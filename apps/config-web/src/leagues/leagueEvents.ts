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
import { starProfanity } from "../discord/profanity.js";
import {
  describeDiscordError, DISCORD_SYNC_MAX_ATTEMPTS, discordRetryDelayMs, DiscordEventsError, isSnowflake, MANAGE_EVENTS_PERMISSION,
  type ChannelSummary, type GuildEventsClient, type GuildSummary, type ScheduledEventBody,
} from "../discord/scheduledEvents.js";
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
 * Every occurrence of an event in the league zone: the first, then every N weeks on the same wall-clock times up to and
 * including the recurrence's last day. Each start and end is converted on its own day, so a 19:00 league night stays at
 * 19:00 local across a daylight-saving change (its UTC instant moves instead).
 */
export function occurrences(ev: Pick<LeagueCalendarEvent, "start" | "end" | "recurrence">, zone: string): Occurrence[] {
  const [sd, st] = ev.start.split("T") as [string, string];
  const [ed, et] = ev.end.split("T") as [string, string];
  const span = dayDiff(sd, ed);
  const step = ev.recurrence ? ev.recurrence.everyWeeks * 7 : 0;
  const out: Occurrence[] = [];
  for (let k = 0; k < OCCURRENCES_MAX; k++) {
    const day = addDays(sd, k * step);
    if (k > 0 && (!step || !ev.recurrence || day > ev.recurrence.until)) break;
    const key = `${day}T${st}`;
    out.push({ key, start: wallInstant(key, zone), end: wallInstant(`${addDays(day, span)}T${et}`, zone) });
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

export type DiscordSyncState = "off" | "draft" | "pending" | "synced" | "failed" | "past";

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

// ---- Discord scheduled events: the payload ----------------------------------------------------------------------------

/** The Discord scheduled event for one occurrence (names and descriptions starred; Discord's own length limits). */
export function scheduledEventBody(ev: LeagueCalendarEvent, o: Occurrence, league: Pick<LeagueRecord, "name">, channelId?: string): ScheduledEventBody {
  const star = (s: string): string => starProfanity(s);
  const desc = [`${LEAGUE_EVENT_TYPE_LABEL[ev.type]} · ${league.name}`, ev.recurrence ? repeatText(ev.recurrence) : "", ev.description].filter(Boolean).join("\n\n");
  const voice = ev.location.kind === "online" && isSnowflake(channelId);
  const where = ev.location.text || (ev.location.kind === "online" ? "Online" : league.name);
  return {
    name: clip(star(ev.title), 100),
    description: clip(star(desc), 1000),
    scheduled_start_time: new Date(o.start).toISOString(),
    scheduled_end_time: new Date(o.end).toISOString(),
    privacy_level: 2,
    entity_type: voice ? 2 : 3,
    channel_id: voice ? channelId! : null,
    entity_metadata: voice ? null : { location: clip(star(where), 100) },
  };
}

// ---- deps ---------------------------------------------------------------------------------------------------------------

export interface LeagueEventsDeps {
  /** The Discord REST client (DISCORD_BOT_TOKEN set); undefined = no bot: "Create Discord events" cannot be turned on. */
  guild?: GuildEventsClient;
  /** DISCORD_CLIENT_ID: the bot invite (with Manage Events) for the "Add the Super FUMBBL bot" button. */
  clientId?: string;
  /** Start a Discord sync now (never awaited by a route). */
  kick?: () => void;
}

export interface LeagueEventRouteDeps extends BodyDeps {
  store: LeagueStore;
  notify?: (coach: string, input: NotificationInput) => void;
  postWebhook?: WebhookPoster;
  ifMatch?: string;
  now?: () => Date;
  leagueEvents?: LeagueEventsDeps;
}

/** The bot invite for scheduled events: the usual permissions plus Manage Events. */
export function eventsBotInviteUrl(clientId: string | undefined): string | undefined {
  const id = clientId?.trim();
  if (!id || !/^\d{5,25}$/.test(id)) return undefined;
  const permissions = BigInt(1024 + 2048 + 16384) + BigInt(MANAGE_EVENTS_PERMISSION);
  return `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${permissions.toString()}`;
}

export const ADD_BOT_TEXT = "Add the Super FUMBBL bot to your server to create Discord events";

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

function readFile(store: LeagueStore, id: string): LeagueEventsFile {
  return store.leagueEvents(id);
}

function gate(league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined): LeagueApiResult | undefined {
  if (!auth) return fail(401, "Sign in to manage this league.");
  if (!league) return fail(404, "League not found.");
  if (!managesLeague(league, auth)) return fail(403, "This league is not one of yours: only its organisers and site admins can change it.");
  return undefined;
}

const newId = (): string => randomBytes(6).toString("hex");

/** Marks the event for a Discord sync when the league uses Discord events or it already has one. */
function markSync(ev: LeagueCalendarEvent, league: LeagueRecord, nowIso: string): void {
  if (league.scheduledEvents?.enabled || ev.discord) ev.discordSync = { attempts: 0, nextAt: nowIso };
  else delete ev.discordSync;
}

/** Occurrences inside the next 24 hours are covered by the create / change notice: their reminder is not sent again. */
function coverWindow(ev: LeagueCalendarEvent, zone: string, now: number): void {
  const keys = occurrences(ev, zone).filter((o) => o.start > now && o.start - now <= REMINDER_MS).map((o) => o.key);
  if (keys.length) ev.reminded = [...new Set([...(ev.reminded ?? []), ...keys])];
}

function kick(deps: LeagueEventRouteDeps): void {
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
  if (second === "discord") return discordSettingsRoute(method, league, auth, deps);
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

  try {
    if (second === undefined) {
      if (file.events.length >= EVENTS_PER_LEAGUE_MAX) return fail(409, `A league can hold at most ${EVENTS_PER_LEAGUE_MAX} events; delete an old one first.`);
      const parsed = parseLeagueEvent(input, { zone, seasons });
      const ev: LeagueCalendarEvent = { id: newId(), revision: 1, ...parsed, createdAt: iso, updatedAt: iso };
      coverWindow(ev, zone, nowMs);
      markSync(ev, lg, iso);
      file.events = [...file.events, ev];
      deps.store.putLeagueEvents(lg.id, file);
      kick(deps);
      if (upcoming(ev, zone, nowMs).length) {
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
      const hadUpcoming = upcoming(ev, zone, nowMs).length > 0;
      file.events = file.events.filter((e) => e.id !== ev.id);
      // Its Discord scheduled event goes too (queued: the removal never holds up the delete).
      if (ev.discord) file.discordDeletes = [...(file.discordDeletes ?? []), { guildId: ev.discord.guildId, eventId: ev.discord.eventId, attempts: 0, nextAt: iso }];
      deps.store.putLeagueEvents(lg.id, file);
      kick(deps);
      if (hadUpcoming) tell(deps.notify, recipients(), { type: "league-broadcast", title: clip(`League event cancelled: ${ev.title}`, 120), body: noticeBody(lg, ev, zone, nowMs, "cancelled. "), link: `/app/leagues/${encodeURIComponent(lg.id)}?tab=calendar`, from: who.coach });
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
    if (changes.includes("time") || changes.includes("repeat")) coverWindow(ev, zone, nowMs);
    markSync(ev, lg, iso);
    deps.store.putLeagueEvents(lg.id, file);
    kick(deps);
    if (changes.length && (wasUpcoming || upcoming(ev, zone, nowMs).length)) {
      const what = changes.length === 1 ? `the ${changes[0]} changed` : `${changes.slice(0, -1).join(", ")} and ${changes.at(-1)} changed`;
      tell(deps.notify, recipients(), {
        type: "league-broadcast", title: clip(`League event changed: ${ev.title}`, 120),
        body: noticeBody(lg, ev, zone, nowMs, `${what.charAt(0).toUpperCase()}${what.slice(1)}. `), link: link(ev.id), from: who.coach,
      });
    }
    return res(200, { event: organiserLeagueEvent(ev, lg, zone, seasons, nowMs) });
  } catch (e) {
    if (e instanceof LeagueEventError) return fail(e.status, e.message, e.field ? { field: e.field } : {});
    if (e instanceof LeagueStoreError) return fail(e.status, e.message);
    return fail(500, "Could not save that right now.");
  }
}

// ---- "Create Discord events" settings ----------------------------------------------------------------------------------

export interface DiscordEventsSettingsView {
  /** The bot token is set (the site can talk to Discord as the bot). */
  available: boolean;
  /** "Add the Super FUMBBL bot to your server" (with Manage Events). */
  inviteUrl?: string;
  enabled: boolean;
  guildId?: string;
  channelId?: string;
  /** The bot's servers (empty without a bot, or when Discord did not answer). */
  guilds: GuildSummary[];
  /** Voice / stage channels of the picked server (online events can be held there). */
  channels: ChannelSummary[];
  /** The picked server still has the bot. */
  botInServer: boolean;
  error?: string;
  notice: string;
}

async function settingsView(league: LeagueRecord, deps: LeagueEventRouteDeps): Promise<DiscordEventsSettingsView> {
  const guild = deps.leagueEvents?.guild;
  const cfg = league.scheduledEvents;
  const invite = eventsBotInviteUrl(deps.leagueEvents?.clientId);
  const base = {
    available: Boolean(guild), ...(invite ? { inviteUrl: invite } : {}), enabled: cfg?.enabled === true,
    ...(cfg?.guildId ? { guildId: cfg.guildId } : {}), ...(cfg?.channelId ? { channelId: cfg.channelId } : {}),
  };
  if (!guild) return { ...base, guilds: [], channels: [], botInServer: false, notice: ADD_BOT_TEXT };
  let guilds: GuildSummary[] = [];
  let channels: ChannelSummary[] = [];
  let error: string | undefined;
  try {
    guilds = await guild.guilds();
    if (cfg?.guildId && guilds.some((g) => g.id === cfg.guildId)) channels = await guild.channels(cfg.guildId);
  } catch (e) { error = describeDiscordError(e); }
  const botInServer = Boolean(cfg?.guildId && guilds.some((g) => g.id === cfg.guildId));
  const notice = !guilds.length && !error ? ADD_BOT_TEXT : "";
  return { ...base, guilds, channels, botInServer, ...(error ? { error } : {}), notice };
}

async function discordSettingsRoute(method: string, league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueEventRouteDeps): Promise<LeagueApiResult> {
  const read = method === "GET" || method === "HEAD";
  if (!read && method !== "PATCH") return fail(405, "Use GET or PATCH.");
  const early = gate(league, auth);
  if (early) return early;
  if (read) return res(200, { discordEvents: await settingsView(league!, deps) });
  const body = await readJsonObject(deps, 4096);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const b = body.value;
  const guild = deps.leagueEvents?.guild;
  const prior = deps.store.league(league!.id)?.scheduledEvents ?? { enabled: false };
  const next = { ...prior };
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== "boolean") return fail(400, "enabled must be true or false.", { field: "enabled" });
    next.enabled = b.enabled;
  }
  if (b.guildId !== undefined) {
    if (b.guildId === null || b.guildId === "") { delete next.guildId; delete next.channelId; }
    else if (!isSnowflake(b.guildId)) return fail(400, "Pick one of the bot's servers.", { field: "guildId" });
    else { if (next.guildId !== b.guildId) delete next.channelId; next.guildId = b.guildId; }
  }
  if (b.channelId !== undefined) {
    if (b.channelId === null || b.channelId === "") delete next.channelId;
    else if (!isSnowflake(b.channelId)) return fail(400, "Pick a voice channel, or none.", { field: "channelId" });
    else next.channelId = b.channelId;
  }
  if (next.enabled && !guild) return fail(409, `${ADD_BOT_TEXT}.`, { field: "enabled" });
  if (next.enabled && !next.guildId) return fail(400, "Pick the Discord server the events go to.", { field: "guildId" });
  if (guild && (next.guildId !== prior.guildId || next.channelId !== prior.channelId) && next.guildId) {
    try {
      const guilds = await guild.guilds();
      if (!guilds.some((g) => g.id === next.guildId)) return fail(400, "The Super FUMBBL bot is not in that server. Add it first.", { field: "guildId" });
      if (next.channelId && !(await guild.channels(next.guildId)).some((c) => c.id === next.channelId)) return fail(400, "That voice channel is not in the server.", { field: "channelId" });
    } catch (e) {
      return fail(502, describeDiscordError(e));
    }
  }
  // Re-read after the Discord checks, then write synchronously.
  const lg = deps.store.league(league!.id);
  const refused = gate(lg, auth);
  if (refused || !lg) return refused ?? fail(404, "League not found.");
  const changed = JSON.stringify(prior) !== JSON.stringify(next);
  const updated = deps.store.updateLeague(lg.id, (l) => { l.scheduledEvents = next; });
  if (changed) {
    // Every event re-syncs: created in the new server, moved, or removed when turned off (the sync job decides).
    try {
      const file = readFile(deps.store, lg.id);
      const iso = (deps.now?.() ?? new Date()).toISOString();
      for (const ev of file.events) if (next.enabled || ev.discord) ev.discordSync = { attempts: 0, nextAt: iso };
      deps.store.putLeagueEvents(lg.id, file);
    } catch { /* the events re-sync on their next edit */ }
    kick(deps);
  }
  return res(200, { ok: true, discordEvents: await settingsView(updated, deps) });
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

// ---- jobs: Discord scheduled events ------------------------------------------------------------------------------------

export interface DiscordSyncDeps {
  store: LeagueStore;
  guild?: GuildEventsClient;
  now?: () => Date;
}

export interface DiscordSyncOutcome { created: string[]; updated: string[]; deleted: string[]; failed: string[] }

const due = (nextAt: string | undefined, now: number): boolean => !nextAt || Date.parse(nextAt) <= now;

/**
 * One pass over every published league that uses Discord events: pending removals first, then each event's scheduled
 * event for its next occurrence (created, moved to the new time / server, rolled on to the next week, or removed when the
 * series is over or the option is off). Calls to Discord happen OUTSIDE the file write; each result is committed onto a
 * fresh read, so an organiser edit made meanwhile is never lost (the event simply syncs again). A failure retries with
 * backoff and never touches the event itself.
 */
export async function runLeagueEventDiscordSync(deps: DiscordSyncDeps): Promise<DiscordSyncOutcome> {
  const out: DiscordSyncOutcome = { created: [], updated: [], deleted: [], failed: [] };
  const guild = deps.guild;
  if (!guild) return out;
  const nowAt = () => deps.now?.() ?? new Date();
  for (const listed of publishedLeagues(deps.store.list())) {
    const league = deps.store.league(listed.id);
    if (!league || isDraftLeague(league)) continue;
    let file: LeagueEventsFile;
    try { file = deps.store.leagueEvents(league.id); } catch { continue; }
    const zone = leagueTimeZone(league);
    const cfg = league.scheduledEvents;
    const active = Boolean(cfg?.enabled && isSnowflake(cfg.guildId));

    // 1. removals
    const doneDeletes = new Map<string, PendingDiscordDelete | null>();
    for (const d of file.discordDeletes ?? []) {
      if (!due(d.nextAt, nowAt().getTime())) continue;
      const key = `${d.guildId}:${d.eventId}`;
      try {
        await guild.remove(d.guildId, d.eventId);
        doneDeletes.set(key, null);
        out.deleted.push(`${league.id}:${d.eventId}`);
      } catch (e) {
        if (e instanceof DiscordEventsError && e.gone) { doneDeletes.set(key, null); continue; }
        const attempts = d.attempts + 1;
        const retry = !(e instanceof DiscordEventsError) || e.retryable;
        doneDeletes.set(key, retry && attempts < DISCORD_SYNC_MAX_ATTEMPTS ? { ...d, attempts, nextAt: new Date(nowAt().getTime() + discordRetryDelayMs(attempts)).toISOString() } : null);
        out.failed.push(`${league.id}:delete:${d.eventId}`);
      }
    }
    if (doneDeletes.size) commit(deps.store, league.id, (f) => {
      f.discordDeletes = (f.discordDeletes ?? []).flatMap((d) => {
        const r = doneDeletes.get(`${d.guildId}:${d.eventId}`);
        return r === undefined ? [d] : r === null ? [] : [r];
      });
    });

    // 2. events
    for (const ev of file.events) {
      const now = nowAt().getTime();
      if (ev.discordSync?.failed) continue;
      const pendingDue = ev.discordSync ? due(ev.discordSync.nextAt, now) : false;
      if (ev.discordSync && !pendingDue) continue;
      const next = active ? nextOccurrence(ev, zone, now) : undefined;
      const want = next ? { guildId: cfg!.guildId!, occurrence: next.key } : undefined;
      const have = ev.discord;
      const haveFuture = have ? wallInstant(have.occurrence, zone) > now : false;
      const drift = (want?.guildId ?? "") !== (have?.guildId ?? "") || (want?.occurrence ?? "") !== (have?.occurrence ?? "");
      if (!pendingDue && !drift) continue;

      const startRevision = ev.revision;
      let current = have;
      const queued: PendingDiscordDelete[] = [];
      let error: unknown;
      let permanent = false;
      try {
        if (current && (!want || current.guildId !== want.guildId)) {
          if (haveFuture) {
            try { await guild.remove(current.guildId, current.eventId); out.deleted.push(`${league.id}:${current.eventId}`); }
            catch (e) { if (!(e instanceof DiscordEventsError && e.gone)) queued.push({ guildId: current.guildId, eventId: current.eventId, attempts: 1, nextAt: new Date(now + discordRetryDelayMs(1)).toISOString() }); }
          }
          current = undefined;
        }
        if (want && next) {
          const body = scheduledEventBody(ev, next, league, cfg?.channelId);
          if (current && current.guildId === want.guildId && haveFuture) {
            try {
              const r = await guild.update(want.guildId, current.eventId, body);
              current = { guildId: want.guildId, eventId: r.id, occurrence: want.occurrence };
              out.updated.push(`${league.id}:${ev.id}`);
            } catch (e) {
              if (!(e instanceof DiscordEventsError && e.gone)) throw e;
              const r = await guild.create(want.guildId, body);
              current = { guildId: want.guildId, eventId: r.id, occurrence: want.occurrence };
              out.created.push(`${league.id}:${ev.id}`);
            }
          } else {
            const r = await guild.create(want.guildId, body);
            current = { guildId: want.guildId, eventId: r.id, occurrence: want.occurrence };
            out.created.push(`${league.id}:${ev.id}`);
          }
        } else if (current && !haveFuture) {
          current = undefined; // the mirrored occurrence is over and nothing follows: forget it (Discord keeps its own record)
        }
      } catch (e) {
        error = e;
        permanent = e instanceof DiscordEventsError && !e.retryable;
        out.failed.push(`${league.id}:${ev.id}`);
      }

      commit(deps.store, league.id, (f) => {
        if (queued.length) f.discordDeletes = [...(f.discordDeletes ?? []), ...queued];
        const fresh = f.events.find((x) => x.id === ev.id);
        if (!fresh) {
          // Deleted while we talked to Discord: the delete route queued what it knew; remove what we just made too.
          if (current && current.eventId !== have?.eventId) f.discordDeletes = [...(f.discordDeletes ?? []), { guildId: current.guildId, eventId: current.eventId, attempts: 0, nextAt: new Date(now).toISOString() }];
          return;
        }
        if (current) fresh.discord = current; else delete fresh.discord;
        if (error !== undefined) {
          const attempts = (fresh.discordSync?.attempts ?? 0) + 1;
          fresh.discordSync = {
            attempts, nextAt: new Date(now + discordRetryDelayMs(attempts)).toISOString(), error: describeDiscordError(error),
            ...(permanent || attempts >= DISCORD_SYNC_MAX_ATTEMPTS ? { failed: true } : {}),
          };
        } else if (fresh.revision !== startRevision) {
          fresh.discordSync = { attempts: 0, nextAt: new Date(now).toISOString() }; // edited meanwhile: sync the new version
        } else {
          delete fresh.discordSync;
        }
      });
    }
  }
  return out;
}

/** Read-modify-write of a league's events file on a FRESH read (synchronous: nothing interleaves). */
function commit(store: LeagueStore, leagueId: string, mutate: (f: LeagueEventsFile) => void): void {
  try {
    const f = store.leagueEvents(leagueId);
    mutate(f);
    store.putLeagueEvents(leagueId, f);
  } catch { /* unreadable or gone: the next pass tries again */ }
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
