// Offline-tolerant event queue for the tabletop recorder (pure: no DOM, injected storage / send / timers).
// Events get a client uuid, wait in the browser (localStorage, in-memory fallback) and are posted in batches of at
// most 100. A network or 5xx failure retries with backoff; the server de-duplicates by id, so a re-send is safe.
// A 400/409 refusal is isolated to the one event the server refused (it moves to `rejected`, with the server's words).

import { ApiError } from "../shared/api";

export interface WireEvent {
  id: string;
  type: string;
  team: "home" | "away";
  player?: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface QueueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SendResult { accepted: string[]; duplicates: string[]; total: number }
export interface RejectedEvent { event: WireEvent; error: string }

export const BATCH_SIZE = 100;
export const BACKOFF_BASE_MS = 2000;
export const BACKOFF_MAX_MS = 60_000;

/** 2 s, 4 s, 8 s ... capped at 60 s. `attempt` counts failures so far (1 = the first failure). */
export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));

export function newEventId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  let s = "";
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
  return `ev-${s}`;
}

export function memoryStorage(): QueueStorage {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** localStorage when it works, the in-memory fallback otherwise (private window, blocked site data, SSR). */
export function browserStorage(): QueueStorage {
  const fallback = memoryStorage();
  let ls: Storage | undefined;
  try {
    ls = (globalThis as { localStorage?: Storage }).localStorage;
    ls?.setItem("tabletop-probe", "1");
    ls?.removeItem("tabletop-probe");
  } catch { ls = undefined; }
  if (!ls) return fallback;
  const real = ls;
  return {
    getItem: (k) => { try { return real.getItem(k); } catch { return fallback.getItem(k); } },
    setItem: (k, v) => { try { real.setItem(k, v); } catch { fallback.setItem(k, v); } },
    removeItem: (k) => { try { real.removeItem(k); } catch { fallback.removeItem(k); } },
  };
}

export interface QueueDeps {
  matchId: string;
  storage: QueueStorage;
  send: (events: WireEvent[]) => Promise<SendResult>;
  /** Called after every change (pending count, status). */
  onChange?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  now?: () => number;
}

const refused = (err: unknown): boolean => err instanceof ApiError && (err.status === 400 || err.status === 409);

export function createEventQueue(deps: QueueDeps) {
  const key = `tabletop-queue:${deps.matchId}`;
  const setT = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = deps.now ?? (() => Date.now());

  const load = (): WireEvent[] => {
    try {
      const raw = deps.storage.getItem(key);
      const v = raw ? (JSON.parse(raw) as unknown) : [];
      return Array.isArray(v) ? (v as WireEvent[]).filter((e) => e && typeof e.id === "string") : [];
    } catch { return []; }
  };
  let events: WireEvent[] = load();
  const rejected: RejectedEvent[] = [];
  const status = { attempts: 0, nextRetryAt: 0, lastError: "", halted: false, sending: false };
  let timer: unknown;
  let stopped = false;

  const save = (): void => {
    try {
      if (events.length) deps.storage.setItem(key, JSON.stringify(events));
      else deps.storage.removeItem(key);
    } catch { /* the in-memory list stays authoritative */ }
    deps.onChange?.();
  };

  const remove = (ids: readonly string[]): void => {
    const set = new Set(ids);
    events = events.filter((e) => !set.has(e.id));
  };

  const schedule = (): void => {
    if (timer !== undefined) clearT(timer);
    timer = undefined;
    if (stopped || status.halted || !events.length || status.attempts === 0) return;
    const wait = backoffMs(status.attempts);
    status.nextRetryAt = now() + wait;
    timer = setT(() => { timer = undefined; void flush(); }, wait);
  };

  async function flush(): Promise<void> {
    if (status.sending || stopped) return;
    status.sending = true;
    status.halted = false;
    try {
      while (events.length) {
        const batch = events.slice(0, BATCH_SIZE);
        try {
          await deps.send(batch);
          remove(batch.map((e) => e.id));
          status.attempts = 0;
          status.lastError = "";
          save();
        } catch (err) {
          if (refused(err)) {
            if (batch.length > 1) {
              // The server refuses a whole batch for one bad event: send one at a time to find it.
              for (const e of batch) {
                try {
                  await deps.send([e]);
                } catch (one) {
                  if (refused(one)) rejected.push({ event: e, error: (one as Error).message });
                  else throw one;
                }
                remove([e.id]);
                save();
              }
            } else {
              rejected.push({ event: batch[0]!, error: (err as Error).message });
              remove([batch[0]!.id]);
              save();
            }
            status.attempts = 0;
            continue;
          }
          status.lastError = err instanceof Error ? err.message : "Can't reach the server.";
          const code = err instanceof ApiError ? err.status : 0;
          if (code === 401 || code === 403) { status.halted = true; return; }
          status.attempts += 1;
          return;
        }
      }
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : "Can't reach the server.";
      status.attempts += 1;
    } finally {
      status.sending = false;
      schedule();
      deps.onChange?.();
    }
  }

  return {
    status,
    rejected,
    pending: (): WireEvent[] => events.slice(),
    pendingCount: (): number => events.length,
    /** Adds an event; a repeated id is ignored (false). */
    enqueue(e: WireEvent): boolean {
      if (events.some((x) => x.id === e.id)) return false;
      events.push(e);
      save();
      return true;
    },
    /** Removes a not-yet-sent event (an undo of something still waiting needs no server round trip). */
    discard(id: string): boolean {
      const had = events.some((e) => e.id === id);
      if (had) { remove([id]); save(); }
      return had;
    },
    dismissRejected(id: string): void {
      const i = rejected.findIndex((r) => r.event.id === id);
      if (i >= 0) rejected.splice(i, 1);
      deps.onChange?.();
    },
    flush,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearT(timer);
      timer = undefined;
    },
  };
}

export type EventQueue = ReturnType<typeof createEventQueue>;
