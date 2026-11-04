/**
 * Team page v2 (spec-team-management-2026-11-02, lane 1): the pure team operations behind the shared team summary.
 * No I/O: teamPage.ts holds the routes, permissions and writes.
 *
 *  - the lasting-injury table (INJURIES) and what each entry does to a league player;
 *  - "a player leaves" (playerLeaves): the ONE stable call that moves a player off a roster (death, firing, defection,
 *    retirement). Other lanes (the recorder's defections) call it, so its signature stays put;
 *  - missed-next-game bookkeeping (settleServedMng): an MNG set on the team page clears once the team has played its next
 *    game, whichever path recorded that game (the fork, the recorder, the fixtures editor);
 *  - roster limits (rosterLimitErrors), shared with the redraft validator's numbers (redraft.ts LIMITS);
 *  - advancement prices for in-season coaches (BB2025 table, teamAdvancement.ts ADVANCEMENT_ROWS);
 *  - the team history line format and the public view of a team (history and injury authors stay private).
 *
 * ---- Team / entry identity (shaped for the team library lane; nothing reads it yet) ----------------------------------
 *  A team belongs to a COACH, not to a league. A league tracks ENTRIES: one slot per team per season, holding that
 *  season's standings and fixtures (spec round answers: "a league tracks entries (slots) holding standings and fixtures;
 *  a swap changes the entry's team; entry history lists the teams").
 *    LeagueTeam.teamUid  "tm-<12 hex>"  the team itself. Minted fresh (random) on the team's first write; it travels ONLY
 *                                       by an explicit link: the stored field, copied by the redraft (source team ->
 *                                       draft team, redraft.ts buildDraftTeam). Season-local team ids and names never
 *                                       link two records (a renamed import or two unrelated same-named teams stay apart).
 *                                       The library lane moves teams between leagues by this uid; ownership is the team's
 *                                       seated account (identity.ts teamSeat).
 *    LeagueTeam.entryId  "en-<12 hex>"  this league season's slot, minted fresh per season (a redraft drops it so the new
 *                                       season mints its own). A swap keeps the entryId and replaces the team behind it;
 *                                       fixtures and standings keep pointing at the entry's team id until that lane
 *                                       re-points them.
 *  Both are opaque, public-safe ids (no coach names in them).
 */
import { randomBytes } from "node:crypto";
import { canonSkill, findPosition, splitCaptainGrants, type DatasetPosition, type DatasetRoster } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { CHARACTERISTIC_BEST, CHARACTERISTIC_MAX_STEPS, skillTakeBlock } from "../advancementRolls.js";
import { ADVANCEMENT_ROWS } from "../teamAdvancement.js";
import { markCaptainVacancy } from "./captain.js";
import { STAT_LIMIT } from "./forkResult.js";
import { statAdvanceOf } from "./forkTeam.js";
import { fixtureOutcome } from "./identity.js";
import { LIMITS, rerollCost, STAFF_COST } from "./redraft.js";
import { refreshTeamValue } from "./teamValue.js";
import type { FormerPlayer, LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord, TeamHistoryEntry } from "./types.js";

// ---- injuries ---------------------------------------------------------------------------------------------------------

export type InjuryKey =
  | "badly-hurt" | "seriously-hurt" | "niggling" | "head-injury" | "smashed-knee" | "broken-arm" | "neck-injury" | "dislocated-shoulder" | "dead";

export interface InjuryType {
  key: InjuryKey;
  label: string;
  /** A short description in our own words. */
  text: string;
  /** The characteristic it reduces (AG / PA / AV targets get one worse: +1; MA / ST lose one). */
  stat?: "ma" | "st" | "ag" | "pa" | "av";
  /** Adds a niggling injury. */
  niggling?: true;
  /** "always" = sets MNG (Seriously Hurt); "optional" = the organiser chooses (lasting injuries); absent = never. */
  mng?: "always" | "optional";
  /** The player leaves the roster. */
  dead?: true;
  /** Record only: no effect on the player (Badly Hurt). */
  recordOnly?: true;
}

/**
 * The lasting-injury table (BB2020 and BB2025 print the same five) plus Niggling Injury and Dead, and the two casualty
 * results organisers record without a lasting effect. Descriptions are our own wording.
 */
export const INJURIES: readonly InjuryType[] = [
  { key: "badly-hurt", label: "Badly Hurt", text: "Out for the rest of the game, nothing lasting. Recorded only.", recordOnly: true },
  { key: "seriously-hurt", label: "Seriously Hurt", text: "Misses the next game, then returns as before.", mng: "always" },
  { key: "niggling", label: "Niggling Injury", text: "An old knock that never quite heals: casualty rolls against the player get +1.", niggling: true, mng: "optional" },
  { key: "head-injury", label: "Head Injury", text: "Concussed for good: armour drops by 1 (AV −1).", stat: "av", mng: "optional" },
  { key: "smashed-knee", label: "Smashed Knee", text: "A knee that never bends right again: movement drops by 1 (MA −1).", stat: "ma", mng: "optional" },
  { key: "broken-arm", label: "Broken Arm", text: "The throwing arm is never the same: passing gets 1 worse (PA −1).", stat: "pa", mng: "optional" },
  { key: "neck-injury", label: "Neck Injury", text: "A stiff neck slows every dodge: agility gets 1 worse (AG −1).", stat: "ag", mng: "optional" },
  { key: "dislocated-shoulder", label: "Dislocated Shoulder", text: "A weak shoulder takes the edge off every block: strength drops by 1 (ST −1).", stat: "st", mng: "optional" },
  { key: "dead", label: "Dead", text: "The player dies and leaves the roster for good.", dead: true },
];

export const injuryType = (key: unknown): InjuryType | undefined => INJURIES.find((i) => i.key === key);

/** The injury table a season offers (the same for both rulesets today; the ruleset is the hook for a later difference). */
export function injuryTable(_ruleset: string): readonly InjuryType[] { return INJURIES; }

/** Applies one characteristic reduction within the fork's limits (ag / pa / av targets get worse: higher). */
export function reduceStat(p: LeaguePlayer, stat: NonNullable<InjuryType["stat"]>): { from: number | null; to: number | null } {
  const from = p[stat];
  if (from === null) return { from, to: from };
  const [min, max] = STAT_LIMIT[stat];
  const to = stat === "ma" || stat === "st" ? Math.max(from - 1, min) : stat === "av" ? Math.max(from - 1, min) : Math.min(from + 1, max);
  p[stat] = to;
  return { from, to };
}

// ---- games played -----------------------------------------------------------------------------------------------------

const playedFor = (f: LeagueFixture, teamId: string): boolean => (f.home.teamId === teamId || f.away.teamId === teamId) && fixtureOutcome(f) !== undefined;

/** Games with a result this team has in the season (a concession or forfeit counts as a game). */
export function teamGamesPlayed(season: Pick<SeasonRecord, "fixtures">, teamId: string): number {
  return season.fixtures.filter((f) => playedFor(f, teamId)).length;
}

/**
 * True when THIS team record is past its first game, judged from the record itself (never by matching ids or names in
 * other seasons): an explicit redraft link (redraftedFrom), a result on one of its own fixtures, an imported standings row with games, or any player (rostered or
 * former) carrying game counters, SPP or earlier seasons (an imported or redrafted veteran roster).
 */
export function teamHasPlayed(season: Pick<SeasonRecord, "fixtures" | "phases">, team: Pick<LeagueTeam, "id" | "players" | "formerPlayers" | "redraftedFrom">): boolean {
  // Owner rule: a redrafted team starts its new season under in-season rules, even with an all-rookie roster.
  if (team.redraftedFrom) return true;
  if (season.fixtures.some((f) => playedFor(f, team.id))) return true;
  if (season.phases.some((p) => p.standings.some((r) => r.teamId === team.id && r.played > 0))) return true;
  const used = (s: { td: number; cas: number; mvp: number; spp: number; completions: number; int: number }): boolean => s.td + s.cas + s.mvp + s.spp + s.completions + s.int > 0;
  return team.players.some((p) => used(p.stats) || p.availableSpp > 0 || (p.seasonsPlayed ?? 0) > 0) || (team.formerPlayers ?? []).some((p) => used(p.stats));
}

/** Unplayed fixtures of the team in the season (no result yet, not decided as cancelled). */
export function unplayedFixtures(season: Pick<SeasonRecord, "fixtures">, teamId: string): LeagueFixture[] {
  return season.fixtures.filter((f) => (f.home.teamId === teamId || f.away.teamId === teamId) && fixtureOutcome(f) === undefined && f.deadlineOutcome?.outcome !== "no-result");
}

/** Unplayed fixtures of an inactive team still waiting for the organiser's cancel / forfeit / leave. */
export function fixturesNeedingDecision(season: Pick<SeasonRecord, "fixtures">, team: Pick<LeagueTeam, "id" | "status">): LeagueFixture[] {
  if (team.status !== "inactive") return [];
  return unplayedFixtures(season, team.id).filter((f) => f.inactiveDecision?.teamId !== team.id);
}

// ---- missed next game -------------------------------------------------------------------------------------------------

/**
 * Clears every team-page MNG the team has served (in place): a player whose flag was set when the team had played N
 * games misses game N+1; once the team has more than N results the flag goes. Returns true when anything changed.
 * Flags the server's own result banking set (no mngGames) are left to it.
 */
export function settleServedMng(season: SeasonRecord): boolean {
  let changed = false;
  for (const team of season.teams) {
    if (!team.players.some((p) => p.mngGames !== undefined)) continue;
    const games = teamGamesPlayed(season, team.id);
    let recovered = false;
    for (const p of team.players) {
      if (p.mngGames === undefined) continue;
      if (!p.missNextGame) { delete p.mngGames; changed = true; continue; }
      if (games > p.mngGames) { p.missNextGame = false; delete p.mngGames; changed = true; recovered = true; }
    }
    // The current team value counts a player again once they no longer miss the next game.
    if (recovered) refreshTeamValue(team, season.ruleset);
  }
  return changed;
}

/** Sets (or clears) a player's MNG from the team page, remembering the game count it was set at. */
export function setMng(p: LeaguePlayer, on: boolean, gamesPlayed: number): void {
  p.missNextGame = on;
  if (on) p.mngGames = gamesPlayed; else delete p.mngGames;
}

// ---- a player leaves --------------------------------------------------------------------------------------------------

export type LeaveReason = "dead" | "fired" | "defected" | "retired";

/**
 * STABLE API (defections from the recorder lane call this): moves `playerId` off the roster into formerPlayers, keeping
 * their season stats and skills, and updates the Team Captain vacancy. In place; returns the former-player row, or
 * undefined when the player is not on the roster. `keepRecord: false` removes the player without a former row (a
 * pre-game firing of a player who never played).
 */
export function playerLeaves(team: LeagueTeam, playerId: string, _reason: LeaveReason, opts: { keepRecord?: boolean } = {}): FormerPlayer | undefined {
  const i = team.players.findIndex((p) => p.playerId === playerId);
  if (i < 0) return undefined;
  const before = { players: [...team.players], captainVacant: team.captainVacant, captainPlayerId: team.captainPlayerId };
  const [p] = team.players.splice(i, 1);
  const former: FormerPlayer = {
    playerId: p!.playerId,
    ...(p!.careerKey ? { careerKey: p!.careerKey } : {}),
    ...(p!.previousIds ? { previousIds: [...p!.previousIds] } : {}),
    name: p!.name, position: p!.position, level: p!.level, stats: { ...p!.stats },
    ...(p!.skills?.length ? { skills: [...p!.skills] } : {}),
  };
  if (opts.keepRecord !== false) team.formerPlayers = [...(team.formerPlayers ?? []), former];
  markCaptainVacancy(before, team);
  return former;
}

// ---- roster limits ----------------------------------------------------------------------------------------------------

const isBigGuy = (p: DatasetPosition | undefined): boolean => Boolean(p && /big\s*guy/i.test(p.type));

/** The dataset position of a league player (forgiving names). */
export const positionOf = (roster: DatasetRoster | undefined, position: string): DatasetPosition | undefined => (roster ? findPosition(roster, position) : undefined);

export interface LimitMetric { key: string; label: string; value: number; max: number }

/**
 * The roster's limited quantities as numbers (the redraft validator's limits: positions, big guys, players, staff, the
 * apothecary rule; the treasury as the gold missing below zero). A coach's change is refused when it raises any metric
 * that is over its limit afterwards: an already-broken roster may shrink toward legality, never grow.
 */
export function rosterLimitMetrics(team: LeagueTeam, roster: DatasetRoster | undefined): LimitMetric[] {
  const out: LimitMetric[] = [];
  if (roster) {
    const per = new Map<string, number>();
    let big = 0;
    for (const p of team.players) {
      const pos = positionOf(roster, p.position);
      if (!pos) continue;
      per.set(pos.name, (per.get(pos.name) ?? 0) + 1);
      if (isBigGuy(pos)) big += 1;
    }
    for (const pos of roster.positions) out.push({ key: `pos:${pos.name}`, label: `At most ${pos.max} ${pos.name}${pos.max === 1 ? "" : "s"}.`, value: per.get(pos.name) ?? 0, max: pos.max });
    out.push({ key: "bigGuys", label: `At most ${roster.maxBigGuys} big guy${roster.maxBigGuys === 1 ? "" : "s"}.`, value: big, max: roster.maxBigGuys });
    out.push({ key: "rerolls", label: `At most ${roster.maxReRolls} rerolls.`, value: team.rerolls ?? 0, max: roster.maxReRolls });
    out.push({ key: "apothecary", label: `${roster.name} teams cannot hire an Apothecary.`, value: team.apothecary ? 1 : 0, max: roster.apothecaryAllowed ? 1 : 0 });
  }
  out.push({ key: "players", label: `A team has at most ${LIMITS.maxPlayers} players.`, value: team.players.length, max: LIMITS.maxPlayers });
  out.push({ key: "assistantCoaches", label: `At most ${LIMITS.assistantCoaches} assistant coaches.`, value: team.assistantCoaches ?? 0, max: LIMITS.assistantCoaches });
  out.push({ key: "cheerleaders", label: `At most ${LIMITS.cheerleaders} cheerleaders.`, value: team.cheerleaders ?? 0, max: LIMITS.cheerleaders });
  out.push({ key: "overdraft", label: "Not enough gold in the treasury.", value: Math.max(0, -(team.treasury ?? 0)), max: 0 });
  return out;
}

/** The limits a change made worse: over the limit afterwards AND higher than before. */
export function worsenedLimits(before: LimitMetric[], after: LimitMetric[]): string[] {
  const was = new Map(before.map((m) => [m.key, m.value]));
  return after.filter((m) => m.value > m.max && m.value > (was.get(m.key) ?? 0)).map((m) => m.label);
}

/**
 * What breaks the roster rules (the redraft validator's limits: position maxima, big guys, at most 16 players, staff
 * limits, the apothecary rule) plus a negative treasury. `minPlayers` is reported separately (a team being built may sit
 * below 11 until it plays).
 */
export function rosterLimitErrors(team: LeagueTeam, roster: DatasetRoster | undefined): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (roster) {
    const per = new Map<string, number>();
    let big = 0;
    for (const p of team.players) {
      const pos = positionOf(roster, p.position);
      if (!pos) continue;
      per.set(pos.name, (per.get(pos.name) ?? 0) + 1);
      if (isBigGuy(pos)) big += 1;
    }
    for (const [name, n] of per) {
      const max = roster.positions.find((p) => p.name === name)?.max ?? 16;
      if (n > max) errors.push(`At most ${max} ${name}${max === 1 ? "" : "s"}.`);
    }
    if (big > roster.maxBigGuys) errors.push(`At most ${roster.maxBigGuys} big guy${roster.maxBigGuys === 1 ? "" : "s"}.`);
    if ((team.rerolls ?? 0) > roster.maxReRolls) errors.push(`At most ${roster.maxReRolls} rerolls.`);
    if (team.apothecary && !roster.apothecaryAllowed) errors.push(`${roster.name} teams cannot hire an Apothecary.`);
  }
  if (team.players.length > LIMITS.maxPlayers) errors.push(`A team has at most ${LIMITS.maxPlayers} players.`);
  if ((team.assistantCoaches ?? 0) > LIMITS.assistantCoaches) errors.push(`At most ${LIMITS.assistantCoaches} assistant coaches.`);
  if ((team.cheerleaders ?? 0) > LIMITS.cheerleaders) errors.push(`At most ${LIMITS.cheerleaders} cheerleaders.`);
  if ((team.treasury ?? 0) < 0) errors.push("Not enough gold in the treasury.");
  if (team.players.length < LIMITS.minPlayers) warnings.push(`A team needs at least ${LIMITS.minPlayers} players to play (${team.players.length} now).`);
  return { errors, warnings };
}

/** Staff prices a coach pays (BB2025): rerolls at the roster price before the first game (doubled after), the rest flat. */
export function staffPrice(key: StaffKey, roster: DatasetRoster | undefined, pregame: boolean): number {
  if (key === "rerolls") return rerollCost(roster) * (pregame ? 1 : 2);
  if (key === "assistantCoaches") return STAFF_COST.assistantCoach;
  if (key === "cheerleaders") return STAFF_COST.cheerleader;
  if (key === "apothecary") return STAFF_COST.apothecary;
  return FAN_PRICE;
}
export type StaffKey = "rerolls" | "assistantCoaches" | "cheerleaders" | "apothecary" | "fans";
export const STAFF_KEYS: readonly StaffKey[] = ["rerolls", "assistantCoaches", "cheerleaders", "apothecary", "fans"];
/** Dedicated fans bought at team creation: 1 free, up to 3 at 10k each beyond the first (BB2020 / BB2025 team drafting). */
export const FAN_PRICE = 10_000;
export const FANS_MAX_AT_CREATION = 3;

// ---- advancements (in-season coaches) ---------------------------------------------------------------------------------

export type AdvanceMethod = "chosenPrimary" | "chosenSecondary";

type Stat = "MA" | "ST" | "AG" | "PA" | "AV";
const STATS: readonly Stat[] = ["MA", "ST", "AG", "PA", "AV"];
const targetOf = (v: unknown): number | null => { const n = Number.parseInt(String(v ?? ""), 10); return Number.isFinite(n) ? n : null; };
/** The BB2025 catalogue keyed by the validator's shared skill key (canonSkill: spelling, "&" / "and", renames). */
const CATALOGUE = new Map(Object.entries(bb2025.skills).map(([name, meta]) => [canonSkill(name), { name, meta }] as const));
/** The injury table's stat reductions, by characteristic. */
const INJURY_STAT: Record<string, Stat> = Object.fromEntries(INJURIES.filter((i) => i.stat).map((i) => [i.key, i.stat!.toUpperCase() as Stat]));

/** Lasting-injury steps the team page recorded on the player, per characteristic. */
function injurySteps(p: Pick<LeaguePlayer, "injuries">): Record<Stat, number> {
  const out: Record<Stat, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  for (const i of p.injuries ?? []) { const s = INJURY_STAT[i.type]; if (s) out[s] += 1; }
  return out;
}

/** Characteristic steps above the position's printed line, with recorded lasting injuries added back (an injury never
 *  erases a gain). AG / PA are targets: lower is better. */
function inferredSteps(p: Pick<LeaguePlayer, "ma" | "st" | "ag" | "pa" | "av" | "injuries">, pos: DatasetPosition | undefined): Record<Stat, number> {
  const hurt = injurySteps(p);
  const out: Record<Stat, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  for (const stat of STATS) {
    const have = p[stat.toLowerCase() as "ma"];
    const base = pos ? targetOf(pos[stat]) : null;
    if (have === null || base === null) continue;
    const healthy = stat === "AG" || stat === "PA" ? have - hurt[stat] : have + hurt[stat];
    out[stat] = Math.max(0, stat === "AG" || stat === "PA" ? base - healthy : healthy - base);
  }
  return out;
}

/** The "+X" advancement entries on the player, per characteristic (forkTeam.ts statAdvanceOf: the one parser). */
function statEntries(skills: readonly string[]): Record<Stat, number> {
  const out: Record<Stat, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  for (const s of skills) { const c = statAdvanceOf(s); if (c) out[c] += 1; }
  return out;
}

/**
 * Advancements the player already took (the price of the next one depends on it), counted per skill and per
 * characteristic:
 *  - a skill counts when it is not printed on the position, is a selectable skill in the BB2025 catalogue (traits that
 *    results hand out, like Hatred, never count) and is not a Team Captain grant: the recorded grants, or the trait and
 *    its one free Pro found in the list itself (validator splitCaptainGrants; imported captains carry no record).
 *    Names compare by the validator's shared skill key (canonSkill), so "Hit & Run" is "Hit and Run";
 *  - a characteristic counts once per step above the position's printed value (MA / ST / AV up, AG / PA targets down)
 *    with recorded lasting injuries added back, or once per "+X" entry, whichever is larger.
 * Without a dataset position only the "+X" entries and catalogue skills can be counted.
 */
export function advancementCount(p: Pick<LeaguePlayer, "skills" | "ma" | "st" | "ag" | "pa" | "av" | "injuries"> & { captainGrants?: string[] }, pos: DatasetPosition | undefined): number {
  const printed = new Set((pos?.skills ?? []).map(canonSkill));
  const recorded = new Set((p.captainGrants ?? []).map(canonSkill));
  const { rest } = splitCaptainGrants(p.skills.filter((s) => !statAdvanceOf(s)));
  let n = 0;
  for (const s of rest) {
    const key = canonSkill(s);
    if (printed.has(key) || recorded.has(key)) continue;
    const hit = CATALOGUE.get(key);
    if (hit?.meta.category && !hit.meta.trait) n += 1;
  }
  const entries = statEntries(p.skills);
  const steps = inferredSteps(p, pos);
  for (const stat of STATS) n += Math.max(entries[stat], steps[stat]);
  return n;
}

/**
 * Writes every inferred characteristic gain that has no "+X" entry yet as an explicit "+X" entry (in place), so a later
 * injury to that characteristic can never erase the advancement. Returns the entries added.
 */
export function recordStatAdvances(p: LeaguePlayer, pos: DatasetPosition | undefined): string[] {
  const entries = statEntries(p.skills);
  const steps = inferredSteps(p, pos);
  const added: string[] = [];
  for (const stat of STATS) for (let i = entries[stat]; i < steps[stat]; i += 1) added.push(`+${stat}`);
  if (added.length) p.skills = [...p.skills, ...added];
  return added;
}

/** Characteristic improvements the player already has, per characteristic ("+X" entries or steps above the printed line,
 *  whichever is larger: the same count advancementCount uses). */
export function statAdvances(p: Pick<LeaguePlayer, "skills" | "ma" | "st" | "ag" | "pa" | "av" | "injuries">, pos: DatasetPosition | undefined): Record<Stat, number> {
  const entries = statEntries(p.skills);
  const steps = inferredSteps(p, pos);
  const out: Record<Stat, number> = { MA: 0, ST: 0, AG: 0, PA: 0, AV: 0 };
  for (const stat of STATS) out[stat] = Math.max(entries[stat], steps[stat]);
  return out;
}

/** May this characteristic improve once more (BB2025: at most twice, never past its best value; no PA line, no PA)? */
export function canImprove(p: Pick<LeaguePlayer, "skills" | "ma" | "st" | "ag" | "pa" | "av" | "injuries">, pos: DatasetPosition | undefined, stat: Stat): boolean {
  if (statAdvances(p, pos)[stat] >= CHARACTERISTIC_MAX_STEPS) return false;
  const v = p[stat.toLowerCase() as "ma"];
  if (v === null || v === undefined) return false;
  const best = CHARACTERISTIC_BEST[stat];
  return stat === "AG" || stat === "PA" ? v > best : v < best;
}

/** SPP price of the next advancement by method (null past Legend). Random and characteristic prices come from the same
 *  BB2025 table (teamAdvancement.ts ADVANCEMENT_ROWS). */
export function advanceCostOf(count: number, method: AdvancementPriceMethod): number | null {
  const row = ADVANCEMENT_ROWS[count];
  return row ? row.costs[method] : null;
}
export type AdvancementPriceMethod = "randomPrimary" | "chosenPrimary" | "chosenSecondary" | "characteristic";

/** SPP price of the next chosen skill (null past Legend). */
export function advanceCost(count: number, method: AdvanceMethod): number | null {
  const row = ADVANCEMENT_ROWS[count];
  return row ? row.costs[method] : null;
}

/** The rank the player reaches with advancement number `count` (1-based). */
export const rankAfter = (count: number): string => ADVANCEMENT_ROWS[Math.min(count, ADVANCEMENT_ROWS.length) - 1]?.rank ?? "Rookie";

/** Selectable skills by access for this player (traits, owned skills and skills the BB2025 taking restrictions forbid,
 *  advancementRolls.ts skillTakeBlock: Lethal Flight needs Right Stuff, Frenzy excludes Grab, ..., left out). */
export function skillChoices(p: Pick<LeaguePlayer, "skills">, pos: DatasetPosition | undefined): { primary: string[]; secondary: string[] } {
  const owned = new Set(p.skills.map(canonSkill));
  const have = [...p.skills, ...(pos?.skills ?? [])];
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const [name, meta] of Object.entries(bb2025.skills)) {
    if (!meta.category || meta.trait || owned.has(canonSkill(name)) || skillTakeBlock(name, have)) continue;
    if (pos?.primaryCategories.includes(meta.category)) primary.push(name);
    else if (pos?.secondaryCategories.includes(meta.category)) secondary.push(name);
  }
  return { primary: primary.sort((a, b) => a.localeCompare(b)), secondary: secondary.sort((a, b) => a.localeCompare(b)) };
}

/** Every selectable skill (organiser edit mode adds any of them). */
export function allSkills(): string[] {
  return Object.entries(bb2025.skills).filter(([, m]) => m.category && !m.trait).map(([n]) => n).sort((a, b) => a.localeCompare(b));
}

/** Gold a chosen skill adds to the player's value (BB2025: Primary 20k, Secondary 40k, Elite +10k). */
export function skillValue(skill: string, method: AdvanceMethod): number {
  const elite = bb2025.skills[skill]?.elite === true;
  return (method === "chosenSecondary" ? 40_000 : 20_000) + (elite ? 10_000 : 0);
}

// ---- identity ---------------------------------------------------------------------------------------------------------

const mint = (prefix: string): string => `${prefix}-${randomBytes(6).toString("hex")}`;

/** Mints the team's teamUid / entryId when it has none (see the module comment). In place; true when it set one. */
export function ensureTeamIdentity(team: LeagueTeam): boolean {
  let changed = false;
  if (!team.teamUid) { team.teamUid = mint("tm"); changed = true; }
  if (!team.entryId) { team.entryId = mint("en"); changed = true; }
  return changed;
}


// ---- history ----------------------------------------------------------------------------------------------------------

export const HISTORY_CAP = 300;

export function addHistory(team: LeagueTeam, entry: TeamHistoryEntry): void {
  if (!entry.changes.length) return;
  team.history = [entry, ...(team.history ?? [])].slice(0, HISTORY_CAP);
}

/** One readable line per change ("Treasury: 130k → 90k"). */
export function changeLine(c: TeamHistoryEntry["changes"][number]): string {
  if (c.from === undefined && c.to === undefined) return c.what;
  if (c.from === undefined) return `${c.what}: ${c.to}`;
  if (c.to === undefined) return `${c.what}: ${c.from} removed`;
  return `${c.what}: ${c.from} → ${c.to}`;
}

// ---- public view ------------------------------------------------------------------------------------------------------

/** The team as a public season read shows it: no history, no injury authors. Identity ids stay (opaque). */
export function publicTeam(team: LeagueTeam): LeagueTeam {
  // League registration (lane L6): the entry and library links stay with the coach and the organisers.
  const { history: _h, registrationId: _r, libraryTeamId: _l, swapRequest: _sr, takeover, entryHistory, ...base } = team;
  // Team library lane: the takeover listing without who listed it; the entry history without the replaced rosters.
  const rest: LeagueTeam = {
    ...base,
    ...(takeover ? { takeover: { id: takeover.id, since: takeover.since, ...(takeover.note ? { note: takeover.note } : {}) } } : {}),
    ...(entryHistory ? { entryHistory: entryHistory.map(({ outgoing: _o, by: _b, ...s }) => s) } : {}),
  };
  if (!rest.players.some((p) => p.pendingAdvance || p.injuries?.some((i) => i.by !== undefined))) return rest;
  return {
    ...rest,
    players: rest.players.map((x) => {
      const { pendingAdvance: _pa, ...p } = x; // an advancement roll waiting for its pick stays with the coach and organisers
      return p.injuries ? { ...p, injuries: p.injuries.map(({ by: _b, ...i }) => i) } : p;
    }),
  };
}
