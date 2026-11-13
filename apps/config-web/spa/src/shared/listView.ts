// Cards / Table lists with a filter box (owner 11-13: My teams first, then the league pages): the remembered view per list
// kind and the text filter they all share. The view is read from localStorage only once the page is mounted, so server
// rendering (and the first client render it hydrates) always shows the list's default; the choice is per browser, guarded
// (blocked or missing storage = the default). The filter is client-side over rows already on the page: every typed word
// must appear in the row's text, ignoring case and accents.
import { inject, onMounted, ref, type InjectionKey, type Ref } from "vue";

export type ListView = "cards" | "table";

/** Stored keys (one per list kind). The fixtures key also serves the Overview's latest results (one choice for both). */
export const LIST_VIEW_KEYS = {
  myTeams: "sf.myTeams.view",
  fixtures: "sf-league-fixtures-view",
  awards: "sf-league-awards-view",
  champions: "sf-league-champions-view",
  participants: "sf-league-participants-view",
} as const;

const isView = (v: unknown): v is ListView => v === "cards" || v === "table";

/** The stored choice for `key`; `fallback` when nothing valid is stored or storage is blocked. */
export function readListView(key: string, fallback: ListView = "cards"): ListView {
  try {
    const v = typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
    return isView(v) ? v : fallback;
  } catch { return fallback; }
}

export function writeListView(key: string, v: ListView): void {
  try { if (typeof localStorage !== "undefined") localStorage.setItem(key, v); } catch { /* not remembered */ }
}

/** Server-rendered tests and previews only: the view a list starts in (by key) before the browser's choice is read. The
 *  app never provides it, so a page always renders and hydrates with the list's default. */
export const LIST_VIEW_START: InjectionKey<Partial<Record<string, ListView>>> = Symbol("list-view-start");

/** A list's Cards / Table view: `fallback` until mounted, then the remembered choice; `setView` remembers a new one. */
export function useListView(key: string, fallback: ListView = "cards"): { view: Ref<ListView>; setView: (v: ListView) => void } {
  const start = inject(LIST_VIEW_START, null)?.[key];
  const view = ref<ListView>(isView(start) ? start : fallback);
  onMounted(() => { view.value = readListView(key, fallback); });
  const setView = (v: ListView): void => { view.value = v; writeListView(key, v); };
  return { view, setView };
}

/** Lower case without accents ("Élan" and "elan" match). */
export const foldText = (s: string): string => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/** The words typed into a filter box (folded). */
export const queryWords = (query: string): string[] => foldText(query).split(/\s+/).filter(Boolean);

type Hay = string | number | null | undefined | ReadonlyArray<string | number | null | undefined>;
const hayText = (h: Hay): string => (Array.isArray(h) ? h.filter((x) => x !== null && x !== undefined).join(" ") : h === null || h === undefined ? "" : String(h));

/** True when every word appears in the text (no words = every row matches). */
export function matchesWords(words: readonly string[], row: Hay): boolean {
  if (!words.length) return true;
  const hay = foldText(hayText(row));
  return words.every((w) => hay.includes(w));
}

/** The rows matching every word typed (the whole list when the box is empty). */
export function filterList<T>(rows: readonly T[], query: string, hay: (row: T) => Hay): T[] {
  const words = queryWords(query);
  if (!words.length) return rows as T[];
  return rows.filter((r) => matchesWords(words, hay(r)));
}

/** "12 teams" or, while filtering, "3 of 12 teams". */
export function listCount(shown: number, total: number, one: string, many = `${one}s`): string {
  return shown === total ? `${total} ${total === 1 ? one : many}` : `${shown} of ${total} ${total === 1 ? one : many}`;
}
