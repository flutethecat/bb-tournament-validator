// League Calendar tab (UX-C, owner 11-02: "a proper calendar view with week/month/year views. Events should be clickable
// and populate their related event"): the pure model behind LeagueCalendar.vue. Every day and clock time is read in the
// league's time zone (src/leagues/timeZone.ts leagueTimeZone, sent on the public league summary), never the viewer's.
//
// Events come from SOURCES: a source turns what a season read already carries into CalendarItems. Fixtures are the only
// source today. League Events, deadlines and gates (not built yet) plug in as further sources with their own `type`;
// the views draw every type the same way and read only the fields below, so a new source needs no view change.

import { fixturePlayed } from "./league";
import { leagueLobbyPath } from "./lobby";
import type { LeagueFixture } from "./types";
import { addDays, clockIn, dayKeyIn, validZone, weekOf, weekdayOf, zonedInstant } from "../schedule/schedule";
import { roundLabel } from "../shell/sectionViews";

// ---- views ----------------------------------------------------------------------------------------------------------

export type CalendarView = "list" | "week" | "month" | "year";
export const CALENDAR_VIEWS: ReadonlyArray<{ id: CalendarView; label: string }> = [
  { id: "list", label: "List" }, { id: "week", label: "Week" }, { id: "month", label: "Month" }, { id: "year", label: "Year" },
];
export const DEFAULT_CALENDAR_VIEW: CalendarView = "month";
/** localStorage key of the viewer's last view (one choice for every league). */
export const CALENDAR_VIEW_KEY = "sf-league-calendar-view";

const isView = (v: unknown): v is CalendarView => CALENDAR_VIEWS.some((x) => x.id === v);

/** The viewer's remembered view; the default when storage is blocked, empty or holds something else. */
export function loadCalendarView(storage: () => Pick<Storage, "getItem"> | undefined): CalendarView {
  try {
    const v = storage()?.getItem(CALENDAR_VIEW_KEY);
    return isView(v) ? v : DEFAULT_CALENDAR_VIEW;
  } catch { return DEFAULT_CALENDAR_VIEW; }
}

/** Remembers the view; a blocked storage keeps the choice for this visit only. */
export function saveCalendarView(storage: () => Pick<Storage, "setItem"> | undefined, view: CalendarView): void {
  try { storage()?.setItem(CALENDAR_VIEW_KEY, view); } catch { /* private window or blocked storage: in memory only */ }
}

// ---- items ----------------------------------------------------------------------------------------------------------

/** What an item is. Only "fixture" has a source today; the rest are the extension point (see calendarItems). */
export type CalendarEventType = "fixture" | "league-event" | "deadline" | "gate";
export type CalendarItemState = "played" | "agreed" | "scheduled";

export interface CalendarItem {
  /** Unique across sources: "<type>:<id>". */
  key: string;
  type: CalendarEventType;
  /** YYYY-MM-DD in the league zone. */
  day: string;
  /** No clock time (a date-only fixture): the week view's all-day row. */
  allDay: boolean;
  /** Timed items: the instants (ms) of the start and end. */
  start?: number;
  end?: number;
  /** "19:00" in the league zone, "" when all-day. */
  time: string;
  /** Full title ("Home v Away") and the chip's short one. */
  title: string;
  short: string;
  /** "2 - 1" once played, else "". */
  result: string;
  state: CalendarItemState;
  /** The line under the title ("Round 3", "Playoffs · Round 1"). */
  detail: string;
  /** SPA path of the related item (router-relative) and what it is. */
  to: string;
  target: "game" | "summary";
  /** Accessible name of the link. */
  label: string;
}

export interface CalendarContext { leagueId: string; seasonId: string; zone: string }
/** One kind of event: what a season read carries, as items. */
export type CalendarSource = (ctx: CalendarContext) => CalendarItem[];

/** "The Lady's Prized Lances" -> "Lady's Prized…": a chip-sized name (whole words, about 14 characters). */
export function shortTeam(name: string): string {
  const n = name.replace(/^the\s+/i, "").trim() || name.trim();
  if (n.length <= 14) return n;
  let out = "";
  for (const w of n.split(/\s+/)) {
    const next = out ? `${out} ${w}` : w;
    if (next.length > 13) break;
    out = next;
  }
  return `${out || n.slice(0, 12)}…`;
}

const at = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
};
const isDay = (s: string | undefined): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const MIN = 60_000;

/**
 * Where a fixture opens (owner 11-02): a played fixture opens its game page (the match report) when the site holds one
 * (a finished Super FUMBBL game: the season read carries its game id then), else the fixture summary; an unplayed one
 * opens the fixture summary (the fixture lobby route).
 */
export function fixtureLink(f: Pick<LeagueFixture, "id" | "home" | "away" | "suspended" | "fork">, ctx: Pick<CalendarContext, "leagueId" | "seasonId">): { to: string; target: "game" | "summary" } {
  const gameId = f.fork?.status === "finished" ? f.fork.gameId : undefined;
  if (fixturePlayed(f) && gameId) return { to: `/games/online/${encodeURIComponent(gameId)}`, target: "game" };
  return { to: leagueLobbyPath(ctx.leagueId, ctx.seasonId, f.id), target: "summary" };
}

/**
 * The season's fixtures as items. The day: a played game on the day it finished, an agreed game time on its day, else
 * the organiser's scheduled date (date only), else a played game's start. Fixtures with no date at all are left out
 * (counted by undatedFixtures). Played games are timed from their start (when it is sane) to their finish.
 */
export function fixtureItems(fixtures: readonly LeagueFixture[], ctx: CalendarContext): CalendarItem[] {
  const zone = validZone(ctx.zone) ? ctx.zone : "UTC";
  const out: CalendarItem[] = [];
  for (const f of fixtures) {
    const played = fixturePlayed(f); // a suspended 0-0 TourPlay row is not a result
    const finished = played ? at(f.finishedAt) : undefined;
    const startedAt = at(f.startedAt);
    const agreed = at(f.scheduledTime?.start);
    let start: number | undefined;
    let end: number | undefined;
    let day = "";
    if (finished !== undefined) {
      start = startedAt !== undefined && startedAt <= finished && finished - startedAt <= 8 * 60 * MIN ? startedAt : finished;
      end = finished;
    } else if (agreed !== undefined) {
      start = agreed;
      end = at(f.scheduledTime?.end) ?? agreed + 120 * MIN;
    } else if (isDay(f.date)) {
      day = f.date;
    } else if (played && startedAt !== undefined) {
      start = startedAt;
      end = startedAt;
    } else continue;
    if (start !== undefined) day = dayKeyIn(finished ?? start, zone);
    const link = fixtureLink(f, ctx);
    const result = played ? `${f.home.score} - ${f.away.score}` : "";
    const title = `${f.home.team} v ${f.away.team}`;
    const state: CalendarItemState = played ? "played" : agreed !== undefined ? "agreed" : "scheduled";
    out.push({
      key: `fixture:${f.id}`, type: "fixture", day, allDay: start === undefined,
      ...(start !== undefined ? { start, end: Math.max(end ?? start, start) } : {}),
      time: start !== undefined ? clockIn(start, zone) : "",
      title, short: `${shortTeam(f.home.team)} v ${shortTeam(f.away.team)}`, result, state, detail: roundLabel(f),
      ...link,
      label: `${link.target === "game" ? "Match report" : "Fixture summary"}: ${played ? `${f.home.team} ${f.home.score}–${f.away.score} ${f.away.team}` : `${f.home.team} against ${f.away.team}`}`,
    });
  }
  return out;
}

/** Fixtures the calendar cannot place (no date of any kind). */
export function undatedFixtures(fixtures: readonly LeagueFixture[], ctx: CalendarContext): number {
  return fixtures.length - fixtureItems(fixtures, ctx).length;
}

/** Every source's items, sorted by day, then all-day first, then start time. Add League Events, deadlines and gates here. */
export function calendarItems(sources: readonly CalendarSource[], ctx: CalendarContext): CalendarItem[] {
  return sources.flatMap((s) => s(ctx)).sort(byWhen);
}

export function byWhen(a: CalendarItem, b: CalendarItem): number {
  return a.day.localeCompare(b.day) || Number(b.allDay) - Number(a.allDay) || (a.start ?? 0) - (b.start ?? 0) || a.title.localeCompare(b.title);
}

export function itemsByDay(items: readonly CalendarItem[]): Map<string, CalendarItem[]> {
  const map = new Map<string, CalendarItem[]>();
  for (const it of items) map.set(it.day, [...(map.get(it.day) ?? []), it]);
  return map;
}

// ---- dates (day keys are plain calendar days; the zone only decides which day an instant falls on) ------------------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");
const parts = (key: string): [number, number, number] => key.split("-").map(Number) as [number, number, number];
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based
const keyOf = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

/** Today in the league zone. */
export const todayIn = (now: number, zone: string): string => dayKeyIn(now, validZone(zone) ? zone : "UTC");

/** The anchor one step back or forward: a week is 7 days; a month or a year keeps the day, clamped to the month. */
export function shiftAnchor(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view === "week") return addDays(anchor, 7 * dir);
  const [y, m, d] = parts(anchor);
  const total = view === "year" ? (y + dir) * 12 + (m - 1) : y * 12 + (m - 1) + dir;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return keyOf(ny, nm, Math.min(d, daysIn(ny, nm)));
}

/** The date label: "3 – 9 Nov 2026" (across months/years spelled out), "November 2026", "2026"; List: "". */
export function rangeLabel(view: CalendarView, anchor: string): string {
  const [y, m] = parts(anchor);
  if (view === "year") return String(y);
  if (view === "month") return `${MONTHS[m - 1]} ${y}`;
  if (view !== "week") return "";
  const days = weekOf(anchor);
  const [ay, am, ad] = parts(days[0]!);
  const [by, bm, bd] = parts(days[6]!);
  if (ay !== by) return `${ad} ${MON[am - 1]} ${ay} – ${bd} ${MON[bm - 1]} ${by}`;
  if (am !== bm) return `${ad} ${MON[am - 1]} – ${bd} ${MON[bm - 1]} ${by}`;
  return `${ad} – ${bd} ${MON[bm - 1]} ${by}`;
}

export interface MonthCell { key: string; day: number; inMonth: boolean }

/** The Monday-first weeks covering a month (4 to 6 rows), days outside it marked. */
export function monthWeeks(anchor: string): MonthCell[][] {
  const [y, m] = parts(anchor);
  const first = keyOf(y, m, 1);
  const last = keyOf(y, m, daysIn(y, m));
  const weeks: MonthCell[][] = [];
  for (let start = addDays(first, -weekdayOf(first)); start <= last; start = addDays(start, 7)) {
    weeks.push(Array.from({ length: 7 }, (_, i) => {
      const key = addDays(start, i);
      const [ky, km, kd] = parts(key);
      return { key, day: kd, inMonth: ky === y && km === m };
    }));
  }
  return weeks;
}

/** The 12 months of the anchor's year, as month anchors (the 1st). */
export function yearMonths(anchor: string): Array<{ anchor: string; label: string; short: string }> {
  const [y] = parts(anchor);
  return MONTHS.map((label, i) => ({ anchor: keyOf(y, i + 1, 1), label: `${label} ${y}`, short: label }));
}

/** "Sat 7 Nov" style day heading parts. */
export function dayParts(key: string): { weekday: string; day: number; month: string; long: string } {
  const [y, m, d] = parts(key);
  const weekday = WEEKDAYS_SHORT[weekdayOf(key)]!;
  return { weekday, day: d, month: MON[m - 1]!, long: `${weekday} ${d} ${MONTHS[m - 1]} ${y}` };
}

/** Where the calendar opens: today when the season has an item in today's month, else the item day nearest today. */
export function initialAnchor(items: readonly CalendarItem[], today: string): string {
  if (!items.length || items.some((i) => i.day.slice(0, 7) === today.slice(0, 7))) return today;
  const t = Date.parse(`${today}T00:00:00Z`);
  let best = items[0]!.day;
  for (const i of items) if (Math.abs(Date.parse(`${i.day}T00:00:00Z`) - t) < Math.abs(Date.parse(`${best}T00:00:00Z`) - t)) best = i.day;
  return best;
}

// ---- month overflow ---------------------------------------------------------------------------------------------------

/** A month cell with room for `capacity` chips (at least one): the first ones, and how many more ("+N more" sits on
 *  the date line, so it takes no chip's room). */
export function splitOverflow<T>(items: readonly T[], capacity: number): { shown: T[]; more: number } {
  const cap = Math.max(1, Math.floor(capacity));
  return { shown: items.slice(0, cap), more: Math.max(0, items.length - cap) };
}

/** Year view heat: 0 none, 1 one fixture, 2 two or three, 3 four or more. */
export const heatLevel = (count: number): 0 | 1 | 2 | 3 => (count <= 0 ? 0 : count === 1 ? 1 : count <= 3 ? 2 : 3);

// ---- week time grid -------------------------------------------------------------------------------------------------

export interface WeekBlock { item: CalendarItem; top: number; height: number; lane: number; lanes: number }

/** Hours the week grid shows: from an hour before the week's first game to an hour after its last (at least 8 hours,
 *  within 00:00-24:00); 08:00-23:00 for a week without timed items. */
export function hourRange(items: readonly CalendarItem[], zone: string): [number, number] {
  let lo = 24;
  let hi = 0;
  for (const it of items) {
    if (it.allDay || it.start === undefined) continue;
    const s = dayKeyIn(it.start, zone) < it.day ? 0 : Number(clockIn(it.start, zone).slice(0, 2));
    const endClock = clockIn(it.end ?? it.start, zone);
    const e = dayKeyIn(it.end ?? it.start, zone) > it.day ? 24 : Math.ceil(Number(endClock.slice(0, 2)) + Number(endClock.slice(3)) / 60);
    lo = Math.min(lo, s);
    hi = Math.max(hi, e, s + 1);
  }
  if (lo > hi) return [8, 23];
  lo = Math.max(0, lo - 1);
  hi = Math.min(24, Math.max(hi + 1, lo + 8));
  return [Math.max(0, Math.min(lo, hi - 8)), hi];
}

/**
 * The timed items of one day as blocks inside the shown hours: top and height as fractions of the shown span (a block is
 * at least 30 minutes tall so a point-in-time result stays clickable), side by side in lanes where they overlap.
 * Uses wall-clock hours, so a DST day lays out like any other (an hour that does not exist is simply empty).
 */
export function dayBlocks(items: readonly CalendarItem[], day: string, zone: string, hours: [number, number]): WeekBlock[] {
  const z = validZone(zone) ? zone : "UTC";
  const span = (hours[1] - hours[0]) * 60;
  const timed = items.filter((i) => i.day === day && !i.allDay && i.start !== undefined).sort(byWhen);
  const placed = timed.map((item) => {
    const d0 = zonedInstant(day, 0, z);
    const startMin = item.start! <= d0 ? 0 : wallMinutes(item.start!, z);
    const endMin = dayKeyIn(item.end!, z) > day ? 24 * 60 : wallMinutes(item.end!, z);
    const a = Math.max(startMin, hours[0] * 60);
    const b = Math.max(Math.min(endMin, hours[1] * 60), Math.min(a + 30, hours[1] * 60));
    return { item, a, b };
  });
  const blocks: WeekBlock[] = [];
  let cluster: Array<{ item: CalendarItem; a: number; b: number; lane: number }> = [];
  let clusterEnd = -1;
  const flush = (): void => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) blocks.push({ item: c.item, top: (c.a - hours[0] * 60) / span, height: (c.b - c.a) / span, lane: c.lane, lanes });
    cluster = [];
  };
  for (const p of placed) {
    if (cluster.length && p.a >= clusterEnd) flush();
    const laneEnds = new Map<number, number>();
    for (const c of cluster) laneEnds.set(c.lane, Math.max(laneEnds.get(c.lane) ?? 0, c.b));
    let lane = 0;
    while ((laneEnds.get(lane) ?? -1) > p.a) lane++;
    cluster.push({ ...p, lane });
    clusterEnd = Math.max(clusterEnd, p.b);
  }
  if (cluster.length) flush();
  return blocks;
}

function wallMinutes(t: number, zone: string): number {
  const c = clockIn(t, zone);
  return Number(c.slice(0, 2)) * 60 + Number(c.slice(3));
}

// ---- list view ------------------------------------------------------------------------------------------------------

export interface ListDay { key: string; dayNo: number; weekday: string; items: CalendarItem[] }
export interface ListMonth { key: string; label: string; count: number; days: ListDay[] }

/** The List view: months (oldest first), the days that have items, their items in time order. */
export function listMonths(items: readonly CalendarItem[]): ListMonth[] {
  const months = new Map<string, ListMonth>();
  for (const [key, list] of [...itemsByDay(items)].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [y, m, d] = parts(key);
    const mk = key.slice(0, 7);
    const month = months.get(mk) ?? { key: mk, label: `${MONTHS[m - 1]} ${y}`, count: 0, days: [] };
    month.days.push({ key, dayNo: d, weekday: WEEKDAYS_SHORT[weekdayOf(key)]!, items: [...list].sort(byWhen) });
    month.count += list.length;
    months.set(mk, month);
  }
  return [...months.values()];
}

/** The days of a month that have items (phone agenda), today included when it is in the month. */
export function agendaDays(items: readonly CalendarItem[], anchor: string, today: string): ListDay[] {
  const mk = anchor.slice(0, 7);
  const byDay = itemsByDay(items);
  const keys = [...byDay.keys()].filter((k) => k.slice(0, 7) === mk);
  if (today.slice(0, 7) === mk && !keys.includes(today)) keys.push(today);
  return keys.sort().map((key) => ({ key, dayNo: parts(key)[2], weekday: WEEKDAYS_SHORT[weekdayOf(key)]!, items: [...(byDay.get(key) ?? [])].sort(byWhen) }));
}
