import { describe, expect, it } from "vitest";
import { renderArtPrompt, type Matrix } from "@bb/validator";
import { pkg } from "./helpers";

describe("renderArtPrompt", () => {
  it("includes the tournament name, date, and Blood Bowl framing", () => {
    const p = renderArtPrompt(pkg({ name: "Lustrian Open", date: "2026-08-01", eligibleRosters: ["Amazon", "Orc"] }));
    expect(p).toContain("Lustrian Open");
    expect(p).toContain("2026-08-01");
    expect(p).toMatch(/BLOOD BOWL/i);
    expect(p).toContain("Amazon");
    expect(p).toContain("Orc");
  });

  it("gathers teams from a matrix", () => {
    const matrix: Matrix = {
      columns: [{ gold: 1_150_000 }],
      rows: [{ primary: 6, secondary: 0, secondarySwap: false }],
      cells: [{ col: 0, row: 0, teams: ["Wood Elf", "Dwarf"] }],
    };
    const p = renderArtPrompt(pkg({ matrix }));
    expect(p).toContain("Wood Elf");
    expect(p).toContain("Dwarf");
  });

  it("falls back gracefully with no explicit teams", () => {
    const p = renderArtPrompt(pkg({ eligibleRosters: ["*"] }));
    expect(p).toMatch(/variety of fantasy football teams/i);
  });
});
