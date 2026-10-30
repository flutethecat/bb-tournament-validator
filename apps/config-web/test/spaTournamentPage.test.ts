import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type TournamentDetailResponse, type TournamentEntrant, type TournamentSummary } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  createTournamentDetail, factsStrip, formatLine, newsList, placesLeft, rulesetCreatorHref, rulesetInitials, safeBannerUrl,
} from "../spa/src/tournaments/detail";
import { parseInline, parseMarkdownLite, safeLink } from "../spa/src/tournaments/markdown";

// Tournament page extras (spec-main-landing-nav §3): front block, facts strip, summary / notes, news, page settings.

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

const NEWS = [
  { id: "n1", title: "Old news", body: "First post.", by: "Veers", at: "2026-10-01T10:00:00Z", pinned: false },
  { id: "n2", title: "Newest", body: "Second post.", by: "Piett", at: "2026-10-20T10:00:00Z", pinned: false },
  { id: "n3", title: "Pinned rules", body: "Read **this**.", by: "Veers", at: "2026-09-01T10:00:00Z", pinned: true },
];

const tournament = (over: Partial<TournamentSummary> = {}): TournamentSummary => ({
  id: "t1", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 5,
  currentRound: 0, tiebreakers: ["buchholz"], startsAt: "2026-11-28T09:00:00.000Z", endsAt: "2026-11-29T18:00:00.000Z",
  entrantCount: 2, ownerCoachId: "Veers", organizerCoachIds: ["Piett"], pairingSystem: "dutch", seedingMode: "elo", remainingRounds: 5,
  location: { venue: "The Dugout", address: "1 Pitch Lane", mapUrl: "https://maps.example.org/?q=dugout" },
  startTime: "09:30", entryFee: "15 GBP",
  deadlines: { registration: "2026-11-20T23:59:00.000Z", checkIn: "2026-11-28T09:00:00.000Z" },
  summary: "Two days of **Swiss** play.\n\nSee [the pack](https://example.org/pack) and <script>alert(1)</script>.",
  notes: "- dice\n- printed roster",
  news: NEWS,
  ...over,
});

const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
const alice = (over: Partial<TournamentEntrant> = {}): TournamentEntrant => ({
  id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", race: "Orc", flags: { ...FLAGS }, ...over,
});
const detailBody = (over: Partial<TournamentDetailResponse> = {}): TournamentDetailResponse => ({
  tournament: tournament(), entrants: [alice()], rounds: [], scheduledMatches: [], capabilities: { manage: false, assignRoles: false }, ...over,
});

describe("markdown-lite", () => {
  it("paragraphs, bold, italic, http(s) links and lists; anything else stays text", () => {
    const blocks = parseMarkdownLite("Hello **big** *world*\nline two\n\n- one\n- [two](https://x.org/a)\n\n1. first\n2. second");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "ul", "ol"]);
    expect(blocks[0]).toMatchObject({ kind: "p", lines: [[{ kind: "text", text: "Hello " }, { kind: "strong" }, { kind: "text", text: " " }, { kind: "em" }], [{ kind: "text", text: "line two" }]] });
    expect(blocks[1]).toMatchObject({ items: [[{ kind: "text", text: "one" }], [{ kind: "link", href: "https://x.org/a", text: "two" }]] });
    expect(parseInline("[x](javascript:alert(1))")[0]).toMatchObject({ kind: "text", text: "x" });
    expect(parseInline("<img src=x onerror=alert(1)>")).toEqual([{ kind: "text", text: "<img src=x onerror=alert(1)>" }]);
    expect(parseInline("see https://example.org/a.")).toEqual([{ kind: "text", text: "see " }, { kind: "link", href: "https://example.org/a", text: "https://example.org/a" }, { kind: "text", text: "." }]);
    expect(safeLink("https://u:p@example.org")).toBe("");
    expect(safeLink("data:text/html,x")).toBe("");
    expect(parseMarkdownLite("")).toEqual([]);
  });
});

describe("page helpers", () => {
  it("facts strip carries location, dates, start time, ruleset link, format, fee, places, organisers, deadlines", () => {
    const facts = Object.fromEntries(factsStrip(tournament()).map((f) => [f.key, f]));
    expect(facts.location).toMatchObject({ value: "The Dugout", sub: "1 Pitch Lane", subHref: "https://maps.example.org/?q=dugout" });
    expect(facts.dates?.value).toBe("2026-11-28 to 2026-11-29");
    expect(facts.startTime?.value).toBe("09:30");
    expect(facts.ruleset).toMatchObject({ value: "nut-cup", href: "/tournament-team-builder.html?package=nut-cup" });
    expect(facts.format?.value).toBe("Swiss · Dutch · 5 rounds");
    expect(facts.entryFee?.value).toBe("15 GBP");
    expect(facts.places?.value).toBe("6");
    expect(facts.organisers?.value).toBe("Veers, Piett");
    expect(facts.registration?.value).toBe("2026-11-20 23:59 UTC");
    expect(facts.checkIn?.value).toBe("2026-11-28 09:00 UTC");
  });

  it("absent facts are left out; uncapped hides places left", () => {
    const bare = tournament({ location: undefined, startTime: undefined, entryFee: undefined, deadlines: undefined, maxPlayers: 0 });
    const keys = factsStrip(bare).map((f) => f.key);
    for (const k of ["location", "startTime", "entryFee", "places", "registration", "checkIn"]) expect(keys).not.toContain(k);
    expect(placesLeft(bare)).toBeNull();
    expect(formatLine({ format: "roundRobin", roundCount: 1 })).toBe("Round robin · 1 round");
    expect(rulesetInitials("nut-cup")).toBe("NC");
    expect(rulesetInitials("Eurobowl")).toBe("EU");
    expect(rulesetCreatorHref("nut cup")).toBe("/app/tournament-creator?package=nut%20cup");
    expect(safeBannerUrl("/api/tournaments/t1/banner?v=abc123")).toBe("/api/tournaments/t1/banner?v=abc123");
    expect(safeBannerUrl("https://evil.example/banner.png")).toBe("");
    expect(newsList(tournament()).map((n) => n.id)).toEqual(["n3", "n2", "n1"]);
  });

  it("controller: page save, banner upload / remove and news writes hit their routes and refetch", async () => {
    const f = mockFetcher({
      "GET /api/tournaments/t1": detailBody(),
      "PATCH /api/tournaments/t1": { tournament: {} },
      "DELETE /api/tournaments/t1/banner": undefined,
      "POST /api/tournaments/t1/news": { post: {} },
      "PATCH /api/tournaments/t1/news/n2": { post: {} },
      "DELETE /api/tournaments/t1/news/n2": { news: [] },
    });
    const uploads: Array<{ path: string; size: number }> = [];
    const d = createTournamentDetail({ api: f, upload: async (path, body) => { uploads.push({ path, size: body.size }); return { ok: true }; } });
    await d.load("t1");
    await d.savePage({ summary: "Hi", location: null });
    expect(f.calls.find((c) => c.method === "PATCH" && c.path === "/api/tournaments/t1")?.body).toEqual({ summary: "Hi", location: null });
    expect(d.state.notice).toBe("Tournament page saved.");
    expect(d.state.lastAction).toBe("page");
    await d.uploadBanner(new Blob([new Uint8Array(10)], { type: "image/png" }));
    expect(uploads).toEqual([{ path: "/api/tournaments/t1/banner", size: 10 }]);
    await d.removeBanner();
    await d.postNews({ title: "T", body: "B", pinned: true });
    expect(f.calls.find((c) => c.method === "POST")?.body).toEqual({ title: "T", body: "B", pinned: true });
    await d.editNews("n2", { pinned: true });
    await d.deleteNews("n2");
    expect(d.state.lastAction).toBe("news:n2");
    expect(f.calls.filter((c) => c.path === "/api/tournaments/t1" && c.method === "GET").length).toBeGreaterThanOrEqual(7);
  });

  it("a refused banner upload shows the server's message", async () => {
    const f = mockFetcher({ "GET /api/tournaments/t1": detailBody() });
    const d = createTournamentDetail({ api: f, upload: async () => { throw new ApiError(400, "The banner must be 1200 to 2400 pixels wide."); } });
    await d.load("t1");
    await d.uploadBanner(new Blob([new Uint8Array(1)], { type: "image/png" }));
    expect(d.state.actionError).toBe("The banner must be 1200 to 2400 pixels wide.");
  });
});

describe("tournament page views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, detail, vueRouter, renderer] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
    ]);
    mods = { app, detail, vueRouter, renderer };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const AS = (coach: string) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord" } });

  async function render(path: string, routes: Routes) {
    const f = mockFetcher({ ...ANON, "/api/fork/library?coach=Alice": { teams: [] }, "/api/fork/team-builder/saves": { saves: [] }, ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    spa.app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("overview without a banner: the ruleset crest on the hero gradient, facts strip, summary, notes, news (pinned first)", async () => {
    const html = await render("/tournaments/t1", { "/api/tournaments/t1": detailBody() });
    expect(html).toContain('data-banner="crest"');
    expect(html).toContain("tn-front-crest");
    expect(html).toMatch(/<text class="tn-crest-text"[^>]*>NC<\/text>/);
    expect(html).not.toContain("tn-front-img");
    for (const text of ["The Dugout", "1 Pitch Lane", "09:30", "15 GBP", "Swiss · Dutch · 5 rounds", "Places left", "Registration closes", "2026-11-20 23:59 UTC", "Check-in by"])
      expect(html, text).toContain(text);
    expect(html).toContain('href="/tournament-team-builder.html?package=nut-cup"');
    expect(html).toContain('href="https://maps.example.org/?q=dugout"');
    // SSR fragment markers sit between the tags; strip them for the structural checks.
    const flat = html.replace(/<!--[\s\S]*?-->/g, "");
    expect(flat).toContain("<strong>Swiss</strong>");
    expect(html).toContain('href="https://example.org/pack"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("What to bring");
    expect(flat).toContain("<li>printed roster</li>");
    const order = ["Pinned rules", "Newest", "Old news"].map((t) => html.indexOf(t));
    expect(order[0]).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).toContain("Sign in to register");
    expect(html).not.toContain("Post news");
    expect(html).not.toContain(">Edit ruleset</a>");
  });

  it("with a banner: the image renders (same-origin URL only) and the Series chip links to the series page", async () => {
    const body = detailBody({ tournament: tournament({ bannerUrl: "/api/tournaments/t1/banner?v=abcdef123456", seriesId: "s1" }) });
    const html = await render("/tournaments/t1", { "/api/tournaments/t1": body });
    expect(html).toContain('data-banner="image"');
    expect(html).toContain('src="/api/tournaments/t1/banner?v=abcdef123456"');
    expect(html).toContain('href="/app/series/s1"');
    const evil = detailBody({ tournament: tournament({ bannerUrl: "javascript:alert(1)" }) });
    expect(await render("/tournaments/t1", { "/api/tournaments/t1": evil })).toContain('data-banner="crest"');
  });

  it("an entrant sees Registered: <team> with Change and Withdraw", async () => {
    const body = detailBody({ tournament: tournament({ myEntrantId: "t1:entrant:1" }) });
    const html = await render("/tournaments/t1", { ...AS("Alice"), "/api/tournaments/t1": body });
    expect(html).toMatch(/Registered: <strong>Alice Orcs<\/strong>/);
    expect(html).toContain(">Change</a>");
    expect(html).toContain(">Withdraw</button>");
    expect(html).toContain("#tn-entry-h");
  });

  it("a signed-in coach not entered gets Register; a manager gets Edit, Edit ruleset, the news composer and per-post actions", async () => {
    const notEntered = await render("/tournaments/t1", { ...AS("Bob"), "/api/tournaments/t1": detailBody({ entrants: [] }) });
    expect(notEntered).toMatch(/>Register<\/a>/);
    const body = detailBody({ capabilities: { manage: true, assignRoles: true } });
    const html = await render("/tournaments/t1", { ...AS("Veers"), "/api/tournaments/t1": body });
    expect(html).toContain(">Edit</a>");
    expect(html).toContain("tab=manage#tn-page-h");
    expect(html).toContain('href="/app/tournament-creator?package=nut-cup"');
    expect(html).toContain("Post news");
    expect(html).toContain(">Unpin</button>");
    expect(html).toContain("Delete news Old news");
  });

  it("manage tab: the Tournament page settings with every page field and the banner upload", async () => {
    const body = detailBody({ capabilities: { manage: true, assignRoles: true }, tournament: tournament({ bannerUrl: "/api/tournaments/t1/banner?v=abc" }) });
    const html = await render("/tournaments/t1?tab=manage", { ...AS("Veers"), "/api/tournaments/t1": body });
    expect(html).toContain('id="tn-page-h"');
    for (const label of ["Venue", "Address", "Map link", "Start time", "Entry fee", "Registration closes (UTC)", "Check-in by (UTC)", "What to bring", "Upload banner", "Remove banner"])
      expect(html, label).toContain(label);
    expect(html).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(html).toContain('value="The Dugout"');
    expect(html).toContain('maxlength="4000"');
    expect(html).toContain('maxlength="2000"');
  });

  it("copy and layout rules: tokens only, a 375 px rule for the facts strip and front block, no hyphenated reroll", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tournaments/tournaments.css", import.meta.url)), "utf8");
    const lane = css.slice(css.indexOf("tournament page (lane 6)"));
    expect(lane).toMatch(/@media \(max-width: 420px\) \{[\s\S]*\.tn-facts-strip \{ grid-template-columns: 1fr; \}/);
    expect(lane).toMatch(/@media \(max-width: 760px\) \{[\s\S]*\.tn-front\[data-banner="crest"\] \.tn-front-body \{ padding-right: 16px;/);
    expect(lane).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    expect(lane).toContain("min-width: 0");
    for (const file of ["TournamentFront", "TournamentOverview", "TournamentNews", "TournamentPageForm", "MarkdownLite", "MarkdownInline"]) {
      const src = readFileSync(fileURLToPath(new URL(`../spa/src/components/${file}.vue`, import.meta.url)), "utf8");
      expect(src, file).not.toMatch(/re-roll/i);
      expect(src, file).not.toMatch(/Java client|FUMBBL art/i);
      expect(src, file).not.toContain("v-html");
    }
  });
});
