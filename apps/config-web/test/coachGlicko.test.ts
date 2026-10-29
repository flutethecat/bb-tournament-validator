import { describe, expect, it } from "vitest";
import {
  computeGlicko, displayedCr, expectedScore, FUMBBL_CR, glickoUpdate, GLICKO_SCALE, PERIOD_EPOCH_MS, rho, unratedGlicko, type GlickoParams,
} from "../src/coachGlicko.js";
import type { StoredTournamentResult } from "../src/tournamentResults.js";

// Glickman, "Example of the Glicko-2 system": a 1500 / RD 200 / sigma 0.06 player, tau 0.5, no RD cap, beats a 1400/30 player, loses to 1550/100 and 1700/300.
const PAPER: GlickoParams = { tau: 0.5, sigma: 0.06, rating: 1500, rd: 200, rdCap: Infinity, epsilon: 1e-6 };
const paperGames = [
  { r: 1400, rd: 30, score: 1 },
  { r: 1550, rd: 100, score: 0 },
  { r: 1700, rd: 300, score: 0 },
];

describe("Glicko-2 core (Glickman's worked example)", () => {
  it("reproduces the paper: r' 1464.06 (1464.05 unrounded), RD' 151.52, sigma' 0.05999", () => {
    const out = glickoUpdate({ r: 1500, rd: 200, sigma: 0.06 }, paperGames, PAPER);
    expect(out.r).toBeCloseTo(1464.06, 1); // the paper rounds mu' to -0.2069 first: the exact figure is 1464.05
    expect(out.rd).toBeCloseTo(151.52, 2);
    expect(out.sigma).toBeCloseTo(0.05999, 4); // 0.059996 unrounded: the paper prints 0.05999
  });
  it("matches the paper's intermediates: E = 0.639, 0.432, 0.303", () => {
    const g = (rd: number) => 1 / Math.sqrt(1 + (3 * (rd / GLICKO_SCALE) ** 2) / Math.PI ** 2);
    expect(g(30)).toBeCloseTo(0.9955, 4);
    expect(expectedScore(0, -0.5756, 30 / GLICKO_SCALE)).toBeCloseTo(0.639, 3);
    expect(expectedScore(0, 0.2878, 100 / GLICKO_SCALE)).toBeCloseTo(0.432, 3);
    expect(expectedScore(0, 1.1513, 300 / GLICKO_SCALE)).toBeCloseTo(0.303, 3);
  });
});

describe("FUMBBL's configuration", () => {
  it("tau 0.2, initial sigma 0.15, r 1500, RD 150, RD capped at 150", () => {
    expect(FUMBBL_CR).toMatchObject({ tau: 0.2, sigma: 0.15, rating: 1500, rd: 150, rdCap: 150 });
  });
  it("a win over an equal unrated opponent raises r, a loss lowers it, RD stays within the cap", () => {
    const start = { r: 1500, rd: 150, sigma: 0.15 };
    const won = glickoUpdate(start, [{ r: 1500, rd: 150, score: 1 }]);
    const lost = glickoUpdate(start, [{ r: 1500, rd: 150, score: 0 }]);
    expect(won.r).toBeGreaterThan(1500);
    expect(lost.r).toBeLessThan(1500);
    expect(won.r - 1500).toBeCloseTo(1500 - lost.r, 6); // symmetric around an even match
    expect(won.rd).toBeLessThanOrEqual(150);
    expect(won.rd).toBeLessThan(150); // a game reduces the deviation
  });
  it("the cap bites after the pre-period inflation: an uncapped run would exceed 150", () => {
    const uncapped = glickoUpdate({ r: 1500, rd: 149, sigma: 0.15 }, [], { ...FUMBBL_CR, rdCap: Infinity });
    expect(uncapped.rd).toBeGreaterThan(150);
    expect(glickoUpdate({ r: 1500, rd: 149, sigma: 0.15 }, []).rd).toBeCloseTo(150, 10);
  });
});

describe("team-value term rho", () => {
  const phi = 150 / GLICKO_SCALE;
  const gj = 1 / Math.sqrt(1 + (3 * phi * phi) / Math.PI ** 2);
  it("is 0 when the team values are equal (or unknown)", () => {
    expect(rho(gj, 0)).toBeCloseTo(0, 12);
  });
  it("is negative when the opponent's team is worth more (delta = opponent - own > 0): playing up lowers E", () => {
    expect(rho(gj, 300_000)).toBeLessThan(0);
    expect(rho(gj, -300_000)).toBeGreaterThan(0);
    const flat = expectedScore(0, 0, phi, rho(gj, 0));
    const up = expectedScore(0, 0, phi, rho(gj, 300_000));
    expect(flat).toBeCloseTo(0.5, 12);
    expect(up).toBeLessThan(flat);
  });
  it("equals (-4g + 5.5) / (1 + exp(delta / 200000)) - (-4g + 5.5) / 2", () => {
    const c = -4 * gj + 5.5;
    expect(rho(gj, 200_000)).toBeCloseTo(c / (1 + Math.E) - c / 2, 12);
  });
  it("playing up earns a bigger gain for the same win", () => {
    const start = { r: 1500, rd: 150, sigma: 0.15 };
    const even = glickoUpdate(start, [{ r: 1500, rd: 150, score: 1, deltaCtv: 0 }]);
    const up = glickoUpdate(start, [{ r: 1500, rd: 150, score: 1, deltaCtv: 300_000 }]);
    const down = glickoUpdate(start, [{ r: 1500, rd: 150, score: 1, deltaCtv: -300_000 }]);
    expect(up.r).toBeGreaterThan(even.r);
    expect(down.r).toBeLessThan(even.r);
  });
});

describe("displayed CR (the decay formula)", () => {
  it("CR = r - 5 * max(RD - 100, 0), rounded", () => {
    expect(displayedCr(1500, 150)).toBe(1250);
    expect(displayedCr(1500, 100)).toBe(1500);
    expect(displayedCr(1500, 60)).toBe(1500); // a low RD never adds
    expect(displayedCr(1600, 120)).toBe(1500);
    expect(displayedCr(1523.4, 100)).toBe(1523);
    expect(displayedCr(1523.6, 100)).toBe(1524);
  });
  it("a never-rated coach shows r 1500 with the initial RD 150", () => {
    expect(unratedGlicko()).toEqual({ cr: 1250, r: 1500, rd: 150, sigma: 0.15, games: 0 });
  });
});

// ---- over stored results ----
const DAY = 86_400_000;
const at = (days: number): string => new Date(PERIOD_EPOCH_MS + days * DAY + 3_600_000).toISOString();
function game(id: string, day: number, home: string, away: string, homeScore: number, awayScore: number, tv?: [number, number]): StoredTournamentResult {
  const team = (teamId: string, score: number) => ({ teamId, score, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] });
  return {
    gameId: id, pulledAt: at(day),
    home: { teamId: `${home}-t`, teamName: home, coach: home, ...(tv ? { teamValue: tv[0] } : {}) },
    away: { teamId: `${away}-t`, teamName: away, coach: away, ...(tv ? { teamValue: tv[1] } : {}) },
    teams: [team(`${home}-t`, homeScore), team(`${away}-t`, awayScore)],
  };
}

describe("computeGlicko over results", () => {
  const fixture = [
    game("1", 0, "Alice", "Bob", 2, 1), game("2", 1, "Cara", "Alice", 0, 0), game("3", 8, "Bob", "Cara", 3, 1),
    game("4", 9, "Alice", "Bob", 1, 0, [1_100_000, 1_000_000]), game("5", 15, "Cara", "Bob", 2, 2),
  ];
  it("is deterministic and independent of the order the rows arrive in", () => {
    const a = computeGlicko(fixture);
    const b = computeGlicko([...fixture].reverse());
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(computeGlicko(fixture)).toEqual(a);
    expect([...a.keys()].sort()).toEqual(["alice", "bob", "cara"]);
    for (const c of a.values()) { expect(c.rd).toBeLessThanOrEqual(150); expect(c.cr).toBe(displayedCr(c.r, c.rd)); }
    expect(a.get("alice")!.games).toBe(3);
  });
  it("games of one 7-day period are rated against the opponents' values at the period's start", () => {
    // A and B play C in the same period: C's rating is not updated between the two games
    const same = computeGlicko([game("1", 0, "A", "C", 1, 0), game("2", 2, "B", "C", 1, 0)]);
    expect(same.get("a")!.r).toBeCloseTo(same.get("b")!.r, 9);
    // in separate periods B meets a C already knocked down by A
    const apart = computeGlicko([game("1", 0, "A", "C", 1, 0), game("2", 8, "B", "C", 1, 0)]);
    expect(apart.get("b")!.r).not.toBeCloseTo(same.get("b")!.r, 3);
  });
  it("a coach with no game in a period only gets the RD inflation, capped at 150", () => {
    const rows = [game("1", 0, "A", "B", 1, 0), game("2", 1, "A", "B", 1, 0), game("3", 2, "A", "B", 1, 0), game("4", 3, "A", "B", 1, 0), game("5", 4, "A", "B", 1, 0)];
    const idle = computeGlicko([...rows, game("9", 70, "X", "Y", 1, 0)]); // ten empty periods later
    const before = computeGlicko(rows);
    const a0 = before.get("a")!, a1 = idle.get("a")!;
    expect(a1.r).toBeCloseTo(a0.r, 9); // the rating itself does not move
    expect(a1.rd).toBeGreaterThan(a0.rd); // the deviation grows with idleness...
    expect(a1.rd).toBeLessThanOrEqual(150 + 1e-9); // ...up to the cap
    expect(a1.sigma).toBeCloseTo(a0.sigma, 12);
    expect(a1.cr).toBeLessThan(a0.cr); // and a looser RD lowers the displayed CR
  });
  it("asOf inflates through that period even without new games; the team values feed the rating", () => {
    const now = computeGlicko(fixture, { asOf: new Date(PERIOD_EPOCH_MS + 200 * DAY) });
    const last = computeGlicko(fixture);
    expect(now.get("alice")!.rd).toBeGreaterThanOrEqual(last.get("alice")!.rd);
    expect(now.get("alice")!.rd).toBeLessThanOrEqual(150 + 1e-9);
    const noTv = computeGlicko(fixture.map((r) => ({ ...r, home: { ...r.home, teamValue: undefined }, away: { ...r.away, teamValue: undefined } })));
    expect(noTv.get("alice")!.r).not.toBeCloseTo(last.get("alice")!.r, 6); // game 4 carried team values (Alice played up as the 1.1M side would not, Bob did)
  });
  it("no results: nothing rated", () => {
    expect(computeGlicko([]).size).toBe(0);
  });
});
