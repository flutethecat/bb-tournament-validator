import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseForkRoster, rosterOptions, rosterOptionsIntrinsic } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

// #52 (A): Secret League / custom rosters aren't in the bb2025 dataset, but the roster XML is fully
// self-describing. The intrinsic path parses cost/cap/stats/skills straight from the XML.
const slXml = readFileSync(
  fileURLToPath(new URL("./fixtures/roster_secretleague.xml", import.meta.url)),
  "utf8",
);

describe("parseForkRoster — roster-intrinsic fields (Secret League)", () => {
  it("falls back to the team attr for the rosterId when there's no id attr", () => {
    expect(parseForkRoster(slXml).rosterId).toBe("1064979");
  });

  it("reads the SL header (race not in the dataset)", () => {
    const r = parseForkRoster(slXml);
    expect(r.raceName).toBe("Clan Moulder");
    expect(r.reRollCost).toBe(60000);
    expect(r.maxReRolls).toBe(8);
    expect(r.apothecaryAllowed).toBe(true);
  });

  it("extracts quantity/cost/stats/skills from each position block", () => {
    const r = parseForkRoster(slXml);
    const ogre = r.positions.find((p) => p.name === "Rat Ogre")!;
    expect(ogre.quantity).toBe(4);
    expect(ogre.cost).toBe(150000);
    expect(ogre.MA).toBe(6);
    expect(ogre.ST).toBe(5);
    expect(ogre.AG).toBe(4);
    expect(ogre.AV).toBe(9);
    expect(ogre.skills).toEqual(["Animal Savagery", "Frenzy", "Mighty Blow", "Prehensile Tail"]);
  });

  it("still excludes Stars (V1)", () => {
    const r = parseForkRoster(slXml);
    expect(r.positions.map((p) => p.name)).not.toContain("Renta Star");
    expect(r.positions).toHaveLength(2);
  });
});

describe("rosterOptionsIntrinsic — dataset-free builder options", () => {
  it("builds pickable options from the XML alone (cost/cap/stats/skills), no dataset needed", () => {
    const opts = rosterOptionsIntrinsic(slXml);
    expect(opts.raceName).toBe("Clan Moulder");
    expect(opts.rosterId).toBe("1064979");
    const ogre = opts.positions.find((p) => p.name === "Rat Ogre")!;
    expect(ogre.cost).toBe(150000);
    expect(ogre.max).toBe(4); // <quantity> = the cap
    expect(ogre.MA).toBe(6);
    expect(ogre.ST).toBe(5);
    expect(ogre.AG).toBe("4+");
    expect(ogre.AV).toBe("9+");
    expect(ogre.PA).toBe("-"); // passing 0 ⇒ no pass characteristic
    const slave = opts.positions.find((p) => p.name === "Skaven Slave")!;
    expect(slave.max).toBe(16);
    expect(slave.PA).toBe("4+");
    expect(slave.skills).toEqual(["Dodge"]);
  });

  it("proves the gap it fills: the DATASET path drops every SL position (race not in bb2025)", () => {
    // rosterOptions (dataset-bridged) can't resolve Clan Moulder → zero positions; intrinsic recovers them.
    expect(rosterOptions(slXml, bb2025).positions).toHaveLength(0);
    expect(rosterOptionsIntrinsic(slXml).positions).toHaveLength(2);
  });
});
