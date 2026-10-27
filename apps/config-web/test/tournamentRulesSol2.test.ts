import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage } from "@bb/validator";
import { PackageFiles } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { type Any, bootRules, plain, repoRoot, type RouteHandler } from "./tournamentRulesHarness";

// Sol r2 (10-27): one block per finding.

function tempPackages(): { dir: string; files: PackageFiles } {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-sol2-"));
  const source = fileURLToPath(new URL("tournament-packages/", repoRoot));
  for (const file of readdirSync(source).filter((name) => name.endsWith(".json"))) cpSync(join(source, file), join(dir, file));
  return { dir, files: new PackageFiles(dir) };
}

const api = (files: PackageFiles, method: string, path: string, body?: unknown, ifMatch?: string, query = "") =>
  packagesApi(files, method, path, new URLSearchParams(query), body, { ifMatch }) as { status: number; body: Any };

function apiRoute(files: PackageFiles): RouteHandler {
  return (path, init) => {
    const [pathname, search] = path.split("?");
    const body = init.body ? JSON.parse(init.body) : undefined;
    return packagesApi(files, init.method ?? "GET", pathname!, new URLSearchParams(search ?? ""), body, { ifMatch: init.headers?.["If-Match"] }) ?? { status: 404, body: {} };
  };
}

async function editorOver(files: PackageFiles) {
  const route = apiRoute(files);
  return bootRules({ authenticated: true, admin: true, coach: "Jay" }, { "/api/packages": route, "*": route });
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");
const tier = (n: number, rosters: string[] = []) => ({ tier: n, label: `Tier ${n}`, rosters, gold: 1000000, starPlayersAllowed: true, bannedStars: [] });

describe("1 — a save never overwrites a file it did not explicitly target", () => {
  it("a name that sanitises onto another package's file is a 409, and the file is untouched", () => {
    const { dir, files } = tempPackages();
    const before = read(dir, "small-gods.json");
    const result = api(files, "POST", "/api/packages", { name: "small/gods", skillAllotment: { skillPointBudget: 0 } });
    expect(result.status).toBe(409);
    expect(result.body.error).toMatch(/small-gods\.json already holds the package "Small Gods"/);
    expect(read(dir, "small-gods.json")).toBe(before);
  });

  it("the same canonical name replaces the file only with the current revision (If-Match)", () => {
    const { dir, files } = tempPackages();
    const opened = api(files, "GET", "/api/packages/Small Gods");
    const doc = { ...opened.body.raw, description: "edited" };
    expect(api(files, "POST", "/api/packages", doc).status).toBe(409); // no revision
    const stale = api(files, "POST", "/api/packages", doc, "0".repeat(64));
    expect(stale.status).toBe(409);
    expect(stale.body.revision).toBe(opened.body.revision);
    const ok = api(files, "POST", "/api/packages", doc, opened.body.revision);
    expect(ok.status).toBe(200);
    expect(JSON.parse(read(dir, "small-gods.json")).description).toBe("edited");
    expect(ok.body.revision).not.toBe(opened.body.revision);
  });

  it("an explicit ?replace=<name> may rename a package in place", () => {
    const { dir, files } = tempPackages();
    const opened = api(files, "GET", "/api/packages/Small Gods");
    const result = api(files, "POST", "/api/packages", { ...opened.body.raw, name: "Small Gods II" }, opened.body.revision, "replace=Small Gods");
    expect(result.status).toBe(200);
    expect(JSON.parse(read(dir, "small-gods.json")).name).toBe("Small Gods II");
    expect(api(files, "POST", "/api/packages", { name: "X", skillAllotment: { skillPointBudget: 0 } }, undefined, "replace=Nope").status).toBe(409);
  });
});

describe("2 — at most 10 tiers, sane caps, and an organiser-only preview", () => {
  const eleven = { name: "Eleven", skillAllotment: { skillPointBudget: 0 }, tiers: Array.from({ length: 11 }, (_, i) => tier(i + 1)) };

  it("an 11th tier is refused on save (422) and on preview (422)", () => {
    const { dir, files } = tempPackages();
    const saved = api(files, "POST", "/api/packages", eleven);
    expect(saved.status).toBe(422);
    expect(saved.body.error).toBe("A package may have at most 10 tiers (this one has 11).");
    expect(readdirSync(dir)).not.toContain("eleven.json");
    const preview = api(files, "POST", "/api/packages/preview", eleven);
    expect(preview.status).toBe(422);
    expect(preview.body.error).toMatch(/at most 10 tiers/);
    expect(api(files, "POST", "/api/packages/preview", { ...eleven, tiers: eleven.tiers.slice(0, 10) }).status).toBe(200);
  });

  it("the schema itself caps tiers at 10", () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL("schemas/tournament-package.schema.json", repoRoot)), "utf8"));
    expect(schema.properties.tiers.maxItems).toBe(10);
  });

  it("other sanity caps: rosters per tier, team rules, packs", () => {
    const { files } = tempPackages();
    const base = { name: "Caps", skillAllotment: { skillPointBudget: 0 } };
    expect(api(files, "POST", "/api/packages/preview", { ...base, tiers: [tier(1, Array.from({ length: 65 }, (_, i) => `Race ${i}`))] }).status).toBe(422);
    expect(api(files, "POST", "/api/packages/preview", { ...base, teamRules: Array.from({ length: 129 }, (_, i) => ({ team: `Race ${i}` })) }).status).toBe(422);
    expect(api(files, "POST", "/api/packages/preview", { ...base, skillPackages: Array.from({ length: 33 }, () => ({ gold: 1, skillPointBudget: 0 })) }).status).toBe(422);
  });

  it("a package at every cap previews quickly and under the 1 MiB response cap", () => {
    const { files } = tempPackages();
    const doc = {
      name: "At the caps",
      skillAllotment: { skillPointBudget: 0 },
      tiers: Array.from({ length: 10 }, (_, t) => tier(t + 1, Array.from({ length: 64 }, (_, r) => `Race ${t}-${r}`))),
      teamRules: Array.from({ length: 128 }, (_, i) => ({ team: `Race ${i % 10}-${i % 64}`, gold: 1000000 })),
    };
    const started = Date.now();
    const result = api(files, "POST", "/api/packages/preview", doc);
    expect(result.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(Buffer.byteLength(JSON.stringify(result.body))).toBeLessThan(1024 * 1024);
  });

  it("the Creator offers no 11th Add Tier", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    page.core.loadPackageIntoEditor({ name: "Ten", skillAllotment: { skillPointBudget: 0 }, tiers: Array.from({ length: 10 }, (_, i) => tier(i + 1)) }, []);
    page.core.state.tab = "races";
    const html = page.core.editorHtml();
    expect(html).not.toContain('data-action="add-tier"');
    expect(html).toContain("A package may have at most 10 tiers.");
    page.core.handleEditorAction("add-tier", { dataset: {} });
    expect(page.core.state.pkg.tiers).toHaveLength(10);
  });
});

describe("3 — malformed documents are refused before anything is written", () => {
  it("a tier missing required fields is a 422 with problems, and no file", () => {
    const { dir, files } = tempPackages();
    const result = api(files, "POST", "/api/packages", { name: "Broken", skillAllotment: { skillPointBudget: 0 }, tiers: [{ tier: 1 }] });
    expect(result.status).toBe(422);
    expect(result.body.problems).toEqual(expect.arrayContaining(["$.tiers[0]: missing rosters"]));
    expect(readdirSync(dir)).not.toContain("broken.json");
  });

  it("an unresolved extends is refused (422), not written with a problem", () => {
    const { dir, files } = tempPackages();
    const result = api(files, "POST", "/api/packages", { name: "Orphan", extends: "no-such-package", skillAllotment: { skillPointBudget: 0 } });
    expect(result.status).toBe(422);
    expect(result.body.error).toMatch(/extends "no-such-package"/);
    expect(readdirSync(dir)).not.toContain("orphan.json");
  });

  it("preview answers a malformed document with 422, never a 500", () => {
    const { files } = tempPackages();
    const result = api(files, "POST", "/api/packages/preview", { name: "Bad", skillAllotment: { skillPointBudget: 0 }, tiers: "bad" });
    expect(result.status).toBe(422);
    expect(api(files, "POST", "/api/packages/preview", [1, 2]).status).toBe(400);
  });

  it("a file on disk that no longer resolves opens as a 422 carrying its raw text", () => {
    const { dir, files } = tempPackages();
    writeFileSync(join(dir, "broken.json"), JSON.stringify({ name: "Broken", skillAllotment: { skillPointBudget: 0 }, tiers: [{ tier: 1 }] }));
    const result = api(files, "GET", "/api/packages/Broken");
    expect(result.status).toBe(422);
    expect(result.body.raw.name).toBe("Broken");
  });
});

describe("4 — concurrent organisers", () => {
  it("the second save of the same opened revision gets 409 and a reload prompt", async () => {
    const { dir, files } = tempPackages();
    const first = await editorOver(files);
    const second = await editorOver(files);
    await first.core.loadSavedPackage("Small Gods");
    await second.core.loadSavedPackage("Small Gods");
    first.core.handleEditorChange({ dataset: { field: "description" }, value: "first" });
    await first.core.savePackage();
    expect(first.core.state.problems).toEqual([]);
    second.core.handleEditorChange({ dataset: { field: "description" }, value: "second" });
    await second.core.savePackage();
    expect(second.core.state.conflict).toMatch(/changed on the server/);
    expect(second.elements["#right-rail"]!.innerHTML).toContain('data-action="reload-package"');
    expect(JSON.parse(read(dir, "small-gods.json")).description).toBe("first");
    // The first editor saves again on top of its own new revision.
    first.core.handleEditorChange({ dataset: { field: "description" }, value: "first again" });
    await first.core.savePackage();
    expect(JSON.parse(read(dir, "small-gods.json")).description).toBe("first again");
  });
});

describe("5 — an explicit value equal to a default is kept; defaults show as placeholders", () => {
  it("a child of bb2025-default can set stars to unlimited (null) over the base's 2", async () => {
    const { files } = tempPackages();
    const page = await bootRules({ authenticated: true, admin: true });
    const raw = { name: "Child", extends: "bb2025-default", skillAllotment: { skillPointBudget: 0 } };
    page.core.loadPackageIntoEditor(plain(raw), []);
    page.core.state.tab = "stars";
    const html = page.core.editorHtml();
    expect(html).toMatch(/data-field="starMaxCount" type="number" min="0" value="" placeholder="inherited from bb2025-default"/);
    page.core.handleEditorChange({ dataset: { field: "starMaxCount" }, value: "3" });
    page.core.handleEditorChange({ dataset: { field: "starMaxCount" }, value: "" });
    const doc = plain(page.core.serializePackage());
    expect(doc.starPlayers).toEqual({ maxCount: null });
    expect(files.resolve(doc).pkg.starPlayers.maxCount).toBeNull();
    expect(files.resolve(raw).pkg.starPlayers.maxCount).toBe(2);
  });

  it("an untouched default still is not written", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    const raw = { name: "Child", extends: "bb2025-default", skillAllotment: { skillPointBudget: 0 } };
    page.core.loadPackageIntoEditor(plain(raw), []);
    page.core.handleEditorChange({ dataset: { field: "description" }, value: "x" });
    expect(plain(page.core.serializePackage())).toEqual({ ...raw, description: "x" });
  });
});

describe("6 — a detour and back restores the loaded values", () => {
  it("explicit count-mode nulls survive pool → count → pool", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    const raw = { name: "Nulls", skillAllotment: { skillPointBudget: 4, maxPrimary: null, maxSecondary: null } };
    page.core.loadPackageIntoEditor(plain(raw), []);
    expect(page.core.state.view.skillMode).toBe("pool");
    page.core.handleEditorAction("mode-count", { dataset: {} });
    page.core.handleEditorAction("mode-pool", { dataset: {} });
    expect(plain(page.core.serializePackage())).toEqual(raw);
  });

  it("tiers: [] plus a tier added during a detour serialises back to tiers: []", async () => {
    const page = await bootRules({ authenticated: true, admin: true });
    const raw = { name: "Empty tiers", skillAllotment: { skillPointBudget: 4 }, tiers: [] };
    page.core.loadPackageIntoEditor(plain(raw), []);
    expect(page.core.state.view.system).toBe("skillpoints");
    page.core.handleEditorAction("system-tiers", { dataset: {} });
    page.core.handleEditorAction("add-tier", { dataset: {} });
    page.core.handleEditorAction("system-skillpoints", { dataset: {} });
    expect(plain(page.core.serializePackage())).toEqual(raw);
  });
});

describe("7 — the Summary reports count limits as N primary + S secondary", () => {
  async function summary(raw: Record<string, unknown>) {
    const { files } = tempPackages();
    const route = apiRoute(files);
    const page = await bootRules({ authenticated: true, admin: true }, { "/api/packages/preview": route });
    page.core.loadPackageIntoEditor(raw, []);
    page.core.handleEditorAction("tab:summary", { dataset: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return page.elements["#editor"]!.innerHTML.replace(/\s+</g, "<");
  }

  it("a tier with 6 primary / 1 secondary", async () => {
    const html = await summary({ name: "Counts", skillAllotment: { skillPointBudget: 0 }, tiers: [{ ...tier(1, ["Orc"]), maxPrimary: 6, maxSecondary: 1 }] });
    expect(html).toContain("<td>Orc 1000k</td><td>6 primary + 1 secondary</td>");
  });

  it("a flat count-mode package (no SP budget shown)", async () => {
    const html = await summary({ name: "Flat counts", skillAllotment: { skillPointBudget: 0, maxPrimary: 5, maxSecondary: 2 } });
    expect(html).toContain("<td>5 primary + 2 secondary</td>");
    expect(html).not.toContain("<td>0 SP</td>");
  });
});

describe("9 — an older server without `raw` opens read-only", () => {
  it("refuses to save instead of writing the resolved package", async () => {
    const { files } = tempPackages();
    let posted = 0;
    const route: RouteHandler = (path, init) => {
      if (init.method === "POST") posted += 1;
      const result = apiRoute(files)(path, init);
      if (path.startsWith("/api/packages/") && init.method !== "POST") {
        const { raw: _raw, revision: _revision, ...rest } = result.body as Record<string, unknown>;
        return { status: result.status, body: rest };
      }
      return result;
    };
    const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" }, { "/api/packages": route, "*": route });
    await page.core.loadSavedPackage("Small Gods");
    expect(page.core.state.readOnly).toMatch(/server does not send the package file/);
    expect(page.elements["#right-rail"]!.innerHTML).toMatch(/class="create-button" data-action="save" disabled/);
    const before = posted;
    await page.core.savePackage();
    expect(posted).toBe(before);
  });
});

describe("8 — validator: an inherited unlimited maxPerPlayer stays unlimited", () => {
  it("is enforced through loadPackage (see packages/bb-validator/test/statIncreaseInherit.test.ts)", async () => {
    const { resolveTeamConfig } = await import("@bb/validator");
    const { pkg } = loadPackage({
      name: "Stat",
      skillAllotment: { skillPointBudget: 0 },
      statIncreases: { allowed: ["MA"], maxPerPlayer: null },
      teamRules: [{ team: "Orc", statIncreases: { exclusiveWithSkills: true } }],
    });
    expect(resolveTeamConfig(pkg, "Orc").statIncreases?.maxPerPlayer).toBeNull();
  });
});
