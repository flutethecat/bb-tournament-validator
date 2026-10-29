import { describe, expect, it } from "vitest";
import { coachRatingFor, CR_BASELINE, eloToCr, rankOf, RANKS } from "../src/coachRank.js";

describe("coach rank (fork Elo -> FUMBBL CR scale)", () => {
  it("maps the 1500 Elo baseline to CR 150 and moves 1 CR per 10 Elo", () => {
    expect(eloToCr(1500)).toBe(CR_BASELINE);
    expect(eloToCr(1520)).toBe(152);
    expect(eloToCr(1400)).toBe(140);
    expect(eloToCr(1624)).toBe(162); // rounds to a whole number
  });
  it("assigns each rank at its threshold and the one below just under it", () => {
    for (const [i, r] of RANKS.entries()) {
      if (i === 0) { expect(rankOf(-1000).name).toBe(r.name); continue; }
      expect(rankOf(r.min).name).toBe(r.name);
      expect(rankOf(r.min - 1).name).toBe(RANKS[i - 1]!.name);
    }
  });
  it("lists the seven ranks in the owner's order", () => {
    expect(RANKS.map((r) => r.name)).toEqual(["Rookie", "Experienced", "Veteran", "Emerging Star", "Star", "Super Star", "Legend"]);
  });
  it("an unrated coach is the baseline Veteran-line CR; a rated one carries cr, rank and key", () => {
    expect(coachRatingFor(undefined)).toMatchObject({ cr: 150, rank: "Veteran", rankKey: "veteran" });
    expect(coachRatingFor(1520)).toEqual({ cr: 152, rank: "Veteran", rankKey: "veteran" });
  });
});
