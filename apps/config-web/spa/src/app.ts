// Builds the SPA (app + router + session + library). main.ts mounts it in the browser; tests build the same app
// with a memory history and server-render it.

import { createApp, createSSRApp, type App as VueApp, type InjectionKey } from "vue";
import type { RouterHistory } from "vue-router";
import App from "./App.vue";
import { createLibrary, LIBRARY_KEY, type Library } from "./lobby/library";
import { createAppRouter } from "./router";
import { createSessionStore, SESSION_KEY, type Fetcher, type SessionStore } from "./session";
import { api } from "./shared/api";
import { createTheme, THEME_KEY, type Theme } from "./theme";

/** The JSON fetcher views use (tests may swap it; the default is the shared same-origin api()). */
export const API_KEY: InjectionKey<Fetcher> = Symbol("api");

export interface SpaOptions {
  history: RouterHistory;
  ssr?: boolean;
  fetcher?: Fetcher;
  /** Pre-built theme (tests); the default follows the device setting. */
  theme?: Theme;
}

export interface Spa {
  app: VueApp;
  router: ReturnType<typeof createAppRouter>;
  session: SessionStore;
  library: Library;
  theme: Theme;
}

export function createSpa(opts: SpaOptions): Spa {
  const fetcher = opts.fetcher ?? api;
  const session = createSessionStore(fetcher);
  const library = createLibrary(fetcher);
  const router = createAppRouter(opts.history, session);
  const app = opts.ssr ? createSSRApp(App) : createApp(App);
  const theme = opts.theme ?? createTheme();
  app.provide(THEME_KEY, theme);
  app.provide(SESSION_KEY, session);
  app.provide(LIBRARY_KEY, library);
  app.provide(API_KEY, fetcher);
  app.use(router);
  return { app, router, session, library, theme };
}
