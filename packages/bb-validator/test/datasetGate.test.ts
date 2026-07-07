/**
 * The M1 dataset gate from the approved plan: the bundled Amazon dataset must
 * reproduce the supplied example-PDF roster exactly (positions, stats, costs,
 * sideline math). If this fails, the dataset is wrong — not the roster.
 */

import { describe, expect, it } from "vitest";
import { bb2025 } from "@bb/validator/dataset";
import { findPosition, findRoster, normName, type Roster } from "@bb/validator";
import fixtureJson from "../../../fixtures/amazon-example.roster.json";

const fixture = fixtureJson as unknown as Roster;

describe("Amazon dataset gate (example PDFs are ground truth)", () => {
  const amazon = findRoster(bb2025, "Amazon");

  it("Amazon exists in the dataset", () => {
    expect(amazon).toBeDefined();
  });

  it("every fixture player's position resolves with matching stats and cost", () => {
    for (const p of fixture.players) {
      const pos = findPosition(amazon!, p.positionName);
      expect(pos, `${p.positionName} should resolve`).toBeDefined();
      expect(
        { MA: pos!.MA, ST: pos!.ST, AG: pos!.AG, PA: pos!.PA, AV: pos!.AV, cost: pos!.cost },
        `#${p.number} ${p.positionName}`,
      ).toEqual({ MA: p.MA, ST: p.ST, AG: p.AG, PA: p.PA, AV: p.AV, cost: p.cost });
    }
  });

  it("base skills are a subset of each player's printed skills (name-normalized, as the validator matches)", () => {
    for (const p of fixture.players) {
      const pos = findPosition(amazon!, p.positionName)!;
      const printed = p.skills.map(normName);
      for (const base of pos.skills) {
        expect(printed, `#${p.number} should have base skill ${base}`).toContain(normName(base));
      }
    }
  });

  it("position keywords match the PDF's printed keywords (race + role)", () => {
    for (const p of fixture.players) {
      const pos = findPosition(amazon!, p.positionName)!;
      expect([...pos.keywords].sort(), `#${p.number} ${p.positionName}`).toEqual([...p.keywords].sort());
    }
  });

  it("positional quantity limits match BB2025 Amazon (16/2/2/2)", () => {
    const limits: [string, number][] = [
      ["Eagle Warrior", 16],
      ["Python Warrior", 2],
      ["Piranha Warrior", 2],
      ["Jaguar Warrior", 2],
    ];
    for (const [name, max] of limits) {
      expect(findPosition(amazon!, name), name).toBeDefined();
      expect(findPosition(amazon!, name)!.max, name).toBe(max);
    }
  });

  it("sideline math reproduces the PDF: 3 re-rolls x 60k + apothecary 50k = 230k", () => {
    const rr = fixture.sideline.reRolls * amazon!.reRollCost;
    const apo = fixture.sideline.apothecary ? 50000 : 0;
    expect(rr + apo).toBe(fixture.summary!.sidelineCost);
  });

  it("players cost sums to the PDF's 810k", () => {
    expect(fixture.players.reduce((a, p) => a + p.cost, 0)).toBe(fixture.summary!.playersCost);
  });
});
