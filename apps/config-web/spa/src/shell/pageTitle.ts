// The page title: one reactive store for the shell header's h1 AND document.title (owner 10-30: every area's title
// lives in the top bar). Default = the route's meta.title; a view may override it (a league's name, "<Home> vs <Away>")
// through usePageTitle(). An override belongs to the route path it was set on, so it never shows on the next page
// while the old view is still unmounting.

import { computed, inject, onBeforeUnmount, reactive, toValue, watch, type ComputedRef, type InjectionKey, type MaybeRefOrGetter } from "vue";
import { useRoute } from "vue-router";

export const SITE_NAME = "Super FUMBBL";

export interface PageTitleStore {
  readonly state: { text: string; path: string; owner: number };
  /** Claims the override for a path; the returned handle sets and releases it (a stale handle cannot clear a newer one). */
  claim(path: string): { set(text: string): void; release(): void };
}

export const PAGE_TITLE_KEY: InjectionKey<PageTitleStore> = Symbol("page-title");

export function createPageTitle(): PageTitleStore {
  const state = reactive({ text: "", path: "", owner: 0 });
  let next = 0;
  return {
    state,
    claim(path) {
      const id = ++next;
      state.owner = id; state.path = path; state.text = "";
      return {
        set(text) { if (state.owner === id) state.text = text.trim(); },
        release() { if (state.owner === id) { state.owner = 0; state.path = ""; state.text = ""; } },
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

/** The shell's title for the current route (override > meta.title); also keeps document.title in sync (the one place). */
export function useShellTitle(): ComputedRef<string> {
  const store = inject(PAGE_TITLE_KEY)!;
  const route = useRoute();
  const title = computed(() => (store.state.text && store.state.path === route.path ? store.state.text : route.meta.title ?? ""));
  watch(title, (t) => { if (typeof document !== "undefined") document.title = documentTitle(t); }, { immediate: true });
  return title;
}

export function documentTitle(title: string): string {
  return title ? `${title} · ${SITE_NAME}` : SITE_NAME;
}
