import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestForkTeam, readLibrary, retireLibraryTeam, upsertLibraryTeam, type ForkConfig } from "@bb/fork-ops";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("team library ingest", () => {
  it("un-retires a team on explicit re-ingest", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-reingest-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir);
    const libraryDir = join(root, "library");
    const coach = "Tarkin";
    upsertLibraryTeam(libraryDir, coach, {
      teamId: "123",
      teamName: "Retired Humans",
      race: "Human",
      coach,
      teamValue: 900,
      gold: 0,
      forkLoadable: true,
      ingestedAt: "2026-08-18T00:00:00.000Z",
    });
    retireLibraryTeam(libraryDir, coach, "123");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("xml:team")) {
          return new Response('<team id="123"><name>Re-ingested Humans</name><coach>Original</coach><treasury>50000</treasury></team>');
        }
        if (url.includes("api/team/get")) {
          return Response.json({ roster: { name: "Human" } });
        }
        return new Response('<roster team="123"><name>Human</name></roster>');
      }),
    );

    const cfg: ForkConfig = {
      teamsDir,
      dbHost: "127.0.0.1",
      dbPort: 3316,
      dbUser: "ffb",
      dbPassword: "ffb",
      dbName: "ffblive",
    };
    await ingestForkTeam(cfg, libraryDir, coach, "https://fumbbl.com/t/123", join(root, "state"));

    expect(readLibrary(libraryDir, coach)[0]).toMatchObject({ teamId: "123", teamName: "Re-ingested Humans" });
    expect(readLibrary(libraryDir, coach)[0]).not.toHaveProperty("retired");
    expect(readLibrary(libraryDir, coach)[0]).not.toHaveProperty("retiredAt");
  });
});
