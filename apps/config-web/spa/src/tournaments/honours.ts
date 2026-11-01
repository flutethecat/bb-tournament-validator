// Tournament Statistics, Honours and Awards tabs: the controller over GET /api/tournaments/:id/statistics and
// GET /api/tournaments/:id/awards (+ the organisers' award writes), and pure display helpers. Server:
// src/tournaments/honours.ts. Everything shown is what the server sent; a stat the results do not record is absent.

import { reactive, type InjectionKey } from "vue";
import type { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { AwardGiver, AwardView, GiveAwardInput, HonoursRecipients } from "../leagues/honours";
import type { SpotCard } from "../leagues/types";

export type TeamStat =
  | "td" | "tdAgainst" | "cas" | "casAgainst" | "completions" | "interceptions" | "fouls" | "blocks" | "mvp"
  | "injuriesFor" | "injuriesAgainst" | "deathsFor" | "deathsAgainst";
export type PlayerStat = "td" | "cas" | "mvp" | "completions" | "interceptions" | "fouls" | "blocks";
export type BoardKind = "team" | "player" | "coach";

export interface StatLine extends Record<TeamStat, number> { games: number; wins: number; draws: number; losses: number; points: number }
export interface TeamStatRow extends StatLine { entrantId: string; team: string; coach: string; race: string; logoUrl?: string }
export interface CoachStatRow extends StatLine { coach: string; teams: number }
export interface RaceStatRow { race: string; teams: number; games: number; wins: number; draws: number; losses: number; winPct: number }
export interface HonourBoard { key: string; kind: BoardKind; stat: string; title: string; rows: Array<{ rank: number; name: string; team: string; coach: string; value: number }> }

export interface TournamentStatistics {
  tournamentId: string;
  status: string;
  totals: { games: number; touchdowns: number; casualties: number | null; teams: number; coaches: number; players: number };
  coverage: { games: number; casualties: number; players: number; blocks: number };
  stats: TeamStat[];
  playerStats: PlayerStat[];
  teams: TeamStatRow[];
  coaches: CoachStatRow[];
  races: RaceStatRow[];
  honours: HonourBoard[];
  cards: SpotCard[];
}

export interface TournamentAwardView {
  id: string;
  source: "podium" | "custom";
  tournamentId: string;
  title: string;
  icon: string;
  toCoach?: string;
  toTeam?: string;
  entrantId?: string;
  race?: string;
  note: string;
  by?: string;
  at?: string;
  star: boolean;
}

export interface TournamentAwardsView {
  revision: number;
  finished: boolean;
  podium: TournamentAwardView[];
  awards: TournamentAwardView[];
  recipients?: { teams: Array<{ id: string; name: string; race: string; coach: string }>; coaches: Array<{ id: string; name: string }> };
}

/** The coach page's tournament awards (GET /api/tournaments?awards=mine). */
export interface MyTournamentAward extends TournamentAwardView { tournamentName: string }

/** Team / coach columns in display order: short label, title, value. A column shows only when the server lists its stat. */
export const STAT_COLUMNS: ReadonlyArray<{ id: TeamStat; label: string; title: string }> = [
  { id: "td", label: "TD", title: "Touchdowns scored" },
  { id: "tdAgainst", label: "TDA", title: "Touchdowns conceded" },
  { id: "cas", label: "CAS", title: "Casualties caused" },
  { id: "casAgainst", label: "CASA", title: "Casualties suffered" },
  { id: "completions", label: "COM", title: "Completions" },
  { id: "interceptions", label: "INT", title: "Interceptions" },
  { id: "fouls", label: "FOU", title: "Fouls" },
  { id: "blocks", label: "BLK", title: "Blocks" },
  { id: "mvp", label: "MVP", title: "MVPs" },
  { id: "injuriesFor", label: "INJ", title: "Serious injuries caused" },
  { id: "injuriesAgainst", label: "INJA", title: "Serious injuries suffered" },
  { id: "deathsFor", label: "KILL", title: "Kills" },
  { id: "deathsAgainst", label: "DTH", title: "Deaths suffered" },
];
export const statColumns = (stats: readonly TeamStat[]) => STAT_COLUMNS.filter((c) => stats.includes(c.id));

export const BOARD_KINDS: ReadonlyArray<{ id: BoardKind; label: string }> = [
  { id: "team", label: "Team" }, { id: "player", label: "Player" }, { id: "coach", label: "Coach" },
];
const KIND_TITLE: Record<BoardKind, string> = { team: "Teams", player: "Players", coach: "Coaches" };
export const isBoardKind = (v: unknown): v is BoardKind => v === "team" || v === "player" || v === "coach";

/** The honour boards of one kind, as HonourBoards.vue groups (empty when the kind has none). */
export function boardGroups(boards: readonly HonourBoard[], kind: BoardKind) {
  const tables = boards.filter((b) => b.kind === kind && b.rows.length).map((b) => ({ key: b.key, title: b.title, rows: b.rows }));
  return tables.length ? [{ kind, title: KIND_TITLE[kind], tables }] : [];
}

/** "8 of 10 games": how much of the tournament records player stats ("" when every game does, or none played). */
export function coverageLine(s: Pick<TournamentStatistics, "coverage">): string {
  const { games, players } = s.coverage;
  if (!games) return "";
  if (!players) return "Scores only: these results carry no player stats.";
  return players === games ? "" : `Player stats from ${players} of ${games} games.`;
}

export const wdl = (r: { wins: number; draws: number; losses: number }): string => `${r.wins}-${r.draws}-${r.losses}`;
export const pctText = (x: number): string => `${Math.round(x * 100)}%`;

/** A tournament award as the shared AwardItem row reads it (no season line; the tournament is the context). */
export const asAwardView = (a: TournamentAwardView): AwardView => ({
  id: a.id, source: a.source, title: a.title, icon: a.icon, ...(a.toCoach ? { toCoach: a.toCoach } : {}), ...(a.toTeam ? { toTeam: a.toTeam } : {}),
  ...(a.race ? { race: a.race } : {}), seasonName: "", note: a.note, ...(a.by ? { by: a.by } : {}), ...(a.at ? { at: a.at } : {}), star: a.star,
});

export const PODIUM_LABEL: Record<string, string> = { "podium-champion": "Champion", "podium-runnerUp": "Runner-up", "podium-consolation": "Consolation" };

/** The Give award dialog's recipients (league shape): the tournament's entrants, its id standing in for the season. */
export function giverRecipients(tournamentId: string, r: TournamentAwardsView["recipients"]): HonoursRecipients | undefined {
  if (!r) return undefined;
  return {
    seasons: [],
    teams: r.teams.map((t) => ({ seasonId: tournamentId, id: t.id, name: t.name, race: t.race, coach: t.coach })),
    coaches: r.coaches.map((c) => ({ id: c.id, name: c.name, seasonIds: [tournamentId] })),
  };
}

/**
 * What the polled detail says about the results (the page polls GET /api/tournaments/:id and, with one of these tabs
 * open, the standings): status, round, the record's updatedAt and awardsRevision, results recorded, and the standings
 * totals. A change marks the loaded statistics and awards stale.
 */
export function resultsStamp(s: {
  tournament: ({ status: string; currentRound: number } & { updatedAt?: string; awardsRevision?: number }) | null;
  fixtures: ReadonlyArray<{ result?: unknown }>;
  standings: ReadonlyArray<{ played: number; points: number; touchdownsFor: number; casualtiesFor: number }>;
}): string {
  const t = s.tournament;
  if (!t) return "";
  const results = s.fixtures.filter((f) => f.result !== undefined).length;
  const totals = s.standings.reduce((a, r) => [a[0]! + r.played, a[1]! + r.points, a[2]! + r.touchdownsFor, a[3]! + r.casualtiesFor], [0, 0, 0, 0]);
  return [t.status, t.currentRound, t.updatedAt ?? "", t.awardsRevision ?? 0, results, ...totals].join("|");
}

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function createTournamentHonours(deps: { api: Fetcher }) {
  const state = reactive({
    id: "",
    stats: null as TournamentStatistics | null,
    statsStatus: "idle" as "idle" | "loading" | "ok" | "error",
    statsError: "",
    awards: null as TournamentAwardsView | null,
    awardsStatus: "idle" as "idle" | "loading" | "ok" | "error",
    awardsError: "",
    /** The Give award dialog's view (recipients in the league shape). */
    view: null as { recipients?: HonoursRecipients } | null,
    busy: "", writeError: "", notice: "",
    /** The latest results stamp seen (resultsStamp) and the stamp each view was loaded at. */
    stamp: "", statsStamp: "", awardsStamp: "",
  });
  const base = (): string => `/api/tournaments/${encodeURIComponent(state.id)}`;
  function use(id: string): void {
    if (state.id === id) return;
    Object.assign(state, { id, stats: null, statsStatus: "idle", statsError: "", awards: null, awardsStatus: "idle", awardsError: "", view: null, busy: "", writeError: "", notice: "", statsStamp: "", awardsStamp: "" });
  }
  /** The results changed (or not): loaded views from an older stamp are stale and refetch on the next load. */
  function noteStamp(stamp: string): void { state.stamp = stamp; }
  const statsFresh = (): boolean => state.statsStatus === "ok" && state.statsStamp === state.stamp;
  const awardsFresh = (): boolean => state.awardsStatus === "ok" && state.awardsStamp === state.stamp;
  let statsGen = 0;
  let awardsGen = 0;
  /** Loads the statistics unless they are fresh; a stale refetch keeps the old numbers on screen until it lands. */
  async function loadStats(id: string, force = false): Promise<void> {
    use(id);
    if (!force && (statsFresh() || (state.statsStatus === "loading"))) return;
    const mine = ++statsGen;
    const stamp = state.stamp;
    if (!state.stats) state.statsStatus = "loading";
    try {
      const stats = await deps.api<TournamentStatistics>(`${base()}/statistics`);
      if (mine !== statsGen || state.id !== id) return;
      state.stats = stats;
      state.statsStamp = stamp;
      state.statsStatus = "ok";
      state.statsError = "";
    } catch (err) {
      if (mine !== statsGen || state.id !== id) return;
      if (state.stats) { state.statsStamp = stamp; return; } // keep what is shown; the next change retries
      state.statsStatus = "error";
      state.statsError = errorText(err, "Can't load the statistics.");
    }
  }
  function setAwards(v: TournamentAwardsView): void {
    state.awards = v;
    state.view = { ...(v.recipients ? { recipients: giverRecipients(state.id, v.recipients) } : {}) };
  }
  async function loadAwards(id: string, force = false): Promise<void> {
    use(id);
    if (!force && (awardsFresh() || state.awardsStatus === "loading")) return;
    const mine = ++awardsGen;
    const stamp = state.stamp;
    if (!state.awards) state.awardsStatus = "loading";
    try {
      const view = await deps.api<TournamentAwardsView>(`${base()}/awards`);
      if (mine !== awardsGen || state.id !== id) return;
      setAwards(view);
      state.awardsStamp = stamp;
      state.awardsStatus = "ok";
      state.awardsError = "";
    } catch (err) {
      if (mine !== awardsGen || state.id !== id) return;
      if (state.awards) { state.awardsStamp = stamp; return; }
      state.awardsStatus = "error";
      state.awardsError = errorText(err, "Can't load the awards.");
    }
  }
  /** One organiser write; a stale revision (409) reloads so the next try names the current one. */
  async function write(tag: string, path: string, init: { method: string; body?: unknown; headers?: Record<string, string> }, notice: string): Promise<boolean> {
    if (state.busy || !state.awards) return false;
    state.busy = tag;
    state.writeError = "";
    state.notice = "";
    try {
      const res = await deps.api<{ awards?: TournamentAwardsView }>(`${base()}${path}`, init);
      if (res?.awards) { setAwards(res.awards); state.awardsStamp = state.stamp; }
      state.notice = notice;
      return true;
    } catch (err) {
      state.writeError = errorText(err, "Could not save that.");
      if ((err as Partial<ApiError> | null)?.status === 409) { state.busy = ""; await loadAwards(state.id, true); }
      return false;
    } finally {
      state.busy = "";
    }
  }
  const give = (input: GiveAwardInput): Promise<boolean> => write("award", "/awards", {
    method: "POST",
    body: {
      title: input.title, icon: input.icon, note: input.note, revision: state.awards?.revision ?? 0,
      recipient: input.recipient.kind === "team" ? { kind: "team", teamId: input.recipient.teamId } : { kind: "coach", coachId: input.recipient.coachId },
    },
  }, `Award "${input.title}" given.`);
  // DELETE carries no body to this route: the revision rides If-Match.
  const removeAward = (id: string): Promise<boolean> => write(`award:${id}`, `/awards/${encodeURIComponent(id)}`, {
    method: "DELETE", headers: { "If-Match": `"${state.awards?.revision ?? 0}"` },
  }, "Award removed.");
  return { state, noteStamp, loadStats, loadAwards, give, removeAward };
}
export type TournamentHonours = ReturnType<typeof createTournamentHonours>;
export const TOURNAMENT_HONOURS_KEY: InjectionKey<TournamentHonours> = Symbol("tournament-honours");
/** The tournament controller satisfies the Give award dialog's contract. */
export const asGiver = (c: TournamentHonours): AwardGiver => c;
