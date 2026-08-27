import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";

const root = mkdtempSync(join(tmpdir(), "server-organizer-gate-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  mkdirSync(join(root, "library"), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({
    version: 1,
    coaches: {
      organizercoach: {
        ffbCoachId: "OrganizerCoach",
        level: "organizer",
        banned: false,
        silenced: false,
        note: "",
        profile: {},
        identities: {},
        updatedAt: "2026-08-27T00:00:00.000Z",
        updatedBy: "RootAdmin",
      },
    },
  }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");

  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("POST /api/team/setResurrection organizer gate", () => {
  it("returns 401 without a session and 403 for a non-organizer coach session", async () => {
    const body = JSON.stringify({ teamId: "42", resurrection: true });
    const unauthenticated = await fetch(`${origin}/api/team/setResurrection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(unauthenticated.status).toBe(401);

    const { token } = createSession("PlainCoach");
    const coach = await fetch(`${origin}/api/team/setResurrection`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
    });
    expect(coach.status).toBe(403);
    expect(await coach.json()).toEqual({ error: "Organizer access required." });
  });
});

describe("NAF identity HTTP gates", () => {
  it("allows an organizer on the NAF route and keeps the full identity route admin-only", async () => {
    const { token } = createSession("OrganizerCoach");
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const nafResponse = await fetch(`${origin}/api/admin/identities/naf`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ffbCoachId: "TargetCoach", nafName: "Target NAF", nafId: "12345" }),
    });
    expect(nafResponse.status).toBe(200);
    expect(await nafResponse.json()).toMatchObject({
      ok: true,
      coach: {
        ffbCoachId: "TargetCoach",
        identities: { nafName: "Target NAF", nafId: "12345" },
        updatedBy: "OrganizerCoach",
      },
    });

    const forbiddenIdentityResponse = await fetch(`${origin}/api/admin/identities/naf`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ffbCoachId: "TargetCoach", email: "attacker@example.test" }),
    });
    expect(forbiddenIdentityResponse.status).toBe(400);
    expect(await forbiddenIdentityResponse.json()).toEqual({
      error: "email is not editable through the organizer NAF identity route.",
    });

    const fullEditorResponse = await fetch(`${origin}/api/admin/identities`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ffbCoachId: "TargetCoach", identities: { nafName: "Blocked" } }),
    });
    expect(fullEditorResponse.status).toBe(403);
  });

  it("rejects a plain coach on the NAF route", async () => {
    const { token } = createSession("PlainCoach");
    const response = await fetch(`${origin}/api/admin/identities/naf`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ffbCoachId: "TargetCoach", nafName: "Blocked" }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Organizer access required." });
  });

  it("rejects SSO-owned identities through PATCH /api/account", async () => {
    const { token } = createSession("PlainCoach");
    const response = await fetch(`${origin}/api/account`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ identities: { email: "attacker@example.test" } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "identities.email is not editable through /api/account.",
    });
  });
});
