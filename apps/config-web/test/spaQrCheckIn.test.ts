import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { alignmentPositions, dataCodewords, encodeQr, formatBits, interleave, qrSvgPath, rsDivisor, rsRemainder, versionBits, versionFor } from "../spa/src/shared/qr";

// QR check-in in the SPA (11-04): the QR encoder (checked by an independent decoder written from the standard's tables,
// and by published vectors), the coach's QR in My entry, the scan page (asks before it writes; the sign-in link never
// carries the token) and the organisers' venue QR page.

// ---- an independent decoder (spec tables for versions 1-10, level M) ----------------------------------------------------
const TOTAL = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const M_BLOCKS: Array<[number, number]> = [[0, 0], [1, 10], [1, 16], [1, 26], [2, 18], [2, 24], [4, 16], [4, 18], [4, 22], [5, 22], [5, 26]];
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const EXP: number[] = [];
const LOG: number[] = new Array(256).fill(0);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a]! + LOG[b]!) % 255]! : 0);

function decode(m: boolean[][]): { text: string; version: number; mask: number; ecl: number } {
  const size = m.length;
  const ver = (size - 17) / 4;
  const centres = ALIGN[ver]!;
  const isFn = (x: number, y: number): boolean => {
    if ((x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8)) return true;
    if (x === 6 || y === 6) return true;
    if (ver >= 7 && ((x >= size - 11 && x < size - 8 && y < 6) || (y >= size - 11 && y < size - 8 && x < 6))) return true;
    for (const cy of centres) for (const cx of centres) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === centres[centres.length - 1]) || (cy === 6 && cx === centres[centres.length - 1])) continue;
      if (Math.abs(x - cx) <= 2 && Math.abs(y - cy) <= 2) return true;
    }
    return false;
  };
  // finder centres and timing
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    expect(m[cy]![cx]).toBe(true);
    expect(m[cy]![cx - 2]).toBe(false);
    expect(m[cy]![cx - 3]).toBe(true);
  }
  for (let i = 8; i < size - 8; i++) { expect(m[6]![i]).toBe(i % 2 === 0); expect(m[i]![6]).toBe(i % 2 === 0); }
  expect(m[size - 8]![8]).toBe(true);
  // format information, both copies, BCH-checked
  const bitAt = (x: number, y: number) => (m[y]![x] ? 1 : 0);
  let f1 = 0, f2 = 0;
  const c1: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  c1.forEach(([x, y], i) => { f1 |= bitAt(x, y) << i; });
  for (let i = 0; i < 8; i++) f2 |= bitAt(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) f2 |= bitAt(8, size - 15 + i) << i;
  expect(f2).toBe(f1);
  const fmt = f1 ^ 0x5412;
  let rem = fmt;
  for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  expect(rem).toBe(0);
  const ecl = fmt >> 13;
  const mask = (fmt >> 10) & 7;
  // version information (7+), both copies, BCH-checked
  if (ver >= 7) {
    let v1 = 0, v2 = 0;
    for (let i = 0; i < 18; i++) { v1 |= bitAt(size - 11 + (i % 3), Math.floor(i / 3)) << i; v2 |= bitAt(Math.floor(i / 3), size - 11 + (i % 3)) << i; }
    expect(v2).toBe(v1);
    expect(v1 >> 12).toBe(ver);
    let r = v1;
    for (let i = 17; i >= 12; i--) if (r & (1 << i)) r ^= 0x1f25 << (i - 12);
    expect(r).toBe(0);
  }
  const maskFn = [
    (i: number, j: number) => (i + j) % 2 === 0, (i: number) => i % 2 === 0, (_i: number, j: number) => j % 3 === 0,
    (i: number, j: number) => (i + j) % 3 === 0, (i: number, j: number) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i: number, j: number) => ((i * j) % 2) + ((i * j) % 3) === 0, (i: number, j: number) => (((i * j) % 2) + ((i * j) % 3)) % 2 === 0,
    (i: number, j: number) => (((i * j) % 3) + ((i + j) % 2)) % 2 === 0,
  ][mask]!;
  // read the data in the zigzag, unmasked (i = row, j = column)
  const bits: number[] = [];
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let k = 0; k < size; k++) {
      const row = up ? size - 1 - k : k;
      for (const c of [col, col - 1]) if (!isFn(c, row)) bits.push((m[row]![c] ? 1 : 0) ^ (maskFn(row, c) ? 1 : 0));
    }
    up = !up;
  }
  const total = TOTAL[ver]!;
  const bytes: number[] = [];
  for (let i = 0; i < total; i++) bytes.push(bits.slice(i * 8, i * 8 + 8).reduce((a, b) => (a << 1) | b, 0));
  // de-interleave, then every block's Reed-Solomon syndromes are zero
  const [nb, ec] = M_BLOCKS[ver]!;
  const shortLen = Math.floor(total / nb);
  const longs = total % nb;
  const blocks: number[][] = Array.from({ length: nb }, () => []);
  let p = 0;
  for (let i = 0; i < shortLen - ec + 1; i++) for (let b = 0; b < nb; b++) {
    if (i === shortLen - ec && b < nb - longs) continue;
    blocks[b]!.push(bytes[p++]!);
  }
  for (let i = 0; i < ec; i++) for (let b = 0; b < nb; b++) blocks[b]!.push(bytes[p++]!);
  expect(p).toBe(total);
  for (const block of blocks) {
    for (let s = 0; s < ec; s++) {
      let acc = 0;
      for (const c of block) acc = mul(acc, EXP[s]!) ^ c;
      expect(acc).toBe(0);
    }
  }
  const data = blocks.flatMap((b) => b.slice(0, b.length - ec));
  const dbits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  const read = (from: number, n: number) => dbits.slice(from, from + n).reduce((a, b) => (a << 1) | b, 0);
  expect(read(0, 4)).toBe(0b0100);
  const countBits = ver <= 9 ? 8 : 16;
  const len = read(4, countBits);
  const out = Array.from({ length: len }, (_, i) => read(4 + countBits + i * 8, 8));
  return { text: new TextDecoder().decode(new Uint8Array(out)), version: ver, mask, ecl };
}

describe("QR encoder", () => {
  it("matches published vectors: HELLO WORLD 1-M error correction, version 7 information, alignment positions", () => {
    // thonky.com QR tutorial: "HELLO WORLD" as 1-M data codewords and their 10 EC codewords.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    expect(rsRemainder(data, rsDivisor(10))).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
    expect(versionBits(7)).toBe(0b000111110010010100);
    expect(formatBits(0)).toBe(0b101010000010010); // level M, mask 0
    expect(alignmentPositions(7)).toEqual([6, 22, 38]);
    expect(alignmentPositions(10)).toEqual([6, 28, 50]);
    expect([1, 2, 5, 7, 10].map(dataCodewords)).toEqual([16, 28, 86, 124, 216]);
    // byte capacity at level M
    expect([14, 15, 106, 107, 213, 214].map(versionFor)).toEqual([1, 2, 6, 7, 10, 11]);
    expect(interleave(new Array(16).fill(0), 1)).toHaveLength(26);
  });

  it("an independent decoder reads back every length and every mask (format and version info, RS syndromes, byte mode)", () => {
    const base = "https://superfumbbl.example/app/tournaments/3ebf1387-16d5-452d-8632-a403b307671c/check-in/p";
    const texts = ["hi", "https://example.org/", `${base}${"A".repeat(44)}`, `${base}${"Zz09_-".repeat(9)}`, "x".repeat(150), "é ü ß ✓ ".repeat(12), "y".repeat(210)];
    for (const text of texts) {
      const qr = encodeQr(text);
      const out = decode(qr.modules);
      expect(out.text).toBe(text);
      expect(out.ecl).toBe(0); // M
      expect(out.mask).toBe(qr.mask);
      expect(out.version).toBe(qr.version);
    }
    for (let mask = 0; mask < 8; mask++) expect(decode(encodeQr(`${base}${"q".repeat(44)}`, { mask }).modules).text).toBe(`${base}${"q".repeat(44)}`);
    // a check-in URL fits a small code
    expect(encodeQr(`${base}${"A".repeat(44)}`).version).toBeLessThanOrEqual(8);
    expect(() => encodeQr("z".repeat(3000))).toThrow();
    expect(qrSvgPath([[true, false], [false, true]], 4)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});

// ---- views ----------------------------------------------------------------------------------------------------------

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}
const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
const TOKEN = `p${"A".repeat(22)}${"B".repeat(22)}`;
const VENUE = `v${"C".repeat(22)}${"D".repeat(22)}`;
const tournament = (over: Partial<TournamentSummary> = {}): TournamentSummary => ({
  id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "nut-cup", maxPlayers: 4, roundCount: 3,
  currentRound: 0, tiebreakers: ["buchholz"], startsAt: "2026-12-05T09:00:00.000Z", entrantCount: 1, ownerCoachId: "Veers", organizerCoachIds: ["Piett"],
  remainingRounds: 3, registration: { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true } }, myEntrantId: "t1:entrant:1", ...over,
});
const entrant = (over: Partial<TournamentEntrant> = {}): TournamentEntrant => ({ id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", flags: { ...FLAGS }, ...over });
const CI = { opensAt: "2026-12-04T09:00:00.000Z", closesAt: "2026-12-05T09:00:00.000Z", self: true, open: true, closed: false };
const body = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(), entrants: [entrant()], rounds: [], scheduledMatches: [], capabilities: { manage: false, assignRoles: false },
  registrationStatus: { open: false, reason: "closed", message: "Registration is closed.", approval: "auto", waitlist: true, rosterLater: false, cap: 4, placesLeft: 3 },
  checkIn: CI, ...over,
});

describe("QR check-in views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, detail, vueRouter, renderer, sharedApi] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("/src/tournaments/detail.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/shared/api.ts"),
    ]);
    mods = { app, detail, vueRouter, renderer, sharedApi };
  }, 120_000);
  afterAll(async () => { await vite?.close(); });

  const AS = (coach: string) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord" } });
  async function render(path: string, routes: Routes, opts: { detail?: boolean } = {}) {
    const f = mockFetcher(routes);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    if (opts.detail !== false) {
      const d = mods.detail.createTournamentDetail({ api: f });
      await d.load("t1");
      spa.app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    return { html, calls: f.calls };
  }

  it("My entry: an accepted coach sees their QR (inline SVG) and the link as text; without a code yet, Get my code", async () => {
    const path = `/app/tournaments/t1/check-in/${TOKEN}`;
    const { html } = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body({ myRegistration: { ...entrant(), state: "accepted", checkInCode: { path } } }) });
    expect(html).toContain("data-check-in-code");
    expect(html).toMatch(/<svg[^>]*class="sf-qr"[^>]*aria-label="Your check-in QR code"/);
    expect(html).toContain(`data-check-in-url>${path}</code>`);
    expect(html).toContain(">New code</button>");
    expect(html).toContain("It works once.");
    const none = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body({ myRegistration: { ...entrant(), state: "accepted" } }) });
    expect(none.html).toContain(">Get my code</button>");
    expect(none.html).not.toContain('class="sf-qr"');
    // checked in, or not in the field: no code panel
    const done = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body({ entrants: [entrant({ flags: { ...FLAGS, checkedIn: true } })], myRegistration: { ...entrant({ flags: { ...FLAGS, checkedIn: true } }), state: "accepted" } }) });
    expect(done.html).not.toContain("data-check-in-code");
    const held = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body({ entrants: [], myRegistration: { ...entrant(), state: "waitlisted", position: 1 } }) });
    expect(held.html).not.toContain("data-check-in-code");
  });

  it("the scan page signed out: a sign-in card whose link goes back to the tournament (never the token); nothing is POSTed", async () => {
    const { html, calls } = await render(`/tournaments/t1/check-in/${TOKEN}`, { "/api/auth/session": { authenticated: false, ssoEnabled: true } }, { detail: false });
    expect(html).toContain("data-scan-signin");
    expect(html).not.toContain(TOKEN.slice(1, 20));
    expect(html).toContain(encodeURIComponent("/app/tournaments/t1"));
    // the header's Login button too: the sign-in flow is never handed the token
    expect(html).not.toContain(encodeURIComponent(`/check-in/${TOKEN}`));
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    expect(calls.some((c) => c.path.includes(TOKEN))).toBe(false);
  });

  it("the token-free page (after the URL was replaced, or a refresh) asks for a new scan and sends nothing", async () => {
    const { html, calls } = await render("/tournaments/t1/check-in", { ...AS("Alice") }, { detail: false });
    expect(html).toContain("data-scan-again");
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("the scan page signed in: the read is a POST with the token in the body (preview only); Check in is a button", async () => {
    const preview = { state: "ready", kind: "personal", tournament: { id: "t1", name: "Spike Open" }, entry: { coach: "Alice", team: "Alice Orcs" }, checkIn: CI };
    const { html, calls } = await render(`/tournaments/t1/check-in/${TOKEN}`, { ...AS("Veers"), "POST /api/tournaments/t1/check-in/qr": () => preview }, { detail: false });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toEqual([{ path: "/api/tournaments/t1/check-in/qr", method: "POST", body: { token: TOKEN } }]);
    expect(calls.every((c) => !c.path.includes(TOKEN))).toBe(true);
    expect(html).toContain("data-scan-confirm>Check in</button>");
    expect(html).toContain("<strong>Alice (Alice Orcs)</strong>");
    // a refusal shows the server's words
    const refused = await render(`/tournaments/t1/check-in/${TOKEN}`, { ...AS("Bob"), "POST /api/tournaments/t1/check-in/qr": () => new mods.sharedApi.ApiError(403, "This check-in code belongs to another coach.", { code: "not-yours" }) }, { detail: false });
    expect(refused.html).toContain('data-refusal="not-yours"');
    expect(refused.html).not.toContain("data-scan-confirm");
  });

  it("the venue page (organisers): the big QR and its link as text, New code and Switch off; off shows Switch on", async () => {
    const path = `/app/tournaments/t1/check-in/${VENUE}`;
    const on = await render("/tournaments/t1/venue-qr", { ...AS("Veers"), "/api/tournaments/t1/check-in/venue": { enabled: true, revision: 2, path, checkIn: CI } }, { detail: false });
    expect(on.html).toContain("data-venue-qr");
    expect(on.html).toMatch(/aria-label="Venue check-in QR code"/);
    expect(on.html).toContain(`data-venue-url>${path}</code>`);
    for (const a of ["data-venue-full", "data-venue-rotate", "data-venue-off"]) expect(on.html).toContain(a);
    const off = await render("/tournaments/t1/venue-qr", { ...AS("Veers"), "/api/tournaments/t1/check-in/venue": { enabled: false, revision: 3, checkIn: CI } }, { detail: false });
    expect(off.html).toContain("data-venue-on");
    expect(off.html).not.toContain("data-venue-qr");
  });

  it("public address: the QR and the link use the origin the server sent; no origin = this page's, a loopback one warns organisers", async () => {
    const path = `/app/tournaments/t1/check-in/${TOKEN}`;
    const vpath = `/app/tournaments/t1/check-in/${VENUE}`;
    const W = "This code points at this computer; set PUBLIC_BASE_URL so phones can open it.";
    const mine = (origin?: string, manage = false) => body({ capabilities: { manage, assignRoles: false }, myRegistration: { ...entrant(), state: "accepted", checkInCode: { path, ...(origin ? { origin } : {}) } } });
    const set = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": mine("https://superfumbbl.example") });
    expect(set.html).toContain(`data-check-in-url>https://superfumbbl.example${path}</code>`);
    expect(set.html).not.toContain("data-qr-loopback");
    const venue = await render("/tournaments/t1/venue-qr", { ...AS("Veers"), "/api/tournaments/t1/check-in/venue": { enabled: true, revision: 2, path: vpath, origin: "https://superfumbbl.example", checkIn: CI } }, { detail: false });
    expect(venue.html).toContain(`data-venue-url>https://superfumbbl.example${vpath}</code>`);
    expect(venue.html).not.toContain("data-qr-loopback");
    // the fallback, opened as 127.0.0.1: the organisers (venue page, a managing coach's own card) see the warning; a coach doesn't
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
    const prev = g.window;
    g.window = { location: { origin: "http://127.0.0.1:4310" } };
    try {
      const loopVenue = await render("/tournaments/t1/venue-qr", { ...AS("Veers"), "/api/tournaments/t1/check-in/venue": { enabled: true, revision: 2, path: vpath, checkIn: CI } }, { detail: false });
      expect(loopVenue.html).toContain(`data-venue-url>http://127.0.0.1:4310${vpath}</code>`);
      expect(loopVenue.html).toContain(`data-qr-loopback>${W}</p>`);
      const org = await render("/tournaments/t1", { ...AS("Piett"), "/api/tournaments/t1": mine(undefined, true) });
      expect(org.html).toContain(`data-check-in-url>http://127.0.0.1:4310${path}</code>`);
      expect(org.html).toContain("data-qr-loopback");
      const plain = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": mine() });
      expect(plain.html).not.toContain("data-qr-loopback");
      // an invalid origin from the server is ignored like an unset one
      const bad = await render("/tournaments/t1/venue-qr", { ...AS("Veers"), "/api/tournaments/t1/check-in/venue": { enabled: true, revision: 2, path: vpath, origin: "javascript:alert(1)", checkIn: CI } }, { detail: false });
      expect(bad.html).toContain(`data-venue-url>http://127.0.0.1:4310${vpath}</code>`);
      expect(bad.html).toContain("data-qr-loopback");
    } finally { if (had) g.window = prev; else delete g.window; }
  });

  it("styles: tokens only (the QR's black and white are root tokens, the same in both themes); the router keeps the token in the path only", () => {
    const css = readFileSync(new URL("../spa/src/tournaments/registration.css", import.meta.url), "utf8");
    const qr = readFileSync(new URL("../spa/src/components/QrCode.vue", import.meta.url), "utf8");
    for (const s of [css.slice(css.indexOf("/* The personal check-in QR")), qr.slice(qr.indexOf("<style>"))]) expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(/i);
    const home = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(home).toMatch(/--sf-qr-light: #ffffff;/);
    const router = readFileSync(new URL("../spa/src/router.ts", import.meta.url), "utf8");
    expect(router).toContain('path: "/tournaments/:id([\\\\w-]{1,64})/check-in/:token([pv][A-Za-z0-9_-]{44})"');
    expect(router).not.toMatch(/name: "tournament-check-in",[^}]*requiresAuth: true/);
  });
});
