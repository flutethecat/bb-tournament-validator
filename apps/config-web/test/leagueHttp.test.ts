import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { resetAvatarRateLimit } from "../src/teamAvatars.js";
import { LeagueStore } from "../src/leagues/store.js";

// League routes wired into the real server with the legacy password gate on: reads are public (no Basic prompt),
// artwork writes need a session, the CSRF header and an organiser.

const png = (w: number, h: number, pad = 0): Buffer => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

const root = mkdtempSync(join(tmpdir(), "league-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let ownerCookie = "";
let otherCookie = "";

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
    ADMIN_PASSWORD: "pw-league-test", FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "saves", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  new LeagueStore(join(root, "state")).upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Alice"] });
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  ownerCookie = `cw_session=${createSession("Alice", Date.now(), "discord").token}`;
  otherCookie = `cw_session=${createSession("Mallory", Date.now(), "discord").token}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => resetAvatarRateLimit());

const logo = `/api/leagues/tabbl/logo`;
const put = (body: Buffer, headers: Record<string, string>) => fetch(`${origin}${logo}`, { method: "PUT", headers: { "content-type": "image/png", ...headers }, body: new Uint8Array(body) });

describe("league routes over HTTP", () => {
  it("reads are public with the password gate on", async () => {
    const list = await fetch(`${origin}/api/leagues`);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { leagues: Array<{ id: string }> }).leagues.map((l) => l.id)).toEqual(["tabbl"]);
    expect((await fetch(`${origin}/api/leagues/tabbl`)).status).toBe(200);
    expect((await fetch(`${origin}/api/leagues/tabbl/stats?scope=all`)).status).toBe(200);
    expect((await fetch(`${origin}${logo}`)).status).toBe(404);
  });

  it("writes: anonymous 401, cookie without X-CW-Auth 403, non-organiser 403, organiser 200 and the image is served", async () => {
    expect((await put(png(256, 256), {})).status).toBe(401);
    expect((await put(png(256, 256), { cookie: ownerCookie })).status).toBe(403);
    expect((await put(png(256, 256), { cookie: otherCookie, "x-cw-auth": "1" })).status).toBe(403);
    const ok = await put(png(256, 256), { cookie: ownerCookie, "x-cw-auth": "1" });
    expect(ok.status).toBe(200);
    const read = await fetch(`${origin}${logo}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect((await fetch(`${origin}${logo}`, { method: "DELETE" })).status).toBe(401);
  });
});
