import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cryptoRoller, dieFrom, flipCoin, pickIndex, rollDie, rollerFromDie, seededRoller, sequenceRoller } from "../src/dice/roller.js";
import { FileDiceLog, MemoryDiceLog, fixtureLogId } from "../src/dice/log.js";
import { BLOCK_FACES, kickoffEvent, kickoffTable, scatterDirection } from "../src/dice/tables.js";
import { mayChooseBlock, parseRollSpec, rollSpec } from "../src/dice/rolls.js";
import { createMatch, tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { d6 } from "../src/leagues/redraft.js";

// The site roller, the dice log and the recorder's dice roller routes (spec-forfeit-and-dice-2026-11-02).

describe("the site roller", () => {
  it("seeded rolls are deterministic and uniform (chi-square over 60k d6)", () => {
    const a = seededRoller(42); const b = seededRoller(42);
    const seqA = Array.from({ length: 50 }, () => rollDie(a, 6));
    expect(Array.from({ length: 50 }, () => rollDie(b, 6))).toEqual(seqA);
    const r = seededRoller(7);
    const n = 60000; const counts = new Array(6).fill(0);
    for (let i = 0; i < n; i++) counts[rollDie(r, 6) - 1]++;
    const exp = n / 6;
    const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
    expect(chi).toBeLessThan(20.5); // 5 dof, p ~ 0.001
  });
  it("uniform over odd ranges too (d16, d3) and never out of range", () => {
    const r = seededRoller(99);
    for (const sides of [3, 8, 16]) {
      const n = 32000; const counts = new Array(sides).fill(0);
      for (let i = 0; i < n; i++) { const v = rollDie(r, sides); expect(v).toBeGreaterThanOrEqual(1); expect(v).toBeLessThanOrEqual(sides); counts[v - 1]++; }
      const exp = n / sides;
      const chi = counts.reduce((s, c) => s + (c - exp) ** 2 / exp, 0);
      expect(chi).toBeLessThan(sides * 3 + 10);
    }
  });
  it("crypto roller stays in range; injection helpers", () => {
    for (let i = 0; i < 500; i++) { const v = rollDie(cryptoRoller, 6); expect(v >= 1 && v <= 6).toBe(true); }
    expect([0, 1]).toContain(pickIndex(cryptoRoller, 2));
    expect(typeof flipCoin(cryptoRoller)).toBe("boolean");
    const seq = sequenceRoller([3, 5]);
    expect([rollDie(seq, 6), rollDie(seq, 6), rollDie(seq, 6)]).toEqual([3, 5, 3]);
    expect(() => rollDie(sequenceRoller([7]), 6)).toThrow();
    expect(dieFrom(sequenceRoller([2]))(6)).toBe(2);
    expect(rollerFromDie(() => 4).int(1, 6)).toBe(4);
    const v = d6(); // redraft rest roll goes through the site roller
    expect(v >= 1 && v <= 6).toBe(true);
  });
});

describe("dice tables", () => {
  it("kick-off table by ruleset (BB2025 default, BB2020 differs on 10/11)", () => {
    expect(kickoffTable().map((e) => e.total)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(kickoffEvent(2).name).toBe("Get the Ref");
    expect(kickoffEvent(7).name).toBe("Brilliant Coaching");
    expect(kickoffEvent(10).name).toBe("Charge!");
    expect(kickoffEvent(11, "BB2025").name).toBe("Dodgy Snack");
    expect(kickoffEvent(10, "BB2020").name).toBe("Blitz");
    expect(kickoffEvent(11, "BB2020").name).toBe("Officious Ref");
    expect(kickoffEvent(12).name).toBe("Pitch Invasion");
    expect(() => kickoffEvent(13)).toThrow();
  });
  it("scatter and block faces", () => {
    expect(scatterDirection(2).id).toBe("n");
    expect(scatterDirection(8).id).toBe("se");
    expect(BLOCK_FACES).toEqual(["skull", "both-down", "push", "push", "stumble", "pow"]);
  });
  it("roll specs: counts, kinds, deviate and kick-off results", () => {
    expect(parseRollSpec({ kind: "d6", count: 3 })).toHaveProperty("error");
    expect(parseRollSpec({ kind: "block", count: 0 })).toHaveProperty("error");
    expect(parseRollSpec({ kind: "block", count: -2 })).toEqual({ kind: "block", count: -2 });
    expect(parseRollSpec({ kind: "defection" })).toHaveProperty("error");
    const dev = rollSpec(sequenceRoller([4, 6]), { kind: "deviate" }, "BB2025");
    expect(dev.result).toMatchObject({ distance: 4, direction: "sw" });
    const ko = rollSpec(sequenceRoller([5, 6]), { kind: "kickoff" }, "BB2025");
    expect(ko.result).toMatchObject({ total: 11, eventName: "Dodgy Snack" });
    const blk = rollSpec(sequenceRoller([1, 6]), { kind: "block", count: -2 }, "BB2025");
    expect(blk.result.faces).toEqual(["skull", "pow"]);
    expect(blk.block).toEqual({ count: -2, chooser: "opponent" });
    expect(mayChooseBlock({ block: { count: -2, chooser: "opponent" }, side: "home" }, "away", false)).toBe(true);
    expect(mayChooseBlock({ block: { count: -2, chooser: "opponent" }, side: "home" }, "home", false)).toBe(true);
    expect(mayChooseBlock({ block: { count: 2, chooser: "roller" }, side: "home" }, "away", false)).toBe(false);
    expect(mayChooseBlock({ block: { count: 2, chooser: "roller" }, side: "home" }, null, false)).toBe(false);
  });
});

// ---- recorder routes ----------------------------------------------------------------------------------------------

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let log: MemoryDiceLog;
let pushes: Array<{ matchId: string; payload: any }>;
const files: Record<string, TabletopTeamFile> = {};
const NOW = new Date("2026-03-01T10:00:00.000Z");
const player = (id: string): TabletopPlayer => ({ id, name: `P ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false });
const team = (name: string, prefix: string): TabletopTeamFile => ({ schema: 1, name, race: "Human", treasury: 0, dedicatedFans: 2, players: Array.from({ length: 11 }, (_, i) => player(`${prefix}${i}`)) });

const deps = (roller = seededRoller(1)): TabletopApiDeps => ({
  repo, results, roller, diceLog: log,
  publishDice: (matchId, payload) => pushes.push({ matchId, payload }),
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: () => false, drawSeats: () => false, isOrganizer: (c) => c === "Org", now: () => NOW,
});
let D: TabletopApiDeps;
const as = async (coach: string | undefined, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, coach ? { coach, method: "discord" } : undefined, body, D))!;

async function newMatch(): Promise<string> {
  const r = await createMatch("Org", true, { home: { coach: "Alice", team: "a" }, away: { coach: "Bob", team: "b" }, postMatch: "full", pregame: "skip" }, D, () => NOW);
  expect(r.status).toBe(201);
  return (r.body as { match: { id: string } }).match.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dice-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  log = new MemoryDiceLog();
  pushes = [];
  files["Alice/a"] = team("Humans", "h");
  files["Bob/b"] = team("Orcs", "o");
  D = deps();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recorder dice roller", () => {
  it("rolls on the server, logs BEFORE the answer, and pushes to the match room", async () => {
    const id = await newMatch();
    const r = await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6", count: 2 });
    expect(r.status).toBe(201);
    const roll = (r.body as any).roll;
    expect(roll).toMatchObject({ by: "Alice", side: "home", kind: "d6" });
    expect(roll.dice).toHaveLength(2);
    expect(log.read(id).map((x) => x.id)).toEqual([roll.id]);
    expect(pushes).toEqual([{ matchId: id, payload: expect.objectContaining({ rollId: roll.id, what: "roll" }) }]);
    // a log write failure: nothing is answered or pushed
    log.failNext = true;
    const bad = await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d8" });
    expect(bad.status).toBe(500);
    expect(JSON.stringify(bad.body)).not.toContain("dice\":");
    expect(pushes).toHaveLength(1);
    expect(log.read(id)).toHaveLength(1);
  });

  it("the log is hidden from coaches by default, organisers always see it; the toggle shows it", async () => {
    const id = await newMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d16" });
    const coach = (await as("Bob", "GET", `/api/tabletop/matches/${id}/dice`)).body as any;
    expect(coach.logShown).toBe(false);
    expect(coach).not.toHaveProperty("log");
    expect(coach.latest).toHaveLength(1); // the opponent sees the live result
    const org = (await as("Org", "GET", `/api/tabletop/matches/${id}/dice`)).body as any;
    expect(org.log).toHaveLength(1);
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/dice/log`, { shown: "yes" })).status).toBe(400);
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/dice/log`, { shown: true })).status).toBe(200);
    expect(((await as("Alice", "GET", `/api/tabletop/matches/${id}/dice`)).body as any).log).toHaveLength(1);
    await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/log`, { shown: false });
    expect((await as("Alice", "GET", `/api/tabletop/matches/${id}/dice`)).body).not.toHaveProperty("log");
  });

  it("strangers never see or make a roll; anonymous gets 401; GET writes nothing", async () => {
    const id = await newMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6" });
    expect((await as("Mallory", "GET", `/api/tabletop/matches/${id}/dice`)).status).toBe(403);
    expect((await as("Mallory", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6" })).status).toBe(403);
    expect((await as(undefined, "GET", `/api/tabletop/matches/${id}/dice`)).status).toBe(401);
    const before = log.read(id).length;
    for (let i = 0; i < 3; i++) await as("Bob", "GET", `/api/tabletop/matches/${id}/dice`);
    expect(log.read(id).length).toBe(before);
    expect(pushes).toHaveLength(1);
    expect((await as("Bob", "GET", `/api/tabletop/matches/${id}/dice/roll`)).status).toBe(405);
  });

  it("a coach rolls for their own side; an organiser names the side and is marked admin", async () => {
    const id = await newMatch();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6", side: "away" })).status).toBe(403);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6" })).status).toBe(400);
    const r = await as("Org", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "kickoff", side: "away" });
    expect((r.body as any).roll).toMatchObject({ side: "away", admin: true, kind: "kickoff" });
    expect(typeof (r.body as any).roll.result.eventName).toBe("string");
  });

  it("block -2: the opponent or the roller may choose; the first valid choice wins and is logged", async () => {
    const id = await newMatch();
    const roll = ((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "block", count: -2 })).body as any).roll;
    expect(roll.block).toEqual({ count: -2, chooser: "opponent" });
    const pending = ((await as("Bob", "GET", `/api/tabletop/matches/${id}/dice`)).body as any).pending;
    expect(pending.map((p: any) => p.id)).toEqual([roll.id]);
    expect((await as("Mallory", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: roll.id, index: 0 })).status).toBe(403);
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: roll.id, index: 5 })).status).toBe(400);
    const first = await as("Bob", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: roll.id, index: 1 });
    expect(first.status).toBe(200);
    expect((first.body as any).roll.choice).toMatchObject({ index: 1, by: "Bob", face: roll.result.faces[1] });
    const second = await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: roll.id, index: 0 });
    expect(second.status).toBe(409);
    expect(log.read(id)[0]!.choice).toMatchObject({ index: 1, by: "Bob" });
    expect(pushes.map((p) => p.payload.what)).toEqual(["roll", "choice"]);
  });

  it("block -3 chosen by the rolling coach (in person); block 2 refuses the opponent", async () => {
    const id = await newMatch();
    const r3 = ((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "block", count: -3 })).body as any).roll;
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: r3.id, index: 2 })).status).toBe(200);
    const r2 = ((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "block", count: 2 })).body as any).roll;
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: r2.id, index: 0 })).status).toBe(403);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: r2.id, index: 0 })).status).toBe(200);
    const r1 = ((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "block", count: 1 })).body as any).roll;
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/choose`, { rollId: r1.id, index: 0 })).status).toBe(409);
  });

  it("dice writes need the CSRF header (state-changing POSTs); the GET is not state-changing", () => {
    for (const a of ["dice/roll", "dice/choose", "dice/log", "forfeit", "forfeit/defections", "forfeit/settings"])
      expect(isStateChangingApiRequest("POST", `/api/tabletop/matches/m1/${a}`)).toBe(true);
    expect(isStateChangingApiRequest("GET", "/api/tabletop/matches/m1/dice")).toBe(false);
    expect(isStateChangingApiRequest("POST", "/api/leagues/l/seasons/s/fixtures/f/forfeit")).toBe(true);
  });
});

describe("recorder forfeit", () => {
  it("managers only; a successful forfeit closes the match and blocks further writes", async () => {
    const calls: string[] = [];
    D = { ...deps(), forfeit: {
      model: () => ({ status: 200, body: { ok: "model" } }),
      roll: () => { calls.push("roll"); return { status: 201, body: {} }; },
      settings: (_m, _w, on) => { calls.push(`settings:${String(on)}`); return { status: 200, body: {} }; },
      apply: async (_m, who) => { calls.push(`apply:${who.coach}`); return { status: 200, body: { ok: true } }; },
    } };
    const id = await newMatch();
    expect((await as("Alice", "GET", `/api/tabletop/matches/${id}/forfeit`)).status).toBe(403);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/forfeit`, {})).status).toBe(403);
    expect((await as("Org", "GET", `/api/tabletop/matches/${id}/forfeit`)).body).toEqual({ ok: "model" });
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit/settings`, { defectionRolls: false })).status).toBe(200);
    const r = await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, { home: {}, away: {} });
    expect(r.status).toBe(200);
    expect((r.body as any).match).toMatchObject({ state: "published", forfeit: { by: "Org" } });
    expect(calls).toEqual(["settings:false", "apply:Org"]);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/forfeit`, {})).status).toBe(409);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [] })).status).toBe(409);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/dice/roll`, { kind: "d6" })).status).toBe(409);
  });
});

describe("file dice log", () => {
  it("appends rolls and folds the first choice; fixture log ids are path-safe", () => {
    const fl = new FileDiceLog(join(dir, "dice"));
    fl.appendRoll({ id: "r1", logId: "m1", at: "t", by: "Alice", kind: "block", purpose: "x", dice: [1, 6], result: { faces: ["skull", "pow"] }, block: { count: -2, chooser: "opponent" } });
    fl.appendChoice("m1", "r1", { index: 1, face: "pow", by: "Bob", at: "t2" });
    fl.appendChoice("m1", "r1", { index: 0, face: "skull", by: "Alice", at: "t3" });
    expect(fl.read("m1")[0]!.choice).toMatchObject({ index: 1, by: "Bob" });
    expect(readFileSync(join(dir, "dice", "m1.ndjson"), "utf8").trim().split("\n")).toHaveLength(3);
    expect(fixtureLogId("league:a:b:c")).toMatch(/^fx-[0-9a-f]{32}$/);
    expect(() => fl.appendRoll({ id: "r", logId: "../x", at: "", by: "", kind: "d6", purpose: "", dice: [], result: {} })).toThrow();
  });
});
