// The page title: one reactive store for the shell header's h1 AND document.title (owner 10-30: every area's title
// lives in the top bar). Default = the route's meta.title; a view may override it (a league's name, "<Home> vs <Away>")
// through usePageTitle(). An override belongs to the route path it was set on, so it never shows on the next page
// while the old view is still unmounting.

import { computed, inject, onBeforeUnmount, reactive, toValue, watch, type ComputedRef, type InjectionKey, type MaybeRefOrGetter } from "vue";
import { useRoute } from "vue-router";

export const SITE_NAME = "Super FUMBBL";

export interface PageTitleStore {
  readonly state: { text: string; path: string; owner: number; blank: boolean; blankName: string; sectionPath: string };
  /** Claims the override for a path; the returned handle sets and releases it (a stale handle cannot clear a newer one). */
  claim(path: string, name?: string): { set(text: string): void; blank(): void; release(): void };
}

export const PAGE_TITLE_KEY: InjectionKey<PageTitleStore> = Symbol("page-title");

export function createPageTitle(): PageTitleStore {
  const state = reactive({ text: "", path: "", owner: 0, blank: false, blankName: "", sectionPath: "" });
  let next = 0;
  return {
    state,
    claim(path, name = "") {
      const id = ++next;
      state.owner = id; state.path = path; state.text = ""; state.blank = false; state.blankName = name;
      return {
        set(text) { if (state.owner === id) { state.text = text.trim(); state.blank = false; } },
        blank() { if (state.owner === id) { state.text = ""; state.blank = true; } },
        release() { if (state.owner === id) { state.owner = 0; state.path = ""; state.text = ""; state.blank = false; state.blankName = ""; } },
      };
    },
  };
}

/** A view's own page title (reactive; empty or undefined falls back to the route's meta.title). */
export function usePageTitle(source: MaybeRefOrGetter<string | null | undefined>): void {
  const store = inject(PAGE_TITLE_KEY, null);
  if (!store) return;
  const handle = store.claim(useRoute().path);
  watch(() => toValue(source) ?? "", (text) => handle.set(text), { immediate: true });
  onBeforeUnmount(() => handle.release());
}

/** A view that wants NO page title in the header (the signed-out landing): an explicit empty title, not the meta.title fallback. */
export function useBlankPageTitle(): void {
  const store = inject(PAGE_TITLE_KEY, null);
  if (!store) return;
  // Keyed to the route NAME: /home, /home/?x=1 and /home#x are the same page and keep the same mounted view.
  const route = useRoute();
  const handle = store.claim(route.path, String(route.name ?? ""));
  handle.blank();
  onBeforeUnmount(() => handle.release());
}

/**
 * Inside a league, tournament or series the section header carries the name (owner 11-02): the page that shows a section
 * header marks its path, and the top bar keeps the title for assistive tech and the document title only.
 */
export function useSectionTitle(): void {
  const store = inject(PAGE_TITLE_KEY, null);
  if (!store) return;
  const route = useRoute();
  const me = ++sectionClaims;
  sectionOwner.set(store, me);
  store.state.sectionPath = route.path;
  // a later section header (the next page) takes over; this one only follows its own page and releases only its own claim
  watch(() => route.path, (p) => { if (sectionOwner.get(store) === me) store.state.sectionPath = p; });
  onBeforeUnmount(() => { if (sectionOwner.get(store) === me) store.state.sectionPath = ""; });
}
let sectionClaims = 0;
const sectionOwner = new WeakMap<PageTitleStore, number>();

/** True while the current page shows a section header (the top bar title is then visually hidden). */
export function useInSection(): ComputedRef<boolean> {
  const store = inject(PAGE_TITLE_KEY)!;
  const route = useRoute();
  return computed(() => store.state.sectionPath !== "" && store.state.sectionPath === route.path);
}

/** The shell's title for the current route (override > meta.title); also keeps document.title in sync (the one place). */
export function useShellTitle(): ComputedRef<string> {
  const store = inject(PAGE_TITLE_KEY)!;
  const route = useRoute();
  const title = computed(() => {
    const mine = store.state.path === route.path;
    if (store.state.blank && store.state.blankName !== "" && store.state.blankName === String(route.name ?? "")) return "";
    return store.state.text && mine ? store.state.text : route.meta.title ?? "";
  });
  watch(title, (t) => { if (typeof document !== "undefined") document.title = documentTitle(t); }, { immediate: true });
  return title;
}

export function documentTitle(title: string): string {
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}
