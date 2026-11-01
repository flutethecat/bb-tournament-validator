// Coach Schedule (spec-main-landing-nav §4.6, ruling §7): the data layer of /app/schedule. Reads GET /api/schedule/mine
// and writes POST /api/schedule/propose and /respond (src/schedule/api.ts); renders only what they answer. Pure helpers
// for the month / week / day calendars, the propose dialog's hour picker (conflict suppression, unsocial hours in the
// opponent's timezone) and the list view's three groups. No DOM.

import { reactive, ref, type InjectionKey, type Ref } from "vue";
import type { Fetcher } from "../session";

export const SLOT_HOURS = 2;
export const SLOT_MS = SLOT_HOURS * 3_600_000;
export const MAX_SLOTS = 3;
export const SOCIAL_START = 9 * 60;
export const SOCIAL_END = 22 * 60;

export interface Interval { start: string; end: string }
export interface AgreedTime extends Interval { agreedAt: string }
export interface AvailabilityBlock { day: number; start: string; end: string }

export interface ScheduleOpponent {
  coach: string;
  /** Absent when proposals are off between the two coaches (blocked): only the name is shown. */
  timezone?: string | null;
  availability?: AvailabilityBlock[];
  busy?: Interval[];
}

export interface ScheduleFixture {
  ref: string;
  kind: "league" | "tournament";
  title: string;
  competition: string;
  round: number;
  myTeam: string;
  opponentTeam: string;
  opponent: ScheduleOpponent | null;
  deadline?: string;
  scheduled?: AgreedTime;
  /** SPA path: the league fixture lobby, or the tournament's rounds. */
  link: string;
  canPropose: boolean;
  reason?: string;
  pendingProposal?: string;
}

export type ProposalState = "pending" | "accepted" | "declined" | "countered" | "withdrawn" | "superseded" | "expired";

export interface ScheduleProposal {
  id: string;
  fixture: string;
  from: string;
  to: string;
  mine: boolean;
  slots: Interval[];
  status: ProposalState;
  createdAt: string;
  answeredAt?: string;
  acceptedSlot?: string;
  counterOf?: string;
}

export interface ScheduleView {
  coach: string;
  timezone: string;
  availability: AvailabilityBlock[];
  fixtures: ScheduleFixture[];
  proposals: ScheduleProposal[];
  counts: { toAnswer: number; waiting: number; needToSchedule: number; scheduled: number };
}

export interface SlotWarning { code: "unsocial" | "no-timezone" | "after-deadline"; slot?: string; text: string }

export const scheduleApi = {
  mine: (f: Fetcher) => f<ScheduleView>("/api/schedule/mine"),
  pending: (f: Fetcher) => f<{ pending: number }>("/api/schedule/pending"),
  propose: (f: Fetcher, fixture: string, slots: string[]) =>
    f<{ proposal: ScheduleProposal; warnings: SlotWarning[] }>("/api/schedule/propose", { method: "POST", body: { fixture, slots } }),
  accept: (f: Fetcher, proposalId: string, slot: string) =>
    f<{ proposal: ScheduleProposal; scheduled: AgreedTime }>("/api/schedule/respond", { method: "POST", body: { proposalId, action: "accept", slot } }),
  counter: (f: Fetcher, proposalId: string, slots: string[]) =>
    f<{ proposal: ScheduleProposal; warnings: SlotWarning[] }>("/api/schedule/respond", { method: "POST", body: { proposalId, action: "counter", slots } }),
  decline: (f: Fetcher, proposalId: string) => f<{ proposal: ScheduleProposal }>("/api/schedule/respond", { method: "POST", body: { proposalId, action: "decline" } }),
  withdraw: (f: Fetcher, proposalId: string) => f<{ proposal: ScheduleProposal }>("/api/schedule/respond", { method: "POST", body: { proposalId, action: "withdraw" } }),
};

/** The router link that opens the propose dialog for a fixture. */
export const proposePath = (ref: string): string => `/schedule?propose=${encodeURIComponent(ref)}`;
export const leagueFixtureRef = (leagueId: string, seasonId: string, fixtureId: string): string => `league:${leagueId}:${seasonId}:${fixtureId}`;
export const tournamentFixtureRef = (matchId: string): string => `tournament:${matchId}`;
/** The fixture ref of a league lobby path (/leagues/<id>/seasons/<season>/fixtures/<fixture>/lobby), else undefined. */
export function refFromLobbyPath(path: string): string | undefined {
  const m = path.match(/^\/leagues\/([a-z0-9-]{1,64})\/seasons\/([a-z0-9-]{1,64})\/fixtures\/([^/]{1,240})\/lobby$/);
  if (!m) return undefined;
  try { return leagueFixtureRef(m[1]!, m[2]!, decodeURIComponent(m[3]!)); } catch { return undefined; }
}

// ---- time zones -----------------------------------------------------------------------------------------------------

export function validZone(tz: string | null | undefined): tz is string {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

const pad = (n: number) => String(n).padStart(2, "0");

function wall(t: number, zone: string): { y: number; mo: number; d: number; h: number; mi: number; weekday: number } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const g = (type: string) => Number(p.find((x) => x.type === type)?.value);
  const y = g("year"); const mo = g("month") - 1; const d = g("day");
  return { y, mo, d, h: g("hour"), mi: g("minute"), weekday: (new Date(Date.UTC(y, mo, d)).getUTCDay() + 6) % 7 };
}

/** YYYY-MM-DD of an instant in the zone. */
export function dayKeyIn(t: number, zone: string): string {
  const w = wall(t, zone);
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)}`;
}

/** Minutes after local midnight in the zone. */
export function minutesIn(t: number, zone: string): number {
  const w = wall(t, zone);
  return w.h * 60 + w.mi;
}

/** HH:MM in the zone. */
export function clockIn(t: number, zone: string): string {
  const w = wall(t, zone);
  return `${pad(w.h)}:${pad(w.mi)}`;
}

/** The instant of a local wall time (day key + minutes) in the zone (DST gaps resolve forward). */
export function zonedInstant(dayKey: string, minutes: number, zone: string): number {
  const [y, mo, d] = dayKey.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const w = wall(t, zone);
    const asUtc = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
    const diff = asUtc - guess;
    if (diff === 0) break;
    t -= diff;
  }
  return t;
}

export function addDays(dayKey: string, n: number): string {
  const [y, mo, d] = dayKey.split("-").map(Number) as [number, number, number];
  const x = new Date(Date.UTC(y, mo - 1, d + n));
  return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}-${pad(x.getUTCDate())}`;
}

/** 0 = Monday .. 6 = Sunday. */
export function weekdayOf(dayKey: string): number {
  const [y, mo, d] = dayKey.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;
}

/** The Monday-first week holding the day. */
export function weekOf(dayKey: string): string[] {
  const monday = addDays(dayKey, -weekdayOf(dayKey));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sat 7 Nov". */
export function dayLabel(dayKey: string): string {
  const [, mo, d] = dayKey.split("-").map(Number) as [number, number, number];
  return `${WD[weekdayOf(dayKey)]} ${d} ${MON[mo - 1]}`;
}
/** "Sat 7 Nov, 19:00" in the zone. */
export function whenIn(at: string | number, zone: string): string {
  const t = typeof at === "number" ? at : Date.parse(at);
  return `${dayLabel(dayKeyIn(t, zone))}, ${clockIn(t, zone)}`;
}
/** "19:00-21:00" for a slot start in the zone. */
export function slotRange(start: string | number, zone: string): string {
  const t = typeof start === "number" ? start : Date.parse(start);
  return `${clockIn(t, zone)}-${clockIn(t + SLOT_MS, zone)}`;
}

// ---- slot checks (mirror src/schedule/api.ts) -----------------------------------------------------------------------

/** The whole 2-hour slot lies within 09:00-22:00 on one day in the zone. */
export function socialSlot(start: number, zone: string): boolean {
  return dayKeyIn(start, zone) === dayKeyIn(start + SLOT_MS, zone) && minutesIn(start, zone) >= SOCIAL_START && minutesIn(start + SLOT_MS, zone) <= SOCIAL_END;
}

const overlaps = (a: number, b: number, c: number, d: number): boolean => a < d && c < b;

/** My confirmed games (agreed times of my open fixtures), except one fixture. */
export function myBusy(view: Pick<ScheduleView, "fixtures">, exceptRef?: string): Interval[] {
  return view.fixtures.filter((f) => f.scheduled && f.ref !== exceptRef).map((f) => ({ start: f.scheduled!.start, end: f.scheduled!.end }));
}

export type SlotState = "ok" | "past" | "clash";

/** Whether a 2-hour slot starting at `start` can be offered (conflict suppression: either coach's confirmed games). */
export function slotState(start: number, busy: readonly Interval[], now: number): SlotState {
  if (start <= now) return "past";
  if (busy.some((b) => overlaps(start, start + SLOT_MS, Date.parse(b.start), Date.parse(b.end)))) return "clash";
  return "ok";
}

/** The opponent usually plays then: the slot lies inside one of their weekly availability blocks (their zone). */
export function inAvailability(start: number, blocks: readonly AvailabilityBlock[] | undefined, zone: string | null | undefined): boolean {
  if (!blocks?.length || !validZone(zone)) return false;
  const day = weekdayOf(dayKeyIn(start, zone));
  const a = minutesIn(start, zone);
  const b = a + SLOT_HOURS * 60;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  return blocks.some((x) => x.day === day && mins(x.start) <= a && b <= mins(x.end));
}

/** Warnings before send: no timezone, unsocial hours in the opponent's zone, after the deadline. Still sendable. */
export function warningsFor(slots: readonly number[], opponentZone: string | null | undefined, deadline?: string): SlotWarning[] {
  const out: SlotWarning[] = [];
  if (!validZone(opponentZone)) out.push({ code: "no-timezone", text: "The opposing coach has no timezone set, so we cannot check their local time." });
  else for (const s of slots) if (!socialSlot(s, opponentZone)) out.push({ code: "unsocial", slot: new Date(s).toISOString(), text: `${slotRange(s, opponentZone)} for the opposing coach (${opponentZone}), outside 09:00-22:00.` });
  const dl = deadline ? Date.parse(deadline) : Number.NaN;
  if (Number.isFinite(dl)) for (const s of slots) if (s + SLOT_MS > dl) out.push({ code: "after-deadline", slot: new Date(s).toISOString(), text: "After the fixture's deadline. The organisers' rules decide whether it counts." });
  return out;
}

/** Toggling a candidate: on (when fewer than 3 and not overlapping another) or off. Returns the new sorted list. */
export function toggleSlot(slots: readonly number[], start: number): number[] {
  if (slots.includes(start)) return slots.filter((s) => s !== start);
  if (slots.length >= MAX_SLOTS) return [...slots];
  if (slots.some((s) => overlaps(s, s + SLOT_MS, start, start + SLOT_MS))) return [...slots];
  return [...slots, start].sort((a, b) => a - b);
}

// ---- calendar events ------------------------------------------------------------------------------------------------

export interface CalEvent {
  id: string;
  kind: "confirmed" | "proposal";
  start: number;
  end: number;
  title: string;
  detail: string;
  fixture: string;
  /** Confirmed: the fixture lobby / tournament rounds. */
  link?: string;
  proposalId?: string;
  /** Proposal sent by the viewer (waiting for the opponent). */
  mine?: boolean;
}

/** Confirmed games (solid) and every slot of a pending proposal (PENDING, 60 % opacity). */
export function calendarEvents(view: Pick<ScheduleView, "fixtures" | "proposals">): CalEvent[] {
  const byRef = new Map(view.fixtures.map((f) => [f.ref, f]));
  const out: CalEvent[] = [];
  for (const f of view.fixtures) {
    if (!f.scheduled) continue;
    out.push({ id: `c:${f.ref}`, kind: "confirmed", start: Date.parse(f.scheduled.start), end: Date.parse(f.scheduled.end), title: f.title, detail: f.competition, fixture: f.ref, link: f.link });
  }
  for (const p of view.proposals) {
    if (p.status !== "pending") continue;
    const f = byRef.get(p.fixture);
    if (!f) continue;
    p.slots.forEach((s, i) => out.push({
      id: `p:${p.id}:${i}`, kind: "proposal", start: Date.parse(s.start), end: Date.parse(s.end), title: f.title,
      detail: p.mine ? `Waiting for ${p.to}` : `From ${p.from}`, fixture: p.fixture, proposalId: p.id, mine: p.mine,
    }));
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Events per local day key (an event is filed under the day it starts on). */
export function eventsByDay(events: readonly CalEvent[], zone: string): Map<string, CalEvent[]> {
  const map = new Map<string, CalEvent[]>();
  for (const e of events) {
    const k = dayKeyIn(e.start, zone);
    map.set(k, [...(map.get(k) ?? []), e]);
  }
  return map;
}

/** Position of an event inside a day column (fractions of the day, clipped to it). */
export function dayBox(e: Pick<CalEvent, "start" | "end">, dayKey: string, zone: string): { top: number; height: number } | undefined {
  const d0 = zonedInstant(dayKey, 0, zone);
  const d1 = zonedInstant(addDays(dayKey, 1), 0, zone);
  const a = Math.max(e.start, d0);
  const b = Math.min(e.end, d1);
  if (b <= a) return undefined;
  return { top: (a - d0) / (d1 - d0), height: (b - a) / (d1 - d0) };
}

// ---- list view ------------------------------------------------------------------------------------------------------

export interface ListGroups {
  scheduled: ScheduleFixture[];
  proposed: Array<{ proposal: ScheduleProposal; fixture: ScheduleFixture }>;
  need: ScheduleFixture[];
}

/** Scheduled (agreed time) · Proposed (pending offers either way) · Need to schedule (no time, nothing pending). */
export function listGroups(view: Pick<ScheduleView, "fixtures" | "proposals">): ListGroups {
  const byRef = new Map(view.fixtures.map((f) => [f.ref, f]));
  const pendingRefs = new Set<string>();
  const proposed: ListGroups["proposed"] = [];
  for (const p of view.proposals) {
    const f = byRef.get(p.fixture);
    if (p.status !== "pending" || !f) continue;
    pendingRefs.add(p.fixture);
    proposed.push({ proposal: p, fixture: f });
  }
  proposed.sort((a, b) => Number(a.proposal.mine) - Number(b.proposal.mine) || a.proposal.slots[0]!.start.localeCompare(b.proposal.slots[0]!.start));
  return {
    scheduled: view.fixtures.filter((f) => f.scheduled).sort((a, b) => a.scheduled!.start.localeCompare(b.scheduled!.start)),
    proposed,
    need: view.fixtures.filter((f) => !f.scheduled && !pendingRefs.has(f.ref)),
  };
}

export const STATE_TEXT: Record<ProposalState, string> = {
  pending: "Pending", accepted: "Accepted", declined: "Declined", countered: "Countered", withdrawn: "Withdrawn", superseded: "Replaced", expired: "Expired",
};

// ---- the page's store -----------------------------------------------------------------------------------------------

export interface ScheduleStore {
  state: { view: ScheduleView | null; loading: boolean; error: string; busy: string; notice: string };
  load(): Promise<void>;
  /** Runs a write; reloads the view after it. Returns the answer, or undefined after an error (shown in state.error). */
  run<T>(key: string, write: () => Promise<T>, notice?: string): Promise<T | undefined>;
}

export function createScheduleStore(fetcher: Fetcher, onChanged?: () => void): ScheduleStore {
  const state = reactive<ScheduleStore["state"]>({ view: null, loading: false, error: "", busy: "", notice: "" });
  let seq = 0;
  async function load(): Promise<void> {
    const mine = ++seq;
    state.loading = true;
    try {
      const view = await scheduleApi.mine(fetcher);
      if (mine === seq) { state.view = view; state.error = ""; }
    } catch (e) {
      if (mine === seq) state.error = (e as Error).message;
    } finally {
      if (mine === seq) state.loading = false;
    }
  }
  async function run<T>(key: string, write: () => Promise<T>, notice = ""): Promise<T | undefined> {
    if (state.busy) return undefined;
    state.busy = key;
    state.error = "";
    state.notice = "";
    let failed = "";
    try {
      const out = await write();
      state.notice = notice;
      onChanged?.();
      return out;
    } catch (e) {
      failed = (e as Error).message || "Something went wrong.";
      return undefined;
    } finally {
      await load();
      // After the reload (which clears a stale read error): the write's own error stays visible.
      if (failed) state.error = failed;
      state.busy = "";
    }
  }
  return { state, load, run };
}

// ---- nav badge ------------------------------------------------------------------------------------------------------

export interface ProposalsBadge {
  /** Proposals waiting for the signed-in coach's answer. */
  pending: Ref<number>;
  load(): Promise<void>;
  set(n: number): void;
}

export function createProposalsBadge(fetcher: Fetcher): ProposalsBadge {
  const pending = ref(0);
  let inFlight: Promise<void> | undefined;
  return {
    pending,
    load() {
      inFlight ??= (async () => {
        try {
          const res = await scheduleApi.pending(fetcher);
          pending.value = typeof res.pending === "number" && res.pending > 0 ? Math.floor(res.pending) : 0;
        } catch { /* keep the last count */ }
        finally { inFlight = undefined; }
      })();
      return inFlight;
    },
    set(n) { pending.value = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; },
  };
}

export const PROPOSALS_KEY: InjectionKey<ProposalsBadge> = Symbol("proposals");
