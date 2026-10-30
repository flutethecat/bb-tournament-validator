import { describe, expect, it } from "vitest";
import { NO_LOG_NOTE, ORDERED_LOG_TITLE, RESULT_LOG_TITLE, reporterModel } from "../spa/src/games/reporter";
import type { GameDetail } from "../spa/src/games/detail";

// The game page's completed match reporter (spa/src/games/reporter.ts): GameDetail -> the recorder's MatchView / TeamView /
// ServerTally / RecordedEvent shapes and feed rows. Server-derived only: no turn or half for a fork result, no invented
// SPP, victims or numbers.

const pline = (name: string, over: Record<string, unknown> = {}) => ({ name, touchdowns: 0, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, fouls: 0, ...over });
const team = (over: Record<string, unknown> = {}) => ({ mvps: [], scorers: [], casualtyMakers: [], players: [], casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, ...over });

/** The live /api/games/online/999 answer (10-30), with the read model's new squad / fouls / winnings fields. */
const online999 = (): GameDetail => {
  const lineman = pline("Gnome Lineman 2", { mvp: 2 });
  const jordell = pline("Jordell Freshbreeze", { touchdowns: 1 });
  const swift = pline("Swiftvine Glimmershard", { touchdowns: 1 });
  const idle = pline("Gnome Lineman 5");
  return {
    source: "online", id: "999",
    card: {
      context: "Online · Friendly", playedAt: "2026-10-13T00:55:07.815Z", href: null, concede: "away", suspended: false,
      home: { name: "UAT2 Woodland", race: "Gnome", coach: "Flutethecat", crestUrl: "/crests/gnome.png", score: 2, cas: 0 },
      away: { name: "UAt2 Nurgle", race: "Nurgle", coach: "Gondra87", crestUrl: null, score: 0, cas: 0 },
    },
    summary: {
      playedAt: "2026-10-13T00:55:07.815Z", competition: "Online · Friendly", round: null, tournament: null,
      casualties: { home: 0, away: 0 }, concede: "away", perPlayer: true, note: null,
      home: team({
        mvps: ["Gnome Lineman 2"], scorers: [{ name: "Jordell Freshbreeze", count: 1 }, { name: "Swiftvine Glimmershard", count: 1 }],
        players: [lineman, jordell, swift], squad: [lineman, jordell, swift, idle], casualtiesSuffered: { bh: 1, si: 0, rip: 0 }, winnings: 40_000,
      }),
      away: team({ squad: [pline("Rotter 1")], winnings: 20_000 }),
    },
  } as GameDetail;
};

describe("completed match reporter: online (fork result)", () => {
  it("a 999-like game: final board, both rosters, a result-only log (2 TDs, MVP, concession, 1 BH suffered) with no turn or half", () => {
    const m = reporterModel(online999());
    expect(m.match).toMatchObject({ home: { teamName: "UAT2 Woodland", coach: "Flutethecat" }, away: { teamName: "UAt2 Nurgle", coach: "Gondra87" } });
    expect(m.final).toEqual({ score: { home: 2, away: 0 }, cas: { home: 0, away: 0 }, fouls: { home: 0, away: 0 }, concede: "away" });
    expect(m.teams.home).toMatchObject({ name: "UAT2 Woodland", race: "Gnome", avatarUrl: "/crests/gnome.png" });
    expect(m.teams.away).not.toHaveProperty("avatarUrl");
    expect(m.teams.home.players.map((p) => p.name)).toEqual(["Gnome Lineman 2", "Jordell Freshbreeze", "Swiftvine Glimmershard", "Gnome Lineman 5"]);
    expect(m.teams.home.players.every((p) => p.spp === 0 && !p.dead && !p.mng)).toBe(true);
    expect(m.ordered).toBe(false);
    expect(m.logTitle).toBe(RESULT_LOG_TITLE);
    expect(m.hasLog).toBe(true);
    // reading order top-down: touchdowns, casualties suffered, MVP, concession, winnings
    const shown = m.rows.filter((r) => r.part === "main");
    expect(shown.map((r) => r.type)).toEqual(["touchdown", "touchdown", "casualtiesSuffered", "mvp", "concede", "winnings", "winnings"]);
    expect(shown.every((r) => r.when === "" && r.half === 0 && r.turn === 0 && r.clock === "")).toBe(true);
    expect(shown[0]).toMatchObject({ team: "home", player: "Jordell Freshbreeze", rest: "scores a touchdown!", stars: 0 });
    expect(shown[2]).toMatchObject({ team: "home", lead: "UAT2 Woodland", rest: " suffered 1 Badly Hurt." });
    expect(shown[3]).toMatchObject({ player: "Gnome Lineman 2", rest: "is the MVP (2 awards)." });
    expect(shown[4]).toMatchObject({ team: "away", lead: "UAt2 Nurgle", rest: " concedes the match." });
    expect(shown[5]).toMatchObject({ lead: "UAT2 Woodland", rest: " earns 40k in winnings." });
    expect(m.finalLine).toBe("Final: UAT2 Woodland 2-0 UAt2 Nurgle · UAt2 Nurgle conceded");
    // the finished-game summaries: outcome and lines, no SPP (the fork result has none), no treasury or fans
    expect(m.summaries.map((s) => s.heading)).toEqual(["Home: UAT2 Woodland (Flutethecat)", "Away: UAt2 Nurgle (Gondra87)"]);
    expect(m.summaries[0]!.summary).toMatchObject({ outcome: "won", score: { for: 2, against: 0 }, winnings: 40_000, deaths: [] });
    expect(m.summaries[0]!.summary.players.every((l) => l.sppEarned === undefined)).toBe(true);
    expect(m.summaries[0]!.summary).not.toHaveProperty("applied");
    expect(m.summaries[1]!.summary).toMatchObject({ outcome: "lost", score: { for: 0, against: 2 }, players: [] });
  });

  it("casualties caused name no victim; a league digest's injuries, positions, SPP and fans flow through; the legal verdict is said", () => {
    const g = online999();
    g.summary.concededLegally = false;
    g.summary.away = team({
      squad: [pline("Rotter 1", { casualtiesCaused: 1, position: "Rotter", sppEarned: 2 }), pline("Bloater", { position: "Bloater", injury: "Dead (RIP)" }), pline("Pestigor", { injury: "Seriously Hurt (MNG)", missNextGame: true })],
      players: [pline("Rotter 1", { casualtiesCaused: 1, position: "Rotter", sppEarned: 2 }), pline("Bloater", { position: "Bloater", injury: "Dead (RIP)" }), pline("Pestigor", { injury: "Seriously Hurt (MNG)", missNextGame: true })],
      fanFactor: 3, dedicatedFansModifier: -1,
    }) as never;
    const m = reporterModel(g);
    const cas = m.rows.filter((r) => r.type === "casualty");
    expect(cas.map((r) => r.part)).toEqual(["main"]); // no victim line: the result does not say who was hurt by whom
    expect(cas[0]).toMatchObject({ player: "Rotter 1", position: "Rotter", rest: "causes a casualty!" });
    const inj = m.rows.filter((r) => r.type === "injury");
    expect(inj.map((r) => [r.player, r.rest])).toEqual([["Bloater", "is Dead."], ["Pestigor", "is injured: Seriously Hurt (MNG)."]]);
    expect(m.rows.find((r) => r.type === "concede")!.rest).toBe(" concedes the match (not a legal concession).");
    expect(m.rows.find((r) => r.type === "fanChange")!.rest).toBe(" fan change -1.");
    const away = m.teams.away.players;
    expect(away.find((p) => p.name === "Bloater")).toMatchObject({ dead: true, position: "Bloater", injuries: ["Dead (RIP)"] });
    expect(away.find((p) => p.name === "Pestigor")).toMatchObject({ mng: true, dead: false });
    const sum = m.summaries[1]!.summary;
    expect(sum).toMatchObject({ fanFactor: 3, fansChange: -1, deaths: ["Bloater"] });
    expect(sum.players.find((l) => l.name === "Rotter 1")).toMatchObject({ sppEarned: 2, position: "Rotter" });
    expect(m.tally.players.away.find((l) => l.name === "Rotter 1")!.sppEarned).toBe(2);
  });

  it("player lines withheld: MVP names still log, no scorers or squads are invented", () => {
    const g = online999();
    g.summary = { ...g.summary, perPlayer: false, note: "Player stats for this game are shown to the coaches who played it and to organisers.", home: team({ mvps: ["Gnome Lineman 2"] }) as never, away: team() as never };
    const m = reporterModel(g);
    expect(m.rows.filter((r) => r.part === "main").map((r) => r.type)).toEqual(["mvp", "concede"]);
    expect(m.summaries).toEqual([]);
    expect(m.final.fouls).toBeNull();
  });
});

describe("completed match reporter: same-named players", () => {
  it("rows follow the server's squad index; without one, an ambiguous name gets a name-only row, never a guessed position", () => {
    const g = online999();
    const blitzer = pline("Twin", { position: "Blitzer", touchdowns: 1, index: 0 });
    const lineman = pline("Twin", { position: "Lineman", index: 1 });
    g.summary.home = team({ players: [blitzer], squad: [blitzer, lineman], mvps: ["Twin"] }) as never;
    const m = reporterModel(g);
    const td = m.rows.find((r) => r.type === "touchdown")!;
    expect(td).toMatchObject({ player: "Twin", position: "Blitzer" });
    expect(m.teams.home.players.map((p) => p.position)).toEqual(["Blitzer", "Lineman"]);
    // the same game with player lines withheld: only the MVP name is known, and two players wear it
    g.summary = { ...g.summary, perPlayer: false, home: team({ squad: [{ ...blitzer, index: undefined }, { ...lineman, index: undefined }], mvps: ["Twin"] }) as never };
    const red = reporterModel(g);
    const mvp = red.rows.find((r) => r.type === "mvp")!;
    expect(mvp).toMatchObject({ player: "Twin", position: "" });
    expect(red.teams.home.players).toHaveLength(2); // the stand-in is not listed in the Rosters popout
  });

  it("tabletop moments carry squad indexes for actor and victim", () => {
    const g = online999();
    g.source = "tabletop";
    const a = pline("Twin", { position: "Blitzer", index: 0 });
    const b = pline("Twin", { position: "Lineman", casualtiesCaused: 1, index: 1 });
    g.summary.home = team({ players: [b], squad: [a, b] }) as never;
    g.summary.away = team({ players: [], squad: [pline("Squeak", { index: 0 })] }) as never;
    g.reporter = { matchId: "x", href: "/app/tabletop/x", state: "confirmed", summaries: null,
      moments: [{ half: 1, turn: 2, side: "home", kind: "casualty", text: "", player: "Twin", playerIndex: 1, victim: "Squeak", victimIndex: 0, victimSide: "away", result: "BH" }] };
    const m = reporterModel(g);
    expect(m.rows.find((r) => r.type === "casualty" && r.part === "main")).toMatchObject({ position: "Lineman" });
  });
});

describe("completed match reporter: tabletop and tournament", () => {
  it("tabletop moments keep their order, half and turn; casualties carry the victim line; MVP rows carry no turn", () => {
    const g = {
      source: "tabletop", id: "tm1",
      card: { context: "Tabletop · Friendly", playedAt: null, href: null, concede: null, suspended: false, home: { name: "Night Owls", race: "Orc", coach: "Eve", crestUrl: null, score: 1, cas: 1 }, away: { name: "Rats", race: "Skaven", coach: "Finn", crestUrl: null, score: 0, cas: 0 } },
      summary: {
        playedAt: null, competition: "Tabletop · Friendly", round: null, tournament: null, casualties: { home: 1, away: 0 }, concede: null, perPlayer: true, note: null,
        home: team({ players: [pline("Grim", { touchdowns: 1, mvp: 1, sppEarned: 7 }), pline("Basher", { casualtiesCaused: 1, sppEarned: 2 })], squad: [pline("Grim", { touchdowns: 1, mvp: 1, sppEarned: 7 }), pline("Basher", { casualtiesCaused: 1, sppEarned: 2 })] }),
        away: team({ players: [pline("Squeak", { injury: "SI", sppEarned: 0 })], squad: [pline("Squeak", { injury: "SI", sppEarned: 0 })] }),
      },
      reporter: {
        matchId: "tm1", href: "/app/tabletop/tm1", state: "confirmed", summaries: null,
        moments: [
          { half: 1, turn: 3, side: "home", kind: "touchdown", text: "Touchdown: Grim", player: "Grim" },
          { half: 2, turn: 2, side: "home", kind: "casualty", text: "Casualty: Basher on Squeak (SI)", player: "Basher", victim: "Squeak", victimSide: "away", result: "SI" },
        ],
      },
    } as unknown as GameDetail;
    const m = reporterModel(g);
    expect(m.ordered).toBe(true);
    expect(m.logTitle).toBe(ORDERED_LOG_TITLE);
    // newest first, as the recorder's feed: MVP, then the casualty (causer above, victim beneath), then the touchdown
    expect(m.rows.map((r) => [r.type, r.part, r.when])).toEqual([
      ["mvp", "main", ""], ["casualty", "main", "H2 T2"], ["casualty", "victim", "H2 T2"], ["touchdown", "main", "H1 T3"],
    ]);
    expect(m.rows[2]).toMatchObject({ team: "away", player: "Squeak", rest: "is injured: SI." });
    // no confirmed preview: the summaries come from the server's own lines (no post-match step is claimed)
    expect(m.summaries[0]!.summary).toMatchObject({ outcome: "won", score: { for: 1, against: 0 } });
    expect(m.summaries[0]!.summary).not.toHaveProperty("applied");
    expect(m.final.cas).toEqual({ home: 1, away: 0 });
  });

  it("a tournament fixture without player data: the scoreboard only, no log", () => {
    const g = {
      source: "tournament", id: "m1",
      card: { context: "Cup · Round 3", playedAt: null, href: null, concede: "away", suspended: false, home: { name: "Reavers", race: "Orc", coach: "Alice", crestUrl: null, score: 1, cas: null }, away: { name: "Grinders", race: "Dwarf", coach: "Bob", crestUrl: null, score: 0, cas: null } },
      summary: { playedAt: null, competition: "Cup · Round 3", round: 3, tournament: { id: "t1", name: "Cup", href: "/app/tournaments/t1?tab=rounds" }, casualties: { home: null, away: null }, concede: "away", perPlayer: false, note: "Per-player stats are recorded for games played through the site.", home: null, away: null },
    } as unknown as GameDetail;
    const m = reporterModel(g);
    expect(m.hasLog).toBe(false);
    expect(m.final).toEqual({ score: { home: 1, away: 0 }, cas: { home: null, away: null }, fouls: null, concede: "away" });
    expect(m.summaries).toEqual([]);
    // the concession still shows: a log row and the final line (the scoreboard marks the side through final.concede)
    expect(m.rows.map((r) => [r.type, r.team, r.rest])).toEqual([["concede", "away", " concedes the match."]]);
    expect(m.finalLine).toBe("Final: Reavers 1-0 Grinders · Grinders conceded");
    expect(NO_LOG_NOTE).toBe("No match log for this fixture");
  });
});
