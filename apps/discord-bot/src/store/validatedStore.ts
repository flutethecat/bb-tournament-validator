/**
 * ValidatedStore — where validated coaches are recorded and what /report reads.
 * CSV implementation (atomic tmp+rename writes); the interface is what the T1
 * tournament service ingests as its entrant-store design, so a DB impl can
 * replace this without touching bot logic.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface ValidatedEntry {
  discordUserId: string;
  coachName: string;
  teamName: string;
  rosterRace: string;
  packageName: string;
  /** https://discord.com/channels/<guildId>/<channelId>/<messageId> */
  messageLink: string;
  /** ISO 8601. */
  validatedAt: string;
}

export interface ValidatedStore {
  /** Latest wins per (discordUserId, packageName). */
  upsert(entry: ValidatedEntry): Promise<void>;
  list(packageName?: string): Promise<ValidatedEntry[]>;
  /** Raw CSV for /report's optional attachment. */
  exportCsv(packageName?: string): Promise<string>;
}

const HEADER = "discordUserId,coachName,teamName,rosterRace,packageName,messageLink,validatedAt";
const FIELDS = HEADER.split(",") as (keyof ValidatedEntry)[];

export const csvEscape = (v: string): string =>
  /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;

/** Minimal RFC-4180 line splitter (quotes + escaped quotes). */
export function csvSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

export class CsvValidatedStore implements ValidatedStore {
  constructor(private readonly filePath: string) {}

  private read(): ValidatedEntry[] {
    if (!existsSync(this.filePath)) return [];
    const lines = readFileSync(this.filePath, "utf8").split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(1).map((line) => {
      const cells = csvSplit(line);
      const entry = {} as Record<keyof ValidatedEntry, string>;
      FIELDS.forEach((f, i) => (entry[f] = cells[i] ?? ""));
      return entry as ValidatedEntry;
    });
  }

  private write(entries: ValidatedEntry[]): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const body = entries
      .map((e) => FIELDS.map((f) => csvEscape(e[f])).join(","))
      .join("\n");
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, `${HEADER}\n${body}${body ? "\n" : ""}`, "utf8");
    renameSync(tmp, this.filePath);
  }

  async upsert(entry: ValidatedEntry): Promise<void> {
    const entries = this.read().filter(
      (e) => !(e.discordUserId === entry.discordUserId && e.packageName === entry.packageName),
    );
    entries.push(entry);
    this.write(entries);
  }

  async list(packageName?: string): Promise<ValidatedEntry[]> {
    const all = this.read();
    return packageName ? all.filter((e) => e.packageName === packageName) : all;
  }

  async exportCsv(packageName?: string): Promise<string> {
    const entries = await this.list(packageName);
    return [HEADER, ...entries.map((e) => FIELDS.map((f) => csvEscape(e[f])).join(","))].join("\n");
  }
}
