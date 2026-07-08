/**
 * Fork40kStore — the single Discord channel where /bbbot 40k launch posts coaches'
 * fork-join JNLPs (distinct from the roster-validation watched channels). JSON file,
 * same atomic-write discipline as the other stores.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class Fork40kStore {
  constructor(private readonly filePath: string) {}

  private read(): { channelId?: string } {
    if (!existsSync(this.filePath)) return {};
    return JSON.parse(readFileSync(this.filePath, "utf8")) as { channelId?: string };
  }

  private write(data: { channelId?: string }): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  getChannel(): string | undefined {
    return this.read().channelId;
  }

  setChannel(channelId: string): void {
    this.write({ channelId });
  }
}
