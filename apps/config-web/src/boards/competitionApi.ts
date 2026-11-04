// League and tournament message boards with organiser moderation (owner 11-04, round 2 Q4), on the club Board's store
// (src/boards/board.ts, scopes "league:<id>" / "tournament:<id>"). Pure apart from the stores it is handed: server.ts
// passes the session identity and the parsed body.
//
//   B = /api/leagues/:id/board  or  /api/tournaments/:id/board
//   GET    B/status                         anyone: { enabled, publicRead, canRead, canModerate } (the tab's visibility)
//   GET    B                                readers: the threads (public when the organisers turned public read on)
//   POST   B {title, text}                  members and organisers: start a thread
//   POST   B/seen                           readers who are signed in: opened the board
//   POST   B/:postId/replies {text}         members and organisers (not in a locked or hidden thread, unless moderating)
//   PATCH  B/:postId {text, title?}         the author
//   DELETE B/:postId {reason?}              the author, or a moderator (soft delete: "Removed by an organiser")
//   POST   B/:postId/hide {hidden, reason?} moderators          POST B/:postId/pin  {pinned, reason?}  moderators
//   POST   B/:postId/lock {locked, reason?} moderators (threads only)
//   POST   B/:postId/report {reason}        members and organisers (one open report per coach per post)
//   GET    B/reports                        moderators: the Reports queue (open first)
//   POST   B/reports/:reportId/resolve {outcome: "dismissed"|"actioned", reason?}   moderators
//   GET    B/mutes                          moderators: running mutes
//   POST   B/mutes {coach, duration: "1h"|"24h"|"7d"|"custom", until?, reason?}     moderators
//   DELETE B/mutes/:coach {reason?}         moderators: lift a mute
//   GET    B/log                            moderators: the moderation log, newest first
//   PATCH  B/settings {revision, enabled?, publicRead?}                             moderators (428 missing, 409 stale)
//
// Readers: league members (a team in any season or ladder: src/boards/members.ts), tournament registered coaches, the
// organisers and site admins; anyone when public read is on. Moderators: the organisers (league owner + organisers,
// tournament owner + organisers) and site admins. A draft league / unpublished tournament answers 404 to everyone else.
// The board is ON by default; OFF hides it from coaches (403 board-off), refuses posts and reports, and keeps the posts.
// Every write: signed in, not a test session, an active account, not being deleted, rate limited (posts as clubs do);
// CSRF and the onboarding gate run in front (server.ts). GETs never change state. No board post goes to Discord (clubs
// have no board Discord event, so there is nothing to mirror).

import { leagueVisibleTo, managesLeague, draftAwareNotify } from "../leagues/lifecycle.js";
import type { LeagueRecord, SeasonRecord } from "../leagues/types.js";
import type { NotificationInput } from "../notifications.js";
import { SenderRateLimiter } from "../notifications.js";
import { canSeeTournament } from "../tournaments/publication.js";
import { isTournamentManager } from "../tournaments/store.js";
import type { TournamentEntrantRecord, TournamentRecord } from "../tournaments/types.js";
import {
  activeMute, BoardError, boardCoachKey, boardSettings, boardView, parseBoardReason, parseBoardText, parseBoardTitle,
  type BoardFile, type BoardPolicy, type BoardStore,
} from "./board.js";
import { isLeagueBoardMember, isTournamentBoardMember } from "./members.js";

export type CompetitionKind = "league" | "tournament";
export interface BoardAuth { coach: string; admin?: boolean; test?: boolean }

export interface CompetitionBoardLimiters { posts: SenderRateLimiter; writes: SenderRateLimiter }
/** The club board's limits (src/clubs/api.ts createClubsLimiters): 20 posts per 10 minutes, 60 other writes an hour. */
export const createCompetitionBoardLimiters = (): CompetitionBoardLimiters => ({
  posts: new SenderRateLimiter(20, 10 * 60_000),
  writes: new SenderRateLimiter(60, 60 * 60_000),
});

export interface CompetitionBoardDeps {
  boards: BoardStore;
  leagues: { league(id: string): LeagueRecord | undefined; competitions(id: string): SeasonRecord[]; version(): number };
  tournaments: { tournament(id: string): TournamentRecord | undefined; entrants(id: string): TournamentEntrantRecord[] };
  /** The coach's identity spelling when an active (not banned) account exists, else undefined. */
  coach(name: string): string | undefined;
  isFenced(coach: string): boolean;
  isAdmin(coach: string): boolean;
  notify?(coach: string, input: NotificationInput): void;
  limiters: CompetitionBoardLimiters;
  now?(): Date;
}

export interface CompetitionBoardResult { status: number; body?: unknown; headers?: Record<string, string> }

const BOARD_PATH = /^\/api\/(leagues|tournaments)\/([^/]+)\/board(?:\/(.*))?$/;

/** The board a path names: kind, competition id and the segments after /board. */
export function competitionBoardPath(path: string): { kind: CompetitionKind; id: string; rest: string[] } | undefined {
  const m = BOARD_PATH.exec(path);
  if (!m) return undefined;
  let id: string;
  try { id = decodeURIComponent(m[2]!); } catch { return undefined; }
  const rest = m[3] === undefined ? [] : m[3].split("/");
  const parts: string[] = [];
  for (const r of rest) { try { parts.push(decodeURIComponent(r)); } catch { return undefined; } }
  return { kind: m[1] === "leagues" ? "league" : "tournament", id, rest: parts };
}

/** Reads a signed-out visitor may make (the handler still decides: public read must be on, the competition visible). */
export function isPublicCompetitionBoardRead(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const p = competitionBoardPath(path);
  return Boolean(p && (p.rest.length === 0 || (p.rest.length === 1 && p.rest[0] === "status")));
}

const NO_STORE = { "cache-control": "private, no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): CompetitionBoardResult => ({ status, body: { error, ...extra }, headers: NO_STORE });
const ok = (body: unknown, status = 200): CompetitionBoardResult => ({ status, body, headers: NO_STORE });
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isResult = (v: unknown): v is CompetitionBoardResult => isObj(v) && typeof v.status === "number";
const k = boardCoachKey;

export const MUTE_DURATIONS: Readonly<Record<string, number>> = { "1h": 60 * 60_000, "24h": 24 * 60 * 60_000, "7d": 7 * 24 * 60 * 60_000 };

/** One competition as the board sees it. */
interface Competition {
  kind: CompetitionKind;
  id: string;
  name: string;
  scope: string;
  link: string;
  organisers: string[];
  isMember(coach: string): boolean;
  isOrganiser(coach: string): boolean;
  notify(coach: string, input: NotificationInput): void;
}

function competition(kind: CompetitionKind, id: string, viewer: BoardAuth | undefined, deps: CompetitionBoardDeps): Competition | undefined {
  const tell = (coach: string, input: NotificationInput): void => { try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ } };
  if (kind === "league") {
    const league = deps.leagues.league(id);
    if (!league || !leagueVisibleTo(league, viewer)) return undefined;
    const organisers = [...new Set([...(league.owner ? [league.owner] : []), ...league.organisers].map((c) => c.trim()).filter(Boolean))];
    const notify = draftAwareNotify(deps.leagues, league.id, tell, (c) => deps.isAdmin(c));
    return {
      kind, id: league.id, name: league.name, scope: `league:${league.id}`, link: `/app/leagues/${encodeURIComponent(league.id)}?tab=board`, organisers,
      isMember: (c) => isLeagueBoardMember(deps.leagues, league.id, c),
      isOrganiser: (c) => managesLeague(league, { coach: c }),
      notify,
    };
  }
  const t = deps.tournaments.tournament(id);
  if (!t || !canSeeTournament(t, viewer)) return undefined;
  const organisers = [...new Set([t.ownerCoachId ?? t.organizerCoachId ?? "", ...(t.organizerCoachIds ?? [])].map((c) => c.trim()).filter(Boolean))];
  return {
    kind, id: t.id, name: t.name, scope: `tournament:${t.id}`, link: `/app/tournaments/${encodeURIComponent(t.id)}?tab=board`, organisers,
    isMember: (c) => isTournamentBoardMember(deps.tournaments.entrants(t.id), c),
    isOrganiser: (c) => isTournamentManager(t, c),
    // An unpublished tournament: only its managers are ever told (and only managers get report notes).
    notify: (coach, input) => { if (t.unpublished === true && !isTournamentManager(t, coach) && !deps.isAdmin(coach)) return; tell(coach, input); },
  };
}

/** The board's rules for one viewer. */
function policyFor(c: Competition, file: BoardFile, admin: (coach: string) => boolean): BoardPolicy {
  const settings = boardSettings(file);
  const moderator = (v: string) => Boolean(v) && (c.isOrganiser(v) || admin(v));
  const insider = (v: string) => Boolean(v) && (moderator(v) || c.isMember(v));
  return {
    // Off: only the moderators (to switch it back on). On: insiders, and anyone when public read is on.
    canRead: (v) => (settings.enabled ? Boolean(v && insider(v)) || settings.publicRead : Boolean(v && moderator(v))),
    canPost: (v) => settings.enabled && insider(v),
    canModerate: (v) => moderator(v),
    canReport: (v) => settings.enabled && insider(v) && !moderator(v),
  };
}

export async function competitionBoardApi(method: string, path: string, auth: BoardAuth | undefined, body: unknown, deps: CompetitionBoardDeps): Promise<CompetitionBoardResult | undefined> {
  const p = competitionBoardPath(path);
  if (!p) return undefined;
  try {
    return route(method, p.kind, p.id, p.rest, auth, isObj(body) ? body : {}, deps);
  } catch (e) {
    if (e instanceof BoardError) return fail(e.status, e.message, e.code ? { code: e.code } : {});
    throw e;
  }
}

/** The acting coach for a write: signed in, not a test session, an active account, not being deleted, under the rate limit. */
function writer(auth: BoardAuth | undefined, deps: CompetitionBoardDeps, limiter: SenderRateLimiter): { coach: string; admin: boolean } | CompetitionBoardResult {
  if (!auth) return fail(401, "Sign in first.");
  if (auth.test) return fail(403, "Test sign-in sessions cannot post on boards.");
  if (deps.isFenced(auth.coach)) return fail(410, "This account is being deleted.");
  const coach = deps.coach(auth.coach);
  if (!coach) return fail(403, "Your account can't do that.");
  if (!limiter.take(coach)) return fail(429, "Too many changes. Try again later.", { code: "rate" });
  return { coach, admin: auth.admin === true };
}

function route(method: string, kind: CompetitionKind, id: string, rest: string[], auth: BoardAuth | undefined, input: Obj, deps: CompetitionBoardDeps): CompetitionBoardResult {
  const read = method === "GET" || method === "HEAD";
  const c = competition(kind, id, auth, deps);
  if (!c) return fail(404, kind === "league" ? "League not found." : "Tournament not found.");
  const now = deps.now?.() ?? new Date();
  const isAdmin = (coach: string) => Boolean(coach) && ((auth && k(auth.coach) === k(coach) && auth.admin === true) || deps.isAdmin(coach));
  const file = deps.boards.read(c.scope);
  const policy = policyFor(c, file, isAdmin);
  const settings = boardSettings(file);
  const viewer = auth?.coach ?? "";
  const [first, second, third] = rest;

  // ---- the tab's visibility (never writes) ----
  if (first === "status" && rest.length === 1) {
    if (!read) return fail(405, "Use GET.");
    return ok({ enabled: settings.enabled, publicRead: settings.publicRead, canRead: policy.canRead(viewer || undefined), canModerate: Boolean(viewer) && policy.canModerate(viewer) });
  }

  const moderator = Boolean(viewer) && policy.canModerate(viewer);
  const fullView = (f: BoardFile, who: string) => {
    const mod = Boolean(who) && policy.canModerate(who);
    const mute = who ? activeMute(f, who, now) : undefined;
    const s = boardSettings(f);
    return {
      ...boardView(f, who, policyFor(c, f, isAdmin), { moderation: true, now }),
      kind: c.kind, name: c.name,
      settings: { enabled: s.enabled, publicRead: s.publicRead, ...(mod ? { revision: s.revision } : {}) },
      canReport: Boolean(who) && policyFor(c, f, isAdmin).canReport!(who),
      ...(mute ? { mutedUntil: mute.until } : {}),
      ...(mod ? { openReports: (f.reports ?? []).filter((r) => !r.resolved).length } : {}),
    };
  };
  // A write answers with board content only when the caller passes the same read check a GET would, against their
  // access NOW (a former member, a coach on a board that is off: a bare { ok }).
  const after = (who: string, extra: Obj = {}, status = 200) => {
    const f = deps.boards.read(c.scope);
    return policyFor(c, f, isAdmin).canRead(who) ? ok({ ...extra, board: fullView(f, who) }, status) : ok({ ok: true }, status);
  };

  // ---- reading ----
  if (read && rest.length === 0) {
    if (!settings.enabled && !moderator) return fail(auth ? 403 : 401, "The board is switched off.", { code: "board-off" });
    if (!policy.canRead(viewer || undefined)) {
      if (!auth) return fail(401, "Sign in to read the board.");
      return fail(403, kind === "league" ? "The board is for the league's coaches and organisers." : "The board is for registered coaches and organisers.", { code: "members-only" });
    }
    return ok(fullView(file, viewer));
  }
  if (read && rest.length === 1 && (first === "reports" || first === "mutes" || first === "log")) {
    if (!auth) return fail(401, "Sign in first.");
    if (!moderator) return fail(403, "Only organisers can see that.");
    if (first === "reports") {
      const reports = [...(file.reports ?? [])].sort((a, b) => Number(Boolean(a.resolved)) - Number(Boolean(b.resolved)) || b.at.localeCompare(a.at) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
      const postOf = (postId: string) => {
        for (const t of file.threads) {
          if (t.id === postId) return { title: t.title, text: t.text, author: t.author, removed: Boolean(t.removed), hidden: Boolean(t.hidden) };
          const r = t.replies.find((x) => x.id === postId);
          if (r) return { title: t.title, text: r.text, author: r.author, removed: Boolean(r.removed), hidden: Boolean(r.hidden) };
        }
        return undefined;
      };
      return ok({ reports: reports.map((r) => ({ ...r, post: postOf(r.postId) ?? null })) });
    }
    if (first === "mutes") {
      const mutes = Object.values(file.mutes ?? {}).filter((m) => Date.parse(m.until) > now.getTime()).sort((a, b) => a.until.localeCompare(b.until));
      return ok({ mutes });
    }
    return ok({ log: [...(file.log ?? [])].reverse() });
  }
  if (read) return fail(404, "Not found.");

  // ---- writes ----
  if (!auth) return fail(401, "Sign in first.");
  const posting = method === "POST" && (rest.length === 0 || (rest.length === 2 && second === "replies"));
  const actor = writer(auth, deps, posting ? deps.limiters.posts : deps.limiters.writes);
  if (isResult(actor)) return actor;
  const who = actor.coach;
  const mod = policy.canModerate(who);
  const insider = mod || c.isMember(who);
  const needInsider = (): CompetitionBoardResult | undefined => {
    if (!settings.enabled && !mod) return fail(403, "The board is switched off.", { code: "board-off" });
    if (!insider) return fail(403, kind === "league" ? "Only the league's coaches and organisers can post." : "Only registered coaches and organisers can post.", { code: "members-only" });
    return undefined;
  };
  const needMod = (): CompetitionBoardResult | undefined => (mod ? undefined : fail(403, "Only organisers can moderate this board.", { code: "moderators-only" }));

  if (rest.length === 0) {
    if (method !== "POST") return fail(405, "Use GET or POST.");
    const no = needInsider(); if (no) return no;
    const thread = deps.boards.startThread(c.scope, who, parseBoardTitle(input.title), parseBoardText(input.text), { moderator: mod });
    return after(who, { thread }, 201);
  }
  if (first === "seen" && rest.length === 1) {
    if (method !== "POST") return fail(405, "Use POST.");
    if (!policy.canRead(who)) return fail(403, "Not a reader of this board.", { code: "members-only" });
    deps.boards.markSeen(c.scope, who);
    return { status: 204 };
  }
  if (first === "settings" && rest.length === 1) {
    if (method !== "PATCH") return fail(405, "Use PATCH.");
    const no = needMod(); if (no) return no;
    if (input.revision === undefined) return fail(428, "Send the settings revision you loaded.", { code: "revision-required" });
    if (typeof input.revision !== "number" || !Number.isInteger(input.revision)) return fail(400, "revision must be a whole number.");
    for (const f of ["enabled", "publicRead"] as const) if (input[f] !== undefined && typeof input[f] !== "boolean") return fail(400, `${f} must be true or false.`);
    for (const f of Object.keys(input)) if (!["revision", "enabled", "publicRead"].includes(f)) return fail(400, `Unknown field: ${f}.`);
    const next = deps.boards.updateSettings(c.scope, input.revision, {
      ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
      ...(typeof input.publicRead === "boolean" ? { publicRead: input.publicRead } : {}),
    }, who);
    return after(who, { settings: next });
  }
  if (first === "mutes") {
    const no = needMod(); if (no) return no;
    if (rest.length === 1) {
      if (method !== "POST") return fail(405, "Use GET or POST.");
      if (typeof input.coach !== "string" || !input.coach.trim()) return fail(400, "Name the coach to mute.", { code: "coach" });
      const target = deps.coach(input.coach);
      if (!target) return fail(404, "No coach with that name.", { code: "coach" });
      if (policy.canModerate(target)) return fail(400, "Organisers and site admins can't be muted.", { code: "moderator" });
      let until: Date;
      const duration = input.duration;
      if (typeof duration === "string" && MUTE_DURATIONS[duration]) until = new Date(now.getTime() + MUTE_DURATIONS[duration]!);
      else if (duration === "custom") {
        const at = typeof input.until === "string" ? Date.parse(input.until) : Number.NaN;
        if (!Number.isFinite(at)) return fail(400, "Give the time the mute ends.", { code: "until" });
        until = new Date(at);
      } else return fail(400, "duration is 1h, 24h, 7d or custom.", { code: "duration" });
      const mute = deps.boards.mute(c.scope, target, until, who, parseBoardReason(input.reason));
      return after(who, { mute }, 201);
    }
    if (rest.length === 2) {
      if (method !== "DELETE") return fail(405, "Use DELETE.");
      const lifted = deps.boards.unmute(c.scope, second!, who, parseBoardReason(input.reason));
      if (!lifted) return fail(404, "That coach is not muted.", { code: "not-muted" });
      return after(who, { lifted: true });
    }
    return fail(404, "Not found.");
  }
  if (first === "reports") {
    if (rest.length === 3 && third === "resolve") {
      if (method !== "POST") return fail(405, "Use POST.");
      const no = needMod(); if (no) return no;
      if (input.outcome !== "dismissed" && input.outcome !== "actioned") return fail(400, "outcome is dismissed or actioned.", { code: "outcome" });
      const report = deps.boards.resolveReport(c.scope, second!, who, input.outcome, parseBoardReason(input.reason));
      return after(who, { report });
    }
    return fail(404, "Not found.");
  }

  // ---- one post ----
  const postId = first!;
  if (rest.length === 2 && second === "replies") {
    if (method !== "POST") return fail(405, "Use POST.");
    const no = needInsider(); if (no) return no;
    const reply = deps.boards.reply(c.scope, postId, who, parseBoardText(input.text), { moderator: mod });
    return after(who, { reply }, 201);
  }
  if (rest.length === 2 && (second === "hide" || second === "pin" || second === "lock")) {
    if (method !== "POST") return fail(405, "Use POST.");
    const no = needMod(); if (no) return no;
    const field = second === "hide" ? "hidden" : second === "pin" ? "pinned" : "locked";
    if (typeof input[field] !== "boolean") return fail(400, `${field} must be true or false.`);
    const on = input[field] as boolean;
    const action = second === "hide" ? (on ? "hide" : "unhide") : second === "pin" ? (on ? "pin" : "unpin") : (on ? "lock" : "unlock");
    deps.boards.moderate(c.scope, postId, action, who, parseBoardReason(input.reason));
    return after(who);
  }
  if (rest.length === 2 && second === "report") {
    if (method !== "POST") return fail(405, "Use POST.");
    const no = needInsider(); if (no) return no;
    if (!settings.enabled) return fail(403, "The board is switched off.", { code: "board-off" });
    if (!policy.canReport!(who)) return fail(403, "Organisers moderate posts instead of reporting them.", { code: "moderators-moderate" });
    const reason = parseBoardReason(input.reason, true);
    const { report, duplicate } = deps.boards.report(c.scope, postId, who, reason);
    if (!duplicate) {
      // The organisers hear about it in their inbox (never the post's text or the reason); the reporter is not told.
      for (const o of c.organisers) {
        if (k(o) === k(who)) continue;
        c.notify(o, {
          type: "board-report", title: `A post was reported on the ${c.name} board`,
          body: "A coach reported a post. Open the board's Reports queue to review it.", link: `${c.link}&reports=1`, from: "", subject: c.name,
        });
      }
    }
    return after(who, { report: { id: report.id, at: report.at }, duplicate }, duplicate ? 200 : 201);
  }
  if (rest.length !== 1) return fail(404, "Not found.");
  if (method === "PATCH") {
    const no = needInsider(); if (no) return no;
    const title = input.title !== undefined ? parseBoardTitle(input.title) : undefined;
    deps.boards.edit(c.scope, postId, who, parseBoardText(input.text), title, { moderator: mod });
    return after(who);
  }
  if (method === "DELETE") {
    // Current write access first: a former member can't delete their old posts (organisers can delete any); the store
    // refuses a muted author and a switched-off board.
    const no = needInsider(); if (no) return no;
    deps.boards.remove(c.scope, postId, who, mod, { reason: parseBoardReason(input.reason) });
    return after(who);
  }
  return fail(405, "Use PATCH or DELETE.");
}
