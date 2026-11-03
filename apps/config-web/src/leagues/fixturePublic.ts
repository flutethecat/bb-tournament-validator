import type { LeagueFixture } from "./types.js";

/**
 * The one sanitiser every fixture serialiser uses before a fixture leaves the server: the Super FUMBBL notice bookkeeping,
 * resultEdit (which organiser typed or changed a score, and when: Weekly Digest bookkeeping, exported only to that
 * organiser), and a forfeit's details and unapplied defection rolls never appear in a read model.
 */
export function publicFixture<T extends Partial<LeagueFixture>>(f: T): Omit<T, "forkNotice" | "resultEdit" | "forfeitDetail" | "forfeitDraft"> {
  const { forkNotice: _n, resultEdit: _e, forfeitDetail: _d, forfeitDraft: _r, ...rest } = f;
  return rest;
}
