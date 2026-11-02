import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createPaneScrollMemory, FIT_QUERY, nodeAt, nodePath, type ScrollNode } from "../spa/src/shell/fit";
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

  it("home.css holds the shell block under FIT_QUERY (desktop screens only: at least 1367 wide and 700 tall, never print)", () => {
    expect(FIT_QUERY).toBe("screen and (min-width: 1367px) and (min-height: 700px)");
    expect(FIT_QUERY.startsWith("screen and ")).toBe(true); // A3 landscape print matches the sizes; print keeps the natural height
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
      // no fit block hides behind another query form (e.g. "all and" or a bare min-height) either
      for (const m of css.matchAll(/@media ([^{]*min-height: 700px[^{]*)\{/g)) expect(m[1]!.trim(), file).toBe(FIT_QUERY);
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
    ["views/TournamentWizardView.vue", ["hm-page tw-page tw-fit sf-fit", "tw-grid sf-fill"]],
    ["views/LeagueWizardView.vue", ["'lw-fit sf-fit'", "lw-grid sf-fill"]],
    ["views/WhatsNewView.vue", ["hm-panel hm-whats-new sf-fit sf-pane", "hm-log hm-log-full sf-pane-body"]],
  ];
  it.each(pages)("%s carries its fit classes", (file, classes) => {
    const tpl = src(file);
    for (const c of classes) expect(tpl, c).toContain(c);
  });

  it("the page CSS that fills the panes stays inside the desktop query (phones get no nested scroll traps)", () => {
    for (const [file, marker] of [["leagues/leagues.css", ".lg-tab-body:has"], ["tournaments/tournaments.css", ".tn-tab-body > .hm-grid"],
      ["tournaments/creator.css", ".cr-pane-fit"], ["teams/builder.css", ".tb-pane.sf-fill"], ["leagues/lobby.css", ".fl-grid.sf-fill"],
      ["home/social.css", ".so-page.sf-fit"], ["tournaments/wizard.css", ".tw-fit .tw-body"], ["leagues/wizard.css", ".lw-fit .lw-pane-body"]] as const) {
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

describe("fit to 1920x1080: Back / Forward restores pane scroll", () => {
  interface Fake extends ScrollNode { children: Fake[]; parentElement: Fake | null; scrollHeight: number }
  const node = (scrollHeight = 1000, kids: Fake[] = []): Fake => {
    const n: Fake = { scrollTop: 0, scrollHeight, clientHeight: 500, parentElement: null, children: kids };
    for (const k of kids) k.parentElement = n;
    return n;
  };
  function shell() {
    const pane = node(3000);
    const main = node(2000, [node(100), node(500, [node(10), pane])]);
    return { main, pane };
  }

  it("addresses a pane by its child-index path under the content area", () => {
    const { main, pane } = shell();
    expect(nodePath(pane, main)).toEqual([1, 1]);
    expect(nodePath(main, main)).toEqual([]);
    expect(nodePath(node(), main)).toBeNull();
    expect(nodeAt(main, [1, 1])).toBe(pane);
    expect(nodeAt(main, [4])).toBeNull();
  });

  it("remembers each entry's offsets and puts them back on the new page once it is tall enough; navigation pauses recording", async () => {
    let entry = 1;
    let page = shell();
    const memory = createPaneScrollMemory({ root: () => page.main, entry: () => entry, wait: async () => {} });
    page.main.scrollTop = 300; memory.record(page.main);
    page.pane.scrollTop = 1200; memory.record(page.pane);
    // navigate away: the outgoing page's teardown (main clamped to 0) must not overwrite entry 1
    memory.pause();
    page.main.scrollTop = 0; memory.record(page.main);
    entry = 2; memory.resume();
    page = shell(); memory.record(page.main); // the new page at the top
    // Back: entry 1 renders again, its pane still filling in (too short for 1200 on the first try)
    entry = 1;
    page = shell();
    page.pane.scrollHeight = 900;
    const done = memory.restore({ tries: 5, delay: 0 });
    page.pane.scrollHeight = 3000;
    expect(await done).toBe(true);
    expect(page.main.scrollTop).toBe(300);
    expect(page.pane.scrollTop).toBe(1200);
    // an entry with nothing recorded restores nothing
    entry = 9;
    expect(await memory.restore({ tries: 2, delay: 0 })).toBe(false);
  });

  it("a newer navigation cancels a pending restore", async () => {
    let page = shell();
    const memory = createPaneScrollMemory({ root: () => page.main, entry: () => 1, wait: async () => { memory.pause(); } });
    page.pane.scrollTop = 1200; memory.record(page.pane);
    page = shell();
    page.pane.scrollHeight = 600; // never tall enough before the next navigation starts
    expect(await memory.restore({ tries: 5, delay: 0 })).toBe(false);
    expect(page.pane.scrollTop).toBe(0);
  });
});
