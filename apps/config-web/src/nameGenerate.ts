/**
 * name/generate/{generator}/{gender} (FUMBBLUI contract §3A).
 *
 * Local corpus only — the fork never calls fumbbl.com for names. Generator ids follow the roster
 * XML's <nameGenerator> vocabulary (elf, orc, dwarf, skaven, amazon, norse, vampire, human/default);
 * an unknown generator falls back to default rather than erroring, because the id space is
 * upstream-owned and open-ended. Response shape is {name} (the client also tolerates {result}).
 */

export interface NameGenerateRequest {
  generator: string;
  gender: string;
}

export function nameGeneratePath(pathname: string): NameGenerateRequest | undefined {
  const match = pathname.match(/^\/api\/name\/generate\/([^/]+)\/([^/]+)$/);
  if (!match) return undefined;
  try {
    return { generator: decodeURIComponent(match[1]!), gender: decodeURIComponent(match[2]!) };
  } catch {
    return undefined;
  }
}

export const NAME_GENERATE_GENDERS = new Set(["male", "female", "neutral"]);

interface StylePools {
  maleFirst: readonly string[];
  femaleFirst: readonly string[];
  lastA: readonly string[];
  lastB: readonly string[];
}

const HUMAN: StylePools = {
  maleFirst: ["Aldric", "Bertrand", "Casimir", "Dieter", "Erwin", "Falko", "Gunther", "Hagen", "Josef", "Konrad", "Ludo", "Magnus", "Otto", "Reiner", "Stefan", "Viggo"],
  femaleFirst: ["Adela", "Brunhilde", "Carlotta", "Elsa", "Frieda", "Greta", "Hanna", "Ilsa", "Katarina", "Liesel", "Magda", "Petra", "Sigrid", "Theda", "Ulrike", "Wilma"],
  lastA: ["Iron", "Stone", "Swift", "Grim", "Black", "White", "Storm", "Bright", "Hard", "Long"],
  lastB: ["hammer", "field", "river", "wald", "mane", "brook", "gard", "helm", "wick", "shaw"],
};

const ELF: StylePools = {
  maleFirst: ["Aelric", "Caladrel", "Eltharion", "Faelor", "Ithilmar", "Loriel", "Maethor", "Naerdil", "Sylvar", "Thalion", "Vaelin", "Yavandir"],
  femaleFirst: ["Aeliana", "Cythera", "Elenwe", "Ilyriel", "Lariel", "Miriel", "Naestra", "Selathiel", "Sylvia", "Thalia", "Vaeri", "Ylsara"],
  lastA: ["Silver", "Moon", "Star", "Wind", "Dawn", "Leaf", "Sun", "Mist", "Swift", "Night"],
  lastB: ["leaf", "song", "rider", "whisper", "shade", "bloom", "weaver", "runner", "brook", "gleam"],
};

const ORC: StylePools = {
  maleFirst: ["Gorbad", "Zagrak", "Skarsnik", "Urgat", "Morglum", "Wazzok", "Grimgor", "Bograt", "Snagga", "Drukk", "Karg", "Thrugg"],
  femaleFirst: ["Gorla", "Zagga", "Urgha", "Mork", "Snikka", "Grotil", "Bogra", "Skab", "Ragash", "Drakka"],
  lastA: ["Skull", "Gob", "Bone", "Squig", "Iron", "Blood", "Rot", "Snot", "Fang", "Gut"],
  lastB: ["smasha", "basher", "chompa", "stompa", "biter", "cruncha", "ripper", "gnasha", "splitta", "mangla"],
};

const DWARF: StylePools = {
  maleFirst: ["Balin", "Dorin", "Grombrindal", "Hargin", "Kadrin", "Morgrim", "Okri", "Snorri", "Thorgrim", "Ungrim", "Burlok", "Grimm"],
  femaleFirst: ["Berta", "Dagna", "Elsbeth", "Gretna", "Helga", "Karin", "Morwen", "Sigrun", "Thora", "Valka"],
  lastA: ["Iron", "Gold", "Stone", "Grudge", "Hammer", "Anvil", "Ore", "Rune", "Forge", "Granite"],
  lastB: ["beard", "fist", "brow", "bearer", "hand", "breaker", "shield", "delver", "helm", "born"],
};

const SKAVEN: StylePools = {
  maleFirst: ["Skreek", "Queek", "Snikch", "Thanquol", "Vermik", "Kritch", "Skabrit", "Pitrik", "Sleekit", "Fangmaster", "Rikkit", "Squealer"],
  femaleFirst: ["Skreelan", "Vissith", "Kritcha", "Sleeka", "Pitrix", "Fangis", "Rikka", "Squeela"],
  lastA: ["Warp", "Plague", "Gnaw", "Rat", "Filth", "Sewer", "Blight", "Musk", "Tail", "Claw"],
  lastB: ["scurry", "snitch", "gnawer", "stalker", "skitter", "chewer", "creeper", "lurker", "sniffer", "scratcher"],
};

const AMAZON: StylePools = {
  maleFirst: ["Huitzitl", "Tlacotl", "Xolotl", "Cuahtli", "Itzcoatl", "Nopaltzin"],
  femaleFirst: ["Anqet", "Citlali", "Itzel", "Malinal", "Necahual", "Quiala", "Tlalli", "Xochitl", "Yaretzi", "Zyanya", "Coszcatl", "Papan"],
  lastA: ["Jaguar", "Piranha", "Serpent", "Sun", "River", "Jade", "Thorn", "Eagle", "Storm", "Moon"],
  lastB: ["claw", "dancer", "strike", "priestess", "runner", "warden", "blade", "chant", "leap", "hunter"],
};

const NORSE: StylePools = {
  maleFirst: ["Bjorn", "Erik", "Gunnar", "Haldor", "Ivar", "Knut", "Leif", "Ragnar", "Sigurd", "Torvald", "Ulf", "Vidar"],
  femaleFirst: ["Astrid", "Brynhild", "Freydis", "Gudrun", "Helga", "Ingrid", "Ragnhild", "Sigrid", "Thyra", "Ylva"],
  lastA: ["Wolf", "Bear", "Frost", "Sea", "Blood", "Thunder", "Raven", "Ice", "Axe", "Mead"],
  lastB: ["pelt", "claw", "born", "farer", "howler", "beard", "caller", "render", "drinker", "fury"],
};

const VAMPIRE: StylePools = {
  maleFirst: ["Abhorash", "Casimir", "Dragomir", "Konstantin", "Lazlo", "Mircea", "Nikolaus", "Radu", "Vasile", "Vlad"],
  femaleFirst: ["Carmilla", "Elisabeta", "Isabella", "Katarina", "Lucrezia", "Mircalla", "Nadja", "Serafina", "Violeta", "Yvette"],
  lastA: ["Von", "Night", "Grave", "Blood", "Shadow", "Bat", "Crypt", "Dusk", "Pale", "Moon"],
  lastB: ["Carstein", "shroud", "thirst", "veil", "wing", "mourn", "fang", "hollow", "whisper", "bane"],
};

const STYLES: Record<string, StylePools> = {
  default: HUMAN,
  human: HUMAN,
  elf: ELF,
  elven: ELF,
  darkelf: ELF,
  orc: ORC,
  ork: ORC,
  goblin: ORC,
  dwarf: DWARF,
  dwarven: DWARF,
  skaven: SKAVEN,
  amazon: AMAZON,
  norse: NORSE,
  vampire: VAMPIRE,
};

const pick = <T>(pool: readonly T[], random: () => number): T => pool[Math.floor(random() * pool.length) % pool.length]!;

export function generateName(generator: string, gender: string, random: () => number = Math.random): string {
  const style = STYLES[generator.trim().toLowerCase()] ?? HUMAN;
  const firstPool = gender === "female"
    ? style.femaleFirst
    : gender === "male"
      ? style.maleFirst
      : random() < 0.5 ? style.maleFirst : style.femaleFirst;
  const lastA = pick(style.lastA, random);
  // "Von Carstein"-style surnames keep their space; compound surnames join lowercase halves directly.
  const lastB = pick(style.lastB, random);
  const last = /^[A-Z]/.test(lastB) ? `${lastA} ${lastB}` : `${lastA}${lastB}`;
  return `${pick(firstPool, random)} ${last}`;
}
