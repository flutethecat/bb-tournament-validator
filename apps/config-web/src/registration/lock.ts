// Per-competition mutation lock (registration spec §8.4 Sol hunt: "cap races between two simultaneous registrations").
// Every core action reads entries, decides and commits inside the lock for its competition, so two registrations at the
// last place can never both be accepted, and a waitlist promotion never runs twice. In-process: config-web is one Node
// process; the adapters' own stores keep their atomic file writes.

export class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  /** Run `fn` after every earlier holder of `key` finished (success or failure). */
  async run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = prev.then(() => gate);
    this.tails.set(key, tail);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** Keys currently held or queued (tests). */
  get size(): number {
    return this.tails.size;
  }
}

/** The process-wide lock every registration service shares by default (one lock per `<kind>:<id>`). */
export const registrationLocks = new KeyedLock();
