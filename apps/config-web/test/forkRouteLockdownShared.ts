// Fork route lockdown (owner rulings 11-03, src/auth/forkRouteAuth.ts), run once per gate path: the AUTH_SIDECAR session
// gate (forkRouteLockdownSidecar.test.ts, the live :4310 path) and the sidecar-off ADMIN_PASSWORD gate
// (forkRouteLockdownSidecarOff.test.ts). FORK_ROUTES_REQUIRE_AUTH is read per request, so each test sets it.
// No fork DB, fork admin API or teams dir is configured: a route that passes the lockdown answers 5xx / 4xx from its own
// handler, never the lockdown's 401 sign_in_required.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";

const ADMIN_PASSWORD = "admin-secret";
const SERVICE_KEY = "service-key-for-tests";
const SIGN_IN = "sign_in_required";

type Row = { method: string; path: string; body?: unknown };

/** Every formerly public fork route the lockdown covers (game creation is exempt, owner 11-03). */
export const LOCKED: Row[] = [
  { method: "GET", path: "/api/fork/library?coach=LockCoach" },
  { method: "POST", path: "/api/fork/library/ingest", body: { coach: "LockCoach", team: "1" } },
  { method: "POST", path: "/api/fork/library/retire", body: { teamId: "T1" } },
  { method: "GET", path: "/api/fork/coaches?q=Lo" },
  { method: "POST", path: "/api/fork/reload", body: {} },
  { method: "GET", path: "/api/fork/games" },
  { method: "GET", path: "/api/fork/records" },
  { method: "POST", path: "/api/fork/team-builder/build", body: {} },
  { method: "POST", path: "/api/fork/my-games", body: {} },
  { method: "GET", path: "/api/fork/team-builder/saves" },
];

/** Stays open on purpose: sign-in / sign-up and the Tournament Builder reads (owner 11-03). */
export const OPEN: Row[] = [
  { method: "POST", path: "/api/fork/login", body: {} },
  { method: "GET", path: "/api/fork/name-available?coach=Somebody" },
  { method: "GET", path: "/api/fork/register?coach=NewCoach&passwordMd5=" + "a".repeat(32) },
  { method: "GET", path: "/api/fork/rosters" },
  { method: "GET", path: "/api/fork/team-builder/tiers" },
  { method: "GET", path: "/api/fork/team-builder/limits" },
  { method: "GET", path: "/api/fork/team-builder/inducements" },
  { method: "GET", path: "/api/fork/team-builder/legal-skills?rosterId=1&positionId=1" },
  { method: "POST", path: "/api/fork/team-builder/preview", body: {} },
  { method: "GET", path: "/api/fork/tournaments" },
];

/** Game creation: unchanged for the live client, flag on or off (TEMPORARY exemption, owner 11-03). */
export const GAME_CREATION: Row[] = [
  { method: "GET", path: "/api/fork/challenge?coach=LockCoach&teamId=T9&opponent=OtherCoach&passwordMd5=" + "b".repeat(32) },
  { method: "GET", path: "/api/fork/challenge?coach=LockCoach&teamId=T9&opponent=OtherCoach&password=clear-text" },
  { method: "GET", path: "/api/fork/matchstatus?coach=LockCoach" },
  { method: "GET", path: "/api/fork/jnlp?coach=LockCoach&teamId=T1&gameName=g&passwordMd5=" + "c".repeat(32) },
];

export function defineForkLockdownSuite(mode: "sidecar" | "sidecar-off"): void {
  const root = mkdtempSync(join(tmpdir(), `fork-lockdown-${mode}-`));
  const previousEnv = new Map<string, string | undefined>();
  let origin = "";
  let server: (typeof import("../src/server.js"))["server"];
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      AUTH_SIDECAR_ENABLED: mode === "sidecar" ? "1" : "",
      ADMIN_PASSWORD,
      CONFIG_WEB_SERVICE_KEY: SERVICE_KEY,
      HOST: "127.0.0.1",
      PORT: "0",
      IDENTITIES_FILE: join(root, "identities.json"),
      ORGANIZERS_FILE: join(root, "organizers.json"),
      SESSIONS_FILE: join(root, "sessions.json"),
      FORK_LIBRARY_DIR: join(root, "library"),
      FORK_BUILDER_SAVES_DIR: join(root, "saves"),
      FORK_STATE_DIR: join(root, "state"),
      PACKAGES_DIR: join(root, "packages"),
      TOURNAMENTS_DIR: join(root, "tournaments"),
      BUG_REPORTS_DIR: join(root, "bug-reports"),
      TABLETOP_DIR: join(root, "tabletop"),
      TEAM_AVATARS_DIR: join(root, "team-avatars"),
      COACH_AVATARS_DIR: join(root, "coach-avatars"),
      COACH_REGISTRY_JSON: join(root, "coach-registry.json"),
      CONFIG_WEB_LOG_DIR: join(root, "log"),
      BUILD_LOG_FILE: join(root, "build-log.json"),
      FORK_ADMIN_PASSWORD: "",
    })) {
      previousEnv.set(name, process.env[name]);
      process.env[name] = value;
    }
    for (const name of ["FORK_TEAMS_DIR", "FORK_DB_HOST", "FORK_ROUTES_REQUIRE_AUTH"]) {
      previousEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    for (const directory of ["library", "saves", "state", "packages", "tournaments", "bug-reports", "tabletop", "log"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    const coaches = onboardedCoaches("LockCoach", "OtherCoach", "OrgCoach", "BossCoach") as Record<string, Record<string, unknown>>;
    coaches.orgcoach!.level = "organizer";
    coaches.bosscoach!.level = "admin";
    writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches }), "utf8");
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
    const team = (coach: string) => [{ teamId: `T-${coach}`, teamName: `${coach} XI`, race: "Human", coach }];
    writeFileSync(join(root, "library", "lockcoach.json"), JSON.stringify(team("LockCoach")), "utf8");
    writeFileSync(join(root, "library", "othercoach.json"), JSON.stringify(team("OtherCoach")), "utf8");
    ({ server } = await import("../src/server.js"));
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const coach of ["LockCoach", "OtherCoach", "OrgCoach", "BossCoach"]) tokens[coach] = createSession(coach, Date.now(), "discord").token;
    }, 120_000);

  afterEach(() => { delete process.env.FORK_ROUTES_REQUIRE_AUTH; });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const basic = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64")}`;
  const bearer = (coach: string): Record<string, string> => ({ authorization: `Bearer ${tokens[coach]}` });
  async function call(row: Row, headers: Record<string, string> = {}): Promise<{ status: number; error?: string; code?: string; body: unknown }> {
    const write = row.method !== "GET" && row.method !== "HEAD";
    const res = await fetch(`${origin}${row.path}`, {
      method: row.method,
      headers: { ...(write ? { "content-type": "application/json" } : {}), ...headers },
      ...(write ? { body: JSON.stringify(row.body ?? {}) } : {}),
    });
    const text = await res.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* JNLP / plain text */ }
    const rec = (body && typeof body === "object" ? body : {}) as { error?: unknown; code?: unknown };
    return {
      status: res.status,
      body,
      ...(typeof rec.error === "string" ? { error: rec.error } : {}),
      ...(typeof rec.code === "string" ? { code: rec.code } : {}),
    };
  }
  const lockOn = () => { process.env.FORK_ROUTES_REQUIRE_AUTH = "1"; };
  const label = (row: Row) => `${row.method} ${row.path.split("?")[0]}`;

  describe(`fork route lockdown (${mode})`, () => {
    describe("FORK_ROUTES_REQUIRE_AUTH on", () => {
      for (const row of LOCKED) {
        it(`${label(row)}: anonymous gets 401${row.path.includes("saves") ? "" : " sign_in_required"}`, async () => {
          lockOn();
          const r = await call(row);
          expect(r.status, JSON.stringify(r.body)).toBe(401);
          if (!row.path.includes("saves")) expect(r.code).toBe(SIGN_IN);
        });
        it(`${label(row)}: a signed-in coach passes the lockdown`, async () => {
          lockOn();
          const r = await call(row, bearer("LockCoach"));
          expect(r.code, JSON.stringify(r.body)).not.toBe(SIGN_IN);
          if (!row.path.includes("reload")) expect(r.status, JSON.stringify(r.body)).not.toBe(401);
        });
      }

      for (const row of OPEN) {
        it(`${label(row)}: stays open to anonymous callers`, async () => {
          lockOn();
          const r = await call(row);
          expect([401, 403], JSON.stringify(r.body)).not.toContain(r.status);
        });
      }

      for (const row of GAME_CREATION) {
        it(`${label(row)}: game creation is exempt (temporary): anonymous is not refused by the lockdown`, async () => {
          lockOn();
          const r = await call(row);
          expect(r.code).not.toBe(SIGN_IN);
          expect([401, 403], JSON.stringify(r.body)).not.toContain(r.status);
        });
      }

      it("library: a coach reads their own library, never another coach's", async () => {
        lockOn();
        const own = await call({ method: "GET", path: "/api/fork/library?coach=LockCoach" }, bearer("LockCoach"));
        expect(own.status).toBe(200);
        expect((own.body as { teams: Array<{ teamId: string }> }).teams.map((t) => t.teamId)).toEqual(["T-LockCoach"]);
        const ownByDefault = await call({ method: "GET", path: "/api/fork/library" }, bearer("LockCoach"));
        expect((ownByDefault.body as { teams: Array<{ teamId: string }> }).teams.map((t) => t.teamId)).toEqual(["T-LockCoach"]);
        const other = await call({ method: "GET", path: "/api/fork/library?coach=OtherCoach" }, bearer("LockCoach"));
        expect(other.status).toBe(403);
        expect(JSON.stringify(other.body)).not.toContain("T-OtherCoach");
        const caseFold = await call({ method: "GET", path: "/api/fork/library?coach=lockcoach" }, bearer("LockCoach"));
        expect(caseFold.status).toBe(200);
      });

      it("library: organisers, admins, the admin password and the service key may read any library", async () => {
        lockOn();
        const path = "/api/fork/library?coach=OtherCoach";
        for (const headers of [bearer("OrgCoach"), bearer("BossCoach"), { authorization: basic }, { "x-cw-service-key": SERVICE_KEY }]) {
          const r = await call({ method: "GET", path }, headers);
          expect(r.status, JSON.stringify(headers)).toBe(200);
          expect((r.body as { teams: Array<{ teamId: string }> }).teams.map((t) => t.teamId)).toEqual(["T-OtherCoach"]);
        }
      });

      it("a wrong service key is refused; the key never opens a write or a coach-scoped route", async () => {
        lockOn();
        expect((await call({ method: "GET", path: "/api/fork/library?coach=OtherCoach" }, { "x-cw-service-key": "wrong" })).status).toBe(401);
        expect((await call({ method: "GET", path: "/api/fork/records" }, { "x-cw-service-key": SERVICE_KEY })).code).not.toBe(SIGN_IN);
        expect((await call({ method: "GET", path: "/api/fork/coaches?q=x" }, { "x-cw-service-key": SERVICE_KEY })).code).not.toBe(SIGN_IN);
        for (const row of [LOCKED[1]!, LOCKED[2]!, LOCKED[4]!, LOCKED[5]!, LOCKED[9]!]) {
          expect((await call(row, { "x-cw-service-key": SERVICE_KEY })).status, label(row)).toBe(401);
        }
      });

      it("legacy body coach+password stays on my-games and build (verified in-handler; reaches the fork DB check)", async () => {
        lockOn();
        const myGames = await call({ method: "POST", path: "/api/fork/my-games", body: { coach: "LockCoach", password: "pw" } });
        expect(myGames.status, JSON.stringify(myGames.body)).toBe(503); // admitted to verification; no fork DB in tests
        expect(myGames.code).not.toBe(SIGN_IN);
        const build = await call({ method: "POST", path: "/api/fork/team-builder/build", body: { coach: "LockCoach", password: "pw" } });
        expect(build.code, JSON.stringify(build.body)).not.toBe(SIGN_IN);
        expect(build.status).not.toBe(401);
      });

      it("Tournament Builder: building and preview are open, saving is locked behind sign-in", async () => {
        lockOn();
        expect((await call({ method: "GET", path: "/api/fork/team-builder/tiers" })).status).toBe(200);
        expect((await call({ method: "GET", path: "/api/fork/team-builder/limits" })).status).toBe(200);
        expect((await call({ method: "POST", path: "/api/fork/team-builder/saves", body: { name: "x" } })).status).toBe(401);
        expect((await call({ method: "POST", path: "/api/fork/team-builder/build", body: { rosterId: "1", picks: [] } })).status).toBe(401);
        expect((await call({ method: "GET", path: "/api/fork/team-builder/saves" }, bearer("LockCoach"))).status).toBe(200);
      });
    });

    describe("admin-only and flag-independent fixes", () => {
      for (const flag of ["1", undefined]) {
        it(`reload is admin only (flag ${flag ?? "unset"}): coach and organiser 403, admin passes`, async () => {
          if (flag) process.env.FORK_ROUTES_REQUIRE_AUTH = flag;
          const row: Row = { method: "POST", path: "/api/fork/reload", body: {} };
          expect((await call(row)).status).toBe(401);
          expect((await call(row, bearer("LockCoach"))).status).toBe(403);
          expect((await call(row, bearer("OrgCoach"))).status).toBe(403);
          const admin = await call(row, bearer("BossCoach"));
          expect(admin.status, JSON.stringify(admin.body)).toBe(503); // passed the gate; no teams dir in tests
          const basicAdmin = await call(row, { authorization: basic });
          expect(basicAdmin.status, JSON.stringify(basicAdmin.body)).toBe(503);
        });
      }
    });

    describe("FORK_ROUTES_REQUIRE_AUTH unset (the production default): behaviour unchanged", () => {
      it("library, coaches and records stay public; another coach's library is still readable", async () => {
        const lib = await call({ method: "GET", path: "/api/fork/library?coach=OtherCoach" });
        expect(lib.status).toBe(200);
        expect((await call({ method: "GET", path: "/api/fork/coaches?q=x" })).status).toBe(503); // handler: no fork DB
        expect((await call({ method: "GET", path: "/api/fork/records" })).status).toBe(502); // handler: no fork admin API
        expect((await call({ method: "POST", path: "/api/fork/library/ingest", body: {} })).status).toBe(401); // already gated
      });

      it("explicit off values keep the routes open", async () => {
        for (const value of ["0", "false", "off", "no", ""]) {
          process.env.FORK_ROUTES_REQUIRE_AUTH = value;
          expect((await call({ method: "GET", path: "/api/fork/library?coach=OtherCoach" })).status, value).toBe(200);
        }
      });

      for (const row of GAME_CREATION) {
        it(`${label(row)}: game creation unchanged`, async () => {
          const r = await call(row);
          expect([401, 403], JSON.stringify(r.body)).not.toContain(r.status);
        });
      }
    });
  });
}
