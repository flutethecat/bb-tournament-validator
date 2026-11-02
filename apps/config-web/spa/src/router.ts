// Routes of the League & Tournament Manager SPA, served under /app/. Pages migrate in as they are touched; until
// then a nav item is a LinkOutView pointing at the existing hand-built page (README: "How pages migrate").

import { createRouter, type RouteLocationNormalized, type RouteRecordRaw, type RouterHistory } from "vue-router";
import { LOBBY_ID_PATTERN } from "./shared/format";
import type { SessionStore } from "./session";
import AccountView from "./views/AccountView.vue";
import AdminTournamentsView from "./views/AdminTournamentsView.vue";
import HelpView from "./views/HelpView.vue";
import GameSummaryView from "./views/GameSummaryView.vue";
import HomeView from "./views/HomeView.vue";
import LeaderboardsView from "./views/LeaderboardsView.vue";
import FixtureLobbyView from "./views/FixtureLobbyView.vue";
import LeagueDetailView from "./views/LeagueDetailView.vue";
import LeagueRedraftView from "./views/LeagueRedraftView.vue";
import LeagueListView from "./views/LeagueListView.vue";
import LeagueSettingsView from "./views/LeagueSettingsView.vue";
import LeagueStatsView from "./views/LeagueStatsView.vue";
import MyTeamsView from "./views/MyTeamsView.vue";
import LinkOutView from "./views/LinkOutView.vue";
import LobbyRoomView from "./views/LobbyRoomView.vue";
import LobbyStartView from "./views/LobbyStartView.vue";
import MessagesView from "./views/MessagesView.vue";
import ScheduleView from "./views/ScheduleView.vue";
import NotFoundView from "./views/NotFoundView.vue";
import PrivacyView from "./views/PrivacyView.vue";
import SeriesDetailView from "./views/SeriesDetailView.vue";
import SeriesListView from "./views/SeriesListView.vue";
import StandingsView from "./views/StandingsView.vue";
import TabletopListView from "./views/TabletopListView.vue";
import TabletopOrganiserView from "./views/TabletopOrganiserView.vue";
import TabletopRecorderView from "./views/TabletopRecorderView.vue";
import TeamManageView from "./views/TeamManageView.vue";
import TournamentBuilderView from "./views/TournamentBuilderView.vue";
import TournamentDetailView from "./views/TournamentDetailView.vue";
import TournamentListView from "./views/TournamentListView.vue";
import TournamentTeamView from "./views/TournamentTeamView.vue";
import WhatsNewView from "./views/WhatsNewView.vue";
import WelcomeView from "./views/WelcomeView.vue";

declare module "vue-router" {
  interface RouteMeta {
    /** Needs a Discord session: signed out, the shell shows the sign-in prompt in place of the page. */
    requiresAuth?: boolean;
    /** The page title: the shell header's h1 and the document title (a view may override it with usePageTitle). */
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
  { path: "/privacy", name: "privacy", component: PrivacyView, meta: { title: "Privacy" } },
  { path: "/whats-new", name: "whats-new", component: WhatsNewView, meta: { title: "What's new" } },
  // Sign-up step 1 (spec 11-02 §3, Q2): the Discord callback lands here; /discord-complete.html 302s here. Public: the
  // pending Discord sign-in is the credential (src/account/welcome.ts).
  { path: "/welcome", name: "welcome", component: WelcomeView, meta: { title: "Welcome" } },
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
    // No sign-in gate (owner ruling 10-30): anyone may watch a match that is not a test match read-only; the server
    // decides the role (home / away / organiser / spectator) and refuses every write from a spectator.
    meta: { title: "Tabletop match" },
  },
  // Game page (owner 10-30): every Past Games card links here. Public; the server answers 404 for anything not public.
  {
    path: "/games/:source(tournament|tabletop|online)/:id([\\w.:%-]{1,160})",
    name: "game",
    component: GameSummaryView,
    props: (route) => ({ source: String(route.params.source), id: String(route.params.id) }),
    meta: { title: "Game" },
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
  // Tournament Series (phase 5): public read; organisers and admins create, the series' organisers edit in place.
  { path: "/series", name: "series", component: SeriesListView, meta: { title: "Tournament series" } },
  { path: "/series/:id([\\w-]{1,64})", name: "series-detail", component: SeriesDetailView, props: true, meta: { title: "Series" } },
  // Opponent's team: the server answers the coach, their current-round opponent and the managers only.
  {
    path: "/tournaments/:id([\\w-]{1,64})/team/:eid([\\w:.-]{1,160})",
    name: "tournament-team",
    component: TournamentTeamView,
    props: true,
    meta: { requiresAuth: true, title: "Team" },
  },
  // Tournament Creator (owner 10-30): the organiser's ruleset-package editor; /tournament-rules.html 302s here. One
  // route: the package rides in the query (?package=<name>, the old page's deep link; ?new=1 for an unsaved document), so
  // names with dots survive a refresh and switching documents never remounts the editor. Organisers and admins only.
  // Loaded on demand (an organiser-only page): the view is imported here so this block stays self-contained.
  {
    path: "/tournament-creator",
    name: "tournament-creator",
    component: () => import("./views/TournamentCreatorView.vue"),
    meta: { requiresAuth: true, title: "Tournament Creator" },
  },
  // Leagues (TABBL, imported from TourPlay): public read, no sign-in gate.
  { path: "/leagues", name: "leagues", component: LeagueListView, meta: { title: "Leagues" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})", name: "league-detail", component: LeagueDetailView, props: true, meta: { title: "League" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})/stats", name: "league-stats", component: LeagueStatsView, props: true, meta: { title: "League statistics" } },
  // Fixture lobby (spec-landing-bubble-retro §8): public read; the two coaches and the organisers act (server-checked).
  {
    path: "/leagues/:id([a-z0-9-]{1,64})/seasons/:seasonId([a-z0-9-]{1,64})/fixtures/:fixtureId([^/]{1,80})/lobby",
    name: "league-fixture-lobby",
    component: FixtureLobbyView,
    props: true,
    meta: { title: "Fixture lobby" },
  },
  // Tournament fixture lobby: the same page for a scheduled match (drafts answer 404 except to their managers).
  {
    path: "/tournaments/:id([\\w-]{1,64})/fixtures/:fixtureId([^/]{1,200})/lobby",
    name: "tournament-fixture-lobby",
    component: FixtureLobbyView,
    props: (r) => ({ id: String(r.params.id), fixtureId: String(r.params.fixtureId), source: "tournament" }),
    meta: { title: "Fixture lobby" },
  },
  // League settings (cog on the league page): organisers and site admins; others get the "not one of yours" note.
  { path: "/leagues/:id([a-z0-9-]{1,64})/settings", name: "league-settings", component: LeagueSettingsView, props: true, meta: { requiresAuth: true, title: "League settings" } },
  // Redraft: the organisers' board; a coach's own redraft (?team= opens the dialog from the notification link).
  { path: "/leagues/:id([a-z0-9-]{1,64})/redraft", name: "league-redraft", component: LeagueRedraftView, props: true, meta: { requiresAuth: true, title: "League redraft" } },
  { path: "/admin/tournaments", name: "admin-tournaments", component: AdminTournamentsView, meta: { requiresAuth: true, title: "Tournaments admin" } },
  {
    path: "/team-builder",
    name: "team-builder",
    component: LinkOutView,
    props: { title: "Team Builder", href: "/team-builder.html", blurb: "Build and save a team sheet." },
    meta: { title: "Team Builder" },
  },
  // Tournament Builder (owner 10-30): public like the vanilla page (browsing and the guest preview need no sign-in; saving,
  // sharing and Create on Fork ask for the Discord session in place). /tournament-team-builder/<saveId> opens a saved team
  // (one record with an optional param, so saving swaps the address without remounting); ?package=&race= and the vanilla
  // ?save= deep links keep working. /tournament-team-builder.html 302s here (server.ts legacyTournamentRedirect).
  {
    path: "/tournament-team-builder/:saveId([\\w-]{1,64})?",
    name: "tournament-team-builder",
    component: TournamentBuilderView,
    props: (route) => ({ saveId: typeof route.params.saveId === "string" && route.params.saveId ? route.params.saveId : undefined }),
    meta: { title: "Roster Builder" },
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
  // Private messages (spec §4.4): the conversation list, and one thread by id; ?to=<coach> starts a new one.
  { path: "/schedule", name: "schedule", component: ScheduleView, meta: { requiresAuth: true, title: "Schedule" } },
  { path: "/messages/:id(t[a-f0-9]{16})?", name: "messages", component: MessagesView, meta: { requiresAuth: true, title: "Messages" } },
  { path: "/:pathMatch(.*)*", name: "not-found", component: NotFoundView, meta: { title: "Page not found" } },
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
  // document.title is set in ONE place: useShellTitle's watcher (shell/pageTitle.ts), which follows the page-title store.
  return router;
}
