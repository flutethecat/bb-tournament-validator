// Account page CALENDAR panel: a Monday-first month grid (matching the availability week grid) that plots the coach's
// deadlines and fixtures from GET /api/me/deadlines, plus the agreed and proposed match times from GET /api/schedule/mine
// (two coaches agreeing a time for a fixture; src/schedule). Days are keyed in the coach's timezone. No DOM; rendered by
// AccountCalendar.vue.

import type { Fetcher } from "../session";
import { chipFor, validTimeZone, type DeadlineChip, type DeadlineView } from "../home/deadlines";
import { byDay, type AvailabilityBlock } from "../home/schedule";
import { scheduleApi, type ScheduleView } from "../schedule/schedule";

/** A proposed (pending) or agreed (accepted) time for a fixture, as the calendar plots it. */
export interface ProposedTime {
  id: string;
  /** ISO instant proposed. */
  at: string;
  opponent: string;
  /** Tournament or fixture context. */
  detail: string;
  /** SPA path of the fixture (router form, no /app prefix). */
  link: string;
  state: "pending" | "accepted" | "declined";
  /** True when the signed-in coach proposed it (the other coach has to answer). */
  mine: boolean;
}

export type CalendarSource = "deadline" | "proposal";

export interface CalendarEvent {
  id: string;
  source: CalendarSource;
  kind: string;
  title: string;
  detail: string;
  at: string;
  chip: DeadlineChip;
  link: string;
}

export interface CalendarDay {
  /** YYYY-MM-DD. */
  key: string;
  /** Day of the month. */
  date: number;
  /** 0 = Monday .. 6 = Sunday (the availability grid's columns). */
  weekday: number;
  inMonth: boolean;
}

/** Year + month (0-11). */
export interface YearMonth { year: number; month: number }

export const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const pad = (n: number) => String(n).padStart(2, "0");
const keyOf = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;

/** The month's weeks, Monday first, padded with the neighbouring months' days to whole weeks (4 to 6 rows). */
export function monthGrid({ year, month }: YearMonth): CalendarDay[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const lead = (first.getUTCDay() + 6) % 7; // days before the 1st in its Monday-first week
  const daysIn = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const total = Math.ceil((lead + daysIn) / 7) * 7;
  const weeks: CalendarDay[][] = [];
  for (let i = 0; i < total; i++) {
    const d = new Date(Date.UTC(year, month, 1 - lead + i));
    const day: CalendarDay = { key: keyOf(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()), date: d.getUTCDate(), weekday: i % 7, inMonth: d.getUTCMonth() === month };
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]!.push(day);
  }
  return weeks;
}

export function shiftMonth({ year, month }: YearMonth, by: number): YearMonth {
  const m = month + by;
  return { year: year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 };
}

export function monthLabel({ year, month }: YearMonth): string {
  return `${MONTHS[month]} ${year}`;
}

function parts(t: number, timeZone: string): { year: number; month: number; day: number } {
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(t));
  const get = (type: string) => Number(p.find((x) => x.type === type)?.value);
  return { year: get("year"), month: get("month") - 1, day: get("day") };
}

/** The YYYY-MM-DD day an instant falls on in the coach's timezone ("" for an unparseable instant). */
export function dayKey(at: string | number | Date, timeZone: string): string {
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const { year, month, day } = parts(t, timeZone);
  return keyOf(year, month, day);
}

/** The month "now" falls in, in the coach's timezone. */
export function monthOf(now: Date, timeZone: string): YearMonth {
  const { year, month } = parts(now.getTime(), timeZone);
  return { year, month };
}

/** HH:MM in the coach's timezone. */
export function timeOf(at: string, timeZone: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
}

/** The chip a calendar event wears: the Deadlines panel's horizon colours, recomputed against the viewer's clock. */
export function chipTone(at: string, now: Date): DeadlineChip {
  return chipFor(at, now);
}

/** Deadlines and proposals as calendar events (declined proposals dropped), chips recomputed against now. */
export function calendarEvents(deadlines: readonly DeadlineView[], proposals: readonly ProposedTime[], now: Date): CalendarEvent[] {
  const out: CalendarEvent[] = deadlines.map((d) => ({
    id: d.id, source: "deadline", kind: d.kind, title: d.title, detail: d.detail, at: d.at, chip: chipTone(d.at, now), link: d.link,
  }));
  for (const p of proposals) {
    if (p.state === "declined") continue;
    out.push({
      id: `proposal:${p.id}`, source: "proposal", kind: p.state === "accepted" ? "fixture" : "proposal",
      title: `${p.state === "accepted" ? "Match" : "Proposed"} vs ${p.opponent}`, detail: p.detail, at: p.at, chip: chipTone(p.at, now), link: p.link,
    });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}

/** Events grouped by the day they fall on in the coach's timezone, each day in time order. */
export function eventsByDay(events: readonly CalendarEvent[], timeZone: string): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  for (const e of events) {
    const k = dayKey(e.at, timeZone);
    if (!k) continue;
    const list = map.get(k) ?? [];
    list.push(e);
    map.set(k, list);
  }
  for (const list of map.values()) list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return map;
}

/** The month's events in time order (the phone agenda). */
export function agenda(events: readonly CalendarEvent[], ym: YearMonth, timeZone: string): CalendarEvent[] {
  const prefix = `${ym.year}-${pad(ym.month + 1)}-`;
  return events.filter((e) => dayKey(e.at, timeZone).startsWith(prefix)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Weekly availability per weekday column (0 = Monday), sorted: shaded lightly on the matching days. */
export function availabilityByWeekday(blocks: readonly AvailabilityBlock[]): AvailabilityBlock[][] {
  return byDay(blocks);
}

/** The Schedule read as calendar rows: each agreed fixture time ("accepted", opens the fixture) and each slot of a
 *  pending proposal ("pending", opens it on the Schedule page). */
export function proposedTimesFrom(view: Pick<ScheduleView, "fixtures" | "proposals">): ProposedTime[] {
  const byRef = new Map(view.fixtures.map((f) => [f.ref, f]));
  const out: ProposedTime[] = [];
  for (const f of view.fixtures) {
    if (!f.scheduled) continue;
    out.push({ id: `agreed:${f.ref}`, at: f.scheduled.start, opponent: f.opponent?.coach ?? f.opponentTeam, detail: f.competition, link: f.link, state: "accepted", mine: false });
  }
  for (const p of view.proposals) {
    const f = byRef.get(p.fixture);
    if (p.status !== "pending" || !f) continue;
    p.slots.forEach((s, i) => out.push({
      id: `${p.id}:${i}`, at: s.start, opponent: p.mine ? p.to : p.from, detail: f.competition, link: `/schedule?proposal=${encodeURIComponent(p.id)}`, state: "pending", mine: p.mine,
    }));
  }
  return out;
}

/** Agreed and proposed times for the calendar (GET /api/schedule/mine). No fetcher, or a failed read: none. */
export async function loadProposals(api?: Fetcher): Promise<ProposedTime[]> {
  if (!api) return [];
  try { return proposedTimesFrom(await scheduleApi.mine(api)); } catch { return []; }
}

/** The zone the calendar keys days in. The freshly loaded scheduling timezone (saved, else detected) is the authority;
 *  the nav tree's cached zone only stands in while scheduling is still loading (or failed), then the browser's. */
export function calendarZone(src: { scheduleLoaded: boolean; scheduleZone: string; treeZone: string; browserZone: string }): string {
  if (src.scheduleLoaded && src.scheduleZone) return src.scheduleZone;
  return src.treeZone || src.scheduleZone || src.browserZone;
}

/** The next `limit` events from today (in the coach's timezone) onward, across months, in time order. Earlier today still counts. */
export function upcomingEvents(events: readonly CalendarEvent[], now: Date, timeZone: string, limit = 5): CalendarEvent[] {
  const today = dayKey(now, timeZone);
  return events
    .filter((e) => { const k = dayKey(e.at, timeZone); return k !== "" && k >= today; })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

const TONE_RANK: Record<DeadlineChip, number> = { overdue: 0, ok: 1, soon: 2, urgent: 3 };

/** The tone a day's marker wears: the most pressing chip among its events ("" for an empty day). */
export function dayTone(list: readonly CalendarEvent[] | undefined): DeadlineChip | "" {
  let best: DeadlineChip | "" = "";
  for (const e of list ?? []) if (best === "" || TONE_RANK[e.chip] > TONE_RANK[best]) best = e.chip;
  return best;
}

/** "Fri 30 Oct" for an instant, in the coach's timezone. */
export function shortDate(at: string, timeZone: string): string {
  const k = dayKey(at, timeZone);
  if (!k) return "";
  const d = new Date(`${k}T00:00:00Z`);
  return `${WEEKDAY_LABELS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)}`;
}
