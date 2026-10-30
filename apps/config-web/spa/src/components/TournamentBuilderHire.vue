<script setup lang="ts">
// Tournament Builder, Hireable players (left column of the Roster pane, owner 10-30): the roster's position cards stacked
// (limits, position groups, the 16-player cap). Hiring needs a named team: an unnamed team gets the name gate (message in the
// Errors / Valid box, focus on the team name field).
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { core, type BuilderPosition } from "../teams/builderCore";
import { fourCardHeight, watchFourCards } from "../teams/hireWindow";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const { state } = builder;
const cards = computed(() => builder.positionCards());
const printed = (p: BuilderPosition): string[] => p.skills ?? [];
/** The list shows four cards at a time: its max-height is the bottom of the 4th card (cards differ in height), measured. */
const list = ref<HTMLElement | null>(null);
const maxH = ref<string | undefined>(undefined);
function measure(): void {
  const el = list.value;
  const h = el ? fourCardHeight(Array.from(el.children) as HTMLElement[]) : undefined;
  maxH.value = h === undefined ? undefined : `${h}px`;
}
let watcher: ReturnType<typeof watchFourCards> | null = null;
function remeasure(): void { maxH.value = undefined; void nextTick(measure); } // card heights follow the width: unset, then measure
onMounted(() => {
  measure();
  if (typeof window !== "undefined") window.addEventListener("resize", remeasure);
  if (list.value) watcher = watchFourCards(list.value, measure);
});
onBeforeUnmount(() => { watcher?.stop(); watcher = null; if (typeof window !== "undefined") window.removeEventListener("resize", remeasure); });
// A different ruleset / race changes the cards: re-measure and re-attach the observers to the new first four.
watch(cards, () => void nextTick(() => { measure(); watcher?.rewatch(); }));
function add(positionId: string): void {
  if (ui.requireName()) builder.addPosition(positionId);
}
</script>

<template>
  <section class="hm-panel tb-panel" aria-labelledby="tb-add-h">
    <header class="hm-band"><h2 id="tb-add-h">Hireable players</h2><span class="hm-cap">{{ state.slots.length }} / {{ core.MAX_PLAYERS }}</span></header>
    <div ref="list" class="tb-positions tb-hire-list" :style="maxH ? { maxHeight: maxH } : undefined">
      <button
        v-for="c in cards" :key="c.position.positionId" type="button" class="tb-position" :class="{ 'name-required': !builder.named() }"
        :disabled="c.exhausted" :aria-label="`Add ${c.position.name}`"
        :title="!builder.named() ? 'You must name your team.' : c.group ? `${c.group.label || 'Position group'} limit reached` : c.name !== c.position.name ? c.position.name : undefined"
        @click="add(c.position.positionId)"
      >
        <span class="sprite-frame tb-sprite" aria-hidden="true"><span class="sprite-fallback">{{ c.name.slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(c.position.name)" class="sprite-image" :src="builder.spritePath(c.position.name)" alt="" loading="lazy" /></span>
        <span class="tb-position-head">
          <strong>{{ c.name }}</strong>
          <small>{{ c.left }} of {{ c.position.max }} left<template v-if="c.role"> · {{ c.role }}</template></small>
        </span>
        <span class="tb-cost">{{ core.gold(c.position.cost) }}</span>
        <TournamentBuilderStats :position="c.position" />
        <span class="row-skills tb-printed">
          <span v-for="k in printed(c.position)" :key="k" :class="builder.skillClass(k)">{{ k }}</span>
          <span v-if="!printed(c.position).length" class="muted">No printed skills</span>
        </span>
      </button>
    </div>
  </section>
</template>
