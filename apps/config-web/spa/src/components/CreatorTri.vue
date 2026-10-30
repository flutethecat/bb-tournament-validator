<script setup lang="ts">
// Tournament Creator: inherit / yes / no select bound to a package path (absent / true / false).
import { computed, inject } from "vue";
import { getPath, type Path } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";

const props = withDefaults(defineProps<{ label: string; path: Path; labels?: [string, string, string] }>(), { labels: () => ["inherit", "yes", "no"] });
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const current = computed(() => {
  const v = c.state.pkg ? getPath(c.state.pkg, props.path) : undefined;
  return v === true ? "true" : v === false ? "false" : "";
});
const onChange = (e: Event): void => c.setBound(props.path, "tri", "delete", (e.target as HTMLSelectElement).value);
</script>

<template>
  <label class="cr-field">
    <span class="cr-label">{{ label }}</span>
    <select :value="current" :aria-label="label" :disabled="Boolean(c.state.readOnly)" @change="onChange">
      <option value="">{{ labels[0] }}</option>
      <option value="true">{{ labels[1] }}</option>
      <option value="false">{{ labels[2] }}</option>
    </select>
  </label>
</template>
