// League page, Awards tab (owner 11-02): the Cards | Table switch (remembered per viewer), the cards grouped by season
// (newest first, pinned first within a season) and the sortable flat table. Pure helpers; no DOM except the guarded
// localStorage access.

import { awardDate, type AwardView } from "./honours";

export type AwardsLayout = "cards" | "table";
export const AWARDS_VIEW_KEY = "sf-league-awards-view";

export function readAwardsLayout(): AwardsLayout {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(AWARDS_VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; }
}
export function writeAwardsLayout(v: AwardsLayout): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(AWARDS_VIEW_KEY, v); } catch { /* no storage */ }
}

export interface AwardGroup { key: string; title: string; awards: AwardView[] }

/** Cards by season: the league's seasons newest first (as `seasons` lists them), league-wide awards last; pinned awards
 *  first within a group, otherwise the server's order (newest first). Empty groups are left out. */
export function groupAwardsBySeason(awards: readonly AwardView[], seasons: ReadonlyArray<{ id: string; name: string }>, pinned: ReadonlySet<string>): AwardGroup[] {
  const pinFirst = (list: AwardView[]): AwardView[] => [...list.filter((a) => pinned.has(a.id)), ...list.filter((a) => !pinned.has(a.id))];
  const known = new Set(seasons.map((s) => s.id));
  const groups: AwardGroup[] = seasons.map((s) => ({ key: s.id, title: s.name, awards: pinFirst(awards.filter((a) => a.seasonId === s.id)) }));
  // a season the list does not name (removed, or not yet listed) keeps its own group, by its name on the award
  const others = new Map<string, AwardView[]>();
  for (const a of awards) if (a.seasonId && !known.has(a.seasonId)) others.set(a.seasonId, [...(others.get(a.seasonId) ?? []), a]);
  for (const [id, list] of others) groups.push({ key: id, title: list[0]!.seasonName ?? id, awards: pinFirst(list) });
  groups.push({ key: "league", title: "League-wide", awards: pinFirst(awards.filter((a) => !a.seasonId)) });
  return groups.filter((g) => g.awards.length);
}

export type AwardSortKey = "award" | "team" | "coach" | "race" | "season" | "date" | "note";
export type SortDir = "asc" | "desc";
export const AWARD_COLUMNS: ReadonlyArray<{ key: AwardSortKey; label: string }> = [
  { key: "award", label: "Award" }, { key: "team", label: "Team" }, { key: "coach", label: "Coach" }, { key: "race", label: "Race" },
  { key: "season", label: "Season" }, { key: "date", label: "Date" }, { key: "note", label: "Note" },
];

/** The table's flat list sorted by a column (stable; empty values last either way). Season sorts by the league's season
 *  order (ascending = oldest first, league-wide awards before any season), date by the award's timestamp. */
export function sortAwards(awards: readonly AwardView[], key: AwardSortKey, dir: SortDir, seasons: ReadonlyArray<{ id: string }>): AwardView[] {
  const order = new Map(seasons.map((s, i) => [s.id, seasons.length - i])); // newest first in `seasons`: oldest gets 1
  const val = (a: AwardView): string | number => {
    switch (key) {
      case "award": return a.title;
      case "team": return a.toTeam ?? "";
      case "coach": return a.toCoach ?? "";
      case "race": return a.race ?? "";
      case "note": return a.note ?? "";
      case "season": return a.seasonId ? order.get(a.seasonId) ?? 0 : -1;
      case "date": { const t = a.at ? Date.parse(a.at) : NaN; return Number.isFinite(t) ? t : ""; }
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return awards.map((a, i) => ({ a, i, v: val(a) })).sort((x, y) => {
    const ex = x.v === "", ey = y.v === "";
    if (ex !== ey) return ex ? 1 : -1;
    const c = typeof x.v === "number" && typeof y.v === "number" ? x.v - y.v : String(x.v).localeCompare(String(y.v), undefined, { sensitivity: "base" });
    return c ? c * sign : x.i - y.i;
  }).map((x) => x.a);
}

/** "Season 5 · 16 Jul 2026" (the parts that are set; "League-wide" for an award without a season). */
export const awardWhen = (a: Pick<AwardView, "seasonName" | "seasonId" | "at">): string =>
  [a.seasonName ?? (a.seasonId ? "" : "League-wide"), awardDate(a)].filter(Boolean).join(" · ");
