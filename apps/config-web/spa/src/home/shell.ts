// Shell UI state (left nav rail / drawer) and the build-log reader. The rail state is per viewer: remembered in
// localStorage when the browser allows it, never required.

import { computed, inject, onBeforeUnmount, onMounted, reactive, type ComputedRef, type InjectionKey } from "vue";
import type { Fetcher } from "../session";

export interface ShellUi {
  /** 56 px icon rail instead of the 260 px bar (desktop); `[` toggles. */
  collapsed: boolean;
  /** The nav drawer under 1024 px. */
  drawerOpen: boolean;
  /** Viewport under 1024 px (set by the shell from matchMedia): the nav is a drawer, inert while closed. */
  narrow: boolean;
}

export const RAIL_STORAGE_KEY = "sf.navRail";
export const SHELL_UI_KEY: InjectionKey<ShellUi> = Symbol("shell-ui");

export function createShellUi(): ShellUi {
  let collapsed = false;
  try { collapsed = typeof localStorage !== "undefined" && localStorage.getItem(RAIL_STORAGE_KEY) === "1"; } catch { /* no storage */ }
  return reactive<ShellUi>({ collapsed, drawerOpen: false, narrow: false });
}

export function rememberRail(ui: ShellUi): void {
  try { localStorage.setItem(RAIL_STORAGE_KEY, ui.collapsed ? "1" : "0"); } catch { /* no storage */ }
}

/** True when a key press belongs to a text field (shortcuts stay out of typing). */
export function typingTarget(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!el) return false;
  return el.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(String(el.tagName ?? "").toUpperCase());
}

export const DRAWER_QUERY = "(max-width: 1023.98px)";
export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where Tab should go inside an open drawer (wrapping at both ends), or undefined to let the browser move focus. */
export function trapTarget<T>(list: readonly T[], active: T | null, shift: boolean): T | undefined {
  if (!list.length) return undefined;
  const first = list[0]!;
  const last = list[list.length - 1]!;
  const i = active === null ? -1 : list.indexOf(active);
  if (i < 0) return shift ? last : first;
  if (shift && i === 0) return last;
  if (!shift && i === list.length - 1) return first;
  return undefined;
}

// ---- shared clock: one 60 s tick for every deadline chip and countdown on screen

export const CLOCK_TICK_MS = 60_000;

export interface Clock {
  readonly state: { now: number };
  /** Starts the tick for a mounted user; returns the release (the tick stops when the last user releases). */
  acquire(): () => void;
}

export function createClock(deps: { now?: () => number; setInterval?: (fn: () => void, ms: number) => unknown; clearInterval?: (h: unknown) => void } = {}): Clock {
  const now = deps.now ?? Date.now;
  const set = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
  const clear = deps.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>));
  const state = reactive({ now: now() });
  let users = 0;
  let handle: unknown;
  return {
    state,
    acquire() {
      users++;
      if (users === 1) { state.now = now(); handle = set(() => { state.now = now(); }, CLOCK_TICK_MS); }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        users--;
        if (users === 0) { clear(handle); handle = undefined; }
      };
    },
  };
}

export const CLOCK_KEY: InjectionKey<Clock> = Symbol("clock");

/** The shared clock's time for a component: ticks while it is mounted (released on unmount). */
export function useNow(): ComputedRef<Date> {
  const clock = inject(CLOCK_KEY)!;
  let release: (() => void) | undefined;
  onMounted(() => { release = clock.acquire(); });
  onBeforeUnmount(() => { release?.(); release = undefined; });
  return computed(() => new Date(clock.state.now));
}

// ---- build log (GET /api/build-log)

export interface BuildLogLink { label: string; href: string }
export interface BuildLogEntry { date: string; version?: string; title: string; body: string; links: BuildLogLink[] }

export async function loadBuildLog(api: Fetcher): Promise<BuildLogEntry[]> {
  const res = await api<{ entries?: BuildLogEntry[] }>("/api/build-log");
  return Array.isArray(res?.entries) ? res.entries : [];
}

/** "29 Oct 2026" from a YYYY-MM-DD date (no timezone shift). */
export function logDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ""} ${m[1]}`;
}

/** An /app/... link from the log as a router path (so it stays in the SPA), or undefined for any other href. */
export function routerPathOf(href: string): string | undefined {
  return /^\/app(\/|$)/.test(href) ? href.slice(4) || "/" : undefined;
}
