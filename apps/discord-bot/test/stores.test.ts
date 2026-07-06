import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CsvValidatedStore, csvSplit, type ValidatedEntry } from "../src/store/validatedStore";
import { FileCoachRegistry, KeyConflictError } from "../src/store/coachRegistry";

const dir = () => mkdtempSync(join(tmpdir(), "bbtv-"));

const entry = (over: Partial<ValidatedEntry> = {}): ValidatedEntry => ({
  discordUserId: "u1",
  coachName: "Jay, the \"Coach\"", // commas + quotes exercise CSV escaping
  teamName: "Team A",
  rosterRace: "Amazon",
  packageName: "Lustrian",
  messageLink: "https://discord.com/channels/1/2/3",
  validatedAt: "2026-07-06T00:00:00Z",
  ...over,
});

describe("CsvValidatedStore", () => {
  it("upserts, lists, and round-trips CSV escaping", async () => {
    const store = new CsvValidatedStore(join(dir(), "v.csv"));
    await store.upsert(entry());
    await store.upsert(entry({ discordUserId: "u2", coachName: "Other" }));
    const all = await store.list();
    expect(all).toHaveLength(2);
    expect(all[0]!.coachName).toBe('Jay, the "Coach"');
  });

  it("re-validation replaces the old row (latest wins per user+package)", async () => {
    const store = new CsvValidatedStore(join(dir(), "v.csv"));
    await store.upsert(entry({ teamName: "Old" }));
    await store.upsert(entry({ teamName: "New" }));
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.teamName).toBe("New");
  });

  it("same user in two packages keeps two rows; list filters by package", async () => {
    const store = new CsvValidatedStore(join(dir(), "v.csv"));
    await store.upsert(entry({ packageName: "A" }));
    await store.upsert(entry({ packageName: "B" }));
    expect(await store.list()).toHaveLength(2);
    expect(await store.list("A")).toHaveLength(1);
  });

  it("exportCsv emits a parseable header + rows", async () => {
    const path = join(dir(), "v.csv");
    const store = new CsvValidatedStore(path);
    await store.upsert(entry());
    const csv = await store.exportCsv();
    const lines = csv.split("\n");
    expect(lines[0]).toMatch(/^discordUserId,/);
    expect(csvSplit(lines[1]!)[1]).toBe('Jay, the "Coach"');
    // file on disk matches the export
    expect(readFileSync(path, "utf8").trim()).toBe(csv.trim());
  });
});

describe("FileCoachRegistry", () => {
  it("registers, looks up by every key case-insensitively", async () => {
    const reg = new FileCoachRegistry(join(dir(), "c.json"));
    const e = await reg.upsert({ discordUserId: "u1", fumbblName: "Flute", nafName: "Jay", nafId: "1234" });
    expect((await reg.lookup("fumbblName", "flute"))?.id).toBe(e.id);
    expect((await reg.lookup("nafId", "1234"))?.id).toBe(e.id);
    expect((await reg.lookup("nafName", "JAY"))?.id).toBe(e.id);
    expect(await reg.lookup("nafId", "9999")).toBeUndefined();
  });

  it("enforces key uniqueness with a named conflict", async () => {
    const reg = new FileCoachRegistry(join(dir(), "c.json"));
    await reg.upsert({ discordUserId: "u1", nafId: "1234" });
    await expect(reg.upsert({ discordUserId: "u2", nafId: "1234" })).rejects.toThrow(KeyConflictError);
  });

  it("updates the same coach by discord id without conflicting with itself", async () => {
    const reg = new FileCoachRegistry(join(dir(), "c.json"));
    const a = await reg.upsert({ discordUserId: "u1", nafId: "1234" });
    const b = await reg.upsert({ discordUserId: "u1", fumbblName: "Flute" });
    expect(b.id).toBe(a.id);
    expect(b.nafId).toBe("1234");
    expect(b.fumbblName).toBe("Flute");
  });

  it("tracks per-tournament team registrations, latest wins", async () => {
    const reg = new FileCoachRegistry(join(dir(), "c.json"));
    const e = await reg.upsert({ discordUserId: "u1" });
    await reg.addTeam(e.id, { tournament: "T", teamName: "Old", rosterRace: "Amazon", registeredAt: "x" });
    await reg.addTeam(e.id, { tournament: "T", teamName: "New", rosterRace: "Amazon", registeredAt: "y" });
    await reg.addTeam(e.id, { tournament: "U", teamName: "Other", rosterRace: "Amazon", registeredAt: "z" });
    const teams = (await reg.lookup("discordUserId", "u1"))!.teams;
    expect(teams).toHaveLength(2);
    expect(teams.find((t) => t.tournament === "T")!.teamName).toBe("New");
  });
});
