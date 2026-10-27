import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackage } from "@bb/validator";
import { PackageFiles } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { packageOverview } from "../src/teamBuilderPackage";
import { type Any, bootRules, readPackage, type RouteHandler } from "./tournamentRulesHarness";

// After the rebase onto the ruleset-summary branch: the Creator's Summary shows the SAME overview
// (packageOverview) the coach-facing Tournament Builder renders, computed from the unsaved package.
describe("Summary tab reuses the coach page's packageOverview", () => {
  const files = new PackageFiles(mkdtempSync(join(tmpdir(), "bbtv-overview-")));

  it("POST /api/packages/preview returns packageOverview of the resolved document", () => {
    const raw = readPackage("whbb-nut-cup-2026");
    const result = packagesApi(files, "POST", "/api/packages/preview", new URLSearchParams(), raw) as { status: number; body: Any };
    expect(result.status).toBe(200);
    expect(result.body.overview).toEqual(JSON.parse(JSON.stringify(packageOverview(loadPackage(raw).pkg))));
    expect(result.body.preview.system).toBe("tiers");
  });

  it("the Summary renders the overview's highlights and one row per team, with the resolution details below", async () => {
    const route: RouteHandler = (path, init) =>
      packagesApi(files, init.method ?? "GET", path, new URLSearchParams(), init.body ? JSON.parse(init.body) : undefined) ?? { status: 404, body: {} };
    const page = await bootRules({ authenticated: true, admin: true }, { "/api/packages/preview": route });
    const raw = readPackage("small-gods");
    page.core.loadPackageIntoEditor(raw, []);
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const html = page.elements["#editor"]!.innerHTML.replace(/\s+</g, "<");
    const overview = packageOverview(loadPackage(raw).pkg);
    expect(html).toContain("What coaches will see (Tournament Builder)");
    for (const line of overview.summary) expect(html).toContain(`<div class="overview-row" data-summary="${line.key}"><dt>${line.label}</dt>`);
    const teamRows = (html.match(/<th scope="row">/g) ?? []).length;
    expect(teamRows).toBeGreaterThanOrEqual(overview.groups.reduce((n, g) => n + g.teams.length, 0));
    expect(html).toContain("Resolution details (tier rows and per-team exceptions)");
  });
});
