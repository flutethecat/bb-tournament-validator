/**
 * League inducement table: the shared, dataset-free part (limits, categories, the icon set and the read-model types),
 * imported by the server (inducements.ts) and the SPA (spa/src/leagues/inducements.ts) so both judge a draft alike.
 * The server is the authority; the SPA uses these to explain a problem before Save.
 *
 * Icons: our own icon set only (public/icons; asset-provenance law). The standard inducements use the inducement icons
 * the Team Builder already ships (public/icons/inducements/manifest.json); custom types pick any key of this table.
 */

export const INDUCEMENT_CATEGORIES = ["staff", "star", "special", "mercenary"] as const;
export type InducementCategory = (typeof INDUCEMENT_CATEGORIES)[number];
export const INDUCEMENT_CATEGORY_LABEL: Readonly<Record<InducementCategory, string>> = {
  staff: "Staff", star: "Star", special: "Special", mercenary: "Mercenary",
};
export const isInducementCategory = (v: unknown): v is InducementCategory => typeof v === "string" && (INDUCEMENT_CATEGORIES as readonly string[]).includes(v);

/** Caps run 0..INDUCEMENT_CAP_MAX (0 = not offered). */
export const INDUCEMENT_CAP_MAX = 16;
/** Prices are whole 5,000-gold steps (the smallest step in the BB2025 list: Temp Agency Cheerleaders), up to 2,000,000. */
export const INDUCEMENT_PRICE_STEP = 5_000;
export const INDUCEMENT_PRICE_MAX = 2_000_000;
export const INDUCEMENT_NAME_MAX = 40;
export const INDUCEMENT_EFFECT_MAX = 300;
export const CUSTOM_INDUCEMENTS_MAX = 30;
/** Server-made custom ids: never a standard (dataset, snake_case) id. */
export const CUSTOM_INDUCEMENT_ID = /^c-[0-9a-f]{8}$/;

export const INDUCEMENT_ICONS: Readonly<Record<string, { label: string; src: string }>> = {
  "assistant-coaches": { label: "Assistant coaches", src: "/icons/inducements/part_time_assistant_coaches.png" },
  cheerleaders: { label: "Cheerleaders", src: "/icons/inducements/temp_agency_cheerleaders.png" },
  keg: { label: "Keg", src: "/icons/inducements/bloodweiser_keg.png" },
  bribe: { label: "Bribe", src: "/icons/inducements/bribe.png" },
  apothecary: { label: "Apothecary", src: "/icons/inducements/wandering_apothecary.png" },
  mortuary: { label: "Mortuary assistant", src: "/icons/inducements/mortuary_assistant.png" },
  "plague-doctor": { label: "Plague doctor", src: "/icons/inducements/plague_doctor.png" },
  rookies: { label: "Rookies", src: "/icons/inducements/riotous_rookies.png" },
  chef: { label: "Chef", src: "/icons/inducements/master_chef.png" },
  training: { label: "Training", src: "/icons/inducements/extra_team_training.png" },
  "weather-mage": { label: "Weather mage", src: "/icons/inducements/weather_mage.png" },
  wizard: { label: "Wizard", src: "/icons/inducements/wizard.png" },
  referee: { label: "Referee", src: "/icons/inducements/biased_ref.png" },
  mascot: { label: "Mascot", src: "/icons/inducements/team_mascot.png" },
  prayer: { label: "Prayer", src: "/icons/inducements/prayer.png" },
  pastries: { label: "Pastries", src: "/icons/inducements/bretonnian_pastries.png" },
  damsel: { label: "Damsel", src: "/icons/inducements/bretonnian_damsel.png" },
  jar: { label: "Jar", src: "/icons/inducements/canopic_jar.png" },
  "coaching-staff": { label: "Coaching staff", src: "/icons/inducements/infamous_coaching_staff.png" },
  star: { label: "Star", src: "/icons/coach-badges/star-retro.png" },
  legend: { label: "Legend", src: "/icons/coach-badges/legend-retro.png" },
  veteran: { label: "Veteran", src: "/icons/coach-badges/veteran-retro.png" },
  helmet: { label: "Helmet", src: "/icons/ui/football-helmet.png" },
  fans: { label: "Fans", src: "/icons/ui/dedicated_fans.png" },
  reroll: { label: "Reroll", src: "/icons/ui/re_roll.png" },
  foul: { label: "Foul", src: "/icons/ui/action-foul.png" },
  block: { label: "Block", src: "/icons/skills/block.png" },
  dodge: { label: "Dodge", src: "/icons/skills/dodge.png" },
};
export const isInducementIcon = (v: unknown): v is string => typeof v === "string" && Object.prototype.hasOwnProperty.call(INDUCEMENT_ICONS, v);

/** The icon key of each standard (dataset) inducement; star players and mercenaries have no inducement icon of their own. */
export const STANDARD_INDUCEMENT_ICON: Readonly<Record<string, string>> = {
  part_time_assistant_coaches: "assistant-coaches",
  temp_agency_cheerleaders: "cheerleaders",
  bloodweiser_kegs: "keg",
  bribes: "bribe",
  wandering_apothecaries: "apothecary",
  mortuary_assistant: "mortuary",
  plague_doctor: "plague-doctor",
  riotous_rookies: "rookies",
  halfling_master_chef: "chef",
  extra_team_training: "training",
  weather_mage: "weather-mage",
  hireling_sports_wizard: "wizard",
  biased_referee: "referee",
  team_mascot: "mascot",
  prayers_to_nuffle: "prayer",
  bretonnian_pastries: "pastries",
  bretonnian_damsel: "damsel",
  canopic_jar: "jar",
  infamous_coaching_staff: "coaching-staff",
  star_players: "star",
  mercenaries: "helmet",
};

/** The category each standard inducement is listed under (display grouping only). */
export const STANDARD_INDUCEMENT_CATEGORY: Readonly<Record<string, InducementCategory>> = {
  part_time_assistant_coaches: "staff",
  temp_agency_cheerleaders: "staff",
  wandering_apothecaries: "staff",
  mortuary_assistant: "staff",
  plague_doctor: "staff",
  halfling_master_chef: "staff",
  weather_mage: "staff",
  hireling_sports_wizard: "staff",
  biased_referee: "staff",
  infamous_coaching_staff: "staff",
  team_mascot: "staff",
  star_players: "star",
  mercenaries: "mercenary",
  riotous_rookies: "mercenary",
};

// ---- stored shape -----------------------------------------------------------------------------------------------

/** An organiser's change to one standard inducement; a field left out keeps the dataset value. */
export interface InducementOverride { enabled?: boolean; cap?: number; price?: number }

export interface CustomInducement {
  id: string;
  name: string;
  price: number;
  cap: number;
  /** Key of INDUCEMENT_ICONS. */
  icon: string;
  effectText: string;
  category: InducementCategory;
}

/** season.rules.inducements: overrides by standard id, the custom types, and its own revision (every save bumps it). */
export interface SeasonInducements {
  standard: Record<string, InducementOverride>;
  custom: CustomInducement[];
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
}

// ---- read model -------------------------------------------------------------------------------------------------

export interface EffectiveInducement {
  id: string;
  name: string;
  source: "standard" | "custom";
  category: InducementCategory;
  /** Icon key (INDUCEMENT_ICONS) and its path. */
  icon: string;
  iconSrc: string;
  enabled: boolean;
  cap: number;
  /** null = no single price (star players are hired at each star's own cost). */
  price: number | null;
  /** Custom types: the organiser's effect text. Standard: the dataset's restriction / pricing note, when it has one. */
  effectText: string;
  /** Standard rows: the dataset values, so the editor can show and reset changes. */
  default?: { enabled: boolean; cap: number; price: number | null };
  /** Standard rows the price of which cannot be changed here (no single price). */
  priceFixed?: boolean;
}

export interface InducementTableView {
  leagueId: string;
  seasonId: string;
  seasonName: string;
  ruleset: string;
  revision: number;
  updatedAt?: string;
  updatedBy?: string;
  table: EffectiveInducement[];
  /** True for organisers of the league and site admins (the page shows the editor link). */
  canEdit: boolean;
}

/** GET .../inducements/usage (inducementUsage.ts): one inducement's use across the counted games. */
export interface InducementUsageRow {
  /** Standard dataset id, `star:<folded name>` (a star hire) or `custom:<folded name>` (the league's own types add up by
   *  name across seasons). */
  key: string;
  name: string;
  source: "standard" | "custom" | "star";
  category: InducementCategory;
  iconSrc: string;
  /** Total quantity taken (both teams, every counted game). */
  taken: number;
  /** Games in which at least one team took it. */
  games: number;
  /** games / gamesCounted, 0..1 (rounded to 4 places). */
  share: number;
}

export type InducementUsageScope = "season" | "league";

export interface InducementUsageView {
  leagueId: string;
  seasonId: string;
  scope: InducementUsageScope;
  /** Played games with inducement data (the share's denominator). */
  gamesCounted: number;
  /** Played games without inducement data (imports, Super FUMBBL games, organiser-entered results). */
  gamesWithoutData: number;
  /** Most taken first, then most games, then name. */
  rows: InducementUsageRow[];
  /** The viewer may edit the season's price table (the panel's editor link). */
  canEdit: boolean;
}

// ---- validation helpers (shared) --------------------------------------------------------------------------------

/** "" when the cap is a whole number 0..INDUCEMENT_CAP_MAX. */
export function capProblem(v: unknown, label: string): string {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INDUCEMENT_CAP_MAX ? "" : `${label}: the cap must be a whole number from 0 to ${INDUCEMENT_CAP_MAX}.`;
}

/** "" when the price is a whole 5,000-gold step from 0 to 2,000,000. */
export function priceProblem(v: unknown, label: string): string {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= INDUCEMENT_PRICE_MAX && v % INDUCEMENT_PRICE_STEP === 0
    ? "" : `${label}: the price must be 0 to 2,000,000 gold in steps of 5,000.`;
}

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp(`[\x00-\x08\x0b-\x1f\x7f-\x9f${String.fromCharCode(0x2028, 0x2029)}]`);

/** Plain text, trimmed and NFC-normalised; undefined when it is not a string or holds control characters (newlines only where allowed). */
export function plainText(v: unknown, allowNewlines: boolean): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  if (CONTROL.test(s) || (!allowNewlines && s.includes("\n"))) return undefined;
  return s;
}

/** "" when the custom type is valid (ids are the server's business). */
export function customProblem(c: { name?: unknown; price?: unknown; cap?: unknown; icon?: unknown; effectText?: unknown; category?: unknown }): string {
  const name = plainText(c.name, false);
  if (name === undefined || !name) return "Give the inducement a name (plain text).";
  if ([...name].length > INDUCEMENT_NAME_MAX) return `Name: at most ${INDUCEMENT_NAME_MAX} characters.`;
  const p = priceProblem(c.price, name) || capProblem(c.cap, name);
  if (p) return p;
  if (!isInducementIcon(c.icon)) return `${name}: pick an icon.`;
  if (!isInducementCategory(c.category)) return `${name}: pick a category.`;
  const effect = plainText(c.effectText ?? "", true);
  if (effect === undefined) return `${name}: the effect must be plain text.`;
  if ([...effect].length > INDUCEMENT_EFFECT_MAX) return `${name}: the effect text can be at most ${INDUCEMENT_EFFECT_MAX} characters.`;
  return "";
}

/** "75k", "1.2M": the short price the tables show; "-" for no single price. */
export function shortGold(price: number | null): string {
  if (price === null) return "-";
  if (price >= 1_000_000) return `${+(price / 1_000_000).toFixed(2)}M`;
  return `${Math.round(price / 1000)}k`;
}
