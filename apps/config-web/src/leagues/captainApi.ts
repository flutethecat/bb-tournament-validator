/**
 * Appoint a new Team Captain on a league team (owner ruling 10-30; ../captain.ts has the rules and choices):
 *
 *   POST /api/leagues/:id/seasons/:seasonId/teams/:teamId/captain   { revision, playerId }
 *
 * Who: the team's coach (the account seated on the team: identity.ts teamSeat), an organiser of the league, or a site
 * admin. Only while the captaincy is vacant (leagues/captain.ts). The player must be on the roster, not a Star and not a
 * Big Guy (the BB2025 dataset position of the team's race), on a roster with the Team Captain special rule. The player
 * gains the trait and Pro (Pro only when not already owned); the stored value and the team value do not change (the
 * rules: "without increasing their cost"). `revision` (or If-Match) is the season revision as read: 428 missing, 409
 * stale; the write bumps it. CSRF is the server's (every cookie POST).
 */
import { findPosition, isStarName, rosterHasTeamCaptain } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { appointedSkills, captainGrantsFor, captainIneligibility, hasTeamCaptain } from "../captain.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { leagueTeamCaptainVacant } from "./captain.js";
import { readJsonObject, requestRevision } from "./http.js";
import { teamSeat } from "./identity.js";
import { isLeagueOrganiser } from "./store.js";
import { datasetPositionFor, teamValueRoster } from "./teamValue.js";
import type { LeaguePlayer, LeagueRecord, LeagueTeam } from "./types.js";

const NO_STORE = { "cache-control": "no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => ({ status, headers: NO_STORE, body: { error, ...extra } });
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** Why this league player cannot be the team's captain ("" = eligible). Per-race dataset data decides Big Guy / Star. */
export function leagueCaptainIneligibility(team: Pick<LeagueTeam, "race">, p: Pick<LeaguePlayer, "position" | "name">): string {
  const roster = teamValueRoster(team.race);
  if (!roster) return `The ${team.race || "team's"} roster could not be checked for the Team Captain rule.`;
  if (!rosterHasTeamCaptain(roster.specialRules)) return `${roster.name} teams have no Team Captain.`;
  const star = isStarName(bb2025, p.position);
  const pos = star ? undefined : (findPosition(roster, p.position) ?? datasetPositionFor(roster, p.position));
  return captainIneligibility({ star, bigGuy: pos?.type === "bigguy", positionKnown: star || Boolean(pos), name: p.name });
}

/** The roster players who may be appointed (ids), for the picker. */
export function eligibleCaptainIds(team: Pick<LeagueTeam, "race" | "players">): string[] {
  return team.players.filter((p) => !leagueCaptainIneligibility(team, p)).map((p) => p.playerId);
}

/** Appoints `playerId` (in place) or answers why not. */
export function appointLeagueCaptain(team: LeagueTeam, playerId: string): { ok: true; player: LeaguePlayer } | { ok: false; status: number; error: string } {
  if (team.players.some((p) => hasTeamCaptain(p.skills))) return { ok: false, status: 409, error: "This team already has a Team Captain." };
  if (!leagueTeamCaptainVacant(team)) return { ok: false, status: 409, error: "A new Team Captain is appointed only when the captain has left the team." };
  const player = team.players.find((p) => p.playerId === playerId);
  if (!player) return { ok: false, status: 400, error: "That player is not on this team's roster." };
  const why = leagueCaptainIneligibility(team, player);
  if (why) return { ok: false, status: 400, error: why };
  // Recorded, never inferred from list order: an owned Pro stays an earned skill.
  player.captainGrants = captainGrantsFor(player.skills ?? []);
  player.skills = appointedSkills(player.skills ?? []);
  delete team.captainVacant;
  return { ok: true, player };
}

export async function leagueCaptainRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, teamId, fifth, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "teams" || !teamId || fifth !== "captain" || more.length) return undefined;
  if (method !== "POST") return fail(405, "Use POST.");
  if (!auth) return fail(401, "Sign in to appoint a Team Captain.");
  if (!league) return fail(404, "League not found.");
  const body = await readJsonObject(deps, 4096);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league and season as they are now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league.id);
  if (!lg) return fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) return fail(404, "Team not found.");
  const manager = auth.admin || isLeagueOrganiser(lg, auth.coach);
  if (!manager && !same(teamSeat(team).coachId, auth.coach)) return fail(403, "Only this team's coach, the league's organisers and site admins can appoint its Team Captain.");
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This team changed since you opened it. Reload to see the latest.", { revision: current });
  if (typeof input.playerId !== "string" || !input.playerId.trim() || input.playerId.length > 128) return fail(400, "playerId is required.", { field: "playerId" });
  const done = appointLeagueCaptain(team, input.playerId);
  if (!done.ok) return fail(done.status, done.error, { revision: current });
  try {
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save the Team Captain right now.");
  }
  return { status: 200, headers: NO_STORE, body: { ok: true, revision: season.revision, teamId: team.id, playerId: done.player.playerId, skills: done.player.skills } };
}

/**
 * Read model (seasonForViewer): every team whose captaincy is vacant carries `captainEligible`, the roster players the
 * picker may offer (the SPA has no dataset to tell a Big Guy or a Star apart). Never stored.
 */
export function withCaptainCandidates<T extends { teams: LeagueTeam[] }>(season: T): T {
  if (!season.teams.some((t) => leagueTeamCaptainVacant(t))) return season;
  return { ...season, teams: season.teams.map((t) => (leagueTeamCaptainVacant(t) ? { ...t, captainEligible: eligibleCaptainIds(t) } : t)) } as T;
}
