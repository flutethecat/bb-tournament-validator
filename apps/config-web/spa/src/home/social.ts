// Friends, private messages and the block list in the SPA (landing spec §4.3-4.5). Reads and writes the /api/me/friends,
// /api/me/blocks and /api/me/threads routes (src/social/api.ts); renders only what they answer. The shared unread store
// feeds the Home badge in the nav (homeBadgeCount's `messages` part) and the coach page Messages preview.

import { ref, type InjectionKey, type Ref } from "vue";
import type { Fetcher } from "../session";

export const MESSAGE_MAX_CHARS = 2000;

export interface CoachRef { coach: string; avatar: string | null }
export interface FriendRow extends CoachRef { since: string; lastPlayed: string | null }
export interface RequestRow extends CoachRef { at: string; lastPlayed?: string | null }
export interface KnownRow extends CoachRef { lastPlayed: string; games: number }
export interface FriendsResponse { friends: FriendRow[]; incoming: RequestRow[]; outgoing: RequestRow[]; known: KnownRow[] }
export interface BlockRow extends CoachRef { at: string }

export interface ThreadSummary {
  id: string;
  with: string;
  avatar: string | null;
  deleted: boolean;
  organiser: boolean;
  lastAt: string;
  lastFromMe: boolean;
  preview: string;
  unread: number;
}
export interface ThreadsResponse { threads: ThreadSummary[]; unread: number }
export interface MessageView { id: number; from: string; mine: boolean; text: string; at: string; organiser?: { kind: string; id: string; name: string } }
export interface ThreadResponse {
  thread: { id: string; with: string; avatar: string | null; deleted: boolean; organiser: boolean; blockedByMe: boolean; canSend: boolean; reason?: string };
  messages: MessageView[];
  more: boolean;
}

const enc = encodeURIComponent;
export const socialApi = {
  friends: (f: Fetcher) => f<FriendsResponse>("/api/me/friends"),
  request: (f: Fetcher, coach: string) => f<{ relation: string }>("/api/me/friends/request", { method: "POST", body: { coach } }),
  accept: (f: Fetcher, coach: string) => f<{ relation: string }>("/api/me/friends/accept", { method: "POST", body: { coach } }),
  decline: (f: Fetcher, coach: string) => f<{ relation: string }>("/api/me/friends/decline", { method: "POST", body: { coach } }),
  unfriend: (f: Fetcher, coach: string) => f<{ relation: string }>(`/api/me/friends/${enc(coach)}`, { method: "DELETE" }),
  blocks: (f: Fetcher) => f<{ blocked: BlockRow[] }>("/api/me/blocks"),
  block: (f: Fetcher, coach: string) => f<{ blocked: boolean }>("/api/me/blocks", { method: "POST", body: { coach } }),
  unblock: (f: Fetcher, coach: string) => f<{ blocked: boolean }>(`/api/me/blocks/${enc(coach)}`, { method: "DELETE" }),
  threads: (f: Fetcher) => f<ThreadsResponse>("/api/me/threads"),
  unread: (f: Fetcher) => f<{ unread: number }>("/api/me/threads/unread"),
  thread: (f: Fetcher, id: string, before?: number) => f<ThreadResponse>(`/api/me/threads/${enc(id)}${before ? `?before=${before}` : ""}`),
  start: (f: Fetcher, to: string, text: string) => f<{ thread: { id: string; with: string }; message: MessageView }>("/api/me/threads", { method: "POST", body: { to, text } }),
  send: (f: Fetcher, id: string, text: string) => f<{ thread: { id: string }; message: MessageView }>(`/api/me/threads/${enc(id)}`, { method: "POST", body: { text } }),
  /** Mark read up to `upTo`, the id of the last message shown (later ones stay unread). */
  read: (f: Fetcher, id: string, upTo: number) => f<{ unread: number }>(`/api/me/threads/${enc(id)}/read`, { method: "POST", body: { upTo } }),
};

/** The router path of a thread (or the Messages page). */
export const messagesPath = (id?: string): string => (id ? `/messages/${enc(id)}` : "/messages");

/** "12 Oct" style date, or "today" / "yesterday" (UTC-free: the viewer's own zone). */
export function shortDate(at: string | null | undefined, now = Date.now()): string {
  const t = at ? Date.parse(at) : Number.NaN;
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  const today = new Date(now);
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now - 86_400_000);
  if (sameDay(d, y)) return "yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The first letter for the avatar badge. */
export const initial = (name: string): string => ([...name.trim()][0] ?? "?").toUpperCase();

/** Row actions shared by the Friends panel and the Messages page: one busy flag, one error line, and the block confirm. */
export function useSocialActions(fetcher: Fetcher, changed: () => void | Promise<void>) {
  const busy = ref("");
  const error = ref("");
  const notice = ref("");
  const blockTarget = ref("");
  async function run(key: string, fn: () => Promise<unknown>, done?: string): Promise<boolean> {
    if (busy.value) return false;
    busy.value = key;
    error.value = "";
    notice.value = "";
    try {
      await fn();
      if (done) notice.value = done;
      await changed();
      return true;
    } catch (e) {
      error.value = (e as Error).message;
      return false;
    } finally {
      busy.value = "";
    }
  }
  return {
    busy, error, notice, blockTarget,
    add: (coach: string) => run(`add:${coach}`, () => socialApi.request(fetcher, coach), `Friend request sent to ${coach}.`),
    accept: (coach: string) => run(`accept:${coach}`, () => socialApi.accept(fetcher, coach), `You and ${coach} are now friends.`),
    decline: (coach: string) => run(`decline:${coach}`, () => socialApi.decline(fetcher, coach)),
    unfriend: (coach: string) => run(`unfriend:${coach}`, () => socialApi.unfriend(fetcher, coach)),
    unblock: (coach: string) => run(`unblock:${coach}`, () => socialApi.unblock(fetcher, coach), `${coach} is unblocked.`),
    askBlock: (coach: string) => { error.value = ""; blockTarget.value = coach; },
    async confirmBlock(): Promise<void> {
      const coach = blockTarget.value;
      if (coach && await run(`block:${coach}`, () => socialApi.block(fetcher, coach), `${coach} is blocked.`)) blockTarget.value = "";
    },
  };
}

export interface MessagesStore {
  unread: Ref<number>;
  /** Re-read the unread count (signed out or failed = 0 / unchanged). */
  load(): Promise<void>;
  set(n: number): void;
}

export function createMessagesStore(fetcher: Fetcher): MessagesStore {
  const unread = ref(0);
  let inFlight: Promise<void> | undefined;
  return {
    unread,
    load() {
      inFlight ??= (async () => {
        try {
          const res = await socialApi.unread(fetcher);
          unread.value = typeof res.unread === "number" && res.unread > 0 ? Math.floor(res.unread) : 0;
        } catch { /* keep the last count */ }
        finally { inFlight = undefined; }
      })();
      return inFlight;
    },
    set(n) { unread.value = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; },
  };
}

export const MESSAGES_KEY: InjectionKey<MessagesStore> = Symbol("messages");
