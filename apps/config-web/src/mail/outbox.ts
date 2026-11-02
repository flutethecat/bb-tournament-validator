// Durable mail outbox: an append-only JSON-lines journal under <state>/mail/outbox/journal.jsonl, replayed at start so
// queued mail survives a restart. Every message carries an idempotency key: enqueueing a key that is already known (queued,
// sent or dead) is a no-op. The worker drains due messages with a global rate limit (default 10/s) and a per-league
// daily cap (default 500, counted per UTC day); retryable failures back off, the rest are dead-lettered.
//
// Retention: a sent or dead message keeps its address and body (with its signed links) for 30 days, then compaction
// strips the whole message (the id, key, league and status stay as a tombstone so the key stays idempotent); tombstones go
// after 180 days. Compaction runs at start, after 5,000 journal ops, and on a daily timer (startRetention).
//
// Channel-agnostic: every item names its channel ("email" or "discord") and the worker picks the transport per channel.
// A Discord row never holds the coach's Discord id: its transport resolves it from the recipient at send time
// (src/mail/discord.ts), so the journal, exports and logs never carry one.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { mailCoachKey } from "./stores.js";
import { isCoachFenced } from "../privacy/fence.js";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { MailSendAborted, MailSendError, type MailMessage, type MailTransport } from "./transport.js";

export const OUTBOX_BODY_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const OUTBOX_TOMBSTONE_RETENTION_MS = 180 * 24 * 3600 * 1000;
export const OUTBOX_MAX_ATTEMPTS = 6;

export type OutboxStatus = "queued" | "sent" | "dead";

/** Delivery channels: email, and Discord DMs from the bot (actionable notifications, src/mail/actionMessages.ts). */
export type MailChannel = "email" | "discord";
export const RETENTION_SWEEP_MS = 24 * 3600 * 1000;

/** Who a message is for, so the worker can re-check eligibility at send time (league mail: consent, ack, address). */
export interface OutboxRecipient { coach: string; leagueId?: string }

export interface OutboxEntry {
  id: string;
  key: string;
  template: string;
  channel: MailChannel;
  leagueId?: string;
  recipient?: OutboxRecipient;
  /** The league message (audit row) this delivery belongs to. */
  auditId?: string;
  /** A re-verification the coach asked for after re-consenting: may go to a complaint-suppressed address. */
  reverify?: true;
  /** Absent once compaction stripped it (sent / dead and older than the retention). */
  message?: MailMessage;
  status: OutboxStatus;
  attempts: number;
  /** Epoch ms: the next attempt is due at or after this. */
  nextAt: number;
  enqueuedAt: number;
  doneAt?: number;
  /** Short reason for a retry or a dead letter (never an address). */
  error?: string;
}

export interface OutboxItem {
  key: string;
  message: MailMessage;
  /** Default "email". */
  channel?: MailChannel;
  leagueId?: string;
  recipient?: OutboxRecipient;
  auditId?: string;
  reverify?: true;
}

type JournalLine =
  | { op: "add"; entry: OutboxEntry }
  | { op: "sent"; id: string; at: number }
  | { op: "retry"; id: string; attempts: number; nextAt: number; error: string }
  | { op: "dead"; id: string; at: number; attempts: number; error: string };

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const nextUtcMidnight = (ms: number): number => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

export class Outbox {
  readonly file: string;
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly byKey = new Map<string, string>();
  private ops = 0;

  constructor(stateMailDir: string, private readonly now: () => number = Date.now) {
    const dir = join(stateMailDir, "outbox");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "journal.jsonl");
    this.load();
    this.compact();
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    for (const raw of readFileSync(this.file, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      let line: JournalLine;
      try { line = JSON.parse(raw) as JournalLine; } catch { continue; } // a torn last line after a crash
      this.apply(line);
    }
  }

  private apply(line: JournalLine): void {
    if (line.op === "add") {
      if (!line.entry?.id || !line.entry.key || this.byKey.has(line.entry.key)) return;
      this.entries.set(line.entry.id, { ...line.entry, channel: line.entry.channel ?? "email" });
      this.byKey.set(line.entry.key, line.entry.id);
      return;
    }
    const e = this.entries.get(line.id);
    if (!e) return;
    if (line.op === "sent") { e.status = "sent"; e.doneAt = line.at; delete e.error; }
    else if (line.op === "retry") { e.attempts = line.attempts; e.nextAt = line.nextAt; e.error = line.error; }
    else if (line.op === "dead") { e.status = "dead"; e.doneAt = line.at; e.attempts = line.attempts; e.error = line.error; }
  }

  private write(lines: JournalLine[]): void {
    if (!lines.length) return;
    appendFileSync(this.file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
    for (const l of lines) this.apply(l);
    this.ops += lines.length;
    if (this.ops > 5_000) this.compact();
  }

  /** The deliveries addressed to a coach (data export). */
  forCoach(coach: string): OutboxEntry[] {
    const key = mailCoachKey(coach);
    return [...this.entries.values()].filter((e) => e.recipient && mailCoachKey(e.recipient.coach) === key).map((e) => ({ ...e }));
  }

  /** Account deletion: every delivery to the coach goes (a queued one is never sent), and the journal is rewritten. */
  forgetCoach(coach: string): number {
    const key = mailCoachKey(coach);
    let n = 0;
    for (const [id, e] of [...this.entries]) {
      if (!e.recipient || mailCoachKey(e.recipient.coach) !== key) continue;
      this.entries.delete(id);
      this.byKey.delete(e.key);
      n += 1;
    }
    this.compact();
    return n;
  }

  /** Rewrites the journal from memory, applying the retention rules. */
  compact(): void {
    const now = this.now();
    const lines: string[] = [];
    for (const [id, e] of [...this.entries]) {
      if (e.status !== "queued" && e.doneAt !== undefined) {
        if (now - e.doneAt > OUTBOX_TOMBSTONE_RETENTION_MS) {
          this.entries.delete(id);
          this.byKey.delete(e.key);
          continue;
        }
        if (now - e.doneAt > OUTBOX_BODY_RETENTION_MS && e.message) delete e.message;
      }
      lines.push(JSON.stringify({ op: "add", entry: e } satisfies JournalLine));
    }
    atomicWriteTextFile(this.file, lines.length ? `${lines.join("\n")}\n` : "");
    this.ops = 0;
  }

  private retentionTimer?: ReturnType<typeof setInterval>;
  /** Daily compaction on a long-running instance (the 30-day strip must not wait for a restart). */
  startRetention(intervalMs = RETENTION_SWEEP_MS): void {
    if (this.retentionTimer) return;
    this.retentionTimer = setInterval(() => { try { this.compact(); } catch { /* next sweep retries */ } }, intervalMs);
    this.retentionTimer.unref?.();
  }
  stopRetention(): void {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
  }

  /** Adds messages whose key is new; returns how many were added and how many keys were already known. */
  enqueue(items: OutboxItem[]): { added: number; duplicates: number } {
    const now = this.now();
    const lines: JournalLine[] = [];
    const seen = new Set<string>();
    let duplicates = 0;
    for (const item of items) {
      if (this.byKey.has(item.key) || seen.has(item.key)) { duplicates += 1; continue; }
      seen.add(item.key);
      lines.push({
        op: "add",
        entry: {
          id: `m${now.toString(36)}${randomBytes(5).toString("hex")}`, key: item.key, template: item.message.template, channel: item.channel ?? "email",
          ...(item.leagueId ? { leagueId: item.leagueId } : {}), ...(item.recipient ? { recipient: item.recipient } : {}), ...(item.auditId ? { auditId: item.auditId } : {}), ...(item.reverify ? { reverify: true as const } : {}),
          message: item.message, status: "queued", attempts: 0, nextAt: now, enqueuedAt: now,
        },
      });
    }
    this.write(lines);
    return { added: lines.length, duplicates };
  }

  has(key: string): boolean { return this.byKey.has(key); }
  get(id: string): OutboxEntry | undefined { const e = this.entries.get(id); return e ? { ...e } : undefined; }
  byIdempotencyKey(key: string): OutboxEntry | undefined { const id = this.byKey.get(key); return id ? this.get(id) : undefined; }
  list(): OutboxEntry[] { return [...this.entries.values()].map((e) => ({ ...e })); }

  /** Due queued messages, oldest first. */
  due(now = this.now()): OutboxEntry[] {
    return [...this.entries.values()].filter((e) => e.status === "queued" && e.nextAt <= now).sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  }

  /** Messages for a league sent today plus those still queued (the daily cap's count). */
  leagueLoad(leagueId: string, now = this.now()): { sentToday: number; queued: number } {
    const today = dayOf(now);
    let sentToday = 0;
    let queued = 0;
    for (const e of this.entries.values()) {
      if (e.leagueId !== leagueId) continue;
      if (e.status === "queued") queued += 1;
      else if (e.status === "sent" && e.doneAt !== undefined && dayOf(e.doneAt) === today) sentToday += 1;
    }
    return { sentToday, queued };
  }

  markSent(id: string): void { this.write([{ op: "sent", id, at: this.now() }]); }
  markRetry(id: string, attempts: number, nextAt: number, error: string): void { this.write([{ op: "retry", id, attempts, nextAt, error }]); }
  markDead(id: string, attempts: number, error: string): void { this.write([{ op: "dead", id, at: this.now(), attempts, error }]); }
}

// ---- worker ---------------------------------------------------------------------------------------------------------

/** Send-time re-check: still eligible (send) or why not (drop as skipped). */
export type RecheckResult = { ok: true } | { ok: false; reason: "noConsent" | "unverified" | "suppressed" };

export interface MailWorkerOptions {
  outbox: Outbox;
  /** Transport per channel. */
  transports?: Partial<Record<MailChannel, MailTransport>>;
  /** Shorthand for transports.email. */
  transport?: MailTransport;
  /** Re-resolves the recipient right before each attempt (consent may be withdrawn while a message waits). */
  recheck?: (entry: OutboxEntry) => RecheckResult;
  /** A message dropped by the re-check (the audit counts it as skipped). */
  onDropped?: (entry: OutboxEntry, reason: Exclude<RecheckResult, { ok: true }>["reason"]) => void;
  /** Suppression check at send time (an address may have bounced since it was queued). */
  isSuppressed?: (address: string) => boolean;
  /** The provider refused the address as inactive: suppress it. */
  onInactive?: (address: string) => void;
  /** A delivery was dead-lettered by a transport failure (refused for good, or out of retries); never called for a row
   *  the eligibility re-check dropped. The Discord channel's email fallback hangs off it. */
  onFailed?: (entry: OutboxEntry, error: MailSendError) => void;
  ratePerSecond?: number;
  /** Per-channel pace on top of the global rate (Discord DMs default to DISCORD_DM_RATE_PER_SECOND). */
  channelRates?: Partial<Record<MailChannel, number>>;
  leagueDailyCap?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_RATE_PER_SECOND = 10;
/** Bot DMs go out a few per second (Discord's DM-open and message routes rate-limit per bot); 429s back off (discord.ts). */
export const DISCORD_DM_RATE_PER_SECOND = 3;
export const DEFAULT_LEAGUE_DAILY_CAP = 500;

/** Backoff after the n-th failed attempt (1-based): 30 s, 2 min, 8 min, 32 min, then 1 h. */
export const retryDelayMs = (attempts: number): number => Math.min(3_600_000, 30_000 * 4 ** Math.max(0, attempts - 1));

export class MailWorker {
  private readonly starts: number[] = [];
  private readonly channelStarts = new Map<MailChannel, number[]>();
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  readonly rate: number;
  readonly cap: number;
  constructor(private readonly opts: MailWorkerOptions) {
    this.rate = opts.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
    this.cap = opts.leagueDailyCap ?? DEFAULT_LEAGUE_DAILY_CAP;
  }

  private now(): number { return this.opts.now?.() ?? Date.now(); }

  /** Sends per second on one channel (email: the global rate; discord: a few per second). */
  channelRate(channel: MailChannel): number {
    return this.opts.channelRates?.[channel] ?? (channel === "discord" ? DISCORD_DM_RATE_PER_SECOND : this.rate);
  }

  private transportFor(channel: MailChannel): MailTransport | undefined {
    return this.opts.transports?.[channel] ?? (channel === "email" ? this.opts.transport : undefined);
  }

  /** One pass: sends up to the rate limit's remaining budget for this second. Returns how many sends were attempted. */
  async drain(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let attempted = 0;
    try {
      const { outbox } = this.opts;
      const deferredLeagues = new Set<string>();
      for (const entry of outbox.due(this.now())) {
        const now = this.now();
        while (this.starts.length && now - this.starts[0]! >= 1000) this.starts.shift();
        if (this.starts.length >= this.rate) break;
        // the channel's own pace: a busy channel waits for the next pass, other channels keep going
        const chStarts = this.channelStarts.get(entry.channel) ?? [];
        while (chStarts.length && now - chStarts[0]! >= 1000) chStarts.shift();
        this.channelStarts.set(entry.channel, chStarts);
        if (chStarts.length >= this.channelRate(entry.channel)) continue;
        if (!entry.message) { outbox.markDead(entry.id, entry.attempts, "no message"); continue; }
        if (entry.leagueId) {
          if (deferredLeagues.has(entry.leagueId)) continue;
          if (outbox.leagueLoad(entry.leagueId, now).sentToday >= this.cap) {
            // Over today's cap: every queued message of this league waits for the next UTC day.
            for (const e of outbox.due(now)) if (e.leagueId === entry.leagueId) outbox.markRetry(e.id, e.attempts, nextUtcMidnight(now), "league daily cap");
            deferredLeagues.add(entry.leagueId);
            continue;
          }
        }
        // A coach whose account deletion is running (src/privacy/fence.ts) never receives another email: the row goes.
        if (entry.recipient && isCoachFenced(entry.recipient.coach)) { outbox.markDead(entry.id, entry.attempts, "account deleted"); continue; }
        const check = (): RecheckResult => {
          if (entry.recipient && isCoachFenced(entry.recipient.coach)) return { ok: false, reason: "noConsent" };
          return this.opts.recheck?.(entry) ?? (this.opts.isSuppressed?.(entry.message!.to) ? { ok: false as const, reason: "suppressed" as const } : { ok: true as const });
        };
        const drop = (r: Exclude<RecheckResult, { ok: true }>, attempts: number) => {
          outbox.markDead(entry.id, attempts, r.reason === "suppressed" ? "suppressed" : `ineligible: ${r.reason}`);
          try { this.opts.onDropped?.(entry, r.reason); } catch { /* best effort */ }
        };
        const recheck = check();
        if (!recheck.ok) { drop(recheck, entry.attempts); continue; }
        const transport = this.transportFor(entry.channel);
        if (!transport) { outbox.markDead(entry.id, entry.attempts, `no transport for ${entry.channel}`); continue; }
        this.starts.push(now);
        chStarts.push(now);
        attempted += 1;
        const attempts = entry.attempts + 1;
        // The transport re-runs the check before every provider attempt (its own retries included).
        let refused: Exclude<RecheckResult, { ok: true }> | undefined;
        const stillEligible = (): boolean => { const r = check(); if (!r.ok) refused = r; return r.ok; };
        try {
          await transport.send(entry.message, { stillEligible, idempotencyKey: entry.key, ...(entry.recipient ? { recipient: { coach: entry.recipient.coach } } : {}) });
          outbox.markSent(entry.id);
        } catch (e) {
          if (e instanceof MailSendAborted || refused) { drop(refused ?? { ok: false, reason: "noConsent" }, entry.attempts); continue; }
          const err = e instanceof MailSendError ? e : new MailSendError("send failed", true);
          if (err.inactiveRecipient) {
            try { this.opts.onInactive?.(entry.message.to); } catch { /* best effort */ }
            outbox.markDead(entry.id, attempts, "inactive recipient");
          } else if (err.retryable && attempts < OUTBOX_MAX_ATTEMPTS) {
            outbox.markRetry(entry.id, attempts, this.now() + retryDelayMs(attempts), err.message.slice(0, 120));
          } else {
            outbox.markDead(entry.id, attempts, err.message.slice(0, 120));
            try { this.opts.onFailed?.(entry, err); } catch { /* best effort */ }
          }
          this.opts.log?.(`[mail] ${entry.template} ${entry.id} failed (attempt ${attempts}): ${err.message.slice(0, 120)}`);
        }
      }
    } finally {
      this.running = false;
    }
    return attempted;
  }

  start(intervalMs = 1000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.drain().catch((e) => this.opts.log?.(`[mail] worker pass failed: ${(e as Error).message}`)); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
