// Shell UI state (left nav rail / drawer) and the build-log reader. The rail state is per viewer: remembered in
// localStorage when the browser allows it, never required.

import { reactive, type InjectionKey } from "vue";
import type { Fetcher } from "../session";

export interface ShellUi {
  /** 56 px icon rail instead of the 260 px bar (desktop); `[` toggles. */
  collapsed: boolean;
  /** The nav drawer under 1024 px. */
  drawerOpen: boolean;
}

export const RAIL_STORAGE_KEY = "sf.navRail";
export const SHELL_UI_KEY: InjectionKey<ShellUi> = Symbol("shell-ui");

export function createShellUi(): ShellUi {
  let collapsed = false;
  try { collapsed = typeof localStorage !== "undefined" && localStorage.getItem(RAIL_STORAGE_KEY) === "1"; } catch { /* no storage */ }
  return reactive<ShellUi>({ collapsed, drawerOpen: false });
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
