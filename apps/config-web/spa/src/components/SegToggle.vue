<script setup lang="ts" generic="T extends string">
// A segmented choice (radiogroup) in the band style (.tl-seg): one tab stop, arrows / Home / End move the choice.
import { nextTick, ref } from "vue";

const props = defineProps<{ options: ReadonlyArray<{ id: T; label: string }>; modelValue: T; label: string }>();
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const seg = ref<HTMLElement | null>(null);
function onKey(e: KeyboardEvent): void {
  const i = props.options.findIndex((o) => o.id === props.modelValue);
  const last = props.options.length - 1;
  const to = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i >= last ? 0 : i + 1)
    : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i <= 0 ? last : i - 1)
      : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
  if (to < 0) return;
  e.preventDefault();
  emit("update:modelValue", props.options[to]!.id);
  void nextTick(() => seg.value?.querySelectorAll<HTMLElement>("[role=radio]")[to]?.focus());
}
</script>

<template>
  <div ref="seg" class="tl-seg sf-seg" role="radiogroup" :aria-label="label" @keydown="onKey">
    <button
      v-for="o in options" :key="o.id" type="button" role="radio" class="tl-seg-btn"
      :aria-checked="modelValue === o.id ? 'true' : 'false'" :tabindex="modelValue === o.id ? 0 : -1" @click="emit('update:modelValue', o.id)"
    >{{ o.label }}</button>
  </div>
</template>
