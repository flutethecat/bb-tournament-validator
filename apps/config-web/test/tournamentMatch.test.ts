import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LibraryTeam } from "@bb/fork-ops";
import {
  TournamentMatchAccessError,
  TournamentMatchStore,
  buildInstructions,
  ensureTournamentInducementSetXml,
  instructionsForSession,
  type TournamentMatchInstructions,
  type TournamentMatchMetadata,
} from "../src/tournamentMatch.js";

const roots: string[] = [];

function team(over: Partial<LibraryTeam> = {}): LibraryTeam {
  return {
    teamId: "home-team",
    teamName: "Home Team",
    race: "Human",
    coach: "Tarkin",
    teamValue: 1_000,
    gold: 0,
    forkLoadable: true,
    ingestedAt: "2026-08-20T00:00:00.000Z",
    ...over,
  };
}

const instructions = (treasury: number): TournamentMatchInstructions => ({
  treasury,
  inducements: [],
});

function match(): TournamentMatchMetadata {
  return {
    gameId: "42",
    packageName: "Spike Cup",
    home: { ffbCoachId: "Tarkin", teamId: "home-team", instructions: instructions(80_000) },
    away: { ffbCoachId: "Gondra87", teamId: "away-team", instructions: instructions(100_000) },
    createdAt: "2026-08-20T12:00:00.000Z",
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("buildInstructions", () => {
  it("reports inducement-only wire gold and ignores rostered Star metadata", () => {
    expect(buildInstructions(team({
      rosteredInducements: [{ key: "bloodweiser_kegs", count: 2 }],
      rosteredStars: ["Akhorne the Squirrel"],
    }))).toEqual({
      treasury: 100_000,
      inducements: [{ key: "bloodweiser_kegs", count: 2 }],
    });
  });

  it("uses the catalog's reduced wire price when the stored team carries its rule", () => {
    expect(buildInstructions(team({
      rosteredInducements: [{ key: "bribes", count: 2 }],
    }), ["Bribery and Corruption"])).toEqual({
      treasury: 100_000,
      inducements: [{ key: "bribes", count: 2 }],
    });
  });

  it("throws rather than guessing an unresolved price", () => {
    expect(() => buildInstructions(team({ rosteredInducements: [{ key: "mystery_box", count: 1 }] })))
      .toThrow(/cannot resolve inducement price/i);
    expect(() => buildInstructions(team({ rosteredInducements: [{ key: "infamous_coaching_staff", count: 1 }] })))
      .toThrow(/fixed wire-gold price/i);
  });
});

describe("TournamentMatchStore", () => {
  it("atomically round-trips metadata by game id", () => {
    const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-match-"));
    roots.push(root);
    const store = new TournamentMatchStore(root);
    const metadata = match();

    expect(store.get(metadata.gameId)).toBeUndefined();
    store.put(metadata);
    expect(store.get(metadata.gameId)).toEqual(metadata);
    expect(readdirSync(root)).toEqual(["tournament-matches.json"]);
  });
});

describe("instructions access", () => {
  it("lets a coach fetch only their own side, case-insensitively", () => {
    expect(instructionsForSession(match(), { coach: "tArKiN", admin: false })).toEqual(instructions(80_000));
    expect(() => instructionsForSession(match(), { coach: "Tarkin", admin: false }, "away"))
      .toThrow(TournamentMatchAccessError);
    expect(() => instructionsForSession(match(), { coach: "outsider", admin: false }))
      .toThrow(/only your own/i);
  });

  it("projects legacy stored instructions to the current star-free response shape", () => {
    const legacy = match();
    (legacy.home.instructions as TournamentMatchInstructions & { stars: string[] }).stars = ["Legacy Star"];
    expect(instructionsForSession(legacy, { coach: "Tarkin", admin: false })).toEqual(instructions(80_000));
  });

  it("lets an admin select either side explicitly", () => {
    expect(instructionsForSession(match(), { coach: "RootAdmin", admin: true }, "away"))
      .toEqual(instructions(100_000));
    expect(() => instructionsForSession(match(), { coach: "RootAdmin", admin: true }))
      .toThrow(/must specify/i);
  });
});

describe("ensureTournamentInducementSetXml", () => {
  it("retrofits only a missing predefined-inducement block and keeps treasury zero", () => {
    const legacy = "<team><treasury>0</treasury><name>XI</name></team>";
    const rostered = team({ rosteredInducements: [{ key: "bloodweiser_kegs", count: 2 }] });
    const upgraded = ensureTournamentInducementSetXml(rostered, legacy);
    expect(upgraded).toContain("<treasury>0</treasury>");
    expect(upgraded).toContain('<inducement type="bloodweiserBabes" value="2" uses="0"/>');
    expect(upgraded).not.toContain("<starPlayerSet>");
    expect(ensureTournamentInducementSetXml(rostered, upgraded)).toBe(upgraded);
    expect(ensureTournamentInducementSetXml(team(), legacy)).toBe(legacy);
    expect(() => ensureTournamentInducementSetXml(team(), upgraded)).toThrow(/unexpected/i);
    expect(() => ensureTournamentInducementSetXml(rostered, upgraded.replace('value="2"', 'value="1"')))
      .toThrow(/does not match/i);
    expect(() => ensureTournamentInducementSetXml(rostered, legacy.replace("0", "1")))
      .toThrow(/treasury>0/i);
  });
});
