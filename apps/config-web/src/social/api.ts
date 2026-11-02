// HTTP routes for Friends, private messages and the block list (landing/nav spec §4.3-4.5). Pure: server.ts hands in
// the session coach, the parsed body and the deps (store, identity lookup, results, notifier, limiters).
//
// Privacy: coaches are addressed and shown by coach name (and the site's own avatar route) only. No email, phone,
// Discord id or contact field is ever read here or put in a response.
//
//   GET    /api/me/friends                  friends, incoming / outgoing requests, People you know
//   POST   /api/me/friends/request {coach}  send (or accept theirs when they already asked)
//   POST   /api/me/friends/accept  {coach}
//   POST   /api/me/friends/decline {coach}
//   DELETE /api/me/friends/:coach           remove a friend or cancel your request
//   GET    /api/me/blocks · POST /api/me/blocks {coach} · DELETE /api/me/blocks/:coach
//   GET    /api/me/threads                  thread list + total unread
//   GET    /api/me/threads/unread           { unread } (nav badge)
//   POST   /api/me/threads {to, text}       start (or continue) the thread with a coach
//   GET    /api/me/threads/:id              one thread (?before=<message id>&limit=)
//   POST   /api/me/threads/:id {text}       send
//   POST   /api/me/threads/:id/read {upTo}  mark read up to the last message shown

import type { NotificationInput } from "../notifications.js";
import { SenderRateLimiter } from "../notifications.js";
import { isReservedCoachName } from "../privacy/fence.js";
import {
  MESSAGE_TEXT_MAX, SocialError, SocialStore, socialKey, THREAD_ID,
  type FixtureContext, type IndexEntry, type MessageRecord, type OrganiserContext, type ThreadFile,
} from "./store.js";

export const NOT_ACCEPTING = "This coach is not accepting messages";
export const NOT_ACCEPTING_REQUESTS = "This coach is not accepting friend requests";
export const YOU_BLOCKED = "You blocked this coach. Unblock them to send a message.";
export const KNOWN_LIMIT = 30;
export const THREAD_PAGE_DEFAULT = 100;
export const THREAD_PAGE_MAX = 200;
const COACH_NAME_MAX = 40;

export interface SocialAuth { coach: string; test?: boolean }

/** One finished game's two coaches, as the results store holds them. */
export interface PlayedRow { home?: { coach?: string }; away?: { coach?: string }; playedAt?: string; pulledAt?: string; test?: boolean; source?: string }

export interface SocialLimiters { messages: SenderRateLimiter; threads: SenderRateLimiter; friends: SenderRateLimiter; blocks: SenderRateLimiter }
export const createSocialLimiters = (): SocialLimiters => ({
  messages: new SenderRateLimiter(30, 60_000),
  threads: new SenderRateLimiter(20, 60 * 60_000),
  friends: new SenderRateLimiter(30, 60 * 60_000),
  blocks: new SenderRateLimiter(60, 60 * 60_000),
});

export interface SocialApiDeps {
  store: SocialStore;
  /** The coach's identity spelling when an active (not banned) account exists, else undefined. */
  coach(name: string): string | undefined;
  /** Finished games (fork and tabletop) for People you know. */
  played(): readonly PlayedRow[];
  avatarFor?(coach: string): string | undefined;
  notify?(coach: string, input: NotificationInput): void;
  isFenced(coach: string): boolean;
  limiters: SocialLimiters;
  now?: () => number;
}

export interface SocialApiResult { status: number; body: unknown }

export const isSocialApiPath = (path: string): boolean => /^\/api\/me\/(friends|blocks|threads)(\/|$)/.test(path);

const err = (status: number, error: string): SocialApiResult => ({ status, body: { error } });
const obj = (body: unknown): Record<string, unknown> | undefined => (body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined);
function decoded(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}
const nameOf = (v: unknown): string | undefined => {
  const s = typeof v === "string" ? v.trim() : "";
  return s && s.length <= COACH_NAME_MAX ? s : undefined;
};

/** Opponents of `coach` in finished, non-test fork and tabletop games: newest game first, one row per coach. */
export function opponentsOf(rows: readonly PlayedRow[], coach: string): Array<{ coach: string; lastPlayed: string; games: number }> {
  const me = socialKey(coach);
  const out = new Map<string, { coach: string; lastPlayed: string; games: number }>();
  for (const r of rows) {
    if (!r || r.test === true || r.source === "naf") continue;
    const home = r.home?.coach?.trim() ?? "";
    const away = r.away?.coach?.trim() ?? "";
    let other = "";
    if (socialKey(home) === me) other = away; else if (socialKey(away) === me) other = home; else continue;
    if (!other || socialKey(other) === me || isReservedCoachName(other)) continue;
    const at = r.playedAt ?? r.pulledAt ?? "";
    const k = socialKey(other);
    const prev = out.get(k);
    if (!prev) out.set(k, { coach: other, lastPlayed: at, games: 1 });
    else { prev.games += 1; if (at > prev.lastPlayed) prev.lastPlayed = at; }
  }
  return [...out.values()].sort((a, b) => b.lastPlayed.localeCompare(a.lastPlayed) || a.coach.localeCompare(b.coach));
}

/** Why `me` cannot message `other` right now (undefined = they can). Organiser messages bypass this (spec §4.5). */
function sendBlocker(deps: SocialApiDeps, me: string, other: string): SocialApiResult | undefined {
  if (isReservedCoachName(other)) return err(410, "This coach's account was deleted.");
  const target = deps.coach(other);
  if (!target) return err(404, "No coach by that name.");
  if (socialKey(target) === socialKey(me)) return err(400, "You cannot message yourself.");
  if (deps.store.hasBlocked(target, me) || deps.isFenced(target)) return err(403, NOT_ACCEPTING);
  if (deps.store.hasBlocked(me, target)) return err(403, YOU_BLOCKED);
  return undefined;
}

function threadSummary(deps: SocialApiDeps, me: string, row: IndexEntry) {
  const deleted = isReservedCoachName(row.with);
  return {
    id: row.id,
    with: row.with,
    avatar: deleted ? null : deps.avatarFor?.(row.with) ?? null,
    deleted,
    organiser: row.organiser === true,
    lastAt: row.lastAt,
    lastFromMe: socialKey(row.lastFrom) === socialKey(me),
    preview: row.preview,
    unread: row.unread,
  };
}

const messageView = (me: string, m: MessageRecord) => ({
  id: m.id, from: m.from, mine: socialKey(m.from) === socialKey(me), text: m.text, at: m.at, ...(m.organiser ? { organiser: m.organiser } : {}),
  ...(m.fixture && typeof m.fixture.title === "string" && typeof m.fixture.link === "string" ? { fixture: { title: m.fixture.title, link: m.fixture.link } } : {}),
});

function threadView(deps: SocialApiDeps, me: string, t: ThreadFile, query: URLSearchParams) {
  const other = SocialStore.other(t, me);
  const deleted = isReservedCoachName(other);
  const blocker = sendBlocker(deps, me, other);
  const beforeRaw = Number(query.get("before") ?? "");
  const limitRaw = Number(query.get("limit") ?? "");
  const limit = Number.isSafeInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, THREAD_PAGE_MAX) : THREAD_PAGE_DEFAULT;
  const pool = Number.isSafeInteger(beforeRaw) && beforeRaw > 0 ? t.messages.filter((m) => m.id < beforeRaw) : t.messages;
  const page = pool.slice(-limit);
  return {
    thread: {
      id: t.id,
      with: other,
      avatar: deleted ? null : deps.avatarFor?.(other) ?? null,
      deleted,
      organiser: t.organiser === true,
      blockedByMe: !deleted && deps.store.hasBlocked(me, other),
      canSend: !blocker,
      ...(blocker ? { reason: (blocker.body as { error: string }).error } : {}),
    },
    messages: page.map((m) => messageView(me, m)),
    more: pool.length > page.length,
  };
}

function notifyBurst(deps: SocialApiDeps, from: string, to: string, threadId: string, text: string): void {
  try {
    deps.notify?.(to, {
      type: "private-message",
      title: `New message from ${from}`,
      body: [...text.replace(/\s+/g, " ")].slice(0, 140).join(""),
      link: `/app/messages/${threadId}`,
      from,
    });
  } catch { /* fire-and-forget */ }
}

function send(deps: SocialApiDeps, me: string, toName: string, rawText: unknown, threadId?: string): SocialApiResult {
  const blocker = sendBlocker(deps, me, toName);
  if (blocker) return blocker;
  const to = deps.coach(toName)!;
  const text = typeof rawText === "string" ? rawText : "";
  if (!text.trim()) return err(400, "Write a message first.");
  if ([...text].length > MESSAGE_TEXT_MAX + 64) return err(400, `A message is at most ${MESSAGE_TEXT_MAX} characters.`);
  const now = deps.now?.() ?? Date.now();
  const existing = threadId ? deps.store.threadFor(me, threadId) : deps.store.findThread(me, to);
  if (!existing && !deps.limiters.threads.take(me, now)) return err(429, "Too many new conversations; try again later.");
  if (!deps.limiters.messages.take(me, now)) return err(429, "Too many messages; wait a minute and try again.");
  const out = deps.store.append(me, to, text);
  if (out.burst) notifyBurst(deps, me, to, out.thread.id, out.message.text);
  return { status: 201, body: { thread: { id: out.thread.id, with: to }, message: messageView(me, out.message), created: out.created } };
}

/** An organiser's tournament message, appended to the organiser <-> coach thread (blocks do not apply, spec §4.5). The
 *  caller already sent the notification, so none is raised here. Fire-and-forget: errors are the caller's to swallow. */
/**
 * A coach's message on a fixture summary, copied into the two coaches' thread so it shows in both inboxes (league UX pass
 * 11-02). Blocks apply (either way: no copy, "blocked"); a deleted / fenced / unknown account gets no copy (undefined).
 * Returns whether the recipient had nothing unread in the thread before (a new burst: the caller notifies once).
 * The shared limiters hold: the message itself was counted by fixtureMessageAllowed (the lobby refuses past it), and a
 * NEW conversation counts against the 20-an-hour conversation limit (past it: no copy, undefined).
 */
export function appendFixtureMessage(deps: Pick<SocialApiDeps, "store" | "coach" | "isFenced" | "limiters" | "now">, from: string, to: string, text: string, fixture: FixtureContext): { burst: boolean } | "blocked" | undefined {
  const a = deps.coach(from), b = deps.coach(to);
  if (!a || !b || socialKey(a) === socialKey(b) || deps.isFenced(a) || deps.isFenced(b)) return undefined;
  if (deps.store.blockedEitherWay(a, b)) return "blocked";
  if (!deps.store.findThread(a, b) && !deps.limiters.threads.take(a, deps.now?.() ?? Date.now())) return undefined;
  return { burst: deps.store.append(a, b, text, undefined, fixture).burst };
}

/** A coach's fixture-summary message counts against the same 30-a-minute message limit as Messages (across fixtures). */
export function fixtureMessageAllowed(deps: Pick<SocialApiDeps, "limiters" | "now">, from: string): boolean {
  return deps.limiters.messages.take(from, deps.now?.() ?? Date.now());
}

export function appendOrganiserMessage(store: SocialStore, organiser: string, coach: string, text: string, context: OrganiserContext): void {
  if (socialKey(organiser) === socialKey(coach)) return;
  store.append(organiser, coach, text, context);
}

export function socialApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: SocialAuth | undefined,
  body: unknown,
  deps: SocialApiDeps,
): SocialApiResult | undefined {
  if (!isSocialApiPath(path)) return undefined;
  if (!auth) return err(401, "Authentication required.");
  const write = method !== "GET" && method !== "HEAD";
  if (write && auth.test) return err(403, "Test sign-in sessions cannot send messages or change friends.");
  const me = deps.coach(auth.coach) ?? auth.coach.trim();
  try {
    return route(method, path, query, me, body, deps);
  } catch (e) {
    if (e instanceof SocialError) return err(e.status, e.message);
    throw e;
  }
}

function route(method: string, path: string, query: URLSearchParams, me: string, body: unknown, deps: SocialApiDeps): SocialApiResult | undefined {
  const now = deps.now?.() ?? Date.now();
  const avatar = (c: string): string | null => deps.avatarFor?.(c) ?? null;

  // ---- friends ----
  if (path === "/api/me/friends" && method === "GET") {
    const f = deps.store.friends(me);
    const linked = new Set([...f.friends, ...f.incoming, ...f.outgoing].map((x) => socialKey(x.coach)));
    const mine = deps.store.blocks(me);
    const blockedByMe = new Set(mine.blocked.map((b) => socialKey(b.coach)));
    const played = opponentsOf(deps.played(), me);
    const lastPlayed = new Map(played.map((p) => [socialKey(p.coach), p]));
    const known: Array<{ coach: string; avatar: string | null; lastPlayed: string; games: number }> = [];
    for (const p of played) {
      if (known.length >= KNOWN_LIMIT) break;
      const k = socialKey(p.coach);
      if (linked.has(k) || blockedByMe.has(k)) continue;
      const coach = deps.coach(p.coach);
      // Only coaches with an account here; and a coach who blocked me never sees me (nor I them).
      if (!coach || deps.store.hasBlocked(coach, me)) continue;
      known.push({ coach, avatar: avatar(coach), lastPlayed: p.lastPlayed, games: p.games });
    }
    const played1 = (c: string) => lastPlayed.get(socialKey(c))?.lastPlayed ?? null;
    return {
      status: 200,
      body: {
        friends: f.friends.map((x) => ({ coach: x.coach, avatar: avatar(x.coach), since: x.since, lastPlayed: played1(x.coach) }))
          .sort((a, b) => a.coach.localeCompare(b.coach)),
        incoming: f.incoming.map((x) => ({ coach: x.coach, avatar: avatar(x.coach), at: x.at, lastPlayed: played1(x.coach) })),
        outgoing: f.outgoing.map((x) => ({ coach: x.coach, avatar: avatar(x.coach), at: x.at })),
        known,
      },
    };
  }
  const friendAction = path.match(/^\/api\/me\/friends\/(request|accept|decline)$/);
  if (friendAction && method === "POST") {
    const name = nameOf(obj(body)?.coach);
    if (!name) return err(400, "Name a coach.");
    if (isReservedCoachName(name)) return err(410, "This coach's account was deleted.");
    const other = deps.coach(name);
    if (!other) return err(404, "No coach by that name.");
    if (socialKey(other) === socialKey(me)) return err(400, "You cannot add yourself.");
    if (friendAction[1] === "request") {
      if (deps.store.hasBlocked(other, me) || deps.isFenced(other)) return err(403, NOT_ACCEPTING_REQUESTS);
      if (deps.store.hasBlocked(me, other)) return err(403, "You blocked this coach. Unblock them first.");
      if (!deps.limiters.friends.take(me, now)) return err(429, "Too many friend requests; try again later.");
      const outcome = deps.store.request(me, other);
      if (outcome !== "already") {
        try {
          deps.notify?.(other, outcome === "friends"
            ? { type: "friend-request", title: `${me} accepted your friend request`, body: "You are now friends.", link: "/app/home#friends", from: me }
            : { type: "friend-request", title: `Friend request from ${me}`, body: "Accept or decline it on your coach page.", link: "/app/home#friends", from: me });
        } catch { /* fire-and-forget */ }
      }
      return { status: 200, body: { relation: deps.store.relation(me, other) } };
    }
    if (friendAction[1] === "accept") {
      deps.store.accept(me, other);
      try { deps.notify?.(other, { type: "friend-request", title: `${me} accepted your friend request`, body: "You are now friends.", link: "/app/home#friends", from: me }); } catch { /* fire-and-forget */ }
      return { status: 200, body: { relation: "friend" } };
    }
    deps.store.decline(me, other);
    return { status: 200, body: { relation: "none" } };
  }
  const friendDelete = path.match(/^\/api\/me\/friends\/([^/]+)$/);
  if (friendDelete && method === "DELETE") {
    const name = nameOf(decoded(friendDelete[1]!));
    if (!name) return err(400, "Name a coach.");
    if (socialKey(name) === socialKey(me)) return err(400, "You cannot remove yourself.");
    // A removed friend may no longer have an account: unlink by the name as stored.
    const removed = deps.store.unlink(me, deps.coach(name) ?? name);
    return removed ? { status: 200, body: { relation: "none" } } : err(404, "Not on your friends list.");
  }

  // ---- blocks ----
  if (path === "/api/me/blocks" && method === "GET") {
    return { status: 200, body: { blocked: deps.store.blocks(me).blocked.map((b) => ({ coach: b.coach, at: b.at, avatar: isReservedCoachName(b.coach) ? null : avatar(b.coach) })) } };
  }
  if (path === "/api/me/blocks" && method === "POST") {
    const name = nameOf(obj(body)?.coach);
    if (!name) return err(400, "Name a coach.");
    const other = deps.coach(name);
    if (!other) return err(404, "No coach by that name.");
    if (socialKey(other) === socialKey(me)) return err(400, "You cannot block yourself.");
    if (!deps.limiters.blocks.take(me, now)) return err(429, "Too many changes; try again later.");
    deps.store.block(me, other);
    return { status: 200, body: { blocked: true, coach: other } };
  }
  const blockDelete = path.match(/^\/api\/me\/blocks\/([^/]+)$/);
  if (blockDelete && method === "DELETE") {
    const name = nameOf(decoded(blockDelete[1]!));
    if (!name) return err(400, "Name a coach.");
    if (!deps.limiters.blocks.take(me, now)) return err(429, "Too many changes; try again later.");
    return deps.store.unblock(me, name) ? { status: 200, body: { blocked: false } } : err(404, "Not on your block list.");
  }

  // ---- threads ----
  if (path === "/api/me/threads/unread" && method === "GET") return { status: 200, body: { unread: deps.store.unread(me) } };
  if (path === "/api/me/threads" && method === "GET") {
    const index = deps.store.index(me);
    return {
      status: 200,
      body: { threads: index.threads.map((row) => threadSummary(deps, me, row)), unread: index.threads.reduce((n, t) => n + t.unread, 0) },
    };
  }
  if (path === "/api/me/threads" && method === "POST") {
    const input = obj(body);
    if (!input) return err(400, "A JSON object is required.");
    const to = nameOf(input.to);
    if (!to) return err(400, "Name a coach.");
    return send(deps, me, to, input.text);
  }
  const threadMatch = path.match(/^\/api\/me\/threads\/([^/]+)(\/read)?$/);
  if (threadMatch) {
    const id = threadMatch[1]!;
    const t = THREAD_ID.test(id) ? deps.store.threadFor(me, id) : undefined;
    if (!t) return err(404, "Conversation not found.");
    if (threadMatch[2]) {
      if (method !== "POST") return undefined;
      // upTo = the id of the last message the client displayed; later messages stay unread.
      const upTo = obj(body)?.upTo;
      if (typeof upTo !== "number" || !Number.isSafeInteger(upTo) || upTo < 0) return err(400, "upTo (the last message id shown) is required.");
      return { status: 200, body: { unread: deps.store.markRead(me, t.id, upTo) } };
    }
    if (method === "GET") return { status: 200, body: threadView(deps, me, t, query) };
    if (method === "POST") {
      const input = obj(body);
      if (!input) return err(400, "A JSON object is required.");
      return send(deps, me, SocialStore.other(t, me), input.text, t.id);
    }
  }
  return undefined;
}
