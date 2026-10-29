/**
 * League redraft (off-season): the organiser's board and the coach's Team Draft List. Pure over the season records;
 * the routes live in redraftApi.ts.
 *
 * Rules (paraphrased from https://bloodbowlbase.ru/bb2025/core_rules/league_play/#re-draft-team, owner rulings 10-30):
 *   - Rest & Relaxation first: each niggling injury rolls off on a 4+ (3+ when the team has an Apothecary); a missed
 *     game and temporary characteristic reductions recover.
 *   - Budget = the roster's initial treasury (1,000,000 unless the season's Team building table says otherwise)
 *     + treasury left + 20,000 per league fixture played last season + 20,000 per win + 10,000 per draw, capped at
 *     1,300,000 when the league keeps the cap on (the excess is lost). An organiser may override a team's budget.
 *   - Re-hiring a player costs their current value + a 20,000 agent fee for every season they have taken part in
 *     (seasonsPlayed, plus the season just finished when their team played in it). A player not re-hired retires.
 *   - Staff (rerolls, assistant coaches, cheerleaders, apothecary) are bought again at the standard price or let go;
 *     the rest of the team is drafted under the normal rules (11 to 16 players, position limits). Unspent gold becomes
 *     the new team's treasury.
 */
import { createHash, randomInt } from "node:crypto";
import { findPosition, findRoster, type DatasetPosition, type DatasetRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { buildCoachAliases, fixtureOutcome, seasonCoachFacets, type CoachAliases } from "./identity.js";
import { playerIdFor, teamPlayedIn } from "./playerIds.js";
import {
  EMPTY_PLAYER_STATS, type DraftList, type LeaguePlayer, type LeagueTeam, type RedraftBudget, type RedraftState, type RedraftTeamTask,
  type RestRoll, type SeasonRecord,
} from "./types.js";
import { forkPlayLock } from "./forkTeam.js";

export const REDRAFT_BASE = 1_000_000;
export const PER_GAME = 20_000;
export const PER_WIN = 20_000;
export const PER_DRAW = 10_000;
export const DEFAULT_CAP = 1_300_000;
export const AGENT_FEE = 20_000;
export const OVERRIDE_MAX = 5_000_000;
export const STAFF_COST = { assistantCoach: 10_000, cheerleader: 10_000, apothecary: 50_000 } as const;
export const LIMITS = { minPlayers: 11, maxPlayers: 16, assistantCoaches: 6, cheerleaders: 12 } as const;
const DEFAULT_REROLL_COST = 60_000;

export class RedraftError extends Error {
  constructor(readonly status: number, message: string, readonly field?: string) {
    super(message);
  }
}

// ---- seasons ----

/** Finished seasons, newest first: the seasons a redraft may run from. */
export const finishedSeasons = (seasons: SeasonRecord[]): SeasonRecord[] =>
  [...seasons].filter((s) => s.status === "completed").sort((a, b) => b.number - a.number);

/**
 * The season a redraft runs from. Seasons may overlap (owner 10-30), so the organiser may pick any finished season
 * (`pick`, undefined when it is not a finished season); without a pick, a confirmed redraft still open wins, else the
 * newest finished season.
 */
export function redraftSource(seasons: SeasonRecord[], pick?: string): SeasonRecord | undefined {
  const finished = finishedSeasons(seasons);
  if (pick) return finished.find((s) => s.id === pick);
  return finished.find((s) => s.redraft && !s.redraft.closedAt) ?? finished[0];
}

/** Seasons after the source, newest first: where its draft lists may go. */
export const redraftTargets = (seasons: SeasonRecord[], source: SeasonRecord): SeasonRecord[] =>
  [...seasons].filter((s) => s.number > source.number).sort((a, b) => b.number - a.number);

/**
 * The season the draft lists go into (undefined = not started yet): the organiser's pick (`pick`, or the one stored on
 * the confirmed redraft), else the newest in-progress season after the source, else the newest season after it.
 */
export function redraftTarget(seasons: SeasonRecord[], source: SeasonRecord, pick?: string): SeasonRecord | undefined {
  const after = redraftTargets(seasons, source);
  const want = pick ?? source.redraft?.targetSeasonId;
  if (want) return after.find((s) => s.id === want);
  return after.find((s) => s.status === "active") ?? after[0];
}

export interface TeamRecordLine { played: number; wins: number; draws: number; losses: number }

/** Games of the team in the season's league fixtures (a fixture counts once it has a result). */
export function teamRecord(season: Pick<SeasonRecord, "fixtures">, team: Pick<LeagueTeam, "id" | "name">): TeamRecordLine {
  const out = { played: 0, wins: 0, draws: 0, losses: 0 };
  const named = team.name.trim().toLowerCase();
  const isTeam = (side: { teamId?: string; team: string }): boolean => (side.teamId ? side.teamId === team.id : side.team.trim().toLowerCase() === named);
  for (const f of season.fixtures) {
    const side = isTeam(f.home) ? "home" : isTeam(f.away) ? "away" : undefined;
    const outcome = side ? fixtureOutcome(f) : undefined;
    if (!side || !outcome) continue;
    out.played += 1;
    const r = outcome[side];
    if (r === "win") out.wins += 1; else if (r === "draw") out.draws += 1; else out.losses += 1;
  }
  return out;
}

// ---- budget ----

export interface BudgetInput { base: number; treasury: number; played: number; wins: number; draws: number }

export function redraftBudget(input: BudgetInput, cap: { enabled: boolean; cap: number }): RedraftBudget {
  const bonus = input.played * PER_GAME + input.wins * PER_WIN + input.draws * PER_DRAW;
  const treasury = Math.max(0, Math.round(input.treasury || 0));
  const raw = input.base + treasury + bonus;
  return { base: input.base, treasury, played: input.played, wins: input.wins, draws: input.draws, bonus, raw, capped: cap.enabled ? Math.min(raw, cap.cap) : raw };
}

/** What the coach may spend: the organiser's override, else the (capped) budget. */
export const spendable = (task: Pick<RedraftTeamTask, "budget" | "override">): number => task.override?.budget ?? task.budget.capped;

/** The roster's initial treasury from the season's Team building table, else 1,000,000. */
export function baseFor(rulesSeason: Pick<SeasonRecord, "rules"> | undefined, race: string): number {
  const roster = datasetRoster(race);
  const rule = rulesSeason?.rules?.teamBuilding?.rosters.find((r) => r.roster === (roster?.name ?? race));
  return rule ? rule.treasury * 1000 : REDRAFT_BASE;
}

// ---- dataset ----

export const datasetRoster = (race: string): DatasetRoster | undefined => (race.trim() ? findRoster(bb2025, race) : undefined);
export const rerollCost = (roster: DatasetRoster | undefined): number => roster?.reRollCost || DEFAULT_REROLL_COST;
const isBigGuy = (p: DatasetPosition | undefined): boolean => Boolean(p && /big\s*guy/i.test(p.type));
const target = (v: unknown): number | null => {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : null;
};

// ---- board ----

export interface BoardRow {
  teamId: string;
  sourceSeasonId: string;
  sourceSeasonName: string;
  name: string;
  coach: string;
  coachId?: string;
  race: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  treasury: number;
  budget: RedraftBudget;
  /** Per player, for the hover list: name and seasons taken part in (including the finished one). */
  players: Array<{ name: string; position: string; seasons: number }>;
  selected: boolean;
  status?: RedraftTeamTask["status"];
  override?: RedraftTeamTask["override"];
  spendable: number;
}

const teamKey = (t: Pick<LeagueTeam, "id">): string => t.id;

export function boardRow(source: SeasonRecord, team: LeagueTeam, cap: { enabled: boolean; cap: number }, rulesSeason: SeasonRecord | undefined, task?: RedraftTeamTask): BoardRow {
  const rec = teamRecord(source, team);
  const budget = task?.budget ?? redraftBudget({ base: baseFor(rulesSeason, team.race), treasury: team.treasury ?? 0, ...rec }, cap);
  const played = teamPlayedIn(source, team);
  return {
    teamId: team.id, sourceSeasonId: source.id, sourceSeasonName: source.name, name: team.name, coach: team.coach,
    ...(team.coachId ? { coachId: team.coachId } : {}),
    race: team.race, ...rec, treasury: team.treasury ?? 0, budget,
    players: team.players.map((p) => ({ name: p.name, position: p.position, seasons: feeSeasons(p, played) })),
    selected: task?.selected ?? false,
    ...(task ? { status: task.status } : {}),
    ...(task?.override ? { override: task.override } : {}),
    spendable: task ? spendable(task) : budget.capped,
  };
}

/**
 * The board: active teams (the source season's) and inactive teams (from earlier seasons, not in the source season;
 * each team once, from the newest season it played in).
 */
export function redraftBoard(seasons: SeasonRecord[], source: SeasonRecord, state: RedraftState | undefined, cap: { enabled: boolean; cap: number }): { active: BoardRow[]; inactive: BoardRow[] } {
  const effCap = state ? { enabled: state.capEnabled, cap: state.cap } : cap;
  const rulesSeason = redraftTarget(seasons, source) ?? source;
  const taskOf = (id: string): RedraftTeamTask | undefined => state?.teams.find((t) => t.teamId === id);
  const active = source.teams.map((t) => boardRow(source, t, effCap, rulesSeason, taskOf(t.id)));
  const seen = new Set(source.teams.map(teamKey));
  const inactive: BoardRow[] = [];
  for (const s of [...seasons].filter((x) => x.number < source.number).sort((a, b) => b.number - a.number)) {
    for (const t of s.teams) {
      if (seen.has(teamKey(t))) continue;
      seen.add(teamKey(t));
      inactive.push(boardRow(s, t, effCap, rulesSeason, taskOf(t.id)));
    }
  }
  const byName = (a: BoardRow, b: BoardRow) => a.name.localeCompare(b.name);
  return { active: active.sort(byName), inactive: inactive.sort(byName) };
}

// ---- Rest & Relaxation ----

/** Niggling injuries roll off on this or more: 4+, 3+ with an Apothecary (owner-confirmed 10-30). */
export const restTarget = (apothecary: boolean): number => (apothecary ? 3 : 4);

export type Roller = () => number;
export const d6: Roller = () => randomInt(1, 7);

/**
 * One roll per niggling injury. mode "site" rolls with `roll`; mode "entered" takes the coach's results per player
 * (exactly one 1-6 value per niggling injury).
 */
export function restAndRelaxation(team: Pick<LeagueTeam, "players" | "apothecary">, mode: "site" | "entered", entered: Record<string, unknown> = {}, roll: Roller = d6): RestRoll[] {
  const goal = restTarget(team.apothecary);
  const out: RestRoll[] = [];
  for (const p of team.players) {
    const n = Math.max(0, p.niggling | 0);
    if (!n) continue;
    let values: number[];
    if (mode === "site") values = Array.from({ length: n }, () => roll());
    else {
      const raw = entered[p.playerId];
      if (!Array.isArray(raw) || raw.length !== n || raw.some((v) => typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 6))
        throw new RedraftError(400, `Enter ${n === 1 ? "one result" : `${n} results`} from 1 to 6 for ${p.name || p.position}.`, `rolls.${p.playerId}`);
      values = raw as number[];
    }
    for (const v of values) out.push({ playerId: p.playerId, roll: v, target: goal, recovered: v >= goal, source: mode });
  }
  return out;
}

/** Niggling injuries left after the rolls (never below 0). */
export function nigglesAfter(player: Pick<LeaguePlayer, "playerId" | "niggling">, rolls: readonly RestRoll[]): number {
  const healed = rolls.filter((r) => r.playerId === player.playerId && r.recovered).length;
  return Math.max(0, (player.niggling | 0) - healed);
}

// ---- re-hire ----

/** Seasons charged as agent fee: seasonsPlayed (earlier seasons) + the finished season when the team played in it. */
export const feeSeasons = (p: Pick<LeaguePlayer, "seasonsPlayed">, teamPlayed: boolean): number => (p.seasonsPlayed ?? 0) + (teamPlayed ? 1 : 0);

export interface RehireQuote {
  playerId: string;
  number: number | null;
  name: string;
  position: string;
  value: number;
  seasons: number;
  fee: number;
  cost: number;
  niggling: number;
  missNextGame: boolean;
  bigGuy: boolean;
}

export function rehireQuote(p: LeaguePlayer, teamPlayed: boolean, roster: DatasetRoster | undefined): RehireQuote {
  const pos = roster ? findPosition(roster, p.position) : undefined;
  const value = typeof p.value === "number" && p.value >= 0 ? p.value : pos?.cost ?? 0;
  const seasons = feeSeasons(p, teamPlayed);
  const fee = seasons * AGENT_FEE;
  return {
    playerId: p.playerId, number: p.number, name: p.name, position: p.position, value, seasons, fee, cost: value + fee,
    niggling: p.niggling | 0, missNextGame: p.missNextGame, bigGuy: isBigGuy(pos),
  };
}

// ---- the coach's view ----

export interface DraftContext {
  task: RedraftTeamTask;
  source: SeasonRecord;
  team: LeagueTeam;
  roster: DatasetRoster | undefined;
  teamPlayed: boolean;
}

export interface CoachRedraftView {
  leagueId: string;
  revision: number;
  teamId: string;
  name: string;
  race: string;
  coach: string;
  sourceSeason: { id: string; name: string };
  targetSeason: { id: string; name: string } | null;
  status: RedraftTeamTask["status"];
  expiredReason: string;
  closed: boolean;
  budget: RedraftBudget;
  capEnabled: boolean;
  cap: number;
  override: RedraftTeamTask["override"] | null;
  spendable: number;
  apothecaryNow: boolean;
  rest: { target: number; done: boolean; rolls: RestRoll[]; needed: Array<{ playerId: string; name: string; position: string; niggling: number }> };
  players: Array<RehireQuote & { nigglingAfter: number }>;
  staff: {
    rerollCost: number; maxRerolls: number; assistantCoachCost: number; cheerleaderCost: number; apothecaryCost: number; apothecaryAllowed: boolean;
    current: { rerolls: number; assistantCoaches: number; cheerleaders: number; apothecary: boolean };
  };
  positions: Array<{ name: string; cost: number; max: number; bigGuy: boolean }>;
  limits: { minPlayers: number; maxPlayers: number; assistantCoaches: number; cheerleaders: number; maxBigGuys: number };
  draft: DraftList | null;
  knownRoster: boolean;
}

export function coachView(leagueId: string, state: RedraftState, ctx: DraftContext, targetSeason: SeasonRecord | undefined): CoachRedraftView {
  const { task, team, roster, teamPlayed } = ctx;
  const rolls = task.rest?.rolls ?? [];
  return {
    leagueId, revision: state.revision, teamId: team.id, name: team.name, race: team.race, coach: team.coach,
    sourceSeason: { id: ctx.source.id, name: ctx.source.name },
    targetSeason: targetSeason ? { id: targetSeason.id, name: targetSeason.name } : null,
    status: task.status, expiredReason: task.expiredReason ?? "", closed: Boolean(state.closedAt),
    budget: task.budget, capEnabled: state.capEnabled, cap: state.cap, override: task.override ?? null, spendable: spendable(task),
    apothecaryNow: team.apothecary,
    rest: {
      target: restTarget(team.apothecary), done: Boolean(task.rest), rolls,
      needed: team.players.filter((p) => (p.niggling | 0) > 0).map((p) => ({ playerId: p.playerId, name: p.name, position: p.position, niggling: p.niggling | 0 })),
    },
    players: team.players.map((p) => ({ ...rehireQuote(p, teamPlayed, roster), nigglingAfter: nigglesAfter(p, rolls) })),
    staff: {
      rerollCost: rerollCost(roster), maxRerolls: roster?.maxReRolls ?? 8,
      assistantCoachCost: STAFF_COST.assistantCoach, cheerleaderCost: STAFF_COST.cheerleader, apothecaryCost: STAFF_COST.apothecary,
      apothecaryAllowed: roster?.apothecaryAllowed ?? true,
      current: { rerolls: team.rerolls ?? 0, assistantCoaches: team.assistantCoaches ?? 0, cheerleaders: team.cheerleaders ?? 0, apothecary: team.apothecary },
    },
    positions: (roster?.positions ?? []).map((p) => ({ name: p.name, cost: p.cost, max: p.max, bigGuy: isBigGuy(p) })),
    limits: { ...LIMITS, maxBigGuys: roster?.maxBigGuys ?? 16 },
    draft: task.draft ?? null,
    knownRoster: Boolean(roster),
  };
}

// ---- validation ----

export interface DraftInput {
  keep: string[];
  hires: Array<{ position: string; count: number }>;
  staff: { rerolls: number; assistantCoaches: number; cheerleaders: number; apothecary: boolean };
}

const wholeIn = (v: unknown, field: string, label: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new RedraftError(400, `${label} must be a whole number from ${min} to ${max}.`, field);
  return v;
};

/** Shape check of a submit body (values, not the budget: see validateDraft). */
export function parseDraftInput(raw: Record<string, unknown>): DraftInput {
  if (!Array.isArray(raw.keep) || raw.keep.some((k) => typeof k !== "string")) throw new RedraftError(400, "keep must be a list of player ids.", "keep");
  const hiresRaw = raw.hires ?? [];
  if (!Array.isArray(hiresRaw)) throw new RedraftError(400, "hires must be a list.", "hires");
  const hires = hiresRaw.map((h, i) => {
    if (!h || typeof h !== "object") throw new RedraftError(400, "Each hire needs a position and a count.", `hires[${i}]`);
    const { position, count } = h as Record<string, unknown>;
    if (typeof position !== "string" || !position.trim()) throw new RedraftError(400, "Each hire needs a position.", `hires[${i}].position`);
    return { position: position.trim(), count: wholeIn(count, `hires[${i}].count`, `${position.trim()} count`, 0, 16) };
  }).filter((h) => h.count > 0);
  const s = raw.staff;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new RedraftError(400, "staff must be an object.", "staff");
  const st = s as Record<string, unknown>;
  if (typeof st.apothecary !== "boolean") throw new RedraftError(400, "staff.apothecary must be true or false.", "staff.apothecary");
  return {
    keep: raw.keep as string[],
    hires,
    staff: {
      rerolls: wholeIn(st.rerolls, "staff.rerolls", "Rerolls", 0, 16),
      assistantCoaches: wholeIn(st.assistantCoaches, "staff.assistantCoaches", "Assistant coaches", 0, 99),
      cheerleaders: wholeIn(st.cheerleaders, "staff.cheerleaders", "Cheerleaders", 0, 99),
      apothecary: st.apothecary,
    },
  };
}

export interface DraftPrice {
  keep: Array<{ quote: RehireQuote }>;
  hires: Array<{ position: DatasetPosition; count: number; cost: number }>;
  staffCost: number;
  spent: number;
  remaining: number;
  players: number;
}

/**
 * Prices the draft and checks it against the rules: no player twice, players of this team only, positions of the
 * roster, position limits (kept + hired), big guy limit, 11-16 players, staff limits, and the sum within the budget.
 * Throws a RedraftError with every problem joined when it does not hold.
 */
export function validateDraft(ctx: DraftContext, input: DraftInput): DraftPrice {
  const errors: string[] = [];
  const { roster, team, teamPlayed } = ctx;
  const seen = new Set<string>();
  const keep: Array<{ quote: RehireQuote }> = [];
  for (const id of input.keep) {
    if (seen.has(id)) { errors.push("A player is kept twice."); continue; }
    seen.add(id);
    const p = team.players.find((x) => x.playerId === id);
    if (!p) { errors.push("A kept player is not on this team."); continue; }
    keep.push({ quote: rehireQuote(p, teamPlayed, roster) });
  }
  const perPosition = new Map<string, number>();
  let bigGuys = 0;
  if (roster) for (const k of keep) {
    const pos = findPosition(roster, k.quote.position);
    if (pos) perPosition.set(pos.name, (perPosition.get(pos.name) ?? 0) + 1);
    if (k.quote.bigGuy) bigGuys += 1;
  }
  const hires: DraftPrice["hires"] = [];
  const hirePositions = new Set<string>();
  for (const h of input.hires) {
    const pos = roster ? findPosition(roster, h.position) : undefined;
    if (!pos) { errors.push(`${h.position} is not a ${team.race} position.`); continue; }
    if (hirePositions.has(pos.name)) { errors.push(`${pos.name} is listed twice.`); continue; }
    hirePositions.add(pos.name);
    perPosition.set(pos.name, (perPosition.get(pos.name) ?? 0) + h.count);
    if (isBigGuy(pos)) bigGuys += h.count;
    hires.push({ position: pos, count: h.count, cost: pos.cost * h.count });
  }
  if (roster) {
    for (const [name, n] of perPosition) {
      const max = roster.positions.find((p) => p.name === name)?.max ?? 16;
      if (n > max) errors.push(`At most ${max} ${name}${max === 1 ? "" : "s"} (${n} picked).`);
    }
    if (bigGuys > roster.maxBigGuys) errors.push(`At most ${roster.maxBigGuys} big guy${roster.maxBigGuys === 1 ? "" : "s"} (${bigGuys} picked).`);
  }
  const players = keep.length + hires.reduce((n, h) => n + h.count, 0);
  if (players < LIMITS.minPlayers) errors.push(`A team needs at least ${LIMITS.minPlayers} players (${players} picked).`);
  if (players > LIMITS.maxPlayers) errors.push(`A team has at most ${LIMITS.maxPlayers} players (${players} picked).`);
  const st = input.staff;
  const maxRerolls = roster?.maxReRolls ?? 8;
  if (st.rerolls > maxRerolls) errors.push(`At most ${maxRerolls} rerolls.`);
  if (st.assistantCoaches > LIMITS.assistantCoaches) errors.push(`At most ${LIMITS.assistantCoaches} assistant coaches.`);
  if (st.cheerleaders > LIMITS.cheerleaders) errors.push(`At most ${LIMITS.cheerleaders} cheerleaders.`);
  if (st.apothecary && roster && !roster.apothecaryAllowed) errors.push(`${roster.name} teams cannot hire an Apothecary.`);
  const staffCost = st.rerolls * rerollCost(roster) + st.assistantCoaches * STAFF_COST.assistantCoach + st.cheerleaders * STAFF_COST.cheerleader + (st.apothecary ? STAFF_COST.apothecary : 0);
  const spent = keep.reduce((n, k) => n + k.quote.cost, 0) + hires.reduce((n, h) => n + h.cost, 0) + staffCost;
  const budget = spendable(ctx.task);
  if (spent > budget) errors.push(`The draft costs ${gold(spent)}, over the budget of ${gold(budget)}.`);
  if (errors.length) throw new RedraftError(400, [...new Set(errors)].join(" "));
  return { keep, hires, staffCost, spent, remaining: budget - spent, players };
}

export const gold = (n: number): string => `${Math.round(n / 1000).toLocaleString("en-US")}k`;

// ---- the new roster ----

const cKey = (playerId: string): string => `c-${createHash("sha256").update(`career\0${playerId}`).digest("hex").slice(0, 12)}`;

/**
 * The next-season roster: kept players keep their profile (SPP, skills, level, career) with Rest & Relaxation applied
 * (niggles that rolled off removed, missed game cleared), season stats reset, seasonsPlayed advanced; hires are
 * rookies from the roster; staff as bought; the unspent budget is the treasury. Player ids are fresh (unique against
 * `usedIds`, which is updated).
 */
export function buildDraftTeam(ctx: DraftContext, price: DraftPrice, input: DraftInput, idCtx: { leagueId: string; slug: string }, usedIds: Set<string>): LeagueTeam {
  const { team, roster } = ctx;
  const rolls = ctx.task.rest?.rolls ?? [];
  const fresh = (number: number | null, name: string, position: string): string => {
    let ord = 0;
    let id = playerIdFor(idCtx, team.id, number, name, position, ord);
    while (usedIds.has(id)) id = playerIdFor(idCtx, team.id, number, name, position, ++ord);
    usedIds.add(id);
    return id;
  };
  const players: LeaguePlayer[] = [];
  for (const k of price.keep) {
    const p = team.players.find((x) => x.playerId === k.quote.playerId)!;
    const { seasonsPlayed: _sp, ...rest } = p;
    players.push({
      ...structuredClone(rest),
      playerId: fresh(p.number, p.name, p.position),
      careerKey: p.careerKey ?? cKey(p.playerId),
      previousIds: [...(p.previousIds ?? []), p.playerId],
      // The value that was charged (the position cost when the import had none), so the team value counts it.
      value: k.quote.value,
      niggling: nigglesAfter(p, rolls),
      missNextGame: false,
      stats: { ...EMPTY_PLAYER_STATS },
      seasonsPlayed: k.quote.seasons,
    });
  }
  const taken = new Set(players.map((p) => p.number).filter((n): n is number => typeof n === "number"));
  let next = 1;
  const nextNumber = (): number => { while (taken.has(next)) next += 1; taken.add(next); return next; };
  for (const h of price.hires) {
    for (let i = 0; i < h.count; i += 1) {
      const number = nextNumber();
      const pos = h.position;
      const id = fresh(number, "", pos.name);
      players.push({
        playerId: id, careerKey: cKey(id), number, name: "", position: pos.name,
        ma: pos.MA, st: pos.ST, ag: target(pos.AG), pa: target(pos.PA), av: target(pos.AV), skills: [...pos.skills],
        value: pos.cost, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0,
      });
    }
  }
  players.sort((a, b) => (a.number ?? 999) - (b.number ?? 999));
  const st = input.staff;
  const staffValue = st.rerolls * rerollCost(roster) + st.assistantCoaches * STAFF_COST.assistantCoach + st.cheerleaders * STAFF_COST.cheerleader + (st.apothecary ? STAFF_COST.apothecary : 0);
  const { rosterHidden: _h, playerCount: _c, ...base } = team;
  return {
    ...structuredClone(base),
    teamValue: players.reduce((n, p) => n + (p.value ?? 0), 0) + staffValue,
    treasury: price.remaining,
    rerolls: st.rerolls,
    assistantCoaches: st.assistantCoaches,
    cheerleaders: st.cheerleaders,
    apothecary: st.apothecary,
    players,
    formerPlayers: [],
  };
}

export function draftList(price: DraftPrice, input: DraftInput, team: LeagueTeam): DraftList {
  return {
    keep: price.keep.map((k) => ({ playerId: k.quote.playerId, cost: k.quote.cost })),
    hires: price.hires.map((h) => ({ position: h.position.name, count: h.count, cost: h.cost })),
    staff: { ...input.staff, cost: price.staffCost },
    spent: price.spent,
    treasury: price.remaining,
    team,
  };
}

/** Puts the draft roster into the next season (replacing a team with the same id) and lists the coach as a participant. */
export function applyDraftTeam(season: SeasonRecord, team: LeagueTeam): void {
  const i = season.teams.findIndex((t) => t.id === team.id);
  if (i >= 0) season.teams[i] = structuredClone(team); else season.teams.push(structuredClone(team));
  const named = team.name.trim().toLowerCase();
  if (!season.participants.some((p) => p.team.trim().toLowerCase() === named)) {
    season.participants.push({ coach: team.coach, ...(team.coachId ? { coachId: team.coachId } : {}), ...(team.nafUser ? { nafUser: team.nafUser } : {}), country: "", race: team.race, team: team.name, active: true });
  }
}

/** Every player id of the league (for unique fresh ids). */
export function leaguePlayerIds(seasons: SeasonRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const s of seasons) {
    for (const t of s.teams) for (const p of [...t.players, ...t.formerPlayers]) ids.add(p.playerId);
    for (const t of s.redraft?.teams ?? []) for (const p of t.draft?.team.players ?? []) ids.add(p.playerId);
  }
  return ids;
}

/**
 * Start a new season: draft lists submitted before the season existed go into it now. Mutates `next` and returns the
 * source seasons whose tasks were marked applied (the caller writes them).
 */
export function applyPendingDrafts(seasons: SeasonRecord[], next: SeasonRecord): SeasonRecord[] {
  const changed: SeasonRecord[] = [];
  for (const s of seasons) {
    if (s.number >= next.number || !s.redraft) continue;
    let touched = false;
    for (const t of s.redraft.teams) {
      if (t.status !== "submitted" || t.appliedTo || !t.draft) continue;
      const conflict = targetConflict(next, { id: t.teamId, name: t.name }, t.draft.team);
      if (conflict) { t.status = "expired"; t.expiredReason = conflict; touched = true; continue; }
      applyDraftTeam(next, t.draft.team);
      t.appliedTo = next.id;
      touched = true;
    }
    if (touched) changed.push(s);
  }
  return changed;
}

/** Same coach (trimmed, case-insensitive). */
export const sameCoach = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();

const norm = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** The league's coach alias table (account id, NAF name, display name) over every season. */
export const leagueAliases = (seasons: SeasonRecord[]): CoachAliases =>
  buildCoachAliases((function* () { for (const s of seasons) yield* seasonCoachFacets(s); })());

/**
 * Whether this signed-in account coaches the team. A recorded coachId (fork account) is authoritative. Only a team
 * with NO coachId falls back to its imported display name, and only when that name resolves through the alias table to
 * this account (seen together with it or with its verified NAF name), or stands alone and is exactly this account's name.
 */
export function coachOwnsTeam(team: { coach: string; coachId?: string; nafUser?: string }, coach: string, aliases: CoachAliases): boolean {
  if (norm(team.coachId)) return sameCoach(team.coachId, coach);
  if (!norm(coach) || !norm(team.coach)) return false;
  const teamKey = aliases.key({ coach: team.coach, ...(team.nafUser ? { nafUser: team.nafUser } : {}) });
  if (teamKey === aliases.key({ coachId: coach })) return true;
  return teamKey === `name:${norm(team.coach)}` && norm(team.coach) === norm(coach);
}

/**
 * Before a draft list goes into the next season: refused when that season already has a result for the team, or holds
 * a roster for the team that is not the one this draft list made. "" = fine, else the reason.
 */
export function targetConflict(target: SeasonRecord, team: Pick<LeagueTeam, "id" | "name">, draftTeam?: LeagueTeam): string {
  if (teamPlayedIn(target, team)) return `${target.name} already has results for ${team.name}.`;
  const locked = forkPlayLock(target, team.id);
  if (locked) return locked;
  const present = target.teams.find((t) => t.id === team.id);
  if (present && (!draftTeam || JSON.stringify(present) !== JSON.stringify(draftTeam))) return `${target.name} already has a different ${team.name} roster.`;
  return "";
}
