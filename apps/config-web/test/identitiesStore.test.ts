import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_FFB_COACH_ID_LENGTH,
  MAX_PROFILE_KEYS,
  mergeIdentityRecords,
  organizerUpdateIdentity,
  ownIdentityRecord,
  readIdentities,
  updateOwnAccount,
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

function record(ffbCoachId: string, level: CoachIdentityRecord["level"] = "player"): CoachIdentityRecord {
  return {
    ffbCoachId,
    level,
    banned: false,
    silenced: false,
    note: "",
    profile: {},
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
      profile: { displayName: "Gondra", pronouns: "he/him" },
      identities: {
        discordUserId: "123",
        discordAvatarHash: "avatar-hash",
        email: "gondra@example.test",
        nafName: "Gondra",
      },
    });
    upsertIdentity(record("Fives", "organizer"));

    const store = readIdentities();
    expect(store.coaches.gondra87).toMatchObject({
      ffbCoachId: "GONDRA87",
      level: "admin",
      profile: { displayName: "Gondra", pronouns: "he/him" },
      identities: {
        discordUserId: "123",
        discordAvatarHash: "avatar-hash",
        email: "gondra@example.test",
        nafName: "Gondra",
      },
    });
    expect(store.coaches.fives?.ffbCoachId).toBe("Fives");
    expect(readdirSync(dir)).toEqual(["identities.json"]);
  });

  it("normalizes keys, preserves canonical case, and rejects unbounded coach ids", () => {
    const { file } = tempStore();
    upsertIdentity(record("  MixedCase  "));
    expect(Object.keys(readIdentities().coaches)).toEqual(["mixedcase"]);
    expect(readIdentities().coaches.mixedcase?.ffbCoachId).toBe("MixedCase");

    expect(() => upsertIdentity(record("x".repeat(MAX_FFB_COACH_ID_LENGTH + 1)))).toThrow(/at most 40/);
    expect(existsSync(file)).toBe(true);
    expect(Object.keys(readIdentities().coaches)).toEqual(["mixedcase"]);
  });

  it("rejects non-string profile values and unbounded freeform key counts", () => {
    tempStore();
    expect(() => upsertIdentity({
      ...record("Tarkin"),
      profile: { rating: 5 as unknown as string },
    })).toThrow(/profile\.rating must be a string/);
    expect(() => upsertIdentity({
      ...record("Tarkin"),
      profile: Object.fromEntries(Array.from({ length: MAX_PROFILE_KEYS + 1 }, (_, index) => [`key${index}`, "value"])),
    })).toThrow(new RegExp(`profile must have at most ${MAX_PROFILE_KEYS} keys`));
  });

  it("merges an accidental Discord identity into the real fork coach and removes only the source identity row", () => {
    tempStore();
    upsertIdentity({
      ...record("DiscordName", "admin"),
      profile: { displayName: "Discord Display", avatar: "https://avatar.example/discord.png" },
      identities: { discordUserId: "123", discordUsername: "DiscordName", email: "discord@example.test" },
    });
    upsertIdentity({
      ...record("RealForkId", "organizer"),
      banned: true,
      profile: { displayName: "Real Coach" },
      identities: { nafId: "98765" },
    });

    const merged = mergeIdentityRecords(
      "DiscordName",
      "RealForkId",
      "RootAdmin",
      new Date("2026-08-28T12:00:00.000Z"),
    );

    expect(merged.coach).toMatchObject({
      ffbCoachId: "RealForkId",
      level: "organizer",
      banned: true,
      profile: { displayName: "Real Coach", avatar: "https://avatar.example/discord.png" },
      identities: {
        nafId: "98765",
        discordUserId: "123",
        discordUsername: "DiscordName",
        email: "discord@example.test",
      },
      updatedBy: "RootAdmin",
    });
    expect(readIdentities().coaches.discordname).toBeUndefined();
    expect(readIdentities().coaches.realforkid).toEqual(merged.coach);
  });

  it("refuses identity merges with conflicting fields and preserves both records", () => {
    tempStore();
    upsertIdentity({ ...record("Source"), identities: { discordUserId: "source-discord" } });
    upsertIdentity({ ...record("Target"), identities: { discordUserId: "target-discord" } });

    expect(() => mergeIdentityRecords("Source", "Target", "RootAdmin"))
      .toThrow(/identities\.discordUserId conflicts/);
    expect(Object.keys(readIdentities().coaches).sort()).toEqual(["source", "target"]);
  });

  it("applies sibling identity-field bounds to Discord avatar hashes", () => {
    tempStore();
    expect(() => upsertIdentity({
      ...record("Tarkin"),
      identities: { discordAvatarHash: "x".repeat(201) },
    })).toThrow(/identities\.discordAvatarHash must be at most 200 characters/);
  });

  it("reads a legacy forkName record as ffbCoachId in memory", () => {
    const { file } = tempStore();
    writeFileSync(file, JSON.stringify({
      version: 1,
      coaches: {
        tarkin: {
          forkName: "Tarkin",
          level: "player",
          banned: false,
          silenced: false,
          note: "",
          identities: { discordUserId: "123" },
          updatedAt: "2026-08-19T00:00:00.000Z",
          updatedBy: "RootAdmin",
        },
      },
    }), "utf8");

    expect(readIdentities().coaches.tarkin).toMatchObject({
      ffbCoachId: "Tarkin",
      profile: {},
      identities: { discordUserId: "123" },
    });
    expect(readIdentities().coaches.tarkin).not.toHaveProperty("forkName");
  });

  it("updates only the caller's profile, including freeform keys", () => {
    tempStore();
    upsertIdentity({
      ...record("Tarkin", "organizer"),
      banned: true,
      profile: { displayName: "Old name" },
      identities: { discordUserId: "123" },
    });

    const updated = updateOwnAccount("Tarkin", {
      profile: { displayName: "Grand Moff", pronouns: "he/him" },
      level: "admin",
      banned: false,
    }, new Date("2026-08-20T12:00:00.000Z"));

    expect(updated).toMatchObject({
      ffbCoachId: "Tarkin",
      level: "organizer",
      banned: true,
      profile: { displayName: "Grand Moff", pronouns: "he/him" },
      identities: { discordUserId: "123" },
      updatedAt: "2026-08-20T12:00:00.000Z",
      updatedBy: "Tarkin",
    });
    expect(updated.identities).toEqual({ discordUserId: "123" });
  });

  it("sets scheduling and round-trips normalized local availability", () => {
    tempStore();

    const updated = updateOwnAccount("Tarkin", {
      scheduling: {
        timezone: "  America/Los_Angeles  ",
        availability: [{ day: "MON", start: "09:00", end: "17:30" }],
      },
    }, new Date("2026-08-20T12:00:00.000Z"));

    expect(updated.scheduling).toEqual({
      timezone: "America/Los_Angeles",
      availability: [{ day: "mon", start: "09:00", end: "17:30" }],
    });
    expect(readIdentities().coaches.tarkin?.scheduling).toEqual(updated.scheduling);

    const cleared = updateOwnAccount("Tarkin", {
      scheduling: { timezone: "  ", availability: [] },
    }, new Date("2026-08-20T13:00:00.000Z"));
    expect(cleared).not.toHaveProperty("scheduling");
    expect(readIdentities().coaches.tarkin).not.toHaveProperty("scheduling");
  });

  it("rejects invalid scheduling days and malformed times", () => {
    tempStore();
    expect(() => updateOwnAccount("Tarkin", {
      scheduling: { availability: [{ day: "funday", start: "09:00", end: "17:00" }] },
    })).toThrow(/day must be one of/);
    expect(() => updateOwnAccount("Tarkin", {
      scheduling: { availability: [{ day: "mon", start: "25:00", end: "17:00" }] },
    })).toThrow(/start must be a 24-hour time/);
    expect(() => updateOwnAccount("Tarkin", {
      scheduling: { availability: [{ day: "mon", start: "09:00", end: "9:5" }] },
    })).toThrow(/end must be a 24-hour time/);
  });

  it("rejects an own-account patch without profile or scheduling", () => {
    tempStore();
    expect(() => updateOwnAccount("Tarkin", {})).toThrow(/profile, scheduling, or identities is required/);
  });

  it("updates and persists the caller's whitelisted self-service identities", () => {
    tempStore();

    const updated = updateOwnAccount("Tarkin", {
      identities: { nafId: "12345", secondaryEmail: "x@y" },
    }, new Date("2026-08-27T12:00:00.000Z"));

    expect(updated.identities).toEqual({ nafId: "12345", secondaryEmail: "x@y" });
    expect(readIdentities().coaches.tarkin?.identities).toEqual({
      nafId: "12345",
      secondaryEmail: "x@y",
    });
  });

  it.each(["email", "discordUserId", "nafName"])(
    "rejects identities.%s from an own-account patch by name",
    (field) => {
      tempStore();
      expect(() => updateOwnAccount("Tarkin", {
        identities: { [field]: "attacker" },
      })).toThrow(new RegExp(`identities\\.${field}`));
    },
  );

  it("clears self-service identities with empty strings and validates secondaryEmail", () => {
    tempStore();
    upsertIdentity({
      ...record("Tarkin"),
      identities: { nafId: "12345", secondaryEmail: "old@example.test" },
    });

    expect(() => updateOwnAccount("Tarkin", {
      identities: { secondaryEmail: "notanemail" },
    })).toThrow(/identities\.secondaryEmail/);

    const cleared = updateOwnAccount("Tarkin", {
      identities: { nafId: "", secondaryEmail: "" },
    });
    expect(cleared.identities).toEqual({});
    expect(readIdentities().coaches.tarkin?.identities).toEqual({});
  });

  it("lets organizers update only NAF identity fields and stamps the acting coach", () => {
    tempStore();
    upsertIdentity({
      ...record("TargetCoach"),
      identities: { email: "sso@example.test", nafName: "Old NAF" },
    });

    const updated = organizerUpdateIdentity(
      "OrganizerCoach",
      "TargetCoach",
      { nafName: "New NAF", nafId: "98765" },
      new Date("2026-08-27T13:00:00.000Z"),
    );
    expect(updated.identities).toEqual({
      email: "sso@example.test",
      nafName: "New NAF",
      nafId: "98765",
    });
    expect(updated).toMatchObject({
      updatedAt: "2026-08-27T13:00:00.000Z",
      updatedBy: "OrganizerCoach",
    });
    expect(() => organizerUpdateIdentity("OrganizerCoach", "TargetCoach", { email: "attacker@example.test" }))
      .toThrow(/email/);
    expect(() => organizerUpdateIdentity("OrganizerCoach", "TargetCoach", { discordUserId: "attacker" }))
      .toThrow(/discordUserId/);
  });

  it("preserves privileged fields during profile and scheduling edits", () => {
    tempStore();
    upsertIdentity({
      ...record("Tarkin", "organizer"),
      banned: true,
      scheduling: { availability: [{ day: "fri", start: "10:00", end: "16:00" }] },
      identities: { discordUserId: "123" },
    });

    const updated = updateOwnAccount("Tarkin", {
      profile: { displayName: "Grand Moff" },
      scheduling: { timezone: "UTC" },
      level: "admin",
      banned: false,
    }, new Date("2026-08-20T12:00:00.000Z"));

    expect(updated).toMatchObject({
      level: "organizer",
      banned: true,
      identities: { discordUserId: "123" },
      profile: { displayName: "Grand Moff" },
    });
    expect(updated.identities).toEqual({ discordUserId: "123" });
    expect(updated.scheduling).toEqual({ timezone: "UTC" });
  });

  it("synthesizes a minimal account for a session coach without an identity record", () => {
    tempStore();
    expect(ownIdentityRecord(" Fives ")).toEqual({
      ffbCoachId: "Fives",
      level: "player",
      banned: false,
      silenced: false,
      note: "",
      profile: {},
      identities: {},
      updatedAt: "",
      updatedBy: "",
    });
  });
});
