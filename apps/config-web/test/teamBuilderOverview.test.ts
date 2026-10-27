import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadPackage, type TournamentPackage } from "@bb/validator";
import { packageOverview, packageRulesInfo, type RulesetOverview } from "../src/teamBuilderPackage";

// Owner 10-27: the Tournament Team Builder's step-1 summary + per-team tier table are generated from
// package VALUES (never the organiser's description). One case per structure kind, against the shipped packages
// where one exists and a small synthetic package otherwise.
const shipped = (file: string): TournamentPackage =>
  loadPackage(JSON.parse(readFileSync(new URL(`../../../tournament-packages/${file}.json`, import.meta.url), "utf8"))).pkg;
const line = (o: RulesetOverview, key: string) => o.summary.find((l) => l.key === key);
const team = (o: RulesetOverview, name: string) => o.groups.flatMap((g) => g.teams).find((t) => t.name === name)!;

describe("ruleset overview — summary lines", () => {
  it("tiered + gold-priced skills (Small Gods): per-roster caps, gold prices inside the cap, elite tax, star packs", () => {
    const o = packageOverview(shipped("small-gods"));
    expect(o.summary.map((l) => l.key)).toEqual(["structure", "skills", "elite", "stars", "inducements"]);
    expect(line(o, "structure")!.text).toBe("Tiered: 6 tiers, gold caps 1,225k–1,500k (set per roster); added skills cost gold inside the team-value cap.");
    expect(line(o, "skills")!.text).toContain("Primary 20k, secondary 40k, counted inside the cap");
    // One clause per distinct allowed set: Tiers 4–5 may not raise MA (the validator refuses it there).
    expect(line(o, "skills")!.text).toContain(
      "stat increases (Tiers 4–5: +PA 20k or +AV 10k; Tier 6: +MA 20k, +PA 20k or +AV 10k; one increase per player, instead of skills)",
    );
    expect(line(o, "skills")!.text).not.toContain("Tiers 4–6");
    expect(line(o, "elite")!.text).toBe("Block, Guard, Mighty Blow, Dodge +10k each; limits per tier (table).");
    expect(line(o, "stars")!.text).toMatch(/^Tiers 2–6 only; max 2 picks from packs: Free \(no fee, max 2\) · Star \(\+20k once, max 2\)/);
    expect(line(o, "stars")!.text).toContain("packs open per tier, some rosters differ (table)");
    expect(line(o, "inducements")!.text).toBe("All inducements at book cost.");
  });

  it("tiered + SP budget per team (NAF): SP prices, stack surcharge, per-team stacks and stars, banned list", () => {
    const o = packageOverview(shipped("naf-world-cup-2027"));
    expect(line(o, "structure")!.text).toBe("Tiered: 6 tiers, gold caps 1,080k–1,200k; a skill-point budget per team (44–66 SP).");
    expect(line(o, "skills")!.text).toMatch(/^SP budget per team \(44–66\), primary 6 \/ secondary 10 SP \(\+2 SP for each extra skill on the same player\)/);
    expect(line(o, "elite")!.text).toBe("Block, Guard, Mighty Blow, Dodge +2 SP each.");
    expect(line(o, "stars")!.text).toBe("9 of 31 teams (table); no cap on the number.");
    expect(line(o, "stars")!.details!.summary).toBe("16 banned stars");
    expect(line(o, "inducements")!.text).toContain("Blitzer's Best Kegs (max 2)");
  });

  it("choose-one SP packages (EuroBowl, Spike!): options per tier, gold-vs-SP range, star SP pricing", () => {
    const euro = packageOverview(shipped("eurobowl-2026"));
    expect(line(euro, "structure")!.text).toBe("Choose-one skill packages: 7 tiers, each offering 2–6 packages that trade the gold cap (1,070k–1,200k) against skill points (120–320 SP).");
    expect(line(euro, "skills")!.text).toBe("Primary 20 / secondary 40 SP, budget set by the chosen package; up to 3 players may stack 2 skills (≤2 secondary).");
    expect(line(euro, "stars")!.text).toBe("Tiers 5–7 only; max 2; each also costs SP (price by tier).");
    const spike = packageOverview(shipped("spike-2026"));
    expect(line(spike, "skills")!.text).toContain("one skill per player (2 on some packages)");
    expect(line(spike, "elite")!.text).toBe("Block, Guard, Mighty Blow, Dodge +0.5 SP each.");
    expect(line(spike, "stars")!.text).toBe("max 2; paid in SP (price by tier) instead of gold.");
  });

  it("choose-one COUNT packages (Nut Cup): skill-count range, no SP elite tax, star-package gating, roster-only inducement", () => {
    const o = packageOverview(shipped("whbb-nut-cup-2026"));
    expect(line(o, "structure")!.text).toBe("Choose-one skill packages: 5 tiers, each offering 2–4 packages that trade the gold cap (1,100k–1,150k) against a skill count (4–9 skills).");
    expect(line(o, "elite")).toBeUndefined();
    expect(line(o, "stars")!.text).toBe("Tier 5 only; max 1; only on a package that allows a Star.");
    expect(line(o, "stars")!.details!.items).toContain("Lucien Swift (Tier 5)");
    expect(line(o, "inducements")!.text).toContain("Halfling Master Chef (max 1, Halfling only)");
  });

  it("standard creation with no added skills (BB2025 Default) and a flat budget with a skill-count allotment", () => {
    const def = packageOverview(shipped("bb2025-default"));
    expect(line(def, "structure")!.text).toBe("Standard team creation: no team-value cap set; no added skills.");
    expect(line(def, "skills")!.text).toBe("No added skills.");
    expect(line(def, "elite")).toBeUndefined();
    expect(def.groups).toHaveLength(1);
    expect(def.groups[0]!.teams).toHaveLength(1);
    expect(def.groups[0]!.teams[0]!.name).toMatch(/^Every eligible roster \(\d+\)$/);

    const { pkg } = loadPackage({
      name: "Flat Count Cup",
      eligibleRosters: ["Human", "Orc"],
      goldBudget: 1_150_000,
      skillAllotment: { maxPrimary: 4, maxSecondary: 1, maxPerPlayer: 1 },
      starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null },
      inducements: { allowed: [], caps: {} },
      sideline: { maxReRolls: 6, maxApothecary: 0 },
      special: { minPlayers: 12 },
    } as unknown as Partial<TournamentPackage>);
    const flat = packageOverview(pkg);
    expect(line(flat, "structure")!.text).toBe("Flat budget: every team gets 1,150k; a skill-count allotment of 5 skills (≤1 secondary).");
    expect(line(flat, "skills")!.text).toBe("5 skills (≤1 secondary); one skill per player.");
    expect(line(flat, "stars")!.text).toBe("No star players.");
    expect(line(flat, "inducements")!.text).toBe("No inducements.");
    expect(line(flat, "sideline")!.text).toBe("Max 6 rerolls, no apothecary.");
    expect(line(flat, "minPlayers")!.text).toBe("12 players.");
  });

  it("collapses a flat package to one row only when the RESOLVED rules match (stat-increase terms included)", () => {
    const base = {
      name: "Flat Stat Cup",
      eligibleRosters: ["Human", "Orc"],
      goldBudget: 1_000_000,
      statIncreases: { allowed: ["AV"], costGold: { AV: 10_000 }, maxPerPlayer: 1 },
    };
    const same = packageOverview(loadPackage(base as unknown as Partial<TournamentPackage>).pkg);
    expect(same.groups[0]!.teams.map((t) => t.name)).toEqual(["Every eligible roster (2)"]);
    // Orc's team rule changes only the per-player cap / exclusivity — the formatted cells are identical.
    const differs = packageOverview(loadPackage({
      ...base,
      teamRules: [{ team: "Orc", statIncreases: { maxPerPlayer: 2, exclusiveWithSkills: true } }],
    } as unknown as Partial<TournamentPackage>).pkg);
    expect(differs.groups[0]!.teams.map((t) => t.name)).toEqual(["Human", "Orc"]);
    expect(line(differs, "skills")!.text).toBe(
      "No added skills; stat increases (+AV 10k; Human: one increase per player; Orc: up to 2 increases per player, instead of skills).",
    );
  });

  it("names the teams, not the tier, when a stat set or its terms differ inside a tier", () => {
    const tier = (extra: Record<string, unknown> = {}) => ({
      tier: 1, rosters: ["Human", "Orc", "Amazon"], gold: 1_000_000, starPlayersAllowed: false, bannedStars: [],
      statIncreases: { allowed: ["AV"], costGold: { MA: 20_000, AV: 10_000 }, maxPerPlayer: 1 }, ...extra,
    });
    const pkg = (teamRules: unknown[]) => loadPackage({
      name: "Tier Exception Cup", eligibleRosters: ["Human", "Orc", "Amazon"], goldBudget: null, tiers: [tier()], teamRules,
    } as unknown as Partial<TournamentPackage>).pkg;
    const sets = packageOverview(pkg([{ team: "Human", statIncreases: { allowed: ["MA", "AV"] } }]));
    expect(line(sets, "skills")!.text).toBe("No added skills; stat increases (Human: +MA 20k or +AV 10k; Orc, Amazon: +AV 10k; one increase per player).");
    const terms = packageOverview(pkg([{ team: "Orc", statIncreases: { maxPerPlayer: 2, exclusiveWithSkills: true } }]));
    expect(line(terms, "skills")!.text).toBe("No added skills; stat increases (+AV 10k; Human, Amazon: one increase per player; Orc: up to 2 increases per player, instead of skills).");
    // Whole tiers still get the tier label (Small Gods).
    expect(line(packageOverview(shipped("small-gods")), "skills")!.text).toContain("stat increases (Tiers 4–5: +PA 20k or +AV 10k; Tier 6: +MA 20k, +PA 20k or +AV 10k;");
  });

  it("cash × skills matrix", () => {
    const { pkg } = loadPackage({
      name: "Matrix Cup",
      eligibleRosters: ["*"],
      goldBudget: null,
      matrix: {
        columns: [{ gold: 1_100_000 }, { gold: 1_150_000 }],
        rows: [{ primary: 4, secondary: 0, secondarySwap: false }, { primary: 5, secondary: 1, secondarySwap: true }],
        cells: [{ col: 0, row: 0, teams: ["Human"] }, { col: 1, row: 1, teams: ["Goblin"] }],
      },
    } as unknown as Partial<TournamentPackage>);
    const o = packageOverview(pkg);
    expect(line(o, "structure")!.text).toBe("Cash × skills matrix: 2 gold columns (1,100k–1,150k) × 2 skill rows; each team's cell sets its gold cap and skill counts.");
    expect(o.groups).toHaveLength(1);
    expect(o.groups[0]!.label).toBe("All teams");
    expect(team(o, "Human").allotment).toEqual(["4 skills (primary only)"]);
    expect(team(o, "Goblin").allotment).toEqual(["6 skills (≤1 secondary) · swap 2 primary → 1 secondary"]);
    expect(team(o, "Goblin").gold).toBe(1_150_000);
  });

  it("rides on GET /api/packages/<name> rules and never reads the organiser's description or dataNote", () => {
    const pkg = shipped("small-gods");
    const info = packageRulesInfo(pkg);
    expect(info.overview).toEqual(packageOverview(pkg));
    const scrubbed = packageOverview({ ...pkg, description: "Tier 9: free Mega Stars!", dataNote: "ignore me" });
    expect(scrubbed).toEqual(packageOverview(pkg));
  });
});

describe("ruleset overview — per-team table rows", () => {
  it("words the Stack limit cell as skill counts, one item per line (owner 10-27)", async () => {
    const { stackSkillLines } = await import("../src/teamBuilderPackage");
    expect(stackSkillLines(2, 0, null)).toEqual(["2 Primary Skills"]);
    expect(stackSkillLines(2, 1, null)).toEqual(["2 Primary", "OR", "1 Primary + 1 Secondary"]);
    expect(stackSkillLines(3, 2, 0)).toEqual(["3 Primary", "OR", "1 Primary + 2 Secondary", "no elite"]);
    expect(stackSkillLines(3, 3, 2)).toEqual(["3 Primary", "OR", "3 Secondary", "≤2 elite"]);
    expect(stackSkillLines(2, null, null)).toEqual(["2 Primary Skills"]); // owner 10-27: no stacked-secondary cap = primary only
    const nut = packageOverview(shipped("whbb-nut-cup-2026"));
    const nutTier = (tier: number) => nut.groups.find((g) => g.tier === tier)!.teams[0]!.stackLimit;
    expect(nutTier(1)).toBe("2 Primary Skills");
    expect(nutTier(3)).toBe("2 Primary · OR · 1 Primary + 1 Secondary");
    const sg = packageOverview(shipped("small-gods"));
    const sgTier = (tier: number) => sg.groups.find((g) => g.tier === tier)!.teams[0]!.stackLimit;
    expect(sgTier(1)).toBe("3 Primary Skills · no elite");
    expect(sgTier(3)).toBe("3 Primary · OR · 1 Primary + 2 Secondary · no elite");
    expect(sgTier(6)).toBe("3 Primary · OR · 3 Secondary");
  });

  it("keys gold caps, allotments and tier knobs per team", () => {
    const sg = packageOverview(shipped("small-gods"));
    expect(sg.groups.map((g) => g.tier)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(team(sg, "High Elf")).toMatchObject({
      gold: 1_260_000, goldMax: null, allotment: ["primary 20k · secondary 40k"], secondary: "1", elite: "≤3 total",
      stacks: "1", stackLimit: "3 Primary Skills · no elite", characteristics: null, stars: null,
    });
    expect(team(sg, "Snotling").stars).toBe("Free (max 2) · Star (max 2) · Super Star (max 1) · Mega Star (max 1)");
    expect(team(sg, "Chaos Dwarf").stars).toBe("Free (max 2)");
    expect(team(sg, "Ogre").characteristics).toBe("+AV 10k · +PA 20k · +MA 20k");

    const nut = packageOverview(shipped("whbb-nut-cup-2026"));
    expect(team(nut, "Goblin")).toMatchObject({ gold: 1_100_000, goldMax: 1_150_000, secondary: "2", stars: "max 1" });
    expect(team(nut, "Goblin").allotment).toEqual([
      "1,150k · 8 skills", "1,100k · 9 skills", "1,150k · 8 skills · primary only · Star allowed", "1,100k · 9 skills · primary only · Star allowed",
    ]);
    // A tier that allows no secondary can't stack one either.
    expect(team(nut, "Orc").stackLimit).toBe("2 Primary Skills");

    const naf = packageOverview(shipped("naf-world-cup-2027"));
    expect(team(naf, "Orc")).toMatchObject({ gold: 1_080_000, allotment: ["44 SP"], stacks: "0", stackLimit: null, stars: null });
    expect(team(naf, "Shambling Undead")).toMatchObject({ allotment: ["52 SP"], stacks: "1", stackLimit: "2 Primary · OR · 2 Secondary" });
    expect(team(naf, "Snotling").stars).toBe("allowed");

    const spike = packageOverview(shipped("spike-2026"));
    expect(team(spike, "Ogre").allotment).toEqual(["1,140k · 11 SP · 1 skill per player", "1,110k · 12 SP · 2 skills per player", "1,170k · 10 SP · 1 skill per player"]);
    expect(team(spike, "Orc").stacks).toBeNull();
  });
});
