import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// End to end with a stubbed fork ACCOUNT STORE (the MySQL reads only; everything else is the real server):
// the stored digest reaches a coach only through the session-scoped GET /api/lobby/:id/jnlp, for that coach's
// own seat, under the game-start gate; never through matchstatus.
const DIGESTS: Record<string, string> = { dbalice: "a1".repeat(16), dbbob: "b2".repeat(16) };

vi.mock("@bb/fork-ops", async (importActual) => {
  const actual = await importActual<typeof import("@bb/fork-ops")>();
  return {
    ...actual,
    forkDbConfigFromEnv: () => ({ dbHost: "stub", dbPort: 3306, dbUser: "stub", dbPassword: "stub", dbName: "stub" }),
    forkCoachPasswordDigest: async (_cfg: unknown, coach: string) => DIGESTS[coach.toLowerCase()],
    verifyCoachDigest: async (_cfg: unknown, coach: string, digest: string) => DIGESTS[coach.toLowerCase()] === digest,
  };
});

const root = mkdtempSync(join(tmpdir(), "lobby-db-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let forkOps: typeof import("@bb/fork-ops");

const team = (coach: string, teamId: string) => ({
  teamId, teamName: `${coach} XI`, race: "Orc", coach, teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00.000Z",
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
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "packages", "tournaments", "state", "teams"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "library", "dbalice.json"), JSON.stringify([team("DbAlice", "9201")]), "utf8");
  writeFileSync(join(root, "library", "dbbob.json"), JSON.stringify([team("DbBob", "9202")]), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  forkOps = await import("@bb/fork-ops");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;
const post = (path: string, c: string, body: unknown) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { cookie: c, "content-type": "application/json", "x-cw-auth": "1" }, body: JSON.stringify(body) });

describe("lobby JNLP with a fork account store", () => {
  it("delivers each coach's OWN stored digest only via GET /api/lobby/:id/jnlp, under the game-start gate", async () => {
    const alice = cookie("DbAlice");
    const bob = cookie("DbBob");
    const { lobby } = (await (await post("/api/lobby", alice, { teamId: "9201", opponent: "DbBob" })).json()) as { lobby: { id: string } };
    expect((await post(`/api/lobby/${lobby.id}/join`, bob, { teamId: "9202" })).status).toBe(200);

    // never through matchstatus, even for the owner
    const ms = (await (await fetch(`${origin}/api/fork/matchstatus?coach=DbAlice`, { headers: { cookie: alice } })).json()) as Record<string, unknown>;
    expect(ms).not.toHaveProperty("jnlp");
    expect(JSON.stringify(ms)).not.toContain(DIGESTS.dbalice);

    const a = await (await fetch(`${origin}/api/lobby/${lobby.id}/jnlp`, { headers: { cookie: alice } })).text();
    const b = await (await fetch(`${origin}/api/lobby/${lobby.id}/jnlp`, { headers: { cookie: bob } })).text();
    expect(a).toContain(`<argument>-coach</argument><argument>DbAlice</argument>`);
    expect(a).toContain(`<argument>-passwordMd5</argument><argument>${DIGESTS.dbalice}</argument>`);
    expect(a).not.toContain(DIGESTS.dbbob);
    expect(b).toContain(`<argument>-passwordMd5</argument><argument>${DIGESTS.dbbob}</argument>`);
    expect(b).not.toContain(DIGESTS.dbalice);
    expect(a + b).not.toContain("12345");

    // the download honours the cache-recovery gate and the game-start lock, like the POSTs
    const teamsDir = join(root, "teams");
    const lock = forkOps.acquireTeamNameWriteLock(teamsDir)!;
    expect((await fetch(`${origin}/api/lobby/${lobby.id}/jnlp`, { headers: { cookie: alice } })).status).toBe(409);
    lock.release();
    forkOps.markForkCacheReloadRequired(teamsDir, "test");
    expect((await fetch(`${origin}/api/lobby/${lobby.id}/jnlp`, { headers: { cookie: alice } })).status).toBe(503);
    unlinkSync(forkOps.forkCacheReloadMarkerPath(teamsDir));
    expect((await fetch(`${origin}/api/lobby/${lobby.id}/jnlp`, { headers: { cookie: alice } })).status).toBe(200);
  });
});
