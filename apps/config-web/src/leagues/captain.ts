/**
 * League Team Captain vacancy (owner ruling 10-30; ../captain.ts has the rules and choices). `captainVacant` on a league
 * team is set when a roster write takes the team from "has a captain" to "has none", and cleared once a player on the
 * roster carries the trait again. Called by every roster writer: fork result banking (forkResult.ts mutateLeagueTeam),
 * the redraft (redraft.ts buildDraftTeam, where a captain who is not re-hired leaves) and, as the data-layer net, the
 * store's season write (store.ts putSeason) against the stored copy of the same season. Light on purpose: no dataset
 * imports, so the store can call it. Eligibility and the appointment route live in captainApi.ts.
 */
import { hasTeamCaptain, nextCaptainVacancy } from "../captain.js";
import type { LeagueTeam, SeasonRecord } from "./types.js";

const vacancyPlayers = (players: LeagueTeam["players"] | undefined) =>
  (players ?? []).map((p) => ({ ids: [p.playerId, ...(p.previousIds ?? [])], skills: p.skills ?? [] }));

/**
 * Sets / clears `after.captainVacant` from the roster change `before` -> `after` (in place). Idempotent. Departure is by
 * player id (a re-import that omits the captain's skills is no departure), and a vacancy on `before` carries over (a
 * fresh import has no flag) until a roster player carries the trait again.
 */
export function markCaptainVacancy(before: Pick<LeagueTeam, "players" | "captainVacant"> | undefined, after: LeagueTeam): void {
  const vacant = nextCaptainVacancy(vacancyPlayers(before?.players), vacancyPlayers(after.players), after.captainVacant === true || before?.captainVacant === true);
  if (vacant) after.captainVacant = true;
  else delete after.captainVacant;
}

/** The same for every team of `next` that `prior` (the stored copy of the same season) also holds. */
export function markSeasonCaptainVacancies(prior: SeasonRecord | undefined, next: SeasonRecord): void {
  const byId = new Map((prior?.teams ?? []).map((t) => [t.id, t] as const));
  for (const team of next.teams ?? []) markCaptainVacancy(byId.get(team.id), team);
}

/**
 * Is this league team waiting for a new captain? The flag, confirmed against the roster (a team whose roster carries a
 * captain again is never vacant). For the fixture lobby / pre-game reminder chip.
 */
export function leagueTeamCaptainVacant(team: Pick<LeagueTeam, "players" | "captainVacant"> | undefined): boolean {
  return Boolean(team?.captainVacant === true && !(team.players ?? []).some((p) => hasTeamCaptain(p.skills)));
}
