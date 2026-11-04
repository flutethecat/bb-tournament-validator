/**
 * The tournament Registration gate (cleanup lane 11-03, Q8: "gates for tournament registration"): the league gates model
 * (src/leagues/gates.ts) scoped to one tournament. Pure: the shape, the time, the check every registration path makes and the
 * read model. The routes and the minute job live in ./gates.ts.
 *
 *  - One gate per tournament, stored on the record (registrationGate). "At a time" only: a wall-clock time in the tournament's
 *    zone (tournamentTimeZone; tournaments have no League Events). Off by default.
 *  - Open = stored state "open" OR its time has passed: self-registration is allowed from the minute it is due, before the job
 *    has flipped the state.
 *  - Fails closed: a gate whose record can't be read (not an object, no usable time while shut) keeps registration shut until
 *    an organiser fixes or opens it.
 *  - Revisions only go up: switching the gate off keeps its last revision (registrationGateRetired), and a re-created gate
 *    continues from it, so a stale tab can never Open now or overwrite it.
 *  - No coach data: openedBy is "schedule" or "organiser".
 */
import { zonedInstant } from "../discord/weekly.js";
import type { TournamentRecord } from "./types.js";

export interface TournamentGate {
  /** A wall-clock time in the tournament's zone ("2026-11-05T19:00"). */
  opensAt: string;
  armedAt: string;
  state: "shut" | "open";
  openedBy?: "schedule" | "organiser";
  openedAt?: string;
  /** The opening's announcement (one organiser note and one Discord post): "pending" is written before anyone is told. */
  announce?: "pending" | "done";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const GATE_ID = "registration:tournament";
export const UTC = "UTC";

/** A zone name the runtime knows. */
function isZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+/-]*$/.test(tz)) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/**
 * The tournament equivalent of leagueTimeZone(): the tournament's own zone when one is stored, else UTC (the zone every
 * tournament time is shown and typed in today: the wizard and the Page form label their fields UTC).
 */
export function tournamentTimeZone(t: Pick<TournamentRecord, "timeZone"> | undefined): string {
  return t?.timeZone && isZone(t.timeZone) ? t.timeZone : UTC;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "2026-11-05T19:00" (seconds dropped), or undefined when it is not a real date and time. */
export function parseGateWall(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const m = WALL.exec(v.trim().slice(0, 16));
  if (!m || v.trim().length > 19) return undefined;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const real = new Date(Date.UTC(y, mo - 1, d));
  if (real.getUTCFullYear() !== y || real.getUTCMonth() !== mo - 1 || real.getUTCDate() !== d || h > 23 || mi > 59) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
}

/** The instant of a wall-clock time in a zone. */
export function gateWallInstant(wall: string, zone: string): number {
  const m = WALL.exec(wall)!;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return zonedInstant(y, mo, d, h, mi, zone).getTime();
}

/** The stored gate if it reads as one; "unreadable" for a corrupt value; undefined = no gate (registration as usual). */
export function storedGate(t: Pick<TournamentRecord, "registrationGate">): TournamentGate | "unreadable" | undefined {
  const g = t.registrationGate as unknown;
  if (g === undefined || g === null) return undefined;
  if (typeof g !== "object" || Array.isArray(g)) return "unreadable";
  const r = g as Partial<TournamentGate>;
  if ((r.state !== "shut" && r.state !== "open") || typeof r.revision !== "number") return "unreadable";
  return r as TournamentGate;
}

/** When the gate opens (ms), undefined = no usable time. */
export function gateInstant(g: TournamentGate, zone: string): number | undefined {
  const wall = parseGateWall(g.opensAt);
  return wall ? gateWallInstant(wall, zone) : undefined;
}

export const gateIsOpen = (g: TournamentGate, at: number | undefined, now: number): boolean => g.state === "open" || (at !== undefined && at <= now);

/** "Thu 5 Nov 2026, 19:00 (UTC)". */
export function gateWhenText(iso: string, zone: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}, ${g("hour")}:${g("minute")} (${zone.replace(/_/g, " ")})`;
}

export interface GateShut { opensAt?: string; message: string; secondsLeft: number | null }

/**
 * Why self-registration is shut by the gate now (undefined = the gate is open, or there is none). Fails closed: an unreadable
 * gate, or a shut one without a usable time, refuses.
 */
export function registrationGateShut(t: Pick<TournamentRecord, "registrationGate" | "timeZone">, now: Date): GateShut | undefined {
  const g = storedGate(t);
  if (!g) return undefined;
  if (g === "unreadable") return { message: "Registration opens when the organisers open it.", secondsLeft: null };
  const zone = tournamentTimeZone(t);
  const at = gateInstant(g, zone);
  if (gateIsOpen(g, at, now.getTime())) return undefined;
  if (at === undefined) return { message: "Registration opens when the organisers open it.", secondsLeft: null };
  const iso = new Date(at).toISOString();
  return { opensAt: iso, message: `Registration opens ${gateWhenText(iso, zone)}.`, secondsLeft: Math.max(0, Math.ceil((at - now.getTime()) / 1000)) };
}

/** The gate as the shared gate editor reads it (the league GateView shape; kind "registration", target "tournament"). */
export interface TournamentGateView {
  id: string; kind: "registration"; target: "tournament"; targetName: string; label: string; title: string;
  state: "shut" | "open"; opensAt: string | null; secondsLeft: number | null; mode: "time"; wall?: string;
  openedAt?: string; openedBy?: "schedule" | "organiser"; revision: number;
}

export function tournamentGateView(t: Pick<TournamentRecord, "name" | "registrationGate" | "timeZone">, now: Date): TournamentGateView | null {
  const g = storedGate(t);
  if (!g || g === "unreadable") return null;
  const zone = tournamentTimeZone(t);
  const at = gateInstant(g, zone);
  const open = gateIsOpen(g, at, now.getTime());
  return {
    id: GATE_ID, kind: "registration", target: "tournament", targetName: t.name, label: "Registration", title: `${t.name}: Registration opens`,
    state: open ? "open" : "shut", opensAt: at === undefined ? null : new Date(at).toISOString(),
    secondsLeft: open ? 0 : at === undefined ? null : Math.max(0, Math.ceil((at - now.getTime()) / 1000)),
    mode: "time", ...(parseGateWall(g.opensAt) ? { wall: parseGateWall(g.opensAt) } : {}),
    ...(g.openedAt ? { openedAt: g.openedAt } : {}), ...(g.openedBy ? { openedBy: g.openedBy } : {}), revision: g.revision,
  };
}
