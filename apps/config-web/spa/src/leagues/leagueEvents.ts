// League Events (owner, grill round 1: "Let's add League Events where folks can input their own league nights, etc."): the
// SPA side of src/leagues/leagueEvents.ts. Types of the read models, the API calls, the Calendar sources (League Events,
// and the typed gates source that returns nothing until gates exist), the Schedule timeline, and the editor's pure form
// helpers. No DOM. Times on the wire are wall-clock keys in the league zone ("2026-11-05T19:00"); the server expands every
// occurrence to instants, so the views never do time-zone arithmetic of their own beyond reading an instant in the zone.

import type { Fetcher } from "../session";
import { clockIn, dayKeyIn, validZone } from "../schedule/schedule";
import type { CalendarContext, CalendarItem, CalendarSource } from "./seasonCalendar";

export type LeagueEventType = "league-night" | "draft" | "tournament-day" | "social" | "other";
export const LEAGUE_EVENT_TYPES: ReadonlyArray<{ id: LeagueEventType; label: string }> = [
  { id: "league-night", label: "League night" },
  { id: "draft", label: "Draft" },
  { id: "tournament-day", label: "Tournament day" },
  { id: "social", label: "Social" },
  { id: "other", label: "Other" },
];
export const typeLabel = (t: LeagueEventType): string => LEAGUE_EVENT_TYPES.find((x) => x.id === t)?.label ?? "Other";

export interface LeagueEventOccurrence { key: string; start: string; end: string }

export interface LeagueEventView {
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
  occurrences: LeagueEventOccurrence[];
  /** Organiser reads only. */
  remind?: boolean;
  announce?: boolean;
  discord?: { state: "off" | "draft" | "pending" | "synced" | "failed" | "past"; error?: string };
}

export interface LeagueEventsRead { timeZone: string; manage: boolean; events: LeagueEventView[] }

export type ScheduleEntry =
  | { kind: "league-event"; key: string; start: string; end: string; title: string; detail: string; eventId: string; type: LeagueEventType }
  | { kind: "gate"; key: string; start: string; title: string; detail: string; gateId: string; step: string; eventId?: string };

export interface DiscordEventsSettings {
  available: boolean;
  inviteUrl?: string;
  enabled: boolean;
  guildId?: string;
  channelId?: string;
  guilds: Array<{ id: string; name: string }>;
  channels: Array<{ id: string; name: string; type: "voice" | "stage" }>;
  botInServer: boolean;
  error?: string;
  notice: string;
}

export const ADD_BOT_TEXT = "Add the Super FUMBBL bot to your server to create Discord events";

const base = (leagueId: string): string => `/api/leagues/${encodeURIComponent(leagueId)}`;

export const leagueEventsApi = {
  list: (api: Fetcher, leagueId: string) => api<LeagueEventsRead>(`${base(leagueId)}/events`),
  create: (api: Fetcher, leagueId: string, body: LeagueEventPayload) => api<{ event: LeagueEventView }>(`${base(leagueId)}/events`, { method: "POST", body }),
  update: (api: Fetcher, leagueId: string, id: string, revision: number, body: LeagueEventPayload) =>
    api<{ event: LeagueEventView }>(`${base(leagueId)}/events/${encodeURIComponent(id)}`, { method: "PATCH", body: { ...body, revision } }),
  remove: (api: Fetcher, leagueId: string, id: string, revision: number) =>
    api<{ deleted: string }>(`${base(leagueId)}/events/${encodeURIComponent(id)}`, { method: "DELETE", body: { revision } }),
  schedule: (api: Fetcher, leagueId: string) => api<{ timeZone: string; entries: ScheduleEntry[] }>(`${base(leagueId)}/schedule`),
  discord: (api: Fetcher, leagueId: string) => api<{ discordEvents: DiscordEventsSettings }>(`${base(leagueId)}/events/discord`),
  saveDiscord: (api: Fetcher, leagueId: string, body: { enabled?: boolean; guildId?: string | null; channelId?: string | null }) =>
    api<{ discordEvents: DiscordEventsSettings }>(`${base(leagueId)}/events/discord`, { method: "PATCH", body }),
};

// ---- calendar sources --------------------------------------------------------------------------------------------------

export const leagueEventItemKey = (eventId: string, occurrence: string): string => `league-event:${eventId}:${occurrence}`;

/**
 * Every occurrence of every League Event as a calendar item (type "league-event"). They are league-wide, so every
 * season's calendar shows them. An item opens the event dialog (target "dialog") instead of a page.
 */
export function leagueEventItems(events: readonly LeagueEventView[], ctx: CalendarContext): CalendarItem[] {
  const zone = validZone(ctx.zone) ? ctx.zone : "UTC";
  const out: CalendarItem[] = [];
  for (const ev of events) {
    for (const o of ev.occurrences) {
      const start = Date.parse(o.start);
      const end = Date.parse(o.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      out.push({
        key: leagueEventItemKey(ev.id, o.key), type: "league-event", day: dayKeyIn(start, zone), allDay: false, start, end: Math.max(end, start),
        time: clockIn(start, zone), title: ev.title, short: ev.title.length > 18 ? `${ev.title.slice(0, 17)}…` : ev.title,
        result: "", state: "scheduled", detail: [ev.typeLabel, ev.location.text].filter(Boolean).join(" · "),
        to: "", target: "dialog", label: `${ev.typeLabel}: ${ev.title}, ${clockIn(start, zone)}. Open the event`,
        eventId: ev.id, occurrence: o.key,
      });
    }
  }
  return out;
}

/**
 * GATES EXTENSION POINT (league ladder spec, Gates; lane 8c): the league's gates ("Opens at" on an online step) as calendar
 * items of type "gate", each at its opening instant (a gate tied to a League Event takes that occurrence's time). No gate
 * exists yet, so the source is empty; give it the gates read and map each one here.
 */
export interface GateView { id: string; title: string; opensAt: string; step: string; eventId?: string }
export function gateItems(gates: readonly GateView[] = []): CalendarSource {
  return (ctx) => gates.flatMap((g) => {
    const t = Date.parse(g.opensAt);
    if (!Number.isFinite(t)) return [];
    const zone = validZone(ctx.zone) ? ctx.zone : "UTC";
    return [{
      key: `gate:${g.id}`, type: "gate" as const, day: dayKeyIn(t, zone), allDay: false, start: t, end: t, time: clockIn(t, zone),
      title: g.title, short: g.title, result: "", state: "scheduled" as const, detail: g.step, to: "", target: "dialog" as const, label: `Opens: ${g.title}`,
    }];
  });
}

// ---- dialog / timeline text -----------------------------------------------------------------------------------------------

const fmt = (t: number, zone: string, o: Intl.DateTimeFormatOptions): string => new Intl.DateTimeFormat("en-GB", { timeZone: validZone(zone) ? zone : "UTC", ...o }).format(new Date(t));

/** "Thu 5 Nov 2026, 19:00 to 22:00" (the end's day too when it is another day), in the league zone. */
export function whenText(o: Pick<LeagueEventOccurrence, "start" | "end">, zone: string): string {
  const s = Date.parse(o.start);
  const e = Date.parse(o.end);
  const day = (t: number) => {
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: validZone(zone) ? zone : "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" }).formatToParts(new Date(t));
    const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}`;
  };
  const clock = (t: number) => fmt(t, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${day(s)}, ${clock(s)} to ${day(s) === day(e) ? "" : `${day(e)}, `}${clock(e)}`;
}

/** The occurrence a click opened, else the next one to come, else the last. */
export function occurrenceFor(ev: LeagueEventView, key: string | undefined, now: number): LeagueEventOccurrence | undefined {
  return ev.occurrences.find((o) => o.key === key) ?? ev.occurrences.find((o) => Date.parse(o.end) > now) ?? ev.occurrences.at(-1);
}

/** Upcoming occurrences (under way or still to come). */
export const upcomingOf = (ev: LeagueEventView, now: number): LeagueEventOccurrence[] => ev.occurrences.filter((o) => Date.parse(o.end) > now);

/** An online location that is a link the dialog may open (https only). */
export const safeHttps = (s: string): string | undefined => (/^https:\/\/[^\s<>"']+$/i.test(s.trim()) ? s.trim() : undefined);

export const DISCORD_STATE_TEXT: Record<NonNullable<LeagueEventView["discord"]>["state"], string> = {
  off: "Discord events off", draft: "Waits for Publish", pending: "Discord: syncing", synced: "On Discord", failed: "Discord: failed", past: "Over",
};

export interface TimelineDay { key: string; label: string; entries: Array<ScheduleEntry & { time: string }> }

/** The Schedule page's timeline: entries by day in the league zone, in time order. */
export function timelineDays(entries: readonly ScheduleEntry[], zone: string): TimelineDay[] {
  const z = validZone(zone) ? zone : "UTC";
  const days = new Map<string, TimelineDay>();
  for (const e of [...entries].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const t = Date.parse(e.start);
    if (!Number.isFinite(t)) continue;
    const key = dayKeyIn(t, z);
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(new Date(t));
    const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
    const day = days.get(key) ?? { key, label: `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}`, entries: [] };
    day.entries.push({ ...e, time: clockIn(t, z) });
    days.set(key, day);
  }
  return [...days.values()];
}

// ---- editor -------------------------------------------------------------------------------------------------------------

export interface LeagueEventForm {
  title: string;
  type: LeagueEventType;
  /** datetime-local values ("2026-11-05T19:00"), in the league zone. */
  start: string;
  end: string;
  locationKind: "venue" | "online";
  locationText: string;
  description: string;
  /** "" = none, else "season:<id>". */
  link: string;
  repeat: boolean;
  everyWeeks: number;
  until: string;
  remind: boolean;
  announce: boolean;
}

export interface LeagueEventPayload {
  title: string;
  type: LeagueEventType;
  start: string;
  end: string;
  location: { kind: "venue" | "online"; text: string };
  description: string;
  link: { kind: "season"; id: string } | null;
  recurrence: { everyWeeks: number; until: string } | null;
  remind: boolean;
  announce: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A new event: next Thursday 19:00 to 22:00 in the league zone (league nights are the usual case), weekly off. */
export function blankForm(now: number, zone: string): LeagueEventForm {
  const today = dayKeyIn(now, validZone(zone) ? zone : "UTC");
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const wd = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = Monday
  const ahead = (3 - wd + 7) % 7 || 7; // the next Thursday
  const t = new Date(Date.UTC(y, m - 1, d + ahead));
  const day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  const until = new Date(Date.UTC(y, m - 1, d + ahead + 7 * 8));
  return {
    title: "", type: "league-night", start: `${day}T19:00`, end: `${day}T22:00`, locationKind: "venue", locationText: "", description: "",
    link: "", repeat: false, everyWeeks: 1, until: `${until.getUTCFullYear()}-${pad(until.getUTCMonth() + 1)}-${pad(until.getUTCDate())}`, remind: true, announce: true,
  };
}

export function formOf(ev: LeagueEventView): LeagueEventForm {
  return {
    title: ev.title, type: ev.type, start: ev.start, end: ev.end, locationKind: ev.location.kind, locationText: ev.location.text, description: ev.description,
    link: ev.link?.kind === "season" ? `season:${ev.link.id}` : "", repeat: Boolean(ev.recurrence), everyWeeks: ev.recurrence?.everyWeeks ?? 1,
    until: ev.recurrence?.until ?? ev.start.slice(0, 10), remind: ev.remind ?? true, announce: ev.announce ?? ev.type === "league-night",
  };
}

export function payloadOf(f: LeagueEventForm): LeagueEventPayload {
  return {
    title: f.title.trim(), type: f.type, start: f.start.slice(0, 16), end: f.end.slice(0, 16),
    location: { kind: f.locationKind, text: f.locationText.trim() }, description: f.description.trim(),
    link: f.link.startsWith("season:") ? { kind: "season", id: f.link.slice(7) } : null,
    recurrence: f.repeat ? { everyWeeks: Math.round(Number(f.everyWeeks) || 1), until: f.until } : null,
    remind: f.remind, announce: f.announce,
  };
}

/** The first problem to show inline ("" = fine). The server checks the same rules and is the authority. */
export function formError(f: LeagueEventForm): { field: string; text: string } | undefined {
  if (!f.title.trim()) return { field: "title", text: "Give the event a title." };
  if (f.title.trim().length > 80) return { field: "title", text: "The title can be at most 80 characters." };
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
  if (!wall.test(f.start)) return { field: "start", text: "Pick the start date and time." };
  if (!wall.test(f.end)) return { field: "end", text: "Pick the end date and time." };
  if (f.end.slice(0, 16) <= f.start.slice(0, 16)) return { field: "end", text: "End must be after the start." };
  if (f.locationKind === "online" && /^[a-z][a-z0-9+.-]*:/i.test(f.locationText.trim()) && !safeHttps(f.locationText)) return { field: "location", text: "An online link must start with https://." };
  if (f.description.length > 2000) return { field: "description", text: "The description can be at most 2000 characters." };
  if (f.repeat) {
    const n = Number(f.everyWeeks);
    if (!Number.isInteger(n) || n < 1 || n > 12) return { field: "everyWeeks", text: "Repeat every 1 to 12 weeks." };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.until)) return { field: "until", text: "Pick the last day it repeats." };
    if (f.until < f.start.slice(0, 10)) return { field: "until", text: "The last day must be on or after the first." };
  }
  return undefined;
}
