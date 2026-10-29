// Coach Rating (CR) for the fork's coaches, shown in the recorder hero. CR IS our fork Elo (coachElo.ts: 1500 baseline, K 32), shown as a whole number.
//
// Titles follow FUMBBL's coach ranking (https://fumbbl.com/help:CoachRankingIntro, updated 2025-09-05; details: help:CoachRankingImplementationDetails):
// eight titles; every coach starts at 1500; Rookie is forced for a coach with fewer than 10 matches; a new coach starts in Emerging Star (around 1500).
// FUMBBL assigns the other titles as percentages of ACTIVE coaches (Legend = the top X), recomputed periodically with hysteresis, and does not publish the
// formula. Until we have enough coaches for percentiles, BANDS below are fixed defaults on the Elo.
// TODO: replace BANDS with percentile bands over our active coaches, recalculated periodically, with hysteresis so a coach does not flap at a boundary.

export interface CoachRank { name: string; key: string; pips: number }

/** In order, lowest first. `min` is the lowest Elo of the band; Rookie is not a band (it is forced by fewer than ROOKIE_GAMES games). */
export const BANDS: ReadonlyArray<CoachRank & { min: number }> = [
  { name: "Experienced", key: "experienced", pips: 2, min: -Infinity }, // below 1450
  { name: "Veteran", key: "veteran", pips: 3, min: 1450 }, // 1450-1499
  { name: "Emerging Star", key: "emerging", pips: 4, min: 1500 }, // 1500-1549
  { name: "Star", key: "star", pips: 5, min: 1550 }, // 1550-1599
  { name: "Super Star", key: "super", pips: 6, min: 1600 }, // 1600-1674
  { name: "Megastar", key: "mega", pips: 7, min: 1675 }, // 1675-1749
  { name: "Legend", key: "legend", pips: 8, min: 1750 }, // 1750 and up
];
export const ROOKIE: CoachRank = { name: "Rookie", key: "rookie", pips: 1 };
/** Fewer than this many matches: Rookie, whatever the rating. */
export const ROOKIE_GAMES = 10;
export const ELO_BASELINE = 1500;

/** The coach rating: the fork Elo as a whole number. */
export const eloToCr = (elo: number): number => Math.round(elo);

export function rankOf(cr: number, games: number): CoachRank {
  if (games < ROOKIE_GAMES) return ROOKIE;
  let best: CoachRank = BANDS[0]!;
  for (const b of BANDS) if (cr >= b.min) best = b;
  return best;
}

export interface CoachRatingView { cr: number; rank: string; rankKey: string; games: number }

export function coachRatingFor(elo: number | undefined, games = 0): CoachRatingView {
  const cr = eloToCr(elo ?? ELO_BASELINE);
  const r = rankOf(cr, games);
  return { cr, rank: r.name, rankKey: r.key, games };
}
