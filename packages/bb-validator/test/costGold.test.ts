import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_ALLOTMENT,
  DEFAULT_SKILL_GOLD,
  costGold,
  inducementsGold,
  staffGold,
  type SkillAllotment,
} from "@bb/validator";

const cfg = (over: Partial<SkillAllotment> = {}): SkillAllotment => ({
  ...DEFAULT_SKILL_ALLOTMENT,
  eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
  skillCostSP: { ...DEFAULT_SKILL_ALLOTMENT.skillCostSP },
  ...over,
});

describe("costGold defaults (owner 2026-08-04 flat model)", () => {
  it("non-elite: primary 20k, secondary 40k", () => {
    expect(costGold("Wrestle", "primary", cfg())).toBe(20000);
    expect(costGold("Wrestle", "secondary", cfg())).toBe(40000);
    expect(DEFAULT_SKILL_GOLD).toEqual({ primary: 20000, secondary: 40000, eliteSurcharge: 10000 });
  });

  it("the four default Elite skills get the +10k surcharge (elite-primary 30k, elite-secondary 50k)", () => {
    for (const s of ["Block", "Guard", "Mighty Blow", "Dodge"]) {
      expect(costGold(s, "primary", cfg())).toBe(30000);
      expect(costGold(s, "secondary", cfg())).toBe(50000);
    }
  });

  it("elite matching is name-normalized", () => {
    expect(costGold("block", "primary", cfg())).toBe(30000);
    expect(costGold("MIGHTY BLOW", "secondary", cfg())).toBe(50000);
  });
});

describe("costGold configurability (package knobs)", () => {
  it("primary/secondary/elite gold knobs re-price", () => {
    const c = cfg({ primaryCostGold: 15000, secondaryCostGold: 30000, eliteSurchargeGold: 5000 });
    expect(costGold("Wrestle", "primary", c)).toBe(15000);
    expect(costGold("Wrestle", "secondary", c)).toBe(30000);
    expect(costGold("Block", "primary", c)).toBe(20000); // 15k + 5k elite
  });

  it("changing the Elite set re-prices gold too", () => {
    const c = cfg({ eliteSkills: ["Wrestle"] });
    expect(costGold("Wrestle", "primary", c)).toBe(30000);
    expect(costGold("Block", "primary", c)).toBe(20000); // no longer elite
  });

  it("per-skill gold override wins outright — no elite surcharge on top", () => {
    const c = cfg({ skillCostGold: { Block: 12000 } });
    expect(costGold("Block", "primary", c)).toBe(12000);
    expect(costGold("Block", "secondary", c)).toBe(12000);
  });
});

describe("cost-bucket formulas", () => {
  it("staffGold = players + sideline", () => {
    const roster = { players: [{ cost: 50000 }, { cost: 90000 }], summary: { sidelineCost: 70000 } };
    expect(staffGold(roster)).toBe(210000);
  });

  it("staffGold tolerates a missing sideline total", () => {
    expect(staffGold({ players: [{ cost: 60000 }] })).toBe(60000);
  });

  it("inducementsGold prefers per-item costs, falls back to the sheet total", () => {
    expect(inducementsGold({ inducements: [{ cost: 30000, count: 2 }, { cost: 50000 }] })).toBe(110000);
    expect(inducementsGold({ inducements: [{ name: "Bribe" } as never], summary: { inducementCost: 100000 } })).toBe(
      100000,
    );
  });
});
