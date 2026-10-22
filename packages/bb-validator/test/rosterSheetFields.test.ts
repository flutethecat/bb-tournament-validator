import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findPosition, findRoster, rosterOptions, rosterOptionsIntrinsic } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

const snotlingXml = readFileSync(new URL("./fixtures/roster_snotling.xml", import.meta.url), "utf8");

describe("roster sheet fields (keywords, skillsDisplay, teamWithPositionId, specialRules)", () => {
  const ro = rosterOptions(snotlingXml, bb2025);
  const pos = (name: string) => ro.positions.find((p) => p.name === name)!;

  it("carries dataset keywords and always-on roster rules separate from leagueOptions", () => {
    expect(pos("Snotling Lineman").keywords).toEqual(findPosition(findRoster(bb2025, "Snotling")!, "Snotling Lineman")!.keywords);
    expect(pos("Snotling Lineman").keywords.length).toBeGreaterThan(0);
    const dwarfXml = '<roster id="dwarf.bb2025"><name>Dwarf</name><reRollCost>60000</reRollCost><apothecary>true</apothecary>' +
      '<position id="1"><quantity>2</quantity><name>Dwarf Blitzer</name><type>Regular</type><gender>male</gender><skillList></skillList></position></roster>';
    const dwarf = rosterOptions(dwarfXml, bb2025);
    expect([...dwarf.specialRules].sort()).toEqual(["Brawlin' Brutes", "Bribery and Corruption"]);
    expect(dwarf.positions[0]!.keywords).toEqual(["Blitzer", "Dwarf"]);
    expect(ro.specialRules).toContain("Bribery and Corruption");
    for (const league of ro.leagueOptions) expect(ro.specialRules).not.toContain(league);
  });

  it("prints skills with their XML parameters for display, keeping `skills` as bare names", () => {
    const morg = pos("Morg 'n' Thorg");
    expect(morg.skills).toContain("Hatred");
    expect(morg.skillsDisplay).toContain("Hatred (Undead)");
    expect(morg.skillsDisplay).toContain("Loner (4+)");
    expect(morg.keywords).toEqual(["big guy", "ogre"]);
    expect(pos("Snotling Lineman").skillsDisplay).toContain("Titchy");
  });

  it("exposes the paired-star partner", () => {
    expect(pos("Grak").teamWithPositionId).toBe("65792");
    expect(pos("Crumbleberry").teamWithPositionId).toBe("65791");
    expect(pos("Akhorne the Squirrel").teamWithPositionId).toBeUndefined();
  });

  it("the intrinsic (SL) path carries the same fields from the XML", () => {
    const sl = rosterOptionsIntrinsic(snotlingXml, bb2025);
    const grak = sl.positions.find((p) => p.name === "Grak")!;
    expect(grak.teamWithPositionId).toBe("65792");
    expect(grak.skillsDisplay).toContain("I'll Carry You (Carrier)");
    expect(Array.isArray(sl.specialRules)).toBe(true);
  });
});
