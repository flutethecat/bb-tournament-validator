// A minimal in-memory RegistrationAdapter (tests, and the reference the tournament / league adapters follow). It keeps
// competitions and entries in maps; `commit` applies a batch all-or-nothing. `beforeCommit` lets tests
// interleave concurrent actions between the read and the write.

import type {
  CheckInNoticeRecord, CompetitionKind, CompetitionSnapshot, RegistrationAdapter, RegistrationChange, RegistrationEntry,
} from "./types.js";

export interface MemoryAdapterOptions {
  /** Awaited between reading entries and committing (to provoke races in tests). */
  beforeCommit?: () => Promise<void> | void;
}

export class MemoryRegistrationAdapter implements RegistrationAdapter {
  readonly competitions = new Map<string, CompetitionSnapshot>();
  readonly store = new Map<string, RegistrationEntry[]>();
  /** Every committed batch, in order (tests read the audit trail from here). */
  readonly commits: Array<{ id: string; changes: RegistrationChange[] }> = [];
  private seq = 0;

  constructor(readonly kind: CompetitionKind, private readonly opts: MemoryAdapterOptions = {}) {}

  /** Add or replace a competition. */
  put(c: CompetitionSnapshot): this {
    this.competitions.set(c.id, structuredClone(c));
    if (!this.store.has(c.id)) this.store.set(c.id, []);
    return this;
  }

  /** Change part of a competition (e.g. raise the cap). */
  update(id: string, patch: Partial<CompetitionSnapshot>): void {
    const c = this.competitions.get(id);
    if (c) this.competitions.set(id, { ...c, ...structuredClone(patch) });
  }

  competition(id: string): CompetitionSnapshot | undefined {
    const c = this.competitions.get(id);
    return c ? structuredClone(c) : undefined;
  }

  async entries(id: string): Promise<RegistrationEntry[]> {
    const rows = structuredClone(this.store.get(id) ?? []);
    // Yield, as a real store read may: concurrent callers interleave here unless the core's lock serialises them.
    await this.opts.beforeCommit?.();
    return rows;
  }

  newEntryId(id: string): string {
    this.seq += 1;
    return `${id}:entry:${this.seq}`;
  }

  async commit(id: string, changes: readonly RegistrationChange[]): Promise<void> {
    await this.opts.beforeCommit?.();
    const rows = structuredClone(this.store.get(id) ?? []);
    for (const ch of changes) {
      if (ch.after.competitionId !== id) throw new Error("An entry of another competition.");
      const i = rows.findIndex((e) => e.id === ch.after.id);
      if (i < 0) rows.push(structuredClone(ch.after));
      else rows[i] = structuredClone(ch.after);
    }
    this.store.set(id, rows);
    this.commits.push({ id, changes: structuredClone([...changes]) });
  }

  markCheckInNotice(id: string, notice: CheckInNoticeRecord): void {
    this.update(id, { checkInNotice: notice });
  }

  link(id: string, audience: "coach" | "organiser"): string {
    const base = this.kind === "tournament" ? `/app/tournaments/${encodeURIComponent(id)}` : `/app/leagues/${encodeURIComponent(id)}`;
    return audience === "organiser" ? `${base}?tab=registrations` : base;
  }
}
