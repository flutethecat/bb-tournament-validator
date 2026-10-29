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
export interface Bounds { poolSize: number; legendCount: number; lower: number[]; crs: number[] }
export const EMPTY_BOUNDS: Bounds = { poolSize: 0, legendCount: 0, lower: [], crs: [] };

const DAY_MS = 86_400_000;
export const isActiveCoach = (g: Pick<CoachGlicko, "games" | "lastPlayedMs">, asOf: Date): boolean =>
  g.games >= ROOKIE_GAMES && g.lastPlayedMs !== undefined && g.lastPlayedMs >= asOf.getTime() - ACTIVE_DAYS * DAY_MS;

/** The bounds from the active pool of `ratings` (every key, `naf:` opponents included). Deterministic. */
export function computeTitleBands(ratings: Map<string, CoachGlicko>, asOf: Date): Bounds {
  const crs = [...ratings.values()].filter((g) => isActiveCoach(g, asOf)).map((g) => g.cr).sort((a, b) => b - a);
  const n = crs.length;
  if (n === 0) return { ...EMPTY_BOUNDS };
  const legendCount = Math.max(1, Math.round(TITLE_PERCENT.legend * n));
  const rest = n - legendCount;
  const lower: number[] = new Array(7);
  lower[6] = crs[legendCount - 1]!; // Legend
  let cum = 0, at = legendCount, floor = lower[6]!;
  // Mega-Star (lower[5]) .. Veteran (lower[1]); Experienced is the remainder.
  for (let i = 0; i < 5; i += 1) {
    cum += TITLE_PERCENT.rest[i]!.share;
    const end = legendCount + Math.round(cum * rest); // cumulative rounding: no drift
    if (end > at) floor = crs[end - 1]!; // an empty band shares the band above's bound, so nobody lands in it
    lower[5 - i] = floor;
    at = Math.max(at, end);
  }
  lower[0] = crs[n - 1]!; // Experienced's own floor: the pool's lowest CR (informational)
  return { poolSize: n, legendCount, lower, crs };
}

/** Lowest CR of band index i (0 Experienced .. 6 Legend). */
const minOf = (b: Bounds, i: number): number => (i === 0 ? -Infinity : b.lower[i] ?? Infinity);

/** The plain percentile band index of a CR. */
function plainBand(cr: number, b: Bounds): number {
  let best = 0;
  for (let i = 1; i < 7; i += 1) if (cr >= minOf(b, i)) best = i;
  return best;
}

export interface RankContext { bounds: Bounds; /** the persisted title, if any */ previousTitle?: string | undefined }

/** The title: forced Rookie / Emerging Star, else the percentile band with hysteresis against `previousTitle`. */
export function rankFor(_coach: string, glicko: Pick<CoachGlicko, "cr" | "games">, context: RankContext): CoachRank {
  if (glicko.games <= 0) return EMERGING;
  if (glicko.games < ROOKIE_GAMES) return ROOKIE;
  const b = context.bounds;
  if (b.poolSize === 0) return EMERGING;
  const cr = Math.round(glicko.cr);
  const prev = BANDS.findIndex((x) => x.name === context.previousTitle);
  if (prev < 0) return BANDS[plainBand(cr, b)]!;
  let i = prev;
  while (i < 6 && cr >= minOf(b, i + 1) + HYSTERESIS) i += 1;
  if (i === prev) while (i > 0 && cr <= minOf(b, i) - HYSTERESIS) i -= 1;
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

interface TitleFile {
  version: 1;
  boundsPeriod?: number;
  bounds?: Bounds;
  titles: Record<string, { title: string; cr: number; at: string }>;
}

/** Persists each coach's title (hysteresis memory) and the bounds of the current 7-day rating period in <FORK_STATE_DIR>/coach-titles.json. Single writer, atomic writes. No file = in memory only. */
export class CoachTitleStore {
  private data: TitleFile | undefined;
  constructor(private readonly file?: string) {}

  private load(): TitleFile {
    if (this.data) return this.data;
    let d: TitleFile = { version: 1, titles: {} };
    try {
      if (this.file && existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TitleFile>;
        if (raw && typeof raw === "object") d = { version: 1, titles: raw.titles && typeof raw.titles === "object" ? raw.titles : {}, ...(typeof raw.boundsPeriod === "number" && raw.bounds ? { boundsPeriod: raw.boundsPeriod, bounds: raw.bounds } : {}) };
      }
    } catch { /* fail open: start fresh */ }
    this.data = d;
    return d;
  }

  /** One batch: bounds (recomputed once per rating period and on first run) and a per-coach view that advances the persisted title; flush() writes if anything changed. */
  session(ratings: Map<string, CoachGlicko>, asOf: Date): { bounds: Bounds; view: (coach: string, glicko?: CoachGlicko) => CoachRatingView; flush: () => void } {
    const d = this.load();
    let dirty = false;
    const period = Math.floor((asOf.getTime() - PERIOD_EPOCH_MS) / (PERIOD_DAYS * DAY_MS));
    if (d.boundsPeriod !== period || !d.bounds) { d.bounds = computeTitleBands(ratings, asOf); d.boundsPeriod = period; dirty = true; }
    const bounds = d.bounds;
    const view = (coach: string, glicko?: CoachGlicko): CoachRatingView => {
      const key = coach.trim().toLowerCase();
      const g = glicko ?? ratings.get(key) ?? unratedGlicko();
      const prev = d.titles[key];
      const out = coachRatingFor(key, g, { bounds, previousTitle: prev?.title });
      if (g.games > 0 && prev?.title !== out.rank) { d.titles[key] = { title: out.rank, cr: out.cr, at: asOf.toISOString() }; dirty = true; }
      return out;
    };
    const flush = (): void => {
      if (!dirty || !this.file) { dirty = false; return; }
      try { atomicWriteTextFile(this.file, `${JSON.stringify(d, null, 2)}\n`); dirty = false; } catch { /* fail open: titles still served from memory */ }
    };
    return { bounds, view, flush };
  }
}
