/**
 * League money rules (owner 11-04, spec-grill-round2-leftovers "Round 2 answers" item 3): the League settings "Money" card.
 * Per league, with an optional override per competition (a season or a ladder) that falls back to the league.
 *
 *   winnings  = fan attendance x fan multiplier x 10,000 + touchdowns x per-TD + no-stalling bonus + win / draw bonus
 *               (fan attendance = the two teams' Fan Factors added together, from the recorder's pre-game fans roll).
 *               Concession rule "rulebook" (BB2025 league_play, #record-outcome-and-collect-winnings): the conceding
 *               team gets nothing; the other team gets the WHOLE fan attendance term (twice the multiplier) plus its
 *               touchdowns and win bonus, and no stalling bonus.
 *   petty cash        on / off: the lower-value team gets the team value gap (plus the higher team's treasury spend).
 *   inducement budget pettyCash (gap only) | treasury (treasury spending only) | both (gap + treasury top-up) | fixed
 *                     (a fixed amount per team per game; unspent is lost).
 *   treasury cap      optional: gold over the cap is lost, or converted to Dedicated Fans (one per `capFansStep`, up to the
 *                     maximum; the rest is lost).
 *
 * DEFAULTS reproduce what the site did before the card existed, so no existing league changes: 10,000 per touchdown and
 * nothing else (owner ruling in tabletop/postMatch.ts: no win/draw bonus), petty cash with treasury top-up, no cap. The
 * BB2025 rulebook formula (half the fan attendance, +1 without stalling, the concession rule) is one click away
 * (BB2025_RULEBOOK_WINNINGS) and is what the card offers as "Use the BB2025 rulebook formula".
 * Spiralling expenses are not offered: neither BB2020 nor BB2025 has them (their gold sink is Expensive Mistakes, rolled at
 * the table).
 *
 * Changes apply from the next fixture: a recorder match snapshots the effective rules when it starts (MatchRecord.money)
 * and a forfeit when it is entered, and each fixture result stores the version it used. Nothing is ever recalculated.
 * Every change bumps league.moneyRulesVersion and is logged (who, when, before, after).
 */
// Structural shapes only (no import of ./types.js): the SPA imports this module, and types.js would pull server code in.
interface LeagueMoney { moneyRules?: Partial<MoneyRules>; moneyRulesVersion?: number; moneyRulesLog?: MoneyRulesLogEntry[] }
interface SeasonMoney { rules?: { money?: Partial<MoneyRules> } }
interface CompetitionRow extends SeasonMoney { id: string; name: string; number: number; ladder?: unknown }

export type InducementBudgetRule = "pettyCash" | "treasury" | "both" | "fixed";
export type CapOverflow = "lost" | "fans";
export type ConcessionRule = "none" | "rulebook";

export interface MoneyRules {
  /** Gold per touchdown scored. */
  perTouchdown: number;
  /** Fan attendance multiplier: winnings add attendance x this x 10,000 (BB2025 rulebook: 0.5). */
  fanMultiplier: number;
  winBonus: number;
  drawBonus: number;
  /** Gold when no player of the team was recorded Stalling (BB2025 rulebook: 10,000). */
  noStallingBonus: number;
  concession: ConcessionRule;
  pettyCash: boolean;
  inducementBudget: InducementBudgetRule;
  /** "fixed": the inducement money each team gets per game. */
  fixedBudget: number;
  treasuryCapEnabled: boolean;
  treasuryCap: number;
  capOverflow: CapOverflow;
  /** "fans": gold over the cap per +1 Dedicated Fans. */
  capFansStep: number;
}

export const FAN_ATTENDANCE_UNIT = 10_000;
export const MONEY_GOLD_MAX = 5_000_000;
export const MONEY_AMOUNT_MAX = 500_000;
export const FAN_MULTIPLIER_MAX = 5;
export const MONEY_LOG_KEEP = 500;

export const DEFAULT_MONEY_RULES: Readonly<MoneyRules> = Object.freeze({
  perTouchdown: 10_000,
  fanMultiplier: 0,
  winBonus: 0,
  drawBonus: 0,
  noStallingBonus: 0,
  concession: "none",
  pettyCash: true,
  inducementBudget: "both",
  fixedBudget: 100_000,
  treasuryCapEnabled: false,
  treasuryCap: 1_000_000,
  capOverflow: "lost",
  capFansStep: 50_000,
});

/** The BB2025 rulebook winnings (league_play, Record Outcome and Collect Winnings). */
export const BB2025_RULEBOOK_WINNINGS: Readonly<Partial<MoneyRules>> = Object.freeze({
  perTouchdown: 10_000, fanMultiplier: 0.5, winBonus: 0, drawBonus: 0, noStallingBonus: 10_000, concession: "rulebook",
});

const KEYS = Object.keys(DEFAULT_MONEY_RULES) as Array<keyof MoneyRules>;
const BUDGET_RULES: readonly InducementBudgetRule[] = ["pettyCash", "treasury", "both", "fixed"];

export interface MoneyRulesLogEntry {
  at: string;
  by: string;
  version: number;
  /** "league", or the competition whose override changed. */
  scope: "league" | { seasonId: string; name: string };
  before: MoneyRules;
  after: MoneyRules;
  changes: string[];
}

/** What a fixture result used: the rules version and the effective rules at the time. */
export interface MoneySnapshot { version: number; rules: MoneyRules }

/**
 * The rules of a recorder match started before the money rules existed (no copy on the match): the site's fixed rule,
 * version 0. Such a match never picks up a league's current rules.
 */
export const LEGACY_MONEY: Readonly<MoneySnapshot> = Object.freeze({ version: 0, rules: { ...DEFAULT_MONEY_RULES } });
export const matchMoney = (match: { money?: MoneySnapshot }): MoneySnapshot => match.money ?? { version: LEGACY_MONEY.version, rules: { ...LEGACY_MONEY.rules } };

/** Is `v` a whole number of hundredths (0.55 and 1.1 are; 0.333 is not)? Float-safe. */
export const isHundredths = (v: number): boolean => Number.isFinite(v) && Math.abs(v * 100 - Math.round(v * 100)) < 1e-6;
/** `v` rounded to hundredths (0.55000000001 -> 0.55). */
export const toHundredths = (v: number): number => Math.round(v * 100) / 100;

/**
 * The moneyOverride rules a competition form sends: every key that differs from the league, and null for every key the
 * old override set that now matches the league (the server deletes null keys, so a field reset to the league's value
 * really goes back to following the league).
 */
export function overridePayload(next: MoneyRules, league: MoneyRules, prior: Partial<MoneyRules>): Partial<Record<keyof MoneyRules, unknown>> | null {
  const out: Partial<Record<keyof MoneyRules, unknown>> = {};
  for (const key of Object.keys(next) as Array<keyof MoneyRules>) {
    if (next[key] !== league[key]) out[key] = next[key];
    else if (prior[key] !== undefined) out[key] = null;
  }
  return Object.keys(out).length ? out : null;
}

const clean = (layer: Partial<MoneyRules> | undefined): Partial<MoneyRules> => {
  const out: Partial<MoneyRules> = {};
  if (!layer) return out;
  for (const k of KEYS) if (layer[k] !== undefined && layer[k] !== null) (out as Record<string, unknown>)[k] = layer[k];
  return out;
};

/** The league's effective money rules, with a competition's override as the last layer. */
export function effectiveMoneyRules(league: Pick<LeagueMoney, "moneyRules">, season?: SeasonMoney | null): MoneyRules {
  return { ...DEFAULT_MONEY_RULES, ...clean(league.moneyRules), ...clean(season?.rules?.money) };
}

export const moneyRulesVersion = (league: Pick<LeagueMoney, "moneyRulesVersion">): number => league.moneyRulesVersion ?? 0;

export function moneySnapshot(league: Pick<LeagueMoney, "moneyRules" | "moneyRulesVersion">, season?: SeasonMoney | null): MoneySnapshot {
  return { version: moneyRulesVersion(league), rules: effectiveMoneyRules(league, season) };
}

export class MoneyRulesError extends Error {
  constructor(message: string, readonly field: string) { super(message); }
}

const gold = (v: unknown, field: string, label: string, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > max) throw new MoneyRulesError(`${label} must be a whole number of gold from 0 to ${max.toLocaleString("en-US")}.`, field);
  return v;
};

const LABEL: Record<keyof MoneyRules, string> = {
  perTouchdown: "Per touchdown", fanMultiplier: "Fan attendance multiplier", winBonus: "Win bonus", drawBonus: "Draw bonus",
  noStallingBonus: "No stalling bonus", concession: "Concession rule", pettyCash: "Petty cash", inducementBudget: "Inducement budget",
  fixedBudget: "Fixed budget", treasuryCapEnabled: "Treasury cap", treasuryCap: "Cap", capOverflow: "Over the cap", capFansStep: "Gold per Dedicated Fan",
};

/**
 * The "money" section (league) or a competition override: any subset of the rules; null on a key = back to the layer
 * below (the defaults for the league, the league for an override). Unknown keys are refused. Answers the next stored layer.
 */
export function parseMoneyRules(raw: unknown, prior: Partial<MoneyRules> | undefined, field = "money"): Partial<MoneyRules> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new MoneyRulesError(`${field} must be an object.`, field);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!(KEYS as string[]).includes(k)) throw new MoneyRulesError(`Unknown money setting: ${k.slice(0, 40)}.`, `${field}.${k.slice(0, 40)}`);
  const out: Partial<MoneyRules> = { ...clean(prior) };
  const set = <K extends keyof MoneyRules>(k: K, v: MoneyRules[K]) => { out[k] = v; };
  for (const k of KEYS) {
    if (!(k in r)) continue;
    const v = r[k];
    const f = `${field}.${k}`;
    if (v === null) { delete out[k]; continue; }
    switch (k) {
      case "perTouchdown": case "winBonus": case "drawBonus": case "noStallingBonus": case "capFansStep":
        set(k, gold(v, f, LABEL[k], MONEY_AMOUNT_MAX));
        if (k === "capFansStep" && v === 0) throw new MoneyRulesError("Gold per Dedicated Fan must be more than 0.", f);
        break;
      case "fixedBudget": case "treasuryCap": set(k, gold(v, f, LABEL[k], MONEY_GOLD_MAX)); break;
      case "fanMultiplier":
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > FAN_MULTIPLIER_MAX || !isHundredths(v))
          throw new MoneyRulesError(`The fan attendance multiplier must be from 0 to ${FAN_MULTIPLIER_MAX}, in steps of 0.01.`, f);
        set(k, toHundredths(v));
        break;
      case "concession":
        if (v !== "none" && v !== "rulebook") throw new MoneyRulesError("The concession rule must be none or rulebook.", f);
        set(k, v);
        break;
      case "inducementBudget":
        if (!BUDGET_RULES.includes(v as InducementBudgetRule)) throw new MoneyRulesError("The inducement budget must be pettyCash, treasury, both or fixed.", f);
        set(k, v as InducementBudgetRule);
        break;
      case "capOverflow":
        if (v !== "lost" && v !== "fans") throw new MoneyRulesError("Money over the cap must be lost or fans.", f);
        set(k, v);
        break;
      case "pettyCash": case "treasuryCapEnabled":
        if (typeof v !== "boolean") throw new MoneyRulesError(`${k} must be true or false.`, f);
        set(k, v);
        break;
    }
  }
  return out;
}

// ---- display --------------------------------------------------------------------------------------------------------

const k = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);

export const BUDGET_LABEL: Record<InducementBudgetRule, string> = {
  pettyCash: "Team value gap only", treasury: "Treasury only", both: "Team value gap plus treasury top-up", fixed: "A fixed amount per game",
};

/** The winnings formula in words ("TDs x 10k"; "(attendance x 0.5) x 10k + TDs x 10k + 10k without stalling"). */
export function winningsFormulaText(r: MoneyRules): string {
  const parts: string[] = [];
  if (r.fanMultiplier) parts.push(`fan attendance x ${r.fanMultiplier} x 10k`);
  if (r.perTouchdown) parts.push(`touchdowns x ${k(r.perTouchdown)}`);
  if (r.noStallingBonus) parts.push(`${k(r.noStallingBonus)} without stalling`);
  if (r.winBonus) parts.push(`${k(r.winBonus)} for a win`);
  if (r.drawBonus) parts.push(`${k(r.drawBonus)} for a draw`);
  return parts.length ? parts.join(" + ") : "No winnings";
}

/** The rows the ruleset card and the settings card show (read-only facts). */
export function moneyRulesRows(r: MoneyRules): Array<{ k: string; v: string }> {
  return [
    { k: "Winnings", v: winningsFormulaText(r) },
    { k: "Concession", v: r.concession === "rulebook" ? "The conceding team gets no winnings; the other team gets the whole fan attendance" : "No special rule" },
    { k: "Petty cash", v: r.inducementBudget === "fixed" || r.inducementBudget === "treasury" ? "Not used" : r.pettyCash ? "On" : "Off" },
    { k: "Inducements", v: r.inducementBudget === "fixed" ? `${k(r.fixedBudget)} per team per game` : BUDGET_LABEL[r.inducementBudget] },
    { k: "Treasury cap", v: r.treasuryCapEnabled ? `${k(r.treasuryCap)}, ${r.capOverflow === "fans" ? `the rest buys Dedicated Fans (${k(r.capFansStep)} each)` : "the rest is lost"}` : "None" },
  ];
}

const valueText = (key: keyof MoneyRules, v: unknown): string => {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (typeof v === "number") return key === "fanMultiplier" ? String(v) : k(v);
  if (key === "inducementBudget") { const t = BUDGET_LABEL[v as InducementBudgetRule] ?? String(v); return t.charAt(0).toLowerCase() + t.slice(1); }
  if (key === "capOverflow") return v === "fans" ? "buys Dedicated Fans" : "lost";
  if (key === "concession") return v === "rulebook" ? "the rulebook's" : "none";
  return String(v);
};

/** "Per touchdown: 10k to 20k" lines between two effective rule sets. */
export function moneyRulesDiff(before: MoneyRules, after: MoneyRules): string[] {
  return KEYS.filter((key) => before[key] !== after[key]).map((key) => `${LABEL[key]}: ${valueText(key, before[key])} to ${valueText(key, after[key])}`);
}

// ---- the maths --------------------------------------------------------------------------------------------------------

export interface WinningsInput {
  score: { for: number; against: number };
  /** Both teams' Fan Factors added together; undefined = not recorded (the fan term counts 0). */
  attendance: number | undefined;
  stalled: boolean;
  conceded: { self: boolean; other: boolean };
}
export interface WinningsLine { what: string; gold: number }

/** One team's winnings by the rules, with its lines (the recorder's post-game money step). */
export function computeWinnings(r: MoneyRules, x: WinningsInput): { winnings: number; lines: WinningsLine[] } {
  const lines: WinningsLine[] = [];
  const rulebook = r.concession === "rulebook";
  if (rulebook && x.conceded.self) return { winnings: 0, lines: [{ what: "Conceded: no winnings", gold: 0 }] };
  const byConcession = rulebook && x.conceded.other;
  const att = x.attendance ?? 0;
  const mult = byConcession ? r.fanMultiplier * 2 : r.fanMultiplier;
  if (r.fanMultiplier) lines.push({ what: `Fan attendance ${att} x ${mult}${byConcession ? " (the opponent conceded)" : ""}`, gold: Math.round(att * mult * FAN_ATTENDANCE_UNIT) });
  if (r.perTouchdown) lines.push({ what: `${x.score.for} touchdown${x.score.for === 1 ? "" : "s"}`, gold: x.score.for * r.perTouchdown });
  if (r.noStallingBonus && !x.stalled && !byConcession) lines.push({ what: "No stalling", gold: r.noStallingBonus });
  const won = x.score.for > x.score.against || (x.conceded.other && !x.conceded.self);
  const drawn = !won && x.score.for === x.score.against && !x.conceded.self;
  if (r.winBonus && won) lines.push({ what: "Win bonus", gold: r.winBonus });
  if (r.drawBonus && drawn) lines.push({ what: "Draw bonus", gold: r.drawBonus });
  return { winnings: lines.reduce((n, l) => n + l.gold, 0), lines };
}

/** The treasury cap: what is kept, lost and turned into Dedicated Fans (never above `fansMax`). */
export function applyTreasuryCap(r: MoneyRules, treasury: number, fans: number, fansMax: number): { treasury: number; fans: number; lost: number; fansGained: number } {
  if (!r.treasuryCapEnabled || treasury <= r.treasuryCap) return { treasury, fans, lost: 0, fansGained: 0 };
  const over = treasury - r.treasuryCap;
  let fansGained = 0;
  if (r.capOverflow === "fans" && r.capFansStep > 0) fansGained = Math.max(0, Math.min(Math.floor(over / r.capFansStep), fansMax - fans));
  const lost = over - fansGained * r.capFansStep;
  return { treasury: r.treasuryCap, fans: fans + fansGained, lost, fansGained };
}

/** The fixture lobby's budget flags from the rules (absent flags = today's league behaviour). */
export function lobbyBudget(r: MoneyRules): { pettyCash: boolean; treasuryTopUp: boolean; fixedBudget: number } {
  const gap = r.pettyCash && (r.inducementBudget === "pettyCash" || r.inducementBudget === "both");
  return {
    pettyCash: gap,
    treasuryTopUp: r.inducementBudget === "treasury" || r.inducementBudget === "both",
    fixedBudget: r.inducementBudget === "fixed" ? r.fixedBudget : 0,
  };
}

/**
 * The forfeit dialog's winnings suggestion for one side. Concession rule "none" (the default) suggests no winnings, as
 * before; "rulebook" gives the team that did not forfeit the whole fan attendance (both teams' Dedicated Fans: no Fan
 * Factor was rolled) plus its awarded touchdowns and win bonus, and the forfeiting team nothing.
 */
export function forfeitWinnings(r: MoneyRules, x: { forfeit: boolean; otherForfeit: boolean; score: number; otherScore: number; attendance: number }): number {
  if (r.concession !== "rulebook" || x.forfeit || !x.otherForfeit) return 0;
  return computeWinnings(r, { score: { for: x.score, against: x.otherScore }, attendance: x.attendance, stalled: false, conceded: { self: false, other: true } }).winnings;
}

// ---- read model -------------------------------------------------------------------------------------------------------

export interface MoneyCompetitionView {
  seasonId: string;
  name: string;
  kind: "season" | "ladder";
  /** The override keys this competition sets (the rest follow the league). */
  override: Partial<MoneyRules>;
  rules: MoneyRules;
}

export interface MoneyRulesView {
  version: number;
  rules: MoneyRules;
  defaults: MoneyRules;
  rulebook: Partial<MoneyRules>;
  /** Keys the league set itself. */
  set: Array<keyof MoneyRules>;
  competitions: MoneyCompetitionView[];
  /** Newest first, the last 20 changes. */
  log: MoneyRulesLogEntry[];
}

export function moneyRulesView(league: LeagueMoney, seasons: readonly CompetitionRow[]): MoneyRulesView {
  return {
    version: moneyRulesVersion(league),
    rules: effectiveMoneyRules(league),
    defaults: { ...DEFAULT_MONEY_RULES },
    rulebook: { ...BB2025_RULEBOOK_WINNINGS },
    set: Object.keys(clean(league.moneyRules)) as Array<keyof MoneyRules>,
    competitions: [...seasons].sort((a, b) => b.number - a.number).map((s) => ({
      seasonId: s.id, name: s.name, kind: s.ladder ? "ladder" as const : "season" as const, override: clean(s.rules?.money), rules: effectiveMoneyRules(league, s),
    })),
    log: [...(league.moneyRulesLog ?? [])].reverse().slice(0, 20),
  };
}

/** The public read (the league's ruleset card): the league's rules and each competition that overrides them. */
export function publicMoneyRules(league: Pick<LeagueMoney, "moneyRules" | "moneyRulesVersion">, seasons: readonly CompetitionRow[]): {
  version: number; rules: MoneyRules; bySeason: Record<string, MoneyRules>;
} {
  const bySeason: Record<string, MoneyRules> = {};
  for (const s of seasons) if (Object.keys(clean(s.rules?.money)).length) bySeason[s.id] = effectiveMoneyRules(league, s);
  return { version: moneyRulesVersion(league), rules: effectiveMoneyRules(league), bySeason };
}
