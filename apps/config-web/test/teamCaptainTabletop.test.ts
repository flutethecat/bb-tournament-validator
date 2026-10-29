import { describe, expect, it } from "vitest";
import { saveCaptainError, teamFileFromSave } from "../src/tabletop/teamFile.js";
import type { TeamBuilderSave } from "../src/teamBuilderSaves.js";

// BB2025 Team Captain (https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): review regressions.
const save = (rosterId: string, picks: unknown[]): TeamBuilderSave =>
  ({ id: "sv_c", name: "Caps", rosterId, raceName: "", packageName: null, teamId: null, updatedAt: "", createdAt: "", body: { rosterId, picks } }) as TeamBuilderSave;

describe("Team Captain: tabletop baselines validate the nomination (saveCaptainError)", () => {
  const forkInfo = (types: Record<string, { type: string; isStar?: boolean }>) => (id: string) => types[id];

  it("admits one count-1 captain on an eligible roster", () => {
    expect(saveCaptainError(save("human", [{ positionId: "human.human_blitzer", count: 1, captain: true }, { positionId: "human.human_lineman", count: 10 }]))).toBeUndefined();
    // Numeric fork ids resolve through the host's fork roster lookup.
    expect(saveCaptainError(save("human", [{ positionId: "66268", count: 1, captain: true }]), forkInfo({ "66268": { type: "blitzer" } }))).toBeUndefined();
  });

  it("refuses a multi-player captain pick, two captains, an ineligible roster, a Big Guy, a Star, a bad flag, an unknown position", () => {
    expect(saveCaptainError(save("snotling", [{ positionId: "snotling.snotling_lineman", count: 11, captain: true }]))).toMatch(/Only one player/);
    expect(saveCaptainError(save("human", [{ positionId: "human.human_lineman", count: 1, captain: true }, { positionId: "human.human_blitzer", count: 1, captain: true }]))).toMatch(/Only one player/);
    expect(saveCaptainError(save("snotling", [{ positionId: "snotling.snotling_lineman", count: 1, captain: true }]))).toMatch(/cannot nominate a Team Captain/);
    expect(saveCaptainError(save("human", [{ positionId: "human.ogre", count: 1, captain: true }]))).toMatch(/Big Guy/);
    expect(saveCaptainError(save("human", [{ positionId: "66270", count: 1, captain: true }]), forkInfo({ "66270": { type: "bigguy" } }))).toMatch(/Big Guy/);
    expect(saveCaptainError(save("human", [{ positionId: "65801", count: 1, captain: true }]), forkInfo({ "65801": { type: "", isStar: true } }))).toMatch(/Star Player/);
    expect(saveCaptainError(save("human", [{ positionId: "human.human_lineman", count: 1, captain: "yes" }]))).toMatch(/true or false/);
    expect(saveCaptainError(save("human", [{ positionId: "99999", count: 1, captain: true }]))).toMatch(/could not be checked/);
  });

  it("never grants the captain skills to more than one player, even if a bad save reached it", () => {
    const file = teamFileFromSave(save("snotling", [{ positionId: "snotling.snotling_lineman", count: 11, captain: true }]));
    expect(file.players.filter((p) => p.skills.includes("Team Captain"))).toHaveLength(1);
  });
});
