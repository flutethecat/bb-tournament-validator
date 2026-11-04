/**
 * The tournament Registration gate (cleanup lane 11-03, Q8: "gates for tournament registration"): the league gates model
 * (src/leagues/gates.ts) scoped to one tournament. Pure: the shape, the time, the check every registration path makes and the
 * read model. The routes and the minute job live in ./gates.ts.
 *
 *  - One gate per tournament, stored on the record (registrationGate). "At a time" only (tournaments have no League Events).
 *    Off by default. The time is a UTC instant (owner 11-04: tournament times are instants, shown in the viewer's own zone);
 *    a gate stored by an earlier build holds a wall time, read in tournamentTimeZone() (UTC unless a zone was ever stored).
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
  /** The opening instant, ISO UTC ("2026-11-05T19:00:00.000Z"). Earlier builds stored a wall time ("2026-11-05T19:00"),
   *  which is read in tournamentTimeZone() (gateInstant). */
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
 * Neutralised (owner 11-04: "store these in epoch time and reveal them in the user's local time zone"): tournaments have no
 * display zone any more. This only reads a gate wall time stored by an earlier build (the tournament's stored zone, else UTC,
 * the zone those walls were typed in). Never use it to show a time: pages format instants in the viewer's zone, and
 * server-written text says UTC (utcWhenText) or uses Discord's <t:epoch> timestamps.
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

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** An ISO instant with its zone ("2026-11-05T19:00:00.000Z", "...+01:00") as ms, or undefined. */
export function parseInstant(v: unknown): number | undefined {
  if (typeof v !== "string" || !INSTANT.test(v.trim())) return undefined;
  const t = Date.parse(v.trim());
  return Number.isFinite(t) ? t : undefined;
}

/** When the gate opens (ms), undefined = no usable time. A stored instant is used as is; a legacy wall time is read in
 *  `legacyZone` (tournamentTimeZone). */
export function gateInstant(g: TournamentGate, legacyZone: string): number | undefined {
  const at = parseInstant(g.opensAt);
  if (at !== undefined) return at;
  const wall = parseGateWall(g.opensAt);
  return wall ? gateWallInstant(wall, legacyZone) : undefined;
}

export const gateIsOpen = (g: TournamentGate, at: number | undefined, now: number): boolean => g.state === "open" || (at !== undefined && at <= now);

/** "Thu 5 Nov 2026, 19:00 UTC": server-written text (inbox, email, refusals) can't know the reader's zone, so it says UTC. */
export function utcWhenText(iso: string): string {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: UTC, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}, ${g("hour")}:${g("minute")} UTC`;
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
  return { opensAt: iso, message: `Registration opens ${utcWhenText(iso)}.`, secondsLeft: Math.max(0, Math.ceil((at - now.getTime()) / 1000)) };
}

/**
 * The Discord observer's "Registration is open" marker, shared by the observer and the gate's opening so whichever claims it
 * posts (one post per opening). With a gate it carries the gate's armedAt: Open now keeps it (the first opening is one post
 * however the timers fall), a re-arm changes it (a later reopen gets its own post). undefined = nothing to post.
 */
export function regopenMarker(t: Pick<TournamentRecord, "registration" | "registrationGate">): string | undefined {
  const g = storedGate(t);
  const suffix = g && g !== "unreadable" ? `:gate:${g.armedAt}` : "";
  const opens = t.registration?.opensAt;
  if (opens) return `regopen:${opens}${suffix}`;
  return suffix ? `regopen${suffix}` : undefined;
}

/** The ledger record that a "Registration is open" marker was actually POSTED (not claimed quietly: a draft, no webhook,
 *  the toggle off, a failed post). Only posted claims count as announced. */
export const POSTED_SUFFIX = "#posted";
export const postedMarker = (marker: string): string => `${marker}${POSTED_SUFFIX}`;

/**
 * Was this registration opening already announced? A POSTED "Registration is open" marker for the same opensAt (plain or with
 * any gate suffix; without opensAt, any gate marker) claimed after the cutoff counts. The cutoff is the gate's last arming, or,
 * with the gate switched off, the arming it had then (registrationGateRetiredArmedAt; none = any time). Only a re-arm (an
 * armedAt later than the last posted claim) allows a new post; switching a gate off never moves the cutoff, and an unreadable
 * gate counts as no re-arm. `seen` is the competition's Discord ledger (marker -> when it was claimed).
 */
export function regopenAnnounced(seen: Readonly<Record<string, string>> | undefined, t: Pick<TournamentRecord, "registration" | "registrationGate" | "registrationGateRetiredArmedAt">): boolean {
  if (!seen) return false;
  const opens = t.registration?.opensAt;
  const prefix = opens ? `regopen:${opens}` : "regopen:gate:";
  const g = storedGate(t);
  const cutoff = g && g !== "unreadable" ? g.armedAt : g === "unreadable" ? undefined : t.registrationGateRetiredArmedAt;
  const since = cutoff ? Date.parse(cutoff) : -Infinity;
  for (const [key, at] of Object.entries(seen)) {
    if (!key.endsWith(POSTED_SUFFIX)) continue;
    const marker = key.slice(0, -POSTED_SUFFIX.length);
    if (marker !== prefix && !marker.startsWith(opens ? `${prefix}:gate:` : prefix)) continue;
    const claimed = Date.parse(at);
    if (!Number.isFinite(since) || !(claimed < since)) return true;
  }
  return false;
}

/** The gate as the shared gate editor reads it (the league GateView shape; kind "registration", target "tournament"). */
export interface TournamentGateView {
  id: string; kind: "registration"; target: "tournament"; targetName: string; label: string; title: string;
  state: "shut" | "open"; opensAt: string | null; secondsLeft: number | null; mode: "time";
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
    // No wall time: the page shows and edits the instant in the viewer's own zone.
    mode: "time",
    ...(g.openedAt ? { openedAt: g.openedAt } : {}), ...(g.openedBy ? { openedBy: g.openedBy } : {}), revision: g.revision,
  };
}
