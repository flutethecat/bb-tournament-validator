// League dialog keys (LeagueDialog.vue), pure so it can be tested without a DOM. The dialog listens on the window while
// it is open, so Escape and Tab still work after the focused control was removed (focus fell to <body>) or focus left
// the dialog: Tab then brings focus back to the dialog's first (Shift+Tab: last) focusable, or the frame itself.
import { reactive, type InjectionKey } from "vue";
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

// League page Announcement dialog (LeagueAnnounce.vue) state, DOM-free: the dialog posts to the season it was opened on
// (captured here), and a league or season change closes it, dropping its drafts (the dialog unmounts).
export interface AnnounceState { seasonId: string; scope: string; notice: string }
export function createAnnounce() {
  const state = reactive<AnnounceState>({ seasonId: "", scope: "", notice: "" });
  return {
    state,
    /** Opens on `seasonId`; `scope` = the league/season the page shows (route key). */
    open(seasonId: string, scope: string): void { state.notice = ""; state.seasonId = seasonId; state.scope = scope; },
    close(): void { state.seasonId = ""; },
    /** A successful post or message: close and show the confirmation. */
    done(notice: string): void { state.seasonId = ""; state.notice = notice; },
    /** The page moved: another league or season closes the dialog; any move clears the confirmation. */
    moved(scope: string): void { state.notice = ""; if (scope !== state.scope) state.seasonId = ""; },
  };
}
export type Announce = ReturnType<typeof createAnnounce>;
export const ANNOUNCE_KEY: InjectionKey<Announce> = Symbol("league-announce");
