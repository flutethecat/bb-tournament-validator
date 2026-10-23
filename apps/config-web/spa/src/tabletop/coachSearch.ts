// Opponent type-ahead for the New match form: GET /api/fork/coaches?q=&limit=10&coach=<me> (fork DB name search, my own
// name excluded server side), debounced 250 ms after 2+ characters. A late answer for old text is dropped.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";

export const COACH_SEARCH_MIN = 2;
export const COACH_SEARCH_DEBOUNCE_MS = 250;
export const COACH_SEARCH_LIMIT = 10;

export interface CoachSearchDeps {
  api: Fetcher;
  coach: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}

export const coachSearchPath = (q: string, me: string): string =>
  `/api/fork/coaches?q=${encodeURIComponent(q)}&limit=${COACH_SEARCH_LIMIT}&coach=${encodeURIComponent(me)}`;

export function createCoachSearch(deps: CoachSearchDeps) {
  const state = reactive({ query: "", matches: [] as string[], searching: false, searched: false, error: "" });
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown;

  async function run(q: string): Promise<void> {
    state.searching = true;
    try {
      const res = await deps.api<{ coaches: string[] }>(coachSearchPath(q, deps.coach()));
      if (state.query.trim() !== q) return;
      state.matches = (res.coaches ?? []).slice(0, COACH_SEARCH_LIMIT);
      state.error = "";
      state.searched = true;
    } catch (err) {
      if (state.query.trim() !== q) return;
      state.matches = [];
      state.error = (err as Error).message;
      state.searched = false;
    } finally {
      if (state.query.trim() === q) state.searching = false;
    }
  }

  return {
    state,
    /** Typed text changed: (re)start the debounce. */
    input(text: string): void {
      state.query = text;
      if (timer !== undefined) clearT(timer);
      timer = undefined;
      const q = text.trim();
      if (q.length < COACH_SEARCH_MIN) {
        state.matches = []; state.searched = false; state.error = ""; state.searching = false;
        return;
      }
      timer = setT(() => { timer = undefined; void run(q); }, COACH_SEARCH_DEBOUNCE_MS);
    },
    /** A match was picked: stop searching and hide the list. */
    pick(name: string): void {
      if (timer !== undefined) clearT(timer);
      timer = undefined;
      state.query = name; state.matches = []; state.searched = false; state.error = ""; state.searching = false;
    },
  };
}

export type CoachSearch = ReturnType<typeof createCoachSearch>;

/** Optional pre-built controller (tests render the form against one). */
export const COACH_SEARCH_KEY: InjectionKey<CoachSearch> = Symbol("tabletop-coach-search");
