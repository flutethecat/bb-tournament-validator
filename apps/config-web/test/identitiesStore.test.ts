import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FORK_NAME_LENGTH,
  readIdentities,
  upsertIdentity,
  type CoachIdentityRecord,
} from "../src/auth/identitiesStore.js";

const originalIdentitiesFile = process.env.IDENTITIES_FILE;
const tempDirs: string[] = [];

function tempStore(): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-identities-"));
  tempDirs.push(dir);
  const file = join(dir, "identities.json");
  process.env.IDENTITIES_FILE = file;
  return { dir, file };
}

function record(forkName: string, level: CoachIdentityRecord["level"] = "player"): CoachIdentityRecord {
  return {
    forkName,
    level,
    banned: false,
    silenced: false,
    note: "",
    identities: {},
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "RootAdmin",
  };
}

afterEach(() => {
  if (originalIdentitiesFile === undefined) delete process.env.IDENTITIES_FILE;
  else process.env.IDENTITIES_FILE = originalIdentitiesFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("identities store", () => {
  it("returns an empty v1 store for missing and corrupt files", () => {
    const { file } = tempStore();
    expect(readIdentities()).toEqual({ version: 1, coaches: {} });
    writeFileSync(file, "{not-json", "utf8");
    expect(readIdentities()).toEqual({ version: 1, coaches: {} });
  });

  it("atomically upserts and round-trips records without leaving a temp file", () => {
    const { dir } = tempStore();
    upsertIdentity({
      ...record("GONDRA87", "admin"),
      identities: { discordUserId: "123", nafName: "Gondra" },
    });
    upsertIdentity(record("Fives", "organizer"));

    const store = readIdentities();
    expect(store.coaches.gondra87).toMatchObject({
      forkName: "GONDRA87",
      level: "admin",
      identities: { discordUserId: "123", nafName: "Gondra" },
    });
    expect(store.coaches.fives?.forkName).toBe("Fives");
    expect(readdirSync(dir)).toEqual(["identities.json"]);
  });

  it("normalizes keys, preserves canonical case, and rejects unbounded fork names", () => {
    const { file } = tempStore();
    upsertIdentity(record("  MixedCase  "));
    expect(Object.keys(readIdentities().coaches)).toEqual(["mixedcase"]);
    expect(readIdentities().coaches.mixedcase?.forkName).toBe("MixedCase");

    expect(() => upsertIdentity(record("x".repeat(MAX_FORK_NAME_LENGTH + 1)))).toThrow(/at most 40/);
    expect(existsSync(file)).toBe(true);
    expect(Object.keys(readIdentities().coaches)).toEqual(["mixedcase"]);
  });
});
