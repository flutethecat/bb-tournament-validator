import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLibrary, removeLibraryTeam, upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bb-lib-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const team = (over: Partial<LibraryTeam>): LibraryTeam => ({
  teamId: "1",
  teamName: "Team",
  race: "Gnome",
  coach: "Flutethecat",
  teamValue: 1000,
  gold: 50000,
  forkLoadable: true,
  ingestedAt: "2026-07-08T12:00:00Z",
  ...over,
});

describe("library store", () => {
  it("returns an empty array for an unknown coach", () => {
    expect(readLibrary(dir, "Nobody")).toEqual([]);
  });

  it("upserts teams and reads them back sorted by name", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "2", teamName: "Zzz" }));
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "Aaa" }));
    const teams = readLibrary(dir, "Flutethecat");
    expect(teams.map((t) => t.teamName)).toEqual(["Aaa", "Zzz"]);
  });

  it("replaces (not duplicates) a team with the same teamId", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "Old", gold: 1 }));
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "New", gold: 999 }));
    const teams = readLibrary(dir, "Flutethecat");
    expect(teams).toHaveLength(1);
    expect(teams[0]!.teamName).toBe("New");
    expect(teams[0]!.gold).toBe(999);
  });

  it("keeps coaches' libraries separate and is case-insensitive on the coach key", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    upsertLibraryTeam(dir, "Gondra87", team({ teamId: "9", coach: "Gondra87" }));
    expect(readLibrary(dir, "flutethecat")).toHaveLength(1); // same file, case-insensitive
    expect(readLibrary(dir, "Gondra87")).toHaveLength(1);
  });

  it("removes a team by id", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "2" }));
    const after = removeLibraryTeam(dir, "Flutethecat", "1");
    expect(after.map((t) => t.teamId)).toEqual(["2"]);
    expect(readLibrary(dir, "Flutethecat").map((t) => t.teamId)).toEqual(["2"]);
  });
});
