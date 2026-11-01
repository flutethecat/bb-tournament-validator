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

  suppress(address: string, reason: SuppressionReason): void {
    const data = this.read();
    data.entries[this.hash(address)] = { reason, at: this.now().toISOString() };
    writeJson(this.file, data);
  }

  /** Lift a suppression (provider reactivation). Complaints are never lifted automatically. */
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
  notified: number;
  queued: number;
  skipped: { noConsent: number; unverified: number; suppressed: number };
}

export class MailAuditLog {
  private readonly file: string;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "audit.jsonl");
  }

  append(entry: MailAuditEntry): void {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Newest first. */
  forLeague(leagueId: string, limit = 20): MailAuditEntry[] {
    if (!existsSync(this.file)) return [];
    const out: MailAuditEntry[] = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as MailAuditEntry;
        if (e.leagueId === leagueId) out.push(e);
      } catch { /* skip a torn line */ }
    }
    return out.reverse().slice(0, limit);
  }
}
