// The Roster pane's roster list (owner 10-31). In the three-column layout the list is its own scroller, as tall as the
// viewport below the panel header (so the page never scrolls to reach its bottom); stacked (phone / narrow) it is not a
// nested scroller. A hire scrolls the newest row into view in whichever scroller holds it, smooth unless
// prefers-reduced-motion, and never moves focus. Dragging a row near the scroller's top or bottom edge auto-scrolls it.
export const REVEAL_FLASH_MS = 600;
export const WIDE_QUERY = "(min-width: 1180px)"; // the Roster pane's three-column breakpoint (builder.css)
export const ROSTER_MIN_PX = 320;
export const EDGE_ZONE_PX = 48;
export const EDGE_MAX_STEP_PX = 16;

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
export function wideLayout(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(WIDE_QUERY).matches;
}

type Box = { offsetTop: number; offsetHeight: number };
type Scroller = Box & { scrollTop: number; clientHeight: number; scrollHeight: number; scrollTo?: (o: ScrollToOptions) => void };

/** The scrollTop that shows the whole row in the scroller (rows' offsetTop is relative to the scroller), or null when it
 *  already shows. A row taller than the box aligns its top. */
export function revealTop(row: Box, box: Scroller): number | null {
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  if (top < box.scrollTop || row.offsetHeight > box.clientHeight) return top;
  if (bottom > box.scrollTop + box.clientHeight) return bottom - box.clientHeight;
  return null;
}

/** Scroll the row into view: inside `scroller` when it scrolls (overflowing), else the page (nearest block). */
export function revealRow(row: (Box & { scrollIntoView?: (o: ScrollIntoViewOptions) => void }) | null, scroller: Scroller | null = null, reduced = prefersReducedMotion()): void {
  if (!row) return;
  const behavior: ScrollBehavior = reduced ? "auto" : "smooth";
  if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
    const top = revealTop(row, scroller);
    if (top !== null) scroller.scrollTo?.({ top, behavior });
    return;
  }
  row.scrollIntoView?.({ block: "nearest", behavior });
}

/** Height for the roster scroller: from its top (page at rest) to the viewport bottom, less what sits under it (the
 *  counts and the skill key) and a margin; never under ROSTER_MIN_PX. */
export function rosterHeight(viewport: number, topAtRest: number, below: number, margin = 16): number {
  return Math.max(ROSTER_MIN_PX, Math.floor(viewport - topAtRest - below - margin));
}

/** Auto-scroll step while dragging: negative near the top edge, positive near the bottom, 0 elsewhere; faster closer in. */
export function edgeStep(y: number, top: number, bottom: number, zone = EDGE_ZONE_PX, max = EDGE_MAX_STEP_PX): number {
  if (y < top + zone) return -Math.ceil(max * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.ceil(max * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}
