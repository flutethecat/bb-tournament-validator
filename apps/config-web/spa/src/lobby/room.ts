// Lobby controller (start-game spec Part 1b): state poll every 4 s (also the presence heartbeat), Super socket chat
// + presence, rosters, the opponent's coach card, and the Start game launch. Same API calls and socket frames as the
// vanilla page (lobby/src/main.ts renderLobby). No DOM: rendered by LobbyRoomView.vue. Everything kept here is what
// the server returned; nothing is invented.

import { reactive, type InjectionKey } from "vue";
import { ApiError, type ChatMessage, type LobbyView, type Roster, type SeatView } from "../shared/api";
import { expiryLine, ratingParts, type RatingLike } from "../shared/format";
import type { Fetcher } from "../session";

export type Role = "creator" | "opponent";

export interface RosterSlot {
  /** none = no team on the seat yet; ok with roster null = the server said not shared. */
  status: "none" | "loading" | "ok" | "error";
  roster: Roster | null;
  error: string;
}

export interface CoachCard {
  coach: string;
  avatar: string | null;
  /** Linked FUMBBL account as the rating endpoint returned it; null = no rating linked. */
  fumbbl: { name: string; title?: string; parts: string[] } | null;
  loading: boolean;
}

export interface LobbyRoomState {
  view: LobbyView | null;
  statusError: string;
  expiry: string;
  /** Set when the lobby is gone (410/404/403): the message shown instead of the lobby. */
  gone: string;
  chat: ChatMessage[];
  chatState: string;
  chatLive: boolean;
  rosters: Record<Role, RosterSlot>;
  card: CoachCard | null;
  launchError: string;
  launching: boolean;
}

export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface LobbyRoomDeps {
  api: Fetcher;
  me: () => string;
  /** The session ended (401): re-read it so the shell shows the sign-in prompt. */
  onSignedOut: () => void;
  /** Opens the Super socket; throwing means live chat is unavailable. */
  openSocket?: (url: string) => SocketLike;
  socketUrl?: () => string;
  /** Hands the launch URL to the browser (anchor click with download). */
  download?: (href: string) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (id: number) => void;
  setTimeout?: (fn: () => void, ms: number) => void;
}

const OPEN = 1;

export function statusLine(v: LobbyView): string {
  const other = v.me === "creator" ? v.opponent : v.creator;
  if (v.status === "ready") {
    return `Game set up${v.game?.gameId ? ` (game ${v.game.gameId})` : ""}. ${v.canLaunch ? "Ready to start." : "Waiting for both coaches."}`;
  }
  if (v.status === "waiting") {
    return v.me === "creator" ? `Waiting for ${other.coach} to accept.` : `${other.coach} challenged you. Pick a team to accept.`;
  }
  return v.me === "creator" ? `Your challenge lapsed. It renews when ${other.coach} accepts.` : "Pick a team to accept.";
}

/** The opponent seat may accept with a team (not yet joined, game not ready). */
export function canJoin(v: LobbyView): boolean {
  return v.me === "opponent" && v.status !== "ready" && !v.opponent.team;
}

/** The creator may withdraw an unpaired lobby. */
export function canClose(v: LobbyView): boolean {
  return v.me === "creator" && v.status !== "ready";
}

export function startLabel(v: LobbyView): string {
  const mine = v.me === "creator" ? v.creator : v.opponent;
  return mine.state === "client" ? "Start game again" : "Start game";
}

function defaultSocketUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/super`;
}

function defaultDownload(href: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.setAttribute("download", "");
  document.body.append(a);
  a.click();
  a.remove();
}

export function createLobbyRoom(id: string, deps: LobbyRoomDeps) {
  const state = reactive<LobbyRoomState>({
    view: null,
    statusError: "",
    expiry: "",
    gone: "",
    chat: [],
    chatState: "Connecting chat…",
    chatLive: false,
    rosters: {
      creator: { status: "none", roster: null, error: "" },
      opponent: { status: "none", roster: null, error: "" },
    },
    card: null,
    launchError: "",
    launching: false,
  });
  const now = deps.now ?? (() => Date.now());
  const setI = deps.setInterval ?? ((fn: () => void, ms: number) => window.setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((t: number) => window.clearInterval(t));
  const setT = deps.setTimeout ?? ((fn: () => void, ms: number) => void window.setTimeout(fn, ms));
  const openSocket = deps.openSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);

  let stopped = false;
  let timer: number | undefined;
  let socket: SocketLike | undefined;
  let socketTries = 0;
  const seenChat = new Set<number>();
  const rosterKey: Record<Role, string> = { creator: "", opponent: "" };
  let cardFor = "";

  const addChat = (m: ChatMessage): void => {
    if (seenChat.has(m.id)) return;
    seenChat.add(m.id);
    state.chat.push(m);
  };

  const stopAll = (): void => {
    stopped = true;
    if (timer !== undefined) clearI(timer);
    timer = undefined;
    socket?.close();
  };

  const showGone = (msg: string): void => {
    stopAll();
    state.gone = msg;
  };

  const loadRoster = async (role: Role, seat: SeatView): Promise<void> => {
    const keyNow = seat.team?.teamId ?? "";
    if (rosterKey[role] === keyNow && keyNow) return;
    rosterKey[role] = keyNow;
    const slot = state.rosters[role];
    if (!seat.team) {
      rosterKey[role] = "";
      Object.assign(slot, { status: "none", roster: null, error: "" });
      return;
    }
    slot.status = "loading";
    try {
      const res = await deps.api<{ shared: boolean; roster: Roster | null }>(`/api/lobby/${id}/roster?role=${role}`);
      Object.assign(slot, { status: "ok", roster: res.roster ?? null, error: "" });
    } catch (err) {
      rosterKey[role] = "";
      Object.assign(slot, { status: "error", roster: null, error: (err as Error).message });
    }
  };

  const loadCard = async (seat: SeatView, role: Role): Promise<void> => {
    if (cardFor === seat.coach) return;
    cardFor = seat.coach;
    state.card = { coach: seat.coach, avatar: null, fumbbl: null, loading: true };
    const current = () => (state.card?.coach === seat.coach ? state.card : undefined);
    try {
      const info = await deps.api<{ avatar: string | null; fumbblName: string | null }>(`/api/lobby/${id}/coach?role=${role}`);
      const card = current();
      if (!card) return;
      card.avatar = info.avatar || null;
      if (!info.fumbblName) return;
      const res = await deps.api<{ rating: RatingLike & { name: string } }>(`/api/coach-rating?name=${encodeURIComponent(info.fumbblName)}`);
      const after = current();
      if (!after) return;
      after.fumbbl = {
        name: res.rating.name || info.fumbblName,
        ...(res.rating.title ? { title: res.rating.title } : {}),
        parts: ratingParts(res.rating),
      };
    } catch {
      /* shown as "No FUMBBL rating linked." */
    } finally {
      const card = current();
      if (card) card.loading = false;
    }
  };

  const apply = (v: LobbyView): void => {
    state.view = v;
    state.statusError = "";
    state.expiry = expiryLine(v.expiresAt, now());
    const other = v.me === "creator" ? v.opponent : v.creator;
    const otherRole: Role = v.me === "creator" ? "opponent" : "creator";
    void loadRoster("creator", v.creator);
    void loadRoster("opponent", v.opponent);
    void loadCard(other, otherRole);
    if (!state.chatLive) for (const m of v.chat ?? []) addChat(m);
  };

  const poll = async (): Promise<void> => {
    try {
      const res = await deps.api<{ lobby: LobbyView; chatLive: boolean }>(`/api/lobby/${id}`);
      if (stopped) return;
      apply(res.lobby);
      if (!res.chatLive && !socket) state.chatState = "Live chat is off on this server.";
    } catch (err) {
      if (err instanceof ApiError && (err.status === 410 || err.status === 404 || err.status === 403)) return showGone(err.message);
      if (err instanceof ApiError && err.status === 401) {
        stopAll();
        return void deps.onSignedOut();
      }
      state.statusError = (err as Error).message;
    }
  };

  const join = async (teamId: string): Promise<void> => {
    const res = await deps.api<{ lobby: LobbyView }>(`/api/lobby/${id}/join`, { method: "POST", body: { teamId } });
    apply(res.lobby);
  };

  const close = async (): Promise<void> => {
    await deps.api(`/api/lobby/${id}/close`, { method: "POST" });
  };

  const launch = async (): Promise<void> => {
    state.launchError = "";
    state.launching = true;
    try {
      const res = await deps.api<{ jnlpUrl: string; scheme: string | null }>(`/api/lobby/${id}/launch`, { method: "POST" });
      (deps.download ?? defaultDownload)(res.scheme ?? res.jnlpUrl);
      await poll();
    } catch (err) {
      state.launchError = (err as Error).message;
    } finally {
      state.launching = false;
    }
  };

  const sendChat = (text: string): boolean => {
    const t = text.trim();
    if (!t || !socket || socket.readyState !== OPEN) return false;
    socket.send(JSON.stringify({ type: "publish", feature: "lobby-chat", payload: { text: t } }));
    return true;
  };

  const connect = (): void => {
    if (stopped) return;
    let ws: SocketLike;
    try {
      ws = openSocket((deps.socketUrl ?? defaultSocketUrl)());
    } catch {
      state.chatState = "Live chat is off on this server.";
      return;
    }
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", v: 1, lobbyId: id }));
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
      if (msg.type === "lobbyWelcome") {
        state.chatLive = true;
        socketTries = 0;
        state.chatState = "";
        for (const m of (msg.history as ChatMessage[]) ?? []) addChat(m);
      } else if (msg.type === "event" && msg.feature === "lobby-chat") {
        const p = msg.payload as { id: number; text: string };
        addChat({ id: p.id, text: p.text, coach: String(msg.coach), ts: Number(msg.ts) });
      } else if (msg.type === "event" && msg.feature === "lobby-presence") {
        void poll();
      }
    };
    ws.onclose = () => {
      socket = undefined;
      state.chatLive = false;
      if (stopped) return;
      socketTries++;
      if (socketTries > 5) {
        state.chatState = "Live chat is off on this server.";
        return;
      }
      state.chatState = "Chat reconnecting…";
      setT(connect, Math.min(15000, 1000 * 2 ** socketTries));
    };
  };

  return {
    id,
    state,
    poll,
    join,
    close,
    launch,
    sendChat,
    isMine: (m: ChatMessage) => m.coach.toLowerCase() === deps.me().toLowerCase(),
    start() {
      stopped = false;
      void poll().then(connect);
      timer = setI(() => void poll(), 4000);
    },
    stop: stopAll,
  };
}

export type LobbyRoom = ReturnType<typeof createLobbyRoom>;

/** Optional controller factory (tests render the page against a pre-loaded one); the view builds its own otherwise. */
export const LOBBY_ROOM_KEY: InjectionKey<(id: string) => LobbyRoom> = Symbol("lobby-room");
