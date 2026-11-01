import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { findRoster, loadPackage, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import nafJson from "../../../tournament-packages/naf-world-cup-2027.json";
import nutJson from "../../../tournament-packages/whbb-nut-cup-2026.json";
import smallGodsJson from "../../../tournament-packages/small-gods.json";
import { extractPdfPages } from "../../../packages/bb-ingest/src/pdf/extractText.js";
import { packageRaceRules } from "../src/teamBuilderPackage";
import { teamBuilderTierCatalog } from "../src/teamBuilderTiers";
import { core, type BuilderPosition, type RaceRules, type SheetModel } from "../spa/src/teams/builderCore";
import { sheetModel, sheetRulesetRows, type SheetBuilderLike } from "../spa/src/teams/sheetRuleset";
import { vfsEntry } from "../spa/src/teams/sheetFonts";

// The Sheet tab in the exported PDF's design (owner 10-30): ONE model (sheetRuleset.ts sheetModel = the builder's
// sheetModel() + the TOURNAMENT RULESET rows) feeds public/sheet-pdf.js and the on-screen TournamentBuilderPrintSheet.
/* eslint-disable @typescript-eslint/no-explicit-any */
const readPublic = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
/** A bare vm context (no DOM), as the browser loads the scripts; withPdfMake adds the vendored pdfmake + fonts. */
function loadContext(withPdfMake = false): any {
  const ctx: any = { console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Buffer, URL, Blob, atob, btoa, navigator: { userAgent: "node" } };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  createContext(ctx);
  if (withPdfMake) {
    runInContext(readPublic("vendor/pdfmake/pdfmake.min.js"), ctx);
    runInContext(readPublic("vendor/pdfmake/vfs_fonts.js"), ctx);
  }
  runInContext(readPublic("sheet-pdf.js"), ctx);
  return ctx;
}
const SheetPdf = loadContext().SheetPdf;
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const textOf = (node: any): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : node?.text != null ? textOf(node.text) : "");

// ── fixture: NAF World Cup 2027, Necromantic Horror, 12 players, 3 rerolls, no stars ──
const { pkg } = loadPackage(nafJson as unknown as Partial<TournamentPackage>);
const RACE = packageRaceRules(pkg, "Necromantic Horror") as unknown as RaceRules;
const TIER = core.normalizeTierRules((teamBuilderTierCatalog(pkg, bb2025, true) as any[]).find((r) => r.name === "Necromantic Horror").rules);
const roster = findRoster(bb2025, "Necromantic Horror")!;
const pos = (name: string): BuilderPosition => {
  const p: any = roster.positions.find((x) => x.name === name)!;
  return { positionId: p.id, name: p.name, type: p.type, cost: p.cost, max: p.max, MA: p.MA, ST: p.ST, AG: p.AG, PA: p.PA, AV: p.AV, skills: p.skills, keywords: p.keywords, isStar: false, playsFor: [] };
};
const LINEUP: Array<[string, string[], ("primary" | "secondary")?]> = [
  ["Werewolf", ["Block"]], ["Werewolf", []], ["Wraith", ["Dodge"], "secondary"], ["Wraith", []], ["Ghoul Runner", []], ["Ghoul Runner", []],
  ["Flesh Golem", ["Guard"]], ["Flesh Golem", []], ["Zombie Lineman", []], ["Zombie Lineman", []], ["Zombie Lineman", []], ["Zombie Lineman", []],
];
function baseModel(): SheetModel {
  return core.rosterSheetModel({
    raceName: "Necromantic Horror", coach: "flutethecat", teamName: "Malta Moonlighters",
    rulesetName: [pkg.name, RACE.tierLabel].filter(Boolean).join(" — "),
    players: LINEUP.map(([name, skills, access]) => ({ position: pos(name), chosenSkills: skills, chosenStatIncreases: [], chosenStats: null, captain: false, accessOf: () => access ?? "primary" })),
    staff: { reRolls: 3, apothecary: 0, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 },
    apothecaryAllowed: false, inducements: [], specialRules: roster.specialRules ?? [], captainAvailable: false,
    summary: { goldUsed: 1_150_000, goldBudget: 1_160_000, skillsCost: 0, inducementsCost: 0, primarySkillCount: 2, secondarySkillCount: 1 },
    costs: { players: 1_050_000, stars: 0, sideline: 210_000, skills: 0, inducements: 0 }, budget: 1_160_000,
  });
}
const fakeBuilder = (model: SheetModel = baseModel()): SheetBuilderLike => ({
  state: { packageName: pkg.name, packageRules: { budget: null } },
  sheetModel: () => model, raceRules: () => RACE, packSummary: () => null, tierRules: () => TIER,
  tierLabel: () => RACE.tierLabel ?? "", activeLeague: () => "",
});
const NAF_RULESET: Array<[string, string]> = [
  ["Package", "NAF World Cup 2027 (Malta) - Rules Pack V3.0"],
  ["Tier", "Gold Budget 1,160,000"],
  ["TV cap", "1,160k"],
  ["SP budget", "52 SP"],
  ["SP prices", "primary 6 · secondary 10 · elite +2 · stacking +2"],
  ["Skills per player", "max 2"],
  ["Stacked players", "max 1 (max 2 skills · max 2 secondary)"],
  ["Star players", "None"],
];

describe("sheetModel: the one model for the screen and the PDF", () => {
  it("the NAF World Cup 2027 Necromantic team: 12 rows, 3 rerolls, no stars, and the ruleset rows", () => {
    const m = sheetModel(fakeBuilder());
    expect(m.rows).toHaveLength(12);
    expect(m.rows.some((r) => r.isStar)).toBe(false);
    expect(Object.fromEntries(m.sideline)).toMatchObject({ Rerolls: "3", Apothecary: "—" });
    expect(m.specialRules).toEqual(["Sylvanian Spotlight", "Masters of Undeath"]);
    expect(m.ruleset).toEqual(NAF_RULESET);
    expect(SheetPdf.rulesetRows(m)).toEqual(NAF_RULESET);
  });
  it("keeps a builder model that already carries the rows (builder.ts sheetModel) untouched", () => {
    const own = { ...baseModel(), ruleset: [["Package", "X"]] as Array<[string, string]> };
    expect(sheetModel(fakeBuilder(own))).toBe(own);
  });
});

// The rows follow the tournament's skill system as validation applies it (Sol 6.1 P2s, 10-30): real packages.
describe("sheetRulesetRows: the skill system decides the rows", () => {
  const raceOf = (p: TournamentPackage, race: string) => {
    const r = packageRaceRules(p, race) as unknown as RaceRules;
    const t = (teamBuilderTierCatalog(p, bb2025, true) as any[]).find((x) => x.name === race);
    return { race: r, tier: core.normalizeTierRules(t?.rules ?? null) };
  };
  const rowsFor = (p: TournamentPackage, race: string, packLabel: string | null = null, league = "") => {
    const { race: r, tier } = raceOf(p, race);
    const pack = packLabel ? r.packs.find((x) => x.label === packLabel)! : null;
    return sheetRulesetRows({ packageName: p.name, tierLabel: r.tierLabel ?? "", raceRules: r, pack, tierRules: tier, league, budget: p.goldBudget });
  };
  const labels = (rows: Array<[string, string]>) => rows.map(([k]) => k);

  it("skill points (NAF World Cup 2027): SP budget and SP prices, no primary / secondary counts", () => {
    const rows = rowsFor(pkg, "Necromantic Horror");
    expect(rows).toEqual(NAF_RULESET);
    expect(labels(rows)).not.toContain("Primary skills");
  });

  it("choose-one packs (WHBB Nut Cup Tier 5): the selected pack's allowance wins over the tier's secondary limit", () => {
    const nut = loadPackage(nutJson as unknown as Partial<TournamentPackage>).pkg;
    const rows = rowsFor(nut, "Goblin", "1,150k · 8 skills + Star");
    expect(Object.fromEntries(rows)).toMatchObject({
      "Skill pack": "1,150k · 8 skills + Star: 8 skills (primary only)",
      "Secondary skills": "none",
      "Skills per player": "max 2",
    });
    expect(rows.find(([k]) => k === "Stacked players")?.[1] ?? "").not.toMatch(/secondary\)/);
    expect(labels(rows)).not.toContain("SP budget"); // validation ignores the SP pool with packs
    expect(JSON.stringify(rows)).not.toContain("max 2 secondary");
    // The plain 8-skill pack keeps the tier's 2 secondary.
    expect(Object.fromEntries(rowsFor(nut, "Goblin", "1,150k · 8 skills"))["Secondary skills"]).toBe("max 2");
    // No pack chosen yet: the packs on offer, still no SP budget.
    const open = rowsFor(nut, "Goblin");
    expect(Object.fromEntries(open)["Skill packs"]).toMatch(/^choose one: 1,150k · 8 skills · /);
    expect(labels(open)).not.toContain("SP budget");
  });

  it("count mode via a matrix cell: the cell, Primary / Secondary skills and the swap; never the SP budget", () => {
    const matrixPkg = loadPackage({
      name: "Matrix Cup", goldBudget: 1_000_000,
      skillAllotment: { skillPointBudget: 12 } as TournamentPackage["skillAllotment"],
      matrix: {
        columns: [{ gold: 1_110_000 }, { gold: 1_150_000 }],
        rows: [{ label: "6 Primary", primary: 6, secondary: 0, secondarySwap: false }, { primary: 8, secondary: 1, secondarySwap: true, secondarySwapMax: 1 }],
        cells: [{ col: 0, row: 0, teams: ["Orc"] }, { col: 1, row: 1, teams: ["Human"] }],
      },
    } as unknown as Partial<TournamentPackage>).pkg;
    const orc = rowsFor(matrixPkg, "Orc");
    expect(orc.slice(0, 5)).toEqual([["Package", "Matrix Cup"], ["TV cap", "1,110k"], ["Matrix cell", "6 Primary @ 1110k"], ["Primary skills", "6"], ["Secondary skills", "none"]]);
    expect(labels(orc)).not.toContain("SP budget");
    const human = rowsFor(matrixPkg, "Human");
    expect(Object.fromEntries(human)).toMatchObject({ "Matrix cell": "8 pri / 1 sec @ 1150k", "Primary skills": "8", "Secondary skills": "1", "Secondary swap": "2 primary → 1 secondary (max 1)" });
    expect(labels(human)).not.toContain("SP budget");
  });

  it("count mode via tiers (Small Gods): Primary / Secondary skills from the resolved race rules", () => {
    const sg = loadPackage(smallGodsJson as unknown as Partial<TournamentPackage>).pkg;
    const race = (sg.tiers ?? [])[0]!.rosters[0]!;
    const rows = rowsFor(sg, race);
    const sys = (packageRaceRules(sg, race) as any).skillSystem;
    expect(sys.mode).toBe("count");
    expect(Object.fromEntries(rows)).toMatchObject({
      "Primary skills": sys.maxPrimary == null ? "any" : String(sys.maxPrimary),
      "Secondary skills": sys.maxSecondary == null ? "any" : sys.maxSecondary === 0 ? "none" : String(sys.maxSecondary),
    });
    expect(labels(rows)).not.toContain("SP budget");
  });
});

describe("sheet-pdf.js: the TOURNAMENT RULESET box", () => {
  const box = (doc: any) => doc.content[0].columns[2];
  const boxRows = (doc: any) => {
    const body = box(doc).stack[0].table.body;
    return body.slice(1).flatMap((r: any[]) => [[textOf(r[0]), textOf(r[1])], [textOf(r[2]), textOf(r[3])]]).filter(([k]: string[]) => k);
  };
  it("model with ruleset rows → the full box top right; A4 landscape; roster headerRows 1", () => {
    const doc = SheetPdf.buildSheetDocDefinition(sheetModel(fakeBuilder()), { gold: core.gold, generatedOn: "2026-10-30" });
    expect(doc.pageSize).toBe("A4");
    expect(doc.pageOrientation).toBe("landscape");
    expect(doc.content[2].table.headerRows).toBe(1);
    expect(doc.content[0].columns).toHaveLength(3); // race · coach/team · ruleset box (right)
    expect(textOf(box(doc).stack[0].table.body[0][0])).toBe("TOURNAMENT RULESET");
    expect(box(doc).width).toBe(330);
    expect(boxRows(doc)).toEqual(NAF_RULESET);
    expect(doc.content[2].table.body).toHaveLength(13);
  });
  it("model without ruleset rows → the fallback box (package, tier, TV cap from the model)", () => {
    const doc = SheetPdf.buildSheetDocDefinition(baseModel(), { gold: core.gold });
    expect(boxRows(doc)).toEqual([
      ["Package", "NAF World Cup 2027 (Malta) - Rules Pack V3.0"],
      ["Tier", "Gold Budget 1,160,000"],
      ["TV cap", "1,160k"],
    ]);
  });
  it("no ruleset at all (a custom sheet) → no box, the header keeps two columns", () => {
    const doc = SheetPdf.buildSheetDocDefinition({ ...baseModel(), rulesetName: "", summary: [] }, { gold: core.gold });
    expect(doc.content[0].columns).toHaveLength(2);
  });
  it("the fixture renders to ONE A4 landscape page with the box text on it", async () => {
    const ctx = loadContext(true);
    const model = JSON.parse(JSON.stringify(sheetModel(fakeBuilder()))); // plain data inside the vm
    const bytes = new Uint8Array(await ctx.pdfMake.createPdf(ctx.SheetPdf.buildSheetDocDefinition(model, { gold: core.gold, generatedOn: "2026-10-30" })).getBuffer());
    const pages = (await extractPdfPages(bytes)).map((p: any) => p.lines.map((l: any) => l.text).join("\n"));
    expect(pages).toHaveLength(1);
    for (const needle of ["TOURNAMENT RULESET", "52 SP", "Stacked players", "Malta Moonlighters", "Page 1 / 1"]) expect(pages[0]).toContain(needle);
  }, 30_000);
});

describe("sheet-pdf.js: a long unbroken team name never pushes the ruleset box off the page", () => {
  it("a 60-character name wraps; every glyph run stays inside the right margin; one page", async () => {
    const ctx = loadContext(true);
    const model = JSON.parse(JSON.stringify({ ...sheetModel(fakeBuilder()), teamName: "W".repeat(60), coach: "C".repeat(40) }));
    const bytes = new Uint8Array(await ctx.pdfMake.createPdf(ctx.SheetPdf.buildSheetDocDefinition(model, { gold: core.gold })).getBuffer());
    // pdfjs-dist (bb-ingest's copy, as extractText.ts uses it) for item positions AND widths.
    const pdfjsPath = new URL("../../../packages/bb-ingest/node_modules/pdfjs-dist/legacy/build/pdf.mjs", import.meta.url).href;
    const { getDocument } = await import(/* @vite-ignore */ pdfjsPath);
    const doc = await getDocument({ data: bytes, useSystemFonts: true }).promise;
    expect(doc.numPages).toBe(1);
    const page = await doc.getPage(1);
    const pageWidth = (page.view as number[])[2]!;
    const items = (await page.getTextContent()).items.filter((it: any) => "str" in it && it.str.trim()) as any[];
    const right = Math.max(...items.map((it) => it.transform[4] + it.width));
    const margin = 10 * (72 / 25.4);
    expect(pageWidth).toBeCloseTo(841.89, 0);
    expect(right).toBeLessThanOrEqual(pageWidth - margin + 0.5);
    const title = items.find((it) => it.str === "TOURNAMENT");
    expect(title.transform[4]).toBeGreaterThan(pageWidth / 2); // still top right
    const ws = items.filter((it) => /^W+$/.test(it.str.replace(/\u200B/g, "")));
    expect(ws.length).toBeGreaterThan(1); // the name wrapped onto several lines
    expect(ws.map((it) => it.str.replace(/\u200B/g, "")).join("")).toBe("W".repeat(60)); // no glyphs lost
    await doc.destroy();
  }, 30_000);
});

describe("the on-screen sheet (TournamentBuilderPrintSheet.vue, server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [vue, renderer, sheet] = await Promise.all([import("vue"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/TournamentBuilderPrintSheet.vue")]);
    mods = { vue, renderer, sheet };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });
  const render = (model: unknown) => mods.renderer.renderToString(mods.vue.createSSRApp({ render: () => mods.vue.h(mods.sheet.default, { model, gold: core.gold, generatedOn: "2026-10-30" }) })) as Promise<string>;

  it("header labels, panel titles in the PDF's order, table rows, ruleset box rows", async () => {
    const html = await render(sheetModel(fakeBuilder()));
    // owner 11-01: the team's name is the big title, the race the small labelled line
    expect(html).toContain('<div class="ps-race">Malta Moonlighters</div>');
    expect(html).toMatch(/<span class="ps-label">COACH<\/span> flutethecat/);
    expect(html).toMatch(/<span class="ps-label">RACE<\/span> Necromantic Horror/);
    const titles = [...html.matchAll(/<thead><tr><th(?: colspan="\d")?>([^<]+)<\/th><\/tr><\/thead>/g)].map((m) => m[1]!.replace("&amp;", "&"));
    expect(titles).toEqual(["TOURNAMENT RULESET", "SIDELINE", "INDUCEMENTS", "LEAGUES & SPECIAL RULES", "SUMMARY"]);
    const cells = [...html.matchAll(/<td class="ps-k">([^<]*)<\/td><td class="ps-v">([^<]*)<\/td>/g)].map((m) => [m[1], m[2]]).filter(([k]) => k);
    expect(cells).toEqual(NAF_RULESET);
    const body = html.slice(html.indexOf('<table class="ps-roster">'));
    expect([...body.matchAll(/<td class="ps-pos"/g)]).toHaveLength(12);
    expect(body).toMatch(/<th scope="col" class="ps-r">#<\/th><th scope="col">PLAYER<\/th>/);
    expect(body).toContain('<span class="ps-primary">Block</span>');
    expect(body).toContain('<span class="ps-secondary">Dodge</span>');
    expect(html).toContain("Super FUMBBL Tournament Builder · NAF World Cup 2027 (Malta) - Rules Pack V3.0");
  });
  it("star and captain markers; the fallback box without ruleset rows", async () => {
    const m = baseModel();
    m.rows[0] = { ...m.rows[0]!, captain: true, free: ["Team Captain", "Pro"] };
    m.rows.push({ ...m.rows[1]!, number: 13, position: "Grim Ironjaw", positionFull: "Grim Ironjaw", isStar: true, added: [{ name: "Guard", access: "primary" }] });
    const html = await render(m);
    expect(html).toMatch(/Werewolf<small class="ps-mark-captain" title="Team Captain">\(C\)<\/small>/);
    expect(html).toContain('<span class="ps-trait">Team Captain</span>');
    expect(html).toMatch(/Grim Ironjaw<small class="ps-mark-star">\(Star\)<\/small>/);
    const starRow = html.slice(html.indexOf("Grim Ironjaw<small"));
    expect(starRow.slice(0, starRow.indexOf("</tr>"))).not.toContain("Guard"); // no added skills on a star
    const cells = [...html.matchAll(/<td class="ps-k">([^<]*)<\/td>/g)].map((x) => x[1]).filter(Boolean);
    expect(cells).toEqual(["Package", "Tier", "TV cap"]);
  });
  it("the paper palette is the PDF's; Roboto comes from the vendored bundle (no CDN, no new font files)", () => {
    const css = readFileSync(new URL("../spa/src/teams/sheet.css", import.meta.url), "utf8");
    const P = SheetPdf.PALETTE;
    for (const [v, c] of [["ink", P.INK], ["muted", P.MUTED], ["rule", P.RULE], ["head", P.HEAD_FILL], ["zebra", P.ZEBRA_FILL], ["blue", P.BLUE], ["green", P.GREEN], ["trait", P.TRAIT]]) expect(css).toContain(`--ps-${v}: ${c};`);
    expect(css).not.toMatch(/https?:\/\//);
    // Mark classes outrank the paper's `.ps-paper td { font/color: inherit }` reset (0,1,1), so improved stats stay bold blue.
    for (const cls of ["ps-improved", "ps-primary", "ps-secondary", "ps-stat-up", "ps-trait", "ps-muted"]) expect(css.split(/\r?\n/).some((l) => l.startsWith(`.ps-paper .${cls} {`))).toBe(true);
    const vfs = readFileSync(new URL("../public/vendor/pdfmake/vfs_fonts.js", import.meta.url), "utf8");
    for (const f of ["Roboto-Regular.ttf", "Roboto-Medium.ttf", "Roboto-Italic.ttf", "Roboto-MediumItalic.ttf"]) expect(vfsEntry(vfs, f).slice(0, 8)).toBe("AAEAAAAR"); // a TrueType header
  });
});
