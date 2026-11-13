import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { createHashReveal, createPaneScrollMemory, entryKey, FIT_QUERY, nodeAt, nodePath, type ScrollNode } from "../spa/src/shell/fit";
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
    // one viewport tall: viewport units are zoomed with the page (home.css --sf-zoom), so the height divides by the zoom
    expect(block).toMatch(/body > #app \{[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*height: calc\(100dvh \/ var\(--sf-zoom, 1\)\);[^}]*overflow: hidden;/);
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

  it("any desktop-size media block that sets a viewport height or a scrolling overflow is screen-only (print keeps the natural flow)", () => {
    const offenders: string[] = [];
    for (const file of cssFiles(".")) {
      const css = src(file.replace(/^\.\//, ""));
      for (const m of css.matchAll(/@media([^{]*)\{/g)) {
        const query = m[1]!.trim();
        if (!/min-(width|height)/.test(query) || /^screen\b|\bprint\b/.test(query)) continue;
        let depth = 0, i = m.index! + m[0].length - 1;
        const start = i;
        for (; i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) break; }
        const body = css.slice(start, i);
        if (!/\b100d?vh\b|overflow(-[xy])?:\s*(auto|scroll)/.test(body)) continue;
        // the match recorder is a position: fixed full-screen app at every size (tabletop.css .tt-rec); it is never a page
        if (file.endsWith("tabletop/tabletop.css") && /\.tt-rec\b|\.tt-rail\b/.test(body)) continue;
        offenders.push(`${file}: @media ${query}`);
      }
    }
    expect(offenders).toEqual([]);
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
    ["views/LeagueSettingsView.vue", ["hm-page lg-page ls-page sf-fit", "sh-manage sf-fill"]],
    ["views/RosterBuilderRedraftView.vue", ["hm-page tm-page tb-page sf-fit", "tb-pane sf-fill"]],
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
    ["views/TeamManageView.vue", ["tm-page sf-fit", "tm-content sf-fit sf-fill", "tm-summary sf-shrink sf-scroll sf-col"]],
    ["views/StandingsView.vue", ["hm-page st-page sf-fit", "sf-pane sf-shrink", "lg-scroll sf-pane-body"]],
    ["views/TournamentListView.vue", ["hm-page tl-page sf-fit", "tl-cards sf-shrink sf-scroll sf-col"]],
    ["views/LeagueListView.vue", ["hm-page lg-page lgb-page sf-fit", "lgb-grid sf-fill sf-scroll sf-col", "lgb-table-pane sf-pane sf-fill", "lgb-table-wrap sf-pane-body"]],
    ["views/SeriesListView.vue", ["hm-page sr-page sf-fit", "tl-cards sf-shrink sf-scroll sf-col"]],
    ["views/SeriesDetailView.vue", ["hm-page sr-page sf-fit", "sr-grid sr-overview sf-shrink sf-scroll sf-col", "sr-schedule sf-shrink sf-scroll sf-col", "sh-manage sf-fill"]],
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
    for (const [file, marker] of [["leagues/leagues.css", ".lg-tab-body:has"], ["leagues/leagues.css", ".lg-ov > .lg-ov-side > .hm-panel {"], ["leagues/leagues.css", ".lg-tab-body > .lg-stack > .lg-fx-nav {"], ["tournaments/tournaments.css", ".tn-tab-body > .hm-grid"],
      ["tournaments/creator.css", ".cr-pane-fit"], ["teams/builder.css", ".tb-pane.sf-fill"], ["leagues/lobby.css", ".fl-grid.sf-fill"],
      ["home/social.css", ".so-page.sf-fit"], ["leagues/calendar.css", ".lg-tab-body:has(> .lgc)"], ["tournaments/wizard.css", ".tw-fit .tw-body"], ["leagues/wizard.css", ".lw-fit .lw-pane-body"]] as const) {
      const css = src(file);
      expect(fitBlock(css), file).toContain(marker);
      expect(css.replace(fitBlock(css), ""), file).not.toContain(marker);
    }
  });
});

describe("fit to 1920x1080: league pages (owner 11-13: \"Panels stay on screen\")", () => {
  const block = fitBlock(src("leagues/leagues.css"));
  it("the Overview side column: every panel band stays in view, long panels give up height first and scroll under a sticky band", () => {
    expect(block).toMatch(/\.lg-ov > \.lg-ov-side > \.hm-panel \{ flex: 0 1 auto; min-height: 80px; overflow-y: auto;/);
    expect(block).toContain(".lg-ov > .lg-ov-side > .cf-house-panel { min-height: 136px; }"); // the band and three full rows
    expect(block).toMatch(/\.lg-ov > \.lg-ov-side > :is\(\.cf-house-panel, \.lg-ov-org, \.ind-panel\) \{ flex-shrink: 16; \}/);
    expect(block).toMatch(/\.lg-ov > \.lg-ov-side > \.hm-panel > \.hm-band \{ position: sticky; top: 0;/);
    // the narrow two-column overview (a small desktop) scrolls its right column as one: the panels go back to their height
    expect(block.slice(block.indexOf("@container lg-ov"))).toMatch(/\.lg-ov > \.lg-ov-side > \.hm-panel, \.lg-ov > \.lg-ov-side > \.cf-house-panel \{ min-height: auto; overflow: visible;/);
  });
  it("Fixtures keeps its nav bar at the top of the tab while the phases scroll; the results table keeps its header", () => {
    expect(block).toContain(".lg-tab-body > .lg-stack > .lg-fx-nav { position: sticky; top: 0; z-index: 3; }");
    expect(block).toContain(".lg-ov-table thead th { position: sticky; top: 0;");
  });
  it("the league views keep their fitted panes (the filter boxes sit inside them)", () => {
    const detail = src("views/LeagueDetailView.vue");
    expect(detail).toContain('class="lg-tab-body sf-fill sf-scroll sf-col"');
    // Participants: the filter is a child of the single table panel, so the panel still fills the tab and its list scrolls
    expect(src("components/LeagueParticipantsList.vue")).toMatch(/<ListFilter v-if="season\.teams\.length"[^>]*class="lg-list-filter"/);
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
  /** A fake browser history: one state object per entry; push drops the forward entries; back / forward move. */
  function fakeHistory() {
    let ids = 0;
    const stack: Array<Record<string, unknown>> = [{ position: 0 }];
    let at = 0;
    return {
      get state() { return stack[at]!; },
      push() { stack.splice(at + 1); stack.push({ position: at + 1 }); at += 1; },
      back() { at -= 1; },
      forward() { at += 1; },
      key: () => entryKey(stack[at], () => {}, () => `k${++ids}`),
    };
  }

  it("addresses a pane by its child-index path under the content area", () => {
    const { main, pane } = shell();
    expect(nodePath(pane, main)).toEqual([1, 1]);
    expect(nodePath(main, main)).toEqual([]);
    expect(nodePath(node(), main)).toBeNull();
    expect(nodeAt(main, [1, 1])).toBe(pane);
    expect(nodeAt(main, [4])).toBeNull();
  });

  it("keys an entry by a random id kept in its own state, created once and persisted", () => {
    const persisted: string[] = [];
    const state: Record<string, unknown> = { position: 3 };
    expect(entryKey(state, (k) => persisted.push(k), () => "abc")).toBe("abc");
    expect(entryKey(state, (k) => persisted.push(k), () => "zzz")).toBe("abc");
    expect(persisted).toEqual(["abc"]);
    expect(entryKey(null, () => {}, () => "x")).toBeUndefined();
  });

  it("remembers each entry's offsets and puts them back once the page is tall enough; navigation pauses recording", async () => {
    const h = fakeHistory();
    let page = shell();
    const memory = createPaneScrollMemory({ root: () => page.main, entry: h.key, position: () => h.state.position as number, wait: async () => {} });
    page.main.scrollTop = 300; memory.record(page.main);
    page.pane.scrollTop = 1200; memory.record(page.pane);
    // navigate away: the outgoing page's teardown (main clamped to 0) must not overwrite this entry
    memory.pause();
    page.main.scrollTop = 0; memory.record(page.main);
    h.push(); memory.pushed(); memory.resume();
    page = shell(); memory.record(page.main);
    // Back: the first page renders again, its pane still filling in (too short for 1200 on the first try)
    memory.pause(); h.back();
    page = shell();
    page.pane.scrollHeight = 900;
    const done = memory.restore({ tries: 5, delay: 0 });
    page.pane.scrollHeight = 3000;
    expect(await done).toBe(true);
    expect(page.main.scrollTop).toBe(300);
    expect(page.pane.scrollTop).toBe(1200);
  });

  it("branching: a page pushed after Back never gets the abandoned entry's offsets (Sol review 1)", async () => {
    const h = fakeHistory();
    let page = shell();
    const memory = createPaneScrollMemory({ root: () => page.main, entry: h.key, position: () => h.state.position as number, wait: async () => {} });
    // A -> Privacy (scrolled) -> Back -> push What's new (not scrolled) -> Back -> Forward
    memory.pause(); h.push(); memory.pushed(); memory.resume();
    page = shell(); page.pane.scrollTop = 1500; memory.record(page.pane);
    memory.pause(); h.back(); page = shell(); await memory.restore({ tries: 2, delay: 0 });
    memory.pause(); h.push(); memory.pushed(); memory.resume(); page = shell();
    memory.pause(); h.back(); page = shell(); await memory.restore({ tries: 2, delay: 0 });
    memory.pause(); h.forward(); page = shell();
    page.pane.scrollTop = 40; // a reused pane left scrolled
    expect(await memory.restore({ tries: 2, delay: 0 })).toBe(true);
    expect(page.pane.scrollTop).toBe(0);
    expect(page.main.scrollTop).toBe(0);
  });

  it("an entry that was never scrolled restores zeros: the content area and every reused pane go back to the top (Sol review 2)", async () => {
    const page = shell();
    const memory = createPaneScrollMemory({ root: () => page.main, entry: () => "never", position: () => 0, wait: async () => {} });
    page.main.scrollTop = 120; page.pane.scrollTop = 900;
    expect(await memory.restore({ tries: 2, delay: 0 })).toBe(true);
    expect(page.main.scrollTop).toBe(0);
    expect(page.pane.scrollTop).toBe(0);
  });

  it("the user taking over (input, or scrolling a restored pane) cancels pending retries and records again (Sol review 3)", async () => {
    let page = shell();
    let waits = 0;
    let onWait: () => void = () => {};
    const memory = createPaneScrollMemory({ root: () => page.main, entry: () => "a", position: () => 0, wait: async () => { waits++; onWait(); } });
    page.main.scrollTop = 200; memory.record(page.main);
    page.pane.scrollTop = 1200; memory.record(page.pane);
    // the page comes back with a short pane: the restore sets main, then waits for the pane to grow
    memory.pause();
    page = shell(); page.pane.scrollHeight = 600;
    onWait = () => memory.userActed(); // the user wheels during the first wait
    expect(await memory.restore({ tries: 5, delay: 0 })).toBe(false);
    expect(waits).toBe(1);
    page.pane.scrollHeight = 3000;
    expect(page.pane.scrollTop).toBe(0); // never pulled to 1200 after the user acted
    page.pane.scrollTop = 1200; memory.record(page.pane); // recording is back on
    // a scroll that is not the restore's own (a restored node moved away from the offset it set) also cancels
    memory.pause();
    page = shell(); page.pane.scrollHeight = 600;
    onWait = () => { page.main.scrollTop = 30; memory.record(page.main); };
    expect(await memory.restore({ tries: 5, delay: 0 })).toBe(false);
    expect(page.main.scrollTop).toBe(30);
  });
});

describe("fit to 1920x1080: hash reveal", () => {
  it("reveals now, retries while the target is out of view, and the next navigation cancels the retries (Sol review 4)", () => {
    const timers = new Map<number, () => void>();
    let next = 0;
    const revealed: string[] = [];
    let top = 2000;
    const hash = createHashReveal({
      find: (id) => id, top: () => top, viewport: () => 1080, reveal: (el) => revealed.push(el as string),
      later: (fn) => { timers.set(++next, fn); return next; }, cancel: (t) => timers.delete(t as number),
    });
    hash.reveal("deadlines");
    expect(revealed).toEqual(["deadlines"]);
    expect(timers.size).toBe(2);
    [...timers.values()][0]!(); // 250 ms: still out of view, revealed again
    expect(revealed).toEqual(["deadlines", "deadlines"]);
    top = 100;
    [...timers.values()][1]!(); // 800 ms: in view, left alone
    expect(revealed).toHaveLength(2);
    hash.reveal("my-teams");
    const stale = [...timers.values()];
    hash.cancel(); // the next navigation
    expect(timers.size).toBe(0);
    top = 2000;
    for (const fn of stale) fn(); // a timer that fired anyway is ignored (generation tag)
    expect(revealed).toEqual(["deadlines", "deadlines", "my-teams"]);
  });
});

describe("the fixture summary's comparison table (11-04: no sideways page scroll at 440 / 375, no overlap at 1920)", () => {
  it("scrolls inside its own pane, wraps the form chips, and wraps the row labels in a narrow column", () => {
    const css = src("leagues/lobby.css");
    expect(css).toMatch(/\.fs-compare \{ overflow-x: auto; container: fs-compare \/ inline-size; \}/);
    expect(css).toContain(".fs-compare-table .fl-form { flex-wrap: wrap;");
    const narrow = css.slice(css.indexOf("@container fs-compare (max-width: 460px)"));
    expect(narrow).toMatch(/^@container fs-compare \(max-width: 460px\) \{\s*\.fs-compare-table th \{[^}]*white-space: normal;[^}]*\}\s*\.fs-compare-table td \{ width: auto;/);
  });
});
