import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

    expect(teamDetailEndpoint({ coach: "tArKiN", organizer: false }, "1272390", d)).toEqual({
      status: 200,
      body: {
        team: {
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
              mng: false,
              status: "Active",
            },
          ],
        },
      },
    });
  });
});
