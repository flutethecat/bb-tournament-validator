import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acknowledgeForkCacheReload, acquireTeamWriteLock, forkCacheReloadRequired, readLibrary, upsertLibraryTeam } from "@bb/fork-ops";
import { parseAdvancementAction, playerProgression, teamAdvancementEndpoint, teamRevision } from "../src/teamAdvancement.js";
import { teamDetailEndpoint } from "../src/teamDetail.js";

const roots: string[] = [];
const TEAM = `<team id="42" status="1"><coach>Tarkin</coach><name>Progress</name><race>Human</race><teamValue>1000000</teamValue><currentTeamValue>1000000</currentTeamValue><strength>100</strength><tournamentWeight>1000000</tournamentWeight><player status="Active" nr="1" id="p1"><name>Ace</name><positionId>h1</positionId><playerStatistics currentSpps="40" earnedSpps="7"></playerStatistics><skillList></skillList></player><player status="Active" nr="2" id="p2"><name>Bruised</name><positionId>h1</positionId><playerStatistics currentSpps="40"></playerStatistics><skillList></skillList><injuryList><injury recovering="true">SmashedKnee</injury></injuryList></player></team>`;
const BUILDER_TEAM = TEAM.replace("<teamValue>1000000</teamValue><currentTeamValue>1000000</currentTeamValue><strength>100</strength><tournamentWeight>1000000</tournamentWeight>", "<teamRating>100</teamRating><currentTeamValue>100</currentTeamValue><teamStrength>100</teamStrength>");
const ROSTER = `<roster team="42"><name>Human</name><position id="h1"><name>Human Lineman</name><movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><cost>50000</cost><skillList></skillList><skillCategoryList><normal>General</normal><double>Agility</double><double>Strength</double></skillCategoryList></position></roster>`;

function setup(team = TEAM) {
  const root = mkdtempSync(join(tmpdir(), "team-advancement-"));
  roots.push(root);
  const libraryDir = join(root, "library");
  const teamsDir = join(root, "teams");
  const rostersDir = join(root, "rosters");
  mkdirSync(teamsDir, { recursive: true });
  mkdirSync(rostersDir, { recursive: true });
  const file = join(teamsDir, "team_Tarkin_42.xml");
  writeFileSync(file, team, "utf8");
  writeFileSync(join(rostersDir, "roster_team_42.xml"), ROSTER, "utf8");
  upsertLibraryTeam(libraryDir, "Tarkin", { teamId: "42", teamName: "Progress", race: "Human", coach: "Tarkin", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-08-21T00:00:00Z" });
  let clock = 1_000;
  return { libraryDir, teamsDir, file, revision: teamRevision(team), tokenSecret: "test-secret", now: () => clock, setNow: (value: number) => { clock = value; }, randomIndex: (_length: number) => 0, isTeamActive: async () => false, reload: async () => ({ reloaded: true }) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const auth = { coach: "Tarkin", organizer: false };

describe("team progression mutation", () => {
  it("does not count a match-granted Trait as a player advancement", () => {
    const player = `<player id="p"><positionId>h1</positionId><skillList><skill value="orc">Hatred</skill><skill>Wrestle</skill></skillList></player>`;
    expect(playerProgression(player, ROSTER)).toMatchObject({ advancements: 1, rank: "Veteran" });
  });

  it("does not fabricate lifetime earned SPP for unaudited imported progression", () => {
    const imported = `<player id="p"><positionId>h1</positionId><playerStatistics currentSpps="4"/>` +
      `<skillList><skill>Wrestle</skill></skillList></player>`;
    expect(playerProgression(imported, ROSTER).earnedSpp).toBeNull();
  });

  it("applies canonical lasting injuries after +STAT skills when computing runtime characteristics", () => {
    const maxRoster = ROSTER
      .replace("<movement>6</movement>", "<movement>9</movement>")
      .replace("<strength>3</strength>", "<strength>8</strength>")
      .replace("<agility>3</agility>", "<agility>1</agility>")
      .replace("<passing>4</passing>", "<passing>1</passing>")
      .replace("<armour>9</armour>", "<armour>11</armour>");
    const injured = `<player id="p"><positionId>h1</positionId><skillList></skillList><injuryList>` +
      `<injury>Smashed Knee (-MA)</injury><injury>Dislocated Shoulder (-ST)</injury>` +
      `<injury>Dislocated Hip (-AG)</injury><injury>Broken Arm (-PA)</injury>` +
      `<injury>Head Injury (-AV)</injury></injuryList></player>`;
    expect(playerProgression(injured, maxRoster).characteristics).toEqual({ MA: 8, ST: 7, AG: 2, PA: 2, AV: 10 });
    const recoveredStrength = injured.replace("<skillList></skillList>", "<skillList><skill>+ST</skill></skillList>");
    expect(playerProgression(recoveredStrength, maxRoster).characteristics.ST).toBe(8);
  });

  it("applies a runtime-safe chosen Primary atomically and normalizes imported TV", async () => {
    const deps = setup();
    const result = await teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle" }, deps);
    expect(result.status).toBe(200);
    const xml = readFileSync(deps.file, "utf8");
    expect(xml).toContain('currentSpps="34"');
    expect(xml).toContain("<skill>Wrestle</skill>");
    expect(xml).toContain("<teamValue>1020000</teamValue>");
    expect(xml).toContain("<currentTeamValue>1020000</currentTeamValue>");
    expect(readLibrary(deps.libraryDir, "Tarkin")[0]?.teamValue).toBe(1020);
  });

  it("uses native 10k units for Team Builder XML and reports thousands in library metadata", async () => {
    const deps = setup(BUILDER_TEAM);
    const result = await teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle" }, deps);
    expect(result.status).toBe(200);
    const xml = readFileSync(deps.file, "utf8");
    expect(xml).toContain("<teamRating>102</teamRating>");
    expect(xml).toContain("<currentTeamValue>102</currentTeamValue>");
    expect(xml).toContain("<teamStrength>102</teamStrength>");
    expect(readLibrary(deps.libraryDir, "Tarkin")[0]?.teamValue).toBe(1020);
  });

  it("fails closed without changing XML when advancement TV aggregates are missing, malformed, or duplicated", async () => {
    for (const broken of [
      TEAM.replace("<currentTeamValue>1000000</currentTeamValue><strength>100</strength>", ""),
      TEAM.replace("<teamValue>1000000</teamValue>", "<teamValue>NaN</teamValue>"),
      TEAM.replace("<teamValue>1000000</teamValue>", "<teamValue>1000000</teamValue><teamValue>1000000</teamValue>"),
      TEAM.replace("<strength>100</strength>", "<strength>9007199254740991</strength>"),
    ]) {
      const deps = setup(broken);
      const result = await teamAdvancementEndpoint(auth, "42", {
        action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle",
      }, deps);
      expect(result.status).toBe(500);
      expect(readFileSync(deps.file, "utf8")).toBe(broken);
    }
  });

  it("never mistakes a player's strength element for a legacy team aggregate", async () => {
    const withoutTeamStrength = TEAM.replace("<strength>100</strength>", "").replace("<positionId>h1</positionId>", "<positionId>h1</positionId><strength>3</strength>");
    const deps = setup(withoutTeamStrength);
    expect((await teamAdvancementEndpoint(auth, "42", {
      action: "applySkill",
      playerId: "p1",
      revision: deps.revision,
      method: "chosenPrimary",
      skill: "Wrestle",
    }, deps)).status).toBe(200);
    expect(readFileSync(deps.file, "utf8")).toContain("<strength>3</strength>");
  });

  it("persists and debits one Random Primary reservation, then reissues the same options", async () => {
    const deps = setup();
    const first = await teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General" }, deps);
    if (first.status !== 200 || !("pending" in first.body)) throw new Error("expected pending");
    const afterFirst = readFileSync(deps.file, "utf8");
    expect(afterFirst).toContain('currentSpps="37"');
    deps.setNow(2_000);
    const second = await teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: first.body.pending.revision, category: "General" }, deps);
    if (second.status !== 200 || !("pending" in second.body)) throw new Error("expected reissue");
    expect(second.body.pending.choices).toEqual(first.body.pending.choices);
    expect(readFileSync(deps.file, "utf8")).toBe(afterFirst);
  });

  it("keeps the same debited reservation when reload fails after the roll write", async () => {
    const deps = setup();
    let calls = 0;
    const randomIndex = (length: number) => (calls++ % length);
    const first = await teamAdvancementEndpoint(auth, "42", {
      action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General",
    }, { ...deps, randomIndex, reload: async () => ({ reloaded: false, reason: "busy" }) });
    if (first.status !== 200 || !("pending" in first.body)) throw new Error("expected durable pending");
    const after = readFileSync(deps.file, "utf8");
    expect(after).toContain('currentSpps="37"');
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(true);
    // A successful operator/startup reload acknowledges the exact on-disk pending generation.
    acknowledgeForkCacheReload(deps.teamsDir);
    expect(forkCacheReloadRequired(deps.teamsDir)).toBe(false);
    const callsAfterFirst = calls;
    const second = await teamAdvancementEndpoint(auth, "42", {
      action: "rollRandomPrimary", playerId: "p1", revision: first.body.pending.revision, category: "General",
    }, { ...deps, randomIndex, reload: async () => ({ reloaded: false, reason: "busy" }) });
    if (second.status !== 200 || !("pending" in second.body)) throw new Error("expected reissued pending");
    expect(second.body.pending.choices).toEqual(first.body.pending.choices);
    expect(calls).toBe(callsAfterFirst);
    expect(readFileSync(deps.file, "utf8")).toBe(after);
  });

  it("survives restart/detail read, rejects tampering, and commits exactly once", async () => {
    const deps = setup();
    const rolled = await teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General" }, deps);
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected pending");
    const detail = teamDetailEndpoint(auth, "42", deps);
    if (detail.status !== 200) throw new Error(detail.body.error);
    const pending = detail.body.team.players[0]!.pendingAdvancement!;
    expect(pending.choices).toEqual(rolled.body.pending.choices);
    expect((await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: pending.revision, token: `${pending.token}x`, choice: { type: "skill", skill: pending.choices[0]! } }, deps)).status).toBe(409);
    expect((await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: pending.revision, token: `${pending.token}.junk`, choice: { type: "skill", skill: pending.choices[0]! } }, deps)).status).toBe(409);
    const committed = await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: pending.revision, token: pending.token, choice: { type: "skill", skill: pending.choices[0]! } }, deps);
    expect(committed.status).toBe(200);
    if (committed.status !== 200 || !("ok" in committed.body)) throw new Error("expected commit");
    expect(readFileSync(deps.file, "utf8")).not.toContain("pendingAdvancement");
    expect((await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: committed.body.revision, token: pending.token, choice: { type: "skill", skill: pending.choices[0]! } }, deps)).status).toBe(409);
  });

  it("expires transport tokens but reissues the durable reservation without rerolling", async () => {
    const deps = setup();
    const rolled = await teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p1", revision: deps.revision }, deps);
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected pending");
    deps.setNow(700_000);
    expect((await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p1", revision: rolled.body.pending.revision, token: rolled.body.pending.token, choice: { type: "characteristic", characteristic: "AV" } }, deps)).status).toBe(409);
    const reissued = await teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p1", revision: rolled.body.pending.revision }, deps);
    if (reissued.status !== 200 || !("pending" in reissued.body)) throw new Error("expected reissue");
    expect(reissued.body.pending).toMatchObject({ roll: rolled.body.pending.roll, choices: rolled.body.pending.choices });
  });

  it("allows only one outstanding roll across a team", async () => {
    const deps = setup();
    const rolled = await teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General" }, deps);
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected pending");
    expect((await teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p2", revision: rolled.body.pending.revision }, deps)).status).toBe(409);
  });

  it("fails closed when stored XML contains malformed or multiple pending reservations", async () => {
    const malformed = TEAM.replace(
      "</player>",
      '<pendingAdvancement nonce="n" method="randomPrimary" cost="NaN" expiresAt="1"><option type="choice">Wrestle</option><option type="choice">Tackle</option></pendingAdvancement></player>',
    );
    const malformedDeps = setup(malformed);
    expect((await teamAdvancementEndpoint(auth, "42", {
      action: "rollRandomPrimary",
      playerId: "p1",
      revision: malformedDeps.revision,
      category: "General",
    }, malformedDeps)).status).toBe(409);

    const pending = '<pendingAdvancement nonce="n" method="randomPrimary" cost="3" expiresAt="1000" category="General"><option type="choice">Wrestle</option><option type="choice">Tackle</option></pendingAdvancement>';
    const multiple = TEAM.replace("</player>", `${pending}${pending}</player>`);
    const multipleDeps = setup(multiple);
    expect((await teamAdvancementEndpoint(auth, "42", {
      action: "rollRandomPrimary",
      playerId: "p1",
      revision: multipleDeps.revision,
      category: "General",
    }, multipleDeps)).status).toBe(409);
  });

  it("stores characteristics canonically as +STAT skills and excludes MNG value from CTV", async () => {
    const deps = setup();
    const rolled = await teamAdvancementEndpoint(auth, "42", { action: "rollCharacteristic", playerId: "p2", revision: deps.revision }, deps);
    if (rolled.status !== 200 || !("pending" in rolled.body)) throw new Error("expected pending");
    const committed = await teamAdvancementEndpoint(auth, "42", { action: "commitRoll", playerId: "p2", revision: rolled.body.pending.revision, token: rolled.body.pending.token, choice: { type: "characteristic", characteristic: "AV" } }, deps);
    expect(committed.status).toBe(200);
    const xml = readFileSync(deps.file, "utf8");
    expect(xml).toContain("<skill>+AV</skill>");
    expect(xml).toContain("<teamValue>1010000</teamValue>");
    expect(xml).toContain("<currentTeamValue>1000000</currentTeamValue>");
    expect(xml).toContain("<strength>100</strength>");
  });

  it("fails closed for Secondary, Elite, hostile fields, and invalid randomness", async () => {
    const deps = setup();
    expect((await teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenSecondary", skill: "Dodge" }, deps)).status).toBe(422);
    expect((await teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Block" }, deps)).status).toBe(422);
    expect(parseAdvancementAction({ action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle", cost: Number.NaN }).ok).toBe(false);
    expect(parseAdvancementAction({ action: "commitRoll", playerId: "p1", revision: deps.revision, token: "x", choice: { type: "skill", skill: "Dodge", access: "secondary", cost: 0 } }).ok).toBe(false);
    expect((await teamAdvancementEndpoint(auth, "42", { action: "rollRandomPrimary", playerId: "p1", revision: deps.revision, category: "General" }, { ...deps, randomIndex: () => Number.NaN })).status).toBe(500);
  });

  it("fails closed for ownership, stale revision, active games, and concurrent writers", async () => {
    const deps = setup();
    const action = { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle" };
    expect((await teamAdvancementEndpoint({ coach: "Other", organizer: false }, "42", action, deps)).status).toBe(404);
    expect((await teamAdvancementEndpoint(auth, "42", { ...action, revision: "0".repeat(64) }, deps)).status).toBe(409);
    expect((await teamAdvancementEndpoint(auth, "42", action, { ...deps, isTeamActive: undefined })).status).toBe(503);
    expect((await teamAdvancementEndpoint(auth, "42", action, { ...deps, isTeamActive: async () => { throw new Error("offline"); } })).status).toBe(503);
    expect((await teamAdvancementEndpoint(auth, "42", action, { ...deps, isTeamActive: async () => true })).status).toBe(409);
    const held = acquireTeamWriteLock(deps.teamsDir, "42")!;
    try { expect((await teamAdvancementEndpoint(auth, "42", action, deps)).status).toBe(409); } finally { held.release(); }
  });

  it("rolls back XML and SPP when fork reload refuses the mutation", async () => {
    const deps = setup();
    const result = await teamAdvancementEndpoint(auth, "42", { action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle" }, { ...deps, reload: async () => ({ reloaded: false, reason: "busy" }) });
    expect(result.status).toBe(500);
    expect(readFileSync(deps.file, "utf8")).toBe(TEAM);
    expect(readLibrary(deps.libraryDir, "Tarkin")[0]?.teamValue).toBe(1000);
  });

  it("rolls back when a game starts between the activity precheck and commit", async () => {
    const deps = setup();
    let checks = 0;
    const result = await teamAdvancementEndpoint(auth, "42", {
      action: "applySkill", playerId: "p1", revision: deps.revision, method: "chosenPrimary", skill: "Wrestle",
    }, { ...deps, isTeamActive: async () => ++checks > 1 });
    expect(result.status).toBe(409);
    expect(readFileSync(deps.file, "utf8")).toBe(TEAM);
    expect(readLibrary(deps.libraryDir, "Tarkin")[0]?.teamValue).toBe(1000);
  });
});
