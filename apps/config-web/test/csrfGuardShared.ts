// Shared CSRF-guard suite (src/auth/csrf.ts), run once per gate path: csrfGuardSidecar.test.ts (AUTH_SIDECAR on, the live
// :4310 session gate) and csrfGuardSidecarOff.test.ts (ADMIN_PASSWORD mode). Every cookie-ridden state change needs
// X-CW-Auth; Bearer, Basic-only and the signed mail links never do.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";

const CSRF_ERROR = "Missing required X-CW-Auth header.";
const ADMIN_PASSWORD = "admin-secret";

/** One route per family Sol 6.1 listed (11-01), plus the legacy state-changing GETs. */
export const WRITE_ROUTES: Array<[string, string]> = [
  ["POST", "/api/tournaments"],
  ["POST", "/api/tournaments/T1/unlock-rosters"],
  ["PATCH", "/api/tournaments/T1"],
  ["POST", "/api/fork/tournaments"],
  ["POST", "/api/fork/tournaments/T1/entrants"],
  ["POST", "/api/scheduled-matches/S1/presence"],
  ["DELETE", "/api/scheduled-matches/S1/presence"],
  ["POST", "/api/team/renumber"],
  ["POST", "/api/teams/120/advancement"],
  ["POST", "/api/fork/library/ingest"],
  ["POST", "/api/fork/library/retire"],
  ["POST", "/api/fork/team-builder/build"],
  ["POST", "/api/fork/reload"],
  ["POST", "/api/admin/identities"],
  ["POST", "/api/admin/identities/merge"],
  ["POST", "/api/bug-reports"],
  ["POST", "/api/translate"],
  ["POST", "/api/leagues/L1/seasons/S1/fixtures/F1/lobby/chat"],
];

export const GET_MUTATIONS: string[] = [
  "/api/fork/register?coach=CsrfCoach&passwordMd5=" + "a".repeat(32),
  "/api/fork/cancel?coach=CsrfCoach",
  "/api/fork/matchstatus?coach=CsrfCoach",
  "/api/fork/challenge?coach=CsrfCoach&teamId=120&opponent=Other",
  "/api/fork/match/g1/result",
];

export function defineCsrfSuite(mode: "sidecar" | "sidecar-off"): void {
  const root = mkdtempSync(join(tmpdir(), `csrf-guard-${mode}-`));
  const previousEnv = new Map<string, string | undefined>();
  let origin = "";
  let server: (typeof import("../src/server.js"))["server"];
  let token = "";

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      AUTH_SIDECAR_ENABLED: mode === "sidecar" ? "1" : "",
      ADMIN_PASSWORD,
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
    for (const name of ["FORK_TEAMS_DIR", "FORK_DB_HOST"]) {
      previousEnv.set(name, process.env[name]);
      delete process.env[name];
    }
    for (const directory of ["library", "saves", "state", "packages", "tournaments", "bug-reports", "tabletop", "log"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("CsrfCoach") }), "utf8");
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
    ({ server } = await import("../src/server.js"));
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    token = createSession("CsrfCoach", Date.now(), "discord").token;
  });

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const cookie = () => `${SESSION_COOKIE_NAME}=${token}`;
  const basic = `Basic ${Buffer.from(`admin:${ADMIN_PASSWORD}`).toString("base64")}`;
  async function call(method: string, path: string, headers: Record<string, string>): Promise<{ status: number; error?: string }> {
    const write = method !== "GET" && method !== "HEAD";
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { ...(write ? { "content-type": "application/json" } : {}), ...headers },
      ...(write ? { body: "{}" } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return { status: res.status, ...(typeof body.error === "string" ? { error: body.error } : {}) };
  }
  const refusedByCsrf = (r: { status: number; error?: string }) => r.status === 403 && r.error === CSRF_ERROR;

  describe(`CSRF guard (${mode})`, () => {
    for (const [method, path] of WRITE_ROUTES) {
      it(`${method} ${path}: cookie without X-CW-Auth 403; with the header or Bearer it passes the guard`, async () => {
        expect(refusedByCsrf(await call(method, path, { cookie: cookie() })), "cookie, no header").toBe(true);
        expect(refusedByCsrf(await call(method, path, { cookie: cookie(), "x-cw-auth": "1" })), "cookie + header").toBe(false);
        expect(refusedByCsrf(await call(method, path, { authorization: `Bearer ${token}` })), "Bearer").toBe(false);
      });
    }

    for (const path of GET_MUTATIONS) {
      it(`GET ${path.split("?")[0]}: cookie without X-CW-Auth 403; header, Bearer and anonymous pass the guard`, async () => {
        expect(refusedByCsrf(await call("GET", path, { cookie: cookie() })), "cookie, no header").toBe(true);
        expect(refusedByCsrf(await call("GET", path, { cookie: cookie(), "x-cw-auth": "1" })), "cookie + header").toBe(false);
        expect(refusedByCsrf(await call("GET", path, { authorization: `Bearer ${token}` })), "Bearer").toBe(false);
        expect(refusedByCsrf(await call("GET", path, {})), "anonymous").toBe(false);
      });
    }

    it("Sol's repro: an allowed app Origin with a cookie and no header cannot unlock rosters", async () => {
      expect(refusedByCsrf(await call("POST", "/api/tournaments/T1/unlock-rosters", { cookie: cookie(), origin: "http://tauri.localhost" }))).toBe(true);
    });

    it("a newly added /api write route is covered by default (no route list to forget)", async () => {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        expect(refusedByCsrf(await call(method, "/api/zz-route-added-later/x", { cookie: cookie() })), method).toBe(true);
        expect(refusedByCsrf(await call(method, "/api/zz-route-added-later/x", { cookie: cookie(), "x-cw-auth": "1" })), method).toBe(false);
      }
    });

    it("plain reads with a cookie need no header", async () => {
      expect(refusedByCsrf(await call("GET", "/api/account", { cookie: cookie() }))).toBe(false);
      expect(refusedByCsrf(await call("GET", "/api/fork/library?coach=CsrfCoach", { cookie: cookie() }))).toBe(false);
    });

    it("a stale cookie is not a session: no header needed (the handler sees an anonymous caller)", async () => {
      expect(refusedByCsrf(await call("POST", "/api/tournaments/T1/unlock-rosters", { cookie: `${SESSION_COOKIE_NAME}=${"0".repeat(64)}` }))).toBe(false);
    });

    it("Basic + a live cookie still needs the header (the browser attaches both on its own)", async () => {
      expect(refusedByCsrf(await call("POST", "/api/fork/reload", { cookie: cookie(), authorization: basic }))).toBe(true);
    });

    it("signed mail links stay exempt even with a cookie riding along", async () => {
      expect(refusedByCsrf(await call("POST", "/api/mail/unsubscribe?token=x", { cookie: cookie() }))).toBe(false);
      expect(refusedByCsrf(await call("POST", "/api/mail/postmark/webhook", { cookie: cookie() }))).toBe(false);
    });

    it("the Discord sign-up pending cookie counts as an ambient credential on /api/auth/discord/complete", async () => {
      expect(refusedByCsrf(await call("POST", "/api/auth/discord/complete", { cookie: "discord_sso_pending=abc" }))).toBe(true);
      expect(refusedByCsrf(await call("POST", "/api/auth/discord/complete", { cookie: "discord_sso_pending=abc", "x-cw-auth": "1" }))).toBe(false);
    });

    if (mode === "sidecar-off") {
      it("Basic admin password without a cookie is exempt (not an ambient session)", async () => {
        expect(refusedByCsrf(await call("POST", "/api/fork/reload", { authorization: basic }))).toBe(false);
        expect(refusedByCsrf(await call("GET", "/api/fork/match/g1/result", { authorization: basic }))).toBe(false);
      });
    }
  });
}
