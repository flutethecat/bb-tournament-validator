import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession } from "../src/auth/session.js";
import { discordAvatarUrl } from "../src/auth/discordSso.js";
import { resetAvatarRateLimit } from "../src/teamAvatars.js";
import {
  AvatarProxy, coachAvatarId, coachAvatarKey, coachAvatarPath, coachAvatarStore, createCoachAvatarResolver, isAllowedCardAvatarUrl, isProxyableAvatarUrl,
  PROXY_MAX_BYTES, resolveCoachAvatar, smallDiscordAvatar, withSideAvatars,
} from "../src/coachAvatars.js";
import { mergeIdentityRecords, ownIdentityRecord, upsertIdentity, type IdentityStore } from "../src/auth/identitiesStore.js";

// Coach avatars (owner 10-31): the coach uploads their own (PUT/DELETE /api/me/avatar), Discord is the fallback, and the
// public result cards carry the site's own avatar route for eligible site coaches only; Discord images are proxied, never
// linked (src/coachAvatars.ts).

const png = (w: number, h: number, pad = 0): Buffer => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const sha = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex");

const record = (ffbCoachId: string, extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "", ...extra,
});
const store = (coaches: Record<string, ReturnType<typeof record>>): IdentityStore => ({ version: 1, coaches } as unknown as IdentityStore);

describe("coach avatar helpers (unit)", () => {
  it("route paths: NFC + case fold, no traversal; a 40-character name that folds longer still works", () => {
    expect(coachAvatarPath("/api/coach-avatars/Alice")).toBe("alice");
    expect(coachAvatarPath("/api/coach-avatars/Big%20Al")).toBe("big al");
    expect(coachAvatarPath(`/api/coach-avatars/${encodeURIComponent("Café")}`)).toBe("café"); // NFC
    expect(coachAvatarPath("/api/coach-avatars/")).toBeUndefined();
    expect(coachAvatarPath("/api/coach-avatars/a/b")).toBeUndefined();
    expect(coachAvatarPath("/api/coach-avatars/..%2F..%2Fetc")).toBeUndefined();
    expect(coachAvatarPath("/api/coach-avatars/%E0%A4%A")).toBeUndefined();
    const dotted = "İ".repeat(40); // "İ": 40 characters, 80 code units once folded
    expect(coachAvatarId(dotted).length).toBe(80);
    expect(coachAvatarPath(`/api/coach-avatars/${encodeURIComponent(coachAvatarId(dotted))}`)).toBe(coachAvatarId(dotted));
    expect(coachAvatarPath(`/api/coach-avatars/${encodeURIComponent(dotted)}`)).toBe(coachAvatarId(dotted));
    expect(coachAvatarPath(`/api/coach-avatars/${"x".repeat(121)}`)).toBeUndefined();
  });

  it("card allow-list: the site's own route with a version token only (never a Discord CDN URL)", () => {
    expect(isAllowedCardAvatarUrl("/api/coach-avatars/alice?v=0123456789abcdef")).toBe(true);
    expect(isAllowedCardAvatarUrl("https://cdn.discordapp.com/avatars/1/abc.png?size=64")).toBe(false);
    expect(isAllowedCardAvatarUrl("/api/coach-avatars/alice")).toBe(false);
    expect(isAllowedCardAvatarUrl("/api/coach-avatars/alice?v=123")).toBe(false);
    expect(isAllowedCardAvatarUrl("/api/coach-avatars/alice/../x?v=0123456789abcdef")).toBe(false);
    expect(isAllowedCardAvatarUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedCardAvatarUrl(undefined)).toBe(false);
  });

  it("proxy allow-list: https cdn.discordapp.com only", () => {
    expect(isProxyableAvatarUrl("https://cdn.discordapp.com/avatars/1/a.png?size=64")).toBe(true);
    for (const bad of ["http://cdn.discordapp.com/a.png", "https://cdn.discordapp.com.evil.test/a.png", "https://user:pw@cdn.discordapp.com/a.png", "https://evil.test/a.png", "https://cdn.discordapp.com:8443/a.png"])
      expect(isProxyableAvatarUrl(bad)).toBe(false);
  });

  it("precedence: upload > admin-set profile > Discord > none", () => {
    expect(resolveCoachAvatar({ upload: "/u", profile: "/p", discord: "/d" })).toEqual({ url: "/u", source: "upload" });
    expect(resolveCoachAvatar({ profile: "/p", discord: "/d" })).toEqual({ url: "/p", source: "profile" });
    expect(resolveCoachAvatar({ profile: "", discord: "/d" })).toEqual({ url: "/d", source: "discord" });
    expect(resolveCoachAvatar({})).toEqual({ url: null, source: "none" });
  });

  it("small Discord avatar: a 64 px still PNG of the CDN URL", () => {
    expect(smallDiscordAvatar("https://cdn.discordapp.com/avatars/1/a_x.gif?size=256")).toBe("https://cdn.discordapp.com/avatars/1/a_x.png?size=64");
    expect(smallDiscordAvatar("https://evil.test/a.png")).toBeUndefined();
    expect(smallDiscordAvatar(undefined)).toBeUndefined();
  });

  it("card resolver: own-route URLs only, eligibility from identities, nothing before the upload index loads, TTL + invalidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-avatar-resolver-"));
    let reads = 0;
    let t = 0;
    let identities = store({
      alice: record("Alice", { identities: { discordUserId: "11", discordAvatarHash: "aa" } }),
      bob: record("Bob", { profile: { avatar: "https://cdn.discordapp.com/avatars/22/admin.png" }, identities: { discordUserId: "22", discordAvatarHash: "bb" } }),
      carol: record("Carol", { profile: { avatar: "https://evil.test/c.png" }, identities: { discordUserId: "33", discordAvatarHash: "cc" } }),
      dan: record("Dan", { banned: true, identities: { discordUserId: "44", discordAvatarHash: "dd" } }),
      erin: record("Erin"),
    });
    const r = createCoachAvatarResolver({ dir, discordAvatarUrl, readIdentities: () => { reads += 1; return identities; }, ttlMs: 1000, now: () => t });
    expect(r.avatarFor("Alice")).toBeUndefined(); // index still loading: no lower source by mistake
    await r.ready;
    const alice = r.avatarFor("alice")!;
    expect(isAllowedCardAvatarUrl(alice)).toBe(true);
    expect(alice.startsWith("/api/coach-avatars/alice?v=")).toBe(true);
    expect(alice).not.toMatch(/discord/);
    expect(isAllowedCardAvatarUrl(r.avatarFor("Bob"))).toBe(true);
    expect(isAllowedCardAvatarUrl(r.avatarFor("Carol"))).toBe(true); // off-list admin avatar skipped, Discord used
    expect(r.avatarFor("Dan")).toBeUndefined(); // banned
    expect(r.avatarFor("Erin")).toBeUndefined(); // nothing to show
    expect(r.avatarFor("FumbblOnly")).toBeUndefined(); // no identity
    expect(r.avatarFor("")).toBeUndefined();
    expect(reads).toBe(1);
    t = 999; r.avatarFor("alice"); expect(reads).toBe(1);
    t = 1000; r.avatarFor("alice"); expect(reads).toBe(2);
    r.invalidate(); r.avatarFor("alice"); expect(reads).toBe(3);
    // a new Discord hash is a new version token
    identities = store({ ...(identities.coaches as unknown as Record<string, ReturnType<typeof record>>), alice: record("Alice", { identities: { discordUserId: "11", discordAvatarHash: "a2" } }) });
    r.invalidate();
    expect(r.avatarFor("Alice")).not.toBe(alice);
    rmSync(dir, { recursive: true, force: true });
  });

  it("identitiesWritten: a ban applies at once, and a removed identity loses its upload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-avatar-written-"));
    const both = store({ fay: record("Fay"), gil: record("Gil") });
    const r = createCoachAvatarResolver({ dir, discordAvatarUrl, readIdentities: () => both, ttlMs: 60_000 });
    await r.ready;
    const uploads = coachAvatarStore(dir);
    await uploads.save("fay", coachAvatarKey("Fay"), png(64, 64), "png");
    await uploads.save("gil", coachAvatarKey("Gil"), png(64, 64), "png");
    expect(r.avatarFor("Fay")).toBeDefined();
    await r.identitiesWritten(store({ fay: record("Fay", { banned: true }), gil: record("Gil") }));
    expect(r.avatarFor("Fay")).toBeUndefined();
    expect(await r.image("fay")).toBeUndefined();
    expect((await r.image("gil"))?.ext).toBe("png");
    await r.identitiesWritten(store({ fay: record("Fay", { banned: true }) })); // Gil merged away / deleted
    expect(uploads.find(coachAvatarKey("Gil"))).toBeUndefined();
    expect(await r.image("gil")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("proxy: allow-listed fetch only, content-type + magic + size checks, cached in memory and on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coach-avatar-proxy-"));
    const hits: string[] = [];
    let reply = (): Response => new Response(png(64, 64) as unknown as BodyInit, { headers: { "content-type": "image/png" } });
    const fetcher = async (url: string) => { hits.push(url); return reply(); };
    const p = new AvatarProxy(dir, fetcher);
    const url = "https://cdn.discordapp.com/avatars/1/a.png?size=64";
    expect((await p.get(url))?.contentType).toBe("image/png");
    expect((await p.get(url))?.ext).toBe("png");
    expect(hits).toEqual([url]); // memory
    expect((await new AvatarProxy(dir, fetcher).get(url))?.ext).toBe("png");
    expect(hits).toHaveLength(1); // disk
    expect(await p.get("https://evil.test/a.png")).toBeUndefined();
    expect(hits).toHaveLength(1);
    reply = () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } });
    expect(await p.get("https://cdn.discordapp.com/avatars/1/b.png")).toBeUndefined();
    reply = () => new Response(Buffer.from("not an image at all, just text") as unknown as BodyInit, { headers: { "content-type": "image/png" } });
    expect(await p.get("https://cdn.discordapp.com/avatars/1/c.png")).toBeUndefined();
    reply = () => new Response(png(64, 64, PROXY_MAX_BYTES) as unknown as BodyInit, { headers: { "content-type": "image/png" } });
    expect(await p.get("https://cdn.discordapp.com/avatars/1/d.png")).toBeUndefined();
    reply = () => new Response("", { status: 404 });
    expect(await p.get("https://cdn.discordapp.com/avatars/1/e.png")).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it("withSideAvatars sets resolved URLs and drops any avatarUrl the row already carried", () => {
    const card = { id: "x", home: { coach: "Alice", avatarUrl: "https://evil.test/x.png" }, away: { coach: "Zed" } };
    const out = withSideAvatars(card, (c) => (c === "Alice" ? "/api/coach-avatars/alice?v=0123456789abcdef" : undefined));
    expect(out.home).toEqual({ coach: "Alice", avatarUrl: "/api/coach-avatars/alice?v=0123456789abcdef" });
    expect(out.away).toEqual({ coach: "Zed" });
    expect(card.home.avatarUrl).toBe("https://evil.test/x.png"); // input untouched
  });
});

// ---- HTTP ---------------------------------------------------------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "coach-avatars-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];
const cookieOf = (coach: string) => `cw_session=${createSession(coach, Date.now(), "discord").token}`;
let alice = "";
let bob = "";
const DOTTED = "İ".repeat(40);
// The proxy fetches cdn.discordapp.com server-side; the test answers those requests itself.
const realFetch = globalThis.fetch;
const cdnHits: string[] = [];
const cdnPng = png(64, 64, 7);

beforeAll(async () => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://cdn.discordapp.com/")) {
      cdnHits.push(url);
      return new Response(cdnPng as unknown as BodyInit, { headers: { "content-type": "image/png" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  for (const [name, value] of Object.entries({
    HOST: "127.0.0.1", PORT: "0", AUTH_SIDECAR_ENABLED: "",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    SESSIONS_FILE: join(root, "sessions.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    TEAM_AVATARS_DIR: join(root, "team-avatars"),
    COACH_AVATARS_DIR: join(root, "coach-avatars"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    TABLETOP_DIR: join(root, "tabletop"),
    COACH_REGISTRY_JSON: join(root, "coaches.json"),
    BUILD_LOG_FILE: join(root, "build-log.json"),
    ADMIN_PASSWORD: "", FORK_ADMIN_PASSWORD: "", FORK_DB_HOST: "", SUPER_ENABLED: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  delete process.env.FORK_TEAMS_DIR;
  for (const d of ["library", "saves", "packages", "tournaments", "state", "tabletop"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    alice: record("Alice", { identities: { discordUserId: "111111", discordAvatarHash: "abc", discordUsername: "alice_dc" } }),
    bob: record("Bob", { profile: { avatar: "https://cdn.discordapp.com/avatars/222222/admin.png" }, identities: { discordUserId: "222222", discordAvatarHash: "def" } }),
    carol: record("Carol"),
    dave: record("Dave"),
    dotted: record(DOTTED),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  writeFileSync(join(root, "coaches.json"), "[]", "utf8");
  writeFileSync(join(root, "build-log.json"), "[]", "utf8");
  writeFileSync(join(root, "state", "fork-reload-state.json"), JSON.stringify({ lastReloadAt: "2026-02-01T00:00:00.000Z" }), "utf8");
  const team = (teamId: string, score: number) => ({ teamId, score, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] });
  const row = (gameId: string, home: string, away: string, playedAt: string) => ({
    gameId, pulledAt: playedAt, playedAt, namesDecoded: true,
    home: { teamId: `${gameId}h`, teamName: `${home} XI`, coach: home }, away: { teamId: `${gameId}a`, teamName: `${away} XI`, coach: away },
    teams: [team(`${gameId}h`, 2), team(`${gameId}a`, 1)],
  });
  writeFileSync(join(root, "state", "tournament-results.json"), JSON.stringify({ version: 1, results: {
    g1: row("g1", "Alice", "Zed", "2026-10-30T10:00:00.000Z"),
    g2: row("g2", "Bob", "Carol", "2026-10-29T10:00:00.000Z"),
  } }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  alice = cookieOf("Alice");
  bob = cookieOf("Bob");
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => resetAvatarRateLimit());

const put = (body: Buffer | string, who = alice, headers: Record<string, string> = { "x-cw-auth": "1" }) =>
  fetch(`${origin}/api/me/avatar`, { method: "PUT", headers: { cookie: who, "content-type": "image/png", ...headers }, body: body as BodyInit });
const del = (who = alice) => fetch(`${origin}/api/me/avatar`, { method: "DELETE", headers: { cookie: who, "x-cw-auth": "1" } });
const profile = async (who = alice) => (await (await fetch(`${origin}/api/me/profile`, { headers: { cookie: who } })).json()) as { avatar: string | null; avatarSource: string };
type Side = { coach: string; avatarUrl?: string };
const recent = async () => ((await (await fetch(`${origin}/api/recent-results`)).json()) as { results: Array<{ id: string; home: Side; away: Side }> }).results;
const card = async (id: string) => (await recent()).find((r) => r.id === id)!;
const bytesOf = async (path: string) => { const r = await fetch(`${origin}${path}`); return { status: r.status, type: r.headers.get("content-type"), body: Buffer.from(await r.arrayBuffer()) }; };

describe("coach avatar routes", () => {
  it("401 without a session, 403 without X-CW-Auth on a cookie write or without a site identity, 405 for other methods", async () => {
    expect((await fetch(`${origin}/api/me/avatar`, { method: "PUT", headers: { "x-cw-auth": "1" }, body: png(128, 128) as unknown as BodyInit })).status).toBe(401);
    expect((await fetch(`${origin}/api/me/avatar`, { method: "DELETE", headers: { "x-cw-auth": "1" } })).status).toBe(401);
    expect((await put(png(128, 128), alice, {})).status).toBe(403);
    expect((await put(png(128, 128), cookieOf("Ghost"))).status).toBe(403); // no identity record
    expect((await fetch(`${origin}/api/coach-avatars/alice`, { method: "PUT", headers: { cookie: alice, "x-cw-auth": "1" } })).status).not.toBe(200);
  });

  it("400 for a wrong type, too small or too large in pixels; 413 for too many bytes", async () => {
    expect((await put("<svg xmlns='http://www.w3.org/2000/svg'/>")).status).toBe(400);
    expect((await put(Buffer.from("GIF89a" + "x".repeat(40)))).status).toBe(400);
    expect((await put(png(32, 32))).status).toBe(400);
    expect((await put(png(2048, 2048))).status).toBe(400);
    const big = await put(png(128, 128, 600 * 1024)).then((r) => r.status, () => 413);
    expect(big).toBe(413);
    expect((await profile()).avatarSource).toBe("discord");
  });

  it("upload wins over Discord and is served by the site's route; Remove falls back to the PROXIED Discord avatar", async () => {
    // the signed-in owner's own account page may show the raw Discord URL
    expect(await profile()).toMatchObject({ avatarSource: "discord", avatar: "https://cdn.discordapp.com/avatars/111111/abc.png?size=256" });
    const res = await put(png(128, 128));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { avatarUrl: string; profile: { avatar: string; avatarSource: string } };
    expect(isAllowedCardAvatarUrl(body.avatarUrl)).toBe(true);
    expect(body.avatarUrl.startsWith("/api/coach-avatars/alice?v=")).toBe(true);
    expect(body.profile).toMatchObject({ avatarSource: "upload", avatar: body.avatarUrl });
    // stored hashed under the coach-avatars dir: no coach name in any path
    expect(readdirSync(join(root, "coach-avatars")).filter((n) => n !== "proxy-cache")).toEqual([sha("alice")]);
    expect(readdirSync(join(root, "coach-avatars", sha("alice")))).toEqual([`${sha("coach:alice")}.png`]);
    const got = await fetch(`${origin}${body.avatarUrl}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(Buffer.from(await got.arrayBuffer()).equals(png(128, 128))).toBe(true);
    expect((await fetch(`${origin}/api/coach-avatars/ALICE`)).status).toBe(200);
    expect((await fetch(`${origin}/api/coach-avatars/nobody`)).status).toBe(404); // no identity
    expect((await fetch(`${origin}/api/coach-avatars/carol`)).status).toBe(404); // identity, nothing to show
    const removed = await del();
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as { profile: { avatarSource: string } }).profile.avatarSource).toBe("discord");
    const before = cdnHits.length;
    const proxied = await bytesOf("/api/coach-avatars/alice");
    expect(proxied).toMatchObject({ status: 200, type: "image/png" });
    expect(proxied.body.equals(cdnPng)).toBe(true);
    expect(cdnHits.slice(before)).toEqual(["https://cdn.discordapp.com/avatars/111111/abc.png?size=64"]);
    await bytesOf("/api/coach-avatars/alice");
    expect(cdnHits.length).toBe(before + 1); // cached
  });

  it("an upload also wins over an admin-set avatar; removing it serves the admin one again (proxied)", async () => {
    expect((await profile(bob)).avatarSource).toBe("profile");
    expect((await put(png(96, 96), bob)).status).toBe(200);
    expect((await profile(bob)).avatarSource).toBe("upload");
    expect((await bytesOf("/api/coach-avatars/bob")).body.equals(png(96, 96))).toBe(true);
    expect((await del(bob)).status).toBe(200);
    expect(await profile(bob)).toMatchObject({ avatarSource: "profile", avatar: "https://cdn.discordapp.com/avatars/222222/admin.png" });
    expect((await bytesOf("/api/coach-avatars/bob")).status).toBe(200);
    expect(cdnHits).toContain("https://cdn.discordapp.com/avatars/222222/admin.png");
  });

  it("a ban hides the avatar at once (route 404, no card avatar); unbanning shows it again", async () => {
    const carol = cookieOf("Carol");
    expect((await put(png(80, 80), carol)).status).toBe(200);
    expect((await bytesOf("/api/coach-avatars/carol")).status).toBe(200);
    expect((await card("fork:g2")).away.avatarUrl).toMatch(/^\/api\/coach-avatars\/carol\?v=/);
    upsertIdentity({ ...ownIdentityRecord("Carol"), banned: true });
    expect((await bytesOf("/api/coach-avatars/carol")).status).toBe(404);
    expect("avatarUrl" in (await card("fork:g2")).away).toBe(false);
    expect((await put(png(80, 80), carol)).status).toBe(403); // a banned coach cannot publish one either
    upsertIdentity({ ...ownIdentityRecord("Carol"), banned: false });
    expect((await bytesOf("/api/coach-avatars/carol")).status).toBe(200);
  });

  it("a merged-away identity's upload is deleted and never served again", async () => {
    expect((await put(png(80, 80), cookieOf("Dave"))).status).toBe(200);
    expect((await bytesOf("/api/coach-avatars/dave")).status).toBe(200);
    mergeIdentityRecords("Dave", "Carol", "Admin");
    await new Promise((r) => setTimeout(r, 50)); // the upload removal runs after the write
    expect((await bytesOf("/api/coach-avatars/dave")).status).toBe(404);
    expect(readdirSync(join(root, "coach-avatars")).includes(sha("dave")) ? readdirSync(join(root, "coach-avatars", sha("dave"))) : []).toEqual([]);
  });

  it("a 40-character name that folds longer (40 x İ) uploads and is served by its URL", async () => {
    const res = await put(png(64, 64), cookieOf(DOTTED));
    expect(res.status).toBe(200);
    const { avatarUrl } = (await res.json()) as { avatarUrl: string };
    expect(isAllowedCardAvatarUrl(avatarUrl)).toBe(true);
    expect((await bytesOf(avatarUrl)).status).toBe(200);
    expect((await bytesOf(`/api/coach-avatars/${encodeURIComponent(DOTTED)}`)).status).toBe(200);
  });

  it("rate limits avatar changes to 10 a minute per coach (429 with retry-after), PUT and DELETE together", async () => {
    for (let i = 0; i < 10; i += 1) expect((await del()).status).toBe(200);
    const limited = await put(png(128, 128));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await del(bob)).status).toBe(200); // another coach has their own bucket
  });
});

describe("result cards carry coach avatars", () => {
  it("recent results: own-route URLs only, upload > admin-set > Discord, nothing Discord in the JSON, FUMBBL-only names get none", async () => {
    let g1 = await card("fork:g1");
    const discordToken = g1.home.avatarUrl!;
    expect(isAllowedCardAvatarUrl(discordToken)).toBe(true);
    expect("avatarUrl" in g1.away).toBe(false); // Zed has no site identity
    expect(isAllowedCardAvatarUrl((await card("fork:g2")).home.avatarUrl)).toBe(true); // Bob, admin-set
    expect((await put(png(128, 128))).status).toBe(200);
    g1 = await card("fork:g1");
    expect(g1.home.avatarUrl).not.toBe(discordToken); // a new source is a new token
    const rows = await recent();
    const text = JSON.stringify(rows);
    expect(text.toLowerCase()).not.toContain("discord");
    for (const id of ["111111", "222222", "abc.png", "admin.png", "alice_dc"]) expect(text).not.toContain(id);
    for (const r of rows) for (const s of [r.home, r.away]) if (s.avatarUrl) expect(isAllowedCardAvatarUrl(s.avatarUrl)).toBe(true);
    expect((await del()).status).toBe(200);
  });

  it("the game page card carries the same own-route avatarUrl and nothing Discord", async () => {
    const res = await fetch(`${origin}/api/games/online/g1`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.toLowerCase()).not.toContain("discord");
    expect(text).not.toContain("111111");
    const detail = JSON.parse(text) as { card: { home: Side; away: Side } };
    expect(detail.card.home.avatarUrl).toBe((await card("fork:g1")).home.avatarUrl);
    expect("avatarUrl" in detail.card.away).toBe(false);
  });
});
