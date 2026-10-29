// Coach home page (/app/home) server side: the derived deadlines list (GET /api/me/deadlines), the availability
// editor's read/write (GET/PUT /api/me/scheduling) over the identity's CoachScheduling, and the read-only build log
// (GET /api/build-log). Pure functions; server.ts wires them to the stores.

import { readFileSync } from "node:fs";
import type { CoachScheduling } from "./auth/identitiesStore.js";
import type { MatchRecord } from "./tabletop/store.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentRecord } from "./tournaments/types.js";

// ---------------------------------------------------------------- deadlines

/** Chip by horizon: green > 72 h, amber < 72 h, scarlet < 24 h, grey once passed. */
export type DeadlineChip = "ok" | "soon" | "urgent" | "overdue";
export type DeadlineKind = "registration" | "checkIn" | "round" | "report" | "confirm";

export interface DeadlineRow {
  id: string;
  kind: DeadlineKind;
  title: string;
  /** Tournament or opponent context, shown under the title. */
  detail: string;
  /** ISO instant; the page renders it in the coach's timezone. */
  at: string;
  chip: DeadlineChip;
  /** SPA path (router form, no /app prefix). */
  link: string;
}

const HOUR = 3_600_000;
/** A played tabletop match should be reported (submitted, or confirmed by both coaches) within this window. */
export const REPORT_WINDOW_HOURS = 48;
export const MAX_DEADLINES = 50;

export function deadlineChip(at: string | number | Date, now: Date): DeadlineChip {
  const t = at instanceof Date ? at.getTime() : typeof at === "number" ? at : Date.parse(at);
  const left = t - now.getTime();
  if (!Number.isFinite(left) || left < 0) return "overdue";
  if (left < 24 * HOUR) return "urgent";
  if (left < 72 * HOUR) return "soon";
  return "ok";
}

const sameCoach = (a: string | undefined, b: string): boolean => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
const validIso = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);

/** Optional fields later lanes add to the records (spec §3 item 7, hub §5b); read defensively, never required. */
interface OptionalDeadlines { deadlines?: { registration?: unknown; checkIn?: unknown } }
interface OptionalFixtureDeadline { deadline?: unknown }

export interface DeadlineSources {
  coach: string;
  tournaments: TournamentRecord[];
  entrants: (tournamentId: string) => TournamentEntrantRecord[];
  matches: (tournamentId: string) => ScheduledMatchRecord[];
  tabletop: MatchRecord[];
  now: Date;
}

/** Every deadline the coach faces, nearest first: tournament registration / check-in (when the record carries them),
 *  fixture round deadlines (when the fixture carries one), and the report-by of played-but-unreported tabletop matches. */
export function deriveDeadlines(src: DeadlineSources): DeadlineRow[] {
  const { coach, now } = src;
  const rows: DeadlineRow[] = [];
  const push = (row: Omit<DeadlineRow, "chip">) => rows.push({ ...row, chip: deadlineChip(row.at, now) });

  for (const t of src.tournaments) {
    if (t.status === "completed" || t.status === "cancelled") continue;
    const entrants = src.entrants(t.id);
    const mine = entrants.find((e) => !e.droppedAt && sameCoach(e.coach.ffbCoachId, coach));
    if (!mine) continue;
    const link = `/tournaments/${encodeURIComponent(t.id)}`;
    const d = (t as TournamentRecord & OptionalDeadlines).deadlines;
    const registration = validIso(d?.registration);
    if (registration && t.status === "draft") push({ id: `reg:${t.id}`, kind: "registration", title: "Registration closes", detail: t.name, at: registration, link });
    const checkIn = validIso(d?.checkIn);
    if (checkIn && !mine.flags?.checkedIn) push({ id: `checkin:${t.id}`, kind: "checkIn", title: "Check in", detail: t.name, at: checkIn, link });
    for (const m of src.matches(t.id)) {
      if (m.status === "completed" || m.status === "cancelled" || m.status === "dismissed" || m.result) continue;
      const home = m.home.entrantId === mine.id;
      if (!home && m.away?.entrantId !== mine.id) continue;
      const deadline = validIso((m as ScheduledMatchRecord & OptionalFixtureDeadline).deadline);
      if (!deadline) continue;
      const opp = home ? m.away?.coach.ffbCoachId : m.home.coach.ffbCoachId;
      push({
        id: `round:${m.id}`, kind: "round", title: `Round ${m.roundNumber}${opp ? ` vs ${opp}` : " (bye)"}`, detail: t.name, at: deadline,
        link: `${link}?tab=rounds`,
      });
    }
  }

  for (const m of src.tabletop) {
    if (m.test) continue;
    const isHome = sameCoach(m.home.coach, coach);
    if (!isHome && !sameCoach(m.away.coach, coach)) continue;
    const opp = isHome ? m.away.coach : m.home.coach;
    const base = Date.parse(m.updatedAt);
    if (!Number.isFinite(base)) continue;
    const at = new Date(base + REPORT_WINDOW_HOURS * HOUR).toISOString();
    const link = `/tabletop/${encodeURIComponent(m.id)}`;
    const ended = m.clock && m.clock.activeTeam === null && m.clock.turn >= 8 && m.clock.half !== 1;
    if (m.state === "recording" && ended) {
      push({ id: `report:${m.id}`, kind: "report", title: `Report the result vs ${opp}`, detail: `${m.home.teamName} v ${m.away.teamName}`, at, link });
    } else if (m.state === "submitted" && !Object.keys(m.confirmations ?? {}).some((c) => sameCoach(c, coach))) {
      push({ id: `confirm:${m.id}`, kind: "confirm", title: `Confirm the result vs ${opp}`, detail: `${m.home.teamName} v ${m.away.teamName}`, at, link });
    }
  }

  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
  return rows.slice(0, MAX_DEADLINES);
}

// ---------------------------------------------------------------- scheduling

/** API day index -> the identity store's day code. 0 = Monday, matching the week grid's first column. */
export const DAY_CODES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export const MAX_SCHEDULE_BLOCKS = 21;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleBlock { day: number; start: string; end: string }
export interface SchedulingView { timezone: string; availability: ScheduleBlock[] }

export class SchedulingError extends Error {}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Validates a PUT body: { timezone, availability: [{ day 0-6, start "HH:MM", end "HH:MM" }] }, start < end, at most 21 blocks. */
export function parseSchedulingInput(body: unknown): SchedulingView {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new SchedulingError("A JSON object is required.");
  const b = body as Record<string, unknown>;
  const timezone = b.timezone === undefined || b.timezone === null ? "" : b.timezone;
  if (typeof timezone !== "string") throw new SchedulingError("timezone must be a string.");
  const tz = timezone.trim();
  if (tz && !isValidTimeZone(tz)) throw new SchedulingError("timezone must be an IANA time zone, e.g. Europe/London.");
  const list = b.availability === undefined ? [] : b.availability;
  if (!Array.isArray(list)) throw new SchedulingError("availability must be an array.");
  if (list.length > MAX_SCHEDULE_BLOCKS) throw new SchedulingError(`availability can hold at most ${MAX_SCHEDULE_BLOCKS} blocks.`);
  const seen = new Set<string>();
  const availability = list.map((raw, i): ScheduleBlock => {
    const f = `availability[${i}]`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SchedulingError(`${f} must be an object.`);
    const item = raw as Record<string, unknown>;
    if (typeof item.day !== "number" || !Number.isInteger(item.day) || item.day < 0 || item.day > 6) throw new SchedulingError(`${f}.day must be 0 (Monday) to 6 (Sunday).`);
    if (typeof item.start !== "string" || !HHMM.test(item.start)) throw new SchedulingError(`${f}.start must be a 24-hour time in HH:MM format.`);
    if (typeof item.end !== "string" || !HHMM.test(item.end)) throw new SchedulingError(`${f}.end must be a 24-hour time in HH:MM format.`);
    if (item.start >= item.end) throw new SchedulingError(`${f}: start must be before end.`);
    const key = `${item.day}|${item.start}|${item.end}`;
    if (seen.has(key)) throw new SchedulingError(`${f} repeats another block.`);
    seen.add(key);
    return { day: item.day, start: item.start, end: item.end };
  });
  availability.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return { timezone: tz, availability };
}

/** The identity's stored scheduling as the API shows it (day codes -> 0-6; unknown codes dropped). */
export function schedulingView(stored: CoachScheduling | undefined): SchedulingView {
  const availability: ScheduleBlock[] = [];
  for (const a of stored?.availability ?? []) {
    const day = DAY_CODES.indexOf(a.day.toLowerCase() as (typeof DAY_CODES)[number]);
    if (day >= 0) availability.push({ day, start: a.start, end: a.end });
  }
  availability.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start));
  return { timezone: stored?.timezone ?? "", availability };
}

/** A validated view in the identity store's shape (the account PATCH's `scheduling` field). */
export function toStoredScheduling(view: SchedulingView): CoachScheduling {
  return {
    ...(view.timezone ? { timezone: view.timezone } : {}),
    availability: view.availability.map((b) => ({ day: DAY_CODES[b.day]!, start: b.start, end: b.end })),
  };
}

// ---------------------------------------------------------------- build log

export interface BuildLogLink { label: string; href: string }
export interface BuildLogEntry { date: string; version?: string; title: string; body: string; links: BuildLogLink[] }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Links stay on this site (a root-relative path) or go to an https page. */
const SAFE_HREF = /^(\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/;

function entryOf(raw: unknown): BuildLogEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);
  const date = typeof r.date === "string" && DATE.test(r.date) ? r.date : undefined;
  const title = str(r.title, 160);
  const body = str(r.body, 2000);
  if (!date || !title || !body) return undefined;
  const version = str(r.version, 40);
  const links = (Array.isArray(r.links) ? r.links : [])
    .map((l) => {
      const o = l && typeof l === "object" ? (l as Record<string, unknown>) : {};
      const label = str(o.label, 80);
      const href = typeof o.href === "string" && SAFE_HREF.test(o.href) && o.href.length <= 300 ? o.href : undefined;
      return label && href ? { label, href } : undefined;
    })
    .filter((l): l is BuildLogLink => l !== undefined)
    .slice(0, 8);
  return { date, ...(version ? { version } : {}), title, body, links };
}

/** Parses the build log: malformed entries are dropped; newest date first, and within a date the later-appended entry first. */
export function parseBuildLog(text: string): BuildLogEntry[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r, i) => ({ e: entryOf(r), i }))
    .filter((x): x is { e: BuildLogEntry; i: number } => x.e !== undefined)
    .sort((a, b) => b.e.date.localeCompare(a.e.date) || b.i - a.i)
    .map((x) => x.e);
}

export function readBuildLog(file: string): BuildLogEntry[] {
  try { return parseBuildLog(readFileSync(file, "utf8")); } catch { return []; }
}
