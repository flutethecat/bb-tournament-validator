<script setup lang="ts">
// The sign-in card on every signed-out page (except the home splash): a panel with a band heading, the site's Discord
// button and the privacy line.
import { RouterLink } from "vue-router";
import DiscordLoginButton from "./DiscordLoginButton.vue";
defineProps<{ href: string; ssoEnabled: boolean; otherSession?: boolean }>();
</script>

<template>
  <section class="hm-panel sg-card" aria-label="Sign in">
    <header class="hm-band"><h2>Sign in</h2><span class="hm-cap">Discord</span></header>
    <div class="sg-body">
      <p class="sg-lead">{{ otherSession ? "This page needs a Discord sign-in." : "Sign in with Discord to use this page." }}</p>
      <DiscordLoginButton v-if="ssoEnabled" class="sg-login" :href="href" />
      <p v-else class="sf-error" role="alert">Discord sign-in is not set up on this server.</p>
      <p v-if="ssoEnabled" class="sg-privacy" data-testid="signin-privacy">By signing in you agree to the <RouterLink to="/privacy">Privacy notice</RouterLink>.</p>
    </div>
  </section>
</template>

<style>
/* Sign-in card (SignInPrompt.vue) and the host-only test sign-in card (TestSignInCard.vue). Tokens only. */
.sg-body { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 24px; }
.sg-lead { flex: 0 1 auto; margin: 0; font-size: 17px; }
.sg-login { min-height: 44px; padding: 8px 18px; font-size: 15px; }
.sg-privacy { flex: 1 1 100%; margin: 0; padding-top: 8px; font-size: 13px; color: var(--ui-muted); border-top: 1px solid var(--sf-panel-line); }
.sg-privacy a { color: inherit; text-decoration: underline; }
.sg-privacy a:hover { color: var(--ui-text); }
/* Signed-out pages stack the cards from the top instead of stretching them over the viewport height. */
.shell-main:has(> .sg-card) { align-content: start; }
/* The test card is secondary: flat surface, dashed edge, muted band, a compact single-row form. */
.hm-panel.sg-test { container-type: inline-size; background: color-mix(in srgb, var(--ui-surface-2) 55%, transparent); border-style: dashed; box-shadow: none; }
.sg-test .hm-band { border-left-color: var(--ui-muted); }
.sg-test .hm-band h2 { color: var(--ui-muted); font-size: 12px; }
.sg-test-help { margin: 0 0 10px; font-size: 13px; color: var(--ui-muted); }
.sg-test-form { display: grid; grid-template-columns: minmax(0, 280px) minmax(0, 240px) max-content; justify-content: start; align-items: end; gap: 10px 12px; }
.sg-test-form .ob-btn { min-height: 44px; }
.sg-test-out { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 10px; }
.sg-test-out:empty { display: none; }
.sg-test-out p { margin: 0; }
@container (max-width: 640px) { .sg-test-form { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 720px) {
  .sg-login { width: 100%; justify-content: center; }
  .sg-test-form { grid-template-columns: minmax(0, 1fr); }
}
</style>
