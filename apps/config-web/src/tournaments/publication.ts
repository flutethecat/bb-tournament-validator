// Tournament publication and registration settings (registration spec 2026-11-02 §2, §6, Q3, Q13; lane L3).
//
// Visibility: a draft the creation wizard saved unpublished (`unpublished: true`) is seen only by its managers (owner,
// organisers) and site admins. Every read path asks canSeeTournament; the by-id routes under /api/tournaments/:id are
// gated once by hiddenTournamentPath (server.ts and tournamentApi both call it). A record without the marker is
// published: every record written before this release, so "existing drafts count as published" (Q3) needs no migration
// and no date cut-off.
//
// Registration: an unpublished draft takes no entries from anyone (store.registerEntrant), so a hidden draft never holds
// a coach's entry, and unpublishing is refused while one exists. A tournament with registration settings also refuses
// self-entries outside its window (src/registration windowStatus); organisers may still add coaches (spec §7).
//
// Test sign-in sessions (Q13): they may create tournaments (marked test) and write only in tournaments marked test.

import { resolveRegistrationWindow, windowStatus, type CompetitionSnapshot, type RegistrationWindow, type WindowStatus } from "../registration/index.js";
import { isTournamentManager, TournamentStoreError, type TournamentStore } from "./store.js";
import { registrationGateShut } from "./registrationGate.js";
import type { TournamentDataFileV4, TournamentRecord, TournamentRegistrationSettings } from "./types.js";

export interface TournamentViewer { coach: string; admin?: boolean }

/** Published = public. Only a draft saved (or put back) unpublished is hidden. */
export function isTournamentPublished(t: Pick<TournamentRecord, "unpublished">): boolean {
  return t.unpublished !== true;
}

/** Everyone sees a published tournament; an unpublished draft only its managers and admins. */
export function canSeeTournament(t: TournamentRecord, viewer: TournamentViewer | undefined): boolean {
  if (isTournamentPublished(t)) return true;
  return Boolean(viewer && (viewer.admin === true || isTournamentManager(t, viewer.coach)));
}

const TOURNAMENT_PATH = /^\/api\/(?:fork\/)?tournaments\/([^/?#]+)(?:\/|$)/;

/** The tournament id of a /api/tournaments/:id(/...) path (either spelling), or undefined. */
export function tournamentIdFromPath(path: string): string | undefined {
  const m = TOURNAMENT_PATH.exec(path);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]!); } catch { return undefined; }
}

/** True when the path names a tournament this viewer may not see (answer 404 as if it did not exist), for every method. */
export function hiddenTournamentPath(store: Pick<TournamentStore, "tournament">, path: string, viewer: TournamentViewer | undefined): boolean {
  const id = tournamentIdFromPath(path);
  if (id === undefined) return false;
  const t = store.tournament(id);
  return Boolean(t && !canSeeTournament(t, viewer));
}

/** The snapshot as `viewer` may see it: hidden drafts (and their entrants, rounds, fixtures) removed, and series lists
 *  without them. Used by the series routes. */
export function visibleTournamentData(data: TournamentDataFileV4, viewer: TournamentViewer | undefined): TournamentDataFileV4 {
  const hidden = new Set(Object.values(data.tournaments).filter((t) => !canSeeTournament(t, viewer)).map((t) => t.id));
  if (!hidden.size) return data;
  const keep = <T extends { tournamentId: string }>(rows: Record<string, T>) =>
    Object.fromEntries(Object.entries(rows).filter(([, row]) => !hidden.has(row.tournamentId)));
  return {
    ...data,
    tournaments: Object.fromEntries(Object.entries(data.tournaments).filter(([id]) => !hidden.has(id))),
    entrants: keep(data.entrants),
    rounds: keep(data.rounds),
    scheduledMatches: keep(data.scheduledMatches),
    standings: keep(data.standings),
    ...(data.series ? {
      series: Object.fromEntries(Object.entries(data.series).map(([id, s]) => [id, { ...s, tournaments: s.tournaments.filter((t) => !hidden.has(t)) }])),
    } : {}),
  };
}

// ---- registration settings ----------------------------------------------------------------------------------------------

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const bad = (message: string): never => { throw new TournamentStoreError(400, message); };

function isoField(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))) return bad(`${field} must be an ISO-8601 timestamp.`);
  return value;
}

function boolField(value: unknown, field: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") return bad(`${field} must be true or false.`);
  return value;
}

/** Organiser approval of entries (lane L4: the Registrations panel in Manage decides pending entries). */
export const ORGANISER_APPROVAL_AVAILABLE = true;
export const ORGANISER_APPROVAL_REFUSAL = "Organiser approval is coming with registration approvals. Use automatic acceptance for now.";

/** The defaults the owner accepted (11-02): auto-accept (Q5), waitlist on (Q6), roster later on (Q4), self check-in on (Q11). */
export function defaultTournamentRegistration(): TournamentRegistrationSettings {
  return { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } };
}

/** A tournament written before registration settings existed (spec §8.1: absent = today's behaviour): every entry is
 *  accepted while there is room, "Tournament is full." when there is none, a team at registration, no self check-in.
 *  Saving registration settings in Manage replaces it. */
export const LEGACY_REGISTRATION: TournamentRegistrationSettings = Object.freeze({ approval: "auto", waitlist: false, rosterLater: false, checkIn: Object.freeze({ self: false }) }) as TournamentRegistrationSettings;

/** A request's `registration` object (absent fields take the defaults). Throws 400 on a bad value. */
export function parseRegistrationSettings(value: unknown): TournamentRegistrationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("registration must be an object.");
  const raw = value as Record<string, unknown>;
  const base = defaultTournamentRegistration();
  if (raw.approval !== undefined && raw.approval !== "auto" && raw.approval !== "organiser") bad("registration.approval must be auto or organiser.");
  // Kept as a switch: with ORGANISER_APPROVAL_AVAILABLE off no tournament could promise an approval step.
  if (raw.approval === "organiser" && !ORGANISER_APPROVAL_AVAILABLE) bad(ORGANISER_APPROVAL_REFUSAL);
  const checkInRaw = raw.checkIn === undefined || raw.checkIn === null ? {} : raw.checkIn;
  if (typeof checkInRaw !== "object" || Array.isArray(checkInRaw)) bad("registration.checkIn must be an object.");
  const checkIn = checkInRaw as Record<string, unknown>;
  const opensAt = isoField(raw.opensAt, "registration.opensAt");
  const rosterLater = boolField(raw.rosterLater, "registration.rosterLater", base.rosterLater);
  const rosterBy = isoField(raw.rosterBy, "registration.rosterBy");
  const checkInOpens = isoField(checkIn.opensAt, "registration.checkIn.opensAt");
  return {
    ...(opensAt ? { opensAt } : {}),
    approval: (raw.approval as TournamentRegistrationSettings["approval"] | undefined) ?? base.approval,
    waitlist: boolField(raw.waitlist, "registration.waitlist", base.waitlist),
    rosterLater,
    ...(rosterLater && rosterBy ? { rosterBy } : {}),
    checkIn: { self: boolField(checkIn.self, "registration.checkIn.self", base.checkIn.self), ...(checkInOpens ? { opensAt: checkInOpens } : {}) },
  };
}

/** Window order checks against the tournament's deadlines (the close values live there). Throws 400. */
export function assertRegistrationOrder(registration: TournamentRegistrationSettings | undefined, deadlines: TournamentRecord["deadlines"], startsAt?: string): void {
  const t = (iso: string | undefined) => (iso ? Date.parse(iso) : undefined);
  const opens = t(registration?.opensAt);
  const closes = t(deadlines?.registration);
  if (opens !== undefined && closes !== undefined && opens >= closes) bad("Registration must open before it closes.");
  const ciOpens = t(registration?.checkIn.opensAt);
  const ciCloses = t(deadlines?.checkIn);
  if (ciOpens !== undefined && ciCloses !== undefined && ciOpens >= ciCloses) bad("Check-in must open before it closes.");
  const start = t(startsAt);
  if (closes !== undefined && start !== undefined && closes > start) bad("Registration must close by the start.");
  // A blank close means the start (tournamentRegistrationWindow): validate against that effective close too.
  if (closes === undefined && opens !== undefined && start !== undefined && opens >= start) bad("Registration must open before the tournament starts.");
  if (ciCloses === undefined && ciOpens !== undefined && start !== undefined && ciOpens >= start) bad("Check-in must open before the tournament starts.");
}

/** The tournament's registration window in the core's shape (close values from deadlines, cap from maxPlayers). */
export function tournamentRegistrationWindow(t: TournamentRecord): RegistrationWindow {
  const r = t.registration ?? LEGACY_REGISTRATION;
  // A blank close means "until the start" (what the wizard promises): no self-entry once the tournament has started.
  // A record written before registration settings existed closes only at its own registration deadline (lane L4
  // enforces deadlines.registration; the start-date fallback is for tournaments that chose a window).
  const closesAt = t.deadlines?.registration ?? (t.registration ? t.startsAt : undefined);
  const checkInCloses = t.deadlines?.checkIn;
  return resolveRegistrationWindow("tournament", {
    ...(r.opensAt ? { opensAt: r.opensAt } : {}),
    ...(closesAt ? { closesAt } : {}),
    approval: r.approval,
    waitlist: r.waitlist,
    rosterLater: r.rosterLater,
    ...(r.rosterBy ? { rosterBy: r.rosterBy } : {}),
    checkIn: { self: r.checkIn.self, ...(r.checkIn.opensAt ? { opensAt: r.checkIn.opensAt } : {}), ...(checkInCloses ? { closesAt: checkInCloses } : {}) },
  }, t.maxPlayers > 0 ? t.maxPlayers : null);
}

/** The core's view of a tournament (registration window checks). */
export function tournamentCompetition(t: TournamentRecord, round1: boolean): CompetitionSnapshot {
  const managers = [t.ownerCoachId ?? t.organizerCoachId, ...(t.organizerCoachIds ?? [])].filter((c): c is string => typeof c === "string" && c !== "");
  // The Registration gate while its stored state is shut (the core compares the time with `now`; an unreadable gate fails
  // closed with no time). Epoch 0 = "now" for the read: only the stored state decides whether the snapshot carries it.
  const shut = registrationGateShut(t, new Date(0));
  return {
    kind: "tournament",
    id: t.id,
    name: t.name,
    published: isTournamentPublished(t),
    finished: t.status === "completed" || t.status === "cancelled",
    started: round1,
    locked: Boolean(t.rostersLockedAt),
    test: t.test === true,
    window: tournamentRegistrationWindow(t),
    managers,
    ...(shut ? { gate: { ...(shut.opensAt ? { opensAt: shut.opensAt } : {}), message: shut.message } } : {}),
    ...(t.startsAt ? { startAt: t.startsAt } : {}),
  };
}

/** May a coach enter themselves now? Unpublished drafts never; otherwise inside the window (lane L4: a record without
 *  registration settings has no opening time and closes at deadlines.registration, plus the status / round 1 / lock
 *  checks it always had). */
export function selfRegistrationStatus(t: TournamentRecord, round1: boolean, now: Date): WindowStatus {
  if (!isTournamentPublished(t)) return { open: false, reason: "unpublished", message: "Registration is not open yet." };
  return windowStatus(tournamentCompetition(t, round1), now);
}

// ---- test sign-in sessions (Q13) ------------------------------------------------------------------------------------------

export const TEST_SESSION_TOURNAMENT_REFUSAL = "Test sign-in sessions can only change test tournaments.";

/**
 * A write from a test sign-in session under /api/tournaments or /api/scheduled-matches: undefined = allowed (creating a
 * tournament, which is then marked test, or writing in a tournament marked test), else the refusal text (403).
 */
export function testSessionTournamentRefusal(store: Pick<TournamentStore, "tournament" | "match">, method: string, path: string): string | undefined {
  const p = path.replace(/^\/api\/fork\/tournaments(?=\/|$)/, "/api/tournaments");
  if (p === "/api/tournaments") return method === "POST" ? undefined : TEST_SESSION_TOURNAMENT_REFUSAL;
  const id = tournamentIdFromPath(p);
  if (id !== undefined) return store.tournament(id)?.test === true ? undefined : TEST_SESSION_TOURNAMENT_REFUSAL;
  const m = /^\/api\/scheduled-matches\/([^/?#]+)/.exec(p);
  if (m) {
    let matchId: string;
    try { matchId = decodeURIComponent(m[1]!); } catch { return TEST_SESSION_TOURNAMENT_REFUSAL; }
    const match = store.match(matchId);
    return match && store.tournament(match.tournamentId)?.test === true ? undefined : TEST_SESSION_TOURNAMENT_REFUSAL;
  }
  return TEST_SESSION_TOURNAMENT_REFUSAL;
}
