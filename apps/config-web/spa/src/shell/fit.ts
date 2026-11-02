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

/** Every node under (and including) root whose scrollTop is not 0. */
function scrolledNodes(root: ScrollNode, out: ScrollNode[] = []): ScrollNode[] {
  if (root.scrollTop) out.push(root);
  for (const child of Array.from(root.children)) scrolledNodes(child, out);
  return out;
}

/**
 * The key of a history entry: a random id kept in the entry's own state (vue-router's position number is reused once
 * the user goes Back and then navigates somewhere new, so it would hand one page's offsets to another). `state` is the
 * router's live state object for the current entry (mutating it keeps the id through vue-router's own replaceState
 * calls); `persist` writes it into the browser's entry now.
 */
export function entryKey(state: Record<string, unknown> | null | undefined, persist: (key: string) => void, random: () => string): string | undefined {
  if (!state) return undefined;
  if (typeof state.sfPane !== "string") {
    state.sfPane = random();
    persist(state.sfPane as string);
  }
  return state.sfPane as string;
}

export interface PaneScrollDeps {
  /** The content area (null while the shell is not mounted). */
  root(): ScrollNode | null;
  /** The current history entry's unique key (entryKey); undefined = nothing to remember. */
  entry(): string | undefined;
  /** The current history entry's position (vue-router's history.state.position), to drop forward entries on a push. */
  position(): number | undefined;
  wait(ms: number): Promise<void>;
}

export interface PaneScrollMemory {
  /** A scroll event's target: remembered for the current entry unless a navigation is under way. */
  record(target: unknown): void;
  /** A navigation started: stop recording (the outgoing page's teardown would overwrite the entry it lands on). */
  pause(): void;
  /** A new page (no restore): record again. */
  resume(): void;
  /** A push landed: the entries that were forward of it can never come back, so forget them. */
  pushed(): void;
  /** The user scrolled, wheeled, touched or pressed a key: stop a pending restore and record again. */
  userActed(): void;
  /**
   * Back / Forward landed: put the entry's offsets back, and put every other scrolled pane (and the content area) at 0,
   * which is also what an entry that was never scrolled restores. Resolves true when it finished, false when cancelled.
   */
  restore(opts?: { tries?: number; delay?: number }): Promise<boolean>;
}

const MAX_ENTRIES = 100;

export function createPaneScrollMemory(deps: PaneScrollDeps): PaneScrollMemory {
  const entries = new Map<string, { position: number | undefined; offsets: Map<string, number> }>();
  let paused = false;
  let generation = 0;
  /** While a restore runs: the offsets it has set, to tell its own scroll events from the user's. */
  let applied: Map<ScrollNode, number> | null = null;
  const cancel = () => { generation += 1; applied = null; paused = false; };
  const memory: PaneScrollMemory = {
    record(target) {
      if (!target || typeof (target as ScrollNode).scrollTop !== "number") return;
      const node = target as ScrollNode;
      // a pane the restore already set has moved away from that offset: the user is scrolling, so stop restoring
      if (applied?.has(node) && Math.abs(applied.get(node)! - node.scrollTop) > 1) cancel();
      if (paused) return;
      const root = deps.root();
      const key = deps.entry();
      if (!root || key === undefined) return;
      const path = nodePath(node, root);
      if (!path) return;
      let saved = entries.get(key);
      if (!saved) {
        saved = { position: deps.position(), offsets: new Map() };
        entries.set(key, saved);
        if (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      }
      saved.offsets.set(path.join("/"), node.scrollTop);
    },
    pause() { generation += 1; applied = null; paused = true; },
    resume() { paused = false; },
    pushed() {
      const at = deps.position();
      const key = deps.entry();
      if (at === undefined) return;
      for (const [k, e] of entries) if (k !== key && e.position !== undefined && e.position >= at) entries.delete(k);
    },
    userActed() { if (applied) cancel(); },
    async restore(opts = {}) {
      const mine = ++generation;
      paused = true;
      applied = new Map();
      const key = deps.entry();
      const saved = key === undefined ? undefined : entries.get(key)?.offsets;
      const tries = opts.tries ?? 20;
      try {
        // everything not recorded for this entry goes back to the top (a never-scrolled entry restores all zeros)
        const root0 = deps.root();
        if (root0) for (const node of scrolledNodes(root0)) {
          const path = nodePath(node, root0)!.join("/");
          if (!saved?.has(path)) { node.scrollTop = 0; applied.set(node, 0); }
        }
        let pending = [...(saved ?? [])];
        for (let i = 0; i < tries && pending.length; i++) {
          if (mine !== generation) return false; // the user scrolled or a newer navigation took over
          const root = deps.root();
          const last = i === tries - 1;
          pending = pending.filter(([path, top]) => {
            const el = root && nodeAt(root, path ? path.split("/").map(Number) : []);
            if (!el) return !last;
            if (el.scrollHeight - el.clientHeight < top && !last) return true; // not tall enough yet: the page is still filling in
            el.scrollTop = top;
            applied?.set(el, top);
            return false;
          });
          if (pending.length) await deps.wait(opts.delay ?? 100);
        }
        return mine === generation;
      } finally {
        if (mine === generation) { paused = false; applied = null; }
      }
    },
  };
  return memory;
}

// ---- Hash links (Sol review 11-02): reveal the target in its pane now, and again after 250 and 800 ms unless it already
// sits in view (panels above it grow as their data arrives). The next navigation cancels the pending retries, so they
// never move the next page.
export interface HashRevealDeps {
  find(id: string): unknown;
  top(el: unknown): number;
  viewport(): number;
  reveal(el: unknown): void;
  later(fn: () => void, ms: number): unknown;
  cancel(timer: unknown): void;
}

export function createHashReveal(deps: HashRevealDeps): { reveal(id: string): void; cancel(): void } {
  let timers: unknown[] = [];
  let generation = 0;
  const cancel = () => { generation += 1; for (const t of timers) deps.cancel(t); timers = []; };
  return {
    cancel,
    reveal(id) {
      cancel();
      if (!id) return;
      const mine = generation;
      const once = (force: boolean) => {
        if (mine !== generation) return;
        const el = deps.find(id);
        if (!el) return;
        const top = deps.top(el);
        if (force || top < 48 || top > deps.viewport() - 120) deps.reveal(el);
      };
      once(true);
      timers = [250, 800].map((ms) => deps.later(() => once(false), ms));
    },
  };
}
