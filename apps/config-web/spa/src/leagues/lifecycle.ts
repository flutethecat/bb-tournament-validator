// League lifecycle in the SPA (lane L5; server src/leagues/lifecycle.ts): the season stage label and chip tone, and the
// organiser moves Administration offers. The server is the authority on every move.

import type { SeasonSummary } from "./types";

export type SeasonStage = "setup" | "registration" | "active" | "completed";

export const SEASON_STAGE_LABEL: Readonly<Record<SeasonStage, string>> = {
  setup: "In setup",
  registration: "Registration open",
  active: "In progress",
  completed: "Finished",
};
/** design.md §5 chips: registration open = amber, in progress = amber as before, setup = muted. */
export const STAGE_TONE: Readonly<Record<SeasonStage, string>> = { setup: "muted", registration: "soon", active: "soon", completed: "muted" };

/** The stage a season summary carries; an older server's summary falls back to its status. */
export function seasonStageOf(s: Pick<SeasonSummary, "status" | "stage">): SeasonStage {
  if (s.status === "completed") return "completed";
  return s.stage === "setup" || s.stage === "registration" ? s.stage : "active";
}

/** Teams a season needs before Start season (server lifecycle.ts MIN_TEAMS_TO_START). */
export const MIN_TEAMS_TO_START = 2;

export interface StageAction { stage: "setup" | "registration" | "active"; label: string; primary: boolean; disabled?: string }

/** The moves Administration offers for a season (mirrors the server: Start season needs 2 teams; registration reopens
 *  from an active season only while no fixture has a result). `disabled` says why a move can't be made yet. */
export function stageActions(s: Pick<SeasonSummary, "status" | "stage"> & Partial<Pick<SeasonSummary, "teamCount" | "playedCount">>): StageAction[] {
  const st = seasonStageOf(s);
  const teams = s.teamCount ?? 0;
  const start: StageAction = { stage: "active", label: "Start season", primary: st === "registration",
    ...(teams < MIN_TEAMS_TO_START ? { disabled: `Start season needs at least ${MIN_TEAMS_TO_START} teams (${teams} so far).` } : {}) };
  if (st === "setup") return [{ stage: "registration", label: "Open registration", primary: true }, start];
  if (st === "registration") return [start, { stage: "setup", label: "Close registration", primary: false }];
  if (st === "active" && (s.playedCount ?? 0) === 0) return [{ stage: "registration", label: "Back to registration", primary: false }];
  return [];
}

/** The season's registration read model (GET /api/leagues/:id/seasons/:seasonId/registration). */
export interface SeasonRegistrationView {
  seasonId: string;
  stage: SeasonStage;
  stageLabel: string;
  open: boolean;
  reason?: string;
  message?: string;
  revision?: number;
  counts: { teams: number; cap: number | null; placesLeft: number | null };
  /** The league's zone: opens / closes are shown and typed in it. */
  timeZone?: string;
  settings: {
    /** Opens / closes as wall-clock times in the league's zone (what the form edits). */
    opensAtWall?: string;
    closesAtWall?: string;
    allowedRosters: { official: boolean; nafApproved: boolean; unofficial: boolean };
    allowRegistration: boolean;
    maxRegistrations: number | null;
    maxPerRace: number | null;
    opensAt?: string;
    closesAt?: string;
    approval: "auto" | "organiser";
    waitlist: boolean;
    allowExistingTeams: boolean;
    allowMidSeason: boolean;
    entryFee: string;
    /** Payment links ("" = none for this season). */
    payPal?: string;
    venmo?: string;
  };
}

/** Site organisers and admins may create leagues (Q1); a test sign-in may too (its leagues are test leagues, Q13). */
export function canCreateLeague(info: { authenticated?: boolean; organizer?: boolean; admin?: boolean; authMethod?: string } | null | undefined): boolean {
  return Boolean(info?.authenticated && info.authMethod === "discord" && (info.organizer || info.admin));
}
