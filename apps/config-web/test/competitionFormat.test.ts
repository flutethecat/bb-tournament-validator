// Creation wizards v2 (lane 1): points always rank first, then the tiebreaker chain (each breaker, chain order, head to head
// among only the tied group), the old primaryTiebreaker ladder read as a chain, the points scheme, and Swiss pairing
// avoidance (avoided when possible; allowed and flagged when not).
import { describe, expect, it } from "vitest";
import {
  chainFromPrimary, chainText, DEFAULT_POINTS, pairingClash, parsePairingAvoid, parsePointsScheme, parseRegions, parseTiebreakerChain,
  POINTS_PRESET_2000, tiebreakerChainOf, TIEBREAKER_CHAIN_KEYS,
} from "../src/competition/format.js";
import { calculateStandings, generateTournamentPairings } from "../src/tournaments/pairing.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord, TournamentTiebreaker } from "../src/tournaments/types.js";

const pts = { win: 3, draw: 1, loss: 0, bye: 3 };

function entrant(n: number, extra: Partial<TournamentEntrantRecord> = {}): TournamentEntrantRecord {
  return {
    id: `e${n}`, tournamentId: "cup", seed: n,
    coach: { coachId: `c${n}`, ffbCoachId: `Coach${n}`, verifiedAt: "2026-11-02T00:00:00.000Z" },
    teamId: `t${n}`, registeredAt: "2026-11-02T00:00:00.000Z", ...extra,
  };
}

let seq = 0;
function game(home: number, away: number, hs: number, as: number, hc = 0, ac = 0, round = 1): ScheduledMatchRecord {
  seq += 1;
  return {
    id: `m${seq}`, tournamentId: "cup", roundId: `r${round}`, roundNumber: round,
    home: { entrantId: `e${home}`, coach: entrant(home).coach, teamId: `t${home}` },
    away: { entrantId: `e${away}`, coach: entrant(away).coach, teamId: `t${away}` },
    status: "completed", revision: 1,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore: hs, awayScore: as, homeCasualties: hc, awayCasualties: ac, reportedAt: "2026-11-02T01:00:00.000Z" },
    createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T01:00:00.000Z",
  };
}

const order = (entrants: TournamentEntrantRecord[], matches: ScheduledMatchRecord[], chain: TournamentTiebreaker[], points = pts) =>
  calculateStandings(entrants, matches, points, chain).map((r) => r.entrantId);

describe("standings: points first, then the chain", () => {
  it("points always rank first, whatever the chain says", () => {
    // e1 wins once (3 pts, TD +1); e2 draws twice (2 pts) with a huge TD and CAS total.
    const matches = [game(1, 3, 1, 0), game(2, 4, 5, 5, 4, 0), game(2, 3, 6, 6, 4, 0)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), matches, ["touchdownsFor", "casualtiesFor"])[0]).toBe("e1");
  });

  // Two coaches level on points who differ on exactly one statistic each time.
  const level = (m: ScheduledMatchRecord[]) => order([1, 2, 3, 4].map((n) => entrant(n)), m, []);
  it("TD difference breaks a tie", () => {
    const m = [game(1, 3, 3, 0), game(2, 4, 1, 0)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["touchdownDifferential"]).slice(0, 2)).toEqual(["e1", "e2"]);
    expect(level(m)).toHaveLength(4);
  });
  it("casualty difference breaks a tie", () => {
    const m = [game(1, 3, 1, 0, 0, 0), game(2, 4, 1, 0, 3, 1)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["casualtyDifferential"]).slice(0, 2)).toEqual(["e2", "e1"]);
  });
  it("TDs scored breaks a tie", () => {
    const m = [game(1, 3, 2, 1), game(2, 4, 3, 2)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["touchdownsFor"]).slice(0, 2)).toEqual(["e2", "e1"]);
  });
  it("casualties caused breaks a tie", () => {
    const m = [game(1, 3, 1, 0, 5, 5), game(2, 4, 1, 0, 1, 0)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["casualtiesFor"]).slice(0, 2)).toEqual(["e1", "e2"]);
    // ...while casualty difference ranks them the other way.
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["casualtyDifferential"]).slice(0, 2)).toEqual(["e2", "e1"]);
  });
  it("Buchholz breaks a tie (the opponents' points)", () => {
    // Round 1: e1 beats e3, e2 beats e4. Round 2: e3 beats e5, e4 loses to e6. e1 and e2 have 3 pts; e3 (3) > e4 (0).
    const m = [game(1, 3, 1, 0), game(2, 4, 1, 0), game(3, 5, 1, 0, 0, 0, 2), game(6, 4, 1, 0, 0, 0, 2)];
    expect(order([1, 2, 3, 4, 5, 6].map((n) => entrant(n)), m, ["buchholz"]).indexOf("e1"))
      .toBeLessThan(order([1, 2, 3, 4, 5, 6].map((n) => entrant(n)), m, ["buchholz"]).indexOf("e2"));
  });
  it("Sonneborn-Berger breaks a tie (beaten opponents' points)", () => {
    // e1 beat e3 and lost to e5; e2 beat e4 and lost to e6. e3 then wins twice, e4 never: e1's SB is higher.
    const m = [game(1, 3, 1, 0), game(2, 4, 1, 0), game(5, 1, 1, 0, 0, 0, 2), game(6, 2, 1, 0, 0, 0, 2), game(3, 7, 1, 0, 0, 0, 3), game(3, 8, 1, 0, 0, 0, 3)];
    const ranked = calculateStandings([1, 2, 3, 4, 5, 6, 7, 8].map((n) => entrant(n)), m, pts, ["sonnebornBerger"]);
    const e1 = ranked.find((r) => r.entrantId === "e1")!;
    const e2 = ranked.find((r) => r.entrantId === "e2")!;
    expect(e1.points).toBe(e2.points);
    expect(e1.sonnebornBerger).toBeGreaterThan(e2.sonnebornBerger);
    expect(e1.rank).toBeLessThan(e2.rank);
  });
  it("head to head breaks a two-way tie", () => {
    // e1 and e2 both 3 pts; e2 beat e1.
    const m = [game(2, 1, 1, 0), game(1, 3, 4, 0), game(4, 2, 1, 0)];
    expect(order([1, 2, 3, 4].map((n) => entrant(n)), m, ["headToHead"]).slice(0, 3).includes("e2")).toBe(true);
    const ranked = order([1, 2, 3, 4].map((n) => entrant(n)), m, ["headToHead", "touchdownDifferential"]);
    expect(ranked.indexOf("e2")).toBeLessThan(ranked.indexOf("e1"));
    // Without head to head, TD difference would put e1 (+3) above e2 (0).
    const byTd = order([1, 2, 3, 4].map((n) => entrant(n)), m, ["touchdownDifferential"]);
    expect(byTd.indexOf("e1")).toBeLessThan(byTd.indexOf("e2"));
  });
  it("head to head among 3+ tied coaches uses only the games inside the tied group", () => {
    // e1, e2, e3 all on 7 pts. Inside the group: e1 beat e2, e2 beat e3, e1 drew e3 -> e1 4, e2 3, e3 1.
    // Outside the group e3 thrashed e4 and e5 (big TD diff) - head to head ignores it.
    const m = [
      game(1, 2, 1, 0), game(2, 3, 1, 0), game(1, 3, 1, 1),
      game(3, 4, 6, 0), game(3, 5, 6, 0), game(2, 4, 1, 0), game(1, 6, 1, 0), game(2, 6, 1, 1),
    ];
    const rows = calculateStandings([1, 2, 3, 4, 5, 6].map((n) => entrant(n)), m, pts, ["headToHead", "touchdownDifferential"]);
    const tied = rows.filter((r) => ["e1", "e2", "e3"].includes(r.entrantId));
    expect(new Set(tied.map((r) => r.points)).size).toBe(1);
    expect(tied.map((r) => r.entrantId)).toEqual(["e1", "e2", "e3"]);
  });
  it("a group head to head leaves tied moves to the next tiebreaker", () => {
    // A cycle: e1 beat e2, e2 beat e3, e3 beat e1 -> all 3 h2h points. TD difference then decides.
    const m = [game(1, 2, 1, 0), game(2, 3, 1, 0), game(3, 1, 3, 0)];
    const ranked = order([1, 2, 3].map((n) => entrant(n)), m, ["headToHead", "touchdownDifferential"]);
    expect(ranked).toEqual(["e3", "e2", "e1"]); // TD diff: e3 +2, e2 0, e1 -2
  });
  it("follows the chain in order: the first breaker that differs decides", () => {
    // e1: TD diff +1, TDs 3; e2: TD diff +2, TDs 2.
    const m = [game(1, 3, 3, 2), game(2, 4, 2, 0)];
    const all = [1, 2, 3, 4].map((n) => entrant(n));
    expect(order(all, m, ["touchdownsFor", "touchdownDifferential"]).slice(0, 2)).toEqual(["e1", "e2"]);
    expect(order(all, m, ["touchdownDifferential", "touchdownsFor"]).slice(0, 2)).toEqual(["e2", "e1"]);
  });
  it("ranks by a custom points scheme (2000/1000/0)", () => {
    const m = [game(1, 2, 1, 1), game(3, 4, 1, 0)];
    const rows = calculateStandings([1, 2, 3, 4].map((n) => entrant(n)), m, { ...POINTS_PRESET_2000, bye: 2000 }, []);
    expect(rows[0]).toMatchObject({ entrantId: "e3", points: 2000 });
    expect(rows.find((r) => r.entrantId === "e1")!.points).toBe(1000);
  });
});

describe("format parsers", () => {
  it("accepts up to 4 distinct chain keys and refuses more, duplicates and unknown keys", () => {
    expect(parseTiebreakerChain(["headToHead", "touchdownDifferential", "casualtyDifferential", "buchholz"])).toHaveLength(4);
    expect(() => parseTiebreakerChain(["buchholz", "buchholz"])).toThrow(/twice/);
    expect(() => parseTiebreakerChain(TIEBREAKER_CHAIN_KEYS.slice(0, 5))).toThrow(/at most 4/);
    expect(() => parseTiebreakerChain(["seed"])).toThrow(/Unknown/);
    expect(TIEBREAKER_CHAIN_KEYS).toEqual(expect.arrayContaining(["touchdownDifferential", "casualtyDifferential", "headToHead"]));
  });
  it("reads an old stored primaryTiebreaker ladder as a chain with the old primary first", () => {
    expect(tiebreakerChainOf(["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"])).toEqual(chainFromPrimary("sonnebornBerger"));
    expect(tiebreakerChainOf(["sonnebornBerger", "buchholz", "touchdownDifferential", "casualtyDifferential", "seed"])).toEqual(["sonnebornBerger", "buchholz", "touchdownDifferential", "casualtyDifferential"]);
    expect(tiebreakerChainOf(undefined)).toEqual([]);
    expect(chainText(["headToHead"])).toBe("Points, then Head to head");
  });
  it("points scheme: integers, win > draw >= loss; 3/1/0 default and the 2000 preset", () => {
    expect(parsePointsScheme(DEFAULT_POINTS)).toEqual({ win: 3, draw: 1, loss: 0 });
    expect(parsePointsScheme(POINTS_PRESET_2000)).toEqual({ win: 2000, draw: 1000, loss: 0 });
    expect(() => parsePointsScheme({ win: 1, draw: 1, loss: 0 })).toThrow(/more points than a draw/);
    expect(() => parsePointsScheme({ win: 3.5, draw: 1, loss: 0 })).toThrow(/whole number/);
  });
  it("regions and avoidance", () => {
    expect(parseRegions([" North ", "", "South"])).toEqual(["North", "South"]);
    expect(() => parseRegions(["North", "north"])).toThrow(/twice/);
    expect(parsePairingAvoid("both")).toBe("both");
    expect(() => parsePairingAvoid("city")).toThrow();
    expect(pairingClash("club", { clubId: "a" }, { clubId: "A" })).toEqual(["club"]);
    expect(pairingClash("region", { clubId: "a", region: null }, { clubId: "a", region: null })).toEqual([]);
    expect(pairingClash("both", { clubId: "a", region: "N" }, { clubId: "a", region: "N" })).toEqual(["club", "region"]);
    expect(pairingClash("none", { clubId: "a" }, { clubId: "a" })).toEqual([]);
  });
});

describe("Swiss pairing avoidance", () => {
  const clubOf: Record<number, string> = { 1: "red", 2: "blue", 3: "red", 4: "blue" };
  const field = () => [1, 2, 3, 4].map((n) => entrant(n, { clubId: clubOf[n], region: n <= 2 ? "North" : "South" }));
  const byClub = (a: TournamentEntrantRecord, b: TournamentEntrantRecord) => pairingClash("club", a, b);
  const pairsOf = (p: Array<{ homeEntrantId: string; awayEntrantId?: string }>) => p.map((x) => [x.homeEntrantId, x.awayEntrantId].sort().join("-")).sort();

  for (const system of ["eloSeeded", "dutch", "monrad"] as const) {
    it(`${system}: round 1 steps past a same-club pairing when another draw exists`, () => {
      // The fold would pair e1 v e3 (both red) and e2 v e4 (both blue).
      const pairs = generateTournamentPairings("swiss", 1, field(), [], pts, [], { system, clash: byClub });
      expect(pairs.every((p) => !p.clash)).toBe(true);
      for (const p of pairs) expect(clubOf[Number(p.homeEntrantId.slice(1))]).not.toBe(clubOf[Number(p.awayEntrantId!.slice(1))]);
    });
    it(`${system}: a later round avoids a clash when possible`, () => {
      // Round 1: e1 v e2, e3 v e4 (cross-club). Round 2 by score would pair winners e1 v e3 (red) - avoided.
      const prior = [game(1, 2, 1, 0), game(3, 4, 1, 0)];
      const pairs = generateTournamentPairings("swiss", 2, field(), prior, pts, [], { system, clash: byClub });
      expect(pairs.some((p) => p.clash)).toBe(false);
      expect(pairsOf(pairs)).toEqual(["e1-e4", "e2-e3"]);
    });
    it(`${system}: allows the clash and flags it when no clash-free draw exists`, () => {
      const allRed = [1, 2, 3, 4].map((n) => entrant(n, { clubId: "red" }));
      const pairs = generateTournamentPairings("swiss", 1, allRed, [], pts, [], { system, clash: byClub });
      expect(pairs).toHaveLength(2);
      expect(pairs.every((p) => p.clash?.includes("club"))).toBe(true);
    });
  }
  it("region avoidance: blank regions never clash", () => {
    const blanks = [1, 2, 3, 4].map((n) => entrant(n, { region: null }));
    const pairs = generateTournamentPairings("swiss", 1, blanks, [], pts, [], { clash: (a, b) => pairingClash("region", a, b) });
    expect(pairs.some((p) => p.clash)).toBe(false);
  });
  it("without a rule nothing changes (no clash field)", () => {
    const pairs = generateTournamentPairings("swiss", 1, field(), [], pts, []);
    expect(pairs).toEqual([{ homeEntrantId: "e1", awayEntrantId: "e3" }, { homeEntrantId: "e2", awayEntrantId: "e4" }]);
  });
});

describe("pairing review fixes (Sol P2s)", () => {
  it("18 players (eloSeeded, greedy-size field): club avoidance never forces an avoidable rematch", () => {
    // Everyone drew once, so the order is the stable coin flip alone; read it, then build the trap around it: the
    // 15th seat shares a club with the 16th and has met the 18th. A greedy pick (15 v 17, dodging the clash) would leave
    // 16 v 18 as a rematch; a draw with neither a rematch nor a clash exists (15 v 18, 16 v 17).
    const base = Array.from({ length: 18 }, (_, i) => entrant(i + 1));
    const dummy = Array.from({ length: 9 }, (_, i) => game(2 * i + 1, 2 * i + 2, 0, 0));
    const order = calculateStandings(base, dummy, pts, []).map((r) => Number(r.entrantId.slice(1)));
    const r = (i: number) => order[i]!;
    const priors = [[0, 2], [1, 3], [4, 6], [5, 7], [8, 10], [9, 12], [11, 14], [13, 16], [15, 17]].map(([a, b]) => game(r(a!), r(b!), 0, 0));
    const field = base.map((e) => (e.id === `e${r(14)}` || e.id === `e${r(15)}` ? { ...e, clubId: "red" } : { ...e, clubId: `club-${e.id}` }));
    const met = new Set(priors.map((m) => [m.home.entrantId, m.away!.entrantId].sort().join("|")));
    const pairs = generateTournamentPairings("swiss", 2, field, priors, pts, [], { system: "eloSeeded", clash: (a, b) => pairingClash("club", a, b) });
    expect(pairs).toHaveLength(9);
    expect(pairs.filter((p) => met.has([p.homeEntrantId, p.awayEntrantId!].sort().join("|")))).toEqual([]);
    expect(pairs.filter((p) => p.clash)).toEqual([]);
  });
  it("a negative scheme (0 / -1000 / -2000) never makes a rematch cheaper than a fresh pairing", () => {
    const neg = { win: 0, draw: -1000, loss: -2000, bye: 0 };
    // R1: 1 beat 2, 3 beat 4. R2: 1 beat 3, 2 beat 4. Fresh round 3 = 1 v 4 and 2 v 3 (a 4000-point gap); the only other
    // draw is two rematches.
    const prior = [game(1, 2, 1, 0), game(3, 4, 1, 0), game(1, 3, 1, 0, 0, 0, 2), game(2, 4, 1, 0, 0, 0, 2)];
    for (const system of ["eloSeeded", "dutch", "monrad"] as const) {
      const pairs = generateTournamentPairings("swiss", 3, [1, 2, 3, 4].map((n) => entrant(n)), prior, neg, [], { system });
      expect(pairsOf(pairs), system).toEqual(["e1-e4", "e2-e3"]);
    }
    expect(() => parsePointsScheme({ win: 0, draw: 0, loss: -1 })).toThrow(/more points than a draw/);
    expect(() => parsePointsScheme({ win: 0, draw: -2, loss: -1 })).toThrow(/at least as many points as a loss/);
    expect(parsePointsScheme({ win: 0, draw: -1000, loss: -2000 })).toEqual({ win: 0, draw: -1000, loss: -2000 });
  });
});

const pairsOf = (p: Array<{ homeEntrantId: string; awayEntrantId?: string }>) => p.map((x) => [x.homeEntrantId, x.awayEntrantId].sort().join("-")).sort();
