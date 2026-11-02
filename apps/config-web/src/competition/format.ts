/**
 * Competition format settings (creation wizards v2, owner grill 2026-11-02, round 2 Q6 and Q13). Pure and dependency-free,
 * shared by the server (parse + store) and the SPA (wizards, Manage, summaries):
 *
 * - Points scheme W/D/L: editable whole numbers, default 3/1/0, preset 2000/1000/0. A bye scores a win.
 * - **Points always rank first**, then a tiebreaker chain of up to 4 from Buchholz, Sonneborn-Berger, TD difference,
 *   casualty difference, head to head, TDs scored and casualties caused (the standings maths is src/tournaments/pairing.ts).
 * - Pairing avoidance (Swiss): none / same club / same region / both.
 * - Regions: the organiser's list; coaches pick one at join (a later lane). Entries carry a nullable region and clubId.
 *
 * Old tournaments stored a ladder from the single `primaryTiebreaker` ([primary, TD diff, CAS diff]): tiebreakerChainOf
 * reads that as a chain (the old primary is chain[0]), so they keep ranking exactly as before.
 */

export const TIEBREAKER_CHAIN_KEYS = [
  "buchholz", "sonnebornBerger", "touchdownDifferential", "casualtyDifferential", "headToHead", "touchdownsFor", "casualtiesFor",
] as const;
export type ChainTiebreaker = (typeof TIEBREAKER_CHAIN_KEYS)[number];
export const TIEBREAKER_CHAIN_MAX = 4;
export const TIEBREAKER_CHAIN_LABEL: Record<ChainTiebreaker, string> = {
  buchholz: "Buchholz",
  sonnebornBerger: "Sonneborn-Berger",
  touchdownDifferential: "TD difference",
  casualtyDifferential: "Casualty difference",
  headToHead: "Head to head",
  touchdownsFor: "TDs scored",
  casualtiesFor: "Casualties caused",
};
/** What a new competition ranks by after points (the old default ladder). */
export const DEFAULT_TIEBREAKER_CHAIN: readonly ChainTiebreaker[] = ["buchholz", "touchdownDifferential", "casualtyDifferential"];

export interface PointsScheme { win: number; draw: number; loss: number }
export const DEFAULT_POINTS: PointsScheme = { win: 3, draw: 1, loss: 0 };
export const POINTS_PRESET_2000: PointsScheme = { win: 2000, draw: 1000, loss: 0 };
export const POINTS_MIN = -10000;
export const POINTS_MAX = 100000;

export type PairingAvoid = "none" | "club" | "region" | "both";
export const PAIRING_AVOID: readonly PairingAvoid[] = ["none", "club", "region", "both"];
export const PAIRING_AVOID_LABEL: Record<PairingAvoid, string> = { none: "None", club: "Same club", region: "Same region", both: "Same club or region" };

export const REGIONS_MAX = 32;
export const REGION_NAME_MAX = 40;

export class FormatError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "FormatError";
  }
}

export const isChainTiebreaker = (v: unknown): v is ChainTiebreaker => typeof v === "string" && (TIEBREAKER_CHAIN_KEYS as readonly string[]).includes(v);

/** A chain from a request body: 0 to 4 distinct known tiebreakers, in order. */
export function parseTiebreakerChain(raw: unknown): ChainTiebreaker[] {
  if (!Array.isArray(raw)) throw new FormatError("The tiebreakers must be a list.", "tiebreakers");
  if (raw.length > TIEBREAKER_CHAIN_MAX) throw new FormatError(`Pick at most ${TIEBREAKER_CHAIN_MAX} tiebreakers.`, "tiebreakers");
  const out: ChainTiebreaker[] = [];
  for (const k of raw) {
    if (!isChainTiebreaker(k)) throw new FormatError(`Unknown tiebreaker: ${String(k).slice(0, 40)}.`, "tiebreakers");
    if (out.includes(k)) throw new FormatError(`${TIEBREAKER_CHAIN_LABEL[k]} is listed twice.`, "tiebreakers");
    out.push(k);
  }
  return out;
}

/** The chain a stored ladder ranks by: known chain keys in order, at most 4 (older extra keys still rank: see pairing.ts). */
export function tiebreakerChainOf(stored: readonly string[] | undefined): ChainTiebreaker[] {
  return (stored ?? []).filter(isChainTiebreaker).filter((k, i, all) => all.indexOf(k) === i).slice(0, TIEBREAKER_CHAIN_MAX);
}

/** The old single-field input ("primaryTiebreaker") as a chain: the primary first, then the old ladder's TD and CAS diff. */
export function chainFromPrimary(primary: "buchholz" | "sonnebornBerger"): ChainTiebreaker[] {
  return [primary, "touchdownDifferential", "casualtyDifferential"];
}

function pointValue(v: unknown, field: string, label: string): number {
  const n = typeof v === "string" && v.trim() ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < POINTS_MIN || n > POINTS_MAX)
    throw new FormatError(`${label} points must be a whole number from ${POINTS_MIN} to ${POINTS_MAX}.`, field);
  return n;
}

/** W/D/L from a request body. A win must score more than a draw, and a draw at least a loss. */
export function parsePointsScheme(raw: unknown): PointsScheme {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new FormatError("Points must be an object with win, draw and loss.", "points");
  const r = raw as Record<string, unknown>;
  const p = { win: pointValue(r.win, "points.win", "Win"), draw: pointValue(r.draw, "points.draw", "Draw"), loss: pointValue(r.loss, "points.loss", "Loss") };
  if (!(p.win > p.draw)) throw new FormatError("A win must score more points than a draw.", "points.win");
  if (p.draw < p.loss) throw new FormatError("A draw must score at least as many points as a loss.", "points.draw");
  return p;
}

export function parsePairingAvoid(raw: unknown): PairingAvoid {
  if (!(PAIRING_AVOID as readonly unknown[]).includes(raw)) throw new FormatError("Avoid pairing must be none, club, region or both.", "pairingAvoid");
  return raw as PairingAvoid;
}

/** The organiser's regions: up to 32 distinct names of at most 40 characters (blank lines dropped). */
export function parseRegions(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new FormatError("Regions must be a list.", "regions");
  const names: string[] = [];
  for (const r of raw) {
    if (typeof r !== "string") throw new FormatError("Each region must be text.", "regions");
    const t = r.trim().replace(/\s+/g, " ");
    if (!t) continue;
    if (t.length > REGION_NAME_MAX) throw new FormatError(`Region names must be at most ${REGION_NAME_MAX} characters.`, "regions");
    if (names.some((n) => n.toLowerCase() === t.toLowerCase())) throw new FormatError(`${t} is listed twice.`, "regions");
    names.push(t);
  }
  if (names.length > REGIONS_MAX) throw new FormatError(`At most ${REGIONS_MAX} regions.`, "regions");
  return names;
}

export const pointsText = (p: PointsScheme): string => `${p.win} / ${p.draw} / ${p.loss}`;
export const chainText = (chain: readonly ChainTiebreaker[]): string =>
  ["Points", ...chain.map((k) => TIEBREAKER_CHAIN_LABEL[k])].join(", then ");

/** What two entries clash on under `avoid` (empty = no clash). Blank club / region never clashes. */
export function pairingClash(
  avoid: PairingAvoid | undefined,
  a: { clubId?: string | null; region?: string | null },
  b: { clubId?: string | null; region?: string | null },
): Array<"club" | "region"> {
  const out: Array<"club" | "region"> = [];
  if (!avoid || avoid === "none") return out;
  const same = (x?: string | null, y?: string | null) => Boolean(x && y && x.trim().toLowerCase() === y.trim().toLowerCase());
  if ((avoid === "club" || avoid === "both") && same(a.clubId, b.clubId)) out.push("club");
  if ((avoid === "region" || avoid === "both") && same(a.region, b.region)) out.push("region");
  return out;
}
