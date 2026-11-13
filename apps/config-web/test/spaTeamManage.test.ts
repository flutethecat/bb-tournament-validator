import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { summaryFromManaged } from "../spa/src/teams/summary";
import { builderHref, canAdvance, careerCells, createTeamManage, dialogKey, nextCostHint, progressLine, sppMeter, teamManagePath, valueBreakdownText, type PlayerProgress, type TeamManageModel } from "../spa/src/teams/manage";

// Team management page (/app/teams/:ref, owner 10-30) and the My teams page restyle. The controller is tested directly;
// the views are server-rendered through the SPA's own Vite config (as spaHome.test.ts does).
const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const REV = "a".repeat(64);
const REV2 = "b".repeat(64);

type Routes = Record<string, unknown | ((body: unknown) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body: unknown }> } {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = `${method} ${path}` in routes ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown) => unknown)(init.body) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const cap = (available: boolean, reason?: string) => (reason ? { available, reason } : { available });
const progress = (over: Partial<PlayerProgress> = {}): PlayerProgress => ({
  id: "p1", spp: 12, earnedSpp: null, advancements: 2, rank: "Emerging Star",
  costs: { randomPrimary: 6, chosenPrimary: 12, chosenSecondary: 16, characteristic: 20 },
  methods: { randomPrimary: cap(true), chosenPrimary: cap(true), chosenSecondary: cap(false, "Secondary advancements are unavailable."), characteristic: cap(false, "Needs 20 SPP; 12 available.") },
  pending: null, primaryCategories: ["General", "Strength"], secondaryCategories: ["Agility"], primarySkills: ["Block", "Tackle"], secondarySkills: ["Dodge"],
  canAddSkill: true, canAddCharacteristic: false, mng: false, injuries: [], ...over,
});
const player = (number: number, name: string, prog?: PlayerProgress) => ({
  number, name, position: "Blitzer", positionFull: "Orc Blitzer", isStar: false, stats: { MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "10+" },
  printed: [{ name: "Block", category: "General" }], added: [], statIncreases: [], cost: 80000, sprite: null, ...(prog ? { progress: prog } : {}),
});
const libraryModel = (players = [player(1, "Big <Bob>", progress()), player(2, "Grit", progress({ id: "p2", spp: 0, canAddSkill: false, methods: { randomPrimary: cap(false, "Needs 6 SPP; 0 available."), chosenPrimary: cap(false, "x"), chosenSecondary: cap(false, "x"), characteristic: cap(false, "x") } }))]): TeamManageModel => ({
  team: {
    teamName: "Da Boyz", coach: "Alice", raceName: "Orc", crest: null, ruleset: null, updatedAt: "2026-10-01T00:00:00Z", players,
    sideline: { reRolls: 2, apothecary: true, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 2 }, inducements: [], specialRules: [],
    summary: { players: players.length, total: 1_000_000, cap: null, primarySkills: 0, secondarySkills: 0 },
    validity: { valid: true, issues: 0, custom: false, findings: [] }, verdict: "On the fork",
  },
  manage: { kind: "library", ref: "library:77", teamId: "77", revision: REV, saveId: "sv_a", treasury: 50000, teamValue: 1000, advancement: { available: true } },
});

describe("team management controller", () => {
  it("loads the model; 404 reads as not-yours", async () => {
    const f = mockFetcher({ "/api/me/teams/library%3A77": libraryModel() });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    expect(m.state.model?.team.teamName).toBe("Da Boyz");
    const g = createTeamManage({ api: mockFetcher({ "/api/me/teams/library%3A9": new ApiError(404, "Team not found.") }) });
    await g.load("library:9");
    expect(g.state).toMatchObject({ notFound: true, model: null, error: "Team not found." });
    expect(teamManagePath("library:77")).toBe("/teams/library%3A77");
    expect(builderHref("sv_a")).toBe("/tournament-team-builder/sv_a");
  });

  it("random Primary: roll a category, keep a rolled skill with the reserved revision, then reload on close", async () => {
    const pending = { token: "tok", playerId: "p1", revision: REV2, method: "randomPrimary", cost: 6, choices: ["Tackle", "Tackle"], primaryFallbacks: [], secondaryFallbacks: [], expiresAt: "x" };
    const f = mockFetcher({
      "/api/me/teams/library%3A77": libraryModel(),
      "POST /api/teams/77/advancement": (body: any) => (body.action === "rollRandomPrimary" ? { pending } : { ok: true, revision: "c".repeat(64), playerId: "p1", spentSpp: 6, valueIncrease: 20000 }),
    });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    m.open(0, "skill");
    expect(m.state.flow).toMatchObject({ step: "choose", kind: "skill" });
    await m.rollRandomPrimary("Strength");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", body: { action: "rollRandomPrimary", playerId: "p1", revision: REV, category: "Strength" } });
    expect(m.state.flow).toMatchObject({ step: "pick", pending: { token: "tok" } });
    await m.commit({ type: "skill", skill: "Tackle" });
    expect(f.calls.at(-1)!.body).toEqual({ action: "commitRoll", playerId: "p1", revision: REV2, token: "tok", choice: { type: "skill", skill: "Tackle" } });
    expect(m.state.flow).toMatchObject({ step: "done", result: "Tackle added. 6 SPP spent, team value +20k." });
    m.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.state.flow).toBeNull();
    expect(f.calls.filter((c) => c.path === "/api/me/teams/library%3A77")).toHaveLength(2);
  });

  it("chosen Primary and a characteristic roll's Primary fallback (access primary); a stored roll resumes at the pick step", async () => {
    const charPending = { token: "t2", playerId: "p1", revision: REV2, method: "characteristic", cost: 20, roll: 6, choices: ["AG"], primaryFallbacks: ["Block"], secondaryFallbacks: [], expiresAt: "x" };
    const model = libraryModel([player(1, "Bob", progress({ pending: charPending as never }))]);
    const f = mockFetcher({ "/api/me/teams/library%3A77": model, "POST /api/teams/77/advancement": { ok: true, spentSpp: 20, valueIncrease: 20000 } });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    m.open(0, "skill");
    expect(m.state.flow).toMatchObject({ kind: "characteristic", step: "pick" });
    await m.commit({ type: "skill", skill: "Block" });
    expect(f.calls.at(-1)!.body).toMatchObject({ action: "commitRoll", token: "t2", choice: { type: "skill", skill: "Block", access: "primary" } });

    const g = mockFetcher({ "/api/me/teams/library%3A77": libraryModel(), "POST /api/teams/77/advancement": { ok: true, spentSpp: 12, valueIncrease: 20000 } });
    const n = createTeamManage({ api: g });
    await n.load("library:77");
    n.open(0, "skill");
    await n.chooseSkill("Tackle");
    expect(g.calls.at(-1)!.body).toEqual({ action: "applySkill", playerId: "p1", revision: REV, method: "chosenPrimary", skill: "Tackle" });
  });

  it("shows the server's refusal and keeps the step", async () => {
    const f = mockFetcher({ "/api/me/teams/library%3A77": libraryModel(), "POST /api/teams/77/advancement": new ApiError(409, "The team changed since it was loaded. Refresh and try again.") });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    m.open(0, "characteristic");
    await m.rollCharacteristic();
    expect(m.state.flow).toMatchObject({ step: "choose", error: "The team changed since it was loaded. Refresh and try again. Close this window to reload the team." });
  });

  it("a 409 conflict marks the flow stale: close reloads the team, and the reopened modal sends the fresh revision", async () => {
    let revision = REV;
    const f = mockFetcher({
      "/api/me/teams/library%3A77": () => ({ ...libraryModel(), manage: { ...libraryModel().manage, revision } }),
      "POST /api/teams/77/advancement": (body: any) => (body.revision === REV ? new ApiError(409, "The team changed since it was loaded. Refresh and try again.") : { pending: { token: "t", playerId: "p1", revision: "c".repeat(64), method: "randomPrimary", cost: 6, choices: ["Tackle", "Block"], primaryFallbacks: [], secondaryFallbacks: [], expiresAt: "x" } }),
    });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    m.open(0, "skill");
    await m.rollRandomPrimary("General");
    expect(m.state.flow).toMatchObject({ stale: true, step: "choose" });
    revision = REV2; // someone else changed the team
    expect(m.close()).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(f.calls.filter((c) => c.path === "/api/me/teams/library%3A77")).toHaveLength(2);
    expect(m.state.model?.manage.revision).toBe(REV2);
    m.open(0, "skill");
    await m.rollRandomPrimary("General");
    expect(f.calls.at(-1)!.body).toMatchObject({ action: "rollRandomPrimary", revision: REV2 });
    expect(m.state.flow).toMatchObject({ step: "pick", stale: false });
  });

  it("while a request is in flight, open() and close() are refused; a response only lands in the flow and player that sent it", async () => {
    let release!: (v: unknown) => void;
    const pendingA = { token: "tA", playerId: "p1", revision: REV2, method: "characteristic", cost: 20, roll: 7, choices: ["ST"], primaryFallbacks: [], secondaryFallbacks: [], expiresAt: "x" };
    const f = mockFetcher({
      "/api/me/teams/library%3A77": libraryModel(),
      "POST /api/teams/77/advancement": () => new Promise((r) => { release = r; }),
    });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    m.open(0, "characteristic");
    const first = m.state.flow!;
    const rolling = m.rollCharacteristic();
    expect(m.state.flow!.busy).toBe(true);
    expect(m.open(1, "skill")).toBe(false); // player B's button while A's roll runs
    expect(m.close()).toBe(false);
    expect(m.state.flow).toBe(first);
    release({ pending: pendingA });
    await rolling;
    expect(m.state.flow).toMatchObject({ playerId: "p1", playerIndex: 0, step: "pick", pending: { token: "tA" } });

    // A reservation answered for a different player is never shown in this modal.
    const g = mockFetcher({ "/api/me/teams/library%3A77": libraryModel(), "POST /api/teams/77/advancement": { pending: { ...pendingA, playerId: "p2" } } });
    const n = createTeamManage({ api: g });
    await n.load("library:77");
    n.open(0, "characteristic");
    await n.rollCharacteristic();
    expect(n.state.flow).toMatchObject({ playerId: "p1", step: "choose", pending: null });
    // A stored roll that belongs to someone else is never committed from this flow.
    n.state.flow!.pending = { ...pendingA, playerId: "p2" } as never;
    const before = g.calls.length;
    await n.commit({ type: "characteristic", characteristic: "ST" });
    expect(g.calls.length).toBe(before);
  });

  it("dialog keys: Escape closes (blocked while busy), Tab and Shift+Tab wrap inside the dialog, focus outside is pulled in", () => {
    const [a, b, c] = ["a", "b", "c"];
    const list = [a, b, c];
    expect(dialogKey({ key: "Escape", shiftKey: false }, list, b, false)).toEqual({ type: "close" });
    expect(dialogKey({ key: "Escape", shiftKey: false }, list, b, true)).toEqual({ type: "block" });
    expect(dialogKey({ key: "Tab", shiftKey: false }, list, c, false)).toEqual({ type: "focus", target: a });
    expect(dialogKey({ key: "Tab", shiftKey: true }, list, a, false)).toEqual({ type: "focus", target: c });
    expect(dialogKey({ key: "Tab", shiftKey: false }, list, b, false)).toBeNull(); // the browser moves to c
    expect(dialogKey({ key: "Tab", shiftKey: false }, list, "background-button", false)).toEqual({ type: "focus", target: a });
    expect(dialogKey({ key: "Tab", shiftKey: false }, [], null, false)).toEqual({ type: "block" });
    expect(dialogKey({ key: "Enter", shiftKey: false }, list, a, false)).toBeNull();
  });

  it("dialog keys: the shell's [ shortcut is stopped inside both team dialogs so it never opens the drawer above them", async () => {
    expect(dialogKey({ key: "[", shiftKey: false }, ["a"], "a", false)).toEqual({ type: "stop" });
    expect(dialogKey({ key: "[", shiftKey: false }, [], null, true)).toEqual({ type: "stop" });
    // both dialogs' window (capture) handlers stop propagation for it, and the containers stop bubbling keydowns
    const { readFileSync } = await import("node:fs");
    for (const file of ["AdvanceModal.vue", "PlayerSheetModal.vue"]) {
      const src = readFileSync(fileURLToPath(new URL(`../spa/src/components/${file}`, import.meta.url)), "utf8");
      expect(src).toContain('if (action.type === "stop") { e.stopPropagation(); return; }');
      expect(src).toMatch(/role="dialog" @keydown\.stop/);
      expect(src).toContain('window.addEventListener("keydown", onKey, true)');
    }
  });

  it("avatar dialog controller: open/close, upload PUTs the library ref's avatar route and cache-busts, remove DELETEs, errors stay inline", async () => {
    let served: string | undefined; // what the server reports on the next team read
    const f = mockFetcher({ "/api/me/teams/library%3A77": () => { const m = libraryModel(); return served ? { ...m, team: { ...m.team, avatarUrl: served } } : m; }, "DELETE /api/fork/teams/library%3A77/avatar": { ok: true } });
    const puts: Array<{ path: string; size: number }> = [];
    let answer: { ok: boolean; status: number; avatarUrl?: string; error?: string } = { ok: true, status: 200, avatarUrl: "/api/fork/teams/library%3A77/avatar?v=111" };
    let clock = 1000;
    const m = createTeamManage({ api: f, now: () => clock, upload: async (path, body) => { puts.push({ path, size: body.size }); return answer; } });
    expect(m.openAvatar()).toBe(false); // nothing loaded yet
    await m.load("library:77");
    expect(m.openAvatar()).toBe(true);
    expect(m.state.avatar.open).toBe(true);
    expect(m.openAvatar()).toBe(false);
    expect(m.open(0, "skill")).toBe(false); // other dialogs refused while it is open
    expect(m.openSheet(0)).toBe(false);
    expect(m.closeAvatar()).toBe(true);
    expect(m.state.avatar.open).toBe(false);
    m.openAvatar();
    expect(await m.removeAvatar()).toBe(false); // no avatar yet
    expect(await m.uploadAvatar(new Blob(["x".repeat(10)], { type: "image/png" }))).toBe(true);
    expect(puts).toEqual([{ path: "/api/fork/teams/library%3A77/avatar", size: 10 }]);
    expect(m.state.avatar.url).toBe("/api/fork/teams/library%3A77/avatar?v=1000"); // cache-busted
    expect(m.state.avatar.open).toBe(true); // the dialog stays open
    expect(m.state.avatar.busy).toBe(false);
    clock = 2000;
    await m.uploadAvatar(new Blob(["y"], { type: "image/webp" }));
    expect(m.state.avatar.url).toBe("/api/fork/teams/library%3A77/avatar?v=2000");
    served = "/api/fork/teams/library%3A77/avatar?v=111";
    await m.load("library:77"); // a reload keeps the busted URL of the same route
    expect(m.state.avatar.url).toBe("/api/fork/teams/library%3A77/avatar?v=2000");
    answer = { ok: false, status: 400, error: "The image must be a PNG, JPEG or WebP file." };
    expect(await m.uploadAvatar(new Blob(["z"]))).toBe(false);
    expect(m.state.avatar.error).toBe("The image must be a PNG, JPEG or WebP file.");
    expect(m.state.avatar.url).toBe("/api/fork/teams/library%3A77/avatar?v=2000");
    answer = { ok: false, status: 500 };
    await m.uploadAvatar(new Blob(["z"]));
    expect(m.state.avatar.error).toBe("Upload failed (500).");
    expect(await m.removeAvatar()).toBe(true);
    expect(f.calls.some((c) => c.path === "/api/fork/teams/library%3A77/avatar" && c.method === "DELETE")).toBe(true);
    expect(m.state.avatar.url).toBe("");
    expect(m.state.avatar.open).toBe(true);
  });

  it("avatar dialog controller: close is refused while a request runs; a failing DELETE and a network failure show inline; builder saves use the save ref", async () => {
    const base = libraryModel();
    const saveModel = { ...base, manage: { ...base.manage, kind: "save" as const, ref: "save:sv_a" } };
    const f = mockFetcher({ "/api/me/teams/save%3Asv_a": saveModel, "DELETE /api/fork/teams/save%3Asv_a/avatar": new ApiError(403, "You can only change the avatar of your own team.") });
    let release!: () => void;
    const paths: string[] = [];
    const m = createTeamManage({ api: f, upload: (path) => { paths.push(path); return new Promise((resolve) => { release = () => resolve({ ok: true, status: 200, avatarUrl: "/api/fork/teams/save%3Asv_a/avatar?v=9" }); }); } });
    await m.load("save:sv_a");
    m.openAvatar();
    const pending = m.uploadAvatar(new Blob(["a"]));
    expect(m.state.avatar.busy).toBe(true);
    expect(m.closeAvatar()).toBe(false);
    expect(await m.uploadAvatar(new Blob(["b"]))).toBe(false); // double submit refused
    release();
    await pending;
    expect(paths).toEqual(["/api/fork/teams/save%3Asv_a/avatar"]);
    expect(m.state.avatar.url).toMatch(/^\/api\/fork\/teams\/save%3Asv_a\/avatar\?v=\d+$/);
    expect(await m.removeAvatar()).toBe(false);
    expect(m.state.avatar.error).toBe("You can only change the avatar of your own team.");
    expect(m.state.avatar.url).not.toBe("");
    const n = createTeamManage({ api: f, upload: async () => { throw new Error("offline"); } });
    await n.load("save:sv_a");
    await n.uploadAvatar(new Blob(["a"]));
    expect(n.state.avatar.error).toBe("Can't reach the server. Check your connection.");
    expect(n.closeAvatar()).toBe(true);
  });

  it("share toggles the linked save's token", async () => {
    const f = mockFetcher({ "/api/me/teams/library%3A77": libraryModel(), "POST /api/fork/team-builder/saves/sv_a/share": { shareToken: "f".repeat(32) }, "DELETE /api/fork/team-builder/saves/sv_a/share": null });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    await m.setShared(true);
    expect(m.state.model?.manage.shareToken).toBe("f".repeat(32));
    await m.setShared(false);
    expect(m.state.model?.manage.shareToken).toBeUndefined();
  });

  it("player sheet: opens and closes, refused while the advancement dialog is open, hands over to it on the row's rules", async () => {
    const f = mockFetcher({ "/api/me/teams/library%3A77": libraryModel() });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    expect(m.openSheet(5)).toBe(false);
    expect(m.openSheet(1)).toBe(true);
    expect(m.state.sheet).toEqual({ playerIndex: 1 });
    // Grit can add neither: the sheet's buttons follow the row's enabled rule and stay put
    expect(m.advanceFromSheet("skill")).toBe(false);
    expect(m.state.sheet).toEqual({ playerIndex: 1 });
    expect(m.closeSheet()).toBe(true);
    expect(m.state.sheet).toBeNull();
    expect(m.closeSheet()).toBe(false);
    // Bob can add a skill: the sheet closes and the advancement dialog opens for him
    m.openSheet(0);
    expect(m.advanceFromSheet("characteristic")).toBe(false);
    expect(m.advanceFromSheet("skill")).toBe(true);
    expect(m.state.sheet).toBeNull();
    expect(m.state.flow).toMatchObject({ playerIndex: 0, kind: "skill", step: "choose" });
    expect(m.openSheet(0)).toBe(false);
    m.close();
    // loading another team drops the open sheet
    m.openSheet(0);
    await m.load("library:9").catch(() => undefined);
    expect(m.state.sheet).toBeNull();
  });

  it("player sheet helpers: SPP meter, career cells with — for unrecorded, value breakdown, advance rules", () => {
    expect(sppMeter(progress())).toEqual({ text: "12/6", percent: 100, rank: "Emerging Star" });
    expect(sppMeter(progress({ spp: 4, costs: { randomPrimary: 16, chosenPrimary: 22, chosenSecondary: 28, characteristic: 30 }, rank: "Experienced" }))).toEqual({ text: "4/16", percent: 25, rank: "Experienced" });
    expect(sppMeter(progress({ costs: null, rank: "Legend" }))).toEqual({ text: "12", percent: null, rank: "Legend" });
    const known = careerCells({ games: null, td: 3, cas: 2, comp: 4, int: 1, mvp: 1, fouls: 0, deflections: null, ni: 1 });
    expect(known.cells.map((c) => `${c.abbr}=${c.text}`)).toEqual(["TD=3", "CAS=2", "COM=4", "INT=1", "MVP=1", "FOUL=0", "NI=1", "GP=—"]);
    expect(known.unknown).toBe(true);
    expect(careerCells(undefined).cells.every((c) => c.text === "—")).toBe(true);
    expect(valueBreakdownText({ base: 115000, added: 30000, total: 145000 })).toBe("(115+30)k");
    expect(valueBreakdownText(null)).toBe("");
    const pl = { progress: progress({ canAddSkill: false, canAddCharacteristic: false }) } as never;
    expect(canAdvance(pl, "skill")).toBe(false);
    expect(canAdvance({ progress: progress({ canAddSkill: false, pending: { method: "randomPrimary" } as never }) } as never, "characteristic")).toBe(true);
    expect(canAdvance({} as never, "skill")).toBe(false);
  });

  it("progress lines", () => {
    expect(progressLine(progress({ earnedSpp: 20 }))).toBe("SPP 12 (earned 20) · Emerging Star · 2 advancements");
    expect(nextCostHint(progress({ spp: 2, canAddSkill: false }))).toBe("Add Skill at 6 SPP");
    expect(nextCostHint(progress({ costs: null, rank: "Legend" }))).toBe("Six advancements: fully advanced.");
  });

  it("summaryFromManaged: a save is the share page's summary; a library team layers SPP, career columns, injuries and MNG on it and drops Team costs", () => {
    const save = libraryModel([player(1, "", undefined), player(2, "Gus", undefined)]);
    const s = summaryFromManaged(save.team);
    expect(s.extraColumns).toBeUndefined();
    expect(s.rows.every((r) => r.extra === undefined)).toBe(true);
    expect(s.panels?.costs?.map((c) => c.key)).toContain("total");
    expect(s.facts[0]).toEqual({ key: "tv", label: "Team value", value: "1,000k" });
    expect(s.crest).toBeUndefined();
    // only the avatar route (cache-busted) may be the crest
    expect(summaryFromManaged(save.team, { avatarUrl: "/api/fork/teams/sv_a/avatar?v=3" }).crest).toBe("/api/fork/teams/sv_a/avatar?v=3");
    expect(summaryFromManaged(save.team, { avatarUrl: "https://example.com/x.png" }).crest).toBeUndefined();

    const lib = libraryModel();
    const l = summaryFromManaged(lib.team);
    expect(l.extraColumns?.map((c) => c.key)).toEqual(["spp"]);
    expect(l.rows[0]!.extra).toEqual({ spp: { text: "12/6", title: "SPP 12 · Emerging Star · 2 advancements" } });
    expect(l.panels).toBeUndefined();
    const career = libraryModel([{ ...player(1, "Bob", progress({ costs: null, mng: true })), careerStats: { games: 1, td: null, cas: 4, comp: 0, int: 0, mvp: 0, fouls: 0, deflections: null, ni: 0 }, injuries: ["Smashed Knee"] }] as never);
    const c = summaryFromManaged(career.team);
    expect(c.extraColumns?.map((x) => x.key)).toEqual(["cas", "mvp", "spp"]);
    expect(c.rows[0]).toMatchObject({ mng: true, sub: ["Smashed Knee", "Misses next game"], extra: { cas: { text: "4" }, mvp: { text: "0" }, spp: { text: "12" } } });
  });
});

describe("team management + My teams pages (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, manageMod] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/teams/manage.ts")]);
    mods = { app, vueRouter, renderer, manageMod };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  // The SPA's own copy of the controller module (same Vue instance and injection key as the rendered app).
  const createTeamManageSsr = (f: Fetcher) => mods.manageMod.createTeamManage({ api: f });

  async function render(path: string, routes: Routes): Promise<string> {
    const spa = mods.app.createSpa({
      history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true,
      fetcher: mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, ...routes }),
    });
    await spa.router.push(path);
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    if (process.env.DUMP_SSR) console.log(html.slice(html.indexOf("<main"), html.indexOf("<main") + Number(process.env.DUMP_SSR_LEN ?? 3000)));
    return html;
  }

  async function renderWith(manage: any, f: Fetcher): Promise<string> {
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.manageMod.TEAM_MANAGE_KEY, manage);
    await spa.router.push("/teams/library%3A77");
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  // The roster is the shared table-style summary (owner 11-12: "This view on the 'My Teams' page should also just be the
  // new table view"), not the legacy team-view.js sheet.
  const SUMMARY_AT = 'class="tm-summary sf-shrink sf-scroll sf-col"';

  it("renders the table-style summary with the SPP column, both buttons (greyed when unaffordable), the Level up! chip, and the header actions", async () => {
    const html = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": libraryModel() });
    expect(html).toContain(SUMMARY_AT);
    expect(html).toContain('<h2 id="tm-summary-h">Da Boyz</h2>');
    expect(html).toContain("data-team-summary");
    expect(html).toContain('<span class="hm-cap ts-caption">Orc · Alice');
    // the legacy sheet is gone from this page
    expect(html).not.toContain("team-view");
    expect(html).not.toContain("tm-sheet");
    expect(html).not.toContain("tv-banner");
    expect(html).not.toContain("data-sheet-row");
    expect(html).not.toContain('data-sheet="0"');
    expect(html).not.toContain("On the fork");
    // the name opens the player sheet; HTML in a name is escaped
    expect(html.match(/<button type="button" class="lg-team-name ts-open" data-open="0" aria-label="Open the player sheet for Big &lt;Bob&gt;, #1 Blitzer" aria-haspopup="dialog">Big &lt;Bob&gt;<\/button>/g)).toHaveLength(1);
    expect(html).not.toContain("Big <Bob>");
    expect(html).toContain('<th scope="col" class="ts-row-act-h"><span class="tn-sr">Advancement</span></th>');
    // one row each; only player 1 can add a skill (owner 10-30: grey out the rest)
    expect(html.match(/<button type="button" class="tm-act" data-adv="0" data-kind="skill" aria-label="Add a skill to Big &lt;Bob&gt;" aria-haspopup="dialog">Add Skill<\/button>/g)).toHaveLength(1);
    expect(html.match(/data-adv="0" data-kind="characteristic" disabled aria-disabled="true" aria-label="Add a stat to Big &lt;Bob&gt;"/g)).toHaveLength(1);
    expect(html.match(/data-adv="1" data-kind="skill" disabled aria-disabled="true" aria-label="Add a skill to Grit"/g)).toHaveLength(1);
    expect(html.match(/data-adv="1" data-kind="characteristic" disabled aria-disabled="true" aria-label="Add a stat to Grit"/g)).toHaveLength(1);
    expect(html).toContain(">Add Stat<");
    expect(html).not.toContain(">Add Characteristic<");
    expect(html.match(/<span class="tm-toast" role="status">Level up!<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain("Finish level up");
    // SPP column: current against the next advancement's cost, the progress line as its title
    expect(html).toContain('<th scope="col" class="lg-num" title="SPP against the cost of the next advancement" data-col="spp">SPP</th>');
    expect(html).toContain('<td class="lg-num" data-col="spp"><span class="ts-extra" title="SPP 12 · Emerging Star · 2 advancements">12/6</span></td>');
    expect(html).toContain('<td class="lg-num" data-col="spp"><span class="ts-extra" title="SPP 0 · Emerging Star · 2 advancements">0/6</span></td>');
    // no career columns when nothing is recorded
    expect(html).not.toContain('data-col="td"');
    expect(html).toMatch(/<a href="\/app\/my-teams" class="[^"]*tm-back[^"]*">Back to My teams<\/a>/);
    expect(html).toMatch(/<a href="\/app\/tournament-team-builder\/sv_a" class="[^"]*lobby-btn[^"]*">Open in Roster Builder<\/a>/);
    expect(html).toMatch(/<button type="button" class="lobby-btn primary">Share<\/button>/);
    expect(html).toMatch(/<button type="button" class="lobby-btn" aria-haspopup="dialog">Team avatar<\/button>/);
    expect(html).not.toContain('aria-labelledby="tm-av-h"');
    // the team value shows once (the summary's strip); the facts line keeps the treasury
    expect(html).toContain('<div data-tv="tv"><dt>Team value</dt><dd>1,000k ');
    expect(html.match(/1,000k/g)).toHaveLength(1);
    expect(html).toContain('<p class="tm-facts"><span>Treasury <b>50k</b></span></p>');
  });

  it("a roll waiting on the team: both buttons resume it with Finish level up; career TD / CAS / MVP, injuries and Miss Next Game on the row; the avatar is the crest", async () => {
    const pending = { token: "t2", playerId: "p1", revision: REV2, method: "characteristic", cost: 20, roll: 6, choices: ["AG"], primaryFallbacks: ["Block"], secondaryFallbacks: [], expiresAt: "x" };
    const bob = { ...player(1, "Big <Bob>", progress({ pending: pending as never, canAddSkill: false, mng: true })),
      careerStats: { games: 4, td: 3, cas: 2, comp: 0, int: 1, mvp: 1, fouls: 0, deflections: null, ni: 1 }, injuries: ["Serious Injury (NI)"] };
    const star = { ...player(3, "", undefined), position: "Griff Oberwald", isStar: true };
    const base = libraryModel([bob, player(2, "Grit", progress({ id: "p2", canAddSkill: false })), star] as never);
    const model = { ...base, team: { ...base.team, avatarUrl: "/api/fork/teams/library%3A77/avatar?v=5" } };
    const html = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": model });
    const plain = html.replace(/<!--[^>]*-->/g, "");
    expect(html.match(/<button type="button" class="tm-act" data-adv="0" data-kind="resume" aria-label="Add a skill to Big &lt;Bob&gt;" aria-haspopup="dialog">Add Skill<\/button>/g)).toHaveLength(1);
    expect(html.match(/<button type="button" class="tm-act" data-adv="0" data-kind="resume" aria-label="Add a stat to Big &lt;Bob&gt;" aria-haspopup="dialog">Add Stat<\/button>/g)).toHaveLength(1);
    expect(html.match(/<span class="tm-toast" role="status">Finish level up<\/span>/g)).toHaveLength(1);
    expect(html).not.toContain("Level up!");
    // career columns (games is not one of them), the SPP column last
    expect(html).toMatch(/title="Career touchdowns" data-col="td">TD<\/th><th[^>]*title="Career casualties caused" data-col="cas">CAS<\/th><th[^>]*title="Career MVP awards" data-col="mvp">MVP<\/th><th[^>]*data-col="spp">SPP<\/th>/);
    expect(plain).toContain('<td class="lg-num" data-col="td">3</td><td class="lg-num" data-col="cas">2</td><td class="lg-num" data-col="mvp">1</td>');
    // Grit has no career record: dashes
    expect(plain).toContain('<td class="lg-num" data-col="td">-</td><td class="lg-num" data-col="cas">-</td><td class="lg-num" data-col="mvp">-</td>');
    expect(plain).toContain("<small>Blitzer · Serious Injury (NI) · Misses next game</small>");
    expect(html).toMatch(/<tr id="player-0" data-player="0" class="ts-mng">/);
    // a player without progression in a library team: no buttons, the SPP cell is a dash
    expect(html).toMatch(/data-open="2" aria-label="Open the player sheet for #3 Griff Oberwald"/);
    expect(html).not.toContain('data-adv="2"');
    expect(plain).toMatch(/<tr id="player-2"[\s\S]*?<td class="lg-num" data-col="spp">-<\/td>/);
    expect(html).toContain('<img class="crest-image" src="/api/fork/teams/library%3A77/avatar?v=5"');
  });

  it("keyboard: the sheet opener and both advancement buttons are native buttons in the tab order with accessible names, wired to the controller", async () => {
    const html = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": libraryModel() });
    const buttons = [...html.matchAll(/<button [^>]*class="(?:lg-team-name ts-open|tm-act)"[^>]*>/g)].map((x) => x[0]);
    expect(buttons).toHaveLength(6); // 2 sheet openers + 2 x (Add Skill, Add Stat)
    for (const b of buttons) {
      expect(b).toContain('type="button"');
      expect(b).toMatch(/aria-label="[^"]+"/);
      expect(b).not.toContain("tabindex");
    }
    // the enabled ones are focusable (no disabled attribute): both openers and Big <Bob>'s Add Skill
    expect(buttons.filter((b) => !/ disabled/.test(b))).toHaveLength(3);
    const view = readFileSync(fileURLToPath(new URL("../spa/src/views/TeamManageView.vue", import.meta.url)), "utf8");
    expect(view).toContain('@open="openSheet"');
    expect(view).toContain("manage.openSheet(i)");
    expect(view).toMatch(/@click="advance\(actsFor\(row\)!\.i, 'skill', actsFor\(row\)!\.pending\)"/);
    expect(view).toMatch(/@click="advance\(actsFor\(row\)!\.i, 'characteristic', actsFor\(row\)!\.pending\)"/);
    expect(view).toContain("manage.open(i, kind)");
    expect(view).not.toContain("team-view.js");
    expect(view).not.toContain("v-html");
    const table = readFileSync(fileURLToPath(new URL("../spa/src/components/TeamRosterTable.vue", import.meta.url)), "utf8");
    expect(table).toContain(`@click="emit('open', r.id, $event.currentTarget as HTMLElement)"`);
  });

  it("the Team avatar dialog: aria-modal, page inert, preview + file input + Upload (no Remove without an avatar) + Close; the summary crest shows the avatar", async () => {
    const session = { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } };
    const f = mockFetcher({ ...session, "/api/me/teams/library%3A77": libraryModel() });
    const manage = createTeamManageSsr(f);
    await manage.load("library:77");
    manage.openAvatar();
    const html = await renderWith(manage, f);
    expect(html).toMatch(/<div class="tm-content sf-fit sf-fill" inert aria-hidden="true">/);
    expect(html).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="tm-av-h"/);
    expect(html).toContain("Team avatar");
    expect(html).toMatch(/type="file" accept="image\/png,image\/jpeg,image\/webp"/);
    expect(html).toContain("up to 512 KB");
    expect(html).toContain("Race crest (no avatar yet)");
    expect(html).toMatch(/<button type="button" class="sf-btn primary" disabled[^>]*>Upload<\/button>/);
    expect(html).not.toContain(">Remove<");
    expect(html).toMatch(/>Close<\/button>/);
    const summaryAt = html.lastIndexOf(SUMMARY_AT);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('role="dialog"')).toBeGreaterThan(summaryAt);

    const base = libraryModel();
    const withAvatar = { ...base, team: { ...base.team, avatarUrl: "/api/fork/teams/library%3A77/avatar?v=5" } };
    const g = mockFetcher({ ...session, "/api/me/teams/library%3A77": withAvatar });
    const m2 = createTeamManageSsr(g);
    await m2.load("library:77");
    m2.openAvatar();
    const html2 = await renderWith(m2, g);
    expect(html2.slice(html2.indexOf(SUMMARY_AT), html2.indexOf('role="dialog"'))).toContain('class="crest-image" src="/api/fork/teams/library%3A77/avatar?v=5"');
    expect(html2).toContain("Current avatar");
    expect(html2).toMatch(/>Remove<\/button>/);
  });

  it("a Roster Builder save: the server's note (no fork wording), sheet openers, no advancement controls or SPP column; 404 shows the friendly message", async () => {
    const save = libraryModel([player(1, "", undefined), player(2, "Gus", undefined)]);
    save.manage = { kind: "save", ref: "sv_a", saveId: "sv_a", shareToken: "e".repeat(32), advancement: { available: false, reason: "This is a Roster Builder sheet. Skills and characteristics are added once the team is created and plays its games." } };
    const html = await render("/teams/sv_a", { "/api/me/teams/sv_a": save });
    expect(html).toContain('<p class="tm-note">This is a Roster Builder sheet. Skills and characteristics are added once the team is created and plays its games.</p>');
    expect(html).toContain(SUMMARY_AT);
    expect(html).toContain('data-open="0" aria-label="Open the player sheet for #1 Blitzer" aria-haspopup="dialog">Blitzer</button>');
    expect(html).toContain('data-open="1" aria-label="Open the player sheet for Gus, #2 Blitzer" aria-haspopup="dialog">Gus</button>');
    expect(html).not.toContain("ts-row-act");
    expect(html).not.toContain("tm-act");
    expect(html).not.toContain("tm-toast");
    expect(html).not.toContain("Advancement");
    expect(html).not.toContain('data-col="spp"');
    expect(html).not.toContain("tm-facts");
    expect(html).not.toContain("tv-actions");
    // the save reads like the share page: Team costs panel included
    expect(html).toContain("data-summary-costs");
    expect(html).toContain(">Unshare</button>");
    expect(html).toContain(`/t/${"e".repeat(32)}`);
    const gone = await render("/teams/library%3A9", { "/api/me/teams/library%3A9": new ApiError(404, "Team not found.") });
    expect(gone).toContain("This team isn&#39;t one of yours, or it no longer exists.");
  });

  it("with the advancement dialog open the page behind is inert and the dialog is a focusable aria-modal", async () => {
    const f = mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, "/api/me/teams/library%3A77": libraryModel() });
    const manage = createTeamManageSsr(f);
    await manage.load("library:77");
    manage.open(0, "skill");
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.manageMod.TEAM_MANAGE_KEY, manage);
    await spa.router.push("/teams/library%3A77");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toMatch(/<div class="tm-content sf-fit sf-fill" inert aria-hidden="true">/);
    expect(html).toMatch(/<div class="ls-dialog tm-modal" role="dialog" aria-modal="true" aria-labelledby="tm-adv-h" tabindex="-1" data-step="choose">/);
    // the dialog sits outside the inert content
    const summaryAt = html.lastIndexOf(SUMMARY_AT);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('role="dialog"')).toBeGreaterThan(summaryAt);
    const closed = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": libraryModel() });
    expect(closed).toContain('<div class="tm-content sf-fit sf-fill">');
    expect(closed).not.toContain('role="dialog"');
  });

  it("each row's name is a player sheet button; the open sheet shows characteristics, skills, SPP bar + rank, career stats, injuries and value", async () => {
    const closed = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": libraryModel() });
    expect(closed.match(/<button type="button" class="lg-team-name ts-open" data-open="0" aria-label="Open the player sheet for Big &lt;Bob&gt;, #1 Blitzer" aria-haspopup="dialog">/g)).toHaveLength(1);
    expect(closed.match(/<button type="button" class="lg-team-name ts-open" data-open="1" aria-label="Open the player sheet for Grit, #2 Blitzer" aria-haspopup="dialog">/g)).toHaveLength(1);

    const bob = { ...player(1, "Big <Bob>", progress({ spp: 4, costs: { randomPrimary: 16, chosenPrimary: 22, chosenSecondary: 28, characteristic: 30 }, rank: "Experienced", canAddSkill: false })),
      statIncreases: ["ST"], stats: { MA: 6, ST: 4, AG: "3+", PA: "4+", AV: "10+" }, added: [{ name: "Tackle", category: "General", access: "primary" as const }],
      careerStats: { games: null, td: 3, cas: 2, comp: 0, int: 1, mvp: 1, fouls: 4, deflections: null, ni: 1 },
      injuries: ["Serious Injury (NI)"], valueBreakdown: { base: 80000, added: 80000, total: 160000 }, cost: 160000 };
    const f = mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, "/api/me/teams/library%3A77": libraryModel([bob, player(2, "Grit")] as never) });
    const manage = createTeamManageSsr(f);
    await manage.load("library:77");
    expect(manage.openSheet(0)).toBe(true);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    spa.app.provide(mods.manageMod.TEAM_MANAGE_KEY, manage);
    await spa.router.push("/teams/library%3A77");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toMatch(/<div class="tm-content sf-fit sf-fill" inert aria-hidden="true">/);
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="tm-ps-h" tabindex="-1"');
    const summaryAt = html.lastIndexOf(SUMMARY_AT);
    expect(summaryAt).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('aria-labelledby="tm-ps-h"')).toBeGreaterThan(summaryAt);
    expect(html).toContain('<p class="tm-ps-name">Big &lt;Bob&gt;</p>');
    expect(html).toMatch(/<span class="tm-ps-num">#1<\/span> Orc Blitzer/);
    // SPP current / next cost, the bar and the rank under it
    expect(html).toContain('<b class="tm-spp">4/16</b>');
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="25"><span style="width:25%;"><\/span>/);
    expect(html).toContain('<span class="tm-ps-rank">Experienced</span>');
    // the increased characteristic is marked
    expect(html).toMatch(/<div class="tv-up"><dt>ST<\/dt><dd>4<span class="tv-up-mark" aria-label="increased">▲<\/span><\/dd><\/div>/);
    expect(html).toContain('title="Primary skill added: Tackle">Tackle</span>');
    // career stats; games not recorded -> — and the footnote
    expect(html).toMatch(/<abbr title="Touchdowns">TD<\/abbr>/);
    expect(html).toContain("<td>3</td><td>2</td><td>0</td><td>1</td><td>1</td><td>4</td><td>1</td><td>—</td>");
    expect(html).toContain("Stats are recorded for games played through the site.");
    expect(html).toContain("<li>Serious Injury (NI)</li>");
    expect(html).toContain('Value <b>160k</b><span class="tm-ps-break" title="Position cost + added value">(80+80)k</span>');
    // Add Skill greyed (not affordable), Add Stat greyed, Close
    expect(html).toMatch(/<button type="button" class="tm-act" data-kind="skill" disabled aria-disabled="true">Add Skill<\/button>/);
    expect(html).toMatch(/<button type="button" class="sf-btn" data-autofocus>Close<\/button>/);
  });

  it("My teams: coach-page panels, tiles linking to the management page, Avatars and Build a team panels", async () => {
    const html = await render("/my-teams", { "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [{ ref: "library:77", name: "Alice Lib", race: "Human" }, { ref: "sv_a", name: "Alice Save", race: "Orc" }] } });
    expect(html).toContain(`<h1 class="sf-page-title" aria-live="polite">My teams</h1>`);
    expect(html).toContain('class="hm-grid sf-fill sf-cols"'); // fit to 1920x1080 (owner 11-02)
    expect(html).toContain('<span class="hm-cap">2 teams</span>');
    expect(html).toContain('class="hm-teams hm-teams-lg"');
    // owner 11-13: a Cards / Table switch (cards first) and a filter box over both views
    expect(html).toMatch(/<button type="button" class="sf-tab" aria-pressed="true" data-teams-view="cards">Cards<\/button><button type="button" class="sf-tab" aria-pressed="false" data-teams-view="table">Table<\/button>/);
    expect(html).toContain('data-teams-filter');
    expect(html).not.toContain("data-teams-table");
    const view = readFileSync(fileURLToPath(new URL("../spa/src/views/MyTeamsView.vue", import.meta.url)), "utf8");
    expect(view).toContain(`<div v-else-if="shown.length && view === 'table'" class="mt-table-wrap" data-teams-table>`);
    expect(view).toContain('<tr v-for="t in shown" :key="t.ref">');
    expect(view).toContain('<li v-for="t in shown" :key="t.ref">');
    expect(view).toMatch(/<th scope="col">Team<\/th><th scope="col">Race<\/th><th scope="col" class="mt-num">Team value<\/th><th scope="col">Registered in<\/th>/);
    expect(view).toContain("words.every((w) => hay.includes(w))");
    expect(html).toContain('<a href="/app/teams/library%3A77" class="hm-team" title="Manage Alice Lib">');
    expect(html).toContain('<a href="/app/teams/sv_a" class="hm-team" title="Manage Alice Save">');
    // owner 10-30: avatar upload moved to the team page; no Avatars panel or per-team upload forms here
    expect(html).not.toContain("mt-avatars-h");
    expect(html).not.toContain(">Upload<");
    expect(html).not.toContain('type="file"');
    expect(html).toContain('<a href="/team-builder.html">Team Builder</a> · <a href="/app/tournament-team-builder"');
    const empty = await render("/my-teams", { "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [] } });
    expect(empty).toContain('<p class="hm-empty">No teams yet. <a href="/team-builder.html">Build one</a>.</p>');
  });
});

// The team management page's opt-in hooks on TeamSummary / TeamRosterTable (name button, row actions slot, extra columns)
// must leave the other pages' markup byte for byte as it was: the league team page (view, coach and organiser modes), the
// Roster Builder's Summary step and the public share page, rendered with their HTML comments kept, against goldens taken
// from those components before the hooks existed (UPDATE_TEAM_SUMMARY_GOLDEN=1 rewrites them).
describe("the shared summary's other pages are unchanged by the management page's hooks", () => {
  const GOLDEN = new URL("./fixtures/team-summary-pages.golden.json", import.meta.url);
  let vite: ViteDevServer;
  let m: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, summaryMod, Summary, Share] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("/src/teams/summary.ts"),
      vite.ssrLoadModule("/src/components/TeamSummary.vue"), vite.ssrLoadModule("/src/views/TeamShareView.vue"),
    ]);
    m = { renderer, vueRouter, summaryMod, Summary: Summary.default, Share: Share.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>): Promise<string> {
    const blank = { render: () => null };
    const router = m.vueRouter.createRouter({ history: m.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/tournament-team-builder/:saveId?", name: "tournament-team-builder", component: blank }, { path: "/:p(.*)*", component: blank }] });
    await router.push("/x");
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    return (await m.renderer.renderToString(app)) as string;
  }

  const stats = (over: Record<string, number> = {}) => ({ td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0, ...over });
  const leagueTeam = () => ({
    id: "rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Dee", coachId: "Dee", teamValue: 885_000, currentTeamValue: 815_000, treasury: 130_000, rerolls: 1, fans: 3,
    assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "",
    players: [
      { playerId: "p1", number: 1, name: "Zegerd", position: "Dwarf Runner", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: ["Block", "Sprint"], value: 110_000, level: "Experienced",
        availableSpp: 0, niggling: 1, missNextGame: true, stats: stats({ td: 3, spp: 6, blocks: 4 }), seasonsPlayed: 2, injuries: [{ type: "smashed-knee", at: "2026-11-01T00:00:00.000Z" }] },
      { playerId: "p2", number: 4, name: "Dethirord", position: "Troll Slayer", ma: 5, st: 3, ag: 4, pa: 5, av: 9, skills: ["Block"], value: 95_000, level: "Rookie",
        availableSpp: 6, niggling: 0, missNextGame: false, stats: stats({ cas: 2, spp: 6 }) },
    ],
    formerPlayers: [{ playerId: "f1", name: "Getro", position: "Troll Slayer", level: "Rookie", stats: stats({ td: 2, mvp: 1, spp: 8 }) }],
  });
  const stat = (v: string | number) => ({ value: v, improved: false });
  const builderModel = {
    raceName: "Human", coach: "Alice", teamName: "Reavers", rulesetName: "", sideline: [], inducements: [], specialRules: ["Old World Classic"], summary: [], keywords: [],
    rows: [
      { number: 1, name: "Liesel", position: "Lineman", positionFull: "Human Lineman", stats: { MA: stat(6), ST: stat(3), AG: stat("3+"), PA: stat("4+"), AV: stat("9+") }, printed: [], added: [{ name: "Dodge", access: "secondary" }],
        captain: true, free: ["Team Captain", "Pro"], statIncreases: [], cost: 50_000, keywords: null, isStar: false },
      { number: 2, name: "", position: "Custom", positionFull: "Custom", stats: { MA: stat(7), ST: stat(4), AG: stat("2+"), PA: stat("-"), AV: stat("10+") }, printed: ["Block"], added: [],
        captain: false, free: [], statIncreases: [], cost: 200_000, keywords: null, isStar: true, specialRules: [{ kind: "rule", name: "Fan Favourite", description: "Fans love them." }] },
    ],
  };
  const shared = () => ({
    teamName: "Altdorf Avengers", coach: "Alice", raceName: "Human", crest: "crests/human.png", ruleset: { name: "BB2025 Matched Play", tierLabel: "Tier 2" }, updatedAt: "2026-11-12T00:29:26.070Z",
    players: [
      { name: "Grumbak", number: 1, position: "Ogre", positionFull: "Ogre", isStar: false, captain: false, stats: { MA: 5, ST: 5, AG: "4+", PA: "5+", AV: "10+" },
        printed: [{ name: "Mighty Blow" }], free: [], added: [], statIncreases: [], cost: 140_000, sprite: "sprites/human/ogre.png" },
      { name: "Gus", number: 2, position: "Blitzer", positionFull: "Human Blitzer", isStar: false, captain: true, stats: { MA: 8, ST: 3, AG: "3+", PA: "4+", AV: "9+" },
        printed: [{ name: "Block" }], free: [{ name: "Team Captain" }], added: [{ name: "Tackle", access: "secondary" }], statIncreases: ["MA"], cost: 85_000, sprite: null },
      { number: 3, position: "Griff Oberwald", positionFull: "Griff Oberwald", isStar: true, captain: false, stats: { MA: 7, ST: 4, AG: "2+", PA: "3+", AV: "9+" },
        printed: [{ name: "Fend" }], free: [], added: [], statIncreases: [], cost: 280_000, sprite: null },
    ],
    sideline: { reRolls: 2, apothecary: true, assistantCoaches: 1, cheerleaders: 0, dedicatedFans: 1 },
    inducements: [{ name: "Blitzer's Best Kegs", count: 1, icon: "icons/inducements/bloodweiser_kegs.png" }],
    specialRules: ["Old World Classic"],
    summary: { players: 3, playersCost: 505_000, starsCost: 280_000, skillsCost: 40_000, inducementsCost: 50_000, sidelineCost: 180_000, total: 1_055_000, cap: 1_150_000, primarySkills: 0, secondarySkills: 1 },
    ownerSaveId: "sv_a",
  });
  const ORGANISER_CAN = { rename: true, renumber: true, fire: true, plus: true, stats: true, numbers: true, mng: true, removeSkill: "all" };

  it("league team page (view, coach, organiser), Roster Builder Summary step and share page render exactly as before", async () => {
    const s = m.summaryMod;
    const sprite = (pos: string) => `sprites/dwarf/${pos.toLowerCase().replace(/\W+/g, "_")}.png`;
    const got: Record<string, string> = {
      leagueView: await render(m.Summary, { team: s.summaryFromLeague(leagueTeam(), { sprite, crest: "crests/dwarf.png" }) }),
      leagueCoach: await render(m.Summary, { team: s.summaryFromLeague(leagueTeam()), mode: "coach", can: { rename: true, renumber: true, plus: true } }),
      leagueOrganiser: await render(m.Summary, { team: s.summaryFromLeague(leagueTeam(), { editable: true }), mode: "organiser", can: ORGANISER_CAN }),
      builderSummary: await render(m.Summary, {
        team: s.summaryFromBuilder(builderModel, { coach: "Alice", teamValue: 250_000, treasury: 900_000, staff: { reRolls: 2, assistantCoaches: 1, cheerleaders: 0, dedicatedFans: 1, apothecary: 1 }, tier: "Tier 1",
          inducements: { items: [{ name: "Bribe", count: 1, icon: "" }], total: 100_000 } }),
        mode: "builder", can: { rename: true, renumber: true, fire: true, removeSkill: "added" }, headingId: "tb-sum-h",
      }),
      sharedSummary: await render(m.Summary, { team: s.summaryFromShared(shared()), mode: "view", headingId: "ts-share-h" }),
      sharePage: await render(m.Share, { token: "a".repeat(32), initial: shared() }),
    };
    if (process.env.UPDATE_TEAM_SUMMARY_GOLDEN) writeFileSync(GOLDEN, `${JSON.stringify(got, null, 1)}\n`);
    const want = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, string>;
    for (const key of Object.keys(want)) expect(got[key], key).toBe(want[key]);
    expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
    // none of the management page's hooks shows up on those pages
    for (const html of Object.values(got)) {
      expect(html).not.toContain("ts-open");
      expect(html).not.toContain("ts-row-act");
      expect(html).not.toContain("data-open=");
    }
  });
});
