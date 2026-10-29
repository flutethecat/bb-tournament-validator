import { describe, expect, it } from "vitest";
import { leagueStats, statsCards } from "../src/leagues/stats";
import type { LeagueFixture, LeaguePlayer, LeagueRuleset, LeagueTeam, PlayerSeasonStats, SeasonRecord } from "../src/leagues/types";
import { EMPTY_PLAYER_STATS } from "../src/leagues/types";

// League statistics spotlight cards (src/leagues/stats.ts statsCards / LeagueStats.cards): per scope, ties, empty
// scope, link targets.

const pl = (id: string, name: string, stats: Partial<PlayerSeasonStats> = {}, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: id, careerKey: `c-${id}`, number: 1, name, position: "Blitzer", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 85000,
  level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS, ...stats }, ...over,
});
const team = (id: string, name: string, race: string, coach: string, players: LeaguePlayer[]): LeagueTeam => ({
  id, name, race, coach, coachId: coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "1", raceLeague: "", players, formerPlayers: [],
});
const side = (t: LeagueTeam, score: number) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score, cas: 0, conceded: false });
const fx = (id: string, round: number, home: LeagueTeam, hs: number, away: LeagueTeam, as: number): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1, home: side(home, hs), away: side(away, as), suspended: false,
});
const season = (n: number, ruleset: LeagueRuleset, teams: LeagueTeam[], fixtures: LeagueFixture[]): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `s${n}`, ruleset, status: "completed",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
});

/**
 * Season 1 (BB2020): Orcs (Ann) 1-0 Elves (Bob). Seasons 2 and 3 (BB2025): Ann's Orcs and Bob's Elves, plus Cat's
 * Dwarfs who play once (a lucky single win). Grok (Orcs) plays every season under one career key.
 */
function league(): SeasonRecord[] {
  const s1orcs = team("orcs", "Orcs", "Orc", "Ann", [pl("grok1", "Grok", { td: 2, cas: 1 }, { careerKey: "c-grok" })]);
  const s1elves = team("elves", "Elves", "Wood Elf", "Bob", [pl("leaf1", "Leaf", { td: 1, completions: 4 }, { careerKey: "c-leaf" })]);
  const s2orcs = team("orcs", "Orcs", "Orc", "Ann", [pl("grok2", "Grok", { td: 3, mvp: 1 }, { careerKey: "c-grok" }), pl("ug2", "Ug", { cas: 4, fouls: 2 })]);
  const s2elves = team("elves", "Elves", "Wood Elf", "Bob", [pl("leaf2", "Leaf", { td: 3, int: 1 }, { careerKey: "c-leaf" })]);
  const s3orcs = team("orcs-3", "Orcs", "Orc", "Ann", [pl("grok3", "Grok", { td: 1 }, { careerKey: "c-grok" })]);
  const s3elves = team("elves-3", "Elves", "Wood Elf", "Bob", [pl("leaf3", "Leaf", { td: 1 }, { careerKey: "c-leaf" })]);
  const s3dwarfs = team("dwarfs", "Dwarfs", "Dwarf", "Cat", []);
  return [
    season(1, "BB2020", [s1orcs, s1elves], [fx("a1", 1, s1orcs, 1, s1elves, 0)]),
    season(2, "BB2025", [s2orcs, s2elves], [fx("b1", 1, s2orcs, 4, s2elves, 0), fx("b2", 2, s2elves, 2, s2orcs, 2), fx("b3", 3, s2elves, 1, s2orcs, 0)]),
    season(3, "BB2025", [s3orcs, s3elves, s3dwarfs], [fx("c1", 1, s3orcs, 2, s3elves, 1), fx("c2", 2, s3dwarfs, 6, s3elves, 2)]),
  ];
}

describe("league statistics cards", () => {
  it("all time: every card in display order with its value, unit, who and link", () => {
    const st = leagueStats(league(), "all");
    expect(st.cards.map((c) => c.id)).toEqual(["top-scorer", "casualties", "mvp", "best-coach", "best-team", "biggest-win", "playmaker", "interceptor", "dirtiest", "iron-man"]);
    const by = Object.fromEntries(st.cards.map((c) => [c.id, c]));
    // Grok 6 TD (2+3+1 across one career), Leaf 5: no tie; the link opens the newest season's team and player id
    expect(by["top-scorer"]).toMatchObject({ value: "6", unit: "TD", name: "Grok", team: "Orcs", race: "Orc", coach: "Ann", seasons: [1, 2, 3], tied: [] });
    expect(by["top-scorer"]!.link).toEqual({ kind: "player", seasonId: "season-3", teamId: "orcs-3", playerId: "grok3" });
    expect(by["casualties"]).toMatchObject({ value: "4", name: "Ug", seasons: [2], link: { kind: "player", seasonId: "season-2", teamId: "orcs", playerId: "ug2" } });
    expect(by["mvp"]).toMatchObject({ value: "1", unit: "MVP", name: "Grok" });
    expect(by["playmaker"]).toMatchObject({ value: "4", unit: "Completions", name: "Leaf" });
    expect(by["interceptor"]).toMatchObject({ value: "1", name: "Leaf", icon: "/icons/panel/teams-roster.png" });
    expect(by["dirtiest"]).toMatchObject({ value: "2", name: "Ug", icon: "" });
    // Grok and Leaf both rostered 3 seasons; Leaf's Elves played 6 games in them, Grok's Orcs 5: Leaf
    expect(by["iron-man"]).toMatchObject({ value: "3", unit: "Seasons", name: "Leaf", seasons: [1, 2, 3], tied: [] });
    expect(by["iron-man"]!.detail).toBe("Blitzer · 6 team games");
    // Cat won his only game (100%), but the busiest coach (Bob) has 6 games: min. 3 games, so Ann tops it
    expect(by["best-coach"]).toMatchObject({ name: "Ann", unit: "Win %", team: "Orcs", race: "Orc" });
    expect(by["best-coach"]!.value).toBe("70%"); // 3 W, 1 D, 1 L in 5 games = (3 + .5) / 5
    expect(by["best-coach"]!.detail).toBe("3-1-1 in 5 games · min. 3 games");
    expect(by["best-coach"]!.link).toEqual({ kind: "team", seasonId: "season-3", teamId: "orcs-3" });
    expect(by["best-team"]).toMatchObject({ value: "10", unit: "Points", name: "Orcs", detail: "3-1-1 · 70% wins", link: { kind: "team", seasonId: "season-3", teamId: "orcs-3" } });
    expect(by["biggest-win"]).toMatchObject({ value: "6-2", unit: "+4", name: "Dwarfs", race: "Dwarf", coach: "Cat", seasons: [3], detail: "beat Elves · Round 2" });
    // Orcs 4-0 in season 2 has the same margin but fewer touchdowns: not level
    expect(by["biggest-win"]!.tied).toEqual([]);
    expect(by["biggest-win"]!.link).toEqual({ kind: "fixture", seasonId: "season-3", fixtureId: "c2" });
  });

  it("per scope: BB2020 counts only its season; BB2025 only its seasons; an empty scope has no cards", () => {
    const old = leagueStats(league(), "bb2020");
    const byOld = Object.fromEntries(old.cards.map((c) => [c.id, c]));
    expect(byOld["top-scorer"]).toMatchObject({ value: "2", name: "Grok", seasons: [1], link: { seasonId: "season-1", teamId: "orcs", playerId: "grok1" } });
    expect(byOld["mvp"]).toBeUndefined(); // nobody has an MVP in BB2020: the card is left out
    expect(byOld["dirtiest"]).toBeUndefined();
    expect(byOld["iron-man"]).toMatchObject({ value: "1", unit: "Season", tied: ["Leaf"] });
    const now = leagueStats(league(), "bb2025");
    const byNow = Object.fromEntries(now.cards.map((c) => [c.id, c]));
    // Grok 4, Leaf 4 in BB2025: a tie, broken by name
    expect(byNow["top-scorer"]).toMatchObject({ value: "4", name: "Grok", tied: ["Leaf"] });
    expect(byNow["iron-man"]).toMatchObject({ value: "2", seasons: [2, 3] });
    expect(leagueStats(league().filter((s) => s.ruleset === "BB2025"), "bb2020").cards).toEqual([]);
    expect(leagueStats([], "all").cards).toEqual([]);
  });

  it("ties: equal headline values list every level name in order; a different tie-break breaks the tie", () => {
    const a = team("a", "Alphas", "Human", "Ann", [pl("p1", "Zed", { td: 3 }), pl("p2", "Amy", { td: 3 }), pl("p3", "Moe", { td: 3 }), pl("p4", "Low", { td: 1 })]);
    const b = team("b", "Betas", "Human", "Bob", []);
    const s = season(1, "BB2025", [a, b], [fx("x1", 1, a, 3, b, 0), fx("x2", 2, b, 3, a, 0)]);
    const st = leagueStats([s], "all");
    const top = st.cards.find((c) => c.id === "top-scorer")!;
    expect([top.name, ...top.tied]).toEqual(["Amy", "Moe", "Zed"]);
    // two 3-0 wins: same margin and score, the earlier round heads the card, the other is tied
    const big = st.cards.find((c) => c.id === "biggest-win")!;
    expect(big).toMatchObject({ name: "Alphas", link: { fixtureId: "x1" }, tied: ["Betas 3-0 Alphas"] });
    // both teams 3 points, 1-0-1: tied, name order
    expect(st.cards.find((c) => c.id === "best-team")).toMatchObject({ name: "Alphas", tied: ["Betas"] });
    expect(st.cards.find((c) => c.id === "best-coach")).toMatchObject({ name: "Ann", value: "50%", tied: ["Bob"] });
  });

  it("a team without a resolved team id links by its name; statsCards is pure over its inputs", () => {
    const a = team("a", "Alphas", "Human", "Ann", []);
    const b = team("b", "Betas", "Human", "Bob", []);
    const f = fx("x1", 1, a, 2, b, 0);
    delete f.home.teamId;
    const st = leagueStats([season(1, "BB2025", [a, b], [f])], "all");
    expect(st.cards.find((c) => c.id === "best-team")!.link).toEqual({ kind: "team", seasonId: "season-1", teamId: "Alphas" });
    expect(statsCards({ careers: [], coaches: [], teams: [], wins: [], teamGames: new Map() })).toEqual([]);
  });
});
