// The threaded Board in the SPA (clubs first; leagues and tournaments since 11-04): reads and writes <base>/board, where
// `base` is the owner's API path (/api/clubs/<id>, /api/leagues/<id>, /api/tournaments/<id>). League and tournament boards
// add organiser moderation (hide, pin, lock, delete, mute), reports, the moderation log and the on / off and public-read
// settings (src/boards/competitionApi.ts). The server is the authority for every rule; this module only calls it.

import { reactive } from "vue";
import { ApiError } from "./api";
import type { Fetcher } from "../session";

export interface BoardPostView {
  id: string; author: string; text: string; at: string; editedAt?: string; removed?: { by: "author" | "moderator"; at: string };
  mine: boolean; canEdit: boolean; canRemove: boolean;
  /** Moderation boards: hidden by an organiser (coaches get no text). */
  hidden?: true;
  canReport?: boolean;
}
export interface BoardThreadView extends BoardPostView { title: string; lastAt: string; replies: BoardPostView[]; pinned?: true; locked?: true }
export interface BoardView {
  threads: BoardThreadView[]; canPost: boolean; canModerate: boolean; seenAt?: string;
  // ---- league / tournament boards ----
  kind?: "league" | "tournament"; name?: string;
  settings?: { enabled: boolean; publicRead: boolean; revision?: number };
  canReport?: boolean;
  mutedUntil?: string;
  openReports?: number;
}
export interface BoardStatus { enabled: boolean; publicRead: boolean; canRead: boolean; canModerate: boolean }
export interface BoardReport {
  id: string; postId: string; threadId: string; reporter: string; reason: string; at: string;
  resolved?: { by: string; at: string; outcome: "dismissed" | "actioned" };
  post: { title: string; text: string; author: string; removed: boolean; hidden: boolean } | null;
}
export interface BoardMute { coach: string; until: string; by: string; at: string; reason?: string }
export interface BoardLogEntry { id: string; at: string; by: string; action: string; postId?: string; coach?: string; reason?: string; detail?: string }
export type MuteDuration = "1h" | "24h" | "7d" | "custom";

export const MUTE_CHOICES: ReadonlyArray<{ value: MuteDuration; label: string }> = [
  { value: "1h", label: "1 hour" }, { value: "24h", label: "24 hours" }, { value: "7d", label: "7 days" }, { value: "custom", label: "Until..." },
];

/** The log's action names in plain words. */
export const LOG_ACTION_LABEL: Readonly<Record<string, string>> = {
  delete: "Deleted a post", hide: "Hid a post", unhide: "Unhid a post", pin: "Pinned a thread", unpin: "Unpinned a thread",
  lock: "Locked a thread", unlock: "Unlocked a thread", mute: "Muted a coach", unmute: "Lifted a mute",
  "report-dismissed": "Dismissed a report", "report-actioned": "Closed a report", settings: "Changed the settings",
};

const message = (err: unknown, fallback: string): string => (err instanceof Error && err.message ? err.message : fallback);

export function createBoard(deps: { api: Fetcher; base: () => string }) {
  const state = reactive({
    view: null as BoardView | null, loaded: false, error: "", code: "", busy: "", actionError: "", notice: "",
    reports: null as BoardReport[] | null, mutes: null as BoardMute[] | null, log: null as BoardLogEntry[] | null, modError: "",
  });
  const path = () => `${deps.base()}/board`;
  async function act(key: string, run: () => Promise<{ board?: BoardView } | undefined>, done = ""): Promise<boolean> {
    state.busy = key;
    state.actionError = "";
    state.notice = "";
    try { const r = await run(); if (r?.board) state.view = r.board; if (done) state.notice = done; return true; } catch (err) { state.actionError = message(err, "That didn't work."); return false; } finally { state.busy = ""; }
  }
  const enc = encodeURIComponent;
  const board = {
    state,
    async load(): Promise<void> {
      try {
        state.view = await deps.api<BoardView>(path());
        state.error = ""; state.code = "";
        // Opening the board is a POST (reads never change state): it coalesces the "new posts" notes.
        void deps.api(`${path()}/seen`, { method: "POST", body: {} }).catch(() => undefined);
      } catch (err) {
        state.error = message(err, "Can't load the board.");
        state.code = err instanceof ApiError ? String(err.status) : "";
        const code = err instanceof ApiError && err.data && typeof err.data === "object" ? (err.data as { code?: unknown }).code : undefined;
        if (code === "board-off") state.code = "board-off";
      } finally { state.loaded = true; }
    },
    post: (title: string, text: string) => act("post", () => deps.api(path(), { method: "POST", body: { title, text } })),
    reply: (threadId: string, text: string) => act(`reply:${threadId}`, () => deps.api(`${path()}/${enc(threadId)}/replies`, { method: "POST", body: { text } })),
    edit: (postId: string, text: string, title?: string) => act(`edit:${postId}`, () => deps.api(`${path()}/${enc(postId)}`, { method: "PATCH", body: { text, ...(title !== undefined ? { title } : {}) } })),
    remove: (postId: string, reason?: string) => act(`rm:${postId}`, () => deps.api(`${path()}/${enc(postId)}`, { method: "DELETE", ...(reason ? { body: { reason } } : {}) })),
    // ---- moderation boards ----
    mark: (postId: string, what: "hide" | "pin" | "lock", on: boolean, reason = "") => {
      const field = what === "hide" ? "hidden" : what === "pin" ? "pinned" : "locked";
      return act(`${what}:${postId}`, () => deps.api(`${path()}/${enc(postId)}/${what}`, { method: "POST", body: { [field]: on, ...(reason ? { reason } : {}) } }));
    },
    report: (postId: string, reason: string) => act(`report:${postId}`, async () => {
      const r = await deps.api<{ board?: BoardView; duplicate?: boolean }>(`${path()}/${enc(postId)}/report`, { method: "POST", body: { reason } });
      state.notice = r?.duplicate ? "You already reported this post. The organisers will look at it." : "Reported. The organisers will look at it.";
      return r;
    }),
    async loadModeration(): Promise<void> {
      try {
        const [reports, mutes, log] = await Promise.all([
          deps.api<{ reports: BoardReport[] }>(`${path()}/reports`),
          deps.api<{ mutes: BoardMute[] }>(`${path()}/mutes`),
          deps.api<{ log: BoardLogEntry[] }>(`${path()}/log`),
        ]);
        state.reports = reports.reports; state.mutes = mutes.mutes; state.log = log.log; state.modError = "";
      } catch (err) { state.modError = message(err, "Can't load the moderation tools."); }
    },
    resolve: async (reportId: string, outcome: "dismissed" | "actioned") => {
      const ok = await act(`resolve:${reportId}`, () => deps.api(`${path()}/reports/${enc(reportId)}/resolve`, { method: "POST", body: { outcome } }));
      if (ok) await board.loadModeration();
      return ok;
    },
    mute: async (coach: string, duration: MuteDuration, until: string, reason: string) => {
      const ok = await act("mute", () => deps.api(`${path()}/mutes`, { method: "POST", body: { coach, duration, ...(duration === "custom" ? { until } : {}), ...(reason ? { reason } : {}) } }), `${coach} is muted on this board.`);
      if (ok) await board.loadModeration();
      return ok;
    },
    unmute: async (coach: string) => {
      const ok = await act(`unmute:${coach}`, () => deps.api(`${path()}/mutes/${enc(coach)}`, { method: "DELETE" }), "Mute lifted.");
      if (ok) await board.loadModeration();
      return ok;
    },
    saveSettings: async (patch: { enabled?: boolean; publicRead?: boolean }) => {
      const ok = await act("settings", () => deps.api(`${path()}/settings`, { method: "PATCH", body: { revision: state.view?.settings?.revision, ...patch } }), "Board settings saved.");
      if (ok) await board.loadModeration();
      return ok;
    },
  };
  return board;
}

/** The tab's visibility for a league / tournament board: undefined while unknown, false on any failure (fail closed). */
export async function loadBoardStatus(api: Fetcher, base: string): Promise<BoardStatus | null> {
  try { return await api<BoardStatus>(`${base}/board/status`); } catch { return null; }
}

/** Whether the header shows the Board tab: readers of a board that is on; moderators always (to switch it back on). */
export const boardTabShows = (s: BoardStatus | null | undefined): boolean => Boolean(s && (s.canModerate || (s.enabled && s.canRead)));

/**
 * One status read per board and viewer, shared by the section header (the tab) and the page (which tab shows): `key` is
 * the board's base plus the signed-in coach, so a sign-in or sign-out reads it again. undefined = not read yet.
 */
export const boardStatuses = reactive<Record<string, BoardStatus | null>>({});
const pendingStatus = new Map<string, Promise<void>>();
export function ensureBoardStatus(api: Fetcher, base: string, coach: string, force = false): Promise<void> {
  const key = `${base}|${coach.trim().toLowerCase()}`;
  if (!force && (key in boardStatuses || pendingStatus.has(key))) return pendingStatus.get(key) ?? Promise.resolve();
  const run = (async () => { boardStatuses[key] = await loadBoardStatus(api, base); pendingStatus.delete(key); })();
  pendingStatus.set(key, run);
  return run;
}
export const boardStatusOf = (base: string, coach: string): BoardStatus | null | undefined => boardStatuses[`${base}|${coach.trim().toLowerCase()}`];
