// The Hireable players list shows four position cards at a time: its max-height is the bottom of the 4th card. Cards differ
// in height and change when fonts or sprites load late or wrap, so the height is re-measured from the cards themselves.

/** Height of the first four cards (top of the first to bottom of the fourth), or undefined when there are four or fewer. */
export function fourCardHeight(kids: ArrayLike<{ offsetTop: number; offsetHeight: number }>): number | undefined {
  if (kids.length <= 4) return undefined;
  const first = kids[0]!;
  const four = kids[3]!;
  return four.offsetTop - first.offsetTop + four.offsetHeight;
}

/** Calls `measure` whenever the first four cards resize, an image inside the list loads, or fonts finish loading; call the
 *  result to disconnect. `rewatch()` re-attaches the card observers (after the card set changes). */
export function watchFourCards(list: HTMLElement, measure: () => void): { rewatch: () => void; stop: () => void } {
  let ro: ResizeObserver | null = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => measure()) : null;
  let stopped = false;
  const rewatch = (): void => {
    if (!ro) return;
    ro.disconnect();
    for (const k of Array.from(list.children).slice(0, 4)) ro.observe(k);
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
