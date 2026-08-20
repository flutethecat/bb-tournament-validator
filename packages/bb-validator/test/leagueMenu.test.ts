import { describe, expect, it } from "vitest";
import { findRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { ALL_DEITIES, leagueMenuForRoster } from "../src/dataset/leagueMenu";

describe("leagueMenuForRoster", () => {
  it("offers both Halfling league affiliations", () => {
    const roster = findRoster(bb2025, "Halfling");
    expect(roster).toBeDefined();
    expect(leagueMenuForRoster(roster!)).toEqual({
      alwaysOn: [],
      leagueOptions: ["Halfling Thimble Cup", "Woodland League"],
    });
  });

  it("de-truncates Norse deities and keeps Chaos Clash always-on", () => {
    const roster = findRoster(bb2025, "Norse");
    expect(roster).toBeDefined();
    expect(leagueMenuForRoster(roster!)).toEqual({
      alwaysOn: ["Chaos Clash"],
      leagueOptions: ["Old World Classic", ...ALL_DEITIES],
    });
  });
});
