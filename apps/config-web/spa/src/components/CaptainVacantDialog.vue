<script setup lang="ts">
// Choose a new Team Captain (owner 10-30: "If that player is ever killed then the coach should be able to nominate a new
// team captain"). Opens on the team sheet while the captaincy is vacant: the notice (LeagueDialog), then the shared player
// picker (TabletopPlayerPicker, the one picker every flow uses) offering only the players the server says are eligible
// (roster players, not Big Guys, not Stars), then a confirm step. "Later" closes it; it opens again the next time the
// sheet is opened while the captaincy is still vacant. The caller does the write (`appoint` resolves "" or an error).
import { computed, inject, ref } from "vue";
import { THEME_KEY } from "../theme";
import LeagueDialog from "./LeagueDialog.vue";
import TabletopPlayerPicker from "./TabletopPlayerPicker.vue";
import { CAPTAIN_VACANT_TITLE, captainGainText } from "../shared/captain";
import type { MatchView, RosterPlayerView, TeamView } from "../tabletop/recorder";
import "../leagues/leagues.css";

const props = defineProps<{ teamName: string; players: RosterPlayerView[]; appoint: (playerId: string) => Promise<string> }>();
const emit = defineEmits<{ close: [] }>();

const step = ref<"notice" | "pick" | "confirm">("notice");
const chosen = ref<RosterPlayerView | null>(null);
const busy = ref(false);
const error = ref("");
// The picker reads one roster ("home") and never the match while a single roster is offered.
const teams = computed<Record<"home" | "away", TeamView | undefined>>(() => ({ home: { name: props.teamName, players: props.players }, away: undefined }));
const noMatch = {} as MatchView;
// The recorder's light / dark picker styles key on data-tt-theme (as TabletopRecorderView sets it).
const themeCtl = inject(THEME_KEY, null);
const ttTheme = computed<"dark" | "light">(() => (themeCtl?.state.resolved === "light" ? "light" : "dark"));
const who = (p: RosterPlayerView): string => `${p.number !== undefined ? `#${p.number} ` : ""}${p.name || p.positionName || p.position || "Player"}`;

function picked(_side: "home" | "away", id: string): void {
  chosen.value = props.players.find((p) => p.id === id) ?? null;
  error.value = "";
  step.value = chosen.value ? "confirm" : "pick";
}
async function confirm(): Promise<void> {
  if (!chosen.value || busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const failed = await props.appoint(chosen.value.id);
    if (failed) error.value = failed;
    else emit("close");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <LeagueDialog v-if="step === 'notice'" id="cp-notice-h" title="Team Captain" :cap="teamName" role="alertdialog" describedby="cp-notice-text" @close="emit('close')">
    <p id="cp-notice-text" class="cp-text">{{ CAPTAIN_VACANT_TITLE }}</p>
    <p class="hm-small hm-empty">The new captain gains Team Captain and Pro for free. Big Guys and Star Players cannot be captain.</p>
    <p v-if="!players.length" class="sf-error" role="alert">No player on this roster can be captain right now.</p>
    <template #foot>
      <button type="button" class="sf-btn" @click="emit('close')">Later</button>
      <button type="button" class="sf-btn primary" data-autofocus :disabled="!players.length" @click="step = 'pick'">Choose a captain</button>
    </template>
  </LeagueDialog>
  <div v-else-if="step === 'pick'" class="ls-dialog-backdrop cp-pick" @click.self="step = 'notice'">
    <div class="tt-rec cp-host" :data-tt-theme="ttTheme">
      <TabletopPlayerPicker title="New Team Captain - who?" caption="Roster players, not Big Guys or Stars" :match="noMatch" :teams="teams" :sides="['home']" @pick="picked" @cancel="step = 'notice'" />
    </div>
  </div>
  <LeagueDialog v-else id="cp-confirm-h" title="Appoint Team Captain" :cap="teamName" :busy="busy" @close="step = 'pick'">
    <p class="cp-text">Make <strong>{{ chosen ? who(chosen) : "" }}</strong> the Team Captain?</p>
    <p class="hm-small hm-empty">{{ captainGainText(chosen?.skills) }}</p>
    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="step = 'pick'">Back</button>
      <button type="button" class="sf-btn primary" data-autofocus :disabled="busy" @click="confirm">{{ busy ? "Saving..." : "Appoint" }}</button>
    </template>
  </LeagueDialog>
</template>

<style scoped>
.cp-text { margin: 0 0 8px; }
/* The picker's tokens come from .tt-rec; here it is only a variable scope, not the recorder's full-screen grid. */
.cp-host { display: contents; }
</style>
