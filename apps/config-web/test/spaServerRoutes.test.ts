import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { isSpaPath, spaFallback } from "../src/spaRoutes.js";

// The SPA mount (/app) on the live host's mode (sidecar OFF, ADMIN_PASSWORD set): public static with a history
// fallback, never Basic-gated. Also GET /api/account's linked fumbblName (same registry lookup as the lobby card).
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
    },
  }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), JSON.stringify([
    { id: "r1", discordUserId: "424242", fumbblName: "BobOnFumbbl", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
    { id: "r2", fumbblName: "SpaAlice", teams: [], updatedAt: "2026-10-01T00:00:00.000Z" },
  ]), "utf8");
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

const cookieFor = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach).token}`;

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

describe("SPA routes (sidecar off)", () => {
  it("/app/lobby is public static, never Basic-gated; SPA routes fall back to index.html", async () => {
    for (const path of ["/app", "/app/", "/app/lobby", "/app/lobby/abcDEF12", "/app/account"]) {
      const res = await fetch(`${origin}${path}`, { redirect: "manual" });
      expect(res.status, path).not.toBe(401);
      expect(res.headers.get("www-authenticate"), path).toBeNull();
      // 200 with the shell when the host has run build:spa, 404 when it has not (build output is not committed).
      expect([200, 404], path).toContain(res.status);
      if (res.status === 200) expect(await res.text()).toContain('<div id="app">');
    }
  });

  it("a missing bundle file is a 404, not the shell", async () => {
    const res = await fetch(`${origin}/app/assets/missing-file.js`);
    expect(res.status).toBe(404);
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
});
