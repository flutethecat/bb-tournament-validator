import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  composeTeam,
  findRoster,
  findStar,
  loadPackage,
  renderPackageHtml,
  resolveTeamConfig,
  validate,
  type TeamPick,
  type TournamentPackage,
  type ValidationResult,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import nutCupJson from "../../../tournament-packages/whbb-nut-cup-2026.json";
import { renderRulesPage } from "../../../packages/bb-validator/src/render/rulesPage";
import { packageRaceRules, packageRulesInfo } from "../src/teamBuilderPackage";
import { teamBuilderInducementCatalog } from "../src/teamBuilderInducements";

const { pkg, problems } = loadPackage(nutCupJson as unknown as Partial<TournamentPackage>);

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
      teamName: "Nut Cup Test",
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

/** Human T3 core: 12 players, 860k. */
const human = (s: { blitzer: string[]; blitzer2: string[]; catcher: string[]; thrower: string[]; ogre: string[]; lineman: string[] }): Line[] => [
  { name: "Human Blitzer", skills: s.blitzer },
  { name: "Human Blitzer", skills: s.blitzer2 },
  { name: "Human Catcher", skills: s.catcher },
  { name: "Human Catcher" },
  { name: "Human Thrower", skills: s.thrower },
  { name: "Human Thrower" },
  { name: "Ogre", skills: s.ogre },
  { name: "Human Lineman", skills: s.lineman },
  { name: "Human Lineman", count: 4 },
];
const noSkills = { blitzer: [], blitzer2: [], catcher: [], thrower: [], ogre: [], lineman: [] };
const BANNED = (n: string) => `${n} is banned in "WHBB Nut Cup 2026".`;

describe("WHBB Nut Cup 2026 package", () => {
  it("matches the schema and loads without problems", () => {
    const out: string[] = [];
    check(schema, nutCupJson, "$", out);
    expect(out).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("puts every roster in its tier with the two treasury options (T5 adds the star variants)", () => {
    const expected: Record<number, string[]> = {
      1: ["Amazon", "Orc", "Old World Alliance"],
      2: ["Dark Elf", "Nurgle", "Underworld Denizens", "Wood Elf"],
      3: ["Elven Union", "Human", "Lizardmen", "Necromantic Horror", "Norse", "Skaven", "Shambling Undead"],
      4: ["Black Orc", "Chaos Chosen", "Chaos Dwarf", "Chaos Renegade", "Dwarf", "Imperial Nobility", "Khorne", "Vampire"],
      5: ["Goblin", "Halfling"],
    };
    const datasetNames = new Set(bb2025.teams.map((t) => t.name));
    for (const [tier, rosters] of Object.entries(expected))
      for (const race of rosters) {
        expect(datasetNames.has(race)).toBe(true);
        expect(resolveTeamConfig(pkg, race).tierNumber).toBe(Number(tier));
      }
    const summary = packageRulesInfo(pkg).tierSummary.map((t) => ({
      tier: t.tier,
      packs: t.packs.map((p) => [p.gold, p.maxSkills, p.maxSecondary, p.starPlayersAllowed ?? true]),
    }));
    expect(summary).toEqual([
      { tier: 1, packs: [[1150000, 4, 0, false], [1100000, 5, 0, false]] },
      { tier: 2, packs: [[1150000, 5, 0, false], [1100000, 6, 0, false]] },
      { tier: 3, packs: [[1150000, 6, 1, false], [1100000, 7, 1, false]] },
      { tier: 4, packs: [[1150000, 7, 1, false], [1100000, 8, 1, false]] },
      { tier: 5, packs: [[1150000, 8, 2, false], [1100000, 9, 2, false], [1150000, 8, 0, true], [1100000, 9, 0, true]] },
    ]);
    // Paired stars + the five named bans, Tier 5 only; every name is a canonical dataset star.
    const banned = packageRaceRules(pkg, "Goblin").bannedStars;
    expect(banned).toEqual(expect.arrayContaining(["Grak", "Crumbleberry", "Dribl", "Drull", "Lucien Swift", "Valen Swift", "Morg 'n' Thorg"]));
    for (const n of banned) expect(findStar(bb2025, n)?.name).toBe(n);
    expect(packageRaceRules(pkg, "Human").stars.allowed).toBe(false);
  });

  it("accepts a T3 Human under the 1,150k pack: 6 skills incl. 1 secondary and one stacked player, 1,135k", () => {
    const { result } = build(
      "Human",
      human({ blitzer: ["Wrestle", "Dodge"], blitzer2: ["Mighty Blow"], catcher: ["Sure Hands"], thrower: ["Accurate"], ogre: ["Guard"], lineman: [] }),
      { reRolls: 4, apothecary: true, inducements: [{ key: "team_mascot", count: 1 }] },
    );
    expect(result.errors).toEqual([]);
    expect(result.recomputedSummary).toMatchObject({ goldUsed: 1135000, primarySkillCount: 5, secondarySkillCount: 1 });
  });

  it("accepts a T3 Human under the 1,100k pack: 7 skills incl. 1 secondary at 1,085k", () => {
    const { result } = build(
      "Human",
      human({ blitzer: ["Wrestle", "Dodge"], blitzer2: ["Mighty Blow"], catcher: ["Sure Hands"], thrower: ["Accurate"], ogre: ["Guard"], lineman: ["Block"] }),
      { reRolls: 4, inducements: [{ key: "team_mascot", count: 1 }] },
    );
    expect(result.errors).toEqual([]);
    expect(result.recomputedSummary.goldUsed).toBe(1085000);
  });

  it("refuses 7 skills above 1,100k (neither option fits)", () => {
    const { result } = build(
      "Human",
      human({ blitzer: ["Wrestle", "Dodge"], blitzer2: ["Mighty Blow"], catcher: ["Sure Hands"], thrower: ["Accurate"], ogre: ["Guard"], lineman: ["Block"] }),
      { reRolls: 4, apothecary: true, inducements: [{ key: "team_mascot", count: 1 }] },
    );
    expect(ruleErrors(result, "skill-packages").map((e) => e.message)).toEqual([
      "Team uses 7 skills (1 secondary) + 1135k (Tier 3); no skill package fits.",
    ]);
  });

  it("refuses a T3 team with 2 secondary skills", () => {
    const { result } = build("Human", human({ ...noSkills, blitzer: ["Dodge"], blitzer2: ["Dodge"] }));
    const errs = ruleErrors(result, "skill-packages");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.message).toBe("Team uses 2 skills (2 secondary) + 860k (Tier 3); no skill package fits.");
    expect(errs[0]!.expected).toContain("6 skills (≤1 secondary) @ 1150k");
  });

  it("refuses a T1 stacked player carrying a secondary", () => {
    const { result } = build("Orc", [{ name: "Orc Blitzer", skills: ["Tackle", "Dodge"] }, { name: "Orc Lineman", count: 10 }]);
    expect(ruleErrors(result, "skill-packages").map((e) => e.message)).toEqual([
      "Team uses 2 skills (1 secondary) + 585k (Tier 1); no skill package fits.",
    ]);
  });

  it("refuses a second stacked player", () => {
    const { result } = build("Orc", [{ name: "Orc Blitzer", count: 2, skills: ["Wrestle", "Tackle"] }, { name: "Orc Lineman", count: 9 }]);
    expect(ruleErrors(result, "skill-points").map((e) => e.message)).toEqual([
      "2 players have more than one added skill; skill stacking allows at most 1 (Tier 1).",
    ]);
  });

  it("allows the Halfling Master Chef for Halfling and refuses it for Human", () => {
    const halfling = build("Halfling", [{ name: "Halfling Hopeful", count: 11 }], { inducements: [{ key: "halfling_master_chef", count: 1 }] }).result;
    expect(halfling.errors).toEqual([]);
    const humanChef = build("Human", human(noSkills), { inducements: [{ key: "halfling_master_chef", count: 1 }] }).result;
    expect(ruleErrors(humanChef, "inducements").map((e) => e.message)).toEqual([
      'Halfling Master Chef is only available to Halfling teams in "WHBB Nut Cup 2026".',
    ]);
  });

  it("builder inducement catalog marks the Chef Halfling-only and allows only the listed inducements", () => {
    const rows = teamBuilderInducementCatalog(pkg, bb2025);
    expect(rows.find((r) => r.key === "halfling_master_chef")).toMatchObject({ allowed: true, rosterOnly: ["Halfling"] });
    expect(rows.filter((r) => r.allowed).map((r) => r.key).sort()).toEqual([
      "bloodweiser_kegs",
      "bribes",
      "halfling_master_chef",
      "mortuary_assistant",
      "plague_doctor",
      "riotous_rookies",
      "team_mascot",
      "weather_mage",
    ]);
  });

  it("refuses a banned star and a paired star on a T5 Goblin", () => {
    const morg = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: ["Morg 'n' Thorg"] }).result;
    expect(ruleErrors(morg, "star-players").map((e) => e.message)).toContain(BANNED("Morg 'n' Thorg"));
    const pair = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: ["Grak", "Crumbleberry"] }).result;
    const msgs = ruleErrors(pair, "star-players").map((e) => e.message);
    expect(msgs).toContain(BANNED("Grak"));
    expect(msgs).toContain(BANNED("Crumbleberry"));
  });

  it("accepts a T5 Goblin with one star and primary-only skills; refuses star + a secondary", () => {
    const ok = build("Goblin", [{ name: "Goblin Lineman", count: 8, skills: ["Sidestep"] }, { name: "Goblin Lineman", count: 3 }], {
      stars: ["Fungus the Loon"],
    }).result;
    expect(ok.errors).toEqual([]);
    const bad = build("Goblin", [{ name: "Goblin Lineman", skills: ["Block"] }, { name: "Goblin Lineman", count: 10 }], { stars: ["Fungus the Loon"] }).result;
    expect(ruleErrors(bad, "skill-packages").map((e) => e.message)).toEqual([
      "Team uses 1 skill (1 secondary) + 520k with a Star Player (Tier 5); no skill package fits.",
    ]);
    // Without the star, 2 secondaries are fine.
    const noStar = build("Goblin", [{ name: "Goblin Lineman", count: 2, skills: ["Block"] }, { name: "Goblin Lineman", count: 9 }]).result;
    expect(noStar.errors).toEqual([]);
  });

  it("refuses any star on a T1 team", () => {
    const { result } = build("Orc", [{ name: "Orc Lineman", count: 11 }], { stars: ["Akhorne the Squirrel"] });
    expect(ruleErrors(result, "star-players")[0]!.message).toBe('Star Players are not allowed (Tier 1) in "WHBB Nut Cup 2026".');
  });

  it("builder pack buttons read count packs as gold + skill counts (SP packs unchanged)", () => {
    const context: Record<string, unknown> = { console };
    runInNewContext(readFileSync(new URL("../public/team-builder.js", import.meta.url), "utf8"), context);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = context.TeamBuilderCore as any;
    const [t3, t5star] = [packageRulesInfo(pkg).tierSummary[2]!.packs[0], packageRulesInfo(pkg).tierSummary[4]!.packs[3]];
    expect(core.packTermsText(t3)).toBe("1,150k · 6 skills (≤1 secondary) · no stars");
    expect(core.packTermsText(t5star)).toBe("1,100k · 9 skills (primary only)");
    expect(core.packTermsText({ gold: 1070000, skillPointBudget: 160, maxPerPlayer: 2 })).toBe("1,070k · 160 SP");
  });

  it("refuses a submitted star carrying an added skill (stars take no added skills); house-rule knob lets it", () => {
    const { composed } = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: ["Fungus the Loon"] });
    const base = findStar(bb2025, "Fungus the Loon")!.skills!;
    expect(base).toContain("Ball & Chain");
    const withStarSkills = (extra: string[]) => ({
      ...composed.roster,
      players: composed.roster.players.map((p) => (p.positionName === "Fungus the Loon" ? { ...p, skills: [...base, ...extra] } : p)),
    });
    const clean = validate(withStarSkills([]), pkg, bb2025);
    expect(ruleErrors(clean, "star-skills")).toEqual([]);
    const guard = validate(withStarSkills(["Guard"]), pkg, bb2025);
    expect(ruleErrors(guard, "star-skills").map((e) => e.message)).toEqual([
      "Fungus the Loon has added skill (Guard); Star Players take no added skills.",
    ]);
    expect(guard.valid).toBe(false);
    const allowed = { ...pkg, starPlayers: { ...pkg.starPlayers, addedSkillsAllowed: true } };
    expect(ruleErrors(validate(withStarSkills(["Guard"]), allowed, bb2025), "star-skills")).toEqual([]);
  });

  it("reports goldUsed without sheet skill gold under count packs (skills are free)", () => {
    // 11 linemen + 8 rerolls + apothecary + bribe + keg = 1,150,000; six Wrestle passes printed at 20k each.
    const { composed } = build(
      "Human",
      [{ name: "Human Lineman", count: 6, skills: ["Wrestle"] }, { name: "Human Lineman", count: 5 }],
      { reRolls: 8, apothecary: true, inducements: [{ key: "bribes", count: 1 }, { key: "bloodweiser_kegs", count: 1 }] },
    );
    const s = composed.roster.summary!;
    const submitted = { ...composed.roster, summary: { ...s, skillsCost: 120000, total: s.total - s.skillsCost + 120000 } };
    const result = validate(submitted, pkg, bb2025);
    expect(result.errors).toEqual([]);
    expect(result.recomputedSummary.goldUsed).toBe(1150000);
  });

  it("export sheet renders the count packs, stacking and star access per tier", () => {
    const html = renderPackageHtml(pkg);
    expect(html).not.toContain("∞ primary");
    expect(html).toContain("1,150,000 gp · 6 skills (≤1 secondary) · ≤2/player · no stars");
    expect(html).toContain("1,100,000 gp · 7 skills (≤1 secondary) · ≤2/player · no stars");
    expect(html).toContain("1,150,000 gp · 8 skills (primary only) · ≤2/player");
    expect(html).toContain("1 (≤2 skills, ≤1 secondary)");
    expect(html).toContain("halfling_master_chef (Halfling only)");
  });

  it("rules page prices the Halfling-only Chef at the Halfling price", () => {
    const html = renderRulesPage(pkg);
    const at = html.indexOf('<th scope="row">Halfling Master Chef');
    expect(at).toBeGreaterThan(-1);
    const row = html.slice(at, html.indexOf("</tr>", at));
    expect(row).toContain("(Halfling only)");
    expect(row).toContain("100,000 gp");
    expect(row).toContain("(Halfling price)");
    expect(row).not.toContain("300,000");
  });

  describe("star-skills is fail-safe", () => {
    const goblinWith = (star: string, skills: string[]) => {
      const { composed } = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: [star] });
      return { ...composed.roster, players: composed.roster.players.map((p) => (p.positionName === star ? { ...p, skills } : p)) };
    };
    const starErrors = (roster: Parameters<typeof validate>[0]) => ruleErrors(validate(roster, pkg, bb2025), "star-skills").map((e) => e.message);

    it("decodes XML entities: a star composed from roster XML (Ball &amp; Chain) passes", () => {
      const { composed, result } = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: ["Fungus the Loon"] });
      expect(composed.roster.players.find((p) => p.positionName === "Fungus the Loon")!.skills).toContain("Ball &amp; Chain");
      expect(ruleErrors(result, "star-skills")).toEqual([]);
      const kreek = build("Goblin", [{ name: "Goblin Lineman", count: 11 }], { stars: ["Kreek Rustgouger"] }).result;
      expect(ruleErrors(kreek, "star-skills")).toEqual([]);
    });

    it("canonicalises spellings: Side Step / No Hands / Kick Team-Mate match the dataset", () => {
      const akhorne = findStar(bb2025, "Akhorne the Squirrel")!.skills!;
      const legacy = akhorne.map((s) => (s === "Sidestep" ? "Side Step" : s === "No Ball" ? "No Hands" : s));
      expect(legacy).toContain("Side Step");
      expect(starErrors(goblinWith("Akhorne the Squirrel", legacy))).toEqual([]);
      expect(starErrors(goblinWith("Akhorne the Squirrel", [...legacy, "GUARD"]))).toEqual([
        "Akhorne the Squirrel has added skill (Guard); Star Players take no added skills.",
      ]);
    });

    it("ignores printed labels and trait/special-rule entries", () => {
      const akhorne = findStar(bb2025, "Akhorne the Squirrel")!.skills!.map((s) => (s === "Blind Rage" ? "Special rule: Blind Rage" : s));
      expect(starErrors(goblinWith("Akhorne the Squirrel", akhorne))).toEqual([]);
      // Comma-split fragments and unknown names never count as added skills.
      expect(starErrors(goblinWith("Fungus the Loon", [...findStar(bb2025, "Fungus the Loon")!.skills!, '"Excuse Me', 'Are You a Zoat?"', "Krump"]))).toEqual([]);
    });

    it("stars without a dataset skill list produce no finding from printed skills", () => {
      for (const star of ["Bryce 'the Slice' Cambuel", "Frank 'n' Stein"]) {
        expect(findStar(bb2025, star)!.skills).toBeUndefined();
        const { composed } = build("Human", human(noSkills), { stars: [star] });
        const roster = { ...composed.roster, players: composed.roster.players.map((p) => (p.positionName === star ? { ...p, skills: ["Block", "Loner", "Chainsaw"] } : p)) };
        expect(ruleErrors(validate(roster, pkg, bb2025), "star-skills")).toEqual([]);
      }
    });
  });
});
