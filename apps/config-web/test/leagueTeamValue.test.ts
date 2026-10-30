import { describe, expect, it } from "vitest";
import { applyForkResult, type ForkGameResult } from "../src/leagues/forkResult";
import { forkPlayerIdFor, forkTeamIdFor } from "../src/leagues/forkTeam";
import { applyDraftTeam } from "../src/leagues/redraft";
import { computeTeamValue, fallbackPlayerValue, kickoffTeamValue, refreshTeamValues, signedK, teamValueRoster } from "../src/leagues/teamValue";
import { buildSeason } from "../src/leagues/tourplay";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";

const HUMAN = teamValueRoster("Human")!;
const NURGLE = teamValueRoster("Nurgle")!;

const pl = (playerId: string, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId, number: null, name: playerId, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50_000, level: "Rookie",
  availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});

const team = (over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: "t", name: "Team", race: "Human", coach: "Ann", teamValue: 999, treasury: 0, rerolls: 0, fans: 6, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [], ...over,
});

const season = (teams: LeagueTeam[], fixtures: LeagueFixture[] = [], ruleset: "BB2025" | "BB2020" = "BB2025"): SeasonRecord => ({
  id: "season-7", leagueId: "l", number: 7, name: "Season 7", sourceSlug: "s7", ruleset, status: "active", phases: [], fixtures, participants: [],
  teams, honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("computeTeamValue", () => {
  it("stored player values + rerolls at the roster's listed price + staff; dedicated fans add nothing", () => {
    expect(HUMAN.reRollCost).toBe(50_000);
    const t = team({ rerolls: 3, assistantCoaches: 2, cheerleaders: 1, apothecary: true, fans: 7, players: [pl("a", "Human Lineman"), pl("b", "Human Blitzer", { value: 105_000 })] });
    expect(computeTeamValue(t, HUMAN)).toEqual({ teamValue: 155_000 + 150_000 + 20_000 + 10_000 + 50_000, currentTeamValue: 385_000, unpriced: [] });
  });

  it("current team value leaves out the players who miss the next game; former players never count", () => {
    const t = team({ rerolls: 1, players: [pl("a", "Human Lineman"), pl("b", "Human Thrower", { value: 95_000, missNextGame: true })],
      formerPlayers: [{ playerId: "gone", name: "Gone", position: "Human Lineman", level: "", stats: { ...EMPTY_PLAYER_STATS } }] });
    expect(computeTeamValue(t, HUMAN)).toMatchObject({ teamValue: 50_000 + 95_000 + 50_000, currentTeamValue: 50_000 + 50_000 });
  });

  it("a player without a stored value is priced by the banker's fallback: Primary 20k, Secondary 40k, Elite +10k, traits free, +X table", () => {
    const p = pl("x", "Human Lineman", { value: null, st: 4, skills: ["Block", "Dodge", "Hatred (Undead)", "+ST"] });
    // 50k + Block (Primary, Elite) 30k + Dodge (Secondary, Elite) 50k + Hatred (trait) 0 + ST 60k
    expect(fallbackPlayerValue(p, HUMAN)).toEqual({ value: 190_000, unpriced: [] });
    expect(computeTeamValue(team({ players: [p] }), HUMAN).teamValue).toBe(190_000);
    // A characteristic above the position without a "+X" entry is an increase too (the fork file writes it so).
    expect(fallbackPlayerValue(pl("y", "Human Lineman", { value: null, ma: 7 }), HUMAN).value).toBe(70_000);
    // The position's printed skills are free.
    expect(fallbackPlayerValue(pl("z", "Human Thrower", { value: null, skills: ["Sure Hands", "Pass"] }), HUMAN).value).toBe(75_000);
    expect(fallbackPlayerValue(pl("q", "Wizard", { value: null }), HUMAN)).toEqual({ value: undefined, unpriced: ['q: the Human roster has no "Wizard" position'] });
  });

  it("skill spellings the fork team file accepts price the same: \"&\" reads as \"and\", parameters dropped", () => {
    // Hit and Run is Agility: Secondary for a Human Lineman (50k + 40k), as the banker prices the fork file.
    expect(fallbackPlayerValue(pl("h", "Human Lineman", { value: null, skills: ["Hit & Run"] }), HUMAN)).toEqual({ value: 90_000, unpriced: [] });
    // A Goblin Fanatic's printed Ball and Chain, written with "&", is free.
    const goblin = teamValueRoster("Goblin")!;
    expect(fallbackPlayerValue(pl("f", "Fanatic", { value: null, ma: 3, st: 7, ag: 3, pa: null, av: 8, skills: ["Ball & Chain", "No Ball", "Secret Weapon", "Stunty"] }), goblin))
      .toEqual({ value: 70_000, unpriced: [] });
  });

  it("an apothecary only counts when the roster may hire one", () => {
    expect(NURGLE.apothecaryAllowed).toBe(false);
    const t = team({ race: "Nurgle", apothecary: true, rerolls: 1, players: [pl("r", "Rotter Lineman", { value: 40_000 })] });
    expect(computeTeamValue(t, NURGLE).teamValue).toBe(40_000 + NURGLE.reRollCost);
    expect(computeTeamValue({ ...t, race: "Human" }, HUMAN).teamValue).toBe(40_000 + 50_000 + 50_000);
  });

  it("refreshTeamValues: BB2025 seasons only; a race the dataset cannot resolve keeps its value", () => {
    const s = season([team({ players: [pl("a", "Human Lineman")] }), team({ id: "u", race: "Martians", teamValue: 777 })]);
    expect(refreshTeamValues(s, undefined, { now: new Date("2026-10-30T12:00:00Z") })).toEqual(["u"]);
    expect(s.teams[0]).toMatchObject({ teamValue: 50_000, currentTeamValue: 50_000 });
    expect(s.teams[1]!.teamValue).toBe(777);
    // Not silent: the season log says so, once per team however often the hook runs.
    refreshTeamValues(s);
    expect(s.log).toEqual([{ at: "2026-10-30T12:00:00.000Z", by: "Super FUMBBL", kind: "team-value-unresolved", teamId: "u", text: 'Team value not recomputed for Team: race "Martians" not in dataset.' }]);
    // The marker lives on the team, so the capped log evicting the entry never repeats it; a new race logs again.
    expect(s.teams[1]!.valueUnresolvedRace).toBe("Martians");
    s.log = [];
    refreshTeamValues(s);
    expect(s.log).toEqual([]);
    s.teams[1]!.race = "Venusians";
    refreshTeamValues(s);
    expect(s.log.map((e) => e.text)).toEqual(['Team value not recomputed for Team: race "Venusians" not in dataset.']);
    s.teams[1]!.race = "Human";
    refreshTeamValues(s);
    expect(s.teams[1]).not.toHaveProperty("valueUnresolvedRace");
    const old = season([team({ players: [pl("a", "Human Lineman")] })], [], "BB2020");
    expect(refreshTeamValues(old)).toEqual(["t"]);
    expect(old.teams[0]!.teamValue).toBe(999);
    expect(old.log).toBeUndefined(); // other editions are skipped by design
    // Kickoff figure: unset dedicated fans count 1, as the fork team file writes them (forkTeam.ts forkDedicatedFans).
    expect(kickoffTeamValue(team({ fans: null, players: [pl("a", "Human Lineman")] }), "BB2025")).toBe(50_000 + 10_000);
    expect(signedK(40_000)).toBe("+40k");
    expect(signedK(-20_000)).toBe("-20k");
  });
});

describe("the value refreshes on every mutation path", () => {
  it("fork result banking: recomputed after a death and a new MNG; the fork's kickoff figure is compared like for like, never adopted", () => {
    const home = team({ id: "home", name: "Home", rerolls: 2, players: [pl("a", "Human Lineman"), pl("b", "Human Lineman"), pl("c", "Human Blitzer", { value: 85_000 })] });
    const away = team({ id: "away", name: "Away", players: [pl("z", "Human Lineman")] });
    const hid = forkTeamIdFor("l", "season-7", "home");
    const aid = forkTeamIdFor("l", "season-7", "away");
    const f: LeagueFixture = {
      id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
      home: { team: "Home", teamId: "home", coach: "Ann", race: "Human", score: null, cas: null, conceded: false },
      away: { team: "Away", teamId: "away", coach: "Bob", race: "Human", score: null, cas: null, conceded: false },
      fork: { status: "in_progress", gameId: "g1", log: [], teams: {
        home: { teamId: "home", forkTeamId: hid, coach: "Ann", builtAt: "", players: home.players.map((p) => ({ forkPlayerId: forkPlayerIdFor(hid, p.playerId), playerId: p.playerId })) },
        away: { teamId: "away", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "z"), playerId: "z" }] },
      } },
    };
    const s = season([home, away], [f]);
    const zero = { td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0 };
    const result: ForkGameResult = { gameId: "g1", source: "full", teams: [
      { teamId: hid, score: 1, conceded: false, winnings: 0, teamValue: 345_000, players: [
        { forkPlayerId: forkPlayerIdFor(hid, "a"), name: "a", ...zero, injuries: ["Dead (RIP)"] },
        { forkPlayerId: forkPlayerIdFor(hid, "b"), name: "b", ...zero, injuries: ["Seriously Hurt (MNG)"] },
      ] },
      { teamId: aid, score: 0, conceded: false, winnings: 0, teamValue: 50_000, players: [] },
    ] };
    const out = applyForkResult(s, f, result, new Date("2026-10-30T12:00:00Z"));
    expect(out.applied).toBe(true);
    const h = s.teams.find((t) => t.id === "home")!;
    // b 50k + c 85k + 2 rerolls x 50k; b misses the next game
    expect(h).toMatchObject({ teamValue: 235_000, currentTeamValue: 185_000 });
    // Kickoff figures (pre-result CTV + dedicated fans x 10k): home a 50k + b 50k + c 85k + 2 rerolls 100k = 285k + 6 fans 60k = 345k,
    // which matches the fork's 345k: no diff. Away 50k + 6 fans 60k = 110k against the fork's 50k: -60k.
    expect(f.fork!.result!.home).not.toHaveProperty("forkTeamValueDiff");
    expect(f.fork!.result!.away.forkTeamValueDiff).toBe(-60_000);
    if (out.applied) expect(out.teamValueDiffs).toEqual([{ side: "away", teamId: "away", team: "Away", diff: -60_000, fork: 50_000, leagueKickoff: 110_000 }]);
  });

  it("fork result banking: a player without a stored value keeps his inferred advancement value after an injury lowers it", () => {
    // ST 4 Human Lineman with no "+ST" entry and no stored value: 50k + ST 60k = 110k.
    const home = team({ id: "home", name: "Home", players: [pl("a", "Human Lineman", { value: null, st: 4 })] });
    const away = team({ id: "away", name: "Away", players: [pl("z", "Human Lineman")] });
    const hid = forkTeamIdFor("l", "season-7", "home");
    const aid = forkTeamIdFor("l", "season-7", "away");
    const f: LeagueFixture = {
      id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
      home: { team: "Home", teamId: "home", coach: "Ann", race: "Human", score: null, cas: null, conceded: false },
      away: { team: "Away", teamId: "away", coach: "Bob", race: "Human", score: null, cas: null, conceded: false },
      fork: { status: "in_progress", gameId: "g1", log: [], teams: {
        home: { teamId: "home", forkTeamId: hid, coach: "Ann", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(hid, "a"), playerId: "a" }] },
        away: { teamId: "away", forkTeamId: aid, coach: "Bob", builtAt: "", players: [{ forkPlayerId: forkPlayerIdFor(aid, "z"), playerId: "z" }] },
      } },
    };
    const s = season([home, away], [f]);
    const zero = { td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0 };
    const out = applyForkResult(s, f, { gameId: "g1", source: "full", teams: [
      { teamId: hid, score: 0, conceded: false, winnings: 0, players: [{ forkPlayerId: forkPlayerIdFor(hid, "a"), name: "a", ...zero, injuries: ["Dislocated Shoulder (-ST)"] }] },
      { teamId: aid, score: 0, conceded: false, winnings: 0, players: [] },
    ] }, new Date("2026-10-30T12:00:00Z"));
    expect(out.applied).toBe(true);
    const a = s.teams.find((t) => t.id === "home")!.players[0]!;
    expect(a).toMatchObject({ st: 3, value: 110_000, missNextGame: true });
    expect(s.teams.find((t) => t.id === "home")).toMatchObject({ teamValue: 110_000, currentTeamValue: 0 });
  });

  it("redraft: the placed roster is recomputed by the receiving season", () => {
    const s = season([]);
    applyDraftTeam(s, team({ rerolls: 1, cheerleaders: 2, players: [pl("a", "Human Lineman", { missNextGame: true }), pl("b", "Human Lineman")] }));
    expect(s.teams[0]).toMatchObject({ teamValue: 100_000 + 50_000 + 20_000, currentTeamValue: 50_000 + 50_000 + 20_000 });
  });

  it("import: TourPlay's value is kept as importedTeamValue; missing stored values are priced and stored; the value is recomputed", () => {
    const crlf = (rows: string[]): string => rows.join("\r\n");
    const roster = crlf([
      "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet",
      "Hammers;Human;Ann;300000;0;1;3;1;0;True;2;;;WorldsEdgeSuperleague;BB2025",
      " ",
      "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame",
      "1;Stored;Human Blitzer;7;3;3;4;9;Block,Tackle;105000;Rookie;0;;",
      "2;Unvalued;Human Lineman;6;3;3;4;9;Block;;Rookie;0;;",
      "3;Hurt;Human Lineman;6;3;3;4;9;;50000;Rookie;0;;True",
      " ",
      "Inducement;Quantity;Value",
    ]);
    const built = buildSeason({ leagueId: "l", number: 7, ruleset: "BB2025", files: { slug: "x", standings: [], honours: [], rosters: [{ name: "r", text: roster }] }, mapCoach: () => undefined });
    const t = built.season.teams[0]!;
    expect(t.importedTeamValue).toBe(300_000);
    expect(t.players.find((p) => p.name === "Unvalued")!.value).toBe(80_000); // Lineman 50k + Block (Primary, Elite) 30k
    // 105k + 80k + 50k + 1 reroll 50k + 1 assistant 10k + apothecary 50k; Hurt misses the next game
    expect(t).toMatchObject({ teamValue: 345_000, currentTeamValue: 295_000 });
  });
});
