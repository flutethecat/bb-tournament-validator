/**
 * End-to-end regression scenarios against the REAL bundled BB2025 dataset and the
 * actual example-PDF Amazon roster. These exercise the whole resolver + rules +
 * render surface the way the bot / config service will, catching cross-cutting
 * regressions the per-unit tests might miss. Documented in docs/regression-scenarios.md.
 */

import { describe, expect, it } from "vitest";
import {
  loadPackage,
  renderArtPrompt,
  renderPackageHtml,
  resolveTeamConfig,
  validate,
  type DeepPartial,
  type Roster,
  type RosterPlayer,
  type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import fixtureJson from "../../../fixtures/amazon-example.roster.json";

const amazon = () => structuredClone(fixtureJson) as unknown as Roster;
const load = (raw: DeepPartial<TournamentPackage>) => loadPackage(raw).pkg;
const errs = (r: ReturnType<typeof validate>, id?: string) =>
  id ? r.errors.filter((e) => e.ruleId === id) : r.errors;

const eagle = (n: number, extra: string[] = []): RosterPlayer => ({
  number: n,
  positionName: "Eagle Warrior",
  MA: 6,
  ST: 3,
  AG: "3+",
  PA: "4+",
  AV: "8+",
  skills: ["Dodge", ...extra],
  keywords: ["Human", "Lineman"],
  cost: 50000,
});

describe("R1 — golden: example Amazon passes a matching SP package", () => {
  it("6 primary skills within a 10-SP budget at 1.2M gold", () => {
    const pkg = load({ name: "R1", eligibleRosters: ["Amazon"], goldBudget: 1_200_000, skillAllotment: { skillPointBudget: 10 } });
    const r = validate(amazon(), pkg, bb2025);
    expect(r.valid).toBe(true);
  });
});

describe("R2 — tier gold cap under team value fails", () => {
  it("Amazon (1.2M) over a Tier-1 1.15M cap", () => {
    const pkg = load({
      name: "R2",
      tiers: [{ tier: 1, rosters: ["Amazon"], gold: 1_150_000, starPlayersAllowed: true, bannedStars: [] }],
      skillAllotment: { skillPointBudget: 20 },
    });
    const r = validate(amazon(), pkg, bb2025);
    expect(errs(r, "gold-budget")[0]!.message).toMatch(/over the 1,?150k? budget \(Tier 1\)/);
  });
});

describe("R3 — matrix count mode: cell sets gold + primary/secondary", () => {
  const matrixPkg = (primary: number) =>
    load({
      name: "R3",
      matrix: {
        columns: [{ gold: 1_200_000 }],
        rows: [{ label: `${primary} primary`, primary, secondary: 0, secondarySwap: false }],
        cells: [{ col: 0, row: 0, teams: ["Amazon"] }],
      },
      skillAllotment: { skillPointBudget: 0 },
    });

  it("passes at 6 primary (the example has exactly 6)", () => {
    expect(validate(amazon(), matrixPkg(6), bb2025).valid).toBe(true);
  });
  it("fails at 5 primary with a count message tagged (matrix)", () => {
    const r = validate(amazon(), matrixPkg(5), bb2025);
    expect(errs(r, "skill-points")[0]!.message).toMatch(/6 primary \+ 0 secondary.*\(matrix\)/);
  });
});

describe("R4 — team rule precedence over the package/tier", () => {
  it("team-rule gold overrides the flat goldBudget", () => {
    const pkg = load({
      name: "R4",
      eligibleRosters: ["Amazon"],
      goldBudget: 1_000_000,
      teamRules: [{ team: "Amazon", gold: 1_300_000 }],
      skillAllotment: { skillPointBudget: 20 },
    });
    expect(resolveTeamConfig(pkg, "Amazon").gold).toBe(1_300_000);
    expect(validate(amazon(), pkg, bb2025).valid).toBe(true); // 1.2M <= 1.3M
  });
});

describe("R5 — secondary swap feasibility on real dataset positions", () => {
  // 11 Eagle Warriors, 2 with an added Strength skill (Guard = secondary for a Lineman).
  const swapRoster = (): Roster => {
    const players = Array.from({ length: 11 }, (_, i) => eagle(i + 1, i < 2 ? ["Guard"] : []));
    return { ...amazon(), players };
  };

  it("2 secondaries fit 4 primary + 0 secondary WITH swap (2 primaries each)", () => {
    const pkg = load({ name: "R5a", eligibleRosters: ["Amazon"], teamRules: [{ team: "Amazon", maxPrimary: 4, maxSecondary: 0, secondarySwap: true }], skillAllotment: { skillPointBudget: 0 } });
    expect(errs(validate(swapRoster(), pkg, bb2025), "skill-points")).toHaveLength(0);
  });
  it("the same team FAILS without swap", () => {
    const pkg = load({ name: "R5b", eligibleRosters: ["Amazon"], teamRules: [{ team: "Amazon", maxPrimary: 4, maxSecondary: 0, secondarySwap: false }], skillAllotment: { skillPointBudget: 0 } });
    expect(errs(validate(swapRoster(), pkg, bb2025), "skill-points")[0]!.message).toMatch(/0 primary \+ 2 secondary/);
  });
});

describe("R6 — global banned star is caught (and stars aren't mis-flagged as bad positions)", () => {
  const withMorg = (): Roster => {
    const r = amazon();
    r.players[10] = { ...r.players[10]!, positionName: "Morg 'n' Thorg", skills: [], cost: 340000 };
    return r;
  };
  it("flags the globally banned star", () => {
    const pkg = load({ name: "R6", eligibleRosters: ["Amazon"], bannedStars: ["Morg 'n' Thorg"], skillAllotment: { skillPointBudget: 20 } });
    const r = validate(withMorg(), pkg, bb2025);
    expect(errs(r, "star-players").some((e) => /Morg 'n' Thorg is banned/.test(e.message))).toBe(true);
  });
  it("does NOT report a known star as an unknown position", () => {
    const pkg = load({ name: "R6b", eligibleRosters: ["Amazon"], skillAllotment: { skillPointBudget: 20 } });
    const r = validate(withMorg(), pkg, bb2025);
    expect(errs(r, "positional-limits").some((e) => /Morg/.test(e.message))).toBe(false);
  });
});

describe("R7 — unknown race fails gracefully (M1 Amazon-only dataset)", () => {
  it("errors clearly instead of validating a race we have no data for", () => {
    const r = validate({ ...amazon(), rosterName: "Orc" }, load({ name: "R7", eligibleRosters: ["*"], skillAllotment: { skillPointBudget: 10 } }), bb2025);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.ruleId === "dataset")).toBe(true);
  });
});

describe("R8 — renderers work for every config mode", () => {
  const modes: [string, Partial<TournamentPackage>][] = [
    ["flat", { eligibleRosters: ["Amazon"] }],
    ["tiers", { tiers: [{ tier: 1, rosters: ["Amazon"], gold: 1_200_000, starPlayersAllowed: true, bannedStars: [] }] }],
    ["matrix", { matrix: { columns: [{ gold: 1_200_000 }], rows: [{ primary: 6, secondary: 0, secondarySwap: true }], cells: [{ col: 0, row: 0, teams: ["Amazon"] }] } }],
    ["teamRules", { teamRules: [{ team: "Amazon", gold: 1_200_000, maxPrimary: 6 }] }],
  ];
  it.each(modes)("renderPackageHtml(%s) is a valid standalone doc mentioning Amazon", (_m, extra) => {
    const html = renderPackageHtml(load({ name: `Mode ${_m}`, ...extra }));
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain("Amazon");
  });
  it.each(modes)("renderArtPrompt(%s) mentions Amazon + Blood Bowl", (_m, extra) => {
    const p = renderArtPrompt(load({ name: `Mode ${_m}`, ...extra }));
    expect(p).toContain("Amazon");
    expect(p).toMatch(/BLOOD BOWL/i);
  });
});

describe("R9 — package normalization round-trips through loadPackage", () => {
  it("a partial package gets defaults filled and keeps its overrides", () => {
    const pkg = load({ name: "R9", skillAllotment: { skillPointBudget: 7, eliteSurchargeSP: 0 } });
    expect(pkg.skillAllotment.skillPointBudget).toBe(7);
    expect(pkg.skillAllotment.eliteSurchargeSP).toBe(0);
    expect(pkg.skillAllotment.primaryCostSP).toBe(1); // default
    expect(pkg.special.minPlayers).toBe(11); // default
  });
});
