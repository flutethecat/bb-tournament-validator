<script setup lang="ts">
// Tournament Builder, Star Players (left column of the Roster pane): the star picker (pairs, bans, SP costs, packs, the
// ruleset's cap). Stars never take added skills or characteristic increases. Adding one needs a named team: an unnamed team
// gets the name gate (message in the Errors / Valid box, focus on the team name field in the Team controls).
import { computed, inject } from "vue";
import { TOURNAMENT_BUILDER_KEY, TOURNAMENT_BUILDER_UI_KEY } from "../teams/builder";

const builder = inject(TOURNAMENT_BUILDER_KEY)!;
const ui = inject(TOURNAMENT_BUILDER_UI_KEY)!;
const stars = computed(() => (builder.starsAllowed() ? builder.starChoices().map((c) => builder.starRow(c)) : []));
const spTable = computed(() => builder.starSpTable());
const cap = computed(() => builder.starCap());
function addStar(key: string): void {
  if (ui.requireName()) builder.addStar(key);
}
</script>

<template>
  <section v-if="builder.starsAllowed()" class="hm-panel tb-panel" aria-labelledby="tb-stars-h">
    <header class="hm-band"><h2 id="tb-stars-h">Star Players</h2><span v-if="cap != null" class="hm-cap">{{ builder.starPickCount() }} / {{ cap }}</span></header>
    <p class="muted tb-hint">Stars never take added skills or characteristic increases.</p>
    <p v-if="!stars.length" class="hm-empty">No star players are available for this roster under this ruleset.</p>
    <ul v-else class="tb-stars">
      <li v-for="r in stars" :key="r.choice.key" class="tb-star">
        <span class="tb-star-sprites" aria-hidden="true">
          <span v-for="m in r.choice.members" :key="m.positionId" class="sprite-frame tb-sprite small"><span class="sprite-fallback">{{ m.name.slice(0, 2).toUpperCase() }}</span><img v-if="builder.spritePath(m.name)" class="sprite-image" :src="builder.spritePath(m.name)" alt="" loading="lazy" /></span>
        </span>
        <span class="tb-who">
          <strong>{{ r.choice.label }}</strong>
          <small>{{ r.price }} · {{ r.status }}</small>
          <small v-if="r.packs" class="muted">{{ r.packs }}</small>
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
  </section>
</template>
