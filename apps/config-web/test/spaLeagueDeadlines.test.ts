import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { createSSRApp } from "vue";
import { chipFor } from "../spa/src/home/deadlines";
import { treeLeagues } from "../spa/src/home/tree";
import { deadlineChip, deadlineRounds, effectiveDeadline, fixtureDeadlineChip, fromLocalInput, toLocalInput } from "../spa/src/leagues/deadlines";
import type { LeagueFixture, LeagueSummary, SeasonRecord } from "../spa/src/leagues/types";

// League fixture deadlines, page side (spa/src/leagues/deadlines.ts): effective deadline, the chip (amber < 72 h,
// scarlet < 24 h, "Overdue" after, outcomes), the sidebar row's deadline, and the Fixtures tab (cards + table chips)
// and Deadlines editor server-rendered.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const NOW = new Date("2026-11-10T12:00:00.000Z");
const H = 3_600_000;
const iso = (h: number): string => new Date(NOW.getTime() + h * H).toISOString();

const fx = (id: string, round: number, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: { team: `Home ${id}`, coach: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: `Away ${id}`, coach: "Bob", race: "Dwarf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const season = (): SeasonRecord => ({
  id: "season-1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", importedAt: "2026-10-30T00:00:00.000Z",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  roundDeadlines: [{ phaseId: "season-regular", round: 1, deadline: iso(100) }, { phaseId: "season-regular", round: 2, deadline: iso(-2) }],
  fixtures: [
    fx("f1", 1),
    fx("f2", 1, { deadline: iso(48) }),
    fx("f3", 1, { deadline: iso(5) }),
    fx("f4", 2),
    fx("f5", 2, { deadlineOutcome: { outcome: "review", auto: true, at: iso(-1) } }),
    fx("f6", 2, { home: { team: "Home f6", coach: "Ann", race: "Orc", score: 0, cas: null, conceded: true }, away: { team: "Away f6", coach: "Bob", race: "Dwarf", score: 0, cas: null, conceded: true }, deadlineOutcome: { outcome: "both-lose", auto: true, at: iso(-1) } }),
    fx("f7", 2, { home: { team: "Home f7", coach: "Ann", race: "Orc", score: 2, cas: 1, conceded: false }, away: { team: "Away f7", coach: "Bob", race: "Dwarf", score: 1, cas: 0, conceded: false } }),
  ],
  participants: [], teams: [], honours: [], awards: [],
});

describe("deadline helpers (page side)", () => {
  it("effective deadline: the fixture's own, else its round's", () => {
    const s = season();
    expect(effectiveDeadline(s, s.fixtures[0]!)).toBe(iso(100));
    expect(effectiveDeadline(s, s.fixtures[1]!)).toBe(iso(48));
    expect(effectiveDeadline({}, s.fixtures[0]!)).toBeUndefined();
  });
  it("chip: muted beyond 72 h, amber < 72 h, scarlet < 24 h, Overdue after; outcomes; nothing for a result", () => {
    const s = season();
    const chip = (i: number) => fixtureDeadlineChip(s, s.fixtures[i]!, NOW, "UTC");
    expect(chip(0)).toMatchObject({ tone: "muted", label: "Due Sat 14 Nov, 16:00", title: "Deadline Sat 14 Nov, 16:00" });
    expect(chip(1)).toMatchObject({ tone: "soon", label: "Due in 2 d" });
    expect(chip(2)).toMatchObject({ tone: "urgent", label: "Due in 5 h" });
    expect(chip(3)).toMatchObject({ tone: "overdue", label: "Overdue" });
    expect(chip(4)).toMatchObject({ tone: "urgent", label: "Overdue: needs organiser decision" });
    expect(chip(5)).toMatchObject({ tone: "muted", label: "Both lose (deadline)" });
    expect(chip(6)).toBeNull();
    expect(chipFor(iso(71.9), NOW)).toBe("soon");
    expect(chipFor(iso(23.9), NOW)).toBe("urgent");
    expect(deadlineChip(iso(5), NOW, "UTC", true).label).toBe("Overdue: needs organiser decision");
  });
  it("datetime-local round trip and the (phase, round) list", () => {
    const local = toLocalInput("2026-11-12T18:30:00.000Z");
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(fromLocalInput(local)).toBe("2026-11-12T18:30:00.000Z");
    expect(fromLocalInput("")).toBeNull();
    expect(toLocalInput(undefined)).toBe("");
    expect(deadlineRounds(season())).toEqual([{ phaseId: "season-regular", phase: "Regular", round: 1 }, { phaseId: "season-regular", phase: "Regular", round: 2 }]);
  });
  it("sidebar: the next fixture keeps a valid deadline and the decision flag; junk is dropped", () => {
    const rows = treeLeagues([{
      id: "a", name: "A", season: { id: "s", number: 1, name: "S" }, to: "/leagues/a",
      teams: [
        { id: "t", name: "T", race: "Orc", record: { wins: 0, draws: 0, losses: 0 }, to: "/leagues/a?tab=teams", next: { id: "f", round: 1, opponent: "X", home: true, deadline: iso(5), needsDecision: true, to: "/leagues/a?fixture=f" } },
        { id: "u", name: "U", race: "Orc", record: { wins: 0, draws: 0, losses: 0 }, to: "/leagues/a?tab=teams", next: { id: "g", round: 1, opponent: "Y", home: true, deadline: "soon", to: "/leagues/a?fixture=g" } },
      ],
    }], { crests: {} } as never);
    expect(rows[0]!.teams[0]!.fixture).toMatchObject({ deadline: iso(5), needsDecision: true });
    expect(rows[0]!.teams[1]!.fixture?.deadline).toBeUndefined();
  });
});

describe("Fixtures tab and Deadlines editor (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: {
    createSSRApp: typeof import("vue").createSSRApp;
    renderToString: (app: unknown) => Promise<string>;
    vueRouter: typeof import("vue-router");
    league: typeof import("../spa/src/leagues/league");
    Fixtures: unknown;
    Editor: unknown;
  };
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, league, fixtures, editor] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("/src/leagues/league.ts"), vite.ssrLoadModule("/src/components/LeagueFixtures.vue"), vite.ssrLoadModule("/src/components/LeagueDeadlinesEditor.vue"),
    ]);
    mods = { createSSRApp, renderToString: renderer.renderToString, vueRouter: vueRouter as never, league: league as never, Fixtures: fixtures.default, Editor: editor.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const league: LeagueSummary = { id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", description: "", organisers: ["Jay"], createdAt: "2026-10-30T00:00:00.000Z", seasonCount: 1 } as LeagueSummary;
  /** Deadlines relative to the real clock (the components read it). */
  const liveSeason = (): SeasonRecord => {
    const at = (h: number) => new Date(Date.now() + h * H).toISOString();
    const s = season();
    s.roundDeadlines = [{ phaseId: "season-regular", round: 1, deadline: at(100) }, { phaseId: "season-regular", round: 2, deadline: at(-2) }];
    s.fixtures[1]!.deadline = at(50);
    s.fixtures[2]!.deadline = at(5);
    return s;
  };
  async function render(component: unknown, props: Record<string, unknown>, path = "/leagues/tabbl?tab=fixtures&round=all", s = liveSeason()) {
    const detail = mods.league.createLeagueDetail({ api: (async () => { throw new Error("no api"); }) as never });
    detail.state.season[s.id] = s;
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [{ path: "/:p(.*)*", component: { render: () => null } }] });
    await router.push(path);
    await router.isReady();
    const app = mods.createSSRApp(component as never, { season: detail.state.season[s.id], ...props });
    app.use(router);
    app.provide(mods.league.LEAGUE_DETAIL_KEY, detail);
    return mods.renderToString(app);
  }

  it("cards and table show the deadline chip per fixture (amber, scarlet, overdue, outcome), none on a result", async () => {
    const g = globalThis as { localStorage?: unknown };
    const saved = g.localStorage;
    for (const view of ["cards", "table"]) {
      g.localStorage = { getItem: () => view, setItem: () => undefined };
      const html = await render(mods.Fixtures, { league, crests: {}, manage: false });
      expect(html).toContain(view === "table" ? "lg-fx-table" : "lg-results");
      expect(html).toMatch(/data-tone="soon"[^>]*data-deadline[^>]*>Due in 2 d</);
      expect(html).toMatch(/data-tone="urgent"[^>]*data-deadline[^>]*>Due in 5 h</);
      expect(html).toMatch(/data-tone="overdue"[^>]*data-deadline[^>]*>Overdue</);
      expect(html).toContain(">Overdue: needs organiser decision<");
      expect(html).toContain(">Both lose (deadline)<");
      expect(html.match(/data-deadline/g)).toHaveLength(6); // f7 has a result: no chip
      expect(html).not.toContain('id="lg-dl-h"'); // the editor is for organisers
    }
    g.localStorage = saved;
  });

  it("organisers get the Deadlines editor under the fixtures", async () => {
    const html = await render(mods.Fixtures, { league, crests: {}, manage: true });
    expect(html).toContain('id="lg-dl-h"');
  });

  it("editor: auto-forfeit OFF by default with its outcome choices, round deadlines, overrides, decisions only once overdue", async () => {
    const html = await render(mods.Editor, {});
    expect(html).toContain("Auto-forfeit unplayed fixtures after the deadline");
    expect(html).toMatch(/<input type="checkbox" role="switch" aria-checked="false"/);
    expect(html).toContain("Mark overdue for an organiser to decide");
    expect(html).toContain("No result");
    expect(html).toContain("Both teams lose");
    expect(html).toMatch(/<fieldset class="lg-dl-outcomes" disabled/);
    expect(html.match(/data-round="season-regular#\d"/g)).toHaveLength(2);
    expect(html.match(/type="datetime-local"/g)).toHaveLength(2 + 7);
    // Decisions: f4 (round deadline passed), f5 (review) and f6 (both lose) — never f1-f3 (not due) or f7 (a result).
    expect(html.match(/aria-label="Decision for /g)).toHaveLength(3);
    expect(html).toMatch(/data-fixture="f5"[\s\S]*?Reopen/);
    expect(html).not.toMatch(/Decision for Home f7/);
    const on = liveSeason();
    on.deadlinePolicy = { autoForfeit: true, outcome: "both-lose" };
    const html2 = await render(mods.Editor, {}, undefined, on);
    expect(html2).toMatch(/<input checked type="checkbox" role="switch" aria-checked="true"/);
    expect(html2).not.toMatch(/<fieldset class="lg-dl-outcomes" disabled/);
    expect(html2).toMatch(/<input checked type="radio" name="lg-dl-outcome" value="both-lose">/);
  });
});
