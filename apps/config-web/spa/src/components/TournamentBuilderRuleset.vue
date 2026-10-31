<script setup lang="ts">
// Tournament Builder, Ruleset tab: the tournament ruleset cards, the chosen ruleset's generated highlights (package values
// only; the organiser's free text sits under "Organiser notes"), and the per-team tier table whose team cells pick the race
// (the shared core's overview / legacy tier table markup, every value escaped by the core). Free Create (owner 10-31) is the
// first card: it has no rules summary (its one-line description instead) and its race step is a plain grid of every base
// roster.
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { currentMotion, FADE_MS, POP_DELAY_MS, POP_MS, QUICK_MS, SLIDE_MS, SWAP_MS, type RulesetMotion } from "../teams/rulesetMotion";
import { TOURNAMENT_BUILDER_KEY } from "../teams/builder";
import { core } from "../teams/builderCore";

const emit = defineEmits<{ package: [name: string]; race: [rosterId: string]; next: [] }>();
const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const { state } = builder;

const free = computed(() => builder.free());
const cards = computed(() => builder.rulesetCards());
const freeRaces = computed(() => (free.value ? builder.freeRaces() : []));
const summaryHtml = computed(() => core.overviewSummaryHtml(state.packageRules?.overview ?? null));
const description = computed(() => (free.value ? "" : state.packageDoc?.description || state.packages.find((p) => p.name === state.packageName)?.description || ""));
const note = computed(() => state.packageRules?.dataNote || state.packageDoc?.dataNote || "");
const table = computed(() => (state.packageName && !free.value ? builder.raceTable() : { html: "", legacy: false, selectable: false }));

// First ruleset pick only (a click from the empty state): the Rulesets panel slides from the left column to the right (FLIP: its
// rect is measured before and after the layout flips, then a transform from the old spot to none is played) while Pick a race
// pops in on the left. Deep links, restored saves and later picks never set `pending`, so they render straight into place.
const rulesetsEl = ref<HTMLElement | null>(null);
const summaryEl = ref<HTMLElement | null>(null);
const raceEl = ref<HTMLElement | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const animating = ref(false);
const loading = ref(false); // a re-pick is waiting for the new ruleset's data: the old table stays, dimmed
const announce = ref("");
let pending: { motion: RulesetMotion; first: DOMRect | null } | null = null;
let repickTo = "";
let awaitingData = false;
let disposed = false;
const running = new Set<Animation>();

function onPick(name: string): void {
  if (!state.packageName) {
    const motion = currentMotion();
    pending = { motion, first: motion === "slide" ? rulesetsEl.value?.getBoundingClientRect() ?? null : null };
  } else if (name !== state.packageName) repickTo = name;
  emit("package", name);
}

function play(el: HTMLElement | null, frames: Keyframe[], duration: number, delay = 0, easing = "cubic-bezier(.2, .8, .2, 1)"): Promise<unknown> {
  if (!el || typeof el.animate !== "function") return Promise.resolve();
  const a = el.animate(frames, { duration, delay, easing, fill: "backwards" });
  running.add(a);
  return a.finished.catch(() => undefined).finally(() => running.delete(a));
}

// Leaving the tab (or the page) mid-motion stops every animation at once and drops the overflow clip.
onBeforeUnmount(() => {
  disposed = true;
  for (const a of [...running]) a.cancel();
  running.clear();
  animating.value = false;
  loading.value = false;
});

watch(() => state.packageName, async (now, was) => {
  const run = pending;
  pending = null;
  const repick = repickTo === now && Boolean(was) && Boolean(now);
  repickTo = "";
  if (repick) { awaitingData = true; loading.value = true; return; }
  if (!now || !run) return;
  announce.value = "Step 2: pick a race";
  await nextTick();
  if (disposed) return;
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
  if (!disposed) animating.value = false;
}, { flush: "post" });

// The re-pick crossfade plays when the new ruleset's data lands (packageRules and tierRows are replaced by the response, never by
// the request), so the table never fades while it still shows the old ruleset. Only a re-pick arms it: never on mount or tab return.
watch(() => [state.packageRules, state.tierRows], async () => {
  if (!awaitingData) return;
  awaitingData = false;
  loading.value = false;
  await nextTick();
  if (disposed) return;
  void play(scrollEl.value, [{ opacity: 0 }, { opacity: 1 }], currentMotion() === "quick" ? QUICK_MS : SWAP_MS, 0, "ease-out");
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
    <header class="hm-band"><h2 id="tb-rulesets-h">Rulesets</h2><span class="hm-cap">Step 1</span></header>
    <div class="tb-cards" role="list">
      <button
        v-for="c in cards" :key="c.name" type="button" role="listitem" class="tb-card" :class="{ 'tb-card-free': c.free }" :data-ruleset="c.name"
        :aria-pressed="c.name === state.packageName ? 'true' : 'false'" @click="onPick(c.name)"
      ><strong>{{ c.label }}</strong><small v-if="c.free" class="tb-card-desc">{{ c.description }}</small></button>
    </div>
    <p v-if="cards.length === 1" class="hm-empty">No tournament packages are saved yet.</p>
  </section>

  <section v-if="state.packageName" ref="summaryEl" class="hm-panel tb-panel tb-area-summary" aria-labelledby="tb-package-h">
    <header class="hm-band"><h2 id="tb-package-h">{{ builder.rulesetLabel() }}</h2><span class="hm-cap">Ruleset</span></header>
    <p v-if="free" class="tb-free-note">{{ cards[0]!.description }}</p>
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
    <template v-if="free">
    <p class="muted tb-hint">Every BB2025 roster. Pick one to start.</p>
    <div class="tb-free-races" role="list" aria-label="Races">
      <button v-for="r in freeRaces" :key="r.rosterId" type="button" role="listitem" class="tb-free-race" :data-tt-race="r.rosterId"
        :aria-pressed="r.selected ? 'true' : 'false'" @click="emit('race', r.rosterId)">
        <img v-if="r.crest" class="crest-image tt-team-crest" :src="r.crest" alt="" aria-hidden="true" loading="lazy" decoding="async" />
        <span>{{ r.raceName }}</span>
      </button>
    </div>
    <p v-if="!freeRaces.length" class="hm-empty">No rosters are installed.</p>
    </template>
    <template v-else-if="state.packageName">
    <p class="muted tb-hint">Each team name picks that race.</p>
    <div v-if="table.html" ref="scrollEl" class="tb-scroll tb-race-scroll" :class="{ 'tb-race-loading': loading }" :aria-busy="loading ? 'true' : 'false'" tabindex="0" role="region" aria-label="Races by tier" @click="onTableClick">
      <table :class="table.legacy ? 'tier-table' : 'tt-rules-table'" v-html="table.html"></table>
    </div>
    <p v-if="!table.selectable" class="hm-empty">No installed roster is eligible for this ruleset.</p>
    </template>
    <div v-if="state.roster" class="tb-actions">
      <button type="button" class="tb-btn primary" @click="emit('next')">Build the {{ state.roster.raceName }} team</button>
    </div>
  </section>
  </div>
</template>
