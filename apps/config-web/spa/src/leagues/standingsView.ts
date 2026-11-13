// League page, Standings tab: the phase selector (owner 11-02). Pure helpers over the server-derived tables
// (league.ts standingsTables); no DOM.

import { fixturePlayed, phaseTitle, type StandingsTable } from "./league";
import type { SeasonRecord, StandingRow } from "./types";
import { filterList, listCount } from "../shared/listView";

export interface StandingsPhaseOption { id: string; title: string }
export type StandingsPick = string; // a phase id, or "all"

/** The table's phase id (table keys are "<phaseId>:<group>"; the group never holds the phase). */
export const tablePhase = (season: Pick<SeasonRecord, "phases">, t: Pick<StandingsTable, "key">): string =>
  season.phases.find((p) => t.key.startsWith(`${p.id}:`))?.id ?? "";

/** The phases that have a table, in season order. */
export function standingsPhaseOptions(season: Pick<SeasonRecord, "phases">, tables: readonly Pick<StandingsTable, "key">[]): StandingsPhaseOption[] {
  const ids = new Set(tables.map((t) => tablePhase(season, t)));
  return season.phases.filter((p) => ids.has(p.id)).map((p) => ({ id: p.id, title: phaseTitle(p) }));
}

/** The phase to open on: the one being played (the first phase with an unplayed fixture, or the latest table before it
 *  when that phase has no table yet, e.g. a knockout), else the last phase with a table. */
export function currentStandingsPhase(season: Pick<SeasonRecord, "phases" | "fixtures">, options: readonly StandingsPhaseOption[]): string {
  if (!options.length) return "all";
  const order = season.phases.map((p) => p.id);
  const live = order.findIndex((id) => season.fixtures.some((f) => f.phaseId === id && !fixturePlayed(f)));
  const withTable = options.map((o) => ({ id: o.id, at: order.indexOf(o.id) }));
  const upTo = live < 0 ? withTable : withTable.filter((o) => o.at <= live);
  return (upTo[upTo.length - 1] ?? withTable[withTable.length - 1])!.id;
}

/** The ?phase= value the page honours: a phase with a table or "all"; anything else is the current phase. */
export function pickStandingsPhase(asked: unknown, options: readonly StandingsPhaseOption[], current: string): StandingsPick {
  const v = Array.isArray(asked) ? asked[0] : asked;
  if (v === "all") return "all";
  return typeof v === "string" && options.some((o) => o.id === v) ? v : current;
}

/** The Standings filter box (league pages treatment, owner 11-13): team, coach or race; rows keep their rank. With several
 *  divisions on show (`multi`: the filter bar sits above them) a division without a matching row drops out while
 *  filtering, and `none` says nothing matched anywhere; one division always stays (it holds the filter). */
export function filterStandings<T extends { rows: StandingRow[] }>(tables: readonly T[], query: string): {
  tables: Array<T & { shownRows: StandingRow[] }>; multi: boolean; filtering: boolean; none: boolean; count: string;
} {
  const filtering = Boolean(query.trim());
  const multi = tables.length > 1;
  const all = tables.map((t) => ({ ...t, shownRows: filterList(t.rows, query, (r) => [r.team, r.coach, r.race]) }));
  const shown = multi && filtering ? all.filter((t) => t.shownRows.length) : all;
  const matched = all.reduce((n, t) => n + t.shownRows.length, 0);
  return { tables: shown, multi, filtering, none: filtering && matched === 0, count: listCount(matched, tables.reduce((n, t) => n + t.rows.length, 0), "team") };
}
