import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../src/boards/board.js";
import { ClubStore } from "../src/clubs/store.js";
import { collectExport, deleteContext, DELETE_STEPS, splitPlan, STORE_COLLECTORS } from "../src/privacy/collectors.js";
import { depsFor } from "./privacyFixture.js";

// Export / delete cover clubs (memberships, requests, former rows, creator), club picks on entries and board posts
// (anonymised on delete, never erased). Fake names only; isolated state dir.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const P = "Deleted coach #7";

function seed() {
  const root = mkdtempSync(join(tmpdir(), "clubs-privacy-"));
  roots.push(root);
  const deps = depsFor(root);
  const clubs = new ClubStore(deps.stateDir);
  const boards = new BoardStore(deps.stateDir);
  const a = clubs.create({ name: "Alice Club", homeRegion: "", description: "", createdBy: "Alice" });
  clubs.update(a.id, (c) => { c.members.push({ coach: "Bob", role: "member", joinedAt: "2026-11-02T00:00:00.000Z" }, { coach: "Carol", role: "member", joinedAt: "2026-11-01T00:00:00.000Z" }); });
  const b = clubs.create({ name: "Bob Club", homeRegion: "", description: "", createdBy: "Bob" });
  clubs.update(b.id, (c) => { c.requests.push({ coach: "Alice", at: "2026-11-02T00:00:00.000Z", message: "let Alice in" }); c.former.push({ coach: "Alice", joinedAt: "x", leftAt: "y", reason: "left" }); });
  clubs.setWebhook(a.id, "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz0123");
  const t = boards.startThread(`club:${a.id}`, "Alice", "Alice's thread", "Hi from Alice");
  boards.reply(`club:${a.id}`, t.id, "Bob", "Hello Alice");
  boards.markSeen(`club:${a.id}`, "Alice");
  mkdirSync(deps.tournamentsDir, { recursive: true });
  writeFileSync(join(deps.tournamentsDir, "tournaments.json"), JSON.stringify({ version: 4, tournaments: {}, entrants: {
    e1: { id: "e1", tournamentId: "t1", seed: 1, coach: { coachId: "Alice", ffbCoachId: "Alice", verifiedAt: "" }, teamId: "", registeredAt: "", clubId: a.id },
    e2: { id: "e2", tournamentId: "t1", seed: 2, coach: { coachId: "Bob", ffbCoachId: "Bob", verifiedAt: "" }, teamId: "", registeredAt: "", clubId: b.id },
  }, rounds: {}, standings: {}, scheduledMatches: {}, waitingPresence: {} }), "utf8");
  return { root, deps, clubs, boards, a, b };
}

describe("clubs in export and delete", () => {
  it("the registry covers the new stores", () => {
    expect(STORE_COLLECTORS.map((c) => c.id)).toEqual(expect.arrayContaining(["clubs", "club-boards"]));
  });

  it("export carries the coach's memberships, requests, former rows, created clubs, picks and posts; never others' or the webhook", async () => {
    const { deps, a, b } = seed();
    const files = new Map((await collectExport(deps, "Alice")).map((f) => [f.name, String(f.content)]));
    const clubs = JSON.parse(files.get("clubs.json")!);
    expect(clubs.memberships).toEqual([{ club: a.id, name: "Alice Club", role: "admin", joinedAt: expect.any(String), notify: {} }]);
    expect(clubs.requests).toEqual([{ club: b.id, name: "Bob Club", at: expect.any(String), message: "let Alice in" }]);
    expect(clubs.former).toHaveLength(1);
    expect(clubs.created).toEqual([{ club: a.id, name: "Alice Club", createdAt: expect.any(String) }]);
    expect(clubs.picks).toEqual([{ kind: "tournament", competition: "t1", entry: "e1", club: a.id }]);
    const posts = JSON.parse(files.get("club-board-posts.json")!);
    expect(posts.map((p: { text: string }) => p.text)).toEqual(["Hi from Alice"]);
    expect([...files.values()].join("\n")).not.toContain("abcdefghij");
  });

  it("delete drops memberships and requests, hands admin on, anonymises former rows, creator and board posts", async () => {
    const { deps, a, b } = seed();
    const plan = { jobId: "x".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: [], pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
    const ctx = deleteContext(deps, { ...splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: [] } as never);
    for (const step of DELETE_STEPS.filter((s) => s.id === "clubs" || s.id === "club-boards")) await step.run(ctx);
    const store = new ClubStore(deps.stateDir);
    const ca = store.get(a.id)!;
    expect(ca.members.map((m) => [m.coach, m.role])).toEqual([["Bob", "member"], ["Carol", "admin"]]);
    expect(ca.createdBy).toBe(P);
    const cb = store.get(b.id)!;
    expect(cb.requests).toEqual([]);
    expect(cb.former.map((f) => f.coach)).toEqual([P]);
    const board = new BoardStore(deps.stateDir).read(`club:${a.id}`);
    expect(board.threads[0]!.author).toBe(P);
    expect(board.threads[0]!.replies[0]!.author).toBe("Bob");
    expect(board.seen).toEqual({});
    const all = readFileSync(join(deps.stateDir, "clubs", "clubs.json"), "utf8") + JSON.stringify(board);
    expect(all).not.toMatch(/"Alice"/);
  });
});

describe("review fix: identifying text on deletion", () => {
  it("removes the coach's own requests, anonymises mentions in descriptions, others' request notes and board posts, flags their clubs", async () => {
    const { deps, clubs, boards, a, b } = seed();
    clubs.update(a.id, (c) => { c.description = "Founded by Alice in 2026."; c.requests.push({ coach: "Dave", at: "x", message: "Alice told me to ask" }); });
    boards.startThread(`club:${b.id}`, "Bob", "Thanks", "Thanks Alice for the dice");
    const plan = { jobId: "y".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: [], pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
    const ctx = deleteContext(deps, { ...splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: [] } as never);
    for (const step of DELETE_STEPS.filter((s) => s.id === "clubs" || s.id === "club-boards")) await step.run(ctx);
    const store = new ClubStore(deps.stateDir);
    const ca = store.get(a.id)!;
    expect(ca.description).toBe(`Founded by ${P} in 2026.`);
    expect(ca.requests).toEqual([{ coach: "Dave", at: "x", message: `${P} told me to ask` }]);
    expect(ca.review).toEqual({ reason: "creator-deleted", at: expect.any(String) });
    const cb = store.get(b.id)!;
    expect(cb.requests.some((r) => r.coach === "Alice")).toBe(false);
    expect(cb.review).toBeUndefined();
    expect(new BoardStore(deps.stateDir).read(`club:${b.id}`).threads[0]!.text).toBe(`Thanks ${P} for the dice`);
  });
});
