import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  adminList,
  atomicWriteTextFile,
  gamestateResult,
  parseAdminGameList,
  type AdminGameEntry,
  type ForkAdminConfig,
  type GamestateResult,
  type GamestateTeamResult,
} from "@bb/fork-ops";
import type { TournamentMatchMetadata } from "./tournamentMatch.js";

export const FINISHED_GAME_STATUSES = ["finished", "backuped"] as const;

export interface ResultSide {
  teamId: string;
  teamName: string;
  coach: string;
}

export interface StoredTournamentResult extends GamestateResult {
  gameId: string;
  pulledAt: string;
  home: ResultSide;
  away: ResultSide;
}

interface TournamentResultStoreFile {
  version: 1;
  results: Record<string, StoredTournamentResult>;
}

export type TeamOutcome = "won" | "drawn" | "lost";

export interface DerivedTeamResult {
  outcome: TeamOutcome;
  tdFor: number;
  tdAgainst: number;
  casFor: number;
  casAgainst: number;
  winnings: number;
}

export interface StandingsRow {
  coach: string;
  packageName?: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  tdFor: number;
  tdAgainst: number;
  tdDiff: number;
  casFor: number;
  casAgainst: number;
  casDiff: number;
  winnings: number;
}

const emptyStore = (): TournamentResultStoreFile => ({ version: 1, results: {} });
const casualtiesCaused = (team: GamestateTeamResult): number =>
  team.players.reduce((total, player) => total + player.casualtiesCaused, 0);
const effectiveScore = (team: GamestateTeamResult): number =>
  team.penaltyScore >= 0 ? team.penaltyScore : team.score;

/** Derive one side's record exclusively from the two authoritative server result blocks. */
export function deriveTeamResult(team: GamestateTeamResult, opponent: GamestateTeamResult): DerivedTeamResult {
  const tdFor = effectiveScore(team);
  const tdAgainst = effectiveScore(opponent);
  return {
    outcome: tdFor > tdAgainst ? "won" : tdFor < tdAgainst ? "lost" : "drawn",
    tdFor,
    tdAgainst,
    casFor: casualtiesCaused(team),
    casAgainst: casualtiesCaused(opponent),
    winnings: team.winnings,
  };
}

export class TournamentResultStore {
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tournament-results.json");
  }

  private readStore(): TournamentResultStoreFile {
    if (!existsSync(this.file)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TournamentResultStoreFile>;
      if (parsed.version !== 1 || !parsed.results || typeof parsed.results !== "object" || Array.isArray(parsed.results))
        return emptyStore();
      return { version: 1, results: parsed.results };
    } catch {
      return emptyStore();
    }
  }

  get(gameId: string): StoredTournamentResult | undefined {
    const results = this.readStore().results;
    return Object.hasOwn(results, gameId) ? results[gameId] : undefined;
  }

  list(): StoredTournamentResult[] {
    return Object.values(this.readStore().results);
  }

  put(result: StoredTournamentResult): StoredTournamentResult {
    if (!result.gameId.trim()) throw new Error("gameId is required for tournament result metadata.");
    const current = this.readStore();
    const next: TournamentResultStoreFile = {
      version: 1,
      results: { ...current.results, [result.gameId]: result },
    };
    atomicWriteTextFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
    return result;
  }
}

/** Discover every retained finished game; the fork has no usable `status=all`. */
export async function discoverFinishedGames(cfg: ForkAdminConfig): Promise<AdminGameEntry[]> {
  const byGameId = new Map<string, AdminGameEntry>();
  // SEQUENTIAL on purpose: the admin servlet keeps ONE fLastChallenge — concurrent
  // challenge->command pairs invalidate each other and one list silently parses to [].
  for (const status of FINISHED_GAME_STATUSES) {
    for (const game of parseAdminGameList(await adminList(cfg, status))) byGameId.set(game.gameId, game);
  }
  return [...byGameId.values()];
}

const storedSide = (game: AdminGameEntry, side: "home" | "away"): ResultSide => ({
  teamId: side === "home" ? game.homeTeamId : game.awayTeamId,
  teamName: side === "home" ? game.homeTeamName : game.awayTeamName,
  coach: side === "home" ? game.homeCoach : game.awayCoach,
});

/** Pull and atomically retain a single discovered finished game. */
export async function pullFinishedGameResult(
  cfg: ForkAdminConfig,
  store: TournamentResultStore,
  game: AdminGameEntry,
): Promise<StoredTournamentResult> {
  const result = await gamestateResult(cfg, game.gameId);
  const expectedTeams = new Set([game.homeTeamId, game.awayTeamId]);
  const actualTeams = new Set(result.teams.map((team) => team.teamId));
  if (actualTeams.size !== expectedTeams.size || [...actualTeams].some((teamId) => !expectedTeams.has(teamId)))
    throw new Error(`Game ${game.gameId} result teams do not match the finished-game listing.`);
  return store.put({
    gameId: game.gameId,
    pulledAt: new Date().toISOString(),
    home: storedSide(game, "home"),
    away: storedSide(game, "away"),
    teams: result.teams,
  });
}

/** Discover finished/backuped games and pull only results not already retained. */
export async function refreshFinishedResults(
  cfg: ForkAdminConfig,
  store: TournamentResultStore,
): Promise<AdminGameEntry[]> {
  const games = await discoverFinishedGames(cfg);
  for (const game of games) {
    if (!store.get(game.gameId)) await pullFinishedGameResult(cfg, store, game);
  }
  return games;
}

interface ResultParticipant {
  teamId: string;
  coach: string;
}

function participants(
  stored: StoredTournamentResult,
  metadata: TournamentMatchMetadata | undefined,
): [ResultParticipant, ResultParticipant] {
  return metadata
    ? [metadata.home, metadata.away].map(({ teamId, ffbCoachId }) => ({ teamId, coach: ffbCoachId })) as [ResultParticipant, ResultParticipant]
    : [stored.home, stored.away];
}

export function mayReadResult(
  game: AdminGameEntry,
  metadata: TournamentMatchMetadata | undefined,
  viewer: { coach?: string; admin: boolean },
): boolean {
  if (viewer.admin) return true;
  const wanted = viewer.coach?.trim().toLowerCase();
  if (!wanted) return false;
  const coaches = metadata
    ? [metadata.home.ffbCoachId, metadata.away.ffbCoachId]
    : [game.homeCoach, game.awayCoach];
  return coaches.some((coach) => coach.trim().toLowerCase() === wanted);
}

export function aggregateStandings(
  storedResults: readonly StoredTournamentResult[],
  metadataForGame: (gameId: string) => TournamentMatchMetadata | undefined,
  filters: { coach?: string; packageName?: string } = {},
): StandingsRow[] {
  const coachFilter = filters.coach?.trim().toLowerCase();
  const packageFilter = filters.packageName?.trim().toLowerCase();
  const rows = new Map<string, StandingsRow>();

  for (const stored of storedResults) {
    const metadata = metadataForGame(stored.gameId);
    const packageName = metadata?.packageName?.trim() || undefined;
    if (packageFilter && packageName?.toLowerCase() !== packageFilter) continue;
    for (const participant of participants(stored, metadata)) {
      if (coachFilter && participant.coach.trim().toLowerCase() !== coachFilter) continue;
      const team = stored.teams.find((candidate) => candidate.teamId === participant.teamId);
      const opponent = stored.teams.find((candidate) => candidate.teamId !== participant.teamId);
      if (!team || !opponent) throw new Error(`Game ${stored.gameId} result does not match its stored participants.`);
      const derived = deriveTeamResult(team, opponent);
      const key = `${participant.coach.trim().toLowerCase()}\u0000${packageName?.toLowerCase() ?? ""}`;
      const row = rows.get(key) ?? {
        coach: participant.coach,
        ...(packageName ? { packageName } : {}),
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        tdFor: 0,
        tdAgainst: 0,
        tdDiff: 0,
        casFor: 0,
        casAgainst: 0,
        casDiff: 0,
        winnings: 0,
      };
      row.played += 1;
      row[derived.outcome] += 1;
      row.tdFor += derived.tdFor;
      row.tdAgainst += derived.tdAgainst;
      row.tdDiff = row.tdFor - row.tdAgainst;
      row.casFor += derived.casFor;
      row.casAgainst += derived.casAgainst;
      row.casDiff = row.casFor - row.casAgainst;
      row.winnings += derived.winnings;
      rows.set(key, row);
    }
  }

  return [...rows.values()].sort((left, right) =>
    (left.packageName ?? "").localeCompare(right.packageName ?? "") ||
    right.won - left.won ||
    right.drawn - left.drawn ||
    right.tdDiff - left.tdDiff ||
    right.casDiff - left.casDiff ||
    right.winnings - left.winnings ||
    left.coach.localeCompare(right.coach),
  );
}
