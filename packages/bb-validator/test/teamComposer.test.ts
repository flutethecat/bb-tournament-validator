import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeTeam, parseForkRoster, mintTeamId, validate } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { pkg } from "./helpers";

const snotlingXml = readFileSync(
  fileURLToPath(new URL("./fixtures/roster_snotling.xml", import.meta.url)),
  "utf8",
);

describe("parseForkRoster", () => {
  it("reads the fork rosterId, race, and reroll/apothecary header", () => {
    const r = parseForkRoster(snotlingXml);
    expect(r.rosterId).toBe("snotling.bb2025");
    expect(r.raceName).toBe("Snotling");
    expect(r.reRollCost).toBe(70000);
    expect(r.maxReRolls).toBe(8);
    expect(r.apothecaryAllowed).toBe(true);
  });

  it("keeps base positions with their NUMERIC positionId and excludes Stars", () => {
    const r = parseForkRoster(snotlingXml);
    const lineman = r.positions.find((p) => p.name === "Snotling Lineman");
    expect(lineman?.positionId).toBe("66199"); // numeric FUMBBL id, not the dataset slug
    // Grak / Crumbleberry / Morg / Akhorne are Stars → dropped in V1.
    expect(r.positions.some((p) => /grak|crumbleberry|morg|akhorne/i.test(p.name))).toBe(false);
    expect(r.positions.every((p) => !/star/i.test(p.type))).toBe(true);
  });
});

describe("mintTeamId", () => {
  it("is a string in the reserved tb_ namespace (never collides with numeric FUMBBL ids)", () => {
    const id = mintTeamId("Kalimar", "Snotling", 1_000_000);
    expect(id).toMatch(/^tb_kalimar_snotling_[0-9a-z]+$/);
    expect(Number.isNaN(Number(id))).toBe(true); // not a bare number → no collision with FUMBBL ids
  });
});

describe("composeTeam", () => {
  const input = {
    forkRosterXml: snotlingXml,
    coach: "Kalimar",
    teamName: "Kalimar's Snotling",
    reRolls: 3,
    apothecary: true,
    dedicatedFans: 1,
    // 6 linemen + 2 fun-hoppas + 2 trained trolls + 1 fungus flinga = 11
    picks: [
      { positionId: "66199", count: 6 }, // Snotling Lineman
      { positionId: "66201", count: 2 }, // Fun-hoppa
      { positionId: "66204", count: 2 }, // Trained Troll
      { positionId: "66200", count: 1 }, // Fungus Flinga
    ],
  };

  it("builds 11 players and mints a tb_ team id", () => {
    const r = composeTeam(input, bb2025, 42);
    expect(r.teamId).toBe("tb_kalimar_snotling_16");
    expect(r.roster.players).toHaveLength(11);
    expect(r.roster.rosterName).toBe("Snotling");
    expect(r.roster.coach).toBe("Kalimar");
    expect(r.roster.sideline.reRolls).toBe(3);
  });

  it("emits only positionIds that exist in the fork roster (round-trip integrity)", () => {
    const r = composeTeam(input, bb2025, 42);
    const forkIds = new Set(parseForkRoster(snotlingXml).positions.map((p) => p.positionId));
    const emitted = [...r.xml.matchAll(/<positionId>(\d+)<\/positionId>/g)].map((m) => m[1]!);
    expect(emitted).toHaveLength(11);
    expect(emitted.every((id) => forkIds.has(id))).toBe(true);
    // Team-level XML: fork rosterId + coach + player ids namespaced under the team id.
    expect(r.xml).toContain("<rosterId>snotling.bb2025</rosterId>");
    expect(r.xml).toContain("<coach>Kalimar</coach>");
    expect(r.xml).toContain(`id="${r.teamId}1"`);
  });

  it("produces a Roster the validator resolves (positions + race known to the dataset)", () => {
    const r = composeTeam(input, bb2025, 42);
    const result = validate(r.roster, pkg({ eligibleRosters: ["Snotling"], goldBudget: null }), bb2025);
    // No dataset-resolution failures: the composed race + every position are recognised.
    expect([...result.errors, ...result.warnings].some((f) => f.ruleId === "dataset")).toBe(false);
    expect(r.roster.players.every((p) => p.positionName.length > 0)).toBe(true);
  });

  it("rejects a pick whose positionId is not in the roster (or is a Star)", () => {
    expect(() => composeTeam({ ...input, picks: [{ positionId: "99999", count: 1 }] }, bb2025, 42)).toThrow(
      /not in the Snotling roster/,
    );
  });
});
