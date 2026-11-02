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

/** The moves Administration offers for a season (mirrors the server's canMoveStage). */
export function stageActions(s: Pick<SeasonSummary, "status" | "stage">): Array<{ stage: "setup" | "registration" | "active"; label: string; primary: boolean }> {
  const st = seasonStageOf(s);
  if (st === "setup") return [{ stage: "registration", label: "Open registration", primary: true }, { stage: "active", label: "Start season", primary: false }];
  if (st === "registration") return [{ stage: "active", label: "Start season", primary: true }, { stage: "setup", label: "Close registration", primary: false }];
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
  settings: {
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
  };
}

/** Site organisers and admins may create leagues (Q1); a test sign-in may too (its leagues are test leagues, Q13). */
export function canCreateLeague(info: { authenticated?: boolean; organizer?: boolean; admin?: boolean; authMethod?: string } | null | undefined): boolean {
  return Boolean(info?.authenticated && info.authMethod === "discord" && (info.organizer || info.admin));
}
