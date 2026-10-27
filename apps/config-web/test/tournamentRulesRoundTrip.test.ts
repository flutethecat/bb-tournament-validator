import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { type Any, bootRules, plain, publicDir, readPackage } from "./tournamentRulesHarness";

// Round-trip law (owner 10-27): a tournament package loaded into Tournament Rules Construction and
// serialised back without edits is deep-equal to the file (key order ignored). Runs the REAL
// tournament-rules.js normalizePackage/serializePackage; with no document the UI never boots.
function loadCore(): Any {
  const context: Record<string, Any> = { console };
  runInNewContext(readFileSync(new URL("tournament-rules.js", publicDir), "utf8"), context);
  return context.TournamentRulesCore;
}

function withoutSchema(value: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, ...rest } = value;
  return rest;
}

function roundTrip(core: Any, raw: Record<string, unknown>): Record<string, unknown> {
  core.loadPackageIntoEditor(raw, []);
  // Rendering every tab must not mutate the model.
  for (const [tab] of core.TABS) {
    core.state.tab = tab;
    core.editorHtml();
  }
  return plain(core.serializePackage());
}

const PACKAGES = ["small-gods", "whbb-nut-cup-2026", "naf-world-cup-2027", "eurobowl-2026", "spike-2026"];

describe("Tournament Rules Construction — round trip", () => {
  const core = loadCore();

  for (const name of PACKAGES) {
    it(`${name}.json serialises back deep-equal`, () => {
      const raw = readPackage(name);
      expect(withoutSchema(roundTrip(core, raw))).toEqual(withoutSchema(raw));
    });
  }

  it("also round-trips the bundled default + example packages", () => {
    for (const name of ["bb2025-default", "lustrian-superleague.example"]) {
      const raw = readPackage(name);
      expect(withoutSchema(roundTrip(core, raw))).toEqual(withoutSchema(raw));
    }
  });

  it("round-trips with the catalogs loaded too (booted page)", async () => {
    const { core: booted } = await bootRules({ authenticated: true, admin: true, coach: "Jay" });
    for (const name of PACKAGES) {
      const raw = readPackage(name);
      expect(withoutSchema(roundTrip(booted, raw))).toEqual(withoutSchema(raw));
    }
  });

  it("preserves unknown / future fields verbatim at every level", () => {
    const raw: Record<string, Any> = {
      ...readPackage("small-gods"),
      futureTopLevel: { nested: [1, 2, { deep: true }] },
      skillAllotment: { ...(readPackage("small-gods").skillAllotment as object), futureCost: 7 },
      sideline: { maxReRolls: 6, futureStaff: 2 },
      special: { minPlayers: 11, futureRule: "x" },
      inducements: { allowed: ["bribes"], caps: {}, futureInducementRule: { a: 1 } },
    };
    const tiers = (raw.tiers as Any[]).map((tier, index) => (index === 0 ? { ...tier, futureTierKnob: [3] } : tier));
    raw.tiers = tiers;
    expect(roundTrip(core, raw)).toEqual(raw);
  });

  it("does not add defaults the file left out", () => {
    const raw = { name: "Minimal", skillAllotment: { skillPointBudget: 4 } };
    expect(roundTrip(core, raw)).toEqual(raw);
  });

  it("an edited value that returns to the validator default is dropped again", () => {
    const raw = { name: "Minimal", skillAllotment: { skillPointBudget: 4 } };
    core.loadPackageIntoEditor(raw, []);
    core.state.pkg.sideline.maxReRolls = 6;
    expect(plain(core.serializePackage()).sideline).toEqual({ maxReRolls: 6 });
    core.state.pkg.sideline.maxReRolls = 8; // the validator default
    expect(plain(core.serializePackage())).toEqual(raw);
  });
});

// ---------- every new control writes the serialised package ----------

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function bindTag(html: string, path: (string | number)[]): string {
  const marker = `data-bind="${escapeAttr(JSON.stringify(path))}"`;
  const index = html.indexOf(marker);
  if (index < 0) throw new Error(`no control bound to ${JSON.stringify(path)}`);
  const start = html.lastIndexOf("<", index);
  return html.slice(start, html.indexOf(">", index) + 1);
}

function attr(tag: string, name: string): string | undefined {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

function getPath(root: Any, path: (string | number)[]): Any {
  return path.reduce((value: Any, key) => (value == null ? undefined : value[key]), root);
}

describe("Tournament Rules Construction — field controls", () => {
  const BASE = {
    name: "Controls",
    eligibleRosters: ["*"],
    skillAllotment: { skillPointBudget: 6 },
    tiers: [
      { tier: 1, label: "Tier 1", rosters: ["Orc", "High Elf"], gold: 1200000, starPlayersAllowed: true, bannedStars: [], skillPackages: [{ label: "Pack 1", gold: 1150000, skillPointBudget: 0 }] },
    ],
    teamRules: [{ team: "Orc" }],
    starPacks: [{ id: "legends", label: "Legends", fee: 20000, stars: [] }],
  };

  async function editor(raw: Record<string, unknown> = BASE) {
    const page = await bootRules({ authenticated: true, admin: true, coach: "Jay" });
    page.core.loadPackageIntoEditor(plain(raw), []);
    const set = (tab: string, path: (string | number)[], input: { value?: string; checked?: boolean }) => {
      page.core.state.tab = tab;
      const tag = bindTag(page.core.editorHtml(), path);
      page.core.handleEditorChange({
        dataset: { bind: JSON.stringify(path), kind: attr(tag, "data-kind") ?? "num", blank: attr(tag, "data-blank") ?? "delete" },
        value: input.value ?? "",
        checked: input.checked ?? false,
      });
      return plain(page.core.serializePackage());
    };
    const multi = (tab: string, path: (string | number)[], value: string, checked: boolean) => {
      page.core.state.tab = tab;
      const html = page.core.editorHtml();
      expect(html).toContain(`data-multi="${escapeAttr(JSON.stringify(path))}" data-value="${escapeAttr(value)}"`);
      page.core.handleEditorChange({ dataset: { multi: JSON.stringify(path), value }, checked });
      return plain(page.core.serializePackage());
    };
    const multiAll = (tab: string, path: (string | number)[], checked: boolean) => {
      page.core.state.tab = tab;
      expect(page.core.editorHtml()).toContain(`data-multi-all="${escapeAttr(JSON.stringify(path))}"`);
      page.core.handleEditorChange({ dataset: { multiAll: JSON.stringify(path) }, checked });
      return plain(page.core.serializePackage());
    };
    return { ...page, set, multi, multiAll };
  }

  const NUMERIC: [string, (string | number)[], string, unknown][] = [
    // tab, path, typed value, serialised value
    ["races", ["tiers", 0, "rosterGold", "Orc"], "1225", 1225000],
    ["races", ["tiers", 0, "maxPrimary"], "4", 4],
    ["races", ["tiers", 0, "maxSecondary"], "1", 1],
    ["races", ["tiers", 0, "secondarySwapRatio"], "3", 3],
    ["races", ["tiers", 0, "secondarySwapMax"], "1", 1],
    ["races", ["tiers", 0, "maxStackedPlayers"], "2", 2],
    ["races", ["tiers", 0, "eliteMaxTotal"], "3", 3],
    ["races", ["tiers", 0, "eliteMaxSameSkill"], "2", 2],
    ["races", ["tiers", 0, "stackedPlayer", "maxSkills"], "2", 2],
    ["races", ["tiers", 0, "stackedPlayer", "maxSecondary"], "0", 0],
    ["races", ["tiers", 0, "stackedPlayer", "maxElite"], "1", 1],
    ["races", ["tiers", 0, "statIncreases", "maxPerPlayer"], "1", 1],
    ["races", ["tiers", 0, "statIncreases", "costGold", "MA"], "30", 30000],
    ["races", ["tiers", 0, "skillPackages", 0, "maxSkills"], "6", 6],
    ["races", ["tiers", 0, "skillPackages", 0, "maxSecondary"], "1", 1],
    ["races", ["teamRules", 0, "gold"], "1250", 1250000],
    ["races", ["teamRules", 0, "skillPointBudget"], "5", 5],
    ["races", ["teamRules", 0, "maxPrimary"], "3", 3],
    ["races", ["teamRules", 0, "maxStackedPlayers"], "1", 1],
    ["races", ["teamRules", 0, "eliteMaxTotal"], "2", 2],
    ["races", ["teamRules", 0, "stackedPlayer", "maxElite"], "0", 0],
    ["skills", ["skillAllotment", "secondaryCostSP"], "3", 3],
    ["skills", ["skillAllotment", "stackSurchargeSP"], "2", 2],
    ["skills", ["skillAllotment", "primaryCostGold"], "25", 25000],
    ["skills", ["skillAllotment", "secondaryCostGold"], "45", 45000],
    ["skills", ["skillAllotment", "eliteSurchargeGold"], "15", 15000],
    ["skills", ["skillAllotment", "maxStackedPlayers"], "3", 3],
    ["skills", ["skillAllotment", "eliteMaxTotal"], "4", 4],
    ["skills", ["skillAllotment", "eliteMaxSameSkill"], "2", 2],
    ["skills", ["skillAllotment", "stackedPlayer", "maxSkills"], "2", 2],
    ["skills", ["skillAllotment", "stackedPlayer", "maxSecondary"], "1", 1],
    ["skills", ["skillAllotment", "stackedPlayer", "maxElite"], "0", 0],
    ["skills", ["skillAllotment", "maxSameSkillTeamwide"], "4", 4],
    ["skills", ["statIncreases", "maxPerPlayer"], "1", 1],
    ["skills", ["statIncreases", "costGold", "ST"], "60", 60000],
    ["stars", ["starPacks", 0, "id"], "mega", "mega"],
    ["stars", ["starPacks", 0, "label"], "Mega Stars", "Mega Stars"],
    ["stars", ["starPacks", 0, "fee"], "50", 50000],
    ["stars", ["starPacks", 0, "max"], "1", 1],
    ["special", ["special", "minPlayers"], "10", 10],
    ["special", ["sideline", "maxReRolls"], "6", 6],
    ["special", ["sideline", "maxApothecary"], "0", 0],
    ["special", ["sideline", "maxCheerleaders"], "4", 4],
    ["special", ["sideline", "maxAssistantCoaches"], "3", 3],
    ["special", ["sideline", "maxDedicatedFans"], "5", 5],
  ];

  it.each(NUMERIC)("%s tab: %j writes the package", async (tab, path, value, expected) => {
    const page = await editor();
    expect(getPath(page.set(tab, path, { value }), path)).toEqual(expected);
  });

  it("blank clears an override and removes the emptied container", async () => {
    const page = await editor();
    page.set("races", ["tiers", 0, "rosterGold", "Orc"], { value: "1225" });
    const cleared = page.set("races", ["tiers", 0, "rosterGold", "Orc"], { value: "" });
    expect(cleared.tiers).toEqual(BASE.tiers);
    page.set("races", ["teamRules", 0, "stackedPlayer", "maxSkills"], { value: "2" });
    expect(page.set("races", ["teamRules", 0, "stackedPlayer", "maxSkills"], { value: "" }).teamRules).toEqual([{ team: "Orc" }]);
  });

  it("tri-state selects write true / false and clear back to inherit", async () => {
    const page = await editor();
    expect(page.set("races", ["tiers", 0, "secondarySwap"], { value: "true" }).tiers[0].secondarySwap).toBe(true);
    expect(page.set("races", ["teamRules", 0, "starPlayersAllowed"], { value: "false" }).teamRules[0].starPlayersAllowed).toBe(false);
    expect(page.set("races", ["teamRules", 0, "secondarySwap"], { value: "true" }).teamRules[0].secondarySwap).toBe(true);
    expect(page.set("races", ["tiers", 0, "skillPackages", 0, "starPlayersAllowed"], { value: "false" }).tiers[0].skillPackages[0].starPlayersAllowed).toBe(false);
    expect(page.set("races", ["teamRules", 0, "starPlayersAllowed"], { value: "" }).teamRules[0]).toEqual({ team: "Orc", secondarySwap: true });
  });

  it("checkboxes, the fee-mode select and the team select write the package", async () => {
    const page = await editor();
    expect(page.set("races", ["tiers", 0, "statIncreases", "exclusiveWithSkills"], { checked: true }).tiers[0].statIncreases).toEqual({ exclusiveWithSkills: true });
    expect(page.set("skills", ["statIncreases", "exclusiveWithSkills"], { checked: true }).statIncreases).toEqual({ exclusiveWithSkills: true });
    expect(page.set("stars", ["starPacks", 0, "feeMode"], { value: "once" }).starPacks[0].feeMode).toBe("once");
    expect(page.set("races", ["teamRules", 0, "team"], { value: "Halfling" }).teamRules[0].team).toBe("Halfling");
  });

  it("multi-selects: stat increases, star packs, banned stars, elite skills, roster-only inducements", async () => {
    const page = await editor();
    page.multiAll("races", ["tiers", 0, "statIncreases", "allowed"], false);
    expect(page.multi("races", ["tiers", 0, "statIncreases", "allowed"], "MA", true).tiers[0].statIncreases).toEqual({ allowed: ["MA"] });
    page.multiAll("races", ["tiers", 0, "starPacksAllowed"], false);
    expect(page.multi("races", ["tiers", 0, "starPacksAllowed"], "legends", true).tiers[0].starPacksAllowed).toEqual(["legends"]);
    expect(page.multiAll("races", ["tiers", 0, "starPacksAllowed"], true).tiers[0].starPacksAllowed).toBeUndefined();
    expect(page.multi("races", ["tiers", 0, "bannedStars"], "Morg 'n' Thorg", true).tiers[0].bannedStars).toEqual(["Morg 'n' Thorg"]);
    page.multiAll("races", ["teamRules", 0, "bannedStars"], false);
    expect(page.multi("races", ["teamRules", 0, "bannedStars"], "Grak", true).teamRules[0].bannedStars).toEqual(["Grak"]);
    page.multiAll("races", ["teamRules", 0, "statIncreases", "allowed"], false);
    expect(page.multi("races", ["teamRules", 0, "statIncreases", "allowed"], "AV", true).teamRules[0].statIncreases.allowed).toEqual(["AV"]);
    page.multiAll("races", ["teamRules", 0, "starPacksAllowed"], false);
    expect(page.multi("races", ["teamRules", 0, "starPacksAllowed"], "legends", true).teamRules[0].starPacksAllowed).toEqual(["legends"]);
    expect(page.multi("skills", ["skillAllotment", "eliteSkills"], "Wrestle", true).skillAllotment.eliteSkills).toEqual(["Block", "Guard", "Mighty Blow", "Dodge", "Wrestle"]);
    expect(page.multi("skills", ["skillAllotment", "eliteSkills"], "Dodge", false).skillAllotment.eliteSkills).toEqual(["Block", "Guard", "Mighty Blow", "Wrestle"]);
    page.multiAll("skills", ["statIncreases", "allowed"], false);
    expect(page.multi("skills", ["statIncreases", "allowed"], "PA", true).statIncreases.allowed).toEqual(["PA"]);
    expect(page.multi("stars", ["starPacks", 0, "stars"], "Morg 'n' Thorg", true).starPacks[0].stars).toEqual(["Morg 'n' Thorg"]);
    page.multiAll("stars", ["starPacksAllowed"], false);
    expect(page.multi("stars", ["starPacksAllowed"], "legends", true).starPacksAllowed).toEqual(["legends"]);
    page.multiAll("inducements", ["inducements", "rosterOnly", "halfling_master_chef"], false);
    expect(page.multi("inducements", ["inducements", "rosterOnly", "halfling_master_chef"], "Halfling", true).inducements.rosterOnly).toEqual({ halfling_master_chef: ["Halfling"] });
    expect(page.multiAll("inducements", ["inducements", "rosterOnly", "halfling_master_chef"], true).inducements?.rosterOnly).toBeUndefined();
  });

  it("count-mode swap ratio / max write the flat allotment (no view-only swap rate)", async () => {
    const page = await editor();
    page.core.handleEditorAction("mode-count", { dataset: {} });
    expect(page.set("skills", ["skillAllotment", "secondarySwapRatio"], { value: "3" }).skillAllotment.secondarySwapRatio).toBe(3);
    expect(page.set("skills", ["skillAllotment", "secondarySwapMax"], { value: "2" }).skillAllotment.secondarySwapMax).toBe(2);
    page.core.handleEditorAction("mode-pool", { dataset: {} });
    expect(plain(page.core.serializePackage()).skillAllotment.secondarySwapRatio).toBeUndefined();
  });

  it("adds / removes team rules, star packs and per-skill gold overrides", async () => {
    const page = await editor({ name: "Adds", skillAllotment: { skillPointBudget: 0 } });
    page.core.state.tab = "races";
    page.core.handleEditorChange({ dataset: { control: "rule-team" }, value: "Halfling" });
    page.core.handleEditorAction("add-team-rule", { dataset: {} });
    expect(plain(page.core.serializePackage()).teamRules).toEqual([{ team: "Halfling" }]);
    page.core.handleEditorAction("remove-team-rule", { dataset: { index: "0" } });
    expect(plain(page.core.serializePackage()).teamRules).toBeUndefined();

    page.core.handleEditorAction("add-star-pack", { dataset: {} });
    expect(plain(page.core.serializePackage()).starPacks).toEqual([{ id: "pack-1", label: "Pack 1", fee: 0, max: 1, stars: [] }]);
    page.core.handleEditorAction("remove-star-pack", { dataset: { index: "0" } });
    expect(plain(page.core.serializePackage()).starPacks).toBeUndefined();

    page.core.handleEditorChange({ dataset: { control: "gold-override-skill" }, value: "Guard" });
    page.core.handleEditorChange({ dataset: { control: "gold-override-cost" }, value: "35" });
    page.core.handleEditorAction("add-gold-override", { dataset: {} });
    expect(plain(page.core.serializePackage()).skillAllotment.skillCostGold).toEqual({ Guard: 35000 });
    page.core.handleEditorAction("remove-gold-override", { dataset: { name: "Guard" } });
    expect(plain(page.core.serializePackage()).skillAllotment.skillCostGold).toBeUndefined();
  });

  it("global skill packages carry count-mode fields", async () => {
    const page = await editor({ name: "Packs", skillAllotment: { skillPointBudget: 0 }, skillPackages: [{ label: "A", gold: 1100000, skillPointBudget: 0 }] });
    expect(page.core.state.view.system).toBe("packages");
    expect(page.set("races", ["skillPackages", 0, "maxSkills"], { value: "5" }).skillPackages[0].maxSkills).toBe(5);
    expect(page.set("races", ["skillPackages", 0, "maxSecondary"], { value: "1" }).skillPackages[0].maxSecondary).toBe(1);
  });

  it("matrix rows and cells: label, swap ratio / max, stacking, teams, star access, banned stars", async () => {
    const raw = {
      name: "Matrix",
      skillAllotment: { skillPointBudget: 0 },
      matrix: { columns: [{ gold: 1150000 }], rows: [{ primary: 6, secondary: 0, secondarySwap: false }], cells: [{ col: 0, row: 0, teams: [] }] },
    };
    const page = await editor(raw);
    expect(page.core.state.view.system).toBe("matrix");
    expect(page.set("races", ["matrix", "rows", 0, "label"], { value: "Six primaries" }).matrix.rows[0].label).toBe("Six primaries");
    expect(page.set("races", ["matrix", "rows", 0, "secondarySwapRatio"], { value: "2" }).matrix.rows[0].secondarySwapRatio).toBe(2);
    expect(page.set("races", ["matrix", "rows", 0, "secondarySwapMax"], { value: "1" }).matrix.rows[0].secondarySwapMax).toBe(1);
    expect(page.set("races", ["matrix", "rows", 0, "maxStackedPlayers"], { value: "2" }).matrix.rows[0].maxStackedPlayers).toBe(2);
    expect(page.multi("races", ["matrix", "cells", 0, "teams"], "Orc", true).matrix.cells[0].teams).toEqual(["Orc"]);
    expect(page.set("races", ["matrix", "cells", 0, "starPlayersAllowed"], { value: "false" }).matrix.cells[0].starPlayersAllowed).toBe(false);
    page.multiAll("races", ["matrix", "cells", 0, "bannedStars"], false);
    expect(page.multi("races", ["matrix", "cells", 0, "bannedStars"], "Grak", true).matrix.cells[0].bannedStars).toEqual(["Grak"]);
  });

  it("the data note and inducements from the dataset (riotous rookies etc.) are editable", async () => {
    const page = await editor();
    page.core.state.tab = "package";
    expect(page.core.editorHtml()).toContain('data-field="dataNote"');
    page.core.handleEditorChange({ dataset: { field: "dataNote" }, value: "Spot-check the star table." });
    expect(plain(page.core.serializePackage()).dataNote).toBe("Spot-check the star table.");
    page.core.state.tab = "inducements";
    const html = page.core.editorHtml();
    for (const id of ["riotous_rookies", "mortuary_assistant", "plague_doctor", "extra_team_training"]) expect(html).toContain(`data-id="${id}"`);
  });
});
