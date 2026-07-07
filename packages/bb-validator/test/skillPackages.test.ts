import { describe, expect, it } from "vitest";
import { validate, type TournamentPackage } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (r: ReturnType<typeof validate>, id: string) => r.errors.filter((f) => f.ruleId === id);

/** A Spike!-style package: Testers in Tier 1 with choose-one gold+SP packages. */
function spikePkg(over: Partial<TournamentPackage> = {}, packs?: { gold: number; skillPointBudget: number; maxPerPlayer?: number }[]) {
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

  it("enforces per-package maxPerPlayer (stacking)", () => {
    const players = roster().players;
    players[0] = player({ number: 1, skills: ["Block", "Tackle"] }); // 2 skills on one player
    // Only a maxPerPlayer:1 package available -> stacking illegal even though SP fits.
    const r = validate(roster({ players }), spikePkg({}, [{ gold: 1000000, skillPointBudget: 10, maxPerPlayer: 1 }]), fakeData);
    expect(errorsOf(r, "skill-packages")[0]!.message).toMatch(/no skill package fits/);
  });
});
