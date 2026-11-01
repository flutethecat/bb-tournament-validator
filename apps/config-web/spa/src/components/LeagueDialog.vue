<script setup lang="ts">
// League organiser dialog frame (design.md §5 dialogs; styles in leagues/leagues.css, .ls-dialog*): a panel with a band
// title (and an optional caption), the body slot, and the footer slot (secondary at left, primary at right). Escape and
// the close button close it (not while busy); Tab wraps inside it and brings focus back when it left; focus moves in
// on open ([data-autofocus] first) and back to the opener on close. `tag="form"` makes the frame the form, so the footer's submit button submits it.
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import { FOCUSABLE } from "../home/shell";
import { leagueDialogKey } from "../leagues/dialog";

const props = withDefaults(defineProps<{
  id: string; title: string; cap?: string; wide?: boolean; busy?: boolean; role?: "dialog" | "alertdialog"; describedby?: string; tag?: "div" | "form";
}>(), { cap: "", wide: false, busy: false, role: "dialog", describedby: undefined, tag: "div" });
const emit = defineEmits<{ close: []; submit: [] }>();

const frame = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
const focusables = (): HTMLElement[] => Array.from(frame.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null);
const close = (): void => { if (!props.busy) emit("close"); };
// On the window (capture) while open, not on the frame: a removed focused control drops focus to <body>, where a
// frame listener would never hear Escape or Tab (leagues/dialog.ts).
function onKey(e: KeyboardEvent): void {
  const el = frame.value;
  if (!el) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const action = leagueDialogKey(e, focusables(), active, Boolean(active && el.contains(active)), el, props.busy);
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") emit("close");
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  const first = frame.value?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables().find((el) => !el.classList.contains("ls-dialog-x"));
  (first ?? frame.value)?.focus({ preventScroll: true });
});
onUnmounted(() => {
  window.removeEventListener("keydown", onKey, true);
  if (opener?.isConnected) opener.focus({ preventScroll: true });
});
</script>

<template>
  <div class="ls-dialog-backdrop" @click.self="close">
    <component
      :is="tag" ref="frame" class="ls-dialog" :class="{ wide }" :role="role" aria-modal="true" :aria-labelledby="id" :aria-describedby="describedby"
      tabindex="-1" @submit.prevent="emit('submit')"
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
