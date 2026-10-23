import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The browser builder is dependency-free JS: its pure core attaches to globalThis.TeamBuilderCore and
// the UI half only boots when a document with the builder's markup exists — so a bare vm context
// exercises the core without a DOM.
const publicDir = new URL("../public/", import.meta.url);
const js = readFileSync(new URL("team-builder.js", publicDir), "utf8");
const html = readFileSync(new URL("team-builder.html", publicDir), "utf8");
const css = readFileSync(new URL("team-builder.css", publicDir), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadCore(): any {
  const context: Record<string, unknown> = { console };
  runInNewContext(js, context);
  return context.TeamBuilderCore;
}
const core = loadCore();

const blitzer = { positionId: "65748", name: "Dwarf Blitzer", cost: 100_000, MA: 5, ST: 3, AG: "4+", PA: "4+", AV: "10+", skills: ["Diving Tackle", "Block", "Tackle", "Thick Skull"], keywords: ["blitzer", "dwarf"] };
const slayer = { positionId: "65749", name: "Troll Slayer", cost: 95_000, MA: 5, ST: 3, AG: "4+", PA: "5+", AV: "9+", skills: ["Block", "Dauntless", "Frenzy*", "Hatred (Troll)*", "Thick Skull"], keywords: ["dwarf", "special"] };
const runner = { positionId: "65747", name: "Dwarf Runner", cost: 80_000, MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: ["Sprint", "Sure Hands", "Thick Skull"], keywords: ["dwarf", "runner"] };
const lineman = { positionId: "65746", name: "Dwarf Blocker Lineman", cost: 70_000, MA: 4, ST: 3, AG: "4+", PA: "5+", AV: "10+", skills: ["Block", "Defensive", "Thick Skull"], keywords: ["dwarf", "lineman"] };
const deathroller = { positionId: "65750", name: "Deathroller", cost: 170_000, MA: 5, ST: 7, AG: "5+", PA: "-", AV: "11+", skills: ["Dirty Player"] };

describe("team builder page — wire picks", () => {
  it("merges consecutive identical players and keeps per-player skills / stat increases as their own picks, in roster order", () => {
    const slots = [
      { positionId: "B", chosenSkills: ["Guard"], chosenStatIncreases: [] },
      { positionId: "B", chosenSkills: ["Mighty Blow"], chosenStatIncreases: [] },
      { positionId: "L", chosenSkills: [], chosenStatIncreases: ["AV"] },
      { positionId: "L", chosenSkills: ["Guard"], chosenStatIncreases: [] },
      { positionId: "L", chosenSkills: ["Guard"], chosenStatIncreases: [] },
      { positionId: "L", chosenSkills: [], chosenStatIncreases: [] },
      { positionId: "L", chosenSkills: [], chosenStatIncreases: [] },
    ];
    expect(core.buildPicks(slots, { skills: true, stats: true })).toEqual([
      { positionId: "B", count: 1, chosenSkills: ["Guard"] },
      { positionId: "B", count: 1, chosenSkills: ["Mighty Blow"] },
      { positionId: "L", count: 1, chosenStatIncreases: ["AV"] },
      { positionId: "L", count: 2, chosenSkills: ["Guard"] },
      { positionId: "L", count: 2 },
    ]);
  });

  it("drops skills in Create mode and stat increases when the ruleset doesn't offer them", () => {
    const slots = [
      { positionId: "B", chosenSkills: ["Guard"], chosenStatIncreases: ["AV"] },
      { positionId: "B", chosenSkills: [], chosenStatIncreases: [] },
    ];
    expect(core.buildPicks(slots, { skills: false })).toEqual([{ positionId: "B", count: 2 }]);
    expect(core.buildPicks(slots, { skills: true, stats: false })).toEqual([
      { positionId: "B", count: 1, chosenSkills: ["Guard"] },
      { positionId: "B", count: 1 },
    ]);
  });

  it("restores slots from saved picks (inverse of buildPicks)", () => {
    const positions = new Map([["B", { positionId: "B" }], ["L", { positionId: "L" }]]);
    const picks = [{ positionId: "B", count: 1, chosenSkills: ["Guard"] }, { positionId: "L", count: 2, chosenStatIncreases: ["AV"] }, { positionId: "gone", count: 1 }];
    const slots = core.slotsFromPicks(picks, (id: string) => positions.get(id));
    expect(slots).toHaveLength(3);
    expect(core.buildPicks(slots, { skills: true, stats: true })).toEqual(picks.slice(0, 2));
  });
});

describe("team builder page — ruleset knobs", () => {
  const rules = {
    tier: 5, maxSecondary: 2, eliteMaxTotal: 4, eliteMaxSameSkill: 2, maxStackedPlayers: 1,
    stackedPlayer: { maxSkills: 2, maxSecondary: 1, maxElite: 1 },
    statIncreases: { allowed: true, costGold: 20_000 },
    starPacks: [{ id: "legends", label: "Legends", fee: 50_000, feeMode: "once", max: 1, stars: ["Grim Ironjaw"] }],
    maxStars: 1,
  };

  it("normalizes the preview echo and degrades to null when absent", () => {
    expect(core.normalizeTierRules({ name: "Small Gods", rules })?.statIncreases?.costGold).toBe(20_000);
    expect(core.normalizeTierRules({ name: "Old server", budget: 1_000_000 })).toBeNull();
    expect(core.normalizeTierRules({ ...rules, statIncreases: { allowed: false, costGold: 1 } })?.statIncreases).toBeNull();
    expect(core.normalizeTierRules(null)).toBeNull();
  });

  it("lists the tier limits for the ruleset panel", () => {
    const lines = core.tierLimitLines(core.normalizeTierRules(rules));
    expect(lines).toContain("Secondary skills: max 2");
    expect(lines).toContain("Elite skills: max 4 total, max 2 of the same skill");
    expect(lines.join("\n")).toMatch(/Stacked players: max 1 \(max 2 skills · max 1 secondary · max 1 elite\)/);
    expect(lines.join("\n")).toMatch(/Characteristics: \+1 stat \(20k\)/);
    expect(lines.join("\n")).toMatch(/Star packs: Legends \+50k once \(max 1\)/);
  });

  it("groups /tiers rows into a tournament rules-sheet table", () => {
    const table = core.tierTable([
      { ...rules, name: "Dwarf", tier: 5, gold: 1_455_000 },
      { name: "Amazon", tier: 2, gold: 1_200_000 },
      { ...rules, name: "Halfling", tier: 5, gold: 1_455_000 },
    ]);
    expect(table.map((row: { tier: number }) => row.tier)).toEqual([2, 5]);
    expect(table[1].rosters.map((r: { name: string }) => r.name)).toEqual(["Dwarf", "Halfling"]);
    const markup = core.tierTableHtml(table);
    expect(markup).toContain("Star packs");
    expect(markup).toContain("Dwarf <small>(1,455k)</small>");
    expect(markup).toContain("max 2 skills · max 1 secondary · max 1 elite");
    // A server that predates the knobs still gets a tier/roster table.
    expect(core.tierTableHtml(core.tierTable([{ name: "Dwarf", tier: 5 }], [{ tier: 5, gold: 1_100_000 }]))).not.toContain("Star packs");
  });

  it("finds a star's pack by normalized name and prices stat increases", () => {
    expect(core.starPacksFor("grim ironjaw", rules.starPacks)).toHaveLength(1);
    expect(core.starPacksFor("Morg 'n' Thorg", rules.starPacks)).toHaveLength(0);
    expect(core.statIncreaseCost(rules.statIncreases, "AV")).toBe(20_000);
    expect(core.statIncreaseCost({ costGold: { AV: 10_000, MA: 30_000 } }, "MA")).toBe(30_000);
  });

  it("applies stat increases to the printed profile", () => {
    const stats = core.improvedStats(lineman, ["AV", "AG"]);
    expect(stats.AV).toEqual({ value: "11+", improved: true });
    expect(stats.AG).toEqual({ value: "3+", improved: true });
    expect(stats.MA).toEqual({ value: 4, improved: false });
    expect(core.improvedStats(lineman, ["MA"]).MA.value).toBe(5);
  });
});

describe("team builder page — star pairs", () => {
  it("collapses linked and known star pairs into one choice", () => {
    const choices = core.buildStarChoices([
      { positionId: "1", name: "Grak", cost: 250_000, isStar: true, teamWithPositionId: "2" },
      { positionId: "2", name: "Crumbleberry", cost: 0, isStar: true, teamWithPositionId: "1" },
      { positionId: "3", name: "Grim Ironjaw", cost: 190_000, isStar: true },
      { positionId: "4", name: "Dribl", cost: 80_000, isStar: true },
      { positionId: "5", name: "Drull", cost: 80_000, isStar: true },
      { positionId: "6", name: "Valen Swift", cost: 100_000, isStar: true },
      lineman,
    ]);
    const labels = choices.map((c: { label: string }) => c.label);
    expect(labels).toContain("Grak & Crumbleberry");
    expect(labels).toContain("Dribl & Drull");
    expect(labels).toContain("Grim Ironjaw");
    // An incomplete known pair is never offered as a singleton.
    expect(labels).not.toContain("Valen Swift");
  });
});

describe("team builder page — roster sheet", () => {
  // The owner's reference sheet (Small Gods, Dwarf T5).
  const access = (secondary: string[] = []) => (skill: string) => (secondary.includes(skill) ? "secondary" : "primary");
  const players = [
    { position: blitzer, chosenSkills: ["Guard"], accessOf: access() },
    { position: blitzer, chosenSkills: ["Mighty Blow"], accessOf: access() },
    { position: slayer, chosenSkills: ["Guard"], accessOf: access() },
    { position: lineman, chosenSkills: ["Dirty Player"], accessOf: access() },
    { position: runner, chosenSkills: ["Block"], accessOf: access() },
    { position: lineman, chosenSkills: ["Guard"], accessOf: access(["Guard"]) },
    { position: lineman, chosenSkills: ["Guard"], accessOf: access(["Guard"]) },
    ...Array.from({ length: 5 }, () => ({ position: lineman, chosenSkills: [] })),
  ];
  const input = {
    raceName: "Dwarf",
    coach: "flutethecat",
    teamName: "Amorical Dwarves w/ Bribe",
    players,
    staff: { reRolls: 2, apothecary: 1, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 },
    apothecaryAllowed: true,
    inducements: [{ label: "Bribes", count: 1 }, { label: "Team Mascot", count: 1 }, { label: "Weather Mage", count: 0 }],
    specialRules: ["Brawlin' Brutes", "Bribery and Corruption", "Worlds Edge Superleague", "Worlds Edge Superleague"],
    summary: { goldUsed: 1_420_000, goldBudget: 1_455_000, skillsCost: 240_000, inducementsCost: 75_000, primarySkillCount: 5, secondarySkillCount: 2, statIncreasesCost: 0, starFeesCost: 0 },
    costs: { players: 935_000, stars: 0, sideline: 170_000, skills: 0, inducements: 0 },
    budget: 1_455_000,
  };
  const model = core.rosterSheetModel(input);
  const markup: string = core.rosterSheetHtml(model);

  it("builds the reference sheet's boxes", () => {
    expect(model.rows).toHaveLength(12);
    expect(model.rows.map((r: { number: number }) => r.number)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(model.sideline).toEqual([
      ["Apothecary", "Yes"], ["Assistant coaches", "0"], ["Cheerleaders", "0"], ["Dedicated fans", "1"], ["Rerolls", "2"],
    ]);
    expect(model.inducements.map((i: { label: string }) => i.label)).toEqual(["Bribes", "Team Mascot"]);
    expect(model.specialRules).toEqual(["Brawlin' Brutes", "Bribery and Corruption", "Worlds Edge Superleague"]);
    expect(model.summary).toEqual([
      ["Players cost", "935k"], ["Skills cost", "240k"], ["Inducement cost", "75k"], ["Sideline cost", "170k"],
      ["Primary skills", "5"], ["Secondary skills", "2"], ["Total", "1,420k / 1,455k"],
    ]);
  });

  it("renders printed skills plain then added skills coloured by access, asterisks kept", () => {
    expect(markup).toContain("COACH NAME");
    expect(markup).toContain("TEAM NAME");
    expect(markup).toContain("Amorical Dwarves w/ Bribe");
    expect(markup).toContain('<span class="sk-printed">Frenzy*</span>, <span class="sk-printed">Hatred (Troll)*</span>');
    expect(markup).toContain('<span class="sk-printed">Thick Skull</span>, <span class="sk-primary">Guard</span>');
    expect(markup).toContain('<span class="sk-secondary">Guard</span>');
    expect(markup.match(/sk-primary/g)).toHaveLength(5);
    expect(markup.match(/sk-secondary/g)).toHaveLength(2);
    expect(markup).toContain('<td class="cost">100k</td>');
    expect(markup).toMatch(/<td class="stat">4\+<\/td><td class="stat">4\+<\/td><td class="stat">10\+<\/td>/);
    expect(core.SHEET_CSS).toMatch(/\.sk-primary\{color:#1a73c8;font-style:italic;\}/);
    expect(core.SHEET_CSS).toMatch(/\.sk-secondary\{color:#5a9e2f;font-style:italic;\}/);
  });

  it("writes the keyword line from roster keywords, once per position", () => {
    expect(markup).toContain("Keywords: <b>Dwarf Blitzer:</b> Blitzer, Dwarf | <b>Troll Slayer:</b> Dwarf, Special | <b>Dwarf Blocker Lineman:</b> Dwarf, Lineman | <b>Dwarf Runner:</b> Dwarf, Runner");
    const noKeywords = core.rosterSheetHtml(core.rosterSheetModel({ ...input, players: [{ position: deathroller, chosenSkills: [] }] }));
    expect(noKeywords).not.toContain("Keywords:");
    expect(noKeywords).toMatch(/<td class="stat">-<\/td>/);
  });

  it("shows stat increases in the stat cell and the skill list, plus the optional cost rows", () => {
    const withStats = core.rosterSheetModel({
      ...input,
      players: [{ position: lineman, chosenSkills: [], chosenStatIncreases: ["AV"] }, { position: { ...slayer, name: "Grim Ironjaw", isStar: true }, chosenSkills: [] }],
      summary: { ...input.summary, statIncreasesCost: 20_000, starFeesCost: 50_000, starsCost: 190_000 },
    });
    const sheet = core.rosterSheetHtml(withStats);
    expect(sheet).toContain('<td class="stat improved">11+</td>');
    expect(sheet).toContain('<span class="sk-stat">+AV</span>');
    expect(withStats.summary).toContainEqual(["Stat increases", "20k"]);
    expect(withStats.summary).toContainEqual(["Star fees", "50k"]);
    expect(withStats.summary).toContainEqual(["Star players cost", "190k"]);
    expect(withStats.rows[1].isStar).toBe(true);
    expect(withStats.rows[1].number).toBe(2);
  });

  it("produces a standalone landscape A4 document and a safe file name", () => {
    const doc: string = core.standaloneSheetDocument(model);
    expect(doc.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(doc).toContain("@page{size:A4 landscape");
    expect(doc).toContain('"Noto Serif"');
    expect(core.sheetFileName(model)).toBe("Amorical_Dwarves_w_Bribe_roster.html");
    expect(core.esc("<script>")).toBe("&lt;script&gt;");
  });
});

describe("team builder page — merged server shapes", () => {
  it("reads statIncreases.allowed as the list of raisable characteristics", () => {
    const t5 = core.normalizeTierRules({ rules: { statIncreases: { allowed: ["AV", "PA"], costGold: { MA: 20_000, PA: 20_000, AV: 10_000 } } } });
    expect(t5.statIncreases.stats).toEqual(["AV", "PA"]);
    expect(core.statIncreaseLabel(t5.statIncreases)).toBe("+PA 20k, +AV 10k");
    expect(core.normalizeTierRules({ rules: { statIncreases: { allowed: [], costGold: { AV: 10_000 } } } }).statIncreases).toBeNull();
  });

  it("names rosters whose star packs differ from the rest of their tier", () => {
    const free = { id: "free", label: "Free", fee: 0, feeMode: "each", max: 2, stars: [] };
    const mega = { id: "mega", label: "Mega Star", fee: 80_000, feeMode: "each", max: 1, stars: [] };
    const markup = core.tierTableHtml(core.tierTable([
      { name: "Chaos Chosen", tier: 4, gold: 1_395_000, rules: { maxSecondary: 4, starPacks: [free] } },
      { name: "Tomb Kings", tier: 4, gold: 1_380_000, rules: { maxSecondary: 4, starPacks: [free] } },
      { name: "Snotling", tier: 4, gold: 1_435_000, rules: { maxSecondary: 4, starPacks: [free, mega] } },
    ]));
    expect(markup).toContain("Free (max 2)<div class=\"tier-pack-exception\"><b>Snotling:</b> Free (max 2) · Mega Star +80k each (max 1)</div>");
  });

  it("prints position names in regular weight", () => {
    expect(core.SHEET_CSS).toContain(".rs-roster td.pos{white-space:nowrap;font-weight:400;}");
  });
});

describe("team builder page — source contract", () => {
  it("never writes re-roll (copy rule)", () => {
    for (const source of [js, html, css]) expect(source).not.toMatch(/re-roll/i);
    expect(js).toContain('label: "Rerolls"');
  });

  it("offers export, saves, Discord sign-in and all four modes", () => {
    for (const id of ["print-sheet", "download-sheet", "saves-panel", "save-button", "save-as-button", "discord-login", "tier-table", "skill-picker", "star-section", "inducement-section", "league"]) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const mode of ["create", "custom", "tournament", "library"]) expect(html).toContain(`data-mode="${mode}"`);
    expect(html).toContain("Sign in with Discord");
  });

  it("prints only the roster sheet, landscape", () => {
    expect(css).toMatch(/@media print \{[\s\S]*size: A4 landscape[\s\S]*body > \*:not\(\.roster-sheet-host\) \{ display: none !important; \}/);
    expect(css).toMatch(/\.roster-sheet-host \{ display: none; \}/);
  });

  it("codes against the saves + build contract", () => {
    expect(js).toContain('"/api/fork/team-builder/saves"');
    expect(js).toMatch(/saves\/\$\{encodeURIComponent\(currentSave\.id\)\}`, \{ name, body \}, "PUT"/);
    expect(js).toContain('{ method: "DELETE" }');
    expect(js).toContain("saveId: currentSave.id");
    expect(js).toContain("chosenStatIncreases");
    expect(js).toContain("rosteredInducements");
  });

  it("draws a Super FUMBBL icon left of every sideline staff row", () => {
    expect(js).toContain('api("/icons/ui/manifest.json")');
    const want: Record<string, [string, string]> = {
      reRolls: ["ui", "re_roll"],
      assistantCoaches: ["inducements", "part_time_assistant_coaches"],
      cheerleaders: ["inducements", "temp_agency_cheerleaders"],
      dedicatedFans: ["ui", "dedicated_fans"],
      apothecary: ["ui", "apothecary"],
    };
    const pub = new URL("../public/", import.meta.url);
    for (const [key, [set, name]] of Object.entries(want)) {
      expect(js).toContain(`${key}: ["${set}", "${name}"]`);
      const manifest = JSON.parse(readFileSync(new URL(`icons/${set}/manifest.json`, pub), "utf8"));
      const path = manifest.icons[name];
      expect(path, `${set}/${name} in manifest`).toBeTypeOf("string");
      expect(readFileSync(new URL(path, pub)).length).toBeGreaterThan(0);
    }
    expect(js).toContain('class="stepper-row staff-row');
    expect(css).toContain(".stepper-row.staff-row { grid-template-columns: 36px minmax(0, 1fr) 32px 20px 32px; }");
  });

  it("prices inducements with the team's Bribery and Corruption terms", () => {
    expect(js).toContain("function inducementTerms(item)");
    expect(js).toMatch(/reducedSpecialRule && item\.reducedPrice != null && teamHasRule\(item\.reducedSpecialRule\)/);
    // Shown price, stepper max and the client total all go through the same terms.
    expect(js).toContain("inducementTerms(inducementCatalog.find((item) => item.key === pick.key)).price");
    expect(js).toContain("const termsMax = inducementTerms(item).max;");
    expect(js).toContain("clampInducementCounts();");
  });
});

describe("team builder page — review fixes", () => {
  it("never renders package/tier values as raw markup (stored XSS)", () => {
    const evil = "<img src=x onerror=alert(1)>";
    const table = core.tierTable([{
      name: evil, tier: 1, gold: evil,
      rules: {
        maxSecondary: evil, maxStackedPlayers: evil, eliteMaxTotal: evil, eliteMaxSameSkill: 2,
        stackedPlayer: { maxSkills: evil, maxSecondary: 1, maxElite: evil },
        statIncreases: { allowed: ["AV", evil], costGold: { AV: evil, PA: 20_000 }, maxPerPlayer: evil },
        starPacks: [{ id: evil, label: evil, fee: evil, feeMode: evil, max: evil, stars: [evil] }],
        maxStars: evil,
      },
    }]);
    const markup: string = core.tierTableHtml(table);
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;img");
    // tierLimitLines returns plain text (only star-pack labels are free strings); the ruleset panel
    // escapes every line before it reaches innerHTML.
    const lines: string[] = core.tierLimitLines(table[0].rules);
    expect(lines.filter((line) => !line.startsWith("Star packs")).join("\n")).not.toContain("<img");
    expect(js).toContain('lines.push(`<div class="ruleset-line ruleset-limit">${esc(line)}</div>`)');
    expect(table[0].rules.maxSecondary).toBeNull();
    expect(table[0].rules.statIncreases.stats).toEqual(["AV"]);
  });

  it("only sends stat increases the tier allows, and custom chosenStats only when asked", () => {
    const slots = [{ positionId: "L", chosenSkills: [], chosenStatIncreases: ["MA", "AV"], chosenStats: { MA: 6, AG: "3" } }];
    expect(core.buildPicks(slots, { skills: true, stats: true, allowedStats: ["AV", "PA"] }))
      .toEqual([{ positionId: "L", count: 1, chosenStatIncreases: ["AV"] }]);
    expect(core.buildPicks(slots, { skills: true, stats: false, customStats: true }))
      .toEqual([{ positionId: "L", count: 1, chosenStats: { MA: 6, AG: 3 } }]);
  });

  it("round-trips custom chosenStats through saved picks and shows them on the profile", () => {
    const positions = new Map([["L", { positionId: "L" }]]);
    const picks = [{ positionId: "L", count: 2, chosenStats: { MA: 5, AV: 11 } }];
    const slots = core.slotsFromPicks(picks, (id: string) => positions.get(id));
    expect(core.buildPicks(slots, { skills: true, customStats: true })).toEqual(picks);
    const stats = core.improvedStats(lineman, [], { MA: 5, AV: 11, AG: 4 });
    expect(stats.MA).toEqual({ value: 5, improved: true });
    expect(stats.AV).toEqual({ value: "11+", improved: true });
    expect(stats.AG).toEqual({ value: "4+", improved: false });
  });

  it("counts a star pair as one star pick and sanitizes ingested numbers", () => {
    expect(js).toContain("function starPickCount()");
    expect(js).toMatch(/if \(cap != null && starPickCount\(\) >= cap\) return;/);
    expect(js).toContain("summary: sanitizeSummary(result.summary)");
    expect(js).toContain("sanitizePackageRules(rulesResult.value.rules)");
    expect(js).toContain(".map(sanitizeRoster)");
    expect(js).toContain("requestBody({ forSave: true })");
  });
});

describe("tournament team builder page", () => {
  const ttHtml = readFileSync(new URL("tournament-team-builder.html", publicDir), "utf8");
  const panel = readFileSync(new URL("control-panel.html", publicDir), "utf8").replace(/\r\n/g, "\n");

  it("is its own pane that reuses the shared builder script and styles, locked to tournament mode", () => {
    expect(ttHtml).toContain('<body data-builder="tournament">');
    expect(ttHtml).toContain('<script src="/team-builder.js" defer></script>');
    expect(ttHtml).toContain('<link rel="stylesheet" href="/team-builder.css" />');
    expect(ttHtml).not.toContain('class="mode-grid"');
    expect(ttHtml).not.toContain('id="library-panel"');
    for (const id of ["tt-steps", "tt-step-package", "tt-packages", "tt-tier-table", "tt-step-race", "tt-races", "tt-locked-bar", "builder-panel", "print-sheet", "saves-panel", "discord-login"]) {
      expect(ttHtml).toContain(`id="${id}"`);
    }
    expect(js).toContain('const TOURNAMENT_PAGE = document.body?.dataset.builder === "tournament";');
    expect(js).toContain("function eligibleRaceGroups()");
  });

  it("is listed on the control panel with the shared hub-card markup", () => {
    expect(panel).toContain(`<a class="hub-card" href="./tournament-team-builder.html">
          <span class="hub-card-name">Tournament Team Builder</span>
          <span class="hub-card-description">Pick a tournament ruleset, choose a tiered race, and build a legal roster with its roster sheet.</span>
          <span class="hub-card-destination">tournament-team-builder.html</span>
        </a>`);
  });

  it("is served without the admin gate like the plain builder", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const sidecar = readFileSync(new URL("../src/auth/requireSession.ts", import.meta.url), "utf8");
    expect(server).toContain('pathname === "/tournament-team-builder.html"');
    expect(sidecar).toContain('pathname === "/tournament-team-builder.html"');
  });
});

describe("team builder page — re-review fixes", () => {
  const evil = "<img src=x onerror=alert(1)>";

  it("copies server objects field-by-field (no spreads into render paths) and escapes value-card text", () => {
    const ui = js.slice(js.indexOf("// UI"));
    for (const spread of ["...race", "...rules", "...roster", "...position", "...item", "...pack", "...tier", "...group", "...race.stars"]) {
      expect(ui).not.toContain(`${spread},`);
    }
    expect(js).toContain("skillCosts: sanitizeSkillCosts(race.skillCosts)");
    expect(js).toContain("<strong>${valueClass ? `<span class=\"${valueClass}\">${esc(value)}</span>` : esc(value)}</strong>");
    expect(js).toContain("package: sanitizePackageEcho(result.package)");
    // A hostile skillCosts value can no longer reach markup: the SP model only ever sees numbers.
    expect(core.playerSkillSp(["Block"], () => false, { primary: core.num(evil) ?? 1, secondary: 2, eliteSurcharge: 0, stackSurcharge: 0, eliteSkills: [] })).toBe(1);
  });

  it("restores saved picks without carrying unexpected values", () => {
    const slots = core.slotsFromPicks([{ positionId: "L", count: 1, chosenStatIncreases: ["av", evil], chosenStats: { MA: evil, AV: 11, x: 1 } }], () => ({ positionId: "L" }));
    expect(slots[0].chosenStatIncreases).toEqual(["AV"]);
    expect(slots[0].chosenStats).toEqual({ AV: 11 });
  });

  it("derives library stat changes including 0 and '-' printed stats", () => {
    const deathroller = { MA: 5, ST: 7, AG: "5+", PA: "-", AV: "11+" };
    // PA 3 on a position printed "-" (custom), everything else unchanged.
    expect(core.deriveStatChanges(deathroller, { movement: 5, strength: 7, agility: 5, passing: 3, armour: 11 }))
      .toEqual({ increases: [], absolute: { PA: 3 } });
    // A thrower stripped to no PA: stored 0 / null both mean none.
    const thrower = { MA: 6, ST: 3, AG: "3+", PA: "2+", AV: "9+" };
    expect(core.deriveStatChanges(thrower, { movement: 6, strength: 3, agility: 3, passing: 0, armour: 9 }).absolute).toEqual({ PA: 0 });
    expect(core.deriveStatChanges(thrower, { movement: 6, strength: 3, agility: 3, passing: null, armour: 9 }).absolute).toEqual({ PA: 0 });
    // Tournament-style +1 steps are still recognised as increases.
    expect(core.deriveStatChanges(thrower, { movement: 7, strength: 3, agility: 3, passing: 1, armour: 10 }))
      .toEqual({ increases: ["MA", "PA", "AV"], absolute: { MA: 7, PA: 1, AV: 10 } });
    // MA 0 is a real value, not "none".
    expect(core.deriveStatChanges(thrower, { movement: 0, strength: 3, agility: 3, passing: 2, armour: 9 }).absolute).toEqual({ MA: 0 });
    // Characteristics the detail didn't report are left alone.
    expect(core.deriveStatChanges(thrower, { movement: 6 })).toEqual({ increases: [], absolute: {} });
  });
});

describe("team builder page — Super FUMBBL art", () => {
  const pub = new URL("../public/", import.meta.url);
  const sprites = JSON.parse(readFileSync(new URL("sprites/manifest.json", pub), "utf8"));
  const crests = JSON.parse(readFileSync(new URL("crests/manifest.json", pub), "utf8"));

  it("resolves portraits with the client's rules (aliases, ruleset tags, stars)", () => {
    expect(core.resolveSprite(sprites, "Amazon", "Jaguar Warrior Blocker")).toBe("sprites/amazon/jaguarwarriorblocker.png");
    expect(core.resolveSprite(sprites, "Amazon", "Piranha Warrior")).toBe("sprites/amazon/piranhawarrior.png");
    expect(core.resolveSprite(sprites, "Orc", "Big Un Blocker")).toBe("sprites/orc/blackorcblocker.png");
    expect(core.resolveSprite(sprites, "Human", "Human Lineman")).toBe("sprites/human/lineman.png");
    expect(core.resolveSprite(sprites, "BB2025 Lizardmen", "Saurus Blocker")).toBe("sprites/lizardmen/saurusblocker.png");
    expect(core.resolveSprite(sprites, "Dwarf", "Grim Ironjaw")).toBe("sprites/stars/grimironjaw.png");
    expect(core.resolveSprite(sprites, "Dwarf", "Nobody")).toBeNull();
    expect(core.resolveSprite(null, "Dwarf", "Dwarf Blitzer")).toBeNull();
    expect(core.rosterRaceKey("Slann 2025")).toBe("slann");
  });

  it("covers every BB2025 roster position and crest", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = JSON.parse(readFileSync(new URL("../../../packages/bb-validator/src/dataset/bb2025/rosters.json", import.meta.url), "utf8"));
    for (const roster of data.rosters ?? data) {
      expect(core.resolveCrest(crests, roster.name), roster.name).not.toBeNull();
      for (const position of roster.positions) expect(core.resolveSprite(sprites, roster.name, position.name), `${roster.name} ${position.name}`).not.toBeNull();
    }
  });

  it("tags each card with its role keyword, never the race", () => {
    const amazon = [
      { name: "Eagle Warrior", keywords: ["Human", "Lineman"] },
      { name: "Python Warrior", keywords: ["Human", "Thrower"] },
      { name: "Piranha Warrior", keywords: ["Blitzer", "Human"] },
      { name: "Jaguar Warrior Blocker", keywords: ["Blocker", "Human"] },
    ];
    expect(amazon.map((p) => core.roleKeywords(p, amazon).join(" · "))).toEqual(["Lineman", "Thrower", "Blitzer", "Blocker"]);
    expect(core.roleKeywords({ keywords: ["big guy", "dwarf", "special"] }, [])).toEqual(["Big Guy", "Special"]);
    // No role keyword: fall back to dropping the roster-wide race tag.
    const odd = [{ keywords: ["Elf", "Wardancer"] }, { keywords: ["Elf", "Spear"] }];
    expect(core.roleKeywords(odd[0], odd)).toEqual(["Wardancer"]);
    expect(core.roleKeywords({}, [])).toEqual([]);
  });

  it("uses portraits/crests/icons on the builder but never on the roster sheet", () => {
    expect(js).toContain("${portraitHtml(current.raceName, position.name)}");
    expect(js).toContain('${crestHtml(roster.raceName, "tt-race-crest")}');
    expect(js).toContain("iconManifest?.icons?.[item.key]");
    const sheetCode = js.slice(js.indexOf("function rosterSheetHtml"), js.indexOf("const SHEET_CSS"));
    expect(sheetCode).not.toMatch(/sprite|crest|icons\//);
  });
});

describe("team builder page — modals and skill icons", () => {
  const ttHtml = readFileSync(new URL("tournament-team-builder.html", publicDir), "utf8");
  const skillIcons = JSON.parse(readFileSync(new URL("icons/skills/manifest.json", publicDir), "utf8"));

  it("opens Add skill / Add stat as native modal dialogs on both pages", () => {
    for (const page of [html, ttHtml]) {
      expect(page).toContain('<dialog id="skill-picker" class="builder-modal"');
      expect(page).toContain('<dialog id="stat-picker" class="builder-modal stat-modal"');
      expect(page).not.toContain('class="skill-picker-panel"');
    }
    expect(js).toContain("dialog.showModal()");
    expect(js).toContain("if (!moreSkillsAllowed(slot)) closeModal($(\"skill-picker\"));");
    expect(js).toContain("<span>Add</span><span>Stat</span>");
    expect(js).not.toContain("function statControl(");
    expect(css).toMatch(/@media \(max-width: 600px\) \{\s*\.builder-modal,/);
  });

  it("maps skill names to the client's canonical icon keys", () => {
    expect(core.skillIconKey("Thick Skull", skillIcons.aliases)).toBe("thickskull");
    expect(core.skillIconKey("Foul Appearance", skillIcons.aliases)).toBe("foulappearence");
    expect(core.skillIconKey("Claws", skillIcons.aliases)).toBe("claw");
    expect(core.skillIconKey("Hatred (Troll)*", skillIcons.aliases)).toBe("hatred");
    expect(core.skillIconKey("Loner (4+)", skillIcons.aliases)).toBe("loner");
    expect(core.skillIconKey("+AV", skillIcons.aliases)).toBe("statupav");
    for (const name of ["Block", "Guard", "Mighty Blow", "Dodge", "Hatred", "Loner", "Frenzy", "Dirty Player"]) {
      expect(skillIcons.icons[core.skillIconKey(name, skillIcons.aliases)], name).toBeTruthy();
    }
  });
});

describe("team builder page — review round 3", () => {
  it("closes and resets both pickers whenever the roster under them is replaced", () => {
    expect(js).toContain("function resetPickers()");
    for (const fn of ["function removeSlot(index) {", "function removeStarChoice(key) {", "function selectRoster(rosterId) {", "async function applyBody(body) {"]) {
      const body = js.slice(js.indexOf(fn), js.indexOf(fn) + 400);
      expect(body, fn).toContain("resetPickers();");
    }
    expect(js.slice(js.indexOf("async function selectMode("), js.indexOf("async function selectMode(") + 300)).toContain("resetPickers();");
    expect(js.slice(js.indexOf("async function choosePackage("), js.indexOf("async function choosePackage(") + 300)).toContain("resetPickers();");
  });

  it("re-checks eligibility right before mutating and caps skills before adding", () => {
    const add = js.slice(js.indexOf("function addSkill(skill) {"), js.indexOf("function addSkill(skill) {") + 300);
    expect(add.indexOf("skillPickBlock(slot, skill)")).toBeLessThan(add.indexOf("chosenSkills.push"));
    const set = js.slice(js.indexOf("function setStatIncrease(index, stat) {"), js.indexOf("function setStatIncrease(index, stat) {") + 800);
    expect(set.indexOf("statOptionState(slot, positionById(slot.positionId), stat)")).toBeLessThan(set.indexOf("slot.chosenStatIncreases = ["));
    expect(js).toContain("selectedPackSummary()?.maxPerPlayer");
    const block = js.slice(js.indexOf("function skillPickBlock("), js.indexOf("function skillPickBlock(") + 1400);
    for (const reason of ["position.isStar", "exclusiveStatAndSkill()", "Not a legal skill", "moreSkillsAllowed(slot)"]) expect(block).toContain(reason);
    const state = js.slice(js.indexOf("function statOptionState("), js.indexOf("function statOptionState(") + 900);
    for (const reason of ["position.isStar", "allowedStatList().includes(stat)", "to improve", "maxStatsPerPlayer()", "exclusiveStatAndSkill()"]) expect(state).toContain(reason);
  });

  it("returns focus to an enabled control in the row and only closes on true backdrop clicks", () => {
    const focus = js.slice(js.indexOf("function restoreModalFocus()"), js.indexOf("function restoreModalFocus()") + 900);
    expect(focus).toContain("opener && !opener.disabled");
    expect(focus).toContain('[data-remove-stat="${i}"]');
    expect(focus).toContain("row.focus()");
    expect(js).toContain("function isBackdropClick(event, dialog)");
    expect(js).not.toContain('event.target === $("skill-picker") ||');
  });

  it("ships PNG crests only", () => {
    const crests = JSON.parse(readFileSync(new URL("crests/manifest.json", publicDir), "utf8"));
    expect(Object.values(crests.crests).every((path) => String(path).endsWith(".png"))).toBe(true);
  });
});

describe("team builder page — modal cleanup", () => {
  it("cleans up synchronously on close and handles Esc via cancel (no reliance on the async close event)", () => {
    const close = js.slice(js.indexOf("function closeModal(dialog) {"), js.indexOf("function closeModal(dialog) {") + 300);
    expect(close).toContain("finishModal(dialog);");
    expect(js).toContain('dialog.dataset.modalActive !== "1"');
    expect(js).toContain('dialog.addEventListener("cancel", (event) => { // Esc');
  });
});
