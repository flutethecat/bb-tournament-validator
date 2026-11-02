/**
 * Tournament scheduled matches as fixture lobbies (spec §8-§9.3; the league adapter is league.ts). Route:
 *   GET|POST /api/tournaments/:id/fixtures/:matchId/lobby[/<action>]   (api.ts lobbyRoute; actions as there)
 * Lobby key `tournament:<matchId>` (the Schedule's tournament fixture ref); the recorder's fixtureRef is the match id.
 *
 * Visibility: the two entrants and that tournament's managers (owner, organisers) and site admins act; anyone else reads
 * a read-only view without chat, without unrevealed picks and without the snapshot roster (the submitted roster is the
 * coach's, the opponent's and the managers' business). A DRAFT tournament is hidden from everyone but its managers (the
 * honours rule, honours.ts tournamentVisible): 404 as if it did not exist. Public read on both gate paths
 * (requireSession.ts and server.ts authorized()); writes need a session, the CSRF header and onboarding.
 *
 * What the tournament supplies:
 *   - the teams: each entrant's submitted roster (the snapshot taken at submission / Start), or the registered library
 *     team when nothing was submitted. The roster lock plays exactly that team (no free choice of recorder team) and is
 *     refused when the submitted Team Builder save changed after the snapshot;
 *   - inducement prices and caps from the tournament's package (`inducements.allowed` / `caps` / `rosterOnly`, the
 *     competition's opt-ins; star players only when the package allows stars), the same table the Builder judges with;
 *   - `inducements.treasuryTopUp` (absent = off, owner ruling §9.2) and `inducements.highlander` (absent = off);
 *   - inducements bought in the Builder: pre-filled and non-removable. They were paid from the roster's gold under the
 *     package's gold budget, so they cost nothing against petty cash; they do count against each inducement's cap.
 *
 * START: a tabletop tournament creates the recorder match (createMatch, fixtureRef = the match id) with both resolved
 * lists, exactly as league fixtures; a Super FUMBBL tournament (`playOnFork`) has no inducement step and START releases
 * the online launch (the waiting presence / launch routes refuse until then).
 */
import { inducementEnabled, type TournamentPackage } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { effectiveInducements, seasonInducementOffers } from "../leagues/inducements.js";
import type { SeasonInducements } from "../leagues/inducementRules.js";
import type { LeagueStore } from "../leagues/store.js";
import { rosterFor, type InducementOffers } from "../tabletop/pregame.js";
import type { TabletopTeamFile } from "../tabletop/postMatch.js";
import type { StoredTournamentResult } from "../tournamentResults.js";
import { tournamentVisible } from "../tournaments/honours.js";
import { calculateStandings } from "../tournaments/pairing.js";
import { isTournamentManager, tournamentOwner, type TournamentStore } from "../tournaments/store.js";
import type { ScheduledMatchRecord, TournamentRecord, TournamentSubmission } from "../tournaments/types.js";
import { lobbyRoute, type LobbyAuth, type LobbyDeps, type LobbyResult } from "./api.js";
import { STAR_PREFIX } from "./core.js";
import { agreedTime, coachHistory, headToHead, ratingsOf, statsOf, type Game } from "./league.js";
import type { CoachEloRating } from "../coachElo.js";
import { LOBBY_SIDES, type LobbyFixture, type LobbyFixtureSide, type LobbyPick, type LobbySide, type LobbyTeam } from "./types.js";

/** One side's team: the team file the lobby judges (race, TV, treasury, players) and what the Builder bought. */
export interface TournamentLobbyTeam {
  file: TabletopTeamFile;
  rostered: Array<{ key: string; count: number }>;
}

export interface TournamentLobbyDeps extends LobbyDeps {
  tournaments: TournamentStore;
  /** The resolved ruleset package (undefined = unreadable: no inducement step). */
  packageOf(name: string): TournamentPackage | undefined;
  /** The team a side plays: its submission snapshot, else the registered library team. undefined = cannot be read. */
  teamOf(coach: string, submission: TournamentSubmission | undefined, libraryTeamId: string): TournamentLobbyTeam | undefined;
  /** false = the submitted Team Builder save changed after the snapshot (the recorder would play another roster). */
  submissionCurrent?(coach: string, submission: TournamentSubmission): boolean;
  /** League fixtures for the coaches' all-time statistics and head-to-head (absent = results store only). */
  leagues?: LeagueStore;
  results?: () => StoredTournamentResult[];
  resultsRevision?: () => string;
  /** The coaches' site rating (the existing Elo) for the fixture summary's coach cards. */
  ratings?: () => ReadonlyMap<string, CoachEloRating>;
  /** When the recorder's chain for a coach's save started (its baseline revision's createdAt); undefined = no chain. */
  chainStartedAt?(coach: string, saveId: string): Promise<string | undefined>;
}

export const LOBBY_BODY_MAX = 16 * 1024;
export const tournamentLobbyKey = (matchId: string): string => `tournament:${matchId}`;
const LOBBY_PATH = /^\/api\/tournaments\/([^/]+)\/fixtures\/([^/]+)\/lobby(?:\/([^/]+))?$/;
/** The lobby route's path, or undefined. */
export const tournamentLobbyPath = (path: string): { tournamentId: string; matchId: string; action?: string } | undefined => {
  const m = LOBBY_PATH.exec(path);
  if (!m) return undefined;
  try {
    return { tournamentId: decodeURIComponent(m[1]!), matchId: decodeURIComponent(m[2]!), ...(m[3] ? { action: m[3] } : {}) };
  } catch { return undefined; }
};

const enc = encodeURIComponent;
const same = (a: string | undefined, b: string | undefined): boolean => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
const NO_STORE = { "cache-control": "private, no-store" };
const fail = (status: number, error: string): LobbyResult => ({ status, headers: NO_STORE, body: { error } });
// an empty league store (a host without leagues): coachHistory then reads the results store only
const NO_LEAGUES = { version: () => "0", list: () => [], seasons: () => [] } as unknown as LeagueStore;

/** One lobby request. `input` is the parsed JSON body of a POST ({} for a GET). undefined = not a lobby path. */
export async function tournamentLobbyRoute(
  method: string, path: string, auth: LobbyAuth | undefined, input: Record<string, unknown>, deps: TournamentLobbyDeps,
): Promise<LobbyResult | undefined> {
  const at = tournamentLobbyPath(path);
  if (!at) return undefined;
  const t = deps.tournaments.tournament(at.tournamentId);
  // a draft is its managers' business only (as Statistics / Honours): the same 404 as an unknown id
  if (!t || !tournamentVisible(t, auth ? { coach: auth.coach, organizer: false, admin: auth.admin } : undefined)) return fail(404, "Tournament not found.");
  const m = deps.tournaments.match(at.matchId);
  if (!m || m.tournamentId !== t.id) return fail(404, "Fixture not found.");
  if (!m.away) return fail(404, "A bye has no fixture lobby.");
  return lobbyRoute(method, at.action, tournamentLobbyFixture(t, m, auth, deps), auth, input, withSubmittedChain(t, deps));
}

/**
 * The recorder plays a save from its chain (src/tabletop ensureChain): a chain that started BEFORE the submitted save
 * revision was built from an older version of the roster, so START refuses (the organiser sorts it out) rather than
 * play another roster than the submitted one. A chain started at or after the submitted revision holds exactly it (the
 * save has not changed since: the roster lock checks that).
 */
function withSubmittedChain(t: TournamentRecord, deps: TournamentLobbyDeps): TournamentLobbyDeps {
  const start = deps.startTabletop;
  const startedAt = deps.chainStartedAt;
  if (!start || !startedAt) return deps;
  return {
    ...deps,
    startTabletop: async (input) => {
      for (const sd of [input.home, input.away]) {
        const sub = deps.tournaments.entrants(t.id).find((e) => !e.droppedAt && same(e.coach.ffbCoachId, sd.coach))?.submission;
        if (!sub || !sub.saveId.startsWith("save:") || sd.team !== sub.saveId) continue;
        const began = await startedAt(sd.coach, sub.saveId.slice("save:".length));
        if (began && began < sub.revision)
          return { status: 409, body: { error: `${sub.teamName ?? "This team"}: the match recorder already holds this team from an older version of the save than the one submitted, so it cannot play the submitted roster. Ask an organiser.` } };
      }
      return start(input);
    },
  };
}

// ---- inducements from the package ----------------------------------------------------------------------------------

/** The package's inducement rules as a season-style table: allowed ids on (opt-ins only when the competition enables
 *  them), package caps, star players only when the package allows stars. */
export function packageInducementConfig(pkg: TournamentPackage, optIns: readonly string[]): SeasonInducements {
  const all = pkg.inducements.allowed.includes("*");
  const standard: SeasonInducements["standard"] = {};
  for (const [id, row] of Object.entries(bb2025.inducements)) {
    const allowed = (all || pkg.inducements.allowed.includes(id)) && (id !== "star_players" || pkg.starPlayers.allowed !== false);
    const cap = pkg.inducements.caps[id];
    standard[id] = { enabled: allowed && inducementEnabled(row, id, optIns), ...(typeof cap === "number" && Number.isInteger(cap) && cap >= 0 ? { cap } : {}) };
  }
  return { standard, custom: [], revision: 0 };
}

/** Offers judged by the package: the table above plus `inducements.rosterOnly` (e.g. a Halfling-only chef). */
function packageOffers(pkg: TournamentPackage, config: SeasonInducements, optIns: readonly string[]): InducementOffers {
  const { offers } = seasonInducementOffers(config, optIns);
  return (file, id) => {
    const only = pkg.inducements.rosterOnly?.[id];
    if (only?.length) {
      const roster = (rosterFor(file)?.name ?? file.race ?? "").toLowerCase();
      if (!only.some((r) => r.toLowerCase() === roster)) return { error: `${bb2025.inducements[id]?.name ?? id} is only for ${only.join(", ")} teams in this tournament.` };
    }
    return offers(file, id);
  };
}

/** The lobby rules a package sets (§9.2: treasury top-up off in tournaments unless the package turns it on). */
export function packageLobbyRules(pkg: TournamentPackage | undefined): LobbyFixture["rules"] {
  const ind = (pkg?.inducements ?? {}) as { treasuryTopUp?: unknown; highlander?: unknown };
  return { treasuryTopUp: ind.treasuryTopUp === true, highlander: ind.highlander === true, starClash: "refund" };
}

/** The package's star limits (`starPlayers.maxCount` / `maxCombinedCost`) over the roster's stars plus the hired ones. */
export function packageStarLimit(pkg: TournamentPackage | undefined, roster: { count: number; cost: number }, lines: ReadonlyArray<{ id: string; cost: number }>): string {
  const hired = lines.filter((l) => l.id.startsWith(STAR_PREFIX));
  if (!pkg || !hired.length) return "";
  const { maxCount, maxCombinedCost, paidInSkillPoints } = pkg.starPlayers;
  const count = roster.count + hired.length;
  if (typeof maxCount === "number" && count > maxCount)
    return `This tournament allows at most ${maxCount} star player${maxCount === 1 ? "" : "s"} per team${roster.count ? ` (${roster.count} already on the roster)` : ""}.`;
  const cost = (paidInSkillPoints ? 0 : roster.cost) + hired.reduce((n, l) => n + l.cost, 0);
  if (typeof maxCombinedCost === "number" && cost > maxCombinedCost)
    return `Star players may cost at most ${Math.round(maxCombinedCost / 1000)}K together in this tournament${roster.cost && !paidInSkillPoints ? " (roster stars included)" : ""}.`;
  return "";
}

// ---- the fixture ----------------------------------------------------------------------------------------------------

function lobbyTeam(file: TabletopTeamFile | undefined, name: string, race: string, id: string, starsOn: boolean): LobbyTeam {
  const f: TabletopTeamFile = file ?? { schema: 1, name, race, treasury: 0, dedicatedFans: 1, players: [] };
  const roster = rosterFor(f);
  const stars = (roster && starsOn ? bb2025.stars : [])
    .filter((s) => s.teams.includes(roster!.name) && typeof s.cost === "number" && s.cost > 0 && !s.pairedWith)
    .map((s) => ({ name: s.name, cost: s.cost as number }))
    .sort((a, b) => a.cost - b.cost || a.name.localeCompare(b.name));
  const players = f.players.filter((p) => !p.dead && !p.journeyman).sort((a, b) => (a.number ?? 99) - (b.number ?? 99));
  const position = (pid: string | undefined, pname: string | undefined) => pname ?? roster?.positions.find((p) => p.id === pid)?.name ?? pid ?? "";
  return {
    id, name: f.name || name, race: race || roster?.name || f.race || "", tv: typeof f.teamValue === "number" ? f.teamValue : null,
    treasury: Math.max(0, f.treasury ?? 0), rerolls: f.rerolls ?? null, apothecary: f.apothecary === true, fans: f.dedicatedFans ?? null,
    assistantCoaches: f.assistantCoaches ?? null, cheerleaders: f.cheerleaders ?? null, playerCount: players.length,
    roster: players.slice(0, 3).map((p) => ({ number: p.number ?? null, name: p.name, position: position(p.positionId, p.positionName), skills: p.skills.slice(0, 6), spp: p.spp ?? 0 })),
    file: { ...f, ...(roster && !f.race ? { race: roster.name } : {}) }, stars,
  };
}

const OUT = { W: "W", D: "D", L: "L" } as const;
/** The coach's games in this tournament (completed fixtures with a result). */
function tournamentGames(matches: readonly ScheduledMatchRecord[], coach: string): Game[] {
  const out: Game[] = [];
  for (const m of matches) {
    if (!m.result || !m.away) continue;
    for (const s of LOBBY_SIDES) {
      if (!same(m[s]?.coach.ffbCoachId, coach)) continue;
      const mine = s === "home" ? m.result.homeScore : m.result.awayScore;
      const theirs = s === "home" ? m.result.awayScore : m.result.homeScore;
      const cas = (s === "home" ? m.result.homeCasualties : m.result.awayCasualties) ?? 0;
      out.push({ at: m.result.reportedAt, outcome: OUT[mine > theirs ? "W" : mine < theirs ? "L" : "D"], td: mine, cas });
    }
  }
  return out;
}

const CLOSED: Record<string, string> = {
  draft: "This tournament has not started yet.", completed: "This tournament is finished.", cancelled: "This tournament was cancelled.",
};

export function tournamentLobbyFixture(t: TournamentRecord, m: ScheduledMatchRecord, auth: LobbyAuth | undefined, deps: TournamentLobbyDeps): LobbyFixture {
  const pkg = (() => { try { return deps.packageOf(t.packageName); } catch { return undefined; } })();
  const optIns = t.inducementOptIns ?? [];
  const config = pkg ? packageInducementConfig(pkg, optIns) : undefined;
  const offers = pkg && config ? packageOffers(pkg, config, optIns) : seasonInducementOffers(undefined).offers;
  const table = effectiveInducements(config);
  const starsOn = Boolean(config?.standard.star_players?.enabled);
  const entrants = deps.tournaments.entrants(t.id);
  const matches = deps.tournaments.matches(t.id);
  const standings = (() => { try { return calculateStandings(entrants, matches, t.points, t.tiebreakers); } catch { return []; } })();
  const base = `/tournaments/${enc(t.id)}`;
  const coachIds = { home: m.home.coach.ffbCoachId, away: m.away?.coach.ffbCoachId ?? "" };
  const history = coachHistory(deps.leagues ?? NO_LEAGUES, deps, coachIds);
  const prefilled: Record<LobbySide, LobbyPick[]> = { home: [], away: [] };
  const fixedTeams = {} as NonNullable<LobbyFixture["fixedTeams"]>;
  const teamLinks: Partial<Record<LobbySide, string>> = {};
  const rosterStars: Record<LobbySide, { count: number; cost: number }> = { home: { count: 0, cost: 0 }, away: { count: 0, cost: 0 } };
  const withdrawn: string[] = [];
  const rate = ratingsOf(deps);
  const side = (s: LobbySide): LobbyFixtureSide => {
    const ms = m[s]!;
    const entrant = entrants.find((e) => e.id === ms.entrantId);
    // a withdrawn (dropped) entrant loses the seat: no coach account on the side, so they read as a spectator
    const dropped = !entrant || entrant.droppedAt !== undefined;
    if (dropped) withdrawn.push(ms.coach.ffbCoachId);
    const cid = dropped ? "" : ms.coach.ffbCoachId;
    const submission = entrant?.submission;
    const data = (() => { try { return deps.teamOf(cid, submission, ms.teamId); } catch { return undefined; } })();
    const name = submission?.teamName ?? data?.file.name ?? ms.teamId;
    // stars already on the roster count against the package's star limits
    for (const p of data?.file.players ?? []) {
      if (p.kind !== "star" || p.dead) continue;
      rosterStars[s].count += 1;
      rosterStars[s].cost += bb2025.stars.find((x) => x.name === p.positionName || x.name === p.name)?.cost ?? 0;
    }
    const team = lobbyTeam(data?.file, name, submission?.race ?? data?.file.race ?? "", entrant?.id ?? ms.entrantId, starsOn);
    // what the Builder bought (stars are roster players, never lobby inducements)
    prefilled[s] = (data?.rostered ?? [])
      .filter((r) => typeof r.key === "string" && r.key && !r.key.startsWith(STAR_PREFIX) && r.key !== "star_players" && Number.isInteger(r.count) && r.count > 0)
      .map((r) => ({ id: r.key, qty: Math.min(16, r.count) }));
    const ref = submission?.saveId ?? `library:${ms.teamId}`;
    fixedTeams[s] = !data ? { error: `${team.name}: the tournament team cannot be read right now. Ask an organiser.` }
      : submission && submission.saveId.startsWith("save:") && deps.submissionCurrent?.(cid, submission) === false
        ? { error: `${team.name}: the Team Builder save changed after it was submitted, and this fixture plays the submitted roster. Ask an organiser.` }
        : { ref, name: team.name, race: team.race };
    teamLinks[s] = `${base}/team/${enc(ms.entrantId)}`;
    const row = standings.find((r) => r.entrantId === ms.entrantId);
    return {
      coachId: cid, coach: ms.coach.ffbCoachId, team,
      ...(row ? { standing: { rank: row.rank, points: row.points, group: "", played: row.played, wins: row.wins, draws: row.draws, losses: row.losses } } : {}),
      ...(rate ? { rating: rate(cid) } : {}),
      stats: {
        season: { ...statsOf(tournamentGames(matches, cid)), ...(row ? { points: row.points } : {}) },
        allTime: statsOf(history.games.get(cid.trim().toLowerCase()) ?? []),
      },
    };
  };
  const sides = { home: side("home"), away: side("away") };
  const closedReason = CLOSED[t.status]
    ?? (withdrawn.length ? `${withdrawn.join(" and ")} withdrew from the tournament.`
      : m.result || m.status === "completed" ? "This fixture has been played."
        : m.status === "cancelled" || m.status === "dismissed" ? "This fixture is not being played." : "");
  const managers = [...new Set([tournamentOwner(t), ...(t.organizerCoachIds ?? [])].filter((c): c is string => Boolean(c)))];
  return {
    key: tournamentLobbyKey(m.id),
    source: "tournament",
    mode: t.playOnFork === true ? "fork" : "tabletop",
    open: !closedReason,
    ...(closedReason ? { closedReason } : {}),
    header: {
      competition: t.name, round: m.roundNumber, rounds: t.roundCount,
      ...(m.scheduledTime ? { date: m.scheduledTime.start } : {}), ...(agreedTime(m.scheduledTime) ? { scheduled: agreedTime(m.scheduledTime)! } : {}), ruleset: t.packageName,
    },
    links: { competition: base, fixture: `${base}?tab=rounds`, standings: `${base}?tab=standings`, rules: base, lobby: `${base}/fixtures/${enc(m.id)}/lobby` },
    sides,
    rules: packageLobbyRules(pkg),
    noInducements: pkg ? "" : "This tournament's ruleset cannot be read, so inducements cannot be priced. Ask an organiser.",
    offers, ids: [...Object.keys(bb2025.inducements)], table,
    isOrganiser: (coach) => isTournamentManager(t, coach) || Boolean(auth?.admin && same(auth.coach, coach)),
    headToHead: headToHead(history.meetings, coachIds),
    organisers: managers,
    recorderTeamAllowed: (s, team) => { const f = fixedTeams[s]; return Boolean(f && !("error" in f) && f.ref === team.ref); },
    start: { fixtureRef: m.id, extra: {} },
    prefilled, fixedTeams, rosterPrivate: true, teamLinks,
    checkPicks: (s, lines) => packageStarLimit(pkg, rosterStars[s], lines),
  };
}
