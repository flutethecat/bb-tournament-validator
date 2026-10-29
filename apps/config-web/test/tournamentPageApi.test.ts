import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { BANNER_MAX_BYTES, checkBanner, orderedNews, parsePagePatch, safeHttpUrl, tournamentBannerApi } from "../src/tournaments/page.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { resetAvatarRateLimit } from "../src/teamAvatars.js";
import type { TournamentRecord } from "../src/tournaments/types.js";

// Tournament page extras (spec-main-landing-nav §3): banner, page fields, news.

const roots: string[] = [];
const now = new Date("2026-10-29T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const helper: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
const admin: TournamentApiIdentity = { coach: "Root", organizer: true, admin: true };
const stranger: TournamentApiIdentity = { coach: "Alice", organizer: false, admin: false };

beforeEach(() => resetAvatarRateLimit());
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { store: TournamentStore; root: string; t: TournamentRecord } {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-page-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const t = store.createTournament({ name: "Spike Open", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Veers", roundCount: 3 }, now);
  store.addOrganizer(t.id, "Piett", now);
  store.registerEntrant(t.id, { coachId: "Bob", ffbCoachId: "Bob", verifiedAt: now.toISOString() }, "team-bob", now);
  return { store, root, t: store.tournament(t.id)! };
}

function deps(store: TournamentStore): TournamentApiDeps {
  return { store, packageExists: (n) => n === "Rules", teamBuild: () => undefined, now: () => now };
}
const call = (store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) =>
  tournamentApi(method, path, new URLSearchParams(), auth, body, deps(store));

/** A header-only PNG of the given size (the guards read dimensions from the IHDR; no decode). */
function png(width: number, height: number, pad = 64): Buffer {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const banner = (store: TournamentStore, root: string, method: string, id: string, auth: TournamentApiIdentity | undefined, body?: Buffer, declared?: number) =>
  tournamentBannerApi(method, `/api/tournaments/${id}/banner`, auth, {
    store, dataDir: root, now: () => now,
    readBody: async (max) => (body && body.length > max ? undefined : body ?? Buffer.alloc(0)),
    declaredTooLarge: (max) => declared !== undefined && declared > max,
  });

describe("banner guards", () => {
  it("checkBanner: magic bytes, 1 MB cap, 1200-2400 px wide, landscape", () => {
    expect(checkBanner(png(1600, 400)).ok).toBe(true);
    expect(checkBanner(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")).ok).toBe(false);
    expect(checkBanner(png(1199, 300))).toMatchObject({ ok: false, error: expect.stringContaining("1200 to 2400") });
    expect(checkBanner(png(2401, 300)).ok).toBe(false);
    expect(checkBanner(png(1600, 1700)).ok).toBe(false);
    expect(checkBanner(png(1600, 400, BANNER_MAX_BYTES))).toMatchObject({ ok: false, error: expect.stringContaining("1 MB") });
  });

  it("a manager uploads: hashed file under tournament-banners, bannerUrl on the read model, public GET, replace drops the old file", async () => {
    const { store, root, t } = setup();
    const up = await banner(store, root, "PUT", t.id, helper, png(1600, 400));
    expect(up?.status).toBe(200);
    const rel = store.tournament(t.id)!.bannerPath!;
    expect(rel).toMatch(/^tournament-banners\/[a-f0-9]{64}\.png$/);
    expect(existsSync(join(root, rel))).toBe(true);
    const detail = await call(store, "GET", `/api/tournaments/${t.id}`);
    const body = detail!.body as { tournament: Record<string, unknown> };
    expect(body.tournament.bannerUrl).toMatch(new RegExp(`^/api/tournaments/${t.id}/banner\\?v=[a-f0-9]{12}$`));
    expect(body.tournament).not.toHaveProperty("bannerPath");
    const read = await banner(store, root, "GET", t.id, undefined);
    expect(read).toMatchObject({ status: 200, file: { path: join(root, rel), contentType: "image/png" } });
    await banner(store, root, "PUT", t.id, owner, png(2000, 500));
    expect(store.tournament(t.id)!.bannerPath).not.toBe(rel);
    expect(readdirSync(join(root, "tournament-banners"))).toHaveLength(1);
    const del = await banner(store, root, "DELETE", t.id, admin);
    expect(del?.status).toBe(204);
    expect(store.tournament(t.id)!.bannerPath).toBeUndefined();
    expect(readdirSync(join(root, "tournament-banners"))).toHaveLength(0);
    expect((await banner(store, root, "GET", t.id, undefined))?.status).toBe(404);
  });

  it("refuses bad magic, too big (declared and streamed), wrong width, non-manager 403, anonymous 401", async () => {
    const { store, root, t } = setup();
    expect((await banner(store, root, "PUT", t.id, owner, Buffer.from("GIF89a-not-allowed-at-all-padding-padding")))?.status).toBe(400);
    expect(await banner(store, root, "PUT", t.id, owner, png(1600, 400), BANNER_MAX_BYTES + 1)).toMatchObject({ status: 413, close: true });
    expect(await banner(store, root, "PUT", t.id, owner, png(1600, 400, BANNER_MAX_BYTES))).toMatchObject({ status: 413, close: true });
    expect((await banner(store, root, "PUT", t.id, owner, png(800, 200)))?.status).toBe(400);
    expect((await banner(store, root, "PUT", t.id, stranger, png(1600, 400)))?.status).toBe(403);
    expect((await banner(store, root, "DELETE", t.id, stranger))?.status).toBe(403);
    expect((await banner(store, root, "PUT", t.id, undefined, png(1600, 400)))?.status).toBe(401);
    expect((await banner(store, root, "PUT", "nope", owner, png(1600, 400)))?.status).toBe(404);
    expect(store.tournament(t.id)!.bannerPath).toBeUndefined();
    expect(existsSync(join(root, "tournament-banners"))).toBe(false);
  });

  it("overlapping PUT and DELETE (identical bytes) never leave bannerPath pointing at a missing file", async () => {
    const { store, root, t } = setup();
    const bytes = png(1600, 400);
    const other = png(1800, 450);
    const delayedPut = (body: Buffer, auth: TournamentApiIdentity) => tournamentBannerApi("PUT", `/api/tournaments/${t.id}/banner`, auth, {
      store, dataDir: root, now: () => now,
      readBody: () => new Promise((resolve) => setImmediate(() => resolve(body))),
    });
    const remove = (auth: TournamentApiIdentity) => banner(store, root, "DELETE", t.id, auth);
    const invariant = () => {
      const rel = store.tournament(t.id)!.bannerPath;
      const dir = join(root, "tournament-banners");
      const files = existsSync(dir) ? readdirSync(dir) : [];
      if (rel) expect(existsSync(join(root, rel)), `bannerPath ${rel} must exist`).toBe(true);
      expect(files.filter((f) => !f.endsWith(".tmp")).map((f) => `tournament-banners/${f}`)).toEqual(rel ? [rel] : []);
    };
    for (let i = 0; i < 15; i++) {
      resetAvatarRateLimit();
      expect((await banner(store, root, "PUT", t.id, owner, bytes))?.status).toBe(200);
      const results = await Promise.all([delayedPut(bytes, helper), remove(owner), delayedPut(other, admin), remove(helper), delayedPut(bytes, owner)]);
      expect(results.every((r) => r && [200, 204].includes(r.status))).toBe(true);
      invariant();
      // The last mutation to enter the queue wins: the final PUT of identical bytes.
      expect(store.tournament(t.id)!.bannerPath).toMatch(/^tournament-banners\/[a-f0-9]{64}\.png$/);
      resetAvatarRateLimit();
      await Promise.all([delayedPut(bytes, owner), remove(admin)]);
      invariant();
    }
  });

  it("rate-limits banner changes per coach (10 a minute, PUT and DELETE share it)", async () => {
    const { store, root, t } = setup();
    for (let i = 0; i < 10; i++) expect((await banner(store, root, "DELETE", t.id, owner))?.status).toBe(204);
    const limited = await banner(store, root, "PUT", t.id, owner, png(1600, 400));
    expect(limited?.status).toBe(429);
    expect(limited?.headers?.["retry-after"]).toMatch(/^\d+$/);
    // Another coach has their own bucket; team avatars are a separate key.
    expect((await banner(store, root, "DELETE", t.id, helper))?.status).toBe(204);
  });
});

describe("page settings (PATCH)", () => {
  it("saves location, start time, fee, summary, notes, deadlines; null or empty clears", async () => {
    const { store, t } = setup();
    const res = await call(store, "PATCH", `/api/tournaments/${t.id}`, helper, {
      location: { venue: "The Dugout", address: "1 Pitch Lane", mapUrl: "https://maps.example.org/?q=dugout" },
      startTime: "09:30", entryFee: "15 GBP", summary: "Two days of **Swiss**.", notes: "- dice\n- rosters",
      deadlines: { registration: "2026-11-20T23:59:00Z", checkIn: "2026-11-28T09:00:00Z" },
    });
    expect(res?.status).toBe(200);
    const record = store.tournament(t.id)!;
    expect(record).toMatchObject({
      location: { venue: "The Dugout", address: "1 Pitch Lane", mapUrl: "https://maps.example.org/?q=dugout" },
      startTime: "09:30", entryFee: "15 GBP", deadlines: { registration: "2026-11-20T23:59:00Z", checkIn: "2026-11-28T09:00:00Z" },
    });
    expect(record.maxPlayers).toBe(8);
    await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { location: null, summary: "", deadlines: { registration: "", checkIn: "2026-11-28T09:00:00Z" } });
    const after = store.tournament(t.id)!;
    expect(after.location).toBeUndefined();
    expect(after.summary).toBeUndefined();
    expect(after.deadlines).toEqual({ checkIn: "2026-11-28T09:00:00Z" });
    expect(after.notes).toBe("- dice\n- rosters");
  });

  it("validates lengths, URLs, times and dates, and writes nothing on a refusal", async () => {
    const { store, t } = setup();
    const refuse = async (body: Record<string, unknown>, text: string) => {
      const res = await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { maxPlayers: 10, ...body });
      expect(res?.status, JSON.stringify(body).slice(0, 60)).toBe(400);
      expect((res?.body as { error: string }).error).toContain(text);
    };
    await refuse({ summary: "x".repeat(4001) }, "summary must be at most 4000");
    await refuse({ notes: "x".repeat(2001) }, "notes must be at most 2000");
    await refuse({ location: { mapUrl: "javascript:alert(1)" } }, "http(s) link");
    await refuse({ location: { mapUrl: "https://user:pw@example.org/" } }, "http(s) link");
    await refuse({ startTime: "25:00" }, "24-hour time");
    await refuse({ deadlines: { registration: "next friday" } }, "deadlines.registration");
    await refuse({ entryFee: 15 }, "entryFee must be a string");
    expect(store.tournament(t.id)!.maxPlayers).toBe(8);
    expect(safeHttpUrl("http://example.org")).toBe(true);
    expect(safeHttpUrl("ftp://example.org")).toBe(false);
    expect(parsePagePatch({ summary: "4000 ok".padEnd(4000, ".") }).summary).toHaveLength(4000);
  });

  it("only managers may edit the page", async () => {
    const { store, t } = setup();
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, stranger, { summary: "Hi" }))?.status).toBe(403);
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}`, undefined, { summary: "Hi" }))?.status).toBe(401);
  });

  it("public detail redaction is unchanged: page fields are public, flags and problems stay private", async () => {
    const { store, t } = setup();
    await call(store, "PATCH", `/api/tournaments/${t.id}`, owner, { summary: "Welcome", entryFee: "Free" });
    const anon = (await call(store, "GET", `/api/tournaments/${t.id}`))!.body as { tournament: Record<string, unknown>; entrants: Array<Record<string, unknown>>; scheduledMatches: unknown[]; capabilities: { manage: boolean } };
    expect(anon.tournament).toMatchObject({ summary: "Welcome", entryFee: "Free" });
    expect(anon.entrants[0]).not.toHaveProperty("flags");
    expect(anon.scheduledMatches).toEqual([]);
    expect(anon.capabilities.manage).toBe(false);
    // The list stays light: no summary, notes or news.
    const list = (await tournamentApi("GET", "/api/tournaments", new URLSearchParams("status=all"), undefined, undefined, deps(store)))!.body as { tournaments: Array<Record<string, unknown>> };
    expect(list.tournaments[0]).toMatchObject({ entryFee: "Free" });
    expect(list.tournaments[0]).not.toHaveProperty("summary");
  });
});

describe("news", () => {
  it("managers post, edit, pin and delete; the read model is pinned first, newest first", async () => {
    const { store, t } = setup();
    let clock = new Date("2026-10-29T12:00:00.000Z");
    const d = (): TournamentApiDeps => ({ ...deps(store), now: () => clock });
    const post = async (auth: TournamentApiIdentity, body: unknown) => tournamentApi("POST", `/api/tournaments/${t.id}/news`, new URLSearchParams(), auth, body, d());
    const first = await post(owner, { title: "Venue confirmed", body: "See the facts strip." });
    expect(first?.status).toBe(201);
    clock = new Date("2026-10-30T12:00:00.000Z");
    const second = await post(helper, { title: "Dice rule", body: "Bring your own dice.", pinned: false });
    clock = new Date("2026-10-31T12:00:00.000Z");
    const third = await post(owner, { title: "Schedule", body: "Round 1 at 09:30." });
    const ids = [first, second, third].map((r) => (r!.body as { post: { id: string } }).post.id);
    expect((second!.body as { post: { by: string } }).post.by).toBe("Piett");
    let news = ((await call(store, "GET", `/api/tournaments/${t.id}`))!.body as { tournament: { news: Array<{ id: string }> } }).tournament.news;
    expect(news.map((n) => n.id)).toEqual([ids[2], ids[1], ids[0]]);
    const pin = await tournamentApi("PATCH", `/api/tournaments/${t.id}/news/${ids[0]}`, new URLSearchParams(), helper, { pinned: true }, d());
    expect(pin?.status).toBe(200);
    news = (pin!.body as { news: Array<{ id: string }> }).news;
    expect(news.map((n) => n.id)).toEqual([ids[0], ids[2], ids[1]]);
    const edit = await tournamentApi("PATCH", `/api/tournaments/${t.id}/news/${ids[1]}`, new URLSearchParams(), owner, { body: "Dice provided." }, d());
    expect((edit!.body as { post: { body: string; editedAt?: string } }).post).toMatchObject({ body: "Dice provided.", editedAt: clock.toISOString() });
    const del = await tournamentApi("DELETE", `/api/tournaments/${t.id}/news/${ids[2]}`, new URLSearchParams(), admin, undefined, d());
    expect((del!.body as { news: unknown[] }).news).toHaveLength(2);
    expect((await tournamentApi("DELETE", `/api/tournaments/${t.id}/news/${ids[2]}`, new URLSearchParams(), admin, undefined, d()))?.status).toBe(404);
  });

  it("validates title and body, and refuses non-managers", async () => {
    const { store, t } = setup();
    const post = (auth: TournamentApiIdentity | undefined, body: unknown) => call(store, "POST", `/api/tournaments/${t.id}/news`, auth, body);
    expect((await post(owner, { title: "", body: "x" }))?.status).toBe(400);
    expect((await post(owner, { title: "x".repeat(121), body: "x" }))?.status).toBe(400);
    expect((await post(owner, { title: "Hi", body: "x".repeat(4001) }))?.status).toBe(400);
    expect((await post(owner, { title: "Hi", body: "Yo", pinned: "yes" }))?.status).toBe(400);
    expect((await post(stranger, { title: "Hi", body: "Yo" }))?.status).toBe(403);
    expect((await post(undefined, { title: "Hi", body: "Yo" }))?.status).toBe(401);
    const ok = await post(owner, { title: "Hi", body: "Yo" });
    const id = (ok!.body as { post: { id: string } }).post.id;
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}/news/${id}`, stranger, { pinned: true }))?.status).toBe(403);
    expect((await call(store, "PATCH", `/api/tournaments/${t.id}/news/${id}`, owner, {}))?.status).toBe(400);
    expect((await call(store, "DELETE", `/api/tournaments/${t.id}/news/${id}`, stranger))?.status).toBe(403);
    expect(store.tournament(t.id)!.news).toHaveLength(1);
  });

  it("orderedNews is stable for equal times", () => {
    const at = "2026-10-29T12:00:00.000Z";
    const out = orderedNews([
      { id: "a", title: "A", body: "a", by: "x", at, pinned: false },
      { id: "b", title: "B", body: "b", by: "x", at, pinned: false },
      { id: "c", title: "C", body: "c", by: "x", at: "2026-10-01T00:00:00Z", pinned: true },
    ]);
    expect(out.map((n) => n.id)).toEqual(["c", "b", "a"]);
  });
});
