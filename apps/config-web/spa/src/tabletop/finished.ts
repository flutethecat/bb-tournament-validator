// Shapes of a finished game as the recorder's read-only parts show it: one team's finished-game summary (the match
// reporter's post-match preview, or a game page's subset with no treasury) and the scoreboard's final board.

import type { PlayerLineView, Side, SummaryView } from "./recorder";

export type SummaryPlayerLine = Omit<PlayerLineView, "sppEarned"> & { sppEarned?: number; position?: string };
export type MatchSummaryView = Omit<SummaryView, "treasuryBefore" | "treasuryAfter" | "players" | "postMatch" | "applied" | "winnings" | "fansBefore" | "fansAfter"> & {
  treasuryBefore?: number; treasuryAfter?: number; players: SummaryPlayerLine[];
  /** The recorder's post-match step; absent on a game that has none (online games). */
  postMatch?: SummaryView["postMatch"]; applied?: boolean;
  winnings?: number; fansBefore?: number; fansAfter?: number;
  /** Online games, when the server's result carried them: the fan factor and the dedicated-fans change. */
  fanFactor?: number; fansChange?: number;
};

/**
 * A finished game on the scoreboard (game page): the server's final score and casualties (null = not recorded, shown as a
 * dash) and the fouls it counted (null = unknown, not shown).
 */
export interface FinalBoard {
  score: Record<Side, number | null>; cas: Record<Side, number | null>; fouls: Record<Side, number> | null;
  /** The side that conceded, as the server reported it. */
  concede?: Side | null;
}
