/**
 * Available for Takeover (spec-team-management-2026-11-02; round answer Q8): applications go through the shared
 * registration core (src/registration: pending -> accepted / declined / withdrawn, the audited log, the notifications).
 *
 * The competition the core sees is ONE takeover listing: id `<leagueId>/<seasonId>/<listingId>` (LeagueTeam.takeover.id;
 * a team listed again gets a new listing, so an old listing's decisions never block a new one). Organiser approval, no
 * waitlist, one place. Storage: one row per application in the season file's `takeoverApplications[]`, in any state.
 * Approving is ONE season write: the row turns accepted, the entry changes (teamLibrary.ts: a swap with the applicant's
 * team, or the team's ownership moving to the applicant), the listing closes and every other live application of the
 * listing is declined ("Another application was approved."). The core announces the applicant's outcome and tells the
 * organisers of every application (law 24); the route adds the old coach's and the other organisers' notes.
 *
 * Two kinds:
 *  - mode "team": the applicant's own team (a Roster Builder save, built in league mode or not, or a library team), checked
 *    against the season's rules at application (the L6 join check) and frozen as a snapshot. Approval substitutes it in.
 *  - mode "takeover": the applicant takes the listed team over. Approval transfers ownership; standings and skills stay.
 *
 * Privacy: rows never reach a public read (api.ts seasonForViewer drops them). The applicant sees their own; organisers
 * see the listing's rows (with what the coach shared for this league, only while the row is live).
 */
import { randomBytes } from "node:crypto";
import {
  createRegistrationService, RegistrationError,
  type CompetitionSnapshot, type EntryState, type RegistrationAdapter, type RegistrationChange, type RegistrationDecision,
  type RegistrationEntry, type RegistrationNotifySink, type RegistrationTransition,
} from "../registration/index.js";
import { isDraftLeague } from "./lifecycle.js";
import { freshTeamId, lineageFor, teamFromSnapshot, type LeagueTeamSnapshot } from "./registration.js";
import { leagueOwner, type LeagueStore } from "./store.js";
import { applyEntrySwap, applyTakeover, entryChangeBlock, parseLeagueTeamRef, teamFromLeagueTeam, transferSource, type EntryChange } from "./teamLibrary.js";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "./types.js";

export interface TakeoverApplicationRow {
  id: string;
  leagueId: string;
  seasonId: string;
  /** The listed entry (LeagueTeam.id) and the listing (LeagueTeam.takeover.id) the application is for. */
  teamId: string;
  listingId: string;
  /** The listed team's name when the application was made (the listing may be gone later). */
  listedTeam: string;
  coach: string;
  state: EntryState;
  submittedAt: string;
  enteredAt: string;
  waitlistAt?: string;
  waitlistSeq?: number;
  decided?: RegistrationDecision;
  registrationLog: RegistrationTransition[];
  mode: "team" | "takeover";
  /** mode "team": what the coach applied with, frozen at application. */
  teamRef?: string;
  teamName?: string;
  race?: string;
  libraryTeamId?: string;
  teamSnapshot?: LeagueTeamSnapshot;
  validation?: { ok: boolean; problems: string[]; checkedAt: string };
  /** The applicant was on the league's roster when applying (the share acknowledgement is asked of the others). */
  member: boolean;
  /** Set on approval: the entry's played games at that moment. */
  approved?: { at: string; games: number };
}

/** What the apply route hands the core (RegistrationEntry.data). */
export interface TakeoverEntryData {
  teamId: string;
  listedTeam: string;
  mode: "team" | "takeover";
  member: boolean;
  teamRef?: string;
  teamName?: string;
  race?: string;
  libraryTeamId?: string;
  teamSnapshot?: LeagueTeamSnapshot;
  validation?: TakeoverApplicationRow["validation"];
}

const LIVE: ReadonlySet<EntryState> = new Set(["pending", "waitlisted", "accepted"]);
const mint = (prefix: string): string => `${prefix}-${randomBytes(6).toString("hex")}`;
export const LISTING_ID = /^tk-[0-9a-f]{12}$/;
export const APPLICATION_ID = /^ta-[0-9a-f]{12}$/;

export const takeoverCompetitionId = (leagueId: string, seasonId: string, listingId: string): string => `${leagueId}/${seasonId}/${listingId}`;
export function parseTakeoverCompetitionId(id: string): { leagueId: string; seasonId: string; listingId: string } {
  const [leagueId = "", seasonId = "", listingId = "", ...rest] = id.split("/");
  if (rest.length || !leagueId || !seasonId || !LISTING_ID.test(listingId)) throw new RegistrationError(404, "not-found", "Not found.");
  return { leagueId, seasonId, listingId };
}

/** The listed team of a listing (undefined once it is closed). */
export const listedTeam = (season: Pick<SeasonRecord, "teams">, listingId: string): LeagueTeam | undefined =>
  (season.teams ?? []).find((t) => t.takeover?.id === listingId);

export function applicationToEntry(row: TakeoverApplicationRow): RegistrationEntry {
  return {
    id: row.id,
    competitionId: takeoverCompetitionId(row.leagueId, row.seasonId, row.listingId),
    coach: row.coach,
    state: row.state,
    submittedAt: row.submittedAt,
    enteredAt: row.enteredAt,
    ...(row.waitlistAt ? { waitlistAt: row.waitlistAt } : {}),
    ...(row.waitlistSeq !== undefined ? { waitlistSeq: row.waitlistSeq } : {}),
    ...(row.decided ? { decided: structuredClone(row.decided) } : {}),
    log: structuredClone(row.registrationLog ?? []),
  };
}

/** The overview link every takeover notice opens (the panel lives on the league overview only). */
export const takeoverLink = (leagueId: string, seasonId: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}`;

/** What an approval did (for the route's notices). */
export interface TakeoverApproval {
  leagueId: string;
  seasonId: string;
  row: TakeoverApplicationRow;
  change: EntryChange;
  /** Rows of the listing declined by the approval. */
  declined: TakeoverApplicationRow[];
}

export interface TakeoverAdapterOptions {
  now?: () => Date;
  /** Fault injection (tests): runs inside commit after every check, just before the season is written. */
  beforeWrite?: (season: SeasonRecord) => void;
  /** Fixture ids with an unpublished tabletop recorder match (the route reads them before the approval). */
  openRecorder?: ReadonlySet<string>;
  /** Called after an approval's season write. */
  onApproved?: (info: TakeoverApproval) => void;
}

export class TakeoverAdapter implements RegistrationAdapter {
  readonly kind = "league" as const;

  constructor(private readonly store: LeagueStore, private readonly opts: TakeoverAdapterOptions = {}) {}

  private load(id: string): { league: LeagueRecord; season: SeasonRecord; listingId: string } | undefined {
    const { leagueId, seasonId, listingId } = parseTakeoverCompetitionId(id);
    const league = this.store.league(leagueId);
    const season = league ? this.store.season(leagueId, seasonId) : undefined;
    return league && season ? { league, season, listingId } : undefined;
  }

  competition(id: string): CompetitionSnapshot | undefined {
    const found = this.load(id);
    if (!found) return undefined;
    const { league, season, listingId } = found;
    const team = listedTeam(season, listingId);
    const known = team ?? (season.takeoverApplications ?? []).some((r) => r.listingId === listingId);
    if (!known) return undefined;
    const name = team?.name ?? (season.takeoverApplications ?? []).find((r) => r.listingId === listingId)?.listedTeam ?? "Team";
    const owner = leagueOwner(league);
    return {
      kind: "league", id, name: `${name} takeover (${league.name} ${season.name})`,
      published: !isDraftLeague(league),
      // A closed listing (approved, unlisted) or a finished season takes no more decisions.
      finished: season.status === "completed" || !team,
      started: false, locked: false, test: league.test === true,
      window: { cap: 1, approval: "organiser", waitlist: false },
      managers: [...new Set([...(owner ? [owner] : []), ...league.organisers])],
    };
  }

  entries(id: string): RegistrationEntry[] {
    const found = this.load(id);
    if (!found) return [];
    return (found.season.takeoverApplications ?? []).filter((r) => r.listingId === found.listingId).map(applicationToEntry);
  }

  newEntryId(): string {
    return mint("ta");
  }

  commit(id: string, changes: readonly RegistrationChange[]): void {
    const found = this.load(id);
    if (!found) throw new RegistrationError(404, "not-found", "Not found.");
    const { league, season, listingId } = found;
    const now = this.opts.now?.() ?? new Date();
    const at = now.toISOString();
    for (const ch of changes) {
      if (!APPLICATION_ID.test(ch.after.id) || ch.after.competitionId !== id) throw new RegistrationError(404, "not-found", "Application not found.");
    }
    const rows = structuredClone(season.takeoverApplications ?? []);
    let approval: Omit<TakeoverApproval, "declined"> | undefined;
    const declined: TakeoverApplicationRow[] = [];
    for (const change of changes) {
      const after = change.after;
      const action = change.transition.action;
      const data = after.data as TakeoverEntryData | undefined;
      let row = rows.find((r) => r.id === after.id);
      const from = row ? row.state : undefined;
      if (!row) {
        if (action !== "submit" || !data) throw new Error("A new takeover application needs its details.");
        row = {
          id: after.id, leagueId: league.id, seasonId: season.id, teamId: data.teamId, listingId, listedTeam: data.listedTeam,
          coach: after.coach, state: after.state, submittedAt: after.submittedAt, enteredAt: after.enteredAt, registrationLog: [],
          mode: data.mode, member: data.member,
          ...(data.teamRef ? { teamRef: data.teamRef } : {}), ...(data.teamName ? { teamName: data.teamName } : {}), ...(data.race ? { race: data.race } : {}),
          ...(data.libraryTeamId ? { libraryTeamId: data.libraryTeamId } : {}),
          ...(data.teamSnapshot ? { teamSnapshot: structuredClone(data.teamSnapshot) } : {}),
          ...(data.validation ? { validation: structuredClone(data.validation) } : {}),
        };
        rows.push(row);
      } else if (action === "reenter" && data) {
        // A withdrawn coach applying again: same row, the new choice.
        row.mode = data.mode;
        row.member = data.member;
        for (const k of ["teamRef", "teamName", "race", "libraryTeamId", "teamSnapshot", "validation"] as const) {
          if (data[k] !== undefined) (row as unknown as Record<string, unknown>)[k] = structuredClone(data[k]); else delete row[k];
        }
      }
      row.state = after.state;
      row.submittedAt = after.submittedAt;
      row.enteredAt = after.enteredAt;
      if (after.waitlistAt) row.waitlistAt = after.waitlistAt; else delete row.waitlistAt;
      if (after.waitlistSeq !== undefined) row.waitlistSeq = after.waitlistSeq; else delete row.waitlistSeq;
      if (after.decided) row.decided = structuredClone(after.decided); else delete row.decided;
      row.registrationLog = structuredClone(after.log);
      if (after.state === "accepted" && from !== "accepted") {
        // Approval and the entry change are one write (the putSeason below), re-checked against the stored season.
        const team = listedTeam(season, listingId);
        if (!team) throw new RegistrationError(409, "closed", "This team is no longer available for takeover.");
        const block = entryChangeBlock(season, team.id, this.opts.openRecorder);
        if (block) throw new RegistrationError(409, "invalid-transition", block);
        const by = change.transition.by;
        let entry: EntryChange;
        if (row.mode === "team" && row.teamRef && parseLeagueTeamRef(row.teamRef)) {
          // The applicant's league team moves with its record (lineage, history), re-checked now.
          const found = transferSource(this.store, row.coach, row.teamRef, { league, season, teamId: team.id });
          if ("error" in found) throw new RegistrationError(409, "invalid-transition", found.error);
          const used = new Set(this.store.seasons(league.id).flatMap((s) => s.teams.flatMap((t) => [...t.players, ...(t.formerPlayers ?? [])].map((p) => p.playerId))));
          const incoming = teamFromLeagueTeam(found.source.team, season, { id: team.id, usedIds: used });
          incoming.coach = row.coach;
          incoming.coachId = row.coach;
          entry = applyEntrySwap(season, team.id, incoming, by, at, "apply");
        } else if (row.mode === "team") {
          if (!row.teamSnapshot) throw new RegistrationError(409, "invalid-transition", "This application has no team to substitute in.");
          const incoming = teamFromSnapshot(league, season, row.teamSnapshot, {
            id: freshTeamId(season), coach: row.coach, ...(row.teamName ? { teamName: row.teamName } : {}), ...(row.race ? { race: row.race } : {}), by, at,
            teamUid: lineageFor(this.store.seasons(league.id), row.libraryTeamId), entryId: team.entryId ?? mint("en"),
            ...(row.libraryTeamId ? { libraryTeamId: row.libraryTeamId } : {}),
          });
          entry = applyEntrySwap(season, team.id, incoming, by, at, "apply");
        } else {
          entry = applyTakeover(season, team.id, row.coach, by, at);
        }
        row.approved = { at, games: entry.games };
        approval = { leagueId: league.id, seasonId: season.id, row: structuredClone(row), change: entry };
      }
    }
    if (approval) {
      // The listing is closed: every other live application of it is declined in the same write.
      for (const r of rows) {
        if (r.listingId !== listingId || r.id === approval.row.id || !LIVE.has(r.state)) continue;
        const t: RegistrationTransition = { action: "decline", from: r.state, to: "declined", by: "system", at, reason: "Another application was approved." };
        r.state = "declined";
        r.decided = { by: "system", at, reason: t.reason };
        r.registrationLog = [...(r.registrationLog ?? []), t];
        delete r.waitlistAt;
        delete r.waitlistSeq;
        declined.push(structuredClone(r));
      }
    }
    season.takeoverApplications = rows;
    this.opts.beforeWrite?.(season);
    this.store.putSeason(season);
    if (approval) {
      try { this.opts.onApproved?.({ ...approval, declined }); } catch { /* notices only */ }
    }
  }

  markCheckInNotice(): void {
    // Takeover listings have no check-in.
  }

  link(id: string): string {
    const { leagueId, seasonId } = parseTakeoverCompetitionId(id);
    return takeoverLink(leagueId, seasonId);
  }
}

export interface TakeoverServiceDeps extends TakeoverAdapterOptions {
  notify?: RegistrationNotifySink;
}

/** The registration service over the takeover listings of one league store (the process-wide lock is shared). */
export function takeoverService(store: LeagueStore, deps: TakeoverServiceDeps = {}) {
  const adapter = new TakeoverAdapter(store, deps);
  return createRegistrationService({ adapter, ...(deps.notify ? { notify: deps.notify } : {}), ...(deps.now ? { now: deps.now } : {}) });
}

/**
 * Closes a listing an organiser took down (in place): the listing goes and every live application of it is declined with
 * the reason. Returns the declined rows (the route tells their coaches).
 */
export function closeListing(season: SeasonRecord, team: LeagueTeam, by: string, at: string): TakeoverApplicationRow[] {
  const listingId = team.takeover?.id;
  delete team.takeover;
  if (!listingId) return [];
  const out: TakeoverApplicationRow[] = [];
  for (const r of season.takeoverApplications ?? []) {
    if (r.listingId !== listingId || !LIVE.has(r.state) || r.state === "accepted") continue;
    const reason = "The team is no longer available for takeover.";
    r.registrationLog = [...(r.registrationLog ?? []), { action: "decline", from: r.state, to: "declined", by, at, reason }];
    r.state = "declined";
    r.decided = { by, at, reason };
    delete r.waitlistAt;
    delete r.waitlistSeq;
    out.push(structuredClone(r));
  }
  return out;
}
