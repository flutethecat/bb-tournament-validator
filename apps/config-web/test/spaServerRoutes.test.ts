import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { linkedFumbblNameIn } from "../src/fumbblLink.js";
import { isSpaPath, spaFallback } from "../src/spaRoutes.js";
import { createSessionStore } from "../spa/src/session";

// The SPA mount (/app) on the live host's mode (sidecar OFF, ADMIN_PASSWORD set): public static with a history
// fallback, never Basic-gated, serving a real build:spa output (built to a temp SPA_DIST_DIR). Also Sign out
// (POST /api/auth/logout, dispatched outside the sidecar portal) and GET /api/account's linked fumbblName.
const root = mkdtempSync(join(tmpdir(), "spa-routes-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const record = (ffbCoachId: string, identities: Record<string, string>) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities,
  updatedAt: "2026-10-01T00:00:00.000Z", updatedBy: ffbCoachId,
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "",
    ADMIN_PASSWORD: "admin-secret",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
    SPA_DIST_DIR: join(root, "spa-dist"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const directory of ["library", "packages", "tournaments", "state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({
    version: 1,
    coaches: {
      spabob: record("SpaBob", { discordUserId: "424242", discordUsername: "bob_discord" }),
      victimname: record("victimname", { discordUserId: "other-discord" }),
    },
  }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), JSON.stringify([
    { id: "r1", discordUserId: "424242", fumbblName: "BobOnFumbbl", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "r2", fumbblName: "SpaAlice", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "r3", discordUserId: "victim-discord", fumbblName: "VictimName", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "r4", fumbblName: "Casey", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
  ]), "utf8");
  const { build } = await import("vite");
  await build({
    configFile: fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url)),
    logLevel: "silent",
    build: { outDir: join(root, "spa-dist"), emptyOutDir: true },
  });
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cookieFor = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;

describe("SPA path helpers", () => {
  it("mount + history fallback", () => {
    expect(isSpaPath("/app")).toBe(true);
    expect(isSpaPath("/app/lobby/abc123")).toBe(true);
    expect(isSpaPath("/apple")).toBe(false);
    expect(spaFallback("/app")).toBe(true);
    expect(spaFallback("/app/")).toBe(true);
    expect(spaFallback("/app/lobby/abcDEF12")).toBe(true);
    expect(spaFallback("/app/account")).toBe(true);
    expect(spaFallback("/app/index.html")).toBe(false);
    expect(spaFallback("/app/assets/index-abc.js")).toBe(false);
    expect(spaFallback("/app/assets/whatever")).toBe(false);
    expect(spaFallback("/lobby/")).toBe(false);
  });
});

describe("linkedFumbblNameIn (lobby coach card + /api/account)", () => {
  const e = (fumbblName: string, discordUserId?: string) => ({ id: fumbblName, fumbblName, ...(discordUserId ? { discordUserId } : {}), teams: [], updatedAt: "" });
  it("Discord id wins; a name match needs the exact name, no conflicting Discord owner, and uniqueness", () => {
    const reg = [e("BobOnFumbbl", "424242"), e("VictimName", "victim-discord"), e("Casey"), e("Twin"), e("Twin")];
    expect(linkedFumbblNameIn(reg, "SpaBob", "424242")).toBe("BobOnFumbbl");
    expect(linkedFumbblNameIn(reg, "VictimName", "victim-discord")).toBe("VictimName");
    expect(linkedFumbblNameIn(reg, "VictimName", "other-discord")).toBeNull();
    expect(linkedFumbblNameIn(reg, "victimname", "other-discord")).toBeNull();
    expect(linkedFumbblNameIn(reg, "VictimName", "")).toBeNull();
    expect(linkedFumbblNameIn(reg, "Casey", "")).toBe("Casey");
    expect(linkedFumbblNameIn(reg, "Casey", "someone")).toBe("Casey");
    expect(linkedFumbblNameIn(reg, "casey", "")).toBeNull();
    expect(linkedFumbblNameIn(reg, "CASEY", "x")).toBeNull();
    expect(linkedFumbblNameIn(reg, "Twin", "")).toBeNull();
    expect(linkedFumbblNameIn(reg, "Nobody", "")).toBeNull();
    expect(linkedFumbblNameIn([e("One", "d1"), e("Two", "d1")], "x", "d1")).toBeNull();
  });
});

describe("SPA routes (sidecar off)", () => {
  it("a deployed shell loads: /app routes answer 200 with the built index.html, and its bundle is served", async () => {
    for (const path of ["/app", "/app/", "/app/lobby", "/app/lobby/abcDEF12", "/app/account"]) {
      const res = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
      expect(res.headers.get("content-type"), path).toMatch(/text\/html/);
      const html = await res.text();
      expect(html, path).toContain('<div id="app">');
      expect(html, path).toContain('href="/theme.css"');
    }
    const html = await (await fetch(`${origin}/app/lobby`)).text();
    const script = html.match(/src="(\/app\/assets\/index-[\w-]+\.js)"/)?.[1];
    expect(script).toBeTruthy();
    const js = await fetch(`${origin}${script}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
  }, 60_000);

  it("a missing bundle file is a 404, not the shell", async () => {
    expect((await fetch(`${origin}/app/assets/missing-file.js`)).status).toBe(404);
  });

  it("Sign out works with sidecar off: the SPA session store over the real API ends the cookie session", async () => {
    const cookie = cookieFor("SpaBob");
    const realFetch = globalThis.fetch;
    // The SPA's own api() (same-origin paths, X-CW-Auth on writes), pointed at this server with the coach cookie.
    vi.stubGlobal("fetch", (path: string, init: RequestInit = {}) =>
      realFetch(`${origin}${path}`, { ...init, headers: { ...(init.headers as Record<string, string>), cookie } }));
    try {
      const session = createSessionStore();
      await session.load();
      expect(session.signedIn()).toBe(true);
      expect(session.coach()).toBe("SpaBob");
      await session.signOut();
      expect(session.signedIn()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
    const after = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  it("logout keeps its guards with sidecar off: X-CW-Auth required, a live session required", async () => {
    const cookie = cookieFor("SpaBob");
    const noCsrf = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie } });
    expect(noCsrf.status).toBe(403);
    const still = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    expect(((await still.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const anon = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { "x-cw-auth": "1" } });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toBeNull();
    const ok = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, "x-cw-auth": "1" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/cw_session=;/);
  });

  it("GET /api/account carries the linked fumbblName (by Discord id, then by coach name); nothing secret", async () => {
    const bob = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("SpaBob") } });
    expect(bob.status).toBe(200);
    const bobBody = await bob.json() as { fumbblName: string | null; ffbCoachId: string };
    expect(bobBody.ffbCoachId).toBe("SpaBob");
    expect(bobBody.fumbblName).toBe("BobOnFumbbl");
    expect(JSON.stringify(bobBody)).not.toMatch(/password|digest|passwordHash/i);

    const alice = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("SpaAlice") } });
    expect((await alice.json() as { fumbblName: string | null }).fumbblName).toBe("SpaAlice");

    const nobody = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("SpaNobody") } });
    expect((await nobody.json() as { fumbblName: string | null }).fumbblName).toBeNull();

    const anon = await fetch(`${origin}/api/account`);
    expect(anon.status).toBe(401);
  });

  it("GET /api/account never attributes another coach's FUMBBL identity", async () => {
    // fork coach "victimname" (Discord other-discord) vs registry VictimName owned by victim-discord: no link
    const victim = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("victimname") } });
    expect((await victim.json() as { fumbblName: string | null }).fumbblName).toBeNull();
    // case collision: registry "Casey" (no Discord id) is not fork coach "casey"
    const casey = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("casey") } });
    expect((await casey.json() as { fumbblName: string | null }).fumbblName).toBeNull();
    const exact = await fetch(`${origin}/api/account`, { headers: { cookie: cookieFor("Casey") } });
    expect((await exact.json() as { fumbblName: string | null }).fumbblName).toBe("Casey");
  });
});
