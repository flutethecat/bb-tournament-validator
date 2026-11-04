// Gates (league ladder spec, "Gates (11-02)"; lane 8c): the SPA side of src/leagues/gates.ts. Types of the read model, the
// API calls, a per-league gates store shared by every editor and banner on a page, the countdown text, and the editor's pure
// form helpers. No DOM. The server is the authority: it refuses a shut step and says when it opens; the pages only count
// down from the opening instant the server sent.

import { reactive } from "vue";
import type { Fetcher } from "../session";
import { validZone } from "../schedule/schedule";
import type { GateView as CalendarGate } from "./leagueEvents";

export type GateKind = "redraft-window" | "redraft-rest" | "redraft-submit" | "season-start" | "ladder-challenges" | "registration" | "honours-reveal";

export interface GateView {
  id: string;
  kind: GateKind;
  target: string;
  targetName: string;
  label: string;
  title: string;
  state: "shut" | "open";
  opensAt: string | null;
  secondsLeft: number | null;
  mode: "time" | "event";
  wall?: string;
  eventId?: string;
  eventTitle?: string;
  eventMissing?: boolean;
  offsetMinutes?: number;
  autoStart?: boolean;
  openedAt?: string;
  openedBy?: "schedule" | "organiser";
  revision: number;
}

export interface GatesRead {
  timeZone: string;
  now: string;
  manage: boolean;
  gates: GateView[];
  /** Organisers: the league's events for the "With a League Event" picker. */
  events?: Array<{ id: string; title: string; next: string | null }>;
  /** Organisers: the last revision of each gate that was switched off (a re-created gate continues from it). */
  retired?: Record<string, number>;
}

/** What each step is called beside its editor, and what the coach banner says. */
export const GATE_TEXT: Record<GateKind, { label: string; help: string; banner: string }> = {
  "redraft-window": { label: "Redraft window", help: "The window opens (coaches are told, the redrafting teams stop playing).", banner: "The redraft opens" },
  "redraft-rest": { label: "Rest rolls", help: "Rest & Relaxation rolls open, for rolling live at a league night.", banner: "Rest & Relaxation rolls open" },
  "redraft-submit": { label: "Submissions", help: "Coaches can submit their draft lists.", banner: "Redraft submissions open" },
  "season-start": { label: "Season start", help: "Start season (and the fixtures) waits until then.", banner: "The season starts" },
  "ladder-challenges": { label: "Ladder challenges", help: "Coaches can issue challenges from then.", banner: "Challenges open" },
  registration: { label: "Registration opens", help: "Coaches can ask to join from then.", banner: "Registration opens" },
  "honours-reveal": { label: "Honours reveal", help: "Period honours stay hidden until then, then they are revealed and announced.", banner: "Period honours are revealed" },
};

/** Where a scope's gates live: a league's (every gate kind), or a tournament's (its one Registration gate, cleanup lane 11-03:
 *  the same read model and routes under /api/tournaments/:id, "At a time" only). */
export const leagueGateBase = (leagueId: string): string => `/api/leagues/${encodeURIComponent(leagueId)}`;
export const tournamentGateBase = (tournamentId: string): string => `/api/tournaments/${encodeURIComponent(tournamentId)}`;

export interface GatePayload { mode: "off" | "time" | "event"; opensAt?: string; eventId?: string; offsetMinutes?: number; autoStart?: boolean }

/** The gate API over a base path (leagueGateBase / tournamentGateBase). */
export const gatesApiAt = {
  list: (api: Fetcher, base: string) => api<GatesRead>(`${base}/gates`),
  save: (api: Fetcher, base: string, kind: GateKind, target: string, revision: number, body: GatePayload) =>
    api<{ gate: GateView | null; removed?: boolean; warning?: string }>(`${base}/gates/${kind}/${encodeURIComponent(target)}`, { method: "PUT", body: { ...body, revision } }),
  open: (api: Fetcher, base: string, kind: GateKind, target: string, revision: number) =>
    api<{ gate: GateView }>(`${base}/gates/${kind}/${encodeURIComponent(target)}/open`, { method: "POST", body: { revision } }),
};

export const gatesApi = {
  list: (api: Fetcher, leagueId: string) => gatesApiAt.list(api, leagueGateBase(leagueId)),
  save: (api: Fetcher, leagueId: string, kind: GateKind, target: string, revision: number, body: GatePayload) => gatesApiAt.save(api, leagueGateBase(leagueId), kind, target, revision, body),
  open: (api: Fetcher, leagueId: string, kind: GateKind, target: string, revision: number) => gatesApiAt.open(api, leagueGateBase(leagueId), kind, target, revision),
};

// ---- a per-league store (one read for every editor and banner on the page) ---------------------------------------------

export interface GatesState { leagueId: string; loaded: boolean; error: string; read: GatesRead | null; at: number }

const stores = new Map<string, { state: GatesState; inflight?: Promise<void> }>();

/** The league's gates, read once per page (reload() after a write). */
export function useLeagueGates(api: Fetcher, leagueId: string) {
  return useGatesAt(api, leagueGateBase(leagueId), leagueId);
}

/** A tournament's Registration gate (the same store and editor as a league's). */
export function useTournamentGates(api: Fetcher, tournamentId: string) {
  return useGatesAt(api, tournamentGateBase(tournamentId), tournamentId);
}

/** The gates under a base path, read once per page and shared by every editor and banner on it. */
export function useGatesAt(api: Fetcher, base: string, id: string) {
  let entry = stores.get(base);
  if (!entry) {
    entry = { state: reactive<GatesState>({ leagueId: id, loaded: false, error: "", read: null, at: 0 }) };
    stores.set(base, entry);
  }
  const e = entry;
  async function reload(): Promise<void> {
    e.inflight = (async () => {
      try {
        const read = await gatesApiAt.list(api, base);
        e.state.read = read;
        e.state.at = Date.now();
        e.state.error = "";
      } catch (err) {
        e.state.error = err instanceof Error && err.message ? err.message : "Can't load the gates.";
      } finally {
        e.state.loaded = true;
      }
    })();
    return e.inflight;
  }
  async function ensure(): Promise<void> {
    if (e.inflight) return e.inflight;
    if (!e.state.loaded) return reload();
  }
  const gate = (kind: GateKind, target: string): GateView | undefined => e.state.read?.gates.find((g) => g.kind === kind && g.target === target);
  /** The revision a save must name: the gate's, else the last one of the gate switched off here, else 0. */
  const baseRevision = (kind: GateKind, target: string): number => gate(kind, target)?.revision ?? e.state.read?.retired?.[`${kind}:${target}`] ?? 0;
  return { state: e.state, reload, ensure, gate, baseRevision, base };
}

/** Tests: forget every cached league. */
export const resetGateStores = (): void => { stores.clear(); };

// ---- countdowns ----------------------------------------------------------------------------------------------------------

/** "2d 4h 13m", "4h 13m 05s", "12m 05s", "now". */
export function countdownText(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${h}h ${p(m)}m`;
  if (h > 0) return `${h}h ${p(m)}m ${p(sec)}s`;
  return `${m}m ${p(sec)}s`;
}

/** "Thu 5 Nov 2026, 19:00" in the league zone. */
export function gateWhen(iso: string, zone: string): string {
  const z = validZone(zone) ? zone : "UTC";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}, ${g("hour")}:${g("minute")}`;
}

/** "Thu 5 Nov, 19:00" (the event picker). */
export function gateShort(iso: string, zone: string): string {
  const z = validZone(zone) ? zone : "UTC";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: z, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")}, ${g("hour")}:${g("minute")}`;
}

/** Shut gates with a time still to come, soonest first (the coach banner). Open gates and untimed ones stay off it. */
export function upcomingGates(gates: readonly GateView[], now: number, kinds?: readonly GateKind[], target?: string): GateView[] {
  return gates
    .filter((g) => g.state === "shut" && g.opensAt && Date.parse(g.opensAt) > now && (!kinds || kinds.includes(g.kind)) && (!target || g.target === target))
    .sort((a, b) => Date.parse(a.opensAt!) - Date.parse(b.opensAt!));
}

/** The calendar source's shape (leagueEvents.ts gateItems). */
export const calendarGates = (gates: readonly GateView[]): CalendarGate[] =>
  gates.filter((g) => g.state === "shut" && g.opensAt).map((g) => ({ id: g.id, title: g.title, opensAt: g.opensAt!, step: g.label, ...(g.eventId ? { eventId: g.eventId } : {}) }));

// ---- the editor ------------------------------------------------------------------------------------------------------------

export interface GateForm {
  mode: "off" | "time" | "event";
  /** datetime-local value in the league zone. */
  wall: string;
  eventId: string;
  /** Offset in minutes (negative = before the event starts). */
  offset: number;
  autoStart: boolean;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** A wall-clock value ("2026-11-05T19:00") of an instant in the zone. */
export function wallOf(iso: string, zone: string): string {
  const z = validZone(zone) ? zone : "UTC";
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** The form of a stored gate (or a new one: tomorrow 19:00 in the league zone). */
export function gateForm(g: GateView | undefined, now: number, zone: string): GateForm {
  if (g) {
    return {
      mode: g.mode, wall: g.wall ?? (g.opensAt ? wallOf(g.opensAt, zone) : ""), eventId: g.eventId ?? "", offset: g.offsetMinutes ?? 0, autoStart: g.autoStart === true,
    };
  }
  const t = wallOf(new Date(now + 86_400_000).toISOString(), zone);
  return { mode: "off", wall: `${t.slice(0, 10)}T19:00`, eventId: "", offset: 0, autoStart: false };
}

export function gatePayload(f: GateForm, kind: GateKind): GatePayload {
  if (f.mode === "off") return { mode: "off" };
  const extra = kind === "season-start" ? { autoStart: f.autoStart } : {};
  if (f.mode === "time") return { mode: "time", opensAt: f.wall.slice(0, 16), ...extra };
  return { mode: "event", eventId: f.eventId, offsetMinutes: Math.round(Number(f.offset) || 0), ...extra };
}

/** The first problem to show inline (undefined = fine). The server checks the same and is the authority. */
export function gateFormError(f: GateForm): string | undefined {
  if (f.mode === "time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(f.wall)) return "Pick the date and time it opens.";
  if (f.mode === "event" && !f.eventId) return "Pick a League Event.";
  if (f.mode === "event" && (!Number.isInteger(Number(f.offset)) || Math.abs(Number(f.offset)) > 7 * 24 * 60)) return "The offset is whole minutes, at most 7 days either way.";
  return undefined;
}

/** "Opens 2 h after League night starts". */
export function offsetText(min: number, event: string): string {
  if (!min) return `Opens when ${event} starts`;
  const abs = Math.abs(min);
  const amount = abs % 1440 === 0 ? `${abs / 1440} d` : abs % 60 === 0 ? `${abs / 60} h` : `${abs} min`;
  return `Opens ${amount} ${min > 0 ? "after" : "before"} ${event} starts`;
}

/** Offset presets for the picker (minutes). */
export const OFFSET_PRESETS: ReadonlyArray<{ value: number; label: string }> = [
  { value: -1440, label: "1 day before" }, { value: -60, label: "1 hour before" }, { value: 0, label: "At the start" },
  { value: 30, label: "30 min after" }, { value: 60, label: "1 hour after" }, { value: 120, label: "2 hours after" }, { value: 180, label: "3 hours after" },
];


