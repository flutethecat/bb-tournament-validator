import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  composeTeam,
  effectiveRosterLimits,
  effectiveStaffPrices,
  findPosition,
  findRoster,
  loadPackage,
  SEVENS_INDUCEMENTS,
  SEVENS_PROFILE,
  SEVENS_TEAMS,
  validate,
  type DeepPartial,
  type Roster,
  type RosterPlayer,
  type TournamentPackage,
} from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";

// Blood Bowl Sevens (Spike! Journal 22), spec-sevens-rules-2026-11-02: the profile, the shipped Matched Play package and
// the validator rules (squad size, non-Lineman cap, Veteran, Sevens inducements, no stars, staff gold recompute, tier SP).

const shipped = JSON.parse(
  readFileSync(new URL("../../../tournament-packages/sevens-matched-play.json", import.meta.url), "utf8"),
) as DeepPartial<TournamentPackage>;
const MATCHED = loadPackage(shipped).pkg;
const PROFILE_ONLY = loadPackage({ name: "Sevens league draft", format: "sevens", skillAllotment: {} }).pkg;

interface Pick { pos: string; n?: number; veteran?: boolean; skills?: string[]; MA?: number }

/** A roster sheet built from the dataset, priced at Sevens prices unless the test overrides the sheet. */
function team(
  race: string,
  picks: Pick[],
  opts: { reRolls?: number; fans?: number; apothecary?: boolean; cheerleaders?: number; coaches?: number; inducements?: Roster["inducements"]; sidelineCost?: number } = {},
): Roster {
  const ds = findRoster(bb2025, race)!;
  const players: RosterPlayer[] = [];
  for (const p of picks) {
    const pos = findPosition(ds, p.pos);
    for (let i = 0; i < (p.n ?? 1); i++) {
      players.push({
        number: players.length + 1,
        positionName: pos?.name ?? p.pos,
        MA: p.MA ?? (pos ? pos.MA - (p.veteran ? 1 : 0) : 6),
        ST: pos?.ST ?? 3,
        AG: pos?.AG ?? "3+",
        PA: pos?.PA ?? "4+",
        AV: pos?.AV ?? "9+",
        skills: [...(pos?.skills ?? []), ...(p.skills ?? [])],
        keywords: [...(pos?.keywords ?? [])],
        cost: pos?.cost ?? 100000,
        ...(p.veteran ? { veteran: true } : {}),
      });
    }
  }
  const sideline = {
    apothecary: opts.apothecary ?? false,
    assistantCoaches: opts.coaches ?? 0,
    cheerleaders: opts.cheerleaders ?? 0,
    dedicatedFans: opts.fans ?? 0,
    reRolls: opts.reRolls ?? 1,
  };
  const sidelineCost = opts.sidelineCost ?? sideline.reRolls * 100000 + (sideline.apothecary ? 80000 : 0) + (sideline.assistantCoaches + sideline.cheerleaders) * 20000 + sideline.dedicatedFans * 20000;
  const inducements = opts.inducements ?? [];
  const playersCost = players.reduce((a, p) => a + p.cost, 0);
  const inducementCost = inducements.reduce((a, i) => a + (i.cost ?? 0) * (i.count ?? 1), 0);
  return {
    rosterName: race,
    coach: "Tester",
    teamName: "Sevens Test",
    sideline,
    inducements,
    leagues: [],
    specialRules: [...ds.specialRules],
    players,
    summary: { playersCost, skillsCost: 0, inducementCost, sidelineCost, total: playersCost + inducementCost + sidelineCost },
  };
}

/** Human: Veteran Lineman + 3 Linemen + 2 Blitzers + 1 Catcher, 1 reroll = 545k. */
const humanPicks = (): Pick[] => [
  { pos: "Human Lineman", veteran: true },
  { pos: "Human Lineman", n: 3 },
  { pos: "Human Blitzer", n: 2 },
  { pos: "Human Catcher" },
];
const messages = (r: ReturnType<typeof validate>) => r.errors.map((e) => e.message);

describe("Sevens profile and package model", () => {
  it("a format: sevens package gets the Sevens defaults (SJ22 + owner 11-02)", () => {
    const p = PROFILE_ONLY;
    expect(p.format).toBe("sevens");
    expect(p.goldBudget).toBe(600000);
    expect(p.special).toMatchObject({ minPlayers: 7, maxPlayers: 11, maxNonLineman: 4, veteran: true });
    expect(p.staffPrices).toEqual({ reRoll: 100000, assistantCoach: 20000, cheerleader: 20000, apothecary: 80000, dedicatedFan: 20000 });
    expect(p.sideline).toEqual({ maxReRolls: 6, maxApothecary: 1, maxCheerleaders: 3, maxAssistantCoaches: 3, maxDedicatedFans: 5, dedicatedFansStart: 0 });
    expect(p.inducements).toMatchObject({ set: "sevens", allowed: ["*"] });
    expect(p.starPlayers.allowed).toBe(false);
    expect(p.skillAllotment).toMatchObject({ maxPerPlayer: 1, eliteMaxTotal: 2, primaryCostGold: 0, secondaryCostGold: 0, eliteSurchargeGold: 0 });
    expect(p.eligibleRosters).toEqual(SEVENS_TEAMS);
    expect(p.eligibleRosters).toHaveLength(30);
    expect(p.eligibleRosters).not.toContain("Slann");
  });

  it("every profile field is an override: the package and its extends base win", () => {
    const p = loadPackage({
      name: "Big Sevens",
      format: "sevens",
      goldBudget: 650000,
      skillAllotment: {},
      special: { maxPlayers: 10, minPlayers: 8 },
      sideline: { dedicatedFansStart: 1, maxReRolls: 4 },
      staffPrices: { reRoll: 90000 },
    }).pkg;
    expect(p.goldBudget).toBe(650000);
    expect(p.special).toMatchObject({ maxPlayers: 10, minPlayers: 8, maxNonLineman: 4, veteran: true });
    expect(p.sideline).toMatchObject({ dedicatedFansStart: 1, maxReRolls: 4, maxCheerleaders: 3 });
    expect(p.staffPrices).toMatchObject({ reRoll: 90000, cheerleader: 20000 });
    // An organiser layer over the shipped package is Sevens too (format comes from the base).
    const child = loadPackage({ name: "My Sevens", extends: "base", skillAllotment: {}, goldBudget: 620000 }, { resolveExtends: () => shipped }).pkg;
    expect(child.format).toBe("sevens");
    expect(child.goldBudget).toBe(620000);
    expect(child.tiers).toHaveLength(4);
    expect(child.special.maxNonLineman).toBe(4);
  });

  it("standard packages are untouched: no format, staffPrices or Sevens keys appear", () => {
    const p = loadPackage({ name: "Plain", skillAllotment: {} }).pkg;
    expect("format" in p).toBe(false);
    expect("staffPrices" in p).toBe(false);
    expect(p.special).not.toHaveProperty("maxPlayers");
    expect(p.special).not.toHaveProperty("maxNonLineman");
    expect(p.inducements).not.toHaveProperty("set");
  });

  it("the profile constant is never mutated by a loaded package", () => {
    const p = loadPackage({ name: "X", format: "sevens", skillAllotment: {} }).pkg;
    p.eligibleRosters.push("Slann");
    p.staffPrices!.reRoll = 1;
    expect(SEVENS_PROFILE.eligibleRosters).not.toContain("Slann");
    expect(SEVENS_PROFILE.staffPrices!.reRoll).toBe(100000);
  });

  it("malformed values are reported and never price a team cheaper or open a closed door", () => {
    const { pkg: p, problems } = loadPackage({
      name: "Broken",
      format: "sevens",
      skillAllotment: {},
      staffPrices: { reRoll: -5, cheerleader: 1.5 as number, apothecary: "80k" as unknown as number },
      special: { maxPlayers: 0, maxNonLineman: -1, veteran: "yes" as unknown as boolean },
      sideline: { dedicatedFansStart: 2.5 },
      inducements: { set: "eights" as unknown as "sevens" },
      starPlayers: { allowed: true },
    });
    expect(p.staffPrices).toMatchObject({ reRoll: 100000, cheerleader: 20000, apothecary: 80000 });
    expect(p.sideline.dedicatedFansStart).toBe(0);
    expect(p.inducements.set).toBe("sevens");
    expect(p.special.veteran).toBe(true);
    expect(p.starPlayers.allowed).toBe(false);
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("staffPrices.reRoll must be a non-negative whole number"),
        expect.stringContaining("staffPrices.cheerleader"),
        expect.stringContaining("staffPrices.apothecary"),
        "special.maxPlayers must be a whole number of at least 1.",
        "special.maxNonLineman must be a non-negative whole number or null.",
        expect.stringContaining("special.veteran must be true or false"),
        expect.stringContaining("sideline.dedicatedFansStart must be a non-negative whole number"),
        expect.stringContaining('inducements.set must be "core" or "sevens"'),
        "Star Players aren't available in Sevens: starPlayers.allowed is ignored.",
      ]),
    );
    const bad = loadPackage({ name: "Eights", format: "eights" as unknown as "sevens", skillAllotment: {} });
    expect(bad.problems).toContain('format must be "standard" or "sevens" (got "eights"; treated as standard).');
    expect(bad.pkg.format).toBeUndefined();
    expect(loadPackage({ name: "Tight", format: "sevens", skillAllotment: {}, special: { minPlayers: 9, maxPlayers: 8 } }).problems).toContain(
      "special.maxPlayers (8) is below special.minPlayers (9): no roster can be legal.",
    );
  });

  it("the shipped Matched Play package loads cleanly with the SJ22 tiers (Slann not on it)", () => {
    const { problems } = loadPackage(shipped);
    expect(problems).toEqual([]);
    expect(MATCHED.name).toBe("Blood Bowl Sevens (Matched Play)");
    expect(MATCHED.tiers!.map((t) => [t.tier, t.rosters.length, t.maxPrimary])).toEqual([[1, 11, 1], [2, 9, 2], [3, 6, 3], [4, 4, 4]]);
    expect(MATCHED.tiers!.flatMap((t) => t.rosters)).not.toContain("Slann");
    expect(Object.keys(SEVENS_INDUCEMENTS)).toContain("desperate_measures");
  });
});

describe("Sevens validator rules", () => {
  it("a legal Sevens team validates; staff and skills are priced the Sevens way", () => {
    const r = validate(team("Human", humanPicks()), MATCHED, bb2025);
    expect(messages(r)).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.recomputedSummary.goldUsed).toBe(545000);
    expect(r.recomputedSummary.staffCost).toBe(545000);
  });

  it("max players comes from the package (11), not the 16 standard", () => {
    const r = validate(team("Human", [...humanPicks(), { pos: "Human Lineman", n: 5 }], { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    expect(messages(r)).toContain("Team has 12 players; Sevens allows at most 11.");
    const six = validate(team("Human", humanPicks().slice(0, 3)), MATCHED, bb2025);
    expect(messages(six)).toContain("Team has 6 players; the tournament requires at least 7.");
  });

  it("at most 4 players without the Lineman keyword", () => {
    const r = validate(team("Human", [{ pos: "Human Lineman", veteran: true }, { pos: "Human Lineman" }, { pos: "Human Blitzer", n: 2 }, { pos: "Human Catcher", n: 2 }, { pos: "Human Thrower" }], { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    expect(messages(r)).toContain("5 players without the Lineman keyword; Sevens allows at most 4.");
    expect(r.errors.find((e) => e.message.startsWith("5 players"))?.suggestion).toContain("Human Blitzer, Human Catcher, Human Thrower");
  });

  it("the keyword decides who is a Lineman (Q2 edge cases)", () => {
    // Human Halfling Hopefuls carry Lineman: 4 positionals + 3 Hopefuls is legal, and a Hopeful may be the Veteran.
    const hopefuls = validate(team("Human", [{ pos: "Halfling Hopeful", veteran: true }, { pos: "Halfling Hopeful", n: 2 }, { pos: "Human Blitzer", n: 2 }, { pos: "Human Catcher", n: 2 }], { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    expect(messages(hopefuls)).toEqual([]);
    // Chaos Renegade Goblin / Orc / Skaven / Dark Elf all carry Lineman; the thrower and Big Guys don't.
    const renegades = validate(
      team("Chaos Renegade", [
        { pos: "Renegade Goblin", veteran: true }, { pos: "Renegade Orc" }, { pos: "Renegade Skaven" }, { pos: "Renegade Dark Elf" },
        { pos: "Renegade Human Thrower" }, { pos: "Troll" },
      ], { reRolls: 0, sidelineCost: 0 }),
      { ...MATCHED, goldBudget: 1000000 },
      bb2025,
    );
    expect(messages(renegades).filter((m) => /Lineman|Veteran/.test(m))).toEqual([]);
    // OWA: the Dwarf Lineman is a Lineman (Veteran-eligible); the Troll Slayer is not.
    const owa = validate(team("Old World Alliance", [{ pos: "Dwarf Lineman", veteran: true }, { pos: "Human Lineman", n: 6 }], { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    expect(messages(owa)).toEqual([]);
    const slayer = validate(team("Old World Alliance", [{ pos: "Troll Slayer", veteran: true }, { pos: "Human Lineman", n: 6 }], { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    expect(messages(slayer)).toContain("#1 Troll Slayer can't be the Veteran: only Linemen can.");
  });

  it("exactly one Veteran, a Lineman, MA printed one lower", () => {
    const none = humanPicks().map((p) => ({ ...p, veteran: false }));
    expect(messages(validate(team("Human", none), MATCHED, bb2025))).toContain("Pick one Lineman as the Veteran.");
    const two = [{ pos: "Human Lineman", veteran: true, n: 2 }, { pos: "Human Lineman", n: 2 }, { pos: "Human Blitzer", n: 2 }, { pos: "Human Catcher" }];
    expect(messages(validate(team("Human", two), MATCHED, bb2025))).toContain("2 Veterans; only one is allowed.");
    const blitzer = [{ pos: "Human Blitzer", veteran: true }, { pos: "Human Lineman", n: 5 }, { pos: "Human Catcher" }];
    expect(messages(validate(team("Human", blitzer), MATCHED, bb2025))).toContain("#1 Human Blitzer can't be the Veteran: only Linemen can.");
    const fullMA = [{ pos: "Human Lineman", veteran: true, MA: 6 }, ...humanPicks().slice(1)];
    expect(messages(validate(team("Human", fullMA), MATCHED, bb2025))).toContain(
      "#1 Human Lineman is the Veteran, so MA should read 5 (one lower than 6); the sheet shows 6.",
    );
    // A standard package refuses a Veteran mark.
    const standard = loadPackage({ name: "Plain", skillAllotment: {} }).pkg;
    expect(messages(validate(team("Human", humanPicks()), standard, bb2025))).toContain(
      "#1 Human Lineman is marked as the Veteran, but this ruleset has no Veteran (a Blood Bowl Sevens rule).",
    );
  });

  it("Team Captain stays alongside the Veteran (owner Q7)", () => {
    const picks: Pick[] = [{ pos: "Human Lineman", veteran: true }, { pos: "Human Lineman", n: 3 }, { pos: "Human Blitzer" }, { pos: "Human Blitzer", skills: ["Team Captain", "Pro"] }, { pos: "Human Catcher" }];
    const r = validate(team("Human", picks), MATCHED, bb2025);
    expect(messages(r)).toEqual([]);
  });

  it("only Sevens inducements, at Sevens caps and prices", () => {
    const ind = (name: string, count: number, cost: number) => ({ name, count, cost });
    const r = validate(team("Human", humanPicks(), { inducements: [ind("Biased Referee", 1, 80000)] }), { ...MATCHED, goldBudget: 2000000 }, bb2025);
    expect(messages(r)).toContain("Biased Referee isn't a Sevens inducement.");
    const merc = validate(team("Human", humanPicks(), { inducements: [{ id: "mercenaries", name: "Mercenary Players", count: 1, cost: 0 }] }), MATCHED, bb2025);
    expect(messages(merc)).toContain("Mercenaries aren't available in Sevens.");
    const star = validate(team("Human", humanPicks(), { inducements: [ind("Griff Oberwald", 1, 0)] }), MATCHED, bb2025);
    expect(messages(star)).toContain("Star Players aren't available in Sevens.");
    const bribes = validate(team("Human", humanPicks(), { reRolls: 0, sidelineCost: 0, inducements: [ind("Bribes", 3, 100000)] }), { ...MATCHED, goldBudget: 2000000 }, bb2025);
    expect(messages(bribes)).toContain("3× Bribes; the Sevens limit is 2.");
    // Desperate Measures (new in Sevens) at 50k each; a 5k Temp Agency Cheerleader is re-priced to 15k (warning).
    const dm = validate(team("Human", humanPicks(), { reRolls: 0, sidelineCost: 0, inducements: [ind("Desperate Measures", 2, 50000), ind("Temp Agency Cheerleaders", 1, 5000)] }), MATCHED, bb2025);
    expect(messages(dm)).toEqual([]);
    expect(dm.recomputedSummary.inducementsCost).toBe(115000);
    expect(dm.warnings.map((w) => w.message)).toContain("Temp Agency Cheerleaders costs 15k each in Sevens; the sheet shows 5k.");
    // Wandering Apothecary: only for teams that can hire an Apothecary.
    const wa = validate(team("Necromantic Horror", [{ pos: "Zombie Lineman", veteran: true }, { pos: "Zombie Lineman", n: 6 }], { reRolls: 0, sidelineCost: 0, inducements: [ind("Wandering Apothecary", 1, 100000)] }), MATCHED, bb2025);
    expect(messages(wa)).toContain("Wandering Apothecary is only available to teams that can hire an Apothecary.");
    // An organiser drop: the item is off the package's allowed list.
    const dropped = validate(team("Human", humanPicks(), { reRolls: 0, sidelineCost: 0, inducements: [ind("Desperate Measures", 1, 50000)] }), { ...MATCHED, inducements: { ...MATCHED.inducements, allowed: ["bribes"] } }, bb2025);
    expect(messages(dropped)).toContain('Desperate Measures is not allowed in "Blood Bowl Sevens (Matched Play)".');
  });

  it("Star Players are refused, whatever a tier says", () => {
    const withStar = team("Human", [...humanPicks(), { pos: "Griff Oberwald" }]);
    withStar.players[withStar.players.length - 1]!.cost = 280000;
    const lenient = { ...MATCHED, goldBudget: 2000000, tiers: MATCHED.tiers!.map((t) => ({ ...t, starPlayersAllowed: true })) };
    expect(messages(validate(withStar, lenient, bb2025))).toContain('Star Players are not allowed (Tier 1) in "Blood Bowl Sevens (Matched Play)".');
  });

  it("staff gold is recomputed from the counts, never trusted from the sheet", () => {
    // The sheet prices 2 rerolls at the Human 50k: 100k. Sevens: 200k, so the team is 645k, over 600k.
    const sheet = team("Human", humanPicks(), { reRolls: 2, sidelineCost: 100000 });
    const r = validate(sheet, MATCHED, bb2025);
    expect(r.recomputedSummary.goldUsed).toBe(645000);
    expect(messages(r)).toContain("Team costs 645k, over the 600k budget (Tier 1).");
    expect(r.warnings.map((w) => w.message)).toContain("Sideline staff costs 200k at Sevens prices (2 rerolls × 100k); the sheet shows 100k.");
    // Apothecary 80k, cheerleaders / coaches 20k, fans 20k each from 0.
    const staff = validate(team("Human", humanPicks(), { reRolls: 0, apothecary: true, cheerleaders: 1, coaches: 1, fans: 1, sidelineCost: 0 }), MATCHED, bb2025);
    expect(staff.recomputedSummary.staffCost - 445000).toBe(140000);
    // Sevens Free Create style: fans start at 1 free.
    const league = loadPackage({ name: "League draft", format: "sevens", skillAllotment: {}, sideline: { dedicatedFansStart: 1 } }).pkg;
    expect(validate(team("Human", humanPicks(), { reRolls: 0, fans: 1, sidelineCost: 0 }), league, bb2025).recomputedSummary.staffCost).toBe(445000);
    // Rerolls over the Sevens cap of 6.
    expect(messages(validate(team("Human", humanPicks(), { reRolls: 7 }), { ...MATCHED, goldBudget: null }, bb2025))).toContain("7 re-rolls exceeds the tournament limit of 6.");
  });

  it("skill points per Sevens tier on the count knobs; skills add no gold", () => {
    const add = (race: string, picks: Pick[]) => validate(team(race, picks, { reRolls: 0, sidelineCost: 0 }), MATCHED, bb2025);
    // Human = Tier 1: one Primary.
    const one = add("Human", [{ pos: "Human Lineman", veteran: true, skills: ["Wrestle"] }, ...humanPicks().slice(1)]);
    expect(messages(one)).toEqual([]);
    expect(one.recomputedSummary.skillsCost).toBe(0);
    expect(one.recomputedSummary.goldUsed).toBe(445000);
    const two = add("Human", [{ pos: "Human Lineman", veteran: true, skills: ["Wrestle"] }, { pos: "Human Lineman", skills: ["Kick"] }, { pos: "Human Lineman", n: 2 }, { pos: "Human Blitzer", n: 2 }, { pos: "Human Catcher" }]);
    expect(messages(two).some((m) => m.startsWith("Team took 2 primary + 0 secondary skills"))).toBe(true);
    // Tier 1 can't afford the Secondary (2 SP).
    const sec = add("Human", [{ pos: "Human Lineman", veteran: true }, { pos: "Human Lineman", n: 3 }, { pos: "Human Blitzer", n: 2, skills: [] }, { pos: "Human Catcher", skills: ["Mighty Blow"] }]);
    expect(messages(sec).some((m) => m.startsWith("Team took 0 primary + 1 secondary skills"))).toBe(true);
    // Black Orc = Tier 3: one Secondary + one Primary fits; a second Secondary doesn't (only one per team).
    const bo = (picks: Pick[]) => add("Black Orc", [{ pos: "Goblin Bruiser", veteran: true }, { pos: "Goblin Bruiser", n: 2 }, ...picks]);
    expect(messages(bo([{ pos: "Black Orc", skills: ["Dodge"] }, { pos: "Black Orc", skills: ["Wrestle"] }, { pos: "Black Orc", n: 2 }]))).toEqual([]);
    expect(messages(bo([{ pos: "Black Orc", skills: ["Dodge"] }, { pos: "Black Orc", skills: ["Sidestep"] }, { pos: "Black Orc", n: 2 }])).some((m) => m.startsWith("Team took 0 primary + 2 secondary skills"))).toBe(true);
    // One added skill per player.
    expect(messages(bo([{ pos: "Black Orc", skills: ["Wrestle", "Kick"] }, { pos: "Black Orc", n: 3 }]))).toContain("#4 has 2 added skills; the limit is 1 per player.");
    // At most 2 Elite skills (Ogre = Tier 4: four primaries to spend).
    const ogre = add("Ogre", [{ pos: "Gnoblar Lineman", veteran: true }, { pos: "Gnoblar Lineman", n: 3 }, { pos: "Ogre Blocker", n: 3, skills: ["Guard"] }]);
    expect(messages(ogre)).toEqual(["Team took 3 elite skills; the limit is 2 (Tier 4)."]);
  });
});

describe("effectiveRosterLimits (for the Roster Builder lane)", () => {
  it("Sevens limits for a race", () => {
    const l = effectiveRosterLimits(MATCHED, "Human", bb2025)!;
    expect(l).toMatchObject({ format: "sevens", race: "Human", budget: 600000, minPlayers: 7, maxPlayers: 11, maxNonLineman: 4, staffPriced: true, starPlayersAllowed: false, inducementSet: "sevens" });
    expect(l.nonLinemanPositions).toEqual(["Human Thrower", "Human Catcher", "Human Blitzer", "Ogre"]);
    expect(l.veteran).toEqual({ required: true, eligiblePositions: ["Human Lineman", "Halfling Hopeful"], maDelta: -1 });
    expect(l.staff).toEqual({
      reRolls: { price: 100000, max: 6 },
      assistantCoaches: { price: 20000, max: 3 },
      cheerleaders: { price: 20000, max: 3 },
      apothecary: { price: 80000, max: 1 },
      dedicatedFans: { price: 20000, max: 5, start: 0, min: 0 },
    });
    expect(l.inducements.map((i) => i.id)).toContain("desperate_measures");
    expect(l.inducements.find((i) => i.id === "bribes")).toMatchObject({ price: 100000, max: 2, allowed: true, available: true });
    expect(l.skills).toMatchObject({ tier: 1, maxPrimary: 1, maxSecondary: 0, secondarySwap: true, secondarySwapRatio: 2, secondarySwapMax: 1, maxPerPlayer: 1, eliteMaxTotal: 2, gold: { primary: 0, secondary: 0, elitePrimary: 0, eliteSecondary: 0 } });
    const undead = effectiveRosterLimits(MATCHED, "Necromantic Horror", bb2025)!;
    expect(undead.staff.apothecary.max).toBe(0);
    expect(undead.inducements.find((i) => i.id === "wandering_apothecaries")).toMatchObject({ available: false, reason: "Only for teams that can hire an Apothecary." });
    expect(undead.inducements.find((i) => i.id === "mortuary_assistant")).toMatchObject({ available: true });
    expect(effectiveRosterLimits(MATCHED, "Goblin", bb2025)!.inducements.find((i) => i.id === "bribes")!.price).toBe(50000);
  });

  it("standard packages report the standard limits", () => {
    const l = effectiveRosterLimits(loadPackage({ name: "Plain", skillAllotment: {} }).pkg, "Human", bb2025)!;
    expect(l).toMatchObject({ format: "standard", maxPlayers: 16, maxNonLineman: null, nonLinemanPositions: [], veteran: null, staffPriced: false, inducementSet: "core" });
    expect(l.staff.reRolls).toEqual({ price: 50000, max: 8 });
    expect(l.skills.gold).toEqual({ primary: 20000, secondary: 40000, elitePrimary: 30000, eliteSecondary: 50000 });
    expect(effectiveRosterLimits(MATCHED, "Not A Race", bb2025)).toBeUndefined();
  });
});

describe("composer support for Sevens previews", () => {
  const humanXml =
    '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary><maxBigGuys>1</maxBigGuys>' +
    '<position id="1"><quantity>16</quantity><name>Human Lineman</name><type>Regular</type><gender>male</gender></position>' +
    '<position id="2"><quantity>2</quantity><name>Human Blitzer</name><type>Regular</type><gender>male</gender></position>' +
    '<position id="3"><quantity>2</quantity><name>Human Catcher</name><type>Regular</type><gender>male</gender></position>' +
    "</roster>";
  it("marks the Veteran (MA -1), prices staff and Sevens inducements, and validates clean", () => {
    const composed = composeTeam(
      {
        forkRosterXml: humanXml,
        coach: "Tester",
        teamName: "Sevens",
        picks: [{ positionId: "1", count: 1, veteran: true }, { positionId: "1", count: 3 }, { positionId: "2", count: 2 }, { positionId: "3", count: 1 }],
        reRolls: 1,
        apothecary: false,
        dedicatedFans: 0,
        staffPrices: effectiveStaffPrices(MATCHED)!,
        freeDedicatedFans: 0,
        inducementSet: "sevens",
        rosteredInducements: [{ key: "desperate_measures", count: 1 }],
      },
      bb2025,
    );
    expect(composed.roster.players[0]).toMatchObject({ veteran: true, MA: 5 });
    expect(composed.roster.players[1]!.veteran).toBeUndefined();
    expect(composed.roster.summary).toMatchObject({ sidelineCost: 100000, inducementCost: 50000 });
    expect(composed.xml).not.toContain("inducementSet");
    const r = validate(composed.roster, MATCHED, bb2025);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.recomputedSummary.goldUsed).toBe(595000);
  });
});

describe("Sol review fixes (2c869b5e)", () => {
  it("the format is resolved through the whole extends chain (Base -> Middle -> Leaf)", () => {
    const raws: Record<string, DeepPartial<TournamentPackage>> = { Base: shipped, Middle: { name: "Middle", extends: "Base", skillAllotment: {} } };
    const leaf = loadPackage({ name: "Leaf", extends: "Middle", skillAllotment: {} }, { resolveExtends: (n) => raws[n] });
    expect(leaf.pkg.format).toBe("sevens");
    expect(leaf.pkg.special).toMatchObject({ maxPlayers: 11, maxNonLineman: 4, veteran: true });
    expect(leaf.pkg.starPlayers.allowed).toBe(false);
    // The nearest explicit format wins, and a cycle ends the walk.
    expect(loadPackage({ name: "Leaf", extends: "Middle", format: "standard", skillAllotment: {} }, { resolveExtends: (n) => raws[n] }).pkg.format).toBe("standard");
    const loop: Record<string, DeepPartial<TournamentPackage>> = { A: { name: "A", extends: "B" }, B: { name: "B", extends: "A" } };
    expect(loadPackage({ name: "C", extends: "A", skillAllotment: {} }, { resolveExtends: (n) => loop[n] }).pkg.format).toBeUndefined();
  });

  it("a Sevens package can't switch to the core inducement list: stars and Mercenaries stay refused", () => {
    const { pkg: p, problems } = loadPackage({ ...shipped, inducements: { set: "core", allowed: ["*"], caps: {} } } as DeepPartial<TournamentPackage>);
    expect(p.inducements.set).toBe("sevens");
    expect(problems).toContain(`inducements.set "core" isn't available in Sevens (it would allow Star Players and Mercenaries); using the Sevens list.`);
    // Even a hand-built package object with the core set is checked against the Sevens list.
    const forced = { ...MATCHED, inducements: { ...MATCHED.inducements, set: "core" as const } };
    const merc = validate(team("Human", humanPicks(), { inducements: [{ id: "mercenaries", name: "Mercenary Players", count: 1, cost: 0 }] }), forced, bb2025);
    expect(messages(merc)).toContain("Mercenaries aren't available in Sevens.");
  });

  it("split inducement rows can't dodge a cap (Sevens and core lists)", () => {
    const rows = [{ name: "Bribes", count: 2, cost: 100000 }, { name: "Bribes", count: 2, cost: 100000 }];
    const sevens = validate(team("Human", humanPicks(), { reRolls: 0, sidelineCost: 0, inducements: rows }), { ...MATCHED, goldBudget: 2000000 }, bb2025);
    expect(messages(sevens)).toContain("4× Bribes; the Sevens limit is 2.");
    const standard = loadPackage({ name: "Plain", skillAllotment: {}, special: { minPlayers: 7 } }).pkg;
    const human = team("Human", humanPicks().map((p) => ({ ...p, veteran: false })), { inducements: rows });
    expect(messages(validate(human, standard, bb2025))).toContain("4× Bribes exceeds the limit of 3.");
  });

  it("a Veteran's +MA is still a stat increase: priced, and caught by a team cap of 0", () => {
    const humanXml =
      '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary><maxBigGuys>1</maxBigGuys>' +
      '<position id="1"><quantity>16</quantity><name>Human Lineman</name><type>Regular</type><gender>male</gender></position>' +
      '<position id="2"><quantity>2</quantity><name>Human Blitzer</name><type>Regular</type><gender>male</gender></position>' +
      "</roster>";
    const composed = composeTeam(
      {
        forkRosterXml: humanXml, coach: "T", teamName: "Vet", reRolls: 0, apothecary: false, dedicatedFans: 0,
        picks: [{ positionId: "1", count: 1, veteran: true, chosenStatIncreases: ["MA"] }, { positionId: "1", count: 4 }, { positionId: "2", count: 2 }],
        staffPrices: effectiveStaffPrices(MATCHED)!, freeDedicatedFans: 0, inducementSet: "sevens",
      },
      bb2025,
    );
    expect(composed.roster.players[0]).toMatchObject({ veteran: true, MA: 6 });
    const capped = { ...MATCHED, special: { ...MATCHED.special, statIncreasesAllowed: true, statIncreaseRules: { maxPerTeam: 0 } } };
    expect(messages(validate(composed.roster, capped, bb2025)).some((m) => m.startsWith("The team has 1 stat increases."))).toBe(true);
    const open = { ...MATCHED, special: { ...MATCHED.special, statIncreasesAllowed: true } };
    const priced = validate(composed.roster, open, bb2025);
    expect(priced.recomputedSummary.statIncreasesCost).toBe(20000);
    // Stat increases off: the +MA is refused outright.
    expect(messages(validate(composed.roster, MATCHED, bb2025)).some((m) => m.includes("characteristic increase (+MA)"))).toBe(true);
  });

  it("Dedicated Fans can't go below the format's start (Sevens Free Create 1; Matched Play 0)", () => {
    const league = loadPackage({ name: "Sevens Free Create", format: "sevens", skillAllotment: {}, sideline: { dedicatedFansStart: 1 } }).pkg;
    expect(messages(validate(team("Human", humanPicks(), { fans: 0 }), league, bb2025))).toContain("0 dedicated fans; this ruleset starts every team on 1 (free).");
    expect(messages(validate(team("Human", humanPicks(), { fans: 1 }), league, bb2025))).toEqual([]);
    expect(messages(validate(team("Human", humanPicks(), { fans: 0 }), MATCHED, bb2025))).toEqual([]);
    expect(effectiveRosterLimits(league, "Human", bb2025)!.staff.dedicatedFans).toMatchObject({ start: 1, min: 1 });
    expect(effectiveRosterLimits(MATCHED, "Human", bb2025)!.staff.dedicatedFans).toMatchObject({ start: 0, min: 0 });
  });
});
