<script setup lang="ts">
// The Cards / Table switch of a list (shared/listView.ts): a labelled button group, aria-pressed on the shown view. The
// buttons stay in place when the view changes, so keyboard focus stays on the button just pressed. `data` names an
// optional data attribute each button carries with its view ("data-teams-view" -> data-teams-view="cards").
import { computed } from "vue";
import type { ListView } from "../shared/listView";

const props = withDefaults(defineProps<{ modelValue: ListView; label: string; tag?: "span" | "div"; data?: string }>(), { tag: "span", data: "" });
const emit = defineEmits<{ "update:modelValue": [view: ListView] }>();
const mark = (v: ListView): Record<string, string> => (props.data ? { [props.data]: v } : {});
const views = computed(() => [{ id: "cards" as const, label: "Cards" }, { id: "table" as const, label: "Table" }]);
</script>

<template>
  <component :is="tag" class="sf-tabs" role="group" :aria-label="label">
    <button v-for="v in views" :key="v.id" type="button" class="sf-tab" :aria-pressed="modelValue === v.id ? 'true' : 'false'" v-bind="mark(v.id)" @click="emit('update:modelValue', v.id)">{{ v.label }}</button>
  </component>
</template>
