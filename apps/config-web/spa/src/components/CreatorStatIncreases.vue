<script setup lang="ts">
// Tournament Creator: the stat-increase rule (flat on the Skills tab; an inheriting override on tiers and team rules).
import { computed, inject } from "vue";
import { getPath, isObj, STAT_KEYS, type Path, type StatIncreases } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";
import CreatorMulti from "./CreatorMulti.vue";
import CreatorNum from "./CreatorNum.vue";
import CreatorOverride from "./CreatorOverride.vue";
import CreatorTri from "./CreatorTri.vue";

const props = defineProps<{ path: Path; inherit: boolean }>();
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const rule = computed<StatIncreases>(() => {
  const v = c.state.pkg ? getPath(c.state.pkg, props.path) : undefined;
  return isObj(v) ? (v as StatIncreases) : {};
});
const statItems = STAT_KEYS.map((s) => ({ value: s, label: s }));
const exclusive = (e: Event): void => c.setBound([...props.path, "exclusiveWithSkills"], "bool", "delete", (e.target as HTMLInputElement).checked);
</script>

<template>
  <div class="cr-inset">
    <h4 class="cr-sub">Stat increases</h4>
    <div class="cr-grid">
      <CreatorMulti label="Allowed stats" :path="[...path, 'allowed']" :items="statItems" :all-label="inherit ? 'Inherit' : 'Not checked'" />
      <CreatorOverride
        label="Max per player" :path="[...path, 'maxPerPlayer']" kind="int" none
        :placeholder="inherit ? 'inherit' : '1 (default)'" :inherit-label="inherit ? 'inherit' : 'default'"
      />
      <template v-for="stat in STAT_KEYS" :key="stat">
        <CreatorOverride v-if="inherit" :label="`${stat} cost`" :path="[...path, 'costGold', stat]" kind="gold" />
        <CreatorNum v-else :label="`${stat} cost`" :path="[...path, 'costGold', stat]" kind="gold" placeholder="0" />
      </template>
      <CreatorTri v-if="inherit" label="No added skills with a stat increase" :path="[...path, 'exclusiveWithSkills']" />
    </div>
    <label v-if="!inherit" class="cr-check">
      <input type="checkbox" :checked="rule.exclusiveWithSkills === true" :disabled="Boolean(c.state.readOnly)" @change="exclusive" />
      <span>A player with a stat increase may not take added skills</span>
    </label>
  </div>
</template>
