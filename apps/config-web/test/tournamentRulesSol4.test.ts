import { describe, expect, it } from "vitest";
import { closeSync, cpSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPackage, resolveTeamConfig } from "@bb/validator";
import { defaultPackageWriteIo, type DurableFs, PackageFiles, writeFileDurable } from "../src/data";
import { packagesApi } from "../src/packagesApi";
import { type Any, bootRules, plain, repoRoot } from "./tournamentRulesHarness";

// Sol r4 (10-27): short writes never reach the package; flat count-mode limits are three-state.

const realFs: DurableFs = {
  openSync: (path, flags) => openSync(path, flags),
  writeSync: (fd, buffer, offset, length) => writeSync(fd, buffer, offset, length),
  fsyncSync: (fd) => fsyncSync(fd),
  fstatSync: (fd) => fstatSync(fd),
  closeSync: (fd) => closeSync(fd),
};

function tempPackages(fs: DurableFs) {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-sol4-"));
  const source = fileURLToPath(new URL("tournament-packages/", repoRoot));
  for (const file of readdirSync(source).filter((name) => name.endsWith(".json"))) cpSync(join(source, file), join(dir, file));
  const files = new PackageFiles(dir, { ...defaultPackageWriteIo, writeFileDurable: (path, text) => writeFileDurable(path, text, fs) });
  return { dir, files };
}

function saveEdit(files: PackageFiles) {
  const opened = packagesApi(files, "GET", "/api/packages/Small Gods", new URLSearchParams()) as { body: Any };
  return () => files.save({ ...opened.body.raw, description: "edited" }, { ifMatch: opened.body.revision });
}

describe("1 — durable writes check every byte", () => {
  it("a writeSync that writes at most 20 bytes per call is looped to completion", () => {
    const chunks: number[] = [];
    const { dir, files } = tempPackages({ ...realFs, writeSync: (fd, buffer, offset, length) => { const n = writeSync(fd, buffer, offset, Math.min(20, length)); chunks.push(n); return n; } });
    saveEdit(files)();
    expect(chunks.length).toBeGreaterThan(10);
    expect(JSON.parse(readFileSync(join(dir, "small-gods.json"), "utf8")).description).toBe("edited");
  });

  it("a write that claims success but leaves a short file (20 of N bytes) throws; the package is intact", () => {
    const { dir, files } = tempPackages({ ...realFs, writeSync: (fd, buffer, offset, length) => { writeSync(fd, buffer, offset, Math.min(20, length)); return length; } });
    const before = readFileSync(join(dir, "small-gods.json"), "utf8");
    expect(saveEdit(files)).toThrow(/Incomplete write .*: 20 of \d+ bytes on disk/);
    expect(readFileSync(join(dir, "small-gods.json"), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("a write of 0 bytes throws instead of spinning; the package is intact", () => {
    let fsynced = false;
    const { dir, files } = tempPackages({ ...realFs, writeSync: () => 0, fsyncSync: () => { fsynced = true; } });
    const before = readFileSync(join(dir, "small-gods.json"), "utf8");
    expect(saveEdit(files)).toThrow(/Short write .*: 0 of \d+ bytes/);
    expect(fsynced).toBe(false);
    expect(readFileSync(join(dir, "small-gods.json"), "utf8")).toBe(before);
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("2 — flat count-mode Max primary / Max secondary are three-state", () => {
  const PRIMARY = ["skillAllotment", "maxPrimary"];
  const SECONDARY = ["skillAllotment", "maxSecondary"];
  const esc = (path: unknown[]) => JSON.stringify(path).replaceAll('"', "&quot;");

  async function counts() {
    const page = await bootRules({ authenticated: true, admin: true });
    page.core.loadPackageIntoEditor(plain({ name: "Counts", skillAllotment: { skillPointBudget: 0, maxPrimary: 6, maxSecondary: 1 } }), []);
    expect(page.core.state.view.skillMode).toBe("count");
    page.core.state.tab = "skills";
    return page;
  }
  const mode = (page: Any, path: unknown[], value: string) => page.core.handleEditorChange({ dataset: { overrideMode: JSON.stringify(path) }, value });
  const type = (page: Any, path: unknown[], value: string) => page.core.handleEditorChange({ dataset: { bind: JSON.stringify(path), kind: "int", blank: "delete" }, value });

  it("both render inherit / value / no limit", async () => {
    const page = await counts();
    const html = page.core.editorHtml();
    for (const path of [PRIMARY, SECONDARY]) {
      const start = html.indexOf(`data-override-mode="${esc(path)}"`);
      expect(start).toBeGreaterThan(-1);
      expect(html.slice(start, html.indexOf("</select>", start))).toMatch(/value="inherit"[\s\S]*value="set" selected[\s\S]*value="none"/);
    }
  });

  it("no limit writes null (the validator reads unlimited), value writes the number, inherit omits the key", async () => {
    const page = await counts();
    mode(page, PRIMARY, "none");
    let doc = plain(page.core.serializePackage());
    expect(doc.skillAllotment.maxPrimary).toBeNull();
    expect(resolveTeamConfig(loadPackage(doc).pkg, "Orc").maxPrimary).toBeNull();
    type(page, SECONDARY, "2");
    expect(plain(page.core.serializePackage()).skillAllotment.maxSecondary).toBe(2);
    mode(page, SECONDARY, "inherit");
    doc = plain(page.core.serializePackage());
    expect("maxSecondary" in doc.skillAllotment).toBe(false);
    // Clearing the value is inherit too — never 0.
    type(page, PRIMARY, "4");
    type(page, PRIMARY, "");
    expect("maxPrimary" in plain(page.core.serializePackage()).skillAllotment).toBe(false);
  });
});
