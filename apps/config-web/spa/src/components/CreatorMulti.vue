<script setup lang="ts">
// Tournament Creator: a checkbox list in a <details>. `allLabel` adds an option meaning "key absent" (inherit / every).
// Values the catalog does not know (kept from the file) still show, so they can be unticked.
import { computed, inject } from "vue";
import { getPath, type Path } from "../tournaments/creatorCore";
import { TOURNAMENT_CREATOR_KEY } from "../tournaments/creator";

const props = withDefaults(defineProps<{ label: string; path: Path; items: Array<{ value: string; label: string }>; allLabel?: string; emptyLabel?: string }>(), {
  allLabel: undefined, emptyLabel: "none",
});
const c = inject(TOURNAMENT_CREATOR_KEY)!;
const list = computed<string[] | null>(() => {
  const v = c.state.pkg ? getPath(c.state.pkg, props.path) : undefined;
  return Array.isArray(v) ? (v as string[]) : null;
});
const all = computed(() => Boolean(props.allLabel) && list.value == null);
const options = computed(() => {
  const known = new Set(props.items.map((i) => i.value));
  return [...props.items, ...(list.value ?? []).filter((v) => !known.has(v)).map((v) => ({ value: v, label: v }))];
});
const summary = computed(() => (all.value ? props.allLabel ?? "" : list.value && list.value.length ? `${list.value.length} selected` : props.emptyLabel));
const ro = computed(() => Boolean(c.state.readOnly));
const onAll = (e: Event): void => c.setMultiAll(props.path, (e.target as HTMLInputElement).checked);
const onOne = (value: string, e: Event): void => c.toggleMulti(props.path, value, (e.target as HTMLInputElement).checked);
</script>

<template>
  <details class="cr-multi">
    <summary><span class="cr-label">{{ label }}</span> <span class="cr-multi-sum">{{ summary }}</span></summary>
    <div class="cr-multi-list">
      <label v-if="allLabel" class="cr-multi-opt cr-multi-all"><input type="checkbox" :checked="all" :disabled="ro" @change="onAll" /> <span>{{ allLabel }}</span></label>
      <label v-for="o in options" :key="o.value" class="cr-multi-opt">
        <input type="checkbox" :checked="Boolean(list?.includes(o.value))" :disabled="all || ro" @change="onOne(o.value, $event)" /> <span>{{ o.label }}</span>
      </label>
      <span v-if="!options.length" class="cr-hint">Catalog unavailable.</span>
    </div>
  </details>
</template>
