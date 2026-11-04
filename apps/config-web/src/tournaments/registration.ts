// Tournament registration (registration spec 2026-11-02 §7, wizards v2 check-in / "I've paid"; lane L4): the tournament
// adapter of the shared registration core (src/registration), payment reference codes, and the scheduled sweep that sends
// the check-in-open and roster-due notices.
//
// Storage (the invariant every reader relies on): only accepted entries (and entries that left after acceptance, with
// droppedAt) live in tournaments.json `entrants`. Pending, waitlisted, declined and withdrawn-before-acceptance entries live
// in `heldEntrants` (src/tournaments/store.ts commitRegistration moves a row on acceptance). So pairing, standings, public
// lists and counts, coach notifications, sharing membership and the NAF rules (all of which read `entrants`) never see an
// entry the organisers have not accepted, by construction.
//
// Every state change goes through createRegistrationService: one per-competition KeyedLock (read -> decide -> commit), so
// two simultaneous registrations at the last place never both get it and a waitlist promotion runs exactly once.

import { randomInt } from "node:crypto";
import {
  checkInWindow, createRegistrationService, isCheckInOpen, normalizeCap, organiserMayAdd, RegistrationError, windowStatus, type CheckInNoticeRecord, type CompetitionSnapshot, type EntryState,
  type RegistrationAdapter, type RegistrationChange, type RegistrationEntry, type RegistrationNotifySink,
} from "../registration/index.js";
import { tournamentCompetition } from "./publication.js";
import type { RegistrationWrite, TournamentStore } from "./store.js";
import type { TournamentDataFileV4, TournamentEntrantRecord, TournamentRecord } from "./types.js";

const LIVE: ReadonlySet<string> = new Set(["pending", "waitlisted", "accepted"]);
const ckey = (c: string) => c.trim().toLowerCase();

/**
 * The registration core decided on a snapshot read inside its lock, but other writers (lock rosters, start, a lowered cap,
 * new settings) do not take that lock. This re-checks the decision against the stored data in the same synchronous
 * store mutation as the write: an entry becoming live or accepted needs the competition still open for it (not
 * finished, rosters not locked, play not started), a coach entering themselves needs the window still open, and the
 * accepted entries after the write must fit the cap. Leaving (withdraw, decline, drop) is never refused.
 */
export function registrationCommitGuard(tournamentId: string, changes: readonly RegistrationChange[], now: Date) {
  return (data: TournamentDataFileV4): void => {
    const t = data.tournaments[tournamentId];
    if (!t) throw new RegistrationError(404, "not-found", "Not found.");
    const round1 = Object.values(data.rounds).some((r) => r.tournamentId === tournamentId && r.number === 1);
    const c = tournamentCompetition(t, round1);
    let gainsAccepted = false;
    for (const change of changes) {
      const to = change.after.state;
      const from = change.before?.state;
      const becomesLive = LIVE.has(to) && !(from && LIVE.has(from));
      const becomesAccepted = to === "accepted" && from !== "accepted";
      if (becomesAccepted) gainsAccepted = true;
      if (becomesLive || becomesAccepted) {
        const s = organiserMayAdd(c);
        if (!s.open) throw new RegistrationError(409, "closed", s.message);
      }
      const action = change.transition.action;
      if (action === "submit" || action === "reenter") {
        const by = change.transition.by;
        const self = ckey(by) === ckey(change.after.coach) && !c.managers.some((m) => ckey(m) === ckey(by));
        if (self) {
          const w = windowStatus(c, now);
          if (!w.open) throw new RegistrationError(409, "closed", w.message);
        }
      }
    }
    const cap = normalizeCap(c.window.cap);
    if (gainsAccepted && cap !== null) {
      const changed = new Map(changes.map((ch) => [ch.after.id, ch.after.state] as const));
      const field = Object.values(data.entrants).filter((e) => e.tournamentId === tournamentId && e.droppedAt === undefined && !changed.has(e.id)).length;
      const after = field + [...changed.values()].filter((s) => s === "accepted").length;
      if (after > cap) throw new RegistrationError(409, "full", "Full.");
    }
  };
}

export const LEGACY_LIBRARY_MESSAGE = "This entry was made with a Super FUMBBL library team, which can't be a tournament source any more. Ask the coach to register again with a saved team.";

/** An entry made with a fork library team before owner rule 11-03: a team id and no submitted roster (a saved team always
 *  carries its submission). */
export function isLegacyLibraryEntry(record: { teamId?: string; submission?: { saveId?: string; teamRef?: string; teamId?: string } | undefined }): boolean {
  const lib = (v: unknown) => typeof v === "string" && v.startsWith("library:");
  const sub = record.submission;
  if (sub) return lib(sub.saveId) || lib(sub.teamRef) || lib(sub.teamId);
  return Boolean(record.teamId);
}

/** The state of a stored entrant row (absent entryState = accepted; droppedAt = withdrawn unless marked dropped). */
export function entryStateOf(record: Pick<TournamentEntrantRecord, "entryState" | "droppedAt">): EntryState {
  if (record.droppedAt !== undefined) return record.entryState === "dropped" ? "dropped" : "withdrawn";
  return record.entryState ?? "accepted";
}

/** A stored row as the registration core sees it. */
export function toRegistrationEntry(record: TournamentEntrantRecord): RegistrationEntry {
  return {
    id: record.id,
    competitionId: record.tournamentId,
    coach: record.coach.ffbCoachId,
    state: entryStateOf(record),
    submittedAt: record.firstRegisteredAt ?? record.registeredAt,
    enteredAt: record.registeredAt,
    ...(record.waitlistAt ? { waitlistAt: record.waitlistAt } : {}),
    ...(record.waitlistSeq !== undefined ? { waitlistSeq: record.waitlistSeq } : {}),
    ...(record.decided ? { decided: structuredClone(record.decided) } : {}),
    log: structuredClone(record.registrationLog ?? []) as RegistrationEntry["log"],
  };
}

/** What the registration route hands the core for a (re)submission (RegistrationEntry.data). */
export interface TournamentEntryData {
  /** The entry's own fields: the coach identity, team, submission, NAF answers, region. */
  record: Omit<TournamentEntrantRecord, "id" | "tournamentId" | "seed" | "registeredAt">;
}

// ---- payment reference codes ------------------------------------------------------------------------------------------

/** No 0/O or 1/I: a code read out or typed into a payment note survives. */
export const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const REF_LENGTH = 4;
export const REF_CODE = /^SF-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4,6}$/;

/**
 * Every entry's reference code, as stored. Codes are random (newReferenceCode), never derived from an entry's fields:
 * a row written before codes existed gets one from ensureReferenceCodes (a write: the minute sweep, server start, or
 * the coach's "I've paid"), never on a read. Coach and managers only: never on a public read.
 */
export function referenceCodes(records: readonly TournamentEntrantRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of records) if (r.refCode && REF_CODE.test(r.refCode)) out.set(r.id, r.refCode);
  return out;
}

/** Gives every entry without a code a fresh random one (all tournaments, or one). Returns how many were given. */
export function ensureReferenceCodes(store: TournamentStore, tournamentId?: string): number {
  return store.ensureReferenceCodes((taken) => newReferenceCode(taken), tournamentId);
}

/** A fresh random code not used by any entry of the tournament (stored or derived). */
export function newReferenceCode(taken: ReadonlySet<string>): string {
  for (;;) {
    let out = "";
    for (let i = 0; i < REF_LENGTH; i++) out += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
    const code = `SF-${out}`;
    if (!taken.has(code)) return code;
  }
}

// ---- the adapter --------------------------------------------------------------------------------------------------------

export interface TournamentAdapterOptions {
  now?: () => Date;
  /** NAF-sanctioned: the entry's NAF details frozen when an accepted entry leaves (the NAF report). */
  nafSnapshot?(tournament: TournamentRecord, record: TournamentEntrantRecord): { nafName?: string; nafNumber: string } | undefined;
}

/** The SPA paths a registration notice opens: the coach's entry card, or the organisers' Registrations panel. */
export const tournamentRegistrationLink = (id: string, audience: "coach" | "organiser"): string =>
  audience === "organiser"
    ? `/app/tournaments/${encodeURIComponent(id)}/manage#tn-reg-h`
    : `/app/tournaments/${encodeURIComponent(id)}#tn-entry-h`;

export class TournamentRegistrationAdapter implements RegistrationAdapter {
  readonly kind = "tournament" as const;

  constructor(private readonly store: TournamentStore, private readonly opts: TournamentAdapterOptions = {}) {}

  competition(id: string): CompetitionSnapshot | undefined {
    const t = this.store.tournament(id);
    if (!t) return undefined;
    const round1 = this.store.rounds(id).some((round) => round.number === 1);
    return { ...tournamentCompetition(t, round1), ...(t.checkInNotice ? { checkInNotice: structuredClone(t.checkInNotice) } : {}) };
  }

  entries(id: string): RegistrationEntry[] {
    return this.store.registrationEntries(id).map(toRegistrationEntry);
  }

  newEntryId(id: string): string {
    // One numbering over the field and the held entries (ids and seeds), so a held row never takes a field id.
    let highest = 0;
    for (const r of this.store.registrationEntries(id)) {
      highest = Math.max(highest, r.seed);
      const n = Number(/:entrant:(\d+)$/.exec(r.id)?.[1]);
      if (Number.isSafeInteger(n)) highest = Math.max(highest, n);
    }
    return `${id}:entrant:${highest + 1}`;
  }

  /** Is this change accepting an entry that rests on a library team? A re-entry is judged on the incoming (patched)
   *  record, not the old stored roster; a brand-new entry is judged on its own record (the route already refuses refs). */
  private legacyLibrary(row: TournamentEntrantRecord | undefined, change: RegistrationChange): boolean {
    const data = change.after.data as TournamentEntryData | undefined;
    if (change.transition.action === "reenter" && data?.record) return isLegacyLibraryEntry(data.record);
    return Boolean(row && isLegacyLibraryEntry(row));
  }

  promotionBlocked(id: string, entry: RegistrationEntry): boolean {
    const row = this.store.registrationEntries(id).find((r) => r.id === entry.id);
    return Boolean(row && isLegacyLibraryEntry(row));
  }

  commit(id: string, changes: readonly RegistrationChange[]): void {
    const tournament = this.store.tournament(id);
    const stored = new Map(this.store.registrationEntries(id).map((r) => [r.id, r]));
    const codes = new Set(referenceCodes([...stored.values()]).values());
    const now = this.opts.now?.() ?? new Date();
    // A fork library team is never a source (owner 11-03). An entry made with one before that rule (a team and no submitted
    // roster) is not accepted or promoted: the organisers ask the coach to register again with a saved team. Entries that were
    // already accepted stay as they are (history is not rewritten); the entry itself stays pending / waitlisted.
    for (const change of changes) {
      if (change.after.state !== "accepted" || change.before?.state === "accepted") continue;
      if (this.legacyLibrary(stored.get(change.after.id), change)) throw new RegistrationError(409, "invalid-transition", LEGACY_LIBRARY_MESSAGE);
    }
    const writes: RegistrationWrite[] = changes.map((change) => {
      const after = change.after;
      const data = after.data as TournamentEntryData | undefined;
      const reg: RegistrationWrite["reg"] = {
        entryState: after.state,
        registeredAt: after.enteredAt,
        ...(after.submittedAt !== after.enteredAt ? { firstRegisteredAt: after.submittedAt } : {}),
        ...(after.waitlistAt ? { waitlistAt: after.waitlistAt } : {}),
        ...(after.waitlistSeq !== undefined ? { waitlistSeq: after.waitlistSeq } : {}),
        ...(after.decided ? { decided: after.decided } : {}),
        registrationLog: after.log,
      };
      const action = change.transition.action;
      const write: RegistrationWrite = { id: after.id, reg };
      if (action === "submit" && !stored.has(after.id)) {
        if (!data?.record) throw new Error("A new tournament entry needs its record.");
        const refCode = newReferenceCode(codes);
        codes.add(refCode);
        const seed = Number(/:entrant:(\d+)$/.exec(after.id)?.[1]) || 0;
        write.create = { ...structuredClone(data.record), id: after.id, tournamentId: id, seed, registeredAt: after.enteredAt, refCode } as TournamentEntrantRecord;
      } else if (action === "reenter") {
        write.reentry = true;
        if (data?.record) {
          const { flags: _flags, refCode: _code, coachSaysPaid: _paid, ...fields } = data.record;
          // The row keeps its id, reference code, Paid flag and "I've paid"; everything the coach answers comes from the
          // new submission (an undefined value removes the old one when the file is written).
          write.patch = {
            submission: undefined, nafNumber: undefined, notNafMember: undefined, nafPending: undefined, region: undefined,
            rosterVerifiedOverride: undefined, ...structuredClone(fields),
          };
        }
      }
      // An accepted entry leaving a NAF-sanctioned tournament: freeze its NAF details for the NAF report.
      const before = change.before;
      if (before?.state === "accepted" && (after.state === "withdrawn" || after.state === "dropped") && tournament?.nafSanctioned) {
        const record = stored.get(after.id);
        const snapshot = record ? this.opts.nafSnapshot?.(tournament, record) : undefined;
        if (snapshot) write.patch = { ...(write.patch ?? {}), nafSnapshot: { ...snapshot, at: now.toISOString() } };
      }
      return write;
    });
    this.store.commitRegistration(id, writes, now, registrationCommitGuard(id, changes, now));
  }

  markCheckInNotice(id: string, notice: CheckInNoticeRecord): void {
    this.store.setCheckInNotice(id, notice);
  }

  link(id: string, audience: "coach" | "organiser"): string {
    return tournamentRegistrationLink(id, audience);
  }
}

export interface TournamentRegistrationDeps extends TournamentAdapterOptions {
  notify?: RegistrationNotifySink;
}

/** The registration service of one tournament store (the process-wide lock is shared by every instance). */
export function tournamentRegistrationService(store: TournamentStore, deps: TournamentRegistrationDeps = {}) {
  const adapter = new TournamentRegistrationAdapter(store, deps);
  return createRegistrationService({ adapter, ...(deps.notify ? { notify: deps.notify } : {}), ...(deps.now ? { now: deps.now } : {}) });
}
export type TournamentRegistrationService = ReturnType<typeof tournamentRegistrationService>;

// ---- check-in and roster deadline ---------------------------------------------------------------------------------------

/** Check-in as everyone may read it (the times are public settings; nothing about who checked in). */
export function checkInView(t: TournamentRecord, round1: boolean, now: Date) {
  const c = tournamentCompetition(t, round1);
  const w = checkInWindow(c.window, c.startAt);
  if (!w) return undefined;
  const closes = w.closesAt ? Date.parse(w.closesAt) : undefined;
  return {
    opensAt: w.opensAt, ...(w.closesAt ? { closesAt: w.closesAt } : {}), self: w.self,
    open: isCheckInOpen(c, now),
    closed: closes !== undefined && now.getTime() >= closes,
  };
}

/** The roster deadline has passed ("register now, roster later" only). */
/** An entry an organiser added that has no roster yet: its coach may submit the FIRST roster after the roster deadline
 *  (until rosters lock), because the entry was made for them and they never had the deadline to meet. */
export function organiserAddedAwaitingRoster(row: Pick<TournamentEntrantRecord, "coach" | "submission" | "registrationLog">): boolean {
  if (row.submission) return false;
  const first = row.registrationLog?.[0];
  return Boolean(first && first.by.trim().toLowerCase() !== row.coach.ffbCoachId.trim().toLowerCase());
}

export function rosterDeadlinePassed(t: TournamentRecord, now: Date): boolean {
  const by = t.registration?.rosterLater ? t.registration.rosterBy : undefined;
  return by !== undefined && now.getTime() >= Date.parse(by);
}

export const ROSTER_DUE_LEAD_MS = 48 * 60 * 60 * 1000;

/**
 * The scheduled sweep (server.ts, every minute; never from a GET): while check-in is open, every accepted entrant not yet
 * told for this window gets the check-in-open notice (inbox + Discord DM through the queue); within 48 h of the roster
 * deadline, every live entry without a roster gets one "roster due" reminder (inbox + DM). Each notice is recorded on the
 * tournament before the next sweep, once per entry per window / deadline.
 */
export async function sweepTournamentRegistrations(
  store: TournamentStore,
  service: TournamentRegistrationService,
  notify: RegistrationNotifySink | undefined,
  now: Date = new Date(),
): Promise<{ checkIn: number; rosterDue: number }> {
  let checkIn = 0;
  let rosterDue = 0;
  // Rows written before payment references existed get a random one here (a write, never on a read).
  try { ensureReferenceCodes(store); } catch (e) { console.error(`[registration] reference codes: ${(e as Error).message}`); }
  for (const t of store.tournaments(["draft", "active"])) {
    if (t.unpublished === true) continue;
    // "Check in here" only where coaches check themselves in (organiser check-in needs no notice).
    if (tournamentCompetition(t, false).window.checkIn?.self !== false) {
      try { checkIn += await service.sendCheckInNotices(t.id); } catch (e) { console.error(`[registration] check-in notices for ${t.id}: ${(e as Error).message}`); }
    }
    const by = t.registration?.rosterLater ? t.registration.rosterBy : undefined;
    if (!by || !notify) continue;
    const deadline = Date.parse(by);
    if (!(now.getTime() >= deadline - ROSTER_DUE_LEAD_MS && now.getTime() < deadline)) continue;
    const told = new Set(t.rosterDueNotice?.rosterBy === by ? t.rosterDueNotice.entryIds : []);
    const due = store.registrationEntries(t.id).filter((r) => {
      const state = entryStateOf(r);
      return (state === "accepted" || state === "pending" || state === "waitlisted") && !r.submission && !r.teamId && !told.has(r.id);
    });
    if (!due.length) continue;
    store.setRosterDueNotice(t.id, { rosterBy: by, entryIds: [...told, ...due.map((r) => r.id)], at: now.toISOString() });
    for (const r of due) {
      try {
        notify(r.coach.ffbCoachId, {
          type: "roster-problems",
          title: `${t.name}: your roster is due`,
          body: `Submit your roster before ${by.slice(0, 16).replace("T", " ")} UTC.`,
          link: tournamentRegistrationLink(t.id, "coach"),
          subject: t.name,
          action: true,
        });
        rosterDue += 1;
      } catch { /* best effort */ }
    }
  }
  return { checkIn, rosterDue };
}
