import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { composeTeam } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentBuilder, FREE_CREATE_PACKAGE } from "../spa/src/teams/builder";
import { core } from "../spa/src/teams/builderCore";
import { sheetRulesetRows } from "../spa/src/teams/sheetRuleset";
import { CHARACTERISTIC_VALUE } from "../src/characteristicValue";
import { CHARACTERISTIC_VALUE as ADVANCEMENT_VALUE } from "../src/teamAdvancement";
import { freeDisplayRosterXml } from "../src/freeCreateDisplay";
import { resolveBuilderPackage } from "../src/teamBuilderPackage";
import { buildBodyForSave, createSave, type TeamBuilderSave } from "../src/teamBuilderSaves";
import { teamBuilderWireError } from "../src/teamBuilderWire";
import { sharedTeamView } from "../src/teamShareView";

// Roster Builder "Free Create" (owner 10-31): any BB2025 race, the race's roster limits only, no tournament rules and no
// site validation; "Ignore in-game limits" lifts position maxes, skill access and stat limits and lists every star (16
// players stays the limit).
/* eslint-disable @typescript-eslint/no-explicit-any */
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

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

const HUMAN = {
  rosterId: "human", raceName: "Human", reRollCost: 50000, maxReRolls: 8, apothecaryAllowed: true, leagueOptions: ["Old World Classic"],
  specialRules: ["Old World Classic"], alwaysOnRules: [],
  positions: [
    { positionId: "hlin", name: "Human Lineman", type: "Lineman", cost: 50000, max: 16, MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: [], playsFor: [] },
    { positionId: "hogr", name: "Ogre", type: "BigGuy", cost: 140000, max: 1, MA: 5, ST: 5, AG: "4+", PA: "5+", AV: "10+", skills: ["Loner (4+)", "Bone Head"], playsFor: [] },
    { positionId: "sgrim", name: "Grim Ironjaw", type: "Star", cost: 200000, max: 1, MA: 5, ST: 4, AG: "3+", PA: "-", AV: "9+", skills: ["Block"], isStar: true, playsFor: ["(any)"] },
  ],
};
const ORC = {
  rosterId: "orc", raceName: "Orc", reRollCost: 60000, maxReRolls: 8, apothecaryAllowed: true, leagueOptions: ["Badlands Brawl"], specialRules: ["Badlands Brawl"],
  positions: [
    { positionId: "olin", name: "Orc Lineman", type: "Lineman", cost: 50000, max: 16, MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+", skills: ["Animosity"], playsFor: [] },
    { positionId: "sgrak", name: "Grak", type: "Star", cost: 250000, max: 1, MA: 5, ST: 5, AG: "4+", PA: "-", AV: "10+", skills: [], isStar: true, playsFor: ["Badlands Brawl"], teamWithPositionId: "scrum" },
    { positionId: "scrum", name: "Crumbleberry", type: "Star", cost: 0, max: 1, MA: 5, ST: 2, AG: "3+", PA: "-", AV: "7+", skills: [], isStar: true, playsFor: ["Badlands Brawl"], teamWithPositionId: "sgrak" },
  ],
};
const LEGAL = {
  primary: [{ skill: "Block", category: "General", elite: true }, { skill: "Tackle", category: "General" }],
  secondary: [{ skill: "Guard", category: "Strength", elite: true }],
  alreadyPrinted: [],
};
const BASE_INDUCEMENTS = { inducements: [{ key: "bribes", label: "Bribes", price: 100000, max: 3, allowed: true }] };

function routes(over: Routes = {}): Routes {
  return {
    "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
    "/api/fork/rosters": { rosters: [HUMAN, ORC] },
    "/api/packages": [{ name: "BB2025 Default", description: "Baseline" }, { name: "Test Cup", description: "A test ruleset" }],
    "/api/packages/BB2025%20Default": { pkg: { description: "Baseline", eligibleRosters: ["*"] }, rules: { name: "BB2025 Default", budget: null, tierSummary: [] } },
    "/api/fork/team-builder/tiers?packageName=BB2025%20Default": { races: [] },
    "/api/fork/team-builder/inducements?packageName=BB2025%20Default": BASE_INDUCEMENTS,
    "/api/fork/team-builder/inducements": BASE_INDUCEMENTS,
    "/api/skills": {
      general: [{ name: "Block", category: "General", elite: true }, { name: "Tackle", category: "General" }],
      strength: [{ name: "Guard", category: "Strength", elite: true }], agility: [{ name: "Dodge", category: "Agility", elite: true }],
    },
    "/api/fork/team-builder/legal-skills?rosterId=human&positionId=hlin": LEGAL,
    "/api/fork/team-builder/legal-skills?rosterId=human&positionId=hogr": LEGAL,
    "POST /api/fork/team-builder/saves": (body: any) => ({ save: { id: "sv1", name: body.name } }),
    "POST /api/fork/team-builder/build": { teamId: "t1" },
    ...over,
  };
}
const make = (f: Fetcher) => createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
async function freeHuman(f = mockFetcher(routes())) {
  const b = make(f);
  const tab = await b.init({ packageName: FREE_CREATE_PACKAGE, race: "human" });
  return { b, f, tab };
}

describe("Free Create: controller", () => {
  it("ruleset cards: Free Create first with its one-line description; BB2025 Default is no longer offered", async () => {
    const b = make(mockFetcher(routes()));
    await b.init({});
    const cards = b.rulesetCards();
    expect(cards.map((c) => c.label)).toEqual(["Free Create", "Test Cup"]);
    expect(cards[0]).toMatchObject({ name: "free-create", free: true, description: "Build any roster. No tournament rules, no validation." });
  });

  it("?package=free-create&race= opens Free Create on the Roster tab; every base roster is eligible; no package, tier or preview calls", async () => {
    const { b, f, tab } = await freeHuman();
    expect(tab).toBe("roster");
    expect(b.free()).toBe(true);
    expect(b.rulesetLabel()).toBe("Free Create");
    expect([...b.eligibleRosters().keys()].sort()).toEqual(["human", "orc"]);
    expect(b.freeRaces().map((r) => r.raceName)).toEqual(["Human", "Orc"]);
    b.setTeamName("Free Reavers");
    b.addPosition("hlin");
    b.stepStaff("reRolls", 1);
    await b.flushPreview();
    expect(f.calls.some((c) => c.path.includes("/preview"))).toBe(false);
    expect(f.calls.some((c) => c.path.startsWith("/api/packages/") || c.path.includes("/tiers"))).toBe(false);
    expect(f.calls.some((c) => c.path === "/api/fork/team-builder/inducements")).toBe(true); // the base list, no package
    expect(b.state.preview).toBeNull();
  });

  it("the race's own roster limits hold; tournament rules don't (any access skill incl. secondary and elite, stats, stars, inducements, no cap)", async () => {
    const { b } = await freeHuman();
    b.setTeamName("Free Reavers");
    expect(b.addPosition("hogr")).toBe(true);
    expect(b.addPosition("hogr")).toBe(false); // position max 1
    b.addPosition("hlin");
    expect(await b.openSkills(1)).toBe("");
    expect(b.addSkill(1, "Tackle")).toBe("");
    expect(b.addSkill(1, "Guard")).toBe(""); // secondary, elite
    expect(b.addSkill(1, "Block")).toBe(""); // elite primary, no per-player cap
    expect(b.addSkill(1, "Dodge")).toBe("Not a legal skill for this position.");
    expect(b.addStat(1, "AV")).toBe("");
    expect(b.addStat(1, "MA")).toBe("Max 1 per player.");
    expect(b.starChoices().map((c) => c.label)).toEqual(["Grim Ironjaw"]); // the race's own stars only
    expect(b.addStar(b.starChoices()[0]!.key)).toBe(true);
    expect(await b.openSkills(2)).toBe("Stars never take added skills.");
    b.stepInducement("bribes", 1);
    const t = b.totals();
    // Skills at the core's flat gold: Tackle 20k + Guard 40k+10k + Block 20k+10k; +AV at the league table's 10k.
    expect(t.skillsCost).toBe(100_000);
    expect(t.statCost).toBe(CHARACTERISTIC_VALUE.AV);
    expect(t.capped).toBe(false);
    expect(t.over).toBe(false);
    expect(t.used).toBe(140_000 + 50_000 + 200_000 + 100_000 + 10_000 + 100_000);
    expect(b.valueLines().at(-1)).toEqual({ label: "Total", value: core.gold(t.used) });
    for (let i = 0; i < 20; i++) b.addPosition("hlin");
    expect(b.state.slots).toHaveLength(16); // 16 players
  });

  it("save line states: no verdict; export, save, share and Create team on Fork once named with a player; build sends the marker", async () => {
    const { b, f } = await freeHuman();
    expect(b.canExport()).toBe(false);
    b.setTeamName("Free Reavers");
    expect(b.canExport()).toBe(false); // no player yet
    b.addPosition("hlin");
    expect(b.canExport()).toBe(true);
    expect(b.canBuild()).toBe(true);
    expect(b.canSave()).toBe(true);
    expect(b.canShare()).toBe(false); // not saved yet
    expect(await b.saveTeam()).toBe(true);
    expect(b.canShare()).toBe(true);
    expect(await b.build()).toBe(true);
    const build = f.calls.find((c) => c.path === "/api/fork/team-builder/build")!.body as any;
    expect(build.packageName).toBe("free-create");
    expect(build.saveId).toBe("sv1");
  });

  it("save round trip: the free marker and the checkbox are stored and reload into Free Create", async () => {
    const { b, f } = await freeHuman();
    b.setTeamName("Wild Bunch");
    await b.setIgnoreLimits(true);
    b.addPosition("hogr");
    b.addPosition("hogr");
    const pair = b.starChoices().find((c) => c.paired)!;
    expect(b.addStar(pair.key)).toBe(true);
    await b.saveTeam();
    const saved = (f.calls.find((c) => c.method === "POST" && c.path.endsWith("/saves"))!.body as any).body;
    expect(saved).toMatchObject({ packageName: "free-create", ignoreLimits: true, rosterId: "human" });

    const g = mockFetcher(routes({ "/api/fork/team-builder/saves/sv1": { save: { id: "sv1", name: "Wild Bunch", body: saved } } }));
    const c = make(g);
    expect(await c.init({ saveId: "sv1" })).toBe("roster");
    expect(c.free()).toBe(true);
    expect(c.state.ignoreLimits).toBe(true);
    expect(c.state.slots.map((s) => s.positionId)).toEqual(["hogr", "hogr", "sgrak", "scrum"]);
    expect(c.positionById("sgrak")?.name).toBe("Grak");
    expect(g.calls.some((x) => x.path.includes("/preview"))).toBe(false);
  });

  it("an old ?package=BB2025 Default link still opens that package (its card is just not shown)", async () => {
    const b = make(mockFetcher(routes()));
    const tab = await b.init({ packageName: "BB2025 Default", race: "human" });
    expect(tab).toBe("roster");
    expect(b.state.packageName).toBe("BB2025 Default");
    expect(b.free()).toBe(false);
  });
});

describe("Free Create: Ignore in-game limits", () => {
  it("lists every star, lifts position maxes, skill access and stat limits; 16 players stays the limit", async () => {
    const { b } = await freeHuman();
    b.setTeamName("Wild Bunch");
    const before = b.starChoices().length;
    await b.setIgnoreLimits(true);
    expect(b.starChoices().map((c) => c.label).sort()).toEqual(["Grak & Crumbleberry", "Grim Ironjaw"].sort());
    expect(b.starChoices().length).toBeGreaterThan(before);
    const pair = b.starChoices().find((c) => c.paired)!;
    expect(b.addStar(pair.key)).toBe(true);
    expect(b.state.slots.map((s) => s.positionId)).toEqual(["sgrak", "scrum"]); // pairs together
    expect(b.addPosition("hogr")).toBe(true);
    expect(b.addPosition("hogr")).toBe(true); // over the position's max
    expect(b.positionCards().find((c) => c.position.positionId === "hogr")?.exhausted).toBe(false);
    expect(await b.openSkills(2)).toBe("");
    const other = b.pickerSections(2)!.find((s) => s.label === "Other skills")!;
    expect(other.groups.flatMap((g) => g.skills.map((k) => k.skill))).toContain("Dodge");
    expect(b.addSkill(2, "Dodge")).toBe(""); // outside the Ogre's access
    expect(b.accessOf("hogr", "Dodge")).toBe("secondary");
    expect(b.addStat(2, "AV")).toBe("");
    expect(b.addStat(2, "MA")).toBe("");
    expect(b.requestBody().ignoreLimits).toBe(true);
    for (let i = 0; i < 20; i++) b.addPosition("hlin");
    expect(b.state.slots).toHaveLength(16);
    expect(b.addStar(b.starChoices().find((c) => !c.paired)!.key)).toBe(false); // stars count toward the 16
  });

  it("unticking puts the race's limits back and says how many changes were undone", async () => {
    const { b } = await freeHuman();
    b.setTeamName("Wild Bunch");
    await b.setIgnoreLimits(true);
    b.addStar(b.starChoices().find((c) => c.paired)!.key);
    b.addPosition("hogr");
    b.addPosition("hogr");
    await b.openSkills(2);
    b.addSkill(2, "Dodge");
    b.addSkill(2, "Tackle");
    b.addStat(2, "AV");
    b.addStat(2, "MA");
    await b.setIgnoreLimits(false);
    expect(b.state.slots.map((s) => s.positionId)).toEqual(["hogr"]);
    expect(b.state.slots[0]).toMatchObject({ chosenSkills: ["Tackle"], chosenStatIncreases: ["AV"] });
    expect(b.state.leagueNotice).toBe("In-game limits back on: 5 changes undone.");
    expect(b.requestBody().ignoreLimits).toBeUndefined();
  });

  it("only Free Create has the box; picking another ruleset clears it", async () => {
    const { b } = await freeHuman();
    await b.setIgnoreLimits(true);
    expect(b.ignoring()).toBe(true);
    await b.choosePackage("BB2025 Default");
    expect(b.state.ignoreLimits).toBe(false);
    await b.setIgnoreLimits(true);
    expect(b.state.ignoreLimits).toBe(false);
  });
});

describe("Free Create: sheet and PDF ruleset box", () => {
  const readPublic = (p: string) => readFileSync(new URL(`../public/${p}`, import.meta.url), "utf8");
  const ctx: any = { console, setTimeout, clearTimeout };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  createContext(ctx);
  runInContext(readPublic("sheet-pdf.js"), ctx);

  it("the box reads one row, plus Ignore in-game limits when ticked", async () => {
    const { b } = await freeHuman();
    b.setTeamName("Free Reavers");
    b.addPosition("hlin");
    const m = b.sheetModel();
    expect(m.rulesetName).toBe("Free Create");
    expect(m.summary.find(([k]) => k === "Total")).toEqual(["Total", core.gold(b.totals().used)]); // no cap
    expect(ctx.SheetPdf.rulesetRows(m)).toEqual([["Ruleset", "Free Create — no tournament rules"]]);
    await b.setIgnoreLimits(true);
    expect(ctx.SheetPdf.rulesetRows(b.sheetModel())).toEqual([["Ruleset", "Free Create — no tournament rules"], ["Limits", "Ignore in-game limits"]]);
    const doc = JSON.stringify(ctx.SheetPdf.buildSheetDocDefinition(b.sheetModel(), { gold: core.gold, generatedOn: "2026-10-31" }));
    expect(doc).toContain("Free Create — no tournament rules");
    expect(doc).toContain("Ignore in-game limits");
    expect(doc).not.toContain("TV cap");
    expect(b.teamViewModel().ruleset).toEqual({ name: "Free Create", tierLabel: null });
    expect(b.teamViewModel().summary.cap).toBeNull();
  });

  it("sheetRulesetRows: the Free Create marker ignores every package input", () => {
    expect(sheetRulesetRows({ packageName: "free-create", tierLabel: "Tier 1", raceRules: null, pack: null, tierRules: null, league: "Old World Classic", budget: 1_000_000 }))
      .toEqual([["Ruleset", "Free Create — no tournament rules"]]);
  });
});

describe("Free Create: server", () => {
  const baseline = { name: "Baseline" } as any;
  it("the marker resolves to the standalone baseline (no package echo); ignoreLimits must be a boolean and is stored", () => {
    expect(resolveBuilderPackage(new Map() as any, baseline, "free-create")).toEqual({ pkg: baseline, free: true });
    expect(teamBuilderWireError({ rosterId: "human", packageName: "free-create", ignoreLimits: "yes" })).toBe("ignoreLimits must be a boolean when supplied.");
    expect(teamBuilderWireError({ rosterId: "human", packageName: "free-create", ignoreLimits: true })).toBeNull();
    expect(buildBodyForSave({ rosterId: "human", packageName: "free-create", ignoreLimits: true, junk: 1 })).toEqual({ rosterId: "human", packageName: "free-create", ignoreLimits: true });
  });

  it("a Free Create save is an ordinary save carrying the marker", () => {
    const dir = mkdtempSync(join(tmpdir(), "fc-saves-"));
    const r = createSave({ dir, raceNameFor: () => "Human" }, "Alice", { name: "Free Reavers", body: { rosterId: "human", packageName: "free-create", ignoreLimits: true, picks: [{ positionId: "1", count: 11 }] } });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.save.packageName).toBe("free-create");
      expect(r.save.body).toMatchObject({ packageName: "free-create", ignoreLimits: true });
    }
    expect(createSave({ dir, raceNameFor: () => "" }, "Alice", { name: "Bad", body: { rosterId: "human", packageName: "free-create", ignoreLimits: 1 } }).ok).toBe(false);
  });

  it("the public share view: Free Create stands in the ruleset's place, no cap and no verdict", () => {
    const xml = '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>'
      + '<position id="1"><quantity>16</quantity><name>Human Lineman</name><type>Regular</type><gender>male</gender></position></roster>';
    const composed = composeTeam({ forkRosterXml: xml, coach: "C", teamName: "T", reRolls: 0, apothecary: false, picks: [{ positionId: "1", count: 3 }] }, bb2025, 1);
    const save = { id: "sv_f", name: "Free", rosterId: "human", raceName: "Human", packageName: "free-create", teamId: null, updatedAt: "", createdAt: "", body: { rosterId: "human", packageName: "free-create" } } as TeamBuilderSave;
    const view = sharedTeamView({ coach: "C", save, roster: composed.roster, free: true, ruleset: { name: "Free Create", budget: null, tierLabel: null }, publicDir: mkdtempSync(join(tmpdir(), "fc-share-")) });
    expect(view.ruleset).toEqual({ name: "Free Create", tierLabel: null });
    expect(view.summary.cap).toBeNull();
    expect(view.validity).toMatchObject({ valid: true, issues: 0, findings: [] });
  });

  it("share view of a sheet past the limits: the race's roster widened for display only (quantity 16, other rosters' stars appended)", () => {
    const pos = (id: string, name: string, type: string, q: number) =>
      `<position id="${id}"><quantity>${q}</quantity><name>${name}</name><type>${type}</type><gender>male</gender><cost>50000</cost><movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList></skillList></position>`;
    const head = (id: string, name: string) => `<roster id="${id}"><name>${name}</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>`;
    const human = `${head("human.bb2025", "Human")}${pos("1", "Human Lineman", "Regular", 16)}${pos("3", "Human Blitzer", "Regular", 2)}</roster>
<!-- Time: 0.02 -->`;
    const lizard = `${head("lizardmen.bb2025", "Lizardmen")}${pos("2", "Saurus Blocker", "Regular", 6)}${pos("65825", "Boa Kon'sstriktr", "Star", 1)}</roster>`;
    const xml = freeDisplayRosterXml(new Map([["human.bb2025", human], ["lizardmen.bb2025", lizard]]), "human.bb2025")!;
    expect(xml).toContain('<position id="65825">'); // the foreign star, before the closing tag (the trailing comment stays after it)
    expect(xml).not.toContain("Saurus Blocker");
    expect(xml.indexOf('<position id="65825">')).toBeLessThan(xml.lastIndexOf("</roster>"));
    expect(xml.match(/<quantity>(\d+)<\/quantity>/g)).toEqual(["<quantity>16</quantity>", "<quantity>16</quantity>", "<quantity>1</quantity>"]);
    expect(freeDisplayRosterXml(new Map(), "nope")).toBeUndefined();
    const composed = composeTeam({ forkRosterXml: xml, coach: "C", teamName: "T", reRolls: 0, apothecary: false, custom: true, picks: [{ positionId: "3", count: 3 }, { positionId: "65825", count: 1 }] }, bb2025, 1);
    expect(composed.roster.players.map((p) => p.positionName)).toEqual(["Human Blitzer", "Human Blitzer", "Human Blitzer", "Boa Kon'sstriktr"]);
  });

  it("one characteristic price table: the league table and the Free Create display read the same numbers", () => {
    expect(ADVANCEMENT_VALUE).toBe(CHARACTERISTIC_VALUE);
    const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    expect(src).toContain("if (isFreeCreatePackage(body.packageName)) { input.free = true; input.ruleset = { name: FREE_CREATE_LABEL");
  });
});

describe("Free Create: page (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, builderMod] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/teams/builder.ts")]);
    mods = { app, vueRouter, renderer, builderMod };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, f: Fetcher, prepare?: (b: any) => Promise<void> | void, link: Record<string, string> = { packageName: "free-create", race: "human" }): Promise<string> {
    const builder = mods.builderMod.createTournamentBuilder({ api: f, coach: () => "Alice", previewDelay: 0, origin: () => "https://sf.example", clipboard: async () => undefined });
    await builder.init(link);
    await prepare?.(builder);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.builderMod.TOURNAMENT_BUILDER_KEY, builder);
    await spa.session.load();
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("Ruleset tab: the Free Create card leads with its description, BB2025 Default is gone; the race step is a grid of every roster", async () => {
    const html = await render("/tournament-team-builder?tab=ruleset", mockFetcher(routes()));
    const cards = [...html.matchAll(/data-ruleset="([^"]+)"/g)].map((m) => m[1]);
    expect(cards).toEqual(["free-create", "Test Cup"]);
    expect(html).toContain('<small class="tb-card-desc">Build any roster. No tournament rules, no validation.</small>');
    expect(html).not.toContain("<strong>BB2025 Default</strong>");
    expect([...html.matchAll(/class="tb-free-race" data-tt-race="(\w+)"/g)].map((m) => m[1])).toEqual(["human", "orc"]);
  });

  it("Roster tab: no verdict, Create team on Fork kept, the checkbox, and a Roster summary with no cap, SP or rule bullets", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), (b) => { b.setTeamName("Free Reavers"); b.addPosition("hlin"); });
    expect(html).toContain("Free Create · Human");
    expect(html).not.toContain("TV cap");
    expect(html).not.toContain('id="tb-valid-h"');
    expect(html).not.toMatch(/Team is (in)?valid|Checking team/);
    expect(html).toContain(">Export PDF</button>");
    expect(html).toContain(">Save Team</button>");
    expect(html).toContain(">Create team on Fork</button>");
    expect(html).toMatch(/<input id="tb-ignore-limits" type="checkbox"[^>]*><span>Ignore in-game limits<\/span>/);
    const summary = html.slice(html.indexOf('id="tb-validator-h"'));
    expect(summary).toMatch(/^id="tb-validator-h">Roster summary</);
    expect(summary).not.toContain('class="tb-sp"');
    expect(summary).not.toContain('class="tb-rules"');
    const total = summary.slice(summary.indexOf('class="tv-total"'), summary.indexOf("</div>", summary.indexOf('class="tv-total"')));
    expect(total).toContain("<span>Total</span>");
    expect(total).not.toContain("<small>"); // no cap fraction on the total
  });

  it("a tournament ruleset still shows the verdict and has no checkbox", async () => {
    const html = await render("/tournament-team-builder?tab=roster", mockFetcher(routes()), undefined, { packageName: "BB2025 Default", race: "human" });
    expect(html).toContain('id="tb-valid-h"');
    expect(html).not.toContain('id="tb-ignore-limits"');
    expect(html).toContain(">Validator</h2>");
  });
});
