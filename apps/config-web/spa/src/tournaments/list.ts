// Tournament list controller (/app/tournaments): GET /api/fork/tournaments (every format) with the Active /
// Upcoming / Finished tabs, name search and paging. Read-only and public; no DOM (rendered by TournamentListView.vue).
//
// The tabs ride the `status` spelling (bare = active, draft, completed). The `category=` spelling is NOT used: the
// server filters any request carrying `category` down to Swiss events (api.ts portal dialect), which would hide
// round-robin and knockout tournaments.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type TournamentListPage, type TournamentSummary } from "../shared/api";
import type { Fetcher } from "../session";

export type ListTab = "active" | "upcoming" | "finished";
export const LIST_TABS: ReadonlyArray<{ id: ListTab; label: string }> = [
  { id: "active", label: "Active" },
  { id: "upcoming", label: "Upcoming" },
  { id: "finished", label: "Finished" },
];

export interface TournamentListState {
  tab: ListTab;
  q: string;
  page: number;
  items: TournamentSummary[];
  total: number;
  pageSize: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
}

export const isListTab = (v: unknown): v is ListTab => v === "active" || v === "upcoming" || v === "finished";

/** The request path for a tab / search / page. */
export function listPath(tab: ListTab, q: string, page: number): string {
  const params: string[] = [];
  if (tab === "upcoming") params.push("status=draft");
  else if (tab === "finished") params.push("status=completed");
  if (q.trim()) params.push(`q=${encodeURIComponent(q.trim())}`);
  if (page > 1) params.push(`page=${page}`);
  return `/api/fork/tournaments${params.length ? `?${params.join("&")}` : ""}`;
}

/** The query string for a list position (defaults omitted): ?tab=&q=&page=. */
export function listQuery(tab: ListTab, q: string, page: number): Record<string, string> {
  const out: Record<string, string> = {};
  if (tab !== "active") out.tab = tab;
  if (q.trim()) out.q = q.trim();
  if (page > 1) out.page = String(page);
  return out;
}

/** Parses a route query into a list position; anything unrecognised falls back to the defaults. */
export function parseListQuery(query: Record<string, unknown>): { tab: ListTab; q: string; page: number } {
  const one = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "");
  const page = Number(one(query.page));
  const tab = one(query.tab);
  return { tab: isListTab(tab) ? tab : "active", q: one(query.q).slice(0, 60), page: Number.isSafeInteger(page) && page >= 1 ? page : 1 };
}

export function createTournamentList(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<TournamentListState>({
    tab: "active", q: "", page: 1, items: [], total: 0, pageSize: 20, hasMore: false, loading: false, loaded: false, error: "",
  });
  // A newer request supersedes an older one still in flight (tab flipped, typing).
  let seq = 0;

  /** `silent` = a background refresh: a failure keeps the rows on screen. */
  async function load(silent = false): Promise<void> {
    const mine = ++seq;
    state.loading = true;
    try {
      const res = await deps.api<TournamentListPage>(listPath(state.tab, state.q, state.page));
      if (mine !== seq) return;
      state.items = Array.isArray(res?.tournaments) ? res.tournaments : [];
      state.total = typeof res?.total === "number" ? res.total : state.items.length;
      state.pageSize = typeof res?.pageSize === "number" ? res.pageSize : state.pageSize;
      state.hasMore = res?.hasMore === true;
      state.error = "";
      state.loaded = true;
    } catch (err) {
      if (mine !== seq) return;
      if (silent && state.loaded && !state.error) return;
      state.items = [];
      state.hasMore = false;
      state.error = err instanceof ApiError && err.status === 401 && deps.onSignedOut
        ? (deps.onSignedOut(), "Signed out. Sign in and try again.")
        : err instanceof Error ? err.message : "Can't load tournaments.";
      state.loaded = true;
    } finally {
      if (mine === seq) state.loading = false;
    }
  }

  return {
    state,
    load,
    /** Sets tab / search / page from the URL; true when something changed (the caller then loads). */
    restore(p: { tab: ListTab; q: string; page: number }): boolean {
      const changed = state.tab !== p.tab || state.q !== p.q || state.page !== p.page;
      state.tab = p.tab; state.q = p.q; state.page = p.page;
      return changed;
    },
    refresh(): Promise<void> { return load(true); },
    setTab(tab: ListTab): Promise<void> { state.tab = tab; state.page = 1; return load(); },
    search(q: string): Promise<void> { state.q = q; state.page = 1; return load(); },
    next(): Promise<void> { if (!state.hasMore) return Promise.resolve(); state.page += 1; return load(); },
    prev(): Promise<void> { if (state.page <= 1) return Promise.resolve(); state.page -= 1; return load(); },
  };
}

export type TournamentList = ReturnType<typeof createTournamentList>;
export const TOURNAMENT_LIST_KEY: InjectionKey<TournamentList> = Symbol("tournament-list");

export const FORMAT_LABEL: Record<string, string> = { swiss: "Swiss", roundRobin: "Round robin", knockout: "Knockout" };
export const STATUS_LABEL: Record<string, string> = { draft: "Upcoming", active: "Active", completed: "Finished", cancelled: "Cancelled" };
