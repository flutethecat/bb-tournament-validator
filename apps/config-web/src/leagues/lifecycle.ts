/**
 * League lifecycle (registration spec 2026-11-02 §4, lane L5): league visibility and the season stage.
 *
 *   League:  draft -> published. A draft is visible to its organisers (owner + organisers) and site admins only, on every
 *            read path (the league routes answer 404 to anyone else; the per-coach indexes skip drafts). Absent visibility
 *            = published, so every imported league stays public.
 *   Season:  setup -> registration -> active -> completed. Absent stage = derived from status (active / completed), so
 *            every imported or older season keeps its meaning. "completed" is the stored status, never a stored stage.
 *
 * Pure helpers, no I/O.
 */
import { isLeagueOrganiser } from "./store.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";

export type LeagueVisibility = "draft" | "published";
export type SeasonStage = "setup" | "registration" | "active" | "completed";
export const SEASON_STAGES: readonly SeasonStage[] = ["setup", "registration", "active", "completed"];

export const SEASON_STAGE_LABEL: Readonly<Record<SeasonStage, string>> = {
  setup: "In setup",
  registration: "Registration open",
  active: "In progress",
  completed: "Finished",
};

/** A draft league (absent visibility = published). */
export const isDraftLeague = (league: Pick<LeagueRecord, "visibility"> | undefined): boolean => league?.visibility === "draft";

export const leagueVisibility = (league: Pick<LeagueRecord, "visibility">): LeagueVisibility => (isDraftLeague(league) ? "draft" : "published");

/** The viewer may manage the league: a site admin, or its owner / an organiser. */
export function managesLeague(league: Pick<LeagueRecord, "organisers" | "owner">, viewer: { coach: string; admin?: boolean } | undefined): boolean {
  return Boolean(viewer && (viewer.admin === true || isLeagueOrganiser(league, viewer.coach)));
}

/** Published leagues are visible to everyone; a draft only to its organisers and site admins. */
export function leagueVisibleTo(league: Pick<LeagueRecord, "visibility" | "organisers" | "owner">, viewer: { coach: string; admin?: boolean } | undefined): boolean {
  return !isDraftLeague(league) || managesLeague(league, viewer);
}

/** Leagues the viewer may see (drafts dropped unless they manage them). */
export function visibleLeagues<T extends Pick<LeagueRecord, "visibility" | "organisers" | "owner">>(leagues: readonly T[], viewer: { coach: string; admin?: boolean } | undefined): T[] {
  return leagues.filter((l) => leagueVisibleTo(l, viewer));
}

/** Published leagues only: for the per-coach indexes (My leagues, schedule, awards, redraft tasks, lobby history). */
export function publishedLeagues<T extends Pick<LeagueRecord, "visibility">>(leagues: readonly T[]): T[] {
  return leagues.filter((l) => !isDraftLeague(l));
}

/** The season's stage: the stored stage while the season is not finished, else derived from the status. */
export function seasonStage(season: Pick<SeasonRecord, "status" | "stage">): SeasonStage {
  if (season.status === "completed") return "completed";
  return season.stage === "setup" || season.stage === "registration" ? season.stage : "active";
}

/**
 * Allowed organiser moves (Settings -> Administration): Open registration (setup -> registration), Start season
 * (setup | registration -> active), Close registration (registration -> setup). Finishing stays Finish season.
 */
const MOVES: Readonly<Record<SeasonStage, readonly SeasonStage[]>> = {
  setup: ["registration", "active"],
  registration: ["setup", "active"],
  active: [],
  completed: [],
};

export function canMoveStage(from: SeasonStage, to: SeasonStage): boolean {
  return MOVES[from].includes(to);
}

/** "Open registration" etc., for refusals and buttons. */
export const STAGE_ACTION_LABEL: Readonly<Record<"setup" | "registration" | "active", string>> = {
  setup: "Close registration",
  registration: "Open registration",
  active: "Start season",
};
