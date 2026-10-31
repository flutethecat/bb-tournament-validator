import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage, resolveTeamConfig } from "@bb/validator";
import { PackageFiles } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { packagePreview } from "../src/teamBuilderPackage";
import { type Any, bootRules, plain, readPublic, repoRoot, type RouteHandler } from "./tournamentRulesHarness";

// Sol r1 (10-27): the round-trip law must hold through the REAL save flow — the editor loads the
// package from GET /api/packages/<name>, the organiser saves via POST /api/packages, and the file
// on disk must come back unchanged. The routes run the server's own packagesApi over a PackageFiles
// rooted in a temp copy of tournament-packages/.

const PACKAGES = ["small-gods", "whbb-nut-cup-2026", "naf-world-cup-2027", "eurobowl-2026", "spike-2026", "bb2025-default", "lustrian-superleague.example"];

function tempPackages(): { dir: string; files: PackageFiles } {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-rules-"));
  const source = fileURLToPath(new URL("tournament-packages/", repoRoot));
  for (const file of readdirSync(source).filter((name) => name.endsWith(".json"))) cpSync(join(source, file), join(dir, file));
  return { dir, files: new PackageFiles(dir) };
}

function apiRoute(files: PackageFiles): RouteHandler {
  return (path, init) => {
    const [pathname, search] = path.split("?");
    const body = init.body ? JSON.parse(init.body) : undefined;
    return packagesApi(files, init.method ?? "GET", pathname!, new URLSearchParams(search ?? ""), body, { ifMatch: init.headers?.["If-Match"] }) ?? { status: 404, body: { error: "not found" } };
  };
}

async function editorOver(files: PackageFiles) {
  const route = apiRoute(files);
  const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" }, { "/api/packages": route, "*": route });
  return page;
}

function nameOf(dir: string, stem: string): string {
  return JSON.parse(readFileSync(join(dir, `${stem}.json`), "utf8")).name;
}

describe("Tournament Creator — real load → save round trip", () => {
  it("GET /api/packages/<name> carries the raw file next to the resolved package", () => {
    const { files } = tempPackages();
    const result = packagesApi(files, "GET", "/api/packages/small-gods", new URLSearchParams()) as Any;
    expect(result.status).toBe(200);
    expect(result.body.raw).toEqual(JSON.parse(readFileSync(fileURLToPath(new URL("tournament-packages/small-gods.json", repoRoot)), "utf8")));
    expect(result.body.pkg.sideline).toBeDefined(); // resolved view keeps its defaults for the coach page
    expect(result.body.raw.sideline).toBeUndefined();
  });

  for (const stem of PACKAGES) {
    it(`${stem}.json is unchanged after open + save in the editor`, async () => {
      const { dir, files } = tempPackages();
      const before = readFileSync(join(dir, `${stem}.json`), "utf8");
      const page = await editorOver(files);
      await page.core.loadSavedPackage(nameOf(dir, stem));
      await page.core.savePackage();
      expect(page.core.state.problems).toEqual([]);
      expect(page.core.state.saved).toBeTruthy();
      const after = readFileSync(join(dir, `${stem}.json`), "utf8");
      expect(JSON.parse(after)).toEqual(JSON.parse(before)); // deep-equal (law); key order is kept too
      expect(Object.keys(JSON.parse(after))).toEqual(Object.keys(JSON.parse(before)));
      expect(readdirSync(dir).length).toBe(readdirSync(fileURLToPath(new URL("tournament-packages/", repoRoot))).filter((n) => n.endsWith(".json")).length);
    });
  }

  it("the example's `extends` resolves on save (no unresolved-extends problem, no inherited keys written)", async () => {
    const { dir, files } = tempPackages();
    const page = await editorOver(files);
    await page.core.loadSavedPackage(nameOf(dir, "lustrian-superleague.example"));
    await page.core.savePackage();
    expect(page.core.state.problems.filter((p: string) => p.includes("extends"))).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "lustrian-superleague.example.json"), "utf8"))._notes).toBeUndefined();
  });

  it("an edit changes only the edited key in the file, and a second save keeps it", async () => {
    const { dir, files } = tempPackages();
    const before = JSON.parse(readFileSync(join(dir, "small-gods.json"), "utf8"));
    const page = await editorOver(files);
    await page.core.loadSavedPackage(before.name);
    page.core.state.tab = "special";
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(["sideline", "maxReRolls"]), kind: "int", blank: "null" }, value: "6" });
    await page.core.savePackage();
    expect(page.core.state.problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "small-gods.json"), "utf8"))).toEqual({ ...before, sideline: { maxReRolls: 6 } });
    await page.core.savePackage();
    expect(JSON.parse(readFileSync(join(dir, "small-gods.json"), "utf8"))).toEqual({ ...before, sideline: { maxReRolls: 6 } });
  });

  it("a new package is written to <name-stem>.json exactly as the editor sent it", () => {
    const { dir, files } = tempPackages();
    const doc = { name: "Brand New Cup", skillAllotment: { skillPointBudget: 3 } };
    const result = packagesApi(files, "POST", "/api/packages", new URLSearchParams(), doc) as Any;
    expect(result.status).toBe(200);
    expect(result.body.problems).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "brand-new-cup.json"), "utf8"))).toEqual(doc);
  });
});

describe("Tournament Creator — Sol r1 fixes", () => {
  async function editor(raw: Record<string, unknown>) {
    const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" });
    page.core.loadPackageIntoEditor(plain(raw), []);
    return page;
  }
  const resolved = (doc: Any, race: string) => resolveTeamConfig(loadPackage(doc).pkg, race);

  it("an override can be explicitly 'no limit' (null) — a team rule lifts a flat elite cap", async () => {
    const page = await editor({
      name: "Null overrides",
      skillAllotment: { skillPointBudget: 6, eliteMaxTotal: 2 },
      teamRules: [{ team: "Orc" }],
      tiers: [{ tier: 1, rosters: ["Orc"], gold: 1000000, starPlayersAllowed: true, bannedStars: [] }],
    });
    page.core.state.tab = "races";
    const html = page.core.editorHtml();
    const path = JSON.stringify(["teamRules", 0, "eliteMaxTotal"]).replaceAll('"', "&quot;");
    expect(html).toContain(`data-override-mode="${path}"`);
    expect(html).toMatch(new RegExp(`data-override-mode="${path.replace(/[[\]]/g, "\\$&")}"[^>]*>[\\s\\S]*?<option value="none"`));
    page.core.handleEditorChange({ dataset: { overrideMode: JSON.stringify(["teamRules", 0, "eliteMaxTotal"]) }, value: "none" });
    const doc = plain(page.core.serializePackage());
    expect(doc.teamRules[0].eliteMaxTotal).toBeNull();
    expect(resolved(doc, "Orc").eliteMaxTotal).toBeNull();
    page.core.handleEditorChange({ dataset: { overrideMode: JSON.stringify(["teamRules", 0, "eliteMaxTotal"]) }, value: "inherit" });
    expect(resolved(plain(page.core.serializePackage()), "Orc").eliteMaxTotal).toBe(2);
    page.core.handleEditorChange({ dataset: { overrideMode: JSON.stringify(["tiers", 0, "stackedPlayer", "maxSkills"]) }, value: "set" });
    expect(plain(page.core.serializePackage()).tiers[0].stackedPlayer).toEqual({ maxSkills: 0 });
  });

  it("stat exclusivity can be overridden to false under a flat true", async () => {
    const page = await editor({
      name: "Exclusive",
      skillAllotment: { skillPointBudget: 0 },
      statIncreases: { allowed: ["MA"], exclusiveWithSkills: true },
      teamRules: [{ team: "Orc" }],
    });
    page.core.state.tab = "races";
    expect(page.core.editorHtml()).toContain(`data-bind="${JSON.stringify(["teamRules", 0, "statIncreases", "exclusiveWithSkills"]).replaceAll('"', "&quot;")}" data-kind="tri"`);
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(["teamRules", 0, "statIncreases", "exclusiveWithSkills"]), kind: "tri" }, value: "false" });
    const doc = plain(page.core.serializePackage());
    expect(doc.teamRules[0].statIncreases).toEqual({ exclusiveWithSkills: false });
    expect(resolved(doc, "Orc").statIncreases?.exclusiveWithSkills).toBe(false);
    expect(resolved(doc, "Halfling").statIncreases?.exclusiveWithSkills).toBe(true);
  });

  it("clearing minimum players restores the default (key omitted, validator sees 11)", async () => {
    const page = await editor({ name: "Min", skillAllotment: { skillPointBudget: 0 }, special: { minPlayers: 11, stalling: true } });
    const set = (value: string) => page.core.handleEditorChange({ dataset: { bind: JSON.stringify(["special", "minPlayers"]), kind: "int", blank: "delete" }, value });
    page.core.state.tab = "special";
    expect(page.core.editorHtml()).toMatch(/data-bind="\[&quot;special&quot;,&quot;minPlayers&quot;\]" data-kind="int" data-blank="delete"/);
    set("10");
    expect(plain(page.core.serializePackage()).special.minPlayers).toBe(10);
    set("");
    const doc = plain(page.core.serializePackage());
    expect(doc.special).toEqual({ stalling: true });
    expect(loadPackage(doc).pkg.special.minPlayers).toBe(11);
  });

  it("re-clicking the active system or pricing mode keeps global packs / swap settings", async () => {
    const raw = {
      name: "Tiers + global packs",
      skillAllotment: { skillPointBudget: 0, secondarySwap: true },
      skillPackages: [{ label: "A", gold: 1100000, skillPointBudget: 2 }],
      tiers: [{ tier: 1, rosters: ["Orc"], gold: 1000000, starPlayersAllowed: true, bannedStars: [] }],
    };
    const page = await editor(raw);
    expect(page.core.state.view.system).toBe("tiers");
    page.core.handleEditorAction("system-tiers", { dataset: {} });
    page.core.handleEditorAction("mode-pool", { dataset: {} });
    expect(plain(page.core.serializePackage())).toEqual(raw);
    // An excursion and back keeps the loaded blocks and drops only what the excursion made.
    page.core.handleEditorAction("system-matrix", { dataset: {} });
    page.core.handleEditorAction("system-tiers", { dataset: {} });
    page.core.handleEditorAction("mode-count", { dataset: {} });
    page.core.handleEditorAction("mode-pool", { dataset: {} });
    expect(plain(page.core.serializePackage())).toEqual(raw);
    // A real switch still drops the other system.
    page.core.handleEditorAction("system-packages", { dataset: {} });
    expect(plain(page.core.serializePackage()).tiers).toBeUndefined();
  });

  it("every inducement (fixed ones too) has an editable cap showing the package value", async () => {
    const page = await editor({ name: "Caps", skillAllotment: { skillPointBudget: 0 }, inducements: { allowed: ["halfling_master_chef"], caps: { halfling_master_chef: 2 } } });
    page.core.state.tab = "inducements";
    const html = page.core.editorHtml();
    const chefRow = html.slice(html.indexOf('data-id="halfling_master_chef"'), html.indexOf("Halfling Master Chef") + 600);
    expect(chefRow).toContain("0-2");
    expect(html).toContain('data-action="step-inducement" data-id="halfling_master_chef" data-delta="1"');
    expect(html).toContain('data-action="step-inducement" data-id="weather_mage" data-delta="-1"');
    page.core.handleEditorAction("step-inducement", { dataset: { id: "halfling_master_chef", delta: "1" } });
    expect(plain(page.core.serializePackage()).inducements.caps).toEqual({ halfling_master_chef: 3 });
  });

  it("the Summary preview is the server's resolution: matrix cells, team rules, and no stale tiers after a switch", async () => {
    const { files } = tempPackages();
    const route = apiRoute(files);
    const page = await bootRules({ authenticated: true, admin: true }, { "/api/packages": route, "*": route });
    page.core.loadPackageIntoEditor({
      name: "Preview",
      skillAllotment: { skillPointBudget: 0 },
      tiers: [{ tier: 1, label: "Tier 1", rosters: ["Orc", "High Elf"], gold: 1225000, rosterGold: { "High Elf": 1260000 }, starPlayersAllowed: true, bannedStars: [] }],
      teamRules: [{ team: "Orc", gold: 1300000, starPlayersAllowed: false }],
    }, []);
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    let editorHtml = page.elements["#editor"]!.innerHTML;
    expect(page.fetched).toContain("/api/packages/preview");
    expect(editorHtml).toContain("<th>Tier 1</th>");
    expect(editorHtml).toContain("Orc 1225k, High Elf 1260k");
    expect(editorHtml).toContain("<th>Orc</th><td>team rule</td><td>1300k</td>");

    // Switch to a matrix: the tiers vanish from the preview, the cell's team shows its cell rules.
    page.core.handleEditorAction("system-matrix", { dataset: {} });
    page.core.handleEditorAction("toggle-matrix-cell", { dataset: { row: "0", col: "0" } }); // default grid ships no cells
    page.core.handleEditorChange({ dataset: { multi: JSON.stringify(["matrix", "cells", 0, "teams"]), value: "Halfling" }, checked: true });
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    editorHtml = page.elements["#editor"]!.innerHTML;
    expect(editorHtml).not.toContain("<th>Tier 1</th>");
    expect(editorHtml.replace(/\s+</g, "<")).toContain("<th>Halfling</th><td>6 pri / 0 sec @ 1150k</td><td>1150k</td><td>6 primary + 0 secondary</td>");
  });

  it("packagePreview reports matrix and team-rule exceptions from resolveTeamConfig", () => {
    const { pkg } = loadPackage({
      name: "Unit",
      skillAllotment: { skillPointBudget: 4 },
      matrix: { columns: [{ gold: 1100000 }], rows: [{ primary: 5, secondary: 1, secondarySwap: false, label: "5+1" }], cells: [{ col: 0, row: 0, teams: ["Orc"] }] },
      teamRules: [{ team: "Orc", gold: 1050000 }, { team: "Dwarf", maxSecondary: null }],
    });
    const preview = packagePreview(pkg);
    expect(preview.system).toBe("matrix");
    expect(preview.tiers).toEqual([]);
    expect(preview.exceptions.map((e) => [e.roster, e.source, e.gold])).toEqual([["Orc", "team", 1050000], ["Dwarf", "team", null]]);
  });

  it("the light theme inks green text darker and keeps active race chips on the theme text colour", () => {
    const css = readPublic("tournament-rules.css");
    expect(css).toMatch(/:root\[data-theme="light"\] \{[^}]*--success-ink: #015c27;/);
    expect(css).toContain(".star-column.allowed .star-column-title { color: var(--success-ink); }");
    expect(css).toMatch(/\.race-chip\.active \{[^}]*color: var\(--text\); \}/);
    expect(css).not.toContain('[data-theme="light"] .race-chip.active');
  });
});
