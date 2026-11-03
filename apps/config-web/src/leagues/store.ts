/**
 * League store: one directory per league under <stateDir>/leagues/<leagueId>/ holding league.json, seasons/<seasonId>.json
 * and league-art/<sha256>.<ext> (logo / banner files written by api.ts). Every JSON write is atomic. Reads go to disk
 * each time (the files are small and change only on import or an artwork upload), so an import run in another process
 * shows up without a restart.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { linkPlayerCareers, needsPlayerIds } from "./playerIds.js";
import { markSeasonCaptainVacancies } from "./captain.js";
import { recordLeagueExits } from "../auth/leagueSharing.js";
import type { LeagueFixture, LeagueRecord, LeagueSecrets, LeagueTeam, SeasonRecord } from "./types.js";

/** One player of a league fork game, public subset: the roster position, and from a full result the SPP the league banked and the server's injury names. */
export interface LeagueGamePlayer { position?: string; spp?: number; injuries?: string[] }
/** One side of a league fork game, by fork team id: what the banked result carries beyond the results store (no treasury). */
export interface LeagueGameSide { winnings?: number; fanFactor?: number; dedicatedFansModifier?: number; players: Record<string, LeagueGamePlayer> }
/** The public digest of a league fixture's fork game (game pages): positions from the season rosters, plus the banked result's extras. */
export interface LeagueGameDigest { source?: "full" | "basic"; teams: Record<string, LeagueGameSide> }

/** Where a fork game was played for a league fixture, and the legal-concession verdicts its banked result carries. */
export interface ForkGameIndexEntry {
  leagueId: string;
  seasonId: string;
  fixtureId: string;
  /** By fork team id; only sides whose banked result carries concededLegally. Absent = none. */
  verdicts?: Record<string, boolean>;
  /** Positions and banked-result extras by fork team / fork player id (absent when the fixture knows none). */
  digest?: LeagueGameDigest;
}

/** The public digest of one fixture's fork game: roster positions by fork player id, and the banked result's SPP, injuries, winnings and fans. */
function forkGameDigest(f: LeagueFixture, teams: readonly LeagueTeam[]): LeagueGameDigest | undefined {
  const fork = f.fork;
  if (!fork) return undefined;
  const out: LeagueGameDigest = { ...(fork.result ? { source: fork.result.source } : {}), teams: {} };
  for (const side of ["home", "away"] as const) {
    const ft = fork.teams[side];
    if (!ft) continue;
    const team = teams.find((t) => t.id === ft.teamId);
    const positionOf = (playerId: string | undefined): string | undefined => {
      if (!playerId || !team) return undefined;
      const p = team.players.find((x) => x.playerId === playerId) ?? (team.formerPlayers ?? []).find((x) => x.playerId === playerId);
      return p?.position || undefined;
    };
    const players: Record<string, LeagueGamePlayer> = {};
    for (const m of ft.players ?? []) {
      const position = positionOf(m.playerId);
      if (position) players[m.forkPlayerId] = { position };
    }
    const r = fork.result?.[side];
    const full = fork.result?.source === "full";
    for (const l of r?.lines ?? []) {
      const position = positionOf(l.playerId) ?? players[l.forkPlayerId]?.position;
      const injuries = full ? (l.injuries ?? []).filter((x) => typeof x === "string" && x !== "") : [];
      const entry: LeagueGamePlayer = {
        ...(position ? { position } : {}),
        ...(full && typeof l.spp === "number" ? { spp: l.spp } : {}),
        ...(injuries.length ? { injuries } : {}),
      };
      if (Object.keys(entry).length) players[l.forkPlayerId] = entry;
    }
    const sideOut: LeagueGameSide = {
      ...(r && full && typeof r.winnings === "number" ? { winnings: r.winnings } : {}),
      ...(r && typeof r.fanFactor === "number" ? { fanFactor: r.fanFactor } : {}),
      ...(r && typeof r.dedicatedFansModifier === "number" ? { dedicatedFansModifier: r.dedicatedFansModifier } : {}),
      players,
    };
    if (Object.keys(sideOut).length > 1 || Object.keys(players).length) out.teams[ft.forkTeamId] = sideOut;
  }
  return Object.keys(out.teams).length ? out : undefined;
}

/** The index entry of one fixture's fork game (undefined when the fixture has no fork game). */
function forkGameEntry(leagueId: string, seasonId: string, f: LeagueFixture, teams: readonly LeagueTeam[] = []): ForkGameIndexEntry | undefined {
  const fork = f.fork;
  if (!fork?.gameId && !fork?.result) return undefined;
  const verdicts: Record<string, boolean> = {};
  for (const side of ["home", "away"] as const) {
    const verdict = fork.result?.[side].concededLegally;
    const team = fork.teams[side];
    if (team && typeof verdict === "boolean") verdicts[team.forkTeamId] = verdict;
  }
  const digest = forkGameDigest(f, teams);
  return { leagueId, seasonId, fixtureId: f.id, ...(Object.keys(verdicts).length ? { verdicts } : {}), ...(digest ? { digest } : {}) };
}

export const LEAGUE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const SEASON_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const LEAGUE_ART_DIR = "league-art";
export const LEAGUE_ART_PATH = /^league-art\/[a-f0-9]{64}\.(png|jpg|webp)$/;

export class LeagueStoreError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type LeagueInput = Omit<LeagueRecord, "createdAt" | "updatedAt" | "organisers" | "description"> &
  Partial<Pick<LeagueRecord, "createdAt" | "organisers" | "description">>;

export class LeagueStore {
  readonly root: string;

  /**
   * Fork game id -> league fixture (forkGame). Built lazily from every season once, then kept current by putSeason /
   * removeSeason, so a lookup (hit or miss) reads no file. A season written by ANOTHER process (an import run, a rig) is
   * picked up when the index is rebuilt, at most every `forkIndexTtlMs`.
   */
  private forkIndex: { at: number; byGame: Map<string, ForkGameIndexEntry> } | undefined;
  /** Season writes / removals through this store (forkIndexVersion). */
  private seasonWrites = 0;
  /** Bumped by every file write, season removal and invalidate() through this store (version(): read-model caches). */
  private generation = 0;
  private readonly forkIndexTtlMs: number;
  private readonly now: () => number;
  /**
   * Built into every store (spec 2026-10-31, review P1): after a season write or removal, the coach accounts that are no
   * longer on ANY season of the league (an organiser cleared or moved their only assignment, a re-import dropped them,
   * a season went) lose their league acknowledgement in the identities file (recordLeagueExits), so a re-joining coach
   * confirms again. Every writer (the server, the TourPlay importer, scripts) goes through a LeagueStore, so none skips it.
   * `identitiesFile` = the file to update (default: IDENTITIES_FILE, else the default identities.json); `onRosterExit`
   * only observes (tests). Under the test runner, a store with neither an explicit file nor IDENTITIES_FILE never touches
   * the default (live) identities file.
   */
  private readonly rosterExit: (leagueId: string, coaches: string[]) => void;
  /** False only under the test runner with no identities file to update and no observer: nothing to compute. */
  private readonly exitsActive: boolean;

  constructor(stateDir: string, opts: {
    forkIndexTtlMs?: number; now?: () => number; identitiesFile?: string; onRosterExit?: (leagueId: string, coaches: string[]) => void;
  } = {}) {
    this.root = join(stateDir, "leagues");
    this.forkIndexTtlMs = opts.forkIndexTtlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
    const file = opts.identitiesFile;
    const guarded = () => Boolean(process.env.VITEST && !file && !process.env.IDENTITIES_FILE);
    this.exitsActive = Boolean(opts.onRosterExit) || !guarded();
    this.rosterExit = (leagueId, coaches) => {
      opts.onRosterExit?.(leagueId, coaches);
      if (guarded()) return;
      recordLeagueExits(leagueId, coaches, new Date(this.now()), file);
    };
  }

  /**
   * Changes whenever the fork-game index may have changed: a season written or removed here, or the index rebuilt (which
   * picks up another process's writes). Game-page caches put it in their revision stamp. Reads no file.
   */
  forkIndexVersion(): string {
    return `${this.seasonWrites}:${this.forkIndex?.at ?? 0}`;
  }

  /** The league fixture fork game `gameId` was played for, if any (cached index; see forkIndex). */
  forkGame(gameId: string): ForkGameIndexEntry | undefined {
    const index = this.forkIndex && this.now() - this.forkIndex.at < this.forkIndexTtlMs ? this.forkIndex : this.buildForkIndex();
    const hit = index.byGame.get(gameId);
    return hit ? structuredClone(hit) : undefined;
  }

  private buildForkIndex(): NonNullable<LeagueStore["forkIndex"]> {
    const byGame = new Map<string, ForkGameIndexEntry>();
    if (existsSync(this.root)) {
      for (const leagueId of readdirSync(this.root).filter((id) => LEAGUE_ID.test(id))) {
        for (const s of this.rawSeasons(leagueId)) this.indexSeason(byGame, s);
      }
    }
    this.forkIndex = { at: this.now(), byGame };
    return this.forkIndex;
  }

  private indexSeason(byGame: Map<string, ForkGameIndexEntry>, s: SeasonRecord): void {
    for (const f of s.fixtures ?? []) {
      const entry = forkGameEntry(s.leagueId, s.id, f, s.teams ?? []);
      const gameId = f.fork?.result?.gameId ?? f.fork?.gameId;
      if (entry && gameId) byGame.set(gameId, entry);
    }
  }

  /** Drops a season's entries from a built index (a season write or removal); an unbuilt index stays unbuilt. */
  private unindexSeason(leagueId: string, seasonId: string): void {
    if (!this.forkIndex) return;
    for (const [gameId, e] of this.forkIndex.byGame) if (e.leagueId === leagueId && e.seasonId === seasonId) this.forkIndex.byGame.delete(gameId);
  }

  leagueDir(id: string): string {
    if (!LEAGUE_ID.test(id)) throw new LeagueStoreError(400, "League id must be lower-case letters, digits or dashes.");
    return join(this.root, id);
  }

  /** Parsed files keyed by path, reused while size + mtime are unchanged (season files run to a few hundred KB). */
  private cache = new Map<string, { stamp: string; value: unknown }>();

  /** Drop the parsed-file cache and the fork-game index (account deletion rewrote league files). */
  invalidate(): void {
    this.generation += 1;
    this.cache.clear();
    this.forkIndex = undefined;
  }

  private readJson<T>(path: string): T | undefined {
    try {
      const st = statSync(path);
      const stamp = `${st.size}:${st.mtimeMs}`;
      const hit = this.cache.get(path);
      if (hit && hit.stamp === stamp) return structuredClone(hit.value) as T;
      const value = JSON.parse(readFileSync(path, "utf8")) as T;
      this.cache.set(path, { stamp, value });
      return structuredClone(value);
    } catch {
      return undefined;
    }
  }

  /** Changes on every write, season removal and invalidate() through this store; reads no file. */
  version(): number {
    return this.generation;
  }

  private write(path: string, value: unknown): void {
    atomicWriteTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
    this.generation += 1;
  }

  list(): LeagueRecord[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => LEAGUE_ID.test(id))
      .map((id) => this.league(id))
      .filter((l): l is LeagueRecord => Boolean(l))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  league(id: string): LeagueRecord | undefined {
    if (!LEAGUE_ID.test(id)) return undefined;
    const rec = this.readJson<LeagueRecord>(join(this.root, id, "league.json"));
    if (!rec || rec.id !== id) return undefined;
    return { ...rec, organisers: Array.isArray(rec.organisers) ? rec.organisers : [], description: rec.description ?? "" };
  }

  /** Creates the league or updates its descriptive fields (artwork paths are kept unless given). */
  upsertLeague(input: LeagueInput, now = new Date()): LeagueRecord {
    const dir = this.leagueDir(input.id);
    mkdirSync(join(dir, "seasons"), { recursive: true });
    const prior = this.league(input.id);
    const at = now.toISOString();
    const next: LeagueRecord = {
      ...(prior ?? {}),
      ...input,
      description: input.description ?? prior?.description ?? "",
      organisers: input.organisers ?? prior?.organisers ?? [],
      createdAt: prior?.createdAt ?? input.createdAt ?? at,
      updatedAt: at,
    };
    for (const key of ["logoPath", "bannerPath"] as const) {
      const value = input[key] ?? prior?.[key];
      if (value && LEAGUE_ART_PATH.test(value)) next[key] = value; else delete next[key];
    }
    this.write(join(dir, "league.json"), next);
    return next;
  }

  /** Records (or clears) a logo / banner path; the caller owns the file. */
  setArt(id: string, kind: "logo" | "banner", path: string | undefined, now = new Date()): LeagueRecord {
    const league = this.league(id);
    if (!league) throw new LeagueStoreError(404, "League not found.");
    const key = kind === "logo" ? "logoPath" : "bannerPath";
    if (path === undefined) delete league[key];
    else if (LEAGUE_ART_PATH.test(path)) league[key] = path;
    else throw new LeagueStoreError(400, "Bad artwork path.");
    league.updatedAt = now.toISOString();
    this.write(join(this.leagueDir(id), "league.json"), league);
    return league;
  }

  /**
   * Read-modify-write of league.json (settings). The mutator may throw a LeagueStoreError to refuse; nothing is written
   * then. updatedAt is stamped; the caller manages `revision`.
   */
  updateLeague(id: string, mutate: (league: LeagueRecord) => void, now = new Date()): LeagueRecord {
    const league = this.league(id);
    if (!league) throw new LeagueStoreError(404, "League not found.");
    mutate(league);
    league.updatedAt = now.toISOString();
    this.write(join(this.leagueDir(id), "league.json"), league);
    return league;
  }

  /** The league's secrets (Discord webhook URL). Server-side only: never put this in a read model or a log line. */
  secrets(id: string): LeagueSecrets {
    if (!LEAGUE_ID.test(id)) return {};
    const raw = this.readJson<LeagueSecrets>(join(this.root, id, "secrets.json"));
    return raw && typeof raw === "object" ? raw : {};
  }

  setSecrets(id: string, secrets: LeagueSecrets): void {
    if (!this.league(id)) throw new LeagueStoreError(404, "League not found.");
    this.write(join(this.leagueDir(id), "secrets.json"), secrets);
  }

  /** Every season of the league, newest first. A season stored before player ids existed is given the ids (and career links) the importer would assign. */
  seasons(leagueId: string): SeasonRecord[] {
    const list = this.rawSeasons(leagueId);
    if (needsPlayerIds(list)) linkPlayerCareers(list);
    return list;
  }

  private rawSeasons(leagueId: string): SeasonRecord[] {
    if (!LEAGUE_ID.test(leagueId)) return [];
    const dir = join(this.root, leagueId, "seasons");
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && SEASON_ID.test(f.slice(0, -5)))
      .map((f) => this.readJson<SeasonRecord>(join(dir, f)))
      .filter((s): s is SeasonRecord => Boolean(s && s.id && s.leagueId === leagueId))
      .sort((a, b) => b.number - a.number);
  }

  season(leagueId: string, seasonId: string): SeasonRecord | undefined {
    if (!LEAGUE_ID.test(leagueId) || !SEASON_ID.test(seasonId)) return undefined;
    const s = this.readJson<SeasonRecord>(join(this.root, leagueId, "seasons", `${seasonId}.json`));
    if (!s || s.id !== seasonId || s.leagueId !== leagueId) return undefined;
    return needsPlayerIds([s]) ? this.seasons(leagueId).find((x) => x.id === seasonId) : s;
  }

  /** Writes a season; an existing season with the same sourceSlug (or id) is replaced. Returns the replaced id, if any. */
  putSeason(season: SeasonRecord): { replaced?: string } {
    if (!this.league(season.leagueId)) throw new LeagueStoreError(404, "League not found.");
    if (!SEASON_ID.test(season.id)) throw new LeagueStoreError(400, "Bad season id.");
    const dir = join(this.leagueDir(season.leagueId), "seasons");
    mkdirSync(dir, { recursive: true });
    const all = this.rawSeasons(season.leagueId);
    const prior = all.find((s) => s.sourceSlug === season.sourceSlug || s.id === season.id);
    const after = [...all.filter((s) => s.id !== season.id && s.id !== prior?.id), season];
    // Monotonic per season id (also when the caller wrote from a stale copy): read-model caches key on it.
    season.revision = Math.max(all.find((s) => s.id === season.id)?.revision ?? 0, season.revision ?? 0) + 1;
    // Team Captain vacancy (leagues/captain.ts): every writer's roster change against the stored copy, so none skips it.
    markSeasonCaptainVacancies(all.find((s) => s.id === season.id), season);
    this.write(join(dir, `${season.id}.json`), season);
    this.seasonWrites += 1;
    this.unindexSeason(season.leagueId, season.id);
    if (this.forkIndex) this.indexSeason(this.forkIndex.byGame, season);
    if (prior && prior.id !== season.id) this.dropSeasonFile(season.leagueId, prior.id);
    this.reportExits(season.leagueId, all, after);
    return prior ? { replaced: prior.id } : {};
  }

  removeSeason(leagueId: string, seasonId: string): void {
    if (!SEASON_ID.test(seasonId)) return;
    const before = this.exitsActive ? this.rawSeasons(leagueId) : [];
    this.dropSeasonFile(leagueId, seasonId);
    this.reportExits(leagueId, before, before.filter((s) => s.id !== seasonId));
  }

  private dropSeasonFile(leagueId: string, seasonId: string): void {
    const path = join(this.leagueDir(leagueId), "seasons", `${seasonId}.json`);
    try { unlinkSync(path); } catch { /* gone */ }
    this.generation += 1;
    this.seasonWrites += 1;
    this.unindexSeason(leagueId, seasonId);
  }

  /**
   * League registration (lane L6): a coach acknowledged the league notice when they asked to join; when that entry ends
   * before (or without) a seat (declined, withdrawn, removed), the acknowledgement goes again unless the coach is on a
   * roster of the league or still has a live entry in one of its seasons. Same writer as a roster exit.
   */
  releaseRegistrationAcks(leagueId: string, coaches: readonly string[]): void {
    if (!this.exitsActive || !coaches.length) return;
    const seasons = this.rawSeasons(leagueId);
    const seated = rosterAccounts(seasons);
    const live = new Set<string>();
    for (const s of seasons) for (const r of s.registrations ?? []) {
      if (r.state === "pending" || r.state === "waitlisted" || r.state === "accepted") live.add(r.coach.trim().toLowerCase());
    }
    const gone = [...new Set(coaches.map((c) => c.trim()).filter(Boolean))].filter((c) => !seated.has(c.toLowerCase()) && !live.has(c.toLowerCase()));
    if (!gone.length) return;
    try { this.rosterExit(leagueId, gone); } catch { /* the season write stands */ }
  }

  private reportExits(leagueId: string, before: readonly SeasonRecord[], after: readonly SeasonRecord[]): void {
    if (!this.exitsActive) return;
    const now = rosterAccounts(after);
    const gone = [...rosterAccounts(before)].filter(([key]) => !now.has(key)).map(([, coach]) => coach);
    if (!gone.length) return;
    try { this.rosterExit(leagueId, gone); } catch { /* the season write stands */ }
  }
}

/** Coach accounts on a league's seasons (team rows not cleared by an organiser, participant rows): key -> spelling.
 *  The same rule as isLeagueRosterMember (src/auth/contactFor.ts). */
export function rosterAccounts(seasons: readonly SeasonRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  const add = (c: string | undefined) => { const v = c?.trim(); if (v && !out.has(v.toLowerCase())) out.set(v.toLowerCase(), v); };
  for (const s of seasons) {
    for (const t of s.teams ?? []) if (!t.coachAssigned?.cleared) add(t.coachId);
    for (const p of s.participants ?? []) add(p.coachId);
  }
  return out;
}

/** Organiser or owner (by trimmed, case-insensitive coach id) of this league; admins are checked by the caller. */
export function isLeagueOrganiser(league: Pick<LeagueRecord, "organisers" | "owner">, coach: string): boolean {
  const key = coach.trim().toLowerCase();
  return Boolean(key) && [...league.organisers, ...(league.owner ? [league.owner] : [])].some((id) => id.trim().toLowerCase() === key);
}

/** The league owner: the recorded owner, else the first organiser ("" when there is none). */
export function leagueOwner(league: Pick<LeagueRecord, "organisers" | "owner">): string {
  return league.owner?.trim() || league.organisers[0]?.trim() || "";
}
