import { describe, expect, it } from "vitest";
import {
  fitsSkillCounts,
  parseGold,
  resolveTeamConfig,
  validate,
  type Matrix,
  type TournamentPackage,
} from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (r: ReturnType<typeof validate>, id: string) => r.errors.filter((f) => f.ruleId === id);

// helper: roster with N primary-access + M secondary-access added skills on Testers.
// Testers Lineman: primary [General], secondary [Agility]. Block=General(primary,elite),
// Wrestle=General(primary), Dodge=Agility(secondary,elite), Side Step=Agility(secondary).
function rosterWithSkills(primary: string[], secondary: string[]) {
  const players = roster({ rosterName: "Testers" }).players;
  primary.forEach((s, i) => (players[i] = player({ number: i + 1, skills: [s] })));
  secondary.forEach((s, i) => (players[primary.length + i] = player({ number: primary.length + i + 1, skills: [s] })));
  return roster({ rosterName: "Testers", players });
}

describe("parseGold (bbtc notation)", () => {
  it("parses bare thousands, millions, and k", () => {
    expect(parseGold("1150")).toBe(1_150_000);
    expect(parseGold("1.15M")).toBe(1_150_000);
    expect(parseGold("1150k")).toBe(1_150_000);
    expect(parseGold("1.15m")).toBe(1_150_000);
    expect(parseGold("1150000")).toBe(1_150_000);
    expect(parseGold("")).toBeNull();
    expect(parseGold("abc")).toBeNull();
  });
});

describe("fitsSkillCounts", () => {
  it("plain counts: primary and secondary within limits", () => {
    expect(fitsSkillCounts(6, 0, 6, 0, false)).toBe(true);
    expect(fitsSkillCounts(7, 0, 6, 0, false)).toBe(false);
  });
  it("secondary slot may hold a primary skill (general downgrade)", () => {
    // 8 primary used, allotment 6 primary + 2 secondary -> primary can borrow the 2 secondary slots
    expect(fitsSkillCounts(8, 0, 6, 2, false)).toBe(true);
    expect(fitsSkillCounts(9, 0, 6, 2, false)).toBe(false);
  });
  it("secondary swap: two primary slots buy one secondary skill", () => {
    // allotment 8 primary + 0 secondary, want 1 secondary -> swap uses 2 primary
    expect(fitsSkillCounts(6, 1, 8, 0, true)).toBe(true); // 2 primary spent on the secondary, 6 left for 6 primary
    expect(fitsSkillCounts(7, 1, 8, 0, true)).toBe(false); // 8 - 2 = 6 primary slots < 7
    expect(fitsSkillCounts(6, 1, 8, 0, false)).toBe(false); // no swap allowed
  });
});

describe("count-mode validation (team rule)", () => {
  it("passes 6 primary within a 6-primary allotment", () => {
    const r = validate(
      rosterWithSkills(["Block", "Wrestle", "Tackle", "Block", "Wrestle", "Tackle"], []),
      pkg({ teamRules: [{ team: "Testers", maxPrimary: 6, maxSecondary: 0 }] }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")).toHaveLength(0);
  });

  it("fails 7 primary against 6-primary, with a primary/secondary message", () => {
    const r = validate(
      rosterWithSkills(["Block", "Wrestle", "Tackle", "Block", "Wrestle", "Tackle", "Block"], []),
      pkg({ teamRules: [{ team: "Testers", maxPrimary: 6, maxSecondary: 0 }] }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")[0]!.message).toMatch(/7 primary \+ 0 secondary.*6 primary/);
  });

  it("counts secondary-access skills separately", () => {
    // 1 secondary (Side Step=Agility) vs allotment 8 primary + 0 secondary, no swap -> fail
    const r = validate(
      rosterWithSkills([], ["Side Step"]),
      pkg({ teamRules: [{ team: "Testers", maxPrimary: 8, maxSecondary: 0, secondarySwap: false }] }),
      fakeData,
    );
    // 1 secondary skill can downgrade? No: downgrade is secondary-SLOT holding primary-skill, not the reverse.
    expect(errorsOf(r, "skill-points")[0]!.message).toMatch(/0 primary \+ 1 secondary/);
  });
});

describe("matrix resolution", () => {
  const matrix: Matrix = {
    columns: [{ gold: 1_110_000 }, { gold: 1_150_000 }],
    rows: [
      { label: "6 Primary", primary: 6, secondary: 0, secondarySwap: false },
      { label: "8 Primary", primary: 8, secondary: 0, secondarySwap: true },
    ],
    cells: [
      { col: 0, row: 0, teams: ["Testers"] },
      { col: 1, row: 1, teams: ["Weaklings"] },
    ],
  };

  it("a team's cell sets its gold + skill counts", () => {
    const p = pkg({ matrix });
    const t = resolveTeamConfig(p, "Testers");
    expect(t.gold).toBe(1_110_000);
    expect(t.maxPrimary).toBe(6);
    expect(t.source).toBe("matrix");
    const w = resolveTeamConfig(p, "Weaklings");
    expect(w.gold).toBe(1_150_000);
    expect(w.maxPrimary).toBe(8);
    expect(w.secondarySwap).toBe(true);
  });

  it("validates against the cell's gold + counts", () => {
    // Testers cell: 1110k gold, 6 primary. 11x50k = 550k ok; 7 primary -> fail
    const r = validate(
      rosterWithSkills(["Block", "Wrestle", "Tackle", "Block", "Wrestle", "Tackle", "Block"], []),
      pkg({ matrix }),
      fakeData,
    );
    expect(errorsOf(r, "skill-points")[0]!.message).toMatch(/7 primary.*\(matrix\)/);
  });

  it("a team not in the matrix is ineligible", () => {
    const r = validate(roster({ rosterName: "Amazon" }), pkg({ matrix }), fakeData);
    expect(errorsOf(r, "roster-eligibility")).toHaveLength(1);
  });
});

describe("global banned stars + inheritance", () => {
  const withStar = (star: string) => {
    const players = roster({ rosterName: "Testers" }).players;
    players[10] = player({ number: 11, positionName: star, cost: 200000 });
    return roster({ rosterName: "Testers", players });
  };

  it("a globally banned star is flagged for any team", () => {
    const r = validate(withStar("Star Guy"), pkg({ bannedStars: ["Star Guy"] }), fakeData);
    expect(errorsOf(r, "star-players").some((f) => /Star Guy is banned/.test(f.message))).toBe(true);
  });

  it("global bans union with team-rule bans", () => {
    const cfg = resolveTeamConfig(
      pkg({ bannedStars: ["Star Guy"], teamRules: [{ team: "Testers", bannedStars: ["Morg 'n' Thorg"] }] }),
      "Testers",
    );
    expect(cfg.bannedStars).toEqual(expect.arrayContaining(["Star Guy", "Morg 'n' Thorg"]));
  });
});

describe("team-rule precedence over tier", () => {
  it("team rule gold overrides the tier gold", () => {
    const p = pkg({
      tiers: [{ tier: 1, rosters: ["Testers"], gold: 1_000_000, starPlayersAllowed: true, bannedStars: [] }],
      teamRules: [{ team: "Testers", gold: 1_200_000 }],
    }) as TournamentPackage;
    const cfg = resolveTeamConfig(p, "Testers");
    expect(cfg.gold).toBe(1_200_000);
    expect(cfg.source).toBe("team");
  });
});
