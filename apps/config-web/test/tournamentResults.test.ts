import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GamestateTeamResult } from "@bb/fork-ops";
import {
  FINISHED_GAME_STATUSES,
  TournamentResultStore,
  aggregateStandings,
  deriveTeamResult,
  discoverFinishedGames,
  mayReadResult,
  type StoredTournamentResult,
} from "../src/tournamentResults.js";
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
    expect(new TournamentResultStore(root).get("tournament")).toEqual(tournamentResult);

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
