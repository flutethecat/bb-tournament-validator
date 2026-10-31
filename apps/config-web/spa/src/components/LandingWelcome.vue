<script setup lang="ts">
// Signed-out /home landing (owner 10-31): banner, welcome splash with the Discord login, then Past games.
// The sign-in card and the test sign-in are deliberately absent here; the header Login button and this splash are the way in.
import { RouterLink } from "vue-router";
import DiscordLoginButton from "./DiscordLoginButton.vue";
import RecentGames from "./RecentGames.vue";
import "../home/landing.css";

// Public assets, served as-is (a bound string keeps Vite from trying to bundle them).
const BANNER_BG = "/assets/motherboard-header.jpg";
const BANNER_LOGO = "/assets/super-fumbbl-logo.png";

defineProps<{ href: string; ssoEnabled: boolean }>();
</script>

<template>
  <div class="lw-landing">
    <!-- PLACEHOLDER banner (owner 10-31): motherboard header art with the Super FUMBBL logo; replace with final art. -->
    <div class="lw-banner" data-testid="landing-banner">
      <img class="lw-banner-bg" :src="BANNER_BG" alt="" aria-hidden="true" />
      <img class="lw-banner-logo" :src="BANNER_LOGO" alt="Super FUMBBL" />
    </div>

    <section class="lw-splash" aria-labelledby="lw-welcome">
      <div class="lw-splash-body">
        <h1 id="lw-welcome" class="lw-title">Welcome to Super FUMBBL League Manager!</h1>
        <p class="lw-sub">Run leagues and tournaments, build rosters and play your matches on Super FUMBBL.</p>
        <div class="lw-cta">
          <DiscordLoginButton v-if="ssoEnabled" :href="href" label="Login with Discord" />
          <p v-else class="lobby-error" role="alert">Discord sign-in is not set up on this server.</p>
          <RouterLink class="lw-link" to="/tournaments">Browse tournaments</RouterLink>
          <RouterLink class="lw-link" to="/leagues">Browse leagues</RouterLink>
        </div>
      </div>
    </section>

    <RecentGames class="rc-landing" />
  </div>
</template>
