import type { LeagueTeam } from "./types.js";

/** The coach-identity keys a reset snapshot never holds (account deletion scrubs any stored before this rule). */
export const RESET_IDENTITY_KEYS = ["history", "statusChanged", "coach", "coachId", "coachAssigned", "nafUser", "entryHistory", "takeover", "swapRequest", "transfer"] as const;

/**
 * A team's roster as tournament-style ladders reset it. No coach data is kept in the snapshot (account deletion anonymises
 * the team rows, not this copy): the coach, the account, the history and every "by" are left out; the reset takes the
 * coach fields from the live team.
 */
export const resetRosterOf = (team: LeagueTeam): unknown => {
  const { history: _h, statusChanged: _s, coach: _c, coachId: _ci, coachAssigned: _ca, nafUser: _n, entryHistory: _e, takeover: _t, swapRequest: _sr, transfer: _tr, ...rest } = structuredClone(team);
  return {
    ...rest,
    players: rest.players.map(({ pendingAdvance: _p, injuries, ...p }) => ({ ...p, ...(injuries?.length ? { injuries: injuries.map(({ by: _b, ...i }) => i) } : {}) })),
  };
};

