import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLibraryTeamByName, readLibrary, upsertLibraryTeam, type LibraryTeam, type ReloadResult } from "@bb/fork-ops";
import {
  isTeamMutationWritePath,
  teamCheckNameEndpoint,
  teamMutationEndpoint,
  teamMutationOperation,
  teamNameValidationError,
  type TeamMutationDeps,
  type TeamMutationOperation,
} from "../src/teamMutation.js";

const roots: string[] = [];
const auth = { coach: "Tarkin", admin: false };

const TEAM = `<?xml version="1.0" encoding="UTF-8"?>
<team id="42">
  <coach>Tarkin</coach>
  <name>Mutation Humans</name>
  <race>Human</race>
  <rosterId>human</rosterId>
  <reRolls>2</reRolls>
  <fanFactor>2</fanFactor>
  <treasury>200000</treasury>
  <apothecaries>0</apothecaries>
  <teamRating>100</teamRating>
  <currentTeamValue>100</currentTeamValue>
  <teamStrength>100</teamStrength>
  <player nr="1" id="p1"><name>One</name><positionId>lineman</positionId></player>
  <player nr="2" id="p2"><name>Two</name><positionId>lineman</positionId></player>
</team>
`;

const ROSTER = `<?xml version="1.0" encoding="UTF-8"?>
<roster id="human">
  <name>Human</name>
  <reRollCost>60000</reRollCost>
  <maxReRolls>8</maxReRolls>
  <apothecary>true</apothecary>
</roster>
`;

const STORED: LibraryTeam = {
  teamId: "42",
  teamName: "Mutation Humans",
  race: "Human",
  coach: "Tarkin",
  teamValue: 1000,
  gold: 200_000,
  rerolls: 2,
  fanFactor: 2,
  apothecary: false,
  forkLoadable: true,
  ingestedAt: "2026-08-01T00:00:00.000Z",
};

interface Setup {
  root: string;
  libraryDir: string;
  teamsDir: string;
  teamFile: string;
  rosterFile: string;
  deps: TeamMutationDeps;
  reloads: () => number;
}

function setup(teamXml = TEAM, rosterXml = ROSTER, reloadResult: ReloadResult = { reloaded: true, method: "refresh", teams: 1, rosters: 1 }): Setup {
  const root = mkdtempSync(join(tmpdir(), "team-mutation-"));
  roots.push(root);
  const libraryDir = join(root, "library");
  const teamsDir = join(root, "teams");
  const rostersDir = join(root, "rosters");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(rostersDir, { recursive: true });
  const teamFile = join(teamsDir, "team_Tarkin_42.xml");
  const rosterFile = join(rostersDir, "roster_team_42.xml");
  writeFileSync(teamFile, teamXml, "utf8");
  writeFileSync(rosterFile, rosterXml, "utf8");
  upsertLibraryTeam(libraryDir, "Tarkin", STORED);
  let reloadCount = 0;
  return {
    root,
    libraryDir,
    teamsDir,
    teamFile,
    rosterFile,
    reloads: () => reloadCount,
    deps: {
      libraryDir,
      teamsDir,
      reload: async () => {
        reloadCount++;
        return reloadResult;
      },
      duplicateNameError: (name, excludeTeamId) => {
        const clash = findLibraryTeamByName(libraryDir, name, excludeTeamId);
        return clash ? `A team named "${name.trim()}" already exists — choose another name.` : undefined;
      },
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function mutate(d: Setup, operation: TeamMutationOperation, body: Record<string, unknown>) {
  return teamMutationEndpoint(auth, operation, body, d.deps);
}

function snapshot(d: Setup): { xml: string; library: LibraryTeam[] } {
  return { xml: readFileSync(d.teamFile, "utf8"), library: readLibrary(d.libraryDir, "Tarkin") };
}

describe("P2 team mutations", () => {
  it.each([
    "renumber",
    "addReroll",
    "removeReroll",
    "discardReroll",
    "addAssistantCoach",
    "fireAssistantCoach",
    "addCheerleader",
    "fireCheerleader",
    "addApothecary",
    "fireApothecary",
    "changeDedicatedFans",
    "rename",
  ] as const)("maps /api/team/%s as a state-changing mutation", (operation) => {
    const path = `/api/team/${operation}`;
    expect(teamMutationOperation(path)).toBe(operation);
    expect(isTeamMutationWritePath(path)).toBe(true);
  });

  it("renumbers listed players and preserves unlisted assignments", async () => {
    const d = setup();
    const result = await mutate(d, "renumber", { teamId: "42", playerNumbers: { p1: 7 } });

    expect(result).toMatchObject({ status: 200, body: { ok: true, teamId: "42", reload: { reloaded: true } } });
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).toContain('<player nr="7" id="p1">');
    expect(xml).toContain('<player nr="2" id="p2">');
    expect(d.reloads()).toBe(1);
  });

  it("rejects a duplicate resulting player number atomically", async () => {
    const d = setup();
    const before = snapshot(d);
    const result = await mutate(d, "renumber", { teamId: "42", playerNumbers: { p1: 2 } });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/duplicate final player number 2/i) });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });

  it("rejects an unknown renumber player atomically", async () => {
    const d = setup();
    const before = snapshot(d);
    const result = await mutate(d, "renumber", { teamId: "42", playerNumbers: { missing: 9 } });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/unknown playerId missing/i) });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });

  it("buys a NEW-status reroll for half roster price and syncs library fields", async () => {
    const d = setup();
    const result = await mutate(d, "addReroll", { teamId: "42" });

    expect(result.status).toBe(200);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).toContain("<reRolls>3</reRolls>");
    expect(xml).toContain("<treasury>170000</treasury>");
    expect(xml).toContain("<teamRating>106</teamRating>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({ rerolls: 3, gold: 170_000, teamValue: 1060 });
  });

  it("rejects the reroll cap of 8 without writing", async () => {
    const d = setup(TEAM.replace("<reRolls>2</reRolls>", "<reRolls>8</reRolls>"));
    const before = snapshot(d);
    const result = await mutate(d, "addReroll", { teamId: "42" });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/more than 8 rerolls/i) });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });

  it("rejects insufficient reroll treasury without writing", async () => {
    const d = setup(TEAM.replace("<treasury>200000</treasury>", "<treasury>29999</treasury>"));
    const before = snapshot(d);
    const result = await mutate(d, "addReroll", { teamId: "42" });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/insufficient treasury/i) });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });

  it("charges double reroll price outside NEW/REDRAFTING", async () => {
    const d = setup(TEAM.replace('<team id="42">', '<team id="42" status="1">'));
    const result = await mutate(d, "addReroll", { teamId: "42" });

    expect(result.status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<treasury>80000</treasury>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({ rerolls: 3, gold: 80_000 });
  });

  it.each(["removeReroll", "discardReroll"] as const)("%s removes a reroll without a refund", async (operation) => {
    const d = setup();
    const result = await mutate(d, operation, { teamId: "42" });

    expect(result.status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<reRolls>1</reRolls>");
    expect(readFileSync(d.teamFile, "utf8")).toContain("<treasury>200000</treasury>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({ rerolls: 1, gold: 200_000, teamValue: 940 });
  });

  it("adds an assistant coach to composed XML that omitted the zero tag", async () => {
    const d = setup();
    const result = await mutate(d, "addAssistantCoach", { teamId: "42" });

    expect(result.status).toBe(200);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).toContain("<assistantCoaches>1</assistantCoaches>");
    expect(xml).toContain("<treasury>190000</treasury>");
  });

  it("enforces the assistant-coach cap of 6", async () => {
    const d = setup(TEAM.replace("<treasury>", "<assistantCoaches>6</assistantCoaches>\n  <treasury>"));
    const before = snapshot(d);
    const result = await mutate(d, "addAssistantCoach", { teamId: "42" });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/more than 6 assistant coaches/i) });
    expect(snapshot(d)).toEqual(before);
  });

  it("buys and fires cheerleaders without a firing refund", async () => {
    const d = setup();
    expect((await mutate(d, "addCheerleader", { teamId: "42" })).status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<cheerleaders>1</cheerleaders>");
    expect((await mutate(d, "fireCheerleader", { teamId: "42" })).status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<cheerleaders>0</cheerleaders>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]?.gold).toBe(190_000);
  });

  it("fires assistant coaches and apothecaries without refunds", async () => {
    const staffed = TEAM
      .replace("<treasury>", "<assistantCoaches>1</assistantCoaches>\n  <treasury>")
      .replace("<apothecaries>0</apothecaries>", "<apothecaries>1</apothecaries>");
    const assistant = setup(staffed);
    expect((await mutate(assistant, "fireAssistantCoach", { teamId: "42" })).status).toBe(200);
    expect(readFileSync(assistant.teamFile, "utf8")).toContain("<assistantCoaches>0</assistantCoaches>");
    expect(readLibrary(assistant.libraryDir, "Tarkin")[0]?.gold).toBe(200_000);

    const apothecary = setup(staffed);
    expect((await mutate(apothecary, "fireApothecary", { teamId: "42" })).status).toBe(200);
    expect(readFileSync(apothecary.teamFile, "utf8")).toContain("<apothecaries>0</apothecaries>");
    expect(readLibrary(apothecary.libraryDir, "Tarkin")[0]).toMatchObject({ apothecary: false, gold: 200_000 });
  });

  it("allows an apothecary only when the stored roster does", async () => {
    const forbidden = setup(TEAM, ROSTER.replace("<apothecary>true</apothecary>", "<apothecary>false</apothecary>"));
    const before = snapshot(forbidden);
    const rejected = await mutate(forbidden, "addApothecary", { teamId: "42" });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toMatchObject({ error: expect.stringMatching(/does not allow an apothecary/i) });
    expect(snapshot(forbidden)).toEqual(before);

    const allowed = setup();
    const bought = await mutate(allowed, "addApothecary", { teamId: "42" });
    expect(bought.status).toBe(200);
    expect(readFileSync(allowed.teamFile, "utf8")).toContain("<apothecaries>1</apothecaries>");
    expect(readLibrary(allowed.libraryDir, "Tarkin")[0]).toMatchObject({ apothecary: true, gold: 150_000 });
  });

  it("changes the composed fanFactor with the exact newDf field and charges increases", async () => {
    const d = setup();
    const result = await mutate(d, "changeDedicatedFans", { teamId: "42", newDf: 4 });

    expect(result.status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<fanFactor>4</fanFactor>");
    expect(readFileSync(d.teamFile, "utf8")).toContain("<treasury>180000</treasury>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({ fanFactor: 4, gold: 180_000, teamValue: 1000 });
  });

  it("rejects a dedicated-fans alias and values outside 1-6 without writing", async () => {
    for (const body of [
      { teamId: "42", dedicatedFans: 3 },
      { teamId: "42", newDf: 0 },
      { teamId: "42", newDf: 7 },
    ]) {
      const d = setup();
      const before = snapshot(d);
      const result = await mutate(d, "changeDedicatedFans", body);
      expect(result.status).toBe(400);
      expect(snapshot(d)).toEqual(before);
      expect(d.reloads()).toBe(0);
    }
  });

  it("rejects a duplicate rename without writing", async () => {
    const d = setup();
    upsertLibraryTeam(d.libraryDir, "Other", { ...STORED, teamId: "99", teamName: "Taken Name", coach: "Other" });
    const before = snapshot(d);
    const result = await mutate(d, "rename", { teamId: "42", newName: " Taken Name " });

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ error: expect.stringMatching(/already exists/i) });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });

  it("renames XML and the LibraryTeam row using the trimmed local-law name", async () => {
    const d = setup();
    const result = await mutate(d, "rename", { teamId: "42", newName: "  The A&B.  " });

    expect(result.status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toContain("<name>The A&amp;B.</name>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]?.teamName).toBe("The A&B.");
  });

  it("preserves library-derived values absent from a legacy XML dialect during rename", async () => {
    const minimal = '<team id="42"><coach>Tarkin</coach><name>Mutation Humans</name></team>';
    const d = setup(minimal);
    const result = await mutate(d, "rename", { teamId: "42", newName: "Legacy Renamed" });

    expect(result.status).toBe(200);
    expect(readLibrary(d.libraryDir, "Tarkin")[0]).toMatchObject({
      teamName: "Legacy Renamed",
      teamValue: 1000,
      gold: 200_000,
      rerolls: 2,
      fanFactor: 2,
      apothecary: false,
    });
  });

  it("keeps a successful mutation when reload is refused and returns the result", async () => {
    const d = setup(TEAM, ROSTER, { reloaded: false, reason: "fork busy" });
    const result = await mutate(d, "addCheerleader", { teamId: "42" });

    expect(result).toMatchObject({ status: 200, body: { ok: true, reload: { reloaded: false, reason: "fork busy" } } });
    expect(readFileSync(d.teamFile, "utf8")).toContain("<cheerleaders>1</cheerleaders>");
    expect(readLibrary(d.libraryDir, "Tarkin")[0]?.gold).toBe(190_000);
  });

  it("enforces owner-or-admin authorization without revealing foreign teams", async () => {
    const d = setup();
    expect((await teamMutationEndpoint(undefined, "addReroll", { teamId: "42" }, d.deps)).status).toBe(401);
    expect((await teamMutationEndpoint({ coach: "Other", admin: false }, "addReroll", { teamId: "42" }, d.deps)).status).toBe(404);
    expect((await teamMutationEndpoint({ admin: true }, "addReroll", { teamId: "42" }, d.deps)).status).toBe(200);
  });
});

describe("POST /api/team/checkName", () => {
  it("uses trimmed non-empty 1-100 local-law validation", () => {
    expect(teamNameValidationError(" x ")).toBeUndefined();
    expect(teamNameValidationError(" ")).toMatch(/empty/i);
    expect(teamNameValidationError(` ${"x".repeat(100)} `)).toBeUndefined();
    expect(teamNameValidationError("x".repeat(101))).toMatch(/100/);
  });

  it("checks uniqueness and performs no write", () => {
    const d = setup();
    const before = snapshot(d);
    const available = teamCheckNameEndpoint({ name: "Available Name" }, d.deps.duplicateNameError);
    const taken = teamCheckNameEndpoint({ name: " Mutation Humans " }, d.deps.duplicateNameError);

    expect(available).toEqual({ status: 200, body: { ok: true } });
    expect(taken).toMatchObject({ status: 200, body: { ok: false, error: expect.stringMatching(/already exists/i) } });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
  });
});
