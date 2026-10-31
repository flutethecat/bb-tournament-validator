import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { RACE_TONE_FALLBACK, raceTone } from "../spa/src/shared/raceTone";
import { RECENT_RESULTS_MAX } from "../src/recentResults";

// Recent games strip (owner 10-30): the signed-out landing page (under the sign-in card) and the coach page (after
// Deadlines), plus the shared ResultCard markup. Rendered server-side through the SPA's own Vite config.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
// The strip asks for everything the API allows.
const RECENT = `/api/recent-results?limit=${RECENT_RESULTS_MAX}`;

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

const side = (name: string, race: string, coach: string, score: number | null, cas: number | null, crestUrl: string | null = null) => ({ name, race, coach, crestUrl, score, cas });
const results = () => ({
  results: [
    { id: "tournament:m1", source: "tournament", context: "Spike Beta Test", playedAt: "2026-10-29T10:00:00.000Z", href: "/app/games/tournament/m1", home: side("Carol's Crushers", "Orc", "Carol", 0, 1), away: side("Dan's Darlings", "Wood Elf", "Dan", 4, null), concede: null, suspended: false },
    { id: "tabletop:x", source: "tabletop", context: "Tabletop · Friendly", playedAt: "2026-10-28T10:00:00.000Z", href: "/app/games/tabletop/x", home: side("<b>Bold</b> Boys", "Dwarf", "Eve<script>", 2, 0), away: side("Nameless", "", "Finn", 1, 0), concede: "away", suspended: false },
  ],
});
const signedOut = (extra: Routes = {}): Routes => ({ "/api/auth/session": { authenticated: false, discordSsoEnabled: true }, ...extra });
const signedIn = (extra: Routes = {}): Routes => ({
  "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
  "/api/me/deadlines": { timezone: "Europe/London", deadlines: [] },
  "/api/build-log": { entries: [] },
  "/api/tabletop/saves?coach=Alice": { coach: "Alice", saves: [], teams: [] },
  "/api/account": { ffbCoachId: "Alice" },
  ...extra,
});

describe("race tone", () => {
  it("maps race names loosely and falls back dark", () => {
    expect(raceTone("Wood Elf")).toBe(raceTone("wood_elf"));
    expect(raceTone("Orc (BB2025)")).toBe(raceTone("Orc"));
    expect(raceTone("")).toBe(RACE_TONE_FALLBACK);
    expect(raceTone("Martians")).toBe(RACE_TONE_FALLBACK);
  });
});

describe("recent games (SSR)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: unknown; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void> } };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    ResultCard: unknown;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, card] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/components/ResultCard.vue"),
    ]);
    mods = { createSpa: app.createSpa, createMemoryHistory: vueRouter.createMemoryHistory, renderToString: renderer.renderToString, ResultCard: card.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes) {
    const f = mockFetcher(routes);
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), f };
  }
  const strip = (html: string) => html.slice(html.indexOf('id="recent-games"'), html.indexOf("</section>", html.indexOf('id="recent-games"')));

  it("signed-out landing (/ -> /lobby): the strip sits under the sign-in card with the count and one card per game", async () => {
    const { html, f } = await render("/", signedOut({ [RECENT]: results(), "/crests/manifest.json": { crests: { dwarf: "crests/dwarf.png" } } }));
    expect(html).toContain("Login with Discord");
    expect(html.indexOf("Login with Discord")).toBeLessThan(html.indexOf('id="recent-games"'));
    expect(html).toMatch(/<h2 id="rc-recent-h">Past Games<\/h2><span class="hm-cap">\(2\)<\/span>/);
    expect((strip(html).match(/class="rc-card"/g) ?? []).length).toBe(2);
    expect(strip(html)).toContain('<span class="rc-comp">Spike Beta Test</span>');
    expect(strip(html)).toContain('<span class="rc-comp">Tabletop · Friendly</span>');
    expect(strip(html)).not.toContain("Round 3");
    // in-SPA links for /app paths; casualties shown only when known
    expect(strip(html)).toMatch(/<a href="\/app\/games\/tournament\/m1" class="rc-card"[^>]*aria-label=/);
    expect(strip(html)).toMatch(/<a href="\/app\/games\/tabletop\/x" class="rc-card"/);
    expect(strip(html)).toContain('<small class="rc-cas">(1)</small>');
    expect((strip(html).match(/class="rc-cas"/g) ?? []).length).toBe(3); // 1, (null: none), 0, 0
    // race crest from the manifest when the team has no avatar; initials otherwise
    expect(strip(html)).toContain('src="/crests/dwarf.png"');
    // the concede line names the conceding side's COACH; the plate sits behind that score only; no strikethrough marker
    expect(strip(html)).toContain("Conceded by Finn");
    expect(strip(html)).not.toContain("Conceded by Nameless");
    expect((strip(html).match(/class="rc-score" data-conceded="true"/g) ?? []).length).toBe(1);
    expect((strip(html).match(/<span class="rc-plate-cap">Conceded<\/span>/g) ?? []).length).toBe(1);
    expect(strip(html)).not.toContain('class="rc-team rc-away" data-conceded');
    // Past Games: a scroll box of large cards, at most two columns
    expect(strip(html)).toMatch(/<div class="rc-scroll"[^>]*><ul class="rc-grid rc-grid-lg"/);
    expect(strip(html)).toContain('data-size="lg"');
    expect(f.calls).toContain(`/api/recent-results?limit=${RECENT_RESULTS_MAX}`);
    expect(f.calls).toContain(RECENT);
  });

  it("signed-out empty and failing reads both show the empty note, never an error", async () => {
    const empty = (await render("/lobby", signedOut({ [RECENT]: { results: [] } }))).html;
    expect(strip(empty)).toContain('<p class="hm-empty">No games recorded yet.</p>');
    expect(strip(empty)).toContain('<span class="hm-cap">(0)</span>');
    const failing = (await render("/lobby", signedOut({ [RECENT]: new ApiError(500, "Internal stack trace at foo.ts:1") }))).html;
    expect(strip(failing)).toContain("No games recorded yet.");
    expect(failing).not.toContain("stack trace");
  });

  it("coach page: the strip closes the main column after Deadlines", async () => {
    const { html } = await render("/home", signedIn({ [RECENT]: results() }));
    const main = html.slice(html.indexOf("hm-col-main"), html.indexOf("hm-col-side"));
    expect(main).toContain('id="recent-games"');
    expect(main.indexOf('id="deadlines"')).toBeLessThan(main.indexOf('id="recent-games"'));
    expect((strip(html).match(/class="rc-card"/g) ?? []).length).toBe(2);
  });

  async function card(props: Record<string, unknown>) {
    return mods.renderToString(createSSRApp(mods.ResultCard as never, props));
  }

  it("ResultCard escapes names and coaches, falls back to initials, and refuses unsafe crests and tones", async () => {
    const html = await card({
      context: "Tabletop · <i>Friendly</i>",
      home: side("<img src=x onerror=alert(1)> Raiders", "Orc", "Eve<script>", 3, 2, "javascript:alert(1)"),
      away: side("Night Owls", "Wood Elf", "Finn", 1, null, "/api/team-avatars/n.png"),
      tone: { home: "red; background:url(x)", away: "#123456" },
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; Raiders");
    expect(html).toContain("Eve&lt;script&gt;");
    expect(html).toContain("Tabletop · &lt;i&gt;Friendly&lt;/i&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).toMatch(/<span class="rc-crest rc-initials" aria-hidden="true">IS<\/span>/); // first letter or digit of the first two words
    expect(html).toContain('src="/api/team-avatars/n.png"');
    expect(html).not.toContain("url(x)");
    expect(html).toContain("--rc-away:#123456");
    expect(html).toContain(`--rc-home:${raceTone("Orc")}`);
    expect(html).toMatch(/^<div class="rc-card"/); // no href: not a link
    expect(await card({ context: "x", home: side("A", "", "", 1, null), away: side("B", "", "", 0, null), href: "javascript:alert(1)" })).toMatch(/^<div class="rc-card"/);
    expect(html).toContain('<small class="rc-cas">(2)</small>');
    expect((html.match(/class="rc-cas"/g) ?? []).length).toBe(1);
  });

  it("ResultCard (owner 10-31): date only on top, competition under the score and cas, race under the crest, white name, avatar or letter badge", async () => {
    const html = await card({
      context: "TABBL · Season 6", playedAt: "2026-10-29T10:00:00.000Z",
      home: { ...side("Rot Girl Summer", "Nurgle", "Jeff", 1, 2, "/crests/nurgle.png"), avatarUrl: "/api/coach-avatars/jeff?v=0123456789abcdef" },
      away: { ...side("Grudge Rollers", "Dwarf", "Kay", 2, 0, "/crests/dwarf.png"), avatarUrl: "javascript:alert(1)" },
    });
    // no phase / group / round text; the top line carries only the date
    expect(html).not.toMatch(/Round|Regular/);
    expect(html).toMatch(/<p class="rc-top"><time class="rc-when" datetime="2026-10-29T10:00:00.000Z">29 Oct 2026<\/time><\/p>/);
    expect(html).not.toContain("rc-context");
    // the context sits in the centre column after the score block (and its cas lines)
    const centre = html.slice(html.indexOf('class="rc-centre"'), html.indexOf('class="rc-team rc-away"'));
    expect(centre.indexOf('class="rc-cas"')).toBeGreaterThan(-1);
    expect(centre.indexOf('class="rc-cas"')).toBeLessThan(centre.indexOf('<span class="rc-comp">TABBL · Season 6</span>'));
    // race under the crest, inside the crest column, not under the name
    expect(html).toMatch(/<span class="rc-crestcol"><img class="rc-crest" src="\/crests\/nurgle.png"[^>]*><span class="rc-race">Nurgle<\/span><\/span>/);
    expect(html).not.toMatch(/<span class="rc-name">[^<]*<\/span><span class="rc-race"/);
    // white team-name class; the shadow itself is in result-card.css
    expect(html).toContain('<span class="rc-name">Rot Girl Summer</span>');
    const css = readFileSync(fileURLToPath(new URL("../spa/src/shared/result-card.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.rc-name \{[^}]*color: var\(--rc-name-ink\); text-shadow: var\(--rc-name-shadow\)/);
    expect(css).toMatch(/--rc-name-ink: var\(--ui-text-on-primary, #ffffff\); --rc-name-shadow: var\(--rc-num-shadow\)/); // dark themes: white + shadow
    expect(css).toMatch(/:root\[data-theme="light"\] \.rc-card \{ --rc-name-ink: var\(--ui-text, #131519\)/); // light theme: dark ink
    // the sides stack when the CARD is narrow (container query), not the viewport
    expect(css).toMatch(/container-type: inline-size/);
    expect(css).toMatch(/@container \(max-width: 560px\)/);
    // avatar: the provided safe URL renders as a round image; an unsafe or missing one falls back to the letter badge
    expect(html).toContain('<img class="rc-avatar" src="/api/coach-avatars/jeff?v=0123456789abcdef"');
    expect(html).not.toContain("javascript:");
    expect(html).toContain('<span class="rc-avatar" aria-hidden="true">K</span>');
    const none = await card({ context: "Online · Friendly", home: side("A", "Orc", "Zed", 1, 0), away: side("B", "Orc", "Yan", 0, 0) });
    expect(none).not.toContain("<img class=\"rc-avatar\"");
    expect((none.match(/class="rc-avatar" aria-hidden="true"/g) ?? []).length).toBe(2);
    expect(none).toContain('<span class="rc-comp">Online · Friendly</span>');
  });

  it("ResultCard: missing scores show a dash, external hrefs are plain links, suspended games say so", async () => {
    const html = await card({ context: "Online · Friendly", home: side("A Team", "", "", null, null), away: side("B Team", "", "", null, null), href: "https://example.test/g/1", suspended: true });
    expect(html).toMatch(/^<a href="https:\/\/example.test\/g\/1" class="rc-card"/);
    expect((html.match(/<span class="rc-num">–/g) ?? []).length).toBe(2);
    expect(html).toContain('data-suspended="true"');
    expect(html).toContain('<p class="rc-flag">Suspended</p>');
    expect(html).toContain(`--rc-home:${RACE_TONE_FALLBACK}`);
  });

  it("ResultCard: names show literally and are escaped exactly once; the concede plate only appears on conceded cards", async () => {
    const name = `<script>brains? & "Co" 'op' >`;
    const html = await card({ context: "x", home: side(name, "Orc", "A&B", 1, 0), away: side("Plain", "Dwarf", "Zed", 0, 0), concede: "home" });
    expect(html).toContain("&lt;script&gt;brains? &amp; &quot;Co&quot; &#39;op&#39; &gt;");
    expect(html).not.toContain("&amp;lt;");
    expect(html).not.toContain("&amp;amp;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("Conceded by A&amp;B");
    expect(html).not.toContain("line-through");
    const plain = await card({ context: "x", home: side("A", "", "a", 1, 0), away: side("B", "", "b", 0, 0) });
    expect(plain).not.toContain("rc-plate-cap");
    expect(plain).not.toContain("data-conceded");
    expect(plain).not.toContain("rc-flag");
    expect(plain).not.toContain("data-size");
    expect(await card({ context: "x", home: side("A", "", "a", 1, 0), away: side("B", "", "b", 0, 0), size: "lg" })).toContain('data-size="lg"');
  });

  it("scroll boxes hand off to the page at their ends: no overscroll containment on Past Games, What's new or My teams", () => {
    const cardCss = readFileSync(new URL("../spa/src/shared/result-card.css", import.meta.url), "utf8");
    const homeCss = readFileSync(new URL("../spa/src/home/home.css", import.meta.url), "utf8");
    expect(cardCss).toMatch(/\.rc-scroll \{[^}]*overflow-y: auto/);
    for (const rule of [cardCss.match(/\.rc-scroll \{[^}]*\}/)![0], homeCss.match(/\.hm-log-strip \{[^}]*\}/)![0], homeCss.match(/\.hm-teams-strip \{[^}]*\}/)![0]]) {
      expect(rule).not.toMatch(/overscroll-behavior/);
    }
  });

  it("result cards are bevelled panels: frame, top highlight, 4 px drop, lift to a 6 px drop on linked cards, score text shadow", () => {
    const css = readFileSync(new URL("../spa/src/shared/result-card.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.rc-card \{[^}]*border: 2px solid var\(--sf-panel-line[^}]*border-radius: 2px;[^}]*box-shadow: 0 4px 0 var\(--sf-panel-drop[^}]*inset 0 1px 0 var\(--sf-panel-hi/);
    expect(css).toMatch(/a\.rc-card:hover, a\.rc-card:focus-visible \{ transform: translateY\(-2px\); box-shadow: 0 6px 0 var\(--sf-panel-drop/);
    expect(css).toMatch(/\.rc-num \{[^}]*text-shadow: var\(--rc-num-shadow\)/);
    expect(css).toContain("--rc-num-shadow: 2px 2px 0 rgb(0 0 0 / 80%), 0 0 10px rgb(0 0 0 / .45)");
    expect(css).toMatch(/linear-gradient\(135deg/); // the team tint stays under the bezel
  });
});
