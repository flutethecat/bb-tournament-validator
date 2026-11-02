<script setup lang="ts">
// A position's MA / ST / AG / PA / AV strip; chosen +1 increases show improved (core.improvedStats). `down` marks tiles the
// ruleset lowered (the Blood Bowl Sevens Veteran's MA −1; the position passed in already carries the lower value).
import { computed } from "vue";
import { core, type BuilderPosition } from "../teams/builderCore";

const props = defineProps<{ position: BuilderPosition | null; increases?: string[]; down?: string[] }>();
const cells = computed(() => {
  const stats = core.improvedStats(props.position, props.increases ?? []);
  return core.STATS.map((k) => ({ k, value: String(stats[k].value), up: stats[k].improved, down: (props.down ?? []).includes(k) }));
});
</script>

<template>
  <span class="tb-stats">
    <span v-for="c in cells" :key="c.k" class="tb-stat" :class="{ up: c.up, down: c.down && !c.up }"
      :title="c.up ? `${c.k} increased` : c.down ? `Veteran: ${c.k} −1` : undefined"><b>{{ c.value }}</b><small>{{ c.k }}</small></span>
  </span>
</template>
