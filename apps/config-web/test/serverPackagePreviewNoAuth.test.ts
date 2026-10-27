import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Sol r3 (10-27): POST /api/packages/preview is organiser-only whatever the configuration — no auth configured (sidecar off, no ADMIN_PASSWORD).
const root = mkdtempSync(join(tmpdir(), "preview-gate-noauth-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "",
    ADMIN_PASSWORD: "",
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
  for (const directory of ["library", "packages", "tournaments", "state", "saves"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const body = JSON.stringify({ name: "Gate", skillAllotment: { skillPointBudget: 0 } });
const post = (headers: Record<string, string> = {}) =>
  fetch(`${origin}/api/packages/preview`, { method: "POST", headers: { "content-type": "application/json", "x-cw-auth": "1", ...headers }, body });

describe("preview gate — no auth mode configured", () => {
  it("refuses with 503 instead of opening up", async () => {
    const response = await post();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Organiser auth is not configured on this server." });
  });
});

describe("save gate — no auth mode configured", () => {
  it("POST /api/packages and ?replace refuse with the same 503 and write nothing", async () => {
    for (const url of ["/api/packages", "/api/packages?replace=Gate"]) {
      const response = await fetch(`${origin}${url}`, { method: "POST", headers: { "content-type": "application/json", "x-cw-auth": "1" }, body });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "Organiser auth is not configured on this server." });
    }
    expect(readdirSync(join(root, "packages"))).toEqual([]);
  });
});
