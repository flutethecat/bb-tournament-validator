import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE_NAME } from "../src/auth/session.js";

// A fork whose schedule answer is always lost (uncertain). The client's challenge route for a held coach answers
// 409 with the lobby where it can be resolved; the error text alone stays readable for the current client.
vi.mock("@bb/fork-ops", async (importActual) => {
  const actual = await importActual<typeof import("@bb/fork-ops")>();
  return {
    ...actual,
    forkAdminConfigFromEnv: () => ({ baseUrl: "http://fork.invalid", passwordMd5Hex: "0".repeat(32) }),
    forkScheduler: () => ({
      schedule: async () => ({ kind: "unknown" as const, error: "504" }),
      findMatchup: async () => [],
    }),
  };
});

const root = mkdtempSync(join(tmpdir(), "lobby-held-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const team = (coach: string, teamId: string) => ({
  teamId, teamName: `${coach} XI`, race: "Orc", coach, teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00.000Z",
});

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
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    FORK_DB_HOST: "",
    SUPER_ENABLED: "",
    PUBLIC_BASE_URL: "https://play.example.test/",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "library", "heldalice.json"), JSON.stringify([team("HeldAlice", "9401")]), "utf8");
  writeFileSync(join(root, "library", "heldbob.json"), JSON.stringify([team("HeldBob", "9402")]), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const cookie = (coach: string) => `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}`;
const post = (path: string, c: string, body: unknown) =>
  fetch(`${origin}${path}`, { method: "POST", headers: { cookie: c, "content-type": "application/json", "x-cw-auth": "1" }, body: JSON.stringify(body) });

describe("held consent on the client challenge route", () => {
  it("answers 409 with the lobby id and URL (PUBLIC_BASE_URL), readable error text", async () => {
    const { lobby } = (await (await post("/api/lobby", cookie("HeldAlice"), { teamId: "9401", opponent: "HeldBob" })).json()) as { lobby: { id: string } };
    const joined = (await (await post(`/api/lobby/${lobby.id}/join`, cookie("HeldBob"), { teamId: "9402" })).json()) as { lobby: { uncertain: boolean } };
    expect(joined.lobby.uncertain).toBe(true);

    const res = await fetch(`${origin}/api/fork/challenge?coach=HeldAlice&teamId=9401&opponent=HeldBob&passwordMd5=${"1".repeat(32)}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; lobbyId: string; lobbyUrl: string };
    expect(body.lobbyId).toBe(lobby.id);
    expect(body.lobbyUrl).toBe(`https://play.example.test/lobby/#${lobby.id}`);
    expect(body.error).toBe(`A game is being set up for this coach; open the lobby at ${body.lobbyUrl}`);
  });
});
