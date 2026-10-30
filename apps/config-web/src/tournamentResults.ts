import { existsSync, readFileSync, statSync } from "node:fs";
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
import { decodeXml } from "./forkGames.js";
import { TestGameStore } from "./testGames.js";

export const FINISHED_GAME_STATUSES = ["finished", "backuped"] as const;

export interface ResultSide {
  teamId: string;
  teamName: string;
  coach: string;
  /** Current team value in gold when the game was played (tabletop rows; fork rows carry none). The coach rating's team-value term reads it. */
  teamValue?: number;
}

export interface StoredTournamentResult extends GamestateResult {
  gameId: string;
  pulledAt: string;
  /** When the game was PLAYED (a fork game's finished, else started, time; a tabletop match's end of match), ISO. Absent on legacy rows: readers fall back to pulledAt. */
  playedAt?: string;
  home: ResultSide;
  away: ResultSide;
  /** True on a fork row whose team and coach names were XML-decoded when stored. A fork row without it was stored raw (still XML-escaped) and is decoded once on load. */
  namesDecoded?: true;
  /** Absent = a fork game. "tabletop" rows come from the confirmed tabletop recorder (src/tabletop). */
  source?: "fork" | "tabletop" | "naf";
  /** Tabletop only: the league/tournament fixture the match was played for, when one was named. */
  fixtureRef?: string;
  /** Tabletop only: the league id the match counts in (defaults to the fixture tournament's package name). */
  league?: string;
  /** A test row that never counts anywhere: a tabletop row from the admin Testing Suite (published or not), or a fork
   *  game listed in test-games.json (testGames.ts; stamped on every read and write). */
  test?: boolean;
  /** Tabletop only: true once an organiser published it. An unpublished tabletop row never counts anywhere. */
  published?: boolean;
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
/** The score that decides the game: the penalty-shootout score when one was recorded, else the score. */
export const effectiveScore = (team: GamestateTeamResult): number =>
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
  private writes = 0;
  private readonly testGames: TestGameStore;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tournament-results.json");
    this.testGames = new TestGameStore(dataDir);
  }

  /** Rows of listed test games read as test (also a row imported before its game was listed). */
  private markTests(results: Record<string, StoredTournamentResult>): Record<string, StoredTournamentResult> {
    const ids = this.testGames.ids();
    if (!ids.size) return results;
    const out: Record<string, StoredTournamentResult> = {};
    for (const [id, row] of Object.entries(results)) out[id] = ids.has(id) && row.test !== true ? { ...row, test: true } : row;
    return out;
  }

  private readStore(): TournamentResultStoreFile {
    if (!existsSync(this.file)) return emptyStore();
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<TournamentResultStoreFile>;
      if (parsed.version !== 1 || !parsed.results || typeof parsed.results !== "object" || Array.isArray(parsed.results))
        return emptyStore();
      const migrated = this.migrateLegacyNames({ version: 1, results: parsed.results });
      return { version: 1, results: this.markTests(migrated.results) };
    } catch {
      return emptyStore();
    }
  }

  /**
   * One-time migration of fork rows stored before names were decoded: their team and coach names are still the admin
   * list's XML-escaped text ("A&amp;B"), which split a coach's history in two. Each such row is decoded exactly once and
   * marked, so decoded rows (and tabletop/NAF rows, which never came from XML) are never touched. Persisted best-effort.
   */
  private migrateLegacyNames(store: TournamentResultStoreFile): TournamentResultStoreFile {
    let changed = false;
    const results: Record<string, StoredTournamentResult> = {};
    for (const [id, row] of Object.entries(store.results)) {
      const fork = row.source === undefined || row.source === "fork";
      if (!fork || row.namesDecoded || !row.home || !row.away) { results[id] = row; continue; }
      const side = (x: ResultSide): ResultSide => ({ ...x, teamName: decodeXml(x.teamName ?? ""), coach: decodeXml(x.coach ?? "") });
      results[id] = { ...row, home: side(row.home), away: side(row.away), namesDecoded: true };
      changed = true;
    }
    const next: TournamentResultStoreFile = { version: 1, results };
    if (changed) {
      try { atomicWriteTextFile(this.file, `${JSON.stringify(next, null, 2)}
`); } catch { /* retried on the next load; in-memory result is already correct */ }
    }
    return changed ? next : store;
  }

  get(gameId: string): StoredTournamentResult | undefined {
    const results = this.readStore().results;
    return Object.hasOwn(results, gameId) ? results[gameId] : undefined;
  }

  /** Rows that COUNT (standings, Elo, records): fork rows, and tabletop rows only once published (never test rows). */
  /** Changes whenever the retained rows change (a write through this store, or the file changing under it): a cheap cache key for derived ratings. */
  revision(): string {
    let stamp = "none";
    try { const s = statSync(this.file); stamp = `${s.mtimeMs}:${s.size}`; } catch { /* no file yet */ }
    return `${this.writes}:${stamp}`;
  }

  list(): StoredTournamentResult[] {
    return this.listAll().filter((row) => row.test !== true && (row.source !== "tabletop" || row.published === true));
  }

  /** Every stored row, including tabletop rows still pending organiser publication. */
  listAll(): StoredTournamentResult[] {
    return Object.values(this.readStore().results);
  }

  /** Remove one row (used only to retract a tabletop result when an organiser undoes a revision). */
  remove(gameId: string): boolean {
    const current = this.readStore();
    if (!Object.hasOwn(current.results, gameId)) return false;
    const { [gameId]: _gone, ...rest } = current.results;
    this.writes += 1;
    atomicWriteTextFile(this.file, `${JSON.stringify({ version: 1, results: rest }, null, 2)}
`);
    return true;
  }

  put(input: StoredTournamentResult): StoredTournamentResult {
    if (!input.gameId.trim()) throw new Error("gameId is required for tournament result metadata.");
    // Every importer (refreshFinishedResults, the single pull, the tabletop recorder) gets the test marker here.
    const result = this.testGames.has(input.gameId) && input.test !== true ? { ...input, test: true } : input;
    const current = this.readStore();
    const next: TournamentResultStoreFile = {
      version: 1,
      results: { ...current.results, [result.gameId]: result },
    };
    this.writes += 1;
    atomicWriteTextFile(this.file, `${JSON.stringify(next, null, 2)}\n`);
    if (result.source === undefined || result.source === "fork") {
      for (const listener of resultStoredListeners) { try { listener(result); } catch { /* a listener never fails the write */ } }
    }
    return result;
  }
}

const resultStoredListeners = new Set<(row: StoredTournamentResult) => void>();
/** Called after every fork row any TournamentResultStore in this process stores (the replay job queues the game). */
export function onResultStored(listener: (row: StoredTournamentResult) => void): () => void {
  resultStoredListeners.add(listener);
  return () => { resultStoredListeners.delete(listener); };
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

export const storedSide = (game: AdminGameEntry, side: "home" | "away"): ResultSide => ({
  teamId: side === "home" ? game.homeTeamId : game.awayTeamId,
  // parseAdminGameList returns the raw XML attribute text: decode once here so the stored name is the literal one.
  teamName: decodeXml(side === "home" ? game.homeTeamName : game.awayTeamName),
  coach: decodeXml(side === "home" ? game.homeCoach : game.awayCoach),
});

/** The fork admin list's finished (else started) time as ISO, or undefined when it is absent or unreadable ("2026-03-01 10:15:00.0" and ISO both parse). */
export function playedAtOf(game: Pick<AdminGameEntry, "started" | "finished">): string | undefined {
  for (const raw of [game.finished, game.started]) {
    const text = raw?.trim();
    if (!text) continue;
    const t = Date.parse(/^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(" ", "T")}Z` : text);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return undefined;
}

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
    ...(playedAtOf(game) ? { playedAt: playedAtOf(game)! } : {}),
    home: storedSide(game, "home"),
    away: storedSide(game, "away"),
    namesDecoded: true,
    teams: result.teams,
  });
}

/**
 * Discover finished/backuped games and pull only results not already retained. A game whose result cannot be read
 * (the fork lists 1072 as finished but answers its result 404) is skipped and retried on the next call instead of
 * failing every caller (/api/fork/records answered 502 for everyone while one such game existed).
 */
export async function refreshFinishedResults(
  cfg: ForkAdminConfig,
  store: TournamentResultStore,
  opts: {
    discover?: (cfg: ForkAdminConfig) => Promise<AdminGameEntry[]>;
    pull?: (cfg: ForkAdminConfig, store: TournamentResultStore, game: AdminGameEntry) => Promise<unknown>;
    onSkip?: (gameId: string, error: Error) => void;
  } = {},
): Promise<AdminGameEntry[]> {
  const games = await (opts.discover ?? discoverFinishedGames)(cfg);
  for (const game of games) {
    if (store.get(game.gameId)) continue;
    try {
      await (opts.pull ?? pullFinishedGameResult)(cfg, store, game);
    } catch (e) {
      opts.onSkip?.(game.gameId, e as Error);
    }
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
