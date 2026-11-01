// League fixture deadlines, page side (server: src/leagues/deadlines.ts). The effective deadline is the fixture's own,
// else its round's; the chip is computed against the viewer's clock (amber < 72 h, scarlet < 24 h, "Overdue" after) and
// times show in the coach's timezone (saved, else the browser's). The organiser editor edits in the browser's timezone
// (datetime-local) and sends UTC ISO.

import { chipFor, formatWhen, timeLeft } from "../home/deadlines";
import type { DeadlineOutcome, LeagueFixture, SeasonRecord } from "./types";

export type DeadlineTone = "ok" | "soon" | "urgent" | "overdue" | "muted";
export interface FixtureDeadlineChip { label: string; tone: DeadlineTone; title: string; at?: string }

export const OUTCOME_LABEL: Record<DeadlineOutcome, string> = {
  review: "Overdue: needs organiser decision",
  "no-result": "No result (deadline)",
  "both-lose": "Both lose (deadline)",
};
/** The season setting's choices, as the organiser reads them. */
export const OUTCOME_CHOICES: Array<{ value: DeadlineOutcome; label: string; hint: string }> = [
  { value: "review", label: "Mark overdue for an organiser to decide", hint: "No score is entered; the fixture waits for you." },
  { value: "no-result", label: "No result", hint: "The fixture counts for nobody." },
  { value: "both-lose", label: "Both teams lose", hint: "A 0-0 with both sides conceding: a loss for each in the standings." },
];

export function roundDeadline(season: Pick<SeasonRecord, "roundDeadlines">, phaseId: string, round: number): string | undefined {
  return season.roundDeadlines?.find((r) => r.phaseId === phaseId && r.round === round)?.deadline;
}

/** The fixture's own deadline, else its round's. */
export function effectiveDeadline(season: Pick<SeasonRecord, "roundDeadlines">, f: Pick<LeagueFixture, "deadline" | "phaseId" | "round">): string | undefined {
  return f.deadline ?? roundDeadline(season, f.phaseId, f.round);
}

/** A result the deadline logic leaves alone (any score that is not the both-lose placeholder). */
export const hasRealResult = (f: LeagueFixture): boolean =>
  (f.home.score !== null || f.away.score !== null) && f.deadlineOutcome?.outcome !== "both-lose";

/** The chip a fixture row shows, or null (played, suspended, or no deadline). */
export function fixtureDeadlineChip(season: Pick<SeasonRecord, "roundDeadlines">, f: LeagueFixture, now: Date, timeZone: string): FixtureDeadlineChip | null {
  if (hasRealResult(f)) return null;
  const at = effectiveDeadline(season, f);
  const when = at ? `Deadline ${formatWhen(at, timeZone)}` : "Deadline";
  if (f.deadlineOutcome) {
    const o = f.deadlineOutcome.outcome;
    return { label: OUTCOME_LABEL[o], tone: o === "review" ? "urgent" : "muted", title: `${when}: ${OUTCOME_LABEL[o]}`, ...(at ? { at } : {}) };
  }
  if (f.suspended || !at) return null;
  return deadlineChip(at, now, timeZone);
}

/** A bare deadline chip (sidebar next fixture, fixture rows): muted "Due <when>" beyond 72 h. */
export function deadlineChip(at: string, now: Date, timeZone: string, needsDecision = false): FixtureDeadlineChip {
  const title = `Deadline ${formatWhen(at, timeZone)}`;
  if (needsDecision) return { label: OUTCOME_LABEL.review, tone: "urgent", title, at };
  const c = chipFor(at, now);
  if (c === "overdue") return { label: "Overdue", tone: "overdue", title, at };
  if (c === "ok") return { label: `Due ${formatWhen(at, timeZone)}`, tone: "muted", title, at };
  return { label: `Due ${timeLeft(at, now)}`, tone: c, title, at };
}

const pad = (n: number): string => String(n).padStart(2, "0");
/** UTC ISO -> a datetime-local value in the browser's timezone ("" for none). */
export function toLocalInput(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/**
 * A datetime-local value (browser timezone) -> an ISO instant with the explicit offset in force ("...T18:30:00+01:00"),
 * so the server never re-guesses the zone; null for empty or unreadable. When the value is what `saved` already shows,
 * `saved` itself comes back: an unchanged deadline is never re-derived (a DST-ambiguous hour would move it).
 */
export function fromLocalInput(v: string, saved?: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  if (saved && toLocalInput(saved) === v) return saved;
  const t = new Date(v).getTime();
  if (!Number.isFinite(t)) return null;
  const off = -new Date(t).getTimezoneOffset();
  const a = Math.abs(off);
  return `${v}:00${off >= 0 ? "+" : "-"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The organiser changed this input (a draft that differs from what the saved deadline shows). */
export const draftChanged = (draft: string | undefined, saved: string | undefined): boolean => draft !== undefined && draft !== toLocalInput(saved);

/** Every (phase, round) pair the season's fixtures use, phase order first, then round. */
export function deadlineRounds(season: Pick<SeasonRecord, "phases" | "fixtures">): Array<{ phaseId: string; phase: string; round: number }> {
  const rank = new Map<string, number>();
  for (const p of season.phases) if (!rank.has(p.id)) rank.set(p.id, rank.size);
  for (const f of season.fixtures) if (!rank.has(f.phaseId)) rank.set(f.phaseId, rank.size);
  const seen = new Map<string, { phaseId: string; phase: string; round: number }>();
  for (const f of season.fixtures) {
    const k = `${f.phaseId}#${f.round}`;
    if (!seen.has(k)) seen.set(k, { phaseId: f.phaseId, phase: season.phases.find((p) => p.id === f.phaseId)?.name ?? f.phase ?? f.phaseId, round: f.round });
  }
  return [...seen.values()].sort((a, b) => rank.get(a.phaseId)! - rank.get(b.phaseId)! || a.round - b.round);
}
