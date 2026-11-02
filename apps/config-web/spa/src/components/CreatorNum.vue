<script setup lang="ts">
// Tournament Creator: a number field bound to a package path. A default normalizePackage() filled in (and the
// organiser has not touched) shows as a placeholder, so it reads differently from an explicit value.
import { computed, inject } from "vue";
import { getPath, goldToK, type Path } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY, type BlankMode } from "../tournaments/creator";

const props = withDefaults(defineProps<{
  label: string; path: Path; kind?: "num" | "int" | "gold"; blank?: BlankMode; placeholder?: string; suffix?: string; min?: number; step?: string; aria?: string;
}>(), { kind: "num", blank: "delete", placeholder: "", suffix: undefined, min: 0, step: undefined, aria: undefined });
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const raw = computed(() => (c.state.pkg ? getPath(c.state.pkg, props.path) : undefined));
const inherited = computed(() => c.isInherited(props.path));
/** The extends base this value comes from (a package with no format of its own): tagged "inherited". */
const from = computed(() => c.inheritedFrom(props.path));
const display = computed(() => {
  const v = props.kind === "gold" ? goldToK(raw.value) : raw.value ?? "";
  return inherited.value ? "" : String(v);
});
const hint = computed(() => (inherited.value ? c.inheritedHint(props.kind === "gold" ? goldToK(raw.value) : raw.value) : props.placeholder));
const unit = computed(() => props.suffix ?? (props.kind === "gold" ? "k" : ""));
const onChange = (e: Event): void => c.setBound(props.path, props.kind, props.blank, (e.target as HTMLInputElement).value);
</script>

<template>
  <label class="cr-field">
    <span class="cr-label">{{ label }}<small v-if="from" class="cr-inh" :title="`Inherited from ${from}`" data-inherited>inherited</small></span>
    <span class="cr-input">
      <input type="number" :min="min" :step="step" :value="display" :placeholder="hint" :aria-label="aria ?? label" :disabled="Boolean(c.state.readOnly)" @change="onChange" />
      <span v-if="unit" class="cr-unit">{{ unit }}</span>
    </span>
  </label>
</template>
