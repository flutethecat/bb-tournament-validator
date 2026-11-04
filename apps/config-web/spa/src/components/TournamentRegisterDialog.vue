<script setup lang="ts">
// Register sheet (registration spec 2026-11-02 §7, wizards v2; lane L4): a dialog (full screen on a phone) in three steps.
// 1. Team: a saved team for this ruleset (cards), "Roster later" when the organiser allows it
//    (until the roster deadline), "Build one now" into the Roster Builder, and the region from the organisers' list.
// 2. Share & NAF: what the organisers see beyond the coach name and team (ShareFieldsPicker, nothing ticked), and on a
//    NAF-sanctioned tournament the profile NAF block (filled in automatically and the coach told, or "not a NAF member",
//    which tells the organisers). The Discord DM notice line (hidden without a bot token).
// 3. Confirm: places left, the approval mode in plain words, the entry fee, what happens now. Register.
// The server stays the authority for every rule; its message shows on a refusal.
import { computed, inject, onMounted, ref, watch } from "vue";
import LeagueDialog from "./LeagueDialog.vue";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import NafProfileField from "./NafProfileField.vue";
import DiscordDmNotice from "./DiscordDmNotice.vue";
import { API_KEY } from "../app";
import { SESSION_KEY } from "../session";
import { createSharing, SHARE_LABEL, type ShareField } from "../account/sharing";
import {
  linkProfileNaf, nafProblem, rulesetBuilderHref, TOURNAMENT_DETAIL_KEY, type NafLinkDraft, type ProfileNafView,
} from "../tournaments/detail";
import { approvalWords, expectedOutcome, placesLine, registerBody, registerChoices } from "../tournaments/registration";
import ClubPickField from "./ClubPickField.vue";
import { loadMyClubs, type MyClub } from "../clubs/clubs";
import "../leagues/leagues.css";
import "../tournaments/registration.css";

const emit = defineEmits<{ close: [] }>();
const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const status = computed(() => state.registrationStatus);

type Step = "team" | "share" | "confirm";
const STEPS: ReadonlyArray<{ id: Step; label: string }> = [{ id: "team", label: "Team" }, { id: "share", label: "Share & NAF" }, { id: "confirm", label: "Confirm" }];
const step = ref<Step>("team");
const stepNo = computed(() => STEPS.findIndex((s) => s.id === step.value) + 1);

const choices = computed(() => registerChoices(state.teamOptions.saves, t.value.packageName, status.value));
const teamRef = ref("");
watch(choices, (list) => { if (!list.some((c) => c.ref === teamRef.value)) teamRef.value = list[0]?.ref ?? ""; }, { immediate: true });
const chosen = computed(() => choices.value.find((c) => c.ref === teamRef.value));
const regions = computed(() => t.value.regions ?? []);
const region = ref("");
// The club the coach represents here (clubs lane): one of their clubs or none.
const clubId = ref("");
const myClubs = ref<MyClub[]>([]);
const clubName = computed(() => myClubs.value.find((c) => c.id === clubId.value)?.name ?? "No club");
const teamTouched = ref(false);
const teamProblem = computed(() => (!teamRef.value
  ? "Pick a team, or build one in the Roster Builder first."
  : regions.value.length && !region.value ? "Pick your region." : ""));
const buildHref = computed(() => `${rulesetBuilderHref(t.value.packageName)}&tournament=${encodeURIComponent(t.value.id)}`);

// The coach's phone and profile NAF details (GET /api/me/sharing), as in the NAF answer form.
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const notNafMember = ref(false);
const nafDraft = ref<NafLinkDraft>({ nafName: "", nafId: "" });
const sanctioned = computed(() => t.value.nafSanctioned === true);
const linkedNow = ref<ProfileNafView | null>(null);
const profileNaf = computed<ProfileNafView | null>(() => {
  if (linkedNow.value?.nafNumber) return linkedNow.value;
  const info = sharing?.state.info;
  return info?.nafNumber ? { nafNumber: info.nafNumber, ...(info.nafName ? { nafName: info.nafName } : {}) } : null;
});
const nafLoading = computed(() => Boolean(sharing && !sharing.state.loaded && !sharing.state.loadFailed));
const nafError = computed(() => nafProblem(sanctioned.value, profileNaf.value, notNafMember.value, nafDraft.value));
const nafTouched = ref(false);
const nafLinkError = ref("");
const nafLinking = ref(false);
const nafShown = computed(() => nafLinkError.value || (nafTouched.value ? nafError.value : ""));
watch(nafDraft, () => { nafLinkError.value = ""; });

onMounted(() => {
  const coach = session.coach();
  if (coach && state.teamOptions.status === "idle") void detail.loadTeamOptions(coach);
  if (sharing) void sharing.load();
  if (fetcher) void loadMyClubs(fetcher).then((c) => { myClubs.value = c; });
});

const busy = computed(() => state.busy === "register" || nafLinking.value);
const outcome = computed(() => expectedOutcome(status.value));
const OUTCOME_TEXT = {
  accepted: "You're in as soon as you register.",
  pending: "Your entry waits for the organisers. You'll hear when they decide.",
  waitlisted: "It's full, so you'll join the waitlist and hear if a place opens.",
  full: "It's full and there is no waitlist, so the entry will be refused.",
} as const;
const shareLine = computed(() => (share.value.length ? share.value.map((f) => SHARE_LABEL[f]).join(", ") : "Nothing beyond your coach name and team"));
const nafLine = computed(() => {
  if (!sanctioned.value) return "";
  if (notNafMember.value && !profileNaf.value) return "Not a NAF member (the organisers are told)";
  return profileNaf.value?.nafNumber ? `${profileNaf.value.nafName ?? ""} #${profileNaf.value.nafNumber}`.trim() : "Added to your profile on Register";
});
const error = computed(() => (state.lastAction === "register" ? state.actionError : ""));

/** Saves the inline NAF name and number to the profile when the form needs it; false = stop (the error is shown). */
async function ensureProfileNaf(): Promise<boolean> {
  if (!sanctioned.value || notNafMember.value || profileNaf.value?.nafNumber) return true;
  if (!fetcher) { nafLinkError.value = "Add your NAF name and number on your Account page."; return false; }
  nafLinking.value = true;
  nafLinkError.value = "";
  try {
    const saved = await linkProfileNaf(fetcher, nafDraft.value);
    linkedNow.value = saved;
    if (sharing) void sharing.load();
    return Boolean(saved.nafNumber);
  } catch (err) {
    nafLinkError.value = err instanceof Error && err.message ? err.message : "Can't save your NAF details. Try again.";
    return false;
  } finally {
    nafLinking.value = false;
  }
}

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
    nafTouched.value = true;
    if (!nafError.value) step.value = "confirm";
    return;
  }
  if (!(await ensureProfileNaf())) { step.value = "share"; return; }
  const declared = sanctioned.value && notNafMember.value && !profileNaf.value;
  const ok = await detail.registerEntry(registerBody({ teamRef: teamRef.value, region: region.value, share: share.value, notNafMember: declared, clubId: clubId.value }, regions.value.length > 0));
  if (ok) emit("close");
}
</script>

<template>
  <LeagueDialog id="tr-reg-h" class="tr-sheet" :title="`Register: ${t.name}`" :cap="`Step ${stepNo} of 3`" wide tag="form" :busy="busy" @close="emit('close')" @submit="next">
    <ol class="tr-steps" aria-label="Steps">
      <li v-for="s in STEPS" :key="s.id" :aria-current="s.id === step ? 'step' : undefined">{{ s.label }}</li>
    </ol>

    <!-- 1. Team -->
    <template v-if="step === 'team'">
      <p v-if="state.teamOptions.status !== 'ok'" class="tr-help" role="status">Loading your teams...</p>
      <div v-else-if="choices.length" class="tr-cards" role="radiogroup" aria-label="Team">
        <button
          v-for="(c, i) in choices" :key="c.ref" type="button" role="radio" class="tr-card" :data-kind="c.kind" :data-ref="c.ref"
          :aria-checked="teamRef === c.ref ? 'true' : 'false'" :data-autofocus="i === 0 ? '' : undefined" @click="teamRef = c.ref"
        >
          <strong>{{ c.label }}</strong><small>{{ c.sub }}</small>
        </button>
      </div>
      <p v-else class="tr-help">You have no team for this ruleset yet. Build one in the Roster Builder, then come back to register.</p>
      <div class="tr-build">
        <a class="sf-btn small" :href="buildHref">Build one now</a>
        <span class="muted">The Roster Builder opens on this tournament's ruleset.</span>
      </div>
      <p v-if="chosen?.kind === 'later'" class="tr-help">You enter now and submit your roster from My entry before the deadline.</p>
      <label v-if="regions.length" class="sf-field">
        <span class="sf-k">Region</span>
        <select v-model="region" class="sf-input tr-select" required>
          <option value="" disabled>Pick your region</option>
          <option v-for="r in regions" :key="r" :value="r">{{ r }}</option>
        </select>
        <small class="muted hm-small">The organisers use regions to pair coaches.</small>
      </label>
      <ClubPickField v-model="clubId" :clubs="myClubs" />
      <p v-if="teamTouched && teamProblem" class="sf-error" role="alert">{{ teamProblem }}</p>
    </template>

    <!-- 2. Share & NAF -->
    <template v-else-if="step === 'share'">
      <p v-if="sanctioned"><span class="sf-chip" data-tone="info" data-naf="sanctioned">NAF sanctioned</span></p>
      <NafProfileField
        v-if="sanctioned" v-model:not-naf-member="notNafMember" v-model:draft="nafDraft" id-prefix="tr-naf"
        :profile="profileNaf" :loading="nafLoading" :disabled="busy" :error="nafShown"
      />
      <div class="tn-reg-share">
        <p class="sf-k">Share with the organiser</p>
        <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" legend="What the organisers of this tournament can see" />
        <small class="muted hm-small">Organisers always see your coach name and team. Nothing else unless you tick it; change it later under Account, Sharing.</small>
      </div>
      <DiscordDmNotice />
    </template>

    <!-- 3. Confirm -->
    <template v-else>
      <dl class="tr-sum">
        <dt>Team</dt><dd>{{ chosen?.label ?? "" }}<span v-if="chosen" class="muted"> · {{ chosen.sub }}</span></dd>
        <dt v-if="regions.length">Region</dt><dd v-if="regions.length">{{ region }}</dd>
        <dt v-if="myClubs.length">Club</dt><dd v-if="myClubs.length" data-club-summary>{{ clubName }}</dd>
        <dt>Places</dt><dd>{{ placesLine(status) }}</dd>
        <dt>Approval</dt><dd>{{ approvalWords(status) }}</dd>
        <dt v-if="t.entryFee">Entry fee</dt><dd v-if="t.entryFee">{{ t.entryFee }}<span class="muted"> · paid to the organiser; your reference code shows in My entry</span></dd>
        <dt>Shared</dt><dd>{{ shareLine }}</dd>
        <dt v-if="sanctioned">NAF</dt><dd v-if="sanctioned">{{ nafLine }}</dd>
      </dl>
      <p class="tr-outcome" :data-outcome="outcome" role="status">{{ OUTCOME_TEXT[outcome] }}</p>
    </template>

    <p v-if="error" class="sf-error" role="alert">{{ error }}</p>

    <template #foot>
      <button v-if="step !== 'team'" type="button" class="sf-btn" :disabled="busy" @click="back">Back</button>
      <button v-else type="button" class="sf-btn" :disabled="busy" @click="emit('close')">Cancel</button>
      <span class="tr-foot-gap" />
      <button type="submit" class="sf-btn primary" :disabled="busy || (step === 'team' && state.teamOptions.status === 'ok' && !choices.length)">
        {{ step === "confirm" ? (nafLinking ? "Saving NAF details..." : "Register") : "Next" }}
      </button>
    </template>
  </LeagueDialog>
</template>
