/**
 * Fixture lobby rules (pure): the inducement menu and budgets, pick validation, the start gate, the reveal rule and the
 * START resolution state machine (spec §9.1). No I/O: api.ts loads and saves, a source adapter supplies the fixture.
 *
 * Budget (BB2025 petty cash, owner rulings §9.2):
 *   - TV gap = |home TV - away TV|. The lower-TV side is the UNDERDOG; the higher one the OVERDOG. Equal TVs (or an
 *     unknown TV) = no inducement step.
 *   - The overdog buys with treasury only, and only where treasury top-up is allowed (leagues by default). Every gold it
 *     spends grows the underdog's petty cash by the same amount.
 *   - The underdog has petty cash (the gap, plus the overdog's spend once that is final) and, where top-up is allowed,
 *     may add up to 50,000 from its treasury (the recorder's rule: TREASURY_TOP_UP_CAP).
 *
 * START (§9.1, §9.2, §9.3), resolved in order:
 *   1. The overdog's locked list (treasury spend).
 *   2. Overdog spent 0 and the underdog armed Auto-Buy on a locked list: that list is bought as loaded.
 *   3. Otherwise START is HELD: the overdog's list is final and now visible to the underdog, whose petty cash grows by
 *      the overdog's spend; the underdog (Auto-Buy list pre-filled, unlocked) picks and locks again, and START re-arms.
 *      Nobody, organisers included, can start past a hold without the underdog's own lock.
 *   Then the stars rule (both sides may pick the same star; Highlander keeps it with the side that locked first, else it
 *   leaves both teams, refunded or forfeit per the rules), then the match.
 */
import { TREASURY_TOP_UP_CAP } from "../tabletop/pregame.js";
import type { InducementCategory } from "../leagues/inducementRules.js";
import {
  LOBBY_SIDES, otherSide,
  type LobbyFixture, type LobbyHold, type LobbyPick, type LobbyRecord, type LobbyResolution, type LobbySide, type LobbySideState,
  type ResolvedPick, type ResolvedSide, type StarClash,
} from "./types.js";

export const STAR_PREFIX = "star:";
export const PICKS_MAX = 40;
export const CHAT_MAX_CHARS = 500;
export const CHAT_KEEP = 1000;

export const emptySide = (): LobbySideState => ({ picks: [], locked: false, autoBuy: false, rosterLocked: false, ready: false });

export function newLobby(fx: Pick<LobbyFixture, "key" | "source" | "sides">, now: Date): LobbyRecord {
  const at = now.toISOString();
  return {
    schema: 1, key: fx.key, source: fx.source,
    coaches: LOBBY_SIDES.map((s) => fx.sides[s].coachId).filter(Boolean),
    revision: 0, sides: { home: emptySide(), away: emptySide() }, chat: [], createdAt: at, updatedAt: at,
  };
}

export const kGold = (gold: number): string => (gold >= 1_000_000 ? `${+(gold / 1_000_000).toFixed(2)}M` : `${Math.round(gold / 1000)}K`);

// ---- TV roles ---------------------------------------------------------------------------------------------------

export interface TvRoles { gap: number; underdog?: LobbySide; overdog?: LobbySide }

export function tvRoles(fx: Pick<LobbyFixture, "sides">): TvRoles {
  const h = fx.sides.home.team.tv, a = fx.sides.away.team.tv;
  if (h === null || a === null || h === a) return { gap: 0 };
  return h > a ? { gap: h - a, underdog: "away", overdog: "home" } : { gap: a - h, underdog: "home", overdog: "away" };
}

/** Why the fixture has no inducement step ("" = it has one). */
export function inducementStep(fx: LobbyFixture): string {
  if (fx.noInducements) return fx.noInducements;
  if (fx.mode === "fork") return "Inducements are bought in the Super FUMBBL client at kick-off.";
  const h = fx.sides.home.team.tv, a = fx.sides.away.team.tv;
  if (h === null || a === null) return "A team value is unknown, so petty cash cannot be worked out.";
  if (h === a) return "Team values are equal: neither team gets petty cash.";
  return "";
}

/** Does this side buy anything before START? The overdog only with treasury top-up and some treasury. */
export function sideHasStep(fx: LobbyFixture, side: LobbySide): boolean {
  if (inducementStep(fx)) return false;
  const r = tvRoles(fx);
  if (side === r.underdog) return true;
  return fx.rules.treasuryTopUp && fx.sides[side].team.treasury > 0;
}

// ---- menu -------------------------------------------------------------------------------------------------------

export interface MenuItem { id: string; name: string; price: number; max: number; icon: string; effect: string }
export interface MenuCategory {
  id: InducementCategory;
  label: string;
  /** Category cap ("0-2" star players), when the table sets one for the whole category. */
  cap?: number;
  items: MenuItem[];
  /** Rows the ruleset lists that cannot be bought here, with the reason (greyed). */
  off: Array<{ id: string; name: string; reason: string }>;
}

const CATEGORY_LABEL: Record<InducementCategory, string> = { staff: "Staff & extras", star: "Star players", special: "Wizards & specials", mercenary: "Mercenaries" };
const CATEGORY_ORDER: readonly InducementCategory[] = ["staff", "star", "special", "mercenary"];

const starRow = (fx: LobbyFixture) => fx.table.find((r) => r.id === "star_players");
export const starCap = (fx: LobbyFixture): number => {
  const r = starRow(fx);
  return r && r.enabled ? r.cap : 0;
};

/** What this side may buy, by category (the same rules validatePicks judges with). */
export function menuFor(fx: LobbyFixture, side: LobbySide): MenuCategory[] {
  const team = fx.sides[side].team;
  const cats = new Map<InducementCategory, MenuCategory>(CATEGORY_ORDER.map((id) => [id, { id, label: CATEGORY_LABEL[id], items: [], off: [] }]));
  for (const row of fx.table) {
    if (row.id === "star_players") continue;
    const cat = cats.get(row.category)!;
    if (!row.enabled || row.cap === 0) { cat.off.push({ id: row.id, name: row.name, reason: "Ruleset off" }); continue; }
    const o = fx.offers(team.file, row.id);
    if ("error" in o) {
      cat.off.push({ id: row.id, name: row.name, reason: row.price === null || /variable price/.test(o.error) ? "Hire at the table" : "Not for this team" });
      continue;
    }
    cat.items.push({ id: row.id, name: o.name, price: o.price, max: o.max ?? row.cap, icon: row.iconSrc, effect: row.effectText });
  }
  const stars = cats.get("star")!;
  const cap = starCap(fx);
  if (cap > 0) {
    stars.cap = cap;
    const icon = starRow(fx)?.iconSrc ?? "";
    for (const s of team.stars) stars.items.push({ id: `${STAR_PREFIX}${s.name}`, name: s.name, price: s.cost, max: 1, icon, effect: "" });
  } else stars.off.push({ id: "star_players", name: "Star players", reason: "Ruleset off" });
  return [...cats.values()];
}

// ---- pick validation ----------------------------------------------------------------------------------------------

/** Shape check of a picks payload: an array of {id, qty} (ids unique, qty 1..16). */
export function parsePicks(raw: unknown): LobbyPick[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "picks must be a list." };
  if (raw.length > PICKS_MAX) return { error: `At most ${PICKS_MAX} picks.` };
  const out: LobbyPick[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "Each pick needs an id and a count." };
    const { id, qty } = p as Record<string, unknown>;
    if (typeof id !== "string" || !id || id.length > 80) return { error: "Each pick needs an id." };
    if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 16) return { error: "Each count must be a whole number from 1 to 16." };
    if (seen.has(id)) return { error: "A pick is listed twice." };
    seen.add(id);
    out.push({ id, qty });
  }
  return out;
}

/** Prices a side's picks (ids, caps, team restrictions, stars); no budget. */
export function priceSide(fx: LobbyFixture, side: LobbySide, picks: readonly LobbyPick[]): { lines: ResolvedPick[]; total: number } | { error: string } {
  const team = fx.sides[side].team;
  const lines: ResolvedPick[] = [];
  let stars = 0;
  for (const p of picks) {
    if (p.id.startsWith(STAR_PREFIX)) {
      const name = p.id.slice(STAR_PREFIX.length);
      const star = team.stars.find((s) => s.name === name);
      if (!star || starCap(fx) === 0) return { error: `${name.slice(0, 60)} cannot play for ${team.name}.` };
      if (p.qty !== 1) return { error: `${star.name}: a star is hired once.` };
      stars++;
      lines.push({ id: p.id, name: star.name, qty: 1, cost: star.cost });
      continue;
    }
    const row = fx.table.find((r) => r.id === p.id);
    if (!row || !row.enabled || row.cap === 0) return { error: `${row?.name ?? "That inducement"} is not offered here.` };
    const o = fx.offers(team.file, p.id);
    if ("error" in o) return { error: o.error };
    const max = o.max ?? row.cap;
    if (p.qty > max) return { error: `${o.name}: at most ${max}.` };
    lines.push({ id: p.id, name: o.name, qty: p.qty, cost: o.price * p.qty });
  }
  if (stars > starCap(fx)) return { error: `At most ${starCap(fx)} star players.` };
  return { lines, total: lines.reduce((n, l) => n + l.cost, 0) };
}

export interface SideBudget {
  role: "overdog" | "underdog" | "equal";
  /** Underdog: the gap, plus the overdog's final spend while START is held. */
  pettyCash: number;
  treasury: number;
  /** Most the treasury may add (overdog: its whole treasury; underdog: up to 50,000), 0 without top-up. */
  topUpLimit: number;
  /** pettyCash + topUpLimit. */
  limit: number;
}

export function budgetFor(fx: LobbyFixture, rec: Pick<LobbyRecord, "hold">, side: LobbySide): SideBudget {
  const r = tvRoles(fx);
  const treasury = Math.max(0, fx.sides[side].team.treasury);
  if (inducementStep(fx) || !r.underdog) return { role: "equal", pettyCash: 0, treasury, topUpLimit: 0, limit: 0 };
  if (side === r.overdog) {
    const topUpLimit = fx.rules.treasuryTopUp ? treasury : 0;
    return { role: "overdog", pettyCash: 0, treasury, topUpLimit, limit: topUpLimit };
  }
  const pettyCash = r.gap + (rec.hold ? rec.hold.overdogSpend : 0);
  const topUpLimit = fx.rules.treasuryTopUp ? Math.min(TREASURY_TOP_UP_CAP, treasury) : 0;
  return { role: "underdog", pettyCash, treasury, topUpLimit, limit: pettyCash + topUpLimit };
}

/** A side's picks against its budget now: the resolved side, or why it does not fit. */
export function planSide(fx: LobbyFixture, rec: Pick<LobbyRecord, "hold">, side: LobbySide, picks: readonly LobbyPick[]): ResolvedSide | { error: string } {
  const priced = priceSide(fx, side, picks);
  if ("error" in priced) return priced;
  const b = budgetFor(fx, rec, side);
  const name = fx.sides[side].team.name;
  if (priced.total > b.limit) {
    if (b.role === "equal") return { error: "Neither team can spend on inducements in this fixture." };
    if (b.role === "overdog") return { error: b.topUpLimit === 0 ? `${name} is the higher-value team and this ruleset allows no treasury spending.` : `${name} pays from its treasury (${kGold(b.treasury)}); these cost ${kGold(priced.total)}.` };
    return { error: `Petty cash is ${kGold(b.pettyCash)}${b.topUpLimit ? ` and the treasury can add ${kGold(b.topUpLimit)}` : ""}; these cost ${kGold(priced.total)}.` };
  }
  const treasury = b.role === "overdog" ? priced.total : Math.max(0, priced.total - b.pettyCash);
  return { picks: priced.lines, total: priced.total, treasury, pettyCash: b.pettyCash };
}

// ---- reveal -------------------------------------------------------------------------------------------------------

export type LobbyViewer = { kind: "side"; side: LobbySide } | { kind: "organiser" } | { kind: "spectator" };

/** Opponent picks reveal when BOTH sides have locked (§9.2), to the underdog once START held (the overdog's final list),
 *  and to everyone once the match started. Organisers see both at all times; a coach always sees their own. */
export function picksVisible(fx: LobbyFixture, rec: LobbyRecord, viewer: LobbyViewer, side: LobbySide): boolean {
  if (viewer.kind === "organiser") return true;
  if (viewer.kind === "side" && viewer.side === side) return true;
  if (rec.started) return true;
  if (LOBBY_SIDES.every((s) => rec.sides[s].locked || !sideHasStep(fx, s))) return true;
  if (viewer.kind === "side" && rec.hold && rec.hold.underdog === viewer.side && side === otherSide(viewer.side)) return true;
  return false;
}

// ---- the start gate -----------------------------------------------------------------------------------------------

export interface GateView {
  rosters: Record<LobbySide, boolean>;
  inducements: Record<LobbySide, boolean>;
  ready: Record<LobbySide, boolean>;
  readyCount: number;
  /** START may be pressed now (by a coach; the organiser's force skips Ready only). */
  armed: boolean;
  forceArmed: boolean;
  blockers: string[];
}

export function gateOf(fx: LobbyFixture, rec: LobbyRecord): GateView {
  const step = !inducementStep(fx);
  const r = tvRoles(fx);
  const rosters = { home: rosterDone(fx, rec, "home"), away: rosterDone(fx, rec, "away") };
  const inducements = {
    home: !step || !sideHasStep(fx, "home") || rec.sides.home.locked,
    away: !step || !sideHasStep(fx, "away") || rec.sides.away.locked,
  };
  const ready = { home: rec.sides.home.ready, away: rec.sides.away.ready };
  const blockers: string[] = [];
  const name = (s: LobbySide) => fx.sides[s].coach || `The ${s} coach`;
  if (!fx.open) blockers.push(fx.closedReason || "This fixture is closed.");
  if (rec.started) blockers.push("The match has started.");
  for (const s of LOBBY_SIDES) if (!rosters[s]) blockers.push(`${name(s)} has not locked their roster.`);
  // The overdog locks first; the underdog may pre-lock with Auto-Buy or pick when START holds.
  if (step && r.overdog && !inducements[r.overdog]) blockers.push(`${name(r.overdog)} has not locked their inducements.`);
  if (step && r.underdog && rec.hold && !rec.sides[r.underdog].locked) blockers.push(`Waiting for ${name(r.underdog)} to lock inducements.`);
  const hard = [...blockers];
  for (const s of LOBBY_SIDES) if (!ready[s]) blockers.push(`${name(s)} is not ready.`);
  return {
    rosters, inducements, ready, readyCount: LOBBY_SIDES.filter((s) => ready[s]).length,
    armed: blockers.length === 0, forceArmed: hard.length === 0, blockers,
  };
}

function rosterDone(fx: LobbyFixture, rec: LobbyRecord, side: LobbySide): boolean {
  const st = rec.sides[side];
  return st.rosterLocked && (fx.mode !== "tabletop" || Boolean(st.teamRef));
}

// ---- START resolution ---------------------------------------------------------------------------------------------

export type StartOutcome =
  | { kind: "refused"; status: number; error: string }
  | { kind: "held"; hold: LobbyHold; banner: string }
  | { kind: "go"; resolution: LobbyResolution };

/**
 * Decides what a START does to the lobby (no I/O): refuse, hold for the underdog's pick, or go with the resolved lists.
 * `force` = an organiser starting without both Ready presses (never past a roster, an inducement lock or a hold).
 */
export function resolveStart(fx: LobbyFixture, rec: LobbyRecord, opts: { force: boolean; now: Date }): StartOutcome {
  const g = gateOf(fx, rec);
  if (rec.started) return { kind: "refused", status: 409, error: "The match has already started." };
  if (!(opts.force ? g.forceArmed : g.armed)) return { kind: "refused", status: 409, error: g.blockers[0] ?? "Not ready to start." };
  const empty = (pettyCash = 0): ResolvedSide => ({ picks: [], total: 0, treasury: 0, pettyCash });
  if (inducementStep(fx)) return { kind: "go", resolution: { home: empty(), away: empty(), pettyCash: 0, treasurySpend: 0, stars: [] } };
  const r = tvRoles(fx);
  const over = r.overdog!, under = r.underdog!;
  // (1) the overdog's locked list
  const overPlan = sideHasStep(fx, over) ? planSide(fx, rec, over, rec.sides[over].picks) : empty();
  if ("error" in overPlan) return { kind: "refused", status: 409, error: `${fx.sides[over].team.name}: ${overPlan.error} An organiser can unlock the list.` };
  const spend = overPlan.treasury;
  const st = rec.sides[under];
  let underPlan: ResolvedSide | { error: string } | undefined;
  if (rec.hold) {
    // (3, re-armed) the underdog locked again against the overdog's final spend
    underPlan = planSide(fx, rec, under, st.picks);
  } else if (spend === 0 && st.locked && st.autoBuy) {
    // (2) Auto-Buy: the pre-loaded list is bought as loaded
    underPlan = planSide(fx, rec, under, st.picks);
    if ("error" in underPlan) underPlan = undefined; // no longer fits (the table changed): the underdog picks again
  }
  if (!underPlan) {
    const hold: LobbyHold = { at: opts.now.toISOString(), underdog: under, overdogSpend: spend, pettyCash: r.gap + spend, was: r.gap };
    return { kind: "held", hold, banner: holdBanner(fx, hold) };
  }
  if ("error" in underPlan) return { kind: "refused", status: 409, error: `${fx.sides[under].team.name}: ${underPlan.error}` };
  const plans: Record<LobbySide, ResolvedSide> = { [over]: overPlan, [under]: underPlan } as Record<LobbySide, ResolvedSide>;
  const stars = applyStarRule(fx, rec, plans);
  return { kind: "go", resolution: { home: plans.home, away: plans.away, pettyCash: underPlan.pettyCash, treasurySpend: spend, stars } };
}

/** The banner a hold shows (§9.1 copy). */
export function holdBanner(fx: LobbyFixture, hold: LobbyHold): string {
  const over = fx.sides[otherSide(hold.underdog)].coach || "The other coach";
  if (hold.overdogSpend > 0) return `${over} spent ${kGold(hold.overdogSpend)}. ${fx.sides[hold.underdog].coach || "The underdog"} has ${kGold(hold.pettyCash)} petty cash now (was ${kGold(hold.was)}).`;
  return `${over} spent nothing. ${fx.sides[hold.underdog].coach || "The underdog"} picks inducements with ${kGold(hold.pettyCash)} petty cash.`;
}

/**
 * Stars both sides picked (§9.3): with Highlander the side that locked first keeps the star; otherwise it leaves BOTH
 * teams. A removed star is refunded (not charged) or forfeit (still charged) per the rules. Petty cash already granted
 * to the underdog stays as it was (a refund only stops the charge). Mutates `plans`.
 */
export function applyStarRule(fx: LobbyFixture, rec: Pick<LobbyRecord, "sides">, plans: Record<LobbySide, ResolvedSide>): StarClash[] {
  const starsOf = (s: LobbySide) => new Set(plans[s].picks.filter((p) => p.id.startsWith(STAR_PREFIX)).map((p) => p.id));
  const shared = [...starsOf("home")].filter((id) => starsOf("away").has(id));
  const clashes: StarClash[] = [];
  const refunded = fx.rules.starClash === "refund";
  for (const id of shared) {
    let removedFrom: LobbySide[] = ["home", "away"];
    let kept: LobbySide | undefined;
    if (fx.rules.highlander) {
      const at = (s: LobbySide) => rec.sides[s].lockedAt ?? "9999";
      kept = at("home") <= at("away") ? "home" : "away";
      removedFrom = [otherSide(kept)];
    }
    for (const s of removedFrom) {
      const plan = plans[s];
      const line = plan.picks.find((p) => p.id === id)!;
      plan.picks = plan.picks.filter((p) => p.id !== id);
      if (refunded) {
        plan.total -= line.cost;
        // the refund comes off what the treasury paid first (unspent petty cash is never kept)
        plan.treasury = s === tvRoles(fx).overdog ? plan.total : Math.max(0, plan.total - plan.pettyCash);
      }
    }
    clashes.push({ name: id.slice(STAR_PREFIX.length), ...(kept ? { kept } : {}), removedFrom, refunded });
  }
  return clashes;
}
