// Coach titles for the CR shown in the recorder hero. The CR itself is FUMBBL's Glicko-2 coach rating (coachGlicko.ts), shown as a whole number.
//
// Titles follow FUMBBL's coach ranking (https://fumbbl.com/help:CoachRankingIntro, updated 2025-09-05; details: help:CoachRankingImplementationDetails):
// eight titles; every coach starts at 1500; Rookie is forced for a coach with fewer than 10 matches; a new coach starts in Emerging Star (around 1500).
// FUMBBL assigns the other titles as percentages of ACTIVE coaches (Legend = the top X), recomputed periodically with hysteresis, and does not publish the
// formula, so ours is TITLE_PERCENT below (owner ruling 10-29): percentile bands over the ACTIVE pool (>= 10 games and a game in the last 365 days),
// bounds recomputed at most once per 7-day rating period, and HYSTERESIS so a coach does not flap at a boundary. The title list, its order and its
// normalisation (COACH_TITLE_SLUGS / coachTitleSlug, including FUMBBL's hyphenated "Mega-Star") are reused verbatim from the client.

/** FUMBBL's eight titles and their badge slugs, in order (verbatim from the client's COACH_TITLE_SLUGS). */
import { existsSync, readFileSync } from "node:fs";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { PERIOD_DAYS, PERIOD_EPOCH_MS, unratedGlicko, type CoachGlicko } from "./coachGlicko.js";

export const COACH_TITLE_SLUGS = {
  "rookie": "rookie",
  "experienced": "experienced",
  "veteran": "veteran",
  "emerging star": "emerging-star",
  "star": "star",
  "super star": "super-star",
  "mega star": "mega-star",
  "legend": "legend",
} as const;
export type CoachTitleSlug = (typeof COACH_TITLE_SLUGS)[keyof typeof COACH_TITLE_SLUGS];

/** "Super Star" / " super  STAR " / "Mega-Star" -> "super-star" / "mega-star"; anything not one of FUMBBL's eight titles -> undefined (the client's coachTitleSlug). */
export function coachTitleSlug(title: string | undefined | null): CoachTitleSlug | undefined {
  if (typeof title !== "string") return undefined;
  const key = title.trim().replace(/[-_\u2010-\u2015]+/g, " ").replace(/\s+/g, " ").toLowerCase();
  return Object.prototype.hasOwnProperty.call(COACH_TITLE_SLUGS, key) ? COACH_TITLE_SLUGS[key as keyof typeof COACH_TITLE_SLUGS] : undefined;
}

export interface CoachRank { name: string; key: string; pips: number }

/** In order, lowest first (index 0..6). Rookie is not a band (it is forced by fewer than ROOKIE_GAMES games). */
export const BANDS: ReadonlyArray<CoachRank> = [
  { name: "Experienced", key: "experienced", pips: 2 },
  { name: "Veteran", key: "veteran", pips: 3 },
  { name: "Emerging Star", key: "emerging", pips: 4 },
  { name: "Star", key: "star", pips: 5 },
  { name: "Super Star", key: "super", pips: 6 },
  { name: "Mega-Star", key: "mega", pips: 7 }, // FUMBBL writes "Mega-Star"
  { name: "Legend", key: "legend", pips: 8 },
];
export const ROOKIE: CoachRank = { name: "Rookie", key: "rookie", pips: 1 };
const EMERGING: CoachRank = BANDS[2]!;
/** Fewer than this many matches: Rookie, whatever the rating. */
export const ROOKIE_GAMES = 10;
/** Active = a game within this many days of `asOf` (and >= ROOKIE_GAMES games). */
export const ACTIVE_DAYS = 365;
/** A coach changes band only when this many CR beyond the boundary. */
export const HYSTERESIS = 10;

/** THE band table. Legend = this share of the whole pool (at least one coach); every other title is a share of the REMAINDER, taken from the top by CR. */
export const TITLE_PERCENT = {
  legend: 0.02,
  rest: [
    { key: "mega", share: 0.05 },
    { key: "super", share: 0.10 },
    { key: "star", share: 0.20 },
    { key: "emerging", share: 0.30 },
    { key: "veteran", share: 0.20 },
    { key: "experienced", share: 0.15 },
  ],
} as const;

/** Percentile bounds. `lower[i]` is the lowest CR of band i (0 Experienced = the pool's lowest .. 6 Legend); empty when the pool is empty. `crs` is the pool's CRs, highest first (for pct). */
export interface Bounds {
  poolSize: number; legendCount: number; lower: number[]; crs: number[];
  /** The pool's coach keys, parallel to `crs` (CR descending, ties by key ascending): a pool member's initial placement is by this rank, so ties at a cutoff cannot inflate a band. */
  keys: string[];
  /** Exclusive end rank of Legend, Mega-Star, Super Star, Star, Emerging Star, Veteran (Experienced runs to the end). */
  ends: number[];
}
export const EMPTY_BOUNDS: Bounds = { poolSize: 0, legendCount: 0, lower: [], crs: [], keys: [], ends: [] };
export const isBounds = (b: unknown): b is Bounds => {
  const x = b as Bounds | null;
  return !!x && typeof x === "object" && Number.isInteger(x.poolSize) && Number.isInteger(x.legendCount) && Array.isArray(x.lower) && Array.isArray(x.crs) && Array.isArray(x.keys) && Array.isArray(x.ends)
    && x.crs.length === x.poolSize && x.keys.length === x.poolSize && x.crs.every((n) => typeof n === "number" && Number.isFinite(n))
    && (x.poolSize === 0 ? x.lower.length === 0 : x.lower.length === 7 && x.ends.length === 6 && x.lower.every((n) => typeof n === "number" && Number.isFinite(n)) && x.ends.every((n) => Number.isInteger(n)));
};

const DAY_MS = 86_400_000;
export const isActiveCoach = (g: Pick<CoachGlicko, "games" | "lastPlayedMs">, asOf: Date): boolean =>
  g.games >= ROOKIE_GAMES && g.lastPlayedMs !== undefined && g.lastPlayedMs >= asOf.getTime() - ACTIVE_DAYS * DAY_MS && g.lastPlayedMs <= asOf.getTime();

/** The bounds from the active pool of `ratings` (every key, `naf:` opponents included). Deterministic. */
export function computeTitleBands(ratings: Map<string, CoachGlicko>, asOf: Date): Bounds {
  const pool = [...ratings].filter(([, g]) => isActiveCoach(g, asOf)).map(([k, g]) => ({ k, cr: g.cr }))
    .sort((a, b) => b.cr - a.cr || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const crs = pool.map((x) => x.cr);
  const keys = pool.map((x) => x.k);
  const n = crs.length;
  if (n === 0) return { ...EMPTY_BOUNDS, lower: [], crs: [], keys: [], ends: [] };
  const legendCount = Math.max(1, Math.round(TITLE_PERCENT.legend * n));
  const rest = n - legendCount;
  const lower: number[] = new Array(7);
  const ends: number[] = [legendCount];
  lower[6] = crs[legendCount - 1]!; // Legend
  let cum = 0, floor = lower[6]!;
  // Mega-Star (lower[5]) .. Veteran (lower[1]); Experienced is the remainder.
  for (let i = 0; i < 5; i += 1) {
    cum += TITLE_PERCENT.rest[i]!.share;
    const end = legendCount + Math.round(cum * rest); // cumulative rounding: no drift
    if (end > ends[ends.length - 1]!) floor = crs[end - 1]!; // an empty band shares the band above's bound, so nobody lands in it
    lower[5 - i] = floor;
    ends.push(Math.max(end, ends[ends.length - 1]!));
  }
  lower[0] = crs[n - 1]!; // Experienced's own floor: the pool's lowest CR (informational)
  return { poolSize: n, legendCount, lower, crs, keys, ends };
}

/** Lowest CR of band index i (0 Experienced .. 6 Legend). */
const minOf = (b: Bounds, i: number): number => (i === 0 ? -Infinity : b.lower[i] ?? Infinity);

const rankIndex = new WeakMap<Bounds, Map<string, number>>();
/**
 * The plain percentile band index. A pool member (same CR as when the bounds were built) is placed by its RANK in the pool (CR descending, ties by coach key
 * ascending), so a run of equal CRs straddling a cutoff is split and the band counts hold. Anyone else (inactive, or changed since) is placed by CR against the bounds.
 */
function plainBand(coach: string, cr: number, b: Bounds): number {
  let idx = rankIndex.get(b);
  if (!idx) { idx = new Map(b.keys.map((k, i) => [k, i])); rankIndex.set(b, idx); }
  const r = idx.get(coach.trim().toLowerCase());
  if (r !== undefined && b.crs[r] === cr && b.ends.length === 6) {
    const k = b.ends.findIndex((end) => r < end); // 0 Legend .. 5 Veteran, -1 Experienced
    return k < 0 ? 0 : 6 - k;
  }
  let best = 0;
  for (let i = 1; i < 7; i += 1) if (cr >= minOf(b, i)) best = i;
  return best;
}

export interface RankContext { bounds: Bounds; /** the persisted title, if any */ previousTitle?: string | undefined }

/** The title: forced Rookie / Emerging Star, else the percentile band with hysteresis against `previousTitle`. */
export function rankFor(coach: string, glicko: Pick<CoachGlicko, "cr" | "games">, context: RankContext): CoachRank {
  if (glicko.games <= 0) return EMERGING;
  if (glicko.games < ROOKIE_GAMES) return ROOKIE;
  const b = context.bounds;
  if (b.poolSize === 0) return EMERGING;
  const cr = Math.round(glicko.cr);
  const prev = BANDS.findIndex((x) => x.name === context.previousTitle);
  if (prev < 0) return BANDS[plainBand(coach, cr, b)]!;
  let i = prev;
  while (i < 6 && cr >= minOf(b, i + 1) + HYSTERESIS) i += 1;
  if (i === prev) while (i > 0 && cr < minOf(b, i) - HYSTERESIS) i -= 1;
  return BANDS[i]!;
}

/** Top-percent position (1..100) of a CR in the pool, for display ("top 12%"); undefined for a Rookie / unrated coach or an empty pool. */
export function percentileOf(cr: number, games: number, b: Bounds): number | undefined {
  if (games < ROOKIE_GAMES || b.poolSize === 0) return undefined;
  let above = 0;
  for (const x of b.crs) { if (x > cr) above += 1; else break; }
  return Math.min(100, Math.max(1, Math.round(((above + 1) / b.poolSize) * 100)));
}

/** `slug` is the client's badge slug for the title ("emerging-star"); the recorder maps it to the badge PNG. `pct` = top-percent within the active pool. */
export interface CoachRatingView { cr: number; rank: string; rankKey: string; slug: string; games: number; pct?: number }

export function coachRatingFor(coach: string, glicko: Pick<CoachGlicko, "cr" | "games">, context: RankContext): CoachRatingView {
  const cr = Math.round(glicko.cr);
  const r = rankFor(coach, glicko, context);
  const pct = percentileOf(cr, glicko.games, context.bounds);
  return { cr, rank: r.name, rankKey: r.key, slug: coachTitleSlug(r.name) ?? r.key, games: glicko.games, ...(pct !== undefined ? { pct } : {}) };
}

interface TitleEntry { title: string; cr: number; at: string; /** last time the coach was in the ratings map at a rollover */ seen?: string }
interface TitleFile { version: 1; boundsPeriod?: number; bounds?: Bounds; titles: Record<string, TitleEntry> }
const PRUNE_MS = 2 * 365 * DAY_MS;

/** Persists each coach's title (hysteresis memory) and the bounds of the current 7-day rating period in <FORK_STATE_DIR>/coach-titles.json. Single writer, atomic writes. No file = in memory only. */
export class CoachTitleStore {
  private data: TitleFile | undefined;
  private dirty = false;
  constructor(private readonly file?: string) {}

  /** Drop the in-memory copy (the file was rewritten outside this store, e.g. by account deletion); the next use re-reads. */
  reload(): void { this.data = undefined; this.dirty = false; }

  private load(): TitleFile {
    if (this.data) return this.data;
    let d: TitleFile = { version: 1, titles: {} };
    try {
      if (this.file && existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TitleFile> | null;
        if (raw && typeof raw === "object") {
          const titles: Record<string, TitleEntry> = {};
          if (raw.titles && typeof raw.titles === "object") {
            for (const [k, v] of Object.entries(raw.titles)) if (v && typeof v.title === "string" && typeof v.cr === "number" && typeof v.at === "string") titles[k] = v;
          }
          d = { version: 1, titles, ...(typeof raw.boundsPeriod === "number" && isBounds(raw.bounds) ? { boundsPeriod: raw.boundsPeriod, bounds: raw.bounds } : {}) };
        }
      }
    } catch { /* fail open: start fresh */ }
    this.data = d;
    return d;
  }

  /**
   * One batch: bounds (recomputed whenever the rating period differs from the stored one, forwards or backwards, and on first run) and a per-coach view
   * that advances the persisted title. At a rollover EVERY rated coach's title advances (not only viewed ones), so identical coaches never diverge.
   * flush() writes if anything changed; a failed write stays pending and is retried by the next flush.
   */
  session(ratings: Map<string, CoachGlicko>, asOf: Date): { bounds: Bounds; view: (coach: string, glicko?: CoachGlicko) => CoachRatingView; flush: () => void } {
    const d = this.load();
    const at = asOf.toISOString();
    const advance = (key: string, g: CoachGlicko, bounds: Bounds): CoachRatingView => {
      const prev = d.titles[key];
      const out = coachRatingFor(key, g, { bounds, previousTitle: prev?.title });
      if (g.games > 0 && prev?.title !== out.rank) { d.titles[key] = { title: out.rank, cr: out.cr, at, ...(prev?.seen ? { seen: prev.seen } : {}) }; this.dirty = true; }
      return out;
    };
    const period = Math.floor((asOf.getTime() - PERIOD_EPOCH_MS) / (PERIOD_DAYS * DAY_MS));
    if (d.boundsPeriod !== period || !d.bounds) {
      d.bounds = computeTitleBands(ratings, asOf); d.boundsPeriod = period; this.dirty = true;
      for (const [key, g] of ratings) {
        advance(key, g, d.bounds);
        const e = d.titles[key];
        if (e && g.games > 0) e.seen = at;
      }
      for (const [key, e] of Object.entries(d.titles)) {
        if (ratings.has(key)) continue;
        const last = Date.parse(e.seen ?? e.at);
        if (Number.isFinite(last) && asOf.getTime() - last > PRUNE_MS) { delete d.titles[key]; this.dirty = true; }
      }
    }
    const bounds = d.bounds;
    const view = (coach: string, glicko?: CoachGlicko): CoachRatingView => {
      const key = coach.trim().toLowerCase();
      return advance(key, glicko ?? ratings.get(key) ?? unratedGlicko(), bounds);
    };
    const flush = (): void => {
      if (!this.dirty || !this.file) { this.dirty = false; return; }
      try { atomicWriteTextFile(this.file, `${JSON.stringify(d, null, 2)}\n`); this.dirty = false; } catch { /* fail open: titles still served from memory; retried on the next flush */ }
    };
    return { bounds, view, flush };
  }
}
