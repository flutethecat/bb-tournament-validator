import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  mkdirSync(join(root, "library"), { recursive: true });
  mkdirSync(join(root, "teams"), { recursive: true });
  mkdirSync(join(root, "log"), { recursive: true });
  // Trip reloadFork's busy guard so this test never kills or spawns the fork process.
  writeFileSync(join(root, "log", "default.log"), "");
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
      admincoach: {
        ffbCoachId: "AdminCoach",
        level: "admin",
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
  writeFileSync(join(root, "library", "tarkin.json"), JSON.stringify([
    { teamId: "120", teamName: "Storm Lords", race: "Human", coach: "Tarkin", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-01T00:00:00.000Z" },
    { teamId: "121", teamName: "Desert Storm", race: "Orc", coach: "Tarkin", teamValue: 1000, gold: 0, forkLoadable: false, ingestedAt: "2026-08-02T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(join(root, "library", "plaincoach.json"), JSON.stringify([
    { teamId: "122", teamName: "Plain Owners", race: "Human", coach: "PlainCoach", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-03T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(join(root, "library", "organizercoach.json"), JSON.stringify([
    { teamId: "123", teamName: "Organizer Owners", race: "Human", coach: "OrganizerCoach", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-04T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(
    join(root, "teams", "team_Tarkin_120.xml"),
    '<team id="120"><coach>Tarkin</coach><name>Storm Lords</name></team>',
    "utf8",
  );
  writeFileSync(join(root, "teams", "team_PlainCoach_122.xml"), '<team id="122"><coach>PlainCoach</coach><name>Plain Owners</name><player id="plain-player"><skillList/><injuryList/></player></team>', "utf8");
  writeFileSync(join(root, "teams", "team_OrganizerCoach_123.xml"), '<team id="123"><coach>OrganizerCoach</coach><name>Organizer Owners</name><player id="organizer-player"><skillList/><injuryList/></player></team>', "utf8");

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

  it("allows an organizer to set resurrection cross-team without relaxing other cross-team mutations", async () => {
    const organizer = createSession("OrganizerCoach");
    const headers = { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" };
    const refundBody = JSON.stringify({ teamId: "120", playerId: "p1" });
    const forbidden = await fetch(`${origin}/api/team/refundPlayer`, {
      method: "POST",
      headers,
      body: refundBody,
    });
    expect(forbidden.status).toBe(404);
    expect(await forbidden.json()).toEqual({ error: "Team not found." });

    const plain = createSession("PlainCoach");
    const plainForbidden = await fetch(`${origin}/api/team/refundPlayer`, {
      method: "POST",
      headers: { authorization: `Bearer ${plain.token}`, "content-type": "application/json" },
      body: refundBody,
    });
    expect(plainForbidden.status).toBe(404);
    expect(await plainForbidden.json()).toEqual({ error: "Team not found." });

    const allowed = await fetch(`${origin}/api/team/setResurrection`, {
      method: "POST",
      headers,
      body: JSON.stringify({ teamId: "120", resurrection: true }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ ok: true, teamId: "120", reload: { reloaded: false } });
    expect(readFileSync(join(root, "teams", "team_Tarkin_120.xml"), "utf8"))
      .toContain('resurrection="true"');
  });
});

describe("admin-only player correction HTTP gates", () => {
  const operations = [
    ["player/addSkill", { skill: "Block" }],
    ["player/removeSkill", { skill: "Block" }],
    ["player/addInjury", { injury: "Seriously Hurt (MNG)", recovering: true }],
    ["player/removeInjury", { injury: "Seriously Hurt (MNG)" }],
    ["player/setStatModifier", { stat: "MA", modifier: 1 }],
  ] as const;

  it.each(operations)("rejects a plain coach on their own team for %s", async (operation, patch) => {
    const coach = createSession("PlainCoach");
    const response = await fetch(`${origin}/api/team/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${coach.token}`, "content-type": "application/json" },
      body: JSON.stringify({ teamId: "122", playerId: "plain-player", ...patch }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admin access required." });
  });

  it.each(operations)("rejects an organizer on their own team for %s", async (operation, patch) => {
    const organizer = createSession("OrganizerCoach");
    const response = await fetch(`${origin}/api/team/${operation}`, {
      method: "POST",
      headers: { authorization: `Bearer ${organizer.token}`, "content-type": "application/json" },
      body: JSON.stringify({ teamId: "123", playerId: "organizer-player", ...patch }),
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Admin access required." });
  });
});

describe("admin team search HTTP gate", () => {
  it("rejects unauthenticated and plain-coach sessions, then returns ranked rows to an admin", async () => {
    const path = `${origin}/api/admin/teams/search?q=storm&mode=name`;
    expect((await fetch(path)).status).toBe(401);

    const plain = createSession("PlainCoach");
    const forbidden = await fetch(path, { headers: { authorization: `Bearer ${plain.token}` } });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Admin access required." });

    const organizer = createSession("OrganizerCoach");
    const organizerForbidden = await fetch(path, { headers: { authorization: `Bearer ${organizer.token}` } });
    expect(organizerForbidden.status).toBe(403);
    expect(await organizerForbidden.json()).toEqual({ error: "Admin access required." });

    const admin = createSession("AdminCoach");
    const allowed = await fetch(path, { headers: { authorization: `Bearer ${admin.token}` } });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual([
      { teamId: "120", name: "Storm Lords", coach: "Tarkin", roster: "Human", status: "loaded" },
      { teamId: "121", name: "Desert Storm", coach: "Tarkin", roster: "Orc", status: "not loaded" },
    ]);
  });
});

describe("control-panel landing", () => {
  it("serves the hub at /, /index.html, and its direct URL while keeping the rules editor direct", async () => {
    for (const path of ["/", "/index.html", "/control-panel.html"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Choose a workspace");
    }
    const rules = await fetch(`${origin}/tournament-rules.html`);
    expect(rules.status).toBe(200);
    expect(await rules.text()).toContain("Tournament Rules");
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
