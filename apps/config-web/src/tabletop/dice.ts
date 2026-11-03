/**
 * The recorder's dice roller routes (spec-forfeit-and-dice-2026-11-02). api.ts routes here after the viewer role is known.
 *   GET  /api/tabletop/matches/:id/dice          the latest roll, open block choices and (when allowed) the dice log
 *   POST /api/tabletop/matches/:id/dice/roll     {kind, count?, side?}  roll on the server; logged BEFORE it is answered
 *   POST /api/tabletop/matches/:id/dice/choose   {rollId, index}        a block-die choice; the first valid one wins
 *   POST /api/tabletop/matches/:id/dice/log      {shown}                the match recorder toggle "Show dice log"
 *
 * Who: the two seats, and organisers (role "organiser" or a manager of the competition). A spectator gets 403 on every
 * dice route, reads included: a stranger never sees a roll. Live sync: after a roll or a choice is logged the server
 * pushes `tabletop-dice` to the match's socket room (participants + organisers viewing the page); the page also polls.
 *
 * The dice log is hidden from the coaches by default (match.diceLogShown, per match); organisers always see it.
 */
import { cryptoRoller } from "../dice/roller.js";
import { newRollId, type DiceLogStore, type DiceRoll, type DiceSide } from "../dice/log.js";
import { mayChooseBlock, parseRollSpec, rollSpec } from "../dice/rolls.js";
import { DEFAULT_DICE_RULESET, kickoffTable, type DiceRuleset } from "../dice/tables.js";
import type { MatchRecord } from "./store.js";
import type { TabletopApiDeps, TabletopResult, ViewerRole } from "./api.js";

const err = (status: number, error: string): TabletopResult => ({ status, body: { error } });
const LATEST = 8;

export interface DiceViewer { role: ViewerRole; manage: boolean; me: string }

/** Organisers always see the log; seats only while the match's toggle is on. */
export const seesDiceLog = (match: MatchRecord, v: DiceViewer): boolean => v.manage || v.role === "organiser" || match.diceLogShown === true;
const seatOf = (role: ViewerRole): DiceSide | null => (role === "home" || role === "away" ? role : null);

export function diceRuleset(match: MatchRecord, deps: TabletopApiDeps): DiceRuleset {
  try { return deps.rulesetOf?.(match) ?? DEFAULT_DICE_RULESET; } catch { return DEFAULT_DICE_RULESET; }
}

/** What GET /dice answers for this viewer (read-only: never writes). */
export function diceView(match: MatchRecord, log: DiceLogStore, v: DiceViewer, deps: TabletopApiDeps): Record<string, unknown> {
  const rolls = log.read(match.id);
  const open = rolls.filter((r) => r.block && r.block.chooser !== "none" && !r.choice);
  const shown = seesDiceLog(match, v);
  const ruleset = diceRuleset(match, deps);
  return {
    ruleset,
    kickoffTable: kickoffTable(ruleset).map((e) => ({ total: e.total, name: e.name })),
    logShown: match.diceLogShown === true,
    canSeeLog: shown,
    /** The newest rolls (live display); the full log only for those who may see it. */
    latest: rolls.slice(-LATEST),
    pending: open,
    ...(shown ? { log: rolls } : {}),
  };
}

/** The push payload after a write: just enough for an open page to refetch (no roll body over the socket). */
const pushPayload = (match: MatchRecord, roll: DiceRoll, what: "roll" | "choice") => ({ matchId: match.id, rollId: roll.id, what, at: roll.choice?.at ?? roll.at });

export function diceRead(match: MatchRecord, v: DiceViewer, deps: TabletopApiDeps): TabletopResult {
  if (v.role === "spectator" && !v.manage) return err(403, "Only the coaches and organisers of this match can see its dice.");
  if (!deps.diceLog) return err(404, "The dice roller is not available here.");
  return { status: 200, body: diceView(match, deps.diceLog, v, deps), headers: { "Cache-Control": "no-store" } };
}

/** POST dice/roll | dice/choose | dice/log, under the match lock. */
export function diceWrite(match: MatchRecord, action: string, body: unknown, v: DiceViewer, deps: TabletopApiDeps, now: () => Date): TabletopResult | Promise<TabletopResult> {
  if (v.role === "spectator" && !v.manage) return err(403, "Only the coaches and organisers of this match can roll here.");
  const log = deps.diceLog;
  if (!log) return err(404, "The dice roller is not available here.");
  if (match.forfeit || match.forfeitPending) return err(409, "This match was forfeited.");
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const seat = seatOf(v.role);
  const organiserOnly = !seat; // an organiser outside the match
  const at = now().toISOString();

  if (action === "dice/log") {
    if (typeof b.shown !== "boolean") return err(400, "shown must be true or false.");
    return (async () => {
      const updated: MatchRecord = { ...match, updatedAt: at };
      if (b.shown) updated.diceLogShown = true; else delete updated.diceLogShown;
      await deps.repo.updateMatch(updated);
      return { status: 200, body: diceView(updated, log, v, deps) };
    })();
  }

  if (match.state !== "recording") return err(409, `This match is ${match.state}: the dice roller is closed.`);

  if (action === "dice/roll") {
    const spec = parseRollSpec(b);
    if ("error" in spec) return err(400, spec.error);
    let side: DiceSide | undefined = seat ?? undefined;
    if (b.side !== undefined) {
      if (b.side !== "home" && b.side !== "away") return err(400, 'side must be "home" or "away".');
      if (seat && b.side !== seat && !v.manage) return err(403, "You roll for your own team.");
      side = b.side;
    }
    if (!side) return err(400, 'An organiser rolls for a side: send side "home" or "away".');
    const core = rollSpec(deps.roller ?? cryptoRoller, spec, diceRuleset(match, deps));
    const roll: DiceRoll = { id: newRollId(), logId: match.id, at, by: v.me, side, ...core, ...(organiserOnly || side !== seat ? { admin: true } : {}) };
    // Logged first: a roll that cannot be written is never answered or pushed.
    try { log.appendRoll(roll); } catch { return err(500, "The roll could not be logged, so it was not made. Try again."); }
    deps.publishDice?.(match.id, pushPayload(match, roll, "roll"));
    return { status: 201, body: { roll, ...diceView(match, log, v, deps) } };
  }

  // dice/choose
  const rollId = b.rollId;
  const index = b.index;
  if (typeof rollId !== "string" || !rollId) return err(400, "rollId is required.");
  if (!Number.isInteger(index)) return err(400, "index must be the chosen die (0, 1 or 2).");
  const roll = log.read(match.id).find((r) => r.id === rollId);
  if (!roll) return err(404, "Roll not found.");
  if (!roll.block || roll.block.chooser === "none") return err(409, "This roll has nothing to choose.");
  if (roll.choice) return err(409, `Already chosen by ${roll.choice.by}.`);
  if (!mayChooseBlock(roll, seat, v.manage || v.role === "organiser")) return err(403, "The rolling coach chooses this block.");
  const faces = (roll.result.faces as string[] | undefined) ?? [];
  if ((index as number) < 0 || (index as number) >= faces.length) return err(400, "index is not one of the rolled dice.");
  const choice = { index: index as number, face: faces[index as number]!, by: v.me, at, ...(organiserOnly ? { admin: true } : {}) };
  try { log.appendChoice(match.id, roll.id, choice); } catch { return err(500, "The choice could not be logged. Try again."); }
  const chosen: DiceRoll = { ...roll, choice };
  deps.publishDice?.(match.id, pushPayload(match, chosen, "choice"));
  return { status: 200, body: { roll: chosen, ...diceView(match, log, v, deps) } };
}
