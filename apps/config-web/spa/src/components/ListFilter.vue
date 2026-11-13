<script setup lang="ts">
// The filter box of a list (shared/listView.ts filterList): a search input with a visually hidden label. `status` (the
// "3 of 12 teams" line) is announced politely to screen readers as the list narrows; `data` names an optional data
// attribute for the input. Typing never moves focus: the list re-renders around the box.
import { computed } from "vue";

const props = withDefaults(defineProps<{ modelValue: string; label: string; placeholder?: string; data?: string; status?: string }>(), { placeholder: "", data: "", status: undefined });
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const text = computed({ get: () => props.modelValue, set: (v: string) => emit("update:modelValue", v) });
const mark = (): Record<string, string> => (props.data ? { [props.data]: "" } : {});
</script>

<template>
  <label class="sf-field">
    <span class="sf-sr">{{ label }}</span>
    <input v-model="text" class="sf-input" type="search" :placeholder="placeholder" autocomplete="off" v-bind="mark()" />
    <span v-if="status !== undefined" class="sf-sr" role="status" aria-live="polite">{{ status }}</span>
  </label>
</template>
