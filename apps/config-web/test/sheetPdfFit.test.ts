import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { extractPdfPages } from "../../../packages/bb-ingest/src/pdf/extractText.js";
// @ts-expect-error plain ES module fixture (shared with the owner's before/after renders)
import { EMERALD_RULESET, WORST_RULESET, emeraldWardens, solOverflow, worstCase } from "./fixtures/sheetFitModels.mjs";

// ONE PAGE, ALWAYS (owner 11-09): public/sheet-pdf.js compresses the TOURNAMENT RULESET box and fits every team sheet on
// one A4 landscape page (density levels, then a uniform scale as the last resort). The vendored pdfmake runs here in a
// bare vm context (no DOM), exactly as the browser loads it.
/* eslint-disable @typescript-eslint/no-explicit-any */
const publicDir = new URL("../public/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, publicDir), "utf8");
function loadContext(): any {
  const ctx: any = { console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Buffer, URL, Blob, atob, btoa, navigator: { userAgent: "node" } };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  createContext(ctx);
  for (const file of ["vendor/pdfmake/pdfmake.min.js", "vendor/pdfmake/vfs_fonts.js", "team-builder.js", "sheet-pdf.js"]) runInContext(read(file), ctx);
  return ctx;
}
const ctx = loadContext();
const SheetPdf = ctx.SheetPdf;
const core = ctx.TeamBuilderCore;
const opts = { gold: core.gold, generatedOn: "2026-11-09" };
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)); // vm-realm data, as the browser hands it over
const emerald = () => plain(emeraldWardens(core));
const worst = () => plain(worstCase(core));
/** Worse than any real team: the worst case with every row carrying a long custom rule (forces the uniform scale, above its readable floor). */
function beyondFloor() {
  const model: any = worst();
  const rule = (i: number) => ({ kind: i % 2 ? "rule" : "trait", name: `Ancient Oath ${i}`, description: "When this player is activated, roll a D6 and consult the oath table; on a 4+ they may ignore the first Tackle Zone they leave this turn. ".repeat(3) });
  for (const row of model.rows) row.specialRules = [0].map(rule);
  return model;
}
const pagesText = async (bytes: Uint8Array) => (await extractPdfPages(bytes)).map((p) => p.lines.map((l) => l.text).join("\n").replace(/​/g, ""));
/** Every font size anywhere in a definition (styles, defaultStyle, node fontSize). */
function fontSizes(def: any): number[] {
  const out: number[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.fontSize === "number" && node.id !== "sheet-end") out.push(node.fontSize);
    for (const value of Object.values(node)) walk(value);
  };
  walk({ content: def.content, styles: def.styles, defaultStyle: def.defaultStyle });
  return out;
}

describe("the owner's export: Emerald Wardens (11 High Elves, NAF World Cup 2027) on ONE page", () => {
  it("the compact ruleset box: shorter labels, SP budget + prices merged, every value whole", () => {
    const rows = SheetPdf.compactRulesetRows(SheetPdf.rulesetRows(emerald()));
    expect(rows.map((r: any) => [r.label, r.value])).toEqual([
      ["Package", "NAF World Cup 2027 (Malta) - Rules Pack V3.0"],
      ["Tier", "Gold Budget 1,100,000"],
      ["TV cap", "1,100k"],
      ["SP budget", "44 SP (primary 6 · secondary 10 · elite +2 · stacking +2)"],
      ["Skills / player", "max 2"],
      ["Stacked players", "max 1 (max 2 skills · max 2 secondary)"],
      ["Star players", "None"],
      ["League / rule", "Elven Kingdoms League"],
    ]);
    // long values take a full line of the box, short ones pair up: 9 source rows on 5 lines (it was 5 lines of
    // 2-4 wrapped rows each in the 330 pt box)
    const lines = SheetPdf.rulesetBoxModel(emerald());
    expect(lines.map((l: any) => l.rows.map((r: any) => r.label))).toEqual([
      ["Package"], ["Tier", "TV cap"], ["SP budget"], ["Skills / player", "Stacked players"], ["Star players", "League / rule"],
    ]);
    expect(lines.filter((l: any) => l.full).map((l: any) => l.rows[0].label)).toEqual(["Package", "SP budget"]);
  });

  it("fits at level 0 in one layout; the real PDF is one page with all 11 players, the keywords and every box value on one line", async () => {
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, emerald(), opts);
    expect(result).toMatchObject({ level: 0, scale: 1, pages: 1, fitted: true, layouts: 1 });
    const pages = await pagesText(new Uint8Array(result.buffer));
    expect(pages).toHaveLength(1);
    const text = pages[0]!;
    for (const name of ["Cythera Silversong", "Sylvia Starbrook", "Naerdil Swiftweaver", "Lariel Leafshade", "Maethor Starsong"]) expect(text).toContain(name);
    expect(text).toMatch(/(^|\n)10 Lariel Leafshade/);
    expect(text).toMatch(/(^|\n)11 Maethor Starsong/);
    expect(text).toContain("Keywords: Dragon Prince: Blitzer, Elf, Runner");
    expect(text).toContain("Page 1 / 1");
    // each box value prints whole on one line (none wraps in the wider box)
    const lines = text.split("\n");
    for (const value of ["NAF World Cup 2027 (Malta) - Rules Pack V3.0", "44 SP (primary 6 · secondary 10 · elite +2 · stacking +2)", "max 1 (max 2 skills · max 2 secondary)", "Elven Kingdoms League"]) {
      expect(lines.some((line) => line.includes(value)), value).toBe(true);
    }
  }, 30_000);
});

describe("worst case: 16 rows, 30-character names, 4-5 skills each, stars, custom star rules, long package", () => {
  it("one page; every row, name, skill, star rule, ruleset value, inducement and keyword is on it", async () => {
    const model = worst();
    expect(model.rows).toHaveLength(16);
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, model, opts);
    expect(result.pages).toBe(1);
    expect(result.fitted).toBe(true);
    expect(result.level).toBeGreaterThan(0);
    expect(result.layouts).toBeLessThanOrEqual(12);
    const pages = await pagesText(new Uint8Array(result.buffer));
    expect(pages).toHaveLength(1);
    // pdf text extraction splits glyph runs at hyphens and soft breaks: compare without whitespace
    const squash = (value: string) => value.replace(/\s+/g, "");
    const text = squash(pages[0]!);
    for (let n = 1; n <= 16; n++) expect(pages[0]).toMatch(new RegExp(`(^|\\n)${n} `));
    for (const row of model.rows) {
      expect(text).toContain(squash(row.name || row.position));
      for (const skill of row.printed) expect(text).toContain(squash(skill));
    }
    for (const [, value] of WORST_RULESET) expect(text).toContain(squash(value.replace(/→/g, "->")));
    for (const item of model.inducements) expect(text).toContain(squash(item.label));
    for (const rule of model.specialRules) expect(text).toContain(squash(rule).slice(0, 24)); // a wrapped band line interleaves with its neighbours
    expect(text).toContain("VerdantWrath");
    expect(text).toContain(squash("the reroll cannot be used during a Blitz."));
    expect(text).toContain(squash("Custom Star: The Emerald Executioner: Blitzer, Elf"));
    expect(text).toContain("Page1/1");
  }, 30_000);

  it("the floor holds: no font below 6.5 pt at any density level (only the last-resort scale goes lower)", () => {
    for (let level = 0; level <= SheetPdf.MAX_DENSITY; level++) {
      const def = SheetPdf.buildSheetDocDefinition(worst(), { ...opts, density: level });
      expect(Math.min(...fontSizes(def)), `level ${level}`).toBeGreaterThanOrEqual(SheetPdf.FONT_FLOOR);
    }
    const scaled = SheetPdf.buildSheetDocDefinition(worst(), { ...opts, density: SheetPdf.MAX_DENSITY, scale: 0.8 });
    expect(Math.min(...fontSizes(scaled))).toBeCloseTo(SheetPdf.FONT_FLOOR * 0.8, 2);
    // denser levels narrow the fixed columns, so the Skills column wraps wider
    const widths = (level: number) => SheetPdf.buildSheetDocDefinition(emerald(), { ...opts, density: level }).content[2].table.widths;
    expect(widths(SheetPdf.MAX_DENSITY)[2]).toBeLessThan(widths(0)[2]);
    expect(widths(SheetPdf.MAX_DENSITY)[8]).toBeLessThan(widths(0)[8]);
  });

  it("beyond the density floor (every row carrying a long custom rule): the uniform scale-down keeps it to ONE page", async () => {
    const model = beyondFloor();
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, model, opts);
    expect(result.level).toBe(SheetPdf.MAX_DENSITY);
    expect(result.scale).toBeLessThan(1);
    expect(result.scale).toBeGreaterThanOrEqual(SheetPdf.MIN_SCALE); // never below the readable floor
    expect(result.pages).toBe(1);
    expect(result.fitted).toBe(true);
    const pages = await pagesText(new Uint8Array(result.buffer));
    expect(pages).toHaveLength(1);
    for (let n = 1; n <= 16; n++) expect(pages[0]).toMatch(new RegExp(`(^|\\n)${n} `));
  }, 60_000);

  it("stays fast: the worst case's whole fit loop under 2 s on this machine", async () => {
    await SheetPdf.fitSheetPdf(ctx.pdfMake, worst(), opts); // warm-up (font parsing)
    const started = performance.now();
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, worst(), opts);
    const ms = performance.now() - started;
    console.log(`[sheet-pdf] worst-case fit ${ms.toFixed(0)} ms, ${result.layouts} layouts, level ${result.level}, scale ${result.scale}`);
    expect(ms).toBeLessThan(2000);
  }, 30_000);

  it("a Blob output for the browser download", async () => {
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, emerald(), { ...opts, blob: true });
    expect(result.blob.type).toBe("application/pdf");
    expect(result.blob.size).toBeGreaterThan(1000);
  }, 30_000);
});

describe("beyond one readable page (Sol 6.1 P2, 11-09): complete, readable, reported", () => {
  it("11 players + a custom star with 12 multiline ~590-character rules: extra pages at the floor scale, every rule whole", async () => {
    const model = plain(solOverflow(core));
    for (const r of model.rows.at(-1).specialRules) expect(r.description.length).toBeGreaterThan(560);
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, model, opts);
    expect(result.fitted).toBe(false);
    expect(result.scale).toBe(SheetPdf.MIN_SCALE); // never shrunk past readable (6.5 pt x 0.6, about 3.9 pt)
    expect(result.pages).toBeGreaterThan(1);
    expect(result.doc.content[2].table.dontBreakRows).toBe(false); // the star's row may split across pages
    const pages = await pagesText(new Uint8Array(result.buffer));
    expect(pages).toHaveLength(result.pages);
    const all = pages.join("\n").replace(/\s+/g, "");
    for (let i = 1; i <= 12; i++) {
      expect(all, `rule ${i}`).toContain(`OathoftheGrove${i}`);
      expect(all, `rule ${i} end`).toContain(`END-OF-RULE-${i}`);
    }
    for (const row of model.rows.slice(0, 11)) expect(all).toContain(row.name.replace(/\s+/g, ""));
    expect(all).toContain("Keywords:");
    expect(all).toContain(`Page${result.pages}/${result.pages}`);
  }, 60_000);
  it("the same sheet kept unbreakable loses the star's rules (why the fallback lets rows break)", async () => {
    const def = SheetPdf.buildSheetDocDefinition(plain(solOverflow(core)), { ...opts, density: SheetPdf.MAX_DENSITY, scale: SheetPdf.MIN_SCALE });
    const text = (await pagesText(new Uint8Array(await ctx.pdfMake.createPdf(def).getBuffer()))).join("\n").replace(/\s+/g, "");
    expect(text).not.toContain("END-OF-RULE-1");
  }, 30_000);
  it("a normal team still fits on one page", async () => {
    const result = await SheetPdf.fitSheetPdf(ctx.pdfMake, emerald(), opts);
    expect(result).toMatchObject({ fitted: true, pages: 1, scale: 1 });
  }, 30_000);
});

describe("no ruleset row is lost", () => {
  const SOURCES: Array<[string, Array<[string, string]>]> = [["emerald", EMERALD_RULESET], ["worst", WORST_RULESET]];
  for (const [name, source] of SOURCES) {
    it(`${name}: every source row lands in exactly one compact row with its value whole, and on exactly one box line`, () => {
      const compact = SheetPdf.compactRulesetRows(source);
      expect(compact.flatMap((r: any) => r.from).sort()).toEqual(source.map(([label]) => label).sort());
      for (const [label, value] of source) {
        const hit = compact.filter((r: any) => r.from.includes(label));
        expect(hit, label).toHaveLength(1);
        expect(hit[0].value, label).toContain(value);
      }
      for (const metrics of [SheetPdf.sheetMetrics(0), SheetPdf.sheetMetrics(SheetPdf.MAX_DENSITY), SheetPdf.sheetMetrics(SheetPdf.MAX_DENSITY, 0.5)]) {
        const placed = SheetPdf.rulesetBoxLines(compact, metrics).flatMap((l: any) => l.rows);
        expect(placed).toHaveLength(compact.length);
        expect(new Set(placed).size).toBe(compact.length);
      }
    });
  }
  it("the PDF box prints every compact row, at every density level", () => {
    for (let level = 0; level <= SheetPdf.MAX_DENSITY; level++) {
      const def = SheetPdf.buildSheetDocDefinition(worst(), { ...opts, density: level });
      const body = def.content[0].columns[1].stack[0].table.body.slice(1);
      const labels = body.flatMap((r: any[]) => [r[0].text, r[2]?.text]).filter(Boolean);
      expect(labels.sort()).toEqual(SheetPdf.compactRulesetRows(WORST_RULESET).map((r: any) => r.label).sort());
    }
  });
  it("only the merges collapse rows; an unmerged source keeps one row per source row", () => {
    const rows: Array<[string, string]> = [["Package", "X"], ["SP budget", "40 SP"], ["Primary skills", "4"]];
    expect(SheetPdf.compactRulesetRows(rows).map((r: any) => [r.label, r.value])).toEqual(rows);
    expect(SheetPdf.compactRulesetRows([["Primary skills", "any"], ["Secondary skills", "none"]]).map((r: any) => [r.label, r.value]))
      .toEqual([["Added skills", "primary any · secondary none"]]);
  });
});

describe("fitLoop (pure, injected layout)", () => {
  /** A fake layout: the content height for (level, scale), one page when it fits the A4 content height. */
  const INNER = 595.28 - 2 * 10 * (72 / 25.4);
  function fake(heightOf: (level: number, scale: number) => number) {
    const calls: Array<{ level: number; scale: number; measuring: boolean; overflow?: boolean }> = [];
    const build = (level: number, scale: number, overflow?: boolean) => ({ level, scale, overflow, pageSize: "A4" });
    const layout = async (def: any) => {
      const measuring = SheetPdf.isMeasuring(def);
      calls.push({ level: def.level, scale: def.scale, measuring, ...(def.overflow ? { overflow: true } : {}) });
      const height = heightOf(def.level, def.scale);
      return { pages: measuring ? 1 : Math.max(1, Math.ceil(height / INNER)), height, output: `pdf ${def.level} ${def.scale}` };
    };
    return { build, layout, calls };
  }
  it("a team that fits at level 0 takes ONE layout", async () => {
    const f = fake(() => 300);
    const result = await SheetPdf.fitLoop(f.build, f.layout);
    expect(result).toMatchObject({ level: 0, scale: 1, pages: 1, fitted: true, layouts: 1, output: "pdf 0 1" });
  });
  it("otherwise: binary search over the levels on the measuring page, then the chosen level on A4 (deterministic)", async () => {
    const heights = [700, 640, 590, 520, 500, 480]; // fits from level 3 on
    const runs = [];
    for (let i = 0; i < 2; i++) {
      const f = fake((level) => heights[level]!);
      const result = await SheetPdf.fitLoop(f.build, f.layout);
      expect(result).toMatchObject({ level: 3, scale: 1, pages: 1, output: "pdf 3 1" });
      runs.push(f.calls);
    }
    expect(runs[0]).toEqual(runs[1]);
    expect(runs[0]!.filter((c) => c.measuring).length).toBeLessThanOrEqual(3); // log2 of 5 levels
    expect(runs[0]!.at(-1)).toEqual({ level: 3, scale: 1, measuring: false });
  });
  it("past the density floor: a uniform scale by the measured ratio, one page", async () => {
    const f = fake((level, scale) => (level === 5 ? 800 : 1000) * scale);
    const result = await SheetPdf.fitLoop(f.build, f.layout);
    expect(result).toMatchObject({ level: 5, pages: 1, fitted: true });
    expect(result.scale).toBeGreaterThanOrEqual(SheetPdf.MIN_SCALE);
    expect(result.scale).toBeLessThan(INNER / 800);
    expect(result.layouts).toBeLessThanOrEqual(12);
  });
  it("a layout that shrinks less than the scale suggests still converges within the layout cap", async () => {
    const f = fake((level, scale) => 650 * Math.sqrt(scale));
    const result = await SheetPdf.fitLoop(f.build, f.layout);
    expect(result).toMatchObject({ pages: 1, fitted: true });
    expect(result.layouts).toBeLessThanOrEqual(12);
  });
  it("past the readable floor: stops at MIN_SCALE and renders the overflow fallback (rows may break), fitted: false", async () => {
    const f = fake((level, scale) => 2000 * scale);
    const result = await SheetPdf.fitLoop(f.build, f.layout);
    expect(result).toMatchObject({ level: 5, scale: SheetPdf.MIN_SCALE, fitted: false, pages: 3 });
    expect(f.calls.every((c) => c.scale >= SheetPdf.MIN_SCALE)).toBe(true);
    expect(f.calls.at(-1)).toEqual({ level: 5, scale: SheetPdf.MIN_SCALE, measuring: false, overflow: true });
    expect(result.layouts).toBeLessThanOrEqual(12);
  });
  it("a pdfmake that reports no measurements (a stub) counts as one page", async () => {
    const result = await SheetPdf.fitLoop((l: number, s: number) => ({ l, s }), async () => ({ pages: 1, height: null, output: "stub" }));
    expect(result).toMatchObject({ level: 0, layouts: 1, output: "stub" });
  });
});
