<script setup lang="ts">
// Apply for a team that is Available for Takeover (spec-team-management-2026-11-02): (a) with one of your own teams (a
// Roster Builder save or a library team, judged against the season by the server and greyed with the reason when it
// doesn't fit; "Build a team" opens the Roster Builder in league mode), or (b) take this team over (its standings and
// players stay; your rating never takes its past games). Coaches new to the league see the league notice and the share
// boxes (nothing ticked) with the required acknowledgement, as at join. The organisers decide.
import { computed, inject, onMounted, ref } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import { API_KEY } from "../app";
import { createSharing, type ShareField } from "../account/sharing";
import { leagueBuilderHref } from "../leagues/registration";
import { applyBody, libraryGroups, librarySub, type Takeovers } from "../leagues/takeover";
import "../tournaments/registration.css";
import "../leagues/registration.css";
import "../leagues/takeover.css";

const props = defineProps<{ takeovers: Takeovers; listingId: string; teamName: string; leagueName: string }>();
const emit = defineEmits<{ close: []; applied: [] }>();
const { state } = props.takeovers;
const member = computed(() => state.view?.member === true);
const mode = ref<"team" | "takeover">("takeover");
const teamRef = ref("");
const groups = computed(() => libraryGroups(state.myTeams.items));
const picked = computed(() => state.myTeams.items.find((i) => i.ref === teamRef.value && i.ok));
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const acknowledged = ref(false);
const touched = ref(false);
const buildHref = computed(() => leagueBuilderHref(state.leagueId, state.seasonId));
const busy = computed(() => state.busy === "apply");
const problem = computed(() => {
  if (mode.value === "team" && !picked.value) return "Pick one of your teams that fits this season, or build one.";
  if (!member.value && !acknowledged.value) return "Tick the box to confirm you agree to share your data with this league's organisers.";
  return "";
});
onMounted(() => {
  if (state.myTeams.status === "idle") void props.takeovers.loadMyTeams();
  if (sharing && !member.value) void sharing.load();
});

async function submit(): Promise<void> {
  touched.value = true;
  if (problem.value || busy.value) return;
  if (await props.takeovers.apply(props.listingId, applyBody({ mode: mode.value, teamRef: teamRef.value, share: share.value, acknowledged: acknowledged.value }, member.value))) emit("applied");
}
</script>

<template>
  <LeagueDialog id="tk-apply-h" class="tr-sheet lr-sheet" wide :title="`Apply: ${teamName}`" :cap="leagueName" tag="form" :busy="busy" @close="emit('close')" @submit="submit">
    <fieldset class="tk-mode">
      <legend class="tb-k">How you'd like to coach it</legend>
      <div class="tk-mode-pick" role="radiogroup" aria-label="How you'd like to coach it">
        <button type="button" role="radio" class="tr-card" :aria-checked="mode === 'takeover' ? 'true' : 'false'" data-mode="takeover" data-autofocus @click="mode = 'takeover'">
          <strong>Take over this team</strong>
          <small>{{ teamName }} becomes yours: its standings, players and skills stay. Your record counts from your first game.</small>
        </button>
        <button type="button" role="radio" class="tr-card" :aria-checked="mode === 'team' ? 'true' : 'false'" data-mode="team" @click="mode = 'team'">
          <strong>Apply with your own team</strong>
          <small>Your team takes this place in the league and keeps its standings and fixtures.</small>
        </button>
      </div>
    </fieldset>

    <template v-if="mode === 'team'">
      <p v-if="state.myTeams.status !== 'ok'" class="tr-help" role="status">Loading your teams...</p>
      <p v-else-if="!state.myTeams.items.length" class="tr-help">You have no teams yet.</p>
      <div v-for="g in groups" :key="g.kind" class="tk-group">
        <h3 class="tb-k">{{ g.label }}</h3>
        <div class="tr-cards tk-cards" role="radiogroup" :aria-label="g.label">
          <button
            v-for="i in g.items" :key="i.ref" type="button" role="radio" class="tr-card tk-card" :data-ref="i.ref"
            :aria-checked="teamRef === i.ref ? 'true' : 'false'" :disabled="!i.ok" @click="teamRef = i.ref"
          >
            <strong>{{ i.name }}</strong>
            <small>{{ librarySub(i) }}</small>
            <small v-if="!i.ok" class="tk-why">{{ i.reason }}</small>
          </button>
        </div>
      </div>
      <div class="tr-build">
        <a class="sf-btn small" :href="buildHref" data-build-team>Build a team for this season</a>
        <span class="muted">The Roster Builder opens in league mode with this season's rules.</span>
      </div>
    </template>

    <div v-if="!member" class="lr-share" data-share-step>
      <p class="lr-share-text">You are joining {{ leagueName }}. Its organisers can see your coach name and your teams. Choose below what else they can see.</p>
      <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" :legend="`What else the organisers of ${leagueName} can see`" />
      <label class="ob-check lr-ack">
        <input v-model="acknowledged" type="checkbox" data-ack />
        <span>I agree to join {{ leagueName }}: its organisers can see my coach name and teams and send me league messages.</span>
      </label>
    </div>

    <p v-if="touched && problem" class="sf-error" role="alert">{{ problem }}</p>
    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>
    <template #foot>
      <button type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="tr-foot-gap" />
      <button type="submit" class="sf-btn primary" :disabled="busy" data-apply-go>{{ busy ? "Sending..." : "Send application" }}</button>
    </template>
  </LeagueDialog>
</template>
