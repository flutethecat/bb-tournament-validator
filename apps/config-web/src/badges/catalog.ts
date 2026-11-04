/**
 * The badge and achievement catalog (badges lane, spec-grill-round2-leftovers 11-04 item 6): DATA, so it can be edited later
 * without touching the evaluators. Each entry names an evaluator (src/badges/evaluators.ts) and its parameters.
 *
 *   kind     "badge" (the site's fixed set) or "achievement" (recorder actions and persistence, the orchestrator's drafts)
 *   scope    who earns it: a coach, a team (team milestones on the team page), or both
 *   tier     optional ladder of one family ("games" 10 / 50 / 100); each tier is its own award
 *   variant  "race": one award per race played ({race} in the name and description)
 *   status   "live" = evaluated; "needs-recorder-data" = the recorder does not capture what it needs today: shown greyed
 *            with "coming soon" and NEVER awarded
 *
 * Pure data with no node: imports (the SPA reads it for names and the greyed "coming soon" list).
 */

export type BadgeKind = "badge" | "achievement";
export type BadgeScope = "coach" | "team" | "both";
export type BadgeTier = "bronze" | "silver" | "gold";
export type BadgeStatus = "live" | "needs-recorder-data";

export interface BadgeDefinition {
  id: string;
  name: string;
  description: string;
  icon: string;
  kind: BadgeKind;
  scope: BadgeScope;
  tier?: BadgeTier;
  /** Tier family (entries of one family share it). */
  family?: string;
  evaluator: string;
  params: Record<string, number>;
  variant?: "race";
  status: BadgeStatus;
  /** needs-recorder-data: what is missing. */
  missing?: string;
}

const live = { status: "live" as const };

export const BADGE_CATALOG: readonly BadgeDefinition[] = [
  // ---- site badges -------------------------------------------------------------------------------------------------
  { id: "first-win", name: "First win", description: "Won a game.", icon: "star", kind: "badge", scope: "both", evaluator: "wins", params: { min: 1 }, ...live },
  { id: "games-10", name: "10 games", description: "Played 10 games.", icon: "medal", kind: "badge", scope: "both", tier: "bronze", family: "games", evaluator: "games", params: { min: 10 }, ...live },
  { id: "games-50", name: "50 games", description: "Played 50 games.", icon: "medal", kind: "badge", scope: "both", tier: "silver", family: "games", evaluator: "games", params: { min: 50 }, ...live },
  { id: "games-100", name: "100 games", description: "Played 100 games.", icon: "medal", kind: "badge", scope: "both", tier: "gold", family: "games", evaluator: "games", params: { min: 100 }, ...live },
  { id: "unbeaten-season", name: "Unbeaten season", description: "Finished a league season without a loss (3 games or more).", icon: "shield", kind: "badge", scope: "both", evaluator: "unbeatenSeason", params: { minGames: 3 }, ...live },
  { id: "belt-holder", name: "Belt holder", description: "Held a ladder title belt.", icon: "belt", kind: "badge", scope: "both", evaluator: "beltHolder", params: {}, ...live },
  { id: "tournament-winner", name: "Tournament winner", description: "Won a tournament.", icon: "trophy", kind: "badge", scope: "coach", evaluator: "tournamentWinner", params: {}, ...live },
  { id: "rumble-winner", name: "Rumble winner", description: "Won a ladder Rumble.", icon: "crown", kind: "badge", scope: "both", evaluator: "rumbleWinner", params: {}, ...live },
  { id: "win-streak-5", name: "5-win streak", description: "Won 5 games in a row.", icon: "fire", kind: "badge", scope: "both", evaluator: "winStreak", params: { length: 5 }, ...live },
  { id: "race", name: "{race}", description: "Played a game with {race}.", icon: "flag", kind: "badge", scope: "coach", evaluator: "racePlayed", params: {}, variant: "race", ...live },

  // ---- achievements: recorder-based (match recorder events, tabletop and Super FUMBBL) -------------------------------
  { id: "hat-trick", name: "Hat-trick", description: "3 touchdowns by one player in a game.", icon: "ball", kind: "achievement", scope: "both", evaluator: "playerTouchdowns", params: { min: 3 }, ...live },
  { id: "meat-grinder", name: "Meat Grinder", description: "3 or more casualties inflicted in one game.", icon: "skull", kind: "achievement", scope: "both", evaluator: "casualtiesInflicted", params: { min: 3 }, ...live },
  { id: "clean-sheet", name: "Clean Sheet", description: "Won without conceding a touchdown.", icon: "shield", kind: "achievement", scope: "both", evaluator: "cleanSheetWin", params: {}, ...live },
  { id: "comeback", name: "Comeback", description: "Won after trailing at half-time.", icon: "rising", kind: "achievement", scope: "both", evaluator: "comeback", params: {}, ...live },
  { id: "shutout-defence", name: "Shutout Defence", description: "Opponents scored no touchdowns in 3 games running.", icon: "wall", kind: "achievement", scope: "both", evaluator: "shutoutRun", params: { games: 3 }, ...live },
  { id: "iron-wall", name: "Iron Wall", description: "Suffered no casualties in a game.", icon: "wall", kind: "achievement", scope: "both", evaluator: "noCasualtiesSuffered", params: {}, ...live },
  {
    id: "underdog", name: "Underdog", description: "Won with a team value 300k or more below the opponent's.", icon: "rocket", kind: "achievement", scope: "both",
    evaluator: "underdog", params: { gap: 300_000 }, status: "needs-recorder-data", missing: "Each side's team value at kick-off is not stored with the result.",
  },
  { id: "nuffles-favourite", name: "Nuffle's Favourite", description: "Won a game whose kick-off weather roll showed a 1.", icon: "clover", kind: "achievement", scope: "both", evaluator: "weatherOneWin", params: {}, ...live },
  { id: "pass-master", name: "Pass Master", description: "3 completions by one player in a game.", icon: "target", kind: "achievement", scope: "both", evaluator: "playerCompletions", params: { min: 3 }, ...live },
  { id: "foul-play", name: "Foul Play", description: "2 or more successful fouls (a foul that caused a casualty) in a game.", icon: "boot", kind: "achievement", scope: "both", evaluator: "successfulFouls", params: { min: 2 }, ...live },

  // ---- achievements: persistence (leagues, ladders, tournaments) -----------------------------------------------------
  { id: "founding-coach", name: "Founding Coach", description: "Played in a league's first season.", icon: "house", kind: "achievement", scope: "coach", evaluator: "foundingCoach", params: {}, ...live },
  { id: "veteran", name: "Veteran", description: "Played 3 seasons in the same league.", icon: "scroll", kind: "achievement", scope: "coach", evaluator: "seasonsInLeague", params: { min: 3 }, ...live },
  { id: "loyalist", name: "Loyalist", description: "Played the same team across 3 seasons.", icon: "heart", kind: "achievement", scope: "both", evaluator: "teamSeasons", params: { min: 3 }, ...live },
  { id: "ever-present", name: "Ever Present", description: "Played every fixture of a league season.", icon: "calendar", kind: "achievement", scope: "both", evaluator: "everPresent", params: {}, ...live },
  { id: "ladder-climber", name: "Ladder Climber", description: "Reached number 1 on a ladder.", icon: "mountain", kind: "achievement", scope: "both", evaluator: "ladderTop", params: {}, ...live },
  { id: "long-reign", name: "Long Reign", description: "Held a belt for 4 weeks or more.", icon: "hourglass", kind: "achievement", scope: "both", evaluator: "beltReign", params: { days: 28 }, ...live },
  { id: "road-warrior", name: "Road Warrior", description: "Played in 5 tournaments.", icon: "road", kind: "achievement", scope: "coach", evaluator: "tournaments", params: { min: 5 }, ...live },
  { id: "polyglot", name: "Polyglot", description: "Played 5 different races.", icon: "globe", kind: "achievement", scope: "coach", evaluator: "races", params: { min: 5 }, ...live },
  { id: "century", name: "Century", description: "100 games on the site.", icon: "hundred", kind: "achievement", scope: "coach", evaluator: "games", params: { min: 100 }, ...live },
  { id: "club-stalwart", name: "Club Stalwart", description: "A club member for 1 year.", icon: "handshake", kind: "achievement", scope: "coach", evaluator: "clubMember", params: { days: 365 }, ...live },
];

const BY_ID = new Map(BADGE_CATALOG.map((b) => [b.id, b] as const));
export const badgeDefinition = (id: string): BadgeDefinition | undefined => BY_ID.get(id);

/** "race" + "Orc" -> the shown name / description. */
export function badgeText(def: Pick<BadgeDefinition, "name" | "description">, variant?: string): { name: string; description: string } {
  const fill = (s: string) => s.replace(/\{race\}/g, variant ?? "a race");
  return { name: fill(def.name), description: fill(def.description) };
}

export const appliesToCoach = (def: Pick<BadgeDefinition, "scope">): boolean => def.scope !== "team";
export const appliesToTeam = (def: Pick<BadgeDefinition, "scope">): boolean => def.scope !== "coach";
