// Fit to 1920x1080 (owner 11-02, laws 18a): on a desktop screen the shell is one viewport tall and the content area and
// its panes scroll instead of the document (home.css "Fit to 1920x1080"). FIT_QUERY mirrors that media query; scrolling
// code that used to move the window asks fitMode() and scrolls the target's own pane instead.

export const FIT_QUERY = "(min-width: 1367px) and (min-height: 700px)";

/** True in the browser when the fitted desktop shell is active (false during a server render). */
export function fitMode(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(FIT_QUERY).matches;
}

/** The content area (the shell's main), which scrolls a page that has not opted into panes. */
export function contentArea(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>(".sf-body > .shell-main");
}

/** Brings `el` to the top of every pane that holds it (its scroll-margin-top keeps a small gap). */
export function revealInPane(el: Element, smooth = false): void {
  el.scrollIntoView?.({ block: "start", behavior: smooth ? "smooth" : "auto" });
}
