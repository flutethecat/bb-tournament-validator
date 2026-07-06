/**
 * WatchStore — channel → tournament-package bindings for auto-ingestion
 * (owner decision 2026-07-06: the bot reads PDFs posted to watched channels).
 * JSON file with atomic writes, same discipline as the other stores.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Watch {
  channelId: string;
  packageName: string;
}

export class WatchStore {
  constructor(private readonly filePath: string) {}

  private read(): Record<string, string> {
    if (!existsSync(this.filePath)) return {};
    return JSON.parse(readFileSync(this.filePath, "utf8")) as Record<string, string>;
  }

  private write(map: Record<string, string>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  set(channelId: string, packageName: string): void {
    const map = this.read();
    map[channelId] = packageName;
    this.write(map);
  }

  /** Returns true if a watch existed. */
  remove(channelId: string): boolean {
    const map = this.read();
    if (!(channelId in map)) return false;
    delete map[channelId];
    this.write(map);
    return true;
  }

  get(channelId: string): string | undefined {
    return this.read()[channelId];
  }

  list(): Watch[] {
    return Object.entries(this.read()).map(([channelId, packageName]) => ({
      channelId,
      packageName,
    }));
  }
}
