// Fit to 1920x1080 (owner 11-02, laws 18a): on a desktop screen the shell is one viewport tall and the content area and
// its panes scroll instead of the document (home.css "Fit to 1920x1080"). FIT_QUERY mirrors that media query; scrolling
// code that used to move the window asks fitMode() and scrolls the target's own pane instead.

export const FIT_QUERY = "screen and (min-width: 1367px) and (min-height: 700px)";

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

// ---- Back / Forward (Sol review 11-02): the window never scrolls in the fitted shell, so the router's saved window
// position is always 0. This memory keeps, per history entry, the scroll offset of the content area and of every pane
// that scrolled (addressed by its child-index path under the content area), and puts them back after Back / Forward
// once the page has rendered (data pages fill in late, so it retries briefly until each pane is tall enough).

/** The parts of an element the memory reads and writes (an HTMLElement in the browser; plain objects in tests). */
export interface ScrollNode {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly parentElement: ScrollNode | null;
  readonly children: ArrayLike<ScrollNode>;
}

/** Child-index path from `root` down to `el` ([] for root itself), or null when `el` is not inside root. */
export function nodePath(el: ScrollNode, root: ScrollNode): number[] | null {
  const path: number[] = [];
  let node: ScrollNode | null = el;
  while (node && node !== root) {
    const parent: ScrollNode | null = node.parentElement;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.children, node));
    node = parent;
  }
  return node === root ? path : null;
}

/** The node at a child-index path under root, or null when the page no longer has it. */
export function nodeAt(root: ScrollNode, path: readonly number[]): ScrollNode | null {
  let node: ScrollNode | undefined = root;
  for (const i of path) {
    node = node?.children[i];
    if (!node) return null;
  }
  return node ?? null;
}

export interface PaneScrollDeps {
  /** The content area (null while the shell is not mounted). */
  root(): ScrollNode | null;
  /** The current history entry's key (vue-router's history.state.position); undefined = nothing to remember. */
  entry(): unknown;
  wait(ms: number): Promise<void>;
}

export interface PaneScrollMemory {
  /** A scroll event's target: remembered for the current entry unless a navigation is under way. */
  record(target: unknown): void;
  /** A navigation started: stop recording (the outgoing page's teardown would overwrite the entry it lands on). */
  pause(): void;
  /** A new page (no restore): record again. */
  resume(): void;
  /** Back / Forward landed: put the entry's offsets back. Resolves true when it had something to restore. */
  restore(opts?: { tries?: number; delay?: number }): Promise<boolean>;
}

const MAX_ENTRIES = 100;

export function createPaneScrollMemory(deps: PaneScrollDeps): PaneScrollMemory {
  const entries = new Map<unknown, Map<string, number>>();
  let paused = false;
  let generation = 0;
  return {
    record(target) {
      if (paused || !target || typeof (target as ScrollNode).scrollTop !== "number") return;
      const root = deps.root();
      const key = deps.entry();
      if (!root || key === undefined || key === null) return;
      const path = nodePath(target as ScrollNode, root);
      if (!path) return;
      let saved = entries.get(key);
      if (!saved) {
        saved = new Map();
        entries.set(key, saved);
        if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
      }
      saved.set(path.join("/"), (target as ScrollNode).scrollTop);
    },
    pause() { paused = true; generation += 1; },
    resume() { paused = false; },
    async restore(opts = {}) {
      const mine = ++generation;
      paused = true;
      const saved = entries.get(deps.entry());
      const tries = opts.tries ?? 20;
      try {
        if (!saved || !saved.size) return false;
        let pending = [...saved];
        for (let i = 0; i < tries && pending.length; i++) {
          if (mine !== generation) return false; // a newer navigation took over
          const root = deps.root();
          const last = i === tries - 1;
          pending = pending.filter(([key, top]) => {
            const el = root && nodeAt(root, key ? key.split("/").map(Number) : []);
            if (!el) return !last;
            if (el.scrollHeight - el.clientHeight < top && !last) return true; // not tall enough yet: the page is still filling in
            el.scrollTop = top;
            return false;
          });
          if (pending.length) await deps.wait(opts.delay ?? 100);
        }
        return true;
      } finally {
        if (mine === generation) paused = false;
      }
    },
  };
}
