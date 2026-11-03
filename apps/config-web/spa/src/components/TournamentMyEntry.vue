<script setup lang="ts">
// Overview "My entry" card (signed-in coaches only). Registration (lane L4) runs in the register sheet
// (TournamentRegisterDialog: team or "roster later", region, share picker, NAF, the DM notice line, confirm). The card
// shows where the entry stands: not entered (places left, approval, Register), pending ("waiting for the organisers"),
// on the waitlist (#n), accepted (team, roster chip, problems, next fixture), declined or removed (the organisers'
// reason), withdrawn (Register again while it is open). A live entry may submit or change its team until the roster
// deadline ("Roster due by ..." when it has none) and withdraw. An entry still owing its NAF answer (organiser-made, or
// the tournament became NAF sanctioned) answers it here (NafProfileField). The server stays the authority throughout.
import { computed, inject, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { proposePath, tournamentFixtureRef } from "../schedule/schedule";
import { tournamentLobbyPath } from "../leagues/lobby";
import NafProfileField from "./NafProfileField.vue";
import TournamentRegisterDialog from "./TournamentRegisterDialog.vue";
import { API_KEY } from "../app";
import { createSharing } from "../account/sharing";
import { SESSION_KEY, writesAllowed } from "../session";
import { paymentStatusText } from "../shared/payLinks";
import {
  isPageAction, linkProfileNaf, myEntrant, nafProblem, nextFixtureFor, registrationOpen, ROSTER_LABEL, ROSTER_TONE, rosterState, submitChoices,
  TOURNAMENT_DETAIL_KEY, type NafLinkDraft, type ProfileNafView,
} from "../tournaments/detail";
import { approvalWords, isLive, placesLine, rosterDueLine, STATE_TONE, stateChip, utcLabel } from "../tournaments/registration";
import "../tournaments/registration.css";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const session = inject(SESSION_KEY)!;
const { state } = detail;
const coach = computed(() => session.coach());
const t = computed(() => state.tournament!);
// A test sign-in session may change a test tournament (registration spec Q13).
const canWrite = computed(() => writesAllowed(session) || t.value.test === true);
const mine = computed(() => myEntrant(state));
const reg = computed(() => state.myRegistration);
const entered = computed(() => Boolean(mine.value && !mine.value.droppedAt));
/** Pending or waitlisted: not in the field yet, but live (team, roster, withdraw). */
const held = computed(() => !entered.value && Boolean(reg.value && (reg.value.state === "pending" || reg.value.state === "waitlisted")));
/** The live entry the card works on: the field row, else the held one. */
const current = computed(() => (entered.value ? mine.value : held.value ? reg.value : undefined));
const status = computed(() => state.registrationStatus);
// The server's registration facts (lane L4); an older response without them falls back to the status / round / lock rule.
const open = computed(() => (status.value ? status.value.open : registrationOpen(t.value, state.rounds)));
const closed = computed(() => t.value.status === "completed" || t.value.status === "cancelled");
// Re-entry (spec §7): a coach who withdrew may register again while it is open; declined / removed entries cannot.
const mayRegister = computed(() => open.value && !closed.value && (!reg.value || reg.value.state === "withdrawn"));
const locked = computed(() => Boolean(t.value.rostersLockedAt || current.value?.flags?.frozen));
const roster = computed(() => (current.value ? rosterState(current.value) : "none"));
const problems = computed(() => current.value?.submission?.problems ?? []);
const due = computed(() => (current.value ? rosterDueLine(t.value, current.value) : ""));
const deadlinePassed = computed(() => Boolean(t.value.registration?.rosterLater && t.value.registration.rosterBy && Date.parse(t.value.registration.rosterBy) <= Date.now()));
const choices = computed(() => submitChoices(state.teamOptions));
const groups = computed(() => (["Team Builder saves", "Library teams"] as const)
  .map((label) => ({ label, items: choices.value.filter((c) => c.group === label) }))
  .filter((g) => g.items.length));
const next = computed(() => (mine.value && entered.value ? nextFixtureFor(mine.value.id, state) : null));
// The coach's own payment status (only the coach and managers get flags): shown when there is a fee or a payment link.
const payShown = computed(() => Boolean(entered.value && mine.value?.flags && (t.value.entryFee || t.value.paymentLinks || mine.value.flags.paid)));
const registering = ref(false);

const saveRef = ref("");
watch(choices, (list) => {
  if (list.some((c) => c.ref === saveRef.value)) return;
  const currentRef = current.value?.submission?.saveId;
  saveRef.value = currentRef && list.some((c) => c.ref === currentRef) ? currentRef : list[0]?.ref ?? "";
}, { immediate: true });

// The NAF answer form of an entry that owes it (GET /api/me/sharing for the profile's NAF details).
const fetcher = inject(API_KEY, null);
const sharing = fetcher ? createSharing({ api: fetcher }) : null;
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
const nafPending = computed(() => Boolean(mine.value?.nafPending && sanctioned.value && entered.value));
onMounted(() => {
  if (coach.value && state.teamOptions.status === "idle") void detail.loadTeamOptions(coach.value);
});
watch(nafPending, (owed) => { if (owed && coach.value && sharing && !sharing.state.loaded) void sharing.load(); }, { immediate: true });

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
async function doSubmit() { if (saveRef.value) await detail.submit(saveRef.value); }
async function doAnswerNaf() {
  nafTouched.value = true;
  if (!mine.value || nafError.value) return;
  if (!(await ensureProfileNaf())) return;
  await detail.answerNaf(mine.value.id, notNafMember.value && !profileNaf.value ? { notNafMember: true } : {});
}
async function doWithdraw() { if (current.value) await detail.withdrawEntry(current.value.id); }
const HELD_TEXT = {
  pending: "Your entry is waiting for the organisers. You'll hear when they decide.",
  waitlisted: "It's full, so you're on the waitlist. You'll hear if a place opens.",
} as const;
</script>

<template>
  <section v-if="coach" class="hm-panel tn-entry" aria-labelledby="tn-entry-h">
    <header class="hm-band">
      <h2 id="tn-entry-h">My entry</h2>
      <span v-if="reg" class="sf-chip hm-cap" :data-tone="STATE_TONE[reg.state]" :data-entry-state="reg.state">{{ stateChip(reg) }}</span>
    </header>
    <div class="tn-panel-body">
      <template v-if="!current">
        <p v-if="reg?.state === 'declined'" class="hm-empty" data-entry-note="declined">The organisers declined your entry{{ reg.reason ? `: ${reg.reason}` : "." }}</p>
        <p v-else-if="reg?.state === 'dropped'" class="hm-empty" data-entry-note="removed">The organisers removed your entry{{ reg.reason ? `: ${reg.reason}` : "." }}</p>
        <p v-else-if="reg?.state === 'withdrawn'" class="hm-empty">You withdrew from this tournament.</p>
        <p v-else-if="open" class="hm-empty">You are not entered yet.</p>
        <template v-if="mayRegister">
          <dl class="tr-facts">
            <dt>Places</dt><dd>{{ placesLine(status) }}</dd>
            <dt>Approval</dt><dd>{{ approvalWords(status) }}</dd>
            <dt v-if="status?.closesAt">Closes</dt><dd v-if="status?.closesAt">{{ utcLabel(status.closesAt) }}</dd>
          </dl>
          <div v-if="canWrite" class="tn-actions">
            <button class="sf-btn primary" type="button" data-register :disabled="busy" @click="registering = true">{{ reg?.state === "withdrawn" ? "Register again" : "Register" }}</button>
          </div>
        </template>
        <p v-else-if="!open && !reg" class="hm-empty">{{ status?.message || "Registration is closed." }}</p>
      </template>
      <template v-else>
        <p v-if="held && reg" class="tr-state" :data-held="reg.state">{{ HELD_TEXT[reg.state as "pending" | "waitlisted"] }}</p>
        <div class="tn-entry-head">
          <span class="tn-side-text">
            <strong class="tn-entry-team">{{ current.submission?.teamName || current.teamName || (current.teamId ? current.teamId : "Roster to come") }}</strong>
            <span class="muted">{{ entered ? `Seed ${current.seed}` : "Not in the field yet" }}{{ current.race ? ` · ${current.race}` : "" }}{{ current.region ? ` · ${current.region}` : "" }}</span>
          </span>
          <span class="sf-chip" :data-tone="ROSTER_TONE[roster]" :data-roster="roster">{{ ROSTER_LABEL[roster] }}</span>
          <span v-if="entered && current.flags?.checkedIn" class="sf-chip" data-tone="ok" data-checked-in="true">Checked in</span>
        </div>
        <p v-if="due" class="tr-due" data-roster-due="true">{{ due }}</p>
        <p v-if="payShown" class="tn-pay-status" :data-paid="mine?.flags?.paid ? 'true' : 'false'">{{ paymentStatusText(mine?.flags?.paid === true) }}</p>
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
        <p v-else-if="roster === 'none' && !due" class="hm-empty">Submit the team you will play so it can be checked against the ruleset.</p>

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

        <form v-if="!closed && canWrite && !deadlinePassed" class="tn-inline-form sf-field" @submit.prevent="doSubmit">
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
      <p v-if="state.actionError && !isPageAction(state.lastAction) && !registering" class="sf-error" role="alert">{{ state.actionError }}</p>
      <p v-else-if="state.notice && !isPageAction(state.lastAction)" class="tn-notice" role="status">{{ state.notice }}</p>
    </div>
    <Teleport to="body"><TournamentRegisterDialog v-if="registering" @close="registering = false" /></Teleport>
  </section>
</template>
