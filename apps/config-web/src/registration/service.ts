// The registration state machine (registration spec §2, §7; lane L0):
//
//   submit  -> pending (organiser mode) | accepted (auto, room) | waitlisted (auto, full, waitlist on) | refused "Full"
//   pending -> accepted | waitlisted | declined | withdrawn
//   waitlisted -> accepted (promoted) | declined | withdrawn
//   accepted -> withdrawn | dropped
//   withdrawn -> (re-entry while open: same id, back of the waitlist if full)
//
// Every action runs inside the competition's lock (read entries -> decide -> commit), is idempotent (asking for the state
// the entry is already in changes nothing and notifies nobody) and appends an audited transition { by, at, reason }.
// Auto mode promotes the first waitlisted entry that fits whenever a place frees; organiser mode tells the organisers.

import { registrationLocks, type KeyedLock } from "./lock.js";
import {
  notifyCheckInOpen, notifyCoachOutcome, notifyOrganisersOfRegistration, notifyPlaceFreed, notifyWithdrawal,
  type NotifyContext, type RegistrationNotifySink,
} from "./notify.js";
import { assertTestSessionMayWrite } from "./testSession.js";
import {
  ACTIVE_ENTRY_STATES, RegistrationError, type CompetitionSnapshot, type EntryState, type RegistrationActor,
  type RegistrationAdapter, type RegistrationChange, type RegistrationEntry, type RegistrationResult, type TransitionAction,
} from "./types.js";
import {
  checkInWindow, isCheckInOpen, nextWaitlistSeq, organiserMayAdd, roomFor, waitlistOrder, waitlistPosition, windowStatus,
} from "./window.js";

export const SYSTEM_ACTOR = "system";
const REASON_MAX = 500;

export interface RegistrationServiceDeps {
  adapter: RegistrationAdapter;
  /** Notification sink (NotificationStore.add); failures are logged, never change the action's result. */
  notify?: RegistrationNotifySink;
  now?: () => Date;
  lock?: KeyedLock;
  log?: (line: string) => void;
}

export interface SubmitOptions {
  race?: string;
  data?: Record<string, unknown>;
  /** Organisers adding a coach when it's full: put them on the waitlist instead of refusing. */
  waitlistIfFull?: boolean;
  /** One thing the organisers must know about this entry, added to their notice (a tournament: "not a NAF member"). */
  organiserFlag?: string;
}

const coachKey = (coach: string) => coach.trim().toLowerCase();
const cleanReason = (reason: string | undefined) => {
  const r = reason?.trim();
  return r ? [...r].slice(0, REASON_MAX).join("") : undefined;
};

export type RegistrationService = ReturnType<typeof createRegistrationService>;

export function createRegistrationService(deps: RegistrationServiceDeps) {
  const { adapter } = deps;
  const lock = deps.lock ?? registrationLocks;
  const now = () => deps.now?.() ?? new Date();
  const log = deps.log ?? ((l: string) => console.error(`[registration] ${l}`));

  const isManager = (c: CompetitionSnapshot, actor: RegistrationActor) =>
    actor.admin === true || c.managers.some((m) => coachKey(m) === coachKey(actor.coach));

  /** Load the competition and apply the checks every action shares (exists, test-session rule). */
  async function load(competitionId: string, actor: RegistrationActor) {
    const competition = await adapter.competition(competitionId);
    if (!competition) throw new RegistrationError(404, "not-found", "Not found.");
    assertTestSessionMayWrite(actor, competition);
    const entries = await adapter.entries(competitionId);
    return { competition, entries: entries.map((e) => structuredClone(e)) };
  }

  function notifyCtx(c: CompetitionSnapshot): NotifyContext {
    return {
      competition: c,
      link: (audience) => adapter.link(c.id, audience),
      send: (coach, input) => {
        if (!deps.notify) return;
        try { deps.notify(coach, input); } catch (e) { log(`notify failed: ${(e as Error).message}`); }
      },
    };
  }

  /** A changed copy of `entry` with the audited transition appended. */
  function transition(entry: RegistrationEntry, to: EntryState, action: TransitionAction, by: string, at: string, reason?: string, entries: readonly RegistrationEntry[] = []): RegistrationChange {
    const before = structuredClone(entry);
    const r = cleanReason(reason);
    const t = { action, from: entry.state, to, by, at, ...(r ? { reason: r } : {}) };
    const after: RegistrationEntry = { ...structuredClone(entry), state: to, log: [...entry.log, t] };
    if (to === "waitlisted" && entry.state !== "waitlisted") { after.waitlistAt = at; after.waitlistSeq = nextWaitlistSeq(entries); }
    if (to !== "waitlisted") { delete after.waitlistAt; delete after.waitlistSeq; }
    if (action === "accept" || action === "promote" || action === "waitlist" || action === "decline" || action === "drop")
      after.decided = { by, at, ...(r ? { reason: r } : {}) };
    return { before, after, transition: t };
  }

  /** Replace `entry` in the working list (so later decisions in the same action see it). */
  const put = (entries: RegistrationEntry[], entry: RegistrationEntry) => {
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i < 0) entries.push(entry);
    else entries[i] = entry;
  };

  /** Auto mode: promote waitlisted entries, first in line first, while each fits. Organiser mode: nothing. Never once
   *  the competition can't take entries (finished, rosters locked, play started without mid-season joining): the same
   *  lifecycle check as an organiser accept. */
  function autoPromote(c: CompetitionSnapshot, entries: RegistrationEntry[], at: string): RegistrationChange[] {
    if (c.window.approval !== "auto" || !organiserMayAdd(c).open) return [];
    const out: RegistrationChange[] = [];
    for (const next of waitlistOrder(entries)) {
      if (!roomFor(c.window, entries, next).ok) continue;
      const change = transition(next, "accepted", "promote", SYSTEM_ACTOR, at);
      put(entries, change.after);
      out.push(change);
    }
    return out;
  }

  async function commit(c: CompetitionSnapshot, changes: RegistrationChange[]) {
    if (changes.length) await adapter.commit(c.id, changes);
  }

  const lockKey = (competitionId: string) => `${adapter.kind}:${competitionId}`;

  /** After a place freed: auto mode promotes (returns the promotions); organiser mode tells the organisers once. */
  function afterFreed(c: CompetitionSnapshot, entries: RegistrationEntry[], at: string, freed: boolean) {
    if (!freed) return { promotions: [] as RegistrationChange[], tellOrganisers: false };
    const promotions = autoPromote(c, entries, at);
    const tellOrganisers = c.window.approval === "organiser" && waitlistOrder(entries).length > 0;
    return { promotions, tellOrganisers };
  }

  function result(entry: RegistrationEntry, changed: boolean, promotions: RegistrationChange[] = []): RegistrationResult {
    return { entry: structuredClone(entry), changed, promoted: promotions.map((p) => structuredClone(p.after)) };
  }

  function notifyPromotions(ctx: NotifyContext, promotions: RegistrationChange[]) {
    for (const p of promotions) notifyCoachOutcome(ctx, p.after, "promoted");
  }

  /** Find an entry by id; 404 when it is not in this competition. */
  function entryById(entries: RegistrationEntry[], entryId: string): RegistrationEntry {
    const e = entries.find((x) => x.id === entryId);
    if (!e) throw new RegistrationError(404, "not-found", "Entry not found.");
    return e;
  }

  function requireManager(c: CompetitionSnapshot, actor: RegistrationActor) {
    if (!isManager(c, actor)) throw new RegistrationError(403, "forbidden", "Only this competition's organisers can do that.");
  }

  const invalid = (from: EntryState, what: string) =>
    new RegistrationError(409, "invalid-transition", `A ${from} entry can't be ${what}.`);

  return {
    /**
     * Register `coach` (the actor themselves, or an organiser adding them). Re-submitting a live entry changes nothing.
     * A withdrawn entry is reactivated with its id (back of the waitlist when full). A declined or removed entry can be
     * renewed only by an organiser.
     */
    async submit(competitionId: string, coach: string, actor: RegistrationActor, opts: SubmitOptions = {}): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        const self = coachKey(coach) === coachKey(actor.coach);
        if (!coachKey(coach)) throw new RegistrationError(400, "invalid-transition", "A coach is required.");
        if (!self) requireManager(c, actor);
        // A coach registering themselves needs the open window; organisers (also entering themselves) may add until play starts.
        const selfService = self && !isManager(c, actor);
        const status = selfService ? windowStatus(c, now()) : organiserMayAdd(c);
        if (!status.open) throw new RegistrationError(409, "closed", status.message);

        const at = now().toISOString();
        const existing = entries.find((e) => coachKey(e.coach) === coachKey(coach));
        if (existing && ACTIVE_ENTRY_STATES.has(existing.state)) return result(existing, false);
        if (existing && selfService && existing.state === "declined")
          throw new RegistrationError(409, "declined", "The organisers declined your entry. Message them if you think that's a mistake.");
        if (existing && selfService && existing.state === "dropped")
          throw new RegistrationError(409, "removed", "The organisers removed your entry. Message them if you think that's a mistake.");

        const changes: RegistrationChange[] = [];
        // Auto mode: anyone already waiting goes first if a place is free (e.g. the cap was raised).
        changes.push(...autoPromote(c, entries, at));

        const base: RegistrationEntry = existing
          ? { ...structuredClone(existing), enteredAt: at, ...(opts.race !== undefined ? { race: opts.race } : {}), ...(opts.data !== undefined ? { data: opts.data } : {}) }
          : {
              id: adapter.newEntryId(c.id, entries), competitionId: c.id, coach: coach.trim(), state: "pending",
              submittedAt: at, enteredAt: at, log: [],
              ...(opts.race !== undefined ? { race: opts.race } : {}), ...(opts.data !== undefined ? { data: opts.data } : {}),
            };
        const action: TransitionAction = existing ? "reenter" : "submit";
        const from = existing ? existing.state : null;

        let to: EntryState;
        if (selfService && c.window.approval === "organiser") to = "pending";
        else {
          const room = roomFor(c.window, entries, base);
          if (room.ok) to = "accepted";
          else if (selfService ? c.window.waitlist : opts.waitlistIfFull === true) to = "waitlisted";
          else throw new RegistrationError(409, room.code, room.code === "race-full" ? "That race is full." : "Full.");
        }
        const t = { action, from, to, by: actor.coach, at };
        const after: RegistrationEntry = { ...base, state: to, log: [...base.log, t] };
        delete after.waitlistSeq;
        if (to === "waitlisted") { after.waitlistAt = at; after.waitlistSeq = nextWaitlistSeq(entries); }
        else delete after.waitlistAt;
        delete after.decided;
        if (!self && to === "accepted") after.decided = { by: actor.coach, at };
        changes.push({ ...(existing ? { before: structuredClone(existing) } : {}), after, transition: t });
        put(entries, after);
        await commit(c, changes);

        const ctx = notifyCtx(c);
        const promotions = changes.filter((ch) => ch.transition.action === "promote");
        notifyPromotions(ctx, promotions);
        const position = waitlistPosition(entries, after.id);
        notifyCoachOutcome(ctx, after, to === "accepted" ? "accepted" : to === "waitlisted" ? "waitlisted" : "pending", position ? { position } : {});
        notifyOrganisersOfRegistration(ctx, after, actor.coach, { ...(position ? { position } : {}), ...(opts.organiserFlag ? { flag: opts.organiserFlag } : {}) });
        return result(after, true, promotions);
      });
    },

    /** Organiser: accept a pending or waitlisted entry (a waitlisted one is "promoted"). Refused when it's full. */
    async accept(competitionId: string, entryId: string, actor: RegistrationActor, reason?: string): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        requireManager(c, actor);
        const entry = entryById(entries, entryId);
        if (entry.state === "accepted") return result(entry, false);
        if (entry.state !== "pending" && entry.state !== "waitlisted") throw invalid(entry.state, "accepted");
        const addable = organiserMayAdd(c);
        if (!addable.open) throw new RegistrationError(409, "closed", addable.message);
        const room = roomFor(c.window, entries, entry);
        if (!room.ok)
          throw new RegistrationError(409, room.code, room.code === "race-full" ? "That race is full. Raise the per-race limit or waitlist the team." : "It's full. Raise the cap or waitlist the entry.");
        const promoted = entry.state === "waitlisted";
        const change = transition(entry, "accepted", promoted ? "promote" : "accept", actor.coach, now().toISOString(), reason);
        put(entries, change.after);
        await commit(c, [change]);
        notifyCoachOutcome(notifyCtx(c), change.after, promoted ? "promoted" : "accepted");
        return result(change.after, true);
      });
    },

    /** Organiser: move a pending entry to the waitlist. */
    async waitlist(competitionId: string, entryId: string, actor: RegistrationActor, reason?: string): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        requireManager(c, actor);
        const entry = entryById(entries, entryId);
        if (entry.state === "waitlisted") return result(entry, false);
        if (entry.state !== "pending") throw invalid(entry.state, "waitlisted");
        const change = transition(entry, "waitlisted", "waitlist", actor.coach, now().toISOString(), reason, entries);
        put(entries, change.after);
        await commit(c, [change]);
        const position = waitlistPosition(entries, change.after.id);
        notifyCoachOutcome(notifyCtx(c), change.after, "waitlisted", position ? { position } : {});
        return result(change.after, true);
      });
    },

    /** Organiser: decline a pending or waitlisted entry (optional reason, shown to the coach). */
    async decline(competitionId: string, entryId: string, actor: RegistrationActor, reason?: string): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        requireManager(c, actor);
        const entry = entryById(entries, entryId);
        if (entry.state === "declined") return result(entry, false);
        if (entry.state !== "pending" && entry.state !== "waitlisted") throw invalid(entry.state, "declined");
        const change = transition(entry, "declined", "decline", actor.coach, now().toISOString(), reason);
        put(entries, change.after);
        await commit(c, [change]);
        notifyCoachOutcome(notifyCtx(c), change.after, "declined", { ...(change.transition.reason ? { reason: change.transition.reason } : {}) });
        return result(change.after, true);
      });
    },

    /**
     * The coach (or an organiser) withdraws an entry. A coach may withdraw a pending or waitlisted entry any time, and an
     * accepted tournament entry until play starts; leaving an accepted league place is an organiser action (§5).
     */
    async withdraw(competitionId: string, entryId: string, actor: RegistrationActor, reason?: string): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        const entry = entryById(entries, entryId);
        const manager = isManager(c, actor);
        if (!manager && coachKey(entry.coach) !== coachKey(actor.coach)) throw new RegistrationError(403, "forbidden", "That isn't your entry.");
        if (entry.state === "withdrawn") return result(entry, false);
        if (!ACTIVE_ENTRY_STATES.has(entry.state)) throw invalid(entry.state, "withdrawn");
        if (entry.state === "accepted" && !manager) {
          if (c.kind === "league") throw new RegistrationError(409, "organiser-only", "Your team is in the league. Ask the organisers to remove it.");
          if (c.started) throw new RegistrationError(409, "closed", "You can't withdraw after play has started. Ask the organisers.");
        }
        const at = now().toISOString();
        const freed = entry.state === "accepted";
        const change = transition(entry, "withdrawn", "withdraw", actor.coach, at, reason);
        put(entries, change.after);
        const { promotions, tellOrganisers } = afterFreed(c, entries, at, freed);
        await commit(c, [change, ...promotions]);
        const ctx = notifyCtx(c);
        notifyWithdrawal(ctx, change.after, actor.coach);
        notifyPromotions(ctx, promotions);
        if (tellOrganisers) notifyPlaceFreed(ctx, SYSTEM_ACTOR, waitlistOrder(entries).length);
        return result(change.after, true, promotions);
      });
    },

    /** Organiser: remove an accepted entry (standby / remove). Frees the place. */
    async drop(competitionId: string, entryId: string, actor: RegistrationActor, reason?: string): Promise<RegistrationResult> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        requireManager(c, actor);
        const entry = entryById(entries, entryId);
        if (entry.state === "dropped") return result(entry, false);
        if (entry.state !== "accepted") throw invalid(entry.state, "removed");
        const at = now().toISOString();
        const change = transition(entry, "dropped", "drop", actor.coach, at, reason);
        put(entries, change.after);
        const { promotions, tellOrganisers } = afterFreed(c, entries, at, true);
        await commit(c, [change, ...promotions]);
        const ctx = notifyCtx(c);
        notifyCoachOutcome(ctx, change.after, "removed", { ...(change.transition.reason ? { reason: change.transition.reason } : {}) });
        notifyPromotions(ctx, promotions);
        if (tellOrganisers) notifyPlaceFreed(ctx, actor.coach, waitlistOrder(entries).length);
        return result(change.after, true, promotions);
      });
    },

    /**
     * Auto mode: promote everyone who now fits (after the cap was raised). Idempotent: a second call promotes nobody.
     * Organiser mode: promotes nobody (the organisers decide). Returns the promoted entries.
     */
    async promoteWaitlist(competitionId: string, actor: RegistrationActor): Promise<RegistrationEntry[]> {
      return lock.run(lockKey(competitionId), async () => {
        const { competition: c, entries } = await load(competitionId, actor);
        requireManager(c, actor);
        const promotions = autoPromote(c, entries, now().toISOString());
        await commit(c, promotions);
        notifyPromotions(notifyCtx(c), promotions);
        return promotions.map((p) => structuredClone(p.after));
      });
    },

    /**
     * While check-in is open, send the check-in-open notice (actionable: DM) to every accepted entry not yet told for
     * this window: once per entry per window, so a coach promoted during check-in gets it on the next call and a moved
     * window starts over. Returns how many coaches were told.
     */
    async sendCheckInNotices(competitionId: string): Promise<number> {
      return lock.run(lockKey(competitionId), async () => {
        const c = await adapter.competition(competitionId);
        if (!c || !isCheckInOpen(c, now())) return 0;
        const w = checkInWindow(c.window, c.startAt);
        const windowKey = `${w?.opensAt ?? ""}|${w?.closesAt ?? ""}`;
        const told = new Set(c.checkInNotice?.window === windowKey ? c.checkInNotice.entryIds : []);
        const due = (await adapter.entries(competitionId)).filter((e) => e.state === "accepted" && !told.has(e.id));
        if (!due.length) return 0;
        await adapter.markCheckInNotice(c.id, { window: windowKey, entryIds: [...told, ...due.map((e) => e.id)], at: now().toISOString() });
        return notifyCheckInOpen(notifyCtx(c), due, w?.closesAt);
      });
    },

    /** The coach's place in line (1 = next), or undefined. Read-only. */
    async position(competitionId: string, entryId: string): Promise<number | undefined> {
      return waitlistPosition(await adapter.entries(competitionId), entryId);
    },
  };
}
