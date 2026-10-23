import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import { effectiveEvents, parseEvent, validateEvent, type RosterPair, type TabletopEvent } from "../src/tabletop/events.js";
import { applyPostMatch, tallyMatch, type TabletopPlayer, type TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { planInducements, weatherFor } from "../src/tabletop/pregame.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let rolls: number[] = [];
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
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams()))!;
const advance = (id: string, who: string, body?: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/pregame/advance`, body);
const get = async (id: string) => (await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as Record<string, any>;
let eid = 0;
const E = (type: string, team_: string | undefined, player?: string, payload: Record<string, unknown> = {}) => {
  eid += 1;
  return { id: `evt-${String(eid).padStart(8, "0")}`, type, team: team_, player, payload };
};

async function newMatch(): Promise<string> {
  const r = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full" });
  expect(r.status).toBe(201);
  return (r.body as { match: { id: string } }).match.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-pregame-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  rolls = [];
  // Alice: Human, only 9 players (two journeymen needed), TV 1,000k. Bob: Black Orc, 11 players, TV 1,200k.
  files["Alice/sv_a"] = team("Human", 9, "a", 1_000_000);
  files["Bob/sv_b"] = team("Black Orc", 11, "b", 1_200_000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("pre-game sequence", () => {
  it("walks fans, weather, journeymen, inducements, prayers, coin in rulebook order; rolls are server-side and recorded", async () => {
    const id = await newMatch();
    expect((await get(id)).phase).toBe("pregame:fans");
    // nothing can be recorded or submitted before the pre-game is done
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1")] })).status).toBe(409);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(409);
    expect((await advance(id, "Alice", { phase: "pregame:weather" })).status).toBe(409); // wrong phase guard

    // fans: D3 + dedicated fans, per team
    rolls = [2, 3];
    let r = await advance(id, "Alice");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "pregame:weather", pregame: { fans: { home: { roll: 2, dedicatedFans: 2, total: 4 }, away: { roll: 3, total: 5 } } } });

    // weather: 2D6 on the table
    rolls = [5, 6];
    r = await advance(id, "Bob");
    expect(r.body).toMatchObject({ phase: "pregame:journeymen", pregame: { weather: { roll: 11, dice: [5, 6], result: "Pouring Rain" } } });

    // journeymen: home has 9 available -> 2 added; away has 11 -> none
    r = await advance(id, "Alice");
    const body = r.body as { phase: string; pregame: any; teams: { home: { players: any[] }; away: { players: any[] } } };
    expect(body.phase).toBe("pregame:inducements");
    expect(body.pregame.journeymen).toEqual({ home: ["jm-1", "jm-2"], away: [] });
    expect(body.teams.home.players).toHaveLength(11);
    expect(body.teams.home.players.filter((p) => p.journeyman).map((p) => [p.positionId, p.skills.includes("Loner (4+)")])).toEqual([["human.human_lineman", true], ["human.human_lineman", true]]);
    expect(body.teams.away.players).toHaveLength(11);
    // the journeymen are NOT written into the stored team revision
    expect((await repo.getChain("Alice", "sv_a"))!.revisions[0]!.teamFile.players).toHaveLength(9);

    // inducements. Away (TV 1,200k) is the higher team; home = 1,000k + 2 x 50k = 1,100k, so petty cash = 100k + away's treasury spend.
    expect((await advance(id, "Alice", { team: "home", picks: [] })).status).toBe(409); // the higher team goes first
    expect((await advance(id, "Mallory", { team: "away", skip: true })).status).toBe(403); // strangers never submit
    expect((await advance(id, "Bob", { team: "away", picks: [{ id: "nonsense", qty: 1 }] })).status).toBe(400);
    expect((await advance(id, "Bob", { team: "away", picks: [{ id: "bribes", qty: 7 }] })).status).toBe(400); // over the reduced max of 6
    expect((await advance(id, "Bob", { team: "away", picks: [{ id: "bribes", qty: 3 }] })).status).toBe(400); // 3 x 50k > treasury 100k
    r = await advance(id, "Bob", { team: "away", picks: [{ id: "bribes", qty: 2 }] }); // reduced price (Bribery and Corruption): 2 x 50k
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "pregame:inducements", waitingFor: ["home"], pregame: { inducements: { away: { total: 100_000, treasury: 100_000 } } } });
    // a second submission for the same team REPLACES the first while the phase is open (participants may submit for either team)
    r = await advance(id, "Alice", { team: "away", picks: [{ id: "bribes", qty: 1 }, { id: "team_mascot", qty: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ phase: "pregame:inducements", pregame: { inducements: { away: { total: 75_000, treasury: 75_000, submittedBy: "Alice", replaces: 1 } } } });
    r = await advance(id, "Bob", { team: "away", picks: [{ id: "bribes", qty: 2 }] });
    expect(r.body).toMatchObject({ pregame: { inducements: { away: { total: 100_000, submittedBy: "Bob" } } } });
    // underdog: petty cash = 100k + 100k = 200k; prayers cost 10k each (rulebook price, shared dataset)
    expect((await advance(id, "Alice", { team: "home", picks: [{ id: "prayers_to_nuffle", qty: 4 }] })).status).toBe(400); // max 3
    expect((await advance(id, "Alice", { team: "home", picks: [{ id: "extra_team_training", qty: 3 }] })).status).toBe(400); // 300k: petty 200k + 100k top-up > treasury top-up of 100k? ok at limit
    r = await advance(id, "Alice", { team: "home", picks: [{ id: "prayers_to_nuffle", qty: 2 }, { id: "team_mascot", qty: 1 }] });
    expect(r.body).toMatchObject({ phase: "pregame:prayers", pregame: { inducements: { home: { total: 45_000, treasury: 0, pettyCash: 200_000 } } } });

    // prayers: one D16 per bought prayer, duplicates re-rolled
    rolls = [16, 16, 4];
    r = await advance(id, "Alice");
    expect(r.body).toMatchObject({ phase: "pregame:coin", pregame: { prayers: { home: [{ roll: 16, name: "Intensive Training" }, { roll: 4, name: "Iron Man" }], away: [] } } });

    // coin by hand
    const hand = { mode: "hand", call: "heads", caller: "home", result: "tails" };
    expect((await advance(id, "Alice", { ...hand, winner: "away" })).status).toBe(400); // choice needed
    expect((await advance(id, "Alice", { ...hand, winner: "home", choice: "kick" })).status).toBe(400); // tails against a heads call: away won
    r = await advance(id, "Alice", { ...hand, winner: "away", choice: "kick" });
    expect(r.body).toMatchObject({ phase: "playing", pregame: { coin: { mode: "hand", call: "heads", caller: "home", result: "tails", winner: "away", choice: "kick" } } });
    expect((await advance(id, "Alice")).status).toBe(409); // pre-game finished

    // play: a journeyman can score; pre-game events are never undoable
    const play = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "jm-1")] });
    expect(play.status).toBe(200);
    const events = (await get(id)).events as TabletopEvent[];
    expect(events.map((e) => e.type)).toEqual(["fans", "fans", "weather", "journeyman", "journeyman", "inducement", "inducement", "inducement", "inducement", "prayer", "prayer", "coinFlip", "touchdown"]);
    const pre = events.find((e) => e.type === "fans")!;
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "home", undefined, { target: pre.id })] })).status).toBe(400);
    // pre-game types cannot be posted by a coach
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("fans", "home")] })).status).toBe(400);
  });

  it("auto coin flip is server-side (roll 1 = home); with no prayers bought the prayers phase is skipped", async () => {
    const id = await newMatch();
    rolls = [1, 1, 3, 3]; await advance(id, "Alice"); await advance(id, "Alice"); // fans, weather
    await advance(id, "Alice"); // journeymen (home needs 2, no rolls used)
    await advance(id, "Bob", { team: "away", skip: true });
    const r = await advance(id, "Alice", { team: "home", skip: true });
    expect(r.body).toMatchObject({ phase: "pregame:coin", pregame: { prayers: { home: [], away: [] } } });
    // auto: the SERVER flips (roll 1 = heads). Home calls tails, gets heads: away wins the toss.
    expect((await advance(id, "Alice", { mode: "auto", call: "heads" })).status).toBe(400); // caller missing
    rolls = [1];
    const flip = await advance(id, "Alice", { mode: "auto", call: "tails", caller: "home" });
    expect(flip.body).toMatchObject({ phase: "pregame:coin", pregame: { coin: { mode: "auto", call: "tails", caller: "home", result: "heads", winner: "away" } } });
    expect((flip.body as { pregame: { coin: { choice?: string } } }).pregame.coin.choice).toBeUndefined();
    expect((await advance(id, "Alice", { mode: "auto", call: "tails", caller: "home" })).status).toBe(400); // the choice is what is needed now
    expect((await advance(id, "Alice", { choice: "kick" })).status).toBe(403); // only the winner (Bob) chooses
    expect((await advance(id, "Bob", { choice: "sideways" })).status).toBe(400);
    const done = await advance(id, "Bob", { choice: "receive" });
    expect(done.body).toMatchObject({ phase: "playing", pregame: { coin: { mode: "auto", result: "heads", winner: "away", choice: "receive" } } });
    expect((await advance(id, "Bob", { choice: "kick" })).status).toBe(409); // pre-game finished
  });

  it("a correct call makes the caller the winner (server result tails, call tails)", async () => {
    const id = await newMatch();
    rolls = [1, 1, 3, 3]; await advance(id, "Alice"); await advance(id, "Alice"); await advance(id, "Alice");
    await advance(id, "Bob", { team: "away", skip: true }); await advance(id, "Alice", { team: "home", skip: true });
    rolls = [2];
    const flip = await advance(id, "Bob", { mode: "auto", call: "tails", caller: "away" });
    expect(flip.body).toMatchObject({ pregame: { coin: { result: "tails", winner: "away" } } });
  });

  it("a match created with pregame: skip starts at playing", async () => {
    const r = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    expect((r.body as { match: { phase: string } }).match.phase).toBe("playing");
  });

  it("an unknown team value blocks the inducement step", async () => {
    files["Bob/sv_b"] = { ...team("Black Orc", 11, "b", 0), teamValue: undefined };
    const id = await newMatch();
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    expect((await advance(id, "Bob", { team: "away", skip: true })).status).toBe(422);
  });
});

describe("pre-game rules, pure", () => {
  it("weather table", () => {
    expect([2, 3, 4, 7, 10, 11, 12].map(weatherFor)).toEqual(["Sweltering Heat", "Very Sunny", "Perfect Conditions", "Perfect Conditions", "Perfect Conditions", "Pouring Rain", "Blizzard"]);
  });
  it("petty cash: favourite pays from treasury, underdog gets TV gap + favourite spend, top-up capped at 50k, equal TV buys nothing", () => {
    const file = team("Human", 11, "a", 1_000_000, 80_000);
    const base = { file, tvDifference: 50_000 };
    expect(planInducements({ ...base, picks: [{ id: "team_mascot", qty: 1 }], role: "favourite", favouriteSpent: 0 })).toMatchObject({ total: 25_000, treasury: 25_000 });
    expect(planInducements({ ...base, picks: [{ id: "extra_team_training", qty: 1 }], role: "favourite", favouriteSpent: 0 })).toMatchObject({ error: expect.stringContaining("treasury") });
    // underdog: 50k gap + 20k favourite spend = 70k petty cash; 100k purchase = 30k top-up (<= 50k and <= 80k treasury)
    expect(planInducements({ ...base, picks: [{ id: "extra_team_training", qty: 1 }], role: "underdog", favouriteSpent: 20_000 })).toMatchObject({ total: 100_000, treasury: 30_000, pettyCash: 70_000 });
    // 130k purchase would need 60k top-up > 50k cap
    expect(planInducements({ ...base, picks: [{ id: "extra_team_training", qty: 1 }, { id: "weather_mage", qty: 1 }, { id: "temp_agency_cheerleaders", qty: 1 }], role: "underdog", favouriteSpent: 0 }))
      .toMatchObject({ error: expect.stringContaining("at most") });
    expect(planInducements({ ...base, picks: [{ id: "team_mascot", qty: 1 }], role: "equal", favouriteSpent: 0 })).toMatchObject({ error: expect.stringContaining("equal") });
    expect(planInducements({ ...base, picks: [], role: "equal", favouriteSpent: 0 })).toMatchObject({ total: 0 });
    // fixed-price only, per-team restrictions
    expect(planInducements({ ...base, picks: [{ id: "star_players", qty: 1 }], role: "favourite", favouriteSpent: 0 })).toMatchObject({ error: expect.any(String) });
    expect(planInducements({ ...base, picks: [{ id: "mortuary_assistant", qty: 1 }], role: "favourite", favouriteSpent: 0 })).toMatchObject({ error: expect.stringContaining("not available") });
    expect(planInducements({ ...base, picks: [{ id: "team_mascot", qty: 1 }, { id: "team_mascot", qty: 1 }], role: "favourite", favouriteSpent: 0 })).toMatchObject({ error: expect.stringContaining("twice") });
  });
  it("prices come through one swappable source: the dataset today (prayers 10,000), any other source tomorrow", () => {
    const file = team("Human", 11, "a", 1_000_000, 100_000);
    const plan = planInducements({ file, picks: [{ id: "prayers_to_nuffle", qty: 3 }], role: "favourite", tvDifference: 0, favouriteSpent: 0 });
    expect(plan).toMatchObject({ total: 30_000, picks: [{ cost: 30_000, qty: 3 }] });
    const custom = planInducements({
      file, picks: [{ id: "prayers_to_nuffle", qty: 3 }], role: "favourite", tvDifference: 0, favouriteSpent: 0,
      offers: () => ({ name: "Prayers to Nuffle", price: 5_000, max: 3 }),
    });
    expect(custom).toMatchObject({ total: 15_000 });
  });
  it("dataset-driven offers: Halfling Master Chef is cheaper for Halfling teams only; restrictions and the renamed catalogue apply", () => {
    const chef = (race: string, rules: string[] = []) =>
      planInducements({ file: { ...team(race, 11, "a", 1_000_000, 500_000), specialRules: rules }, picks: [{ id: "halfling_master_chef", qty: 1 }], role: "favourite", tvDifference: 0, favouriteSpent: 0 });
    expect(chef("Halfling")).toMatchObject({ total: 100_000 });
    expect(chef("Gnome", ["Halfling Thimble Cup"])).toMatchObject({ total: 300_000 });
    expect(chef("Human")).toMatchObject({ total: 300_000 });
    const file = team("Human", 11, "a", 1_000_000, 500_000);
    for (const id of ["igor", "special_play_cards"])
      expect(planInducements({ file, picks: [{ id, qty: 1 }], role: "favourite", tvDifference: 0, favouriteSpent: 0 })).toMatchObject({ error: expect.stringContaining("Unknown inducement") });
    expect(planInducements({ file, picks: [{ id: "bloodweiser_kegs", qty: 2 }], role: "favourite", tvDifference: 0, favouriteSpent: 0 }))
      .toMatchObject({ total: 100_000, picks: [{ name: "Blitzer's Best Kegs" }] });
    const needs = (id: string, rules: string[]) => planInducements({ file: { ...file, specialRules: rules }, picks: [{ id, qty: 1 }], role: "favourite", tvDifference: 0, favouriteSpent: 0 });
    expect(needs("mortuary_assistant", [])).toMatchObject({ error: expect.stringContaining("not available") });
    expect(needs("mortuary_assistant", ["Masters of Undeath"])).toMatchObject({ total: 100_000 });
    expect(needs("plague_doctor", ["Favoured of Nurgle"])).toMatchObject({ total: 100_000 });
    expect(needs("riotous_rookies", ["Low Cost Linemen"])).toMatchObject({ total: 150_000 });
  });
  it("inducement treasury spending comes off the treasury in a full post-match", () => {
    const f = team("Human", 11, "a", 1_000_000, 100_000);
    const ev: TabletopEvent = { id: "pg-inducement-home", matchId: "m", type: "inducement", team: "home", payload: { total: 100_000, treasury: 40_000 }, ts: "t", by: "x" };
    const full = applyPostMatch(f, [ev], { team: "home", postMatch: "full", ruleset: "bb2025" });
    expect(full.teamFile.treasury).toBe(60_000);
    expect(applyPostMatch(f, [ev], { team: "home", postMatch: "spp-only", ruleset: "bb2025" }).teamFile.treasury).toBe(100_000);
  });
});

// ---- the new game events -----------------------------------------------------------------------------------------
const roster = (): RosterPair => ({ home: team("Human", 3, "h", 0), away: team("Human", 3, "a", 0) });
let n = 0;
const ev = (type: string, side: string | undefined, who: string | undefined, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): TabletopEvent => {
  n += 1;
  const p = parseEvent({ id: `new-${String(n).padStart(6, "0")}`, type, team: side, player: who, payload, ...extra }, "m", "alice", "t");
  if (!p.ok) throw new Error(p.error);
  return p.event;
};
const run = (events: TabletopEvent[]) => {
  const stored: TabletopEvent[] = [];
  for (const e of events) {
    const v = validateEvent(e, stored, roster());
    if ("error" in v) return { error: v.error, stored };
    stored.push(v.event);
  }
  return { stored };
};
const err = (events: TabletopEvent[]) => (run(events) as { error?: string }).error;

describe("TourPlay event set", () => {
  it("injury (non-casualty), catch, foul, stalling: need an available player; injury needs stunned or KO", () => {
    expect(err([ev("injury", "home", "h1", { result: "KO" }), ev("injury", "away", "a1", { result: "stunned" })])).toBeUndefined();
    expect(err([ev("injury", "home", "h1", { result: "BH" })])).toMatch(/stunned, KO/);
    expect(err([ev("injury", "home", "a1", { result: "KO" })])).toMatch(/not on the home team/);
    for (const t of ["catch", "foul", "stalling"]) {
      expect(err([ev(t, "home", "h1")])).toBeUndefined();
      expect(err([ev(t, "home", undefined)])).toMatch(/needs a player/);
    }
  });
  it("throwTeamMate: completion gives 1 SPP; a failed throw and the record-only events give none", () => {
    expect(err([ev("throwTeamMate", "home", "h1", { completed: "yes" })])).toMatch(/boolean/);
    expect(err([ev("throwTeamMate", "home", "h1", { target: "a1" })])).toMatch(/same team/);
    const events = [
      ev("throwTeamMate", "home", "h1", { completed: true, target: "h2" }), ev("throwTeamMate", "home", "h1", { completed: false }),
      ev("catch", "home", "h2"), ev("foul", "home", "h3"), ev("stalling", "home", "h3"), ev("injury", "away", "a1", { result: "KO" }),
      ev("secretObjective", "home", undefined, { text: "Score twice" }),
    ];
    const stored = (run(events) as { stored: TabletopEvent[] }).stored;
    const res = applyPostMatch(team("Human", 3, "h", 0), stored, { team: "home", postMatch: "spp-only", ruleset: "bb2025" });
    expect(res.teamFile.players.map((p) => p.spp)).toEqual([1, 0, 0]);
    const tally = tallyMatch(stored);
    expect(tally.lines.home.get("h2")!.catches).toBe(1);
    expect(tally.lines.home.get("h3")!.fouls).toBe(1);
  });
  it("secretObjective needs text; sentOff is an alias of sendOff", () => {
    expect(err([ev("secretObjective", "home", undefined, {})])).toMatch(/payload.text/);
    expect(err([ev("secretObjective", "home", undefined, { text: "x".repeat(201) })])).toMatch(/payload.text/);
    const e = ev("sentOff", "home", "h1");
    expect(e.type).toBe("sendOff");
    expect(err([e, ev("catch", "home", "h1")])).toMatch(/sent off/);
  });
  it("mid-game weather is coach-entered from the table; rolls and pre-game markers are server-only", () => {
    expect(err([ev("weather", undefined, undefined, { result: "Blizzard" })])).toBeUndefined();
    expect(err([ev("weather", undefined, undefined, { result: "Monsoon" })])).toMatch(/must be one of/);
    expect(err([ev("weather", undefined, undefined, { result: "Blizzard", roll: 12 })])).toMatch(/server-only/);
    expect(err([ev("weather", undefined, undefined, { result: "Blizzard", pregame: true })])).toMatch(/server-only/);
  });
  it("concede ends the match: only endOfMatch may follow, and the flag is tallied", () => {
    expect(err([ev("concede", "away", undefined), ev("touchdown", "home", "h1")])).toMatch(/conceded/);
    expect(err([ev("concede", "away", undefined), ev("endOfMatch", undefined, undefined)])).toBeUndefined();
    expect(err([ev("concede", "away", undefined), ev("concede", "home", undefined)])).toMatch(/conceded/);
    const stored = (run([ev("touchdown", "home", "h1"), ev("concede", "away", undefined)]) as { stored: TabletopEvent[] }).stored;
    expect(tallyMatch(stored).conceded).toEqual({ home: false, away: true });
    expect(tallyMatch(stored).score).toEqual({ home: 1, away: 0 });
  });
  it("half is 1, 2 or OT (legacy 3 = OT) and turn is 1-8; the tally carries the latest clock", () => {
    expect(ev("touchdown", "home", "h1", {}, { half: "OT", turn: 8 })).toMatchObject({ half: "OT", turn: 8 });
    expect(ev("touchdown", "home", "h1", {}, { half: 3 }).half).toBe("OT");
    for (const bad of [{ half: 4 }, { half: "x" }, { turn: 0 }, { turn: 9 }]) {
      expect(parseEvent({ id: "bad-00000001", type: "touchdown", team: "home", player: "h1", ...bad }, "m", "a", "t")).toMatchObject({ ok: false });
    }
    const stored = (run([ev("touchdown", "home", "h1", {}, { half: 1, turn: 3 }), ev("completion", "home", "h2", {}, { half: 2, turn: 5 })]) as { stored: TabletopEvent[] }).stored;
    expect(tallyMatch(stored).clock).toEqual({ half: 2, turn: 5 });
  });
  it("SPP matrix is unchanged for the original events", () => {
    const stored = (run([
      ev("touchdown", "home", "h1"), ev("completion", "home", "h2"), ev("interception", "home", "h2"), ev("deflection", "home", "h3"), ev("mvp", "home", "h3"),
      ev("casualty", "home", "h1", { victim: "a1", result: "BH" }),
    ]) as { stored: TabletopEvent[] }).stored;
    const res = applyPostMatch(team("Human", 3, "h", 0), stored, { team: "home", postMatch: "spp-only", ruleset: "bb2025" });
    expect(res.teamFile.players.map((p) => p.spp)).toEqual([5, 2, 5]);
    expect(effectiveEvents(stored)).toHaveLength(6);
  });
});

describe("endOfMatch and the server tally over the API", () => {
  it("endOfMatch records the event and submits the match; the tally carries score and clock", async () => {
    const r0 = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    const id = (r0.body as { match: { id: string } }).match.id;
    const r = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, {
      events: [{ ...E("touchdown", "home", "a1"), half: 2, turn: 4 }, E("endOfMatch", undefined)],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ submitted: true, match: { state: "submitted" }, tally: { score: { home: 1, away: 0 }, clock: { half: 2, turn: 4 } } });
  });
});

describe("one phone, stats and per-event SPP", () => {
  it("the tally counts only the latest inducement submission per team", async () => {
    const id = await newMatch();
    rolls = [1, 1, 3, 3];
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    await advance(id, "Org", { team: "away", picks: [{ id: "bribes", qty: 2 }] });
    await advance(id, "Bob", { team: "away", picks: [{ id: "team_mascot", qty: 1 }] }); // replaces
    const g = await get(id);
    expect(g.tally.treasurySpent).toEqual({ home: 0, away: 25_000 });
    expect(g.pregame.inducements.away).toMatchObject({ total: 25_000, submittedBy: "Bob" });
  });

  it("team files carry position names and characteristics (library: current stats; builder: base plus recorded increases; journeymen too)", async () => {
    const id = await newMatch();
    const g = await get(id);
    void g;
    const { teamFileFromSave, positionStats } = await import("../src/tabletop/teamFile.js");
    const { bb2025 } = await import("@bb/validator/dataset");
    const human = bb2025.rosters.Human!;
    const lineman = human.positions.find((p) => p.id === "human.human_lineman")!;
    const base = positionStats(lineman);
    expect(base).toMatchObject({ positionName: "Human Lineman", ma: lineman.MA, st: lineman.ST });
    const file = teamFileFromSave({
      name: "T", rosterId: "human", body: { picks: [{ positionId: "human.human_lineman", count: 2, chosenStatIncreases: ["MA", "AG", "AV"] }, { positionId: "human.human_lineman", count: 1 }] },
    } as never);
    expect(file.players[0]).toMatchObject({ positionName: "Human Lineman", ma: base.ma + 1, st: base.st, ag: base.ag - 1, av: base.av + 1 });
    expect(file.players[2]).toMatchObject({ positionName: "Human Lineman", ma: base.ma, ag: base.ag, av: base.av });
    // journeymen come with the position's stats, and the match GET exposes them under teams
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    const after = await get(id);
    const jm = after.teams.home.players.find((p: TabletopPlayer) => p.journeyman);
    expect(jm).toMatchObject({ positionName: "Human Lineman", ma: base.ma, st: base.st, ag: base.ag, av: base.av });
  });

  it("SPP per effective event comes from the server (feed and tally); undone and non-SPP events earn nothing", async () => {
    const r0 = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    const id = (r0.body as { match: { id: string } }).match.id;
    const td = E("touchdown", "home", "a1");
    const cas = E("casualty", "home", "a2", { victim: "b1", result: "BH" });
    const foulCas = E("casualty", "home", "a3", { victim: "b2", result: "BH", cause: "foul" });
    const catchEv = E("catch", "home", "a4");
    const ttm = E("throwTeamMate", "home", "a5", { completed: true });
    const mvp = E("mvp", "away", "b3");
    const undone = E("completion", "home", "a6");
    const posted = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [td, cas, foulCas, catchEv, ttm, mvp, undone] });
    expect(posted.status).toBe(200);
    const undo = E("undo", "home", undefined, { target: undone.id });
    const afterUndo = (await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [undo] })).body as { tally: { events: Array<{ id: string; sppEarned: number }> } };
    const spp = Object.fromEntries(afterUndo.tally.events.map((e) => [e.id, e.sppEarned]));
    expect(spp).toEqual({ [td.id]: 3, [cas.id]: 2, [foulCas.id]: 0, [catchEv.id]: 0, [ttm.id]: 1, [mvp.id]: 4 }); // the undone completion is gone
    const g = await get(id);
    const feed = Object.fromEntries((g.events as Array<{ id: string; sppEarned: number }>).map((e) => [e.id, e.sppEarned]));
    expect(feed[td.id]).toBe(3);
    expect(feed[undone.id]).toBe(0);
    expect(feed[undo.id]).toBe(0);
    // per-event SPP adds up to the per-player totals
    const sum = (arr: Array<{ sppEarned: number }>) => arr.reduce((n, e) => n + e.sppEarned, 0);
    const players = [...g.tally.players.home, ...g.tally.players.away] as Array<{ sppEarned: number }>;
    expect(sum(g.tally.events)).toBe(sum(players));
  });
});
