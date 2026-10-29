import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import { squareCrop } from "../spa/src/shared/avatarImage";
import type { Fetcher } from "../spa/src/session";

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

describe("squareCrop", () => {
  it("centre-crops to a square and never upscales; caps at 512", () => {
    expect(squareCrop(1000, 600)).toEqual({ sx: 200, sy: 0, side: 600, out: 512 });
    expect(squareCrop(300, 400)).toEqual({ sx: 0, sy: 50, side: 300, out: 300 });
    expect(squareCrop(512, 512)).toEqual({ sx: 0, sy: 0, side: 512, out: 512 });
  });
});

describe("My teams avatar control (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { app, vueRouter, renderer };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const fetcher = (routes: Record<string, unknown>): Fetcher =>
    (async (path: string) => { if (!(path in routes)) throw new ApiError(404, `no mock for ${path}`); return routes[path]; }) as Fetcher;

  it("lists each team with an Avatar file input (image/*), Upload and Remove, and the crest fallback line", async () => {
    const spa = mods.app.createSpa({
      history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true,
      fetcher: fetcher({
        "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
        "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [{ ref: "library:77", name: "Alice Lib", race: "Human" }, { ref: "save:sv_a", name: "Alice Save", race: "Orc" }] },
      }),
    });
    await spa.router.push("/my-teams");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toContain("My teams");
    expect(html).toContain("Alice Lib");
    expect(html).toContain("Alice Save");
    expect(html.match(/type="file"[^>]*accept="image\/\*"|accept="image\/\*"[^>]*type="file"/g)).toHaveLength(2);
    expect(html.match(/>Upload</g)).toHaveLength(2);
    expect(html.match(/>Remove</g)).toHaveLength(2);
    expect(html).toContain("Race crest (no avatar yet)");
  });
});
