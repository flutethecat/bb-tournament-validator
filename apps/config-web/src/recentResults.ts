// Recent games (owner 10-30): the newest results from every source the site holds, normalised for the landing page and
// the coach page (GET /api/recent-results, public). Pure: server.ts gathers the stores and hands the rows in.
//
// Sources: tournament fixtures with a reported result ("Tournament · Round n"), tabletop matches that were played out
// and submitted / confirmed / published ("Tabletop · ..."), and fork games whose result the site already retained (the
// results store; nothing here calls the fork server). One game is listed once: a tabletop match linked to a fixture
// replaces that fixture, and a fork game launched from a fixture lends the fixture its casualties instead of appearing
// twice. Casualties are null when the source does not know them (the card then shows nothing, never 0). Every card
// links to its game page, /app/games/<tournament|tabletop|online>/<id> (src/gameDetail.ts).

import type { GamestateTeamResult } from "@bb/fork-ops";
import { effectiveScore, type StoredTournamentResult } from "./tournamentResults.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "./tournaments/types.js";
import type { MatchRecord, TeamChain } from "./tabletop/store.js";
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
  /** The game page (/app/games/<source>/<id>); every card links to one. */
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

export const TABLETOP_LISTED: ReadonlySet<string> = new Set(["submitted", "confirmed", "published"]);

/** The game page sources (route /app/games/:source/:id); a fork game is "online" in the URL. */
export type GameSource = "tournament" | "tabletop" | "online";
export const GAME_SOURCES: readonly GameSource[] = ["tournament", "tabletop", "online"];
/** The SPA game page for one played game (src/gameDetail.ts answers its GET /api/games/:source/:id). */
export const gameHref = (source: GameSource, id: string): string => `/app/games/${source}/${encodeURIComponent(id)}`;

export function recentResults(inputs: RecentInputs, limit = RECENT_RESULTS_DEFAULT): RecentResult[] {
  const info = (ref: string | undefined, coach: string): TeamInfo => (ref ? inputs.teamInfo?.(ref, coach) : undefined) ?? {};
  const out: RecentResult[] = [];
  // Team lookups (library / save reads) run only for the cards that make the cut, after sorting.
  const enrichers = new Map<RecentResult, Array<() => void>>();
  const later = (item: RecentResult, s: RecentSide, ref: string | undefined, coach: string, known: { name?: string; race?: string; fallbackName?: string }) => {
    const list = enrichers.get(item) ?? [];
    list.push(() => {
      const team = info(ref, coach);
      if (!known.name) s.name = team.name || known.fallbackName || "Unnamed team";
      if (!known.race) s.race = team.race ?? "";
      s.crestUrl ||= team.crestUrl || null;
    });
    enrichers.set(item, list);
  };

  // Fixtures by id (tabletop links) and by launched fork game id (fork rows).
  const fixtures = new Map<string, { item: RecentResult; tournament: string; round: number }>();
  const fixtureByGame = new Map<string, RecentResult>();
  for (const t of inputs.tournaments) {
    const entrants = new Map(t.entrants.map((e) => [e.id, e]));
    for (const m of t.matches) {
      if (!m.away || !m.result) continue;
      const r = m.result;
      const sideOf = (s: ScheduledMatchRecord["home"], score: number, cas: number | undefined): RecentSide =>
        side(entrants.get(s.entrantId)?.submission?.teamName ?? s.teamId, entrants.get(s.entrantId)?.submission?.race, s.coach.ffbCoachId, null, num(score), num(cas));
      const item: RecentResult = {
        id: `tournament:${m.id}`,
        source: "tournament",
        context: `${t.name} · Round ${m.roundNumber}`,
        playedAt: iso(r.reportedAt) ?? iso(m.updatedAt),
        href: gameHref("tournament", m.id),
        home: sideOf(m.home, r.homeScore, r.homeCasualties),
        away: sideOf(m.away, r.awayScore, r.awayCasualties),
        concede: null,
        suspended: false,
      };
      for (const [s, rec] of [[item.home, m.home], [item.away, m.away!]] as const) {
        const sub = entrants.get(rec.entrantId)?.submission;
        later(item, s, rec.teamId, rec.coach.ffbCoachId, { name: sub?.teamName, race: sub?.race, fallbackName: rec.teamId });
      }
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
    const item: RecentResult = {
      id: `tabletop:${m.id}`,
      source: "tabletop",
      context: `Tabletop · ${where}`,
      playedAt: iso(matchEndedAt(events)) ?? iso(m.publishedAt) ?? iso(m.updatedAt),
      href: gameHref("tabletop", m.id),
      home: side(m.home.teamName, race?.home, m.home.coach, null, tally.score.home, cas("home")),
      away: side(m.away.teamName, race?.away, m.away.coach, null, tally.score.away, cas("away")),
      concede: tally.conceded.home ? "home" : tally.conceded.away ? "away" : null,
      suspended: false,
    };
    later(item, item.home, m.home.teamSaveId, m.home.coach, { name: m.home.teamName, race: race?.home });
    later(item, item.away, m.away.teamSaveId, m.away.coach, { name: m.away.teamName, race: race?.away });
    out.push(item);
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
    const pkg = inputs.forkMeta?.(row.gameId)?.packageName;
    const item: RecentResult = {
      id: `fork:${row.gameId}`,
      source: "fork",
      context: pkg ? `Online · ${pkg}` : "Online · Friendly",
      playedAt: iso(row.playedAt) ?? iso(row.pulledAt),
      href: gameHref("online", row.gameId),
      home: side(row.home.teamName, undefined, row.home.coach, null, forkScore(homeTeam), casCaused(homeTeam)),
      away: side(row.away.teamName, undefined, row.away.coach, null, forkScore(awayTeam), casCaused(awayTeam)),
      concede: homeTeam?.conceded ? "home" : awayTeam?.conceded ? "away" : null,
      suspended: false,
    };
    later(item, item.home, row.home.teamId, row.home.coach, { name: row.home.teamName });
    later(item, item.away, row.away.teamId, row.away.coach, { name: row.away.teamName });
    out.push(item);
  }

  for (const [id, { item }] of fixtures) if (!replacedFixtures.has(id)) out.push(item);

  // Newest first; undated rows last; ties by id so the order is stable.
  out.sort((a, b) => (b.playedAt ?? "").localeCompare(a.playedAt ?? "") || a.id.localeCompare(b.id));
  const picked = out.slice(0, Math.max(0, Math.min(limit, RECENT_RESULTS_MAX)));
  for (const item of picked) for (const fill of enrichers.get(item) ?? []) fill();
  return picked;
}

/** The recorder reads the gatherer needs (FileTabletopRepository satisfies it). */
export interface TabletopReader {
  listMatches(): Promise<MatchRecord[]>;
  readEvents(matchId: string): Promise<TabletopEvent[]>;
  getChain(coach: string, saveId: string): Promise<TeamChain | undefined>;
}

type TabletopRow = RecentInputs["tabletop"][number];

/**
 * Tabletop rows for the strip, bounded: only the newest `cap` listed matches (by updatedAt; a match is played out before
 * its last update, so nothing older can be newer on the strip) have their event log and team chains read. A match whose
 * updatedAt has not moved since the last refresh is served from the summary cache with no reads at all; team chains are
 * read at most once per (coach, team) per refresh.
 */
export function createTabletopGatherer(cap = RECENT_RESULTS_MAX) {
  let cache = new Map<string, { stamp: string; row: TabletopRow }>();
  return async function gather(reader: TabletopReader): Promise<TabletopRow[]> {
    const candidates = (await reader.listMatches())
      .filter((m) => !m.test && TABLETOP_LISTED.has(m.state))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")) || a.id.localeCompare(b.id))
      .slice(0, Math.max(0, cap));
    const chains = new Map<string, Promise<string | undefined>>();
    const raceOf = (coach: string, saveId: string): Promise<string | undefined> => {
      const key = `${coach}\u0000${saveId}`;
      let hit = chains.get(key);
      if (!hit) {
        hit = reader.getChain(coach, saveId)
          .then((chain) => chain?.revisions.find((r) => r.revision === chain.head)?.teamFile.race ?? undefined)
          .catch(() => undefined);
        chains.set(key, hit);
      }
      return hit;
    };
    const next = new Map<string, { stamp: string; row: TabletopRow }>();
    const rows: TabletopRow[] = [];
    for (const match of candidates) {
      const stamp = `${match.updatedAt}|${match.state}`;
      const cached = cache.get(match.id);
      if (cached && cached.stamp === stamp) {
        next.set(match.id, cached);
        rows.push(cached.row);
        continue;
      }
      try {
        const row: TabletopRow = {
          match,
          events: await reader.readEvents(match.id),
          race: { home: await raceOf(match.home.coach, match.home.teamSaveId), away: await raceOf(match.away.coach, match.away.teamSaveId) },
        };
        next.set(match.id, { stamp, row });
        rows.push(row);
      } catch { /* unreadable match: skipped */ }
    }
    cache = next; // only the current candidates stay cached
    return rows;
  };
}
