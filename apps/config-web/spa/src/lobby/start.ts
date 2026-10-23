// Start Game controller (start-game spec Part 1b): my lobbies + challenges addressed to me, polled every 5 s.
// Same API calls as the vanilla page (lobby/src/main.ts renderStart). No DOM: rendered by LobbyStartView.vue.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type LobbyView, type PendingChallenge } from "../shared/api";
import { lobbyRowStatus } from "../shared/format";
import type { Fetcher } from "../session";

export interface LobbyStartState {
  loaded: boolean;
  lobbies: LobbyView[];
  challenges: PendingChallenge[];
  error: string;
}

export interface LobbyStartDeps {
  api: Fetcher;
  /** The session ended (401): re-read it so the shell shows the sign-in prompt. */
  onSignedOut: () => void;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
}

export function createLobbyStart(deps: LobbyStartDeps) {
  const state = reactive<LobbyStartState>({ loaded: false, lobbies: [], challenges: [], error: "" });
  let stopped = false;
  let timer: number | undefined;
  const setI = deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((id) => window.clearInterval(id));

  const refresh = async (): Promise<void> => {
    let data: { lobbies: LobbyView[]; challenges: PendingChallenge[] };
    try {
      data = await deps.api("/api/lobby");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void deps.onSignedOut();
      state.error = (err as Error).message;
      return;
    }
    if (stopped) return;
    state.error = "";
    state.lobbies = data.lobbies ?? [];
    state.challenges = data.challenges ?? [];
    state.loaded = true;
  };

  /** Challenge = create (or join, if the opponent already opened one). Resolves to the lobby id. */
  const challenge = async (teamId: string, opponent: string): Promise<string> => {
    const res = await deps.api<{ lobby: LobbyView }>("/api/lobby", { method: "POST", body: { teamId, opponent } });
    return res.lobby.id;
  };

  /** Accept a challenge addressed to me with `teamId`. Resolves to the lobby id. */
  const accept = async (c: PendingChallenge, teamId: string): Promise<string> => {
    const res = c.lobbyId
      ? await deps.api<{ lobby: LobbyView }>(`/api/lobby/${c.lobbyId}/join`, { method: "POST", body: { teamId } })
      : await deps.api<{ lobby: LobbyView }>("/api/lobby", { method: "POST", body: { teamId, opponent: c.coach } });
    return res.lobby.id;
  };

  return {
    state,
    refresh,
    challenge,
    accept,
    start() {
      stopped = false;
      void refresh();
      timer = setI(() => void refresh(), 5000);
    },
    stop() {
      stopped = true;
      if (timer !== undefined) clearI(timer);
      timer = undefined;
    },
  };
}

export type LobbyStart = ReturnType<typeof createLobbyStart>;

/** Row status on the Start Game list (shared with the vanilla page). */
export const lobbyStatusLabel = (l: LobbyView): string => lobbyRowStatus(l);

/** Optional pre-built controller (tests render the page against one); the view builds its own otherwise. */
export const LOBBY_START_KEY: InjectionKey<LobbyStart> = Symbol("lobby-start");
