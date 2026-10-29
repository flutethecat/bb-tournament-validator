import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tournamentBannerApi } from "../src/tournaments/page.js";
import { TournamentStore } from "../src/tournaments/store.js";

// Regression (Sol 6.1 P2): with the auth sidecar ON, requireSession must let an anonymous visitor read a tournament
// banner (both spellings) while writes stay session-gated.

const png = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(33 + 16);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

const root = mkdtempSync(join(tmpdir(), "tournament-banner-sidecar-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let tournamentId = "";

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    SESSIONS_FILE: join(root, "sessions.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_TEAMS_DIR: join(root, "teams"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    FORK_STATE_DIR: join(root, "state"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "teams", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  const dataDir = join(root, "tournaments");
  const store = new TournamentStore(dataDir);
  tournamentId = store.createTournament({ name: "Sidecar Cup", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Alice" }).id;
  const up = await tournamentBannerApi("PUT", `/api/tournaments/${tournamentId}/banner`, { coach: "Alice", admin: false }, {
    store, dataDir, readBody: async () => png(1600, 400),
  });
  expect(up?.status).toBe(200);
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe("tournament banner with the auth sidecar enabled", () => {
  it("anonymous GET and HEAD read the banner on both spellings; anonymous PUT is still refused", async () => {
    for (const path of [`/api/tournaments/${tournamentId}/banner`, `/api/fork/tournaments/${tournamentId}/banner`]) {
      const read = await fetch(`${origin}${path}`);
      expect(read.status, path).toBe(200);
      expect(read.headers.get("content-type")).toBe("image/png");
      expect((await fetch(`${origin}${path}`, { method: "HEAD" })).status, path).toBe(200);
    }
    const write = await fetch(`${origin}/api/tournaments/${tournamentId}/banner`, { method: "PUT", headers: { "x-cw-auth": "1" }, body: png(1600, 400) });
    expect(write.status).toBe(401);
  });
});
