import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { extractPdfPages } from "../../../packages/bb-ingest/src/pdf/extractText.js";

// The in-browser team-sheet PDF (owner 10-27, option 1): public/sheet-pdf.js builds a pdfmake document
// definition from TeamBuilderCore.rosterSheetModel; the vendored pdfmake renders it. Both run here in a
// bare vm context (no DOM), exactly as the browser loads them.
const publicDir = new URL("../public/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, publicDir), "utf8");
const lf = (text: string) => text.replace(/\r\n/g, "\n");

/* eslint-disable @typescript-eslint/no-explicit-any */
function loadContext(withPdfMake = false): any {
  const ctx: any = { console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Buffer, URL, Blob, atob, btoa, navigator: { userAgent: "node" } };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.globalThis = ctx;
  createContext(ctx);
  if (withPdfMake) {
    runInContext(read("vendor/pdfmake/pdfmake.min.js"), ctx);
    runInContext(read("vendor/pdfmake/vfs_fonts.js"), ctx);
  }
  runInContext(read("team-builder.js"), ctx);
  runInContext(read("sheet-pdf.js"), ctx);
  return ctx;
}
const plain = loadContext();
const core = plain.TeamBuilderCore;
const SheetPdf = plain.SheetPdf;

const blitzer = { positionId: "65748", name: "Dwarf Blitzer", cost: 100_000, MA: 5, ST: 3, AG: "4+", PA: "4+", AV: "10+", skills: ["Block", "Tackle", "Thick Skull"], keywords: ["blitzer", "dwarf"] };
const lineman = { positionId: "65746", name: "Dwarf Blocker Lineman", cost: 70_000, MA: 4, ST: 3, AG: "4+", PA: "5+", AV: "10+", skills: ["Block", "Defensive", "Thick Skull"], keywords: ["dwarf", "lineman"] };
const grim = { positionId: "s1", name: "Grim Ironjaw", cost: 190_000, MA: 5, ST: 4, AG: "3+", PA: "-", AV: "9+", skills: ["Block", "Dauntless", "Frenzy", "Multiple Block", "Thick Skull"], isStar: true };
const access = (secondary: string[] = []) => (skill: string) => (secondary.includes(skill) ? "secondary" : "primary");

function dwarfModel(extra: { linemen?: number; stars?: number; longSkills?: boolean } = {}) {
  const players = [
    { position: blitzer, chosenSkills: ["Guard"], chosenStatIncreases: ["AV"], accessOf: access() },
    { position: blitzer, chosenSkills: ["Mighty Blow"], accessOf: access() },
    { position: lineman, chosenSkills: ["Dirty Player"], accessOf: access(["Dirty Player"]) },
    ...Array.from({ length: extra.linemen ?? 9 }, () => ({
      position: extra.longSkills ? { ...lineman, skills: [...lineman.skills, "Sure Feet", "Stand Firm", "Brawler", "Iron Hard Skin", "Pro", "Fend", "Kick", "Dump-off"] } : lineman,
      chosenSkills: [],
    })),
    // A star row given added skills / stat increases anyway: the model (and the PDF) must ignore them.
    ...Array.from({ length: extra.stars ?? 1 }, () => ({ position: grim, chosenSkills: ["Guard"], chosenStatIncreases: ["ST"], accessOf: access() })),
  ];
  return core.rosterSheetModel({
    raceName: "Dwarf",
    coach: "flutethecat",
    teamName: "Amorical Dwarves w/ Bribe",
    rulesetName: "Nut Cup — Tier 3",
    players,
    staff: { reRolls: 2, apothecary: 1, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 },
    apothecaryAllowed: true,
    inducements: [{ label: "Bribes", count: 1 }, { label: "Weather Mage", count: 0 }],
    specialRules: ["Brawlin' Brutes", "Bribery and Corruption"],
    summary: { goldUsed: 1_420_000, goldBudget: 1_455_000, skillsCost: 240_000, inducementsCost: 75_000, primarySkillCount: 2, secondarySkillCount: 1, statIncreasesCost: 10_000, starFeesCost: 0 },
    costs: { players: 935_000, stars: 190_000, sideline: 170_000, skills: 0, inducements: 0 },
    budget: 1_455_000,
  });
}

const textOf = (node: any): string => (typeof node === "string" ? node : Array.isArray(node) ? node.map(textOf).join("") : node?.text != null ? textOf(node.text) : "");
const roster = (doc: any) => doc.content[2].table;
const pdfText = async (bytes: Uint8Array) => (await extractPdfPages(bytes)).map((page) => page.lines.map((l) => l.text).join("\n"));

describe("buildSheetDocDefinition (pure)", () => {
  const model = dwarfModel();
  const doc = SheetPdf.buildSheetDocDefinition(model, { gold: core.gold, generatedOn: "2026-10-27T12:00:00Z" });

  it("is A4 landscape with 10 mm margins, Roboto only, real metadata", () => {
    expect(doc.pageSize).toBe("A4");
    expect(doc.pageOrientation).toBe("landscape");
    for (const m of doc.pageMargins) expect(m).toBeCloseTo(28.35, 1);
    expect(doc.defaultStyle.font).toBe("Roboto");
    expect(JSON.stringify(doc)).not.toMatch(/"font":"(?!Roboto)/);
    expect(doc.info).toMatchObject({ title: "Amorical Dwarves w/ Bribe roster sheet", author: "flutethecat", creator: "Super FUMBBL Tournament Builder" });
  });

  it("header: race bold 18, coach and team", () => {
    const header = doc.content[0];
    expect(header.columns[0]).toMatchObject({ text: "Dwarf", style: "race" });
    expect(doc.styles.race).toEqual({ fontSize: 18, bold: true });
    expect(textOf(header.columns[1].stack)).toContain("flutethecat");
    expect(textOf(header.columns[1].stack)).toContain("Amorical Dwarves w/ Bribe");
  });

  it("top band: Sideline / Inducements / Leagues & special rules / Summary with totals vs cap", () => {
    const band = doc.content[1].columns;
    expect(band.map((panel: any) => textOf(panel.table.body[0][0]))).toEqual(["SIDELINE", "INDUCEMENTS", "LEAGUES & SPECIAL RULES", "SUMMARY"]);
    expect(band[1].table.body.slice(1).map((r: any) => [textOf(r[0]), textOf(r[1])])).toEqual([["Bribes", "1"]]); // zero-count inducements dropped
    expect(band[2].table.body[1][0].ul).toEqual(["Brawlin' Brutes", "Bribery and Corruption"]);
    const summary = Object.fromEntries(band[3].table.body.slice(1).map((r: any) => [textOf(r[0]), textOf(r[1])]));
    expect(summary).toMatchObject({
      "Players cost": "935k",
      "Skills cost": "240k",
      "Inducement cost": "75k",
      "Sideline cost": "170k",
      "Primary skills": "2",
      "Secondary skills": "1",
      Total: "1,420k / 1,455k",
    });
  });

  it("roster table: repeated header row, right-aligned numbers, zebra rows", () => {
    const table = roster(doc);
    expect(table.headerRows).toBe(1);
    expect(table.dontBreakRows).toBe(true);
    expect(table.body[0].map(textOf)).toEqual(["#", "POSITION", "MA", "ST", "AG", "PA", "AV", "SKILLS", "COST"]);
    const first = table.body[1];
    expect(textOf(first[1])).toBe("Dwarf Blitzer");
    for (const i of [0, 2, 3, 4, 5, 6, 8]) expect(first[i].alignment).toBe("right");
    expect(textOf(first[8])).toBe("100k");
    const fill = doc.content[2].layout.fillColor;
    expect([fill(0), fill(1), fill(2), fill(3)]).toEqual(["#e6e6e6", null, "#f4f4f4", null]);
  });

  it("skills: printed normal, added italic blue (secondary green), stat increases marked, improved stat bold", () => {
    const [, first, , dirty] = roster(doc).body;
    const parts = first[7].text.filter((p: any) => p.text !== ", ");
    expect(parts.map((p: any) => p.text)).toEqual(["Block", "Tackle", "Thick Skull", "Guard", "+AV"]);
    expect(parts[0].italics).toBeUndefined();
    expect(parts[3]).toMatchObject({ italics: true, color: "#1a5fb4" });
    expect(parts[4]).toMatchObject({ italics: true, bold: true, color: "#1a5fb4" });
    expect(first[6]).toMatchObject({ text: "11+", bold: true, color: "#1a5fb4" }); // AV 10+ improved
    const dirtyParts = dirty[7].text.filter((p: any) => p.text !== ", ");
    expect(dirtyParts.at(-1)).toMatchObject({ text: "Dirty Player", italics: true, color: "#3d7a1f" });
  });

  it("a star row never prints added skills or stat changes", () => {
    const star = roster(doc).body.at(-1);
    expect(textOf(star[1])).toBe("Grim Ironjaw  (Star)");
    expect(textOf(star[7])).toBe("Block, Dauntless, Frenzy, Multiple Block, Thick Skull");
    expect(JSON.stringify(star[7])).not.toContain("italics");
    expect(star[3]).toEqual({ text: "4", alignment: "right" }); // ST not improved
    expect(textOf(star[8])).toBe("190k");
  });

  it("keywords line and footer (product · ruleset · date, page x / y)", () => {
    expect(textOf(doc.content[3].text)).toBe("Keywords: Dwarf Blitzer: Blitzer, Dwarf  |  Dwarf Blocker Lineman: Dwarf, Lineman");
    const footer = doc.footer(2, 3);
    expect(footer.columns.map(textOf)).toEqual(["Super FUMBBL Tournament Builder · Nut Cup — Tier 3 · 2026-10-27", "Page 2 / 3"]);
  });

  it("an 18-player roster carries 18 body rows plus the header", () => {
    const big = SheetPdf.buildSheetDocDefinition(dwarfModel({ linemen: 15, stars: 0 }), { gold: core.gold });
    expect(roster(big).body).toHaveLength(19);
  });

  it("file name: Core.sheetFileName with .pdf", () => {
    expect(SheetPdf.sheetPdfFileName(core.sheetFileName(model))).toBe("Amorical_Dwarves_w_Bribe_roster.pdf");
    expect(SheetPdf.sheetPdfFileName("")).toBe("team_roster.pdf");
  });
});

describe("rendered with the vendored pdfmake (real PDF, selectable text)", () => {
  const ctx = loadContext(true);
  const render = (model: unknown) =>
    ctx.pdfMake.createPdf(ctx.SheetPdf.buildSheetDocDefinition(model, { gold: ctx.TeamBuilderCore.gold, generatedOn: "2026-10-27" })).getBuffer()
      .then((b: Uint8Array) => new Uint8Array(b));

  it("produces a one-page PDF whose text is real and complete", async () => {
    const bytes = await render(dwarfModel());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const pages = await pdfText(bytes);
    expect(pages).toHaveLength(1);
    const text = pages[0]!;
    for (const needle of ["Dwarf", "flutethecat", "Amorical Dwarves w/ Bribe", "Grim Ironjaw", "Mighty Blow", "+AV", "1,420k / 1,455k", "Keywords:", "Page 1 / 1"]) expect(text).toContain(needle);
  });

  it("a long roster (16 players + 4 stars, long skill lists) paginates with the header repeated on every page", async () => {
    const bytes = await render(dwarfModel({ linemen: 13, stars: 4, longSkills: true }));
    const pages = await pdfText(bytes);
    expect(pages.length).toBeGreaterThan(1);
    pages.forEach((page, i) => {
      expect(page).toMatch(/#\s+POSITION\s+MA\s+ST\s+AG\s+PA\s+AV\s+SKILLS\s+COST/);
      expect(page).toContain(`Page ${i + 1} / ${pages.length}`);
    });
    const all = pages.join("\n");
    for (let n = 1; n <= 20; n++) expect(all).toMatch(new RegExp(`(^|\\n)${n} `));
  });
});

describe("generation time (pdfmake lays out synchronously; bounded by the roster cap)", () => {
  const ctx = loadContext(true);
  const render = (model: unknown) =>
    ctx.pdfMake.createPdf(ctx.SheetPdf.buildSheetDocDefinition(model, { gold: ctx.TeamBuilderCore.gold })).getBuffer();
  it("worst case (16 players + 4 stars, long skill lists) stays under 2 s on this machine", async () => {
    await render(dwarfModel({ linemen: 13, stars: 4, longSkills: true })); // warm-up (font parsing)
    const started = performance.now();
    await render(dwarfModel({ linemen: 13, stars: 4, longSkills: true }));
    const ms = performance.now() - started;
    console.log(`[sheet-pdf] worst-case generation ${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(2000);
  });
});

describe("lazy loader", () => {
  function fakeDocument(behaviour: (src: string) => "load" | "error") {
    const inserted: string[] = [];
    const head = {
      appendChild(script: any) {
        inserted.push(script.src);
        setTimeout(() => (behaviour(script.src) === "load" ? script.onload() : script.onerror()), 0);
      },
    };
    return { inserted, document: { head, createElement: () => ({ remove() {} }) } };
  }

  it("inserts the two vendored scripts in order only when asked, and a failure clears the cache for a retry", async () => {
    const ctx = loadContext();
    let fail = true;
    const fake = fakeDocument(() => (fail ? "error" : "load"));
    ctx.document = fake.document;
    expect(fake.inserted).toEqual([]); // nothing at page load
    await expect(ctx.SheetPdf.loadPdfMake()).rejects.toThrow(/Could not load \/vendor\/pdfmake\/pdfmake\.min\.js/);
    fail = false;
    ctx.pdfMake = { createPdf: () => ({}) };
    await expect(ctx.SheetPdf.loadPdfMake()).resolves.toBe(ctx.pdfMake);
    expect(fake.inserted).toEqual(["/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/vfs_fonts.js"]);
  });
});

describe("lazy loader: a hung load is abandoned, a good load stays cached", () => {
  it("abandonPdfMakeLoad drops the in-flight promise and removes its dangling scripts; the retry starts from scratch", async () => {
    const ctx = loadContext();
    let mode: "hang" | "load" = "hang";
    const inserted: string[] = [];
    const removed: string[] = [];
    ctx.document = {
      head: { appendChild(script: any) { inserted.push(script.src); if (mode === "load") setTimeout(() => script.onload(), 0); } },
      createElement: () => { const script: any = { remove() { removed.push(script.src); } }; return script; },
    };
    const hung = ctx.SheetPdf.loadPdfMake();
    hung.catch(() => undefined);
    expect(ctx.SheetPdf.loadPdfMake()).toBe(hung); // in flight: shared
    ctx.SheetPdf.abandonPdfMakeLoad();
    expect(removed).toEqual(["/vendor/pdfmake/pdfmake.min.js"]);
    mode = "load";
    ctx.pdfMake = { createPdf: () => ({}) };
    const retry = ctx.SheetPdf.loadPdfMake();
    expect(retry).not.toBe(hung);
    await expect(retry).resolves.toBe(ctx.pdfMake);
    expect(inserted).toEqual(["/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/vfs_fonts.js"]);
    // Success stays cached: abandoning afterwards is a no-op and nothing is inserted again.
    ctx.SheetPdf.abandonPdfMakeLoad();
    expect(ctx.SheetPdf.loadPdfMake()).toBe(retry);
    expect(inserted).toHaveLength(3);
    expect(removed).toHaveLength(1);
  });
});

describe("Export PDF button flow (team-builder.js printSheet, stubbed DOM)", () => {
  const js = lf(read("team-builder.js"));
  const grab = (start: string) => {
    const from = js.indexOf(start);
    expect(from).toBeGreaterThan(-1);
    return js.slice(from, js.indexOf("\n  }\n", from) + 4);
  };
  const source = `${grab("  async function printSheet(")}\nreturn printSheet;`;

  function harness(sheetPdf: unknown, opts: { prepare?: () => Promise<unknown>; timeoutMs?: number } = {}) {
    const els: Record<string, any> = {};
    const el = (id: string) => (els[id] ??= { textContent: id === "print-sheet" ? "Export PDF" : "", disabled: false, hidden: true, className: "", innerHTML: "" });
    const calls = { printed: 0, saved: [] as string[] };
    const printSheet = new Function(
      "$", "current", "slots", "prepareSheet", "sheetModel", "Core", "window", "SHEET_PDF_TIMEOUT_MS",
      "saveBlob", "openPrintDialog", "syncBuildButton",
      `let pdfExportBusy = false;\n${source}`,
    )(
      el, {}, [{}], opts.prepare ?? (async () => ({ teamName: "T" })), () => ({ teamName: "T" }),
      { gold: core.gold, sheetFileName: () => "T_roster.html" },
      { SheetPdf: sheetPdf }, opts.timeoutMs ?? 50,
      (_blob: unknown, name: string) => calls.saved.push(name), () => calls.printed++, () => {},
    ) as () => Promise<void>;
    return { printSheet, el, calls };
  }
  const workingPdf = (getBlob: () => Promise<unknown> = async () => ({ size: 10 })) => ({
    ...SheetPdf,
    loadPdfMake: async () => ({ createPdf: () => ({ getBlob }) }),
  });

  it("downloads <sheetFileName>.pdf and resets the button", async () => {
    const h = harness(workingPdf());
    await h.printSheet();
    expect(h.calls.saved).toEqual(["T_roster.pdf"]);
    expect(h.calls.printed).toBe(0);
    expect(h.el("print-sheet").textContent).toBe("Export PDF");
  });

  it("a script-load failure falls back to the print dialog with the notice; the button resets", async () => {
    const h = harness({ ...SheetPdf, loadPdfMake: async () => { throw new Error("Could not load /vendor/pdfmake/pdfmake.min.js"); } });
    await h.printSheet();
    expect(h.calls.printed).toBe(1);
    expect(h.calls.saved).toEqual([]);
    expect(h.el("build-result").innerHTML).toContain("PDF service unavailable, opened the print dialog instead.");
    expect(h.el("build-result").hidden).toBe(false);
    expect(h.el("print-sheet").textContent).toBe("Export PDF");
  });

  it("two exports against a HUNG script load: the first times out and abandons it, the second retries the load and succeeds", async () => {
    const ctx = loadContext();
    let mode: "hang" | "load" = "hang";
    const inserted: string[] = [];
    ctx.document = {
      head: { appendChild(script: any) { inserted.push(script.src); if (mode === "load") setTimeout(() => script.onload(), 0); } },
      createElement: () => ({ remove() {} }),
    };
    const first = harness(ctx.SheetPdf, { timeoutMs: 30 });
    await first.printSheet();
    expect(first.calls.printed).toBe(1); // fallback after the deadline
    mode = "load";
    ctx.pdfMake = { createPdf: () => ({ getBlob: async () => ({ size: 10 }) }) };
    const second = harness(ctx.SheetPdf, { timeoutMs: 1000 });
    await second.printSheet();
    expect(second.calls.saved).toEqual(["T_roster.pdf"]);
    expect(second.calls.printed).toBe(0);
    expect(inserted).toEqual(["/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/vfs_fonts.js"]);
  });

  it("an expired deadline wins before the synchronous generation starts (macrotask yield)", async () => {
    let generated = 0;
    const busyPrepare = async () => {
      const until = Date.now() + 60; // block the main thread past the 30 ms deadline
      while (Date.now() < until) { /* busy */ }
      return { teamName: "T" };
    };
    const pdf = { ...SheetPdf, loadPdfMake: async () => ({ createPdf: () => { generated++; return { getBlob: async () => ({ size: 10 }) }; } }) };
    const h = harness(pdf, { prepare: busyPrepare, timeoutMs: 30 });
    await h.printSheet();
    expect(generated).toBe(0);
    expect(h.calls.printed).toBe(1);
    expect(h.el("print-sheet").textContent).toBe("Export PDF");
  });

  it("a pdfmake throw, a missing sheet-pdf.js, or a hung load/generation all fall back and reset", async () => {
    const cases = [
      harness({ ...SheetPdf, loadPdfMake: async () => ({ createPdf: () => { throw new Error("pdfmake blew up"); } }) }),
      harness(undefined),
      harness({ ...SheetPdf, loadPdfMake: () => new Promise(() => {}) }, { timeoutMs: 30 }),
      harness(workingPdf(() => new Promise(() => {})), { timeoutMs: 30 }),
      harness(workingPdf(), { prepare: () => new Promise(() => {}), timeoutMs: 30 }),
    ];
    for (const h of cases) {
      await h.printSheet();
      expect(h.calls.printed).toBe(1);
      expect(h.calls.saved).toEqual([]);
      expect(h.el("print-sheet").textContent).toBe("Export PDF");
    }
  });
});

describe("vendored pdfmake + page wiring", () => {
  const vendor = new URL("vendor/pdfmake/", publicDir);
  const sha1 = (name: string) => createHash("sha1").update(readFileSync(new URL(name, vendor))).digest("hex");

  it("ships exactly pdfmake 0.3.11's two build files, unmodified, plus the licence", () => {
    expect(readdirSync(vendor).sort()).toEqual(["LICENSE", "pdfmake.min.js", "vfs_fonts.js"]);
    expect(sha1("pdfmake.min.js")).toBe("e175450b934ec8050e00021516adef84af4f0e08");
    expect(sha1("vfs_fonts.js")).toBe("69008fe6f45a34fb76585ab29ec018f6bc95f450");
  });

  it("the licence records the version, MIT for pdfmake and OFL 1.1 for the bundled Roboto", () => {
    const licence = readFileSync(new URL("LICENSE", vendor), "utf8");
    expect(licence).toContain("pdfmake 0.3.11 (MIT)");
    expect(licence).toContain("The MIT License (MIT)");
    expect(licence).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(licence).toContain("b4504d19b8f31fa5063dc1b847b060faa4f7c5bb");
    const docs = readFileSync(new URL("../../../docs/third-party.md", import.meta.url), "utf8");
    expect(docs).toContain("pdfmake 0.3.11 (MIT)");
  });

  it("the only fonts are Roboto faces", () => {
    const vfs = read("vendor/pdfmake/vfs_fonts.js");
    const keys = [...vfs.matchAll(/^\s*"([^"]+)":\s*"/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual(["Roboto-Italic.ttf", "Roboto-Medium.ttf", "Roboto-MediumItalic.ttf", "Roboto-Regular.ttf"]);
  });

  it("both builder pages load sheet-pdf.js, never pdfmake at page load; the static paths are public", () => {
    for (const page of ["team-builder.html", "tournament-team-builder.html"]) {
      const html = read(page);
      expect(html).toContain('<script src="/sheet-pdf.js" defer></script>');
      expect(html).not.toContain("pdfmake");
    }
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const sidecar = readFileSync(new URL("../src/auth/requireSession.ts", import.meta.url), "utf8");
    for (const path of ["/sheet-pdf.js", "/vendor/pdfmake/pdfmake.min.js", "/vendor/pdfmake/vfs_fonts.js"]) {
      expect(server).toContain(`pathname === "${path}"`);
      expect(sidecar).toContain(`pathname === "${path}"`);
    }
    expect(read("sheet-pdf.js")).not.toMatch(/https?:\/\//); // no CDN
  });
});
