/**
 * Advancement by roll on the league team page (spec-forfeit-and-dice-2026-11-02, Q7): Random Primary skill and
 * "Advance Characteristic", rolled on the server with the site roller and the BB2025 tables (src/advancementRolls.ts),
 * written to the team's dice log (src/dice/log.ts, `tm-` log) BEFORE anyone is shown the result, and recorded in the team
 * history. The same pending-roll idea as the fork's team advancement (src/teamAdvancement.ts): the SPP is spent when the
 * roll is made, the roll and its choices are stored on the player (LeaguePlayer.pendingAdvance) and come back unchanged
 * until the coach picks one. Reopening the panel never rolls again; a second roll for the same player is refused.
 *
 * Ops (POST .../teams/:teamId/edit, alone in their request; teamPage.ts runs them):
 *   { op: "rollAdvance", playerId, kind: "randomPrimary", category }   two results on the category table (a double is taken at once)
 *   { op: "rollAdvance", playerId, kind: "characteristic" }            a D8 on the characteristic table
 *   { op: "resolveAdvance", playerId, rollId, choice: { type: "skill", skill, access? } | { type: "stat", stat } }
 *
 * Who: the team's coach (coach mode, in season) or the league's organisers (edit mode, "on the coach's behalf": the
 * dice log marks the roll admin and the history says so). The price is the player's next advancement on the BB2025 table
 * (teamOps.ts advancementCount + advanceCostOf); the SPP is checked before the dice are rolled.
 */
import type { DatasetPosition } from "@bb/validator";
import { CHARACTERISTIC_STATS, CHARACTERISTIC_TABLE, rollCharacteristic, rollRandomSkill, skillTable, type CharacteristicStat } from "../advancementRolls.js";
import { CHARACTERISTIC_VALUE } from "../characteristicValue.js";
import type { DiceRoll } from "../dice/log.js";
import { newRollId } from "../dice/log.js";
import type { Roller } from "../dice/roller.js";
import { advanceCostOf, advancementCount, canImprove, positionOf, rankAfter, skillChoices, skillValue } from "./teamOps.js";
import type { LeaguePlayer, LeagueTeam, PendingAdvance, TeamHistoryEntry } from "./types.js";
import type { DatasetRoster } from "@bb/validator";

type Change = TeamHistoryEntry["changes"][number];

export class AdvanceError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export interface AdvanceCtx {
  team: LeagueTeam;
  roster: DatasetRoster | undefined;
  mode: "coach" | "organiser";
  actor: string;
  at: string;
  roller: Roller;
  /** The team's dice log id (teamLogId). */
  logId: string;
  /** Writes one roll to the dice log; throws when it can't (then nothing is stored or shown). */
  logRoll: (roll: DiceRoll) => void;
}

const who = (p: LeaguePlayer): string => `${p.name || p.position}${p.number !== null ? ` (#${p.number})` : ""}`;
const STAT_FIELD: Record<CharacteristicStat, "ma" | "st" | "ag" | "pa" | "av"> = { MA: "ma", ST: "st", AG: "ag", PA: "pa", AV: "av" };
const isStat = (v: unknown): v is CharacteristicStat => typeof v === "string" && (CHARACTERISTIC_STATS as readonly string[]).includes(v);

/** The Primary categories a random roll may use for this player: printed on the position, with a legal skill left. */
export function randomCategories(p: Pick<LeaguePlayer, "skills">, pos: DatasetPosition | undefined): string[] {
  if (!pos) return [];
  const legal = new Set(skillChoices(p, pos).primary);
  return pos.primaryCategories.filter((c) => skillTable(c).some((s) => legal.has(s)));
}

/** The characteristics this D8 result lets the player improve now. */
export function statChoices(p: LeaguePlayer, pos: DatasetPosition | undefined, roll: number): CharacteristicStat[] {
  return (CHARACTERISTIC_TABLE[roll] ?? []).filter((s) => canImprove(p, pos, s));
}

function playerOf(team: LeagueTeam, id: unknown): LeaguePlayer {
  const p = typeof id === "string" ? team.players.find((x) => x.playerId === id) : undefined;
  if (!p) throw new AdvanceError(400, "That player is not on this team's roster.");
  return p;
}

const rollLine = (r: { dice: [number, number]; skill: string; rerolled?: true }): string => `${r.dice[0]}+${r.dice[1]} ${r.skill || "-"}${r.rerolled ? " (rolled again)" : ""}`;
const behalf = (ctx: AdvanceCtx): string => (ctx.mode === "organiser" ? " (an organiser rolled on the coach's behalf)" : "");

/** Applies a chosen skill (value and rank; the SPP was spent at the roll). */
function takeSkill(p: LeaguePlayer, skill: string, access: "primary" | "secondary", count: number): void {
  p.skills = [...p.skills, skill];
  if (typeof p.value === "number") p.value += skillValue(skill, access === "secondary" ? "chosenSecondary" : "chosenPrimary");
  p.level = rankAfter(count + 1);
}

/** { op: "rollAdvance" }: rolls, logs, stores the pending choice (or takes a forced double). Returns the history lines. */
export function rollAdvance(ctx: AdvanceCtx, raw: Record<string, unknown>): Change[] {
  const p = playerOf(ctx.team, raw.playerId);
  if (raw.kind !== "randomPrimary" && raw.kind !== "characteristic") throw new AdvanceError(400, 'kind must be "randomPrimary" or "characteristic".');
  if (p.pendingAdvance) throw new AdvanceError(409, `${who(p)} already has a roll waiting for a choice. Pick from it first.`);
  const pos = positionOf(ctx.roster, p.position);
  if (!pos) throw new AdvanceError(400, `${p.position} is not a ${ctx.team.race} position: it can't take advancements here.`);
  const count = advancementCount(p, pos);
  const cost = advanceCostOf(count, raw.kind);
  if (cost === null) throw new AdvanceError(400, "This player has taken every advancement.");
  const choices = skillChoices(p, pos);
  const label = raw.kind === "randomPrimary" ? "a Random Primary skill" : "a Characteristic Improvement";
  // Everything is checked BEFORE the dice: a refused roll is never rolled, logged or charged.
  let category = "";
  if (raw.kind === "randomPrimary") {
    category = typeof raw.category === "string" ? raw.category : "";
    if (!pos.primaryCategories.includes(category as never)) throw new AdvanceError(400, `${category || "That"} is not a Primary category for ${who(p)}.`);
    if (!randomCategories(p, pos).includes(category)) throw new AdvanceError(400, `${who(p)} has no ${category} skill left to roll for.`);
  } else {
    const anySkill = choices.primary.length + choices.secondary.length > 0;
    const everyRoll = Object.keys(CHARACTERISTIC_TABLE).every((r) => statChoices(p, pos, Number(r)).length > 0);
    if (!anySkill && !everyRoll) throw new AdvanceError(400, `No characteristic roll is safe for ${who(p)}: some results would leave nothing to take.`);
  }
  if (p.availableSpp < cost) throw new AdvanceError(400, `${label} costs ${cost} SPP; ${who(p)} has ${p.availableSpp}.`);

  const id = newRollId();
  const admin = ctx.mode === "organiser";
  const base = { id, logId: ctx.logId, at: ctx.at, by: ctx.actor, ...(admin ? { admin: true } : {}) };
  if (raw.kind === "randomPrimary") {
    const primary = new Set(choices.primary);
    const r = rollRandomSkill(ctx.roller, category, (s) => primary.has(s));
    ctx.logRoll({
      ...base, kind: "advance-skill", purpose: `Random Primary skill (${category}) for ${who(p)}`, dice: r.rolls.flatMap((x) => x.dice),
      result: { team: ctx.team.name, playerId: p.playerId, player: who(p), category, rolls: r.rolls, picks: r.picks, forced: r.forced, cost },
    });
    p.availableSpp -= cost;
    const lines: Change[] = [{ what: `${who(p)} rolled a Random Primary skill (${category}, ${cost} SPP)${behalf(ctx)}`, to: r.rolls.map(rollLine).join(", ") }];
    if (r.forced) {
      takeSkill(p, r.picks[0], "primary", count);
      lines.push({ what: `${who(p)} took ${r.picks[0]} (both rolls gave it)` });
      return lines;
    }
    p.pendingAdvance = { id, kind: "randomPrimary", at: ctx.at, by: ctx.actor, ...(admin ? { admin: true as const } : {}), cost, count, category, rolls: r.rolls, choices: [...r.picks] };
    return lines;
  }
  const { roll } = rollCharacteristic(ctx.roller);
  const stats = statChoices(p, pos, roll);
  ctx.logRoll({
    ...base, kind: "advance-stat", purpose: `Characteristic Improvement (D8) for ${who(p)}`, dice: [roll],
    result: { team: ctx.team.name, playerId: p.playerId, player: who(p), roll, allowed: [...(CHARACTERISTIC_TABLE[roll] ?? [])], choices: stats, cost },
  });
  p.availableSpp -= cost;
  p.pendingAdvance = {
    id, kind: "characteristic", at: ctx.at, by: ctx.actor, ...(admin ? { admin: true as const } : {}), cost, count, roll, choices: stats,
    skills: { primary: choices.primary, secondary: choices.secondary },
  };
  return [{ what: `${who(p)} rolled a Characteristic Improvement (${cost} SPP)${behalf(ctx)}`, to: `D8 ${roll}: ${stats.length ? stats.join(" / ") : "no characteristic can improve"}` }];
}

/** { op: "resolveAdvance" }: takes one of the pending roll's choices. The SPP was spent at the roll: none is charged here. */
export function resolveAdvance(ctx: AdvanceCtx, raw: Record<string, unknown>): Change[] {
  const p = playerOf(ctx.team, raw.playerId);
  const pend: PendingAdvance | undefined = p.pendingAdvance;
  if (!pend) throw new AdvanceError(409, `${who(p)} has no roll waiting for a choice.`);
  if (raw.rollId !== pend.id) throw new AdvanceError(409, "That roll is no longer the one waiting. Reload to see it.");
  const c = (raw.choice && typeof raw.choice === "object" && !Array.isArray(raw.choice) ? raw.choice : {}) as Record<string, unknown>;
  const pos = positionOf(ctx.roster, p.position);
  const owned = new Set(p.skills.map((s) => s.toLowerCase()));
  if (c.type === "stat") {
    if (pend.kind !== "characteristic" || !isStat(c.stat) || !pend.choices.includes(c.stat)) throw new AdvanceError(400, "That characteristic was not offered by this roll.");
    if (!canImprove(p, pos, c.stat)) throw new AdvanceError(409, `${c.stat} can't improve any more for ${who(p)}.`);
    const field = STAT_FIELD[c.stat];
    const from = p[field]!;
    p[field] = c.stat === "AG" || c.stat === "PA" ? from - 1 : from + 1;
    p.skills = [...p.skills, `+${c.stat}`];
    if (typeof p.value === "number") p.value += CHARACTERISTIC_VALUE[c.stat];
    p.level = rankAfter(pend.count + 1);
    delete p.pendingAdvance;
    const shown = (v: number) => (c.stat === "AG" || c.stat === "PA" || c.stat === "AV" ? `${v}+` : String(v));
    return [{ what: `${who(p)} improved ${c.stat} (D8 ${pend.roll})`, from: shown(from), to: shown(p[field]!) }];
  }
  if (c.type !== "skill" || typeof c.skill !== "string") throw new AdvanceError(400, 'choice must be { type: "skill", skill } or { type: "stat", stat }.');
  const want = c.skill.trim().toLowerCase();
  let skill: string | undefined;
  let access: "primary" | "secondary" = "primary";
  if (pend.kind === "randomPrimary") {
    skill = pend.choices.find((s) => s.toLowerCase() === want);
    if (!skill) throw new AdvanceError(400, "That skill was not offered by this roll.");
  } else {
    access = c.access === "secondary" ? "secondary" : "primary";
    // "Choose Skill" instead of the characteristic: any Primary or Secondary skill the player may take now.
    const now = skillChoices(p, pos);
    skill = (access === "secondary" ? now.secondary : now.primary).find((s) => s.toLowerCase() === want);
    if (!skill) throw new AdvanceError(400, `${c.skill} is not a ${access === "secondary" ? "Secondary" : "Primary"} skill this player can take.`);
  }
  if (owned.has(skill.toLowerCase())) throw new AdvanceError(409, `${who(p)} already has ${skill}.`);
  takeSkill(p, skill, access, pend.count);
  delete p.pendingAdvance;
  return [{ what: `${who(p)} took ${skill} (${pend.kind === "randomPrimary" ? `random Primary, ${pend.category}` : `${access === "secondary" ? "Secondary" : "Primary"} instead of a characteristic, D8 ${pend.roll}`})` }];
}
