// Browse leagues (/app/leagues, owner 11-02): pure helpers for the postcard and table views. Status and play mode per
// league, the search over every public identifying field the list row carries (server src/leagues/browse.ts), the
// filter chips, table sorting and the remembered Cards | Table choice. No DOM.

import { seasonDates } from "./league";
import type { LeagueBrowseStatus, LeagueSummary } from "./types";

export const BROWSE_STATUSES: readonly LeagueBrowseStatus[] = ["in-progress", "registration", "finished", "off-season"];
export const BROWSE_STATUS_LABEL: Readonly<Record<LeagueBrowseStatus, string>> = {
  "in-progress": "In progress", registration: "Registration open", finished: "Finished", "off-season": "Off-season",
};
export const BROWSE_STATUS_TONE: Readonly<Record<LeagueBrowseStatus, string>> = {
  "in-progress": "soon", registration: "ok", finished: "info", "off-season": "muted",
};

export type PlayedOn = "tabletop" | "fork";
export const PLAYED_ON_LABEL: Readonly<Record<PlayedOn, string>> = { tabletop: "Tabletop", fork: "Super FUMBBL" };

/** The league's status: the server's browse status, else derived from the newest season's stage (older servers). */
export function browseStatus(l: Pick<LeagueSummary, "browse" | "currentSeason">): LeagueBrowseStatus {
  if (l.browse && BROWSE_STATUSES.includes(l.browse.status)) return l.browse.status;
  const s = l.currentSeason;
  if (!s) return "off-season";
  const stage = s.stage ?? (s.status === "completed" ? "completed" : "active");
  return stage === "active" ? "in-progress" : stage === "registration" ? "registration" : stage === "completed" ? "finished" : "off-season";
}

export const playedOn = (l: Pick<LeagueSummary, "playOnFork">): PlayedOn => (l.playOnFork ? "fork" : "tabletop");

/** Town / state, else the organiser's regions, else "". */
export function leagueRegion(l: Pick<LeagueSummary, "browse">): string {
  return l.browse?.location || (l.browse?.regions ?? []).join(", ");
}

/** The ruleset as the table shows it: the ruleset card's name with the edition, or the edition alone. */
export function rulesetText(l: Pick<LeagueSummary, "rulesetPackage" | "currentSeason">): string {
  const edition = l.currentSeason?.ruleset ?? "";
  if (l.rulesetPackage && edition && l.rulesetPackage !== edition) return `${l.rulesetPackage} (${edition})`;
  return l.rulesetPackage || edition;
}

export const teamCount = (l: Pick<LeagueSummary, "currentSeason">): number | null => (l.currentSeason ? l.currentSeason.teamCount : null);
export const dateText = (l: Pick<LeagueSummary, "currentSeason">): string => (l.currentSeason ? seasonDates(l.currentSeason) : "");

// ---- search ----

/** Case- and accent-folded text plus, for each folded character, the index of the original character it came from. */
export function fold(text: string): { text: string; map: number[]; ends: number[] } {
  let out = "";
  const map: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
    for (let k = 0; k < f.length; k++) { map.push(i); ends.push(i + ch.length); }
    out += f;
    i += ch.length;
  }
  return { text: out, map, ends };
}

export const foldQuery = (q: string): string => fold(q.trim().replace(/\s+/g, " ")).text;

export interface SearchField { field: string; label: string; value: string }
export interface SearchHit extends SearchField { start: number; end: number }

/** Every public identifying value of a league, in the order a hit is reported (the first matching field wins). */
export function searchFields(l: LeagueSummary): SearchField[] {
  const out: SearchField[] = [];
  const push = (field: string, label: string, value: unknown) => {
    if (typeof value === "string" && value.trim()) out.push({ field, label, value });
  };
  push("name", "name", l.name);
  push("fullName", "full name", l.fullName);
  push("slug", "address", l.slug);
  if (l.id !== l.slug) push("slug", "address", l.id);
  for (const o of l.organisers ?? []) push("organiser", "organiser", o);
  push("region", "region", l.browse?.location);
  for (const r of l.browse?.regions ?? []) push("region", "region", r);
  push("ruleset", "ruleset", l.rulesetPackage);
  push("ruleset", "ruleset", l.currentSeason?.ruleset);
  push("status", "status", BROWSE_STATUS_LABEL[browseStatus(l)]);
  push("playedOn", "played on", PLAYED_ON_LABEL[playedOn(l)]);
  const seasons = l.browse?.seasons ?? (l.currentSeason ? [l.currentSeason.name] : []);
  for (const s of seasons) push("season", "season", s);
  for (const t of l.browse?.teams ?? []) push("team", "team", t.name);
  for (const t of l.browse?.teams ?? []) push("coach", "coach", t.coach);
  push("description", "description", l.description);
  return out;
}

/** The first field the (folded, trimmed) query appears in, with the matched range in the ORIGINAL value; null = no match. */
export function matchLeague(l: LeagueSummary, query: string): SearchHit | null {
  const q = foldQuery(query);
  if (!q) return null;
  for (const f of searchFields(l)) {
    const folded = fold(f.value);
    const at = folded.text.indexOf(q);
    if (at < 0) continue;
    return { ...f, start: folded.map[at]!, end: folded.ends[at + q.length - 1]! };
  }
  return null;
}

/** The value cut into plain and marked parts for the hit's range (the whole value plain when the range is not in it). */
export function highlightParts(value: string, hit: Pick<SearchHit, "start" | "end"> | null | undefined): Array<{ text: string; mark: boolean }> {
  if (!hit || hit.start < 0 || hit.end > value.length || hit.end <= hit.start) return [{ text: value, mark: false }];
  return [
    { text: value.slice(0, hit.start), mark: false },
    { text: value.slice(hit.start, hit.end), mark: true },
    { text: value.slice(hit.end), mark: false },
  ].filter((p) => p.text !== "");
}

/** A long value (a description) shortened around the hit, the range moved with it. */
export function hitSnippet(hit: SearchHit, room = 48): SearchHit {
  if (hit.value.length <= room * 2 + 10) return hit;
  const from = Math.max(0, hit.start - room);
  const to = Math.min(hit.value.length, hit.end + room);
  const lead = from > 0 ? "…" : "";
  const value = `${lead}${hit.value.slice(from, to)}${to < hit.value.length ? "…" : ""}`;
  return { ...hit, value, start: hit.start - from + lead.length, end: hit.end - from + lead.length };
}

/** The ?q= value as the search field takes it ("" when absent or repeated), capped at 200 characters. */
export const routeQuery = (raw: unknown): string => (typeof raw === "string" ? raw.slice(0, 200) : "");
/** A ?q= change the field must follow (a query-only navigation), not the echo of the field's own write. */
export const followsRouteQuery = (next: string, field: string): boolean => next.trim() !== field.trim();

// ---- filters ----

export interface BrowseFilters { statuses: LeagueBrowseStatus[]; playedOn: PlayedOn[]; registrationOpen: boolean }
export const emptyFilters = (): BrowseFilters => ({ statuses: [], playedOn: [], registrationOpen: false });
export const filtersActive = (f: BrowseFilters): boolean => f.statuses.length > 0 || f.playedOn.length > 0 || f.registrationOpen;

export function passesFilters(l: LeagueSummary, f: BrowseFilters): boolean {
  if (f.statuses.length && !f.statuses.includes(browseStatus(l))) return false;
  if (f.playedOn.length && !f.playedOn.includes(playedOn(l))) return false;
  if (f.registrationOpen && l.browse?.registrationOpen !== true) return false;
  return true;
}

export interface BrowseRow { l: LeagueSummary; hit: SearchHit | null }

/** Leagues that pass the filters and match the query (every league when the query is blank), in the given order. */
export function browseRows(leagues: readonly LeagueSummary[], query: string, filters: BrowseFilters): BrowseRow[] {
  const blank = !foldQuery(query);
  const rows: BrowseRow[] = [];
  for (const l of leagues) {
    if (!passesFilters(l, filters)) continue;
    const hit = blank ? null : matchLeague(l, query);
    if (!blank && !hit) continue;
    rows.push({ l, hit });
  }
  return rows;
}

// ---- table sorting ----

export type SortKey = "name" | "fullName" | "status" | "season" | "ruleset" | "teams" | "region" | "playedOn" | "dates";
export type SortDir = "asc" | "desc";
export const SORT_COLUMNS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: "name", label: "League" }, { key: "fullName", label: "Full name" }, { key: "status", label: "Status" },
  { key: "season", label: "Current season" }, { key: "ruleset", label: "Ruleset" }, { key: "teams", label: "Teams" },
  { key: "region", label: "Region" }, { key: "playedOn", label: "Played on" }, { key: "dates", label: "Dates" },
];

function sortValue(l: LeagueSummary, key: SortKey): string | number | null {
  switch (key) {
    case "name": return l.name;
    case "fullName": return l.fullName || null;
    case "status": return BROWSE_STATUSES.indexOf(browseStatus(l));
    case "season": return l.currentSeason ? l.currentSeason.name : null;
    case "ruleset": return rulesetText(l) || null;
    case "teams": return teamCount(l);
    case "region": return leagueRegion(l) || null;
    case "playedOn": return PLAYED_ON_LABEL[playedOn(l)];
    case "dates": { const t = Date.parse(l.currentSeason?.startedAt ?? ""); return Number.isNaN(t) ? null : t; }
  }
}

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });

/** Sorted copy; empty values always last, ties by name. */
export function sortRows<T extends { l: LeagueSummary }>(rows: readonly T[], key: SortKey, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a.l, key);
    const vb = sortValue(b.l, key);
    if (va === null && vb !== null) return 1;
    if (vb === null && va !== null) return -1;
    let c = 0;
    if (va !== null && vb !== null) c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
    // Current season: the shown name decides; the season number breaks ties between equal names.
    if (c === 0 && key === "season") c = (a.l.currentSeason?.number ?? 0) - (b.l.currentSeason?.number ?? 0);
    return c !== 0 ? c * sign : collator.compare(a.l.name, b.l.name);
  });
}

// ---- the remembered view ----

export type BrowseView = "cards" | "table";
export const BROWSE_VIEW_KEY = "sf-league-browse-view";
/** The viewer's last Cards | Table choice; cards when storage is missing, blocked or holds anything else. */
export function readBrowseView(): BrowseView {
  try { return typeof localStorage !== "undefined" && localStorage.getItem(BROWSE_VIEW_KEY) === "table" ? "table" : "cards"; } catch { return "cards"; }
}
export function writeBrowseView(v: BrowseView): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(BROWSE_VIEW_KEY, v); } catch { /* no storage */ }
}

/** A stable placeholder colour (0..3) for a league without a header bar image. */
export function placeholderTone(id: string): number {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return h % 4;
}
