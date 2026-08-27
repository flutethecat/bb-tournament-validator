import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findLibraryTeamByName, readLibrary, upsertLibraryTeam, type LibraryTeam, type ReloadResult } from "@bb/fork-ops";
import { teamDetailEndpoint } from "../src/teamDetail.js";
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
    "setResurrection",
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

  it("round-trips the resurrection root attribute and omits false from detail", async () => {
    const d = setup();

    expect((await mutate(d, "setResurrection", { teamId: "42", resurrection: true })).status).toBe(200);
    expect((await mutate(d, "setResurrection", { teamId: "42", resurrection: true })).status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8").match(/\bresurrection="true"/g)).toHaveLength(1);
    const enabled = teamDetailEndpoint({ coach: "Tarkin", organizer: true }, "42", d);
    if (enabled.status !== 200) throw new Error(enabled.body.error);
    expect(enabled.body.team.resurrection).toBe(true);

    expect((await mutate(d, "setResurrection", { teamId: "42", resurrection: false })).status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).not.toContain("resurrection=");
    const disabled = teamDetailEndpoint({ coach: "Tarkin", organizer: true }, "42", d);
    if (disabled.status !== 200) throw new Error(disabled.body.error);
    expect(disabled.body.team).not.toHaveProperty("resurrection");
  });

  it("requires a boolean resurrection value without writing", async () => {
    const d = setup();
    const before = snapshot(d);
    const result = await mutate(d, "setResurrection", { teamId: "42", resurrection: "true" });

    expect(result).toMatchObject({ status: 400, body: { error: expect.stringMatching(/resurrection must be a boolean/i) } });
    expect(snapshot(d)).toEqual(before);
    expect(d.reloads()).toBe(0);
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

// ── P3: player lifecycle + ready/unready ─────────────────────────────────────────────────────────

const P3_ROSTER = `<?xml version="1.0" encoding="UTF-8"?>
<roster id="human">
  <name>Human</name>
  <reRollCost>60000</reRollCost>
  <apothecary>true</apothecary>
  <nameGenerator>human</nameGenerator>
  <position id="lineman"><quantity>16</quantity><name>Lineman</name><type>Regular</type><gender>random</gender><cost>50000</cost></position>
  <position id="blitzer"><quantity>4</quantity><name>Blitzer</name><type>Regular</type><gender>male</gender><cost>90000</cost></position>
  <position id="star1"><quantity>1</quantity><name>Griff Oberwald</name><type>Star</type><gender>male</gender><cost>300000</cost></position>
</roster>
`;

function teamWithPlayers(count: number, status?: string): string {
  const players = Array.from({ length: count }, (_, i) =>
    `  <player nr="${i + 1}" id="p${i + 1}"><name>Player ${i + 1}</name><positionId>lineman</positionId><skillList></skillList></player>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<team id="42"${status !== undefined ? ` status="${status}"` : ""}>
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
${players}
</team>
`;
}

describe("P3 player lifecycle", () => {
  it.each([
    "addPlayer",
    "firePlayer",
    "retirePlayer",
    "temporaryRetirePlayer",
    "undoTemporaryRetire",
    "rehirePlayer",
    "refundPlayer",
    "ready",
    "unready",
  ] as const)("maps /api/team/%s as a state-changing mutation", (operation) => {
    const path = `/api/team/${operation}`;
    expect(teamMutationOperation(path)).toBe(operation);
    expect(isTeamMutationWritePath(path)).toBe(true);
  });

  it("hires a player: debits cost, assigns lowest free number, bumps TV, returns {playerId, number}", async () => {
    const d = setup(teamWithPlayers(2), P3_ROSTER);
    const result = await mutate(d, "addPlayer", { teamId: "42", positionId: "blitzer", gender: "male", name: "New Guy" });

    expect(result).toMatchObject({ status: 200, body: { ok: true, playerId: "42h1", number: 3 } });
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).toMatch(/<player nr="3" id="42h1"><name>New Guy<\/name><gender>male<\/gender><positionId>blitzer<\/positionId>/);
    expect(xml).toContain("<treasury>110000</treasury>");
    expect(xml).toContain("<teamRating>109</teamRating>");
    expect(d.reloads()).toBe(1);
  });

  it("builds a rich player node for the fork-ingest dialect", async () => {
    const rich = teamWithPlayers(1).replace(
      /<player nr="1" id="p1">.*<\/player>/,
      `  <player status="Active" nr="1" id="p1"><name>One</name><positionId>lineman</positionId><playerStatistics currentSpps="0"><games>0</games></playerStatistics></player>`,
    );
    const d = setup(rich, P3_ROSTER);
    const result = await mutate(d, "addPlayer", { teamId: "42", positionId: "lineman", gender: "female", name: "Ricci" });

    expect(result.status).toBe(200);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).toMatch(/<player status="Active" nr="2" id="42h1">/);
    expect(xml).toContain('<playerStatistics currentSpps="0">');
    expect(xml).toContain("<position>Lineman</position>");
  });

  it("rejects star hires, bad genders, unknown positions, and over-cap hires without writing", async () => {
    const d = setup(teamWithPlayers(2), P3_ROSTER);
    const before = snapshot(d);
    const star = await mutate(d, "addPlayer", { teamId: "42", positionId: "star1", gender: "male", name: "Griff" });
    const gender = await mutate(d, "addPlayer", { teamId: "42", positionId: "blitzer", gender: "Male", name: "X" });
    const unknown = await mutate(d, "addPlayer", { teamId: "42", positionId: "nope", gender: "male", name: "X" });

    expect(star).toMatchObject({ status: 400, body: { error: expect.stringMatching(/induced per game/i) } });
    expect(gender).toMatchObject({ status: 400, body: { error: expect.stringMatching(/male, female, or neutral/i) } });
    expect(unknown).toMatchObject({ status: 400, body: { error: expect.stringMatching(/unknown positionId/i) } });
    expect(snapshot(d)).toEqual(before);

    const full = setup(teamWithPlayers(16), P3_ROSTER);
    const capped = await mutate(full, "addPlayer", { teamId: "42", positionId: "blitzer", gender: "male", name: "X" });
    expect(capped).toMatchObject({ status: 400, body: { error: expect.stringMatching(/more than 16 players/i) } });
  });

  it("rejects an unaffordable hire atomically", async () => {
    const d = setup(teamWithPlayers(2).replace("<treasury>200000</treasury>", "<treasury>10000</treasury>"), P3_ROSTER);
    const before = snapshot(d);
    const result = await mutate(d, "addPlayer", { teamId: "42", positionId: "blitzer", gender: "male", name: "X" });

    expect(result).toMatchObject({ status: 400, body: { error: expect.stringMatching(/insufficient treasury/i) } });
    expect(snapshot(d)).toEqual(before);
  });

  it("fires a player into <firedPlayer> with neutralized child tags, no refund, TV down", async () => {
    const d = setup(teamWithPlayers(2), P3_ROSTER);
    const result = await mutate(d, "firePlayer", { teamId: "42", playerId: "p1" });

    expect(result.status).toBe(200);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).not.toMatch(/<player\b[^>]*id="p1"/);
    expect(xml).toMatch(/<firedPlayer reason="fired"[^>]*id="p1"/);
    expect(xml).toContain("<firedName>Player 1</firedName>");
    expect(xml).not.toMatch(/<firedPlayer[^>]*>[\s\S]*?<name>/);
    expect(xml).toContain("<treasury>200000</treasury>");
    expect(xml).toContain("<teamRating>95</teamRating>");
  });

  it("retires with reason=retired and re-hires at current value with a fresh number", async () => {
    const d = setup(teamWithPlayers(2), P3_ROSTER);
    await mutate(d, "retirePlayer", { teamId: "42", playerId: "p1" });
    expect(readFileSync(d.teamFile, "utf8")).toMatch(/<firedPlayer reason="retired"/);

    const rehired = await mutate(d, "rehirePlayer", { teamId: "42", playerId: "p1" });
    expect(rehired.status).toBe(200);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).not.toMatch(/<firedPlayer\b/);
    expect(xml).toMatch(/<player status="Active" nr="1" id="p1"><name>Player 1<\/name>/);
    expect(xml).toContain("<treasury>150000</treasury>");
    expect(xml).toContain("<teamRating>100</teamRating>");
  });

  it("refunds an unplayed player on a NEW team and removes the node outright", async () => {
    const d = setup(teamWithPlayers(2), P3_ROSTER);
    const result = await mutate(d, "refundPlayer", { teamId: "42", playerId: "p2" });

    expect(result).toMatchObject({ status: 200, body: { number: 0 } });
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml).not.toContain('id="p2"');
    expect(xml).toContain("<treasury>250000</treasury>");
    expect(xml).toContain("<teamRating>95</teamRating>");
  });

  it("refuses refunds on non-NEW teams and on players with history", async () => {
    const active = setup(teamWithPlayers(2, "1"), P3_ROSTER);
    const refused = await mutate(active, "refundPlayer", { teamId: "42", playerId: "p1" });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringMatching(/before a team's first game/i) } });

    const skilled = setup(teamWithPlayers(2).replace("<skillList></skillList>", "<skillList><skill>Block</skill></skillList>"), P3_ROSTER);
    const history = await mutate(skilled, "refundPlayer", { teamId: "42", playerId: "p1" });
    expect(history).toMatchObject({ status: 400, body: { error: expect.stringMatching(/cannot be refunded/i) } });
  });

  it("toggles temporary retirement via the status attribute", async () => {
    const eligible = teamWithPlayers(2).replace(
      "<skillList></skillList></player>",
      '<skillList></skillList><injuryList><injury recovering="true">Smashed Knee (-MA)</injury></injuryList></player>',
    );
    const d = setup(eligible, P3_ROSTER);
    await mutate(d, "temporaryRetirePlayer", { teamId: "42", playerId: "p1" });
    expect(readFileSync(d.teamFile, "utf8")).toMatch(/<player status="TemporarilyRetired" nr="1" id="p1">/);

    const again = await mutate(d, "temporaryRetirePlayer", { teamId: "42", playerId: "p1" });
    expect(again).toMatchObject({ status: 400, body: { error: expect.stringMatching(/already temporarily retired/i) } });

    await mutate(d, "undoTemporaryRetire", { teamId: "42", playerId: "p1" });
    expect(readFileSync(d.teamFile, "utf8")).toMatch(/<player status="Active" nr="1" id="p1">/);

    const notRetired = await mutate(d, "undoTemporaryRetire", { teamId: "42", playerId: "p2" });
    expect(notRetired).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not temporarily retired/i) } });
  });

  it("rejects temporary retirement for an old stat reduction", async () => {
    const oldInjury = teamWithPlayers(2).replace(
      "<skillList></skillList></player>",
      "<skillList></skillList><injuryList><injury>Smashed Knee (-MA)</injury></injuryList></player>",
    );
    const d = setup(oldInjury, P3_ROSTER);
    const before = snapshot(d);

    const result = await mutate(d, "temporaryRetirePlayer", { teamId: "42", playerId: "p1" });
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringMatching(/fresh stat-reducing injury/i) } });
    expect(snapshot(d)).toEqual(before);
  });

  it("rejects temporary retirement for a recovering non-stat injury", async () => {
    const mngOnly = teamWithPlayers(2).replace(
      "<skillList></skillList></player>",
      '<skillList></skillList><injuryList><injury recovering="true">Seriously Hurt (MNG)</injury></injuryList></player>',
    );
    const d = setup(mngOnly, P3_ROSTER);
    const before = snapshot(d);

    const result = await mutate(d, "temporaryRetirePlayer", { teamId: "42", playerId: "p1" });
    expect(result).toMatchObject({ status: 400, body: { error: expect.stringMatching(/fresh stat-reducing injury/i) } });
    expect(snapshot(d)).toEqual(before);
  });
});

describe("P3 ready/unready", () => {
  it("readies an 11-player NEW team without journeymen and writes status 1", async () => {
    const d = setup(teamWithPlayers(11), P3_ROSTER);
    const result = await mutate(d, "ready", { teamId: "42", journeymen: [] });

    expect(result.status).toBe(200);
    expect((result.body as Record<string, unknown>).expensiveMistakes).toBeUndefined();
    expect(readFileSync(d.teamFile, "utf8")).toMatch(/<team id="42" status="1">/);
  });

  it("requires exactly the missing journeymen and provisions them per the handoff shape", async () => {
    const d = setup(teamWithPlayers(9), P3_ROSTER);
    const short = await mutate(d, "ready", { teamId: "42", journeymen: [] });
    expect(short).toMatchObject({ status: 400, body: { error: expect.stringMatching(/exactly 2 journeymen/i) } });

    const wrongPosition = await mutate(d, "ready", { teamId: "42", journeymen: [{ positionId: "blitzer", quantity: 2 }] });
    expect(wrongPosition).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not a journeyman-legal position/i) } });

    const result = await mutate(d, "ready", { teamId: "42", journeymen: [{ positionId: "lineman", quantity: 2 }] });
    expect(result.status).toBe(200);
    expect((result.body as { journeymen?: unknown[] }).journeymen).toHaveLength(2);
    const xml = readFileSync(d.teamFile, "utf8");
    expect(xml.match(/status="journeyman"/g)).toHaveLength(2);
    expect(xml).toContain('<skill value="4">Loner</skill>');
    expect(xml).toContain("<treasury>200000</treasury>");
    expect(xml).toContain("<teamRating>110</teamRating>");
    expect(xml).toMatch(/status="1"/);
  });

  it("refuses ready on active and post-game statuses, and unready outside active", async () => {
    const active = setup(teamWithPlayers(11, "1"), P3_ROSTER);
    expect(await mutate(active, "ready", { teamId: "42", journeymen: [] })).toMatchObject({
      status: 400, body: { error: expect.stringMatching(/already ready/i) },
    });

    const postGame = setup(teamWithPlayers(11, "7"), P3_ROSTER);
    expect(await mutate(postGame, "ready", { teamId: "42", journeymen: [] })).toMatchObject({
      status: 400, body: { error: expect.stringMatching(/post-game parity/i) },
    });

    const fresh = setup(teamWithPlayers(11), P3_ROSTER);
    expect(await mutate(fresh, "unready", { teamId: "42" })).toMatchObject({
      status: 400, body: { error: expect.stringMatching(/only a ready team/i) },
    });
  });

  it("unreadies an active team back to status 0", async () => {
    const d = setup(teamWithPlayers(11, "1"), P3_ROSTER);
    const result = await mutate(d, "unready", { teamId: "42" });

    expect(result.status).toBe(200);
    expect(readFileSync(d.teamFile, "utf8")).toMatch(/<team id="42" status="0">/);
  });
});
