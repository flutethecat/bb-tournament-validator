// The match log reads top to bottom (oldest first), so the latest entry sits at the bottom of the scroller.
// Live feed: a new event follows the viewer down only when they are at (or within STICK_PX of) the bottom; a viewer who
// scrolled up to read history is left alone and gets a "New events" pill instead. The first rows of a live log land at
// the bottom (latest). A finished game opens at the top (the start of the match).
import { nextTick, onBeforeUnmount, ref, watch, type Ref } from "vue";

export const STICK_PX = 80;

export const nearBottom = (el: Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">, px = STICK_PX): boolean => el.scrollHeight - el.scrollTop - el.clientHeight <= px;

const reducedMotion = (): boolean => { try { return !!globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

/** Scroll to the latest entry: smooth, or instant under reduced motion / when asked. */
export function scrollToLatest(el: HTMLElement, smooth = true): void {
  const top = el.scrollHeight;
  if (smooth && !reducedMotion() && typeof el.scrollTo === "function") el.scrollTo({ top, behavior: "smooth" });
  else el.scrollTop = top;
}

/** Follow-the-bottom behaviour for a live log. `ids` is the row ids in display order (oldest first); pass effective rows only, so toggling removed rows changes nothing. */
export function useStickToBottom(scroller: Ref<HTMLElement | null>, ids: () => string[]): { unseen: Ref<boolean>; onScroll: () => void; toLatest: () => void } {
  const unseen = ref(false);
  let seen: Set<string> | null = null;
  let stopped = false;
  watch(ids, (list) => {
    const el = scroller.value;
    if (seen === null) {
      if (!list.length) return;
      seen = new Set(list);
      void nextTick(() => { if (!stopped && scroller.value) scrollToLatest(scroller.value, false); });
      return;
    }
    // only ids after the latest one already seen are new: revealing older (removed) rows never counts
    const known = seen;
    let from = -1;
    for (let i = list.length - 1; i >= 0 && from < 0; i--) if (known.has(list[i]!)) from = i;
    const fresh = list.slice(from + 1).filter((id) => !known.has(id));
    list.forEach((id) => known.add(id));
    if (!fresh.length || !el) return;
    if (nearBottom(el)) void nextTick(() => { if (!stopped && scroller.value) scrollToLatest(scroller.value); });
    else unseen.value = true;
  }, { immediate: true });
  const onScroll = (): void => { const el = scroller.value; if (el && unseen.value && nearBottom(el)) unseen.value = false; };
  const toLatest = (): void => { unseen.value = false; if (scroller.value) scrollToLatest(scroller.value); };
  onBeforeUnmount(() => { stopped = true; });
  return { unseen, onScroll, toLatest };
}
