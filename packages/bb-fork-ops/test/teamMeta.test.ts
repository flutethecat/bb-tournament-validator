import { describe, expect, it } from "vitest";
import { parseTeamId, parseTeamXmlMeta, recoachXml } from "@bb/fork-ops";

// Trimmed real FUMBBL xml:team export (BB2025 Black Orc team 1272390).
const REAL_XML = `<team id="1272390" status="1"><coach>Flutethecat</coach><name>blorcblorcblorcblorc</name>` +
  `<rosterId>8604</rosterId><reRolls>2</reRolls><dedicatedFans>3</dedicatedFans><apothecaries>0</apothecaries>` +
  `<teamValue>955000</teamValue><currentTeamValue>955000</currentTeamValue><treasury>35000</treasury></team>`;

describe("parseTeamXmlMeta", () => {
  it("parses a real BB2025 export (TV in thousands, gold raw, dedicatedFans as fanFactor)", () => {
    expect(parseTeamXmlMeta(REAL_XML)).toEqual({
      teamValue: 955, // 955000 ÷ 1000
      gold: 35000,
      rerolls: 2,
      fanFactor: 3, // from <dedicatedFans>
      apothecary: false, // <apothecaries>0</apothecaries>
    });
  });

  it("prefers <fanFactor> when present and reports apothecary from a positive count", () => {
    const xml = `<team><currentTeamValue>1200</currentTeamValue><treasury>0</treasury>` +
      `<fanFactor>7</fanFactor><apothecaries>2</apothecaries></team>`;
    const m = parseTeamXmlMeta(xml);
    expect(m.teamValue).toBe(1200); // already < 10000, left as-is
    expect(m.fanFactor).toBe(7);
    expect(m.apothecary).toBe(true);
  });

  it("defaults missing numbers safely", () => {
    const m = parseTeamXmlMeta("<team></team>");
    expect(m).toEqual({ teamValue: 0, gold: 0, rerolls: undefined, fanFactor: undefined, apothecary: undefined });
  });
});

describe("recoachXml", () => {
  it("rewrites the coach element (XML-escaping the new name)", () => {
    expect(recoachXml(REAL_XML, "Kalimar")).toContain("<coach>Kalimar</coach>");
    expect(recoachXml(REAL_XML, "A & B")).toContain("<coach>A &amp; B</coach>");
  });

  it("leaves XML without a coach element unchanged", () => {
    expect(recoachXml("<team><name>x</name></team>", "Z")).toBe("<team><name>x</name></team>");
  });
});

describe("parseTeamId", () => {
  it("pulls the id from a URL, ?id=, or a bare id", () => {
    expect(parseTeamId("https://fumbbl.com/t/1272390")).toBe("1272390");
    expect(parseTeamId("https://fumbbl.com/p/team?id=1272390")).toBe("1272390");
    expect(parseTeamId("1272390")).toBe("1272390");
    expect(parseTeamId("not a team")).toBeUndefined();
  });
});
