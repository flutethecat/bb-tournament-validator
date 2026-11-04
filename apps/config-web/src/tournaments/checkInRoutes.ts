/**
 * QR check-in routes (spec-grill-round2-leftovers 11-03 "Round 2 answers" 5; tokens in ./checkInQr.ts). The check-in rules
 * and window are the registration lane's (isCheckInOpen over tournamentCompetition, the same as POST /check-in).
 *
 *   POST /api/tournaments/:id/check-in/qr               signed in: { token, confirm? }. Without confirm it only says what the
 *                                                       code would do (nothing is written); with confirm: true it checks in.
 *   POST /api/tournaments/:id/check-in/code             the coach: a new personal code (the old one stops working)
 *   GET  /api/tournaments/:id/check-in/venue            managers: the venue code (its path) and whether it is on
 *   PUT  /api/tournaments/:id/check-in/venue            managers: { revision, enabled } (switch it on / off)
 *   POST /api/tournaments/:id/check-in/venue/rotate     managers: { revision } (a new code; the old one stops working)
 *
 * GETs never write (laws 14b): the scan opens a page whose button POSTs the token in the body. The token is never in an API
 * path or query, never logged, never echoed back. Who may use a code:
 *  - personal: the coach it belongs to, or the tournament's organisers / an admin (an organiser scanning the coach's QR).
 *    The coach's own scan is self check-in, so it needs self check-in on; an organiser's never does.
 *  - venue: any signed-in coach in the field, for their own entry only (the organisers chose to show it).
 * Everyone else, outside the window, or with a dead code: a clear refusal, and nobody is checked in.
 */
import type { TournamentStore } from "./store.js";
import { isTournamentManager } from "./store.js";
import { tournamentCompetition } from "./publication.js";
import { isCheckInOpen } from "../registration/index.js";
import { checkInView } from "./registration.js";
import { checkInPath, issuePersonal, issueVenue, matchesPersonal, matchesVenue, parseToken, personalToken, venueToken, type ParsedToken } from "./checkInQr.js";
import type { TournamentEntrantRecord, TournamentRecord } from "./types.js";

export interface CheckInRouteDeps {
  store: TournamentStore;
  /** The host key the codes are signed with (server: checkin.key next to the tournament data). Absent = QR check-in off. */
  checkInKey?: string;
  ifMatch?: string;
}

interface Who { coach: string; admin: boolean }
type Result = { status: number; body: unknown; headers?: Record<string, string> };
const NO_STORE = { "cache-control": "private, no-store" };
const res = (status: number, body: unknown): Result => ({ status, body, headers: { ...NO_STORE } });
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Result => res(status, { error, code, ...extra });

const ROUTE = /^\/api\/tournaments\/([^/]+)\/check-in\/(qr|code|venue|venue\/rotate)$/;
const ckey = (c: string): string => c.trim().toLowerCase();
const manages = (t: TournamentRecord, who: Who): boolean => who.admin || isTournamentManager(t, who.coach);

export const DEAD_CODE = "This check-in code doesn't work any more. Ask for a new one.";

/** The tournament's field entry of a coach (accepted, not withdrawn), if any. */
function fieldEntry(store: TournamentStore, tournamentId: string, coach: string): TournamentEntrantRecord | undefined {
  return store.entrants(tournamentId).find((e) => e.droppedAt === undefined && ckey(e.coach.ffbCoachId) === ckey(coach));
}

function revisionOf(input: Record<string, unknown>, ifMatch: string | undefined): number | "missing" | "bad" {
  const raw = input.revision ?? (ifMatch !== undefined ? Number(ifMatch.replace(/"/g, "")) : undefined);
  if (raw === undefined || raw === null) return "missing";
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : "bad";
}

/** The managers' view of the venue code. */
function venueView(store: TournamentStore, key: string, t: TournamentRecord, now: Date) {
  const v = t.venueCheckIn;
  const round1 = store.rounds(t.id).some((r) => r.number === 1);
  const on = Boolean(v?.enabled && v.nonce);
  return {
    enabled: on,
    revision: v?.revision ?? 0,
    ...(on ? { path: checkInPath(t.id, venueToken(key, t.id, v!.nonce!)) } : {}),
    ...(v?.updatedAt ? { updatedAt: v.updatedAt } : {}),
    checkIn: checkInView(t, round1, now) ?? null,
  };
}

export async function checkInRoutes(method: string, path: string, auth: Who | undefined, body: unknown, deps: CheckInRouteDeps, now: Date): Promise<Result | undefined> {
  const m = ROUTE.exec(path);
  if (!m) return undefined;
  let id: string;
  try { id = decodeURIComponent(m[1]!); } catch { return fail(400, "bad-request", "Invalid tournament id."); }
  const route = m[2]!;
  const key = deps.checkInKey;
  if (!key) return fail(503, "unavailable", "QR check-in isn't available on this host.");
  const read = method === "GET" || method === "HEAD";
  if (route === "venue" ? !(read || method === "PUT") : method !== "POST") return fail(405, "method", route === "venue" ? "Use GET or PUT." : "Use POST.");
  if (!auth) return fail(401, "sign-in", "Sign in to check in.");
  const tournament = deps.store.tournament(id);
  if (!tournament) return fail(404, "not-found", "Tournament not found.");
  const input = !read && body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};

  if (route === "qr") return scan(deps, key, tournament, auth, input, now);

  if (route === "code") {
    const mine = fieldEntry(deps.store, id, auth.coach);
    if (!mine) return fail(403, "not-entered", "Only coaches in the field have a check-in code.");
    if (mine.flags?.checkedIn) return fail(409, "already", "You're already checked in.");
    if (tournament.status === "completed" || tournament.status === "cancelled") return fail(409, "finished", `${tournament.name} is finished.`);
    deps.store.issueCheckInCodes((tid, eid) => issuePersonal(key, tid, eid, now), { tournamentId: id, entrantId: mine.id, replace: true });
    return res(200, { reissued: true });
  }

  // ---- venue code (managers) ----
  if (!manages(tournament, auth)) return fail(403, "not-organiser", "You are not this tournament's organizer.");
  if (read) return res(200, venueView(deps.store, key, tournament, now));
  if (tournament.status === "completed" || tournament.status === "cancelled") return fail(409, "finished", `${tournament.name} is finished.`);
  const asked = revisionOf(input, deps.ifMatch);
  if (asked === "bad") return fail(400, "bad-request", "revision must be a whole number.");
  const rotate = route === "venue/rotate";
  if (!rotate && typeof input.enabled !== "boolean") return fail(400, "bad-request", "enabled must be true or false.");
  const outcome = deps.store.updateTournamentRecord(id, (t): Result | undefined => {
    const base = t.venueCheckIn?.revision ?? 0;
    if (asked === "missing") return fail(428, "revision", "Name the venue code's revision. Reload and try again.", { revision: base });
    if (asked !== base) return fail(409, "stale", "Someone changed the venue code since you opened it. Reload to see the latest.", { revision: base });
    const at = now.toISOString();
    const on = rotate ? true : input.enabled === true;
    if (rotate && !t.venueCheckIn?.enabled) return fail(409, "off", "The venue code is off. Switch it on first.");
    if (!rotate && on && t.venueCheckIn?.enabled && t.venueCheckIn.nonce) return undefined; // already on: nothing changes
    t.venueCheckIn = on
      ? { enabled: true, ...issueVenue(key, t.id), revision: base + 1, updatedAt: at, by: auth.coach }
      : { enabled: false, revision: base + 1, updatedAt: at, by: auth.coach };
    return undefined;
  }, now);
  if (outcome) return outcome;
  return res(200, venueView(deps.store, key, deps.store.tournament(id)!, now));
}

/** POST /check-in/qr: what the code does (preview) or the check-in itself (confirm: true). */
function scan(deps: CheckInRouteDeps, key: string, t: TournamentRecord, auth: Who, input: Record<string, unknown>, now: Date): Result {
  const token = parseToken(input.token);
  if (!token) return fail(404, "invalid", DEAD_CODE);
  const round1 = deps.store.rounds(t.id).some((r) => r.number === 1);
  const window = () => checkInView(t, round1, now) ?? null;
  const resolved = token.kind === "personal" ? personalEntry(deps.store, key, t, token) : venueEntry(deps.store, key, t, token, auth);
  if ("refuse" in resolved) return resolved.refuse;
  const entrant = resolved.entrant;
  const organiser = manages(t, auth);
  const own = ckey(entrant.coach.ffbCoachId) === ckey(auth.coach);
  // A personal code: its coach or the organisers (an admin too). Everyone else learns nothing about whose it is.
  if (token.kind === "personal" && !own && !organiser) return fail(403, "not-yours", "This check-in code belongs to another coach. Only that coach or the tournament's organisers can use it.");
  const about = {
    kind: token.kind, tournament: { id: t.id, name: t.name },
    entry: { coach: entrant.coach.ffbCoachId, ...(entrant.submission?.teamName ? { team: entrant.submission.teamName } : {}) },
    checkIn: window(),
  };
  if (entrant.flags?.checkedIn || (token.kind === "personal" && entrant.checkInQr?.usedAt)) return res(200, { state: "already", ...about });
  const competition = tournamentCompetition(t, round1);
  if (!isCheckInOpen(competition, now)) return fail(409, "check-in-closed", "Check-in is not open.", { checkIn: window() });
  // The coach scanning their own personal code is self check-in: the organisers may have kept check-in to themselves.
  if (token.kind === "personal" && own && !organiser && competition.window.checkIn?.self === false)
    return fail(409, "organiser-check-in", "The organisers check coaches in for this tournament. Show them this code.");
  if (input.confirm !== true) return res(200, { state: "ready", ...about });
  const via = token.kind === "personal" ? "personal-qr" as const : "venue-qr" as const;
  const done = deps.store.checkInByQr(t.id, entrant.id, auth.coach, via, (tt, e) => (token.kind === "personal" ? matchesPersonal(key, tt.id, e.id, e.checkInQr, token) : matchesVenue(key, tt.id, tt.venueCheckIn, token)), now);
  if (done === "invalid") return fail(404, "invalid", DEAD_CODE);
  return res(200, { state: done, ...about });
}

function personalEntry(store: TournamentStore, key: string, t: TournamentRecord, token: ParsedToken): { entrant: TournamentEntrantRecord } | { refuse: Result } {
  const entrant = store.entrants(t.id).find((e) => e.droppedAt === undefined && matchesPersonal(key, t.id, e.id, e.checkInQr, token));
  return entrant ? { entrant } : { refuse: fail(404, "invalid", DEAD_CODE) };
}

function venueEntry(store: TournamentStore, key: string, t: TournamentRecord, token: ParsedToken, auth: Who): { entrant: TournamentEntrantRecord } | { refuse: Result } {
  if (!matchesVenue(key, t.id, t.venueCheckIn, token)) return { refuse: fail(404, "invalid", "This venue code doesn't work any more. Scan the one on show now.") };
  const mine = fieldEntry(store, t.id, auth.coach);
  if (!mine) return { refuse: fail(403, "not-entered", `You're not in the field of ${t.name}, so there's nothing to check in. Sign in as the coach who entered.`) };
  return { entrant: mine };
}

/** The coach's own check-in code path for their registration panel (a read: the code was issued by a write earlier). The
 *  token is recomputed from the stored nonce under the key; the stored hash is only ever compared. */
export function myCheckInCode(key: string | undefined, t: TournamentRecord, entrant: TournamentEntrantRecord | undefined): { path: string } | undefined {
  if (!key || !entrant || entrant.droppedAt !== undefined || entrant.flags?.checkedIn || !entrant.checkInQr || entrant.checkInQr.usedAt) return undefined;
  if (t.status === "completed" || t.status === "cancelled") return undefined;
  return { path: checkInPath(t.id, personalToken(key, t.id, entrant.id, entrant.checkInQr.nonce)) };
}
