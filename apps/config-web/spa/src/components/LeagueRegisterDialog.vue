<script setup lang="ts">
// League join sheet (registration spec 2026-11-02 §5 (c), lane L6): a dialog (full screen on a phone) in three steps.
// 1. Team: a team built in the Roster Builder's league mode for this season (the default; "Build a team" opens it), or,
//    only when the organisers allow existing teams, another save or a library team. The per-race count shows by each
//    team ("Orc: 2 / 2, full"). The region from the league's list when it has regions.
// 2. Share & join: the league notice (what the organisers see), the share boxes (nothing ticked) and the required
//    acknowledgement. No NAF step (law 23: league organisers never set NAF). The Discord DM notice line.
// 3. Confirm: places, the approval mode in plain words, the entry fee, what happens now. Register.
// The server checks the team against the season's rules and is the authority for every rule; its message shows.
import { computed, inject, onMounted, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import DiscordDmNotice from "./DiscordDmNotice.vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createSharing, SHARE_LABEL, type ShareField } from "../account/sharing";
import {
  joinBody, joinChoices, joinOutcome, LEAGUE_JOIN_KEY, leagueApprovalWords, leagueBuilderHref, leaguePlacesLine, raceLine,
} from "../leagues/registration";
import ClubPickField from "./ClubPickField.vue";
import { loadMyClubs, type MyClub } from "../clubs/clubs";
import "../leagues/leagues.css";
import "../tournaments/registration.css";
import "../leagues/registration.css";

const props = defineProps<{ leagueName: string; seasonName: string }>();
const emit = defineEmits<{ close: [] }>();
const join = inject(LEAGUE_JOIN_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = join;
const status = computed(() => state.status);

type Step = "team" | "share" | "confirm";
const STEPS: ReadonlyArray<{ id: Step; label: string }> = [{ id: "team", label: "Team" }, { id: "share", label: "Share & join" }, { id: "confirm", label: "Confirm" }];
const step = ref<Step>("team");
const stepNo = computed(() => STEPS.findIndex((s) => s.id === step.value) + 1);

const choices = computed(() => joinChoices(state.options.saves, state.options.leagueTeams, status.value?.packageName ?? "", status.value?.allowExistingTeams === true, state.leagueId));
const teamRef = ref("");
watch(choices, (list) => { if (!list.some((c) => c.ref === teamRef.value)) teamRef.value = list[0]?.ref ?? ""; }, { immediate: true });
const chosen = computed(() => choices.value.find((c) => c.ref === teamRef.value));
/** The race a choice names in its caption ("Orc · built for this season"). */
const raceOf = (sub: string): string => sub.split(" · ")[0] ?? "";
const regions = computed(() => status.value?.regions ?? []);
const region = ref("");
// The club the coach represents in this season (clubs lane): one of their clubs or none.
const clubId = ref("");
const myClubs = ref<MyClub[]>([]);
const clubName = computed(() => myClubs.value.find((c) => c.id === clubId.value)?.name ?? "No club");
const teamTouched = ref(false);
const teamProblem = computed(() => (!teamRef.value
  ? "Pick a team, or build one for this season first."
  : regions.value.length && !region.value ? "Pick your region." : ""));
const buildHref = computed(() => leagueBuilderHref(state.leagueId, state.seasonId));

const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const acknowledged = ref(false);
const shareTouched = ref(false);

onMounted(() => {
  const coach = session.coach();
  if (coach && state.options.status === "idle") void join.loadOptions(coach);
  if (sharing) void sharing.load();
  if (fetcher) void loadMyClubs(fetcher).then((c) => { myClubs.value = c; });
});

const busy = computed(() => state.busy === "join");
const outcome = computed(() => joinOutcome(status.value, chosen.value ? raceOf(chosen.value.sub) : undefined));
const OUTCOME_TEXT = {
  accepted: "Your team is in as soon as you register.",
  pending: "Your registration waits for the organisers. You'll hear when they decide.",
  waitlisted: "It's full, so your team joins the waitlist and you'll hear if a place opens.",
  full: "It's full and there is no waitlist, so the registration will be refused.",
} as const;
const shareLine = computed(() => (share.value.length ? share.value.map((f) => SHARE_LABEL[f]).join(", ") : "Nothing beyond your coach name and teams"));

function back() {
  step.value = step.value === "confirm" ? "share" : "team";
}
async function next() {
  if (busy.value) return;
  if (step.value === "team") {
    teamTouched.value = true;
    if (!teamProblem.value) step.value = "share";
    return;
  }
  if (step.value === "share") {
    shareTouched.value = true;
    if (acknowledged.value) step.value = "confirm";
    return;
  }
  const ok = await join.join(joinBody({ teamRef: teamRef.value, region: region.value, share: share.value, acknowledged: acknowledged.value, clubId: clubId.value }, regions.value.length > 0));
  if (ok) emit("close");
}
</script>

<template>
  <LeagueDialog id="lr-join-h" class="tr-sheet lr-sheet" :title="`Register: ${props.leagueName}`" :cap="`Step ${stepNo} of 3`" wide tag="form" :busy="busy" @close="emit('close')" @submit="next">
    <ol class="tr-steps" aria-label="Steps">
      <li v-for="s in STEPS" :key="s.id" :aria-current="s.id === step ? 'step' : undefined">{{ s.label }}</li>
    </ol>

    <!-- 1. Team -->
    <template v-if="step === 'team'">
      <p class="tr-help">{{ props.seasonName }} · {{ status?.allowExistingTeams ? "a team built for this season, or one of your teams" : "a new team built under this season's rules" }}</p>
      <p v-if="state.options.status !== 'ok'" class="tr-help" role="status">Loading your teams...</p>
      <div v-else-if="choices.length" class="tr-cards" role="radiogroup" aria-label="Team">
        <button
          v-for="(c, i) in choices" :key="c.ref" type="button" role="radio" class="tr-card" :data-kind="c.kind" :data-ref="c.ref"
          :aria-checked="teamRef === c.ref ? 'true' : 'false'" :data-autofocus="i === 0 ? '' : undefined" @click="teamRef = c.ref"
        >
          <strong>{{ c.label }}</strong>
          <small>{{ c.sub }}</small>
          <small v-if="raceLine(status, raceOf(c.sub))" class="lr-race" :data-full="(status?.raceCounts[raceOf(c.sub)] ?? 0) >= (status?.perRace ?? Infinity) ? 'true' : 'false'">{{ raceLine(status, raceOf(c.sub)) }}</small>
        </button>
      </div>
      <p v-else class="tr-help">You have no team built for this season yet. Build one under the season's rules, then come back to register.</p>
      <div class="tr-build">
        <a class="sf-btn small" :href="buildHref" data-build-team>Build a team for this season</a>
        <span class="muted">The Roster Builder opens in league mode with this season's rules.</span>
      </div>
      <label v-if="regions.length" class="sf-field">
        <span class="sf-k">Region</span>
        <select v-model="region" class="sf-input tr-select" required>
          <option value="" disabled>Pick your region</option>
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
        <small class="muted hm-small">The organisers use regions when they make fixtures.</small>
      </label>
      <ClubPickField v-model="clubId" :clubs="myClubs" />
      <p v-if="teamTouched && teamProblem" class="sf-error" role="alert">{{ teamProblem }}</p>
    </template>

    <!-- 2. Share & join -->
    <template v-else-if="step === 'share'">
      <div class="lr-share">
        <p class="lr-share-text">{{ status?.shareText }}</p>
        <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" :legend="`What else the organisers of ${props.leagueName} can see`" />
        <label class="ob-check lr-ack">
          <input v-model="acknowledged" type="checkbox" required data-ack />
          <span>I agree to join {{ props.leagueName }}: its organisers can see my coach name and teams and send me league messages.</span>
        </label>
        <small class="muted hm-small">Nothing else is shared unless you tick it. Change it later under Account, Sharing.</small>
      </div>
      <p v-if="shareTouched && !acknowledged" class="sf-error" role="alert">Tick the box to confirm you agree to share your data with this league's organisers.</p>
      <DiscordDmNotice />
    </template>

    <!-- 3. Confirm -->
    <template v-else>
      <dl class="tr-sum">
        <dt>Team</dt><dd>{{ chosen?.label ?? "" }}<span v-if="chosen" class="muted"> · {{ chosen.sub }}</span></dd>
        <dt v-if="regions.length">Region</dt><dd v-if="regions.length">{{ region }}</dd>
        <dt v-if="myClubs.length">Club</dt><dd v-if="myClubs.length" data-club-summary>{{ clubName }}</dd>
        <dt>Places</dt><dd>{{ leaguePlacesLine(status) }}<span v-if="chosen && raceLine(status, raceOf(chosen.sub))" class="muted"> · {{ raceLine(status, raceOf(chosen.sub)) }}</span></dd>
        <dt>Approval</dt><dd>{{ leagueApprovalWords(status) }}</dd>
        <dt v-if="status?.entryFee">Entry fee</dt><dd v-if="status?.entryFee">{{ status.entryFee }}<span class="muted"> · paid to the organisers; your reference code shows on the league page</span></dd>
        <dt>Shared</dt><dd>{{ shareLine }}</dd>
        <dt v-if="status?.midSeason">Joining</dt><dd v-if="status?.midSeason">The season is in progress: the organisers add your fixtures.</dd>
      </dl>
      <p class="tr-outcome" :data-outcome="outcome" role="status">{{ OUTCOME_TEXT[outcome] }}</p>
    </template>

    <p v-if="state.error" class="sf-error" role="alert">{{ state.error }}</p>

    <template #foot>
      <button v-if="step !== 'team'" type="button" class="sf-btn" :disabled="busy" @click="back">Back</button>
      <button v-else type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="tr-foot-gap" />
      <button type="submit" class="sf-btn primary" :disabled="busy || (step === 'team' && state.options.status === 'ok' && !choices.length)">
        {{ step === "confirm" ? (busy ? "Registering..." : "Register") : "Next" }}
      </button>
    </template>
  </LeagueDialog>
</template>
