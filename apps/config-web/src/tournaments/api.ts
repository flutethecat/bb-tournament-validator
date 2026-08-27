import { generateSwissPairings } from "./pairing.js";
import { TournamentStore, TournamentStoreError } from "./store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, VerifiedCoachIdentity } from "./types.js";

export interface TournamentApiIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
}

export interface TournamentApiDeps {
  store: TournamentStore;
  teamBuild(teamId: string): unknown | undefined;
  now?: () => Date;
}

export interface TournamentApiResult {
  status: number;
  body: unknown;
}

const coachKey = (value: string): string => value.trim().toLowerCase();

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

function authenticated(auth: TournamentApiIdentity | undefined): TournamentApiIdentity {
  if (!auth) throw new TournamentStoreError(401, "Authentication required.");
  return auth;
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
  const pair = generateSwissPairings(entrants, matches, tournament.points, tournament.tiebreakers)
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
  // `/api/fork/tournaments` is the Tauri-facing spelling; keep the shorter portal spelling too.
  path = path.replace(/^\/api\/fork\/tournaments(?=\/|$)/, "/api/tournaments");
  const now = deps.now?.() ?? new Date();
  try {
    if (path === "/api/tournaments" && method === "GET") {
      const tournaments = deps.store.activeTournaments().map((tournament) => ({
        ...tournament,
        entrantCount: deps.store.entrants(tournament.id).filter((entrant) => entrant.droppedAt === undefined).length,
      }));
      return { status: 200, body: { tournaments } };
    }

    const standingsMatch = path.match(/^\/api\/tournaments\/([^/]+)\/standings$/);
    if (standingsMatch && method === "GET") {
      const tournamentId = decoded(standingsMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      return { status: 200, body: { tournamentId, standings: deps.store.standings(tournamentId) } };
    }

    const detailMatch = path.match(/^\/api\/tournaments\/([^/]+)$/);
    if (detailMatch && method === "GET") {
      const tournamentId = decoded(detailMatch[1]!);
      const tournament = tournamentId ? deps.store.tournament(tournamentId) : undefined;
      if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
      const scheduledMatches = auth
        ? deps.store.matches(tournament.id)
          .filter((match) => auth.organizer || isParticipant(match, auth.coach))
          .map((match) => clientMatch(deps.store, match, auth, now, deps.teamBuild))
        : [];
      return {
        status: 200,
        body: {
          tournament,
          entrants: deps.store.entrants(tournament.id).map(({ coach, ...entrant }) => {
            const team = deps.teamBuild(entrant.teamId);
            return {
              ...entrant,
              entrantId: entrant.id,
              coachId: coach.ffbCoachId,
              coach: { coachId: coach.coachId, ffbCoachId: coach.ffbCoachId },
              ...(stringField(team, "teamName") ? { teamName: stringField(team, "teamName") } : {}),
              ...(stringField(team, "race") ? { race: stringField(team, "race") } : {}),
              ...(stringField(team, "logoUrl") ? { logoUrl: stringField(team, "logoUrl") } : {}),
            };
          }),
          rounds: deps.store.rounds(tournament.id),
          standings: deps.store.standings(tournament.id),
          scheduledMatches,
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
      const mayRead = identity.organizer || coachKey(identity.coach) === coachKey(entrant.coach.ffbCoachId);
      if (!mayRead) return { status: 403, body: { error: "You may fetch only your own tournament build." } };
      const team = deps.teamBuild(entrant.teamId);
      if (!team) return { status: 404, body: { error: "Tournament team build not found." } };
      return {
        status: 200,
        body: {
          tournamentId,
          entrantId,
          team,
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
      if (!identity.organizer) return { status: 403, body: { error: "Organizer access required." } };
      const tournamentId = decoded(roundMatch[1]!);
      if (!tournamentId) return { status: 400, body: { error: "Invalid tournament id." } };
      return { status: 201, body: { round: deps.store.generateNextRound(tournamentId, now) } };
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
