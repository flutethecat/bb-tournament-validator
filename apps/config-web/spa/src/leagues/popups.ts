// Shared popups (owner 11-02, league UX pass): the coach summary (CoachSummaryDialog.vue) and the at-a-glance roster
// (RosterDialog.vue), opened from a coach or team name on the standings and reusable on any league page. Pure helpers,
// no DOM. Public data only: the league statistics (GET /api/leagues/:id/stats, a public read) and the season's teams.
// Never an email, phone or Discord id: the summary is built field by field from the public record.

import type { CoachRecord, LeagueStats, LeagueTeam } from "./types";

/** The coach summary's lines, built only from public statistics fields. */
export interface CoachSummary {
  coach: string;
  games: number;
  wins: number;
  draws: number;
  losses: number;
  /** 0..1, as the statistics count it (a draw is half a win). */
  winRate: number;
  titles: number;
  teams: number;
  seasons: number[];
}

const fold = (s: string | undefined): string => (s ?? "").normalize("NFC").trim().toLowerCase();

/** The coach's all-time record: by account id when the row carries one, else by the shown name (only when one row has it). */
export function findCoachRecord(stats: Pick<LeagueStats, "coaches"> | undefined, coach: string, coachId?: string): CoachRecord | undefined {
  const rows = stats?.coaches ?? [];
  if (coachId) {
    const byId = rows.find((r) => fold(r.coachId) === fold(coachId));
    if (byId) return byId;
  }
  const named = rows.filter((r) => fold(r.coach) === fold(coach));
  return named.length === 1 ? named[0] : undefined;
}

/** Copies the public fields only (an unexpected extra field on the record never reaches the popup). */
export function coachSummaryOf(r: CoachRecord): CoachSummary {
  return {
    coach: String(r.coach), games: Number(r.games) || 0, wins: Number(r.wins) || 0, draws: Number(r.draws) || 0, losses: Number(r.losses) || 0,
    winRate: Number.isFinite(r.winPct) ? r.winPct : 0, titles: Number(r.titles) || 0, teams: Number(r.teams) || 0,
    seasons: Array.isArray(r.seasons) ? r.seasons.filter((n) => Number.isInteger(n)) : [],
  };
}

/** The site's own public avatar route for a coach account ("" without one): the letter badge shows when it 404s. */
export const coachAvatarSrc = (coachId: string | undefined): string => {
  const id = (coachId ?? "").normalize("NFC").trim();
  return id && id.length <= 120 ? `/api/coach-avatars/${encodeURIComponent(id)}` : "";
};

/** "W-D-L". */
export const wdlLine = (s: Pick<CoachSummary, "wins" | "draws" | "losses">): string => `${s.wins}-${s.draws}-${s.losses}`;

/** The roster popup's columns (the team page's roster columns, at a glance). */
export const ROSTER_POPUP_COLUMNS = ["#", "Player", "MA", "ST", "AG", "PA", "AV", "Skills", "SPP", "Value"] as const;

/** The team a standings row names: its team id, else its name (only when exactly one team has it). */
export function teamForRow(teams: readonly LeagueTeam[], row: { teamId?: string; team: string }): LeagueTeam | undefined {
  if (row.teamId) {
    const byId = teams.find((t) => t.id === row.teamId);
    if (byId) return byId;
  }
  const named = teams.filter((t) => fold(t.name) === fold(row.team));
  return named.length === 1 ? named[0] : undefined;
}
