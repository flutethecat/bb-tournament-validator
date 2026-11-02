/**
 * House rules of a league or tournament (creation wizards v2, owner grill 2026-11-02). Pure and dependency-free: the server
 * parses and stores them ON THE COMPETITION (never by changing the shared ruleset package), and the SPA's wizards, settings
 * forms and summaries read the same labels through a relative import.
 *
 * Every setting defaults to "as the ruleset says". Both kinds: Prayers to Nuffle (as ruleset / cost change / banned),
 * Brawling Brutes (as ruleset / on / off), max stat increases per team and per player (null = as ruleset). League only:
 * MVP (as ruleset / pick 3 / random) and hire/fire (as ruleset / enforced / not enforced). Tournament only: Progression
 * (off = resurrection, the default) with three carry-over tickboxes.
 *
 * Old records have no `houseRules`: houseRulesOf derives the defaults on read, so nothing needs a migration.
 */

export type CompetitionKind = "league" | "tournament";
export type PrayersMode = "ruleset" | "cost" | "banned";
export type TriState = "ruleset" | "on" | "off";
export type MvpMode = "ruleset" | "pick3" | "random";
export type HireFireMode = "ruleset" | "enforced" | "notEnforced";

export interface ProgressionRules {
  /** Off = resurrection (every round starts from the submitted roster). */
  enabled: boolean;
  /** What carries from round to round when progression is on. */
  spp: boolean;
  injuries: boolean;
  treasury: boolean;
}

export interface HouseRules {
  prayers: { mode: PrayersMode; /** Thousands of gold, mode "cost" only. */ costK?: number };
  brawlingBrutes: TriState;
  /** Most characteristic increases a team / a player may carry; null = as the ruleset says. */
  maxStatIncreasesTeam: number | null;
  maxStatIncreasesPlayer: number | null;
  /** League only. */
  mvp?: MvpMode;
  /** League only. */
  hireFire?: HireFireMode;
  /** Tournament only. */
  progression?: ProgressionRules;
}

export const PRAYERS_COST_MAX_K = 1000;
export const STAT_CAP_MAX_TEAM = 64;
export const STAT_CAP_MAX_PLAYER = 10;

export const PRAYERS_LABEL: Record<PrayersMode, string> = { ruleset: "As the ruleset says", cost: "Cost change", banned: "Banned" };
export const TRI_LABEL: Record<TriState, string> = { ruleset: "As the ruleset says", on: "On", off: "Off" };
export const MVP_LABEL: Record<MvpMode, string> = { ruleset: "As the ruleset says", pick3: "Pick 3", random: "Random" };
export const HIRE_FIRE_LABEL: Record<HireFireMode, string> = { ruleset: "As the ruleset says", enforced: "Enforced", notEnforced: "Not enforced" };
export const PROGRESSION_CARRY_LABEL: Record<"spp" | "injuries" | "treasury", string> = {
  spp: "SPP and advancements",
  injuries: "Lasting injuries and deaths",
  treasury: "Treasury and winnings",
};

export class HouseRulesError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = "HouseRulesError";
  }
}

export function defaultProgression(): ProgressionRules {
  return { enabled: false, spp: true, injuries: true, treasury: true };
}

export function defaultHouseRules(kind: CompetitionKind): HouseRules {
  const base: HouseRules = { prayers: { mode: "ruleset" }, brawlingBrutes: "ruleset", maxStatIncreasesTeam: null, maxStatIncreasesPlayer: null };
  return kind === "league" ? { ...base, mvp: "ruleset", hireFire: "ruleset" } : { ...base, progression: defaultProgression() };
}

const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

function cap(v: unknown, max: number, field: string, label: string): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > max) throw new HouseRulesError(`${label} must be a whole number from 0 to ${max}, or blank for the ruleset's.`, field);
  return n;
}

/**
 * A full house-rules object from a request body, merged over `prior` (fields left out keep their value). Fields for the
 * other kind are refused, so a league can't carry a progression setting and a tournament can't carry MVP.
 */
export function parseHouseRules(raw: unknown, kind: CompetitionKind, prior: HouseRules = defaultHouseRules(kind)): HouseRules {
  if (!isObj(raw)) throw new HouseRulesError("House rules must be an object.", "houseRules");
  // A JSON copy, so a reactive proxy (SPA forms) is accepted too.
  const out: HouseRules = JSON.parse(JSON.stringify(prior)) as HouseRules;
  if (kind === "league" && raw.progression !== undefined) throw new HouseRulesError("Progression is a tournament setting.", "houseRules.progression");
  if (kind === "tournament" && (raw.mvp !== undefined || raw.hireFire !== undefined)) throw new HouseRulesError("MVP and hire/fire are league settings.", "houseRules");
  if (raw.prayers !== undefined) {
    if (!isObj(raw.prayers) || !oneOf(raw.prayers.mode, ["ruleset", "cost", "banned"] as const))
      throw new HouseRulesError("Prayers to Nuffle must be as the ruleset says, a cost change or banned.", "houseRules.prayers");
    if (raw.prayers.mode === "cost") {
      const c = cap(raw.prayers.costK, PRAYERS_COST_MAX_K, "houseRules.prayers.costK", "The Prayers to Nuffle cost");
      if (c === null) throw new HouseRulesError("Enter the Prayers to Nuffle cost (thousands of gold).", "houseRules.prayers.costK");
      out.prayers = { mode: "cost", costK: c };
    } else out.prayers = { mode: raw.prayers.mode };
  }
  if (raw.brawlingBrutes !== undefined) {
    if (!oneOf(raw.brawlingBrutes, ["ruleset", "on", "off"] as const)) throw new HouseRulesError("Brawling Brutes must be as the ruleset says, on or off.", "houseRules.brawlingBrutes");
    out.brawlingBrutes = raw.brawlingBrutes;
  }
  if (raw.maxStatIncreasesTeam !== undefined) out.maxStatIncreasesTeam = cap(raw.maxStatIncreasesTeam, STAT_CAP_MAX_TEAM, "houseRules.maxStatIncreasesTeam", "Max stat increases per team");
  if (raw.maxStatIncreasesPlayer !== undefined) out.maxStatIncreasesPlayer = cap(raw.maxStatIncreasesPlayer, STAT_CAP_MAX_PLAYER, "houseRules.maxStatIncreasesPlayer", "Max stat increases per player");
  if (kind === "league") {
    if (raw.mvp !== undefined) {
      if (!oneOf(raw.mvp, ["ruleset", "pick3", "random"] as const)) throw new HouseRulesError("MVP must be as the ruleset says, pick 3 or random.", "houseRules.mvp");
      out.mvp = raw.mvp;
    }
    if (raw.hireFire !== undefined) {
      if (!oneOf(raw.hireFire, ["ruleset", "enforced", "notEnforced"] as const)) throw new HouseRulesError("Hire/fire must be as the ruleset says, enforced or not enforced.", "houseRules.hireFire");
      out.hireFire = raw.hireFire;
    }
  } else if (raw.progression !== undefined) {
    const p = raw.progression;
    if (!isObj(p)) throw new HouseRulesError("Progression must be an object.", "houseRules.progression");
    const next = { ...(out.progression ?? defaultProgression()) };
    for (const k of ["enabled", "spp", "injuries", "treasury"] as const) {
      if (p[k] === undefined) continue;
      if (typeof p[k] !== "boolean") throw new HouseRulesError(`progression.${k} must be true or false.`, `houseRules.progression.${k}`);
      next[k] = p[k] as boolean;
    }
    out.progression = next;
  }
  return out;
}

/** The stored house rules, or the defaults (records written before house rules existed). Bad stored values fall back. */
export function houseRulesOf(record: { houseRules?: unknown }, kind: CompetitionKind): HouseRules {
  if (!isObj(record.houseRules)) return defaultHouseRules(kind);
  try { return parseHouseRules(record.houseRules, kind); } catch { return defaultHouseRules(kind); }
}

/** True when nothing differs from the ruleset. */
export function houseRulesAreDefault(rules: HouseRules, kind: CompetitionKind): boolean {
  return JSON.stringify(rules) === JSON.stringify(defaultHouseRules(kind));
}

/** Key/value rows for a summary (Review step, overview info panel): every setting, in form order. */
export function houseRulesRows(rules: HouseRules, kind: CompetitionKind): Array<{ k: string; v: string }> {
  const asRuleset = "As the ruleset says";
  const capText = (n: number | null) => (n === null ? asRuleset : String(n));
  const rows = [
    { k: "Prayers to Nuffle", v: rules.prayers.mode === "cost" ? `Costs ${rules.prayers.costK ?? 0}k` : PRAYERS_LABEL[rules.prayers.mode] },
    { k: "Brawling Brutes", v: TRI_LABEL[rules.brawlingBrutes] },
    { k: "Stat increases per team", v: capText(rules.maxStatIncreasesTeam) },
    { k: "Stat increases per player", v: capText(rules.maxStatIncreasesPlayer) },
  ];
  if (kind === "league") {
    rows.push({ k: "MVP", v: MVP_LABEL[rules.mvp ?? "ruleset"] }, { k: "Hire/fire", v: HIRE_FIRE_LABEL[rules.hireFire ?? "ruleset"] });
  } else {
    const p = rules.progression ?? defaultProgression();
    const carry = (["spp", "injuries", "treasury"] as const).filter((k) => p[k]).map((k) => PROGRESSION_CARRY_LABEL[k]);
    rows.push({ k: "Progression", v: p.enabled ? `On: ${carry.length ? carry.join(", ") : "nothing carries"}` : "Off (resurrection)" });
  }
  return rows;
}

/** Only the rows that differ from the ruleset (the overview info panel keeps to what matters). */
export function changedHouseRulesRows(rules: HouseRules, kind: CompetitionKind): Array<{ k: string; v: string }> {
  const base = houseRulesRows(defaultHouseRules(kind), kind);
  return houseRulesRows(rules, kind).filter((row, i) => row.v !== base[i]?.v);
}

/**
 * The house-rule settings the Roster Builder validator enforces (src/competition/packageOverlay.ts), as a stable key:
 * "" when none is set. A roster check carries it; when it changes, checks made under the old value are stale.
 */
export function houseRulesStamp(rules: HouseRules | undefined): string {
  if (!rules) return "";
  const banned = rules.prayers.mode === "banned";
  if (!banned && rules.maxStatIncreasesTeam === null && rules.maxStatIncreasesPlayer === null) return "";
  return JSON.stringify({ ptnBanned: banned, statTeam: rules.maxStatIncreasesTeam, statPlayer: rules.maxStatIncreasesPlayer });
}
