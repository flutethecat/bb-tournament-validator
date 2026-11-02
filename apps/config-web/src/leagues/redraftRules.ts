/**
 * Redraft budget rules (owner 11-02, spec-league-ladder "Redraft"): the formula and options a redraft opens with.
 *
 *   budget  = base + treasury left + per game x games + per win x wins + per draw x draws + per loss x losses
 *             (base = the roster's initial treasury unless the league sets one), capped when the cap is on
 *   spendable = an organiser's override, else max(earned, the lift) where a lift raises a team that earned less than the
 *             set budget to it ("Lift to budget", per team or for all; automatic when the redraft opens with
 *             liftToBudget on). Every lift is logged with its actor and time.
 *
 * Layers (effectiveRedraftRules): the defaults (the amounts that were hardcoded before 11-02) <- the league's old
 * remembered cap (redraftCap) <- league.redraftRules <- an override (a ladder's, later). liftToBudget is OFF unless set:
 * leagues made before 11-02 keep today's behaviour, and the creation wizard sets it ON for new leagues.
 */
import type { LeagueRecord, RedraftAmounts, RedraftRules } from "./types.js";

export const DEFAULT_REDRAFT_RULES: Readonly<RedraftRules> = Object.freeze({
  base: null,
  perGame: 20_000,
  perWin: 20_000,
  perDraw: 10_000,
  perLoss: 0,
  agentFee: 20_000,
  capEnabled: true,
  cap: 1_300_000,
  setBudget: 1_000_000,
  liftToBudget: false,
  windowDays: 7,
});

/** What a new league starts with (the creation wizard): the defaults with Lift teams to the budget on. */
export const NEW_LEAGUE_REDRAFT_RULES: Partial<RedraftRules> = { liftToBudget: true };

export const GOLD_MAX = 5_000_000;
export const AMOUNT_MAX = 500_000;
export const WINDOW_DAYS_MAX = 60;

export const amountsOf = (r: Pick<RedraftRules, keyof RedraftAmounts>): RedraftAmounts => ({ perGame: r.perGame, perWin: r.perWin, perDraw: r.perDraw, perLoss: r.perLoss });
export const DEFAULT_AMOUNTS: Readonly<RedraftAmounts> = Object.freeze(amountsOf(DEFAULT_REDRAFT_RULES));

/** The league's effective rules; `override` (a ladder's, later) is the last layer. */
export function effectiveRedraftRules(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">, override?: Partial<RedraftRules>): RedraftRules {
  const out: RedraftRules = { ...DEFAULT_REDRAFT_RULES };
  if (league.redraftCap) { out.capEnabled = league.redraftCap.enabled; out.cap = league.redraftCap.cap; }
  for (const layer of [league.redraftRules, override]) {
    if (!layer) continue;
    for (const k of Object.keys(DEFAULT_REDRAFT_RULES) as Array<keyof RedraftRules>) {
      const v = layer[k];
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}

export class RedraftRulesError extends Error {
  constructor(message: string, readonly field: string) { super(message); }
}

const gold = (v: unknown, field: string, label: string, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new RedraftRulesError(`${label} must be a whole number of gold from 0 to ${max.toLocaleString("en-US")}.`, field);
  return v;
};

/**
 * The League settings "redraft" section: any subset of the rules (unknown keys refused). base null = the roster's
 * initial treasury. Answers the league's next stored rules (the prior ones with the changes).
 */
export function parseRedraftRules(raw: unknown, prior: Partial<RedraftRules> | undefined): Partial<RedraftRules> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RedraftRulesError("redraft must be an object.", "redraft");
  const r = raw as Record<string, unknown>;
  const known = new Set(Object.keys(DEFAULT_REDRAFT_RULES));
  for (const k of Object.keys(r)) if (!known.has(k)) throw new RedraftRulesError(`Unknown redraft setting: ${k.slice(0, 40)}.`, `redraft.${k.slice(0, 40)}`);
  const out: Partial<RedraftRules> = { ...(prior ?? {}) };
  if (r.base !== undefined) out.base = r.base === null ? null : gold(r.base, "redraft.base", "Base", GOLD_MAX);
  if (r.perGame !== undefined) out.perGame = gold(r.perGame, "redraft.perGame", "Per game", AMOUNT_MAX);
  if (r.perWin !== undefined) out.perWin = gold(r.perWin, "redraft.perWin", "Per win", AMOUNT_MAX);
  if (r.perDraw !== undefined) out.perDraw = gold(r.perDraw, "redraft.perDraw", "Per draw", AMOUNT_MAX);
  if (r.perLoss !== undefined) out.perLoss = gold(r.perLoss, "redraft.perLoss", "Per loss", AMOUNT_MAX);
  if (r.agentFee !== undefined) out.agentFee = gold(r.agentFee, "redraft.agentFee", "Agent fee", AMOUNT_MAX);
  if (r.cap !== undefined) out.cap = gold(r.cap, "redraft.cap", "Cap", GOLD_MAX);
  if (r.setBudget !== undefined) out.setBudget = gold(r.setBudget, "redraft.setBudget", "Set budget", GOLD_MAX);
  for (const k of ["capEnabled", "liftToBudget"] as const) {
    if (r[k] === undefined) continue;
    if (typeof r[k] !== "boolean") throw new RedraftRulesError(`${k} must be true or false.`, `redraft.${k}`);
    out[k] = r[k] as boolean;
  }
  if (r.windowDays !== undefined) {
    const d = r.windowDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > WINDOW_DAYS_MAX) throw new RedraftRulesError(`The redraft window must be 1 to ${WINDOW_DAYS_MAX} days.`, "redraft.windowDays");
    out.windowDays = d;
  }
  return out;
}

/** The read model for League settings: the effective rules, the defaults, and which keys the league set itself. */
export interface RedraftRulesView {
  rules: RedraftRules;
  defaults: RedraftRules;
  /** Keys stored on the league (the rest follow the defaults). */
  set: Array<keyof RedraftRules>;
}

export function redraftRulesView(league: Pick<LeagueRecord, "redraftRules" | "redraftCap">): RedraftRulesView {
  const set = (Object.keys(league.redraftRules ?? {}) as Array<keyof RedraftRules>).filter((k) => league.redraftRules?.[k] !== undefined);
  return { rules: effectiveRedraftRules(league), defaults: { ...DEFAULT_REDRAFT_RULES }, set };
}
