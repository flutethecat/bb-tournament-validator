/**
 * Competition Discord settings (league, season, tournament) and the organiser actions. Organisers of the competition and
 * site admins only (anonymous 401, others 403; a draft the viewer cannot see answers 404). Every answer is no-store.
 *
 *   GET   /api/leagues/:id/discord                          league options (webhook masked), Weekly Digest, bot invite
 *   PATCH /api/leagues/:id/discord                          { url?, events?, live?, endOfGameDigest?, comments?, weekly?, timeZone? }
 *   GET   /api/leagues/:id/seasons/:seasonId/discord        a season's own options (blank webhook = the league's)
 *   PATCH /api/leagues/:id/seasons/:seasonId/discord        { url?, events?, live?, endOfGameDigest?, comments?, inherit? }
 *   GET   /api/tournaments/:id/discord                      a tournament's options (tournament mode until changed)
 *   PATCH /api/tournaments/:id/discord                      { url?, events?, live?, endOfGameDigest?, comments? }
 *   POST  <any of the three>/discord/test                   one test post (the league's stays on the settings route)
 *   POST  <any of the three>/discord/samples                one "[TEST]" sample per ticked event (rate limited; never drafts)
 *   GET   /api/leagues/:id/discord/weekly-digest            preview of the Weekly Digest for the current period (read only)
 *   POST  /api/leagues/:id/discord/weekly-digest/post       post it now
 *
 * Webhook URLs are secrets: stored server-side, only ever answered masked, never logged, never in an error message.
 * GETs never change anything; writes go through the CSRF gate (src/auth/csrf.ts) like every other /api write.
 */
import { DISCORD_EVENT_LABEL, isDiscordWebhookUrl, maskWebhookUrl, postWebhook as defaultPoster, type DiscordPayload, type WebhookPoster } from "../leagues/discord.js";
import { isDraftLeague, managesLeague } from "../leagues/lifecycle.js";
import type { LeagueStore } from "../leagues/store.js";
import { DISCORD_EVENT_KEYS, type DiscordEventKey, type DiscordEvents, type LeagueRecord } from "../leagues/types.js";
import { isTournamentManager, type TournamentStore } from "../tournaments/store.js";
import type { TournamentRecord } from "../tournaments/types.js";
import {
  appliesTo, eventKeysFor, eventMeta, IN_GAME_KEYS, typeOfKind, type CompetitionDiscordConfig, type CompetitionKind, type CompetitionType, type EffectiveDiscordConfig, type LiveMap,
} from "./catalogue.js";
import type { DiscordObserver } from "./observer.js";
import { cleanPayload, post, safe, samplePost } from "./posts.js";
import type { DiscordStateStore } from "./store.js";
import { leagueTarget, seasonCompetitionKey, seasonTarget, tournamentTarget, type DiscordTarget } from "./targets.js";
import { parseWeekly, weeklyOf, WEEKDAYS, type WeeklyDigestSettings } from "./weekly.js";
import { isTimeZone, leagueTimeZone, leagueTimeZoneSet } from "../leagues/timeZone.js";

export interface DiscordApiIdentity { coach: string; admin?: boolean }
export interface DiscordApiResult { status: number; body: unknown; headers?: Record<string, string> }

export interface DiscordApiDeps {
  leagues: LeagueStore;
  tournaments: Pick<TournamentStore, "tournament">;
  state: DiscordStateStore;
  observer?: Pick<DiscordObserver, "digestFor" | "previewPeriod" | "claimPeriod">;
  poster?: WebhookPoster;
  /** DISCORD_CLIENT_ID: the bot invite link (hidden when unset). */
  clientId?: string;
  /** Pause between sample posts (Discord rate-limits webhooks); tests pass 0. */
  samplePauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const NO_STORE = { "cache-control": "no-store" };
const res = (status: number, body: unknown): DiscordApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, field?: string): DiscordApiResult => res(status, { error, ...(field ? { field } : {}) });

export const SAMPLE_WINDOW_MS = 10 * 60_000;
const TEST_WINDOW_MS = 60_000;
const DIGEST_POST_WINDOW_MS = 60_000;
/** Bot permissions the invite asks for: View Channels, Send Messages, Embed Links. */
export const BOT_PERMISSIONS = 1024 + 2048 + 16384;

/** Per-competition rate limits (memory only): samples, test posts, Weekly Digest "Post now". */
const lastRun = new Map<string, number>();
export function resetDiscordRateLimits(): void { lastRun.clear(); }
function limited(key: string, windowMs: number, now: number): number {
  const prev = lastRun.get(key);
  if (prev !== undefined && now - prev < windowMs) return Math.ceil((windowMs - (now - prev)) / 1000);
  lastRun.set(key, now);
  if (lastRun.size > 5000) lastRun.delete(lastRun.keys().next().value!);
  return 0;
}

const DISCORD_PATH = /^\/api\/(?:leagues\/([a-z0-9][a-z0-9-]{0,63})(?:\/seasons\/([A-Za-z0-9][A-Za-z0-9_-]{0,80}))?|tournaments\/([A-Za-z0-9_-]{1,80}))\/discord(?:\/(test|samples|weekly-digest(?:\/post)?))?$/;

/** Is this one of the routes below (the league's own /discord/test stays with the league settings route)? */
export function discordApiPath(path: string): boolean {
  const m = DISCORD_PATH.exec(path);
  if (!m) return false;
  return !(m[1] && !m[2] && m[4] === "test");
}

export function botInviteUrl(clientId: string | undefined): string | undefined {
  const id = clientId?.trim();
  return id && /^\d{5,25}$/.test(id) ? `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${BOT_PERMISSIONS}` : undefined;
}

// ---- view ------------------------------------------------------------------------------------------------------------

export interface CompetitionDiscordView {
  kind: CompetitionKind;
  type: CompetitionType;
  name: string;
  draft: boolean;
  /** The competition's OWN webhook is set. */
  configured: boolean;
  maskedUrl: string;
  /** Posts go to the parent's webhook (the own one is blank). */
  inherited: boolean;
  parentMaskedUrl: string;
  events: Partial<DiscordEvents>;
  live: LiveMap;
  endOfGameDigest: boolean;
  comments: boolean;
  catalogue: Array<{ key: DiscordEventKey; label: string; group: "competition" | "inGame" }>;
  weekly?: WeeklyDigestSettings & { timeZone: string; timeZoneSet: boolean; weekdays: readonly string[] };
  botInviteUrl?: string;
  seasons?: Array<{ id: string; name: string }>;
}

function viewOf(t: DiscordTarget, ownUrl: string | undefined, parentUrl: string | undefined, extra: Partial<CompetitionDiscordView> = {}): CompetitionDiscordView {
  const type = typeOfKind(t.kind);
  const keys = eventKeysFor(type);
  const events: Partial<DiscordEvents> = {};
  for (const k of keys) events[k] = t.config.events[k];
  return {
    kind: t.kind, type, name: t.name, draft: t.draft,
    configured: Boolean(ownUrl), maskedUrl: maskWebhookUrl(ownUrl), inherited: !ownUrl && Boolean(parentUrl), parentMaskedUrl: maskWebhookUrl(parentUrl),
    events, live: { ...t.config.live }, endOfGameDigest: t.config.endOfGameDigest, comments: t.config.comments,
    catalogue: keys.map((k) => ({ key: k, label: DISCORD_EVENT_LABEL[k] ?? k, group: eventMeta(k).scope === "inGame" ? "inGame" as const : "competition" as const })),
    ...extra,
  };
}

// ---- patch -----------------------------------------------------------------------------------------------------------

export class DiscordSettingsError extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

export interface DiscordPatch {
  /** undefined = leave; null = clear; string = a checked webhook URL. */
  url?: string | null;
  config: CompetitionDiscordConfig;
  weekly?: WeeklyDigestSettings;
  timeZone?: string | null;
}

const bool = (v: unknown, field: string): boolean => {
  if (typeof v !== "boolean") throw new DiscordSettingsError(`${field} must be true or false.`, field);
  return v;
};

/** Validates a PATCH body against the competition type; `prior` is the stored own config (merged into). */
export function parseDiscordPatch(raw: unknown, type: CompetitionType, prior: CompetitionDiscordConfig, priorWeekly?: WeeklyDigestSettings): DiscordPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new DiscordSettingsError("Send a JSON object.");
  const b = raw as Record<string, unknown>;
  const out: DiscordPatch = { config: structuredClone(prior) };
  if (b.url !== undefined) {
    if (b.url === null || b.url === "") out.url = null;
    // The message never echoes the value: a webhook URL is a secret even when malformed.
    else if (!isDiscordWebhookUrl(b.url)) throw new DiscordSettingsError("That is not a Discord webhook URL (https://discord.com/api/webhooks/...).", "url");
    else out.url = (b.url as string).trim();
  }
  if (b.events !== undefined) {
    if (!b.events || typeof b.events !== "object" || Array.isArray(b.events)) throw new DiscordSettingsError("events must be an object.", "events");
    const e = b.events as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!(DISCORD_EVENT_KEYS as readonly string[]).includes(k) || !appliesTo(k as DiscordEventKey, type)) throw new DiscordSettingsError(`Unknown event: ${k.slice(0, 40)}.`, `events.${k.slice(0, 40)}`);
    out.config.events = { ...(out.config.events ?? {}) };
    for (const [k, v] of Object.entries(e)) out.config.events[k as DiscordEventKey] = bool(v, `events.${k}`);
  }
  if (b.live !== undefined) {
    if (!b.live || typeof b.live !== "object" || Array.isArray(b.live)) throw new DiscordSettingsError("live must be an object.", "live");
    const l = b.live as Record<string, unknown>;
    out.config.live = { ...(out.config.live ?? {}) };
    for (const [k, v] of Object.entries(l)) {
      if (!(IN_GAME_KEYS as readonly string[]).includes(k)) throw new DiscordSettingsError(`Unknown in-game event: ${k.slice(0, 40)}.`, `live.${k.slice(0, 40)}`);
      out.config.live[k as keyof LiveMap] = bool(v, `live.${k}`);
    }
  }
  if (b.endOfGameDigest !== undefined) out.config.endOfGameDigest = bool(b.endOfGameDigest, "endOfGameDigest");
  if (b.comments !== undefined) out.config.comments = bool(b.comments, "comments");
  if (b.weekly !== undefined) {
    if (!priorWeekly) throw new DiscordSettingsError("The Weekly Digest is a league setting.", "weekly");
    try { out.weekly = parseWeekly(b.weekly, priorWeekly); } catch (e) { throw new DiscordSettingsError((e as Error).message, "weekly"); }
  }
  if (b.timeZone !== undefined) {
    if (!priorWeekly) throw new DiscordSettingsError("The time zone is a league setting.", "timeZone");
    if (b.timeZone === null || b.timeZone === "") out.timeZone = null;
    else if (!isTimeZone(b.timeZone)) throw new DiscordSettingsError("Pick a time zone from the list (for example America/New_York).", "timeZone");
    else out.timeZone = b.timeZone as string;
  }
  return out;
}

// ---- auto-populate ---------------------------------------------------------------------------------------------------

/**
 * A new season starts with the league's webhook and options copied in (league ladder spec round 2: "auto-populated from
 * the league webhook on competition creation"). Nothing is overwritten. Never throws (creation must not fail on it).
 */
export function populateSeasonDiscord(store: LeagueStore, leagueId: string, seasonId: string): void {
  try {
    const league = store.league(leagueId);
    if (!league) return;
    const key = seasonCompetitionKey(seasonId);
    const secrets = store.secrets(leagueId);
    if (secrets.discordWebhookUrl && !secrets.competitionWebhooks?.[key]) {
      store.setSecrets(leagueId, { ...secrets, competitionWebhooks: { ...(secrets.competitionWebhooks ?? {}), [key]: secrets.discordWebhookUrl } });
    }
    if (!league.competitionDiscord?.[key]) {
      const base = leagueTarget(store, league).config;
      store.updateLeague(leagueId, (l) => { l.competitionDiscord = { ...(l.competitionDiscord ?? {}), [key]: freeze(base) }; });
    }
  } catch { /* best effort */ }
}

const freeze = (c: EffectiveDiscordConfig): CompetitionDiscordConfig => {
  const events: Partial<DiscordEvents> = {};
  for (const k of DISCORD_EVENT_KEYS) events[k] = c.events[k];
  return { events, live: { ...c.live }, endOfGameDigest: c.endOfGameDigest, comments: c.comments };
};

// ---- routes ----------------------------------------------------------------------------------------------------------

interface Resolved {
  target: DiscordTarget;
  ownUrl?: string;
  parentUrl?: string;
  league?: LeagueRecord;
  seasonId?: string;
  tournament?: TournamentRecord;
}

function resolve(m: RegExpExecArray, auth: DiscordApiIdentity | undefined, deps: DiscordApiDeps): Resolved | DiscordApiResult {
  if (!auth) return fail(401, "Sign in to manage this competition.");
  if (m[3]) {
    const t = deps.tournaments.tournament(m[3]);
    if (!t) return fail(404, "Tournament not found.");
    const manager = auth.admin === true || isTournamentManager(t, auth.coach);
    if (!manager) return t.unpublished ? fail(404, "Tournament not found.") : fail(403, "Only this tournament's organisers and site admins can change its Discord settings.");
    const own = deps.state.webhook(`tournament:${t.id}`);
    const parent = t.seriesId ? deps.state.webhook(`series:${t.seriesId}`) : undefined;
    return { target: tournamentTarget(deps.state, t), ...(own ? { ownUrl: own } : {}), ...(parent ? { parentUrl: parent } : {}), tournament: t };
  }
  const league = deps.leagues.league(m[1]!);
  if (!league) return fail(404, "League not found.");
  if (!managesLeague(league, auth)) return isDraftLeague(league) ? fail(404, "League not found.") : fail(403, "Only this league's organisers and site admins can change its Discord settings.");
  const secrets = deps.leagues.secrets(league.id);
  if (m[2]) {
    if (!deps.leagues.season(league.id, m[2])) return fail(404, "Season not found.");
    const own = secrets.competitionWebhooks?.[seasonCompetitionKey(m[2])];
    return { target: seasonTarget(deps.leagues, league, m[2]), ...(own ? { ownUrl: own } : {}), ...(secrets.discordWebhookUrl ? { parentUrl: secrets.discordWebhookUrl } : {}), league, seasonId: m[2] };
  }
  return { target: leagueTarget(deps.leagues, league), ...(secrets.discordWebhookUrl ? { ownUrl: secrets.discordWebhookUrl } : {}), league };
}

function viewFor(r: Resolved, deps: DiscordApiDeps): CompetitionDiscordView {
  if (r.league && !r.seasonId) {
    const invite = botInviteUrl(deps.clientId);
    return viewOf(r.target, r.ownUrl, undefined, {
      weekly: { ...weeklyOf(r.league.weeklyDigest), timeZone: leagueTimeZone(r.league), timeZoneSet: leagueTimeZoneSet(r.league), weekdays: WEEKDAYS },
      ...(invite ? { botInviteUrl: invite } : {}),
      seasons: deps.leagues.seasons(r.league.id).map((s) => ({ id: s.id, name: s.name })),
    });
  }
  return viewOf(r.target, r.ownUrl, r.parentUrl);
}

function ownConfig(r: Resolved, deps: DiscordApiDeps): CompetitionDiscordConfig {
  if (r.tournament) return deps.state.config(`tournament:${r.tournament.id}`) ?? {};
  if (r.seasonId) return r.league!.competitionDiscord?.[seasonCompetitionKey(r.seasonId)] ?? {};
  return { ...(r.league!.discord ?? {}), ...(r.league!.discordEvents ? { events: r.league!.discordEvents } : {}) };
}

function applyPatch(r: Resolved, p: DiscordPatch, deps: DiscordApiDeps): void {
  if (r.tournament) {
    const key = `tournament:${r.tournament.id}`;
    if (p.url !== undefined) deps.state.setWebhook(key, p.url);
    deps.state.setConfig(key, p.config);
    return;
  }
  const leagueId = r.league!.id;
  if (p.url !== undefined) {
    const secrets = deps.leagues.secrets(leagueId);
    if (r.seasonId) {
      const hooks = { ...(secrets.competitionWebhooks ?? {}) };
      if (p.url === null) delete hooks[seasonCompetitionKey(r.seasonId)]; else hooks[seasonCompetitionKey(r.seasonId)] = p.url;
      deps.leagues.setSecrets(leagueId, { ...secrets, competitionWebhooks: hooks });
    } else {
      if (p.url === null) delete secrets.discordWebhookUrl; else secrets.discordWebhookUrl = p.url;
      deps.leagues.setSecrets(leagueId, secrets);
    }
  }
  deps.leagues.updateLeague(leagueId, (l) => {
    if (r.seasonId) {
      l.competitionDiscord = { ...(l.competitionDiscord ?? {}), [seasonCompetitionKey(r.seasonId)]: p.config };
      return;
    }
    if (p.config.events) {
      const full = leagueTarget(deps.leagues, l).config.events;
      l.discordEvents = { ...full, ...(p.config.events as DiscordEvents) };
    }
    const { events: _e, ...rest } = p.config;
    l.discord = rest;
    if (p.weekly) l.weeklyDigest = p.weekly;
    if (p.timeZone !== undefined) { if (p.timeZone === null) delete l.timeZone; else l.timeZone = p.timeZone; }
  });
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function discordApi(method: string, path: string, auth: DiscordApiIdentity | undefined, body: unknown, deps: DiscordApiDeps): Promise<DiscordApiResult | undefined> {
  const m = DISCORD_PATH.exec(path);
  if (!m || !discordApiPath(path)) return undefined;
  const action = m[4];
  const read = method === "GET" || method === "HEAD";
  if (action === undefined && !read && method !== "PATCH") return fail(405, "Use GET or PATCH.");
  if ((action === "test" || action === "samples" || action === "weekly-digest/post") && method !== "POST") return fail(405, "Use POST.");
  if (action === "weekly-digest" && !read) return fail(405, "Use GET.");
  const r = resolve(m, auth, deps);
  if ("status" in r) return r;
  const now = (deps.now?.() ?? new Date()).getTime();
  const poster = deps.poster ?? defaultPoster;
  const who = auth!;

  if (action === undefined) {
    if (read) return res(200, { discord: viewFor(r, deps) });
    let patch: DiscordPatch;
    try {
      patch = parseDiscordPatch(body, typeOfKind(r.target.kind), ownConfig(r, deps), r.league && !r.seasonId ? weeklyOf(r.league.weeklyDigest) : undefined);
    } catch (e) {
      if (e instanceof DiscordSettingsError) return fail(400, e.message, e.field);
      throw e;
    }
    try { applyPatch(r, patch, deps); } catch { return fail(500, "Could not save the Discord settings right now."); }
    const again = resolve(m, auth, deps);
    return "status" in again ? again : res(200, { ok: true, discord: viewFor(again, deps) });
  }

  if (action === "weekly-digest" || action === "weekly-digest/post") {
    if (!r.league || r.seasonId) return fail(404, "Not found.");
    if (!deps.observer) return fail(503, "The Weekly Digest is not available right now.");
    const period = deps.observer.previewPeriod(r.league);
    const d = await deps.observer.digestFor(r.league, period.from, period.to);
    if (action === "weekly-digest") return res(200, { preview: d.payload ?? null, reason: d.reason ?? null, period: { from: new Date(d.from).toISOString(), to: new Date(d.to).toISOString() } });
    if (r.target.draft) return fail(409, "Publish the league first: a draft never posts to Discord.");
    if (!r.target.url) return fail(409, "Set a Discord webhook URL first.");
    if (!d.payload) return fail(409, d.reason ?? "Nothing to post.");
    const wait = limited(`digest:${r.target.key}`, DIGEST_POST_WINDOW_MS, now);
    if (wait) return { ...fail(429, "The digest was just posted. Try again in a minute."), headers: { ...NO_STORE, "retry-after": String(wait) } };
    // The period is claimed BEFORE the send, so a scheduler tick while Discord answers never posts it again; a failed
    // send gives the claim back.
    const claim = deps.observer.claimPeriod(r.league, d.to);
    const out = await sendOne(poster, r.target.url, d.payload);
    if (!out.ok) {
      claim.release();
      return fail(502, out.status ? `Discord did not accept the post (status ${out.status}).` : "Could not reach Discord.");
    }
    return res(200, { ok: true });
  }

  // test + samples: never for drafts, need a webhook (own or inherited).
  if (r.target.draft) return fail(409, `Publish the ${r.tournament ? "tournament" : "league"} first: a draft never posts to Discord.`);
  if (!r.target.url) return fail(409, "Set a Discord webhook URL first.");
  if (action === "test") {
    const wait = limited(`test:${r.target.key}`, TEST_WINDOW_MS, now);
    if (wait) return { ...fail(429, "Too many test posts. Try again in a minute."), headers: { ...NO_STORE, "retry-after": String(wait) } };
    const out = await sendOne(poster, r.target.url, post(`[TEST] ${safe(r.target.name, 100)}: Discord connected`, `${who.coach ? safe(who.coach, 60) : "An organiser"} connected this channel. Posts for the events ticked in its Discord settings will appear here.`, 0xe8b02c, { footer: "Test post" }));
    return out.ok ? res(200, { ok: true }) : fail(502, out.status ? `Discord did not accept the test post (status ${out.status}).` : "Could not reach Discord.");
  }
  // samples
  const keys = eventKeysFor(typeOfKind(r.target.kind)).filter((k) => r.target.config.events[k]);
  if (!keys.length) return fail(409, "Tick at least one event first.");
  const wait = limited(`samples:${r.target.key}`, SAMPLE_WINDOW_MS, now);
  if (wait) return { ...fail(429, "Samples were sent recently. Try again in a few minutes."), headers: { ...NO_STORE, "retry-after": String(wait) } };
  const pause = deps.samplePauseMs ?? 600;
  const sleep = deps.sleep ?? sleepDefault;
  let posted = 0;
  let failed = 0;
  for (const [i, k] of keys.entries()) {
    if (i > 0 && pause > 0) await sleep(pause);
    const out = await sendOne(poster, r.target.url, samplePost(r.target.name, k));
    if (out.ok) posted += 1; else failed += 1;
    // Discord says slow down: stop rather than hammer it.
    if (out.status === 429) { failed += keys.length - i - 1; break; }
  }
  return res(failed && !posted ? 502 : 200, { ok: posted > 0, posted, failed, total: keys.length });
}

async function sendOne(poster: WebhookPoster, url: string, payload: DiscordPayload): Promise<{ ok: boolean; status: number }> {
  try { return await poster(url, cleanPayload(payload)); } catch { return { ok: false, status: 0 }; }
}
