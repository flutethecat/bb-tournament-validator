import { DEFAULT_DISCORD_EVENTS } from "../src/leagues/discord";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminExchange } from "@bb/fork-ops";
import { leagueApi, resetForkToggleLimit, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { syncLeagueForkResults, type ForkFindOutcome, type ForkScheduleOutcome, type LeagueForkClient } from "../src/leagues/forkPlay";
import { dueFixtures, forkGamePending } from "../src/leagues/deadlines";
import { applyForkResult, fromBasicResult, fromParsedResult, mutateLeagueTeam, type ForkGameResult } from "../src/leagues/forkResult";
import { confirmedList } from "../src/leagues/forkClient";
import { buildLeagueForkTeam, forkPlayerIdFor, forkPlayLock, forkRosterFor, forkTeamIdFor, ForkTeamBuildError, statDelta, type LeagueForkTeamFile } from "../src/leagues/forkTeam";
import { targetConflict } from "../src/leagues/redraft";
import { shiftStoredPlayerValue } from "../src/storedPlayerValue";
import { buildBankTasks, computedPlayerValue } from "../src/site-backend/fumbblResultBanking";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import type { ParsedGameResult } from "../src/site-backend/fumbblResult";

// Play on Super FUMBBL for league fixtures (src/leagues/forkTeam.ts, forkResult.ts, forkPlay.ts). The fork is a stub:
// no test schedules a real game.

const pos = (id: string, name: string, s: { ma: number; st: number; ag: number; pa: number; av: number; cost: number }, skills: string[] = [], type = "Regular") =>
  `<position id="${id}"><quantity>16</quantity><name>${name}</name><type>${type}</type><gender>male</gender><cost>${s.cost}</cost>` +
  `<movement>${s.ma}</movement><strength>${s.st}</strength><agility>${s.ag}</agility><passing>${s.pa}</passing><armour>${s.av}</armour>` +
  `<skillList>${skills.map((k) => `<skill>${k}</skill>`).join("")}</skillList></position>`;
const HUMAN = '<?xml version="1.0" encoding="UTF-8"?>\n<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("10", "Human Lineman", { ma: 6, st: 3, ag: 3, pa: 4, av: 9, cost: 50000 }) +
  pos("11", "Human Thrower", { ma: 6, st: 3, ag: 3, pa: 2, av: 9, cost: 75000 }, ["Sure Hands", "Pass"]) + "</roster>";
const ORC = '<roster id="orc.bb2025"><name>Orc</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("20", "Orc Lineman", { ma: 5, st: 3, ag: 3, pa: 4, av: 10, cost: 50000 }) + "</roster>";
const ROSTERS = new Map([["human.bb2025", HUMAN], ["orc.bb2025", ORC]]);

const player = (playerId: string, number: number, name: string, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId, number, name, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0,
  missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});

const humans = (): LeagueTeam => ({
  id: "grudge", name: "Grudge Rollers", race: "Human", coach: "Ann", coachId: "Ann", teamValue: 1_100_000, treasury: 10_000, rerolls: 2, fans: 2,
  assistantCoaches: 1, cheerleaders: 0, apothecary: true, tier: "2", raceLeague: "",
  players: [
    player("p-thrower", 1, "Arm", "Thrower", { pa: 2, skills: ["Sure Hands", "Pass", "Block"], availableSpp: 8, niggling: 1, value: 95000 }),
    player("p-lino", 2, "Limp", "Human Lineman", { ma: 5, skills: ["Hatred (Undead)"], missNextGame: true }),
    player("p-doomed", 3, "Doomed", "Human Lineman"),
  ],
  formerPlayers: [],
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Green Tide", race: "Orc", coach: "Bob", coachId: "Bob", teamValue: 1_000_000, treasury: 0, rerolls: 3, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "",
  players: [player("q-1", 1, "Grot", "Lineman", { ma: 5, av: 10 })],
  formerPlayers: [],
});

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "Green Tide", teamId: "orcs", coach: "Bob", coachId: "Bob", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, forkEnabled: true, ...over,
});

const season = (fixtures: LeagueFixture[], status: "active" | "completed" = "active"): SeasonRecord => ({
  id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, participants: [], teams: [humans(), orcs()], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("league roster -> fork team file", () => {
  it("writes every player as the league has them, with the fork id map", () => {
    const file = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: humans(), coach: "Ann", rosters: ROSTERS, ruleset: "BB2025", now: new Date(0) });
    const id = forkTeamIdFor("tabbl", "season-7", "grudge");
    expect(file.forkTeamId).toBe(id);
    expect(id).toMatch(/^lg_[a-f0-9]{16}$/);
    expect(file.rosterId).toBe("human.bb2025");
    expect(file.players).toEqual([
      { forkPlayerId: forkPlayerIdFor(id, "p-thrower"), playerId: "p-thrower" },
      { forkPlayerId: forkPlayerIdFor(id, "p-lino"), playerId: "p-lino" },
      { forkPlayerId: forkPlayerIdFor(id, "p-doomed"), playerId: "p-doomed" },
    ]);
    const x = file.xml;
    expect(x).toContain(`<team id="${id}">`);
    expect(x).toContain("<coach>Ann</coach>");
    expect(x).toContain("<name>Grudge Rollers</name>");
    expect(x).toContain("<rosterId>human.bb2025</rosterId>");
    expect(x).toContain("<treasury>10000</treasury>");
    expect(x).toContain("<reRolls>2</reRolls>");
    expect(x).toContain("<fanFactor>2</fanFactor>");
    expect(x).toContain("<apothecaries>1</apothecaries>");
    expect(x).toContain("<assistantCoaches>1</assistantCoaches>");
    expect(x).not.toContain("<custom>");
    expect(x).toContain("<currentTeamValue>110</currentTeamValue>");
    const block = (playerId: string): string => x.match(new RegExp(`<player [^>]*id="${forkPlayerIdFor(id, playerId)}"[\\s\\S]*?</player>`))![0];
    // Thrower: matched by the bare position name, printed skills left out, Block written, SPP and the niggle carried
    expect(block("p-thrower")).toContain("<positionId>11</positionId>");
    expect(block("p-thrower")).toContain("<skillList><skill>Block</skill></skillList>");
    expect(block("p-thrower")).toContain('currentSpps="8"');
    expect(block("p-thrower")).toContain("<injuryList><injury>Serious Injury (NI)</injury></injuryList>");
    expect(block("p-thrower")).not.toContain("<passing>");
    // Lineman with a lost MA point and a missed next game; parameter skills carry their value
    expect(block("p-lino")).toContain("<injury>Smashed Knee (-MA)</injury>");
    expect(block("p-lino")).not.toContain("<movement>");
    expect(block("p-lino")).toContain('<skill value="undead">Hatred</skill>');
    expect(block("p-lino")).toContain('<injury recovering="true">Seriously Hurt (MNG)</injury>');
    expect(block("p-doomed")).toContain("<injuryList/>");
    expect(file.library).toMatchObject({ teamName: "Grudge Rollers", race: "Human", treasury: 10000, rerolls: 2, apothecary: true });
  });

  it("refuses with a readable reason: unknown race, position or skill, empty roster", () => {
    const build = (team: LeagueTeam) => () => buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    expect(build({ ...humans(), race: "Vampire" })).toThrow("Super FUMBBL has no BB2025 Vampire roster.");
    expect(build({ ...humans(), players: [player("x", 1, "Odd", "Wizard")] })).toThrow(/no "Wizard" position/);
    expect(build({ ...humans(), players: [player("x", 1, "Odd", "Human Lineman", { skills: ["Laser Eyes"] })] })).toThrow(ForkTeamBuildError);
    expect(build({ ...humans(), players: [] })).toThrow(/no players/);
  });
});

const fullResult = (homeId: string, awayId: string, over: Partial<ForkGameResult> = {}): ForkGameResult => ({
  gameId: "g42", source: "full", playedAt: "2026-10-30T20:00:00.000Z",
  teams: [
    { teamId: homeId, score: 2, conceded: false, winnings: 60_000, treasurySpent: 10_000, dedicatedFansModifier: 1, players: [
      { forkPlayerId: forkPlayerIdFor(homeId, "p-thrower"), name: "Arm", td: 2, cas: 1, completions: 1, interceptions: 0, mvp: 1, fouls: 0, earnedSpps: 6 + 1 + 4 + 2, injuries: ["Head Injury (-AV)"] },
      { forkPlayerId: forkPlayerIdFor(homeId, "p-doomed"), name: "Doomed", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 1, earnedSpps: 0, injuries: ["Dead (RIP)"] },
      { forkPlayerId: "star-1", name: "Hired Star", td: 0, cas: 1, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 2 },
    ] },
    { teamId: awayId, score: 1, conceded: false, winnings: 40_000, treasurySpent: 0, dedicatedFansModifier: 0, players: [
      { forkPlayerId: forkPlayerIdFor(awayId, "q-1"), name: "Grot", td: 1, cas: 1, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 5, injuries: ["Serious Injury (NI)"] },
    ] },
  ],
  ...over,
});

describe("result -> league team mutation (pure)", () => {
  const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
  const map = humans().players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid, p.playerId), playerId: p.playerId }));

  it("SPP, counters, injuries, death, MNG recovery, treasury, fans; the input is untouched", () => {
    const before = humans();
    const r = fullResult(hid, "away");
    const m = mutateLeagueTeam(before, r.teams[0]!, map, "full");
    expect(before.players).toHaveLength(3);
    const t = m.team;
    const arm = t.players.find((p) => p.playerId === "p-thrower")!;
    expect(arm.availableSpp).toBe(8 + 13);
    expect(arm.stats).toMatchObject({ td: 2, cas: 1, completions: 1, mvp: 1, spp: 13 });
    expect(arm.av).toBe(8);
    expect(arm.missNextGame).toBe(true);
    expect(arm.niggling).toBe(1);
    expect(t.players.find((p) => p.playerId === "p-lino")!.missNextGame).toBe(false); // served last game's MNG
    expect(t.players.find((p) => p.playerId === "p-doomed")).toBeUndefined();
    expect(t.formerPlayers).toEqual([expect.objectContaining({ playerId: "p-doomed", name: "Doomed", stats: expect.objectContaining({ fouls: 1 }) })]);
    expect(m.retired).toEqual(["p-doomed"]);
    expect(t.teamValue).toBe(1_100_000); // the pure mutation leaves the value alone: applyForkResult recomputes it (teamValue.ts)
    expect(t.treasury).toBe(10_000 - 10_000 + 60_000);
    expect(t.fans).toBe(3);
    expect(t.players.every((p) => p.seasonsPlayed === undefined)).toBe(true);
    expect(m.lines.find((l) => l.forkPlayerId === "star-1")).toMatchObject({ name: "Hired Star", cas: 1 });
    expect(m.lines.find((l) => l.forkPlayerId === "star-1")).not.toHaveProperty("playerId");
  });

  it("injury table: NI adds a niggle, characteristic losses, every serious injury misses the next game", () => {
    const one = (injury: string) => mutateLeagueTeam(humans(), { teamId: hid, score: 0, conceded: false, winnings: 0, players: [
      { forkPlayerId: map[2]!.forkPlayerId, name: "", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: [injury] },
    ] }, map, "full").team.players.find((p) => p.playerId === "p-doomed")!;
    expect(one("Serious Injury (NI)")).toMatchObject({ niggling: 1, missNextGame: true });
    expect(one("Smashed Knee (-MA)")).toMatchObject({ ma: 5, missNextGame: true });
    expect(one("Dislocated Shoulder (-ST)")).toMatchObject({ st: 2 });
    expect(one("Dislocated Hip (-AG)")).toMatchObject({ ag: 4 });
    expect(one("Broken Arm (-PA)")).toMatchObject({ pa: 5 });
    expect(one("Seriously Hurt (MNG)")).toMatchObject({ niggling: 0, ma: 6, missNextGame: true });
  });

  it("a conceding team's spendable SPP is cleared; a basic result only adds counters and winnings", () => {
    const conceded = mutateLeagueTeam(humans(), { ...fullResult(hid, "a").teams[0]!, conceded: true }, map, "full").team;
    expect(conceded.players.every((p) => p.availableSpp === 0)).toBe(true);
    const basic = mutateLeagueTeam(humans(), { teamId: hid, score: 1, conceded: false, winnings: 20_000, players: [
      { forkPlayerId: map[0]!.forkPlayerId, name: "Arm", td: 1, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0 },
    ] }, map, "basic").team;
    const arm = basic.players.find((p) => p.playerId === "p-thrower")!;
    expect(arm).toMatchObject({ availableSpp: 8, av: 9, missNextGame: false });
    expect(arm.stats.td).toBe(1);
    expect(basic.players.find((p) => p.playerId === "p-lino")!.missNextGame).toBe(true); // nothing known about recovery
    expect(basic.treasury).toBe(10_000); // winnings without the inducement spend would overstate it: left for an organiser
    expect(basic.fans).toBe(2);
  });

  it("the server's FumbblResult maps to a full result", () => {
    const parsed: ParsedGameResult = { gameId: "g9", halves: 2, teams: [
      { teamId: "A", score: 1, conceded: false, stalled: false, winnings: 50_000, dedicatedFansModifier: -1, treasurySpentOnInducements: 5000, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [
        { playerId: "a1", name: "X", defecting: false, currentSpps: 0, earnedSpps: 3, completions: 0, touchdowns: 1, deflections: 0, interceptions: 0, casualties: 0, playerAwards: 0, landings: 0, blocks: 2, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 16, injuries: [], gainedHatred: [] },
      ] },
      { teamId: "B", score: 0, conceded: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [] },
    ] };
    const r = fromParsedResult(parsed, "2026-10-30T00:00:00.000Z");
    expect(r).toMatchObject({ gameId: "g9", source: "full", teams: [{ teamId: "A", winnings: 50_000, treasurySpent: 5000, dedicatedFansModifier: -1, players: [{ forkPlayerId: "a1", td: 1, earnedSpps: 3 }] }, { teamId: "B", winnings: 0 }] });
  });

  it("closes the fixture once: score, casualties, played; a second apply or another game is refused", () => {
    const s = season([fx("f1")]);
    const f = s.fixtures[0]!;
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    f.fork = { status: "scheduled", gameId: "g42", log: [], teams: {
      home: { teamId: "grudge", forkTeamId: hid, coach: "Ann", builtAt: "", players: map },
      away: { teamId: "orcs", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "q-1"), playerId: "q-1" }] },
    } };
    expect(applyForkResult(s, f, { ...fullResult(hid, aid), gameId: "g1" }, new Date())).toMatchObject({ applied: false });
    const out = applyForkResult(s, f, fullResult(hid, aid), new Date("2026-10-31T00:00:00Z"));
    expect(out.applied).toBe(true);
    expect(f.home).toMatchObject({ score: 2, cas: 2, conceded: false }); // the hired Star's casualty counts for the team
    expect(f.away).toMatchObject({ score: 1, cas: 1 });
    expect(f.finishedAt).toBe("2026-10-30T20:00:00.000Z");
    expect(f.fork!.status).toBe("finished");
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]).toMatchObject({ niggling: 1, missNextGame: true, availableSpp: 5 });
    const again = applyForkResult(s, f, fullResult(hid, aid), new Date());
    expect(again).toMatchObject({ applied: false, already: true });
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]!.availableSpp).toBe(5);
  });
});

describe("extra result data that fills itself (owner 10-30: G1, G2, G4)", () => {
  const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
  const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
  const map = humans().players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid, p.playerId), playerId: p.playerId }));
  const scheduled = (): { s: SeasonRecord; f: LeagueFixture } => {
    const s = season([fx("f1")]);
    const f = s.fixtures[0]!;
    f.fork = { status: "scheduled", gameId: "g42", log: [], teams: {
      home: { teamId: "grudge", forkTeamId: hid, coach: "Ann", builtAt: "", players: map },
      away: { teamId: "orcs", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "q-1"), playerId: "q-1" }] },
    } };
    return { s, f };
  };
  const parsed = (): ParsedGameResult => ({ gameId: "g42", halves: 2, teams: [
    { teamId: hid, score: 2, conceded: false, stalled: false, spectators: 23_000, fame: 1, fanFactor: 4, winnings: 60_000, dedicatedFansModifier: 1,
      casualtiesSuffered: { badlyHurt: 1, seriousInjury: 0, rip: 1 }, players: [
        { playerId: forkPlayerIdFor(hid, "p-thrower"), name: "Arm", defecting: false, currentSpps: 8, earnedSpps: 7, completions: 1, touchdowns: 1, deflections: 1, interceptions: 0, casualties: 0, playerAwards: 1, landings: 0, blocks: 3, fouls: 0, rushing: 41, passing: -2, turnsPlayed: 15, injuries: ["Head Injury (-AV)"], gainedHatred: [] },
        { playerId: forkPlayerIdFor(hid, "p-doomed"), name: "Doomed", defecting: false, completions: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 0, playerAwards: 0, landings: 1, blocks: 0, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 6, injuries: ["Dead (RIP)"], gainedHatred: [] },
        { playerId: forkPlayerIdFor(hid, "p-lino"), name: "Limp", defecting: false, completions: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 0, playerAwards: 0, landings: 0, blocks: 0, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 0, injuries: [], gainedHatred: [] },
      ] },
    { teamId: aid, score: 0, conceded: true, concededLegally: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [
      { playerId: forkPlayerIdFor(aid, "q-1"), name: "Grot", defecting: false, completions: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 2, playerAwards: 0, landings: 0, blocks: 5, fouls: 0, rushing: 3, passing: 0, turnsPlayed: 8, injuries: [], gainedHatred: [] },
    ] },
  ] });

  it("parsing: the concession verdict, casualties suffered, attendance and player counters come through; zeros are omitted", () => {
    const r = fromParsedResult(parsed());
    const [home, away] = r.teams;
    expect(home).toMatchObject({ spectators: 23_000, fame: 1, fanFactor: 4, dedicatedFansModifier: 1, casualtiesSuffered: { badlyHurt: 1, seriousInjury: 0, rip: 1 } });
    expect(home).not.toHaveProperty("concededLegally");
    expect(home!.players[0]).toMatchObject({ blocks: 3, rushing: 41, passing: -2, deflections: 1, turnsPlayed: 15 });
    expect(home!.players[0]).not.toHaveProperty("landings");
    expect(home!.players[2]).not.toHaveProperty("blocks");
    expect(away).toMatchObject({ conceded: true, concededLegally: false });
    expect(away).not.toHaveProperty("casualtiesSuffered");
    expect(away).not.toHaveProperty("spectators");
  });

  it("the basic listing's casualties suffered and blocks / deflections come through too", () => {
    const r = fromBasicResult("g42", { teams: [{ teamId: hid, score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 2, si: 1, rip: 0 },
      players: [{ playerId: "x", name: "X", touchdowns: 0, casualtiesCaused: 0, blocks: 4, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0 }] }] });
    expect(r.teams[0]).toMatchObject({ casualtiesSuffered: { badlyHurt: 2, seriousInjury: 1, rip: 0 }, players: [{ blocks: 4 }] });
    expect(r.teams[0]!.players[0]).not.toHaveProperty("deflections");
  });

  it("banking: the fixture result carries the extra data and the season stats gain the counters, once", () => {
    const { s, f } = scheduled();
    expect(applyForkResult(s, f, fromParsedResult(parsed()), new Date("2026-10-31T00:00:00Z")).applied).toBe(true);
    expect(f.fork!.result!.home).toMatchObject({ casualtiesSuffered: { badlyHurt: 1, seriousInjury: 0, rip: 1 }, spectators: 23_000, fame: 1, fanFactor: 4, dedicatedFansModifier: 1 });
    expect(f.fork!.result!.home).not.toHaveProperty("concededLegally");
    expect(f.fork!.result!.away).toMatchObject({ conceded: true, concededLegally: false });
    expect(f.fork!.result!.away).not.toHaveProperty("casualtiesSuffered");
    const grudge = (): LeagueTeam => s.teams.find((t) => t.id === "grudge")!;
    const arm = () => grudge().players.find((p) => p.playerId === "p-thrower")!;
    expect(arm().stats).toMatchObject({ blocks: 3, rushing: 41, passing: -2, deflections: 1, turnsPlayed: 15, injuries: 1 });
    expect(arm().stats).not.toHaveProperty("landings");
    expect(grudge().players.find((p) => p.playerId === "p-lino")!.stats).toEqual({ ...EMPTY_PLAYER_STATS }); // nothing to add, nothing written
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]!.stats).toMatchObject({ blocks: 5, rushing: 3, turnsPlayed: 8, cas: 2, injuries: 0 });
    // The same game again: refused, nothing counted twice.
    expect(applyForkResult(s, f, fromParsedResult(parsed()), new Date())).toMatchObject({ applied: false, already: true });
    expect(arm().stats).toMatchObject({ blocks: 3, rushing: 41, turnsPlayed: 15, injuries: 1 });
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]!.stats).toMatchObject({ blocks: 5, turnsPlayed: 8 });
  });

  it("injuries = injuries SUFFERED by the victim (a death included, carried to former players); casualties stay inflicted", () => {
    const { s, f } = scheduled();
    applyForkResult(s, f, fromParsedResult(parsed()), new Date());
    const grudge = s.teams.find((t) => t.id === "grudge")!;
    const doomed = grudge.formerPlayers.find((p) => p.playerId === "p-doomed")!;
    expect(doomed.stats).toMatchObject({ injuries: 1, landings: 1, turnsPlayed: 6, cas: 0 });
    const grot = s.teams.find((t) => t.id === "orcs")!.players[0]!;
    expect(grot.stats).toMatchObject({ cas: 2, injuries: 0 }); // the casualty-maker gains cas, never injuries
    // A Decay player's two results in one game are one casualty suffered.
    const decay = mutateLeagueTeam(humans(), { teamId: hid, score: 0, conceded: false, winnings: 0, players: [
      { forkPlayerId: map[0]!.forkPlayerId, name: "", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: ["Seriously Hurt (MNG)", "Smashed Knee (-MA)"] },
    ] }, map, "full").team;
    expect(decay.players.find((p) => p.playerId === "p-thrower")!.stats.injuries).toBe(1);
  });

  it("the game page reads the verdict from the store's fork-game index: no season file read after it is built, a new bank is found at once", () => {
    const dir = mkdtempSync(join(tmpdir(), "league-forkindex-"));
    try {
      let clock = 0;
      const store = new LeagueStore(dir, { now: () => clock });
      store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], playOnFork: true });
      const { s, f } = scheduled();
      const other = { ...season([fx("f9")]), id: "season-6", number: 6, sourceSlug: "s6" };
      store.putSeason(s);
      store.putSeason(other);
      const reads = vi.spyOn(store as unknown as { readJson: (p: string) => unknown }, "readJson");
      const first = store.forkGame("g42");
      expect(first).toMatchObject({ leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1" }); // built here, no verdict yet
      expect(first!.verdicts).toBeUndefined();
      const built = reads.mock.calls.length;
      expect(built).toBeGreaterThan(0);
      expect(store.forkGame("g42")).toBeDefined();
      expect(store.forkGame("no-such-game")).toBeUndefined(); // a miss is answered from the index too
      expect(store.forkGame("no-such-game")).toBeUndefined();
      expect(reads.mock.calls.length).toBe(built);
      // Banking writes through putSeason: the index follows without a rebuild (or a restart).
      const versionBefore = store.forkIndexVersion();
      expect(store.forkIndexVersion()).toBe(versionBefore); // stable while nothing changes
      applyForkResult(s, f, fromParsedResult(parsed()), new Date());
      reads.mockClear();
      store.putSeason(s);
      const banked = reads.mock.calls.length; // putSeason's own revision read
      expect(store.forkIndexVersion()).not.toBe(versionBefore); // the game page's cache stamp moves with the bank
      expect(store.forkGame("g42")).toMatchObject({ leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1", verdicts: { [aid]: false } });
      // the game page's public digest: the banked full result's extras by fork team / player id, never the treasury or team value
      const digest = store.forkGame("g42")!.digest!;
      expect(digest.source).toBe("full");
      expect(Object.keys(digest.teams).length).toBeGreaterThan(0);
      expect(Object.values(digest.teams).some((t) => Object.values(t.players).some((p) => typeof p.position === "string"))).toBe(true);
      expect(JSON.stringify(digest)).not.toMatch(/treasury|teamValue|coach/i);
      expect(reads.mock.calls.length).toBe(banked);
      // Removing the season drops its games.
      const versionBanked = store.forkIndexVersion();
      store.removeSeason("tabbl", "season-7");
      expect(store.forkIndexVersion()).not.toBe(versionBanked);
      expect(store.forkGame("g42")).toBeUndefined();
      expect(reads.mock.calls.length).toBe(banked);
      // A season written by another process shows up once the index is older than its TTL.
      store.putSeason(s);
      new LeagueStore(dir).removeSeason("tabbl", "season-7");
      expect(store.forkGame("g42")).toBeDefined(); // still the cached index
      clock += 10 * 60_000;
      expect(store.forkGame("g42")).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---- routes, with a stub fork ----

interface Stub extends LeagueForkClient {
  installs: Array<Array<{ coach: string; file: LeagueForkTeamFile }>>;
  deletes: string[];
  deleteOk: boolean;
  find: ForkFindOutcome;
  inflight: number;
  maxInflight: number;
  schedules: Array<[string, string]>;
  launches: Array<{ coach: string; teamId: string; gameId: string }>;
  next: ForkScheduleOutcome;
  states: Map<string, { status: "scheduled" | "active" | "finished"; playedAt?: string }>;
  results: Map<string, ForkGameResult>;
}
function stubFork(): Stub {
  const s: Stub = {
    installs: [], schedules: [], launches: [], deletes: [], deleteOk: true, find: { kind: "none" }, inflight: 0, maxInflight: 0,
    next: { kind: "scheduled", gameId: "g42" }, states: new Map(), results: new Map(),
    rosters: () => ROSTERS,
    async prepareGame({ install, home, away }) {
      s.inflight += 1;
      s.maxInflight = Math.max(s.maxInflight, s.inflight);
      try {
        await new Promise((r) => setTimeout(r, 5));
        if (install.length) s.installs.push(install);
        s.schedules.push([home, away]);
        return s.next;
      } finally { s.inflight -= 1; }
    },
    async findGame() { return s.find; },
    async deleteGame(id) { s.deletes.push(id); return s.deleteOk; },
    async launchFile(input) { s.launches.push(input); return `<jnlp coach="${input.coach}" team="${input.teamId}" game="${input.gameId}"/>`; },
    async gameStates(ids) { return new Map([...s.states].filter(([id]) => ids.includes(id))); },
    async result(id) { return s.results.get(id); },
  };
  return s;
}

describe("Super FUMBBL fixture routes", () => {
  let dir: string;
  let store: LeagueStore;
  let fork: Stub;
  let body: unknown;
  const notes: Array<{ coach: string; title: string; body: string }> = [];
  const posts: DiscordPayload[] = [];
  const IDS = [{ coach: "Jay", level: "organizer" }, { coach: "Ann", level: "player" }, { coach: "Bob", level: "player" }, { coach: "Root", level: "admin" }, { coach: "Eve", level: "player" }];
  const deps = (): LeagueApiDeps => ({
    store, fork,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date("2026-10-30T12:00:00Z"),
    identities: () => IDS,
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body }); },
    postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  });
  const ANN = { coach: "Ann", admin: false };
  const BOB = { coach: "bob", admin: false };
  const JAY = { coach: "Jay", admin: false };
  const EVE = { coach: "Eve", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const base = "/api/leagues/tabbl/seasons/season-7/fixtures/f1";
  const call = async (method: string, path: string, auth?: { coach: string; admin: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const fixture = () => store.season("tabbl", "season-7")!.fixtures.find((f) => f.id === "f1")!;
  const view = (r: LeagueApiResult) => (r.body as { fork: Record<string, any> }).fork;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-fork-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], playOnFork: true });
    store.putSeason(season([fx("f1"), fx("f2", { forkEnabled: false })]));
    fork = stubFork();
    notes.length = 0;
    posts.length = 0;
    resetForkToggleLimit();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("summary: public read, Generate offered to the seated coaches and organisers only", async () => {
    const anon = await call("GET", base);
    expect(anon.status).toBe(200);
    expect(view(anon)).toMatchObject({ enabled: true, status: "none", statusLabel: "Not generated", canGenerate: false, canStart: false });
    expect(view(anon)).not.toHaveProperty("log");
    expect(view(await call("GET", base, ANN))).toMatchObject({ canGenerate: true, mySide: "home" });
    expect(view(await call("GET", base, BOB))).toMatchObject({ canGenerate: true, mySide: "away" });
    expect(view(await call("GET", base, JAY))).toMatchObject({ canGenerate: true, canConfigure: true });
    expect(view(await call("GET", base, EVE))).toMatchObject({ canGenerate: false, canConfigure: false });
    expect(view(await call("GET", "/api/leagues/tabbl/seasons/season-7/fixtures/f2", ANN))).toMatchObject({ enabled: false, canGenerate: false, blocker: expect.stringContaining("not allowed") });
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-7/fixtures/nope")).status).toBe(404);
  });

  it("generate: builds both teams, schedules once, invites the opponent and tells organisers and admins", async () => {
    expect((await call("POST", `${base}/fork/generate`, EVE, {})).status).toBe(403);
    expect((await call("POST", `${base}/fork/generate`, undefined, {})).status).toBe(401);
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(200);
    expect(view(r)).toMatchObject({ status: "scheduled", gameId: "g42", canStart: true, canGenerate: false });
    expect(fork.installs).toHaveLength(1);
    expect(fork.installs[0]!.map((t) => t.coach)).toEqual(["Ann", "Bob"]);
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    expect(fork.schedules).toEqual([[hid, aid]]);
    const f = fixture();
    expect(f.fork).toMatchObject({ status: "scheduled", gameId: "g42", generatedBy: "Ann", invited: true });
    expect(f.fork!.teams.home).toMatchObject({ teamId: "grudge", forkTeamId: hid, coach: "Ann" });
    expect(f.fork!.teams.home!.players).toHaveLength(3);
    expect(notes.map((n) => n.coach).sort()).toEqual(["Bob", "Jay", "Root"]);
    expect(notes.find((n) => n.coach === "Bob")!.body).toContain("Ann has invited you to play your match on Super FUMBBL");
    expect(notes.find((n) => n.coach === "Jay")!.title).toBe("Fixture generated on Super FUMBBL");
    // idempotent: a second click (either coach) re-uses the teams and the game
    const again = await call("POST", `${base}/fork/generate`, BOB, {});
    expect(again.status).toBe(200);
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(1);
    expect(notes).toHaveLength(3);
  });

  it("generate and launch announce \"Match started\" once through the league events hook (no duplicate fork embed)", async () => {
    store.setSecrets("tabbl", { discordWebhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123" });
    store.updateLeague("tabbl", (l) => { l.discordEvents = { ...DEFAULT_DISCORD_EVENTS, news: true, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true }; });
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect((await call("POST", `${base}/fork/generate`, BOB, {})).status).toBe(200);
    expect((await call("POST", `${base}/fork/launch`, ANN, {})).status).toBe(200);
    expect(posts.map((p) => p.embeds[0]!.title)).toEqual(["TABBL: kick-off"]);
    expect(posts[0]!.embeds[0]!.description).toContain("has started on Super FUMBBL");
    expect(fixture().announced?.started).toBeTruthy();
  });

  it("a double click at the same moment builds and schedules once", async () => {
    const [a, b] = await Promise.all([call("POST", `${base}/fork/generate`, ANN, {}), call("POST", `${base}/fork/generate`, BOB, {})]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(1);
  });

  it("an organiser generates: both coaches are invited", async () => {
    expect((await call("POST", `${base}/fork/generate`, JAY, {})).status).toBe(200);
    expect(notes.filter((n) => n.title === "Play on Super FUMBBL").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
    expect(notes.find((n) => n.coach === "Ann")!.body).toContain("Jay has invited you");
  });

  it("blocked: fixture not allowed, league toggle off, a played fixture, a finished season unless late launch is allowed", async () => {
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/fixtures/f2/fork/generate", ANN, {})).status).toBe(409);
    store.updateLeague("tabbl", (l) => { l.playOnFork = false; });
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).body).toMatchObject({ error: expect.stringContaining("off for this league") });
    store.updateLeague("tabbl", (l) => { l.playOnFork = true; });
    const s = store.season("tabbl", "season-7")!;
    s.status = "completed";
    store.putSeason(s);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).body).toMatchObject({ error: expect.stringContaining("late launch") });
    expect((await call("PATCH", base, ANN, { forkAllowLate: true })).status).toBe(403);
    const late = await call("PATCH", base, JAY, { forkAllowLate: true });
    expect(late.status).toBe(200);
    expect((late.body as { fixture: LeagueFixture }).fixture.forkAllowLate).toBe(true);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect(fork.schedules).toHaveLength(1);
  });

  it("a team build failure is reported and nothing is scheduled", async () => {
    const s = store.season("tabbl", "season-7")!;
    s.teams[0]!.players[0]!.skills.push("Laser Eyes");
    store.putSeason(s);
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("Laser Eyes");
    expect(fork.installs).toHaveLength(0);
    fork.prepareGame = async () => { throw new Error("reload refused"); };
    s.teams[0]!.players[0]!.skills.pop();
    store.putSeason(s);
    const r2 = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r2.status).toBe(502);
    expect(fork.schedules).toHaveLength(0);
    expect(view(await call("GET", base, JAY))).toMatchObject({ status: "none", canGenerate: true });
  });

  it("launch failed: reason shown, organiser reset with a logged reason, then generate re-uses the teams", async () => {
    fork.next = { kind: "rejected", error: "fork admin/schedule: team not loaded" };
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(502);
    expect(view(r)).toMatchObject({ status: "launch_failed", statusLabel: "Failed", error: "fork admin/schedule: team not loaded", canStart: false });
    expect(notes).toHaveLength(0);
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(409);
    expect((await call("POST", `${base}/fork/reset`, ANN, { reason: "retry" })).status).toBe(403);
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "  " })).status).toBe(400);
    expect(view(await call("GET", base, JAY))).toMatchObject({ canReset: true });
    const reset = await call("POST", `${base}/fork/reset`, JAY, { reason: "Teams reloaded by hand" });
    expect(reset.status).toBe(200);
    expect(view(reset)).toMatchObject({ status: "teams_built", canGenerate: true });
    expect(view(reset).log.at(-1)).toMatchObject({ by: "Jay", text: "Reset: Teams reloaded by hand" });
    fork.next = { kind: "scheduled", gameId: "g77" };
    expect(view(await call("POST", `${base}/fork/generate`, ANN, {}))).toMatchObject({ status: "scheduled", gameId: "g77" });
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(2);
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "x" })).status).toBe(409);
  });

  it("launch file: the seated coach only (403 for anyone else, organisers and admins too)", async () => {
    expect((await call("GET", `${base}/fork/jnlp`, ANN)).status).toBe(409); // nothing scheduled yet
    await call("POST", `${base}/fork/generate`, ANN, {});
    for (const who of [EVE, JAY, ROOT]) expect((await call("GET", `${base}/fork/jnlp`, who)).status).toBe(403);
    expect((await call("POST", `${base}/fork/launch`, EVE, {})).status).toBe(403);
    const launch = await call("POST", `${base}/fork/launch`, BOB, {});
    expect(launch.body).toMatchObject({ jnlpUrl: `${base}/fork/jnlp`, side: "away", gameId: "g42" });
    expect(fixture().fork!.launched).toEqual({ away: "2026-10-30T12:00:00.000Z" });
    const j = await call("GET", `${base}/fork/jnlp`, BOB);
    expect(j.status).toBe(200);
    expect(j.download!.contentType).toContain("jnlp");
    expect(j.download!.bytes.toString()).toContain(`team="${forkTeamIdFor("tabbl", "season-7", "orcs")}"`);
    expect(fork.launches).toEqual([{ coach: "Bob", teamId: forkTeamIdFor("tabbl", "season-7", "orcs"), gameName: "league-f1", gameId: "g42" }]);
    // cancelled: no launch file
    expect((await call("PATCH", base, JAY, { forkCancelled: true })).status).toBe(200);
    expect(fixture().fork!.status).toBe("cancelled");
    expect((await call("GET", `${base}/fork/jnlp`, BOB)).status).toBe(409);
  });

  it("result sync: in progress, then the result closes the fixture once, mutates both teams and notifies", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    store.setSecrets("tabbl", { discordWebhookUrl: "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123" });
    notes.length = 0;
    fork.states.set("g42", { status: "active" });
    await syncLeagueForkResults({ store, fork, notify: deps().notify, postWebhook: deps().postWebhook });
    expect(fixture().fork!.status).toBe("in_progress");
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    fork.states.set("g42", { status: "finished", playedAt: "2026-10-30T20:00:00.000Z" });
    fork.results.set("g42", fullResult(hid, aid));
    const [one, two] = await Promise.all([
      syncLeagueForkResults({ store, fork, notify: deps().notify, postWebhook: deps().postWebhook }),
      call("POST", `${base}/fork/sync`, JAY, {}),
    ]);
    expect(two.status).toBe(200);
    const s = store.season("tabbl", "season-7")!;
    const f = s.fixtures.find((x) => x.id === "f1")!;
    expect(f.home.score).toBe(2);
    expect(f.away.score).toBe(1);
    expect(f.fork!.status).toBe("finished");
    expect(f.fork!.result).toMatchObject({ gameId: "g42", source: "full", home: { score: 2, winnings: 60_000 } });
    const home = s.teams.find((t) => t.id === "grudge")!;
    expect(home.treasury).toBe(60_000);
    expect(home.fans).toBe(3);
    expect(home.players.map((p) => p.playerId)).toEqual(["p-thrower", "p-lino"]);
    expect(home.formerPlayers.map((p) => p.playerId)).toEqual(["p-doomed"]);
    expect(home.players[0]!.availableSpp).toBe(21);
    expect(one.applied.length + ((two.body as { applied: string[] }).applied.length)).toBe(1);
    expect(notes.filter((n) => n.title === "Super FUMBBL result recorded").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
    // One match-end post through the league events hook (events.ts): a recorded Super FUMBBL game gets the end-of-game
    // digest (on by default for leagues) built from the banked result, not the plain result line.
    const ends = posts.filter((p) => / 2 - 1 /.test(p.embeds[0]!.title) || (p.embeds[0]!.title === "TABBL: result" && p.embeds[0]!.description.includes("2 - 1")));
    expect(ends).toHaveLength(1);
    expect(ends[0]!.embeds[0]!.footer?.text).toBe("Played on Super FUMBBL");
    // again: nothing more
    await syncLeagueForkResults({ store, fork, notify: deps().notify });
    expect(store.season("tabbl", "season-7")!.teams.find((t) => t.id === "grudge")!.players[0]!.availableSpp).toBe(21);
    expect(notes.filter((n) => n.title === "Super FUMBBL result recorded")).toHaveLength(2);
    // the summary shows the lines; the season read carries the status only
    const sum = view(await call("GET", base, EVE));
    expect(sum).toMatchObject({ status: "finished", result: { home: { lines: expect.arrayContaining([expect.objectContaining({ playerId: "p-thrower", td: 2 })]) } } });
    const read = (await call("GET", "/api/leagues/tabbl/seasons/season-7", EVE)).body as { season: SeasonRecord };
    // the season read carries the finished game's id (its game page is public; the Calendar links it), nothing else
    expect(read.season.fixtures[0]!.fork).toEqual({ status: "finished", gameId: "g42", teams: {}, log: [] });
  });
  it("[review P2] a result arriving while a team is redrafting is held, never applied by the timer, and released by an organiser after", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    // Orcs are in an open redraft window (stored on a season of the league; the block reads every season's redraft)
    const s7 = store.season("tabbl", "season-7")!;
    const budget = { base: 0, treasury: 0, played: 0, wins: 0, draws: 0, bonus: 0, raw: 0, capped: 0 };
    s7.redraft = {
      startedAt: "2026-10-30T00:00:00.000Z", byCoach: "Jay", capEnabled: false, cap: 0, revision: 1, log: [],
      teams: [{ teamId: "orcs", sourceSeasonId: "season-7", name: "Orcs", coach: "Bob", race: "Orc", selected: true, budget, status: "pending" }],
      window: { opensAt: "2000-01-01T00:00:00.000Z", closesAt: "2100-01-01T00:00:00.000Z" },
    };
    store.putSeason(s7);
    notes.length = 0;
    fork.states.set("g42", { status: "finished", playedAt: "2026-10-30T20:00:00.000Z" });
    fork.results.set("g42", fullResult(hid, aid));
    const held = await syncLeagueForkResults({ store, fork, notify: deps().notify });
    expect(held.applied).toEqual([]);
    let f = store.season("tabbl", "season-7")!.fixtures.find((x) => x.id === "f1")!;
    expect(f.home.score).toBeNull();
    expect(f.fork!.redraftHold).toMatchObject({ gameId: "g42" });
    expect(f.fork!.redraftHold!.reason).toMatch(/Orcs is redrafting/);
    expect(store.season("tabbl", "season-7")!.teams.find((t) => t.id === "grudge")!.treasury).not.toBe(60_000); // rosters untouched
    expect(notes.filter((n) => n.title === "Super FUMBBL result held for the redraft").map((n) => n.coach)).toContain("Jay");
    // the timer again: still held, told once
    await syncLeagueForkResults({ store, fork, notify: deps().notify });
    const heldNotes = notes.filter((n) => n.title === "Super FUMBBL result held for the redraft").length;
    // the redraft closes: the timer still leaves the held result alone (an organiser decides)
    const s = store.season("tabbl", "season-7")!;
    s.redraft!.closedAt = "2026-11-01T00:00:00.000Z";
    store.putSeason(s);
    await syncLeagueForkResults({ store, fork, notify: deps().notify });
    expect(store.season("tabbl", "season-7")!.fixtures.find((x) => x.id === "f1")!.home.score).toBeNull();
    expect(notes.filter((n) => n.title === "Super FUMBBL result held for the redraft")).toHaveLength(heldNotes);
    // the organiser's Check for a result releases and applies it
    const rel = await call("POST", `${base}/fork/sync`, JAY, {});
    expect(rel.status).toBe(200);
    f = store.season("tabbl", "season-7")!.fixtures.find((x) => x.id === "f1")!;
    expect(f.home.score).toBe(2);
    expect(f.fork!.redraftHold).toBeUndefined();
    expect(f.fork!.log.some((l) => /released after the redraft/.test(l.text))).toBe(true);
  });

  // Kickoff figures (pre-result CTV + dedicated fans x 10k), what the fork's teamValue counts:
  // Grudge Rollers: Arm 95k + Doomed 50k (Limp misses the game) + 2 rerolls 100k + assistant 10k + apothecary 50k = 305k, + 2 fans = 325k.
  // Green Tide: Grot 50k + 3 rerolls x 60k = 230k, + 1 fan = 240k.
  const syncWithForkValues = async (home: number, away: number) => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const r = fullResult(forkTeamIdFor("tabbl", "season-7", "grudge"), forkTeamIdFor("tabbl", "season-7", "orcs"));
    r.teams[0]!.teamValue = home;
    r.teams[1]!.teamValue = away;
    fork.states.set("g42", { status: "finished", playedAt: "2026-10-30T20:00:00.000Z" });
    fork.results.set("g42", r);
    await syncLeagueForkResults({ store, fork });
    return store.season("tabbl", "season-7")!;
  };

  it("result sync: a fork team value that matches the league's kickoff figure records no diff and no event", async () => {
    const s = await syncWithForkValues(325_000, 240_000);
    const f = s.fixtures.find((x) => x.id === "f1")!;
    expect(f.fork!.status).toBe("finished");
    expect(f.fork!.result!.home).not.toHaveProperty("forkTeamValueDiff");
    expect(f.fork!.result!.away).not.toHaveProperty("forkTeamValueDiff");
    expect(f.fork!.log.some((e) => e.text.startsWith("Fork team value differs"))).toBe(false);
    expect((s.log ?? []).some((e) => e.kind === "team-value-diff")).toBe(false);
  });

  it("result sync: the league recomputes both team values; a differing fork kickoff value is logged for organisers only as information", async () => {
    const s = await syncWithForkValues(365_000, 240_000);
    const home = s.teams.find((t) => t.id === "grudge")!;
    // Arm 95k (now misses the next game) + Limp 50k + 2 rerolls x 50k + 1 assistant 10k + apothecary 50k; Doomed died.
    expect(home).toMatchObject({ teamValue: 305_000, currentTeamValue: 210_000 });
    // Grot 50k (misses the next game) + 3 rerolls x 60k (Orc listed price).
    expect(s.teams.find((t) => t.id === "orcs")).toMatchObject({ teamValue: 230_000, currentTeamValue: 180_000 });
    const f = s.fixtures.find((x) => x.id === "f1")!;
    expect(f.fork!.result!.home.forkTeamValueDiff).toBe(40_000);
    expect(f.fork!.result!.away).not.toHaveProperty("forkTeamValueDiff");
    const text = "Fork team value differs by +40k for Grudge Rollers (fork 365k, league kickoff 325k).";
    expect(f.fork!.log.map((e) => e.text)).toContain(text);
    expect(s.log!.filter((e) => e.kind === "team-value-diff")).toEqual([expect.objectContaining({ fixtureId: "f1", teamId: "grudge", text })]);
    // The fork history (where the entry lives) is organiser-only: a public read carries no log.
    expect(view(await call("GET", base, EVE))).not.toHaveProperty("log");
    expect(view(await call("GET", base, JAY)).log.map((e: { text: string }) => e.text)).toContain(text);
    // The public season read drops the organiser-only log kinds; organisers still read them.
    const kinds = async (who?: { coach: string; admin: boolean }) =>
      ((await call("GET", "/api/leagues/tabbl/seasons/season-7", who)).body as { season: SeasonRecord }).season.log?.map((e) => e.kind) ?? [];
    expect(await kinds()).not.toContain("team-value-diff");
    expect(await kinds(EVE)).not.toContain("team-value-diff");
    expect(await kinds()).toContain("match-result");
    expect(await kinds(JAY)).toContain("team-value-diff");
    expect(await kinds(ROOT)).toContain("team-value-diff");
  });

  it("a fixture that got a result by hand is never overwritten by the fork result", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    const f = s.fixtures.find((x) => x.id === "f1")!;
    f.home.score = 0; f.away.score = 0;
    store.putSeason(s);
    fork.states.set("g42", { status: "finished" });
    fork.results.set("g42", fullResult(forkTeamIdFor("tabbl", "season-7", "grudge"), forkTeamIdFor("tabbl", "season-7", "orcs")));
    const out = await syncLeagueForkResults({ store, fork });
    expect(out.applied).toEqual([]);
    expect(out.errors[0]).toContain("already has a result");
    expect(store.season("tabbl", "season-7")!.teams[0]!.treasury).toBe(10_000);
  });

  it("no fork connected: actions answer 503, the summary still reads", async () => {
    const plain = { ...deps(), fork: undefined };
    const r = await leagueApi("POST", `${base}/fork/generate`, new URLSearchParams(), ANN, plain);
    expect(r!.status).toBe(503);
    const g = await leagueApi("GET", base, new URLSearchParams(), ANN, plain);
    expect((g!.body as { forkAvailable: boolean }).forkAvailable).toBe(false);
  });

  // ---- review regressions (Sol 6.1 round 1) ----

  it("P1-3: two fixtures of one team never prepare at once; install and schedule are one critical section", async () => {
    const s = store.season("tabbl", "season-7")!;
    s.fixtures.push(fx("f3"));
    store.putSeason(s);
    const [a, b] = await Promise.all([
      call("POST", `${base}/fork/generate`, ANN, {}),
      call("POST", "/api/leagues/tabbl/seasons/season-7/fixtures/f3/fork/generate", ANN, {}),
    ]);
    expect(fork.maxInflight).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(((a.status === 409 ? a : b).body as { error: string }).error).toContain("in another Super FUMBBL game");
    expect(fork.installs).toHaveLength(1);
    expect(fork.schedules).toHaveLength(1);
  });

  it("P1-4: an uncertain schedule is reconciled before a reset; a found game is kept, an unconfirmed check refuses", async () => {
    fork.next = { kind: "unknown", error: "timeout" };
    await call("POST", `${base}/fork/generate`, ANN, {});
    expect(fixture().fork).toMatchObject({ status: "launch_failed", uncertain: true });
    fork.find = { kind: "unknown", error: "list not confirmed" };
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "retry" })).status).toBe(503);
    expect(fixture().fork!.status).toBe("launch_failed");
    fork.find = { kind: "found", gameId: "g99" };
    const kept = await call("POST", `${base}/fork/reset`, JAY, { reason: "retry" });
    expect(kept.status).toBe(200);
    expect(fixture().fork).toMatchObject({ status: "scheduled", gameId: "g99" });
    expect(fixture().fork).not.toHaveProperty("uncertain");
    expect(fork.schedules).toHaveLength(1); // nothing scheduled again
  });

  it("P1-4: an uncertain schedule with no game on the fork may be reset and generated again", async () => {
    fork.next = { kind: "unknown", error: "timeout" };
    await call("POST", `${base}/fork/generate`, ANN, {});
    fork.find = { kind: "none" };
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "no game" })).status).toBe(200);
    fork.next = { kind: "scheduled", gameId: "g50" };
    expect(view(await call("POST", `${base}/fork/generate`, ANN, {}))).toMatchObject({ status: "scheduled", gameId: "g50" });
  });

  it("P1-4: cancel keeps a game it cannot withdraw, keeps syncing it, and allowing play again keeps the reference", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    fork.deleteOk = false;
    expect((await call("PATCH", base, JAY, { forkCancelled: true })).status).toBe(200);
    expect(fork.deletes).toEqual(["g42"]);
    expect(fixture().fork).toMatchObject({ status: "cancelled", gameId: "g42" });
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(409);
    expect((await call("PATCH", base, JAY, { forkCancelled: false })).status).toBe(200);
    expect(fixture().fork).toMatchObject({ status: "scheduled", gameId: "g42" });
    expect(fork.schedules).toHaveLength(1);
    // cancelled again; the game is played anyway: the result still lands
    await call("PATCH", base, JAY, { forkCancelled: true });
    fork.states.set("g42", { status: "finished" });
    fork.results.set("g42", fullResult(forkTeamIdFor("tabbl", "season-7", "grudge"), forkTeamIdFor("tabbl", "season-7", "orcs")));
    const out = await syncLeagueForkResults({ store, fork });
    expect(out.applied).toEqual(["g42"]);
    expect(fixture().home.score).toBe(2);
  });

  it("P1-4: cancel withdraws an unstarted game the fork confirms; allowing play again needs a new game", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    await call("PATCH", base, JAY, { forkCancelled: true });
    expect(fixture().fork!.gameId).toBeUndefined();
    await call("PATCH", base, JAY, { forkCancelled: false });
    expect(fixture().fork!.status).toBe("teams_built");
    fork.next = { kind: "scheduled", gameId: "g60" };
    expect(view(await call("POST", `${base}/fork/generate`, ANN, {}))).toMatchObject({ status: "scheduled", gameId: "g60" });
    expect((await call("PATCH", base, JAY, { forkEnabled: true, forkCancelled: true })).status).toBe(400);
  });

  it("P2-6: before the first launch a changed league roster rebuilds that team and replaces the unstarted game", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    s.teams[0]!.players[0]!.skills.push("Dodge");
    store.putSeason(s);
    fork.next = { kind: "scheduled", gameId: "g43" };
    const r = await call("POST", `${base}/fork/launch`, ANN, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ gameId: "g43", rebuilt: ["home"] });
    expect(fork.deletes).toEqual(["g42"]);
    expect(fork.installs).toHaveLength(2);
    expect(fork.installs[1]!.map((t) => t.coach)).toEqual(["Ann"]);
    expect(fork.installs[1]![0]!.file.xml).toContain("<skill>Dodge</skill>");
    expect(fixture().fork).toMatchObject({ status: "scheduled", gameId: "g43", launched: { home: expect.any(String) } });
    // play has started: no more rebuilds, and the league roster is locked
    const later = store.season("tabbl", "season-7")!;
    later.teams[1]!.players[0]!.skills = ["Block"];
    store.putSeason(later);
    expect((await call("POST", `${base}/fork/launch`, BOB, {})).body).toMatchObject({ gameId: "g43" });
    expect(fork.deletes).toHaveLength(1);
    expect(forkPlayLock(store.season("tabbl", "season-7")!, "orcs")).toContain("locked until the result is in");
    expect(targetConflict(store.season("tabbl", "season-7")!, { id: "grudge", name: "Grudge Rollers" })).toContain("locked until the result is in");
  });

  it("P2-6: a changed roster whose old game cannot be withdrawn refuses the launch and keeps the game", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    s.teams[1]!.treasury = 90_000;
    store.putSeason(s);
    fork.deleteOk = false;
    const r = await call("POST", `${base}/fork/launch`, BOB, {});
    expect(r.status).toBe(409);
    expect(fixture().fork).toMatchObject({ status: "scheduled", gameId: "g42" });
    expect(fixture().fork!.launched).toBeUndefined();
  });

  it("P2-7: a BB2020 season is refused before anything is installed", async () => {
    const s = store.season("tabbl", "season-7")!;
    s.ruleset = "BB2020";
    store.putSeason(s);
    const r = await call("POST", `${base}/fork/generate`, ANN, {});
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("BB2025 league fixtures only");
    expect(fork.installs).toHaveLength(0);
    expect(fork.schedules).toHaveLength(0);
    expect(view(await call("GET", base, ANN))).toMatchObject({ canGenerate: false, blocker: expect.stringContaining("BB2020") });
  });

  it("P2-9: a basic result leaves the treasuries and flags the fixture for an organiser", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
    const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
    fork.states.set("g42", { status: "finished" });
    fork.results.set("g42", { gameId: "g42", source: "basic", teams: [
      { teamId: hid, score: 1, conceded: false, winnings: 50_000, players: [] },
      { teamId: aid, score: 0, conceded: true, winnings: 0, players: [] },
    ] });
    await syncLeagueForkResults({ store, fork });
    const s = store.season("tabbl", "season-7")!;
    expect(s.teams.find((t) => t.id === "grudge")!.treasury).toBe(10_000);
    expect(s.fixtures[0]!.fork!.result).toMatchObject({ source: "basic", financialPending: true });
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]!.availableSpp).toBe(0);
    expect(s.teams.find((t) => t.id === "grudge")!.players[0]!.availableSpp).toBe(8);
  });

  // ---- review regressions (Sol 6.1 round 2) ----

  it("GET jnlp is read-only (Sol 11-01 P2): before POST launch it answers 409 and rebuilds, withdraws and records nothing", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    s.teams[0]!.players[0]!.availableSpp = 30; // stale roster: only POST launch may rebuild it
    store.putSeason(s);
    fork.next = { kind: "scheduled", gameId: "g44" };
    const before = JSON.stringify(fixture().fork);
    const j = await call("GET", `${base}/fork/jnlp`, ANN); // e.g. an <img> or a link on a same-site page
    expect(j.status).toBe(409);
    expect(fork.deletes).toEqual([]);
    expect(fork.launches).toHaveLength(0);
    expect(JSON.stringify(fixture().fork)).toBe(before);
    expect(fixture().fork!.launched).toBeUndefined();
  });

  it("POST launch rebuilds a stale team and records the launch; the GET then serves the rebuilt game's file and writes nothing", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    s.teams[0]!.players[0]!.availableSpp = 30;
    store.putSeason(s);
    fork.next = { kind: "scheduled", gameId: "g44" };
    const launch = await call("POST", `${base}/fork/launch`, ANN, {});
    expect(launch.status).toBe(200);
    expect(fork.deletes).toEqual(["g42"]);
    const after = JSON.stringify(fixture().fork);
    expect(fixture().fork).toMatchObject({ gameId: "g44", launched: { home: expect.any(String) } });
    const j = await call("GET", `${base}/fork/jnlp`, ANN);
    expect(j.status).toBe(200);
    expect(j.download!.bytes.toString()).toContain('game="g44"');
    expect(JSON.stringify(fixture().fork)).toBe(after);
    // The other seat has not pressed Start Game: no file for it yet.
    expect((await call("GET", `${base}/fork/jnlp`, BOB)).status).toBe(409);
  });

  it("R2-5: a team record without a fingerprint counts as stale: rebuilt through a confirmed withdrawal", async () => {
    await call("POST", `${base}/fork/generate`, ANN, {});
    const s = store.season("tabbl", "season-7")!;
    delete s.fixtures[0]!.fork!.teams.away!.revision;
    store.putSeason(s);
    fork.next = { kind: "scheduled", gameId: "g45" };
    const r = await call("POST", `${base}/fork/launch`, BOB, {});
    expect(r.body).toMatchObject({ gameId: "g45", rebuilt: ["away"] });
    expect(fork.deletes).toEqual(["g42"]);
    expect(fixture().fork!.teams.away!.revision).toMatch(/^[a-f0-9]{16}$/);
  });
});

// ---- review regressions (Sol 6.1 round 1): pure ----

/** The fork's load path (ffb-common RosterPlayer.updatePosition): position base, then +X skills, then lasting injuries clamped to the limits. */
const LIMIT: Record<string, [number, number]> = { MA: [1, 9], ST: [1, 8], AG: [1, 6], PA: [1, 6], AV: [3, 11] };
const INJURY_STAT: Record<string, string> = { "Smashed Knee (-MA)": "MA", "Dislocated Shoulder (-ST)": "ST", "Dislocated Hip (-AG)": "AG", "Broken Arm (-PA)": "PA", "Head Injury (-AV)": "AV" };
function forkLoad(block: string, roster: string): Record<string, number> {
  const posId = block.match(/<positionId>([^<]+)<\/positionId>/)![1];
  const pos = roster.match(new RegExp(`<position id="${posId}">[\\s\\S]*?</position>`))![0];
  const n = (tag: string): number => Number(pos.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))![1]);
  const st: Record<string, number> = { MA: n("movement"), ST: n("strength"), AG: n("agility"), PA: n("passing"), AV: n("armour") };
  for (const m of block.matchAll(/<skill[^>]*>\+(MA|ST|AG|PA|AV)<\/skill>/g)) st[m[1]!]! += m[1] === "AG" || m[1] === "PA" ? -1 : 1;
  for (const m of block.matchAll(/<injury>([^<]+)<\/injury>/g)) {
    const k = INJURY_STAT[m[1]!];
    if (!k) continue;
    st[k] = k === "AG" || k === "PA" ? Math.min(st[k]! + 1, LIMIT[k]![1]) : Math.max(st[k]! - 1, LIMIT[k]![0]);
  }
  return st;
}

describe("review regressions: team file, admin lists, banking, mutation limits", () => {
  it("P1-1: characteristics survive the fork's load path (advances as +X skills, losses as stat injuries, no overrides)", () => {
    const team: LeagueTeam = { ...humans(), players: [
      player("a", 1, "Advanced", "Human Lineman", { ma: 7, ag: 2, pa: 3 }),
      player("b", 2, "Battered", "Human Lineman", { st: 2, av: 8, ma: 5 }),
      player("c", 3, "Mixed", "Thrower", { pa: 3, av: 10 }),
    ] };
    const file = buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    expect(file.xml).not.toMatch(/<(movement|strength|agility|passing|armour)>/);
    for (const p of team.players) {
      const block = file.xml.match(new RegExp(`<player [^>]*id="${forkPlayerIdFor(file.forkTeamId, p.playerId)}"[\\s\\S]*?</player>`))![0];
      expect(forkLoad(block, HUMAN), p.name).toEqual({ MA: p.ma, ST: p.st, AG: p.ag, PA: p.pa, AV: p.av });
    }
    expect(statDelta({ ma: 7, st: 3, ag: 2, pa: 4, av: 8 }, { MA: 6, ST: 3, AG: 3, PA: 4, AV: 9 })).toEqual({ increases: ["+MA", "+AG"], injuries: ["Head Injury (-AV)"] });
  });

  it("P2-7: rosters are picked by the season's edition; other editions are refused", () => {
    const legacy = new Map([["human", HUMAN.replace('id="human.bb2025"', 'id="human"')]]);
    expect(forkRosterFor("Human", legacy, "BB2025")).toBeUndefined();
    expect(forkRosterFor("Human", ROSTERS, "BB2025")!.roster.rosterId).toBe("human.bb2025");
    expect(() => buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team: humans(), coach: "Ann", rosters: ROSTERS, ruleset: "BB2020" })).toThrow(/BB2025 league fixtures only/);
  });

  it("P1-2: an admin list is trusted only with an ok status, and only one admin exchange runs at a time", async () => {
    const cfg = { baseUrl: "http://fork.test", passwordMd5Hex: "0".repeat(32) } as never;
    const ok = '<admin><list size="1"><game id="7" status="active"><team home="true" id="A" name="A" coach="x"/><team home="false" id="B" name="B" coach="y"/></game></list><status>ok</status></admin>';
    let inflight = 0;
    let max = 0;
    // the stub stands in for adminList: an exchange on the shared transport queue
    const slow = (xml: string) => (c: { baseUrl: string }): Promise<string> => adminExchange(c, async () => { inflight += 1; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 5)); inflight -= 1; return xml; });
    const lists = await Promise.all([confirmedList(cfg, "active", slow(ok)), confirmedList(cfg, "paused", slow(ok)), confirmedList(cfg, "scheduled", slow(ok))]);
    expect(max).toBe(1);
    expect(lists[0]!.map((g) => g.gameId)).toEqual(["7"]);
    await expect(confirmedList(cfg, "active", slow('<admin><list size="0"/><status>fail</status></admin>'))).rejects.toThrow(/could not be confirmed/);
    await expect(confirmedList(cfg, "active", slow("<admin><status>ok</status></admin>"))).rejects.toThrow(/could not be confirmed/);
  });

  it("P1-5: a casualty result banks against a league team (the roster resolves through the team's rosterId)", () => {
    const dir = mkdtempSync(join(tmpdir(), "league-bank-"));
    try {
      const teamsDir = join(dir, "teams");
      mkdirSync(teamsDir, { recursive: true });
      mkdirSync(join(dir, "rosters"), { recursive: true });
      writeFileSync(join(dir, "rosters", "roster_human.xml"), HUMAN);
      const team: LeagueTeam = { ...humans(), players: [player("k", 1, "Keeper", "Human Lineman", { skills: ["Block"], availableSpp: 4 }), player("d", 2, "Doomed", "Human Lineman")] };
      const file = buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
      writeFileSync(join(teamsDir, `team_Ann_${file.forkTeamId}.xml`), file.xml);
      const pr = (playerId: string, over: Partial<ParsedGameResult["teams"][number]["players"][number]> = {}) => ({
        playerId, name: "", defecting: false, currentSpps: 0, earnedSpps: 0, completions: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 0,
        playerAwards: 0, landings: 0, blocks: 0, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 16, injuries: [] as string[], gainedHatred: [] as string[], ...over,
      });
      const parsed: ParsedGameResult = { gameId: "g5", halves: 2, teams: [
        { teamId: file.forkTeamId, score: 1, conceded: false, stalled: false, winnings: 50_000, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 1 }, players: [
          pr(forkPlayerIdFor(file.forkTeamId, "k"), { currentSpps: 4, earnedSpps: 3, touchdowns: 1 }),
          pr(forkPlayerIdFor(file.forkTeamId, "d"), { injuries: ["Dead (RIP)"] }),
        ] },
        { teamId: "other", score: 0, conceded: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [] },
      ] };
      const task = buildBankTasks(parsed, teamsDir).find((t) => t.teamId === file.forkTeamId)!;
      const out = task.applyFn(file.xml);
      expect(out).not.toContain(forkPlayerIdFor(file.forkTeamId, "d"));
      expect(out).toContain('currentSpps="7"');
      expect(out).toContain("<teamRating>105</teamRating>"); // 110 - the dead lineman's 50k
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const hid2 = forkTeamIdFor("tabbl", "season-7", "grudge");
  const map2 = humans().players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid2, p.playerId), playerId: p.playerId }));
  const injured = (over: Partial<LeaguePlayer>, injury: string) => mutateLeagueTeam({ ...humans(), players: [player("p-doomed", 3, "Doomed", "Human Lineman", over)] },
    { teamId: hid2, score: 0, conceded: false, winnings: 0, players: [{ forkPlayerId: map2[2]!.forkPlayerId, name: "", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: [injury] }] },
    map2, "full").team.players[0]!;

  it("P2-10: injuries respect the fork's characteristic limits and still miss the next game", () => {
    expect(injured({ ma: 1 }, "Smashed Knee (-MA)")).toMatchObject({ ma: 1, missNextGame: true });
    expect(injured({ st: 1 }, "Dislocated Shoulder (-ST)")).toMatchObject({ st: 1, missNextGame: true });
    expect(injured({ ag: 6 }, "Dislocated Hip (-AG)")).toMatchObject({ ag: 6, missNextGame: true });
    expect(injured({ pa: 6 }, "Broken Arm (-PA)")).toMatchObject({ pa: 6, missNextGame: true });
    expect(injured({ av: 3 }, "Head Injury (-AV)")).toMatchObject({ av: 3, missNextGame: true });
    expect(injured({ av: 9 }, "Head Injury (-AV)")).toMatchObject({ av: 8 });
  });

  it("P2-8: a basic concession result keeps spendable SPP; a full one clears it", () => {
    const side = { teamId: hid2, score: 0, conceded: true, winnings: 0, players: [] };
    expect(mutateLeagueTeam(humans(), side, map2, "basic").team.players[0]!.availableSpp).toBe(8);
    expect(mutateLeagueTeam(humans(), side, map2, "full").team.players[0]!.availableSpp).toBe(0);
  });

  it("P2-9: a basic result never touches the treasury and marks the result financially pending", () => {
    const basic = mutateLeagueTeam({ ...humans(), treasury: 100_000 }, { teamId: hid2, score: 1, conceded: false, winnings: 50_000, players: [] }, map2, "basic").team;
    expect(basic.treasury).toBe(100_000);
    const full = mutateLeagueTeam({ ...humans(), treasury: 100_000 }, { teamId: hid2, score: 1, conceded: false, winnings: 50_000, treasurySpent: 40_000, players: [] }, map2, "full").team;
    expect(full.treasury).toBe(110_000);
  });
});

// ---- review regressions (Sol 6.1 round 2): pure ----

describe("review regressions round 2: stat advances, banking +MA, the banking guard", () => {
  it("R2-3: an advance offset by a lasting injury keeps both; the fork load gives the league value with the advance counted", () => {
    expect(statDelta({ ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: ["+ST"] }, { MA: 6, ST: 3, AG: 3, PA: 4, AV: 9 }))
      .toEqual({ increases: ["+ST"], injuries: ["Dislocated Shoulder (-ST)"] });
    const team: LeagueTeam = { ...humans(), players: [player("o", 1, "Offset", "Human Lineman", { st: 3, ag: 2, skills: ["+ST", "+AG"] })] };
    const file = buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    const block = file.xml.match(/<player [\s\S]*?<\/player>/)![0];
    expect(forkLoad(block, HUMAN)).toMatchObject({ ST: 3, AG: 2 });
    expect(block.match(/<skill>\+ST<\/skill>/g)).toHaveLength(1);
    expect(block.match(/<skill>\+AG<\/skill>/g)).toHaveLength(1);
    expect(block).toContain("<injury>Dislocated Shoulder (-ST)</injury>");
  });

  const bankDir = (): { dir: string; teamsDir: string } => {
    const dir = mkdtempSync(join(tmpdir(), "league-bank2-"));
    const teamsDir = join(dir, "teams");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(join(dir, "rosters"), { recursive: true });
    writeFileSync(join(dir, "rosters", "roster_human.xml"), HUMAN);
    return { dir, teamsDir };
  };
  const pr = (playerId: string, over: Record<string, unknown> = {}) => ({
    playerId, name: "", defecting: false, currentSpps: 0, earnedSpps: 0, completions: 0, touchdowns: 0, deflections: 0, interceptions: 0, casualties: 0,
    playerAwards: 0, landings: 0, blocks: 0, fouls: 0, rushing: 0, passing: 0, turnsPlayed: 16, injuries: [] as string[], gainedHatred: [] as string[], ...over,
  });
  const bank = (injury: string, fast: Partial<LeaguePlayer> = { ma: 7, skills: ["+MA"], value: null }, asBuilderTeam = false) => {
    const { dir, teamsDir } = bankDir();
    try {
      const team: LeagueTeam = { ...humans(), players: [player("fast", 1, "Fast", "Human Lineman", fast), player("plain", 2, "Plain", "Human Lineman")] };
      const file = buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
      writeFileSync(join(teamsDir, `team_Ann_${file.forkTeamId}.xml`), file.xml);
      const parsed: ParsedGameResult = { gameId: "g8", halves: 2, teams: [
        { teamId: file.forkTeamId, score: 0, conceded: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [
          pr(forkPlayerIdFor(file.forkTeamId, "fast"), { injuries: [injury] }), pr(forkPlayerIdFor(file.forkTeamId, "plain")),
        ] },
        { teamId: "other", score: 0, conceded: false, stalled: false, casualtiesSuffered: { badlyHurt: 0, seriousInjury: 0, rip: 0 }, players: [] },
      ] };
      const xml = asBuilderTeam ? file.xml.replace(/ storedValue="\d*"/g, "") : file.xml;
      if (asBuilderTeam) writeFileSync(join(teamsDir, `team_Ann_${file.forkTeamId}.xml`), xml);
      return { file, out: buildBankTasks(parsed, teamsDir).find((t) => t.teamId === file.forkTeamId)!.applyFn(xml) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("R2-1: a death on a generated +MA player banks, priced from the advancement table (50k + 20k)", () => {
    const { file, out } = bank("Dead (RIP)");
    expect(out).not.toContain(forkPlayerIdFor(file.forkTeamId, "fast"));
    expect(out).toContain("<teamRating>103</teamRating>"); // 110 - 7
    expect(out).toContain("<currentTeamValue>103</currentTeamValue>");
  });

  it("R2-1: a missed game on a generated +MA player banks (current value only)", () => {
    const { out } = bank("Seriously Hurt (MNG)");
    expect(out).toContain('<injury recovering="true">Seriously Hurt (MNG)</injury>');
    expect(out).toContain("<teamRating>110</teamRating>");
    expect(out).toContain("<currentTeamValue>103</currentTeamValue>");
  });

  it("stored value: a death on a Block + Guard player banks from the stored value, no throw", () => {
    const { file, out } = bank("Dead (RIP)", { skills: ["Block", "Guard"], value: 90000 });
    expect(file.xml).toContain('storedValue="90000"');
    expect(out).not.toContain(forkPlayerIdFor(file.forkTeamId, "fast"));
    expect(out).toContain("<teamRating>101</teamRating>"); // 110 - 9
    expect(out).toContain("<currentTeamValue>101</currentTeamValue>");
  });

  it("stored value absent: banking falls back to computed pricing", () => {
    const { file, out } = bank("Dead (RIP)", { ma: 7, skills: ["+MA"], value: null });
    expect(file.xml).toMatch(/<player nr="1" id="[^"]*" storedValue=""><name>Fast/);
    expect(out).toContain("<teamRating>103</teamRating>");
  });

  it("fallback pricing: Primary 20k, Secondary 40k, Elite = access price + 10k, trait free, unknown throws", () => {
    const posXml = (cats: string) => `<position id="10"><cost>50000</cost><skillList/>${cats}</position>`;
    const roster = (cats: string) => `<roster>${posXml(cats)}</roster>`;
    const one = (skill: string) => `<player nr="1" id="x"><positionId>10</positionId><skillList><skill>${skill}</skill></skillList><injuryList/></player>`;
    const primary = roster("<normal>General</normal><double>Strength</double>");
    const secondary = roster("<normal>Passing</normal><double>General</double>");
    expect(computedPlayerValue(one("Sure Hands"), primary, true)).toBe(70_000);
    expect(computedPlayerValue(one("Sure Hands"), secondary, true)).toBe(90_000);
    expect(computedPlayerValue(one("Block"), primary, true)).toBe(80_000);
    expect(computedPlayerValue(one("Block"), secondary, true)).toBe(100_000);
    expect(computedPlayerValue(one("Loner"), primary, true)).toBe(50_000);
    expect(() => computedPlayerValue(one("Nonexistent Skill"), primary, true)).toThrow(/unknown skill/);
  });

  it("a tournament-builder team (no storedValue attributes) keeps rejecting Secondary/Elite skills on a death", () => {
    expect(() => bank("Dead (RIP)", { skills: ["Block"], value: null }, true)).toThrow(/cannot safely price Elite skill Block/);
    expect(() => bank("Seriously Hurt (MNG)", { skills: ["Block"], value: null }, true)).toThrow(/cannot safely price Elite skill Block/);
    // A league team (the file carries storedValue attributes) with no stored value for the player prices the skill.
    expect(computedPlayerValue('<player nr="1" id="x" storedValue=""><positionId>10</positionId><skillList><skill>Block</skill></skillList><injuryList/></player>',
      `<roster><position id="10"><cost>50000</cost><skillList/><normal>General</normal></position></roster>`, true)).toBe(80_000);
  });

  it("shiftStoredPlayerValue moves a numeric stored value only", () => {
    expect(shiftStoredPlayerValue('<player id="a" storedValue="50000"><x/></player>', 20_000)).toBe('<player id="a" storedValue="70000"><x/></player>');
    expect(shiftStoredPlayerValue('<player id="a" storedValue=""><x/></player>', 20_000)).toBe('<player id="a" storedValue=""><x/></player>');
    expect(shiftStoredPlayerValue('<player id="a"><x/></player>', 20_000)).toBe('<player id="a"><x/></player>');
  });

  it("the pre-game banking guard is gone: a team with Block schedules a build", () => {
    const team: LeagueTeam = { ...humans(), players: [player("e", 1, "Elite", "Human Lineman", { skills: ["Block"] })] };
    expect(() => buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" })).not.toThrow();
  });
});

describe("league-fork-test findings: TABBL rosters the fork names differently", () => {
  const roster = (id: string, race: string, positions: string) =>
    `<roster id="${id}"><name>${race}</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${positions}</roster>`;
  const S = { ma: 6, st: 3, ag: 3, pa: 4, av: 9, cost: 50000 };
  const SLANN = roster("slann.bb2025", "Slann 2025", pos("40", "Lineman", S) + pos("41", "Blitzer", { ...S, cost: 110000 }));
  const DWARF = roster("dwarf.bb2025", "Dwarf", pos("50", "Dwarf Blocker Lineman", { ...S, ma: 4, av: 10 }) + pos("51", "Dwarf Blitzer", { ...S, ma: 5, av: 10, cost: 80000 }));
  const AMAZON = roster("amazon.bb2025", "Amazon", pos("60", "Jaguar Warrior Blocker", { ...S, st: 4, cost: 110000 }) + pos("61", "Piranha Warrior", S));
  const GOBLIN = roster("goblin.bb2025", "Goblin", pos("70", "Goblin Lineman", { ...S, st: 2, av: 8, cost: 40000 }) + pos("71", "Fanatic", { ...S, ma: 3, st: 7, av: 8, cost: 70000 }));
  const rosters = new Map([["slann.bb2025", SLANN], ["dwarf.bb2025", DWARF], ["amazon.bb2025", AMAZON], ["goblin.bb2025", GOBLIN]]);
  const team = (race: string, players: LeaguePlayer[]): LeagueTeam => ({ ...humans(), id: race.toLowerCase(), name: `${race} XI`, race, players });
  const build = (t: LeagueTeam) => buildLeagueForkTeam({ leagueId: "l", seasonId: "s", team: t, coach: "Ann", rosters, ruleset: "BB2025" });

  it("a fork roster named with its edition ('Slann 2025') is the league's Slann roster, positions without the race word", () => {
    expect(forkRosterFor("Slann", rosters, "BB2025")!.roster.rosterId).toBe("slann.bb2025");
    const file = build(team("Slann", [player("s1", 1, "Hop", "Slann Blitzer"), player("s2", 2, "Skip", "Slann Lineman")]));
    expect(file.xml).toContain("<positionId>41</positionId>");
    expect(file.xml).toContain("<positionId>40</positionId>");
  });

  it("a league short position name matches the one roster position holding all its words", () => {
    const dwarves = build(team("Dwarf", [player("d1", 1, "Grim", "Dwarf Lineman", { ma: 4, av: 10 })]));
    expect(dwarves.xml).toContain("<positionId>50</positionId>");
    const amazons = build(team("Amazon", [player("a1", 1, "Cat", "Jaguar Warrior", { st: 4 })]));
    expect(amazons.xml).toContain("<positionId>60</positionId>");
  });

  it("an ambiguous short name is still refused (never a guess)", () => {
    expect(() => build(team("Amazon", [player("a1", 1, "Who", "Warrior")]))).toThrow(/has no "Warrior" position/);
  });

  it("'Ball & Chain' is the dataset's Ball and Chain", () => {
    const file = build(team("Goblin", [player("g1", 1, "Spinny", "Fanatic", { ma: 3, st: 7, av: 8, skills: ["Ball & Chain"] })]));
    expect(file.xml).toContain("<skill>Ball and Chain</skill>");
  });
});

describe("fixture deadlines meet Super FUMBBL (deadlines.ts)", () => {
  const hid = forkTeamIdFor("tabbl", "season-7", "grudge");
  const aid = forkTeamIdFor("tabbl", "season-7", "orcs");
  const map = humans().players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid, p.playerId), playerId: p.playerId }));
  const scheduled = (): { s: SeasonRecord; f: LeagueFixture } => {
    const s = season([fx("f1")]);
    const f = s.fixtures[0]!;
    f.fork = { status: "scheduled", gameId: "g42", log: [], teams: {
      home: { teamId: "grudge", forkTeamId: hid, coach: "Ann", builtAt: "", players: map },
      away: { teamId: "orcs", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "q-1"), playerId: "q-1" }] },
    } };
    return { s, f };
  };
  const both = (f: LeagueFixture, auto: boolean): void => {
    f.home = { ...f.home, score: 0, cas: null, conceded: true };
    f.away = { ...f.away, score: 0, cas: null, conceded: true };
    f.deadlineOutcome = { outcome: "both-lose", at: "2026-10-30T00:00:00.000Z", ...(auto ? { auto: true as const } : { by: "Org" }) };
  };

  it("a real result replaces a job-applied both-lose placeholder, rosters included", () => {
    const { s, f } = scheduled();
    both(f, true);
    const out = applyForkResult(s, f, fullResult(hid, aid), new Date("2026-10-31T00:00:00Z"));
    expect(out.applied).toBe(true);
    expect(f.deadlineOutcome).toBeUndefined();
    expect(f.home).toMatchObject({ score: 2, conceded: false });
    expect(f.away).toMatchObject({ score: 1, conceded: false });
    expect(s.teams.find((t) => t.id === "orcs")!.players[0]).toMatchObject({ availableSpp: 5 });
  });

  it("an organiser's both-lose decision is a decided result: the sync leaves it", () => {
    const { s, f } = scheduled();
    both(f, false);
    expect(applyForkResult(s, f, fullResult(hid, aid), new Date())).toMatchObject({ applied: false });
    expect(f.deadlineOutcome?.by).toBe("Org");
  });

  it("auto-forfeit waits for a launched, running or unreported Super FUMBBL game", () => {
    for (const status of ["scheduled", "in_progress", "teams_built", "launch_failed", "cancelled", "finished"] as const) {
      const { s, f } = scheduled();
      f.fork!.status = status;
      if (status === "teams_built") delete f.fork!.gameId;
      s.deadlinePolicy = { autoForfeit: true, outcome: "review" };
      s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: "2026-10-01T00:00:00.000Z" }];
      const due = dueFixtures(s, new Date("2026-10-31T00:00:00Z")).length;
      expect(due, status).toBe(status === "teams_built" || status === "launch_failed" || status === "cancelled" ? 1 : 0);
      expect(forkGamePending(f), status).toBe(due === 0);
    }
  });
});
