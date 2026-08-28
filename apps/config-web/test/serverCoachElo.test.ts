import { once } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";

const root = mkdtempSync(join(tmpdir(), "server-coach-elo-"));
const previousEnv = new Map<string, string | undefined>();
const forkServer = createServer((req, res) => {
  res.setHeader("content-type", "application/xml");
  if (req.url?.startsWith("/admin/challenge")) {
    res.end("<admin><challenge>0123456789abcdef0123456789abcdef</challenge></admin>");
    return;
  }
  res.end("<admin><list></list></admin>");
});
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const side = (teamId: string, score: number) => ({
  teamId,
  score,
  winnings: 0,
  penaltyScore: -1,
  conceded: false,
  casualtiesSuffered: { bh: 0, si: 0, rip: 0 },
  players: [],
});

beforeAll(async () => {
  forkServer.listen(0, "127.0.0.1");
  await once(forkServer, "listening");
  const forkOrigin = `http://127.0.0.1:${(forkServer.address() as AddressInfo).port}`;
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_STATE_DIR: join(root, "state"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    PACKAGES_DIR: join(root, "packages"),
    FORK_ADMIN_PASSWORD: "098f6bcd4621d373cade4e832627b4f6",
    FORK_ADMIN_URL: forkOrigin,
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "state", "tournaments", "packages", "log"])
    mkdirSync(join(root, directory), { recursive: true });
  // Trip reloadFork's busy guard so this suite cannot stop or spawn a live fork.
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  const identity = (ffbCoachId: string) => ({
    ffbCoachId,
    level: "player",
    banned: false,
    silenced: false,
    note: "",
    profile: {},
    identities: {},
    updatedAt: "2026-08-27T00:00:00.000Z",
    updatedBy: "RootAdmin",
  });
  writeFileSync(join(root, "identities.json"), JSON.stringify({
    version: 1,
    coaches: { alice: identity("Alice"), charlie: identity("Charlie") },
  }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "state", "tournament-results.json"), JSON.stringify({
    version: 1,
    results: {
      "1": {
        gameId: "1",
        pulledAt: "2026-08-27T01:00:00.000Z",
        home: { teamId: "home", teamName: "Home", coach: "ALICE" },
        away: { teamId: "away", teamName: "Away", coach: "Bob" },
        teams: [side("home", 1), side("away", 0)],
      },
    },
  }), "utf8");

  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (forkServer.listening) await new Promise<void>((resolve, reject) => forkServer.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("Coach Elo HTTP surfaces", () => {
  it("adds case-insensitive Elo fields to the public records rows", async () => {
    const response = await fetch(`${origin}/api/fork/records`);
    expect(response.status).toBe(200);
    const rows = await response.json() as Array<Record<string, unknown>>;
    expect(rows.find((row) => String(row.coach).toLowerCase() === "alice")).toMatchObject({
      elo: 1516,
      provisional: true,
    });
    expect(rows.find((row) => String(row.coach).toLowerCase() === "bob")).toMatchObject({
      elo: 1484,
      provisional: true,
    });
  });

  it("emits account Elo and defaults a coach with no history without failing", async () => {
    const alice = createSession("Alice");
    const rated = await fetch(`${origin}/api/account`, { headers: { authorization: `Bearer ${alice.token}` } });
    expect(rated.status).toBe(200);
    expect(await rated.json()).toMatchObject({ elo: { rating: 1516, games: 1, provisional: true } });

    rmSync(join(root, "state", "tournament-results.json"), { force: true });
    const charlie = createSession("Charlie");
    const unrated = await fetch(`${origin}/api/account`, { headers: { authorization: `Bearer ${charlie.token}` } });
    expect(unrated.status).toBe(200);
    expect(await unrated.json()).toMatchObject({ elo: { rating: 1500, games: 0, provisional: true } });
  });
});
