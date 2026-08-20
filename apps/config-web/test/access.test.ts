import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coachLevel, isAdmin, isBanned, isOrganizer, isSilenced } from "../src/auth/access.js";

const originalIdentitiesFile = process.env.IDENTITIES_FILE;
const originalOrganizersFile = process.env.ORGANIZERS_FILE;
const tempDirs: string[] = [];

function setStores(
  coaches: Record<string, Record<string, unknown>> = {},
  organizers: string[] = [],
): void {
  const dir = mkdtempSync(join(tmpdir(), "bbtv-access-"));
  tempDirs.push(dir);
  process.env.IDENTITIES_FILE = join(dir, "identities.json");
  process.env.ORGANIZERS_FILE = join(dir, "organizers.json");
  writeFileSync(process.env.IDENTITIES_FILE, JSON.stringify({ version: 1, coaches }), "utf8");
  writeFileSync(process.env.ORGANIZERS_FILE, JSON.stringify({ organizers }), "utf8");
}

function identity(level: "player" | "organizer" | "admin", flags: { banned?: boolean; silenced?: boolean } = {}) {
  return {
    forkName: "Tarkin",
    level,
    banned: flags.banned === true,
    silenced: flags.silenced === true,
    note: "",
    identities: {},
    updatedAt: "2026-08-19T00:00:00.000Z",
    updatedBy: "RootAdmin",
  };
}

afterEach(() => {
  if (originalIdentitiesFile === undefined) delete process.env.IDENTITIES_FILE;
  else process.env.IDENTITIES_FILE = originalIdentitiesFile;
  if (originalOrganizersFile === undefined) delete process.env.ORGANIZERS_FILE;
  else process.env.ORGANIZERS_FILE = originalOrganizersFile;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("coach access", () => {
  it("resolves stored levels and defaults unknown coaches to player", () => {
    setStores({ organizer: { ...identity("organizer"), forkName: "Organizer" }, admin: identity("admin") });
    expect(coachLevel("unknown")).toBe("player");
    expect(coachLevel(" ORGANIZER ")).toBe("organizer");
    expect(coachLevel("ADMIN")).toBe("admin");
    expect(isOrganizer("organizer")).toBe(true);
    expect(isAdmin("admin")).toBe(true);
  });

  it("keeps legacy organizers elevated when the store is absent or player", () => {
    setStores({ tarkin: identity("player") }, ["TARKIN", "Fives"]);
    expect(coachLevel("tarkin")).toBe("organizer");
    expect(coachLevel("fives")).toBe("organizer");
    expect(isOrganizer("FIVES")).toBe(true);
  });

  it("de-elevates a banned admin even through the legacy bridge", () => {
    setStores({ tarkin: identity("admin", { banned: true }) }, ["Tarkin"]);
    expect(coachLevel("TARKIN")).toBe("player");
    expect(isAdmin("Tarkin")).toBe(false);
    expect(isOrganizer("Tarkin")).toBe(false);
  });

  it("resolves banned and silenced flags independently", () => {
    setStores({ tarkin: identity("player", { banned: true, silenced: true }) });
    expect(isBanned(" tarkin ")).toBe(true);
    expect(isSilenced("TARKIN")).toBe(true);
    expect(isBanned("unknown")).toBe(false);
    expect(isSilenced("unknown")).toBe(false);
  });
});
