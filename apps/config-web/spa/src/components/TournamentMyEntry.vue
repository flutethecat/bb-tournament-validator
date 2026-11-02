<script setup lang="ts">
// Overview "My entry" card (signed-in coaches only): Register with a library team while registration is open; once
// entered, the submitted team with its validity chip and problems, Submit team (Team Builder saves or library teams),
// the next fixture with a link to the opponent's team, and Withdraw.
// Registration (owner 10-31) carries "Share with the organiser" (Preferred name / Email / Phone, default off; phone only
// with one on file) and, on a NAF-sanctioned tournament, the NAF block (NafProfileField): the NAF name and number on the
// coach's profile are shared with the organiser (one read-only line, no typing), or a coach without them adds them here
// (saved to the profile through the Account NAF link) or ticks "I am not a NAF member". The NAF answer form of an entry
// that owes it (organiser-made, or the tournament became sanctioned) works the same way.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import TeamSelect from "./TeamSelect.vue";
import { proposePath, tournamentFixtureRef } from "../schedule/schedule";
import { tournamentLobbyPath } from "../leagues/lobby";
import ShareFieldsPicker from "./ShareFieldsPicker.vue";
import NafProfileField from "./NafProfileField.vue";
import { API_KEY } from "../app";
import { createSharing, type ShareField } from "../account/sharing";
import { SESSION_KEY, writesAllowed } from "../session";
import { paymentStatusText } from "../shared/payLinks";
import {
  isPageAction, linkProfileNaf, myEntrant, nafProblem, nextFixtureFor, registrationOpen, ROSTER_LABEL, ROSTER_TONE, rosterState, submitChoices,
  TOURNAMENT_DETAIL_KEY, type NafLinkDraft, type ProfileNafView,
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
// The coach's own payment status (only the coach and managers get flags): shown when there is a fee or a payment link.
const payShown = computed(() => Boolean(mine.value?.flags && (t.value.entryFee || t.value.paymentLinks || mine.value.flags.paid)));

const teamId = ref("");
const saveRef = ref("");
watch(choices, (list) => {
  if (list.some((c) => c.ref === saveRef.value)) return;
  const current = mine.value?.submission?.saveId;
  saveRef.value = current && list.some((c) => c.ref === current) ? current : list[0]?.ref ?? "";
}, { immediate: true });

// The coach's phone and profile NAF details, for the registration form (GET /api/me/sharing).
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
const share = ref<ShareField[]>([]);
const notNafMember = ref(false);
const nafDraft = ref<NafLinkDraft>({ nafName: "", nafId: "" });
const sanctioned = computed(() => t.value.nafSanctioned === true);
/** Set by a save from the inline form, so the line shows at once (the sharing view reloads behind it). */
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

// An entry still owing its NAF answer (organiser-made, or the tournament became NAF sanctioned): derived by the server.
const nafPending = computed(() => Boolean(mine.value?.nafPending && sanctioned.value));
onMounted(() => {
  if (coach.value && state.teamOptions.status === "idle") void detail.loadTeamOptions(coach.value);
  if (coach.value && (!mine.value || nafPending.value) && sharing) void sharing.load();
});
watch(nafPending, (owed) => { if (owed && coach.value && sharing && !sharing.state.loaded) void sharing.load(); });

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

const busy = computed(() => Boolean(state.busy) || nafLinking.value);
async function doRegister() {
  nafTouched.value = true;
  if (!teamId.value || nafError.value) return;
  if (!(await ensureProfileNaf())) return;
  const declared = sanctioned.value && notNafMember.value && !profileNaf.value;
  await detail.register(teamId.value, { share: share.value, ...(declared ? { notNafMember: true } : {}) });
}
async function doSubmit() { if (saveRef.value) await detail.submit(saveRef.value); }
async function doAnswerNaf() {
  nafTouched.value = true;
  if (!mine.value || nafError.value) return;
  if (!(await ensureProfileNaf())) return;
  await detail.answerNaf(mine.value.id, notNafMember.value && !profileNaf.value ? { notNafMember: true } : {});
}
async function doWithdraw() { await detail.withdraw(); }
</script>

<template>
  <section v-if="coach" class="hm-panel tn-entry" aria-labelledby="tn-entry-h">
    <header class="hm-band"><h2 id="tn-entry-h">My entry</h2></header>
    <div class="tn-panel-body">
      <template v-if="!entered">
        <template v-if="open">
          <p class="hm-empty">{{ mine?.droppedAt ? "You withdrew from this tournament." : "You are not entered yet." }}</p>
          <form v-if="!mine && canWrite" class="tn-reg-form" novalidate @submit.prevent="doRegister">
            <p v-if="sanctioned" class="tn-reg-chip"><span class="sf-chip" data-tone="info" data-naf="sanctioned">NAF sanctioned</span></p>
            <div class="tn-inline-form sf-field">
              <label for="tn-reg-team" class="sf-k">Team</label>
              <TeamSelect id="tn-reg-team" v-model="teamId" :teams="state.teamOptions.library" />
            </div>
            <NafProfileField
              v-if="sanctioned" v-model:not-naf-member="notNafMember" v-model:draft="nafDraft" id-prefix="tn-reg-naf"
              :profile="profileNaf" :loading="nafLoading" :disabled="busy" :error="nafShown"
            />
            <div class="tn-reg-share">
              <p class="sf-k">Share with the organiser</p>
              <ShareFieldsPicker v-model="share" :phone-on-file="sharing?.state.info?.phoneOnFile === true" legend="What the organisers of this tournament can see" />
              <small class="muted hm-small">Organisers always see your coach name and team. Nothing else unless you tick it; change it later under Account, Sharing.</small>
            </div>
            <div class="tn-actions">
              <button class="sf-btn primary" type="submit" :disabled="!teamId || busy || (nafTouched && Boolean(nafError))">{{ nafLinking ? "Saving NAF details..." : "Register" }}</button>
            </div>
          </form>
          <p v-if="!mine && state.teamOptions.status === 'ok' && !state.teamOptions.library.length" class="hm-empty">
            Your library is empty. Build a team in the Team Builder, then come back to register.
          </p>
        </template>
        <p v-else class="hm-empty">{{ mine?.droppedAt ? "You withdrew from this tournament." : "Registration is closed." }}</p>
      </template>
      <template v-else-if="mine">
        <div class="tn-entry-head">
          <span class="tn-side-text">
            <strong class="tn-entry-team">{{ mine.submission?.teamName || mine.teamName || mine.teamId }}</strong>
            <span class="muted">Seed {{ mine.seed }}{{ mine.race ? ` · ${mine.race}` : "" }}</span>
          </span>
          <span class="sf-chip" :data-tone="ROSTER_TONE[roster]" :data-roster="roster">{{ ROSTER_LABEL[roster] }}</span>
        </div>
        <p v-if="payShown" class="tn-pay-status" :data-paid="mine.flags?.paid ? 'true' : 'false'">{{ paymentStatusText(mine.flags?.paid === true) }}</p>
        <form v-if="nafPending && canWrite" class="tn-reg-naf tn-naf-pending" novalidate @submit.prevent="doAnswerNaf">
          <p class="sf-error">This tournament is NAF sanctioned. Add your NAF name and number to your profile, or say you are not a NAF member, before you submit a roster.</p>
          <NafProfileField
            v-model:not-naf-member="notNafMember" v-model:draft="nafDraft" id-prefix="tn-entry-naf"
            :profile="profileNaf" :loading="nafLoading" :disabled="busy" :error="nafShown"
          />
          <div class="tn-actions"><button class="sf-btn primary" type="submit" :disabled="busy || (nafTouched && Boolean(nafError))">{{ nafLinking ? "Saving NAF details..." : "Save NAF answer" }}</button></div>
        </form>
        <ul v-if="problems.length" class="tn-problems" aria-label="Roster problems">
          <li v-for="(p, i) in problems" :key="i">{{ p }}</li>
        </ul>
        <p v-else-if="roster === 'none'" class="hm-empty">Submit the team you will play so it can be checked against the ruleset.</p>

        <div v-if="next" class="tn-next" :data-side="next.opponentEntrantId ? 'vs' : 'bye'">
          <span class="sf-k">Round {{ next.round }}</span>
          <strong v-if="next.opponentEntrantId">vs {{ next.opponentTeam }} <span class="muted">({{ next.opponentCoach }})</span></strong>
          <strong v-else>Bye</strong>
          <RouterLink
            v-if="next.opponentEntrantId" class="sf-btn small"
            :to="{ name: 'tournament-team', params: { id: t.id, eid: next.opponentEntrantId } }"
          >Opponent's team</RouterLink>
          <RouterLink v-if="next.opponentEntrantId" class="sf-btn small" data-lobby :to="tournamentLobbyPath(t.id, next.fixtureId)">Lobby</RouterLink>
          <RouterLink v-if="next.opponentEntrantId && t.status === 'active'" class="sf-btn small" data-propose :to="proposePath(tournamentFixtureRef(next.fixtureId))">Propose a time</RouterLink>
        </div>

        <form v-if="!closed && canWrite" class="tn-inline-form sf-field" @submit.prevent="doSubmit">
          <label for="tn-submit-team" class="sf-k">Submit team</label>
          <select id="tn-submit-team" v-model="saveRef" :disabled="locked || !choices.length">
            <option v-if="!choices.length" value="">No saved teams yet</option>
            <optgroup v-for="g in groups" :key="g.label" :label="g.label">
              <option v-for="c in g.items" :key="c.ref" :value="c.ref">{{ c.label }}</option>
            </optgroup>
          </select>
          <button class="sf-btn primary" type="submit" :disabled="locked || nafPending || !saveRef || busy">Submit team</button>
        </form>
        <p v-if="locked && !closed" class="hm-empty">Rosters are locked. Ask an organiser to unlock them to change your team.</p>

        <div v-if="!closed && canWrite" class="tn-actions">
          <button class="sf-btn" type="button" :disabled="busy" @click="doWithdraw">Withdraw</button>
        </div>
      </template>
      <p v-if="!canWrite" class="hm-empty tn-readonly">Test sign-in sessions can look but cannot change tournament data.</p>
      <p v-if="state.actionError && !isPageAction(state.lastAction)" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="state.notice && !isPageAction(state.lastAction)" class="tn-notice" role="status">{{ state.notice }}</p>
    </div>
  </section>
</template>
