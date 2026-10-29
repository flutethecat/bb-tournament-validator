// Behaviour of the Account page's "Set schedule" dialog, kept free of the DOM so it can be tested directly. The dialog
// shows the shared schedule editor (account/editors.ts), so a save reshades the calendar at once. Closing never asks
// anything and never throws the edits away: they stay in the editor, reopening shows them and the dirty hint remains.

import { ref, type InjectionKey, type Ref } from "vue";

export interface ScheduleDialogDeps {
  /** True while the editor holds unsaved changes (an overlay click must not close over them). */
  isDirty: () => boolean;
  /** Puts keyboard focus back on the "Set schedule" button (a no-op when it is gone). */
  focusOpener: () => void;
}

export interface ScheduleDialog {
  open: Ref<boolean>;
  show(): void;
  /** Escape / the Close button / the x: always closes and returns focus to the opener. */
  close(): void;
  /** A press on the dim overlay (outside the dialog): closes only when there are no unsaved changes. */
  pressOverlay(): void;
}

export function createScheduleDialog(deps: ScheduleDialogDeps, initialOpen = false): ScheduleDialog {
  const open = ref(initialOpen);
  const dialog: ScheduleDialog = {
    open,
    show() { open.value = true; },
    close() {
      if (!open.value) return;
      open.value = false;
      deps.focusOpener();
    },
    pressOverlay() { if (!deps.isDirty()) dialog.close(); },
  };
  return dialog;
}

/** Test seam: a controller provided by the host replaces the page's own (rendering the dialog open in SSR). */
export const SCHEDULE_DIALOG_KEY: InjectionKey<ScheduleDialog> = Symbol("schedule-dialog");

/** The hash that lands on the dialog (/app/account#schedule, kept from when Schedule was a panel). */
export const SCHEDULE_HASH = "#schedule";
