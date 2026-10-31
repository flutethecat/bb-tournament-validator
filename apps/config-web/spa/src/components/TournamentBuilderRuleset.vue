<script setup lang="ts">
// Tournament Builder, Ruleset tab: the tournament ruleset cards, the chosen ruleset's generated highlights (package values
// only; the organiser's free text sits under "Organiser notes"), and the per-team tier table whose team cells pick the race
// (the shared core's overview / legacy tier table markup, every value escaped by the core).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const emit = defineEmits<{ package: [name: string]; race: [rosterId: string]; next: [] }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const summaryHtml = computed(() => core.overviewSummaryHtml(state.packageRules?.overview ?? null));
const description = computed(() => state.packageDoc?.description || state.packages.find((p) => p.name === state.packageName)?.description || "");
const note = computed(() => state.packageRules?.dataNote || state.packageDoc?.dataNote || "");
const table = computed(() => (state.packageName ? builder.raceTable() : { html: "", legacy: false, selectable: false }));

function onTableClick(e: MouseEvent): void {
  const button = (e.target as HTMLElement | null)?.closest?.("[data-tt-race]") as HTMLElement | null;
  const id = button?.dataset.ttRace;
  if (id) emit("race", id);
}
</script>

<template>
  <!-- DOM order is the reading / focus order: rulesets (step 1), the rules summary, then Pick a race (step 2). From 1180 px the
       grid areas seat the race picker as the tall left column and the other two stacked on the right (builder.css .tb-rsflow). -->
  <div class="tb-rsflow">
  <section class="hm-panel tb-panel tb-area-rulesets" aria-labelledby="tb-rulesets-h">
    <header class="hm-band"><h2 id="tb-rulesets-h">Tournament rulesets</h2><span class="hm-cap">Step 1</span></header>
    <div v-if="state.packages.length" class="tb-cards" role="list">
      <button
        v-for="p in state.packages" :key="p.name" type="button" role="listitem" class="tb-card"
        :aria-pressed="p.name === state.packageName ? 'true' : 'false'" @click="emit('package', p.name)"
      ><strong>{{ p.name }}</strong></button>
    </div>
    <p v-else class="hm-empty">No tournament packages are saved yet.</p>
  </section>

  <section v-if="state.packageName" class="hm-panel tb-panel tb-area-summary" aria-labelledby="tb-package-h">
    <header class="hm-band"><h2 id="tb-package-h">{{ state.packageName }}</h2><span class="hm-cap">Ruleset</span></header>
    <dl v-if="summaryHtml" class="tt-summary tb-summary" v-html="summaryHtml"></dl>
    <details v-if="description" class="tb-notes">
      <summary>Organiser notes</summary>
      <p class="tb-notes-text">{{ description }}</p>
    </details>
    <details v-if="note" class="tb-notes">
      <summary>Rules note</summary>
      <p class="muted tb-notes-text">{{ note }}</p>
    </details>
  </section>

  <section class="hm-panel tb-panel tb-area-race" aria-labelledby="tb-race-h">
    <header class="hm-band"><h2 id="tb-race-h">Pick a race</h2><span class="hm-cap">Step 2</span></header>
    <p v-if="!state.packageName" class="hm-empty">Pick a tournament ruleset first.</p>
    <template v-else>
    <p class="muted tb-hint">Each team name picks that race.</p>
    <div v-if="table.html" class="tb-scroll tb-race-scroll" tabindex="0" role="region" aria-label="Races by tier" @click="onTableClick">
      <table :class="table.legacy ? 'tier-table' : 'tt-rules-table'" v-html="table.html"></table>
    </div>
    <p v-if="!table.selectable" class="hm-empty">No installed roster is eligible for this ruleset.</p>
    <div v-if="state.roster" class="tb-actions">
      <button type="button" class="tb-btn primary" @click="emit('next')">Build the {{ state.roster.raceName }} team</button>
    </div>
    </template>
  </section>
  </div>
</template>
