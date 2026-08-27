import { describe, expect, it } from "vitest";
import {
  DEFAULT_SKILL_ALLOTMENT,
  applyCsvOverrides,
  costSP,
  parseSkillCostCsv,
  type SkillAllotment,
} from "@bb/validator";

const cfg = (over: Partial<SkillAllotment> = {}): SkillAllotment => ({
  ...DEFAULT_SKILL_ALLOTMENT,
  eliteSkills: [...DEFAULT_SKILL_ALLOTMENT.eliteSkills],
  skillCostSP: { ...DEFAULT_SKILL_ALLOTMENT.skillCostSP },
  ...over,
});

describe("costSP defaults (owner spec)", () => {
  it("non-elite primary skill costs 1 SP", () => {
    expect(costSP("Wrestle", "primary", cfg())).toBe(1);
    expect(costSP("Leader", "primary", cfg())).toBe(1);
  });

  it("the four default Elite skills cost 1.5 SP as primary (+0.5 surcharge — owner ruling 08-27)", () => {
    for (const s of ["Block", "Guard", "Mighty Blow", "Dodge"]) {
      expect(costSP(s, "primary", cfg())).toBe(1.5);
    }
  });

  it("secondary = 2x primary by default", () => {
    expect(costSP("Wrestle", "secondary", cfg())).toBe(2);
    expect(costSP("Block", "secondary", cfg())).toBe(2.5); // 2 + elite 0.5
  });

  it("elite matching is name-normalized", () => {
    expect(costSP("block", "primary", cfg())).toBe(1.5);
    expect(costSP("MIGHTY BLOW", "primary", cfg())).toBe(1.5);
  });
});

describe("costSP configurability", () => {
  it("explicit secondaryCostSP overrides the multiplier", () => {
    const c = cfg({ secondaryCostSP: 5 });
    expect(costSP("Wrestle", "secondary", c)).toBe(5);
    expect(costSP("Block", "secondary", c)).toBe(5.5);
  });

  it("changing the Elite set re-prices", () => {
    const c = cfg({ eliteSkills: ["Wrestle"] });
    expect(costSP("Wrestle", "primary", c)).toBe(1.5);
    expect(costSP("Block", "primary", c)).toBe(1); // no longer elite
  });

  it("changing the surcharge re-prices", () => {
    const c = cfg({ eliteSurchargeSP: 3 });
    expect(costSP("Block", "primary", c)).toBe(4);
  });

  it("per-skill override wins outright — no elite surcharge on top", () => {
    const c = cfg({ skillCostSP: { Block: 1 } });
    expect(costSP("Block", "primary", c)).toBe(1);
    expect(costSP("Block", "secondary", c)).toBe(1);
  });
});

describe("CSV overrides", () => {
  it("parses the documented CSV format, skipping comments and header", () => {
    const { rows, problems } = parseSkillCostCsv(
      "skill,costSP,elite\n# a comment\nBlock,3,true\nWrestle,1,false\n",
    );
    expect(problems).toEqual([]);
    expect(rows).toEqual([
      { skill: "Block", costSP: 3, elite: true },
      { skill: "Wrestle", costSP: 1, elite: false },
    ]);
  });

  it("reports bad rows as problems instead of throwing", () => {
    const { rows, problems } = parseSkillCostCsv("skill,costSP,elite\nBlock,banana,true\n");
    expect(rows).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/banana/);
  });

  it("CSV cost applies, but inline package skillCostSP still wins", () => {
    const base = cfg({ skillCostSP: { Guard: 9 } });
    const { rows } = parseSkillCostCsv("skill,costSP,elite\nGuard,4,\nWrestle,4,\n");
    const merged = applyCsvOverrides(base, rows);
    expect(costSP("Guard", "primary", merged)).toBe(9); // inline wins
    expect(costSP("Wrestle", "primary", merged)).toBe(4); // CSV applied
  });

  it("CSV elite column edits the effective Elite set", () => {
    const { rows } = parseSkillCostCsv("skill,costSP,elite\nWrestle,,true\nDodge,,false\n");
    const merged = applyCsvOverrides(cfg(), rows);
    expect(costSP("Wrestle", "primary", merged)).toBe(1.5);
    expect(costSP("Dodge", "primary", merged)).toBe(1);
  });
});
