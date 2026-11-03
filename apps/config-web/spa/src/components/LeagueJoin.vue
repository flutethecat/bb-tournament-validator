<script setup lang="ts">
// League page, Overview: the season's registration block (registration spec 2026-11-02 §5 (c), lane L6) for signed-in
// coaches. While registration is open and the coach has no live entry: "Register a team" (the join sheet) and "Build a
// team for this season" (Roster Builder league mode). With an entry: "Registered: <team> · PENDING / ACCEPTED /
// WAITLIST #2", Withdraw while it waits (an accepted team leaves through the organisers), the organisers' reason for a
// decline, and "Register again" after a withdrawal while it is open. Facts and the entry come from GET .../join.
// `entryOnly` (an older season, review P2-3): shown only while the coach's entry there is live (pending, waitlisted,
// accepted), with Withdraw and its own Pay block (reference code, "I've paid"); no new registrations from it.
import { computed, inject, ref, watch } from "vue";
import LeagueRegisterDialog from "./LeagueRegisterDialog.vue";
import DiscordDmNotice from "./DiscordDmNotice.vue";
import PayEntryFee from "./PayEntryFee.vue";
import { API_KEY } from "../app";
import { createLeagueJoin, entryChip, type LeagueJoin as LeagueJoinController, isLiveEntry, LEAGUE_JOIN_KEY, leagueBuilderHref, leaguePlacesLine, STATE_TONE } from "../leagues/registration";
import "../tournaments/registration.css";
import "../leagues/registration.css";

const props = defineProps<{ leagueId: string; seasonId: string; leagueName: string; seasonName: string; entryOnly?: boolean; controller?: LeagueJoinController }>();
const fetcher = inject(API_KEY)!;
const join = props.controller ?? (props.entryOnly ? createLeagueJoin({ api: fetcher }) : inject(LEAGUE_JOIN_KEY)!);
const { state } = join;
const sheet = ref(false);
watch(() => [props.leagueId, props.seasonId] as const, ([id, sid]) => { void join.load(id, sid); }, { immediate: true });

const status = computed(() => state.status);
const mine = computed(() => state.mine);
const live = computed(() => isLiveEntry(mine.value?.state));
const canRegister = computed(() => !props.entryOnly && Boolean(status.value?.open) && !live.value && mine.value?.state !== "declined" && mine.value?.state !== "dropped");
const shown = computed(() => (props.entryOnly ? live.value : Boolean(mine.value) || Boolean(status.value?.open)));
const caption = computed(() => (status.value?.open ? (status.value.midSeason ? "Open mid-season" : "Open") : "Closed"));
</script>

<template>
  <section v-if="state.loaded && shown" class="hm-panel lr-join" :aria-labelledby="`lr-join-block-h-${seasonId}`" data-league-join>
    <header class="hm-band"><h2 :id="`lr-join-block-h-${seasonId}`">{{ entryOnly ? `Registration: ${seasonName}` : "Registration" }}</h2><span class="hm-cap">{{ entryOnly ? seasonName : caption }}</span></header>
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
      <PayEntryFee
        v-if="entryOnly && mine?.refCode" :id-prefix="`lr-${seasonId}`" :entry-fee="status?.entryFee" :links="status?.links ?? null"
        :ref-code="mine.refCode" :coach-says-paid="Boolean(mine.coachSaysPaid)" :paid="mine.paid === true" claimable
        :busy="state.busy === 'claim'" @claim="(paid) => join.claimPaid(paid)"
      />
      <DiscordDmNotice v-if="canRegister" />
      <p v-if="state.error && !sheet" class="sf-error" role="alert">{{ state.error }}</p>
      <p v-else-if="state.notice" class="tn-notice lr-notice" role="status">{{ state.notice }}</p>
    </div>
    <LeagueRegisterDialog v-if="sheet" :league-name="leagueName" :season-name="seasonName" @close="sheet = false" />
  </section>
</template>
