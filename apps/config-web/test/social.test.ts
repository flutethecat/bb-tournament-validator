import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createSocialLimiters, isSocialApiPath, KNOWN_LIMIT, NOT_ACCEPTING, NOT_ACCEPTING_REQUESTS, opponentsOf, socialApi, YOU_BLOCKED,
  type PlayedRow, type SocialApiDeps, type SocialAuth,
} from "../src/social/api.js";
import { cleanMessageText, SocialStore, socialFileName, THREAD_MESSAGE_CAP } from "../src/social/store.js";
import { NotificationStore, notificationsApi, setOrganiserThreadSink, type NotificationInput } from "../src/notifications.js";
import { appendOrganiserMessage } from "../src/social/api.js";
import { clearFences, coachKeyHash, fenceCoachHash } from "../src/privacy/fence.js";
import { SenderRateLimiter } from "../src/notifications.js";
import { requireSession } from "../src/auth/requireSession.js";

// Friends, private messages and the block list (landing spec §4.3-4.5): the store, the routes' auth, block effects,
// the friend request lifecycle, message send / read / unread counts, the rate limit, escaping and the deletion fence.

const roots: string[] = [];
afterEach(() => {
  clearFences();
  setOrganiserThreadSink(undefined);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const tmp = (): string => { const r = mkdtempSync(join(tmpdir(), "social-")); roots.push(r); return r; };

const ACCOUNTS = ["Alice", "Bob", "Carol", "Dave", "Erin"];
interface Harness { deps: SocialApiDeps; store: SocialStore; notes: Array<{ coach: string; input: NotificationInput }>; played: PlayedRow[]; dir: string }
function harness(over: Partial<SocialApiDeps> = {}): Harness {
  const dir = tmp();
  const store = new SocialStore(dir);
  const notes: Harness["notes"] = [];
  const played: PlayedRow[] = [];
  const deps: SocialApiDeps = {
    store,
    coach: (name) => ACCOUNTS.find((a) => a.toLowerCase() === name.trim().toLowerCase()),
    played: () => played,
    avatarFor: (c) => `/api/coach-avatars/${c}?v=0123456789abcdef`,
    notify: (coach, input) => { notes.push({ coach, input }); },
    isFenced: () => false,
    limiters: createSocialLimiters(),
    ...over,
  };
  return { deps, store, notes, played, dir };
}
const as = (coach: string, extra: Partial<SocialAuth> = {}): SocialAuth => ({ coach, ...extra });
const call = (h: Harness, method: string, path: string, auth: SocialAuth | undefined, body?: unknown, query = "") =>
  socialApi(method, path, new URLSearchParams(query), auth, body, h.deps)!;
const json = (r: { body: unknown }) => r.body as any;

describe("routes: auth and paths", () => {
  it("claims only the social paths; every route needs a session; test sessions read only", () => {
    expect(isSocialApiPath("/api/me/friends")).toBe(true);
    expect(isSocialApiPath("/api/me/threads/t0123456789abcdef/read")).toBe(true);
    expect(isSocialApiPath("/api/me/blocks/Bob")).toBe(true);
    expect(isSocialApiPath("/api/me/friendship")).toBe(false);
    expect(isSocialApiPath("/api/me/notifications")).toBe(false);
    const h = harness();
    for (const [m, p] of [["GET", "/api/me/friends"], ["GET", "/api/me/threads"], ["POST", "/api/me/threads"], ["GET", "/api/me/blocks"], ["POST", "/api/me/friends/request"]] as const)
      expect(call(h, m, p, undefined, {}).status, `${m} ${p}`).toBe(401);
    expect(call(h, "POST", "/api/me/threads", as("Alice", { test: true }), { to: "Bob", text: "hi" }).status).toBe(403);
    expect(call(h, "POST", "/api/me/friends/request", as("Alice", { test: true }), { coach: "Bob" }).status).toBe(403);
    expect(call(h, "GET", "/api/me/threads", as("Alice", { test: true })).status).toBe(200);
  });

  it("a coach only ever reads their own threads; an unknown or foreign id is 404", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "Hello Bob" })).thread.id as string;
    expect(call(h, "GET", `/api/me/threads/${id}`, as("Bob")).status).toBe(200);
    expect(call(h, "GET", `/api/me/threads/${id}`, as("Carol")).status).toBe(404);
    expect(call(h, "POST", `/api/me/threads/${id}`, as("Carol"), { text: "sneaky" }).status).toBe(404);
    expect(call(h, "POST", `/api/me/threads/${id}/read`, as("Carol"), { upTo: 1 }).status).toBe(404);
    expect(call(h, "GET", "/api/me/threads/..%2Fetc", as("Alice")).status).toBe(404);
    expect(call(h, "GET", "/api/me/threads/a/b", as("Alice"))).toBeUndefined(); // not a social route: the server's 404
    expect(call(h, "GET", "/api/me/threads/t0000000000000000", as("Alice")).status).toBe(404);
  });

  it("answers coach names and the site's own avatar route only, never a contact field", () => {
    const h = harness();
    h.played.push({ home: { coach: "Alice" }, away: { coach: "Bob" }, playedAt: "2026-10-20T00:00:00Z" });
    call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "Hi" });
    const all = JSON.stringify([json(call(h, "GET", "/api/me/friends", as("Alice"))), json(call(h, "GET", "/api/me/threads", as("Alice")))]);
    expect(all).not.toMatch(/email|phone|discord/i);
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).known[0]).toEqual({ coach: "Bob", avatar: "/api/coach-avatars/Bob?v=0123456789abcdef", lastPlayed: "2026-10-20T00:00:00Z", games: 1 });
  });
});

describe("session gate (live host, src/auth/requireSession.ts)", () => {
  it("every social route is signed-in only: anonymous API calls are 401, the /app/messages page itself is public (the SPA shows Sign in)", () => {
    const req = (method: string) => ({ method, headers: {} }) as never;
    for (const [m, p] of [["GET", "/api/me/friends"], ["GET", "/api/me/threads"], ["GET", "/api/me/threads/unread"], ["GET", "/api/me/blocks"],
      ["POST", "/api/me/threads"], ["POST", "/api/me/friends/request"], ["DELETE", "/api/me/blocks/Bob"]] as const)
      expect(requireSession(req(m), p, "").kind, `${m} ${p}`).toBe("unauthorized");
    expect(requireSession(req("GET"), "/app/messages", "").kind).toBe("allow");
    expect(requireSession(req("GET"), "/app/messages/t0123456789abcdef", "").kind).toBe("allow");
  });
});

describe("friend request lifecycle", () => {
  it("request -> incoming/outgoing -> accept -> friends both ways -> remove", () => {
    const h = harness();
    expect(json(call(h, "POST", "/api/me/friends/request", as("alice"), { coach: "bob" }))).toEqual({ relation: "outgoing" });
    // identity spellings are stored, whatever case was typed
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).outgoing.map((r: any) => r.coach)).toEqual(["Bob"]);
    expect(json(call(h, "GET", "/api/me/friends", as("Bob"))).incoming.map((r: any) => r.coach)).toEqual(["Alice"]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ coach: "Bob", input: { type: "friend-request", title: "Friend request from Alice", link: "/app/home#friends" } });
    // a second request is a no-op (no second notification)
    expect(json(call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Bob" }))).toEqual({ relation: "outgoing" });
    expect(h.notes).toHaveLength(1);
    expect(call(h, "POST", "/api/me/friends/accept", as("Alice"), { coach: "Bob" }).status).toBe(404); // not hers to accept
    expect(json(call(h, "POST", "/api/me/friends/accept", as("Bob"), { coach: "Alice" }))).toEqual({ relation: "friend" });
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).friends.map((r: any) => r.coach)).toEqual(["Bob"]);
    expect(json(call(h, "GET", "/api/me/friends", as("Bob"))).friends.map((r: any) => r.coach)).toEqual(["Alice"]);
    expect(h.notes.at(-1)).toMatchObject({ coach: "Alice", input: { title: "Bob accepted your friend request" } });
    expect(call(h, "DELETE", "/api/me/friends/Alice", as("Bob")).status).toBe(200);
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).friends).toEqual([]);
    expect(call(h, "DELETE", "/api/me/friends/Alice", as("Bob")).status).toBe(404);
  });

  it("decline drops only the request; cancel withdraws yours; crossing requests become friends", () => {
    const h = harness();
    call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Bob" });
    expect(call(h, "POST", "/api/me/friends/decline", as("Bob"), { coach: "Alice" }).status).toBe(200);
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).outgoing).toEqual([]);
    call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Carol" });
    expect(call(h, "DELETE", "/api/me/friends/Carol", as("Alice")).status).toBe(200);
    expect(json(call(h, "GET", "/api/me/friends", as("Carol"))).incoming).toEqual([]);
    call(h, "POST", "/api/me/friends/request", as("Dave"), { coach: "Erin" });
    expect(json(call(h, "POST", "/api/me/friends/request", as("Erin"), { coach: "Dave" }))).toEqual({ relation: "friend" });
  });

  it("refuses yourself, unknown coaches and deleted coaches; friends are on for everyone with no opt-in and no auto-friending", () => {
    const h = harness();
    expect(call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "alice" }).status).toBe(400);
    expect(call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Nobody" }).status).toBe(404);
    expect(call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Deleted coach #4" }).status).toBe(410);
    expect(call(h, "POST", "/api/me/friends/request", as("Alice"), {}).status).toBe(400);
    h.played.push({ home: { coach: "Alice" }, away: { coach: "Bob" } });
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).friends).toEqual([]); // played is a suggestion, not a friendship
  });
});

describe("People you know", () => {
  it("opponents from fork and tabletop results, newest first, one row per coach; never test, NAF, self or deleted rows", () => {
    const rows: PlayedRow[] = [
      { home: { coach: "Alice" }, away: { coach: "Bob" }, playedAt: "2026-10-01T00:00:00Z" },
      { home: { coach: "Carol" }, away: { coach: "alice" }, playedAt: "2026-10-05T00:00:00Z", source: "tabletop" },
      { home: { coach: "Alice" }, away: { coach: "Bob" }, playedAt: "2026-10-09T00:00:00Z" },
      { home: { coach: "Alice" }, away: { coach: "Dave" }, playedAt: "2026-10-10T00:00:00Z", test: true },
      { home: { coach: "Alice" }, away: { coach: "Erin" }, playedAt: "2026-10-10T00:00:00Z", source: "naf" },
      { home: { coach: "Alice" }, away: { coach: "Deleted coach #2" }, playedAt: "2026-10-11T00:00:00Z" },
      { home: { coach: "Bob" }, away: { coach: "Carol" }, playedAt: "2026-10-12T00:00:00Z" },
    ];
    expect(opponentsOf(rows, "ALICE")).toEqual([
      { coach: "Bob", lastPlayed: "2026-10-09T00:00:00Z", games: 2 },
      { coach: "Carol", lastPlayed: "2026-10-05T00:00:00Z", games: 1 },
    ]);
  });

  it("only coaches with an account who are not friends or pending; capped", () => {
    const h = harness();
    h.played.push(
      { home: { coach: "Alice" }, away: { coach: "Bob" }, playedAt: "2026-10-01T00:00:00Z" },
      { home: { coach: "Alice" }, away: { coach: "Carol" }, playedAt: "2026-10-02T00:00:00Z" },
      { home: { coach: "Alice" }, away: { coach: "NoAccount" }, playedAt: "2026-10-03T00:00:00Z" },
    );
    call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Carol" });
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).known.map((k: any) => k.coach)).toEqual(["Bob"]);
    const many = harness({ coach: (n) => n.trim() });
    for (let i = 0; i < KNOWN_LIMIT + 5; i += 1) many.played.push({ home: { coach: "Alice" }, away: { coach: `Coach${i}` }, playedAt: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z` });
    expect(json(call(many, "GET", "/api/me/friends", as("Alice"))).known).toHaveLength(KNOWN_LIMIT);
  });
});

describe("block effects", () => {
  it("a blocked coach cannot message you (403 'This coach is not accepting messages') or send friend requests", () => {
    const h = harness();
    expect(call(h, "POST", "/api/me/blocks", as("Alice"), { coach: "bob" }).status).toBe(200);
    expect(json(call(h, "GET", "/api/me/blocks", as("Alice"))).blocked.map((b: any) => b.coach)).toEqual(["Bob"]);
    const msg = call(h, "POST", "/api/me/threads", as("Bob"), { to: "Alice", text: "let me in" });
    expect(msg.status).toBe(403);
    expect(json(msg).error).toBe(NOT_ACCEPTING);
    const req = call(h, "POST", "/api/me/friends/request", as("Bob"), { coach: "Alice" });
    expect(req.status).toBe(403);
    expect(json(req).error).toBe(NOT_ACCEPTING_REQUESTS);
    // the blocker cannot write to them either until they unblock
    expect(json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "hi" })).error).toBe(YOU_BLOCKED);
    expect(h.notes).toEqual([]);
    expect(call(h, "DELETE", "/api/me/blocks/Bob", as("Alice")).status).toBe(200);
    expect(call(h, "POST", "/api/me/threads", as("Bob"), { to: "Alice", text: "thanks" }).status).toBe(201);
  });

  it("blocking in an existing thread: the thread stays readable, sending stops, and the view says why", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Bob"), { to: "Alice", text: "first" })).thread.id;
    call(h, "POST", "/api/me/blocks", as("Alice"), { coach: "Bob" });
    expect(call(h, "POST", `/api/me/threads/${id}`, as("Bob"), { text: "again" }).status).toBe(403);
    const bobView = json(call(h, "GET", `/api/me/threads/${id}`, as("Bob")));
    expect(bobView.thread).toMatchObject({ canSend: false, reason: NOT_ACCEPTING, blockedByMe: false });
    expect(json(call(h, "GET", `/api/me/threads/${id}`, as("Alice"))).thread).toMatchObject({ canSend: false, blockedByMe: true });
  });

  it("blocking removes the friendship and pending requests both ways, and hides each from the other's People you know", () => {
    const h = harness();
    call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Bob" });
    call(h, "POST", "/api/me/friends/accept", as("Bob"), { coach: "Alice" });
    call(h, "POST", "/api/me/friends/request", as("Carol"), { coach: "Alice" });
    call(h, "POST", "/api/me/blocks", as("Alice"), { coach: "Bob" });
    call(h, "POST", "/api/me/blocks", as("Alice"), { coach: "Carol" });
    expect(json(call(h, "GET", "/api/me/friends", as("Alice")))).toMatchObject({ friends: [], incoming: [], outgoing: [] });
    expect(json(call(h, "GET", "/api/me/friends", as("Bob"))).friends).toEqual([]);
    expect(json(call(h, "GET", "/api/me/friends", as("Carol"))).outgoing).toEqual([]);
    h.played.push({ home: { coach: "Alice" }, away: { coach: "Bob" } }, { home: { coach: "Alice" }, away: { coach: "Dave" } });
    expect(json(call(h, "GET", "/api/me/friends", as("Alice"))).known.map((k: any) => k.coach)).toEqual(["Dave"]); // the one she blocked is gone
    expect(json(call(h, "GET", "/api/me/friends", as("Bob"))).known).toEqual([]); // and Bob does not see her
  });

  it("a corrupt block list fails closed (500), never 'nobody blocked'", () => {
    const h = harness();
    mkdirSync(join(h.dir, "blocks"), { recursive: true });
    writeFileSync(join(h.dir, "blocks", socialFileName("Alice")), "{ not json", "utf8");
    expect(call(h, "POST", "/api/me/threads", as("Bob"), { to: "Alice", text: "hi" }).status).toBe(500);
  });

  it("organisers are exempt: a tournament message lands in the thread flagged ORGANISER even when blocked", () => {
    const h = harness();
    call(h, "POST", "/api/me/blocks", as("Alice"), { coach: "Bob" });
    appendOrganiserMessage(h.store, "Bob", "Alice", "Round 2 starts at 7 pm.", { kind: "tournament", id: "t1", name: "Spike Open" });
    const list = json(call(h, "GET", "/api/me/threads", as("Alice")));
    expect(list.threads[0]).toMatchObject({ with: "Bob", organiser: true, unread: 1 });
    const view = json(call(h, "GET", `/api/me/threads/${list.threads[0].id}`, as("Alice")));
    expect(view.messages[0]).toMatchObject({ text: "Round 2 starts at 7 pm.", organiser: { kind: "tournament", id: "t1", name: "Spike Open" } });
  });
});

describe("messages: send, read, unread counts, one notification per burst", () => {
  it("send creates one thread per pair; unread counts follow; reading clears them", () => {
    const h = harness();
    const first = call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "Game Saturday?" });
    expect(first.status).toBe(201);
    const id = json(first).thread.id;
    expect(json(first).created).toBe(true);
    // continuing by name reuses the thread
    expect(json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "bob", text: "Or Sunday." })).thread.id).toBe(id);
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Bob")))).toEqual({ unread: 2 });
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Alice")))).toEqual({ unread: 0 });
    const bobList = json(call(h, "GET", "/api/me/threads", as("Bob")));
    expect(bobList).toMatchObject({ unread: 2, threads: [{ id, with: "Alice", unread: 2, preview: "Or Sunday.", lastFromMe: false, deleted: false }] });
    const view = json(call(h, "GET", `/api/me/threads/${id}`, as("Bob")));
    expect(view.messages.map((m: any) => [m.from, m.text, m.mine])).toEqual([["Alice", "Game Saturday?", false], ["Alice", "Or Sunday.", false]]);
    // GET does not mark read; POST /read does
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Bob")))).toEqual({ unread: 2 });
    expect(json(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: 2 }))).toEqual({ unread: 0 });
    expect(call(h, "POST", `/api/me/threads/${id}`, as("Bob"), { text: "Saturday works." }).status).toBe(201);
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Alice")))).toEqual({ unread: 1 });
  });

  it("read marks only up to the last message the reader was shown; later messages stay unread; never moves back (Sol P2)", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "one" })).thread.id;
    call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "two" });
    // Bob's screen showed message 1 only; message 2 arrived while he was reading
    expect(json(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: 1 }))).toEqual({ unread: 1 });
    call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "three" });
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Bob")))).toEqual({ unread: 2 });
    expect(json(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: 0 }))).toEqual({ unread: 2 }); // no step back
    expect(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), {}).status).toBe(400);
    expect(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: "3" }).status).toBe(400);
    expect(json(call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: 99 }))).toEqual({ unread: 0 }); // clamped to the thread
    // the reader's own replies never count as unread for them
    call(h, "POST", `/api/me/threads/${id}`, as("Bob"), { text: "reply" });
    expect(json(call(h, "GET", "/api/me/threads/unread", as("Bob")))).toEqual({ unread: 0 });
  });

  it("an index-evicted thread is found again through the pair map: one thread per pair, row re-added on activity (Sol P2)", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "old thread" })).thread.id;
    // Alice's index at the cap without the Bob thread (what the cap leaves after 1000 newer conversations)
    const xf = join(h.dir, "messages", "index", socialFileName("Alice"));
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `t${(i + 1).toString(16).padStart(16, "0")}`, with: `C${i}`, lastAt: "2020-01-01T00:00:00.000Z", lastFrom: "Alice", preview: "", unread: 0 }));
    writeFileSync(xf, JSON.stringify({ version: 1, threads: rows }));
    expect(h.store.index("Alice").threads.some((t) => t.id === id)).toBe(false);
    expect(json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "still the same thread" })).thread.id).toBe(id);
    expect(h.store.index("Alice").threads[0]).toMatchObject({ id, with: "Bob" });
    expect(h.store.thread(id)!.messages.map((m) => m.text)).toEqual(["old thread", "still the same thread"]);
    // and from the other side by name
    expect(json(call(h, "POST", "/api/me/threads", as("Bob"), { to: "alice", text: "yes" })).thread.id).toBe(id);
  });

  it("notifies the recipient once per burst (first unread message), again only after they read", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "one" })).thread.id;
    call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "two" });
    call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "three" });
    expect(h.notes.map((n) => n.coach)).toEqual(["Bob"]);
    expect(h.notes[0]!.input).toMatchObject({ type: "private-message", title: "New message from Alice", body: "one", link: `/app/messages/${id}`, from: "Alice" });
    call(h, "POST", `/api/me/threads/${id}/read`, as("Bob"), { upTo: 3 });
    call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "four" });
    expect(h.notes).toHaveLength(2);
  });

  it("text only: length cap, empty refused, controls and bidi overrides stripped, markup stored as typed (rendered as text)", () => {
    const h = harness();
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "   " }).status).toBe(400);
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "x".repeat(2001) }).status).toBe(400);
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "😀".repeat(2000) }).status).toBe(201); // code points, not UTF-16 units
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: { html: "<b>" } }).status).toBe(400);
    const xss = `<img src=x onerror=alert(1)><script>alert("x")</script>`;
    const r = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: `${xss}‮\u0007\r\nline 2` }));
    expect(r.message.text).toBe(`${xss}\nline 2`);
    expect(cleanMessageText("a\n\n\n\n\n\nb")).toBe("a\n\n\nb");
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Alice", text: "me" }).status).toBe(400);
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Nobody", text: "hi" }).status).toBe(404);
  });

  it("caps a thread at 1000 messages (oldest dropped) and pages with ?before", () => {
    const h = harness();
    const r = h.store.append("Alice", "Bob", "m0");
    // seed the file near the cap (one write per append would make this slow), then append through the store
    const tf = join(h.dir, "messages", "threads", `${r.thread.id}.json`);
    const seeded = JSON.parse(readFileSync(tf, "utf8"));
    seeded.messages = Array.from({ length: THREAD_MESSAGE_CAP + 2 }, (_, i) => ({ id: i + 1, from: i % 2 ? "Bob" : "Alice", text: `m${i}`, at: "2026-10-01T00:00:00.000Z" }));
    seeded.seq = THREAD_MESSAGE_CAP + 2;
    writeFileSync(tf, JSON.stringify(seeded));
    for (let i = THREAD_MESSAGE_CAP + 2; i < THREAD_MESSAGE_CAP + 5; i += 1) h.store.append(i % 2 ? "Bob" : "Alice", i % 2 ? "Alice" : "Bob", `m${i}`);
    const t = h.store.thread(r.thread.id)!;
    expect(t.messages).toHaveLength(THREAD_MESSAGE_CAP);
    expect(t.messages[0]!.text).toBe("m5");
    const page = json(call(h, "GET", `/api/me/threads/${t.id}`, as("Alice"), undefined, "limit=10"));
    expect(page.messages).toHaveLength(10);
    expect(page.more).toBe(true);
    const older = json(call(h, "GET", `/api/me/threads/${t.id}`, as("Alice"), undefined, `before=${page.messages[0].id}&limit=10`));
    expect(older.messages.at(-1).id).toBe(page.messages[0].id - 1);
  });

  it("rate limits: 30 messages a minute, 20 new conversations an hour", () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    for (let i = 0; i < 30; i += 1) expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: `m${i}` }).status).toBe(201);
    const limited = call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "too many" });
    expect(limited.status).toBe(429);
    now += 61_000;
    expect(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "ok again" }).status).toBe(201);
    const lim = harness({ coach: (n) => n.trim(), limiters: { ...createSocialLimiters(), threads: new SenderRateLimiter(2, 60 * 60_000) } });
    expect(call(lim, "POST", "/api/me/threads", as("Alice"), { to: "C1", text: "hi" }).status).toBe(201);
    expect(call(lim, "POST", "/api/me/threads", as("Alice"), { to: "C2", text: "hi" }).status).toBe(201);
    expect(call(lim, "POST", "/api/me/threads", as("Alice"), { to: "C3", text: "hi" }).status).toBe(429);
    expect(call(lim, "POST", "/api/me/threads", as("Alice"), { to: "C1", text: "existing thread is fine" }).status).toBe(201);
  });
});

describe("deletion fence and deleted coaches", () => {
  it("a fenced coach cannot write; nobody can write into a fenced coach's files", () => {
    const h = harness({ isFenced: (c) => c.toLowerCase() === "bob" });
    fenceCoachHash(coachKeyHash("Carol"));
    expect(() => h.store.append("Carol", "Alice", "hi")).toThrow(/being deleted/);
    expect(() => h.store.request("Carol", "Alice")).toThrow(/being deleted/);
    expect(json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "hi" })).error).toBe(NOT_ACCEPTING);
    expect(call(h, "POST", "/api/me/friends/request", as("Alice"), { coach: "Bob" }).status).toBe(403);
    expect(existsSync(join(h.dir, "messages", "index", socialFileName("Carol")))).toBe(false);
  });

  it("a deleted coach's thread shows 'Deleted coach #n' and cannot be written to", () => {
    const h = harness();
    const id = json(call(h, "POST", "/api/me/threads", as("Alice"), { to: "Bob", text: "hi" })).thread.id;
    // what the delete job leaves behind (src/privacy/collectors.ts anonymise-messages)
    const tf = join(h.dir, "messages", "threads", `${id}.json`);
    const t = JSON.parse(readFileSync(tf, "utf8"));
    t.coaches = t.coaches.map((c: string) => (c === "Bob" ? "Deleted coach #3" : c));
    writeFileSync(tf, JSON.stringify(t));
    const xf = join(h.dir, "messages", "index", socialFileName("Alice"));
    const x = JSON.parse(readFileSync(xf, "utf8"));
    x.threads[0].with = "Deleted coach #3";
    writeFileSync(xf, JSON.stringify(x));
    const list = json(call(h, "GET", "/api/me/threads", as("Alice")));
    expect(list.threads[0]).toMatchObject({ with: "Deleted coach #3", deleted: true, avatar: null });
    expect(json(call(h, "GET", `/api/me/threads/${id}`, as("Alice"))).thread).toMatchObject({ with: "Deleted coach #3", deleted: true, canSend: false });
    expect(call(h, "POST", `/api/me/threads/${id}`, as("Alice"), { text: "hello?" }).status).toBe(410);
  });
});

describe("organiser Message coach -> thread", () => {
  it("the tournament message route also writes the organiser thread through the registered sink", () => {
    const dir = tmp();
    const t = { id: "t1", name: "Spike Open", ownerCoachId: "Bob", organizerCoachIds: [] } as never;
    const tournaments = { tournament: (id: string) => (id === "t1" ? t : undefined), entrants: () => [{ coach: { ffbCoachId: "Alice" } }] as never };
    const store = new SocialStore(dir);
    setOrganiserThreadSink((o, c, text, ctx) => appendOrganiserMessage(store, o, c, text, ctx));
    const res = notificationsApi("POST", "/api/tournaments/t1/message", new URLSearchParams(), { coach: "Bob", organizer: false, admin: true },
      { coachKey: "Alice", body: "See you there" }, { store: new NotificationStore(dir), tournaments });
    expect(res!.status).toBe(201);
    expect(store.index("Alice").threads[0]).toMatchObject({ with: "Bob", organiser: true, unread: 1 });
    expect(store.thread(store.index("Alice").threads[0]!.id)!.messages[0]).toMatchObject({ text: "See you there", organiser: { kind: "tournament", id: "t1", name: "Spike Open" } });
  });
});

beforeEach(() => clearFences());
