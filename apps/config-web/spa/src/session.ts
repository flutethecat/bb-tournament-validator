// Discord session store for the SPA. The Discord session (cw_session cookie) is the only identity: this reads the
// same endpoint the vanilla Lobby page reads (GET /api/auth/session) and never holds anything but what it returns.
// A session counts only when the server says authMethod "discord", as the vanilla page requires.

import { reactive, type InjectionKey } from "vue";
import { api, type SessionInfo } from "./shared/api";

/** localStorage key the Account page's test sign-in card remembers its secret under; cleared on sign-out. */
export const TEST_LOGIN_SECRET_KEY = "cw.testLoginSecret";

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
  /**
   * A site admin per the latest session read. Fails closed: off when signed out, after a failed read, and while a
   * re-read is pending once any read has said "not admin".
   */
  admin(): boolean;
  /**
   * Re-reads the session (forced) at most once per SESSION_REVALIDATE_MS, so a revoked admin flag or an expired
   * session reaches the shell on the next navigation or when the tab comes back. Concurrent callers share the request.
   */
  revalidate(): Promise<void>;
  /** POST /api/auth/logout, then re-read the session. */
  signOut(): Promise<void>;
}

export type Fetcher = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** Floor between two revalidation reads of the session (navigation, focus and visibility changes). */
export const SESSION_REVALIDATE_MS = 60_000;

export function createSessionStore(fetcher: Fetcher = api, deps: { now?: () => number } = {}): SessionStore {
  const now = deps.now ?? (() => Date.now());
  const state = reactive<SessionState>({ status: "idle", info: null, error: "" });
  let inflight: Promise<void> | undefined;
  let lastRead = Number.NEGATIVE_INFINITY;
  // Set once any read says "not admin" (or fails); only a read that says admin clears it.
  const adminSeenFalse = { value: false };

  const load = (force = false): Promise<void> => {
    if (inflight) return inflight;
    if (!force && state.status === "ready") return Promise.resolve();
    state.status = "loading";
    inflight = fetcher<SessionInfo>("/api/auth/session")
      .then((info) => {
        state.info = info && typeof info === "object" ? info : { authenticated: false };
        state.error = "";
        state.status = "ready";
        adminSeenFalse.value = state.info.admin !== true;
      })
      .catch((err: unknown) => {
        state.info = null;
        state.error = err instanceof Error ? err.message : "Can't read your session.";
        state.status = "error";
        adminSeenFalse.value = true;
      })
      .finally(() => { inflight = undefined; lastRead = now(); });
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
    admin: () => discord() && state.info?.admin === true && state.status !== "error" && !(state.status === "loading" && adminSeenFalse.value),
    revalidate() {
      if (inflight) return inflight;
      if (state.status === "idle") return load();
      if (now() - lastRead < SESSION_REVALIDATE_MS) return Promise.resolve();
      return load(true);
    },
    async signOut() {
      try { await fetcher("/api/auth/logout", { method: "POST" }); } finally {
        // Every sign-out path goes through here: never leave the remembered test secret behind.
        try { localStorage.removeItem(TEST_LOGIN_SECRET_KEY); } catch { /* no storage */ }
        await load(true);
      }
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

/** Test sign-in sessions (local UAT) cannot write tournament data on the server: write controls stay hidden for them. */
export function writesAllowed(session: SessionStore): boolean {
  return session.state.info?.test !== true;
}
