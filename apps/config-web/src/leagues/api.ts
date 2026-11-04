/**
 * League routes. Reads are public; artwork writes need a session and an organiser of the league (or an admin).
 *
 *   GET    /api/leagues                          list (summaries + browse: status, place, public search index)
 *   GET    /api/leagues/:id                      league + season summaries (newest first)
 *   GET    /api/leagues/:id/seasons/:seasonId    one full season
 *   GET    /api/leagues/:id/stats?scope=         aggregates: bb2020 | bb2025 | all (default all)
 *   GET    /api/leagues/:id/logo|banner          the image (public)
 *   PUT    /api/leagues/:id/logo|banner          raw image body (PNG / JPEG / WebP; logo 1 MB, banner 2 MB)
 *   DELETE /api/leagues/:id/logo|banner
 *
 * League settings (organisers of the league and site admins; anonymous 401, other coaches 403): see settingsRoutes.
 *   GET    /api/leagues/:id/settings[?season=]                    settings read model (webhook URL masked)
 *   PATCH  /api/leagues/:id/settings                              { revision, administration?, information?, registrations?, teamBuilding?, connections?, houseRules?, regions? }
 *   GET    /api/leagues/:id/coaches?q=                            coach-name lookup against the identities (add organiser)
 *   POST   /api/leagues/:id/seasons                               { name?, ruleset? } start the next season
 *   GET    /api/leagues/:id/seasons/:seasonId/podium              the podium Finish season proposes (standings.ts) + candidates
 *   POST   /api/leagues/:id/seasons/:seasonId/finish              { podium?: { champion?, runnerUp?, consolation? } (team refs) } status -> completed, crowns the podium
 *   POST   /api/leagues/:id/seasons/:seasonId/reopen              a season finished here goes back in progress; its podium is cleared
 *   PATCH  /api/leagues/:id/seasons/:seasonId/phases/:phaseId     { revision, format: "table" | "knockout" } mark a phase (standings / podium)
 *   PATCH  /api/leagues/:id/seasons/:seasonId/teams/:teamId       { revision, coachId, allSeasons? } assign a coach account (teamCoach.ts)
 *   POST   /api/leagues/:id/seasons/:seasonId/teams/:teamId/captain { revision, playerId } appoint a new Team Captain (captainApi.ts)
 *   PATCH  /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId { forkEnabled?, forkAllowLate?, forkCancelled? } Super FUMBBL per fixture
 *   GET|POST .../fixtures/:fixtureId/forfeit[/defections|/settings]  the forfeit dialog and its defection rolls (forfeit.ts)
 *   GET|POST /api/leagues/:id/seasons/:seasonId/participants, PATCH .../participants/:teamId  Participants tab flags: see participants.ts
 *                                                                 { date?, round?, result? } fixtures editor (events.ts)
 * News and the fixtures editor (create / delete): see events.ts.
 *
 * League Events (league nights, drafts, socials; calendar + Schedule page + Discord scheduled events): see leagueEvents.ts.
 *   GET|POST /api/leagues/:id/events, PATCH|DELETE .../events/:eventId, GET|PATCH .../events/discord, POST .../events/discord/cleanup (leagueEventsDiscord.ts), GET .../schedule
 *
 * League ladders (lane 8b; ranking, challenges, scheduled rounds, joining, the Ladder tab): see ladderApi.ts.
 *   GET|POST /api/leagues/:id/ladders, GET|PATCH .../ladders/:ladderId, POST .../start|close|challenges|rounds|registrations
 *   A ladder is read like a season by the fixture / team / recorder routes (.../seasons/<ladderId>/...); season-only routes
 *   (join, registrations, stage, finish, reopen, podium, participants, deadlines) answer 404 for a ladder id.
 *
 * TourPlay import upload (lane L8; organisers + admins, claims by any signed-in coach): see tourplayImport.ts.
 *   POST .../tourplay/preview|apply, GET .../tourplay, POST .../tourplay/coaches/:row/assign, GET .../tourplay/claimable,
 *   POST .../tourplay/claims, POST .../tourplay/claims/:claim/approve|decline|withdraw
 *
 * League registration (lane L6; join, the Registrations tab, accept -> team, "I've paid"): see registrationApi.ts.
 *   GET .../seasons/:seasonId/join, GET|POST .../seasons/:seasonId/registrations, POST .../registrations/:rid/<verb>
 *   POST   /api/leagues/:id/discord/test                          send a small test embed to the webhook
 *   GET    /api/leagues/:id/export.zip[?season=]                  CSV zip (teams, fixtures, standings, participants, honours, awards)
 *
 * Play on Super FUMBBL (fixture summary, generate, launch file, reset, result sync): see forkPlay.ts.
 *   GET /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId, POST .../fork/generate|launch|reset|sync, GET .../fork/jnlp
 *
 * Redraft (board for organisers, Team Draft List for the team's coach): see redraftApi.ts.
 *   GET|POST /api/leagues/:id/redraft, GET /api/leagues/:id/redraft/teams/:teamId, POST .../rest, POST .../submit,
 *   GET /api/leagues?redraft=mine, GET /api/leagues/:id/seasons/:seasonId/teams/:teamId/redraft-budget (team summary)
 *
 * Fixture lobby (public read; the two coaches + organisers write): see src/fixtureLobby/league.ts.
 *   GET .../seasons/:seasonId/fixtures/:fixtureId/lobby, POST .../lobby/presence|chat|roster|ready|inducements|start
 *
 * Inducement table per season (public read; organisers + admins write): see inducements.ts.
 *   GET|PUT /api/leagues/:id/seasons/:seasonId/inducements
 *   GET /api/leagues/:id/seasons/:seasonId/inducements/usage[?scope=league]  (public: inducements taken)
 *
 * Awards and the Hall of Fame (public read; organisers + admins write): see awards.ts.
 *   GET /api/leagues/:id/honours, POST /api/leagues/:id/awards, DELETE /api/leagues/:id/awards/:awardId,
 *   POST /api/leagues/:id/hall-of-fame/pins, DELETE .../pins/:pinId, PUT /api/leagues/:id/hall-of-fame/order,
 *   GET /api/leagues?awards=mine
 *
 * Image guards reuse the team-avatar helpers (magic-byte sniff with header-parsed dimensions, the per-coach rate
 * limit) as the tournament banner does; files are stored under the league's own directory with a hashed name.
 */
import { houseRulesOf, type HouseRules } from "../competition/houseRules.js";
import { createHash, randomBytes } from "node:crypto";
import { leagueHonoursRoutes, myAwards } from "./awards.js";
import { leagueInducementRoutes } from "./inducements.js";
import { leagueBuilderRoute } from "./leagueBuilder.js";
import { leagueCaptainRoutes, withCaptainCandidates } from "./captainApi.js";
import { leagueLobbyRoutes, type LeagueLobbyDeps } from "../fixtureLobby/league.js";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { AVATAR_CONTENT_TYPE, avatarRateLimit, sniffImage, type AvatarExt, type SniffedImage } from "../teamAvatars.js";
import type { NotificationInput } from "../notifications.js";
import { buildMilestonePost, buildTestPost, discordEvents, postWebhook as defaultPoster, type DiscordPayload, type WebhookPoster } from "./discord.js";
import { buildNewsPost, editFixture, leagueEventRoutes, postLeagueEvent, seasonCoaches } from "./events.js";
import { ChangeMessageError, CONFIRM_AFTER_START_LEAGUE, parseChangeMessage, rulesChangeBody, rulesChangeDiff, rulesChangeNews, rulesNotices, type RulesChangeCoalescer, type RulesState } from "../competition/rulesChange.js";
import { leagueForfeitRoutes } from "./forfeit.js";
import { populateSeasonDiscord } from "../discord/api.js";
import { cleanPayload } from "../discord/clean.js";
import { leagueCsvFiles, zipFiles } from "./exportZip.js";
import { readJsonObject, requestRevision } from "./http.js";
import { applyForkSettings, leagueForkRoutes, publicForkState, updateForkSettings, type LeagueForkClient } from "./forkPlay.js";
import { applyPendingDrafts } from "./redraft.js";
import { copyLastSeason, seasonFromTemplate, type NewSeasonSettings } from "../templates/season.js";
import { TemplateError, type SeasonTemplateContent } from "../competition/templates.js";
import { assignTeamCoach } from "./teamCoach.js";
import { publicTeam, settleServedMng } from "./teamOps.js";
import { teamPageRoutes } from "./teamPage.js";
import { teamLibraryRoutes, type TeamLibraryApiDeps } from "./teamLibraryApi.js";
import { myRedraftTasks, redraftRoutes, teamRedraftBudgetRoute } from "./redraftApi.js";
import { RedraftRulesError, parseRedraftRules } from "./redraftRules.js";
import { MONEY_LOG_KEEP, MoneyRulesError, effectiveMoneyRules, moneyRulesDiff, parseMoneyRules, publicMoneyRules, type MoneyRules, type MoneyRulesLogEntry } from "./moneyRules.js";
import { notifyRecordChange } from "./recordChange.js";
import { leagueParticipantRoutes, myPaymentStatus, participantsForPublic } from "./participants.js";
import { leagueRegistrationRoutes, type LeagueRegistrationApiDeps } from "./registrationApi.js";
import {
  parseConnections, parseInformation, parseLeagueHouseRules, parseLeagueRegions, parseRegistrations, parseTeamBuilding, registrationsOf, settingsView, SettingsError, teamBuildingTable,
} from "./settings.js";
import { leagueStats, isStatsScope, type LeagueStats, type StatsScope } from "./stats.js";
import { clearStandingsCache, podiumAwards, PODIUM_SLOTS, proposePodium, withStandings, type PodiumPlace } from "./standings.js";
import { fixturePlayed } from "./tourplay.js";
import { ORGANISER_LOG_KINDS } from "./teamValue.js";
import { leagueBrowseInfo, type LeagueBrowseInfo } from "./browse.js";
import { draftAwareNotify, isDraftLeague, leagueVisibleTo, seasonStage, storeWithoutLeague, visibleLeagues, type SeasonStage } from "./lifecycle.js";
import { defaultSeasonRegistration, seasonRegistrationOf } from "./seasonRegistration.js";
import { paymentLinksView } from "../payments/links.js";
import { createLeagueRoute, leagueLifecycleRoutes } from "./wizard.js";
import { tourplayImportRoutes } from "./tourplayImport.js";
import { leagueCalendarEventRoutes, type LeagueEventsDeps } from "./leagueEvents.js";
import { leagueGateRoutes } from "./gates.js";
import { leagueEventsDiscordRoutes } from "./leagueEventsDiscord.js";
import { leagueChampionsRoute, leagueLadderRoutes } from "./ladderApi.js";
import { competitionPlaysOnFork, isLadder, isLadderId, ladderVisible } from "./ladder.js";
import { TEST_SESSION_REFUSAL, testSessionMayWrite } from "../registration/testSession.js";
import { leagueTimeZone } from "./timeZone.js";
import { isLeagueOrganiser, LEAGUE_ART_DIR, LEAGUE_ART_PATH, leagueOwner, LeagueStore, LeagueStoreError, SEASON_ID } from "./store.js";
import { LEAGUE_RULESETS, type LeagueFixture, type LeagueNewsPost, type LeagueRecord, type LeagueTeam, type LeagueRuleset, type PodiumSlot, type SeasonRecord, type SeasonStatus } from "./types.js";

export const LOGO_MAX_BYTES = 1024 * 1024;
/** Season routes a ladder id never answers (ladders join, start and close through ladderApi.ts). */
const LADDER_BLOCKED_SEASON_ROUTES: ReadonlySet<string> = new Set(["join", "registrations", "registration", "stage", "finish", "reopen", "podium", "participants", "deadlines", "phases"]);
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
  /** Lane L5: "draft" only for a draft (seen by its organisers and admins); absent = published. */
  visibility?: "draft";
  /** Creation wizards v2: the league's house rules (defaults derived on read), the ruleset card, and the authorised flag. */
  houseRules: HouseRules;
  rulesetPackage?: string;
  authorised: boolean;
  /** The league's IANA time zone (UTC when unset): the Calendar tab reads every day and time in it. */
  timeZone: string;
  /** The money rules (moneyRules.ts) for the ruleset card: the league's, and each competition that overrides them. */
  money: ReturnType<typeof publicMoneyRules>;
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
  /** Lane L5: setup | registration | active | completed (lifecycle.ts seasonStage). */
  stage: SeasonStage;
}

export interface LeagueApiIdentity {
  coach: string;
  admin: boolean;
  /** Site organiser level (creates leagues, Q1). */
  organizer?: boolean;
  /** A test sign-in session (Q13): writes only in test leagues; a league it creates is a test league. */
  test?: boolean;
}

/** One identity row the coach lookup and the admin list read (identities.json, read-only here). */
export interface LeagueIdentityRow { coach: string; level: string; banned?: boolean }

export interface LeagueApiDeps extends LeagueRegistrationApiDeps, TeamLibraryApiDeps {
  store: LeagueStore;
  /** Fork identities (coach-name lookup for organisers; level "admin" rows are the site admins). */
  identities?: () => LeagueIdentityRow[];
  /** Lane L8 TourPlay import: site coaches with their display name and profile NAF details (identities.json, read-only),
   *  for matching and likely-match suggestions. Unset = nothing matches. */
  coachProfiles?: () => import("./tourplayImport.js").TourplayProfile[];
  /** What the viewer sees of a member for this league (sharedContactFor, src/auth/contactFor.ts): the coach name plus only
   *  the fields the coach granted; undefined = the viewer does not organise it, or the coach has not joined. */
  memberContact?: (viewer: { coach: string; admin?: boolean }, coach: string, leagueId: string) => { coach: string } | undefined;
  /** Stores one notification (fire-and-forget; src/notifications.ts NotificationStore.add). */
  notify?: (coach: string, input: NotificationInput) => void;
  /** Rules-change notice coalescing (creation wizards v2). Absent = the process-wide one. */
  rulesNotices?: RulesChangeCoalescer;
  /** Team page v2: coalescing of the coach's "An organiser updated your team" note and the record-change note (teamPage.ts).
   *  Absent = the process-wide one. */
  teamNotices?: RulesChangeCoalescer;
  /** Rest & Relaxation die for "Roll for me" (tests stub it; default the site roller's d6). */
  rollD6?: () => number;
  /** The site roller (src/dice/roller.ts) for forfeit defection rolls; default cryptoRoller (tests inject). */
  roller?: import("../dice/roller.js").Roller;
  /** The dice log (src/dice/log.ts): defection rolls are written here before they are shown. */
  diceLog?: import("../dice/log.js").DiceLogStore;
  /** GAME_PAGES_PUBLIC_PLAYER_LINES for the forfeit webhook report (default: the Discord setting). */
  publicNames?: () => boolean;
  /** Discord webhook poster (tests stub it; default POSTs with fetch). */
  postWebhook?: WebhookPoster;
  /** The Discord observer's ledger (gates.ts: a registration gate's post marks the observer's own marker, so it posts once). */
  discordLedger?: { mark(key: string, markers: readonly string[], at: string): string[] };
  /** Play on Super FUMBBL: the fork (forkClient.ts on the server, a stub in tests); unset = not connected (503 on fork actions). */
  fork?: LeagueForkClient;
  /** The request's If-Match header (settings PATCH revision, as an alternative to body.revision). */
  ifMatch?: string;
  /** Raw body reader (artwork PUT): undefined = larger than max (the caller closes the connection). */
  readBody?(max: number): Promise<Buffer | undefined>;
  declaredTooLarge?(max: number): boolean;
  now?: () => Date;
  /** Does the public game page (GET /api/games/online/<id>) serve this fork game yet? A season read carries a finished
   *  fixture's game id only then (the Calendar links it). Unset = never. */
  gamePage?: (gameId: string) => boolean;
  /** Fixture lobby (src/fixtureLobby): store, presence, chat limiter, the recorder's createMatch; unset = 503 on lobby routes. */
  lobby?: LeagueLobbyDeps;
  /** The tabletop recorder's matches, read only (inducement usage, inducementUsage.ts); unset = no recorder data. */
  tabletop?: import("./inducementUsage.js").InducementUsageSource;
  /** A saved ruleset package exists (the ruleset card the wizard / settings pick); unset = names are only syntax-checked. */
  packageExists?: (name: string) => boolean;
  /** League Events (leagueEvents.ts): the Discord bot client for scheduled events (unset = no bot) and the sync kick. */
  leagueEvents?: LeagueEventsDeps;
  /** Competition templates (src/templates): a season template the caller may use for Start a new season "From template"
   *  (owner or shared organiser; payment links only for the owner). Throws TemplateError. Unset = templates off (503). */
  seasonTemplate?: (id: unknown, coach: string) => { content: SeasonTemplateContent; mine: boolean; name: string };
}

/** Refuses a ruleset card that is not a saved package (null = the plain base ruleset). */
export function assertRulesetPackage(name: string | null | undefined, deps: Pick<LeagueApiDeps, "packageExists">): void {
  if (name && deps.packageExists && !deps.packageExists(name)) throw new SettingsError(400, "That ruleset is not on the list.", "rulesetPackage");
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
    stage: seasonStage(s),
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
    ...(isDraftLeague(league) ? { visibility: "draft" as const } : {}),
    houseRules: houseRulesOf(league, "league"),
    ...(league.rulesetPackage ? { rulesetPackage: league.rulesetPackage } : {}),
    authorised: league.authorised !== false,
    timeZone: leagueTimeZone(league),
    money: publicMoneyRules(league, seasons),
  };
}

/** One row of the public list: the summary plus the Browse leagues facts (status, place, search index; browse.ts). */
export function listRow(league: LeagueRecord, seasons: SeasonRecord[], now: Date): LeagueSummary & { browse: LeagueBrowseInfo } {
  return { ...leagueSummary(league, seasons), browse: leagueBrowseInfo(league, seasons, now) };
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
    // Lane L5: POST /api/leagues creates a draft league (wizard.ts).
    if (method === "POST") return createLeagueRoute(auth, deps);
    if (!read) return { status: 405, body: { error: "Use GET or POST." } };
    if (query.get("redraft") === "mine") {
      // The signed-in coach's open redraft tasks (team management page panel).
      if (!auth) return { status: 401, headers: { "cache-control": "no-store" }, body: { error: "Sign in to see your redraft tasks." } };
      return { status: 200, headers: { "cache-control": "no-store" }, body: { tasks: myRedraftTasks(store, auth.coach) } };
    }
    if (query.get("awards") === "mine") {
      // The signed-in coach's awards in every league (coach page Honours panel; awards.ts).
      if (!auth) return { status: 401, headers: { "cache-control": "no-store" }, body: { error: "Sign in to see your awards." } };
      return { status: 200, headers: { "cache-control": "private, no-store" }, body: { awards: myAwards(store, auth.coach) } };
    }
    // Drafts (lifecycle.ts) are listed only to their organisers and admins; such a list is never cached.
    // Browse leagues (owner 11-02): each row also carries its public search index and status (browse.ts).
    const now = deps.now?.() ?? new Date();
    const leagues = visibleLeagues(store.list(), auth);
    const privateList = leagues.some((l) => isDraftLeague(l));
    return { status: 200, ...(privateList ? { headers: { "cache-control": "private, no-store" } } : {}), body: { leagues: leagues.map((l) => listRow(l, store.seasons(l.id), now)) } };
  }
  let found = store.league(route.id);
  // Lane L5 visibility gate: a draft league does not exist for anyone but its organisers and site admins, on every route
  // below (reads and writes alike): the routes see a store without it, so they answer exactly as for an unknown league.
  if (found && !leagueVisibleTo(found, auth)) {
    deps = { ...deps, store: storeWithoutLeague(store, found.id) };
    found = undefined;
  }
  // A test sign-in writes only in a test league (Q13).
  if (found && !read && !testSessionMayWrite(auth, found)) return { status: 403, body: { error: TEST_SESSION_REFUSAL } };
  const league = found;
  // Notifications about a league reach only its organisers and site admins while it is a draft, judged when each one is
  // sent (a request that spans Publish neither leaks before it nor drops after it).
  if (found && deps.notify) {
    const admins = new Set(siteAdmins(deps).map((c) => c.trim().toLowerCase()));
    deps = { ...deps, notify: draftAwareNotify(store, found.id, deps.notify, (c) => admins.has(c.trim().toLowerCase())) };
  }
  const [first, second, ...extra] = route.rest;
  // A ladder id under /seasons/ (lane 8b): hidden while in setup from all but the league's organisers and site admins, and
  // the season-only routes are not there for it.
  if (first === "seasons" && isLadderId(second) && league) {
    const lad = deps.store.season(league.id, second!);
    if (lad && isLadder(lad) && !ladderVisible(lad, Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach))))) return { status: 404, body: { error: "Season not found." } };
    if (extra.length && LADDER_BLOCKED_SEASON_ROUTES.has(extra[0]!)) return { status: 404, body: { error: "Not found." } };
  }
  const lifecycle = await leagueLifecycleRoutes(method, route.rest, league, auth, deps);
  if (lifecycle) return lifecycle;
  // TourPlay import upload (lane L8, tourplayImport.ts): preview / apply, the review list, coach claims.
  const tourplay = await tourplayImportRoutes(method, route.rest, league, auth, deps);
  if (tourplay) return tourplay;
  // League Events (leagueEvents.ts): GET|POST .../events, PATCH|DELETE .../events/:eventId, .../events/discord, GET .../schedule.
  const eventsDiscord = await leagueEventsDiscordRoutes(method, route.rest, league, auth, deps);
  if (eventsDiscord) return eventsDiscord;
  const calendarEvents = await leagueCalendarEventRoutes(method, route.rest, league, auth, deps);
  if (calendarEvents) return calendarEvents;
  // Gates (gates.ts): GET .../gates, PUT .../gates/:kind/:target, POST .../gates/:kind/:target/open, and the live Redraft rolls
  // page (.../redraft-rolls[/link|/:token]). Notes go through the draft-aware notifier above; site admins count as admins.
  const gateRoutes = await leagueGateRoutes(method, route.rest, league, auth, { ...deps, isAdmin: (c: string) => siteAdmins(deps).some((a) => a.trim().toLowerCase() === c.trim().toLowerCase()) });
  if (gateRoutes) return gateRoutes;
  // League ladders (ladderApi.ts).
  const ladders = await leagueLadderRoutes(method, route.rest, league, auth, deps);
  if (ladders) return ladders;
  // The Current Champions panel (ladderApi.ts): season cups and ladder belts.
  const champions = leagueChampionsRoute(method, route.rest, league, deps);
  if (champions) return champions;

  if (first === "logo" || first === "banner") {
    if (second !== undefined) return { status: 404, body: { error: "Not found." } };
    return artRoute(method, first, route.id, league, auth, deps);
  }
  if (first === "members") return memberContactRoute(method, league, second, extra, auth, deps);
  const captain = await leagueCaptainRoutes(method, route.rest, league, auth, deps);
  if (captain) return captain;
  // Team page v2 (teamPage.ts): GET .../teams/:teamId/manage, POST .../edit, .../status, .../fixtures.
  const teamPage = await teamPageRoutes(method, route.rest, league, auth, deps);
  if (teamPage) return teamPage;
  // Team library, swap and takeover (teamLibraryApi.ts): .../library/:coach, .../teams/:teamId/(library|swap|takeover),
  // .../takeovers[/my-teams|/:listingId/applications[/:appId/(approve|decline|withdraw)]].
  const library = await teamLibraryRoutes(method, route.rest, league, auth, deps);
  if (library) return library;
  const lobby = await leagueLobbyRoutes(method, route.rest, league, auth, deps);
  if (lobby) return lobby;
  const inducements = await leagueInducementRoutes(method, route.rest, league, auth, deps, query);
  if (inducements) return inducements;
  // Roster Builder league mode (lane L7): GET .../seasons/:seasonId/team-building, the builder's league context.
  const builder = leagueBuilderRoute(method, route.rest, league, store);
  if (builder) return builder;
  const fork = await leagueForkRoutes(method, route.id, route.rest, auth, deps);
  if (fork) return fork;
  const teamBudget = teamRedraftBudgetRoute(method, route.rest, league, auth, deps);
  if (teamBudget) return teamBudget;
  const redraft = await redraftRoutes(method, route.rest, league, auth, deps, query);
  if (redraft) return redraft;
  // Forfeit dialog (forfeit.ts): GET/POST .../seasons/:seasonId/fixtures/:fixtureId/forfeit[/defections|/settings].
  const forfeit = await leagueForfeitRoutes(method, route.rest, league, auth, deps);
  if (forfeit) return forfeit;
  const events = await leagueEventRoutes(method, route.rest, league, auth, deps);
  if (events) return events;
  const participants = await leagueParticipantRoutes(method, route.rest, league, auth, deps);
  if (participants) return participants;
  // League registration (lane L6, registrationApi.ts): join, the Registrations tab, decisions, "I've paid".
  const registration = await leagueRegistrationRoutes(method, route.rest, league, auth, deps);
  if (registration) return registration;
  // Fixture deadlines + auto-forfeit policy (deadlines.ts; PATCH .../seasons/:seasonId/deadlines). Loaded on demand: one block.
  const deadlines = await (await import("./deadlines.js")).leagueDeadlineRoutes(method, route.rest, league, auth, deps);
  if (deadlines) return deadlines;
  const honours = await leagueHonoursRoutes(method, route.rest, league, auth, deps);
  if (honours) return honours;
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
    // A signed-in read carries the viewer's own paid status (seasonForViewer payment.mine): never cached for anyone else.
    return {
      status: 200, ...(auth ? { headers: { "cache-control": "private, no-store" } } : {}),
      body: { league: leagueSummary(league, store.seasons(league.id)), season: seasonForViewer(league, season, auth, deps.gamePage) },
    };
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
    // Lane L5: a draft's artwork is never cached by a proxy (only its organisers may load it at all).
    const draftArt = isDraftLeague(league) ? { headers: { "cache-control": "private, no-store", vary: "Cookie" } } : {};
    return { status: 200, ...draftArt, file: { path: join(store.leagueDir(id), rel), contentType: AVATAR_CONTENT_TYPE[ext] } };
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
      const res = await (deps.postWebhook ?? defaultPoster)(url, cleanPayload(buildTestPost(lg, who.coach)));
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
/**
 * A league rules change (creation wizards v2 Q2): logged in the current season's news (always kept, a full board never
 * drops it), posted through the cleaned league Discord sender like any news, and sent to every registered coach (inbox +
 * DM: the organiser's message and the site's list of what changed). deps.notify is draft-aware (a draft league tells only
 * its organisers). League rosters are not checked against a package, so there is nothing to re-validate here.
 */
function announceRulesChange(
  league: LeagueRecord, season: SeasonRecord, message: string, diff: readonly string[], started: boolean, coaches: readonly string[], actor: string, count: number, deps: LeagueApiDeps, now: Date,
): void {
  const news = rulesChangeNews(message || "The organiser changed the rules.", diff, started);
  const post: LeagueNewsPost = { id: randomBytes(6).toString("hex"), title: news.title, body: news.body.slice(0, 4000), by: actor, at: now.toISOString(), pinned: false };
  const fresh = deps.store.season(league.id, season.id) ?? season;
  fresh.news = [...(fresh.news ?? []), post];
  deps.store.putSeason(fresh);
  const link = `/app/leagues/${encodeURIComponent(league.id)}`;
  const body = rulesChangeBody(message || "The organiser changed the rules.", diff);
  for (const coach of coaches) {
    try { deps.notify?.(coach, { type: "ruleset-change", title: `${league.name}: the rules changed${count > 1 ? ` (${count} changes)` : ""}`, body, link, from: actor, subject: league.name, action: true }); } catch { /* fire-and-forget */ }
  }
  void postLeagueEvent(deps.store, league, "news", buildNewsPost(league, fresh, post), deps.postWebhook ?? defaultPoster, { seasonId: fresh.id }).catch(() => undefined);
}

function patchSettings(league: LeagueRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps): LeagueApiResult {
  const revisionNow = league.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return { status: 428, body: { error: "Send the settings revision you loaded (revision or If-Match).", revision: revisionNow } };
  if (asked === "bad") return { status: 400, body: { error: "revision must be a whole number.", field: "revision" } };
  if (asked !== revisionNow)
    return { status: 409, body: { error: "These settings changed since you opened them. Reload to see the latest.", revision: revisionNow } };
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
  assertRulesetPackage(info?.rulesetPackage, deps);
  const houseRules = input.houseRules !== undefined ? parseLeagueHouseRules(input.houseRules, league) : undefined;
  const regions = input.regions !== undefined ? parseLeagueRegions(input.regions) : undefined;
  const registrations = input.registrations !== undefined ? parseRegistrations(input.registrations, registrationsOf(league)) : undefined;
  const connections = input.connections !== undefined ? parseConnections(input.connections, discordEvents(league)) : undefined;
  const team = input.teamBuilding !== undefined ? parseTeamBuilding(input.teamBuilding) : undefined;
  let redraftRules: LeagueRecord["redraftRules"];
  if (input.redraft !== undefined) {
    try { redraftRules = parseRedraftRules(input.redraft, league.redraftRules); } catch (e) {
      if (e instanceof RedraftRulesError) throw new SettingsError(400, e.message, e.field);
      throw e;
    }
  }
  const season = team ? deps.store.season(league.id, team.seasonId) : undefined;
  if (team && !season) return { status: 404, body: { error: "Season not found.", field: "seasonId" } };
  // Money rules (moneyRules.ts): the league's layer and / or one competition's override, validated here, written below.
  let moneyLeague: Partial<MoneyRules> | undefined;
  let moneyOverride: { season: SeasonRecord; rules: Partial<MoneyRules> | undefined } | undefined;
  try {
    if (input.money !== undefined) moneyLeague = parseMoneyRules(input.money, league.moneyRules, "money");
    if (input.moneyOverride !== undefined) {
      const o = input.moneyOverride;
      if (!o || typeof o !== "object" || Array.isArray(o)) throw new SettingsError(400, "moneyOverride must be { seasonId, rules }.", "moneyOverride");
      const { seasonId, rules } = o as Record<string, unknown>;
      const target = typeof seasonId === "string" ? deps.store.season(league.id, seasonId) : undefined;
      if (!target) return { status: 404, body: { error: "Season or ladder not found.", field: "moneyOverride.seasonId" } };
      const next = rules === null ? undefined : parseMoneyRules(rules, target.rules?.money, "moneyOverride.rules");
      moneyOverride = { season: target, rules: next && Object.keys(next).length ? next : undefined };
    }
  } catch (e) {
    if (e instanceof MoneyRulesError) throw new SettingsError(400, e.message, e.field);
    throw e;
  }

  // A ruleset / house-rules change with registered coaches (creation wizards v2 Q2): the organiser's message is required
  // (400 without it); once the season has started the "Are you sure?" confirmation is required too (409 without it).
  const rulesBefore: RulesState = { packageName: league.rulesetPackage ?? "", houseRules: houseRulesOf(league, "league"), ruleset: league.ruleset ?? "BB2025" };
  const packageAfter = info?.rulesetPackage !== undefined ? info.rulesetPackage ?? "" : rulesBefore.packageName;
  const rulesAfter: RulesState = {
    packageName: packageAfter,
    houseRules: houseRules ?? rulesBefore.houseRules,
    // A picked package always plays on BB2025 (the write below sets it); otherwise the requested base ruleset.
    ruleset: info?.rulesetPackage ? "BB2025" : info?.ruleset ?? rulesBefore.ruleset,
  };
  const rulesDiff = rulesChangeDiff("league", rulesBefore, rulesAfter, (n) => n || "BB2025");
  const current = deps.store.seasons(league.id)[0];
  const coaches = current && seasonStage(current) !== "completed" ? seasonCoaches(current) : [];
  const started = Boolean(current && seasonStage(current) === "active");
  let changeMessage = "";
  if (rulesDiff.length && coaches.length) {
    try { changeMessage = parseChangeMessage(input.changeMessage); } catch (e) {
      if (e instanceof ChangeMessageError) return { status: 400, body: { error: e.message, field: "changeMessage", changes: rulesDiff, coaches: coaches.length, afterStart: started } };
      throw e;
    }
  }
  if (rulesDiff.length && started && input.confirmAfterStart !== true)
    return { status: 409, body: { error: CONFIRM_AFTER_START_LEAGUE, confirmRequired: true, changes: rulesDiff, coaches: coaches.length, afterStart: true } };

  // Every effective change is logged (who, when, before, after) under a new version; a no-op save logs nothing.
  let moneyChange: { version: number; entries: MoneyRulesLogEntry[] } | undefined;
  {
    const entries: MoneyRulesLogEntry[] = [];
    let version = league.moneyRulesVersion ?? 0;
    const leagueAfter = { ...league, moneyRules: moneyLeague ?? league.moneyRules };
    if (moneyLeague !== undefined) {
      const before = effectiveMoneyRules(league), after = effectiveMoneyRules(leagueAfter);
      const changes = moneyRulesDiff(before, after);
      if (changes.length) entries.push({ at: now.toISOString(), by: who.coach, version: ++version, scope: "league", before, after, changes });
    }
    if (moneyOverride) {
      const s0 = moneyOverride.season;
      const before = effectiveMoneyRules(leagueAfter, s0);
      const after = effectiveMoneyRules(leagueAfter, { rules: { ...(s0.rules ?? {}), money: moneyOverride.rules } });
      const changes = moneyRulesDiff(before, after);
      const storedChanged = JSON.stringify(s0.rules?.money ?? {}) !== JSON.stringify(moneyOverride.rules ?? {});
      if (changes.length || storedChanged) {
        entries.push({ at: now.toISOString(), by: who.coach, version: ++version, scope: { seasonId: s0.id, name: s0.name }, before, after, changes: changes.length ? changes : ["Now follows the league's money rules"] });
      } else moneyOverride = undefined;
    }
    if (entries.length) moneyChange = { version, entries };
  }
  if (season && team) {
    season.rules = {
      ...(season.rules ?? {}),
      teamBuilding: { rosters: team.rosters, eliteSkills: teamBuildingTable(season).eliteSkills, updatedAt: now.toISOString(), updatedBy: who.coach },
    };
    deps.store.putSeason(season);
  }
  if (moneyOverride) {
    // after the team building write (it may be the same season): read it fresh so neither write drops the other
    const fresh = deps.store.season(league.id, moneyOverride.season.id) ?? moneyOverride.season;
    const { money: _m, ...rest } = fresh.rules ?? {};
    fresh.rules = { ...rest, ...(moneyOverride.rules ? { money: moneyOverride.rules } : {}) };
    deps.store.putSeason(fresh);
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
      if (info.playOnFork !== undefined) l.playOnFork = info.playOnFork;
      if (info.timeZone !== undefined) { if (info.timeZone === null) delete l.timeZone; else l.timeZone = info.timeZone; }
      if (info.rulesetPackage !== undefined) { if (info.rulesetPackage === null) delete l.rulesetPackage; else { l.rulesetPackage = info.rulesetPackage; l.ruleset = "BB2025"; } }
    }
    if (houseRules) l.houseRules = houseRules;
    if (regions) { if (regions.length) l.regions = regions; else delete l.regions; }
    if (registrations) l.registrations = registrations;
    if (connections?.playOnFork !== undefined) l.playOnFork = connections.playOnFork;
    if (connections?.discordEvents) l.discordEvents = connections.discordEvents;
    if (redraftRules) l.redraftRules = redraftRules;
    if (moneyChange) {
      if (moneyLeague !== undefined) { if (Object.keys(moneyLeague).length) l.moneyRules = moneyLeague; else delete l.moneyRules; }
      l.moneyRulesVersion = moneyChange.version;
      l.moneyRulesLog = [...(l.moneyRulesLog ?? []), ...moneyChange.entries].slice(-MONEY_LOG_KEEP);
    }
    l.revision = revisionNow + 1;
  }, now);
  if (moneyChange) {
    // the other organisers hear about it through the record-change note (draft-aware deps.notify; never the actor)
    const link = `/app/leagues/${encodeURIComponent(updated.id)}/settings?tab=money`;
    for (const e of moneyChange.entries) {
      const where = e.scope === "league" ? "the league" : e.scope.name;
      notifyRecordChange(updated, who.coach, {
        title: `${updated.name}: money rules changed`,
        body: `${who.coach} changed the money rules for ${where} (version ${e.version}), from the next fixture:\n${e.changes.join("\n")}`, link,
      }, deps.notify);
    }
  }
  if (rulesDiff.length && current && (coaches.length || started)) {
    // Coalesced per league: a burst of edits = one combined news post, note and DM per window.
    (deps.rulesNotices ?? rulesNotices).submit(`league:${updated.id}`, { message: changeMessage, diff: rulesDiff, afterStart: started, actor: who.coach, from: rulesBefore, to: rulesAfter }, (n) => {
      const lg = deps.store.league(updated.id);
      const season = lg ? deps.store.seasons(lg.id)[0] : undefined;
      if (!lg || !season) return;
      announceRulesChange(lg, season, n.message, n.diff, n.afterStart, seasonStage(season) !== "completed" ? seasonCoaches(season) : [], n.actor, n.count, deps, deps.now?.() ?? new Date());
    }, (a, b) => rulesChangeDiff("league", a, b, (x) => x || "BB2025"));
  }
  return { status: 200, body: { ok: true, settings: view(updated, who, deps, team?.seasonId), ...(rulesDiff.length ? { changes: rulesDiff } : {}) } };
}

/** Discord post for a season started / finished, to the season's webhook when its toggle is on. Best effort; the URL is never logged. */
async function postMilestone(league: LeagueRecord, deps: LeagueApiDeps, payload: DiscordPayload, seasonId: string, key: "seasonStarted" | "seasonFinished"): Promise<void> {
  // lane L5: drafts post nothing to Discord (targets.ts)
  await postLeagueEvent(deps.store, league, key, payload, deps.postWebhook ?? defaultPoster, { seasonId });
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
  // Start a new season (creation wizards v2): "Copy last season" (from: "last", the dialog's default) takes the newest
  // season's phases and registration settings; "From template" (from: "template") takes a season template's, and with
  // applyRules (default on) its rules snapshot and house rules too. Without `from` the old behaviour stands (one Regular
  // phase, the league's registration defaults). Everything is checked before anything is written.
  if (input.from !== undefined && input.from !== "last" && input.from !== "template") throw new SettingsError(400, "from must be last or template.", "from");
  let carried: NewSeasonSettings | undefined;
  let template: { content: SeasonTemplateContent; mine: boolean; name: string } | undefined;
  let rulesPatch: { rulesetPackage: string | null; ruleset: LeagueRuleset; houseRules: HouseRules } | undefined;
  if (input.from === "template") {
    if (!deps.seasonTemplate) return { status: 503, body: { error: "Templates are not available right now." } };
    try { template = deps.seasonTemplate(input.templateId, who.coach); } catch (e) {
      if (e instanceof TemplateError) return { status: e.status, body: { error: e.message, ...(e.field ? { field: e.field } : {}) } };
      throw e;
    }
    if (input.usePayLinks !== undefined && typeof input.usePayLinks !== "boolean") throw new SettingsError(400, "usePayLinks must be true or false.", "usePayLinks");
    if (input.applyRules !== undefined && typeof input.applyRules !== "boolean") throw new SettingsError(400, "applyRules must be true or false.", "applyRules");
    carried = seasonFromTemplate(league, template.content, input.usePayLinks === true && template.mine);
    // The template's base ruleset is part of its rules: taken only with "Use its rules" (applyRules, default on).
    if (input.ruleset === undefined && carried.ruleset && input.applyRules !== false) ruleset = template.content.rulesetPackage ? "BB2025" : carried.ruleset;
    if (input.applyRules !== false) {
      const c = template.content;
      const differs = (league.rulesetPackage ?? null) !== c.rulesetPackage || JSON.stringify(houseRulesOf(league, "league")) !== JSON.stringify(c.houseRules)
        || (!c.rulesetPackage && (league.ruleset ?? "BB2025") !== c.ruleset);
      if (differs) {
        assertRulesetPackage(c.rulesetPackage, deps);
        // A season still running with coaches must hear about a rules change (League settings, Rules asks for the message).
        const running = seasons.find((s) => seasonStage(s) !== "completed" && seasonCoaches(s).length > 0);
        if (running) throw new SettingsError(409, `${running.name} is still running with coaches, so the template's rules can't replace the league's here. Untick "Use its rules", or change the rules from League settings so the coaches are told.`, "applyRules");
        rulesPatch = { rulesetPackage: c.rulesetPackage, ruleset: c.rulesetPackage ? "BB2025" : c.ruleset, houseRules: structuredClone(c.houseRules) };
      }
    }
  } else if (input.from === "last") carried = copyLastSeason(league, newest);
  const at = (deps.now?.() ?? new Date()).toISOString();
  const copied = newest?.rules?.teamBuilding;
  const copiedInducements = newest?.rules?.inducements;
  const season: SeasonRecord = {
    id, leagueId: league.id, number, name, sourceSlug: id, ruleset, status: "active", startedAt: at,
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [],
    importedAt: at, source: "manual",
    // Team building rules carry over from the previous season (the organiser edits them on the Team building tab).
    // So does the inducement table (Inducements tab), with its revision started again.
    ...(copied || copiedInducements ? { rules: {
      ...(copied ? { teamBuilding: { ...structuredClone(copied), updatedAt: at, updatedBy: who.coach } } : {}),
      ...(copiedInducements ? { inducements: { ...structuredClone(copiedInducements), revision: 0, updatedAt: at, updatedBy: who.coach } } : {}),
    } } : {}),
  };
  // Draft lists submitted in a redraft before this season existed become its teams.
  const redrafted = applyPendingDrafts(seasons, season);
  // Lane L5: the season starts from the league's registration defaults (Q7), in setup unless redraft gave it teams
  // (Open registration / Start season in Administration move it on).
  season.registration = carried ? structuredClone(carried.registration) : defaultSeasonRegistration(league);
  if (carried) season.phases = structuredClone(carried.phases);
  if (!season.teams.length) season.stage = "setup";
  deps.store.putSeason(season);
  for (const s of redrafted) deps.store.putSeason(s);
  // The template's league-level pieces: its regions (when it has any) and, with applyRules, the rules snapshot.
  if (template && (rulesPatch || template.content.regions.length)) {
    const regions = template.content.regions;
    deps.store.updateLeague(league.id, (l) => {
      if (regions.length) l.regions = [...regions];
      if (rulesPatch) {
        if (rulesPatch.rulesetPackage) l.rulesetPackage = rulesPatch.rulesetPackage; else delete l.rulesetPackage;
        l.ruleset = rulesPatch.ruleset;
        l.houseRules = rulesPatch.houseRules;
      }
      l.revision = (l.revision ?? 0) + 1;
    }, deps.now?.() ?? new Date());
  }
  // Per-competition Discord: the new season starts with the league's webhook and options copied in.
  populateSeasonDiscord(deps.store, league.id, season.id);
  await postMilestone(league, deps, buildMilestonePost(league, "season-started", name, ruleset), season.id, "seasonStarted");
  return { status: 201, body: { ok: true, season: seasonSummary(season), ...(template ? { template: { name: template.name, rulesApplied: Boolean(rulesPatch) } } : {}) } };
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
  season.stage = "active"; // lane L5: a stored registration stage never survives finishing (or a reopen)
  season.endedAt = at;
  deps.store.putSeason(season);
  await postMilestone(league, deps, buildMilestonePost(league, "season-finished", season.name), season.id, "seasonFinished");
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
  return { status: 200, body: { ok: true, season: seasonForViewer(league, season, who, deps.gamePage) } };
}

/** Reopen a season finished on this site (it has a podium record): back in progress, podium awards and record removed. */
function reopenSeason(league: LeagueRecord, seasonId: string, deps: LeagueApiDeps): LeagueApiResult {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return { status: 404, body: { error: "Season not found." } };
  if (season.status !== "completed") return { status: 409, body: { error: `${season.name} is still in progress.` } };
  if (!season.podium) return { status: 409, body: { error: "Only a season finished on this site can be reopened." } };
  season.status = "active";
  // Lane L5: a reopened season is in play again, never back in registration.
  season.stage = "active";
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
  if (on && !competitionPlaysOnFork(league, season)) return { status: 409, body: { error: season.competition === "ladder" ? "Set this ladder to be played on Super FUMBBL first." : "Turn on Play on Super FUMBBL in League settings first." } };
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
export function seasonForViewer(league: LeagueRecord, full: SeasonRecord, auth: LeagueApiIdentity | undefined, gamePage?: (gameId: string) => boolean): SeasonRecord {
  // Redraft state (budgets, R&R, draft rosters) is served only by the authorised redraft routes, never in a season read.
  // League registration rows (lane L6) are organiser and coach data, served only by the registration routes.
  // Takeover applications (team library lane) are the applicant's and the organisers', served only by takeover routes; a ladder's own record (challenges, members, rounds) by the ladder routes (ladderApi.ts).
  const { redraft: _r, registrations: _reg, takeoverApplications: _ta, ladder: _lad, ...derived } = withCaptainCandidates(withStandings(full));
  // Team page v2: a team-page MNG the team has served reads as cleared (computed on a copy; the next write stores it), and
  // team histories and injury authors stay with the team's coach and the organisers (GET .../teams/:teamId/manage).
  const teamsCopy = derived.teams.some((t) => t.players.some((p) => p.mngGames !== undefined)) ? structuredClone(derived.teams) : derived.teams;
  if (teamsCopy !== derived.teams) settleServedMng({ ...derived, teams: teamsCopy } as SeasonRecord);
  const season = { ...derived, teams: teamsCopy.map(publicTeam) };
  const fixtures = season.fixtures.map((f) => (f.forkNotice || f.fork || f.resultEdit || f.forfeitDetail || f.forfeitDraft ? publicForkState(f, gamePage) : f));
  // Organiser-only log entries (team value diff / not recomputed) stay with organisers and admins.
  const manager = Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach)));
  const payment = seasonPayment(league, full, auth, manager);
  const extra = payment ? { payment } : {};
  if (manager) return { ...season, fixtures, ...extra };
  // Participants tab flags (paid, verified...) are organiser data (participants.ts).
  const participants = participantsForPublic(season.participants);
  if (!season.log) return { ...season, fixtures, participants, ...extra };
  return { ...season, fixtures, participants, log: season.log.filter((e) => !ORGANISER_LOG_KINDS.has(e.kind)), ...extra };
}

/**
 * The "Pay entry fee" block of a season read: the season's links (re-checked) and entry fee, shown on a published league
 * (a draft reaches only its organisers and admins), plus the viewer's own teams' Paid flag. Nobody else's paid status is
 * ever in it. Undefined when there is nothing to show (no link, and no entry of the viewer's with a fee).
 */
function seasonPayment(league: LeagueRecord, season: SeasonRecord, auth: LeagueApiIdentity | undefined, manager: boolean): SeasonRecord["payment"] {
  if (isDraftLeague(league) && !manager) return undefined;
  const reg = seasonRegistrationOf(league, season);
  const links = paymentLinksView(reg.payPal, reg.venmo);
  const mine = auth ? myPaymentStatus(season, auth.coach) : [];
  const fee = reg.entryFee.trim();
  if (!links && !(mine.length && fee)) return undefined;
  return { ...(fee ? { entryFee: fee } : {}), ...(links ?? {}), ...(mine.length ? { mine } : {}) };
}
