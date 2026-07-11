/**
 * Short-lived record of a valid roster that is waiting on the coach's "replace
 * my earlier submission?" confirmation (DM buttons). Kept in memory on purpose:
 * a pending prompt is ephemeral, single-use, and losing it on a bot restart is
 * harmless — the stale buttons simply report "expired" and the coach re-submits.
 */

import { randomUUID } from "node:crypto";
import type { CoachTeamRegistration } from "./coachRegistry";
import type { ValidatedEntry } from "./validatedStore";

export interface PendingResubmission {
  token: string;
  discordUserId: string;
  packageName: string;
  /** The new submission to commit if the coach confirms the replace. */
  newEntry: ValidatedEntry;
  /** Coach-registry team payload committed alongside newEntry. */
  registryTeam: CoachTeamRegistration;
  /** The existing entry the coach would be overwriting. */
  previous: { teamName: string; messageLink: string; validatedAt: string };
  createdAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class PendingResubmissionStore {
  private readonly byToken = new Map<string, PendingResubmission>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  /**
   * Register a pending confirmation. Any earlier pending prompt for the same
   * (coach, tournament) is superseded so only the latest question is live.
   */
  create(
    p: Omit<PendingResubmission, "token" | "createdAt">,
  ): PendingResubmission {
    this.sweep();
    for (const [tok, ex] of this.byToken)
      if (ex.discordUserId === p.discordUserId && ex.packageName === p.packageName)
        this.byToken.delete(tok);
    const pending: PendingResubmission = {
      ...p,
      token: randomUUID().replace(/-/g, "").slice(0, 12),
      createdAt: Date.now(),
    };
    this.byToken.set(pending.token, pending);
    return pending;
  }

  /** Consume a pending confirmation (single-use). Undefined if unknown/expired. */
  take(token: string): PendingResubmission | undefined {
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
