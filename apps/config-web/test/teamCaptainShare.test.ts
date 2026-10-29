import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeTeam } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { sharedTeamView } from "../src/teamShareView.js";
import type { TeamBuilderSave } from "../src/teamBuilderSaves.js";

// BB2025 Team Captain (https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): review regressions.
const save = (rosterId: string, picks: unknown[]): TeamBuilderSave =>
  ({ id: "sv_c", name: "Caps", rosterId, raceName: "", packageName: null, teamId: null, updatedAt: "", createdAt: "", body: { rosterId, picks } }) as TeamBuilderSave;

const position = (id: string, name: string, type: string, quantity: number) =>
  `<position id="${id}"><quantity>${quantity}</quantity><name>${name}</name><type>${type}</type><gender>male</gender></position>`;
const humanXml =
  '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  position("1", "Human Lineman", "Regular", 16) + position("2", "Human Blitzer", "Regular", 2) + "</roster>";

describe("Team Captain: the public share view shows the free grants", () => {
  it("lists Team Captain + Pro as free, not printed or added, and marks the captain", () => {
    const composed = composeTeam({ forkRosterXml: humanXml, coach: "C", teamName: "T", reRolls: 0, apothecary: false, picks: [{ positionId: "2", count: 1, captain: true, chosenSkills: ["Dodge"] }, { positionId: "1", count: 10 }] }, bb2025, 1);
    const view = sharedTeamView({ coach: "C", save: save("human", []), roster: composed.roster, publicDir: mkdtempSync(join(tmpdir(), "tc-share-")) });
    const captain = view.players[0]!;
    expect(captain.captain).toBe(true);
    expect(captain.free.map((s) => s.name)).toEqual(["Team Captain", "Pro"]);
    expect(captain.printed.map((s) => s.name)).toEqual(["Block", "Tackle"]);
    expect(captain.added.map((s) => s.name)).toEqual(["Dodge"]);
    expect(view.players[1]!.captain).toBe(false);
    expect(view.players[1]!.free).toEqual([]);
  });
});
describe("Team Captain: page sources render the free grants", () => {
  it("the share page, the PDF sheet and the builder all handle the captain", async () => {
    const { readFileSync } = await import("node:fs");
    const read = (f: string) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    expect(read("team-view.js")).toContain("const free = (player.free ?? [])");
    expect(read("team-view.js")).toContain("${p.captain ? CAPTAIN_TAG : \"\"}");
    expect(read("sheet-pdf.js")).toContain("for (const skill of row.free ?? []) push({ text: skill, color: TRAIT });");
    // The builder's canCaptain reads the normalized type the intrinsic options now carry ("bigguy").
    const { runInNewContext } = await import("node:vm");
    const context: Record<string, unknown> = { console };
    runInNewContext(read("team-builder.js"), context);
    const core = context.TeamBuilderCore as { canCaptain: (p: unknown, r: string[]) => boolean };
    expect(core.canCaptain({ positionId: "x", type: "bigguy" }, ["Team Captain"])).toBe(false);
    expect(core.canCaptain({ positionId: "x", type: "regular" }, ["Team Captain"])).toBe(true);
  });
});
