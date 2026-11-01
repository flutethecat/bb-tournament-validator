// Leagues (/app/leagues, /app/leagues/:id, /app/leagues/:id/stats): controllers over the public league API and pure
// display helpers. No DOM; rendered by LeagueListView / LeagueDetailView / LeagueStatsView.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import { resolveCrest } from "../tabletop/art";
import type { Fetcher } from "../session";
import type {
  FormerPlayer, HonourTable, HonourValue, LeagueFixture, LeagueNewsPost, LeaguePhase, LeaguePlayer, LeagueStats, LeagueSummary, LeagueTeam, SeasonRecord, SeasonSummary, StatsCard,
  StatsScope,
} from "./types";

const errorText = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

// ---- list ----

export function createLeagueList(deps: { api: Fetcher }) {
  const state = reactive({ leagues: [] as LeagueSummary[], loaded: false, loading: false, error: "" });
  async function load(): Promise<void> {
    state.loading = true;
    try {
      const res = await deps.api<{ leagues?: LeagueSummary[] }>("/api/leagues");
      state.leagues = Array.isArray(res?.leagues) ? res.leagues : [];
      state.error = "";
    } catch (err) {
      state.leagues = [];
      state.error = errorText(err, "Can't load leagues.");
    } finally {
      state.loaded = true;
      state.loading = false;
    }
  }
  return { state, load };
}
export type LeagueList = ReturnType<typeof createLeagueList>;
export const LEAGUE_LIST_KEY: InjectionKey<LeagueList> = Symbol("league-list");

// ---- detail ----

export type LeagueTab = "overview" | "standings" | "fixtures" | "teams" | "honours";
/** The Statistics tab is a route of its own (/leagues/:id/stats), shown at the end of the same tab bar. */
export const LEAGUE_STATS_TAB_LABEL = "Statistics";
export const LEAGUE_TABS: ReadonlyArray<{ id: LeagueTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "standings", label: "Standings" },
  { id: "fixtures", label: "Fixtures" },
  { id: "teams", label: "Teams" },
  { id: "honours", label: "Honours" },
];
export const isLeagueTab = (v: unknown): v is LeagueTab => typeof v === "string" && LEAGUE_TABS.some((t) => t.id === v);

export interface LeagueDetailState {
  id: string;
  league: LeagueSummary | null;
  seasons: SeasonSummary[];
  loaded: boolean;
  error: string;
  /** Full seasons by id, loaded on demand. */
  season: Record<string, SeasonRecord>;
  seasonLoading: string;
  seasonError: string;
  /** Race crest manifest (key -> path), best effort. */
  crests: Record<string, string>;
  /** Artwork write in flight ("logo" | "banner") and its outcome. */
  artBusy: string;
  artError: string;
  artNotice: string;
  /** Fixture whose Super FUMBBL switch is saving, and the last error. */
  forkBusy: string;
  forkError: string;
  /** League news / fixtures editor / coach account write in flight ("news", "news:<id>", "fixture", "fixture:<id>", "coach:<teamId>") and its outcome. */
  editBusy: string;
  editError: string;
  editNotice: string;
}

/** News as the panel lists it: pinned first, then newest first. */
export function newsList(season: Pick<SeasonRecord, "news"> | undefined): LeagueNewsPost[] {
  return [...(season?.news ?? [])].sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

/** The fixtures editor's per-row state key: season AND fixture (imported seasons reuse fixture ids like f1). */
export const fixtureRowKey = (seasonId: string, fixtureId: string): string => `${seasonId}/${fixtureId}`;

/** One fixtures-editor row (strings, so an empty box means "none"). */
export interface FixtureRowEdit { date: string; home: string; away: string; homeCas: string; awayCas: string }

export const fixtureRowEdit = (f: LeagueFixture): FixtureRowEdit => ({
  date: f.date ?? "", home: f.home.score === null ? "" : String(f.home.score), away: f.away.score === null ? "" : String(f.away.score),
  homeCas: f.home.cas === null ? "" : String(f.home.cas), awayCas: f.away.cas === null ? "" : String(f.away.cas),
});

/**
 * The fixtures editor's pending edits. Keyed by season + fixture, and a season switch drops every pending edit, so a
 * score typed in one season can never be submitted into another season's fixture with the same id.
 */
export function createFixtureRows() {
  const rows = reactive<Record<string, FixtureRowEdit>>({});
  let current = "";
  return {
    has: (seasonId: string, fixtureId: string): boolean => fixtureRowKey(seasonId, fixtureId) in rows,
    /** Call outside render whenever the season or its fixture list changes. */
    sync(seasonId: string, fixtures: readonly LeagueFixture[]): void {
      if (seasonId !== current) { for (const k of Object.keys(rows)) delete rows[k]; current = seasonId; }
      for (const f of fixtures) rows[fixtureRowKey(seasonId, f.id)] ??= fixtureRowEdit(f);
    },
    rowOf: (seasonId: string, f: LeagueFixture): FixtureRowEdit => rows[fixtureRowKey(seasonId, f.id)] ?? fixtureRowEdit(f),
    drop(seasonId: string, fixtureId: string): void { delete rows[fixtureRowKey(seasonId, fixtureId)]; },
  };
}

export interface NewFixtureForm { home: string; away: string; round: number | null; phaseId: string; date: string; test: boolean }

/** The first problem with an Add fixture form ("" = send it); the server checks the same rules. */
export function newFixtureError(f: NewFixtureForm): string {
  if (!f.home || !f.away) return "Pick both teams.";
  if (f.home === f.away) return "A team cannot play itself.";
  if (typeof f.round !== "number" || !Number.isInteger(f.round) || f.round < 1 || f.round > 99) return "Round: 1 to 99.";
  if (f.date && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) return "Date must look like 2026-11-05.";
  return "";
}

export type RawUploader = (path: string, body: Blob) => Promise<unknown>;

const fetchUpload: RawUploader = async (path, body) => {
  const res = await fetch(path, {
    method: "PUT", credentials: "same-origin", headers: { "x-cw-auth": "1", "content-type": body.type || "application/octet-stream" }, body,
  });
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Upload failed (${res.status}).`);
  return data;
};

export function createLeagueDetail(deps: { api: Fetcher; upload?: RawUploader }) {
  const state = reactive<LeagueDetailState>({
    id: "", league: null, seasons: [], loaded: false, error: "", season: {}, seasonLoading: "", seasonError: "", crests: {},
    artBusy: "", artError: "", artNotice: "", forkBusy: "", forkError: "", editBusy: "", editError: "", editNotice: "",
  });
  async function load(id: string): Promise<void> {
    state.id = id;
    try {
      const res = await deps.api<{ league: LeagueSummary; seasons: SeasonSummary[] }>(`/api/leagues/${encodeURIComponent(id)}`);
      state.league = res.league;
      state.seasons = [...(res.seasons ?? [])].sort((a, b) => b.number - a.number);
      state.error = "";
    } catch (err) {
      state.league = null;
      state.seasons = [];
      state.error = err instanceof ApiError && err.status === 404 ? "League not found." : errorText(err, "Can't load this league.");
    } finally {
      state.loaded = true;
    }
    try {
      const m = await deps.api<{ crests?: Record<string, string> }>("/crests/manifest.json");
      state.crests = m?.crests ?? {};
    } catch { /* no crests: initials badges */ }
  }
  async function ensureSeason(seasonId: string): Promise<void> {
    if (!seasonId || state.season[seasonId]) return;
    state.seasonLoading = seasonId;
    try {
      const res = await deps.api<{ season: SeasonRecord }>(`/api/leagues/${encodeURIComponent(state.id)}/seasons/${encodeURIComponent(seasonId)}`);
      state.season[seasonId] = res.season;
      state.seasonError = "";
    } catch (err) {
      state.seasonError = errorText(err, "Can't load this season.");
    } finally {
      if (state.seasonLoading === seasonId) state.seasonLoading = "";
    }
  }
  async function refreshLeague(): Promise<void> {
    try { state.league = (await deps.api<{ league: LeagueSummary }>(`/api/leagues/${encodeURIComponent(state.id)}`)).league; } catch { /* keep */ }
  }
  async function art(kind: "logo" | "banner", task: () => Promise<unknown>, done: string): Promise<void> {
    state.artBusy = kind; state.artError = ""; state.artNotice = "";
    try {
      await task();
      await refreshLeague();
      state.artNotice = done;
    } catch (err) {
      state.artError = errorText(err, "That did not save.");
    } finally {
      state.artBusy = "";
    }
  }
  const base = (): string => `/api/leagues/${encodeURIComponent(state.id)}`;
  const label = (kind: "logo" | "banner"): string => (kind === "logo" ? "Logo" : "Header bar");
  /** One organiser write (news / fixtures editor): busy key, error, notice; `apply` folds the answer into the season. */
  async function edit<T>(key: string, task: () => Promise<T>, apply: (res: T) => void, notice: string): Promise<boolean> {
    state.editBusy = key; state.editError = ""; state.editNotice = "";
    try {
      apply(await task());
      state.editNotice = notice;
      return true;
    } catch (err) {
      state.editError = errorText(err, "That did not save.");
      return false;
    } finally {
      state.editBusy = "";
    }
  }
  const seasonPath = (seasonId: string): string => `${base()}/seasons/${encodeURIComponent(seasonId)}`;
  const putNews = (seasonId: string) => (res: { news?: LeagueNewsPost[] }): void => { const s = state.season[seasonId]; if (s) s.news = res.news ?? []; };
  const putFixture = (seasonId: string) => (res: { fixture: LeagueFixture }): void => {
    const s = state.season[seasonId];
    if (!s) return;
    const i = s.fixtures.findIndex((f) => f.id === res.fixture.id);
    if (i >= 0) s.fixtures[i] = res.fixture; else s.fixtures.push(res.fixture);
  };
  return {
    state, load, ensureSeason,
    postNews: (seasonId: string, input: { title: string; body: string; pinned: boolean }) =>
      edit("news", () => deps.api<{ news: LeagueNewsPost[] }>(`${seasonPath(seasonId)}/news`, { method: "POST", body: input }), putNews(seasonId), "News posted."),
    editNews: (seasonId: string, id: string, patch: { title?: string; body?: string; pinned?: boolean }) =>
      edit(`news:${id}`, () => deps.api<{ news: LeagueNewsPost[] }>(`${seasonPath(seasonId)}/news/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }), putNews(seasonId), "News updated."),
    deleteNews: (seasonId: string, id: string) =>
      edit(`news:${id}`, () => deps.api<{ news: LeagueNewsPost[] }>(`${seasonPath(seasonId)}/news/${encodeURIComponent(id)}`, { method: "DELETE" }), putNews(seasonId), "News deleted."),
    createFixture: (seasonId: string, form: NewFixtureForm) =>
      edit("fixture", () => deps.api<{ fixture: LeagueFixture }>(`${seasonPath(seasonId)}/fixtures`, {
        method: "POST", body: { home: form.home, away: form.away, round: form.round, ...(form.phaseId ? { phaseId: form.phaseId } : {}), ...(form.date ? { date: form.date } : {}), ...(form.test ? { test: true } : {}) },
      }), putFixture(seasonId), "Fixture added."),
    editFixture: (seasonId: string, id: string, patch: { date?: string | null; round?: number; result?: { home: number; away: number; homeCas?: number | null; awayCas?: number | null } | null }) =>
      edit(`fixture:${id}`, () => deps.api<{ fixture: LeagueFixture }>(`${seasonPath(seasonId)}/fixtures/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }), putFixture(seasonId), "Fixture saved."),
    deleteFixture: (seasonId: string, id: string) =>
      edit(`fixture:${id}`, () => deps.api(`${seasonPath(seasonId)}/fixtures/${encodeURIComponent(id)}`, { method: "DELETE" }), () => {
        const s = state.season[seasonId];
        if (s) s.fixtures = s.fixtures.filter((f) => f.id !== id);
      }, "Fixture deleted."),
    /** Organisers: coach-name lookup against the identities (the Administration tab's lookup). */
    async lookupCoaches(q: string): Promise<string[]> {
      if (q.trim().length < 2) return [];
      try { return (await deps.api<{ coaches: string[] }>(`${base()}/coaches?q=${encodeURIComponent(q.trim())}`)).coaches ?? []; } catch { return []; }
    },
    /**
     * Organisers: seat a coach account on a league team (null clears it); allSeasons = every season of the team's lineage.
     * The season is re-read afterwards (its unplayed fixtures changed too); other changed seasons reload when opened.
     */
    assignCoach: (seasonId: string, teamId: string, coachId: string | null, allSeasons: boolean) =>
      edit(`coach:${teamId}`, async () => {
        const res = await deps.api<{ seasons: string[] }>(`${seasonPath(seasonId)}/teams/${encodeURIComponent(teamId)}`, {
          method: "PATCH", body: { revision: state.season[seasonId]?.revision ?? 0, coachId, ...(allSeasons ? { allSeasons: true } : {}) },
        });
        const fresh = await deps.api<{ season: SeasonRecord }>(seasonPath(seasonId));
        return { changed: res.seasons ?? [], season: fresh.season };
      }, ({ changed, season }) => {
        state.season[seasonId] = season;
        for (const id of changed) if (id !== seasonId) delete state.season[id];
      }, coachId ? `Coach account set to ${coachId}.` : "Coach account cleared."),
    uploadArt: (kind: "logo" | "banner", image: Blob) => art(kind, () => (deps.upload ?? fetchUpload)(`${base()}/${kind}`, image), `${label(kind)} updated.`),
    removeArt: (kind: "logo" | "banner") => art(kind, () => deps.api(`${base()}/${kind}`, { method: "DELETE" }), `${label(kind)} removed.`),
    /** League admins: allow (or stop allowing) one fixture on Super FUMBBL; the server notifies the coaches and admins. */
    async setFixtureFork(seasonId: string, fixtureId: string, on: boolean): Promise<void> {
      state.forkBusy = fixtureId;
      state.forkError = "";
      try {
        const res = await deps.api<{ fixture: LeagueFixture }>(`${base()}/seasons/${encodeURIComponent(seasonId)}/fixtures/${encodeURIComponent(fixtureId)}`, { method: "PATCH", body: { forkEnabled: on } });
        const season = state.season[seasonId];
        const i = season?.fixtures.findIndex((f) => f.id === fixtureId) ?? -1;
        if (season && i >= 0) season.fixtures[i] = res.fixture;
      } catch (err) {
        state.forkError = errorText(err, "That did not save.");
      } finally {
        state.forkBusy = "";
      }
    },
  };
}

/** Organisers (trimmed, case-insensitive coach id) and admins may change the league artwork. */
export function canManageLeague(league: Pick<LeagueSummary, "organisers"> | null, coach: string, admin: boolean): boolean {
  if (!league || !coach) return false;
  const me = coach.trim().toLowerCase();
  return admin || league.organisers.some((o) => o.trim().toLowerCase() === me);
}
export type LeagueDetail = ReturnType<typeof createLeagueDetail>;
export const LEAGUE_DETAIL_KEY: InjectionKey<LeagueDetail> = Symbol("league-detail");

/** The season the page shows: the asked id when the league has it, else the newest. */
export function pickSeason(seasons: SeasonSummary[], asked: unknown): SeasonSummary | undefined {
  const id = Array.isArray(asked) ? asked[0] : asked;
  return seasons.find((s) => s.id === id) ?? [...seasons].sort((a, b) => b.number - a.number)[0];
}

// ---- stats ----

export const STATS_SCOPES: ReadonlyArray<{ id: StatsScope; label: string }> = [
  { id: "bb2020", label: "BB2020" },
  { id: "bb2025", label: "BB2025" },
  { id: "all", label: "All time" },
];
export const isStatsScope = (v: unknown): v is StatsScope => v === "bb2020" || v === "bb2025" || v === "all";

export function createLeagueStats(deps: { api: Fetcher }) {
  const state = reactive({
    id: "", scope: "all" as StatsScope, byScope: {} as Partial<Record<StatsScope, LeagueStats>>, league: null as LeagueSummary | null, loading: false, error: "",
    /** Race crest manifest (the spotlight cards' crests), loaded once, best effort. */
    crests: {} as Record<string, string>, crestsLoaded: false,
  });
  async function load(id: string, scope: StatsScope): Promise<void> {
    if (state.id !== id) { state.byScope = {}; state.league = null; }
    state.id = id;
    state.scope = scope;
    if (!state.league) {
      try { state.league = (await deps.api<{ league: LeagueSummary }>(`/api/leagues/${encodeURIComponent(id)}`)).league; } catch { /* the stats call reports */ }
    }
    if (!state.crestsLoaded) {
      state.crestsLoaded = true;
      try { state.crests = (await deps.api<{ crests?: Record<string, string> }>("/crests/manifest.json"))?.crests ?? {}; } catch { /* initials badges */ }
    }
    if (state.byScope[scope]) return;
    state.loading = true;
    try {
      state.byScope[scope] = await deps.api<LeagueStats>(`/api/leagues/${encodeURIComponent(id)}/stats?scope=${scope}`);
      state.error = "";
    } catch (err) {
      state.error = err instanceof ApiError && err.status === 404 ? "League not found." : errorText(err, "Can't load the statistics.");
    } finally {
      state.loading = false;
    }
  }
  return { state, load };
}
export type LeagueStatsCtl = ReturnType<typeof createLeagueStats>;
export const LEAGUE_STATS_KEY: InjectionKey<LeagueStatsCtl> = Symbol("league-stats");

// ---- display helpers ----

export const RULESET_TONE: Record<string, string> = { BB2020: "info", BB2025: "ok" };
export const SEASON_STATUS_LABEL: Record<string, string> = { active: "In progress", completed: "Finished" };

/** Only same-origin API paths render as images (the server sends /api/leagues/<id>/logo?v=...). */
export function safeArtUrl(url: unknown): string {
  return typeof url === "string" && /^\/api\/leagues\/[\w-]+\/(?:logo|banner)(?:\?v=[a-f0-9]{1,64})?$/.test(url) ? url : "";
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  return (words.length === 1 ? words[0]!.slice(0, 2) : words[0]![0]! + words[1]![0]!).toUpperCase();
}

/** "2026-05-29" or "". */
export function day(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
}

/** "Founded" tag: the earliest season start in the league data, as MM-DD-YYYY (US order, UTC day) plus a long date and age. */
export function leagueFounded(seasons: ReadonlyArray<Pick<SeasonSummary, "startedAt">>, now: Date = new Date()): { short: string; long: string; years: number; title: string } | null {
  let first: Date | null = null;
  for (const s of seasons) {
    if (!s.startedAt) continue;
    const d = new Date(s.startedAt);
    if (Number.isNaN(d.getTime())) continue;
    if (!first || d < first) first = d;
  }
  if (!first) return null;
  const iso = first.toISOString();
  const short = `${iso.slice(5, 7)}-${iso.slice(8, 10)}-${iso.slice(0, 4)}`;
  const long = first.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
  let years = now.getUTCFullYear() - first.getUTCFullYear();
  if (now.getUTCMonth() < first.getUTCMonth() || (now.getUTCMonth() === first.getUTCMonth() && now.getUTCDate() < first.getUTCDate())) years -= 1;
  years = Math.max(0, years);
  const age = years < 1 ? "less than a year ago" : years === 1 ? "1 year ago" : `${years} years ago`;
  return { short, long, years, title: `Founded ${long}, ${age}` };
}

/** Where the Season row (oldest first, scrolling sideways) should sit: the right end when the latest season is picked,
 *  otherwise just enough to bring the picked card fully into view (scrollLeft unchanged when it already is). */
export function seasonRowScroll(
  row: { scrollLeft: number; scrollWidth: number; clientWidth: number; getBoundingClientRect(): { left: number } },
  card: { getBoundingClientRect(): { left: number; width: number } } | null,
  latestPicked: boolean,
): number {
  const end = Math.max(0, row.scrollWidth - row.clientWidth);
  if (latestPicked || !card) return end;
  // Row-relative geometry from real rects (offsetLeft is relative to the offset parent, which is not the row).
  const r = card.getBoundingClientRect();
  const left = r.left - row.getBoundingClientRect().left + row.scrollLeft;
  if (left < row.scrollLeft) return Math.max(0, left);
  if (left + r.width > row.scrollLeft + row.clientWidth) return Math.min(end, left + r.width - row.clientWidth);
  return row.scrollLeft;
}

/** The season to carry through the league tab links: the asked one when it is a known season other than the latest. */
export function carriedSeason(seasons: SeasonSummary[], asked: unknown): string {
  const id = Array.isArray(asked) ? asked[0] : asked;
  if (typeof id !== "string" || !seasons.some((s) => s.id === id)) return "";
  return id === [...seasons].sort((a, b) => b.number - a.number)[0]?.id ? "" : id;
}

export function seasonDates(s: Pick<SeasonSummary, "startedAt" | "endedAt">): string {
  const a = day(s.startedAt);
  const b = day(s.endedAt);
  if (!a) return "Dates not recorded";
  return b && b !== a ? `${a} to ${b}` : a;
}

const PHASE_LABEL: Record<string, string> = { PreSeason: "Pre-season", PlayOffs: "Playoffs", Interdivision: "Interdivision" };
export const phaseLabel = (name: string): string => PHASE_LABEL[name] ?? name.replace(/([a-z])([A-Z])/g, "$1 $2");
export function phaseTitle(p: Pick<LeaguePhase, "category" | "name">): string {
  return p.category && p.category !== "Season" ? `${p.category} ${phaseLabel(p.name)}` : phaseLabel(p.name);
}

export type SideOutcome = "win" | "draw" | "loss";

/**
 * The server's outcome rule (src/leagues/identity.ts fixtureOutcome): no result when unscored or a suspended 0-0
 * with no concession; a concession decides (the conceding side loses, whatever the recorded score); else the score.
 */
export function fixtureOutcome(f: Pick<LeagueFixture, "home" | "away" | "suspended">): { home: SideOutcome; away: SideOutcome } | undefined {
  if (f.home.score === null || f.away.score === null) return undefined;
  const hc = f.home.conceded;
  const ac = f.away.conceded;
  if (f.suspended && f.home.score === 0 && f.away.score === 0 && !hc && !ac) return undefined;
  if (hc && ac) return { home: "loss", away: "loss" };
  if (hc) return { home: "loss", away: "win" };
  if (ac) return { home: "win", away: "loss" };
  const d = f.home.score - f.away.score;
  return d > 0 ? { home: "win", away: "loss" } : d < 0 ? { home: "loss", away: "win" } : { home: "draw", away: "draw" };
}

/** A fixture with a result (see fixtureOutcome). */
export const fixturePlayed = (f: Pick<LeagueFixture, "home" | "away" | "suspended">): boolean => fixtureOutcome(f) !== undefined;

export const fixtureTime = (f: Pick<LeagueFixture, "finishedAt" | "startedAt">): string => f.finishedAt ?? f.startedAt ?? "";

/** Most recent finished fixtures, newest first. */
export function latestResults(season: SeasonRecord, limit = 9): LeagueFixture[] {
  return season.fixtures
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => fixturePlayed(f))
    .sort((a, b) => fixtureTime(b.f).localeCompare(fixtureTime(a.f)) || b.f.round - a.f.round || b.i - a.i)
    .slice(0, limit)
    .map(({ f }) => f);
}

/** "TABBL · Season 6 · Regular · Klickitat · Round 3". */
export function fixtureContext(league: Pick<LeagueSummary, "name">, season: Pick<SeasonRecord, "name">, f: LeagueFixture): string {
  const phase = f.category && f.category !== "Season" ? `${f.category} ${phaseLabel(f.phase)}` : phaseLabel(f.phase);
  return [league.name, season.name, phase, f.group, `Round ${f.round}`].filter(Boolean).join(" · ");
}

export interface RoundGroup { round: number; fixtures: LeagueFixture[]; played: number }
export interface PhaseGroup { phase: LeaguePhase; title: string; rounds: RoundGroup[] }

/** Fixtures by phase (season order) then round (ascending), tables in order. */
export function fixturesByPhase(season: SeasonRecord): PhaseGroup[] {
  return season.phases
    .map((phase) => {
      const rounds = new Map<number, LeagueFixture[]>();
      for (const f of season.fixtures) if (f.phaseId === phase.id) rounds.set(f.round, [...(rounds.get(f.round) ?? []), f]);
      return {
        phase,
        title: phaseTitle(phase),
        rounds: [...rounds].sort((a, b) => a[0] - b[0]).map(([round, fixtures]) => ({
          round,
          fixtures: fixtures.sort((a, b) => a.group.localeCompare(b.group) || a.table - b.table),
          played: fixtures.filter(fixturePlayed).length,
        })),
      };
    })
    .filter((g) => g.rounds.length);
}

/** Standings tables: one per phase + group, phases with no table left out. */
export function standingsTables(season: SeasonRecord): Array<{ key: string; title: string; note: string; rows: LeaguePhase["standings"] }> {
  const out: Array<{ key: string; title: string; note: string; rows: LeaguePhase["standings"] }> = [];
  for (const p of season.phases) {
    if (!p.standings.length || p.standings.every((r) => r.played === 0)) continue;
    const includes = (p.includes ?? []).map((id) => season.phases.find((x) => x.id === id)).filter(Boolean).map((x) => phaseLabel(x!.name));
    const note = includes.length ? `Includes ${includes.join(" and ")} games.` : "";
    const groups = [...new Set(p.standings.map((r) => r.group))];
    for (const g of groups) out.push({ key: `${p.id}:${g}`, title: g ? `${phaseTitle(p)} · ${g}` : phaseTitle(p), note, rows: p.standings.filter((r) => r.group === g) });
  }
  return out;
}

/** The team a ?team= value names: its id (exact), else a team name only when exactly one team has it. */
export function teamByRef(season: SeasonRecord, ref: string): LeagueTeam | undefined {
  const byId = season.teams.find((t) => t.id === ref);
  if (byId) return byId;
  const named = season.teams.filter((t) => t.name.trim().toLowerCase() === ref.trim().toLowerCase());
  return named.length === 1 ? named[0] : undefined;
}

/** Totals the export could not split between players, recorded once on this team. */
export const teamUnattributed = (season: SeasonRecord, team: LeagueTeam) => (season.unattributedStats ?? []).filter((u) => u.teamId === team.id);

/** The roster or former player a ?player= value names: its playerId, else an id the player held in an earlier season. */
export function playerByRef(season: SeasonRecord, ref: string): { team: LeagueTeam; player: LeaguePlayer | FormerPlayer } | undefined {
  if (!ref) return undefined;
  for (const exact of [true, false]) {
    for (const team of season.teams) {
      for (const player of [...team.players, ...team.formerPlayers]) {
        if (exact ? player.playerId === ref : player.previousIds?.includes(ref)) return { team, player };
      }
    }
  }
  return undefined;
}

/** Combined honour totals this player is one of the candidates for (the export could not split them). */
export const sharedTotalsFor = (season: SeasonRecord, playerId: string) => (season.unattributedStats ?? []).filter((u) => (u.candidates ?? []).includes(playerId));

/** Where a player's id opens: that season's Teams tab with the player highlighted. */
export const playerQuery = (seasonId: string, playerId: string): Record<string, string> => ({ season: seasonId, tab: "teams", player: playerId });

/** Where a spotlight card opens on the league page: the player (team + player), the team, or the fixture summary. */
export function cardQuery(card: Pick<StatsCard, "link">): Record<string, string> {
  const l = card.link;
  if (l.kind === "player") return { season: l.seasonId, tab: "teams", team: l.teamId, player: l.playerId };
  if (l.kind === "team") return { season: l.seasonId, tab: "teams", team: l.teamId };
  return { season: l.seasonId, tab: "fixtures", fixture: l.fixtureId };
}

/** A card's season chips: at most `max` ("S6"), the rest folded into "+N". */
export function cardSeasonChips(seasons: number[], max = 4): string[] {
  if (seasons.length <= max) return seasons.map((n) => `S${n}`);
  const shown = seasons.slice(-(max - 1)).map((n) => `S${n}`);
  return [`+${seasons.length - shown.length}`, ...shown];
}

/** "Tied with Leaf" / "Tied with Leaf and Ug" / "Tied with Leaf, Ug and 3 more". */
export function tiedLine(names: string[]): string {
  if (!names.length) return "";
  if (names.length === 1) return `Tied with ${names[0]}`;
  if (names.length === 2) return `Tied with ${names[0]} and ${names[1]}`;
  return `Tied with ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/** 885000 -> "885k", 1205000 -> "1,205k". */
export function kValue(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  return `${Math.round(n / 1000).toLocaleString("en-US")}k`;
}

/**
 * A league team's value figures as the server sent them: the current team value (CTV) is the main figure, with the
 * team value (TV) secondary when they differ; one TV figure when they match or no CTV was sent.
 */
export function teamValueFigures(t: { teamValue: number | null; currentTeamValue?: number | null }): { main: { label: "CTV" | "TV"; value: number | null }; secondary?: { label: "TV"; value: number } } {
  const ctv = t.currentTeamValue;
  if (typeof ctv === "number" && typeof t.teamValue === "number" && ctv !== t.teamValue) return { main: { label: "CTV", value: ctv }, secondary: { label: "TV", value: t.teamValue } };
  return { main: { label: "TV", value: t.teamValue } };
}

const STAT_LABEL: Record<string, string> = {
  mosttouchdowns: "Most touchdowns", mostcasualties: "Most casualties", mostmvp: "Most MVPs", mostinterceptions: "Most interceptions",
  mostpass: "Most completions", mostdirtyplay: "Most fouls", mostinjuries: "Most injuries caused", mostsentoffs: "Most sent off",
  mostexperienced: "Most SPP", bestperformance: "Best performance", mostvaluebigguy: "Most valuable big guy", mostvalueblitzer: "Most valuable blitzer",
  mostvalueblocker: "Most valuable blocker", mostvaluecatcher: "Most valuable catcher", mostvaluelineman: "Most valuable lineman",
  mostvaluerunner: "Most valuable runner", mostvaluespecial: "Most valuable special", mostvaluestunty: "Most valuable stunty", mostvaluethrower: "Most valuable thrower",
  bestdefenseteam: "Best defence", bestperformanceteam: "Best performance", bestrun: "Best run", worstrun: "Worst run",
  mostcasualtiesagainstteam: "Most casualties suffered", mostcasualtiesfavorteam: "Most casualties caused", mostdeathsfavorteam: "Most kills",
  mostdirtyplayteam: "Most fouls", mostexperienceteam: "Most SPP", mostfanfactorteam: "Most fans", mostinjuriesagainstteam: "Most injuries suffered",
  mostinterceptionsteam: "Most interceptions", mostmatchresulthattricksteam: "Most hat-tricks", mostmatchresultmassacresteam: "Most massacres",
  mostmatchresultshutoutsteam: "Most shutouts", mostpassteam: "Most completions", mostsecretobjectives: "Most secret objectives",
  mostsentoffsteam: "Most sent off", mosttouchdownfavorteam: "Most touchdowns", mostvalueteam: "Highest team value",
  bestrace: "Best coach", beststunty: "Best stunty coach", coachraceexperience: "Most experienced coach", rankingposition: "Ranking position",
  bestbadlandsbrawl: "Best Badlands Brawl coach", bestchaosclash: "Best Chaos Clash coach", bestelvenkingdomsleague: "Best Elven Kingdoms League coach",
  bestfavouredof: "Best Favoured of... coach", besthalflingthimblecup: "Best Halfling Thimble Cup coach", bestlustriansuperleague: "Best Lustrian Superleague coach",
  bestoldworldclassic: "Best Old World Classic coach", bestsylvanianspotlight: "Best Sylvanian Spotlight coach", bestunderworldchallenge: "Best Underworld Challenge coach",
  bestwoodlandleague: "Best Woodland League coach", bestworldsedgesuperleague: "Best Worlds Edge Superleague coach",
};
export const honourLabel = (stat: string): string => STAT_LABEL[stat] ?? stat.replace(/^(most|best|worst)/, "$1 ").replace(/^./, (c) => c.toUpperCase());

/** The order honour boards appear in: player stat boards first (TD, CAS, MVP...), then team, then coach. */
const STAT_ORDER = ["mosttouchdowns", "mostcasualties", "mostmvp", "mostexperienced", "mostpass", "mostinterceptions", "mostdirtyplay", "mostinjuries", "mostsentoffs", "bestperformance"];
export function honourBoards(season: SeasonRecord): Array<{ title: string; kind: HonourTable["kind"]; tables: HonourTable[] }> {
  const rank = (t: HonourTable): number => { const i = STAT_ORDER.indexOf(t.stat); return i < 0 ? 100 : i; };
  const kinds: Array<[HonourTable["kind"], string]> = [["player", "Players"], ["team", "Teams"], ["coach", "Coaches"]];
  return kinds.map(([kind, title]) => ({
    title,
    kind,
    tables: season.honours
      .filter((t) => t.kind === kind && t.rows.length)
      .sort((a, b) => a.category.localeCompare(b.category) * -1 || rank(a) - rank(b) || honourLabel(a.stat).localeCompare(honourLabel(b.stat))),
  })).filter((b) => b.tables.length);
}

/** A coach honour brace record reads as "4-0-0 · 16 pts"; other records as "k v" pairs; numbers as themselves. */
export function honourValue(v: HonourValue): string {
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === "string") return v;
  if ("Wins" in v || "Draws" in v || "Defeats" in v) {
    const wdl = `${v.Wins ?? 0}-${v.Draws ?? 0}-${v.Defeats ?? 0}`;
    return v.Points !== undefined ? `${wdl} · ${v.Points} pts` : wdl;
  }
  return Object.entries(v).map(([k, x]) => `${k} ${x}`).join(", ");
}

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const seasonsLine = (list: number[]): string => (list.length ? `S${list.join(", S")}` : "");

/**
 * The race crest path from the crest manifest, resolved as the Past Games strip does (home/recent.ts: tabletop/art
 * resolveCrest over the manifest), with TourPlay's singular "Underworld Denizen" spelling mapped to the manifest key.
 */
export function crestFor(crests: Record<string, string>, race: string): string {
  const art = { crests: { crests } };
  const found = resolveCrest(art, race) || (/^underworld\s*denizen$/i.test(race.trim()) ? resolveCrest(art, "Underworld Denizens") : "");
  return /^\/crests\/[a-z]+\.png$/.test(found) ? found : "";
}

/** The side that conceded, by the shared outcome rule (the side that lost by conceding), or null. */
export function concedeOf(f: LeagueFixture): "home" | "away" | null {
  const o = fixtureOutcome(f);
  if (!o) return null;
  if (f.home.conceded && o.home === "loss" && o.away === "win") return "home";
  if (f.away.conceded && o.away === "loss" && o.home === "win") return "away";
  return null;
}

/** The card's competition line: "TABBL · Season 6" (no phase, group or round). */
export const fixtureCompetition = (league: Pick<LeagueSummary, "name">, season: Pick<SeasonRecord, "name">): string =>
  [league.name, season.name].filter(Boolean).join(" · ");

/** ResultCard props for a fixture (the shared components/ResultCard.vue contract; each side names its coach). */
export function resultCardProps(league: Pick<LeagueSummary, "name">, season: Pick<SeasonRecord, "name">, f: LeagueFixture, crests: Record<string, string>) {
  const side = (s: LeagueFixture["home"]) => ({ name: s.team, race: s.race, coach: s.coach, crestUrl: crestFor(crests, s.race) || null, score: s.score, cas: s.cas });
  return {
    context: fixtureCompetition(league, season),
    home: side(f.home),
    away: side(f.away),
    ...(fixtureTime(f) ? { playedAt: fixtureTime(f) } : {}),
    concede: concedeOf(f),
    // TourPlay marks a concession "suspended" as well; the card shows the concession (naming the coach) instead.
    suspended: f.suspended && !concedeOf(f),
  };
}
