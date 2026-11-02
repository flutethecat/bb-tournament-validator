// "Filter profanity" (owner 11-02): what the viewer sees. Messages and comments are stored exactly as written; with the
// Account option on (the default, and always for a visitor who is not signed in) matched words show as "***". One small
// shared store: loaded once (GET /api/me/display-settings), updated on toggle (POST, through api(): CSRF header).
import { reactive } from "vue";
import { forViewer } from "../../../src/discord/profanity";
import type { Fetcher } from "../session";

export const PROFANITY_LABEL = "Filter profanity";
export const PROFANITY_HINT = "Shows rude words as ***. Messages are stored as written.";

export const profanitySetting = reactive({ on: true, loaded: false });

let loading: Promise<void> | undefined;

/** Reads the viewer's choice once (failures keep the default: on). `force` re-reads (after a sign-in or sign-out). */
export function loadProfanitySetting(api: Fetcher, force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = (async () => {
    try {
      const r = await api<{ profanityFilter?: unknown }>("/api/me/display-settings");
      profanitySetting.on = r?.profanityFilter !== false;
    } catch {
      profanitySetting.on = true;
    } finally {
      profanitySetting.loaded = true;
    }
  })();
  return loading;
}

/** Saves the choice; the store follows the server's answer. */
export async function saveProfanitySetting(api: Fetcher, on: boolean): Promise<void> {
  const r = await api<{ profanityFilter?: unknown }>("/api/me/display-settings", { method: "POST", body: { profanityFilter: on } });
  profanitySetting.on = r?.profanityFilter !== false;
}

/** Text as this viewer sees it (starred while the option is on). */
export const shown = (text: string | undefined | null): string => forViewer(text ?? "", profanitySetting.on);
