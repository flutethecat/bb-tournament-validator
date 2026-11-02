// Light section tab views built from data the pages already load (spec-section-header: "If a tab has no view yet but its
// data exists elsewhere, build a light view from existing API data only"): a league season's Calendar (fixtures by day)
// and Draws (the pairings round by round). Pure; LeagueCalendar.vue / LeagueDraws.vue render them.

import { fixturePlayed, phaseLabel } from "../leagues/league";
import type { LeagueFixture } from "../leagues/types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface CalendarGame { id: string; home: string; away: string; score: string; kind: "played" | "agreed" | "scheduled"; time: string; round: string }
export interface CalendarDay { key: string; dayNo: number; weekday: string; games: CalendarGame[] }
export interface CalendarMonth { key: string; label: string; count: number; days: CalendarDay[] }

const isDay = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);
const isoDay = (iso: string | undefined): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
};

/** "Round 3", or "Playoffs · Round 1" outside the regular phase. */
export function roundLabel(f: Pick<LeagueFixture, "phase" | "round" | "group">): string {
  const phase = f.phase && f.phase !== "Regular" ? `${phaseLabel(f.phase)} · ` : "";
  return `${phase}${f.group ? `${f.group} · ` : ""}Round ${f.round}`;
}

/**
 * The fixtures by UTC day, month by month (oldest first): a played game on the day it finished, an agreed game time on
 * its day (with the time, UTC), else the organiser's scheduled date. Fixtures with no date at all are only counted.
 */
export function fixtureCalendar(fixtures: readonly LeagueFixture[]): { months: CalendarMonth[]; undated: number } {
  const byDay = new Map<string, CalendarGame[]>();
  let undated = 0;
  for (const f of fixtures) {
    const played = fixturePlayed(f); // the league rule: a suspended 0-0 TourPlay row is not a result
    const finished = isoDay(f.finishedAt);
    const agreed = isoDay(f.scheduledTime?.start);
    const scheduled = f.date && isDay(f.date) ? f.date : "";
    const key = (played && finished) || agreed || scheduled || (played ? isoDay(f.startedAt) : "");
    if (!key) { undated += 1; continue; }
    const game: CalendarGame = {
      id: f.id, home: f.home.team, away: f.away.team, round: roundLabel(f),
      score: played ? `${f.home.score} - ${f.away.score}` : "",
      kind: played ? "played" : agreed ? "agreed" : "scheduled",
      time: !played && agreed && f.scheduledTime ? new Date(f.scheduledTime.start).toISOString().slice(11, 16) : "",
    };
    byDay.set(key, [...(byDay.get(key) ?? []), game]);
  }
  const months = new Map<string, CalendarMonth>();
  for (const key of [...byDay.keys()].sort()) {
    const [y, m, d] = key.split("-").map(Number) as [number, number, number];
    const mk = key.slice(0, 7);
    const month = months.get(mk) ?? { key: mk, label: `${MONTHS[m - 1]} ${y}`, count: 0, days: [] };
    const games = byDay.get(key)!;
    month.days.push({ key, dayNo: d, weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!, games });
    month.count += games.length;
    months.set(mk, month);
  }
  return { months: [...months.values()], undated };
}

export interface DrawPairing { id: string; table: number; home: { team: string; coach: string }; away: { team: string; coach: string } }
export interface DrawRound { key: string; label: string; pairings: DrawPairing[] }

/** The season's draw: every round's pairings in phase and round order, table by table (no results). */
export function drawRounds(fixtures: readonly LeagueFixture[]): DrawRound[] {
  const rounds = new Map<string, DrawRound & { order: [number, number] }>();
  const phaseOrder: string[] = [];
  for (const f of fixtures) {
    if (!phaseOrder.includes(f.phaseId)) phaseOrder.push(f.phaseId);
    const key = `${f.phaseId}|${f.group}|${f.round}`;
    const r = rounds.get(key) ?? { key, label: roundLabel(f), pairings: [], order: [phaseOrder.indexOf(f.phaseId), f.round] };
    r.pairings.push({ id: f.id, table: f.table, home: { team: f.home.team, coach: f.home.coach }, away: { team: f.away.team, coach: f.away.coach } });
    rounds.set(key, r);
  }
  return [...rounds.values()]
    .sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1] || a.label.localeCompare(b.label))
    .map(({ key, label, pairings }) => ({ key, label, pairings: [...pairings].sort((a, b) => a.table - b.table) }));
}
