import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { RecorderAnnouncement } from "../src/tabletop/discord.js";
import type { TabletopEvent } from "../src/tabletop/events.js";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { pregameStepOf } from "../src/tabletop/pregame.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { testingApi } from "../src/tabletop/testing.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// Pre-game flow (spec docs/artifact-orchestration/spec-recorder-pregame-2026-10-30.md): physical vs site rolls, the
// drawn coin caller, kick/receive as a step, the organiser skip, the inducement menu, test matches, Discord milestones.

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let rolls: number[] = [];
let announced: RecorderAnnouncement[] = [];
let pushes: Array<{ id: string; payload: any }> = [];
const files: Record<string, TabletopTeamFile> = {};

const players = (n: number, prefix: string): TabletopPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
const team = (race: string, n: number, prefix: string, tv: number, treasury = 100_000): TabletopTeamFile =>
  ({ schema: 1, name: `${prefix} XI`, race, treasury, dedicatedFans: 2, teamValue: tv, players: players(n, prefix) });

const deps = (): TabletopApiDeps => ({
  repo, results,
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => new Date("2026-03-01T10:00:00.000Z"),
  rollDie: () => rolls.shift() ?? 1,
  publishClock: (id, payload) => { pushes.push({ id, payload }); },
  announce: (a) => { announced.push(a); },
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams()))!;
const advance = (id: string, who: string, body?: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/pregame/advance`, body);
const skip = (id: string, who: string) => as(who, "POST", `/api/tabletop/matches/${id}/pregame/skip`, {});
const get = async (id: string) => (await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as Record<string, any>;
const ev = async (id: string, eid: string) => ((await get(id)).events as TabletopEvent[]).find((e) => e.id === eid);

async function newMatch(): Promise<string> {
  const r = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full" });
  expect(r.status).toBe(201);
  return (r.body as { match: { id: string } }).match.id;
}
/** fans, weather, journeymen with site rolls, then both inducements skipped: the match is at the coin phase. */
async function toCoin(id: string, callerRoll = 1): Promise<void> {
  rolls = [1, 1, 3, 3];
  for (let i = 0; i < 3; i += 1) expect((await advance(id, "Alice")).status).toBe(200);
  await advance(id, "Bob", { team: "away", skip: true });
  rolls = [callerRoll];
  expect((await advance(id, "Alice", { team: "home", skip: true })).body).toMatchObject({ phase: "pregame:coin" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-pregame-flow-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  rolls = [];
  announced = [];
  pushes = [];
  files["Alice/sv_a"] = team("Human", 11, "a", 1_000_000);
  files["Bob/sv_b"] = team("Black Orc", 11, "b", 1_200_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("physical dice or site rolls", () => {
  it("fans and weather: site rolls say so; entered results are validated and carry who typed them", async () => {
    const id = await newMatch();
    expect((await advance(id, "Alice", { mode: "dice-bag" })).status).toBe(400);
    expect((await advance(id, "Alice", { mode: "hand", rolls: { home: 4, away: 1 } })).status).toBe(400); // a D3 is 1-3
    expect((await advance(id, "Alice", { mode: "hand", rolls: { home: 2 } })).status).toBe(400);
    let r = await advance(id, "Bob", { mode: "hand", rolls: { home: 3, away: 1 } });
    expect(r.body).toMatchObject({ phase: "pregame:weather", pregame: { step: "weather", fans: { home: { roll: 3, total: 5, rolledBy: "coach", enteredBy: "Bob" }, away: { roll: 1, total: 3 } } } });
    expect((await advance(id, "Alice", { mode: "hand", dice: [7, 1] })).status).toBe(400);
    expect((await advance(id, "Alice", { mode: "hand", dice: [6] })).status).toBe(400);
    r = await advance(id, "Alice", { mode: "hand", dice: [6, 6] });
    expect(r.body).toMatchObject({ phase: "pregame:journeymen", pregame: { weather: { roll: 12, dice: [6, 6], result: "Blizzard", rolledBy: "coach", enteredBy: "Alice" } } });
    expect((await advance(id, "Mallory", {})).status).toBe(403); // strangers never act
  });

  it("a site roll is recorded as rolledBy site", async () => {
    const id = await newMatch();
    rolls = [2, 2, 4, 5];
    await advance(id, "Alice", { mode: "site" });
    await advance(id, "Alice");
    expect(await ev(id, "pg-fans-home")).toMatchObject({ payload: { roll: 2, rolledBy: "site" } });
    expect((await ev(id, "pg-fans-home"))!.payload.enteredBy).toBeUndefined();
    expect(await ev(id, "pg-weather-0")).toMatchObject({ payload: { roll: 9, result: "Perfect Conditions", rolledBy: "site" } });
  });

  it("prayers entered by hand: one distinct D16 per prayer bought", async () => {
    files["Alice/sv_a"] = team("Human", 11, "a", 1_000_000);
    const id = await newMatch();
    rolls = [1, 1, 3, 3];
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    await advance(id, "Bob", { team: "away", skip: true });
    expect((await advance(id, "Alice", { team: "home", picks: [{ id: "prayers_to_nuffle", qty: 2 }] })).body).toMatchObject({ phase: "pregame:prayers" });
    expect((await advance(id, "Alice", { mode: "hand", rolls: { home: [3, 3], away: [] } })).status).toBe(400); // duplicates
    expect((await advance(id, "Alice", { mode: "hand", rolls: { home: [3], away: [] } })).status).toBe(400); // two were bought
    expect((await advance(id, "Alice", { mode: "hand", rolls: { home: [3, 17], away: [] } })).status).toBe(400);
    const r = await advance(id, "Alice", { mode: "hand", rolls: { home: [3, 9], away: [] } });
    expect(r.body).toMatchObject({ phase: "pregame:coin", pregame: { prayers: { home: [{ roll: 3, name: "Stiletto", rolledBy: "coach" }, { roll: 9, name: "Moles Under the Pitch" }] }, coin: { caller: "home" } } });
  });
});

describe("coin flip and kick/receive", () => {
  it("the site draws the caller; the caller calls; the winner chooses; every step is visible to the other coach and organisers", async () => {
    const id = await newMatch();
    await toCoin(id, 2); // away calls
    expect((await get(id)).pregame).toMatchObject({ step: "coin", coin: { caller: "away" } });
    expect((await as("Org", "GET", `/api/tabletop/matches/${id}`)).body).toMatchObject({ pregame: { coin: { caller: "away" } } }); // an onlooking organiser sees it
    expect((await advance(id, "Alice", { mode: "auto", call: "heads" })).status).toBe(403);
    rolls = [1]; // heads
    const flip = await advance(id, "Bob", { mode: "auto", call: "tails" });
    expect(flip.body).toMatchObject({ phase: "pregame:coin", pregame: { step: "kickreceive", coin: { caller: "away", call: "tails", result: "heads", winner: "home", rolledBy: "site" } } });
    expect((await get(id)).pregame.step).toBe("kickreceive");
    expect((await advance(id, "Bob", { choice: "kick" })).status).toBe(403); // Alice won
    const done = await advance(id, "Alice", { choice: "kick" });
    expect(done.body).toMatchObject({ phase: "pregame:timers", pregame: { step: "timers", coin: { winner: "home", choice: "kick" } } });
    // the log carries the draw, the flip and the choice
    const events = (await get(id)).events as TabletopEvent[];
    expect(events.filter((e) => e.type === "coinFlip").map((e) => e.id)).toEqual(["pg-coincaller", "pg-coinflip", "pg-coinchoice"]);
  });

  it("a real coin cannot be used to bypass the caller or the winner (regression: Sol 6.1 P2 #1)", async () => {
    const id = await newMatch();
    await toCoin(id, 1); // Alice (home) was drawn to call
    expect((await advance(id, "Bob", { mode: "auto", call: "heads" })).status).toBe(403);
    // Bob may not call, flip and choose for Alice in one hand-entered request; nothing is recorded
    expect((await advance(id, "Bob", { mode: "hand", call: "heads", result: "heads", choice: "kick" })).status).toBe(403);
    expect((await advance(id, "Bob", { mode: "hand", call: "heads", result: "heads" })).status).toBe(403);
    expect(((await get(id)).events as TabletopEvent[]).filter((e) => e.type === "coinFlip").map((e) => e.id)).toEqual(["pg-coincaller"]);
    // the caller who also wins may do all three at once; the choice is its own logged event
    const r = await advance(id, "Alice", { mode: "hand", call: "heads", result: "heads", choice: "receive" });
    expect(r.body).toMatchObject({ phase: "pregame:timers", pregame: { coin: { mode: "hand", caller: "home", winner: "home", choice: "receive", rolledBy: "coach", enteredBy: "Alice" } } });
    expect(((await get(id)).events as TabletopEvent[]).filter((e) => e.type === "coinFlip").map((e) => e.id)).toEqual(["pg-coincaller", "pg-coincall", "pg-coinflip", "pg-coinchoice"]);
  });

  it("an organiser may call, enter and choose for the coaches", async () => {
    const id = await newMatch();
    await toCoin(id, 2); // Bob (away) calls
    expect((await advance(id, "Org", { mode: "hand", call: "tails" })).status).toBe(200);
    expect((await advance(id, "Alice", { mode: "hand", result: "heads" })).body).toMatchObject({ pregame: { step: "kickreceive", coin: { winner: "home" } } });
    expect((await advance(id, "Org", { choice: "kick" })).body).toMatchObject({ phase: "pregame:timers", pregame: { coin: { choice: "kick" } } });
  });

  it("a match already at the coin phase without a draw gets one on its first request (nothing else accepted)", async () => {
    const id = await newMatch();
    const m = (await repo.getMatch(id))!;
    await repo.updateMatch({ ...m, phase: "pregame:coin" });
    rolls = [2];
    const r = await advance(id, "Alice", { mode: "auto", call: "heads" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "pregame:coin", recorded: ["pg-coincaller"], pregame: { coin: { caller: "away" } } });
    expect((await get(id)).pregame.coin.result).toBeUndefined();
  });
});

describe("organiser skip", () => {
  it("only an organiser skips; it is logged, starts the set-up and cannot repeat", async () => {
    const id = await newMatch();
    expect((await skip(id, "Alice")).status).toBe(403);
    const r = await skip(id, "Org");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "playing", recorded: ["pg-skip"], clock: { half: 1, turn: 0 }, pregame: { step: "setup", skipped: { by: "Org", from: "pregame:fans" } } });
    expect(await ev(id, "pg-skip")).toMatchObject({ type: "pregameSkip", by: "Org", payload: { from: "pregame:fans" } });
    expect((await skip(id, "Org")).status).toBe(409);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/turn/start`, {})).status).toBe(200); // the turn UI unlocks
    expect((await get(id)).pregame.step).toBe("done");
    expect(announced.map((a) => a.kind)).toEqual(["skip"]);
    expect(pushes.at(-1)).toMatchObject({ id, payload: { phase: "playing" } });
  });

  it("turn routes stay locked during the pre-game", async () => {
    const id = await newMatch();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/turn/start`, {})).status).toBe(409);
  });
});

describe("inducement menu, pushes and Discord milestones", () => {
  it("during inducements the view lists each team's offers and budget by the petty-cash rules", async () => {
    const id = await newMatch();
    rolls = [1, 1, 3, 3];
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    let pg = (await get(id)).pregame;
    expect(pg.step).toBe("inducements");
    expect(pg.tv).toEqual({ home: 1_000_000, away: 1_200_000 });
    expect(pg.budget.away).toMatchObject({ role: "favourite", topUpLimit: 100_000, pettyCash: 0, submitted: false });
    expect(pg.budget.home).toMatchObject({ role: "underdog", pettyCash: 200_000, topUpLimit: 50_000 });
    expect(pg.inducementOptions.away.find((o: { id: string }) => o.id === "bribes")).toMatchObject({ price: 50_000, max: 6 }); // Bribery and Corruption
    expect(pg.inducementOptions.home.find((o: { id: string }) => o.id === "bribes")).toMatchObject({ price: 100_000, max: 3 });
    expect(pg.inducementOptions.home.some((o: { id: string }) => o.id === "star_players")).toBe(false); // variable price: not offered
    await advance(id, "Bob", { team: "away", picks: [{ id: "bribes", qty: 1 }] });
    pg = (await get(id)).pregame;
    expect(pg.budget.home.pettyCash).toBe(250_000);
    expect(pg.budget.away).toMatchObject({ spent: 50_000, submitted: true });
  });

  it("each pre-game write is pushed; fans, weather, inducements and coin are announced once each", async () => {
    const id = await newMatch();
    await toCoin(id, 1);
    rolls = [1];
    await advance(id, "Alice", { mode: "auto", call: "heads" });
    await advance(id, "Alice", { choice: "receive" });
    expect(announced.map((a) => a.kind)).toEqual(["fans", "weather", "inducements", "coin"]);
    expect(announced.at(-1)!.match.id).toBe(id);
    expect(pushes.length).toBeGreaterThanOrEqual(7); // fans, weather, journeymen, 2 x inducements, flip, choice
    expect(Object.keys(pushes[0]!.payload)).toContain("phase");
  });

  it("a failing announcer never blocks the match", async () => {
    const id = await newMatch();
    const r = await tabletopApi("POST", `/api/tabletop/matches/${id}/pregame/advance`, { coach: "Alice", method: "discord" }, {}, { ...deps(), announce: () => { throw new Error("discord down"); } }, new URLSearchParams());
    expect(r!.status).toBe(200);
  });
});

describe("test matches walk the pre-game too", () => {
  it("a Testing Suite match with no pregame field starts at pregame:fans; skip is explicit", async () => {
    const T = (body: unknown) => testingApi("POST", "/api/admin/testing/tabletop-match", new URLSearchParams(), body, { me: "Org" }, deps());
    const sides = { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } };
    const full = (await T(sides))!;
    expect(full.status).toBe(201);
    const fid = (full.body as { matchId: string }).matchId;
    expect((await repo.getMatch(fid))!).toMatchObject({ test: true, phase: "pregame:fans" });
    rolls = [1, 2];
    expect((await advance(fid, "Org")).body).toMatchObject({ phase: "pregame:weather" });
    files["Carol/sv_c"] = team("Human", 11, "c", 1_000_000);
    files["Dave/sv_d"] = team("Human", 11, "d", 1_000_000);
    const skipped = (await T({ home: { coach: "Carol", team: "sv_c" }, away: { coach: "Dave", team: "sv_d" }, pregame: "skip" }))!;
    expect(skipped.status).toBe(201);
    expect((await repo.getMatch((skipped.body as { matchId: string }).matchId))!.phase).toBe("playing");
  });
});

describe("pregameStepOf", () => {
  it("maps phases, the kick/receive sub-step and the set-up", () => {
    const flip = { id: "pg-coinflip", payload: { result: "heads" } } as unknown as TabletopEvent;
    expect(pregameStepOf("pregame:fans", [])).toBe("fans");
    expect(pregameStepOf("pregame:coin", [])).toBe("coin");
    expect(pregameStepOf("pregame:coin", [flip])).toBe("kickreceive");
    expect(pregameStepOf("pregame:coin", [{ ...flip, payload: { result: "heads", choice: "kick" } } as TabletopEvent])).toBe("coin");
    expect(pregameStepOf("playing", [], { half: 1, turn: 0 })).toBe("setup");
    expect(pregameStepOf("playing", [], { half: 1, turn: 3 })).toBe("done");
    expect(pregameStepOf("playing", [])).toBe("setup");
  });
});
