// League dialog keys (LeagueDialog.vue), pure so it can be tested without a DOM. The dialog listens on the window while
// it is open, so Escape and Tab still work after the focused control was removed (focus fell to <body>) or focus left
// the dialog: Tab then brings focus back to the dialog's first (Shift+Tab: last) focusable, or the frame itself.
import { trapTarget } from "../home/shell";

export type LeagueDialogKey<T> = { type: "close" } | { type: "block" } | { type: "focus"; target: T } | null;

export function leagueDialogKey<T>(
  e: { key: string; shiftKey: boolean },
  focusables: readonly T[],
  active: T | null,
  inside: boolean,
  frame: T,
  busy: boolean,
): LeagueDialogKey<T> {
  if (e.key === "Escape") return busy ? { type: "block" } : { type: "close" };
  if (e.key !== "Tab") return null;
  if (!focusables.length) return { type: "focus", target: frame };
  if (!inside) return { type: "focus", target: e.shiftKey ? focusables[focusables.length - 1]! : focusables[0]! };
  const target = trapTarget(focusables, active, e.shiftKey);
  return target === undefined ? null : { type: "focus", target };
}
