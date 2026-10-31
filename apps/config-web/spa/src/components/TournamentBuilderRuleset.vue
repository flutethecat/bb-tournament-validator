<script setup lang="ts">
// Tournament Builder, Ruleset tab: the tournament ruleset cards, the chosen ruleset's generated highlights (package values
// only; the organiser's free text sits under "Organiser notes"), and the per-team tier table whose team cells pick the race
// (the shared core's overview / legacy tier table markup, every value escaped by the core).
import { computed, inject, nextTick, ref, watch } from "vue";
import { currentMotion, FADE_MS, POP_DELAY_MS, POP_MS, QUICK_MS, SLIDE_MS, type RulesetMotion } from "../teams/rulesetMotion";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const emit = defineEmits<{ package: [name: string]; race: [rosterId: string]; next: [] }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const summaryHtml = computed(() => core.overviewSummaryHtml(state.packageRules?.overview ?? null));
const description = computed(() => state.packageDoc?.description || state.packages.find((p) => p.name === state.packageName)?.description || "");
const note = computed(() => state.packageRules?.dataNote || state.packageDoc?.dataNote || "");
const table = computed(() => (state.packageName ? builder.raceTable() : { html: "", legacy: false, selectable: false }));

// First ruleset pick only (a click from the empty state): the Rulesets panel slides from the left column to the right (FLIP: its
// rect is measured before and after the layout flips, then a transform from the old spot to none is played) while Pick a race
// pops in on the left. Deep links, restored saves and later picks never set `pending`, so they render straight into place.
const rulesetsEl = ref<HTMLElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
const raceEl = ref<HTMLElement | null>(null);
const animating = ref(false);
const announce = ref("");
let pending: { motion: RulesetMotion; first: DOMRect | null } | null = null;

function onPick(name: string): void {
  if (!state.packageName) {
    const motion = currentMotion();
    pending = { motion, first: motion === "slide" ? rulesetsEl.value?.getBoundingClientRect() ?? null : null };
  }
  emit("package", name);
}

function play(el: HTMLElement | null, frames: Keyframe[], duration: number, delay = 0, easing = "cubic-bezier(.2, .8, .2, 1)"): Promise<unknown> {
  if (!el || typeof el.animate !== "function") return Promise.resolve();
  return el.animate(frames, { duration, delay, easing, fill: "backwards" }).finished.catch(() => undefined);
}

watch(() => state.packageName, async (now) => {
  const run = pending;
  pending = null;
  if (!now || !run) return;
  announce.value = "Step 2: pick a race";
  await nextTick();
  const race = raceEl.value;
  if (run.motion === "quick") { void play(race, [{ opacity: 0 }, { opacity: 1 }], QUICK_MS, 0, "linear"); return; }
  if (run.motion === "fade") {
    void play(race, [{ opacity: 0 }, { opacity: 1 }], FADE_MS, 0, "ease-out");
    race?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    return;
  }
  const last = rulesetsEl.value?.getBoundingClientRect();
  if (!run.first || !last) return;
  const from = `translate(${run.first.left - last.left}px, ${run.first.top - last.top}px)`;
  animating.value = true;
  await Promise.all([
    play(rulesetsEl.value, [{ transform: from }, { transform: "none" }], SLIDE_MS),
    play(summaryEl.value, [{ transform: from, opacity: 0 }, { transform: "none", opacity: 1 }], SLIDE_MS),
    play(race, [{ opacity: 0, transform: "translateY(14px) scale(.97)" }, { opacity: 1, transform: "none" }], POP_MS, POP_DELAY_MS, "ease-out"),
  ]);
  animating.value = false;
}, { flush: "post" });

function onTableClick(e: MouseEvent): void {
  const button = (e.target as HTMLElement | null)?.closest?.("[data-tt-race]") as HTMLElement | null;
  const id = button?.dataset.ttRace;
  if (id) emit("race", id);
}
</script>

<template>
  <!-- With no ruleset only step 1 shows, in the left column. DOM order is the reading / focus order: rulesets (step 1), the rules summary, then Pick a race (step 2). From 1180 px the
       grid areas seat the race picker as the tall left column and the other two stacked on the right (builder.css .tb-rsflow). -->
  <div class="tb-rsflow" :class="[state.packageName ? 'tb-rs-sel' : 'tb-rs-none', { 'tb-rs-anim': animating }]">
  <p class="visually-hidden" role="status" aria-live="polite">{{ announce }}</p>
  <section ref="rulesetsEl" class="hm-panel tb-panel tb-area-rulesets" aria-labelledby="tb-rulesets-h">
    <header class="hm-band"><h2 id="tb-rulesets-h">Tournament rulesets</h2><span class="hm-cap">Step 1</span></header>
    <div v-if="state.packages.length" class="tb-cards" role="list">
      <button
        v-for="p in state.packages" :key="p.name" type="button" role="listitem" class="tb-card"
        :aria-pressed="p.name === state.packageName ? 'true' : 'false'" @click="onPick(p.name)"
      ><strong>{{ p.name }}</strong></button>
    </div>
    <p v-else class="hm-empty">No tournament packages are saved yet.</p>
  </section>

  <section v-if="state.packageName" ref="summaryEl" class="hm-panel tb-panel tb-area-summary" aria-labelledby="tb-package-h">
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

  <section v-if="state.packageName" ref="raceEl" class="hm-panel tb-panel tb-area-race" aria-labelledby="tb-race-h">
    <header class="hm-band"><h2 id="tb-race-h">Pick a race</h2><span class="hm-cap">Step 2</span></header>
    <template v-if="state.packageName">
    <p class="muted tb-hint">Each team name picks that race.</p>
    <div v-if="table.html" :key="state.packageName" class="tb-scroll tb-race-scroll tb-race-swap" tabindex="0" role="region" aria-label="Races by tier" @click="onTableClick">
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
