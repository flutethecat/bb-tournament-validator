/**
 * Fixture lobby presence (memory only, never written): a signed-in coach's heartbeat POST marks them here for
 * ONLINE_MS. Reads never mark anyone (GETs never change state). Bounded: at most MAX_LOBBIES lobbies, oldest dropped.
 */
export const HEARTBEAT_MS = 20_000;
export const ONLINE_MS = 45_000;
const MAX_LOBBIES = 5_000;

export class LobbyPresence {
  private readonly seen = new Map<string, Map<string, number>>();
  constructor(private readonly now: () => number = Date.now) {}

  beat(key: string, coach: string): void {
    const k = coach.trim().toLowerCase();
    if (!k) return;
    let m = this.seen.get(key);
    if (!m) {
      if (this.seen.size >= MAX_LOBBIES) this.sweep();
      m = new Map();
      this.seen.set(key, m);
    }
    m.set(k, this.now());
  }

  online(key: string, coach: string | undefined): boolean {
    const k = coach?.trim().toLowerCase();
    const at = k ? this.seen.get(key)?.get(k) : undefined;
    return at !== undefined && this.now() - at < ONLINE_MS;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, m] of this.seen) {
      for (const [c, at] of m) if (t - at >= ONLINE_MS) m.delete(c);
      if (!m.size) this.seen.delete(key);
    }
    while (this.seen.size >= MAX_LOBBIES) this.seen.delete(this.seen.keys().next().value!);
  }
}
