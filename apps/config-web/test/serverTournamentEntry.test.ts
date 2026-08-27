import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";

const root = mkdtempSync(join(tmpdir(), "server-tournament-entry-"));
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
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "packages", "tournaments", "log"])
    mkdirSync(join(root, directory), { recursive: true });
  // Trip reloadFork's busy guard so this suite cannot stop or spawn a live fork.
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "packages", "http-rules.json"), JSON.stringify({
    name: "HTTP Rules",
    ruleset: "bb2025-default",
  }), "utf8");
  writeFileSync(join(root, "library", "plaincoach.json"), JSON.stringify([
    { teamId: "501", teamName: "Plain XI", race: "Human", coach: "PlainCoach", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-27T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(join(root, "library", "othercoach.json"), JSON.stringify([
    { teamId: "502", teamName: "Other XI", race: "Orc", coach: "OtherCoach", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-27T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({
    version: 1,
    coaches: {
      organizercoach: {
        ffbCoachId: "OrganizerCoach", level: "organizer", banned: false, silenced: false,
        note: "", profile: {}, identities: {}, updatedAt: "2026-08-27T00:00:00.000Z", updatedBy: "RootAdmin",
      },
    },
  }), "utf8");
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

function post(path: string, token: string | undefined, body: unknown) {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("tournament entry HTTP tiers", () => {
  let tournamentId = "";

  it("serves the tournament HTML and JavaScript through GET and HEAD", async () => {
    for (const path of ["/tournaments.html", "/tournaments.js"]) {
      const get = await fetch(`${origin}${path}`);
      expect(get.status).toBe(200);
      expect((await get.text()).length).toBeGreaterThan(20);
      expect((await fetch(`${origin}${path}`, { method: "HEAD" })).status).toBe(200);
    }
  });

  it("rejects unauthenticated and coach create calls, then creates for an organizer", async () => {
    const body = { name: "HTTP Cup", packageName: "HTTP Rules", maxPlayers: 2, format: "swiss" };
    expect((await post("/api/fork/tournaments", undefined, body)).status).toBe(401);
    const plain = createSession("PlainCoach");
    expect((await post("/api/fork/tournaments", plain.token, body)).status).toBe(403);
    const organizer = createSession("OrganizerCoach");
    const response = await post("/api/fork/tournaments", organizer.token, body);
    expect(response.status).toBe(201);
    const payload = await response.json() as { tournament: { id: string; status: string } };
    tournamentId = payload.tournament.id;
    expect(payload.tournament.status).toBe("draft");
  });

  it("lets a coach self-register but not register another coach", async () => {
    expect((await post(`/api/fork/tournaments/${tournamentId}/entrants`, undefined, { teamId: "501" })).status).toBe(401);
    const plain = createSession("PlainCoach");
    const self = await post(`/api/fork/tournaments/${tournamentId}/entrants`, plain.token, { teamId: "501" });
    expect(self.status).toBe(201);
    const other = await post(`/api/fork/tournaments/${tournamentId}/entrants`, plain.token, { teamId: "502", coach: "OtherCoach" });
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: "Only an organizer may register another coach." });
  });

  it("lets an organizer register another coach through the same ownership contract", async () => {
    const organizer = createSession("OrganizerCoach");
    const response = await post(`/api/fork/tournaments/${tournamentId}/entrants`, organizer.token, { teamId: "502", coach: "OtherCoach" });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ entrant: { teamId: "502", coach: { ffbCoachId: "OtherCoach" } } });
  });
});
