import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseAdminGameList, type GamestateTeamResult } from "@bb/fork-ops";
import {
  FINISHED_GAME_STATUSES,
  TournamentResultStore,
  aggregateStandings,
  deriveTeamResult,
  discoverFinishedGames,
  storedSide,
  mayReadResult,
  type StoredTournamentResult,
} from "../src/tournamentResults.js";
import { computeElo } from "../src/coachElo.js";
import type { TournamentMatchMetadata } from "../src/tournamentMatch.js";

const roots: string[] = [];
const team = (teamId: string, score: number, penaltyScore: number, casualties: number, winnings = 0): GamestateTeamResult => ({
  teamId,
  score,
  winnings,
  penaltyScore,
  conceded: penaltyScore >= 0,
  casualtiesSuffered: { bh: 0, si: 0, rip: 0 },
  players: [{
    playerId: `${teamId}-player`,
    name: "Player",
    touchdowns: 0,
    casualtiesCaused: casualties,
    blocks: 0,
    fouls: 0,
    completions: 0,
    interceptions: 0,
    deflections: 0,
    mvp: 0,
  }],
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("deriveTeamResult", () => {
  it("derives W-D-L, touchdown totals, caused casualties, and winnings from server results", () => {
    const home = team("home", 3, -1, 2, 70_000);
    const away = team("away", 1, -1, 4, 50_000);
    expect(deriveTeamResult(home, away)).toEqual({
      outcome: "won",
      tdFor: 3,
      tdAgainst: 1,
      casFor: 2,
      casAgainst: 4,
      winnings: 70_000,
    });
    expect(deriveTeamResult(away, home).outcome).toBe("lost");
    expect(deriveTeamResult(team("a", 1, -1, 0), team("b", 1, -1, 0)).outcome).toBe("drawn");
  });

  it("uses every nonnegative penaltyScore instead of the raw score", () => {
    const conceded = team("home", 4, 0, 0);
    const winner = team("away", 1, 2, 0);
    expect(deriveTeamResult(conceded, winner)).toMatchObject({ outcome: "lost", tdFor: 0, tdAgainst: 2 });
    expect(deriveTeamResult(winner, conceded)).toMatchObject({ outcome: "won", tdFor: 2, tdAgainst: 0 });
  });
});

describe("TournamentResultStore and standings", () => {
  it("atomically persists results and joins tournament metadata while retaining ad-hoc games", () => {
    const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-results-"));
    roots.push(root);
    const store = new TournamentResultStore(root);
    const tournamentResult: StoredTournamentResult = {
      gameId: "tournament",
      pulledAt: "2026-08-27T00:00:00.000Z",
      home: { teamId: "home", teamName: "Home", coach: "Old Home" },
      away: { teamId: "away", teamName: "Away", coach: "Old Away" },
      teams: [team("home", 2, -1, 3, 80_000), team("away", 1, -1, 1, 60_000)],
    };
    const adHocResult: StoredTournamentResult = {
      gameId: "ad-hoc",
      pulledAt: "2026-08-27T01:00:00.000Z",
      home: { teamId: "third", teamName: "Third", coach: "Coach Three" },
      away: { teamId: "fourth", teamName: "Fourth", coach: "Coach Four" },
      teams: [team("third", 0, -1, 0, 40_000), team("fourth", 0, -1, 2, 50_000)],
    };
    store.put(tournamentResult);
    store.put(adHocResult);
    expect(readdirSync(root)).toEqual(["tournament-results.json"]);
    expect(new TournamentResultStore(root).get("tournament")).toEqual({ ...tournamentResult, namesDecoded: true }); // legacy row: migrated once on load

    const metadata: TournamentMatchMetadata = {
      gameId: "tournament",
      packageName: "Spike Cup",
      home: { ffbCoachId: "Coach One", teamId: "home", instructions: { treasury: 0, inducements: [] } },
      away: { ffbCoachId: "Coach Two", teamId: "away", instructions: { treasury: 0, inducements: [] } },
      createdAt: "2026-08-26T00:00:00.000Z",
    };
    const rows = aggregateStandings(store.list(), (gameId) => gameId === metadata.gameId ? metadata : undefined);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ coach: "Coach One", packageName: "Spike Cup", won: 1, tdDiff: 1, casDiff: 2, winnings: 80_000 }),
      expect.objectContaining({ coach: "Coach Two", packageName: "Spike Cup", lost: 1, tdDiff: -1, casDiff: -2, winnings: 60_000 }),
      expect.objectContaining({ coach: "Coach Three", drawn: 1, casDiff: -2, winnings: 40_000 }),
      expect.objectContaining({ coach: "Coach Four", drawn: 1, casDiff: 2, winnings: 50_000 }),
    ]));
    expect(aggregateStandings(store.list(), () => undefined, { coach: "coach three" })).toHaveLength(1);
    expect(aggregateStandings(store.list(), (id) => id === metadata.gameId ? metadata : undefined, { packageName: "spike cup" }))
      .toHaveLength(2);
  });
});

describe("result access", () => {
  const game = {
    gameId: "42",
    status: "finished",
    half: 2,
    turn: 8,
    homeTeamId: "home",
    homeTeamName: "Home",
    homeCoach: "Coach One",
    awayTeamId: "away",
    awayTeamName: "Away",
    awayCoach: "Coach Two",
  };

  it("allows either participant and admins, but rejects other authenticated coaches", () => {
    expect(mayReadResult(game, undefined, { coach: "coach one", admin: false })).toBe(true);
    expect(mayReadResult(game, undefined, { coach: "outsider", admin: false })).toBe(false);
    expect(mayReadResult(game, undefined, { admin: true })).toBe(true);
  });
});

describe("finished-game discovery", () => {
  it("merges finished and backuped instead of requesting a nonexistent all status", async () => {
    const cfg = { baseUrl: "http://127.0.0.1:22227", passwordMd5Hex: "098f6bcd4621d373cade4e832627b4f6" };
    const statuses: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("/admin/challenge"))
        return new Response("<admin><challenge>3c67e0dacb39754d058e398f9911ab71</challenge></admin>");
      const status = new URL(url).searchParams.get("status")!;
      statuses.push(status);
      return new Response(`<admin><list><game id="${status}" status="${status}" half="2" turn="8">
        <team home="true" id="a-${status}" name="A" coach="Coach A"/>
        <team home="false" id="b-${status}" name="B" coach="Coach B"/>
      </game></list></admin>`);
    }));

    expect((await discoverFinishedGames(cfg)).map((game) => game.gameId).sort()).toEqual(["backuped", "finished"]);
    expect(statuses.sort()).toEqual([...FINISHED_GAME_STATUSES].sort());
  });
});

describe("stored result sides", () => {
  it("decode the admin list's XML-escaped names once, so a team named <script>brains? is stored literally", () => {
    const [game] = parseAdminGameList(`<admin><list><game id="9" status="finished" half="2" turn="8">
      <team home="true" id="a" name="&lt;script&gt;brains? &amp;amp; &quot;x&quot;" coach="A&amp;B"/>
      <team home="false" id="b" name="B" coach="C"/></game></list></admin>`);
    expect(storedSide(game!, "home")).toEqual({ teamId: "a", teamName: '<script>brains? &amp; "x"', coach: "A&B" });
  });
});

describe("legacy escaped names", () => {
  it("decodes legacy fork rows once on load, so a coach stored as A&amp;B and A&B is one Elo key and a decoded row is never decoded again", () => {
    const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-results-"));
    roots.push(root);
    const row = (gameId: string, coach: string, name: string, extra: Partial<StoredTournamentResult> = {}): StoredTournamentResult => ({
      gameId, pulledAt: "2026-08-27T00:00:00.000Z",
      home: { teamId: `h${gameId}`, teamName: name, coach },
      away: { teamId: `a${gameId}`, teamName: "Other", coach: `Opp${gameId}` },
      teams: [team(`h${gameId}`, 2, -1, 0), team(`a${gameId}`, 1, -1, 0)], ...extra,
    });
    const legacy = row("1", "A&amp;B", "&lt;script&gt;brains?");
    const fresh = row("2", "A&B", "A literal &amp;lt; name", { namesDecoded: true }); // already decoded: must stay as is
    const tabletop = row("3", "T&amp;T", "Tab &amp; Co", { source: "tabletop", published: true }); // never XML: untouched
    writeFileSync(join(root, "tournament-results.json"), JSON.stringify({ version: 1, results: { 1: legacy, 2: fresh, 3: tabletop } }));
    const store = new TournamentResultStore(root);
    const rows = store.list();
    expect(rows.find((r) => r.gameId === "1")!.home).toMatchObject({ coach: "A&B", teamName: "<script>brains?" });
    expect(rows.find((r) => r.gameId === "2")!.home).toMatchObject({ coach: "A&B", teamName: "A literal &amp;lt; name" });
    expect(rows.find((r) => r.gameId === "3")!.home).toMatchObject({ coach: "T&amp;T", teamName: "Tab &amp; Co" });
    expect([...computeElo(rows, { includeTabletop: false }).keys()].filter((k) => k.includes("a&"))).toEqual(["a&b"]);
    // persisted: a fresh store reads the same rows and a second load changes nothing
    const onDisk = readFileSync(join(root, "tournament-results.json"), "utf8");
    expect(new TournamentResultStore(root).list()).toEqual(rows);
    expect(readFileSync(join(root, "tournament-results.json"), "utf8")).toBe(onDisk);
  });
});

describe("test games (test-games.json) never count", () => {
  const row = (gameId: string): StoredTournamentResult => ({
    gameId, pulledAt: "2026-10-29T00:00:00.000Z", namesDecoded: true,
    home: { teamId: "lg_a", teamName: "A", coach: "Flutethecat" }, away: { teamId: "lg_b", teamName: "B", coach: "Gondra87" },
    teams: [team("lg_a", 2, -1, 1), team("lg_b", 0, -1, 0)],
  });

  it("a listed game is stored test:true by any importer, and is left out of list()", async () => {
    const root = mkdtempSync(join(tmpdir(), "test-games-"));
    roots.push(root);
    const { TestGameStore } = await import("../src/testGames.js");
    expect(new TestGameStore(root).add(["1096", "1096", "../x"], "league-fork-test")).toEqual(["1096"]);
    const store = new TournamentResultStore(root);
    store.put(row("1096"));
    store.put(row("2000"));
    expect(store.get("1096")?.test).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "tournament-results.json"), "utf8")).results["1096"].test).toBe(true);
    expect(store.list().map((r) => r.gameId)).toEqual(["2000"]);
  });

  it("a row imported before its game was listed reads as test afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "test-games-"));
    roots.push(root);
    const store = new TournamentResultStore(root);
    store.put(row("1097"));
    expect(store.list().map((r) => r.gameId)).toEqual(["1097"]);
    const { TestGameStore } = await import("../src/testGames.js");
    new TestGameStore(root).add(["1097"], "league-fork-test");
    expect(store.get("1097")?.test).toBe(true);
    expect(store.list()).toEqual([]);
    expect(store.listAll()[0]?.test).toBe(true);
  });
});

describe("refreshFinishedResults", () => {
  it("skips a finished game whose result the fork cannot serve and still imports the rest", async () => {
    const root = mkdtempSync(join(tmpdir(), "refresh-"));
    roots.push(root);
    const store = new TournamentResultStore(root);
    const game = (id: string) => parseAdminGameList(`<admin><list><game id="${id}" status="finished" half="2" turn="8">
      <team home="true" id="a${id}" name="A" coach="Coach A"/><team home="false" id="b${id}" name="B" coach="Coach B"/></game></list></admin>`)[0]!;
    const skipped: string[] = [];
    const { refreshFinishedResults } = await import("../src/tournamentResults.js");
    const games = await refreshFinishedResults({ baseUrl: "http://x", passwordMd5Hex: "0".repeat(32) }, store, {
      discover: async () => [game("1072"), game("1100")],
      pull: async (_cfg, s, g) => {
        if (g.gameId === "1072") throw new Error("fork gamestate/result failed (HTTP 404)");
        return s.put({ gameId: g.gameId, pulledAt: "2026-10-29T00:00:00.000Z", home: storedSide(g, "home"), away: storedSide(g, "away"), teams: [team(`a${g.gameId}`, 1, -1, 0), team(`b${g.gameId}`, 0, -1, 0)] });
      },
      onSkip: (id) => skipped.push(id),
    });
    expect(games.map((g) => g.gameId)).toEqual(["1072", "1100"]);
    expect(skipped).toEqual(["1072"]);
    expect(store.get("1100")).toBeDefined();
    expect(store.get("1072")).toBeUndefined();
  });
});
