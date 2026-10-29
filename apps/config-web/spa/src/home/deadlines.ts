// Deadline rows as GET /api/me/deadlines sends them, plus the page-side helpers: the chip is recomputed against the
// viewer's clock (a server-rendered or cached list never shows a stale colour) and times render in the coach's
// timezone (the saved one, else the browser's).

export type DeadlineChip = "ok" | "soon" | "urgent" | "overdue";

export interface DeadlineView {
  id: string;
  kind: string;
  title: string;
  detail: string;
  at: string;
  chip: DeadlineChip;
  link: string;
}

const HOUR = 3_600_000;

/** Green > 72 h, amber < 72 h, scarlet < 24 h, grey once passed (same horizons as the server). */
export function chipFor(at: string, now: Date): DeadlineChip {
  const left = Date.parse(at) - now.getTime();
  if (!Number.isFinite(left) || left < 0) return "overdue";
  if (left < 24 * HOUR) return "urgent";
  if (left < 72 * HOUR) return "soon";
  return "ok";
}

/** CSS class per chip (home.css: green / amber / scarlet / grey). */
export const CHIP_CLASS: Record<DeadlineChip, string> = { ok: "hm-chip-ok", soon: "hm-chip-soon", urgent: "hm-chip-urgent", overdue: "hm-chip-overdue" };

/** Short "time left" text: "in 4 d", "in 5 h", "in 20 min", "3 h ago". */
export function timeLeft(at: string, now: Date): string {
  const ms = Date.parse(at) - now.getTime();
  if (!Number.isFinite(ms)) return "";
  const abs = Math.abs(ms);
  const text = abs >= 48 * HOUR ? `${Math.round(abs / (24 * HOUR))} d` : abs >= HOUR ? `${Math.round(abs / HOUR)} h` : `${Math.max(1, Math.round(abs / 60000))} min`;
  return ms < 0 ? `${text} ago` : `in ${text}`;
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}

export function validTimeZone(tz: string): boolean {
  if (!tz) return false;
  try { new Intl.DateTimeFormat("en-GB", { timeZone: tz }); return true; } catch { return false; }
}

/** "Sat 31 Oct, 11:00" in the given timezone (falls back to UTC for an unknown zone). */
export function formatWhen(at: string, timeZone: string): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const zone = validTimeZone(timeZone) ? timeZone : "UTC";
  return new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(t));
}
