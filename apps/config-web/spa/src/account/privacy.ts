// Account page PRIVACY panel (privacy spec 2026-10-31 §2/§3): "Download my data" (GET /api/me/export, a ZIP) and
// "Delete my account" (two steps: what goes vs what is anonymised, then type the coach name; POST /api/me/delete).
// No DOM here; AccountPrivacy.vue renders it. The server stays the authority on every check.

import { reactive } from "vue";
import { ApiError } from "../shared/api";
import type { Fetcher } from "../session";

export const EXPORT_PATH = "/api/me/export";
export const DELETE_PATH = "/api/me/delete";
export const DELETED_NOTICE = "Your account was deleted.";

/** Fetches the export as a Blob (the JSON Fetcher cannot) and hands it to the browser. Replaceable in tests. */
export type ExportDownloader = () => Promise<{ ok: true; blob: Blob; filename: string } | { ok: false; status: number; error: string }>;

const defaultDownloader: ExportDownloader = async () => {
  let res: Response;
  try {
    res = await fetch(EXPORT_PATH, { credentials: "same-origin", headers: { "x-cw-auth": "1", accept: "application/zip" } });
  } catch {
    return { ok: false, status: 0, error: "Can't reach the server. Check your connection." };
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status, error: data?.error ?? `Request failed (${res.status}).` };
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "super-fumbbl-data.zip";
  return { ok: true, blob: await res.blob(), filename: name };
};

const defaultSave = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
};

export type DeleteStage = "closed" | "explain" | "confirm" | "deleting" | "done";

export interface PrivacyState {
  downloading: boolean;
  downloadError: string;
  downloadNotice: string;
  stage: DeleteStage;
  typed: string;
  deleteError: string;
  /** Tournaments / leagues to hand over first (409 from the server). */
  owned: Array<{ kind: string; id: string; name: string }>;
}

export interface PrivacyDeps {
  api: Fetcher;
  coach: () => string;
  download?: ExportDownloader;
  save?: (blob: Blob, filename: string) => void;
  /** After a successful delete: sign out and land on the home page with DELETED_NOTICE. */
  onDeleted: () => Promise<void> | void;
}

/** What deletion removes and what it keeps (anonymised): shown before the coach types their name. */
export const DELETED_ITEMS = [
  "Your account record: coach name, Discord link, email, contact details and consents",
  "Your sign-ins (every device is signed out)",
  "Your uploaded avatar and team logos",
  "Saved rosters and their share links",
  "Your Play on Super FUMBBL team library (the game-server account is disabled)",
  "Your notifications and the bug reports you sent",
  "Organiser roles",
];
export const ANONYMISED_ITEMS = [
  "Game results, standings, ratings and titles",
  "League and tournament history (teams, fixtures, stats, honours)",
  "Published tabletop matches and game highlights",
  "Mentions in other coaches' notifications",
];

export function confirmMatches(typed: string, coach: string): boolean {
  const k = (s: string) => s.normalize("NFC").trim().toLowerCase();
  return Boolean(coach) && k(typed) === k(coach);
}

export function createPrivacyController(deps: PrivacyDeps) {
  const state = reactive<PrivacyState>({ downloading: false, downloadError: "", downloadNotice: "", stage: "closed", typed: "", deleteError: "", owned: [] });
  const download = deps.download ?? defaultDownloader;
  const save = deps.save ?? defaultSave;

  async function downloadData(): Promise<void> {
    if (state.downloading) return;
    state.downloading = true;
    state.downloadError = "";
    state.downloadNotice = "";
    try {
      const r = await download();
      if (!r.ok) { state.downloadError = r.error; return; }
      save(r.blob, r.filename);
      state.downloadNotice = "Your data is downloading.";
    } finally {
      state.downloading = false;
    }
  }

  const open = (): void => { state.stage = "explain"; state.typed = ""; state.deleteError = ""; state.owned = []; };
  const next = (): void => { if (state.stage === "explain") state.stage = "confirm"; };
  const cancel = (): void => { if (state.stage !== "deleting") { state.stage = "closed"; state.typed = ""; state.deleteError = ""; } };

  async function confirmDelete(): Promise<void> {
    if (state.stage !== "confirm") return;
    if (!confirmMatches(state.typed, deps.coach())) { state.deleteError = "Type your coach name exactly as shown."; return; }
    state.stage = "deleting";
    state.deleteError = "";
    try {
      await deps.api(DELETE_PATH, { method: "POST", body: { confirm: state.typed.trim() } });
      state.stage = "done";
      await deps.onDeleted();
    } catch (err) {
      state.stage = "confirm";
      if (err instanceof ApiError && err.status === 409) {
        const owned = (err.data as { owned?: PrivacyState["owned"] } | undefined)?.owned;
        state.owned = Array.isArray(owned) ? owned : [];
      }
      state.deleteError = err instanceof Error ? err.message : "The delete failed.";
    }
  }

  return { state, downloadData, open, next, cancel, confirmDelete };
}

export type PrivacyController = ReturnType<typeof createPrivacyController>;

// ---- the one-shot notice shown on the page the coach lands on after deletion --------------------------------------

export const flash = reactive<{ message: string }>({ message: "" });
export const setFlash = (message: string): void => { flash.message = message; };
export const clearFlash = (): void => { flash.message = ""; };
