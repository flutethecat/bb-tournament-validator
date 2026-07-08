/**
 * Owner-controlled kill switch for the FUMBBL40k build/daily-summary announcer.
 * When held, NOTHING posts (poller, manual /bbbot 40k announce|daily, and the 9AM
 * scheduled task all route through this) — and de-dupe state is NOT marked, so
 * whatever was pending still posts once the hold is lifted, nothing is lost.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface HoldState {
  held: boolean;
  reason?: string;
  setAt?: string;
}

export class AnnounceHold {
  constructor(private readonly filePath: string) {}

  private read(): HoldState {
    if (!existsSync(this.filePath)) return { held: false };
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as HoldState;
    } catch {
      return { held: false };
    }
  }

  private write(s: HoldState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  isHeld(): boolean {
    return this.read().held;
  }

  status(): HoldState {
    return this.read();
  }

  hold(reason?: string): void {
    this.write({ held: true, reason, setAt: new Date().toISOString() });
  }

  resume(): void {
    this.write({ held: false, setAt: new Date().toISOString() });
  }
}
