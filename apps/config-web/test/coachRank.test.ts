import { describe, expect, it } from "vitest";
import { BANDS, coachRatingFor, eloToCr, ELO_BASELINE, rankOf, ROOKIE, ROOKIE_GAMES } from "../src/coachRank.js";

describe("coach rank (CR = fork Elo, FUMBBL titles)", () => {
  it("CR is the Elo itself, whole-numbered, 1500 baseline", () => {
    expect(eloToCr(1500)).toBe(ELO_BASELINE);
    expect(eloToCr(1523.4)).toBe(1523);
    expect(eloToCr(1523.6)).toBe(1524);
  });
  it("Rookie whenever fewer than 10 games, whatever the rating", () => {
    expect(rankOf(1900, ROOKIE_GAMES - 1)).toBe(ROOKIE);
    expect(rankOf(1200, 0).name).toBe("Rookie");
    expect(rankOf(1900, ROOKIE_GAMES).name).toBe("Legend");
  });
  it("the default bands: Experienced < 1450, Veteran 1450-1499, Emerging Star 1500-1549, Star 1550-1599, Super Star 1600-1674, Megastar 1675-1749, Legend >= 1750", () => {
    const at = (cr: number): string => rankOf(cr, 50).name;
    expect([at(1449), at(1450), at(1499), at(1500), at(1549), at(1550), at(1599), at(1600), at(1674), at(1675), at(1749), at(1750)]).toEqual([
      "Experienced", "Veteran", "Veteran", "Emerging Star", "Emerging Star", "Star", "Star", "Super Star", "Super Star", "Megastar", "Megastar", "Legend",
    ]);
    expect(at(900)).toBe("Experienced");
  });
  it("eight titles in order, with one more pip per step", () => {
    expect([ROOKIE, ...BANDS].map((r) => r.name)).toEqual(["Rookie", "Experienced", "Veteran", "Emerging Star", "Star", "Super Star", "Megastar", "Legend"]);
    expect([ROOKIE, ...BANDS].map((r) => r.pips)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("a new coach (1500, no games) is a Rookie; a rated one carries cr, rank, key and games", () => {
    expect(coachRatingFor(undefined)).toEqual({ cr: 1500, rank: "Rookie", rankKey: "rookie", games: 0 });
    expect(coachRatingFor(1523, 12)).toEqual({ cr: 1523, rank: "Emerging Star", rankKey: "emerging", games: 12 });
  });
});
