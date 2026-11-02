// The team sheet's TOURNAMENT RULESET box (owner 10-30): one pure mapping from the builder's ruleset state to [label, value]
// rows. The sheet model carries them as `ruleset` (sheetModel below; builder.ts's own sheetModel() adds the same rows), and
// public/sheet-pdf.js rulesetRows(model) prints them in the PDF and in the on-screen sheet (TournamentBuilderPrintSheet.vue),
// so the two can never disagree. Only rows the package defines; empty ones are left out.
import { core, type RaceRules, type SheetModel, type SkillPack, type TierRules } from "./builderCore";
import { FREE_CREATE_LABEL, isFreeCreatePackage } from "../../../src/freeCreate";

export type SheetRulesetRow = [string, string];
export interface SheetRulesetInput {
  packageName: string;
  tierLabel: string;
  raceRules: RaceRules | null;
  pack: SkillPack | null;
  tierRules: TierRules | null;
  /** The league / special rule the coach chose ("" none). */
  league: string;
  /** Fallback gold cap (the package budget) when the race block names none. */
  budget?: number | null;
  /** Free Create's "Ignore in-game limits" (only read for Free Create). */
  ignoreLimits?: boolean;
  /** Blood Bowl Sevens (Roster Builder lane): the package's display name (Sevens Free Create's marker reads as its label)
   *  and the format rows read from the package limits. Absent for standard rulesets. */
  sevens?: SheetSevens | null;
}
export interface SheetSevens { label: string; minPlayers: number; maxPlayers: number; maxNonLineman: number | null; veteran: boolean }
/** The sheet model plus the ruleset rows: the one object both the on-screen sheet and the PDF consume. */
export type PrintSheetModel = SheetModel & { ruleset?: SheetRulesetRow[] };

/** The server's skill-system block on the race rules (src/teamBuilderPackage.ts RaceSkillSystem): which branch validation
 *  takes for this race's added skills, with the resolved counts. */
export interface SheetSkillSystem {
  mode: "packs" | "count" | "points";
  maxPrimary: number | null;
  maxSecondary: number | null;
  secondarySwap: boolean;
  secondarySwapRatio: number;
  secondarySwapMax: number | null;
  matrixCell?: string;
}
type RaceWithSystem = RaceRules & { skillSystem?: SheetSkillSystem };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const minOf = (...values: Array<number | null | undefined>): number | null => {
  const nums = values.filter(isNum);
  return nums.length ? Math.min(...nums) : null;
};

/** Copies a wire skill-system block field by field (builder.ts sanitizePackageRules spreads the result into the race). */
export function sanitizeSkillSystem(raw: unknown): { skillSystem?: SheetSkillSystem } {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const mode = r.mode === "packs" || r.mode === "count" || r.mode === "points" ? r.mode : null;
  if (!mode) return {};
  const n = (v: unknown): number | null => (isNum(v) ? v : null);
  return {
    skillSystem: {
      mode, maxPrimary: n(r.maxPrimary), maxSecondary: n(r.maxSecondary), secondarySwap: r.secondarySwap === true,
      secondarySwapRatio: n(r.secondarySwapRatio) ?? 2, secondarySwapMax: n(r.secondarySwapMax),
      ...(typeof r.matrixCell === "string" && r.matrixCell ? { matrixCell: r.matrixCell } : {}),
    },
  };
}

/**
 * The rows follow the tournament's skill system exactly as validation applies it (the skill-points rule's branch order):
 *  - choose-one packs: the selected pack's allowance (or the packs on offer); never an SP budget of its own;
 *  - count mode (tiers, team rules, a matrix cell): Primary skills / Secondary skills (+ swap, + the matrix cell);
 *  - skill points: SP budget and the SP prices.
 * A selected pack's restrictions win over the tier limits (a primary-only pack never shows "Secondary skills: max 2").
 */
export function sheetRulesetRows(input: SheetRulesetInput): SheetRulesetRow[] {
  // Free Create (owner 10-31): one row, plus a second when the coach ignored the in-game limits.
  if (isFreeCreatePackage(input.packageName)) {
    return [["Ruleset", `${FREE_CREATE_LABEL} — no tournament rules`], ...(input.ignoreLimits ? [["Limits", "Ignore in-game limits"] as SheetRulesetRow] : [])];
  }
  const race = input.raceRules as RaceWithSystem | null;
  const pack = input.pack;
  const tier = input.tierRules;
  const system = race?.skillSystem ?? null;
  const mode = system?.mode ?? (race?.packs.length ? "packs" : "points");
  // A trailing parenthetical note on the tier label ("Gold Budget 1,160,000 (SPP, stacking … per team)") stays off the box.
  const sevens = input.sevens ?? null;
  // Sevens: the sheet's title line already says "Blood Bowl Sevens", so the box starts with the package as usual.
  const rows: SheetRulesetRow[] = [["Package", sevens?.label || input.packageName], ["Tier", input.tierLabel.replace(/\s*\([^()]*\)\s*$/, "")]];
  const cap = pack?.gold ?? race?.gold ?? input.budget ?? null;
  if (isNum(cap)) rows.push(["TV cap", core.gold(cap)]);
  if (sevens) {
    rows.push(["Players", `${sevens.minPlayers}–${sevens.maxPlayers}${isNum(sevens.maxNonLineman) ? `, max ${sevens.maxNonLineman} non-Linemen` : ""}`]);
    if (sevens.veteran) rows.push(["Veteran", "1 Lineman, MA −1"]);
  }

  // The team-wide secondary allowance in force: the count allotment, else the selected pack and the tier limit.
  let secondary: number | null;
  if (mode === "count" && system) {
    secondary = system.secondarySwap ? null : system.maxSecondary;
    if (system.matrixCell) rows.push(["Matrix cell", system.matrixCell]);
    rows.push(["Primary skills", isNum(system.maxPrimary) ? String(system.maxPrimary) : "any"]);
    rows.push(["Secondary skills", isNum(system.maxSecondary) ? (system.maxSecondary === 0 ? "none" : String(system.maxSecondary)) : "any"]);
    if (system.secondarySwap) {
      rows.push(["Secondary swap", `${system.secondarySwapRatio} primary → 1 secondary${isNum(system.secondarySwapMax) ? ` (max ${system.secondarySwapMax})` : ""}`]);
    }
  } else if (mode === "packs") {
    secondary = minOf(pack?.maxSecondary, tier?.maxSecondary);
    if (pack) rows.push(["Skill pack", `${pack.label}: ${core.packSkillText(pack)}`]);
    else if (race?.packs.length) rows.push(["Skill packs", `choose one: ${race.packs.map((p) => p.label).join(" · ")}`]);
    if (isNum(secondary)) rows.push(["Secondary skills", secondary === 0 ? "none" : `max ${secondary}`]);
  } else {
    secondary = tier?.maxSecondary ?? null;
    if (race && race.skillPointBudget > 0) {
      rows.push(["SP budget", `${race.skillPointBudget} SP`]);
      const c = race.skillCosts;
      if (c) rows.push(["SP prices", [`primary ${c.primary}`, `secondary ${c.secondary}`, c.eliteSurcharge ? `elite +${c.eliteSurcharge}` : "", c.stackSurcharge ? `stacking +${c.stackSurcharge}` : ""].filter(Boolean).join(" · ")]);
    } else if (race || sevens) rows.push(["Added skills", "None"]);
    if (isNum(secondary)) rows.push(["Secondary skills", secondary === 0 ? "none" : `max ${secondary}`]);
  }

  const perPlayer = pack?.maxPerPlayer ?? race?.maxPerPlayer ?? null;
  if (isNum(perPlayer)) rows.push(["Skills per player", `max ${perPlayer}`]);
  // Tier limits in the builder's own wording; secondary and stacking are composed here so they honour the pack.
  const lines = core.tierLimitLines(tier);
  const line = (prefix: string): void => {
    const hit = lines.find((l) => l.startsWith(`${prefix}: `));
    if (hit) rows.push([prefix, hit.slice(prefix.length + 2)]);
  };
  line("Elite skills");
  if (tier && isNum(tier.maxStackedPlayers)) {
    const sp = tier.stackedPlayer;
    const stackSecondary = secondary === 0 ? 0 : sp?.maxSecondary ?? null;
    const parts = [
      isNum(sp?.maxSkills) ? `max ${plural(sp!.maxSkills!, "skill")}` : "",
      stackSecondary === 0 ? "primary only" : isNum(stackSecondary) ? `max ${stackSecondary} secondary` : "",
      sp?.maxElite === 0 ? "no elite" : isNum(sp?.maxElite) ? `max ${sp!.maxElite} elite` : "",
    ].filter(Boolean);
    rows.push(["Stacked players", `max ${tier.maxStackedPlayers}${parts.length ? ` (${parts.join(" · ")})` : ""}`]);
  }
  line("Characteristics");
  line("Star packs");
  const maxStars = tier?.maxStars ?? race?.stars?.maxCount ?? null;
  if (sevens || (race?.stars && !race.stars.allowed)) rows.push(["Star players", "None"]);
  else if (pack?.starPlayersAllowed === false) rows.push(["Star players", "None with this pack"]);
  else if (maxStars === 0) rows.push(["Star players", "None"]);
  else if (race?.stars || isNum(maxStars)) {
    rows.push(["Star players", [isNum(maxStars) ? `max ${maxStars}` : "Allowed", race?.stars?.paidInSkillPoints ? "paid in SP" : ""].filter(Boolean).join(", ")]);
  }
  if (input.league) rows.push(["League / special rule", input.league]);
  return rows.filter(([, v]) => String(v ?? "").trim() !== "");
}

/** The builder's public API, as far as the sheet reads it (createTournamentBuilder's return). */
export interface SheetBuilderLike {
  state: { packageName: string; packageRules: { budget: number | null } | null; ignoreLimits?: boolean };
  sheetModel(): SheetModel & { ruleset?: SheetRulesetRow[] };
  raceRules(): RaceRules | null;
  packSummary(): SkillPack | null;
  tierRules(): TierRules | null;
  tierLabel(): string;
  activeLeague(): string;
}
export function builderRulesetInput(b: SheetBuilderLike): SheetRulesetInput {
  return {
    packageName: b.state.packageName, tierLabel: b.tierLabel(), raceRules: b.raceRules(), pack: b.packSummary(),
    tierRules: b.tierRules(), league: b.activeLeague(), budget: b.state.packageRules?.budget ?? null, ignoreLimits: b.state.ignoreLimits === true,
  };
}
/** The sheet model: the builder's own (the PDF's) model, with the ruleset rows (kept when the builder already adds them). */
export function sheetModel(b: SheetBuilderLike): PrintSheetModel {
  const model = b.sheetModel();
  return Array.isArray(model.ruleset) ? model : { ...model, ruleset: sheetRulesetRows(builderRulesetInput(b)) };
}
