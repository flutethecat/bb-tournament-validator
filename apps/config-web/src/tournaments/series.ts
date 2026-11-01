// Tournament Series (spec-spa-tournaments §6.2, phase 5; owner 10-28: "sub-tournaments that all contribute to the
// standings"). A series groups tournaments; its standings add up each coach's event points from every counted
// sub-tournament. Records live in tournaments.json `series` (TournamentStore); this file holds the standings engine and
// the /api/series routes.
//
//   GET    /api/series                              public list
//   POST   /api/series                              admins and organisers { name, description?, organisers?, scoring, bestN?, seeding }
//   GET    /api/series/:id                          public: the series, its tournaments, the aggregated standings
//   GET    /api/series/:id/standings                public: the aggregated standings only
//   PATCH  /api/series/:id                          series organisers / admins { revision, ...fields }
//   DELETE /api/series/:id                          series organisers / admins { revision } (tournaments stay, leave the series)
//   POST   /api/series/:id/tournaments/:tid         series organisers / admins { revision }: only a tournament the actor manages (admins: any)
//   DELETE /api/series/:id/tournaments/:tid         the same rule
//
// Writes send the revision they loaded (body `revision` or If-Match): 428 missing, 409 stale (the league settings pattern).

import { calculateStandings } from "./pairing.js";
import { isTournamentManager, TournamentStore, TournamentStoreError, type SeriesInput } from "./store.js";
import { SERIES_SCORING, SERIES_SEEDINGS } from "./types.js";
import type {
  SeriesScoring,
  SeriesSeeding,
  TournamentDataFileV4,
  TournamentRecord,
  TournamentSeriesRecord,
  TournamentStatus,
} from "./types.js";
import { requestRevision } from "../leagues/http.js";

export const SERIES_NAME_MAX = 100;
export const SERIES_DESCRIPTION_MAX = 2000;
export const SERIES_ORGANISERS_MAX = 10;
export const SERIES_BEST_N_MAX = 50;

/** Statuses whose standings count: a finished event, and one in progress (marked provisional). */
const COUNTED: ReadonlySet<TournamentStatus> = new Set(["active", "completed"]);

const coachKey = (value: string): string => value.normalize("NFC").trim().toLowerCase();

export function seriesPath(path: string): string | undefined {
  return path === "/api/series" || path.startsWith("/api/series/") ? path : undefined;
}

// ---- standings ------------------------------------------------------------------------------------------------------

export interface SeriesEventResult {
  tournamentId: string;
  /** The coach's points in that tournament (its own points system). */
  points: number;
  /** The coach's final (or current) place in that tournament. */
  rank: number;
  played: number;
  teamName?: string;
  /** bestN: false when this result is outside the coach's N best (shown, not added). */
  counted: boolean;
}

export interface SeriesStandingRow {
  rank: number;
  coach: string;
  total: number;
  eventsPlayed: number;
  /** Best single event result (tiebreak 1). */
  best: number;
  /** Games won against the coaches tied with this one on total and best (tiebreak 2). */
  headToHead: number;
  results: SeriesEventResult[];
}

export interface SeriesEvent {
  id: string;
  name: string;
  status: TournamentStatus;
  startsAt?: string;
  endsAt?: string;
  /** Counts toward the standings (active or completed). */
  counted: boolean;
  /** Active: its points can still change. */
  provisional: boolean;
}

export interface SeriesStandings {
  scoring: SeriesScoring;
  bestN?: number;
  /** Tiebreak order, for the page's footnote. */
  tiebreaks: readonly string[];
  events: SeriesEvent[];
  rows: SeriesStandingRow[];
}

export const SERIES_TIEBREAKS = ["total points", "best single result", "head-to-head wins", "name"] as const;

/**
 * The series standings from one snapshot (no writes). Each counted sub-tournament (active or completed) is ranked by
 * its own standings engine; a coach takes that event's points when they played at least one game (or had a bye).
 * `sum` adds every event; `bestN` adds each coach's N best (ties between equal results keep the earlier event).
 * Order: total points, then best single result, then head-to-head wins among the coaches still tied, then name.
 * Coaches tied on the first three share a rank.
 */
export function computeSeriesStandings(series: TournamentSeriesRecord, data: TournamentDataFileV4): SeriesStandings {
  const events: SeriesEvent[] = [];
  const byCoach = new Map<string, { coach: string; results: SeriesEventResult[] }>();
  // Wins of coach A over coach B across the counted events: "a\0b" -> wins.
  const wins = new Map<string, number>();
  for (const id of series.tournaments) {
    const tournament = data.tournaments[id];
    if (!tournament) continue;
    const counted = COUNTED.has(tournament.status);
    events.push({
      id, name: tournament.name, status: tournament.status, counted, provisional: tournament.status === "active",
      ...(tournament.startsAt ? { startsAt: tournament.startsAt } : {}),
      ...(tournament.endsAt ? { endsAt: tournament.endsAt } : {}),
    });
    if (!counted) continue;
    const entrants = Object.values(data.entrants).filter((entrant) => entrant.tournamentId === id);
    const matches = Object.values(data.scheduledMatches).filter((match) => match.tournamentId === id).sort((a, b) => a.id.localeCompare(b.id));
    const rows = calculateStandings(entrants, matches, tournament.points, tournament.tiebreakers);
    const teamOf = new Map(entrants.map((entrant) => [entrant.id, entrant.submission?.teamName]));
    for (const row of rows) {
      if (row.played < 1) continue;
      const key = coachKey(row.coachId);
      const entry = byCoach.get(key) ?? { coach: row.coachId, results: [] };
      entry.coach = row.coachId; // the latest event's spelling
      const teamName = teamOf.get(row.entrantId);
      entry.results.push({ tournamentId: id, points: row.points, rank: row.rank, played: row.played, ...(teamName ? { teamName } : {}), counted: true });
      byCoach.set(key, entry);
    }
    for (const match of matches) {
      if (match.status !== "completed" || !match.result || !match.away) continue;
      const home = coachKey(match.home.coach.ffbCoachId);
      const away = coachKey(match.away.coach.ffbCoachId);
      if (match.result.homeScore === match.result.awayScore) continue;
      const pair = match.result.homeScore > match.result.awayScore ? `${home}\0${away}` : `${away}\0${home}`;
      wins.set(pair, (wins.get(pair) ?? 0) + 1);
    }
  }

  const limit = series.scoring === "bestN" ? Math.max(1, series.bestN ?? 1) : Infinity;
  const rows: Array<SeriesStandingRow & { key: string }> = [...byCoach.entries()].map(([key, entry]) => {
    const order = entry.results.map((result, index) => ({ result, index }))
      .sort((a, b) => b.result.points - a.result.points || a.index - b.index);
    const kept = new Set(order.slice(0, limit).map((item) => item.index));
    const results = entry.results.map((result, index) => ({ ...result, counted: kept.has(index) }));
    return {
      key,
      rank: 0,
      coach: entry.coach,
      total: results.filter((result) => result.counted).reduce((sum, result) => sum + result.points, 0),
      eventsPlayed: results.length,
      best: Math.max(...results.map((result) => result.points)),
      headToHead: 0,
      results,
    };
  });

  // Head-to-head inside each group still tied on total and best.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = `${row.total}\0${row.best}`;
    groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.headToHead = group.reduce((sum, other) => (other === row ? sum : sum + (wins.get(`${row.key}\0${other.key}`) ?? 0)), 0);
    }
  }
  const byName = (a: string, b: string): number => a.localeCompare(b, "en", { sensitivity: "base" }) || (a < b ? -1 : a > b ? 1 : 0);
  rows.sort((a, b) => b.total - a.total || b.best - a.best || b.headToHead - a.headToHead || byName(a.coach, b.coach));
  rows.forEach((row, index) => {
    const prev = rows[index - 1];
    row.rank = prev && prev.total === row.total && prev.best === row.best && prev.headToHead === row.headToHead ? prev.rank : index + 1;
  });
  return {
    scoring: series.scoring,
    ...(series.scoring === "bestN" ? { bestN: series.bestN } : {}),
    tiebreaks: SERIES_TIEBREAKS,
    events,
    rows: rows.map(({ key: _key, ...row }) => row),
  };
}

// ---- validation -------------------------------------------------------------------------------------------------------

export interface SeriesApiIdentity {
  coach: string;
  organizer: boolean;
  admin: boolean;
}

export interface SeriesApiDeps {
  store: TournamentStore;
  /** The stored spelling of a registered coach id, or undefined when nobody has that id. */
  registeredCoach?(coachId: string): string | undefined;
  ifMatch?: string;
  now?: () => Date;
}

export interface SeriesApiResult {
  status: number;
  body: unknown;
}

function fail(status: 400 | 401 | 403 | 404 | 409 | 428, message: string): never {
  throw new TournamentStoreError(status, message);
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined) return required ? fail(400, `${field} is required.`) : undefined;
  if (typeof value !== "string") fail(400, `${field} must be text.`);
  const trimmed = (value as string).trim();
  if (required && !trimmed) fail(400, `${field} is required.`);
  if (trimmed.length > max) fail(400, `${field} must be at most ${max} characters.`);
  return trimmed;
}

function organisersField(value: unknown, deps: SeriesApiDeps): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(400, "organisers must be a list of coach names.");
  const out: string[] = [];
  for (const raw of value as string[]) {
    const name = raw.trim();
    if (!name) continue;
    const stored = deps.registeredCoach ? deps.registeredCoach(name) : name;
    if (!stored) fail(400, `"${name}" is not a registered coach.`);
    if (!out.some((existing) => coachKey(existing) === coachKey(stored!))) out.push(stored!);
  }
  if (out.length > SERIES_ORGANISERS_MAX) fail(400, `A series can have at most ${SERIES_ORGANISERS_MAX} organisers.`);
  return out;
}

function parseSeriesInput(input: Record<string, unknown>, deps: SeriesApiDeps, creating: boolean): Partial<SeriesInput> {
  const out: Partial<SeriesInput> = {};
  const name = text(input.name, "name", SERIES_NAME_MAX, creating);
  if (name !== undefined) out.name = name;
  const description = text(input.description, "description", SERIES_DESCRIPTION_MAX, false);
  if (description !== undefined) out.description = description;
  const organisers = organisersField(input.organisers, deps);
  if (organisers !== undefined) out.organisers = organisers;
  if (input.scoring !== undefined || creating) {
    if (!SERIES_SCORING.includes(input.scoring as SeriesScoring)) fail(400, "scoring must be sum or bestN.");
    out.scoring = input.scoring as SeriesScoring;
  }
  if (input.bestN !== undefined && input.bestN !== null) {
    if (!Number.isSafeInteger(input.bestN) || (input.bestN as number) < 1 || (input.bestN as number) > SERIES_BEST_N_MAX)
      fail(400, `bestN must be a whole number from 1 to ${SERIES_BEST_N_MAX}.`);
    out.bestN = input.bestN as number;
  }
  if (out.scoring === "bestN" && out.bestN === undefined && creating) fail(400, "bestN is required when scoring is bestN.");
  if (input.seeding !== undefined || creating) {
    if (!SERIES_SEEDINGS.includes(input.seeding as SeriesSeeding)) fail(400, "seeding must be dutch, monrad or elo.");
    out.seeding = input.seeding as SeriesSeeding;
  }
  return out;
}

// ---- access -------------------------------------------------------------------------------------------------------------

/** Series organiser (case-insensitive coach id) or admin. */
export function canEditSeries(series: TournamentSeriesRecord, auth: SeriesApiIdentity | undefined): boolean {
  if (!auth) return false;
  if (auth.admin) return true;
  return series.organisers.some((organiser) => coachKey(organiser) === coachKey(auth.coach));
}

/** A tournament the actor may put in (or take out of) a series: one they manage, or any for an admin. */
function canMoveTournament(tournament: TournamentRecord, auth: SeriesApiIdentity): boolean {
  return auth.admin || isTournamentManager(tournament, auth.coach);
}

function authenticated(auth: SeriesApiIdentity | undefined): SeriesApiIdentity {
  return auth ?? fail(401, "Authentication required.");
}

function revisionOf(input: Record<string, unknown>, deps: SeriesApiDeps, current: number): number {
  const asked = requestRevision(input, deps.ifMatch);
  if (asked === "missing") throw Object.assign(new TournamentStoreError(428, "Send the series revision you loaded (revision or If-Match)."), { revision: current });
  if (asked === "bad") fail(400, "revision must be a whole number.");
  return asked as number;
}

function jsonObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) fail(400, "A JSON object is required.");
  return body as Record<string, unknown>;
}

function decoded(value: string): string {
  try { return decodeURIComponent(value); } catch { return fail(400, "Invalid id."); }
}

// ---- read models ----------------------------------------------------------------------------------------------------------

/** The public series card: no createdBy (the organisers list is the public "run by"). */
function clientSeries(series: TournamentSeriesRecord, auth: SeriesApiIdentity | undefined) {
  const { createdBy: _createdBy, ...record } = series;
  return { ...record, canEdit: canEditSeries(series, auth) };
}

function seriesSummary(series: TournamentSeriesRecord, data: TournamentDataFileV4, auth: SeriesApiIdentity | undefined) {
  const statuses = series.tournaments.map((id) => data.tournaments[id]?.status).filter(Boolean) as TournamentStatus[];
  const dates = series.tournaments.map((id) => data.tournaments[id]?.startsAt).filter((d): d is string => Boolean(d)).sort();
  return {
    ...clientSeries(series, auth),
    tournamentCount: statuses.length,
    activeCount: statuses.filter((s) => s === "active").length,
    completedCount: statuses.filter((s) => s === "completed").length,
    ...(dates.length ? { firstStartsAt: dates[0], lastStartsAt: dates[dates.length - 1] } : {}),
  };
}

/** Tournaments the viewer may add: ones they manage (admins: any) that are not cancelled and in no series. */
function attachable(data: TournamentDataFileV4, auth: SeriesApiIdentity) {
  return Object.values(data.tournaments)
    .filter((t) => t.status !== "cancelled" && !(t.seriesId && data.series?.[t.seriesId]) && canMoveTournament(t, auth))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .slice(0, 200)
    .map((t) => ({ id: t.id, name: t.name, status: t.status }));
}

function seriesDetail(series: TournamentSeriesRecord, data: TournamentDataFileV4, auth: SeriesApiIdentity | undefined) {
  const editable = canEditSeries(series, auth);
  return {
    series: clientSeries(series, auth),
    standings: computeSeriesStandings(series, data),
    ...(editable && auth ? { attachable: attachable(data, auth) } : {}),
  };
}

// ---- routes -----------------------------------------------------------------------------------------------------------------

export function seriesApi(
  method: string,
  path: string,
  auth: SeriesApiIdentity | undefined,
  body: unknown,
  deps: SeriesApiDeps,
): SeriesApiResult | undefined {
  if (seriesPath(path) === undefined) return undefined;
  const now = deps.now?.() ?? new Date();
  try {
    if (path === "/api/series") {
      if (method === "GET") {
        const data = deps.store.snapshot();
        return { status: 200, body: { series: deps.store.seriesList().map((s) => seriesSummary(s, data, auth)) } };
      }
      if (method === "POST") {
        const identity = authenticated(auth);
        // Owner 10-28: admins AND organisers may create a series.
        if (!identity.admin && !identity.organizer) fail(403, "Organizer access required.");
        const input = parseSeriesInput(jsonObject(body), deps, true);
        const creator = deps.registeredCoach?.(identity.coach) ?? identity.coach;
        const organisers = [creator, ...(input.organisers ?? []).filter((o) => coachKey(o) !== coachKey(creator))];
        if (organisers.length > SERIES_ORGANISERS_MAX) fail(400, `A series can have at most ${SERIES_ORGANISERS_MAX} organisers.`);
        const series = deps.store.createSeries({
          name: input.name!, description: input.description ?? "", organisers, scoring: input.scoring!,
          ...(input.scoring === "bestN" ? { bestN: input.bestN } : {}), seeding: input.seeding!, createdBy: identity.coach,
        }, now);
        return { status: 201, body: { series: clientSeries(series, identity) } };
      }
      return { status: 405, body: { error: "Method not allowed." } };
    }

    const attach = path.match(/^\/api\/series\/([^/]+)\/tournaments\/([^/]+)$/);
    if (attach && (method === "POST" || method === "DELETE")) {
      const identity = authenticated(auth);
      const seriesId = decoded(attach[1]!);
      const tournamentId = decoded(attach[2]!);
      const series = deps.store.seriesRecord(seriesId) ?? fail(404, "Series not found.");
      if (!canEditSeries(series, identity)) fail(403, "You are not this series' organiser.");
      const tournament = deps.store.tournament(tournamentId) ?? fail(404, "Tournament not found.");
      if (!canMoveTournament(tournament, identity)) fail(403, "You can only add or remove tournaments you organise.");
      const revision = revisionOf(jsonObject(body), deps, series.revision);
      const updated = method === "POST"
        ? deps.store.attachToSeries(seriesId, tournamentId, revision, now)
        : deps.store.detachFromSeries(seriesId, tournamentId, revision, now);
      return { status: 200, body: seriesDetail(updated, deps.store.snapshot(), identity) };
    }

    const standings = path.match(/^\/api\/series\/([^/]+)\/standings$/);
    if (standings && method === "GET") {
      const data = deps.store.snapshot();
      const series = data.series?.[decoded(standings[1]!)] ?? fail(404, "Series not found.");
      return { status: 200, body: { seriesId: series.id, standings: computeSeriesStandings(series, data) } };
    }

    const detail = path.match(/^\/api\/series\/([^/]+)$/);
    if (detail) {
      const seriesId = decoded(detail[1]!);
      if (method === "GET") {
        const data = deps.store.snapshot();
        const series = data.series?.[seriesId] ?? fail(404, "Series not found.");
        return { status: 200, body: seriesDetail(series, data, auth) };
      }
      if (method === "PATCH" || method === "DELETE") {
        const identity = authenticated(auth);
        const series = deps.store.seriesRecord(seriesId) ?? fail(404, "Series not found.");
        if (!canEditSeries(series, identity)) fail(403, "You are not this series' organiser.");
        const input = jsonObject(body);
        const revision = revisionOf(input, deps, series.revision);
        if (method === "DELETE") {
          deps.store.deleteSeries(seriesId, revision, now);
          return { status: 200, body: { ok: true } };
        }
        const patch = parseSeriesInput(input, deps, false);
        if (patch.organisers !== undefined && patch.organisers.length === 0) fail(400, "A series needs at least one organiser.");
        const updated = deps.store.updateSeries(seriesId, revision, patch, now);
        return { status: 200, body: seriesDetail(updated, deps.store.snapshot(), identity) };
      }
    }
    return undefined;
  } catch (error) {
    if (error instanceof TournamentStoreError) {
      const revision = (error as { revision?: number }).revision;
      return { status: error.status, body: { error: error.message, ...(revision === undefined ? {} : { revision }) } };
    }
    throw error;
  }
}

/** The series a tournament belongs to, for its page's chip: id and name, or undefined. */
export function seriesChip(store: TournamentStore, tournament: Pick<TournamentRecord, "seriesId">): { id: string; name: string } | undefined {
  if (!tournament.seriesId) return undefined;
  const series = store.seriesRecord(tournament.seriesId);
  return series ? { id: series.id, name: series.name } : undefined;
}
