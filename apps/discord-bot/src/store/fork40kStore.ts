/**
 * Fork40kStore — FUMBBL40k Discord channels: `channelId` = where /bbbot 40k launch
 * posts coaches' fork-join JNLPs; `announceChannelId` = where build announcements go
 * (falls back to channelId when unset). JSON file, atomic writes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Fork40kState {
  channelId?: string;
  announceChannelId?: string;
}

export class Fork40kStore {
  constructor(private readonly filePath: string) {}

  private read(): Fork40kState {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as Fork40kState;
    } catch {
      return {};
    }
  }

  private write(data: Fork40kState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  getChannel(): string | undefined {
    return this.read().channelId;
  }

  setChannel(channelId: string): void {
    this.write({ ...this.read(), channelId });
  }

  /** Build-announce channel; falls back to the games channel when unset. */
  getAnnounceChannel(): string | undefined {
    return this.read().announceChannelId ?? this.read().channelId;
  }

  setAnnounceChannel(channelId: string): void {
    this.write({ ...this.read(), announceChannelId: channelId });
  }
}
