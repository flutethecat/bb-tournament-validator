import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import type { ComposeResult, Roster } from "@bb/validator";
import {
  registerBuiltTeam,
  resolveTeamBuilderBuildTarget,
  retargetComposedTeam,
} from "../src/teamBuilderBuild.js";

const roots: string[] = [];

function libraryDir(): string {
  const root = mkdtempSync(join(tmpdir(), "team-builder-build-"));
  roots.push(root);
  return join(root, "library");
}

function stored(teamId: string, coach = "Tarkin"): LibraryTeam {
  return {
    teamId,
    teamName: `Old ${teamId}`,
    race: "Human",
    coach,
    teamValue: 900,
    gold: 25_000,
    rerolls: 2,
    fanFactor: 2,
    apothecary: true,
    rulesetPackName: "Old Cup",
    forkLoadable: true,
    ingestedAt: "2026-08-01T00:00:00.000Z",
  };
}

function roster(): Roster {
  return {
    rosterName: "Human",
    coach: "Tarkin",
    teamName: "Edited Humans",
    sideline: {
      apothecary: false,
      assistantCoaches: 0,
      cheerleaders: 0,
      dedicatedFans: 3,
      reRolls: 1,
    },
    inducements: [],
    leagues: [],
    specialRules: [],
    players: [],
  };
}

function composed(): ComposeResult {
  return {
    teamId: "tb_tarkin_human_new",
    xml: '<team id="tb_tarkin_human_new"><player id="tb_tarkin_human_new1"></player></team>',
    roster: roster(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("team-builder build target", () => {
  it("updates an owned team in place with the same id and row count", () => {
    const dir = libraryDir();
    upsertLibraryTeam(dir, "Tarkin", stored("owned"));
    upsertLibraryTeam(dir, "Tarkin", stored("sibling"));

    const target = resolveTeamBuilderBuildTarget(dir, "Tarkin", " owned ");
    expect(target).toEqual({ ok: true, teamId: "owned" });
    if (!target.ok) throw new Error("unreachable");
    const edited = retargetComposedTeam(composed(), target.teamId);
    registerBuiltTeam(dir, edited.roster, edited.teamId, 975_000, "2026-08-19T12:00:00.000Z", true, "New Cup");

    expect(edited.teamId).toBe("owned");
    expect(edited.xml).toContain('<team id="owned">');
    expect(edited.xml).toContain('<player id="tb_tarkin_human_new1">');
    const rows = readLibrary(dir, "Tarkin");
    expect(rows).toHaveLength(2);
    expect(rows.find((team) => team.teamId === "owned")).toMatchObject({
      teamName: "Edited Humans",
      teamValue: 975,
      rulesetPackName: "New Cup",
      ingestedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it.each(["foreign", "unknown"])("rejects a %s team id without a write", (teamId) => {
    const dir = libraryDir();
    upsertLibraryTeam(dir, "Gondra87", stored("foreign", "Gondra87"));
    const before = readLibrary(dir, "Gondra87");

    expect(resolveTeamBuilderBuildTarget(dir, "Tarkin", teamId)).toEqual({
      ok: false,
      status: 404,
      error: "Team not found.",
    });
    expect(readLibrary(dir, "Tarkin")).toEqual([]);
    expect(readLibrary(dir, "Gondra87")).toEqual(before);
  });

  it("keeps the existing mint-and-insert behavior when teamId is absent", () => {
    const dir = libraryDir();
    const original = composed();
    const target = resolveTeamBuilderBuildTarget(dir, "Tarkin", undefined);
    expect(target).toEqual({ ok: true });
    if (!target.ok) throw new Error("unreachable");

    const created = retargetComposedTeam(original, target.teamId);
    expect(created).toBe(original);
    registerBuiltTeam(dir, created.roster, created.teamId, 900_000, "2026-08-19T12:00:00.000Z", false);
    expect(readLibrary(dir, "Tarkin").map((team) => team.teamId)).toEqual(["tb_tarkin_human_new"]);
  });
});
