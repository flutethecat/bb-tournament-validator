<script setup lang="ts">
// The header row of every recorder popup: the title on the left (optional extra content beside it), a 40 x 40 bevelled close button
// ("X") on the right, sticky while the body scrolls. Escape closes the topmost popup.
import { onBeforeUnmount, onMounted } from "vue";
import { dropSheet, isTopSheet, pushSheet } from "../tabletop/sheetStack";

defineProps<{ title: string }>();
const emit = defineEmits<{ (e: "close"): void }>();
const id = pushSheet();
const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape" && isTopSheet(id)) { e.preventDefault(); emit("close"); } };
onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => { window.removeEventListener("keydown", onKey); dropSheet(id); });
</script>

<template>
  <div class="tt-sheet-head">
    <h3 class="tt-sheet-title">{{ title }}</h3>
    <slot />
    <button class="tt-x" type="button" aria-label="Close" @click="emit('close')">&#10005;</button>
  </div>
</template>
