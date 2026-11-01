<script setup lang="ts">
import DiscordLoginButton from "./components/DiscordLoginButton.vue";
import { computed, inject, nextTick, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { API_KEY } from "./app";
import AccountMenu from "./components/AccountMenu.vue";
import BellPopover from "./components/BellPopover.vue";
import ShellNav from "./components/ShellNav.vue";
import LandingWelcome from "./components/LandingWelcome.vue";
import RecentGames from "./components/RecentGames.vue";
import SignInPrompt from "./components/SignInPrompt.vue";
import TestSignInCard from "./components/TestSignInCard.vue";
import TournamentCreateDialog from "./components/TournamentCreateDialog.vue";
import OnboardingDialog from "./components/OnboardingDialog.vue";
import { ONBOARDING_KEY } from "./account/onboarding";
import LeagueShareNotice from "./components/LeagueShareNotice.vue";
import { LEAGUE_SHARING_KEY } from "./account/leagueSharing";
import { canCreateTournament, TOURNAMENT_CREATOR_KEY } from "./tournaments/create";
import { appPath, discordLoginUrl, SESSION_KEY } from "./session";
import { THEME_KEY, themeLabel } from "./theme";
import { gateFor } from "./router";
import { COACH_TREE_KEY } from "./home/tree";
import { DRAWER_QUERY, FOCUSABLE, rememberRail, SHELL_UI_KEY, trapTarget, typingTarget } from "./home/shell";
import { useShellTitle } from "./shell/pageTitle";
import { NOTIFICATIONS_KEY } from "./home/notifications";
import type { AccountInfo } from "./shared/api";
import { clearFlash, flash } from "./account/privacy";

const session = inject(SESSION_KEY)!;
const theme = inject(THEME_KEY)!;
const fetcher = inject(API_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const ui = inject(SHELL_UI_KEY)!;
const route = useRoute();
const router = useRouter();
// Header title colour follows the section (owner 10-31): Tournaments and Leagues pages carry gold, every other page red.
const titleArea = computed(() => (/^\/(tournaments|tournament-creator|admin\/tournaments|leagues)(\/|$|\?)/.test(route.path) ? "gold" : "red"));
const pageTitle = useShellTitle();
const creator = inject(TOURNAMENT_CREATOR_KEY, null);
// "Create tournament" in the account menu: organisers only, the server's POST /api/tournaments rule. The rule gates
// opening only: once open, the dialog stays until Cancel / Escape even if the session lapses (its 401 error shows).
const canCreate = computed(() => Boolean(creator) && canCreateTournament(session));
// New-user flow (owner 10-31): while the signed-in coach has not completed onboarding, the welcome modal blocks the shell
// on every route (header and body inert). Read once per coach, in the browser only.
const onboarding = inject(ONBOARDING_KEY, null);
const onboardingOpen = computed(() => onboarding?.open() === true);
onMounted(() => watch(() => session.coach(), (coach) => void onboarding?.load(coach), { immediate: true }));
// League data-sharing notice (owner 10-31): once onboarding is done, the leagues the coach has not answered show a
// non-blocking notice above the page, one at a time.
const leagueSharing = inject(LEAGUE_SHARING_KEY, null);
const onboardingSettled = computed(() => Boolean(onboarding?.state.info) && !onboardingOpen.value);
onMounted(() => watch(() => [session.coach(), onboardingSettled.value] as const, ([coach, settled]) => {
  void leagueSharing?.load(settled ? coach : "");
}, { immediate: true }));
const createOpen = computed(() => creator?.state.open === true || onboardingOpen.value);
function openCreate(): void {
  menuOpen.value = false;
  if (canCreate.value) creator?.show();
}

// RouterView is keyed by path: moving between two lobbies builds a fresh controller.
const gate = computed(() => gateFor(route, session));
const loginHref = computed(() => discordLoginUrl(appPath(route.fullPath)));
const avatar = ref("");
const menuOpen = ref(false);
/** The shared notifications store (createSpa): BellPopover shows its unread count. */
const notifications = inject(NOTIFICATIONS_KEY)!;
// The bell holds one subscription while a coach is signed in (browser only; never during a server render).
let bellSubscribed = false;
function followSession(coach: string): void {
  if (coach && !bellSubscribed) { bellSubscribed = true; void notifications.load(); notifications.subscribe(); }
  else if (!coach && bellSubscribed) { bellSubscribed = false; notifications.unsubscribe(); }
}
onMounted(() => watch(() => session.coach(), followSession, { immediate: true }));
onBeforeUnmount(() => { if (bellSubscribed) { bellSubscribed = false; notifications.unsubscribe(); } });

// Header avatar: the Discord avatar (or profile avatar) /api/account returns; the name alone is enough on failure.
watch(
  () => session.coach(),
  async (coach) => {
    avatar.value = "";
    if (!coach) return;
    try {
      const account = await fetcher<AccountInfo>("/api/account");
      if (session.coach() === coach) avatar.value = account.profile?.avatar || account.discordAvatarUrl || "";
    } catch { /* name only */ }
  },
  { immediate: true },
);

// Nav trees follow the signed-in coach (server render waits for them so the rows are in the HTML).
watch(() => session.coach(), (coach) => void tree.load(coach), { immediate: true });
onServerPrefetch(() => tree.load(session.coach()));

// A route change closes the drawer and refreshes the trees (at most once a minute).
// Every navigation also re-reads the session (throttled to once a minute) so a revoked admin flag or an expired
// session reaches the shell without a reload.
watch(() => route.fullPath, () => { ui.drawerOpen = false; menuOpen.value = false; void tree.refresh(); void session.revalidate(); });

// The drawer (< 1024 px): inert and hidden while closed; open, focus moves to its first row and Tab stays inside;
// closing (Escape, the scrim, a row) puts focus back on the Menu button.
const aside = ref<HTMLElement | null>(null);
const menuBtn = ref<HTMLButtonElement | null>(null);
const drawerClosed = computed(() => ui.narrow && !ui.drawerOpen);
const drawerModal = computed(() => ui.narrow && ui.drawerOpen);
const focusables = (): HTMLElement[] => Array.from(aside.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
watch(drawerModal, async (open, was) => {
  if (typeof document === "undefined") return;
  await nextTick();
  if (open) (focusables()[0] ?? aside.value)?.focus({ preventScroll: true });
  else if (was && ui.narrow) menuBtn.value?.focus({ preventScroll: true });
});

function toggleRail(): void {
  ui.collapsed = !ui.collapsed;
  rememberRail(ui);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") { ui.drawerOpen = false; menuOpen.value = false; return; }
  if (e.key === "Tab" && drawerModal.value) {
    const target = trapTarget(focusables(), document.activeElement as HTMLElement | null, e.shiftKey);
    if (target) { e.preventDefault(); target.focus({ preventScroll: true }); }
    return;
  }
  if (e.key !== "[" || e.ctrlKey || e.metaKey || e.altKey || typingTarget(e.target)) return;
  e.preventDefault();
  if (ui.narrow) ui.drawerOpen = !ui.drawerOpen;
  else toggleRail();
}
// Coming back to the tab refreshes the trees (same once-a-minute bound).
const onFocus = () => { void tree.refresh(); void session.revalidate(); };
const onVisible = () => { if (document.visibilityState === "visible") void session.revalidate(); };
let media: MediaQueryList | undefined;
const onMedia = () => { ui.narrow = media?.matches === true; if (!ui.narrow) ui.drawerOpen = false; };
onMounted(() => {
  window.addEventListener("keydown", onKey);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisible);
  media = window.matchMedia?.(DRAWER_QUERY);
  onMedia();
  media?.addEventListener?.("change", onMedia);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisible);
  media?.removeEventListener?.("change", onMedia);
});

async function signOut(): Promise<void> {
  menuOpen.value = false;
  await session.signOut();
  void router.push("/home");
}
</script>

<template>
  <header class="shell-header sf-top" :data-rail="ui.collapsed ? 'true' : 'false'" :data-title="titleArea" :inert="createOpen || undefined" :aria-hidden="createOpen ? 'true' : undefined">
    <button
      ref="menuBtn" class="sf-menu" type="button" :aria-expanded="ui.drawerOpen ? 'true' : 'false'" aria-controls="sf-aside"
      aria-label="Menu" @click="ui.drawerOpen = !ui.drawerOpen"
    ><span aria-hidden="true">☰</span></button>
    <!-- the wordmark with the page title stacked under it (owner 10-31) -->
    <div class="sf-titleblock">
      <RouterLink class="brand sf-wordmark" to="/home" aria-label="Super FUMBBL home">Super FUMBBL</RouterLink>
      <h1 class="sf-page-title" aria-live="polite">{{ pageTitle }}</h1>
    </div>
    <!-- a page's own header controls (Teleport target; empty on every page but the Tournament Builder, owner 10-31) -->
    <div id="sf-header-slot" class="sf-header-slot"></div>
    <div class="shell-who" aria-live="polite">
      <template v-if="session.signedIn()">
        <BellPopover />
        <div class="sf-avatar-menu">
          <button class="shell-me" type="button" aria-haspopup="menu" :aria-expanded="menuOpen ? 'true' : 'false'" @click="menuOpen = !menuOpen">
            <img v-if="avatar" class="sf-avatar small" :src="avatar" alt="" />
            <span>{{ session.coach() }}</span>
            <span aria-hidden="true" class="sf-menu-caret">▾</span>
          </button>
          <AccountMenu v-if="menuOpen" :can-create="canCreate" @create="openCreate" @sign-out="signOut" />
        </div>
      </template>
      <DiscordLoginButton v-else-if="session.state.status === 'ready' && session.ssoEnabled()" :href="loginHref" label="Login" />
    </div>
  </header>
  <div class="sf-body" :data-rail="ui.collapsed ? 'true' : 'false'" :inert="createOpen || undefined" :aria-hidden="createOpen ? 'true' : undefined">
    <div v-if="ui.drawerOpen" class="sf-scrim" aria-hidden="true" @click="ui.drawerOpen = false"></div>
    <aside
      id="sf-aside" ref="aside" class="sf-aside" :data-open="ui.drawerOpen ? 'true' : 'false'"
      :inert="drawerClosed || undefined" :aria-hidden="drawerClosed ? 'true' : undefined"
      :role="drawerModal ? 'dialog' : undefined" :aria-modal="drawerModal ? 'true' : undefined" :aria-label="drawerModal ? 'Navigation' : undefined"
      :tabindex="drawerModal ? -1 : undefined"
    >
      <ShellNav />
      <!-- Theme switch (owner 10-31): an icon at the bottom left of the screen. Sun = light, moon = dark, half sun / half
           moon = automatic (follows the device). Click cycles System -> Light -> Dark. -->
      <div class="sf-aside-foot">
        <button
          class="sf-theme" type="button" :data-mode="theme.state.mode"
          :aria-label="`Theme: ${themeLabel(theme.state.mode)}. Tap to change.`" @click="theme.cycle()"
        >
          <svg v-if="theme.state.mode === 'light'" class="sf-theme-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="4.5" fill="currentColor" />
            <g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" /></g>
          </svg>
          <svg v-else-if="theme.state.mode === 'dark'" class="sf-theme-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M20.3 14.6A8.5 8.5 0 0 1 9.4 3.7a8.5 8.5 0 1 0 10.9 10.9Z" />
          </svg>
          <svg v-else class="sf-theme-ico" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
            <path fill="currentColor" d="M12 5.5a6.5 6.5 0 0 0 0 13Z" />
            <path fill="currentColor" d="M12 5.5a6.5 6.5 0 0 1 0 13 4.6 4.6 0 0 0 0-13Z" opacity=".55" />
            <circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6" />
            <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 1.8v2M4.8 4.8l1.4 1.4M1.8 12h2M4.8 19.2l1.4-1.4M12 20.2v2" /></g>
          </svg>
          <span class="sf-sr">Theme: {{ themeLabel(theme.state.mode) }}</span>
        </button>
        <RouterLink class="sf-privacy-link" to="/privacy" data-testid="nav-privacy">Privacy</RouterLink>
      </div>
    </aside>
    <!-- Rail collapser (owner 10-31): a tag hanging on the sidebar's right edge at the bottom of the screen; desktop only
         (phones use Menu). -->
    <button
      class="sf-rail-toggle" type="button" :data-rail="ui.collapsed ? 'true' : 'false'"
      :aria-label="ui.collapsed ? 'Expand navigation ([)' : 'Collapse navigation ([)'" @click="toggleRail"
    ><span aria-hidden="true">{{ ui.collapsed ? "»" : "«" }}</span></button>
    <main class="shell-main">
      <p v-if="flash.message" class="sf-flash" role="status">{{ flash.message }} <button class="sf-btn small" type="button" @click="clearFlash()">Dismiss</button></p>
      <p v-if="gate === 'loading'" class="muted">Loading…</p>
      <section v-else-if="gate === 'error'" class="hm-panel sf-solo" aria-labelledby="sf-gate-h">
        <header class="hm-band"><h2 id="sf-gate-h">Can't check your sign-in</h2></header>
        <p class="sf-error" role="alert">{{ session.state.error }}</p>
        <div class="sf-btn-row"><button class="sf-btn" type="button" @click="session.load(true)">Try again</button></div>
      </section>
      <LandingWelcome v-else-if="gate === 'signin' && route.name === 'home' && !session.otherSession()" :href="loginHref" :sso-enabled="session.ssoEnabled()" />
      <template v-else-if="gate === 'signin'">
        <SignInPrompt :href="loginHref" :sso-enabled="session.ssoEnabled()" :other-session="session.otherSession()" />
        <TestSignInCard />
        <RecentGames class="rc-landing" />
      </template>
      <template v-else>
        <LeagueShareNotice v-if="leagueSharing && session.signedIn() && !onboardingOpen" />
        <RouterView :key="route.path" />
      </template>
    </main>
  </div>
  <TournamentCreateDialog v-if="creator?.state.open && !onboardingOpen" />
  <OnboardingDialog v-if="onboardingOpen" @sign-out="signOut" />
</template>
