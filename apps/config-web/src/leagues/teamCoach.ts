/**
 * Assign coach account (League page, Teams tab, organisers and site admins): seats a fork account on a league team,
 * e.g. on an imported team for a test league game.
 *
 *   PATCH /api/leagues/:id/seasons/:seasonId/teams/:teamId { revision, coachId: string | null, allSeasons? }
 *
 * `revision` (or If-Match) is the season's revision as last read (428 missing, 409 stale). coachId is looked up against
 * the identities (the identity's own spelling; unknown or banned: 400); null clears the team's account, whoever set it
 * (an imported account too). The change applies to the team's roster record, its season participant row and the
 * team's side of every fixture WITHOUT a result (played fixtures keep the coach who played them), whatever set the
 * seat before; allSeasons also applies it to every other season holding a team with the same id (the team's lineage:
 * redraft and season start keep the id). Each changed season logs a "team-coach" entry.
 *
 * Concurrency: the write runs holding the fork locks of the affected fixtures and fork teams (forkPlay.ts
 * withForkLocks), so it waits for a generate / launch in flight; then it re-reads the seasons, re-checks the revision
 * and refuses a team whose Super FUMBBL game has started (409).
 *
 * The assigned account is authoritative for seating, ownership and the statistics alias table (identity.ts: rows
 * marked coachAssigned link nothing). A re-import of the season keeps the organiser's assignments and clears
 * (carryCoachAssignments, called by the importer).
 */
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { addLog, LOG_CAP } from "./events.js";
import { fixtureLockKey, withForkLocks } from "./forkPlay.js";
import { forkPlayLock, forkTeamIdFor } from "./forkTeam.js";
import { requestRevision } from "./http.js";
import { fixturePlayed } from "./tourplay.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";

const same = (a: string | undefined, b: string | undefined): boolean => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Sets (or with null clears) the team's account in one season, in place: the team record, its participant row and the
 * team's side of every unplayed fixture, regardless of what set them before. Returns false when the season has no such
 * team. `log` adds the season's "team-coach" entry.
 */
export function applyTeamCoach(season: SeasonRecord, teamId: string, to: string | null, by: string, at: string, log = true): boolean {
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) return false;
  const before = team.coachId;
  if (to) { team.coachId = to; team.coachAssigned = { by, at }; } else { delete team.coachId; team.coachAssigned = { by, at, cleared: true }; }
  const seat = <T extends { coachId?: string; coachAssigned?: true }>(row: T): void => {
    if (to) { row.coachId = to; row.coachAssigned = true; } else { delete row.coachId; delete row.coachAssigned; }
  };
  for (const p of season.participants) {
    if (p.team.trim().toLowerCase() === team.name.trim().toLowerCase() && same(p.coach, team.coach)) seat(p);
  }
  for (const f of season.fixtures) {
    if (fixturePlayed(f)) continue;
    for (const side of [f.home, f.away]) if (side.teamId === teamId) seat(side);
  }
  if (log) {
    addLog(season, {
      at, by, kind: "team-coach", teamId,
      text: to ? `${by} assigned the coach account ${to} to ${team.name}${before && !same(before, to) ? ` (was ${before})` : ""}.` : `${by} cleared the coach account of ${team.name}.`,
    });
  }
  return true;
}

/**
 * Re-import: the organiser's coach assignments and clears on `prior` (the stored season the import replaces) are put
 * back on `next` (team, participant row, unplayed fixture sides), keeping who / when, and the "team-coach" log entries
 * are carried into next's log. A team the new export no longer has is skipped. Returns the team ids carried.
 */
export function carryCoachAssignments(prior: SeasonRecord | undefined, next: SeasonRecord): string[] {
  if (!prior) return [];
  const carried: string[] = [];
  for (const t of prior.teams) {
    const mark = t.coachAssigned;
    if (!mark) continue;
    if (!applyTeamCoach(next, t.id, mark.cleared ? null : t.coachId ?? null, mark.by, mark.at, false)) continue;
    next.teams.find((x) => x.id === t.id)!.coachAssigned = { ...mark };
    carried.push(t.id);
  }
  const audit = (prior.log ?? []).filter((e) => e.kind === "team-coach");
  if (audit.length) {
    const have = new Set((next.log ?? []).map((e) => `${e.at}|${e.kind}|${e.teamId ?? ""}|${e.text}`));
    const add = audit.filter((e) => !have.has(`${e.at}|${e.kind}|${e.teamId ?? ""}|${e.text}`));
    next.log = [...(next.log ?? []), ...add].sort((a, b) => b.at.localeCompare(a.at)).slice(0, LOG_CAP);
  }
  return carried;
}

/**
 * The route body (after the organiser gate in api.ts). `resolve` maps a typed name to the identity's spelling
 * (undefined: no such coach).
 */
export async function assignTeamCoach(
  league: LeagueRecord, seasonId: string, teamId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps,
  resolve: (name: string) => string | undefined,
): Promise<LeagueApiResult> {
  const first = deps.store.season(league.id, seasonId);
  if (!first) return { status: 404, body: { error: "Season not found." } };
  if (!first.teams.some((t) => t.id === teamId)) return { status: 404, body: { error: "Team not found in this season." } };
  const asked = requestRevision(input, deps.ifMatch);
  const stale = (current: number): LeagueApiResult | undefined => {
    if (asked === "missing") return { status: 428, body: { error: "Send the season revision you loaded (revision or If-Match).", revision: current } };
    if (asked === "bad") return { status: 400, body: { error: "revision must be a whole number.", field: "revision" } };
    if (asked !== current) return { status: 409, body: { error: "This season changed since you opened it. Reload to see the latest.", revision: current } };
    return undefined;
  };
  const early = stale(first.revision ?? 0);
  if (early) return early;
  let coachId: string | null;
  if (input.coachId === null) coachId = null;
  else if (typeof input.coachId === "string" && input.coachId.trim()) {
    const found = resolve(input.coachId);
    if (!found) return { status: 400, body: { error: `No coach called "${input.coachId.trim().slice(0, 64)}".`, field: "coachId" } };
    coachId = found;
  } else return { status: 400, body: { error: "Pick a coach account (coachId), or send null to clear it.", field: "coachId" } };
  if (input.allSeasons !== undefined && typeof input.allSeasons !== "boolean") return { status: 400, body: { error: "allSeasons must be true or false.", field: "allSeasons" } };
  const allSeasons = input.allSeasons === true;

  const targetsOf = (): SeasonRecord[] => {
    const own = deps.store.season(league.id, seasonId);
    if (!own) return [];
    return allSeasons ? [own, ...deps.store.seasons(league.id).filter((s) => s.id !== seasonId && s.teams.some((t) => t.id === teamId))] : [own];
  };
  // Every fixture of the team that may carry a fork game, and its fork team per season: the locks fork play takes.
  const planned = targetsOf();
  const fixtureKeys = planned.flatMap((s) => s.fixtures.filter((f) => f.home.teamId === teamId || f.away.teamId === teamId).map((f) => fixtureLockKey(league.id, s.id, f.id)));
  const forkTeams = planned.map((s) => forkTeamIdFor(league.id, s.id, teamId));

  return withForkLocks(fixtureKeys, forkTeams, async () => {
    // Re-read under the locks: a launch / generate that held them has recorded what it did.
    const targets = targetsOf();
    const season = targets[0];
    if (!season) return { status: 404, body: { error: "Season not found." } };
    if (!season.teams.some((t) => t.id === teamId)) return { status: 404, body: { error: "Team not found in this season." } };
    const moved = stale(season.revision ?? 0);
    if (moved) return moved;
    for (const s of targets) {
      const locked = forkPlayLock(s, teamId);
      if (locked) return { status: 409, body: { error: locked } };
    }
    const at = (deps.now?.() ?? new Date()).toISOString();
    const changed: string[] = [];
    for (const s of targets) {
      if (applyTeamCoach(s, teamId, coachId, who.coach, at)) {
        deps.store.putSeason(s);
        changed.push(s.id);
      }
    }
    const saved = deps.store.season(league.id, seasonId)!;
    return { status: 200, body: { ok: true, team: saved.teams.find((t) => t.id === teamId), seasons: changed, revision: saved.revision ?? 0 } };
  });
}
