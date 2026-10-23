// "My matches" for /app/tabletop. The tabletop API has no list endpoint yet, so this browser remembers the ids of
// matches the coach created or opened (a per-coach convenience, never state) and asks the server for each one.

import { reactive, type InjectionKey } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";
import { browserStorage, type QueueStorage } from "./queue";
import type { MatchResponse, MatchView, PostMatchOption } from "./recorder";

const MAX_REMEMBERED = 30;
const keyFor = (coach: string): string => `tabletop-matches:${coach}`;

export function rememberedMatchIds(storage: QueueStorage, coach: string): string[] {
  try {
    const v = JSON.parse(storage.getItem(keyFor(coach)) ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

export function rememberMatch(storage: QueueStorage, coach: string, id: string): void {
  try {
    const ids = [id, ...rememberedMatchIds(storage, coach).filter((x) => x !== id)].slice(0, MAX_REMEMBERED);
    storage.setItem(keyFor(coach), JSON.stringify(ids));
  } catch { /* convenience only */ }
}

export interface NewMatchForm { mySaveId: string; opponent: string; theirSaveId: string; postMatch: PostMatchOption }

export interface TabletopListState { loaded: boolean; matches: MatchView[]; error: string }

export interface TabletopListDeps {
  api: Fetcher;
  coach: () => string;
  onSignedOut: () => void;
  storage?: QueueStorage;
}

export function createTabletopList(deps: TabletopListDeps) {
  const state = reactive<TabletopListState>({ loaded: false, matches: [], error: "" });
  const storage = deps.storage ?? browserStorage();

  async function refresh(): Promise<void> {
    const ids = rememberedMatchIds(storage, deps.coach());
    const found: MatchView[] = [];
    for (const id of ids) {
      try {
        found.push((await deps.api<MatchResponse>(`/api/tabletop/matches/${encodeURIComponent(id)}`)).match);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return void deps.onSignedOut();
        // 403/404: not mine (any more); anything else: leave it out this round.
      }
    }
    state.matches = found;
    state.error = "";
    state.loaded = true;
  }

  /** Home = me, away = the opponent. Resolves to the new match id. */
  async function create(form: NewMatchForm): Promise<string> {
    const me = deps.coach();
    const res = await deps.api<{ match: MatchView }>("/api/tabletop/matches", {
      method: "POST",
      body: {
        home: { coach: me, teamSaveId: form.mySaveId },
        away: { coach: form.opponent.trim(), teamSaveId: form.theirSaveId.trim() },
        postMatch: form.postMatch,
      },
    });
    rememberMatch(storage, me, res.match.id);
    return res.match.id;
  }

  return { state, refresh, create, storage };
}

export type TabletopList = ReturnType<typeof createTabletopList>;

/** Optional pre-built controller (tests render the page against one). */
export const TABLETOP_LIST_KEY: InjectionKey<TabletopList> = Symbol("tabletop-list");
