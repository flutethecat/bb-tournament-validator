import { bb2025 } from "@bb/validator/dataset";
import { generateTournamentPairings } from "./pairing.js";
import { NafExportError, renderNafTournamentReport } from "./nafExport.js";
import { isTournamentManager, tournamentOwner, TournamentStore, TournamentStoreError, type TournamentUpdate } from "./store.js";
import { canEditSeries, seriesChip } from "./series.js";
import { bannerUrl, NEWS_MAX_POSTS, newNewsPost, orderedNews, PAGE_FIELDS, parseNewsInput, parsePagePatch } from "./page.js";
import { DEFAULT_ENTRANT_FLAGS, DEFAULT_TOURNAMENT_TURN_TIMER, TOURNAMENT_PAIRING_SYSTEMS, TOURNAMENT_SEEDING_MODES } from "./types.js";
import type {
  ScheduledMatchRecord,
  TournamentEntrantFlags,
  TournamentEntrantRecord,
  TournamentPairingSystem,
  TournamentSeedingMode,
  TournamentSubmission,
  TournamentPrimaryTiebreaker,
  TournamentRecord,
  VerifiedCoachIdentity,
} from "./types.js";
import { tournamentLink, type TournamentNotify } from "../notifications.js";
import { myTournamentAwards, tournamentHonoursRoutes } from "./honours.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import { canonicalNafId } from "../auth/identitiesStore.js";
import { ContactValidationError, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import type { SharedContact } from "../auth/contactFor.js";

export interface TournamentApiIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
}

export interface TournamentApiDeps {
  store: TournamentStore;
  teamBuild(teamId: string, coachId?: string): unknown | undefined;
  identityRecord?(coachId: string): TournamentIdentityRecord | undefined;
  /** The same for many coaches at once (one identities read; the detail page). Absent = identityRecord() per coach. */
  identityRecords?(coachIds: readonly string[]): Array<TournamentIdentityRecord | undefined>;
  packageExists?(packageName: string): boolean;
  teamOwner?(teamId: string): string | undefined;
  coachRating?(coach: string): number | undefined;
  /** v4: snapshot + validate a coach's Team Builder save (`save:<id>`) or library team (`library:<teamId>`) against a package. */
  validateSubmission?(coach: string, ref: string, packageName: string, now: Date): TournamentSubmission | { error: string; status?: 400 | 404 | 409 };
  /** v4: the stored spelling of a registered coach id (identities store), or undefined when nobody has that id. */
  registeredCoach?(coachId: string): string | undefined;
  /** v4: the package file's current revision; Start refuses rosters checked against another revision. */
  packageRevision?(packageName: string): string | undefined;
  /** v4: the shared Team Builder read-view model (teamShareView) of a submitted snapshot, or undefined. */
  submissionTeamView?(coach: string, submission: TournamentSubmission, packageName: string): unknown | undefined;
  /** Coach notifications (src/notifications.ts). Fire-and-forget; absent = no notifications. */
  notify?: TournamentNotify;
  /** Per-organiser sharing (src/auth/sharing.ts, owner 10-31). Absent = no share picker, no shared fields. */
  sharing?: {
    /** Stores the coach's own `tournament:<id>` grant (written with a self-registration). */
    grant(coach: string, scope: string, fields: ShareField[], now: Date): void;
    /** What `viewer` sees of the coach for this tournament (sharedContactFor); undefined = not allowed or not entered. */
    contact(viewer: TournamentApiIdentity, coach: string, tournamentId: string): SharedContact | undefined;
    /** The same for many coaches at once (one identity read; the Participants table). Absent = contact() per coach. */
    contacts?(viewer: TournamentApiIdentity, coaches: readonly string[], tournamentId: string): Array<SharedContact | undefined>;
  };
  /** Counted result rows (TournamentResultStore.list()) for Statistics / Honours (src/tournaments/honours.ts). */
  results?(): StoredTournamentResult[];
  /** The request's If-Match header (award DELETE carries its revision there). */
  ifMatch?: string;
  now?: () => Date;
}

/** The slice of a coach's identity record the tournament routes read: the profile NAF details (owner 10-31: the
 *  source of an entry's NAF name and number on a NAF-sanctioned tournament) and the NAF page check. */
export interface TournamentIdentityRecord {
  ffbCoachId: string;
  identities: { nafName?: string; nafId?: string };
  connections?: { naf?: { nafId: string; nafName: string } };
}

export interface TournamentApiResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  contentType?: string;
}

const coachKey = (value: string): string => value.trim().toLowerCase();
const TOURNAMENT_PAGE_SIZE = 20;

function decoded(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

function jsonObject(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TournamentStoreError(400, "A JSON object is required.");
  return body as Record<string, unknown>;
}

function integer(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) throw new TournamentStoreError(400, `${field} must be an integer.`);
  return value as number;
}

function primaryTiebreaker(value: unknown): TournamentPrimaryTiebreaker {
  if (!(value === "buchholz" || value === "sonnebornBerger"))
    throw new TournamentStoreError(400, "primaryTiebreaker must be buchholz or sonnebornBerger.");
  return value;
}

function requestedRoundCount(value: unknown): number {
  const count = integer(value, "roundCount");
  if (count < 1 || count > 50) throw new TournamentStoreError(400, "roundCount must be between 1 and 50.");
  return count;
}

function csvCell(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function exportFilename(name: string, format: "csv" | "json" | "naf"): string {
  const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "tournament";
  return format === "naf" ? `${base}-naf.xml` : `${base}.${format}`;
}

function authenticated(auth: TournamentApiIdentity | undefined): TournamentApiIdentity {
  if (!auth) throw new TournamentStoreError(401, "Authentication required.");
  return auth;
}

/** Manager = admin, the owner, or a listed organiser of this tournament. */
function requireTournamentManager(tournament: TournamentRecord, auth: TournamentApiIdentity): void {
  if (auth.admin) return;
  if (isTournamentManager(tournament, auth.coach)) return;
  throw new TournamentStoreError(403, "You are not this tournament's organizer.");
}

function isParticipant(match: ScheduledMatchRecord, coach: string): boolean {
  const key = coachKey(coach);
  return coachKey(match.home.coach.ffbCoachId) === key || (match.away !== undefined && coachKey(match.away.coach.ffbCoachId) === key);
}

function opponent(match: ScheduledMatchRecord, coach: string): VerifiedCoachIdentity | undefined {
  const key = coachKey(coach);
  if (coachKey(match.home.coach.ffbCoachId) === key) return match.away?.coach;
  if (match.away && coachKey(match.away.coach.ffbCoachId) === key) return match.home.coach;
  return undefined;
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

const SUBMISSION_REF = /^(?:save:|library:)?[A-Za-z0-9_.:-]+$/;

/** Owner-level actions (owner reassignment, organiser list): admin or the tournament owner. */
function requireTournamentOwner(tournament: TournamentRecord, auth: TournamentApiIdentity): void {
  if (auth.admin) return;
  const owner = tournamentOwner(tournament);
  if (owner && coachKey(auth.coach) === coachKey(owner)) return;
  throw new TournamentStoreError(403, "Only the tournament owner or an admin can change its roles.");
}

function canManage(tournament: TournamentRecord, auth: TournamentApiIdentity | undefined): boolean {
  return Boolean(auth && (auth.admin || isTournamentManager(tournament, auth.coach)));
}

/** A coach id that names a registered user (identities store), in its stored spelling. */
function registeredCoach(deps: TournamentApiDeps, value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40)
    throw new TournamentStoreError(400, "coachId must be a non-empty coach id of at most 40 characters.");
  if (!deps.registeredCoach) throw new TournamentStoreError(400, "Coach accounts cannot be checked on this host.");
  const coach = deps.registeredCoach(value.trim());
  if (!coach) throw new TournamentStoreError(400, `"${value.trim()}" is not a registered coach.`);
  return coach;
}

/** Fresh snapshot + validation for every undropped entrant (their submission, else their registered library team). */
function rosterChecks(
  tournament: TournamentRecord,
  entrants: readonly TournamentEntrantRecord[],
  deps: TournamentApiDeps,
  now: Date,
): Record<string, TournamentSubmission | { error: string }> {
  const out: Record<string, TournamentSubmission | { error: string }> = {};
  for (const entrant of entrants) {
    if (entrant.droppedAt !== undefined) continue;
    if (!deps.validateSubmission) {
      out[entrant.id] = { error: "Team validation is unavailable on this host." };
      continue;
    }
    const ref = entrant.submission?.saveId ?? `library:${entrant.teamId}`;
    let check: ReturnType<NonNullable<TournamentApiDeps["validateSubmission"]>>;
    try {
      check = deps.validateSubmission(entrant.coach.ffbCoachId, ref, tournament.packageName, now);
    } catch {
      throw new TournamentStoreError(503, "Team validation failed on this host; nothing was locked. Try again.");
    }
    out[entrant.id] = "error" in check ? { error: check.error } : check;
  }
  return out;
}

/** The submission as the page shows it: validity for everyone, the problems list only for the coach and managers. */
function submissionView(entrant: TournamentEntrantRecord, private_: boolean) {
  const submission = entrant.submission;
  if (!submission) return undefined;
  return {
    saveId: private_ ? submission.saveId : undefined,
    submittedAt: submission.submittedAt,
    ...(submission.teamName ? { teamName: submission.teamName } : {}),
    ...(submission.race ? { race: submission.race } : {}),
    valid: submission.validation.ok,
    problemCount: submission.validation.problems.length,
    checkedAt: submission.validation.checkedAt,
    ...(private_ ? { problems: submission.validation.problems } : {}),
  };
}

/** An entrant for the page; `private_` (the coach themselves or a manager) adds flags, manual seed and problems. */
/** shared: the coach's granted fields, for a manager's view only (sharedContactFor). tournament: when given, the NAF
 *  details and nafPending are derived from it and the coach's current profile NAF (`profile`): a sanctioned entry shows
 *  the profile's NAF name and number, and owes its answer when there is none (reads never write). */
function clientEntrant(entrant: TournamentEntrantRecord, deps: Pick<TournamentApiDeps, "teamBuild">, private_: boolean, shared?: SharedContact, tournament?: TournamentRecord, profile?: ProfileNaf) {
  const { coach, submission: _submission, flags, rosterVerifiedOverride, manualSeed, nafNumber, notNafMember, nafPending, nafSnapshot: _nafSnapshot, ...rest } = entrant;
  const team = deps.teamBuild(entrant.teamId);
  const submission = submissionView(entrant, private_);
  return {
    ...rest,
    entrantId: entrant.id,
    coachId: coach.ffbCoachId,
    coach: { coachId: coach.coachId, ffbCoachId: coach.ffbCoachId },
    ...(stringField(team, "teamName") ? { teamName: stringField(team, "teamName") } : submission?.teamName ? { teamName: submission.teamName } : {}),
    ...(stringField(team, "race") ? { race: stringField(team, "race") } : submission?.race ? { race: submission.race } : {}),
    ...(stringField(team, "logoUrl") ? { logoUrl: stringField(team, "logoUrl") } : {}),
    ...(submission ? { submission } : {}),
    ...(private_ ? {
      flags: { ...DEFAULT_ENTRANT_FLAGS, ...(flags ?? {}) },
      ...(rosterVerifiedOverride === undefined ? {} : { rosterVerifiedOverride }),
      ...(manualSeed === undefined ? {} : { manualSeed }),
      ...(tournament ? nafFields(entryNaf(tournament, entrant, profile)) : nafNumber ? { nafNumber } : {}),
      ...(notNafMember ? { notNafMember } : {}),
      ...((tournament ? nafOwed(tournament, entrant, profile) : nafPending) ? { nafPending: true as const } : {}),
    } : {}),
    ...(shared ? { shared } : {}),
  };
}

/** Per-entrant validation rows for the Start Tournament table. */
function validationTable(entrants: readonly TournamentEntrantRecord[], deps: Pick<TournamentApiDeps, "teamBuild">) {
  return entrants.filter((entrant) => entrant.droppedAt === undefined).map((entrant) => {
    const team = deps.teamBuild(entrant.teamId);
    return {
      entrantId: entrant.id,
      coachId: entrant.coach.ffbCoachId,
      teamName: stringField(team, "teamName") ?? entrant.submission?.teamName ?? entrant.teamId,
      valid: Boolean(entrant.flags?.rosterVerified),
      validatorOk: entrant.submission?.validation.ok ?? false,
      ...(entrant.submission ? { checkedAgainst: entrant.submission.validation.packageName } : {}),
      ...(entrant.rosterVerifiedOverride === undefined ? {} : { override: entrant.rosterVerifiedOverride }),
      problems: entrant.submission?.validation.problems ?? [],
    };
  });
}

/** A fixture for an entrant who does not play in it: names, teams, round, status, score. No coach identities beyond
 *  the fork coach name, no launch, lease or challenge data. */
function publicMatch(match: ScheduledMatchRecord) {
  const side = (s: ScheduledMatchRecord["home"]) => ({ entrantId: s.entrantId, teamId: s.teamId, coach: { ffbCoachId: s.coach.ffbCoachId } });
  return {
    id: match.id,
    matchId: match.id,
    tournamentId: match.tournamentId,
    roundId: match.roundId,
    roundNumber: match.roundNumber,
    round: match.roundNumber,
    status: match.status,
    home: side(match.home),
    ...(match.away ? { away: side(match.away) } : {}),
    ...(match.result ? {
      result: {
        homeScore: match.result.homeScore,
        awayScore: match.result.awayScore,
        ...(match.result.homeCasualties === undefined ? {} : { homeCasualties: match.result.homeCasualties }),
        ...(match.result.awayCasualties === undefined ? {} : { awayCasualties: match.result.awayCasualties }),
      },
    } : {}),
  };
}

/** A fixture side without the stored coach's Discord id (never shown to coaches or organisers). */
function sideWithoutDiscordId<T extends { coach: { discordUserId?: string } }>(side: T): T {
  const { discordUserId: _id, ...coach } = side.coach;
  return { ...side, coach } as T;
}

function clientMatch(
  store: TournamentStore,
  match: ScheduledMatchRecord,
  auth?: TournamentApiIdentity,
  now = new Date(),
  teamBuild?: TournamentApiDeps["teamBuild"],
) {
  const waitingCoachIds = store.activeLeases(match.id, now).map((lease) => lease.coachId);
  const participant = auth ? isParticipant(match, auth.coach) : false;
  const ownsHome = participant && coachKey(match.home.coach.ffbCoachId) === coachKey(auth!.coach);
  const mySide = participant ? (ownsHome ? match.home : match.away) : undefined;
  const opponentSide = participant ? (ownsHome ? match.away : match.home) : undefined;
  const opponentBuild = opponentSide && teamBuild ? teamBuild(opponentSide.teamId) : undefined;
  return {
    ...match,
    home: sideWithoutDiscordId(match.home),
    ...(match.away ? { away: sideWithoutDiscordId(match.away) } : {}),
    matchId: match.id,
    statusRevision: match.revision,
    round: match.roundNumber,
    scheduledAt: match.createdAt,
    ...(mySide ? { myTeamId: mySide.teamId } : {}),
    ...(opponentSide ? {
      opponentTeamId: opponentSide.teamId,
      opponentCoach: opponentSide.coach.ffbCoachId,
      ...(stringField(opponentBuild, "teamName") ? { opponentTeamName: stringField(opponentBuild, "teamName") } : {}),
      ...(stringField(opponentBuild, "logoUrl") ? { opponentLogoUrl: stringField(opponentBuild, "logoUrl") } : {}),
    } : {}),
    canLaunch: participant && match.away !== undefined && (match.status === "scheduled" || match.status === "launch_failed"),
    waitingCoachIds,
    routeMetadata: {
      challenge: match.launch.challengePath,
      matchstatus: "/api/fork/matchstatus",
      cancel: "/api/fork/cancel",
      jnlp: match.launch.jnlpPath,
    },
    ...(participant ? { waiting: waitingCoachIds.some((coach) => coachKey(coach) === coachKey(auth!.coach)) } : {}),
    ...(participant && match.away ? {
      challenger: {
        challenge: {
          path: match.launch.challengePath,
          coach: auth!.coach,
          teamId: coachKey(match.home.coach.ffbCoachId) === coachKey(auth!.coach) ? match.home.teamId : match.away.teamId,
          opponent: opponent(match, auth!.coach)?.ffbCoachId,
        },
        jnlpPath: match.launch.jnlpPath,
      },
    } : {}),
  };
}

function clientTournament(
  tournament: TournamentRecord,
  entrants: TournamentEntrantRecord[],
  auth?: TournamentApiIdentity,
) {
  const { startsAt, endsAt, bannerPath: _bannerPath, news, ...record } = tournament;
  const banner = bannerUrl(tournament);
  const ownEntrant = auth
    ? entrants.find((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(auth.coach))
    : undefined;
  return {
    ...record,
    turnTimer: tournament.turnTimer ?? DEFAULT_TOURNAMENT_TURN_TIMER,
    inducementOptIns: tournament.inducementOptIns ?? [],
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(banner ? { bannerUrl: banner } : {}),
    ...(news?.length ? { news: orderedNews(news) } : {}),
    ...(tournamentOwner(tournament) ? { ownerCoachId: tournamentOwner(tournament) } : {}),
    organizerCoachIds: tournament.organizerCoachIds ?? [],
    pairingSystem: tournament.pairingSystem ?? "eloSeeded",
    seedingMode: tournament.seedingMode ?? "elo",
    remainingRounds: tournament.status === "completed" || tournament.status === "cancelled"
      ? 0
      : Math.max(0, tournament.roundCount - tournament.currentRound),
    ...(tournament.packageName.trim() ? { rulesetPackName: tournament.packageName } : {}),
    entrantCount: entrants.filter((entrant) => entrant.droppedAt === undefined).length,
    ...(ownEntrant ? { myEntrantId: ownEntrant.id, myDroppedAt: ownEntrant.droppedAt } : {}),
  };
}

function projectedOpponent(
  store: TournamentStore,
  tournamentId: string,
  auth: TournamentApiIdentity,
): TournamentApiResult {
  const tournament = store.tournament(tournamentId);
  if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
  const entrants = store.entrants(tournamentId);
  const entrant = entrants.find((candidate) => coachKey(candidate.coach.ffbCoachId) === coachKey(auth.coach));
  if (!entrant) return { status: 403, body: { error: "You are not entered in this tournament." } };
  const matches = store.matches(tournamentId);
  const confirmed = [...matches].reverse().find((match) => match.status !== "completed" &&
    (match.home.entrantId === entrant.id || match.away?.entrantId === entrant.id));
  if (confirmed) {
    const other = confirmed.home.entrantId === entrant.id ? confirmed.away : confirmed.home;
    return {
      status: 200,
      body: {
        tournamentId,
        entrantId: entrant.id,
        roundNumber: confirmed.roundNumber,
        provisional: false,
        scheduledMatchId: confirmed.id,
        opponent: other ? { entrantId: other.entrantId, coachId: other.coach.ffbCoachId, teamId: other.teamId } : null,
      },
    };
  }
  const pair = generateTournamentPairings(
    tournament.format,
    tournament.currentRound + 1,
    entrants,
    matches,
    tournament.points,
    tournament.tiebreakers,
    { system: tournament.pairingSystem ?? "eloSeeded", eligible: (candidate) => candidate.flags?.active !== false },
  )
    .find((candidate) => candidate.homeEntrantId === entrant.id || candidate.awayEntrantId === entrant.id);
  if (!pair) return { status: 200, body: { tournamentId, entrantId: entrant.id, provisional: true, opponent: null } };
  const otherId = pair.homeEntrantId === entrant.id ? pair.awayEntrantId : pair.homeEntrantId;
  const other = otherId ? entrants.find((candidate) => candidate.id === otherId) : undefined;
  return {
    status: 200,
    body: {
      tournamentId,
      entrantId: entrant.id,
      roundNumber: tournament.currentRound + 1,
      provisional: true,
      opponent: other ? { entrantId: other.id, coachId: other.coach.ffbCoachId, teamId: other.teamId } : null,
    },
  };
}

// ---- notification hooks: called after a mutation succeeded; a fault here never changes the response ----

function sharedOf(deps: TournamentApiDeps, viewer: TournamentApiIdentity, entrant: TournamentEntrantRecord, tournamentId: string): SharedContact | undefined {
  try { return deps.sharing?.contact(viewer, entrant.coach.ffbCoachId, tournamentId); } catch { return undefined; }
}

/** Entrant id -> shared contact, for a manager's view (one batch read when the host offers it). */
function sharedMap(deps: TournamentApiDeps, viewer: TournamentApiIdentity, entrants: readonly TournamentEntrantRecord[], tournamentId: string): Map<string, SharedContact> {
  const out = new Map<string, SharedContact>();
  if (!deps.sharing || !entrants.length) return out;
  try {
    const list = deps.sharing.contacts
      ? deps.sharing.contacts(viewer, entrants.map((e) => e.coach.ffbCoachId), tournamentId)
      : entrants.map((e) => sharedOf(deps, viewer, e, tournamentId));
    entrants.forEach((e, i) => { const c = list[i]; if (c) out.set(e.id, c); });
  } catch { /* shared fields are best effort in the table */ }
  return out;
}

function quietly(fn: () => void): void {
  try { fn(); } catch { /* notifications are best effort */ }
}

const FLAG_WORDS: Record<keyof TournamentEntrantFlags, [on: string, off: string]> = {
  paid: ["Marked as paid", "Marked as not paid"],
  rosterVerified: ["Roster verified", "Roster marked invalid"],
  frozen: ["Roster frozen", "Roster unfrozen"],
  checkedIn: ["Checked in", "Check-in cleared"],
  active: ["Moved to active", "Moved to standby"],
};

function effectiveFlags(entrant: TournamentEntrantRecord | undefined): TournamentEntrantFlags {
  return { ...DEFAULT_ENTRANT_FLAGS, ...(entrant?.flags ?? {}) };
}

function notifyFlagChanges(deps: TournamentApiDeps, tournament: TournamentRecord, before: TournamentEntrantRecord | undefined, after: TournamentEntrantRecord, actor: string): void {
  if (!deps.notify) return;
  quietly(() => {
    const was = effectiveFlags(before);
    const now = effectiveFlags(after);
    const lines = (Object.keys(FLAG_WORDS) as Array<keyof TournamentEntrantFlags>)
      .filter((key) => was[key] !== now[key])
      .map((key) => FLAG_WORDS[key][now[key] ? 0 : 1]);
    if (!lines.length) return;
    deps.notify!.coach(after.coach.ffbCoachId, {
      type: "entrant-flag",
      title: `${tournament.name}: your entry was updated`,
      body: lines.join(". ") + ".",
      link: tournamentLink(tournament.id, "overview"),
      from: actor,
    });
  });
}

/** Entrants still invalid with problems after a roster check: tell each coach the count. */
function notifyRosterProblems(deps: TournamentApiDeps, tournament: TournamentRecord, entrants: readonly TournamentEntrantRecord[], actor: string): void {
  if (!deps.notify) return;
  quietly(() => {
    for (const entrant of entrants) {
      if (entrant.droppedAt !== undefined || entrant.flags?.rosterVerified) continue;
      const count = entrant.submission?.validation.problems.length ?? 0;
      if (count === 0) continue;
      deps.notify!.coach(entrant.coach.ffbCoachId, {
        type: "roster-problems",
        title: `${tournament.name}: your roster has ${count} ${count === 1 ? "problem" : "problems"}`,
        body: "The roster check found problems. Open the tournament to see them and resubmit, or ask an organiser.",
        link: tournamentLink(tournament.id, "overview"),
        from: actor,
      });
    }
  });
}

function notifyWithdrawal(deps: TournamentApiDeps, tournament: TournamentRecord, entrant: TournamentEntrantRecord, actor: string, selfDrop: boolean): void {
  if (!deps.notify) return;
  quietly(() => {
    if (selfDrop) {
      deps.notify!.managers(tournament.id, {
        type: "withdrawal",
        title: `${tournament.name}: ${entrant.coach.ffbCoachId} withdrew`,
        body: `${entrant.coach.ffbCoachId} withdrew from ${tournament.name}.`,
        link: tournamentLink(tournament.id, "manage"),
        from: actor,
      }, actor);
    } else {
      deps.notify!.coach(entrant.coach.ffbCoachId, {
        type: "withdrawal",
        title: `${tournament.name}: you were withdrawn`,
        body: `An organiser withdrew your entry from ${tournament.name}.`,
        link: tournamentLink(tournament.id, "overview"),
        from: actor,
      });
    }
  });
}

/** A new entry: the managers except the actor ("{coach} registered for {tournament}", flagged when not a NAF member);
 *  an organiser-made entry also asks the coach to choose what they share. */
function notifyRegistration(deps: TournamentApiDeps, tournament: TournamentRecord, entrant: TournamentEntrantRecord, actor: string): void {
  if (!deps.notify) return;
  quietly(() => {
    const coach = entrant.coach.ffbCoachId;
    const what = `${coach} registered for ${tournament.name}`;
    deps.notify!.managers(tournament.id, {
      type: "registration",
      title: entrant.notNafMember ? `${what} — not a NAF member` : what,
      body: entrant.notNafMember ? `${what} and is not a NAF member.` : `${what}.`,
      link: tournamentLink(tournament.id, "manage"),
      from: actor,
    }, actor);
  });
  if (coachKey(entrant.coach.ffbCoachId) !== coachKey(actor)) {
    if (entrant.nafPending) notifyNafRequest(deps, tournament, entrant.coach.ffbCoachId, actor, true);
    else notifyShareRequest(deps, tournament, entrant.coach.ffbCoachId, actor, tournament.nafSanctioned === true && !entrant.nafNumber);
  }
}

/** nafShared: the entry's NAF details come from the coach's profile (NAF sanctioned), and the coach is told so. */
function notifyShareRequest(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string, nafShared = false): void {
  quietly(() => deps.notify?.coach(coach, {
    type: "share-request",
    title: `You were entered in ${tournament.name} — choose what to share`,
    body: "Choose what its organisers can see on your Account page, under Sharing."
      + (nafShared ? ` ${tournament.name} is NAF sanctioned: ${NAF_SHARED_SENTENCE}` : ""),
    link: "/app/account#sharing",
    from: actor,
  }));
}

/** What a coach is told when their profile NAF details go to a tournament's organisers (owner 10-31). */
export const NAF_SHARED_SENTENCE = "the NAF name and number on your profile are shared with its organisers.";

/** The coach owes a NAF answer (organiser-made entry, or the tournament became NAF sanctioned) and has no NAF details
 *  on their profile: add them (they then go to the organisers), or say "not a NAF member". One notice. */
function notifyNafRequest(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string, entered: boolean): void {
  quietly(() => deps.notify?.coach(coach, {
    type: "naf-request",
    title: entered ? `You were entered in ${tournament.name} — add your NAF details` : `${tournament.name} is NAF sanctioned — add your NAF details`,
    body: `${tournament.name} is NAF sanctioned. On the tournament page, add your NAF name and number to your profile `
      + "(they are shared with its organisers) or say you are not a NAF member; you cannot submit a roster until you do."
      + (entered ? " You can also choose what its organisers see under Account, Sharing." : ""),
    link: tournamentLink(tournament.id, "overview"),
    from: actor,
  }));
}

/** The tournament became NAF sanctioned and the coach's profile has NAF details: they now go to its organisers. */
function notifyNafShared(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string): void {
  quietly(() => deps.notify?.coach(coach, {
    type: "naf-request",
    title: `${tournament.name} is NAF sanctioned — your NAF details are shared`,
    body: `${tournament.name} is NAF sanctioned: ${NAF_SHARED_SENTENCE} Change them on your Account page.`,
    link: "/app/account#identity",
    from: actor,
  }));
}

/** "{coach} registered for {tournament} and is not a NAF member" to the managers except the actor. */
function notifyNotNafMember(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string): void {
  quietly(() => {
    const what = `${coach} registered for ${tournament.name}`;
    deps.notify?.managers(tournament.id, {
      type: "registration", title: `${what} — not a NAF member`, body: `${what} and is not a NAF member.`,
      link: tournamentLink(tournament.id, "manage"), from: actor,
    }, actor);
  });
}

/** The coach's NAF answer from a request body (profile-first, owner 10-31): notNafMember: true, or the NAF details on
 *  their profile. A typed number is no longer taken from the coach: it goes on the profile (Account, or the inline form). */
function nafAnswer(input: Record<string, unknown>, profile: ProfileNaf | undefined): { notNafMember: true } | { fromProfile: true } | { error: string } {
  if (input.notNafMember !== undefined && typeof input.notNafMember !== "boolean") return { error: "notNafMember must be true or false." };
  if (input.notNafMember === true) return { notNafMember: true };
  return profile ? { fromProfile: true } : { error: NAF_REQUIRED_MESSAGE };
}

export const NAF_REQUIRED_MESSAGE = "NAF number required for this NAF-sanctioned tournament.";
export const NAF_EXPORT_UNSANCTIONED_MESSAGE = "The NAF export is only for NAF-sanctioned tournaments. Mark the tournament NAF sanctioned in Settings first.";

/** A coach's NAF details from their profile (identities.nafName / nafId): owner 10-31, the source of an entry's NAF
 *  name and number on a NAF-sanctioned tournament. nafChecked: the NAF coach page check still matches. undefined = no
 *  NAF number on the profile. */
export interface ProfileNaf { nafNumber: string; nafName?: string; nafChecked?: true }

export function profileNafOf(record: TournamentIdentityRecord | undefined): ProfileNaf | undefined {
  const nafNumber = canonicalNafId(record?.identities.nafId);
  if (!record || !nafNumber) return undefined;
  const nafName = record.identities.nafName?.trim();
  const check = record.connections?.naf;
  const checked = check !== undefined && check.nafId === record.identities.nafId && check.nafName === record.identities.nafName;
  return { nafNumber, ...(nafName ? { nafName } : {}), ...(checked ? { nafChecked: true as const } : {}) };
}

/** The profile NAF details of one coach (undefined when there is no lookup, no record or no number). */
function profileNaf(deps: Pick<TournamentApiDeps, "identityRecord">, coach: string): ProfileNaf | undefined {
  try { return profileNafOf(deps.identityRecord?.(coach)); } catch { return undefined; }
}

/** The same for many coaches, keyed by coachKey (one identities read when the host offers identityRecords). */
function profileNafs(deps: Pick<TournamentApiDeps, "identityRecord" | "identityRecords">, coaches: readonly string[]): Map<string, ProfileNaf> {
  const out = new Map<string, ProfileNaf>();
  const unique = [...new Map(coaches.map((c) => [coachKey(c), c])).values()];
  if (!unique.length) return out;
  let records: Array<TournamentIdentityRecord | undefined>;
  try {
    records = deps.identityRecords
      ? deps.identityRecords(unique)
      : unique.map((c) => { try { return deps.identityRecord?.(c); } catch { return undefined; } });
  } catch { return out; }
  unique.forEach((c, i) => { const naf = profileNafOf(records[i]); if (naf) out.set(coachKey(c), naf); });
  return out;
}

/** What an entry tells the coach and the managers about NAF: on a sanctioned tournament the coach's current profile
 *  details win (a change or unlink shows at once); otherwise, or with none on the profile, the number stored with the
 *  entry (older self-entries, organiser-made entries). "Not a NAF member" shows none. */
export function entryNaf(tournament: Pick<TournamentRecord, "nafSanctioned">, entrant: TournamentEntrantRecord, profile: ProfileNaf | undefined): ProfileNaf | undefined {
  if (entrant.notNafMember) return undefined;
  if (tournament.nafSanctioned === true && profile) return profile;
  return entrant.nafNumber ? { nafNumber: entrant.nafNumber } : undefined;
}

/** An entry as a response shows it: the frozen NAF details are for the NAF report only. */
function withoutNafSnapshot(entrant: TournamentEntrantRecord): Omit<TournamentEntrantRecord, "nafSnapshot"> {
  const { nafSnapshot: _nafSnapshot, ...shown } = entrant;
  return shown;
}

const nafFields = (naf: ProfileNaf | undefined) => (naf
  ? { nafNumber: naf.nafNumber, ...(naf.nafName ? { nafName: naf.nafName } : {}), ...(naf.nafChecked ? { nafChecked: true as const } : {}) }
  : {});

/** Derived, not just the stored flag (review P2): an active entry of a NAF-sanctioned tournament with no NAF details on
 *  the coach's profile, no number stored with the entry and no "not a NAF member" owes its NAF answer, however it got
 *  that way (including a coach who later removed their profile NAF details). */
export function nafOwed(tournament: Pick<TournamentRecord, "nafSanctioned">, entrant: TournamentEntrantRecord, profile?: ProfileNaf): boolean {
  return tournament.nafSanctioned === true && entrant.droppedAt === undefined && !entrant.nafNumber && !entrant.notNafMember && !profile;
}

/**
 * Startup migration (idempotent): entries of draft / active NAF-sanctioned tournaments that owe their NAF answer but are
 * not marked yet (written before nafPending existed, or by another writer) are marked nafPending and each coach gets the
 * naf-request notice once. The mark is the guard: a restart finds them marked and notifies nobody again. Reads never
 * write; they derive (nafOwed). Returns how many entries were marked.
 */
export function settleNafOwedEntries(deps: Pick<TournamentApiDeps, "store" | "notify" | "identityRecord" | "identityRecords">): number {
  let count = 0;
  for (const tournament of deps.store.tournaments(["draft", "active"])) {
    if (!tournament.nafSanctioned) continue;
    const entrants = deps.store.entrants(tournament.id);
    const profiles = profileNafs(deps, entrants.map((e) => e.coach.ffbCoachId));
    const unmarked = entrants.filter((e) => nafOwed(tournament, e, profiles.get(coachKey(e.coach.ffbCoachId))) && !e.nafPending);
    if (!unmarked.length) continue;
    const marked = deps.store.markNafPending(tournament.id, unmarked.map((e) => e.id));
    for (const e of unmarked) if (marked.includes(e.id)) notifyNafRequest(deps as TournamentApiDeps, tournament, e.coach.ffbCoachId, "", false);
    count += marked.length;
  }
  return count;
}

function notifyFixtures(deps: TournamentApiDeps, tournament: TournamentRecord, matches: readonly ScheduledMatchRecord[], actor: string): void {
  if (!deps.notify) return;
  quietly(() => {
    const link = tournamentLink(tournament.id, "rounds");
    for (const match of matches) {
      const title = `${tournament.name}: round ${match.roundNumber} fixture`;
      if (!match.away) {
        deps.notify!.coach(match.home.coach.ffbCoachId, { type: "fixture-created", title, body: `You have a bye in round ${match.roundNumber}.`, link, from: actor });
        continue;
      }
      deps.notify!.coach(match.home.coach.ffbCoachId, { type: "fixture-created", title, body: `You play ${match.away.coach.ffbCoachId} in round ${match.roundNumber}.`, link, from: actor });
      deps.notify!.coach(match.away.coach.ffbCoachId, { type: "fixture-created", title, body: `You play ${match.home.coach.ffbCoachId} in round ${match.roundNumber}.`, link, from: actor });
    }
  });
}

function notifyResult(deps: TournamentApiDeps, match: ScheduledMatchRecord, actor: string): void {
  if (!deps.notify || !match.result || !match.away) return;
  quietly(() => {
    const name = deps.store.tournament(match.tournamentId)?.name ?? "Tournament";
    const body = `${match.home.coach.ffbCoachId} ${match.result!.homeScore} - ${match.result!.awayScore} ${match.away!.coach.ffbCoachId} (round ${match.roundNumber}).`;
    const input = { type: "result-confirmed" as const, title: `${name}: result confirmed`, body, link: tournamentLink(match.tournamentId, "rounds"), from: actor };
    deps.notify!.coach(match.home.coach.ffbCoachId, input);
    deps.notify!.coach(match.away!.coach.ffbCoachId, input);
  });
}

export async function tournamentApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: TournamentApiIdentity | undefined,
  body: unknown,
  deps: TournamentApiDeps,
): Promise<TournamentApiResult | undefined> {
  const portalListAlias = path === "/api/tournaments";
  // `/api/fork/tournaments` is the Tauri-facing spelling; keep the shorter portal spelling too.
  path = path.replace(/^\/api\/fork\/tournaments(?=\/|$)/, "/api/tournaments");
  const now = deps.now?.() ?? new Date();
  try {
    if (path === "/api/tournaments" && method === "POST") {
      const identity = authenticated(auth);
      if (!identity.organizer) return { status: 403, body: { error: "Organizer access required." } };
      const input = jsonObject(body);
      if (typeof input.name !== "string" || !input.name.trim())
        return { status: 400, body: { error: "name is required." } };
      const name = input.name.trim();
      if (name.length > 100) return { status: 400, body: { error: "name must be at most 100 characters." } };
      if (typeof input.packageName !== "string" || !input.packageName.trim())
        return { status: 400, body: { error: "packageName is required." } };
      const packageName = input.packageName.trim();
      if (deps.packageExists?.(packageName) !== true)
        return { status: 400, body: { error: "Unknown tournament rules package." } };
      const maxPlayers = integer(input.maxPlayers, "maxPlayers");
      if (maxPlayers < 2) return { status: 400, body: { error: "maxPlayers must be at least 2." } };
      if (!(input.format === "swiss" || input.format === "roundRobin" || input.format === "knockout"))
        return { status: 400, body: { error: "format must be swiss, roundRobin, or knockout." } };
      const roundCount = input.roundCount === undefined ? undefined : requestedRoundCount(input.roundCount);
      if (roundCount !== undefined && input.format !== "swiss")
        return { status: 400, body: { error: "roundCount can be set only for Swiss tournaments." } };
      const chosenTiebreaker = input.primaryTiebreaker === undefined
        ? "buchholz"
        : primaryTiebreaker(input.primaryTiebreaker);
      if (input.nafSanctioned !== undefined && typeof input.nafSanctioned !== "boolean")
        return { status: 400, body: { error: "nafSanctioned must be true or false." } };
      // Create inside a Tournament Series (phase 5): only that series' organisers (or an admin); the new tournament takes
      // the series seeding as its pairing default (store.createTournament).
      let seriesId: string | undefined;
      if (input.seriesId !== undefined && input.seriesId !== null && input.seriesId !== "") {
        if (typeof input.seriesId !== "string") return { status: 400, body: { error: "seriesId must be a series id." } };
        const series = deps.store.seriesRecord(input.seriesId);
        if (!series) return { status: 404, body: { error: "Series not found." } };
        if (!canEditSeries(series, identity)) return { status: 403, body: { error: "You are not this series' organiser." } };
        seriesId = series.id;
      }
      return {
        status: 201,
        body: {
          tournament: deps.store.createTournament({
            name,
            packageName,
            maxPlayers,
            format: input.format,
            organizerCoachId: identity.coach,
            primaryTiebreaker: chosenTiebreaker,
            ...(roundCount === undefined ? {} : { roundCount }),
            ...(input.nafSanctioned === true ? { nafSanctioned: true } : {}),
            ...(seriesId ? { seriesId } : {}),
          }, now),
        },
      };
    }

    // Statistics, Honours and Awards (src/tournaments/honours.ts): public reads, organiser/admin award writes.
    const honours = tournamentHonoursRoutes(method, path, query, auth, body, deps);
    if (honours) return honours;
    if (path === "/api/tournaments" && method === "GET" && query.get("awards") === "mine") {
      return { status: 200, headers: { "cache-control": "private, no-store" }, body: { awards: auth ? myTournamentAwards(deps.store, auth.coach, deps.teamBuild, auth) : [] } };
    }

    if (path === "/api/tournaments" && method === "GET") {
      const category = query.get("category");
      const source = category === "active"
        ? deps.store.tournaments(["active"])
        : category === "future"
          ? deps.store.tournaments(["draft"])
          : category === "finished"
            ? deps.store.tournaments(["completed"])
            : query.get("status") === "draft"
              ? deps.store.tournaments(["draft"])
              : query.get("status") === "completed"
                ? deps.store.tournaments(["completed"])
                : query.get("status") === "cancelled"
                  ? deps.store.tournaments(["cancelled"])
                  : query.get("status") === "all"
                    ? deps.store.tournaments(["draft", "active", "completed", "cancelled"])
                    : deps.store.activeTournaments();
      const nameQuery = query.get("q")?.trim().toLowerCase();
      let filtered = nameQuery
        ? source.filter((tournament) => tournament.name.toLowerCase().includes(nameQuery))
        : source;
      // apps/tauri/src/game/tournamentApi.ts:145 hard-rejects non-Swiss items AND one bad item
      // throws the whole list. The client resolves ForkApi.get('tournaments') to the FORK
      // spelling (forkChallenge.ts builds `/api/fork/${path}`), so path alone cannot identify
      // the portal — key on its dialect instead: only the portal sends `category=`. The web
      // tournaments.js uses `status=`/bare and keeps seeing all formats. Lift when the client widens.
      if (portalListAlias || query.get("category") !== null) {
        filtered = filtered.filter((tournament) => tournament.format === "swiss");
      }
      // ?coach=me: only the signed-in coach's (not withdrawn) entries, most recent first (end, start, starting date,
      // last update), one page of up to `limit` (1-20, default 20). The coach page's nav trees read this.
      if (query.get("coach") === "me") {
        const me = coachKey(authenticated(auth).coach);
        const recency = (t: TournamentRecord) => t.endsAt ?? t.startedAt ?? t.startsAt ?? t.updatedAt ?? "";
        const requestedLimit = Number(query.get("limit"));
        const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 1 ? Math.min(requestedLimit, TOURNAMENT_PAGE_SIZE) : TOURNAMENT_PAGE_SIZE;
        const mine = filtered
          .filter((t) => deps.store.entrants(t.id).some((e) => !e.droppedAt && coachKey(e.coach.ffbCoachId) === me))
          .sort((a, b) => recency(b).localeCompare(recency(a)) || a.id.localeCompare(b.id));
        return {
          status: 200,
          body: {
            tournaments: mine.slice(0, limit).map((tournament) => clientTournament(tournament, deps.store.entrants(tournament.id), auth)),
            page: 1,
            pageSize: limit,
            total: mine.length,
            hasMore: mine.length > limit,
          },
        };
      }
      const requestedPage = Number(query.get("page"));
      const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
      const total = filtered.length;
      const offset = (page - 1) * TOURNAMENT_PAGE_SIZE;
      const tournaments = filtered
        .slice(offset, offset + TOURNAMENT_PAGE_SIZE)
        .map((tournament) => {
          // The list stays light: news, summary and notes are read from the detail route.
          const { news: _news, summary: _summary, notes: _notes, ...item } = clientTournament(tournament, deps.store.entrants(tournament.id), auth);
          return item;
        });
      return {
        status: 200,
        body: {
          tournaments,
          page,
          pageSize: TOURNAMENT_PAGE_SIZE,
          total,
          hasMore: offset + TOURNAMENT_PAGE_SIZE < total,
        },
      };
    }

    // ---- v4 routes: submissions, roles, roster lock, start, participant edit ----

    const submissionMatch = path.match(/^\/api\/tournaments\/([^/]+)\/submissions$/);
    if (submissionMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(submissionMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      const input = jsonObject(body);
      const saveId = typeof input.saveId === "string" ? input.saveId.trim() : "";
      if (!saveId || saveId.length > 120 || !SUBMISSION_REF.test(saveId))
        return { status: 400, body: { error: "saveId must name a Team Builder save (save:<id>) or a library team (library:<teamId>)." } };
      const entrant = entrantByCoach(deps.store.entrants(tournament.id), identity.coach);
      if (!entrant || entrant.droppedAt) return { status: 403, body: { error: "You are not entered in this tournament." } };
      // NAF stays non-optional (owner 10-31): an entry still owing its NAF answer cannot submit a roster.
      if (tournament.nafSanctioned && nafOwed(tournament, entrant, profileNaf(deps, entrant.coach.ffbCoachId))) return { status: 400, body: { error: NAF_REQUIRED_MESSAGE } };
      if (tournament.rostersLockedAt || entrant.flags?.frozen)
        return { status: 409, body: { error: "Rosters are locked; ask an organiser to unlock them before resubmitting." } };
      if (!deps.validateSubmission) return { status: 503, body: { error: "Team validation is unavailable on this host." } };
      const check = deps.validateSubmission(entrant.coach.ffbCoachId, saveId, tournament.packageName, now);
      if ("error" in check) return { status: check.status ?? 400, body: { error: check.error } };
      const updated = deps.store.submitTeam(tournament.id, entrant.id, check, now);
      return {
        status: 201,
        body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, tournament.nafSanctioned ? profileNaf(deps, updated.coach.ffbCoachId) : undefined), submission: submissionView(updated, true) },
      };
    }

    const ownerMatch = path.match(/^\/api\/tournaments\/([^/]+)\/owner$/);
    if (ownerMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(ownerMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentOwner(tournament, identity);
      const input = jsonObject(body);
      const coach = registeredCoach(deps, input.coachId);
      const updated = deps.store.setOwner(tournament.id, coach, now);
      return { status: 200, body: { tournament: clientTournament(updated, deps.store.entrants(updated.id), auth) } };
    }

    const organizerMatch = path.match(/^\/api\/tournaments\/([^/]+)\/organizers\/([^/]+)$/);
    if (organizerMatch && (method === "POST" || method === "DELETE")) {
      const identity = authenticated(auth);
      const tournamentId = decoded(organizerMatch[1]!);
      const coachId = decoded(organizerMatch[2]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament || coachId === undefined) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentOwner(tournament, identity);
      const updated = method === "POST"
        ? deps.store.addOrganizer(tournament.id, registeredCoach(deps, coachId), now)
        : deps.store.removeOrganizer(tournament.id, coachId, now);
      return { status: 200, body: { tournament: clientTournament(updated, deps.store.entrants(updated.id), auth) } };
    }

    const lockMatch = path.match(/^\/api\/tournaments\/([^/]+)\/(lock|unlock)-rosters$/);
    if (lockMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(lockMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      if (lockMatch[2] === "unlock") {
        const updated = deps.store.unlockRosters(tournament.id, now);
        return { status: 200, body: { tournament: clientTournament(updated, deps.store.entrants(updated.id), auth) } };
      }
      if (tournament.rostersLockedAt) return { status: 409, body: { error: "Rosters are already locked." } };
      const entrants = deps.store.lockRosters(tournament.id, rosterChecks(tournament, deps.store.entrants(tournament.id), deps, now), now);
      const updated = deps.store.tournament(tournament.id)!;
      notifyRosterProblems(deps, updated, entrants, identity.coach);
      return {
        status: 200,
        body: {
          tournament: clientTournament(updated, entrants, auth),
          validation: validationTable(entrants, deps),
        },
      };
    }

    const startMatch = path.match(/^\/api\/tournaments\/([^/]+)\/start$/);
    if (startMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(startMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const input = body === undefined || body === null ? {} : jsonObject(body);
      if (input.force !== undefined && typeof input.force !== "boolean")
        return { status: 400, body: { error: "force must be true or false." } };
      const checks = tournament.rostersLockedAt
        ? undefined
        : rosterChecks(tournament, deps.store.entrants(tournament.id), deps, now);
      const packageRevision = deps.packageRevision?.(tournament.packageName);
      const result = deps.store.startTournament(tournament.id, {
        force: input.force === true,
        ...(checks ? { checks } : {}),
        ...(packageRevision ? { packageRevision } : {}),
      }, now);
      const validation = validationTable(result.entrants, deps);
      if (checks) notifyRosterProblems(deps, result.tournament, result.entrants, identity.coach);
      if (!result.started) {
        return {
          status: 409,
          body: {
            error: `${result.invalid.length} ${result.invalid.length === 1 ? "roster is" : "rosters are"} not valid. Fix them, verify them by hand, or start anyway.`,
            problems: validation.filter((row) => !row.valid),
            validation,
          },
        };
      }
      return { status: 200, body: { tournament: clientTournament(result.tournament, result.entrants, auth), validation } };
    }

    const entrantPatchMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)$/);
    if (entrantPatchMatch && method === "PATCH") {
      const identity = authenticated(auth);
      const tournamentId = decoded(entrantPatchMatch[1]!);
      const entrantId = decoded(entrantPatchMatch[2]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament || !entrantId) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const input = jsonObject(body);
      const flags: Record<string, unknown> = input.flags === undefined ? {} : { ...jsonObject(input.flags) };
      if (input.paid !== undefined) flags.paid = input.paid;
      if (input.manualSeed !== undefined && input.manualSeed !== null && !Number.isSafeInteger(input.manualSeed))
        return { status: 400, body: { error: "manualSeed must be a whole number or null." } };
      const before = deps.store.entrants(tournament.id).find((candidate) => candidate.id === entrantId);
      const updated = deps.store.updateEntrant(tournament.id, entrantId, {
        flags: flags as Partial<TournamentEntrantFlags>,
        ...(input.manualSeed === undefined ? {} : { manualSeed: input.manualSeed as number | null }),
      }, now);
      notifyFlagChanges(deps, tournament, before, updated, identity.coach);
      return { status: 200, body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, tournament.nafSanctioned && updated.droppedAt === undefined ? profileNaf(deps, updated.coach.ffbCoachId) : undefined) } };
    }

    const entrantCollectionMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants$/);
    if (entrantCollectionMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(entrantCollectionMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const input = jsonObject(body);
      if (typeof input.teamId !== "string" || !input.teamId.trim())
        return { status: 400, body: { error: "teamId is required." } };
      const requestedCoach = input.coach;
      if (requestedCoach !== undefined && (typeof requestedCoach !== "string" || !requestedCoach.trim()))
        return { status: 400, body: { error: "coach must be a non-empty string." } };
      const targetCoach = typeof requestedCoach === "string" ? requestedCoach.trim() : identity.coach;
      const self = coachKey(targetCoach) === coachKey(identity.coach);
      const tournament = deps.store.tournament(tournamentId);
      if (!self) {
        if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
        requireTournamentManager(tournament, identity);
      }
      // Share picker (owner 10-31): only the coach chooses; an organiser-made entry carries no grant.
      let share: ShareField[] = [];
      if (input.share !== undefined) {
        if (!self) return { status: 400, body: { error: "Only the coach can choose what they share." } };
        try { share = parseShareFields(input.share); } catch (e) { return { status: 400, body: { error: (e as ContactValidationError).message } }; }
      }
      // NAF (owner 10-31, profile-first): on a NAF-sanctioned tournament the coach's profile NAF name and number go to the
      // organisers with the entry (derived on read, nothing copied), else the coach says "not a NAF member". A number the
      // coach types is not taken there (it belongs on the profile); elsewhere it stays optional and format-checked.
      if (input.notNafMember !== undefined && typeof input.notNafMember !== "boolean")
        return { status: 400, body: { error: "notNafMember must be true or false." } };
      if (input.nafNumber !== undefined && input.nafNumber !== null && typeof input.nafNumber !== "string")
        return { status: 400, body: { error: "NAF number must be 1 to 10 digits." } };
      const sanctioned = tournament?.nafSanctioned === true;
      const notNafMember = sanctioned && input.notNafMember === true;
      const typedNaf = typeof input.nafNumber === "string" ? input.nafNumber.trim() : "";
      const parsedNaf = typedNaf && !notNafMember ? canonicalNafId(typedNaf) : undefined;
      if (typedNaf && !notNafMember && !parsedNaf) return { status: 400, body: { error: "NAF number must be 1 to 10 digits." } };
      const nafNumber = sanctioned && self ? undefined : parsedNaf;
      const profile = sanctioned ? profileNaf(deps, targetCoach) : undefined;
      if (sanctioned && self && !notNafMember && !profile) return { status: 400, body: { error: NAF_REQUIRED_MESSAGE } };
      // An organiser may enter a coach without it, but only the coach says "not a NAF member": the entry owes the answer.
      const nafPending = sanctioned && !self && !nafNumber && !profile;
      const teamId = input.teamId.trim();
      const owner = deps.teamOwner?.(teamId);
      if (!owner || coachKey(owner) !== coachKey(targetCoach))
        return { status: 400, body: { error: "Team is not owned by the target coach." } };
      const entrant = deps.store.registerEntrant(tournamentId, {
        coachId: targetCoach,
        ffbCoachId: targetCoach,
        verifiedAt: now.toISOString(),
      }, teamId, now, {
        ...(nafNumber ? { nafNumber } : {}),
        ...(notNafMember && self ? { notNafMember: true } : {}),
        ...(nafPending ? { nafPending: true } : {}),
      });
      const registeredIn = deps.store.tournament(tournamentId);
      let sharingSaved = true;
      if (self && deps.sharing && registeredIn) {
        try { deps.sharing.grant(entrant.coach.ffbCoachId, `tournament:${registeredIn.id}`, share, now); } catch { sharingSaved = false; }
      }
      if (registeredIn) {
        notifyRegistration(deps, registeredIn, entrant, identity.coach);
        // The entry stands; a grant that could not be stored is asked again (Account -> Sharing).
        if (!sharingSaved) notifyShareRequest(deps, registeredIn, entrant.coach.ffbCoachId, identity.coach);
      }
      return { status: 201, body: { entrant, ...(sharingSaved ? {} : { sharingSaved: false }) } };
    }

    const entrantItemMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)$/);
    if (entrantItemMatch && method === "DELETE") {
      const identity = authenticated(auth);
      const tournamentId = decoded(entrantItemMatch[1]!);
      const entrantId = decoded(entrantItemMatch[2]!);
      if (!tournamentId || !entrantId) return { status: 400, body: { error: "Invalid tournament entrant path." } };
      const tournament = deps.store.tournament(tournamentId);
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      const entrant = deps.store.entrants(tournamentId).find((candidate) => candidate.id === entrantId);
      if (!entrant) return { status: 404, body: { error: "Tournament entrant not found." } };
      const selfDrop = coachKey(entrant.coach.ffbCoachId) === coachKey(identity.coach);
      if (!selfDrop) requireTournamentManager(tournament, identity);
      // NAF sanctioned: the coach agreed to share their NAF details by entering, and the NAF report must carry every game
      // they played, so the details at withdrawal (profile, else the entry's number) are frozen onto the entry.
      const snapshot = tournament.nafSanctioned && entrant.droppedAt === undefined
        ? entryNaf(tournament, entrant, profileNaf(deps, entrant.coach.ffbCoachId))
        : undefined;
      const dropped = deps.store.dropEntrant(tournamentId, entrantId, identity.coach, !selfDrop, now,
        snapshot ? { nafNumber: snapshot.nafNumber, ...(snapshot.nafName ? { nafName: snapshot.nafName } : {}) } : undefined);
      // Only the drop itself notifies: a repeated DELETE of an already-withdrawn entry sends nothing.
      if (entrant.droppedAt === undefined && dropped.droppedAt !== undefined) notifyWithdrawal(deps, tournament, entrant, identity.coach, selfDrop);
      return {
        status: 200,
        body: { entrant: withoutNafSnapshot(dropped) },
      };
    }

    const newsMatch = path.match(/^\/api\/tournaments\/([^/]+)\/news(?:\/([^/]+))?$/);
    if (newsMatch && (method === "POST" || method === "PATCH" || method === "DELETE")) {
      const identity = authenticated(auth);
      const tournamentId = decoded(newsMatch[1]!);
      const newsId = newsMatch[2] === undefined ? undefined : decoded(newsMatch[2]);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      if (method === "POST") {
        if (newsMatch[2] !== undefined) return { status: 405, body: { error: "POST to /news to add a post." } };
        const post = deps.store.addNews(tournament.id, newNewsPost(parseNewsInput(jsonObject(body), false), identity.coach, now), NEWS_MAX_POSTS, now);
        // Entrants hear about new news (type tournament-news); the author is excluded like other hooks.
        deps.notify?.entrants(tournament.id, "tournament-news", post.title, post.body, tournamentLink(tournament.id, "overview"), identity.coach, identity.coach);
        return { status: 201, body: { post, news: orderedNews(deps.store.tournament(tournament.id)?.news) } };
      }
      if (!newsId) return { status: 404, body: { error: "News post not found." } };
      if (method === "PATCH") {
        const post = deps.store.updateNews(tournament.id, newsId, parseNewsInput(jsonObject(body), true), now);
        return { status: 200, body: { post, news: orderedNews(deps.store.tournament(tournament.id)?.news) } };
      }
      deps.store.deleteNews(tournament.id, newsId, now);
      return { status: 200, body: { news: orderedNews(deps.store.tournament(tournament.id)?.news) } };
    }

    const standingsMatch = path.match(/^\/api\/tournaments\/([^/]+)\/standings$/);
    if (standingsMatch && method === "GET") {
      const tournamentId = decoded(standingsMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      return { status: 200, body: { tournamentId, standings: deps.store.standings(tournamentId) } };
    }

    const detailMatch = path.match(/^\/api\/tournaments\/([^/]+)$/);
    if (detailMatch && method === "PATCH") {
      const identity = authenticated(auth);
      const tournamentId = decoded(detailMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const existing = deps.store.tournament(tournamentId);
      if (!existing) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(existing, identity);
      const input = jsonObject(body);
      // Tournament page fields are validated before anything is written, then applied after the core settings.
      const pagePatch = parsePagePatch(input);
      const hasPage = PAGE_FIELDS.some((field) => input[field] !== undefined);
      const patch: TournamentUpdate = {};
      if (input.organizerCoachId !== undefined) {
        if (!identity.admin)
          return { status: 403, body: { error: "Only an admin may change organizerCoachId." } };
        if (typeof input.organizerCoachId !== "string" || !input.organizerCoachId.trim())
          return { status: 400, body: { error: "organizerCoachId must be a non-empty string." } };
        patch.organizerCoachId = input.organizerCoachId;
      }
      if (input.maxPlayers !== undefined) patch.maxPlayers = integer(input.maxPlayers, "maxPlayers");
      if (input.format !== undefined) {
        if (!(input.format === "swiss" || input.format === "roundRobin" || input.format === "knockout"))
          return { status: 400, body: { error: "format must be swiss, roundRobin, or knockout." } };
        patch.format = input.format;
      }
      if (input.packageName !== undefined) {
        if (typeof input.packageName !== "string" || !input.packageName.trim())
          return { status: 400, body: { error: "packageName is required." } };
        const packageName = input.packageName.trim();
        if (deps.packageExists?.(packageName) !== true)
          return { status: 400, body: { error: "Unknown tournament rules package." } };
        patch.packageName = packageName;
      }
      if (input.startsAt !== undefined) {
        if (typeof input.startsAt !== "string")
          return { status: 400, body: { error: "startsAt must be a string." } };
        patch.startsAt = input.startsAt;
      }
      if (input.endsAt !== undefined) {
        if (typeof input.endsAt !== "string")
          return { status: 400, body: { error: "endsAt must be a string." } };
        patch.endsAt = input.endsAt;
      }
      if (input.pairingSystem !== undefined) {
        if (!TOURNAMENT_PAIRING_SYSTEMS.includes(input.pairingSystem as TournamentPairingSystem))
          return { status: 400, body: { error: "pairingSystem must be dutch, monrad or eloSeeded." } };
        patch.pairingSystem = input.pairingSystem as TournamentPairingSystem;
      }
      if (input.seedingMode !== undefined) {
        if (!TOURNAMENT_SEEDING_MODES.includes(input.seedingMode as TournamentSeedingMode))
          return { status: 400, body: { error: "seedingMode must be elo or manual." } };
        patch.seedingMode = input.seedingMode as TournamentSeedingMode;
      }
      if (input.primaryTiebreaker !== undefined)
        patch.primaryTiebreaker = primaryTiebreaker(input.primaryTiebreaker);
      if (input.nafSanctioned !== undefined) {
        if (typeof input.nafSanctioned !== "boolean")
          return { status: 400, body: { error: "nafSanctioned must be true or false." } };
        patch.nafSanctioned = input.nafSanctioned;
      }
      if (input.roundCount !== undefined) patch.roundCount = requestedRoundCount(input.roundCount);
      if (input.turnTimer !== undefined) {
        const t = jsonObject(input.turnTimer);
        const current = existing.turnTimer ?? DEFAULT_TOURNAMENT_TURN_TIMER;
        const enforced = t.enforced === undefined ? current.enforced : t.enforced;
        if (enforced !== "off" && enforced !== "optional" && enforced !== "required")
          return { status: 400, body: { error: "turnTimer.enforced must be off, optional or required." } };
        patch.turnTimer = { enforced, seconds: t.seconds === undefined ? current.seconds : integer(t.seconds, "turnTimer.seconds") };
      }
      if (input.inducementOptIns !== undefined) {
        if (!Array.isArray(input.inducementOptIns) || input.inducementOptIns.some((k) => typeof k !== "string"))
          return { status: 400, body: { error: "inducementOptIns must be a list of inducement keys." } };
        const known = Object.entries(bb2025.inducements).filter(([, r]) => r.optIn).flatMap(([id, r]) => [id, r.wireName ?? id]);
        const bad = (input.inducementOptIns as string[]).find((k) => !known.includes(k.trim()));
        if (bad !== undefined) return { status: 400, body: { error: `"${bad}" is not an opt-in inducement.` } };
        patch.inducementOptIns = (input.inducementOptIns as string[]).map((k) => k.trim());
      }
      const coreKeys = Object.keys(input).filter((key) => !(PAGE_FIELDS as readonly string[]).includes(key));
      const pendingBefore = new Set(deps.store.entrants(tournamentId).filter((e) => e.nafPending).map((e) => e.id));
      const wasSanctioned = existing.nafSanctioned === true;
      let tournament = coreKeys.length || !hasPage ? deps.store.updateTournament(tournamentId, patch, now) : existing;
      if (patch.nafSanctioned === true && !wasSanctioned) {
        // Made NAF sanctioned with entries already in: one notice per coach, none to organisers. Every active entrant
        // whose profile NAF details now reach the organisers is told so (whatever the entry stored before); a newly
        // marked entry without them is asked to add them (or say "not a NAF member").
        const entries = deps.store.entrants(tournamentId).filter((e) => e.droppedAt === undefined);
        const profiles = profileNafs(deps, entries.map((e) => e.coach.ffbCoachId));
        for (const e of entries) {
          const shared = entryNaf(tournament, e, profiles.get(coachKey(e.coach.ffbCoachId)));
          if (shared && profiles.get(coachKey(e.coach.ffbCoachId)) === shared) notifyNafShared(deps, tournament, e.coach.ffbCoachId, identity.coach);
          else if (e.nafPending && !pendingBefore.has(e.id)) notifyNafRequest(deps, tournament, e.coach.ffbCoachId, identity.coach, false);
        }
      }
      if (hasPage) tournament = deps.store.updatePage(tournamentId, pagePatch, now);
      return {
        status: 200,
        body: { tournament: clientTournament(tournament, deps.store.entrants(tournamentId), auth) },
      };
    }

    const finishMatch = path.match(/^\/api\/tournaments\/([^/]+)\/finish$/);
    if (finishMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(finishMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const tournament = deps.store.tournament(tournamentId);
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      return { status: 200, body: { tournament: deps.store.finishTournament(tournamentId, now) } };
    }

    const exportMatch = path.match(/^\/api\/tournaments\/([^/]+)\/export$/);
    if (exportMatch && method === "GET") {
      const identity = authenticated(auth);
      const tournamentId = decoded(exportMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      // An omitted format intentionally defaults to JSON for browser/API convenience.
      const format = query.get("format") ?? "json";
      if (!(format === "json" || format === "csv" || format === "naf"))
        return { status: 400, body: { error: "format must be csv, json, or naf." } };
      const standings = deps.store.standings(tournament.id);
      const headers = {
        "content-disposition": `attachment; filename="${exportFilename(tournament.name, format)}"`,
      };
      if (format === "json") {
        return {
          status: 200,
          headers,
          body: {
            tournament,
            entrants: deps.store.entrants(tournament.id).map(withoutNafSnapshot),
            rounds: deps.store.rounds(tournament.id),
            standings,
            matches: deps.store.matches(tournament.id),
          },
        };
      }
      if (format === "naf") {
        // The NAF report carries coaches' NAF details: only a NAF-sanctioned tournament has them shared. Every completed
        // game is reported: active entrants from their profile, withdrawn ones from the details frozen when they left
        // (never the live profile); a withdrawn coach with none is reported empty and named in the warnings
        // (x-naf-export-warnings: how many; the XML carries them as comments).
        if (!tournament.nafSanctioned)
          return { status: 409, body: { error: NAF_EXPORT_UNSANCTIONED_MESSAGE } };
        if (!deps.identityRecord)
          return { status: 503, body: { error: "Canonical identity storage is unavailable." } };
        try {
          const report = renderNafTournamentReport({
            tournament,
            organizerCoachId: tournament.organizerCoachId ?? identity.coach,
            entrants: deps.store.entrants(tournament.id),
            matches: deps.store.matches(tournament.id),
            identityRecord: deps.identityRecord,
            teamBuild: deps.teamBuild,
          });
          return {
            status: 200,
            headers: { ...headers, ...(report.warnings.length ? { "x-naf-export-warnings": String(report.warnings.length) } : {}) },
            contentType: "application/xml; charset=utf-8",
            body: report.xml,
          };
        } catch (error) {
          if (error instanceof NafExportError)
            return { status: 400, body: { error: error.message, problems: error.problems } };
          throw error;
        }
      }
      const columns = ["rank", "coach", "team", "played", "W", "D", "L", "points", "tdDiff", "casDiff"];
      const rows = standings.map((row) => {
        const team = deps.teamBuild(row.teamId);
        return [
          row.rank,
          row.coachId,
          stringField(team, "teamName") ?? row.teamId,
          row.played,
          row.wins,
          row.draws,
          row.losses,
          row.points,
          row.touchdownDifferential,
          row.casualtyDifferential,
        ].map(csvCell).join(",");
      });
      return {
        status: 200,
        headers,
        contentType: "text/csv; charset=utf-8",
        body: [columns.join(","), ...rows].join("\r\n") + "\r\n",
      };
    }
    if (detailMatch && method === "GET") {
      const tournamentId = decoded(detailMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      const entrants = deps.store.entrants(tournament.id);
      const manager = canManage(tournament, auth);
      const shared = manager && auth ? sharedMap(deps, auth, entrants.filter((e) => e.droppedAt === undefined), tournament.id) : new Map<string, SharedContact>();
      // Profile NAF details (sanctioned only, active entries only, like /contact): every active entrant for a manager,
      // the coach's own otherwise; never public. A withdrawn entry shows only a number stored on the entry itself.
      const active = entrants.filter((e) => e.droppedAt === undefined);
      const profiles = tournament.nafSanctioned && auth
        ? profileNafs(deps, (manager ? active : active.filter((e) => coachKey(e.coach.ffbCoachId) === coachKey(auth.coach))).map((e) => e.coach.ffbCoachId))
        : new Map<string, ProfileNaf>();
      // Fixtures: organisers and this tournament's managers see all; an entrant sees every fixture of the event
      // (mine + all); another signed-in coach sees only fixtures they play in; anonymous visitors none.
      const entered = auth ? entrants.some((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(auth.coach)) : false;
      const scheduledMatches = auth
        ? deps.store.matches(tournament.id)
          .filter((match) => auth.organizer || manager || entered || isParticipant(match, auth.coach))
          .map((match) => auth.organizer || manager || isParticipant(match, auth.coach)
            ? clientMatch(deps.store, match, auth, now, deps.teamBuild)
            : publicMatch(match))
        : [];
      const series = seriesChip(deps.store, tournament);
      return {
        status: 200,
        body: {
          tournament: clientTournament(tournament, entrants, auth),
          ...(series ? { series } : {}),
          entrants: entrants.map((entrant) => clientEntrant(
            entrant,
            deps,
            manager || (auth !== undefined && coachKey(auth.coach) === coachKey(entrant.coach.ffbCoachId)),
            shared.get(entrant.id),
            tournament,
            entrant.droppedAt === undefined ? profiles.get(coachKey(entrant.coach.ffbCoachId)) : undefined,
          )),
          rounds: deps.store.rounds(tournament.id),
          standings: deps.store.standings(tournament.id),
          scheduledMatches,
          capabilities: {
            manage: manager,
            assignRoles: Boolean(auth && (auth.admin || (tournamentOwner(tournament) && coachKey(auth.coach) === coachKey(tournamentOwner(tournament)!)))),
          },
        },
      };
    }

    // The coach's NAF answer for their own entry on a NAF-sanctioned tournament (owner 10-31): { nafNumber } or
    // { notNafMember: true }. Clears nafPending; "not a NAF member" tells the managers (except the coach).
    const nafMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)\/naf$/);
    if (nafMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(nafMatch[1]!);
      const entrantId = decoded(nafMatch[2]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament || !entrantId) return { status: 404, body: { error: "Tournament not found." } };
      const entrant = deps.store.entrants(tournament.id).find((candidate) => candidate.id === entrantId);
      if (!entrant || entrant.droppedAt !== undefined) return { status: 404, body: { error: "No active entry with that id." } };
      if (coachKey(entrant.coach.ffbCoachId) !== coachKey(identity.coach)) return { status: 403, body: { error: "Only the coach answers for their entry." } };
      if (!tournament.nafSanctioned) return { status: 400, body: { error: "This tournament is not NAF sanctioned." } };
      const profile = profileNaf(deps, entrant.coach.ffbCoachId);
      const answer = nafAnswer(jsonObject(body), profile);
      if ("error" in answer) return { status: 400, body: { error: answer.error } };
      const updated = deps.store.answerNaf(tournament.id, entrant.id, answer, now);
      if (updated.notNafMember && !entrant.notNafMember) notifyNotNafMember(deps, tournament, updated.coach.ffbCoachId, identity.coach);
      return { status: 200, body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, profile) } };
    }

    // Organiser view of an entrant's shared contact (owner 10-31): the coach name plus only the fields the coach granted
    // this tournament; owners / organisers (and site admins) only, active entries only.
    const contactMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)\/contact$/);
    if (contactMatch && method === "GET") {
      const identity = authenticated(auth);
      const tournamentId = decoded(contactMatch[1]!);
      const entrantId = decoded(contactMatch[2]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament || !entrantId) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const entrant = deps.store.entrants(tournament.id).find((candidate) => candidate.id === entrantId);
      if (!entrant || entrant.droppedAt !== undefined) return { status: 404, body: { error: "No active entry with that id." } };
      const contact = sharedOf(deps, identity, entrant, tournament.id) ?? { coach: entrant.coach.ffbCoachId };
      return {
        status: 200,
        headers: { "cache-control": "private, no-store" },
        body: {
          contact,
          ...nafFields(entryNaf(tournament, entrant, tournament.nafSanctioned ? profileNaf(deps, entrant.coach.ffbCoachId) : undefined)),
          ...(entrant.notNafMember ? { notNafMember: true } : {}),
        },
      };
    }

    const buildMatch = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)\/build$/);
    if (buildMatch && method === "GET") {
      const identity = authenticated(auth);
      const tournamentId = decoded(buildMatch[1]!);
      const entrantId = decoded(buildMatch[2]!);
      const entrant = tournamentId && entrantId
        ? deps.store.entrants(tournamentId).find((candidate) => candidate.id === entrantId)
        : undefined;
      if (!entrant) return { status: 404, body: { error: "Tournament entrant not found." } };
      const buildTournament = deps.store.tournament(entrant.tournamentId);
      const self = coachKey(identity.coach) === coachKey(entrant.coach.ffbCoachId);
      const opponentNow = !self && buildTournament !== undefined && deps.store.matches(entrant.tournamentId).some((match) =>
        match.roundNumber === buildTournament.currentRound && match.away !== undefined && match.status !== "cancelled" &&
        ((match.home.entrantId === entrant.id && coachKey(match.away.coach.ffbCoachId) === coachKey(identity.coach)) ||
          (match.away.entrantId === entrant.id && coachKey(match.home.coach.ffbCoachId) === coachKey(identity.coach))));
      // Only THIS tournament's managers: the global organiser flag is not a licence to read every event's rosters.
      const manager = buildTournament !== undefined && canManage(buildTournament, identity);
      const mayRead = self || opponentNow || manager;
      if (!mayRead) return { status: 403, body: { error: "You may fetch only your own tournament build or your current opponent's." } };
      const team = deps.teamBuild(entrant.teamId);
      const submission = entrant.submission;
      if (!team && !submission?.snapshot) return { status: 404, body: { error: "Tournament team build not found." } };
      const view = submission?.snapshot && buildTournament
        ? deps.submissionTeamView?.(entrant.coach.ffbCoachId, submission, buildTournament.packageName)
        : undefined;
      return {
        status: 200,
        body: {
          tournamentId,
          entrantId,
          coachId: entrant.coach.ffbCoachId,
          ...(team ? { team } : {}),
          ...(submission ? {
            submission: {
              submittedAt: submission.submittedAt,
              ...(submission.teamName ? { teamName: submission.teamName } : {}),
              ...(submission.race ? { race: submission.race } : {}),
              valid: Boolean(entrant.flags?.rosterVerified),
              // The problems list is for the coach and the managers; the opponent sees validity only.
              ...(self || manager ? { problems: submission.validation.problems } : {}),
              ...(view ? { view } : {}),
            },
          } : {}),
          inert: true,
          capabilities: {
            editRoster: { available: false, reason: "Tournament builds are read-only snapshots." },
            retire: { available: false, reason: "Tournament builds remain attached to tournament history." },
            launchUnscheduled: { available: false, reason: "Launch is available only through a scheduled match." },
          },
        },
      };
    }

    const nextMatch = path.match(/^\/api\/tournaments\/([^/]+)\/next-opponent$/);
    if (nextMatch && method === "GET") {
      const tournamentId = decoded(nextMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      return projectedOpponent(deps.store, tournamentId, authenticated(auth));
    }

    const roundMatch = path.match(/^\/api\/tournaments\/([^/]+)\/rounds$/);
    if (roundMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(roundMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const tournament = deps.store.tournament(tournamentId);
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const input = body === undefined || body === null ? {} : jsonObject(body);
      if (input.pairingSystem !== undefined && !TOURNAMENT_PAIRING_SYSTEMS.includes(input.pairingSystem as TournamentPairingSystem))
        return { status: 400, body: { error: "pairingSystem must be dutch, monrad or eloSeeded." } };
      if (input.seedingMode !== undefined && !TOURNAMENT_SEEDING_MODES.includes(input.seedingMode as TournamentSeedingMode))
        return { status: 400, body: { error: "seedingMode must be elo or manual." } };
      const options = {
        ...(input.pairingSystem === undefined ? {} : { pairingSystem: input.pairingSystem as TournamentPairingSystem }),
        ...(input.seedingMode === undefined ? {} : { seedingMode: input.seedingMode as TournamentSeedingMode }),
      };
      if (input.preview === true) {
        if (tournament.status !== "draft" && tournament.status !== "active")
          return { status: 409, body: { error: "This tournament is closed." } };
        const preview = deps.store.previewNextRound(tournamentId, options, deps.coachRating);
        return {
          status: 200,
          body: {
            preview: true,
            ...preview,
            pairingSystem: options.pairingSystem ?? tournament.pairingSystem ?? "eloSeeded",
            seedingMode: options.seedingMode ?? tournament.seedingMode ?? "elo",
          },
        };
      }
      const round = deps.store.generateNextRound(tournamentId, now, deps.coachRating, options);
      quietly(() => {
        const ids = new Set(round.scheduledMatchIds);
        notifyFixtures(deps, tournament, deps.store.matches(tournamentId).filter((match) => ids.has(match.id)), identity.coach);
      });
      return { status: 200, body: { round } };
    }

    if (path === "/api/scheduled-matches" && method === "GET") {
      const identity = authenticated(auth);
      const tournamentId = query.get("tournamentId")?.trim() || undefined;
      const matches = deps.store.matches(tournamentId)
        .filter((match) => identity.organizer || isParticipant(match, identity.coach))
        .map((match) => clientMatch(deps.store, match, identity, now, deps.teamBuild));
      return { status: 200, body: { matches } };
    }

    const audienceMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/notification-audience$/);
    if (audienceMatch && method === "GET") {
      const identity = authenticated(auth);
      if (!identity.organizer) return { status: 403, body: { error: "Organizer access required." } };
      const matchId = decoded(audienceMatch[1]!);
      if (!matchId || !deps.store.match(matchId)) return { status: 404, body: { error: "Scheduled match not found." } };
      // Coach names only: the notification system maps names to Discord ids server-side; ids are never sent out.
      const audience = deps.store.notificationAudience(matchId, now).map((coach) => ({ coachId: coach.ffbCoachId }));
      return { status: 200, body: { scheduledMatchId: matchId, audience } };
    }

    const presenceMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/presence$/);
    if (presenceMatch && (method === "POST" || method === "DELETE")) {
      const identity = authenticated(auth);
      const matchId = decoded(presenceMatch[1]!);
      if (!matchId) return { status: 400, body: { error: "Invalid scheduled match id." } };
      if (method === "DELETE") {
        deps.store.clearWaiting(matchId, identity.coach);
        return { status: 204, body: undefined };
      }
      const input = body === undefined ? {} : jsonObject(body);
      const ttlMs = input.ttlMs === undefined ? undefined : integer(input.ttlMs, "ttlMs");
      const lease = deps.store.renewWaiting(matchId, identity.coach, ttlMs, now);
      return {
        status: 200,
        body: {
          lease,
          statusRevision: deps.store.match(matchId)?.revision,
          notificationAudience: deps.store.notificationAudience(matchId, now).map((coach) => coach.ffbCoachId),
        },
      };
    }

    const actionMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/actions\/(retry|dismiss)$/);
    if (actionMatch && method === "POST") {
      const identity = authenticated(auth);
      const matchId = decoded(actionMatch[1]!);
      if (!matchId) return { status: 400, body: { error: "Invalid scheduled match id." } };
      const input = jsonObject(body);
      const updated = deps.store.applyMatchAction(matchId, identity.coach, actionMatch[2] as "retry" | "dismiss", integer(input.revision, "revision"), now);
      return { status: 200, body: { match: clientMatch(deps.store, updated, identity, now, deps.teamBuild) } };
    }

    const launchMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/launch$/);
    if (launchMatch && method === "PATCH") {
      const identity = authenticated(auth);
      if (!identity.organizer) return { status: 403, body: { error: "Organizer access required." } };
      const matchId = decoded(launchMatch[1]!);
      if (!matchId) return { status: 400, body: { error: "Invalid scheduled match id." } };
      const input = jsonObject(body);
      if (!(["launching", "launched", "launch_failed"] as unknown[]).includes(input.status))
        return { status: 400, body: { error: "status must be launching, launched, or launch_failed." } };
      const match = deps.store.recordLaunch(matchId, {
        expectedRevision: integer(input.revision, "revision"),
        status: input.status as "launching" | "launched" | "launch_failed",
        ...(typeof input.gameName === "string" ? { gameName: input.gameName } : {}),
        ...(typeof input.gameId === "string" ? { gameId: input.gameId } : {}),
        ...(typeof input.error === "string" ? { error: input.error } : {}),
      }, now);
      return { status: 200, body: { match: clientMatch(deps.store, match, identity, now, deps.teamBuild) } };
    }

    const resultMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/result$/);
    if (resultMatch && method === "PATCH") {
      const identity = authenticated(auth);
      if (!identity.organizer) return { status: 403, body: { error: "Organizer access required." } };
      const matchId = decoded(resultMatch[1]!);
      if (!matchId) return { status: 400, body: { error: "Invalid scheduled match id." } };
      const input = jsonObject(body);
      const match = deps.store.recordResult(matchId, {
        expectedRevision: integer(input.revision, "revision"),
        homeScore: integer(input.homeScore, "homeScore"),
        awayScore: integer(input.awayScore, "awayScore"),
        ...(input.homeCasualties === undefined ? {} : { homeCasualties: integer(input.homeCasualties, "homeCasualties") }),
        ...(input.awayCasualties === undefined ? {} : { awayCasualties: integer(input.awayCasualties, "awayCasualties") }),
      }, now);
      notifyResult(deps, match, identity.coach);
      return { status: 200, body: { match: clientMatch(deps.store, match, identity, now, deps.teamBuild) } };
    }

    const scheduledMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)$/);
    if (scheduledMatch && method === "GET") {
      const identity = authenticated(auth);
      const matchId = decoded(scheduledMatch[1]!);
      const match = matchId ? deps.store.match(matchId) : undefined;
      if (!match) return { status: 404, body: { error: "Scheduled match not found." } };
      if (!identity.organizer && !isParticipant(match, identity.coach))
        return { status: 403, body: { error: "You may fetch only your scheduled matches." } };
      return { status: 200, body: { match: clientMatch(deps.store, match, identity, now, deps.teamBuild) } };
    }

    return undefined;
  } catch (error) {
    if (error instanceof TournamentStoreError) return { status: error.status, body: { error: error.message } };
    throw error;
  }
}

export function entrantByCoach(entrants: readonly TournamentEntrantRecord[], coach: string): TournamentEntrantRecord | undefined {
  return entrants.find((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(coach));
}
