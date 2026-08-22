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
