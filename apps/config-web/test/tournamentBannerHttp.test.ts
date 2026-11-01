import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "./onboardedFixture.js";
import { resetAvatarRateLimit } from "../src/teamAvatars.js";
import { TournamentStore } from "../src/tournaments/store.js";

// The banner route wired into the real server: raw body, public read with the sniffed content type, 413 + close.

const png = (w: number, h: number, pad = 0): Buffer => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

const root = mkdtempSync(join(tmpdir(), "tournament-banner-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let ownerCookie = "";
let otherCookie = "";
let tournamentId = "";

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
    ADMIN_PASSWORD: "", FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "saves", "packages", "tournaments", "state"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {} }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  tournamentId = new TournamentStore(join(root, "tournaments")).createTournament({ name: "Banner Cup", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Alice" }).id;
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

const url = () => `${origin}/api/tournaments/${tournamentId}/banner`;
const put = (body: Buffer, cookie = ownerCookie) =>
  fetch(url(), { method: "PUT", headers: { cookie, "x-cw-auth": "1", "content-type": "image/png" }, body });

describe("tournament banner over HTTP", () => {
  it("owner uploads; anyone reads it with the sniffed type; the detail carries bannerUrl", async () => {
    expect((await fetch(url())).status).toBe(404);
    const up = await put(png(1600, 400, 16));
    expect(up.status).toBe(200);
    const { bannerUrl } = (await up.json()) as { bannerUrl: string };
    const read = await fetch(`${origin}${bannerUrl}`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("x-content-type-options")).toBe("nosniff");
    const detail = (await (await fetch(`${origin}/api/tournaments/${tournamentId}`)).json()) as { tournament: Record<string, unknown> };
    expect(detail.tournament.bannerUrl).toBe(bannerUrl);
    expect(detail.tournament).not.toHaveProperty("bannerPath");
  });

  it("another coach is refused; a too-large upload answers 413", async () => {
    expect((await put(png(1600, 400), otherCookie)).status).toBe(403);
    const big = await put(png(1600, 400, 1024 * 1024)).catch(() => undefined);
    if (big) expect(big.status).toBe(413);
    const del = await fetch(url(), { method: "DELETE", headers: { cookie: ownerCookie, "x-cw-auth": "1" } });
    expect(del.status).toBe(204);
    expect((await fetch(url())).status).toBe(404);
  });
});
