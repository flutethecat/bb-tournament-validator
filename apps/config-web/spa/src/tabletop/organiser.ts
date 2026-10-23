// Organiser console controller (/app/tabletop/organiser): a round's tabletop matches, bulk Confirm & publish /
// Reopen with per-row results, and the CSV export link. Everything shown is what the server returned.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

export interface TournamentOption { id: string; name: string; currentRound?: number; roundCount?: number }

export interface OrganiserMatch {
  id: string;
  state: string;
  pendingOrganiser?: boolean;
  home: { coach: string; teamName: string };
  away: { coach: string; teamName: string };
  score?: { home: number; away: number };
  confirmations?: Record<string, string>;
}

export interface BulkResult { id: string; ok: boolean; error?: string; state?: string }
export type BulkAction = "confirm-publish" | "reopen";

export interface OrganiserState {
  tournaments: TournamentOption[];
  tournament: string;
  round: number;
  matches: OrganiserMatch[];
  loaded: boolean;
  selected: string[];
  note: string;
  results: Record<string, BulkResult>;
  busy: boolean;
  error: string;
}

export const roundsOf = (t: TournamentOption | undefined): number[] => {
  const n = Math.max(t?.currentRound ?? 0, 1);
  return Array.from({ length: Math.min(n, 50) }, (_, i) => i + 1);
};

export const exportHref = (tournament: string, round: number): string =>
  `/api/tabletop/organiser/export?tournament=${encodeURIComponent(tournament)}&round=${round}`;

export function createOrganiser(deps: { api: Fetcher; onSignedOut: () => void }) {
  const state = reactive<OrganiserState>({
    tournaments: [], tournament: "", round: 1, matches: [], loaded: false, selected: [], note: "", results: {}, busy: false, error: "",
  });
  const fail = (err: unknown): string => {
    if (err instanceof ApiError && err.status === 401) deps.onSignedOut();
    return (err as Error).message;
  };

  async function loadTournaments(): Promise<void> {
    try {
      const active = await deps.api<{ tournaments: TournamentOption[] }>("/api/tournaments");
      const draft = await deps.api<{ tournaments: TournamentOption[] }>("/api/tournaments?status=draft");
      const seen = new Set<string>();
      state.tournaments = [...(active.tournaments ?? []), ...(draft.tournaments ?? [])].filter((t) => !seen.has(t.id) && seen.add(t.id));
      state.error = "";
    } catch (err) {
      state.error = fail(err);
    }
  }

  async function loadMatches(): Promise<void> {
    if (!state.tournament) return;
    try {
      const q = `tournament=${encodeURIComponent(state.tournament)}&round=${state.round}`;
      const res = await deps.api<{ matches: OrganiserMatch[] }>(`/api/tabletop/organiser/matches?${q}`);
      state.matches = res.matches ?? [];
      state.selected = state.selected.filter((id) => state.matches.some((m) => m.id === id));
      state.loaded = true;
      state.error = "";
    } catch (err) {
      state.error = fail(err);
    }
  }

  async function choose(tournament: string, round?: number): Promise<void> {
    state.tournament = tournament;
    if (round !== undefined) state.round = round;
    state.results = {};
    state.selected = [];
    state.loaded = false;
    await loadMatches();
  }

  function toggle(id: string): void {
    state.selected = state.selected.includes(id) ? state.selected.filter((x) => x !== id) : [...state.selected, id];
  }

  async function bulk(action: BulkAction): Promise<void> {
    if (!state.selected.length) return void (state.error = "Tick at least one match.");
    state.busy = true;
    state.error = "";
    try {
      const body: Record<string, unknown> = { ids: state.selected, action };
      if (state.note.trim()) body.note = state.note.trim();
      const res = await deps.api<{ results: BulkResult[] }>("/api/tabletop/organiser/bulk", { method: "POST", body });
      state.results = Object.fromEntries((res.results ?? []).map((r) => [r.id, r]));
      await loadMatches();
    } catch (err) {
      state.error = fail(err);
    } finally {
      state.busy = false;
    }
  }

  return { state, loadTournaments, loadMatches, choose, toggle, bulk };
}

export type Organiser = ReturnType<typeof createOrganiser>;
export const ORGANISER_KEY: InjectionKey<Organiser> = Symbol("tabletop-organiser");
