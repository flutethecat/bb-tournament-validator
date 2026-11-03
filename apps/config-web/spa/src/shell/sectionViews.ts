// Light section tab views built from data the pages already load (spec-section-header: "If a tab has no view yet but its
// data exists elsewhere, build a light view from existing API data only"): a league season's Draws (the pairings round
// by round; LeagueDraws.vue) and the round labels. The Calendar's model is leagues/seasonCalendar.ts.

import { phaseLabel } from "../leagues/league";
import type { LeagueFixture } from "../leagues/types";

/** "Round 3", or "Playoffs · Round 1" outside the regular phase. */
export function roundLabel(f: Pick<LeagueFixture, "phase" | "round" | "group">): string {
  const phase = f.phase && f.phase !== "Regular" ? `${phaseLabel(f.phase)} · ` : "";
  return `${phase}${f.group ? `${f.group} · ` : ""}Round ${f.round}`;
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
