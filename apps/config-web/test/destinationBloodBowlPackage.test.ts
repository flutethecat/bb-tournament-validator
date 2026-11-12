import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  composeTeam,
  findRoster,
  findStar,
  decodeEntities,
  loadPackage,
  renderPackageHtml,
  resolveTeamConfig,
  validate,
  type TeamPick,
  type TournamentPackage,
  type ValidationResult,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import dbbJson from "../../../tournament-packages/destination-blood-bowl.json";
import { renderRulesPage } from "../../../packages/bb-validator/src/render/rulesPage";
import { builderRaceRules, packageRaceRules, packageRulesInfo } from "../src/teamBuilderPackage";
import { teamBuilderInducementCatalog } from "../src/teamBuilderInducements";

const { pkg, problems } = loadPackage(dbbJson as unknown as Partial<TournamentPackage>);

// Minimal draft-07 subset checker (type / required / properties / additionalProperties / items / $ref / enum / minimum).
type Schema = Record<string, any>;
const schema: Schema = JSON.parse(readFileSync(new URL("../../../schemas/tournament-package.schema.json", import.meta.url), "utf8"));
const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;
function check(node: Schema, value: unknown, path: string, out: string[]): void {
  if (node.$ref) node = (node.$ref as string).replace(/^#\//, "").split("/").reduce((n: Schema, k) => n[k], schema);
  if (node.type) {
    const types: string[] = Array.isArray(node.type) ? node.type : [node.type];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      out.push(`${path}: ${t} is not ${types.join("|")}`);
      return;
    }
  }
  if (node.enum && !node.enum.includes(value)) out.push(`${path}: ${String(value)} not in enum`);
  if (typeof value === "number" && node.minimum != null && value < node.minimum) out.push(`${path}: below minimum`);
  if (Array.isArray(value) && node.items) value.forEach((v, i) => check(node.items, v, `${path}[${i}]`, out));
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const r of node.required ?? []) if (!(r in obj)) out.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(obj)) {
      if (node.properties?.[k]) check(node.properties[k], v, `${path}.${k}`, out);
      else if (node.additionalProperties === false) out.push(`${path}: unknown property ${k}`);
      else if (node.additionalProperties && typeof node.additionalProperties === "object") check(node.additionalProperties, v, `${path}.${k}`, out);
    }
  }
}

/** A fork roster XML synthesised from the dataset (positionId = index) plus stars. */
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
      `<passing>4</passing><armour>9</armour><skillList>${(findStar(bb2025, name)!.skills ?? ["Loner"])
        .map((s) => `<skill>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</skill>`)
        .join("")}</skillList></position>`,
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
}
function build(
  race: string,
  lines: Line[],
  opts: { stars?: string[]; reRolls?: number; apothecary?: boolean; inducements?: Array<{ key: string; count: number }> } = {},
) {
  const stars = opts.stars ?? [];
  const picks: TeamPick[] = lines.map((l) => ({
    positionId: posId(race, l.name),
    count: l.count ?? 1,
    ...(l.skills ? { chosenSkills: l.skills } : {}),
  }));
  stars.forEach((_, i) => picks.push({ positionId: `s${i + 1}`, count: 1 }));
  const composed = composeTeam(
    {
      forkRosterXml: forkXml(race, stars),
      coach: "Coach",
      teamName: "Destination Test",
      picks,
      reRolls: opts.reRolls ?? 0,
      apothecary: opts.apothecary ?? false,
      rosteredInducements: opts.inducements,
    },
    bb2025,
    42,
  );
  return { composed, result: validate(composed.roster, pkg, bb2025) };
}
const ruleErrors = (r: ValidationResult, id: string) => r.errors.filter((e) => e.ruleId === id);

const goblins = (skilled: Line[], plain: number): Line[] => [...skilled, { name: "Goblin Lineman", count: plain }];
const dwarfs = (skilled: Line[], plain: number): Line[] => [...skilled, { name: "Dwarf Blocker Lineman", count: plain }];
const humans = (skilled: Line[], plain: number): Line[] => [...skilled, { name: "Human Lineman", count: plain }];

describe("Destination Blood Bowl package (Charleston 2027 rules pack, read 2026-11-12)", () => {
  it("matches the schema and loads without problems", () => {
    const out: string[] = [];
    check(schema, dbbJson, "$", out);
    expect(out).toEqual([]);
    expect(problems).toEqual([]);
    expect(pkg.name).toBe("Destination Blood Bowl");
  });

  it("puts all 31 rosters in the pack's tiers with their Skill Points, stacks and star access", () => {
    const expected: Record<number, { rosters: string[]; sp: number; stacks: number; stars: number }> = {
      1: { rosters: ["Amazon", "Dark Elf", "High Elf", "Human", "Old World Alliance", "Skaven", "Underworld Denizens", "Wood Elf"], sp: 5, stacks: 0, stars: 0 },
      2: { rosters: ["Elven Union", "Lizardmen", "Necromantic Horror", "Nurgle", "Orc", "Shambling Undead", "Vampire"], sp: 6, stacks: 0, stars: 0 },
      3: { rosters: ["Bretonnian", "Chaos Chosen", "Chaos Dwarf", "Imperial Nobility", "Khorne", "Norse", "Slann", "Tomb Kings"], sp: 7, stacks: 1, stars: 1 },
      4: { rosters: ["Black Orc", "Chaos Renegade", "Dwarf", "Snotling"], sp: 8, stacks: 2, stars: 1 },
      5: { rosters: ["Gnome", "Goblin", "Halfling", "Ogre"], sp: 9, stacks: 2, stars: 2 },
    };
    const datasetNames = new Set(bb2025.teams.map((t) => t.name));
    let n = 0;
    for (const [tier, row] of Object.entries(expected))
      for (const race of row.rosters) {
        n++;
        expect(datasetNames.has(race)).toBe(true);
        const cfg = resolveTeamConfig(pkg, race);
        expect(cfg.tierNumber).toBe(Number(tier));
        expect(cfg.gold).toBe(1_200_000);
        expect(cfg.maxStackedPlayers).toBe(row.stacks);
        expect(cfg.starPlayersAllowed).toBe(row.stars > 0);
        expect(cfg.skillPackages).toEqual([
          { label: `${row.sp} Skill Points`, gold: 1_200_000, skillPointBudget: row.sp, maxPerPlayer: row.stacks ? 2 : 1, starPlayersAllowed: row.stars > 0, maxStars: row.stars },
        ]);
        expect(cfg.stackedPlayer).toMatchObject({ maxSkills: 2, maxSecondary: 0 });
      }
    expect(n).toBe(31);
    expect(datasetNames.size).toBe(31);
    expect(resolveTeamConfig(pkg, "Chaos Dwarf").starPacksAllowed).toEqual(["star"]);
    expect(resolveTeamConfig(pkg, "Dwarf").starPacksAllowed).toEqual(["star"]);
    expect(resolveTeamConfig(pkg, "Goblin").starPacksAllowed).toEqual(["star", "mega"]);
  });

  it("every dataset star is priced and packed: 2 SP, Mega-Stars 4 SP in Tier 5 only, a pair pays once", () => {
    const table = pkg.starPlayers.spCostByTier!;
    const megas = ["Deeproot Strongbranch", "Grak", "Crumbleberry", "Griff Oberwald", "Hakflem Skuttlespike", "H'Thark the Unstoppable", "Morg 'n' Thorg", "Ripper Bolgrot", "Skitter Stab-Stab", "Skrorg Snowpelt"];
    expect(pkg.starPacks!.find((p) => p.id === "mega")).toMatchObject({ max: 1, fee: 0, stars: megas });
    const regular = pkg.starPacks!.find((p) => p.id === "star")!;
    expect(regular.max).toBeNull();
    for (const star of bb2025.stars) {
      const mega = megas.includes(star.name);
      expect(regular.stars.includes(star.name)).toBe(!mega);
      const secondHalf = Boolean(star.pairedWith) && !star.pairPrimary;
      expect(table[star.name]).toEqual(mega ? [null, null, null, null, secondHalf ? 0 : 4] : [null, null, ...Array(3).fill(secondHalf ? 0 : 2)]);
    }
    expect(Object.keys(table)).toHaveLength(bb2025.stars.length);
    expect(table["Grak"]![4]! + table["Crumbleberry"]![4]!).toBe(4);
    expect(table["Dribl"]![2]! + table["Drull"]![2]!).toBe(2);
  });

  it("Tier 1 Human: 5 primaries fit; a secondary costs 2; no stacking", () => {
    const ok = build("Human", humans([{ name: "Human Lineman", count: 5, skills: ["Wrestle"] }], 6), { reRolls: 3 }).result;
    expect(ok.errors).toEqual([]);
    expect(ok.recomputedSummary).toMatchObject({ skillPointsUsed: 5, skillPointBudget: 5 });
    const sec = build("Human", humans([{ name: "Human Lineman", count: 4, skills: ["Wrestle"] }, { name: "Human Lineman", skills: ["Dodge"] }], 6)).result;
    expect(sec.recomputedSummary.skillPointsUsed).toBe(6);
    expect(ruleErrors(sec, "skill-packages")).toHaveLength(1);
    const stack = build("Human", humans([{ name: "Human Lineman", skills: ["Wrestle", "Tackle"] }], 10)).result;
    expect(stack.recomputedSummary.skillPointsUsed).toBe(3);
    expect(stack.errors.map((e) => e.ruleId)).toEqual(expect.arrayContaining(["skill-points", "skill-packages"]));
  });

  it("Tier 4 Dwarf: a two-primary stack costs 3 SP; 2 stacks + 2 singles = 8 fits, a ninth point or a third stack does not", () => {
    const stack = { name: "Dwarf Blocker Lineman", skills: ["Fend", "Pro"] };
    const single = { name: "Dwarf Blocker Lineman", skills: ["Fend"] };
    const ok = build("Dwarf", dwarfs([stack, stack, single, single], 7), { reRolls: 3 }).result;
    expect(ok.errors).toEqual([]);
    expect(ok.recomputedSummary.skillPointsUsed).toBe(8);
    const nine = build("Dwarf", dwarfs([stack, stack, single, single, single], 6)).result;
    expect(nine.recomputedSummary.skillPointsUsed).toBe(9);
    expect(ruleErrors(nine, "skill-packages")).toHaveLength(1);
    const three = build("Dwarf", dwarfs([stack, stack, stack], 8)).result;
    expect(ruleErrors(three, "skill-points").map((e) => e.message).join(" ")).toMatch(/3 players have more than one added skill; skill stacking allows at most 2 \(Tier 4\)/);
  });

  it("a stacked player may not mix a primary with a secondary, or carry two secondaries", () => {
    const mixed = build("Dwarf", dwarfs([{ name: "Dwarf Blocker Lineman", skills: ["Fend", "Guard"] }], 10)).result;
    expect(mixed.valid).toBe(false);
    expect(mixed.errors.some((e) => /secondary/i.test(e.message))).toBe(true);
    const twoSec = build("Dwarf", dwarfs([{ name: "Dwarf Blocker Lineman", skills: ["Guard", "Mighty Blow"] }], 10)).result;
    expect(twoSec.valid).toBe(false);
    // One secondary alone on a player is fine (2 SP).
    const one = build("Dwarf", dwarfs([{ name: "Dwarf Blocker Lineman", skills: ["Guard"] }], 10)).result;
    expect(one.errors).toEqual([]);
    expect(one.recomputedSummary.skillPointsUsed).toBe(2);
  });

  it("stars: none in Tiers 1-2; Tier 4 takes one 2-SP star, no second star and no Mega-Star", () => {
    const t1 = build("Human", humans([], 11), { stars: ["Akhorne the Squirrel"] }).result;
    expect(ruleErrors(t1, "star-players")[0]!.message).toBe('Star Players are not allowed (Tier 1) in "Destination Blood Bowl".');
    const t2 = build("Orc", [{ name: "Orc Lineman", count: 11 }], { stars: ["Akhorne the Squirrel"] }).result;
    expect(ruleErrors(t2, "star-players")[0]!.message).toBe('Star Players are not allowed (Tier 2) in "Destination Blood Bowl".');
    const single = { name: "Dwarf Blocker Lineman", skills: ["Fend"] };
    const ok = build("Dwarf", dwarfs(Array(6).fill(single), 5), { stars: ["Akhorne the Squirrel"] }).result;
    expect(ok.errors).toEqual([]);
    expect(ok.recomputedSummary.skillPointsUsed).toBe(8); // 6 skills + 2 for the star
    const over = build("Dwarf", dwarfs(Array(7).fill(single), 4), { stars: ["Akhorne the Squirrel"] }).result;
    expect(ruleErrors(over, "skill-packages")).toHaveLength(1);
    const two = build("Dwarf", dwarfs([], 11), { stars: ["Akhorne the Squirrel", "Helmut Wulf"] }).result;
    expect(ruleErrors(two, "skill-packages")).toHaveLength(1);
    const mega = build("Dwarf", dwarfs([], 11), { stars: ["Morg 'n' Thorg"] }).result;
    expect(ruleErrors(mega, "star-packs").map((e) => e.message).join(" ")).toMatch(/Morg 'n' Thorg is in the Mega-Star pack, which is not open to this team \(Tier 4\)/);
    expect(ruleErrors(mega, "skill-packages").map((e) => e.message).join(" ")).toMatch(/Morg 'n' Thorg is not available in Tier 4/);
  });

  it("Tier 5 Goblin: a Mega-Star (4 SP) plus a star (2 SP) leaves 3; two Mega-Stars or three stars are refused; a pair is one pick", () => {
    const single = { name: "Goblin Lineman", skills: ["Sidestep"] };
    const ok = build("Goblin", goblins([single, single, single], 8), { stars: ["Morg 'n' Thorg", "Fungus the Loon"] }).result;
    expect(ok.errors).toEqual([]);
    expect(ok.recomputedSummary.skillPointsUsed).toBe(9);
    const over = build("Goblin", goblins([single, single, single, single], 7), { stars: ["Morg 'n' Thorg", "Fungus the Loon"] }).result;
    expect(ruleErrors(over, "skill-packages")).toHaveLength(1);
    const twoMega = build("Goblin", goblins([], 11), { stars: ["Morg 'n' Thorg", "Ripper Bolgrot"] }).result;
    expect(ruleErrors(twoMega, "star-packs").map((e) => e.message)).toContain("2 picks from the Mega-Star pack; the limit is 1.");
    const three = build("Goblin", goblins([], 11), { stars: ["Fungus the Loon", "Akhorne the Squirrel", "Helmut Wulf"] }).result;
    expect(ruleErrors(three, "star-players").map((e) => e.message)).toContain("3 Star Players; the limit is 2.");
    const pair = build("Goblin", goblins([single, single, single], 8), { stars: ["Grak", "Crumbleberry", "Fungus the Loon"] }).result;
    expect(pair.errors).toEqual([]);
    expect(pair.recomputedSummary.skillPointsUsed).toBe(9); // pair 4 + star 2 + 3 skills
    // Half a pair cannot be hired alone (the 0-SP half would dodge the charge).
    for (const [half, partner] of [["Crumbleberry", "Grak"], ["Grak", "Crumbleberry"], ["Drull", "Dribl"], ["Valen Swift", "Lucien Swift"]] as const) {
      const lone = build("Goblin", goblins([], 11), { stars: [half] }).result;
      expect(ruleErrors(lone, "star-players").map((e) => e.message)).toContain(`${half} is hired together with ${partner}; ${partner} is missing.`);
    }
  });

  it("caps a team at 1,200,000 gold and refuses Mercenaries, Prayers to Nuffle, Wizards and non-rulebook inducements", () => {
    const rich = build("Human", [{ name: "Human Blitzer", count: 2 }, { name: "Human Catcher", count: 2 }, { name: "Human Thrower", count: 2 }, { name: "Ogre" }, { name: "Human Lineman", count: 5 }], { reRolls: 6, apothecary: true }).result;
    expect(rich.recomputedSummary.goldUsed).toBeGreaterThan(1_200_000);
    expect(rich.valid).toBe(false);
    const allowed = teamBuilderInducementCatalog(pkg, bb2025).filter((i) => i.allowed).map((i) => i.key).sort();
    expect(allowed).toEqual(["biased_referee", "bloodweiser_kegs", "bribes", "extra_team_training", "halfling_master_chef", "infamous_coaching_staff", "mortuary_assistant", "part_time_assistant_coaches", "plague_doctor", "riotous_rookies", "team_mascot", "temp_agency_cheerleaders", "wandering_apothecaries", "weather_mage"]);
    // A base budget of 1,100k under the 1,200k cap: over it is legal, and the builder is told the base.
    expect(pkg.baseGoldBudget).toBe(1_100_000);
    expect(packageRulesInfo(pkg, "Human").baseBudget).toBe(1_100_000);
    const overBase = build("Human", [{ name: "Human Blitzer", count: 2 }, { name: "Human Catcher", count: 2 }, { name: "Human Thrower", count: 2 }, { name: "Ogre" }, { name: "Human Lineman", count: 5 }], { reRolls: 4, apothecary: true }).result;
    expect(overBase.recomputedSummary.goldUsed).toBe(1_110_000);
    expect(overBase.errors).toEqual([]);
    for (const key of ["hireling_sports_wizard", "prayers_to_nuffle", "bretonnian_pastries"]) {
      const r = build("Human", humans([], 11), { inducements: [{ key, count: 1 }] }).result;
      expect(ruleErrors(r, "inducements").length).toBeGreaterThan(0);
    }
  });

  it("builder race rules carry the stacking price and the star SP prices", () => {
    const goblin = packageRaceRules(pkg, "Goblin");
    expect(goblin.skillCosts).toMatchObject({ primary: 1, secondary: 2, eliteSurcharge: 0, stackSurcharge: 1 });
    expect(goblin.stars).toMatchObject({ allowed: true, maxCount: 2, paidInSkillPoints: false });
    expect(goblin.stars.spCosts!.find((s) => s.name === "Morg 'n' Thorg")!.sp).toBe(4);
    expect(goblin.stars.spCosts!.find((s) => s.name === "Fungus the Loon")!.sp).toBe(2);
    const dwarf = packageRaceRules(pkg, "Dwarf");
    expect(dwarf.stars.spCosts!.some((s) => s.name === "Morg 'n' Thorg")).toBe(false);
    expect(packageRaceRules(pkg, "Human").stars.allowed).toBe(false);
    // The builder stops at the tier's own star count (the pack's maxStars), not the package-wide 2.
    expect(["Human", "Orc", "Norse", "Dwarf", "Goblin"].map((race) => builderRaceRules(pkg, race).maxStars)).toEqual([0, 0, 1, 1, 2]);
  });
});
