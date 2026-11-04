/**
 * Joining a ladder (spec-league-ladder-2026-11-02, lane 8b): the ladder adapter of the shared registration core, next to the
 * season's (registration.ts). It reuses the league adapter whole (rows in the ladder record's `registrations[]`, the commit
 * guard, acceptance creating the team in the SAME write) and changes three things:
 *
 *   approval   per request: a team built and validated in the Roster Builder for this ladder joins straight away when the
 *              ladder's "auto-approve validated teams" is on (default); every other entry (a pre-existing team, a move)
 *              waits for an organiser.
 *   placement  a move (row.move) brings the league team in WITH its progression (players, SPP, skills, injuries, treasury),
 *              under fresh player ids linked to the old ones; the team it came from is superseded (ladder.ts
 *              supersededTeams), so the team plays in one place at a time. The move is refused while the team has anything
 *              open where it is (unplayed fixtures, live challenges), re-checked inside the write.
 *   member     every accepted team becomes a ladder member in the same write (tournament-style ladders also keep the roster
 *              it joined with, for the reset after every game).
 *
 * The core keys entries by coach: one team per coach per ladder.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  createRegistrationService, RegistrationError, type ApprovalMode, type CompetitionSnapshot, type RegistrationEntry, type RegistrationNotifySink,
} from "../registration/index.js";
import { isLadder, openWork, settingsOf, supersededTeams, teamKey } from "./ladder.js";
import { playerIdFor } from "./playerIds.js";
import {
  LeagueRegistrationAdapter, parseCompetitionId, placeRegisteredTeam, rowToEntry, type LeagueRegistrationRow, type LeagueTeamSnapshot,
} from "./registration.js";
import type { LeagueStore } from "./store.js";
import { refreshTeamValue } from "./teamValue.js";
import { EMPTY_PLAYER_STATS, type LeagueParticipant, type LeagueRecord, type LeagueTeam, type SeasonRecord } from "./types.js";

const mint = (prefix: string, bytes = 6): string => `${prefix}-${randomBytes(bytes).toString("hex")}`;
const careerOf = (playerId: string): string => `c-${createHash("sha256").update(`career\0${playerId}`).digest("hex").slice(0, 12)}`;

/** A league team as a registration snapshot (the row's record of what joined; the move itself copies the whole team). */
export function snapshotFromTeam(team: LeagueTeam): LeagueTeamSnapshot {
  return {
    teamName: team.name, race: team.race, rerolls: team.rerolls ?? 0, apothecary: team.apothecary === true,
    assistantCoaches: team.assistantCoaches ?? 0, cheerleaders: team.cheerleaders ?? 0, dedicatedFans: team.fans ?? 1,
    cost: team.teamValue ?? 0,
    players: team.players.map((p) => ({ number: p.number, name: p.name, position: p.position, ma: p.ma, st: p.st, ag: p.ag, pa: p.pa, av: p.av, skills: [...p.skills], cost: p.value ?? 0 })),
  };
}

/**
 * A copy of `team` for `target` (a move): same lineage (teamUid), a fresh entry, fresh player ids that name the old ones
 * (previousIds; careerKey kept), the competition's counters cleared, progression kept. Not placed: the caller adds it.
 */
export function copyTeamForMove(team: LeagueTeam, target: SeasonRecord, from: { kind: "season" | "ladder"; id: string }, at: string): LeagueTeam {
  const taken = new Set((target.teams ?? []).map((t) => t.id));
  let id = team.id;
  while (taken.has(id)) id = mint("t", 5);
  const ctx = { leagueId: target.leagueId, slug: target.sourceSlug || target.id };
  const used = new Set<string>();
  const remap = new Map<string, string>();
  const players = team.players.map((p) => {
    let ord = 0;
    let playerId = playerIdFor(ctx, id, p.number, p.name, p.position, ord);
    while (used.has(playerId)) playerId = playerIdFor(ctx, id, p.number, p.name, p.position, ++ord);
    used.add(playerId);
    remap.set(p.playerId, playerId);
    return { ...structuredClone(p), playerId, careerKey: p.careerKey ?? careerOf(p.playerId), previousIds: [...(p.previousIds ?? []), p.playerId], stats: { ...EMPTY_PLAYER_STATS } };
  });
  const copy: LeagueTeam = {
    ...structuredClone(team), id, players, formerPlayers: [], entryId: mint("en"),
    movedFrom: { kind: from.kind, id: from.id, teamId: team.id, at },
  };
  delete copy.status;
  delete copy.statusChanged;
  delete copy.registrationId;
  if (copy.captainPlayerId) { const next = remap.get(copy.captainPlayerId); if (next) copy.captainPlayerId = next; else delete copy.captainPlayerId; }
  return copy;
}

const participantFor = (team: LeagueTeam, at: string): LeagueParticipant => ({
  coach: team.coach, ...(team.coachId ? { coachId: team.coachId } : {}), ...(team.coachAssigned && !team.coachAssigned.cleared ? { coachAssigned: true as const } : {}),
  country: "", race: team.race, team: team.name, registeredAt: at, active: true, teamId: team.id, addedHere: true,
});

/** Places a moved team into `target` (in place), re-checking that its current row is the one named and nothing is open there. */
export function placeMovedTeam(store: LeagueStore, league: LeagueRecord, target: SeasonRecord, move: NonNullable<LeagueRegistrationRow["move"]>, now: Date): LeagueTeam {
  if (move.id === target.id) throw new RegistrationError(409, "invalid-transition", "That team is already here.");
  const source = store.season(league.id, move.id);
  const team = source?.teams.find((t) => t.id === move.teamId);
  if (!source || !team) throw new RegistrationError(409, "invalid-transition", "That team is no longer in the league.");
  if (supersededTeams(store.competitions(league.id)).has(teamKey(source.id, team.id))) throw new RegistrationError(409, "invalid-transition", "That team has already moved.");
  const busy = openWork(source, team.id, now);
  if (busy) throw new RegistrationError(409, "invalid-transition", busy);
  const at = now.toISOString();
  const copy = copyTeamForMove(team, target, { kind: isLadder(source) ? "ladder" : "season", id: source.id }, at);
  refreshTeamValue(copy, target.ruleset);
  target.teams = [...(target.teams ?? []), copy];
  target.participants = [...(target.participants ?? []), participantFor(copy, at)];
  return copy;
}

/** A team's roster as tournament-style ladders reset it (the team without its history and counters). */
export const resetRosterOf = (team: LeagueTeam): unknown => {
  const { history: _h, statusChanged: _s, ...rest } = structuredClone(team);
  return rest;
};

export interface LadderRegistrationDeps {
  now?: () => Date;
  notify?: RegistrationNotifySink;
  /** auto = this request's entry joins straight away (a validated Roster Builder team with auto-approve on). */
  approval?: ApprovalMode;
  beforeWrite?: (season: SeasonRecord) => void;
}

/** The league adapter with the ladder's approval, entries (members only) and placement. */
export class LadderRegistrationAdapter extends LeagueRegistrationAdapter {
  constructor(private readonly ladderStore: LeagueStore, private readonly approval: ApprovalMode, deps: LadderRegistrationDeps = {}) {
    super(ladderStore, {
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.beforeWrite ? { beforeWrite: deps.beforeWrite } : {}),
      placeTeam: (league, season, row, seasons, now) => (row.move ? placeMovedTeam(ladderStore, league, season, row.move, now) : placeRegisteredTeam(league, season, row, seasons, now)),
      afterPlace: (season, row, team, now) => {
        if (!season.ladder) return;
        const last = row.registrationLog.at(-1);
        const via = row.move ? "move" as const : last && (last.action === "submit" || last.action === "reenter") && last.to === "accepted" && last.by.trim().toLowerCase() === row.coach.trim().toLowerCase() ? "validator" as const : "organiser" as const;
        season.ladder.members = [
          ...season.ladder.members.filter((m) => m.teamId !== team.id),
          { teamId: team.id, joinedAt: now.toISOString(), via, ...(settingsOf(season.ladder).style === "tournament" ? { reset: { roster: resetRosterOf(team) } } : {}) },
        ];
      },
      afterUnplace: (season, row) => {
        if (season.ladder && row.teamId) season.ladder.members = season.ladder.members.filter((m) => m.teamId !== row.teamId);
      },
    });
  }

  private ladderOf(id: string): { league: LeagueRecord; ladder: SeasonRecord } | undefined {
    const { leagueId, seasonId } = parseCompetitionId(id);
    const league = this.ladderStore.league(leagueId);
    const ladder = league ? this.ladderStore.season(leagueId, seasonId) : undefined;
    return league && ladder && isLadder(ladder) ? { league, ladder } : undefined;
  }

  override competition(id: string): CompetitionSnapshot | undefined {
    const found = this.ladderOf(id);
    const snap = found ? super.competition(id) : undefined;
    if (!found || !snap) return undefined;
    return { ...snap, name: `${found.league.name} ${found.ladder.name}`, window: { ...snap.window, approval: this.approval, cap: null, perRace: null, waitlist: false } };
  }

  /** Rows, plus one accepted entry per member team no accepted row stands for; a team that left holds no place. */
  override entries(id: string): RegistrationEntry[] {
    const found = this.ladderOf(id);
    if (!found) return [];
    const { ladder } = found;
    const rows = ladder.registrations ?? [];
    const byRow = new Set(rows.filter((r) => r.state === "accepted" && r.teamId).map((r) => r.teamId!));
    const members = new Set((ladder.ladder?.members ?? []).filter((m) => !m.leftAt && !m.movedTo).map((m) => m.teamId));
    const synthetic = (ladder.teams ?? []).filter((t) => members.has(t.id) && !byRow.has(t.id)).map((t): RegistrationEntry => ({
      id: `team:${t.id}`, competitionId: id, coach: t.coachId ?? t.coach ?? "", state: "accepted",
      submittedAt: ladder.importedAt, enteredAt: ladder.importedAt, race: t.race, log: [],
    }));
    return [...rows.map(rowToEntry), ...synthetic];
  }
}

/** The registration service for one ladder request (the process-wide registration lock is shared with the season's). */
export function ladderRegistrationService(store: LeagueStore, deps: LadderRegistrationDeps = {}) {
  const adapter = new LadderRegistrationAdapter(store, deps.approval ?? "organiser", deps);
  return createRegistrationService({ adapter, ...(deps.notify ? { notify: deps.notify } : {}), ...(deps.now ? { now: deps.now } : {}) });
}

/** The coach's own (latest) ladder entry, as only they see it: the reason for a decline, never who decided. */
export function myLadderEntry(ladder: SeasonRecord, coach: string) {
  const key = coach.trim().toLowerCase();
  const rows = (ladder.registrations ?? []).filter((r) => r.coach.trim().toLowerCase() === key).sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
  const mine = rows[0];
  if (!mine) return undefined;
  return {
    id: mine.id, state: mine.state, teamName: mine.teamName, race: mine.race, kind: mine.kind, enteredAt: mine.enteredAt,
    ...(mine.move ? { moving: true } : {}),
    ...(mine.teamId && mine.state === "accepted" ? { teamId: mine.teamId } : {}),
    ...(mine.decided?.reason && (mine.state === "declined" || mine.state === "dropped") ? { reason: mine.decided.reason } : {}),
  };
}
