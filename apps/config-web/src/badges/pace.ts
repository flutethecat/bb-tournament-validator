/**
 * Cooperative pacing for the badge pass (badges lane review 11-04, P2-2): long loops call `await pace.tick()` between items;
 * once the slice has run for `budgetMs` it yields to the event loop (setImmediate), so a full-history pass never blocks
 * request handling for more than about one slice at a time.
 */
export interface Pacer { tick(): Promise<void> }

export const BADGE_SLICE_MS = 40;

export function createPacer(budgetMs = BADGE_SLICE_MS, clock: () => number = () => performance.now()): Pacer {
  let since = clock();
  return {
    async tick() {
      if (clock() - since < budgetMs) return;
      await new Promise<void>((r) => setImmediate(r));
      since = clock();
    },
  };
}

/** A pacer that never yields (pure callers and tests that want a synchronous-feeling pass). */
export const noPace: Pacer = { tick: async () => undefined };
