// SPA theme: follows the device (prefers-color-scheme) by default, live, with System / Light / Dark as an explicit
// choice that overrides it (remembered per viewer when storage allows). Dark = the Black/Red preset (the recorder
// draws its SNES dark look), light = the FUMBBL preset (the recorder draws its SNES grey look). Also keeps the
// browser chrome (theme-color meta) in step.

import { reactive, type InjectionKey } from "vue";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "spa-theme-mode";
export const THEME_COLORS: Record<ResolvedTheme, string> = { dark: "#0b0d12", light: "#d4d5e0" };
const PRESET: Record<ResolvedTheme, string> = { dark: "brand-red", light: "fumbbl" };
const QUERY = "(prefers-color-scheme: dark)";

interface MediaLike { matches: boolean; addEventListener?: (type: "change", fn: (e: { matches: boolean }) => void) => void }
interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }
interface DocLike {
  documentElement?: { setAttribute(name: string, value: string): void };
  head?: { appendChild(node: unknown): unknown };
  querySelector?(sel: string): { setAttribute(name: string, value: string): void } | null;
  createElement?(tag: string): { setAttribute(name: string, value: string): void };
}

export interface ThemeDeps {
  matchMedia?: (query: string) => MediaLike;
  storage?: StorageLike;
  doc?: DocLike;
}

export function createTheme(deps: ThemeDeps = {}) {
  const g = globalThis as { matchMedia?: ThemeDeps["matchMedia"]; localStorage?: StorageLike; document?: DocLike };
  const mm = deps.matchMedia ?? g.matchMedia?.bind(globalThis);
  const doc = deps.doc ?? g.document;
  let storage: StorageLike | undefined;
  try { storage = deps.storage ?? g.localStorage; } catch { storage = undefined; }

  let stored: ThemeMode = "system";
  try {
    const v = storage?.getItem(THEME_STORAGE_KEY);
    if (v === "light" || v === "dark") stored = v;
  } catch { /* system */ }

  let media: MediaLike | undefined;
  try { media = mm?.(QUERY); } catch { media = undefined; }

  const state = reactive<{ mode: ThemeMode; systemDark: boolean; resolved: ResolvedTheme }>({
    mode: stored, systemDark: media ? media.matches : true, resolved: "dark",
  });

  function apply(): void {
    state.resolved = state.mode === "system" ? (state.systemDark ? "dark" : "light") : state.mode;
    try {
      doc?.documentElement?.setAttribute("data-theme", PRESET[state.resolved]);
      let meta = doc?.querySelector?.('meta[name="theme-color"]') ?? null;
      if (!meta && doc?.createElement) {
        meta = doc.createElement("meta");
        meta.setAttribute("name", "theme-color");
        doc.head?.appendChild(meta);
      }
      meta?.setAttribute("content", THEME_COLORS[state.resolved]);
    } catch { /* no DOM (tests, SSR) */ }
  }

  // The system setting is re-read live: a change flips the theme unless an explicit choice is stored.
  try {
    media?.addEventListener?.("change", (e) => { state.systemDark = e.matches; apply(); });
  } catch { /* old browsers */ }
  apply();

  return {
    state,
    setMode(mode: ThemeMode): void {
      state.mode = mode;
      try { if (mode === "system") storage?.setItem(THEME_STORAGE_KEY, "system"); else storage?.setItem(THEME_STORAGE_KEY, mode); } catch { /* not remembered */ }
      apply();
    },
    /** System -> Light -> Dark -> System. */
    cycle(): void {
      this.setMode(state.mode === "system" ? "light" : state.mode === "light" ? "dark" : "system");
    },
  };
}

export type Theme = ReturnType<typeof createTheme>;
export const THEME_KEY: InjectionKey<Theme> = Symbol("theme");
export const themeLabel = (mode: ThemeMode): string => (mode === "system" ? "System" : mode === "light" ? "Light" : "Dark");
