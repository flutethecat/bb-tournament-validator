// Discord session store for the SPA. The Discord session (cw_session cookie) is the only identity: this reads the
// same endpoint the vanilla Lobby page reads (GET /api/auth/session) and never holds anything but what it returns.
// A session counts only when the server says authMethod "discord", as the vanilla page requires.

import { reactive, type InjectionKey } from "vue";
import { api, type SessionInfo } from "./shared/api";

export type SessionStatus = "idle" | "loading" | "ready" | "error";

export interface SessionState {
  status: SessionStatus;
  info: SessionInfo | null;
  error: string;
}

export interface SessionStore {
  readonly state: SessionState;
  /** Signed-in coach name (Discord sessions only), or "" when signed out / not loaded yet. */
  coach(): string;
  /** A Discord session. A password session is NOT signed in here: it gets the Login with Discord action. */
  signedIn(): boolean;
  /** Authenticated, but not with Discord (a password session). */
  otherSession(): boolean;
  ssoEnabled(): boolean;
  /** Loads once; concurrent callers share the request. `force` re-reads (after a 401 or sign-out). */
  load(force?: boolean): Promise<void>;
  /** POST /api/auth/logout, then re-read the session. */
  signOut(): Promise<void>;
}

export type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

export function createSessionStore(fetcher: Fetcher = api): SessionStore {
  const state = reactive<SessionState>({ status: "idle", info: null, error: "" });
  let inflight: Promise<void> | undefined;

  const load = (force = false): Promise<void> => {
    if (inflight) return inflight;
    if (!force && state.status === "ready") return Promise.resolve();
    state.status = "loading";
    inflight = fetcher<SessionInfo>("/api/auth/session")
      .then((info) => {
        state.info = info && typeof info === "object" ? info : { authenticated: false };
        state.error = "";
        state.status = "ready";
      })
      .catch((err: unknown) => {
        state.info = null;
        state.error = err instanceof Error ? err.message : "Can't read your session.";
        state.status = "error";
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };

  const discord = (): boolean => Boolean(state.info?.authenticated && state.info.coach && state.info.authMethod === "discord");
  return {
    state,
    coach: () => (discord() && state.info?.coach) || "",
    signedIn: discord,
    otherSession: () => Boolean(state.info?.authenticated) && !discord(),
    ssoEnabled: () => state.info?.discordSsoEnabled !== false,
    load,
    async signOut() {
      try { await fetcher("/api/auth/logout", { method: "POST" }); } finally { await load(true); }
    },
  };
}

/** The existing Discord login flow, returning to `next` (an /app path) afterwards. */
export function discordLoginUrl(next: string): string {
  return `/api/auth/discord/start?next=${encodeURIComponent(next)}`;
}

export const SESSION_KEY: InjectionKey<SessionStore> = Symbol("session");

/** A router path ("/lobby/abc") as the browser path under the SPA's /app mount ("/app/lobby/abc"). */
export function appPath(routePath: string): string {
  return `/app${routePath.startsWith("/") ? routePath : `/${routePath}`}`;
}
