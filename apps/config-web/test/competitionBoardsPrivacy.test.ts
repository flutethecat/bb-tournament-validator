import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoardStore } from "../src/boards/board.js";
import { collectExport, deleteContext, DELETE_STEPS, splitPlan } from "../src/privacy/collectors.js";
import { depsFor } from "./privacyFixture.js";

// League / tournament board moderation data in the privacy export and delete (owner 11-04): posts, reports, mutes and log
// entries are exported; on delete the posts are anonymised, the coach's reports and the mutes on them go, and log entries
// and marks keep only the pseudonym. Fake names only; isolated state dir.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const P = "Deleted coach #9";
const S = "league:lg1";

function seed() {
  const root = mkdtempSync(join(tmpdir(), "cboards-privacy-"));
  roots.push(root);
  const deps = depsFor(root);
  const boards = new BoardStore(deps.stateDir);
  const t = boards.startThread(S, "Alice", "Alice's thread", "Hi from Alice");
  const r = boards.reply(S, t.id, "Bob", "Hello Alice");
  boards.report(S, r.id, "Alice", "Bob was rude to Alice");
  boards.report(S, t.id, "Bob", "Spam");
  boards.mute(S, "Alice", new Date(Date.now() + 3600_000), "Olga", "Cool off");
  boards.mute(S, "Bob", new Date(Date.now() + 3600_000), "Alice", "Alice's call");
  boards.moderate(S, t.id, "pin", "Alice", "");
  boards.moderate(S, r.id, "hide", "Olga", "Hidden for Alice");
  return { deps, t, r };
}

function ctxFor(deps: ReturnType<typeof depsFor>) {
  const plan = { jobId: "z".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: [], pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
  return deleteContext(deps, { ...splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: [] } as never);
}

describe("league / tournament boards in export and delete", () => {
  it("export carries the coach's posts, reports, the mutes on or by them and their log entries; never others' reports", async () => {
    const { deps } = seed();
    const files = new Map((await collectExport(deps, "Alice")).map((f) => [f.name, String(f.content)]));
    const posts = JSON.parse(files.get("club-board-posts.json")!);
    expect(posts).toEqual([expect.objectContaining({ board: S, text: "Hi from Alice" })]);
    const mod = JSON.parse(files.get("board-moderation.json")!);
    expect(mod.reports).toEqual([expect.objectContaining({ board: S, reason: "Bob was rude to Alice" })]);
    expect(mod.mutes.map((m: { coach: string }) => m.coach).sort()).toEqual(["Alice", "Bob"]);
    expect(mod.log.map((e: { action: string }) => e.action).sort()).toEqual(["mute", "mute", "pin"]);
    expect(files.get("board-moderation.json")).not.toContain("Spam");
  });

  it("delete anonymises posts, removes the coach's reports and the mutes on them, and pseudonymises log entries and marks", async () => {
    const { deps } = seed();
    for (const step of DELETE_STEPS.filter((s) => s.id === "club-boards")) await step.run(ctxFor(deps));
    const b = new BoardStore(deps.stateDir).read(S);
    expect(b.threads[0]!.author).toBe(P);
    expect(b.threads[0]!.pinned?.by).toBe(P);
    expect(b.threads[0]!.replies[0]!.text).toBe(`Hello ${P}`);
    expect(b.reports!.map((r) => r.reporter)).toEqual(["Bob"]);
    expect(Object.values(b.mutes!).map((m) => [m.coach, m.by, m.reason])).toEqual([["Bob", P, `${P}'s call`]]);
    expect(b.log!.every((e) => e.by !== "Alice" && e.coach !== "Alice")).toBe(true);
    expect(b.log!.find((e) => e.action === "hide")!.reason).toBe(`Hidden for ${P}`);
    expect(JSON.stringify(b)).not.toMatch(/Alice/);
  });
});
