<script setup lang="ts">
// Overview "My entry" card (signed-in coaches only): Register with a library team while registration is open; once
// entered, the submitted team with its validity chip and problems, Submit team (Team Builder saves or library teams),
// the next fixture with a link to the opponent's team, and Withdraw.
// Registration (owner 10-31) carries "Share with the organiser" (Preferred name / Email / Phone, default off; phone only
// with one on file) and, on a NAF-sanctioned tournament, the required NAF number (prefilled from a verified NAF link) or
// "I am not a NAF member".
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import TeamSelect from "./TeamSelect.vue";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import { API_KEY } from "../app";
import { createSharing, type ShareField } from "../account/sharing";
import { SESSION_KEY, writesAllowed } from "../session";
import {
  isPageAction, myEntrant, nafProblem, nextFixtureFor, registrationOpen, ROSTER_LABEL, rosterState, submitChoices, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const coach = computed(() => session.coach());
const canWrite = computed(() => writesAllowed(session));
const t = computed(() => state.tournament!);
const mine = computed(() => myEntrant(state));
const entered = computed(() => Boolean(mine.value && !mine.value.droppedAt));
const open = computed(() => registrationOpen(t.value, state.rounds));
const locked = computed(() => Boolean(t.value.rostersLockedAt || mine.value?.flags?.frozen));
const closed = computed(() => t.value.status === "completed" || t.value.status === "cancelled");
const roster = computed(() => (mine.value ? rosterState(mine.value) : "none"));
const problems = computed(() => mine.value?.submission?.problems ?? []);
const choices = computed(() => submitChoices(state.teamOptions));
const groups = computed(() => (["Team Builder saves", "Library teams"] as const)
  .map((label) => ({ label, items: choices.value.filter((c) => c.group === label) }))
  .filter((g) => g.items.length));
const next = computed(() => (mine.value ? nextFixtureFor(mine.value.id, state) : null));

const teamId = ref("");
const saveRef = ref("");
watch(choices, (list) => {
  if (list.some((c) => c.ref === saveRef.value)) return;
  const current = mine.value?.submission?.saveId;
  saveRef.value = current && list.some((c) => c.ref === current) ? current : list[0]?.ref ?? "";
}, { immediate: true });

// The coach's phone / verified NAF number, for the registration picker (GET /api/me/sharing).
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const nafNumber = ref("");
const notNafMember = ref(false);
const sanctioned = computed(() => t.value.nafSanctioned === true);
const nafError = computed(() => nafProblem(sanctioned.value, nafNumber.value, notNafMember.value));
const nafTouched = ref(false);
watch(() => sharing?.state.info?.nafNumber, (n) => { if (n && !nafNumber.value) nafNumber.value = n; });

onMounted(() => {
  if (coach.value && state.teamOptions.status === "idle") void detail.loadTeamOptions(coach.value);
  if (coach.value && !mine.value && sharing) void sharing.load();
});

const busy = computed(() => Boolean(state.busy));
async function doRegister() {
  nafTouched.value = true;
  if (!teamId.value || nafError.value) return;
  await detail.register(teamId.value, { share: share.value, ...(sanctioned.value ? (notNafMember.value ? { notNafMember: true } : { nafNumber: nafNumber.value }) : {}) });
}
async function doSubmit() { if (saveRef.value) await detail.submit(saveRef.value); }
async function doWithdraw() { await detail.withdraw(); }
</script>

<template>
  <section v-if="coach" class="tn-panel tn-entry" aria-labelledby="tn-entry-h">
    <h3 id="tn-entry-h" class="tn-band">My entry</h3>
    <div class="tn-panel-body">
      <template v-if="!entered">
        <template v-if="open">
          <p class="muted">{{ mine?.droppedAt ? "You withdrew from this tournament." : "You are not entered yet." }}</p>
          <form v-if="!mine && canWrite" class="tn-reg-form" novalidate @submit.prevent="doRegister">
            <p v-if="sanctioned" class="tn-reg-chip"><span class="tn-chip" data-naf="sanctioned">NAF sanctioned</span></p>
            <div class="tn-inline-form">
              <label for="tn-reg-team">Team</label>
              <TeamSelect id="tn-reg-team" v-model="teamId" :teams="state.teamOptions.library" />
            </div>
            <div v-if="sanctioned" class="tn-reg-naf">
              <label for="tn-reg-naf">NAF number (required — this tournament is NAF sanctioned)</label>
              <input
                id="tn-reg-naf" v-model="nafNumber" type="text" inputmode="numeric" maxlength="10" autocomplete="off" :disabled="notNafMember"
                :aria-invalid="nafTouched && nafError ? 'true' : undefined" aria-describedby="tn-reg-naf-help" @blur="nafTouched = true"
              />
              <small id="tn-reg-naf-help" class="hm-small" :class="nafTouched && nafError ? 'lobby-error' : 'muted'">{{
                nafTouched && nafError ? nafError : "Not optional: your NAF number is shared with the organisers as part of your entry."
              }}</small>
              <label class="ob-check"><input v-model="notNafMember" type="checkbox" /> <span>I am not a NAF member</span></label>
            </div>
            <div class="tn-reg-share">
              <p class="tn-fact-k">Share with the organiser</p>
              <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" legend="What the organisers of this tournament can see" />
              <small class="muted hm-small">Organisers always see your coach name and team. Nothing else unless you tick it; change it later under Account, Sharing.</small>
            </div>
            <div class="tn-actions">
              <button class="lobby-btn primary" type="submit" :disabled="!teamId || busy || (nafTouched && Boolean(nafError))">Register</button>
            </div>
          </form>
          <p v-if="!mine && state.teamOptions.status === 'ok' && !state.teamOptions.library.length" class="muted">
            Your library is empty. Build a team in the Team Builder, then come back to register.
          </p>
        </template>
        <p v-else class="muted">{{ mine?.droppedAt ? "You withdrew from this tournament." : "Registration is closed." }}</p>
      </template>
      <template v-else-if="mine">
        <div class="tn-entry-head">
          <span class="tn-side-text">
            <strong>{{ mine.submission?.teamName || mine.teamName || mine.teamId }}</strong>
            <span class="muted">Seed {{ mine.seed }}{{ mine.race ? ` · ${mine.race}` : "" }}</span>
          </span>
          <span class="tn-chip" :data-roster="roster">{{ ROSTER_LABEL[roster] }}</span>
        </div>
        <ul v-if="problems.length" class="tn-problems" aria-label="Roster problems">
          <li v-for="(p, i) in problems" :key="i">{{ p }}</li>
        </ul>
        <p v-else-if="roster === 'none'" class="muted">Submit the team you will play so it can be checked against the ruleset.</p>

        <div v-if="next" class="tn-next" :data-side="next.opponentEntrantId ? 'vs' : 'bye'">
          <span class="tn-fact-k">Round {{ next.round }}</span>
          <strong v-if="next.opponentEntrantId">vs {{ next.opponentTeam }} <span class="muted">({{ next.opponentCoach }})</span></strong>
          <strong v-else>Bye</strong>
          <RouterLink
            v-if="next.opponentEntrantId" class="lobby-btn small"
            :to="{ name: 'tournament-team', params: { id: t.id, eid: next.opponentEntrantId } }"
          >Opponent's team</RouterLink>
        </div>

        <form v-if="!closed && canWrite" class="tn-inline-form" @submit.prevent="doSubmit">
          <label for="tn-submit-team">Submit team</label>
          <select id="tn-submit-team" v-model="saveRef" :disabled="locked || !choices.length">
            <option v-if="!choices.length" value="">No saved teams yet</option>
            <optgroup v-for="g in groups" :key="g.label" :label="g.label">
              <option v-for="c in g.items" :key="c.ref" :value="c.ref">{{ c.label }}</option>
            </optgroup>
          </select>
          <button class="lobby-btn primary" type="submit" :disabled="locked || !saveRef || busy">Submit team</button>
        </form>
        <p v-if="locked && !closed" class="muted">Rosters are locked. Ask an organiser to unlock them to change your team.</p>

        <div v-if="!closed && canWrite" class="tn-actions">
          <button class="lobby-btn" type="button" :disabled="busy" @click="doWithdraw">Withdraw</button>
        </div>
      </template>
      <p v-if="!canWrite" class="muted tn-readonly">Test sign-in sessions can look but cannot change tournament data.</p>
      <p v-if="state.actionError && !isPageAction(state.lastAction)" class="lobby-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="state.notice && !isPageAction(state.lastAction)" class="tn-notice" role="status">{{ state.notice }}</p>
    </div>
  </section>
</template>
