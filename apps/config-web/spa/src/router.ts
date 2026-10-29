// Routes of the League & Tournament Manager SPA, served under /app/. Pages migrate in as they are touched; until
// then a nav item is a LinkOutView pointing at the existing hand-built page (README: "How pages migrate").

import { createRouter, type RouteLocationNormalized, type RouteRecordRaw, type RouterHistory } from "vue-router";
import { LOBBY_ID_PATTERN } from "./shared/format";
import type { SessionStore } from "./session";
import AccountView from "./views/AccountView.vue";
import AdminTournamentsView from "./views/AdminTournamentsView.vue";
import HelpView from "./views/HelpView.vue";
import HomeView from "./views/HomeView.vue";
import LeaderboardsView from "./views/LeaderboardsView.vue";
import LeagueDetailView from "./views/LeagueDetailView.vue";
import LeagueListView from "./views/LeagueListView.vue";
import LeagueStatsView from "./views/LeagueStatsView.vue";
import MyTeamsView from "./views/MyTeamsView.vue";
import LinkOutView from "./views/LinkOutView.vue";
import LobbyRoomView from "./views/LobbyRoomView.vue";
import LobbyStartView from "./views/LobbyStartView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import StandingsView from "./views/StandingsView.vue";
import TabletopListView from "./views/TabletopListView.vue";
import TabletopOrganiserView from "./views/TabletopOrganiserView.vue";
import TabletopRecorderView from "./views/TabletopRecorderView.vue";
import TeamManageView from "./views/TeamManageView.vue";
import TournamentDetailView from "./views/TournamentDetailView.vue";
import TournamentListView from "./views/TournamentListView.vue";
import TournamentTeamView from "./views/TournamentTeamView.vue";
import WhatsNewView from "./views/WhatsNewView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** Needs a Discord session: signed out, the shell shows the sign-in prompt in place of the page. */
    requiresAuth?: boolean;
    /** Document title suffix. */
    title?: string;
  }
}

export const APP_BASE = "/app/";

export const routes: RouteRecordRaw[] = [
  // Owner 10-29 (e): the Tournament Builder stays the site root; the SPA root keeps redirecting to the Lobby until
  // the owner moves it. The coach page lives at /home.
  { path: "/", redirect: "/lobby" },
  { path: "/home", name: "home", component: HomeView, meta: { requiresAuth: true, title: "Coach page" } },
  { path: "/leaderboards", name: "leaderboards", component: LeaderboardsView, meta: { title: "Leaderboards" } },
  { path: "/help", name: "help", component: HelpView, meta: { title: "Help" } },
  { path: "/whats-new", name: "whats-new", component: WhatsNewView, meta: { title: "What's new" } },
  { path: "/lobby", name: "lobby", component: LobbyStartView, meta: { requiresAuth: true, title: "Start Game" } },
  {
    path: `/lobby/:id(${LOBBY_ID_PATTERN})`,
    name: "lobby-room",
    component: LobbyRoomView,
    props: true,
    meta: { requiresAuth: true, title: "Lobby" },
  },
  { path: "/tabletop", name: "tabletop", component: TabletopListView, meta: { requiresAuth: true, title: "Tabletop" } },
  { path: "/tabletop/organiser", name: "tabletop-organiser", component: TabletopOrganiserView, meta: { requiresAuth: true, title: "Organiser" } },
  { path: "/standings", name: "standings", component: StandingsView, meta: { title: "Standings" } },
  {
    path: "/tabletop/:id([\\w-]{1,64})",
    name: "tabletop-match",
    component: TabletopRecorderView,
    props: true,
    meta: { requiresAuth: true, title: "Tabletop match" },
  },
  // Tournaments: public read (no sign-in gate); the old hand-built page stays at /tournaments.html.
  { path: "/tournaments", name: "tournaments", component: TournamentListView, meta: { title: "Tournaments" } },
  {
    path: "/tournaments/:id([\\w-]{1,64})",
    name: "tournament-detail",
    component: TournamentDetailView,
    props: true,
    meta: { title: "Tournament" },
  },
  // Opponent's team: the server answers the coach, their current-round opponent and the managers only.
  {
    path: "/tournaments/:id([\\w-]{1,64})/team/:eid([\\w:.-]{1,160})",
    name: "tournament-team",
    component: TournamentTeamView,
    props: true,
    meta: { requiresAuth: true, title: "Team" },
  },
  // Leagues (TABBL, imported from TourPlay): public read, no sign-in gate.
  { path: "/leagues", name: "leagues", component: LeagueListView, meta: { title: "Leagues" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})", name: "league-detail", component: LeagueDetailView, props: true, meta: { title: "League" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})/stats", name: "league-stats", component: LeagueStatsView, props: true, meta: { title: "League statistics" } },
  { path: "/admin/tournaments", name: "admin-tournaments", component: AdminTournamentsView, meta: { requiresAuth: true, title: "Tournaments admin" } },
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
    props: { title: "Tournament Builder", href: "/tournament-team-builder.html", blurb: "Build a team against a tournament's rules." },
    meta: { title: "Tournament Builder" },
  },
  { path: "/my-teams", name: "my-teams", component: MyTeamsView, meta: { requiresAuth: true, title: "My teams" } },
  // Team management (owner 10-30): the coach's own team (fork library team "library:<id>" or a Tournament Builder save id).
  // The server answers only the owner; anyone else gets "Team not found." shown as a friendly note.
  {
    // The matcher sees the encoded path: tiles link "library%3A<id>" (teams/manage.ts teamManagePath), a typed URL may say "library:<id>".
    path: "/teams/:ref([\\w:%-]{1,80})",
    name: "team",
    component: TeamManageView,
    props: (route) => ({ teamRef: String(route.params.ref) }),
    meta: { requiresAuth: true, title: "Team management" },
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
  const router = createRouter({
    history,
    routes,
    // Coach-page rows link to panels by hash (/home#deadlines): scroll that panel into view, clear of the top bar.
    scrollBehavior: (to, _from, saved) => (to.hash ? { el: to.hash, top: 72 } : saved ?? undefined),
  });
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
