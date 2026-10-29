import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";

// Game page (/app/games/:source/:id, owner 10-30): the hero result card, the Summary panel and, for tabletop matches,
// the match reporter's summary read-only with a link into the recorder. Rendered server-side through the SPA's Vite config.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

type Routes = Record<string, unknown>;
function mockFetcher(routes: Routes): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (path: string) => {
    calls.push(path);
    const hit = routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

const side = (name: string, race: string, coach: string, score: number | null, cas: number | null) => ({ name, race, coach, crestUrl: null, score, cas });
const team = (over: Record<string, unknown> = {}) => ({ mvps: [], scorers: [], casualtyMakers: [], players: [], casualtiesSuffered: null, ...over });
const pline = (name: string, over: Record<string, unknown> = {}) => ({ name, touchdowns: 0, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, ...over });
const summary = (over: Record<string, unknown> = {}) => ({
  playedAt: "2026-10-02T09:00:00.000Z", competition: "Online · Friendly", round: null, tournament: null,
  casualties: { home: 1, away: 2 }, concede: null, perPlayer: false, note: "Per-player stats are recorded for games played through the site.", home: null, away: null, ...over,
});
const card = (context: string, over: Record<string, unknown> = {}) => ({
  context, home: side("Reavers", "Orc", "Alice", 2, 1), away: side("Grinders", "Dwarf", "Bob", 1, 2), playedAt: "2026-10-02T09:00:00.000Z", href: null, concede: null, suspended: false, ...over,
});

const online = {
  source: "online", id: "g1", card: card("Online · BB2025"),
  summary: summary({
    competition: "Online · BB2025", perPlayer: true, note: null,
    home: team({ mvps: ["Grak"], scorers: [{ name: "Grak", count: 2 }], casualtyMakers: [{ name: "Bonk", count: 1 }], players: [pline("Grak", { touchdowns: 2, mvp: 1 }), pline("Bonk", { casualtiesCaused: 1 })], casualtiesSuffered: { bh: 1, si: 0, rip: 0 } }),
    away: team({ scorers: [{ name: "<b>Snik</b>", count: 1 }], players: [pline("<b>Snik</b>", { touchdowns: 1 })] }),
  }),
};
const tournament = {
  source: "tournament", id: "m1", card: card("Spike Beta Test · Round 3", { concede: "away" }),
  summary: summary({ competition: "Spike Beta Test · Round 3", round: 3, tournament: { id: "t1", name: "Spike Beta Test", href: "/app/tournaments/t1?tab=rounds" }, casualties: { home: 1, away: null }, concede: "away" }),
};
const rsum = (outcome: string, f: number, a: number, players: unknown[]) => ({
  postMatch: "spp-only", applied: true, score: { for: f, against: a }, outcome, players, deaths: [], winnings: 10_000, fansBefore: 3, fansAfter: 4,
});
const tabletop = {
  source: "tabletop", id: "tm1", card: card("Tabletop · Friendly", { home: side("Night Owls", "Orc", "Eve", 1, 1), away: side("Rats", "Skaven", "Finn", 0, 0) }),
  summary: summary({
    competition: "Tabletop · Friendly", perPlayer: true, note: null,
    home: team({ mvps: ["Grim"], scorers: [{ name: "Grim", count: 1 }], players: [pline("Grim", { touchdowns: 1, mvp: 1, sppEarned: 7 })] }),
    away: team({ players: [pline("Squeak", { injury: "SI", sppEarned: 0 })] }),
  }),
  reporter: {
    matchId: "tm1", href: "/app/tabletop/tm1", state: "confirmed",
    summaries: {
      home: rsum("won", 1, 0, [{ id: "p1", name: "Grim", touchdowns: 1, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 1, sentOff: false, sppEarned: 7 }]),
      away: rsum("lost", 0, 1, [{ id: "q2", name: "Squeak", touchdowns: 0, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 0, injury: { result: "SI", apothecaryUsed: false } }]),
    },
    moments: [{ half: 1, turn: 3, side: "home", kind: "touchdown", text: "Touchdown: Grim" }],
  },
};
const signedOut = (extra: Routes = {}): Routes => ({ "/api/auth/session": { authenticated: false, discordSsoEnabled: true }, ...extra });

describe("game page (SSR)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: unknown; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer] = await Promise.all([vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer")]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes) {
    const f = mockFetcher(routes);
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), f };
  }
  const page = (html: string) => html.slice(html.indexOf('class="gs-page"'));

  it("online: public, hero card (not a link), summary facts, scorers and per-player table; no match report", async () => {
    const { html, f } = await render("/games/online/g1", signedOut({ "/api/games/online/g1": online, "/crests/manifest.json": { crests: { orc: "crests/orc.png" } } }));
    const p = page(html);
    expect(f.calls).toContain("/api/games/online/g1");
    expect(p).not.toContain("Login with Discord");
    expect(p).toMatch(/<div class="gs-hero"><div class="rc-card"[^>]*data-size="lg"/);
    expect(p).toContain('src="/crests/orc.png"');
    expect(p).toContain('<h2 id="gs-summary-h">Summary</h2>');
    expect(p).toContain("Online · BB2025");
    expect(p).toContain("Reavers 1 (suffered 1 BH, 0 SI, 0 dead)");
    expect(p).toContain("Grak (Reavers)"); // MVP line
    expect(p).toContain("Grak ×2");
    expect(p).toContain("&lt;b&gt;Snik&lt;/b&gt;");
    expect(p).not.toContain("<b>Snik</b>");
    expect(p).toContain('class="gs-table"');
    expect(p).not.toContain(">SPP<"); // the fork result carries no SPP
    expect(p).toContain("Played online on the Super FUMBBL client");
    expect(p).not.toContain("Per-player stats are recorded");
    expect(p).not.toContain('id="match-report"');
    expect(p).toContain('href="/app/lobby#recent-games"'); // signed out: Past Games is under the sign-in card
  });

  it("tournament: the per-player note, the concession, and links to the Rounds tab", async () => {
    const { html } = await render("/games/tournament/m1", signedOut({ "/api/games/tournament/m1": tournament }));
    const p = page(html);
    expect(p).toContain("Spike Beta Test · Round 3");
    expect(p).toContain("Per-player stats are recorded for games played through the site.");
    expect(p).toContain("Conceded by Bob (Grinders)");
    expect(p).toContain("Grinders not recorded");
    expect((p.match(/href="\/app\/tournaments\/t1\?tab=rounds"/g) ?? []).length).toBe(2);
    expect(p).toContain("Tournament rounds");
    expect(p).not.toContain('class="gs-table"');
    expect(p).not.toContain('id="match-report"');
  });

  it("tabletop: the match report panel with key moments, both reporter summaries (no treasury) and the recorder link", async () => {
    const { html } = await render("/games/tabletop/tm1", signedOut({ "/api/games/tabletop/tm1": tabletop }));
    const p = page(html);
    expect(p).toContain('<h2 id="gs-report-h">Match report</h2>');
    expect(p).toContain('<span class="gs-at">H1 T3</span>Touchdown: Grim');
    expect((p.match(/class="tt-panel tt-summary"/g) ?? []).length).toBe(2);
    expect(p).toContain("Won 1-0");
    expect(p).toContain("winnings 10k");
    expect(p).toContain("fans 3 to 4");
    expect(p).not.toContain("treasury");
    expect(p).toContain("SI");
    expect(p).toMatch(/<a href="\/app\/tabletop\/tm1" class="lobby-btn primary">Open match reporter<\/a>/);
    expect(p).toContain(">SPP<");
  });

  it("unknown, unsupported and failing games: friendly notes, never a stack trace", async () => {
    const missing = page((await render("/games/online/nope", signedOut())).html);
    expect(missing).toContain("Game not found");
    const failing = page((await render("/games/online/g1", signedOut({ "/api/games/online/g1": new ApiError(500, "Internal stack trace at foo.ts:1") }))).html);
    expect(failing).toContain("The game could not be loaded");
    expect(failing).not.toContain("stack trace");
    const bad = (await render("/games/fork/g1", signedOut())).html;
    expect(bad).toContain("Page not found");
  });

  it("the recorder renders its finished-game summary through the shared component", () => {
    const view = readFileSync(new URL("../spa/src/views/TabletopRecorderView.vue", import.meta.url), "utf8");
    expect(view).toContain('<TabletopMatchSummary v-for="[s, sum] in summaries()"');
  });
});
