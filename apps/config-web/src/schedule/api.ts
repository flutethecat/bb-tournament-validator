// Game-time proposals and the coach Schedule (spec-main-landing-nav §4.6; hub spec §6-7; ruling §7). Pure: server.ts
// hands in the session coach, the parsed body and the deps (proposals store, fixture source, identity lookups, blocks,
// notifier, limiter).
//
//   GET  /api/schedule/mine      the coach's open fixtures (scheduled or not), proposals, opponents' timezones and busy
//                                slots, and the counts (to answer / waiting / need to schedule / scheduled)
//   GET  /api/schedule/pending   { pending }: proposals waiting for this coach's answer (nav badge)
//   POST /api/schedule/propose   { fixture, slots: ISO[1..3] }            -> 201 { proposal, warnings }
//   POST /api/schedule/respond   { proposalId, action: "accept", slot }   -> sets the fixture's time
//                                { proposalId, action: "counter", slots } -> a new proposal the other way
//                                { proposalId, action: "decline" }
//                                { proposalId, action: "withdraw" }       (the sender)
//
// Rules: proposals exist only for existing fixtures where both coaches hold a seat (fixtures.ts); accepting writes the
// agreed 2-hour slot onto the fixture and never creates one. A slot that overlaps a confirmed game of either coach is
// refused (conflict suppression); slots outside 09:00-22:00 in the answering coach's timezone, after the fixture's
// deadline, or for an opponent with no timezone come back as warnings (still sendable: the organisers' rules apply).
// Blocked coaches (either direction) cannot propose to each other. One notification to the other coach per proposal,
// counter and accept. GETs never write. CSRF and the onboarding 428 gate run in front of every /api write (server.ts).
// Privacy: coaches are named by coach name only; an opponent's timezone, weekly availability and confirmed-game slots
// (times only) are shown only to a coach who shares an open fixture with them and is not blocked.

import type { NotificationInput } from "../notifications.js";
import type { SenderRateLimiter } from "../notifications.js";
import { DeletionFenceError, isReservedCoachName } from "../privacy/fence.js";
import { accountKey, parseRef, slotOf, type AgreedTime, type FixtureEntry, type FixtureSource } from "./fixtures.js";
import {
  isExpired, MAX_SLOTS, PROPOSAL_ID, ProposalStore, sameCoach, ScheduleStoreError, SLOT_MS, type ProposalRecord,
} from "./store.js";

export const SOCIAL_START = 9 * 60;
export const SOCIAL_END = 22 * 60;
/** Slots may be proposed at most this far ahead. */
export const MAX_AHEAD_MS = 366 * 24 * 3_600_000;
/** Answered proposals stay in the list's history this long. */
export const HISTORY_MS = 14 * 24 * 3_600_000;
export const NOT_ACCEPTING = "This coach is not accepting game proposals. Ask the organiser to set a time.";
/** An opponent seat with no account behind it (test or imported data only). Never says "Super FUMBBL" (laws §E 23b). */
export const OPPONENT_UNLINKED = "This fixture's opponent isn't linked to an account on this site yet. Ask the organiser.";
export const YOU_BLOCKED = "You blocked this coach. Unblock them to propose a time.";

export interface ScheduleAuth { coach: string; test?: boolean }
export interface ScheduleBlockView { day: number; start: string; end: string }
export interface SchedulingInfo { timezone: string; availability: ScheduleBlockView[] }

export interface ScheduleApiDeps {
  store: ProposalStore;
  fixtures: FixtureSource;
  /** The coach's identity spelling when an active (not banned) account exists, else undefined. */
  coach(name: string): string | undefined;
  /** The coach's saved timezone and weekly availability (identity CoachScheduling), if any. */
  scheduling(coach: string): SchedulingInfo | undefined;
  /** `a` blocked `b` (one direction). */
  hasBlocked(a: string, b: string): boolean;
  isFenced(coach: string): boolean;
  notify?(coach: string, input: NotificationInput): void;
  limiter: SenderRateLimiter;
  now?: () => number;
}

export interface ScheduleApiResult { status: number; body: unknown }

export type WarningCode = "unsocial" | "no-timezone" | "after-deadline";
export interface SlotWarning { code: WarningCode; slot?: string; text: string }

export const isScheduleApiPath = (path: string): boolean => /^\/api\/schedule\/(mine|pending|propose|respond)$/.test(path);

const err = (status: number, error: string, extra: Record<string, unknown> = {}): ScheduleApiResult => ({ status, body: { error, ...extra } });
const obj = (body: unknown): Record<string, unknown> | undefined => (body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined);

// ---- time helpers (pure) --------------------------------------------------------------------------------------------

export function validZone(tz: string | undefined): boolean {
  if (!tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

/** Minutes after local midnight and the local day key of an instant in a timezone. */
export function localClock(t: number, timeZone: string): { minutes: number; day: string; text: string } {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
  const g = (type: string) => p.find((x) => x.type === type)?.value ?? "";
  const hh = g("hour");
  const mm = g("minute");
  return { minutes: Number(hh) * 60 + Number(mm), day: `${g("year")}-${g("month")}-${g("day")}`, text: `${hh}:${mm}` };
}

/** True when the whole 2-hour slot lies within 09:00-22:00 on one day in the timezone. */
export function socialSlot(start: string, timeZone: string): boolean {
  const s = Date.parse(start);
  const a = localClock(s, timeZone);
  const b = localClock(s + SLOT_MS, timeZone);
  return a.day === b.day && a.minutes >= SOCIAL_START && b.minutes <= SOCIAL_END;
}

/** A slot start: an ISO instant with an explicit zone on a quarter hour (seconds 0), as UTC ISO; undefined otherwise. */
export function parseSlot(v: unknown): string | undefined {
  if (typeof v !== "string" || v.length > 40) return undefined;
  const s = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:00(\.0{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return undefined;
  const t = Date.parse(s);
  if (!Number.isFinite(t) || t % (15 * 60_000) !== 0) return undefined;
  return new Date(t).toISOString();
}

const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number): boolean => aStart < bEnd && bStart < aEnd;

/** The confirmed games (agreed times) of a coach, except one fixture. */
export function busyOf(deps: ScheduleApiDeps, coach: string, exceptRef?: string): AgreedTime[] {
  return deps.fixtures.forCoach(coach).filter((e) => e.scheduled && e.ref !== exceptRef).map((e) => e.scheduled!);
}

/** The slots that overlap a confirmed game in `busy`. */
export function clashing(slots: readonly string[], busy: readonly AgreedTime[]): string[] {
  return slots.filter((s) => {
    const a = Date.parse(s);
    return busy.some((b) => overlaps(a, a + SLOT_MS, Date.parse(b.start), Date.parse(b.end)));
  });
}

function formatIn(at: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));
}

/** Warnings for slots offered to `opponent` (unsocial hours in their zone, no zone, after the fixture's deadline). */
export function slotWarnings(slots: readonly string[], opponentZone: string | undefined, deadline: string | undefined): SlotWarning[] {
  const out: SlotWarning[] = [];
  if (!validZone(opponentZone)) out.push({ code: "no-timezone", text: "The opposing coach has no timezone set, so we cannot check their local time." });
  else {
    for (const s of slots) {
      if (socialSlot(s, opponentZone!)) continue;
      const a = localClock(Date.parse(s), opponentZone!);
      const b = localClock(Date.parse(s) + SLOT_MS, opponentZone!);
      out.push({ code: "unsocial", slot: s, text: `${a.text}-${b.text} for the opposing coach (${opponentZone}), outside 09:00-22:00.` });
    }
  }
  const dl = deadline ? Date.parse(deadline) : Number.NaN;
  if (Number.isFinite(dl)) {
    for (const s of slots) if (Date.parse(s) + SLOT_MS > dl) out.push({ code: "after-deadline", slot: s, text: "After the fixture's deadline. The organisers' rules decide whether it counts." });
  }
  return out;
}

// ---- views ----------------------------------------------------------------------------------------------------------

interface Seat { mine: "home" | "away"; /** More than one account holds the coach's own seat. */ shared: boolean; opponentKey?: string; opponentTeam: string; myTeam: string; opponentLabel: string }

/** The coach's seat on a fixture, and the single coach holding the other seat (undefined = none or ambiguous). The same
 *  "exactly one account holds the seat" rule applies to the coach's own seat (`shared`). */
function seatOf(e: FixtureEntry, coach: string): Seat | undefined {
  const key = accountKey(coach);
  const mine = e.sides.home.owners.includes(key) ? "home" : e.sides.away.owners.includes(key) ? "away" : undefined;
  if (!mine) return undefined;
  const other = mine === "home" ? e.sides.away : e.sides.home;
  const own = mine === "home" ? e.sides.home : e.sides.away;
  const opp = other.owners.filter((o) => o !== key);
  return { mine, shared: own.owners.length !== 1, ...(opp.length === 1 ? { opponentKey: opp[0] } : {}), opponentTeam: other.team, myTeam: own.team, opponentLabel: other.team || other.coach };
}

function fixtureTitle(e: FixtureEntry, seat: Seat): string {
  return `${e.round ? `Round ${e.round} ` : ""}vs ${seat.opponentLabel || "TBC"}`;
}

/** Why the coach cannot propose on this fixture (undefined = they can), and the opponent's identity spelling. */
function proposeBlocker(deps: ScheduleApiDeps, me: string, seat: Seat): { reason?: string; status?: number; opponent?: string } {
  if (seat.shared) return { status: 409, reason: "More than one account is linked to your team on this fixture. Ask the organiser to assign the coach account." };
  // Only test or imported data has an unlinked seat (every live coach registers with an account, laws §E 23b).
  if (!seat.opponentKey) return { status: 409, reason: OPPONENT_UNLINKED };
  if (isReservedCoachName(seat.opponentKey)) return { status: 410, reason: "This coach's account was deleted." };
  const opponent = deps.coach(seat.opponentKey);
  if (!opponent) return { status: 409, reason: OPPONENT_UNLINKED };
  if (deps.hasBlocked(opponent, me) || deps.isFenced(opponent)) return { status: 403, reason: NOT_ACCEPTING, opponent };
  if (deps.hasBlocked(me, opponent)) return { status: 403, reason: YOU_BLOCKED, opponent };
  return { opponent };
}

function proposalView(p: ProposalRecord, me: string, now: number) {
  return {
    id: p.id,
    fixture: p.fixture,
    from: p.from,
    to: p.to,
    mine: sameCoach(p.from, me),
    slots: p.slots.map((s) => slotOf(s)),
    status: isExpired(p, now) ? "expired" : p.status,
    createdAt: p.createdAt,
    ...(p.answeredAt ? { answeredAt: p.answeredAt } : {}),
    ...(p.acceptedSlot ? { acceptedSlot: p.acceptedSlot } : {}),
    ...(p.counterOf ? { counterOf: p.counterOf } : {}),
  };
}

function mine(deps: ScheduleApiDeps, me: string, now: number) {
  const entries = deps.fixtures.forCoach(me);
  const own = deps.scheduling(me);
  const fixtures = entries.map((e) => {
    const seat = seatOf(e, me)!;
    const b = proposeBlocker(deps, me, seat);
    const opponentInfo = b.opponent && !b.reason ? deps.scheduling(b.opponent) : undefined;
    const pending = deps.store.pendingFor(e.ref).find((p) => sameCoach(p.from, me) || sameCoach(p.to, me));
    return {
      ref: e.ref,
      kind: e.kind,
      title: fixtureTitle(e, seat),
      competition: e.competition,
      round: e.round,
      myTeam: seat.myTeam,
      opponentTeam: seat.opponentTeam,
      opponent: b.opponent
        ? {
            coach: b.opponent,
            // Only between coaches who may propose to each other: blocked pairs see the name (public on the fixture) only.
            ...(b.reason ? {} : {
              timezone: validZone(opponentInfo?.timezone) ? opponentInfo!.timezone : null,
              availability: opponentInfo?.availability ?? [],
              busy: busyOf(deps, b.opponent, e.ref).filter((x) => Date.parse(x.end) > now).map((x) => ({ start: x.start, end: x.end })),
            }),
          }
        : null,
      ...(e.deadline ? { deadline: e.deadline } : {}),
      ...(e.scheduled ? { scheduled: e.scheduled } : {}),
      link: e.link,
      canPropose: !b.reason,
      ...(b.reason ? { reason: b.reason } : {}),
      ...(pending && !isExpired(pending, now) ? { pendingProposal: pending.id } : {}),
    };
  }).sort((a, b) => (a.scheduled?.start ?? a.deadline ?? "9999").localeCompare(b.scheduled?.start ?? b.deadline ?? "9999") || a.ref.localeCompare(b.ref));
  const openRefs = new Set(entries.map((e) => e.ref));
  const proposals = deps.store.forCoach(me)
    .filter((p) => openRefs.has(p.fixture) && (p.status === "pending" || now - Date.parse(p.answeredAt ?? p.createdAt) < HISTORY_MS))
    .map((p) => proposalView(p, me, now));
  const live = proposals.filter((p) => p.status === "pending");
  return {
    coach: me,
    timezone: validZone(own?.timezone) ? own!.timezone : "",
    availability: own?.availability ?? [],
    fixtures,
    proposals,
    counts: {
      toAnswer: live.filter((p) => !p.mine).length,
      waiting: live.filter((p) => p.mine).length,
      needToSchedule: fixtures.filter((f) => !f.scheduled).length,
      scheduled: fixtures.filter((f) => f.scheduled).length,
    },
  };
}

function pendingCount(deps: ScheduleApiDeps, me: string, now: number): number {
  let n = 0;
  for (const p of deps.store.forCoach(me)) {
    if (p.status !== "pending" || !sameCoach(p.to, me) || isExpired(p, now)) continue;
    const e = deps.fixtures.byRef(p.fixture);
    if (e && seatOf(e, me)) n++;
  }
  return n;
}

// ---- writes ---------------------------------------------------------------------------------------------------------

/** Validates 1-3 candidate slots: future, at most a year ahead, distinct and not overlapping each other. */
function readSlots(raw: unknown, now: number): { slots: string[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: "Pick at least one time." };
  if (raw.length > MAX_SLOTS) return { error: `Offer at most ${MAX_SLOTS} times.` };
  const slots: string[] = [];
  for (const v of raw) {
    const s = parseSlot(v);
    if (!s) return { error: "Each time must be a date and time on the quarter hour." };
    const t = Date.parse(s);
    if (t <= now) return { error: "Times must be in the future." };
    if (t - now > MAX_AHEAD_MS) return { error: "Times can be at most a year ahead." };
    slots.push(s);
  }
  slots.sort();
  for (let i = 1; i < slots.length; i++) {
    if (Date.parse(slots[i]!) < Date.parse(slots[i - 1]!) + SLOT_MS) return { error: "Two of the times overlap. Each game takes 2 hours." };
  }
  return { slots };
}

/** The other coach's spelling and the fixture, re-checked: open, both coaches still hold its seats, not blocked. */
function checkPair(deps: ScheduleApiDeps, me: string, ref: string): { entry: FixtureEntry; opponent: string } | ScheduleApiResult {
  const entry = deps.fixtures.byRef(ref);
  if (!entry) return parseRef(ref) ? err(409, "This fixture is already played, closed or no longer active.") : err(404, "Fixture not found.");
  const seat = seatOf(entry, me);
  if (!seat) return err(403, "Only the two coaches of this fixture can agree its time.");
  const b = proposeBlocker(deps, me, seat);
  if (b.reason) return err(b.status ?? 403, b.reason);
  return { entry, opponent: b.opponent! };
}

function notify(deps: ScheduleApiDeps, to: string, input: NotificationInput): void {
  try { deps.notify?.(to, input); } catch { /* fire-and-forget */ }
}

const zoneOf = (deps: ScheduleApiDeps, coach: string): string => {
  const tz = deps.scheduling(coach)?.timezone;
  return validZone(tz) ? tz! : "UTC";
};

function propose(deps: ScheduleApiDeps, me: string, body: unknown, now: number): ScheduleApiResult {
  const input = obj(body);
  if (!input) return err(400, "A JSON object is required.");
  const ref = typeof input.fixture === "string" ? input.fixture : "";
  if (!parseRef(ref)) return err(400, "Name the fixture.");
  const pair = checkPair(deps, me, ref);
  if ("status" in pair) return pair;
  const read = readSlots(input.slots, now);
  if ("error" in read) return err(400, read.error);
  const clash = clashing(read.slots, [...busyOf(deps, me, ref), ...busyOf(deps, pair.opponent, ref)]);
  if (clash.length) return err(409, "One of the times clashes with a confirmed game of yours or your opponent's.", { conflicts: clash });
  const pending = deps.store.pendingFor(ref).filter((p) => !isExpired(p, now));
  const theirs = pending.find((p) => sameCoach(p.from, pair.opponent) && sameCoach(p.to, me));
  if (theirs) return err(409, `${pair.opponent} already proposed times for this fixture. Accept, counter or decline them.`, { proposal: theirs.id });
  if (!deps.limiter.take(me, now)) return err(429, "Too many proposals; try again later.");
  const at = new Date(now).toISOString();
  const created = deps.store.mutate((list, ctx) => {
    const id = ctx.newId();
    // The sender's own earlier pending times for this fixture are replaced by these.
    for (const p of list) if (p.fixture === ref && p.status === "pending" && sameCoach(p.from, me)) { p.status = "withdrawn"; p.answeredAt = at; p.replacedBy = id; }
    const record: ProposalRecord = { id, fixture: ref, from: me, to: pair.opponent, slots: read.slots, status: "pending", createdAt: at };
    list.push(record);
    return record;
  }, now);
  const label = `${fixtureTitle(pair.entry, seatOf(pair.entry, pair.opponent) ?? seatOf(pair.entry, me)!)} · ${pair.entry.competition}`;
  notify(deps, pair.opponent, {
    type: "proposal-received",
    title: `${me} proposed a time for your fixture`,
    subject: label,
    body: `${label}. ${read.slots.length === 1 ? "One time" : `${read.slots.length} times`} to choose from: ${read.slots.map((s) => formatIn(s, zoneOf(deps, pair.opponent))).join(", ")}.`,
    link: `/app/schedule?proposal=${created.id}`,
    from: me,
  });
  return { status: 201, body: { proposal: proposalView(created, me, now), warnings: slotWarnings(read.slots, deps.scheduling(pair.opponent)?.timezone, pair.entry.deadline) } };
}

function respond(deps: ScheduleApiDeps, me: string, body: unknown, now: number): ScheduleApiResult {
  const input = obj(body);
  if (!input) return err(400, "A JSON object is required.");
  const id = typeof input.proposalId === "string" ? input.proposalId : "";
  const action = input.action;
  if (action !== "accept" && action !== "counter" && action !== "decline" && action !== "withdraw") return err(400, "action must be accept, counter, decline or withdraw.");
  const p = PROPOSAL_ID.test(id) ? deps.store.get(id) : undefined;
  if (!p || !(sameCoach(p.from, me) || sameCoach(p.to, me))) return err(404, "Proposal not found.");
  if (p.status !== "pending") return err(409, "This proposal was already answered.");
  if (isExpired(p, now)) return err(409, "Every time in this proposal has passed. Propose new times.");
  const at = new Date(now).toISOString();

  if (action === "withdraw") {
    if (!sameCoach(p.from, me)) return err(403, "Only the coach who sent the times can withdraw them.");
    deps.store.mutate((list) => { const r = list.find((x) => x.id === p.id); if (r && r.status === "pending") { r.status = "withdrawn"; r.answeredAt = at; } }, now);
    return { status: 200, body: { proposal: proposalView({ ...p, status: "withdrawn", answeredAt: at }, me, now) } };
  }
  if (!sameCoach(p.to, me)) return err(403, `Only ${p.to} can answer these times.`);

  if (action === "decline") {
    // Declining is always possible (also between coaches who blocked each other since).
    deps.store.mutate((list) => { const r = list.find((x) => x.id === p.id); if (r && r.status === "pending") { r.status = "declined"; r.answeredAt = at; } }, now);
    return { status: 200, body: { proposal: proposalView({ ...p, status: "declined", answeredAt: at }, me, now) } };
  }

  const pair = checkPair(deps, me, p.fixture);
  if ("status" in pair) return pair;
  if (!sameCoach(pair.opponent, p.from)) return err(409, "The coaches of this fixture changed. Propose new times.");

  if (action === "accept") {
    const slot = parseSlot(input.slot);
    if (!slot || !p.slots.includes(slot)) return err(400, "Pick one of the proposed times.");
    if (Date.parse(slot) <= now) return err(409, "That time has passed. Pick another or counter.");
    const clash = clashing([slot], [...busyOf(deps, me, p.fixture), ...busyOf(deps, pair.opponent, p.fixture)]);
    if (clash.length) return err(409, "That time now clashes with a confirmed game of yours or your opponent's.", { conflicts: clash });
    const time: AgreedTime = { ...slotOf(slot), agreedAt: at };
    // The fixture first: the proposal is marked accepted only once the fixture carries the time.
    try { deps.fixtures.setTime(p.fixture, time); } catch (e) {
      if (e instanceof DeletionFenceError) throw e;
      return err(409, "This fixture is already played, closed or no longer active.");
    }
    deps.store.mutate((list) => {
      for (const r of list) {
        if (r.id === p.id) { r.status = "accepted"; r.answeredAt = at; r.acceptedSlot = slot; }
        else if (r.fixture === p.fixture && r.status === "pending") { r.status = "superseded"; r.answeredAt = at; r.replacedBy = p.id; }
      }
    }, now);
    const acceptedLabel = `${fixtureTitle(pair.entry, seatOf(pair.entry, p.from) ?? seatOf(pair.entry, me)!)} · ${pair.entry.competition}`;
    notify(deps, p.from, {
      type: "proposal-accepted",
      title: `${me} accepted a time for your fixture`,
      subject: acceptedLabel,
      body: `${acceptedLabel}: ${formatIn(slot, zoneOf(deps, p.from))}.`,
      link: `/app/schedule?proposal=${p.id}`,
      from: me,
    });
    return { status: 200, body: { proposal: proposalView({ ...p, status: "accepted", answeredAt: at, acceptedSlot: slot }, me, now), scheduled: time } };
  }

  // counter
  const read = readSlots(input.slots, now);
  if ("error" in read) return err(400, read.error);
  const clash = clashing(read.slots, [...busyOf(deps, me, p.fixture), ...busyOf(deps, pair.opponent, p.fixture)]);
  if (clash.length) return err(409, "One of the times clashes with a confirmed game of yours or your opponent's.", { conflicts: clash });
  if (!deps.limiter.take(me, now)) return err(429, "Too many proposals; try again later.");
  const created = deps.store.mutate((list, ctx) => {
    const nid = ctx.newId();
    const r = list.find((x) => x.id === p.id);
    if (r) { r.status = "countered"; r.answeredAt = at; r.replacedBy = nid; }
    const record: ProposalRecord = { id: nid, fixture: p.fixture, from: me, to: pair.opponent, slots: read.slots, status: "pending", createdAt: at, counterOf: p.id };
    list.push(record);
    return record;
  }, now);
  const counterLabel = `${fixtureTitle(pair.entry, seatOf(pair.entry, pair.opponent) ?? seatOf(pair.entry, me)!)} · ${pair.entry.competition}`;
  notify(deps, pair.opponent, {
    type: "proposal-countered",
    title: `${me} suggested other times for your fixture`,
    subject: counterLabel,
    body: `${counterLabel}: ${read.slots.map((s) => formatIn(s, zoneOf(deps, pair.opponent))).join(", ")}.`,
    link: `/app/schedule?proposal=${created.id}`,
    from: me,
  });
  return { status: 201, body: { proposal: proposalView(created, me, now), warnings: slotWarnings(read.slots, deps.scheduling(pair.opponent)?.timezone, pair.entry.deadline) } };
}

export function scheduleApi(
  method: string,
  path: string,
  auth: ScheduleAuth | undefined,
  body: unknown,
  deps: ScheduleApiDeps,
): ScheduleApiResult | undefined {
  if (!isScheduleApiPath(path)) return undefined;
  if (!auth) return err(401, "Authentication required.");
  const read = path === "/api/schedule/mine" || path === "/api/schedule/pending";
  if (read ? method !== "GET" && method !== "HEAD" : method !== "POST") return err(405, read ? "Use GET." : "Use POST.");
  const me = deps.coach(auth.coach) ?? auth.coach.trim();
  const now = deps.now?.() ?? Date.now();
  try {
    if (path === "/api/schedule/mine") return { status: 200, body: mine(deps, me, now) };
    if (path === "/api/schedule/pending") return { status: 200, body: { pending: pendingCount(deps, me, now) } };
    if (auth.test) return err(403, "Test sign-in sessions cannot propose or answer game times.");
    if (deps.isFenced(me)) throw new DeletionFenceError();
    return path === "/api/schedule/propose" ? propose(deps, me, body, now) : respond(deps, me, body, now);
  } catch (e) {
    if (e instanceof ScheduleStoreError) return err(e.status, e.message);
    if (e instanceof DeletionFenceError) return err(e.status, e.message);
    throw e;
  }
}
