// The team sheet's TOURNAMENT RULESET box (owner 10-30): one pure mapping from the builder's ruleset state to [label, value]
// rows. The sheet model carries them as `ruleset` (sheetModel below; builder.ts's own sheetModel() adds the same rows), and
// public/sheet-pdf.js rulesetRows(model) prints them in the PDF and in the on-screen sheet (TournamentBuilderPrintSheet.vue),
// so the two can never disagree. Only rows the package defines; empty ones are left out.
import { core, type RaceRules, type SheetModel, type SkillPack, type TierRules } from "./builderCore";

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
}
/** The sheet model plus the ruleset rows: the one object both the on-screen sheet and the PDF consume. */
export type PrintSheetModel = SheetModel & { ruleset?: SheetRulesetRow[] };

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

export function sheetRulesetRows(input: SheetRulesetInput): SheetRulesetRow[] {
  const race = input.raceRules;
  const pack = input.pack;
  const tier = input.tierRules;
  // A trailing parenthetical note on the tier label ("Gold Budget 1,160,000 (SPP, stacking … per team)") stays off the box.
  const rows: SheetRulesetRow[] = [["Package", input.packageName], ["Tier", input.tierLabel.replace(/\s*\([^()]*\)\s*$/, "")]];
  const cap = pack?.gold ?? race?.gold ?? input.budget ?? null;
  if (isNum(cap)) rows.push(["TV cap", core.gold(cap)]);
  if (pack) rows.push(["Skill pack", `${pack.label}: ${core.packSkillText(pack)}`]);
  else if (race && race.skillPointBudget > 0) rows.push(["SP budget", `${race.skillPointBudget} SP`]);
  const perPlayer = pack?.maxPerPlayer ?? race?.maxPerPlayer ?? null;
  if (isNum(perPlayer)) rows.push(["Skills per player", `max ${perPlayer}`]);
  // Tier limits (secondary, elite, stacking, characteristics, star packs) in the builder's own wording.
  for (const line of core.tierLimitLines(tier)) {
    const at = line.indexOf(": ");
    if (at < 0 || line.startsWith("Star players:")) continue; // the star allowance gets its own row below
    rows.push([line.slice(0, at), line.slice(at + 2)]);
  }
  const maxStars = tier?.maxStars ?? race?.stars?.maxCount ?? null;
  if (race?.stars && !race.stars.allowed) rows.push(["Star players", "None"]);
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
  state: { packageName: string; packageRules: { budget: number | null } | null };
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
    tierRules: b.tierRules(), league: b.activeLeague(), budget: b.state.packageRules?.budget ?? null,
  };
}
/** The sheet model: the builder's own (the PDF's) model, with the ruleset rows (kept when the builder already adds them). */
export function sheetModel(b: SheetBuilderLike): PrintSheetModel {
  const model = b.sheetModel();
  return Array.isArray(model.ruleset) ? model : { ...model, ruleset: sheetRulesetRows(builderRulesetInput(b)) };
}
