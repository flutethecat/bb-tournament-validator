/**
 * SKETCH (unbuilt). Validation output types — the product of the whole tool.
 * Messages + suggestions are what the Discord bot renders and the coach reads.
 */

export type Severity = "error" | "warning" | "info";

export interface Finding {
  /** Stable id of the rule that produced this, e.g. "skill-points". */
  ruleId: string;
  severity: Severity;
  /** Player number when player-specific. */
  playerRef?: number;
  /** Human-readable explanation, e.g. "Guard on Jaguar Warrior is a secondary (Agility) skill". */
  message: string;
  expected?: string | number;
  actual?: string | number;
  /** How to fix, e.g. "drop one Block (−2 SP), or raise the SP budget to 12". */
  suggestion?: string;
}

export interface RecomputedSummary {
  skillPointsUsed: number;
  skillPointBudget: number;
  goldUsed: number;
  goldBudget: number | null;
  playerCount: number;
  primarySkillCount: number;
  secondarySkillCount: number;
}

export interface ValidationResult {
  /** True iff there are no error-severity findings. */
  valid: boolean;
  errors: Finding[];
  warnings: Finding[];
  infos: Finding[];
  recomputedSummary: RecomputedSummary;
}
