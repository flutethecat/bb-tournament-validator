/**
 * The league registration check (lane L5, used by L6's register route and shown by the Roster Builder's league mode):
 * may a team of `race` join this season now? It enforces the season's registration settings through the registration
 * core: the window (seasonWindowStatus: published, stage, Allow registration, dates), the allowed roster classes (Q10),
 * and the core's roomFor (max teams = cap, max per race = perRace) over the season's accepted entries.
 *
 * Until L6 stores LeagueRegistration rows, the accepted entries are the season's teams (seasonTeamEntries). L6 passes its
 * own entries (accepted ones count; the core ignores every other state).
 */
import { roomFor, type RegistrationEntry, type WindowStatus } from "../registration/index.js";
import { canonicalRace, rosterAllowed } from "./leagueBuilder.js";
import { seasonOrganiserWindow, seasonRegistrationOf, seasonWindow, seasonWindowStatus } from "./seasonRegistration.js";
import type { LeagueRecord, SeasonRecord } from "./types.js";

export type LeagueRegistrationRefusal = "closed" | "roster" | "full" | "race-full";
export type LeagueRegistrationCheck = { ok: true } | { ok: false; code: LeagueRegistrationRefusal; message: string };

/** Each team already in the season as an accepted entry (race in dataset spelling, for the per-race limit). */
export function seasonTeamEntries(league: Pick<LeagueRecord, "id">, season: Pick<SeasonRecord, "id" | "teams" | "importedAt">): RegistrationEntry[] {
  return (season.teams ?? []).map((t) => ({
    id: `team:${t.id}`, competitionId: `${league.id}/${season.id}`, coach: t.coachId ?? t.coach ?? "", state: "accepted" as const,
    submittedAt: season.importedAt, enteredAt: season.importedAt, race: canonicalRace(String(t.race ?? "")), log: [],
  }));
}

export interface LeagueRegistrationCheckOptions {
  now: Date;
  /** The season's registration entries (default: its teams, all accepted). */
  entries?: readonly RegistrationEntry[];
  /** An organiser adding a team: the dates and Allow registration do not apply (only finished / started do). */
  organiser?: boolean;
  /** The entry being decided (it never counts against itself). */
  entryId?: string;
  /** The admin-kept NAF-approved list (tests). */
  naf?: readonly string[];
}

export function checkLeagueRegistration(league: LeagueRecord, season: SeasonRecord, team: { race: string }, opts: LeagueRegistrationCheckOptions): LeagueRegistrationCheck {
  const window: WindowStatus = opts.organiser ? seasonOrganiserWindow(league, season) : seasonWindowStatus(league, season, opts.now);
  if (!window.open) return { ok: false, code: "closed", message: window.message };
  const reg = seasonRegistrationOf(league, season);
  const race = canonicalRace(team.race);
  const allowed = rosterAllowed(race, reg.allowedRosters, opts.naf);
  if (!allowed.allowed) return { ok: false, code: "roster", message: allowed.reason };
  const entries = opts.entries ?? seasonTeamEntries(league, season);
  const room = roomFor(seasonWindow(reg), entries.map((e) => ({ ...e, race: e.race ? canonicalRace(e.race) : e.race })), { id: opts.entryId ?? "\0new", race });
  if (room.ok) return { ok: true };
  if (room.code === "full") return { ok: false, code: "full", message: `${season.name} is full (${reg.maxRegistrations} teams).` };
  return { ok: false, code: "race-full", message: `${race}: ${reg.maxPerRace} / ${reg.maxPerRace} teams in this season, full.` };
}
