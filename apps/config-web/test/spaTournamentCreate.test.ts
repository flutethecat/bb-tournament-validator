import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentSummary } from "../spa/src/shared/api";
import { createSessionStore, type Fetcher } from "../spa/src/session";
import {
  canCreateTournament, createBody, createdLocation, createTournamentCreator, CREATED_NOTICE, formProblem,
} from "../spa/src/tournaments/create";

// Create Tournament (owner 10-30): the CREATE button on the Tournaments toolbar, the account menu item, and the dialog
// (POST /api/tournaments, then the new draft's Manage tab). Controller tests with a mocked Fetcher; views server-rendered
// through the SPA's own Vite config, as in spaTournaments.test.ts.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
const AS = (coach: string, extra: Record<string, unknown> = {}) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", ...extra } });
const PACKAGES = { "/api/packages": [{ name: "nut-cup" }, { name: "small-gods" }] };
const listPage = (items: TournamentSummary[] = []) => ({ tournaments: items, page: 1, pageSize: 20, total: items.length, hasMore: false });
type Creator = ReturnType<typeof createTournamentCreator>;

describe("create controller", () => {
  it("who may create: a Discord organiser; never signed out, a plain coach, an admin flag alone, a password session or a test sign-in", async () => {
    const as = async (info: unknown) => { const s = createSessionStore(mockFetcher({ "/api/auth/session": info })); await s.load(); return canCreateTournament(s); };
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "discord", organizer: true })).toBe(true);
    expect(await as({ authenticated: false })).toBe(false);
    expect(await as({ authenticated: true, coach: "Bob", authMethod: "discord", organizer: false })).toBe(false);
    // The server gates on the organizer flag only: an admin flag alone does not create.
    expect(await as({ authenticated: true, coach: "Ada", authMethod: "discord", admin: true })).toBe(false);
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "password", organizer: true })).toBe(false);
    expect(await as({ authenticated: true, coach: "Veers", authMethod: "discord", organizer: true, test: true })).toBe(false);
  });

  it("the body: name trimmed, Swiss rounds only when set, other formats never send rounds", () => {
    const base = { name: "  Spike Open ", packageName: "nut-cup", maxPlayers: 16 as number | "", format: "swiss" as const, roundCount: "" as number | "", primaryTiebreaker: "buchholz" as const };
    expect(createBody(base)).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "swiss", primaryTiebreaker: "buchholz" });
    expect(createBody({ ...base, roundCount: 5 })).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "swiss", primaryTiebreaker: "buchholz", roundCount: 5 });
    expect(createBody({ ...base, format: "knockout", roundCount: 5, primaryTiebreaker: "sonnebornBerger" } as never)).toEqual({ name: "Spike Open", packageName: "nut-cup", maxPlayers: 16, format: "knockout", primaryTiebreaker: "sonnebornBerger" });
    expect(formProblem({ ...base, name: " " })).toBe("Enter a name.");
    expect(formProblem({ ...base, packageName: "" })).toBe("Choose a ruleset.");
    expect(formProblem({ ...base, maxPlayers: 1 })).toContain("at least 2");
    expect(formProblem({ ...base, roundCount: 51 })).toContain("1 to 50");
    expect(formProblem(base)).toBe("");
  });

  it("submit POSTs the dialog's body, closes, and leaves a one-time notice for the new tournament", async () => {
    const f = mockFetcher({ ...PACKAGES, "POST /api/tournaments": { tournament: { id: "t9", name: "Spike Open" } } });
    let created = 0;
    const c = createTournamentCreator({ api: f, onCreated: () => { created++; } });
    c.show();
    await c.loadPackages();
    expect(c.state.open).toBe(true);
    expect(c.state.packages).toEqual(["nut-cup", "small-gods"]);
    expect(c.state.form.packageName).toBe("nut-cup");
    Object.assign(c.state.form, { name: "Spike Open", packageName: "small-gods", maxPlayers: 12, format: "swiss", roundCount: 4, primaryTiebreaker: "sonnebornBerger" });
    expect(await c.submit()).toBe("t9");
    expect(f.calls.find((x) => x.method === "POST")).toEqual({
      path: "/api/tournaments", method: "POST",
      body: { name: "Spike Open", packageName: "small-gods", maxPlayers: 12, format: "swiss", primaryTiebreaker: "sonnebornBerger", roundCount: 4 },
    });
    expect(c.state.open).toBe(false);
    expect(created).toBe(1);
    expect(createdLocation("t9")).toEqual({ name: "tournament-detail", params: { id: "t9" }, query: { tab: "manage" } });
    expect(c.takeNotice("other")).toBe("");
    expect(c.takeNotice("t9")).toBe(CREATED_NOTICE);
    expect(c.takeNotice("t9")).toBe("");
  });

  it("the ruleset list is refetched on every open; the last list stays while loading and after a failed reread", async () => {
    let names = ["nut-cup"];
    let release: () => void = () => undefined;
    let gate: Promise<void> = Promise.resolve();
    let fail = false;
    const f = mockFetcher({ "/api/packages": async () => { await gate; if (fail) throw new ApiError(500, "x"); return names.map((name) => ({ name })); } });
    const c = createTournamentCreator({ api: f });
    c.show();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup"]);
    c.close();
    names = ["nut-cup", "fresh-cup"];
    gate = new Promise((r) => { release = r; });
    c.show();
    expect(c.state.packagesStatus).toBe("loading");
    expect(c.state.packages).toEqual(["nut-cup"]);
    expect(c.state.form.packageName).toBe("nut-cup");
    release();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup", "fresh-cup"]);
    expect(f.calls.filter((x) => x.path === "/api/packages")).toHaveLength(2);
    c.close();
    fail = true;
    gate = Promise.resolve();
    c.show();
    await c.loadPackages();
    expect(c.state.packages).toEqual(["nut-cup", "fresh-cup"]);
    expect(c.state.packagesStatus).toBe("ready");
  });

  it("server refusals show verbatim and keep the dialog open; a local problem never reaches the server; 401 signs out", async () => {
    let signedOut = 0;
    let reply: unknown = new ApiError(400, "Unknown tournament rules package.");
    const f = mockFetcher({ ...PACKAGES, "POST /api/tournaments": () => reply });
    const c = createTournamentCreator({ api: f, onSignedOut: () => { signedOut++; } });
    c.show();
    await c.loadPackages();
    expect(await c.submit()).toBeUndefined();
    expect(c.state.error).toBe("Enter a name.");
    expect(f.calls.some((x) => x.method === "POST")).toBe(false);
    c.state.form.name = "Spike Open";
    expect(await c.submit()).toBeUndefined();
    expect(c.state.error).toBe("Unknown tournament rules package.");
    expect(c.state.open).toBe(true);
    reply = new ApiError(409, "A tournament with that name already exists.");
    await c.submit();
    expect(c.state.error).toBe("A tournament with that name already exists.");
    reply = new ApiError(401, "Authentication required.");
    await c.submit();
    expect(signedOut).toBe(1);
    expect(c.state.error).toBe("Signed out. Sign in and try again.");
    expect(c.state.signedOut).toBe(true);
    expect(c.state.open).toBe(true);
    expect(c.state.busy).toBe(false);
  });
});

describe("create views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, create, detail, vueRouter, renderer, menu, api] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/create.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/AccountMenu.vue"),
      vite.ssrLoadModule("/src/shared/api.ts"),
    ]);
    mods = { app, create, detail, vueRouter, renderer, menu, api };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes, prep?: (inject: (key: symbol, v: unknown) => void, f: Fetcher) => Promise<void>) {
    const f = mockFetcher({ ...ANON, "/api/fork/tournaments": listPage(), ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await prep?.((k, v) => spa.app.provide(k, v), f);
    await spa.router.push(path);
    await spa.router.isReady();
    await spa.session.load();
    return { html: (await mods.renderer.renderToString(spa.app)) as string, spa, f };
  }

  it("Tournaments toolbar: CREATE right of Search for an organiser; none signed out, for a plain coach, a test sign-in or an admin flag alone", async () => {
    const org = await render("/tournaments", AS("Veers", { organizer: true }));
    expect(org.html).toMatch(/class="tl-search-btn" type="submit">Search<\/button><\/form><button class="tl-create-btn" type="button" aria-haspopup="dialog">Create<\/button><\/div>/);
    for (const routes of [ANON, AS("Bob"), AS("Veers", { organizer: true, test: true }), AS("Ada", { admin: true })]) {
      const { html } = await render("/tournaments", routes);
      expect(html).toContain('class="tl-search-btn"');
      expect(html).not.toContain("tl-create-btn");
    }
  });

  it("account menu: Create tournament between Account and Sign out only when allowed", async () => {
    const menu = async (canCreate: boolean) => {
      const app = createSSRApp(mods.menu.default, { canCreate });
      app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] }));
      return (await mods.renderer.renderToString(app)) as string;
    };
    const itemsOf = (html: string) => [...html.matchAll(/role="menuitem"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(itemsOf(await menu(true))).toEqual(["Account", "Create tournament", "Sign out"]);
    expect(itemsOf(await menu(false))).toEqual(["Account", "Sign out"]);
  });

  it("the dialog: band heading, the old form's fields (Rounds for Swiss only), server errors inline", async () => {
    const prep = (format: string, error = "") => async (inject: (k: symbol, v: unknown) => void, f: Fetcher) => {
      const creator: Creator = mods.create.createTournamentCreator({ api: f });
      creator.show();
      await creator.loadPackages();
      creator.state.form.format = format as never;
      creator.state.error = error;
      inject(mods.create.TOURNAMENT_CREATOR_KEY, creator);
    };
    const { html } = await render("/tournaments", { ...AS("Veers", { organizer: true }), ...PACKAGES }, prep("swiss", "A tournament with that name already exists."));
    const dlg = html.slice(html.indexOf('role="dialog"'));
    expect(dlg).toContain('aria-labelledby="tc-modal-h"');
    expect(dlg).toMatch(/<h3 id="tc-modal-h" class="tn-band">\s*Create Tournament/);
    const labels = [...dlg.matchAll(/class="tn-fact-k">([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(["Name", "Ruleset", "Type", "Max players", "Rounds", "First tiebreaker"]);
    expect(dlg).toContain('<option value="nut-cup" selected>nut-cup</option><option value="small-gods">small-gods</option>');
    expect(dlg).toContain('placeholder="Auto"');
    expect(dlg).toMatch(/<p class="lobby-error tc-full" role="alert">\s*A tournament with that name already exists\.\s*(<!---->)?<\/p>/);
    expect(dlg).toContain(">Create draft</button>");
    const ko = await render("/tournaments", { ...AS("Veers", { organizer: true }), ...PACKAGES }, prep("knockout"));
    const koLabels = [...ko.html.slice(ko.html.indexOf('role="dialog"')).matchAll(/class="tn-fact-k">([^<]+)</g)].map((m) => m[1]);
    expect(koLabels).not.toContain("Rounds");
    // Modal: the shell behind is inert, the dialog takes focus (tabindex -1) and a backdrop click never closes it.
    expect(html).toMatch(/<header class="shell-header sf-top"[^>]*inert[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<div class="sf-body"[^>]*inert[^>]*aria-hidden="true"/);
    expect(dlg).toMatch(/role="dialog"[^>]*tabindex="-1"/);
  });

  it("a lapsed session keeps the open dialog: its 401 error shows with the sign-in link, the shell stays inert", async () => {
    const lapsed = (inject: (k: symbol, v: unknown) => void, f: Fetcher) => (async () => {
      const creator: Creator = mods.create.createTournamentCreator({ api: f });
      creator.show();
      await creator.loadPackages();
      creator.state.form.name = "Spike Open";
      expect(await creator.submit()).toBeUndefined();
      inject(mods.create.TOURNAMENT_CREATOR_KEY, creator);
    })();
    const { html } = await render("/tournaments", { ...ANON, ...PACKAGES, "POST /api/tournaments": new mods.api.ApiError(401, "Authentication required.") }, lapsed);
    expect(html).not.toContain("tl-create-btn");
    const dlg = html.slice(html.indexOf('role="dialog"'));
    expect(dlg).toContain("Signed out. Sign in and try again.");
    expect(dlg).toMatch(/<a class="sf-discord-login small" href="\/api\/auth\/discord\/start\?next=%2Fapp%2Ftournaments" aria-label="Login with Discord">[\s\S]*?<span>Login with Discord<\/span><\/a>/);
    expect(html).toMatch(/<div class="sf-body"[^>]*inert/);
  });

  it("keyboard: the dialog uses the shared dialogKey trap (Tab wraps, Escape closes, Escape held while creating)", async () => {
    const manage = await vite.ssrLoadModule("/src/teams/manage.ts");
    const [a, b, c] = ["name", "select", "cancel"];
    expect(manage.dialogKey({ key: "Tab", shiftKey: false }, [a, b, c], c, false)).toEqual({ type: "focus", target: a });
    expect(manage.dialogKey({ key: "Tab", shiftKey: true }, [a, b, c], a, false)).toEqual({ type: "focus", target: c });
    expect(manage.dialogKey({ key: "Escape", shiftKey: false }, [a], a, false)).toEqual({ type: "close" });
    expect(manage.dialogKey({ key: "Escape", shiftKey: false }, [a], a, true)).toEqual({ type: "block" });
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(fileURLToPath(new URL("../spa/src/components/TournamentCreateDialog.vue", import.meta.url)), "utf8");
    expect(src).toContain("dialogKey(e, focusables(), document.activeElement as HTMLElement | null, state.busy)");
    expect(src).toContain('window.addEventListener("keydown", onKey, true)');
    expect(src).not.toContain("@click.self");
  });

  it("after Create: the new draft's Manage tab shows the created notice once", async () => {
    const t = { id: "t9", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3, currentRound: 0, entrantCount: 0, ownerCoachId: "Veers" } as TournamentSummary;
    const body: TournamentDetailResponse = { tournament: t, entrants: [], rounds: [], scheduledMatches: [], capabilities: { manage: true, assignRoles: true } };
    const routes = { ...AS("Veers", { organizer: true }), ...PACKAGES, "/api/tournaments/t9": body, "POST /api/tournaments": { tournament: t } };
    let creator: Creator | undefined;
    const { html, spa } = await render("/tournaments/t9?tab=manage", routes, async (inject, f) => {
      creator = mods.create.createTournamentCreator({ api: f });
      creator!.show();
      await creator!.loadPackages();
      creator!.state.form.name = "Spike Open";
      expect(await creator!.submit()).toBe("t9");
      inject(mods.create.TOURNAMENT_CREATOR_KEY, creator);
      const d = mods.detail.createTournamentDetail({ api: f });
      await d.load("t9");
      inject(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    });
    expect(spa.router.currentRoute.value.query.tab).toBe("manage");
    // The dialog pushes createdLocation(id): the new draft's Manage tab.
    expect(spa.router.resolve(mods.create.createdLocation("t9")).fullPath).toBe("/tournaments/t9?tab=manage");
    expect(html).toContain('<p class="tn-notice" role="status">Tournament created as a draft.</p>');
    expect(creator!.state.created).toBeNull();
  });
});
