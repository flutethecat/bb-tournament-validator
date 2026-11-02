import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { phaseComplete, phaseFoldId, phaseFoldKey, phaseOpen, readPhaseFolds, writePhaseFold } from "../spa/src/leagues/fixtureNav";

// League UX pass A (owner 11-02): fixtures phases collapse, the standings phase selector and popups, the honours pin icon
// and Player / Coach / Team selector. Pure helpers here; rendered checks where a template carries the rule.
const src = (path: string) => readFileSync(new URL(`../spa/src/${path}`, import.meta.url), "utf8");

const round = (played: number, total: number) => ({ round: 1, played, fixtures: Array.from({ length: total }, () => ({})) });

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; }, clear: () => m.clear(), key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); },
  };
}

describe("fixtures: collapsible phases", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a phase is complete when every fixture of every round is played; a phase without fixtures is not", () => {
    expect(phaseComplete({ rounds: [round(4, 4), round(2, 2)] as never })).toBe(true);
    expect(phaseComplete({ rounds: [round(4, 4), round(1, 2)] as never })).toBe(false);
    expect(phaseComplete({ rounds: [] })).toBe(false);
  });

  it("defaults: completed phases collapsed, the current and coming ones open; a viewer's toggle wins", () => {
    const done = { rounds: [round(2, 2)] } as never;
    const live = { rounds: [round(2, 2), round(0, 2)] } as never;
    expect(phaseOpen({}, "s6:pre", done)).toBe(false);
    expect(phaseOpen({}, "s6:regular", live)).toBe(true);
    expect(phaseOpen({ "s6:pre": true }, "s6:pre", done)).toBe(true);
    expect(phaseOpen({ "s6:regular": false }, "s6:regular", live)).toBe(false);
  });

  it("toggles persist per league in localStorage, keyed by season and phase; junk and missing storage fall back to the defaults", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readPhaseFolds("harbour")).toEqual({});
    writePhaseFold("harbour", phaseFoldId("season-6", "pre"), true);
    writePhaseFold("harbour", phaseFoldId("season-6", "regular"), false);
    expect(readPhaseFolds("harbour")).toEqual({ "season-6:pre": true, "season-6:regular": false });
    expect(readPhaseFolds("other-league")).toEqual({}); // per league
    expect(localStorage.getItem(phaseFoldKey("harbour"))).toBe('{"season-6:pre":true,"season-6:regular":false}');
    localStorage.setItem(phaseFoldKey("harbour"), "not json");
    expect(readPhaseFolds("harbour")).toEqual({});
    localStorage.setItem(phaseFoldKey("harbour"), '{"a":true,"b":"yes","c":1}');
    expect(readPhaseFolds("harbour")).toEqual({ a: true });
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readPhaseFolds("harbour")).toEqual({});
    expect(writePhaseFold("harbour", "x", true)).toEqual({ x: true }); // no throw; the session keeps the toggle
  });

  it("the phase band is a button with aria-expanded; the table view is unchanged", () => {
    const vue = src("components/LeagueFixtures.vue");
    expect(vue).toMatch(/<button type="button" class="lg-fx-fold" :aria-expanded="isOpen\(g\.phase\.id\) \? 'true' : 'false'" data-phase-toggle @click="toggle\(g\.phase\.id\)">/);
    expect(vue).toContain('<template v-if="!isOpen(g.phase.id)" />');
    expect(vue).toContain('<table v-else class="sf-table lg-fx-table">');
    // completion is judged on the whole phase, not the round on show
    expect(vue).toContain("const wholePhase = (id: string) => groups.value.find((x) => x.phase.id === id)");
  });
});
