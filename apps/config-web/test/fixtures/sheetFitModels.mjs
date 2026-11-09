// Team-sheet one-page fixtures (owner 11-09): models for public/sheet-pdf.js fitSheetPdf, built through the page's own
// TeamBuilderCore.rosterSheetModel (pass it in as `core`). Fake data only (laws A2): invented team, coach and player names.
//
// emeraldWardens: recreated from the owner's real export (an 11-player High Elf team on the NAF World Cup 2027 (Malta)
// package) that spilled players 10-11 and the Keywords line onto page 2.
// worstCase: 16 rows (the BB2025 maximum) with 30-character names, 4-5 skills each, a captain, three stars (one custom star
// with long special rules), many ruleset rows with a long package name, every sideline line, many inducements and long
// team special rules.

const pos = (name, cost, [MA, ST, AG, PA, AV], skills, keywords, extra = {}) => ({ positionId: name, name, cost, MA, ST, AG, PA, AV, skills, keywords, ...extra });
const primary = () => "primary";

export const EMERALD_RULESET = [
  ["Package", "NAF World Cup 2027 (Malta) - Rules Pack V3.0"],
  ["Tier", "Gold Budget 1,100,000"],
  ["TV cap", "1,100k"],
  ["SP budget", "44 SP"],
  ["SP prices", "primary 6 · secondary 10 · elite +2 · stacking +2"],
  ["Skills per player", "max 2"],
  ["Stacked players", "max 1 (max 2 skills · max 2 secondary)"],
  ["Star players", "None"],
  ["League / special rule", "Elven Kingdoms League"],
];

export function emeraldWardens(core) {
  const prince = pos("Dragon Prince", 110_000, [8, 3, "2+", "4+", "9+"], ["Block", "My Ball", "Steady Footing"], ["blitzer", "elf", "runner"]);
  const lion = pos("White Lion", 110_000, [7, 3, "2+", "3+", "9+"], ["Claws", "Wrestle"], ["blitzer", "elf"]);
  const phoenix = pos("Phoenix Warrior", 90_000, [6, 3, "2+", "2+", "9+"], ["Cloud Burster", "Pass", "Safe Pass"], ["elf", "thrower"]);
  const lineman = pos("High Elf Lineman", 65_000, [6, 3, "2+", "3+", "9+"], [], ["elf", "lineman"]);
  const players = [
    [prince, "Cythera Silversong", ["Dodge"]], [prince, "Vaelin Sunweaver", ["Dodge"]],
    [lion, "Sylvar Moonweaver", ["Dodge"]], [lion, "Sylvia Starbrook", ["Dodge"]],
    [phoenix, "Naerdil Swiftweaver", ["Leader"]],
    [lineman, "Vaeri Leafsong", ["Wrestle"]], [lineman, "Sylvar Swiftgleam", []], [lineman, "Vaeri Windgleam", []],
    [lineman, "Naerdil Moonweaver", []], [lineman, "Lariel Leafshade", []], [lineman, "Maethor Starsong", []],
  ].map(([position, name, chosenSkills]) => ({ position, name, chosenSkills, chosenStatIncreases: [], accessOf: primary }));
  const model = core.rosterSheetModel({
    raceName: "High Elf", coach: "Test Coach", teamName: "Emerald Wardens",
    rulesetName: "NAF World Cup 2027 (Malta) - Rules Pack V3.0 — Gold Budget 1,100,000 (SPP, stacking and star access per team via teamRules)",
    players,
    staff: { reRolls: 2, apothecary: 1, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1 },
    apothecaryAllowed: true,
    inducements: [{ label: "Team Mascot", count: 1 }],
    specialRules: ["Elven Kingdoms League"],
    summary: { goldUsed: 1_095_000, goldBudget: 1_100_000, skillsCost: 160_000, inducementsCost: 25_000, primarySkillCount: 6, secondarySkillCount: 0 },
    costs: { players: 920_000, stars: 0, sideline: 150_000, skills: 160_000, inducements: 25_000 },
    budget: 1_100_000,
  });
  return { ...model, ruleset: EMERALD_RULESET.map((r) => [...r]) };
}

export const WORST_RULESET = [
  ["Package", "Grand Federation Continental Open Championship 2027 (Valletta, Malta) - Official Rules Pack V3.0.1 Final"],
  ["Tier", "Tier 4 — Underdogs, Gold Budget 1,250,000 plus 2 extra inducement slots"],
  ["TV cap", "1,250k"],
  ["Matrix cell", "Tier 4 × Column C (stacking allowed on two players)"],
  ["Primary skills", "6"],
  ["Secondary skills", "2"],
  ["Secondary swap", "2 primary → 1 secondary (max 2)"],
  ["SP budget", "72 SP"],
  ["SP prices", "primary 6 · secondary 10 · elite +2 · stacking +2"],
  ["Skills per player", "max 3"],
  ["Elite skills", "max 2 per team (Block, Dodge, Guard, Mighty Blow)"],
  ["Stacked players", "max 2 (max 3 skills · max 1 secondary · max 1 elite)"],
  ["Characteristics", "max 1 increase per player, none above the racial maximum"],
  ["Star packs", "Pack A: Grim Ironjaw + Morg 'n' Thorg · Pack B: any two Chaos stars"],
  ["Star players", "max 3, paid in SP"],
  ["League / special rule", "Lustrian Superleague, Favoured of Khorne and Bribery and Corruption"],
];

export function worstCase(core) {
  const skills = ["Block", "Dodge", "Guard", "Mighty Blow", "Sure Hands", "Sidestep", "Tackle", "Strip Ball", "Diving Tackle", "Jump Up"];
  const blitzer = pos("Chaos Renegade Blitzer", 95_000, [7, 3, "3+", "4+", "9+"], ["Block", "Hatred (Elves)", "Iron Hard Skin"], ["blitzer", "human"]);
  const big = pos("Chaos Renegade Rat Ogre", 150_000, [6, 5, "4+", "-", "9+"], ["Animal Savagery", "Frenzy", "Loner (4+)", "Mighty Blow", "Prehensile Tail"], ["big guy", "skaven"]);
  const line = pos("Chaos Renegade Lineman", 50_000, [6, 3, "3+", "4+", "9+"], ["Animosity (all team-mates)", "Dirty Player"], ["human", "lineman"]);
  const grim = pos("Grim Ironjaw", 200_000, [5, 4, "3+", "-", "10+"], ["Block", "Dauntless", "Frenzy", "Hatred (Big Guy)", "Loner (4+)", "Multiple Block", "Thick Skull"], ["blitzer", "dwarf"], { isStar: true });
  const morg = pos("Morg 'n' Thorg", 380_000, [6, 6, "3+", "4+", "11+"], ["Block", "Loner (4+)", "Mighty Blow", "Thick Skull", "Throw Team-mate", "The Ballista"], ["big guy", "ogre"], { isStar: true });
  const custom = pos("Custom Star: The Emerald Executioner", 260_000, [7, 4, "2+", "3+", "10+"], ["Block", "Dodge", "Loner (4+)", "Stand Firm"], ["blitzer", "elf"], {
    isStar: true,
    specialRules: [
      { kind: "trait", name: "Verdant Wrath", description: "Once per game, when this player is Marked by two or more opposition players, they may make a free Block action against one of them before their own activation ends, ignoring Tackle Zones." },
      { kind: "rule", name: "Oath of the Wardens", description: "While this player is on the pitch, team-mates within two squares may reroll a failed Dodge test once per drive; the reroll cannot be used during a Blitz." },
    ],
  });
  const names = ["Bartholomew Thunderstrike-Vale", "Maximiliana Starbrook-Ashgrove", "Grimbold Ironfist of the Deeps", "Thorgrim Stonehammer the Third"];
  const name = (i) => `${names[i % names.length]}`.slice(0, 30);
  const players = [];
  for (let i = 0; i < 4; i++) players.push({ position: blitzer, name: name(i), chosenSkills: [skills[i], skills[i + 4]], chosenStatIncreases: i % 2 ? ["AV"] : ["MA"], accessOf: (s) => (s === skills[i + 4] ? "secondary" : "primary"), captain: i === 0 });
  players.push({ position: big, name: name(4), chosenSkills: ["Block", "Guard"], chosenStatIncreases: ["ST"], accessOf: primary });
  for (let i = 0; i < 8; i++) players.push({ position: line, name: name(i + 5), chosenSkills: [skills[(i + 5) % skills.length], skills[(i + 6) % skills.length]], chosenStatIncreases: [], accessOf: primary });
  players.push({ position: grim, chosenSkills: [] }, { position: morg, chosenSkills: [] }, { position: custom, chosenSkills: [] });
  const model = core.rosterSheetModel({
    raceName: "Chaos Renegade", coach: "Lord Commander Maximilian von Testcoach",
    teamName: "The Unbreakable Grand Order of the Eternal Emerald Wardens XX",
    rulesetName: `${WORST_RULESET[0][1]} — ${WORST_RULESET[1][1]}`,
    players,
    staff: { reRolls: 8, apothecary: 1, assistantCoaches: 6, cheerleaders: 6, dedicatedFans: 7 },
    apothecaryAllowed: true,
    inducements: [
      { label: "Bloodweiser Kegs", count: 2 }, { label: "Bribes", count: 3 }, { label: "Extra Team Training", count: 4 },
      { label: "Halfling Master Chef", count: 1 }, { label: "Wandering Apothecaries", count: 2 }, { label: "Mortuary Assistant", count: 1 },
      { label: "Plague Doctor", count: 1 }, { label: "Riotous Rookies", count: 1 }, { label: "Team Mascot", count: 1 }, { label: "Weather Mage", count: 1 },
    ],
    specialRules: ["Favoured of Khorne", "Lustrian Superleague", "Bribery and Corruption", "Brawlin' Brutes (an extremely long special rule name for testing)"],
    summary: { goldUsed: 1_249_000, goldBudget: 1_250_000, starsCost: 840_000, skillsCost: 320_000, inducementsCost: 410_000, statIncreasesCost: 60_000, starFeesCost: 40_000, primarySkillCount: 18, secondarySkillCount: 4 },
    costs: { players: 930_000, stars: 840_000, sideline: 690_000, skills: 320_000, inducements: 410_000 },
    budget: 1_250_000,
    captainAvailable: true,
  });
  return { ...model, ruleset: WORST_RULESET.map((r) => [...r]) };
}
