<script setup lang="ts">
// Tournament Creator, Stars tab: the package's custom stars (creation wizards v2). "Create a star" opens the Roster
// Builder-style row (CustomStarDialog); each saved star shows as that row, read-only, with Edit and Remove. They are saved
// inside the ruleset package (Save package), so every competition on it offers them in the Stars list. Coaches hire them as
// they are: stars never take added skills.
import { computed, inject, ref } from "vue";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import { statValue, STAR_STATS, type CustomStarDoc } from "../tournaments/customStars";
import CustomStarDialog from "./CustomStarDialog.vue";
import CustomStarSpecialRules from "./CustomStarSpecialRules.vue";
import "../teams/builder.css";

const c = inject(TOURNAMENT_CREATOR_KEY)!;
const { state } = c;
const ro = computed(() => Boolean(state.readOnly));
const sevens = computed(() => c.sevens());
const stars = computed(() => c.customStars());
const datasetStars = computed(() => state.stars.map((s) => s.name));
/** null = closed; "new" = Create a star; else the star being edited. */
const editing = ref<CustomStarDoc | "new" | null>(null);
const gold = (n: number): string => `${Math.round(n / 1000).toLocaleString("en-US")}k`;
function onSave(star: CustomStarDoc): void {
  c.saveCustomStar(star);
  editing.value = null;
}
</script>

<template>
  <section class="hm-panel" aria-labelledby="cr-custom-stars-h" data-custom-stars>
    <header class="hm-band"><h2 id="cr-custom-stars-h">Custom stars</h2><span class="hm-cap">{{ stars.length || "none" }}</span></header>
    <p v-if="sevens" class="cr-hint">Sevens has no Star Players, so custom stars can't be hired here.</p>
    <p class="cr-hint">Stars you create are saved in this ruleset: every competition using it offers them in the Stars list. Coaches can't change them.</p>
    <ol v-if="stars.length" class="tb-rows cr-cs-rows">
      <li v-for="s in stars" :key="s.id" class="tb-row cr-cs-row" :data-star="s.id">
        <span class="sprite-frame tb-sprite tb-row-sprite" aria-hidden="true"><span class="sprite-fallback">{{ s.name.slice(0, 2).toUpperCase() }}</span><img v-if="s.sprite" class="sprite-image" :src="s.sprite" alt="" /></span>
        <span class="tb-who"><strong class="tb-pname">{{ s.name }}</strong><small class="tb-psub">Custom star: no added skills</small></span>
        <span class="tb-cost">{{ gold(s.cost) }}</span>
        <span class="cr-cs-tools">
          <button type="button" class="sf-btn small" :disabled="ro" :aria-label="`Edit ${s.name}`" @click="editing = s">Edit</button>
          <button type="button" class="cr-remove" :disabled="ro" :aria-label="`Remove ${s.name}`" @click="c.removeCustomStar(s.id)">✕</button>
        </span>
        <span class="tb-row-line2"><span class="tv-stats cr-cs-stats"><span v-for="k in STAR_STATS" :key="k" class="tb-stat"><b>{{ statValue(s, k) }}</b><small>{{ k }}</small></span></span></span>
        <span class="row-skills tb-row-skills">
          <span v-for="k in s.skills" :key="k" class="skill skill-general">{{ k }}</span>
          <CustomStarSpecialRules :rules="s.specialRules ?? []" compact />
        </span>
      </li>
    </ol>
    <div class="cr-row">
      <button type="button" class="cr-btn primary" data-create-star :disabled="ro || sevens" @click="editing = 'new'">Create a star</button>
    </div>
  </section>
  <CustomStarDialog
    v-if="editing" :star="editing === 'new' ? null : editing" :others="stars" :dataset-stars="datasetStars" :read-only="ro"
    @close="editing = null" @save="onSave"
  />
</template>

<style scoped>
.cr-cs-rows { margin-bottom: 10px; }
.cr-cs-row { grid-template-columns: 64px minmax(0, 1fr) auto auto; grid-template-areas: "sprite who cost tools" "line2 line2 line2 line2" "skills skills skills skills"; padding: 6px 8px; gap: 4px 10px; }
.cr-cs-row > .tb-sprite { grid-area: sprite; }
.cr-cs-tools { grid-area: tools; display: flex; gap: 6px; align-items: center; }
.cr-cs-row > .tb-row-skills { display: flex; flex-wrap: wrap; gap: 4px; }
.cr-cs-stats { display: grid; grid-template-columns: repeat(5, minmax(40px, 56px)); gap: 4px; }
@media (max-width: 600px) {
  .cr-cs-row { grid-template-columns: 56px minmax(0, 1fr) auto; grid-template-areas: "sprite who tools" "cost cost cost" "line2 line2 line2" "skills skills skills"; }
}
</style>
