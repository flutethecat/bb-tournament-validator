// Coach notifications for the SPA (landing spec §4.1). The home lane mounts NotificationsPanel with this store and
// shows `unread` on the top-bar bell. Push = the Super socket's `notify` feature (hello { notify: true }); when the
// socket is unavailable or refused, the store polls every 60 s instead. Rows are what the server sent, nothing more.

import { ref, type InjectionKey, type Ref } from "vue";
import type { Fetcher } from "../session";

export type NotificationType =
  | "organiser-message" | "entrant-flag" | "roster-problems" | "withdrawal" | "award"
  | "fixture-created" | "fixture-rescheduled" | "proposal-received" | "proposal-accepted" | "proposal-countered"
  | "result-confirmed" | "tournament-news" | "league-broadcast";

export interface NotificationRow {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  at: string;
  readAt?: string;
  from: string;
}

export interface NotificationListResponse {
  notifications: NotificationRow[];
  unread: number;
  total?: number;
}

/** One glyph per type, from our own icon set (public/icons). */
export const NOTIFICATION_ICONS: Record<NotificationType, string> = {
  "organiser-message": "/icons/ui/action-pass.png",
  "entrant-flag": "/icons/ui/football-helmet.png",
  "roster-problems": "/icons/ui/action-foul.png",
  withdrawal: "/icons/ui/status-stalling.png",
  award: "/icons/coach-badges/star-retro.png",
  "fixture-created": "/icons/skills/block.png",
  "fixture-rescheduled": "/icons/skills/block.png",
  "proposal-received": "/icons/ui/action-pass.png",
  "proposal-accepted": "/icons/ui/status-catch.png",
  "proposal-countered": "/icons/ui/re_roll.png",
  "result-confirmed": "/icons/ui/dedicated_fans.png",
  "tournament-news": "/icons/skills/leader.png",
  "league-broadcast": "/icons/skills/leader.png",
};
export const notificationIcon = (type: string): string => NOTIFICATION_ICONS[type as NotificationType] ?? "/icons/ui/football-helmet.png";

/** Short age: "now", "5 min", "3 h", "2 d", then the date ("12 Oct"). */
export function notificationAge(at: string, now = Date.now()): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)} d`;
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

export interface NotifySocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
}

export interface NotificationsOptions {
  /** Opens the Super socket; default a browser WebSocket to /super (none during SSR). */
  openSocket?: (url: string) => NotifySocket;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (h: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Poll period when the socket is down (default 60 s). */
  pollMs?: number;
  /** Rows fetched per load (default 50). */
  limit?: number;
}

export interface NotificationsStore {
  rows: Ref<NotificationRow[]>;
  unread: Ref<number>;
  loaded: Ref<boolean>;
  error: Ref<string>;
  /** True while the push socket is live (polling is off). */
  live: Ref<boolean>;
  load(): Promise<void>;
  markRead(ids: string[]): Promise<void>;
  markAllRead(): Promise<void>;
  /** Start push (socket) with the 60 s poll fallback. Counted: every subscribe() needs its own unsubscribe(), and
   *  the socket opens on the first and closes on the last, so the bell and the coach page can share one store. */
  subscribe(): void;
  unsubscribe(): void;
}

export const NOTIFICATIONS_PATH = "/api/me/notifications";
export const POLL_MS = 60_000;

export function useNotifications(fetcher: Fetcher, options: NotificationsOptions = {}): NotificationsStore {
  const rows = ref<NotificationRow[]>([]);
  const unread = ref(0);
  const loaded = ref(false);
  const error = ref("");
  const live = ref(false);
  const limit = options.limit ?? 50;
  const setI = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const setT = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));

  async function load(): Promise<void> {
    try {
      const res = await fetcher<NotificationListResponse>(`${NOTIFICATIONS_PATH}?limit=${limit}`);
      rows.value = Array.isArray(res?.notifications) ? res.notifications : [];
      unread.value = typeof res?.unread === "number" ? res.unread : rows.value.filter((r) => !r.readAt).length;
      error.value = "";
      loaded.value = true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Can't load notifications.";
    }
  }

  async function post(body: { ids: string[] } | { all: true }): Promise<void> {
    try {
      const res = await fetcher<{ marked: number; unread: number }>(`${NOTIFICATIONS_PATH}/read`, { method: "POST", body });
      const at = new Date().toISOString();
      const wanted = "ids" in body ? new Set(body.ids) : undefined;
      rows.value = rows.value.map((r) => (r.readAt || (wanted && !wanted.has(r.id)) ? r : { ...r, readAt: at }));
      unread.value = typeof res?.unread === "number" ? res.unread : rows.value.filter((r) => !r.readAt).length;
      error.value = "";
    } catch (err) {
      error.value = err instanceof Error ? err.message : "Can't update notifications.";
    }
  }
  const markRead = (ids: string[]) => (ids.length ? post({ ids }) : Promise.resolve());
  const markAllRead = () => post({ all: true });

  /** A pushed { unread, latest }: the count follows the server, the new row goes on top. */
  function onPush(payload: unknown): void {
    const p = payload as { unread?: unknown; latest?: NotificationRow } | undefined;
    if (!p || typeof p !== "object") return;
    if (typeof p.unread === "number") unread.value = p.unread;
    const latest = p.latest;
    if (latest && typeof latest.id === "string" && !rows.value.some((r) => r.id === latest.id)) rows.value = [latest, ...rows.value].slice(0, limit);
  }

  let pollTimer: unknown;
  let socket: NotifySocket | undefined;
  let holders = 0;
  let subscribed = false;
  let tries = 0;
  const startPoll = () => { if (pollTimer === undefined && subscribed) pollTimer = setI(() => { void load(); }, options.pollMs ?? POLL_MS); };
  const stopPoll = () => { if (pollTimer !== undefined) { clearI(pollTimer); pollTimer = undefined; } };

  function connect(): void {
    const open = options.openSocket ?? (typeof WebSocket === "undefined" ? undefined : (url: string) => new WebSocket(url) as unknown as NotifySocket);
    if (!open || !subscribed) { startPoll(); return; }
    let ws: NotifySocket;
    try {
      const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
      ws = open(`${proto}//${typeof location !== "undefined" ? location.host : "localhost"}/super`);
    } catch { startPoll(); return; }
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", v: 1, notify: true }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; feature?: string; payload?: unknown };
        if (m.type === "notifyRefused") { tries = 99; return; }
        if (m.type === "notifyWelcome") { tries = 0; live.value = true; stopPoll(); void load(); return; }
        if (m.type === "event" && m.feature === "notify") onPush(m.payload);
      } catch { /* ignore a bad frame */ }
    };
    ws.onclose = () => {
      socket = undefined;
      live.value = false;
      if (!subscribed) return;
      startPoll(); // the fallback runs while the socket is down
      if (tries > 5) return;
      tries += 1;
      setT(() => { if (subscribed && !socket) connect(); }, Math.min(30_000, 1000 * 2 ** tries));
    };
  }

  return {
    rows, unread, loaded, error, live, load, markRead, markAllRead,
    subscribe() {
      holders += 1;
      if (subscribed) return;
      subscribed = true;
      tries = 0;
      connect();
    },
    unsubscribe() {
      if (holders > 0) holders -= 1;
      if (holders > 0) return;
      subscribed = false;
      stopPoll();
      const s = socket;
      socket = undefined;
      live.value = false;
      try { s?.close(); } catch { /* ignore */ }
    },
  };
}

export const MESSAGE_MAX_CHARS = 2000;

/** Organiser "Message coach" (Participants row menu): POST /api/tournaments/:id/message. Resolves to an error message, or "" when sent. */
export async function sendCoachMessage(fetcher: Fetcher, tournamentId: string, coachKey: string, body: string): Promise<string> {
  const text = body.trim();
  if (!text) return "Write a message first.";
  if ([...text].length > MESSAGE_MAX_CHARS) return `A message is at most ${MESSAGE_MAX_CHARS} characters.`;
  try {
    await fetcher(`/api/tournaments/${encodeURIComponent(tournamentId)}/message`, { method: "POST", body: { coachKey, body: text } });
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : "Can't send the message.";
  }
}

/** The one store the SPA shares (createSpa provides it): the top-bar bell and the coach page read the same rows. */
export const NOTIFICATIONS_KEY: InjectionKey<NotificationsStore> = Symbol("notifications");

/** Badge text for the bell: "" at 0 (badge hidden), "99+" above 99. */
export const unreadBadge = (n: number): string => (n <= 0 ? "" : n > 99 ? "99+" : String(n));
