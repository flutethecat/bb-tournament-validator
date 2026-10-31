<script setup lang="ts">
// Signed-out /home landing (owner 10-31): a welcome splash (logo, heading, copy, Discord login) over the stadium art,
// then Past games. The sign-in card and the test sign-in are deliberately absent; the header Login button and this
// splash are the way in. The header shows no page title here.
import { RouterLink } from "vue-router";
import DiscordLoginButton from "./DiscordLoginButton.vue";
import RecentGames from "./RecentGames.vue";
import { useBlankPageTitle } from "../shell/pageTitle";
import "../home/landing.css";

// Public assets, served as-is (a bound string keeps Vite from trying to bundle them).
// Splash artwork: ONE constant, so swapping candidates (e.g. to a candidate B file) is a one-line change.
const SPLASH_IMAGE = "/assets/welcome-splash.jpg";
const LOGO = "/assets/league-manager-logo.png";

defineProps<{ href: string; ssoEnabled: boolean }>();
useBlankPageTitle();
</script>

<template>
  <div class="lw-landing">
    <section class="lw-splash" aria-labelledby="lw-welcome" :style="{ '--lw-splash': `url(${SPLASH_IMAGE})` }">
      <div class="lw-box">
        <h2 id="lw-welcome" class="lw-logo"><img class="lw-logo-img" :src="LOGO" alt="Super FUMBBL League Manager" /></h2>
        <p class="lw-lead">Tell your league's story</p>
        <p class="lw-sub">Run your tabletop leagues and tournaments, build rosters for your favorite tournaments, contact your players, integrate with Discord, and have detailed league stats across multiple seasons.</p>
        <div class="lw-cta">
          <RouterLink class="lw-btn lw-btn-left" to="/tournaments">Browse tournaments</RouterLink>
          <DiscordLoginButton v-if="ssoEnabled" class="lw-login" :href="href" label="Login" />
          <p v-else class="lobby-error lw-login" role="alert">Discord sign-in is not set up on this server.</p>
          <RouterLink class="lw-btn lw-btn-right" to="/leagues">Browse leagues</RouterLink>
        </div>
      </div>
    </section>

    <RecentGames class="rc-landing" />
  </div>
</template>
