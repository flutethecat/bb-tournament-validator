import { describe, expect, it } from "vitest";
import { resolveTeamConfig } from "@bb/validator";
import {
  leagueBuilderContext, leagueRaceProblems, leagueSeasonPackage, nafApprovedRosters, resolveLeaguePackage, rosterAllowed, rosterClasses, withLeagueProblems,
} from "../src/leagues/leagueBuilder.js";
import { isLeaguePackageName, leaguePackageName, parseLeaguePackageName } from "../src/leagueBuilderMarker.js";
import { resolveBuilderPackage } from "../src/teamBuilderPackage.js";
import type { LeagueRecord, SeasonRecord } from "../src/leagues/types.js";

// Roster Builder league mode (registration spec 11-02, lane L7): the season's team-building rules as a validator package,
// the Q10 roster classes, max per race and the builder's league context.

const league = (registrations: Partial<LeagueRecord["registrations"]> = {}): LeagueRecord => ({
  id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", description: "", organisers: ["Alice"],
  registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null, ...registrations },
  createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
});
const season = (over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: "s7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active",
  phases: [], fixtures: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00.000Z", source: "manual",
  teams: [
    { id: "t1", name: "Grim Orcs", race: "Orc", coach: "Bob", teamValue: null, players: [], formerPlayers: [] },
    { id: "t2", name: "Green Tide", race: "orc", coach: "Cy", teamValue: null, players: [], formerPlayers: [] },
    { id: "t3", name: "Stunties", race: "Halfling", coach: "Di", teamValue: null, players: [], formerPlayers: [] },
  ] as never,
  rules: {
    teamBuilding: {
      eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"],
      rosters: [
        { roster: "Halfling", tier: 4, treasury: 1150, startingSkills: { primary: 2, secondary: 1, elite: 1 } },
        { roster: "Orc", tier: 1, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } },
      ],
    },
    inducements: { standard: { bribes: { price: 50_000, cap: 2 }, wandering_apothecaries: { enabled: false } }, custom: [], revision: 1 },
  },
  ...over,
});

describe("league package marker", () => {
  it("round-trips league and season ids and refuses anything else", () => {
    expect(leaguePackageName("tabbl", "s7")).toBe("league:tabbl:s7");
    expect(parseLeaguePackageName("league:tabbl:s7")).toEqual({ leagueId: "tabbl", seasonId: "s7" });
    for (const bad of ["tabbl", "league:", "league:tabbl", "league:TABBL:s7", "league:tabbl:s7:x", "league:../x:s7", 7, null]) expect(parseLeaguePackageName(bad)).toBeNull();
    expect(leaguePackageName("Bad Id", "s7")).toBe("");
    expect(isLeaguePackageName("free-create")).toBe(false);
  });
});

describe("roster classes (Q10)", () => {
  it("official = the BB2025 dataset, NAF-approved = the admin list, unofficial = everything else", () => {
    expect(rosterClasses("Orc").primary).toBe("official");
    expect(rosterClasses("Chaos Pact", ["Chaos Pact"]).primary).toBe("nafApproved");
    expect(rosterClasses("Simyin", ["Chaos Pact"]).primary).toBe("unofficial");
    // On both lists: displayed as official, admitted by either class.
    expect(rosterClasses("Slann", ["Slann"])).toEqual({ official: true, nafApproved: true, primary: "official" });
    expect(rosterAllowed("Slann", { official: false, nafApproved: true, unofficial: false }, ["Slann"]).allowed).toBe(true);
    expect(rosterAllowed("Orc", { official: false, nafApproved: true, unofficial: false }, [])).toEqual({ allowed: false, reason: "Official rosters aren't allowed in this league." });
    expect(rosterAllowed("Simyin", { official: true, nafApproved: true, unofficial: false }, []).reason).toBe("Unofficial rosters aren't allowed in this league.");
    expect(rosterAllowed("Simyin", { official: false, nafApproved: false, unofficial: true }, []).allowed).toBe(true);
  });
  it("seeds the admin-kept NAF list from its data file", () => {
    expect(nafApprovedRosters().length).toBeGreaterThan(0);
  });
});

describe("leagueSeasonPackage", () => {
  it("applies the season's treasury, tier and starting skills, and no stars, inducements or stat increases", () => {
    const pkg = leagueSeasonPackage(league(), season());
    expect(pkg.name).toBe("TABBL · Season 7");
    const halfling = resolveTeamConfig(pkg, "Halfling");
    expect(halfling.gold).toBe(1_150_000);
    expect(halfling.tierNumber).toBe(4);
    expect([halfling.maxPrimary, halfling.maxSecondary, halfling.eliteMaxTotal]).toEqual([2, 1, 1]);
    const orc = resolveTeamConfig(pkg, "Orc");
    expect(orc.gold).toBe(1_000_000);
    expect([orc.maxPrimary, orc.maxSecondary]).toEqual([0, 0]);
    // A roster the league never edited keeps the dataset tier and the default treasury.
    const human = resolveTeamConfig(pkg, "Human");
    expect(human.gold).toBe(1_000_000);
    expect(human.tierNumber).toBe(2);
    expect(pkg.starPlayers.allowed).toBe(false);
    expect(pkg.inducements.allowed).toEqual([]);
    expect(pkg.special.statIncreasesAllowed).toBe(false);
    expect(pkg.special.slannAllowed).toBe(true);
    expect(pkg.eligibleRosters).toContain("Slann");
  });
  it("admits only the allowed classes", () => {
    const pkg = leagueSeasonPackage(league({ allowedRosters: { official: false, nafApproved: true, unofficial: false } }), season(), ["Slann"]);
    expect(pkg.eligibleRosters).toEqual(["Slann"]);
    expect(pkg.tiers?.flatMap((t) => t.rosters)).toEqual(["Slann"]);
    const none = leagueSeasonPackage(league({ allowedRosters: { official: false, nafApproved: true, unofficial: false } }), season(), []);
    expect(none.eligibleRosters).toEqual(["(no roster allowed)"]);
  });
});

describe("max per race and the league context", () => {
  it("counts the season's teams per race (dataset names) and disables a full race with a reason", () => {
    const lg = league({ maxPerRace: 2 });
    expect(leagueRaceProblems(lg, season(), "Orc")).toEqual(["Orc: 2 / 2 teams in this season, full."]);
    expect(leagueRaceProblems(lg, season(), "Halfling")).toEqual([]);
    const ctx = leagueBuilderContext(lg, season());
    expect(ctx.label).toBe("TABBL · Season 7");
    expect(ctx.packageName).toBe("league:tabbl:s7");
    expect(ctx.registration).toMatchObject({ open: true, maxPerRace: 2, teams: 3, source: "allowRegistration" });
    const orc = ctx.races.find((r) => r.roster === "Orc")!;
    expect(orc).toMatchObject({ teams: 2, full: true, selectable: false, reason: "Full: 2 / 2 Orc teams this season." });
    expect(ctx.races.find((r) => r.roster === "Halfling")).toMatchObject({ treasury: 1_150_000, tier: 4, startingSkills: { primary: 2, secondary: 1, elite: 1 }, selectable: true, class: "official" });
  });
  it("lists the season's offered inducements at the league's terms (bought before each match)", () => {
    const ctx = leagueBuilderContext(league(), season());
    expect(ctx.inducements.find((i) => i.id === "bribes")).toMatchObject({ price: 50_000, cap: 2 });
    expect(ctx.inducements.some((i) => i.id === "wandering_apothecaries")).toBe(false);
  });
  it("registration is open only while Allow registration is on and the season is not finished (until L0's window)", () => {
    expect(leagueBuilderContext(league({ allowRegistration: false }), season()).registration.open).toBe(false);
    expect(leagueBuilderContext(league(), season({ status: "completed" })).registration.open).toBe(false);
  });
  it("a class the league turned off disables those races with the class reason", () => {
    const ctx = leagueBuilderContext(league({ allowedRosters: { official: false, nafApproved: true, unofficial: false } }), season(), ["Slann"]);
    expect(ctx.races.find((r) => r.roster === "Orc")).toMatchObject({ allowed: false, selectable: false, reason: "Official rosters aren't allowed in this league." });
    expect(ctx.races.find((r) => r.roster === "Slann")).toMatchObject({ allowed: true, selectable: true });
  });
});

describe("resolveBuilderPackage league hook", () => {
  const store = { league: (id: string) => (id === "tabbl" ? league({ maxPerRace: 2 }) : undefined), season: (_l: string, id: string) => (id === "s7" ? season() : undefined) };
  const hook = (name: string) => resolveLeaguePackage(store, name);
  it("resolves the marker to the season's package; other names fall through unchanged", () => {
    const hit = resolveBuilderPackage(new Map() as never, { name: "baseline" } as never, "league:tabbl:s7", hook);
    expect("error" in hit).toBe(false);
    if ("error" in hit) return;
    expect(hit.selected?.name).toBe("TABBL · Season 7");
    expect(hit.league).toMatchObject({ leagueId: "tabbl", seasonId: "s7" });
    expect(resolveBuilderPackage(new Map() as never, { name: "baseline" } as never, "league:tabbl:nope", hook)).toEqual({ error: "That league season doesn't exist." });
    expect(resolveBuilderPackage(new Map() as never, { name: "baseline" } as never, undefined, hook)).toEqual({ pkg: { name: "baseline" } });
  });
  it("adds the league's problems to a validator result", () => {
    const hit = hook("league:tabbl:s7")!;
    if ("error" in hit) throw new Error(hit.error);
    const result = withLeagueProblems({ valid: true, errors: [] as Array<{ ruleId: string; severity: string; message: string }> }, hit, "Orc");
    expect(result).toEqual({ valid: false, errors: [{ ruleId: "league", severity: "error", message: "Orc: 2 / 2 teams in this season, full." }] });
    expect(withLeagueProblems({ valid: true, errors: [] }, {}, "Orc").valid).toBe(true);
  });
});

describe("review fixes (Sol, 3fcb3dc9)", () => {
  it("every valid id pair fits the wire, including two 64-character ids; other long package names are still refused", async () => {
    const { teamBuilderBoundsError } = await import("../src/teamBuilderWire.js");
    const longId = `a${"b".repeat(63)}`;
    const marker = leaguePackageName(longId, longId);
    expect(marker.length).toBe(136);
    expect(parseLeaguePackageName(marker)).toEqual({ leagueId: longId, seasonId: longId });
    expect(teamBuilderBoundsError({ rosterId: "dwarf", packageName: marker })).toBeNull();
    expect(teamBuilderBoundsError({ rosterId: "dwarf", packageName: "x".repeat(136) })).toMatch(/packageName must be at most 120/);
    expect(teamBuilderBoundsError({ rosterId: "dwarf", packageName: `league:${longId}:${longId}x` })).toMatch(/packageName must be at most 120/);
  });

  it("a league save load that resolves after a newer ruleset choice is dropped", async () => {
    const { createTournamentBuilder } = await import("../spa/src/teams/builder");
    let release: (v: unknown) => void = () => undefined;
    const ctx = leagueBuilderContext(league(), season());
    const routes: Record<string, unknown> = {
      "/api/fork/rosters": { rosters: [] }, "/api/packages": [], "/api/skills": {},
      "/api/fork/team-builder/saves/sv_1": { save: { id: "sv_1", name: "Old", body: { rosterId: "dwarf", packageName: "league:tabbl:s7", picks: [] } } },
    };
    const api = (async (path: string) => {
      if (path === "/api/leagues/tabbl/seasons/s7/team-building") return new Promise((resolve) => { release = resolve; });
      if (path in routes) return routes[path];
      if (path.startsWith("/api/fork/team-builder/inducements")) return { inducements: [] };
      throw new Error(`no mock ${path}`);
    }) as never;
    const b = createTournamentBuilder({ api, coach: () => "Alice", previewDelay: 0 });
    await b.boot();
    const loading = b.loadSave("sv_1");
    await new Promise((r) => setTimeout(r, 0));
    await b.choosePackage("free-create");
    release(ctx);
    expect(await loading).toBe(false);
    expect(b.state.packageName).toBe("free-create");
    expect(b.state.leagueCtx).toBeNull();
    expect(b.state.currentSave).toBeNull();
    expect(b.state.savesStatus).toBe("");
  });
});
