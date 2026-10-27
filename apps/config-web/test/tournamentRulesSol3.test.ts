import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultPackageWriteIo, PackageFiles, type PackageWriteIo } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { type Any, bootRules, plain, repoRoot, type RouteHandler } from "./tournamentRulesHarness";

// Sol r3 (10-27): one block per finding (finding 5, the preview gate, lives in
// serverPackagePreviewGate.test.ts / serverPackagePreviewNoAuth.test.ts — each needs its own server config).

function tempPackages(io?: PackageWriteIo): { dir: string; files: PackageFiles } {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-sol3-"));
  const source = fileURLToPath(new URL("tournament-packages/", repoRoot));
  for (const file of readdirSync(source).filter((name) => name.endsWith(".json"))) cpSync(join(source, file), join(dir, file));
  return { dir, files: new PackageFiles(dir, io) };
}

const api = (files: PackageFiles, method: string, path: string, body?: unknown, ifMatch?: string) =>
  packagesApi(files, method, path, new URLSearchParams(), body, { ifMatch }) as { status: number; body: Any };

function apiRoute(files: PackageFiles): RouteHandler {
  return (path, init) => {
    const [pathname, search] = path.split("?");
    const body = init.body ? JSON.parse(init.body) : undefined;
    return packagesApi(files, init.method ?? "GET", pathname!, new URLSearchParams(search ?? ""), body, { ifMatch: init.headers?.["If-Match"] }) ?? { status: 404, body: {} };
  };
}

const esc = (path: unknown[]) => JSON.stringify(path).replaceAll('"', "&quot;");

describe("1 — replacement writes are atomic", () => {
  function edit(files: PackageFiles) {
    const opened = api(files, "GET", "/api/packages/Small Gods");
    return () => files.save({ ...opened.body.raw, description: "edited" }, { ifMatch: opened.body.revision });
  }

  it("a write that fails midway leaves the old file intact and no temp file behind", () => {
    const failing: PackageWriteIo = {
      ...defaultPackageWriteIo,
      writeFileDurable(path, text) {
        writeFileSync(path, text.slice(0, 40)); // truncated temp file …
        throw new Error("disk full"); // … then the write fails
      },
    };
    const { dir, files } = tempPackages(failing);
    const before = readFileSync(join(dir, "small-gods.json"), "utf8");
    expect(edit(files)).toThrow("disk full");
    expect(readFileSync(join(dir, "small-gods.json"), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a failed rename also leaves the old file intact", () => {
    const { dir, files } = tempPackages({ ...defaultPackageWriteIo, rename: () => { throw new Error("rename refused"); } });
    const before = readFileSync(join(dir, "small-gods.json"), "utf8");
    expect(edit(files)).toThrow("rename refused");
    expect(readFileSync(join(dir, "small-gods.json"), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a successful save goes temp file → rename over the target", () => {
    const calls: string[] = [];
    const spy: PackageWriteIo = {
      writeFileDurable: (path, text) => { calls.push(`write ${path.endsWith(".tmp")}`); defaultPackageWriteIo.writeFileDurable(path, text); },
      rename: (from, to) => { calls.push(`rename ${from.endsWith(".tmp")} → ${to.endsWith("small-gods.json")}`); defaultPackageWriteIo.rename(from, to); },
      remove: defaultPackageWriteIo.remove,
    };
    const { dir, files } = tempPackages(spy);
    edit(files)();
    expect(calls).toEqual(["write true", "rename true → true"]);
    expect(JSON.parse(readFileSync(join(dir, "small-gods.json"), "utf8")).description).toBe("edited");
  });
});

describe("2 + 3 — typing a default, and three-state flat caps", () => {
  async function child() {
    const { files } = tempPackages();
    const page = await bootRules({ authenticated: true, admin: true });
    const raw = { name: "Child of Small Gods", extends: "small-gods", skillAllotment: { skillPointBudget: 0 } };
    page.core.loadPackageIntoEditor(plain(raw), []);
    page.core.state.tab = "skills";
    return { page, files, raw };
  }

  it("typing the filled default (2) into Max skills / player is saved and overrides the base's 3", async () => {
    const { page, files } = await child();
    expect(files.resolve({ name: "x", extends: "small-gods", skillAllotment: { skillPointBudget: 0 } }).pkg.skillAllotment.maxPerPlayer).not.toBe(2);
    expect(page.core.state.pkg.skillAllotment.maxPerPlayer).toBe(2); // the filled default already holds 2
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(["skillAllotment", "maxPerPlayer"]), kind: "int", blank: "delete" }, value: "2" });
    const doc = plain(page.core.serializePackage());
    expect(doc.skillAllotment.maxPerPlayer).toBe(2);
    expect(files.resolve(doc).pkg.skillAllotment.maxPerPlayer).toBe(2);
  });

  it("the flat stacked-player cap: 'no limit' writes null (unlimited); clearing the value inherits", async () => {
    const { page, files } = await child();
    const path = ["skillAllotment", "stackedPlayer", "maxSkills"];
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(path), kind: "int", blank: "delete" }, value: "5" });
    page.core.handleEditorChange({ dataset: { overrideMode: JSON.stringify(path) }, value: "none" });
    let doc = plain(page.core.serializePackage());
    expect(doc.skillAllotment.stackedPlayer).toEqual({ maxSkills: null });
    expect(files.resolve(doc).pkg.skillAllotment.stackedPlayer?.maxSkills).toBeNull();
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(path), kind: "int", blank: "delete" }, value: "5" });
    page.core.handleEditorChange({ dataset: { bind: JSON.stringify(path), kind: "int", blank: "delete" }, value: "" });
    doc = plain(page.core.serializePackage());
    expect(doc.skillAllotment.stackedPlayer).toBeUndefined();
    expect(files.resolve(doc).pkg.skillAllotment.stackedPlayer?.maxSkills).toBe(3);
  });

  it("every flat control whose null means unlimited offers inherit / value / no limit", async () => {
    const { page } = await child();
    const html = (tab: string) => { page.core.state.tab = tab; return page.core.editorHtml(); };
    const audit: [string, unknown[]][] = [
      ["skills", ["skillAllotment", "maxPerPlayer"]],
      ["skills", ["skillAllotment", "maxSameSkillTeamwide"]],
      ["skills", ["skillAllotment", "maxStackedPlayers"]],
      ["skills", ["skillAllotment", "eliteMaxTotal"]],
      ["skills", ["skillAllotment", "eliteMaxSameSkill"]],
      ["skills", ["skillAllotment", "stackedPlayer", "maxSkills"]],
      ["skills", ["skillAllotment", "stackedPlayer", "maxSecondary"]],
      ["skills", ["skillAllotment", "stackedPlayer", "maxElite"]],
      ["skills", ["statIncreases", "maxPerPlayer"]],
      ["stars", ["starPlayers", "maxCount"]],
      ["stars", ["starPlayers", "maxCombinedCost"]],
      ["package", ["goldBudget"]],
      ["special", ["sideline", "maxReRolls"]],
      ["special", ["sideline", "maxApothecary"]],
      ["special", ["sideline", "maxCheerleaders"]],
      ["special", ["sideline", "maxAssistantCoaches"]],
      ["special", ["sideline", "maxDedicatedFans"]],
    ];
    for (const [tab, path] of audit) {
      const text = html(tab);
      const start = text.indexOf(`data-override-mode="${esc(path)}"`);
      expect(start, JSON.stringify(path)).toBeGreaterThan(-1);
      const select = text.slice(start, text.indexOf("</select>", start));
      expect(select, JSON.stringify(path)).toMatch(/value="inherit"[\s\S]*value="set"[\s\S]*value="none"/);
    }
    page.core.handleEditorAction("mode-count", { dataset: {} });
    const count = html("skills");
    expect(count.slice(count.indexOf(`data-override-mode="${esc(["skillAllotment", "secondarySwapMax"])}"`))).toMatch(/^[^]*?value="none"/);
  });
});

describe("4 — resolver problems and schema numeric constraints block the write", () => {
  it("a negative cap (resolver problem) is a 422 and nothing is written", () => {
    const { dir, files } = tempPackages();
    const result = api(files, "POST", "/api/packages", { name: "Negative", skillAllotment: { skillPointBudget: 0, maxStackedPlayers: -1 } });
    expect(result.status).toBe(422);
    expect(readdirSync(dir)).not.toContain("negative.json");
  });

  it("multipleOf / integer constraints are honoured (secondarySwapRatio 1.5, eliteMaxTotal 1.5)", () => {
    const { dir, files } = tempPackages();
    const ratio = api(files, "POST", "/api/packages", { name: "Ratio", skillAllotment: { skillPointBudget: 0, secondarySwapRatio: 1.5 } });
    expect(ratio.status).toBe(422);
    expect(ratio.body.problems).toEqual(["$.skillAllotment.secondarySwapRatio: must be a multiple of 1"]);
    const elite = api(files, "POST", "/api/packages", { name: "Elite", skillAllotment: { skillPointBudget: 0, eliteMaxTotal: 1.5 } });
    expect(elite.status).toBe(422);
    expect(readdirSync(dir).filter((name) => /^(ratio|elite)\.json$/.test(name))).toEqual([]);
  });
});

describe("6 — unknown fields are flagged on open, read-only", () => {
  it("lists the unknown fields and disables Save", async () => {
    const { dir, files } = tempPackages();
    const raw = { name: "Future Cup", skillAllotment: { skillPointBudget: 0, hyperCost: 4 }, futureRule: true };
    writeFileSync(join(dir, "future-cup.json"), JSON.stringify(raw, null, 2));
    let posted = 0;
    const route: RouteHandler = (path, init) => { if (init.method === "POST" && path === "/api/packages") posted += 1; return apiRoute(files)(path, init); };
    const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" }, { "/api/packages": route, "*": route });
    await page.core.loadSavedPackage("Future Cup");
    expect(page.core.state.readOnly).toBe("This package uses fields this Creator does not know: skillAllotment.hyperCost, futureRule. Update the Creator before editing.");
    const rail = page.elements["#right-rail"]!.innerHTML;
    expect(rail).toContain("fields this Creator does not know");
    expect(rail).toMatch(/class="create-button" data-action="save" disabled/);
    await page.core.savePackage();
    expect(posted).toBe(0);
  });

  it("a known package opens editable with no preflight notice", async () => {
    const { files } = tempPackages();
    const route = apiRoute(files);
    const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" }, { "/api/packages": route, "*": route });
    await page.core.loadSavedPackage("Small Gods");
    expect(page.core.state.readOnly).toBe("");
    expect(page.core.state.problems).toEqual([]);
  });
});
