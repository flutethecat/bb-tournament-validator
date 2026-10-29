// Recent games (owner 10-30): the newest results from every source the site holds, normalised for the landing page and
// the coach page (GET /api/recent-results, public). Pure: server.ts gathers the stores and hands the rows in.
//
// Sources: tournament fixtures with a reported result ("Tournament · Round n"), tabletop matches that were played out
// and submitted / confirmed / published ("Tabletop · ..."), and fork games whose result the site already retained (the
// results store; nothing here calls the fork server). One game is listed once: a tabletop match linked to a fixture
// replaces that fixture, and a fork game launched from a fixture lends the fixture its casualties instead of appearing
// twice. Casualties are null when the source does not know them (the card then shows nothing, never 0).

import type { GamestateTeamResult } from "@bb/fork-ops";
import { effectiveScore, type StoredTournamentResult } from "./tournamentResults.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "./tournaments/types.js";
import type { MatchRecord } from "./tabletop/store.js";
import type { TabletopEvent } from "./tabletop/events.js";
import { tallyMatch } from "./tabletop/postMatch.js";
import { matchEndedAt } from "./coachHome.js";

export const RECENT_RESULTS_DEFAULT = 12;
export const RECENT_RESULTS_MAX = 50;

export interface RecentSide {
  name: string;
  race: string;
  coach: string;
  crestUrl: string | null;
  score: number | null;
  cas: number | null;
}

export interface RecentResult {
  id: string;
  source: "tournament" | "tabletop" | "fork";
  context: string;
  playedAt: string | null;
  href: string | null;
  home: RecentSide;
  away: RecentSide;
  concede: "home" | "away" | null;
  suspended: boolean;
}

export interface TeamInfo { name?: string; race?: string; crestUrl?: string | null }

export interface RecentInputs {
  /** Every retained results-store row; only fork rows (no source / "fork", never test) are read here. */
  results: readonly StoredTournamentResult[];
  /** Tournament-match metadata for a fork game (its package name labels the card). */
  forkMeta?: (gameId: string) => { packageName?: string } | undefined;
  tournaments: ReadonlyArray<{ id: string; name: string; matches: readonly ScheduledMatchRecord[]; entrants: readonly TournamentEntrantRecord[] }>;
  tabletop: ReadonlyArray<{ match: MatchRecord; events: readonly TabletopEvent[]; race?: { home?: string; away?: string } }>;
  /** A team ref (fork team id, "library:<id>", or a save id) -> what the site knows about it. */
  teamInfo?: (ref: string, coach: string) => TeamInfo | undefined;
}

/** `?limit=` -> 1..50, default 12. */
export function recentLimit(raw: string | null | undefined): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, RECENT_RESULTS_MAX) : RECENT_RESULTS_DEFAULT;
}

const iso = (value: unknown): string | null => {
  if (typeof value !== "string" || !value) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const casCaused = (team: GamestateTeamResult | undefined): number | null =>
  team && Array.isArray(team.players) ? team.players.reduce((n, p) => n + (num(p.casualtiesCaused) ?? 0), 0) : null;
/** The deciding score (a penalty shootout's when one was recorded), the same rule standings use. */
const forkScore = (team: GamestateTeamResult | undefined): number | null => (team ? num(effectiveScore(team)) : null);

function side(name: string, race: string | undefined, coach: string, crestUrl: string | null | undefined, score: number | null, cas: number | null): RecentSide {
  return { name: name || "Unnamed team", race: race ?? "", coach, crestUrl: crestUrl || null, score, cas };
}

const TABLETOP_LISTED = new Set(["submitted", "confirmed", "published"]);

export function recentResults(inputs: RecentInputs, limit = RECENT_RESULTS_DEFAULT): RecentResult[] {
  const info = (ref: string | undefined, coach: string): TeamInfo => (ref ? inputs.teamInfo?.(ref, coach) : undefined) ?? {};
  const out: RecentResult[] = [];

  // Fixtures by id (tabletop links) and by launched fork game id (fork rows).
  const fixtures = new Map<string, { item: RecentResult; tournament: string; round: number }>();
  const fixtureByGame = new Map<string, RecentResult>();
  for (const t of inputs.tournaments) {
    const entrants = new Map(t.entrants.map((e) => [e.id, e]));
    for (const m of t.matches) {
      if (!m.away || !m.result) continue;
      const r = m.result;
      const sideOf = (s: ScheduledMatchRecord["home"], score: number, cas: number | undefined): RecentSide => {
        const entrant = entrants.get(s.entrantId);
        const team = info(s.teamId, s.coach.ffbCoachId);
        return side(entrant?.submission?.teamName ?? team.name ?? s.teamId, entrant?.submission?.race ?? team.race, s.coach.ffbCoachId, team.crestUrl, num(score), num(cas));
      };
      const item: RecentResult = {
        id: `tournament:${m.id}`,
        source: "tournament",
        context: `${t.name} · Round ${m.roundNumber}`,
        playedAt: iso(r.reportedAt) ?? iso(m.updatedAt),
        href: `/app/tournaments/${encodeURIComponent(t.id)}`,
        home: sideOf(m.home, r.homeScore, r.homeCasualties),
        away: sideOf(m.away, r.awayScore, r.awayCasualties),
        concede: null,
        suspended: false,
      };
      fixtures.set(m.id, { item, tournament: t.name, round: m.roundNumber });
      if (m.launch?.gameId) fixtureByGame.set(m.launch.gameId, item);
    }
  }

  // Tabletop matches played out (submitted onwards), never test matches.
  const replacedFixtures = new Set<string>();
  for (const { match: m, events, race } of inputs.tabletop) {
    if (m.test || !TABLETOP_LISTED.has(m.state)) continue;
    const tally = tallyMatch(events);
    const cas = (s: "home" | "away") => [...tally.lines[s].values()].reduce((n, l) => n + l.casualtiesCaused, 0);
    const fixture = m.fixtureRef ? fixtures.get(m.fixtureRef) : undefined;
    if (fixture) replacedFixtures.add(m.fixtureRef!);
    const where = fixture ? `${fixture.tournament} · Round ${fixture.round}` : m.league ? m.league : "Friendly";
    const homeInfo = info(m.home.teamSaveId, m.home.coach);
    const awayInfo = info(m.away.teamSaveId, m.away.coach);
    out.push({
      id: `tabletop:${m.id}`,
      source: "tabletop",
      context: `Tabletop · ${where}`,
      playedAt: iso(matchEndedAt(events)) ?? iso(m.publishedAt) ?? iso(m.updatedAt),
      href: `/app/tabletop/${encodeURIComponent(m.id)}`,
      home: side(m.home.teamName || homeInfo.name || "", race?.home ?? homeInfo.race, m.home.coach, homeInfo.crestUrl, tally.score.home, cas("home")),
      away: side(m.away.teamName || awayInfo.name || "", race?.away ?? awayInfo.race, m.away.coach, awayInfo.crestUrl, tally.score.away, cas("away")),
      concede: tally.conceded.home ? "home" : tally.conceded.away ? "away" : null,
      suspended: false,
    });
  }

  // Fork games the site retained.
  for (const row of inputs.results) {
    if (row.test === true || (row.source !== undefined && row.source !== "fork")) continue;
    const teams = Array.isArray(row.teams) ? row.teams : [];
    const homeTeam = teams.find((t) => t.teamId === row.home.teamId);
    const awayTeam = teams.find((t) => t.teamId === row.away.teamId);
    const fixture = fixtureByGame.get(row.gameId);
    if (fixture) {
      // The fixture already lists this game: lend it the time it was played (the fixture only knows when it was
      // reported), the casualties and the concession the fork recorded.
      fixture.playedAt = iso(row.playedAt) ?? fixture.playedAt;
      fixture.home.cas ??= casCaused(homeTeam);
      fixture.away.cas ??= casCaused(awayTeam);
      fixture.concede ??= homeTeam?.conceded ? "home" : awayTeam?.conceded ? "away" : null;
      continue;
    }
    const homeInfo = info(row.home.teamId, row.home.coach);
    const awayInfo = info(row.away.teamId, row.away.coach);
    const pkg = inputs.forkMeta?.(row.gameId)?.packageName;
    out.push({
      id: `fork:${row.gameId}`,
      source: "fork",
      context: pkg ? `Online · ${pkg}` : "Online · Friendly",
      playedAt: iso(row.playedAt) ?? iso(row.pulledAt),
      href: null,
      home: side(row.home.teamName || homeInfo.name || "", homeInfo.race, row.home.coach, homeInfo.crestUrl, forkScore(homeTeam), casCaused(homeTeam)),
      away: side(row.away.teamName || awayInfo.name || "", awayInfo.race, row.away.coach, awayInfo.crestUrl, forkScore(awayTeam), casCaused(awayTeam)),
      concede: homeTeam?.conceded ? "home" : awayTeam?.conceded ? "away" : null,
      suspended: false,
    });
  }

  for (const [id, { item }] of fixtures) if (!replacedFixtures.has(id)) out.push(item);

  // Newest first; undated rows last; ties by id so the order is stable.
  out.sort((a, b) => (b.playedAt ?? "").localeCompare(a.playedAt ?? "") || a.id.localeCompare(b.id));
  return out.slice(0, Math.max(0, Math.min(limit, RECENT_RESULTS_MAX)));
}
