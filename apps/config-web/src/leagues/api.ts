/**
 * League routes. Reads are public; artwork writes need a session and an organiser of the league (or an admin).
 *
 *   GET    /api/leagues                          list (summaries)
 *   GET    /api/leagues/:id                      league + season summaries (newest first)
 *   GET    /api/leagues/:id/seasons/:seasonId    one full season
 *   GET    /api/leagues/:id/stats?scope=         aggregates: bb2020 | bb2025 | all (default all)
 *   GET    /api/leagues/:id/logo|banner          the image (public)
 *   PUT    /api/leagues/:id/logo|banner          raw image body (PNG / JPEG / WebP; logo 1 MB, banner 2 MB)
 *   DELETE /api/leagues/:id/logo|banner
 *
 * Image guards reuse the team-avatar helpers (magic-byte sniff with header-parsed dimensions, the per-coach rate
 * limit) as the tournament banner does; files are stored under the league's own directory with a hashed name.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { AVATAR_CONTENT_TYPE, avatarRateLimit, sniffImage, type AvatarExt, type SniffedImage } from "../teamAvatars.js";
import { leagueStats, isStatsScope, type LeagueStats, type StatsScope } from "./stats.js";
import { fixturePlayed } from "./tourplay.js";
import { isLeagueOrganiser, LEAGUE_ART_DIR, LEAGUE_ART_PATH, LeagueStore } from "./store.js";
import type { LeagueRecord, LeagueRuleset, SeasonRecord, SeasonStatus } from "./types.js";

export const LOGO_MAX_BYTES = 1024 * 1024;
export const BANNER_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIN_PX = 64;
export const LOGO_MAX_PX = 2048;
export const BANNER_MIN_WIDTH = 600;
export const BANNER_MAX_WIDTH = 4000;

export type ArtKind = "logo" | "banner";

export interface LeagueSummary {
  id: string;
  name: string;
  fullName: string;
  slug: string;
  description: string;
  organisers: string[];
  createdAt: string;
  logoUrl?: string;
  bannerUrl?: string;
  seasonCount: number;
  currentSeason?: SeasonSummary;
}

export interface SeasonSummary {
  id: string;
  number: number;
  name: string;
  ruleset: LeagueRuleset;
  status: SeasonStatus;
  startedAt?: string;
  endedAt?: string;
  teamCount: number;
  fixtureCount: number;
  playedCount: number;
  champion?: { coach: string; team: string; race: string };
}

export interface LeagueApiIdentity { coach: string; admin: boolean }

export interface LeagueApiDeps {
  store: LeagueStore;
  /** Raw body reader (artwork PUT): undefined = larger than max (the caller closes the connection). */
  readBody?(max: number): Promise<Buffer | undefined>;
  declaredTooLarge?(max: number): boolean;
  now?: () => Date;
}

export interface LeagueApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  file?: { path: string; contentType: string };
  close?: boolean;
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export function artUrl(league: Pick<LeagueRecord, "id" | "logoPath" | "bannerPath">, kind: ArtKind): string | undefined {
  const path = kind === "logo" ? league.logoPath : league.bannerPath;
  if (!path || !LEAGUE_ART_PATH.test(path)) return undefined;
  const hash = path.slice(LEAGUE_ART_DIR.length + 1, LEAGUE_ART_DIR.length + 13);
  return `/api/leagues/${encodeURIComponent(league.id)}/${kind}?v=${hash}`;
}

export function seasonSummary(s: SeasonRecord): SeasonSummary {
  const champ = s.awards.find((a) => a.type === "Overall Champion");
  const played = s.fixtures.filter(fixturePlayed).length;
  return {
    id: s.id,
    number: s.number,
    name: s.name,
    ruleset: s.ruleset,
    status: s.status,
    ...(s.startedAt ? { startedAt: s.startedAt } : {}),
    ...(s.endedAt ? { endedAt: s.endedAt } : {}),
    teamCount: s.teams.length || new Set(s.participants.map((p) => p.team)).size,
    fixtureCount: s.fixtures.length,
    playedCount: played,
    ...(champ ? { champion: { coach: champ.coach, team: champ.team, race: champ.race } } : {}),
  };
}

export function leagueSummary(league: LeagueRecord, seasons: SeasonRecord[]): LeagueSummary {
  const { logoPath: _l, bannerPath: _b, updatedAt: _u, ...rest } = league;
  const logo = artUrl(league, "logo");
  const banner = artUrl(league, "banner");
  const newest = [...seasons].sort((a, b) => b.number - a.number)[0];
  return {
    ...rest,
    ...(logo ? { logoUrl: logo } : {}),
    ...(banner ? { bannerUrl: banner } : {}),
    seasonCount: seasons.length,
    ...(newest ? { currentSeason: seasonSummary(newest) } : {}),
  };
}

/** Matches /api/leagues[/...]; undefined when the path is not a league route. */
export function leaguePath(pathname: string): { id?: string; rest: string[] } | undefined {
  const m = /^\/api\/leagues(?:\/(.*))?$/.exec(pathname);
  if (!m) return undefined;
  if (!m[1]) return { rest: [] };
  try {
    const [id, ...rest] = m[1].split("/").map((p) => decodeURIComponent(p));
    return { id, rest };
  } catch {
    return { rest: ["\0bad"] };
  }
}

/** True for the public reads (GET/HEAD); the session gate in front of handleApi waves these through. */
export function isPublicLeagueRead(method: string, pathname: string): boolean {
  return (method === "GET" || method === "HEAD") && leaguePath(pathname) !== undefined;
}

export function checkLeagueArt(kind: ArtKind, b: Buffer): { ok: true; image: SniffedImage } | { ok: false; error: string } {
  const max = kind === "logo" ? LOGO_MAX_BYTES : BANNER_MAX_BYTES;
  const label = kind === "logo" ? "The logo" : "The header bar";
  if (b.length === 0) return { ok: false, error: "An image is required." };
  if (b.length > max) return { ok: false, error: `${label} must be at most ${max / (1024 * 1024)} MB.` };
  const image = sniffImage(b);
  if (!image) return { ok: false, error: `${label} must be a PNG, JPEG or WebP file.` };
  if (kind === "logo") {
    if (image.width < LOGO_MIN_PX || image.height < LOGO_MIN_PX || image.width > LOGO_MAX_PX || image.height > LOGO_MAX_PX)
      return { ok: false, error: `The logo must be ${LOGO_MIN_PX} to ${LOGO_MAX_PX} pixels on each side.` };
  } else {
    if (image.width < BANNER_MIN_WIDTH || image.width > BANNER_MAX_WIDTH)
      return { ok: false, error: `The header bar must be ${BANNER_MIN_WIDTH} to ${BANNER_MAX_WIDTH} pixels wide.` };
    if (image.height < 1 || image.height >= image.width) return { ok: false, error: "The header bar must be wider than it is tall." };
  }
  return { ok: true, image };
}

/**
 * Stores checked artwork bytes for a league (file first, then the record) and removes the previous file when nothing
 * points at it any more. Shared by the PUT route and the importer.
 */
export async function storeLeagueArt(store: LeagueStore, id: string, kind: ArtKind, bytes: Buffer, ext: AvatarExt, now = new Date()): Promise<LeagueRecord> {
  return withArtLock(id, async () => {
    const dir = store.leagueDir(id);
    const rel = `${LEAGUE_ART_DIR}/${sha(`${id}\0${kind}\0${sha(bytes)}`)}.${ext}`;
    const target = join(dir, rel);
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const previous = kind === "logo" ? store.league(id)?.logoPath : store.league(id)?.bannerPath;
    try {
      await fsp.mkdir(join(dir, LEAGUE_ART_DIR), { recursive: true });
      await fsp.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await fsp.rename(temp, target);
    } catch (err) {
      try { await fsp.unlink(temp); } catch { /* none */ }
      throw err;
    }
    const updated = store.setArt(id, kind, rel, now);
    await dropUnreferenced(store, id, previous);
    return updated;
  });
}

async function dropUnreferenced(store: LeagueStore, id: string, rel: string | undefined): Promise<void> {
  const league = store.league(id);
  if (!rel || !LEAGUE_ART_PATH.test(rel) || league?.logoPath === rel || league?.bannerPath === rel) return;
  try { await fsp.unlink(join(store.leagueDir(id), rel)); } catch { /* already gone */ }
}

const artLocks = new Map<string, Promise<unknown>>();
function withArtLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prior = artLocks.get(id) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.catch(() => undefined);
  artLocks.set(id, tail);
  void tail.then(() => { if (artLocks.get(id) === tail) artLocks.delete(id); });
  return run;
}

const statsCache = new Map<string, { key: string; stats: LeagueStats }>();

function statsFor(store: LeagueStore, leagueId: string, scope: StatsScope): LeagueStats {
  const seasons = store.seasons(leagueId);
  const key = seasons.map((s) => `${s.id}@${s.importedAt}`).join("|");
  const cacheKey = `${leagueId}\0${scope}`;
  const hit = statsCache.get(cacheKey);
  if (hit && hit.key === key) return hit.stats;
  const stats = leagueStats(seasons, scope);
  statsCache.set(cacheKey, { key, stats });
  return stats;
}

export async function leagueApi(
  method: string,
  pathname: string,
  query: URLSearchParams,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const route = leaguePath(pathname);
  if (!route) return undefined;
  const { store } = deps;
  const read = method === "GET" || method === "HEAD";
  if (!route.id) {
    if (!read) return { status: 405, body: { error: "Use GET." } };
    return { status: 200, body: { leagues: store.list().map((l) => leagueSummary(l, store.seasons(l.id))) } };
  }
  const league = store.league(route.id);
  const [first, second, ...extra] = route.rest;

  if (first === "logo" || first === "banner") {
    if (second !== undefined) return { status: 404, body: { error: "Not found." } };
    return artRoute(method, first, route.id, league, auth, deps);
  }
  if (!read) return { status: 405, body: { error: "Use GET." } };
  if (!league) return { status: 404, body: { error: "League not found." } };
  if (first === undefined) {
    const seasons = store.seasons(league.id);
    return { status: 200, body: { league: leagueSummary(league, seasons), seasons: seasons.map(seasonSummary) } };
  }
  if (first === "seasons" && second && extra.length === 0) {
    const season = store.season(league.id, second);
    if (!season) return { status: 404, body: { error: "Season not found." } };
    return { status: 200, body: { league: leagueSummary(league, store.seasons(league.id)), season } };
  }
  if (first === "stats" && second === undefined) {
    const raw = query.get("scope") ?? "all";
    if (!isStatsScope(raw)) return { status: 400, body: { error: "scope must be bb2020, bb2025 or all." } };
    return { status: 200, body: statsFor(store, league.id, raw) };
  }
  return { status: 404, body: { error: "Not found." } };
}

async function artRoute(
  method: string,
  kind: ArtKind,
  id: string,
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  const { store } = deps;
  const label = kind === "logo" ? "logo" : "header bar";
  if (method === "GET" || method === "HEAD") {
    const rel = kind === "logo" ? league?.logoPath : league?.bannerPath;
    if (!league || !rel || !LEAGUE_ART_PATH.test(rel)) return { status: 404, body: { error: `No ${label}.` } };
    const ext = rel.split(".").pop() as AvatarExt;
    return { status: 200, file: { path: join(store.leagueDir(id), rel), contentType: AVATAR_CONTENT_TYPE[ext] } };
  }
  if (method !== "PUT" && method !== "DELETE") return { status: 405, body: { error: "Use GET, PUT or DELETE." } };
  if (!auth) return { status: 401, body: { error: `Sign in to change the ${label}.` } };
  if (!league) return { status: 404, body: { error: "League not found." } };
  const wait = avatarRateLimit(`league-art:${auth.coach.trim().toLowerCase()}`);
  if (wait > 0) return { status: 429, headers: { "retry-after": String(wait) }, body: { error: "Too many artwork changes. Try again in a minute." } };
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return { status: 403, body: { error: "You are not an organiser of this league." } };
  const now = deps.now?.() ?? new Date();
  if (method === "DELETE") {
    await withArtLock(id, async () => {
      const previous = kind === "logo" ? store.league(id)?.logoPath : store.league(id)?.bannerPath;
      store.setArt(id, kind, undefined, now);
      await dropUnreferenced(store, id, previous);
    });
    return { status: 204 };
  }
  const max = kind === "logo" ? LOGO_MAX_BYTES : BANNER_MAX_BYTES;
  const tooLarge: LeagueApiResult = { status: 413, close: true, body: { error: `The ${label} must be at most ${max / (1024 * 1024)} MB.` } };
  if (deps.declaredTooLarge?.(max)) return tooLarge;
  const bytes = await deps.readBody?.(max);
  if (!bytes) return tooLarge;
  const checked = checkLeagueArt(kind, bytes);
  if (!checked.ok) return { status: 400, body: { error: checked.error } };
  try {
    const updated = await storeLeagueArt(store, id, kind, bytes, checked.image.ext, now);
    return { status: 200, body: { ok: true, [`${kind}Url`]: artUrl(updated, kind) } };
  } catch {
    return { status: 500, body: { error: `Could not store the ${label} right now.` } };
  }
}
