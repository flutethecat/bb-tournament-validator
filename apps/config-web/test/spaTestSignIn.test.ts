import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import { createSessionStore, TEST_LOGIN_SECRET_KEY, type Fetcher } from "../spa/src/session";
import { createTestMatchTeams } from "../spa/src/tabletop/testMatchTeams";

// Test sign-in card (/app/account, and the signed-out prompt) and the tabletop Test match card, server-rendered
// through the SPA's own Vite config like spaShell.test.ts.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

describe("test sign-in + test match cards (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { app, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const fetcher = (routes: Record<string, unknown>): Fetcher =>
    (async (path: string, init: { method?: string } = {}) => {
      const hit = routes[`${init.method ?? "GET"} ${path}`] ?? routes[path];
      if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
      return hit;
    }) as Fetcher;

  async function render(path: string, routes: Record<string, unknown>): Promise<string> {
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: fetcher(routes) });
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  const signedIn = (extra: Record<string, unknown> = {}) => ({ authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true, ...extra });
  const account = { ffbCoachId: "Alice", fumbblName: null };
  const enabled = { enabled: true, coaches: [{ coach: "Alice", level: "organizer" }, { coach: "Bob", level: "player" }] };

  it("account page: card hidden when options are disabled, unreachable, or absent", async () => {
    for (const options of [{ enabled: false }, undefined]) {
      const html = await render("/account", { "/api/auth/session": signedIn(), "/api/account": account, ...(options ? { "/api/auth/test-login/options": options } : {}) });
      expect(html).toContain("Account");
      expect(html).not.toContain("Test sign-in");
    }
  });

  it("account page: card shown when enabled, with the coaches, levels and a password-type secret field", async () => {
    const html = await render("/account", { "/api/auth/session": signedIn(), "/api/account": account, "/api/auth/test-login/options": enabled });
    expect(html).toContain("Test sign-in (this machine only)");
    expect(html).toContain("Alice (organizer)");
    expect(html).toContain("Bob (player)");
    expect(html).toMatch(/id="ts-secret"[^>]*type="password"|type="password"[^>]*id="ts-secret"/);
  });

  it("signed-out visitors see the card under the sign-in prompt when enabled", async () => {
    const html = await render("/account", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true }, "/api/auth/test-login/options": enabled });
    expect(html).toContain("Sign in");
    expect(html).toContain("Test sign-in (this machine only)");
  });

  const tabletopRoutes = (session: Record<string, unknown>) => ({
    "/api/auth/session": session,
    "/api/tabletop/matches": { matches: [] },
    "/api/tabletop/teams": { teams: [] },
    "/api/tabletop/fixtures": { fixtures: [] },
    "/api/admin/testing/tools": { tools: [{ id: "tabletop-test-match", description: "Load a recorder match from two chosen teams; test matches never count in standings, Elo or results." }] },
    "/api/admin/testing/tabletop-defaults": { defaults: { home: { coach: "Alice", team: "library:77" }, away: { coach: "Bob", team: "sv_b" } } },
    "/api/admin/testing/teams?coach=Alice": { coach: "Alice", teams: [{ ref: "library:77", name: "Alice Lib", race: "Human", tv: 1000 }] },
    "/api/admin/testing/teams?coach=Bob": { coach: "Bob", teams: [{ ref: "sv_b", name: "Bob Save", race: "Orc", tv: null }] },
  });

  it("tabletop: the Test match card shows for an organiser, prefilled from the defaults, with the never-counts line", async () => {
    const html = await render("/tabletop", tabletopRoutes(signedIn({ organizer: true })));
    expect(html).toContain("Test match");
    expect(html).toContain("test matches never count");
    expect(html).toContain("Alice Lib (Human)");
    expect(html).toContain("Bob Save (Orc)");
    expect(html).toContain("Create test match");
    expect(html).toContain("Purge test matches");
  });

  it("tabletop: the Test match card shows for an admin and is absent for a plain player", async () => {
    expect(await render("/tabletop", tabletopRoutes(signedIn({ admin: true })))).toContain("Create test match");
    const player = await render("/tabletop", tabletopRoutes(signedIn()));
    expect(player).not.toContain("Create test match");
    expect(player).not.toContain("Purge test matches");
  });
});

describe("test match team lists", () => {
  const routes: Record<string, unknown> = {
    "/api/admin/testing/teams?coach=Alice": { teams: [{ ref: "library:77", name: "Alice Lib" }] },
    "/api/admin/testing/teams?coach=Bob": { teams: [{ ref: "sv_b", name: "Bob A" }, { ref: "sv_c", name: "Bob B" }] },
    "/api/admin/testing/teams?coach=Nobody": { teams: [] },
  };
  const f = (async (path: string) => { if (!(path in routes)) throw new ApiError(404, "no mock"); return routes[path]; }) as Fetcher;

  it("changing a side's coach reloads that side's list and re-picks the first team; the other side is untouched", async () => {
    const { state, load } = createTestMatchTeams(f);
    const home = { coach: "Alice", team: "" };
    const away = { coach: "Bob", team: "sv_c" };
    await Promise.all([load("home", home), load("away", away)]);
    expect(state.home.map((t) => t.ref)).toEqual(["library:77"]);
    expect(home.team).toBe("library:77");
    expect(state.away).toHaveLength(2);
    expect(away.team).toBe("sv_c"); // still listed, so kept
    home.coach = "Bob";
    await load("home", home);
    expect(state.home.map((t) => t.ref)).toEqual(["sv_b", "sv_c"]);
    expect(home.team).toBe("sv_b");
    expect(state.away).toHaveLength(2);
    home.coach = "Nobody";
    await load("home", home);
    expect(state.home).toEqual([]);
    expect(home.team).toBe("");
  });

  it("a slow older response never overwrites a newer coach's list", async () => {
    let release: (v: unknown) => void = () => undefined;
    const slow = new Promise((r) => { release = r; });
    const fetcher = (async (path: string) => (path.endsWith("Alice") ? slow : routes[path])) as Fetcher;
    const { state, load } = createTestMatchTeams(fetcher);
    const side = { coach: "Alice", team: "" };
    const first = load("home", side);
    side.coach = "Bob";
    await load("home", side);
    release(routes["/api/admin/testing/teams?coach=Alice"]);
    await first;
    expect(state.home.map((t) => t.ref)).toEqual(["sv_b", "sv_c"]);
  });
});

describe("test secret is forgotten on sign-out", () => {
  const store = new Map<string, string>();
  afterEach(() => { vi.unstubAllGlobals(); store.clear(); });

  it("session.signOut() removes cw.testLoginSecret (also when the logout call fails)", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    for (const failLogout of [false, true]) {
      store.set(TEST_LOGIN_SECRET_KEY, "secret-0123456789abcdef");
      const sess = createSessionStore((async (path: string) => {
        if (path === "/api/auth/logout" && failLogout) throw new ApiError(500, "boom");
        return path === "/api/auth/session" ? { authenticated: false } : { ok: true };
      }) as Fetcher);
      await sess.signOut().catch(() => undefined);
      expect(store.has(TEST_LOGIN_SECRET_KEY)).toBe(false);
    }
    expect(TEST_LOGIN_SECRET_KEY).toBe("cw.testLoginSecret");
  });
});
