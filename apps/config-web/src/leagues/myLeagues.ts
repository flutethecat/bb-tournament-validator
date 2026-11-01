/**
 * GET /api/me/leagues (sidebar Leagues section, spec-main-landing-nav §2): the signed-in coach's own league seats.
 * One entry per league where the coach holds a team in an active season (the newest active season), with each of
 * their teams in it: name, race, the W-D-L record over the season's played fixtures, and the next unplayed fixture
 * (lowest round first). Only the coach's own teams are listed; the opponent is named by team only. No contact data,
 * no coach ids. Links follow the league page's own query shape (the newest season carries no ?season=).
 */
import { fixtureOutcome } from "./identity.js";
import { coachOwnsTeam, leagueAliases } from "./redraft.js";
import { artUrl } from "./api.js";
import type { LeagueStore } from "./store.js";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "./types.js";

export interface MyLeagueFixture {
  id: string;
  round: number;
  /** The opponent's team name ("" = no opponent recorded). */
  opponent: string;
  home: boolean;
  /** Scheduled date (YYYY-MM-DD) when the organiser set one. */
  date?: string;
  /** SPA path of the fixture summary (the league Fixtures tab's own link). */
  to: string;
}

export interface MyLeagueTeam {
  id: string;
  name: string;
  race: string;
  record: { wins: number; draws: number; losses: number };
  /** SPA path of the team on the league page. */
  to: string;
  next: MyLeagueFixture | null;
}

export interface MyLeague {
  id: string;
  name: string;
  logoUrl?: string;
  season: { id: string; number: number; name: string };
  /** SPA path of the league page on that season. */
  to: string;
  teams: MyLeagueTeam[];
}

const enc = encodeURIComponent;
const norm = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();

/** Whether a fixture side is this season team: its teamId, or (unresolved sides only) the team name. */
function isTeam(side: LeagueFixture["home"], team: LeagueTeam): boolean {
  if (side.teamId) return side.teamId === team.id;
  return norm(side.team) !== "" && norm(side.team) === norm(team.name);
}

function seasonQuery(seasonId: string, latestId: string | undefined, extra: Record<string, string>): string {
  const q = new URLSearchParams({ ...(seasonId !== latestId ? { season: seasonId } : {}), ...extra }).toString();
  return q ? `?${q}` : "";
}

export function myLeagueTeam(leagueId: string, season: SeasonRecord, latestId: string | undefined, team: LeagueTeam): MyLeagueTeam {
  const record = { wins: 0, draws: 0, losses: 0 };
  let next: LeagueFixture | undefined;
  let nextHome = true;
  for (const f of season.fixtures) {
    const home = isTeam(f.home, team);
    const away = !home && isTeam(f.away, team);
    if (!home && !away) continue;
    const out = fixtureOutcome(f);
    if (out) {
      const mine = home ? out.home : out.away;
      if (mine === "win") record.wins++; else if (mine === "draw") record.draws++; else record.losses++;
      continue;
    }
    if (f.suspended) continue;
    if (!next || f.round < next.round || (f.round === next.round && f.table < next.table)) { next = f; nextHome = home; }
  }
  const base = `/leagues/${enc(leagueId)}`;
  return {
    id: team.id,
    name: team.name,
    race: team.race,
    record,
    to: `${base}${seasonQuery(season.id, latestId, { tab: "teams", team: team.id })}`,
    next: next
      ? {
          id: next.id,
          round: next.round,
          opponent: (nextHome ? next.away : next.home).team ?? "",
          home: nextHome,
          ...(next.date ? { date: next.date } : {}),
          to: `${base}${seasonQuery(season.id, latestId, { tab: "fixtures", fixture: next.id })}`,
        }
      : null,
  };
}

/** The coach's leagues: one row per league with a seat in an active season, league name order. */
export function myLeagues(store: LeagueStore, coach: string): MyLeague[] {
  if (!norm(coach)) return [];
  const out: MyLeague[] = [];
  for (const lg of store.list()) {
    const seasons = store.seasons(lg.id);
    const active = seasons.find((s) => s.status === "active");
    if (!active) continue;
    const aliases = leagueAliases(seasons);
    const teams = active.teams.filter((t) => coachOwnsTeam(t, coach, aliases));
    if (!teams.length) continue;
    const latestId = seasons[0]?.id;
    const logoUrl = artUrl(lg, "logo");
    out.push({
      id: lg.id,
      name: lg.name,
      ...(logoUrl ? { logoUrl } : {}),
      season: { id: active.id, number: active.number, name: active.name },
      to: `/leagues/${enc(lg.id)}${seasonQuery(active.id, latestId, {})}`,
      teams: teams.map((t) => myLeagueTeam(lg.id, active, latestId, t)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
