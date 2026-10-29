import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importLeague } from "../scripts/import-tourplay-league";
import { assertUniquePlayerIds, linkPlayerCareers, needsPlayerIds } from "../src/leagues/playerIds";
import { leagueStats } from "../src/leagues/stats";
import { LeagueStore } from "../src/leagues/store";
import { buildSeason, type TourplayFiles } from "../src/leagues/tourplay";
import type { LeagueTeam, SeasonRecord } from "../src/leagues/types";

// League player ids: stable across re-imports, unique inside a season with duplicate names, the key of stats /
// honours / shared totals, and linked across seasons by the importer (never by name at query time).

const BOM = String.fromCharCode(0xfeff);
const csv = (lines: string[]): string => BOM + lines.join("\r\n") + "\r\n";
const FIX_HEAD = "Category;Phase;Group;Round;Table;TeamNameHome;TeamNameAway;CoachHome;CoachAway;TeamRaceHome;TeamRaceAway;NafUserHome;NafUserAway;ScoreHome;ScoreAway;CasualtiesHome;CasualtiesAway;Suspended;ConcedeHome;ConcedeAway;UtcStart;UtcFinish";
const ROSTER_HEAD = "TeamName;TeamRace;Coach;CurrentTeamValue;Treasury;ReRolls;Fans;AssistantCoaches;CheerLeaders;Apothecary;Tier;Pack;NafUser;League;RuleSet";
const PLAYER_HEAD = "Number;Name;Position;MA;ST;AG;PA;AV;Skills;Value;Level;AvailableSpp;NigglingInjuries;MissNextGame";
const roster = (team: string, race: string, coach: string, players: string[]): string =>
  csv([ROSTER_HEAD, `${team};${race};${coach};1000000;0;2;1;0;0;False;1;;;;BB2025`, " ", PLAYER_HEAD, ...players, " ", "Inducement;Quantity;Value"]);
const player = (n: number | "", name: string, position = "Lineman"): string => `${n};${name};${position};6;3;3;4;9;;50000;Rookie;0;;`;
const honour = (stat: string, rows: string[]) => ({ name: `season-${stat}-player-honors.csv`, text: csv(["Category;Rank;Name;Position;Level;TeamName;TeamRace;Coach;Value", ...rows]) });
const none = (): undefined => undefined;

/** Hammers (Ann): two "Bob" Linemen (#1, #2), a Blitzer Bob, Una; Ghosts (Bea): two "Gus" Linemen with no shirt number, Vi. */
function files(slug: string, over: { bobs?: Array<number | "">; honours?: ReturnType<typeof honour>[] } = {}): TourplayFiles {
  const bobs = over.bobs ?? [1, 2];
  return {
    slug,
    fixtures: csv([FIX_HEAD, "Season;Regular;;1;1;Hammers;Ghosts;Ann;Bea;Dwarf;Undead;;;2;1;0;0;;;;2026-06-01T00:00:00Z;2026-06-01T02:00:00Z"]),
    standings: [],
    honours: over.honours ?? [honour("mosttouchdowns", [
      "Season;1;Bob;Lineman;Rookie;Hammers;;;3", "Season;2;Gus;Lineman;Rookie;Ghosts;;;2", "Season;3;Bob;Blitzer;Rookie;Hammers;;;1", "Season;4;Gone Guy;Lineman;Rookie;Hammers;;;4",
    ])],
    rosters: [
      { name: "hammers-roster.csv", text: roster("Hammers", "Dwarf", "Ann", [...bobs.map((n) => player(n, "Bob")), player(3, "Bob", "Blitzer"), player(4, "Una")]) },
      { name: "ghosts-roster.csv", text: roster("Ghosts", "Undead", "Bea", [player("", "Gus"), player("", "Gus"), player(9, "Vi")]) },
    ],
  };
}
const build = (slug: string, number: number, f = files(slug)): SeasonRecord => buildSeason({ leagueId: "tabbl", number, files: f, mapCoach: none }).season;
const allPlayers = (s: SeasonRecord) => s.teams.flatMap((t) => [...t.players, ...t.formerPlayers]);
const team = (s: SeasonRecord, name: string): LeagueTeam => s.teams.find((t) => t.name === name)!;

describe("league player ids", () => {
  it("every roster and former player gets an opaque id; two imports of the same export give the same ids", () => {
    const a = build("tabbl---season-6", 6);
    const b = build("tabbl---season-6", 6);
    expect(allPlayers(a)).toHaveLength(8); // 4 + 3 rostered, 1 former (Gone Guy)
    for (const p of allPlayers(a)) expect(p.playerId).toMatch(/^p-[0-9a-f]{12}$/);
    expect(allPlayers(b).map((p) => p.playerId)).toEqual(allPlayers(a).map((p) => p.playerId));
    // a different season slug is a different player record
    expect(allPlayers(build("tabbl---season-7", 7)).map((p) => p.playerId)).not.toEqual(allPlayers(a).map((p) => p.playerId));
    // the id does not move when the honours (stat lines) change
    const c = build("tabbl---season-6", 6, files("tabbl---season-6", { honours: [] }));
    expect(team(c, "Hammers").players.map((p) => p.playerId)).toEqual(team(a, "Hammers").players.map((p) => p.playerId));
  });

  it("duplicate names stay apart: unique ids even for the same name, position and a missing shirt number", () => {
    const s = build("tabbl---season-6", 6);
    const ids = allPlayers(s).map((p) => p.playerId);
    expect(new Set(ids).size).toBe(ids.length);
    const bobs = team(s, "Hammers").players.filter((p) => p.name === "Bob" && p.position === "Lineman");
    expect(bobs).toHaveLength(2);
    expect(bobs[0]!.playerId).not.toBe(bobs[1]!.playerId);
    const gus = team(s, "Ghosts").players.filter((p) => p.name === "Gus");
    expect(gus).toHaveLength(2);
    expect(gus[0]!.playerId).not.toBe(gus[1]!.playerId);
    // and stable: the second Gus is the second Gus on the next import
    expect(team(build("tabbl---season-6", 6), "Ghosts").players.filter((p) => p.name === "Gus").map((p) => p.playerId)).toEqual(gus.map((p) => p.playerId));
    expect(() => assertUniquePlayerIds([s])).not.toThrow();
    const dup = build("tabbl---season-6", 6);
    team(dup, "Ghosts").players[1]!.playerId = team(dup, "Ghosts").players[0]!.playerId;
    expect(() => assertUniquePlayerIds([dup])).toThrow(/is held by both/);
  });

  it("honours: one match carries the player's id on the board row; the former player has an id too", () => {
    const s = build("tabbl---season-6", 6);
    const board = s.honours.find((h) => h.stat === "mosttouchdowns")!;
    const blitzer = team(s, "Hammers").players.find((p) => p.position === "Blitzer")!;
    const gone = team(s, "Hammers").formerPlayers.find((p) => p.name === "Gone Guy")!;
    expect(blitzer.stats.td).toBe(1);
    expect(board.rows.find((r) => r.name === "Gone Guy")!.playerId).toBe(gone.playerId);
    expect(board.rows.find((r) => r.position === "Blitzer")!.playerId).toBe(blitzer.playerId);
    // the shared names carry no single id
    expect(board.rows.filter((r) => r.name === "Bob" && r.position === "Lineman").every((r) => r.playerId === undefined)).toBe(true);
  });

  it("shared totals: recorded once, against the candidate player ids", () => {
    const s = build("tabbl---season-6", 6);
    expect(s.unattributedStats).toHaveLength(2);
    const bobTotal = s.unattributedStats.find((u) => u.name === "Bob")!;
    const bobs = team(s, "Hammers").players.filter((p) => p.name === "Bob" && p.position === "Lineman");
    expect(bobTotal).toMatchObject({ teamId: team(s, "Hammers").id, position: "Lineman", stats: expect.objectContaining({ td: 3 }) });
    expect(bobTotal.candidates).toEqual(bobs.map((p) => p.playerId));
    expect(bobs.map((p) => p.stats.td)).toEqual([0, 0]); // never copied onto the candidates
    const gusTotal = s.unattributedStats.find((u) => u.name === "Gus")!;
    expect(gusTotal.candidates).toEqual(team(s, "Ghosts").players.filter((p) => p.name === "Gus").map((p) => p.playerId));
    expect(gusTotal.candidates).toHaveLength(2);
    // a total with no roster behind it has no candidates
    const lost = buildSeason({ leagueId: "tabbl", number: 6, mapCoach: none, files: { ...files("x"), honours: [honour("mosttouchdowns", ["Season;1;Zed;Lineman;Rookie;Nobody FC;;;2"])] } }).season;
    expect(lost.unattributedStats).toEqual([expect.objectContaining({ name: "Zed", reason: "no roster for this team", candidates: [] })]);
  });
});

describe("career links and keyed statistics", () => {
  const twoSeasons = (): [SeasonRecord, SeasonRecord] => {
    const s1 = build("tabbl---season-1", 1, files("tabbl---season-1", { honours: [honour("mosttouchdowns", ["Season;1;Una;Lineman;Rookie;Hammers;;;2", "Season;2;Gone Guy;Lineman;Rookie;Hammers;;;1"])] }));
    // season 2: Una keeps #4; the second Bob changed shirt number 2 -> 5
    const s2 = build("tabbl---season-2", 2, files("tabbl---season-2", { bobs: [1, 5], honours: [honour("mosttouchdowns", ["Season;1;Una;Lineman;Rookie;Hammers;;;3"])] }));
    return [s1, s2];
  };

  it("the same player across seasons shares a careerKey; previousIds lists the earlier ids", () => {
    const [s1, s2] = twoSeasons();
    linkPlayerCareers([s2, s1]); // order does not matter
    const una1 = team(s1, "Hammers").players.find((p) => p.name === "Una")!;
    const una2 = team(s2, "Hammers").players.find((p) => p.name === "Una")!;
    expect(una2.careerKey).toBe(una1.careerKey);
    expect(una2.previousIds).toEqual([una1.playerId]);
    expect(una1.previousIds).toBeUndefined();
    expect(una2.playerId).not.toBe(una1.playerId);
    // shirt number 1 continues; the Bob who moved from #2 to #5 is a new record
    const bob = (s: SeasonRecord, n: number) => team(s, "Hammers").players.find((p) => p.name === "Bob" && p.position === "Lineman" && p.number === n)!;
    expect(bob(s2, 1).careerKey).toBe(bob(s1, 1).careerKey);
    expect(bob(s2, 5).careerKey).not.toBe(bob(s1, 2).careerKey);
    // every player (former too) has a career key
    expect(allPlayers(s1).every((p) => p.careerKey)).toBe(true);
    // idempotent
    const before = JSON.stringify([s1, s2]);
    linkPlayerCareers([s1, s2]);
    expect(JSON.stringify([s1, s2])).toBe(before);
    expect(needsPlayerIds([s1, s2])).toBe(false);
  });

  it("leaders are keyed by career: ids, not names, decide who is who; each player counted once", () => {
    const list = twoSeasons();
    linkPlayerCareers(list);
    const st = leagueStats(list, "all");
    const una = st.leaders.td.find((l) => l.name === "Una")!;
    expect(una).toMatchObject({ value: 5, seasons: [1, 2], seasonId: "season-2" });
    expect(una.playerId).toBe(team(list[1], "Hammers").players.find((p) => p.name === "Una")!.playerId);
    expect(st.leaders.td.map((l) => l.playerId).filter((id, i, a) => a.indexOf(id) !== i)).toEqual([]);
    // shared totals are not credited to anyone
    expect(st.leaders.td.some((l) => l.name === "Bob")).toBe(false);
    expect(st.totals.players).toBe(new Set(list.flatMap((s) => allPlayers(s).map((p) => p.careerKey))).size);
  });

  it("two players with one name on one team never merge, whatever their stats", () => {
    const [s1] = twoSeasons();
    const bobs = team(s1, "Hammers").players.filter((p) => p.name === "Bob" && p.position === "Lineman");
    bobs[0]!.stats.td = 2;
    bobs[1]!.stats.td = 6;
    linkPlayerCareers([s1]);
    const st = leagueStats([s1], "all");
    const found = st.leaders.td.filter((l) => l.name === "Bob");
    expect(found.map((l) => l.value).sort()).toEqual([2, 6]);
    expect(found.map((l) => l.playerId).sort()).toEqual(bobs.map((p) => p.playerId).sort());
  });

  it("a season stored before ids existed is given them (and career links) when read from the store", () => {
    const dir = mkdtempSync(join(tmpdir(), "league-ids-"));
    try {
      const store = new LeagueStore(dir);
      store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl" });
      const [s1, s2] = twoSeasons();
      linkPlayerCareers([s1, s2]);
      const legacy = (s: SeasonRecord): SeasonRecord => {
        const copy = JSON.parse(JSON.stringify(s)) as SeasonRecord;
        for (const t of copy.teams) for (const p of [...t.players, ...t.formerPlayers]) { delete (p as Partial<typeof p>).playerId; delete p.careerKey; delete p.previousIds; }
        return copy;
      };
      store.putSeason(legacy(s1));
      store.putSeason(legacy(s2));
      const read = store.season("tabbl", "season-2")!;
      const una = team(read, "Hammers").players.find((p) => p.name === "Una")!;
      expect(una.playerId).toMatch(/^p-/);
      expect(una.previousIds).toHaveLength(1);
      expect(una.playerId).toBe(team(s2, "Hammers").players.find((p) => p.name === "Una")!.playerId); // the id the importer gives
      expect(store.seasons("tabbl").every((s) => !needsPlayerIds([s]))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("importer: ids over a full run", () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

  function writeExport(root: string, slug: string): void {
    const f = files(slug);
    const dir = join(root, `${slug}-data`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug}-fixtures.csv`), f.fixtures!);
    for (const h of f.honours) writeFileSync(join(dir, `${slug}-${h.name}`), h.text);
    for (const r of f.rosters) writeFileSync(join(dir, r.name), r.text);
  }

  it("re-importing the same exports keeps every playerId; the report counts ids and cross-season links", async () => {
    const root = mkdtempSync(join(tmpdir(), "league-ids-exp-"));
    const stateDir = mkdtempSync(join(tmpdir(), "league-ids-state-"));
    dirs.push(root, stateDir);
    writeExport(root, "tabbl---season-1");
    writeExport(root, "tabbl---season-2");
    const lines: string[] = [];
    const opts = { league: "tabbl", name: "TABBL", fullName: "TABBL", exports: root, stateDir, identities: undefined, log: (l: string) => lines.push(l) };
    const first = await importLeague(opts);
    const store = new LeagueStore(stateDir);
    const idsOf = (): Record<string, string[]> => Object.fromEntries(store.seasons("tabbl").map((s) => [s.id, allPlayers(s).map((p) => p.playerId)]));
    const before = idsOf();
    expect(first.map((r) => r.playerIds)).toEqual([8, 8]);
    expect(first.map((r) => r.linkedToEarlierSeasons)).toEqual([0, 8]); // every player (the former Gone Guy too) continues from season 1
    expect(first[0]!.ambiguities).toHaveLength(2);
    expect(lines.join("\n")).toContain("shared honour totals");
    await importLeague({ ...opts, log: () => undefined });
    expect(idsOf()).toEqual(before);
    const s2 = store.season("tabbl", "season-2")!;
    expect(s2.unattributedStats.every((u) => u.candidates.every((id) => allPlayers(s2).some((p) => p.playerId === id)))).toBe(true);
    const ids = store.seasons("tabbl").flatMap((s) => allPlayers(s).map((p) => p.playerId));
    expect(new Set(ids).size).toBe(ids.length); // unique across the whole league
  });
});
