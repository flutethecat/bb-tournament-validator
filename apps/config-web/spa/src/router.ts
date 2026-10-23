// Routes of the League & Tournament Manager SPA, served under /app/. Pages migrate in as they are touched; until
// then a nav item is a LinkOutView pointing at the existing hand-built page (README: "How pages migrate").

import { createRouter, type RouteLocationNormalized, type RouteRecordRaw, type RouterHistory } from "vue-router";
import { LOBBY_ID_PATTERN } from "./shared/format";
import type { SessionStore } from "./session";
import AccountView from "./views/AccountView.vue";
import LinkOutView from "./views/LinkOutView.vue";
import LobbyRoomView from "./views/LobbyRoomView.vue";
import LobbyStartView from "./views/LobbyStartView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import TabletopListView from "./views/TabletopListView.vue";
import TabletopRecorderView from "./views/TabletopRecorderView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** Needs a Discord session: signed out, the shell shows the sign-in prompt in place of the page. */
    requiresAuth?: boolean;
    /** Document title suffix. */
    title?: string;
  }
}

export const APP_BASE = "/app/";

export interface NavItem {
  label: string;
  to: string;
}

export const NAV: NavItem[] = [
  { label: "Lobby", to: "/lobby" },
  { label: "Tabletop", to: "/tabletop" },
  { label: "Tournaments", to: "/tournaments" },
  { label: "Team Builder", to: "/team-builder" },
  { label: "Tournament Team Builder", to: "/tournament-team-builder" },
  { label: "Account", to: "/account" },
];

export const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/lobby" },
  { path: "/lobby", name: "lobby", component: LobbyStartView, meta: { requiresAuth: true, title: "Start Game" } },
  {
    path: `/lobby/:id(${LOBBY_ID_PATTERN})`,
    name: "lobby-room",
    component: LobbyRoomView,
    props: true,
    meta: { requiresAuth: true, title: "Lobby" },
  },
  { path: "/tabletop", name: "tabletop", component: TabletopListView, meta: { requiresAuth: true, title: "Tabletop" } },
  {
    path: "/tabletop/:id([\\w-]{1,64})",
    name: "tabletop-match",
    component: TabletopRecorderView,
    props: true,
    meta: { requiresAuth: true, title: "Tabletop match" },
  },
  {
    path: "/tournaments",
    name: "tournaments",
    component: LinkOutView,
    props: { title: "Tournaments", href: "/tournaments.html", blurb: "Browse tournaments, register, and follow standings." },
    meta: { title: "Tournaments" },
  },
  {
    path: "/team-builder",
    name: "team-builder",
    component: LinkOutView,
    props: { title: "Team Builder", href: "/team-builder.html", blurb: "Build and save a team sheet." },
    meta: { title: "Team Builder" },
  },
  {
    path: "/tournament-team-builder",
    name: "tournament-team-builder",
    component: LinkOutView,
    props: { title: "Tournament Team Builder", href: "/tournament-team-builder.html", blurb: "Build a team against a tournament's rules." },
    meta: { title: "Tournament Team Builder" },
  },
  { path: "/account", name: "account", component: AccountView, meta: { requiresAuth: true, title: "Account" } },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundView, meta: { title: "Not found" } },
];

export type GateResult = "loading" | "error" | "signin" | "allow";

/** What the shell shows for a route given the session: the page, a sign-in prompt, or a session error. */
export function gateFor(route: Pick<RouteLocationNormalized, "meta">, session: SessionStore): GateResult {
  if (!route.meta.requiresAuth) return "allow";
  const { status } = session.state;
  if (status === "idle" || status === "loading") return session.state.info ? (session.signedIn() ? "allow" : "signin") : "loading";
  if (status === "error") return "error";
  return session.signedIn() ? "allow" : "signin";
}

export function createAppRouter(history: RouterHistory, session: SessionStore) {
  const router = createRouter({ history, routes });
  // Every navigation waits for the first session read, so a page never renders against an unknown identity. A
  // failed read does not block navigation: the shell shows the error with a retry.
  router.beforeEach(async () => {
    await session.load();
    return true;
  });
  router.afterEach((to) => {
    if (typeof document !== "undefined") document.title = `${to.meta.title ? `${to.meta.title} · ` : ""}Super FUMBBL`;
  });
  return router;
}
