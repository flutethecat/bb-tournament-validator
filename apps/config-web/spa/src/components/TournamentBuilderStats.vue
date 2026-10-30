<script setup lang="ts">
// A position's MA / ST / AG / PA / AV strip; chosen +1 increases show improved (core.improvedStats).
import { computed } from "vue";
import { core, type BuilderPosition } from "../teams/builderCore";

const props = defineProps<{ position: BuilderPosition | null; increases?: string[] }>();
const cells = computed(() => {
  const stats = core.improvedStats(props.position, props.increases ?? []);
  return core.STATS.map((k) => ({ k, value: String(stats[k].value), up: stats[k].improved }));
});
</script>

<template>
  <span class="tb-stats">
    <span v-for="c in cells" :key="c.k" class="tb-stat" :class="{ up: c.up }" :title="c.up ? `${c.k} increased` : undefined"><b>{{ c.value }}</b><small>{{ c.k }}</small></span>
  </span>
</template>
