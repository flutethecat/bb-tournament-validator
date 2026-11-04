// HTTP routes for coach clubs (creation wizards v2 round 2 / 2b Q12-Q16 / round 3). Pure apart from the stores it is
// handed: server.ts passes the session identity, the parsed body (or a raw-body reader for the crest) and the deps.
//
//   GET    /api/clubs?q=&archived=1                public directory (name / home region search)
//   POST   /api/clubs                              any onboarded coach { name, homeRegion?, description? }
//   GET    /api/clubs/:id                          public club page: about, members (names only), the viewer's own state
//   GET    /api/clubs/:id/stats                    public: Results, Stats and Members records (authorised events only)
//   GET    /api/clubs/:id/crest                    public crest image
//   PUT    /api/clubs/:id/crest · DELETE           admins (PNG / JPEG / WebP, the league-logo rules)
//   PATCH  /api/clubs/:id                          admins { revision, name?, homeRegion?, description?, ladderGamesCount?, webhookEvents? }
//   DELETE /api/clubs/:id                          admins: only with no members besides admins; a club with history is archived
//   POST   /api/clubs/:id/archive {archived}       admins
//   GET    /api/clubs/:id/manage                   admins: pending requests, webhook (masked), settings
//   PUT    /api/clubs/:id/webhook {url|null}       admins
//   POST   /api/clubs/:id/requests {message?}      ask to join;  POST .../requests/cancel  withdraw your request
//   POST   /api/clubs/:id/requests/:coach/approve|decline   admins
//   POST   /api/clubs/:id/leave                    a member leaves (the last admin first hands over)
//   POST   /api/clubs/:id/members/:coach/remove    admins (members only; demote an admin first)
//   POST   /api/clubs/:id/members/:coach/role {role}       admins
//   POST   /api/clubs/:id/notify {wins?, board?}   a member's own opt-ins (both off by default)
//   GET    /api/clubs/:id/board                    members (and site admins): the threaded board
//   POST   /api/clubs/:id/board {title, text}      members: start a thread
//   POST   /api/clubs/:id/board/seen               members: opened the board (coalesces "new posts" notes)
//   POST   /api/clubs/:id/board/:postId/replies {text}       members
//   PATCH  /api/clubs/:id/board/:postId {text, title?}       the author
//   DELETE /api/clubs/:id/board/:postId            the author, or a club admin (moderation)
//   GET    /api/me/clubs                           the coach's clubs (the join sheets' club pick) and pending requests
//
// Privacy: coaches are named by their account name only (never email, phone or Discord id). Pending requests are visible to
// the club's admins only. Webhook URLs are secrets: only ever answered masked. GETs never change state.

import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { BoardError, boardView, parseBoardText, parseBoardTitle, type BoardPolicy, type BoardStore } from "../boards/board.js";
import { checkLeagueArt, LOGO_MAX_BYTES } from "../leagues/api.js";
import { isDiscordWebhookUrl, maskWebhookUrl } from "../leagues/discord.js";
import type { NotificationInput } from "../notifications.js";
import { SenderRateLimiter } from "../notifications.js";
import { AVATAR_CONTENT_TYPE, type AvatarExt } from "../teamAvatars.js";
import { textLength } from "../social/store.js";
import { clubStats, latestResults, type ClubLedger } from "./stats.js";
import {
  ClubError, ClubStore, cleanLine, parseClubDescription, parseClubName, parseClubRegion,
} from "./store.js";
import {
  CLUB_ID, CLUB_MEMBERS_MAX, CLUB_REQUEST_MESSAGE_MAX, CLUB_REQUESTS_MAX, CLUBS_PER_COACH_MAX, CLUB_FORMER_MAX, clubCoachKey,
  type ClubRecord, type ClubRole,
} from "./types.js";

export interface ClubsAuth { coach: string; admin?: boolean; test?: boolean }

export interface ClubsLimiters { creates: SenderRateLimiter; writes: SenderRateLimiter; posts: SenderRateLimiter }
export const createClubsLimiters = (): ClubsLimiters => ({
  creates: new SenderRateLimiter(5, 24 * 60 * 60_000),
  writes: new SenderRateLimiter(60, 60 * 60_000),
  posts: new SenderRateLimiter(20, 10 * 60_000),
});

export interface ClubsApiDeps {
  store: ClubStore;
  boards: BoardStore;
  /** One pass over the competitions (src/clubs/stats.ts clubLedger), cached by the caller. */
  ledger(): ClubLedger;
  /** The coach's identity spelling when an active (not banned) account exists, else undefined. */
  coach(name: string): string | undefined;
  notify?(coach: string, input: NotificationInput): void;
  isFenced(coach: string): boolean;
  limiters: ClubsLimiters;
  avatarFor?(coach: string): string | undefined;
  /** The crest upload: reads the raw body up to `max` bytes (undefined = too large). */
  readRaw?(max: number): Promise<Buffer | undefined>;
  declaredTooLarge?(max: number): boolean;
}

export interface ClubsApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** A file to stream (the crest). */
  file?: { path: string; contentType: string };
  close?: true;
}

export const isClubsApiPath = (path: string): boolean => path === "/api/clubs" || path.startsWith("/api/clubs/") || path === "/api/me/clubs";

/** Public reads (no session needed): the directory, a club page, its stats and its crest. */
export function isPublicClubRead(method: string, path: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  return path === "/api/clubs" || /^\/api\/clubs\/[^/]+$/.test(path) || /^\/api\/clubs\/[^/]+\/(?:stats|crest)$/.test(path);
}

const NO_STORE = { "cache-control": "private, no-store" };
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): ClubsApiResult => ({ status, body: { error, ...extra } });
const ok = (body: unknown, status = 200, headers: Record<string, string> = NO_STORE): ClubsApiResult => ({ status, body, headers });
const k = clubCoachKey;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function decoded(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  try { return decodeURIComponent(v); } catch { return undefined; }
}

export const crestUrl = (c: Pick<ClubRecord, "id" | "crestPath">): string | undefined =>
  c.crestPath ? `/api/clubs/${encodeURIComponent(c.id)}/crest?v=${c.crestPath.slice(7, 15)}` : undefined;

const memberOf = (c: ClubRecord, coach: string) => c.members.find((m) => k(m.coach) === k(coach));
const isAdminOf = (c: ClubRecord, coach: string): boolean => memberOf(c, coach)?.role === "admin";
const admins = (c: ClubRecord) => c.members.filter((m) => m.role === "admin");
const clubLink = (c: Pick<ClubRecord, "id">, tail = ""): string => `/app/clubs/${encodeURIComponent(c.id)}${tail}`;

/** The directory card. */
function summary(c: ClubRecord) {
  const crest = crestUrl(c);
  return {
    id: c.id, name: c.name, homeRegion: c.homeRegion, description: c.description.slice(0, 280), memberCount: c.members.length, createdAt: c.createdAt,
    ...(crest ? { crestUrl: crest } : {}), ...(c.archivedAt ? { archived: true } : {}),
  };
}

/** The public club page (members by name; never requests, never the webhook). */
function publicView(c: ClubRecord, viewer: ClubsAuth | undefined, deps: ClubsApiDeps) {
  const me = viewer ? memberOf(c, viewer.coach) : undefined;
  const requested = Boolean(viewer && c.requests.some((r) => k(r.coach) === k(viewer.coach)));
  let latest: ReturnType<typeof latestResults> = [];
  try { latest = latestResults(c, deps.ledger()); } catch { latest = []; }
  const crest = crestUrl(c);
  return {
    club: {
      id: c.id, name: c.name, homeRegion: c.homeRegion, description: c.description, createdAt: c.createdAt, revision: c.revision,
      ...(crest ? { crestUrl: crest } : {}), ...(c.archivedAt ? { archivedAt: c.archivedAt } : {}),
      ladderGamesCount: c.settings.ladderGamesCount,
      members: c.members.map((m) => {
        const avatar = deps.avatarFor?.(m.coach);
        return { coach: m.coach, role: m.role, joinedAt: m.joinedAt, ...(avatar ? { avatar } : {}) };
      }),
      memberCount: c.members.length,
    },
    latest,
    me: viewer ? {
      member: Boolean(me), ...(me ? { role: me.role, notify: { wins: me.notify?.wins === true, board: me.notify?.board === true } } : {}),
      requested,
      canRequest: !me && !requested && !c.archivedAt,
      siteAdmin: viewer.admin === true,
    } : null,
  };
}

function manageView(c: ClubRecord, deps: ClubsApiDeps) {
  const url = deps.store.webhook(c.id);
  return {
    requests: c.requests.map((r) => ({ coach: r.coach, at: r.at, ...(r.message ? { message: r.message } : {}) })),
    webhook: { configured: Boolean(url), maskedUrl: maskWebhookUrl(url) },
    settings: structuredClone(c.settings),
    revision: c.revision,
  };
}

export async function clubsApi(method: string, path: string, query: URLSearchParams, auth: ClubsAuth | undefined, body: unknown, deps: ClubsApiDeps): Promise<ClubsApiResult | undefined> {
  if (!isClubsApiPath(path)) return undefined;
  try {
    return await route(method, path, query, auth, body, deps);
  } catch (e) {
    if (e instanceof ClubError || e instanceof BoardError) return fail(e.status, e.message, e.code ? { code: e.code } : {});
    throw e;
  }
}

/** The acting coach for a write: signed in, not a test session, an active account, not being deleted, under the rate limit. */
function writer(auth: ClubsAuth | undefined, deps: ClubsApiDeps, limiter: SenderRateLimiter = deps.limiters.writes): { coach: string; admin: boolean } | ClubsApiResult {
  if (!auth) return fail(401, "Sign in first.");
  if (auth.test) return fail(403, "Test sign-in sessions cannot change clubs.");
  if (deps.isFenced(auth.coach)) return fail(410, "This account is being deleted.");
  const coach = deps.coach(auth.coach);
  if (!coach) return fail(403, "Your account can't do that.");
  if (!limiter.take(coach)) return fail(429, "Too many changes. Try again later.", { code: "rate" });
  return { coach, admin: auth.admin === true };
}
const isResult = (v: unknown): v is ClubsApiResult => isObj(v) && typeof v.status === "number";

function requireAdmin(c: ClubRecord, actor: { coach: string; admin: boolean }): void {
  if (!isAdminOf(c, actor.coach) && !actor.admin) throw new ClubError(403, "Only this club's admins can do that.");
}
function requireOpen(c: ClubRecord): void {
  if (c.archivedAt) throw new ClubError(409, "This club is archived.", "archived");
}

function tell(deps: ClubsApiDeps, coach: string, input: NotificationInput): void {
  try { deps.notify?.(coach, input); } catch { /* fire-and-forget */ }
}

async function route(method: string, path: string, query: URLSearchParams, auth: ClubsAuth | undefined, body: unknown, deps: ClubsApiDeps): Promise<ClubsApiResult> {
  const read = method === "GET" || method === "HEAD";
  const input = isObj(body) ? body : {};

  // ---- the coach's own clubs ----
  if (path === "/api/me/clubs") {
    if (!read) return fail(405, "Use GET.");
    if (!auth) return fail(401, "Sign in first.");
    const mine = deps.store.membershipsOf(auth.coach).map((c) => ({ id: c.id, name: c.name, role: memberOf(c, auth.coach)!.role, ...(crestUrl(c) ? { crestUrl: crestUrl(c) } : {}) }));
    const pending = deps.store.list().filter((c) => !c.archivedAt && c.requests.some((r) => k(r.coach) === k(auth.coach))).map((c) => ({ id: c.id, name: c.name }));
    return ok({ clubs: mine, requests: pending });
  }

  // ---- the directory ----
  if (path === "/api/clubs") {
    if (read) {
      const q = cleanLine(query.get("q") ?? "").toLowerCase().slice(0, 60);
      const archived = query.get("archived") === "1";
      const clubs = deps.store.list()
        .filter((c) => (archived ? true : !c.archivedAt))
        .filter((c) => !q || c.name.toLowerCase().includes(q) || c.homeRegion.toLowerCase().includes(q))
        .sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name));
      return ok({ clubs: clubs.map(summary), total: clubs.length }, 200, { "cache-control": "no-store" });
    }
    if (method !== "POST") return fail(405, "Use GET or POST.");
    const actor = writer(auth, deps, deps.limiters.creates);
    if (isResult(actor)) return actor;
    if (deps.store.membershipsOf(actor.coach).length >= CLUBS_PER_COACH_MAX) return fail(409, `You are in ${CLUBS_PER_COACH_MAX} clubs already. Leave one first.`, { code: "cap" });
    const extra = Object.keys(input).filter((x) => !["name", "homeRegion", "description"].includes(x));
    if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
    const club = deps.store.create({
      name: parseClubName(input.name), homeRegion: parseClubRegion(input.homeRegion), description: parseClubDescription(input.description), createdBy: actor.coach,
    });
    return ok(publicView(club, auth, deps), 201);
  }

  const m = path.match(/^\/api\/clubs\/([^/]+)(?:\/(.*))?$/);
  if (!m) return fail(404, "Not found.");
  const id = decoded(m[1]);
  if (!id || !CLUB_ID.test(id)) return fail(404, "Club not found.");
  const rest = (m[2] ?? "").split("/").filter((s) => s !== "");
  if ((m[2] ?? "") !== rest.join("/")) return fail(404, "Not found.");
  const club = deps.store.get(id);
  if (!club) return fail(404, "Club not found.");
  const [first, second, third, ...more] = rest;
  if (more.length) return fail(404, "Not found.");

  // ---- GET /api/clubs/:id · PATCH · DELETE ----
  if (first === undefined) {
    if (read) return ok(publicView(club, auth, deps), 200, auth ? NO_STORE : { "cache-control": "no-store" });
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    requireAdmin(club, actor);
    if (method === "PATCH") return patchClub(club, input, deps);
    if (method === "DELETE") return deleteClub(club, input, deps);
    return fail(405, "Use GET, PATCH or DELETE.");
  }

  if (first === "stats" && second === undefined) {
    if (!read) return fail(405, "Use GET.");
    return ok(clubStats(club, deps.ledger()), 200, { "cache-control": "no-store" });
  }

  if (first === "crest" && second === undefined) return crestRoute(method, club, auth, deps);

  if (first === "archive" && second === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    requireAdmin(club, actor);
    if (typeof input.archived !== "boolean") return fail(400, "archived must be true or false.");
    const archived = input.archived;
    const updated = deps.store.update(club.id, (c) => { if (archived) c.archivedAt ??= deps.store.now().toISOString(); else delete c.archivedAt; });
    return ok(publicView(updated, auth, deps));
  }

  if (first === "manage" && second === undefined) {
    if (!read) return fail(405, "Use GET.");
    if (!auth) return fail(401, "Sign in first.");
    if (!isAdminOf(club, auth.coach) && auth.admin !== true) return fail(403, "Only this club's admins can see that.");
    return ok(manageView(club, deps));
  }

  if (first === "webhook" && second === undefined) {
    if (method !== "PUT") return fail(405, "Use PUT.");
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    requireAdmin(club, actor);
    const url = input.url;
    if (url !== null && url !== "" && !isDiscordWebhookUrl(url)) return fail(400, "That is not a Discord webhook URL (https://discord.com/api/webhooks/...).", { field: "url" });
    deps.store.setWebhook(club.id, typeof url === "string" && url ? url : null);
    return ok(manageView(deps.store.get(club.id) ?? club, deps));
  }

  if (first === "requests") return requestsRoute(method, club, second, third, input, auth, deps);

  if (first === "leave" && second === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    const me = memberOf(club, actor.coach);
    if (!me) return fail(409, "You are not a member of this club.", { code: "not-member" });
    const others = club.members.filter((x) => k(x.coach) !== k(actor.coach));
    if (me.role === "admin" && others.length && !others.some((x) => x.role === "admin"))
      return fail(409, "You are the last admin. Make another member an admin before you leave.", { code: "last-admin" });
    const at = deps.store.now().toISOString();
    const updated = deps.store.update(club.id, (c) => {
      c.members = c.members.filter((x) => k(x.coach) !== k(actor.coach));
      pushFormer(c, { coach: me.coach, joinedAt: me.joinedAt, leftAt: at, reason: "left" });
      // The last member leaving archives the club (its history stays readable).
      if (!c.members.length) c.archivedAt ??= at;
    });
    return ok(publicView(updated, auth, deps));
  }

  if (first === "members" && second && (third === "remove" || third === "role")) {
    if (method !== "POST") return fail(405, "Use POST.");
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    requireAdmin(club, actor);
    const target = decoded(second);
    const member = target ? memberOf(club, target) : undefined;
    if (!member) return fail(404, "That coach is not a member.");
    if (third === "remove") {
      if (member.role === "admin") return fail(409, "Make this admin a member first.", { code: "admin" });
      const at = deps.store.now().toISOString();
      const updated = deps.store.update(club.id, (c) => {
        c.members = c.members.filter((x) => k(x.coach) !== k(member.coach));
        pushFormer(c, { coach: member.coach, joinedAt: member.joinedAt, leftAt: at, reason: "removed" });
      });
      tell(deps, member.coach, { type: "club", title: `You were removed from ${club.name}`, body: `An admin removed you from the club ${club.name}. Your games for it stay in its history.`, link: clubLink(club), from: actor.coach });
      return ok(manageAndPublic(updated, auth, deps));
    }
    const role = input.role;
    if (role !== "admin" && role !== "member") return fail(400, "role must be admin or member.", { field: "role" });
    if (member.role === role) return ok(manageAndPublic(club, auth, deps));
    if (role === "member" && admins(club).length <= 1) return fail(409, "A club needs at least one admin.", { code: "last-admin" });
    const updated = deps.store.update(club.id, (c) => { const x = c.members.find((y) => k(y.coach) === k(member.coach)); if (x) x.role = role as ClubRole; });
    if (role === "admin") tell(deps, member.coach, { type: "club", title: `You are now an admin of ${club.name}`, body: `${actor.coach} made you an admin of ${club.name}.`, link: clubLink(club, "/manage"), from: actor.coach });
    return ok(manageAndPublic(updated, auth, deps));
  }

  if (first === "notify" && second === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    const actor = writer(auth, deps);
    if (isResult(actor)) return actor;
    if (!memberOf(club, actor.coach)) return fail(409, "You are not a member of this club.", { code: "not-member" });
    for (const f of ["wins", "board"] as const) if (input[f] !== undefined && typeof input[f] !== "boolean") return fail(400, `${f} must be true or false.`);
    const updated = deps.store.update(club.id, (c) => {
      const x = c.members.find((y) => k(y.coach) === k(actor.coach));
      if (!x) return;
      const next = { wins: typeof input.wins === "boolean" ? input.wins : x.notify?.wins === true, board: typeof input.board === "boolean" ? input.board : x.notify?.board === true };
      if (next.wins || next.board) x.notify = { ...(next.wins ? { wins: true } : {}), ...(next.board ? { board: true } : {}) }; else delete x.notify;
    });
    return ok(publicView(updated, auth, deps));
  }

  if (first === "board") return boardRoute(method, club, second, third, input, auth, deps);

  return fail(404, "Not found.");
}

function manageAndPublic(c: ClubRecord, auth: ClubsAuth | undefined, deps: ClubsApiDeps) {
  return { ...publicView(c, auth, deps), manage: manageView(c, deps) };
}

function pushFormer(c: ClubRecord, row: ClubRecord["former"][number]): void {
  c.former.push(row);
  if (c.former.length > CLUB_FORMER_MAX) c.former = c.former.slice(c.former.length - CLUB_FORMER_MAX);
}

function patchClub(club: ClubRecord, input: Obj, deps: ClubsApiDeps): ClubsApiResult {
  const extra = Object.keys(input).filter((x) => !["revision", "name", "homeRegion", "description", "ladderGamesCount", "webhookEvents"].includes(x));
  if (extra.length) return fail(400, `Unknown field: ${extra[0]!.slice(0, 40)}.`);
  if (typeof input.revision !== "number") return fail(428, "Send the revision you loaded.", { code: "revision" });
  const name = input.name !== undefined ? parseClubName(input.name) : undefined;
  const homeRegion = input.homeRegion !== undefined ? parseClubRegion(input.homeRegion) : undefined;
  const description = input.description !== undefined ? parseClubDescription(input.description) : undefined;
  if (input.ladderGamesCount !== undefined && typeof input.ladderGamesCount !== "boolean") return fail(400, "ladderGamesCount must be true or false.");
  let events: Partial<Record<"results" | "podiums" | "titles", boolean>> | undefined;
  if (input.webhookEvents !== undefined) {
    if (!isObj(input.webhookEvents)) return fail(400, "webhookEvents must be an object.");
    events = {};
    for (const [key, v] of Object.entries(input.webhookEvents)) {
      if (key !== "results" && key !== "podiums" && key !== "titles") return fail(400, `Unknown webhook event: ${key.slice(0, 40)}.`);
      if (typeof v !== "boolean") return fail(400, `${key} must be true or false.`);
      events[key] = v;
    }
  }
  const updated = deps.store.update(club.id, (c) => {
    if (c.archivedAt && (name !== undefined)) throw new ClubError(409, "This club is archived.", "archived");
    if (name !== undefined) c.name = name;
    if (homeRegion !== undefined) c.homeRegion = homeRegion;
    if (description !== undefined) c.description = description;
    if (typeof input.ladderGamesCount === "boolean") c.settings.ladderGamesCount = input.ladderGamesCount;
    if (events) c.settings.webhookEvents = { ...c.settings.webhookEvents, ...events };
  }, input.revision);
  return ok({ ...publicView(updated, undefined, deps), manage: manageView(updated, deps) });
}

function deleteClub(club: ClubRecord, input: Obj, deps: ClubsApiDeps): ClubsApiResult {
  if (club.members.some((m) => m.role !== "admin")) return fail(409, "Remove the members first, or archive the club.", { code: "members" });
  if (input.revision !== undefined && input.revision !== club.revision) return fail(409, "The club changed since you loaded it. Reload and try again.", { code: "stale" });
  // A club that any competition entry names keeps its history: archived, never deleted.
  let picked = false;
  try { picked = deps.ledger().picked.has(club.id); } catch { picked = true; }
  if (picked) {
    const updated = deps.store.update(club.id, (c) => { c.archivedAt ??= deps.store.now().toISOString(); });
    return ok({ archived: true, club: summary(updated) });
  }
  deps.store.remove(club.id);
  deps.boards.drop(`club:${club.id}`);
  return ok({ deleted: true });
}

function requestsRoute(method: string, club: ClubRecord, second: string | undefined, third: string | undefined, input: Obj, auth: ClubsAuth | undefined, deps: ClubsApiDeps): ClubsApiResult {
  if (method !== "POST") return fail(405, "Use POST.");
  const actor = writer(auth, deps);
  if (isResult(actor)) return actor;

  // POST .../requests: ask to join (idempotent while pending).
  if (second === undefined) {
    requireOpen(club);
    if (memberOf(club, actor.coach)) return fail(409, "You are already a member.", { code: "member" });
    if (club.requests.some((r) => k(r.coach) === k(actor.coach))) return ok(publicView(club, auth, deps));
    if (deps.store.membershipsOf(actor.coach).length >= CLUBS_PER_COACH_MAX) return fail(409, `You are in ${CLUBS_PER_COACH_MAX} clubs already. Leave one first.`, { code: "cap" });
    if (club.requests.length >= CLUB_REQUESTS_MAX) return fail(409, "This club has too many requests waiting. Try again later.", { code: "full" });
    let message: string | undefined;
    if (input.message !== undefined && input.message !== null && input.message !== "") {
      if (typeof input.message !== "string") return fail(400, "message must be text.");
      message = cleanLine(input.message);
      if (textLength(message) > CLUB_REQUEST_MESSAGE_MAX) return fail(400, `A message is at most ${CLUB_REQUEST_MESSAGE_MAX} characters.`, { field: "message" });
    }
    const updated = deps.store.update(club.id, (c) => {
      if (c.requests.some((r) => k(r.coach) === k(actor.coach))) return;
      c.requests.push({ coach: actor.coach, at: deps.store.now().toISOString(), ...(message ? { message } : {}) });
    });
    for (const a of admins(updated)) tell(deps, a.coach, {
      type: "club", title: `${actor.coach} asked to join ${club.name}`, body: "Approve or decline the request in the club's management.", link: clubLink(club, "/manage"), from: actor.coach,
    });
    return ok(publicView(updated, auth, deps), 201);
  }

  // POST .../requests/cancel: the coach withdraws their own request.
  if (second === "cancel" && third === undefined) {
    if (!club.requests.some((r) => k(r.coach) === k(actor.coach))) return ok(publicView(club, auth, deps));
    const updated = deps.store.update(club.id, (c) => { c.requests = c.requests.filter((r) => k(r.coach) !== k(actor.coach)); });
    return ok(publicView(updated, auth, deps));
  }

  // POST .../requests/:coach/approve|decline (admins).
  if (third !== "approve" && third !== "decline") return fail(404, "Not found.");
  requireAdmin(club, actor);
  requireOpen(club);
  const target = decoded(second);
  const request = target ? club.requests.find((r) => k(r.coach) === k(target)) : undefined;
  if (!request) return fail(404, "That request is not waiting any more.");
  if (third === "decline") {
    const updated = deps.store.update(club.id, (c) => { c.requests = c.requests.filter((r) => k(r.coach) !== k(request.coach)); });
    tell(deps, request.coach, { type: "club", title: `${club.name} declined your request`, body: `The admins of ${club.name} declined your request to join.`, link: clubLink(club), from: actor.coach });
    return ok(manageAndPublic(updated, auth, deps));
  }
  const joining = deps.coach(request.coach);
  if (!joining || deps.isFenced(request.coach)) {
    deps.store.update(club.id, (c) => { c.requests = c.requests.filter((r) => k(r.coach) !== k(request.coach)); });
    return fail(409, "That coach's account is not active any more.", { code: "inactive" });
  }
  if (club.members.length >= CLUB_MEMBERS_MAX) return fail(409, `A club has at most ${CLUB_MEMBERS_MAX} members.`, { code: "full" });
  if (deps.store.membershipsOf(joining).length >= CLUBS_PER_COACH_MAX) return fail(409, `${joining} is in ${CLUBS_PER_COACH_MAX} clubs already.`, { code: "cap" });
  const updated = deps.store.update(club.id, (c) => {
    c.requests = c.requests.filter((r) => k(r.coach) !== k(request.coach));
    if (!c.members.some((x) => k(x.coach) === k(joining))) c.members.push({ coach: joining, role: "member", joinedAt: deps.store.now().toISOString() });
  });
  tell(deps, joining, { type: "club", title: `Welcome to ${club.name}`, body: `Your request to join ${club.name} was approved. Pick the club when you join a league or tournament to play for it.`, link: clubLink(club), from: actor.coach });
  return ok(manageAndPublic(updated, auth, deps));
}

// ---- crest ----------------------------------------------------------------------------------------------------------

const crestLocks = new Map<string, Promise<unknown>>();
function withCrestLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prior = crestLocks.get(id) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.catch(() => undefined);
  crestLocks.set(id, tail);
  void tail.then(() => { if (crestLocks.get(id) === tail) crestLocks.delete(id); });
  return run;
}

async function crestRoute(method: string, club: ClubRecord, auth: ClubsAuth | undefined, deps: ClubsApiDeps): Promise<ClubsApiResult> {
  if (method === "GET" || method === "HEAD") {
    if (!club.crestPath) return fail(404, "No crest.");
    const ext = club.crestPath.split(".").pop() as AvatarExt;
    return { status: 200, file: { path: deps.store.crestFile(club.crestPath), contentType: AVATAR_CONTENT_TYPE[ext] } };
  }
  if (method !== "PUT" && method !== "DELETE") return fail(405, "Use GET, PUT or DELETE.");
  const actor = writer(auth, deps);
  if (isResult(actor)) return actor;
  requireAdmin(club, actor);
  if (method === "DELETE") {
    await withCrestLock(club.id, async () => {
      const previous = deps.store.get(club.id)?.crestPath;
      deps.store.update(club.id, (c) => { delete c.crestPath; });
      deps.store.dropCrest(previous);
    });
    return { status: 204 };
  }
  const tooLarge: ClubsApiResult = { status: 413, close: true, body: { error: `The crest must be at most ${LOGO_MAX_BYTES / (1024 * 1024)} MB.` } };
  if (deps.declaredTooLarge?.(LOGO_MAX_BYTES)) return tooLarge;
  const bytes = await deps.readRaw?.(LOGO_MAX_BYTES);
  if (!bytes) return tooLarge;
  const checked = checkLeagueArt("logo", bytes);
  if (!checked.ok) return fail(400, checked.error.replace("The logo", "The crest"));
  const ext = checked.image.ext;
  const rel = `crests/${createHash("sha256").update(club.id).update("\0").update(bytes).digest("hex").slice(0, 32)}.${ext}`;
  const updated = await withCrestLock(club.id, async () => {
    const target = deps.store.crestFile(rel);
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fsp.mkdir(join(deps.store.dir, "crests"), { recursive: true });
    try {
      await fsp.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await fsp.rename(temp, target);
    } catch (err) {
      try { await fsp.unlink(temp); } catch { /* none */ }
      throw err;
    }
    const previous = deps.store.get(club.id)?.crestPath;
    const next = deps.store.update(club.id, (c) => { c.crestPath = rel; });
    if (previous !== rel) deps.store.dropCrest(previous);
    return next;
  });
  return ok({ crestUrl: crestUrl(updated) });
}

// ---- board ----------------------------------------------------------------------------------------------------------

/** A club board's rules: members read and post (site admins read and moderate); club admins moderate. */
export function clubBoardPolicy(club: ClubRecord, siteAdmin: boolean): BoardPolicy {
  return {
    canRead: (viewer) => Boolean(viewer && (memberOf(club, viewer) || siteAdmin)),
    canPost: (viewer) => Boolean(memberOf(club, viewer)) && !club.archivedAt,
    canModerate: (viewer) => isAdminOf(club, viewer) || siteAdmin,
  };
}

function boardRoute(method: string, club: ClubRecord, second: string | undefined, third: string | undefined, input: Obj, auth: ClubsAuth | undefined, deps: ClubsApiDeps): ClubsApiResult {
  const scope = `club:${club.id}`;
  if (!auth) return fail(401, "Sign in to read the club board.");
  const policy = clubBoardPolicy(club, auth.admin === true);
  if (!policy.canRead(auth.coach)) return fail(403, "The board is for club members.", { code: "members-only" });
  if ((method === "GET" || method === "HEAD") && second === undefined) {
    return ok(boardView(deps.boards.read(scope), auth.coach, policy));
  }
  // Every write below: an active account, not a test session; posts share their own rate limit.
  const posting = method === "POST" && (second === undefined || third === "replies");
  const actor = writer(auth, deps, posting ? deps.limiters.posts : deps.limiters.writes);
  if (isResult(actor)) return actor;

  if (second === "seen" && third === undefined) {
    if (method !== "POST") return fail(405, "Use POST.");
    deps.boards.markSeen(scope, actor.coach);
    return { status: 204 };
  }
  if (second === undefined) {
    if (method !== "POST") return fail(405, "Use GET or POST.");
    if (!policy.canPost(actor.coach)) return fail(403, club.archivedAt ? "This club is archived." : "Only members can post.");
    const thread = deps.boards.startThread(scope, actor.coach, parseBoardTitle(input.title), parseBoardText(input.text));
    noticeBoard(club, actor.coach, deps);
    return ok({ thread, board: boardView(deps.boards.read(scope), actor.coach, policy) }, 201);
  }
  if (third === "replies") {
    if (method !== "POST") return fail(405, "Use POST.");
    if (!policy.canPost(actor.coach)) return fail(403, club.archivedAt ? "This club is archived." : "Only members can post.");
    const reply = deps.boards.reply(scope, second, actor.coach, parseBoardText(input.text));
    noticeBoard(club, actor.coach, deps);
    return ok({ reply, board: boardView(deps.boards.read(scope), actor.coach, policy) }, 201);
  }
  if (third !== undefined) return fail(404, "Not found.");
  if (method === "PATCH") {
    if (!policy.canPost(actor.coach)) return fail(403, "Only members can edit their posts.");
    const title = input.title !== undefined ? parseBoardTitle(input.title) : undefined;
    deps.boards.edit(scope, second, actor.coach, parseBoardText(input.text), title);
    return ok({ board: boardView(deps.boards.read(scope), actor.coach, policy) });
  }
  if (method === "DELETE") {
    deps.boards.remove(scope, second, actor.coach, policy.canModerate(actor.coach));
    return ok({ board: boardView(deps.boards.read(scope), actor.coach, policy) });
  }
  return fail(405, "Use PATCH or DELETE.");
}

/** Coalesced "new posts" notes to members who opted in (once until they open the board again). Never the post text. */
function noticeBoard(club: ClubRecord, author: string, deps: ClubsApiDeps): void {
  const candidates = club.members.filter((m) => m.notify?.board === true).map((m) => m.coach);
  if (!candidates.length) return;
  let due: string[] = [];
  try { due = deps.boards.claimNotices(`club:${club.id}`, candidates, author); } catch { return; }
  for (const coach of due) tell(deps, coach, { type: "club", title: `New posts on the ${club.name} board`, body: "Clubmates posted on the club board.", link: clubLink(club, "?tab=board"), from: "" });
}
