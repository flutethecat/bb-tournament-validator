import { describe, expect, it } from "vitest";
import { resolveTier, validate, type TierDef } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const tiers = (over: Partial<TierDef>[] = []): TierDef[] => [
  { tier: 1, rosters: ["Testers"], gold: 1150000, starPlayersAllowed: true, bannedStars: [], ...over[0] },
  { tier: 3, rosters: ["Weaklings"], gold: 1300000, starPlayersAllowed: false, bannedStars: [], ...over[1] },
];

const errorsOf = (r: ReturnType<typeof validate>, id: string) => r.errors.filter((f) => f.ruleId === id);

describe("resolveTier", () => {
  it("finds a race's tier, case-insensitively", () => {
    const p = pkg({ tiers: tiers() });
    expect(resolveTier(p, "Testers")!.tier).toBe(1);
    expect(resolveTier(p, "weaklings")!.tier).toBe(3);
    expect(resolveTier(p, "Amazon")).toBeUndefined();
  });
});

describe("tier eligibility", () => {
  it("a race in no tier is ineligible when tiers are set", () => {
    const r = validate(roster({ rosterName: "Testers" }), pkg({ tiers: [{ tier: 1, rosters: ["Weaklings"], gold: null, starPlayersAllowed: true, bannedStars: [] }] }), fakeData);
    expect(errorsOf(r, "roster-eligibility")[0]!.message).toMatch(/not an eligible roster/);
  });

  it("a race in a tier is eligible", () => {
    const r = validate(roster({ rosterName: "Testers" }), pkg({ tiers: tiers() }), fakeData);
    expect(errorsOf(r, "roster-eligibility")).toHaveLength(0);
  });
});

describe("per-tier gold", () => {
  it("uses the tier gold cap over the package goldBudget", () => {
    // 11 x 50k = 550k; tier-1 cap 500k => over
    const r = validate(
      roster({ rosterName: "Testers" }),
      pkg({ goldBudget: 9000000, tiers: tiers([{ gold: 500000 }]) }),
      fakeData,
    );
    const f = errorsOf(r, "gold-budget")[0]!;
    expect(f.message).toMatch(/550k, over the 500k budget \(Tier 1\)/);
  });
});

describe("per-tier star access + banned stars", () => {
  const withStar = (race: string, star = "Star Guy") => {
    const players = roster({ rosterName: race }).players;
    players[10] = player({ number: 11, positionName: star, cost: 200000 });
    return roster({ rosterName: race, players });
  };

  it("blocks stars for a tier that disallows them", () => {
    const r = validate(withStar("Weaklings"), pkg({ tiers: tiers() }), fakeData);
    expect(errorsOf(r, "star-players")[0]!.message).toMatch(/not allowed \(Tier 3\)/);
  });

  it("allows stars for a tier that permits them", () => {
    const r = validate(withStar("Testers"), pkg({ tiers: tiers() }), fakeData);
    expect(errorsOf(r, "star-players")).toHaveLength(0);
  });

  it("flags a per-tier banned star by name", () => {
    const r = validate(
      withStar("Testers", "Morg 'n' Thorg"),
      pkg({ tiers: tiers([{ bannedStars: ["Morg 'n' Thorg"] }]) }),
      fakeData,
    );
    expect(errorsOf(r, "star-players")[0]!.message).toMatch(/Morg 'n' Thorg is banned/);
  });
});

describe("per-tier skill-point budget", () => {
  it("uses the tier SP budget over the package skillAllotment budget", () => {
    // one Block added (2 SP elite); package budget 10, tier-1 budget 1 => over
    const players = roster({ rosterName: "Testers" }).players;
    players[0] = player({ number: 1, skills: ["Block"] });
    const base = pkg().skillAllotment;
    const r = validate(
      roster({ rosterName: "Testers", players }),
      pkg({
        skillAllotment: { ...base, skillPointBudget: 10 },
        tiers: tiers([{ skillPointBudget: 1 }]),
      }),
      fakeData,
    );
    const f = errorsOf(r, "skill-points")[0]!;
    expect(f.message).toMatch(/2 Skill Points; the budget is 1 \(Tier 1\)/);
    expect(r.recomputedSummary.skillPointBudget).toBe(1);
  });

  it("falls back to the package budget when the tier leaves SP unset", () => {
    const players = roster({ rosterName: "Testers" }).players;
    players[0] = player({ number: 1, skills: ["Block"] });
    const base = pkg().skillAllotment;
    const r = validate(
      roster({ rosterName: "Testers", players }),
      pkg({ skillAllotment: { ...base, skillPointBudget: 10 }, tiers: tiers() }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")).toHaveLength(0);
    expect(r.recomputedSummary.skillPointBudget).toBe(10);
  });
});

describe("per-tier skill allotment (count mode + stacking)", () => {
  it("a tier's primary/secondary counts switch it to count mode", () => {
    const players = roster({ rosterName: "Testers" }).players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] }); // 2 primary on a Lineman
    const r = validate(
      roster({ rosterName: "Testers", players }),
      pkg({ tiers: tiers([{ maxPrimary: 1, maxSecondary: 0 }]) }),
      fakeData,
    );
    const f = errorsOf(r, "skill-points")[0]!;
    expect(f.message).toMatch(/2 primary.*allotment is 1 primary/);
    expect(f.message).toMatch(/Tier 1/);
  });

  it("a tier can cap skill stacking", () => {
    const players = roster({ rosterName: "Testers" }).players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] });
    players[1] = player({ number: 2, skills: ["Block", "Wrestle"] });
    const r = validate(
      roster({ rosterName: "Testers", players }),
      pkg({ tiers: tiers([{ maxStackedPlayers: 1 }]) }),
      fakeData,
    );
    const f = errorsOf(r, "skill-points").find((x) => /skill stacking/.test(x.message))!;
    expect(f.message).toMatch(/at most 1 \(Tier 1\)/);
  });
});

describe("generic star detection (no tiers)", () => {
  it("detects stars for any team via the dataset star list", () => {
    const players = roster().players;
    players[10] = player({ number: 11, positionName: "Morg 'n' Thorg", cost: 340000 });
    const r = validate(
      roster({ players }),
      pkg({ starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null } }),
      fakeData,
    );
    expect(errorsOf(r, "star-players")[0]!.message).toMatch(/not allowed/);
  });
});
