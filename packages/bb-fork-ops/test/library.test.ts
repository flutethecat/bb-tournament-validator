import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLibraryTeamByName,
  readLibrary,
  removeLibraryTeam,
  retireLibraryTeam,
  upsertLibraryTeam,
  type LibraryTeam,
} from "@bb/fork-ops";

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

describe("retireLibraryTeam (soft-delete, owner ruling 08-18)", () => {
  it("flags a team retired and stamps retiredAt, without removing it", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    const retired = retireLibraryTeam(dir, "Flutethecat", "1");
    expect(retired?.retired).toBe(true);
    expect(retired?.retiredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const stored = readLibrary(dir, "Flutethecat");
    expect(stored).toHaveLength(1); // kept, not deleted
    expect(stored[0]!.retired).toBe(true);
  });

  it("returns undefined for a teamId not in the coach's library", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    expect(retireLibraryTeam(dir, "Flutethecat", "999")).toBeUndefined();
  });

  it("is idempotent: retiring an already-retired team just refreshes retiredAt", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    const first = retireLibraryTeam(dir, "Flutethecat", "1");
    const second = retireLibraryTeam(dir, "Flutethecat", "1");
    expect(second?.retired).toBe(true);
    expect(readLibrary(dir, "Flutethecat")).toHaveLength(1);
    expect(first).toBeDefined();
  });

  it("does not affect other coaches' libraries", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1" }));
    upsertLibraryTeam(dir, "Gondra87", team({ teamId: "1", coach: "Gondra87" }));
    retireLibraryTeam(dir, "Flutethecat", "1");
    expect(readLibrary(dir, "Gondra87")[0]!.retired).toBeUndefined();
  });
});

describe("findLibraryTeamByName (duplicate-name guard)", () => {
  it("finds a collision across DIFFERENT coaches — team names are global, not per-coach", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "The Bad Guys", coach: "Flutethecat" }));
    const hit = findLibraryTeamByName(dir, "The Bad Guys", "Gondra87");
    expect(hit?.teamId).toBe("1");
  });

  it("is case-insensitive and trims whitespace", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "The Bad Guys" }));
    expect(findLibraryTeamByName(dir, "  the bad guys  ")?.teamId).toBe("1");
  });

  it("returns undefined when no team has that name", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "The Bad Guys" }));
    expect(findLibraryTeamByName(dir, "Nobody Home")).toBeUndefined();
  });

  it("excludes the team being updated via excludeTeamId, so a resubmission doesn't collide with itself", () => {
    upsertLibraryTeam(dir, "Flutethecat", team({ teamId: "1", teamName: "The Bad Guys" }));
    expect(findLibraryTeamByName(dir, "The Bad Guys", "1")).toBeUndefined();
    // a DIFFERENT existing team still collides even when excluding some other id
    upsertLibraryTeam(dir, "Gondra87", team({ teamId: "2", teamName: "The Bad Guys", coach: "Gondra87" }));
    expect(findLibraryTeamByName(dir, "The Bad Guys", "1")?.teamId).toBe("2");
  });
});
