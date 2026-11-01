import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { calculateStandings, generateTournamentPairings, stableTieFlip } from "./pairing.js";
import { DEFAULT_ENTRANT_FLAGS, TOURNAMENT_PAIRING_SYSTEMS, TOURNAMENT_SEEDING_MODES } from "./types.js";
import type { NewsInput, TournamentPagePatch } from "./page.js";
import type {
  ScheduledMatchRecord,
  TournamentDataFileV2,
  TournamentDataFileV3,
  TournamentDataFileV4,
  TournamentEntrantFlags,
  TournamentPairingSystem,
  TournamentSeedingMode,
  TournamentSubmission,
  TournamentEntrantRecord,
  TournamentNewsPost,
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

export type TournamentUpdate = Partial<Pick<TournamentRecord, "maxPlayers" | "format" | "packageName" | "startsAt" | "endsAt" | "roundCount" | "organizerCoachId" | "turnTimer" | "inducementOptIns" | "pairingSystem" | "seedingMode" | "nafSanctioned">> & {
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

const emptyData = (): TournamentDataFileV4 => ({
  version: 4,
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
    // v4 defaults: the owner is the existing organiser (legacy rows without one stay ownerless = admin-only);
    // migrated records keep the original matcher ("eloSeeded") so their pairing behaviour is unchanged.
    ...(tournament.ownerCoachId ?? tournament.organizerCoachId
      ? { ownerCoachId: tournament.ownerCoachId ?? tournament.organizerCoachId }
      : {}),
    organizerCoachIds: Array.isArray(tournament.organizerCoachIds) ? tournament.organizerCoachIds : [],
    pairingSystem: TOURNAMENT_PAIRING_SYSTEMS.includes(tournament.pairingSystem as TournamentPairingSystem)
      ? tournament.pairingSystem
      : "eloSeeded",
    seedingMode: TOURNAMENT_SEEDING_MODES.includes(tournament.seedingMode as TournamentSeedingMode) ? tournament.seedingMode : "elo",
  }]),
);

const normalizedEntrants = (
  value: TournamentEntrantRecord[] | Record<string, TournamentEntrantRecord> | undefined,
): Record<string, TournamentEntrantRecord> => Object.fromEntries(
  Object.entries(keyed(value)).map(([id, entrant]) => [id, {
    ...entrant,
    flags: { ...DEFAULT_ENTRANT_FLAGS, ...(entrant.flags ?? {}) },
  }]),
);

/** Runtime migration: V1/V2/V3 remain readable and are atomically rewritten as V4 on the next store mutation.
 *  V4 only adds optional fields; the defaults are materialised here (organizerCoachIds [], pairingSystem, seedingMode,
 *  ownerCoachId from organizerCoachId, entrant flags), so a V3 file loads with every existing value unchanged. */
export function migrateTournamentData(value: unknown): TournamentDataFileV4 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Tournament data must be an object.");
  const parsed = value as TournamentDataFileV1 | TournamentDataFileV2 | TournamentDataFileV3 | TournamentDataFileV4;
  if (parsed.version === 1) {
    return {
      version: 4,
      tournaments: normalizedTournaments(parsed.tournaments),
      entrants: normalizedEntrants(parsed.entrants),
      rounds: keyed(parsed.rounds),
      standings: {},
      scheduledMatches: keyed(parsed.scheduledMatches),
      waitingPresence: {},
    };
  }
  if (parsed.version !== 2 && parsed.version !== 3 && parsed.version !== 4) throw new Error("Unsupported tournament data version.");
  for (const field of ["tournaments", "entrants", "rounds", "standings", "scheduledMatches", "waitingPresence"] as const) {
    if (!parsed[field] || typeof parsed[field] !== "object" || Array.isArray(parsed[field]))
      throw new Error(`Tournament data ${field} must be an object.`);
  }
  return {
    ...structuredClone(parsed),
    version: 4,
    tournaments: normalizedTournaments(parsed.tournaments as unknown as Record<string, LegacyTournamentRecord>),
    entrants: normalizedEntrants(parsed.entrants),
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

/** The tournament owner: ownerCoachId, or the legacy organizerCoachId. Undefined = legacy ownerless (admin-only). */
export function tournamentOwner(tournament: Pick<TournamentRecord, "ownerCoachId" | "organizerCoachId">): string | undefined {
  return tournament.ownerCoachId ?? tournament.organizerCoachId;
}

/** Owner or listed organiser of this tournament (admins are checked by the caller). */
export function isTournamentManager(tournament: TournamentRecord, coach: string): boolean {
  const key = coachKey(coach);
  const owner = tournamentOwner(tournament);
  if (owner && coachKey(owner) === key) return true;
  return (tournament.organizerCoachIds ?? []).some((id) => coachKey(id) === key);
}

/** flags.rosterVerified = the organiser override when set, otherwise the latest validation. */
function withVerified(entrant: TournamentEntrantRecord): TournamentEntrantFlags {
  const flags = { ...DEFAULT_ENTRANT_FLAGS, ...(entrant.flags ?? {}) };
  flags.rosterVerified = entrant.rosterVerifiedOverride ?? entrant.submission?.validation.ok ?? false;
  return flags;
}

function lockInto(
  data: TournamentDataFileV4,
  tournamentId: string,
  checks: Record<string, TournamentSubmission | { error: string }>,
  now: Date,
): TournamentEntrantRecord[] {
  const tournament = data.tournaments[tournamentId];
  if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
  if (tournament.status === "completed" || tournament.status === "cancelled")
    throw new TournamentStoreError(400, "This tournament is closed.");
  if (tournament.rostersLockedAt) throw new TournamentStoreError(409, "Rosters are already locked.");
  const timestamp = now.toISOString();
  const entrants = Object.values(data.entrants)
    .filter((entrant) => entrant.tournamentId === tournamentId)
    .sort((left, right) => left.seed - right.seed);
  for (const entrant of entrants) {
    if (entrant.droppedAt !== undefined) continue;
    const check = checks[entrant.id];
    if (check && !("error" in check)) {
      entrant.submission = structuredClone(check);
    } else {
      const problem = check && "error" in check ? check.error : "No roster could be read for this entry.";
      entrant.submission = {
        ...(entrant.submission ?? {
          saveId: `library:${entrant.teamId}`,
          revision: entrant.teamId,
          submittedAt: timestamp,
          snapshot: null,
        }),
        validation: { ok: false, problems: [problem], checkedAt: timestamp, packageName: tournament.packageName },
      };
    }
    entrant.flags = { ...withVerified(entrant), frozen: true };
  }
  tournament.rostersLockedAt = timestamp;
  tournament.updatedAt = timestamp;
  delete data.standings[tournamentId];
  return entrants;
}

/** The ruleset changed: every check is void (ok false, a reason), hand verifications are cleared, the lock is lifted. */
function invalidateRosterChecks(data: TournamentDataFileV4, tournamentId: string, timestamp: string): void {
  const tournament = data.tournaments[tournamentId];
  if (!tournament) return;
  for (const entrant of Object.values(data.entrants)) {
    if (entrant.tournamentId !== tournamentId) continue;
    delete entrant.rosterVerifiedOverride;
    if (entrant.submission) {
      entrant.submission.validation = {
        ...entrant.submission.validation,
        ok: false,
        problems: ["The ruleset changed; resubmit this team so it is checked against the new ruleset."],
        checkedAt: timestamp,
        packageName: tournament.packageName,
      };
      delete entrant.submission.validation.packageRevision;
    }
    entrant.flags = { ...withVerified(entrant), frozen: false };
  }
  delete tournament.rostersLockedAt;
}

interface RoundPlan {
  number: number;
  seeds: Record<string, number>;
  pairings: Array<{ homeEntrantId: string; awayEntrantId?: string }>;
  roundCount: number;
}

/**
 * The next round of a tournament without writing: round 1 reseeds (manual seeds first when seedingMode is manual,
 * then tournament Elo, then a stable flip); Swiss rounds use the pairing system (`options` override the record).
 */
function planRound(
  data: TournamentDataFileV4,
  tournamentId: string,
  options: { pairingSystem?: TournamentPairingSystem; seedingMode?: TournamentSeedingMode },
  coachRating: (coach: string) => number | undefined,
): RoundPlan {
  const tournament = data.tournaments[tournamentId];
  if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
  if (options.pairingSystem !== undefined && !TOURNAMENT_PAIRING_SYSTEMS.includes(options.pairingSystem))
    throw new TournamentStoreError(400, "pairingSystem must be dutch, monrad or eloSeeded.");
  if (options.seedingMode !== undefined && !TOURNAMENT_SEEDING_MODES.includes(options.seedingMode))
    throw new TournamentStoreError(400, "seedingMode must be elo or manual.");
  const existingRounds = Object.values(data.rounds).filter((round) => round.tournamentId === tournamentId);
  if (existingRounds.some((round) => round.status !== "completed"))
    throw new TournamentStoreError(409, "Complete the current round before generating another.");
  const number = existingRounds.length + 1;
  const entrants = Object.values(data.entrants)
    .filter((entrant) => entrant.tournamentId === tournamentId)
    .map((entrant) => ({ ...entrant }));
  const seeds: Record<string, number> = {};
  const seedingMode = options.seedingMode ?? tournament.seedingMode ?? "elo";
  if (number === 1) {
    const seeded = entrants.filter((entrant) => entrant.droppedAt === undefined).sort((left, right) => {
      if (seedingMode === "manual") {
        const manual = (left.manualSeed ?? Number.MAX_SAFE_INTEGER) - (right.manualSeed ?? Number.MAX_SAFE_INTEGER);
        if (manual !== 0) return manual;
      }
      const ratingDifference = (coachRating(right.coach.ffbCoachId) ?? 1500) -
        (coachRating(left.coach.ffbCoachId) ?? 1500);
      return ratingDifference || stableTieFlip(tournamentId, left.id, right.id);
    });
    seeded.forEach((entrant, index) => {
      entrant.seed = index + 1;
      seeds[entrant.id] = index + 1;
    });
  }
  let roundCount = tournament.roundCount;
  if (number === 1 && tournament.format !== "swiss") {
    const activeCount = entrants.filter((entrant) => entrant.droppedAt === undefined).length;
    roundCount = tournament.format === "roundRobin"
      ? Math.max(1, activeCount - (activeCount % 2 === 0 ? 1 : 0))
      : Math.max(1, Math.ceil(Math.log2(Math.max(2, activeCount))));
  }
  if (number > roundCount) throw new TournamentStoreError(409, "All configured rounds already exist.");
  const priorMatches = Object.values(data.scheduledMatches).filter((match) => match.tournamentId === tournamentId);
  const pairings = generateTournamentPairings(
    tournament.format,
    number,
    entrants,
    priorMatches,
    tournament.points,
    tournament.tiebreakers,
    {
      system: options.pairingSystem ?? tournament.pairingSystem ?? "eloSeeded",
      eligible: (entrant) => entrant.flags?.active !== false,
    },
  );
  return { number, seeds, pairings, roundCount };
}

export class TournamentStoreError extends Error {
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

export class TournamentStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tournaments.json");
  }

  snapshot(): TournamentDataFileV4 {
    if (!existsSync(this.file)) return emptyData();
    return migrateTournamentData(JSON.parse(readFileSync(this.file, "utf8")) as unknown);
  }

  /** Intended for migrations, administrative import, and deterministic tests. */
  writeSnapshot(value: TournamentDataFileV2 | TournamentDataFileV3 | TournamentDataFileV4): TournamentDataFileV4 {
    const normalized = migrateTournamentData(value);
    atomicWriteTextFile(this.file, `${JSON.stringify(normalized, null, 2)}\n`);
    return structuredClone(normalized);
  }

  private mutate<T>(change: (data: TournamentDataFileV4) => T): T {
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
      nafSanctioned?: boolean;
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
        ownerCoachId: organizerCoachId,
        organizerCoachIds: [],
        pairingSystem: "dutch",
        seedingMode: "elo",
        ...(input.nafSanctioned ? { nafSanctioned: true } : {}),
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
      if (patch.endsAt !== undefined && patch.endsAt !== "" &&
        (!ISO_DATE_TIME.test(patch.endsAt) || !Number.isFinite(Date.parse(patch.endsAt))))
        throw new TournamentStoreError(400, "endsAt must be an ISO-8601 timestamp.");
      const resultingStart = patch.startsAt === "" ? undefined : patch.startsAt ?? tournament.startsAt;
      const resultingEnd = patch.endsAt === "" ? undefined : patch.endsAt ?? tournament.endsAt;
      if (resultingStart && resultingEnd && Date.parse(resultingEnd) < Date.parse(resultingStart))
        throw new TournamentStoreError(400, "endsAt must not be before startsAt.");
      if (patch.pairingSystem !== undefined && !TOURNAMENT_PAIRING_SYSTEMS.includes(patch.pairingSystem))
        throw new TournamentStoreError(400, "pairingSystem must be dutch, monrad or eloSeeded.");
      if (patch.seedingMode !== undefined && !TOURNAMENT_SEEDING_MODES.includes(patch.seedingMode))
        throw new TournamentStoreError(400, "seedingMode must be elo or manual.");
      if (patch.organizerCoachId !== undefined && (!patch.organizerCoachId.trim() || patch.organizerCoachId.trim().length > 40))
        throw new TournamentStoreError(400, "organizerCoachId must be a non-empty coach id of at most 40 characters.");
      if (patch.turnTimer !== undefined) {
        const t = patch.turnTimer;
        if (!["off", "optional", "required"].includes(t.enforced))
          throw new TournamentStoreError(400, "turnTimer.enforced must be off, optional or required.");
        if (!Number.isInteger(t.seconds) || t.seconds < 30 || t.seconds > 3600)
          throw new TournamentStoreError(400, "turnTimer.seconds must be a whole number from 30 to 3600.");
      }
      if (patch.inducementOptIns !== undefined) {
        const list = patch.inducementOptIns;
        if (!Array.isArray(list) || list.length > 20 || list.some((k) => typeof k !== "string" || !k.trim() || k.length > 40))
          throw new TournamentStoreError(400, "inducementOptIns must be a list of at most 20 inducement keys.");
        tournament.inducementOptIns = [...new Set(list.map((k) => k.trim()))];
      }
      if (patch.turnTimer !== undefined) tournament.turnTimer = { enforced: patch.turnTimer.enforced, seconds: patch.turnTimer.seconds };
      if (patch.maxPlayers !== undefined) tournament.maxPlayers = patch.maxPlayers;
      if (patch.format !== undefined) tournament.format = patch.format;
      if (patch.packageName !== undefined && patch.packageName !== tournament.packageName) {
        tournament.packageName = patch.packageName;
        invalidateRosterChecks(data, tournamentId, now.toISOString());
      }
      if (patch.primaryTiebreaker !== undefined) {
        tournament.tiebreakers = tiebreakerLadder(patch.primaryTiebreaker);
        delete data.standings[tournamentId];
      }
      if (patch.startsAt === "") delete tournament.startsAt;
      else if (patch.startsAt !== undefined) tournament.startsAt = patch.startsAt;
      if (patch.endsAt === "") delete tournament.endsAt;
      else if (patch.endsAt !== undefined) tournament.endsAt = patch.endsAt;
      if (patch.pairingSystem !== undefined) tournament.pairingSystem = patch.pairingSystem;
      if (patch.seedingMode !== undefined) tournament.seedingMode = patch.seedingMode;
      if (patch.nafSanctioned === true && tournament.nafSanctioned !== true) {
        tournament.nafSanctioned = true;
        // Entries made before the tournament was sanctioned owe a NAF answer now.
        for (const entrant of Object.values(data.entrants)) {
          if (entrant.tournamentId !== tournamentId || entrant.droppedAt !== undefined) continue;
          if (!entrant.nafNumber && !entrant.notNafMember) entrant.nafPending = true;
        }
      } else if (patch.nafSanctioned === false && tournament.nafSanctioned === true) {
        delete tournament.nafSanctioned;
        for (const entrant of Object.values(data.entrants)) if (entrant.tournamentId === tournamentId) delete entrant.nafPending;
      }
      if (patch.organizerCoachId !== undefined) {
        tournament.organizerCoachId = patch.organizerCoachId.trim();
        tournament.ownerCoachId = tournament.organizerCoachId;
      }
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

  /** Tournament page fields (parsed by page.ts parsePagePatch): null clears a field. */
  updatePage(tournamentId: string, patch: TournamentPagePatch, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      for (const field of ["location", "startTime", "entryFee", "summary", "notes", "deadlines"] as const) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value === null) delete tournament[field];
        else (tournament as unknown as Record<string, unknown>)[field] = structuredClone(value);
      }
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  /** Records (or clears) the banner file path; the caller owns the file itself. */
  setBanner(tournamentId: string, bannerPath: string | undefined, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (bannerPath === undefined) delete tournament.bannerPath;
      else tournament.bannerPath = bannerPath;
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  addNews(tournamentId: string, post: TournamentNewsPost, maxPosts: number, now = new Date()): TournamentNewsPost {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const news = tournament.news ?? [];
      if (news.length >= maxPosts) throw new TournamentStoreError(409, `A tournament can hold at most ${maxPosts} news posts; delete an old one first.`);
      tournament.news = [...news, post];
      tournament.updatedAt = now.toISOString();
      return post;
    });
  }

  updateNews(tournamentId: string, newsId: string, patch: NewsInput, now = new Date()): TournamentNewsPost {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const post = tournament.news?.find((candidate) => candidate.id === newsId);
      if (!post) throw new TournamentStoreError(404, "News post not found.");
      if (patch.title !== undefined) post.title = patch.title;
      if (patch.body !== undefined) post.body = patch.body;
      if (patch.pinned !== undefined) post.pinned = patch.pinned;
      if (patch.title !== undefined || patch.body !== undefined) post.editedAt = now.toISOString();
      tournament.updatedAt = now.toISOString();
      return post;
    });
  }

  deleteNews(tournamentId: string, newsId: string, now = new Date()): void {
    this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const news = tournament.news ?? [];
      if (!news.some((candidate) => candidate.id === newsId)) throw new TournamentStoreError(404, "News post not found.");
      tournament.news = news.filter((candidate) => candidate.id !== newsId);
      if (!tournament.news.length) delete tournament.news;
      tournament.updatedAt = now.toISOString();
    });
  }

  registerEntrant(
    tournamentId: string,
    coach: VerifiedCoachIdentity,
    teamId: string,
    now = new Date(),
    nafEntry: { nafNumber?: string; notNafMember?: boolean; nafPending?: boolean } = {},
  ): TournamentEntrantRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (!(["draft", "active"] as TournamentRecord["status"][]).includes(tournament.status))
        throw new TournamentStoreError(400, "Tournament registration is closed.");
      if (Object.values(data.rounds).some((round) => round.tournamentId === tournamentId && round.number === 1))
        throw new TournamentStoreError(400, "Tournament registration is closed after round 1 is generated.");
      if (tournament.rostersLockedAt)
        throw new TournamentStoreError(409, "Registration is closed while rosters are locked.");
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
        flags: { ...DEFAULT_ENTRANT_FLAGS },
        ...(nafEntry.nafNumber ? { nafNumber: nafEntry.nafNumber } : {}),
        ...(nafEntry.notNafMember ? { notNafMember: true as const } : {}),
        ...(nafEntry.nafPending ? { nafPending: true as const } : {}),
      };
      assertId(entrant.id, "entrant id");
      data.entrants[entrant.id] = entrant;
      tournament.updatedAt = now.toISOString();
      delete data.standings[tournamentId];
      return entrant;
    });
  }

  /** Marks entries as owing their NAF answer (nafPending); returns the ids newly marked (already marked: skipped). */
  markNafPending(tournamentId: string, entrantIds: readonly string[], now = new Date()): string[] {
    if (!entrantIds.length) return [];
    return this.mutate((data) => {
      const marked: string[] = [];
      for (const id of entrantIds) {
        const entrant = data.entrants[id];
        if (!entrant || entrant.tournamentId !== tournamentId || entrant.nafPending) continue;
        entrant.nafPending = true;
        marked.push(id);
      }
      if (marked.length && data.tournaments[tournamentId]) data.tournaments[tournamentId]!.updatedAt = now.toISOString();
      return marked;
    });
  }

  /** The coach's NAF answer for their entry: a NAF number, or "not a NAF member". Clears nafPending. */
  answerNaf(
    tournamentId: string,
    entrantId: string,
    answer: { nafNumber: string } | { notNafMember: true },
    now = new Date(),
  ): TournamentEntrantRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const entrant = data.entrants[entrantId];
      if (!entrant || entrant.tournamentId !== tournamentId || entrant.droppedAt !== undefined)
        throw new TournamentStoreError(404, "Tournament entrant not found.");
      if ("nafNumber" in answer) { entrant.nafNumber = answer.nafNumber; delete entrant.notNafMember; }
      else { entrant.notNafMember = true; delete entrant.nafNumber; }
      delete entrant.nafPending;
      tournament.updatedAt = now.toISOString();
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
    options: { pairingSystem?: TournamentPairingSystem; seedingMode?: TournamentSeedingMode } = {},
  ): TournamentRoundRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (tournament.status !== "active") throw new TournamentStoreError(409, "Only an active tournament can generate a round.");
      const plan = planRound(data, tournamentId, options, coachRating);
      const number = plan.number;
      // The organiser's choice in the Generate fixtures step is kept on the tournament.
      if (options.pairingSystem !== undefined) tournament.pairingSystem = options.pairingSystem;
      if (options.seedingMode !== undefined) tournament.seedingMode = options.seedingMode;
      for (const [entrantId, seed] of Object.entries(plan.seeds)) {
        const entrant = data.entrants[entrantId];
        if (entrant) entrant.seed = seed;
      }
      if (number === 1 && tournament.format !== "swiss") {
        tournament.roundCount = plan.roundCount;
        tournament.roundCountExplicit = false;
      }
      const entrants = Object.values(data.entrants).filter((entrant) => entrant.tournamentId === tournamentId);
      for (const entrant of entrants) assertVerifiedCoach(entrant.coach);
      const pairings = plan.pairings;
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

  // ---- v4: roles, submissions, roster lock, start, participant flags ----

  /** Reassign the owner (the caller checked admin/owner and that the coach is a registered user). */
  setOwner(tournamentId: string, coachId: string, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const owner = coachId.trim();
      if (!owner || owner.length > 40) throw new TournamentStoreError(400, "coachId must be a non-empty coach id of at most 40 characters.");
      tournament.ownerCoachId = owner;
      tournament.organizerCoachId = owner;
      tournament.organizerCoachIds = (tournament.organizerCoachIds ?? []).filter((id) => coachKey(id) !== coachKey(owner));
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  addOrganizer(tournamentId: string, coachId: string, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const coach = coachId.trim();
      if (!coach || coach.length > 40) throw new TournamentStoreError(400, "coachId must be a non-empty coach id of at most 40 characters.");
      const list = tournament.organizerCoachIds ?? [];
      if (tournamentOwner(tournament) && coachKey(tournamentOwner(tournament)!) === coachKey(coach))
        throw new TournamentStoreError(400, "The owner already manages this tournament.");
      if (list.length >= 20) throw new TournamentStoreError(400, "A tournament can have at most 20 organisers.");
      if (!list.some((id) => coachKey(id) === coachKey(coach))) tournament.organizerCoachIds = [...list, coach];
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  removeOrganizer(tournamentId: string, coachId: string, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const list = tournament.organizerCoachIds ?? [];
      if (!list.some((id) => coachKey(id) === coachKey(coachId))) throw new TournamentStoreError(404, "That coach is not an organiser of this tournament.");
      tournament.organizerCoachIds = list.filter((id) => coachKey(id) !== coachKey(coachId));
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  /** A coach submits a team for their entry; refused (409) while rosters are locked or the entry is frozen. */
  submitTeam(tournamentId: string, entrantId: string, submission: TournamentSubmission, now = new Date()): TournamentEntrantRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const entrant = data.entrants[entrantId];
      if (!entrant || entrant.tournamentId !== tournamentId) throw new TournamentStoreError(404, "Tournament entrant not found.");
      if (entrant.droppedAt) throw new TournamentStoreError(400, "A withdrawn entry cannot submit a team.");
      if (tournament.status === "completed" || tournament.status === "cancelled")
        throw new TournamentStoreError(400, "This tournament is closed.");
      if (tournament.rostersLockedAt || entrant.flags?.frozen)
        throw new TournamentStoreError(409, "Rosters are locked; ask an organiser to unlock them before resubmitting.");
      const roundOneExists = Object.values(data.rounds).some((round) => round.tournamentId === tournamentId);
      entrant.submission = structuredClone(submission);
      // A hand verification belonged to the previous roster: a resubmitted team is judged by the validator again.
      delete entrant.rosterVerifiedOverride;
      if (submission.teamId && !roundOneExists) entrant.teamId = submission.teamId;
      entrant.flags = withVerified(entrant);
      tournament.updatedAt = now.toISOString();
      delete data.standings[tournamentId];
      return entrant;
    });
  }

  /**
   * Freeze every undropped entrant's roster: `checks` holds the fresh snapshot + validation per entrant id (or an
   * error, which keeps any earlier snapshot and records the problem). Sets rostersLockedAt.
   */
  lockRosters(tournamentId: string, checks: Record<string, TournamentSubmission | { error: string }>, now = new Date()): TournamentEntrantRecord[] {
    return this.mutate((data) => lockInto(data, tournamentId, checks, now));
  }

  unlockRosters(tournamentId: string, now = new Date()): TournamentRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (!tournament.rostersLockedAt) throw new TournamentStoreError(409, "Rosters are not locked.");
      if (tournament.status !== "draft")
        throw new TournamentStoreError(409, "Rosters stay locked once the tournament has started.");
      delete tournament.rostersLockedAt;
      for (const entrant of Object.values(data.entrants)) {
        if (entrant.tournamentId !== tournamentId) continue;
        entrant.flags = { ...DEFAULT_ENTRANT_FLAGS, ...(entrant.flags ?? {}), frozen: false };
      }
      tournament.updatedAt = now.toISOString();
      return tournament;
    });
  }

  /**
   * One-click start (owner ruling 10-28): lock rosters (snapshot + validation) unless already locked, then
   * draft -> active. Refuses with the per-entrant problems when an undropped entrant's roster is not verified, unless
   * `force`. The lock is kept on a refusal so the organiser sees the same table. Does not generate a round.
   */
  startTournament(
    tournamentId: string,
    input: { force: boolean; checks?: Record<string, TournamentSubmission | { error: string }>; packageRevision?: string },
    now = new Date(),
  ): { started: boolean; tournament: TournamentRecord; entrants: TournamentEntrantRecord[]; invalid: TournamentEntrantRecord[] } {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      if (tournament.status !== "draft") throw new TournamentStoreError(409, "Only a draft tournament can be started.");
      const field = Object.values(data.entrants).filter((entrant) => entrant.tournamentId === tournamentId && entrant.droppedAt === undefined);
      if (field.length < 2) throw new TournamentStoreError(409, "A tournament needs at least two entrants to start.");
      if (!tournament.rostersLockedAt) {
        if (!input.checks) throw new TournamentStoreError(409, "Rosters must be locked before the start.");
        lockInto(data, tournamentId, input.checks, now);
      }
      const entrants = Object.values(data.entrants)
        .filter((entrant) => entrant.tournamentId === tournamentId)
        .sort((left, right) => left.seed - right.seed);
      // A roster checked against another ruleset (or another revision of the package file) is not valid for this
      // start unless an organiser verified it by hand since; the refusal records why.
      for (const entrant of entrants) {
        const validation = entrant.submission?.validation;
        if (entrant.droppedAt !== undefined || !validation || entrant.rosterVerifiedOverride !== undefined) continue;
        const stale = validation.packageName !== tournament.packageName ||
          (input.packageRevision !== undefined && validation.packageRevision !== input.packageRevision);
        if (!stale) continue;
        entrant.submission!.validation = {
          ...validation,
          ok: false,
          problems: ["The ruleset changed after this roster was checked. Unlock the rosters and start again to re-check it."],
        };
        entrant.flags = withVerified(entrant);
      }
      const invalid = entrants.filter((entrant) => entrant.droppedAt === undefined && !entrant.flags?.rosterVerified);
      if (invalid.length > 0 && !input.force) return { started: false, tournament, entrants, invalid };
      const timestamp = now.toISOString();
      tournament.status = "active";
      tournament.startedAt = timestamp;
      tournament.updatedAt = timestamp;
      return { started: true, tournament, entrants, invalid };
    });
  }

  /** Organiser edit of one participant: paid, the five flags (rosterVerified = an override), manual seed. */
  updateEntrant(
    tournamentId: string,
    entrantId: string,
    patch: { flags?: Partial<TournamentEntrantFlags>; manualSeed?: number | null },
    now = new Date(),
  ): TournamentEntrantRecord {
    return this.mutate((data) => {
      const tournament = data.tournaments[tournamentId];
      if (!tournament) throw new TournamentStoreError(404, "Tournament not found.");
      const entrant = data.entrants[entrantId];
      if (!entrant || entrant.tournamentId !== tournamentId) throw new TournamentStoreError(404, "Tournament entrant not found.");
      const flags = { ...DEFAULT_ENTRANT_FLAGS, ...(entrant.flags ?? {}) };
      for (const [key, value] of Object.entries(patch.flags ?? {})) {
        if (!(key in DEFAULT_ENTRANT_FLAGS)) throw new TournamentStoreError(400, `Unknown participant flag "${key}".`);
        if (typeof value !== "boolean") throw new TournamentStoreError(400, `${key} must be true or false.`);
        if (key === "rosterVerified") entrant.rosterVerifiedOverride = value;
        else flags[key as keyof TournamentEntrantFlags] = value;
      }
      entrant.flags = flags;
      entrant.flags = withVerified(entrant);
      if (patch.manualSeed === null) delete entrant.manualSeed;
      else if (patch.manualSeed !== undefined) {
        if (!Number.isSafeInteger(patch.manualSeed) || patch.manualSeed < 1 || patch.manualSeed > 999)
          throw new TournamentStoreError(400, "manualSeed must be a whole number from 1 to 999.");
        entrant.manualSeed = patch.manualSeed;
      }
      tournament.updatedAt = now.toISOString();
      delete data.standings[tournamentId];
      return entrant;
    });
  }

  /** The pairings the next round would get (no write): the Generate fixtures preview. */
  previewNextRound(
    tournamentId: string,
    options: { pairingSystem?: TournamentPairingSystem; seedingMode?: TournamentSeedingMode } = {},
    coachRating: (coach: string) => number | undefined = () => undefined,
  ): { roundNumber: number; pairings: Array<{ homeEntrantId: string; awayEntrantId?: string }>; seeds: Record<string, number> } {
    const data = this.snapshot();
    const plan = planRound(data, tournamentId, options, coachRating);
    return { roundNumber: plan.number, pairings: plan.pairings, seeds: plan.seeds };
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

  /** Undo a recorded result (tabletop publication retracted): the match returns to `status`, its round/tournament reopen. */
  retractResult(
    matchId: string,
    input: { expectedRevision: number; status: ScheduledMatchRecord["status"] },
    now = new Date(),
  ): ScheduledMatchRecord {
    return this.mutate((data) => {
      const match = data.scheduledMatches[matchId];
      if (!match) throw new TournamentStoreError(404, "Scheduled match not found.");
      if (!match.result || match.revision !== input.expectedRevision)
        throw new TournamentStoreError(409, "The fixture result changed since it was recorded.");
      const timestamp = now.toISOString();
      const { result: _result, ...rest } = match;
      const updated: ScheduledMatchRecord = { ...rest, status: input.status, revision: match.revision + 1, updatedAt: timestamp };
      data.scheduledMatches[matchId] = updated;
      const round = data.rounds[match.roundId];
      if (round?.status === "completed") {
        const { completedAt: _completedAt, ...openRound } = round;
        data.rounds[round.id] = { ...openRound, status: "active" };
        const tournament = data.tournaments[match.tournamentId];
        if (tournament?.status === "completed" && round.number >= tournament.roundCount)
          data.tournaments[tournament.id] = { ...tournament, status: "active", updatedAt: timestamp };
      }
      delete data.standings[match.tournamentId];
      return updated;
    });
  }

  recordResult(
    matchId: string,
    input: { expectedRevision: number; homeScore: number; awayScore: number; homeCasualties?: number; awayCasualties?: number; opId?: string },
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
      for (const [field, value] of Object.entries(input).filter(([field]) => field !== "expectedRevision" && field !== "opId")) {
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
          ...(input.opId ? { opId: input.opId } : {}),
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
