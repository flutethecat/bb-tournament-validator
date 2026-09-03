import { describe, expect, it } from "vitest";
import { loadPackage, validate, type Dataset } from "@bb/validator";
import { fakeData, pkg, player, roster } from "./helpers";

const errorsOf = (result: ReturnType<typeof validate>) =>
  result.errors.filter((finding) => finding.ruleId === "inducements");

const dataWithStarSkills = (skills: string[]): Dataset => ({
  ...fakeData,
  stars: fakeData.stars.map((star) =>
    star.name === "Star Guy" ? { ...star, skills } : star,
  ),
});

const rosterWithStarAndBribes = () => {
  const players = roster().players;
  players[10] = player({ number: 11, positionName: "Star Guy", cost: 200000 });
  return roster({
    players,
    inducements: [{ id: "bribes", name: "Bribes", count: 3, cost: 100000 }],
  });
};

const tournament = (baseCap = 3, overrideCap = 2) => pkg({
  inducements: {
    allowed: ["bribes"],
    caps: { bribes: baseCap },
    capOverrides: [{
      when: { starHasSkill: "Secret Weapon" },
      caps: { bribes: overrideCap },
    }],
  },
});

describe("conditional inducement cap overrides", () => {
  it("lowers the Bribes cap when a rostered star has Secret Weapon", () => {
    const findings = errorsOf(validate(
      rosterWithStarAndBribes(),
      tournament(),
      dataWithStarSkills(["Secret Weapon"]),
    ));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe(
      "3× Bribes; the limit is 2 while a Secret Weapon star is rostered (Star Guy).",
    );
  });

  it("does not lower the cap for a non-Secret Weapon star", () => {
    expect(errorsOf(validate(
      rosterWithStarAndBribes(),
      tournament(),
      dataWithStarSkills(["Block"]),
    ))).toHaveLength(0);
  });

  it("never raises the base cap", () => {
    const findings = errorsOf(validate(
      rosterWithStarAndBribes(),
      tournament(2, 6),
      dataWithStarSkills(["Secret Weapon"]),
    ));

    expect(findings).toHaveLength(1);
    expect(findings[0]!.message).toBe("3× Bribes exceeds the limit of 2.");
  });

  it("reports empty conditions and negative caps as load problems", () => {
    const { problems } = loadPackage({
      name: "Bad overrides",
      inducements: {
        capOverrides: [{ when: { starHasSkill: " " }, caps: { bribes: -1 } }],
      },
    });

    expect(problems).toEqual([
      "inducements.capOverrides[0].when.starHasSkill must not be empty",
      "inducements.capOverrides[0].caps.bribes must be non-negative",
    ]);
  });
});
