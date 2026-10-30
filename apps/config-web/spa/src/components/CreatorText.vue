<script setup lang="ts">
// Tournament Creator: a text field bound to a package path.
import { computed, inject } from "vue";
import { getPath, type Path } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY, type BlankMode } from "../tournaments/creator";

const props = withDefaults(defineProps<{ label: string; path: Path; blank?: BlankMode; placeholder?: string }>(), { blank: "delete", placeholder: "" });
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const value = computed(() => {
  const v = c.state.pkg ? getPath(c.state.pkg, props.path) : undefined;
  return v == null ? "" : String(v);
});
const onChange = (e: Event): void => c.setBound(props.path, "str", props.blank, (e.target as HTMLInputElement).value);
</script>

<template>
  <label class="cr-field">
    <span class="cr-label">{{ label }}</span>
    <input type="text" :value="value" :placeholder="placeholder" :aria-label="label" :disabled="Boolean(c.state.readOnly)" @change="onChange" />
  </label>
</template>
