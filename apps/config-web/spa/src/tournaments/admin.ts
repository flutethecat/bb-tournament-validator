// Site admin tournaments page (/app/admin/tournaments): every tournament in every state (GET
// /api/fork/tournaments?status=all, paged), with Set owner and add / remove organisers per row. The server checks
// that the caller is an admin (or the owner) and that the coach is a registered user; this only shows its answer.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type TournamentListPage, type TournamentSummary } from "../shared/api";
import type { Fetcher } from "../session";

export interface AdminTournamentsState {
  q: string;
  page: number;
  items: TournamentSummary[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  error: string;
  /** The tournament id whose write is in flight ("" = none). */
  busy: string;
  /** Per-row result: the server's message on failure, a short confirmation on success. */
  rowError: Record<string, string>;
  rowNotice: Record<string, string>;
}

export function adminListPath(q: string, page: number): string {
  const params = ["status=all"];
  if (q.trim()) params.push(`q=${encodeURIComponent(q.trim())}`);
  if (page > 1) params.push(`page=${page}`);
  return `/api/fork/tournaments?${params.join("&")}`;
}

export function createAdminTournaments(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<AdminTournamentsState>({
    q: "", page: 1, items: [], total: 0, hasMore: false, loading: false, loaded: false, error: "", busy: "", rowError: {}, rowNotice: {},
  });
  let gen = 0;
  const message = (err: unknown, fallback: string): string => {
    if (err instanceof ApiError && err.status === 401 && deps.onSignedOut) { deps.onSignedOut(); return "Signed out. Sign in and try again."; }
    return err instanceof Error ? err.message : fallback;
  };

  async function load(silent = false): Promise<void> {
    const mine = ++gen;
    state.loading = true;
    try {
      const res = await deps.api<TournamentListPage>(adminListPath(state.q, state.page));
      if (mine !== gen) return;
      state.items = res.tournaments ?? [];
      state.total = res.total ?? state.items.length;
      state.hasMore = res.hasMore === true;
      state.error = "";
    } catch (err) {
      if (mine !== gen) return;
      if (!silent) state.items = [];
      state.error = message(err, "Can't load tournaments.");
    } finally {
      if (mine === gen) { state.loading = false; state.loaded = true; }
    }
  }

  const search = (q: string) => { state.q = q; state.page = 1; return load(); };
  const goto = (page: number) => { state.page = Math.max(1, page); return load(); };

  async function write(id: string, path: string, method: string, body: unknown, notice: string): Promise<boolean> {
    if (state.busy) return false;
    state.busy = id;
    state.rowError = { ...state.rowError, [id]: "" };
    state.rowNotice = { ...state.rowNotice, [id]: "" };
    try {
      await deps.api(path, { method, ...(body === undefined ? {} : { body }) });
      state.rowNotice = { ...state.rowNotice, [id]: notice };
      await load(true);
      return true;
    } catch (err) {
      state.rowError = { ...state.rowError, [id]: message(err, "That did not work.") };
      return false;
    } finally {
      state.busy = "";
    }
  }
  const base = (id: string) => `/api/tournaments/${encodeURIComponent(id)}`;
  const setOwner = (id: string, coachId: string) => write(id, `${base(id)}/owner`, "POST", { coachId }, `Owner set to ${coachId}.`);
  const addOrganizer = (id: string, coachId: string) => write(id, `${base(id)}/organizers/${encodeURIComponent(coachId)}`, "POST", undefined, `${coachId} added.`);
  const removeOrganizer = (id: string, coachId: string) => write(id, `${base(id)}/organizers/${encodeURIComponent(coachId)}`, "DELETE", undefined, `${coachId} removed.`);

  return { state, load, search, goto, setOwner, addOrganizer, removeOrganizer };
}

export type AdminTournaments = ReturnType<typeof createAdminTournaments>;
export const ADMIN_TOURNAMENTS_KEY: InjectionKey<AdminTournaments> = Symbol("admin-tournaments");
