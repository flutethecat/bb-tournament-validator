import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage } from "@bb/validator";
import { PackageFiles } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { packageOverview } from "../src/teamBuilderPackage";
import { type Any, bootRules, readPackage, repoRoot, type RouteHandler } from "./tournamentRulesHarness";

// After the rebase onto the ruleset-summary branch: the Creator's Summary shows the SAME overview
// (packageOverview) the coach-facing Tournament Builder renders, computed from the unsaved package.

function tempPackages(): { dir: string; files: PackageFiles } {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-overview-"));
  const source = fileURLToPath(new URL("tournament-packages/", repoRoot));
  for (const file of readdirSync(source).filter((name) => name.endsWith(".json"))) cpSync(join(source, file), join(dir, file));
  return { dir, files: new PackageFiles(dir) };
}

const api = (files: PackageFiles, method: string, path: string, body?: unknown) =>
  packagesApi(files, method, path, new URLSearchParams(), body) as { status: number; body: Any };

describe("packageOverview output is unchanged for the shipped packages (Sol r6: Set-based membership)", () => {
  // Golden captured from deploy-0818's packageOverview before the Set change (fixtures/package-overviews.json).
  const golden = JSON.parse(readFileSync(new URL("./fixtures/package-overviews.json", import.meta.url), "utf8")) as Record<string, unknown>;
  const { files } = tempPackages();
  for (const stem of Object.keys(golden)) {
    it(`${stem}`, () => {
      expect(JSON.parse(JSON.stringify(packageOverview(files.resolve(readPackage(stem)).pkg)))).toEqual(golden[stem]);
    });
  }
  it("covers every shipped tournament package", () => {
    expect(Object.keys(golden).sort()).toEqual(["bb2025-default", "eurobowl-2026", "lustrian-superleague.example", "naf-world-cup-2027", "sevens-matched-play", "small-gods", "spike-2026", "whbb-nut-cup-2026"]);
  });
});

describe("eligibleRosters is capped and checked before any derivation (Sol r6)", () => {
  const huge = { name: "Huge", skillAllotment: { skillPointBudget: 0 }, eligibleRosters: Array.from({ length: 50_000 }, (_, i) => `Team ${i}`) };

  it("50,000 names: preview and save answer 422 quickly, nothing written", () => {
    const { dir, files } = tempPackages();
    const started = Date.now();
    const preview = api(files, "POST", "/api/packages/preview", huge);
    const save = api(files, "POST", "/api/packages", huge);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(preview.status).toBe(422);
    expect(save.status).toBe(422);
    expect(preview.body.error).toBe("A package may list at most 64 eligible rosters (this one lists 50000).");
    expect(readdirSync(dir)).not.toContain("huge.json");
  });

  it("a name that is neither a dataset team nor placed in a tier is refused; a tier-only roster (Night Goblin) is fine", () => {
    const { files } = tempPackages();
    const bad = api(files, "POST", "/api/packages/preview", { name: "Typo", skillAllotment: { skillPointBudget: 0 }, eligibleRosters: ["Orc", "Orcs of Doom"] });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("Unknown eligible roster(s): Orcs of Doom.");
    expect(api(files, "POST", "/api/packages/preview", readPackage("small-gods")).status).toBe(200);
    expect(readPackage("small-gods").eligibleRosters).toContain("Night Goblin");
  });
});

describe("Summary tab reuses the coach page's packageOverview", () => {
  const { files } = tempPackages();

  it("POST /api/packages/preview returns packageOverview of the resolved document", () => {
    const raw = readPackage("whbb-nut-cup-2026");
    const result = api(files, "POST", "/api/packages/preview", raw);
    expect(result.status).toBe(200);
    expect(result.body.overview).toEqual(JSON.parse(JSON.stringify(packageOverview(loadPackage(raw).pkg))));
    expect(result.body.preview.system).toBe("tiers");
  });

  async function summaryHtml(stem: string): Promise<string> {
    const route: RouteHandler = (path, init) =>
      packagesApi(files, init.method ?? "GET", path, new URLSearchParams(), init.body ? JSON.parse(init.body) : undefined) ?? { status: 404, body: {} };
    const page = await bootRules({ authenticated: true, admin: true }, { "/api/packages/preview": route });
    page.core.loadPackageIntoEditor(readPackage(stem), []);
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return page.elements["#editor"]!.innerHTML.replace(/\s+</g, "<");
  }

  it("Small Gods: the Structure line and representative team rows", async () => {
    const html = await summaryHtml("small-gods");
    expect(html).toContain("What coaches will see (Tournament Builder)");
    expect(html).toContain(
      '<div class="overview-row" data-summary="structure"><dt>Structure</dt><dd>Tiered: 6 tiers, gold caps 1,225k–1,500k (set per roster); added skills cost gold inside the team-value cap.</dd></div>',
    );
    expect(html).toContain('<th scope="rowgroup" rowspan="5">1</th><th scope="row">Orc</th><td>1,225k</td><td>primary 20k · secondary 40k</td>');
    expect(html).toMatch(/<th scope="row">Ogre<\/th><td>1,500k<\/td><td>primary 20k · secondary 40k<\/td>/);
    expect(html).toContain("<td>Free (max 2)<br>Star (max 2)<br>Super Star (max 1)<br>Mega Star (max 1)</td>");
    expect(html).toContain("Resolution details (tier rows and per-team exceptions)");
  });

  it("WHBB Nut Cup: choose-one pack lines and a gold range", async () => {
    const html = await summaryHtml("whbb-nut-cup-2026");
    expect(html).toContain('<th scope="row">Amazon</th><td>1,100k–1,150k</td><td>1,150k · 4 skills<br>1,100k · 5 skills</td>');
    expect(html).toContain('<th scope="row">Elven Union</th><td>1,100k–1,150k</td><td>1,150k · 6 skills<br>1,100k · 7 skills</td>');
  });
});
