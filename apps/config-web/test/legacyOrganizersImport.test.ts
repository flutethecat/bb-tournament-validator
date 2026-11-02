// organizers.json retirement (registration spec 2026-11-02 Q14): the one-time import into identity levels. Isolated
// identities file, organizers file and state dir per test. Invented names only.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coachLevel, isOrganizer } from "../src/auth/access.js";
import { readIdentities } from "../src/auth/identitiesStore.js";
import { importLegacyOrganizers, LEGACY_IMPORT_ACTOR, legacyOrganizersMarker } from "../src/auth/organizers.js";
import { clearFences, coachKeyHash, fenceCoachHash } from "../src/privacy/fence.js";

const prev = { identities: process.env.IDENTITIES_FILE, organizers: process.env.ORGANIZERS_FILE };
let root = "";
let state = "";
let file = "";
const logs: string[] = [];
const log = (l: string) => { logs.push(l); };

const rec = (ffbCoachId: string, level = "player", extra: Record<string, unknown> = {}) => ({
  ffbCoachId, level, banned: false, silenced: false, note: "kept", profile: { displayName: "Kept" }, identities: { discordUserId: "900000000000000099" }, updatedAt: "", updatedBy: "", ...extra,
});
const writeOrganizers = (names: unknown) => writeFileSync(file, JSON.stringify({ organizers: names }), "utf8");

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "legacy-organizers-"));
  state = join(root, "state");
  file = join(root, "organizers.json");
  process.env.IDENTITIES_FILE = join(root, "identities.json");
  process.env.ORGANIZERS_FILE = file;
  writeFileSync(process.env.IDENTITIES_FILE, JSON.stringify({ version: 1, coaches: {
    tarkin: rec("Tarkin"), veers: rec("Veers", "admin"), piett: rec("Piett", "organizer"), ozzel: rec("Ozzel", "player", { banned: true }),
  } }), "utf8");
  logs.length = 0;
  clearFences();
});
afterEach(() => {
  for (const [k, v] of [["IDENTITIES_FILE", prev.identities], ["ORGANIZERS_FILE", prev.organizers]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  clearFences();
  rmSync(root, { recursive: true, force: true });
});

describe("legacy organiser import", () => {
  it("raises players (case/space-insensitive), keeps admins and organisers, creates missing coaches, keeps every other field", () => {
    writeOrganizers([" TARKIN ", "Veers", "piett", "Fives", "fives", "Ozzel", ""]);
    const r = importLegacyOrganizers(state, { log, now: new Date("2026-11-02T00:00:00Z") });
    expect(r).toEqual({ status: "imported", elevated: 3, unchanged: 2, skipped: 0 });
    const c = readIdentities().coaches;
    // stored spelling and every other field kept; audit fields say who
    expect(c.tarkin).toMatchObject({ ffbCoachId: "Tarkin", level: "organizer", note: "kept", profile: { displayName: "Kept" }, identities: { discordUserId: "900000000000000099" }, updatedBy: LEGACY_IMPORT_ACTOR, updatedAt: "2026-11-02T00:00:00.000Z" });
    expect(c.veers!.level).toBe("admin");
    expect(c.piett).toMatchObject({ level: "organizer", updatedBy: "" }); // untouched
    expect(c.fives).toMatchObject({ ffbCoachId: "Fives", level: "organizer", banned: false });
    expect(c.ozzel).toMatchObject({ level: "organizer", banned: true });
    // nobody who had rights through the file loses them; a banned coach still resolves to player, as before
    expect(coachLevel("tarkin")).toBe("organizer");
    expect(isOrganizer("FIVES")).toBe(true);
    expect(coachLevel("Veers")).toBe("admin");
    expect(coachLevel("Ozzel")).toBe("player");
    const marker = JSON.parse(readFileSync(legacyOrganizersMarker(state), "utf8"));
    expect(marker).toMatchObject({ version: 1, source: "organizers.json", elevated: 3, unchanged: 2, skipped: 0 });
    expect(JSON.stringify(marker)).not.toMatch(/tarkin|fives/i); // counts only
  });

  it("is idempotent: a second run is a no-op that only logs the deprecation; the file is never read for permissions again", () => {
    writeOrganizers(["Tarkin"]);
    importLegacyOrganizers(state, { log });
    const before = readFileSync(process.env.IDENTITIES_FILE!, "utf8");
    // the file changes after the import: adding a name grants nothing, removing one revokes nothing
    writeOrganizers(["Newcomer"]);
    logs.length = 0;
    expect(importLegacyOrganizers(state, { log })).toEqual({ status: "already", elevated: 0, unchanged: 0, skipped: 0 });
    expect(readFileSync(process.env.IDENTITIES_FILE!, "utf8")).toBe(before);
    expect(coachLevel("Newcomer")).toBe("player");
    expect(coachLevel("Tarkin")).toBe("organizer");
    expect(logs).toEqual([expect.stringContaining("organizers.json is deprecated")]);
    rmSync(file);
    logs.length = 0;
    importLegacyOrganizers(state, { log });
    expect(logs).toEqual([]); // no file, no deprecation line
  });

  it("no file: writes the marker so a file added later is never read", () => {
    expect(importLegacyOrganizers(state, { log }).status).toBe("imported");
    expect(JSON.parse(readFileSync(legacyOrganizersMarker(state), "utf8")).source).toBe("absent");
    writeOrganizers(["Tarkin"]);
    expect(importLegacyOrganizers(state, { log }).status).toBe("already");
    expect(coachLevel("Tarkin")).toBe("player");
  });

  it("an unreadable organizers file or identities store leaves no marker (retried next start) and writes nothing", () => {
    writeFileSync(file, "{oops", "utf8");
    expect(importLegacyOrganizers(state, { log }).status).toBe("failed");
    expect(existsSync(legacyOrganizersMarker(state))).toBe(false);
    writeOrganizers([1, 2]);
    expect(importLegacyOrganizers(state, { log }).status).toBe("failed");
    writeOrganizers(["Tarkin"]);
    writeFileSync(process.env.IDENTITIES_FILE!, "{broken", "utf8");
    expect(importLegacyOrganizers(state, { log }).status).toBe("failed");
    expect(readFileSync(process.env.IDENTITIES_FILE!, "utf8")).toBe("{broken");
    expect(existsSync(legacyOrganizersMarker(state))).toBe(false);
  });

  it("skips a reserved pseudonym name, an over-long name and a coach whose deletion is running", () => {
    fenceCoachHash(coachKeyHash("Tarkin"));
    writeOrganizers(["Deleted coach #4", "x".repeat(41), "Tarkin", "Fives"]);
    expect(importLegacyOrganizers(state, { log })).toEqual({ status: "imported", elevated: 1, unchanged: 0, skipped: 3 });
    const c = readIdentities().coaches;
    expect(c.tarkin!.level).toBe("player");
    expect(Object.keys(c)).not.toContain("deleted coach #4");
  });
});
