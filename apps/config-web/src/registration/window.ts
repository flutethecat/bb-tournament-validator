// The registration window (registration spec §2): defaults per competition kind, the open/closed decision, cap and
// per-race room, the waitlist order and the self check-in window. Pure functions, no I/O.

import type {
  CompetitionKind, CompetitionSnapshot, EntryState, RegistrationEntry, RegistrationWindow,
} from "./types.js";

/** Default check-in opening: 24 hours before the start (Q11). */
export const CHECK_IN_LEAD_MS = 24 * 60 * 60 * 1000;

/**
 * The defaults the owner accepted (11-02): tournaments auto-accept (Q5), leagues need organiser approval (Q5); the
 * waitlist is on (Q6); "roster later" is on for tournaments (Q4); self check-in is on (Q11); existing teams and
 * mid-season joining are off for leagues (Q8, Q9).
 */
export function defaultRegistrationWindow(kind: CompetitionKind, cap: number | null = null): RegistrationWindow {
  const normalCap = normalizeCap(cap);
  if (kind === "tournament") {
    return { cap: normalCap, approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } };
  }
  return { cap: normalCap, perRace: null, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false };
}

/** A stored window over the kind's defaults (absent fields take the default; `cap` from the competition wins when given). */
export function resolveRegistrationWindow(kind: CompetitionKind, stored: Partial<RegistrationWindow> | undefined, cap?: number | null): RegistrationWindow {
  const base = defaultRegistrationWindow(kind, cap ?? stored?.cap ?? null);
  const out: RegistrationWindow = { ...base, ...(stored ?? {}), cap: normalizeCap(cap !== undefined ? cap : stored?.cap ?? null) };
  if (out.approval !== "auto" && out.approval !== "organiser") out.approval = base.approval;
  if (typeof out.waitlist !== "boolean") out.waitlist = base.waitlist;
  return out;
}

/** 0, negatives and non-numbers mean "no cap". */
export function normalizeCap(cap: number | null | undefined): number | null {
  return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : null;
}

const ms = (iso: string | undefined): number | undefined => {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
};

export type ClosedReason = "unpublished" | "not-yet-open" | "closed" | "finished" | "started" | "locked";

export type WindowStatus = { open: true } | { open: false; reason: ClosedReason; message: string };

const CLOSED_TEXT: Record<ClosedReason, string> = {
  unpublished: "Registration is not open yet.",
  "not-yet-open": "Registration is not open yet.",
  closed: "Registration is closed.",
  finished: "Registration is closed.",
  started: "Registration is closed now that play has started.",
  locked: "Registration is closed while rosters are locked.",
};

const closed = (reason: ClosedReason): WindowStatus => ({ open: false, reason, message: CLOSED_TEXT[reason] });

/**
 * Self-registration is open when the competition is published, not finished, not started (a league season with
 * allowMidSeason may be), rosters are not locked, and `now` is in [opensAt, closesAt).
 */
export function windowStatus(c: CompetitionSnapshot, now: Date): WindowStatus {
  if (c.finished) return closed("finished");
  if (!c.published) return closed("unpublished");
  if (c.locked) return closed("locked");
  if (c.started && !c.window.allowMidSeason) return closed("started");
  const t = now.getTime();
  // A shut Registration gate (tournaments): refused until it opens, whatever the window's own dates say.
  if (c.gate && (c.gate.opensAt === undefined || !(t >= (ms(c.gate.opensAt) ?? Infinity)))) return { open: false, reason: "not-yet-open", message: c.gate.message };
  const opens = ms(c.window.opensAt);
  const closes = ms(c.window.closesAt);
  if (opens !== undefined && t < opens) return closed("not-yet-open");
  if (closes !== undefined && t >= closes) return closed("closed");
  return { open: true };
}

/** What organisers may still do when self-registration is closed: add or decide entries until play starts. */
export function organiserMayAdd(c: CompetitionSnapshot): WindowStatus {
  if (c.finished) return closed("finished");
  if (c.locked) return closed("locked");
  if (c.started && !c.window.allowMidSeason) return closed("started");
  return { open: true };
}

const sameRace = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();

/** Accepted entries (the only state that counts toward the cap, pairing, standings and public lists). */
export const acceptedEntries = (entries: readonly RegistrationEntry[]) => entries.filter((e) => e.state === "accepted");

export type Room = { ok: true } | { ok: false; code: "full" | "race-full" };

/** Is there a place for `entry` among `entries` (the entry itself never counts against itself)? */
export function roomFor(window: RegistrationWindow, entries: readonly RegistrationEntry[], entry: Pick<RegistrationEntry, "id" | "race">): Room {
  const accepted = acceptedEntries(entries).filter((e) => e.id !== entry.id);
  const cap = normalizeCap(window.cap);
  if (cap !== null && accepted.length >= cap) return { ok: false, code: "full" };
  const perRace = normalizeCap(window.perRace ?? null);
  if (perRace !== null && entry.race && accepted.filter((e) => sameRace(e.race, entry.race)).length >= perRace) return { ok: false, code: "race-full" };
  return { ok: true };
}

/** The waitlist in order: joined first = first in line; same instant -> the lower waitlistSeq (assigned when it joined).
 *  Never by id (a re-entering coach keeps an older id). Entries without a seq keep their stored order (stable sort). */
export function waitlistOrder(entries: readonly RegistrationEntry[]): RegistrationEntry[] {
  const seq = (e: RegistrationEntry) => e.waitlistSeq ?? Number.MAX_SAFE_INTEGER;
  return entries
    .filter((e) => e.state === "waitlisted")
    .sort((a, b) => (ms(a.waitlistAt) ?? 0) - (ms(b.waitlistAt) ?? 0) || seq(a) - seq(b));
}

/** The next waitlistSeq for a competition (one more than any seq ever given, whatever the entry's state now). */
export function nextWaitlistSeq(entries: readonly RegistrationEntry[]): number {
  return entries.reduce((m, e) => Math.max(m, e.waitlistSeq ?? 0), 0) + 1;
}

/** The coach's place in line (1 = next), or undefined when the entry is not waitlisted. */
export function waitlistPosition(entries: readonly RegistrationEntry[], entryId: string): number | undefined {
  const i = waitlistOrder(entries).findIndex((e) => e.id === entryId);
  return i < 0 ? undefined : i + 1;
}

/** Counts for a band caption ("12 / 16 TEAMS · 3 PENDING"). */
export function registrationCounts(window: RegistrationWindow, entries: readonly RegistrationEntry[]) {
  const count = (s: EntryState) => entries.filter((e) => e.state === s).length;
  const cap = normalizeCap(window.cap);
  const accepted = count("accepted");
  return { accepted, pending: count("pending"), waitlisted: count("waitlisted"), cap, placesLeft: cap === null ? null : Math.max(0, cap - accepted) };
}

/** The self check-in window: opens 24 h before the start unless set, closes at the start unless set. */
export function checkInWindow(window: RegistrationWindow, startAt: string | undefined): { opensAt?: string; closesAt?: string; self: boolean } | undefined {
  const start = ms(startAt);
  const opens = window.checkIn?.opensAt ?? (start !== undefined ? new Date(start - CHECK_IN_LEAD_MS).toISOString() : undefined);
  const closes = window.checkIn?.closesAt ?? (start !== undefined ? new Date(start).toISOString() : undefined);
  if (opens === undefined) return undefined;
  return { opensAt: opens, ...(closes !== undefined ? { closesAt: closes } : {}), self: window.checkIn?.self ?? true };
}

/** Check-in is open now (not for a finished competition). */
export function isCheckInOpen(c: CompetitionSnapshot, now: Date): boolean {
  if (c.finished) return false;
  const w = checkInWindow(c.window, c.startAt);
  if (!w) return false;
  const t = now.getTime();
  const opens = ms(w.opensAt);
  const closes = ms(w.closesAt);
  return opens !== undefined && t >= opens && (closes === undefined || t < closes);
}

/** The state of a stored record from before the registration core (absent entryState = accepted; dropped = withdrawn). */
export function legacyEntryState(record: { entryState?: EntryState; droppedAt?: string }): EntryState {
  if (record.entryState) return record.entryState;
  return record.droppedAt !== undefined ? "withdrawn" : "accepted";
}
