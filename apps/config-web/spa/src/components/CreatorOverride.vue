<script setup lang="ts">
// Tournament Creator: a three-state override, inherit (key absent) / an explicit value / an explicit null ("none").
// Only fields whose resolver treats null as "no limit" get the none state (`none`).
import { computed, inject } from "vue";
import { getPath, goldToK, type Path } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY, type OverrideMode } from "../tournaments/creator";

const props = withDefaults(defineProps<{
  label: string; path: Path; kind?: "num" | "int" | "gold"; none?: boolean; noneLabel?: string; flat?: boolean; placeholder?: string; inheritLabel?: string; min?: number;
}>(), { kind: "num", none: false, noneLabel: "no limit", flat: false, placeholder: undefined, inheritLabel: undefined, min: 0 });
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const value = computed(() => (c.state.pkg ? getPath(c.state.pkg, props.path) : undefined));
const mode = computed<OverrideMode>(() => c.overrideMode(props.path));
const display = computed(() => (mode.value !== "set" ? "" : String(props.kind === "gold" ? goldToK(value.value) : value.value ?? "")));
const hint = computed(() => {
  if (mode.value === "none") return props.noneLabel;
  if (mode.value === "inherit" && value.value !== undefined) {
    return c.inheritedHint(value.value === null ? "" : props.kind === "gold" ? `${goldToK(value.value)}k` : value.value);
  }
  return props.placeholder ?? (props.flat ? "default" : "inherit");
});
const inheritText = computed(() => props.inheritLabel ?? (props.flat ? (c.state.pkg?.extends ? "inherit" : "default") : "inherit"));
const onMode = (e: Event): void => c.setOverrideMode(props.path, (e.target as HTMLSelectElement).value as OverrideMode);
const onValue = (e: Event): void => c.setBound(props.path, props.kind, "delete", (e.target as HTMLInputElement).value);
</script>

<template>
  <label class="cr-field cr-override">
    <span class="cr-label">{{ label }}</span>
    <span class="cr-input">
      <select class="cr-mode" :value="mode" :aria-label="`${label} mode`" :disabled="Boolean(c.state.readOnly)" @change="onMode">
        <option value="inherit">{{ inheritText }}</option>
        <option value="set">value</option>
        <option v-if="none" value="none">{{ noneLabel }}</option>
      </select>
      <input type="number" :min="min" :value="display" :placeholder="hint" :aria-label="label" :disabled="Boolean(c.state.readOnly)" @change="onValue" />
      <span v-if="kind === 'gold'" class="cr-unit">k</span>
    </span>
  </label>
</template>
