import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Public team view page (owner 10-27). No jsdom in the repo: the pure core renders markup we assert on, and the
// controller runs against a tiny DOM stub (one root element + the nav links carrying data-*-only flags).
const publicDir = new URL("../public/", import.meta.url);
const js = readFileSync(new URL("team-view.js", publicDir), "utf8");
const html = readFileSync(new URL("team-view.html", publicDir), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const context: Record<string, unknown> = { console, URLSearchParams };
runInNewContext(js, context);
const TeamView = context.TeamView as Any;

const TOKEN = "0123456789abcdef0123456789abcdef";
const fixture = () => ({
  teamName: "Grudge <XI>",
  coach: "Alice",
  raceName: "Dwarf",
  crest: "crests/dwarf.png",
  ruleset: { name: "EuroBowl 2026", tierLabel: "Tier 2" },
  updatedAt: "2026-10-27T09:00:00.000Z",
  players: [
    { number: 1, position: "Blocker Lineman", positionFull: "Dwarf Blocker Lineman", isStar: false, stats: { MA: 4, ST: 3, AG: "4+", PA: "5+", AV: "10+" },
      printed: [{ name: "Block", category: "General" }, { name: "Thick Skull", category: "Strength" }],
      added: [{ name: "Tackle", category: "General", access: "primary" }, { name: "Guard", category: "Strength", access: "secondary" }],
      statIncreases: [], cost: 70000, sprite: "sprites/dwarf/dwarfblockerlineman.png" },
    { number: 2, position: "Runner", positionFull: "Dwarf Runner", isStar: false, stats: { MA: 7, ST: 3, AG: "3+", PA: "4+", AV: "9+" },
      printed: [{ name: "Sure Hands", category: "General" }], added: [], statIncreases: ["MA"], cost: 85000, sprite: "https://evil.example/x.png" },
    { number: 3, position: "Grim Ironjaw", isStar: true, stats: { MA: 5, ST: 4, AG: "3+", PA: "-", AV: "9+" },
      printed: [{ name: "Loner (4+)", category: "Trait" }], added: [], statIncreases: [], cost: 200000, sprite: null },
  ],
  sideline: { reRolls: 2, apothecary: true, assistantCoaches: 1, cheerleaders: 0, dedicatedFans: 2 },
  inducements: [{ name: "Bribes", count: 2, icon: "icons/inducements/bribe.png" }],
  specialRules: ["Old World Classic"],
  summary: { players: 3, playersCost: 355000, starsCost: 200000, skillsCost: 40000, inducementsCost: 100000, sidelineCost: 140000, total: 1150000, cap: 1150000, primarySkills: 1, secondarySkills: 1 },
  validity: { valid: true, issues: 0, custom: false },
});

describe("team view core", () => {
  it("reads the token from /t/<token> or ?t=<token> only when well-formed", () => {
    expect(TeamView.tokenFrom({ pathname: `/t/${TOKEN}`, search: "" })).toBe(TOKEN);
    expect(TeamView.tokenFrom({ pathname: "/team-view.html", search: `?t=${TOKEN}` })).toBe(TOKEN);
    expect(TeamView.tokenFrom({ pathname: "/team-view.html", search: "?t=../../x" })).toBe("");
    expect(TeamView.tokenFrom({ pathname: `/t/${TOKEN}/x`, search: "" })).toBe("");
  });

  it("renders the banner, the desktop table and the mobile cards", () => {
    const markup = TeamView.viewHtml(fixture());
    expect(markup).toContain("<h1>Grudge &lt;XI&gt;</h1>");
    expect(markup).not.toContain("Grudge <XI>");
    expect(markup).toContain('src="/crests/dwarf.png"');
    expect(markup).toContain("Shared by <strong>Alice</strong> · EuroBowl 2026 — Tier 2 · updated 27 Oct 2026");
    expect(markup).toContain('<span class="tv-badge tv-valid" title="Valid team"><small>EuroBowl 2026</small><span class="tv-verdict"><span class="tv-check" aria-hidden="true">&#10003;</span>Verified</span></span>');
    expect(markup).toContain('<table class="tv-table">');
    expect(markup).toContain('<ol class="tv-cards">');
    const rosterStart = markup.indexOf('<table class="tv-table">');
    const roster = markup.slice(rosterStart, markup.indexOf("</table>", rosterStart)); // the inducements table now comes first
    expect((roster.match(/<tr[ >]/g) ?? []).length).toBe(4); // header + 3 players (the inducements table has its own rows)
    // Short position names, the full name as the tooltip (table + cards); a star keeps its name, no tooltip.
    expect(roster).toContain('<td class="tv-pos" title="Dwarf Blocker Lineman">Blocker Lineman</td>');
    expect(markup).toContain('<span class="tv-pos" title="Dwarf Runner">Runner</span>');
    expect(roster).toContain('<td class="tv-pos">Grim Ironjaw <span class="tv-tag">Star</span></td>');
    expect((markup.match(/<li class="tv-card/g) ?? []).length).toBe(3);
    expect(markup).toContain('src="/sprites/dwarf/dwarfblockerlineman.png"');
    expect(markup).not.toContain("evil.example");
    expect(markup).toContain('<span class="tv-tag">Star</span>');
  });

  it("colours skills by category, italicises added skills, flags secondaries and stat increases", () => {
    const markup = TeamView.viewHtml(fixture());
    expect(markup).toContain('<span class="skill skill-general" title="Block">Block</span>');
    expect(markup).toContain('<span class="skill skill-strength" title="Thick Skull">Thick Skull</span>');
    expect(markup).toContain('<span class="skill skill-trait" title="Loner (4+)">Loner (4+)</span>');
    expect(markup).toContain('class="skill skill-general tv-added" title="Primary skill added: Tackle">Tackle</span>');
    expect(markup).toContain('class="skill skill-strength tv-added tv-secondary" title="Secondary skill added: Guard">Guard</span>');
    expect(markup).not.toContain('tv-access'); // owner 10-27: no superscript S - it read as "Guards"
    expect(markup).toContain('<span class="skill tv-stat-up" title="Characteristic increase">+MA</span>');
    expect(markup).toContain('<td class="tv-stat tv-up" title="MA increased"><span class="tv-stat-box">7<span class="tv-up-mark" aria-hidden="true">▲</span></span></td>');
    expect(TeamView.categoryClass("Devious")).toBe("skill-passing");
    expect(TeamView.categoryClass("Mutation")).toBe("skill-mutation");
  });

  it("shows totals vs cap, sideline staff, the inducements table and the inline special rules", () => {
    const markup = TeamView.viewHtml(fixture());
    expect(markup).toContain("<span>Total</span><b>1,150k <small>/ 1,150k</small></b>");
    expect(markup).toContain("<span>Primary / Secondary</span><b>1 / 1</b>");
    expect(markup).toContain("<span>Stars</span><b>200k</b>");
    expect(markup).toContain('<dt class="tv-staff-cell"><img class="crest-image tv-staff-icon" src="/icons/ui/re_roll.png" alt="" aria-hidden="true" loading="lazy"><span>Rerolls</span></dt><dd>2</dd>');
    expect(markup).toContain("<span>S</span>ideline <span>S</span>taff");
    expect(markup).toContain('<span>Bribes</span></td><td class="num">2</td>');
    expect(markup).toContain('<small class="tv-rules-inline" aria-label="Special rules">Old World Classic</small>');
    // Sideline Staff comes before the inducements panel (owner 10-28), and there is no Special Rules panel
    expect(markup.indexOf('id="tv-sideline-title"')).toBeLessThan(markup.indexOf('id="tv-ind-title"'));
    expect(markup).not.toContain('id="tv-rules-title"');
  });

  it("an invalid team gets an issue badge; the owner link appears only with ownerSaveId", () => {
    const invalid = { ...fixture(), validity: { valid: false, issues: 3, custom: false, findings: ["Team spends 1,160k; the cap is 1,150k.", "Guard is not a primary skill for Dwarf Blitzer.", "<b>bad</b>"] } };
    expect(TeamView.viewHtml(invalid)).toContain('<ul class="tv-issues" aria-label="Issues"><li>Team spends 1,160k; the cap is 1,150k.</li><li>Guard is not a primary skill for Dwarf Blitzer.</li><li>&lt;b&gt;bad&lt;/b&gt;</li></ul>');
    expect(TeamView.viewHtml(invalid)).toContain('<span class="tv-verdict"><span class="tv-check" aria-hidden="true">&#10007;</span>Has 3 issues</span>');
    expect(TeamView.viewHtml(fixture())).toMatch(/<span class="tv-badge tv-valid"[^>]*><small>[^<]+<\/small><span class="tv-verdict"><span class="tv-check" aria-hidden="true">&#10003;<\/span>Verified<\/span>/);
    // the team name sits above the crest: h1 before the crest markup
    const m = TeamView.viewHtml(fixture());
    expect(m.indexOf("<h1>")).toBeLessThan(m.indexOf('tv-banner-main'));
    expect(TeamView.viewHtml(fixture())).not.toContain("Open in Tournament Builder");
    const owned = TeamView.viewHtml({ ...fixture(), ownerSaveId: "sv_abc" });
    expect(owned).toContain('<a class="session-button tv-owner" href="/tournament-team-builder.html?save=sv_abc">Open in Tournament Builder</a>');
    expect(TeamView.viewHtml({ ...fixture(), ownerSaveId: "x\"><script>" })).not.toContain("Open in Tournament Builder");
  });
});

function stubPage(routes: Record<string, () => { status: number; body: unknown }>, location = { pathname: `/t/${TOKEN}`, search: "" }) {
  const rootEl = { innerHTML: "" };
  const nav = [...html.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map((m) => m[0]).filter((tag) => /data-(admin|signed-in)-only/.test(tag)).map((tag) => ({
    text: tag.replace(/<[^>]+>/g, ""), hidden: true, admin: tag.includes("data-admin-only"), signedIn: tag.includes("data-signed-in-only"),
  }));
  const doc = {
    title: "",
    getElementById: (id: string) => (id === "team-view-root" ? rootEl : null),
    querySelectorAll: (selector: string) => nav.filter((link) => (selector === "[data-admin-only]" ? link.admin : selector === "[data-signed-in-only]" ? link.signedIn : false)),
  };
  const calls: string[] = [];
  const page = TeamView.createTeamViewPage({
    document: doc,
    location,
    fetch: async (path: string) => {
      calls.push(path);
      const route = routes[path];
      const out = route ? route() : { status: 404, body: { error: "not found" } };
      return { ok: out.status >= 200 && out.status < 300, status: out.status, json: async () => out.body };
    },
  });
  return { page, rootEl, nav, doc, calls };
}

describe("team view controller", () => {
  const anon = { "/api/auth/session": () => ({ status: 200, body: { authenticated: false } }) };

  it("loads the shared team anonymously; nav shows only the Tournament link", async () => {
    const { page, rootEl, nav, doc, calls } = stubPage({ ...anon, [`/api/fork/team-builder/shared/${TOKEN}`]: () => ({ status: 200, body: { team: fixture() } }) });
    await page.start();
    expect(calls).toContain(`/api/fork/team-builder/shared/${TOKEN}`);
    expect(rootEl.innerHTML).toContain('<table class="tv-table">');
    expect(rootEl.innerHTML).not.toContain("Open in Tournament Builder");
    expect(doc.title).toBe("Grudge <XI> — Super FUMBBL");
    expect(nav.every((link) => link.hidden)).toBe(true);
    expect(html).toContain('<a href="/tournament-team-builder.html">Tournament</a>');
  });

  it("the owner's session gets the Open in Tournament Builder link (from the server's ownerSaveId)", async () => {
    const { page, rootEl, nav } = stubPage({
      "/api/auth/session": () => ({ status: 200, body: { authenticated: true, coach: "Alice" } }),
      [`/api/fork/team-builder/shared/${TOKEN}`]: () => ({ status: 200, body: { team: { ...fixture(), ownerSaveId: "sv_abc" } } }),
    });
    await page.start();
    expect(rootEl.innerHTML).toContain("?save=sv_abc");
    expect(nav.find((link) => link.text === "My Teams")!.hidden).toBe(false);
    expect(nav.filter((link) => link.admin).every((link) => link.hidden)).toBe(true);
  });

  it("a revoked / unknown token shows the friendly not-available page", async () => {
    const { page, rootEl } = stubPage({ ...anon });
    await page.start();
    expect(rootEl.innerHTML).toContain("This team link is no longer available.");
    const missing = stubPage({ ...anon }, { pathname: "/team-view.html", search: "" });
    await missing.page.start();
    expect(missing.rootEl.innerHTML).toContain("This team link is no longer available.");
    expect(missing.calls).not.toContain(expect.stringContaining("/shared/"));
  });

  it("markup: public shell, own stylesheet and script, no sign-in form", () => {
    expect(html).toContain('<body data-page="team-view">');
    expect(html).toContain('<link rel="stylesheet" href="/team-builder.css" />');
    expect(html).toContain('<link rel="stylesheet" href="/team-view.css" />');
    expect(html).toContain('<script src="/team-view.js" defer></script>');
    expect(html).toContain('<script src="/theme.js" defer></script>');
    expect(html).not.toContain("discord-login");
  });
});

/** Attribute NAMES of every real tag (quoted values skipped, so escaped text inside a title never counts). */
function liveAttributes(markup: string): string[] {
  const names: string[] = [];
  for (const tag of markup.matchAll(/<([a-z][a-z0-9]*)((?:\s+[^\s=>]+(?:="[^"]*"|='[^']*'|=[^\s>]+)?)*)\s*\/?>/gi))
    for (const attr of tag[2]!.matchAll(/\s+([^\s=>]+)(?:="[^"]*"|='[^']*'|=[^\s>]+)?/g)) names.push(attr[1]!.toLowerCase());
  return names;
}

describe("team view: hostile strings (Sol r1 P3)", () => {
  const EVIL = `<img src=x onerror=alert(1)>"'&`;
  const hostile = () => {
    const team: Any = fixture();
    team.teamName = EVIL;
    team.coach = EVIL;
    team.raceName = EVIL;
    team.ruleset = { name: EVIL, tierLabel: EVIL };
    team.updatedAt = EVIL;
    team.specialRules = [EVIL];
    team.inducements = [{ name: EVIL, count: EVIL, icon: `icons/x.png" onerror="alert(1)` }];
    team.crest = "javascript:alert(1)";
    team.players[0] = { ...team.players[0], position: EVIL, number: EVIL, cost: EVIL, sprite: "/sprites/../../x.png",
      stats: { MA: EVIL, ST: EVIL, AG: EVIL, PA: EVIL, AV: EVIL },
      printed: [{ name: EVIL, category: EVIL }], added: [{ name: EVIL, category: EVIL, access: EVIL }], statIncreases: [EVIL] };
    team.summary = { ...team.summary, players: EVIL, total: EVIL, cap: EVIL };
    team.validity = { valid: false, issues: EVIL, custom: false };
    return team;
  };

  it("escapes every server string in the table, the cards, skills, special rules, coach and stats", () => {
    const markup = TeamView.viewHtml(hostile());
    expect(markup).not.toContain("<img src=x");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("/sprites/../");
    expect(liveAttributes(markup)).toEqual(expect.arrayContaining(["class", "title"])); // the scan sees real attributes
    // every hostile art path (javascript:, traversal, quote break-out) is dropped; the only <img> left are the page's own fixed staff icons
    const imgSrcs = [...markup.matchAll(/<img [^>]*src="([^"]*)"/g)].map((m) => m[1]);
    expect(imgSrcs.every((src) => /^\/icons\/(ui|inducements)\/[a-z_]+\.png$/.test(src))).toBe(true);
    expect(imgSrcs.length).toBeGreaterThan(0); // staff with a zero count are not listed (owner 10-28)
    expect(imgSrcs.length).toBeLessThanOrEqual(5);
    expect(liveAttributes(markup).filter((a) => /^on/i.test(a))).toEqual([]); // no live event-handler attribute anywhere
    const escaped = "&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;";
    const tableStart = markup.indexOf('<table class="tv-table">');
    const table = markup.slice(tableStart, markup.indexOf("</table>", tableStart));
    const cards = markup.slice(markup.indexOf('<ol class="tv-cards">'), markup.indexOf("</ol>"));
    for (const part of [table, cards]) {
      expect(part).toContain(escaped); // position / skills / stats
      expect(part).toContain(`<span class="skill skill-trait" title="${escaped}">${escaped}</span>`);
    }
    expect(markup).toContain(`<h1>${escaped}</h1>`);
    expect(markup).toContain(`Shared by <strong>${escaped}</strong>`);
    expect(markup).toContain(`aria-label="Special rules">${escaped}</small>`); // special rule beside the team type
    expect(markup).toContain("Has 1 issue"); // a non-numeric issue count never reaches the markup
    expect(markup).toContain("+&lt;img"); // stat increase chip
  });

  it("document.title takes the team name as text, and the page renders it through the escaped core", async () => {
    const { page, rootEl, doc } = stubPage({ "/api/auth/session": () => ({ status: 200, body: { authenticated: false } }),
      [`/api/fork/team-builder/shared/${TOKEN}`]: () => ({ status: 200, body: { team: hostile() } }) });
    await page.start();
    expect(doc.title).toBe(`${EVIL} — Super FUMBBL`); // title is a text property, not markup
    expect(rootEl.innerHTML).not.toContain("<img src=x");
    expect(liveAttributes(rootEl.innerHTML).filter((a) => /^on/i.test(a))).toEqual([]);
  });
});

  it("a team without inducements still shows the Inducements table, reading None", () => {
    const none = { ...fixture(), inducements: [] };
    const markup = TeamView.viewHtml(none);
    expect(markup).toContain('id="tv-ind-title"');
    expect(markup).toContain('class="status-copy tv-none">None</td>');
  });

  it("sideline staff (left) and inducements (right) render below the roster", () => {
    const markup = TeamView.viewHtml(fixture());
    const rosterEnd = markup.indexOf("</section>", markup.indexOf('<table class="tv-table">'));
    expect(markup.indexOf('id="tv-sideline-title"')).toBeGreaterThan(rosterEnd);
    expect(markup.indexOf('id="tv-ind-title"')).toBeGreaterThan(markup.indexOf('id="tv-sideline-title"'));
  });
