import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "./onboardedFixture.js";
import { createSession as createRawSession } from "../src/auth/session.js";

// Tournament Series routes wired into the real server with the legacy password gate on: reads are public (no Basic
// prompt), writes need a session, the X-CW-Auth CSRF header, onboarding (428) and the organiser rules.

const root = mkdtempSync(join(tmpdir(), "series-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let organiserCookie = "";
let coachCookie = "";
let newcomerCookie = "";

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    HOST: "127.0.0.1", PORT: "0", AUTH_SIDECAR_ENABLED: "",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    SESSIONS_FILE: join(root, "sessions.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    TEAM_AVATARS_DIR: join(root, "avatars"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    ADMIN_PASSWORD: "pw-series-test", FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "saves", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: ["Veers", "Newbie"] }), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  organiserCookie = `cw_session=${createSession("Veers", Date.now(), "discord").token}`;
  coachCookie = `cw_session=${createSession("Needa", Date.now(), "discord").token}`;
  // An organiser who has not accepted the privacy notice yet: every write answers 428.
  newcomerCookie = `cw_session=${createRawSession("Newbie", Date.now(), "discord").token}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown, headers: Record<string, string>) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const create = { name: "Valley Series", scoring: "bestN", bestN: 2, seeding: "elo" };

describe("series routes over HTTP", () => {
  it("reads are public with the password gate on", async () => {
    const list = await fetch(`${origin}/api/series`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ series: [] });
    expect((await fetch(`${origin}/api/series/nope`)).status).toBe(404);
  });

  it("create: anonymous 401, no CSRF header 403, not onboarded 428, plain coach 403, organiser 201; then PATCH and DELETE", async () => {
    expect((await post("/api/series", create, {})).status).toBe(401);
    expect((await post("/api/series", create, { cookie: organiserCookie })).status).toBe(403);
    const gated = await post("/api/series", create, { cookie: newcomerCookie, "x-cw-auth": "1" });
    expect(gated.status).toBe(428);
    expect(await gated.json()).toMatchObject({ onboarding: true });
    expect((await post("/api/series", create, { cookie: coachCookie, "x-cw-auth": "1" })).status).toBe(403);
    const made = await post("/api/series", create, { cookie: organiserCookie, "x-cw-auth": "1" });
    expect(made.status).toBe(201);
    const { series } = (await made.json()) as { series: { id: string; organisers: string[]; revision: number } };
    expect(series).toMatchObject({ organisers: ["Veers"], revision: 1 });

    const read = await fetch(`${origin}/api/series/${series.id}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ series: { name: "Valley Series", canEdit: false }, standings: { scoring: "bestN", bestN: 2, rows: [] } });

    const patch = (headers: Record<string, string>, body: unknown) =>
      fetch(`${origin}/api/series/${series.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: organiserCookie, ...headers }, body: JSON.stringify(body) });
    expect((await patch({}, { revision: 1, name: "X" })).status).toBe(403); // CSRF
    expect((await patch({ "x-cw-auth": "1" }, { name: "X" })).status).toBe(428); // no revision
    expect((await patch({ "x-cw-auth": "1", "if-match": '"1"' }, { name: "Valley Cup" })).status).toBe(200);
    const other = await fetch(`${origin}/api/series/${series.id}`, { method: "PATCH", headers: { "content-type": "application/json", cookie: coachCookie, "x-cw-auth": "1" }, body: JSON.stringify({ revision: 2, name: "Mine" }) });
    expect(other.status).toBe(403);
    const del = await fetch(`${origin}/api/series/${series.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie: organiserCookie, "x-cw-auth": "1" }, body: JSON.stringify({ revision: 2 }) });
    expect(del.status).toBe(200);
    expect((await fetch(`${origin}/api/series/${series.id}`)).status).toBe(404);
  });
});
