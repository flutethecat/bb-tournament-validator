/**
 * Account → "Filter profanity" (owner 11-02): a viewer option, default ON. When on, the site and the inbox show listed
 * words as "***" for that viewer (the SPA stars at display time with src/discord/profanity.ts); stored text never changes.
 * Kept with the coach's other per-coach choices in the mail prefs store (so the data export and account deletion cover it).
 *
 *   GET  /api/me/display-settings   { profanityFilter: boolean }
 *   POST /api/me/display-settings   { profanityFilter: boolean }   (CSRF-gated like every /api write)
 */
import type { MailPrefsStore } from "../mail/stores.js";

export const DISPLAY_SETTINGS_PATH = "/api/me/display-settings";

export interface DisplaySettingsResult { status: number; body: unknown }

/** The viewer's choice (absent = on; a visitor who is not signed in always gets the filter). */
export const profanityFilterOn = (prefs: Pick<MailPrefsStore, "get">, coach: string | undefined): boolean =>
  !coach ? true : prefs.get(coach).profanityFilter?.on ?? true;

export function displaySettingsRoute(
  method: string, auth: { coach: string; test?: boolean } | undefined, body: unknown, prefs: Pick<MailPrefsStore, "get" | "update">, now = new Date(),
): DisplaySettingsResult {
  if (method === "GET" || method === "HEAD") return { status: 200, body: { profanityFilter: profanityFilterOn(prefs, auth?.coach) } };
  if (method !== "POST") return { status: 405, body: { error: "Use GET or POST." } };
  if (!auth) return { status: 401, body: { error: "Authentication required." } };
  if (auth.test) return { status: 403, body: { error: "Test sign-in sessions cannot change account settings." } };
  const v = (body as { profanityFilter?: unknown } | undefined)?.profanityFilter;
  if (typeof v !== "boolean") return { status: 400, body: { error: "Send { profanityFilter: true } or { profanityFilter: false }." } };
  prefs.update(auth.coach, (p) => ({ ...p, profanityFilter: { on: v, at: now.toISOString() } }));
  return { status: 200, body: { profanityFilter: v } };
}
