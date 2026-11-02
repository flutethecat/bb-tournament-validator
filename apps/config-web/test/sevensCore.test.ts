import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRoster, loadPackage, resolveTeamConfig, SEVENS_INDUCEMENTS, SEVENS_PROFILE, SEVENS_STAFF_PRICES, SEVENS_TEAM_TIERS, sevensTierDef, type DeepPartial, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";
import { packageSchemaProblems } from "../src/packageSchema.js";
import { packageOverview, resolveBuilderPackage, SEVENS_FREE_CREATE_BUILD_PACKAGE, SEVENS_TABLETOP_ONLY } from "../src/teamBuilderPackage.js";
import { teamBuilderInducementCatalog } from "../src/teamBuilderInducements.js";
import { SEVENS_FREE_CREATE_LABEL, SEVENS_FREE_CREATE_PACKAGE } from "../src/freeCreate.js";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentCreator, packageSummary } from "../spa/src/tournaments/creator";
import {
  applySevensDefaults, applyStandardDefaults, sevensDrops, freshView, inducementDefs, normalizePackage, SEVENS_DEFAULTS, SEVENS_INDUCEMENTS as UI_SEVENS_INDUCEMENTS, SEVENS_TIER_TABLE, sevensTier, serializePackage, type RawDoc,
} from "../spa/src/tournaments/creatorCore";

// Blood Bowl Sevens core in config-web (spec-sevens-rules-2026-11-02): the schema, the shipped Matched Play package, Sevens
// Free Create, the Tournament Creator's Format toggle (round trip, defaults, knobs), and the fork refusing Sevens teams.
/* eslint-disable @typescript-eslint/no-explicit-any */

const REPO = new URL("../../../", import.meta.url);
const SHIPPED_TEXT = readFileSync(new URL("tournament-packages/sevens-matched-play.json", REPO), "utf8");
const SHIPPED = JSON.parse(SHIPPED_TEXT) as RawDoc;
const MATCHED = loadPackage(SHIPPED as DeepPartial<TournamentPackage>).pkg;

describe("schema", () => {
  it("accepts the shipped Sevens package and the new fields", () => {
    expect(packageSchemaProblems(SHIPPED)).toEqual([]);
  });
  it("rejects malformed Sevens values", () => {
    const bad = {
      name: "Bad", skillAllotment: {}, format: "eights",
      staffPrices: { reRoll: -1, cheerleader: 1.5, mascot: 5 },
      inducements: { set: "sevens-plus" },
      sideline: { dedicatedFansStart: -2 },
      special: { maxPlayers: 0, maxNonLineman: 2.5, veteran: "yes" },
    };
    const problems = packageSchemaProblems(bad);
    expect(problems).toEqual(expect.arrayContaining([
      "$.format: eights is not one of standard, sevens",
      "$.staffPrices.reRoll: below the minimum 0",
      "$.staffPrices.cheerleader: number is not integer",
      "$.staffPrices: unknown property mascot",
      "$.inducements.set: sevens-plus is not one of core, sevens",
      "$.sideline.dedicatedFansStart: below the minimum 0",
      "$.special.maxPlayers: below the minimum 1",
      "$.special.maxNonLineman: number is not integer|null",
      "$.special.veteran: string is not boolean",
    ]));
  });
});

describe("packages", () => {
  it("Sevens Free Create resolves like Free Create, to League-draft Sevens rules (fans start at 1, no skills)", () => {
    const r = resolveBuilderPackage(new Map() as any, { name: "Baseline" } as any, SEVENS_FREE_CREATE_PACKAGE) as any;
    expect(r.pkg).toBe(SEVENS_FREE_CREATE_BUILD_PACKAGE);
    expect(r.selected).toMatchObject({ name: SEVENS_FREE_CREATE_LABEL });
    expect(r.free).toBeUndefined();
    const p = SEVENS_FREE_CREATE_BUILD_PACKAGE;
    expect(p).toMatchObject({ format: "sevens", goldBudget: 600000, staffPrices: SEVENS_STAFF_PRICES });
    expect(p.sideline.dedicatedFansStart).toBe(1);
    expect(p.special).toMatchObject({ minPlayers: 7, maxPlayers: 11, maxNonLineman: 4, veteran: true });
    expect(p.skillAllotment.skillPointBudget).toBe(0);
    expect(p.tiers).toBeUndefined();
  });

  it("the Matched Play package's overview leads with the Sevens format line; inducements are the Sevens list", () => {
    const o = packageOverview(MATCHED);
    expect(o.summary[0]).toEqual({
      key: "format",
      label: "Format",
      text: "Blood Bowl Sevens, tabletop only: 7–11 players, at most 4 without the Lineman keyword, one Lineman as the Veteran (MA −1). Staff: rerolls 100k, assistant coaches 20k, cheerleaders 20k, apothecary 80k, Dedicated Fans 20k each from 0.",
    });
    expect(o.summary.find((l) => l.key === "inducements")!.text).toBe("All Sevens inducements (incl. Desperate Measures) at Sevens prices.");
    expect(o.summary.some((l) => l.key === "minPlayers")).toBe(false);
    expect(o.groups.map((g) => g.label)).toEqual(["Tier 1", "Tier 2", "Tier 3", "Tier 4"]);
    const rows = teamBuilderInducementCatalog(MATCHED, bb2025);
    expect(rows.map((r) => r.key)).toEqual(Object.keys(SEVENS_INDUCEMENTS).sort());
    expect(rows.find((r) => r.key === "desperate_measures")).toMatchObject({ label: "Desperate Measures", price: 50000, max: 5, allowed: true });
    expect(rows.find((r) => r.key === "bribes")).toMatchObject({ price: 100000, max: 2, reducedPrice: 50000, reducedSpecialRule: "Bribery and Corruption" });
  });
});

describe("Tournament Creator: the Format toggle", () => {
  it("mirrors the validator's Sevens profile, tiers and inducement list", () => {
    expect(SEVENS_DEFAULTS.goldBudget).toBe(SEVENS_PROFILE.goldBudget);
    expect(SEVENS_DEFAULTS.staffPrices).toEqual(SEVENS_PROFILE.staffPrices);
    expect(SEVENS_DEFAULTS.skillAllotment).toEqual(SEVENS_PROFILE.skillAllotment);
    expect(SEVENS_DEFAULTS.starPlayers).toEqual(SEVENS_PROFILE.starPlayers);
    expect(SEVENS_DEFAULTS.inducements).toEqual(SEVENS_PROFILE.inducements);
    expect(SEVENS_DEFAULTS.sideline).toEqual(SEVENS_PROFILE.sideline);
    expect(SEVENS_DEFAULTS.special).toEqual(SEVENS_PROFILE.special);
    expect(SEVENS_TIER_TABLE).toEqual(SEVENS_TEAM_TIERS.map((t) => ({ tier: t.tier, rosters: [...t.rosters] })));
    expect(SEVENS_TIER_TABLE.map((t) => sevensTier(t.tier, t.rosters))).toEqual(SEVENS_TEAM_TIERS.map((t) => sevensTierDef(t.tier, t.rosters)));
    expect(UI_SEVENS_INDUCEMENTS.map((i) => [i.id, i.label, i.max])).toEqual(Object.entries(SEVENS_INDUCEMENTS).map(([id, r]) => [id, r.name, r.max]));
    for (const team of SEVENS_TIER_TABLE.flatMap((t) => t.rosters)) expect(findRoster(bb2025, team)?.name).toBe(team);
  });

  it("round-trip law: the shipped Sevens package and a minimal Sevens document serialise back unchanged", () => {
    for (const doc of [SHIPPED, { name: "Tiny Sevens", format: "sevens", skillAllotment: {} } as RawDoc]) {
      const filled = new Set<string>();
      const pkg = normalizePackage(doc, filled);
      const out = serializePackage(pkg, { original: doc, baseline: normalizePackage(doc), view: freshView("tiers", "pool"), book: { touched: new Set(), injected: filled } });
      expect(out).toEqual(doc);
    }
    // Absent keys of a Sevens document show the Sevens values (what the validator applies), not the 11s defaults.
    const tiny = normalizePackage({ name: "Tiny Sevens", format: "sevens", skillAllotment: {} });
    expect(tiny).toMatchObject({ goldBudget: 600000, staffPrices: SEVENS_STAFF_PRICES, special: { maxPlayers: 11, minPlayers: 7, veteran: true }, sideline: { maxReRolls: 6, dedicatedFansStart: 0 } });
    expect(inducementDefs(tiny).map((i) => i.id)).toContain("desperate_measures");
  });

  const mock = (routes: Record<string, unknown>): Fetcher =>
    (async (path: string, init?: { method?: string; body?: unknown }) => {
      const method = init?.method ?? "GET";
      const hit = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
      if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
      return typeof hit === "function" ? (hit as (b: unknown) => unknown)(init?.body) : hit;
    }) as Fetcher;
  const saved: unknown[] = [];
  const API = {
    "/api/packages": ["Club Cup"],
    "/api/packages/Club%20Cup": () => ({ raw: { name: "Club Cup", date: "2026-12-01", description: "Our cup", goldBudget: 1100000, skillAllotment: { skillPointBudget: 4 } }, revision: "r1", problems: [], schemaProblems: [] }),
    "/api/presets": [], "/api/skills": { elite: [], general: [] }, "/api/stars": [], "/api/positions": [],
    "/api/teams": [...SEVENS_TIER_TABLE.flatMap((t) => t.rosters.map((name) => ({ name, defaultTier: t.tier }))), { name: "Slann", defaultTier: 2 }],
    "POST /api/packages": (body: unknown) => { saved.push(body); return { name: (body as any).name, revision: "r2", problems: [] }; },
  };

  it("Sevens applies the defaults, every knob stays editable, the save carries them, and Standard restores the 11s rules", async () => {
    const c = createTournamentCreator({ api: mock(API) });
    await c.init();
    await c.open("Club Cup");
    c.setFormat("sevens");
    expect(c.state.formatNotice).toBe("Sevens defaults applied — edit any below.");
    const pkg = c.state.pkg!;
    expect(pkg).toMatchObject({ format: "sevens", goldBudget: 600000, staffPrices: SEVENS_STAFF_PRICES, starPlayers: { allowed: false, maxCount: 0 } });
    expect(pkg.special).toMatchObject({ minPlayers: 7, maxPlayers: 11, maxNonLineman: 4, veteran: true });
    expect(pkg.inducements).toEqual({ set: "sevens", allowed: ["*"], caps: {} });
    expect(pkg.tiers.map((t) => [t.tier, t.maxPrimary, t.rosters.length])).toEqual([[1, 1, 11], [2, 2, 9], [3, 3, 6], [4, 4, 4]]);
    expect(packageSummary(c.state).slice(0, 4)).toEqual([
      { label: "Format", value: "Blood Bowl Sevens (tabletop only)" },
      { label: "Players", value: "7–11" },
      { label: "Non-Lineman", value: "at most 4" },
      { label: "Veteran", value: "required" },
    ]);
    // Stars stay locked off.
    c.toggleStarsAllowed();
    expect(c.state.pkg!.starPlayers.allowed).toBe(false);
    // Knobs: budget "slightly higher", players, staff price, fans start 1, Slann added to Tier 2, an inducement dropped + a cap.
    c.setBound(["goldBudget"], "gold", "delete", "650");
    c.setBound(["special", "maxPlayers"], "int", "delete", "10");
    c.setBound(["staffPrices", "cheerleader"], "gold", "delete", "15");
    c.setBound(["sideline", "dedicatedFansStart"], "int", "delete", "1");
    c.toggleSpecial("veteran");
    c.assignTeamToTier("Slann", 1);
    c.toggleInducement("desperate_measures");
    c.stepInducement("bribes", -1);
    await c.save();
    const sent = saved.at(-1) as any;
    expect(sent).toMatchObject({
      name: "Club Cup", date: "2026-12-01", description: "Our cup", format: "sevens", goldBudget: 650000,
      staffPrices: { reRoll: 100000, cheerleader: 15000 },
      special: { maxPlayers: 10, maxNonLineman: 4, veteran: false, minPlayers: 7 },
      sideline: { dedicatedFansStart: 1, maxReRolls: 6 },
      inducements: { set: "sevens", caps: { bribes: 1 } },
    });
    expect(sent.inducements.allowed).not.toContain("desperate_measures");
    expect(sent.inducements.allowed).toContain("bribes");
    expect(sent.tiers[1].rosters).toContain("Slann");
    expect(packageSchemaProblems(sent)).toEqual([]);
    const resolved = loadPackage(sent);
    expect(resolved.problems).toEqual([]);
    expect(resolved.pkg.staffPrices).toMatchObject({ cheerleader: 15000, apothecary: 80000 });
    // Back to Standard: the rules reset, the details stay.
    c.setFormat("standard");
    expect(c.state.formatNotice).toBe("Standard defaults restored.");
    const back = c.serialize() as any;
    expect(back.format).toBeUndefined();
    expect(back.staffPrices).toBeUndefined();
    expect(back.tiers).toBeUndefined();
    expect(back).toMatchObject({ name: "Club Cup", date: "2026-12-01", description: "Our cup", goldBudget: null });
    expect(back.special?.maxPlayers).toBeUndefined();
    expect(back.inducements?.set).toBeUndefined();
    expect(loadPackage(back).pkg.format).toBeUndefined();
  });
});

describe("Tournament Creator: Format toggle edge cases (Sol 2c869b5e)", () => {
  it("Sevens lists and then drops what would fight the defaults (team-rule budgets, other tiers, packs)", () => {
    const naf = normalizePackage(JSON.parse(readFileSync(new URL("tournament-packages/naf-world-cup-2027.json", REPO), "utf8")));
    const drops = sevensDrops(naf);
    expect(drops.some((d) => /team rules? \(per-race budgets and skills\)/.test(d))).toBe(true);
    applySevensDefaults(naf);
    expect(naf.teamRules).toEqual([]);
    expect(naf.matrix).toBeUndefined();
    expect(naf.skillPackages).toEqual([]);
    const resolved = loadPackage(naf as any).pkg;
    for (const race of ["Ogre", "Orc", "Human"]) expect(resolveTeamConfig(resolved, race).gold).toBe(600000);
    expect(sevensDrops(normalizePackage({ name: "Blank", skillAllotment: {} }))).toEqual([]);
  });

  it("Standard clears an extends to a Sevens base and every Sevens-only field", () => {
    const pkg = normalizePackage({ name: "Club Sevens", extends: "Blood Bowl Sevens (Matched Play)", format: "sevens", skillAllotment: {}, special: { maxPlayers: 10 } });
    applyStandardDefaults(pkg);
    expect(pkg.extends).toBe("");
    expect(pkg.format).toBeUndefined();
    expect(pkg.staffPrices).toBeUndefined();
    expect(pkg.special.maxPlayers).toBeUndefined();
    expect(pkg.special.veteran).toBeUndefined();
    expect(pkg.inducements.set).toBeUndefined();
    expect(pkg.sideline.dedicatedFansStart).toBeUndefined();
    const raw = { ...pkg, extends: undefined } as any;
    expect(loadPackage(raw, { resolveExtends: () => SHIPPED as any }).pkg.format).toBeUndefined();
  });
});

describe("fork create refuses Sevens; preview prices them the Sevens way", () => {
  const root = mkdtempSync(join(tmpdir(), "sevens-http-"));
  const previousEnv = new Map<string, string | undefined>();
  let origin = "";
  let server: (typeof import("../src/server.js"))["server"];
  const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const HUMAN = findRoster(bb2025, "Human")!;
  const humanXml = `<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${HUMAN.positions
    .map((p, i) => `<position id="h${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender><cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility><passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList>${p.skills.map((s) => `<skill>${s}</skill>`).join("")}</skillList></position>`)
    .join("")}</roster>`;
  const pos = (name: string) => `h${HUMAN.positions.findIndex((p) => p.name === name) + 1}`;
  const picks = [
    { positionId: pos("Human Lineman"), count: 1, veteran: true },
    { positionId: pos("Human Lineman"), count: 3 },
    { positionId: pos("Human Blitzer"), count: 2 },
    { positionId: pos("Human Catcher"), count: 1 },
  ];

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
    writeFileSync(join(root, "rosters", "human.xml"), humanXml, "utf8");
    copyFileSync(new URL("tournament-packages/sevens-matched-play.json", REPO), join(root, "packages", "sevens-matched-play.json"));
    // Two extends hops over the Sevens package, no format of their own (Sol 2c869b5e #1).
    writeFileSync(join(root, "packages", "sevens-middle.json"), JSON.stringify({ name: "Sevens Middle", extends: "Blood Bowl Sevens (Matched Play)", skillAllotment: {} }), "utf8");
    writeFileSync(join(root, "packages", "sevens-leaf.json"), JSON.stringify({ name: "Sevens Leaf", extends: "Sevens Middle", skillAllotment: {} }), "utf8");
    writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("Alice") }), "utf8");
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
    ({ server } = await import("../src/server.js"));
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  });

  const post = async (path: string, body: unknown) => {
    const alice = createSession("Alice");
    const res = await fetch(`${origin}${path}`, { method: "POST", headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it("POST /api/fork/team-builder/build answers 400 for a Sevens package and for Sevens Free Create; nothing is written", async () => {
    for (const packageName of ["Blood Bowl Sevens (Matched Play)", SEVENS_FREE_CREATE_PACKAGE, "Sevens Leaf"]) {
      const r = await post("/api/fork/team-builder/build", { rosterId: "human.bb2025", coach: "Alice", teamName: "Seven Up", picks, reRolls: 1, apothecary: false, dedicatedFans: 0, packageName });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe(SEVENS_TABLETOP_ONLY);
      expect(SEVENS_TABLETOP_ONLY).toMatch(/^Sevens teams are tabletop only/);
    }
    expect(readdirSync(join(root, "teams"))).toEqual([]);
    expect(readdirSync(join(root, "library"))).toEqual([]);
  });

  it("POST /api/fork/team-builder/preview validates a Sevens team at Sevens prices and echoes its limits", async () => {
    const r = await post("/api/fork/team-builder/preview", {
      rosterId: "human.bb2025", coach: "Alice", teamName: "Seven Up", picks, reRolls: 1, apothecary: false, dedicatedFans: 0,
      packageName: "Blood Bowl Sevens (Matched Play)", rosteredInducements: [{ key: "desperate_measures", count: 1 }],
    });
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.valid).toBe(true);
    expect(r.body.summary).toMatchObject({ goldUsed: 595000, goldBudget: 600000, inducementsCost: 50000, skillsCost: 0 });
    expect(r.body.package.limits).toMatchObject({ format: "sevens", maxPlayers: 11, maxNonLineman: 4, veteran: { required: true } });
    // No Veteran: the preview says so.
    const none = await post("/api/fork/team-builder/preview", { rosterId: "human.bb2025", coach: "Alice", teamName: "Seven Up", picks: picks.map((p) => ({ ...p, veteran: false })), reRolls: 1, apothecary: false, dedicatedFans: 0, packageName: SEVENS_FREE_CREATE_PACKAGE });
    expect(none.body.errors.map((e: any) => e.message)).toContain("Pick one Lineman as the Veteran.");
    // Sevens Free Create starts every team on 1 Dedicated Fan (Sol 2c869b5e #7).
    expect(none.body.errors.map((e: any) => e.message)).toContain("0 dedicated fans; this ruleset starts every team on 1 (free).");
    const inds = (await (await fetch(`${origin}/api/fork/team-builder/inducements?packageName=${encodeURIComponent("Blood Bowl Sevens (Matched Play)")}`)).json()) as any;
    expect(inds.inducements.map((i: any) => i.key)).toContain("desperate_measures");
  });
});
