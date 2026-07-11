/**
 * Short-lived record of a roster message whose tournament couldn't be derived
 * from the channel name, waiting on the coach to pick the tournament from a
 * select menu. In-memory + single-use, same rationale as the resubmission
 * prompts: losing one on restart is harmless (the stale menu says "expired").
 */

import { randomUUID } from "node:crypto";

export interface PendingChannelResolution {
  token: string;
  channelId: string;
  messageId: string;
  /** The coach who posted — only they may answer the prompt. */
  userId: string;
  createdAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class PendingChannelResolutionStore {
  private readonly byToken = new Map<string, PendingChannelResolution>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  create(p: Omit<PendingChannelResolution, "token" | "createdAt">): PendingChannelResolution {
    this.sweep();
    // One live prompt per posted message.
    for (const [tok, ex] of this.byToken)
      if (ex.messageId === p.messageId) this.byToken.delete(tok);
    const pending: PendingChannelResolution = {
      ...p,
      token: randomUUID().replace(/-/g, "").slice(0, 12),
      createdAt: Date.now(),
    };
    this.byToken.set(pending.token, pending);
    return pending;
  }

  take(token: string): PendingChannelResolution | undefined {
    const p = this.byToken.get(token);
    if (!p) return undefined;
    this.byToken.delete(token);
    if (Date.now() - p.createdAt > this.ttlMs) return undefined;
    return p;
  }

  private sweep(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [tok, p] of this.byToken) if (p.createdAt < cutoff) this.byToken.delete(tok);
  }
}
