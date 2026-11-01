import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { computePhaseStandings, deriveStandings, isKnockoutPhase, proposePodium } from "../src/leagues/standings";
import { LeagueStore } from "../src/leagues/store";
import type { FixtureSide, LeagueFixture, LeaguePhase, LeagueTeam, SeasonRecord, StandingRow } from "../src/leagues/types";

// League standings derived from results and the season podium (src/leagues/standings.ts, Finish season in api.ts).

const team = (id: string, name: string, coach: string): LeagueTeam => ({
  id, name, race: "Orc", coach, coachId: coach, teamValue: null, treasury: null, rerolls: null, fans: null, assistantCoaches: null,
  cheerleaders: null, apothecary: false, tier: "", raceLeague: "", players: [], formerPlayers: [],
});
const TEAMS = [team("a", "Alpha", "Ann"), team("b", "Bravo", "Bob"), team("c", "Charlie", "Cy"), team("d", "Delta", "Di")];
const sideOf = (id: string, score: number | null = null, cas: number | null = null, conceded = false): FixtureSide => {
  const t = TEAMS.find((x) => x.id === id)!;
  return { team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score, cas, conceded };
};
let n = 0;
const game = (h: string, a: string, hs: number | null, as: number | null, over: Partial<LeagueFixture> & { hc?: number; ac?: number; hConc?: boolean; aConc?: boolean } = {}): LeagueFixture => {
  const { hc = 0, ac = 0, hConc = false, aConc = false, ...rest } = over;
  n += 1;
  return {
    id: `f${n}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: n,
    home: sideOf(h, hs, hs === null ? null : hc, hConc), away: sideOf(a, as, as === null ? null : ac, aConc), suspended: false,
    finishedAt: hs === null ? undefined : `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00.000Z`, ...rest,
  };
};
const regular = (over: Partial<LeaguePhase> = {}): LeaguePhase => ({ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [], ...over });
const manual = (fixtures: LeagueFixture[], over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "season-7", ruleset: "BB2025", status: "active",
  phases: [regular()], fixtures, participants: [], teams: TEAMS.map((t) => structuredClone(t)), honours: [], awards: [], unattributedStats: [],
  importedAt: "2026-10-01T00:00:00.000Z", source: "manual", ...over,
});
const table = (s: SeasonRecord, phase = 0): StandingRow[] => computePhaseStandings(s, s.phases[phase]!).rows;
const order = (rows: StandingRow[]): string[] => rows.map((r) => r.teamId ?? r.team);

describe("standings maths", () => {
  beforeEach(() => { n = 0; });

  it("default points W3 D1 L0, TD and CAS for / against, every season team seeded", () => {
    const rows = table(manual([game("a", "b", 2, 1, { hc: 3, ac: 1 }), game("c", "a", 1, 1, { hc: 0, ac: 2 })]));
    expect(order(rows)).toEqual(["a", "c", "d", "b"]);
    expect(rows[0]).toMatchObject({ rank: 1, points: 4, played: 2, wins: 1, draws: 1, losses: 0, tdFor: 3, tdAgainst: 2, casFor: 5, casAgainst: 1, coachId: "Ann" });
    expect(rows.find((r) => r.teamId === "b")).toMatchObject({ points: 0, losses: 1, tdFor: 1, tdAgainst: 2 });
    expect(rows.find((r) => r.teamId === "d")).toMatchObject({ played: 0, points: 0, rank: 3 });
  });

  it("the phase's own points setting wins", () => {
    const s = manual([game("a", "b", 1, 1), game("c", "d", 1, 0)], { phases: [regular({ points: { win: 2, draw: 1, loss: 0 } })] });
    expect(table(s).find((r) => r.teamId === "c")!.points).toBe(2);
  });

  it("tiebreaks: points, then TD difference, then CAS difference, then head-to-head, then name", () => {
    // a and b both 3 pts; a has the better TD diff.
    expect(order(table(manual([game("a", "c", 3, 0), game("b", "d", 1, 0), game("c", "d", 0, 0), game("a", "b", 0, 0)]))).slice(0, 2)).toEqual(["a", "b"]);
    // Same points and TD diff; b has the better CAS diff.
    expect(order(table(manual([game("a", "c", 1, 0, { hc: 0 }), game("b", "d", 1, 0, { hc: 2 })]))).slice(0, 2)).toEqual(["b", "a"]);
    // a and c level on points, TD and CAS difference: c beat a head to head, so c is above a (name would say a).
    const rows = table(manual([game("c", "a", 1, 0), game("d", "c", 1, 0), game("a", "b", 1, 0)]));
    expect(rows.find((r) => r.teamId === "a")).toMatchObject({ points: 3, tdFor: 1, tdAgainst: 1 });
    expect(rows.find((r) => r.teamId === "c")).toMatchObject({ points: 3, tdFor: 1, tdAgainst: 1 });
    expect(order(rows)).toEqual(["d", "c", "a", "b"]);
    // Nothing separates them: name.
    expect(order(table(manual([game("b", "a", 1, 1)]))).slice(0, 2)).toEqual(["a", "b"]);
    // A phase's own tiebreaks: TD for before TD difference.
    const custom = manual([game("a", "c", 1, 0), game("b", "d", 3, 2)], { phases: [regular({ tiebreaks: ["points", "tdFor", "name"] })] });
    expect(order(table(custom)).slice(0, 2)).toEqual(["b", "a"]);
  });

  it("forfeits and suspended games count as the data says", () => {
    const rows = table(manual([
      game("a", "b", 2, 0, { hConc: true }), // a conceded: a loses despite the score
      game("c", "d", 0, 0, { suspended: true }), // suspended 0-0, no concession: not played
      game("c", "d", 1, 0, { suspended: true }), // suspended with a score: counts
      game("b", "d", 0, 0, { hConc: true, aConc: true }), // both conceded: both lose
    ]));
    expect(rows.find((r) => r.teamId === "a")).toMatchObject({ played: 1, losses: 1, points: 0, tdFor: 2 });
    expect(rows.find((r) => r.teamId === "b")).toMatchObject({ played: 2, wins: 1, losses: 1, points: 3 });
    expect(rows.find((r) => r.teamId === "c")).toMatchObject({ played: 1, wins: 1 });
    expect(rows.find((r) => r.teamId === "d")).toMatchObject({ played: 2, losses: 2 });
  });

  it("Super FUMBBL result stats (COM, INT, INJ, DTH, FOU) only when a result carries them; LATEST dots", () => {
    const line = (completions: number, interceptions: number, fouls: number) => ({ forkPlayerId: "x", name: "x", td: 0, cas: 0, completions, interceptions, mvp: 0, fouls, injuries: [] });
    const fork = game("a", "b", 2, 1, { hc: 1, ac: 0 });
    fork.fork = { status: "finished", teams: {}, log: [], result: { gameId: "g1", source: "full", appliedAt: "2026-10-20T00:00:00Z",
      home: { score: 2, cas: 1, conceded: false, winnings: 0, lines: [line(3, 1, 2)] },
      away: { score: 1, cas: 0, conceded: false, winnings: 0, lines: [line(1, 0, 1)], casualtiesSuffered: { badlyHurt: 0, seriousInjury: 1, rip: 1 } } } };
    const plain = deriveStandings(manual([game("a", "b", 1, 0)]))[0]!;
    expect(plain.standingsStats).toEqual([]);
    expect(plain.standingsSource).toBe("computed");
    const s = manual([game("a", "c", 0, 1), fork, game("a", "d", 1, 1)]);
    const phase = deriveStandings(s)[0]!;
    expect(phase.standingsStats).toEqual(["completions", "interceptions", "injuries", "deaths", "fouls"]);
    expect(phase.standings.find((r) => r.teamId === "a")).toMatchObject({ completions: 3, interceptions: 1, foulsFor: 2, foulsAgainst: 1, injuriesFor: 1, deathsFor: 1, latest: ["W", "L", "D"] }); // by finish time
    expect(phase.standings.find((r) => r.teamId === "b")).toMatchObject({ injuriesAgainst: 1, deathsAgainst: 1, latest: ["L"] });
  });

  it("divisions: one ranking per group, interdivision games count in the team's own group", () => {
    const s = manual([
      game("a", "b", 1, 0, { group: "North" }), game("c", "d", 2, 0, { group: "South" }),
      game("b", "c", 3, 0, { phaseId: "season-interdivision", phase: "Interdivision" }),
    ], { phases: [regular({ groups: ["North", "South"], includes: ["season-interdivision"] }), { id: "season-interdivision", category: "Season", name: "Interdivision", groups: [], standings: [] }] });
    const rows = table(s);
    expect(rows.filter((r) => r.group === "North").map((r) => [r.teamId, r.rank, r.points, r.played])).toEqual([["b", 1, 3, 2], ["a", 2, 3, 1]]); // b: +2 TD with the interdivision win
    expect(rows.filter((r) => r.group === "South").map((r) => [r.teamId, r.rank])).toEqual([["c", 1], ["d", 2]]);
    expect(isKnockoutPhase({ name: "PlayOffs", category: "Season" })).toBe(true);
    expect(isKnockoutPhase({ name: "Regular", category: "Season" })).toBe(false);
  });
});

describe("podium proposal", () => {
  beforeEach(() => { n = 0; });

  it("from the final standings when there is no playoff", () => {
    const p = proposePodium(manual([game("a", "b", 2, 0), game("c", "d", 1, 0), game("a", "c", 1, 0)]));
    expect(p.decidedBy).toBe("standings");
    expect([p.champion?.ref, p.runnerUp?.ref, p.consolation?.ref]).toEqual(["a", "c", "d"]);
    expect(p.candidates.map((c) => c.ref)).toEqual(["a", "b", "c", "d"]);
    expect(proposePodium(manual([])).decidedBy).toBe("none");
  });

  it("from the playoff final (and the third-place game) when a knockout phase exists", () => {
    const po = (h: string, a: string, hs: number, as: number, round: number): LeagueFixture => game(h, a, hs, as, { phaseId: "season-playoffs", phase: "PlayOffs", round });
    const phases = [regular(), { id: "season-playoffs", category: "Season", name: "PlayOffs", groups: [], standings: [] }];
    const regularGames = [game("a", "b", 3, 0), game("a", "c", 3, 0), game("a", "d", 3, 0), game("b", "c", 1, 0)];
    // Semis: d beats a, c beats b. Final d-c (c wins); third place a-b (b wins).
    const withThird = manual([...regularGames, po("a", "d", 0, 1, 1), po("b", "c", 0, 1, 1), po("d", "c", 0, 2, 2), po("a", "b", 0, 1, 2)], { phases });
    const p = proposePodium(withThird);
    expect(p.decidedBy).toBe("playoff");
    expect([p.champion?.ref, p.runnerUp?.ref, p.consolation?.ref]).toEqual(["c", "d", "b"]);
    // No third-place game: the better-placed semi-final loser in the table (a).
    const noThird = proposePodium(manual([...regularGames, po("a", "d", 0, 1, 1), po("b", "c", 0, 1, 1), po("d", "c", 0, 2, 2)], { phases }));
    expect([noThird.champion?.ref, noThird.runnerUp?.ref, noThird.consolation?.ref]).toEqual(["c", "d", "a"]);
    // The knockout phase has no table of its own.
    expect(deriveStandings(withThird)[1]!.standings).toEqual([]);
  });
});

describe("standings and Finish season through the league API", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  const JAY = { coach: "Jay", admin: false };
  const MALLORY = { coach: "Mallory", admin: false };
  const deps = (): LeagueApiDeps => ({
    store, now: () => new Date("2026-11-01T12:00:00Z"), postWebhook: async () => ({ ok: true, status: 204 }),
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route ${path}`);
    return r;
  };
  const readSeason = async (id = "season-7"): Promise<SeasonRecord> => ((await call("GET", `/api/leagues/tabbl/seasons/${id}`)).body as { season: SeasonRecord }).season;
  const row = (s: SeasonRecord, teamId: string) => s.phases[0]!.standings.find((r) => r.teamId === teamId)!;

  beforeEach(() => {
    n = 0;
    dir = mkdtempSync(join(tmpdir(), "league-standings-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(manual([game("a", "b", null, null), game("c", "d", null, null)]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("recomputes when a result is added, edited and removed", async () => {
    expect((await readSeason()).phases[0]!.standings.every((r) => r.played === 0)).toBe(true);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f1", JAY, { result: { home: 2, away: 1, homeCas: 1, awayCas: 0 } })).status).toBe(200);
    let s = await readSeason();
    expect(row(s, "a")).toMatchObject({ rank: 1, points: 3, wins: 1, tdFor: 2, casFor: 1, latest: ["W"] });
    expect(s.phases[0]!.standingsSource).toBe("computed");
    await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f1", JAY, { result: { home: 0, away: 1 } });
    s = await readSeason();
    expect(row(s, "b")).toMatchObject({ rank: 1, points: 3 });
    expect(row(s, "a")).toMatchObject({ points: 0, losses: 1, latest: ["L"] });
    await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f1", JAY, { result: null });
    s = await readSeason();
    expect(row(s, "b")).toMatchObject({ played: 0, points: 0 });
    // Nothing is written to the stored season: the table is derived on read.
    expect(store.season("tabbl", "season-7")!.phases[0]!.standings).toEqual([]);
  });

  it("an imported season keeps its exported table until a result changes here", async () => {
    const imported: StandingRow = { ...computePhaseStandings(manual([game("a", "b", 1, 0)]), regular()).rows[0]!, points: 99, completions: 7 };
    store.putSeason(manual([game("a", "b", 1, 0), game("c", "d", null, null)], {
      id: "season-6", number: 6, sourceSlug: "s6", source: "tourplay-export", status: "completed", phases: [regular({ standings: [imported] })],
    }));
    let s = await readSeason("season-6");
    expect(s.phases[0]!.standingsSource).toBe("imported");
    expect(s.phases[0]!.standings[0]).toMatchObject({ points: 99, latest: ["W"] });
    expect(s.phases[0]!.standingsStats).toEqual(["completions"]);
    await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f5", JAY, { result: { home: 1, away: 0 } });
    s = await readSeason("season-6");
    expect(s.phases[0]!.standingsSource).toBe("computed");
    expect(row(s, "a").points).toBe(3);
    expect(row(s, "c").points).toBe(3);
  });

  it("Finish season: organiser only, proposal, override recorded, podium shown as awards; reopen clears it", async () => {
    await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f1", JAY, { result: { home: 2, away: 0 } });
    await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f2", JAY, { result: { home: 1, away: 0 } });
    for (const [m, p] of [["GET", "podium"], ["POST", "finish"], ["POST", "reopen"]] as const) {
      expect((await call(m, `/api/leagues/tabbl/seasons/season-7/${p}`, MALLORY, {})).status).toBe(403);
      expect((await call(m, `/api/leagues/tabbl/seasons/season-7/${p}`, undefined, {})).status).toBe(401);
    }
    const prop = (await call("GET", "/api/leagues/tabbl/seasons/season-7/podium", JAY)).body as { proposal: { champion: { ref: string }; runnerUp: { ref: string }; decidedBy: string } };
    expect(prop.proposal).toMatchObject({ decidedBy: "standings", champion: { ref: "a" }, runnerUp: { ref: "c" } });
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/finish", JAY, { podium: { champion: "zzz" } })).status).toBe(400);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/finish", JAY, { podium: { runnerUp: "a" } })).status).toBe(400); // a twice
    expect(store.season("tabbl", "season-7")!.status).toBe("active");
    const fin = await call("POST", "/api/leagues/tabbl/seasons/season-7/finish", JAY, { podium: { runnerUp: "d", consolation: "" } });
    expect(fin.status).toBe(200);
    expect((fin.body as { season: { champion: unknown; finishedHere: boolean } }).season).toMatchObject({ champion: { team: "Alpha", coach: "Ann" }, finishedHere: true });
    const stored = store.season("tabbl", "season-7")!;
    expect(stored.podium).toMatchObject({ decidedBy: "organiser", overridden: true, by: "Jay", proposed: { champion: "a", runnerUp: "c", consolation: "d" }, final: { champion: "a", runnerUp: "d" } });
    expect(stored.awards.map((a) => [a.type, a.team, a.goldenStar, a.podium])).toEqual([["Overall Champion", "Alpha", true, true], ["Runner-up", "Delta", false, true]]);
    // The league read and the statistics champions pick it up.
    const league = (await call("GET", "/api/leagues/tabbl")).body as { seasons: Array<{ champion?: { team: string } }> };
    expect(league.seasons[0]!.champion?.team).toBe("Alpha");
    expect(((await call("GET", "/api/leagues/tabbl/stats")).body as { champions: Array<{ team: string }> }).champions.map((c) => c.team)).toEqual(["Alpha"]);
    // Reopen clears the podium; finishing again without changes records no override.
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/reopen", JAY, {})).status).toBe(200);
    expect(store.season("tabbl", "season-7")).toMatchObject({ status: "active", awards: [] });
    expect(store.season("tabbl", "season-7")!.podium).toBeUndefined();
    await call("POST", "/api/leagues/tabbl/seasons/season-7/finish", JAY, {});
    expect(store.season("tabbl", "season-7")!.podium).toMatchObject({ decidedBy: "standings", overridden: false });
    expect(store.season("tabbl", "season-7")!.awards.map((a) => a.team)).toEqual(["Alpha", "Charlie", "Delta"]);
  });

  it("a season with an imported champion keeps it; an override is refused", async () => {
    store.putSeason(manual([game("a", "b", 1, 0)], {
      id: "season-6", number: 6, sourceSlug: "s6", source: "tourplay-export",
      awards: [{ category: "Season", type: "Overall Champion", name: "", description: "", coach: "Bob", team: "Bravo", race: "Orc", goldenStar: false }],
    }));
    expect(((await call("GET", "/api/leagues/tabbl/seasons/season-6/podium", JAY)).body as { proposal: { decidedBy: string } }).proposal.decidedBy).toBe("imported");
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", JAY, { podium: { champion: "a" } })).status).toBe(409);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", JAY, {})).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.awards.map((a) => a.team)).toEqual(["Bravo"]);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/reopen", JAY, {})).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.awards.map((a) => a.team)).toEqual(["Bravo"]);
  });
});
