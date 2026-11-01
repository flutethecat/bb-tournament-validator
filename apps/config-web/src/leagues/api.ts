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
 * League settings (organisers of the league and site admins; anonymous 401, other coaches 403): see settingsRoutes.
 *   GET    /api/leagues/:id/settings[?season=]                    settings read model (webhook URL masked)
 *   PATCH  /api/leagues/:id/settings                              { revision, administration?, information?, registrations?, teamBuilding?, connections? }
 *   GET    /api/leagues/:id/coaches?q=                            coach-name lookup against the identities (add organiser)
 *   POST   /api/leagues/:id/seasons                               { name?, ruleset? } start the next season
 *   GET    /api/leagues/:id/seasons/:seasonId/podium              the podium Finish season proposes (standings.ts) + candidates
 *   POST   /api/leagues/:id/seasons/:seasonId/finish              { podium?: { champion?, runnerUp?, consolation? } (team refs) } status -> completed, crowns the podium
 *   POST   /api/leagues/:id/seasons/:seasonId/reopen              a season finished here goes back in progress; its podium is cleared
 *   PATCH  /api/leagues/:id/seasons/:seasonId/phases/:phaseId     { revision, format: "table" | "knockout" } mark a phase (standings / podium)
 *   PATCH  /api/leagues/:id/seasons/:seasonId/teams/:teamId       { revision, coachId, allSeasons? } assign a coach account (teamCoach.ts)
 *   PATCH  /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId { forkEnabled?, forkAllowLate?, forkCancelled? } Super FUMBBL per fixture
 *   GET|POST /api/leagues/:id/seasons/:seasonId/participants, PATCH .../participants/:teamId  Participants tab flags: see participants.ts
 *                                                                 { date?, round?, result? } fixtures editor (events.ts)
 * News and the fixtures editor (create / delete): see events.ts.
 *   POST   /api/leagues/:id/discord/test                          send a small test embed to the webhook
 *   GET    /api/leagues/:id/export.zip[?season=]                  CSV zip (teams, fixtures, standings, participants, honours, awards)
 *
 * Play on Super FUMBBL (fixture summary, generate, launch file, reset, result sync): see forkPlay.ts.
 *   GET /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId, POST .../fork/generate|launch|reset|sync, GET .../fork/jnlp
 *
 * Redraft (board for organisers, Team Draft List for the team's coach): see redraftApi.ts.
 *   GET|POST /api/leagues/:id/redraft, GET /api/leagues/:id/redraft/teams/:teamId, POST .../rest, POST .../submit,
 *   GET /api/leagues?redraft=mine
 *
 * Image guards reuse the team-avatar helpers (magic-byte sniff with header-parsed dimensions, the per-coach rate
 * limit) as the tournament banner does; files are stored under the league's own directory with a hashed name.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { AVATAR_CONTENT_TYPE, avatarRateLimit, sniffImage, type AvatarExt, type SniffedImage } from "../teamAvatars.js";
import type { NotificationInput } from "../notifications.js";
import { buildMilestonePost, buildTestPost, discordEvents, postWebhook as defaultPoster, type DiscordPayload, type WebhookPoster } from "./discord.js";
import { editFixture, leagueEventRoutes } from "./events.js";
import { leagueCsvFiles, zipFiles } from "./exportZip.js";
import { readJsonObject, requestRevision } from "./http.js";
import { applyForkSettings, leagueForkRoutes, publicForkState, updateForkSettings, type LeagueForkClient } from "./forkPlay.js";
import { applyPendingDrafts } from "./redraft.js";
import { assignTeamCoach } from "./teamCoach.js";
import { myRedraftTasks, redraftRoutes } from "./redraftApi.js";
import { leagueParticipantRoutes, participantsForPublic } from "./participants.js";
import {
  parseConnections, parseInformation, parseRegistrations, parseTeamBuilding, registrationsOf, settingsView, SettingsError, teamBuildingTable,
} from "./settings.js";
import { leagueStats, isStatsScope, type LeagueStats, type StatsScope } from "./stats.js";
import { clearStandingsCache, podiumAwards, PODIUM_SLOTS, proposePodium, withStandings, type PodiumPlace } from "./standings.js";
import { fixturePlayed } from "./tourplay.js";
import { ORGANISER_LOG_KINDS } from "./teamValue.js";
import { isLeagueOrganiser, LEAGUE_ART_DIR, LEAGUE_ART_PATH, leagueOwner, LeagueStore, LeagueStoreError, SEASON_ID } from "./store.js";
import { LEAGUE_RULESETS, type LeagueFixture, type LeagueRecord, type LeagueTeam, type LeagueRuleset, type PodiumSlot, type SeasonRecord, type SeasonStatus } from "./types.js";

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
  /** Play on Super FUMBBL is on for this league (fixtures show the per-fixture switch to admins). */
  playOnFork: boolean;
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
  /** Finished on this site (it carries a podium record): an organiser may reopen it. */
  finishedHere?: boolean;
}

export interface LeagueApiIdentity { coach: string; admin: boolean }

/** One identity row the coach lookup and the admin list read (identities.json, read-only here). */
export interface LeagueIdentityRow { coach: string; level: string; banned?: boolean }

export interface LeagueApiDeps {
  store: LeagueStore;
  /** Fork identities (coach-name lookup for organisers; level "admin" rows are the site admins). */
  identities?: () => LeagueIdentityRow[];
  /** What the viewer sees of a member for this league (sharedContactFor, src/auth/contactFor.ts): the coach name plus only
   *  the fields the coach granted; undefined = the viewer does not organise it, or the coach has not joined. */
  memberContact?: (viewer: { coach: string; admin?: boolean }, coach: string, leagueId: string) => { coach: string } | undefined;
  /** Stores one notification (fire-and-forget; src/notifications.ts NotificationStore.add). */
  notify?: (coach: string, input: NotificationInput) => void;
  /** Rest & Relaxation die for "Roll for me" (tests stub it; default crypto d6). */
  rollD6?: () => number;
  /** Discord webhook poster (tests stub it; default POSTs with fetch). */
  postWebhook?: WebhookPoster;
  /** Play on Super FUMBBL: the fork (forkClient.ts on the server, a stub in tests); unset = not connected (503 on fork actions). */
  fork?: LeagueForkClient;
  /** The request's If-Match header (settings PATCH revision, as an alternative to body.revision). */
  ifMatch?: string;
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
  /** A generated attachment (export.zip). */
  download?: { bytes: Buffer; contentType: string; filename: string };
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
    ...(s.status === "completed" && s.podium ? { finishedHere: true } : {}),
  };
}

export function leagueSummary(league: LeagueRecord, seasons: SeasonRecord[]): LeagueSummary {
  const logo = artUrl(league, "logo");
  const banner = artUrl(league, "banner");
  const newest = [...seasons].sort((a, b) => b.number - a.number)[0];
  // Picked, not spread: settings (address, registrations, Discord events, revision) stay in the organiser read model.
  return {
    id: league.id, name: league.name, fullName: league.fullName, slug: league.slug, description: league.description,
    organisers: [...new Set([...(league.owner ? [league.owner] : []), ...league.organisers])],
    playOnFork: league.playOnFork === true,
    createdAt: league.createdAt,
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
/** Account deletion rewrote league files: drop the derived statistics. */
export function clearLeagueStatsCache(): void { statsCache.clear(); clearStandingsCache(); }

function statsFor(store: LeagueStore, leagueId: string, scope: StatsScope): LeagueStats {
  const seasons = store.seasons(leagueId);
  const key = seasons.map((s) => `${s.id}@${s.importedAt}#${s.revision ?? 0}`).join("|");
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
    if (query.get("redraft") === "mine") {
      // The signed-in coach's open redraft tasks (team management page panel).
      if (!auth) return { status: 401, headers: { "cache-control": "no-store" }, body: { error: "Sign in to see your redraft tasks." } };
      return { status: 200, headers: { "cache-control": "no-store" }, body: { tasks: myRedraftTasks(store, auth.coach) } };
    }
    return { status: 200, body: { leagues: store.list().map((l) => leagueSummary(l, store.seasons(l.id))) } };
  }
  const league = store.league(route.id);
  const [first, second, ...extra] = route.rest;

  if (first === "logo" || first === "banner") {
    if (second !== undefined) return { status: 404, body: { error: "Not found." } };
    return artRoute(method, first, route.id, league, auth, deps);
  }
  if (first === "members") return memberContactRoute(method, league, second, extra, auth, deps);
  const fork = await leagueForkRoutes(method, route.id, route.rest, auth, deps);
  if (fork) return fork;
  const redraft = await redraftRoutes(method, route.rest, league, auth, deps, query);
  if (redraft) return redraft;
  const events = await leagueEventRoutes(method, route.rest, league, auth, deps);
  if (events) return events;
  const participants = await leagueParticipantRoutes(method, route.rest, league, auth, deps);
  if (participants) return participants;
  const managed = await settingsRoutes(method, route.rest, query, league, auth, deps);
  if (managed) return managed;
  if (!read) return { status: 405, body: { error: "Use GET." } };
  if (!league) return { status: 404, body: { error: "League not found." } };
  if (first === undefined) {
    const seasons = store.seasons(league.id);
    return { status: 200, body: { league: leagueSummary(league, seasons), seasons: seasons.map(seasonSummary) } };
  }
  if (first === "seasons" && second && extra.length === 0) {
    const season = store.season(league.id, second);
    if (!season) return { status: 404, body: { error: "Season not found." } };
    return { status: 200, body: { league: leagueSummary(league, store.seasons(league.id)), season: seasonForViewer(league, season, auth) } };
  }
  if (first === "stats" && second === undefined) {
    const raw = query.get("scope") ?? "all";
    if (!isStatsScope(raw)) return { status: 400, body: { error: "scope must be bb2020, bb2025 or all." } };
    return { status: 200, body: statsFor(store, league.id, raw) };
  }
  return { status: 404, body: { error: "Not found." } };
}

/**
 * GET /api/leagues/<id>/members/<coach>/contact (owner 10-31): a league organiser (or site admin) reads what one member
 * shares with this league: the coach name, plus preferred name / email / phones only when the coach granted them. A coach
 * who has not joined (acknowledged) the league answers 404. Never Discord ids.
 */
function memberContactRoute(
  method: string,
  league: LeagueRecord | undefined,
  coach: string | undefined,
  extra: string[],
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): LeagueApiResult {
  const noStore = { "cache-control": "private, no-store" };
  if (!coach || extra.length !== 1 || extra[0] !== "contact") return { status: 404, headers: noStore, body: { error: "Not found." } };
  if (method !== "GET") return { status: 405, headers: noStore, body: { error: "Use GET." } };
  if (!auth) return { status: 401, headers: noStore, body: { error: "Sign in to see member details." } };
  if (!league) return { status: 404, headers: noStore, body: { error: "League not found." } };
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach)) return { status: 403, headers: noStore, body: { error: "You are not an organiser of this league." } };
  const contact = deps.memberContact?.(auth, coach, league.id);
  if (!contact) return { status: 404, headers: noStore, body: { error: "That coach has not joined this league." } };
  return { status: 200, headers: noStore, body: { contact } };
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

// ---- League settings ----------------------------------------------------------------------------------------------

export const SETTINGS_MAX_BYTES = 256 * 1024;

const SETTINGS_ROUTES = new Set(["settings", "coaches", "export.zip", "discord"]);

function isSettingsRoute(method: string, rest: string[]): boolean {
  const [first, second, third, fourth, ...more] = rest;
  if (first && SETTINGS_ROUTES.has(first)) return true;
  if (first !== "seasons" || more.length) return false;
  if (second === undefined) return method !== "GET" && method !== "HEAD";
  return ((third === "finish" || third === "podium" || third === "reopen") && fourth === undefined) || (third === "fixtures" && fourth !== undefined)
    || ((third === "teams" || third === "phases") && fourth !== undefined && method !== "GET" && method !== "HEAD");
}

/** Anonymous 401, unknown league 404, neither organiser nor admin 403. */
function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return { status: 401, body: { error: "Sign in to manage this league." } };
  if (!league) return { status: 404, body: { error: "League not found." } };
  if (!auth.admin && !isLeagueOrganiser(league, auth.coach))
    return { status: 403, body: { error: "This league is not one of yours: only its organisers and site admins can change its settings." } };
  return undefined;
}

async function jsonBody(deps: LeagueApiDeps): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; result: LeagueApiResult }> {
  const r = await readJsonObject(deps, SETTINGS_MAX_BYTES);
  if (r.ok) return r;
  return { ok: false, result: { status: r.status, ...(r.close ? { close: true } : {}), body: { error: r.error } } };
}

const sameCoach = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

function siteAdmins(deps: LeagueApiDeps): string[] {
  try { return (deps.identities?.() ?? []).filter((r) => r.level === "admin" && !r.banned).map((r) => r.coach); } catch { return []; }
}

/** The identity's own spelling of a coach name; without an identities source the trimmed name is taken as given. */
function lookupCoach(deps: LeagueApiDeps, name: string): string | undefined {
  const want = name.trim();
  if (!want) return undefined;
  if (!deps.identities) return want;
  return deps.identities().find((r) => !r.banned && sameCoach(r.coach, want))?.coach;
}

function settingsError(e: unknown): LeagueApiResult | undefined {
  if (e instanceof SettingsError) return { status: e.status, body: { error: e.message, ...(e.field ? { field: e.field } : {}) } };
  if (e instanceof LeagueStoreError) return { status: e.status, body: { error: e.message } };
  return undefined;
}

async function settingsRoutes(
  method: string,
  rest: string[],
  query: URLSearchParams,
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  if (!isSettingsRoute(method, rest)) return undefined;
  const result = await settingsRoute(method, rest, query, league, auth, deps);
  // Organiser data: never cached by the browser or a proxy.
  return { ...result, headers: { "cache-control": "no-store", ...(result.headers ?? {}) } };
}

async function settingsRoute(
  method: string,
  rest: string[],
  query: URLSearchParams,
  league: LeagueRecord | undefined,
  auth: LeagueApiIdentity | undefined,
  deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  const early = gate(league, auth);
  if (early) return early;
  const who = auth!;
  const [first, second, third, fourth] = rest;
  // Writes read their body FIRST, then re-load the league and re-check the gate: a request that was slow to send
  // its body is judged against the league as it is now (e.g. its sender may have been removed as an organiser in
  // between). Everything after this point up to the store writes is synchronous, so nothing can interleave.
  let input: Record<string, unknown> = {};
  if (method !== "GET" && method !== "HEAD") {
    const body = await jsonBody(deps);
    if (!body.ok) return body.result;
    input = body.value;
  }
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? { status: 404, body: { error: "League not found." } };
  try {
    if (first === "settings" && second === undefined) {
      if (method === "GET" || method === "HEAD")
        return { status: 200, headers: { etag: `"${lg.revision ?? 0}"` }, body: { settings: view(lg, who, deps, query.get("season") ?? undefined) } };
      if (method !== "PATCH") return { status: 405, body: { error: "Use GET or PATCH." } };
      return patchSettings(lg, who, input, deps);
    }
    if (first === "coaches" && second === undefined) {
      if (method !== "GET") return { status: 405, body: { error: "Use GET." } };
      const q = (query.get("q") ?? "").trim().toLowerCase();
      const rows = q.length < 2 ? [] : (deps.identities?.() ?? [])
        .filter((r) => !r.banned && r.coach.toLowerCase().includes(q)).map((r) => r.coach).sort((a, b) => a.localeCompare(b)).slice(0, 10);
      return { status: 200, body: { coaches: rows } };
    }
    if (first === "export.zip" && second === undefined) {
      if (method !== "GET") return { status: 405, body: { error: "Use GET." } };
      const only = query.get("season");
      const seasons = deps.store.seasons(lg.id).filter((s) => !only || s.id === only).map(withStandings);
      if (only && !seasons.length) return { status: 404, body: { error: "Season not found." } };
      const bytes = zipFiles(leagueCsvFiles(lg, seasons), deps.now?.() ?? new Date());
      return { status: 200, download: { bytes, contentType: "application/zip", filename: `${lg.slug || lg.id}-results${only ? `-${only}` : ""}.zip` } };
    }
    if (first === "discord" && second === "test" && third === undefined) {
      if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
      const url = deps.store.secrets(lg.id).discordWebhookUrl;
      if (!url) return { status: 409, body: { error: "Set a Discord webhook URL first." } };
      const wait = avatarRateLimit(`league-discord:${who.coach.trim().toLowerCase()}`);
      if (wait > 0) return { status: 429, headers: { "retry-after": String(wait) }, body: { error: "Too many test posts. Try again in a minute." } };
      const res = await (deps.postWebhook ?? defaultPoster)(url, buildTestPost(lg, who.coach));
      if (res.ok) return { status: 200, body: { ok: true } };
      return { status: 502, body: { error: res.status ? `Discord did not accept the test post (status ${res.status}).` : "Could not reach Discord." } };
    }
    if (first === "seasons") {
      if (second === undefined) {
        if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
        return await createSeason(lg, who, input, deps);
      }
      if (third === "podium") {
        if (method !== "GET") return { status: 405, body: { error: "Use GET." } };
        const s = deps.store.season(lg.id, second);
        if (!s) return { status: 404, body: { error: "Season not found." } };
        return { status: 200, body: { proposal: proposePodium(s), status: s.status } };
      }
      if (third === "finish") {
        if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
        return await finishSeason(lg, second, who, input, deps);
      }
      if (third === "reopen") {
        if (method !== "POST") return { status: 405, body: { error: "Use POST." } };
        return reopenSeason(lg, second, deps);
      }
      if (third === "phases" && fourth) {
        if (method !== "PATCH") return { status: 405, body: { error: "Use PATCH." } };
        return setPhaseFormat(lg, second, fourth, who, input, deps);
      }
      if (third === "teams" && fourth) {
        if (method !== "PATCH") return { status: 405, body: { error: "Use PATCH." } };
        return await assignTeamCoach(lg, second, fourth, who, input, deps, (name) => lookupCoach(deps, name));
      }
      if (third === "fixtures" && fourth) {
        if (method !== "PATCH") return { status: 405, body: { error: "Use PATCH." } };
        // Super FUMBBL fields go to patchFixture; date / round / result go to the fixtures editor (events.ts).
        const forkFields = input.forkEnabled !== undefined || input.forkAllowLate !== undefined || input.forkCancelled !== undefined;
        if (!forkFields) return await editFixture(lg, second, fourth, who, input, deps);
        return await patchFixture(lg, second, fourth, who, input, deps);
      }
    }
  } catch (e) {
    const known = settingsError(e);
    if (known) return known;
    return { status: 500, body: { error: "Could not save the league settings right now." } };
  }
  return { status: 404, body: { error: "Not found." } };
}

function view(league: LeagueRecord, who: LeagueApiIdentity, deps: LeagueApiDeps, seasonId?: string) {
  return settingsView(league, deps.store.secrets(league.id), deps.store.seasons(league.id), who, siteAdmins(deps), seasonId);
}

export { requestRevision };

/**
 * Synchronous from validation to the last write (the caller re-loaded `league` after the body arrived), so the
 * revision check, the permission checks and the writes all see one state.
 */
function patchSettings(league: LeagueRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const current = league.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return { status: 428, body: { error: "Send the settings revision you loaded (revision or If-Match).", revision: current } };
  if (asked === "bad") return { status: 400, body: { error: "revision must be a whole number.", field: "revision" } };
  if (asked !== current)
    return { status: 409, body: { error: "These settings changed since you opened them. Reload to see the latest.", revision: current } };
  const now = deps.now?.() ?? new Date();

  // Everything is validated before anything is written.
  const owner = leagueOwner(league);
  const isOwner = Boolean(owner) && sameCoach(owner, who.coach);
  let organisers = [...league.organisers];
  let nextOwner: string | undefined;
  // Membership is written only when the request carries an authorised add / remove / owner change.
  let membershipChanged = false;
  if (input.administration !== undefined) {
    const a = input.administration;
    if (!a || typeof a !== "object" || Array.isArray(a)) throw new SettingsError(400, "administration must be an object.");
    const { addOrganiser, removeOrganiser, owner: wantOwner } = a as Record<string, unknown>;
    if ((addOrganiser !== undefined || removeOrganiser !== undefined) && !who.admin && !isOwner)
      return { status: 403, body: { error: "Only the league owner or a site admin can change the organisers." } };
    if (wantOwner !== undefined && !who.admin) return { status: 403, body: { error: "Only a site admin can change the league owner." } };
    membershipChanged = addOrganiser !== undefined || removeOrganiser !== undefined || wantOwner !== undefined;
    if (addOrganiser !== undefined) {
      if (typeof addOrganiser !== "string" || !addOrganiser.trim()) throw new SettingsError(400, "Enter a coach name.", "addOrganiser");
      const coach = lookupCoach(deps, addOrganiser);
      if (!coach) throw new SettingsError(400, `No coach called "${addOrganiser.trim().slice(0, 40)}".`, "addOrganiser");
      if (sameCoach(coach, owner) || organisers.some((o) => sameCoach(o, coach))) throw new SettingsError(400, `${coach} is already an organiser.`, "addOrganiser");
      organisers.push(coach);
    }
    if (removeOrganiser !== undefined) {
      if (typeof removeOrganiser !== "string") throw new SettingsError(400, "Enter a coach name.", "removeOrganiser");
      if (owner && sameCoach(removeOrganiser, owner)) throw new SettingsError(400, "The owner cannot be removed. Change the owner first.", "removeOrganiser");
      if (!organisers.some((o) => sameCoach(o, removeOrganiser))) throw new SettingsError(400, `${removeOrganiser.trim().slice(0, 40)} is not an organiser.`, "removeOrganiser");
      organisers = organisers.filter((o) => !sameCoach(o, removeOrganiser));
    }
    if (wantOwner !== undefined) {
      if (typeof wantOwner !== "string" || !wantOwner.trim()) throw new SettingsError(400, "Enter a coach name.", "owner");
      const found = lookupCoach(deps, wantOwner);
      if (!found) throw new SettingsError(400, `No coach called "${wantOwner.trim().slice(0, 40)}".`, "owner");
      nextOwner = found;
      // The previous owner stays on as an organiser.
      if (owner && !organisers.some((o) => sameCoach(o, owner))) organisers.unshift(owner);
      organisers = organisers.filter((o) => !sameCoach(o, found));
    }
  }
  const info = input.information !== undefined ? parseInformation(input.information) : undefined;
  const registrations = input.registrations !== undefined ? parseRegistrations(input.registrations, registrationsOf(league)) : undefined;
  const connections = input.connections !== undefined ? parseConnections(input.connections, discordEvents(league)) : undefined;
  const team = input.teamBuilding !== undefined ? parseTeamBuilding(input.teamBuilding) : undefined;
  const season = team ? deps.store.season(league.id, team.seasonId) : undefined;
  if (team && !season) return { status: 404, body: { error: "Season not found.", field: "seasonId" } };

  if (season && team) {
    season.rules = {
      ...(season.rules ?? {}),
      teamBuilding: { rosters: team.rosters, eliteSkills: teamBuildingTable(season).eliteSkills, updatedAt: now.toISOString(), updatedBy: who.coach },
    };
    deps.store.putSeason(season);
  }
  if (connections?.discordUrl !== undefined) {
    const secrets = deps.store.secrets(league.id);
    if (connections.discordUrl === null) delete secrets.discordWebhookUrl; else secrets.discordWebhookUrl = connections.discordUrl;
    deps.store.setSecrets(league.id, secrets);
  }
  const updated = deps.store.updateLeague(league.id, (l) => {
    if (membershipChanged) {
      l.organisers = organisers;
      if (nextOwner) l.owner = nextOwner;
      else if (!l.owner && owner) l.owner = owner;
    }
    if (info) {
      if (info.name !== undefined) l.name = info.name;
      if (info.fullName !== undefined) l.fullName = info.fullName;
      if (info.description !== undefined) l.description = info.description;
      if (info.ruleset !== undefined) l.ruleset = info.ruleset;
      if (info.mode !== undefined) l.mode = info.mode;
      if (info.address !== undefined) { if (info.address === null) delete l.address; else l.address = info.address; }
    }
    if (registrations) l.registrations = registrations;
    if (connections?.playOnFork !== undefined) l.playOnFork = connections.playOnFork;
    if (connections?.discordEvents) l.discordEvents = connections.discordEvents;
    l.revision = current + 1;
  }, now);
  return { status: 200, body: { ok: true, settings: view(updated, who, deps, team?.seasonId) } };
}

/** Discord post for a season milestone the league enabled. Best effort; the URL is never logged. */
async function postMilestone(league: LeagueRecord, deps: LeagueApiDeps, payload: DiscordPayload): Promise<void> {
  const url = deps.store.secrets(league.id).discordWebhookUrl;
  if (!url || !discordEvents(league).milestones) return;
  try { await (deps.postWebhook ?? defaultPoster)(url, payload); } catch { /* best effort */ }
}

async function createSeason(league: LeagueRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const seasons = deps.store.seasons(league.id);
  // Seasons may overlap (owner 10-30): a season in progress does not block the next one; the newest is current.
  const newest = seasons[0];
  const number = (newest?.number ?? 0) + 1;
  let name = `Season ${number}`;
  if (input.name !== undefined && input.name !== "") {
    if (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > 60) throw new SettingsError(400, "Season name must be 1 to 60 characters.", "name");
    name = input.name.trim();
  }
  let ruleset: LeagueRuleset = league.ruleset ?? newest?.ruleset ?? "BB2025";
  if (input.ruleset !== undefined) {
    if (!LEAGUE_RULESETS.includes(input.ruleset as LeagueRuleset)) throw new SettingsError(400, "Ruleset must be BB2020 or BB2025.", "ruleset");
    ruleset = input.ruleset as LeagueRuleset;
  }
  let id = `season-${number}`;
  for (let i = 2; seasons.some((s) => s.id === id || s.sourceSlug === id); i++) id = `season-${number}-${i}`;
  if (!SEASON_ID.test(id)) throw new SettingsError(400, "Bad season id.");
  const at = (deps.now?.() ?? new Date()).toISOString();
  const copied = newest?.rules?.teamBuilding;
  const season: SeasonRecord = {
    id, leagueId: league.id, number, name, sourceSlug: id, ruleset, status: "active", startedAt: at,
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [],
    importedAt: at, source: "manual",
    // Team building rules carry over from the previous season (the organiser edits them on the Team building tab).
    ...(copied ? { rules: { teamBuilding: { ...structuredClone(copied), updatedAt: at, updatedBy: who.coach } } } : {}),
  };
  // Draft lists submitted in a redraft before this season existed become its teams.
  const redrafted = applyPendingDrafts(seasons, season);
  deps.store.putSeason(season);
  for (const s of redrafted) deps.store.putSeason(s);
  await postMilestone(league, deps, buildMilestonePost(league, "season-started", name, ruleset));
  return { status: 201, body: { ok: true, season: seasonSummary(season) } };
}

/**
 * The organiser's podium override: { champion?, runnerUp?, consolation? }, each a candidate's team ref or null (empty).
 * A slot left out keeps the proposal. Throws SettingsError.
 */
export function parsePodiumOverride(input: unknown, candidates: PodiumPlace[]): Partial<Record<PodiumSlot, string | null>> {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new SettingsError(400, "podium must be an object.", "podium");
  const raw = input as Record<string, unknown>;
  const out: Partial<Record<PodiumSlot, string | null>> = {};
  for (const slot of PODIUM_SLOTS) {
    const v = raw[slot];
    if (v === undefined) continue;
    if (v === null || v === "") { out[slot] = null; continue; }
    if (typeof v !== "string" || !candidates.some((c) => c.ref === v)) throw new SettingsError(400, "Pick a team of this season.", slot);
    out[slot] = v;
  }
  return out;
}

async function finishSeason(league: LeagueRecord, seasonId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  if (season.status === "completed") return { status: 409, body: { error: `${season.name} is already finished.` } };
  const at = (deps.now?.() ?? new Date()).toISOString();
  const proposal = proposePodium(season);
  if (proposal.decidedBy === "imported") {
    // The imported awards stand untouched; the record lets the season be reopened like any other.
    if (input.podium !== undefined) return { status: 409, body: { error: "This season's podium came with the TourPlay import and cannot be changed here.", field: "podium" } };
    const refs: Partial<Record<PodiumSlot, string>> = {};
    for (const slot of PODIUM_SLOTS) if (proposal[slot]) refs[slot] = proposal[slot]!.ref;
    season.podium = { decidedBy: "imported", proposed: refs, final: { ...refs }, overridden: false, by: who.coach, at };
  } else {
    const override = parsePodiumOverride(input.podium, proposal.candidates);
    const byRef = new Map(proposal.candidates.map((c) => [c.ref, c]));
    const proposed: Partial<Record<PodiumSlot, string>> = {};
    const places: Partial<Record<PodiumSlot, PodiumPlace>> = {};
    for (const slot of PODIUM_SLOTS) {
      const p = proposal[slot];
      if (p) proposed[slot] = p.ref;
      const ref = override[slot] === undefined ? p?.ref : override[slot];
      const place = ref ? byRef.get(ref) ?? (p?.ref === ref ? p : undefined) : undefined;
      if (place) places[slot] = place;
    }
    const refs = PODIUM_SLOTS.map((s) => places[s]?.ref).filter(Boolean);
    if (new Set(refs).size !== refs.length) throw new SettingsError(400, "A team can take only one podium place.", "podium");
    const final: Partial<Record<PodiumSlot, string>> = {};
    for (const slot of PODIUM_SLOTS) if (places[slot]) final[slot] = places[slot]!.ref;
    const overridden = PODIUM_SLOTS.some((slot) => (final[slot] ?? "") !== (proposed[slot] ?? ""));
    const decidedBy = overridden ? "organiser" : proposal.decidedBy === "pending" ? "none" : proposal.decidedBy;
    season.awards = [...season.awards.filter((a) => !a.podium), ...podiumAwards(places, decidedBy)];
    season.podium = { decidedBy, proposed, final, overridden, by: who.coach, at };
  }
  season.status = "completed";
  season.endedAt = at;
  deps.store.putSeason(season);
  await postMilestone(league, deps, buildMilestonePost(league, "season-finished", season.name));
  return { status: 200, body: { ok: true, season: seasonSummary(season) } };
}

/**
 * An organiser marks a phase Table or Knockout (the only way a phase becomes a knockout). `revision` (or If-Match) is the
 * season's revision as last read: 428 missing, 409 stale. The write bumps the revision, which invalidates the derived
 * standings (standings.ts withStandings keys on it). Answers the season as the organiser now sees it.
 */
function setPhaseFormat(league: LeagueRecord, seasonId: string, phaseId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  const phase = season.phases.find((p) => p.id === phaseId);
  if (!phase) return { status: 404, body: { error: "Phase not found." } };
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return { status: 428, body: { error: "Send the season revision you loaded (revision or If-Match).", revision: current } };
  if (asked === "bad") return { status: 400, body: { error: "revision must be a whole number.", field: "revision" } };
  if (asked !== current) return { status: 409, body: { error: "This season changed since you opened it. Reload to see the latest.", revision: current } };
  if (input.format !== "table" && input.format !== "knockout") throw new SettingsError(400, "format must be table or knockout.", "format");
  if (input.format === "knockout") phase.format = "knockout"; else delete phase.format;
  deps.store.putSeason(season);
  return { status: 200, body: { ok: true, season: seasonForViewer(league, season, who) } };
}

/** Reopen a season finished on this site (it has a podium record): back in progress, podium awards and record removed. */
function reopenSeason(league: LeagueRecord, seasonId: string, deps: LeagueApiDeps): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  if (season.status !== "completed") return { status: 409, body: { error: `${season.name} is still in progress.` } };
  if (!season.podium) return { status: 409, body: { error: "Only a season finished on this site can be reopened." } };
  season.status = "active";
  delete season.endedAt;
  delete season.podium;
  season.awards = season.awards.filter((a) => !a.podium);
  deps.store.putSeason(season);
  return { status: 200, body: { ok: true, season: seasonSummary(season) } };
}

const fixtureLink = (leagueId: string, seasonId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}&tab=fixtures`;

/**
 * Who hears that a fixture may be played on Super FUMBBL: each seated coach mapped to a fork identity (the actor
 * excluded, so when the actor plays in it only the opponent), then the league owner, organisers and site admins.
 */
export function forkFixtureNotices(league: LeagueRecord, seasonId: string, f: LeagueFixture, actor: string, admins: string[]): Array<{ coach: string; input: NotificationInput }> {
  const link = fixtureLink(league.id, seasonId);
  const match = `${f.home.team} vs ${f.away.team}`;
  const out: Array<{ coach: string; input: NotificationInput }> = [];
  const seen = new Set<string>([actor.trim().toLowerCase()]);
  const add = (coach: string | undefined, input: NotificationInput): void => {
    const key = coach?.trim().toLowerCase();
    if (!coach || !key || seen.has(key)) return;
    seen.add(key);
    out.push({ coach: coach.trim(), input });
  };
  for (const side of [f.home, f.away])
    add(side.coachId, { type: "league-broadcast", title: "Play on Super FUMBBL", body: `${actor} has invited you to play your match on Super FUMBBL (${league.name}: ${match}).`, link, from: actor });
  const notice: NotificationInput = { type: "league-broadcast", title: "Super FUMBBL allowed for a fixture", body: `${actor} allowed ${match} (${league.name}) to be played on Super FUMBBL.`, link, from: actor };
  for (const coach of [leagueOwner(league), ...league.organisers, ...admins]) add(coach, notice);
  return out;
}

export const FORK_TOGGLE_LIMIT = 10;
export const FORK_TOGGLE_WINDOW_MS = 10 * 60_000;
export const FORK_RENOTIFY_QUIET_MS = 24 * 60 * 60_000;
const forkToggles = new Map<string, number[]>();
/** Tests: forget the per-coach toggle counts. */
export function resetForkToggleLimit(): void { forkToggles.clear(); }

/** Seconds to wait when this coach used up FORK_TOGGLE_LIMIT fixture toggles in the window; 0 = go ahead (and count it). */
function forkToggleWait(coach: string, now: number): number {
  const key = coach.trim().toLowerCase();
  const recent = (forkToggles.get(key) ?? []).filter((t) => now - t < FORK_TOGGLE_WINDOW_MS);
  if (recent.length >= FORK_TOGGLE_LIMIT) {
    forkToggles.set(key, recent);
    return Math.max(1, Math.ceil((FORK_TOGGLE_WINDOW_MS - (now - recent[0]!)) / 1000));
  }
  recent.push(now);
  forkToggles.set(key, recent);
  return 0;
}

/**
 * Turning a fixture on notifies each recipient once per fixture (fixture.forkNotice remembers who was told), never
 * again within FORK_RENOTIFY_QUIET_MS of the last batch, and never for a played fixture; a coach may toggle at most
 * FORK_TOGGLE_LIMIT times in FORK_TOGGLE_WINDOW_MS.
 */
async function patchFixture(league: LeagueRecord, seasonId: string, fixtureId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): Promise<LeagueApiResult> {
  for (const key of ["forkEnabled", "forkAllowLate", "forkCancelled"] as const)
    if (input[key] !== undefined && typeof input[key] !== "boolean") throw new SettingsError(400, `${key} must be true or false.`, key);
  if (input.forkEnabled === undefined && input.forkAllowLate === undefined && input.forkCancelled === undefined)
    throw new SettingsError(400, "forkEnabled must be true or false.", "forkEnabled");
  // Late launch / cancel ("Allow late launch", "Cancel Super FUMBBL play"; default both off) go through forkPlay, which
  // may have to withdraw the fork game; Cancel is never combined with the Allow switch.
  if (input.forkEnabled === undefined) return updateForkSettings(deps, league.id, seasonId, fixtureId, who, input as { forkAllowLate?: boolean; forkCancelled?: boolean });
  if (input.forkCancelled !== undefined) throw new SettingsError(400, "Change forkCancelled on its own.", "forkCancelled");
  const on = input.forkEnabled as boolean;
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  const fixture = season.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return { status: 404, body: { error: "Fixture not found." } };
  if (on && league.playOnFork !== true) return { status: 409, body: { error: "Turn on Play on Super FUMBBL in League settings first." } };
  const now = deps.now?.() ?? new Date();
  const wait = forkToggleWait(who.coach, now.getTime());
  if (wait > 0) return { status: 429, headers: { "retry-after": String(wait) }, body: { error: "Too many Super FUMBBL changes. Try again in a few minutes." } };
  const was = fixture.forkEnabled === true;
  if (on) fixture.forkEnabled = true; else delete fixture.forkEnabled;
  let send: Array<{ coach: string; input: NotificationInput }> = [];
  const last = fixture.forkNotice;
  const quiet = last && now.getTime() - Date.parse(last.at) < FORK_RENOTIFY_QUIET_MS;
  if (on && !was && deps.notify && !fixturePlayed(fixture) && !quiet) {
    const told = new Set((last?.to ?? []).map((c) => c.trim().toLowerCase()));
    send = forkFixtureNotices(league, season.id, fixture, who.coach, siteAdmins(deps)).filter((n) => !told.has(n.coach.toLowerCase()));
    if (send.length) fixture.forkNotice = { at: now.toISOString(), to: [...(last?.to ?? []), ...send.map((n) => n.coach)] };
  }
  applyForkSettings(fixture, input as { forkAllowLate?: boolean }, who.coach, now);
  deps.store.putSeason(season);
  for (const n of send) {
    try { deps.notify!(n.coach, n.input); } catch { /* fire-and-forget */ }
  }
  return { status: 200, body: { ok: true, fixture: publicForkState(fixture), revision: season.revision } };
}

// ---- season read model ---------------------------------------------------------------------------------------------

/**
 * The season as this viewer may see it: rosters are always visible (owner 10-30); the internal fork-notice bookkeeping
 * and the redraft state never leave the server in a season read.
 */
export function seasonForViewer(league: LeagueRecord, full: SeasonRecord, auth: LeagueApiIdentity | undefined): SeasonRecord {
  // Redraft state (budgets, R&R, draft rosters) is served only by the authorised redraft routes, never in a season read.
  const { redraft: _r, ...season } = withStandings(full);
  const fixtures = season.fixtures.map((f) => (f.forkNotice || f.fork ? publicForkState(f) : f));
  // Organiser-only log entries (team value diff / not recomputed) stay with organisers and admins.
  const manager = Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach)));
  if (manager) return { ...season, fixtures };
  // Participants tab flags (paid, verified...) are organiser data (participants.ts).
  const participants = participantsForPublic(season.participants);
  if (!season.log) return { ...season, fixtures, participants };
  return { ...season, fixtures, participants, log: season.log.filter((e) => !ORGANISER_LOG_KINDS.has(e.kind)) };
}
