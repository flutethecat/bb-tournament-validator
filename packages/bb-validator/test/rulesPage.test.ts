import { describe, expect, it } from "vitest";
import { loadPackage, renderRulesPage, type TournamentPackage } from "@bb/validator";
import nafRaw from "../../../tournament-packages/naf-world-cup-2027.json";
import defaultRaw from "../../../tournament-packages/bb2025-default.json";
import { pkg } from "./helpers";

const generatedAt = new Date("2027-01-01T12:00:00.000Z");

const naf = (): TournamentPackage =>
  loadPackage(nafRaw as unknown as Partial<TournamentPackage>).pkg;

describe("renderRulesPage", () => {
  it("renders all 31 NAF World Cup team rows sorted by gold then team", () => {
    const html = renderRulesPage(naf(), { generatedAt });
    const rows = [...html.matchAll(/<tr class="team-row"[\s\S]*?<\/tr>/g)].map((match) => match[0]);

    expect(rows).toHaveLength(31);
    const values = rows.map((row) => {
      const cells = [...row.matchAll(/<(?:th|td)[^>]*>(.*?)<\/(?:th|td)>/g)].map((match) => match[1]);
      return { team: cells[0], gold: Number(cells[1]?.replace(/,/g, "")) };
    });
    expect(values).toEqual(values.slice().sort((left, right) => left.gold - right.gold || left.team!.localeCompare(right.team!)));
  });

  it("renders the NAF Ogre row with 1,180,000 gold, 66 SPP, two stackers, and Stars Yes", () => {
    const html = renderRulesPage(naf(), { generatedAt });
    const row = html.match(/<tr class="team-row"[^>]*data-roster="Ogre"[\s\S]*?<\/tr>/)?.[0];

    expect(row).toContain("1,180,000");
    expect(row).toMatch(/<td>66<\/td>/);
    expect(row).toContain("Up to 2 players may carry 2 skills");
    expect(row).toMatch(/<td>Yes<\/td>/);
  });

  it("renders the NAF Orc row as No stacking with Stars No", () => {
    const html = renderRulesPage(naf(), { generatedAt });
    const row = html.match(/<tr class="team-row"[^>]*data-roster="Orc"[\s\S]*?<\/tr>/)?.[0];

    expect(row).toContain("No stacking");
    expect(row).toMatch(/<td>No<\/td>/);
  });

  it("renders all 16 alphabetised NAF banned-star chips and escapes Morg's apostrophes", () => {
    const html = renderRulesPage(naf(), { generatedAt });
    const chips = [...html.matchAll(/<li class="banned-star-chip">(.*?)<\/li>/g)].map((match) => match[1]);

    expect(chips).toHaveLength(16);
    expect(chips).toContain("Morg &#39;n&#39; Thorg");
    expect(chips).toEqual(chips.slice().sort((left, right) => left.localeCompare(right)));
  });

  it("splits the NAF hand-check data note into four numbered items (three were absorbed by the validator knobs)", () => {
    const html = renderRulesPage(naf(), { generatedAt });

    expect(html).toContain("Hand-checked by the TO");
    expect(html.match(/class="data-note-item"/g)).toHaveLength(4);
    expect(html).toContain("These rules are not enforced by the validator.");
  });

  it("renders the NAF Star Player tax table when spTaxByCombinedCost is present", () => {
    const packageWithPendingFields = naf() as TournamentPackage & {
      starPlayers: TournamentPackage["starPlayers"] & {
        spTaxByCombinedCost?: { upToGold: number | null; sp: number }[];
      };
    };
    if (!packageWithPendingFields.starPlayers.spTaxByCombinedCost) return;

    const html = renderRulesPage(packageWithPendingFields, { generatedAt });
    expect(html).toContain("Star Player skill-budget tax");
    expect(html).toContain("18 SP");
    expect(html).toContain("24 SP");
    expect(html).toContain("32 SP");
  });

  it("renders EuroBowl-style skill packages per tier, Star Player SP costs, and the Slann footnote", () => {
    const euroBowl = pkg({
      name: "EuroBowl 2026",
      eligibleRosters: ["Human", "Slann"],
      skillPackages: [
        { label: "Skills A", gold: 1_100_000, skillPointBudget: 6, maxPerPlayer: 1 },
        { label: "Skills B", gold: 1_060_000, skillPointBudget: 8, maxPerPlayer: 2 },
      ],
      tiers: [
        { tier: 1, rosters: ["Human"], gold: 1_100_000, starPlayersAllowed: true, bannedStars: [] },
        { tier: 2, rosters: ["Slann"], gold: 1_150_000, starPlayersAllowed: true, bannedStars: [] },
      ],
      starPlayers: {
        allowed: true,
        maxCount: 2,
        maxCombinedCost: null,
        paidInSkillPoints: true,
        spCostByTier: { "Akhorne the Squirrel": [1, 2], "Griff Oberwald": [6, null] },
      },
    });
    const html = renderRulesPage(euroBowl, { generatedAt });

    expect(html).toContain("Tier 1 skill packages");
    expect(html).toContain("Tier 2 skill packages");
    expect(html).toContain("Star Player SP cost by tier");
    expect(html).toContain("Slann†");
    expect(html).toContain("† not selectable in the Team Builder yet.");
  });

  it("renders a flat default package without a tier table and names all BB2025 teams", () => {
    const flat = loadPackage(defaultRaw as unknown as Partial<TournamentPackage>).pkg;
    const html = renderRulesPage(flat, { generatedAt });

    expect(html).toContain("All BB2025 teams");
    expect(html).not.toContain('class="team-rules"');
    expect(html).not.toContain("Effective rules by team");
  });

  it("escapes a package name containing a script element everywhere", () => {
    const html = renderRulesPage(pkg({ name: "<script>alert('x')</script>" }), { generatedAt });

    expect(html).not.toContain("<script>alert('x')</script>");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
  });

  it("is deterministic for fixed inputs and matches its structural snapshot", () => {
    const options = { generatedAt, roster: "Ogre", problems: ["Example warning"] };
    const first = renderRulesPage(naf(), options);
    const second = renderRulesPage(naf(), options);

    expect(second).toBe(first);
    expect({
      doctype: first.startsWith("<!doctype html>"),
      h1Count: first.match(/<h1>/g)?.length,
      teamRows: first.match(/data-team-row="true"/g)?.length,
      focused: first.includes('data-roster="Ogre" aria-current="true"'),
      generated: first.includes("on 2027-01-01"),
      problems: first.includes("Example warning"),
    }).toMatchInlineSnapshot(`
      {
        "doctype": true,
        "focused": true,
        "generated": true,
        "h1Count": 1,
        "problems": true,
        "teamRows": 31,
      }
    `);
  });
});
