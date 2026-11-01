<script setup lang="ts">
// League data-sharing notice (owner 10-31): one league at a time, shown in the shell after onboarding for each league
// the coach is on and has not answered. NON-blocking: a panel above the page, not a modal; the rest of the site works.
// Share needs the required checkbox; "Don't share" keeps the coach on the team (organisers then see public fields only).
import { computed, inject } from "vue";
import "../account/onboarding.css";
import { LEAGUE_SHARING_KEY } from "../account/leagueSharing";

const sharing = inject(LEAGUE_SHARING_KEY)!;
const { state } = sharing;
const league = computed(() => sharing.pending());
</script>

<template>
  <section v-if="league" class="tn-panel ls-notice" role="region" aria-labelledby="ls-notice-h" :aria-busy="state.busy ? 'true' : undefined">
    <h2 id="ls-notice-h" class="tn-band">Sharing your data with {{ league.name }}</h2>
    <div class="tn-panel-body">
      <p class="ls-notice-text">{{ league.text }}</p>
      <label class="ob-check">
        <input
          type="checkbox" required :checked="state.ticked === league.id" :disabled="Boolean(state.busy)"
          @change="sharing.tick(league.id, ($event.target as HTMLInputElement).checked)"
        />
        <span>I agree to share my personal data with the organisers of {{ league.name }}.</span>
      </label>
      <p class="muted hm-small ls-notice-help">If you don't share, you stay on your team; the organisers see only your public profile. You can change this on your Account page.</p>
      <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
      <div class="ob-actions">
        <button class="lobby-btn primary" type="button" :disabled="state.ticked !== league.id || Boolean(state.busy)" @click="sharing.share(league.id)">{{ state.busy === league.id ? "Saving…" : "Share" }}</button>
        <button class="lobby-btn" type="button" :disabled="Boolean(state.busy)" @click="sharing.decline(league.id)">Don't share</button>
      </div>
    </div>
  </section>
</template>
