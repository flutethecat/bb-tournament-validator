<script setup lang="ts">
// Manage tab (owner, organisers, admins): Summary pane with the event's actions (Start Tournament until it has
// started, then Edit Tournament; Generate round; Lock / Unlock rosters; Finish), the Start Tournament sub-modal,
// the Edit Tournament pane (settings + roles) and the Participants table.
import { computed, inject, nextTick, ref } from "vue";
import TournamentParticipants from "./TournamentParticipants.vue";
import TournamentSettingsForm from "./TournamentSettingsForm.vue";
import TournamentStartModal from "./TournamentStartModal.vue";
import {
  canGenerateRound, PAIRING_LABEL, roundProgress, SEEDING_LABEL, startDate, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";
import { FORMAT_LABEL, STATUS_LABEL } from "../tournaments/list";

const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const busy = computed(() => Boolean(state.busy));
const started = computed(() => Boolean(t.value.startedAt) || t.value.status !== "draft");
const field = computed(() => state.entrants.filter((e) => !e.droppedAt).length);
const generate = computed(() => canGenerateRound(t.value, state.rounds));
const open = ref(false);
const editPane = ref<HTMLElement | null>(null);
const ruleset = computed(() => t.value.rulesetPackName || t.value.packageName || "Not set");
const entrants = computed(() => (t.value.maxPlayers > 0 ? `${field.value} of ${t.value.maxPlayers}` : String(field.value)));

async function editTournament() {
  await nextTick();
  editPane.value?.scrollIntoView({ behavior: "smooth", block: "start" });
  editPane.value?.querySelector<HTMLElement>("input, select")?.focus();
}
</script>

<template>
  <div class="tn-manage">
    <section class="tn-panel" aria-labelledby="tn-summary-h">
      <h3 id="tn-summary-h" class="tn-band">Summary</h3>
      <div class="tn-panel-body">
        <div class="tn-facts">
          <div class="tn-fact"><span class="tn-fact-k">Status</span><strong><span class="tn-chip" :data-status="t.status">{{ STATUS_LABEL[t.status] ?? t.status }}</span></strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Format</span><strong>{{ FORMAT_LABEL[t.format] ?? t.format }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Dates</span><strong>{{ startDate(t.startsAt) || "Not set" }}{{ t.endsAt ? ` to ${startDate(t.endsAt)}` : "" }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Ruleset</span><strong>{{ ruleset }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Round</span><strong>{{ roundProgress(t) }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Entrants</span><strong>{{ entrants }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Owner</span><strong>{{ t.ownerCoachId || "None" }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Organisers</span><strong>{{ t.organizerCoachIds?.length ? t.organizerCoachIds.join(", ") : "None" }}</strong></div>
          <div v-if="t.format === 'swiss'" class="tn-fact"><span class="tn-fact-k">Pairing</span><strong>{{ PAIRING_LABEL[t.pairingSystem ?? "eloSeeded"] }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Seeding</span><strong>{{ SEEDING_LABEL[t.seedingMode ?? "elo"] }}</strong></div>
          <div class="tn-fact"><span class="tn-fact-k">Rosters</span><strong>{{ t.rostersLockedAt ? `Locked ${startDate(t.rostersLockedAt)}` : "Open" }}</strong></div>
        </div>
        <div class="tn-actions tn-sticky-actions">
          <button v-if="!started" class="lobby-btn primary" type="button" :disabled="busy" @click="open = true">Start Tournament</button>
          <button v-else class="lobby-btn" type="button" @click="editTournament">Edit Tournament</button>
          <button v-if="generate" class="lobby-btn primary" type="button" :disabled="busy" @click="open = true">Generate round {{ state.rounds.length + 1 }}</button>
          <template v-if="!state.rounds.length && t.status !== 'completed' && t.status !== 'cancelled'">
            <button v-if="!t.rostersLockedAt" class="lobby-btn" type="button" :disabled="busy" @click="detail.lockRosters()">Lock rosters</button>
            <button v-else class="lobby-btn" type="button" :disabled="busy" @click="detail.unlockRosters()">Unlock rosters</button>
          </template>
          <button v-if="t.status === 'active'" class="lobby-btn" type="button" :disabled="busy" @click="detail.finish()">Finish tournament</button>
        </div>
        <p v-if="state.actionError && !open" class="lobby-error" role="alert">{{ state.actionError }}</p>
        <p v-else-if="state.notice && !open" class="tn-notice" role="status">{{ state.notice }}</p>
      </div>
    </section>

    <TournamentStartModal v-if="open" @close="open = false" />

    <section ref="editPane" class="tn-panel" aria-labelledby="tn-edit-h">
      <h3 id="tn-edit-h" class="tn-band">{{ started ? "Edit Tournament" : "Settings" }}</h3>
      <div class="tn-panel-body"><TournamentSettingsForm /></div>
    </section>

    <section class="tn-panel" aria-labelledby="tn-part-h">
      <h3 id="tn-part-h" class="tn-band">Participants</h3>
      <div class="tn-panel-body"><TournamentParticipants /></div>
    </section>
  </div>
</template>
