// The inducement picker's cart (no DOM, unit-tested). Either phone at the table may submit for either team, so the
// server's last submission can change under a cart. Rules:
//   - the cart starts from the team's last submission;
//   - a new submission from the server replaces the cart when the cart has no unsaved edits;
//   - with unsaved edits the cart is kept, and `remote` holds the newer submission until the coach reloads it
//     (the picker shows "picks changed on the other phone" and will not resubmit the stale cart meanwhile);
//   - polls that bring the same submission change nothing, so a draft survives them.

import { reactive } from "vue";

export type PickList = ReadonlyArray<{ id: string; qty: number }>;
export type Picks = Record<string, number>;

const toPicks = (list: PickList | undefined): Picks =>
  Object.fromEntries((list ?? []).filter((x) => x && typeof x.id === "string" && Number(x.qty) > 0).map((x) => [x.id, Number(x.qty)]));
/** A stable key for a set of picks (zero quantities ignored, order ignored). */
export const picksKey = (p: Picks | PickList | undefined): string => {
  const picks = Array.isArray(p) ? toPicks(p as PickList) : ((p ?? {}) as Picks);
  return Object.entries(picks).filter(([, q]) => q > 0).map(([id, q]) => `${id}:${q}`).sort().join(",");
};

export function createCartSync(initial: PickList | undefined) {
  const state = reactive({ picks: toPicks(initial) as Picks, base: picksKey(initial), remote: null as Picks | null });
  const dirty = (): boolean => picksKey(state.picks) !== state.base;
  return {
    state,
    dirty,
    /** Feed the server's latest submission for this team (every poll; unchanged ones are ignored). */
    server(list: PickList | undefined): void {
      const k = picksKey(list);
      if (k === state.base) { state.remote = null; return; }
      if (picksKey(state.picks) === k) { state.base = k; state.remote = null; return; } // our own submission came back
      if (!dirty()) { state.picks = toPicks(list); state.base = k; state.remote = null; return; }
      state.remote = toPicks(list);
    },
    /** Throw the local draft away and take the newer submission. */
    reload(): void {
      if (!state.remote) return;
      state.picks = { ...state.remote };
      state.base = picksKey(state.remote);
      state.remote = null;
    },
  };
}
