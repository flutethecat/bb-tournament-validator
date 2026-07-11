import { describe, expect, it } from "vitest";
import { validate, type TournamentPackage } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (r: ReturnType<typeof validate>, id: string) => r.errors.filter((f) => f.ruleId === id);

/** A Spike!-style package: Testers in Tier 1 with choose-one gold+SP packages. */
function spikePkg(
  over: Partial<TournamentPackage> = {},
  packs?: { gold: number; skillPointBudget: number; maxPerPlayer?: number; starPlayersAllowed?: boolean }[],
) {
  return pkg({
    goldBudget: null,
    tiers: [
      {
        tier: 1,
        rosters: ["Testers"],
        gold: 1000000,
        skillPointBudget: 6,
        starPlayersAllowed: true,
        bannedStars: [],
        skillPackages: packs ?? [
          { gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1 },
          { gold: 970000, skillPointBudget: 7, maxPerPlayer: 1 },
        ],
      },
    ],
    ...over,
  });
}

describe("skill-packages (choose-one gold+SP)", () => {
  it("passes when the roster fits a package", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block"] }); // 1 primary elite = 2 SP; 550k gold
    const r = validate(roster({ players }), spikePkg(), fakeData);
    expect(errorsOf(r, "skill-packages")).toHaveLength(0);
    expect(errorsOf(r, "skill-points")).toHaveLength(0); // budget check delegated
    expect(errorsOf(r, "gold-budget")).toHaveLength(0); // gold check delegated
  });

  it("fails when SP exceeds every package", () => {
    const players = roster().players;
    // 4 players x Block (elite primary = 2 SP) = 8 SP; both packs cap at 6/7.
    for (let i = 0; i < 4; i++) players[i] = player({ number: i + 1, skills: ["Block"] });
    const r = validate(roster({ players }), spikePkg(), fakeData);
    const f = errorsOf(r, "skill-packages");
    expect(f).toHaveLength(1);
    expect(f[0]!.message).toMatch(/no skill package fits/);
  });

  it("counts star SP against the package and excludes star gold when paid in SP", () => {
    const players = roster().players.slice(0, 10);
    players.push(player({ number: 11, positionName: "Star Guy", cost: 200000 }));
    const base = {
      allowed: true,
      maxCount: 2,
      maxCombinedCost: null,
      paidInSkillPoints: true,
      spCostByTier: { "Star Guy": [3] },
    };
    // Package SP budget 3: star costs exactly 3 SP -> fits (skill SP 0).
    const okPkg = spikePkg({ starPlayers: base }, [{ gold: 1000000, skillPointBudget: 3, maxPerPlayer: 1 }]);
    expect(errorsOf(validate(roster({ players }), okPkg, fakeData), "skill-packages")).toHaveLength(0);
    // Package SP budget 2: the 3-SP star no longer fits.
    const tightPkg = spikePkg({ starPlayers: base }, [{ gold: 1000000, skillPointBudget: 2, maxPerPlayer: 1 }]);
    expect(errorsOf(validate(roster({ players }), tightPkg, fakeData), "skill-packages")[0]!.message).toMatch(/no skill package fits/);
  });

  it("flags a star not available in the team's tier", () => {
    const players = roster().players.slice(0, 10);
    players.push(player({ number: 11, positionName: "Star Guy", cost: 200000 }));
    const p = spikePkg({
      starPlayers: { allowed: true, maxCount: 2, maxCombinedCost: null, paidInSkillPoints: true, spCostByTier: { "Star Guy": [null] } },
    });
    const f = errorsOf(validate(roster({ players }), p, fakeData), "skill-packages");
    expect(f.some((x) => /not available in Tier 1/.test(x.message))).toBe(true);
  });

  it("excludes SP-paid skill cost from the gold budget", () => {
    const players = roster().players; // 11 x 50k = 550k build gold
    // The sheet's summary bundles 500k of skills-gold; without exclusion gold would be 1050k.
    const ro = roster({
      players,
      summary: { playersCost: 550000, skillsCost: 500000, inducementCost: 0, sidelineCost: 0, total: 1050000 },
    });
    const r = validate(ro, spikePkg({}, [{ gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1 }]), fakeData);
    expect(errorsOf(r, "skill-packages")).toHaveLength(0); // 550k build fits; skills are SP, not gold
  });

  it("enforces per-package maxPerPlayer (stacking)", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] }); // 2 skills on one player
    // Only a maxPerPlayer:1 package available -> stacking illegal even though SP fits.
    const r = validate(roster({ players }), spikePkg({}, [{ gold: 1000000, skillPointBudget: 10, maxPerPlayer: 1 }]), fakeData);
    expect(errorsOf(r, "skill-packages")[0]!.message).toMatch(/no skill package fits/);
  });
});

describe("skill-packages: global (package-level) vs tier-unique", () => {
  it("GLOBAL packages apply to a tier that has none of its own", () => {
    const players = roster().players;
    for (let i = 0; i < 4; i++) players[i] = player({ number: i + 1, skills: ["Block"] }); // 8 SP
    // Tier has no skillPackages; the global set caps at 6 -> 8 SP fails against the global.
    const p = pkg({
      goldBudget: null,
      skillPackages: [{ gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1 }],
      tiers: [{ tier: 1, rosters: ["Testers"], gold: 1000000, starPlayersAllowed: true, bannedStars: [] }],
    });
    expect(errorsOf(validate(roster({ players }), p, fakeData), "skill-packages")[0]!.message).toMatch(/no skill package fits/);
  });

  it("a TIER's own packages OVERRIDE the global set for that tier", () => {
    const players = roster().players;
    for (let i = 0; i < 4; i++) players[i] = player({ number: i + 1, skills: ["Block"] }); // 8 SP
    // Global caps at 6 (would fail), but the tier overrides with an 8-SP pack -> passes.
    const p = pkg({
      goldBudget: null,
      skillPackages: [{ gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1 }],
      tiers: [
        {
          tier: 1,
          rosters: ["Testers"],
          gold: 1000000,
          starPlayersAllowed: true,
          bannedStars: [],
          skillPackages: [{ gold: 1000000, skillPointBudget: 8, maxPerPlayer: 1 }],
        },
      ],
    });
    expect(errorsOf(validate(roster({ players }), p, fakeData), "skill-packages")).toHaveLength(0);
  });
});

describe("skill-packages: per-package star access lever", () => {
  const starBase = { allowed: true, maxCount: 2, maxCombinedCost: null, paidInSkillPoints: true, spCostByTier: { "Star Guy": [0] } };
  const withStar = () => {
    const players = roster().players.slice(0, 10);
    players.push(player({ number: 11, positionName: "Star Guy", cost: 200000 }));
    return roster({ players });
  };

  it("a roster WITH a star fails when the only fitting package forbids stars", () => {
    const p = spikePkg({ starPlayers: starBase }, [{ gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1, starPlayersAllowed: false }]);
    expect(errorsOf(validate(withStar(), p, fakeData), "skill-packages")[0]!.message).toMatch(/no skill package fits/);
  });

  it("the same roster passes when a star-allowing package fits", () => {
    const p = spikePkg({ starPlayers: starBase }, [
      { gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1, starPlayersAllowed: false },
      { gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1, starPlayersAllowed: true },
    ]);
    expect(errorsOf(validate(withStar(), p, fakeData), "skill-packages")).toHaveLength(0);
  });

  it("a star-free roster is unaffected by a no-stars package", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block"] }); // 2 SP, no star
    const p = spikePkg({}, [{ gold: 1000000, skillPointBudget: 6, maxPerPlayer: 1, starPlayersAllowed: false }]);
    expect(errorsOf(validate(roster({ players }), p, fakeData), "skill-packages")).toHaveLength(0);
  });
});
