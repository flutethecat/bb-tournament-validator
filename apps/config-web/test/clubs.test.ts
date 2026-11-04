import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../src/boards/board.js";
import { clubsApi, createClubsLimiters, isPublicClubRead, type ClubsApiDeps, type ClubsAuth } from "../src/clubs/api.js";
import { ClubStore } from "../src/clubs/store.js";
import type { ClubLedger } from "../src/clubs/stats.js";
import type { NotificationInput } from "../src/notifications.js";
import { starProfanity } from "../src/discord/profanity.js";

// Clubs (creation wizards v2 rounds 2-3): lifecycle (create, request, approve, leave, admins), multi-club membership,
// access control (public reads, admin-only management, members-only board), the board (threads, replies, edit / remove,
// moderation, coalesced notes) and the notifications. Each test has its own state dir (laws §C14); no real transport.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const ACCOUNTS = new Set(["ann", "ben", "cy", "dee", "eve", "fenced", "admin"]);
const SPELL: Record<string, string> = { ann: "Ann", ben: "Ben", cy: "Cy", dee: "Dee", eve: "Eve", fenced: "Fenced", admin: "SiteAdmin" };

function harness() {
  const root = mkdtempSync(join(tmpdir(), "bbtv-clubs-"));
  roots.push(root);
  const store = new ClubStore(root);
  const boards = new BoardStore(root);
  const sent: Array<{ coach: string; input: NotificationInput }> = [];
  const ledger: ClubLedger = { games: new Map(), honours: new Map(), picked: new Set() };
  const deps: ClubsApiDeps = {
    store, boards, ledger: () => ledger,
    coach: (n) => (ACCOUNTS.has(n.trim().toLowerCase()) ? SPELL[n.trim().toLowerCase()] : undefined),
    notify: (coach, input) => { sent.push({ coach, input }); },
    isFenced: (c) => c.toLowerCase() === "fenced",
    limiters: createClubsLimiters(),
  };
  const as = (coach: string, extra: Partial<ClubsAuth> = {}): ClubsAuth => ({ coach, ...extra });
  const call = async (method: string, path: string, auth?: ClubsAuth, body?: unknown, q = "") => (await clubsApi(method, path, new URLSearchParams(q), auth, body, deps))!;
  const create = async (name = "Grudge Rollers", by = "Ann") => {
    const r = await call("POST", "/api/clubs", as(by), { name, homeRegion: "North Coast", description: "We roll grudges." });
    expect(r.status).toBe(201);
    return (r.body as { club: { id: string; revision: number } }).club;
  };
  const join_ = async (id: string, who: string, admin = "Ann") => {
    expect((await call("POST", `/api/clubs/${id}/requests`, as(who), { message: "Let me in" })).status).toBe(201);
    expect((await call("POST", `/api/clubs/${id}/requests/${who}/approve`, as(admin))).status).toBe(200);
  };
  return { root, store, boards, sent, ledger, deps, as, call, create, join: join_ };
}

describe("club lifecycle", () => {
  it("creates a club with the creator as admin, a slug id and the defaults; names are unique", async () => {
    const h = harness();
    const club = await h.create();
    expect(club.id).toBe("grudge-rollers");
    const rec = h.store.get(club.id)!;
    expect(rec.members).toEqual([{ coach: "Ann", role: "admin", joinedAt: expect.any(String) }]);
    expect(rec.settings).toEqual({ ladderGamesCount: false, webhookEvents: { results: true, podiums: true, titles: true } });
    expect((await h.call("POST", "/api/clubs", h.as("Ben"), { name: "grudge  ROLLERS" })).status).toBe(409);
    expect((await h.call("POST", "/api/clubs", h.as("Ben"), { name: "x" })).status).toBe(400);
    expect((await h.call("POST", "/api/clubs", h.as("Ben"), { name: "Fine Club", extra: 1 })).status).toBe(400);
    expect((await h.call("POST", "/api/clubs", undefined, { name: "Anon Club" })).status).toBe(401);
    expect((await h.call("POST", "/api/clubs", h.as("Ben", { test: true }), { name: "Test Club" })).status).toBe(403);
    expect((await h.call("POST", "/api/clubs", h.as("Nobody"), { name: "Ghost Club" })).status).toBe(403);
    expect((await h.call("POST", "/api/clubs", h.as("Fenced"), { name: "Fenced Club" })).status).toBe(410);
  });

  it("join request -> admins told; approve -> member, coach told; decline and cancel; leave keeps history", async () => {
    const h = harness();
    const club = await h.create();
    const req = await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Ben"), { message: "Hi there" });
    expect(req.status).toBe(201);
    expect(h.sent.map((s) => [s.coach, s.input.type, s.input.link])).toEqual([["Ann", "club", "/app/clubs/grudge-rollers/manage"]]);
    // idempotent while pending; a member can't ask; only admins approve
    expect((await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Ben"))).status).toBe(200);
    expect(h.store.get(club.id)!.requests).toHaveLength(1);
    expect((await h.call("POST", `/api/clubs/${club.id}/requests/Ben/approve`, h.as("Cy"))).status).toBe(403);
    expect((await h.call("POST", `/api/clubs/${club.id}/requests/Ben/approve`, h.as("Ann"))).status).toBe(200);
    expect(h.store.get(club.id)!.members.map((m) => [m.coach, m.role])).toEqual([["Ann", "admin"], ["Ben", "member"]]);
    expect(h.sent.at(-1)).toMatchObject({ coach: "Ben", input: { type: "club", title: "Welcome to Grudge Rollers" } });
    expect((await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Ben"))).status).toBe(409);
    // decline
    await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Cy"));
    expect((await h.call("POST", `/api/clubs/${club.id}/requests/cy/decline`, h.as("Ann"))).status).toBe(200);
    expect(h.sent.at(-1)).toMatchObject({ coach: "Cy", input: { title: "Grudge Rollers declined your request" } });
    expect(h.store.get(club.id)!.members.some((m) => m.coach === "Cy")).toBe(false);
    // cancel your own request
    await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Dee"));
    expect((await h.call("POST", `/api/clubs/${club.id}/requests/cancel`, h.as("Dee"))).status).toBe(200);
    expect(h.store.get(club.id)!.requests).toEqual([]);
    // leave: a former-member row (history stays)
    expect((await h.call("POST", `/api/clubs/${club.id}/leave`, h.as("Ben"))).status).toBe(200);
    expect(h.store.get(club.id)!.former).toEqual([{ coach: "Ben", joinedAt: expect.any(String), leftAt: expect.any(String), reason: "left" }]);
  });

  it("admin roles: the last admin can't leave or step down; admins promote, demote and remove members", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    await h.join(club.id, "Cy");
    expect((await h.call("POST", `/api/clubs/${club.id}/leave`, h.as("Ann"))).body).toMatchObject({ code: "last-admin" });
    expect((await h.call("POST", `/api/clubs/${club.id}/members/Ann/role`, h.as("Ann"), { role: "member" })).status).toBe(409);
    expect((await h.call("POST", `/api/clubs/${club.id}/members/Ben/role`, h.as("Cy"), { role: "admin" })).status).toBe(403);
    expect((await h.call("POST", `/api/clubs/${club.id}/members/Ben/role`, h.as("Ann"), { role: "admin" })).status).toBe(200);
    expect(h.sent.at(-1)).toMatchObject({ coach: "Ben", input: { title: "You are now an admin of Grudge Rollers" } });
    // an admin can't be removed until demoted; members can
    expect((await h.call("POST", `/api/clubs/${club.id}/members/Ann/remove`, h.as("Ben"))).body).toMatchObject({ code: "admin" });
    expect((await h.call("POST", `/api/clubs/${club.id}/members/Cy/remove`, h.as("Ben"))).status).toBe(200);
    expect(h.store.get(club.id)!.former.at(-1)).toMatchObject({ coach: "Cy", reason: "removed" });
    // now Ann may leave (Ben is admin)
    expect((await h.call("POST", `/api/clubs/${club.id}/leave`, h.as("Ann"))).status).toBe(200);
    expect(h.store.get(club.id)!.members.map((m) => [m.coach, m.role])).toEqual([["Ben", "admin"]]);
    // the last member leaving archives the club
    expect((await h.call("POST", `/api/clubs/${club.id}/leave`, h.as("Ben"))).status).toBe(200);
    expect(h.store.get(club.id)!.archivedAt).toEqual(expect.any(String));
    expect((await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Dee"))).body).toMatchObject({ code: "archived" });
  });

  it("edit (admins, revision checked), delete only without members, archive when history exists", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    const rev = h.store.get(club.id)!.revision;
    expect((await h.call("PATCH", `/api/clubs/${club.id}`, h.as("Ben"), { revision: rev, name: "Ben's" })).status).toBe(403);
    expect((await h.call("PATCH", `/api/clubs/${club.id}`, h.as("Ann"), { name: "New" })).status).toBe(428);
    expect((await h.call("PATCH", `/api/clubs/${club.id}`, h.as("Ann"), { revision: rev - 1, name: "New" })).status).toBe(409);
    const ok = await h.call("PATCH", `/api/clubs/${club.id}`, h.as("Ann"), { revision: rev, description: "Updated", ladderGamesCount: true, webhookEvents: { podiums: false } });
    expect(ok.status).toBe(200);
    expect(h.store.get(club.id)!.settings).toEqual({ ladderGamesCount: true, webhookEvents: { results: true, podiums: false, titles: true } });
    // delete refused while a non-admin member is in
    expect((await h.call("DELETE", `/api/clubs/${club.id}`, h.as("Ann"))).body).toMatchObject({ code: "members" });
    await h.call("POST", `/api/clubs/${club.id}/members/Ben/remove`, h.as("Ann"));
    // history (a competition entry names the club): archived, not deleted
    h.ledger.picked.add(club.id);
    expect((await h.call("DELETE", `/api/clubs/${club.id}`, h.as("Ann"))).body).toMatchObject({ archived: true });
    expect(h.store.get(club.id)).toBeDefined();
    // a club without history goes, its board with it
    const other = await h.create("Empty Club", "Cy");
    await h.call("POST", `/api/clubs/${other.id}/board`, h.as("Cy"), { title: "Hello", text: "First" });
    expect((await h.call("DELETE", `/api/clubs/${other.id}`, h.as("Cy"))).body).toMatchObject({ deleted: true });
    expect(h.store.get(other.id)).toBeUndefined();
    expect(existsSync(join(h.root, "boards")) ? readdirSync(join(h.root, "boards")) : []).toEqual([]);
  });
});

describe("multi-club membership", () => {
  it("a coach can be in several clubs; /api/me/clubs lists them (the join sheets' pick) and pending requests", async () => {
    const h = harness();
    const a = await h.create("Alpha Club", "Ann");
    const b = await h.create("Beta Club", "Ben");
    const c = await h.create("Gamma Club", "Cy");
    await h.join(a.id, "Dee", "Ann");
    await h.join(b.id, "Dee", "Ben");
    await h.call("POST", `/api/clubs/${c.id}/requests`, h.as("Dee"));
    const mine = await h.call("GET", "/api/me/clubs", h.as("Dee"));
    expect(mine.body).toEqual({ clubs: [{ id: a.id, name: "Alpha Club", role: "member" }, { id: b.id, name: "Beta Club", role: "member" }], requests: [{ id: c.id, name: "Gamma Club" }] });
    expect((await h.call("GET", "/api/me/clubs")).status).toBe(401);
    expect(h.store.membershipsOf("DEE").map((x) => x.id)).toEqual([a.id, b.id]);
  });
});

describe("access control and privacy", () => {
  it("directory, club page and stats are public; requests, the webhook and the board are not", async () => {
    const h = harness();
    const club = await h.create();
    await h.call("POST", `/api/clubs/${club.id}/requests`, h.as("Ben"), { message: "secret note" });
    const dir = await h.call("GET", "/api/clubs", undefined, undefined, "q=north");
    expect(dir.body).toMatchObject({ clubs: [{ id: club.id, name: "Grudge Rollers", memberCount: 1 }], total: 1 });
    expect(((await h.call("GET", "/api/clubs", undefined, undefined, "q=zzz")).body as { total: number }).total).toBe(0);
    const page = await h.call("GET", `/api/clubs/${club.id}`);
    expect(page.status).toBe(200);
    const text = JSON.stringify(page.body);
    expect(text).not.toContain("secret note");
    expect(text).not.toContain("requests");
    expect((page.body as { club: { members: unknown[] } }).club.members).toEqual([{ coach: "Ann", role: "admin", joinedAt: expect.any(String) }]);
    expect((await h.call("GET", `/api/clubs/${club.id}/stats`)).status).toBe(200);
    // management: admins only
    expect((await h.call("GET", `/api/clubs/${club.id}/manage`)).status).toBe(401);
    expect((await h.call("GET", `/api/clubs/${club.id}/manage`, h.as("Ben"))).status).toBe(403);
    const manage = await h.call("GET", `/api/clubs/${club.id}/manage`, h.as("Ann"));
    expect(manage.body).toMatchObject({ requests: [{ coach: "Ben", message: "secret note" }], webhook: { configured: false, maskedUrl: "" } });
    expect((await h.call("GET", `/api/clubs/${club.id}/manage`, h.as("SiteAdmin", { admin: true }))).status).toBe(200);
    // the board is for members
    expect((await h.call("GET", `/api/clubs/${club.id}/board`)).status).toBe(401);
    expect((await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ben"))).body).toMatchObject({ code: "members-only" });
    expect((await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ann"))).status).toBe(200);
    // only the read routes are public
    expect(isPublicClubRead("GET", "/api/clubs")).toBe(true);
    expect(isPublicClubRead("GET", `/api/clubs/${club.id}`)).toBe(true);
    expect(isPublicClubRead("GET", `/api/clubs/${club.id}/stats`)).toBe(true);
    expect(isPublicClubRead("GET", `/api/clubs/${club.id}/board`)).toBe(false);
    expect(isPublicClubRead("GET", `/api/clubs/${club.id}/manage`)).toBe(false);
    expect(isPublicClubRead("POST", "/api/clubs")).toBe(false);
  });

  it("the webhook URL is stored server-side and only ever answered masked; bad URLs are refused", async () => {
    const h = harness();
    const club = await h.create();
    const url = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz0123";
    expect((await h.call("PUT", `/api/clubs/${club.id}/webhook`, h.as("Ann"), { url: "https://example.com/hook" })).status).toBe(400);
    expect((await h.call("PUT", `/api/clubs/${club.id}/webhook`, h.as("Ben"), { url })).status).toBe(403);
    const r = await h.call("PUT", `/api/clubs/${club.id}/webhook`, h.as("Ann"), { url });
    expect(r.body).toMatchObject({ webhook: { configured: true, maskedUrl: "https://discord.com/api/webhooks/…/•••" } });
    expect(JSON.stringify(r.body)).not.toContain("abcdefghij");
    expect(JSON.stringify((await h.call("GET", `/api/clubs/${club.id}`, h.as("Ann"))).body)).not.toContain("webhooks");
    expect(h.store.webhook(club.id)).toBe(url);
    expect(readFileSync(join(h.root, "clubs", "clubs.json"), "utf8")).not.toContain("abcdefghij");
    await h.call("PUT", `/api/clubs/${club.id}/webhook`, h.as("Ann"), { url: null });
    expect(h.store.webhook(club.id)).toBeUndefined();
  });

  it("a corrupt clubs file fails closed (500), never reads as empty", async () => {
    const h = harness();
    await h.create();
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(h.root, "clubs", "clubs.json"), "{not json", "utf8");
    expect((await h.call("GET", "/api/clubs")).status).toBe(500);
    expect((await h.call("POST", "/api/clubs/grudge-rollers/requests", h.as("Ben"))).status).toBe(500);
  });
});

describe("member notification opt-ins", () => {
  it("both opt-ins start off; a member sets their own; non-members can't", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    const before = await h.call("GET", `/api/clubs/${club.id}`, h.as("Ben"));
    expect(before.body).toMatchObject({ me: { member: true, role: "member", notify: { wins: false, board: false } } });
    const r = await h.call("POST", `/api/clubs/${club.id}/notify`, h.as("Ben"), { wins: true });
    expect(r.body).toMatchObject({ me: { notify: { wins: true, board: false } } });
    expect((await h.call("POST", `/api/clubs/${club.id}/notify`, h.as("Cy"), { wins: true })).status).toBe(409);
    expect((await h.call("POST", `/api/clubs/${club.id}/notify`, h.as("Ben"), { wins: "yes" })).status).toBe(400);
  });
});

describe("club board", () => {
  it("members post threads and replies, edit their own, remove their own; admins moderate; archived clubs are read-only", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    await h.join(club.id, "Cy");
    const t = await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Ben"), { title: "Saturday", text: "Who is in?" });
    expect(t.status).toBe(201);
    const threadId = (t.body as { thread: { id: string } }).thread.id;
    expect((await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Ben"), { title: "", text: "x" })).status).toBe(400);
    expect((await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Dee"), { title: "Hi", text: "x" })).status).toBe(403);
    const reply = await h.call("POST", `/api/clubs/${club.id}/board/${threadId}/replies`, h.as("Cy"), { text: "Me!" });
    const replyId = (reply.body as { reply: { id: string } }).reply.id;
    // only the author edits
    expect((await h.call("PATCH", `/api/clubs/${club.id}/board/${replyId}`, h.as("Ben"), { text: "hacked" })).status).toBe(403);
    expect((await h.call("PATCH", `/api/clubs/${club.id}/board/${replyId}`, h.as("Cy"), { text: "Me too" })).status).toBe(200);
    // a member can't remove someone else's post; an admin can (moderation)
    expect((await h.call("DELETE", `/api/clubs/${club.id}/board/${replyId}`, h.as("Ben"))).status).toBe(403);
    const mod = await h.call("DELETE", `/api/clubs/${club.id}/board/${replyId}`, h.as("Ann"));
    const view = (mod.body as { board: { threads: Array<{ title: string; mine: boolean; replies: Array<{ text: string; removed?: { by: string } }> }> } }).board;
    expect(view.threads[0]!.replies[0]).toMatchObject({ text: "", removed: { by: "moderator" } });
    // the viewer's flags
    const seen = await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ben"));
    expect(seen.body).toMatchObject({ canPost: true, canModerate: false, threads: [{ title: "Saturday", mine: true, canEdit: true, canRemove: true }] });
    // GET never marks seen; POST .../seen does
    expect((seen.body as { seenAt?: string }).seenAt).toBeUndefined();
    expect((await h.call("POST", `/api/clubs/${club.id}/board/seen`, h.as("Ben"))).status).toBe(204);
    expect(((await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ben"))).body as { seenAt?: string }).seenAt).toEqual(expect.any(String));
    // archived: read-only
    h.store.update(club.id, (c) => { c.archivedAt = "2026-11-03T00:00:00.000Z"; });
    expect((await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Ben"), { title: "Late", text: "x" })).status).toBe(403);
    expect((await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ben"))).status).toBe(200);
  });

  it("text is stored as written; the profanity filter only changes what a viewer sees", async () => {
    const h = harness();
    const club = await h.create();
    const rude = "this is shit";
    await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Ann"), { title: "Rant", text: rude });
    const view = (await h.call("GET", `/api/clubs/${club.id}/board`, h.as("Ann"))).body as { threads: Array<{ text: string }> };
    expect(view.threads[0]!.text).toBe(rude);
    expect(starProfanity(view.threads[0]!.text)).toBe("this is ***");
  });

  it("new-post notes go to members who opted in, coalesced until they open the board, never the author, never the text", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    await h.join(club.id, "Cy");
    await h.call("POST", `/api/clubs/${club.id}/notify`, h.as("Ben"), { board: true });
    h.sent.length = 0;
    const t = await h.call("POST", `/api/clubs/${club.id}/board`, h.as("Cy"), { title: "One", text: "private words" });
    const id = (t.body as { thread: { id: string } }).thread.id;
    await h.call("POST", `/api/clubs/${club.id}/board/${id}/replies`, h.as("Cy"), { text: "two" });
    expect(h.sent.map((s) => [s.coach, s.input.title])).toEqual([["Ben", "New posts on the Grudge Rollers board"]]);
    expect(JSON.stringify(h.sent)).not.toContain("private words");
    // Ben opens the board: the next post tells him again; his own post never does
    await h.call("POST", `/api/clubs/${club.id}/board/seen`, h.as("Ben"));
    await h.call("POST", `/api/clubs/${club.id}/board/${id}/replies`, h.as("Ben"), { text: "mine" });
    expect(h.sent).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    await h.call("POST", `/api/clubs/${club.id}/board/${id}/replies`, h.as("Cy"), { text: "three" });
    expect(h.sent).toHaveLength(2);
  });
});

describe("crest upload", () => {
  it("takes the league-logo image rules, admins only, served from the public crest route", async () => {
    const h = harness();
    const club = await h.create();
    const png = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "latin1"); png.writeUInt32BE(128, 16); png.writeUInt32BE(128, 20);
    const put = (who: string, bytes: Buffer) => clubsApi("PUT", `/api/clubs/${club.id}/crest`, new URLSearchParams(), h.as(who), undefined, { ...h.deps, readRaw: async () => bytes });
    expect((await put("Ben", png))!.status).toBe(403);
    expect((await put("Ann", Buffer.from("not an image")))!.status).toBe(400);
    const ok = await put("Ann", png);
    expect(ok!.status).toBe(200);
    expect((ok!.body as { crestUrl: string }).crestUrl).toMatch(/^\/api\/clubs\/grudge-rollers\/crest\?v=/);
    const get = await h.call("GET", `/api/clubs/${club.id}/crest`);
    expect(get.file?.contentType).toBe("image/png");
    expect(readFileSync(get.file!.path).equals(png)).toBe(true);
    expect((await h.call("DELETE", `/api/clubs/${club.id}/crest`, h.as("Ann"))).status).toBe(204);
    expect((await h.call("GET", `/api/clubs/${club.id}/crest`)).status).toBe(404);
  });
});

describe("review fixes", () => {
  it("a legacy accepted entry is fixed: a log that only shows leaving accepted, a league row that made its team, a field entry", async () => {
    const { everAccepted, priorClubEntry, resolveClubPick } = await import("../src/clubs/pick.js");
    expect(everAccepted("withdrawn", [{ from: "accepted", to: "withdrawn" }])).toBe(true);
    expect(everAccepted("withdrawn", [], true)).toBe(true);
    expect(everAccepted("withdrawn", [{ from: "pending", to: "withdrawn" }])).toBe(false);
    const rows = [{ coach: "Ann", clubId: "red", state: "dropped", teamId: "t-ann", registrationLog: [] }];
    expect(priorClubEntry(rows, "ann")).toEqual({ clubId: "red", everAccepted: true });
    expect(resolveClubPick("Ann", "blue", priorClubEntry(rows, "Ann"))).toMatchObject({ ok: false, code: "club-fixed" });
  });

  it("a crest upload re-checks the admin right after the body is read (demoted meanwhile: 403, nothing stored)", async () => {
    const h = harness();
    const club = await h.create();
    await h.join(club.id, "Ben");
    await h.call("POST", `/api/clubs/${club.id}/members/Ben/role`, h.as("Ann"), { role: "admin" });
    const png = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8); png.write("IHDR", 12, "latin1"); png.writeUInt32BE(128, 16); png.writeUInt32BE(128, 20);
    // Ben is demoted while his upload body is still arriving
    const r = await clubsApi("PUT", `/api/clubs/${club.id}/crest`, new URLSearchParams(), h.as("Ben"), undefined, {
      ...h.deps, readRaw: async () => { h.store.update(club.id, (c) => { c.members.find((m) => m.coach === "Ben")!.role = "member"; }); return png; },
    });
    expect(r!.status).toBe(403);
    expect(h.store.get(club.id)!.crestPath).toBeUndefined();
    expect(existsSync(join(h.root, "clubs", "crests")) ? readdirSync(join(h.root, "clubs", "crests")) : []).toEqual([]);
    // the session ended meanwhile
    const gone = await clubsApi("PUT", `/api/clubs/${club.id}/crest`, new URLSearchParams(), h.as("Ann"), undefined, { ...h.deps, readRaw: async () => png, recheck: () => undefined });
    expect(gone!.status).toBe(401);
  });

  it("delete fails closed when a competition file can't be read (503, the club stays); a strict scan finds picks", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { clubHasHistory } = await import("../src/clubs/stats.js");
    const h = harness();
    const club = await h.create();
    const dirs = { stateDir: h.root, tournamentsDir: join(h.root, "tournaments") };
    const deps = { ...h.deps, history: (id: string) => clubHasHistory(dirs, id) };
    mkdirSync(join(h.root, "leagues", "lg", "seasons"), { recursive: true });
    writeFileSync(join(h.root, "leagues", "lg", "seasons", "season-1.json"), "{broken", "utf8");
    const r = await clubsApi("DELETE", `/api/clubs/${club.id}`, new URLSearchParams(), h.as("Ann"), {}, deps);
    expect(r!.status).toBe(503);
    expect(h.store.get(club.id)).toBeDefined();
    writeFileSync(join(h.root, "leagues", "lg", "seasons", "season-1.json"), JSON.stringify({ registrations: [{ coach: "Ann", clubId: club.id }] }), "utf8");
    expect(clubHasHistory(dirs, club.id)).toBe(true);
    expect((await clubsApi("DELETE", `/api/clubs/${club.id}`, new URLSearchParams(), h.as("Ann"), {}, deps))!.body).toMatchObject({ archived: true });
    writeFileSync(join(h.root, "leagues", "lg", "seasons", "season-1.json"), JSON.stringify({ registrations: [] }), "utf8");
    expect(clubHasHistory(dirs, club.id)).toBe(false);
  });

  it("connecting a webhook stamps the connection and asks the observer to baseline; removing clears the stamp", async () => {
    const h = harness();
    const club = await h.create();
    const seen: string[] = [];
    const deps = { ...h.deps, webhookConnected: (c: { webhookConnectedAt?: string }) => { seen.push(c.webhookConnectedAt ?? ""); } };
    const url = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz0123";
    await clubsApi("PUT", `/api/clubs/${club.id}/webhook`, new URLSearchParams(), h.as("Ann"), { url }, deps);
    expect(seen).toHaveLength(1);
    expect(h.store.get(club.id)!.webhookConnectedAt).toBe(seen[0]);
    await clubsApi("PUT", `/api/clubs/${club.id}/webhook`, new URLSearchParams(), h.as("Ann"), { url }, deps);
    expect(seen).toHaveLength(1); // same URL: no new connection
    await clubsApi("PUT", `/api/clubs/${club.id}/webhook`, new URLSearchParams(), h.as("Ann"), { url: null }, deps);
    expect(h.store.get(club.id)!.webhookConnectedAt).toBeUndefined();
  });
});
