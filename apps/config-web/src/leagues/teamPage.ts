/**
 * Team page v2 (spec-team-management-2026-11-02 lane 1, league UX pass Q4): the shared team summary's server side.
 *
 *   GET  /api/leagues/:id/seasons/:seasonId/teams/:teamId/manage     the page's edit context (coach or organiser only)
 *   POST /api/leagues/:id/seasons/:seasonId/teams/:teamId/edit       { revision, mode: "coach" | "organiser", ops: [...] }
 *   POST /api/leagues/:id/seasons/:seasonId/teams/:teamId/status     { revision, status: "active" | "inactive", decisions? }
 *   POST /api/leagues/:id/seasons/:seasonId/teams/:teamId/fixtures   { revision, decisions?: [{ fixtureId, decision }], all? }
 *
 * Who:
 *  - mode "coach": the team's seated account (identity.ts teamSeat), within the rules. Before the team's first game in the
 *    league (judged from the team record itself: its own results, imported games, SPP counters): hire, fire (refunded), rename and renumber players, staff up and
 *    down (rerolls at the roster price, dedicated fans 1-3) within the treasury. After it: names and numbers, hiring
 *    players and staff from the treasury (never rerolls, which are locked on an active team, nor fans), and chosen
 *    Primary / Secondary skills their unspent SPP pays for, and advancement by roll (Random Primary skill, Advance
 *    Characteristic: teamAdvance.ts, ops rollAdvance / resolveAdvance, alone in their request; organisers may roll on the
 *    coach's behalf in edit mode). Validation: the redraft validator's roster limits
 *    (teamOps.ts rosterLimitErrors) and the treasury.
 *  - mode "organiser": an organiser of THIS league or a site admin. Every field: team numbers, player fields, stats,
 *    skills, SPP, value, Seasons Played, injuries (teamOps.ts INJURIES), MNG, hire and fire. Status and fixture decisions
 *    are organiser-only too. Another league's organiser, or a site organiser who does not organise this league, is a
 *    plain viewer here.
 *
 * Every write names the season revision (428 missing, 409 stale), runs synchronously from the re-read to putSeason, is
 * refused while the team's Super FUMBBL game is under way (forkPlayLock), and writes the team history. Organiser edits
 * and status changes also send the team's coach an inbox note ("An organiser updated your team") and the league's other
 * organisers the record-change note (recordChange.ts), coalesced per team (one note per burst, nothing dropped). Coach
 * self-edits are logged without notes. GET never writes (MNG settling and identity are computed on a copy). CSRF is the
 * server's (every cookie POST).
 */
import { randomBytes } from "node:crypto";
import type { DatasetRoster } from "@bb/validator";
import { rulesNotices, type RulesChangeCoalescer, type RulesNotice } from "../competition/rulesChange.js";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "./api.js";
import { STAT_LIMIT } from "./forkResult.js";
import { forkPlayLock } from "./forkTeam.js";
import { readJsonObject, requestRevision } from "./http.js";
import { fixtureOutcome, teamSeat } from "./identity.js";
import { notifyRecordChange } from "./recordChange.js";
import { datasetRoster, LIMITS } from "./redraft.js";
import { isLeagueOrganiser } from "./store.js";
import {
  addHistory, advanceCost, advancementCount, allSkills, changeLine, ensureTeamIdentity, FANS_MAX_AT_CREATION, fixturesNeedingDecision, injuryTable, injuryType,
  playerLeaves, positionOf, rankAfter, recordStatAdvances, reduceStat, rosterLimitErrors, rosterLimitMetrics, setMng, settleServedMng, skillChoices, skillValue, staffPrice, teamGamesPlayed, teamHasPlayed, worsenedLimits,
  advanceCostOf, type AdvancementPriceMethod, type InjuryType, type StaffKey,
} from "./teamOps.js";
import { refreshTeamValue } from "./teamValue.js";
import { AdvanceError, randomCategories, resolveAdvance, rollAdvance, unsavedRoll } from "./teamAdvance.js";
import { cryptoRoller } from "../dice/roller.js";
import { teamLogId, type DiceRoll } from "../dice/log.js";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueRecord, type LeagueTeam, type SeasonRecord, type TeamHistoryEntry } from "./types.js";

/** A Super FUMBBL game is scheduled, running or awaiting its result (deadlines.ts forkGamePending; copied: that module
 *  imports api.ts, which imports this one). */
function forkGamePending(f: Pick<LeagueFixture, "fork">): boolean {
  const fork = f.fork;
  if (!fork || fork.result) return false;
  if (fork.status === "scheduled" || fork.status === "in_progress") return true;
  return Boolean(fork.gameId) && fork.status !== "cancelled" && fork.status !== "launch_failed";
}

const NO_STORE = { "cache-control": "private, no-store" };
const ok = (body: unknown): LeagueApiResult => ({ status: 200, headers: NO_STORE, body });
const fail = (status: number, error: string, extra: Record<string, unknown> = {}): LeagueApiResult => ({ status, headers: NO_STORE, body: { error, ...extra } });
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
const k = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : `${Math.round(n / 1000).toLocaleString("en-US")}k`);
const shown = (v: unknown): string => (v === null || v === undefined || v === "" ? "-" : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));

export const MAX_OPS = 50;
export const BODY_MAX = 32 * 1024;
const NAME_MAX = 60;
const SKILL_MAX = 48;

// ---- roles ------------------------------------------------------------------------------------------------------------

export const isManager = (league: LeagueRecord, auth: LeagueApiIdentity | undefined): boolean => Boolean(auth && (auth.admin || isLeagueOrganiser(league, auth.coach)));
export const isTeamCoach = (team: LeagueTeam, auth: LeagueApiIdentity | undefined): boolean => Boolean(auth && same(teamSeat(team).coachId, auth.coach));

export type TeamPhase = "pregame" | "inseason";
/** Judged from this team record alone (teamOps.ts teamHasPlayed): its own results, imported games and SPP counters. */
export function teamPhase(season: SeasonRecord, team: LeagueTeam): TeamPhase { return teamHasPlayed(season, team) ? "inseason" : "pregame"; }

/** Why a coach may not edit right now ("" = may). */
export function coachBlock(season: SeasonRecord, team: LeagueTeam): string {
  if (season.status === "completed") return "This season is finished: the roster is final.";
  if (team.status === "inactive") return "This team is inactive in the league.";
  const lock = forkPlayLock(season, team.id);
  return lock || "";
}

// ---- the edit context (GET .../manage) --------------------------------------------------------------------------------

const STAFF_LABEL: Record<StaffKey, string> = { rerolls: "Rerolls", assistantCoaches: "Assistant coaches", cheerleaders: "Cheerleaders", apothecary: "Apothecary", fans: "Dedicated fans" };
const staffCount = (t: LeagueTeam, key: StaffKey): number => (key === "apothecary" ? (t.apothecary ? 1 : 0) : (t[key] ?? (key === "fans" ? 1 : 0)));
function staffBounds(key: StaffKey, roster: DatasetRoster | undefined): { min: number; max: number } {
  if (key === "rerolls") return { min: 0, max: roster?.maxReRolls ?? 8 };
  if (key === "assistantCoaches") return { min: 0, max: LIMITS.assistantCoaches };
  if (key === "cheerleaders") return { min: 0, max: LIMITS.cheerleaders };
  if (key === "apothecary") return { min: 0, max: roster && !roster.apothecaryAllowed ? 0 : 1 };
  return { min: 1, max: FANS_MAX_AT_CREATION };
}
const bigGuy = (type: string): boolean => /big\s*guy/i.test(type);
const targetNum = (v: unknown): number | null => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? n : null; };

export interface TeamPageView {
  leagueId: string;
  seasonId: string;
  revision: number;
  ruleset: string;
  role: { coach: boolean; organiser: boolean };
  phase: TeamPhase;
  gamesPlayed: number;
  coach: { block: string; rerolls: boolean; fire: boolean; staffDown: boolean; fans: boolean; advance: boolean };
  team: LeagueTeam;
  hire: {
    positions: Array<{ name: string; cost: number; max: number; count: number; ma: number; st: number; ag: number | null; pa: number | null; av: number | null; skills: string[]; bigGuy: boolean }>;
    staff: Array<{ key: StaffKey; label: string; price: number; count: number; min: number; max: number }>;
    maxBigGuys: number;
    maxPlayers: number;
  };
  limits: { errors: string[]; warnings: string[] };
  injuries: readonly InjuryType[];
  advancement: Record<string, {
    count: number; spp: number; costs: Record<AdvancementPriceMethod, number | null>; primary: string[]; secondary: string[];
    /** Primary categories a Random Primary roll may use (a legal skill left on the table). */
    randomCategories: string[];
  }>;
  /** The team's advancement dice log (random skills, characteristic rolls), newest first, coach and organisers only. */
  diceLog: DiceRoll[];
  skills?: string[];
  fixtures?: Array<{ id: string; round: number; phase: string; opponent: string; date?: string; decision?: "cancel" | "forfeit" | "leave"; pending: boolean }>;
  needDecision: number;
  history: TeamHistoryEntry[];
}

/** The dice log of a league team's advancement rolls (src/dice/log.ts): by league, season and the season-unique team id,
 *  which exist before the first write (a uid minted by a write that then fails would move the log, and an unsaved roll
 *  must be found again on the retry). */
export const teamAdvanceLogId = (leagueId: string, seasonId: string, teamId: string): string => teamLogId(`league:${leagueId}:${seasonId}:${teamId}`);
/** Every log a team's advancement rolls may sit in, oldest key first: the first build keyed it by the team's uid (or
 *  `id:<teamId>` before one existed); reads merge them so no logged roll goes missing. New rolls go to the current key. */
export function teamAdvanceLogIds(leagueId: string, seasonId: string, team: Pick<LeagueTeam, "id" | "teamUid">): string[] {
  const legacy = [...(team.teamUid ? [teamLogId(`league:${leagueId}:${team.teamUid}`)] : []), teamLogId(`league:${leagueId}:id:${team.id}`)];
  return [...legacy, teamAdvanceLogId(leagueId, seasonId, team.id)];
}
/** The team's advancement rolls from every key, oldest first. */
export function readTeamAdvanceLog(diceLog: Pick<NonNullable<LeagueApiDeps["diceLog"]>, "read">, leagueId: string, seasonId: string, team: Pick<LeagueTeam, "id" | "teamUid">): DiceRoll[] {
  const seen = new Set<string>();
  return teamAdvanceLogIds(leagueId, seasonId, team).flatMap((id) => diceLog.read(id))
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

export function teamPageView(league: LeagueRecord, stored: SeasonRecord, teamId: string, auth: LeagueApiIdentity | undefined, diceLog?: Pick<NonNullable<LeagueApiDeps["diceLog"]>, "read">): TeamPageView | undefined {
  const season = structuredClone(stored);
  settleServedMng(season);
  const team = season.teams.find((t) => t.id === teamId);
  if (!team) return undefined;
  const organiser = isManager(league, auth);
  const coach = isTeamCoach(team, auth);
  // A swap request names one of the coach's private teams: only the coach sees which (team library lane).
  if (team.swapRequest && !coach) team.swapRequest = { id: team.swapRequest.id, ref: "", by: team.swapRequest.by, at: team.swapRequest.at };
  const phase = teamPhase(season, team);
  const roster = datasetRoster(team.race);
  const pregame = phase === "pregame";
  const positions = (roster?.positions ?? []).map((p) => ({
    name: p.name, cost: p.cost, max: p.max, count: team.players.filter((x) => positionOf(roster, x.position)?.name === p.name).length,
    ma: p.MA, st: p.ST, ag: targetNum(p.AG), pa: targetNum(p.PA), av: targetNum(p.AV), skills: [...p.skills], bigGuy: bigGuy(p.type),
  }));
  const staff = (["rerolls", "assistantCoaches", "cheerleaders", "apothecary", "fans"] as StaffKey[]).map((key) => ({
    key, label: STAFF_LABEL[key], price: staffPrice(key, roster, pregame), count: staffCount(team, key), ...staffBounds(key, roster),
  }));
  const advancement: TeamPageView["advancement"] = {};
  for (const p of team.players) {
    const pos = positionOf(roster, p.position);
    const count = advancementCount(p, pos);
    advancement[p.playerId] = {
      count, spp: p.availableSpp,
      costs: { randomPrimary: advanceCostOf(count, "randomPrimary"), chosenPrimary: advanceCost(count, "chosenPrimary"), chosenSecondary: advanceCost(count, "chosenSecondary"), characteristic: advanceCostOf(count, "characteristic") },
      ...skillChoices(p, pos), randomCategories: randomCategories(p, pos),
    };
  }
  const decidable = organiser ? decidableFixtures(season, team) : [];
  return {
    leagueId: league.id, seasonId: season.id, revision: stored.revision ?? 0, ruleset: season.ruleset,
    role: { coach, organiser }, phase, gamesPlayed: teamGamesPlayed(season, teamId),
    coach: { block: coachBlock(season, team), rerolls: pregame, fire: pregame, staffDown: pregame, fans: pregame, advance: !pregame },
    team,
    hire: { positions, staff, maxBigGuys: roster?.maxBigGuys ?? 0, maxPlayers: LIMITS.maxPlayers },
    limits: rosterLimitErrors(team, roster),
    injuries: injuryTable(season.ruleset),
    advancement,
    diceLog: (diceLog ? readTeamAdvanceLog(diceLog, league.id, season.id, team) : []).slice(-50).reverse(),
    ...(organiser ? { skills: allSkills(), fixtures: decidable.map((f) => fixtureRow(f, team)) } : {}),
    needDecision: organiser ? fixturesNeedingDecision(season, team).length : 0,
    history: team.history ?? [],
  };
}

function fixtureRow(f: LeagueFixture, team: LeagueTeam): NonNullable<TeamPageView["fixtures"]>[number] {
  const opp = f.home.teamId === team.id ? f.away : f.home;
  const mine = f.inactiveDecision?.teamId === team.id ? f.inactiveDecision.decision : undefined;
  return { id: f.id, round: f.round, phase: f.phase, opponent: opp.team, ...(f.date ? { date: f.date } : {}), ...(mine ? { decision: mine } : {}), pending: forkGamePending(f) };
}

/** Our own decision's effect is still what the fixture shows (a real result or someone else's outcome replaced it). */
function decisionStands(f: LeagueFixture, team: LeagueTeam): boolean {
  const d = f.inactiveDecision;
  if (!d || d.teamId !== team.id) return false;
  if (d.decision === "forfeit") return f.resultEdit?.at === d.at && fixtureOutcome(f) !== undefined;
  if (d.decision === "cancel") return fixtureOutcome(f) === undefined && f.deadlineOutcome?.outcome === "no-result" && f.deadlineOutcome.at === d.at;
  return fixtureOutcome(f) === undefined && f.deadlineOutcome?.outcome !== "no-result";
}

/** Fixtures the organiser may decide for the team: unplayed ones, and the ones whose cancel / forfeit / leave is still
 *  ours. A fixture with a real result (played after an earlier decision) is never decidable again. */
function decidableFixtures(season: SeasonRecord, team: LeagueTeam): LeagueFixture[] {
  return season.fixtures.filter((f) => {
    if (f.home.teamId !== team.id && f.away.teamId !== team.id) return false;
    if (decisionStands(f, team)) return true;
    return fixtureOutcome(f) === undefined && f.deadlineOutcome?.outcome !== "no-result";
  });
}

// ---- ops --------------------------------------------------------------------------------------------------------------

export class OpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

type Change = TeamHistoryEntry["changes"][number];
interface OpCtx {
  season: SeasonRecord; team: LeagueTeam; roster: DatasetRoster | undefined; mode: "coach" | "organiser"; pregame: boolean; actor: string; at: string; games: number; usedIds: Set<string>;
  /** Advancement rolls (teamAdvance.ts): the site roller and the team's dice log. Absent = rolls are unavailable (503). */
  dice?: { roller: import("../dice/roller.js").Roller; logId: string; logRoll: (roll: DiceRoll) => void; readRolls: () => DiceRoll[]; rolled?: (id: string, logId: string, mark: "saved" | "void") => void };
}

const TEAM_NUMBER_FIELDS = ["treasury", "rerolls", "fans", "assistantCoaches", "cheerleaders"] as const;
const PLAYER_NUMBER_FIELDS = ["number", "ma", "st", "ag", "pa", "av", "availableSpp", "spp", "value", "seasonsPlayed", "niggling", "td", "cas", "mvp"] as const;
type PlayerNumberField = (typeof PLAYER_NUMBER_FIELDS)[number];
const PLAYER_LABEL: Record<PlayerNumberField, string> = {
  number: "number", ma: "MA", st: "ST", ag: "AG", pa: "PA", av: "AV", availableSpp: "unspent SPP", spp: "season SPP", value: "value", seasonsPlayed: "Seasons Played", niggling: "niggling injuries", td: "TD", cas: "CAS", mvp: "MVP",
};
const TEAM_LABEL: Record<string, string> = { treasury: "Treasury", rerolls: "Rerolls", fans: "Dedicated fans", assistantCoaches: "Assistant coaches", cheerleaders: "Cheerleaders", apothecary: "Apothecary", name: "Team name" };

function whole(v: unknown, min: number, max: number, what: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new OpError(400, `${what} must be a whole number from ${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}.`);
  return v;
}
function text(v: unknown, max: number, what: string, allowEmpty = false): string {
  if (typeof v !== "string") throw new OpError(400, `${what} must be text.`);
  const t = v.trim().replace(/\s+/g, " ");
  if ((!t && !allowEmpty) || t.length > max) throw new OpError(400, `${what} must be ${allowEmpty ? "at most" : "1 to"} ${max} characters.`);
  return t;
}
function playerOf(ctx: OpCtx, id: unknown): LeaguePlayer {
  const p = typeof id === "string" ? ctx.team.players.find((x) => x.playerId === id) : undefined;
  if (!p) throw new OpError(400, "That player is not on this team's roster.");
  return p;
}
const who = (p: LeaguePlayer): string => `${p.name || p.position}${p.number !== null ? ` (#${p.number})` : ""}`;
const STAT_RANGE = { ma: STAT_LIMIT.ma, st: STAT_LIMIT.st, ag: STAT_LIMIT.ag, pa: STAT_LIMIT.pa, av: STAT_LIMIT.av } as const;

function setNumber(ctx: OpCtx, p: LeaguePlayer, n: number): Change {
  if (ctx.team.players.some((x) => x !== p && x.number === n)) throw new OpError(400, `Number ${n} is already taken.`);
  const from = p.number;
  p.number = n;
  return { what: `${p.name || p.position} number`, from: shown(from), to: String(n) };
}

function nextNumber(team: LeagueTeam): number {
  const taken = new Set(team.players.map((p) => p.number));
  for (let n = 1; n <= 99; n += 1) if (!taken.has(n)) return n;
  throw new OpError(400, "No free shirt number.");
}

function newPlayerId(ctx: OpCtx): string {
  for (;;) {
    const id = `p-${randomBytes(6).toString("hex")}`;
    if (!ctx.usedIds.has(id)) { ctx.usedIds.add(id); return id; }
  }
}

function hire(ctx: OpCtx, position: unknown, pay: boolean): Change {
  const name = text(position, 60, "position");
  const pos = positionOf(ctx.roster, name);
  if (!pos) throw new OpError(400, `${name} is not a ${ctx.team.race} position.`);
  if (pay) {
    const treasury = ctx.team.treasury ?? 0;
    if (pos.cost > treasury) throw new OpError(400, `Not enough gold: ${pos.name} costs ${k(pos.cost)}, the treasury holds ${k(treasury)}.`);
    ctx.team.treasury = treasury - pos.cost;
  }
  const id = newPlayerId(ctx);
  const number = nextNumber(ctx.team);
  ctx.team.players.push({
    playerId: id, number, name: "", position: pos.name, ma: pos.MA, st: pos.ST, ag: targetNum(pos.AG), pa: targetNum(pos.PA), av: targetNum(pos.AV),
    skills: [...pos.skills], value: pos.cost, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0,
    ...(pay ? { purchasePrice: pos.cost } : {}),
  });
  return { what: `Hired ${pos.name} #${number}${pay ? ` for ${k(pos.cost)}` : ""}` };
}

function fire(ctx: OpCtx, id: unknown): Change {
  const p = playerOf(ctx, id);
  if (ctx.pregame) {
    // Before the first game the roster is still being built: the player never played and what was paid comes back
    // (coach): the recorded purchase price, else at most the position's hire price, never the current valuation.
    const base = positionOf(ctx.roster, p.position)?.cost;
    const refund = ctx.mode !== "coach" ? 0 : p.purchasePrice !== undefined ? p.purchasePrice : base === undefined ? 0 : Math.min(base, p.value ?? base);
    playerLeaves(ctx.team, p.playerId, "fired", { keepRecord: false });
    if (refund) ctx.team.treasury = (ctx.team.treasury ?? 0) + refund;
    return { what: `Removed ${who(p)}${refund ? ` (refund ${k(refund)})` : ""}` };
  }
  playerLeaves(ctx.team, p.playerId, "fired");
  return { what: `Fired ${who(p)}` };
}

function staffStep(ctx: OpCtx, keyRaw: unknown, deltaRaw: unknown): Change {
  const key = keyRaw as StaffKey;
  if (!(key in STAFF_LABEL)) throw new OpError(400, "Unknown staff line.");
  const delta = deltaRaw === 1 || deltaRaw === -1 ? deltaRaw : (() => { throw new OpError(400, "delta must be 1 or -1."); })();
  if (ctx.mode === "coach" && !ctx.pregame) {
    if (key === "rerolls") throw new OpError(403, "Rerolls can't be changed once the team has played: they are locked for the season.");
    if (key === "fans") throw new OpError(403, "Dedicated fans change only through game results once the team has played.");
    if (delta < 0) throw new OpError(403, "Sideline staff can't be sold once the team has played.");
  }
  const { min, max } = staffBounds(key, ctx.roster);
  const from = staffCount(ctx.team, key);
  const to = from + delta;
  if (to < min || to > max) throw new OpError(400, max === 0 ? `${ctx.team.race} teams cannot hire an Apothecary.` : `${STAFF_LABEL[key]}: ${min} to ${max}.`);
  // Dedicated fans: the first is free.
  const price = key === "fans" ? (delta > 0 ? (from >= 1 ? staffPrice(key, ctx.roster, true) : 0) : (to >= 1 ? staffPrice(key, ctx.roster, true) : 0)) : staffPrice(key, ctx.roster, ctx.pregame);
  const treasury = ctx.team.treasury ?? 0;
  if (delta > 0 && price > treasury) throw new OpError(400, `Not enough gold: ${STAFF_LABEL[key].toLowerCase()} cost ${k(price)}, the treasury holds ${k(treasury)}.`);
  ctx.team.treasury = treasury - delta * price;
  if (key === "apothecary") ctx.team.apothecary = to === 1; else ctx.team[key] = to;
  return { what: STAFF_LABEL[key], from: String(from), to: String(to) };
}

function advance(ctx: OpCtx, id: unknown, skillRaw: unknown, methodRaw: unknown): Change {
  const p = playerOf(ctx, id);
  const method = methodRaw === "chosenPrimary" || methodRaw === "chosenSecondary" ? methodRaw : (() => { throw new OpError(400, "method must be chosenPrimary or chosenSecondary."); })();
  if (p.pendingAdvance) throw new OpError(409, `${who(p)} has a roll waiting for a choice. Pick from it first.`);
  const skill = text(skillRaw, SKILL_MAX, "skill");
  const pos = positionOf(ctx.roster, p.position);
  if (!pos) throw new OpError(400, `${p.position} is not a ${ctx.team.race} position: it can't take advancements here.`);
  const choices = skillChoices(p, pos);
  const list = method === "chosenPrimary" ? choices.primary : choices.secondary;
  const hit = list.find((s) => s.toLowerCase() === skill.toLowerCase());
  if (!hit) throw new OpError(400, `${skill} is not a ${method === "chosenPrimary" ? "Primary" : "Secondary"} skill this player can take.`);
  const count = advancementCount(p, pos);
  const cost = advanceCost(count, method);
  if (cost === null) throw new OpError(400, "This player has taken every advancement.");
  if (p.availableSpp < cost) throw new OpError(400, `${hit} costs ${cost} SPP; ${who(p)} has ${p.availableSpp}.`);
  p.availableSpp -= cost;
  p.skills = [...p.skills, hit];
  if (typeof p.value === "number") p.value += skillValue(hit, method);
  p.level = rankAfter(count + 1);
  return { what: `${who(p)} took ${hit} (${method === "chosenPrimary" ? "Primary" : "Secondary"}, ${cost} SPP)` };
}

function injure(ctx: OpCtx, id: unknown, keyRaw: unknown, mngRaw: unknown): Change[] {
  const p = playerOf(ctx, id);
  const inj = injuryType(keyRaw);
  if (!inj) throw new OpError(400, "Unknown injury.");
  if (mngRaw !== undefined && typeof mngRaw !== "boolean") throw new OpError(400, "mng must be true or false.");
  const out: Change[] = [];
  // A characteristic gain with no "+X" entry yet is written down before the injury, so the injury can never erase it.
  if (inj.stat) for (const e of recordStatAdvances(p, positionOf(ctx.roster, p.position))) out.push({ what: `${who(p)} advancement recorded`, to: e });
  p.injuries = [...(p.injuries ?? []), { type: inj.key, at: ctx.at, by: ctx.actor }];
  if (inj.dead) {
    playerLeaves(ctx.team, p.playerId, "dead");
    return [{ what: `${who(p)}: Dead (left the roster)` }];
  }
  out.push({ what: `${who(p)}: ${inj.label}` });
  if (inj.stat) {
    const r = reduceStat(p, inj.stat);
    out.push({ what: `${who(p)} ${inj.stat.toUpperCase()}`, from: shown(r.from), to: shown(r.to) });
  }
  if (inj.niggling) { p.niggling = (p.niggling || 0) + 1; out.push({ what: `${who(p)} niggling injuries`, from: String(p.niggling - 1), to: String(p.niggling) }); }
  const mng = inj.mng === "always" || (inj.mng === "optional" && mngRaw === true);
  if (mng && !p.missNextGame) { setMng(p, true, ctx.games); out.push({ what: `${who(p)} misses the next game` }); }
  return out;
}

function playerField(ctx: OpCtx, id: unknown, field: unknown, value: unknown): Change {
  const p = playerOf(ctx, id);
  if (field === "name") {
    const to = text(value, NAME_MAX, "Player name", true);
    const from = p.name;
    p.name = to;
    return { what: `${from || p.position} name`, from: shown(from), to: shown(to) };
  }
  if (field === "missNextGame") {
    if (typeof value !== "boolean") throw new OpError(400, "missNextGame must be true or false.");
    const from = p.missNextGame;
    setMng(p, value, ctx.games);
    return { what: `${who(p)} misses next game`, from: shown(from), to: shown(value) };
  }
  if (field === "level") {
    const to = text(value, 30, "Level");
    const from = p.level;
    p.level = to;
    return { what: `${who(p)} level`, from: shown(from), to };
  }
  if (!(PLAYER_NUMBER_FIELDS as readonly unknown[]).includes(field)) throw new OpError(400, "Unknown player field.");
  const f = field as PlayerNumberField;
  if (f === "number") return setNumber(ctx, p, whole(value, 1, 99, "Number"));
  if (ctx.mode === "coach") throw new OpError(403, "Coaches change names and numbers; organisers change the rest.");
  if (f in STAT_RANGE) {
    const [min, max] = STAT_RANGE[f as keyof typeof STAT_RANGE];
    const to = whole(value, min, max, PLAYER_LABEL[f]);
    const from = p[f as keyof typeof STAT_RANGE];
    p[f as keyof typeof STAT_RANGE] = to;
    return { what: `${who(p)} ${PLAYER_LABEL[f]}`, from: shown(from), to: String(to) };
  }
  const max = f === "value" ? 5_000_000 : f === "seasonsPlayed" ? 99 : f === "niggling" ? 9 : 9999;
  const to = whole(value, 0, max, PLAYER_LABEL[f]);
  let from: number | null;
  if (f === "td" || f === "cas" || f === "mvp" || f === "spp") { from = p.stats[f]; p.stats[f] = to; }
  else if (f === "value") { from = p.value; p.value = to; }
  else if (f === "seasonsPlayed") { from = p.seasonsPlayed ?? 0; p.seasonsPlayed = to; }
  else { from = p[f]; p[f] = to; }
  return { what: `${who(p)} ${PLAYER_LABEL[f]}`, from: f === "value" ? k(from) : shown(from), to: f === "value" ? k(to) : String(to) };
}

function teamField(ctx: OpCtx, field: unknown, value: unknown): Change {
  if (field === "apothecary") {
    if (typeof value !== "boolean") throw new OpError(400, "apothecary must be true or false.");
    const from = ctx.team.apothecary;
    ctx.team.apothecary = value;
    return { what: TEAM_LABEL.apothecary!, from: shown(from), to: shown(value) };
  }
  if (field === "name") {
    const to = text(value, NAME_MAX, "Team name");
    const from = ctx.team.name;
    if (to === from) return { what: TEAM_LABEL.name!, from, to };
    renameTeam(ctx.season, ctx.team, to);
    return { what: TEAM_LABEL.name!, from, to };
  }
  if (!(TEAM_NUMBER_FIELDS as readonly unknown[]).includes(field)) throw new OpError(400, "Unknown team field.");
  const f = field as (typeof TEAM_NUMBER_FIELDS)[number];
  const to = whole(value, f === "treasury" ? -10_000_000 : 0, f === "treasury" ? 10_000_000 : 99, TEAM_LABEL[f]!);
  const from = ctx.team[f];
  ctx.team[f] = to;
  return { what: TEAM_LABEL[f]!, from: f === "treasury" ? k(from) : shown(from), to: f === "treasury" ? k(to) : String(to) };
}

/** A team rename reaches its fixture sides and its participant row (fixtures and standings show the season's name). */
function renameTeam(season: SeasonRecord, team: LeagueTeam, to: string): void {
  const from = team.name;
  for (const p of season.participants) if (p.teamId === team.id || (p.team.trim().toLowerCase() === from.trim().toLowerCase() && same(p.coach, team.coach))) p.team = to;
  for (const f of season.fixtures) for (const side of [f.home, f.away]) if (side.teamId === team.id) side.team = to;
  team.name = to;
}

function skillOp(ctx: OpCtx, id: unknown, skillRaw: unknown, add: boolean): Change {
  const p = playerOf(ctx, id);
  const skill = text(skillRaw, SKILL_MAX, "skill");
  if (add) {
    if (p.skills.some((s) => s.toLowerCase() === skill.toLowerCase())) throw new OpError(400, `${who(p)} already has ${skill}.`);
    const known = allSkills().find((s) => s.toLowerCase() === skill.toLowerCase());
    p.skills = [...p.skills, known ?? skill];
    return { what: `${who(p)} skill added`, to: known ?? skill };
  }
  const at = p.skills.findIndex((s) => s.toLowerCase() === skill.toLowerCase());
  if (at < 0) throw new OpError(400, `${who(p)} has no ${skill}.`);
  const [gone] = p.skills.splice(at, 1);
  return { what: `${who(p)} skill removed`, from: gone };
}

/** Applies one op (throws OpError); returns the history lines. Coach ops check the phase here. */
export function applyOp(ctx: OpCtx, raw: unknown): Change[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new OpError(400, "Each op must be an object.");
  const o = raw as Record<string, unknown>;
  const coach = ctx.mode === "coach";
  switch (o.op) {
    case "player":
      if (coach && o.field !== "name" && o.field !== "number") throw new OpError(403, "Coaches change player names and numbers only.");
      return [playerField(ctx, o.playerId, o.field, o.value)];
    case "hire":
      return [hire(ctx, o.position, coach)];
    case "fire":
      if (coach && !ctx.pregame) throw new OpError(403, "Players are fired before the team's first game; after it, ask an organiser.");
      return [fire(ctx, o.playerId)];
    case "staff":
      if (!coach) throw new OpError(400, "Organisers set staff numbers directly (op team).");
      return [staffStep(ctx, o.key, o.delta)];
    case "advance":
      if (!coach) throw new OpError(400, "Organisers add skills directly (op addSkill).");
      if (ctx.pregame) throw new OpError(403, "Advancements come from SPP earned in games.");
      {
        // a logged roll that never reached the season binds the player: restore (or void) it first by rolling again
        const p = ctx.team.players.find((x) => x.playerId === o.playerId);
        if (p && ctx.dice && unsavedRoll(ctx.dice.readRolls(), p)) throw new OpError(409, "An earlier advancement roll for this player was never saved. Roll again to restore it before taking another advancement.");
      }
      return [advance(ctx, o.playerId, o.skill, o.method)];
    case "rollAdvance":
    case "resolveAdvance": {
      if (coach && ctx.pregame) throw new OpError(403, "Advancements come from SPP earned in games.");
      if (!ctx.dice) throw new OpError(503, "Advancement rolls are unavailable on this server right now.");
      try {
        const actx = { team: ctx.team, roster: ctx.roster, mode: ctx.mode, actor: ctx.actor, at: ctx.at, ...ctx.dice };
        return o.op === "rollAdvance" ? rollAdvance(actx, o) : resolveAdvance(actx, o);
      } catch (e) {
        if (e instanceof AdvanceError) throw new OpError(e.status, e.message);
        throw e;
      }
    }
    case "team":
      if (coach) throw new OpError(403, "Only organisers change team numbers directly.");
      return [teamField(ctx, o.field, o.value)];
    case "addSkill":
    case "removeSkill":
      if (coach) throw new OpError(403, "Only organisers add or remove skills directly.");
      return [skillOp(ctx, o.playerId, o.skill, o.op === "addSkill")];
    case "injury":
      if (coach) throw new OpError(403, "Only organisers record injuries.");
      return injure(ctx, o.playerId, o.injury, o.mng);
    default:
      throw new OpError(400, "Unknown op.");
  }
}

// ---- notices ----------------------------------------------------------------------------------------------------------

const teamLink = (leagueId: string, seasonId: string, teamId: string): string =>
  `/app/leagues/${encodeURIComponent(leagueId)}?season=${encodeURIComponent(seasonId)}&tab=participants&team=${encodeURIComponent(teamId)}`;

/**
 * The team's coach gets "An organiser updated your team"; the other organisers the record-change note. Coalesced per team
 * (RulesChangeCoalescer: the first change goes at once, a burst within the window joins one combined note).
 */
function sendTeamNotices(league: LeagueRecord, season: SeasonRecord, team: LeagueTeam, actor: string, lines: string[], deps: LeagueApiDeps): void {
  if (!lines.length || !deps.notify) return;
  const coalescer: RulesChangeCoalescer = deps.teamNotices ?? rulesNotices;
  const notice: RulesNotice = { message: "", diff: lines, afterStart: false, actor };
  const coachId = teamSeat(team).coachId;
  const link = teamLink(league.id, season.id, team.id);
  const teamName = team.name;
  coalescer.submit(`team:${league.id}:${season.id}:${team.id}`, notice, (n) => {
    const body = n.diff.slice(0, 30).map((l) => `- ${l}`).join("\n") + (n.diff.length > 30 ? `\n- and ${n.diff.length - 30} more` : "");
    if (coachId && !same(coachId, n.actor)) {
      try { deps.notify?.(coachId, { type: "league-broadcast", title: "An organiser updated your team", body: `${n.actor} changed ${teamName} in ${league.name}:\n${body}`, link, from: n.actor, subject: league.name }); } catch { /* fire-and-forget */ }
    }
    notifyRecordChange(league, n.actor, { title: `${league.name}: ${teamName} was changed`, body: `${n.actor} changed ${teamName}:\n${body}`, link }, deps.notify);
  });
}

// ---- fixture decisions ------------------------------------------------------------------------------------------------

export type FixtureDecision = "cancel" | "forfeit" | "leave";
const DECISIONS: readonly FixtureDecision[] = ["cancel", "forfeit", "leave"];
const DECISION_TEXT: Record<FixtureDecision, string> = { cancel: "cancelled", forfeit: "forfeited", leave: "left scheduled" };

/** Undoes our own earlier cancel / forfeit on the fixture (never a real result). */
function undoDecision(f: LeagueFixture, team: LeagueTeam): boolean {
  const d = f.inactiveDecision;
  if (!d || d.teamId !== team.id) return false;
  let standings = false;
  if (d.decision === "cancel" && f.deadlineOutcome?.outcome === "no-result" && f.deadlineOutcome.at === d.at) delete f.deadlineOutcome;
  if (d.decision === "forfeit" && f.resultEdit?.at === d.at) {
    for (const s of [f.home, f.away]) { s.score = null; s.cas = null; s.conceded = false; }
    delete f.resultEdit;
    standings = true;
  }
  delete f.inactiveDecision;
  return standings;
}

/** Applies the decisions IN PLACE; returns the history lines and whether results changed. Throws OpError. */
export function applyDecisions(season: SeasonRecord, team: LeagueTeam, decisions: Array<{ fixtureId: string; decision: FixtureDecision }>, actor: string, at: string): { changes: Change[]; standings: boolean } {
  const allowed = new Map(decidableFixtures(season, team).map((f) => [f.id, f]));
  const changes: Change[] = [];
  let standings = false;
  for (const { fixtureId, decision } of decisions) {
    const f = allowed.get(fixtureId);
    const own = season.fixtures.find((x) => x.id === fixtureId && (x.home.teamId === team.id || x.away.teamId === team.id));
    if (!f && own && fixtureOutcome(own) !== undefined) throw new OpError(409, "That fixture already has a result: it can't be cancelled or forfeited.");
    if (!f) throw new OpError(400, "That fixture is not an unplayed fixture of this team.");
    if (forkGamePending(f)) throw new OpError(409, "A Super FUMBBL game is under way for one of these fixtures.");
    if (f.inactiveDecision?.teamId === team.id && f.inactiveDecision.decision === decision) continue;
    if (undoDecision(f, team)) standings = true;
    const opp = f.home.teamId === team.id ? f.away : f.home;
    f.inactiveDecision = { teamId: team.id, decision, by: actor, at };
    if (decision === "cancel") f.deadlineOutcome = { outcome: "no-result", by: actor, at };
    if (decision === "forfeit") {
      const mine = f.home.teamId === team.id ? f.home : f.away;
      f.home.score = 0; f.away.score = 0; f.home.cas = null; f.away.cas = null;
      opp.conceded = false; mine.conceded = true;
      f.resultEdit = { by: actor, at };
      standings = true;
    }
    changes.push({ what: `Round ${f.round} vs ${opp.team}: ${DECISION_TEXT[decision]}` });
  }
  return { changes, standings };
}

function parseDecisions(input: Record<string, unknown>, season: SeasonRecord, team: LeagueTeam): Array<{ fixtureId: string; decision: FixtureDecision }> {
  if (input.all !== undefined) {
    if (!DECISIONS.includes(input.all as FixtureDecision)) throw new OpError(400, 'all must be "cancel", "forfeit" or "leave".');
    // Bulk: every fixture still waiting for a decision.
    return fixturesNeedingDecision(season, team).map((f) => ({ fixtureId: f.id, decision: input.all as FixtureDecision }));
  }
  const raw = input.decisions ?? [];
  if (!Array.isArray(raw) || raw.length > 200) throw new OpError(400, "decisions must be a list.");
  return raw.map((d) => {
    const r = (d ?? {}) as Record<string, unknown>;
    if (typeof r.fixtureId !== "string" || !DECISIONS.includes(r.decision as FixtureDecision)) throw new OpError(400, 'Each decision needs a fixtureId and "cancel", "forfeit" or "leave".');
    return { fixtureId: r.fixtureId, decision: r.decision as FixtureDecision };
  });
}

// ---- routes -----------------------------------------------------------------------------------------------------------

export async function teamPageRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, teamId, action, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "teams" || !teamId || more.length) return undefined;
  if (action !== "manage" && action !== "edit" && action !== "status" && action !== "fixtures") return undefined;
  const read = method === "GET" || method === "HEAD";
  if (action === "manage" ? !read : method !== "POST") return fail(405, action === "manage" ? "Use GET." : "Use POST.");
  if (!auth) return fail(401, "Sign in to manage this team.");
  if (!league) return fail(404, "League not found.");

  if (read) {
    const season = deps.store.season(league.id, seasonId);
    const team = season?.teams.find((t) => t.id === teamId);
    if (!season || !team) return fail(404, "Team not found.");
    if (!isManager(league, auth) && !isTeamCoach(team, auth)) return fail(403, "Only this team's coach and the league's organisers can manage it.");
    return ok({ view: teamPageView(league, season, teamId, auth, deps.diceLog) });
  }

  const body = await readJsonObject(deps, BODY_MAX);
  if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
  const input = body.value;
  // Judged against the league and season as they are now (after the body arrived); synchronous from here to the write.
  const lg = deps.store.league(league.id);
  if (!lg) return fail(404, "League not found.");
  const season = deps.store.season(lg.id, seasonId);
  const team = season?.teams.find((t) => t.id === teamId);
  if (!season || !team) return fail(404, "Team not found.");
  const organiser = isManager(lg, auth);
  const coach = isTeamCoach(team, auth);
  const mode = action === "edit" ? input.mode : "organiser";
  if (mode !== "coach" && mode !== "organiser") return fail(400, 'mode must be "coach" or "organiser".', { field: "mode" });
  if (mode === "organiser" && !organiser) return fail(403, "Only this league's organisers and site admins can use edit mode.");
  if (mode === "coach" && !coach) return fail(403, "Only this team's coach can edit it within the rules.");
  const current = season.revision ?? 0;
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") return fail(428, "Send the season revision you loaded (revision or If-Match).", { revision: current });
  if (asked === "bad") return fail(400, "revision must be a whole number.", { field: "revision" });
  if (asked !== current) return fail(409, "This team changed since you opened it. Reload to see the latest.", { revision: current });
  const locked = forkPlayLock(season, team.id);
  if (locked) return fail(409, locked);

  const at = (deps.now?.() ?? new Date()).toISOString();
  const before = structuredClone(team);
  settleServedMng(season);
  ensureTeamIdentity(team);
  let changes: Change[] = [];
  /** The advancement roll this request stored: marked saved in the dice log once the season is written. */
  let savedRoll: { logId: string; id: string; mark: "saved" | "void" } | undefined;
  let kind: TeamHistoryEntry["kind"] = mode === "coach" ? "coach-edit" : "organiser-edit";
  try {
    if (action === "edit") {
      if (mode === "coach") { const why = coachBlock(season, team); if (why) return fail(409, why); }
      if (!Array.isArray(input.ops) || !input.ops.length || input.ops.length > MAX_OPS) return fail(400, `ops must be a list of 1 to ${MAX_OPS} changes.`, { field: "ops" });
      const pregame = teamPhase(season, team) === "pregame";
      const usedIds = new Set(deps.store.seasons(lg.id).flatMap((s) => s.teams.flatMap((t) => [...t.players, ...t.formerPlayers].map((p) => p.playerId))));
      // An advancement roll is a request of its own: its dice are logged before the season is saved, so nothing else may
      // ride along and fail after it.
      const rolls = input.ops.filter((o: unknown) => o && typeof o === "object" && ["rollAdvance", "resolveAdvance"].includes(String((o as Record<string, unknown>).op)));
      if (rolls.length && input.ops.length !== 1) return fail(400, "An advancement roll or pick goes in a request of its own.", { field: "ops" });
      if (rolls.length) kind = "advancement";
      const diceLog = deps.diceLog;
      const logId = teamAdvanceLogId(lg.id, season.id, team.id);
      const dice = diceLog ? {
        roller: deps.roller ?? cryptoRoller, logId,
        logRoll: (r: DiceRoll) => { try { diceLog.appendRoll(r); } catch { throw new OpError(500, "The roll could not be logged, so it was not made. Try again."); } },
        readRolls: () => readTeamAdvanceLog(diceLog, lg.id, season.id, team),
        rolled: (id: string, rollLog: string, mark: "saved" | "void") => { savedRoll = { logId: rollLog, id, mark }; },
      } : undefined;
      const ctx: OpCtx = { season, team, roster: datasetRoster(team.race), mode, pregame, actor: auth.coach, at, games: teamGamesPlayed(season, team.id), usedIds, ...(dice ? { dice } : {}) };
      const limitsBefore = rosterLimitMetrics(before, ctx.roster);
      for (const op of input.ops) changes.push(...applyOp(ctx, op));
      if (mode === "coach") {
        // Counts, not messages: a roster already over a limit may move toward it, never further past it.
        const worse = worsenedLimits(limitsBefore, rosterLimitMetrics(team, ctx.roster));
        if (worse.length) return fail(400, worse.join(" "), { revision: current });
      }
    } else if (action === "status") {
      if (input.status !== "active" && input.status !== "inactive") return fail(400, 'status must be "active" or "inactive".', { field: "status" });
      kind = "status";
      const was = team.status === "inactive" ? "Inactive" : "Active";
      const now = input.status === "inactive" ? "Inactive" : "Active";
      if (was !== now) {
        if (input.status === "inactive") team.status = "inactive"; else delete team.status;
        team.statusChanged = { by: auth.coach, at };
        changes.push({ what: "Status", from: was, to: now });
      }
      if (input.status === "inactive" && (input.decisions !== undefined || input.all !== undefined)) {
        const d = applyDecisions(season, team, parseDecisions(input, season, team), auth.coach, at);
        changes.push(...d.changes);
        if (d.standings) season.resultsChangedAt = at;
      }
    } else {
      kind = "fixture-decision";
      if (team.status !== "inactive") return fail(409, "Fixture decisions are for an inactive team.");
      const d = applyDecisions(season, team, parseDecisions(input, season, team), auth.coach, at);
      changes = d.changes;
      if (d.standings) season.resultsChangedAt = at;
    }
  } catch (e) {
    if (e instanceof OpError) return fail(e.status, e.message, { revision: current });
    throw e;
  }
  // A forfeit is a game for both sides: the MNG it serves is cleared in the stored season too (values refreshed).
  settleServedMng(season);
  refreshTeamValue(team, season.ruleset);
  addHistory(team, { at, by: auth.coach, kind, changes });
  try {
    deps.store.putSeason(season);
  } catch {
    return fail(500, "Could not save the team right now.");
  }
  // The roll is in the season now: mark it saved in the log (best effort; the season's advanceRolls also says so).
  if (savedRoll) { try { deps.diceLog?.appendChoice(savedRoll.logId, savedRoll.id, { index: 0, face: savedRoll.mark, by: auth.coach, at }); } catch { /* the season record suffices */ } }
  if (kind !== "coach-edit" && !(kind === "advancement" && mode === "coach")) sendTeamNotices(lg, season, team, auth.coach, changes.map(changeLine), deps);
  const saved = deps.store.season(lg.id, season.id) ?? season;
  return ok({ ok: true, revision: saved.revision ?? 0, view: teamPageView(lg, saved, team.id, auth, deps.diceLog) });
}
