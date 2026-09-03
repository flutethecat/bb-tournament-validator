/**
 * Bot E2E minus Discord: the full /validate pipeline on the real example PDF,
 * plus embed rendering shape (what the FUMBBL40k client will mirror).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPackage, type TournamentPackage } from "@bb/validator";
import { renderProblemsEmbed, renderResultEmbed, validateRosterBytes } from "../src/pipeline";
import { PackageStore } from "../src/packageStore";
import lustrianJson from "../../../tournament-packages/lustrian-superleague.example.json";
import defaultJson from "../../../tournament-packages/bb2025-default.json";

const pdfBytes = () =>
  new Uint8Array(
    readFileSync(fileURLToPath(new URL("../../../fixtures/pdfs/Example PDF 1.pdf", import.meta.url))),
  );

const lustrian = () =>
  loadPackage(lustrianJson as unknown as Partial<TournamentPackage>, {
    resolveExtends: () => defaultJson as unknown as Partial<TournamentPackage>,
  }).pkg;

describe("validate pipeline (bytes → verdict)", () => {
  // owner 2026-09-03: PDF-ingestion golden (bbtc.pl sample vs Lustrian 10 SP) — not maintained; no fix required.
  it.skip("passes the example PDF and renders a green embed", async () => {
    const out = await validateRosterBytes(pdfBytes(), "Example PDF 1.pdf", lustrian());
    expect(out.ok).toBe(true);
    expect(out.result!.valid).toBe(true);
    const embed = renderResultEmbed(out.result!, out.roster!.teamName, "Lustrian");
    expect(embed.title).toMatch(/^✅/);
    expect(embed.color).toBe(0x22e05a);
    expect(embed.fields[0]!.value).toMatch(/10 \/ 10 SP\s+\(6 primary, 0 secondary\)/);
  });

  // owner 2026-09-03: PDF-ingestion golden (bbtc.pl sample vs Lustrian 10 SP) — not maintained; no fix required.
  it.skip("renders errors WITH suggestions on a failing package", async () => {
    const strict = lustrian();
    strict.skillAllotment.skillPointBudget = 8;
    const out = await validateRosterBytes(pdfBytes(), "Example PDF 1.pdf", strict);
    expect(out.result!.valid).toBe(false);
    const embed = renderResultEmbed(out.result!, out.roster!.teamName, "Strict");
    expect(embed.title).toMatch(/^❌/);
    const errField = embed.fields.find((f) => f.name.includes("skill-points"));
    expect(errField!.value).toMatch(/→ \*.*raise the budget to 10.*\*/);
  });

  it("junk bytes produce a problems embed, not a verdict", async () => {
    const out = await validateRosterBytes(new Uint8Array([9, 9, 9]), "junk.pdf", lustrian());
    expect(out.ok).toBe(false);
    const embed = renderProblemsEmbed(out.problems, "junk.pdf");
    expect(embed.title).toMatch(/Could not read junk.pdf/);
  });
});

describe("PackageStore", () => {
  it("loads the repo's tournament-packages dir and resolves extends", () => {
    const store = new PackageStore(
      fileURLToPath(new URL("../../../tournament-packages", import.meta.url)),
    );
    expect(store.names()).toContain("Lustrian Superleague (Example)");
    const found = store.get("Lustrian Superleague (Example)")!;
    expect(found.problems).toEqual([]);
    expect(found.pkg.skillAllotment.skillPointBudget).toBe(10);
    // inherited from bb2025-default via extends
    expect(found.pkg.special.minPlayers).toBe(11);
  });
});
