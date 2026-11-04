// Routes of the League & Tournament Manager SPA, served under /app/. Pages migrate in as they are touched; until
// then a nav item is a LinkOutView pointing at the existing hand-built page (README: "How pages migrate").

import { createRouter, type RouteLocationNormalized, type RouteRecordRaw, type RouterHistory } from "vue-router";
import { LOBBY_ID_PATTERN } from "./shared/format";
import type { SessionStore } from "./session";
import { contentArea, createHashReveal, createPaneScrollMemory, entryKey, fitMode, revealInPane, type ScrollNode } from "./shell/fit";
import { hashId } from "./tournaments/scroll";
import { legacyRedirect } from "./shell/sectionNav";
import AccountView from "./views/AccountView.vue";
import AdminOrganiserRequestsView from "./views/AdminOrganiserRequestsView.vue";
import AdminTournamentsView from "./views/AdminTournamentsView.vue";
import HelpView from "./views/HelpView.vue";
import GameSummaryView from "./views/GameSummaryView.vue";
import HomeView from "./views/HomeView.vue";
import LeaderboardsView from "./views/LeaderboardsView.vue";
import FixtureLobbyView from "./views/FixtureLobbyView.vue";
import LeagueDetailView from "./views/LeagueDetailView.vue";
import RosterBuilderRedraftView from "./views/RosterBuilderRedraftView.vue";
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
import OrganiserRequestView from "./views/OrganiserRequestView.vue";
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
import TournamentWizardView from "./views/TournamentWizardView.vue";
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
  // Create a tournament (lane L3): the wizard replaced the Create Tournament dialog. Static, so it wins over :id.
  { path: "/tournaments/new", name: "tournament-new", component: TournamentWizardView, meta: { requiresAuth: true, title: "New tournament" } },
  {
    path: "/tournaments/:id([\\w-]{1,64})",
    name: "tournament-detail",
    component: TournamentDetailView,
    props: true,
    meta: { title: "Tournament" },
  },
  // The tournament's management sub-panel (the section header's cog; was the Manage tab, ?tab=manage redirects here).
  // The page answers "not one of yours" to anyone the server does not let manage the tournament.
  {
    path: "/tournaments/:id([\\w-]{1,64})/manage",
    name: "tournament-manage",
    component: TournamentDetailView,
    props: (r) => ({ id: String(r.params.id), manage: true }),
    meta: { title: "Tournament" },
  },
  // Tournament Series (phase 5): public read; organisers and admins create, the series' organisers edit in place.
  { path: "/series", name: "series", component: SeriesListView, meta: { title: "Tournament series" } },
  { path: "/series/:id([\\w-]{1,64})", name: "series-detail", component: SeriesDetailView, props: true, meta: { title: "Series" } },
  // The series' management sub-panel (the section header's cog): Edit, Delete, New / Add / Remove tournament.
  { path: "/series/:id([\\w-]{1,64})/manage", name: "series-manage", component: SeriesDetailView, props: (r) => ({ id: String(r.params.id), manage: true }), meta: { title: "Series" } },
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
  // Ruleset summary (creation wizards v2): the public read-only page of a ruleset + its PDF. The package rides in the query
  // (names carry dots). No sign-in; the server hides draft packages.
  { path: "/ruleset-summary", name: "ruleset-summary", component: () => import("./views/RulesetSummaryView.vue"), meta: { title: "Ruleset summary" } },
  // Leagues (TABBL, imported from TourPlay): public read, no sign-in gate.
  { path: "/leagues", name: "leagues", component: LeagueListView, meta: { title: "Browse leagues" } },
  // League creation wizard (registration spec 11-02 §4, lane L5): site organisers and admins; before /leagues/:id ("new" is reserved).
  { path: "/leagues/new", name: "league-new", component: () => import("./views/LeagueWizardView.vue"), meta: { requiresAuth: true, title: "Create a league" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})", name: "league-detail", component: LeagueDetailView, props: true, meta: { title: "League" } },
  { path: "/leagues/:id([a-z0-9-]{1,64})/stats", name: "league-stats", component: LeagueStatsView, props: true, meta: { title: "League statistics" } },
  // League ladders (lane 8b): the four-step setup of a ladder made from League management -> Ladders (organisers; the server decides).
  {
    path: "/leagues/:id([a-z0-9-]{1,64})/ladders/:ladderId(ladder-[0-9]{1,6})/setup",
    name: "league-ladder-setup",
    component: () => import("./views/LadderWizardView.vue"),
    props: true,
    meta: { requiresAuth: true, title: "Set up a ladder" },
  },
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
  // The management sub-panel keeps the League settings address; /manage (the tournament and series spelling) lands there.
  { path: "/leagues/:id([a-z0-9-]{1,64})/manage", redirect: (to) => ({ name: "league-settings", params: { id: String(to.params.id) }, query: to.query, hash: to.hash }) },
  // The old redraft page (owner 11-02): ?team= (the coach's notification link) opens that team's Redraft mode in the Roster
  // Builder; without it, the organiser board in League settings -> Redraft (a coach there sees their own redraft tasks).
  {
    path: "/leagues/:id([a-z0-9-]{1,64})/redraft",
    name: "league-redraft",
    redirect: (to) => (typeof to.query.team === "string" && to.query.team
      ? { name: "roster-builder-redraft", params: { leagueId: String(to.params.id) }, query: { team: to.query.team } }
      : { name: "league-settings", params: { id: String(to.params.id) }, query: { tab: "redraft" } }),
  },
  { path: "/admin/tournaments", name: "admin-tournaments", component: AdminTournamentsView, meta: { requiresAuth: true, title: "Tournaments admin" } },
  // Organiser requests (registration spec 2026-11-02 §3): coaches ask here; site admins answer in the queue.
  { path: "/organiser/request", name: "organiser-request", component: OrganiserRequestView, meta: { requiresAuth: true, title: "Become an organiser" } },
  { path: "/admin/organiser-requests", name: "admin-organiser-requests", component: AdminOrganiserRequestsView, meta: { requiresAuth: true, title: "Organiser requests" } },
  {
    path: "/team-builder",
    name: "team-builder",
    component: LinkOutView,
    props: { title: "Team Builder", href: "/team-builder.html", blurb: "Build and save a team sheet." },
    meta: { title: "Team Builder" },
  },
  // Redraft mode (owner 11-02): the coach's league redraft in the Roster Builder layout (?team=<teamId>; the id rides in the
  // query since league team ids may hold a dot). Two segments, so it never meets the saved-team address below.
  {
    path: "/tournament-team-builder/redraft/:leagueId([a-z0-9-]{1,64})",
    name: "roster-builder-redraft",
    component: RosterBuilderRedraftView,
    props: (route) => ({ leagueId: String(route.params.leagueId), teamId: typeof route.query.team === "string" ? route.query.team : "" }),
    meta: { requiresAuth: true, title: "Roster Builder" },
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

/** Fitted shell: a hash target is revealed in its pane now and again shortly while the page fills in (shell/fit.ts). */
const hashReveal = typeof document !== "undefined"
  ? createHashReveal({
    find: (id) => document.getElementById(id),
    top: (el) => (el as HTMLElement).getBoundingClientRect().top,
    viewport: () => window.innerHeight,
    reveal: (el) => revealInPane(el as Element),
    later: (fn, ms) => setTimeout(fn, ms),
    cancel: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  })
  : null;

export function createAppRouter(history: RouterHistory, session: SessionStore) {
  // Fitted desktop shell: pane scroll offsets per history entry, put back on Back / Forward (shell/fit.ts). Browser only.
  // Each entry's key is a random id in its own history state (shell/fit.ts entryKey), never the reused position number.
  const panes = typeof window !== "undefined" && typeof document !== "undefined"
    ? createPaneScrollMemory({
      root: () => contentArea() as ScrollNode | null,
      entry: () => entryKey(history.state as Record<string, unknown> | null, (key) => {
        try { window.history.replaceState({ ...(window.history.state as object | null), sfPane: key }, ""); } catch { /* the id lives on in the router's state */ }
      }, () => Math.random().toString(36).slice(2, 12)),
      position: () => (history.state as { position?: number } | null)?.position,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    : null;
  if (panes) {
    document.addEventListener("scroll", (e) => panes.record(e.target), { capture: true, passive: true });
    // the user takes over: a pending restore must not pull the pane back
    for (const type of ["wheel", "touchstart", "keydown", "pointerdown"]) document.addEventListener(type, () => panes.userActed(), { capture: true, passive: true });
  }
  let lastPosition: number | undefined;
  const router = createRouter({
    history,
    routes,
    // Coach-page rows link to panels by hash (/home#deadlines): scroll that panel into view, clear of the top bar.
    // Fitted desktop shell (shell/fit.ts): the window never scrolls, so a new page resets the content area and a hash
    // target is revealed inside its pane; Back / Forward (saved is set) puts the entry's pane offsets back instead.
    scrollBehavior: (to, from, saved) => {
      const position = (history.state as { position?: number } | null)?.position;
      const pushed = !saved && position !== lastPosition; // a replace keeps the position; Back / Forward passes saved
      lastPosition = position;
      if (pushed) panes?.pushed();
      if (!fitMode()) { panes?.resume(); return to.hash ? { el: to.hash, top: 72 } : saved ?? undefined; }
      if (saved && panes) { void panes.restore(); return false; }
      panes?.resume();
      const main = contentArea();
      if (main && to.path !== from.path) main.scrollTop = 0;
      if (to.hash) hashReveal?.reveal(hashId(to.hash));
      return false;
    },
  });
  // Every navigation waits for the first session read, so a page never renders against an unknown identity. A
  // failed read does not block navigation: the shell shows the error with a retry.
  router.beforeEach(async (to) => {
    // Old section tab links that moved (shell/sectionNav.ts): ?tab=manage, the old league Participants tab, new tab names.
    const moved = legacyRedirect(to);
    if (moved) return moved;
    panes?.pause();
    hashReveal?.cancel();
    await session.load();
    return true;
  });
  router.afterEach((_to, _from, failure) => { if (failure) panes?.resume(); });
  // document.title is set in ONE place: useShellTitle's watcher (shell/pageTitle.ts), which follows the page-title store.
  return router;
}
