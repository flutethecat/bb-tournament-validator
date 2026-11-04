import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import type { ViteDevServer } from "vite";
import { BB2025_RULEBOOK_WINNINGS, DEFAULT_MONEY_RULES, moneyRulesView, type MoneyRules } from "../src/leagues/moneyRules";

// SPA: League settings -> Money, the Money section of the league's ruleset card (House rules panel), the recorder's
// post-game money lines and the fixture summary's budget note. Server-rendered; fake data only.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

describe("money rules in the SPA (server-rendered)", () => {
  let vite: ViteDevServer | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, vueRouter, money, house, summary, settings, fixture] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("/src/components/LeagueSettingsMoney.vue"), vite.ssrLoadModule("/src/components/HouseRulesPanel.vue"),
      vite.ssrLoadModule("/src/components/TabletopMatchSummary.vue"), vite.ssrLoadModule("/src/leagues/settings.ts"),
      vite.ssrLoadModule("/src/components/FixtureMatchSummary.vue"),
    ]);
    mods = { renderer, vueRouter, Money: money.default, House: house.default, Summary: summary.default, settings, Fixture: fixture.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(component: unknown, props: Record<string, unknown>, provide?: (app: { provide: (k: unknown, v: unknown) => void }) => void): Promise<string> {
    const blank = { render: () => null };
    const router = mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory("/app/"), routes: [
      { path: "/leagues/:id/settings", name: "league-settings", component: blank }, { path: "/:p(.*)*", component: blank },
    ] });
    await router.push("/x");
    await router.isReady();
    const app = createSSRApp(component as never, props);
    app.use(router);
    provide?.(app);
    return ((await mods.renderer.renderToString(app)) as string).replace(/<!--[^>]*-->/g, "");
  }
  const settingsWith = (money: unknown) => (app: { provide: (k: unknown, v: unknown) => void }) => {
    const s = mods.settings.createLeagueSettings({ api: (async () => { throw new Error("no api"); }) as never });
    s.state.view = { id: "tabbl", revision: 2, money };
    app.provide(mods.settings.LEAGUE_SETTINGS_KEY, s);
  };

  it("the Money card: scope picker, the formula, the four budget rules, the cap and the change log", async () => {
    const view = moneyRulesView({
      moneyRules: { perTouchdown: 20_000 }, moneyRulesVersion: 2,
      moneyRulesLog: [
        { at: "2026-11-04T10:00:00.000Z", by: "Jay", version: 1, scope: "league", before: DEFAULT_MONEY_RULES, after: DEFAULT_MONEY_RULES, changes: ["Petty cash: on to off"] },
        { at: "2026-11-04T11:00:00.000Z", by: "Kim", version: 2, scope: { seasonId: "season-2", name: "Season 2" }, before: DEFAULT_MONEY_RULES, after: DEFAULT_MONEY_RULES, changes: ["Win bonus: 0k to 10k"] },
      ],
    }, [{ id: "season-2", name: "Season 2", number: 2, rules: { money: { winBonus: 10_000 } } }, { id: "ladder-1", name: "Open Ladder", number: 3, ladder: {} }]);
    const html = await render(mods.Money, {}, settingsWith(view));
    expect(html).toContain(">Money</h2>");
    expect(html).toContain("Rules version 2");
    expect(html).toContain("Season 2 (season) · own rules");
    expect(html).toContain("Open Ladder (ladder)");
    expect(html).toContain("touchdowns x 20k"); // the live formula
    expect(html).toContain("Changes apply from the next fixture. Games already played keep their numbers.");
    for (const b of ["Team value gap plus treasury top-up", "Team value gap only", "Treasury only", "A fixed amount per game"]) expect(html).toContain(b);
    expect(html).toContain("Use the BB2025 rulebook formula");
    expect(html).toContain("Legacy: 10k per touchdown"); // the old default, now a preset
    expect(html).toContain("data-money-legacy");
    expect(html).not.toContain("data-money-preset"); // 20k per touchdown follows neither preset
    expect(html).toContain("Money over the cap is lost");
    expect(html).toContain("It buys Dedicated Fans");
    // the log: newest first, who and what
    expect(html.indexOf("Version 2")).toBeLessThan(html.indexOf("Version 1"));
    expect(html).toContain("Season 2 · Kim");
    expect(html).toContain("Win bonus: 0k to 10k");
    expect(html).toContain("Own rules: Season 2.");
    expect(html).not.toMatch(/style="[^"]*#[0-9a-f]{3}/i);
  });

  it("a league on the defaults: the card shows the rulebook formula and names it; the log says so", async () => {
    const html = await render(mods.Money, {}, settingsWith(moneyRulesView({}, [])));
    expect(html).toContain("fan attendance x 0.5 x 10k + touchdowns x 10k + 10k without stalling");
    expect(html).toContain("(the BB2025 rulebook)");
    expect(html).toContain("The league plays on the defaults (the BB2025 rulebook formula).");
  });

  it("an older server without money settings: a single muted line", async () => {
    expect(await render(mods.Money, {}, settingsWith(undefined))).toContain("This server does not offer the money settings yet.");
  });

  it("the ruleset card's Money section: read-only rows; organisers get Edit; tournaments show none", async () => {
    const rb: MoneyRules = { ...DEFAULT_MONEY_RULES, ...BB2025_RULEBOOK_WINNINGS, treasuryCapEnabled: true, treasuryCap: 500_000, inducementBudget: "fixed", fixedBudget: 120_000 } as MoneyRules;
    const coach = await render(mods.House, { kind: "league", rules: null, ruleset: "BB2025", idPrefix: "lg", money: rb, moneyEditTo: null });
    expect(coach).toContain("data-money-rules");
    expect(coach).toContain("fan attendance x 0.5 x 10k + touchdowns x 10k + 10k without stalling");
    expect(coach).toContain("120k per team per game");
    expect(coach).toContain("500k, the rest is lost");
    expect(coach).toContain("The conceding team gets no winnings");
    expect(coach).not.toContain("data-money-edit");
    const org = await render(mods.House, { kind: "league", rules: null, ruleset: "BB2025", idPrefix: "lg", money: DEFAULT_MONEY_RULES, moneyEditTo: { name: "league-settings", params: { id: "tabbl" }, query: { tab: "money" } } });
    expect(org).toContain("data-money-edit");
    // the defaults (owner 11-04): the BB2025 rulebook formula and concession rule
    expect(org).toContain("fan attendance x 0.5 x 10k + touchdowns x 10k + 10k without stalling (the BB2025 rulebook)");
    expect(org).toContain("The conceding team gets no winnings");
    expect(org).toContain("Team value gap plus treasury top-up");
    expect(coach).toContain("Not used"); // petty cash under a fixed amount
    const tn = await render(mods.House, { kind: "tournament", rules: null, ruleset: "BB2025", idPrefix: "tn" });
    expect(tn).not.toContain("data-money-rules");
  });

  it("the recorder's post-game summary lists the winnings lines and the cap under league money rules only", async () => {
    const base = { outcome: "won", score: { for: 2, against: 1 }, applied: true, postMatch: "full", winnings: 70_000, treasuryBefore: 100_000, treasuryAfter: 120_000, fansBefore: 3, fansAfter: 4, deaths: [], players: [] };
    const html = await render(mods.Summary, { heading: "Orcs", summary: { ...base, money: { version: 4, attendance: 8, stalled: false, lines: [{ what: "Fan attendance 8 x 0.5", gold: 40_000 }, { what: "2 touchdowns", gold: 20_000 }, { what: "No stalling", gold: 10_000 }], capLost: 30_000 } } });
    expect(html).toContain("Winnings: Fan attendance 8 x 0.5 40k + 2 touchdowns 20k + No stalling 10k · treasury cap: 30k lost · money rules v4");
    const plain = await render(mods.Summary, { heading: "Orcs", summary: base });
    expect(plain).not.toContain("data-money-lines");
  });

  it("the fixture summary says when the league's money rules change the inducement cash", async () => {
    const stats = { played: 0, wins: 0, draws: 0, losses: 0, tdPerGame: 0, casPerGame: 0, form: [] };
    const side = (name: string, pettyCash: number, limit: number) => ({
      coach: name, coachId: name, team: { id: name, name, race: "Orc", tv: 1_000_000, treasury: 50_000 }, standing: null, stats: { season: stats, allTime: stats },
      inducements: { budget: { role: "equal", pettyCash, treasury: 50_000, topUpLimit: limit - pettyCash, limit } },
    });
    const view = (rules: Record<string, unknown>) => ({
      header: { competition: "TABBL", round: 2, ruleset: "BB2025" }, sides: { home: side("Ann", 100_000, 100_000), away: side("Bob", 100_000, 100_000) },
      inducements: { step: true, reason: "", rules: { treasuryTopUp: false, highlander: false, starClash: "refund", ...rules }, gap: 0, underdog: null, overdog: null, overdogFinal: false },
    });
    const fixed = await render(mods.Fixture, { view: view({ fixedBudget: 100_000 }), left: "home", crests: { home: "", away: "" }, rosterLinks: false });
    expect(fixed).toContain("League money rules: each team gets 100K for inducements this game.");
    const treasury = await render(mods.Fixture, { view: view({ pettyCash: false, treasuryTopUp: true }), left: "home", crests: { home: "", away: "" }, rosterLinks: false });
    expect(treasury).toContain("no petty cash; inducements are paid from the treasury");
    const plain = await render(mods.Fixture, { view: view({ treasuryTopUp: true }), left: "home", crests: { home: "", away: "" }, rosterLinks: false });
    expect(plain).not.toContain("data-budget-note");
  });
});
