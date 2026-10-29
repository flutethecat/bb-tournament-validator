<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, onMounted, onServerPrefetch, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import { API_KEY } from "./app";
import BellPopover from "./components/BellPopover.vue";
import ShellNav from "./components/ShellNav.vue";
import RecentGames from "./components/RecentGames.vue";
import SignInPrompt from "./components/SignInPrompt.vue";
import TestSignInCard from "./components/TestSignInCard.vue";
import { appPath, discordLoginUrl, SESSION_KEY } from "./session";
import { THEME_KEY, themeLabel } from "./theme";
import { gateFor } from "./router";
import { COACH_TREE_KEY } from "./home/tree";
import { DRAWER_QUERY, FOCUSABLE, rememberRail, SHELL_UI_KEY, trapTarget, typingTarget } from "./home/shell";
import { NOTIFICATIONS_KEY } from "./home/notifications";
import type { AccountInfo } from "./shared/api";

const session = inject(SESSION_KEY)!;
const theme = inject(THEME_KEY)!;
const fetcher = inject(API_KEY)!;
const tree = inject(COACH_TREE_KEY)!;
const ui = inject(SHELL_UI_KEY)!;
const route = useRoute();
const router = useRouter();

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
  <header class="shell-header sf-top" :data-rail="ui.collapsed ? 'true' : 'false'">
    <!-- Rail collapser (owner 10-30): in the top bar at the right edge of the sidebar column; desktop only (phones use Menu). -->
    <button
      class="sf-rail-toggle" type="button" :data-rail="ui.collapsed ? 'true' : 'false'"
      :aria-label="ui.collapsed ? 'Expand navigation ([)' : 'Collapse navigation ([)'" @click="toggleRail"
    ><span aria-hidden="true">{{ ui.collapsed ? "»" : "«" }}</span></button>
    <button
      ref="menuBtn" class="sf-menu" type="button" :aria-expanded="ui.drawerOpen ? 'true' : 'false'" aria-controls="sf-aside"
      aria-label="Menu" @click="ui.drawerOpen = !ui.drawerOpen"
    ><span aria-hidden="true">☰</span></button>
    <RouterLink class="brand sf-wordmark" to="/home" aria-label="Super FUMBBL home">Super FUMBBL</RouterLink>
    <div class="shell-who" aria-live="polite">
      <button class="lobby-btn small shell-theme" type="button" :aria-label="`Theme: ${themeLabel(theme.state.mode)}. Tap to change.`" @click="theme.cycle()">Theme: {{ themeLabel(theme.state.mode) }}</button>
      <template v-if="session.signedIn()">
        <BellPopover />
        <div class="sf-avatar-menu">
          <button class="shell-me" type="button" aria-haspopup="menu" :aria-expanded="menuOpen ? 'true' : 'false'" @click="menuOpen = !menuOpen">
            <img v-if="avatar" class="lobby-avatar small" :src="avatar" alt="" />
            <span>{{ session.coach() }}</span>
            <span aria-hidden="true" class="sf-menu-caret">▾</span>
          </button>
          <ul v-if="menuOpen" class="sf-avatar-list" role="menu">
            <li role="none"><RouterLink role="menuitem" to="/account">Account</RouterLink></li>
            <li role="none"><button role="menuitem" type="button" @click="signOut">Sign out</button></li>
          </ul>
        </div>
      </template>
      <a v-else-if="session.state.status === 'ready' && session.ssoEnabled()" class="lobby-btn primary small" :href="loginHref">
        Login with Discord
      </a>
    </div>
  </header>
  <div class="sf-body" :data-rail="ui.collapsed ? 'true' : 'false'">
    <div v-if="ui.drawerOpen" class="sf-scrim" aria-hidden="true" @click="ui.drawerOpen = false"></div>
    <aside
      id="sf-aside" ref="aside" class="sf-aside" :data-open="ui.drawerOpen ? 'true' : 'false'"
      :inert="drawerClosed || undefined" :aria-hidden="drawerClosed ? 'true' : undefined"
      :role="drawerModal ? 'dialog' : undefined" :aria-modal="drawerModal ? 'true' : undefined" :aria-label="drawerModal ? 'Navigation' : undefined"
      :tabindex="drawerModal ? -1 : undefined"
    >
      <ShellNav />
    </aside>
    <main class="shell-main">
      <p v-if="gate === 'loading'" class="muted">Loading…</p>
      <section v-else-if="gate === 'error'" class="lobby-card">
        <h2>Can't check your sign-in</h2>
        <p class="lobby-error" role="alert">{{ session.state.error }}</p>
        <button class="lobby-btn" type="button" @click="session.load(true)">Try again</button>
      </section>
      <template v-else-if="gate === 'signin'">
        <SignInPrompt :href="loginHref" :sso-enabled="session.ssoEnabled()" :other-session="session.otherSession()" />
        <TestSignInCard />
        <RecentGames class="rc-landing" />
      </template>
      <RouterView v-else :key="route.path" />
    </main>
  </div>
</template>
