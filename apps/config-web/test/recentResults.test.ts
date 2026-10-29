import { describe, expect, it } from "vitest";
import { RECENT_RESULTS_DEFAULT, recentLimit, recentResults, type RecentInputs } from "../src/recentResults";

// GET /api/recent-results normalisation (src/recentResults.ts): every source, newest first, limit, null casualties,
// concessions, and one card per game when sources overlap.

const player = (cas: number) => ({ playerId: "p", name: "P", touchdowns: 0, casualtiesCaused: cas, blocks: 0, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0 });
const forkTeam = (teamId: string, score: number, cas: number[], conceded = false) => ({
  teamId, score, winnings: 0, penaltyScore: -1, conceded, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: cas.map(player),
});
const forkRow = (gameId: string, playedAt: string | undefined, extra: Record<string, unknown> = {}) => ({
  gameId, pulledAt: "2026-10-01T00:00:00.000Z", ...(playedAt ? { playedAt } : {}),
  home: { teamId: "h", teamName: "Reavers", coach: "Alice" },
  away: { teamId: "a", teamName: "Grinders", coach: "Bob" },
  teams: [forkTeam("h", 2, [1, 1]), forkTeam("a", 1, [0])],
  ...extra,
});
const coach = (id: string) => ({ coachId: id, ffbCoachId: id, verifiedAt: "x" });
const fixture = (id: string, round: number, result: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  id, tournamentId: "t1", roundId: `r${round}`, roundNumber: round, status: "completed", revision: 1,
  home: { entrantId: "e1", coach: coach("Carol"), teamId: "tc" },
  away: { entrantId: "e2", coach: coach("Dan"), teamId: "td" },
  launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  ...(result ? { result } : {}), createdAt: "x", updatedAt: "2026-09-01T00:00:00.000Z", ...extra,
});
const entrant = (id: string, teamName: string, race: string) => ({ id, tournamentId: "t1", seed: 1, coach: coach(id), teamId: `t-${id}`, registeredAt: "x", submission: { teamName, race } });
const tabletopMatch = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, state, home: { coach: "Eve", teamSaveId: "library:9", teamName: "Night <Owls>" }, away: { coach: "Finn", teamSaveId: "s1", teamName: "" },
  postMatch: "none", createdBy: "Eve", createdAt: "x", updatedAt: "2026-10-20T00:00:00.000Z", confirmations: {}, baseRevision: { home: 0, away: 0 }, ...extra,
});
const ev = (id: string, type: string, team: "home" | "away", payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id, matchId: "m", type, team, payload, by: "Eve", ts: "2026-10-21T10:00:00.000Z", ...extra });

function inputs(over: Partial<RecentInputs> = {}): RecentInputs {
  return { results: [], tournaments: [], tabletop: [], ...over } as RecentInputs;
}

describe("recent results", () => {
  it("limit: 1..50, default 12", () => {
    expect(recentLimit(null)).toBe(RECENT_RESULTS_DEFAULT);
    expect(recentLimit("0")).toBe(12);
    expect(recentLimit("abc")).toBe(12);
    expect(recentLimit("3")).toBe(3);
    expect(recentLimit("500")).toBe(50);
  });

  it("fork rows: newest first by playedAt (pulledAt fallback), limit applied, casualties summed, concede side", () => {
    const rows = recentResults(inputs({
      results: [
        forkRow("g1", "2026-10-02T00:00:00.000Z"),
        forkRow("g2", "2026-10-05T00:00:00.000Z", { teams: [forkTeam("h", 0, [], true), forkTeam("a", 2, [3])] }),
        forkRow("g3", undefined),
        forkRow("tt", "2026-10-30T00:00:00.000Z", { source: "tabletop" }), // tabletop rows come from the recorder, not here
        forkRow("tx", "2026-10-30T00:00:00.000Z", { test: true }),
      ] as never,
    }), 2);
    expect(rows.map((r) => r.id)).toEqual(["fork:g2", "fork:g1"]);
    expect(rows[0]).toMatchObject({ source: "fork", context: "Online · Friendly", href: null, concede: "home", suspended: false, home: { name: "Reavers", coach: "Alice", score: 0, cas: 0 }, away: { score: 2, cas: 3 } });
    expect(rows[1]!.home.cas).toBe(2);
    expect(rows[1]!.concede).toBeNull();
    const all = recentResults(inputs({ results: [forkRow("g1", "2026-10-02T00:00:00.000Z"), forkRow("g3", undefined)] as never }));
    expect(all.map((r) => r.playedAt)).toEqual(["2026-10-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z"]);
  });

  it("tournament fixtures: context, page link, entrant team names; casualties null when unreported, never 0", () => {
    const rows = recentResults(inputs({
      tournaments: [{
        id: "t1", name: "Spike Beta Test",
        entrants: [entrant("e1", "Carol's Crushers", "Orc"), entrant("e2", "Dan's Darlings", "Wood Elf")] as never,
        matches: [
          fixture("m1", 3, { homeScore: 0, awayScore: 4, reportedAt: "2026-10-10T00:00:00.000Z" }),
          fixture("m2", 2, { homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0, reportedAt: "2026-10-09T00:00:00.000Z" }),
          fixture("m3", 4, undefined), // not played yet
          fixture("bye", 1, { homeScore: 2, awayScore: 0, reportedAt: "2026-10-11T00:00:00.000Z" }, { away: undefined }),
        ] as never,
      }],
    }));
    expect(rows.map((r) => r.id)).toEqual(["tournament:m1", "tournament:m2"]);
    expect(rows[0]).toMatchObject({
      source: "tournament", context: "Spike Beta Test · Round 3", href: "/app/tournaments/t1", concede: null,
      home: { name: "Carol's Crushers", race: "Orc", coach: "Carol", score: 0, cas: null, crestUrl: null },
      away: { name: "Dan's Darlings", race: "Wood Elf", coach: "Dan", score: 4, cas: null },
    });
    expect(rows[1]!.home.cas).toBe(2);
    expect(rows[1]!.away.cas).toBe(0);
  });

  it("a fork game launched from a fixture is listed once, lending the fixture its casualties", () => {
    const rows = recentResults(inputs({
      results: [forkRow("g7", "2026-10-12T00:00:00.000Z")] as never,
      tournaments: [{ id: "t1", name: "Cup", entrants: [], matches: [fixture("m1", 1, { homeScore: 2, awayScore: 1, reportedAt: "2026-10-12T01:00:00.000Z" }, { launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, gameId: "g7" } })] as never }],
    }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "tournament:m1", home: { cas: 2 }, away: { cas: 0 } });
  });

  it("tabletop: submitted onwards only (no test, no recording); score, casualties and concede from the effective events; fixture link replaces the fixture", () => {
    const events = [
      ev("1", "touchdown", "home", {}, { player: "p1" }),
      ev("2", "touchdown", "away", {}, { player: "q1" }),
      ev("3", "undo", "away", { target: "2" }),
      ev("4", "casualty", "home", { victim: "q2", result: "BH", cause: "block" }, { player: "p2" }),
      ev("5", "concede", "away"),
      ev("6", "endOfMatch", "home", {}, { ts: "2026-10-21T12:00:00.000Z" }),
    ];
    const rows = recentResults(inputs({
      tournaments: [{ id: "t1", name: "League", entrants: [], matches: [fixture("fx", 5, { homeScore: 1, awayScore: 0, reportedAt: "2026-10-01T00:00:00.000Z" })] as never }],
      tabletop: [
        { match: tabletopMatch("tm1", "published", { fixtureRef: "fx" }), events, race: { home: "Orc" } },
        { match: tabletopMatch("tm2", "submitted"), events: [ev("a", "touchdown", "away", {}, { player: "q" })] },
        { match: tabletopMatch("tm3", "recording"), events },
        { match: tabletopMatch("tm4", "confirmed", { test: true }), events },
      ] as never,
      teamInfo: (ref) => (ref === "s1" ? { name: "Saved Side", race: "Dwarf", crestUrl: "/api/team-avatars/x.png" } : undefined),
    }));
    expect(rows.map((r) => r.id)).toEqual(["tabletop:tm1", "tabletop:tm2"]);
    expect(rows[0]).toMatchObject({
      source: "tabletop", context: "Tabletop · League · Round 5", href: "/app/tabletop/tm1", playedAt: "2026-10-21T12:00:00.000Z", concede: "away",
      home: { name: "Night <Owls>", race: "Orc", coach: "Eve", score: 1, cas: 1 },
      away: { name: "Saved Side", race: "Dwarf", crestUrl: "/api/team-avatars/x.png", score: 0, cas: 0 },
    });
    expect(rows[1]).toMatchObject({ context: "Tabletop · Friendly", home: { score: 0 }, away: { score: 1 }, concede: null });
  });

  it("a fixture-linked fork game sorts by when it was played, not when the fixture was reported", () => {
    const launch = (gameId: string) => ({ launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, gameId } });
    const rows = recentResults(inputs({
      results: [forkRow("old", "2026-10-01T00:00:00.000Z"), forkRow("plain", "2026-10-28T00:00:00.000Z")] as never,
      tournaments: [{ id: "t1", name: "Cup", entrants: [], matches: [
        fixture("late", 1, { homeScore: 2, awayScore: 1, reportedAt: "2026-10-29T00:00:00.000Z" }, launch("old")),
        // no retained fork row: the report time stays the fallback
        fixture("solo", 2, { homeScore: 0, awayScore: 0, reportedAt: "2026-10-27T00:00:00.000Z" }, launch("missing")),
      ] as never }],
    }));
    expect(rows.map((r) => [r.id, r.playedAt])).toEqual([
      ["fork:plain", "2026-10-28T00:00:00.000Z"],
      ["tournament:solo", "2026-10-27T00:00:00.000Z"],
      ["tournament:late", "2026-10-01T00:00:00.000Z"],
    ]);
  });

  it("fork cards show the deciding (penalty) score when one was recorded", () => {
    const shootout = { ...forkTeam("h", 4, []), penaltyScore: 0 };
    const rows = recentResults(inputs({ results: [forkRow("pk", "2026-10-02T00:00:00.000Z", { teams: [shootout, { ...forkTeam("a", 1, []), penaltyScore: 2 }] })] as never }));
    expect(rows[0]).toMatchObject({ home: { score: 0 }, away: { score: 2 } });
  });
});
