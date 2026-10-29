// Hash scroll after an async load. The router's scrollBehavior ({ el: hash, top: 72 }) runs when the route resolves,
// before a data page has rendered its sections, and never retries; a link like /tournaments/t1#tn-entry-h (the list's
// Register / Your entry) would land at the top. The page calls this once its load settles: wait a tick for the render,
// then scroll the target clear of the top bar, retrying briefly while it has not appeared yet (bounded, fails quiet).

export interface HashScrollDeps {
  find(id: string): { getBoundingClientRect(): { top: number } } | null;
  scrollTo(top: number): void;
  scrollY(): number;
  tick(): Promise<void>;
  wait(ms: number): Promise<void>;
}

/** The router's offset for hash targets (router.ts scrollBehavior). */
export const HASH_SCROLL_OFFSET = 72;

/** Resolves true once it scrolled to the hash target, false when there is no hash or it never appeared. */
export async function scrollToHashAfter(ready: Promise<unknown>, hash: string, deps: HashScrollDeps, opts: { tries?: number; delay?: number } = {}): Promise<boolean> {
  try { await ready; } catch { /* the page shows its own error; still try the hash */ }
  const id = hashId(hash);
  if (!id) return false;
  const tries = opts.tries ?? 10;
  await deps.tick();
  for (let i = 0; i < tries; i++) {
    const el = deps.find(id);
    if (el) {
      deps.scrollTo(Math.max(0, el.getBoundingClientRect().top + deps.scrollY() - HASH_SCROLL_OFFSET));
      return true;
    }
    if (i < tries - 1) await deps.wait(opts.delay ?? 100);
  }
  return false;
}

/** "#tn-entry-h" -> "tn-entry-h"; "" for no hash or an undecodable one. */
export function hashId(hash: string): string {
  if (!hash || hash === "#") return "";
  try { return decodeURIComponent(hash.replace(/^#/, "")); } catch { return ""; }
}

/** The browser deps (window / document); null during SSR. */
export function browserHashScroll(tick: () => Promise<void>): HashScrollDeps | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  return {
    find: (id) => document.getElementById(id),
    scrollTo: (top) => window.scrollTo({ top }),
    scrollY: () => window.scrollY,
    tick,
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
