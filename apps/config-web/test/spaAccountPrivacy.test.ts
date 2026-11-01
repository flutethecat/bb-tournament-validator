import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { confirmMatches, createPrivacyController, DELETE_PATH, DELETED_NOTICE, flash, setFlash, clearFlash } from "../spa/src/account/privacy";

// Account page Privacy panel (privacy spec 2026-10-31 §2/§3): download my data, the two-step delete, the sign-out
// notice, and the panel markup (SSR).

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; init?: unknown }> } {
  const calls: Array<{ path: string; init?: unknown }> = [];
  const f = (async (path: string, init?: unknown) => {
    calls.push({ path, init });
    const hit = routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as Fetcher & { calls: Array<{ path: string; init?: unknown }> };
  f.calls = calls;
  return f;
}

describe("privacy controller", () => {
  it("download: saves the blob under the server's file name; shows the server's error", async () => {
    const saved: string[] = [];
    let answer: Awaited<ReturnType<NonNullable<Parameters<typeof createPrivacyController>[0]["download"]>>> = { ok: true, blob: new Blob(["zip"]), filename: "super-fumbbl-data-2026-10-31.zip" };
    const c = createPrivacyController({ api: mockFetcher({}), coach: () => "Alice", download: async () => answer, save: (_b, name) => saved.push(name), onDeleted: () => undefined });
    await c.downloadData();
    expect(saved).toEqual(["super-fumbbl-data-2026-10-31.zip"]);
    expect(c.state.downloadNotice).toBe("Your data is downloading.");
    answer = { ok: false, status: 429, error: "You can download your data 3 times an hour. Try again later." };
    await c.downloadData();
    expect(c.state.downloadError).toMatch(/3 times an hour/);
    expect(c.state.downloading).toBe(false);
  });

  it("delete: explain, then type the name, then POST; success signs out via onDeleted", async () => {
    const f = mockFetcher({ [DELETE_PATH]: { ok: true, pending: [] } });
    let deleted = 0;
    const c = createPrivacyController({ api: f, coach: () => "Alice", onDeleted: () => { deleted += 1; } });
    expect(c.state.stage).toBe("closed");
    c.open();
    expect(c.state.stage).toBe("explain");
    await c.confirmDelete(); // not on the confirm step yet: nothing sent
    expect(f.calls).toEqual([]);
    c.next();
    c.state.typed = "Alicia";
    await c.confirmDelete();
    expect(c.state.deleteError).toMatch(/exactly/);
    expect(f.calls).toEqual([]);
    c.state.typed = " alice ";
    await c.confirmDelete();
    expect(f.calls).toEqual([{ path: DELETE_PATH, init: { method: "POST", body: { confirm: "alice" } } }]);
    expect(c.state.stage).toBe("done");
    expect(deleted).toBe(1);
  });

  it("delete: an ownership block lists what to hand over and stays on the confirm step", async () => {
    const owned = [{ kind: "league", id: "l1", name: "Valley League" }];
    const f = mockFetcher({ [DELETE_PATH]: new ApiError(409, 'Transfer ownership first: league "Valley League".', { owned }) });
    const c = createPrivacyController({ api: f, coach: () => "Alice", onDeleted: () => { throw new Error("must not run"); } });
    c.open(); c.next();
    c.state.typed = "Alice";
    await c.confirmDelete();
    expect(c.state.stage).toBe("confirm");
    expect(c.state.owned).toEqual(owned);
    expect(c.state.deleteError).toMatch(/Transfer ownership first/);
    c.cancel();
    expect(c.state.stage).toBe("closed");
  });

  it("confirmMatches folds case and spaces; the flash notice", () => {
    expect(confirmMatches("  ALICE ", "Alice")).toBe(true);
    expect(confirmMatches("Alic", "Alice")).toBe(false);
    expect(confirmMatches("", "")).toBe(false);
    setFlash(DELETED_NOTICE);
    expect(flash.message).toBe("Your account was deleted.");
    clearFlash();
    expect(flash.message).toBe("");
  });
});

describe("privacy panel markup (SSR)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { use: (p: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    createRouter: (o: unknown) => unknown;
    createSSRApp: (c: unknown, p?: unknown) => { use: (p: unknown) => void };
    renderToString: (app: unknown) => Promise<string>;
    AccountPrivacy: unknown;
    privacy: typeof import("../spa/src/account/privacy");
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, panel, privacy] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/AccountPrivacy.vue"), vite.ssrLoadModule("/src/account/privacy.ts"),
    ]);
    mods = {
      createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, createRouter: vueRouter.createRouter, createSSRApp: createSSRApp as never,
      renderToString: renderer.renderToString, AccountPrivacy: panel.default, privacy: privacy as typeof import("../spa/src/account/privacy"),
    };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const signedIn = { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true } };

  it("the Account page carries the Privacy panel with both actions and a single notice link", async () => {
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: mockFetcher(signedIn) });
    await spa.router.push("/account");
    await spa.router.isReady();
    const html = await mods.renderToString(spa.app);
    expect(html).toContain('id="privacy"');
    expect(html).toContain('<h2 id="ac-privacy-h">Privacy</h2>');
    expect(html).toContain("Download my data");
    expect(html).toContain("Delete my account");
    // one notice link on the page (the notice lane's, at the top), not a second one in the panel
    expect(html.match(/How we use your data/g)).toHaveLength(1);
  });

  async function renderPanel(stage: "explain" | "confirm", typed = "") {
    const c = mods.privacy.createPrivacyController({ api: mockFetcher({}), coach: () => "Alice", onDeleted: () => undefined });
    c.open();
    if (stage === "confirm") { c.next(); c.state.typed = typed; }
    const app = mods.createSSRApp(mods.AccountPrivacy, { controller: c, coach: "Alice" });
    app.use(mods.createRouter({ history: mods.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] }));
    return mods.renderToString(app);
  }

  it("step one explains what is deleted and what is anonymised", async () => {
    const html = await renderPanel("explain");
    expect(html).toContain("Delete your account?");
    expect(html).toContain("Saved rosters and their share links");
    expect(html).toContain("Deleted coach #");
    expect(html).toContain("Game results, standings, ratings and titles");
    expect(html).toContain(">Continue<");
  });

  it("step two asks for the coach name; the final button is disabled until it matches", async () => {
    const empty = await renderPanel("confirm");
    expect(empty).toContain("Type your coach name <strong>Alice</strong> to confirm.");
    expect(empty).toMatch(/<button class="ob-btn ac-danger" type="submit" disabled[^>]*>Delete my account<\/button>/);
    const typed = await renderPanel("confirm", "alice");
    expect(typed).toMatch(/<button class="ob-btn ac-danger" type="submit"(?! disabled)[^>]*>Delete my account<\/button>/);
  });
});
