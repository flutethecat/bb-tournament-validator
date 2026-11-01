<script setup lang="ts">
// Start Tournament sub-modal (owner ruling 10-28): step 1 starts the tournament in one click (the server locks every
// roster, validates it against the ruleset and opens the event; a refusal lists the invalid rosters, which an
// organiser can verify by hand or start anyway). Step 2 is Generate fixtures: pairing system + seeding, a preview of
// the round, then Generate. Opened again later it goes straight to Generate fixtures for the next round.
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import type { TournamentPairingSystem, TournamentSeedingMode } from "../shared/api";
import {
  PAIRING_LABEL, ROSTER_LABEL, ROSTER_TONE, rosterState, SEEDING_LABEL, teamLabels, TOURNAMENT_DETAIL_KEY,
} from "../tournaments/detail";

const emit = defineEmits<{ close: [] }>();
const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const t = computed(() => state.tournament!);
const step = computed<"start" | "generate">(() => (t.value.status === "draft" ? "start" : "generate"));
const field = computed(() => state.entrants.filter((e) => !e.droppedAt));
const invalidCount = computed(() => field.value.filter((e) => rosterState(e) !== "valid").length);
const busy = computed(() => Boolean(state.busy));
const nextRound = computed(() => state.rounds.length + 1);

const system = ref<TournamentPairingSystem>(t.value.pairingSystem ?? "dutch");
const seeding = ref<TournamentSeedingMode>(t.value.seedingMode ?? "elo");
watch(() => t.value.id, () => {
  system.value = t.value.pairingSystem ?? "dutch";
  seeding.value = t.value.seedingMode ?? "elo";
});
watch([system, seeding], () => { state.preview = null; });

const labels = computed(() => teamLabels(state.entrants));
const previewRows = computed(() => (state.preview?.pairings ?? []).map((p, i) => ({
  key: `${i}`,
  home: labels.value.get(p.homeEntrantId)?.team ?? p.homeEntrantId,
  homeCoach: labels.value.get(p.homeEntrantId)?.coach ?? "",
  away: p.awayEntrantId ? labels.value.get(p.awayEntrantId)?.team ?? p.awayEntrantId : null,
  awayCoach: p.awayEntrantId ? labels.value.get(p.awayEntrantId)?.coach ?? "" : "",
})));

const swiss = computed(() => t.value.format === "swiss");
const firstRound = computed(() => nextRound.value === 1);
const choice = () => ({ pairingSystem: swiss.value ? system.value : undefined, seedingMode: firstRound.value ? seeding.value : undefined });

const verify = (entrantId: string) => detail.patchEntrant(entrantId, { flags: { rosterVerified: true } });
const doStart = (force = false) => detail.start(force);
const doPreview = () => detail.previewRound(choice().pairingSystem, choice().seedingMode);
async function doGenerate() {
  if (await detail.generateRound(choice().pairingSystem, choice().seedingMode)) emit("close");
}

const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") emit("close"); };
onMounted(() => { state.preview = null; state.startOutcome = ""; window.addEventListener("keydown", onKey); });
onUnmounted(() => window.removeEventListener("keydown", onKey));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="emit('close')">
    <div class="tn-modal hm-panel" role="dialog" aria-modal="true" aria-labelledby="tn-modal-h">
      <header class="hm-band tn-modal-band">
        <h2 id="tn-modal-h">{{ step === "start" ? "Start Tournament" : `Generate fixtures · Round ${nextRound}` }}</h2>
        <button type="button" class="tn-modal-x" aria-label="Close" @click="emit('close')">×</button>
      </header>
      <div class="tn-panel-body">
        <template v-if="step === 'start'">
          <ol class="tn-steps" aria-label="Steps">
            <li class="on">Lock rosters and check them</li>
            <li>Generate fixtures</li>
          </ol>
          <p class="muted">
            Starting locks every roster, checks it against the ruleset and opens the tournament. Fixtures come next.
            {{ t.rostersLockedAt ? "Rosters are already locked: the table shows their checks." : "The table shows each entry's last check." }}
          </p>
          <div class="tn-table-wrap">
            <table class="sf-table tn-table tn-validation">
              <thead><tr><th>Team</th><th>Roster</th><th>Problems</th><th></th></tr></thead>
              <tbody>
                <tr v-for="e in field" :key="e.id">
                  <td data-label="Team" class="tn-team">
                    <span class="tn-side-text"><strong>{{ e.submission?.teamName || e.teamName || e.teamId }}</strong><span class="muted">{{ e.coachId }}</span></span>
                  </td>
                  <td data-label="Roster"><span class="sf-chip" :data-tone="ROSTER_TONE[rosterState(e)]" :data-roster="rosterState(e)">{{ ROSTER_LABEL[rosterState(e)] }}</span><span v-if="e.rosterVerifiedOverride" class="muted"> (by hand)</span></td>
                  <td data-label="Problems">
                    <ul v-if="e.submission?.problems?.length" class="tn-problems"><li v-for="(p, i) in e.submission.problems" :key="i">{{ p }}</li></ul>
                    <span v-else class="muted">None</span>
                  </td>
                  <td data-label="">
                    <button v-if="t.rostersLockedAt && rosterState(e) !== 'valid'" class="sf-btn small" type="button" :disabled="busy" @click="verify(e.id)">Verify by hand</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="state.startOutcome === 'refused' && state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
          <p v-else-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
          <div class="tn-actions">
            <button class="sf-btn primary" type="button" :disabled="busy || field.length < 2" @click="doStart(false)">Start tournament</button>
            <button v-if="state.startOutcome === 'refused' && invalidCount" class="sf-btn" type="button" :disabled="busy" @click="doStart(true)">
              Start anyway ({{ invalidCount }} invalid)
            </button>
            <button class="sf-btn" type="button" @click="emit('close')">Cancel</button>
          </div>
          <p v-if="field.length < 2" class="muted">A tournament needs at least two entrants to start.</p>
        </template>

        <template v-else>
          <ol class="tn-steps" aria-label="Steps">
            <li class="done">Lock rosters and check them</li>
            <li class="on">Generate fixtures</li>
          </ol>
          <p v-if="state.startOutcome === 'started'" class="tn-notice" role="status">Tournament started. Now draw round {{ nextRound }}.</p>
          <div class="tn-form-grid">
            <label v-if="swiss" class="tn-field sf-field">
              <span class="tn-fact-k">Pairing system</span>
              <select v-model="system">
                <option v-for="(label, key) in PAIRING_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
            <label v-if="firstRound" class="tn-field sf-field">
              <span class="tn-fact-k">Seeding</span>
              <select v-model="seeding">
                <option v-for="(label, key) in SEEDING_LABEL" :key="key" :value="key">{{ label }}</option>
              </select>
            </label>
          </div>
          <p v-if="firstRound && seeding === 'manual'" class="muted">Seeds come from the Participants table; unseeded entries follow by rating.</p>
          <div class="tn-actions">
            <button class="sf-btn" type="button" :disabled="busy" @click="doPreview">Preview round {{ nextRound }}</button>
          </div>
          <ul v-if="state.preview" class="tn-fixtures tn-preview" aria-label="Preview">
            <li v-for="row in previewRows" :key="row.key" class="tn-fixture">
              <div class="tn-side tn-home"><span class="tn-side-text"><strong>{{ row.home }}</strong><span class="muted">{{ row.homeCoach }}</span></span></div>
              <div class="tn-score"><span class="muted">{{ row.away ? "vs" : "Bye" }}</span></div>
              <div class="tn-side tn-away"><span v-if="row.away" class="tn-side-text"><strong>{{ row.away }}</strong><span class="muted">{{ row.awayCoach }}</span></span></div>
            </li>
          </ul>
          <p v-if="state.actionError" class="sf-error" role="alert">{{ state.actionError }}</p>
          <div class="tn-actions">
            <button class="sf-btn primary" type="button" :disabled="busy" @click="doGenerate">Generate round {{ nextRound }}</button>
            <button class="sf-btn" type="button" @click="emit('close')">Close</button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
