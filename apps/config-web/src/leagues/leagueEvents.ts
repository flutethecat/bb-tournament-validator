/**
 * League Events (owner, grill round 1: "Let's add League Events where folks can input their own league nights, etc. Can we
 * wire this up to also create a discord event when created in their discord of choice?"). Organisers add league nights,
 * drafts, tournament days, socials and other events to their league; they show on the league Calendar (every view) and
 * on the organiser Schedule page, coaches get an inbox note (and an optional reminder 24 hours before), the league's
 * Discord webhook gets a "New league event" post, and, with the bot in the league's Discord server, each event keeps a
 * Discord scheduled event for its next occurrence (src/discord/scheduledEvents.ts).
 *
 *   GET    /api/leagues/:id/events                  public (a draft league answers 404 to everyone but its managers)
 *   POST   /api/leagues/:id/events                  { title, type, start, end, location, description?, link?, recurrence?, remind?, announce? }
 *   PATCH  /api/leagues/:id/events/:eventId         { revision, ...fields }   (If-Match also names the revision)
 *   DELETE /api/leagues/:id/events/:eventId         { revision } or If-Match
 *   GET    /api/leagues/:id/events/discord          organisers: "Create Discord events" state, the bot's servers / channels
 *   PATCH  /api/leagues/:id/events/discord          { enabled?, guildId?, channelId? }
 *   GET    /api/leagues/:id/schedule                organisers: upcoming League Events and gates on one timeline
 *
 * Rules:
 *  - Writes: organisers of THIS league and site admins (anonymous 401, others 403, unknown or hidden draft 404). CSRF and the
 *    onboarding gate run in front of every /api write (server.ts); no GET here changes anything (the Discord listing only
 *    reads from Discord).
 *  - Times are wall-clock times in the league zone (leagueTimeZone); a recurrence repeats the same wall-clock time every N
 *    weeks, so daylight saving never moves a league night (occurrences()).
 *  - A draft league posts nothing: notices go through the draft-aware notifier, the webhook post through postTo (drafts
 *    never post), the reminder job and the Discord sync skip drafts.
 *  - Discord scheduled events never block a save: the route only marks the event for sync and kicks the job, which retries
 *    with backoff (discordRetryDelayMs) and gives up after DISCORD_SYNC_MAX_ATTEMPTS until the next edit.
 *  - Text bound for Discord is starred (starProfanity; the webhook post also passes cleanPayload in postTo).
 */
import { randomBytes } from "node:crypto";
import type { NotificationInput } from "../notifications.js";
import { post, safe } from "../discord/posts.js";
import type { GuildEventsClient } from "../discord/scheduledEvents.js";
import { zonedInstant } from "../discord/weekly.js";
import type { LeagueApiIdentity, LeagueApiResult } from "./api.js";
import type { WebhookPoster } from "./discord.js";
import { postLeagueEvent, seasonCoaches } from "./events.js";
import { readJsonObject, requestRevision, type BodyDeps } from "./http.js";
import { isDraftLeague, managesLeague, publishedLeagues } from "./lifecycle.js";
import { LeagueStoreError, type LeagueStore } from "./store.js";
import { leagueTimeZone } from "./timeZone.js";
import {
  LEAGUE_EVENT_TYPES, type LeagueCalendarEvent, type LeagueEventsFile, type LeagueEventType, type LeagueRecord, type PendingDiscordDelete, type SeasonRecord,
} from "./types.js";

export const LEAGUE_EVENT_TYPE_LABEL: Record<LeagueEventType, string> = {
  "league-night": "League night", draft: "Draft", "tournament-day": "Tournament day", social: "Social", other: "Other",
};
export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 2000;
export const LOCATION_MAX = 200;
export const EVENTS_PER_LEAGUE_MAX = 200;
export const EVERY_WEEKS_MAX = 12;
/** A recurrence ends within two years of its first day. */
export const RECURRENCE_DAYS_MAX = 730;
/** A single occurrence lasts at most a week (a tournament weekend fits). */
export const DURATION_MAX_MS = 7 * 86_400_000;
export const REMINDER_MS = 86_400_000;
const BODY_MAX = 16 * 1024;
const MIN = 60_000;
const NO_STORE = { "cache-control": "private, no-store" };

const res = (status: number, body: unknown, headers: Record<string, string> = NO_STORE): LeagueApiResult => ({ status, body, headers: { ...headers } });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => res(status, { error, ...extra });

export class LeagueEventError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) { super(message); }
}

// ---- dates (wall-clock keys; the zone only turns them into instants) -------------------------------------------------

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n: number): string => String(n).padStart(2, "0");

function realDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y < 2200;
}

/** "2026-11-05T19:00" (seconds dropped) when it is a real wall-clock time, else undefined. */
export function parseWall(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = WALL.exec(v.trim().slice(0, 16));
  if (!m || v.trim().length > 19) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  if (!realDay(y, mo, d) || h > 23 || mi > 59) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

export function parseDay(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = DAY.exec(v.trim());
  if (!m) return undefined;
  return realDay(Number(m[1]), Number(m[2]), Number(m[3])) ? v.trim() : undefined;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const dayDiff = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The instant of a wall-clock key in the zone (a time skipped by daylight saving moves forward). */
export function wallInstant(wall: string, zone: string): number {
  const [d, t] = wall.split("T") as [string, string];
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  const [hh, mm] = t.split(":").map(Number) as [number, number];
  return zonedInstant(y, m, dd, hh, mm, zone).getTime();
}

export interface Occurrence { key: string; start: number; end: number }

/** Occurrences are capped (a two-year weekly series is 105). */
export const OCCURRENCES_MAX = 120;

/**
 * Every occurrence of an event in the league zone: the first, then every N weeks at the same wall-clock START time up to and
 * including the recurrence's last day, so a 19:00 league night stays at 19:00 local across a daylight-saving change (its
 * UTC instant moves instead). Each occurrence lasts the first one's real duration (end = start + that duration), so a start
 * the clocks skip (moved forward) can never end before it starts.
 */
export function occurrences(ev: Pick<LeagueCalendarEvent, "start" | "end" | "recurrence">, zone: string): Occurrence[] {
  const [sd, st] = ev.start.split("T") as [string, string];
  const duration = Math.max(MIN, wallInstant(ev.end, zone) - wallInstant(ev.start, zone));
  const step = ev.recurrence ? ev.recurrence.everyWeeks * 7 : 0;
  const out: Occurrence[] = [];
  for (let k = 0; k < OCCURRENCES_MAX; k++) {
    const day = addDays(sd, k * step);
    if (k > 0 && (!step || !ev.recurrence || day > ev.recurrence.until)) break;
    const key = `${day}T${st}`;
    const start = wallInstant(key, zone);
    out.push({ key, start, end: start + duration });
  }
  return out;
}

/** The first occurrence that starts after `now` (what the Discord scheduled event mirrors). */
export const nextOccurrence = (ev: Pick<LeagueCalendarEvent, "start" | "end" | "recurrence">, zone: string, now: number): Occurrence | undefined =>
  occurrences(ev, zone).find((o) => o.start > now);

/** Still to come or under way. */
const upcoming = (ev: Pick<LeagueCalendarEvent, "start" | "end" | "recurrence">, zone: string, now: number): Occurrence[] =>
  occurrences(ev, zone).filter((o) => o.end > now);

const fmt = (t: number, zone: string, opts: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat("en-GB", { timeZone: zone, ...opts }).format(new Date(t));

/** "Thu 5 Nov 2026, 19:00 to 22:00" (the end's day too when it is another day). */
export function whenText(o: Pick<Occurrence, "start" | "end">, zone: string): string {
  // "Thu 5 Nov 2026" from the parts (ICU builds differ on the commas)
  const day = (t: number) => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(new Date(t));
    const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}`;
  };
  const clock = (t: number) => fmt(t, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const sameDay = day(o.start) === day(o.end);
  return `${day(o.start)}, ${clock(o.start)} to ${sameDay ? "" : `${day(o.end)}, `}${clock(o.end)}`;
}

const dayText = (day: string): string => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(Date.UTC(y, m - 1, d)));
};

export function repeatText(r: LeagueCalendarEvent["recurrence"]): string {
  if (!r) return "";
  return `${r.everyWeeks === 1 ? "Every week" : `Every ${r.everyWeeks} weeks`} until ${dayText(r.until)}`;
}

const zoneLabel = (zone: string): string => zone.replace(/_/g, " ");

// ---- input ------------------------------------------------------------------------------------------------------------

/** Plain text: NFC, no control characters (newlines kept only where allowed), trimmed. */
function text(v: unknown, field: string, max: number, opts: { required?: boolean; multiline?: boolean; label: string }): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new LeagueEventError(400, `${opts.label} must be text.`, field);
  let s = v.normalize("NFC").replace(/\r\n?/g, "\n");
  s = opts.multiline ? s.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n") : s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  s = s.trim();
  if (opts.required && !s) throw new LeagueEventError(400, `${opts.label} is required.`, field);
  if (s.length > max) throw new LeagueEventError(400, `${opts.label} can be at most ${max} characters.`, field);
  return s;
}

const bool = (v: unknown, field: string, label: string): boolean => {
  if (typeof v !== "boolean") throw new LeagueEventError(400, `${label} must be true or false.`, field);
  return v;
};

export type LeagueEventInput = Omit<LeagueCalendarEvent, "id" | "revision" | "createdAt" | "updatedAt" | "reminded" | "discord" | "discordSync">;

/**
 * Validates a full event (a create, or a PATCH merged over the stored event). `seasons` = the league's seasons (a link
 * must name one of them; ladders are not built yet, so a ladder link is refused).
 */
export function parseLeagueEvent(raw: Record<string, unknown>, ctx: { zone: string; seasons: ReadonlyArray<Pick<SeasonRecord, "id">> }): LeagueEventInput {
  const title = text(raw.title, "title", TITLE_MAX, { required: true, label: "Title" });
  const type = raw.type === undefined ? "league-night" : raw.type;
  if (typeof type !== "string" || !(LEAGUE_EVENT_TYPES as readonly string[]).includes(type)) throw new LeagueEventError(400, "Pick a type: League night, Draft, Tournament day, Social or Other.", "type");
  const start = parseWall(raw.start);
  if (!start) throw new LeagueEventError(400, "Start must be a date and time (2026-11-05T19:00).", "start");
  const end = parseWall(raw.end);
  if (!end) throw new LeagueEventError(400, "End must be a date and time (2026-11-05T22:00).", "end");
  const t0 = wallInstant(start, ctx.zone);
  const t1 = wallInstant(end, ctx.zone);
  if (t1 <= t0) throw new LeagueEventError(400, "End must be after the start.", "end");
  if (t1 - t0 > DURATION_MAX_MS) throw new LeagueEventError(400, "An event can last at most 7 days.", "end");

  const loc = raw.location === undefined || raw.location === null ? { kind: "venue", text: "" } : raw.location;
  if (!loc || typeof loc !== "object" || Array.isArray(loc)) throw new LeagueEventError(400, "Location must be a venue or online.", "location");
  const kind = (loc as { kind?: unknown }).kind;
  if (kind !== "venue" && kind !== "online") throw new LeagueEventError(400, "Location must be a venue or online.", "location.kind");
  const where = text((loc as { text?: unknown }).text, "location.text", LOCATION_MAX, { label: kind === "venue" ? "Venue" : "Online details" });
  if (kind === "online" && /^[a-z][a-z0-9+.-]*:/i.test(where) && !/^https:\/\/\S+$/i.test(where)) throw new LeagueEventError(400, "An online link must start with https://.", "location.text");

  const description = text(raw.description, "description", DESCRIPTION_MAX, { multiline: true, label: "Description" });

  let link: LeagueCalendarEvent["link"];
  if (raw.link !== undefined && raw.link !== null && raw.link !== "") {
    const l = raw.link as { kind?: unknown; id?: unknown };
    if (!l || typeof l !== "object" || (l.kind !== "season" && l.kind !== "ladder") || typeof l.id !== "string") throw new LeagueEventError(400, "Link a season of this league, or none.", "link");
    if (l.kind === "ladder") throw new LeagueEventError(400, "This league has no ladders yet.", "link");
    if (!ctx.seasons.some((s) => s.id === l.id)) throw new LeagueEventError(400, "That season is not in this league.", "link");
    link = { kind: "season", id: l.id };
  }

  let recurrence: LeagueCalendarEvent["recurrence"];
  if (raw.recurrence !== undefined && raw.recurrence !== null) {
    const r = raw.recurrence as { everyWeeks?: unknown; until?: unknown };
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new LeagueEventError(400, "Repeat must name every how many weeks and until when.", "recurrence");
    const n = r.everyWeeks;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > EVERY_WEEKS_MAX) throw new LeagueEventError(400, `Repeat every 1 to ${EVERY_WEEKS_MAX} weeks.`, "recurrence.everyWeeks");
    const until = parseDay(r.until);
    if (!until) throw new LeagueEventError(400, "Repeat until must be a date (2026-12-17).", "recurrence.until");
    const first = start.slice(0, 10);
    if (until < first) throw new LeagueEventError(400, "Repeat until must be on or after the first day.", "recurrence.until");
    if (dayDiff(first, until) > RECURRENCE_DAYS_MAX) throw new LeagueEventError(400, "A repeating event can run for at most two years.", "recurrence.until");
    recurrence = { everyWeeks: n, until };
  }

  // every occurrence is checked, not just the first: each one ends after it starts and after the one before it starts
  const occ = occurrences({ start, end, ...(recurrence ? { recurrence } : {}) }, ctx.zone);
  occ.forEach((o, i) => {
    if (o.end <= o.start || (i > 0 && o.start <= occ[i - 1]!.start)) throw new LeagueEventError(400, `The date on ${o.key.slice(0, 10)} does not work in the league's time zone.`, recurrence ? "recurrence" : "start");
  });
  const remind = raw.remind === undefined ? true : bool(raw.remind, "remind", "Reminder");
  const announce = raw.announce === undefined ? type === "league-night" : bool(raw.announce, "announce", "Post to Discord");
  return {
    title, type: type as LeagueEventType, start, end, location: { kind, text: where }, description,
    ...(link ? { link } : {}), ...(recurrence ? { recurrence } : {}), remind, announce,
  };
}

/** The fields a PATCH may send, merged over the stored event before parseLeagueEvent checks the whole. */
const PATCHABLE = ["title", "type", "start", "end", "location", "description", "link", "recurrence", "remind", "announce"] as const;

function merged(ev: LeagueCalendarEvent, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {
    title: ev.title, type: ev.type, start: ev.start, end: ev.end, location: ev.location, description: ev.description,
    link: ev.link ?? null, recurrence: ev.recurrence ?? null, remind: ev.remind, announce: ev.announce,
  };
  for (const k of PATCHABLE) if (patch[k] !== undefined) base[k] = patch[k];
  return base;
}

/** The stored event as input (no re-validation: a stored event may predate a rule). */
const storedInput = (ev: LeagueCalendarEvent): LeagueEventInput => ({
  title: ev.title, type: ev.type, start: ev.start, end: ev.end, location: ev.location, description: ev.description,
  ...(ev.link ? { link: ev.link } : {}), ...(ev.recurrence ? { recurrence: ev.recurrence } : {}), remind: ev.remind, announce: ev.announce,
});

/** What a coach would notice changed (used for the "changed" notice; reminder / Discord toggles alone tell nobody). */
export function visibleChanges(a: LeagueEventInput, b: LeagueEventInput): string[] {
  const out: string[] = [];
  if (a.title !== b.title) out.push("title");
  if (a.type !== b.type) out.push("type");
  if (a.start !== b.start || a.end !== b.end) out.push("time");
  if (JSON.stringify(a.recurrence ?? null) !== JSON.stringify(b.recurrence ?? null)) out.push("repeat");
  if (a.location.kind !== b.location.kind || a.location.text !== b.location.text) out.push("location");
  if (a.description !== b.description) out.push("description");
  if (JSON.stringify(a.link ?? null) !== JSON.stringify(b.link ?? null)) out.push("season");
  return out;
}

// ---- read models ------------------------------------------------------------------------------------------------------

export interface PublicLeagueEvent {
  id: string;
  revision: number;
  title: string;
  type: LeagueEventType;
  typeLabel: string;
  start: string;
  end: string;
  location: { kind: "venue" | "online"; text: string };
  description: string;
  link?: { kind: "season" | "ladder"; id: string; name: string };
  recurrence?: { everyWeeks: number; until: string };
  repeatText: string;
  /** Every occurrence as instants (ISO), first to last. */
  occurrences: Array<{ key: string; start: string; end: string }>;
}

export type DiscordSyncState = "off" | "draft" | "blocked" | "pending" | "synced" | "failed" | "past";

export interface OrganiserLeagueEvent extends PublicLeagueEvent {
  remind: boolean;
  announce: boolean;
  discord: { state: DiscordSyncState; error?: string };
}

export function publicLeagueEvent(ev: LeagueCalendarEvent, zone: string, seasons: ReadonlyArray<Pick<SeasonRecord, "id" | "name">>): PublicLeagueEvent {
  const season = ev.link?.kind === "season" ? seasons.find((s) => s.id === ev.link!.id) : undefined;
  return {
    id: ev.id, revision: ev.revision, title: ev.title, type: ev.type, typeLabel: LEAGUE_EVENT_TYPE_LABEL[ev.type] ?? "Other",
    start: ev.start, end: ev.end, location: { kind: ev.location.kind, text: ev.location.text }, description: ev.description,
    ...(ev.link && season ? { link: { kind: ev.link.kind, id: ev.link.id, name: season.name } } : {}),
    ...(ev.recurrence ? { recurrence: { ...ev.recurrence } } : {}),
    repeatText: repeatText(ev.recurrence),
    occurrences: occurrences(ev, zone).map((o) => ({ key: o.key, start: new Date(o.start).toISOString(), end: new Date(o.end).toISOString() })),
  };
}

export function discordState(ev: LeagueCalendarEvent, league: Pick<LeagueRecord, "scheduledEvents" | "visibility">, zone: string, now: number): OrganiserLeagueEvent["discord"] {
  if (!league.scheduledEvents?.enabled) return { state: "off" };
  if (isDraftLeague(league)) return { state: "draft" };
  if (league.scheduledEvents.blocked) return { state: "blocked", error: league.scheduledEvents.blocked.reason };
  if (ev.discordSync?.failed) return { state: "failed", ...(ev.discordSync.error ? { error: ev.discordSync.error } : {}) };
  if (ev.discordSync) return { state: "pending", ...(ev.discordSync.error ? { error: ev.discordSync.error } : {}) };
  if (!nextOccurrence(ev, zone, now)) return { state: "past" };
  return ev.discord ? { state: "synced" } : { state: "pending" };
}

export function organiserLeagueEvent(ev: LeagueCalendarEvent, league: LeagueRecord, zone: string, seasons: ReadonlyArray<Pick<SeasonRecord, "id" | "name">>, now: number): OrganiserLeagueEvent {
  return { ...publicLeagueEvent(ev, zone, seasons), remind: ev.remind, announce: ev.announce, discord: discordState(ev, league, zone, now) };
}

const byStart = (zone: string) => (a: LeagueCalendarEvent, b: LeagueCalendarEvent): number => wallInstant(a.start, zone) - wallInstant(b.start, zone) || a.title.localeCompare(b.title);

// ---- recipients, notices, the webhook post ----------------------------------------------------------------------------

/** The league's coaches: mapped coaches of every unfinished season (the newest season when all are finished), once each. */
export function leagueCoaches(seasons: readonly SeasonRecord[], exclude = ""): string[] {
  const open = seasons.filter((s) => s.status !== "completed");
  const pool = open.length ? open : seasons.slice(0, 1);
  const seen = new Set<string>([exclude.trim().toLowerCase()]);
  const out: string[] = [];
  for (const s of pool) for (const c of seasonCoaches(s)) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

export const leagueEventLink = (leagueId: string, eventId: string): string => `/app/leagues/${encodeURIComponent(leagueId)}?tab=calendar&event=${encodeURIComponent(eventId)}`;

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function noticeBody(league: LeagueRecord, ev: LeagueCalendarEvent, zone: string, now: number, lead = ""): string {
  const next = upcoming(ev, zone, now)[0] ?? occurrences(ev, zone)[0]!;
  const where = ev.location.text ? ` ${ev.location.kind === "online" ? "Online" : "At"}: ${ev.location.text}.` : ev.location.kind === "online" ? " Online." : "";
  const repeat = ev.recurrence ? ` ${repeatText(ev.recurrence)}.` : "";
  return clip(`${league.name}: ${lead}${LEAGUE_EVENT_TYPE_LABEL[ev.type]}, ${whenText(next, zone)} (${zoneLabel(zone)}).${repeat}${where}`, 600);
}

function tell(notify: ((coach: string, input: NotificationInput) => void) | undefined, coaches: readonly string[], input: NotificationInput): void {
  for (const c of coaches) { try { notify?.(c, input); } catch { /* fire-and-forget */ } }
}

/** The "New league event" webhook embed (pure). User text is escaped and starred (safe); postTo cleans it once more. */
export function buildLeagueEventPost(league: Pick<LeagueRecord, "name">, ev: LeagueCalendarEvent, zone: string, now: number, siteUrl = ""): ReturnType<typeof post> {
  const next = upcoming(ev, zone, now)[0] ?? occurrences(ev, zone)[0]!;
  const fields = [
    { name: "When", value: `${whenText(next, zone)} (${zoneLabel(zone)})`, inline: true },
    { name: ev.location.kind === "online" ? "Online" : "Where", value: ev.location.text ? safe(ev.location.text, 200) : ev.location.kind === "online" ? "Online" : "", inline: true },
    { name: "Repeats", value: repeatText(ev.recurrence) },
  ];
  const lines = [`**${safe(ev.title, TITLE_MAX)}**`, LEAGUE_EVENT_TYPE_LABEL[ev.type]];
  if (ev.description) lines.push("", safe(ev.description, 1500));
  return post(`${safe(league.name, 100)}: New league event`, lines.join("\n"), 0x3b82c4, { fields, ...(siteUrl ? { url: siteUrl } : {}) });
}

// ---- deps ---------------------------------------------------------------------------------------------------------------

export interface LeagueEventsDeps {
  /** The Discord REST client (DISCORD_BOT_TOKEN set); undefined = no bot: "Create Discord events" cannot be turned on. */
  guild?: GuildEventsClient;
  /** DISCORD_CLIENT_ID: the bot invite (with Manage Events) for the "Add the Super FUMBBL bot" button. */
  clientId?: string;
  /** Start a Discord sync now (never awaited by a route). */
  kick?: () => void;
  /** A coach's LINKED Discord account id (server side only; never answered): proof of authority over a server. */
  discordUserId?: (coach: string) => string | undefined;
  /** Change-notice coalescing (one combined "updated" note per event per window). Absent = the process-wide one. */
  notices?: LeagueEventNoticeCoalescer;
}

export interface LeagueEventRouteDeps extends BodyDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  postWebhook?: WebhookPoster;
  ifMatch?: string;
  now?: () => Date;
  leagueEvents?: LeagueEventsDeps;
}

// ---- change notices: coalesced per event ------------------------------------------------------------------------------

export const EVENT_NOTICE_WINDOW_MS = 10 * 60_000;

/**
 * Coalesces "League event changed" notes per event (the RulesChangeCoalescer pattern): the first change in a quiet window
 * goes out at once; later changes inside the window are held and go out as ONE combined "updated" note (every change named
 * once, the event as it is at the end) when the window closes. A cancel drops what is held for that event. In memory: a
 * restart inside a window drops a held note (the calendar already shows the change).
 */
export class LeagueEventNoticeCoalescer {
  private readonly open = new Map<string, { until: number; changes: string[]; send?: (changes: string[]) => void }>();
  constructor(
    private readonly windowMs = EVENT_NOTICE_WINDOW_MS,
    private readonly schedule: (fn: () => void, ms: number) => void = (fn, ms) => { const t = setTimeout(fn, ms); (t as { unref?: () => void }).unref?.(); },
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Opens a window without sending (a create: its own notice went out). */
  touch(key: string): void {
    if (!this.open.has(key)) this.start(key);
  }

  submit(key: string, changes: string[], send: (changes: string[]) => void): "sent" | "held" {
    const w = this.open.get(key);
    if (w && this.clock() < w.until) {
      for (const c of changes) if (!w.changes.includes(c)) w.changes.push(c);
      w.send = send;
      return "held";
    }
    if (w) this.flush(key, false);
    this.start(key);
    send(changes);
    return "sent";
  }

  drop(key: string): void { this.open.delete(key); }

  /** A change note is held for this event (coaches have not been told the latest yet). */
  holds(key: string): boolean { return (this.open.get(key)?.changes.length ?? 0) > 0; }

  flush(key: string, reopen = true): void {
    const w = this.open.get(key);
    this.open.delete(key);
    if (!w || !w.changes.length || !w.send) return;
    if (reopen) this.start(key);
    w.send(w.changes);
  }

  private start(key: string): void {
    const until = this.clock() + this.windowMs;
    this.open.set(key, { until, changes: [] });
    this.schedule(() => { const w = this.open.get(key); if (w && w.until === until) this.flush(key); }, this.windowMs);
  }
}

/** The process-wide coalescer; tests pass their own. */
export const leagueEventNotices = new LeagueEventNoticeCoalescer();

// ---- schedule sources (the organiser Schedule page) --------------------------------------------------------------------

export type ScheduleEntry =
  | { kind: "league-event"; key: string; start: string; end: string; title: string; detail: string; eventId: string; type: LeagueEventType }
  /** A gate ("Opens at" on an online step, league ladder spec, Gates): lane 8c. `eventId` = the League Event it is tied to. */
  | { kind: "gate"; key: string; start: string; title: string; detail: string; gateId: string; step: string; eventId?: string };

export interface ScheduleContext { league: LeagueRecord; seasons: readonly SeasonRecord[]; events: readonly LeagueCalendarEvent[]; zone: string; now: number }
export type ScheduleSource = (ctx: ScheduleContext) => ScheduleEntry[];

/** Upcoming League Event occurrences (under way or still to come). */
export const leagueEventScheduleSource: ScheduleSource = (ctx) => ctx.events.flatMap((ev) => upcoming(ev, ctx.zone, ctx.now).map((o) => ({
  kind: "league-event" as const, key: `league-event:${ev.id}:${o.key}`, start: new Date(o.start).toISOString(), end: new Date(o.end).toISOString(),
  title: ev.title, detail: [LEAGUE_EVENT_TYPE_LABEL[ev.type], ev.location.text].filter(Boolean).join(" · "), eventId: ev.id, type: ev.type,
})));

/**
 * GATES EXTENSION POINT (league ladder spec, Gates; lane 8c): return every gate of the league (redraft window, rest rolls,
 * season start / fixture release, ladder challenges, registration opening, honours reveal) as "gate" entries, each at its
 * "Opens at" instant. A gate tied to a League Event reads its time from that event's occurrence (ctx.events) so it moves
 * with the event. No gate exists yet, so this returns [].
 */
export const gateScheduleSource: ScheduleSource = () => [];

export const SCHEDULE_SOURCES: readonly ScheduleSource[] = [leagueEventScheduleSource, gateScheduleSource];

export function scheduleEntries(ctx: ScheduleContext, sources: readonly ScheduleSource[] = SCHEDULE_SOURCES): ScheduleEntry[] {
  return sources.flatMap((s) => s(ctx)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.title.localeCompare(b.title)).slice(0, 300);
}

// ---- routes -----------------------------------------------------------------------------------------------------------

export function readFile(store: LeagueStore, id: string): LeagueEventsFile {
  return store.leagueEvents(id);
}

export function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can change it.");
  return undefined;
}

const newId = (): string => randomBytes(6).toString("hex");

/**
 * Queues the event for a Discord sync when the league uses Discord events or a Discord event of it is still tracked. Each
 * queueing is a new generation (syncGen): a sync started for an older one never clears or fails this one.
 */
export function markSync(ev: LeagueCalendarEvent, league: Pick<LeagueRecord, "scheduledEvents">, nowIso: string): void {
  if (league.scheduledEvents?.enabled || ev.discord || ev.discordLive?.length) {
    ev.syncGen = (ev.syncGen ?? 0) + 1;
    ev.discordSync = { attempts: 0, nextAt: nowIso, gen: ev.syncGen };
  } else delete ev.discordSync;
}

/** Occurrences inside the next 24 hours are covered by the create / change notice: their reminder is not sent again.
 *  Never while the league is a draft (that notice was not sent): the callers check. */
function coverWindow(ev: LeagueCalendarEvent, zone: string, now: number): void {
  const keys = occurrences(ev, zone).filter((o) => o.start > now && o.start - now <= REMINDER_MS).map((o) => o.key);
  if (keys.length) ev.reminded = [...new Set([...(ev.reminded ?? []), ...keys])];
}

export function kick(deps: Pick<LeagueEventRouteDeps, "leagueEvents">): void {
  try { deps.leagueEvents?.kick?.(); } catch { /* the job retries on its timer */ }
}

export async function leagueCalendarEventRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueEventRouteDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, second, ...more] = rest;
  if (first === "schedule") {
    if (second !== undefined) return undefined;
    if (method !== "GET" && method !== "HEAD") return fail(405, "Use GET.");
    const early = gate(league, auth);
    if (early) return early;
    const now = (deps.now?.() ?? new Date()).getTime();
    const zone = leagueTimeZone(league);
    let events: LeagueCalendarEvent[];
    try { events = readFile(deps.store, league!.id).events; } catch { return fail(500, "The league's events could not be read."); }
    const entries = scheduleEntries({ league: league!, seasons: deps.store.seasons(league!.id), events, zone, now });
    return res(200, { timeZone: zone, entries });
  }
  if (first !== "events" || more.length) return undefined;
  if (second === "discord") return undefined; // leagueEventsDiscord.ts
  const read = method === "GET" || method === "HEAD";
  if (second === undefined && !read && method !== "POST") return fail(405, "Use GET or POST.");
  if (second !== undefined && method !== "PATCH" && method !== "DELETE") return fail(405, "Use PATCH or DELETE.");
  const now = deps.now?.() ?? new Date();
  if (read) {
    if (!league) return fail(404, "League not found.", {});
    const zone = leagueTimeZone(league);
    let file: LeagueEventsFile;
    try { file = readFile(deps.store, league.id); } catch { return fail(500, "The league's events could not be read."); }
    const seasons = deps.store.seasons(league.id);
    const manage = managesLeague(league, auth);
    const events = [...file.events].sort(byStart(zone)).map((ev) => (manage ? organiserLeagueEvent(ev, league, zone, seasons, now.getTime()) : publicLeagueEvent(ev, zone, seasons)));
    // A manager's read (or a draft's) carries organiser fields; any signed-in read stays private.
    const headers = auth || manage || isDraftLeague(league) ? NO_STORE : {};
    return { status: 200, headers, body: { timeZone: zone, manage, events } };
  }
  const early = gate(league, auth);
  if (early) return early;
  let input: Record<string, unknown> = {};
  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  input = body.value;
  // Judged against the league as it is now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const zone = leagueTimeZone(lg);
  const nowMs = now.getTime();
  const iso = now.toISOString();
  const seasons = deps.store.seasons(lg.id);
  let file: LeagueEventsFile;
  try { file = readFile(deps.store, lg.id); } catch { return fail(500, "The league's events could not be read."); }
  const who = auth!;
  const link = (id: string) => leagueEventLink(lg.id, id);
  const recipients = () => leagueCoaches(seasons, who.coach);
  const draft = isDraftLeague(lg);
  const notices = deps.leagueEvents?.notices ?? leagueEventNotices;
  const noticeKey = (id: string) => `${lg.id}:${id}`;

  try {
    if (second === undefined) {
      if (file.events.length >= EVENTS_PER_LEAGUE_MAX) return fail(409, `A league can hold at most ${EVENTS_PER_LEAGUE_MAX} events; delete an old one first.`);
      const parsed = parseLeagueEvent(input, { zone, seasons });
      const ev: LeagueCalendarEvent = { id: newId(), revision: 1, ...parsed, createdAt: iso, updatedAt: iso };
      if (!draft) coverWindow(ev, zone, nowMs);
      if (!draft && upcoming(ev, zone, nowMs).length) ev.announced = true; // the create note below goes out
      markSync(ev, lg, iso);
      file.events = [...file.events, ev];
      deps.store.putLeagueEvents(lg.id, file);
      kick(deps);
      if (upcoming(ev, zone, nowMs).length) {
        notices.touch(noticeKey(ev.id)); // quick follow-up edits fold into one "updated" note
        tell(deps.notify, recipients(), { type: "league-broadcast", title: clip(`New league event: ${ev.title}`, 120), body: noticeBody(lg, ev, zone, nowMs), link: link(ev.id), from: who.coach });
        if (ev.announce) {
          const seasonId = ev.link?.kind === "season" ? ev.link.id : undefined;
          await postLeagueEvent(deps.store, lg, "leagueEvent", buildLeagueEventPost(lg, ev, zone, nowMs), deps.postWebhook, seasonId ? { seasonId } : {});
        }
      }
      return res(201, { event: organiserLeagueEvent(ev, lg, zone, seasons, nowMs) });
    }

    const ev = file.events.find((e) => e.id === second);
    if (!ev) return fail(404, "Event not found.");
    const rev = requestRevision(input, deps.ifMatch);
    if (rev === "missing") return fail(428, "Name the event's revision (reload and try again).");
    if (rev === "bad") return fail(400, "revision must be a whole number.");
    if (rev !== ev.revision) return fail(409, "Someone changed this event since you opened it. Reload to see the latest.", { revision: ev.revision });

    if (method === "DELETE") {
      // Told whenever coaches were ever told about it (or a change note is still held), even if it now lies in the past.
      const tellCancel = !draft && (ev.announced === true || notices.holds(noticeKey(ev.id)));
      file.events = file.events.filter((e) => e.id !== ev.id);
      // Its Discord scheduled events go too, an occurrence under way included (queued: never holds up the delete).
      const tracked = [...(ev.discord ? [ev.discord] : []), ...(ev.discordLive ?? [])];
      if (tracked.length) file.discordDeletes = [...(file.discordDeletes ?? []), ...tracked.map((m) => ({ guildId: m.guildId, eventId: m.eventId, attempts: 0, nextAt: iso, title: ev.title }))];
      notices.drop(noticeKey(ev.id));
      deps.store.putLeagueEvents(lg.id, file);
      kick(deps);
      if (tellCancel) tell(deps.notify, recipients(), { type: "league-broadcast", title: clip(`League event cancelled: ${ev.title}`, 120), body: noticeBody(lg, ev, zone, nowMs, "cancelled. "), link: `/app/leagues/${encodeURIComponent(lg.id)}?tab=calendar`, from: who.coach });
      return res(200, { deleted: ev.id });
    }

    const parsed = parseLeagueEvent(merged(ev, input), { zone, seasons });
    const changes = visibleChanges(storedInput(ev), parsed);
    const wasUpcoming = upcoming(ev, zone, nowMs).length > 0;
    const { link: _l, recurrence: _r, ...plain } = parsed;
    Object.assign(ev, plain);
    if (parsed.link) ev.link = parsed.link; else delete ev.link;
    if (parsed.recurrence) ev.recurrence = parsed.recurrence; else delete ev.recurrence;
    ev.revision += 1;
    ev.updatedAt = iso;
    if (!draft && (changes.includes("time") || changes.includes("repeat"))) coverWindow(ev, zone, nowMs);
    const noteChange = changes.length > 0 && (wasUpcoming || upcoming(ev, zone, nowMs).length > 0);
    if (!draft && noteChange) ev.announced = true;
    markSync(ev, lg, iso);
    deps.store.putLeagueEvents(lg.id, file);
    kick(deps);
    if (noteChange) {
      // Coalesced per event: the first change goes now, a burst within the window becomes one combined "updated" note.
      const snapshot = structuredClone(ev);
      const coaches = recipients();
      const notify = deps.notify;
      notices.submit(noticeKey(ev.id), changes, (all) => {
        const what = all.length === 1 ? `the ${all[0]} changed` : `${all.slice(0, -1).join(", ")} and ${all.at(-1)} changed`;
        tell(notify, coaches, {
          type: "league-broadcast", title: clip(`League event ${all === changes ? "changed" : "updated"}: ${snapshot.title}`, 120),
          body: noticeBody(lg, snapshot, zone, nowMs, `${what.charAt(0).toUpperCase()}${what.slice(1)}. `), link: link(snapshot.id), from: who.coach,
        });
      });
    }
    return res(200, { event: organiserLeagueEvent(ev, lg, zone, seasons, nowMs) });
  } catch (e) {
    if (e instanceof LeagueEventError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    if (e instanceof LeagueStoreError) return fail(e.status, e.message);
    return fail(500, "Could not save that right now.");
  }
}

// ---- jobs: reminders (inbox, once per occurrence) ----------------------------------------------------------------------

export interface ReminderJobDeps {
  store: LeagueStore;
  notify: (coach: string, input: NotificationInput) => void;
  now?: () => Date;
}

/**
 * Coaches of a published league get one reminder per occurrence of an event with "Remind coaches" on, in the 24 hours
 * before it starts. The occurrence is recorded (written) BEFORE anyone is told, so a restart or a second tick never sends
 * it twice; occurrences inside the window when the event was created or moved were covered by that notice (coverWindow).
 */
export function runLeagueEventReminders(deps: ReminderJobDeps): { reminded: string[] } {
  const now = (deps.now?.() ?? new Date()).getTime();
  const out: string[] = [];
  for (const league of publishedLeagues(deps.store.list())) {
    let file: LeagueEventsFile;
    try { file = deps.store.leagueEvents(league.id); } catch { continue; }
    if (!file.events.length) continue;
    const zone = leagueTimeZone(league);
    const due: Array<{ ev: LeagueCalendarEvent; o: Occurrence }> = [];
    let changed = false;
    for (const ev of file.events) {
      const occ = occurrences(ev, zone);
      const keep = new Set(occ.filter((o) => o.start > now - 7 * REMINDER_MS).map((o) => o.key));
      const pruned = (ev.reminded ?? []).filter((k) => keep.has(k));
      if (pruned.length !== (ev.reminded ?? []).length) { changed = true; if (pruned.length) ev.reminded = pruned; else delete ev.reminded; }
      if (!ev.remind) continue;
      for (const o of occ) {
        if (o.start <= now || o.start - now > REMINDER_MS || ev.reminded?.includes(o.key)) continue;
        ev.reminded = [...(ev.reminded ?? []), o.key];
        changed = true;
        due.push({ ev, o });
      }
    }
    if (!changed) continue;
    try { deps.store.putLeagueEvents(league.id, file); } catch { continue; } // not written: nobody is told
    if (!due.length) continue;
    const coaches = leagueCoaches(deps.store.seasons(league.id));
    for (const { ev, o } of due) {
      out.push(`${league.id}/${ev.id}/${o.key}`);
      const where = ev.location.text ? ` ${ev.location.kind === "online" ? "Online" : "At"}: ${ev.location.text}.` : "";
      tell(deps.notify, coaches, {
        type: "league-broadcast", title: clip(`Tomorrow: ${ev.title}`, 120),
        body: clip(`${league.name}: ${LEAGUE_EVENT_TYPE_LABEL[ev.type]}, ${whenText(o, zone)} (${zoneLabel(zone)}).${where}`, 600),
        link: leagueEventLink(league.id, ev.id), from: league.name,
      });
    }
  }
  return { reminded: out };
}


// ---- publish: what drafts held back ------------------------------------------------------------------------------------

/**
 * Publishing a draft league tells its coaches what is coming up (a draft posts nothing, so nothing was sent while it was
 * one): ONE note per coach listing the events that start in the next 7 days. Occurrences inside the next 24 hours count as
 * covered by it (no reminder on top); later ones get their reminder as usual.
 */
export function announceUpcomingOnPublish(store: LeagueStore, league: LeagueRecord, notify: ((coach: string, input: NotificationInput) => void) | undefined, now: Date): number {
  let file: LeagueEventsFile;
  try { file = store.leagueEvents(league.id); } catch { return 0; }
  const zone = leagueTimeZone(league);
  const t = now.getTime();
  const soon = file.events.flatMap((ev) => occurrences(ev, zone).filter((o) => o.start > t && o.start - t <= 7 * REMINDER_MS).map((o) => ({ ev, o })))
    .sort((a, b) => a.o.start - b.o.start);
  // Every event still to come is public now: its cancellation will be told. Inside 24 hours the note below covers it.
  let changed = false;
  for (const ev of file.events) {
    if (!upcoming(ev, zone, t).length) continue;
    if (soon.length) coverWindow(ev, zone, t);
    ev.announced = true;
    changed = true;
  }
  if (changed) { try { store.putLeagueEvents(league.id, file); } catch { /* a reminder may repeat it; never block publish */ } }
  if (!soon.length) return 0;
  const lines = soon.slice(0, 6).map(({ ev, o }) => `${ev.title}: ${whenText(o, zone)}`);
  const more = soon.length > 6 ? ` And ${soon.length - 6} more.` : "";
  const coaches = leagueCoaches(store.seasons(league.id));
  tell(notify, coaches, {
    type: "league-broadcast", title: clip(`${league.name}: upcoming league events`, 120),
    body: clip(`${league.name} is open. Coming up (${zoneLabel(zone)}): ${lines.join("; ")}.${more}`, 600),
    link: `/app/leagues/${encodeURIComponent(league.id)}?tab=calendar`, from: league.name,
  });
  return coaches.length;
}
