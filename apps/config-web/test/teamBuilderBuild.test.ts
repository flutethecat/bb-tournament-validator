import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import type { ComposeResult, Roster } from "@bb/validator";
import {
  registerBuiltTeam,
  resolveTeamBuilderBuildTarget,
  retargetComposedTeam,
} from "../src/teamBuilderBuild.js";

const roots: string[] = [];
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function dirs(): { libraryDir: string; teamsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "team-builder-build-"));
  roots.push(root);
  const teamsDir = join(root, "teams");
  mkdirSync(teamsDir);
  return { libraryDir: join(root, "library"), teamsDir };
}

function writeTeam(teamsDir: string, teamId: string, coach: string): string {
  const path = join(teamsDir, `team_${coach}_${teamId}.xml`);
  writeFileSync(path, `<team id="${teamId}"><coach>${coach}</coach><player id="p1"><name>Player</name></player></team>`, "utf8");
  return path;
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
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", stored("owned"));
    upsertLibraryTeam(d.libraryDir, "Tarkin", stored("sibling"));
    writeTeam(d.teamsDir, "owned", "Tarkin");

    const target = resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "tArKiN", " owned ");
    expect(target).toEqual({ ok: true, teamId: "owned" });
    if (!target.ok) throw new Error("unreachable");
    const edited = retargetComposedTeam(composed(), target.teamId);
    registerBuiltTeam(d.libraryDir, edited.roster, edited.teamId, 975_000, "2026-08-19T12:00:00.000Z", true, "New Cup");

    expect(edited.teamId).toBe("owned");
    expect(edited.xml).toContain('<team id="owned">');
    expect(edited.xml).toContain('<player id="tb_tarkin_human_new1">');
    const rows = readLibrary(d.libraryDir, "Tarkin");
    expect(rows).toHaveLength(2);
    expect(rows.find((team) => team.teamId === "owned")).toMatchObject({
      teamName: "Edited Humans",
      teamValue: 975,
      rulesetPackName: "New Cup",
      ingestedAt: "2026-08-19T12:00:00.000Z",
    });
  });

  it.each(["foreign", "unknown"])("rejects a %s team id without a write", (teamId) => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Gondra87", stored("foreign", "Gondra87"));
    const before = readLibrary(d.libraryDir, "Gondra87");

    expect(resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "Tarkin", teamId)).toEqual({
      ok: false,
      status: 404,
      error: "Team not found.",
    });
    expect(readLibrary(d.libraryDir, "Tarkin")).toEqual([]);
    expect(readLibrary(d.libraryDir, "Gondra87")).toEqual(before);
  });

  it("rejects a stale matching row when stored XML belongs to another coach", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", stored("owned"));
    const path = writeTeam(d.teamsDir, "owned", "Gondra87");
    const beforeRow = readLibrary(d.libraryDir, "Tarkin");
    const beforeXml = readFileSync(path, "utf8");

    expect(resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "Tarkin", "owned")).toEqual({
      ok: false,
      status: 404,
      error: "Team not found.",
    });
    expect(readLibrary(d.libraryDir, "Tarkin")).toEqual(beforeRow);
    expect(readFileSync(path, "utf8")).toBe(beforeXml);
  });

  it("refuses a played team with 409 and leaves its XML and row unchanged", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", stored("1272390"));
    const path = join(d.teamsDir, "team_Tarkin_1272390.xml");
    cpSync(join(FIXTURES, "team-detail.xml"), path);
    const beforeRow = readLibrary(d.libraryDir, "Tarkin");
    const beforeXml = readFileSync(path, "utf8");

    expect(resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "Tarkin", "1272390")).toEqual({
      ok: false,
      status: 409,
      error: "This team has match history; editing played teams isn't supported yet.",
    });
    expect(readLibrary(d.libraryDir, "Tarkin")).toEqual(beforeRow);
    expect(readFileSync(path, "utf8")).toBe(beforeXml);
  });

  it("rejects a retired edit target with 409 and no write", () => {
    const d = dirs();
    const retiredAt = "2026-08-18T00:00:00.000Z";
    upsertLibraryTeam(d.libraryDir, "Tarkin", { ...stored("owned"), retired: true, retiredAt });
    const path = writeTeam(d.teamsDir, "owned", "Tarkin");
    const beforeRow = readLibrary(d.libraryDir, "Tarkin");
    const beforeXml = readFileSync(path, "utf8");

    expect(resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "Tarkin", "owned")).toEqual({
      ok: false,
      status: 409,
      error: "Retired teams can't be edited.",
    });
    expect(readLibrary(d.libraryDir, "Tarkin")).toEqual(beforeRow);
    expect(readFileSync(path, "utf8")).toBe(beforeXml);
  });

  it("does not drop retirement metadata when an existing row is upserted", () => {
    const d = dirs();
    const retiredAt = "2026-08-18T00:00:00.000Z";
    upsertLibraryTeam(d.libraryDir, "Tarkin", { ...stored("owned"), retired: true, retiredAt });
    upsertLibraryTeam(d.libraryDir, "Tarkin", { ...stored("owned"), teamName: "Replacement" });

    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({ retired: true, retiredAt });
  });

  it("keeps the existing mint-and-insert behavior when teamId is absent", () => {
    const d = dirs();
    const original = composed();
    const target = resolveTeamBuilderBuildTarget(d.libraryDir, d.teamsDir, "Tarkin", undefined);
    expect(target).toEqual({ ok: true });
    if (!target.ok) throw new Error("unreachable");

    const created = retargetComposedTeam(original, target.teamId);
    expect(created).toBe(original);
    registerBuiltTeam(d.libraryDir, created.roster, created.teamId, 900_000, "2026-08-19T12:00:00.000Z", false);
    expect(readLibrary(d.libraryDir, "Tarkin").map((team) => team.teamId)).toEqual(["tb_tarkin_human_new"]);
  });
});
