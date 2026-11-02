import type { LeagueFixture } from "./types.js";

/**
 * The one sanitiser every fixture serialiser uses before a fixture leaves the server: the Super FUMBBL notice bookkeeping
 * and resultEdit (which organiser typed or changed a score, and when: Weekly Digest bookkeeping, exported only to that
 * organiser) never appear in a read model.
 */
export function publicFixture<T extends Partial<LeagueFixture>>(f: T): Omit<T, "forkNotice" | "resultEdit"> {
  const { forkNotice: _n, resultEdit: _e, ...rest } = f;
  return rest;
}
