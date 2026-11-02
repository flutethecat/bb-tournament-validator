<script setup lang="ts">
// Tournament Builder, Star Players (a panel of the Roster pane's left accordion): the star picker (pairs, bans, SP costs,
// packs, the ruleset's cap), five stars at a time. Stars never take added skills or characteristic increases. Adding one
// needs a named team: an unnamed team gets the name gate (message in the save-line box, focus on the team name field).
// A race with no star access never opens this panel: its header bar reads NO STAR ACCESS (TournamentBuilderAccordion.vue).
import { computed, inject, ref } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";
import { useRowWindow } from "../teams/hireWindow";
import CustomStarSpecialRules from "./CustomStarSpecialRules.vue";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const stars = computed(() => (builder.starsAllowed() ? builder.starChoices().map((c) => builder.starRow(c)) : []));
const spTable = computed(() => builder.starSpTable());
const list = ref<HTMLElement | null>(null);
const { maxHeight } = useRowWindow(list, () => stars.value.map((r) => r.choice.key));
function addStar(key: string): void {
  if (ui.requireName() && builder.addStar(key)) ui.noteAdded();
}
</script>

<template>
  <p class="muted tb-hint">Stars never take added skills or characteristic increases.</p>
  <p v-if="!stars.length" class="hm-empty">No star players are available for this roster under this ruleset.</p>
  <ul v-else ref="list" class="tb-stars tb-scroll-list tb-row-window" :style="maxHeight ? { maxHeight } : undefined">
    <li v-for="r in stars" :key="r.choice.key" class="tb-star">
      <span class="tb-star-sprites" aria-hidden="true">
        <span v-for="m in r.choice.members" :key="m.positionId" class="sprite-frame tb-sprite small"><span class="sprite-fallback">{{ m.name.slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(m.name)" class="sprite-image" :src="builder.spritePath(m.name)" alt="" loading="lazy" /></span>
      </span>
      <span class="tb-who">
        <strong>{{ r.choice.label }}</strong>
        <small>{{ r.price }} · {{ r.status }}</small>
        <small v-if="r.packs" class="muted">{{ r.packs }}</small>
        <CustomStarSpecialRules v-for="m in r.choice.members" :key="`sr-${m.positionId}`" :rules="builder.specialRulesOf(m.positionId)" compact />
      </span>
      <span class="tb-stepper">
        <button type="button" :disabled="!r.present" :aria-label="`Remove ${r.choice.label}`" @click="builder.removeStar(r.choice.key)">−</button>
        <button type="button" :class="{ 'name-required': !builder.named() }" :disabled="!r.canAdd"
          :title="!builder.named() ? 'You must name your team.' : r.capReached ? 'This ruleset\'s star player limit is reached.' : undefined"
          :aria-label="`Add ${r.choice.label}`" @click="addStar(r.choice.key)">+</button>
      </span>
    </li>
  </ul>
  <details v-if="spTable.rows.length || spTable.banned.length" class="tb-notes">
    <summary>Star Player SP costs<template v-if="spTable.rows.length"> ({{ spTable.rows.length }})</template></summary>
    <table v-if="spTable.rows.length" class="tb-table">
      <thead><tr><th scope="col">Star Player</th><th scope="col">SP Cost</th></tr></thead>
      <tbody><tr v-for="r in spTable.rows" :key="r.name"><th scope="row">{{ r.name }}</th><td>{{ r.sp }} SP</td></tr></tbody>
    </table>
    <p v-if="spTable.banned.length" class="muted">Banned: {{ spTable.banned.join(", ") }}</p>
  </details>
</template>
