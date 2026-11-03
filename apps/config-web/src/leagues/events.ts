/**
 * League events: league news, the organiser fixtures editor, and the Discord posts for every event toggle (league
 * news, fixture created, match started, match result). Season start / finish and the redraft post from api.ts /
 * redraftApi.ts. Every post goes through the league webhook only when its toggle is on; the URL is never logged.
 *
 *   POST   /api/leagues/:id/seasons/:seasonId/news                { title, body, pinned? }   organisers + admins
 *   PATCH  /api/leagues/:id/seasons/:seasonId/news/:newsId        { title?, body?, pinned? }
 *   DELETE /api/leagues/:id/seasons/:seasonId/news/:newsId
 *   POST   /api/leagues/:id/seasons/:seasonId/fixtures            { home, away (team ids), round, phaseId?, date?, test? }
 *   DELETE /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId (a fixture without a result)
 *   PATCH  .../fixtures/:fixtureId { date?, round?, result? }     via api.ts settings route (editFixture below)
 *
 * News is read with the season (season.news, pinned first then newest first). Other paths that start a match or write
 * a result (the Super FUMBBL fork lane, tabletop) call recordLeagueFixtureEvent.
 */
import { settleServedMng } from "./teamOps.js";
import { randomBytes } from "node:crypto";
import type { NotificationInput } from "../notifications.js";
import { NEWS_MAX_POSTS, orderedNews, parseNewsInput } from "../tournaments/page.js";
import { TournamentStoreError } from "../tournaments/store.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { postWebhook as defaultPoster, type DiscordPayload, type WebhookPoster } from "./discord.js";
import { forkGame } from "../discord/games.js";
import { starProfanity } from "../discord/profanity.js";
import { announceGame } from "../discord/games-post.js";
import { leagueTarget, postTo, seasonTarget } from "../discord/targets.js";
import { readJsonObject } from "./http.js";
import { teamSeat } from "./identity.js";
import { SettingsError } from "./settings.js";
import { isLeagueOrganiser, type LeagueStore } from "./store.js";
import { fixturePlayed } from "./tourplay.js";
import type {
  DiscordEventKey, FixtureSide, LeagueEventEntry, LeagueFixture, LeagueNewsPost, LeagueRecord, LeagueTeam, SeasonRecord,
} from "./types.js";
import { publicFixture } from "./fixturePublic.js";
import { fixtureRedraftBlock } from "./redraftWindow.js";

export const EVENTS_MAX_BYTES = 64 * 1024;
export const LOG_CAP = 200;
export const FIXTURES_MAX = 2000;
export const ROUND_MAX = 99;
export const SCORE_MAX = 99;
const NO_STORE = { "cache-control": "no-store" };

const BRAND = "Super FUMBBL";
const GOLD = 0xe8b02c;
const GREEN = 0x3fa34d;
const BLUE = 0x3b82c4;
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const testTag = (test: boolean | undefined): string => (test ? "[Test] " : "");

// ---- Discord embeds (pure; no network) -----------------------------------------------------------------------------

type LeagueName = Pick<LeagueRecord, "name">;
type SeasonName = Pick<SeasonRecord, "name">;

const sideLabel = (s: Pick<FixtureSide, "team" | "coach" | "race">): string => `${s.team}${s.coach || s.race ? ` (${[s.coach, s.race].filter(Boolean).join(", ")})` : ""}`;
const roundLabel = (f: Pick<LeagueFixture, "phase" | "round">): string => [f.phase && f.phase !== "Regular" ? f.phase : "", f.round ? `Round ${f.round}` : ""].filter(Boolean).join(", ");

function embed(title: string, description: string, color: number, footer?: string): DiscordPayload {
  return {
    username: BRAND,
    embeds: [{ title: clip(title, 256), description: clip(description, 2000), color, ...(footer ? { footer: { text: clip(footer, 200) } } : {}) }],
    allowed_mentions: { parse: [] },
  };
}

/** League news posted on the league page. */
export function buildNewsPost(league: LeagueName, season: SeasonName, post: Pick<LeagueNewsPost, "title" | "body" | "by">, test = false): DiscordPayload {
  // Discord always stars listed words (owner 11-02); the site keeps the post as written.
  return embed(`${testTag(test)}${league.name}: ${starProfanity(post.title)}`, starProfanity(post.body), GOLD, `${season.name} news by ${post.by}`);
}

/** An organiser created a fixture. */
export function buildFixtureCreatedPost(league: LeagueName, season: SeasonName, f: LeagueFixture): DiscordPayload {
  const when = [roundLabel(f), f.date ? `on ${f.date}` : ""].filter(Boolean).join(" ");
  return embed(`${testTag(f.test)}${league.name}: new fixture`, `${sideLabel(f.home)} vs ${sideLabel(f.away)}${when ? `\n${when}` : ""}`, BLUE, season.name);
}

/** A league fixture's match started (fork game launched, or a tabletop match started recording). */
export function buildMatchStartedPost(league: LeagueName, season: SeasonName, f: LeagueFixture, opts: { test?: boolean; where?: string } = {}): DiscordPayload {
  const where = opts.where ? ` on ${opts.where}` : "";
  return embed(`${testTag(opts.test || f.test)}${league.name}: kick-off`, `${f.home.team} vs ${f.away.team} has started${where}.${roundLabel(f) ? `\n${roundLabel(f)}` : ""}`, GREEN, season.name);
}

/** A result was written to a league fixture (hand entry, tabletop or Super FUMBBL). */
export function buildMatchResultPost(league: LeagueName, season: SeasonName, f: LeagueFixture, opts: { test?: boolean } = {}): DiscordPayload {
  const score = `${f.home.team} ${f.home.score ?? 0} - ${f.away.score ?? 0} ${f.away.team}`;
  const cas = f.home.cas !== null || f.away.cas !== null ? `\nCasualties ${f.home.cas ?? 0} - ${f.away.cas ?? 0}` : "";
  const conceded = f.home.conceded ? `\n${f.home.team} conceded.` : f.away.conceded ? `\n${f.away.team} conceded.` : "";
  return embed(`${testTag(opts.test || f.test)}${league.name}: result`, `${score}${cas}${conceded}${roundLabel(f) ? `\n${roundLabel(f)}` : ""}`, GOLD, season.name);
}

/**
 * Posts the payload when the competition has a webhook and the event's toggle is on. Best effort; never logs the URL.
 * `opts.seasonId` posts to that season's own webhook and toggles (a blank season webhook falls back to the league's:
 * src/discord/targets.ts); without it the league's own.
 */
export async function postLeagueEvent(
  store: LeagueStore, league: LeagueRecord, key: DiscordEventKey, payload: DiscordPayload, poster: WebhookPoster = defaultPoster,
  opts: { seasonId?: string } = {},
): Promise<boolean> {
  // Lane L5: a draft league posts nothing to Discord (publishing never replays what happened while it was a draft).
  const target = opts.seasonId ? seasonTarget(store, league, opts.seasonId) : leagueTarget(store, league);
  return postTo(target, key, payload, poster);
}

// ---- season log -----------------------------------------------------------------------------------------------------

export function addLog(season: SeasonRecord, entry: LeagueEventEntry): void {
  season.log = [entry, ...(season.log ?? [])].slice(0, LOG_CAP);
}

export const resultSig = (f: LeagueFixture): string => `${f.home.score ?? ""}-${f.away.score ?? ""}/${f.home.cas ?? ""}-${f.away.cas ?? ""}/${f.home.conceded ? "h" : f.away.conceded ? "a" : ""}`;

const matchText = (f: LeagueFixture): string => `${f.home.team} vs ${f.away.team}`;

// ---- recordLeagueFixtureEvent (other lanes call this) ---------------------------------------------------------------

export interface LeagueEventDeps {
  store: LeagueStore;
  postWebhook?: WebhookPoster;
  notify?: (coach: string, input: NotificationInput) => void;
  now?: () => Date;
}

let registered: LeagueEventDeps | undefined;
/** server.ts registers the live store once, so recordLeagueFixtureEvent works without threading deps through. */
export function registerLeagueEvents(deps: LeagueEventDeps | undefined): void { registered = deps; }

export interface FixtureEventPayload {
  /** The season holding the fixture; omitted = the newest season that has a fixture with this id. */
  seasonId?: string;
  /** Who / what started it or wrote the result (a coach, "Super FUMBBL", "tabletop"). */
  by?: string;
  /** Test data: the post carries the "[Test]" prefix. */
  test?: boolean;
  /** match started: where it is played ("Super FUMBBL", "the tabletop"). */
  where?: string;
  /** result: the result comes from a recorded game (the fork, the recorder) even without a banked game record. */
  recorded?: boolean;
  /** result: an organiser or admin typed it in (logged, never announced). */
  handEntered?: boolean;
}

export interface FixtureEventOutcome { ok: boolean; posted: boolean; reason?: string }

/**
 * The shared hook for a league fixture's match starting or its result being written. "started" stamps startedAt (when
 * unset) and posts once per fixture; "result" announces the result already stored on the fixture (the caller writes
 * it first) and posts once per distinct result. Logged on the season; posts honour the per-event toggles.
 */
export async function recordLeagueFixtureEvent(
  leagueId: string, fixtureId: string, kind: "started" | "result", payload: FixtureEventPayload = {}, deps: LeagueEventDeps | undefined = registered,
): Promise<FixtureEventOutcome> {
  if (!deps) return { ok: false, posted: false, reason: "League events are not configured." };
  const league = deps.store.league(leagueId);
  if (!league) return { ok: false, posted: false, reason: "League not found." };
  const seasons = payload.seasonId ? [deps.store.season(leagueId, payload.seasonId)].filter((s): s is SeasonRecord => Boolean(s)) : deps.store.seasons(leagueId);
  const season = seasons.find((s) => s.fixtures.some((f) => f.id === fixtureId));
  const fixture = season?.fixtures.find((f) => f.id === fixtureId);
  if (!season || !fixture) return { ok: false, posted: false, reason: "Fixture not found." };
  return fixtureEvent(league, season, fixture, kind, payload, deps);
}

async function fixtureEvent(
  league: LeagueRecord, season: SeasonRecord, fixture: LeagueFixture, kind: "started" | "result", payload: FixtureEventPayload, deps: LeagueEventDeps,
): Promise<FixtureEventOutcome> {
  const at = (deps.now?.() ?? new Date()).toISOString();
  const by = payload.by?.trim() || "";
  if (kind === "started") {
    if (fixture.announced?.started || (season.log ?? []).some((e) => e.kind === "match-started" && e.fixtureId === fixture.id))
      return { ok: true, posted: false, reason: "Already announced." };
    fixture.startedAt ??= at;
    fixture.announced = { ...(fixture.announced ?? {}), started: at };
    addLog(season, { at, by, kind: "match-started", fixtureId: fixture.id, text: `${matchText(fixture)} started${payload.where ? ` on ${payload.where}` : ""}.` });
    deps.store.putSeason(season);
    const posted = await postLeagueEvent(deps.store, league, "matchStarted", buildMatchStartedPost(league, season, fixture, payload), deps.postWebhook, { seasonId: season.id });
    return { ok: true, posted };
  }
  if (!fixturePlayed(fixture)) return { ok: false, posted: false, reason: "The fixture has no result yet." };
  const sig = resultSig(fixture);
  const marked = fixture.announced ? fixture.announced.result === sig
    : (season.log ?? []).some((e) => e.kind === "match-result" && e.fixtureId === fixture.id && e.sig === sig);
  if (marked) return { ok: true, posted: false, reason: "Already announced." };
  fixture.finishedAt ??= at;
  fixture.announced = { ...(fixture.announced ?? {}), result: sig };
  // Team page v2: a missed-next-game an organiser set is served by this game (teamOps.ts settleServedMng).
  settleServedMng(season);
  addLog(season, { at, by, kind: "match-result", fixtureId: fixture.id, sig, text: `${fixture.home.team} ${fixture.home.score ?? 0} - ${fixture.away.score ?? 0} ${fixture.away.team}` });
  deps.store.putSeason(season);
  // A recorded Super FUMBBL game gets the end-of-game digest (when on) and its live events; a result with no game record
  // behind it (an organiser's or admin's hand entry) is logged above but never announced (owner round 3).
  const game = forkGame(fixture);
  if (payload.handEntered || (!game && !payload.recorded)) return { ok: true, posted: false, reason: "Hand-entered results are not announced." };
  const outcome = await announceGame(seasonTarget(deps.store, league, season.id), game, deps.postWebhook ?? defaultPoster, {
    round: roundLabel(fixture) || undefined,
    plain: () => buildMatchResultPost(league, season, fixture, payload),
  });
  return { ok: true, posted: outcome.digest || outcome.plain };
}

// ---- routes ---------------------------------------------------------------------------------------------------------

const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

const isManager = (league: LeagueRecord, auth: LeagueApiIdentity): boolean => auth.admin || isLeagueOrganiser(league, auth.coach);

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!isManager(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can change it.");
  return undefined;
}

const overviewLink = (leagueId: string, seasonId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}`;

/** The season's coaches mapped to a fork account (teams, then participants), once each, the author excluded. */
export function seasonCoaches(season: Pick<SeasonRecord, "teams" | "participants">, exclude = ""): string[] {
  const seen = new Set<string>([exclude.trim().toLowerCase()]);
  const out: string[] = [];
  for (const c of [...season.teams.map((t) => t.coachId), ...season.participants.map((p) => p.coachId)]) {
    const key = c?.trim().toLowerCase();
    if (!c || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(c.trim());
  }
  return out;
}

/** Routes this module owns; undefined = not one of them (the caller tries the next router). */
export async function leagueEventRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, what, itemId, ...more] = rest;
  if (first !== "seasons" || !seasonId || more.length) return undefined;
  const news = what === "news";
  const fixtures = what === "fixtures" && (itemId === undefined ? method === "POST" : method === "DELETE");
  if (!news && !fixtures) return undefined;
  if (news) {
    if (itemId === undefined && method !== "POST") return fail(405, "POST to /news to add a post.");
    if (itemId !== undefined && method !== "PATCH" && method !== "DELETE") return fail(405, "Use PATCH or DELETE.");
  }
  const early = gate(league, auth);
  if (early) return early;
  let input: Record<string, unknown> = {};
  if (method !== "DELETE") {
    const body = await readJsonObject(deps, EVENTS_MAX_BYTES);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    input = body.value;
  }
  // Judged against the league as it is now (after the body arrived); synchronous from here to the writes.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const who = auth!;
  const ev: LeagueEventDeps = { store: deps.store, postWebhook: deps.postWebhook, notify: deps.notify, now: deps.now };
  try {
    if (news) return await newsRoute(method, lg, season, itemId, who, input, ev);
    if (itemId === undefined) return await createFixture(lg, season, who, input, ev);
    return deleteFixture(season, itemId, who, ev);
  } catch (e) {
    if (e instanceof SettingsError || e instanceof TournamentStoreError) return fail(e.status, e.message, e instanceof SettingsError && e.field ? { field: e.field } : {});
    return fail(500, "Could not save that right now.");
  }
}

// ---- news -----------------------------------------------------------------------------------------------------------

async function newsRoute(
  method: string, league: LeagueRecord, season: SeasonRecord, newsId: string | undefined, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueEventDeps,
): Promise<LeagueApiResult> {
  const now = (deps.now?.() ?? new Date()).toISOString();
  const list = season.news ?? [];
  if (newsId === undefined) {
    const parsed = parseNewsInput(input, false);
    if (list.length >= NEWS_MAX_POSTS) return fail(409, `A season can hold at most ${NEWS_MAX_POSTS} news posts; delete an old one first.`);
    const post: LeagueNewsPost = { id: randomBytes(6).toString("hex"), title: parsed.title!, body: parsed.body!, by: who.coach, at: now, pinned: parsed.pinned === true };
    season.news = [...list, post];
    deps.store.putSeason(season);
    const link = overviewLink(league.id, season.id);
    for (const coach of seasonCoaches(season, who.coach)) {
      try { deps.notify?.(coach, { type: "league-broadcast", title: clip(`${league.name}: ${post.title}`, 120), body: clip(post.body, 300), link, from: who.coach }); } catch { /* fire-and-forget */ }
    }
    await postLeagueEvent(deps.store, league, "news", buildNewsPost(league, season, post), deps.postWebhook, { seasonId: season.id });
    return res(201, { post, news: orderedNews(season.news), revision: season.revision });
  }
  const post = list.find((p) => p.id === newsId);
  if (!post) return fail(404, "News post not found.");
  if (method === "DELETE") {
    season.news = list.filter((p) => p.id !== newsId);
    if (!season.news.length) delete season.news;
    deps.store.putSeason(season);
    return res(200, { news: orderedNews(season.news), revision: season.revision });
  }
  const patch = parseNewsInput(input, true);
  if (patch.title !== undefined) post.title = patch.title;
  if (patch.body !== undefined) post.body = patch.body;
  if (patch.pinned !== undefined) post.pinned = patch.pinned;
  if (patch.title !== undefined || patch.body !== undefined) post.editedAt = now;
  deps.store.putSeason(season);
  return res(200, { post, news: orderedNews(season.news), revision: season.revision });
}

// ---- fixtures editor ------------------------------------------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "" / null = clear; otherwise a real calendar date YYYY-MM-DD. */
export function parseFixtureDate(v: unknown): string | null {
  if (v === null || v === "") return null;
  if (typeof v !== "string" || !DATE.test(v.trim())) throw new SettingsError(400, "Date must look like 2026-11-05.", "date");
  const d = v.trim();
  const t = Date.parse(`${d}T00:00:00Z`);
  if (!Number.isFinite(t) || new Date(t).toISOString().slice(0, 10) !== d) throw new SettingsError(400, "That date does not exist.", "date");
  return d;
}

function parseRound(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > ROUND_MAX) throw new SettingsError(400, `Round must be a whole number from 1 to ${ROUND_MAX}.`, "round");
  return v;
}

function parseScore(v: unknown, field: string, nullable: boolean): number | null {
  if (v === undefined || v === null || v === "") {
    if (nullable) return null;
    throw new SettingsError(400, `${field} is required.`, field);
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > SCORE_MAX) throw new SettingsError(400, `${field} must be a whole number from 0 to ${SCORE_MAX}.`, field);
  return v;
}

const side = (t: LeagueTeam): FixtureSide => ({
  team: t.name, teamId: t.id, coach: t.coach, race: t.race, ...teamSeat(t),
  score: null, cas: null, conceded: false,
});

export interface NewFixtureInput { home: string; away: string; round: number; phaseId: string; date: string | null; test: boolean }

/** Validates a fixtures-editor create against the season (teams, phases). Throws SettingsError. */
export function parseNewFixture(season: Pick<SeasonRecord, "teams" | "phases" | "fixtures">, input: Record<string, unknown>): NewFixtureInput {
  const home = typeof input.home === "string" ? input.home : "";
  const away = typeof input.away === "string" ? input.away : "";
  if (!season.teams.some((t) => t.id === home)) throw new SettingsError(400, "Pick the home team.", "home");
  if (!season.teams.some((t) => t.id === away)) throw new SettingsError(400, "Pick the away team.", "away");
  if (home === away) throw new SettingsError(400, "A team cannot play itself.", "away");
  const round = parseRound(input.round);
  let phaseId = season.phases[0]?.id ?? "season-regular";
  if (input.phaseId !== undefined && input.phaseId !== "") {
    if (typeof input.phaseId !== "string" || !season.phases.some((p) => p.id === input.phaseId)) throw new SettingsError(400, "Unknown phase.", "phaseId");
    phaseId = input.phaseId;
  }
  const date = input.date === undefined ? null : parseFixtureDate(input.date);
  if (input.test !== undefined && typeof input.test !== "boolean") throw new SettingsError(400, "test must be true or false.", "test");
  if (season.fixtures.length >= FIXTURES_MAX) throw new SettingsError(409, `A season can hold at most ${FIXTURES_MAX} fixtures.`);
  return { home, away, round, phaseId, date, test: input.test === true };
}

async function createFixture(league: LeagueRecord, season: SeasonRecord, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueEventDeps): Promise<LeagueApiResult> {
  const p = parseNewFixture(season, input);
  const phase = season.phases.find((x) => x.id === p.phaseId);
  let id = `fx-${randomBytes(5).toString("hex")}`;
  while (season.fixtures.some((f) => f.id === id)) id = `fx-${randomBytes(5).toString("hex")}`;
  const table = season.fixtures.filter((f) => f.phaseId === p.phaseId && f.round === p.round).reduce((m, f) => Math.max(m, f.table || 0), 0) + 1;
  const fixture: LeagueFixture = {
    id, category: phase?.category ?? "Season", phase: phase?.name ?? "Regular", phaseId: p.phaseId, group: phase?.groups[0] ?? "", round: p.round, table,
    home: side(season.teams.find((t) => t.id === p.home)!), away: side(season.teams.find((t) => t.id === p.away)!), suspended: false,
    ...(p.date ? { date: p.date } : {}), ...(p.test ? { test: true } : {}),
  };
  season.fixtures.push(fixture);
  const at = (deps.now?.() ?? new Date()).toISOString();
  addLog(season, { at, by: who.coach, kind: "fixture-created", fixtureId: id, text: `${who.coach} added ${matchText(fixture)} (Round ${p.round}${p.date ? `, ${p.date}` : ""}).` });
  deps.store.putSeason(season);
  await postLeagueEvent(deps.store, league, "fixtureCreated", buildFixtureCreatedPost(league, season, fixture), deps.postWebhook, { seasonId: season.id });
  return res(201, { ok: true, fixture: shown(fixture), revision: season.revision });
}

function deleteFixture(season: SeasonRecord, fixtureId: string, who: LeagueApiIdentity, deps: LeagueEventDeps): LeagueApiResult {
  const fixture = season.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return fail(404, "Fixture not found.");
  if (fixturePlayed(fixture)) return fail(409, "This fixture has a result: clear the result before deleting it.");
  season.fixtures = season.fixtures.filter((f) => f.id !== fixtureId);
  addLog(season, { at: (deps.now?.() ?? new Date()).toISOString(), by: who.coach, kind: "fixture-deleted", fixtureId, text: `${who.coach} deleted ${matchText(fixture)}.` });
  deps.store.putSeason(season);
  return res(200, { ok: true, revision: season.revision });
}

const shown = publicFixture;

/**
 * PATCH a fixture from the editor: { date?: "YYYY-MM-DD" | null, round?, result?: { home, away, homeCas?, awayCas? } | null }.
 * A new or changed result is announced (matchResult); clearing it removes finishedAt. Called by api.ts (settings route,
 * organiser gate already passed) when the body carries no forkEnabled.
 */
export async function editFixture(
  league: LeagueRecord, seasonId: string, fixtureId: string, who: LeagueApiIdentity, input: Record<string, unknown>, deps: LeagueApiDeps,
): Promise<LeagueApiResult> {
  const season = deps.store.season(league.id, seasonId);
  if (!season) return fail(404, "Season not found.");
  const fixture = season.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return fail(404, "Fixture not found.");
  const keys = ["date", "round", "result"].filter((k) => input[k] !== undefined);
  if (!keys.length) throw new SettingsError(400, "Nothing to change: send date, round or result.");
  const date = input.date !== undefined ? parseFixtureDate(input.date) : undefined;
  const round = input.round !== undefined ? parseRound(input.round) : undefined;
  let result: { home: number; away: number; homeCas: number | null; awayCas: number | null } | null | undefined;
  if (input.result === null) result = null;
  else if (input.result !== undefined) {
    if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) throw new SettingsError(400, "result must be an object or null.", "result");
    const r = input.result as Record<string, unknown>;
    result = {
      home: parseScore(r.home, "Home score", false)!, away: parseScore(r.away, "Away score", false)!,
      homeCas: parseScore(r.homeCas, "Home casualties", true), awayCas: parseScore(r.awayCas, "Away casualties", true),
    };
  }
  // A team in an open redraft window (or still needing its redraft) cannot play: no result for it (redraftWindow.ts).
  if (result) {
    const blocked = fixtureRedraftBlock(deps.store.seasons(league.id), fixture, deps.now?.() ?? new Date());
    if (blocked) throw new SettingsError(409, blocked, "result");
  }
  if (date !== undefined) { if (date === null) delete fixture.date; else fixture.date = date; }
  if (round !== undefined) fixture.round = round;
  let announce = false;
  if (result === null) {
    fixture.home.score = fixture.away.score = null;
    fixture.home.cas = fixture.away.cas = null;
    fixture.home.conceded = fixture.away.conceded = false;
    delete fixture.finishedAt;
    delete fixture.resultEdit;
    // A corrected result entered after a clear is announced again.
    if (fixture.announced) { delete fixture.announced.result; if (!fixture.announced.started) delete fixture.announced; }
  } else if (result) {
    const before = fixturePlayed(fixture) ? resultSig(fixture) : "";
    // This route is organiser/admin-only (the settings gate in api.ts); a coach's report arrives through the recorder or the
    // Super FUMBBL result path, which clear the marker. So every score typed or changed here is an organiser's edit, a first
    // entry included, and the Weekly Digest labels it "edited". A both-lose placeholder is not a result: a score entered over
    // it is an entry too.
    const placeholder = fixture.deadlineOutcome?.outcome === "both-lose";
    // Only a save that changes the scores or casualties counts: an unchanged save keeps (or never makes) the mark.
    const changed = !fixturePlayed(fixture) || placeholder || fixture.home.score !== result.home || fixture.away.score !== result.away || fixture.home.cas !== result.homeCas || fixture.away.cas !== result.awayCas;
    // A real score typed over a concession replaces it: clear the conceded flags so standings and digest read the same outcome.
    if (changed) fixture.home.conceded = fixture.away.conceded = false;
    if (changed) fixture.resultEdit = { ...(who.coach ? { by: who.coach } : {}), at: (deps.now?.() ?? new Date()).toISOString() };
    // A both-lose deadline placeholder is a double concession: the real result entered over it is not.
    if (fixture.deadlineOutcome?.outcome === "both-lose") fixture.home.conceded = fixture.away.conceded = false;
    fixture.home.score = result.home;
    fixture.away.score = result.away;
    fixture.home.cas = result.homeCas;
    fixture.away.cas = result.awayCas;
    announce = resultSig(fixture) !== before;
  }
  // A result entered or cleared here replaces any deadline outcome (deadlines.ts), including a both-lose placeholder.
  if (result !== undefined) delete fixture.deadlineOutcome;
  // Standings are derived from the results (standings.ts); an imported season with a newer result is recomputed.
  if (result !== undefined) season.resultsChangedAt = (deps.now?.() ?? new Date()).toISOString();
  deps.store.putSeason(season);
  // Logged on the season; hand-entered results are never announced on Discord (owner round 3).
  if (announce) await fixtureEvent(league, season, fixture, "result", { by: who.coach, handEntered: true }, { store: deps.store, postWebhook: deps.postWebhook, now: deps.now });
  return res(200, { ok: true, fixture: shown(fixture), revision: season.revision });
}


