<script setup lang="ts">
// "Set schedule" dialog (Account page, owner 10-30): the weekly availability editor in an aria-modal dialog. Same keyboard
// rules as AdvanceModal (dialogKey: focus moves in, Tab wraps, Escape closes, shell shortcuts stopped); the page behind is
// inert (AccountView) and focus returns to the opener on close.
import { nextTick, onMounted, onUnmounted, ref } from "vue";
import HomeSchedule from "./HomeSchedule.vue";
import { FOCUSABLE } from "../home/shell";
import { dialogKey } from "../teams/manage";
import type { ScheduleEditor } from "../home/schedule";
import type { ScheduleDialog } from "../account/scheduleDialog";

const props = defineProps<{ editor: ScheduleEditor; dialog: ScheduleDialog }>();
const root = ref<HTMLElement | null>(null);
const focusables = (): HTMLElement[] =>
  Array.from(root.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter((el) => el.offsetParent !== null || el === document.activeElement);
function onKey(e: KeyboardEvent): void {
  const action = dialogKey(e, focusables(), document.activeElement as HTMLElement | null, false);
  if (!action) return;
  if (action.type === "stop") { e.stopPropagation(); return; }
  e.preventDefault();
  e.stopPropagation();
  if (action.type === "close") props.dialog.close();
  else if (action.type === "focus") action.target.focus({ preventScroll: true });
}
onMounted(async () => {
  window.addEventListener("keydown", onKey, true);
  await nextTick();
  const first = root.value?.querySelector<HTMLElement>("select, input") ?? root.value;
  first?.focus({ preventScroll: true });
});
onUnmounted(() => window.removeEventListener("keydown", onKey, true));
</script>

<template>
  <div class="tn-modal-backdrop" @click.self="dialog.pressOverlay()">
    <div ref="root" class="tn-modal tn-panel ac-sched-modal" role="dialog" aria-modal="true" aria-labelledby="ac-sched-h" tabindex="-1" @keydown.stop>
      <h3 id="ac-sched-h" class="tn-band">
        Set schedule
        <button type="button" class="tn-modal-x" aria-label="Close" @click="dialog.close()">×</button>
      </h3>
      <div class="tn-panel-body ac-sched-body">
        <HomeSchedule :editor="editor" />
        <div class="tn-actions">
          <button type="button" class="sf-btn" @click="dialog.close()">Close</button>
        </div>
      </div>
    </div>
  </div>
</template>
