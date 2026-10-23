// Server-side FUMBBL coach rating for the web Lobby's coach card (spec Part 1b §21.2).
//
// Same THREE fumbbl.com requests the desktop client's coach card makes (apps/tauri/src/game/fumbblCoachProfile.ts),
// ported in behaviour:
//   1. GET /api/coach/search/<name>  -> [{ id, name }]   (exact, case-insensitive match only)
//   2. GET /api/coach/get/<id>       -> { id, name, rating }   (`rating` = the status title)
//   3. GET /~<name>                  -> coach page HTML (only the `.rankings` Overall block is read)
// Cached per lower-cased name for 10 minutes (never per game), bounded, fail-soft: never throws.
// Server-derived: every number is one FUMBBL sent, or win % / WAR computed from the record it sent.

export const FUMBBL_SITE = "https://fumbbl.com";
export const COACH_RATING_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;
const REQUEST_TIMEOUT_MS = 6_000;

export interface FumbblCoachRecord { w: number; d: number; l: number }

export interface CoachRating {
  name: string;
  id?: number;
  title?: string;
  cr?: number;
  record?: FumbblCoachRecord;
  winPct?: number;
  /** Wins above a .500 coach: 0.5 (W - L). */
  war?: number;
}

export type RatingFetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
function positiveId(value: unknown): number | undefined {
  const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}
function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function pickSearchMatch(payload: unknown, name: string): { id: number; name: string } | undefined {
  if (!Array.isArray(payload)) return undefined;
  const wanted = name.trim().toLowerCase();
  if (!wanted) return undefined;
  for (const entry of payload) {
    const row = asObject(entry);
    const id = positiveId(row?.id);
    const rowName = nonEmpty(row?.name);
    if (id !== undefined && rowName && rowName.toLowerCase() === wanted) return { id, name: rowName };
  }
  return undefined;
}

export function parseCoachGet(payload: unknown): { id?: number; name?: string; title?: string } {
  const data = asObject(payload);
  if (!data) return {};
  const out: { id?: number; name?: string; title?: string } = {};
  const id = positiveId(data.id);
  if (id !== undefined) out.id = id;
  const name = nonEmpty(data.name);
  if (name) out.name = name;
  const title = nonEmpty(data.rating);
  if (title) out.title = title;
  return out;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", sol: "/", frasl: "/", percnt: "%", num: "#",
  colon: ":", comma: ",", period: ".", lpar: "(", rpar: ")", hyphen: "-", dash: "-", ndash: "–", mdash: "—",
};
function codePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
}
function decodeHtmlEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return codePoint(Number(dec)) || whole;
    if (hex !== undefined) return codePoint(parseInt(hex, 16)) || whole;
    return NAMED_ENTITIES[(name ?? "").toLowerCase()] ?? whole;
  });
}
function decodeText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, "")).replace(/[\s ]+/g, " ").trim();
}
function divText(chunk: string, classPattern: string): string | undefined {
  const re = new RegExp(`<div\\b[^>]*\\bclass\\s*=\\s*["'](?:[^"']*\\s)?${classPattern}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)</div>`, "i");
  const match = re.exec(chunk);
  return match?.[1] !== undefined ? decodeText(match[1]) : undefined;
}
function statValue(chunk: string, stat: string): string | undefined {
  const re = new RegExp(`<div\\b[^>]*\\bclass\\s*=\\s*["'](?:[^"']*\\s)?statrow\\s+(?:[^"']*\\s)?${stat}(?:\\s[^"']*)?["'][^>]*>([\\s\\S]*?)(?=<div\\b[^>]*\\bclass\\s*=\\s*["'][^"']*\\bstatrow\\b|$)`, "i");
  const row = re.exec(chunk)?.[1];
  return row ? divText(row, "value") : undefined;
}
function parseNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text);
  if (!match) return undefined;
  const n = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}
function parseCoachRecord(text: string | undefined): FumbblCoachRecord | undefined {
  const match = text ? /^\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text) : null;
  return match ? { w: Number(match[1]), d: Number(match[2]), l: Number(match[3]) } : undefined;
}
export function computeWinPct(record: FumbblCoachRecord | undefined): number | undefined {
  if (!record) return undefined;
  const games = record.w + record.d + record.l;
  return games > 0 ? Math.round(((record.w + 0.5 * record.d) / games) * 100) : undefined;
}
/** WAR = (W + 0.5 D) - 0.5 G = 0.5 (W - L); undefined without games. Same formula as the client. */
export function winsAboveReplacement(record: FumbblCoachRecord | undefined): number | undefined {
  if (!record) return undefined;
  const games = record.w + record.d + record.l;
  return games > 0 ? record.w + 0.5 * record.d - 0.5 * games : undefined;
}

export function parseCoachOverall(html: unknown): Omit<CoachRating, "name" | "id" | "war"> {
  if (typeof html !== "string") return {};
  const start = /<div\b[^>]*\bclass\s*=\s*["']rankings["'][^>]*>/i.exec(html);
  if (!start) return {};
  const after = html.slice(start.index + start[0].length);
  const endMatch = /<div\b[^>]*\bclass\s*=\s*["']coachcontent["']/i.exec(after);
  const block = after.slice(0, endMatch ? endMatch.index : 20_000);
  const chunks = block.split(/<div\b[^>]*\bclass\s*=\s*["']ranking["'][^>]*>/i).slice(1);
  const overall = chunks.find((chunk) => divText(chunk, "title")?.toLowerCase() === "overall");
  if (!overall) return {};
  const out: Omit<CoachRating, "name" | "id" | "war"> = {};
  const title = divText(overall, "level");
  if (title) out.title = title;
  const cr = parseNumber(statValue(overall, "CR"));
  if (cr !== undefined) out.cr = cr;
  const record = parseCoachRecord(statValue(overall, "record"));
  if (record) out.record = record;
  const winPct = parseNumber(statValue(overall, "winp")) ?? computeWinPct(record);
  if (winPct !== undefined) out.winPct = winPct;
  return out;
}

async function getBody(fetchFn: RatingFetch, url: string, json: boolean): Promise<unknown> {
  try {
    const response = await fetchFn(url);
    if (!response.ok) return undefined;
    const text = await response.text();
    if (!json) return text;
    try { return JSON.parse(text); } catch { return text; }
  } catch {
    return undefined;
  }
}

async function loadRating(name: string, fetchFn: RatingFetch): Promise<CoachRating> {
  const rating: CoachRating = { name };
  try {
    const encoded = encodeURIComponent(name);
    const pageRequest = getBody(fetchFn, `${FUMBBL_SITE}/~${encoded}`, false);
    const match = pickSearchMatch(await getBody(fetchFn, `${FUMBBL_SITE}/api/coach/search/${encoded}`, true), name);
    let apiTitle: string | undefined;
    if (match) {
      rating.id = match.id;
      rating.name = match.name;
      const got = parseCoachGet(await getBody(fetchFn, `${FUMBBL_SITE}/api/coach/get/${match.id}`, true));
      if (got.name && (got.id === undefined || got.id === match.id)) rating.name = got.name;
      apiTitle = got.title;
    }
    const overall = parseCoachOverall(await pageRequest);
    const title = overall.title ?? apiTitle;
    if (title) rating.title = title;
    if (overall.cr !== undefined) rating.cr = overall.cr;
    if (overall.record) rating.record = overall.record;
    if (overall.winPct !== undefined) rating.winPct = overall.winPct;
    const war = winsAboveReplacement(overall.record);
    if (war !== undefined) rating.war = war;
  } catch {
    // fail-soft
  }
  return rating;
}

/** Default fetch with a timeout. */
export const defaultRatingFetch: RatingFetch = async (url) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
};

/** 10-minute, bounded, per-name cache over the three requests. */
export class CoachRatingCache {
  private readonly cache = new Map<string, { at: number; value: Promise<CoachRating> }>();
  constructor(
    private readonly fetchFn: RatingFetch = defaultRatingFetch,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = COACH_RATING_TTL_MS,
  ) {}

  get(name: string): Promise<CoachRating> {
    const trimmed = name.trim();
    if (!trimmed) return Promise.resolve({ name: "" });
    const key = trimmed.toLowerCase();
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.value;
    this.cache.delete(key);
    while (this.cache.size >= MAX_CACHE) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    const value = loadRating(trimmed, this.fetchFn);
    this.cache.set(key, { at: this.now(), value });
    return value;
  }
}
