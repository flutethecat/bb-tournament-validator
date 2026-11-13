// The left accordion's panels show at most ROW_WINDOW rows (cards / lines) at a time and scroll beyond that (owner 10-31:
// "rows are 5 in a line"): a list's max-height is the bottom of its Nth row. Rows differ in height and change when fonts or
// sprites load late or wrap, so the height is re-measured from the rows themselves.
import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref, type WatchSource } from "vue";

export const ROW_WINDOW = 5;
/** Card lists (Hireable players, Star Players) show three cards at a time (owner 11-13); the short stepper rows keep five. */
export const CARD_WINDOW = 3;

/** Height of the first `n` rows (top of the first to bottom of the nth), or undefined when there are `n` or fewer. */
export function rowWindowHeight(kids: ArrayLike<{ offsetTop: number; offsetHeight: number }>, n = ROW_WINDOW): number | undefined {
  if (kids.length <= n) return undefined;
  const first = kids[0]!;
  const last = kids[n - 1]!;
  return last.offsetTop - first.offsetTop + last.offsetHeight;
}

/** Calls `measure` whenever the first `n` rows resize, an image inside the list loads, or fonts finish loading. `rewatch()`
 *  re-attaches the row observers (after the row set changes); `stop()` disconnects. */
export function watchRowWindow(list: HTMLElement, measure: () => void, n = ROW_WINDOW): { rewatch: () => void; stop: () => void } {
  let ro: ResizeObserver | null = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
  let stopped = false;
  const rewatch = (): void => {
    if (!ro) return;
    ro.disconnect();
    for (const k of Array.from(list.children).slice(0, n)) ro.observe(k);
    ro.observe(list);
  };
  const onLoad = (): void => measure();
  list.addEventListener("load", onLoad, true); // image load events do not bubble: capture them
  void (typeof document !== "undefined" ? document.fonts?.ready : undefined)?.then(() => { if (!stopped) measure(); });
  rewatch();
  return {
    rewatch,
    stop: () => { stopped = true; ro?.disconnect(); ro = null; list.removeEventListener("load", onLoad, true); },
  };
}

/** A component's N-row window: bind `maxHeight` as the list's inline max-height. `rows` is what changes the row set (a new
 *  ruleset, race or selection); the list element may come and go (v-if). */
export function useRowWindow(list: Ref<HTMLElement | null>, rows: WatchSource<unknown>, n = ROW_WINDOW): { maxHeight: Ref<string | undefined> } {
  const maxHeight = ref<string | undefined>(undefined);
  let watcher: ReturnType<typeof watchRowWindow> | null = null;
  let watched: HTMLElement | null = null;
  function measure(): void {
    const el = list.value;
    const h = el ? rowWindowHeight(Array.from(el.children) as HTMLElement[], n) : undefined;
    maxHeight.value = h === undefined ? undefined : `${h}px`;
  }
  function attach(): void {
    const el = list.value;
    if (el === watched) { watcher?.rewatch(); return; }
    watcher?.stop();
    watcher = el ? watchRowWindow(el, measure, n) : null;
    watched = el;
  }
  // Row heights follow the width: unset, then measure.
  function remeasure(): void { maxHeight.value = undefined; void nextTick(measure); }
  onMounted(() => {
    measure();
    attach();
    if (typeof window !== "undefined") window.addEventListener("resize", remeasure);
  });
  onBeforeUnmount(() => {
    watcher?.stop();
    watcher = null;
    watched = null;
    if (typeof window !== "undefined") window.removeEventListener("resize", remeasure);
  });
  watch(rows, () => void nextTick(() => { measure(); attach(); }), { deep: true });
  return { maxHeight };
}
