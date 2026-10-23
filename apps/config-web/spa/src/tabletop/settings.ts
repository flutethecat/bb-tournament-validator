// Per-viewer recorder options (the Settings cog). Remembered in this browser only; every storage call is guarded.

import { reactive, type InjectionKey } from "vue";
import { browserStorage, type QueueStorage } from "./queue";

export interface ViewerSettings {
  /** Tighter feed rows. */
  compact: boolean;
  /** Show the half / turn tag and clock under each feed line. */
  timestamps: boolean;
  /** Short vibration on taps (phones that support it). */
  haptic: boolean;
}

export const VIEWER_SETTINGS_KEY = "tabletop-viewer-settings";
const DEFAULTS: ViewerSettings = { compact: false, timestamps: true, haptic: false };

export function createViewerSettings(storage: QueueStorage = browserStorage()) {
  const state = reactive<ViewerSettings>({ ...DEFAULTS });
  try {
    const raw = storage.getItem(VIEWER_SETTINGS_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<ViewerSettings>) : {};
    for (const k of Object.keys(DEFAULTS) as Array<keyof ViewerSettings>) if (typeof v[k] === "boolean") state[k] = v[k] as boolean;
  } catch { /* defaults */ }
  return {
    state,
    set<K extends keyof ViewerSettings>(key: K, value: ViewerSettings[K]): void {
      state[key] = value;
      try { storage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify({ ...state })); } catch { /* not remembered */ }
    },
    /** One short buzz when the viewer turned haptics on and the device can vibrate. */
    buzz(): void {
      try { if (state.haptic) (globalThis as { navigator?: { vibrate?: (ms: number) => boolean } }).navigator?.vibrate?.(15); } catch { /* no vibration */ }
    },
  };
}

export type ViewerSettingsStore = ReturnType<typeof createViewerSettings>;
export const VIEWER_SETTINGS_INJECT: InjectionKey<ViewerSettingsStore> = Symbol("tabletop-viewer-settings");
