// Shared HTTP checks for POST /api/bug-reports/status (owner 11-04), run against the real server on both gate paths:
// the session gate (AUTH_SIDECAR_ENABLED=1, src/auth/requireSession.ts) and the sidecar-off authorized() path.
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { onboardedCoaches } from "./onboardedFixture.js";

export function bugReportStatusSuite(label: string, sidecar: boolean): void {
  const root = mkdtempSync(join(tmpdir(), `bug-status-${sidecar ? "on" : "off"}-`));
  const previousEnv = new Map<string, string | undefined>();
  let origin = "";
  let server: (typeof import("../src/server.js"))["server"];
  let ipSeq = 0;
  const freshIp = () => `203.0.113.${(ipSeq += 1)}`;

  beforeAll(async () => {
    for (const [name, value] of Object.entries({
      AUTH_SIDECAR_ENABLED: sidecar ? "1" : "",
      ADMIN_PASSWORD: "admin-secret",
      HOST: "127.0.0.1",
      PORT: "0",
      IDENTITIES_FILE: join(root, "identities.json"),
      ORGANIZERS_FILE: join(root, "organizers.json"),
      SESSIONS_FILE: join(root, "sessions.json"),
      FORK_LIBRARY_DIR: join(root, "library"),
      FORK_BUILDER_SAVES_DIR: join(root, "saves"),
      FORK_STATE_DIR: join(root, "state"),
      FORK_TEAMS_DIR: join(root, "teams"),
      FORK_DB_HOST: "127.0.0.1",
      FORK_DB_PORT: "1",
      PACKAGES_DIR: join(root, "packages"),
      TOURNAMENTS_DIR: join(root, "tournaments"),
      BUG_REPORTS_DIR: join(root, "bug-reports"),
      TABLETOP_DIR: join(root, "tabletop"),
      TEAM_AVATARS_DIR: join(root, "team-avatars"),
      COACH_AVATARS_DIR: join(root, "coach-avatars"),
      COACH_REGISTRY_JSON: join(root, "coach-registry.json"),
      CONFIG_WEB_LOG_DIR: join(root, "log"),
      BUILD_LOG_FILE: join(root, "build-log.json"),
      CORS_ALLOWED_ORIGINS: "",
      FORK_ADMIN_PASSWORD: "",
      SUPER_ENABLED: "",
    })) {
      previousEnv.set(name, process.env[name]);
      if (value === "") delete process.env[name]; else process.env[name] = value;
    }
    for (const directory of ["library", "saves", "state", "teams", "packages", "tournaments", "bug-reports", "tabletop", "log"]) {
      mkdirSync(join(root, directory), { recursive: true });
    }
    writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("StatusCoach") }), "utf8");
    writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
    ({ server } = await import("../src/server.js"));
    if (!server.listening) await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 120_000);

  afterAll(async () => {
    if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [name, value] of previousEnv) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": freshIp(), ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  async function fileReport(description = "Ball vanished after a blitz."): Promise<{ id: string; receipt: string }> {
    const res = await post("/api/bug-reports", { publicEdition: true, coach: "Kildash", description });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; id: string; receipt: string };
    expect(Object.keys(body).sort()).toEqual(["id", "ok", "receipt"]);
    return body;
  }

  describe(`POST /api/bug-reports/status over HTTP (${label})`, () => {
    it("create returns { id, receipt }; an anonymous status check answers only the matching entry's public fields", async () => {
      const mine = await fileReport();
      const other = await fileReport("Another player's report.");
      const res = await post("/api/bug-reports/status", {
        reports: [mine, { id: other.id, receipt: mine.receipt }, { id: "2020-01-01T00-00-00-000Z_x_nogame", receipt: mine.receipt }],
      });
      expect(res.status).toBe(200);
      const body = await res.json() as { reports: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(["reports"]);
      expect(body.reports).toHaveLength(1);
      expect(Object.keys(body.reports[0]!).sort()).toEqual(["fixedIn", "id", "reply", "replyAt", "status", "updatedAt"]);
      expect(body.reports[0]).toMatchObject({ id: mine.id, status: "received", reply: null, fixedIn: null });
      expect(JSON.stringify({ ...body.reports[0], id: "" })).not.toMatch(/Ball vanished|Kildash|receiptHash/); // the id is the reporter's own
    });

    it("a bad shape or more than 50 entries is 400; an oversize body is 413", async () => {
      const entry = { id: "x", receipt: "y" };
      expect((await post("/api/bug-reports/status", { reports: Array(50).fill(entry) })).status).toBe(200);
      expect((await post("/api/bug-reports/status", { reports: Array(51).fill(entry) })).status).toBe(400);
      expect((await post("/api/bug-reports/status", { reports: "nope" })).status).toBe(400);
      expect((await post("/api/bug-reports/status", "{not json")).status).toBe(400);
      expect((await post("/api/bug-reports/status", { reports: [], pad: "x".repeat(20 * 1024) })).status).toBe(413);
    });

    it("rate limits at 30 an hour per IP with Retry-After; another IP is unaffected", async () => {
      const ip = "198.51.100.77";
      for (let n = 0; n < 30; n += 1)
        expect((await post("/api/bug-reports/status", { reports: [] }, { "x-forwarded-for": ip })).status).toBe(200);
      const limited = await post("/api/bug-reports/status", { reports: [] }, { "x-forwarded-for": ip });
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await post("/api/bug-reports/status", { reports: [] })).status).toBe(200);
    });

    it("CORS: the client origin (and the tauri origins) pass, preflight included; a foreign origin is refused", async () => {
      for (const o of ["http://sfapp.localhost", "sfapp://localhost", "http://tauri.localhost", "tauri://localhost"]) {
        const preflight = await fetch(`${origin}/api/bug-reports/status`, {
          method: "OPTIONS",
          headers: { origin: o, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(o);
        expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
        expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
        const res = await post("/api/bug-reports/status", { reports: [] }, { origin: o });
        expect(res.status).toBe(200);
        expect(res.headers.get("access-control-allow-origin")).toBe(o);
      }
      const foreign = await post("/api/bug-reports/status", { reports: [] }, { origin: "https://evil.example.com" });
      expect(foreign.status).toBe(403);
      const foreignPreflight = await fetch(`${origin}/api/bug-reports/status`, { method: "OPTIONS", headers: { origin: "https://evil.example.com" } });
      expect(foreignPreflight.status).toBe(403);
    });
  });
}
