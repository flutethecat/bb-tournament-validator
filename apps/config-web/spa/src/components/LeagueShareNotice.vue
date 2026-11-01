<script setup lang="ts">
// League data-sharing notice (owner 10-31): one league at a time, shown in the shell after onboarding for each league
// the coach is on and has not answered. NON-blocking: a panel above the page, not a modal; the rest of the site works.
// This is the league registration step: Share needs the required checkbox and sends the Preferred name / Email / Phone
// boxes (default off) with it; "Don't share" keeps the coach on the team (organisers then see public fields only).
import { computed, inject } from "vue";
import "../account/onboarding.css";
import "../leagues/leagues.css";
import { LEAGUE_SHARING_KEY } from "../account/leagueSharing";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";

const sharing = inject(LEAGUE_SHARING_KEY)!;
const { state } = sharing;
const league = computed(() => sharing.pending());
</script>

<template>
  <section v-if="league" class="hm-panel ls-notice" role="region" aria-labelledby="ls-notice-h" :aria-busy="state.busy ? 'true' : undefined">
    <header class="hm-band" data-tone="info"><h2 id="ls-notice-h">Your profile and {{ league.name }}</h2><span class="hm-cap">League sharing</span></header>
    <div class="ls-notice-body">
      <p class="ls-notice-text">{{ league.text }}</p>
      <label class="ob-check">
        <input
          type="checkbox" required :checked="state.ticked === league.id" :disabled="Boolean(state.busy)"
          @change="sharing.tick(league.id, ($event.target as HTMLInputElement).checked)"
        />
        <span>I agree to join {{ league.name }}: its organisers can see my coach name and teams and send me league messages.</span>
      </label>
      <ShareFieldsPicker
        :model-value="state.fields[league.id] ?? []" :phone-on-file="state.phoneOnFile" :disabled="Boolean(state.busy)"
        :legend="`What else the organisers of ${league.name} can see`" @update:model-value="(v) => sharing.setFields(league!.id, v)"
      />
      <p class="muted hm-small ls-notice-help">If you don't share, you stay on your team; the organisers see only your coach name and NAF details. You can change this on your Account page.</p>
      <p v-if="state.error" class="ls-error hm-small" role="alert">{{ state.error }}</p>
      <div class="ob-actions">
        <button class="ls-btn primary" type="button" :disabled="state.ticked !== league.id || Boolean(state.busy)" @click="sharing.share(league.id)">{{ state.busy === league.id ? "Saving…" : "Share" }}</button>
        <button class="ls-btn" type="button" :disabled="Boolean(state.busy)" @click="sharing.decline(league.id)">Don't share</button>
      </div>
    </div>
  </section>
</template>
