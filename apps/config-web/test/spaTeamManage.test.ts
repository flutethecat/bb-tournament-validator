import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTeamManage, nextCostHint, progressLine, teamManagePath, type PlayerProgress, type TeamManageModel } from "../spa/src/teams/manage";

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

  it("share toggles the linked save's token", async () => {
    const f = mockFetcher({ "/api/me/teams/library%3A77": libraryModel(), "POST /api/fork/team-builder/saves/sv_a/share": { shareToken: "f".repeat(32) }, "DELETE /api/fork/team-builder/saves/sv_a/share": null });
    const m = createTeamManage({ api: f });
    await m.load("library:77");
    await m.setShared(true);
    expect(m.state.model?.manage.shareToken).toBe("f".repeat(32));
    await m.setShared(false);
    expect(m.state.model?.manage.shareToken).toBeUndefined();
  });

  it("progress lines", () => {
    expect(progressLine(progress({ earnedSpp: 20 }))).toBe("SPP 12 (earned 20) · Emerging Star · 2 advancements");
    expect(nextCostHint(progress({ spp: 2, canAddSkill: false }))).toBe("Add Skill at 6 SPP");
    expect(nextCostHint(progress({ costs: null, rank: "Legend" }))).toBe("Six advancements: fully advanced.");
  });
});

describe("team management + My teams pages (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { app, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes): Promise<string> {
    const spa = mods.app.createSpa({
      history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true,
      fetcher: mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, ...routes }),
    });
    await spa.router.push(path);
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    if (process.env.DUMP_SSR) console.log(html.slice(html.indexOf("<main"), html.indexOf("<main") + 3000));
    return html;
  }

  it("renders the share view's sheet with Add Skill only where affordable, and the header actions", async () => {
    const html = await render("/teams/library%3A77", { "/api/me/teams/library%3A77": libraryModel() });
    expect(html).toContain("<h1>Da Boyz</h1>");
    expect(html).toContain('class="tv-banner"');
    expect(html).toContain("</span>On the fork</span>");
    expect(html).toContain("Coach <strong>Alice</strong>");
    expect(html).toContain('<span class="tv-pname">Big &lt;Bob&gt;</span>');
    expect(html).toContain('<th scope="col" class="tv-actions">Advancement</th>');
    // table + phone card each carry the button, for player 1 only
    expect(html.match(/data-adv="0" data-kind="skill"/g)).toHaveLength(2);
    expect(html).not.toContain('data-adv="1" data-kind="skill"');
    expect(html).not.toContain(">Add Characteristic<");
    expect(html).toContain("SPP 0 · Emerging Star · 2 advancements<br>Add Skill at 6 SPP");
    expect(html).toMatch(/<a href="\/app\/my-teams" class="[^"]*tm-back[^"]*">Back to My teams<\/a>/);
    expect(html).toContain('href="/tournament-team-builder.html?save=sv_a">Open in Tournament Builder</a>');
    expect(html).toMatch(/<button type="button" class="lobby-btn primary">Share<\/button>/);
    expect(html).toContain("Team value <b>1,000k</b>");
  });

  it("a builder save is read-only with the server's note; 404 shows the friendly message", async () => {
    const save = libraryModel([player(1, "", undefined)]);
    save.manage = { kind: "save", ref: "sv_a", saveId: "sv_a", shareToken: "e".repeat(32), advancement: { available: false, reason: "This is a Tournament Builder sheet. Skills and characteristics are added once the team is built and plays on the fork." } };
    const html = await render("/teams/sv_a", { "/api/me/teams/sv_a": save });
    expect(html).toContain("added once the team is built and plays on the fork.");
    expect(html).not.toContain("tv-actions");
    expect(html).toContain(">Unshare</button>");
    expect(html).toContain(`/t/${"e".repeat(32)}`);
    const gone = await render("/teams/library%3A9", { "/api/me/teams/library%3A9": new ApiError(404, "Team not found.") });
    expect(gone).toContain("This team isn&#39;t one of yours, or it no longer exists.");
  });

  it("My teams: coach-page panels, tiles linking to the management page, Avatars and Build a team panels", async () => {
    const html = await render("/my-teams", { "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [{ ref: "library:77", name: "Alice Lib", race: "Human" }, { ref: "sv_a", name: "Alice Save", race: "Orc" }] } });
    expect(html).toContain('<h1 class="hm-title">My teams <span class="hm-led">Alice</span></h1>');
    expect(html).toContain('class="hm-grid"');
    expect(html).toContain('<span class="hm-cap">2 teams</span>');
    expect(html).toContain('class="hm-teams hm-teams-lg"');
    expect(html).toContain('<a href="/app/teams/library%3A77" class="hm-team" title="Manage Alice Lib">');
    expect(html).toContain('<a href="/app/teams/sv_a" class="hm-team" title="Manage Alice Save">');
    expect(html).toMatch(/<h2 id="mt-avatars-h">Avatars<\/h2>/);
    expect(html.match(/>Upload</g)).toHaveLength(2);
    expect(html).toContain('<a href="/team-builder.html">Team Builder</a> · <a href="/tournament-team-builder.html">Tournament Builder</a>');
    const empty = await render("/my-teams", { "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [] } });
    expect(empty).toContain('<p class="hm-empty">No teams yet. <a href="/team-builder.html">Build one</a>.</p>');
  });
});
