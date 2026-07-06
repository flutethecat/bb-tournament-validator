import { describe, expect, it } from "vitest";
import { renderPackageHtml, type Matrix } from "@bb/validator";
import { pkg } from "./helpers";

describe("renderPackageHtml", () => {
  it("produces a standalone HTML doc with the package name and key sections", () => {
    const html = renderPackageHtml(pkg({ name: "Lustrian Open", date: "2026-08-01" }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("Lustrian Open");
    expect(html).toContain("2026-08-01");
    expect(html).toContain("Skill Allotment");
    expect(html).toContain("Star Players");
    expect(html).toContain("Sideline");
    expect(html).toContain("Special Rules");
  });

  it("renders a matrix as a cash x skills table with team names and swap markers", () => {
    const matrix: Matrix = {
      columns: [{ gold: 1_110_000 }, { gold: 1_150_000 }],
      rows: [
        { label: "6 Primary", primary: 6, secondary: 0, secondarySwap: false },
        { label: "8 Primary", primary: 8, secondary: 0, secondarySwap: true },
      ],
      cells: [
        { col: 0, row: 0, teams: ["Amazon"] },
        { col: 1, row: 1, teams: ["Orc", "Dwarf"] },
      ],
    };
    const html = renderPackageHtml(pkg({ matrix }));
    expect(html).toContain("Cash × Skills Matrix");
    expect(html).toContain("1,110,000 gp");
    expect(html).toContain("Amazon");
    expect(html).toContain("Orc");
    expect(html).toMatch(/swap/i); // secondary-swap row marker
  });

  it("renders tiers and global bans", () => {
    const html = renderPackageHtml(
      pkg({
        bannedStars: ["Morg 'n' Thorg"],
        tiers: [{ tier: 1, rosters: ["Amazon", "Orc"], gold: 1_150_000, skillPointBudget: 6, starPlayersAllowed: false, bannedStars: [] }],
      }),
    );
    expect(html).toContain("Tiers");
    expect(html).toContain("Tier 1");
    expect(html).toContain("1,150,000 gp");
    expect(html).toContain("Morg &#39;n&#39; Thorg"); // escaped
  });

  it("escapes HTML in names to avoid injection", () => {
    const html = renderPackageHtml(pkg({ name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
