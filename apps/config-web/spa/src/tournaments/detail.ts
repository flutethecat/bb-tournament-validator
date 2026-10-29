// Tournament detail controller (/app/tournaments/:id): GET /api/tournaments/:id for Overview / Entrants / Rounds and
// GET /api/tournaments/:id/standings for Standings. Reads are public; fixtures are whatever the server sends
// (anonymous visitors get none). Phase 2/3 add the player actions (register, withdraw, submit a team) and the
// organiser actions (roles, settings, roster lock, start, generate fixtures, participant flags). Every write refetches
// the tournament and shows the server's message on failure; nothing is retried. No DOM; rendered by the views.

import { reactive, type InjectionKey } from "vue";
import {
  ApiError,
  type BuilderSaveSummary,
  type LibraryTeam,
  type TournamentDetailResponse,
  type TournamentEntrantFlags,
  type TournamentPairingSystem,
  type TournamentRoundPreview,
  type TournamentSeedingMode,
  type TournamentEntrant,
  type TournamentFixture,
  type TournamentRound,
  type TournamentStandingRow,
  type TournamentSummary,
} from "../shared/api";
import type { Fetcher } from "../session";

export type DetailTab = "overview" | "entrants" | "rounds" | "standings" | "manage";
export const DETAIL_TABS: ReadonlyArray<{ id: DetailTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "entrants", label: "Entrants" },
  { id: "rounds", label: "Rounds" },
  { id: "standings", label: "Standings" },
];
/** The organiser tab, shown only when the server says the viewer manages this tournament. */
export const MANAGE_TAB: { id: DetailTab; label: string } = { id: "manage", label: "Manage" };
export const isDetailTab = (v: unknown): v is DetailTab => v === "manage" || DETAIL_TABS.some((t) => t.id === v);
export const tabsFor = (manage: boolean): ReadonlyArray<{ id: DetailTab; label: string }> => (manage ? [...DETAIL_TABS, MANAGE_TAB] : DETAIL_TABS);

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
  capabilities: { manage: boolean; assignRoles: boolean };
  /** The write in flight ("" = none): buttons disable while it runs. */
  busy: string;
  /** The last write's server message (failure) and a short confirmation (success). */
  actionError: string;
  notice: string;
  /** The signed-in coach's library teams and Team Builder saves for Register / Submit team. */
  teamOptions: { status: "idle" | "loading" | "ok"; library: LibraryTeam[]; saves: BuilderSaveSummary[] };
  /** Generate fixtures preview (organiser), or null. */
  preview: TournamentRoundPreview | null;
  /** The Start Tournament outcome: refused = some roster is not verified (the table shows which). */
  startOutcome: "" | "refused" | "started";
}

export interface TournamentSettingsPatch {
  startsAt?: string;
  endsAt?: string;
  maxPlayers?: number;
  roundCount?: number;
  pairingSystem?: TournamentPairingSystem;
  seedingMode?: TournamentSeedingMode;
  primaryTiebreaker?: "buchholz" | "sonnebornBerger";
}

export interface EntrantPatch { flags?: Partial<TournamentEntrantFlags>; manualSeed?: number | null }

/** Only http(s) image URLs are rendered as crests; anything else (data:, javascript:, relative junk) is dropped. */
export function safeCrestUrl(url: string | undefined | null): string {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim()) ? url.trim() : "";
}

/** `onChanged` runs after every successful write (register, withdraw, submit, organiser actions): the shell's nav trees and
 *  deadlines refetch through it. */
export function createTournamentDetail(deps: { api: Fetcher; onSignedOut?: () => void; onChanged?: () => void }) {
  const state = reactive<TournamentDetailState>({
    id: "", tournament: null, entrants: [], rounds: [], fixtures: [], standings: [], standingsStatus: "idle", standingsError: "",
    loaded: false, loading: false, notFound: false, error: "",
    capabilities: { manage: false, assignRoles: false }, busy: "", actionError: "", notice: "",
    teamOptions: { status: "idle", library: [], saves: [] }, preview: null, startOutcome: "",
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
      state.capabilities = { manage: false, assignRoles: false }; state.preview = null; state.startOutcome = "";
      state.actionError = ""; state.notice = "";
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
      state.capabilities = { manage: res.capabilities?.manage === true, assignRoles: res.capabilities?.assignRoles === true };
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

  const base = (): string => `/api/tournaments/${encodeURIComponent(state.id)}`;
  const message = (err: unknown, fallback: string): string =>
    signedOut(err) ? "Signed out. Sign in and try again." : err instanceof Error ? err.message : fallback;

  /** One write: busy flag, server message on failure, refetch (tournament + opened standings) after it either way. */
  async function run<T>(name: string, write: () => Promise<T>, notice = ""): Promise<T | undefined> {
    if (!state.id || state.busy) return undefined;
    state.busy = name;
    state.actionError = "";
    state.notice = "";
    try {
      const out = await write();
      state.notice = notice;
      deps.onChanged?.();
      return out;
    } catch (err) {
      state.actionError = message(err, "That did not work.");
      return undefined;
    } finally {
      state.busy = "";
      await refresh();
    }
  }

  /** Library teams + Team Builder saves of the signed-in coach (a failed read is an empty list, never an error). */
  async function loadTeamOptions(coach: string): Promise<void> {
    if (!coach) return;
    state.teamOptions.status = "loading";
    const [library, saves] = await Promise.all([
      deps.api<{ teams?: LibraryTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(coach)}`).then((r) => r.teams ?? []).catch(() => [] as LibraryTeam[]),
      deps.api<{ saves?: BuilderSaveSummary[] }>("/api/fork/team-builder/saves").then((r) => r.saves ?? []).catch(() => [] as BuilderSaveSummary[]),
    ]);
    state.teamOptions = { status: "ok", library, saves };
  }

  // ---- player actions ----
  const register = (teamId: string) =>
    run("register", () => deps.api(`${base()}/entrants`, { method: "POST", body: { teamId } }), "You are registered.");
  const withdraw = () => {
    const mine = state.tournament?.myEntrantId;
    return mine
      ? run("withdraw", () => deps.api(`${base()}/entrants/${encodeURIComponent(mine)}`, { method: "DELETE" }), "Your entry is withdrawn.")
      : Promise.resolve(undefined);
  };
  const submit = (saveId: string) =>
    run("submit", () => deps.api(`${base()}/submissions`, { method: "POST", body: { saveId } }), "Team submitted.");

  // ---- organiser actions ----
  const saveSettings = (patch: TournamentSettingsPatch) =>
    run("settings", () => deps.api(base(), { method: "PATCH", body: patch }), "Settings saved.");
  const setOwner = (coachId: string) =>
    run("owner", () => deps.api(`${base()}/owner`, { method: "POST", body: { coachId } }), "Owner changed.");
  const addOrganizer = (coachId: string) =>
    run("organizers", () => deps.api(`${base()}/organizers/${encodeURIComponent(coachId)}`, { method: "POST" }), "Organiser added.");
  const removeOrganizer = (coachId: string) =>
    run("organizers", () => deps.api(`${base()}/organizers/${encodeURIComponent(coachId)}`, { method: "DELETE" }), "Organiser removed.");
  const lockRosters = () => run("lock", () => deps.api(`${base()}/lock-rosters`, { method: "POST" }), "Rosters locked.");
  const unlockRosters = () => run("lock", () => deps.api(`${base()}/unlock-rosters`, { method: "POST" }), "Rosters unlocked.");
  const finish = () => run("finish", () => deps.api(`${base()}/finish`, { method: "POST" }), "Tournament finished.");
  const patchEntrant = (entrantId: string, patch: EntrantPatch) =>
    run(`entrant:${entrantId}`, () => deps.api(`${base()}/entrants/${encodeURIComponent(entrantId)}`, { method: "PATCH", body: patch }));

  /** One click: lock + validate + start. A refusal (409) leaves the lock, so the table shows which rosters fail. */
  async function start(force = false): Promise<void> {
    state.startOutcome = "";
    const ok = await run("start", () => deps.api(`${base()}/start`, { method: "POST", body: force ? { force: true } : {} }), "Tournament started.");
    state.startOutcome = ok === undefined ? (state.actionError ? "refused" : "") : "started";
  }

  async function previewRound(pairingSystem?: TournamentPairingSystem, seedingMode?: TournamentSeedingMode): Promise<void> {
    if (!state.id || state.busy) return;
    state.busy = "preview";
    state.actionError = "";
    try {
      state.preview = await deps.api<TournamentRoundPreview>(`${base()}/rounds`, {
        method: "POST",
        body: { preview: true, ...(pairingSystem ? { pairingSystem } : {}), ...(seedingMode ? { seedingMode } : {}) },
      });
    } catch (err) {
      state.preview = null;
      state.actionError = message(err, "Can't preview the round.");
    } finally {
      state.busy = "";
    }
  }

  async function generateRound(pairingSystem?: TournamentPairingSystem, seedingMode?: TournamentSeedingMode): Promise<boolean> {
    const ok = await run("generate", () => deps.api(`${base()}/rounds`, {
      method: "POST",
      body: { ...(pairingSystem ? { pairingSystem } : {}), ...(seedingMode ? { seedingMode } : {}) },
    }), "Fixtures generated.");
    if (ok !== undefined) state.preview = null;
    return ok !== undefined;
  }

  return {
    state, load, loadStandings, ensureTab, refresh, loadTeamOptions,
    register, withdraw, submit,
    saveSettings, setOwner, addOrganizer, removeOrganizer, lockRosters, unlockRosters, finish, patchEntrant,
    start, previewRound, generateRound,
  };
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

// ---- phase 2/3 display helpers (pure) ----

export const PAIRING_LABEL: Record<TournamentPairingSystem, string> = { dutch: "Dutch", monrad: "Monrad", eloSeeded: "Elo-seeded" };
export const SEEDING_LABEL: Record<TournamentSeedingMode, string> = { elo: "By rating (Elo)", manual: "Manual seeds" };

export type RosterState = "none" | "valid" | "invalid";
/** The roster chip: no submission, valid (validator or organiser override), invalid. */
export function rosterState(e: Pick<TournamentEntrant, "submission" | "flags">): RosterState {
  if (e.flags?.rosterVerified) return "valid";
  if (!e.submission) return "none";
  if (e.flags) return "invalid";
  return e.submission.valid ? "valid" : "invalid";
}
export const ROSTER_LABEL: Record<RosterState, string> = { none: "Not submitted", valid: "Valid", invalid: "Invalid" };

/** Registration is open: draft or active before round 1, rosters not locked. */
export function registrationOpen(t: TournamentSummary, rounds: TournamentRound[]): boolean {
  return (t.status === "draft" || t.status === "active") && rounds.length === 0 && !t.rostersLockedAt;
}

export function remainingRounds(t: TournamentSummary): number {
  if (typeof t.remainingRounds === "number") return t.remainingRounds;
  return t.status === "completed" || t.status === "cancelled" ? 0 : Math.max(0, t.roundCount - t.currentRound);
}

/** The viewer's own entrant row (by the server's myEntrantId). */
export function myEntrant(s: Pick<TournamentDetailState, "tournament" | "entrants">): TournamentEntrant | undefined {
  const id = s.tournament?.myEntrantId;
  return id ? s.entrants.find((e) => e.id === id) : undefined;
}

export interface NextFixtureView { fixtureId: string; round: number; opponentEntrantId: string | null; opponentTeam: string; opponentCoach: string; status: string }

/** An entrant's next unplayed fixture (latest round first), with the opponent named from the entrant list. */
export function nextFixtureFor(entrantId: string, s: Pick<TournamentDetailState, "fixtures" | "entrants">): NextFixtureView | null {
  const labels = teamLabels(s.entrants);
  const open = [...s.fixtures]
    .filter((f) => f.status !== "completed" && f.status !== "cancelled" && f.status !== "dismissed" &&
      (f.home.entrantId === entrantId || f.away?.entrantId === entrantId))
    .sort((a, b) => b.roundNumber - a.roundNumber)[0];
  if (!open) return null;
  const other = open.home.entrantId === entrantId ? open.away : open.home;
  const label = other ? labels.get(other.entrantId) : undefined;
  return {
    fixtureId: open.id, round: open.roundNumber, status: open.status,
    opponentEntrantId: other?.entrantId ?? null,
    opponentTeam: other ? label?.team || other.teamId : "Bye",
    opponentCoach: other ? label?.coach || other.coach.ffbCoachId : "",
  };
}

/** Rounds view filtered to the fixtures an entrant plays in ("Mine"). */
export function onlyMine(rounds: RoundView[], fixtures: TournamentFixture[], entrantId: string): RoundView[] {
  const mine = new Set(fixtures.filter((f) => f.home.entrantId === entrantId || f.away?.entrantId === entrantId).map((f) => f.id));
  return rounds.map((r) => ({ ...r, fixtures: r.fixtures.filter((f) => mine.has(f.id)) })).filter((r) => r.fixtures.length > 0);
}

/** Active, every drawn round complete, rounds left: the organiser may generate the next round. */
export function canGenerateRound(t: TournamentSummary, rounds: TournamentRound[]): boolean {
  if (t.status !== "active") return false;
  if (rounds.some((r) => r.status !== "completed")) return false;
  return rounds.length < t.roundCount;
}

/** ISO timestamp -> the value of a datetime-local input (UTC, minutes), and back ("" clears). */
export function toLocalInput(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16);
}
export function fromLocalInput(value: string): string {
  if (!value) return "";
  const d = new Date(`${value}:00.000Z`);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export interface SubmitChoice { ref: string; label: string; group: "Team Builder saves" | "Library teams" }

/** Submit team choices: Team Builder saves first (save:<id>), then library teams without a sheet (library:<teamId>). */
export function submitChoices(options: TournamentDetailState["teamOptions"]): SubmitChoice[] {
  const linked = new Set(options.saves.map((s) => s.teamId).filter((id): id is string => Boolean(id)));
  return [
    ...options.saves.map((s) => ({ ref: `save:${s.id}`, label: `${s.name}${s.raceName ? ` (${s.raceName})` : ""}`, group: "Team Builder saves" as const })),
    ...options.library.filter((t) => !linked.has(t.teamId)).map((t) => ({ ref: `library:${t.teamId}`, label: `${t.teamName} (${t.race})`, group: "Library teams" as const })),
  ];
}
