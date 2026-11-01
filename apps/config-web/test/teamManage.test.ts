import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";
import { parseStoredTeamDetail, playerCareerStats, teamDetailEndpoint, storedRosterXml } from "../src/teamDetail.js";
import { libraryManageView, meTeamPath } from "../src/teamManageView.js";

// Team management page (owner 10-30): GET /api/me/teams/<ref> answers the coach's own team in the shared team view's
// shape plus per-player progression (fork library teams) or the read-only sheet (Tournament Builder saves).
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const root = mkdtempSync(join(tmpdir(), "team-manage-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const STORED: LibraryTeam = {
  teamId: "1272390", teamName: "Da & Boyz", race: "Black Orc", coach: "Tarkin", teamValue: 955, gold: 35000,
  rerolls: 2, fanFactor: 3, apothecary: true, forkLoadable: true, ingestedAt: "2026-08-19T12:00:00.000Z",
};

function dwarfRosterXml(): string {
  const r = findRoster(bb2025, "Dwarf")!;
  const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList></skillList></position>`,
  );
  return `<roster id="dwarf.bb2025"><name>Dwarf</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${positions.join("")}</roster>`;
}

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1",
    HOST: "127.0.0.1",
    PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"),
    ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"),
    FORK_BUILDER_SAVES_DIR: join(root, "saves"),
    FORK_TEAMS_DIR: join(root, "teams"),
    FORK_STATE_DIR: join(root, "state"),
    PACKAGES_DIR: join(root, "packages"),
    TOURNAMENTS_DIR: join(root, "tournaments"),
    FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const directory of ["library", "teams", "rosters", "packages", "tournaments", "log", "state"]) mkdirSync(join(root, directory), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "rosters", "dwarf.xml"), dwarfRosterXml(), "utf8");
  cpSync(join(FIXTURES, "team-detail.xml"), join(root, "teams", "team_Tarkin_1272390.xml"));
  cpSync(join(FIXTURES, "roster-team-detail.xml"), join(root, "rosters", "roster_team_1272390.xml"));
  upsertLibraryTeam(join(root, "library"), "Tarkin", STORED);
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("Tarkin", "Gondra87") }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const call = (method: string, path: string, token?: string, body?: unknown) =>
  fetch(`${origin}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("meTeamPath", () => {
  it("accepts library:, save: and bare save refs only", () => {
    expect(meTeamPath("/api/me/teams/library%3A1272390")).toBe("library:1272390");
    expect(meTeamPath("/api/me/teams/library:1272390")).toBe("library:1272390");
    expect(meTeamPath("/api/me/teams/sv_abc")).toBe("sv_abc");
    expect(meTeamPath("/api/me/teams/save:sv_abc")).toBe("save:sv_abc");
    for (const bad of ["/api/me/teams/", "/api/me/teams/a/b", "/api/me/teams/..%2Fx", "/api/me/teams/other:1", "/api/me/teams/%E0%A4%A"]) expect(meTeamPath(bad)).toBeUndefined();
  });
});

describe("libraryManageView", () => {
  it("maps the stored team to the shared view shape with progression and Add Skill / Add Characteristic flags", () => {
    const libraryDir = join(root, "library");
    const teamsDir = join(root, "teams");
    const detail = teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "1272390", { libraryDir, teamsDir, tokenSecret: "s" });
    if (detail.status !== 200) throw new Error(detail.body.error);
    const stored = readLibrary(libraryDir, "Tarkin")[0]!;
    const xml = '<team id="1272390"><rosterId>8604</rosterId></team>';
    const model = libraryManageView({ coach: "Tarkin", detail: detail.body.team, stored, rosterXml: storedRosterXml(teamsDir, "1272390", xml), publicDir: join(root, "nopublic") });
    expect(model.manage).toMatchObject({ kind: "library", ref: "library:1272390", teamId: "1272390", advancement: { available: true } });
    expect(model.manage.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(model.team).toMatchObject({ teamName: "Da & Boyz", raceName: "Black Orc", verdict: "On the fork", summary: { players: 2, total: 955000 } });
    const [bob, grit] = model.team.players;
    expect(bob).toMatchObject({ number: 1, name: "Big & Bob", printed: [{ name: "Brawler" }], stats: { MA: 4, ST: 4, AG: "4+", AV: "10+" } });
    expect(bob!.added.map((s) => s.name)).toEqual(["Block", "Guard"]);
    // Emerging Star (2 advancements): random Primary 6, chosen Primary 12, characteristic 20; 12 SPP to spend.
    expect(bob!.progress).toMatchObject({ spp: 12, rank: "Emerging Star", costs: { randomPrimary: 6, chosenPrimary: 12, chosenSecondary: 16, characteristic: 20 }, canAddSkill: true, canAddCharacteristic: false });
    expect(bob!.progress!.methods.chosenSecondary.available).toBe(false);
    expect(grit!.progress).toMatchObject({ spp: 0, canAddSkill: false, canAddCharacteristic: false });
    // Career stats come from the team XML <playerStatistics>: Bob has the element (touchdowns 1, the rest 0), Grit none.
    expect(bob!.careerStats).toEqual({ games: null, td: 1, cas: 0, comp: 0, int: 0, mvp: 0, fouls: 0, deflections: null, ni: 0 });
    expect(bob!.injuries).toEqual(["Smashed Knee"]);
    expect(bob!.valueBreakdown).toEqual({ base: 90000, added: 60000, total: bob!.cost });
    expect(bob!.cost).toBe(150000);
    expect(grit!.careerStats).toEqual({ games: null, td: null, cas: null, comp: null, int: null, mvp: null, fouls: null, deflections: null, ni: 0 });
    expect(grit!.injuries).toEqual([]);
    expect(grit!.valueBreakdown).toEqual({ base: 45000, added: 0, total: 45000 });
    const blocked = libraryManageView({ coach: "Tarkin", detail: detail.body.team, stored, publicDir: root, advancementBlocked: "no admin API" });
    expect(blocked.manage.advancement).toEqual({ available: false, reason: "no admin API" });
    expect(blocked.team.players[0]!.progress!.canAddSkill).toBe(false);
  });
});

describe("playerCareerStats", () => {
  it("reads the banked counters, counts Niggling Injuries and never invents games or deflections", () => {
    const block = `<player nr="3" id="9"><playerStatistics currentSpps="20" earnedSpps="31"><completions>4</completions><touchdowns>3</touchdowns>` +
      `<interceptions>1</interceptions><casualties>2</casualties><mvps>1</mvps><fouls>5</fouls><blocks>40</blocks><games>9</games></playerStatistics>` +
      `<injuryList><injury>Serious Injury (NI)</injury><injury>Niggling Injury</injury><injury>Head Injury (-AV)</injury></injuryList></player>`;
    expect(playerCareerStats(block, ["Serious Injury (NI)", "Niggling Injury", "Head Injury (-AV)"])).toEqual({
      games: null, td: 3, cas: 2, comp: 4, int: 1, mvp: 1, fouls: 5, deflections: null, ni: 2,
    });
    expect(playerCareerStats('<player><playerStatistics currentSpps="0"/></player>', [])).toMatchObject({ td: 0, cas: 0, fouls: 0, games: null });
    expect(playerCareerStats("<player><touchdowns>2</touchdowns></player>", [])).toMatchObject({ td: null, comp: null });
  });

  it("is carried on every parsed player with the roster's base cost", () => {
    const xml = `<team id="1"><player nr="1" id="p1"><name>A</name><positionId>860401</positionId><skillList/>` +
      `<playerStatistics currentSpps="2"><casualties>1</casualties></playerStatistics><injuryList/></player></team>`;
    const roster = '<roster><position id="860401"><name>Black Orc</name><cost>90000</cost><skillList/></position></roster>';
    const [p] = parseStoredTeamDetail(xml, { ...STORED, teamId: "1" }, roster).players;
    expect(p!.careerStats).toMatchObject({ cas: 1, td: 0 });
    expect(p!.baseValue).toBe(90000);
    expect(parseStoredTeamDetail(xml, { ...STORED, teamId: "1" }).players[0]!.baseValue).toBeNull();
  });
});

describe("GET /api/me/teams/:ref", () => {
  const tarkin = createSession("Tarkin");
  const gondra = createSession("Gondra87");

  it("requires a session", async () => {
    expect((await call("GET", "/api/me/teams/library%3A1272390")).status).toBe(401);
  });

  it("answers the owner's fork team with progression; advancement is blocked without the fork admin API", async () => {
    const res = await call("GET", "/api/me/teams/library%3A1272390", tarkin.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { team: any; manage: any };
    expect(body.manage).toMatchObject({ kind: "library", teamId: "1272390", treasury: 35000, teamValue: 955, advancement: { available: false } });
    expect(body.manage.advancement.reason).toMatch(/fork admin API/);
    expect(body.team.players[0].progress).toMatchObject({ id: "17854689", spp: 12, earnedSpp: null, advancements: 2, rank: "Emerging Star", canAddSkill: false });
    expect(body.team.players[0].progress.primarySkills.length).toBeGreaterThan(0);
  });

  it("another coach's team is not found", async () => {
    const res = await call("GET", "/api/me/teams/library%3A1272390", gondra.token);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Team not found." });
    expect((await call("GET", "/api/me/teams/library%3A999", tarkin.token)).status).toBe(404);
  });

  it("a Tournament Builder save is the read-only sheet; another coach's save is not found", async () => {
    const created = await call("POST", "/api/fork/team-builder/saves", tarkin.token, {
      name: "Grudge XI",
      body: { rosterId: "dwarf.bb2025", teamName: "Grudge XI", picks: [{ positionId: "1", count: 11, chosenSkills: [] }], reRolls: 2 },
    });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { save: { id: string } }).save.id;
    const res = await call("GET", `/api/me/teams/${id}`, tarkin.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { team: any; manage: any };
    expect(body.manage).toMatchObject({ kind: "save", saveId: id, advancement: { available: false } });
    expect(body.manage.advancement.reason).toMatch(/plays on the fork/);
    expect(body.team.teamName).toBe("Grudge XI");
    expect(body.team.ownerSaveId).toBeUndefined();
    expect(body.team.players[0].progress).toBeUndefined();
    expect((await call("GET", `/api/me/teams/save%3A${id}`, tarkin.token)).status).toBe(200);
    expect((await call("GET", `/api/me/teams/${id}`, gondra.token)).status).toBe(404);
  });
});
