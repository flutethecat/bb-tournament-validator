/**
 * GET /api/me/leagues (sidebar Leagues section, spec-main-landing-nav §2): the signed-in coach's own league seats.
 * One entry per league where the coach holds a team in an active season (the newest active season), with each of
 * their teams in it: name, race, the W-D-L record over the season's played fixtures, and the next unplayed fixture.
 * Only the coach's own teams are listed; the opponent is named by team only. No contact data, no coach ids. Links
 * follow the league page's own query shape (the newest season carries no ?season=).
 *
 * Who holds a seat (seatOwners): an explicit organiser assignment decides alone (an assigned account owns the team; a
 * CLEARED assignment means nobody does, whatever the display or NAF name says); otherwise the team's account; only a
 * team with neither falls back to the coach aliases (identity.ts) built from the league's active seasons.
 *
 * Cost: the seat index (coach key -> rows) is built once from the active seasons only and reused until the league store
 * reports a write through it (LeagueStore.version(): league, season, artwork, account-deletion invalidate), or after
 * INDEX_TTL_MS for writes made by another process (an import run). A cached request is one map lookup.
 */
import { buildCoachAliases, fixtureOutcome, seasonCoachFacets, type CoachAliases } from "./identity.js";
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

/** Writes by another process (no store write through this process) are picked up at most this late. */
export const INDEX_TTL_MS = 60_000;

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

/**
 * Fixture order for "next": the season's phase sequence first (phases as listed; fixture-only phases after them, in the
 * order they first appear), then the scheduled date (dated before undated), then round, then table.
 */
export function fixtureOrder(season: Pick<SeasonRecord, "phases" | "fixtures">): (a: LeagueFixture, b: LeagueFixture) => number {
  const rank = new Map<string, number>();
  for (const p of season.phases) if (!rank.has(p.id)) rank.set(p.id, rank.size);
  for (const f of season.fixtures) if (!rank.has(f.phaseId)) rank.set(f.phaseId, rank.size);
  const day = (f: LeagueFixture) => (f.date && /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : "9999-99-99");
  return (a, b) => (rank.get(a.phaseId)! - rank.get(b.phaseId)!) || day(a).localeCompare(day(b)) || a.round - b.round || a.table - b.table;
}

export function myLeagueTeam(leagueId: string, season: SeasonRecord, latestId: string | undefined, team: LeagueTeam): MyLeagueTeam {
  const record = { wins: 0, draws: 0, losses: 0 };
  const order = fixtureOrder(season);
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
    if (!next || order(f, next) < 0) { next = f; nextHome = home; }
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

/**
 * The coach keys (normalised account ids, or a display name the aliases leave unlinked) that hold this team's seat.
 * `observedIds` = every account id seen in the league's active seasons (the only ids an alias can resolve to the team).
 */
export function seatOwners(team: LeagueTeam, aliases: CoachAliases, observedIds: Iterable<string>): string[] {
  if (team.coachAssigned) {
    if (team.coachAssigned.cleared) return [];
    return norm(team.coachId) ? [norm(team.coachId)] : [];
  }
  if (norm(team.coachId)) return [norm(team.coachId)];
  if (!norm(team.coach)) return [];
  const teamKey = aliases.key({ coach: team.coach, ...(team.nafUser ? { nafUser: team.nafUser } : {}) });
  const owners = new Set<string>();
  for (const id of observedIds) if (aliases.key({ coachId: id }) === teamKey) owners.add(norm(id));
  // An account whose id equals the unlinked display name (the coach signed in under the name the export shows).
  if (teamKey === `name:${norm(team.coach)}`) owners.add(norm(team.coach));
  return [...owners];
}

interface SeatIndex { version: number; at: number; byCoach: Map<string, MyLeague[]> }
const indexes = new WeakMap<LeagueStore, SeatIndex>();

function buildIndex(store: LeagueStore): Map<string, MyLeague[]> {
  const byCoach = new Map<string, MyLeague[]>();
  for (const lg of store.list()) {
    const seasons = store.seasons(lg.id);
    const activeSeasons = seasons.filter((s) => s.status === "active");
    const active = activeSeasons[0];
    if (!active) continue;
    const aliases = buildCoachAliases((function* () { for (const s of activeSeasons) yield* seasonCoachFacets(s); })());
    const observed = new Set<string>();
    for (const s of activeSeasons) for (const f of seasonCoachFacets(s)) if (norm(f.coachId)) observed.add(f.coachId!.trim());
    const latestId = seasons[0]?.id;
    const logoUrl = artUrl(lg, "logo");
    const perCoach = new Map<string, MyLeagueTeam[]>();
    for (const t of active.teams) {
      const owners = seatOwners(t, aliases, observed);
      if (!owners.length) continue;
      const row = myLeagueTeam(lg.id, active, latestId, t);
      for (const o of owners) perCoach.set(o, [...(perCoach.get(o) ?? []), row]);
    }
    for (const [coach, teams] of perCoach) {
      const list = byCoach.get(coach) ?? [];
      list.push({
        id: lg.id,
        name: lg.name,
        ...(logoUrl ? { logoUrl } : {}),
        season: { id: active.id, number: active.number, name: active.name },
        to: `/leagues/${enc(lg.id)}${seasonQuery(active.id, latestId, {})}`,
        teams,
      });
      byCoach.set(coach, list);
    }
  }
  for (const list of byCoach.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  return byCoach;
}

/** Drop every cached seat index (tests; a caller that changed league files behind the store's back). */
export function clearMyLeaguesIndex(store: LeagueStore): void { indexes.delete(store); }

/** The coach's leagues: one row per league with a seat in an active season, league name order. */
export function myLeagues(store: LeagueStore, coach: string, now = Date.now()): MyLeague[] {
  const key = norm(coach);
  if (!key) return [];
  let idx = indexes.get(store);
  if (!idx || idx.version !== store.version() || now - idx.at >= INDEX_TTL_MS) {
    idx = { version: store.version(), at: now, byCoach: buildIndex(store) };
    indexes.set(store, idx);
  }
  const hit = idx.byCoach.get(key);
  return hit ? structuredClone(hit) : [];
}
