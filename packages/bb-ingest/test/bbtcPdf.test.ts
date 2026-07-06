/**
 * M2 golden ingestion tests: both example PDFs must parse to the golden fixture
 * (fixtures/amazon-example.roster.json), and the parsed roster must pass the
 * full validation pipeline — the complete e2e minus Discord.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bbtcPdfSource, ingestRoster } from "@bb/ingest";
import {
  loadPackage,
  validate,
  type Roster,
  type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import fixtureJson from "../../../fixtures/amazon-example.roster.json";
import lustrianJson from "../../../tournament-packages/lustrian-superleague.example.json";
import defaultJson from "../../../tournament-packages/bb2025-default.json";

const fixture = fixtureJson as unknown as Roster;

const pdfPath = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/pdfs/${name}`, import.meta.url));

async function parsePdf(name: string): Promise<Roster> {
  const bytes = new Uint8Array(readFileSync(pdfPath(name)));
  const result = await ingestRoster({ kind: "pdf", bytes, filename: name }, [bbtcPdfSource]);
  expect(result.problems, `problems for ${name}`).toEqual([]);
  expect(result.roster).toBeDefined();
  return result.roster!;
}

/** Strip validator-derived fields the parser doesn't (and shouldn't) emit. */
function comparable(r: Roster) {
  return {
    rosterName: r.rosterName,
    coach: r.coach,
    teamName: r.teamName,
    sideline: r.sideline,
    inducements: r.inducements,
    leagues: r.leagues,
    players: r.players.map((p) => ({
      number: p.number,
      positionName: p.positionName,
      MA: p.MA,
      ST: p.ST,
      AG: p.AG,
      PA: p.PA,
      AV: p.AV,
      skills: p.skills,
      keywords: [...p.keywords].sort(),
      cost: p.cost,
    })),
    summary: {
      playersCost: r.summary!.playersCost,
      skillsCost: r.summary!.skillsCost,
      inducementCost: r.summary!.inducementCost,
      sidelineCost: r.summary!.sidelineCost,
      total: r.summary!.total,
      primarySkills: r.summary!.primarySkills,
      secondarySkills: r.summary!.secondarySkills,
    },
  };
}

describe.each(["Example PDF 1.pdf", "Example PDF 2.pdf"])("golden parse of %s", (name) => {
  it("reproduces the golden fixture exactly", async () => {
    const parsed = await parsePdf(name);
    expect(comparable(parsed)).toEqual(comparable(fixture));
  });

  it("parsed roster passes the Lustrian sample package end-to-end (10/10 SP)", async () => {
    const parsed = await parsePdf(name);
    const { pkg } = loadPackage(lustrianJson as unknown as Partial<TournamentPackage>, {
      resolveExtends: () => defaultJson as unknown as Partial<TournamentPackage>,
    });
    const result = validate(parsed, pkg, bb2025);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.recomputedSummary.skillPointsUsed).toBe(10);
  });
});

describe("loud failure on non-bbtc input", () => {
  it("refuses to guess on unrecognized bytes", async () => {
    const result = await ingestRoster(
      { kind: "pdf", bytes: new Uint8Array([1, 2, 3]), filename: "junk.pdf" },
      [bbtcPdfSource],
    );
    expect(result.roster).toBeUndefined();
    expect(result.problems.length).toBeGreaterThan(0);
  });
});
