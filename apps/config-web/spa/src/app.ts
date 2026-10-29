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
import { COACH_TREE_KEY, createCoachTree, type CoachTree } from "./home/tree";
import { CLOCK_KEY, createClock, createShellUi, SHELL_UI_KEY, type Clock, type ShellUi } from "./home/shell";
import { NOTIFICATIONS_KEY, useNotifications } from "./home/notifications";

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
  /** Left nav trees for the signed-in coach. */
  tree: CoachTree;
  /** Nav rail / drawer state. */
  ui: ShellUi;
  /** The shared 60 s clock for deadline chips and countdowns. */
  clock: Clock;
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
  const tree = createCoachTree({ api: fetcher });
  const ui = createShellUi();
  const clock = createClock();
  app.provide(API_KEY, fetcher);
  app.provide(NOTIFICATIONS_KEY, useNotifications(fetcher));
  app.provide(COACH_TREE_KEY, tree);
  app.provide(SHELL_UI_KEY, ui);
  app.provide(CLOCK_KEY, clock);
  app.use(router);
  return { app, router, session, library, theme, tree, ui, clock };
}
