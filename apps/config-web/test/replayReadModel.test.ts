import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gameDetail, replayReporter, type GameInputs } from "../src/gameDetail";
import { createGameDetailLoader, withoutPlayerLines } from "../src/gameDetailLoader";
import { deriveReplayMoments } from "../src/replay/moments";
import type { ReplayEntry } from "../src/replay/store";
import { ONLINE_NOTE, ONLINE_PENDING_NOTE, ONLINE_REPLAY_NOTE, ORDERED_LOG_TITLE, PENDING_LOG_TITLE, RESULT_LOG_TITLE, reporterModel } from "../spa/src/games/reporter";
import type { GameDetail } from "../spa/src/games/detail";

// GET /api/games/online/:id with the replay cache (src/gameDetail.ts replayReporter, src/gameDetailLoader.ts) and the
// game page's rendering of it (spa/src/games/reporter.ts): ordered online moments read like tabletop ones.

type Fx = { gameState: { teamHome: { teamId: string; playerArray: Array<{ playerId: string; playerName: string }> }; teamAway: { teamId: string; playerArray: Array<{ playerId: string; playerName: string }> } }; commands: unknown[] };
const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "replay-999.json"), "utf8")) as Fx;
const derived = deriveReplayMoments(fx.gameState, fx.commands);
const entry: ReplayEntry = { schema: 1, reader: 1, gameId: "999", status: "ready", readAt: "2026-10-30T15:00:00.000Z", commands: derived.commands, truncated: false, teams: derived.teams, moments: derived.moments };

const TD = new Set(["Jordell Freshbreeze", "Swiftvine Glimmershard"]);
const resultPlayers = (t: Fx["gameState"]["teamHome"], home: boolean) => t.playerArray.map((p) => ({
  playerId: p.playerId, name: p.playerName, touchdowns: home && TD.has(p.playerName) ? 1 : 0, casualtiesCaused: 0, blocks: 0, fouls: 0,
  completions: 0, interceptions: 0, deflections: 0, mvp: home && p.playerName === "Gnome Lineman 2" ? 2 : 0,
}));
/** The live 999 row's shape (results store), players in the fork's own order. */
const row999 = (over: Record<string, unknown> = {}) => ({
  gameId: "999", pulledAt: "2026-10-13T00:55:07.815Z", playedAt: "2026-09-29T11:39:17.000Z",
  home: { teamId: fx.gameState.teamHome.teamId, teamName: "UAT2 Woodland", coach: "Flutethecat" },
  away: { teamId: fx.gameState.teamAway.teamId, teamName: "UAt2 Nurgle", coach: "Gondra87" },
  teams: [
    { teamId: fx.gameState.teamHome.teamId, score: 2, winnings: 80_000, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 1, si: 0, rip: 0 }, players: resultPlayers(fx.gameState.teamHome, true) },
    { teamId: fx.gameState.teamAway.teamId, score: 0, winnings: 0, penaltyScore: -1, conceded: true, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: resultPlayers(fx.gameState.teamAway, false) },
  ],
  ...over,
});
const inputs = (over: Partial<GameInputs> = {}): GameInputs => ({ results: [row999()], tournaments: [], tabletop: [], ...over } as GameInputs);
const homeIndex = (name: string) => fx.gameState.teamHome.playerArray.findIndex((p) => p.playerName === name);
const awayIndex = (name: string) => fx.gameState.teamAway.playerArray.findIndex((p) => p.playerName === name);

describe("read model: online game + replay cache", () => {
  it("ready: reporter.moments in game order with half / turn / side, squad indexes resolved by player id, source replay", () => {
    const d = gameDetail("online", "999", inputs({ replay: { state: "ready", entry } }))!;
    expect(d.replay).toBe("ready");
    expect(d.reporter).toMatchObject({ matchId: "999", source: "replay", summaries: null, href: "/app/games/online/999" });
    expect(d.reporter!.moments.map((m) => [m.half, m.turn, m.side, m.kind])).toEqual([
      [null, null, null, "weather"], [1, null, null, "halfStart"], [1, null, null, "kickoff"], [1, 1, "away", "casualty"],
      [1, 5, "away", "concession"], [1, 5, "home", "touchdown"], [1, 5, "home", "touchdown"],
    ]);
    expect(d.reporter!.moments[3]).toEqual({
      half: 1, turn: 1, side: "away", kind: "casualty", text: "Casualty: Grashnak Blackhoof on Gnome Lineman 1 (Badly Hurt)",
      player: "Grashnak Blackhoof", playerIndex: awayIndex("Grashnak Blackhoof"), victimSide: "home", victim: "Gnome Lineman 1", victimIndex: homeIndex("Gnome Lineman 1"), result: "Badly Hurt",
    });
    expect(d.reporter!.moments[5]).toMatchObject({ player: "Swiftvine Glimmershard", playerIndex: homeIndex("Swiftvine Glimmershard"), awarded: true });
    expect(d.reporter!.moments[4]).toMatchObject({ legal: false });
    // the summary still comes from the result (unchanged)
    expect(d.summary.home!.scorers.map((s) => s.name).sort()).toEqual(["Jordell Freshbreeze", "Swiftvine Glimmershard"]);
  });

  it("pending / unavailable: no reporter; a cached unavailable answer reads unavailable; no replay input reads unavailable", () => {
    expect(gameDetail("online", "999", inputs({ replay: { state: "pending" } }))).toMatchObject({ replay: "pending" });
    expect(gameDetail("online", "999", inputs({ replay: { state: "pending" } }))).not.toHaveProperty("reporter");
    const gone: ReplayEntry = { schema: 1, reader: 1, gameId: "999", status: "unavailable", readAt: "t", reason: "Replay Unavailable" };
    expect(gameDetail("online", "999", inputs({ replay: { state: "unavailable", entry: gone } }))).toMatchObject({ replay: "unavailable" });
    expect(gameDetail("online", "999", inputs())!.replay).toBe("unavailable");
  });

  it("sides follow the result row: a replay with the teams swapped flips every side; one naming other teams is not used", () => {
    const swapped = row999({ home: row999().away, away: row999().home });
    const r = replayReporter(swapped as never, entry)!;
    expect(r.moments[3]).toMatchObject({ side: "home", victimSide: "away", playerIndex: awayIndex("Grashnak Blackhoof") });
    expect(r.moments[0]!.side).toBeNull();
    expect(replayReporter(row999({ home: { teamId: "other", teamName: "x", coach: "y" } }) as never, entry)).toBeUndefined();
    expect(gameDetail("online", "999", inputs({ results: [row999({ home: { teamId: "other", teamName: "x", coach: "y" } })] as never, replay: { state: "ready", entry } }))!.replay).toBe("unavailable");
  });

  it("a name the result spells differently wins; a player the result does not list keeps the replay's name and no index", () => {
    const renamed = row999();
    const home = (renamed.teams[0] as { players: Array<{ playerId: string; name: string }> }).players;
    home.find((p) => p.name === "Jordell Freshbreeze")!.name = "Jordell F.";
    (renamed.teams[1] as { players: unknown[] }).players = [];
    const r = replayReporter(renamed as never, entry)!;
    expect(r.moments[6]).toMatchObject({ player: "Jordell F.", text: "Touchdown awarded: Jordell F." });
    expect(r.moments[3]).toMatchObject({ player: "Grashnak Blackhoof" });
    expect(r.moments[3]).not.toHaveProperty("playerIndex");
  });

  it("loader: the replay store rides in for online games; the private-lines redaction names teams, keeps game-wide moments", async () => {
    const loader = createGameDetailLoader({
      revision: () => "r", fixture: () => undefined, fixtureForGame: () => undefined,
      result: (id) => (id === "999" ? (row999() as never) : undefined), tabletop: async () => undefined,
      replay: (id) => (id === "999" ? { state: "ready", entry } : { state: "pending" }),
    });
    const full = (await loader.load("online", "999"))!.detail;
    expect(full.reporter!.moments).toHaveLength(7);
    const red = withoutPlayerLines(full);
    expect(red.reporter!.moments.map((m) => m.text)).toEqual([
      "Weather: Nice Weather (2 + 3)", "Start of half 1", "Kick-off: Brilliant Coaching (4 + 3)",
      "Casualty caused: UAt2 Nurgle", "Concession: UAt2 Nurgle", "Touchdown: UAT2 Woodland", "Touchdown: UAT2 Woodland",
    ]);
    const json = JSON.stringify(red.reporter);
    for (const name of ["Grashnak", "Gnome Lineman 1", "Swiftvine", "Jordell", "Badly Hurt"]) expect(json).not.toContain(name);
    expect(red.reporter!.moments[3]).not.toHaveProperty("playerIndex");
  });
});

describe("game page: ordered online moments", () => {
  const online = (over: Partial<GameInputs> = {}) => gameDetail("online", "999", inputs(over)) as unknown as GameDetail;

  it("ready: ordered like a tabletop log (H1 T1 ...), heading 'Match log', centre rows for weather / half / kick-off, post-game rows after", () => {
    const m = reporterModel(online({ replay: { state: "ready", entry } }));
    expect(m.ordered).toBe(true);
    expect(m.logTitle).toBe(ORDERED_LOG_TITLE);
    expect(m.sourceNote).toBe(ONLINE_REPLAY_NOTE);
    // the feed is newest first: read it top-down in play order
    const rows = [...m.rows].reverse().filter((r) => r.part === "main");
    expect(rows.map((r) => [r.type, r.when, r.side])).toEqual([
      ["weather", "", "centre"], ["halfStart", "H1", "centre"], ["kickoff", "H1", "centre"], ["casualty", "H1 T1", "away"],
      ["concede", "H1 T5", "away"], ["touchdown", "H1 T5", "home"], ["touchdown", "H1 T5", "home"],
      ["mvp", "", "home"], ["winnings", "", "centre"],
    ]);
    expect(rows[0]).toMatchObject({ lead: "Weather", rest: ": Nice Weather (2 + 3)" });
    expect(rows[1]).toMatchObject({ lead: "Start of half 1", rest: "." });
    expect(rows[2]).toMatchObject({ lead: "Kick-off", rest: ": Brilliant Coaching (4 + 3)" });
    expect(rows[3]).toMatchObject({ player: "Grashnak Blackhoof", sub: "Badly Hurt on Gnome Lineman 1" });
    expect(rows[4]).toMatchObject({ lead: "UAt2 Nurgle", rest: " concedes the match (not a legal concession)." });
    expect(rows[5]).toMatchObject({ player: "Swiftvine Glimmershard", rest: "scores a touchdown!" });
    // the casualty's victim line, directly beneath it
    const victim = [...m.rows].reverse().find((r) => r.part === "victim")!;
    expect(victim).toMatchObject({ team: "home", player: "Gnome Lineman 1", rest: "is Badly Hurt." });
    // one concession row only (the replay's, with its turn)
    expect(m.rows.filter((r) => r.type === "concede")).toHaveLength(1);
  });

  it("pending: the result's grouped rows under 'turn order loading…'; unavailable: today's heading", () => {
    const pending = reporterModel(online({ replay: { state: "pending" } }));
    expect(pending.ordered).toBe(false);
    expect(pending.logTitle).toBe(PENDING_LOG_TITLE);
    expect(pending.sourceNote).toBe(ONLINE_PENDING_NOTE);
    expect(pending.rows.every((r) => r.when === "")).toBe(true);
    const gone = reporterModel(online({ replay: { state: "unavailable" } }));
    expect(gone.logTitle).toBe(RESULT_LOG_TITLE);
    expect(gone.sourceNote).toBe(ONLINE_NOTE);
  });

  it("redacted ready game: ordered team-level rows, no player names", () => {
    const red = withoutPlayerLines(gameDetail("online", "999", inputs({ replay: { state: "ready", entry } }))!) as unknown as GameDetail;
    const m = reporterModel(red);
    expect(m.ordered).toBe(true);
    const rows = [...m.rows].reverse().filter((r) => r.part === "main");
    expect(rows.find((r) => r.type === "casualty")).toMatchObject({ when: "H1 T1", lead: "UAt2 Nurgle", rest: " causes a casualty!", player: "" });
    expect(m.rows.some((r) => r.part === "victim")).toBe(false);
  });
});
