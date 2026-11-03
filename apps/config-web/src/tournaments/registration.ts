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

import { createHash, randomInt } from "node:crypto";
import {
  checkInWindow, createRegistrationService, isCheckInOpen, type CheckInNoticeRecord, type CompetitionSnapshot, type EntryState,
  type RegistrationAdapter, type RegistrationChange, type RegistrationEntry, type RegistrationNotifySink,
} from "../registration/index.js";
import { tournamentCompetition } from "./publication.js";
import type { RegistrationWrite, TournamentStore } from "./store.js";
import type { TournamentEntrantRecord, TournamentRecord } from "./types.js";

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

function derivedCode(record: Pick<TournamentEntrantRecord, "id" | "coach" | "registeredAt">, salt: number): string {
  const digest = createHash("sha256").update(`${record.id}|${record.coach.verifiedAt}|${record.registeredAt}|${salt}`).digest();
  let out = "";
  for (let i = 0; i < REF_LENGTH; i++) out += REF_ALPHABET[digest[i]! % REF_ALPHABET.length];
  return `SF-${out}`;
}

/**
 * Every entry's reference code: the stored one, else (rows written before codes existed) one derived from the entry's
 * private fields, unique within the tournament. Coach and managers only: never on a public read.
 */
export function referenceCodes(records: readonly TournamentEntrantRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const r of records) if (r.refCode && REF_CODE.test(r.refCode)) { out.set(r.id, r.refCode); taken.add(r.refCode); }
  for (const r of [...records].sort((a, b) => a.id.localeCompare(b.id))) {
    if (out.has(r.id)) continue;
    let salt = 0;
    let code = derivedCode(r, salt);
    while (taken.has(code)) code = derivedCode(r, ++salt);
    taken.add(code);
    out.set(r.id, code);
  }
  return out;
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

  commit(id: string, changes: readonly RegistrationChange[]): void {
    const tournament = this.store.tournament(id);
    const stored = new Map(this.store.registrationEntries(id).map((r) => [r.id, r]));
    const codes = new Set(referenceCodes([...stored.values()]).values());
    const now = this.opts.now?.() ?? new Date();
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
    this.store.commitRegistration(id, writes, now);
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
