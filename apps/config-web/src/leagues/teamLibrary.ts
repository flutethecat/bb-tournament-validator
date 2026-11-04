/**
 * Team library, swap and takeover (spec-team-management-2026-11-02 "Team libraries and swaps", "Available for takeover",
 * round answers Q5-Q8): the pure parts. No I/O: teamLibraryApi.ts holds the routes, takeover.ts the registration adapter.
 *
 *  - The coach's LIBRARY = every team the coach owns: Roster Builder saves and fork library teams (server.ts coachTeams),
 *    plus their league teams in other seasons / leagues (one row per team lineage, the newest season). Each is judged
 *    against the target season: a team that doesn't fit is greyed with the reason (Q5).
 *  - An ENTRY is the season slot a team fills (LeagueTeam.id / entryId): it holds the standings and fixtures. A swap keeps
 *    the slot (id, entryId, results, standings rows, fixtures) and changes the team behind it (Q6); the entry history lists
 *    the teams with the entry's game numbers ("Team A (games 1-5), Team B (games 6-)").
 *  - A TAKEOVER keeps the team (teamUid, skills, standings) and changes its owner. Records follow the coach of each game
 *    (Q7): played fixture sides keep the coach who played them (FixtureSide.playedBy, identity.ts), so the new coach
 *    inherits no results and their rating does not move; unplayed sides are re-seated, so future games count for them.
 *
 * Every write here is IN PLACE on one season record and is followed by one putSeason by the caller (atomic).
 */
import { randomBytes } from "node:crypto";
import { canonicalRace, rosterAllowed } from "./leagueBuilder.js";
import { addLog } from "./events.js";
import { forkPlayLock } from "./forkTeam.js";
import { fixtureOutcome, teamSeat } from "./identity.js";
import { isDraftLeague } from "./lifecycle.js";
import { participantOf } from "./participants.js";
import { datasetRoster } from "./redraft.js";
import { seasonRegistrationOf } from "./seasonRegistration.js";
import type { LeagueStore } from "./store.js";
import { addHistory, ensureTeamIdentity, rosterLimitErrors, teamGamesPlayed } from "./teamOps.js";
import { refreshTeamValue } from "./teamValue.js";
import { EMPTY_PLAYER_STATS, type EntrySpan, type FormerPlayer, type LeagueFixture, type LeaguePlayer, type LeagueRecord, type LeagueTeam, type SeasonRecord } from "./types.js";

const ckey = (c: string | undefined): string => (c ?? "").normalize("NFC").trim().toLowerCase();
const mint = (prefix: string): string => `${prefix}-${randomBytes(6).toString("hex")}`;

// ---- the library ------------------------------------------------------------------------------------------------------

/** A save or fork library team of the coach (server.ts coachTeams). */
export interface CoachTeamRow {
  ref: string; kind: "save" | "library"; name: string; race: string; tv: number | null;
  /** The coach shared it (a save with a share link): organisers may see and swap it in directly. Anything else is private:
   *  organisers see only "Private save" and a swap needs the coach's approval. */
  shared?: boolean;
}

/** One library row as the swap dialog / the application dialog shows it. */
export interface LibraryItem {
  /** "save:<id>" | "library:<teamId>" | "league:<leagueId>/<seasonId>/<teamId>". */
  ref: string;
  kind: "save" | "library" | "league";
  name: string;
  race: string;
  tv: number | null;
  /** League teams: where the team last played ("Rivertown Season 2"). */
  source?: string;
  ok: boolean;
  /** Why the team doesn't fit (greyed), when !ok. */
  reason?: string;
  /** A team the coach never shared (organiser view): no details; a swap asks the coach. */
  private?: true;
}

/** The coach's teams in league seasons (owned: a seat not cleared by an organiser), one per lineage, newest season. Only
 *  published leagues (a draft league does not exist for another league's organisers) and the target league. */
export function leagueTeamsOf(store: Pick<LeagueStore, "list" | "seasons">, coach: string, target: { leagueId: string }): Array<{ league: LeagueRecord; season: SeasonRecord; team: LeagueTeam }> {
  const key = ckey(coach);
  if (!key) return [];
  const best = new Map<string, { league: LeagueRecord; season: SeasonRecord; team: LeagueTeam }>();
  for (const league of store.list()) {
    if (league.id !== target.leagueId && isDraftLeague(league)) continue;
    for (const season of store.seasons(league.id)) {
      for (const team of season.teams ?? []) {
        if (team.coachAssigned?.cleared || ckey(team.coachId) !== key) continue;
        const lineage = team.teamUid ?? `${league.id}/${season.id}/${team.id}`;
        const have = best.get(lineage);
        const newer = !have || (have.league.id === league.id ? season.number > have.season.number : (season.importedAt ?? "") > (have.season.importedAt ?? ""));
        if (newer) best.set(lineage, { league, season, team });
      }
    }
  }
  return [...best.values()];
}

/** Why a league team can't enter `season` ("" = it can). */
export function leagueTeamProblem(source: { league: LeagueRecord; season: SeasonRecord; team: LeagueTeam }, target: { league: LeagueRecord; season: SeasonRecord; teamId?: string }): string {
  const { league, season, team } = source;
  if (league.id === target.league.id && season.id === target.season.id) return target.teamId === team.id ? "This is the team in the entry now." : "Already in this season.";
  if (season.ruleset !== target.season.ruleset) return `Built for ${season.ruleset}; this season plays ${target.season.ruleset}.`;
  if (season.status === "active" && team.status !== "inactive") return `Still playing in ${league.name} ${season.name}.`;
  const allowed = rosterAllowed(canonicalRace(team.race), seasonRegistrationOf(target.league, target.season).allowedRosters);
  if (!allowed.allowed) return allowed.reason;
  const errors = rosterLimitErrors(team, datasetRoster(canonicalRace(team.race))).errors;
  return errors.length ? errors.join(" ") : "";
}

/** "league:<leagueId>/<seasonId>/<teamId>". */
export const leagueTeamRef = (leagueId: string, seasonId: string, teamId: string): string => `league:${leagueId}/${seasonId}/${teamId}`;
export function parseLeagueTeamRef(ref: string): { leagueId: string; seasonId: string; teamId: string } | undefined {
  const m = /^league:([^/]{1,80})\/([^/]{1,80})\/([^/]{1,80})$/.exec(ref);
  return m ? { leagueId: m[1]!, seasonId: m[2]!, teamId: m[3]! } : undefined;
}

// ---- entry history ----------------------------------------------------------------------------------------------------

/** The span a team held from the start of the season (when the entry has no history yet). */
function startSpan(team: LeagueTeam, at: string): EntrySpan {
  return {
    name: team.name, race: team.race, coach: team.coach, ...(team.coachId && !team.coachAssigned?.cleared ? { coachId: team.coachId } : {}),
    ...(team.teamUid ? { teamUid: team.teamUid } : {}), fromGame: 1, via: "start", at,
  };
}

/** "Team A (games 1-5), Team B (games 6-)". A holder replaced before playing shows "(no games)". */
export function entryHistoryLine(spans: readonly Pick<EntrySpan, "name" | "fromGame" | "toGame" | "coach">[] | undefined): string {
  if (!spans?.length) return "";
  return spans.map((s) => {
    const games = s.toGame === undefined ? `games ${s.fromGame}-` : s.toGame < s.fromGame ? "no games" : s.toGame === s.fromGame ? `game ${s.fromGame}` : `games ${s.fromGame}-${s.toGame}`;
    return `${s.name} (${games})`;
  }).join(", ");
}

/** The roster as kept in the history (no history, no entry history: nothing nests). */
function outgoingCopy(team: LeagueTeam): LeagueTeam {
  const { history: _h, entryHistory: _e, takeover: _t, ...rest } = structuredClone(team);
  return rest;
}

// ---- guards -----------------------------------------------------------------------------------------------------------

/**
 * A Super FUMBBL game is held for one of the team's fixtures and has no applied result: scheduled or running, and ANY
 * status that still names a game id (a cancelled game that was started or could not be withdrawn keeps syncing its
 * result, and an unclear launch may have made one). Its result would otherwise be credited to the new team or coach.
 */
function holdsForkGame(f: LeagueFixture, teamId: string): boolean {
  const fork = f.fork;
  if (!fork || fork.result) return false;
  const mine = fork.teams.home?.teamId === teamId || fork.teams.away?.teamId === teamId || f.home.teamId === teamId || f.away.teamId === teamId;
  if (!mine) return false;
  return fork.status === "scheduled" || fork.status === "in_progress" || Boolean(fork.gameId) || fork.uncertain === true;
}

/** The fixtures of a team (any side). */
export const teamFixtures = (season: Pick<SeasonRecord, "fixtures">, teamId: string): LeagueFixture[] =>
  season.fixtures.filter((f) => f.home.teamId === teamId || f.away.teamId === teamId);

/**
 * Why the team behind this entry can't change right now ("" = it can): a finished season, a Super FUMBBL game held for
 * any of its fixtures (see holdsForkGame), or a tabletop recorder match on one of its fixtures that is not published yet
 * (`openRecorder`: the fixture ids with such a match; its result would be credited to the new coach).
 */
export function entryChangeBlock(season: SeasonRecord, teamId: string, openRecorder: ReadonlySet<string> = new Set()): string {
  if (season.status === "completed") return "This season is finished: its teams are final.";
  const lock = forkPlayLock(season, teamId);
  if (lock) return lock;
  const game = season.fixtures.find((f) => holdsForkGame(f, teamId));
  if (game) return `A Super FUMBBL game exists for ${game.home.team} vs ${game.away.team}. Finish it, or cancel and reset it on the fork, first.`;
  const recorded = teamFixtures(season, teamId).find((f) => openRecorder.has(f.id));
  if (recorded) return `A tabletop match for ${recorded.home.team} vs ${recorded.away.team} is still being recorded. Publish or delete it first.`;
  return "";
}

// ---- seating ----------------------------------------------------------------------------------------------------------

/**
 * Points the entry's unplayed fixture sides and its participant row at the team as it is now (in place): name, race,
 * coach and the coach's seat. Played sides keep what they recorded (records follow the coach of each game). A missing
 * participant row is added (the new coach's membership row).
 */
function reseatEntry(season: SeasonRecord, before: LeagueTeam, team: LeagueTeam, at: string): void {
  for (const f of season.fixtures) {
    if (fixtureOutcome(f) !== undefined) continue;
    for (const side of [f.home, f.away]) {
      if (side.teamId !== team.id) continue;
      side.team = team.name;
      side.race = team.race;
      side.coach = team.coach;
      delete side.coachId;
      delete side.coachAssigned;
      delete side.nafUser;
      Object.assign(side, teamSeat(team));
    }
  }
  const row = participantOf(season, before);
  if (row) {
    row.coach = team.coach;
    row.team = team.name;
    row.race = team.race;
    row.teamId = team.id;
    delete row.nafUser;
    if (team.coachId) { row.coachId = team.coachId; row.coachAssigned = true; } else { delete row.coachId; delete row.coachAssigned; }
  } else {
    season.participants = [...(season.participants ?? []), {
      coach: team.coach, ...(team.coachId ? { coachId: team.coachId, coachAssigned: true as const } : {}), country: "", race: team.race, team: team.name,
      registeredAt: at, active: true, teamId: team.id, addedHere: true,
    }];
  }
}

/** The outgoing team's players with this season's records, kept under the entry's "Left the roster" so the season's
 *  leaders and honours keep their numbers. */
function keptRecords(team: LeagueTeam): FormerPlayer[] {
  const used = (s: LeaguePlayer["stats"]): boolean => s.td + s.cas + s.mvp + s.spp + s.completions + s.int + (s.fouls ?? 0) > 0;
  return [
    ...team.players.filter((p) => used(p.stats)).map((p): FormerPlayer => ({
      playerId: p.playerId, ...(p.careerKey ? { careerKey: p.careerKey } : {}), ...(p.previousIds ? { previousIds: [...p.previousIds] } : {}),
      name: p.name, position: p.position, level: p.level, stats: { ...p.stats }, ...(p.skills.length ? { skills: [...p.skills] } : {}),
    })),
    ...(team.formerPlayers ?? []).map((p) => structuredClone(p)),
  ];
}

// ---- swap ---------------------------------------------------------------------------------------------------------------

export type SwapVia = "swap" | "apply";

export interface EntryChange { before: LeagueTeam; after: LeagueTeam; games: number }

/**
 * Puts `incoming` (a team built for this entry: teamFromSnapshot, or teamFromLeagueTeam) behind the entry `teamId`, in
 * place. The entry keeps its id, entryId, results, standings, fixtures, status and history; the team, its coach and its
 * roster change. The replaced roster is kept in the entry history (private) and its players with this season's records
 * under "Left the roster". Unplayed fixtures and the participant row follow the new team.
 */
export function applyEntrySwap(season: SeasonRecord, teamId: string, incoming: LeagueTeam, actor: string, at: string, via: SwapVia): EntryChange {
  const i = season.teams.findIndex((t) => t.id === teamId);
  if (i < 0) throw new Error("No such team.");
  const before = season.teams[i]!;
  ensureTeamIdentity(before);
  const games = teamGamesPlayed(season, teamId);
  const spans = before.entryHistory?.length ? structuredClone(before.entryHistory) : [startSpan(before, before.coachAssigned?.at ?? season.importedAt ?? at)];
  const last = spans[spans.length - 1]!;
  last.toGame = games;
  last.outgoing = outgoingCopy(before);
  spans.push({
    name: incoming.name, race: incoming.race, coach: incoming.coach, ...(incoming.coachId ? { coachId: incoming.coachId } : {}),
    ...(incoming.teamUid ? { teamUid: incoming.teamUid } : {}), fromGame: games + 1, via, at, by: actor,
  });
  const after: LeagueTeam = {
    ...structuredClone(incoming),
    id: before.id,
    entryId: before.entryId,
    formerPlayers: [...keptRecords(before), ...(incoming.formerPlayers ?? [])],
    coachAssigned: { by: actor, at },
    entryHistory: spans,
    ...(before.history ? { history: before.history } : {}),
    ...(before.status ? { status: before.status } : {}),
    ...(before.statusChanged ? { statusChanged: before.statusChanged } : {}),
    ...(before.registrationId ? { registrationId: before.registrationId } : {}),
  };
  delete after.takeover;
  delete after.swapRequest;
  delete after.captainVacant;
  if (!after.teamUid) after.teamUid = mint("tm");
  refreshTeamValue(after, season.ruleset);
  season.teams[i] = after;
  reseatEntry(season, before, after, at);
  // The entry's accepted registration row counts toward max teams and max per race: it follows the team now behind it.
  for (const r of season.registrations ?? []) {
    if (r.state !== "accepted" || r.teamId !== teamId) continue;
    r.race = canonicalRace(after.race);
    r.teamName = after.name;
    r.teamId = after.id;
  }
  const changes = [{ what: "Team", from: `${before.name} (${before.race})`, to: `${after.name} (${after.race})` }];
  if (ckey(before.coachId ?? before.coach) !== ckey(after.coachId ?? after.coach)) changes.push({ what: "Coach", from: before.coach, to: after.coach });
  addHistory(after, { at, by: actor, kind: via === "apply" ? "takeover" : "swap", changes });
  addLog(season, {
    at, by: actor, kind: "team-coach", teamId,
    text: via === "apply"
      ? `${after.coach}'s ${after.name} took over the entry of ${before.name} (approved by ${actor}).`
      : `${actor} swapped ${before.name} for ${after.name} in its entry.`,
  });
  return { before, after, games };
}

/**
 * The fork library / save sheet route is teamFromSnapshot (registration.ts). A league team from another season or league
 * enters as the same team (its teamUid, roster, skills, SPP and treasury), with fresh player ids for this season (the old
 * ids in previousIds) and this season's counters at zero.
 */
export function teamFromLeagueTeam(source: LeagueTeam, season: SeasonRecord, opts: { id: string; usedIds: Set<string> }): LeagueTeam {
  const copy = structuredClone(source);
  const players = copy.players.map((p) => {
    let id = mint("p");
    while (opts.usedIds.has(id)) id = mint("p");
    opts.usedIds.add(id);
    const { pendingAdvance: _pa, advanceRolls: _ar, mngGames: _mg, ...rest } = p;
    return { ...rest, playerId: id, previousIds: [...(p.previousIds ?? []), p.playerId], stats: { ...EMPTY_PLAYER_STATS } };
  });
  const { history: _h, entryHistory: _e, takeover: _t, registrationId: _r, status: _s, statusChanged: _sc, redraftedFrom: _rf, ...rest } = copy;
  const team: LeagueTeam = { ...rest, id: opts.id, players, formerPlayers: [] };
  refreshTeamValue(team, season.ruleset);
  return team;
}

// ---- takeover -----------------------------------------------------------------------------------------------------------

/**
 * Ownership of the entry's team moves to `coach` (in place): the same team (teamUid, roster, skills, standings), a new
 * coach. Played sides keep the coach who played them; unplayed sides and the participant row move to the new coach.
 */
export function applyTakeover(season: SeasonRecord, teamId: string, coach: string, actor: string, at: string): EntryChange {
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) throw new Error("No such team.");
  ensureTeamIdentity(team);
  const before = structuredClone(team);
  const games = teamGamesPlayed(season, teamId);
  const spans = team.entryHistory?.length ? structuredClone(team.entryHistory) : [startSpan(team, team.coachAssigned?.at ?? season.importedAt ?? at)];
  spans[spans.length - 1]!.toGame = games;
  spans.push({ name: team.name, race: team.race, coach, coachId: coach, ...(team.teamUid ? { teamUid: team.teamUid } : {}), fromGame: games + 1, via: "takeover", at, by: actor });
  team.entryHistory = spans;
  team.coach = coach;
  team.coachId = coach;
  team.coachAssigned = { by: actor, at };
  delete team.nafUser;
  delete team.takeover;
  delete team.swapRequest;
  reseatEntry(season, before, team, at);
  addHistory(team, { at, by: actor, kind: "takeover", changes: [{ what: "Coach", from: before.coach, to: coach }] });
  addLog(season, { at, by: actor, kind: "team-coach", teamId, text: `${coach} took over ${team.name} from ${before.coach} (approved by ${actor}).` });
  return { before, after: team, games };
}

// ---- listing --------------------------------------------------------------------------------------------------------------

export const newListingId = (): string => mint("tk");

/** Lists (or with null unlists) the team for takeover, in place. Returns the listing id now in force ("" = unlisted). */
export function setTakeoverListing(team: LeagueTeam, on: { by: string; at: string; note?: string } | null): string {
  if (!on) { delete team.takeover; return ""; }
  if (team.takeover) {
    if (on.note !== undefined) { if (on.note) team.takeover.note = on.note; else delete team.takeover.note; }
    return team.takeover.id;
  }
  team.takeover = { id: newListingId(), since: on.at, by: on.by, ...(on.note ? { note: on.note } : {}) };
  return team.takeover.id;
}

/** The public view of an entry history (no outgoing rosters, no actor). */
export function publicEntryHistory(spans: EntrySpan[] | undefined): EntrySpan[] | undefined {
  return spans?.map(({ outgoing: _o, by: _b, ...s }) => s);
}

// ---- backfill: the coach of each played game -----------------------------------------------------------------------------

export interface PlayedCoachBackfill { seasons: number; sides: number; nameOnly: number }

/**
 * Freezes the coach of every played side that has no stamp yet, in every season of every league (identity.ts
 * stampPlayedCoaches). The best record of who played is the side itself: its coach / account / NAF name were written when
 * the fixture was made and re-seated only while it was unplayed (Assign coach account skips played fixtures), so they are
 * the coach at the time. Nothing else is rewritten. `nameOnly` counts stamped sides with no account (an imported display
 * name: the statistics alias table links it as before). Dry run unless `apply` (one putSeason per changed season).
 */
export function backfillPlayedCoaches(store: Pick<LeagueStore, "list" | "seasons" | "putSeason">, apply: boolean): PlayedCoachBackfill {
  const out: PlayedCoachBackfill = { seasons: 0, sides: 0, nameOnly: 0 };
  for (const league of store.list()) {
    for (const season of store.seasons(league.id)) {
      const copy = structuredClone(season);
      const missing = copy.fixtures.flatMap((f) => (fixtureOutcome(f) !== undefined ? [f.home, f.away] : [])).filter((s) => s && !s.playedBy && (s.coach || s.coachId));
      if (!missing.length) continue;
      out.seasons += 1;
      out.sides += missing.length;
      out.nameOnly += missing.filter((s) => !s.coachId).length;
      if (apply) store.putSeason(copy); // putSeason stamps them (identity.ts stampPlayedCoaches)
    }
  }
  return out;
}
