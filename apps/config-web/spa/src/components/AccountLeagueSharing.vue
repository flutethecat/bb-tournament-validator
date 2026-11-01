<script setup lang="ts">
// LEAGUE DATA SHARING (Account page, owner 10-31): the leagues the coach is on (and any they still share with), whether
// their organisers see the coach's personal data, and "Stop sharing" / "Share" (the notice and its checkbox again).
import { computed, inject, onMounted, ref } from "vue";
import "../account/onboarding.css";
import { LEAGUE_SHARING_KEY, type LeagueSharingRow } from "../account/leagueSharing";
import { dateOf } from "../account/contact";

const props = defineProps<{ coach: string }>();
const sharing = inject(LEAGUE_SHARING_KEY)!;
const { state } = sharing;
/** The league whose Share form (notice + checkbox) is open. */
const open = ref("");
const rows = computed(() => state.leagues);
const statusText = (l: LeagueSharingRow) =>
  l.status === "shared" ? `Shared since ${dateOf(l.at)}` : l.status === "declined" ? `Not shared${l.at ? ` (since ${dateOf(l.at)})` : ""}` : "Not answered yet";
async function share(l: LeagueSharingRow): Promise<void> { if (await sharing.share(l.id)) open.value = ""; }

onMounted(() => { void sharing.load(props.coach); });
</script>

<template>
  <div class="ac-league-sharing">
    <p v-if="!state.loaded && !state.error" class="hm-empty">Loading…</p>
    <p v-else-if="!rows.length && state.loaded" class="muted hm-small">You are not on any league yet.</p>
    <ul v-else class="ac-share-list">
      <li v-for="l in rows" :key="l.id" class="ac-share-row" :data-share="l.status">
        <div class="ac-share-head">
          <strong>{{ l.name }}</strong>
          <span class="muted hm-small">{{ statusText(l) }}{{ l.onRoster ? "" : " · no longer on this league" }}</span>
          <button v-if="l.status === 'shared'" class="lobby-btn small" type="button" :disabled="Boolean(state.busy)" @click="sharing.decline(l.id)">Stop sharing</button>
          <button v-else-if="l.onRoster && open !== l.id" class="lobby-btn small" type="button" :disabled="Boolean(state.busy)" @click="open = l.id">Share…</button>
        </div>
        <div v-if="open === l.id && l.status !== 'shared'" class="ac-share-form">
          <p class="hm-small">{{ l.text }}</p>
          <label class="ob-check">
            <input type="checkbox" required :checked="state.ticked === l.id" @change="sharing.tick(l.id, ($event.target as HTMLInputElement).checked)" />
            <span>I agree that the organisers of {{ l.name }} can see my name and profile and send me league messages.</span>
          </label>
          <div class="ob-actions">
            <button class="lobby-btn primary small" type="button" :disabled="state.ticked !== l.id || Boolean(state.busy)" @click="share(l)">Share</button>
            <button class="lobby-btn small" type="button" @click="open = ''">Cancel</button>
          </div>
        </div>
      </li>
    </ul>
    <p class="muted hm-small">Organisers of a league you share with see your name and profile and can send you league messages through Super FUMBBL (only if you also allow league messages in Contact &amp; consent above). Your email address and phone numbers are never shown to them.</p>
    <p v-if="state.error" class="lobby-error hm-small" role="alert">{{ state.error }}</p>
  </div>
</template>
