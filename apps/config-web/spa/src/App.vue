<script setup lang="ts">
import { computed, inject, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { API_KEY } from "./app";
import SignInPrompt from "./components/SignInPrompt.vue";
import { appPath, discordLoginUrl, SESSION_KEY } from "./session";
import { gateFor, NAV } from "./router";
import type { AccountInfo } from "./shared/api";

const session = inject(SESSION_KEY)!;
const fetcher = inject(API_KEY)!;
const route = useRoute();

// RouterView is keyed by path: moving between two lobbies builds a fresh controller.
const gate = computed(() => gateFor(route, session));
const loginHref = computed(() => discordLoginUrl(appPath(route.fullPath)));
const avatar = ref("");

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
</script>

<template>
  <header class="shell-header">
    <RouterLink class="brand" to="/lobby">Super FUMBBL</RouterLink>
    <nav class="shell-nav" aria-label="Main">
      <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" class="shell-link">{{ item.label }}</RouterLink>
    </nav>
    <div class="shell-who" aria-live="polite">
      <RouterLink v-if="session.signedIn()" to="/account" class="shell-me">
        <img v-if="avatar" class="lobby-avatar small" :src="avatar" alt="" />
        <span>{{ session.coach() }}</span>
      </RouterLink>
      <a v-else-if="session.state.status === 'ready' && session.ssoEnabled()" class="lobby-btn primary small" :href="loginHref">
        Login with Discord
      </a>
    </div>
  </header>
  <main class="shell-main">
    <p v-if="gate === 'loading'" class="muted">Loading…</p>
    <section v-else-if="gate === 'error'" class="lobby-card">
      <h2>Can't check your sign-in</h2>
      <p class="lobby-error" role="alert">{{ session.state.error }}</p>
      <button class="lobby-btn" type="button" @click="session.load(true)">Try again</button>
    </section>
    <SignInPrompt v-else-if="gate === 'signin'" :href="loginHref" :sso-enabled="session.ssoEnabled()" />
    <RouterView v-else :key="route.path" />
  </main>
</template>
