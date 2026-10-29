// Coach Rating (CR) for the fork's coaches, shown in the recorder hero. Computed server-side from OUR records: the fork Elo (coachElo.ts, 1500 baseline, K 32)
// is mapped onto FUMBBL's CR scale (150 baseline): CR = 150 + (elo - 1500) / 10, shown as a whole number.
//
// PROVISIONAL RANK TABLE: FUMBBL's help pages (help:Ranking, help:CoachRating) sit behind a bot check and could not be read, so the thresholds below are
// NOT FUMBBL's published figures. They are one constant (RANKS), anchored on the 150 baseline = Veteran and on the one CR/title pair the repo's coach-card
// fixture carries (162.4 = Super Star). Replace the numbers once the owner supplies the page; the tests read the table, not literals.

export interface CoachRank { name: string; min: number; key: string }

/** Ascending by `min`; a CR below the first row is still the first rank. */
export const RANKS: readonly CoachRank[] = [
  { name: "Rookie", min: -Infinity, key: "rookie" },
  { name: "Experienced", min: 140, key: "experienced" },
  { name: "Veteran", min: 150, key: "veteran" },
  { name: "Emerging Star", min: 155, key: "emerging" },
  { name: "Star", min: 158, key: "star" },
  { name: "Super Star", min: 162, key: "super" },
  { name: "Legend", min: 175, key: "legend" },
];

export const CR_BASELINE = 150;
export const ELO_BASELINE = 1500;

/** The fork Elo on FUMBBL's CR scale (150 at 1500), rounded to a whole number. */
export const eloToCr = (elo: number): number => Math.round(CR_BASELINE + (elo - ELO_BASELINE) / 10);

export function rankOf(cr: number): CoachRank {
  let best = RANKS[0]!;
  for (const r of RANKS) if (cr >= r.min) best = r;
  return best;
}

export interface CoachRatingView { cr: number; rank: string; rankKey: string }

export function coachRatingFor(elo: number | undefined): CoachRatingView {
  const cr = eloToCr(elo ?? ELO_BASELINE);
  const r = rankOf(cr);
  return { cr, rank: r.name, rankKey: r.key };
}
