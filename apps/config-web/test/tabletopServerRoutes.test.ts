import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { createSave } from "../src/teamBuilderSaves.js";

// Route wiring in the live host's mode (sidecar OFF): Discord session only, CSRF header on writes, temp dirs, port 0.
const root = mkdtempSync(join(tmpdir(), "tabletop-routes-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const saveIds: Record<string, string> = {};

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
    TABLETOP_DIR: join(root, "tabletop"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_ADMIN_PASSWORD: "",
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "packages", "tournaments", "state", "teams", "saves"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  for (const coach of ["TtAlice", "TtBob"]) {
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

const cookie = (coach: string, method = "discord") => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), method as "discord").token}`;
const call = (method: string, path: string, who?: string, body?: unknown, csrf = true) =>
  fetch(`${origin}${path}`, {
    method,
    headers: { ...(who ? { cookie: cookie(who) } : {}), "content-type": "application/json", ...(csrf && method === "POST" ? { "x-cw-auth": "1" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  });
const create = (who: string) => call("POST", "/api/tabletop/matches", who, {
  home: { coach: "TtAlice", teamSaveId: saveIds.TtAlice }, away: { coach: "TtBob", teamSaveId: saveIds.TtBob }, postMatch: "full",
});

describe("tabletop routes (sidecar off)", () => {
  it("401 anonymous (JSON, no Basic challenge)", async () => {
    const res = await call("GET", "/api/tabletop/matches/tm_whatever");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect((await call("POST", "/api/tabletop/matches", undefined, {})).status).toBe(401);
  });
  it("403 without X-CW-Auth on a write", async () => {
    expect((await call("POST", "/api/tabletop/matches", "TtAlice", {}, false)).status).toBe(403);
  });
  it("participant creates and records; a non-participant gets 403", async () => {
    const created = await create("TtAlice");
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { match: { id: string } }).match.id;
    expect((await call("GET", `/api/tabletop/matches/${id}`, "TtMallory")).status).toBe(403);
    expect((await call("POST", `/api/tabletop/matches/${id}/events`, "TtMallory", { events: [] })).status).toBe(403);
    const ok = await call("POST", `/api/tabletop/matches/${id}/events`, "TtBob", {
      events: [{ id: "evt-route-0001", type: "touchdown", team: "away", player: "lineman-1" }],
    });
    expect(ok.status).toBe(200);
    const got = (await (await call("GET", `/api/tabletop/matches/${id}`, "TtAlice")).json()) as { events: Array<{ by: string }>; teams: { home: { players: unknown[] } } };
    expect(got.events[0]!.by).toBe("TtBob");
    expect(got.teams.home.players).toHaveLength(3);
  });
});

describe("public standings route", () => {
  it("answers without a session, is rate limited per IP, and keeps tabletop writes gated", async () => {
    const res = await call("GET", "/api/standings?league=Nope");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ league: "Nope", rows: [] });
    expect((await call("POST", "/api/tabletop/matches", undefined, {})).status).toBe(401);
    let limited = 0;
    for (let i = 0; i < 70; i += 1) if ((await call("GET", "/api/standings?league=Nope")).status === 429) limited += 1;
    expect(limited).toBeGreaterThan(0);
  });
});
