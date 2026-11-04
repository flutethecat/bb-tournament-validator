import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budgetFor, gateOf, inducementStep, newLobby, planSide, resolveStart, sideHasStep, tvRoles } from "../src/fixtureLobby/core";
import { leagueLobbyRules, lobbyRulesFor } from "../src/fixtureLobby/league";
import type { LobbyFixture, LobbyRecord, LobbyRules, LobbyTeam } from "../src/fixtureLobby/types";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { effectiveInducements, seasonInducementOffers } from "../src/leagues/inducements";
import {
  BB2025_RULEBOOK_WINNINGS, DEFAULT_MONEY_RULES, LEGACY_MONEY, MoneyRulesError, applyTreasuryCap, computeWinnings, effectiveMoneyRules, forfeitWinnings, isHundredths,
  lobbyBudget, matchMoney, moneyRulesDiff, moneySnapshot, overridePayload, parseMoneyRules, type MoneyRules,
} from "../src/leagues/moneyRules";
import { applyForfeit, forfeitModel } from "../src/leagues/forfeit";
import { LeagueStore } from "../src/leagues/store";
import { leagueFixtureView, recordLeagueFixture } from "../src/leagues/tabletopFixtures";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import { tabletopApi, type FixtureGateway, type FixtureView, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api";
import type { TabletopEvent } from "../src/tabletop/events";
import { applyPostMatch, type TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";

// League money rules (src/leagues/moneyRules.ts; owner 11-04, round 2 item 3): the defaults keep every number the site
// produced before, each option changes only what it says, a competition override falls back to the league, and a
// result keeps the rules it started with. Fake data only.

const rules = (over: Partial<MoneyRules> = {}): MoneyRules => ({ ...DEFAULT_MONEY_RULES, ...over });

describe("money rules: the maths", () => {
  it("the defaults are the site's fixed rule: 10k per touchdown, nothing for attendance, stalling, results or concessions", () => {
    const r = rules();
    for (const [f, a, conceded] of [[0, 0, false], [2, 1, false], [1, 3, false], [3, 0, true]] as const) {
      const w = computeWinnings(r, { score: { for: f, against: a }, attendance: 9, stalled: false, conceded: { self: conceded, other: false } });
      expect(w.winnings).toBe(f * 10_000);
    }
    expect(lobbyBudget(r)).toEqual({ pettyCash: true, treasuryTopUp: true, fixedBudget: 0 });
    expect(applyTreasuryCap(r, 9_000_000, 3, 6)).toEqual({ treasury: 9_000_000, fans: 3, lost: 0, fansGained: 0 });
  });

  it("the BB2025 rulebook formula: half the attendance + touchdowns + 1 without stalling, x 10k (bloodbowlbase example: 65k)", () => {
    const r = rules(BB2025_RULEBOOK_WINNINGS);
    expect(computeWinnings(r, { score: { for: 2, against: 1 }, attendance: 7, stalled: false, conceded: { self: false, other: false } }).winnings).toBe(65_000);
    expect(computeWinnings(r, { score: { for: 2, against: 1 }, attendance: 7, stalled: true, conceded: { self: false, other: false } }).winnings).toBe(55_000);
    // conceding: nothing for the conceder; the opponent gets the whole attendance plus its touchdowns (no stalling term)
    expect(computeWinnings(r, { score: { for: 0, against: 1 }, attendance: 7, stalled: false, conceded: { self: true, other: false } }).winnings).toBe(0);
    expect(computeWinnings(r, { score: { for: 1, against: 0 }, attendance: 7, stalled: false, conceded: { self: false, other: true } }).winnings).toBe(80_000);
    // attendance not recorded: the fan term is 0
    expect(computeWinnings(r, { score: { for: 1, against: 0 }, attendance: undefined, stalled: false, conceded: { self: false, other: false } }).winnings).toBe(20_000);
  });

  it("each winnings option: per touchdown, the fan multiplier, win and draw bonuses", () => {
    const x = (r: MoneyRules, f: number, a: number) => computeWinnings(r, { score: { for: f, against: a }, attendance: 6, stalled: false, conceded: { self: false, other: false } }).winnings;
    expect(x(rules({ perTouchdown: 20_000 }), 2, 0)).toBe(40_000);
    expect(x(rules({ perTouchdown: 0, fanMultiplier: 0.25 }), 2, 0)).toBe(15_000);
    expect(x(rules({ winBonus: 30_000, drawBonus: 10_000 }), 2, 1)).toBe(50_000);
    expect(x(rules({ winBonus: 30_000, drawBonus: 10_000 }), 1, 1)).toBe(20_000);
    expect(x(rules({ winBonus: 30_000, drawBonus: 10_000 }), 0, 1)).toBe(0);
    expect(x(rules({ noStallingBonus: 5_000 }), 0, 0)).toBe(5_000);
  });

  it("the treasury cap: over it is lost, or buys Dedicated Fans up to the maximum with the rest lost", () => {
    expect(applyTreasuryCap(rules({ treasuryCapEnabled: true, treasuryCap: 200_000 }), 260_000, 3, 6)).toEqual({ treasury: 200_000, fans: 3, lost: 60_000, fansGained: 0 });
    const fans = rules({ treasuryCapEnabled: true, treasuryCap: 200_000, capOverflow: "fans", capFansStep: 25_000 });
    expect(applyTreasuryCap(fans, 260_000, 3, 6)).toEqual({ treasury: 200_000, fans: 5, lost: 10_000, fansGained: 2 });
    expect(applyTreasuryCap(fans, 400_000, 5, 6)).toEqual({ treasury: 200_000, fans: 6, lost: 175_000, fansGained: 1 });
    expect(applyTreasuryCap(fans, 150_000, 3, 6).lost).toBe(0);
  });

  it("the inducement budget rule maps to the lobby's flags", () => {
    expect(lobbyBudget(rules({ inducementBudget: "pettyCash" }))).toEqual({ pettyCash: true, treasuryTopUp: false, fixedBudget: 0 });
    expect(lobbyBudget(rules({ inducementBudget: "treasury" }))).toEqual({ pettyCash: false, treasuryTopUp: true, fixedBudget: 0 });
    expect(lobbyBudget(rules({ inducementBudget: "fixed", fixedBudget: 150_000 }))).toEqual({ pettyCash: false, treasuryTopUp: false, fixedBudget: 150_000 });
    expect(lobbyBudget(rules({ pettyCash: false }))).toEqual({ pettyCash: false, treasuryTopUp: true, fixedBudget: 0 });
  });

  it("forfeit suggestions: none by default; the rulebook concession pays the other team only", () => {
    const x = { score: 2, otherScore: 0, attendance: 5 };
    expect(forfeitWinnings(rules(), { ...x, forfeit: false, otherForfeit: true })).toBe(0);
    const rb = rules(BB2025_RULEBOOK_WINNINGS);
    expect(forfeitWinnings(rb, { ...x, forfeit: false, otherForfeit: true })).toBe(70_000); // 5 x 1 x 10k + 2 x 10k
    expect(forfeitWinnings(rb, { ...x, score: 0, otherScore: 2, forfeit: true, otherForfeit: false })).toBe(0);
    expect(forfeitWinnings(rb, { ...x, forfeit: true, otherForfeit: true })).toBe(0);
  });

  it("validation: unknown keys and bad values are refused; null goes back to the layer below", () => {
    expect(parseMoneyRules({ perTouchdown: 20_000 }, undefined)).toEqual({ perTouchdown: 20_000 });
    expect(parseMoneyRules({ perTouchdown: null }, { perTouchdown: 20_000, winBonus: 5_000 })).toEqual({ winBonus: 5_000 });
    for (const bad of [{ nope: 1 }, { perTouchdown: -1 }, { perTouchdown: 1.5 }, { fanMultiplier: 0.333 }, { fanMultiplier: 9 }, { inducementBudget: "all" },
      { capOverflow: "spp" }, { pettyCash: "yes" }, { capFansStep: 0 }, { treasuryCap: 99_000_000 }, { concession: "half" }])
      expect(() => parseMoneyRules(bad, undefined)).toThrow(MoneyRulesError);
    expect(() => parseMoneyRules([], undefined)).toThrow(MoneyRulesError);
  });

  it("the fan multiplier is checked in whole hundredths, float-safe: 0.55 and 1.1 are accepted (Sol P3)", () => {
    expect(parseMoneyRules({ fanMultiplier: 0.55 }, undefined)).toEqual({ fanMultiplier: 0.55 });
    expect(parseMoneyRules({ fanMultiplier: 1.1 }, undefined)).toEqual({ fanMultiplier: 1.1 });
    expect(parseMoneyRules({ fanMultiplier: 0.29 }, undefined)).toEqual({ fanMultiplier: 0.29 });
    expect(isHundredths(0.55) && isHundredths(1.1) && isHundredths(4.35)).toBe(true);
    expect(isHundredths(0.555)).toBe(false);
  });

  it("an override form sends null for a key reset to the league's value and keeps the others (Sol P2 2)", () => {
    const league = rules({ perTouchdown: 20_000 });
    const prior = { winBonus: 30_000, drawBonus: 10_000 };
    expect(overridePayload({ ...league, drawBonus: 10_000 }, league, prior)).toEqual({ winBonus: null, drawBonus: 10_000 });
    expect(overridePayload(league, league, prior)).toEqual({ winBonus: null, drawBonus: null });
    expect(overridePayload(league, league, {})).toBeNull();
    // the server deletes null keys and keeps the rest
    expect(parseMoneyRules({ winBonus: null, drawBonus: 10_000 }, prior)).toEqual({ drawBonus: 10_000 });
  });

  it("a match without its own copy uses the legacy rules, never the league's current ones (Sol P2 3)", () => {
    expect(matchMoney({})).toEqual({ version: 0, rules: DEFAULT_MONEY_RULES });
    expect(LEGACY_MONEY.rules).toEqual(DEFAULT_MONEY_RULES);
    const copy = { version: 5, rules: rules({ inducementBudget: "treasury" }) };
    expect(matchMoney({ money: copy })).toBe(copy);
    expect(lobbyRulesFor(matchMoney({}).rules)).toEqual({ treasuryTopUp: true, highlander: false, starClash: "refund" });
  });

  it("a competition override falls back to the league, the league to the defaults", () => {
    const league = { moneyRules: { perTouchdown: 20_000, treasuryCapEnabled: true } };
    expect(effectiveMoneyRules({})).toEqual(DEFAULT_MONEY_RULES);
    expect(effectiveMoneyRules(league)).toMatchObject({ perTouchdown: 20_000, treasuryCapEnabled: true, winBonus: 0 });
    expect(effectiveMoneyRules(league, { rules: { money: { winBonus: 10_000 } } })).toMatchObject({ perTouchdown: 20_000, winBonus: 10_000, treasuryCapEnabled: true });
    expect(effectiveMoneyRules(league, { rules: {} })).toEqual(effectiveMoneyRules(league));
    expect(moneyRulesDiff(rules(), rules({ perTouchdown: 20_000, pettyCash: false }))).toEqual(["Per touchdown: 10k to 20k", "Petty cash: on to off"]);
  });
});

// ---- the recorder's post-game money step ----------------------------------------------------------------------------

const player = (id: string) => ({ id, name: id, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false });
const file = (treasury: number, fans: number): TabletopTeamFile => ({ schema: 1, name: "T", treasury, dedicatedFans: fans, players: [player("h1"), player("h2")] });
let n = 0;
const ev = (type: TabletopEvent["type"], team: "home" | "away", payload: Record<string, unknown> = {}, p?: string): TabletopEvent =>
  ({ id: `ev-${String(++n).padStart(8, "0")}`, matchId: "m1", type, team, ...(p ? { player: p } : {}), payload, ts: "2026-11-04T10:00:00.000Z", by: "Ann" });

describe("money rules in applyPostMatch", () => {
  const events = (): TabletopEvent[] => [
    ev("fans", "home", { roll: 2, dedicatedFans: 3, total: 5 }), ev("fans", "away", { roll: 1, dedicatedFans: 2, total: 3 }),
    ev("inducement", "home", { treasury: 20_000, picks: [] }),
    ev("touchdown", "home", {}, "h1"), ev("touchdown", "home", {}, "h2"), ev("touchdown", "away", {}, "a1"),
    ev("stalling", "away", {}, "a1"), ev("fanChange", "home", { delta: 1 }),
  ];
  const opt = { postMatch: "full" as const, ruleset: "bb2025" as const, matchId: "m1" };

  it("the default rules give exactly the numbers of a match without money rules (every past and default league match)", () => {
    for (const side of ["home", "away"] as const) {
      const base = applyPostMatch(file(100_000, 3), events(), { ...opt, team: side });
      const withRules = applyPostMatch(file(100_000, 3), events(), { ...opt, team: side, money: moneySnapshot({}) });
      expect(withRules.teamFile).toEqual(base.teamFile);
      const { money, ...summary } = withRules.summary;
      expect(summary).toEqual(base.summary);
      expect(money).toMatchObject({ version: 0, attendance: 8 });
    }
    // and without money rules the summary carries no money block at all
    expect(applyPostMatch(file(0, 3), events(), { ...opt, team: "home" }).summary.money).toBeUndefined();
  });

  it("the rulebook formula reads the pre-game fans and stalling; the cap applies after the inducement spend", () => {
    const rb = { version: 4, rules: rules({ ...BB2025_RULEBOOK_WINNINGS, treasuryCapEnabled: true, treasuryCap: 120_000 }) };
    const home = applyPostMatch(file(100_000, 3), events(), { ...opt, team: "home", money: rb });
    // (8 / 2 + 2 + 1) x 10k = 70k; 100k - 20k spent + 70k = 150k, capped at 120k (30k lost)
    expect(home.summary.winnings).toBe(70_000);
    expect(home.summary.treasuryAfter).toBe(120_000);
    expect(home.teamFile.treasury).toBe(120_000);
    expect(home.summary.money).toMatchObject({ version: 4, attendance: 8, stalled: false, capLost: 30_000 });
    const away = applyPostMatch(file(0, 2), events(), { ...opt, team: "away", money: rb });
    expect(away.summary.winnings).toBe(50_000); // stalled: (4 + 1) x 10k
    // spp-only: no money moves, whatever the rules
    const sppOnly = applyPostMatch(file(100_000, 3), events(), { ...opt, postMatch: "spp-only", team: "home", money: rb });
    expect(sppOnly.teamFile.treasury).toBe(100_000);
  });

  it("the cap applies at every settlement, also with no winnings (Sol P2 4)", () => {
    const r = { version: 2, rules: rules({ treasuryCapEnabled: true, treasuryCap: 100_000 }) };
    const away = applyPostMatch(file(300_000, 2), [ev("touchdown", "home", {}, "h1")], { ...opt, team: "away", money: r });
    expect(away.summary.winnings).toBe(0);
    expect(away.teamFile.treasury).toBe(100_000);
    expect(away.summary.money).toMatchObject({ capLost: 200_000 });
  });

  it("over the cap can buy Dedicated Fans", () => {
    const r = { version: 1, rules: rules({ perTouchdown: 50_000, treasuryCapEnabled: true, treasuryCap: 50_000, capOverflow: "fans", capFansStep: 20_000 }) };
    const home = applyPostMatch(file(0, 3), events(), { ...opt, team: "home", money: r });
    // 100k winnings - 20k spent = 80k: 30k over the cap -> +1 fan, 10k lost; fans 3 + 1 (fanChange) + 1 = 5
    expect(home.teamFile.treasury).toBe(50_000);
    expect(home.teamFile.dedicatedFans).toBe(5);
    expect(home.summary.money).toMatchObject({ capFans: 1, capLost: 10_000 });
  });
});

// ---- the lobby: inducement budget rules -----------------------------------------------------------------------------

const lteam = (name: string, tv: number | null, treasury: number): LobbyTeam => ({
  id: name.toLowerCase(), name, race: "Orc", tv, treasury, rerolls: 2, apothecary: true, fans: 3, assistantCoaches: 0, cheerleaders: 0, playerCount: 12, roster: [],
  file: { schema: 1, name, race: "Orc", treasury, dedicatedFans: 3, ...(tv !== null ? { teamValue: tv } : {}), players: [] }, stars: [],
});
function lfx(r: LobbyRules, homeTv: number | null = 1_000_000, awayTv: number | null = 1_100_000): LobbyFixture {
  const { offers, ids } = seasonInducementOffers(undefined);
  const stats = { played: 0, wins: 0, draws: 0, losses: 0, tdPerGame: 0, casPerGame: 0, form: [] };
  const side = (coach: string, t: LobbyTeam) => ({ coachId: coach, coach, team: t, stats: { season: stats, allTime: stats } });
  return {
    key: "league:alpha:season-1:f1", source: "league", mode: "tabletop", open: true, header: { competition: "Alpha", round: 1, ruleset: "BB2025" },
    links: { competition: "", fixture: "", standings: "", rules: "" },
    sides: { home: side("Ann", lteam("Orcs", homeTv, 100_000)), away: side("Bob", lteam("Humans", awayTv, 150_000)) },
    rules: r, noInducements: "", offers, ids, table: effectiveInducements(undefined),
    isOrganiser: () => false, headToHead: { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] },
    organisers: [], start: { fixtureRef: "league:alpha:season-1:f1", extra: {} }, recorderTeamAllowed: () => true,
  };
}
const NOW = new Date("2026-11-04T12:00:00.000Z");
const readyRec = (fx: LobbyFixture): LobbyRecord => {
  const rec = newLobby(fx, NOW);
  for (const s of ["home", "away"] as const) Object.assign(rec.sides[s], { rosterLocked: true, teamRef: `library:${s}`, ready: true });
  return rec;
};

describe("money rules in the fixture lobby", () => {
  it("a league on the defaults gets exactly the rules it had (treasury top-up, no extra flags)", () => {
    expect(leagueLobbyRules({}, { rules: {} })).toEqual({ treasuryTopUp: true, highlander: false, starClash: "refund" });
    const fx = lfx(leagueLobbyRules({}, {}));
    expect(budgetFor(fx, {}, "home")).toEqual({ role: "underdog", pettyCash: 100_000, treasury: 100_000, topUpLimit: 50_000, limit: 150_000 });
    expect(budgetFor(fx, {}, "away")).toEqual({ role: "overdog", pettyCash: 0, treasury: 150_000, topUpLimit: 150_000, limit: 150_000 });
  });

  it("gap only: no treasury spending, the overdog buys nothing", () => {
    const fx = lfx(leagueLobbyRules({ moneyRules: { inducementBudget: "pettyCash" } }, {}));
    expect(budgetFor(fx, {}, "home")).toMatchObject({ role: "underdog", pettyCash: 100_000, topUpLimit: 0 });
    expect(sideHasStep(fx, "away")).toBe(false);
  });

  it("treasury only: no roles and no hold; both teams pay from their whole treasury, even at equal team values", () => {
    const fx = lfx(leagueLobbyRules({ moneyRules: { inducementBudget: "treasury" } }, {}), 1_000_000, 1_000_000);
    expect(inducementStep(fx)).toBe("");
    expect(tvRoles(fx).underdog).toBeUndefined();
    expect(budgetFor(fx, {}, "home")).toEqual({ role: "equal", pettyCash: 0, treasury: 100_000, topUpLimit: 100_000, limit: 100_000 });
    expect(sideHasStep(fx, "home") && sideHasStep(fx, "away")).toBe(true);
    const rec = readyRec(fx);
    expect(gateOf(fx, rec).blockers).toEqual(["Ann has not locked their inducements.", "Bob has not locked their inducements."]);
    rec.sides.home.picks = [{ id: "bribes", qty: 1 }];
    for (const s of ["home", "away"] as const) rec.sides[s].locked = true;
    const out = resolveStart(fx, rec, { force: false, now: NOW });
    expect(out.kind).toBe("go");
    if (out.kind === "go") { expect(out.resolution.home.treasury).toBe(out.resolution.home.total); expect(out.resolution.away.total).toBe(0); }
  });

  it("a fixed amount per game for each team: unspent is lost, nothing comes from the treasury", () => {
    const fx = lfx(leagueLobbyRules({ moneyRules: { inducementBudget: "fixed", fixedBudget: 100_000 } }, {}));
    expect(budgetFor(fx, {}, "away")).toEqual({ role: "equal", pettyCash: 100_000, treasury: 150_000, topUpLimit: 0, limit: 100_000 });
    const plan = planSide(fx, {}, "away", [{ id: "bribes", qty: 1 }]);
    expect(plan).toMatchObject({ treasury: 0, pettyCash: 100_000 });
    expect("error" in planSide(fx, {}, "away", [{ id: "bribes", qty: 3 }])).toBe(true);
  });

  it("petty cash off and no treasury spending: no inducement step", () => {
    const fx = lfx(leagueLobbyRules({ moneyRules: { pettyCash: false, inducementBudget: "pettyCash" } }, {}));
    expect(inducementStep(fx)).toMatch(/no inducement money/);
  });

  it("a started match judges its pre-game picks by its own snapshot (lobbyRulesFor), not the league's current rules", () => {
    expect(lobbyRulesFor(rules({ inducementBudget: "treasury" }))).toEqual({ treasuryTopUp: true, highlander: false, starClash: "refund", pettyCash: false });
    expect(lobbyRulesFor(rules())).toEqual(leagueLobbyRules({}, {}));
  });

  it("the competition override wins over the league", () => {
    const r = leagueLobbyRules({ moneyRules: { inducementBudget: "treasury" } }, { rules: { money: { inducementBudget: "both" } } });
    expect(r).toEqual({ treasuryTopUp: true, highlander: false, starClash: "refund" });
  });
});

// ---- League settings: the Money card ---------------------------------------------------------------------------------

const lfixture = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const lgTeam = (id: string, name: string, coach: string, fans: number, treasury: number): LeagueTeam => ({
  id, name, race: id === "orcs" ? "Orc" : "Wood Elf", coach, coachId: coach, teamValue: 1_000_000, treasury, rerolls: 2, fans,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [{ playerId: `${id}-1`, number: 1, name: `${name} 1`, position: id === "orcs" ? "Orc Lineman" : "Wood Elf Lineman", ma: 5, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50_000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS } }],
  formerPlayers: [],
});
const lseason = (number: number, fixtures: LeagueFixture[]): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams: [lgTeam("orcs", "Orcs", "Ann", 3, 50_000), lgTeam("elves", "Elves", "Bob", 2, 0)], participants: [], honours: [], awards: [], unattributedStats: [],
  importedAt: "2026-11-01T00:00:00.000Z", source: "manual",
});

describe("League settings -> Money", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let clock = "2026-11-04T12:00:00.000Z";
  const notes: Array<{ coach: string; title: string; body: string }> = [];
  const deps = (): LeagueApiDeps => ({
    store, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)), now: () => new Date(clock),
    identities: () => [{ coach: "Jay", level: "organizer" }, { coach: "Kim", level: "player" }],
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body }); },
    postWebhook: async () => ({ ok: true, status: 204 }),
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const JAY = { coach: "Jay" };
  const S = "/api/leagues/tabbl/settings";
  const rev = () => store.league("tabbl")?.revision ?? 0;
  const money = (r: LeagueApiResult) => (r.body as { settings: { money: any } }).settings.money;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-money-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay", "Kim"] });
    store.putSeason(lseason(1, [lfixture("f1"), lfixture("f2")]));
    store.putSeason(lseason(2, []));
    notes.length = 0;
    clock = "2026-11-04T12:00:00.000Z";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the read model starts on the defaults at version 0; a GET writes nothing", async () => {
    const before = JSON.stringify(store.league("tabbl"));
    const m = money(await call("GET", S, JAY));
    expect(m).toMatchObject({ version: 0, rules: DEFAULT_MONEY_RULES, set: [], log: [] });
    expect(m.competitions.map((c: any) => c.seasonId)).toEqual(["season-2", "season-1"]);
    expect(JSON.stringify(store.league("tabbl"))).toBe(before);
  });

  it("saves the league's rules: a new version, a log entry (who, when, before, after) and a note to the other organisers", async () => {
    const r = await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 20_000, treasuryCapEnabled: true } });
    expect(r.status).toBe(200);
    const m = money(r);
    expect(m.version).toBe(1);
    expect(m.rules).toMatchObject({ perTouchdown: 20_000, treasuryCapEnabled: true });
    expect(m.log[0]).toMatchObject({ version: 1, by: "Jay", at: clock, scope: "league", before: { perTouchdown: 10_000 }, after: { perTouchdown: 20_000 } });
    expect(m.log[0].changes).toEqual(["Per touchdown: 10k to 20k", "Treasury cap: off to on"]);
    expect(notes.map((x) => x.coach)).toEqual(["Kim"]); // the actor never notifies themself
    expect(notes[0]!.title).toBe("TABBL: money rules changed");
    expect(notes[0]!.body).toContain("Per touchdown: 10k to 20k");
    // saving the same again changes nothing: no new version, no note
    notes.length = 0;
    expect(money(await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 20_000 } })).version).toBe(1);
    expect(notes).toEqual([]);
  });

  it("revisions: no revision 428, a stale one 409, and nothing is written", async () => {
    expect((await call("PATCH", S, JAY, { money: { perTouchdown: 20_000 } })).status).toBe(428);
    await call("PATCH", S, JAY, { revision: rev(), money: { winBonus: 10_000 } });
    expect((await call("PATCH", S, JAY, { revision: 0, money: { perTouchdown: 20_000 } })).status).toBe(409);
    expect(store.league("tabbl")!.moneyRules).toEqual({ winBonus: 10_000 });
    expect((await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: -5 } })).status).toBe(400);
    expect((await call("PATCH", S, { coach: "Ann" }, { revision: rev(), money: { perTouchdown: 0 } })).status).toBe(403);
    expect(store.league("tabbl")!.moneyRulesVersion).toBe(1);
  });

  it("a competition override falls back to the league, and null makes it follow the league again", async () => {
    await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 20_000 } });
    const r = await call("PATCH", S, JAY, { revision: rev(), moneyOverride: { seasonId: "season-2", rules: { winBonus: 30_000 } } });
    expect(r.status).toBe(200);
    const m = money(r);
    const s2 = m.competitions.find((c: any) => c.seasonId === "season-2");
    expect(s2).toMatchObject({ override: { winBonus: 30_000 }, rules: { perTouchdown: 20_000, winBonus: 30_000 } });
    expect(m.competitions.find((c: any) => c.seasonId === "season-1").rules).toMatchObject({ perTouchdown: 20_000, winBonus: 0 });
    expect(m.log[0]).toMatchObject({ version: 2, scope: { seasonId: "season-2", name: "Season 2" } });
    // the public league read carries the rules for the ruleset card
    const pub = (await call("GET", "/api/leagues/tabbl")).body as { league: { money: any } };
    expect(pub.league.money).toMatchObject({ version: 2, rules: { perTouchdown: 20_000 }, bySeason: { "season-2": { winBonus: 30_000 } } });
    expect(Object.keys(pub.league.money.bySeason)).toEqual(["season-2"]);
    expect(JSON.stringify(pub.league)).not.toContain("moneyRulesLog");
    // the league changes later: the override keeps only its own key
    await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 30_000 } });
    expect(effectiveMoneyRules(store.league("tabbl")!, store.season("tabbl", "season-2"))).toMatchObject({ perTouchdown: 30_000, winBonus: 30_000 });
    const cleared = money(await call("PATCH", S, JAY, { revision: rev(), moneyOverride: { seasonId: "season-2", rules: null } }));
    expect(cleared.competitions.find((c: any) => c.seasonId === "season-2").override).toEqual({});
    expect(store.season("tabbl", "season-2")!.rules?.money).toBeUndefined();
    expect((await call("PATCH", S, JAY, { revision: rev(), moneyOverride: { seasonId: "season-9", rules: {} } })).status).toBe(404);
  });

  it("the lobby view of a fixture uses the season's rules; the recorder's fixture view carries the snapshot", async () => {
    await call("PATCH", S, JAY, { revision: rev(), money: { inducementBudget: "fixed", fixedBudget: 80_000 } });
    const v = leagueFixtureView(store, "league:tabbl:season-1:f1");
    expect(v?.money).toMatchObject({ version: 1, rules: { inducementBudget: "fixed", fixedBudget: 80_000 } });
  });

  it("a recorded result stores the version it used; a result recorded before the change keeps its own", async () => {
    recordLeagueFixture(store, "league:tabbl:season-1:f1", { expectedRevision: 0, homeScore: 1, awayScore: 0, homeCasualties: 0, awayCasualties: 0, moneyRulesVersion: 0 }, new Date(clock));
    await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 50_000 } });
    recordLeagueFixture(store, "league:tabbl:season-1:f2", { expectedRevision: 0, homeScore: 1, awayScore: 0, homeCasualties: 0, awayCasualties: 0, moneyRulesVersion: 1 }, new Date(clock));
    const fs = store.season("tabbl", "season-1")!.fixtures;
    expect(fs.find((f) => f.id === "f1")!.moneyRulesVersion).toBe(0);
    expect(fs.find((f) => f.id === "f2")!.moneyRulesVersion).toBe(1);
    // the teams were not touched by the rules change (nothing is recalculated)
    expect(store.season("tabbl", "season-1")!.teams.map((t) => t.treasury)).toEqual([50_000, 0]);
  });

  it("the forfeit dialog: default suggestions unchanged (no winnings); the rulebook concession pays the winner and the cap applies", async () => {
    const F = "/api/leagues/tabbl/seasons/season-1/fixtures/f1/forfeit";
    const plain = (await call("GET", F, JAY)).body as any;
    expect(plain.suggestions.home.home.winnings).toBe(0);
    expect(plain.suggestions.home.away.winnings).toBe(0);
    expect(plain.money).toMatchObject({ version: 0, concession: "none", treasuryCap: null });
    await call("PATCH", S, JAY, { revision: rev(), money: { ...BB2025_RULEBOOK_WINNINGS, treasuryCapEnabled: true, treasuryCap: 40_000 } });
    const m = (await call("GET", F, JAY)).body as any;
    // home forfeits: away (Elves) gets the whole attendance (3 + 2 Dedicated Fans) x 10k + 2 awarded TDs x 10k
    expect(m.suggestions.home.away.winnings).toBe(70_000);
    expect(m.suggestions.home.home.winnings).toBe(0);
    expect(m.legalSuggestions.away.home.winnings).toBe(70_000);
    const s = m.suggestions.home;
    const applied = await call("POST", F, JAY, { home: s.home, away: s.away, noStandings: false, legalConcession: true });
    expect(applied.status).toBe(200);
    const after = store.season("tabbl", "season-1")!;
    const f1 = after.fixtures.find((f) => f.id === "f1")!;
    expect(f1.moneyRulesVersion).toBe(1);
    expect(f1.forfeitDetail?.moneyRulesVersion).toBe(1);
    expect(after.teams.find((t) => t.id === "elves")!.treasury).toBe(40_000); // 70k capped at 40k
  });

  it("resetting one override field to the league's value deletes it and keeps the other (Sol P2 2)", async () => {
    await call("PATCH", S, JAY, { revision: rev(), money: { perTouchdown: 20_000 } });
    await call("PATCH", S, JAY, { revision: rev(), moneyOverride: { seasonId: "season-2", rules: { winBonus: 30_000, drawBonus: 10_000 } } });
    const leagueRules = effectiveMoneyRules(store.league("tabbl")!);
    const next = { ...leagueRules, drawBonus: 10_000 }; // the form: win bonus put back to the league's 0
    const r = await call("PATCH", S, JAY, { revision: rev(), moneyOverride: { seasonId: "season-2", rules: overridePayload(next, leagueRules, { winBonus: 30_000, drawBonus: 10_000 }) } });
    expect(r.status).toBe(200);
    expect(store.season("tabbl", "season-2")!.rules?.money).toEqual({ drawBonus: 10_000 });
    expect(money(r).competitions.find((c: any) => c.seasonId === "season-2").rules).toMatchObject({ winBonus: 0, drawBonus: 10_000, perTouchdown: 20_000 });
    expect(money(r).log[0].changes).toEqual(["Win bonus: 30k to 0k"]);
  });

  it("a recorder forfeit uses the match's copy (rules, cap and version), not the league's current rules (Sol P2 1)", async () => {
    await call("PATCH", S, JAY, { revision: rev(), money: { treasuryCapEnabled: true, treasuryCap: 10_000 } }); // the league now: a 10k cap
    const ids = { leagueId: "tabbl", seasonId: "season-1", fixtureId: "f1" };
    const copy = { version: 7, rules: rules({ ...BB2025_RULEBOOK_WINNINGS, treasuryCapEnabled: true, treasuryCap: 60_000 }) };
    const model = forfeitModel({ store }, ids, { coach: "Jay", admin: false }, { money: copy }).body as any;
    expect(model.money).toMatchObject({ version: 7, concession: "rulebook", treasuryCap: 60_000 });
    expect(model.suggestions.home.away.winnings).toBe(70_000);
    const s = model.suggestions.home;
    const out = await applyForfeit({ store }, ids, { coach: "Jay", admin: false }, { home: s.home, away: s.away, noStandings: false, legalConcession: true }, { matchId: "tm_x", announce: false, money: copy });
    expect(out.status).toBe(200);
    const after = store.season("tabbl", "season-1")!;
    expect(after.fixtures.find((f) => f.id === "f1")!.moneyRulesVersion).toBe(7);
    expect(after.teams.find((t) => t.id === "elves")!.treasury).toBe(60_000); // the copy's cap, not the league's 10k
    expect(after.teams.find((t) => t.id === "orcs")!.treasury).toBe(50_000); // under the copy's cap: untouched
  });

  it("the cap applies to a forfeit settlement with no or negative winnings (Sol P2 4)", async () => {
    await call("PATCH", S, JAY, { revision: rev(), money: { treasuryCapEnabled: true, treasuryCap: 30_000 } });
    const F = "/api/leagues/tabbl/seasons/season-1/fixtures/f1/forfeit";
    const s = ((await call("GET", F, JAY)).body as any).legalSuggestions.home;
    expect(s.home.winnings).toBe(0);
    const r = await call("POST", F, JAY, { home: { ...s.home, winnings: -5_000 }, away: s.away, noStandings: false, legalConcession: true });
    expect(r.status).toBe(200);
    const teams = store.season("tabbl", "season-1")!.teams;
    expect(teams.find((t) => t.id === "orcs")!.treasury).toBe(30_000); // 50k - 5k = 45k, capped at 30k
    expect(teams.find((t) => t.id === "elves")!.treasury).toBe(0);
  });

  it("a suggestion above the 2,000,000 a forfeit accepts is clamped to it, with a note, and submits (Sol P2 5)", async () => {
    const s1 = store.season("tabbl", "season-1")!;
    for (const t of s1.teams) t.fans = 6;
    store.putSeason(s1);
    await call("PATCH", S, JAY, { revision: rev(), money: { ...BB2025_RULEBOOK_WINNINGS, fanMultiplier: 5, perTouchdown: 500_000, winBonus: 500_000 } });
    const F = "/api/leagues/tabbl/seasons/season-1/fixtures/f1/forfeit";
    const m = (await call("GET", F, JAY)).body as any;
    // 12 x 10 x 10k + 2 x 500k + 500k = 2,700,000
    expect(m.suggestions.home.away.winnings).toBe(2_000_000);
    expect(m.suggestions.home.notes.join(" ")).toContain("so the suggestion is capped there");
    const s = m.legalSuggestions.home;
    expect((await call("POST", F, JAY, { home: s.home, away: s.away, noStandings: false, legalConcession: true })).status).toBe(200);
  });
});

// ---- a recorder match keeps the rules it started with ---------------------------------------------------------------

describe("a recorder match snapshots the money rules at the start", () => {
  let dir = "";
  let repo: FileTabletopRepository;
  let results: TournamentResultStore;
  let money: { version: number; rules: MoneyRules } | undefined;
  const recorded: Array<Record<string, unknown>> = [];
  const files: Record<string, TabletopTeamFile> = {};
  let open = true;
  const view = (): FixtureView => ({
    id: "fx-1", open, status: "scheduled", revision: 0, home: { coach: "Alice" }, away: { coach: "Bob" }, ...(money ? { money } : {}),
  });
  const gateway = (): FixtureGateway => ({ get: (id) => (id === "fx-1" ? view() : undefined), record: (_id, input) => { recorded.push(input); open = false; }, retract: () => undefined });
  const deps = (): TabletopApiDeps => ({
    repo, results, fixtures: gateway(), loadTeamFile: (coach, saveId) => files[`${coach}/${saveId}`], isBanned: () => false,
    drawSeats: () => false, isOrganizer: (c) => c === "Org", now: () => new Date("2026-11-04T10:00:00.000Z"),
  });
  const as = (coach: string, method: string, path: string, b?: unknown): Promise<TabletopResult> =>
    tabletopApi(method, path, { coach, method: "discord" }, b, deps(), new URLSearchParams()) as Promise<TabletopResult>;
  let eid = 0;
  const E = (type: string, team: string, p?: string) => ({ id: `mny-${String(++eid).padStart(8, "0")}`, type, team, player: p, payload: {} });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "money-recorder-"));
    repo = new FileTabletopRepository(join(dir, "tt"));
    results = new TournamentResultStore(join(dir, "results"));
    recorded.length = 0;
    open = true;
    for (const [c, p] of [["Alice", "a"], ["Bob", "b"]] as const)
      files[`${c}/sv_${p}`] = { schema: 1, name: `${c} XI`, treasury: 10_000, dedicatedFans: 2, players: [player(`${p}1`), player(`${p}2`)] };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function play(): Promise<string> {
    const created = await as("Org", "POST", "/api/tabletop/matches", { pregame: "skip", fixtureRef: "fx-1", home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" } });
    expect(created.status).toBe(201);
    return (created.body as { match: { id: string } }).match.id;
  }

  it("the rules in force at the start are used, even when the league changes them mid-game; the fixture gets the version", async () => {
    money = { version: 3, rules: rules({ perTouchdown: 20_000, winBonus: 15_000 }) };
    const id = await play();
    money = { version: 4, rules: rules({ perTouchdown: 90_000 }) }; // changed while the game is played: the next fixture's rules
    await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1"), E("touchdown", "home", "a2")] });
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(200);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    const m = (await repo.getMatch(id))!;
    expect(m.money?.version).toBe(3);
    expect(m.preview!.home.winnings).toBe(55_000); // 2 x 20k + 15k win bonus
    expect(m.preview!.home.money).toMatchObject({ version: 3 });
    expect(m.preview!.away.winnings).toBe(0);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(200);
    expect(recorded[0]).toMatchObject({ homeScore: 2, moneyRulesVersion: 3 });
  });

  it("a match without league money rules keeps the fixed rule and its summary carries no money block", async () => {
    money = undefined;
    const id = await play();
    await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "away", "b1")] });
    await as("Org", "POST", `/api/tabletop/matches/${id}/submit`);
    const m = (await repo.getMatch(id))!;
    expect(m.money).toBeUndefined();
    expect(m.preview!.away.winnings).toBe(10_000);
    expect(m.preview!.away.money).toBeUndefined();
  });
});
