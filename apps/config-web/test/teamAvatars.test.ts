import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { request } from "node:http";
import { AvatarStore, avatarRateBuckets, avatarRateLimit, avatarUrlFor, canonicalTeamKey, checkAvatar, resetAvatarRateLimit, sniffImage, sweepAvatarRateLimit, teamAvatarPath } from "../src/teamAvatars.js";
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

const webpVp8 = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8 ", 12, "latin1"); b.writeUInt32LE(18, 16);
  b[23] = 0x9d; b[24] = 0x01; b[25] = 0x2a; b.writeUInt16LE(w, 26); b.writeUInt16LE(h, 28);
  return b;
};
const webpVp8l = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1"); b.writeUInt32LE(32, 4); b.write("WEBP", 8, "latin1"); b.write("VP8L", 12, "latin1"); b.writeUInt32LE(18, 16);
  b[20] = 0x2f; b.writeUInt32LE(((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14), 21);
  return b;
};
/** EXIF APP1 (40 bytes) then a progressive SOF2 frame. */
const jpegExifProgressive = (w: number, h: number): Buffer => {
  const b = Buffer.alloc(80);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe1; b.writeUInt16BE(40, 4); b.write("Exif", 6, "latin1");
  b[44] = 0xff; b[45] = 0xc2; b.writeUInt16BE(17, 46); b[48] = 8; b.writeUInt16BE(h, 49); b.writeUInt16BE(w, 51); b[53] = 3;
  return b;
};

describe("avatar validation (unit)", () => {
  it("accepts VP8 / VP8L / VP8X webp and an EXIF + progressive jpeg", () => {
    expect(sniffImage(webpVp8(320, 200))).toEqual({ ext: "webp", width: 320, height: 200 });
    expect(sniffImage(webpVp8l(300, 150))).toEqual({ ext: "webp", width: 300, height: 150 });
    expect(sniffImage(webpX(512, 512))).toEqual({ ext: "webp", width: 512, height: 512 });
    expect(sniffImage(jpegExifProgressive(640, 480))).toEqual({ ext: "jpg", width: 640, height: 480 });
  });
  it("rejects malformed structure: PNG IHDR length, truncated / short JPEG SOF, bad RIFF lengths", () => {
    const badPng = png(128, 128); badPng.writeUInt32BE(12, 8);
    expect(sniffImage(badPng)).toBeUndefined();
    expect(sniffImage(jpeg(128, 128).subarray(0, 27))).toBeUndefined(); // SOF cut off
    const shortSof = jpeg(128, 128); shortSof.writeUInt16BE(8, 22);
    expect(sniffImage(shortSof)).toBeUndefined();
    const badRiff = webpX(128, 128); badRiff.writeUInt32LE(9999, 4);
    expect(sniffImage(badRiff)).toBeUndefined();
    const badChunk = webpX(128, 128); badChunk.writeUInt32LE(9999, 16);
    expect(sniffImage(badChunk)).toBeUndefined();
    const shortVp8 = webpVp8(128, 128); shortVp8.writeUInt32LE(4, 16);
    expect(sniffImage(shortVp8)).toBeUndefined();
  });
  it("rejects SVG, an HTML polyglot, GIF and an empty body", () => {
    expect(checkAvatar(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><script>alert(1)</script></svg>')).ok).toBe(false);
    expect(checkAvatar(Buffer.from("<!DOCTYPE html><html><body><script>alert(1)</script></body></html>" + " ".repeat(64))).ok).toBe(false);
    expect(checkAvatar(Buffer.concat([Buffer.from("  <html>"), png(128, 128)])).ok).toBe(false);
    expect(checkAvatar(Buffer.from("GIF89a" + "\0".repeat(60))).ok).toBe(false);
    expect(checkAvatar(Buffer.alloc(0)).ok).toBe(false);
  });

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
    { teamId: "502", teamName: "Alice Old", race: "Human", coach: "Alice", teamValue: 1000, gold: 0, forkLoadable: true, retired: true, ingestedAt: "2026-08-27T00:00:00.000Z" },
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
/** PUT a large body; "413" when the refusal arrives, "reset" when the server drops the upload connection first. */
const bigPut = (body: Buffer): Promise<string> =>
  new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port: Number(new URL(origin).port), method: "PUT", path: "/api/fork/teams/library%3A501/avatar", headers: { cookie, "x-cw-auth": "1", "content-length": String(body.length) } }, (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on("error", () => resolve("reset"));
    req.end(body);
  });
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
    expect(await bigPut(png(128, 128, 600 * 1024))).toMatch(/^(413|reset)$/); // the server drops an oversized upload
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

  it("413 up front for a declared Content-Length over the cap (nothing read), and for a chunked body that streams past it", async () => {
    const before = filesFor();
    const port = Number(new URL(origin).port);
    // Declared: headers only, no body ever sent: the answer must not wait for the upload.
    const declared = await new Promise<number>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "PUT", path: "/api/fork/teams/library%3A501/avatar", headers: { cookie, "x-cw-auth": "1", "content-length": String(700 * 1024) } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      req.on("error", (e) => (e as NodeJS.ErrnoException).code === "ECONNRESET" ? undefined : reject(e));
      req.flushHeaders();
    });
    expect(declared).toBe(413);
    // Chunked: no Content-Length; the server stops at the cap (413 or a dropped connection), never stores anything.
    const chunked = await new Promise<string>((resolve) => {
      const req = request({ host: "127.0.0.1", port, method: "PUT", path: "/api/fork/teams/library%3A501/avatar", headers: { cookie, "x-cw-auth": "1", "transfer-encoding": "chunked" } }, (res) => {
        res.resume();
        resolve(String(res.statusCode));
      });
      req.on("error", () => resolve("reset"));
      req.write(png(128, 128));
      for (let i = 0; i < 12; i += 1) req.write(Buffer.alloc(64 * 1024));
      req.end();
    });
    expect(chunked).toMatch(/^(413|reset)$/);
    expect(filesFor()).toEqual(before);
  });

  it("403 for a retired library team (the owner lookup honours retired)", async () => {
    expect((await put("library%3A502", png(128, 128))).status).toBe(403);
  });

  it("rate limits before the ownership lookup (a stranger gets 429, not 403, once the bucket is full)", async () => {
    for (let i = 0; i < 10; i += 1) expect((await put("library%3A501", png(128, 128), otherCookie)).status).toBe(403);
    expect((await put("library%3A501", png(128, 128), otherCookie)).status).toBe(429);
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

describe("avatar index and ownership change (unit)", () => {
  it("builds the index at startup, answers a miss from memory, and prunes other owners' copies on save and remove", async () => {
    const dir = mkdtempSync(join(tmpdir(), "av-index-"));
    try {
      const hash = sha("save:sv_x");
      const oldFolder = join(dir, sha("OldOwner"));
      mkdirSync(oldFolder, { recursive: true });
      writeFileSync(join(oldFolder, `${hash}.png`), png(128, 128));
      const store = new AvatarStore(dir);
      await store.ready;
      expect(store.find("save:sv_x")?.ext).toBe("png");
      // memory only: a file dropped behind the index's back is invisible, so a miss never costs a stat
      writeFileSync(join(oldFolder, `${sha("save:other")}.png`), png(128, 128));
      expect(store.find("save:other")).toBeUndefined();
      expect(store.url("save:nope")).toBeUndefined();

      await store.save("NewOwner", "save:sv_x", jpeg(200, 200), "jpg");
      expect(existsSync(join(oldFolder, `${hash}.png`))).toBe(false); // old owner's copy pruned
      expect(store.find("save:sv_x")?.ext).toBe("jpg");
      expect(readdirSync(join(dir, sha("NewOwner")))).toEqual([`${hash}.jpg`]);

      // a restart still sees exactly one copy
      const reopened = new AvatarStore(dir);
      await reopened.ready;
      expect(reopened.find("save:sv_x")?.ext).toBe("jpg");

      // the new owner can remove it, and it is gone from every folder
      expect(await store.remove("save:sv_x")).toBe(true);
      expect(store.find("save:sv_x")).toBeUndefined();
      expect(readdirSync(join(dir, sha("NewOwner")))).toEqual([]);
      expect(await store.remove("save:sv_x")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rate limiter housekeeping", () => {
  it("sweeps idle buckets", () => {
    resetAvatarRateLimit();
    avatarRateLimit("Idle", 1_000);
    avatarRateLimit("Busy", 100_000);
    expect(avatarRateBuckets()).toBe(2);
    expect(sweepAvatarRateLimit(120_000)).toBe(1); // Idle has nothing in the last minute
    expect(avatarRateBuckets()).toBe(1);
    resetAvatarRateLimit();
  });
});
