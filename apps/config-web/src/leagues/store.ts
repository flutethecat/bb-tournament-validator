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
import type { LeagueRecord, SeasonRecord } from "./types.js";

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

  constructor(stateDir: string) {
    this.root = join(stateDir, "leagues");
  }

  leagueDir(id: string): string {
    if (!LEAGUE_ID.test(id)) throw new LeagueStoreError(400, "League id must be lower-case letters, digits or dashes.");
    return join(this.root, id);
  }

  /** Parsed files keyed by path, reused while size + mtime are unchanged (season files run to a few hundred KB). */
  private cache = new Map<string, { stamp: string; value: unknown }>();

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

  private write(path: string, value: unknown): void {
    atomicWriteTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
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
    const prior = this.rawSeasons(season.leagueId).find((s) => s.sourceSlug === season.sourceSlug || s.id === season.id);
    this.write(join(dir, `${season.id}.json`), season);
    if (prior && prior.id !== season.id) this.removeSeason(season.leagueId, prior.id);
    return prior ? { replaced: prior.id } : {};
  }

  removeSeason(leagueId: string, seasonId: string): void {
    if (!SEASON_ID.test(seasonId)) return;
    const path = join(this.leagueDir(leagueId), "seasons", `${seasonId}.json`);
    try { unlinkSync(path); } catch { /* gone */ }
  }
}

/** Organiser (by trimmed, case-insensitive coach id) of this league; admins are checked by the caller. */
export function isLeagueOrganiser(league: Pick<LeagueRecord, "organisers">, coach: string): boolean {
  const key = coach.trim().toLowerCase();
  return Boolean(key) && league.organisers.some((id) => id.trim().toLowerCase() === key);
}
