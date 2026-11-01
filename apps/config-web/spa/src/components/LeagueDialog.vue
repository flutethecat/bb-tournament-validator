<script setup lang="ts">
// League organiser dialog frame (design.md §5 dialogs; styles in leagues/leagues.css, .ls-dialog*): a panel with a band
// title (and an optional caption), the body slot, and the footer slot (secondary at left, primary at right). Escape and
// the close button close it (not while busy); Tab wraps inside it; focus moves in on open ([data-autofocus] first) and
// back to the opener on close. `tag="form"` makes the frame the form, so the footer's submit button submits it.
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { FOCUSABLE, trapTarget } from "../home/shell";

const props = withDefaults(defineProps<{
  id: string; title: string; cap?: string; wide?: boolean; busy?: boolean; role?: "dialog" | "alertdialog"; describedby?: string; tag?: "div" | "form";
}>(), { cap: "", wide: false, busy: false, role: "dialog", describedby: undefined, tag: "div" });
const emit = defineEmits<{ close: []; submit: [] }>();

const frame = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
const focusables = (): HTMLElement[] => Array.from(frame.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
const close = (): void => { if (!props.busy) emit("close"); };
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab") return;
  const list = focusables();
  const target = list.length ? trapTarget(list, document.activeElement as HTMLElement | null, e.shiftKey) : frame.value ?? undefined;
  if (target) { e.preventDefault(); target.focus({ preventScroll: true }); }
}
onMounted(async () => {
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  const first = frame.value?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables().find((el) => !el.classList.contains("ls-dialog-x"));
  (first ?? frame.value)?.focus({ preventScroll: true });
});
onUnmounted(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
</script>

<template>
  <div class="ls-dialog-backdrop" @click.self="close">
    <component
      :is="tag" ref="frame" class="ls-dialog" :class="{ wide }" :role="role" aria-modal="true" :aria-labelledby="id" :aria-describedby="describedby"
      tabindex="-1" @keydown="onKey" @submit.prevent="emit('submit')"
    >
      <header class="hm-band">
        <h2 :id="id">{{ title }}</h2>
        <span v-if="cap" class="hm-cap">{{ cap }}</span>
        <button type="button" class="ls-dialog-x" aria-label="Close" :disabled="busy" @click="close">×</button>
      </header>
      <div class="ls-dialog-body"><slot /></div>
      <footer v-if="$slots.foot" class="ls-dialog-foot"><slot name="foot" /></footer>
    </component>
  </div>
</template>
