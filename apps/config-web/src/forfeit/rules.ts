/**
 * Forfeit rules (spec-forfeit-and-dice-2026-11-02, Decisions): the TourPlay-style forfeit dialog, with FFB's concession
 * penalties as editable suggestions and FFB-style defection rolls in place of "Quits the team". Pure: no store, no I/O.
 *
 * FFB facts this follows (re-implemented here, not copied):
 *   - Defections happen only after an ILLEGAL concession. A concession is legal at set-up with fewer than 3 (BB2025) /
 *     at most 3 (BB2020) players who could be set up.
 *   - Each player of the conceding team with 3+ advancements rolls a D6; 1-3 = the player leaves (defects). A player who
 *     died in the game does not roll. Advancements are counted by the league's shared counter (teamOps.ts).
 *   - The conceding team gets no winnings, rolls a D3 for its fans (it can lose fans) and gets no MVP; the other team
 *     gets one extra MVP.
 */
import { teamValueRoster } from "../leagues/teamValue.js";
import type { LeaguePlayer } from "../leagues/types.js";
import { advancementCount as sharedAdvancementCount, positionOf } from "../leagues/teamOps.js";

export type ForfeitSide = "home" | "away";
export type ForfeitRuleset = "BB2020" | "BB2025";
export const FORFEIT_SIDES: readonly ForfeitSide[] = ["home", "away"];
export const other = (s: ForfeitSide): ForfeitSide => (s === "home" ? "away" : "home");

/** A D6 of 1-3 means the player leaves the team. */
export const DEFECTS_ON = (roll: number): boolean => roll >= 1 && roll <= 3;
export const DEFECTION_THRESHOLD = 3;
export const MAX_PENALTY = 99;
export const MAX_GOLD = 2_000_000;
export const MAX_FANS = 6;
export const MAX_SCORE = 99;
/** An MVP is worth 4 SPP in both rulesets. */
export const MVP_SPP = 4;

/** What eligibility needs to know about a player (a league roster player satisfies it). */
export interface ForfeitPlayerLike {
  playerId: string;
  name: string;
  number?: number | null;
  position: string;
  skills: string[];
  ma?: number | null; st?: number | null; ag?: number | null; pa?: number | null; av?: number | null;
  /** Recorded lasting injuries (a characteristic lost to one is added back when counting its advances). */
  injuries?: LeaguePlayer["injuries"];
  captainGrants?: string[];
}

/**
 * The player's advancement count for defection: the league's ONE counter (teamOps.ts advancementCount, the same the team
 * page prices advancements with): gained catalogue skills over the position's own (Team Captain grants and handed-out
 * traits never count), plus each characteristic step, counted per characteristic from the "+X" entries or the line with
 * recorded injuries added back, whichever is larger. FFB counts both rulesets this way (skills that are not
 * characteristic decreases); `ruleset` is kept for the callers and the dialog's caption.
 */
export function advancementCount(p: ForfeitPlayerLike, race: string, _ruleset: ForfeitRuleset): number {
  const pos = positionOf(teamValueRoster(race), p.position);
  return sharedAdvancementCount({ skills: p.skills.filter((x) => typeof x === "string" && x.trim()), ma: p.ma ?? null, st: p.st ?? null, ag: p.ag ?? null, pa: p.pa ?? null, av: p.av ?? null, injuries: p.injuries, ...(p.captainGrants ? { captainGrants: p.captainGrants } : {}) }, pos);
}

export interface DefectionCandidate { playerId: string; name: string; number?: number | null; advancements: number }

/** The conceding team's players who roll for defection (3+ advancements; the dead are already off the roster). */
export function defectionCandidates(players: readonly ForfeitPlayerLike[], race: string, ruleset: ForfeitRuleset): DefectionCandidate[] {
  return players
    .map((p) => ({ playerId: p.playerId, name: p.name, ...(p.number !== undefined ? { number: p.number } : {}), advancements: advancementCount(p, race, ruleset) }))
    .filter((c) => c.advancements >= DEFECTION_THRESHOLD);
}

export interface DefectionRoll extends DefectionCandidate { roll: number; leaves: boolean }

/** A legal concession by FFB's rule: at set-up, with fewer than 3 (BB2025) / at most 3 (BB2020) players able to set up. */
export const isLegalConcession = (ruleset: ForfeitRuleset, atSetup: boolean, playersAbleToSetUp: number): boolean =>
  atSetup && (ruleset === "BB2020" ? playersAbleToSetUp <= 3 : playersAbleToSetUp < 3);

/** One side's editable forfeit numbers. */
export interface ForfeitSideInput {
  /** The F marker: this team forfeited (conceded). */
  forfeit: boolean;
  score: number;
  /** Penalty points taken off this team's standings (organiser-set; only for a forfeiting team). */
  penalty: number;
  /** Winnings +/- in gold. */
  winnings: number;
  /** Dedicated Fans +/-. */
  fans: number;
  /** MVP player ids (0, 1 or 2: the winner of an illegal concession may have two). */
  mvp: string[];
  /** Players who miss the next game. */
  missNextGame: string[];
}

export interface ForfeitInput {
  home: ForfeitSideInput;
  away: ForfeitSideInput;
  /** "No effect on standings": the fixture counts nowhere in the table. */
  noStandings: boolean;
  /** The concession was legal (no defections, no FFB penalties). */
  legalConcession: boolean;
}

/** FFB's concession penalties as editable suggestions for the side(s) that forfeited (both forfeiting = both lose). */
export function suggestForfeit(forfeiting: { home: boolean; away: boolean }, legal = false): ForfeitInput & { notes: string[] } {
  const side = (s: ForfeitSide): ForfeitSideInput => {
    const mine = forfeiting[s];
    const theirs = forfeiting[other(s)];
    return {
      forfeit: mine,
      score: mine || !theirs ? 0 : 2,
      penalty: 0,
      winnings: 0,
      fans: mine && !legal ? -1 : 0,
      mvp: [],
      missNextGame: [],
    };
  };
  const one = forfeiting.home !== forfeiting.away;
  const notes = one && !legal
    ? [
      "The team that forfeited gets no winnings.",
      "It rolls a D3 for its Dedicated Fans and can lose one: -1 is suggested, change it to the roll.",
      "It gets no MVP; the other team gets one extra MVP (pick up to two).",
    ]
    : [];
  return { home: side("home"), away: side("away"), noStandings: false, legalConcession: legal, notes };
}

/** How many MVPs a side may pick: none for an illegal conceder, two for its opponent, otherwise one. */
export function mvpLimit(input: Pick<ForfeitInput, "home" | "away" | "legalConcession">, s: ForfeitSide): number {
  const one = input.home.forfeit !== input.away.forfeit;
  if (!one || input.legalConcession) return 1;
  return input[s].forfeit ? 0 : 2;
}

export class ForfeitInputError extends Error {
  constructor(message: string, readonly field?: string) { super(message); }
}

const int = (v: unknown, field: string, min: number, max: number): number => {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new ForfeitInputError(`${field} must be a whole number from ${min} to ${max}.`, field);
  return n;
};
const ids = (v: unknown, field: string, allowed: ReadonlySet<string>): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ForfeitInputError(`${field} must be a list of player ids.`, field);
  const out = [...new Set(v as string[])];
  for (const id of out) if (!allowed.has(id)) throw new ForfeitInputError(`${field}: ${id} is not on that team.`, field);
  return out;
};

/** Validate a submitted forfeit against the two rosters (player ids per side). */
export function parseForfeitInput(raw: unknown, rosters: Record<ForfeitSide, ReadonlySet<string>>): ForfeitInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ForfeitInputError("Send the forfeit as an object.");
  const b = raw as Record<string, unknown>;
  const side = (s: ForfeitSide): ForfeitSideInput => {
    const r = b[s];
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new ForfeitInputError(`${s} is required.`, s);
    const o = r as Record<string, unknown>;
    if (o.forfeit !== undefined && typeof o.forfeit !== "boolean") throw new ForfeitInputError(`${s}.forfeit must be true or false.`, `${s}.forfeit`);
    return {
      forfeit: o.forfeit === true,
      score: int(o.score, `${s}.score`, 0, MAX_SCORE),
      penalty: int(o.penalty, `${s}.penalty`, 0, MAX_PENALTY),
      winnings: int(o.winnings, `${s}.winnings`, -MAX_GOLD, MAX_GOLD),
      fans: int(o.fans, `${s}.fans`, -MAX_FANS, MAX_FANS),
      mvp: ids(o.mvp, `${s}.mvp`, rosters[s]),
      missNextGame: ids(o.missNextGame, `${s}.missNextGame`, rosters[s]),
    };
  };
  const input: ForfeitInput = {
    home: side("home"), away: side("away"),
    noStandings: b.noStandings === true,
    legalConcession: b.legalConcession === true,
  };
  if (b.noStandings !== undefined && typeof b.noStandings !== "boolean") throw new ForfeitInputError("noStandings must be true or false.", "noStandings");
  if (b.legalConcession !== undefined && typeof b.legalConcession !== "boolean") throw new ForfeitInputError("legalConcession must be true or false.", "legalConcession");
  if (!input.home.forfeit && !input.away.forfeit) throw new ForfeitInputError("Mark the team (or both teams) that forfeited.", "forfeit");
  for (const s of FORFEIT_SIDES) {
    if (input[s].penalty && !input[s].forfeit) throw new ForfeitInputError("Penalty points apply only to a team that forfeited.", `${s}.penalty`);
    const limit = mvpLimit(input, s);
    if (input[s].mvp.length > limit) throw new ForfeitInputError(limit === 0 ? "A team that forfeited gets no MVP." : `At most ${limit} MVP${limit === 1 ? "" : "s"} for this team.`, `${s}.mvp`);
  }
  if (input.home.forfeit !== input.away.forfeit) {
    const loser: ForfeitSide = input.home.forfeit ? "home" : "away";
    if (input[loser].score > input[other(loser)].score) throw new ForfeitInputError("The team that forfeited cannot have the higher score.", `${loser}.score`);
  }
  return input;
}

/** The fixture outcome a forfeit records: per side win / draw / loss (both forfeiting = both lose). */
export function forfeitOutcome(input: Pick<ForfeitInput, "home" | "away">): Record<ForfeitSide, "win" | "draw" | "loss"> {
  if (input.home.forfeit && input.away.forfeit) return { home: "loss", away: "loss" };
  return input.home.forfeit ? { home: "loss", away: "win" } : { home: "win", away: "loss" };
}
