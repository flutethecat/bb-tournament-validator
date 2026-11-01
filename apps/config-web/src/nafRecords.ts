// NAF (thenaf.net) ranked games for the coach rating. A coach whose identity record carries a nafId opts in: their NAF game list is scraped (public HTML,
// no API) when one of their tabletop matches is CREATED, cached in <FORK_STATE_DIR>/naf-games.json, and every other read uses that cache as it stands.
// The cached games become result-shaped rows for computeGlicko ONLY (nafResultRows); they never enter TournamentResultStore, so standings, Elo and
// records cannot see them. Everything here fails open: NAF down, slow or re-marked-up means no rows, never an error in match creation or ratings.
//
// SINGLE WRITER: the cache file is read-modify-written with no inter-process lock, so exactly one config-web process may refresh it (writes are atomic,
// but two writers could lose each other's coach record; the next refresh restores it).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { isNafId } from "./auth/identitiesStore.js";
import type { StoredTournamentResult } from "./tournamentResults.js";

export interface NafGame {
  /** YYYY-MM-DD */
  date: string;
  tournament: string;
  variant: string;
  coaches: [string, string];
  /** The NAF coach ids from the Coaches cell's head2head link, in the same order as `coaches`; absent when the page carried no such link. */
  coachIds?: [string, string];
  races: [string, string];
  score: [number, number];
}

/** The NAF coach page, parsed by label. Every field is optional: a label that is not found is simply absent. */
export interface NafProfile { glicko?: number; wins?: number; draws?: number; losses?: number; nafName?: string; fetchedAt: string }

export interface NafCoachRecord {
  nafId: string;
  nafName: string;
  /** When the games were last fetched successfully ("" = never). */
  fetchedAt: string;
  /** When a fetch was last ATTEMPTED (success or not): the 10-minute throttle runs on this, so a failing NAF is not retried on every match creation. */
  lastAttemptAt?: string;
  /** The coach page (Global Glicko, record, displayed name); absent until a coach page fetch has parsed. Fetched after, and independently of, the game list. */
  profile?: NafProfile;
  games: NafGame[];
}

const NAF_USER_AGENT = "SuperFUMBBL-config-web/1.0 (+https://github.com/flutethecat)";
const NAF_TIMEOUT_MS = 10_000;
/** Re-creating a match must not hammer NAF: an attempt younger than this is not repeated. */
export const NAF_REFRESH_MIN_AGE_MS = 10 * 60_000;
export const NAF_MAX_GAMES_PER_COACH = 1000;

// ---- HTML parsing -------------------------------------------------------------------------------------------------------------------------------

const LATIN1 = "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml".split(" ");
const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", hellip: "…", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š", Zcaron: "Ž", zcaron: "ž", euro: "€",
  ...Object.fromEntries(LATIN1.map((name, i) => [name, String.fromCharCode(160 + i)])),
};
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1]!.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  }).replace(/ /g, " ");
}
const cellText = (html: string): string => decodeEntities(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

const HEADERS = ["date", "tournament", "variant", "coaches", "races", "score", "result"] as const;
const REQUIRED_HEADERS = ["date", "tournament", "coaches", "races", "score"] as const;
type Column = (typeof HEADERS)[number];

/** The column map of a Games header row (resolved by header text, so a reordered or extended table still parses), or undefined for any other row. */
function headerColumns(cells: string[]): Partial<Record<Column, number>> | undefined {
  const map: Partial<Record<Column, number>> = {};
  cells.forEach((text, index) => { const key = text.toLowerCase(); if ((HEADERS as readonly string[]).includes(key) && map[key as Column] === undefined) map[key as Column] = index; });
  return REQUIRED_HEADERS.every((key) => map[key] !== undefined) ? map : undefined;
}

interface RawRow { date: string; tournament: string; variant: string; joined: string; anchorTexts: string[]; ids?: [string, string]; races: [string, string]; score: [number, number] }

const splitPair = (text: string): [string, string] | undefined => {
  const parts = text.split(/\s+-\s+/);
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0].trim(), parts[1].trim()] : undefined;
};

/**
 * The game rows of a NAF gamelist page. Only rows under a header row naming Date/Tournament/Coaches/Races/Score count (any other table, or a page that
 * is not the list, yields []). `hint` is the coach whose page this is: it settles a Coaches cell whose names contain " - ".
 */
export function parseNafGameList(html: string, hint: { nafId?: string; nafName?: string } = {}): NafGame[] {
  try {
    const raws: RawRow[] = [];
    const columnsByDepth: Array<Partial<Record<Column, number>> | undefined> = [undefined];
    for (const token of html.matchAll(/<table\b|<\/table\s*>|<tr\b[\s\S]*?<\/tr\s*>/gi)) {
      const text = token[0];
      if (/^<table\b/i.test(text)) { columnsByDepth.push(undefined); continue; }
      if (/^<\/table/i.test(text)) { if (columnsByDepth.length > 1) columnsByDepth.pop(); continue; }
      const rawCells = [...text.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((m) => m[1]!);
      const texts = rawCells.map(cellText);
      const header = headerColumns(texts);
      if (header) { columnsByDepth[columnsByDepth.length - 1] = header; continue; }
      const columns = columnsByDepth[columnsByDepth.length - 1];
      if (!columns) continue;
      const at = (key: Column): string => (columns[key] === undefined ? "" : texts[columns[key]!] ?? "");
      const date = at("date");
      const races = splitPair(at("races"));
      const scoreParts = /^(\d+)\s*-\s*(\d+)$/.exec(at("score"));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !races || !scoreParts) continue;
      const coachesRaw = rawCells[columns.coaches!] ?? "";
      const href = decodeEntities(/href\s*=\s*["']([^"']*)["']/i.exec(coachesRaw)?.[1] ?? "");
      const id1 = /[?&]coach1=(\d+)/.exec(href)?.[1];
      const id2 = /[?&]coach2=(\d+)/.exec(href)?.[1];
      raws.push({
        date, tournament: at("tournament"), variant: at("variant"), joined: at("coaches"),
        anchorTexts: [...coachesRaw.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi)].map((m) => cellText(m[1]!)).filter(Boolean),
        ...(isNafId(id1) && isNafId(id2) ? { ids: [id1, id2] as [string, string] } : {}),
        races, score: [Number(scoreParts[1]), Number(scoreParts[2])],
      });
    }
    // 1. rows whose names split unambiguously (two anchors, or exactly one " - ")
    const names = raws.map((raw) => (raw.anchorTexts.length === 2 ? ([raw.anchorTexts[0]!, raw.anchorTexts[1]!] as [string, string]) : splitPair(raw.joined)));
    // 2. the page coach's own name (the hint, else the one name seen on the page coach's side of every unambiguous row), to settle the rest
    const hintId = hint.nafId && isNafId(hint.nafId) ? hint.nafId : undefined;
    let ownName = hint.nafName?.trim() || undefined;
    if (!ownName && hintId) {
      const seen = new Set<string>();
      raws.forEach((raw, i) => { const side = raw.ids?.indexOf(hintId) ?? -1; const n = names[i]; if (n && side >= 0) seen.add(n[side]!); });
      if (seen.size === 1) ownName = [...seen][0];
    }
    const out: NafGame[] = [];
    raws.forEach((raw, i) => {
      let pair = names[i];
      if (!pair && raw.ids && hintId && ownName) {
        const side = raw.ids.indexOf(hintId);
        const joined = raw.joined;
        const lower = joined.toLowerCase();
        const own = ownName.toLowerCase();
        if (side === 0 && lower.startsWith(`${own} - `)) pair = [joined.slice(0, own.length), joined.slice(own.length + 3).trim()];
        else if (side === 1 && lower.endsWith(` - ${own}`)) pair = [joined.slice(0, joined.length - own.length - 3).trim(), joined.slice(joined.length - own.length)];
      }
      if (!pair || !pair[0] || !pair[1]) return;
      out.push({
        date: raw.date, tournament: raw.tournament, variant: raw.variant, coaches: pair, ...(raw.ids ? { coachIds: raw.ids } : {}), races: raw.races, score: raw.score,
      });
    });
    return out;
  } catch { return []; }
}

/**
 * The NAF coach page (member.thenaf.net ... type=coachpage), read by label text: the first row labelled "Global Glicko" gives the rating, the first
 * "Record (W/T/L)" row the record, "NAF name" the displayed name. A label that is missing leaves its field out; nothing found at all gives undefined.
 */
export function parseNafCoachPage(html: string, fetchedAt = new Date().toISOString()): NafProfile | undefined {
  try {
    const profile: NafProfile = { fetchedAt };
    const rows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/gi)].map((m) => [...m[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => cellText(c[1]!)));
    const valueOf = (label: RegExp): string | undefined => rows.find((cells) => cells.length >= 2 && label.test(cells[0]!))?.[1];
    const glickoText = valueOf(/^global glicko\b/i);
    const glicko = glickoText === undefined ? undefined : /-?\d+(?:\.\d+)?/.exec(glickoText)?.[0];
    if (glicko !== undefined && Number.isFinite(Number(glicko)) && Number(glicko) > 0 && Number(glicko) < 10_000) profile.glicko = Number(glicko);
    const recordText = valueOf(/^record\s*\(w\/[td]\/l\)/i);
    const record = recordText === undefined ? undefined : /(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/.exec(recordText);
    if (record) { profile.wins = Number(record[1]); profile.draws = Number(record[2]); profile.losses = Number(record[3]); }
    const name = valueOf(/^naf name$/i)?.trim();
    if (name && name.length <= 100) profile.nafName = name;
    return profile.glicko !== undefined || profile.wins !== undefined || profile.nafName !== undefined ? profile : undefined;
  } catch { return undefined; }
}

// ---- cache validation + store -------------------------------------------------------------------------------------------------------------------

const str = (v: unknown): v is string => typeof v === "string";
function validGame(value: unknown): NafGame | undefined {
  if (!value || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  const pairOf = (v: unknown): v is [string, string] => Array.isArray(v) && v.length === 2 && str(v[0]) && str(v[1]);
  const score = g.score;
  if (!str(g.date) || !/^\d{4}-\d{2}-\d{2}$/.test(g.date) || !str(g.tournament) || !str(g.variant) || !pairOf(g.coaches) || !pairOf(g.races)) return undefined;
  if (!Array.isArray(score) || score.length !== 2 || !score.every((n) => Number.isInteger(n) && n >= 0 && n < 1000)) return undefined;
  const ids = pairOf(g.coachIds) && isNafId(g.coachIds[0]) && isNafId(g.coachIds[1]) ? (g.coachIds as [string, string]) : undefined;
  return { date: g.date, tournament: g.tournament, variant: g.variant, coaches: g.coaches, ...(ids ? { coachIds: ids } : {}), races: g.races, score: score as [number, number] };
}
function validProfile(value: unknown): NafProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const p = value as Record<string, unknown>;
  if (!str(p.fetchedAt)) return undefined;
  const num = (v: unknown, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < max ? v : undefined);
  const out: NafProfile = { fetchedAt: p.fetchedAt };
  const glicko = num(p.glicko, 10_000); if (glicko !== undefined) out.glicko = glicko;
  const wins = num(p.wins, 100_000); if (wins !== undefined) out.wins = wins;
  const draws = num(p.draws, 100_000); if (draws !== undefined) out.draws = draws;
  const losses = num(p.losses, 100_000); if (losses !== undefined) out.losses = losses;
  if (str(p.nafName) && p.nafName.length <= 100) out.nafName = p.nafName;
  return out;
}
function validRecord(key: string, value: unknown): NafCoachRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const r = value as Record<string, unknown>;
  if (!isNafId(key) || r.nafId !== key || !str(r.nafName) || !str(r.fetchedAt) || !Array.isArray(r.games)) return undefined;
  const games = r.games.map(validGame).filter((g): g is NafGame => g !== undefined);
  return { nafId: key, nafName: r.nafName, fetchedAt: r.fetchedAt, ...(str(r.lastAttemptAt) ? { lastAttemptAt: r.lastAttemptAt } : {}), ...(validProfile(r.profile) ? { profile: validProfile(r.profile)! } : {}), games };
}

interface NafStoreFile { version: 1; coaches: Record<string, unknown> }

let nafIdFilter: ((nafId: string) => string | undefined) | undefined;
/** Account deletion: a NAF id -> pseudonym (deleted coaches with a verified NAF link), applied to every write. */
export function setNafIdFilter(fn: ((nafId: string) => string | undefined) | undefined): void { nafIdFilter = fn; }
function filteredCoaches(coaches: Record<string, unknown>): Record<string, unknown> {
  if (!nafIdFilter) return coaches;
  const out: Record<string, unknown> = {};
  for (const [id, rec] of Object.entries(coaches)) {
    if (nafIdFilter(id)) continue; // a deleted coach's own record is never stored again
    if (!rec || typeof rec !== "object" || !Array.isArray((rec as { games?: unknown }).games)) { out[id] = rec; continue; }
    const games = ((rec as { games: unknown[] }).games).map((g) => {
      const game = g as { coaches?: unknown; coachIds?: unknown };
      if (!Array.isArray(game?.coaches) || !Array.isArray(game.coachIds)) return g;
      const swapped = (game.coachIds as unknown[]).map((cid) => (typeof cid === "string" ? nafIdFilter!(cid) : undefined));
      if (!swapped.some(Boolean)) return g;
      const { coachIds: _drop, ...rest } = game as Record<string, unknown>;
      return { ...rest, coaches: (game.coaches as unknown[]).map((c, i) => swapped[i] ?? c) };
    });
    out[id] = { ...(rec as object), games };
  }
  return out;
}

export class NafRecordStore {
  private readonly file: string;
  private writes = 0;

  constructor(dataDir: string) { this.file = join(dataDir, "naf-games.json"); }

  private read(): NafStoreFile {
    if (!existsSync(this.file)) return { version: 1, coaches: {} };
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<NafStoreFile>;
      if (parsed.version !== 1 || !parsed.coaches || typeof parsed.coaches !== "object" || Array.isArray(parsed.coaches)) return { version: 1, coaches: {} };
      return { version: 1, coaches: parsed.coaches };
    } catch { return { version: 1, coaches: {} }; }
  }

  /** A coach's cached record; an invalid record reads as absent (and its bad games are skipped), never as an error. */
  get(nafId: string): NafCoachRecord | undefined {
    const coaches = this.read().coaches;
    return Object.hasOwn(coaches, nafId) ? validRecord(nafId, coaches[nafId]) : undefined;
  }

  listAll(): NafCoachRecord[] {
    return Object.entries(this.read().coaches).map(([key, value]) => validRecord(key, value)).filter((r): r is NafCoachRecord => r !== undefined);
  }

  /** Changes whenever the cache changes (a write through this store, or the file changing under it): a cheap key for derived ratings. */
  revision(): string {
    let stamp = "none";
    try { const s = statSync(this.file); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* no file yet */ }
    return `${this.writes}:${stamp}`;
  }

  private write(coaches: Record<string, unknown>): void {
    this.writes += 1;
    atomicWriteTextFile(this.file, `${JSON.stringify({ version: 1, coaches: filteredCoaches(coaches) }, null, 2)}\n`);
  }

  /** Store a successful fetch (capped at 1000 games). With `keep`, records of nafIds not in it (a coach unlinked since) are dropped. */
  put(nafId: string, nafName: string, games: NafGame[], fetchedAt = new Date().toISOString(), keep?: ReadonlySet<string>): NafCoachRecord {
    const current = this.read().coaches;
    const previous = Object.hasOwn(current, nafId) ? validRecord(nafId, current[nafId]) : undefined;
    const record: NafCoachRecord = { nafId, nafName, fetchedAt, lastAttemptAt: fetchedAt, ...(previous?.profile ? { profile: previous.profile } : {}), games: games.slice(0, NAF_MAX_GAMES_PER_COACH) };
    const kept = Object.fromEntries(Object.entries(current).filter(([id]) => !keep || keep.has(id)));
    this.write({ ...kept, [nafId]: record });
    return record;
  }

  /** Remember that a fetch was attempted (and failed or came back empty) without touching the cached games. */
  markAttempt(nafId: string, nafName: string, at: string): void {
    const current = this.read().coaches;
    const previous = Object.hasOwn(current, nafId) ? validRecord(nafId, current[nafId]) : undefined;
    this.write({ ...current, [nafId]: { nafId, nafName: previous?.nafName || nafName, fetchedAt: previous?.fetchedAt ?? "", lastAttemptAt: at, ...(previous?.profile ? { profile: previous.profile } : {}), games: previous?.games ?? [] } });
  }

  /** Store the parsed coach page on the coach record (created, without games, when the record is new). Games and the attempt stamp are kept. */
  putProfile(nafId: string, nafName: string, profile: NafProfile): void {
    const current = this.read().coaches;
    const previous = Object.hasOwn(current, nafId) ? validRecord(nafId, current[nafId]) : undefined;
    this.write({ ...current, [nafId]: { nafId, nafName: previous?.nafName || nafName, fetchedAt: previous?.fetchedAt ?? "", ...(previous?.lastAttemptAt ? { lastAttemptAt: previous.lastAttemptAt } : {}), profile: { ...previous?.profile, ...profile }, games: previous?.games ?? [] } });
  }
}

export const nafScrapeDisabled = (): boolean => process.env.NAF_SCRAPE_DISABLED === "1";

/** One coach's NAF game list; [] on any failure (non-200, timeout, network, parse), never throws. NAF_SCRAPE_DISABLED=1 makes no request at all. */
export async function fetchNafGames(nafId: string, fetchImpl: typeof fetch = fetch, nafName?: string): Promise<NafGame[]> {
  if (nafScrapeDisabled() || !isNafId(nafId.trim())) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAF_TIMEOUT_MS);
  try {
    const url = `https://member.thenaf.net/index.php?module=NAF&type=gamelist&coach=${encodeURIComponent(nafId.trim())}&limit=1000`;
    const res = await fetchImpl(url, { headers: { "User-Agent": NAF_USER_AGENT }, signal: controller.signal });
    if (res.status !== 200) return [];
    return parseNafGameList(await res.text(), { nafId: nafId.trim(), ...(nafName ? { nafName } : {}) });
  } catch { return []; } finally { clearTimeout(timer); }
}

/** One coach page, parsed; undefined on any failure (non-200, timeout, network, no recognisable label), never throws. Same kill switch and timeout as the game list. */
export async function fetchNafProfile(nafId: string, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): Promise<NafProfile | undefined> {
  if (nafScrapeDisabled() || !isNafId(nafId.trim())) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAF_TIMEOUT_MS);
  try {
    const url = `https://member.thenaf.net/index.php?module=NAF&type=coachpage&coach=${encodeURIComponent(nafId.trim())}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": NAF_USER_AGENT }, signal: controller.signal });
    if (res.status !== 200) return undefined;
    return parseNafCoachPage(await res.text(), now().toISOString());
  } catch { return undefined; } finally { clearTimeout(timer); }
}

/** What the NAF coach page says about who it belongs to (Account page Connections: src/auth/connections.ts). */
export type NafCoachIdentity =
  | { kind: "found"; nafName?: string; nafNumber?: string }
  /** 404, or a 200 page with neither a "NAF number" nor a "NAF name" row (the NAF answers unknown numbers with an empty page). */
  | { kind: "missing" }
  /** Non-200 other than 404, timeout, network error, or the NAF_SCRAPE_DISABLED kill switch. */
  | { kind: "unavailable" };

/** The "NAF number" and "NAF name" rows of a coach page, by label (same reading as parseNafCoachPage). */
export function parseNafCoachIdentity(html: string): { nafName?: string; nafNumber?: string } {
  try {
    const rows = [...html.matchAll(/<tr\b[\s\S]*?<\/tr\s*>/gi)].map((m) => [...m[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]\s*>/gi)].map((c) => cellText(c[1]!)));
    const valueOf = (label: RegExp): string | undefined => rows.find((cells) => cells.length >= 2 && label.test(cells[0]!))?.[1]?.trim();
    const name = valueOf(/^naf name$/i);
    const number = valueOf(/^naf number$/i);
    return { ...(name && name.length <= 100 ? { nafName: name } : {}), ...(number && isNafId(number) ? { nafNumber: number } : {}) };
  } catch { return {}; }
}

/** One coach page read for identity verification; never throws. Same URL, user agent, timeout and kill switch as fetchNafProfile. */
export async function fetchNafCoachIdentity(nafId: string, fetchImpl: typeof fetch = fetch): Promise<NafCoachIdentity> {
  if (nafScrapeDisabled()) return { kind: "unavailable" };
  if (!isNafId(nafId.trim())) return { kind: "missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NAF_TIMEOUT_MS);
  try {
    const url = `https://member.thenaf.net/index.php?module=NAF&type=coachpage&coach=${encodeURIComponent(nafId.trim())}`;
    const res = await fetchImpl(url, { headers: { "User-Agent": NAF_USER_AGENT }, signal: controller.signal });
    if (res.status === 404) return { kind: "missing" };
    if (res.status !== 200) return { kind: "unavailable" };
    const found = parseNafCoachIdentity(await res.text());
    return found.nafName || found.nafNumber ? { kind: "found", ...found } : { kind: "missing" };
  } catch { return { kind: "unavailable" }; } finally { clearTimeout(timer); }
}

// ---- identities ---------------------------------------------------------------------------------------------------------------------------------

/** The slice of the identity store this module reads. */
export interface NafIdentities {
  coaches: Record<string, { ffbCoachId: string; identities: { nafId?: string; nafName?: string } }>;
}

const normalizedCoach = (coach: string): string => coach.trim().toLowerCase();
/** The coach's opt-in link (an identity record carrying a valid nafId), or undefined. */
export function nafLinkOf(identities: NafIdentities, coach: string): { nafId: string; nafName: string } | undefined {
  const record = identities.coaches[normalizedCoach(coach)];
  const nafId = record?.identities.nafId?.trim();
  return record && isNafId(nafId) ? { nafId, nafName: record.identities.nafName?.trim() || "" } : undefined;
}

/**
 * The key of everything the NAF rows depend on besides the cache: the identity links. readIdentities() has no revision of its own, so this is the identity
 * file's mtime and size (or, with no file to stat, a hash of the {ffbCoachId, nafId, nafName} triples), plus the cache's own revision.
 */
export function nafRevision(store: NafRecordStore, identities: () => NafIdentities, identitiesFilePath?: string): string {
  let links = "";
  try { if (identitiesFilePath) { const s = statSync(identitiesFilePath); links = `f${s.mtimeMs}:${s.size}`; } } catch { /* fall through to the hash */ }
  if (!links) {
    try {
      const hash = createHash("sha1");
      for (const r of Object.values(identities().coaches)) hash.update(`${r.ffbCoachId}\0${r.identities.nafId ?? ""}\0${r.identities.nafName ?? ""}\n`);
      links = `h${hash.digest("hex")}`;
    } catch { links = "none"; }
  }
  return `${store.revision()}:${links}`;
}

// ---- refresh ------------------------------------------------------------------------------------------------------------------------------------

export interface NafRefreshDeps {
  store: NafRecordStore;
  identities: () => NafIdentities;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  warn?: (message: string) => void;
}

const inFlight = new Map<string, Promise<void>>();

/**
 * Fetch and cache the NAF games of every named coach that has a nafId. Per-nafId in-flight dedupe; a coach attempted less than 10 minutes ago (fetched or
 * not) is left alone; an empty or failed fetch keeps the cached games. Never throws.
 */
export async function refreshNafForCoaches(coaches: string[], deps: NafRefreshDeps): Promise<void> {
  try {
    if (nafScrapeDisabled()) return;
    const warn = deps.warn ?? ((m: string) => console.warn(m));
    const now = deps.now ?? (() => new Date());
    const identities = deps.identities();
    const linked = new Set<string>();
    for (const record of Object.values(identities.coaches)) { const id = record.identities.nafId?.trim(); if (isNafId(id)) linked.add(id); }
    const ids = new Map<string, string>();
    for (const coach of coaches) { const link = nafLinkOf(identities, coach); if (link) ids.set(link.nafId, link.nafName); }
    await Promise.all([...ids].map(([nafId, nafName]) => {
      const pending = inFlight.get(nafId);
      if (pending) return pending;
      const job = (async () => {
        let throttled = false;
        try {
          const cached = deps.store.get(nafId);
          const last = Date.parse(cached?.lastAttemptAt || cached?.fetchedAt || "");
          if (Number.isFinite(last) && now().getTime() - last < NAF_REFRESH_MIN_AGE_MS) { throttled = true; return; }
          const games = await fetchNafGames(nafId, deps.fetchImpl, nafName || cached?.nafName);
          const at = now().toISOString();
          // an empty answer is a failure (or a coach with no games): keep what is cached rather than wiping it
          if (games.length === 0) deps.store.markAttempt(nafId, nafName, at);
          else deps.store.put(nafId, nafName || cached?.nafName || "", games, at, linked);
        } catch (error) {
          warn(`[naf] refresh of ${nafId} failed: ${(error as Error).message}`);
        }
        if (throttled) return; // a recent attempt covers the coach page too
        // the coach page comes after the game list and succeeds or fails on its own (the same attempt window covers it)
        try {
          const profile = await fetchNafProfile(nafId, deps.fetchImpl, now);
          if (profile) deps.store.putProfile(nafId, nafName, profile);
        } catch (error) {
          warn(`[naf] coach page of ${nafId} failed: ${(error as Error).message}`);
        }
      })().finally(() => { inFlight.delete(nafId); });
      inFlight.set(nafId, job);
      return job;
    }));
  } catch { /* fail open */ }
}

// ---- rating rows --------------------------------------------------------------------------------------------------------------------------------

const gameKey = (game: NafGame): string => {
  const a = game.coaches[0].trim().toLowerCase();
  const b = game.coaches[1].trim().toLowerCase();
  const swap = a > b;
  const coaches = swap ? [b, a] : [a, b];
  const score = swap ? [game.score[1], game.score[0]] : game.score;
  return createHash("sha1").update([game.date, game.tournament, coaches.join("|"), score.join("-")].join("|")).digest("hex");
};

/**
 * Every cached NAF game as a result row for computeGlicko (and nothing else). The same game cached from both linked coaches is one row. Each side is
 * mapped to our coach by NAF id (the head2head link), else by a linked identity's NAF name, else keyed `naf:<lowercased name>` so the opponent is rated too.
 * When a game has no link ids, the one name present in every game of that coach's cache is the page coach (unique candidate only). No team values
 * (deltaCtv 0). penaltyScore is -1 (no shoot-out): a 0 would override the score in deriveTeamResult.
 */
export function nafResultRows(store: NafRecordStore, identities: NafIdentities): StoredTournamentResult[] {
  // pass 1: every mapping, before any row is emitted
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const record of Object.values(identities.coaches)) {
    const nafId = record.identities.nafId?.trim();
    if (!isNafId(nafId)) continue; // opt-in: without a valid nafId a coach is a plain naf: entry
    byId.set(nafId, record.ffbCoachId);
    const name = record.identities.nafName?.trim().toLowerCase();
    if (name) byName.set(name, record.ffbCoachId);
  }
  const cache = store.listAll();
  const pageName = new Map<string, string>(); // nafId -> the page coach's lowercased name, from games that carry no ids
  for (const cached of cache) {
    if (!byId.has(cached.nafId) || cached.games.length === 0) continue;
    let common: Set<string> | undefined;
    for (const g of cached.games) {
      const names = new Set(g.coaches.map((c) => c.trim().toLowerCase()));
      common = common ? new Set([...common].filter((n) => names.has(n))) : names;
    }
    if (common && common.size === 1) pageName.set(cached.nafId, [...common][0]!);
  }
  // pass 2: emit
  const rows = new Map<string, StoredTournamentResult>();
  for (const cached of cache) {
    if (!byId.has(cached.nafId)) continue; // unlinked since: its games no longer count
    for (const game of cached.games) {
      const names = [game.coaches[0].trim().toLowerCase(), game.coaches[1].trim().toLowerCase()] as [string, string];
      if (!names[0] || !names[1] || names[0] === names[1]) continue;
      const gameId = `naf:${gameKey(game)}`;
      if (rows.has(gameId)) continue;
      const at = Date.parse(`${game.date}T12:00:00Z`);
      if (!Number.isFinite(at)) continue;
      const owner = (i: 0 | 1): string | undefined => {
        const byLink = game.coachIds ? byId.get(game.coachIds[i]) : undefined;
        if (byLink) return byLink;
        if (!game.coachIds && names[i] === pageName.get(cached.nafId)) return byId.get(cached.nafId);
        return byName.get(names[i]);
      };
      const side = (i: 0 | 1) => ({ teamId: `naf:${names[i]}`, teamName: game.races[i], coach: owner(i) ?? `naf:${names[i]}` });
      const team = (i: 0 | 1) => ({
        teamId: `naf:${names[i]}`, score: game.score[i], winnings: 0, penaltyScore: -1, conceded: false,
        casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [],
      });
      rows.set(gameId, {
        gameId, pulledAt: cached.fetchedAt || new Date(at).toISOString(), playedAt: new Date(at).toISOString(), source: "naf",
        home: side(0), away: side(1), teams: [team(0), team(1)],
      });
    }
  }
  return [...rows.values()];
}

/** How many cached NAF games a linked coach has (0 when unlinked or never fetched). */
export interface NafSummary { games: number; fetchedAt?: string; /** the NAF Global Glicko from the coach page, when it was fetched */ glicko?: number; /** W/D/L over the cached games, from this coach side */ record?: { w: number; d: number; l: number } }

export function nafSummaryFor(store: NafRecordStore, identities: NafIdentities, coach: string): NafSummary {
  const link = nafLinkOf(identities, coach);
  const cached = link ? store.get(link.nafId) : undefined;
  if (!link || !cached) return { games: 0 };
  // this coach side of each game: the head2head id, else the coach's NAF names, else the one name common to every game
  const mine = new Set([link.nafName, cached.nafName, cached.profile?.nafName].map((n) => n?.trim().toLowerCase()).filter((n): n is string => Boolean(n)));
  let common: Set<string> | undefined;
  for (const g of cached.games) {
    const names = new Set(g.coaches.map((c) => c.trim().toLowerCase()));
    common = common ? new Set([...common].filter((n) => names.has(n))) : names;
  }
  if (common && common.size === 1) mine.add([...common][0]!);
  const record = { w: 0, d: 0, l: 0 };
  let counted = 0;
  for (const g of cached.games) {
    if (g.coachIds && g.coachIds[0] === g.coachIds[1]) continue;
    let side = g.coachIds ? g.coachIds.indexOf(link.nafId) : -1;
    if (side < 0) { const names = g.coaches.map((c) => c.trim().toLowerCase()); side = mine.has(names[0]!) && !mine.has(names[1]!) ? 0 : mine.has(names[1]!) && !mine.has(names[0]!) ? 1 : -1; }
    if (side < 0) continue;
    const own = g.score[side]!;
    const other = g.score[1 - side]!;
    counted += 1;
    if (own > other) record.w += 1; else if (own < other) record.l += 1; else record.d += 1;
  }
  return {
    games: cached.games.length,
    ...(cached.fetchedAt ? { fetchedAt: cached.fetchedAt } : {}),
    ...(cached.profile?.glicko !== undefined ? { glicko: cached.profile.glicko } : {}),
    ...(counted > 0 ? { record } : {}),
  };
}
