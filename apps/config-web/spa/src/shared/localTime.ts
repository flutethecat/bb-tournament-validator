// Tournament times in the viewer's own zone (owner 11-04: "store these in epoch time and reveal them in the user's local
// time zone for the device they're viewing"). Every tournament time is stored as a UTC instant (ISO); pages show it in the
// browser's zone with the zone's abbreviation, and datetime-local fields are typed in that zone and sent back as an instant.
// League times keep the league zone (leagues/gates.ts, schedule/schedule.ts). Pure; `zone` is a parameter for tests.

import { validZone } from "../schedule/schedule";

/** The device's IANA zone ("Europe/London"), UTC when the runtime can't say. */
export function viewerZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return validZone(z) ? z : "UTC";
  } catch { return "UTC"; }
}

const zoneOr = (zone: string | undefined): string => (zone && validZone(zone) ? zone : viewerZone());
const ms = (iso: string | number | undefined): number => (typeof iso === "number" ? iso : iso ? Date.parse(iso) : NaN);

/** The zone's short name at that instant ("PST", "GMT+1", "UTC"). en-US gives the familiar letters where they exist. */
export function zoneAbbr(iso: string | number | undefined, zone?: string): string {
  const z = zoneOr(zone);
  const t = ms(iso);
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "short" }).formatToParts(Number.isFinite(t) ? new Date(t) : new Date()).find((p) => p.type === "timeZoneName");
    return part?.value ?? z;
  } catch { return z; }
}

function parts(t: number, zone: string, withYear: boolean, weekday: boolean) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone, ...(weekday ? { weekday: "short" } : {}), day: "2-digit", month: "short", ...(withYear ? { year: "numeric" } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "";
  return { weekday: g("weekday"), day: g("day"), month: g("month"), year: g("year"), hour: g("hour"), minute: g("minute") };
}

/** "05 Dec 2026, 09:00 GMT" in the viewer's zone; "" when absent or unreadable. */
export function localWhen(iso: string | number | undefined, zone?: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const z = zoneOr(zone);
  const p = parts(t, z, true, false);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${zoneAbbr(t, z)}`;
}

/** "Thu 05 Dec 2026, 09:00 GMT" (a weekday for countdown / gate lines). */
export function localWhenLong(iso: string | number | undefined, zone?: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const z = zoneOr(zone);
  const p = parts(t, z, true, true);
  return `${p.weekday} ${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} ${zoneAbbr(t, z)}`;
}

/** The calendar day of an instant in the viewer's zone ("2026-12-05"); "" when absent or unreadable. */
export function localDay(iso: string | undefined, zone?: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  return toZoneInput(new Date(t).toISOString(), zone).slice(0, 10);
}

/** ISO instant -> a datetime-local value in the viewer's zone ("2026-12-05T09:00"); "" when absent or unreadable. */
export function toZoneInput(iso: string | undefined, zone?: string): string {
  const t = ms(iso);
  if (!Number.isFinite(t)) return "";
  const z = zoneOr(zone);
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

/** Minutes between the zone's wall clock and UTC at an instant (wall - utc). */
function offsetAt(t: number, zone: string): number {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(t / 1000) * 1000;
}

export interface ZoneInput { iso: string; kind: "ok" | "gap" | "twice" | "empty" | "bad"; wall?: string }

/**
 * A datetime-local value typed in the viewer's zone, resolved to an instant (Sol P2-2):
 *  - a time that exists once: that instant;
 *  - a time that occurs twice (clocks go back): the FIRST occurrence, always;
 *  - a time that does not exist (clocks go forward): forward to the first valid instant (the change itself, e.g. 03:00
 *    on a spring-forward morning in Paris), with kind "gap" so the form can say so.
 */
export function resolveZoneInput(value: string, zone?: string): ZoneInput {
  if (!value) return { iso: "", kind: "empty" };
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return { iso: "", kind: "bad" };
  const z = zoneOr(zone);
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const g = Date.UTC(y, mo - 1, d, h, mi);
  if (!Number.isFinite(g) || new Date(g).getUTCDate() !== d) return { iso: "", kind: "bad" };
  const wall = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`;
  // The offsets a day either side bracket any change on this day; each gives one candidate instant.
  const candidates = [...new Set([g - offsetAt(g - 86_400_000, z), g - offsetAt(g + 86_400_000, z), g - offsetAt(g, z)])]
    .filter((t) => toZoneInput(new Date(t).toISOString(), z) === wall)
    .sort((a, b) => a - b);
  if (candidates.length) return { iso: new Date(candidates[0]!).toISOString(), kind: candidates.length > 1 ? "twice" : "ok", wall };
  // A gap: find the change (the first instant whose wall clock is past the typed time), to the minute.
  let lo = g - offsetAt(g - 86_400_000, z) - 86_400_000;
  let hi = g - offsetAt(g + 86_400_000, z) + 86_400_000;
  const after = (t: number) => toZoneInput(new Date(t).toISOString(), z) > wall;
  if (!after(hi) || after(lo)) return { iso: "", kind: "bad" };
  while (hi - lo > 60_000) {
    const mid = Math.floor((lo + hi) / 2 / 60_000) * 60_000;
    if (mid <= lo || mid >= hi) break;
    if (after(mid)) hi = mid; else lo = mid;
  }
  return { iso: new Date(hi).toISOString(), kind: "gap", wall };
}

/** A datetime-local value typed in the viewer's zone -> the ISO instant ("" clears, "" for an unreadable value). A time
 *  that does not exist in the zone resolves forward; one that occurs twice takes the first (resolveZoneInput). */
export function fromZoneInput(value: string, zone?: string): string {
  return resolveZoneInput(value, zone).iso;
}

/** The note a form shows under its time fields for a typed time that moved (a DST gap) or is ambiguous; "" otherwise. */
export function zoneInputNote(value: string, zone?: string): string {
  const r = resolveZoneInput(value, zone);
  const at = (iso: string) => localWhen(iso, zone);
  if (r.kind === "gap") return `${r.wall!.replace("T", " ")} doesn't exist in your time zone (the clocks go forward), so it is saved as ${at(r.iso)}.`;
  if (r.kind === "twice") return `${r.wall!.replace("T", " ")} happens twice in your time zone (the clocks go back); the first one is used: ${at(r.iso)}.`;
  return "";
}

/** The notes for several fields (each once). */
export const zoneInputNotes = (values: readonly string[], zone?: string): string[] => [...new Set(values.map((v) => zoneInputNote(v, zone)).filter(Boolean))];

/**
 * The value to send for a datetime-local field: the stored instant untouched when the field still shows it (an unrelated
 * save never moves a time, not even by its seconds), else the typed time as an instant ("" = cleared).
 */
export function keptOrTyped(stored: string | undefined, value: string, zone?: string): string {
  if (stored && toZoneInput(stored, zone) === value) return stored;
  return fromZoneInput(value, zone);
}

/** "your time, GMT" for a field caption. */
export function zoneCaption(zone?: string): string {
  return `your time, ${zoneAbbr(Date.now(), zone)}`;
}
