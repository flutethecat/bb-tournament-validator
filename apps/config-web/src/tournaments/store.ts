import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { calculateStandings, generateTournamentPairings, stableTieFlip } from "./pairing.js";
import type {
  ScheduledMatchRecord,
  TournamentDataFileV2,
  TournamentDataFileV3,
  TournamentEntrantRecord,
  TournamentPrimaryTiebreaker,
  TournamentRecord,
  TournamentRoundRecord,
  VerifiedCoachIdentity,
  WaitingPresenceLease,
} from "./types.js";

export const DEFAULT_WAITING_LEASE_MS = 45_000;
export const MIN_WAITING_LEASE_MS = 15_000;
export const MAX_WAITING_LEASE_MS = 5 * 60_000;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const tiebreakerLadder = (primary: TournamentPrimaryTiebreaker): TournamentRecord["tiebreakers"] =>
  [primary, "touchdownDifferential", "casualtyDifferential"];

type TournamentUpdate = Partial<Pick<TournamentRecord, "maxPlayers" | "format" | "packageName" | "startsAt" | "roundCount" | "organizerCoachId">> & {
  primaryTiebreaker?: TournamentPrimaryTiebreaker;
};

type LegacyTournamentRecord = Omit<TournamentRecord, "format" | "packageName" | "maxPlayers"> &
  Partial<Pick<TournamentRecord, "format" | "packageName" | "maxPlayers">>;

type TournamentDataFileV1 = Partial<Omit<TournamentDataFileV2, "version" | "waitingPresence" | "tournaments">> & {
  version: 1;
  tournaments?: LegacyTournamentRecord[] | Record<string, LegacyTournamentRecord>;
  entrants?: TournamentEntrantRecord[] | Record<string, TournamentEntrantRecord>;
  rounds?: TournamentRoundRecord[] | Record<string, TournamentRoundRecord>;
  scheduledMatches?: ScheduledMatchRecord[] | Record<string, ScheduledMatchRecord>;
};

const emptyData = (): TournamentDataFileV3 => ({
  version: 3,
  tournaments: {},
  entrants: {},
  rounds: {},
  standings: {},
  scheduledMatches: {},
  waitingPresence: {},
});

const keyed = <T extends { id: string }>(value: T[] | Record<string, T> | undefined): Record<string, T> =>
  Array.isArray(value) ? Object.fromEntries(value.map((item) => [item.id, item])) : { ...(value ?? {}) };

const normalizedTournaments = (
  value: LegacyTournamentRecord[] | Record<string, LegacyTournamentRecord> | undefined,
): Record<string, TournamentRecord> => Object.fromEntries(
  Object.entries(keyed(value)).map(([id, tournament]) => [id, {
    ...tournament,
    format: tournament.format ?? "swiss",
    packageName: tournament.packageName ?? "",
    maxPlayers: tournament.maxPlayers ?? 0,
    roundCountExplicit: tournament.roundCountExplicit === true,
  }]),
);

/** Runtime migration: V1/V2 remain readable and are atomically rewritten as V3 on the next store mutation. */
export function migrateTournamentData(value: unknown): TournamentDataFileV3 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tournament data must be an object.");
  const parsed = value as TournamentDataFileV1 | TournamentDataFileV2 | TournamentDataFileV3;
  if (parsed.version === 1) {
    return {
      version: 3,
      tournaments: normalizedTournaments(parsed.tournaments),
      entrants: keyed(parsed.entrants),
      rounds: keyed(parsed.rounds),
      standings: {},
      scheduledMatches: keyed(parsed.scheduledMatches),
      waitingPresence: {},
    };
  }
  if (parsed.version !== 2 && parsed.version !== 3) throw new Error("Unsupported tournament data version.");
  for (const field of ["tournaments", "entrants", "rounds", "standings", "scheduledMatches", "waitingPresence"] as const) {
    if (!parsed[field] || typeof parsed[field] !== "object" || Array.isArray(parsed[field]))
      throw new Error(`Tournament data ${field} must be an object.`);
  }
  return {
    ...structuredClone(parsed),
    version: 3,
    tournaments: normalizedTournaments(parsed.tournaments as unknown as Record<string, LegacyTournamentRecord>),
  };
}

const coachKey = (value: string): string => value.trim().toLowerCase();
const leaseKey = (matchId: string, coachId: string): string => `${matchId}\0${coachKey(coachId)}`;

function assertId(value: string, label: string): void {
  if (!value.trim() || value.length > 120 || !/^[A-Za-z0-9_.:-]+$/.test(value))
    throw new Error(`${label} must contain only letters, digits, dot, underscore, colon, or dash.`);
}

function assertVerifiedCoach(identity: VerifiedCoachIdentity): void {
  assertId(identity.coachId, "coachId");
  if (!identity.ffbCoachId.trim()) throw new Error("ffbCoachId is required.");
  if (!Number.isFinite(Date.parse(identity.verifiedAt))) throw new Error("verifiedAt must be an ISO timestamp.");
}

function participants(match: ScheduledMatchRecord): VerifiedCoachIdentity[] {
  return [match.home.coach, ...(match.away ? [match.away.coach] : [])];
}

export class TournamentStoreError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409, message: string) {
    super(message);
  }
}

export class TournamentStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tournaments.json");
  }

  snapshot(): TournamentDataFileV3 {
    if (!existsSync(this.file)) return emptyData();
    return migrateTournamentData(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
  }

  /** Intended for migrations, administrative import, and deterministic tests. */
  writeSnapshot(value: TournamentDataFileV2 | TournamentDataFileV3): TournamentDataFileV3 {
    const normalized = migrateTournamentData(value);
    atomicWriteTextFile(this.file, `${JSON.stringify(normalized, null, 2)}\n`);
    return structuredClone(normalized);
  }

  private mutate<T>(change: (data: TournamentDataFileV3) => T): T {
    const data = this.snapshot();
    const result = change(data);
    this.writeSnapshot(data);
    return structuredClone(result);
  }

  activeTournaments(): TournamentRecord[] {
    return Object.values(this.snapshot().tournaments)
      .filter((tournament) => tournament.status === "active")
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  tournaments(statuses: readonly TournamentRecord["status"][]): TournamentRecord[] {
    const allowed = new Set(statuses);
    return Object.values(this.snapshot().tournaments)
      .filter((tournament) => allowed.has(tournament.status))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  }

  createTournament(
    input: Pick<TournamentRecord, "name" | "packageName" | "maxPlayers" | "format"> & {
      organizerCoachId: string;
      primaryTiebreaker?: TournamentPrimaryTiebreaker;
      roundCount?: number;
    },
    now = new Date(),
  ): TournamentRecord {
    return this.mutate((data) => {
      if (input.roundCount !== undefined &&
        (input.format !== "swiss" || input.roundCount < 1 || input.roundCount > 50)) {
        throw new TournamentStoreError(400, input.format !== "swiss"
          ? "roundCount can be set only for Swiss tournaments."
          : "roundCount must be between 1 and 50.");
      }
      const timestamp = now.toISOString();
      const organizerCoachId = input.organizerCoachId.trim();
      if (!organizerCoachId || organizerCoachId.length > 40)
        throw new TournamentStoreError(400, "organizerCoachId must be a non-empty coach id of at most 40 characters.");
      const record: TournamentRecord = {
        id: randomUUID(),
        name: input.name,
        status: "draft",
        format: input.format,
        packageName: input.packageName,
        maxPlayers: input.maxPlayers,
        roundCount: input.roundCount ?? (input.format === "roundRobin"
          ? input.maxPlayers - (input.maxPlayers % 2 === 0 ? 1 : 0)
          : Math.max(1, Math.ceil(Math.log2(input.maxPlayers)))),
        roundCountExplicit: input.roundCount !== undefined,
        currentRound: 0,
        tiebreakers: tiebreakerLadder(input.primaryTiebreaker ?? "buchholz"),
        points: { win: 3, draw: 1, loss: 0, bye: 3 },
        organizerCoachId,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.tournaments[record.id] = record;
      return record;
    });
  }

  updateTournament(
    tournamentId: string,
    patch: TournamentUpdate,
    now = new Date(),
  ): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (patch.primaryTiebreaker !== undefined && tournament.status === "completed")
        throw new TournamentStoreError(400, "Ranking is locked once the tournament is completed.");
      const entrantCount = Object.values(data.entrants)
        .filter((entrant) => entrant.tournamentId === tournamentId && entrant.droppedAt === undefined).length;
      if (patch.maxPlayers !== undefined && patch.maxPlayers < entrantCount)
        throw new TournamentStoreError(400, `maxPlayers cannot be below the current non-dropped entrant count of ${entrantCount}.`);
      if (patch.maxPlayers !== undefined && patch.maxPlayers < 2)
        throw new TournamentStoreError(400, "maxPlayers must be at least 2.");
      const resultingFormat = patch.format ?? tournament.format;
      if (patch.roundCount !== undefined) {
        if (resultingFormat !== "swiss")
          throw new TournamentStoreError(400, "roundCount can be set only for Swiss tournaments.");
        if (patch.roundCount < 1 || patch.roundCount < tournament.currentRound || patch.roundCount > 50)
          throw new TournamentStoreError(400, `roundCount must be between ${Math.max(1, tournament.currentRound)} and 50.`);
      }
      const hasRounds = Object.values(data.rounds).some((round) => round.tournamentId === tournamentId);
      if (patch.format !== undefined && hasRounds)
        throw new TournamentStoreError(400, "Format is locked once rounds exist.");
      if (patch.packageName !== undefined && hasRounds)
        throw new TournamentStoreError(400, "Ruleset is locked once rounds exist.");
      if (patch.startsAt !== undefined && patch.startsAt !== "" &&
        (!ISO_DATE_TIME.test(patch.startsAt) || !Number.isFinite(Date.parse(patch.startsAt))))
        throw new TournamentStoreError(400, "startsAt must be an ISO-8601 timestamp.");
      if (patch.organizerCoachId !== undefined && (!patch.organizerCoachId.trim() || patch.organizerCoachId.trim().length > 40))
        throw new TournamentStoreError(400, "organizerCoachId must be a non-empty coach id of at most 40 characters.");
      if (patch.maxPlayers !== undefined) tournament.maxPlayers = patch.maxPlayers;
      if (patch.format !== undefined) tournament.format = patch.format;
      if (patch.packageName !== undefined) tournament.packageName = patch.packageName;
      if (patch.primaryTiebreaker !== undefined) {
        tournament.tiebreakers = tiebreakerLadder(patch.primaryTiebreaker);
        delete data.standings[tournamentId];
      }
      if (patch.startsAt === "") delete tournament.startsAt;
      else if (patch.startsAt !== undefined) tournament.startsAt = patch.startsAt;
      if (patch.organizerCoachId !== undefined) tournament.organizerCoachId = patch.organizerCoachId.trim();
      if (patch.roundCount !== undefined) {
        tournament.roundCount = patch.roundCount;
        tournament.roundCountExplicit = true;
      } else if (!hasRounds && (patch.maxPlayers !== undefined || patch.format !== undefined) &&
        (tournament.format !== "swiss" || tournament.roundCountExplicit !== true)) {
        // Explicit Swiss counts survive unrelated maxPlayers edits; derived formats/counts do not.
        tournament.roundCount = tournament.format === "roundRobin"
          ? tournament.maxPlayers - (tournament.maxPlayers % 2 === 0 ? 1 : 0)
          : Math.max(1, Math.ceil(Math.log2(tournament.maxPlayers)));
        tournament.roundCountExplicit = false;
      }
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  registerEntrant(
    tournamentId: string,
    coach: VerifiedCoachIdentity,
    teamId: string,
    now = new Date(),
  ): TournamentEntrantRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (!(["draft", "active"] as TournamentRecord["status"][]).includes(tournament.status))
        throw new TournamentStoreError(400, "Tournament registration is closed.");
      if (Object.values(data.rounds).some((round) => round.tournamentId === tournamentId && round.number === 1))
        throw new TournamentStoreError(400, "Tournament registration is closed after round 1 is generated.");
      assertVerifiedCoach(coach);
      if (!teamId.trim()) throw new TournamentStoreError(400, "teamId is required.");
      const entrants = Object.values(data.entrants).filter((entrant) => entrant.tournamentId === tournamentId);
      if (entrants.some((entrant) => coachKey(entrant.coach.ffbCoachId) === coachKey(coach.ffbCoachId)))
        throw new TournamentStoreError(400, "Coach is already entered in this tournament.");
      if (tournament.maxPlayers > 0 && entrants.filter((entrant) => entrant.droppedAt === undefined).length >= tournament.maxPlayers)
        throw new TournamentStoreError(400, "Tournament is full.");
      const seed = entrants.reduce((highest, entrant) => Math.max(highest, entrant.seed), 0) + 1;
      const entrant: TournamentEntrantRecord = {
        id: `${tournamentId}:entrant:${seed}`,
        tournamentId,
        seed,
        coach,
        teamId: teamId.trim(),
        registeredAt: now.toISOString(),
      };
      assertId(entrant.id, "entrant id");
      data.entrants[entrant.id] = entrant;
      tournament.updatedAt = now.toISOString();
      delete data.standings[tournamentId];
      return entrant;
    });
  }

  dropEntrant(
    tournamentId: string,
    entrantId: string,
    authenticatedCoach: string,
    organizer: boolean,
    now = new Date(),
  ): TournamentEntrantRecord {
    return this.mutate((data) => {
      const entrant = data.entrants[entrantId];
      if (!entrant || entrant.tournamentId !== tournamentId)
        throw new TournamentStoreError(404, "Tournament entrant not found.");
      if (!organizer && coachKey(entrant.coach.ffbCoachId) !== coachKey(authenticatedCoach))
        throw new TournamentStoreError(403, "You may withdraw only your own tournament entry.");
      if (!entrant.droppedAt) entrant.droppedAt = now.toISOString();
      const tournament = data.tournaments[tournamentId];
      if (tournament) tournament.updatedAt = now.toISOString();
      delete data.standings[tournamentId];
      return entrant;
    });
  }

  tournament(tournamentId: string): TournamentRecord | undefined {
    return this.snapshot().tournaments[tournamentId];
  }

  entrants(tournamentId: string): TournamentEntrantRecord[] {
    return Object.values(this.snapshot().entrants)
      .filter((entrant) => entrant.tournamentId === tournamentId)
      .sort((left, right) => left.seed - right.seed || left.id.localeCompare(right.id));
  }

  rounds(tournamentId: string): TournamentRoundRecord[] {
    return Object.values(this.snapshot().rounds)
      .filter((round) => round.tournamentId === tournamentId)
      .sort((left, right) => left.number - right.number);
  }

  matches(tournamentId?: string): ScheduledMatchRecord[] {
    return Object.values(this.snapshot().scheduledMatches)
      .filter((match) => tournamentId === undefined || match.tournamentId === tournamentId)
      .sort((left, right) => left.roundNumber - right.roundNumber || left.id.localeCompare(right.id));
  }

  match(matchId: string): ScheduledMatchRecord | undefined {
    return this.snapshot().scheduledMatches[matchId];
  }

  standings(tournamentId: string) {
    const snapshot = this.snapshot();
    const tournament = snapshot.tournaments[tournamentId];
    if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
    const entrants = Object.values(snapshot.entrants).filter((entrant) => entrant.tournamentId === tournamentId);
    const matches = Object.values(snapshot.scheduledMatches)
      .filter((match) => match.tournamentId === tournamentId)
      .sort((left, right) => left.id.localeCompare(right.id));
    const matchRevision = matches.map((match) => `${match.id}:${match.revision}:${match.status}`).join("|");
    const cached = snapshot.standings[tournamentId];
    if (cached?.matchRevision === matchRevision) return cached.rows;
    const rows = calculateStandings(entrants, matches, tournament.points, tournament.tiebreakers);
    this.mutate((data) => {
      data.standings[tournamentId] = {
        tournamentId,
        matchRevision,
        rows,
        calculatedAt: new Date().toISOString(),
      };
    });
    return rows;
  }

  generateNextRound(
    tournamentId: string,
    now = new Date(),
    coachRating: (coach: string) => number | undefined = () => undefined,
  ): TournamentRoundRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (tournament.status !== "active") throw new TournamentStoreError(409, "Only an active tournament can generate a round.");
      const existingRounds = Object.values(data.rounds).filter((round) => round.tournamentId === tournamentId);
      if (existingRounds.some((round) => round.status !== "completed"))
        throw new TournamentStoreError(409, "Complete the current round before generating another.");
      const number = existingRounds.length + 1;
      const entrants = Object.values(data.entrants).filter((entrant) => entrant.tournamentId === tournamentId);
      if (number === 1) {
        const seeded = entrants.filter((entrant) => entrant.droppedAt === undefined).sort((left, right) => {
          const ratingDifference = (coachRating(right.coach.ffbCoachId) ?? 1500) -
            (coachRating(left.coach.ffbCoachId) ?? 1500);
          return ratingDifference || stableTieFlip(tournamentId, left.id, right.id);
        });
        seeded.forEach((entrant, index) => {
          entrant.seed = index + 1;
        });
      }
      if (number === 1 && tournament.format !== "swiss") {
        const activeCount = entrants.filter((entrant) => entrant.droppedAt === undefined).length;
        tournament.roundCount = tournament.format === "roundRobin"
          ? Math.max(1, activeCount - (activeCount % 2 === 0 ? 1 : 0))
          : Math.max(1, Math.ceil(Math.log2(Math.max(2, activeCount))));
        tournament.roundCountExplicit = false;
      }
      if (number > tournament.roundCount) throw new TournamentStoreError(409, "All configured rounds already exist.");
      for (const entrant of entrants) assertVerifiedCoach(entrant.coach);
      const priorMatches = Object.values(data.scheduledMatches).filter((match) => match.tournamentId === tournamentId);
      const pairings = generateTournamentPairings(
        tournament.format,
        number,
        entrants,
        priorMatches,
        tournament.points,
        tournament.tiebreakers,
      );
      const roundId = `${tournamentId}:round:${number}`;
      assertId(roundId, "round id");
      const timestamp = now.toISOString();
      const scheduledMatchIds: string[] = [];
      pairings.forEach((pairing, index) => {
        const id = `${roundId}:match:${index + 1}`;
        const homeEntrant = data.entrants[pairing.homeEntrantId];
        const awayEntrant = pairing.awayEntrantId ? data.entrants[pairing.awayEntrantId] : undefined;
        if (!homeEntrant || (pairing.awayEntrantId && !awayEntrant)) throw new Error("Pairing references an unknown entrant.");
        const match: ScheduledMatchRecord = {
          id,
          tournamentId,
          roundId,
          roundNumber: number,
          home: { entrantId: homeEntrant.id, coach: homeEntrant.coach, teamId: homeEntrant.teamId },
          ...(awayEntrant ? { away: { entrantId: awayEntrant.id, coach: awayEntrant.coach, teamId: awayEntrant.teamId } } : {}),
          status: awayEntrant ? "scheduled" : "completed",
          revision: 1,
          launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
          ...(awayEntrant ? {} : { result: { homeScore: 0, awayScore: 0, reportedAt: timestamp } }),
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        data.scheduledMatches[id] = match;
        scheduledMatchIds.push(id);
      });
      const round: TournamentRoundRecord = {
        id: roundId,
        tournamentId,
        number,
        status: pairings.every((pairing) => pairing.awayEntrantId === undefined) ? "completed" : "active",
        scheduledMatchIds,
        createdAt: timestamp,
      };
      data.rounds[roundId] = round;
      data.tournaments[tournamentId] = { ...tournament, currentRound: number, updatedAt: timestamp };
      return round;
    });
  }

  finishTournament(tournamentId: string, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (tournament.status === "completed")
        throw new TournamentStoreError(400, "Tournament is already completed.");
      if (tournament.status !== "active")
        throw new TournamentStoreError(400, "Only an active tournament can be finished.");
      const timestamp = now.toISOString();
      const openStatuses: ScheduledMatchRecord["status"][] = ["scheduled", "launching", "launched", "launch_failed"];
      for (const match of Object.values(data.scheduledMatches)) {
        if (match.tournamentId !== tournamentId || !openStatuses.includes(match.status)) continue;
        data.scheduledMatches[match.id] = {
          ...match,
          status: "cancelled",
          revision: match.revision + 1,
          updatedAt: timestamp,
        };
      }
      for (const key of Object.keys(data.waitingPresence)) {
        const matchId = data.waitingPresence[key]?.scheduledMatchId;
        if (matchId && data.scheduledMatches[matchId]?.tournamentId === tournamentId) delete data.waitingPresence[key];
      }
      tournament.status = "completed";
      tournament.updatedAt = timestamp;
      delete data.standings[tournamentId];
      return tournament;
    });
  }

  activeLeases(matchId: string, now = new Date()): WaitingPresenceLease[] {
    const current = now.getTime();
    return Object.values(this.snapshot().waitingPresence)
      .filter((lease) => lease.scheduledMatchId === matchId && Date.parse(lease.expiresAt) > current)
      .sort((left, right) => left.coachId.localeCompare(right.coachId));
  }

  renewWaiting(matchId: string, authenticatedCoach: string, ttlMs = DEFAULT_WAITING_LEASE_MS, now = new Date()): WaitingPresenceLease {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      const coach = participants(match).find((candidate) => coachKey(candidate.ffbCoachId) === coachKey(authenticatedCoach));
      if (!coach) throw new TournamentStoreError(403, "Only a scheduled participant can renew waiting presence.");
      if (!["scheduled", "launching", "launch_failed"].includes(match.status))
        throw new TournamentStoreError(409, "Waiting presence is closed for this match.");
      if (!Number.isFinite(ttlMs) || ttlMs < MIN_WAITING_LEASE_MS || ttlMs > MAX_WAITING_LEASE_MS)
        throw new TournamentStoreError(400, `ttlMs must be between ${MIN_WAITING_LEASE_MS} and ${MAX_WAITING_LEASE_MS}.`);
      const lease: WaitingPresenceLease = {
        scheduledMatchId: matchId,
        coachId: coach.ffbCoachId,
        renewedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
      };
      data.waitingPresence[leaseKey(matchId, coach.ffbCoachId)] = lease;
      return lease;
    });
  }

  clearWaiting(matchId: string, authenticatedCoach: string): boolean {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      const coach = participants(match).find((candidate) => coachKey(candidate.ffbCoachId) === coachKey(authenticatedCoach));
      if (!coach) throw new TournamentStoreError(403, "Only a scheduled participant can clear waiting presence.");
      return delete data.waitingPresence[leaseKey(matchId, coach.ffbCoachId)];
    });
  }

  /** Empty unless at least one participant is waiting; never targets a coach with an active lease. */
  notificationAudience(matchId: string, now = new Date()): VerifiedCoachIdentity[] {
    const match = this.match(matchId);
    if (!match?.away || !["scheduled", "launching", "launch_failed"].includes(match.status)) return [];
    const waiting = new Set(this.activeLeases(matchId, now).map((lease) => coachKey(lease.coachId)));
    if (waiting.size === 0) return [];
    return participants(match).filter((coach) => !waiting.has(coachKey(coach.ffbCoachId)));
  }

  applyMatchAction(matchId: string, authenticatedCoach: string, action: "retry" | "dismiss", expectedRevision: number, now = new Date()): ScheduledMatchRecord {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      if (!participants(match).some((coach) => coachKey(coach.ffbCoachId) === coachKey(authenticatedCoach)))
        throw new TournamentStoreError(403, "Only a scheduled participant can change this match.");
      if (!Number.isSafeInteger(expectedRevision) || match.revision !== expectedRevision)
        throw new TournamentStoreError(409, `Scheduled match revision changed; current revision is ${match.revision}.`);
      if (action === "retry" && match.status !== "launch_failed")
        throw new TournamentStoreError(409, "Retry is available only after a launch failure.");
      if (action === "dismiss" && match.status !== "launch_failed")
        throw new TournamentStoreError(409, "Dismiss is available only after a launch failure.");
      const updated: ScheduledMatchRecord = {
        ...match,
        status: action === "retry" ? "scheduled" : "dismissed",
        revision: match.revision + 1,
        launch: action === "retry"
          ? { ...match.launch, retryCount: match.launch.retryCount + 1, lastError: undefined }
          : match.launch,
        updatedAt: now.toISOString(),
      };
      data.scheduledMatches[matchId] = updated;
      for (const key of Object.keys(data.waitingPresence)) {
        if (data.waitingPresence[key]?.scheduledMatchId === matchId) delete data.waitingPresence[key];
      }
      return updated;
    });
  }

  recordLaunch(
    matchId: string,
    input: {
      expectedRevision: number;
      status: "launching" | "launched" | "launch_failed";
      gameName?: string;
      gameId?: string;
      error?: string;
    },
    now = new Date(),
  ): ScheduledMatchRecord {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      if (data.tournaments[match.tournamentId]?.status === "completed" ||
        (["completed", "cancelled", "dismissed"] as ScheduledMatchRecord["status"][]).includes(match.status))
        throw new TournamentStoreError(409, "This scheduled match is closed.");
      if (!Number.isSafeInteger(input.expectedRevision) || match.revision !== input.expectedRevision)
        throw new TournamentStoreError(409, `Scheduled match revision changed; current revision is ${match.revision}.`);
      if (input.status === "launched" && !input.gameName?.trim() && !input.gameId?.trim())
        throw new TournamentStoreError(400, "A launched match requires gameName or gameId.");
      if (input.status === "launch_failed" && !input.error?.trim())
        throw new TournamentStoreError(400, "A launch failure requires an error message.");
      const timestamp = now.toISOString();
      const updated: ScheduledMatchRecord = {
        ...match,
        status: input.status,
        revision: match.revision + 1,
        launch: {
          ...match.launch,
          ...(input.gameName?.trim() ? { gameName: input.gameName.trim() } : {}),
          ...(input.gameId?.trim() ? { gameId: input.gameId.trim() } : {}),
          lastAttemptAt: timestamp,
          ...(input.status === "launched" ? { launchedAt: timestamp, lastError: undefined } : {}),
          ...(input.status === "launch_failed" ? { lastError: input.error!.trim() } : {}),
        },
        updatedAt: timestamp,
      };
      data.scheduledMatches[matchId] = updated;
      return updated;
    });
  }

  recordResult(
    matchId: string,
    input: { expectedRevision: number; homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number },
    now = new Date(),
  ): ScheduledMatchRecord {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      if (!match.away) throw new TournamentStoreError(409, "A bye already has an automatic result.");
      if (data.tournaments[match.tournamentId]?.status === "completed" || match.status === "cancelled" || match.status === "dismissed")
        throw new TournamentStoreError(409, "This scheduled match is closed.");
      if (!Number.isSafeInteger(input.expectedRevision) || match.revision !== input.expectedRevision)
        throw new TournamentStoreError(409, `Scheduled match revision changed; current revision is ${match.revision}.`);
      for (const [field, value] of Object.entries(input).filter(([field]) => field !== "expectedRevision")) {
        if (!Number.isSafeInteger(value) || (value as number) < 0)
          throw new TournamentStoreError(400, `${field} must be a non-negative integer.`);
      }
      const timestamp = now.toISOString();
      const updated: ScheduledMatchRecord = {
        ...match,
        status: "completed",
        revision: match.revision + 1,
        result: {
          homeScore: input.homeScore,
          awayScore: input.awayScore,
          ...(input.homeCasualties === undefined ? {} : { homeCasualties: input.homeCasualties }),
          ...(input.awayCasualties === undefined ? {} : { awayCasualties: input.awayCasualties }),
          reportedAt: timestamp,
        },
        updatedAt: timestamp,
      };
      data.scheduledMatches[matchId] = updated;
      const round = data.rounds[match.roundId];
      if (round && round.scheduledMatchIds.every((id) => data.scheduledMatches[id]?.status === "completed")) {
        data.rounds[round.id] = { ...round, status: "completed", completedAt: timestamp };
        const tournament = data.tournaments[match.tournamentId];
        if (tournament && round.number >= tournament.roundCount)
          data.tournaments[tournament.id] = { ...tournament, status: "completed", updatedAt: timestamp };
      }
      delete data.standings[match.tournamentId];
      for (const key of Object.keys(data.waitingPresence)) {
        if (data.waitingPresence[key]?.scheduledMatchId === matchId) delete data.waitingPresence[key];
      }
      return updated;
    });
  }
}
