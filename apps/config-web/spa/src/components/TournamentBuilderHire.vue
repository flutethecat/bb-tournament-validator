<script setup lang="ts">
// Tournament Builder, Hireable players (left column of the Roster pane, owner 10-30): the roster's position cards stacked
// (limits, position groups, the 16-player cap). Hiring needs a named team: an unnamed team gets the name gate (message in the
// Errors / Valid box, focus on the team name field).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { core, type BuilderPosition } from "../teams/builderCore";
import TournamentBuilderStats from "./TournamentBuilderStats.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const { state } = builder;
const cards = computed(() => builder.positionCards());
const printed = (p: BuilderPosition): string[] => p.skills ?? [];
function add(positionId: string): void {
  if (ui.requireName()) builder.addPosition(positionId);
}
</script>

<template>
  <section class="hm-panel tb-panel" aria-labelledby="tb-add-h">
    <header class="hm-band"><h2 id="tb-add-h">Hireable players</h2><span class="hm-cap">{{ state.slots.length }} / {{ core.MAX_PLAYERS }}</span></header>
    <div class="tb-positions">
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
