import { describe, expect, it } from "vitest";
import { isReplayPending, REPLAY_POLL_MAX, REPLAY_POLL_MS, startReplayPoll } from "../spa/src/games/replayPoll";
import type { GameDetail } from "../spa/src/games/detail";

// The game page's poll while an online game's turn order is still being read (spa/src/games/replayPoll.ts): every 10 s,
// at most ~5 minutes, stopping when the answer is no longer pending or the tab is hidden.

const game = (replay: GameDetail["replay"]) => ({ source: "online", id: "999", replay }) as GameDetail;

/** Manual timers: run() fires the pending one. */
function clock() {
  let next: { fn: () => void; ms: number } | undefined;
  return {
    setTimer: (fn: () => void, ms: number) => { next = { fn, ms }; return 1; },
    clearTimer: () => { next = undefined; },
    async run() { const n = next; next = undefined; n?.fn(); await new Promise((r) => setTimeout(r, 0)); },
    get armed() { return next?.ms; },
  };
}
function doc(state: "visible" | "hidden" = "visible") {
  const listeners = new Set<() => void>();
  return {
    visibilityState: state as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
    hide() { this.visibilityState = "hidden"; for (const l of [...listeners]) l(); },
    get listeners() { return listeners.size; },
  };
}

describe("replay poll", () => {
  it("polls every 10 s while pending and swaps in the ordered answer, then stops", async () => {
    expect(REPLAY_POLL_MS).toBe(10_000);
    expect(REPLAY_POLL_MAX * REPLAY_POLL_MS).toBe(300_000);
    const c = clock();
    const d = doc();
    const answers = [game("pending"), game("ready")];
    const seen: GameDetail[] = [];
    startReplayPoll({ load: async () => answers.shift(), onGame: (g) => seen.push(g), setTimer: c.setTimer, clearTimer: c.clearTimer, doc: d as never });
    expect(c.armed).toBe(10_000);
    await c.run();
    expect(seen.map((g) => g.replay)).toEqual(["pending"]);
    expect(c.armed).toBe(10_000);
    await c.run();
    expect(seen.map((g) => g.replay)).toEqual(["pending", "ready"]);
    expect(c.armed).toBeUndefined();
    expect(d.listeners).toBe(0);
  });

  it("gives up after maxPolls; failed reads count and keep polling", async () => {
    const c = clock();
    let loads = 0;
    startReplayPoll({ load: async () => { loads += 1; if (loads === 1) throw new Error("offline"); return game("pending"); }, onGame: () => {}, maxPolls: 3, setTimer: c.setTimer, clearTimer: c.clearTimer });
    for (let i = 0; i < 5; i++) await c.run();
    expect(loads).toBe(3);
    expect(c.armed).toBeUndefined();
  });

  it("stops when the tab is hidden, never starts in a hidden tab, and the stop function cancels it", async () => {
    const c = clock();
    const d = doc();
    startReplayPoll({ load: async () => game("pending"), onGame: () => {}, setTimer: c.setTimer, clearTimer: c.clearTimer, doc: d as never });
    d.hide();
    expect(c.armed).toBeUndefined();
    const c2 = clock();
    startReplayPoll({ load: async () => game("pending"), onGame: () => {}, setTimer: c2.setTimer, clearTimer: c2.clearTimer, doc: doc("hidden") as never });
    expect(c2.armed).toBeUndefined();
    const c3 = clock();
    const stop = startReplayPoll({ load: async () => game("pending"), onGame: () => {}, setTimer: c3.setTimer, clearTimer: c3.clearTimer });
    stop();
    expect(c3.armed).toBeUndefined();
  });

  it("isReplayPending: online and pending only", () => {
    expect(isReplayPending(game("pending"))).toBe(true);
    expect(isReplayPending(game("ready"))).toBe(false);
    expect(isReplayPending({ ...game("pending"), source: "tabletop" } as GameDetail)).toBe(false);
    expect(isReplayPending(null)).toBe(false);
  });
});
