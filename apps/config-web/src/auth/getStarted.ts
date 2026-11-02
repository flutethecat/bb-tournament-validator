// "Get started" panel on the coach page (spec-registration-creation-flows 11-02 §3, lane L1): four next steps for a new
// coach. GET /api/me/get-started answers which are done (derived from the stores on every read, never stored) and whether
// the coach hid the panel; POST { hidden: boolean } remembers the Hide button on the coach's own identity record
// (profile.getStartedHidden = when). Own data only: the session coach, never a name from the request.
//
// Done rules (derived):
//   league     = on any league team or participant row (contactFor.ts leaguesOf; a pending league registration joins
//                this once self-service league registration exists)
//   tournament = any tournament entry, in any tournament
//   team       = any Roster Builder save or fork library team
//   organiser  = site organiser or admin level
// The panel shows while it is not hidden and not every step is done.

import { leaguesOf, type MembershipSources } from "./contactFor.js";
import { normalizeFfbCoachId, ownIdentityRecord, upsertIdentity, type CoachIdentityRecord } from "./identitiesStore.js";
import type { TournamentRecord } from "../tournaments/types.js";

export const GET_STARTED_PATH = "/api/me/get-started";
/** The identity-record profile key holding when the coach pressed Hide (absent = shown). */
export const GET_STARTED_HIDDEN_KEY = "getStartedHidden";

export const GET_STARTED_STEPS = ["league", "tournament", "team", "organiser"] as const;
export type GetStartedStep = (typeof GET_STARTED_STEPS)[number];
export type GetStartedDone = Record<GetStartedStep, boolean>;

export interface GetStartedView {
  done: GetStartedDone;
  doneCount: number;
  total: number;
  hidden: boolean;
  /** Not hidden and not every step done. */
  show: boolean;
}

export class GetStartedError extends Error {}

export interface GetStartedSources {
  leagues: MembershipSources["leagues"];
  tournaments: {
    tournaments(statuses: readonly TournamentRecord["status"][]): ReadonlyArray<{ id: string }>;
    entrants(id: string): ReadonlyArray<{ coach: { ffbCoachId: string } }>;
  };
  /** Any Roster Builder save or fork library team for the coach. */
  hasTeam(coach: string): boolean;
  /** Site organiser or admin. */
  isOrganiser(coach: string): boolean;
}

const ALL_STATUSES: readonly TournamentRecord["status"][] = ["draft", "active", "completed", "cancelled"];

export function getStartedDone(coach: string, sources: GetStartedSources): GetStartedDone {
  const key = normalizeFfbCoachId(coach);
  const tournament = sources.tournaments.tournaments(ALL_STATUSES)
    .some((t) => sources.tournaments.entrants(t.id).some((e) => normalizeFfbCoachId(e.coach.ffbCoachId ?? "") === key));
  return {
    league: leaguesOf(coach, { leagues: sources.leagues, tournaments: { tournament: () => undefined, entrants: () => [] } }).length > 0,
    tournament,
    team: sources.hasTeam(coach),
    organiser: sources.isOrganiser(coach),
  };
}

export function getStartedView(record: CoachIdentityRecord, done: GetStartedDone): GetStartedView {
  const doneCount = GET_STARTED_STEPS.filter((s) => done[s]).length;
  const hidden = Boolean(record.profile[GET_STARTED_HIDDEN_KEY]);
  return { done, doneCount, total: GET_STARTED_STEPS.length, hidden, show: !hidden && doneCount < GET_STARTED_STEPS.length };
}

/** POST body { hidden: boolean }: Hide stores the time on the coach's own record; hidden false shows the panel again. */
export function setGetStartedHidden(coach: string, body: unknown, now = new Date()): CoachIdentityRecord {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new GetStartedError("A JSON object is required.");
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "hidden" || typeof (body as { hidden?: unknown }).hidden !== "boolean")
    throw new GetStartedError("Send { hidden: true } or { hidden: false }.");
  const hidden = (body as { hidden: boolean }).hidden;
  const previous = ownIdentityRecord(coach);
  const profile = { ...previous.profile };
  if (hidden) profile[GET_STARTED_HIDDEN_KEY] = now.toISOString();
  else delete profile[GET_STARTED_HIDDEN_KEY];
  return upsertIdentity({ ...previous, profile, updatedAt: now.toISOString(), updatedBy: previous.ffbCoachId })
    .coaches[normalizeFfbCoachId(previous.ffbCoachId)]!;
}
