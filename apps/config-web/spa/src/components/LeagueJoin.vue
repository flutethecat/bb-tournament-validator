<script setup lang="ts">
// League page, Overview: the season's registration block (registration spec 2026-11-02 §5 (c), lane L6) for signed-in
// coaches. While registration is open and the coach has no live entry: "Register a team" (the join sheet) and "Build a
// team for this season" (Roster Builder league mode). With an entry: "Registered: <team> · PENDING / ACCEPTED /
// WAITLIST #2", Withdraw while it waits (an accepted team leaves through the organisers), the organisers' reason for a
// decline, and "Register again" after a withdrawal while it is open. Facts and the entry come from GET .../join.
import { computed, inject, ref, watch } from "vue";
import LeagueRegisterDialog from "./LeagueRegisterDialog.vue";
import DiscordDmNotice from "./DiscordDmNotice.vue";
import { entryChip, isLiveEntry, LEAGUE_JOIN_KEY, leagueBuilderHref, leaguePlacesLine, STATE_TONE } from "../leagues/registration";
import "../tournaments/registration.css";
import "../leagues/registration.css";

const props = defineProps<{ leagueId: string; seasonId: string; leagueName: string; seasonName: string }>();
const join = inject(LEAGUE_JOIN_KEY)!;
const { state } = join;
const sheet = ref(false);
watch(() => [props.leagueId, props.seasonId] as const, ([id, sid]) => { void join.load(id, sid); }, { immediate: true });

const status = computed(() => state.status);
const mine = computed(() => state.mine);
const live = computed(() => isLiveEntry(mine.value?.state));
const canRegister = computed(() => Boolean(status.value?.open) && !live.value && mine.value?.state !== "declined" && mine.value?.state !== "dropped");
const shown = computed(() => Boolean(mine.value) || Boolean(status.value?.open));
const caption = computed(() => (status.value?.open ? (status.value.midSeason ? "Open mid-season" : "Open") : "Closed"));
</script>

<template>
  <section v-if="state.loaded && shown" class="hm-panel lr-join" aria-labelledby="lr-join-block-h" data-league-join>
    <header class="hm-band"><h2 id="lr-join-block-h">Registration</h2><span class="hm-cap">{{ caption }}</span></header>
    <div class="lr-join-body">
      <template v-if="mine">
        <p class="tr-state" data-my-entry>
          <span class="lr-join-k">Registered</span>
          <strong>{{ mine.teamName }}</strong>
          <span class="muted">{{ mine.race }}</span>
          <span class="sf-chip" :data-tone="STATE_TONE[mine.state]" :data-state="mine.state">{{ entryChip(mine) }}</span>
        </p>
        <p v-if="mine.state === 'pending'" class="tr-help">The organisers review every team. You'll hear when they decide.</p>
        <p v-else-if="mine.state === 'waitlisted'" class="tr-help">It's full. You'll hear if a place opens.</p>
        <p v-else-if="mine.state === 'accepted' && mine.midSeason" class="tr-help">Your team joined mid-season. The organisers add your fixtures.</p>
        <p v-else-if="mine.state === 'accepted'" class="tr-help">Your team is in the season.</p>
        <p v-else-if="mine.reason" class="tr-help">The organisers said: {{ mine.reason }}</p>
        <p v-else-if="mine.state === 'withdrawn'" class="tr-help">You withdrew this registration.</p>
      </template>
      <p v-else-if="status" class="tr-help">{{ leaguePlacesLine(status) }}. {{ status.approval === "auto" ? "Teams are accepted while there are places." : "The organisers review every team." }}</p>
      <div class="sf-btn-row lr-join-actions">
        <button v-if="canRegister" type="button" class="sf-btn primary" data-register @click="sheet = true">{{ mine?.state === "withdrawn" ? "Register again" : "Register a team" }}</button>
        <a v-if="canRegister" class="sf-btn" :href="leagueBuilderHref(leagueId, seasonId)">Build a team for this season</a>
        <button v-if="mine && (mine.state === 'pending' || mine.state === 'waitlisted')" type="button" class="sf-btn" :disabled="Boolean(state.busy)" data-withdraw @click="join.withdraw()">
          {{ state.busy === "withdraw" ? "Withdrawing..." : "Withdraw" }}
        </button>
      </div>
      <DiscordDmNotice v-if="canRegister" />
      <p v-if="state.error && !sheet" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-else-if="state.notice" class="tn-notice lr-notice" role="status">{{ state.notice }}</p>
    </div>
    <LeagueRegisterDialog v-if="sheet" :league-name="leagueName" :season-name="seasonName" @close="sheet = false" />
  </section>
</template>
