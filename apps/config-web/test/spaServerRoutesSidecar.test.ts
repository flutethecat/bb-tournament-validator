import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// The SPA mount (/app) with the auth sidecar ON: public like /lobby/ (no /login redirect for a signed-out visitor;
// the SPA shows its own sign-in prompt), while the API it calls still answers 401.
const root = mkdtempSync(join(tmpdir(), "spa-routes-sidecar-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
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
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  // A deployed SPA shell (stand-in for build:spa output; the sidecar-off test serves a real build).
  mkdirSync(join(root, "spa-dist"), { recursive: true });
  writeFileSync(join(root, "spa-dist", "index.html"), '<!DOCTYPE html><html><body><div id="app"></div></body></html>', "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
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

describe("SPA routes (sidecar on)", () => {
  it("/app/lobby is public: no /login redirect, no 401; the deployed shell answers 200", async () => {
    for (const path of ["/app", "/app/lobby", "/app/lobby/abcDEF12", "/app/account"]) {
      const res = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).toContain('<div id="app">');
    }
  });

  it("Sign out with the sidecar on: guards kept, the session ends", async () => {
    const cookie = `${SESSION_COOKIE_NAME}=${createSession("SideCoach").token}`;
    expect((await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie } })).status).toBe(403);
    expect((await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { "x-cw-auth": "1" } })).status).toBe(401);
    const before = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    expect(((await before.json()) as { authenticated: boolean }).authenticated).toBe(true);
    const ok = await fetch(`${origin}/api/auth/logout`, { method: "POST", headers: { cookie, "x-cw-auth": "1" } });
    expect(ok.status).toBe(200);
    const after = await fetch(`${origin}/api/auth/session`, { headers: { cookie } });
    expect(((await after.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });

  it("a non-SPA page still redirects to /login, and the API the SPA calls still answers 401", async () => {
    const page = await fetch(`${origin}/users.html`, { redirect: "manual" });
    expect(page.status).toBe(302);
    const api = await fetch(`${origin}/api/account`);
    expect(api.status).toBe(401);
    const session = await fetch(`${origin}/api/auth/session`);
    expect(session.status).toBe(200);
    expect(((await session.json()) as { authenticated: boolean }).authenticated).toBe(false);
  });
});
