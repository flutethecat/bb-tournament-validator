import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { importLeague } from "../scripts/import-tourplay-league";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import {
  AGENT_FEE, baseFor, DEFAULT_CAP, feeSeasons, nigglesAfter, redraftBudget, RedraftError, rehireQuote, restAndRelaxation, restTarget, spendable,
  teamRecord, validateDraft, datasetRoster, type DraftContext,
} from "../src/leagues/redraft";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { EMPTY_PLAYER_STATS } from "../src/leagues/types";

// League redraft (src/leagues/redraft.ts, redraftApi.ts): budget maths, Rest & Relaxation, re-hire costs, draft
// validation, the organiser board and the coach's submit, seasonsPlayed at import.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";

const pl = (n: number, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: `p-orc${n}`, careerKey: `c-orc${n}`, number: n, name: `Orc ${n}`, position, ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills: [],
  value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0, ...over,
});

const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", coachId: "Ann", teamValue: 1000000, treasury: 50000, rerolls: 2, fans: 1,
  assistantCoaches: 1, cheerleaders: 0, apothecary: true, tier: "1", raceLeague: "",
  players: [
    pl(1, "Orc Blitzer", { value: 105000, seasonsPlayed: 2, niggling: 1, missNextGame: true, availableSpp: 12 }),
    pl(2, "Orc Blitzer"),
    ...Array.from({ length: 10 }, (_, i) => pl(i + 3, "Orc Lineman")),
  ],
  formerPlayers: [],
});
const elves = (): LeagueTeam => ({
  id: "elves", name: "Elves", race: "Wood Elf", coach: "Bob", coachId: "Bob", teamValue: 1000000, treasury: 0, rerolls: 1, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [pl(1, "Wood Elf Lineman", { playerId: "p-elf1", careerKey: "c-elf1", name: "Elf 1", value: 65000 })], formerPlayers: [],
});
const goblins = (): LeagueTeam => ({ ...elves(), id: "gobbos", name: "Gobbos", race: "Goblin", coach: "Cat", coachId: "Cat", players: [], treasury: 20000 });

const fx = (id: string, home: [string, number | null], away: [string, number | null], over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: home[0], teamId: home[0].toLowerCase(), coach: "", race: "", score: home[1], cas: 0, conceded: false },
  away: { team: away[0], teamId: away[0].toLowerCase(), coach: "", race: "", score: away[1], cas: 0, conceded: false },
  suspended: false, ...over,
});

const season = (number: number, status: "active" | "completed", teams: LeagueTeam[], fixtures: LeagueFixture[] = []): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

/** Season 6 (finished): Orcs 2 wins + 1 draw in 3 games (one unplayed); Elves 1 draw 2 losses. Season 5 has Gobbos (inactive). */
const s6Fixtures = (): LeagueFixture[] => [
  fx("f1", ["Orcs", 2], ["Elves", 1]),
  fx("f2", ["Elves", 1], ["Orcs", 1]),
  fx("f3", ["Orcs", 0], ["Elves", 0], { away: { team: "Elves", teamId: "elves", coach: "", race: "", score: 0, cas: 0, conceded: true } }),
  fx("f4", ["Orcs", null], ["Elves", null]),
];

describe("redraft maths", () => {
  it("budget: base + treasury + 20k per game + 20k per win + 10k per draw; cap on / off; override", () => {
    const b = redraftBudget({ base: 1_000_000, treasury: 50_000, played: 3, wins: 2, draws: 1 }, { enabled: true, cap: DEFAULT_CAP });
    expect(b).toEqual({ base: 1_000_000, treasury: 50_000, played: 3, wins: 2, draws: 1, bonus: 60_000 + 40_000 + 10_000, raw: 1_160_000, capped: 1_160_000 });
    const rich = redraftBudget({ base: 1_000_000, treasury: 400_000, played: 10, wins: 8, draws: 2 }, { enabled: true, cap: DEFAULT_CAP });
    expect(rich.raw).toBe(1_000_000 + 400_000 + 200_000 + 160_000 + 20_000);
    expect(rich.capped).toBe(1_300_000); // excess lost
    expect(redraftBudget({ base: 1_000_000, treasury: 400_000, played: 10, wins: 8, draws: 2 }, { enabled: false, cap: DEFAULT_CAP }).capped).toBe(1_780_000);
    expect(spendable({ budget: rich })).toBe(1_300_000);
    expect(spendable({ budget: rich, override: { budget: 900_000, reason: "late fees", by: "Jay", at: "" } })).toBe(900_000);
    // the base follows the season's Team building treasury for the roster
    const rules = { rules: { teamBuilding: { eliteSkills: [], rosters: [{ roster: "Orc", tier: 2, treasury: 1100, startingSkills: { primary: 0, secondary: 0, elite: 0 } }] } } };
    expect(baseFor(rules, "Orc")).toBe(1_100_000);
    expect(baseFor(rules, "Wood Elf")).toBe(1_000_000);
    expect(baseFor(undefined, "Orc")).toBe(1_000_000);
  });

  it("team record counts results only (a concession is a loss for the conceder)", () => {
    const s = season(6, "completed", [orcs(), elves()], s6Fixtures());
    expect(teamRecord(s, orcs())).toEqual({ played: 3, wins: 2, draws: 1, losses: 0 });
    expect(teamRecord(s, elves())).toEqual({ played: 3, wins: 0, draws: 1, losses: 2 });
  });

  it("Rest & Relaxation: 4+ without an Apothecary, 3+ with; site rolls vs entered results; MNG cleared later", () => {
    expect(restTarget(false)).toBe(4);
    expect(restTarget(true)).toBe(3);
    const team = { apothecary: true, players: [pl(1, "Orc Lineman", { niggling: 2 }), pl(2, "Orc Lineman")] };
    const dice = [3, 2];
    const site = restAndRelaxation(team, "site", {}, () => dice.shift()!);
    expect(site).toEqual([
      { playerId: "p-orc1", roll: 3, target: 3, recovered: true, source: "site" },
      { playerId: "p-orc1", roll: 2, target: 3, recovered: false, source: "site" },
    ]);
    expect(nigglesAfter(team.players[0]!, site)).toBe(1);
    const noApo = restAndRelaxation({ ...team, apothecary: false }, "entered", { "p-orc1": [3, 4] });
    expect(noApo.map((r) => [r.roll, r.target, r.recovered, r.source])).toEqual([[3, 4, false, "entered"], [4, 4, true, "entered"]]);
    expect(() => restAndRelaxation(team, "entered", { "p-orc1": [3] })).toThrow(/Enter 2 results/);
    expect(() => restAndRelaxation(team, "entered", { "p-orc1": [3, 7] })).toThrow(RedraftError);
  });

  it("re-hire cost = current value + 20k x seasons (earlier seasons + the finished one when the team played)", () => {
    const roster = datasetRoster("Orc");
    const veteran = pl(1, "Orc Blitzer", { value: 105000, seasonsPlayed: 2 });
    expect(feeSeasons(veteran, true)).toBe(3);
    expect(feeSeasons(veteran, false)).toBe(2);
    expect(rehireQuote(veteran, true, roster)).toMatchObject({ value: 105000, seasons: 3, fee: 3 * AGENT_FEE, cost: 165000 });
    // no recorded value: the position's cost
    expect(rehireQuote(pl(5, "Orc Lineman", { value: null }), true, roster)).toMatchObject({ value: 50000, seasons: 1, cost: 70000 });
  });

  it("validation: over budget, duplicate keep, other team's player, position limits, roster size, staff", () => {
    const s = season(6, "completed", [orcs()], s6Fixtures());
    const team = s.teams[0]!;
    const ctx = (budget = 1_160_000): DraftContext => ({
      task: { teamId: "orcs", sourceSeasonId: "season-6", name: "Orcs", coach: "Ann", race: "Orc", selected: true, status: "pending",
        budget: redraftBudget({ base: 1_000_000, treasury: 50_000, played: 3, wins: 2, draws: 1 }, { enabled: true, cap: DEFAULT_CAP }), ...(budget !== 1_160_000 ? { override: { budget, reason: "x", by: "Jay", at: "" } } : {}) },
      source: s, team, roster: datasetRoster("Orc"), teamPlayed: true,
    });
    const staff = { rerolls: 2, assistantCoaches: 1, cheerleaders: 0, apothecary: true };
    const all = team.players.map((p) => p.playerId);
    const ok = validateDraft(ctx(), { keep: all, hires: [], staff });
    // 1 blitzer 105k + (2*0 seasons earlier +1)*20k fee each; 2 rerolls 120k, AC 10k, apo 50k
    expect(ok.players).toBe(12);
    expect(ok.spent).toBe(105000 + 60000 + 70000 + 10 * 70000 + 120000 + 10000 + 50000);
    expect(ok.remaining).toBe(1_160_000 - ok.spent);
    expect(() => validateDraft(ctx(900_000), { keep: all, hires: [], staff })).toThrow(/over the budget of 900k/);
    expect(() => validateDraft(ctx(), { keep: [...all.slice(0, 11), all[0]!], hires: [], staff })).toThrow(/kept twice/);
    expect(() => validateDraft(ctx(), { keep: [...all.slice(0, 11), "p-elf1"], hires: [], staff })).toThrow(/not on this team/);
    expect(() => validateDraft(ctx(), { keep: all.slice(0, 10), hires: [], staff })).toThrow(/at least 11 players/);
    expect(() => validateDraft(ctx(), { keep: all.slice(0, 11), hires: [{ position: "Orc Blitzer", count: 1 }], staff })).toThrow(/At most 2 Orc Blitzers/);
    expect(() => validateDraft(ctx(), { keep: all.slice(0, 11), hires: [{ position: "Troll", count: 2 }], staff })).toThrow(/At most 1 Troll/);
    expect(() => validateDraft(ctx(), { keep: all.slice(0, 11), hires: [{ position: "Treeman", count: 1 }], staff })).toThrow(/not a Orc position/);
    expect(() => validateDraft(ctx(), { keep: all.slice(0, 11), hires: [], staff: { ...staff, rerolls: 9 } })).toThrow(/At most 8 rerolls/);
    expect(() => validateDraft(ctx(), { keep: all, hires: [{ position: "Orc Lineman", count: 5 }], staff })).toThrow(/at most 16 players/);
  });
});

describe("redraft routes", () => {
  let dir: string;
  let store: LeagueStore;
  let notes: Array<{ coach: string; title: string; body: string; link: string }>;
  let posts: DiscordPayload[];
  let dice: number[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-redraft-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
    store.putSeason(season(5, "completed", [goblins(), { ...elves(), players: [pl(1, "Wood Elf Lineman", { playerId: "p-elf1-s5", careerKey: "c-elf1", name: "Elf 1" })] }], [fx("g1", ["Gobbos", 1], ["Elves", 0])]));
    store.putSeason(season(6, "completed", [orcs(), elves()], s6Fixtures()));
    notes = [];
    posts = [];
    dice = [];
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const call = async (method: string, path: string, who: { coach: string; admin?: boolean } | undefined, body?: unknown, over: Partial<LeagueApiDeps> = {}): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path.split("?")[0]!, new URLSearchParams(path.split("?")[1] ?? ""), who ? { coach: who.coach, admin: who.admin ?? false } : undefined, {
      store,
      readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
      notify: (coach, input) => notes.push({ coach, title: input.title, body: input.body, link: input.link }),
      postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
      rollD6: () => dice.shift() ?? 6,
      now: () => new Date("2026-11-01T12:00:00.000Z"),
      ...over,
    });
    return r!;
  };
  const JAY = { coach: "Jay" };
  const ANN = { coach: "ann" };
  const BOB = { coach: "Bob" };
  type Board = { redraft: { revision: number; active: Array<{ teamId: string; budget: { capped: number; raw: number }; selected: boolean; status?: string; players: Array<{ seasons: number }> }>; inactive: Array<{ teamId: string }>; state: { log: Array<{ text: string }> } | null } };

  async function confirm(): Promise<void> {
    const r = await call("POST", "/api/leagues/tabbl/redraft", JAY, {
      revision: 0, action: "confirm", capEnabled: true, cap: DEFAULT_CAP,
      teams: [{ teamId: "orcs", selected: true }, { teamId: "elves", selected: false }, { teamId: "gobbos", selected: true, override: { budget: 1_050_000, reason: "Returning team" } }],
    });
    expect(r.status).toBe(200);
  }

  it("board gating: anonymous 401, other coach 403, organiser and admin see active + inactive teams with budgets", async () => {
    expect((await call("GET", "/api/leagues/tabbl/redraft", undefined)).status).toBe(401);
    expect((await call("GET", "/api/leagues/tabbl/redraft", BOB)).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft", BOB, { revision: 0, action: "close" })).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/redraft", { coach: "Root", admin: true })).status).toBe(200);
    const r = await call("GET", "/api/leagues/tabbl/redraft", JAY);
    expect(r.status).toBe(200);
    expect(r.headers?.["cache-control"]).toBe("no-store");
    const b = (r.body as Board).redraft;
    expect(b.active.map((x) => x.teamId)).toEqual(["elves", "orcs"]);
    expect(b.inactive.map((x) => x.teamId)).toEqual(["gobbos"]);
    const o = b.active.find((x) => x.teamId === "orcs")!;
    expect(o.budget.raw).toBe(1_000_000 + 50_000 + 3 * 20_000 + 2 * 20_000 + 10_000);
    expect(o.players[0]!.seasons).toBe(3);
    expect(b.state).toBeNull();
  });

  it("confirm: revision required (428) / stale (409), tasks for selected teams, coach notices, Discord, log", async () => {
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { action: "confirm", capEnabled: true, teams: [] })).status).toBe(428);
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 4, action: "confirm", capEnabled: true, teams: [] })).status).toBe(409);
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 0, action: "confirm", capEnabled: true, teams: [{ teamId: "orcs", selected: false }] })).status).toBe(400);
    await confirm();
    const s6 = store.season("tabbl", "season-6")!;
    expect(s6.redraft!.revision).toBe(1);
    expect(s6.redraft!.teams.find((t) => t.teamId === "orcs")).toMatchObject({ selected: true, status: "pending" });
    expect(s6.redraft!.teams.find((t) => t.teamId === "elves")).toMatchObject({ selected: false, status: "skipped" });
    expect(s6.redraft!.teams.find((t) => t.teamId === "gobbos")).toMatchObject({ sourceSeasonId: "season-5", override: { budget: 1_050_000, reason: "Returning team", by: "Jay" } });
    expect(notes.map((n) => n.coach).sort()).toEqual(["Ann", "Cat"]);
    expect(notes[0]!.link).toMatch(/^\/app\/leagues\/tabbl\/redraft\?team=/);
    expect(posts[0]!.embeds[0]!.title).toBe("TABBL: Redraft started");
    expect(store.league("tabbl")!.redraftCap).toEqual({ enabled: true, cap: DEFAULT_CAP });
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 1, action: "confirm", capEnabled: true, teams: [{ teamId: "orcs", selected: true }] })).status).toBe(409);
    // per-team override after confirmation
    const ov = await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 1, action: "team", teamId: "orcs", override: { budget: 1_200_000, reason: "Prize money" } });
    expect(ov.status).toBe(200);
    expect(notes.at(-1)).toMatchObject({ coach: "Ann", title: "Redraft budget changed" });
    expect((await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 2, action: "team", teamId: "orcs", override: { budget: 1, reason: "" } })).status).toBe(400);
    const board = (await call("GET", "/api/leagues/tabbl/redraft", JAY)).body as Board;
    expect(board.redraft.state!.log[0]!.text).toContain("set Orcs's budget to 1,200k");
  });

  it("coach flow: other coach 403, Rest & Relaxation once, submit validates, writes the draft list, organisers told", async () => {
    await confirm();
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", BOB)).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", undefined)).status).toBe(401);
    expect((await call("GET", "/api/leagues/tabbl/redraft/teams/elves", BOB)).status).toBe(404); // not selected
    const view = await call("GET", "/api/leagues/tabbl/redraft/teams/orcs", ANN);
    expect(view.status).toBe(200);
    const v = (view.body as { redraft: { revision: number; spendable: number; rest: { target: number; needed: unknown[] }; players: Array<{ playerId: string; cost: number }> } }).redraft;
    expect(v.rest.target).toBe(3);
    expect(v.rest.needed).toHaveLength(1);
    expect(v.players[0]).toMatchObject({ playerId: "p-orc1", cost: 105000 + 3 * AGENT_FEE });
    const keep = v.players.map((p) => p.playerId);
    const staff = { rerolls: 2, assistantCoaches: 1, cheerleaders: 0, apothecary: true };
    // R&R first
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { revision: 1, keep, hires: [], staff })).status).toBe(409);
    dice = [3];
    const rr = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: 1, mode: "site" });
    expect(rr.status).toBe(200);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: 2, mode: "site" })).status).toBe(409);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", BOB, { revision: 2, keep, hires: [], staff })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { keep, hires: [], staff })).status).toBe(428);
    const over = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { revision: 2, keep, hires: [], staff: { ...staff, rerolls: 8 } });
    expect(over.status).toBe(400);
    expect((over.body as { error: string }).error).toContain("over the budget");
    const ok = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { revision: 2, keep: keep.slice(1), hires: [{ position: "Troll", count: 1 }], staff });
    expect(ok.status).toBe(200);
    const task = store.season("tabbl", "season-6")!.redraft!.teams.find((t) => t.teamId === "orcs")!;
    expect(task.status).toBe("submitted");
    expect(task.appliedTo).toBeUndefined(); // no season 7 yet: the list waits on the task
    const drafted = task.draft!.team;
    expect(drafted.players).toHaveLength(12);
    expect(drafted.players.some((p) => p.previousIds?.includes("p-orc1"))).toBe(false); // released = retired
    const linemen = drafted.players.find((p) => p.previousIds?.includes("p-orc3"))!;
    expect(linemen.seasonsPlayed).toBe(1);
    expect(linemen.careerKey).toBe("c-orc3");
    expect(drafted.players.find((p) => p.position === "Troll")).toMatchObject({ seasonsPlayed: 0, value: 115000, level: "Rookie" });
    expect(drafted.treasury).toBe(task.draft!.treasury);
    expect(notes.at(-1)).toMatchObject({ coach: "Jay", title: "Redraft submitted" });
    expect(posts.at(-1)!.embeds[0]!.title).toBe("TABBL: Orcs redrafted");
    // the old roster stays under the finished season
    expect(store.season("tabbl", "season-6")!.teams.find((t) => t.id === "orcs")!.players).toHaveLength(12);
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { revision: 3, keep, hires: [], staff })).status).toBe(409);
    // My tasks (team management panel)
    const mine = await call("GET", "/api/leagues?redraft=mine", ANN);
    expect((mine.body as { tasks: Array<{ teamId: string; status: string }> }).tasks).toEqual([expect.objectContaining({ teamId: "orcs", status: "submitted" })]);
    expect((await call("GET", "/api/leagues?redraft=mine", undefined)).status).toBe(401);
    // Start a new season: the waiting draft list becomes a season 7 team, with R&R applied (niggle healed, MNG cleared)
    const started = await call("POST", "/api/leagues/tabbl/seasons", JAY, {});
    expect(started.status).toBe(201);
    const s7 = store.season("tabbl", "season-7")!;
    expect(s7.teams.map((t) => t.id)).toEqual(["orcs"]);
    expect(s7.participants.map((p) => p.team)).toEqual(["Orcs"]);
    expect(store.season("tabbl", "season-6")!.redraft!.teams.find((t) => t.teamId === "orcs")!.appliedTo).toBe("season-7");
  });

  it("submit with an existing next season writes straight into it; entered R&R results; close skips the rest", async () => {
    await confirm();
    // gobbos (inactive, no players): no R&R needed; season 7 exists without results
    store.putSeason(season(7, "active", []));
    const v = (await call("GET", "/api/leagues/tabbl/redraft/teams/gobbos", { coach: "Cat" })).body as { redraft: { spendable: number; targetSeason: { id: string } } };
    expect(v.redraft.spendable).toBe(1_050_000);
    expect(v.redraft.targetSeason.id).toBe("season-7");
    const ok = await call("POST", "/api/leagues/tabbl/redraft/teams/gobbos/submit", JAY, {
      revision: 1, keep: [], hires: [{ position: "Goblin Lineman", count: 11 }], staff: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false },
    });
    expect(ok.status).toBe(200);
    expect(store.season("tabbl", "season-7")!.teams.find((t) => t.id === "gobbos")!.players).toHaveLength(11);
    const rr = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: 2, mode: "entered", rolls: { "p-orc1": [2] } });
    expect(rr.status).toBe(200);
    const task = store.season("tabbl", "season-6")!.redraft!.teams.find((t) => t.teamId === "orcs")!;
    expect(task.rest!.rolls).toEqual([{ playerId: "p-orc1", roll: 2, target: 3, recovered: false, source: "entered" }]);
    const closed = await call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 3, action: "close" });
    expect(closed.status).toBe(200);
    expect(store.season("tabbl", "season-6")!.redraft!.teams.find((t) => t.teamId === "orcs")!.status).toBe("skipped");
    expect(posts.at(-1)!.embeds[0]!.title).toBe("TABBL: Redraft closed");
    expect((await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/submit", ANN, { revision: 4, keep: [], hires: [], staff: {} })).status).toBe(409);
  });
});

describe("seasonsPlayed at import (TourPlay exports, scratch state dir)", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
  const BOM = String.fromCharCode(0xfeff);
  const csv = (lines: string[]): string => BOM + lines.join("\r\n") + "\r\n";
  const FIX_HEAD = "Category;Phase;Group;Round;Table;TeamNameHome;TeamNameAway;CoachHome;CoachAway;TeamRaceHome;TeamRaceAway;NafUserHome;NafUserAway;ScoreHome;ScoreAway;CasualtiesHome;CasualtiesAway;Suspended;ConcedeHome;ConcedeAway;UtcStart;UtcFinish";
  const ROSTER_HEAD = "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet";
  const PLAYER_HEAD = "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame";
  const roster = (team: string, race: string, coach: string, players: string[]): string =>
    csv([ROSTER_HEAD, `${team};${race};${coach};1000000;0;2;1;0;0;False;1;;;;BB2025`, " ", PLAYER_HEAD, ...players, " ", "Inducement;Quantity;Value"]);
  const player = (n: number, name: string): string => `${n};${name};Lineman;6;3;3;4;9;;50000;Rookie;0;;`;

  function writeExport(root: string, slug: string, played: boolean, hammers: string[]): void {
    const dir = join(root, `${slug}-data`);
    mkdirSync(dir, { recursive: true });
    const score = played ? "2;1" : ";";
    writeFileSync(join(dir, `${slug}-fixtures.csv`), csv([FIX_HEAD, `Season;Regular;;1;1;Hammers;Ghosts;Ann;Bea;Dwarf;Undead;;;${score};0;0;;;;2026-06-01T00:00:00Z;2026-06-01T02:00:00Z`]));
    writeFileSync(join(dir, "hammers-roster.csv"), roster("Hammers", "Dwarf", "Ann", hammers.map((n, i) => player(i + 1, n))));
    writeFileSync(join(dir, "ghosts-roster.csv"), roster("Ghosts", "Undead", "Bea", [player(9, "Vi")]));
  }

  it("counts earlier seasons on a roster whose team played; a season without games does not count", async () => {
    const root = mkdtempSync(join(tmpdir(), "league-sp-exp-"));
    const stateDir = mkdtempSync(join(tmpdir(), "league-sp-state-"));
    dirs.push(root, stateDir);
    writeExport(root, "tabbl---season-1", true, ["Una", "Old"]);
    writeExport(root, "tabbl---season-2", false, ["Una", "Old"]); // no games played
    writeExport(root, "tabbl---season-3", true, ["Una", "Newt"]);
    writeExport(root, "tabbl---season-4", true, ["Una", "Newt"]);
    await importLeague({ league: "tabbl", name: "TABBL", fullName: "TABBL", exports: root, stateDir, identities: undefined, log: () => undefined });
    const store = new LeagueStore(stateDir);
    const sp = (n: number, name: string) => store.season("tabbl", `season-${n}`)!.teams.find((t) => t.name === "Hammers")!.players.find((p) => p.name === name)!.seasonsPlayed;
    expect([sp(1, "Una"), sp(2, "Una"), sp(3, "Una"), sp(4, "Una")]).toEqual([0, 1, 1, 2]);
    expect([sp(3, "Newt"), sp(4, "Newt")]).toEqual([0, 1]);
    expect(sp(2, "Old")).toBe(1);
  });
});
