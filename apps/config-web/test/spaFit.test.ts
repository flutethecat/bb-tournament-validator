import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { FIT_QUERY } from "../spa/src/shell/fit";
import { scrollToHashAfter, type HashScrollDeps } from "../spa/src/tournaments/scroll";

// Fit to 1920x1080 (owner 11-02, laws 18a): on a desktop screen the shell is one viewport tall and pages scroll inside
// panes (home.css "Fit to 1920x1080"). These checks pin the shared primitives, the media query every page block uses,
// and the pages that opted in.
const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");
const home = src("home/home.css");

function fitBlock(css: string): string {
  const start = css.indexOf(`@media ${FIT_QUERY} {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1);
  }
  return "";
}

function cssFiles(dir: string): string[] {
  return readdirSync(new URL(`../spa/src/${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? cssFiles(`${dir}/${e.name}`) : /\.(css|vue)$/.test(e.name) ? [`${dir}/${e.name}`] : []);
}

describe("fit to 1920x1080: the shell", () => {
  const block = fitBlock(home);

  it("home.css holds the shell block under FIT_QUERY (desktop only: at least 1367 wide and 700 tall)", () => {
    expect(FIT_QUERY).toBe("(min-width: 1367px) and (min-height: 700px)");
    expect(block).not.toBe("");
  });

  it("makes #app one viewport tall with the content area and the sidebar scrolling inside", () => {
    expect(block).toMatch(/body > #app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*height: 100dvh;[^}]*overflow: hidden;/);
    expect(block).toMatch(/\.sf-body > \.shell-main \{[^}]*position: relative;[^}]*min-height: 0;[^}]*overflow-y: auto;/);
    expect(block).toMatch(/\.sf-aside \{[^}]*height: auto;[^}]*min-height: 0;/);
  });

  it("defines the opt-in primitives, scoped to the content area so a page root's own display cannot override them", () => {
    for (const rule of [".shell-main .sf-fit {", ".shell-main .sf-fit > .sf-fill", ".shell-main .sf-fit > .sf-shrink", ".shell-main .sf-pane {",
      ".shell-main .sf-pane > .sf-pane-body {", ".shell-main .sf-scroll {", ".shell-main .sf-cols > .hm-col {"]) {
      expect(block, rule).toContain(rule);
    }
    // every scroller contains its visually hidden (absolute) text, which otherwise stretched the content area
    expect(block).toMatch(/\.shell-main \.sf-scroll, \.shell-main \.sf-pane > \.sf-pane-body, \.shell-main \.sf-cols > \.hm-col \{ position: relative; \}/);
    // table headers stay in view inside a pane
    expect(block).toMatch(/\.sf-pane-body thead th[^{]*\{[^}]*position: sticky;/);
  });

  it("every page-level fit block uses the same media query as the shell (no drifting breakpoints)", () => {
    for (const file of cssFiles(".")) {
      const css = src(file.replace(/^\.\//, ""));
      for (const m of css.matchAll(/@media ([^{]*1367px[^{]*)\{/g)) expect(m[1]!.trim(), file).toBe(FIT_QUERY);
    }
  });
});

describe("fit to 1920x1080: the pages that opted in", () => {
  // [view, a class list its template must carry]
  const pages: Array<[string, string[]]> = [
    ["views/LeagueDetailView.vue", ["hm-page lg-page sf-fit", "lg-tab-body sf-fill sf-scroll sf-col"]],
    ["views/LeagueStatsView.vue", ["hm-page lg-page sf-fit", "lg-tab-body sf-fill sf-scroll sf-col"]],
    ["views/LeagueSettingsView.vue", ["hm-page lg-page ls-page sf-fit", "lg-tab-body sf-fill sf-scroll sf-col"]],
    ["views/LeagueRedraftView.vue", ["hm-page lg-page ls-page sf-fit", 'class="sf-fill sf-scroll sf-col"']],
    ["views/TournamentDetailView.vue", ["hm-page tn-page sf-fit", "tn-tab-body sf-fill"]],
    ["views/TournamentCreatorView.vue", ["hm-page cr-page sf-fit", "cr-pane sf-fill", "cr-pane-fit"]],
    ["views/TournamentBuilderView.vue", ["hm-page tm-page tb-page sf-fit", "tb-pane sf-fill"]],
    ["views/HomeView.vue", ["hm-page sf-fit", "hm-grid sf-fill sf-cols"]],
    ["views/AccountView.vue", ["ac-root sf-fit", "hm-page sf-fit sf-fill ac-page", "hm-grid sf-fill sf-cols"]],
    ["views/ScheduleView.vue", ["hm-page sf-fit sc-page", "hm-grid sf-fill sf-cols"]],
    ["views/MyTeamsView.vue", ["hm-page sf-fit", "hm-grid sf-fill sf-cols"]],
    ["views/MessagesView.vue", ["so-page sf-fit", "so-side sf-scroll sf-col"]],
    ["views/TabletopListView.vue", ["hm-page sf-fit", "hm-grid sf-fill sf-cols tt-home-grid"]],
    ["views/FixtureLobbyView.vue", ["fl-page sf-fit", "fl-grid sf-fill"]],
    ["views/TeamManageView.vue", ["tm-page sf-fit", "tm-content sf-fit sf-fill", "tm-sheet sf-shrink sf-scroll sf-col"]],
    ["views/StandingsView.vue", ["hm-page st-page sf-fit", "sf-pane sf-shrink", "lg-scroll sf-pane-body"]],
    ["views/TournamentListView.vue", ["hm-page tl-page sf-fit", "tl-cards sf-shrink sf-scroll sf-col"]],
    ["views/LeagueListView.vue", ["hm-page lg-page sf-fit", "tl-cards lg-cards sf-shrink sf-scroll sf-col"]],
    ["views/SeriesListView.vue", ["hm-page sr-page sf-fit", "tl-cards sf-shrink sf-scroll sf-col"]],
    ["views/SeriesDetailView.vue", ["hm-page sr-page sf-fit", "sr-grid sf-shrink sf-scroll sf-col"]],
    ["views/AdminTournamentsView.vue", ["hm-page sf-fit", "ad-list sf-shrink sf-scroll sf-col"]],
    ["views/PrivacyView.vue", ["hm-page pv-page sf-fit sf-scroll sf-col"]],
    ["views/HelpView.vue", ["hm-page sf-fit sf-scroll sf-col"]],
    ["views/WhatsNewView.vue", ["hm-panel hm-whats-new sf-fit sf-pane", "hm-log hm-log-full sf-pane-body"]],
  ];
  it.each(pages)("%s carries its fit classes", (file, classes) => {
    const tpl = src(file);
    for (const c of classes) expect(tpl, c).toContain(c);
  });

  it("the page CSS that fills the panes stays inside the desktop query (phones get no nested scroll traps)", () => {
    for (const [file, marker] of [["leagues/leagues.css", ".lg-tab-body:has"], ["tournaments/tournaments.css", ".tn-tab-body > .hm-grid"],
      ["tournaments/creator.css", ".cr-pane-fit"], ["teams/builder.css", ".tb-pane.sf-fill"], ["leagues/lobby.css", ".fl-grid.sf-fill"],
      ["home/social.css", ".so-page.sf-fit"]] as const) {
      const css = src(file);
      expect(fitBlock(css), file).toContain(marker);
      expect(css.replace(fitBlock(css), ""), file).not.toContain(marker);
    }
  });
});

describe("fit to 1920x1080: hash scroll", () => {
  it("reveals a late hash target inside its pane when the fitted shell gives a reveal dep (the window does not move)", async () => {
    const revealed: unknown[] = [];
    const scrolled: number[] = [];
    const target = { getBoundingClientRect: () => ({ top: 500 }) };
    const deps: HashScrollDeps = {
      find: (id) => (id === "tn-entry-h" ? target : null), reveal: (el) => revealed.push(el), scrollTo: (top) => scrolled.push(top),
      scrollY: () => 0, tick: async () => {}, wait: async () => {},
    };
    expect(await scrollToHashAfter(Promise.resolve(), "#tn-entry-h", deps)).toBe(true);
    expect(revealed).toEqual([target]);
    expect(scrolled).toEqual([]);
  });
});
