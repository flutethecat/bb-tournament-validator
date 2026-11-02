import { describe, expect, it } from "vitest";
import {
  BROWSE_VIEW_KEY, browseRows, followsRouteQuery, routeQuery, browseStatus, emptyFilters, fold, highlightParts, hitSnippet, leagueRegion, matchLeague, readBrowseView, rulesetText,
  sortRows, writeBrowseView,
} from "../spa/src/leagues/browse";
import type { LeagueSummary, SeasonSummary } from "../spa/src/leagues/types";

// Browse leagues helpers (spa/src/leagues/browse.ts): search over every public identifier, filters, sorting and the
// remembered Cards | Table choice.

const season = (over: Partial<SeasonSummary> = {}): SeasonSummary => ({
  id: "season-1", number: 1, name: "Season 1", ruleset: "BB2025", status: "active", teamCount: 4, fixtureCount: 0, playedCount: 0, ...over,
});

const league = (over: Partial<LeagueSummary> & { id: string; name: string }): LeagueSummary => ({
  fullName: "", slug: over.id, description: "", organisers: [], createdAt: "2026-10-01T00:00:00.000Z", seasonCount: 1,
  browse: { status: "in-progress", registrationOpen: false, regions: [], seasons: [], teams: [] }, ...over,
});

const harbour = league({
  id: "demo-harbour", name: "Demo Harbour", fullName: "Demo Harbour Blood Bowl League", slug: "harbour-bbl", description: "Weekly games at the Example Games Hall by the quay.",
  organisers: ["demo-organiser-ana"], rulesetPackage: "Small Gods", playOnFork: true, currentSeason: season({ name: "Autumn Cup", teamCount: 12, startedAt: "2026-08-30T00:00:00.000Z" }),
  browse: { status: "in-progress", registrationOpen: false, location: "Port Example, WA", regions: ["North bank"], test: true, seasons: ["Autumn Cup", "Spring Shield"],
    teams: [{ name: "Grudge Rollers", coach: "Pat Example" }, { name: "Mud Moles", coach: "Zoë Sample" }] },
});
const river = league({
  id: "river", name: "River Cup", fullName: "River Valley Cup", currentSeason: season({ ruleset: "BB2020", stage: "registration", teamCount: 3 }),
  browse: { status: "registration", registrationOpen: true, regions: [], seasons: ["Season 1"], teams: [] },
});
const quiet = league({ id: "quiet", name: "Quiet League", browse: { status: "off-season", registrationOpen: false, regions: [], seasons: [], teams: [] } });
const done = league({ id: "done", name: "Done League", currentSeason: season({ status: "completed", teamCount: 8, startedAt: "2025-01-01T00:00:00.000Z" }),
  browse: { status: "finished", registrationOpen: false, location: "Alpha Town, OR", regions: [], seasons: ["Season 1"], teams: [] } });
const ALL = [harbour, river, quiet, done];

describe("search over every identifier", () => {
  const hit = (q: string, l = harbour) => matchLeague(l, q);
  it.each([
    ["harbour", "name", "Demo Harbour"],
    ["blood bowl league", "fullName", "Demo Harbour Blood Bowl League"],
    ["harbour-bbl", "slug", "harbour-bbl"],
    ["quay", "description", "Weekly games at the Example Games Hall by the quay."],
    ["organiser-ana", "organiser", "demo-organiser-ana"],
    ["port example", "region", "Port Example, WA"],
    ["north bank", "region", "North bank"],
    ["small gods", "ruleset", "Small Gods"],
    ["bb2025", "ruleset", "BB2025"],
    ["in progress", "status", "In progress"],
    ["super fumbbl", "playedOn", "Super FUMBBL"],
    ["spring shield", "season", "Spring Shield"],
    ["grudge", "team", "Grudge Rollers"],
    ["pat example", "coach", "Pat Example"],
  ])("%s matches the %s", (q, field, value) => {
    expect(hit(q)).toMatchObject({ field, value });
  });

  it("is case- and accent-blind and maps the highlight back onto the original text", () => {
    const h = hit("ZOE")!;
    expect(h).toMatchObject({ field: "coach", value: "Zoë Sample", start: 0, end: 3 });
    expect(highlightParts(h.value, h)).toEqual([{ text: "Zoë", mark: true }, { text: " Sample", mark: false }]);
    expect(fold("Zoë").text).toBe("zoe");
    expect(hit("   grudge    rollers ")).toMatchObject({ field: "team" });
  });

  it("no match is null; a blank query lists every league with no hit", () => {
    expect(hit("zebra")).toBeNull();
    expect(browseRows(ALL, "  ", emptyFilters()).map((r) => [r.l.id, r.hit])).toEqual([["demo-harbour", null], ["river", null], ["quiet", null], ["done", null]]);
    expect(browseRows(ALL, "grudge", emptyFilters()).map((r) => r.l.id)).toEqual(["demo-harbour"]);
  });

  it("a long description hit is shortened around the match", () => {
    const long = league({ id: "x", name: "X", description: `${"a".repeat(200)} needle ${"b".repeat(200)}` });
    const snip = hitSnippet(matchLeague(long, "needle")!);
    expect(snip.value.length).toBeLessThan(120);
    expect(snip.value.slice(snip.start, snip.end)).toBe("needle");
    expect(snip.value.startsWith("…") && snip.value.endsWith("…")).toBe(true);
  });
});

describe("filters, status and display helpers", () => {
  it("status chips, played on and Registration open combine (OR within a group, AND across)", () => {
    const ids = (f: Partial<ReturnType<typeof emptyFilters>>) => browseRows(ALL, "", { ...emptyFilters(), ...f }).map((r) => r.l.id);
    expect(ids({ statuses: ["finished", "off-season"] })).toEqual(["quiet", "done"]);
    expect(ids({ playedOn: ["fork"] })).toEqual(["demo-harbour"]);
    expect(ids({ playedOn: ["tabletop"] })).toEqual(["river", "quiet", "done"]);
    expect(ids({ registrationOpen: true })).toEqual(["river"]);
    expect(ids({ statuses: ["in-progress"], playedOn: ["tabletop"] })).toEqual([]);
  });

  it("status falls back to the season stage on an older server", () => {
    expect(browseStatus({ currentSeason: season({ stage: "registration" }) })).toBe("registration");
    expect(browseStatus({ currentSeason: season({ status: "completed" }) })).toBe("finished");
    expect(browseStatus({ currentSeason: season({ stage: "setup" }) })).toBe("off-season");
    expect(browseStatus({})).toBe("off-season");
  });

  it("region and ruleset text", () => {
    expect(leagueRegion(harbour)).toBe("Port Example, WA");
    expect(leagueRegion(league({ id: "r", name: "R", browse: { status: "off-season", registrationOpen: false, regions: ["East", "West"], seasons: [], teams: [] } }))).toBe("East, West");
    expect(leagueRegion(quiet)).toBe("");
    expect(rulesetText(harbour)).toBe("Small Gods (BB2025)");
    expect(rulesetText(river)).toBe("BB2020");
    expect(rulesetText(quiet)).toBe("");
  });
});

describe("table sorting", () => {
  const order = (key: Parameters<typeof sortRows>[1], dir: "asc" | "desc") => sortRows(ALL.map((l) => ({ l })), key, dir).map((r) => r.l.id);
  it("sorts each column both ways; empty values always last; ties by name", () => {
    expect(order("name", "asc")).toEqual(["demo-harbour", "done", "quiet", "river"]);
    expect(order("name", "desc")).toEqual(["river", "quiet", "done", "demo-harbour"]);
    expect(order("teams", "desc")).toEqual(["demo-harbour", "done", "river", "quiet"]);
    expect(order("teams", "asc")).toEqual(["river", "done", "demo-harbour", "quiet"]);
    expect(order("status", "asc")).toEqual(["demo-harbour", "river", "done", "quiet"]);
    expect(order("region", "asc")).toEqual(["done", "demo-harbour", "quiet", "river"]);
    expect(order("dates", "asc")).toEqual(["done", "demo-harbour", "quiet", "river"]);
    expect(order("dates", "desc")).toEqual(["demo-harbour", "done", "quiet", "river"]);
    expect(order("ruleset", "asc")).toEqual(["river", "done", "demo-harbour", "quiet"]);
    expect(order("playedOn", "asc")).toEqual(["demo-harbour", "done", "quiet", "river"]);
    expect(order("season", "asc")).toEqual(["demo-harbour", "done", "river", "quiet"]);
    expect(order("fullName", "asc")).toEqual(["demo-harbour", "river", "done", "quiet"]);
  });
});

describe("current season sort and the ?q= follow rule", () => {
  it("Current season sorts by the shown name (numbers in names compare as numbers); equal names fall back to the season number", () => {
    const at = (id: string, name: string, number: number) => ({ l: league({ id, name: id, currentSeason: season({ name, number }) }) });
    const rows = [at("a", "Season 10", 10), at("b", "Season 2", 2), at("c", "Autumn Cup", 7), at("d", "Season 2", 1), at("e", "Spring", 3)];
    expect(sortRows(rows, "season", "asc").map((r) => r.l.id)).toEqual(["c", "d", "b", "a", "e"]);
    expect(sortRows(rows, "season", "desc").map((r) => r.l.id)).toEqual(["e", "a", "b", "d", "c"]);
  });

  it("a query-only navigation is followed; the echo of the field's own write is not", () => {
    expect(routeQuery("mud")).toBe("mud");
    expect(routeQuery(["a", "b"])).toBe("");
    expect(routeQuery(undefined)).toBe("");
    expect(routeQuery("x".repeat(300))).toHaveLength(200);
    expect(followsRouteQuery("mud", "grudge")).toBe(true); // ?q=grudge -> ?q=mud
    expect(followsRouteQuery("", "grudge")).toBe(true); // Back to the plain list
    expect(followsRouteQuery("grudge", " grudge ")).toBe(false); // our own replace() of the trimmed field
  });

  it("the view watches route.query.q", async () => {
    const { readFileSync } = await import("node:fs");
    const view = readFileSync(new URL("../spa/src/views/LeagueListView.vue", import.meta.url), "utf8");
    expect(view).toMatch(/watch\(\(\) => route\.query\.q,/);
    expect(view).toContain("followsRouteQuery(next, query.value)");
  });
});

describe("the remembered Cards | Table choice", () => {
  it("is per viewer in localStorage, defaults to cards, and survives missing or blocked storage", () => {
    const g = globalThis as { localStorage?: unknown };
    expect(readBrowseView()).toBe("cards");
    expect(() => writeBrowseView("table")).not.toThrow();
    const store = new Map<string, string>();
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    try {
      writeBrowseView("table");
      expect(store.get(BROWSE_VIEW_KEY)).toBe("table");
      expect(readBrowseView()).toBe("table");
      writeBrowseView("cards");
      expect(readBrowseView()).toBe("cards");
      store.set(BROWSE_VIEW_KEY, "nonsense");
      expect(readBrowseView()).toBe("cards");
      g.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
      expect(readBrowseView()).toBe("cards");
      expect(() => writeBrowseView("table")).not.toThrow();
    } finally { delete g.localStorage; }
  });
});
