/**
 * Bounded, single-use nonce store for the site-backend's `xml:auth?op=challenge` (SR-142 TP-5).
 *
 * Every FUMBBL-mode write op the game server performs fetches a fresh challenge before it, so an
 * impersonating config-web serves `op=challenge` at write-op rate for anonymous callers. TP-5:
 * bound it BY CONSTRUCTION, not with a rate-limit —
 *   - ONE outstanding nonce per coach (a new challenge for a coach evicts that coach's prior one),
 *   - a TTL (an unconsumed nonce expires),
 *   - a HARD CAP on distinct coaches (LRU eviction past the cap),
 * so the store cannot grow without bound however the caller behaves. Nonces are single-use:
 * `consume` deletes on read, so a captured response can't be replayed.
 *
 * In-memory by design — challenges are ephemeral and per-process, exactly like the fork's own
 * single `fLastChallenge` slot in AdminServlet (this is strictly more forgiving: per-coach, not
 * one global slot). No persistence, no cross-process sharing needed.
 */

import { randomBytes } from "node:crypto";

export interface NonceStoreOptions {
  ttlMs?: number; // default 2 min — a challenge→response round-trip is sub-second
  maxCoaches?: number; // default 512 — hard cap on distinct outstanding coaches
  now?: () => number; // injectable clock for tests
}

interface Entry {
  nonce: string;
  expiresAt: number;
}

export class NonceStore {
  private readonly ttlMs: number;
  private readonly maxCoaches: number;
  private readonly now: () => number;
  /** coach(lowercased) → entry. Map iteration order = insertion order ⇒ oldest-first for LRU. */
  private readonly byCoach = new Map<string, Entry>();

  constructor(opts: NonceStoreOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.maxCoaches = Math.max(1, opts.maxCoaches ?? 512);
    this.now = opts.now ?? Date.now;
  }

  private key(coach: string): string {
    return coach.trim().toLowerCase();
  }

  /**
   * Mint a fresh single-use challenge for `coach` as a lowercase hex string (16 bytes = the same
   * width the fork's PasswordChallenge consumes). Replaces any prior outstanding nonce for that
   * coach (single-per-coach). Evicts the oldest coach if minting would exceed the hard cap.
   */
  issue(coach: string): string {
    const k = this.key(coach);
    if (!k) throw new Error("coach is required");
    this.sweep();
    // Re-issuing for an existing coach reuses its slot (delete-then-set keeps LRU order honest).
    this.byCoach.delete(k);
    while (this.byCoach.size >= this.maxCoaches) {
      const oldest = this.byCoach.keys().next().value;
      if (oldest === undefined) break;
      this.byCoach.delete(oldest);
    }
    const nonce = randomBytes(16).toString("hex");
    this.byCoach.set(k, { nonce, expiresAt: this.now() + this.ttlMs });
    return nonce;
  }

  /**
   * Return the coach's outstanding nonce and DELETE it (single-use), or undefined if none / expired.
   * The caller verifies the submitted response against this nonce; a second attempt with the same
   * response finds nothing → cannot replay.
   */
  consume(coach: string): string | undefined {
    const k = this.key(coach);
    const e = this.byCoach.get(k);
    if (!e) return undefined;
    this.byCoach.delete(k);
    if (e.expiresAt <= this.now()) return undefined;
    return e.nonce;
  }

  /** Drop expired entries. Cheap; called on every issue so the cap reflects live entries. */
  private sweep(): void {
    const t = this.now();
    for (const [k, e] of this.byCoach) if (e.expiresAt <= t) this.byCoach.delete(k);
  }

  /** Live outstanding count (post-sweep) — for tests/metrics. */
  size(): number {
    this.sweep();
    return this.byCoach.size;
  }
}
