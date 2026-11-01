import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";

// Game page (/app/games/:source/:id, owner 10-30: "Clicking a game should open the Match reporter view that we currently
// have but with a completed state"): the recorder's screen read-only and finished. Rendered server-side through the SPA's Vite config.

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
    return { html: await mods.renderToString(spa.app), f, spa };
  }
  const page = (html: string) => html.slice(html.indexOf('class="tt-rec tt-rec--final"'));
  const plain = (html: string) => html.slice(html.indexOf('class="gs-page"'));

  it("online: the match reporter, completed and read-only: final scoreboard, result-only Match log, summaries, Rosters; no controls", async () => {
    const { html, f } = await render("/games/online/g1", signedOut({ "/api/games/online/g1": online, "/crests/manifest.json": { crests: { orc: "crests/orc.png" } } }));
    const p = page(html);
    expect(f.calls).toContain("/api/games/online/g1");
    expect(html).toContain('class="tt-rec tt-rec--final"');
    expect(p).not.toContain("Login with Discord");
    expect(p).toContain('<h2 class="tt-final-h">Reavers vs Grinders</h2>'); // the reporter's own title is no longer an h1
    expect(p).not.toContain("<h1 class=\"tt-final-h\">");
    expect(p).toContain('src="/crests/orc.png"'); // the race crest from the manifest
    expect(p).toContain('class="tt-board"');
    expect(p).toMatch(/<p class="tt-score" aria-label="Score"><span>2<\/span><span class="tt-score-colon">:<\/span><span>1<\/span>(<!---->)?<\/p>/);
    expect(p).toContain('<span class="tt-stats-half">Final</span>');
    expect(p).toContain("CAS <b>1</b>");
    expect(p).not.toContain("FOULS"); // the fixture's lines carry no fouls: none are shown
    expect(p).not.toContain('class="tt-turns"'); // no turn track, clock or turn button
    expect(p).not.toContain("tt-endturn");
    expect(p).not.toContain('class="tt-cog"');
    expect(p).not.toContain("tt-rail");
    expect(p).not.toContain("tt-actions-bar");
    expect(p).not.toContain("tt-trash"); // no undo
    expect(p).toContain("Match log (from the game result; order not recorded)");
    expect(p).toContain("Final: Reavers 2-1 Grinders");
    expect((p.match(/data-type="touchdown"/g) ?? []).length).toBe(3); // Grak x2, Snik x1
    expect(p).toContain('data-type="casualty"');
    expect(p).toContain('data-type="mvp"');
    expect(p).toContain(" suffered 1 Badly Hurt.");
    expect(p).not.toMatch(/class="tt-ev-mark"/); // no half or turn is shown for a fork result
    expect(p).toContain("&lt;b&gt;Snik&lt;/b&gt;");
    expect(p).not.toContain("<b>Snik</b>");
    expect((p.match(/class="tt-panel tt-summary"/g) ?? []).length).toBe(2);
    expect(p).toContain("Won 2-1");
    expect(p).not.toContain("SPP"); // the fork result carries no SPP
    expect(p).not.toContain("post-match not applied");
    expect(p).toContain("Played online on the Super FUMBBL client");
    expect(p).toContain(">Rosters</button>");
    expect(p).toContain('href="/app/lobby#recent-games"'); // signed out: Past Games is under the sign-in card
  });

  it("tournament without player data: the scoreboard, a 'No match log' note, the concession and the Rounds tab link", async () => {
    const fixture = { ...tournament, card: card("Spike Beta Test · Round 3", { concede: "away", away: side("Grinders", "Dwarf", "Bob", 1, null) }) };
    const { html } = await render("/games/tournament/m1", signedOut({ "/api/games/tournament/m1": fixture }));
    const p = page(html);
    expect(p).toContain("Spike Beta Test · Round 3");
    expect(p).toContain("No match log for this fixture");
    expect(p).toContain("Per-player stats are recorded for games played through the site.");
    expect(p).toContain("CAS <b>–</b>"); // away casualties not recorded: a dash, never a 0
    expect(p).not.toContain("legal concession"); // no server verdict: nothing said
    expect(p).toMatch(/data-type="concede"[^]*?data-team="away">Grinders<\/span> concedes the match\./); // the concession row, without player data
    expect(p).toContain("Final: Reavers 2-1 Grinders · Grinders conceded");
    expect(p).toContain('<span class="tt-conceded tt-nameline">Conceded</span>');
    expect((p.match(/href="\/app\/tournaments\/t1\?tab=rounds"/g) ?? []).length).toBe(1);
    expect(p).toContain("Tournament rounds");
  });

  it("online: a league fixture's banked legal-concession verdict is in the log's concession line", async () => {
    const legal = { ...online, id: "g9", card: card("Online · BB2025", { concede: "away" }), summary: { ...online.summary, concede: "away", concededLegally: false } };
    const p = page((await render("/games/online/g9", signedOut({ "/api/games/online/g9": legal }))).html);
    expect(p).toContain("concedes the match (not a legal concession).");
  });

  it("tabletop: the recorded moments in order with half and turn, both reporter summaries (no treasury) and the recorder link", async () => {
    const { html } = await render("/games/tabletop/tm1", signedOut({ "/api/games/tabletop/tm1": tabletop }));
    const p = page(html);
    expect(p).toContain('<h2 class="tt-label tt-log-h">Match log</h2>');
    expect(p).toContain('<span class="tt-ev-mark">H1 T3</span>');
    expect(p).toContain('data-type="touchdown"');
    expect((p.match(/class="tt-panel tt-summary"/g) ?? []).length).toBe(2);
    expect(p).toContain("Won 1-0");
    expect(p).toContain("winnings 10k");
    expect(p).toContain("fans 3 to 4");
    expect(p).not.toContain("treasury");
    expect(p).toContain("SI");
    expect(p).toContain("+7 SPP");
    expect(p).toMatch(/<a href="\/app\/tabletop\/tm1" class="sf-btn">Open in the recorder<\/a>/);
  });

  it("unknown, unsupported and failing games: friendly notes, never a stack trace", async () => {
    const missing = plain((await render("/games/online/nope", signedOut())).html);
    expect(missing).toContain("Game not found");
    const failing = plain((await render("/games/online/g1", signedOut({ "/api/games/online/g1": new ApiError(500, "Internal stack trace at foo.ts:1") }))).html);
    expect(failing).toContain("The game could not be loaded");
    expect(failing).not.toContain("stack trace");
    const bad = (await render("/games/fork/g1", signedOut())).html;
    expect(bad).toContain(`<h1 class="sf-page-title" aria-live="polite">Page not found</h1>`);
  });

  it("the recorder renders its finished-game summary through the shared component", () => {
    const view = readFileSync(new URL("../spa/src/views/TabletopRecorderView.vue", import.meta.url), "utf8");
    expect(view).toContain('<TabletopMatchSummary v-for="[s, sum] in summaries()"');
  });
});
