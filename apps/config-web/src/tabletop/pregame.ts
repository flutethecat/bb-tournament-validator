/**
 * Tabletop pre-game sequence (lane R1): pure helpers. The route orchestration lives in api.ts.
 *
 * Order follows the BB2025 rulebook's Pre-Game Sequence, paraphrased from bloodbowlbase.ru:
 *   game_of_blood_bowl #pre-game-sequence -> #the-fans (Fan Factor = D3 + Dedicated Fans),
 *   #the-weather / #weather-table (2D6), take on journeymen (league_play #take-on-journeymen),
 *   inducements (league_play #inducements; catalogue: inducements #purchasing-inducements),
 *   Prayers to Nuffle (inducements #0-3-prayers-to-nuffle: a PURCHASED inducement, one D16 roll each, duplicates
 *   re-rolled), then #determine-kicking-team (roll-off, the winner chooses to kick or receive).
 * The rulebook grants no prayers for a TV gap: they exist only when bought, so the prayers phase is skipped
 * when neither team bought one.
 *
 * Phases a match walks through: pregame:fans -> pregame:weather -> pregame:journeymen -> pregame:inducements ->
 * pregame:prayers (only when bought) -> pregame:coin -> playing.
 *
 * Simplifications, stated: team value is the stored current team value (library) or the builder's preview /
 * roster arithmetic (saves), plus journeymen; players missing the next game are not subtracted.
 */

import { bb2025 } from "@bb/validator/dataset";
import { WEATHER_RESULTS, type Side, type TabletopEvent } from "./events.js";
import type { TabletopPlayer, TabletopTeamFile } from "./postMatch.js";

export const PREGAME_PHASES = [
  "pregame:fans", "pregame:weather", "pregame:journeymen", "pregame:inducements", "pregame:prayers", "pregame:coin",
] as const;
export type PregamePhase = (typeof PREGAME_PHASES)[number];
export type MatchPhase = PregamePhase | "playing";

export const MIN_PLAYERS = 11;
export const TREASURY_TOP_UP_CAP = 50_000;

export const PRAYERS_TO_NUFFLE = [
  "Treacherous Trapdoor", "Friends with the Ref", "Stiletto", "Iron Man", "Knuckle Dusters", "Bad Habits", "Greasy Cleats",
  "Blessing of Nuffle", "Moles Under the Pitch", "Perfect Passing", "Dazzling Catching", "Fan Interaction", "Fouling Frenzy",
  "Throw a Rock", "Under Scrutiny", "Intensive Training",
] as const;

/** Weather Table (#weather-table): 2 Sweltering Heat, 3 Very Sunny, 4-10 Perfect, 11 Pouring Rain, 12 Blizzard. */
export function weatherFor(total: number): (typeof WEATHER_RESULTS)[number] {
  if (total <= 2) return "Sweltering Heat";
  if (total === 3) return "Very Sunny";
  if (total <= 10) return "Perfect Conditions";
  if (total === 11) return "Pouring Rain";
  return "Blizzard";
}

type DatasetRoster = (typeof bb2025.rosters)[string];
type DatasetPosition = DatasetRoster["positions"][number];

export function rosterFor(file: TabletopTeamFile): DatasetRoster | undefined {
  const wantName = file.race?.trim().toLowerCase();
  const wantId = file.rosterId?.trim().toLowerCase();
  return Object.values(bb2025.rosters).find((r) => (wantName && r.name.toLowerCase() === wantName) || (wantId && r.id.toLowerCase() === wantId));
}

/** The Lineman position journeymen are taken from (QTY 0-16; the largest-quota Lineman if a roster has several). */
export function journeymanPosition(file: TabletopTeamFile): DatasetPosition | undefined {
  const linemen = (rosterFor(file)?.positions ?? []).filter((p) => p.keywords?.includes("Lineman"));
  return [...linemen].sort((a, b) => (b.max ?? 0) - (a.max ?? 0))[0];
}

export const availablePlayers = (file: { players: ReadonlyArray<{ dead: boolean; mng: boolean }> }): number =>
  file.players.filter((p) => !p.dead && !p.mng).length;

/** Journeymen to add so the team can field 11 (never above 11 available players). */
export function journeymenNeeded(file: TabletopTeamFile): number {
  return Math.max(0, MIN_PLAYERS - availablePlayers(file));
}

export function makeJourneymen(file: TabletopTeamFile, count: number): { players: TabletopPlayer[]; cost: number } | { error: string } {
  const position = journeymanPosition(file);
  if (!position) return { error: "No roster data for this team's race, so journeymen cannot be chosen." };
  let n = file.players.length;
  const players: TabletopPlayer[] = [];
  for (let i = 1; i <= count; i += 1) {
    n += 1;
    players.push({
      id: `jm-${i}`, name: `Journeyman ${position.name} ${i}`, number: n, positionId: position.id, spp: 0,
      skills: [...(position.skills ?? []), "Loner (4+)"], mng: false, niggles: 0, statLoss: {}, dead: false, journeyman: true,
    });
  }
  return { players, cost: position.cost * count };
}

// ---- inducements -------------------------------------------------------------------------------------------

export interface InducementPick { id: string; qty: number }

function specialRulesOf(file: TabletopTeamFile): string[] {
  return [...(file.specialRules ?? []), ...(rosterFor(file)?.specialRules ?? [])].map((r) => r.toLowerCase());
}

/** Roster restrictions the dataset does not encode (names per the inducements page). */
const REQUIRES_RULE: Record<string, string> = {
  mortuary_assistant: "masters of undeath",
  plague_doctor: "favoured of nurgle",
  riotous_rookies: "low cost linemen",
};

export function inducementOffer(file: TabletopTeamFile, id: string): { name: string; price: number; max: number | null } | { error: string } {
  const row = bb2025.inducements[id];
  if (!row) return { error: `Unknown inducement "${id}".` };
  if (!row.wireName || typeof row.cost !== "number") return { error: `${row.name} has a variable price and cannot be recorded here.` };
  const rules = specialRulesOf(file);
  const need = REQUIRES_RULE[id];
  if (need && !rules.includes(need)) return { error: `${row.name} is not available to this team.` };
  if (id === "wandering_apothecaries" && rosterFor(file)?.apothecaryAllowed === false) return { error: `${row.name} is not available to this team.` };
  const reduced = row.reducedSpecialRule && rules.includes(row.reducedSpecialRule.toLowerCase());
  return {
    name: row.name,
    price: reduced && typeof row.reducedCost === "number" ? row.reducedCost : row.cost,
    max: (reduced ? (row.reducedMax ?? row.max) : row.max) ?? null,
  };
}

export interface InducementPlan {
  picks: Array<{ id: string; name: string; qty: number; cost: number }>;
  total: number;
  /** Gold taken from the treasury (the favourite's whole spend; the underdog's top-up beyond its petty cash). */
  treasury: number;
  pettyCash: number;
}

/**
 * Validate one team's picks. `favourite` is the higher-CTV team (it spends from its own treasury first); the
 * lower-CTV team gets petty cash = the CTV difference + what the favourite spent, and may top up from its treasury
 * by at most 50,000. Equal CTVs: no treasury spending and no petty cash, so nothing can be bought.
 */
export function planInducements(input: {
  file: TabletopTeamFile;
  picks: readonly InducementPick[];
  role: "favourite" | "underdog" | "equal";
  tvDifference: number;
  favouriteSpent: number;
}): InducementPlan | { error: string } {
  const lines: InducementPlan["picks"] = [];
  const seen = new Set<string>();
  for (const pick of input.picks) {
    if (!pick || typeof pick.id !== "string" || !Number.isInteger(pick.qty) || pick.qty < 1) return { error: "Each pick needs an id and a whole quantity of at least 1." };
    if (seen.has(pick.id)) return { error: `${pick.id} is listed twice.` };
    seen.add(pick.id);
    const offer = inducementOffer(input.file, pick.id);
    if ("error" in offer) return offer;
    if (offer.max !== null && pick.qty > offer.max) return { error: `${offer.name}: at most ${offer.max}.` };
    lines.push({ id: pick.id, name: offer.name, qty: pick.qty, cost: offer.price * pick.qty });
  }
  const total = lines.reduce((n, l) => n + l.cost, 0);
  if (total === 0) return { picks: [], total: 0, treasury: 0, pettyCash: input.role === "underdog" ? input.tvDifference + input.favouriteSpent : 0 };
  const treasury = input.file.treasury;
  if (input.role === "equal") return { error: "Team values are equal: neither team can spend on inducements." };
  if (input.role === "favourite") {
    if (total > treasury) return { error: `The higher-value team pays from its treasury (${treasury}); these cost ${total}.` };
    return { picks: lines, total, treasury: total, pettyCash: 0 };
  }
  const pettyCash = input.tvDifference + input.favouriteSpent;
  const topUp = Math.max(0, total - pettyCash);
  const topUpLimit = Math.min(TREASURY_TOP_UP_CAP, treasury);
  if (topUp > topUpLimit) return { error: `Petty cash is ${pettyCash} and the treasury can add at most ${topUpLimit}; these cost ${total}.` };
  return { picks: lines, total, treasury: topUp, pettyCash };
}

// ---- rosters and the summary, derived from the events --------------------------------------------------------

const asPlayer = (v: unknown): TabletopPlayer | undefined =>
  v && typeof v === "object" && typeof (v as TabletopPlayer).id === "string" ? (v as TabletopPlayer) : undefined;

/** Team files with this match's journeymen added (the post-pregame rosters). */
export function overlayRosters<T extends Record<Side, TabletopTeamFile | undefined>>(teams: T, events: readonly TabletopEvent[]): T {
  const out = { ...teams };
  for (const side of ["home", "away"] as const) {
    const base = teams[side];
    if (!base) continue;
    const added = events.filter((e) => e.type === "journeyman" && e.team === side).map((e) => asPlayer(e.payload.player)).filter((p): p is TabletopPlayer => !!p);
    if (added.length) out[side] = { ...base, players: [...base.players, ...added] };
  }
  return out;
}

export function pregameSummary(events: readonly TabletopEvent[]) {
  const of = (type: string, side?: Side) => events.filter((e) => e.type === type && (side === undefined || e.team === side));
  const side = <T,>(f: (s: Side) => T): Record<Side, T> => ({ home: f("home"), away: f("away") });
  const fans = side((s) => of("fans", s)[0]?.payload);
  const weather = events.find((e) => e.type === "weather" && e.payload.pregame === true)?.payload;
  const flip = events.find((e) => e.id === "pg-coinflip");
  const choice = events.find((e) => e.id === "pg-coinchoice");
  return {
    fans: fans.home || fans.away ? fans : undefined,
    weather,
    journeymen: side((s) => of("journeyman", s).map((e) => (e.payload.player as TabletopPlayer | undefined)?.id).filter(Boolean)),
    inducements: side((s) => of("inducement", s)[0]?.payload),
    prayers: side((s) => of("prayer", s).map((e) => e.payload)),
    // {mode, call, caller, result, winner, choice?}: choice arrives with a second advance after a server flip
    coin: flip ? { ...flip.payload, winner: flip.team, ...(choice ? { choice: choice.payload.choice } : {}) } : undefined,
  };
}

/** Starting team values for the inducement step: stored/builder TV plus the journeymen taken on. */
export function teamValueWithJourneymen(file: TabletopTeamFile, journeymen: readonly TabletopPlayer[]): number | undefined {
  if (typeof file.teamValue !== "number") return undefined;
  const position = journeymanPosition(file);
  return file.teamValue + (journeymen.length && position ? position.cost * journeymen.length : 0);
}
