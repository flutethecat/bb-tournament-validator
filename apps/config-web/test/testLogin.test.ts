import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-secret-0123456789";
const root = mkdtempSync(join(tmpdir(), "test-login-"));
const touched = new Map<string, string | undefined>();

function setEnv(values: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(values)) {
    if (!touched.has(name)) touched.set(name, process.env[name]);
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
}

interface Booted {
  origin: string;
  close: () => Promise<void>;
  reset: () => void;
  identitiesFile: string;
}

async function boot(sidecar: boolean): Promise<Booted> {
  const dir = join(root, sidecar ? "on" : "off");
  for (const d of ["library", "packages", "tournaments", "state"]) mkdirSync(join(dir, d), { recursive: true });
  const identitiesFile = join(dir, "identities.json");
  writeFileSync(identitiesFile, JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(dir, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(dir, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  setEnv({
    AUTH_SIDECAR_ENABLED: sidecar ? "1" : "",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: identitiesFile,
    ORGANIZERS_FILE: join(dir, "organizers.json"),
    SESSIONS_FILE: join(dir, "sessions.json"),
    FORK_LIBRARY_DIR: join(dir, "library"),
    FORK_BUILDER_SAVES_DIR: join(dir, "saves"),
    FORK_STATE_DIR: join(dir, "state"),
    PACKAGES_DIR: join(dir, "packages"),
    TOURNAMENTS_DIR: join(dir, "tournaments"),
    COACH_REGISTRY_JSON: join(dir, "coaches.json"),
    ADMIN_PASSWORD: "",
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
    TEST_LOGIN_SECRET: SECRET,
    TEST_LOGIN_COACHES: "Alice:organizer,bob,Carol:admin",
  });
  delete process.env.FORK_TEAMS_DIR;
  vi.resetModules();
  const { server } = await import("../src/server.js");
  const attempts = await import("../src/auth/testLogin.js");
  if (!server.listening) await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
    reset: () => attempts.testLoginAttemptsByIp.clear(),
    identitiesFile,
  };
}

afterAll(() => {
  for (const [name, value] of touched) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const post = (origin: string, coach: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}/api/auth/test-login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cw-auth": "1", "x-test-login": SECRET, ...headers },
    body: JSON.stringify({ coach }),
  });

for (const sidecar of [true, false]) {
  describe(`test sign-in (sidecar ${sidecar ? "on" : "off"})`, () => {
    let b: Booted;
    let started = false;
    const ready = async () => { if (!started) { b = await boot(sidecar); started = true; } };
    afterAll(async () => { if (started) await b.close(); });
    beforeEach(async () => { await ready(); b.reset(); setEnv({ TEST_LOGIN_SECRET: SECRET, TEST_LOGIN_COACHES: "Alice:organizer,bob,Carol:admin" }); });

    it("does not exist without the env (404 like any unknown path)", async () => {
      setEnv({ TEST_LOGIN_SECRET: undefined });
      const without = await post(b.origin, "bob");
      setEnv({ TEST_LOGIN_SECRET: "short", TEST_LOGIN_COACHES: "bob" });
      const short = await post(b.origin, "bob");
      setEnv({ TEST_LOGIN_SECRET: SECRET, TEST_LOGIN_COACHES: undefined });
      const noCoaches = await post(b.origin, "bob");
      const unknown = await fetch(`${b.origin}/api/auth/no-such-route`, { method: "POST", headers: { "x-cw-auth": "1" } });
      expect(without.status).toBe(unknown.status);
      expect(short.status).toBe(unknown.status);
      expect(noCoaches.status).toBe(unknown.status);
      expect(without.status).not.toBe(200);
    });

    it("403 with X-Forwarded-For or missing headers", async () => {
      expect((await post(b.origin, "bob", { "x-forwarded-for": "203.0.113.9" })).status).toBe(403);
      const noCsrf = await fetch(`${b.origin}/api/auth/test-login`, {
        method: "POST", headers: { "content-type": "application/json", "x-test-login": SECRET }, body: JSON.stringify({ coach: "bob" }),
      });
      expect(noCsrf.status).toBe(403);
      const noSecret = await fetch(`${b.origin}/api/auth/test-login`, {
        method: "POST", headers: { "content-type": "application/json", "x-cw-auth": "1" }, body: JSON.stringify({ coach: "bob" }),
      });
      expect(noSecret.status).toBe(403);
    });

    it("401 on a wrong secret, 429 after 3 failures (even with the right secret)", async () => {
      for (let i = 0; i < 3; i += 1) expect((await post(b.origin, "bob", { "x-test-login": "wrong-secret-000000" })).status).toBe(401);
      expect((await post(b.origin, "bob", { "x-test-login": "wrong-secret-000000" })).status).toBe(429);
      expect((await post(b.origin, "bob")).status).toBe(429);
    });

    it("403 for a coach not in TEST_LOGIN_COACHES", async () => {
      expect((await post(b.origin, "mallory")).status).toBe(403);
    });

    it("signs in: cookie, discord method, test:true, stored casing, level raised once", async () => {
      const res = await post(b.origin, "aLiCe");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, coach: "Alice", level: "organizer" });
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^cw_session=[a-f0-9]{64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict/);
      const session = await (await fetch(`${b.origin}/api/auth/session`, { headers: { cookie: cookie.split(";")[0]! } })).json();
      expect(session).toMatchObject({ authenticated: true, coach: "Alice", authMethod: "discord", test: true, organizer: true });
      const stored = JSON.parse(readFileSync(b.identitiesFile, "utf8")).coaches;
      expect(stored.alice.level).toBe("organizer");
      expect(stored.alice.updatedBy).toBe("test-login");
    });

    it("never lowers a stored level; default level is player", async () => {
      const carol = await post(b.origin, "carol");
      expect((await carol.json()).level).toBe("admin");
      setEnv({ TEST_LOGIN_COACHES: "Carol:player,bob" });
      const lower = await post(b.origin, "carol");
      expect((await lower.json()).level).toBe("admin");
      expect(JSON.parse(readFileSync(b.identitiesFile, "utf8")).coaches.carol.level).toBe("admin");
      const bob = await post(b.origin, "bob");
      expect((await bob.json()).level).toBe("player");
    });
  });
}

describe("test sign-in loopback guard (unit)", () => {
  it("answers 403 for a non-loopback socket", async () => {
    setEnv({ TEST_LOGIN_SECRET: SECRET, TEST_LOGIN_COACHES: "bob" });
    const { handleTestLogin } = await import("../src/auth/testLogin.js");
    let status = 0;
    const res = { writeHead: (s: number) => { status = s; }, end: () => undefined } as never;
    const req = {
      method: "POST",
      socket: { remoteAddress: "203.0.113.9" },
      headers: { "x-cw-auth": "1", "x-test-login": SECRET },
    } as never;
    expect(await handleTestLogin(req, res, "/api/auth/test-login")).toBe(true);
    expect(status).toBe(403);
  });
});
