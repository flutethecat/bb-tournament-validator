import { describe, expect, it } from "vitest";
import { ingestPackageDocument, parsePackageDocument } from "@bb/ingest";

const DOC = `
Tournament: Lustrian Open 2026
Eligible rosters: Amazon, Human, Orc
Skill point budget: 10
Primary skill cost: 1
Secondary multiplier: 2
Elite surcharge: 1
Elite skills: Block, Guard, Mighty Blow, Dodge
Max skills per player: 2
Star players: no
Max re-rolls: 8
Banned skills: Sneaky Git
Min players: 11
`;

describe("rules-document package ingestion", () => {
  it("parses labeled lines into a complete package", async () => {
    const { pkg, problems } = await ingestPackageDocument({ kind: "text", text: DOC });
    expect(problems).toEqual([]);
    expect(pkg).toBeDefined();
    expect(pkg!.name).toBe("Lustrian Open 2026");
    expect(pkg!.eligibleRosters).toEqual(["Amazon", "Human", "Orc"]);
    expect(pkg!.skillAllotment.skillPointBudget).toBe(10);
    expect(pkg!.skillAllotment.eliteSkills).toEqual(["Block", "Guard", "Mighty Blow", "Dodge"]);
    expect(pkg!.starPlayers.allowed).toBe(false);
    expect(pkg!.sideline.maxReRolls).toBe(8);
    expect(pkg!.special.bannedSkills).toEqual(["Sneaky Git"]);
    // untouched fields come from the built-in defaults layer
    expect(pkg!.special.minPlayers).toBe(11);
    expect(pkg!.goldBudget).toBeNull();
  });

  it("reports unrecognized rule lines instead of silently defaulting", () => {
    const { problems } = parsePackageDocument("Skill point budget: 6\nWizard hats: 3\n");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/Wizard hats/);
  });

  it("flags a document with no skill point budget", async () => {
    const { problems } = await ingestPackageDocument({ kind: "text", text: "Tournament: X\n" });
    expect(problems.some((p) => /Skill point budget/.test(p))).toBe(true);
  });

  it("layers CSV overrides on top of the document", async () => {
    const { pkg } = await ingestPackageDocument(
      { kind: "text", text: DOC },
      { csvText: "skill,costSP,elite\nBlock,5,true\n" },
    );
    expect(pkg!.skillAllotment.skillCostSP["Block"]).toBe(5);
  });

  it("JSON path round-trips", async () => {
    const { pkg, problems } = await ingestPackageDocument({
      kind: "json",
      text: JSON.stringify({ name: "J", skillAllotment: { skillPointBudget: 4 } }),
    });
    expect(problems).toEqual([]);
    expect(pkg!.skillAllotment.skillPointBudget).toBe(4);
    expect(pkg!.skillAllotment.primaryCostSP).toBe(1); // defaults merged
  });
});
