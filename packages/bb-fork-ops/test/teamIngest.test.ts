import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeForkCacheReload,
  acknowledgeRecoveredTeamTransactions,
  beginTeamXmlTransaction,
  copyForkTeam,
  forkCacheReloadRequired,
  ingestForkTeam,
  readLibrary,
  recoverTeamFileTransactions,
  retireLibraryTeam,
  upsertLibraryTeam,
  updateTeamXmlTransactionLibraryTeam,
  type ForkConfig,
} from "@bb/fork-ops";

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
    upsertLibraryTeam(libraryDir, "Original", {
      teamId: "123", teamName: "Old ownership row", race: "Human", coach: "Original",
      teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-17T00:00:00.000Z",
    });
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
    await ingestForkTeam(cfg, libraryDir, coach, "https://fumbbl.com/t/123", join(root, "state"), {
      isTeamActive: async () => false,
    });

    expect(readLibrary(libraryDir, coach)[0]).toMatchObject({ teamId: "123", teamName: "Re-ingested Humans" });
    expect(readLibrary(libraryDir, coach)[0]).not.toHaveProperty("retired");
    expect(readLibrary(libraryDir, coach)[0]).not.toHaveProperty("retiredAt");
    expect(readLibrary(libraryDir, "Original").some((team) => team.teamId === "123")).toBe(false);
  });

  it("refuses destructive re-ingest of a progressed local team unless recovery is explicit", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-reingest-protected-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir);
    const libraryDir = join(root, "library");
    const coach = "Tarkin";
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const progressed = '<team id="123"><name>Progressed</name><coach>Tarkin</coach><player id="p1"><name>P</name><injury recovering="true">SeriouslyHurt</injury></player></team>';
    writeFileSync(teamPath, progressed, "utf8");
    upsertLibraryTeam(libraryDir, coach, {
      teamId: "123",
      teamName: "Progressed",
      race: "Human",
      coach,
      teamValue: 900,
      gold: 0,
      forkLoadable: true,
      ingestedAt: "2026-08-18T00:00:00.000Z",
    });
    upsertLibraryTeam(libraryDir, "Original", {
      teamId: "123", teamName: "Old owner", race: "Human", coach: "Original",
      teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-17T00:00:00.000Z",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("xml:team")) {
          return new Response('<team id="123"><name>Fresh Remote</name><coach>Original</coach><currentTeamValue>1000000</currentTeamValue></team>');
        }
        if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
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
    await expect(ingestForkTeam(cfg, libraryDir, coach, "123", join(root, "state"), {
      isTeamActive: async () => false,
    })).rejects.toThrow(/progression or match history/i);
    expect(readFileSync(teamPath, "utf8")).toBe(progressed);
    expect(readLibrary(libraryDir, coach)[0]?.teamName).toBe("Progressed");

    await ingestForkTeam(cfg, libraryDir, coach, "123", join(root, "state"), {
      allowReplaceProgressed: true,
      isTeamActive: async () => false,
    });
    expect(readFileSync(teamPath, "utf8")).toContain("Fresh Remote");
    expect(readLibrary(libraryDir, coach)[0]?.teamName).toBe("Fresh Remote");
  });

  it("rolls team, roster, and library metadata back when reload fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-reingest-rollback-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    const rosterDir = join(root, "rosters");
    mkdirSync(teamsDir);
    mkdirSync(rosterDir);
    const libraryDir = join(root, "library");
    const coach = "Tarkin";
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const rosterPath = join(rosterDir, "roster_team_123.xml");
    const beforeTeam = '<team id="123"><name>Before</name><coach>Tarkin</coach></team>';
    const beforeRoster = '<roster team="123"><name>Before roster</name></roster>';
    writeFileSync(teamPath, beforeTeam, "utf8");
    writeFileSync(rosterPath, beforeRoster, "utf8");
    upsertLibraryTeam(libraryDir, coach, {
      teamId: "123",
      teamName: "Before",
      race: "Human",
      coach,
      teamValue: 900,
      gold: 0,
      forkLoadable: true,
      ingestedAt: "2026-08-18T00:00:00.000Z",
    });
    upsertLibraryTeam(libraryDir, "Original", {
      teamId: "123", teamName: "Old owner", race: "Human", coach: "Original",
      teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-17T00:00:00.000Z",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("xml:team")) return new Response('<team id="123"><name>After</name><coach>Original</coach></team>');
        if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
        return new Response('<roster team="123"><name>After roster</name></roster>');
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
    await expect(
      ingestForkTeam(cfg, libraryDir, coach, "123", join(root, "state"), {
        isTeamActive: async () => false,
        reload: async () => {
          upsertLibraryTeam(libraryDir, coach, {
            teamId: "other", teamName: "Concurrent updated", race: "Human", coach,
            teamValue: 520, gold: 0, forkLoadable: true, ingestedAt: "2026-08-19T00:00:00.000Z",
          });
          throw new Error("reload failed");
        },
      }),
    ).rejects.toThrow("reload failed");
    expect(readFileSync(teamPath, "utf8")).toBe(beforeTeam);
    expect(readFileSync(rosterPath, "utf8")).toBe(beforeRoster);
    expect(readLibrary(libraryDir, coach).find((team) => team.teamId === "123")?.teamName).toBe("Before");
    expect(readLibrary(libraryDir, coach).find((team) => team.teamId === "other")).toMatchObject({ teamName: "Concurrent updated", teamValue: 520 });
    expect(readLibrary(libraryDir, "Original")[0]?.teamName).toBe("Old owner");
  });

  it("fails closed when activity cannot be established and refuses a pristine active team", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-reingest-active-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir);
    const libraryDir = join(root, "library");
    const coach = "Tarkin";
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const before = '<team id="123"><name>Pristine</name><coach>Tarkin</coach></team>';
    writeFileSync(teamPath, before, "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("xml:team")) return new Response('<team id="123"><name>Remote</name><coach>Original</coach></team>');
      if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
      return new Response('<roster team="123"><name>Human</name></roster>');
    }));
    const cfg: ForkConfig = {
      teamsDir, dbHost: "127.0.0.1", dbPort: 3316, dbUser: "ffb", dbPassword: "ffb", dbName: "ffblive",
    };

    await expect(ingestForkTeam(cfg, libraryDir, coach, "123", join(root, "state")))
      .rejects.toThrow(/activity cannot be verified/i);
    await expect(ingestForkTeam(cfg, libraryDir, coach, "123", join(root, "state"), {
      isTeamActive: async () => true,
    })).rejects.toThrow(/game in progress/i);
    expect(readFileSync(teamPath, "utf8")).toBe(before);
  });

  it("rolls an ingest back when a game starts between the precheck and commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-reingest-race-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    const rosterDir = join(root, "rosters");
    const libraryDir = join(root, "library");
    mkdirSync(teamsDir);
    mkdirSync(rosterDir);
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const rosterPath = join(rosterDir, "roster_team_123.xml");
    const before = '<team id="123"><name>Before</name><coach>Tarkin</coach></team>';
    writeFileSync(teamPath, before, "utf8");
    writeFileSync(rosterPath, '<roster team="123"><name>Before roster</name></roster>', "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", {
      teamId: "123", teamName: "Before", race: "Human", coach: "Tarkin", teamValue: 900, gold: 0,
      forkLoadable: true, ingestedAt: "2026-08-18T00:00:00.000Z",
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("xml:team")) return new Response('<team id="123"><name>After</name><coach>Original</coach></team>');
      if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
      return new Response('<roster team="123"><name>After roster</name></roster>');
    }));
    const cfg: ForkConfig = { teamsDir, dbHost: "127.0.0.1", dbPort: 3316, dbUser: "ffb", dbPassword: "ffb", dbName: "ffblive" };
    let checks = 0;
    await expect(ingestForkTeam(cfg, libraryDir, "Tarkin", "123", join(root, "state"), {
      isTeamActive: async () => ++checks > 1,
      reload: async () => ({ reloaded: true }),
    })).rejects.toThrow(/game started during/i);
    expect(readFileSync(teamPath, "utf8")).toBe(before);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("Before");
  });

  it("recovers PREPARED and COMMITTED team generations from durable journals", () => {
    const root = mkdtempSync(join(tmpdir(), "team-journal-recovery-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    const rosterDir = join(root, "rosters");
    const libraryDir = join(root, "library");
    const journalDir = join(teamsDir, ".team-transactions");
    mkdirSync(journalDir, { recursive: true });
    mkdirSync(rosterDir, { recursive: true });
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const rosterPath = join(rosterDir, "roster_team_123.xml");
    const oldTeam = '<team id="123"><name>Old</name><coach>Tarkin</coach></team>';
    const newTeam = '<team id="123"><name>New</name><coach>Tarkin</coach></team>';
    const oldRoster = '<roster team="123"><name>Old roster</name></roster>';
    const newRoster = '<roster team="123"><name>New roster</name></roster>';
    const oldRow = { teamId: "123", teamName: "Old", race: "Human", coach: "Tarkin", teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-18T00:00:00.000Z" };
    const newRow = { ...oldRow, teamName: "New", teamValue: 950 };
    writeFileSync(teamPath, newTeam, "utf8");
    writeFileSync(rosterPath, newRoster, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", newRow);
    const journalPath = join(journalDir, `${createHash("sha256").update("123").digest("hex")}.json`);
    const baseJournal = {
      version: 1, teamId: "123", targetPath: teamPath, teamXml: newTeam,
      priorTeams: [{ path: teamPath, xml: oldTeam }], rosterPath, rosterXml: newRoster, priorRoster: oldRoster,
      library: { baseDir: libraryDir, coach: "Tarkin", team: newRow, prior: { teamId: "123", priorRows: [{ coachKey: "tarkin", team: oldRow }] } },
    };
    writeFileSync(journalPath, JSON.stringify({ ...baseJournal, phase: "PREPARED" }), "utf8");
    const preparedRecovery = recoverTeamFileTransactions(teamsDir);
    expect(preparedRecovery).toMatchObject({ recovered: ["123"], errors: [] });
    expect(preparedRecovery.receipts).toHaveLength(1);
    expect(readFileSync(teamPath, "utf8")).toBe(oldTeam);
    expect(readFileSync(rosterPath, "utf8")).toBe(oldRoster);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("Old");
    acknowledgeRecoveredTeamTransactions(preparedRecovery.receipts);

    writeFileSync(teamPath, oldTeam, "utf8");
    writeFileSync(rosterPath, oldRoster, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", oldRow);
    writeFileSync(journalPath, JSON.stringify({ ...baseJournal, phase: "COMMITTED" }), "utf8");
    const committedRecovery = recoverTeamFileTransactions(teamsDir);
    expect(committedRecovery).toMatchObject({ recovered: ["123"], errors: [] });
    expect(readFileSync(teamPath, "utf8")).toBe(newTeam);
    expect(readFileSync(rosterPath, "utf8")).toBe(newRoster);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("New");
    acknowledgeRecoveredTeamTransactions(committedRecovery.receipts);
  });

  it("rechecks global team-name uniqueness on the privileged copy path", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-copy-name-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir);
    writeFileSync(join(teamsDir, "team_Other_999.xml"), '<team id="999"><name>Collision</name><coach>Other</coach></team>', "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("xml:team")) return new Response('<team id="123"><name>Collision</name><coach>Original</coach></team>');
      if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
      return new Response('<roster team="123"><name>Human</name></roster>');
    }));
    const cfg: ForkConfig = { teamsDir, dbHost: "127.0.0.1", dbPort: 3316, dbUser: "ffb", dbPassword: "ffb", dbName: "ffblive" };
    await expect(copyForkTeam(cfg, "123", { isTeamActive: async () => false })).rejects.toThrow(/already uses the name/i);
  });

  it("recovers a PREPARED single-XML transaction that crashed before its library write", () => {
    const root = mkdtempSync(join(tmpdir(), "single-team-prepared-")); roots.push(root);
    const teamsDir = join(root, "teams");
    const libraryDir = join(root, "library");
    mkdirSync(teamsDir);
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const oldXml = '<team id="123"><name>Old</name><coach>Tarkin</coach></team>';
    const newXml = '<team id="123"><name>New</name><coach>Tarkin</coach></team>';
    writeFileSync(teamPath, oldXml, "utf8");
    const oldRow = { teamId: "123", teamName: "Old", race: "Human", coach: "Tarkin", teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-18T00:00:00.000Z" };
    const newRow = { ...oldRow, teamName: "New", teamValue: 920 };
    upsertLibraryTeam(libraryDir, "Tarkin", oldRow);
    beginTeamXmlTransaction({ teamsDir, teamId: "123", targetPath: teamPath, teamXml: newXml, library: { baseDir: libraryDir, coach: "Tarkin", team: newRow } });
    writeFileSync(teamPath, newXml, "utf8");
    const recovery = recoverTeamFileTransactions(teamsDir);
    expect(readFileSync(teamPath, "utf8")).toBe(oldXml);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("Old");
    expect(forkCacheReloadRequired(teamsDir)).toBe(true);
    acknowledgeRecoveredTeamTransactions(recovery.receipts);
    expect(forkCacheReloadRequired(teamsDir)).toBe(true);
    acknowledgeForkCacheReload(teamsDir);
  });

  it("recovers a PREPARED single-XML transaction that crashed after its library write", () => {
    const root = mkdtempSync(join(tmpdir(), "single-team-library-")); roots.push(root);
    const teamsDir = join(root, "teams");
    const libraryDir = join(root, "library");
    mkdirSync(teamsDir);
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const oldXml = '<team id="123"><name>Old</name><coach>Tarkin</coach></team>';
    const newXml = '<team id="123"><name>New</name><coach>Tarkin</coach></team>';
    writeFileSync(teamPath, oldXml, "utf8");
    const oldRow = { teamId: "123", teamName: "Old", race: "Human", coach: "Tarkin", teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-18T00:00:00.000Z" };
    const newRow = { ...oldRow, teamName: "New", teamValue: 920 };
    upsertLibraryTeam(libraryDir, "Tarkin", oldRow);
    beginTeamXmlTransaction({ teamsDir, teamId: "123", targetPath: teamPath, teamXml: newXml, library: { baseDir: libraryDir, coach: "Tarkin", team: newRow } });
    writeFileSync(teamPath, newXml, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", newRow);
    const recovery = recoverTeamFileTransactions(teamsDir);
    expect(readFileSync(teamPath, "utf8")).toBe(oldXml);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("Old");
    acknowledgeRecoveredTeamTransactions(recovery.receipts);
    acknowledgeForkCacheReload(teamsDir);
  });

  it("completes a COMMITTED single-XML transaction and retains its reload marker until acknowledgement", () => {
    const root = mkdtempSync(join(tmpdir(), "single-team-committed-")); roots.push(root);
    const teamsDir = join(root, "teams");
    const libraryDir = join(root, "library");
    mkdirSync(teamsDir);
    const teamPath = join(teamsDir, "team_Tarkin_123.xml");
    const oldXml = '<team id="123"><name>Old</name><coach>Tarkin</coach></team>';
    const newXml = '<team id="123"><name>New</name><coach>Tarkin</coach></team>';
    writeFileSync(teamPath, oldXml, "utf8");
    const oldRow = { teamId: "123", teamName: "Old", race: "Human", coach: "Tarkin", teamValue: 900, gold: 0, forkLoadable: true, ingestedAt: "2026-08-18T00:00:00.000Z" };
    const newRow = { ...oldRow, teamName: "New", teamValue: 920 };
    upsertLibraryTeam(libraryDir, "Tarkin", oldRow);
    const handle = beginTeamXmlTransaction({ teamsDir, teamId: "123", targetPath: teamPath, teamXml: newXml, library: { baseDir: libraryDir, coach: "Tarkin", team: newRow } });
    writeFileSync(teamPath, newXml, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", newRow);
    updateTeamXmlTransactionLibraryTeam(handle, newRow);
    const durable = JSON.parse(readFileSync(handle.journalPath, "utf8")) as Record<string, unknown>;
    writeFileSync(handle.journalPath, JSON.stringify({ ...durable, phase: "COMMITTED" }), "utf8");
    writeFileSync(teamPath, oldXml, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", oldRow);
    const recovery = recoverTeamFileTransactions(teamsDir);
    expect(readFileSync(teamPath, "utf8")).toBe(newXml);
    expect(readLibrary(libraryDir, "Tarkin")[0]?.teamName).toBe("New");
    expect(forkCacheReloadRequired(teamsDir)).toBe(true);
    acknowledgeRecoveredTeamTransactions(recovery.receipts);
    acknowledgeForkCacheReload(teamsDir);
    expect(forkCacheReloadRequired(teamsDir)).toBe(false);
  });

  it("rolls a privileged copy back if a game starts during replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "team-copy-race-"));
    roots.push(root);
    const teamsDir = join(root, "teams");
    const rosterDir = join(root, "rosters");
    mkdirSync(teamsDir);
    mkdirSync(rosterDir);
    const teamPath = join(teamsDir, "team_Original_123.xml");
    const rosterPath = join(rosterDir, "roster_team_123.xml");
    const before = '<team id="123"><name>Before</name><coach>Original</coach></team>';
    writeFileSync(teamPath, before, "utf8");
    writeFileSync(rosterPath, '<roster team="123"><name>Before roster</name></roster>', "utf8");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("xml:team")) return new Response('<team id="123"><name>After</name><coach>Original</coach></team>');
      if (url.includes("api/team/get")) return Response.json({ roster: { name: "Human" } });
      return new Response('<roster team="123"><name>After roster</name></roster>');
    }));
    const cfg: ForkConfig = { teamsDir, dbHost: "127.0.0.1", dbPort: 3316, dbUser: "ffb", dbPassword: "ffb", dbName: "ffblive" };
    let checks = 0;
    await expect(copyForkTeam(cfg, "123", { isTeamActive: async () => ++checks > 1 }))
      .rejects.toThrow(/game started during/i);
    expect(readFileSync(teamPath, "utf8")).toBe(before);
    expect(readFileSync(rosterPath, "utf8")).toContain("Before roster");
  });
});
