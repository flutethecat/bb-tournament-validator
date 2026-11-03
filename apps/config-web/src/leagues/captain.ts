/**
 * League Team Captain vacancy (owner ruling 10-30; ../captain.ts has the rules and choices). `captainVacant` on a league
 * team is set when a roster write takes the team from "has a captain" to "has none", and cleared once a player on the
 * roster carries the trait again. Called by every roster writer: fork result banking (forkResult.ts mutateLeagueTeam),
 * the redraft (redraft.ts buildDraftTeam, where a captain who is not re-hired leaves) and, as the data-layer net, the
 * store's season write (store.ts putSeason) against the stored copy of the same season. Light on purpose: no dataset
 * imports, so the store can call it. Eligibility and the appointment route live in captainApi.ts.
 */
import { hasTeamCaptain } from "../captain.js";
import type { LeaguePlayer, LeagueTeam, SeasonRecord } from "./types.js";

/** The roster player known by `id` (its own id, or an earlier season's id: a redraft gives kept players fresh ids). */
const holderOf = (players: readonly LeaguePlayer[], id: string): LeaguePlayer | undefined =>
  players.find((p) => p.playerId === id || (p.previousIds ?? []).includes(id));

/**
 * Sets / clears `after.captainVacant` and `after.captainPlayerId` from the roster change `before` -> `after` (in place).
 * Idempotent. The captain's identity is the persisted `captainPlayerId` (set from any roster that shows the trait, an
 * appointment, or a draft nomination) and is carried across writes, so a re-import that omits skills keeps it and a
 * later departure of that player is still seen. Departure = that id (or a redraft successor) no longer on the roster.
 * An existing vacancy carries over (a fresh import has no flag) until a roster player carries the trait again.
 */
export function markCaptainVacancy(before: Pick<LeagueTeam, "players" | "captainVacant" | "captainPlayerId"> | undefined, after: LeagueTeam): void {
  const players = after.players ?? [];
  const carrier = players.find((p) => hasTeamCaptain(p.skills));
  if (carrier) {
    after.captainPlayerId = carrier.playerId;
    delete after.captainVacant;
    return;
  }
  const known = after.captainPlayerId ?? before?.captainPlayerId ?? before?.players?.find((p) => hasTeamCaptain(p.skills))?.playerId;
  if (known) {
    const holder = holderOf(players, known);
    if (holder) {
      after.captainPlayerId = holder.playerId; // still rostered (skills omitted by an import): no vacancy
      delete after.captainVacant;
    } else {
      delete after.captainPlayerId;
      after.captainVacant = true;
    }
    return;
  }
  if (after.captainVacant === true || before?.captainVacant === true) after.captainVacant = true;
  else delete after.captainVacant;
}

/** The same for every team of `next` that `prior` (the stored copy of the same season) also holds. */
export function markSeasonCaptainVacancies(prior: SeasonRecord | undefined, next: SeasonRecord): void {
  const byId = new Map((prior?.teams ?? []).map((t) => [t.id, t] as const));
  for (const team of next.teams ?? []) {
    const prior = byId.get(team.id);
    // A swap puts a different team (another teamUid) behind the same season id: the old team's captain is not this one's.
    const same = !prior || !prior.teamUid || !team.teamUid || prior.teamUid === team.teamUid;
    markCaptainVacancy(same ? prior : undefined, team);
  }
}

/**
 * Is this league team waiting for a new captain? The flag, confirmed against the roster (a team whose roster carries a
 * captain again is never vacant). For the fixture lobby / pre-game reminder chip.
 */
export function leagueTeamCaptainVacant(team: Pick<LeagueTeam, "players" | "captainVacant"> | undefined): boolean {
  return Boolean(team?.captainVacant === true && !(team.players ?? []).some((p) => hasTeamCaptain(p.skills)));
}
