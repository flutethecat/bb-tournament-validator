// Tournament Series (spec-spa-tournaments §6.2, owner 10-28: "sub-tournaments that all contribute to the standings"):
// the list (/app/series), the series page (/app/series/:id) and the organisers' create / edit dialog. The server
// (src/tournaments/series.ts) computes the standings; this module only reads and writes through /api/series.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import { writesAllowed, type Fetcher, type SessionStore } from "../session";

export type SeriesScoring = "sum" | "bestN";
export type SeriesSeeding = "dutch" | "monrad" | "elo";
export type SeriesEventStatus = "draft" | "active" | "completed" | "cancelled";

export interface SeriesRecord {
  id: string;
  name: string;
  description: string;
  organisers: string[];
  scoring: SeriesScoring;
  bestN?: number;
  seeding: SeriesSeeding;
  tournaments: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  canEdit: boolean;
}

export interface SeriesSummary extends SeriesRecord {
  tournamentCount: number;
  activeCount: number;
  completedCount: number;
  firstStartsAt?: string;
  lastStartsAt?: string;
}

export interface SeriesEvent { id: string; name: string; status: SeriesEventStatus; startsAt?: string; endsAt?: string; counted: boolean; provisional: boolean }
export interface SeriesEventResult { tournamentId: string; points: number; rank: number; played: number; teamName?: string; counted: boolean }
export interface SeriesStandingRow { rank: number; coach: string; total: number; eventsPlayed: number; best: number; headToHead: number; results: SeriesEventResult[] }
export interface SeriesStandings { scoring: SeriesScoring; bestN?: number; tiebreaks: string[]; events: SeriesEvent[]; rows: SeriesStandingRow[] }
export interface SeriesDetail { series: SeriesRecord; standings: SeriesStandings; attachable?: Array<{ id: string; name: string; status: SeriesEventStatus }> }

export const SEEDING_OPTIONS: ReadonlyArray<{ id: SeriesSeeding; label: string }> = [
  { id: "dutch", label: "Dutch" }, { id: "monrad", label: "Monrad" }, { id: "elo", label: "Elo seeded" },
];
export const SEEDING_LABEL: Record<SeriesSeeding, string> = { dutch: "Dutch", monrad: "Monrad", elo: "Elo seeded" };

/** "All events" or "Best 3 events". */
export function scoringLabel(s: Pick<SeriesRecord, "scoring" | "bestN">): string {
  if (s.scoring !== "bestN") return "All events count";
  const n = s.bestN ?? 1;
  return `Best ${n} ${n === 1 ? "event" : "events"}`;
}

/** Who may create a series: organisers and admins (owner 10-28), on a session that may write. */
export function canCreateSeries(session: SessionStore): boolean {
  const info = session.state.info;
  return session.signedIn() && (info?.organizer === true || info?.admin === true) && writesAllowed(session);
}

export const seriesLink = (id: string) => ({ name: "series-detail", params: { id } });

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

// ---- list ---------------------------------------------------------------------------------------------------------------

export function createSeriesList(deps: { api: Fetcher }) {
  const state = reactive({ items: [] as SeriesSummary[], loaded: false, loading: false, error: "" });
  return {
    state,
    async load(): Promise<void> {
      state.loading = true;
      try {
        const res = await deps.api<{ series?: SeriesSummary[] }>("/api/series");
        state.items = Array.isArray(res?.series) ? res.series : [];
        state.error = "";
      } catch (err) {
        state.error = message(err, "Can't load the series.");
      } finally {
        state.loading = false;
        state.loaded = true;
      }
    },
  };
}
export type SeriesList = ReturnType<typeof createSeriesList>;
export const SERIES_LIST_KEY: InjectionKey<SeriesList> = Symbol("series-list");

// ---- dialog form --------------------------------------------------------------------------------------------------------

export interface SeriesForm {
  name: string;
  description: string;
  scoring: SeriesScoring;
  bestN: number | "";
  seeding: SeriesSeeding;
  /** Comma- or newline-separated coach names. */
  organisers: string;
}

export const blankSeriesForm = (): SeriesForm => ({ name: "", description: "", scoring: "sum", bestN: 3, seeding: "dutch", organisers: "" });

export function formFromSeries(s: SeriesRecord): SeriesForm {
  return { name: s.name, description: s.description, scoring: s.scoring, bestN: s.bestN ?? 3, seeding: s.seeding, organisers: s.organisers.join(", ") };
}

export function seriesFormProblem(form: SeriesForm): string {
  const name = form.name.trim();
  if (!name) return "Enter a name.";
  if (name.length > 100) return "The name can be at most 100 characters.";
  if (form.description.trim().length > 2000) return "The description can be at most 2000 characters.";
  if (form.scoring === "bestN") {
    const n = Number(form.bestN);
    if (form.bestN === "" || !Number.isSafeInteger(n) || n < 1 || n > 50) return "Best events must be a whole number from 1 to 50.";
  }
  return "";
}

export function seriesBody(form: SeriesForm): Record<string, unknown> {
  return {
    name: form.name.trim(),
    description: form.description.trim(),
    scoring: form.scoring,
    ...(form.scoring === "bestN" ? { bestN: Number(form.bestN) } : {}),
    seeding: form.seeding,
    organisers: form.organisers.split(/[,\n]/).map((o) => o.trim()).filter(Boolean),
  };
}

/** POST /api/series: the new series, or throws ApiError with the server's message. */
export async function createSeriesRecord(api: Fetcher, form: SeriesForm): Promise<SeriesRecord> {
  const res = await api<{ series?: SeriesRecord }>("/api/series", { method: "POST", body: seriesBody(form) });
  if (!res?.series?.id) throw new Error("The server did not return the new series.");
  return res.series;
}

// ---- detail -------------------------------------------------------------------------------------------------------------

export function createSeriesDetail(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive({
    id: "", view: null as SeriesDetail | null, loaded: false, loading: false, notFound: false, error: "",
    busy: "", actionError: "",
  });
  let gen = 0;
  const path = (): string => `/api/series/${encodeURIComponent(state.id)}`;

  async function load(id: string): Promise<void> {
    if (state.id !== id) { state.view = null; state.loaded = false; state.actionError = ""; }
    state.id = id;
    const mine = ++gen;
    state.loading = true;
    try {
      const res = await deps.api<SeriesDetail>(`/api/series/${encodeURIComponent(id)}`);
      if (mine !== gen) return;
      state.view = res;
      state.notFound = false;
      state.error = "";
    } catch (err) {
      if (mine !== gen) return;
      state.notFound = err instanceof ApiError && err.status === 404;
      state.error = state.notFound ? "" : message(err, "Can't load this series.");
    } finally {
      if (mine === gen) { state.loading = false; state.loaded = true; }
    }
  }

  /** One revision-checked write; a 409 reloads so the organiser sees the latest. Resolves true on success. */
  async function write(action: string, method: string, url: string, body: Record<string, unknown> = {}): Promise<boolean> {
    if (state.busy || !state.view) return false;
    state.busy = action;
    state.actionError = "";
    try {
      const res = await deps.api<SeriesDetail | { ok: true }>(url, { method, body: { ...body, revision: state.view.series.revision } });
      if (res && "series" in res) state.view = res;
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) deps.onSignedOut?.();
      state.actionError = message(err, "That didn't save.");
      if (err instanceof ApiError && err.status === 409) void load(state.id);
      return false;
    } finally {
      state.busy = "";
    }
  }

  return {
    state,
    load,
    save: (form: SeriesForm) => write("save", "PATCH", path(), seriesBody(form)),
    remove: () => write("delete", "DELETE", path()),
    attach: (tournamentId: string) => write(`attach:${tournamentId}`, "POST", `${path()}/tournaments/${encodeURIComponent(tournamentId)}`),
    detach: (tournamentId: string) => write(`detach:${tournamentId}`, "DELETE", `${path()}/tournaments/${encodeURIComponent(tournamentId)}`),
  };
}
export type SeriesDetailController = ReturnType<typeof createSeriesDetail>;

export type SeriesSubmitOutcome = { kind: "updated" } | { kind: "created"; id: string } | { kind: "error"; error: string };

/**
 * The dialog's Save. Edit (`editing` = the series being edited) PATCHes through the series page controller with its
 * revision and never creates: a missing controller, or one showing another series, is an error with no request sent.
 * Create (no `editing`) POSTs /api/series.
 */
export async function submitSeriesForm(input: {
  api: Fetcher; form: SeriesForm; editing?: Pick<SeriesRecord, "id"> | null; controller?: SeriesDetailController | null;
}): Promise<SeriesSubmitOutcome> {
  const problem = seriesFormProblem(input.form);
  if (problem) return { kind: "error", error: problem };
  if (input.editing) {
    const ctl = input.controller;
    if (!ctl || ctl.state.view?.series.id !== input.editing.id) return { kind: "error", error: "Reload the series page and try again." };
    return (await ctl.save(input.form)) ? { kind: "updated" } : { kind: "error", error: ctl.state.actionError || "That didn't save." };
  }
  try {
    const created = await createSeriesRecord(input.api, input.form);
    return { kind: "created", id: created.id };
  } catch (err) {
    return { kind: "error", error: message(err, "Can't create the series.") };
  }
}
export const SERIES_DETAIL_KEY: InjectionKey<SeriesDetailController> = Symbol("series-detail");

/** "2026-11-01" or "2026-11-01 to 2026-11-02"; "Date not set". */
export function eventDates(e: Pick<SeriesEvent, "startsAt" | "endsAt">): string {
  const day = (iso?: string): string => {
    if (!iso) return "";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  };
  const start = day(e.startsAt);
  const end = day(e.endsAt);
  if (!start) return "Date not set";
  return end && end !== start ? `${start} to ${end}` : start;
}
