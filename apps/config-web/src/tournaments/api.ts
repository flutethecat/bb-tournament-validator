import { bb2025 } from "@bb/validator/dataset";
import { generateTournamentPairings } from "./pairing.js";
import { NafExportError, renderNafTournamentXml } from "./nafExport.js";
import { isTournamentManager, tournamentOwner, TournamentStore, TournamentStoreError, type TournamentUpdate } from "./store.js";
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

export interface TournamentApiIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
}

export interface TournamentApiDeps {
  store: TournamentStore;
  teamBuild(teamId: string, coachId?: string): unknown | undefined;
  identityRecord?(coachId: string): {
    ffbCoachId: string;
    identities: { nafName?: string; nafId?: string };
  } | undefined;
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
  now?: () => Date;
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
function clientEntrant(entrant: TournamentEntrantRecord, deps: Pick<TournamentApiDeps, "teamBuild">, private_: boolean) {
  const { coach, submission: _submission, flags, rosterVerifiedOverride, manualSeed, ...rest } = entrant;
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
    } : {}),
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
  const { startsAt, endsAt, ...record } = tournament;
  const ownEntrant = auth
    ? entrants.find((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(auth.coach))
    : undefined;
  return {
    ...record,
    turnTimer: tournament.turnTimer ?? DEFAULT_TOURNAMENT_TURN_TIMER,
    inducementOptIns: tournament.inducementOptIns ?? [],
    ...(startsAt === undefined ? {} : { startsAt }),
    ...(endsAt === undefined ? {} : { endsAt }),
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
          }, now),
        },
      };
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
      const requestedPage = Number(query.get("page"));
      const page = Number.isSafeInteger(requestedPage) && requestedPage >= 1 ? requestedPage : 1;
      const total = filtered.length;
      const offset = (page - 1) * TOURNAMENT_PAGE_SIZE;
      const tournaments = filtered
        .slice(offset, offset + TOURNAMENT_PAGE_SIZE)
        .map((tournament) => clientTournament(tournament, deps.store.entrants(tournament.id), auth));
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
      if (tournament.rostersLockedAt || entrant.flags?.frozen)
        return { status: 409, body: { error: "Rosters are locked; ask an organiser to unlock them before resubmitting." } };
      if (!deps.validateSubmission) return { status: 503, body: { error: "Team validation is unavailable on this host." } };
      const check = deps.validateSubmission(entrant.coach.ffbCoachId, saveId, tournament.packageName, now);
      if ("error" in check) return { status: check.status ?? 400, body: { error: check.error } };
      const updated = deps.store.submitTeam(tournament.id, entrant.id, check, now);
      return {
        status: 201,
        body: { entrant: clientEntrant(updated, deps, true), submission: submissionView(updated, true) },
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
      const updated = deps.store.updateEntrant(tournament.id, entrantId, {
        flags: flags as Partial<TournamentEntrantFlags>,
        ...(input.manualSeed === undefined ? {} : { manualSeed: input.manualSeed as number | null }),
      }, now);
      return { status: 200, body: { entrant: clientEntrant(updated, deps, true) } };
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
      if (coachKey(targetCoach) !== coachKey(identity.coach)) {
        const tournament = deps.store.tournament(tournamentId);
        if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
        requireTournamentManager(tournament, identity);
      }
      const teamId = input.teamId.trim();
      const owner = deps.teamOwner?.(teamId);
      if (!owner || coachKey(owner) !== coachKey(targetCoach))
        return { status: 400, body: { error: "Team is not owned by the target coach." } };
      const entrant = deps.store.registerEntrant(tournamentId, {
        coachId: targetCoach,
        ffbCoachId: targetCoach,
        verifiedAt: now.toISOString(),
      }, teamId, now);
      return { status: 201, body: { entrant } };
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
      return {
        status: 200,
        body: { entrant: deps.store.dropEntrant(tournamentId, entrantId, identity.coach, !selfDrop, now) },
      };
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
      const tournament = deps.store.updateTournament(tournamentId, patch, now);
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
            entrants: deps.store.entrants(tournament.id),
            rounds: deps.store.rounds(tournament.id),
            standings,
            matches: deps.store.matches(tournament.id),
          },
        };
      }
      if (format === "naf") {
        if (!deps.identityRecord)
          return { status: 503, body: { error: "Canonical identity storage is unavailable." } };
        try {
          return {
            status: 200,
            headers,
            contentType: "application/xml; charset=utf-8",
            body: renderNafTournamentXml({
              tournament,
              organizerCoachId: tournament.organizerCoachId ?? identity.coach,
              entrants: deps.store.entrants(tournament.id),
              matches: deps.store.matches(tournament.id),
              identityRecord: deps.identityRecord,
              teamBuild: deps.teamBuild,
            }),
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
      return {
        status: 200,
        body: {
          tournament: clientTournament(tournament, entrants, auth),
          entrants: entrants.map((entrant) => clientEntrant(
            entrant,
            deps,
            manager || (auth !== undefined && coachKey(auth.coach) === coachKey(entrant.coach.ffbCoachId)),
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
      return { status: 200, body: { round: deps.store.generateNextRound(tournamentId, now, deps.coachRating, options) } };
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
      const audience = deps.store.notificationAudience(matchId, now).map((coach) => ({
        coachId: coach.ffbCoachId,
        ...(coach.discordUserId ? { discordUserId: coach.discordUserId } : {}),
      }));
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
