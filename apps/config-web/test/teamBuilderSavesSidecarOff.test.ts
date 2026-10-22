import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// Sidecar-OFF (the live ADMIN_PASSWORD host mode): saves must bypass the legacy Basic gate and be
// enforced by the coach session in-handler, with JSON 401s and the cookie CSRF header.
const root = mkdtempSync(join(tmpdir(), "team-builder-saves-off-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

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
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const directory of ["library", "packages", "tournaments", "state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
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

const body = { name: "Off XI", body: { rosterId: "dwarf.bb2025", teamName: "Off XI", picks: [] } };

describe("team-builder saves with the auth sidecar off", () => {
  it("answers JSON 401 (not a Basic challenge) without a session", async () => {
    for (const path of ["/api/fork/team-builder/saves", "/api/fork/team-builder/saves/sv_x"]) {
      const res = await fetch(`${origin}${path}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBeNull();
    }
  });

  it("serves the session coach via Bearer, and requires X-CW-Auth for cookie writes", async () => {
    const s = createSession("OffCoach");
    const created = await fetch(`${origin}/api/fork/team-builder/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
      body: JSON.stringify(body),
    });
    expect(created.status).toBe(201);
    const list = await fetch(`${origin}/api/fork/team-builder/saves`, { headers: { authorization: `Bearer ${s.token}` } });
    expect(((await list.json()) as { saves: unknown[] }).saves).toHaveLength(1);
    const cookie = `${SESSION_COOKIE_NAME}=${s.token}`;
    const csrf = await fetch(`${origin}/api/fork/team-builder/saves`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    expect(csrf.status).toBe(403);
  });
});
