// The background job that fills the replay moments cache (store.ts). Never on an HTTP request path: the game page only
// reads the cache and says "pending" until the job has read the game.
//
//   triggers  a fork result stored in the results store (onResultStored, tournamentResults.ts), a sweep shortly after
//             startup and then every `intervalMs` (results imported by another process), newest games first;
//   pace      one replay at a time, `gapMs` between reads, each read bounded by the reader's own deadlines;
//   once      a game the fork answered is cached for good, ready or unavailable ("Replay Unavailable" for 1072);
//             a failed read (fork down, timeout) is retried by later sweeps, at most `maxFailures` times per process;
//   guard     a game is only replayed when the fork's finished list shows it as a started, two-team, non-test-mode game.
//             Replaying loads the game into the fork's game cache, and the fork deletes a cached test-mode game (or an
//             unstarted / one-team one) from its database when it evicts it (GameCache.removeGame): such games are
//             cached as unavailable instead, and never loaded.

import { adminList, parseAdminGameList, type ForkAdminConfig } from "@bb/fork-ops";
import type { ReplayReadResult } from "./reader.js";
import type { ReplayMomentStore } from "./store.js";

export interface ReplayGuard { testMode: boolean; started?: string; homeTeamId: string; awayTeamId: string }

/** The fork's finished + backuped games with what the guard needs (sequential: the admin servlet keeps one challenge). */
export async function finishedGameGuards(cfg: ForkAdminConfig): Promise<Map<string, ReplayGuard>> {
  const out = new Map<string, ReplayGuard>();
  for (const status of ["finished", "backuped"]) {
    const xml = await adminList(cfg, status);
    const testMode = new Map<string, boolean>();
    for (const m of xml.matchAll(/<game\b([^>]*)>/g)) {
      const id = /\bid="([^"]*)"/.exec(m[1]!)?.[1];
      if (id) testMode.set(id, /\btestMode="true"/.test(m[1]!));
    }
    for (const g of parseAdminGameList(xml)) {
      out.set(g.gameId, { testMode: testMode.get(g.gameId) ?? false, started: g.started, homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId });
    }
  }
  return out;
}

/** Why replaying this game could cost the fork its copy, or undefined when it is safe to load. */
export function unsafeReason(guard: ReplayGuard): string | undefined {
  if (guard.testMode) return "fork test-mode game: not replayed (the fork deletes a test-mode game it evicts after loading it)";
  if (!guard.homeTeamId || !guard.awayTeamId) return "one-team game: not replayed (the fork deletes it when it evicts it)";
  const started = guard.started?.trim();
  if (!started || /^1970-01-01/.test(started)) return "unstarted game: not replayed (the fork deletes it when it evicts it)";
  return undefined;
}

export interface ReplayJobRow { gameId: string; source?: string; playedAt?: string; pulledAt?: string }

export interface ReplayJobDeps {
  store: ReplayMomentStore;
  /** Every results-store row (test rows included: their own pages may read moments; ratings never see this cache). */
  rows: () => readonly ReplayJobRow[];
  guards: () => Promise<Map<string, ReplayGuard>>;
  read: (gameId: string) => Promise<ReplayReadResult>;
  gapMs?: number;
  guardTtlMs?: number;
  maxFailures?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export type ReplayStatus = "ready" | "pending" | "unavailable";

const isForkRow = (r: ReplayJobRow): boolean => (r.source === undefined || r.source === "fork") && /^[0-9]{1,18}$/.test(r.gameId);
const sleep = (ms: number): Promise<void> => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

export function createReplayJob(deps: ReplayJobDeps) {
  const gapMs = deps.gapMs ?? 20_000;
  const guardTtlMs = deps.guardTtlMs ?? 5 * 60_000;
  const maxFailures = deps.maxFailures ?? 3;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const queue: string[] = [];
  const queued = new Set<string>();
  const failures = new Map<string, number>();
  let guardCache: { at: number; map: Map<string, ReplayGuard> } | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;

  const gaveUp = (id: string): boolean => (failures.get(id) ?? 0) >= maxFailures;
  const fail = (id: string, why: string): void => {
    failures.set(id, (failures.get(id) ?? 0) + 1);
    log(`[replay] game ${id}: ${why} (attempt ${failures.get(id)}/${maxFailures})`);
  };

  async function guards(): Promise<Map<string, ReplayGuard>> {
    if (guardCache && now() - guardCache.at < guardTtlMs) return guardCache.map;
    const map = await deps.guards();
    if (map.size === 0) throw new Error("the fork's finished list came back empty");
    guardCache = { at: now(), map };
    return map;
  }

  async function processOne(id: string): Promise<void> {
    let guard: ReplayGuard | undefined;
    try {
      guard = (await guards()).get(id);
    } catch (e) {
      fail(id, `finished list unavailable: ${(e as Error).message}`);
      return;
    }
    if (!guard) {
      // an admin list can parse to [] under a concurrent challenge (another process): never cached from one miss
      guardCache = undefined;
      fail(id, "not in the fork's finished list");
      return;
    }
    const unsafe = unsafeReason(guard);
    if (unsafe) {
      deps.store.put({ gameId: id, status: "unavailable", readAt: new Date(now()).toISOString(), reason: unsafe });
      log(`[replay] game ${id}: ${unsafe}`);
      return;
    }
    let result: ReplayReadResult;
    try {
      result = await deps.read(id);
    } catch (e) {
      fail(id, (e as Error).message);
      return;
    }
    const readAt = new Date(now()).toISOString();
    if (result.status === "unavailable") {
      deps.store.put({ gameId: id, status: "unavailable", readAt, reason: result.reason });
      log(`[replay] game ${id}: ${result.reason}`);
      return;
    }
    const d = result.derivation;
    deps.store.put({ gameId: id, status: "ready", readAt, commands: d.commands, truncated: d.truncated, teams: d.teams, moments: d.moments });
    log(`[replay] game ${id}: ${d.moments.length} moments from ${d.commands} commands`);
  }

  async function drain(): Promise<void> {
    while (queue.length && !stopped) {
      const id = queue.shift()!;
      queued.delete(id);
      if (deps.store.has(id) || gaveUp(id)) continue;
      await processOne(id);
      if (queue.length && !stopped) await sleep(gapMs);
    }
  }

  function kick(): Promise<void> {
    running ??= drain().finally(() => { running = undefined; });
    return running;
  }

  return {
    /** Queue one game (a result just stored). */
    enqueue(gameId: string): void {
      const id = String(gameId);
      if (stopped || !/^[0-9]{1,18}$/.test(id) || queued.has(id) || deps.store.has(id) || gaveUp(id)) return;
      queue.push(id);
      queued.add(id);
      void kick();
    },
    /** Queue every fork row without a cached answer, newest first. */
    sweep(): number {
      if (stopped) return 0;
      let rows: readonly ReplayJobRow[] = [];
      try { rows = deps.rows(); } catch { return 0; }
      const when = (r: ReplayJobRow): number => Date.parse(r.playedAt ?? r.pulledAt ?? "") || 0;
      const todo = rows.filter((r) => isForkRow(r) && !queued.has(r.gameId) && !gaveUp(r.gameId) && !deps.store.has(r.gameId)).sort((a, b) => when(b) - when(a));
      for (const r of todo) { queue.push(r.gameId); queued.add(r.gameId); }
      if (todo.length) void kick();
      return todo.length;
    },
    /** What the game page says about this game's ordered log. */
    status(gameId: string): ReplayStatus {
      const entry = deps.store.get(gameId);
      if (entry) return entry.status;
      return stopped || gaveUp(gameId) ? "unavailable" : "pending";
    },
    /** Startup sweep after `initialDelayMs`, then one every `intervalMs`. */
    start(opts: { initialDelayMs?: number; intervalMs?: number } = {}): void {
      startTimer = setTimeout(() => this.sweep(), opts.initialDelayMs ?? 60_000);
      startTimer.unref?.();
      timer = setInterval(() => this.sweep(), opts.intervalMs ?? 15 * 60_000);
      timer.unref?.();
    },
    stop(): void {
      stopped = true;
      if (timer) clearInterval(timer);
      if (startTimer) clearTimeout(startTimer);
    },
    /** Resolves when the queue is drained (tests). */
    idle(): Promise<void> { return running ?? Promise.resolve(); },
    pending: () => queue.length,
  };
}

export type ReplayJob = ReturnType<typeof createReplayJob>;
