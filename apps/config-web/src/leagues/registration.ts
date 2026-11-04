/**
 * League registration (registration spec 2026-11-02 §5 (c), lane L6): the league adapter of the shared registration core
 * (src/registration), the team a registration becomes on acceptance, and the payment reference codes.
 *
 * Storage: one row per coach entry in the season file's `registrations[]` (LeagueRegistrationRow), in any state. The
 * season file is the ONE write for every transition, so acceptance and team creation are atomic: accepting an entry
 * (accept, promote, or an auto-mode submit) appends the LeagueTeam (fresh `t-<hex>` id, teamUid, a fresh entryId, the coach
 * assigned) and its participant row in the same putSeason that marks the row accepted. A crash before the write leaves
 * the entry pending and no team; after it, both. Removing an accepted entry takes its team out of the season in the same
 * write (refused while a fixture names the team: set it inactive from its team page instead).
 *
 * The competition the core sees is one season: id `<leagueId>/<seasonId>`, the window from seasonRegistration.ts. Its
 * entries are the rows plus one synthetic accepted entry per season team that no accepted row stands for (imported,
 * redrafted or organiser-assigned teams), so max teams and max per race count every team in the season. Synthetic
 * entries (`team:<teamId>`) are never acted on: the routes take only row ids, and commit refuses them.
 *
 * Every decision is re-checked against the stored season inside the write (registrationCommitGuard): the core decided
 * on a read taken inside its lock, but other writers (settings, Start season, a lowered cap) don't take that lock.
 *
 * Privacy: a row is never in a public read (api.ts seasonForViewer drops `registrations`). Pending, waitlisted and
 * declined entries are not teams, so they appear in no standings, Participants list or team count.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Roster } from "@bb/validator";
import {
  createRegistrationService, normalizeCap, organiserMayAdd, RegistrationError,
  type CompetitionSnapshot, type EntryState, type RegistrationAdapter, type RegistrationChange, type RegistrationDecision,
  type RegistrationEntry, type RegistrationNotifySink, type RegistrationTransition,
} from "../registration/index.js";
import { newReferenceCode, REF_CODE } from "../tournaments/registration.js";
import { canonicalRace } from "./leagueBuilder.js";
import { seasonStage } from "./lifecycle.js";
import { playerIdFor } from "./playerIds.js";
import { seasonRegistrationOf, seasonSnapshot, seasonWindowStatus } from "./seasonRegistration.js";
import { teamBuildingTable } from "./settings.js";
import { adoptLineage, parseLeagueTeamRef, teamFromLeagueTeam, transferSource } from "./teamLibrary.js";
import type { LeagueStore } from "./store.js";
import { refreshTeamValue } from "./teamValue.js";
import { EMPTY_PLAYER_STATS, type LeagueParticipant, type LeaguePlayer, type LeagueRecord, type LeagueTeam, type SeasonRecord } from "./types.js";

/** One player of the roster a coach registered (from the Roster Builder sheet, composed and checked at registration). */
export interface SnapshotPlayer {
  number: number | null;
  name: string;
  position: string;
  ma: number | null;
  st: number | null;
  /** Targets as numbers (3 = 3+); null = "-". */
  ag: number | null;
  pa: number | null;
  av: number | null;
  skills: string[];
  /** Gold. */
  cost: number;
}

/** The team a registration becomes: what the coach built, frozen at registration (re-entry replaces it). No coach name. */
export interface LeagueTeamSnapshot {
  teamName: string;
  race: string;
  rerolls: number;
  apothecary: boolean;
  assistantCoaches: number;
  cheerleaders: number;
  dedicatedFans: number;
  /** The sheet's total cost in gold (players + sideline). */
  cost: number;
  players: SnapshotPlayer[];
}

/** One league registration row (SeasonRecord.registrations). Field names the privacy collectors read: coach, decided,
 *  registrationLog (src/registration/privacy.ts). */
export interface LeagueRegistrationRow {
  id: string;
  leagueId: string;
  seasonId: string;
  coach: string;
  state: EntryState;
  submittedAt: string;
  enteredAt: string;
  waitlistAt?: string;
  waitlistSeq?: number;
  decided?: RegistrationDecision;
  registrationLog: RegistrationTransition[];
  /** Dataset spelling (the per-race limit). */
  race: string;
  teamName: string;
  /** "save:<id>" (a Roster Builder save) or "library:<teamId>" (a library team, through its newest sheet). */
  teamRef: string;
  /** new = built in the Roster Builder's league mode for this season; existing = any other save or library team (only
   *  when the organisers allow existing teams). */
  kind: "new" | "existing";
  libraryTeamId?: string;
  teamSnapshot: LeagueTeamSnapshot;
  /** The check against the season's rules at registration (always ok: an invalid team is refused). */
  validation: { ok: boolean; problems: string[]; checkedAt: string };
  region?: string;
  /** The club the coach represents in this season / ladder (clubs lane, src/clubs/pick.ts): fixed once accepted. */
  clubId?: string;
  /** The LeagueTeam made on acceptance (kept after a removal, for the record). */
  teamId?: string;
  /** Accepted while the season was in progress: no fixtures were made for the team. */
  midSeason?: true;
  /** Payment reference (SF-XXXX), random; the coach and the organisers only. */
  refCode?: string;
  /** The coach's "I've paid" (organisers still tick Paid in Participants). */
  coachSaysPaid?: { at: string };
  /** The organisers were last told about "I've paid" (once per 24 hours). */
  paidClaimNotifiedAt?: string;
  /** Ladders (lane 8b, ladderRegistration.ts): the league team this entry moves in with its progression (a season's or another
   *  ladder's), instead of the snapshot. */
  move?: { kind: "season" | "ladder"; id: string; teamId: string };
}

/** What the register route hands the core with a (re)submission (RegistrationEntry.data). */
export interface LeagueEntryData {
  teamRef: string;
  kind: "new" | "existing";
  libraryTeamId?: string;
  teamName: string;
  race: string;
  teamSnapshot: LeagueTeamSnapshot;
  validation: LeagueRegistrationRow["validation"];
  region?: string;
  /** The coach's club pick (clubs lane). */
  clubId?: string;
  /** Ladders: the league team to move in (LeagueRegistrationRow.move). */
  move?: LeagueRegistrationRow["move"];
}

const LIVE: ReadonlySet<EntryState> = new Set(["pending", "waitlisted", "accepted"]);
const ckey = (c: string | undefined) => (c ?? "").trim().toLowerCase();
export const PAID_CLAIM_NOTICE_MS = 24 * 60 * 60 * 1000;

export const competitionIdOf = (leagueId: string, seasonId: string): string => `${leagueId}/${seasonId}`;
export function parseCompetitionId(id: string): { leagueId: string; seasonId: string } {
  const [leagueId = "", seasonId = "", ...rest] = id.split("/");
  if (rest.length || !leagueId || !seasonId) throw new RegistrationError(404, "not-found", "Not found.");
  return { leagueId, seasonId };
}

/** A stored row as the registration core sees it. */
export function rowToEntry(row: LeagueRegistrationRow): RegistrationEntry {
  return {
    id: row.id,
    competitionId: competitionIdOf(row.leagueId, row.seasonId),
    coach: row.coach,
    state: row.state,
    submittedAt: row.submittedAt,
    enteredAt: row.enteredAt,
    ...(row.waitlistAt ? { waitlistAt: row.waitlistAt } : {}),
    ...(row.waitlistSeq !== undefined ? { waitlistSeq: row.waitlistSeq } : {}),
    ...(row.decided ? { decided: structuredClone(row.decided) } : {}),
    race: canonicalRace(row.race),
    log: structuredClone(row.registrationLog ?? []),
  };
}

/** The season's entries: every row, plus one accepted entry per team no accepted row stands for (they hold a place). */
export function seasonEntries(league: Pick<LeagueRecord, "id">, season: Pick<SeasonRecord, "id" | "teams" | "registrations" | "importedAt">): RegistrationEntry[] {
  const rows = season.registrations ?? [];
  const byRow = new Set(rows.filter((r) => r.state === "accepted" && r.teamId).map((r) => r.teamId!));
  const synthetic = (season.teams ?? []).filter((t) => !byRow.has(t.id)).map((t): RegistrationEntry => ({
    id: `team:${t.id}`, competitionId: competitionIdOf(league.id, season.id), coach: t.coachId ?? t.coach ?? "", state: "accepted",
    submittedAt: season.importedAt, enteredAt: season.importedAt, race: canonicalRace(String(t.race ?? "")), log: [],
  }));
  return [...rows.map(rowToEntry), ...synthetic];
}

/** The SPA paths a registration notice opens: the coach's league page (Join block), or the organisers' Registrations. */
export function leagueRegistrationLink(leagueId: string, seasonId: string, audience: "coach" | "organiser"): string {
  const q = `season=${encodeURIComponent(seasonId)}`;
  return audience === "organiser"
    ? `/app/leagues/${encodeURIComponent(leagueId)}/settings?${q}&tab=entries`
    : `/app/leagues/${encodeURIComponent(leagueId)}?${q}`;
}

// ---- the team a registration becomes ----------------------------------------------------------------------------------

const target = (t: string | undefined): number | null => {
  const m = /^(\d+)\+$/.exec(String(t ?? "").trim());
  return m ? Number(m[1]) : null;
};

/** The composed Roster Builder sheet (validator model) as a snapshot. The coach name is not kept. */
export function snapshotFromRoster(roster: Roster, teamName: string): LeagueTeamSnapshot {
  const players: SnapshotPlayer[] = roster.players.map((p) => ({
    number: Number.isFinite(p.number) ? p.number : null,
    name: "",
    position: p.positionName,
    ma: Number.isFinite(p.MA) ? p.MA : null,
    st: Number.isFinite(p.ST) ? p.ST : null,
    ag: target(p.AG), pa: target(p.PA), av: target(p.AV),
    skills: [...p.skills],
    cost: Math.max(0, Math.round(p.cost || 0)),
  }));
  const playersCost = players.reduce((n, p) => n + p.cost, 0);
  return {
    teamName: teamName.trim() || roster.teamName,
    race: canonicalRace(roster.rosterName),
    rerolls: Math.max(0, roster.sideline.reRolls | 0),
    apothecary: roster.sideline.apothecary === true,
    assistantCoaches: Math.max(0, roster.sideline.assistantCoaches | 0),
    cheerleaders: Math.max(0, roster.sideline.cheerleaders | 0),
    dedicatedFans: Math.max(1, roster.sideline.dedicatedFans | 0),
    cost: Math.max(playersCost, Math.round(roster.summary?.total ?? playersCost)),
    players,
  };
}

const mint = (prefix: string, bytes = 6): string => `${prefix}-${randomBytes(bytes).toString("hex")}`;
const careerKey = (playerId: string): string => `c-${createHash("sha256").update(`career\0${playerId}`).digest("hex").slice(0, 12)}`;

/** The team's lineage id: a library team already in this league (any season) keeps its teamUid; anything else is new. */
function teamUidFor(seasons: readonly SeasonRecord[], libraryTeamId: string | undefined): string {
  if (libraryTeamId) {
    for (const s of seasons) for (const t of s.teams ?? []) if (t.libraryTeamId === libraryTeamId && t.teamUid) return t.teamUid;
  }
  return mint("tm");
}

/** A fresh season-unique team id (`t-<hex>`). */
export function freshTeamId(season: Pick<SeasonRecord, "teams">): string {
  const taken = new Set((season.teams ?? []).map((t) => t.id));
  let id = mint("t", 5);
  while (taken.has(id)) id = mint("t", 5);
  return id;
}

/**
 * The LeagueTeam a frozen Roster Builder sheet becomes in `season` (not added): fresh player ids under `id`, treasury =
 * the roster's starting treasury in the season's Team building table less what the sheet cost, the league's own valuation
 * (owner 10-30). Shared by registration acceptance and the team library lane's swap / approved takeover application.
 */
export function teamFromSnapshot(
  league: Pick<LeagueRecord, "id" | "slug">, season: SeasonRecord, snap: LeagueTeamSnapshot,
  opts: { id: string; coach: string; teamName?: string; race?: string; by: string; at: string; teamUid: string; entryId: string; libraryTeamId?: string; registrationId?: string },
): LeagueTeam {
  const id = opts.id;
  const race = canonicalRace(snap.race || opts.race || "");
  const rule = teamBuildingTable(season).rosters.find((r) => r.roster === race);
  const budget = (rule?.treasury ?? 1000) * 1000;
  const used = new Set<string>();
  const ctx = { leagueId: league.id, slug: season.sourceSlug || season.id };
  const players: LeaguePlayer[] = snap.players.map((p, i) => {
    const number = p.number ?? i + 1;
    let ord = 0;
    let playerId = playerIdFor(ctx, id, number, p.name, p.position, ord);
    while (used.has(playerId)) playerId = playerIdFor(ctx, id, number, p.name, p.position, ++ord);
    used.add(playerId);
    return {
      playerId, careerKey: careerKey(playerId), number, name: p.name, position: p.position,
      // No stored value yet: the league prices the player itself below (position cost + starting skills + increases),
      // exactly as import does (teamValue.ts storeFallbackValues), never the sheet's printed cost.
      ma: p.ma, st: p.st, ag: p.ag, pa: p.pa, av: p.av, skills: [...p.skills], value: null,
      level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0,
    };
  });
  const team: LeagueTeam = {
    id, name: snap.teamName || opts.teamName || "Team", race, coach: opts.coach, coachId: opts.coach,
    coachAssigned: { by: opts.by, at: opts.at },
    teamValue: null, treasury: Math.max(0, budget - snap.cost), rerolls: snap.rerolls, fans: snap.dedicatedFans,
    assistantCoaches: snap.assistantCoaches, cheerleaders: snap.cheerleaders, apothecary: snap.apothecary,
    tier: rule ? String(rule.tier) : "", raceLeague: "", players, formerPlayers: [],
    teamUid: opts.teamUid, entryId: opts.entryId,
    ...(opts.registrationId ? { registrationId: opts.registrationId } : {}),
    ...(opts.libraryTeamId ? { libraryTeamId: opts.libraryTeamId } : {}),
  };
  // Stored values as the league's own valuation (the banker's fallback: position cost + Primary 20k / Secondary 40k /
  // Elite +10k + characteristic increases), then the team value. A season the dataset can't price (not BB2025, an
  // unknown race) keeps the sheet's cost per player.
  refreshTeamValue(team, season.ruleset, { fillStoredValues: true });
  for (const [i, p] of team.players.entries()) {
    if (typeof p.value !== "number") p.value = snap.players[i]?.cost ?? null;
    if (typeof p.value === "number") p.purchasePrice = p.value;
  }
  refreshTeamValue(team, season.ruleset);
  return team;
}

/** The library team's lineage id when it already played in this league (any season), else a new one. */
export function lineageFor(seasons: readonly SeasonRecord[], libraryTeamId: string | undefined): string {
  return teamUidFor(seasons, libraryTeamId);
}

/**
 * Builds the LeagueTeam for an accepted row and adds it, with its participant row, to `season` (in place). Treasury =
 * the roster's starting treasury in the season's Team building table, less what the sheet cost; the team value is the
 * league's own recompute (owner 10-30). No fixtures are made: the organisers add them (also mid-season).
 */
export function placeRegisteredTeam(league: Pick<LeagueRecord, "id" | "slug">, season: SeasonRecord, row: LeagueRegistrationRow, seasons: readonly SeasonRecord[], now: Date): LeagueTeam {
  const at = now.toISOString();
  const team = teamFromSnapshot(league, season, row.teamSnapshot, {
    id: freshTeamId(season), coach: row.coach, teamName: row.teamName, race: row.race, by: row.decided?.by ?? row.coach, at,
    teamUid: teamUidFor(seasons, row.libraryTeamId), entryId: mint("en"), registrationId: row.id,
    ...(row.libraryTeamId ? { libraryTeamId: row.libraryTeamId } : {}),
  });
  season.teams = [...(season.teams ?? []), team];
  const participant: LeagueParticipant = {
    coach: row.coach, coachId: row.coach, coachAssigned: true, country: "", race: team.race, team: team.name, registeredAt: at, active: true,
    teamId: team.id, addedHere: true,
  };
  season.participants = [...(season.participants ?? []), participant];
  return team;
}

/**
 * Places an accepted registration made with one of the coach's league teams (owner 11-03): the same team (teamUid, roster,
 * skills, SPP, treasury, history kept in its old season), fresh player ids, this season's counters at zero, a fresh entry.
 * Re-checked now (owned, transfer permitted, one place at a time).
 */
export function placeTransferredTeam(store: LeagueStore, league: LeagueRecord, season: SeasonRecord, row: LeagueRegistrationRow, now: Date): LeagueTeam {
  const found = transferSource(store, row.coach, row.teamRef, { league, season });
  if ("error" in found) throw new RegistrationError(409, "invalid-transition", found.error);
  const used = new Set(store.competitions(league.id).flatMap((s) => (s.teams ?? []).flatMap((t) => [...t.players, ...(t.formerPlayers ?? [])].map((p) => p.playerId))));
  const at = now.toISOString();
  const moved = adoptLineage(store, found.source, at);
  const team = teamFromLeagueTeam(moved.team, season, { id: freshTeamId(season), usedIds: used, from: moved.from });
  team.coach = row.coach;
  team.coachId = row.coach;
  team.coachAssigned = { by: row.decided?.by ?? row.coach, at };
  team.entryId = mint("en");
  team.registrationId = row.id;
  delete team.transfer;
  season.teams = [...(season.teams ?? []), team];
  season.participants = [...(season.participants ?? []), {
    coach: row.coach, coachId: row.coach, coachAssigned: true, country: "", race: team.race, team: team.name, registeredAt: at, active: true, teamId: team.id, addedHere: true,
  }];
  return team;
}

/** Takes a removed entry's team out of the season (and its participant row). Refused while a fixture names it. */
export function unplaceRegisteredTeam(season: SeasonRecord, teamId: string | undefined): void {
  if (!teamId) return;
  if ((season.fixtures ?? []).some((f) => f.home?.teamId === teamId || f.away?.teamId === teamId))
    throw new RegistrationError(409, "invalid-transition", "This team has fixtures. Set it inactive from its team page instead.");
  season.teams = (season.teams ?? []).filter((t) => t.id !== teamId);
  season.participants = (season.participants ?? []).filter((p) => p.teamId !== teamId);
}

// ---- the commit guard -------------------------------------------------------------------------------------------------

/**
 * Re-checks the core's decision against the stored season, in the same synchronous mutation as the write: an entry
 * becoming live or accepted needs the season still open for it (not finished, not started unless joining mid-season is
 * on); a coach entering themselves needs the window still open (seasonWindowStatus: stage, Allow registration, dates);
 * the accepted entries after the write must fit max teams and max per race. Leaving is never refused here.
 */
export function registrationCommitGuard(league: LeagueRecord, season: SeasonRecord, changes: readonly RegistrationChange[], now: Date): void {
  const c = seasonSnapshot(league, season);
  let gainsAccepted = false;
  for (const change of changes) {
    const to = change.after.state;
    const from = change.before?.state;
    const becomesLive = LIVE.has(to) && !(from && LIVE.has(from));
    const becomesAccepted = to === "accepted" && from !== "accepted";
    if (becomesAccepted) gainsAccepted = true;
    if (becomesLive || becomesAccepted) {
      const s = organiserMayAdd(c);
      if (!s.open) throw new RegistrationError(409, "closed", s.message);
    }
    const action = change.transition.action;
    if (action === "submit" || action === "reenter") {
      const by = change.transition.by;
      const self = ckey(by) === ckey(change.after.coach) && !c.managers.some((m) => ckey(m) === ckey(by));
      if (self) {
        const w = seasonWindowStatus(league, season, now);
        if (!w.open) throw new RegistrationError(409, "closed", w.message);
      }
    }
  }
  if (!gainsAccepted) return;
  const changed = new Map(changes.map((ch) => [ch.after.id, ch.after] as const));
  const stored = seasonEntries(league, season).filter((e) => !changed.has(e.id));
  const after = [...stored.filter((e) => e.state === "accepted"), ...[...changed.values()].filter((e) => e.state === "accepted")];
  const cap = normalizeCap(c.window.cap);
  if (cap !== null && after.length > cap) throw new RegistrationError(409, "full", "Full.");
  const perRace = normalizeCap(c.window.perRace ?? null);
  if (perRace !== null) {
    for (const e of changed.values()) {
      if (e.state !== "accepted" || !e.race) continue;
      const same = after.filter((x) => x.race && ckey(x.race) === ckey(e.race)).length;
      if (same > perRace) throw new RegistrationError(409, "race-full", "That race is full.");
    }
  }
}

// ---- the adapter --------------------------------------------------------------------------------------------------------

export interface LeagueAdapterOptions {
  now?: () => Date;
  /** Fault injection (tests): runs inside commit after every check, just before the season is written. */
  beforeWrite?: (season: SeasonRecord) => void;
  /** Ladders (lane 8b, ladderRegistration.ts): how an accepted row becomes a team (default placeRegisteredTeam), and the
   *  competition's own follow-up in the same write (a ladder member). Absent = a season, exactly as before. */
  placeTeam?: (league: LeagueRecord, season: SeasonRecord, row: LeagueRegistrationRow, seasons: readonly SeasonRecord[], now: Date) => LeagueTeam;
  afterPlace?: (season: SeasonRecord, row: LeagueRegistrationRow, team: LeagueTeam, now: Date) => void;
  afterUnplace?: (season: SeasonRecord, row: LeagueRegistrationRow, now: Date) => void;
}

export class LeagueRegistrationAdapter implements RegistrationAdapter {
  readonly kind = "league" as const;

  constructor(private readonly store: LeagueStore, private readonly opts: LeagueAdapterOptions = {}) {}

  private load(id: string): { league: LeagueRecord; season: SeasonRecord } | undefined {
    const { leagueId, seasonId } = parseCompetitionId(id);
    const league = this.store.league(leagueId);
    const season = league ? this.store.season(leagueId, seasonId) : undefined;
    return league && season ? { league, season } : undefined;
  }

  competition(id: string): CompetitionSnapshot | undefined {
    const found = this.load(id);
    return found ? seasonSnapshot(found.league, found.season) : undefined;
  }

  entries(id: string): RegistrationEntry[] {
    const found = this.load(id);
    return found ? seasonEntries(found.league, found.season) : [];
  }

  newEntryId(): string {
    return mint("lr");
  }

  /** A pending / waitlisted entry made with a fork library team (before owner rule 11-03) is never accepted or promoted; the core
   *  skips it when promoting so the next eligible entry still gets the place. */
  promotionBlocked(id: string, entry: RegistrationEntry): boolean {
    const found = this.load(id);
    const row = found?.season.registrations?.find((r) => r.id === entry.id);
    return Boolean(row?.teamRef.startsWith("library:"));
  }

  commit(id: string, changes: readonly RegistrationChange[]): void {
    const found = this.load(id);
    if (!found) throw new RegistrationError(404, "not-found", "Not found.");
    const { league, season } = found;
    const now = this.opts.now?.() ?? new Date();
    for (const ch of changes) {
      if (!ch.after.id.startsWith("lr-")) throw new RegistrationError(404, "not-found", "Entry not found.");
      if (ch.after.competitionId !== id) throw new RegistrationError(404, "not-found", "Entry not found.");
    }
    registrationCommitGuard(league, season, changes, now);
    const rows = structuredClone(season.registrations ?? []);
    const codes = new Set(rows.map((r) => r.refCode).filter((c): c is string => Boolean(c)));
    const seasons = this.store.competitions(league.id);
    const released: string[] = [];
    for (const change of changes) {
      const after = change.after;
      const data = after.data as LeagueEntryData | undefined;
      const action = change.transition.action;
      let row = rows.find((r) => r.id === after.id);
      // The stored state is the authority for the side effects (the lock makes it equal the core's read).
      const from = row ? row.state : undefined;
      if (!row) {
        if (action !== "submit" || !data) throw new Error("A new league entry needs its team.");
        const refCode = newReferenceCode(codes);
        codes.add(refCode);
        row = {
          id: after.id, leagueId: league.id, seasonId: season.id, coach: after.coach, state: after.state,
          submittedAt: after.submittedAt, enteredAt: after.enteredAt, registrationLog: [],
          race: canonicalRace(data.race), teamName: data.teamName, teamRef: data.teamRef, kind: data.kind,
          ...(data.libraryTeamId ? { libraryTeamId: data.libraryTeamId } : {}),
          teamSnapshot: structuredClone(data.teamSnapshot), validation: structuredClone(data.validation),
          ...(data.region ? { region: data.region } : {}), ...(data.clubId ? { clubId: data.clubId } : {}), refCode,
          ...(data.move ? { move: structuredClone(data.move) } : {}),
        };
        rows.push(row);
      } else if (action === "reenter" && data) {
        // The row keeps its id, reference code and "I've paid"; the team and the answers come from the new submission.
        row.race = canonicalRace(data.race);
        row.teamName = data.teamName;
        row.teamRef = data.teamRef;
        row.kind = data.kind;
        if (data.libraryTeamId) row.libraryTeamId = data.libraryTeamId; else delete row.libraryTeamId;
        row.teamSnapshot = structuredClone(data.teamSnapshot);
        row.validation = structuredClone(data.validation);
        if (data.region) row.region = data.region; else delete row.region;
        if (data.clubId) row.clubId = data.clubId; else delete row.clubId;
        if (data.move) row.move = structuredClone(data.move); else delete row.move;
        delete row.teamId;
        delete row.midSeason;
      }
      row.state = after.state;
      row.submittedAt = after.submittedAt;
      row.enteredAt = after.enteredAt;
      if (after.waitlistAt) row.waitlistAt = after.waitlistAt; else delete row.waitlistAt;
      if (after.waitlistSeq !== undefined) row.waitlistSeq = after.waitlistSeq; else delete row.waitlistSeq;
      if (after.decided) row.decided = structuredClone(after.decided); else delete row.decided;
      row.registrationLog = structuredClone(after.log);
      if (after.state === "accepted" && from !== "accepted") {
        // Acceptance and the team are one write (the putSeason below).
        // A fork library team is never a source (owner 11-03): an entry made with one before that rule is not accepted; the
        // organisers ask the coach to register again with a saved team (the entry stays as it is).
        if (row.teamRef.startsWith("library:"))
          throw new RegistrationError(409, "invalid-transition", "This entry was made with a Super FUMBBL library team, which can't join a league any more. Ask the coach to withdraw and register again with a saved team.");
        // A league team (transfer permitted when it played elsewhere) joins with its record; a save is built from its sheet.
        // A ladder (lane 8b) places its own way (a move with progression, or the sheet): ladderRegistration.ts.
        const team = this.opts.placeTeam ? this.opts.placeTeam(league, season, row, seasons, now)
          : parseLeagueTeamRef(row.teamRef) ? placeTransferredTeam(this.store, league, season, row, now) : placeRegisteredTeam(league, season, row, seasons, now);
        row.teamId = team.id;
        if (seasonStage(season) === "active") row.midSeason = true; else delete row.midSeason;
        this.opts.afterPlace?.(season, row, team, now);
      } else if (from === "accepted" && after.state !== "accepted") {
        unplaceRegisteredTeam(season, row.teamId);
        this.opts.afterUnplace?.(season, row, now);
      }
      if (after.state === "declined" || after.state === "withdrawn" || after.state === "dropped") released.push(row.coach);
    }
    season.registrations = rows;
    this.opts.beforeWrite?.(season);
    this.store.putSeason(season);
    // An entry that ended without a seat: the join acknowledgement goes too (unless the coach is seated or still waiting).
    if (released.length) this.store.releaseRegistrationAcks(league.id, released);
  }

  markCheckInNotice(): void {
    // League seasons have no check-in.
  }

  link(id: string, audience: "coach" | "organiser"): string {
    const { leagueId, seasonId } = parseCompetitionId(id);
    return leagueRegistrationLink(leagueId, seasonId, audience);
  }
}

export interface LeagueRegistrationDeps extends LeagueAdapterOptions {
  notify?: RegistrationNotifySink;
}

/** The registration service over one league store (the process-wide lock is shared by every instance). */
export function leagueRegistrationService(store: LeagueStore, deps: LeagueRegistrationDeps = {}) {
  const adapter = new LeagueRegistrationAdapter(store, deps);
  return createRegistrationService({ adapter, ...(deps.notify ? { notify: deps.notify } : {}), ...(deps.now ? { now: deps.now } : {}) });
}
export type LeagueRegistrationService = ReturnType<typeof leagueRegistrationService>;

// ---- views --------------------------------------------------------------------------------------------------------------

/** The stored, valid reference code of a row (never derived). */
export const refCodeOf = (row: Pick<LeagueRegistrationRow, "refCode">): string | undefined => (row.refCode && REF_CODE.test(row.refCode) ? row.refCode : undefined);

/** Accepted teams per race in the season (public: the teams are public), dataset spelling. */
export function acceptedRaceCounts(league: Pick<LeagueRecord, "id">, season: SeasonRecord): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of seasonEntries(league, season)) if (e.state === "accepted" && e.race) out[e.race] = (out[e.race] ?? 0) + 1;
  return out;
}

/** The season's registration settings the join sheet shows (all public settings). */
export function seasonRegistrationSettings(league: LeagueRecord, season: SeasonRecord) {
  const reg = seasonRegistrationOf(league, season);
  return {
    approval: reg.approval, waitlist: reg.waitlist, allowExistingTeams: reg.allowExistingTeams, allowMidSeason: reg.allowMidSeason,
    cap: normalizeCap(reg.maxRegistrations), perRace: normalizeCap(reg.maxPerRace), entryFee: reg.entryFee,
  };
}
