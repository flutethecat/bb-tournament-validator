<script setup lang="ts">
// Tournament Creator: override knobs shared by tiers and team rules (count / swap / stacking / stars). Team rules merge
// gold / maxPrimary / maxSecondary with `!== undefined` (null = no limit); tiers merge them with `!= null` (null =
// inherit), so tiers get no "none" state there.
import { computed, inject } from "vue";
import { safeArray, type Path, type StarPack } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorStatIncreases from "./CreatorStatIncreases.vue";
import CreatorTri from "./CreatorTri.vue";

const props = withDefaults(defineProps<{ path: Path; team?: boolean }>(), { team: false });
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const p = (...keys: string[]): Path => [...props.path, ...keys];
const packs = computed(() => safeArray<StarPack>(c.state.pkg?.starPacks).map((pack, i) => ({
  value: String(pack.id ?? ""), label: pack.label ? `${pack.label} (${pack.id})` : String(pack.id || `Pack ${i + 1}`),
})));
const starItems = computed(() => c.state.stars.map((s) => ({ value: s.name, label: s.name })));
</script>

<template>
  <div class="cr-grid">
    <CreatorOverride v-if="team" label="Gold cap" :path="p('gold')" kind="gold" none none-label="no gold cap" />
    <CreatorOverride v-if="team" label="SP budget" :path="p('skillPointBudget')" />
    <CreatorOverride label="Max primary (count)" :path="p('maxPrimary')" :none="team" />
    <CreatorOverride label="Max secondary (count)" :path="p('maxSecondary')" :none="team" />
    <CreatorTri label="Secondary swap" :path="p('secondarySwap')" />
    <CreatorOverride label="Swap ratio (primary per secondary)" :path="p('secondarySwapRatio')" :min="1" />
    <CreatorOverride label="Max swaps" :path="p('secondarySwapMax')" none none-label="unlimited" />
    <CreatorOverride label="Max stacked players" :path="p('maxStackedPlayers')" none />
    <CreatorOverride label="Elite skills cap" :path="p('eliteMaxTotal')" kind="int" none />
    <CreatorOverride label="Same elite skill cap" :path="p('eliteMaxSameSkill')" kind="int" none />
    <CreatorOverride label="Stacked player: max skills" :path="p('stackedPlayer', 'maxSkills')" kind="int" none />
    <CreatorOverride label="Stacked player: max secondary" :path="p('stackedPlayer', 'maxSecondary')" kind="int" none />
    <CreatorOverride label="Stacked player: max elite" :path="p('stackedPlayer', 'maxElite')" kind="int" none />
    <CreatorTri v-if="team" label="Star players" :path="p('starPlayersAllowed')" />
  </div>
  <CreatorStatIncreases :path="p('statIncreases')" inherit />
  <div class="cr-grid">
    <CreatorMulti v-if="packs.length" label="Star packs open" :path="p('starPacksAllowed')" :items="packs" all-label="Inherit (every pack)" />
    <CreatorMulti label="Banned stars" :path="p('bannedStars')" :items="starItems" :all-label="team ? 'Inherit' : undefined" />
  </div>
</template>
