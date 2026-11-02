<script setup lang="ts">
// Tournament Builder, Hireable players (a panel of the Roster pane's left accordion, owner 10-30 / 10-31): the roster's
// position cards stacked (limits, position groups, the 16-player cap), five cards at a time. Hiring needs a named team: an
// unnamed team gets the name gate (message in the save-line box, focus on the team name field). The panel's header bar is
// the accordion's (TournamentBuilderAccordion.vue).
import { computed, inject, ref } from "vue";
import { ELITE_ICON, TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { core, type BuilderPosition } from "../teams/builderCore";
import { useRowWindow } from "../teams/hireWindow";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const cards = computed(() => builder.positionCards());
/** Blood Bowl Sevens: "Non-Linemen 3 / 4" over the cards (null for standard rulesets). */
const nonLineman = computed(() => builder.nonLineman());
const printed = (p: BuilderPosition): string[] => p.skills ?? [];
const list = ref<HTMLElement | null>(null);
const { maxHeight } = useRowWindow(list, () => cards.value.map((c) => c.position.positionId));
function add(positionId: string): void {
  if (ui.requireName() && builder.addPosition(positionId)) ui.noteAdded();
}
</script>

<template>
  <p v-if="nonLineman" class="tb-nl-count" :data-tone="nonLineman.count >= nonLineman.max ? 'full' : undefined" aria-live="polite">
    <span class="tb-k">Non-Linemen</span><b>{{ nonLineman.count }} / {{ nonLineman.max }}</b>
    <small v-if="nonLineman.count >= nonLineman.max" class="muted">Sevens: at most {{ nonLineman.max }} players without the Lineman keyword.</small>
  </p>
  <div ref="list" class="tb-positions tb-hire-list tb-row-window" :style="maxHeight ? { maxHeight } : undefined">
    <button
      v-for="c in cards" :key="c.position.positionId" type="button" class="tb-position" :class="{ 'name-required': !builder.named() }"
      :disabled="c.exhausted" :aria-label="`Add ${c.position.name}, ${c.count} of ${c.position.max} hired, ${core.gold(c.position.cost)}`"
      :title="!builder.named() ? 'You must name your team.' : c.reason ? c.reason : c.group ? `${c.group.label || 'Position group'} limit reached` : c.name !== c.position.name ? c.position.name : undefined"
      :data-reason="c.reason || undefined"
      @click="add(c.position.positionId)"
    >
      <span class="sprite-frame tb-sprite" aria-hidden="true"><span class="sprite-fallback">{{ c.name.slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(c.position.name)" class="sprite-image" :src="builder.spritePath(c.position.name)" alt="" loading="lazy" /></span>
      <span class="tb-position-head"><strong>{{ c.name }}</strong></span>
      <span class="tb-corner">
        <span class="tb-cost">{{ core.gold(c.position.cost) }}</span>
        <small class="tb-hired">{{ c.count }}/{{ c.position.max }}</small>
      </span>
      <TournamentBuilderStats :position="c.position" />
      <small v-if="c.reason && c.exhausted" class="tb-hire-reason">{{ c.reason }}</small>
      <span class="row-skills tb-printed tb-skillband">
        <span v-for="k in printed(c.position)" :key="k" :class="[builder.skillClass(k), { 'tb-elite-chip': builder.eliteMark(k) }]" :title="builder.eliteMark(k) ? 'Elite skill' : undefined"><img v-if="builder.eliteMark(k)" class="tb-elite-dot" :src="ELITE_ICON" alt="" width="12" height="12" />{{ k }}</span>
        <span v-if="!printed(c.position).length" class="muted">No printed skills</span>
      </span>
    </button>
  </div>
</template>
