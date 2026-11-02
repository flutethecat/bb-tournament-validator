/**
 * Discord state outside the league store (leagues keep their webhooks in their own secrets.json):
 *
 *   <FORK_STATE_DIR>/discord/competitions.json   Discord options per competition key ("tournament:<id>", "series:<id>")
 *   <FORK_STATE_DIR>/discord/secrets.json        their webhook URLs: server-side only, masked in every read model, never
 *                                                logged, never in an error message
 *   <FORK_STATE_DIR>/discord/ledger.json         what was already posted (the observer's seen-sets, Weekly Digest last
 *                                                runs, the samples rate limit): opaque ids and times only, no coach data
 *
 * Atomic writes (temp file + rename); every write re-reads the file first. A missing or unreadable file reads as empty.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import type { CompetitionDiscordConfig } from "./catalogue.js";

export const COMPETITION_KEY = /^(?:tournament|series):[A-Za-z0-9_-]{1,80}$/;

interface ConfigFile { version: 1; configs: Record<string, CompetitionDiscordConfig> }
interface SecretsFile { version: 1; webhooks: Record<string, string> }

/** Per competition: posted marker keys (key -> ISO time), capped. */
export interface LedgerEntry { seen: Record<string, string>; baselineAt?: string }
interface LedgerFile { version: 1; competitions: Record<string, LedgerEntry>; weekly: Record<string, { lastRun?: string; lastRound?: string }> }

const LEDGER_CAP = 4000;

export class DiscordStateStore {
  constructor(readonly dir: string) {}

  private read<T>(name: string, empty: T): T {
    try {
      const v = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as T;
      return v && typeof v === "object" ? v : empty;
    } catch {
      return empty;
    }
  }
  private write(name: string, value: unknown): void {
    atomicWriteTextFile(join(this.dir, name), `${JSON.stringify(value, null, 2)}\n`);
  }

  // ---- options ----

  config(key: string): CompetitionDiscordConfig | undefined {
    const c = this.read<ConfigFile>("competitions.json", { version: 1, configs: {} }).configs?.[key];
    return c ? structuredClone(c) : undefined;
  }
  setConfig(key: string, config: CompetitionDiscordConfig | undefined): void {
    if (!COMPETITION_KEY.test(key)) throw new Error("bad competition key");
    const file = this.read<ConfigFile>("competitions.json", { version: 1, configs: {} });
    file.configs ??= {};
    if (config) file.configs[key] = config; else delete file.configs[key];
    this.write("competitions.json", file);
  }

  // ---- secrets (never in a read model or a log line) ----

  webhook(key: string): string | undefined {
    const url = this.read<SecretsFile>("secrets.json", { version: 1, webhooks: {} }).webhooks?.[key];
    return typeof url === "string" && url ? url : undefined;
  }
  setWebhook(key: string, url: string | null): void {
    if (!COMPETITION_KEY.test(key)) throw new Error("bad competition key");
    const file = this.read<SecretsFile>("secrets.json", { version: 1, webhooks: {} });
    file.webhooks ??= {};
    if (url) file.webhooks[key] = url; else delete file.webhooks[key];
    this.write("secrets.json", file);
  }

  // ---- ledger ----

  private ledger(): LedgerFile {
    const l = this.read<LedgerFile>("ledger.json", { version: 1, competitions: {}, weekly: {} });
    l.competitions ??= {};
    l.weekly ??= {};
    return l;
  }
  entry(key: string): LedgerEntry | undefined {
    const e = this.ledger().competitions[key];
    return e ? structuredClone(e) : undefined;
  }
  /**
   * Marks keys posted (or baselined). Returns the keys that were NEW (a key marked before is never returned twice).
   * `live` (the observer passes every marker the competition still has) makes the call a full pass: markers no longer
   * live may then be dropped, oldest first, once there are more than LEDGER_CAP. A live marker is never dropped, so
   * history can never be replayed; calls without `live` only add.
   */
  mark(key: string, markers: readonly string[], at: string, baseline = false, live?: ReadonlySet<string>): string[] {
    const l = this.ledger();
    const e = l.competitions[key] ?? { seen: {} };
    const fresh: string[] = [];
    for (const m of markers) if (!(m in e.seen)) { e.seen[m] = at; fresh.push(m); }
    let changed = fresh.length > 0;
    if (baseline && !e.baselineAt) { e.baselineAt = at; changed = true; }
    const keys = Object.keys(e.seen);
    if (live && keys.length > LEDGER_CAP) {
      const stale = keys.filter((k) => !live.has(k)).sort((a, b) => e.seen[a]!.localeCompare(e.seen[b]!));
      for (const k of stale.slice(0, keys.length - LEDGER_CAP)) { delete e.seen[k]; changed = true; }
    }
    l.competitions[key] = e;
    if (changed) this.write("ledger.json", l);
    return fresh;
  }
  /** Has this marker been posted for the competition? */
  has(key: string, marker: string): boolean {
    return Boolean(this.ledger().competitions[key]?.seen?.[marker]);
  }
  weekly(leagueId: string): { lastRun?: string; lastRound?: string } {
    return { ...(this.ledger().weekly[leagueId] ?? {}) };
  }
  setWeekly(leagueId: string, patch: { lastRun?: string; lastRound?: string }): void {
    const l = this.ledger();
    l.weekly[leagueId] = { ...(l.weekly[leagueId] ?? {}), ...patch };
    this.write("ledger.json", l);
  }
}
