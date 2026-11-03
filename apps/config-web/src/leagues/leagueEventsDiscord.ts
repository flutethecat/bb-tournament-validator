/**
 * League Events -> Discord Guild Scheduled Events: the "Create Discord events" settings (League settings -> External
 * connections) and the background sync. The REST client is src/discord/scheduledEvents.ts; the events themselves live in
 * leagueEvents.ts.
 *
 *   GET   /api/leagues/:id/events/discord            organisers: state, the servers THEY can manage, cleanup list, block reason
 *   PATCH /api/leagues/:id/events/discord            { enabled?, guildId?, channelId? }
 *   POST  /api/leagues/:id/events/discord/cleanup    "Retry cleanup": dead-lettered Discord removals go back on the queue
 *
 * Authority (the bot is SHARED by every league): a server can be picked only by an organiser whose LINKED Discord account
 * is a member there with Manage Events or Administrator (the bot reads the member and roles with its own token). The list
 * answered to an organiser holds only such servers. Every save that enables or picks a server re-checks the caller, and
 * every sync pass re-checks that at least one current organiser of the league (owner or organiser, linked Discord) still
 * has it; when none has, the sync stops for that league and Connections and the Schedule page say why. A server already
 * used by another league can be picked only by someone who manages it too (the same check).
 *
 * The sync (runLeagueEventDiscordSync) keeps one Discord event per League Event for its next occurrence, tracks earlier
 * occurrences' Discord events until they end (plus GRACE_MS) so a delete, disable, server change or move still removes
 * them, reconciles a lost create through a marker in the description instead of posting twice, never lets an older
 * generation's result clear or fail a newer one (syncGen), compares the real UTC start / end and the channel against what
 * is wanted (a time zone change or a channel change re-syncs), retries with backoff, and keeps removals that ran out of
 * retries in a dead-letter list instead of dropping them. Nothing here runs in a GET that changes anything.
 */
import { createHmac, randomBytes } from "node:crypto";
import {
  botPermitsChannel, describeDiscordError, DISCORD_SYNC_MAX_ATTEMPTS, discordRetryDelayMs, DiscordEventsError, isSnowflake, MANAGE_EVENTS_PERMISSION, permitsChannelEvents, permitsEvents,
  type ChannelSummary, type GuildEventsClient, type GuildSummary, type ScheduledEventBody,
} from "../discord/scheduledEvents.js";
import { starProfanity } from "../discord/profanity.js";
import type { LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { readJsonObject } from "./http.js";
import {
  gate, kick, LEAGUE_EVENT_TYPE_LABEL, markSync, occurrences, readFile, repeatText, type LeagueEventRouteDeps, type Occurrence,
} from "./leagueEvents.js";
import { isDraftLeague, publishedLeagues } from "./lifecycle.js";
import type { LeagueStore } from "./store.js";
import { leagueTimeZone } from "./timeZone.js";
import type { DiscordDeadLetter, DiscordMirror, LeagueCalendarEvent, LeagueEventsFile, LeagueRecord, PendingDiscordDelete } from "./types.js";

export const ADD_BOT_TEXT = "Add the Super FUMBBL bot to your server to create Discord events";
export const LINK_DISCORD_TEXT = "Link your Discord account (Account page) to pick a server you manage";
/** A Discord event of an occurrence under way is tracked this long after it ends. */
export const GRACE_MS = 60 * 60_000;
/** Servers checked for the picker (the bot may be in many league servers). */
const PICKER_GUILDS_MAX = 100;

const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): LeagueApiResult => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The bot invite for scheduled events: the usual permissions plus Manage Events. */
export function eventsBotInviteUrl(clientId: string | undefined): string | undefined {
  const id = clientId?.trim();
  if (!id || !/^\d{5,25}$/.test(id)) return undefined;
  const permissions = BigInt(1024 + 2048 + 16384) + BigInt(MANAGE_EVENTS_PERMISSION);
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${permissions.toString()}`;
}

// ---- authority ------------------------------------------------------------------------------------------------------------

/** Can this Discord user manage events in this server (Manage Events or Administrator)? Throws when Discord does not answer. */
export async function userCanManageEvents(guild: GuildEventsClient, guildId: string, userId: string | undefined): Promise<boolean> {
  if (!userId || !isSnowflake(userId) || !isSnowflake(guildId)) return false;
  const perms = await guild.memberPermissions(guildId, userId);
  return perms !== null && permitsEvents(perms);
}

const leagueManagers = (league: Pick<LeagueRecord, "owner" | "organisers">): string[] => {
  const seen = new Set<string>();
  return [league.owner ?? "", ...league.organisers].map((c) => c.trim()).filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()));
};

/** Can this user hold events in this channel: EFFECTIVE channel permissions (overwrites included) allow managing events
 *  and seeing it? */
export async function userCanUseChannel(guild: GuildEventsClient, guildId: string, channelId: string, userId: string): Promise<boolean> {
  const perms = await guild.channelPermissions(guildId, channelId, userId);
  return perms !== null && permitsChannelEvents(perms);
}

/** Can the bot itself manage events in the server and, when a channel is picked, see, connect to and manage events there? */
export async function botCanUse(guild: GuildEventsClient, guildId: string, channelId?: string): Promise<boolean> {
  const bot = await guild.botUserId();
  const base = await guild.memberPermissions(guildId, bot);
  if (base === null || !permitsEvents(base)) return false;
  if (!channelId) return true;
  const ch = await guild.channelPermissions(guildId, channelId, bot);
  return ch !== null && botPermitsChannel(ch);
}

/**
 * Does any current organiser of the league (owner or organiser) have a linked Discord account that can manage events in
 * the server (and, when a voice / stage channel is picked, in that channel by its EFFECTIVE permissions)? And can the bot?
 * `reason` says why not. Throws when Discord does not answer (a transient outage never blocks a league).
 */
export async function leagueAuthority(
  league: LeagueRecord, guildId: string, guild: GuildEventsClient, discordUserId: ((coach: string) => string | undefined) | undefined, channelId?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let linked = 0;
  let inServer = 0;
  for (const coach of leagueManagers(league)) {
    const uid = discordUserId?.(coach);
    if (!uid || !isSnowflake(uid)) continue;
    linked += 1;
    if (!(await userCanManageEvents(guild, guildId, uid))) continue;
    inServer += 1;
    if (channelId && !(await userCanUseChannel(guild, guildId, channelId, uid))) continue;
    if (!(await botCanUse(guild, guildId, channelId))) {
      return { ok: false, reason: `Discord events stopped: the Super FUMBBL bot can't manage events ${channelId ? "in the picked channel (it needs View Channel, Connect and Manage Events)" : "in that server (Manage Events)"}.` };
    }
    return { ok: true };
  }
  return {
    ok: false,
    reason: !linked
      ? "Discord events stopped: no organiser of this league has a linked Discord account."
      : inServer && channelId
        ? "Discord events stopped: no organiser of this league can manage events in the picked voice channel any more."
        : "Discord events stopped: no organiser of this league can manage events in that Discord server any more (Manage Events or Administrator).",
  };
}

/** Removes a Discord event only when Discord says the BOT created it ("foreign" = someone else's: never touched). */
export async function removeOurs(guild: GuildEventsClient, guildId: string, eventId: string): Promise<"removed" | "gone" | "foreign"> {
  const bot = await guild.botUserId();
  const e = await guild.getEvent(guildId, eventId);
  if (!e) return "gone";
  if (e.creatorId !== bot) return "foreign";
  try { await guild.remove(guildId, eventId); } catch (err) { if (err instanceof DiscordEventsError && err.gone) return "gone"; throw err; }
  return "removed";
}

// ---- the payload ----------------------------------------------------------------------------------------------------------

/** The marker key when none is configured (tests; the server passes LEAGUE_EVENTS_MARKER_KEY or one derived from the bot token). */
const PROCESS_MARKER_KEY = randomBytes(32).toString("hex");

/**
 * The marker a Discord event carries in its description, so a create whose answer was lost is found, not posted twice. It is
 * an HMAC of the league, League Event and occurrence under a server secret, so nobody can forge one; and an event is only
 * adopted when Discord also says the bot created it.
 */
export function syncMarker(key: string | undefined, leagueId: string, eventId: string, occurrence: string): string {
  const mac = createHmac("sha256", key || PROCESS_MARKER_KEY).update(`${leagueId}\0${eventId}\0${occurrence}`).digest("base64url").slice(0, 22);
  return `[sf:${mac}]`;
}

/** The Discord scheduled event for one occurrence (names and descriptions starred; Discord's own length limits). */
export function scheduledEventBody(ev: LeagueCalendarEvent, o: Occurrence, league: Pick<LeagueRecord, "name">, cfg: LeagueRecord["scheduledEvents"], marker: string): ScheduledEventBody {
  const star = (s: string): string => starProfanity(s);
  const desc = [`${LEAGUE_EVENT_TYPE_LABEL[ev.type]} · ${league.name}`, ev.recurrence ? repeatText(ev.recurrence) : "", ev.description].filter(Boolean).join("\n\n");
  const channelId = cfg?.channelId;
  const inChannel = ev.location.kind === "online" && isSnowflake(channelId);
  const where = ev.location.text || (ev.location.kind === "online" ? "Online" : league.name);
  return {
    name: clip(star(ev.title), 100),
    description: `${clip(star(desc), 1000 - marker.length - 2)}\n\n${marker}`,
    scheduled_start_time: new Date(o.start).toISOString(),
    scheduled_end_time: new Date(o.end).toISOString(),
    privacy_level: 2,
    // 1 = stage channel, 2 = voice channel, 3 = external (a venue, or online without a channel)
    entity_type: inChannel ? (cfg?.channelType === "stage" ? 1 : 2) : 3,
    channel_id: inChannel ? channelId! : null,
    entity_metadata: inChannel ? null : { location: clip(star(where), 100) },
  };
}

// ---- settings -------------------------------------------------------------------------------------------------------------

export interface DiscordEventsSettingsView {
  /** The bot token is set (the site can talk to Discord as the bot). */
  available: boolean;
  /** "Add the Super FUMBBL bot to your server" (with Manage Events). */
  inviteUrl?: string;
  enabled: boolean;
  /** The picked server, only when the caller can manage it (else boundToOther). */
  guildId?: string;
  channelId?: string;
  /** A server is picked that the caller cannot manage (another organiser picked it). */
  boundToOther: boolean;
  /** The caller has a linked Discord account. */
  linked: boolean;
  /** Servers the bot is in AND the caller can manage events in. Never any other. */
  guilds: GuildSummary[];
  /** Voice / stage channels of the picked server (only when the caller can manage it). */
  channels: ChannelSummary[];
  /** The sync stopped, and why. */
  blocked?: string;
  /** Discord removals that ran out of retries ("Retry cleanup"). */
  cleanup: Array<{ eventId: string; title: string; error: string; at: string }>;
  error?: string;
  notice: string;
}

async function manageableGuilds(guild: GuildEventsClient, userId: string): Promise<GuildSummary[]> {
  const all = (await guild.guilds()).slice(0, PICKER_GUILDS_MAX);
  const out: GuildSummary[] = [];
  for (let i = 0; i < all.length; i += 5) {
    const chunk = all.slice(i, i + 5);
    const ok = await Promise.all(chunk.map((g) => userCanManageEvents(guild, g.id, userId).catch(() => false)));
    chunk.forEach((g, n) => { if (ok[n]) out.push(g); });
  }
  return out;
}

async function settingsView(league: LeagueRecord, auth: LeagueApiIdentity, deps: LeagueEventRouteDeps): Promise<DiscordEventsSettingsView> {
  const guild = deps.leagueEvents?.guild;
  const cfg = league.scheduledEvents;
  const invite = eventsBotInviteUrl(deps.leagueEvents?.clientId);
  let cleanup: DiscordEventsSettingsView["cleanup"] = [];
  try { cleanup = (readFile(deps.store, league.id).discordDeadLetters ?? []).map((d) => ({ eventId: d.eventId, title: d.title ?? "League event", error: d.error, at: d.at })); } catch { /* none shown */ }
  const uid = deps.leagueEvents?.discordUserId?.(auth.coach);
  const linked = Boolean(uid && isSnowflake(uid));
  const base = {
    available: Boolean(guild), ...(invite ? { inviteUrl: invite } : {}), enabled: cfg?.enabled === true, linked, cleanup,
    ...(cfg?.blocked ? { blocked: cfg.blocked.reason } : {}),
  };
  if (!guild) return { ...base, boundToOther: Boolean(cfg?.guildId), guilds: [], channels: [], notice: ADD_BOT_TEXT };
  if (!linked) return { ...base, boundToOther: Boolean(cfg?.guildId), guilds: [], channels: [], notice: LINK_DISCORD_TEXT };
  let guilds: GuildSummary[] = [];
  let channels: ChannelSummary[] = [];
  let error: string | undefined;
  try {
    guilds = await manageableGuilds(guild, uid!);
    if (cfg?.guildId && guilds.some((g) => g.id === cfg.guildId)) channels = await guild.channels(cfg.guildId);
  } catch (e) { error = describeDiscordError(e); }
  const mine = Boolean(cfg?.guildId && guilds.some((g) => g.id === cfg.guildId));
  const notice = !guilds.length && !error ? `${ADD_BOT_TEXT}. Only servers where you can manage events are listed.` : "";
  return {
    ...base, ...(mine ? { guildId: cfg!.guildId, ...(cfg?.channelId ? { channelId: cfg.channelId } : {}) } : {}),
    boundToOther: Boolean(cfg?.guildId && !mine), guilds, channels, ...(error ? { error } : {}), notice,
  };
}

/** Routes this module owns (events/discord, events/discord/cleanup); undefined = not one of them. */
export async function leagueEventsDiscordRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueEventRouteDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, third, ...more] = rest;
  if (first !== "events" || second !== "discord" || more.length) return undefined;
  if (third === "cleanup") return cleanupRoute(method, league, auth, deps);
  if (third !== undefined) return fail(404, "Not found.");
  const read = method === "GET" || method === "HEAD";
  if (!read && method !== "PATCH") return fail(405, "Use GET or PATCH.");
  const early = gate(league, auth);
  if (early) return early;
  if (read) return res(200, { discordEvents: await settingsView(league!, auth!, deps) });
  const body = await readJsonObject(deps, 4096);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const b = body.value;
  const guild = deps.leagueEvents?.guild;
  const prior = deps.store.league(league!.id)?.scheduledEvents ?? { enabled: false };
  const next: NonNullable<LeagueRecord["scheduledEvents"]> = { ...prior };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return fail(400, "enabled must be true or false.", { field: "enabled" });
    next.enabled = b.enabled;
  }
  if (b.guildId !== undefined) {
    if (b.guildId === null || b.guildId === "") { delete next.guildId; delete next.channelId; delete next.channelType; }
    else if (!isSnowflake(b.guildId)) return fail(400, "Pick one of your servers.", { field: "guildId" });
    else { if (next.guildId !== b.guildId) { delete next.channelId; delete next.channelType; } next.guildId = b.guildId; }
  }
  if (b.channelId !== undefined) {
    if (b.channelId === null || b.channelId === "") { delete next.channelId; delete next.channelType; }
    else if (!isSnowflake(b.channelId)) return fail(400, "Pick a voice or stage channel, or none.", { field: "channelId" });
    else next.channelId = b.channelId;
  }
  if (next.enabled && !guild) return fail(409, `${ADD_BOT_TEXT}.`, { field: "enabled" });
  if (next.enabled && !next.guildId) return fail(400, "Pick the Discord server the events go to.", { field: "guildId" });
  // Proof of authority on EVERY save that leaves Discord events on in a server: the caller's linked account manages events
  // there (turning the option off, or clearing the server, needs no Discord permission).
  if (next.enabled && next.guildId && guild) {
    const uid = deps.leagueEvents?.discordUserId?.(auth!.coach);
    if (!uid || !isSnowflake(uid)) return fail(403, `${LINK_DISCORD_TEXT}.`, { field: "guildId" });
    try {
      if (!(await guild.guilds()).some((g) => g.id === next.guildId)) return fail(400, "The Super FUMBBL bot is not in that server. Add it first.", { field: "guildId" });
      if (!(await userCanManageEvents(guild, next.guildId, uid))) return fail(403, "You can only pick a server where your Discord account can manage events (Manage Events or Administrator).", { field: "guildId" });
      if (next.channelId) {
        const ch = (await guild.channels(next.guildId)).find((c) => c.id === next.channelId);
        if (!ch) return fail(400, "That voice channel is not in the server.", { field: "channelId" });
        // effective channel permissions (role and member overwrites count), for the organiser and for the bot
        if (!(await userCanUseChannel(guild, next.guildId, next.channelId, uid))) return fail(403, "Your Discord account can't manage events in that channel.", { field: "channelId" });
        if (!(await botCanUse(guild, next.guildId, next.channelId))) return fail(400, "The Super FUMBBL bot can't use that channel: it needs View Channel, Connect and Manage Events there.", { field: "channelId" });
        next.channelType = ch.type;
      } else if (!(await botCanUse(guild, next.guildId))) {
        return fail(400, "The Super FUMBBL bot can't manage events in that server: give it the Manage Events permission.", { field: "guildId" });
      }
    } catch (e) {
      return fail(502, describeDiscordError(e));
    }
    delete next.blocked; // a manager just proved authority
  }
  // Re-read after the Discord checks, then write synchronously.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const changed = JSON.stringify(prior) !== JSON.stringify(next);
  const updated = deps.store.updateLeague(lg.id, (l) => { l.scheduledEvents = next; });
  if (changed) {
    try {
      const file = readFile(deps.store, lg.id);
      const iso = (deps.now?.() ?? new Date()).toISOString();
      for (const ev of file.events) markSync(ev, updated, iso); // created in the new server, moved, or removed when off
      if (next.enabled && !next.blocked) requeueDeadLetters(file, iso); // authority is back: retry the stuck cleanups
      deps.store.putLeagueEvents(lg.id, file);
    } catch { /* the events re-sync on the next pass (drift) */ }
    kick(deps);
  }
  return res(200, { ok: true, discordEvents: await settingsView(updated, auth!, deps) });
}

function requeueDeadLetters(file: LeagueEventsFile, iso: string): void {
  const dead = file.discordDeadLetters ?? [];
  if (!dead.length) return;
  file.discordDeletes = [...(file.discordDeletes ?? []), ...dead.map((d) => ({ guildId: d.guildId, eventId: d.eventId, attempts: 0, nextAt: iso, ...(d.title ? { title: d.title } : {}) }))];
  delete file.discordDeadLetters;
}

async function cleanupRoute(method: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueEventRouteDeps): Promise<LeagueApiResult> {
  if (method !== "POST") return fail(405, "Use POST.");
  const early = gate(league, auth);
  if (early) return early;
  const body = await readJsonObject(deps, 1024);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const lg = deps.store.league(league!.id);
  if (!lg) return fail(404, "League not found.");
  let count = 0;
  try {
    const file = readFile(deps.store, lg.id);
    count = file.discordDeadLetters?.length ?? 0;
    requeueDeadLetters(file, (deps.now?.() ?? new Date()).toISOString());
    if (count) deps.store.putLeagueEvents(lg.id, file);
  } catch { return fail(500, "The league's events could not be read."); }
  if (count) kick(deps);
  return res(200, { ok: true, requeued: count });
}

// ---- the sync -------------------------------------------------------------------------------------------------------------

export interface DiscordSyncDeps {
  store: LeagueStore;
  guild?: GuildEventsClient;
  /** A coach's linked Discord id (the league's organisers are re-checked every pass). */
  discordUserId?: (coach: string) => string | undefined;
  /** LEAGUE_EVENTS_MARKER_KEY (or a key derived from the bot token): signs the sync marker. Absent = a per-process key. */
  markerKey?: string;
  now?: () => Date;
}

/** How often a dead-lettered cleanup is re-checked against the bot's permission (requeued once the bot can manage events). */
export const DEAD_LETTER_CHECK_MS = 60 * 60_000;

export interface DiscordSyncOutcome { created: string[]; updated: string[]; deleted: string[]; failed: string[]; adopted: string[]; blocked: string[]; skipped: string[] }

const due = (nextAt: string | undefined, now: number): boolean => !nextAt || Date.parse(nextAt) <= now;
const sameMirror = (a: DiscordMirror, b: Omit<DiscordMirror, "eventId">): boolean =>
  a.guildId === b.guildId && a.occurrence === b.occurrence && a.start === b.start && a.end === b.end && (a.channelId ?? "") === (b.channelId ?? "");

/** Read-modify-write of a league's events file on a FRESH read (synchronous: nothing interleaves). */
function commit(store: LeagueStore, leagueId: string, mutate: (f: LeagueEventsFile) => void): void {
  try {
    const f = store.leagueEvents(leagueId);
    mutate(f);
    store.putLeagueEvents(leagueId, f);
  } catch { /* unreadable or gone: the next pass tries again */ }
}

function setBlocked(store: LeagueStore, leagueId: string, reason: string | undefined, iso: string): void {
  const lg = store.league(leagueId);
  if (!lg?.scheduledEvents) return;
  const was = lg.scheduledEvents.blocked?.reason;
  if (was === reason) return;
  store.updateLeague(leagueId, (l) => {
    if (!l.scheduledEvents) return;
    if (reason) l.scheduledEvents.blocked = { reason, at: iso }; else delete l.scheduledEvents.blocked;
  });
}

/**
 * One pass over every published league that uses (or used) Discord events. Per league: the authority check for its server,
 * pending removals (dead-lettered when out of retries), then each event: drift between what is wanted (the next occurrence,
 * its real UTC start / end, the channel, the server) and what Discord has, plus anything queued. Discord calls happen
 * outside the file write; every result is committed onto a fresh read and applied only for the generation it was made for.
 */
export async function runLeagueEventDiscordSync(deps: DiscordSyncDeps): Promise<DiscordSyncOutcome> {
  const out: DiscordSyncOutcome = { created: [], updated: [], deleted: [], failed: [], adopted: [], blocked: [], skipped: [] };
  const guild = deps.guild;
  if (!guild) return out;
  const nowAt = () => deps.now?.() ?? new Date();
  for (const listed of publishedLeagues(deps.store.list())) {
    const league = deps.store.league(listed.id);
    if (!league || isDraftLeague(league)) continue;
    let file: LeagueEventsFile;
    try { file = deps.store.leagueEvents(league.id); } catch { continue; }
    const tracked = file.events.some((e) => e.discord || e.discordLive?.length || e.discordSync);
    if (!league.scheduledEvents?.enabled && !tracked && !file.discordDeletes?.length && !file.discordDeadLetters?.length) continue;
    const zone = leagueTimeZone(league);
    const cfg = league.scheduledEvents;
    const active = Boolean(cfg?.enabled && isSnowflake(cfg.guildId));

    // authority, per server, once per pass (a Discord outage = skip, never block)
    const authority = new Map<string, { ok: true } | { ok: false; reason: string } | "unknown">();
    const authorityFor = async (guildId: string) => {
      if (!authority.has(guildId)) {
        const channel = guildId === cfg?.guildId && cfg?.channelId ? cfg.channelId : undefined;
        try { authority.set(guildId, await leagueAuthority(league, guildId, guild, deps.discordUserId, channel)); } catch { authority.set(guildId, "unknown"); }
      }
      return authority.get(guildId)!;
    };
    // 0. dead-lettered cleanups: re-checked (hourly, even with the connection off) and requeued once the bot can manage
    //    events in that server again. Removing only ever touches events the bot created (removeOurs).
    const deadChecks = new Map<string, boolean>();
    for (const d of file.discordDeadLetters ?? []) {
      if (d.checkedAt && nowAt().getTime() - Date.parse(d.checkedAt) < DEAD_LETTER_CHECK_MS) continue;
      if (!deadChecks.has(d.guildId)) { try { deadChecks.set(d.guildId, await botCanUse(guild, d.guildId)); } catch { /* unknown: next pass */ } }
    }
    if (deadChecks.size) commit(deps.store, league.id, (f) => {
      const iso = nowAt().toISOString();
      const keep: DiscordDeadLetter[] = [];
      for (const d of f.discordDeadLetters ?? []) {
        const ok = deadChecks.get(d.guildId);
        if (ok === true) f.discordDeletes = [...(f.discordDeletes ?? []), { guildId: d.guildId, eventId: d.eventId, attempts: 0, nextAt: iso, ...(d.title ? { title: d.title } : {}) }];
        else keep.push(ok === false ? { ...d, checkedAt: iso } : d);
      }
      if (keep.length) f.discordDeadLetters = keep; else delete f.discordDeadLetters;
    });
    if (deadChecks.size) { try { file = deps.store.leagueEvents(league.id); } catch { continue; } }

    let leagueOk = true;
    if (active) {
      const a = await authorityFor(cfg!.guildId!);
      if (a === "unknown") leagueOk = false; // try again next pass (never mark blocked on an outage)
      else if (!a.ok) {
        setBlocked(deps.store, league.id, a.reason, nowAt().toISOString());
        out.blocked.push(league.id);
        leagueOk = false;
      } else if (cfg?.blocked) {
        setBlocked(deps.store, league.id, undefined, nowAt().toISOString());
        commit(deps.store, league.id, (f) => requeueDeadLetters(f, nowAt().toISOString())); // permission is back
        try { file = deps.store.leagueEvents(league.id); } catch { continue; }
      }
    }

    // 1. removals: always (even when stopped or turned off), and only of events the bot created
    const results = new Map<string, PendingDiscordDelete | DiscordDeadLetter | null>();
    for (const d of file.discordDeletes ?? []) {
      const now = nowAt().getTime();
      if (!due(d.nextAt, now)) continue;
      const key = `${d.guildId}:${d.eventId}`;
      let err: unknown;
      try {
        const r = await removeOurs(guild, d.guildId, d.eventId);
        results.set(key, null);
        if (r === "removed") out.deleted.push(`${league.id}:${d.eventId}`);
        if (r === "foreign") out.skipped.push(`${league.id}:${d.eventId}`);
        continue;
      } catch (e) { err = e; }
      const attempts = d.attempts + 1;
      const retry = !(err instanceof DiscordEventsError) || err.retryable;
      const error = describeDiscordError(err);
      results.set(key, retry && attempts < DISCORD_SYNC_MAX_ATTEMPTS
        ? { ...d, attempts, error, nextAt: new Date(now + discordRetryDelayMs(attempts)).toISOString() }
        : { guildId: d.guildId, eventId: d.eventId, ...(d.title ? { title: d.title } : {}), at: new Date(now).toISOString(), error });
      out.failed.push(`${league.id}:delete:${d.eventId}`);
    }
    if (results.size) commit(deps.store, league.id, (f) => {
      const dead: DiscordDeadLetter[] = [];
      f.discordDeletes = (f.discordDeletes ?? []).flatMap((d) => {
        const r = results.get(`${d.guildId}:${d.eventId}`);
        if (r === undefined) return [d];
        if (r === null) return [];
        if ("attempts" in r) return [r];
        dead.push(r);
        return [];
      });
      if (dead.length) f.discordDeadLetters = [...(f.discordDeadLetters ?? []), ...dead];
    });

    // 2. events: created / changed only while a manager has authority (a stopped league waits)
    if (!leagueOk) continue;
    for (const ev of file.events) {
      const now = nowAt().getTime();
      if (ev.discordSync?.failed) continue;
      const gen = ev.syncGen ?? 0;
      const pendingDue = ev.discordSync ? due(ev.discordSync.nextAt, now) : false;
      if (ev.discordSync && !pendingDue) continue;
      const occ = occurrences(ev, zone);
      const iso = (t: number) => new Date(t).toISOString();
      const scheduled = (m: DiscordMirror): boolean => occ.some((o) => o.key === m.occurrence && iso(o.start) === m.start);
      const next = active ? occ.find((o) => o.start > now) : undefined;
      const channelId = ev.location.kind === "online" && cfg?.channelId ? cfg.channelId : undefined;
      const want = next ? { guildId: cfg!.guildId!, occurrence: next.key, start: iso(next.start), end: iso(next.end), ...(channelId ? { channelId } : {}) } : undefined;
      const have = ev.discord;
      const live = ev.discordLive ?? [];

      const removals: DiscordMirror[] = [];
      const keepLive: DiscordMirror[] = [];
      for (const m of live) {
        if (now > Date.parse(m.end) + GRACE_MS) continue; // over: forget it
        if (!active || m.guildId !== cfg?.guildId || !scheduled(m)) removals.push(m); else keepLive.push(m);
      }
      let current = have;
      if (current) {
        const started = Date.parse(current.start) <= now;
        if (now > Date.parse(current.end) + GRACE_MS) current = undefined; // over (plus grace): forget it
        else if (started) {
          // under way: kept (tracked until it ends) while it is still on the schedule in this server, whatever comes next
          if (active && current.guildId === cfg?.guildId && scheduled(current)) keepLive.push(current); else removals.push(current);
          current = undefined;
        } else if (!want || current.guildId !== want.guildId) { removals.push(current); current = undefined; }
      }
      const needsUpdate = Boolean(want && current && !sameMirror(current, want));
      const drift = Boolean(want && !current) || needsUpdate || removals.length > 0 || keepLive.length !== live.length || (!want && Boolean(have));
      if (!pendingDue && !drift) continue;

      const queued: PendingDiscordDelete[] = [];
      let error: unknown;
      let permanent = false;
      try {
        for (const m of removals) {
          try {
            const r = await removeOurs(guild, m.guildId, m.eventId);
            if (r === "removed") out.deleted.push(`${league.id}:${m.eventId}`);
            continue;
          } catch { /* retried from the queue */ }
          queued.push({ guildId: m.guildId, eventId: m.eventId, attempts: 1, nextAt: iso(now + discordRetryDelayMs(1)), title: ev.title });
        }
        if (want && next) {
          const marker = syncMarker(deps.markerKey, league.id, ev.id, next.key);
          const body = scheduledEventBody(ev, next, league, cfg, marker);
          const createOrAdopt = async (): Promise<string> => {
            // a create whose answer was lost: find it by its (signed) marker AND Discord saying the bot created it
            const bot = await guild.botUserId();
            const found = (await guild.listEvents(want.guildId)).find((x) => x.creatorId === bot && x.description.includes(marker));
            if (found) { await guild.update(want.guildId, found.id, body); out.adopted.push(`${league.id}:${ev.id}`); return found.id; }
            const r = await guild.create(want.guildId, body);
            out.created.push(`${league.id}:${ev.id}`);
            return r.id;
          };
          let eventId: string;
          if (current) {
            try {
              eventId = (await guild.update(want.guildId, current.eventId, body)).id;
              out.updated.push(`${league.id}:${ev.id}`);
            } catch (e) {
              if (!(e instanceof DiscordEventsError && e.gone)) throw e;
              eventId = await createOrAdopt();
            }
          } else eventId = await createOrAdopt();
          current = { ...want, eventId };
        }
      } catch (e) {
        error = e;
        permanent = e instanceof DiscordEventsError && !e.retryable;
        out.failed.push(`${league.id}:${ev.id}`);
      }

      const knownIds = new Set([have?.eventId, ...live.map((m) => m.eventId)].filter(Boolean));
      commit(deps.store, league.id, (f) => {
        if (queued.length) f.discordDeletes = [...(f.discordDeletes ?? []), ...queued];
        const fresh = f.events.find((x) => x.id === ev.id);
        if (!fresh) {
          // Deleted while Discord answered: the delete route queued what it knew; remove what this pass made or kept too.
          const extra = [...(current && !knownIds.has(current.eventId) ? [current] : []), ...keepLive.filter((m) => !knownIds.has(m.eventId))];
          if (extra.length) f.discordDeletes = [...(f.discordDeletes ?? []), ...extra.map((m) => ({ guildId: m.guildId, eventId: m.eventId, attempts: 0, nextAt: iso(now), title: ev.title }))];
          return;
        }
        // What Discord now has is always recorded (so nothing is orphaned) ...
        if (error === undefined || current !== have) { if (current) fresh.discord = current; else delete fresh.discord; }
        if (keepLive.length) fresh.discordLive = keepLive; else delete fresh.discordLive;
        // ... but the queue state is touched only for the generation this pass worked on: a newer edit or settings change
        // stays queued, and an older failure never marks it failed.
        if ((fresh.syncGen ?? 0) !== gen) return;
        if (error !== undefined) {
          const attempts = (fresh.discordSync?.attempts ?? 0) + 1;
          fresh.discordSync = {
            attempts, gen, nextAt: iso(now + discordRetryDelayMs(attempts)), error: describeDiscordError(error),
            ...(permanent || attempts >= DISCORD_SYNC_MAX_ATTEMPTS ? { failed: true } : {}),
          };
        } else delete fresh.discordSync;
      });
    }
  }
  return out;
}

/**
 * The server's runner: one pass at a time; a kick during a pass runs one more pass after it. `run` resolves when the
 * pass (and any follow-up) is over; routes call `kick` and never wait.
 */
export function createDiscordSyncRunner(deps: DiscordSyncDeps & { log?: (line: string) => void }) {
  let running: Promise<void> | undefined;
  let again = false;
  const pass = async (): Promise<void> => {
    do {
      again = false;
      try {
        const r = await runLeagueEventDiscordSync(deps);
        if (r.failed.length) deps.log?.(`[league-events] Discord sync: ${r.failed.length} failed, will retry`);
      } catch (e) { deps.log?.(`[league-events] Discord sync failed: ${(e as Error).message}`); }
    } while (again);
  };
  const run = (): Promise<void> => {
    if (running) { again = true; return running; }
    running = pass().finally(() => { running = undefined; });
    return running;
  };
  return { run, kick: (): void => { void run(); } };
}
