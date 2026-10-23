// League standings (/app/standings?league=): renders GET /api/standings exactly as returned.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

export interface StandingRow {
  coach: string; played: number; won: number; drawn: number; lost: number;
  tdFor: number; tdAgainst: number; tdDiff: number; casFor: number; casAgainst: number; casDiff: number; points: number;
}

export function createStandings(deps: { api: Fetcher; onSignedOut?: () => void }) {
  const state = reactive<{ league: string; rows: StandingRow[]; loaded: boolean; error: string }>({ league: "", rows: [], loaded: false, error: "" });
  async function load(league: string): Promise<void> {
    state.league = league.trim();
    state.loaded = false;
    state.rows = [];
    if (!state.league) return void (state.error = "");
    try {
      const res = await deps.api<{ league: string; rows: StandingRow[] }>(`/api/standings?league=${encodeURIComponent(state.league)}`);
      state.rows = res.rows ?? [];
      state.error = "";
      state.loaded = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) deps.onSignedOut?.();
      state.error = (err as Error).message;
    }
  }
  return { state, load };
}

export type Standings = ReturnType<typeof createStandings>;
export const STANDINGS_KEY: InjectionKey<Standings> = Symbol("tabletop-standings");
export const signed = (n: number): string => (n > 0 ? `+${n}` : String(n));
