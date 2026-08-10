/**
 * SKETCH (unbuilt — no toolchain yet; see docs/roadmap.md M1).
 * Normalized team roster — the output of bb-ingest and the input to validate().
 * PURE DATA ONLY: this package must stay Node-free so it runs unchanged in the
 * FUMBBL40k Tauri webview and the tournament service (tournament-play-plan.md T1).
 */

/** BB2025 target-number stat, e.g. "3+" (AG/PA/AV); "-" = no value (e.g. PA on some Big Guys). */
export type Target = `${number}+` | "-";

export interface RosterPlayer {
  number: number;
  /** As printed; matched against dataset position names/aliases. */
  positionName: string;
  MA: number;
  ST: number;
  AG: Target;
  PA: Target;
  AV: Target;
  /** All skills as printed on the sheet (base + added, undifferentiated). */
  skills: string[];
  /** Filled by the validator by diffing against the dataset position. */
  baseSkills?: string[];
  addedSkills?: string[];
  /** e.g. ["Human", "Lineman"] — used by T1 keyword gating too. */
  keywords: string[];
  /** Gold cost as printed. */
  cost: number;
}

export interface RosterInducement {
  id?: string;
  name: string;
  count?: number;
  cost?: number;
}

export interface RosterSummary {
  playersCost: number;
  skillsCost: number;
  inducementCost: number;
  sidelineCost: number;
  total: number;
  primarySkills?: number;
  secondarySkills?: number;
}

export interface Roster {
  /** Race, e.g. "Amazon". */
  rosterName: string;
  coach: string;
  teamName: string;
  sideline: {
    apothecary: boolean;
    assistantCoaches: number;
    cheerleaders: number;
    dedicatedFans: number;
    reRolls: number;
  };
  inducements: RosterInducement[];
  leagues: string[];
  specialRules: string[];
  players: RosterPlayer[];
  /** True when composed in CUSTOM mode (owner bypass of legality/budget). Gated tournament
   *  validation must reject or re-price such a team — its free skills/stats aren't legal (SR-258). */
  custom?: boolean;
  /** Present when the source printed one (bbtc.pl does); cross-checked, never trusted. */
  summary?: RosterSummary;
}
