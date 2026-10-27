import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Owner 10-27: step 2 of the Tournament Builder is the per-team tier table; each eligible team name is a
// button that picks the race. Runs the REAL team-builder.js UI against the same small DOM/fetch stub as
// teamBuilderRestore.test.ts.
const publicDir = new URL("../public/", import.meta.url);
const js = readFileSync(new URL("team-builder.js", publicDir), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function stubElement(id: string): Any {
  const listeners: Record<string, Array<(event: Any) => unknown>> = {};
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  return {
    id, value: "", textContent: "", innerHTML: "", className: "", href: "", title: "", hidden: false, disabled: false, open: false, checked: false,
    dataset: {} as Record<string, string>, style: {} as Record<string, string>, listeners,
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, on?: boolean) => { const next = on ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; },
      contains: (name: string) => classes.has(name),
    },
    setAttribute: (name: string, value: string) => { attributes[name] = String(value); },
    getAttribute: (name: string) => attributes[name] ?? null,
    removeAttribute: (name: string) => { delete attributes[name]; },
    hasAttribute: (name: string) => name in attributes,
    addEventListener: (type: string, fn: (event: Any) => unknown) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    focus: () => undefined,
    blur: () => undefined,
    scrollIntoView: () => undefined,
    showModal() { this.open = true; },
    close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    appendChild: (child: unknown) => child,
    append: () => undefined,
    remove: () => undefined,
  };
}

interface Held { path: string; release: () => void }

function bootBuilder(opts: { search?: string; routes: Record<string, (init: Any) => { status: number; body: unknown }>; hold?: (path: string, method: string) => boolean; prompt?: () => string | null }) {
  const elements = new Map<string, Any>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, stubElement(id)); return elements.get(id); };
  el("team-builder-title");
  const docListeners: Record<string, Array<(event: Any) => unknown>> = {};
  const document = {
    body: { dataset: { builder: "tournament" }, classList: stubElement("body").classList },
    documentElement: stubElement("html"),
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => stubElement(tag),
    addEventListener: (type: string, fn: (event: Any) => unknown) => { (docListeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
  };
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const held: Held[] = [];
  const replaced: string[] = [];
  const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = (path: string, init: Any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = `${method} ${path.split("?")[0]}`;
    const route = opts.routes[`${method} ${path}`] ?? opts.routes[key];
    const out = route ? route(init) : { status: 200, body: {} };
    const result = respond(out.status, out.body);
    if (opts.hold?.(path, method)) return new Promise((resolve) => held.push({ path, release: () => resolve(result) }));
    return Promise.resolve(result);
  };
  const location = { pathname: "/tournament-team-builder.html", search: opts.search ?? "", hash: "", hostname: "localhost", href: "" };
  const context: Record<string, Any> = {
    console, document, fetch, location, URLSearchParams, setTimeout, clearTimeout, Promise, Date, JSON, Math, Map, Set,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    window: { prompt: opts.prompt ?? (() => null), confirm: () => true, print: () => undefined, open: () => null, addEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  };
  context.globalThis = context;
  runInNewContext(js, context);
  return { el, calls, held, replaced };
}

const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

const position = { positionId: "L", name: "Lineman", cost: 50_000, MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+", skills: [], quantity: 16 };
const rosterRows = [
  { rosterId: "dwarf", raceName: "Dwarf", positions: [{ ...position, name: "Dwarf Blocker Lineman" }], rerollCost: 50_000 },
  { rosterId: "orc", raceName: "Orc", positions: [{ ...position, name: "Orc Lineman" }], rerollCost: 60_000 },
  { rosterId: "human", raceName: "Human", positions: [{ ...position, name: "Human Lineman" }], rerollCost: 50_000 },
];
const team = (name: string, gold = 1_150_000) => ({ name, gold, goldMax: null, allotment: ["8 skills"], secondary: "1", stackLimit: "2 Primary · OR · 1 Primary + 1 Secondary" });
const tieredRules = {
  name: "Cup", budget: 1_150_000, tierSummary: [{ tier: 1, label: "Tier 1", rosters: ["Dwarf", "Orc", "Night Goblin"], gold: 1_150_000 }],
  overview: { summary: [{ key: "structure", label: "Structure", text: "Tiered." }], groups: [{ tier: 1, label: "Tier 1", teams: [team("Dwarf"), team("Orc"), team("Night Goblin")] }] },
};
const flatRules = {
  name: "Open", budget: 1_000_000, tierSummary: [],
  overview: { summary: [], groups: [{ tier: null, label: "All teams", teams: [{ ...team("Every eligible roster (2)", 1_000_000) }] }] },
};
const routes = (rules: Any, eligibleRosters: string[], tierRaces: Any[]) => ({
  "GET /api/fork/rosters": () => ({ status: 200, body: { rosters: rosterRows } }),
  "GET /api/packages": () => ({ status: 200, body: [{ name: "Cup" }] }),
  "GET /api/packages/Cup": () => ({ status: 200, body: { pkg: { name: "Cup", eligibleRosters }, rules } }),
  "GET /api/fork/team-builder/tiers": () => ({ status: 200, body: { races: tierRaces } }),
});
const tiered = () => routes(tieredRules, ["Dwarf", "Orc", "Night Goblin"], [{ name: "Dwarf", tier: 1, gold: 1_150_000 }, { name: "Orc", tier: 1, gold: 1_150_000 }, { name: "Night Goblin", tier: 1, gold: 1_150_000 }]);
const clickRace = (page: Any, rosterId: string) => {
  for (const fn of page.el("tt-races").listeners.click ?? []) fn({ target: { closest: (sel: string) => (sel === "[data-tt-race]" ? { dataset: { ttRace: rosterId } } : null) } });
};

describe("tournament builder — step 2 race table (owner 10-27)", () => {
  it("renders the tier table with one pick button per eligible team; a team missing from the fork is plain text", async () => {
    const page = bootBuilder({ search: "?package=Cup&step=2", routes: tiered() });
    await flush();
    expect(page.el("tt-step-race").hidden).toBe(false);
    expect(page.el("tt-race-title").textContent).toBe("Step 2 — Pick a race for Cup");
    const html: string = page.el("tt-tier-table").innerHTML;
    expect(html.match(/<button type="button" class="tt-team-pick/g)).toHaveLength(2);
    expect(html).toContain('data-tt-race="dwarf"');
    expect(html).toContain('data-tt-race="orc"');
    expect(html).toContain('<span class="tt-team-off">Night Goblin <small class="tt-team-na">(not available)</small></span>');
    expect(html).not.toContain('data-tt-race="human"');
    // One cap + one allotment for the tier → merged cells.
    expect(html).toContain('<td class="tt-rt-num tt-rt-gold tt-rt-span" rowspan="3">1,150k</td>');
    expect(page.el("tt-tier-empty").hidden).toBe(true);
    // Step 1 no longer carries the table: only the summary + Choose a race.
    expect(page.el("tt-package-summary").innerHTML).toContain("Structure");
  });

  it("clicking a team button selects that race and moves to the Build step", async () => {
    const page = bootBuilder({ search: "?package=Cup&step=2", routes: tiered() });
    await flush();
    clickRace(page, "dwarf");
    await flush();
    expect(page.el("race").value).toBe("dwarf");
    expect(page.el("builder-panel").hidden).toBe(false);
    expect(page.el("tt-step-race").hidden).toBe(true);
    expect(page.el("tt-step-2-title").textContent).toContain("Dwarf");
  });

  it("an ineligible roster id (not admitted by the package) never advances", async () => {
    const page = bootBuilder({ search: "?package=Cup&step=2", routes: tiered() });
    await flush();
    clickRace(page, "human");
    await flush();
    expect(page.el("race").value).toBe("");
    expect(page.el("builder-panel").hidden).toBe(true);
    expect(page.el("tt-step-race").hidden).toBe(false);
  });

  it("a package without tiers lists every eligible roster as buttons under one All teams group", async () => {
    const page = bootBuilder({ search: "?package=Cup&step=2", routes: routes(flatRules, ["Orc", "Human"], []) });
    await flush();
    const html: string = page.el("tt-tier-table").innerHTML;
    expect(html).toContain('<span class="tt-rt-all">All teams</span>');
    expect(html).not.toContain("Every eligible roster");
    expect(html.match(/<button type="button" class="tt-team-pick/g)).toHaveLength(2);
    expect(html).toContain('data-tt-race="human"');
    expect(html).toContain('data-tt-race="orc"');
    expect(html).not.toContain('data-tt-race="dwarf"');
    clickRace(page, "human");
    await flush();
    expect(page.el("builder-panel").hidden).toBe(false);
  });

  it("an older server without the overview still gets the legacy tier table with pick buttons", async () => {
    const { overview: _drop, ...legacyRules } = tieredRules;
    const page = bootBuilder({ search: "?package=Cup&step=2", routes: { ...tiered(), "GET /api/packages/Cup": () => ({ status: 200, body: { pkg: { name: "Cup", eligibleRosters: ["Dwarf", "Orc", "Night Goblin"] }, rules: legacyRules } }) } });
    await flush();
    expect(page.el("tt-tier-table").className).toBe("tier-table");
    const html: string = page.el("tt-tier-table").innerHTML;
    expect(html).toContain('data-tt-race="dwarf"');
    expect(html).toContain("Night Goblin <small class=\"tt-team-na\">(not available)</small>");
  });
});
