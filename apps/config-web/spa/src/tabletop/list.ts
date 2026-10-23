// "My matches" for /app/tabletop: GET /api/tabletop/matches (my matches; an organiser sees all), and the New match
// form's opponent-save lookup (GET /api/tabletop/saves?coach=). Nothing is remembered in the browser.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import type { MatchView, PostMatchOption } from "./recorder";

export interface NewMatchForm { mySaveId: string; opponent: string; theirSaveId: string; postMatch: PostMatchOption }

export type MatchSummary = Pick<MatchView, "id" | "state" | "postMatch" | "home" | "away"> & { createdAt?: string };
export interface SaveOption { id: string; name: string }

export interface TabletopListState { loaded: boolean; matches: MatchSummary[]; error: string }

export interface TabletopListDeps {
  api: Fetcher;
  coach: () => string;
  onSignedOut: () => void;
}

export function createTabletopList(deps: TabletopListDeps) {
  const state = reactive<TabletopListState>({ loaded: false, matches: [], error: "" });

  async function refresh(): Promise<void> {
    try {
      const res = await deps.api<{ matches: MatchSummary[] }>("/api/tabletop/matches");
      state.matches = res.matches ?? [];
      state.error = "";
      state.loaded = true;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void deps.onSignedOut();
      state.error = (err as Error).message;
    }
  }

  /** The opponent's saved teams (id + name) for the coach name typed. */
  async function lookupSaves(coach: string): Promise<SaveOption[]> {
    const res = await deps.api<{ coach: string; saves: SaveOption[] }>(`/api/tabletop/saves?coach=${encodeURIComponent(coach.trim())}`);
    return res.saves ?? [];
  }

  /** Home = me, away = the opponent. Resolves to the new match id. */
  async function create(form: NewMatchForm): Promise<string> {
    const res = await deps.api<{ match: MatchView }>("/api/tabletop/matches", {
      method: "POST",
      body: {
        home: { coach: deps.coach(), teamSaveId: form.mySaveId },
        away: { coach: form.opponent.trim(), teamSaveId: form.theirSaveId },
        postMatch: form.postMatch,
      },
    });
    return res.match.id;
  }

  return { state, refresh, create, lookupSaves };
}

export type TabletopList = ReturnType<typeof createTabletopList>;

/** Optional pre-built controller (tests render the page against one). */
export const TABLETOP_LIST_KEY: InjectionKey<TabletopList> = Symbol("tabletop-list");
