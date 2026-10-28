// Visible-only polling: runs `fn` every `ms` while the page is visible; returns the stop function (call on unmount).

const pageVisible = (): boolean => typeof document === "undefined" || document.visibilityState === "visible";

export const POLL_MS = 30_000;

export function startPolling(fn: () => void | Promise<void>, ms = POLL_MS, visible: () => boolean = pageVisible): () => void {
  const timer = setInterval(() => { if (visible()) void fn(); }, ms);
  return () => clearInterval(timer);
}
