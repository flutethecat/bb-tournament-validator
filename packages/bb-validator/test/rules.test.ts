import { describe, expect, it } from "vitest";
import { validate } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (r: ReturnType<typeof validate>, ruleId: string) =>
  r.errors.filter((f) => f.ruleId === ruleId);

describe("roster-eligibility", () => {
  it("rejects a race not in eligibleRosters, with a suggestion", () => {
    const r = validate(roster(), pkg({ eligibleRosters: ["Amazon"] }), fakeData);
    const f = errorsOf(r, "roster-eligibility");
    expect(f).toHaveLength(1);
    expect(f[0]!.suggestion).toMatch(/Amazon/);
  });

  it("accepts '*' wildcard", () => {
    const r = validate(roster(), pkg({ eligibleRosters: ["*"] }), fakeData);
    expect(errorsOf(r, "roster-eligibility")).toHaveLength(0);
  });
});

describe("squad-size", () => {
  it("flags fewer than minPlayers", () => {
    const r = validate(
      roster({ players: Array.from({ length: 9 }, (_, i) => player({ number: i + 1 })) }),
      pkg(),
      fakeData,
    );
    expect(errorsOf(r, "squad-size")[0]!.message).toMatch(/9 players.*at least 11/);
  });

  it("flags more than 16", () => {
    const r = validate(
      roster({ players: Array.from({ length: 17 }, (_, i) => player({ number: i + 1 })) }),
      pkg(),
      fakeData,
    );
    expect(errorsOf(r, "squad-size")[0]!.message).toMatch(/maximum roster size is 16/);
  });
});

describe("positional-limits", () => {
  it("flags too many of a position (big guys over 0-2)", () => {
    const players = [
      ...Array.from({ length: 8 }, (_, i) => player({ number: i + 1 })),
      player({ number: 9, positionName: "Bruiser", skills: ["Loner"], cost: 140000 }),
      player({ number: 10, positionName: "Bruiser", skills: ["Loner"], cost: 140000 }),
      player({ number: 11, positionName: "Bruiser", skills: ["Loner"], cost: 140000 }),
    ];
    const r = validate(roster({ players }), pkg(), fakeData);
    const f = errorsOf(r, "positional-limits");
    expect(f.some((x) => /3× Bruiser exceeds the 0-2/.test(x.message))).toBe(true);
    // 3 bigguys also over maxBigGuys=1
    expect(f.some((x) => /Big Guys exceeds/.test(x.message))).toBe(true);
  });

  it("flags unknown position names", () => {
    const players = [
      ...Array.from({ length: 10 }, (_, i) => player({ number: i + 1 })),
      player({ number: 11, positionName: "Ninja" }),
    ];
    const r = validate(roster({ players }), pkg(), fakeData);
    expect(errorsOf(r, "positional-limits")[0]!.message).toMatch(/"Ninja" is not a position/);
  });
});

describe("gold-budget", () => {
  it("skipped when goldBudget is null", () => {
    const r = validate(roster(), pkg({ goldBudget: null }), fakeData);
    expect(errorsOf(r, "gold-budget")).toHaveLength(0);
  });

  it("flags overage when set (11 x 50k = 550k > 500k)", () => {
    const r = validate(roster(), pkg({ goldBudget: 500000 }), fakeData);
    expect(errorsOf(r, "gold-budget")[0]!.message).toMatch(/550k.*500k/);
  });

  // Meero option (c): goldCapIncludesAddedSkills strips recomputeGold's skill portion and re-prices
  // by the flat model. 11x50k players + 100k printed skill cost = 650k.
  const withSkillCost = roster({
    summary: { playersCost: 550000, skillsCost: 100000, inducementCost: 0, sidelineCost: 0, total: 650000 },
  });

  it("default: added-skill gold does NOT eat the cap (650k > 600k flags)", () => {
    const r = validate(withSkillCost, pkg({ goldBudget: 600000 }), fakeData);
    expect(errorsOf(r, "gold-budget")).toHaveLength(1);
  });

  it("hard gold limit strips the counted skill gold, no double-count (650k − 100k + 0 = 550k ≤ 600k)", () => {
    const r = validate(withSkillCost, pkg({ goldBudget: 600000, goldCapIncludesAddedSkills: true }), fakeData);
    expect(errorsOf(r, "gold-budget")).toHaveLength(0);
  });
});

describe("skill-access", () => {
  it("flags a skill with no access for the position (Mutation on a Lineman)", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Horns"] });
    const r = validate(roster({ players }), pkg(), fakeData);
    const f = errorsOf(r, "skill-access")[0]!;
    expect(f.message).toMatch(/Horns \(Mutation\) is neither primary nor secondary/);
    expect(f.playerRef).toBe(1);
  });

  it("flags traits taken as skills", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Insignificant"] });
    const r = validate(roster({ players }), pkg(), fakeData);
    expect(errorsOf(r, "skill-access")[0]!.message).toMatch(/Trait/);
  });

  it("flags unknown skill names loudly", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Awesome Sauce"] });
    const r = validate(roster({ players }), pkg(), fakeData);
    expect(errorsOf(r, "skill-access")[0]!.message).toMatch(/not a known BB2025 skill/);
  });
});

describe("skill-points", () => {
  it("prices primary vs secondary correctly and flags over-budget with suggestion", () => {
    // Block primary (2 SP elite) x2, Dodge secondary on Lineman (2x1+1=3 SP) => 7 > 6
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block"] });
    players[1] = player({ number: 2, skills: ["Block"] });
    players[2] = player({ number: 3, skills: ["Dodge"] });
    const r = validate(roster({ players }), pkg(), fakeData);
    const f = errorsOf(r, "skill-points")[0]!;
    expect(f.message).toMatch(/7 Skill Points.*budget is 6.*1 over/);
    expect(f.suggestion).toMatch(/raise the budget to 7/);
    expect(r.recomputedSummary.skillPointsUsed).toBe(7);
    expect(r.recomputedSummary.primarySkillCount).toBe(2);
    expect(r.recomputedSummary.secondarySkillCount).toBe(1);
  });

  it("enforces maxPerPlayer", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block", "Wrestle", "Tackle"] });
    const r = validate(
      roster({ players }),
      pkg({ skillAllotment: { ...pkg().skillAllotment, skillPointBudget: 20 } }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")[0]!.message).toMatch(/3 added skills.*limit is 2/);
  });

  it("enforces skill stacking (max players with >1 added skill)", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] });
    players[1] = player({ number: 2, skills: ["Block", "Wrestle"] });
    const r = validate(
      roster({ players }),
      pkg({ skillAllotment: { ...pkg().skillAllotment, skillPointBudget: 20, maxStackedPlayers: 1 } }),
      fakeData,
    );
    const f = errorsOf(r, "skill-points").find((x) => /skill stacking/.test(x.message));
    expect(f).toBeDefined();
    expect(f!.message).toMatch(/2 players have more than one added skill.*at most 1/);
  });

  it("allows stacking up to the cap", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] });
    players[1] = player({ number: 2, skills: ["Block", "Wrestle"] });
    const r = validate(
      roster({ players }),
      pkg({ skillAllotment: { ...pkg().skillAllotment, skillPointBudget: 20, maxStackedPlayers: 2 } }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points").some((x) => /skill stacking/.test(x.message))).toBe(false);
  });

  it("enforces maxSameSkillTeamwide", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle"] });
    players[1] = player({ number: 2, skills: ["Wrestle"] });
    const base = pkg().skillAllotment;
    const r = validate(
      roster({ players }),
      pkg({ skillAllotment: { ...base, skillPointBudget: 20, maxSameSkillTeamwide: 1 } }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")[0]!.message).toMatch(/2× wrestle.*limit is 1/);
  });

  it("flags duplicate skill on one player", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Wrestle", "Wrestle"] });
    const r = validate(roster({ players }), pkg(), fakeData);
    expect(errorsOf(r, "skill-points").some((f) => /twice/.test(f.message))).toBe(true);
  });
});

describe("star-players", () => {
  const withStar = () => {
    const players = roster().players;
    players[10] = player({ number: 11, positionName: "Star Guy", cost: 200000 });
    return roster({ players });
  };

  it("flags stars when not allowed", () => {
    const r = validate(
      withStar(),
      pkg({ starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null } }),
      fakeData,
    );
    expect(errorsOf(r, "star-players")[0]!.message).toMatch(/not allowed/);
  });

  it("enforces maxCombinedCost", () => {
    const r = validate(
      withStar(),
      pkg({ starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: 150000 } }),
      fakeData,
    );
    expect(errorsOf(r, "star-players")[0]!.message).toMatch(/200k combined.*150k/);
  });

  const withNamedStar = (name: string, cost = 100000) => {
    const players = roster().players;
    players[10] = player({ number: 11, positionName: name, cost });
    return roster({ players });
  };

  it("accepts a star eligible for the team", () => {
    const r = validate(withStar(), pkg(), fakeData);
    expect(errorsOf(r, "star-players")).toHaveLength(0);
  });

  it("flags a star not eligible for the team", () => {
    const r = validate(withNamedStar("Weakling Star"), pkg(), fakeData);
    const f = errorsOf(r, "star-players");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/cannot play for Testers/);
    expect(f[0]!.expected).toMatch(/Weaklings/);
  });

  it("skips eligibility when a star has no team data", () => {
    const r = validate(withNamedStar("Free Agent", 0), pkg(), fakeData);
    expect(errorsOf(r, "star-players")).toHaveLength(0);
  });

  it("does not report eligibility when stars are disallowed entirely", () => {
    const r = validate(
      withNamedStar("Weakling Star"),
      pkg({ starPlayers: { allowed: false, maxCount: 0, maxCombinedCost: null } }),
      fakeData,
    );
    const f = errorsOf(r, "star-players");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/not allowed/);
  });
});

describe("inducements", () => {
  it("flags disallowed inducements and over-cap counts", () => {
    const r = validate(
      roster({ inducements: [{ id: "bribes", name: "Bribes", count: 4, cost: 100000 }] }),
      pkg({ inducements: { allowed: [], caps: {} } }),
      fakeData,
    );
    expect(errorsOf(r, "inducements").some((f) => /not allowed/.test(f.message))).toBe(true);
    // cap from dataset (max 3)
    expect(errorsOf(r, "inducements").some((f) => /4× Bribes exceeds the limit of 3/.test(f.message))).toBe(true);
  });

  it("raises the cap under a reduced-cost special rule", () => {
    // 4 Bribes: over the base 3, but Bribery and Corruption raises the cap to 6.
    const r = validate(
      roster({ specialRules: ["Bribery and Corruption"], inducements: [{ id: "bribes", name: "Bribes", count: 4 }] }),
      pkg(),
      fakeData,
    );
    expect(errorsOf(r, "inducements")).toHaveLength(0);
  });

  it("still enforces the reduced cap ceiling", () => {
    const r = validate(
      roster({ specialRules: ["Bribery and Corruption"], inducements: [{ id: "bribes", name: "Bribes", count: 7 }] }),
      pkg(),
      fakeData,
    );
    expect(errorsOf(r, "inducements").some((f) => /7× Bribes exceeds the limit of 6/.test(f.message))).toBe(true);
  });
});

describe("recomputeGold inducement fallback", () => {
  it("counts inducement gold from the summary when line items carry no cost", () => {
    // bbtc.pl lists inducement NAMES without per-item costs; the sheet total must still count.
    const ro = roster({
      inducements: [{ name: "Halfling Master Chef" }],
      summary: { playersCost: 550000, skillsCost: 0, inducementCost: 300000, sidelineCost: 0, total: 850000 },
    });
    const r = validate(ro, pkg(), fakeData);
    expect(r.recomputedSummary.goldUsed).toBe(850000); // 550k players + 300k inducements
  });
});

describe("sideline", () => {
  it("flags package caps and roster maxima", () => {
    const r = validate(
      roster({
        sideline: { apothecary: true, assistantCoaches: 0, cheerleaders: 9, dedicatedFans: 0, reRolls: 7 },
      }),
      pkg({ sideline: { ...pkg().sideline, maxCheerleaders: 4 } }),
      fakeData,
    );
    const msgs = errorsOf(r, "sideline").map((f) => f.message);
    expect(msgs.some((m) => /9 cheerleaders.*limit of 4/.test(m))).toBe(true);
    expect(msgs.some((m) => /7 re-rolls exceeds the Testers roster maximum of 6/.test(m))).toBe(true);
    expect(msgs.some((m) => /cannot take an Apothecary/.test(m))).toBe(true);
  });
});

describe("special-rules", () => {
  it("flags banned skills", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block"] });
    const r = validate(
      roster({ players }),
      pkg({ special: { ...pkg().special, bannedSkills: ["Block"] } }),
      fakeData,
    );
    expect(errorsOf(r, "special-rules")[0]!.message).toMatch(/Block is banned/);
  });

  it("flags Insignificant players outnumbering the rest", () => {
    const players = [
      ...Array.from({ length: 6 }, (_, i) =>
        player({ number: i + 1, skills: ["Insignificant"] }),
      ),
      ...Array.from({ length: 5 }, (_, i) => player({ number: i + 7 })),
    ];
    const r = validate(roster({ players }), pkg(), fakeData);
    expect(errorsOf(r, "special-rules").some((f) => /Insignificant/.test(f.message))).toBe(true);
  });
});

describe("unknown race (M1 graceful fail)", () => {
  it("errors clearly instead of validating misleadingly", () => {
    const r = validate(roster({ rosterName: "Orc" }), pkg({ eligibleRosters: ["*"] }), fakeData);
    expect(r.valid).toBe(false);
    expect(r.errors.some((f) => f.ruleId === "dataset" && /not in the BB2025 dataset/.test(f.message))).toBe(true);
  });
});
