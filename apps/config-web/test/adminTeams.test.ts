import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { rankAdminTeamSearch, searchStoredAdminTeams, type AdminTeamSearchRow } from "../src/data.js";

const roots: string[] = [];
const rows: AdminTeamSearchRow[] = [
  { teamId: "1234", name: "Storm Lords", coach: "Tarkin", roster: "Human", status: "loaded" },
  { teamId: "12345", name: "Desert Storm", coach: "Tarkin", roster: "Orc", status: "loaded" },
  { teamId: "9234", name: "Firestorm Union", coach: "Tarkin Jr", roster: "Elf", status: "not loaded" },
  { teamId: "8888", name: "Quiet Rats", coach: "Leia", roster: "Skaven", status: "retired" },
];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("admin stored-team search ranking", () => {
  it("ranks name prefix, word-prefix, then substring matches", () => {
    expect(rankAdminTeamSearch(rows, "storm", "name").map((row) => row.teamId)).toEqual([
      "1234",
      "12345",
      "9234",
    ]);
  });

  it("ranks an exact team ID first, then prefix and nearest IDs", () => {
    expect(rankAdminTeamSearch(rows, "1234", "id").map((row) => row.teamId)).toEqual([
      "1234",
      "12345",
      "9234",
      "8888",
    ]);
  });

  it("returns an exact coach's whole library without similarly named coaches", () => {
    expect(rankAdminTeamSearch(rows, "tarkin", "coach").map((row) => row.teamId)).toEqual([
      "12345",
      "1234",
    ]);
  });

  it("returns an empty array for an empty query or missing library directory", () => {
    const root = mkdtempSync(join(tmpdir(), "admin-team-search-"));
    roots.push(root);
    expect(rankAdminTeamSearch(rows, "  ", "name")).toEqual([]);
    expect(searchStoredAdminTeams(join(root, "missing"), "anything", "name")).toEqual([]);
  });
});
