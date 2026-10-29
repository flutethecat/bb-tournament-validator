import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { avatarUrlFor, canonicalTeamKey, checkAvatar, resetAvatarRateLimit, sniffImage, teamAvatarPath } from "../src/teamAvatars.js";
import { tabletopApi, type TabletopApiDeps } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// ---- image fixtures (headers only: validation is decode-free) ----------------------------------------------
const png = (w: number, h: number, pad = 0): Buffer => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; b.writeUInt16BE(16, 4); // APP0, 16 bytes
  b[20] = 0xff; b[21] = 0xc0; b.writeUInt16BE(17, 22); b[24] = 8; b.writeUInt16BE(h, 25); b.writeUInt16BE(w, 27);
  return b;
};
const webpX = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8X", 12, "latin1"); b.writeUInt32LE(10, 16);
  const wm = w - 1; const hm = h - 1;
  b[24] = wm & 255; b[25] = (wm >> 8) & 255; b[26] = (wm >> 16) & 255; b[27] = hm & 255; b[28] = (hm >> 8) & 255; b[29] = (hm >> 16) & 255;
  return b;
};

describe("avatar validation (unit)", () => {
  it("sniffs png / jpeg / webp dimensions from the headers", () => {
    expect(sniffImage(png(128, 96))).toEqual({ ext: "png", width: 128, height: 96 });
    expect(sniffImage(jpeg(200, 100))).toEqual({ ext: "jpg", width: 200, height: 100 });
    expect(sniffImage(webpX(300, 256))).toEqual({ ext: "webp", width: 300, height: 256 });
  });
  it("rejects bad magic, oversize, too small and too large", () => {
    expect(checkAvatar(Buffer.from("GIF89a....................................")).ok).toBe(false);
    expect(checkAvatar(png(128, 128, 600 * 1024)).ok).toBe(false);
    expect(checkAvatar(png(63, 128)).ok).toBe(false);
    expect(checkAvatar(png(128, 1025)).ok).toBe(false);
    expect(checkAvatar(png(64, 1024)).ok).toBe(true);
  });
  it("refs: canonical keys and traversal attempts", () => {
    expect(canonicalTeamKey("library:77")).toBe("library:77");
    expect(canonicalTeamKey("sv_a")).toBe("save:sv_a");
    expect(canonicalTeamKey("save:sv_a")).toBe("save:sv_a");
    expect(canonicalTeamKey("../../etc/passwd")).toBeUndefined();
    expect(teamAvatarPath("/api/fork/teams/library%3A77/avatar")).toBe("library:77");
    expect(teamAvatarPath("/api/fork/teams/..%2F..%2Fx/avatar")).toBeUndefined();
    expect(teamAvatarPath("/api/fork/teams/a/b/avatar")).toBeUndefined();
  });
});

// ---- HTTP routes -------------------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "team-avatars-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
let cookie = "";
let otherCookie = "";
const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

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
  writeFileSync(join(root, "library", "alice.json"), JSON.stringify([
    { teamId: "501", teamName: "Alice XI", race: "Human", coach: "Alice", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-27T00:00:00.000Z" },
  ]), "utf8");
  writeFileSync(join(root, "saves", `${sha("Alice")}.json`), JSON.stringify({ coach: "Alice", saves: [{ id: "sv_a", name: "Alice Save" }] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cookie = `cw_session=${createSession("Alice", Date.now(), "discord").token}`;
  otherCookie = `cw_session=${createSession("Mallory", Date.now(), "discord").token}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => resetAvatarRateLimit());

const put = (ref: string, body: Buffer | string, who = cookie) =>
  fetch(`${origin}/api/fork/teams/${ref}/avatar`, { method: "PUT", headers: { cookie: who, "x-cw-auth": "1", "content-type": "image/png" }, body });
const filesFor = (): string[] => {
  const dir = join(root, "avatars", sha("Alice"));
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("avatar routes", () => {
  it("requires a session (401) and ownership (403)", async () => {
    const anon = await fetch(`${origin}/api/fork/teams/library%3A501/avatar`, { method: "PUT", headers: { "x-cw-auth": "1" }, body: png(128, 128) });
    expect(anon.status).toBe(401);
    expect((await put("library%3A501", png(128, 128), otherCookie)).status).toBe(403);
    expect((await put("sv_a", png(128, 128), otherCookie)).status).toBe(403);
    expect((await put("library%3A999", png(128, 128))).status).toBe(403);
    expect((await put("sv_zzz", png(128, 128))).status).toBe(403);
  });

  it("400 for bad magic, oversize and too-small images; traversal refs never reach a path", async () => {
    expect((await put("library%3A501", Buffer.from("not an image at all, just text ........."))).status).toBe(400);
    expect((await put("library%3A501", png(128, 128, 600 * 1024))).status).toBe(400);
    expect((await put("library%3A501", png(32, 32))).status).toBe(400);
    expect((await put("..%2F..%2Fescape", png(128, 128))).status).not.toBe(200);
    expect(filesFor()).toEqual([]);
    expect(existsSync(join(root, "escape"))).toBe(false);
  });

  it("stores one hashed file per team, replaces across formats, serves it publicly, and deletes", async () => {
    expect((await fetch(`${origin}/api/fork/teams/library%3A501/avatar`)).status).toBe(404);
    const first = await put("library%3A501", png(128, 128));
    expect(first.status).toBe(200);
    expect((await first.json()).avatarUrl).toMatch(/^\/api\/fork\/teams\/library%3A501\/avatar\?v=\d+$/);
    expect(filesFor()).toHaveLength(1);
    expect(filesFor()[0]).toBe(`${sha("library:501")}.png`);

    const read = await fetch(`${origin}/api/fork/teams/library%3A501/avatar`);
    expect(read.status).toBe(200);
    expect(read.headers.get("content-type")).toBe("image/png");
    expect(read.headers.get("cache-control")).toContain("max-age=3600");

    expect((await put("library%3A501", jpeg(200, 200))).status).toBe(200);
    expect(filesFor()).toEqual([`${sha("library:501")}.jpg`]); // replaced, old ext gone
    expect((await fetch(`${origin}/api/fork/teams/library%3A501/avatar`)).headers.get("content-type")).toBe("image/jpeg");

    expect((await put("sv_a", webpX(256, 256))).status).toBe(200);
    expect(filesFor()).toHaveLength(2);
    expect((await fetch(`${origin}/api/fork/teams/save%3Asv_a/avatar`)).headers.get("content-type")).toBe("image/webp");

    const del = await fetch(`${origin}/api/fork/teams/library%3A501/avatar`, { method: "DELETE", headers: { cookie, "x-cw-auth": "1" } });
    expect(del.status).toBe(204);
    expect((await fetch(`${origin}/api/fork/teams/library%3A501/avatar`)).status).toBe(404);
    const strangerDelete = await fetch(`${origin}/api/fork/teams/save%3Asv_a/avatar`, { method: "DELETE", headers: { cookie: otherCookie, "x-cw-auth": "1" } });
    expect(strangerDelete.status).toBe(403);
    expect((await fetch(`${origin}/api/fork/teams/save%3Asv_a/avatar`)).status).toBe(200);
  });

  it("rate limits a coach to 10 changes per minute (429)", async () => {
    for (let i = 0; i < 10; i += 1) expect((await put("library%3A501", png(128, 128))).status).toBe(200);
    expect((await put("library%3A501", png(128, 128))).status).toBe(429);
  });

  it("requires the X-CW-Auth header on a cookie write", async () => {
    const r = await fetch(`${origin}/api/fork/teams/library%3A501/avatar`, { method: "PUT", headers: { cookie }, body: png(128, 128) });
    expect(r.status).toBe(403);
  });
});

describe("TeamView carries avatarUrl", () => {
  const files: Record<string, TabletopTeamFile> = {};
  const team = (prefix: string): TabletopTeamFile => ({
    schema: 1, name: `${prefix} XI`, race: "Human", treasury: 0, dedicatedFans: 1, teamValue: 1_000_000,
    players: Array.from({ length: 11 }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
  });

  it("the match GET adds avatarUrl for a team with an avatar and omits it otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tv-avatar-"));
    try {
      const repo = new FileTabletopRepository(join(dir, "tt"));
      files["Alice/sv_a"] = team("a");
      files["Bob/sv_b"] = team("b");
      const deps: TabletopApiDeps = {
        repo, results: new TournamentResultStore(join(dir, "results")),
        loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
        listSaves: () => [], listTeams: () => [], isBanned: () => false, isOrganizer: () => false,
        now: () => new Date("2026-03-01T10:00:00.000Z"), rollDie: () => 1,
        teamAvatarUrl: (ref) => (ref === "sv_a" ? "/api/fork/teams/save%3Asv_a/avatar?v=1" : undefined),
      };
      const call = (method: string, path: string, who: string, body?: unknown) =>
        tabletopApi(method, path, { coach: who, method: "discord" }, body, deps, new URLSearchParams()).then((r) => r!);
      const created = await call("POST", "/api/tabletop/matches", "Alice", { home: { coach: "Alice", team: "save:sv_a" }, away: { coach: "Bob", team: "save:sv_b" }, postMatch: "none" });
      const id = (created.body as { match: { id: string } }).match.id;
      const got = (await call("GET", `/api/tabletop/matches/${id}`, "Alice")).body as { teams: { home: { avatarUrl?: string }; away: { avatarUrl?: string } } };
      expect(got.teams.home.avatarUrl).toBe("/api/fork/teams/save%3Asv_a/avatar?v=1");
      expect(got.teams.away.avatarUrl).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("avatarUrlFor is undefined without a stored file", () => {
    expect(avatarUrlFor(join(root, "avatars"), "library:12345")).toBeUndefined();
    expect(avatarUrlFor(undefined, "library:1")).toBeUndefined();
  });
});
