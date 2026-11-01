// Small JSON stores under <state>/mail/:
//   suppression.json  bounced / complained addresses as salted hashes (HMAC-SHA256 with the host salt in salt.key);
//                     the address itself is never stored here.
//   prefs.json        per coach: the league-mail opt-out (unsubscribe link) and the portal-verified email (with the
//                     pending verification request) while the identity record has no contact fields of its own.
//   audit.jsonl       one line per league message: league, sender, recipient counts, time. No addresses, no names of
//                     recipients.

import { createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { hostKey } from "./tokens.js";

export const mailCoachKey = (coach: string): string => coach.trim().toLowerCase();
export const normalizeAddress = (address: string): string => address.trim().toLowerCase();

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  atomicWriteTextFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

// ---- suppression ----------------------------------------------------------------------------------------------------

export type SuppressionReason = "bounce" | "complaint" | "inactive" | "manual";

interface SuppressionFile { version: 1; entries: Record<string, { reason: SuppressionReason; at: string }> }

export class SuppressionStore {
  private readonly file: string;
  private readonly salt: string;
  constructor(private readonly dir: string, private readonly now: () => Date = () => new Date()) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "suppression.json");
    this.salt = hostKey(join(dir, "salt.key"));
  }

  /** The stored form of an address: HMAC-SHA256(salt, lower-cased address), hex. */
  hash(address: string): string {
    return createHmac("sha256", this.salt).update(normalizeAddress(address)).digest("hex");
  }

  private read(): SuppressionFile {
    const raw = readJson<Partial<SuppressionFile>>(this.file, {});
    return { version: 1, entries: raw.entries && typeof raw.entries === "object" ? raw.entries : {} };
  }

  isSuppressed(address: string): boolean {
    return Object.hasOwn(this.read().entries, this.hash(address));
  }

  /** The stored reason and time for an address, if suppressed. */
  entry(address: string): { reason: SuppressionReason; at: string } | undefined {
    return this.read().entries[this.hash(address)];
  }

  /** Suppress an address. A complaint is sticky: a later bounce / inactive / manual event never downgrades it. */
  suppress(address: string, reason: SuppressionReason): void {
    const data = this.read();
    const key = this.hash(address);
    if (data.entries[key]?.reason === "complaint" && reason !== "complaint") return;
    data.entries[key] = { reason, at: this.now().toISOString() };
    writeJson(this.file, data);
  }

  /**
   * Explicit clear (an admin action, or the coach re-verifying and re-consenting after the suppression). The only way a
   * complaint is ever removed; it is logged (who, the reason and a hash prefix; never the address).
   */
  clear(address: string, by: "admin" | "reverify-reconsent", log: (line: string) => void): boolean {
    const data = this.read();
    const key = this.hash(address);
    const hit = data.entries[key];
    if (!hit) return false;
    delete data.entries[key];
    writeJson(this.file, data);
    log(`[mail] suppression cleared (${hit.reason}) by ${by}: ${key.slice(0, 12)}`);
    return true;
  }

  /** Lift a suppression (provider reactivation). Complaints are never lifted this way. */
  unsuppress(address: string): boolean {
    const data = this.read();
    const key = this.hash(address);
    const hit = data.entries[key];
    if (!hit || hit.reason === "complaint") return false;
    delete data.entries[key];
    writeJson(this.file, data);
    return true;
  }

  size(): number {
    return Object.keys(this.read().entries).length;
  }
}

// ---- per-coach mail prefs -------------------------------------------------------------------------------------------

export interface CoachMailPrefs {
  /** The coach turned league email off with an unsubscribe link (when the identity has no consent field to write). */
  leagueMailOff?: { at: string; leagueId?: string };
  /** An address the coach verified through the portal. */
  email?: { address: string; verifiedAt: string };
  /** Bumped when league email is turned back on (re-consent): unsubscribe links issued before stop working. */
  consentGen?: number;
  /** When the coach last turned league email back on from the Account page. */
  reconsentAt?: string;
  /** The open verification request (one at a time; a new request replaces it). */
  pending?: { address: string; nonce: string; requestedAt: string; expiresAt: string };
}

interface PrefsFile { version: 1; coaches: Record<string, CoachMailPrefs> }

export class MailPrefsStore {
  private readonly file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "prefs.json");
  }

  private read(): PrefsFile {
    const raw = readJson<Partial<PrefsFile>>(this.file, {});
    return { version: 1, coaches: raw.coaches && typeof raw.coaches === "object" ? raw.coaches : {} };
  }

  get(coach: string): CoachMailPrefs {
    return this.read().coaches[mailCoachKey(coach)] ?? {};
  }

  update(coach: string, mutate: (prefs: CoachMailPrefs) => CoachMailPrefs | void): CoachMailPrefs {
    const key = mailCoachKey(coach);
    if (!key) throw new Error("A coach is required.");
    const data = this.read();
    const current = { ...(data.coaches[key] ?? {}) };
    const next = mutate(current) ?? current;
    if (Object.keys(next).length) data.coaches[key] = next;
    else delete data.coaches[key];
    writeJson(this.file, data);
    return next;
  }

  /** Account deletion (export/delete lane): drop everything held for a coach. */
  remove(coach: string): void {
    const data = this.read();
    if (delete data.coaches[mailCoachKey(coach)]) writeJson(this.file, data);
  }
}

// ---- audit ----------------------------------------------------------------------------------------------------------

export interface MailAuditEntry {
  id: string;
  leagueId: string;
  sender: string;
  at: string;
  scope: "all" | "team" | "coach";
  /** Members the message was addressed to (the organiser-facing daily cap counts these); older rows: notified. */
  addressed?: number;
  notified: number;
  queued: number;
  skipped: { noConsent: number; unverified: number; suppressed: number };
}

/** A queued delivery dropped at send time (consent withdrawn, address changed, suppressed since). */
export interface MailAuditDrop { kind: "drop"; id: string; leagueId: string; at: string; reason: keyof MailAuditEntry["skipped"] }

export class MailAuditLog {
  private readonly file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "audit.jsonl");
  }

  append(entry: MailAuditEntry): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  recordDrop(drop: Omit<MailAuditDrop, "kind">): void {
    appendFileSync(this.file, `${JSON.stringify({ kind: "drop", ...drop })}\n`, { mode: 0o600 });
  }

  /** Members addressed by a league's messages on the UTC day of `nowMs` (the organiser-facing daily cap). */
  addressedOn(leagueId: string, nowMs: number): number {
    if (!existsSync(this.file)) return 0;
    const day = new Date(nowMs).toISOString().slice(0, 10);
    let total = 0;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as Partial<MailAuditEntry> & { kind?: string };
        if (e.kind === "drop" || e.leagueId !== leagueId || typeof e.at !== "string" || e.at.slice(0, 10) !== day) continue;
        const n = typeof e.addressed === "number" ? e.addressed : e.notified;
        if (typeof n === "number" && n > 0) total += n;
      } catch { /* skip a torn line */ }
    }
    return total;
  }

  /** Newest first; send-time drops are folded in (queued down, skipped up). */
  forLeague(leagueId: string, limit = 20): MailAuditEntry[] {
    if (!existsSync(this.file)) return [];
    const out: MailAuditEntry[] = [];
    const byId = new Map<string, MailAuditEntry>();
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MailAuditEntry | MailAuditDrop;
        if (e.leagueId !== leagueId) continue;
        if ("kind" in e && e.kind === "drop") {
          const row = byId.get(e.id);
          if (row && typeof row.skipped[e.reason] === "number") { row.queued = Math.max(0, row.queued - 1); row.skipped[e.reason] += 1; }
          continue;
        }
        const entry = e as MailAuditEntry;
        const row: MailAuditEntry = { ...entry, skipped: { ...entry.skipped } };
        byId.set(row.id, row);
        out.push(row);
      } catch { /* skip a torn line */ }
    }
    return out.reverse().slice(0, limit);
  }
}
