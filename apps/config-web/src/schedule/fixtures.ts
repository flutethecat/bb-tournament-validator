// The fixtures a game-time proposal can name (ruling §7: organisers and admins create fixtures; coaches only agree a
// TIME for one). Two sources, both existing records:
//
//   league:<leagueId>:<seasonId>:<fixtureId>   an open fixture of an ACTIVE league season (leagues/store.ts)
//   tournament:<matchId>                       an open scheduled match of an ACTIVE tournament (tournaments/store.ts)
//
// A coach is a participant when they hold one side's seat: for a league fixture the seat owner rule of the sidebar
// (seatAccounts below = myLeagues.ts seatOwners with the identity store's key: an organiser's assignment, else the team's account, else the coach aliases), for a tournament
// match the side's verified coach. The agreed time is written onto the fixture record itself (`scheduledTime`); nothing
// here ever creates, deletes or re-pairs a fixture.
//
// The league index (coach key -> entries, ref -> entry) is rebuilt when the league store reports a write
// (LeagueStore.version()) or after INDEX_TTL_MS; tournament matches are read per call (one small JSON file).

import { buildCoachAliases, seasonCoachFacets } from "../leagues/identity.js";
import { effectiveDeadline, fixtureOpenForDeadline } from "../leagues/deadlines.js";
import { INDEX_TTL_MS } from "../leagues/myLeagues.js";
import type { CoachAliases } from "../leagues/identity.js";
import type { LeagueStore } from "../leagues/store.js";
import type { FixtureSide, LeagueFixture, LeagueTeam, SeasonRecord } from "../leagues/types.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord } from "../tournaments/types.js";
import { scheduleKey, SLOT_MS } from "./store.js";

/** The agreed time written onto a fixture record by an accepted proposal. */
export interface AgreedTime { start: string; end: string; agreedAt: string }

export interface FixtureEntry {
  ref: string;
  kind: "league" | "tournament";
  /** The fixture's round number. */
  round: number;
  competition: string;
  /** Home and away: team name and the coach keys that hold the seat (normalised; [] = nobody linked). */
  sides: { home: { team: string; coach: string; owners: string[] }; away: { team: string; coach: string; owners: string[] } };
  /** Effective deadline (UTC ISO) when one is set. */
  deadline?: string;
  scheduled?: AgreedTime;
  /** SPA path (router form, no /app prefix): the fixture lobby, or the tournament's rounds. */
  link: string;
  /** Still to be played (no result, not suspended or closed). Closed fixtures are not indexed. */
  open: true;
}

export interface FixtureSource {
  /** Open fixtures where the coach holds a seat. */
  forCoach(coach: string): FixtureEntry[];
  /** One open fixture by ref (undefined = unknown, closed, or its competition is not active). */
  byRef(ref: string): FixtureEntry | undefined;
  /** Writes the agreed time onto the fixture. Throws when the fixture is gone or closed. */
  setTime(ref: string, time: AgreedTime): void;
}

const enc = encodeURIComponent;
/** Team-name matching only (fixture side -> season team): inner whitespace folded. Never used for coach accounts. */
const teamKey = (v: string | undefined): string => (v ?? "").trim().replace(/\s+/g, " ").toLowerCase();
/** Coach accounts: EXACTLY the identity store's key (scheduleKey = privacy/fence coachKey = normalizeFfbCoachId). */
export const accountKey = (v: string | undefined): string => scheduleKey(v ?? "");

/**
 * Who holds a league team's seat, keyed by the identity store's key (the sidebar's seatOwners rule, myLeagues.ts, without
 * its whitespace folding, so "A B" never stands in for "A  B"): an organiser's assignment decides alone (cleared = nobody);
 * else the team's account; only a team with neither falls back to the coach aliases over the accounts seen in the league.
 */
export function seatAccounts(team: LeagueTeam, aliases: CoachAliases, observedIds: Iterable<string>): string[] {
  if (team.coachAssigned) return team.coachAssigned.cleared || !accountKey(team.coachId) ? [] : [accountKey(team.coachId)];
  if (accountKey(team.coachId)) return [accountKey(team.coachId)];
  if (!accountKey(team.coach)) return [];
  const key = aliases.key({ coach: team.coach, ...(team.nafUser ? { nafUser: team.nafUser } : {}) });
  const owners = new Set<string>();
  for (const id of observedIds) if (aliases.key({ coachId: id }) === key) owners.add(accountKey(id));
  // An account whose id is the unlinked display name itself (exact identity key only).
  if (key === `name:${teamKey(team.coach)}`) owners.add(accountKey(team.coach));
  return [...owners];
}

export function leagueRef(leagueId: string, seasonId: string, fixtureId: string): string { return `league:${leagueId}:${seasonId}:${fixtureId}`; }
export function tournamentRef(matchId: string): string { return `tournament:${matchId}`; }

export type ParsedRef = { kind: "league"; leagueId: string; seasonId: string; fixtureId: string } | { kind: "tournament"; matchId: string };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MATCH_ID = /^[A-Za-z0-9_.:-]{1,120}$/;
export const REF_MAX = 260;

export function parseRef(ref: unknown): ParsedRef | undefined {
  if (typeof ref !== "string" || ref.length > REF_MAX) return undefined;
  if (ref.startsWith("tournament:")) {
    const matchId = ref.slice("tournament:".length);
    return MATCH_ID.test(matchId) ? { kind: "tournament", matchId } : undefined;
  }
  const m = ref.match(/^league:([^:]+):([^:]+):(.{1,80})$/s);
  if (!m || !SLUG.test(m[1]!) || !SLUG.test(m[2]!) || /[/\\\u0000-\u001f]/.test(m[3]!)) return undefined;
  return { kind: "league", leagueId: m[1]!, seasonId: m[2]!, fixtureId: m[3]! };
}

const validIso = (v: unknown): string | undefined => (typeof v === "string" && v.length <= 64 && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : undefined);

function agreed(v: unknown): AgreedTime | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const start = validIso(o.start);
  const end = validIso(o.end);
  if (!start || !end) return undefined;
  return { start, end, agreedAt: validIso(o.agreedAt) ?? start };
}

// ---- league fixtures ------------------------------------------------------------------------------------------------

function teamOf(season: SeasonRecord, side: FixtureSide): LeagueTeam | undefined {
  if (side.teamId) return season.teams.find((t) => t.id === side.teamId);
  const name = teamKey(side.team);
  return name ? season.teams.find((t) => teamKey(t.name) === name) : undefined;
}

interface LeagueIndex { version: number; at: number; byCoach: Map<string, FixtureEntry[]>; byRef: Map<string, FixtureEntry> }
const leagueIndexes = new WeakMap<LeagueStore, LeagueIndex>();

function buildLeagueIndex(store: LeagueStore): Pick<LeagueIndex, "byCoach" | "byRef"> {
  const byCoach = new Map<string, FixtureEntry[]>();
  const byRef = new Map<string, FixtureEntry>();
  for (const lg of store.list()) {
    const active = store.seasons(lg.id).filter((s) => s.status === "active");
    if (!active.length) continue;
    const aliases = buildCoachAliases((function* () { for (const s of active) yield* seasonCoachFacets(s); })());
    const observed = new Set<string>();
    for (const s of active) for (const f of seasonCoachFacets(s)) if (accountKey(f.coachId)) observed.add(f.coachId!.trim());
    for (const season of active) {
      const owners = new Map<string, string[]>();
      for (const t of season.teams) owners.set(t.id, seatAccounts(t, aliases, observed));
      for (const f of season.fixtures) {
        if (!fixtureOpenForDeadline(f)) continue;
        const home = teamOf(season, f.home);
        const away = teamOf(season, f.away);
        const entry: FixtureEntry = {
          ref: leagueRef(lg.id, season.id, f.id),
          kind: "league",
          round: f.round,
          competition: `${lg.name} · ${season.name || `Season ${season.number}`}`,
          sides: {
            home: { team: f.home.team ?? "", coach: f.home.coach ?? "", owners: home ? owners.get(home.id) ?? [] : [] },
            away: { team: f.away.team ?? "", coach: f.away.coach ?? "", owners: away ? owners.get(away.id) ?? [] : [] },
          },
          ...(effectiveDeadline(season, f) ? { deadline: effectiveDeadline(season, f)! } : {}),
          ...(agreed((f as LeagueFixture).scheduledTime) ? { scheduled: agreed(f.scheduledTime)! } : {}),
          link: `/leagues/${enc(lg.id)}/seasons/${enc(season.id)}/fixtures/${enc(f.id)}/lobby`,
          open: true,
        };
        byRef.set(entry.ref, entry);
        for (const key of new Set([...entry.sides.home.owners, ...entry.sides.away.owners])) byCoach.set(key, [...(byCoach.get(key) ?? []), entry]);
      }
    }
  }
  return { byCoach, byRef };
}

function leagueIndex(store: LeagueStore, now: number): LeagueIndex {
  let idx = leagueIndexes.get(store);
  if (!idx || idx.version !== store.version() || now - idx.at >= INDEX_TTL_MS) {
    idx = { version: store.version(), at: now, ...buildLeagueIndex(store) };
    leagueIndexes.set(store, idx);
  }
  return idx;
}

/** Tests: forget the cached league index. */
export function clearScheduleIndex(store: LeagueStore): void { leagueIndexes.delete(store); }

// ---- tournament matches ---------------------------------------------------------------------------------------------

const MATCH_CLOSED = new Set(["completed", "cancelled", "dismissed"]);

function tournamentEntries(store: TournamentStore): FixtureEntry[] {
  const snap = store.snapshot();
  const out: FixtureEntry[] = [];
  for (const m of Object.values(snap.scheduledMatches)) {
    if (!m.away || m.result || MATCH_CLOSED.has(m.status)) continue;
    const t = snap.tournaments[m.tournamentId];
    if (!t || t.status !== "active") continue;
    const teamName = (entrantId: string) => snap.entrants[entrantId]?.submission?.teamName ?? "";
    // A dropped entrant loses the seat (and with it any say over the time): the match is not offered to either side.
    if (snap.entrants[m.home.entrantId]?.droppedAt || snap.entrants[m.away.entrantId]?.droppedAt) continue;
    const side = (s: NonNullable<ScheduledMatchRecord["away"]>) => ({ team: teamName(s.entrantId), coach: s.coach.ffbCoachId, owners: accountKey(s.coach.ffbCoachId) ? [accountKey(s.coach.ffbCoachId)] : [] });
    const deadline = validIso((m as ScheduledMatchRecord & { deadline?: unknown }).deadline);
    const scheduled = agreed(m.scheduledTime);
    out.push({
      ref: tournamentRef(m.id),
      kind: "tournament",
      round: m.roundNumber,
      competition: t.name,
      sides: { home: side(m.home), away: side(m.away) },
      ...(deadline ? { deadline } : {}),
      ...(scheduled ? { scheduled } : {}),
      link: `/tournaments/${enc(t.id)}?tab=rounds`,
      open: true,
    });
  }
  return out;
}

// ---- the source -----------------------------------------------------------------------------------------------------

export function createFixtureSource(deps: { leagues: LeagueStore; tournaments: TournamentStore; now?: () => number }): FixtureSource {
  const now = () => deps.now?.() ?? Date.now();
  const safeTournaments = (): FixtureEntry[] => { try { return tournamentEntries(deps.tournaments); } catch { return []; } };
  const safeLeague = (): LeagueIndex | undefined => { try { return leagueIndex(deps.leagues, now()); } catch { return undefined; } };
  return {
    forCoach(coach) {
      const key = accountKey(coach);
      if (!key) return [];
      const league = safeLeague()?.byCoach.get(key) ?? [];
      const tour = safeTournaments().filter((e) => e.sides.home.owners.includes(key) || e.sides.away.owners.includes(key));
      return structuredClone([...league, ...tour]);
    },
    byRef(ref) {
      const parsed = parseRef(ref);
      if (!parsed) return undefined;
      if (parsed.kind === "league") {
        const hit = safeLeague()?.byRef.get(ref);
        return hit ? structuredClone(hit) : undefined;
      }
      return safeTournaments().find((e) => e.ref === ref);
    },
    setTime(ref, time) {
      const parsed = parseRef(ref);
      if (!parsed) throw new Error("Unknown fixture.");
      if (parsed.kind === "league") {
        const season = deps.leagues.season(parsed.leagueId, parsed.seasonId);
        const f = season?.status === "active" ? season.fixtures.find((x) => x.id === parsed.fixtureId) : undefined;
        if (!season || !f || !fixtureOpenForDeadline(f)) throw new Error("The fixture is no longer open.");
        f.scheduledTime = { start: time.start, end: time.end, agreedAt: time.agreedAt };
        deps.leagues.putSeason(season);
        return;
      }
      // Tournament matches: the agreed time only (no revision bump, so a coach mid-launch is not refused for a stale revision).
      const data = deps.tournaments.snapshot();
      const m = data.scheduledMatches[parsed.matchId];
      const t = m ? data.tournaments[m.tournamentId] : undefined;
      if (!m || !t || t.status !== "active" || !m.away || m.result || MATCH_CLOSED.has(m.status)) throw new Error("The fixture is no longer open.");
      if (data.entrants[m.home.entrantId]?.droppedAt || data.entrants[m.away.entrantId]?.droppedAt) throw new Error("The fixture is no longer open.");
      m.scheduledTime = { start: time.start, end: time.end, agreedAt: time.agreedAt };
      deps.tournaments.writeSnapshot(data);
    },
  };
}

/** The 2-hour slot that starts at `start` (UTC ISO). */
export const slotOf = (start: string): { start: string; end: string } => ({ start, end: new Date(Date.parse(start) + SLOT_MS).toISOString() });
