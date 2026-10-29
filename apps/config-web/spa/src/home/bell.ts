// Behaviour of the top-bar bell popover, kept free of the DOM so it can be tested directly: open/close, the focus
// rule (every close returns focus to the bell, except an outside press that landed on another focusable control),
// choosing a row, Mark all read, and the clock the ages follow.

import { ref, type Ref } from "vue";
import type { Clock } from "./shell";
import type { NotificationRow, NotificationsStore } from "./notifications";

/** How many rows the popover lists (newest first). */
export const BELL_RECENT = 8;

export interface BellDeps {
  store: NotificationsStore;
  /** False for a test sign-in session: rows are readable but not marked read. */
  writable: () => boolean;
  /** SPA navigation for an in-app link ("/tournaments/t1"). */
  push: (path: string) => void;
  /** Puts keyboard focus back on the bell button (a no-op when it is gone). */
  focusBell: () => void;
  /** The shared 60 s clock the ages follow. */
  clock: Clock;
  /** Test override for "now". */
  now?: () => number | undefined;
}

export interface Bell {
  open: Ref<boolean>;
  /** "Now" for the ages: the override, else the shared clock (it ticks, so reopening later shows fresh ages). */
  nowMs(): number;
  toggle(): void;
  /** Closes (when open) and returns focus to the bell. */
  close(): void;
  /** A press outside the bell: closes, keeping focus where the press landed when that is another focusable control. */
  pressOutside(onFocusable: boolean): void;
  choose(row: NotificationRow, ev: Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault">): void;
  markAll(): Promise<void>;
}

export function createBell(deps: BellDeps, initialOpen = false): Bell {
  const open = ref(initialOpen);
  function shut(returnFocus: boolean): void {
    if (!open.value) return;
    open.value = false;
    if (returnFocus) deps.focusBell();
  }
  return {
    open,
    nowMs: () => deps.now?.() ?? deps.clock.state.now,
    toggle() {
      if (open.value) shut(true);
      else {
        open.value = true;
        if (!deps.store.loaded.value) void deps.store.load();
      }
    },
    close: () => shut(true),
    pressOutside: (onFocusable) => shut(!onFocusable),
    choose(row, ev) {
      if (deps.writable() && !row.readAt) void deps.store.markRead([row.id]);
      const plain = !(ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey);
      if (plain && row.link.startsWith("/app/")) {
        ev.preventDefault();
        deps.push(row.link.slice("/app".length));
      }
      shut(true);
    },
    markAll: () => deps.store.markAllRead(),
  };
}
