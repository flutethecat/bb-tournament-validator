import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PackageFiles, readCoaches, skillCatalog, starList } from "../src/data";
import { PRESETS } from "../src/presets";

const dir = () => mkdtempSync(join(tmpdir(), "bbtv-cw-"));

describe("skillCatalog", () => {
  it("splits selectable skills into elite vs general, excludes traits", () => {
    const cat = skillCatalog();
    const eliteNames = cat.elite.map((s) => s.name);
    expect(eliteNames).toContain("Block");
    expect(eliteNames).toContain("Guard");
    expect(cat.general.map((s) => s.name)).toContain("Wrestle");
    // no traits anywhere
    const all = [...cat.elite, ...cat.general].map((s) => s.name);
    expect(all).not.toContain("Loner");
    expect(all).not.toContain("Regeneration");
  });
});

describe("starList", () => {
  it("surfaces reciprocal inseparable-pair metadata", () => {
    const partners = Object.fromEntries(starList().filter((star) => star.pairedWith).map((star) => [star.name, star.pairedWith]));
    expect(partners).toEqual({
      Crumbleberry: "Grak",
      Dribl: "Drull",
      Drull: "Dribl",
      Grak: "Crumbleberry",
      "Lucien Swift": "Valen Swift",
      "Valen Swift": "Lucien Swift",
    });
  });
});

describe("PackageFiles", () => {
  it("saves a wizard package (normalized) and reads it back", () => {
    const pf = new PackageFiles(dir());
    const { path, pkg } = pf.save({
      name: "Test Cup",
      date: "2026-08-01",
      eligibleRosters: ["Amazon"],
      skillAllotment: { skillPointBudget: 8, eliteSurchargeSP: 0 },
    });
    expect(path).toMatch(/test-cup\.json$/);
    expect(pkg.skillAllotment.skillPointBudget).toBe(8);
    expect(pkg.skillAllotment.eliteSurchargeSP).toBe(0); // "elite doesn't cost more"
    expect(pkg.skillAllotment.primaryCostSP).toBe(1); // default merged in
    const listed = pf.list();
    expect(listed[0]!.name).toBe("Test Cup");
    expect(listed[0]!.date).toBe("2026-08-01");
    expect(pf.get("Test Cup")!.pkg.name).toBe("Test Cup");
  });
});

describe("presets", () => {
  it("all presets normalize cleanly and keep their SP config", () => {
    for (const p of PRESETS) {
      expect(p.pkg.name).toBeTruthy();
      expect(p.pkg.skillAllotment.eliteSkills.length).toBeGreaterThan(0);
    }
    const euro = PRESETS.find((p) => p.id === "eurobowl-2026-approx")!;
    expect(euro.pkg.starPlayers.allowed).toBe(false);
    expect(euro.pkg.skillAllotment.maxSameSkillTeamwide).toBe(3);
    expect(euro.pkg.description).toMatch(/APPROXIMATION/);
  });
});

describe("readCoaches", () => {
  it("parses the validated-rosters CSV and filters by package", () => {
    const d = dir();
    const csv = join(d, "v.csv");
    writeFileSync(
      csv,
      'discordUserId,coachName,teamName,rosterRace,packageName,messageLink,validatedAt\n' +
        'u1,"Jay, the Coach",Team A,Amazon,Lustrian,https://x/1,2026-07-06T00:00:00Z\n' +
        "u2,Other,Team B,Orc,Strict,https://x/2,2026-07-06T00:00:00Z\n",
      "utf8",
    );
    expect(readCoaches(csv)).toHaveLength(2);
    expect(readCoaches(csv)[0]!.coachName).toBe("Jay, the Coach");
    expect(readCoaches(csv, "Strict")).toHaveLength(1);
  });

  it("returns [] when the CSV does not exist", () => {
    expect(readCoaches(join(dir(), "missing.csv"))).toEqual([]);
  });
});
