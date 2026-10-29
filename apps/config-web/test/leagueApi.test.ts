import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artUrl, checkLeagueArt, isPublicLeagueRead, leagueApi, leaguePath, type LeagueApiDeps } from "../src/leagues/api";
import { leagueStats } from "../src/leagues/stats";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import { resetAvatarRateLimit } from "../src/teamAvatars";

// League statistics (src/leagues/stats.ts) and the league routes (src/leagues/api.ts).

let n = 0;
const fx = (home: [string, string, string, number | null, number?], away: [string, string, string, number | null, number?], over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: `f${++n}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: n, table: 1,
  home: { team: home[0], coach: home[1], race: home[2], score: home[3], cas: home[4] ?? 0, conceded: false },
  away: { team: away[0], coach: away[1], race: away[2], score: away[3], cas: away[4] ?? 0, conceded: false },
  suspended: false, finishedAt: `2026-0${(n % 9) + 1}-01T00:00:00.000Z`, ...over,
});

const team = (name: string, coach: string, race: string, players: Array<[string, Partial<typeof EMPTY_PLAYER_STATS>]>, former: Array<[string, Partial<typeof EMPTY_PLAYER_STATS>]> = []): LeagueTeam => ({
  name, race, coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 2, assistantCoaches: 0, cheerleaders: 0, apothecary: true, tier: "1", raceLeague: "",
  players: players.map(([pname, stats], i) => ({ number: i + 1, name: pname, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS, ...stats } })),
  formerPlayers: former.map(([pname, stats]) => ({ name: pname, position: "Blitzer", level: "Rookie", stats: { ...EMPTY_PLAYER_STATS, ...stats } })),
});

const season = (number: number, ruleset: "BB2020" | "BB2025", fixtures: LeagueFixture[], teams: LeagueTeam[], champion?: [string, string, string]): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset, status: champion ? "completed" : "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, participants: [], teams, honours: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
  awards: champion ? [{ category: "Season", type: "Overall Champion", name: "", description: "", coach: champion[0], team: champion[1], race: champion[2], goldenStar: false }] : [],
});

function seasons(): SeasonRecord[] {
  n = 0;
  const s1 = season(1, "BB2020", [
    fx(["Orcs", "Ann", "Orc", 3, 2], ["Elves", "Bob", "Wood Elf", 0, 1]),
    fx(["Elves", "Bob", "Wood Elf", 1], ["Orcs", "Ann", "Orc", 1]),
    // not played: suspended 0-0
    fx(["Orcs", "Ann", "Orc", 0], ["Elves", "Bob", "Wood Elf", 0], { suspended: true }),
  ], [team("Orcs", "Ann", "Orc", [["Grok", { td: 3, cas: 2, spp: 15 }], ["Ug", { td: 1 }]], [["Dead Dave", { cas: 5, spp: 10 }]]), team("Elves", "Bob", "Wood Elf", [["Leaf", { td: 1, completions: 4 }]])], ["Ann", "Orcs", "Orc"]);
  const s5 = season(5, "BB2025", [
    fx(["Orcs", "Ann", "Orc", 1], ["Dwarfs", "Cy", "Dwarf", 2]),
    fx(["Dwarfs", "Cy", "Dwarf", 4], ["Elves", "Bob", "Wood Elf", 0]),
    fx(["Orcs", "Ann", "Orc", null], ["Elves", "Bob", "Wood Elf", null]),
  ], [team("Orcs", "Ann", "Orc", [["Grok", { td: 2, mvp: 1 }]]), team("Dwarfs", "Cy", "Dwarf", [["Thorin", { td: 4, int: 1 }]])]);
  return [s1, s5];
}

describe("league statistics", () => {
  it("all time: coach W/D/L and points from played fixtures, careers summed across seasons, leaders ordered", () => {
    const st = leagueStats(seasons(), "all");
    expect(st.seasons.map((s) => s.number)).toEqual([5, 1]);
    expect(st.totals).toMatchObject({ seasons: 2, games: 4, touchdowns: 12, teams: 3, coaches: 3 });
    const ann = st.coaches.find((c) => c.coach === "Ann")!;
    expect(ann).toMatchObject({ games: 3, wins: 1, draws: 1, losses: 1, points: 4, tdFor: 5, tdAgainst: 3, seasons: [1, 5], titles: 1, winPct: 0.5 });
    expect(st.coaches[0]!.coach).toBe("Cy"); // 6 points
    expect(st.leaders.td.map((l) => [l.name, l.value, l.seasons])).toEqual([["Grok", 5, [1, 5]], ["Thorin", 4, [5]], ["Leaf", 1, [1]], ["Ug", 1, [1]]]);
    expect(st.leaders.cas[0]).toMatchObject({ name: "Dead Dave", value: 5, team: "Orcs" }); // former players count
    expect(st.leaders.int).toHaveLength(1);
    expect(st.biggestWins[0]).toMatchObject({ season: 5, margin: 4, winner: { team: "Dwarfs", score: 4 }, loser: { team: "Elves", score: 0 } });
    expect(st.races.find((r) => r.race === "Dwarf")).toMatchObject({ games: 2, wins: 2, winPct: 1 });
    expect(st.mostGames[0]!.games).toBe(3);
    expect(st.champions).toEqual([{ seasonId: "season-1", season: 1, ruleset: "BB2020", coach: "Ann", team: "Orcs", race: "Orc" }]);
  });

  it("scope filters by rules edition", () => {
    const old = leagueStats(seasons(), "bb2020");
    expect(old.seasons.map((s) => s.number)).toEqual([1]);
    expect(old.totals.games).toBe(2);
    expect(old.coaches.find((c) => c.coach === "Cy")).toBeUndefined();
    expect(old.leaders.td[0]).toMatchObject({ name: "Grok", value: 3 });
    const now = leagueStats(seasons(), "bb2025");
    expect(now.totals.games).toBe(2);
    expect(now.champions).toEqual([]);
    expect(now.leaders.td[0]).toMatchObject({ name: "Thorin", value: 4 });
  });

  it("coaches merge across seasons by NAF name when the display name changed", () => {
    const [s1, s5] = seasons();
    for (const f of s1!.fixtures) for (const side of [f.home, f.away]) if (side.coach === "Ann") side.nafUser = "ann99";
    for (const f of s5!.fixtures) for (const side of [f.home, f.away]) if (side.coach === "Ann") { side.coach = "Ann (A)"; side.nafUser = "ANN99"; }
    const st = leagueStats([s1!, s5!], "all");
    expect(st.coaches.filter((c) => c.coach.startsWith("Ann"))).toHaveLength(1);
    expect(st.coaches.find((c) => c.coach === "Ann (A)")!.games).toBe(3);
  });
});

const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

describe("league routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: Buffer | undefined;
  const deps = (): LeagueApiDeps => ({ store, readBody: async () => body, now: () => new Date("2026-10-30T00:00:00Z") });
  const call = (method: string, path: string, auth?: { coach: string; admin: boolean }, q = "") => leagueApi(method, path, new URLSearchParams(q), auth, deps());

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-api-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Jay"] });
    for (const s of seasons()) store.putSeason(s);
    resetAvatarRateLimit();
    body = undefined;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("path matching and the public-read predicate", () => {
    expect(leaguePath("/api/leagues")).toEqual({ rest: [] });
    expect(leaguePath("/api/leagues/tabbl/seasons/season-1")).toEqual({ id: "tabbl", rest: ["seasons", "season-1"] });
    expect(leaguePath("/api/leaguesx")).toBeUndefined();
    expect(isPublicLeagueRead("GET", "/api/leagues/tabbl/stats")).toBe(true);
    expect(isPublicLeagueRead("PUT", "/api/leagues/tabbl/logo")).toBe(false);
  });

  it("public reads: list, league with season summaries, one season, stats by scope", async () => {
    const list = await call("GET", "/api/leagues");
    expect(list!.status).toBe(200);
    const [l] = (list!.body as { leagues: Array<Record<string, unknown>> }).leagues;
    expect(l).toMatchObject({ id: "tabbl", name: "TABBL", seasonCount: 2, currentSeason: { number: 5, ruleset: "BB2025", status: "active", playedCount: 2, fixtureCount: 3 } });
    expect(l).not.toHaveProperty("logoPath");
    const one = await call("GET", "/api/leagues/tabbl");
    const ob = one!.body as { seasons: Array<{ id: string; champion?: unknown }> };
    expect(ob.seasons.map((s) => s.id)).toEqual(["season-5", "season-1"]);
    expect(ob.seasons[1]!.champion).toEqual({ coach: "Ann", team: "Orcs", race: "Orc" });
    const s = await call("GET", "/api/leagues/tabbl/seasons/season-1");
    expect((s!.body as { season: SeasonRecord }).season.fixtures).toHaveLength(3);
    expect((await call("GET", "/api/leagues/tabbl/seasons/season-9"))!.status).toBe(404);
    expect((await call("GET", "/api/leagues/nope"))!.status).toBe(404);
    const st = await call("GET", "/api/leagues/tabbl/stats", undefined, "scope=bb2025");
    expect((st!.body as { scope: string; totals: { games: number } })).toMatchObject({ scope: "bb2025", totals: { games: 2 } });
    expect((await call("GET", "/api/leagues/tabbl/stats", undefined, "scope=bb2016"))!.status).toBe(400);
    expect((await call("POST", "/api/leagues/tabbl"))!.status).toBe(405);
    expect(await call("GET", "/api/tournaments")).toBeUndefined();
  });

  it("artwork writes: anonymous 401, non-organiser 403, organiser and admin may; GET serves the image; DELETE clears", async () => {
    body = png(512, 512);
    expect((await call("PUT", "/api/leagues/tabbl/logo"))!.status).toBe(401);
    expect((await call("PUT", "/api/leagues/tabbl/logo", { coach: "Mallory", admin: false }))!.status).toBe(403);
    expect((await call("PUT", "/api/leagues/nope/logo", { coach: "Jay", admin: false }))!.status).toBe(404);
    const ok = await call("PUT", "/api/leagues/tabbl/logo", { coach: " jay ", admin: false });
    expect(ok!.status).toBe(200);
    expect((ok!.body as { logoUrl: string }).logoUrl).toMatch(/^\/api\/leagues\/tabbl\/logo\?v=[a-f0-9]{12}$/);
    const read = await call("GET", "/api/leagues/tabbl/logo");
    expect(read!.file!.contentType).toBe("image/png");
    expect(artUrl(store.league("tabbl")!, "logo")).toBe((ok!.body as { logoUrl: string }).logoUrl);
    body = png(1600, 300);
    expect((await call("PUT", "/api/leagues/tabbl/banner", { coach: "Root", admin: true }))!.status).toBe(200);
    const summary = (await call("GET", "/api/leagues/tabbl"))!.body as { league: { bannerUrl?: string; logoUrl?: string } };
    expect(summary.league.bannerUrl).toMatch(/\/banner\?v=/);
    // validation
    body = png(300, 1600);
    expect((await call("PUT", "/api/leagues/tabbl/banner", { coach: "Jay", admin: false }))!.status).toBe(400);
    body = Buffer.from("<svg></svg>");
    expect((await call("PUT", "/api/leagues/tabbl/logo", { coach: "Jay", admin: false }))!.status).toBe(400);
    body = undefined; // over the cap
    expect((await call("PUT", "/api/leagues/tabbl/logo", { coach: "Jay", admin: false }))!).toMatchObject({ status: 413, close: true });
    expect((await call("DELETE", "/api/leagues/tabbl/logo"))!.status).toBe(401);
    expect((await call("DELETE", "/api/leagues/tabbl/logo", { coach: "Jay", admin: false }))!.status).toBe(204);
    expect((await call("GET", "/api/leagues/tabbl/logo"))!.status).toBe(404);
  });

  it("image checks: logo size bounds, header bar landscape only, byte caps", () => {
    expect(checkLeagueArt("logo", png(32, 32)).ok).toBe(false);
    expect(checkLeagueArt("logo", png(2000, 2000)).ok).toBe(true);
    expect(checkLeagueArt("banner", png(2000, 2000)).ok).toBe(false);
    expect(checkLeagueArt("banner", Buffer.concat([png(1600, 300), Buffer.alloc(2 * 1024 * 1024)])).ok).toBe(false);
  });
});
