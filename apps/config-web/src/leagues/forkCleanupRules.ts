/**
 * When a fixture's fork team copies may be removed (owner 11-03: "League manager teams that are used for a match should
 * be deleted at the end."). Pure rules, shared by the fork routes (forkPlay.ts marks the fixture) and the runner
 * (forkCleanup.ts removes the copies).
 *
 * A fixture no longer needs its copies when:
 *   - its fork game is finished AND the result is banked into the league (status "finished" with fork.result);
 *   - Super FUMBBL play is cancelled and no game is held (the game was withdrawn, or none was scheduled);
 *   - no game is held and the fixture is cancelled or already has a result some other way (hand entry, forfeit).
 * A game that is scheduled, running, held for a redraft, or that may exist (an unclear schedule answer) keeps them.
 */
import { fixturePlayed } from "./tourplay.js";
import type { FixtureForkCleanup, ForkSide, LeagueFixture } from "./types.js";

const SIDES: ForkSide[] = ["home", "away"];

/** Fork team ids the league builds (forkTeam.ts forkTeamIdFor). Nothing else is ever removed. */
export const isLeagueForkTeamId = (id: string | undefined): id is string => typeof id === "string" && /^lg_[a-f0-9]{16}$/.test(id);

/** The fork team copies this fixture installed (one per side, coach as recorded at build). */
export function fixtureForkCopies(f: LeagueFixture): Array<{ side: ForkSide; forkTeamId: string; coach: string }> {
  const out: Array<{ side: ForkSide; forkTeamId: string; coach: string }> = [];
  for (const s of SIDES) {
    const t = f.fork?.teams[s];
    if (t && isLeagueForkTeamId(t.forkTeamId)) out.push({ side: s, forkTeamId: t.forkTeamId, coach: t.coach });
  }
  return out;
}

/** Why this fixture's fork copies are no longer needed ("" = they are still needed, or there are none). */
export function forkCleanupReason(f: LeagueFixture): string {
  const fork = f.fork;
  if (!fork || !fixtureForkCopies(f).length) return "";
  if (fork.redraftHold) return "";
  if (fork.status === "finished") return fork.result ? "the game is over and its result is banked" : "";
  if (fork.gameId || fork.uncertain) return ""; // a game is held, or may exist
  if (fork.status === "cancelled" || f.forkCancelled) return "Super FUMBBL play was cancelled";
  if ((fork.status === "teams_built" || fork.status === "launch_failed") && fixturePlayed(f)) return "the fixture has a result without a Super FUMBBL game";
  return "";
}

/** Retry delay after `attempts` failures: 2 min, doubling, at most 6 hours. */
export function cleanupBackoffMs(attempts: number): number {
  return Math.min(2 * 60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
}

/** Marks the fixture's copies for removal (idempotent: an existing marker is kept). */
export function markForkCleanup(f: LeagueFixture, now: Date, reason: string): FixtureForkCleanup | undefined {
  if (!f.fork) return undefined;
  f.fork.cleanup ??= { state: "pending", reason, since: now.toISOString(), attempts: 0 };
  return f.fork.cleanup;
}

/** The runner should try this fixture now: a pending marker, or a failed one whose backoff has passed. */
export function cleanupDue(f: LeagueFixture, now: Date): boolean {
  const c = f.fork?.cleanup;
  if (!c || c.state === "removed") return false;
  if (c.state === "failed" && c.nextAttemptAt && Date.parse(c.nextAttemptAt) > now.getTime()) return false;
  return true;
}
