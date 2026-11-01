<script setup lang="ts">
// Manage → Rounds (tournament managers): every recorded result per round with its source and an Edit result action
// (TournamentResultDialog), plus fixtures whose result an organiser cleared. Byes have an automatic result and are not
// listed. The Edited chip and the activity feed show the change to everyone who sees the fixture (Rounds tab).
import { computed, inject, ref } from "vue";
import TournamentResultDialog from "./TournamentResultDialog.vue";
import { editedTitle, resultSource, resultText, teamLabels, TOURNAMENT_DETAIL_KEY } from "../tournaments/detail";
import type { TournamentFixture } from "../shared/api";
import "../tournaments/resultEdits.css";

defineProps<{ canWrite: boolean }>();
const detail = inject(TOURNAMENT_DETAIL_KEY)!;
const { state } = detail;
const labels = computed(() => teamLabels(state.entrants));
const team = (side: TournamentFixture["home"] | undefined): string => (side ? labels.value.get(side.entrantId)?.team || side.teamId : "Bye");
const listed = (f: TournamentFixture): boolean => Boolean(f.away) && (Boolean(f.result) || (f.edited?.kind === "result" && f.edited.cleared === true));
const rounds = computed(() => {
  const numbers = [...new Set(state.fixtures.filter(listed).map((f) => f.roundNumber))].sort((a, b) => a - b);
  return numbers.map((n) => ({ number: n, fixtures: state.fixtures.filter((f) => f.roundNumber === n && listed(f)) }));
});
const source = (f: TournamentFixture): string => resultSource(f) || "Cleared";
const editing = ref<TournamentFixture | null>(null);
const open = (f: TournamentFixture): void => { editing.value = f; };
</script>

<template>
  <section class="hm-panel" aria-labelledby="tn-re-rounds-h">
    <header class="hm-band" data-tone="admin"><h2 id="tn-re-rounds-h">Rounds</h2><span class="hm-cap">Results</span></header>
    <div class="tn-panel-body">
      <p v-if="!rounds.length" class="hm-empty">No results recorded yet. Results the coaches confirm appear here, ready to edit.</p>
      <div v-for="r in rounds" :key="r.number" class="tn-re-round">
        <h3 class="sf-k tn-re-round-h">Round {{ r.number }}</h3>
        <ul class="tn-re-list">
          <li v-for="f in r.fixtures" :key="f.id" class="tn-re-row" :data-fixture="f.id">
            <span class="tn-re-teams"><strong>{{ team(f.home) }}</strong> <span class="muted">v</span> <strong>{{ team(f.away) }}</strong></span>
            <span class="tn-re-score">{{ f.result ? resultText(f.result) : "Unplayed" }}</span>
            <span class="tn-re-meta">
              <span class="sf-chip" data-tone="muted">{{ source(f) }}</span>
              <span v-if="f.edited?.kind === 'result'" class="sf-chip tn-edited" data-tone="admin" tabindex="0" :title="editedTitle(f.edited)" :aria-label="editedTitle(f.edited)">Edited</span>
            </span>
            <button
              v-if="canWrite && f.result" type="button" class="sf-btn small tn-re-edit" :disabled="Boolean(state.busy)"
              :aria-label="`Edit result: ${team(f.home)} v ${team(f.away)}, round ${f.roundNumber}`" @click="open(f)"
            >Edit result</button>
          </li>
        </ul>
      </div>
      <p v-if="state.notice && state.lastAction.startsWith('result:') && !editing" class="tn-notice" role="status">{{ state.notice }}</p>
    </div>
    <TournamentResultDialog v-if="editing" :fixture="editing" @close="editing = null" />
  </section>
</template>
