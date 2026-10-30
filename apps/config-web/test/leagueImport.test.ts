import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLeague, nafMapFromIdentities, seasonNumberFromSlug } from "../scripts/import-tourplay-league";
import { LeagueStore } from "../src/leagues/store";
import { applyTeamCoach } from "../src/leagues/teamCoach";
import {
  attachPlayerStats, buildSeason, checkStandings, csvRecords, fixturePlayed, parseCsv, parseFixtures, parseHonours,
  parseHonourValue, parseRoster, parseSkills, readTourplayDir,
} from "../src/leagues/tourplay";

// TourPlay organiser exports -> season records (src/leagues/tourplay.ts), the league store and the importer script.

const BOM = "﻿";
const crlf = (lines: string[]): string => BOM + lines.join("\r\n") + "\r\n";
const none = (): undefined => undefined;

const FIX_HEAD = "Category;Phase;Group;Round;Table;TeamNameHome;TeamNameAway;CoachHome;CoachAway;TeamRaceHome;TeamRaceAway;NafUserHome;NafUserAway;ScoreHome;ScoreAway;CasualtiesHome;CasualtiesAway;Suspended;ConcedeHome;ConcedeAway;UtcStart;UtcFinish";
const STAND_HEAD = "Category;Phase;Group;Rank;TeamName;TeamRace;Coach;Points;CustomPoints;BuchholzScore;SonnebornBergerScore;CumulativeScore;Played;Wins;Draws;Losses;TdFor;TdAgainst;CasualtiesFor;CasualtiesAgainst;InjuriesFor;InjuriesAgainst;Completions;Interceptions;DeathsFor;DeathsAgainst;FoulsFor;FoulsAgainst;SentOffsFor;SentOffsAgainst;SecretObjectives";

const fixturesCsv = crlf([
  FIX_HEAD,
  "Season;PreSeason;;1;1;Grudge Rollers;Rot Girl Summer;flutethecat (Jay);Jeff / @Chap;Dwarf;Nurgle;flutethecat;chap;1;1;2;3;;;;2026-05-29T00:25:04Z;2026-05-29T03:00:58Z",
  "Season;Regular;North;1;1;Grudge Rollers;\"Orcs; the \"\"Best\"\"\";flutethecat (Jay);RockyBoy;Dwarf;Orc;flutethecat;;3;0;1;0;;;;2026-06-01T00:00:00Z;2026-06-01T02:00:00Z",
  "Season;Regular;North;2;1;Rot Girl Summer;Grudge Rollers;Jeff / @Chap;flutethecat (Jay);Nurgle;Dwarf;chap;flutethecat;0;2;0;0;True;True;;2026-06-08T00:00:00Z;2026-06-08T00:00:00Z",
  "Season;Regular;North;3;1;\"Orcs; the \"\"Best\"\"\";Rot Girl Summer;RockyBoy;Jeff / @Chap;Orc;Nurgle;;chap;0;0;0;0;True;;;2026-06-15T00:00:00Z;2026-06-15T00:00:00Z",
  "Season;Interdivision;;4;1;Rot Girl Summer;\"Orcs; the \"\"Best\"\"\";Jeff / @Chap;RockyBoy;Nurgle;Orc;chap;;2;1;0;1;;;;2026-06-22T00:00:00Z;2026-06-22T02:00:00Z",
  "Season;Regular;North;5;1;Grudge Rollers;Rot Girl Summer;flutethecat (Jay);Jeff / @Chap;Dwarf;Nurgle;flutethecat;chap;;;;;;;;;",
]);

const standingsCsv = crlf([
  STAND_HEAD,
  "Season;Regular;North;1;Grudge Rollers;Dwarf;flutethecat (Jay);6;0;0;0;0;2;2;0;0;5;0;1;0;0;0;0;0;0;0;0;0;0;0;0",
  "Season;Regular;North;2;Rot Girl Summer;Nurgle;Jeff / @Chap;3;0;0;0;0;2;1;0;1;2;3;0;1;0;0;0;0;0;0;0;0;0;0;0",
  "Season;Regular;North;3;\"Orcs; the \"\"Best\"\"\";Orc;RockyBoy;0;0;0;0;0;2;0;0;2;1;5;1;1;0;0;0;0;0;0;0;0;0;0;0",
]);

const rosterCsv = crlf([
  "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet",
  "Grudge Rollers;Dwarf;flutethecat (Jay);885000;130000;1;3;0;0;False;2;;flutethecat;WorldsEdgeSuperleague;BB2025",
  " ",
  "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame",
  "4;Dethirord Slenderstrength;Troll Slayer;5;3;4;5;9;Block,Dauntless,Frenzy,Hatred (102),Thick Skull;95000;Rookie;6;;",
  "16;Zhethrah  Stonerage;Deathroller;5;7;5;;11;Break Tackle,Loner (4+),Secret Weapon;170000;Rookie;10;1;True",
  " ",
  "Inducement;Quantity;Value",
]);

const honourCsv = (rows: string[]): string => crlf(["Category;Rank;Name;Position;Level;TeamName;TeamRace;Coach;Value", ...rows]);

describe("TourPlay CSV parsing", () => {
  it("strips the BOM, splits CRLF rows, honours quoted semicolons and doubled quotes", () => {
    const rows = parseCsv(fixturesCsv);
    expect(rows[0]![0]).toBe("Category");
    expect(rows[2]![6]).toBe('Orcs; the "Best"');
    expect(rows[2]).toHaveLength(22);
    expect(parseCsv('a;"x\r\ny";b\n1;2;3')).toEqual([["a", "x\r\ny", "b"], ["1", "2", "3"]]);
    expect(csvRecords(crlf(["A;B", "", "1;2", " "]))).toEqual([{ A: "1", B: "2" }]);
  });

  it("brace-record honour values, numbers and plain text", () => {
    expect(parseHonourValue("{ WinDrawRatio = 0.955, Wins = 10, Draws = 1, Defeats = 0, Points = 22, Buchholz = 44 }"))
      .toEqual({ WinDrawRatio: 0.955, Wins: 10, Draws: 1, Defeats: 0, Points: 22, Buchholz: 44 });
    expect(parseHonourValue("46")).toBe(46);
    expect(parseHonourValue("4.5")).toBe(4.5);
    expect(parseHonourValue("Elf")).toBe("Elf");
    expect(parseHonourValue("{ Race = Dwarf }")).toEqual({ Race: "Dwarf" });
  });

  it("skills keep bracketed parameters", () => {
    expect(parseSkills("Block,Hatred (102),Loner (4+), Thick Skull")).toEqual(["Block", "Hatred (102)", "Loner (4+)", "Thick Skull"]);
    expect(parseSkills("")).toEqual([]);
    expect(parseSkills("Eye Gunge,Block")).toEqual(["Eye Gouge", "Block"]);
  });

  it("fixtures: blank groups, suspended / concede flags, missing NAF names, unplayed rows", () => {
    const f = parseFixtures(fixturesCsv, (_c, naf) => (naf === "flutethecat" ? "Jay" : undefined));
    expect(f).toHaveLength(6);
    expect(f[0]).toMatchObject({ id: "f1", category: "Season", phase: "PreSeason", phaseId: "season-preseason", group: "", round: 1 });
    expect(f[0]!.home).toMatchObject({ team: "Grudge Rollers", coach: "flutethecat (Jay)", coachId: "Jay", nafUser: "flutethecat", score: 1, cas: 2 });
    expect(f[0]!.away.coachId).toBeUndefined();
    expect(f[1]!.away.nafUser).toBeUndefined();
    expect(f[2]).toMatchObject({ suspended: true });
    expect(f[2]!.home.conceded).toBe(true);
    expect(f[0]!.startedAt).toBe("2026-05-29T00:25:04.000Z");
    expect(fixturePlayed(f[2]!)).toBe(true); // suspended but a conceded result
    expect(fixturePlayed(f[3]!)).toBe(false); // suspended 0-0: not played
    expect(fixturePlayed(f[5]!)).toBe(false); // no score yet
    expect(f[5]!.home.score).toBeNull();
  });

  it("roster: header block, players with skills and stats slots, inducement block ignored", () => {
    const team = parseRoster(rosterCsv, none)!;
    expect(team).toMatchObject({ name: "Grudge Rollers", race: "Dwarf", teamValue: 885000, treasury: 130000, rerolls: 1, apothecary: false, raceLeague: "WorldsEdgeSuperleague", nafUser: "flutethecat" });
    expect(team.players.map((p) => p.number)).toEqual([4, 16]);
    expect(team.players[0]!.skills).toContain("Hatred (102)");
    expect(team.players[1]).toMatchObject({ pa: null, niggling: 1, missNextGame: true });
  });

  it("player honours fold into season stats (whitespace-insensitive names); unknown players become former players", () => {
    const team = parseRoster(rosterCsv, none)!;
    const td = parseHonours("season-mosttouchdowns-player-honors.csv", honourCsv([
      "Season;1;Zhethrah Stonerage;Deathroller;Rookie;Grudge Rollers;;;3",
      "Season;2;Gone Guy;Dwarf Lineman;Rookie;Grudge Rollers;;;1",
    ]))!;
    const spp = parseHonours("season-mostexperienced-player-honors.csv", honourCsv(["Season;1;Zhethrah Stonerage;Deathroller;Rookie;Grudge Rollers;;;9"]))!;
    const cup = parseHonours("cup-mosttouchdowns-player-honors.csv", honourCsv(["Cup;1;Zhethrah Stonerage;Deathroller;Rookie;Grudge Rollers;;;1"]))!;
    expect(td).toMatchObject({ key: "season-mosttouchdowns", category: "season", stat: "mosttouchdowns", kind: "player" });
    attachPlayerStats([team], [td, spp, cup]);
    expect(team.players[1]!.stats).toMatchObject({ td: 4, spp: 9, cas: 0 });
    expect(team.formerPlayers).toEqual([{ playerId: expect.stringMatching(/^p-[0-9a-f]{12}$/), name: "Gone Guy", position: "Dwarf Lineman", level: "Rookie", stats: expect.objectContaining({ td: 1 }) }]);
    const coach = parseHonours("season-bestrace-coach-honors.csv", crlf(["Category;Rank;Coach;NafUser;TeamRace;TeamName;Value", "Season;1;Kainis;Kainis;;Caledor;{ Wins = 4, Draws = 0 }"]))!;
    expect(coach.rows[0]).toMatchObject({ name: "Kainis", team: "Caledor", value: { Wins: 4, Draws: 0 } });
  });

  it("standings check: folds Interdivision into Regular when that is what the table counts, reports what is left", () => {
    const built = buildSeason({
      leagueId: "tabbl", number: 6, ruleset: "BB2025",
      files: { slug: "x", fixtures: fixturesCsv, standings: [{ name: "x-season-regular-standings.csv", text: standingsCsv }], honours: [], rosters: [] },
      mapCoach: none,
    });
    const regular = built.season.phases.find((p) => p.id === "season-regular")!;
    expect(regular.groups).toEqual(["North"]);
    expect(regular.includes).toEqual(["season-interdivision"]);
    expect(built.mismatches).toEqual([]);
    expect(built.season.phases.map((p) => p.id)).toEqual(["season-preseason", "season-regular", "season-interdivision"]);
    // a broken table is reported, never thrown
    regular.standings[0]!.wins = 5;
    expect(checkStandings(built.season.phases, built.season.fixtures)[0]).toContain("Grudge Rollers exported 5-0-0, fixtures 2-0-0");
  });

  it("coach mapping by NAF name carries to display-name rows; unmapped coaches are listed", () => {
    const built = buildSeason({
      leagueId: "tabbl", number: 1,
      files: { slug: "x", fixtures: fixturesCsv, standings: [{ name: "s", text: standingsCsv }], honours: [], rosters: [] },
      mapCoach: (_c, naf) => (naf === "flutethecat" ? "Jay" : undefined),
    });
    expect(built.season.phases.find((p) => p.id === "season-regular")!.standings[0]).toMatchObject({ coach: "flutethecat (Jay)", coachId: "Jay" });
    expect(built.unmappedCoaches).toEqual(["Jeff / @Chap", "RockyBoy"]);
    expect(built.season.ruleset).toBe("BB2020");
    expect(built.season.status).toBe("active");
  });
});

// ---- store + importer ----

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "league-")); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function writeExport(root: string, slug: string, opts: { champion?: boolean } = {}): void {
  const dir = join(root, `${slug}-data`);
  mkdirSync(join(dir, "rot girl summer-nurgle-jeff "), { recursive: true });
  writeFileSync(join(dir, `${slug}-fixtures.csv`), fixturesCsv);
  writeFileSync(join(dir, `${slug}-season-regular-standings.csv`), standingsCsv);
  writeFileSync(join(dir, `${slug}-participants.csv`), crlf([
    "Category;Coach;Country;TeamRace;TeamName;UtcDatetime;Active;Payment;CheckedValid;NafNumber;NafUser;GamingGroup;SquadName;RuleSet;Observations",
    "Season;flutethecat (Jay);US;Dwarf;Grudge Rollers;2026-05-17T23:23:34Z;False;True;True;34116;flutethecat;TABBL;;BB2025;private note",
  ]));
  writeFileSync(join(dir, `${slug}-awards.csv`), crlf([
    "Category;Type;Name;Description;Coach;GoldenStarAward;TeamRace;TeamName",
    ...(opts.champion ? ["Season;Overall Champion;;;flutethecat (Jay);True;Dwarf;Grudge Rollers"] : []),
  ]));
  writeFileSync(join(dir, `${slug}-season-mosttouchdowns-player-honors.csv`), honourCsv(["Season;1;Dethirord Slenderstrength;Troll Slayer;Rookie;Grudge Rollers;;;2"]));
  writeFileSync(join(dir, "grudge rollers-dwarf-flutethecat (ja-roster.csv"), rosterCsv);
  writeFileSync(join(dir, "rot girl summer-nurgle-jeff ", " @chap-roster.csv"), rosterCsv.replace("Grudge Rollers;Dwarf;flutethecat (Jay)", "Rot Girl Summer;Nurgle;Jeff / @Chap").replace(";flutethecat;Worlds", ";chap;Worlds"));
}

describe("league store and importer", () => {
  it("reads an export folder (rosters found in sub-folders) and drops private participant columns", () => {
    const root = tmp();
    writeExport(root, "tabbl---season-6");
    const files = readTourplayDir(join(root, "tabbl---season-6-data"));
    expect(files.slug).toBe("tabbl---season-6");
    expect(files.rosters).toHaveLength(2);
    expect(files.honours.map((h) => h.name)).toEqual(["season-mosttouchdowns-player-honors.csv"]);
    const built = buildSeason({ leagueId: "l", number: 6, files, mapCoach: none });
    expect(JSON.stringify(built.season.participants)).not.toMatch(/private note|34116|Payment/);
    expect(built.season.ruleset).toBe("BB2025");
  });

  it("store round-trip: league upsert keeps createdAt, seasons replace by source slug, bad ids refused", () => {
    const store = new LeagueStore(tmp());
    const a = store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma", slug: "tabbl" }, new Date("2026-10-01T00:00:00Z"));
    const b = store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area", slug: "tabbl", organisers: ["Jay"] }, new Date("2026-10-02T00:00:00Z"));
    expect(b.createdAt).toBe(a.createdAt);
    expect(store.league("tabbl")).toMatchObject({ fullName: "Tahoma Area", organisers: ["Jay"], description: "" });
    const built = buildSeason({ leagueId: "tabbl", number: 3, files: { slug: "s3", fixtures: fixturesCsv, standings: [], honours: [], rosters: [] }, mapCoach: none });
    expect(store.putSeason(built.season)).toEqual({});
    expect(store.season("tabbl", "season-3")!.fixtures).toHaveLength(6);
    // same slug, new number: the old file goes
    expect(store.putSeason({ ...built.season, id: "season-4", number: 4 })).toEqual({ replaced: "season-3" });
    expect(store.seasons("tabbl").map((s) => s.id)).toEqual(["season-4"]);
    expect(store.season("tabbl", "../x")).toBeUndefined();
    expect(() => store.upsertLeague({ id: "Bad Id", name: "x", fullName: "x", slug: "x" })).toThrow();
    expect(() => store.setArt("tabbl", "logo", "../../etc/passwd")).toThrow();
  });

  it("importer: seasons numbered from slugs, BB2025 from season 5, newest uncrowned season active, idempotent", async () => {
    const root = tmp();
    writeExport(root, "tahoma-area-blood-bowl-league---season-1", { champion: true });
    writeExport(root, "tabbl---season-4");
    writeExport(root, "tabbl---season-5---bb2025", { champion: true });
    writeExport(root, "tabbl---season-6");
    const identities = join(root, "identities.json");
    writeFileSync(identities, JSON.stringify({ version: 1, coaches: { jay: { ffbCoachId: "Jay", identities: { nafName: "FluteTheCat" } } } }));
    expect([...nafMapFromIdentities(identities)]).toEqual([["flutethecat", "Jay"]]);
    expect(seasonNumberFromSlug("tabbl---season-5---bb2025")).toBe(5);
    const stateDir = tmp();
    const lines: string[] = [];
    const opts = { league: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", exports: root, identities, stateDir, log: (l: string) => lines.push(l) };
    const first = await importLeague(opts);
    expect(first.map((r) => [r.number, r.ruleset, r.status])).toEqual([[1, "BB2020", "completed"], [4, "BB2020", "completed"], [5, "BB2025", "completed"], [6, "BB2025", "active"]]);
    expect(first[0]).toMatchObject({ teams: 2, players: 4, fixtures: 6, played: 4, mismatches: [], unmappedCoaches: ["Jeff / @Chap", "RockyBoy"] });
    expect(lines.join("\n")).toContain("Season 6 (tabbl---season-6) BB2025 active");
    const store = new LeagueStore(stateDir);
    expect(store.season("tabbl", "season-6")!.fixtures[0]!.home.coachId).toBe("Jay");
    expect(store.season("tabbl", "season-6")!.teams[0]!.players[0]!.stats.td).toBe(2);
    const second = await importLeague({ ...opts, log: () => undefined });
    expect(second.every((r) => r.replaced === `season-${r.number}`)).toBe(true);
    expect(readdirSync(join(stateDir, "leagues", "tabbl", "seasons")).sort()).toEqual(["season-1.json", "season-4.json", "season-5.json", "season-6.json"]);
    expect(store.league("tabbl")!.createdAt).toBeTruthy();
  });

  it("[review P2] a re-import keeps the organiser's coach assignments and clears (team, participant, unplayed fixtures, log)", async () => {
    const root = tmp();
    writeExport(root, "tabbl---season-5---bb2025", { champion: true });
    writeExport(root, "tabbl---season-6");
    const identities = join(root, "identities.json");
    writeFileSync(identities, JSON.stringify({ version: 1, coaches: { jay: { ffbCoachId: "Jay", identities: { nafName: "FluteTheCat" } } } }));
    const stateDir = tmp();
    const opts = { league: "tabbl", name: "TABBL", fullName: "TABBL", exports: root, identities, stateDir, log: () => undefined };
    await importLeague(opts);
    const store = new LeagueStore(stateDir);
    const s6 = store.season("tabbl", "season-6")!;
    const gr = s6.teams.find((t) => t.name === "Grudge Rollers")!;
    expect(gr.coachId).toBe("Jay"); // imported through the NAF name
    applyTeamCoach(s6, gr.id, "ForkTester", "Organiser", "2026-10-30T18:00:00.000Z");
    store.putSeason(s6);
    const s5 = store.season("tabbl", "season-5")!;
    applyTeamCoach(s5, gr.id, null, "Organiser", "2026-10-30T18:05:00.000Z");
    store.putSeason(s5);
    const again = await importLeague(opts);
    expect(again.find((r) => r.number === 6)).toMatchObject({ replaced: "season-6", coachAssignmentsKept: [gr.id] });
    const n6 = store.season("tabbl", "season-6")!;
    expect(n6.teams.find((t) => t.id === gr.id)).toMatchObject({ coachId: "ForkTester", coachAssigned: { by: "Organiser", at: "2026-10-30T18:00:00.000Z" } });
    expect(n6.participants.find((p) => p.team === "Grudge Rollers")).toMatchObject({ coachId: "ForkTester", coachAssigned: true });
    const unplayed = n6.fixtures.filter((f) => !fixturePlayed(f) && (f.home.teamId === gr.id || f.away.teamId === gr.id));
    expect(unplayed.length).toBeGreaterThan(0);
    for (const f of unplayed) expect([f.home, f.away].find((x) => x.teamId === gr.id)).toMatchObject({ coachId: "ForkTester", coachAssigned: true });
    const played = n6.fixtures.filter((f) => fixturePlayed(f) && f.home.teamId === gr.id);
    expect(played.length).toBeGreaterThan(0);
    for (const f of played) expect(f.home.coachId).toBe("Jay"); // history as exported
    expect(n6.log?.filter((e) => e.kind === "team-coach").map((e) => e.text)).toEqual(["Organiser assigned the coach account ForkTester to Grudge Rollers (was Jay)."]);
    // the clear on season 5 survives too: the imported account does not come back
    const n5 = store.season("tabbl", "season-5")!;
    expect(n5.teams.find((t) => t.id === gr.id)).toMatchObject({ coachAssigned: { by: "Organiser", cleared: true } });
    expect(n5.teams.find((t) => t.id === gr.id)).not.toHaveProperty("coachId");
    for (const f of n5.fixtures.filter((x) => !fixturePlayed(x))) for (const x of [f.home, f.away]) if (x.teamId === gr.id) expect(x).not.toHaveProperty("coachId");
    // a third import changes nothing more (the audit entry is not duplicated)
    await importLeague(opts);
    expect(store.season("tabbl", "season-6")!.log?.filter((e) => e.kind === "team-coach")).toHaveLength(1);
  });
});
