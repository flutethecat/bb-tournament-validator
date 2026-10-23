import { describe, expect, it } from "vitest";
import {
  composeTeam,
  MAX_STAT_STEPS,
  statIncreasesOf,
  findRoster,
  findStar,
  loadPackage,
  resolveTeamConfig,
  validate,
  type TeamPick,
  type TournamentPackage,
  type ValidationResult,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import smallGodsJson from "../../../tournament-packages/small-gods.json";
import { builderRaceRules, builderTierRows, packageResponseInfo } from "../src/teamBuilderPackage";
import { teamBuilderTierCatalog } from "../src/teamBuilderTiers";
import { teamBuilderWireError } from "../src/teamBuilderWire";

const { pkg, problems } = loadPackage(smallGodsJson as unknown as Partial<TournamentPackage>);

/** A fork roster XML synthesised from the dataset (positionId = index) plus roster-intrinsic stars. */
function forkXml(race: string, stars: string[] = []): string {
  const r = findRoster(bb2025, race)!;
  const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList></skillList></position>`,
  );
  const starXml = stars.map(
    (name, i) =>
      `<position id="s${i + 1}"><quantity>1</quantity><name>${name}</name><type>Star</type><gender>male</gender>` +
      `<cost>${findStar(bb2025, name)!.cost ?? 0}</cost><movement>5</movement><strength>3</strength><agility>3</agility>` +
      `<passing>4</passing><armour>9</armour><skillList><skill>Loner</skill></skillList></position>`,
  );
  return (
    `<roster id="${race.toLowerCase().replace(/\W+/g, "")}.bb2025"><name>${r.name}</name><reRollCost>${r.reRollCost}</reRollCost>` +
    `<maxReRolls>8</maxReRolls><apothecary>${r.apothecaryAllowed}</apothecary>${positions.join("")}${starXml.join("")}</roster>`
  );
}

const posId = (race: string, name: string) => String(findRoster(bb2025, race)!.positions.findIndex((p) => p.name === name) + 1);

interface Line {
  name: string;
  count?: number;
  skills?: string[];
  stats?: TeamPick["chosenStatIncreases"];
}

function build(
  race: string,
  lines: Line[],
  opts: { stars?: string[]; reRolls?: number; apothecary?: boolean; inducements?: Array<{ key: string; count: number }>; specialRule?: string } = {},
) {
  const stars = opts.stars ?? [];
  const picks: TeamPick[] = lines.map((l) => ({
    positionId: posId(race, l.name),
    count: l.count ?? 1,
    ...(l.skills ? { chosenSkills: l.skills } : {}),
    ...(l.stats ? { chosenStatIncreases: l.stats } : {}),
  }));
  stars.forEach((_, i) => picks.push({ positionId: `s${i + 1}`, count: 1 }));
  const composed = composeTeam(
    {
      forkRosterXml: forkXml(race, stars),
      coach: "Coach",
      teamName: "Small Gods Test",
      picks,
      reRolls: opts.reRolls ?? 0,
      apothecary: opts.apothecary ?? false,
      rosteredInducements: opts.inducements,
      ...(opts.specialRule ? { specialRule: opts.specialRule } : {}),
    },
    bb2025,
    42,
  );
  return { composed, result: validate(composed.roster, pkg, bb2025) };
}

const ruleErrors = (r: ValidationResult, id: string) => r.errors.filter((e) => e.ruleId === id);

/** The owner-verified Dwarf T5 sheet (cap 1455k): 12 players, no stacked players. */
const dwarfLines: Line[] = [
  { name: "Dwarf Blitzer", skills: ["Guard"] },
  { name: "Dwarf Blitzer", skills: ["Mighty Blow"] },
  { name: "Troll Slayer", skills: ["Guard"] },
  { name: "Dwarf Blocker Lineman", skills: ["Dirty Player"] },
  { name: "Dwarf Runner", skills: ["Block"] },
  { name: "Dwarf Blocker Lineman", count: 2, skills: ["Guard"] },
  { name: "Dwarf Blocker Lineman", count: 5 },
];
const dwarfOpts = {
  reRolls: 2,
  apothecary: true,
  inducements: [
    { key: "bribes", count: 1 },
    { key: "team_mascot", count: 1 },
  ],
};

describe("Small Gods package", () => {
  it("loads cleanly and puts every published roster in the right tier at its own gold cap", () => {
    expect(problems).toEqual([]);
    const expected: Record<string, [number, number]> = {
      Orc: [1, 1225], "Old World Alliance": [1, 1225], "Underworld Denizens": [1, 1225], "High Elf": [1, 1260], Amazon: [1, 1265],
      "Dark Elf": [2, 1275], "Wood Elf": [2, 1285], Skaven: [2, 1290], Human: [2, 1305],
      "Shambling Undead": [3, 1320], Lizardmen: [3, 1340], Nurgle: [3, 1340], "Necromantic Horror": [3, 1350], Norse: [3, 1350], Slann: [3, 1360], Vampire: [3, 1365],
      "Imperial Nobility": [4, 1380], "Tomb Kings": [4, 1380], "Chaos Chosen": [4, 1395], "Elven Union": [4, 1395], "Chaos Dwarf": [4, 1410], Snotling: [4, 1435],
      Bretonnian: [5, 1440], Khorne: [5, 1450], Dwarf: [5, 1455], "Black Orc": [5, 1460], "Chaos Renegade": [5, 1470], Gnome: [5, 1470],
      Goblin: [6, 1480], Halfling: [6, 1480], "Night Goblin": [6, 1480], Ogre: [6, 1500],
    };
    const assigned = pkg.tiers!.flatMap((t) => t.rosters);
    expect(new Set(assigned)).toEqual(new Set(Object.keys(expected)));
    expect(assigned).toHaveLength(32);
    for (const [race, [tier, gold]] of Object.entries(expected)) {
      const cfg = resolveTeamConfig(pkg, race);
      expect({ race, tier: cfg.tierNumber, gold: cfg.gold }).toEqual({ race, tier, gold: gold * 1000 });
    }
    // Every dataset race is covered; Night Goblin is the only PDF race the dataset lacks.
    const datasetNames = new Set(bb2025.teams.map((t) => t.name));
    expect(assigned.filter((n) => !datasetNames.has(n))).toEqual(["Night Goblin"]);
    expect(bb2025.teams.every((t) => assigned.includes(t.name))).toBe(true);
  });

  it("maps every pack star to a canonical dataset name (Josef Bugman is the one gap)", () => {
    const names = new Set(bb2025.stars.map((s) => s.name));
    const all = pkg.starPacks!.flatMap((p) => p.stars);
    expect(all.filter((n) => !names.has(n))).toEqual(["Josef Bugman"]);
    expect(new Set(all).size).toBe(all.length);
    expect(pkg.starPacks!.map((p) => [p.id, p.fee, p.feeMode, p.max, p.stars.length])).toEqual([
      ["free", 0, "each", 2, 5],
      ["star", 20000, "once", 2, 21],
      ["super", 40000, "each", 1, 27],
      ["mega", 80000, "each", 1, 13],
    ]);
  });

  it("accepts the owner's Dwarf worked example at 1420k with the exact cost buckets", () => {
    const { composed, result } = build("Dwarf", dwarfLines, dwarfOpts);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(composed.roster.summary).toMatchObject({ playersCost: 935000, sidelineCost: 170000, inducementCost: 75000 });
    expect(result.recomputedSummary).toMatchObject({
      staffCost: 935000 + 170000, // players + sideline (validator bucket)
      skillsCost: 240000,
      inducementsCost: 75000,
      primarySkillCount: 5,
      secondarySkillCount: 2,
      statIncreasesCost: 0,
      starFeesCost: 0,
      goldUsed: 1420000,
      playerCount: 12,
    });
  });

  it("rejects the same sheet once added-skill gold pushes it over the cap", () => {
    const { result } = build("Dwarf", [...dwarfLines.slice(0, 6), { name: "Dwarf Blocker Lineman", count: 5, skills: ["Tackle"] }], dwarfOpts);
    // +5 primary Tackle = +100k → 1520k > 1455k
    expect(ruleErrors(result, "gold-budget")[0]!.message).toBe("Team costs 1520k, over the 1455k budget (Tier 5).");
  });

  it("T1 caps elite skills at 3 team-wide", () => {
    const { result } = build("Orc", [{ name: "Orc Lineman", count: 4, skills: ["Block"] }, { name: "Orc Lineman", count: 7 }]);
    expect(ruleErrors(result, "elite-skills").map((e) => e.message)).toEqual([
      "Team took 4 elite skills; the limit is 3 (Tier 1).",
    ]);
  });

  it("T3 caps copies of any one elite skill at 4", () => {
    const { result } = build("Lizardmen", [{ name: "Saurus Blocker", count: 5, skills: ["Guard"] }, { name: "Skink Lineman", count: 6 }]);
    expect(ruleErrors(result, "elite-skills").map((e) => e.message)).toEqual([
      "5× Guard across the team; at most 4 of any one elite skill (Tier 3).",
    ]);
  });

  it("T1 stacked players take primary skills only", () => {
    const { result } = build("Amazon", [{ name: "Eagle Warrior", skills: ["Block", "Guard"] }, { name: "Eagle Warrior", count: 10 }]);
    expect(ruleErrors(result, "stacked-player")[0]!.message).toBe(
      "#1 Eagle Warrior is stacked with a secondary skill (Guard); stacked players may only take primary skills (Tier 1).",
    );
  });

  it("T1 allows one stacked player", () => {
    const { result } = build("Orc", [{ name: "Orc Lineman", count: 2, skills: ["Wrestle", "Tackle"] }, { name: "Orc Lineman", count: 9 }]);
    expect(ruleErrors(result, "skill-points")[0]!.message).toBe(
      "2 players have more than one added skill; skill stacking allows at most 1 (Tier 1).",
    );
  });

  it("T1-T4 stacked players may carry no elite skill at all (owner 10-22)", () => {
    const t3 = build("Lizardmen", [{ name: "Saurus Blocker", skills: ["Block", "Tackle"] }, { name: "Skink Lineman", count: 10 }]).result;
    expect(ruleErrors(t3, "stacked-player")[0]!.message).toMatch(/stacked with 1 elite skills?; at most 0/);
    // A single elite skill on an unstacked player stays legal.
    const single = build("Lizardmen", [{ name: "Saurus Blocker", skills: ["Block"] }, { name: "Skink Lineman", count: 10 }]).result;
    expect(ruleErrors(single, "stacked-player")).toEqual([]);
    // T5 still allows elite on a stacked player.
    const t5 = build("Dwarf", [{ name: "Dwarf Runner", skills: ["Block", "Tackle"] }, { name: "Dwarf Blocker Lineman", count: 10 }]).result;
    expect(ruleErrors(t5, "stacked-player")).toEqual([]);
  });

  it("a chosen league keeps Bribery and Corruption (Goblin on Badlands Brawl: 5 Bribes at 50k)", () => {
    const { composed, result } = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], {
      specialRule: "Badlands Brawl",
      inducements: [{ key: "bribes", count: 5 }],
    });
    expect(composed.roster.specialRules).toEqual(expect.arrayContaining(["Bribery and Corruption", "Badlands Brawl"]));
    expect(composed.roster.inducements[0]).toMatchObject({ id: "bribes", count: 5, cost: 50_000 });
    expect(ruleErrors(result, "inducements")).toEqual([]);
  });

  it("T5 stacked players carry at most 2 elite skills", () => {
    const { result } = build("Dwarf", [{ name: "Dwarf Runner", skills: ["Block", "Guard", "Dodge"] }, { name: "Dwarf Blocker Lineman", count: 10 }]);
    expect(ruleErrors(result, "stacked-player")[0]!.message).toMatch(/stacked with 3 elite skills; at most 2/);
  });

  it("stat increases: none in T2, never with a skill, and no +MA in T5", () => {
    const t2 = build("Human", [{ name: "Human Lineman", stats: ["AV"] }, { name: "Human Lineman", count: 10 }]).result;
    expect(ruleErrors(t2, "stat-increases")[0]!.message).toBe(
      "#1 Human Lineman has a characteristic increase (+AV); stat increases are not allowed (Tier 2).",
    );

    const withSkill = build("Dwarf", [{ name: "Dwarf Blocker Lineman", stats: ["AV"], skills: ["Guard"] }, { name: "Dwarf Blocker Lineman", count: 10 }]).result;
    expect(ruleErrors(withSkill, "stat-increases")[0]!.message).toMatch(/may not take skills \(Tier 5\)/);

    const ma = build("Dwarf", [{ name: "Dwarf Runner", stats: ["MA"] }, { name: "Dwarf Blocker Lineman", count: 10 }]).result;
    expect(ruleErrors(ma, "stat-increases")[0]!.message).toBe("#1 Dwarf Runner: +MA is not allowed (Tier 5) (allowed: +AV, +PA).");

    const two = build("Ogre", [{ name: "Ogre Blocker", stats: ["AV", "MA"] }]).result;
    expect(ruleErrors(two, "stat-increases").map((e) => e.message)).toEqual([
      "#1 Ogre Blocker has 2 characteristic increases (+MA, +AV); the limit is 1 per player (Tier 6).",
    ]);
  });

  it("a legal T5 +AV is applied to the player, written to the XML, and priced inside the cap", () => {
    const { composed, result } = build("Dwarf", [{ name: "Dwarf Blocker Lineman", stats: ["AV"] }, { name: "Dwarf Runner", stats: ["PA"] }, { name: "Dwarf Blocker Lineman", count: 9 }]);
    expect(ruleErrors(result, "stat-increases")).toEqual([]);
    expect(composed.roster.players[0]!.AV).toBe("11+");
    expect(composed.roster.players[1]!.PA).toBe("3+");
    expect(composed.xml).toContain("<positionId>1</positionId><armour>11</armour>");
    expect(composed.xml).toContain("<passing>3</passing>");
    expect(result.recomputedSummary.statIncreasesCost).toBe(30000); // AV 10k + PA 20k
    expect(result.recomputedSummary.goldUsed).toBe(70000 + 80000 + 9 * 70000 + 30000);
  });

  it("T2-T5 may only hire Free-pack stars", () => {
    const { result } = build("Human", [{ name: "Human Lineman", count: 11 }], { stars: ["Helmut Wulf"] });
    expect(ruleErrors(result, "star-packs")[0]!.message).toBe(
      "Helmut Wulf is in the Star pack, which is not open to this team (Tier 2) (open: Free).",
    );
    const free = build("Human", [{ name: "Human Lineman", count: 11 }], { stars: ["Akhorne the Squirrel"] }).result;
    expect(ruleErrors(free, "star-packs")).toEqual([]);
    expect(free.recomputedSummary.starFeesCost).toBe(0);
  });

  it("T1 hires no stars at all", () => {
    const { result } = build("Orc", [{ name: "Orc Lineman", count: 11 }], { stars: ["Akhorne the Squirrel"] });
    expect(ruleErrors(result, "star-players")[0]!.message).toMatch(/Star Players are not allowed \(Tier 1\)/);
  });

  it("Gnome (T5 exception) pays the Star-pack fee once for two Star-pack stars", () => {
    const { result } = build("Gnome", [{ name: "Gnome Lineman", count: 11 }], { stars: ["Puggy Baconbreath", "Rodney Roachbait"] });
    expect(ruleErrors(result, "star-packs")).toEqual([]);
    expect(ruleErrors(result, "star-players")).toEqual([]);
    expect(result.recomputedSummary.starFeesCost).toBe(20000);
    expect(result.recomputedSummary.goldUsed).toBe(11 * 40000 + 130000 + 70000 + 20000);
  });

  it("charges the Mega Star fee (+80k) and caps that pack at one", () => {
    const one = build("Gnome", [{ name: "Gnome Lineman", count: 11 }], { stars: ["Deeproot Strongbranch"] }).result;
    expect(one.recomputedSummary.starFeesCost).toBe(80000);
    expect(ruleErrors(one, "star-packs")).toEqual([]);
    const two = build("Gnome", [{ name: "Gnome Lineman", count: 11 }], { stars: ["Deeproot Strongbranch", "Cindy Piewhistle"] }).result;
    expect(ruleErrors(two, "star-packs")[0]!.message).toBe("2 picks from the Mega Star pack; the limit is 1.");
    expect(two.recomputedSummary.starFeesCost).toBe(160000);
  });

  it("a star pair is one pick; a third pick is rejected", () => {
    const pair = build("Snotling", [{ name: "Snotling Lineman", count: 11 }], { stars: ["Akhorne the Squirrel", "Grak", "Crumbleberry"] }).result;
    expect(ruleErrors(pair, "star-players")).toEqual([]);
    expect(ruleErrors(pair, "star-packs")).toEqual([]);
    expect(pair.recomputedSummary.starFeesCost).toBe(40000); // Super Star fee once for the pair

    const three = build("Snotling", [{ name: "Snotling Lineman", count: 11 }], {
      stars: ["Akhorne the Squirrel", "Grak", "Crumbleberry", "Morg 'n' Thorg"],
    }).result;
    expect(ruleErrors(three, "star-players")[0]!.message).toBe("3 Star Players; the limit is 2.");
  });

  it("echoes the per-race rules block for builder clients", () => {
    const selected = { name: pkg.name, description: pkg.description };
    const dwarf = packageResponseInfo({ pkg, selected }, "Dwarf")!;
    expect(dwarf.budget).toBe(1455000);
    expect(dwarf.rules).toEqual({
      tier: 5,
      maxSecondary: 8,
      eliteMaxTotal: null,
      eliteMaxSameSkill: 6,
      maxStackedPlayers: 4,
      stackedPlayer: { maxSkills: 3, maxSecondary: 2, maxElite: 2 },
      statIncreases: { allowed: ["AV", "PA"], costGold: { MA: 20000, PA: 20000, AV: 10000 } },
      starPacks: [{ id: "free", label: "Free", fee: 0, feeMode: "each", max: 2, stars: pkg.starPacks![0]!.stars }],
      maxStars: 2,
    });
    expect(builderRaceRules(pkg, "Orc")).toMatchObject({ tier: 1, eliteMaxTotal: 3, statIncreases: null, starPacks: [], maxStars: 0 });
    expect(builderRaceRules(pkg, "Snotling").starPacks.map((p) => p.id)).toEqual(["free", "star", "super", "mega"]);
    expect(builderRaceRules(pkg, "Ogre").statIncreases!.allowed).toEqual(["AV", "PA", "MA"]);
  });

  it("serves the PDF-style tier table rows and per-race rows", () => {
    const rows = builderTierRows(pkg);
    expect(rows.map((r) => [r.tier, r.secondaryText, r.eliteText, r.stacksText, r.stackTypeText, r.characteristicsText, r.starPacksText])).toEqual([
      [1, "1", "max 3 total", "1", "up to 3 skills, primary only, no elite", "none", "none"],
      [2, "2", "max 4 total", "1", "up to 3 skills, primary only, no elite", "none", "Free"],
      [3, "3", "max 4 of any one", "2", "up to 3 skills, max 2 secondary, no elite", "none", "Free"],
      [4, "4", "max 4 of any one", "3", "up to 3 skills, max 2 secondary, no elite", "+AV (10k) / +PA (20k)", "Free"],
      [5, "8", "max 6 of any one", "4", "up to 3 skills, max 2 secondary, max 2 elite", "+AV (10k) / +PA (20k)", "Free"],
      [6, "10", "unlimited", "6", "up to 3 skills", "+AV (10k) / +PA (20k) / +MA (20k)", "Free, Star, Super Star, Mega Star"],
    ]);
    expect(rows[0]!.rosters).toContainEqual({ name: "High Elf", gold: 1260000 });
    const races = teamBuilderTierCatalog(pkg, bb2025, true);
    expect(races.find((r) => r.name === "Gnome")).toMatchObject({ tier: 5, gold: 1470000, rules: { tier: 5 } });
    expect(races.find((r) => r.name === "Gnome")!.rules!.starPacks).toHaveLength(4);
    // Without a selected package the catalog keeps its original shape.
    expect(teamBuilderTierCatalog(pkg, bb2025).find((r) => r.name === "Gnome")).toEqual({ name: "Gnome", tier: 5, source: "package" });
  });

  it("validates chosenStatIncreases on the wire", () => {
    expect(teamBuilderWireError({ picks: [{ positionId: "1", count: 1, chosenStatIncreases: ["AV"] }] })).toBeNull();
    expect(teamBuilderWireError({ picks: [{ positionId: "1", count: 1, chosenStatIncreases: "AV" }] })).toBe(
      "chosenStatIncreases must be an array when supplied.",
    );
    expect(teamBuilderWireError({ picks: [{ positionId: "1", count: 1, chosenStatIncreases: ["WS"] }] })).toBe(
      "each chosenStatIncreases entry must be one of MA, ST, AG, PA, AV.",
    );
  });
});

describe("stat-increase hardening (review 10-22)", () => {
  it("rejects non-finite / out-of-range chosenStats and repeated increases on the wire", () => {
    const pick = (extra: Record<string, unknown>) => ({ picks: [{ positionId: "1", count: 1, ...extra }] });
    expect(teamBuilderWireError(pick({ chosenStats: { MA: Number.POSITIVE_INFINITY } }))).toBe("chosenStats.MA must be an integer between 0 and 20.");
    expect(teamBuilderWireError(JSON.parse('{"picks":[{"positionId":"1","count":1,"chosenStats":{"MA":1e309}}]}'))).toMatch(/between 0 and 20/);
    expect(teamBuilderWireError(pick({ chosenStats: { MA: 1.5 } }))).toMatch(/between 0 and 20/);
    expect(teamBuilderWireError(pick({ chosenStats: { XX: 3 } }))).toBe("chosenStats keys must be MA, ST, AG, PA or AV.");
    expect(teamBuilderWireError(pick({ chosenStats: { MA: 7 } }))).toBeNull();
    // Repeats are a per-package question (maxPerPlayer) for the validator; the wire only bounds the list.
    expect(teamBuilderWireError(pick({ chosenStatIncreases: ["MA", "MA"] }))).toBeNull();
    expect(teamBuilderWireError(pick({ chosenStatIncreases: ["MA", "MA", "MA", "MA", "MA", "MA"] }))).toBe("chosenStatIncreases may list at most 5 entries.");
  });

  it("bounds the stat-diff loop even for an Infinity characteristic", () => {
    const dsPos = findRoster(bb2025, "Dwarf")!.positions[0]!;
    const player = { number: 1, positionName: dsPos.name, MA: Number.POSITIVE_INFINITY, ST: dsPos.ST, AG: dsPos.AG, PA: dsPos.PA, AV: dsPos.AV, skills: [], keywords: [], cost: dsPos.cost };
    expect(statIncreasesOf(player, dsPos)).toHaveLength(MAX_STAT_STEPS);
  });

  it("fails closed: a package without the statIncreases knob rejects any increase", () => {
    const { pkg: legacy } = loadPackage({ name: "Legacy Cup", eligibleRosters: ["*"] });
    const composed = composeTeam(
      { forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks: [{ positionId: "1", count: 11, chosenStatIncreases: ["ST"] }], reRolls: 0, apothecary: false },
      bb2025,
      42,
    );
    const result = validate(composed.roster, legacy, bb2025);
    expect(result.valid).toBe(false);
    expect(ruleErrors(result, "stat-increases")[0]!.message).toBe(
      "#1 Dwarf Blocker Lineman has a characteristic increase (+ST); stat increases are not allowed in this package.",
    );
    // The composer refuses increases on a Star pick outright.
    expect(() =>
      composeTeam(
        { forkRosterXml: forkXml("Dwarf", ["Grombrindal"]), coach: "C", teamName: "T", picks: [{ positionId: "s1", count: 1, chosenStatIncreases: ["AV"] }], reRolls: 0, apothecary: false },
        bb2025,
      ),
    ).toThrow(/cannot take characteristic increases/);
  });
});

describe("package knob load checks + legacy summary shape (review 10-22)", () => {
  it("reports bad knob values and never lets a negative cost or fee lower a team's price", () => {
    const { pkg: bad, problems: p } = loadPackage({
      name: "Bad Knobs",
      eligibleRosters: ["*"],
      statIncreases: { allowed: ["AV"], costGold: { AV: -50000, PA: Number.NaN }, maxPerPlayer: 1.5 },
      starPacks: [{ id: "x", fee: -20000, max: -1, feeMode: "both" as never, stars: ["Grombrindal"] }],
      skillAllotment: { skillPointBudget: 0, eliteMaxTotal: 2.5, stackedPlayer: { maxSecondary: -1 } },
      tiers: [{ tier: 1, rosters: ["Dwarf"], gold: null, rosterGold: { Dwarf: -1 }, starPlayersAllowed: true, bannedStars: [] }],
    } as never);
    expect(p).toEqual([
      "skillAllotment.eliteMaxTotal must be a non-negative integer or null.",
      "skillAllotment.stackedPlayer.maxSecondary must be a non-negative integer or null.",
      "package.statIncreases.costGold.AV must be a non-negative number (ignored).",
      "package.statIncreases.costGold.PA must be a non-negative number (ignored).",
      "package.statIncreases.maxPerPlayer must be a non-negative integer or null.",
      "tiers[1].rosterGold.Dwarf must be a non-negative number.",
      "starPacks[x].max must be a non-negative integer or null.",
      'starPacks[x].feeMode must be "once" or "each".',
      "starPacks[x].fee must be a non-negative number (treated as 0).",
    ]);
    expect(bad.statIncreases!.costGold).toEqual({});
    expect(bad.starPacks![0]!.fee).toBe(0);
    expect(problems).toEqual([]); // Small Gods itself is clean
  });

  it("keeps the legacy recomputedSummary shape when the new knobs are unused", () => {
    const { pkg: legacy } = loadPackage({ name: "Legacy Cup", eligibleRosters: ["*"] });
    const composed = composeTeam(
      { forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks: [{ positionId: "1", count: 11 }], reRolls: 0, apothecary: false },
      bb2025,
      42,
    );
    const summary = validate(composed.roster, legacy, bb2025).recomputedSummary;
    expect("statIncreasesCost" in summary).toBe(false);
    expect("starFeesCost" in summary).toBe(false);
    const sg = validate(composed.roster, pkg, bb2025).recomputedSummary;
    expect(sg).toMatchObject({ statIncreasesCost: 0, starFeesCost: 0 });
  });
});

describe("stat-increase overflow is an error, not a clamp (re-review 10-22)", () => {
  it("rejects a characteristic far above its position even when maxPerPlayer would allow it", () => {
    const { pkg: lax } = loadPackage({
      name: "Lax Cup",
      eligibleRosters: ["*"],
      statIncreases: { allowed: ["MA"], costGold: { MA: 20000 }, maxPerPlayer: 10 },
    });
    const composed = composeTeam(
      { forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks: [{ positionId: "1", count: 11 }], reRolls: 0, apothecary: false },
      bb2025,
      42,
    );
    composed.roster.players[0] = { ...composed.roster.players[0]!, MA: 100 };
    const result = validate(composed.roster, lax, bb2025);
    expect(result.valid).toBe(false);
    expect(ruleErrors(result, "stat-increases")[0]!.message).toBe(
      "#1 Dwarf Blocker Lineman: MA is more than 10 steps above the position — over the characteristic limit.",
    );
    // A double +MA within maxPerPlayer 2 stays legal (repeats are allowed when the package allows them).
    const { pkg: two } = loadPackage({ name: "Two Cup", eligibleRosters: ["*"], statIncreases: { allowed: ["MA"], maxPerPlayer: 2 } });
    const ok = composeTeam(
      { forkRosterXml: forkXml("Dwarf"), coach: "C", teamName: "T", picks: [{ positionId: "1", count: 11, chosenStatIncreases: ["MA", "MA"] }], reRolls: 0, apothecary: false },
      bb2025,
      42,
    );
    expect(ruleErrors(validate(ok.roster, two, bb2025), "stat-increases")).toEqual([]);
  });
});
