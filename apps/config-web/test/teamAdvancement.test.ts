import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLibrary, upsertLibraryTeam } from "@bb/fork-ops";
import { playerProgression, teamAdvancementEndpoint, teamRevision, type AdvancementAction } from "../src/teamAdvancement.js";

const roots: string[] = [];
const TEAM = `<team id="42" status="1"><coach>Tarkin</coach><name>Progress</name><race>Human</race><teamValue>1000000</teamValue><currentTeamValue>1000000</currentTeamValue><strength>100</strength><tournamentWeight>1000000</tournamentWeight><player status="Active" nr="1" id="p1"><name>Ace</name><positionId>h1</positionId><playerStatistics currentSpps="40" earnedSpps="7"></playerStatistics><skillList></skillList></player><player status="MissNextGame" mng="true" nr="2" id="p2"><name>Bruised</name><positionId>h1</positionId><playerStatistics currentSpps="40"></playerStatistics><skillList></skillList></player></team>`;
const ROSTER = `<roster team="42"><name>Human</name><position id="h1"><name>Human Lineman</name><movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList></skillList><skillCategoryList><normal>General</normal><double>Agility</double><double>Strength</double></skillCategoryList></position></roster>`;

function setup() {
  const root = mkdtempSync(join(tmpdir(), "team-advancement-"));
  roots.push(root);
  const libraryDir = join(root, "library");
  const teamsDir = join(root, "teams");
  const rostersDir = join(root, "rosters");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(rostersDir, { recursive: true });
  const file = join(teamsDir, "team_Tarkin_42.xml");
  writeFileSync(file, TEAM, "utf8");
  writeFileSync(join(rostersDir, "roster_team_42.xml"), ROSTER, "utf8");
  upsertLibraryTeam(libraryDir, "Tarkin", { teamId: "42", teamName: "Progress", race: "Human", coach: "Tarkin", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-21T00:00:00Z" });
  return { libraryDir, teamsDir, file, revision: teamRevision(TEAM), tokenSecret: "test-secret", now: () => 1_000, randomIndex: (_length: number) => 0 };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const auth = { coach: "Tarkin", organizer: false };

describe("team progression mutation", () => {
  it("does not count a match-granted Trait as a player advancement", () => {
    const player = `<player id="p"><positionId>h1</positionId><skillList><skill value="orc">Hatred</skill><skill>Block</skill></skillList></player>`;
    expect(playerProgression(player, ROSTER)).toMatchObject({ advancements: 1, rank: "Veteran" });
  });

  it("applies a chosen Primary skill atomically, debits SPP, records audit, and updates value", () => {
    const deps = setup();
    const result = teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Block" }, deps);
    expect(result.status).toBe(200);
    if (result.status !== 200 || !("ok" in result.body)) throw new Error("expected commit");
    const xml = readFileSync(deps.file, "utf8");
    expect(xml).toContain('currentSpps="34"');
    expect(xml).toContain("<skill>Block</skill>");
    expect(xml).toContain('method="chosenPrimary"');
    expect(xml).toContain("<teamValue>1030000</teamValue>");
    expect(xml).toContain("<currentTeamValue>1030000</currentTeamValue>");
    expect(result.body.revision).toBe(teamRevision(xml));
    expect(readLibrary(deps.libraryDir, "Tarkin")[0]?.teamValue).toBe(1030);
  });

  it("generates a signed Random Primary choice and rejects tampering", () => {
    const deps = setup();
    const rolled = teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General" }, deps);
    expect(rolled.status).toBe(200);
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected roll");
    expect(rolled.body.pending.choices).toHaveLength(2);
    const action: AdvancementAction = { action: "commitRoll", playerId: "p1", revision: deps.revision, token: `${rolled.body.pending.token}x`, choice: { type: "skill", skill: rolled.body.pending.choices[0]! } };
    expect(teamAdvancementEndpoint(auth, "42", action, deps)).toEqual({ status: 409, body: { error: "That roll is invalid, expired, or belongs to an older team revision." } });
    expect(readFileSync(deps.file, "utf8")).toBe(TEAM);
  });

  it("commits a server-rolled Characteristic and does not add MNG value to CTV", () => {
    const deps = setup();
    const rolled = teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p2", revision: deps.revision }, { ...deps, randomIndex: () => 0 });
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected characteristic roll");
    expect(rolled.body.pending).toMatchObject({ method: "characteristic", roll: 1, choices: ["AV"] });
    const committed = teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p2", revision: deps.revision, token: rolled.body.pending.token, choice: { type: "characteristic", characteristic: "AV" } }, deps);
    expect(committed.status).toBe(200);
    const xml = readFileSync(deps.file, "utf8");
    expect(xml).toContain("<armour>10</armour>");
    expect(xml).toContain("<teamValue>1010000</teamValue>");
    expect(xml).toContain("<currentTeamValue>1000000</currentTeamValue>");
  });

  it("prices a Characteristic-roll Secondary fallback as a Secondary skill", () => {
    const deps = setup();
    const rolled = teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p1", revision: deps.revision }, { ...deps, randomIndex: () => 0 });
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected characteristic roll");
    const committed = teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: deps.revision, token: rolled.body.pending.token, choice: { type: "skill", access: "secondary", skill: "Dodge" } }, deps);
    expect(committed.status).toBe(200);
    if (committed.status !== 200 || !("ok" in committed.body)) throw new Error("expected commit");
    expect(committed.body.valueIncrease).toBe(50_000); // 40k Secondary + 10k Elite Dodge
    expect(readFileSync(deps.file, "utf8")).toContain('skillAccess="secondary"');
  });

  it("fails closed for another coach and for a stale revision", () => {
    const deps = setup();
    const action: AdvancementAction = { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Block" };
    expect(teamAdvancementEndpoint({ coach: "Other", organizer: false }, "42", action, deps).status).toBe(404);
    expect(teamAdvancementEndpoint(auth, "42", { ...action, revision: "stale" }, deps).status).toBe(409);
  });

  it("rejects a concurrent writer without touching the XML", () => {
    const deps = setup();
    writeFileSync(`${deps.file}.advancement.lock`, "held", "utf8");
    const result = teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Block" }, deps);
    expect(result).toEqual({ status: 409, body: { error: "Another team update is in progress. Refresh and try again." } });
    expect(readFileSync(deps.file, "utf8")).toBe(TEAM);
  });
});
