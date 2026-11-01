import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectExport, INVENTORY_ROWS, KNOWN_STORES, STORE_COLLECTORS } from "../src/privacy/collectors.js";
import { PrivacyService } from "../src/privacy/service.js";
import { clearFences } from "../src/privacy/fence.js";
import { setResultCoachFilter } from "../src/tournamentResults.js";
import { setNafIdFilter } from "../src/nafRecords.js";
import { setReplayCoachFilter } from "../src/replay/store.js";
import { SocialStore, socialFileName } from "../src/social/store.js";
import { INVENTORY } from "../spa/src/privacy/inventory";
import { depsFor, filesContaining, seed } from "./privacyFixture.js";

// Friends, messages and blocks in the privacy export and the delete / anonymise job (privacy spec §2, §3; laws §E26).

const roots: string[] = [];
const prevIdentities = process.env.IDENTITIES_FILE;
let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "social-privacy-"));
  roots.push(root);
  process.env.IDENTITIES_FILE = join(root, "identities.json");
  clearFences();
});
afterEach(() => {
  if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities;
  setResultCoachFilter(undefined);
  setNafIdFilter(undefined);
  setReplayCoachFilter(undefined);
  clearFences();
});
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const readJ = (p: string) => JSON.parse(readFileSync(p, "utf8"));

function seedSocial(stateDir: string) {
  const s = new SocialStore(stateDir);
  s.request("Alice", "Bob");
  s.accept("Bob", "Alice");
  s.request("Carol", "Alice");
  s.block("Bob", "Carol");
  s.block("Carol", "Dave");
  s.block("Erin", "Alice");
  const ab = s.append("Alice", "Bob", "Hi Bob, Alice here.").thread.id;
  s.append("Bob", "Alice", "Hello Alice!");
  const bc = s.append("Bob", "Carol", "Private between Bob and Carol").thread.id;
  return { s, ab, bc };
}

describe("registry", () => {
  it("friends, blocks and messages each have a collector, an inventory row and a delete step; every social dir is covered", () => {
    for (const id of ["friends", "blocks", "messages"]) {
      expect(KNOWN_STORES as readonly string[]).toContain(id);
      const c = STORE_COLLECTORS.find((x) => x.id === id);
      expect(c, id).toBeDefined();
      expect(typeof c!.export).toBe("function");
      expect(Array.isArray(c!.erase) && c!.erase.includes("social")).toBe(true);
      expect(INVENTORY_ROWS[id as (typeof KNOWN_STORES)[number]]).toEqual([id]);
      expect(INVENTORY.some((r) => r.id === id)).toBe(true);
    }
    // a new directory in the social store without a collector naming it fails here
    const s = new SocialStore("/state");
    const locations = STORE_COLLECTORS.map((c) => c.location).join("\n");
    for (const dir of [s.friendsDir, s.blocksDir, s.threadsDir, s.indexDir, s.pairsDir]) {
      expect(locations, dir).toContain(`FORK_STATE_DIR/${relative("/state", dir).replace(/\\/g, "/")}/`);
    }
  });
});

describe("export", () => {
  it("has the coach's friends, blocks and own conversations, never another pair's thread", async () => {
    await seed(root);
    const deps = depsFor(root);
    seedSocial(deps.stateDir);
    const files = new Map((await collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const friends = JSON.parse(files.get("friends.json")!);
    expect(friends.friends.map((f: { coach: string }) => f.coach)).toEqual(["Bob"]);
    expect(friends.incoming.map((f: { coach: string }) => f.coach)).toEqual(["Carol"]);
    const messages = JSON.parse(files.get("messages.json")!);
    expect(messages.threads).toHaveLength(1);
    expect(messages.threads[0].messages.map((m: { text: string }) => m.text)).toEqual(["Hi Bob, Alice here.", "Hello Alice!"]);
    expect(messages.inbox).toHaveLength(1);
    expect(files.get("messages.json")).not.toContain("Private between Bob and Carol");
    expect(files.has("blocks.json")).toBe(false); // Alice blocked nobody (Erin blocking her is Erin's data)
    expect(files.get("README.txt")).toMatch(/messages\.json/);
    const carol = new Map((await collectExport(deps, "Carol")).map((f) => [f.name, String(f.content)]));
    expect(JSON.parse(carol.get("blocks.json")!).blocked.map((b: { coach: string }) => b.coach)).toEqual(["Dave"]);
  });

  it("a coach with no social data gets no social files", async () => {
    await seed(root);
    const names = (await collectExport(depsFor(root), "Alice")).map((f) => f.name);
    for (const n of ["friends.json", "blocks.json", "messages.json"]) expect(names).not.toContain(n);
  });
});

describe("delete", () => {
  it("drops the coach's own files and their rows in others' lists; threads stay for the other coach as 'Deleted coach #n'", async () => {
    await seed(root);
    const deps = depsFor(root);
    const { ab, bc } = seedSocial(deps.stateDir);
    const out = await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toEqual([]);
    const P = "Deleted coach #1";
    for (const dir of ["friends", "blocks", join("messages", "index")]) expect(existsSync(join(deps.stateDir, dir, socialFileName("Alice"))), dir).toBe(false);
    // Bob's friend row, Carol's outgoing request and Erin's block naming Alice are gone (not pseudonymised)
    expect(readJ(join(deps.stateDir, "friends", socialFileName("Bob"))).friends).toEqual([]);
    expect(readJ(join(deps.stateDir, "friends", socialFileName("Carol"))).outgoing).toEqual([]);
    expect(readJ(join(deps.stateDir, "blocks", socialFileName("Erin"))).blocked).toEqual([]);
    expect(readJ(join(deps.stateDir, "blocks", socialFileName("Carol"))).blocked.map((b: { coach: string }) => b.coach)).toEqual(["Dave"]);
    expect(readJ(join(deps.stateDir, "blocks", socialFileName("Bob"))).blocked.map((b: { coach: string }) => b.coach)).toEqual(["Carol"]);
    // the shared thread: kept for Bob, Alice swapped for her pseudonym in coaches, senders and free text
    const t = readJ(join(deps.stateDir, "messages", "threads", `${ab}.json`));
    expect(t.coaches).toEqual([P, "Bob"]);
    expect(t.messages.map((m: { from: string; text: string }) => [m.from, m.text])).toEqual([[P, `Hi Bob, ${P} here.`], ["Bob", `Hello ${P}!`]]);
    const bobIndex = readJ(join(deps.stateDir, "messages", "index", socialFileName("Bob")));
    expect(bobIndex.threads.find((x: { id: string }) => x.id === ab)).toMatchObject({ with: P, lastFrom: "Bob" });
    // Bob and Carol's own thread is untouched
    expect(readJ(join(deps.stateDir, "messages", "threads", `${bc}.json`)).coaches).toEqual(["Bob", "Carol"]);
    for (const dir of ["friends", "blocks", "messages"]) expect(filesContaining(join(deps.stateDir, dir), /\bAlice\b/), dir).toEqual([]);
    // the store still reads every file
    const s = new SocialStore(deps.stateDir);
    expect(s.index("Bob").threads.map((x) => x.with).sort()).toEqual(["Carol", P].sort());
  });

  it("organiser metadata naming the coach is anonymised too ('Alice Open'), and her pair files go (Sol P2)", async () => {
    await seed(root);
    const deps = depsFor(root);
    const { s, ab } = seedSocial(deps.stateDir);
    const org = s.append("Bob", "Carol", "Alice Open round 2 is up.", { kind: "tournament", id: "x1", name: "Alice Open" }).thread.id;
    const pairs = join(deps.stateDir, "messages", "pairs");
    expect(existsSync(join(pairs, SocialStore.pairFile("Alice", "Bob")))).toBe(true);
    expect((await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).pending).toEqual([]);
    const m = readJ(join(deps.stateDir, "messages", "threads", `${org}.json`)).messages.at(-1);
    expect(m.organiser).toEqual({ kind: "tournament", id: "x1", name: "Deleted coach #1 Open" });
    expect(m.text).toBe("Deleted coach #1 Open round 2 is up.");
    expect(existsSync(join(pairs, SocialStore.pairFile("Alice", "Bob")))).toBe(false);
    expect(existsSync(join(pairs, SocialStore.pairFile("Bob", "Carol")))).toBe(true);
    expect(filesContaining(join(deps.stateDir, "messages"), /\bAlice\b/)).toEqual([]);
    // a new account later taking the old name gets a fresh thread, never the anonymised one
    clearFences(); // past the post-delete grace period
    const fresh = new SocialStore(deps.stateDir).append("Bob", "Alice", "Welcome!").thread.id;
    expect(fresh).not.toBe(ab);
  });

  it("a thread whose two coaches are both deleted goes", async () => {
    await seed(root);
    const deps = depsFor(root);
    const { s, ab } = seedSocial(deps.stateDir);
    const ac = s.append("Carol", "Alice", "Hi from Carol").thread.id;
    expect((await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).pending).toEqual([]);
    clearFences();
    const carol = await new PrivacyService(deps).deleteCoach("Carol", "Carol", "self");
    expect(carol, JSON.stringify(carol)).toMatchObject({ pending: [] });
    expect(existsSync(join(deps.stateDir, "messages", "threads", `${ac}.json`))).toBe(false);
    expect(existsSync(join(deps.stateDir, "messages", "threads", `${ab}.json`))).toBe(true); // Bob is still here
  });

  it("an unreadable social file fails the step (the job retries) instead of skipping it", async () => {
    await seed(root);
    const deps = depsFor(root);
    seedSocial(deps.stateDir);
    (await import("node:fs")).writeFileSync(join(deps.stateDir, "friends", socialFileName("Bob")), "{ torn", "utf8");
    const out = await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self");
    expect(out.pending).toContain("social");
  });
});
