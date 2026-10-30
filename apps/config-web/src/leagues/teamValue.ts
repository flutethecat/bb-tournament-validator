/**
 * League team value (owner ruling 10-30): the league is the system of record. A team's value is RECOMPUTED here from
 * the stored player values plus staff after every mutation (fork result banking, redraft, import), never taken from
 * the fork's figure (the fork's teamValue is only compared, see forkResult.ts forkTeamValueDiff).
 *
 *   teamValue        = every rostered player's value (former players are not on the roster)
 *                      + rerolls x the roster's listed reroll price (not the doubled purchase price)
 *                      + assistant coaches x 10k + cheerleaders x 10k + 50k for an apothecary (only when the roster allows one)
 *   currentTeamValue = the same without the players who miss the next game.
 *
 * Dedicated fans add nothing in BB2025. A player's value is their STORED value (LeaguePlayer.value); only when it is
 * missing is it priced by the banker's fallback rules (fumbblResultBanking.ts computedPlayerValue): the position cost +
 * Primary skill 20,000 / Secondary 40,000 / Elite = that access price + 10,000 / traits free / +X characteristics from
 * CHARACTERISTIC_VALUE (teamAdvancement.ts). The prices come from the BB2025 dataset; no other price table exists here.
 *
 * Only BB2025 seasons are recomputed (the dataset is BB2025); a team whose race the dataset cannot resolve keeps its
 * value as it is.
 */
import { canonSkill, findPosition, findRoster, findSkill, type DatasetPosition, type DatasetRoster, type ForkRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { CHARACTERISTIC_VALUE } from "../teamAdvancement.js";
import { positionFor, statAdvanceOf, statDelta } from "./forkTeam.js";
import type { LeagueEventEntry, LeaguePlayer, LeagueTeam, SeasonRecord } from "./types.js";

/** BB2025 staff prices (gold). */
export const STAFF_VALUE = { assistantCoach: 10_000, cheerleader: 10_000, apothecary: 50_000 } as const;

export interface TeamValueResult {
  teamValue: number;
  currentTeamValue: number;
  /** Players (or their skills) the fallback could not price: "<name>: <reason>". Empty when every player is priced. */
  unpriced: string[];
}

/** The BB2025 dataset roster of a league race (forgiving names: "OWA", "Slann 2025"), or undefined. */
export function teamValueRoster(race: string): DatasetRoster | undefined {
  return findRoster(bb2025, race) ?? findRoster(bb2025, race.replace(/\s+(?:bb)?20\d\d$/i, ""));
}

const targetNum = (v: string): number => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

/** The dataset position a league player plays (the dataset's names, then the fork matcher's short-name rules). */
export function datasetPositionFor(roster: DatasetRoster, position: string): DatasetPosition | undefined {
  const direct = findPosition(roster, position);
  if (direct) return direct;
  const shaped = { raceName: roster.name, positions: roster.positions.map((p) => ({ name: p.name, isStar: false })) } as unknown as ForkRoster;
  const hit = positionFor(shaped, position);
  return hit ? roster.positions.find((p) => p.name === hit.name) : undefined;
}

/**
 * The banker's fallback price for a player without a stored value: position cost + chosen skills by access + stat
 * increases (the "+X" entries and any characteristic above the position's, as the fork team file writes them).
 */
export function fallbackPlayerValue(p: LeaguePlayer, roster: DatasetRoster): { value: number | undefined; unpriced: string[] } {
  const label = p.name || p.position || "A player";
  const pos = datasetPositionFor(roster, p.position);
  if (!pos) return { value: undefined, unpriced: [`${label}: the ${roster.name} roster has no "${p.position}" position`] };
  const unpriced: string[] = [];
  let value = pos.cost;
  const printed = new Set(pos.skills.map(canonSkill));
  for (const raw of p.skills) {
    if (!raw.trim() || statAdvanceOf(raw) || printed.has(canonSkill(raw))) continue;
    const meta = findSkill(bb2025, raw) ?? findSkill(bb2025, raw.replace(/\s*\([^)]*\)\s*$/, ""));
    if (meta?.trait) continue;
    if (!meta?.category) { unpriced.push(`${label}: unknown skill ${raw}`); continue; }
    const access = pos.primaryCategories.includes(meta.category) ? 20_000 : pos.secondaryCategories.includes(meta.category) ? 40_000 : undefined;
    if (access === undefined) { unpriced.push(`${label}: no access to ${raw}`); continue; }
    value += access + (meta.elite ? 10_000 : 0);
  }
  const { increases } = statDelta(p, { MA: pos.MA, ST: pos.ST, AG: targetNum(pos.AG), PA: targetNum(pos.PA), AV: targetNum(pos.AV) });
  for (const inc of increases) value += CHARACTERISTIC_VALUE[inc.slice(1) as keyof typeof CHARACTERISTIC_VALUE];
  return { value, unpriced };
}

const stored = (p: LeaguePlayer): number | undefined =>
  typeof p.value === "number" && Number.isSafeInteger(p.value) && p.value > 0 ? p.value : undefined;

/** A player's value for the team value: the stored value, else the fallback price. */
export function leaguePlayerValue(p: LeaguePlayer, roster: DatasetRoster): { value: number; unpriced: string[] } {
  const s = stored(p);
  if (s !== undefined) return { value: s, unpriced: [] };
  const f = fallbackPlayerValue(p, roster);
  return { value: f.value ?? 0, unpriced: f.unpriced };
}

/** Team value and current team value of a league team (pure). */
export function computeTeamValue(team: LeagueTeam, roster: DatasetRoster): TeamValueResult {
  let players = 0;
  let unavailable = 0;
  const unpriced: string[] = [];
  for (const p of team.players) {
    const v = leaguePlayerValue(p, roster);
    players += v.value;
    unpriced.push(...v.unpriced);
    if (p.missNextGame) unavailable += v.value;
  }
  const staff = Math.max(0, team.rerolls ?? 0) * roster.reRollCost
    + Math.max(0, team.assistantCoaches ?? 0) * STAFF_VALUE.assistantCoach
    + Math.max(0, team.cheerleaders ?? 0) * STAFF_VALUE.cheerleader
    + (team.apothecary && roster.apothecaryAllowed ? STAFF_VALUE.apothecary : 0);
  return { teamValue: players + staff, currentTeamValue: players - unavailable + staff, unpriced };
}

export interface RefreshOptions {
  /** Import: write the fallback price as the stored value of every player that has none. */
  fillStoredValues?: boolean;
  /** Time stamp of the season log entry for a team that could not be valued (default now). */
  now?: Date;
}

/**
 * Recomputes one team's teamValue / currentTeamValue in place. Returns false (and leaves the team alone) when the
 * season is not BB2025 or the dataset has no roster for the race. Mutation paths call refreshTeamValues (which also
 * logs a race the dataset cannot resolve).
 */
export function refreshTeamValue(team: LeagueTeam, ruleset: string, opts: RefreshOptions = {}): boolean {
  if (ruleset !== "BB2025") return false;
  const roster = teamValueRoster(team.race);
  if (!roster) return false;
  if (opts.fillStoredValues) {
    for (const p of team.players) {
      if (stored(p) !== undefined) continue;
      const f = fallbackPlayerValue(p, roster);
      if (f.value !== undefined) p.value = f.value;
    }
  }
  const tv = computeTeamValue(team, roster);
  team.teamValue = tv.teamValue;
  team.currentTeamValue = tv.currentTeamValue;
  return true;
}

/** The season log's cap (events.ts LOG_CAP; not imported, events.ts sits above this module). */
const SEASON_LOG_CAP = 200;

/**
 * The single refresh hook every league mutation path calls before putSeason: recomputes the named teams (all when
 * `teamIds` is omitted). Returns the ids of the teams it could not value. In a BB2025 season a team whose race the
 * dataset cannot resolve is never silent: the season log gets "Team value not recomputed for X: race not in dataset"
 * once per team (kind team-value-unresolved). Other editions are skipped by design, without a log entry.
 */
export function refreshTeamValues(season: SeasonRecord, teamIds?: readonly string[], opts: RefreshOptions = {}): string[] {
  const only = teamIds ? new Set(teamIds) : undefined;
  const skipped: string[] = [];
  for (const t of season.teams) {
    if (only && !only.has(t.id)) continue;
    if (refreshTeamValue(t, season.ruleset, opts)) continue;
    skipped.push(t.id);
    if (season.ruleset !== "BB2025") continue;
    if ((season.log ?? []).some((e) => e.kind === "team-value-unresolved" && e.teamId === t.id)) continue;
    const entry: LeagueEventEntry = {
      at: (opts.now ?? new Date()).toISOString(), by: "Super FUMBBL", kind: "team-value-unresolved", teamId: t.id,
      text: `Team value not recomputed for ${t.name}: race "${t.race}" not in dataset.`,
    };
    season.log = [entry, ...(season.log ?? [])].slice(0, SEASON_LOG_CAP);
  }
  return skipped;
}

/**
 * The fork's teamValue is a KICKOFF figure (upstream UtilTeamValue.findTeamValue, set at game start): rerolls, staff
 * and the players without a recovering injury (a missed game is written as one) PLUS dedicated fans x 10k. The
 * like-for-like league figure is therefore the team's current team value BEFORE the result is applied plus
 * dedicatedFans x 10k. Undefined when the team cannot be valued (not BB2025, or race not in the dataset).
 */
export function kickoffTeamValue(team: LeagueTeam, ruleset: string): number | undefined {
  if (ruleset !== "BB2025") return undefined;
  const roster = teamValueRoster(team.race);
  if (!roster) return undefined;
  return computeTeamValue(team, roster).currentTeamValue + Math.max(0, team.fans ?? 0) * 10_000;
}

/** "1,740k" for gold. */
export const kGold = (gold: number): string => `${Math.round(gold / 1000).toLocaleString("en-US")}k`;

/** "+40k" / "-20k" for a gold difference. */
export const signedK = (gold: number): string => `${gold > 0 ? "+" : gold < 0 ? "-" : ""}${kGold(Math.abs(gold))}`;
