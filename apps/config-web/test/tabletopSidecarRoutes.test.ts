import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { createSession } from "./onboardedFixture.js";
import { createSave } from "../src/teamBuilderSaves.js";

// The tabletop spectator view with the auth sidecar ON (review P2 #3): the outer session gate lets the exact match
// GET through, the handler decides the role, every other tabletop route still needs a session. Also the per-IP /
// per-session rate limit on match views (review P2 #2).
const root = mkdtempSync(join(tmpdir(), "tabletop-sidecar-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const saveIds: Record<string, string> = {};

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
    TABLETOP_DIR: join(root, "tabletop"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "packages", "tournaments", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  for (const coach of ["ScAlice", "ScBob"]) {
    const made = createSave({ dir: join(root, "saves"), raceNameFor: () => "Orc" }, coach, {
      name: `${coach} XI`, body: { rosterId: "orc", picks: [{ positionId: "lineman", count: 3 }] },
    });
    if (!made.ok) throw new Error(made.error);
    saveIds[coach] = made.save.id;
  }
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;
const call = (method: string, path: string, who?: string, body?: unknown) =>
  fetch(`${origin}${path}`, {
    method, redirect: "manual",
    headers: { ...(who ? { cookie: cookie(who) } : {}), "content-type": "application/json", ...(method === "POST" ? { "x-cw-auth": "1" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });

describe("tabletop spectator view (sidecar on)", () => {
  let id = "";
  it("an anonymous visitor reads a match as a spectator; every other tabletop route still needs a session", async () => {
    const created = await call("POST", "/api/tabletop/matches", "ScAlice", {
      pregame: "skip", home: { coach: "ScAlice", teamSaveId: saveIds.ScAlice }, away: { coach: "ScBob", teamSaveId: saveIds.ScBob }, postMatch: "none",
    });
    expect(created.status).toBe(201);
    id = ((await created.json()) as { match: { id: string } }).match.id;
    const anon = await call("GET", `/api/tabletop/matches/${id}`);
    expect(anon.status).toBe(200);
    const body = (await anon.json()) as { role: string; match: { home: { coach: string; teamSaveId?: string } } };
    expect(body.role).toBe("spectator");
    expect(body.match.home.teamSaveId).toBeUndefined();
    expect((await call("GET", `/api/tabletop/matches/${id}`, "ScMallory")).status).toBe(200);
    // the gate opens the exact view only
    expect((await call("POST", `/api/tabletop/matches/${id}/events`, undefined, { events: [] })).status).toBe(401);
    expect((await call("GET", "/api/tabletop/matches")).status).toBe(401);
    expect((await call("GET", "/api/tabletop/fixtures")).status).toBe(401);
    expect((await call("POST", `/api/tabletop/matches/${id}/events`, "ScMallory", { events: [] })).status).toBe(403);
    // the SPA page itself is public too
    expect((await call("GET", `/app/tabletop/${id}`)).status).not.toBe(302);
  });

  it("match views are rate limited per IP (anonymous): 60 a minute, then 429 with retry-after", async () => {
    let last: Response | undefined;
    for (let i = 0; i < 70; i += 1) {
      last = await call("GET", `/api/tabletop/matches/${id}`);
      if (last.status === 429) break;
      expect(last.status).toBe(200);
    }
    expect(last!.status).toBe(429);
    expect(Number(last!.headers.get("retry-after"))).toBeGreaterThan(0);
    // a signed-in coach has a bucket of their own
    expect((await call("GET", `/api/tabletop/matches/${id}`, "ScAlice")).status).toBe(200);
  });
});
