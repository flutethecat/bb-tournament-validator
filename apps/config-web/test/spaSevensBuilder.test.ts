import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectiveRosterLimits, findRoster, loadPackage, type DeepPartial, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { extractPdfPages } from "../../../packages/bb-ingest/src/pdf/extractText.js";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createTournamentBuilder, nonLinemanReason, SEVENS_FREE_CREATE_PACKAGE, SEVENS_NO_STARS, SEVENS_TABLETOP_NOTE, staffRows, VETERAN_MISSING,
} from "../spa/src/teams/builder";
import { core } from "../spa/src/teams/builderCore";
import { createTournamentCreator } from "../spa/src/tournaments/creator";
import { requireSession } from "../src/auth/requireSession.js";
import { PackageFiles } from "../src/data";
import { builderTierRows, packageRulesInfo, SEVENS_FREE_CREATE_BUILD_PACKAGE } from "../src/teamBuilderPackage";
import { teamBuilderInducementCatalog } from "../src/teamBuilderInducements";
import { teamBuilderTierCatalog } from "../src/teamBuilderTiers";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";

// Blood Bowl Sevens in the Roster Builder (spec-sevens-rules-2026-11-02, Roster Builder + PDF lane): limits read from the
// package (never hard-coded), the non-Lineman cap, the Veteran, stars / mercenaries / the fork shut, the Sevens inducement
// list, the tier skill limits, the Sevens sheet and PDF, the Creator's inherited format, and standard packages unchanged.
/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = new URL("../../../", import.meta.url);
const SHIPPED = JSON.parse(readFileSync(new URL("tournament-packages/sevens-matched-play.json", REPO), "utf8"));
const MATCHED = loadPackage(SHIPPED as DeepPartial<TournamentPackage>).pkg;
const NAME = "Blood Bowl Sevens (Matched Play)";
const ENC = encodeURIComponent(NAME);
const HUMAN_DS = findRoster(bb2025, "Human")!;
const id = (name: string) => `h${HUMAN_DS.positions.findIndex((p) => p.name === name) + 1}`;
const HUMAN = {
  rosterId: "human", raceName: "Human", reRollCost: 50000, maxReRolls: 8, apothecaryAllowed: true, leagueOptions: ["Old World Classic"],
  specialRules: ["Old World Classic"], alwaysOnRules: [],
  positions: [
    ...HUMAN_DS.positions.map((p) => ({
      positionId: id(p.name), name: p.name, type: "Regular", cost: p.cost, max: p.max, MA: p.MA, ST: p.ST, AG: p.AG, PA: p.PA, AV: p.AV,
      skills: [...p.skills], keywords: [...(p.keywords ?? [])], playsFor: [],
    })),
    { positionId: "sgrim", name: "Grim Ironjaw", type: "Star", cost: 200000, max: 1, MA: 5, ST: 4, AG: "3+", PA: "-", AV: "9+", skills: ["Block"], isStar: true, playsFor: ["(any)"] },
  ],
};
const LEGAL = {
  primary: [{ skill: "Block", category: "General", elite: true }, { skill: "Dodge", category: "Agility", elite: true }, { skill: "Mighty Blow", category: "Strength", elite: true }, { skill: "Tackle", category: "General" }],
  secondary: [{ skill: "Guard", category: "Strength", elite: true }, { skill: "Wrestle", category: "General" }],
  alreadyPrinted: [],
};
const LIMITS = effectiveRosterLimits(MATCHED, "Human", bb2025)!;
const FREE_LIMITS = effectiveRosterLimits(SEVENS_FREE_CREATE_BUILD_PACKAGE, "Human", bb2025)!;
const STANDARD_INDUCEMENTS = { inducements: [{ key: "bribes", label: "Bribes", price: 100000, max: 3, allowed: true }] };

type Routes = Record<string, unknown | ((body: unknown) => unknown)>;
type Call = { path: string; method: string; body: unknown };
function mockFetcher(routes: Routes): Fetcher & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = `${method} ${path}` in routes ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: Call[] };
  f.calls = calls;
  return f;
}
const saves: Record<string, unknown> = {};
function routes(over: Routes = {}): Routes {
  const pkgDoc = { description: MATCHED.description, dataNote: MATCHED.dataNote, eligibleRosters: MATCHED.eligibleRosters, format: "sevens" };
  return {
    "/api/fork/rosters": { rosters: [HUMAN] },
    "/api/packages": [{ name: NAME, description: MATCHED.description, format: "sevens" }, { name: "Test Cup", description: "A test ruleset" }],
    [`/api/packages/${ENC}`]: { pkg: pkgDoc, rules: packageRulesInfo(MATCHED, null) },
    [`/api/packages/${ENC}?roster=Human`]: { pkg: pkgDoc, rules: packageRulesInfo(MATCHED, "Human") },
    [`/api/fork/team-builder/tiers?packageName=${ENC}`]: { races: teamBuilderTierCatalog(MATCHED, bb2025, true), tiers: builderTierRows(MATCHED) },
    [`/api/fork/team-builder/inducements?packageName=${ENC}`]: { inducements: teamBuilderInducementCatalog(MATCHED, bb2025) },
    [`/api/fork/team-builder/limits?packageName=${ENC}`]: { format: "sevens", eligibleRosters: MATCHED.eligibleRosters },
    [`/api/fork/team-builder/limits?packageName=${ENC}&roster=Human`]: { format: "sevens", eligibleRosters: MATCHED.eligibleRosters, limits: LIMITS },
    "/api/fork/team-builder/limits?packageName=sevens-free-create": { format: "sevens", eligibleRosters: SEVENS_FREE_CREATE_BUILD_PACKAGE.eligibleRosters },
    "/api/fork/team-builder/limits?packageName=sevens-free-create&roster=Human": { format: "sevens", eligibleRosters: SEVENS_FREE_CREATE_BUILD_PACKAGE.eligibleRosters, limits: FREE_LIMITS },
    "/api/fork/team-builder/inducements?packageName=sevens-free-create": { inducements: teamBuilderInducementCatalog(SEVENS_FREE_CREATE_BUILD_PACKAGE, bb2025) },
    "/api/fork/team-builder/tiers?packageName=sevens-free-create": { races: [] },
    "/api/packages/Test%20Cup": { pkg: { description: "A test ruleset", eligibleRosters: ["*"] }, rules: { name: "Test Cup", budget: 1000000, tierSummary: [] } },
    "/api/packages/Test%20Cup?roster=Human": { pkg: { description: "A test ruleset", eligibleRosters: ["*"] }, rules: { name: "Test Cup", budget: 1000000, tierSummary: [] } },
    "/api/fork/team-builder/tiers?packageName=Test%20Cup": { races: [] },
    "/api/fork/team-builder/inducements?packageName=Test%20Cup": STANDARD_INDUCEMENTS,
    "/api/skills": {
      general: [{ name: "Block", category: "General", elite: true }, { name: "Tackle", category: "General" }, { name: "Wrestle", category: "General" }],
      agility: [{ name: "Dodge", category: "Agility", elite: true }], strength: [{ name: "Guard", category: "Strength", elite: true }, { name: "Mighty Blow", category: "Strength", elite: true }],
    },
    ...Object.fromEntries(HUMAN.positions.map((p) => [`/api/fork/team-builder/legal-skills?rosterId=human&positionId=${p.positionId}`, LEGAL])),
    "POST /api/fork/team-builder/preview": { valid: true, errors: [], warnings: [], summary: null, package: null },
    "POST /api/fork/team-builder/saves": (body: any) => { saves.sv7 = body.body; return { save: { id: "sv7", name: body.name } }; },
    "/api/fork/team-builder/saves/sv7": () => ({ save: { id: "sv7", name: "Seven Up", body: saves.sv7 } }),
    "POST /api/fork/team-builder/build": { teamId: "t1" },
    ...over,
  };
}
const make = (f: Fetcher) => createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
async function sevensHuman(packageName = NAME, f = mockFetcher(routes())) {
  const b = make(f);
  const tab = await b.init({ packageName, race: "human" });
  b.setTeamName("Seven Up");
  return { b, f, tab };
}
const hire = (b: ReturnType<typeof make>, name: string, n = 1) => { for (let i = 0; i < n; i++) b.addPosition(id(name)); };

describe("Sevens: limits come from the package", () => {
  it("Matched Play: 11 players, 600k, Sevens staff prices and caps, fans from 0; all read from the limits route", async () => {
    const { b, f, tab } = await sevensHuman();
    expect(tab).toBe("roster");
    expect(b.sevens()).toBe(true);
    expect(f.calls.some((c) => c.path === `/api/fork/team-builder/limits?packageName=${ENC}&roster=Human`)).toBe(true);
    expect(b.maxPlayers()).toBe(LIMITS.maxPlayers);
    expect(b.maxPlayers()).toBe(11);
    expect(b.totals().budget).toBe(600000);
    const rows = Object.fromEntries(b.staffRows().map((r) => [r.key, r]));
    expect(rows.reRolls).toMatchObject({ cost: 100000, max: 6, min: 0, free: 0 });
    expect(rows.assistantCoaches).toMatchObject({ cost: 20000, max: 3 });
    expect(rows.cheerleaders).toMatchObject({ cost: 20000, max: 3 });
    expect(rows.apothecary).toMatchObject({ cost: 80000, max: 1 });
    expect(rows.dedicatedFans).toMatchObject({ cost: 20000, max: 5, min: 0, free: 0 });
    expect(b.state.staff.dedicatedFans).toBe(0); // Matched Play starts at 0
    b.stepStaff("reRolls", 10);
    expect(b.state.staff.reRolls).toBe(6);
    b.stepStaff("dedicatedFans", 2);
    expect(b.totals().sidelineCost).toBe(6 * 100000 + 2 * 20000);
  });

  it("a package that changes a limit is followed (not a hard-coded Sevens number)", async () => {
    const custom = { ...LIMITS, maxPlayers: 9, staff: { ...LIMITS.staff, reRolls: { price: 90000, max: 4 } } };
    const { b } = await sevensHuman(NAME, mockFetcher(routes({ [`/api/fork/team-builder/limits?packageName=${ENC}&roster=Human`]: { format: "sevens", eligibleRosters: ["Human"], limits: custom } })));
    expect(b.maxPlayers()).toBe(9);
    expect(b.staffRows().find((r) => r.key === "reRolls")).toMatchObject({ cost: 90000, max: 4 });
    hire(b, "Human Lineman", 12);
    expect(b.state.slots).toHaveLength(9);
    expect(b.positionCards().every((c) => c.exhausted)).toBe(true);
  });

  it("Sevens Free Create: its card sits next to Free Create, the race grid lists the Sevens teams, fans start at 1 free", async () => {
    const b0 = make(mockFetcher(routes()));
    await b0.init({});
    const cards = b0.rulesetCards();
    expect(cards.slice(0, 2).map((c) => [c.name, c.label, c.free, c.sevens])).toEqual([["free-create", "Free Create", true, false], ["sevens-free-create", "Sevens Free Create", true, true]]);
    expect(cards.find((c) => c.name === NAME)).toMatchObject({ sevens: true, free: false });
    expect(cards.find((c) => c.name === "Test Cup")).toMatchObject({ sevens: false });
    const { b } = await sevensHuman(SEVENS_FREE_CREATE_PACKAGE);
    expect(b.sevensFree()).toBe(true);
    expect(b.rulesetLabel()).toBe("Sevens Free Create");
    expect(b.freeRaces().map((r) => r.raceName)).toEqual(["Human"]);
    expect(b.staffRows().find((r) => r.key === "dedicatedFans")).toMatchObject({ min: 1, free: 1, cost: 20000 });
    expect(b.state.staff.dedicatedFans).toBe(1);
    expect(b.totals().sidelineCost).toBe(0);
    // Sevens Free Create has no added skills: the + carries the reason.
    hire(b, "Human Lineman");
    expect(b.advanceLock(0).reason).toBe("Sevens Free Create has no added skills.");
  });
});

describe("Sevens: the non-Lineman cap", () => {
  it("counts players without the Lineman keyword; at the cap the other non-Lineman cards disable with the reason", async () => {
    const { b } = await sevensHuman();
    hire(b, "Human Blitzer", 2);
    hire(b, "Halfling Hopeful", 2); // Halfling Hopefuls carry the Lineman keyword (owner Q2)
    expect(b.nonLineman()).toEqual({ count: 2, max: 4 });
    hire(b, "Human Catcher", 2);
    expect(b.nonLineman()).toEqual({ count: 4, max: 4 });
    const thrower = b.positionCards().find((c) => c.position.name === "Human Thrower")!;
    expect(thrower).toMatchObject({ exhausted: true, reason: nonLinemanReason(4), nonLineman: true });
    expect(nonLinemanReason(4)).toBe("Sevens: at most 4 players without the Lineman keyword.");
    expect(b.addPosition(id("Human Thrower"))).toBe(false);
    expect(b.positionCards().find((c) => c.position.name === "Human Lineman")).toMatchObject({ exhausted: false, reason: "" });
    expect(b.addPosition(id("Human Lineman"))).toBe(true);
    expect(b.valueLines().find((l) => l.label === "Non-Linemen")).toEqual({ label: "Non-Linemen", value: "4 / 4" });
  });
});

describe("Sevens: the Veteran", () => {
  it("one Lineman-keyword player, MA −1 on its row, its own veteran pick, flagged when missing, and kept by a save", async () => {
    const { b, f } = await sevensHuman();
    hire(b, "Human Blitzer");
    hire(b, "Human Lineman", 3);
    hire(b, "Halfling Hopeful");
    hire(b, "Human Catcher", 2);
    expect(b.validity().notices).toContain(VETERAN_MISSING);
    expect(b.valueLines().find((l) => l.label === "Veteran")).toMatchObject({ value: "not picked", tone: "over" });
    // Eligibility: Linemen and Hopefuls yes, a Blitzer no.
    expect(b.canVeteran(b.state.slots[0])).toBe(false);
    expect(b.canVeteran(b.state.slots[1])).toBe(true);
    expect(b.canVeteran(b.state.slots[4])).toBe(true);
    b.toggleVeteran(0);
    expect(b.veteranIndex()).toBe(-1);
    b.toggleVeteran(2);
    expect(b.veteranIndex()).toBe(2);
    // Exactly one: another Lineman can't take it while it is set.
    b.toggleVeteran(3);
    expect(b.veteranIndex()).toBe(2);
    expect(b.state.slots.filter((s) => s.veteran)).toHaveLength(1);
    expect(b.displayPosition(b.state.slots[2]!)!.MA).toBe(5);
    expect(b.displayPosition(b.state.slots[1]!)!.MA).toBe(6);
    expect(b.statSteps(2).find((s) => s.stat === "MA")!.value).toBe("5");
    expect(b.validity().notices).not.toContain(VETERAN_MISSING);
    expect(b.valueLines().find((l) => l.label === "Veteran")).toEqual({ label: "Veteran", value: "#3 Lineman" });
    // The composer's wire: the Veteran rides its own count:1 pick.
    const picks = b.requestBody().picks;
    expect(picks.filter((p) => p.veteran)).toEqual([expect.objectContaining({ positionId: id("Human Lineman"), count: 1, veteran: true })]);
    expect(picks.map((p) => [p.positionId, p.count, p.veteran ?? false])).toEqual([
      [id("Human Blitzer"), 1, false], [id("Human Lineman"), 1, false], [id("Human Lineman"), 1, true], [id("Human Lineman"), 1, false],
      [id("Halfling Hopeful"), 1, false], [id("Human Catcher"), 2, false],
    ]);
    await b.flushPreview();
    expect((f.calls.filter((c) => c.path === "/api/fork/team-builder/preview").pop()!.body as any).picks.some((p: any) => p.veteran === true)).toBe(true);
    // Moving rows keeps the flag on the same player; the save keeps it and a reload restores it.
    b.moveSlot(2, 0);
    expect(b.veteranIndex()).toBe(0);
    expect(await b.saveTeam()).toBe(true);
    const b2 = make(f);
    await b2.init({ saveId: "sv7" });
    expect(b2.veteranIndex()).toBe(0);
    expect(b2.state.slots[0]!.positionId).toBe(id("Human Lineman"));
    expect(b2.state.staff.dedicatedFans).toBe(0); // a saved 0 stays 0 under Matched Play
    // Clearing it brings the notice back.
    b.toggleVeteran(0);
    expect(b.veteranIndex()).toBe(-1);
    expect(b.validity().notices).toContain(VETERAN_MISSING);
  });
});

describe("Sevens: stars, mercenaries and the fork", () => {
  it("the star panel is shut with the Sevens reason; the fork build is refused before any request", async () => {
    const { b, f } = await sevensHuman();
    expect(b.starsAllowed()).toBe(false);
    expect(b.starsOffReason()).toBe(SEVENS_NO_STARS);
    expect(b.addStar("sgrim")).toBe(false);
    expect(b.rulesetLines()).toContain(SEVENS_NO_STARS);
    expect(b.forkBlocked()).toBe(SEVENS_TABLETOP_NOTE);
    expect(SEVENS_TABLETOP_NOTE).toBe("Sevens teams are tabletop only.");
    hire(b, "Human Lineman", 7);
    b.toggleVeteran(0);
    await b.flushPreview();
    expect(b.canBuild()).toBe(false);
    expect(await b.build()).toBe(false);
    expect(b.state.buildResult).toEqual({ ok: false, title: "Tabletop only", lines: [SEVENS_TABLETOP_NOTE] });
    expect(f.calls.some((c) => c.path === "/api/fork/team-builder/build")).toBe(false);
    // No Mercenaries or Star Players on the Sevens inducement list.
    expect(b.inducementRows().map((r) => r.item.key).some((k) => /mercenar|star/i.test(k))).toBe(false);
  });
});

describe("Sevens: the inducement panel", () => {
  it("shows the Sevens list at Sevens prices and caps, Desperate Measures included", async () => {
    const { b } = await sevensHuman();
    const rows = Object.fromEntries(b.inducementRows().map((r) => [r.item.key, r]));
    expect(rows.desperate_measures).toMatchObject({ terms: { price: 50000, max: 5 } });
    expect(rows.desperate_measures!.item.label).toBe("Desperate Measures");
    expect(rows.temp_agency_cheerleaders?.terms).toMatchObject({ price: 15000, max: 2 });
    expect(rows.extra_team_training?.terms).toMatchObject({ price: 125000, max: 6 });
    b.stepInducement("desperate_measures", 9);
    expect(b.state.inducementCounts.desperate_measures).toBe(5);
    expect(b.totals().inducementsCost).toBe(250000);
  });
});

describe("Sevens: tier skill limits (Matched Play count knobs)", () => {
  it("Tier 1: one Skill Point; a Secondary costs 2; one skill per player; added skills cost no gold", async () => {
    const { b } = await sevensHuman();
    hire(b, "Human Lineman", 3);
    await b.openSkills(0);
    expect(b.skillPrice("primary", false)).toBe("1 SP");
    expect(b.skillPrice("secondary", true)).toBe("2 SP");
    expect(b.skillBlock(b.state.slots[0]!, "Guard")).toBe("Not enough Skill Points: a Secondary costs 2 (Tier 1 has 1).");
    expect(b.addSkill(0, "Tackle")).toBe("");
    expect(b.skillBlock(b.state.slots[0]!, "Block")).toBe("One added skill per player in Sevens.");
    expect(b.moreSkills(b.state.slots[0]!)).toBe(false);
    expect(b.advanceLock(0)).toMatchObject({ offered: true, reason: "" }); // the dialog still opens to remove the skill
    await b.openSkills(1);
    expect(b.skillBlock(b.state.slots[1]!, "Block")).toBe("No Skill Points left (Tier 1 has 1).");
    expect(b.skillPoints()).toMatchObject({ used: 1, budget: 1, over: false });
    expect(b.totals().skillsCost).toBe(0);
  });

  it("a richer tier: the one Secondary (2 SP), then no second Secondary; at most 2 Elite skills per team", async () => {
    const rich = { ...LIMITS, skills: { ...LIMITS.skills, tier: 4, maxPrimary: 4 } };
    const { b } = await sevensHuman(NAME, mockFetcher(routes({ [`/api/fork/team-builder/limits?packageName=${ENC}&roster=Human`]: { format: "sevens", eligibleRosters: ["Human"], limits: rich } })));
    hire(b, "Human Lineman", 5);
    for (let i = 0; i < 5; i++) await b.openSkills(i);
    expect(b.addSkill(0, "Block")).toBe("");
    expect(b.addSkill(1, "Wrestle")).toBe(""); // the Secondary: 2 SP
    expect(b.skillBlock(b.state.slots[2]!, "Guard")).toBe("Only 1 Secondary skill per team.");
    expect(b.addSkill(2, "Dodge")).toBe("");
    expect(b.skillPoints()).toMatchObject({ used: 4, budget: 4 });
    expect(b.skillBlock(b.state.slots[3]!, "Tackle")).toBe("No Skill Points left (Tier 4 has 4).");
    // Elite cap: two elites are in (Block, Dodge); a third is refused whatever the SP.
    const roomy = { ...rich, skills: { ...rich.skills, maxPrimary: 9 } };
    const b2 = (await sevensHuman(NAME, mockFetcher(routes({ [`/api/fork/team-builder/limits?packageName=${ENC}&roster=Human`]: { format: "sevens", eligibleRosters: ["Human"], limits: roomy } })))).b;
    hire(b2, "Human Lineman", 3);
    for (let i = 0; i < 3; i++) await b2.openSkills(i);
    expect(b2.addSkill(0, "Block")).toBe("");
    expect(b2.addSkill(1, "Dodge")).toBe("");
    expect(b2.skillBlock(b2.state.slots[2]!, "Mighty Blow")).toBe("At most 2 Elite skills per team.");
    expect(b2.skillBlock(b2.state.slots[2]!, "Tackle")).toBe("");
  });
});

describe("Sevens: the sheet and the PDF", () => {
  const read = (path: string) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
  function pdfContext(): any {
    const ctx: any = { console, setTimeout, clearTimeout, setImmediate, queueMicrotask, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Buffer, URL, Blob, atob, btoa, navigator: { userAgent: "node" } };
    ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
    createContext(ctx);
    runInContext(read("vendor/pdfmake/pdfmake.min.js"), ctx);
    runInContext(read("vendor/pdfmake/vfs_fonts.js"), ctx);
    runInContext(read("team-builder.js"), ctx);
    runInContext(read("sheet-pdf.js"), ctx);
    return ctx;
  }
  async function eleven() {
    const { b } = await sevensHuman();
    hire(b, "Human Blitzer", 2);
    hire(b, "Human Catcher", 2);
    hire(b, "Human Lineman", 7);
    b.toggleVeteran(4);
    b.renameSlot(4, "Bartholomew Thunderstrike Vee");
    b.stepStaff("reRolls", 2);
    b.stepStaff("dedicatedFans", 1);
    b.stepInducement("desperate_measures", 1);
    return b;
  }

  it("the model: Sevens title, the Veteran on its row with MA −1, priced staff, the non-Lineman count, the format rows", async () => {
    const b = await eleven();
    const m = b.sheetModel();
    expect(m.formatTitle).toBe("Blood Bowl Sevens · Matched Play");
    const vet = m.rows[4]!;
    expect(vet).toMatchObject({ veteran: true, name: "Bartholomew Thunderstrike Vee", position: "Lineman" });
    expect(vet.stats.MA.value).toBe(5);
    expect(m.rows[5]!.stats.MA.value).toBe(6);
    expect(m.rows.filter((r) => r.veteran)).toHaveLength(1);
    expect(Object.fromEntries(m.sideline)).toMatchObject({ Rerolls: "2 · 200k", "Dedicated fans": "1 · 20k", Apothecary: "No · 0k" });
    expect(Object.fromEntries(m.summary)).toMatchObject({ "Non-Linemen": "4 / 4", Veteran: "#5 Lineman" });
    expect(m.inducements).toEqual([{ label: "Desperate Measures", count: 1 }]);
    expect(Object.fromEntries(m.ruleset!)).toMatchObject({ Package: NAME, "TV cap": "600k", Players: "7–11, max 4 non-Linemen",Veteran: "1 Lineman, MA −1", "Star players": "None" });
    // The HTML print fallback marks the Veteran too.
    expect(core.rosterSheetHtml(m)).toContain('class="rs-veteran"');
  });

  it("the real PDF: title line, Veteran marker; rows grow and stay whole across pages (dontBreakRows)", async () => {
    const b = await eleven();
    const ctx = pdfContext();
    const model = JSON.parse(JSON.stringify(b.sheetModel()));
    const doc = ctx.SheetPdf.buildSheetDocDefinition(model, { gold: ctx.TeamBuilderCore.gold, generatedOn: "2026-11-02" });
    const roster = doc.content.find((c: any) => c.table?.headerRows === 1);
    expect(roster.table.dontBreakRows).toBe(true);
    expect(roster.table.body).toHaveLength(12);
    const bytes = new Uint8Array(await ctx.pdfMake.createPdf(doc).getBuffer());
    const pages = (await extractPdfPages(bytes)).map((p) => p.lines.map((l) => l.text).join("\n"));
    expect(pages.length).toBeLessThanOrEqual(2);
    const text = pages.join("\n");
    for (const needle of ["Bartholomew", "Desperate Measures", "2 · 200k", "4 / 4"]) expect(text).toContain(needle);
    expect(pages[0]).toContain("Blood Bowl Sevens · Matched Play");
    // The Veteran's row: the long name wraps inside the Player cell; the position and the Veteran marker stay with it.
    expect(text).toMatch(/5 Bartholomew 5 3 3\+ 4\+ 9\+ 50k\nThunderstrike Vee\nLineman Veteran/);
    pages.forEach((page, i) => {
      expect(page).toMatch(/#\s+PLAYER\s+MA\s+ST\s+AG\s+PA\s+AV\s+SKILLS\s+COST/); // the header repeats on every page
      expect(page).toContain(`Page ${i + 1} / ${pages.length}`);
      // No row is split: each player's top line is followed by its position line on the same page.
      for (const m of page.matchAll(/^(\d+) [A-Z][a-z]+ .* \d+k$/gm)) expect(page.slice(m.index! + m[0].length)).toMatch(/^\n(\S.*\n)?(Lineman|Blitzer|Catcher)/);
    });
    for (let n = 1; n <= 11; n++) expect(text.match(new RegExp(`(^|\\n)${n} [A-Z]`, "g"))).toHaveLength(1);
  });

  it("standard sheets are unchanged: no title line, no Veteran or Non-Linemen rows, unpriced staff", async () => {
    const b = make(mockFetcher(routes()));
    await b.init({ packageName: "Test Cup", race: "human" });
    b.setTeamName("Elevens");
    hire(b, "Human Lineman", 2);
    const m = b.sheetModel();
    expect(m.formatTitle).toBe("");
    expect(m.summary.map(([k]) => k)).not.toContain("Non-Linemen");
    expect(m.summary.map(([k]) => k)).not.toContain("Veteran");
    expect(Object.fromEntries(m.sideline)).toMatchObject({ Rerolls: "0", "Dedicated fans": "1", Apothecary: "No" });
    expect(m.ruleset!.map(([k]) => k)).not.toContain("Format");
  });
});

describe("standard packages are unchanged (regression)", () => {
  it("16 players, standard staff, no limits request, no Veteran, stars and the fork as before", async () => {
    const f = mockFetcher(routes());
    const b = make(f);
    await b.init({ packageName: "Test Cup", race: "human" });
    b.setTeamName("Elevens");
    expect(b.sevens()).toBe(false);
    expect(b.limits()).toBeNull();
    expect(f.calls.some((c) => c.path.startsWith("/api/fork/team-builder/limits"))).toBe(false);
    expect(b.maxPlayers()).toBe(16);
    expect(b.staffRows()).toEqual(staffRows(HUMAN as any));
    expect(b.staffRows().map((r) => [r.key, r.cost, r.max, r.min, r.free])).toEqual([
      ["reRolls", 50000, 8, 0, 0], ["assistantCoaches", 10000, 6, 0, 0], ["cheerleaders", 10000, 12, 0, 0], ["dedicatedFans", 10000, 7, 1, 1], ["apothecary", 50000, 1, 0, 0],
    ]);
    hire(b, "Human Blitzer", 2);
    hire(b, "Human Catcher", 2);
    hire(b, "Human Thrower", 2);
    expect(b.state.slots).toHaveLength(6); // no non-Lineman cap
    expect(b.nonLineman()).toBeNull();
    expect(b.positionCards().every((c) => c.reason === "" || c.reason.startsWith("The roster is full"))).toBe(true);
    expect(b.canVeteran(b.state.slots[0])).toBe(false);
    hire(b, "Human Lineman");
    b.toggleVeteran(6);
    expect(b.veteranIndex()).toBe(-1);
    expect(b.requestBody().picks.some((p) => "veteran" in p)).toBe(false);
    expect(b.starsAllowed()).toBe(true);
    expect(b.forkBlocked()).toBe("");
    expect(b.valueLines().map((l) => l.label)).not.toContain("Veteran");
    expect(b.skillPrice("primary", false)).toBe("+20k");
  });

  it("core.buildPicks still merges identical players when no Veteran is set", () => {
    const slot = { positionId: "x", chosenSkills: [], chosenStatIncreases: [] };
    expect(core.buildPicks([slot, slot, slot])).toEqual([{ positionId: "x", count: 3 }]);
    expect(core.buildPicks([slot, { ...slot, veteran: true }, slot])).toEqual([{ positionId: "x", count: 1 }, { positionId: "x", count: 1, veteran: true }, { positionId: "x", count: 1 }]);
    expect(core.slotsFromPicks([{ positionId: "x", count: 2, veteran: true }], () => ({ positionId: "x" }) as any).map((s) => s.veteran === true)).toEqual([true, false]);
  });
});

describe("Tournament Creator: inherited format display", () => {
  const mock = (r: Routes): Fetcher => mockFetcher(r);
  const API: Routes = {
    "/api/packages": ["Club Sevens", NAME],
    "/api/packages/Club%20Sevens": () => ({ raw: { name: "Club Sevens", extends: NAME, skillAllotment: {} }, revision: "r1", problems: [], schemaProblems: [] }),
    [`/api/packages/${ENC}`]: () => ({ pkg: MATCHED, raw: SHIPPED, revision: "r0", problems: [], schemaProblems: [] }),
    "/api/packages/Plain": () => ({ raw: { name: "Plain", skillAllotment: {} }, revision: "r2", problems: [], schemaProblems: [] }),
    "/api/presets": [], "/api/skills": { elite: [], general: [] }, "/api/stars": [], "/api/positions": [], "/api/teams": [],
  };
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("a package with no format that extends a Sevens base reads 'Sevens (inherited from <base>)'; its own format wins", async () => {
    const c = createTournamentCreator({ api: mock(API) });
    await c.init();
    await c.open("Club Sevens");
    await settle();
    expect(c.state.pkg!.format).toBeUndefined();
    expect(c.effectiveFormat()).toEqual({ format: "sevens", inheritedFrom: NAME });
    // Sevens on an inherited Sevens is a no-op; Standard overrides it (and drops the extends).
    c.setFormat("sevens");
    expect(c.state.pkg!.format).toBeUndefined();
    c.setFormat("standard");
    expect(c.state.pkg!.extends).toBe("");
    expect(c.effectiveFormat()).toEqual({ format: "standard", inheritedFrom: null });
    await c.open("Plain");
    await settle();
    expect(c.effectiveFormat()).toEqual({ format: "standard", inheritedFrom: null });
  });
});

describe("server: GET /api/fork/team-builder/limits and the package list format", () => {
  const root = mkdtempSync(join(tmpdir(), "sevens-ui-http-"));
  const previousEnv = new Map<string, string | undefined>();
  let origin = "";
  let server: (typeof import("../src/server.js"))["server"];

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
      IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
      FORK_LIBRARY_DIR: join(root, "library"), FORK_BUILDER_SAVES_DIR: join(root, "saves"), FORK_TEAMS_DIR: join(root, "teams"),
      FORK_STATE_DIR: join(root, "state"), PACKAGES_DIR: join(root, "packages"), TOURNAMENTS_DIR: join(root, "tournaments"), FORK_ADMIN_PASSWORD: "",
    })) {
      previousEnv.set(name, process.env[name]);
      process.env[name] = value;
    }
    for (const d of ["library", "teams", "rosters", "packages", "tournaments", "log", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, "log", "default.log"), "", "utf8");
    copyFileSync(new URL("tournament-packages/sevens-matched-play.json", REPO), join(root, "packages", "sevens-matched-play.json"));
    writeFileSync(join(root, "packages", "sevens-layer.json"), JSON.stringify({ name: "Sevens Layer", extends: NAME, skillAllotment: {} }), "utf8");
    writeFileSync(join(root, "packages", "plain.json"), JSON.stringify({ name: "Plain Cup", skillAllotment: {} }), "utf8");
    writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("Alice") }), "utf8");
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
    void createSession;
    ({ server } = await import("../src/server.js"));
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  });

  it("anonymous reads through the session gate: the race's limits for a Sevens package, Sevens Free Create and a layer", async () => {
    const get = async (q: string) => { const r = await fetch(`${origin}/api/fork/team-builder/limits?${q}`); return { status: r.status, body: (await r.json()) as any }; };
    const m = await get(`packageName=${ENC}&roster=Human`);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ format: "sevens", limits: { format: "sevens", maxPlayers: 11, maxNonLineman: 4, budget: 600000, staffPriced: true } });
    expect(m.body.eligibleRosters).not.toContain("Slann");
    expect(m.body.limits.staff.reRolls).toEqual({ price: 100000, max: 6 });
    const free = await get("packageName=sevens-free-create&roster=Human");
    expect(free.body.limits.staff.dedicatedFans).toMatchObject({ start: 1, min: 1 });
    const layer = await get(`packageName=${encodeURIComponent("Sevens Layer")}&roster=Human`);
    expect(layer.body).toMatchObject({ format: "sevens", limits: { maxPlayers: 11 } });
    const plain = await get(`packageName=${encodeURIComponent("Plain Cup")}`);
    expect(plain.body).toEqual({ format: "standard", eligibleRosters: expect.any(Array) });
    expect((await get("packageName=nope")).status).toBe(400);
    const list = (await (await fetch(`${origin}/api/packages`)).json()) as any[];
    expect(list.find((r) => r.name === NAME)?.format).toBe("sevens");
    expect(list.find((r) => r.name === "Sevens Layer")?.format).toBe("sevens");
    expect(list.find((r) => r.name === "Plain Cup")).not.toHaveProperty("format");
  });

  it("the route is on the public-read lists (requireSession and the sidecar-off PUBLIC_PATHS)", () => {
    const req: any = { method: "GET", headers: {}, socket: { remoteAddress: "203.0.113.9" } };
    expect(requireSession(req, "/api/fork/team-builder/limits", "").kind).toBe("allow");
    expect(readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")).toMatch(/"\/api\/fork\/team-builder\/limits",\r?\n/);
  });

  it("PackageFiles.list resolves the format along a cycle-safe extends chain", () => {
    const dir = mkdtempSync(join(tmpdir(), "sevens-list-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "A", extends: "B" }), "utf8");
    writeFileSync(join(dir, "b.json"), JSON.stringify({ name: "B", extends: "A" }), "utf8");
    writeFileSync(join(dir, "c.json"), JSON.stringify({ name: "C", extends: "D" }), "utf8");
    writeFileSync(join(dir, "d.json"), JSON.stringify({ name: "D", format: "sevens" }), "utf8");
    expect(new PackageFiles(dir).list().map((r) => [r.name, r.format ?? null])).toEqual([["A", null], ["B", null], ["C", "sevens"], ["D", "sevens"]]);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Sevens: page (server-rendered)", () => {
  const SPA_CONFIG = new URL("../spa/vite.config.ts", import.meta.url);
  let vite: import("vite").ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    const { fileURLToPath } = await import("node:url");
    vite = await createServer({ configFile: fileURLToPath(SPA_CONFIG), logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, builderMod] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/teams/builder.ts")]);
    mods = { app, vueRouter, renderer, builderMod };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, prepare?: (b: any) => void, link: Record<string, string> = { packageName: NAME, race: "human" }): Promise<string> {
    const f = mockFetcher(routes({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }));
    const builder = mods.builderMod.createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
    await builder.init(link);
    prepare?.(builder);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.builderMod.TOURNAMENT_BUILDER_KEY, builder);
    await spa.session.load();
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("Ruleset tab: Sevens Free Create next to Free Create; Sevens cards wear the badge", async () => {
    const html = await render("/tournament-team-builder?tab=ruleset", undefined, {});
    expect([...html.matchAll(/data-ruleset="([^"]+)"/g)].map((m) => m[1])).toEqual(["free-create", "sevens-free-create", NAME, "Test Cup"]);
    expect(html.match(/class="tb-card-badge">Sevens</g)).toHaveLength(2);
  });

  it("Roster tab: the Veteran toggle and MA tile, the non-Lineman counter, NO STAR PLAYERS, the tabletop note and no fork button", async () => {
    const html = await render("/tournament-team-builder?tab=roster", (b) => {
      b.setTeamName("Seven Up");
      for (const n of ["Human Blitzer", "Human Blitzer", "Human Catcher", "Human Catcher", "Human Lineman", "Human Lineman", "Human Lineman"]) b.addPosition(id(n));
      b.toggleVeteran(4);
    });
    expect(html).toContain('class="tb-vet" aria-pressed="true"');
    expect(html).toMatch(/class="tb-vet"[^>]*>Veteran<\/button>/);
    expect(html).not.toMatch(/>Make Veteran<\/button>/); // one Veteran: the other Linemen don't offer it while it is set
    expect(html).toMatch(/class="down tb-stat" title="Veteran: MA −1"><b>5<\/b><small>MA<\/small>/);
    expect(html).toMatch(/<span class="tb-k">Non-Linemen<\/span><b>4 \/ 4<\/b>/);
    expect(html).toContain('data-reason="Sevens: at most 4 players without the Lineman keyword."');
    expect(html).toContain('<span class="tb-acc-title">NO STAR PLAYERS</span>');
    expect(html).toContain(`title="${SEVENS_NO_STARS}"`);
    expect(html).toContain(`class="muted tb-fork-note">${SEVENS_TABLETOP_NOTE}</p>`);
    expect(html).not.toContain("Create team on Fork");
    expect(html).toContain("7 / 11 players");
  });
});

describe("Tournament Creator: inherited format (server-rendered)", () => {
  let vite: import("vite").ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    const { fileURLToPath } = await import("node:url");
    vite = await createServer({ configFile: fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url)), logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, creator, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/tournaments/creator.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { app, creator, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  it("the Format panel shows 'Sevens (inherited from <base>)' with the Sevens chip pressed", async () => {
    const f = mockFetcher({
      "/api/auth/session": { authenticated: true, coach: "Jay", organizer: true, authMethod: "discord", discordSsoEnabled: true },
      "/api/packages": ["Club Sevens", NAME],
      "/api/packages/Club%20Sevens": () => ({ raw: { name: "Club Sevens", extends: NAME, skillAllotment: {} }, revision: "r1", problems: [], schemaProblems: [] }),
      [`/api/packages/${ENC}`]: () => ({ pkg: MATCHED, raw: SHIPPED, revision: "r0", problems: [], schemaProblems: [] }),
      "/api/presets": [], "/api/skills": { elite: [], general: [] }, "/api/stars": [], "/api/positions": [], "/api/teams": [],
    });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const c = mods.creator.createTournamentCreator({ api: f });
    await c.init();
    await c.open("Club Sevens");
    await new Promise((r) => setTimeout(r, 0));
    spa.app.provide(mods.creator.TOURNAMENT_CREATOR_KEY, c);
    await spa.router.push("/tournament-creator?package=Club%20Sevens");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toContain(`data-inherited-format>Sevens (inherited from ${NAME})</p>`);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Sevens<\/button>/);
    expect(html).toContain("Blood Bowl Sevens</span>"); // the band caption
  });
});
