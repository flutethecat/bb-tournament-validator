// The site ratings' one stored setting: the go-live reset (owner round 2, 11-04: "No backfill. Ratings reset to 1500 at
// go-live"). Ratings are derived from the results every time (src/ratings/service.ts); a reset stores the moment from
// which games count, so every rating starts again at 1500 / RD 350 / volatility 0.06 and earlier games never count.
// The file holds no personal data (no coach, no actor name). scripts/reset-ratings.ts writes it.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";

export interface RatingsState {
  version: 1;
  /** Games played before this instant never count (ISO). Absent = every game counts. */
  resetAt?: string;
}

export const ratingsStateFile = (stateDir: string): string => join(stateDir, "site-ratings.json");

/** Strict: a missing file is "no reset"; an unreadable or malformed one throws (callers fail closed). */
export function readRatingsState(stateDir: string): RatingsState {
  let text: string;
  try { text = readFileSync(ratingsStateFile(stateDir), "utf8"); } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { version: 1 };
    throw e;
  }
  const parsed = JSON.parse(text) as Partial<RatingsState>;
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) throw new Error("site-ratings.json: unknown format.");
  if (parsed.resetAt !== undefined && (typeof parsed.resetAt !== "string" || !Number.isFinite(Date.parse(parsed.resetAt))))
    throw new Error("site-ratings.json: resetAt is not a time.");
  return { version: 1, ...(parsed.resetAt ? { resetAt: parsed.resetAt } : {}) };
}

/** A cache stamp for the state file (size + mtime; "none" when absent). */
export function ratingsStateStamp(stateDir: string): string {
  try { const st = statSync(ratingsStateFile(stateDir)); return `${st.size}:${st.mtimeMs}`; } catch { return "none"; }
}

export function writeRatingsReset(stateDir: string, at: Date): RatingsState {
  const next: RatingsState = { version: 1, resetAt: at.toISOString() };
  atomicWriteTextFile(ratingsStateFile(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
