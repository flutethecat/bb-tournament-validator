// What counts for the site ratings (owner round 2, 11-04): "Forfeits and admin/override results never count."
// Pure rules over one stored result; src/ratings/sources.ts applies them to every store, and league ladders ranked by
// rating (src/leagues/ladder.ts) use the league rule for their own rating too.

import { fixtureOutcome } from "../leagues/identity.js";
import type { LeagueFixture } from "../leagues/types.js";
import type { ScheduledMatchRecord } from "../tournaments/types.js";

export type RatingExclusion =
  /** No result yet, cleared, or a 0-0 suspended fixture. */
  | "no-result"
  /** A test fixture or competition. */
  | "test"
  /** An administrative forfeit (the forfeit dialog, an inactive team's forfeit). */
  | "forfeit"
  /** A deadline decision: both sides lose, or no result. */
  | "deadline"
  /** An organiser or admin overrode a result that already existed (league resultEdit, tournament result edit). */
  | "override"
  /** A concession with no played game behind it (a forfeit recorded as a concession, e.g. a TourPlay import). */
  | "concession"
  /** A tournament bye, or a cancelled / dismissed fixture. */
  | "bye"
  | "cancelled";

export type Verdict = { counts: true; homeScore: 0 | 0.5 | 1 } | { counts: false; reason: RatingExclusion };

const score = (o: "win" | "draw" | "loss"): 0 | 0.5 | 1 => (o === "win" ? 1 : o === "draw" ? 0.5 : 0);

/**
 * A league or ladder fixture. Counts: a played result (recorded on Super FUMBBL or the match recorder, imported, or a
 * first-time typed score). Never: a forfeit, a deadline decision, an organiser override of an existing result, a test
 * fixture, or a concession that no played game backs (only a Super FUMBBL result or a recorder result proves the game
 * was played; a played concession is a loss for the coach who conceded).
 */
export function leagueFixtureVerdict(f: LeagueFixture): Verdict {
  if (f.test) return { counts: false, reason: "test" };
  if (f.forfeit || f.forfeitDetail || f.inactiveDecision?.decision === "forfeit") return { counts: false, reason: "forfeit" };
  if (f.deadlineOutcome && f.deadlineOutcome.outcome !== "review") return { counts: false, reason: "deadline" };
  if (f.resultEdit) return { counts: false, reason: "override" };
  const out = fixtureOutcome(f);
  if (!out) return { counts: false, reason: "no-result" };
  if (f.home.conceded || f.away.conceded) {
    const played = Boolean(f.fork?.result) || Boolean(f.tabletop?.opId || f.tabletop?.reportedAt);
    if (!played || (f.home.conceded && f.away.conceded)) return { counts: false, reason: "concession" };
  }
  return { counts: true, homeScore: score(out.home) };
}

/**
 * A tournament fixture. Counts: a reported result (Super FUMBBL, the match recorder, or a manager's first-time entry).
 * Never: a bye, a cancelled or dismissed fixture, or a result a manager edited (a result reported again after a manager
 * cleared it counts again: the store stamps it reportedAgainAt, and the new report is a played result).
 */
export function tournamentMatchVerdict(m: ScheduledMatchRecord): Verdict {
  if (!m.away) return { counts: false, reason: "bye" };
  if (m.status === "cancelled" || m.status === "dismissed") return { counts: false, reason: "cancelled" };
  const r = m.result;
  if (!r || !Number.isFinite(r.homeScore) || !Number.isFinite(r.awayScore)) return { counts: false, reason: "no-result" };
  if (m.edited?.kind === "result" && !m.edited.reportedAgainAt) return { counts: false, reason: "override" };
  return { counts: true, homeScore: r.homeScore > r.awayScore ? 1 : r.homeScore < r.awayScore ? 0 : 0.5 };
}
