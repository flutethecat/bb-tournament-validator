import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readLibrary, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository, headRevision } from "../src/tabletop/store.js";
import { parseTeamRef, teamFileFromLibraryDetail } from "../src/tabletop/teamFile.js";
import { teamDetailEndpoint } from "../src/teamDetail.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOW = new Date("2026-03-01T10:00:00.000Z");
const LIB_TEAM: LibraryTeam = {
  teamId: "1272390", teamName: "Da & Boyz", race: "Black Orc", coach: "Tarkin", teamValue: 955, gold: 35000, rerolls: 2,
  fanFactor: 3, apothecary: true, forkLoadable: true, ingestedAt: "2026-08-19T12:00:00.000Z",
};
let root = "";
let libraryDir = "";
let teamsDir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;

const detailFor = (coach: string, id: string) => teamDetailEndpoint({ coach, organizer: false }, id, { libraryDir, teamsDir });
const saveFile: TabletopTeamFile = {
  schema: 1, name: "Bob XI", treasury: 0, dedicatedFans: 1,
  players: [{ id: "b1", name: "b 1", spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }],
};

const deps = (): TabletopApiDeps => ({
  repo, results,
  // mirrors server.ts: library:<id> -> the real stored team; anything else -> a builder save
  loadTeamFile: (coach, ref) => {
    if (ref.startsWith("library:")) {
      const d = detailFor(coach, ref.slice("library:".length));
      return d.status === 200 ? teamFileFromLibraryDetail(d.body.team) : undefined;
    }
    return coach === "Bob" && ref === "sv_bob" ? saveFile : undefined;
  },
  listSaves: (coach) => (coach === "Bob" ? [{ id: "sv_bob", name: "Bob XI" }] : []),
  listTeams: (coach) => [
    ...readLibrary(libraryDir, coach).map((t) => ({ ref: `library:${t.teamId}`, name: t.teamName, race: t.race, tv: t.teamValue })),
    ...(coach === "Bob" ? [{ ref: "sv_bob", name: "Bob XI", race: "Orc", tv: null }] : []),
  ],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => NOW,
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return (await tabletopApi(method, p!, { coach, method: "discord" }, body, deps(), new URLSearchParams(q ?? "")))!;
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tabletop-library-"));
  libraryDir = join(root, "library");
  teamsDir = join(root, "teams");
  mkdirSync(teamsDir, { recursive: true });
  upsertLibraryTeam(libraryDir, "Tarkin", LIB_TEAM);
  cpSync(join(FIXTURES, "team-detail.xml"), join(teamsDir, "team_Tarkin_1272390.xml"));
  repo = new FileTabletopRepository(join(root, "tt"));
  results = new TournamentResultStore(join(root, "results"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("team refs", () => {
  it("parses library:, save: and bare ids", () => {
    expect(parseTeamRef("library:1272390")).toEqual({ ref: "library:1272390", kind: "library", id: "1272390" });
    expect(parseTeamRef("save:sv_x")).toEqual({ ref: "sv_x", kind: "save", id: "sv_x" });
    expect(parseTeamRef("sv_x")).toEqual({ ref: "sv_x", kind: "save", id: "sv_x" });
    expect(parseTeamRef("nope:1")).toBeUndefined();
    expect(parseTeamRef("library:")).toBeUndefined();
    expect(parseTeamRef(5)).toBeUndefined();
  });
});

describe("baseline from a fork library team", () => {
  it("maps the stored team file: players, SPP, injuries, MNG, treasury, rerolls, apothecary, fans", () => {
    const d = detailFor("Tarkin", "1272390");
    if (d.status !== 200) throw new Error(d.body.error);
    const file = teamFileFromLibraryDetail(d.body.team);
    expect(file).toMatchObject({ schema: 1, name: "Da & Boyz", race: "Black Orc", treasury: 35000, dedicatedFans: 3, rerolls: 2, apothecary: true, assistantCoaches: 1, cheerleaders: 2 });
    expect(file.players.map((p) => p.id)).toEqual(["17854689", "17854690"]);
    expect(file.players[0]).toMatchObject({
      name: "Big & Bob", number: 1, positionId: "860401", spp: 12, skills: ["Block", "Guard"], mng: true, niggles: 1, injuries: ["Smashed Knee"], dead: false,
    });
    expect(file.players[1]).toMatchObject({ number: 2, mng: false, niggles: 0 });
  });
});

describe("tabletop create with library refs", () => {
  it("creates from a library ref, stores revisions under library:<id>, and plays on the real roster", async () => {
    const created = await as("Tarkin", "POST", "/api/tabletop/matches", {
      pregame: "skip", home: { coach: "Tarkin", team: "library:1272390" }, away: { coach: "Bob", team: "save:sv_bob" }, postMatch: "spp-only",
    });
    expect(created.status).toBe(201);
    const match = (created.body as { match: { id: string; home: { teamSaveId: string; teamName: string }; away: { teamSaveId: string } } }).match;
    expect(match.home).toMatchObject({ teamSaveId: "library:1272390", teamName: "Da & Boyz" });
    expect(match.away.teamSaveId).toBe("sv_bob"); // a save keeps its bare id
    const chain = (await repo.getChain("Tarkin", "library:1272390"))!;
    expect(headRevision(chain).teamFile.players).toHaveLength(2);

    // the MNG library player cannot play; the other can score
    const bad = await as("Tarkin", "POST", `/api/tabletop/matches/${match.id}/events`, { events: [{ id: "evt-lib-0001", type: "touchdown", team: "home", player: "17854689" }] });
    expect(bad.status).toBe(400);
    const ok = await as("Tarkin", "POST", `/api/tabletop/matches/${match.id}/events`, { events: [{ id: "evt-lib-0002", type: "touchdown", team: "home", player: "17854690" }] });
    expect(ok.status).toBe(200);
    await as("Tarkin", "POST", `/api/tabletop/matches/${match.id}/submit`);
    expect((await as("Org", "POST", `/api/tabletop/matches/${match.id}/confirm`)).status).toBe(200);
    const after = headRevision((await repo.getChain("Tarkin", "library:1272390"))!);
    expect(after.revision).toBe(1);
    expect(after.teamFile.players.find((p) => p.id === "17854690")!.spp).toBe(3);
    expect(after.teamFile.players.find((p) => p.id === "17854689")!.mng).toBe(false); // sat the match out
    expect(after.teamFile).toMatchObject({ race: "Black Orc", rerolls: 2, apothecary: true });
    expect(results.listAll()[0]).toMatchObject({ home: { teamId: "library:1272390" }, away: { teamId: "sv_bob" } });
  });

  it("still accepts the old teamSaveId field and a bare id", async () => {
    const r = await as("Bob", "POST", "/api/tabletop/matches", {
      pregame: "skip", home: { coach: "Bob", teamSaveId: "sv_bob" }, away: { coach: "Tarkin", team: "library:1272390" },
    });
    expect(r.status).toBe(201);
  });

  it("names the kind when a team is missing, and never resolves another coach's library team", async () => {
    const mk = (home: object, away: object) => as("Org", "POST", "/api/tabletop/matches", { pregame: "skip", home, away });
    const missingLib = await mk({ coach: "Tarkin", team: "library:999" }, { coach: "Bob", team: "sv_bob" });
    expect(missingLib.status).toBe(404);
    expect(missingLib.body).toEqual({ error: "Tarkin has no library team library:999." });
    const missingSave = await mk({ coach: "Tarkin", team: "library:1272390" }, { coach: "Bob", team: "sv_nope" });
    expect(missingSave.body).toEqual({ error: "Bob has no saved team sv_nope." });
    const theirs = await mk({ coach: "Tarkin", team: "library:1272390" }, { coach: "Bob", team: "library:1272390" });
    expect(theirs.status).toBe(404);
    expect((theirs.body as { error: string }).error).toMatch(/^Bob has no library team/);
    expect((await mk({ coach: "Tarkin", team: "library:" }, { coach: "Bob", team: "sv_bob" })).status).toBe(400);
  });
});

describe("saves lookup shape", () => {
  it("returns teams (library + saves) with ref, name, race, tv, and keeps the old saves array", async () => {
    const tarkin = await as("Bob", "GET", "/api/tabletop/saves?coach=Tarkin");
    expect(tarkin.body).toEqual({ coach: "Tarkin", saves: [], teams: [{ ref: "library:1272390", name: "Da & Boyz", race: "Black Orc", tv: 955 }] });
    const bob = await as("Tarkin", "GET", "/api/tabletop/saves?coach=Bob");
    expect(bob.body).toEqual({
      coach: "Bob", saves: [{ id: "sv_bob", name: "Bob XI" }], teams: [{ ref: "sv_bob", name: "Bob XI", race: "Orc", tv: null }],
    });
  });
});
