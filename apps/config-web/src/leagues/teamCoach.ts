/**
 * Assign coach account (League page, Teams tab, organisers and site admins): seats a fork account on a league team,
 * e.g. on an imported team for a test league game.
 *
 *   PATCH /api/leagues/:id/seasons/:seasonId/teams/:teamId { revision, coachId: string | null, allSeasons? }
 *
 * `revision` (or If-Match) is the season's revision as last read (428 missing, 409 stale). coachId is looked up against
 * the identities (the identity's own spelling; unknown or banned: 400); null clears an earlier assignment. The change
 * applies to the team's roster record, its season participant row and the team's side of every fixture WITHOUT a
 * result (played fixtures keep the coach who played them); allSeasons also applies it to every other season holding a
 * team with the same id (the team's lineage: redraft and season start keep the id). A team in a running Super FUMBBL
 * game is refused (409). Each changed season logs a "team-coach" entry. The assigned account is authoritative for
 * seating, ownership and the statistics alias table (identity.ts: coachAssigned rows link nothing).
 */
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { addLog } from "./events.js";
import { forkPlayLock } from "./forkTeam.js";
import { requestRevision } from "./http.js";
import { fixturePlayed } from "./tourplay.js";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";

export interface AssignCoachInput {
  /** The identity's spelling, or null to clear. */
  coachId: string | null;
  allSeasons: boolean;
}

const same = (a: string | undefined, b: string | undefined): boolean => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/** Applies the assignment to one season in place (and logs it); false when the season has no such team. */
export function applyTeamCoach(season: SeasonRecord, teamId: string, input: AssignCoachInput, by: string, at: string): boolean {
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) return false;
  const before = team.coachId;
  const to = input.coachId;
  const setTeam = (t: LeagueTeam): void => {
    if (to) { t.coachId = to; t.coachAssigned = { by, at }; } else { delete t.coachId; delete t.coachAssigned; }
  };
  setTeam(team);
  for (const p of season.participants) {
    if (p.team.trim().toLowerCase() !== team.name.trim().toLowerCase() || !same(p.coach, team.coach)) continue;
    if (to) { p.coachId = to; p.coachAssigned = true; } else if (p.coachAssigned) { delete p.coachId; delete p.coachAssigned; }
  }
  for (const f of season.fixtures) {
    if (fixturePlayed(f)) continue;
    for (const side of [f.home, f.away]) {
      if (side.teamId !== teamId) continue;
      if (to) { side.coachId = to; side.coachAssigned = true; } else if (side.coachAssigned) { delete side.coachId; delete side.coachAssigned; }
    }
  }
  addLog(season, {
    at, by, kind: "team-coach", teamId,
    text: to ? `${by} assigned the coach account ${to} to ${team.name}${before && !same(before, to) ? ` (was ${before})` : ""}.` : `${by} cleared the coach account of ${team.name}.`,
  });
  return true;
}

/**
 * The route body (after the organiser gate in api.ts). `resolve` maps a typed name to the identity's spelling
 * (undefined: no such coach).
 */
export function assignTeamCoach(
  league: LeagueRecord, seasonId: string, teamId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps,
  resolve: (name: string) => string | undefined,
): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) return { status: 404, body: { error: "Team not found in this season." } };
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return { status: 428, body: { error: "Send the season revision you loaded (revision or If-Match).", revision: current } };
  if (asked === "bad") return { status: 400, body: { error: "revision must be a whole number.", field: "revision" } };
  if (asked !== current) return { status: 409, body: { error: "This season changed since you opened it. Reload to see the latest.", revision: current } };
  let coachId: string | null;
  if (input.coachId === null) coachId = null;
  else if (typeof input.coachId === "string" && input.coachId.trim()) {
    const found = resolve(input.coachId);
    if (!found) return { status: 400, body: { error: `No coach called "${input.coachId.trim().slice(0, 64)}".`, field: "coachId" } };
    coachId = found;
  } else return { status: 400, body: { error: "Pick a coach account (coachId), or send null to clear it.", field: "coachId" } };
  if (input.allSeasons !== undefined && typeof input.allSeasons !== "boolean") return { status: 400, body: { error: "allSeasons must be true or false.", field: "allSeasons" } };
  const allSeasons = input.allSeasons === true;
  const targets = allSeasons ? deps.store.seasons(league.id).filter((s) => s.teams.some((t) => t.id === teamId)) : [season];
  for (const s of targets) {
    const locked = forkPlayLock(s, teamId);
    if (locked) return { status: 409, body: { error: locked } };
  }
  const at = (deps.now?.() ?? new Date()).toISOString();
  const changed: string[] = [];
  for (const s of targets) {
    const fresh = s.id === season.id ? season : s;
    if (applyTeamCoach(fresh, teamId, { coachId, allSeasons }, who.coach, at)) {
      deps.store.putSeason(fresh);
      changed.push(fresh.id);
    }
  }
  const saved = deps.store.season(league.id, season.id)!;
  return { status: 200, body: { ok: true, team: saved.teams.find((t) => t.id === teamId), seasons: changed, revision: saved.revision ?? 0 } };
}
