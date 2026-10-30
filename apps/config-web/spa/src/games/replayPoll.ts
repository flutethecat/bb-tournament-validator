// Game page: an online game opened while its turn order is still being read from the game server (replay "pending")
// asks again every 10 s, for at most ~5 minutes, and stops as soon as the answer is no longer pending, the page goes
// away, or the tab is hidden. The caller swaps the new answer in (the ordered log replaces the grouped one).

import type { GameDetail } from "./detail";

export interface ReplayPollOptions {
  /** One fresh read of the game; undefined when the read failed (the poll keeps going until it runs out). */
  load: () => Promise<GameDetail | undefined>;
  /** A newer answer (ordered, unavailable, or still pending with fresher data). */
  onGame: (game: GameDetail) => void;
  intervalMs?: number;
  maxPolls?: number;
  /** The document whose visibility stops the poll (absent on the server). */
  doc?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const REPLAY_POLL_MS = 10_000;
export const REPLAY_POLL_MAX = 30;

export const isReplayPending = (g: GameDetail | null | undefined): boolean => !!g && g.source === "online" && g.replay === "pending";

/** Starts polling; returns the stop function. */
export function startReplayPoll(opts: ReplayPollOptions): () => void {
  const intervalMs = opts.intervalMs ?? REPLAY_POLL_MS;
  const maxPolls = opts.maxPolls ?? REPLAY_POLL_MAX;
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let polls = 0;
  let stopped = false;
  let handle: unknown;
  const onVisibility = (): void => { if (opts.doc?.visibilityState === "hidden") stop(); };
  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (handle !== undefined) clearTimer(handle);
    opts.doc?.removeEventListener("visibilitychange", onVisibility);
  }
  function schedule(): void {
    if (stopped || polls >= maxPolls) { stop(); return; }
    handle = setTimer(async () => {
      handle = undefined;
      if (stopped) return;
      polls += 1;
      let game: GameDetail | undefined;
      try { game = await opts.load(); } catch { game = undefined; }
      if (stopped) return;
      if (game) {
        opts.onGame(game);
        if (!isReplayPending(game)) { stop(); return; }
      }
      schedule();
    }, intervalMs);
  }
  if (opts.doc?.visibilityState === "hidden") { stopped = true; return () => {}; }
  opts.doc?.addEventListener("visibilitychange", onVisibility);
  schedule();
  return stop;
}
