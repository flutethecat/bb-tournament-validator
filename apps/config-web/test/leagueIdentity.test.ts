import { describe, expect, it } from "vitest";
import { buildCoachAliases, fixtureOutcome } from "../src/leagues/identity";
import { linkPlayerCareers } from "../src/leagues/playerIds";
import { leagueStats } from "../src/leagues/stats";
import { attachPlayerStats, buildSeason, checkStandings, parseHonours } from "../src/leagues/tourplay";
import { EMPTY_PLAYER_STATS, type FixtureSide, type LeagueFixture, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";

// Regressions from the league review (Sol 6.1, four P2s): team identity, duplicate player names, partial coach
// mapping, concessions.

const BOM = "﻿";
const csv = (lines: string[]): string => BOM + lines.join("\r\n") + "\r\n";
const FIX_HEAD = "Category;Phase;Group;Round;Table;TeamNameHome;TeamNameAway;CoachHome;CoachAway;TeamRaceHome;TeamRaceAway;NafUserHome;NafUserAway;ScoreHome;ScoreAway;CasualtiesHome;CasualtiesAway;Suspended;ConcedeHome;ConcedeAway;UtcStart;UtcFinish";
const STAND_HEAD = "Category;Phase;Group;Rank;TeamName;TeamRace;Coach;Points;CustomPoints;BuchholzScore;SonnebornBergerScore;CumulativeScore;Played;Wins;Draws;Losses;TdFor;TdAgainst;CasualtiesFor;CasualtiesAgainst;InjuriesFor;InjuriesAgainst;Completions;Interceptions;DeathsFor;DeathsAgainst;FoulsFor;FoulsAgainst;SentOffsFor;SentOffsAgainst;SecretObjectives";
const ROSTER_HEAD = "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet";
const PLAYER_HEAD = "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame";
const fixRow = (r: number, home: string, away: string, hc: string, ac: string, hr: string, ar: string, hs: number, as: number, extra = ";;") =>
  `Season;Regular;;${r};1;${home};${away};${hc};${ac};${hr};${ar};;;${hs};${as};0;0;${extra};2026-06-0${r}T00:00:00Z;2026-06-0${r}T02:00:00Z`;
const standRow = (rank: number, team: string, race: string, coach: string, w: number, d: number, l: number) =>
  `Season;Regular;;${rank};${team};${race};${coach};${w * 3 + d};0;0;0;0;${w + d + l};${w};${d};${l};0;0;0;0;0;0;0;0;0;0;0;0;0;0;0`;
const roster = (team: string, race: string, coach: string, players: string[]) =>
  csv([ROSTER_HEAD, `${team};${race};${coach};1000000;0;2;1;0;0;False;1;;;;BB2025`, " ", PLAYER_HEAD, ...players, " ", "Inducement;Quantity;Value"]);
const honour = (stat: string, rows: string[]) => ({ name: `season-${stat}-player-honors.csv`, text: csv(["Category;Rank;Name;Position;Level;TeamName;TeamRace;Coach;Value", ...rows]) });
const none = (): undefined => undefined;

const side = (team: string, coach: string, race: string, score: number, over: Partial<FixtureSide> = {}): FixtureSide =>
  ({ team, coach, race, score, cas: 0, conceded: false, ...over });
let fid = 0;
const fixture = (home: FixtureSide, away: FixtureSide, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: `f${++fid}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: fid, table: 1, home, away, suspended: false, ...over,
});
const team = (name: string, coach: string, race: string, players: Array<[number, string, string, Partial<typeof EMPTY_PLAYER_STATS>]>, extra: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: `${name}-${coach}`.toLowerCase(), name, race, coach, teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null, cheerleaders: null,
  apothecary: false, tier: "", raceLeague: "", formerPlayers: [], ...extra,
  players: players.map(([number, pname, position, stats]) => ({ playerId: "", number, name: pname, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS, ...stats } })),
});
const season = (number: number, fixtures: LeagueFixture[], teams: LeagueTeam[] = [], over: Partial<SeasonRecord> = {}): SeasonRecord => {
  const s = seasonRecord(number, fixtures, teams, over);
  linkPlayerCareers([s]);
  return s;
};
const seasonRecord = (number: number, fixtures: LeagueFixture[], teams: LeagueTeam[] = [], over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${number}`, leagueId: "l", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status: "completed",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }], fixtures, participants: [], teams, honours: [], awards: [],
  unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export", ...over,
});

describe("P2-1: same-named teams of different coaches stay apart", () => {
  const built = () => buildSeason({
    leagueId: "l", number: 1, ruleset: "BB2025", mapCoach: none,
    files: {
      slug: "x",
      fixtures: csv([FIX_HEAD,
        fixRow(1, "United", "Rovers", "Ann", "Cy", "Human", "Orc", 2, 0),
        fixRow(2, "Rovers", "United", "Cy", "Bea", "Orc", "Dwarf", 3, 1)]),
      standings: [{ name: "x-season-regular-standings.csv", text: csv([STAND_HEAD,
        standRow(1, "Rovers", "Orc", "Cy", 1, 0, 1),
        standRow(2, "United", "Human", "Ann", 1, 0, 0),
        standRow(3, "United", "Dwarf", "Bea", 0, 0, 1)]) }],
      honours: [honour("mosttouchdowns", ["Season;1;Gus;Lineman;Rookie;United;;;2"])],
      rosters: [
        { name: "united-human-ann-roster.csv", text: roster("United", "Human", "Ann", ["1;Gus;Lineman;6;3;3;4;9;;50000;Rookie;0;;"]) },
        { name: "united-dwarf-bea-roster.csv", text: roster("United", "Dwarf", "Bea", ["1;Gus;Lineman;4;3;4;5;10;;70000;Rookie;0;;"]) },
        { name: "rovers-orc-cy-roster.csv", text: roster("Rovers", "Orc", "Cy", []) },
      ],
    },
  });

  it("import: one team id per coach, fixtures and standings resolve to it, the check passes per team", () => {
    const { season: s, mismatches, ambiguities } = built();
    const united = s.teams.filter((t) => t.name === "United");
    expect(united.map((t) => t.coach).sort()).toEqual(["Ann", "Bea"]);
    expect(new Set(united.map((t) => t.id)).size).toBe(2);
    const ann = united.find((t) => t.coach === "Ann")!;
    const bea = united.find((t) => t.coach === "Bea")!;
    expect(s.fixtures[0]!.home.teamId).toBe(ann.id);
    expect(s.fixtures[1]!.away.teamId).toBe(bea.id);
    const rows = s.phases.find((p) => p.id === "season-regular")!.standings;
    expect(rows.find((r) => r.coach === "Ann")!.teamId).toBe(ann.id);
    expect(rows.find((r) => r.coach === "Bea")!.teamId).toBe(bea.id);
    expect(mismatches).toEqual([]);
    // the honours file names the team only: the shared player name cannot be credited to either team's Gus
    expect(united.every((t) => t.players[0]!.stats.td === 0)).toBe(true);
    expect(s.unattributedStats).toEqual([expect.objectContaining({ team: "United", name: "Gus", reason: '2 teams are called "United" this season' })]);
    expect(ambiguities).toHaveLength(1);
  });

  it("statistics: team records keep the two Uniteds apart", () => {
    const st = leagueStats([built().season], "all");
    const united = st.teams.filter((t) => t.team === "United");
    expect(united).toHaveLength(2);
    expect(united.map((t) => [t.coach, t.wins, t.losses]).sort()).toEqual([["Ann", 1, 0], ["Bea", 0, 1]]);
  });
});

describe("P2-2: duplicate player names never multiply statistics", () => {
  const roster2 = () => team("Hammers", "Ann", "Dwarf", [[1, "Bob", "Lineman", {}], [2, "Bob", "Lineman", {}], [3, "Bob", "Blitzer", {}]]);

  it("two players listed under one name: the total is recorded once on the team, no player gets a copy", () => {
    const t = roster2();
    const td = parseHonours("season-mosttouchdowns-player-honors.csv", csv(["Category;Rank;Name;Position;Level;TeamName;TeamRace;Coach;Value",
      "Season;1;Bob;Lineman;Rookie;Hammers;;;3", "Season;2;Bob;Lineman;Rookie;Hammers;;;2", "Season;3;Bob;Blitzer;Rookie;Hammers;;;1"]))!;
    const out = attachPlayerStats([t], [td]);
    expect(t.players.map((p) => p.stats.td)).toEqual([0, 0, 1]); // the Blitzer is told apart by position
    expect(out).toEqual([expect.objectContaining({ teamId: t.id, name: "Bob", position: "Lineman", stats: expect.objectContaining({ td: 5 }) })]);
    expect(out[0]!.reason).toContain("cannot split");
  });

  it("one honours row but two matching roster players: still unattributed, not copied", () => {
    const t = roster2();
    const td = parseHonours("season-mosttouchdowns-player-honors.csv", csv(["Category;Rank;Name;Position;Level;TeamName;TeamRace;Coach;Value", "Season;1;Bob;Lineman;Rookie;Hammers;;;4"]))!;
    const out = attachPlayerStats([t], [td]);
    expect(t.players.map((p) => p.stats.td)).toEqual([0, 0, 0]);
    expect(out).toHaveLength(1);
    expect(out[0]!.stats.td).toBe(4);
  });

  it("statistics: career leaders count each roster player once and skip unsplit totals", () => {
    const t = roster2();
    t.players[0]!.stats.td = 2;
    t.players[1]!.stats.td = 3;
    const s = season(1, [], [t], { unattributedStats: [{ team: "Hammers", teamId: t.id, name: "Bob", position: "Lineman", stats: { ...EMPTY_PLAYER_STATS, td: 9 }, reason: "x", candidates: [] }] });
    const st = leagueStats([s], "all");
    expect(st.leaders.td.map((l) => l.value).sort()).toEqual([2, 3]);
    expect(st.totals.players).toBe(3);
  });
});

describe("P2-3: partial account mapping does not split a coach", () => {
  it("an account seen without a NAF name and the NAF name seen without the account aggregate as one coach", () => {
    fid = 0;
    const s = season(1, [
      fixture(side("Ann's Orcs", "Ann", "Orc", 2, { coachId: "Ann" }), side("Bob's Elves", "Bob", "Wood Elf", 0)),
      fixture(side("Ann's Orcs", "Ann", "Orc", 1, { nafUser: "ann99" }), side("Cy's Dwarfs", "Cy", "Dwarf", 0)),
    ]);
    const st = leagueStats([s], "all");
    const ann = st.coaches.filter((c) => c.coach === "Ann");
    expect(ann).toHaveLength(1);
    expect(ann[0]).toMatchObject({ games: 2, wins: 2, coachId: "Ann" });
    expect(st.teams.filter((t) => t.team === "Ann's Orcs")).toHaveLength(1);
  });

  it("a display name shared by two NAF identities stays ambiguous; name-only rows do not join either", () => {
    const a = buildCoachAliases([
      { coach: "Sam", nafUser: "sam1" }, { coach: "Sam", nafUser: "sam2" }, { coach: "Sam" },
      { coach: "Ann", coachId: "Ann" }, { coach: "Ann", nafUser: "ann99" }, { coach: "Ann" },
    ]);
    expect(a.key({ nafUser: "sam1" })).not.toBe(a.key({ nafUser: "sam2" }));
    expect(a.key({ coach: "Sam" })).toBe("name:sam");
    expect(a.key({ nafUser: "ANN99" })).toBe(a.key({ coachId: "Ann" }));
    expect(a.key({ coach: " ann " })).toBe(a.key({ coachId: "Ann" }));
  });

  it("import: a standings / award row with only the display name inherits the account id", () => {
    const { season: s } = buildSeason({
      leagueId: "l", number: 1, mapCoach: (_c, naf) => (naf === "ann99" ? "Ann" : undefined),
      files: {
        slug: "x",
        fixtures: csv([FIX_HEAD, "Season;Regular;;1;1;Orcs;Elves;Ann;Bob;Orc;Wood Elf;ann99;;2;0;0;0;;;;2026-06-01T00:00:00Z;2026-06-01T02:00:00Z"]),
        standings: [{ name: "s", text: csv([STAND_HEAD, standRow(1, "Orcs", "Orc", "Ann", 1, 0, 0), standRow(2, "Elves", "Wood Elf", "Bob", 0, 0, 1)]) }],
        awards: csv(["Category;Type;Name;Description;Coach;GoldenStarAward;TeamRace;TeamName", "Season;Overall Champion;;;Ann;;Orc;Orcs"]),
        honours: [], rosters: [],
      },
    });
    expect(s.phases[0]!.standings[0]).toMatchObject({ coach: "Ann", coachId: "Ann" });
    expect(s.awards[0]).toMatchObject({ coachId: "Ann" });
    expect(leagueStats([s], "all").coaches.find((c) => c.coach === "Ann")!.titles).toBe(1);
  });
});

describe("P2-4: a concession decides the outcome", () => {
  it("the shared helper: the conceding side loses whatever the score; touchdowns stay recorded", () => {
    fid = 0;
    const f = fixture(side("A", "Ann", "Orc", 1, { conceded: true }), side("B", "Bob", "Elf", 1));
    expect(fixtureOutcome(f)).toEqual({ home: "loss", away: "win" });
    expect(fixtureOutcome({ ...f, home: { ...f.home, conceded: false } })).toEqual({ home: "draw", away: "draw" });
    expect(fixtureOutcome({ ...f, home: { ...f.home, score: 0, conceded: false }, away: { ...f.away, score: 0 }, suspended: true })).toBeUndefined();
    expect(fixtureOutcome({ ...f, home: { ...f.home, score: 0 }, away: { ...f.away, score: 0 }, suspended: true })).toEqual({ home: "loss", away: "win" });
  });

  it("statistics and the standings check use it", () => {
    fid = 0;
    const f = fixture(side("A", "Ann", "Orc", 1, { conceded: true, teamId: "a" }), side("B", "Bob", "Elf", 1, { teamId: "b" }));
    const st = leagueStats([season(1, [f])], "all");
    expect(st.coaches.find((c) => c.coach === "Bob")).toMatchObject({ wins: 1, draws: 0, points: 3, tdFor: 1, tdAgainst: 1 });
    expect(st.coaches.find((c) => c.coach === "Ann")).toMatchObject({ losses: 1, draws: 0 });
    expect(st.biggestWins).toEqual([]); // a conceded 1-1 is a win without a margin
    const phase = { id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [
      { group: "", rank: 1, team: "B", teamId: "b", race: "Elf", coach: "Bob", points: 3, played: 1, wins: 1, draws: 0, losses: 0, tdFor: 1, tdAgainst: 1, casFor: 0, casAgainst: 0, injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0, sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0 },
      { group: "", rank: 2, team: "A", teamId: "a", race: "Orc", coach: "Ann", points: 0, played: 1, wins: 0, draws: 0, losses: 1, tdFor: 1, tdAgainst: 1, casFor: 0, casAgainst: 0, injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0, sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0 },
    ] };
    expect(checkStandings([phase], [f])).toEqual([]);
  });
});
