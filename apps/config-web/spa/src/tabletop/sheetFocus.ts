// Shared focus management for the recorder's popups (.tt-modal / .tt-sheet, the phone's bottom sheets): while one is open the
// page behind it is inert (no focus, no taps, no screen-reader reach) and its scroll is locked; focus moves into the topmost sheet,
// Tab wraps inside it, and when the last sheet closes focus returns to whatever opened it. Escape and the X are the sheets' own
// (TabletopSheetHead); this only manages focus and the background.

const SHEET = ".tt-sheet, .tt-modal";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SheetFocus { sync: () => void; detach: () => void }

/** Watches `root` for sheets opening and closing. `sync` can also be called directly (tests, or after a state change). */
export function createSheetFocus(root: HTMLElement): SheetFocus {
  const doc = root.ownerDocument;
  let seq = 0;
  let opener: HTMLElement | null = null;
  let active = false;
  let lastTop: HTMLElement | null = null;

  const sheets = (): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(SHEET)).filter((el) => !el.parentElement?.closest(SHEET));
  const seqOf = (el: HTMLElement): number => {
    if (!el.dataset.ttSheetSeq) el.dataset.ttSheetSeq = String(++seq);
    return Number(el.dataset.ttSheetSeq);
  };
  const focusables = (top: HTMLElement): HTMLElement[] => Array.from(top.querySelectorAll<HTMLElement>(FOCUSABLE));

  function setInert(el: Element, on: boolean): void {
    if (on) el.setAttribute("inert", "");
    else el.removeAttribute("inert");
  }

  function sync(): void {
    const open = sheets();
    if (!open.length) {
      if (!active) return;
      active = false;
      lastTop = null;
      for (const child of Array.from(root.children)) setInert(child, false);
      root.removeAttribute("data-sheet-open");
      const back = opener;
      opener = null;
      if (back && back.isConnected) back.focus({ preventScroll: true });
      return;
    }
    open.forEach(seqOf); // stamp unseen sheets in DOM order before comparing
    const top = open.reduce((a, b) => (seqOf(b) > seqOf(a) ? b : a));
    if (!active) {
      active = true;
      const ae = doc.activeElement as HTMLElement | null;
      opener = ae && ae !== doc.body && root.contains(ae) ? ae : null;
      root.setAttribute("data-sheet-open", "true");
    }
    // everything but the top sheet is inert: the page behind, and any sheet underneath
    for (const child of Array.from(root.children)) setInert(child, child !== top && !child.contains(top));
    for (const s of open) { if (s !== top) setInert(s, true); }
    setInert(top, false);
    top.setAttribute("aria-modal", "true");
    if (!top.hasAttribute("tabindex")) top.setAttribute("tabindex", "-1");
    if (top !== lastTop) {
      lastTop = top;
      const first = focusables(top).find((el) => !el.classList.contains("tt-x")) ?? focusables(top)[0];
      (first ?? top).focus({ preventScroll: true });
      if (doc.activeElement === doc.body) top.focus({ preventScroll: true });
    }
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Tab" || !active || !lastTop) return;
    const list = focusables(lastTop);
    if (!list.length) { e.preventDefault(); lastTop.focus({ preventScroll: true }); return; }
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const ae = doc.activeElement as HTMLElement | null;
    if (!ae || !lastTop.contains(ae)) { e.preventDefault(); first.focus({ preventScroll: true }); }
    else if (e.shiftKey && (ae === first || ae === lastTop)) { e.preventDefault(); last.focus({ preventScroll: true }); }
    else if (!e.shiftKey && ae === last) { e.preventDefault(); first.focus({ preventScroll: true }); }
  }

  doc.addEventListener("keydown", onKey, true);
  const view = doc.defaultView;
  const mo = view && "MutationObserver" in view ? new view.MutationObserver(() => sync()) : null;
  mo?.observe(root, { childList: true, subtree: true });
  sync();
  return {
    sync,
    detach: () => {
      mo?.disconnect();
      doc.removeEventListener("keydown", onKey, true);
      for (const child of Array.from(root.children)) setInert(child, false);
      root.removeAttribute("data-sheet-open");
    },
  };
}
