// Tournament detail controller (/app/tournaments/:id): GET /api/tournaments/:id for Overview / Entrants / Rounds and
// GET /api/tournaments/:id/standings for Standings. Read-only and public. Fixtures are whatever the server sends
// (anonymous visitors get none today): the Rounds tab shows an empty state then. No DOM; rendered by the views.

import { reactive, type InjectionKey } from "vue";
import {
  ApiError,
  type TournamentDetailResponse,
  type TournamentEntrant,
  type TournamentFixture,
  type TournamentRound,
  type TournamentStandingRow,
  type TournamentSummary,
} from "../shared/api";
import type { Fetcher } from "../session";

export type DetailTab = "overview" | "entrants" | "rounds" | "standings";
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "entrants", label: "Entrants" },
  { id: "rounds", label: "Rounds" },
  { id: "standings", label: "Standings" },
];
export const isDetailTab = (v: unknown): v is DetailTab => DETAIL_TABS.some((t) => t.id === v);

export interface TournamentDetailState {
  id: string;
  tournament: TournamentSummary | null;
  entrants: TournamentEntrant[];
  rounds: TournamentRound[];
  fixtures: TournamentFixture[];
  standings: TournamentStandingRow[];
  standingsStatus: "idle" | "loading" | "ok" | "error";
  standingsError: string;
  loaded: boolean;
  loading: boolean;
  notFound: boolean;
  error: string;
}

/** Only http(s) image URLs are rendered as crests; anything else (data:, javascript:, relative junk) is dropped. */
export function safeCrestUrl(url: string | undefined | null): string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : "";
}

export function createTournamentDetail(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<TournamentDetailState>({
    id: "", tournament: null, entrants: [], rounds: [], fixtures: [], standings: [], standingsStatus: "idle", standingsError: "",
    loaded: false, loading: false, notFound: false, error: "",
  });

  // Request generations: a response is applied only if no newer request of its kind started (A -> B -> A safe).
  let loadGen = 0;
  let standingsGen = 0;
  const signedOut = (err: unknown): boolean => {
    if (err instanceof ApiError && err.status === 401 && deps.onSignedOut) { deps.onSignedOut(); return true; }
    return false;
  };

  /** `silent` = a background refresh: a failure other than 404 keeps what is on screen. */
  async function load(id: string, silent = false): Promise<void> {
    if (state.id !== id) {
      state.tournament = null; state.entrants = []; state.rounds = []; state.fixtures = [];
      state.standings = []; state.standingsStatus = "idle"; state.standingsError = "";
      standingsGen++;
    }
    state.id = id;
    const mine = ++loadGen;
    state.loading = true;
    try {
      const res = await deps.api<TournamentDetailResponse>(`/api/tournaments/${encodeURIComponent(id)}`);
      if (mine !== loadGen) return;
      state.tournament = res.tournament;
      state.entrants = res.entrants ?? [];
      state.rounds = [...(res.rounds ?? [])].sort((a, b) => a.number - b.number);
      state.fixtures = res.scheduledMatches ?? [];
      state.error = "";
      state.notFound = false;
    } catch (err) {
      if (mine !== loadGen) return;
      const notFound = err instanceof ApiError && err.status === 404;
      if (silent && !notFound && state.tournament) return;
      state.tournament = null;
      state.notFound = notFound;
      state.error = signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : "Can't load this tournament.";
    } finally {
      if (mine === loadGen) { state.loading = false; state.loaded = true; }
    }
  }

  async function loadStandings(silent = false): Promise<void> {
    const id = state.id;
    if (!id) return;
    const mine = ++standingsGen;
    if (!silent) state.standingsStatus = "loading";
    try {
      // GET /api/tournaments/:id/standings answers { tournamentId, standings: Row[] }.
      const res = await deps.api<{ standings?: TournamentStandingRow[] }>(`/api/tournaments/${encodeURIComponent(id)}/standings`);
      if (mine !== standingsGen) return;
      state.standings = Array.isArray(res?.standings) ? res.standings : [];
      state.standingsError = "";
      state.standingsStatus = "ok";
    } catch (err) {
      if (mine !== standingsGen) return;
      if (silent && state.standingsStatus === "ok") return;
      state.standings = [];
      state.standingsError = signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : "Can't load standings.";
      state.standingsStatus = "error";
    }
  }

  /** Background refresh: the tournament, and the standings if that tab has been opened. */
  async function refresh(): Promise<void> {
    if (!state.id) return;
    await Promise.all([load(state.id, true), state.standingsStatus === "idle" ? Promise.resolve() : loadStandings(true)]);
  }

  /** Loads what a tab needs the first time it is shown. */
  async function ensureTab(tab: DetailTab): Promise<void> {
    if (tab === "standings" && state.tournament && state.standingsStatus === "idle") await loadStandings();
  }

  return { state, load, loadStandings, ensureTab, refresh };
}

export type TournamentDetail = ReturnType<typeof createTournamentDetail>;
export const TOURNAMENT_DETAIL_KEY: InjectionKey<TournamentDetail> = Symbol("tournament-detail");

// ---- display helpers (pure) ----

export interface TeamLabel { entrantId: string; team: string; coach: string; race: string; logoUrl: string }

/** Entrant lookup by id: team and coach as the server named them, with the team id as the fallback name. */
export function teamLabels(entrants: TournamentEntrant[]): Map<string, TeamLabel> {
  const out = new Map<string, TeamLabel>();
  for (const e of entrants) {
    out.set(e.id, { entrantId: e.id, team: e.teamName || e.teamId, coach: e.coachId ?? "", race: e.race ?? "", logoUrl: safeCrestUrl(e.logoUrl) });
  }
  return out;
}

export interface FixtureSideView { team: string; coach: string; logoUrl: string; score: number | null; cas: number | null }
export interface FixtureView { id: string; status: string; home: FixtureSideView; away: FixtureSideView | null; played: boolean }
export interface RoundView { number: number; status: string; fixtures: FixtureView[] }

const sideView = (label: TeamLabel | undefined, side: { teamId: string; coach: { ffbCoachId: string } }, score: number | null, cas: number | null): FixtureSideView => ({
  team: label?.team || side.teamId, coach: label?.coach || side.coach.ffbCoachId, logoUrl: label?.logoUrl ?? "", score, cas,
});

/** Rounds with their fixtures; a round the server has no fixtures for (anonymous) is listed empty. */
export function roundViews(s: Pick<TournamentDetailState, "rounds" | "fixtures" | "entrants">): RoundView[] {
  const labels = teamLabels(s.entrants);
  const numbers = new Set<number>(s.rounds.map((r) => r.number));
  for (const f of s.fixtures) numbers.add(f.roundNumber);
  return [...numbers].sort((a, b) => a - b).map((number) => ({
    number,
    status: s.rounds.find((r) => r.number === number)?.status ?? "active",
    fixtures: s.fixtures.filter((f) => f.roundNumber === number).map((f) => {
      const r = f.result;
      return {
        id: f.id,
        status: f.status,
        played: Boolean(r),
        home: sideView(labels.get(f.home.entrantId), f.home, r ? r.homeScore : null, r ? r.homeCasualties ?? null : null),
        away: f.away ? sideView(labels.get(f.away.entrantId), f.away, r ? r.awayScore : null, r ? r.awayCasualties ?? null : null) : null,
      };
    }),
  }));
}

export interface StandingView {
  rank: number; team: string; coach: string; race: string; logoUrl: string;
  points: number; played: number; wins: number; draws: number; losses: number; td: number; cas: number; tiebreak: string;
}

const TIEBREAK_LABEL: Record<string, string> = {
  buchholz: "Buchholz", sonnebornBerger: "SB", opponentWinPercentage: "OW%", headToHead: "H2H",
  touchdownDifferential: "TD +/-", touchdownsFor: "TD", casualtyDifferential: "CAS +/-", casualtiesFor: "CAS", seed: "Seed",
};

/** The column header for the tournament's first tiebreaker (Buchholz when the server names none). */
export function tiebreakLabel(t: Pick<TournamentSummary, "tiebreakers"> | null): string {
  return TIEBREAK_LABEL[t?.tiebreakers?.[0] ?? "buchholz"] ?? "Tiebreak";
}

export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));

function tiebreakValue(row: TournamentStandingRow, key: string): string {
  const n = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  switch (key) {
    case "sonnebornBerger": return n(row.sonnebornBerger);
    case "opponentWinPercentage": return `${Math.round(row.opponentWinPercentage * 100)}%`;
    case "touchdownDifferential": return signed(row.touchdownDifferential);
    case "casualtyDifferential": return signed(row.casualtyDifferential);
    case "touchdownsFor": return n(row.touchdownsFor);
    case "casualtiesFor": return n(row.casualtiesFor);
    case "seed": return n(row.seed);
    case "headToHead": return "";
    default: return n(row.buchholz);
  }
}

export function standingViews(s: Pick<TournamentDetailState, "standings" | "entrants" | "tournament">): StandingView[] {
  const labels = teamLabels(s.entrants);
  const key = s.tournament?.tiebreakers?.[0] ?? "buchholz";
  return s.standings.map((r) => {
    const l = labels.get(r.entrantId);
    return {
      rank: r.rank, team: l?.team || r.teamId, coach: l?.coach || r.coachId, race: l?.race ?? "", logoUrl: l?.logoUrl ?? "",
      points: r.points, played: r.played, wins: r.wins, draws: r.draws, losses: r.losses,
      td: r.touchdownsFor, cas: r.casualtiesFor, tiebreak: tiebreakValue(r, key),
    };
  });
}

export function roundProgress(t: Pick<TournamentSummary, "currentRound" | "roundCount">): string {
  if (t.currentRound > 0) return `Round ${t.currentRound} of ${t.roundCount}`;
  return t.roundCount > 0 ? `Not started (${t.roundCount} rounds)` : "Not started";
}

export function startDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** Entrant status: dropped coaches are labelled, everyone else is registered. */
export const entrantStatus = (e: TournamentEntrant): string => (e.droppedAt ? "Dropped" : "Registered");
