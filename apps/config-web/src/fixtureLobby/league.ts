/**
 * League fixtures as fixture lobbies (spec §8, owner scope 11-01: leagues first). Route under the league API:
 *   GET|POST /api/leagues/:id/seasons/:seasonId/fixtures/:fixtureId/lobby[/<action>]   (api.ts lobbyRoute)
 * Public read on both gate paths (requireSession.ts and server.ts authorized(): every /api/leagues read); writes need a
 * session, the CSRF header and onboarding (server.ts runs those first) and are refused for test sign-in sessions.
 *
 * What the league supplies: the two seats (fork accounts on the fixture sides), the teams (current team value,
 * treasury, mini roster, the stars their BB2025 roster may hire), the season's effective inducement table
 * (inducements.ts), treasury top-up ON (owner ruling §9.2: allowed in leagues by default), Highlander off and a star
 * picked by both sides refunded, coach statistics (this season + all time) and every previous meeting of the two coaches
 * (league fixtures in every league, plus Super FUMBBL / recorder results from the results store).
 *
 * START: a Super FUMBBL fixture (Play on Super FUMBBL allowed for it) marks the lobby started and sends both coaches to
 * the fixture page's existing launch flow; any other fixture creates the tabletop recorder match with the league season
 * (its inducement table) and fixtureRef `league:<leagueId>:<seasonId>:<fixtureId>` (tabletopFixtures.ts).
 */
import { bb2025 } from "@bb/validator/dataset";
import type { LeagueApiDeps, LeagueApiIdentity, LeagueApiResult } from "../leagues/api.js";
import { effectiveDeadline, fixtureOpenForDeadline } from "../leagues/deadlines.js";
import { readJsonObject } from "../leagues/http.js";
import { fixtureOutcome } from "../leagues/identity.js";
import { effectiveInducements, inducementConfigOf, seasonInducementOffers } from "../leagues/inducements.js";
import { withStandings } from "../leagues/standings.js";
import { isLeagueOrganiser, type LeagueStore } from "../leagues/store.js";
import { leagueFixtureRef } from "../leagues/tabletopFixtures.js";
import { teamValueRoster } from "../leagues/teamValue.js";
import { fixturePlayed } from "../leagues/tourplay.js";
import type { LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "../leagues/types.js";
import type { TabletopTeamFile } from "../tabletop/postMatch.js";
import { deriveTeamResult, type StoredTournamentResult } from "../tournamentResults.js";
import { lobbyRoute, type LobbyDeps } from "./api.js";
import type { CoachEloRating } from "../coachElo.js";
import { LOBBY_SIDES, type LobbyCoachRating, type LobbyCoachStats, type LobbyFixture, type LobbyFixtureSide, type LobbyHeadToHead, type LobbyMeeting, type LobbySide, type LobbyTeam } from "./types.js";
import { publishedLeagues } from "../leagues/lifecycle.js";
import { fixtureRedraftBlock } from "../leagues/redraftWindow.js";

export const LOBBY_BODY_MAX = 16 * 1024;

export interface LeagueLobbyDeps extends LobbyDeps {
  /** Counting results (fork + published tabletop) for coach statistics and head-to-head; absent = league fixtures only. */
  results?: () => StoredTournamentResult[];
  resultsRevision?: () => string;
  /** The site rating of every coach (the existing Elo, by lower-cased coach); absent = no Rating on the coach cards. */
  ratings?: () => ReadonlyMap<string, CoachEloRating>;
}

const enc = encodeURIComponent;
const norm = (v: string): string => v.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
const fail = (status: number, error: string): LeagueApiResult => ({ status, headers: { "cache-control": "private, no-store" }, body: { error } });

export async function leagueLobbyRoutes(
  method: string, rest: string[], league: LeagueRecord | undefined, auth: LeagueApiIdentity | undefined, deps: LeagueApiDeps,
): Promise<LeagueApiResult | undefined> {
  const [first, seasonId, third, fixtureId, fourth, action, ...more] = rest;
  if (first !== "seasons" || !seasonId || third !== "fixtures" || !fixtureId || fourth !== "lobby" || more.length) return undefined;
  const lobby = deps.lobby;
  if (!lobby) return fail(503, "The fixture lobby is not available on this server.");
  if (!league) return fail(404, "League not found.");
  let input: Record<string, unknown> = {};
  if (method === "POST") {
    const body = await readJsonObject(deps, LOBBY_BODY_MAX);
    if (!body.ok) return { ...fail(body.status, body.error), ...(body.close ? { close: true } : {}) };
    input = body.value;
  }
  // judged against the season as it is now (after the body arrived)
  const lg = deps.store.league(league.id);
  const season = lg ? deps.store.season(lg.id, seasonId) : undefined;
  if (!lg || !season) return fail(404, "Season not found.");
  const fixture = season.fixtures.find((f) => f.id === fixtureId);
  if (!fixture) return fail(404, "Fixture not found.");
  const fx = leagueLobbyFixture(lg, season, fixture, auth, deps.store, lobby, lobby.now?.() ?? deps.now?.() ?? new Date());
  // notifications go through the league's (draft-aware) notifier when the league API has one
  return lobbyRoute(method, action, fx, auth, input, deps.notify ? { ...lobby, notify: deps.notify } : lobby);
}

// ---- the fixture ----------------------------------------------------------------------------------------------------

function seasonQuery(store: LeagueStore, league: LeagueRecord, season: SeasonRecord, extra: Record<string, string>): string {
  const latest = store.seasons(league.id)[0]?.id;
  const q = new URLSearchParams({ ...(season.id !== latest ? { season: season.id } : {}), ...extra }).toString();
  return q ? `?${q}` : "";
}

export function leagueLobbyFixture(
  league: LeagueRecord, season: SeasonRecord, f: LeagueFixture, auth: LeagueApiIdentity | undefined, store: LeagueStore, deps: LeagueLobbyDeps, now: Date = new Date(),
): LobbyFixture {
  const config = inducementConfigOf(season);
  const { offers, ids } = seasonInducementOffers(config);
  const ranked = withStandings(season);
  const phase = ranked.phases.find((p) => p.id === f.phaseId);
  const base = `/leagues/${enc(league.id)}`;
  const coachIds = { home: f.home.coachId ?? "", away: f.away.coachId ?? "" };
  const history = coachHistory(store, deps, coachIds);
  const rate = ratingsOf(deps);
  const side = (s: LobbySide): LobbyFixtureSide => {
    const fs = f[s];
    const team = season.teams.find((t) => (fs.teamId ? t.id === fs.teamId : t.name === fs.team));
    const row = phase?.standings.find((r) => (fs.teamId ? r.teamId === fs.teamId : r.team === fs.team));
    const cid = coachIds[s];
    return {
      coachId: cid,
      coach: fs.coach || cid,
      team: lobbyTeam(team, fs.team, fs.race),
      ...(row ? { standing: {
        rank: row.rank, points: row.points, group: row.group, played: row.played, wins: row.wins, draws: row.draws, losses: row.losses,
        ...(row.latest ? { latest: row.latest.slice(-5) } : {}),
      } } : {}),
      ...(rate ? { rating: rate(cid) } : {}),
      stats: {
        season: { ...statsOf(seasonGames(season, cid)), ...(row ? { points: row.points } : {}) },
        allTime: statsOf(history.games.get(cid.trim().toLowerCase()) ?? []),
      },
    };
  };
  const lobbySides = { home: side("home"), away: side("away") };
  const played = fixturePlayed(f);
  const closedReason = played ? "This fixture has been played."
    : f.suspended ? "This fixture is not being played."
      : season.status !== "active" ? "This season is finished."
        : !fixtureOpenForDeadline(f) ? "This fixture was decided at its deadline."
          : !(coachIds.home && coachIds.away) ? "Both teams need a coach account before the lobby opens."
            : fixtureRedraftBlock(store.seasons(league.id), f, now);
  const deadline = effectiveDeadline(season, f);
  return {
    key: leagueFixtureRef(league.id, season.id, f.id),
    source: "league",
    mode: league.playOnFork === true && f.forkEnabled === true && f.forkCancelled !== true ? "fork" : "tabletop",
    open: !closedReason,
    ...(closedReason ? { closedReason } : {}),
    header: {
      competition: league.name, season: season.name, phase: f.phase, ...(f.group ? { group: f.group } : {}), round: f.round,
      ...(f.table ? { table: f.table } : {}), ...(f.date ? { date: f.date } : {}), ...(deadline ? { deadline } : {}),
      ...(agreedTime(f.scheduledTime) ? { scheduled: agreedTime(f.scheduledTime)! } : {}), ruleset: season.ruleset,
    },
    links: {
      competition: `${base}${seasonQuery(store, league, season, {})}`,
      fixture: `${base}${seasonQuery(store, league, season, { tab: "fixtures", fixture: f.id })}`,
      standings: `${base}${seasonQuery(store, league, season, { tab: "standings" })}`,
      rules: `${base}${seasonQuery(store, league, season, {})}`,
      lobby: `${base}/seasons/${enc(season.id)}/fixtures/${enc(f.id)}/lobby`,
    },
    sides: lobbySides,
    // Owner ruling §9.2: treasury top-up allowed in leagues by default. Highlander is a tournament package option.
    rules: { treasuryTopUp: true, highlander: false, starClash: "refund" },
    noInducements: "",
    offers, ids, table: effectiveInducements(config),
    isOrganiser: (coach) => isLeagueOrganiser(league, coach) || Boolean(auth?.admin && same(auth.coach, coach)),
    headToHead: headToHead(history.meetings, coachIds),
    teamHeadToHead: teamMeetings(store, league, lobbySides, history.meetings),
    organisers: [...new Set([...(league.owner ? [league.owner] : []), ...league.organisers])],
    // the recorder team must be this season's league team: same name, same roster (race)
    recorderTeamAllowed: (s, t) => {
      const lt = lobbySides[s].team;
      if (norm(t.name) !== norm(lt.name)) return false;
      if (!t.race) return true;
      const a = teamValueRoster(t.race)?.id, b = teamValueRoster(lt.race)?.id;
      return a && b ? a === b : norm(t.race) === norm(lt.race);
    },
    start: {
      fixtureRef: leagueFixtureRef(league.id, season.id, f.id),
      extra: { leagueSeason: { leagueId: league.id, seasonId: season.id }, league: league.name },
    },
  };
}

function lobbyTeam(team: LeagueTeam | undefined, name: string, race: string): LobbyTeam {
  const roster = teamValueRoster(team?.race ?? race);
  const tv = team ? (team.currentTeamValue ?? team.teamValue ?? null) : null;
  const treasury = Math.max(0, team?.treasury ?? 0);
  const file: TabletopTeamFile = {
    schema: 1, name: team?.name ?? name, race: roster?.name ?? team?.race ?? race, ...(roster ? { rosterId: roster.id } : {}),
    treasury, dedicatedFans: team?.fans ?? 0, ...(tv !== null ? { teamValue: tv } : {}), apothecary: team?.apothecary ?? false,
    players: [],
  };
  // the BB2025 stars that play for this roster (paired stars are hired together at the table, so not listed here)
  const stars = (roster ? bb2025.stars : [])
    .filter((s) => s.teams.includes(roster!.name) && typeof s.cost === "number" && s.cost > 0 && !s.pairedWith)
    .map((s) => ({ name: s.name, cost: s.cost as number }))
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  const players = [...(team?.players ?? [])].sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  return {
    id: team?.id ?? "", name: team?.name ?? name, race: team?.race ?? race, tv, treasury,
    rerolls: team?.rerolls ?? null, apothecary: team?.apothecary ?? false, fans: team?.fans ?? null,
    assistantCoaches: team?.assistantCoaches ?? null, cheerleaders: team?.cheerleaders ?? null,
    playerCount: players.length,
    roster: players.slice(0, 3).map((p) => ({ number: p.number, name: p.name, position: p.position, skills: p.skills.slice(0, 6), spp: p.availableSpp ?? p.stats.spp ?? 0 })),
    file, stars,
  };
}

// ---- statistics and head-to-head ------------------------------------------------------------------------------------

export interface Game { at: string; outcome: "W" | "D" | "L"; td: number; cas: number }
export interface Meeting extends LobbyMeeting { coaches: { home: string; away: string } }

export function statsOf(games: Game[]): LobbyCoachStats {
  const sorted = [...games].sort((a, b) => a.at.localeCompare(b.at));
  const n = sorted.length;
  const sum = (k: "td" | "cas") => sorted.reduce((t, g) => t + g[k], 0);
  return {
    played: n,
    wins: sorted.filter((g) => g.outcome === "W").length,
    draws: sorted.filter((g) => g.outcome === "D").length,
    losses: sorted.filter((g) => g.outcome === "L").length,
    tdPerGame: n ? Math.round((sum("td") / n) * 10) / 10 : 0,
    casPerGame: n ? Math.round((sum("cas") / n) * 10) / 10 : 0,
    form: sorted.slice(-5).map((g) => g.outcome),
  };
}

const OUT = { win: "W", draw: "D", loss: "L" } as const;
const fixtureAt = (f: LeagueFixture, s: SeasonRecord): string => f.finishedAt ?? (f.date ? `${f.date}T12:00:00.000Z` : (s.startedAt ?? s.importedAt));

function fixtureGames(season: SeasonRecord, coach: string): Game[] {
  if (!coach) return [];
  const out: Game[] = [];
  for (const f of season.fixtures) {
    const o = fixturePlayed(f) ? fixtureOutcome(f) : undefined;
    if (!o) continue;
    for (const s of LOBBY_SIDES) if (same(f[s].coachId, coach)) out.push({ at: fixtureAt(f, season), outcome: OUT[o[s]], td: f[s].score ?? 0, cas: f[s].cas ?? 0 });
  }
  return out;
}
const seasonGames = (season: SeasonRecord, coach: string): Game[] => fixtureGames(season, coach);

const historyCache = new Map<string, { at: number; value: { games: Map<string, Game[]>; meetings: Meeting[] } }>();
const HISTORY_TTL_MS = 30_000;

/**
 * Every game of the two coaches (all leagues, plus results-store rows that are not league games) and every meeting
 * between them. Cached per store version / results revision for 30 s (writes by another process show within that).
 */
export function coachHistory(store: LeagueStore, deps: LeagueLobbyDeps, coaches: Record<LobbySide, string>): { games: Map<string, Game[]>; meetings: Meeting[] } {
  const keys = LOBBY_SIDES.map((s) => coaches[s].trim().toLowerCase());
  const cacheKey = `${store.version()}|${deps.resultsRevision?.() ?? ""}|${keys.join("|")}`;
  const now = Date.now();
  const hit = historyCache.get(cacheKey);
  if (hit && now - hit.at < HISTORY_TTL_MS) return hit.value;
  const games = new Map<string, Game[]>(keys.filter(Boolean).map((k) => [k, []]));
  const meetings: Meeting[] = [];
  const leagueGameIds = new Set<string>();
  for (const league of publishedLeagues(store.list())) {
    for (const season of store.seasons(league.id)) {
      for (const f of season.fixtures) {
        if (f.fork?.result?.gameId) leagueGameIds.add(f.fork.result.gameId);
        if (f.fork?.gameId) leagueGameIds.add(f.fork.gameId);
      }
      for (const k of games.keys()) games.get(k)!.push(...fixtureGames(season, k));
      if (!keys[0] || !keys[1]) continue;
      for (const f of season.fixtures) {
        const ids = [f.home.coachId?.trim().toLowerCase(), f.away.coachId?.trim().toLowerCase()];
        if (!(ids.includes(keys[0]) && ids.includes(keys[1])) || !fixturePlayed(f) || f.home.score === null || f.away.score === null) continue;
        meetings.push({
          at: fixtureAt(f, season), event: `${league.name} · ${season.name} · Round ${f.round}`,
          home: { coach: f.home.coach, team: f.home.team, score: f.home.score }, away: { coach: f.away.coach, team: f.away.team, score: f.away.score },
          cas: { home: f.home.cas, away: f.away.cas },
          to: `/leagues/${enc(league.id)}?${new URLSearchParams({ season: season.id, tab: "fixtures", fixture: f.id })}`,
          coaches: { home: f.home.coachId ?? "", away: f.away.coachId ?? "" },
        });
      }
    }
  }
  let rows: StoredTournamentResult[] = [];
  try { rows = deps.results?.() ?? []; } catch { rows = []; }
  for (const row of rows) {
    if (row.test || (row.source === "tabletop" && row.published !== true) || row.fixtureRef?.startsWith("league:") || leagueGameIds.has(row.gameId)) continue;
    const ht = row.teams.find((t) => t.teamId === row.home.teamId), at = row.teams.find((t) => t.teamId === row.away.teamId);
    if (!ht || !at) continue;
    const dh = deriveTeamResult(ht, at), da = deriveTeamResult(at, ht);
    const when = row.playedAt ?? row.pulledAt;
    const outcome = (d: typeof dh): Game["outcome"] => (d.outcome === "won" ? "W" : d.outcome === "lost" ? "L" : "D");
    const hk = row.home.coach.trim().toLowerCase(), ak = row.away.coach.trim().toLowerCase();
    games.get(hk)?.push({ at: when, outcome: outcome(dh), td: dh.tdFor, cas: dh.casFor });
    games.get(ak)?.push({ at: when, outcome: outcome(da), td: da.tdFor, cas: da.casFor });
    if (keys[0] && keys[1] && [hk, ak].includes(keys[0]) && [hk, ak].includes(keys[1])) {
      meetings.push({
        at: when, event: row.source === "tabletop" ? (row.league ? `${row.league} (tabletop)` : "Tabletop") : row.source === "naf" ? "NAF" : "Super FUMBBL",
        home: { coach: row.home.coach, team: row.home.teamName, score: dh.tdFor }, away: { coach: row.away.coach, team: row.away.teamName, score: da.tdFor },
        cas: { home: dh.casFor, away: da.casFor }, coaches: { home: row.home.coach, away: row.away.coach },
      });
    }
  }
  meetings.sort((a, b) => b.at.localeCompare(a.at));
  const value = { games, meetings };
  historyCache.set(cacheKey, { at: now, value });
  if (historyCache.size > 200) historyCache.delete(historyCache.keys().next().value!);
  return value;
}

/** Wins of each lobby side's coach, draws and TD / CAS totals over every meeting (newest first, 50 listed). */
export function headToHead(meetings: Meeting[], coaches: Record<LobbySide, string>): LobbyHeadToHead {
  const h: LobbyHeadToHead = { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] };
  for (const m of meetings) {
    const homeIsHome = same(m.coaches.home, coaches.home);
    const mine = (s: LobbySide) => ((s === "home") === homeIsHome ? m.home : m.away);
    const casOf = (s: LobbySide) => ((s === "home") === homeIsHome ? m.cas.home : m.cas.away) ?? 0;
    const a = mine("home").score, b = mine("away").score;
    if (a > b) h.wins.home++; else if (b > a) h.wins.away++; else h.draws++;
    h.td.home += a; h.td.away += b;
    h.cas.home += casOf("home"); h.cas.away += casOf("away");
  }
  h.meetings = meetings.slice(0, 50).map(({ coaches: _c, ...m }) => m);
  return h;
}

// ---- schedule, ratings and the teams' own meetings (fixture summary, UX pass 11-02) ---------------------------------

const ISO = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
/** The agreed time on a fixture (Schedule writes it), only when well formed. */
export function agreedTime(v: unknown): { start: string; end: string; agreedAt: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!ISO(o.start) || !ISO(o.end)) return undefined;
  return { start: o.start, end: o.end, agreedAt: ISO(o.agreedAt) ? o.agreedAt : o.start };
}

/**
 * The coach's Rating (the existing Elo until Glicko lands) and their rank among every rated coach (highest first; a tie
 * shares the better rank). A coach with no rated game has no Rating (null).
 */
export function ratingsOf(deps: Pick<LeagueLobbyDeps, "ratings">): ((coach: string) => LobbyCoachRating | null) | undefined {
  if (!deps.ratings) return undefined;
  let map: ReadonlyMap<string, CoachEloRating>;
  try { map = deps.ratings(); } catch { return undefined; }
  const sorted = [...map.values()].filter((r) => r.games > 0).map((r) => r.rating).sort((a, b) => b - a);
  return (coach) => {
    const r = coach ? map.get(coach.trim().toLowerCase()) : undefined;
    if (!r || r.games <= 0) return null;
    const rank = sorted.findIndex((v) => v <= r.rating) + 1;
    return { value: Math.round(r.rating), games: r.games, provisional: r.provisional, ...(rank > 0 ? { rank, of: sorted.length } : {}) };
  };
}

/**
 * Every played meeting of the two TEAMS in this league (any season: league team ids are the slug of name + coach, so a
 * team keeps its id across seasons), as a head-to-head by side. null when it is the same set of games as the coaches'
 * own meetings (nothing more to say), or when a side has no team record.
 */
export function teamMeetings(store: LeagueStore, league: LeagueRecord, sides: Record<LobbySide, LobbyFixtureSide>, coachMeetings: readonly Meeting[]): LobbyHeadToHead | null {
  const ids = { home: sides.home.team.id, away: sides.away.team.id };
  if (!ids.home || !ids.away || ids.home === ids.away) return null;
  const meetings: Array<Meeting & { homeTeamId: string }> = [];
  for (const season of store.seasons(league.id)) {
    for (const f of season.fixtures) {
      const t = [f.home.teamId, f.away.teamId];
      if (!(t.includes(ids.home) && t.includes(ids.away)) || !fixturePlayed(f) || f.home.score === null || f.away.score === null) continue;
      meetings.push({
        at: fixtureAt(f, season), event: `${league.name} · ${season.name} · Round ${f.round}`,
        home: { coach: f.home.coach, team: f.home.team, score: f.home.score }, away: { coach: f.away.coach, team: f.away.team, score: f.away.score },
        cas: { home: f.home.cas, away: f.away.cas },
        to: `/leagues/${enc(league.id)}?${new URLSearchParams({ season: season.id, tab: "fixtures", fixture: f.id })}`,
        coaches: { home: f.home.coachId ?? "", away: f.away.coachId ?? "" }, homeTeamId: f.home.teamId ?? "",
      });
    }
  }
  meetings.sort((a, b) => b.at.localeCompare(a.at));
  const coachLinks = new Set(coachMeetings.map((m) => m.to).filter(Boolean));
  if (meetings.length === coachLinks.size && meetings.every((m) => coachLinks.has(m.to))) return null;
  const h: LobbyHeadToHead = { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] };
  for (const m of meetings) {
    const homeIsHome = m.homeTeamId === ids.home;
    const a = homeIsHome ? m.home.score : m.away.score, b = homeIsHome ? m.away.score : m.home.score;
    if (a > b) h.wins.home++; else if (b > a) h.wins.away++; else h.draws++;
    h.td.home += a; h.td.away += b;
    h.cas.home += (homeIsHome ? m.cas.home : m.cas.away) ?? 0; h.cas.away += (homeIsHome ? m.cas.away : m.cas.home) ?? 0;
  }
  h.meetings = meetings.slice(0, 50).map(({ coaches: _c, homeTeamId: _t, ...m }) => m);
  return h;
}
