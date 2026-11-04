// Tournament list controller (/app/tournaments): GET /api/fork/tournaments (every format) with the Active /
// Upcoming / Finished tabs, name search and paging. Read-only and public; no DOM (rendered by TournamentListView.vue).
//
// The tabs ride the `status` spelling (bare = active, draft, completed). The `category=` spelling is NOT used: the
// server filters any request carrying `category` down to Swiss events (api.ts portal dialect), which would hide
// round-robin and knockout tournaments.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type TournamentListPage, type TournamentSummary } from "../shared/api";
import type { Fetcher } from "../session";
import { localDay } from "../shared/localTime";

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

// ---- list cards (pure display helpers) ----

/** The status chip tone (the shell's sf-chip tones). */
export const STATUS_TONE: Record<string, string> = { draft: "info", active: "ok", completed: "muted", cancelled: "urgent" };

/** "2026-11-01", "2026-11-01 to 2026-11-03", or "Not set": the days in the viewer's zone (owner 11-04). */
export function cardDates(t: Pick<TournamentSummary, "startsAt" | "endsAt">, zone?: string): string {
  const day = (iso: string | undefined): string => localDay(iso, zone);
  const start = day(t.startsAt);
  const end = day(t.endsAt);
  if (!start) return "Not set";
  return end && end !== start ? `${start} to ${end}` : start;
}

/** "2 of 8 · 6 places left" (capped), "5" (uncapped), "8 of 8 · Full". */
export function entrantsLine(t: Pick<TournamentSummary, "entrantCount" | "maxPlayers">): string {
  const n = t.entrantCount ?? 0;
  if (!(t.maxPlayers > 0)) return String(n);
  const left = Math.max(0, t.maxPlayers - n);
  return `${n} of ${t.maxPlayers} · ${left ? `${left} ${left === 1 ? "place" : "places"} left` : "Full"}`;
}

/** Coach ids compare as the server's manager check does (src/tournaments/store.ts): trimmed, lower-cased. */
export const coachKey = (coach: string | undefined | null): string => (typeof coach === "string" ? coach.trim().toLowerCase() : "");

export type CardAction = "manage" | "entry" | "register" | "open";

/**
 * The card's footer action for this viewer, from what the list row carries: Manage for the owner and organisers,
 * "Your entry" when the viewer is entered, Register while registration is open (draft or active, round 1 not yet
 * started, rosters unlocked, a place left) for a signed-in coach who can write, otherwise Open.
 */
export function cardAction(t: TournamentSummary, coach: string, canWrite: boolean): CardAction {
  const me = coachKey(coach);
  if (me && (coachKey(t.ownerCoachId) === me || (t.organizerCoachIds ?? []).some((id) => coachKey(id) === me))) return "manage";
  if (t.myEntrantId && !t.myDroppedAt) return "entry";
  const open = (t.status === "draft" || t.status === "active") && !(t.currentRound > 0) && !t.rostersLockedAt
    && !(t.maxPlayers > 0 && (t.entrantCount ?? 0) >= t.maxPlayers);
  if (open && me && canWrite && !t.myEntrantId) return "register";
  return "open";
}

export const CARD_ACTION_LABEL: Record<CardAction, string> = { manage: "Manage", entry: "Your entry", register: "Register", open: "Open" };
