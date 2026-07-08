/**
 * FUMBBL40k daily summary — reads the shared end-of-day file that all three
 * cross-session tracks (40k Default-UI, FUMBBL Classic, Tournament Bot) append to
 * (fumbbl40k-client/docs/daily-summary.md, newest day at the top). We read the file
 * directly rather than waiting on a cross-session message, so publishing doesn't
 * depend on the compiling session surviving to send it (it may reset/hit context
 * limits right after compiling, as happened 2026-07-08).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface DailySummary {
  date: string;
  body: string;
}

/** Where the shared daily summary lives (both repos are on this box). Env-overridable. */
export function dailySummaryPath(): string {
  return (
    process.env.FORK_DAILY_SUMMARY ||
    "C:\\Users\\Jay\\Documents\\Claude\\fumbbl40k-client\\docs\\daily-summary.md"
  );
}

/**
 * Parse the topmost "## YYYY-MM-DD" section (newest day is always first per the
 * file's convention). The body runs to the first "---" divider or the next "## "
 * heading, whichever comes first — this excludes same-day appendix sections (e.g.
 * "## Smoke test — ...") that follow the day's own track subsections.
 */
export function readTopDailySummary(path = dailySummaryPath()): DailySummary | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  const m = text.match(/^## (\d{4}-\d{2}-\d{2})\s*$/m);
  if (!m || m.index == null) return undefined;
  const date = m[1]!;
  const rest = text.slice(m.index + m[0].length);
  const boundaries = [rest.search(/\n---\s*\n/), rest.search(/\n## /)].filter((i) => i !== -1);
  const cutIdx = boundaries.length ? Math.min(...boundaries) : -1;
  const body = (cutIdx === -1 ? rest : rest.slice(0, cutIdx)).trim();
  if (!body) return undefined;
  return { date, body };
}

/** Persisted last-announced date so a re-check doesn't double-post the same day. */
export class DailySummaryState {
  constructor(private readonly filePath: string) {}

  private read(): { date?: string } {
    if (!existsSync(this.filePath)) return {};
    try {
      return JSON.parse(readFileSync(this.filePath, "utf8")) as { date?: string };
    } catch {
      return {};
    }
  }

  private write(d: { date?: string }): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(d, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }

  /** True when nothing has been announced/seeded yet (very first run). */
  isEmpty(): boolean {
    return !this.read().date;
  }

  isNew(d: DailySummary): boolean {
    return this.read().date !== d.date;
  }

  mark(d: DailySummary): void {
    this.write({ date: d.date });
  }
}
