// Global site search (owner 11-04): the client side of GET /api/search (server src/search/index.ts). Pure helpers for the
// header search bar's quick results and the Search page: the request path, the result groups in display order, keyboard
// movement and the Search page's route query. The filters are the shared ones (src/search/filters.ts). No DOM.

import {
  competitionFilterParams, competitionFiltersActive, emptyCompetitionFilters, parseCompetitionFilters, type CompetitionFilters,
} from "../../../src/search/filters";

export type SearchType = "leagues" | "tournaments" | "clubs" | "coaches" | "teams";
export const SEARCH_TYPES: readonly SearchType[] = ["leagues", "tournaments", "clubs", "coaches", "teams"];
export const TYPE_LABEL: Readonly<Record<SearchType, string>> = { leagues: "Leagues", tournaments: "Tournaments", clubs: "Clubs", coaches: "Coaches", teams: "Teams" };
/** Leagues and tournaments take the competition filters (ruleset, region, format, played on, open). */
export const FILTERED_TYPES: ReadonlySet<SearchType | "all"> = new Set(["all", "leagues", "tournaments"]);

/** The server's query cap (src/search/index.ts QUERY_MAX). */
export const QUERY_MAX = 100;
/** Quick results ask for this many per group. */
export const QUICK_LIMIT = 4;
export const PAGE_LIMIT = 20;
/** Typing pause before a quick search is sent. */
export const QUICK_DELAY_MS = 160;

export interface SearchItem {
  type: SearchType;
  id: string;
  title: string;
  subtitle?: string;
  url: string;
  image?: string;
  chips?: string[];
  draft?: true;
  matched?: string;
}
export interface SearchGroup { items: SearchItem[]; total: number; more: boolean }
export interface SearchResponse {
  q: string;
  type: SearchType | "all";
  groups: Partial<Record<SearchType, SearchGroup>>;
  facets: { rulesets: string[]; countries: Array<{ code: string; name: string }> };
}

export interface SearchParams {
  q: string;
  type: SearchType | "all";
  filters?: CompetitionFilters;
  limit?: number;
  offset?: number;
}

/** The GET /api/search path for a request (blank values left out). */
export function searchPath(p: SearchParams): string {
  const qs = new URLSearchParams();
  const q = p.q.trim().slice(0, QUERY_MAX);
  if (q) qs.set("q", q);
  if (p.type !== "all") qs.set("type", p.type);
  if (p.filters && FILTERED_TYPES.has(p.type)) for (const [k, v] of competitionFilterParams(p.filters)) qs.append(k, v);
  if (p.limit) qs.set("limit", String(p.limit));
  if (p.offset) qs.set("offset", String(p.offset));
  const s = qs.toString();
  return `/api/search${s ? `?${s}` : ""}`;
}

/** The groups that have results, in display order. */
export function filledGroups(res: Pick<SearchResponse, "groups"> | null | undefined): Array<{ type: SearchType; group: SearchGroup }> {
  if (!res) return [];
  return SEARCH_TYPES.flatMap((type) => {
    const group = res.groups[type];
    return group && group.items.length ? [{ type, group }] : [];
  });
}

/** Every quick result in display order (the keyboard walks this list). */
export function flatItems(res: Pick<SearchResponse, "groups"> | null | undefined): SearchItem[] {
  return filledGroups(res).flatMap((g) => g.group.items);
}

/** The next highlighted row for an arrow key: wraps; -1 (nothing highlighted) goes to the first or the last row. */
export function moveActive(current: number, delta: 1 | -1, count: number): number {
  if (count <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : count - 1;
  return (current + delta + count) % count;
}

/** A stable DOM id for a quick result (aria-activedescendant). */
export const optionId = (prefix: string, item: Pick<SearchItem, "type" | "id">): string =>
  `${prefix}-${item.type}-${item.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** "/" focuses the search unless the key is typed into a field or carries a modifier. */
export function isSlashShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">, typing: boolean): boolean {
  return e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing;
}

/** Two letters for a result without an image. */
export function initialsOf(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

/** Only same-site paths: an image route of this site (never an off-site URL). */
export const safeImage = (src: string | undefined): string => (src && /^\/api\/[\w./%?=&-]+$/.test(src) ? src : "");

// ---- the Search page's route query ----

export interface SearchRoute { q: string; type: SearchType | "all"; filters: CompetitionFilters }

const one = (v: unknown): string => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");

/** The Search page state from ?q=&type=&ruleset=&country=&region=&format=&playedOn=&open=. */
export function routeState(query: Record<string, unknown>): SearchRoute {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string") qs.append(k, x);
  }
  const type = one(query.type);
  return {
    q: one(query.q).slice(0, QUERY_MAX),
    type: (SEARCH_TYPES as readonly string[]).includes(type) ? (type as SearchType) : "all",
    filters: parseCompetitionFilters(qs),
  };
}

/** The route query for a Search page state (only the set values). */
export function routeQuery(s: SearchRoute): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (s.q.trim()) out.q = s.q.trim();
  if (s.type !== "all") out.type = s.type;
  if (FILTERED_TYPES.has(s.type)) {
    for (const [k, v] of competitionFilterParams(s.filters)) {
      const prev = out[k];
      out[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
    }
  }
  return out;
}

export { competitionFiltersActive, emptyCompetitionFilters };
export type { CompetitionFilters };

/** The Search page link for a query ("See all results"). */
export const searchPageLink = (q: string): { name: "search"; query: Record<string, string> } => ({ name: "search", query: q.trim() ? { q: q.trim().slice(0, QUERY_MAX) } : {} });
