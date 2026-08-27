import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { requireSession } from "../src/auth/requireSession.js";
import { teamDetailEndpoint } from "../src/teamDetail.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const roots: string[] = [];

const STORED_TEAM: LibraryTeam = {
  teamId: "1272390",
  teamName: "Da & Boyz",
  race: "Black Orc",
  coach: "Tarkin",
  teamValue: 955,
  gold: 35000,
  rerolls: 2,
  fanFactor: 3,
  apothecary: true,
  forkLoadable: true,
  ingestedAt: "2026-08-19T12:00:00.000Z",
};

function request(): IncomingMessage {
  return { headers: {}, socket: {}, method: "GET" } as unknown as IncomingMessage;
}

function dirs(): { root: string; libraryDir: string; teamsDir: string } {
  const root = mkdtempSync(join(tmpdir(), "team-detail-"));
  roots.push(root);
  const libraryDir = join(root, "library");
  const teamsDir = join(root, "teams");
  mkdirSync(teamsDir, { recursive: true });
  return { root, libraryDir, teamsDir };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GET /api/teams/:id/detail", () => {
  it("requires a coach session", () => {
    const d = dirs();
    expect(requireSession(request(), "/api/teams/1272390/detail", "").kind).toBe("unauthorized");
    expect(teamDetailEndpoint(undefined, "1272390", d)).toEqual({
      status: 401,
      body: { error: "Authentication required." },
    });
  });

  it("does not reveal another coach's team", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Gondra87", { ...STORED_TEAM, coach: "Gondra87" });
    expect(teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", d)).toEqual({
      status: 404,
      body: { error: "Team not found." },
    });
  });

  it("rejects a matching library row when stored XML belongs to another coach", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    writeFileSync(
      join(d.teamsDir, "team_Gondra87_1272390.xml"),
      '<team id="1272390"><coach>Gondra87</coach><name>Stale Row</name></team>',
      "utf8",
    );

    expect(teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", d)).toEqual({
      status: 404,
      body: { error: "Team not found." },
    });
  });

  it("returns the sanitized parsed roster from stored team XML", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    cpSync(join(FIXTURES, "team-detail.xml"), join(d.teamsDir, "team_Tarkin_1272390.xml"));
    const rostersDir = join(d.root, "rosters");
    mkdirSync(rostersDir);
    cpSync(join(FIXTURES, "roster-team-detail.xml"), join(rostersDir, "roster_team_1272390.xml"));

    const result = teamDetailEndpoint({ coach: "tArKiN", organizer: false }, "1272390", d);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error(result.body.error);
    expect(result.body.team).toMatchObject({
          id: "1272390",
          name: "Da & Boyz",
          race: "Black Orc",
          rerolls: 2,
          apothecary: true,
          fanFactor: 3,
          assistantCoaches: 1,
          cheerleaders: 2,
          treasury: 35000,
          teamValue: 955,
          rulesetPackName: null,
          players: [
            {
              id: "17854689",
              number: 1,
              name: "Big & Bob",
              position: "Black Orc",
              positionId: "860401",
              skills: ["Block", "Guard"],
              injuries: ["Smashed Knee"],
              injuryDetails: [{ name: "Smashed Knee", recovering: false }],
              spp: 12,
          earnedSpp: null,
              advancements: 2,
              rank: "Emerging Star",
              advancementCosts: { randomPrimary: 6, chosenPrimary: 12, chosenSecondary: 16, characteristic: 20 },
              primaryCategories: ["General", "Strength"],
              secondaryCategories: ["Agility"],
              movement: 4,
              strength: 4,
              agility: 4,
              passing: 5,
              armour: 10,
              currentValue: 150000,
              mng: true,
              status: "MissNextGame",
            },
            {
              id: "17854690",
              number: 2,
              name: "Grit",
              position: "Goblin Bruiser",
              positionId: "860402",
              skills: [],
              injuries: [],
              injuryDetails: [],
              spp: 0,
              earnedSpp: 0,
              advancements: 0,
              rank: "Experienced",
              mng: false,
              status: "Active",
            },
          ],
    });
    expect(result.body.team.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(result.body.team.players[0]!.primarySkills).not.toContain("Mighty Blow"); // Elite is fail-closed until runtime surcharge support exists.
    expect(result.body.team.players[0]!.primarySkills).toContain("Wrestle");
    expect(result.body.team.players[0]!.primarySkills).not.toContain("Block");
    expect(result.body.team.players[0]!.secondarySkills).toContain("Dodge");
  });

  it("resolves positions and progression from the team's rosterId roster", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    cpSync(join(FIXTURES, "team-detail.xml"), join(d.teamsDir, "team_Tarkin_1272390.xml"));
    const rostersDir = join(d.root, "rosters");
    mkdirSync(rostersDir);
    cpSync(join(FIXTURES, "roster-team-detail.xml"), join(rostersDir, "roster_8604.xml"));

    const result = teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", d);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error(result.body.error);
    expect(result.body.team.players).toMatchObject([
      {
        position: "Black Orc",
        rank: "Emerging Star",
        advancementCosts: { randomPrimary: 6, chosenPrimary: 12, chosenSecondary: 16, characteristic: 20 },
        movement: 4,
        strength: 4,
        agility: 4,
        passing: 5,
        armour: 10,
      },
      {
        position: "Goblin Bruiser",
        rank: "Experienced",
        movement: 6,
        strength: 2,
        agility: 3,
        passing: 4,
        armour: 8,
      },
    ]);
  });

  it("prefers the per-team roster when both roster files exist", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    cpSync(join(FIXTURES, "team-detail.xml"), join(d.teamsDir, "team_Tarkin_1272390.xml"));
    const rostersDir = join(d.root, "rosters");
    mkdirSync(rostersDir);
    cpSync(join(FIXTURES, "roster-team-detail.xml"), join(rostersDir, "roster_team_1272390.xml"));
    writeFileSync(
      join(rostersDir, "roster_8604.xml"),
      '<roster><position id="860401"><name>Wrong fallback</name><cost>10000</cost><movement>1</movement><strength>1</strength><agility>1</agility><passing>1</passing><armour>1</armour><skillList/><skillCategoryList/></position></roster>',
      "utf8",
    );

    const result = teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", d);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error(result.body.error);
    expect(result.body.team.players[0]).toMatchObject({
      position: "Black Orc",
      movement: 4,
      strength: 4,
      currentValue: 150000,
    });
  });

  it("keeps players ineligible with null characteristics when no roster file exists", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    cpSync(join(FIXTURES, "team-detail.xml"), join(d.teamsDir, "team_Tarkin_1272390.xml"));

    const result = teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", d);
    expect(result.status).toBe(200);
    if (result.status !== 200) throw new Error(result.body.error);
    expect(result.body.team.players).toHaveLength(2);
    expect(result.body.team.players).toSatisfy(
      (players: typeof result.body.team.players) => players.every((player) =>
        player.position === null &&
        player.rank === "Ineligible" &&
        player.advancementCosts === null &&
        player.movement === null &&
        player.strength === null &&
        player.agility === null &&
        player.passing === null &&
        player.armour === null),
    );
  });

  it("exposes exact league/rule metadata and role-aware whole-roster capability", () => {
    const d = dirs();
    upsertLibraryTeam(d.libraryDir, "Tarkin", STORED_TEAM);
    writeFileSync(join(d.teamsDir, "team_Tarkin_1272390.xml"), '<team id="1272390"><coach>Tarkin</coach><name>Fresh</name><race>Human</race><league>Old World Classic</league><specialRule>Favoured of Nuffle</specialRule><currentTeamValue>1000000</currentTeamValue><player status="Active" nr="1" id="p"><name>Rookie</name><positionId>h1</positionId><playerStatistics currentSpps="0"><games>0</games></playerStatistics><skillList/><injuryList/></player></team>', "utf8");
    const rostersDir = join(d.root, "rosters");
    mkdirSync(rostersDir);
    writeFileSync(join(rostersDir, "roster_team_1272390.xml"), '<roster><league>Old World Classic</league><specialRules><rule>Favoured of Nuffle</rule><rule>Bribery and Corruption</rule></specialRules><position id="h1"><name>Lineman</name><cost>50000</cost><movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList/><skillCategoryList><normal>General</normal><double>Agility</double></skillCategoryList></position></roster>', "utf8");

    const owner = teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", { ...d, tokenSecret: "secret" });
    if (owner.status !== 200) throw new Error(owner.body.error);
    expect(owner.body.team).toMatchObject({ leagues: ["Old World Classic"], specialRules: ["Favoured of Nuffle", "Bribery and Corruption"], canEditRoster: { available: false } });
    expect(owner.body.team.players[0]!.advancementMethods).toMatchObject({
      chosenSecondary: { available: false },
      chosenPrimary: { available: false, reason: "Needs 6 SPP; 0 available." },
    });

    const organizer = teamDetailEndpoint({ coach: "Tarkin", organizer: true }, "1272390", { ...d, tokenSecret: "secret" });
    if (organizer.status !== 200) throw new Error(organizer.body.error);
    expect(organizer.body.team.canEditRoster).toEqual({ available: true });

    const acquiredPath = join(d.teamsDir, "team_Tarkin_1272390.xml");
    writeFileSync(acquiredPath, readFileSync(acquiredPath, "utf8").replace("<skillList/>", "<skillList><skill>Wrestle</skill></skillList>"), "utf8");
    const progressed = teamDetailEndpoint({ coach: "Tarkin", organizer: true }, "1272390", { ...d, tokenSecret: "secret" });
    if (progressed.status !== 200) throw new Error(progressed.body.error);
    expect(progressed.body.team.canEditRoster).toMatchObject({ available: false });

    upsertLibraryTeam(d.libraryDir, "Tarkin", { ...STORED_TEAM, retired: true, retiredAt: "2026-08-22T00:00:00Z" });
    const retired = teamDetailEndpoint({ coach: "Tarkin", organizer: true }, "1272390", { ...d, tokenSecret: "secret" });
    if (retired.status !== 200) throw new Error(retired.body.error);
    expect(Object.values(retired.body.team.players[0]!.advancementMethods)).toSatisfy(
      (methods: Array<{ available: boolean; reason?: string }>) =>
        methods.every((method) => method.available === false && /Retired/.test(method.reason ?? "")),
    );
  });
});

describe("§3E schema widening", () => {
  const TEAM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<team id="1272390">
  <coach>Tarkin</coach>
  <name>Da &amp; Boyz</name>
  <race>Human</race>
  <rosterId>human</rosterId>
  <reRolls>2</reRolls>
  <fanFactor>3</fanFactor>
  <treasury>35000</treasury>
  <player nr="1" id="p1"><name>Fresh</name><gender>female</gender><positionId>lineman</positionId><skillList></skillList></player>
  <player status="journeyman" nr="2" id="p2"><name>Journey</name><gender>neutral</gender><positionId>lineman</positionId><skillList><skill value="4">Loner</skill></skillList></player>
<firedPlayers>
<firedPlayer reason="retired" nr="3" id="p3"><firedName>Gone</firedName><gender>male</gender><positionId>lineman</positionId><skillList></skillList></firedPlayer>
</firedPlayers>
</team>
`;
  const ROSTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<roster id="human"><name>Human</name><reRollCost>50000</reRollCost><nameGenerator>human</nameGenerator>
<position id="lineman"><quantity>16</quantity><name>Lineman</name><type>Regular</type><gender>random</gender><cost>50000</cost></position>
</roster>
`;

  async function widened(status?: string) {
    const { parseStoredTeamDetail } = await import("../src/teamDetail.js");
    const xml = status === undefined ? TEAM_XML : TEAM_XML.replace('<team id="1272390">', `<team id="1272390" status="${status}">`);
    return parseStoredTeamDetail(xml, STORED_TEAM, ROSTER_XML);
  }

  it("emits gender, journeyman, refundable, teamStatus, nameGenerator, and firedPlayers", async () => {
    const team = await widened();
    expect(team.teamStatus).toBe("0");
    expect(team.nameGenerator).toBe("human");
    expect(team.players.map((p) => p.gender)).toEqual(["female", "neutral"]);
    expect(team.players.map((p) => p.journeyman)).toEqual([false, true]);
    expect(team.players[0]!.refundable).toBe(true);
    // The journeyman's Loner skill counts as history, so it is not refundable.
    expect(team.players[1]!.refundable).toBe(false);
    expect(team.firedPlayers).toEqual([
      { id: "p3", name: "Gone", position: "Lineman", positionId: "lineman", reason: "retired" },
    ]);
  });

  it("kills refundable on a non-NEW team and reports the raw status", async () => {
    const team = await widened("1");
    expect(team.teamStatus).toBe("1");
    expect(team.players[0]!.refundable).toBe(false);
  });

  it("emits injuryDetails from the same nodes without changing injuries", async () => {
    const { parseStoredTeamDetail } = await import("../src/teamDetail.js");
    const xml = TEAM_XML.replace(
      "<skillList></skillList></player>",
      '<skillList></skillList><injuryList><injury>Head Injury (-AV)</injury><injury recovering="true">Broken Arm (-PA)</injury></injuryList></player>',
    );
    const team = parseStoredTeamDetail(xml, STORED_TEAM, ROSTER_XML);

    expect(team.players[0]!.injuries).toEqual(["Head Injury (-AV)", "Broken Arm (-PA)"]);
    expect(team.players[0]!.injuryDetails).toEqual([
      { name: "Head Injury (-AV)", recovering: false },
      { name: "Broken Arm (-PA)", recovering: true },
    ]);
  });
});
