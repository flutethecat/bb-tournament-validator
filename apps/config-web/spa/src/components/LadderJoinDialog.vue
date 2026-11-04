<script setup lang="ts">
// Join a ladder (spec-league-ladder-2026-11-02, lane 8b): the season join sheet's pattern (LeagueRegisterDialog) in two
// steps. 1. Team: a team built and validated in the Roster Builder for this ladder (joins straight away when the organisers
// auto-approve validated teams), or, in a league-style ladder, one of your other teams, or one of your league teams moved in
// WITH its progression (the organisers approve those; a team with unplayed fixtures or open challenges can't move yet).
// 2. Share & join: the league notice, the share boxes (nothing ticked) and the acknowledgement. The server decides.
import { computed, inject, onMounted, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import DiscordDmNotice from "./DiscordDmNotice.vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createSharing, type ShareField } from "../account/sharing";
import { ladderBuilderHref, ladderJoinChoices, LADDERS_KEY } from "../leagues/ladder";
import "../leagues/leagues.css";
import "../tournaments/registration.css";
import "../leagues/registration.css";
import "../leagues/ladder.css";

const props = defineProps<{ leagueId: string; leagueName: string; ladderId: string; ladderName: string }>();
const emit = defineEmits<{ close: [] }>();
const ladders = inject(LADDERS_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = ladders;
const status = computed(() => state.join?.status);

type Step = "team" | "share";
const step = ref<Step>("team");
const choices = computed(() => ladderJoinChoices(state.options.saves, state.options.library, status.value?.packageName ?? "", status.value?.moves === true));
const movable = computed(() => state.join?.movable ?? []);
/** "save:<id>" / "library:<id>" or "move:<competition>:<teamId>". */
const pick = ref("");
watch([choices, movable], () => {
  if (pick.value) return;
  const free = movable.value.find((m) => !m.blocked);
  pick.value = choices.value[0]?.ref ?? (free ? `move:${free.id}:${free.teamId}` : "");
}, { immediate: true });
const chosenMove = computed(() => (pick.value.startsWith("move:") ? movable.value.find((m) => `move:${m.id}:${m.teamId}` === pick.value) : undefined));
const chosen = computed(() => choices.value.find((c) => c.ref === pick.value));
const outcome = computed(() => (chosenMove.value || chosen.value?.kind === "existing" || !status.value?.autoApprove
  ? "The organisers review this team before it joins. You'll hear when they decide."
  : "Built and validated for this ladder: your team joins straight away."));
const regions = computed(() => status.value?.regions ?? []);
const region = ref("");
const touched = ref(false);
const problem = computed(() => (!pick.value ? "Pick a team, or build one for this ladder first." : regions.value.length && !region.value ? "Pick your region." : ""));
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const acknowledged = ref(false);
const shareTouched = ref(false);
const busy = computed(() => state.busy === "join");
const buildHref = computed(() => ladderBuilderHref(props.leagueId, props.ladderId));
const tv = (v: number | null): string => (typeof v === "number" ? `${Math.round(v / 1000)}k TV` : "TV not known");

onMounted(() => {
  void ladders.loadOptions(session.coach());
  if (sharing) void sharing.load();
});

async function next(): Promise<void> {
  if (busy.value) return;
  if (step.value === "team") {
    touched.value = true;
    if (!problem.value) step.value = "share";
    return;
  }
  shareTouched.value = true;
  if (!acknowledged.value) return;
  const m = chosenMove.value;
  const body: Record<string, unknown> = {
    ...(m ? { move: { id: m.id, teamId: m.teamId } } : { teamRef: pick.value }),
    share: share.value, acknowledged: true, ...(regions.value.length && region.value ? { region: region.value } : {}),
  };
  if (await ladders.join(body)) emit("close");
}
</script>

<template>
  <LeagueDialog id="ld-join-h" class="tr-sheet lr-sheet" :title="`Join: ${props.ladderName}`" :cap="`Step ${step === 'team' ? 1 : 2} of 2`" wide tag="form" :busy="busy" @close="emit('close')" @submit="next">
    <ol class="tr-steps" aria-label="Steps">
      <li :aria-current="step === 'team' ? 'step' : undefined">Team</li>
      <li :aria-current="step === 'share' ? 'step' : undefined">Share &amp; join</li>
    </ol>
    <template v-if="step === 'team'">
      <p class="tr-help">{{ status?.style === "tournament" ? "This ladder resets rosters after every game: it takes new teams built under its rules." : "A team built for this ladder, one of your teams, or a league team moved in with its progression." }}</p>
      <p v-if="state.options.status !== 'ok'" class="tr-help" role="status">Loading your teams...</p>
      <div v-else class="tr-cards" role="radiogroup" aria-label="Team">
        <button
          v-for="(c, i) in choices" :key="c.ref" type="button" role="radio" class="tr-card" :data-kind="c.kind" :data-ref="c.ref"
          :aria-checked="pick === c.ref ? 'true' : 'false'" :data-autofocus="i === 0 ? '' : undefined" @click="pick = c.ref"
        >
          <strong>{{ c.label }}</strong>
          <small>{{ c.sub }}</small>
        </button>
        <button
          v-for="m in movable" :key="`${m.id}:${m.teamId}`" type="button" role="radio" class="tr-card ld-move-card" data-kind="move"
          :aria-checked="pick === `move:${m.id}:${m.teamId}` ? 'true' : 'false'" :disabled="Boolean(m.blocked)" @click="pick = `move:${m.id}:${m.teamId}`"
        >
          <strong>{{ m.team }}</strong>
          <small>{{ m.race }} · move from {{ m.competition }} · {{ tv(m.teamValue) }} · {{ m.games }} game{{ m.games === 1 ? "" : "s" }}</small>
          <small v-if="m.blocked" class="ld-blocked">{{ m.blocked }}</small>
        </button>
      </div>
      <p v-if="state.options.status === 'ok' && !choices.length && !movable.length" class="tr-help">You have no team built for this ladder yet. Build one under its rules, then come back to join.</p>
      <div class="tr-build">
        <a class="sf-btn small" :href="buildHref" data-build-team>Build a team for this ladder</a>
        <span class="muted">The Roster Builder opens in league mode with this ladder's rules.</span>
      </div>
      <label v-if="regions.length" class="sf-field">
        <span class="sf-k">Region</span>
        <select v-model="region" class="sf-input tr-select" required>
          <option value="" disabled>Pick your region</option>
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
      </label>
      <p class="sf-notice ld-outcome">{{ outcome }}</p>
      <p v-if="touched && problem" class="sf-error" role="alert">{{ problem }}</p>
    </template>
    <template v-else>
      <div class="lr-share">
        <p class="lr-share-text">{{ status?.shareText }}</p>
        <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" :legend="`What else the organisers of ${props.leagueName} can see`" />
        <label class="ob-check lr-ack">
          <input v-model="acknowledged" type="checkbox" required data-ack />
          <span>I agree to join {{ props.leagueName }}: its organisers can see my coach name and teams and send me league messages.</span>
        </label>
      </div>
      <p v-if="shareTouched && !acknowledged" class="sf-error" role="alert">Tick the box to confirm you agree to share your data with this league's organisers.</p>
      <DiscordDmNotice />
    </template>
    <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
    <template #foot>
      <button class="sf-btn" type="button" :disabled="busy" @click="step === 'team' ? emit('close') : (step = 'team')">{{ step === "team" ? "Cancel" : "Back" }}</button>
      <span class="tr-foot-gap" />
      <button class="sf-btn primary" type="submit" :disabled="busy">{{ step === "team" ? "Next" : busy ? "Joining..." : "Join the ladder" }}</button>
    </template>
  </LeagueDialog>
</template>
