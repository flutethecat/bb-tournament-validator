import { describe, expect, it } from "vitest";
import { gameDetail, parseGamePath, PER_PLAYER_NOTE, type GameInputs } from "../src/gameDetail";

// GET /api/games/:source/:id (src/gameDetail.ts): one played game per source, the hero card built by the Past Games
// normaliser, per-player lines when the source has them, the match reporter for tabletop matches, 404s for the rest.

const pl = (name: string, over: Record<string, number> = {}) => ({
  playerId: name, name, touchdowns: 0, casualtiesCaused: 0, blocks: 0, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, ...over,
});
const forkTeam = (teamId: string, score: number, players: ReturnType<typeof pl>[], conceded = false) => ({
  teamId, score, winnings: 0, penaltyScore: -1, conceded, casualtiesSuffered: { bh: 1, si: 0, rip: 0 }, players,
});
const forkRow = (gameId: string, extra: Record<string, unknown> = {}) => ({
  gameId, pulledAt: "2026-10-01T00:00:00.000Z", playedAt: "2026-10-02T09:00:00.000Z",
  home: { teamId: "h", teamName: "Reavers", coach: "Alice" },
  away: { teamId: "a", teamName: "Grinders", coach: "Bob" },
  teams: [
    forkTeam("h", 2, [pl("Grak", { touchdowns: 2, mvp: 1 }), pl("Bonk", { casualtiesCaused: 1 }), pl("Idle")]),
    forkTeam("a", 1, [pl("Snik", { touchdowns: 1, casualtiesCaused: 2 })]),
  ],
  ...extra,
});
const coach = (id: string) => ({ coachId: id, ffbCoachId: id, verifiedAt: "x" });
const launch = (gameId?: string) => ({ challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, ...(gameId ? { gameId } : {}) });
const fixture = (id: string, result: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  id, tournamentId: "t1", roundId: "r2", roundNumber: 2, status: "completed", revision: 1,
  home: { entrantId: "e1", coach: coach("Carol"), teamId: "tc" },
  away: { entrantId: "e2", coach: coach("Dan"), teamId: "td" },
  launch: launch(), ...(result ? { result } : {}), createdAt: "x", updatedAt: "2026-09-01T00:00:00.000Z", ...extra,
});
const entrant = (id: string, teamName: string, race: string) => ({ id, tournamentId: "t1", seed: 1, coach: coach(id), teamId: `t-${id}`, registeredAt: "x", submission: { teamName, race } });
const tabletopMatch = (id: string, state: string, extra: Record<string, unknown> = {}) => ({
  id, state, home: { coach: "Eve", teamSaveId: "library:9", teamName: "Night Owls" }, away: { coach: "Finn", teamSaveId: "s1", teamName: "Rats" },
  postMatch: "spp-only", createdBy: "Eve", createdAt: "x", updatedAt: "2026-10-20T00:00:00.000Z", confirmations: {}, baseRevision: { home: 0, away: 0 }, ...extra,
});
const ev = (id: string, type: string, team: "home" | "away", payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ id, matchId: "m", type, team, payload, by: "Eve", ts: "2026-10-21T10:00:00.000Z", ...extra });
const line = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, touchdowns: 0, casualtiesCaused: 0, completions: 0, throwTeamMateCompletions: 0, landings: 0, catches: 0, fouls: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 0, ...over,
});
const summary = (team: "home" | "away", score: [number, number], players: ReturnType<typeof line>[]) => ({
  ruleset: "bb2025", postMatch: "spp-only", team, applied: true, score: { for: score[0], against: score[1] },
  outcome: score[0] > score[1] ? "won" : score[0] < score[1] ? "lost" : "drawn", players, deaths: [], winnings: 0,
  treasuryBefore: 120_000, treasuryAfter: 140_000, fansBefore: 3, fansAfter: 3, casualtiesSuffered: { bh: 0, si: team === "away" ? 1 : 0, rip: 0 },
});
const playedEvents = [
  ev("1", "touchdown", "home", {}, { player: "p1", half: 1, turn: 3 }),
  ev("2", "touchdown", "away", {}, { player: "q1", half: 1, turn: 5 }),
  ev("3", "undo", "away", { target: "2" }),
  ev("4", "casualty", "home", { victim: "q2", result: "SI", cause: "block" }, { player: "p2", half: 2, turn: 2 }),
  ev("5", "mvp", "home", {}, { player: "p1" }),
  ev("6", "endOfMatch", "home", {}, { ts: "2026-10-21T12:00:00.000Z" }),
];
const preview = {
  home: summary("home", [1, 0], [line("p1", "Grim", { touchdowns: 1, mvp: 1, sppEarned: 7 }), line("p2", "Basher", { casualtiesCaused: 1, sppEarned: 2 })]),
  away: summary("away", [0, 1], [line("q2", "Squeak", { injury: { result: "SI", apothecaryUsed: false } })]),
};

function inputs(over: Partial<GameInputs> = {}): GameInputs {
  return { results: [], tournaments: [], tabletop: [], ...over } as GameInputs;
}

describe("game path", () => {
  it("parses the three sources, decodes the id, refuses anything else", () => {
    expect(parseGamePath("/api/games/online/123")).toEqual({ source: "online", id: "123" });
    expect(parseGamePath("/api/games/tabletop/tm-1")).toEqual({ source: "tabletop", id: "tm-1" });
    expect(parseGamePath("/api/games/tournament/m%3A1")).toEqual({ source: "tournament", id: "m:1" });
    expect(parseGamePath("/api/games/fork/123")).toBeUndefined();
    expect(parseGamePath("/api/games/online/a%2Fb")).toBeUndefined();
    expect(parseGamePath("/api/games/online/%E0%A4%A")).toBeUndefined();
    expect(parseGamePath("/api/games/online/")).toBeUndefined();
    expect(parseGamePath("/api/games/online/1/2")).toBeUndefined();
  });
});

describe("game detail", () => {
  it("online: the stored fork result's card, scorers, casualty-makers, MVPs and per-player lines", () => {
    const d = gameDetail("online", "g1", inputs({ results: [forkRow("g1"), forkRow("tx", { test: true })] as never, forkMeta: () => ({ packageName: "BB2025" }) }));
    expect(d).toBeDefined();
    expect(d!.card).toMatchObject({ context: "Online · BB2025", href: null, playedAt: "2026-10-02T09:00:00.000Z", home: { name: "Reavers", score: 2, cas: 1 }, away: { name: "Grinders", score: 1, cas: 2 } });
    expect(d!.summary).toMatchObject({ perPlayer: true, note: null, tournament: null, round: null, casualties: { home: 1, away: 2 } });
    expect(d!.summary.home).toMatchObject({ mvps: ["Grak"], scorers: [{ name: "Grak", count: 2 }], casualtyMakers: [{ name: "Bonk", count: 1 }], casualtiesSuffered: { bh: 1, si: 0, rip: 0 } });
    expect(d!.summary.home!.players.map((p) => p.name)).toEqual(["Grak", "Bonk"]); // "Idle" has no line
    expect(d!.summary.away).toMatchObject({ scorers: [{ name: "Snik", count: 1 }], casualtyMakers: [{ name: "Snik", count: 2 }] });
    expect(d!.reporter).toBeUndefined();
  });

  it("online: test, tabletop and unknown rows are 404; a fixture-launched game names its tournament", () => {
    const rows = [forkRow("tx", { test: true }), forkRow("tt", { source: "tabletop" }), forkRow("g7")] as never;
    expect(gameDetail("online", "tx", inputs({ results: rows }))).toBeUndefined();
    expect(gameDetail("online", "tt", inputs({ results: rows }))).toBeUndefined();
    expect(gameDetail("online", "nope", inputs({ results: rows }))).toBeUndefined();
    const d = gameDetail("online", "g7", inputs({
      results: rows,
      tournaments: [{ id: "t1", name: "Cup", entrants: [], matches: [fixture("f7", { homeScore: 2, awayScore: 1, reportedAt: "2026-10-03T00:00:00.000Z" }, { launch: launch("g7") })] as never }],
    }));
    expect(d!.summary).toMatchObject({ round: 2, tournament: { id: "t1", name: "Cup", href: "/app/tournaments/t1?tab=rounds" } });
  });

  it("online: a league fixture's banked legal-concession verdict names the conceding side's concession; none is never guessed", () => {
    const conceded = forkRow("g8", { teams: [forkTeam("h", 2, [pl("Grak")]), forkTeam("a", 0, [pl("Snik")], true)] });
    const plain = gameDetail("online", "g8", inputs({ results: [conceded] as never }))!;
    expect(plain.summary.concede).toBe("away");
    expect(plain.summary).not.toHaveProperty("concededLegally");
    expect(gameDetail("online", "g8", inputs({ results: [conceded] as never, concededLegally: { a: false } }))!.summary.concededLegally).toBe(false);
    expect(gameDetail("online", "g8", inputs({ results: [conceded] as never, concededLegally: { a: true } }))!.summary.concededLegally).toBe(true);
    // A verdict for the other team does not describe this concession.
    expect(gameDetail("online", "g8", inputs({ results: [conceded] as never, concededLegally: { h: true } }))!.summary).not.toHaveProperty("concededLegally");
  });

  it("tournament: a reported fixture's card links nothing, points at the Rounds tab, and says per-player stats are missing", () => {
    const d = gameDetail("tournament", "m1", inputs({
      tournaments: [{
        id: "t1", name: "Spike Beta Test",
        entrants: [entrant("e1", "Carol's Crushers", "Orc"), entrant("e2", "Dan's Darlings", "Wood Elf")] as never,
        matches: [fixture("m1", { homeScore: 0, awayScore: 4, homeCasualties: 1, reportedAt: "2026-10-10T00:00:00.000Z" }), fixture("m2", undefined)] as never,
      }],
    }));
    expect(d!.card).toMatchObject({ context: "Spike Beta Test · Round 2", href: null, home: { name: "Carol's Crushers", race: "Orc", score: 0, cas: 1 }, away: { name: "Dan's Darlings", score: 4, cas: null } });
    expect(d!.summary).toMatchObject({
      competition: "Spike Beta Test · Round 2", round: 2, tournament: { id: "t1", href: "/app/tournaments/t1?tab=rounds" },
      perPlayer: false, note: PER_PLAYER_NOTE, home: null, away: null, casualties: { home: 1, away: null },
    });
    expect(gameDetail("tournament", "m2", inputs({ tournaments: [{ id: "t1", name: "x", entrants: [], matches: [fixture("m2", undefined)] as never }] }))).toBeUndefined();
    expect(gameDetail("tournament", "zzz", inputs())).toBeUndefined();
  });

  it("tournament: the launched fork game lends per-player lines; a recorded tabletop match lends its reporter", () => {
    const t = (m: unknown) => [{ id: "t1", name: "Cup", entrants: [], matches: [m] as never }];
    const fork = gameDetail("tournament", "m1", inputs({
      tournaments: t(fixture("m1", { homeScore: 2, awayScore: 1, reportedAt: "2026-10-10T00:00:00.000Z" }, { launch: launch("g1") })),
      results: [forkRow("g1")] as never,
    }));
    expect(fork!.card.playedAt).toBe("2026-10-02T09:00:00.000Z");
    expect(fork!.summary).toMatchObject({ perPlayer: true, home: { scorers: [{ name: "Grak", count: 2 }] } });
    const tt = gameDetail("tournament", "m1", inputs({
      tournaments: t(fixture("m1", { homeScore: 1, awayScore: 0, reportedAt: "2026-10-22T00:00:00.000Z" })),
      tabletop: [{ match: tabletopMatch("tm1", "published", { fixtureRef: "m1", preview }), events: playedEvents }] as never,
    }));
    expect(tt!.reporter).toMatchObject({ matchId: "tm1", href: "/app/tabletop/tm1" });
    expect(tt!.summary.home).toMatchObject({ scorers: [{ name: "Grim", count: 1 }], mvps: ["Grim"] });
  });

  it("tournament: a tabletop match recorded with the coaches swapped reads in fixture order (summary, reporter, moments)", () => {
    // Fixture: Carol (home) vs Dan (away), Dan won 1-0. The tabletop match lists Dan's team as its home side.
    const d = gameDetail("tournament", "m1", inputs({
      tournaments: [{ id: "t1", name: "Cup", entrants: [entrant("e1", "Carol's Crushers", "Orc"), entrant("e2", "Dan's Darlings", "Wood Elf")] as never,
        matches: [fixture("m1", { homeScore: 0, awayScore: 1, reportedAt: "2026-10-22T00:00:00.000Z" })] as never }],
      tabletop: [{
        match: tabletopMatch("tm1", "published", { fixtureRef: "m1", fixtureSwap: true, preview,
          home: { coach: "Dan", teamSaveId: "s2", teamName: "Dan's Darlings" }, away: { coach: "Carol", teamSaveId: "s3", teamName: "Carol's Crushers" } }),
        events: playedEvents,
      }] as never,
    }));
    expect(d!.card).toMatchObject({ home: { name: "Carol's Crushers", score: 0 }, away: { name: "Dan's Darlings", score: 1 } });
    // fixture home (Carol) lost: its summary and report are the recorder's AWAY side
    expect(d!.summary.home).toMatchObject({ scorers: [], mvps: [] });
    expect(d!.summary.away).toMatchObject({ scorers: [{ name: "Grim", count: 1 }], mvps: ["Grim"] });
    expect(d!.reporter!.summaries!.home).toMatchObject({ outcome: "lost", score: { for: 0, against: 1 } });
    expect(d!.reporter!.summaries!.away).toMatchObject({ outcome: "won", score: { for: 1, against: 0 } });
    expect(d!.reporter!.moments.map((m) => [m.side, m.text])).toEqual([["away", "Touchdown: Grim"], ["away", "Casualty: Basher on Squeak (SI)"]]);
  });

  it("tabletop: the reporter's finished-game summary (no treasury), key moments in order, scorers and casualties", () => {
    const d = gameDetail("tabletop", "tm1", inputs({
      tabletop: [{ match: tabletopMatch("tm1", "confirmed", { preview }), events: playedEvents, race: { home: "Orc" } }] as never,
    }));
    expect(d!.card).toMatchObject({ context: "Tabletop · Friendly", href: null, playedAt: "2026-10-21T12:00:00.000Z", home: { name: "Night Owls", race: "Orc", score: 1, cas: 1 }, away: { name: "Rats", score: 0, cas: 0 } });
    expect(d!.summary).toMatchObject({ perPlayer: true, note: null });
    expect(d!.summary.home).toMatchObject({ mvps: ["Grim"], scorers: [{ name: "Grim", count: 1 }], casualtyMakers: [{ name: "Basher", count: 1 }] });
    expect(d!.summary.away!.players).toEqual([expect.objectContaining({ name: "Squeak", injury: "SI" })]);
    expect(d!.summary.away!.casualtiesSuffered).toEqual({ bh: 0, si: 1, rip: 0 });
    expect(d!.reporter).toMatchObject({ matchId: "tm1", href: "/app/tabletop/tm1", state: "confirmed" });
    expect(d!.reporter!.summaries!.home).toMatchObject({ outcome: "won", score: { for: 1, against: 0 }, applied: true });
    expect(d!.reporter!.summaries!.home).not.toHaveProperty("treasuryBefore");
    expect(d!.reporter!.summaries!.home).not.toHaveProperty("treasuryAfter");
    expect(d!.reporter!.moments).toEqual([
      { half: 1, turn: 3, side: "home", kind: "touchdown", text: "Touchdown: Grim", player: "Grim", playerIndex: 0 },
      { half: 2, turn: 2, side: "home", kind: "casualty", text: "Casualty: Basher on Squeak (SI)", player: "Basher", playerIndex: 1, victim: "Squeak", victimIndex: 0, victimSide: "away", result: "SI" },
    ]);
  });

  it("online: the reporter's read model: every listed player (squad), fouls, winnings; no SPP, injury or position without a league digest", () => {
    const d = gameDetail("online", "g1", inputs({ results: [forkRow("g1")] as never }));
    const home = d!.summary.home!;
    expect(home.squad!.map((p) => p.name)).toEqual(["Grak", "Bonk", "Idle"]);
    expect(home.squad![2]).toEqual({ name: "Idle", touchdowns: 0, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, fouls: 0, index: 2 });
    expect(home.winnings).toBe(0);
    expect(home).not.toHaveProperty("fanFactor");
    expect(home.players.every((p) => p.sppEarned === undefined && p.injury === undefined && p.position === undefined && p.missNextGame === undefined)).toBe(true);
  });

  it("online: a league digest adds positions, the banked SPP, the server's injury text (MNG only when it says so), fan factor and fans change", () => {
    const leagueGame = {
      source: "full" as const,
      teams: {
        h: { winnings: 60_000, fanFactor: 4, dedicatedFansModifier: 1, players: { Grak: { position: "Blitzer", spp: 7 }, Idle: { position: "Lineman", spp: 0, injuries: ["Seriously Hurt (MNG)"] } } },
        a: { players: { Snik: { position: "Gutter Runner", spp: 3, injuries: ["Dead (RIP)"] } } },
      },
    };
    const d = gameDetail("online", "g1", inputs({ results: [forkRow("g1")] as never, leagueGame }));
    const home = d!.summary.home!;
    expect(home).toMatchObject({ winnings: 0, fanFactor: 4, dedicatedFansModifier: 1 }); // winnings stay the results store's own number
    expect(home.squad!.find((p) => p.name === "Grak")).toMatchObject({ position: "Blitzer", sppEarned: 7 });
    expect(home.squad!.find((p) => p.name === "Idle")).toMatchObject({ position: "Lineman", injury: "Seriously Hurt (MNG)", missNextGame: true });
    expect(home.players.map((p) => p.name)).toContain("Idle"); // an injury is a line
    const snik = d!.summary.away!.squad!.find((p) => p.name === "Snik")!;
    expect(snik).toMatchObject({ injury: "Dead (RIP)", sppEarned: 3 });
    expect(snik).not.toHaveProperty("missNextGame");
    // public-safe: nothing private rides along
    const json = JSON.stringify(d);
    for (const k of ["treasury", "email", "password", "teamValue", "forkTeamValueDiff", "coachId"]) expect(json).not.toContain(k);
  });

  it("tabletop: a match without a preview still gets lines from the tally; test, recording and unknown matches are 404", () => {
    const d = gameDetail("tabletop", "tm2", inputs({ tabletop: [{ match: tabletopMatch("tm2", "submitted"), events: playedEvents }] as never }));
    expect(d!.reporter!.summaries).toBeNull();
    expect(d!.summary.home!.scorers).toEqual([{ name: "p1", count: 1 }]);
    const rows = [
      { match: tabletopMatch("test", "published", { test: true, preview }), events: playedEvents },
      { match: tabletopMatch("live", "recording"), events: playedEvents },
    ] as never;
    expect(gameDetail("tabletop", "test", inputs({ tabletop: rows }))).toBeUndefined();
    expect(gameDetail("tabletop", "live", inputs({ tabletop: rows }))).toBeUndefined();
    expect(gameDetail("tabletop", "nope", inputs({ tabletop: rows }))).toBeUndefined();
  });
});
