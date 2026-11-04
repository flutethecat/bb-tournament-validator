import { bb2025 } from "@bb/validator/dataset";
import { generateTournamentPairings } from "./pairing.js";
import { NafExportError, renderNafTournamentReport } from "./nafExport.js";
import { isTournamentManager, tournamentOwner, TournamentStore, TournamentStoreError, type TournamentUpdate } from "./store.js";
import { canEditSeries, seriesChip } from "./series.js";
import {
  assertRegistrationOrder, canSeeTournament, hiddenTournamentPath, parseRegistrationSettings, selfRegistrationStatus,
} from "./publication.js";
import { bannerUrl, NEWS_BODY_MAX, NEWS_MAX_POSTS, newNewsPost, orderedNews, PAGE_FIELDS, parseNewsInput, parsePagePatch } from "./page.js";
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
  TournamentRegistrationSettings,
  VerifiedCoachIdentity,
} from "./types.js";
import { tournamentLink, type TournamentNotify } from "../notifications.js";
import { paymentLinksView } from "../payments/links.js";
import { clubLabel, everAccepted, resolveClubPick } from "../clubs/pick.js";
import { FormatError, parsePairingAvoid, parsePointsScheme, parseRegions, parseTiebreakerChain, tiebreakerChainOf } from "../competition/format.js";
import { HouseRulesError, houseRulesOf, houseRulesStamp, parseHouseRules, type HouseRules } from "../competition/houseRules.js";
import { ChangeMessageError, CONFIRM_AFTER_START_TOURNAMENT, parseChangeMessage, rulesChangeBody, rulesChangeDiff, rulesChangeNews, rulesNotices, type RulesChangeCoalescer, type RulesState } from "../competition/rulesChange.js";

/** A package name as the change list prints it. */
const rulesetLabel = (name: string): string => name || "no ruleset";
/** The net change of a window of rules changes (first starting settings -> latest settings). */
const tournamentNetDiff = (from: RulesState, to: RulesState): string[] => rulesChangeDiff("tournament", from, to, rulesetLabel);
import { myTournamentAwards, tournamentHonoursRoutes } from "./honours.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import { canonicalNafId } from "../auth/identitiesStore.js";
import { requestRevision } from "../leagues/http.js";
import { ContactValidationError, parseShareFields, type ShareField } from "../auth/contactSchema.js";
import type { SharedContact } from "../auth/contactFor.js";
import {
  isCheckInOpen, RegistrationError, registrationCounts, waitlistOrder, waitlistPosition, type RegistrationActor, type RegistrationEntry,
} from "../registration/index.js";
import { tournamentCompetition, tournamentRegistrationWindow } from "./publication.js";
import {
  checkInView, ensureReferenceCodes, entryStateOf, organiserAddedAwaitingRoster, referenceCodes, rosterDeadlinePassed, toRegistrationEntry, tournamentRegistrationService,
  type TournamentEntryData,
} from "./registration.js";

export interface TournamentApiIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
  /** A test sign-in session (registration spec Q13): what it creates is marked test (server.ts gates its other writes). */
  test?: boolean;
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
  /** v4: snapshot + validate a coach's saved team (`save:<id>`) against a package. */
  validateSubmission?(coach: string, ref: string, packageName: string, now: Date, houseRules?: HouseRules): TournamentSubmission | { error: string; status?: 400 | 404 | 409 };
  /** Creation wizards v2: re-check a STORED submission's snapshot against a package after a rules change (never the
   *  coach's live save). Absent = no automatic re-check (the store's "ruleset changed" verdict stays). */
  revalidateSubmission?(coach: string, submission: TournamentSubmission, packageName: string, now: Date, houseRules?: HouseRules): TournamentSubmission;
  /** Rules-change notice coalescing (one combined notice per competition per window). Absent = the process-wide one. */
  rulesNotices?: RulesChangeCoalescer;
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
    /** Registrations panel (lane L4): what a manager sees of each entry's coach while it is pending, waitlisted or
     *  accepted (src/registration registrationContactFor: the grant given for the current entry; nothing on decline or
     *  withdrawal). Absent = no shared fields in the panel. */
    registrationContacts?(viewer: TournamentApiIdentity, entries: ReadonlyArray<Pick<RegistrationEntry, "coach" | "state" | "enteredAt" | "competitionId">>, managers: readonly string[]): Array<SharedContact | undefined>;
  };
  /** Counted result rows (TournamentResultStore.list()) for Statistics / Honours (src/tournaments/honours.ts). */
  results?(): StoredTournamentResult[];
  /** The request's If-Match header (award DELETE carries its revision there). */
  ifMatch?: string;
  /** The fixture lobby of a scheduled match (src/fixtureLobby/tournament.ts): undefined = nobody opened one. A lobby that
   *  has not STARTed holds the online launch (waiting presence and launching / launched). Throws when unreadable. */
  fixtureLobby?(matchId: string): { started: boolean } | undefined;
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

/**
 * Creation wizards v2 fields on a create or settings PATCH body, validated into `patch` before anything is written:
 * `tiebreakers` (the chain after points, up to 4), `points` ({ win, draw, loss }), `houseRules` (merged over the stored
 * ones), `pairingAvoid` and `regions`. A bad value is a 400 with the parser's message.
 */
function competitionFields(input: Record<string, unknown>, patch: TournamentUpdate, prior?: TournamentRecord): void {
  try {
    if (input.tiebreakers !== undefined) patch.tiebreakerChain = parseTiebreakerChain(input.tiebreakers);
    if (input.points !== undefined) patch.pointsScheme = parsePointsScheme(input.points);
    if (input.houseRules !== undefined) patch.houseRules = parseHouseRules(input.houseRules, "tournament", prior ? houseRulesOf(prior, "tournament") : undefined);
    if (input.pairingAvoid !== undefined) patch.pairingAvoid = parsePairingAvoid(input.pairingAvoid);
    if (input.regions !== undefined) patch.regions = parseRegions(input.regions);
  } catch (error) {
    if (error instanceof FormatError || error instanceof HouseRulesError) throw new TournamentStoreError(400, error.message);
    throw error;
  }
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

const SUBMISSION_REF = /^(?:save:)?[A-Za-z0-9_.:-]+$/;
/** Owner rule 11-03: fork library teams are never a source; a team made in the League Manager is a saved team. */
const LIBRARY_TEAM_REFUSED = "A Super FUMBBL library team can't be used here. Register with a saved team.";

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
    // "Register now, roster later": an entry with no team and no roster yet has nothing to check.
    if (!entrant.submission && !entrant.teamId) {
      out[entrant.id] = { error: NO_ROSTER_PROBLEM };
      continue;
    }
    // A submitted roster is judged by the snapshot stored when it was submitted (never the coach's live save, which may
    // have changed after the roster deadline); re-checked against the current rules when the host can.
    if (entrant.submission) {
      try {
        out[entrant.id] = deps.revalidateSubmission
          ? deps.revalidateSubmission(entrant.coach.ffbCoachId, entrant.submission, tournament.packageName, now, houseRulesOf(tournament, "tournament"))
          : structuredClone(entrant.submission);
      } catch {
        throw new TournamentStoreError(503, "Team validation failed on this host; nothing was locked. Try again.");
      }
      continue;
    }
    if (!deps.validateSubmission) {
      out[entrant.id] = { error: "Team validation is unavailable on this host." };
      continue;
    }
    // No submission: the library team the coach entered with (a fork team, not a Roster Builder save).
    const ref = `library:${entrant.teamId}`;
    let check: ReturnType<NonNullable<TournamentApiDeps["validateSubmission"]>>;
    try {
      check = deps.validateSubmission(entrant.coach.ffbCoachId, ref, tournament.packageName, now, houseRulesOf(tournament, "tournament"));
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
function clientEntrant(entrant: TournamentEntrantRecord, deps: Pick<TournamentApiDeps, "teamBuild">, private_: boolean, shared?: SharedContact, tournament?: TournamentRecord, profile?: ProfileNaf, refCode?: string) {
  const {
    coach, submission: _submission, flags, rosterVerifiedOverride, manualSeed, nafNumber, notNafMember, nafPending, nafSnapshot: _nafSnapshot, paidUpdated,
    // Registration (lane L4): the state machine's fields, the payment reference and "I've paid" are never public.
    entryState: _state, firstRegisteredAt: _first, waitlistAt: _wAt, waitlistSeq: _wSeq, decided: _decided, registrationLog: _log,
    refCode: storedCode, coachSaysPaid, checkedInBy, region, nafToldAt: _told, paidClaimNotifiedAt: _paidTold, clubId,
    ...rest
  } = entrant;
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
    // The club the coach represents here (public: club results are public too).
    ...clubLabel(clubId),
    ...(private_ ? {
      flags: { ...DEFAULT_ENTRANT_FLAGS, ...(flags ?? {}) },
      ...(paidUpdated ? { paidUpdated: { ...paidUpdated } } : {}),
      ...(rosterVerifiedOverride === undefined ? {} : { rosterVerifiedOverride }),
      ...(manualSeed === undefined ? {} : { manualSeed }),
      ...(tournament ? nafFields(entryNaf(tournament, entrant, profile)) : nafNumber ? { nafNumber } : {}),
      ...(notNafMember ? { notNafMember } : {}),
      ...((tournament ? nafOwed(tournament, entrant, profile) : nafPending) ? { nafPending: true as const } : {}),
      ...(refCode ?? storedCode ? { refCode: refCode ?? storedCode } : {}),
      ...(coachSaysPaid ? { coachSaysPaid: { ...coachSaysPaid } } : {}),
      ...(checkedInBy ? { checkedInBy: { ...checkedInBy } } : {}),
      ...(region ? { region } : {}),
    } : {}),
    ...(shared ? { shared } : {}),
  };
}

export const NO_ROSTER_PROBLEM = "No roster submitted yet.";

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
    ...(match.edited?.kind === "result" ? { edited: publicEdit(match.edited) } : {}),
  };
}

/** The Edited chip everyone who sees the fixture gets: who changed the result and when (no reason, no old values). */
function publicEdit(edited: NonNullable<ScheduledMatchRecord["edited"]>) {
  return {
    kind: "result" as const, byCoachId: edited.byCoachId, at: edited.at,
    ...(edited.cleared ? { cleared: true as const } : {}), ...(edited.reportedAgainAt ? { reportedAgainAt: edited.reportedAgainAt } : {}),
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
  const owning = store.tournament(match.tournamentId);
  const fullEdit = participant || Boolean(auth && owning && canManage(owning, auth));
  const ownsHome = participant && coachKey(match.home.coach.ffbCoachId) === coachKey(auth!.coach);
  const mySide = participant ? (ownsHome ? match.home : match.away) : undefined;
  const opponentSide = participant ? (ownsHome ? match.away : match.home) : undefined;
  const opponentBuild = opponentSide && teamBuild ? teamBuild(opponentSide.teamId) : undefined;
  const { edited, ...rest } = match;
  return {
    ...rest,
    ...(edited ? { edited: fullEdit || edited.kind !== "result" ? edited : publicEdit(edited) } : {}),
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

/** The stored tournament fields a tournament payload may carry (everything else is derived or private). */
export const PUBLIC_TOURNAMENT_FIELDS = [
  "id", "name", "status", "test", "publishedAt", "unpublished", "registration", "format", "packageName", "maxPlayers",
  "roundCount", "roundCountExplicit", "currentRound", "tiebreakers", "points", "turnTimer", "inducementOptIns",
  "organizerCoachId", "ownerCoachId", "organizerCoachIds", "pairingSystem", "seedingMode", "rostersLockedAt", "startedAt",
  "seriesId", "location", "startTime", "entryFee", "payPal", "venmo", "summary", "notes", "deadlines", "nafSanctioned",
  "playOnFork", "awards", "awardsRevision", "houseRules", "pairingAvoid", "regions", "authorised", "createdAt", "updatedAt",
] as const satisfies ReadonlyArray<keyof TournamentRecord>;

function pickPublicTournament(t: TournamentRecord): Partial<Pick<TournamentRecord, (typeof PUBLIC_TOURNAMENT_FIELDS)[number]>> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_TOURNAMENT_FIELDS) if (t[key] !== undefined) out[key] = structuredClone(t[key]);
  return out as Partial<Pick<TournamentRecord, (typeof PUBLIC_TOURNAMENT_FIELDS)[number]>>;
}

function clientTournament(
  tournament: TournamentRecord,
  entrants: TournamentEntrantRecord[],
  auth?: TournamentApiIdentity,
) {
  const { startsAt, endsAt, news } = tournament;
  // An allow-list, never a spread (lane L4): internal bookkeeping (bannerPath, the activity log, the check-in and
  // roster-due notice guards that list held entry ids) never reaches a tournament payload. A new stored field stays
  // private until it is added here.
  const record = pickPublicTournament(tournament);
  const banner = bannerUrl(tournament);
  // Payment links as a page may show them (re-checked; only valid links). The detail route is the only way to a draft.
  const payment = paymentLinksView(tournament.payPal, tournament.venmo);
  const ownEntrant = auth
    ? entrants.find((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(auth.coach))
    : undefined;
  return {
    ...record,
    turnTimer: tournament.turnTimer ?? DEFAULT_TOURNAMENT_TURN_TIMER,
    inducementOptIns: tournament.inducementOptIns ?? [],
    // Creation wizards v2: derived on read so records written before these settings existed read as the defaults.
    houseRules: houseRulesOf(tournament, "tournament"),
    tiebreakerChain: tiebreakerChainOf(tournament.tiebreakers),
    pairingAvoid: tournament.pairingAvoid ?? "none",
    regions: tournament.regions ?? [],
    authorised: tournament.authorised !== false,
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
    ...(banner ? { bannerUrl: banner } : {}),
    ...(payment ? { paymentLinks: payment } : {}),
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
  paid: ["Payment received", "Payment no longer marked as received"],
  rosterVerified: ["Roster verified", "Roster marked invalid"],
  frozen: ["Roster frozen", "Roster unfrozen"],
  checkedIn: ["Checked in", "Check-in cleared"],
  active: ["Moved to active", "Moved to standby"],
};

function effectiveFlags(entrant: TournamentEntrantRecord | undefined): TournamentEntrantFlags {
  return { ...DEFAULT_ENTRANT_FLAGS, ...(entrant?.flags ?? {}) };
}

function notifyFlagChanges(deps: TournamentApiDeps, tournament: TournamentRecord, before: TournamentEntrantRecord | undefined, after: TournamentEntrantRecord, actor: string): void {
  // An unpublished draft is out of sight for its coaches: nothing to tell them yet.
  if (!deps.notify || tournament.unpublished === true) return;
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

/** The news log entry of a rules change (always written: a full news board never drops it). */
function logRulesChange(deps: TournamentApiDeps, tournament: TournamentRecord, message: string, diff: readonly string[], afterStart: boolean, actor: string, now: Date): TournamentRecord {
  const news = rulesChangeNews(message || "The organiser changed the rules.", diff, afterStart);
  deps.store.addNews(tournament.id, newNewsPost({ title: news.title, body: news.body.slice(0, NEWS_BODY_MAX), pinned: false }, actor, now), Number.MAX_SAFE_INTEGER, now);
  return deps.store.tournament(tournament.id) ?? tournament;
}

/**
 * After a ruleset / house-rules change with registered coaches: log it in the news, re-validate every submitted roster
 * against the new rules at once, tell EVERY registered coach (inbox + Discord DM: the message and the site's list of what
 * changed), and tell each coach whose roster is now invalid that it needs changes (inbox + DM). A draft (unpublished)
 * tournament notifies nobody.
 */
function applyRulesChange(deps: TournamentApiDeps, tournament: TournamentRecord, message: string, diff: readonly string[], afterStart: boolean, actor: string, now: Date, enforced: boolean, from: RulesState, to: RulesState): TournamentRecord {
  let updated = tournament;
  // Only a change to what the validator enforces (the package, the PtN ban, the stat caps) re-checks rosters, and only the
  // SUBMITTED snapshots: a display-only change never touches a submission. The re-check is immediate.
  const submitted = deps.store.entrants(updated.id).filter((e) => e.droppedAt === undefined && e.submission);
  if (enforced && submitted.length && deps.revalidateSubmission) {
    const checks: Record<string, TournamentSubmission | { error: string }> = {};
    const rules = houseRulesOf(updated, "tournament");
    for (const e of submitted) {
      try { checks[e.id] = deps.revalidateSubmission(e.coach.ffbCoachId, e.submission!, updated.packageName, now, rules); }
      catch { checks[e.id] = { error: "The roster could not be re-checked on this host." }; }
    }
    deps.store.recheckRosters(updated.id, checks, now);
    updated = deps.store.tournament(updated.id) ?? updated;
  }
  // The news post, the notes and the DMs are coalesced per tournament (a burst of edits = one combined notice per window).
  const coalescer = deps.rulesNotices ?? rulesNotices;
  coalescer.submit(`tournament:${updated.id}`, { message, diff: [...diff], afterStart, actor, from, to }, (n) => announceRulesChange(deps, updated.id, n, deps.now?.() ?? new Date()), tournamentNetDiff);
  return deps.store.tournament(updated.id) ?? updated;
}

/** One (possibly combined) rules-change notice: the news log entry, then every registered coach's note + DM and, for each
 *  coach whose submitted roster is invalid NOW, a "needs changes" note + DM. A draft (unpublished) tournament tells nobody. */
function announceRulesChange(deps: TournamentApiDeps, tournamentId: string, n: { message: string; diff: string[]; afterStart: boolean; actor: string; count: number }, now: Date): void {
  quietly(() => {
    const current = deps.store.tournament(tournamentId);
    if (!current) return;
    logRulesChange(deps, current, n.message, n.diff, n.afterStart, n.actor, now);
    if (!deps.notify || current.unpublished === true) return;
    const link = tournamentLink(current.id, "overview");
    const body = rulesChangeBody(n.message || "The organiser changed the rules.", n.diff);
    const seen = new Set<string>();
    for (const entrant of deps.store.entrants(current.id)) {
      if (entrant.droppedAt !== undefined) continue;
      const coach = entrant.coach.ffbCoachId;
      if (seen.has(coachKey(coach))) continue;
      seen.add(coachKey(coach));
      deps.notify!.coach(coach, { type: "ruleset-change", title: `${current.name}: the rules changed${n.count > 1 ? ` (${n.count} changes)` : ""}`, body, link, from: n.actor, subject: current.name, action: true });
      const validation = entrant.submission?.validation;
      if (validation && !validation.ok && !entrant.flags?.rosterVerified) {
        deps.notify!.coach(coach, {
          type: "roster-problems", title: `${current.name}: your roster needs changes`,
          body: `After the rules change your roster is not valid any more (${validation.problems.length} ${validation.problems.length === 1 ? "problem" : "problems"}). Open the tournament to see what to fix and resubmit.`,
          link, from: n.actor, subject: current.name, action: true,
        });
      }
    }
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
    // The field and (lane L4) pending / waitlisted entries; a held entry is marked told with the request.
    const entrants = deps.store.registrationEntries(tournament.id).filter((e) => LIVE_STATES.has(entryStateOf(e)));
    const profiles = profileNafs(deps, entrants.map((e) => e.coach.ffbCoachId));
    const unmarked = entrants.filter((e) => nafOwed(tournament, e, profiles.get(coachKey(e.coach.ffbCoachId))) && !e.nafPending);
    if (!unmarked.length) continue;
    const marked = deps.store.markNafPending(tournament.id, unmarked.map((e) => e.id));
    deps.store.markNafTold(tournament.id, unmarked.filter((e) => marked.includes(e.id) && entryStateOf(e) !== "accepted").map((e) => e.id));
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

/** Organiser result edit / clear: both coaches of the fixture once (not the editing manager, who made the change). */
function notifyResultEdit(deps: TournamentApiDeps, match: ScheduledMatchRecord, actor: string): void {
  if (!deps.notify || !match.away) return;
  quietly(() => {
    const name = deps.store.tournament(match.tournamentId)?.name ?? "Tournament";
    const cleared = !match.result;
    const score = match.result ? ` ${match.result.homeScore} - ${match.result.awayScore} ` : " v ";
    const body = cleared
      ? `An organiser cleared the result of ${match.home.coach.ffbCoachId} v ${match.away!.coach.ffbCoachId} (round ${match.roundNumber}). The fixture is unplayed again.`
      : `An organiser changed the result to ${match.home.coach.ffbCoachId}${score}${match.away!.coach.ffbCoachId} (round ${match.roundNumber}).`;
    const input = { type: "result-edited" as const, title: `${name}: result ${cleared ? "cleared" : "edited"} by an organiser`, body, link: tournamentLink(match.tournamentId, "rounds"), from: actor };
    const seen = new Set<string>();
    for (const coach of [match.home.coach.ffbCoachId, match.away!.coach.ffbCoachId]) {
      if (coachKey(coach) === coachKey(actor) || seen.has(coachKey(coach))) continue;
      seen.add(coachKey(coach));
      deps.notify!.coach(coach, input);
    }
  });
}

/** The edit body's optional reason (trimmed; "" = none). */
function editReason(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TournamentStoreError(400, "reason must be text.");
  const text = value.trim();
  return text ? text : undefined;
}

/** The fixture revision a result edit names (body `revision` or If-Match): 428 missing, 400 malformed. */
function editRevision(input: Record<string, unknown>, ifMatch: string | undefined): number {
  const asked = requestRevision(input, ifMatch);
  if (asked === "missing") throw new TournamentStoreError(428, "Send the fixture revision you loaded (revision or If-Match).");
  if (asked === "bad") throw new TournamentStoreError(400, "revision must be a whole number.");
  return asked;
}

/** The activity log a viewer of the detail page gets: everyone who sees every fixture (managers, organisers,
 *  entrants) the whole log; another signed-in coach only entries about their own fixtures; anonymous none. */
function visibleActivity(
  tournament: TournamentRecord, store: TournamentStore, auth: TournamentApiIdentity | undefined, seesAll: boolean,
) {
  const log = tournament.activity ?? [];
  if (!auth || !log.length) return [];
  const mine = new Set(store.matches(tournament.id).filter((m) => isParticipant(m, auth.coach)).map((m) => m.id));
  const manager = canManage(tournament, auth);
  // Full detail (reason, old and new values) for this tournament's managers and the fixture's two coaches; everyone
  // else who may see the log gets who and when.
  return log
    .filter((entry) => seesAll || mine.has(entry.fixtureId))
    .map((entry) => (manager || mine.has(entry.fixtureId) ? entry : {
      id: entry.id, at: entry.at, by: entry.by, kind: entry.kind, admin: entry.admin, fixtureId: entry.fixtureId, roundNumber: entry.roundNumber,
    }));
}

/** The creation wizard's extra fields on POST /api/tournaments (lane L3), validated before anything is written: `publish`,
 *  the settings the Manage route edits (dates, pairing, seeding, where it is played, turn timer), the page fields
 *  (location, start time, entry fee, summary, notes, deadlines) and the registration settings. Absent `publish` = the old
 *  dialog's body (nothing else is read, so the record is exactly what it made before). */
function wizardCreateFields(input: Record<string, unknown>):
  { fields: { publication?: "draft" | "published"; settings?: TournamentUpdate; page?: ReturnType<typeof parsePagePatch>; registration?: TournamentRegistrationSettings } } | { error: string } {
  if (input.publish === undefined) return { fields: {} };
  if (typeof input.publish !== "boolean") return { error: "publish must be true or false." };
  try {
    const settings: TournamentUpdate = {};
    for (const key of ["startsAt", "endsAt"] as const) {
      if (input[key] === undefined || input[key] === "") continue;
      if (typeof input[key] !== "string") return { error: `${key} must be a string.` };
      settings[key] = input[key] as string;
    }
    if (input.pairingSystem !== undefined) {
      if (!TOURNAMENT_PAIRING_SYSTEMS.includes(input.pairingSystem as TournamentPairingSystem)) return { error: "pairingSystem must be dutch, monrad or eloSeeded." };
      settings.pairingSystem = input.pairingSystem as TournamentPairingSystem;
    }
    if (input.seedingMode !== undefined) {
      if (!TOURNAMENT_SEEDING_MODES.includes(input.seedingMode as TournamentSeedingMode)) return { error: "seedingMode must be elo or manual." };
      settings.seedingMode = input.seedingMode as TournamentSeedingMode;
    }
    if (input.playOnFork !== undefined) {
      if (typeof input.playOnFork !== "boolean") return { error: "playOnFork must be true or false." };
      if (input.playOnFork) settings.playOnFork = true;
    }
    competitionFields(input, settings);
    if (input.turnTimer !== undefined) {
      const t = jsonObject(input.turnTimer);
      const enforced = t.enforced === undefined ? DEFAULT_TOURNAMENT_TURN_TIMER.enforced : t.enforced;
      if (enforced !== "off" && enforced !== "optional" && enforced !== "required") return { error: "turnTimer.enforced must be off, optional or required." };
      settings.turnTimer = { enforced, seconds: t.seconds === undefined ? DEFAULT_TOURNAMENT_TURN_TIMER.seconds : integer(t.seconds, "turnTimer.seconds") };
    }
    const page = parsePagePatch(Object.fromEntries(PAGE_FIELDS.filter((f) => input[f] !== undefined).map((f) => [f, input[f]])));
    for (const key of PAGE_FIELDS) if (page[key] === null) delete page[key];
    const registration = input.registration === undefined || input.registration === null ? undefined : parseRegistrationSettings(input.registration);
    assertRegistrationOrder(registration, page.deadlines ?? undefined, settings.startsAt);
    return {
      fields: {
        publication: input.publish ? "published" : "draft",
        ...(Object.keys(settings).length ? { settings } : {}),
        ...(Object.keys(page).length ? { page } : {}),
        ...(registration ? { registration } : {}),
      },
    };
  } catch (error) {
    if (error instanceof TournamentStoreError && error.status === 400) return { error: error.message };
    throw error;
  }
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
    // An unpublished draft is seen only by its managers and admins (lane L3): every /api/tournaments/:id route answers
    // 404 to anyone else, as if it did not exist (src/tournaments/publication.ts).
    if (hiddenTournamentPath(deps.store, path, auth)) return { status: 404, body: { error: "Tournament not found." } };

    if (path === "/api/tournaments" && method === "POST") {
      const identity = authenticated(auth);
      // Site organisers and admins create (registration spec Q1).
      if (!identity.organizer && !identity.admin) return { status: 403, body: { error: "Organizer access required." } };
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
        // A test sign-in session never writes into a real series (registration spec Q13).
        if (identity.test && (series as { test?: boolean }).test !== true)
          return { status: 403, body: { error: "Test sign-in sessions can only create tournaments outside a series." } };
        seriesId = series.id;
      }
      // The creation wizard (lane L3): `publish` (true = public now, false = a hidden draft) plus the details, page and
      // registration fields, all validated here and written in the same store mutation. Without `publish` this is the old
      // dialog's create (public draft, as before).
      const wizard = wizardCreateFields(input);
      if ("error" in wizard) return { status: 400, body: { error: wizard.error } };
      const created = deps.store.createTournament({
        name,
        packageName,
        maxPlayers,
        format: input.format,
        organizerCoachId: identity.coach,
        primaryTiebreaker: chosenTiebreaker,
        ...(roundCount === undefined ? {} : { roundCount }),
        ...(input.nafSanctioned === true ? { nafSanctioned: true } : {}),
        ...(seriesId ? { seriesId } : {}),
        ...(identity.test ? { test: true } : {}),
        ...wizard.fields,
      }, now);
      return { status: 201, body: { tournament: created } };
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
      // Unpublished drafts list only for their managers and admins (lane L3).
      const seen = source.filter((tournament) => canSeeTournament(tournament, auth));
      let filtered = nameQuery
        ? seen.filter((tournament) => tournament.name.toLowerCase().includes(nameQuery))
        : seen;
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
          // The coach's own live entries, accepted or still pending / waitlisted (lane L4).
          .filter((t) => deps.store.registrationEntries(t.id).some((e) => LIVE_STATES.has(entryStateOf(e)) && coachKey(e.coach.ffbCoachId) === me))
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
      if (saveId.startsWith("library:")) return { status: 400, body: { error: LIBRARY_TEAM_REFUSED, code: "library-team" } };
      if (!saveId || saveId.length > 120 || !SUBMISSION_REF.test(saveId))
        return { status: 400, body: { error: "saveId must name a saved team (save:<id>)." } };
      // The coach's live entry: in the field, or pending / waitlisted ("register now, roster later" works before acceptance).
      const entrant = deps.store.registrationEntries(tournament.id)
        .find((r) => coachKey(r.coach.ffbCoachId) === coachKey(identity.coach) && LIVE_STATES.has(entryStateOf(r)));
      if (!entrant) return { status: 403, body: { error: "You are not entered in this tournament." } };
      // The roster deadline ("register now, roster later"): after it the roster is what it is; organisers can move the deadline.
      // Grace for an entry an organiser added after the deadline: its FIRST roster is still welcome (until rosters lock, below).
      if (rosterDeadlinePassed(tournament, now) && !organiserAddedAwaitingRoster(entrant))
        return { status: 409, body: { error: "The roster deadline has passed. Ask an organiser if you need to change your roster.", code: "roster-deadline" } };
      // NAF stays non-optional (owner 10-31): an entry still owing its NAF answer cannot submit a roster.
      if (tournament.nafSanctioned && nafOwed(tournament, entrant, profileNaf(deps, entrant.coach.ffbCoachId))) return { status: 400, body: { error: NAF_REQUIRED_MESSAGE } };
      if (tournament.rostersLockedAt || entrant.flags?.frozen)
        return { status: 409, body: { error: "Rosters are locked; ask an organiser to unlock them before resubmitting." } };
      if (!deps.validateSubmission) return { status: 503, body: { error: "Team validation is unavailable on this host." } };
      const check = deps.validateSubmission(entrant.coach.ffbCoachId, saveId, tournament.packageName, now, houseRulesOf(tournament, "tournament"));
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
      }, now, identity.coach);
      notifyFlagChanges(deps, tournament, before, updated, identity.coach);
      return { status: 200, body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, tournament.nafSanctioned && updated.droppedAt === undefined ? profileNaf(deps, updated.coach.ffbCoachId) : undefined) } };
    }

    // ---- registration (lane L4: src/tournaments/registration.ts over the src/registration core) ----
    // Every state change runs through the core (per-tournament lock, audited transitions, notifications: the organisers
    // on every registration and withdrawal except the actor, the coach on their own outcome). CSRF (X-CW-Auth) and the
    // onboarding 428 gate run in server.ts ahead of every /api write; GETs below never change state.
    const registration = await registrationRoutes(method, path, auth, body, deps, now);
    if (registration) return registration;

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
      competitionFields(input, patch, existing);
      if (input.nafSanctioned !== undefined) {
        if (typeof input.nafSanctioned !== "boolean")
          return { status: 400, body: { error: "nafSanctioned must be true or false." } };
        patch.nafSanctioned = input.nafSanctioned;
      }
      if (input.playOnFork !== undefined) {
        if (typeof input.playOnFork !== "boolean")
          return { status: 400, body: { error: "playOnFork must be true or false." } };
        // A lobby START already went one way (online launch released, or a recorder match made): switching now would
        // strand those fixtures, so the switch waits until every started fixture is resolved.
        if (input.playOnFork !== (existing.playOnFork === true) && deps.fixtureLobby) {
          const open = deps.store.matches(tournamentId).filter((m) => !m.result && !["completed", "cancelled", "dismissed"].includes(m.status));
          let started = false;
          try { started = open.some((m) => deps.fixtureLobby!(m.id)?.started === true); }
          catch { return { status: 500, body: { error: "Could not read the fixture lobbies right now." } }; }
          if (started) return { status: 409, body: { error: "A fixture lobby of this tournament has already started its match. Finish or resolve those fixtures before changing where the tournament is played." } };
        }
        patch.playOnFork = input.playOnFork;
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
      // Registration settings (lane L3): replace as a whole (null clears back to today's behaviour), checked against the
      // deadlines and start the same request leaves in place.
      let registration: TournamentRegistrationSettings | null | undefined;
      if (input.registration !== undefined) {
        registration = input.registration === null ? null : parseRegistrationSettings(input.registration);
      }
      if (registration !== undefined || input.deadlines !== undefined || input.startsAt !== undefined) {
        const deadlines = pagePatch.deadlines === undefined ? existing.deadlines : pagePatch.deadlines ?? undefined;
        const startsAt = patch.startsAt === undefined ? existing.startsAt : patch.startsAt || undefined;
        if (registration !== undefined || existing.registration) assertRegistrationOrder(registration === undefined ? existing.registration : registration ?? undefined, deadlines, startsAt);
      }
      // A ruleset / house-rules change with registered coaches (creation wizards v2 Q2): the organiser's message is required
      // (400 without it), and after round 1 so is the "Are you sure?" confirmation (409 without it).
      const rulesBefore: RulesState = { packageName: existing.packageName, houseRules: houseRulesOf(existing, "tournament") };
      const rulesAfter: RulesState = { packageName: patch.packageName ?? existing.packageName, houseRules: patch.houseRules ?? rulesBefore.houseRules };
      const rulesDiff = rulesChangeDiff("tournament", rulesBefore, rulesAfter, rulesetLabel);
      const registered = deps.store.entrants(tournamentId).filter((e) => e.droppedAt === undefined);
      const afterStart = existing.status !== "draft" || deps.store.rounds(tournamentId).length > 0;
      let changeMessage = "";
      if (rulesDiff.length && registered.length) {
        try { changeMessage = parseChangeMessage(input.changeMessage); } catch (error) {
          if (error instanceof ChangeMessageError) return { status: 400, body: { error: error.message, field: "changeMessage", changes: rulesDiff, coaches: registered.length, afterStart } };
          throw error;
        }
      }
      if (rulesDiff.length && afterStart) {
        if (input.confirmAfterStart !== true) return { status: 409, body: { error: CONFIRM_AFTER_START_TOURNAMENT, confirmRequired: true, changes: rulesDiff, coaches: registered.length, afterStart: true } };
        patch.confirmAfterStart = true;
      }
      const coreKeys = Object.keys(input).filter((key) => !(PAGE_FIELDS as readonly string[]).includes(key) && key !== "registration" && key !== "changeMessage" && key !== "confirmAfterStart");
      const pendingBefore = new Set(deps.store.registrationEntries(tournamentId).filter((e) => e.nafPending).map((e) => e.id));
      const wasSanctioned = existing.nafSanctioned === true;
      let tournament = coreKeys.length || (!hasPage && registration === undefined) ? deps.store.updateTournament(tournamentId, patch, now) : existing;
      if (patch.nafSanctioned === true && !wasSanctioned) {
        // Made NAF sanctioned with entries already in: one notice per coach, none to organisers. Every active entrant
        // whose profile NAF details now reach the organisers is told so (whatever the entry stored before); a newly
        // marked entry without them is asked to add them (or say "not a NAF member").
        // Pending and waitlisted entries are treated alike (lane L4); a held entry is marked told before the notice, so
        // the Registrations panel shows its profile NAF details only once the coach has been told (law 23a).
        const entries = deps.store.registrationEntries(tournamentId).filter((e) => LIVE_STATES.has(entryStateOf(e)));
        const profiles = profileNafs(deps, entries.map((e) => e.coach.ffbCoachId));
        const told: Array<{ e: TournamentEntrantRecord; shared: boolean }> = [];
        for (const e of entries) {
          const shared = entryNaf(tournament, e, profiles.get(coachKey(e.coach.ffbCoachId)));
          if (shared && profiles.get(coachKey(e.coach.ffbCoachId)) === shared) told.push({ e, shared: true });
          else if (e.nafPending && !pendingBefore.has(e.id)) told.push({ e, shared: false });
        }
        deps.store.markNafTold(tournamentId, told.filter((x) => entryStateOf(x.e) !== "accepted").map((x) => x.e.id), now);
        for (const { e, shared } of told) {
          if (shared) notifyNafShared(deps, tournament, e.coach.ffbCoachId, identity.coach);
          else notifyNafRequest(deps, tournament, e.coach.ffbCoachId, identity.coach, false);
        }
      }
      if (hasPage) tournament = deps.store.updatePage(tournamentId, pagePatch, now);
      if (registration !== undefined) tournament = deps.store.setRegistration(tournamentId, registration, now);
      // A raised cap or new registration settings can free places: auto mode promotes the waitlist now (the core's
      // promotion is idempotent and runs in the tournament's lock).
      if (patch.maxPlayers !== undefined || registration !== undefined) {
        try { await registrationServiceFor(deps).promoteWaitlist(tournamentId, registrationActor(identity)); } catch { /* best effort */ }
      }
      let recheck: ReturnType<typeof validationTable> | undefined;
      if (rulesDiff.length && registered.length) {
        const enforced = rulesBefore.packageName !== rulesAfter.packageName || houseRulesStamp(rulesBefore.houseRules) !== houseRulesStamp(rulesAfter.houseRules);
        tournament = applyRulesChange(deps, tournament, changeMessage, rulesDiff, afterStart, identity.coach, now, enforced, rulesBefore, rulesAfter);
        recheck = validationTable(deps.store.entrants(tournamentId), deps);
      } else if (rulesDiff.length && afterStart) {
        // No registered coach to tell, but a change during play is still logged in the news.
        (deps.rulesNotices ?? rulesNotices).submit(`tournament:${tournament.id}`, { message: "", diff: rulesDiff, afterStart: true, actor: identity.coach, from: rulesBefore, to: rulesAfter }, (n) => announceRulesChange(deps, tournament.id, n, deps.now?.() ?? new Date()), tournamentNetDiff);
        tournament = deps.store.tournament(tournament.id) ?? tournament;
      }
      return {
        status: 200,
        body: { tournament: clientTournament(tournament, deps.store.entrants(tournamentId), auth), ...(recheck ? { changes: rulesDiff, validation: recheck } : {}) },
      };
    }

    // Publish / Unpublish (lane L3, managers): publishing a hidden draft makes it public (registration then follows its
    // window); unpublishing puts a draft nobody has entered back out of sight.
    const publishMatch = path.match(/^\/api\/tournaments\/([^/]+)\/(publish|unpublish)$/);
    if (publishMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(publishMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const tournament = deps.store.tournament(tournamentId);
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const updated = deps.store.setPublished(tournamentId, publishMatch[2] === "publish", now);
      return { status: 200, body: { tournament: clientTournament(updated, deps.store.entrants(tournamentId), auth) } };
    }

    const finishMatch = path.match(/^\/api\/tournaments\/([^/]+)\/finish$/);
    if (finishMatch && method === "POST") {
      const identity = authenticated(auth);
      const tournamentId = decoded(finishMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      const tournament = deps.store.tournament(tournamentId);
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const finished = deps.store.finishTournament(tournamentId, now);
      return { status: 200, body: { tournament: clientTournament(finished, deps.store.entrants(tournamentId), auth) } };
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
      // Registration (lane L4): the public facts (open, places left from accepted entries only), check-in times, and for
      // a signed-in coach their own entry in any state (pending / waitlisted / declined entries are never in `entrants`).
      const round1 = deps.store.rounds(tournament.id).some((round) => round.number === 1);
      const everyEntry = auth ? deps.store.registrationEntries(tournament.id) : [];
      const codes = auth ? referenceCodes(everyEntry) : new Map<string, string>();
      const myRegistration = auth ? myRegistrationView(deps, tournament, everyEntry, auth.coach) : undefined;
      const checkIn = checkInView(tournament, round1, now);
      return {
        status: 200,
        body: {
          tournament: clientTournament(tournament, entrants, auth),
          ...(series ? { series } : {}),
          registrationStatus: registrationStatusView(tournament, entrants, round1, now),
          ...(checkIn ? { checkIn } : {}),
          ...(myRegistration ? { myRegistration } : {}),
          entrants: entrants.map((entrant) => {
            const private_ = manager || (auth !== undefined && coachKey(auth.coach) === coachKey(entrant.coach.ffbCoachId));
            return clientEntrant(
              entrant,
              deps,
              private_,
              shared.get(entrant.id),
              tournament,
              entrant.droppedAt === undefined ? profiles.get(coachKey(entrant.coach.ffbCoachId)) : undefined,
              private_ ? codes.get(entrant.id) : undefined,
            );
          }),
          rounds: deps.store.rounds(tournament.id),
          standings: deps.store.standings(tournament.id),
          scheduledMatches,
          activity: visibleActivity(tournament, deps.store, auth, Boolean(auth && (auth.organizer || manager || entered))),
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
      // The field or (lane L4) a pending / waitlisted entry: a held coach answers too.
      const entrant = deps.store.liveEntry(tournament.id, entrantId);
      if (!entrant) return { status: 404, body: { error: "No active entry with that id." } };
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
      const held = lobbyHold(deps, matchId);
      if (held) return held;
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
      const held = input.status === "launch_failed" ? undefined : lobbyHold(deps, matchId);
      if (held) return held;
      const match = deps.store.recordLaunch(matchId, {
        expectedRevision: integer(input.revision, "revision"),
        status: input.status as "launching" | "launched" | "launch_failed",
        ...(typeof input.gameName === "string" ? { gameName: input.gameName } : {}),
        ...(typeof input.gameId === "string" ? { gameId: input.gameId } : {}),
        ...(typeof input.error === "string" ? { error: input.error } : {}),
      }, now);
      return { status: 200, body: { match: clientMatch(deps.store, match, identity, now, deps.teamBuild) } };
    }

    // Organiser result edit (owner ruling 10-29 §7): managers of the tournament override or clear a recorded result.
    //   PATCH /api/tournaments/:id/fixtures/:mid/result        { revision, homeScore, awayScore, homeCasualties?, awayCasualties?, reason?, confirmFinished? }
    //   POST  /api/tournaments/:id/fixtures/:mid/result/clear  { revision, reason?, confirmFinished? }
    // revision = the fixture's (body or If-Match): 428 missing, 409 stale. CSRF and onboarding run in server.ts.
    const editMatch = path.match(/^\/api\/tournaments\/([^/]+)\/fixtures\/([^/]+)\/result(\/clear)?$/);
    if (editMatch && ((method === "PATCH" && !editMatch[3]) || (method === "POST" && editMatch[3]))) {
      const identity = authenticated(auth);
      const tournamentId = decoded(editMatch[1]!);
      const matchId = decoded(editMatch[2]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      requireTournamentManager(tournament, identity);
      const existing = matchId ? deps.store.match(matchId) : undefined;
      if (!existing || existing.tournamentId !== tournament.id) return { status: 404, body: { error: "Fixture not found." } };
      const input = jsonObject(body);
      const common = {
        expectedRevision: editRevision(input, deps.ifMatch),
        by: identity.coach,
        ...(editReason(input.reason) ? { reason: editReason(input.reason)! } : {}),
        confirmFinished: input.confirmFinished === true,
      };
      const optional = (field: "homeCasualties" | "awayCasualties") =>
        input[field] === undefined || input[field] === null ? {} : { [field]: integer(input[field], field) };
      const { match } = editMatch[3]
        ? deps.store.clearEditedResult(existing.id, common, now)
        : deps.store.editResult(existing.id, {
          ...common,
          homeScore: integer(input.homeScore, "homeScore"),
          awayScore: integer(input.awayScore, "awayScore"),
          ...optional("homeCasualties"),
          ...optional("awayCasualties"),
        }, now);
      notifyResultEdit(deps, match, identity.coach);
      return { status: 200, body: { match: clientMatch(deps.store, match, identity, now, deps.teamBuild) } };
    }

    // Organiser score entry for a fixture with no result yet (a game played on the fork or at the table whose result
    // did not arrive through the recorder): that tournament's managers only. A recorded result is never overwritten
    // here (store: 409); changing one goes through the edit route above (manager check, guards, audit, notifications).
    const resultMatch = path.match(/^\/api\/scheduled-matches\/([^/]+)\/result$/);
    if (resultMatch && method === "PATCH") {
      const identity = authenticated(auth);
      const matchId = decoded(resultMatch[1]!);
      if (!matchId) return { status: 400, body: { error: "Invalid scheduled match id." } };
      const existing = deps.store.match(matchId);
      const owning = existing ? deps.store.tournament(existing.tournamentId) : undefined;
      if (!existing || !owning) return { status: 404, body: { error: "Scheduled match not found." } };
      requireTournamentManager(owning, identity);
      const input = jsonObject(body);
      const match = deps.store.recordResult(matchId, {
        expectedRevision: integer(input.revision, "revision"),
        homeScore: integer(input.homeScore, "homeScore"),
        awayScore: integer(input.awayScore, "awayScore"),
        ...(input.homeCasualties === undefined ? {} : { homeCasualties: integer(input.homeCasualties, "homeCasualties") }),
        ...(input.awayCasualties === undefined ? {} : { awayCasualties: integer(input.awayCasualties, "awayCasualties") }),
        // an organiser's typed-in score: marked manual so Discord never announces it (owner round 3)
        manual: true,
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
    // The registration core's refusals carry a stable code the SPA can switch on (closed, full, declined...).
    if (error instanceof RegistrationError) return { status: error.status, body: { error: error.message, code: error.code } };
    throw error;
  }
}

/** A fixture with a fixture lobby launches only after the lobby's START (as league fixtures, src/leagues/forkPlay.ts).
 *  Fixtures nobody opened a lobby for keep the old path. Fails closed when the lobby cannot be read. */
function lobbyHold(deps: TournamentApiDeps, matchId: string): TournamentApiResult | undefined {
  if (!deps.fixtureLobby) return undefined;
  let lobby: { started: boolean } | undefined;
  try { lobby = deps.fixtureLobby(matchId); } catch { return { status: 500, body: { error: "Could not read the fixture lobby right now." } }; }
  return lobby && !lobby.started ? { status: 409, body: { error: "Start this match from the fixture lobby first." } } : undefined;
}

export function entrantByCoach(entrants: readonly TournamentEntrantRecord[], coach: string): TournamentEntrantRecord | undefined {
  return entrants.find((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(coach));
}

// ---- registration routes (lane L4; registration spec 2026-11-02 §7, wizards v2 check-in / "I've paid") ------------------

const REASON_MAX = 500;

function registrationActor(identity: TournamentApiIdentity): RegistrationActor {
  return { coach: identity.coach, ...(identity.admin ? { admin: true } : {}), ...(identity.test ? { test: true } : {}) };
}

/** The registration service over this request's store, notifier and clock (the per-tournament lock is process-wide). */
export function registrationServiceFor(deps: Pick<TournamentApiDeps, "store" | "notify" | "now" | "identityRecord">, opts: { quietOutcomeFor?: string } = {}) {
  return tournamentRegistrationService(deps.store, {
    ...(deps.now ? { now: deps.now } : {}),
    notify: (coach, input) => {
      // An organiser-made entry: the coach gets the existing "you were entered" notice (share / NAF request) instead.
      if (opts.quietOutcomeFor && input.type === "registration-outcome" && coachKey(coach) === coachKey(opts.quietOutcomeFor)) return;
      quietly(() => deps.notify?.coach(coach, input));
    },
    nafSnapshot: (tournament, record) => {
      const naf = entryNaf(tournament, record, profileNaf(deps, record.coach.ffbCoachId));
      return naf ? { nafNumber: naf.nafNumber, ...(naf.nafName ? { nafName: naf.nafName } : {}) } : undefined;
    },
  });
}

function optionalReason(input: Record<string, unknown>): string | undefined {
  if (input.reason === undefined || input.reason === null) return undefined;
  if (typeof input.reason !== "string") throw new TournamentStoreError(400, "reason must be text.");
  const r = input.reason.trim();
  if ([...r].length > REASON_MAX) throw new TournamentStoreError(400, `reason must be at most ${REASON_MAX} characters.`);
  return r || undefined;
}

const LIVE_STATES = new Set(["pending", "waitlisted", "accepted"]);

/** Other managers hear that an organiser removed (dropped) an accepted entry (the coach is told by the core). */
function notifyRemoval(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string): void {
  quietly(() => deps.notify?.managers(tournament.id, {
    type: "withdrawal",
    title: `${coach} was removed from ${tournament.name}`,
    body: `${actor} removed the entry of ${coach}.`,
    link: `/app/tournaments/${encodeURIComponent(tournament.id)}/manage#tn-reg-h`,
    from: actor,
  }, actor));
}

/** An organiser withdrew a pending or waitlisted entry: the coach is told (as before for any organiser withdrawal). */
function notifyWithdrawnByOrganiser(deps: TournamentApiDeps, tournament: TournamentRecord, coach: string, actor: string): void {
  quietly(() => deps.notify?.coach(coach, {
    type: "withdrawal",
    title: `${tournament.name}: you were withdrawn`,
    body: `An organiser withdrew your entry from ${tournament.name}.`,
    link: tournamentLink(tournament.id, "overview"),
    from: actor,
  }));
}

/** The viewer's own entry in any state (latest submission first), as the coach sees it: their entry card. */
function myRegistrationView(deps: TournamentApiDeps, tournament: TournamentRecord, all: readonly TournamentEntrantRecord[], coach: string) {
  const mine = all.filter((r) => coachKey(r.coach.ffbCoachId) === coachKey(coach))
    .sort((a, b) => b.registeredAt.localeCompare(a.registeredAt))[0];
  if (!mine) return undefined;
  const state = entryStateOf(mine);
  const entries = all.map(toRegistrationEntry);
  const position = waitlistPosition(entries, mine.id);
  const live = LIVE_STATES.has(state);
  const profile = live && tournament.nafSanctioned ? profileNaf(deps, mine.coach.ffbCoachId) : undefined;
  const view = clientEntrant(mine, deps, live, undefined, tournament, profile, live ? referenceCodes(all).get(mine.id) : undefined);
  return {
    ...view,
    state,
    ...(position ? { position } : {}),
    // The coach sees the organisers' reason for a decline or removal (they were told it), never who decided.
    ...(mine.decided?.reason && (state === "declined" || state === "dropped") ? { reason: mine.decided.reason } : {}),
  };
}

/** The public registration facts of a tournament: open or not (and why), the approval mode, places left (accepted
 *  entries only: pending and waitlisted ones are never counted publicly), "roster later" and its deadline. */
function registrationStatusView(tournament: TournamentRecord, field: readonly TournamentEntrantRecord[], round1: boolean, now: Date) {
  const status = selfRegistrationStatus(tournament, round1, now);
  const window = tournamentRegistrationWindow(tournament);
  const accepted = field.filter((e) => e.droppedAt === undefined).length;
  const cap = window.cap;
  return {
    open: status.open,
    ...(status.open ? {} : { reason: status.reason, message: status.message }),
    approval: window.approval,
    waitlist: window.waitlist,
    rosterLater: window.rosterLater === true && !rosterDeadlinePassed(tournament, now),
    ...(window.rosterBy ? { rosterBy: window.rosterBy } : {}),
    ...(window.opensAt ? { opensAt: window.opensAt } : {}),
    ...(window.closesAt ? { closesAt: window.closesAt } : {}),
    cap,
    placesLeft: cap === null ? null : Math.max(0, cap - accepted),
  };
}

async function registrationRoutes(
  method: string,
  path: string,
  auth: TournamentApiIdentity | undefined,
  body: unknown,
  deps: TournamentApiDeps,
  now: Date,
): Promise<TournamentApiResult | undefined> {
  // POST /api/tournaments/:id/entrants  { teamRef: "save:<id>" (a saved team; library refs are refused, owner 11-03) | rosterLater: true,
  //   share?, notNafMember?, nafNumber? (organisers), region?, coach? (organisers), waitlistIfFull? (organisers) }
  const collection = path.match(/^\/api\/tournaments\/([^/]+)\/entrants$/);
  if (collection && method === "POST") {
    const identity = authenticated(auth);
    const tournamentId = decoded(collection[1]!);
    if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
    const input = jsonObject(body);
    const requestedCoach = input.coach;
    if (requestedCoach !== undefined && (typeof requestedCoach !== "string" || !requestedCoach.trim()))
      return { status: 400, body: { error: "coach must be a non-empty string." } };
    const targetCoach = typeof requestedCoach === "string" ? requestedCoach.trim() : identity.coach;
    const self = coachKey(targetCoach) === coachKey(identity.coach);
    const tournament = deps.store.tournament(tournamentId);
    if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
    if (!self) requireTournamentManager(tournament, identity);
    else {
      // Self-entry only while published and inside the registration window (organisers may still add coaches).
      const round1 = deps.store.rounds(tournament.id).some((round) => round.number === 1);
      const window = selfRegistrationStatus(tournament, round1, now);
      if (!window.open) return { status: 409, body: { error: window.message, code: window.reason } };
    }
    if (tournament.unpublished === true) return { status: 409, body: { error: "Registration is not open yet.", code: "unpublished" } };

    // The team: a saved team (Roster Builder save), or none yet ("register now, roster later").
    if (input.rosterLater !== undefined && typeof input.rosterLater !== "boolean")
      return { status: 400, body: { error: "rosterLater must be true or false." } };
    // The older `teamId` body field named a library team: refused like `library:` (owner 11-03).
    if (typeof input.teamId === "string" && input.teamId.trim() && !(typeof input.teamRef === "string" && input.teamRef.trim()))
      return { status: 400, body: { error: LIBRARY_TEAM_REFUSED, code: "library-team" } };
    const teamRef = typeof input.teamRef === "string" && input.teamRef.trim() ? input.teamRef.trim() : "";
    if (teamRef.startsWith("library:")) return { status: 400, body: { error: LIBRARY_TEAM_REFUSED, code: "library-team" } };
    // An organiser adding a coach has no saved team of theirs to attach (only the coach can), so that entry starts without a
    // roster and the coach submits it from My entry; a coach registering themselves needs "Roster later" to do the same.
    const later = !teamRef && (input.rosterLater === true || !self);
    if (!teamRef && !later) return { status: 400, body: { error: "teamRef is required (a saved team, save:<id>)." } };
    if (teamRef && (teamRef.length > 120 || !/^save:[A-Za-z0-9_.:-]+$/.test(teamRef)))
      return { status: 400, body: { error: "teamRef must name a saved team (save:<id>)." } };
    const window = tournamentRegistrationWindow(tournament);
    if (later && self && !window.rosterLater) return { status: 400, body: { error: "This tournament needs your roster when you register.", code: "roster-required" } };
    if (later && self && rosterDeadlinePassed(tournament, now)) return { status: 409, body: { error: "The roster deadline has passed. Register with a team.", code: "roster-deadline" } };

    // Share picker (owner 10-31): only the coach chooses; an organiser-made entry carries no grant.
    let share: ShareField[] = [];
    if (input.share !== undefined) {
      if (!self) return { status: 400, body: { error: "Only the coach can choose what they share." } };
      try { share = parseShareFields(input.share); } catch (e) { return { status: 400, body: { error: (e as ContactValidationError).message } }; }
    }
    // NAF (owner 10-31, profile-first): on a NAF-sanctioned tournament the coach's profile NAF name and number go to the
    // organisers with the entry (derived on read, nothing copied), else the coach says "not a NAF member" (the organisers
    // are told). A number the coach types is not taken there (it belongs on the profile); elsewhere it stays optional.
    if (input.notNafMember !== undefined && typeof input.notNafMember !== "boolean")
      return { status: 400, body: { error: "notNafMember must be true or false." } };
    if (input.nafNumber !== undefined && input.nafNumber !== null && typeof input.nafNumber !== "string")
      return { status: 400, body: { error: "NAF number must be 1 to 10 digits." } };
    const sanctioned = tournament.nafSanctioned === true;
    const notNafMember = sanctioned && input.notNafMember === true;
    const typedNaf = typeof input.nafNumber === "string" ? input.nafNumber.trim() : "";
    const parsedNaf = typedNaf && !notNafMember ? canonicalNafId(typedNaf) : undefined;
    if (typedNaf && !notNafMember && !parsedNaf) return { status: 400, body: { error: "NAF number must be 1 to 10 digits." } };
    const nafNumber = sanctioned && self ? undefined : parsedNaf;
    const profile = sanctioned ? profileNaf(deps, targetCoach) : undefined;
    if (sanctioned && self && !notNafMember && !profile) return { status: 400, body: { error: NAF_REQUIRED_MESSAGE } };
    // An organiser may enter a coach without it, but only the coach says "not a NAF member": the entry owes the answer.
    const nafPending = sanctioned && !self && !nafNumber && !profile;

    // Region (creation wizards v2 Q13): a coach picks one of the organiser's regions when there are any.
    const regions = tournament.regions ?? [];
    let region: string | undefined;
    if (input.region !== undefined && input.region !== null && input.region !== "") {
      if (typeof input.region !== "string" || !regions.includes(input.region.trim()))
        return { status: 400, body: { error: "Pick a region from the organisers' list.", code: "region" } };
      region = input.region.trim();
    } else if (regions.length && self) return { status: 400, body: { error: "Pick your region.", code: "region" } };
    // Club (clubs lane): the coach picks one of their clubs or none; fixed once the entry was accepted (src/clubs/pick.ts).
    if (!self && input.clubId !== undefined && input.clubId !== null && input.clubId !== "") return { status: 400, body: { error: "Only the coach picks the club they represent.", code: "club" } };
    const priorEntry = deps.store.registrationEntries(tournament.id).find((r) => coachKey(r.coach.ffbCoachId) === coachKey(targetCoach));
    const clubPick = resolveClubPick(targetCoach, self ? input.clubId : undefined, priorEntry ? { clubId: priorEntry.clubId, everAccepted: everAccepted(entryStateOf(priorEntry), priorEntry.registrationLog) } : undefined);
    if (!clubPick.ok) return { status: clubPick.status, body: { error: clubPick.error, code: clubPick.code } };

    let teamId = "";
    let submission: TournamentSubmission | undefined;
    if (teamRef.startsWith("save:")) {
      if (!self) return { status: 400, body: { error: "Only the coach can register with their own Roster Builder save." } };
      if (!deps.validateSubmission) return { status: 503, body: { error: "Team validation is unavailable on this host." } };
      const check = deps.validateSubmission(targetCoach, teamRef, tournament.packageName, now, houseRulesOf(tournament, "tournament"));
      if ("error" in check) return { status: check.status ?? 400, body: { error: check.error } };
      submission = check;
      teamId = check.teamId ?? "";
    }

    const record: TournamentEntryData["record"] = {
      coach: { coachId: targetCoach, ffbCoachId: targetCoach, verifiedAt: now.toISOString() },
      teamId,
      flags: { ...DEFAULT_ENTRANT_FLAGS, rosterVerified: submission?.validation.ok ?? false },
      ...(submission ? { submission } : {}),
      ...(nafNumber ? { nafNumber } : {}),
      ...(notNafMember && self ? { notNafMember: true as const } : {}),
      ...(nafPending ? { nafPending: true as const } : {}),
      ...(region ? { region } : {}),
      ...(clubPick.clubId ? { clubId: clubPick.clubId } : {}),
      // Told about NAF with the entry: the coach filled in the NAF block, or (organiser-made) gets the NAF request or the
      // "your profile NAF details are shared" notice in this same request. Every NAF notice path sets this (law 23a).
      ...(sanctioned ? { nafToldAt: now.toISOString() } : {}),
    };
    let result: Awaited<ReturnType<ReturnType<typeof registrationServiceFor>["submit"]>>;
    try {
      result = await registrationServiceFor(deps, self ? {} : { quietOutcomeFor: targetCoach }).submit(tournament.id, targetCoach, registrationActor(identity), {
        data: { record } as unknown as Record<string, unknown>,
        ...(notNafMember && self ? { organiserFlag: "not a NAF member" } : {}),
        ...(!self && input.waitlistIfFull === true ? { waitlistIfFull: true } : {}),
      });
    } catch (error) {
      // The older contract's words for a full tournament without a waitlist.
      if (error instanceof RegistrationError && error.code === "full") return { status: 400, body: { error: "Tournament is full." } };
      throw error;
    }
    if (!result.changed) return { status: 400, body: { error: "Coach is already entered in this tournament." } };
    const stored = deps.store.registrationEntries(tournament.id).find((r) => r.id === result.entry.id);
    if (!stored) return { status: 500, body: { error: "The entry was not saved." } };
    // The grant is written after the entry, so it counts for this submission (src/registration/privacy.ts).
    let sharingSaved = true;
    if (self && deps.sharing) {
      try { deps.sharing.grant(stored.coach.ffbCoachId, `tournament:${tournament.id}`, share, deps.now?.() ?? new Date()); } catch { sharingSaved = false; }
      if (!sharingSaved) notifyShareRequest(deps, tournament, stored.coach.ffbCoachId, identity.coach);
    }
    if (!self) {
      if (stored.nafPending) notifyNafRequest(deps, tournament, stored.coach.ffbCoachId, identity.coach, true);
      else notifyShareRequest(deps, tournament, stored.coach.ffbCoachId, identity.coach, sanctioned && !stored.nafNumber);
    }
    const position = waitlistPosition(deps.store.registrationEntries(tournament.id).map(toRegistrationEntry), stored.id);
    return {
      status: 201,
      body: {
        entrant: withoutNafSnapshot(stored),
        registration: { state: result.entry.state, ...(position ? { position } : {}) },
        ...(sharingSaved ? {} : { sharingSaved: false }),
      },
    };
  }

  // DELETE /api/tournaments/:id/entrants/:eid: the coach withdraws (pending, waitlisted, or accepted until round 1); an
  // organiser withdraws a pending / waitlisted entry or removes an accepted one. A freed place promotes the waitlist (auto).
  const item = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)$/);
  if (item && method === "DELETE") {
    const identity = authenticated(auth);
    const tournamentId = decoded(item[1]!);
    const entrantId = decoded(item[2]!);
    if (!tournamentId || !entrantId) return { status: 400, body: { error: "Invalid tournament entrant path." } };
    const tournament = deps.store.tournament(tournamentId);
    if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
    const record = deps.store.registrationEntries(tournamentId).find((candidate) => candidate.id === entrantId);
    if (!record) return { status: 404, body: { error: "Tournament entrant not found." } };
    const selfDrop = coachKey(record.coach.ffbCoachId) === coachKey(identity.coach);
    if (!selfDrop) requireTournamentManager(tournament, identity);
    const service = registrationServiceFor(deps);
    const actor = registrationActor(identity);
    if (!selfDrop && entryStateOf(record) === "accepted") {
      const result = await service.drop(tournament.id, record.id, actor);
      if (result.changed) notifyRemoval(deps, tournament, record.coach.ffbCoachId, identity.coach);
    } else {
      const result = await service.withdraw(tournament.id, record.id, actor);
      if (result.changed && !selfDrop) notifyWithdrawnByOrganiser(deps, tournament, record.coach.ffbCoachId, identity.coach);
    }
    const after = deps.store.registrationEntries(tournamentId).find((candidate) => candidate.id === entrantId) ?? record;
    return { status: 200, body: { entrant: withoutNafSnapshot(after) } };
  }

  // POST /api/tournaments/:id/entrants/:eid/paid-claim { paid }: the coach's "I've paid" (organisers still tick Paid).
  const claim = path.match(/^\/api\/tournaments\/([^/]+)\/entrants\/([^/]+)\/paid-claim$/);
  if (claim && method === "POST") {
    const identity = authenticated(auth);
    const tournamentId = decoded(claim[1]!);
    const entrantId = decoded(claim[2]!);
    const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
    if (!tournament || !entrantId) return { status: 404, body: { error: "Tournament not found." } };
    const input = jsonObject(body);
    if (typeof input.paid !== "boolean") return { status: 400, body: { error: "paid must be true or false." } };
    const record = deps.store.liveEntry(tournament.id, entrantId);
    if (!record) return { status: 404, body: { error: "No active entry with that id." } };
    if (coachKey(record.coach.ffbCoachId) !== coachKey(identity.coach)) return { status: 403, body: { error: "Only the coach can say they paid." } };
    if (tournament.status === "completed" || tournament.status === "cancelled") return { status: 409, body: { error: "This tournament is closed." } };
    ensureReferenceCodes(deps.store, tournament.id);
    const { entrant: updated, notify } = deps.store.setCoachSaysPaid(tournament.id, record.id, input.paid, now);
    const code = referenceCodes(deps.store.registrationEntries(tournament.id)).get(record.id);
    if (notify) {
      quietly(() => deps.notify?.managers(tournament.id, {
        type: "registration",
        title: `${record.coach.ffbCoachId} says they paid: ${tournament.name}`,
        body: `${code ? `Reference ${code}. ` : ""}Check the payment, then tick Paid in Participants.`,
        link: `/app/tournaments/${encodeURIComponent(tournament.id)}/manage#tn-part-h`,
        from: identity.coach,
      }, identity.coach));
    }
    return { status: 200, body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, undefined, code) } };
  }

  // POST /api/tournaments/:id/check-in: the coach checks themselves in during the check-in window (self check-in on).
  const checkIn = path.match(/^\/api\/tournaments\/([^/]+)\/check-in$/);
  if (checkIn && method === "POST") {
    const identity = authenticated(auth);
    const tournamentId = decoded(checkIn[1]!);
    const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
    if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
    const entrant = deps.store.entrants(tournament.id).find((e) => e.droppedAt === undefined && coachKey(e.coach.ffbCoachId) === coachKey(identity.coach));
    if (!entrant) return { status: 403, body: { error: "Only coaches in the field can check in." } };
    const round1 = deps.store.rounds(tournament.id).some((round) => round.number === 1);
    const competition = tournamentCompetition(tournament, round1);
    if (competition.window.checkIn?.self === false) return { status: 409, body: { error: "The organisers check coaches in for this tournament.", code: "organiser-check-in" } };
    if (!isCheckInOpen(competition, now)) return { status: 409, body: { error: "Check-in is not open.", code: "check-in-closed" } };
    const updated = deps.store.checkInEntrant(tournament.id, entrant.id, identity.coach, now);
    return { status: 200, body: { entrant: clientEntrant(updated, deps, true, undefined, tournament, undefined, referenceCodes(deps.store.registrationEntries(tournament.id)).get(entrant.id)) } };
  }

  // GET /api/tournaments/:id/registrations (this tournament's managers and admins): the Registrations panel.
  const list = path.match(/^\/api\/tournaments\/([^/]+)\/registrations$/);
  if (list && method === "GET") {
    const identity = authenticated(auth);
    const tournamentId = decoded(list[1]!);
    const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
    if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
    requireTournamentManager(tournament, identity);
    const all = deps.store.registrationEntries(tournament.id);
    const entries = all.map(toRegistrationEntry);
    const window = tournamentRegistrationWindow(tournament);
    const managers = tournamentCompetition(tournament, false).managers;
    const codes = referenceCodes(all);
    const live = all.filter((r) => LIVE_STATES.has(entryStateOf(r)));
    let contacts: Array<SharedContact | undefined> = [];
    try {
      contacts = deps.sharing?.registrationContacts?.(identity, live.map(toRegistrationEntry), managers) ?? [];
    } catch { contacts = []; }
    const shared = new Map(live.map((r, i) => [r.id, contacts[i]] as const));
    // Profile NAF details only for entries whose coach knows they go to the organisers: the field (told on entry or when
    // the tournament was sanctioned), and held entries marked told (law 23a).
    const nafVisible = (r: TournamentEntrantRecord) => entryStateOf(r) === "accepted" || Boolean(r.nafToldAt);
    const profiles = tournament.nafSanctioned ? profileNafs(deps, live.filter(nafVisible).map((r) => r.coach.ffbCoachId)) : new Map<string, ProfileNaf>();
    const order = waitlistOrder(entries);
    const nextInLine = order[0]?.id;
    const rank = new Map(order.map((e, i) => [e.id, i + 1]));
    const teamNameOf = (r: TournamentEntrantRecord) => stringField(deps.teamBuild(r.teamId), "teamName") ?? r.submission?.teamName;
    const rows = all.map((record) => {
      const state = entryStateOf(record);
      const entry = toRegistrationEntry(record);
      if (!LIVE_STATES.has(state)) {
        // Declined, withdrawn, removed: the decision only, never what the coach shared.
        const teamName = teamNameOf(record);
        return {
          id: record.id, coachId: record.coach.ffbCoachId, state, enteredAt: entry.enteredAt,
          ...(teamName ? { teamName } : {}),
          ...(record.decided ? { decided: { ...record.decided } } : {}),
        };
      }
      return {
        ...clientEntrant(record, deps, true, shared.get(record.id), tournament, profiles.get(coachKey(record.coach.ffbCoachId)), codes.get(record.id)),
        // Profile NAF details withheld (coach not told yet): "NAF pending" is what the entry stores, not derived from the
        // missing profile.
        ...(tournament.nafSanctioned && !nafVisible(record) ? { nafPending: record.nafPending === true } : {}),
        state,
        submittedAt: entry.submittedAt,
        enteredAt: entry.enteredAt,
        ...(rank.has(record.id) ? { position: rank.get(record.id)! } : {}),
        ...(record.id === nextInLine ? { nextInLine: true } : {}),
        ...(record.decided ? { decided: { ...record.decided } } : {}),
      };
    });
    const stateRank: Record<string, number> = { pending: 0, waitlisted: 1, accepted: 2, declined: 3, withdrawn: 4, dropped: 5 };
    const pos = (row: object) => (row as { position?: number }).position ?? 0;
    rows.sort((a, b) => (stateRank[a.state] ?? 9) - (stateRank[b.state] ?? 9) || pos(a) - pos(b) || a.enteredAt.localeCompare(b.enteredAt));
    const round1 = deps.store.rounds(tournament.id).some((round) => round.number === 1);
    const checkInNow = checkInView(tournament, round1, now);
    const field = deps.store.entrants(tournament.id).filter((e) => e.droppedAt === undefined);
    const checkedIn = field.filter((e) => e.flags?.checkedIn === true).length;
    // At check-in close (before round 1): who has not checked in. Removing one is the organiser's call, never automatic.
    const noShows = checkInNow?.closed && !round1
      ? field.filter((e) => e.flags?.checkedIn !== true).map((e) => {
        const teamName = teamNameOf(e);
        return { id: e.id, coachId: e.coach.ffbCoachId, ...(teamName ? { teamName } : {}) };
      })
      : [];
    return {
      status: 200,
      headers: { "cache-control": "private, no-store" },
      body: {
        counts: registrationCounts(window, entries),
        settings: {
          approval: window.approval, waitlist: window.waitlist, rosterLater: window.rosterLater === true,
          ...(window.rosterBy ? { rosterBy: window.rosterBy } : {}), selfCheckIn: window.checkIn?.self !== false,
        },
        entries: rows,
        ...(checkInNow ? { checkIn: { ...checkInNow, checkedIn, total: field.length } } : {}),
        noShows,
      },
    };
  }

  // POST /api/tournaments/:id/registrations/:eid/(accept|waitlist|decline|promote|remove) { reason?, promote? }: managers.
  const action = path.match(/^\/api\/tournaments\/([^/]+)\/registrations\/([^/]+)\/(accept|waitlist|decline|promote|remove)$/);
  if (action && method === "POST") {
    const identity = authenticated(auth);
    const tournamentId = decoded(action[1]!);
    const entrantId = decoded(action[2]!);
    const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
    if (!tournament || !entrantId) return { status: 404, body: { error: "Tournament not found." } };
    requireTournamentManager(tournament, identity);
    const input = body === undefined || body === null ? {} : jsonObject(body);
    const reason = optionalReason(input);
    if (input.promote !== undefined && typeof input.promote !== "boolean") return { status: 400, body: { error: "promote must be true or false." } };
    const service = registrationServiceFor(deps);
    const actor = registrationActor(identity);
    const verb = action[3]!;
    // The entry must belong to THIS tournament: the core looks it up among this tournament's entries only (404 otherwise).
    let result: Awaited<ReturnType<typeof service.accept>>;
    const promoted: RegistrationEntry[] = [];
    if (verb === "accept" || verb === "promote") result = await service.accept(tournament.id, entrantId, actor, reason);
    else if (verb === "waitlist") result = await service.waitlist(tournament.id, entrantId, actor, reason);
    else if (verb === "decline") result = await service.decline(tournament.id, entrantId, actor, reason);
    else {
      // "Remove and promote waitlist" (no-shows): in organiser mode the next in line who fits is accepted in the same
      // lock as the removal (auto mode promotes on its own), so concurrent removals each fill their own place once.
      result = await service.drop(tournament.id, entrantId, actor, reason, { promoteNext: input.promote === true });
      if (result.changed) {
        notifyRemoval(deps, tournament, result.entry.coach, identity.coach);
        promoted.push(...result.promoted);
      }
    }
    return {
      status: 200,
      body: {
        entry: { id: result.entry.id, coachId: result.entry.coach, state: result.entry.state },
        changed: result.changed,
        promoted: promoted.map((p) => ({ id: p.id, coachId: p.coach, state: p.state })),
      },
    };
  }

  return undefined;
}
