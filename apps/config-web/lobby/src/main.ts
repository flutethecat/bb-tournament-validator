// Start Game + Lobby page (start-game spec Part 1 lane 1 + Part 1b). Vanilla TS, built by Vite to public/lobby/.
// Routes: /lobby/ = Start Game, /lobby/#<lobbyId> = the Lobby. Identity = the Discord session (cookie).
// Everything shown is server-derived; user text is only ever set with textContent.

import "./style.css";
import { api, ApiError, type ChatMessage, type LibraryTeam, type LobbyView, type PendingChallenge, type Roster, type SeatView, type SessionInfo } from "./api";
import { expiryLine, lobbyIdFromHash, presenceLine, ratingParts, renderEmoji, type RatingLike } from "./format";

const RETURN_KEY = "lobby-return-hash";

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | ((e: Event) => void)> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") el.addEventListener(k.replace(/^on/, ""), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const app = document.getElementById("app")!;
const who = document.getElementById("who")!;
let me = "";
let teams: LibraryTeam[] = [];
let stopCurrent: (() => void) | undefined;

function fmtK(n: number): string {
  const k = n >= 10000 ? Math.round(n / 1000) : n;
  return `${k.toLocaleString("en")}k`;
}

function errorBox(msg: string): HTMLElement {
  return h("p", { class: "lobby-error", role: "alert" }, msg);
}

function teamSelect(id: string): HTMLSelectElement {
  const sel = h("select", { id, "aria-label": "Your team" });
  if (!teams.length) sel.append(h("option", { value: "" }, "No teams in your library yet"));
  for (const t of teams) sel.append(h("option", { value: t.teamId }, `${t.teamName} (${t.race}, TV ${fmtK(t.teamValue)})`));
  return sel;
}

async function loadTeams(): Promise<void> {
  try {
    const res = await api<{ teams: LibraryTeam[] }>(`/api/fork/library?coach=${encodeURIComponent(me)}`);
    teams = res.teams ?? [];
  } catch {
    teams = [];
  }
}

// ── sign-in ──

function renderSignIn(ssoEnabled: boolean): void {
  who.textContent = "Not signed in";
  app.replaceChildren(
    h("section", { class: "lobby-card" },
      h("h2", {}, "Sign in"),
      h("p", {}, "Sign in with Discord to start a game."),
      ssoEnabled
        ? h("a", { class: "lobby-btn primary", href: "/api/auth/discord/start?next=%2Flobby%2F", onclick: () => {
            try { sessionStorage.setItem(RETURN_KEY, location.hash); } catch { /* storage off */ }
          } }, "Sign in with Discord")
        : errorBox("Discord sign-in is not set up on this server."),
    ),
  );
}

async function renderIdentity(): Promise<void> {
  who.replaceChildren(h("span", {}, "Signed in with Discord as "), h("strong", {}, me));
  try {
    const account = await api<{ discordAvatarUrl?: string | null; profile?: { avatar?: string } }>("/api/account");
    const src = account.profile?.avatar || account.discordAvatarUrl;
    if (src) who.prepend(h("img", { class: "lobby-avatar small", src, alt: "" }));
  } catch { /* the name alone is enough */ }
}

// ── Start Game ──

function renderStart(): () => void {
  let stopped = false;
  const challengeErr = h("div");
  const opponent = h("input", { id: "opponent", type: "text", maxlength: "40", autocomplete: "off", placeholder: "Coach name", "aria-label": "Opponent coach name" });
  const startTeam = teamSelect("start-team");
  const challengeBtn = h("button", { class: "lobby-btn primary", type: "submit" }, "Challenge");
  const form = h("form", { class: "lobby-form", onsubmit: async (e: Event) => {
    e.preventDefault();
    challengeErr.replaceChildren();
    if (!startTeam.value) return challengeErr.replaceChildren(errorBox("Pick a team first."));
    if (!opponent.value.trim()) return challengeErr.replaceChildren(errorBox("Enter the coach you want to play."));
    challengeBtn.disabled = true;
    try {
      const res = await api<{ lobby: LobbyView }>("/api/lobby", { method: "POST", body: { teamId: startTeam.value, opponent: opponent.value.trim() } });
      location.hash = res.lobby.id;
    } catch (err) {
      challengeErr.replaceChildren(errorBox((err as Error).message));
    } finally {
      challengeBtn.disabled = false;
    }
  } },
    h("label", { for: "start-team" }, "Your team"), startTeam,
    h("label", { for: "opponent" }, "Opponent"), opponent,
    challengeBtn,
  );

  const inbox = h("div", { class: "lobby-list" });
  const mine = h("div", { class: "lobby-list" });
  app.replaceChildren(
    h("section", { class: "lobby-card" }, h("h2", {}, "Challenge a coach"),
      h("p", { class: "muted" }, "The game starts when they accept. You both wait in a lobby with chat until then."),
      form, challengeErr),
    h("section", { class: "lobby-card" }, h("h2", {}, "Challenges for you"), inbox),
    h("section", { class: "lobby-card" }, h("h2", {}, "Your lobbies"), mine),
  );

  const refresh = async (): Promise<void> => {
    let data: { lobbies: LobbyView[]; challenges: PendingChallenge[] };
    try {
      data = await api("/api/lobby");
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void boot();
      inbox.replaceChildren(errorBox((err as Error).message));
      return;
    }
    if (stopped) return;
    inbox.replaceChildren(...(data.challenges.length ? data.challenges.map(challengeRow) : [h("p", { class: "muted" }, "No challenges right now.")]));
    mine.replaceChildren(...(data.lobbies.length ? data.lobbies.map(lobbyRow) : [h("p", { class: "muted" }, "No open lobbies.")]));
  };

  const challengeRow = (c: PendingChallenge): HTMLElement => {
    const sel = teamSelect(`accept-${c.coach}`);
    const err = h("div");
    const btn = h("button", { class: "lobby-btn primary", type: "button", onclick: async () => {
      if (!sel.value) return err.replaceChildren(errorBox("Pick a team first."));
      btn.disabled = true;
      try {
        const res = c.lobbyId
          ? await api<{ lobby: LobbyView }>(`/api/lobby/${c.lobbyId}/join`, { method: "POST", body: { teamId: sel.value } })
          : await api<{ lobby: LobbyView }>("/api/lobby", { method: "POST", body: { teamId: sel.value, opponent: c.coach } });
        location.hash = res.lobby.id;
      } catch (e) {
        err.replaceChildren(errorBox((e as Error).message));
        btn.disabled = false;
      }
    } }, "Accept");
    return h("div", { class: "lobby-row" }, h("span", {}, h("strong", {}, c.coach), " challenged you"), sel, btn,
      c.lobbyId ? h("a", { href: `#${c.lobbyId}` }, "Open lobby") : null, err);
  };

  const lobbyRow = (l: LobbyView): HTMLElement => {
    const other = l.me === "creator" ? l.opponent : l.creator;
    const status = l.status === "ready" ? "Game ready" : l.status === "waiting" ? "Waiting" : "Challenge lapsed";
    return h("div", { class: "lobby-row" }, h("a", { href: `#${l.id}` }, `vs ${other.coach}`), h("span", { class: "muted" }, status));
  };

  void refresh();
  const timer = window.setInterval(() => void refresh(), 5000);
  return () => { stopped = true; window.clearInterval(timer); };
}

// ── Lobby ──

function rosterTable(roster: Roster): HTMLElement {
  const rows = roster.players.map((p) => h("tr", {},
    h("td", {}, String(p.number)),
    h("td", {}, p.name),
    h("td", {}, p.position ?? ""),
    h("td", {}, [p.ma, p.st, p.ag === null ? null : `${p.ag}+`, p.pa === null ? "-" : `${p.pa}+`, p.av === null ? null : `${p.av}+`].map((v) => v ?? "-").join(" / ")),
    h("td", {}, p.skills.join(", ")),
    h("td", {}, String(p.spp)),
    h("td", {}, [...p.injuries, p.mng ? "MNG" : ""].filter(Boolean).join(", ")),
  ));
  const staff = [
    `Rerolls ${roster.rerolls}`,
    roster.apothecary ? "Apothecary" : "",
    `Assistant coaches ${roster.assistantCoaches}`,
    `Cheerleaders ${roster.cheerleaders}`,
    `Fans ${roster.fanFactor}`,
    `Treasury ${fmtK(roster.treasury)}`,
  ].filter(Boolean).join(" · ");
  return h("div", { class: "roster" },
    h("p", { class: "roster-head" }, h("strong", {}, roster.name), ` ${roster.race} · TV ${fmtK(roster.teamValue)}`),
    h("p", { class: "muted" }, staff),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ...["#", "Name", "Position", "MA / ST / AG / PA / AV", "Skills", "SPP", "Injuries"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...rows))),
  );
}

function renderLobby(id: string): () => void {
  let stopped = false;
  let view: LobbyView | undefined;
  let socket: WebSocket | undefined;
  let socketTries = 0;
  let chatLive = false;
  const seenChat = new Set<number>();
  const rosterLoaded = { creator: "", opponent: "" };
  let cardLoaded = "";

  const title = h("h2", {}, "Lobby");
  const status = h("p", { class: "lobby-status" });
  const expiry = h("p", { class: "muted" });
  const presence = h("ul", { class: "presence" });
  const joinBox = h("div");
  const launchErr = h("div");
  const launchNote = h("p", { class: "muted" }, "Downloads the game file for your seat. Open it with Super FUMBBL.");
  const startBtn = h("button", { class: "lobby-btn primary big", type: "button", disabled: true, onclick: () => void launch() }, "Start game");
  const card = h("div", { class: "coach-card" });
  const rosterCols = { creator: h("div", { class: "roster-col" }), opponent: h("div", { class: "roster-col" }) };
  const chatLog = h("ol", { class: "chat-log", "aria-live": "polite" });
  const chatState = h("p", { class: "muted" }, "Connecting chat…");
  const chatInput = h("input", { type: "text", maxlength: "500", placeholder: "Say something (:+1: works)", "aria-label": "Chat message", disabled: true });
  const chatForm = h("form", { class: "chat-form", onsubmit: (e: Event) => {
    e.preventDefault();
    const text = chatInput.value.trim();
    if (!text || !socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "publish", feature: "lobby-chat", payload: { text } }));
    chatInput.value = "";
  } }, chatInput, h("button", { class: "lobby-btn", type: "submit" }, "Send"));

  app.replaceChildren(
    h("p", {}, h("a", { href: "#" }, "← Start Game")),
    h("section", { class: "lobby-card" }, title, status, expiry, presence, joinBox,
      h("div", { class: "launch" }, startBtn, launchNote, launchErr)),
    h("section", { class: "lobby-grid" },
      h("div", { class: "lobby-card" }, h("h3", {}, "Opponent"), card),
      h("div", { class: "lobby-card chat" }, h("h3", {}, "Chat"), chatState, chatLog, chatForm)),
    h("section", { class: "lobby-grid rosters" },
      h("div", { class: "lobby-card" }, rosterCols.creator),
      h("div", { class: "lobby-card" }, rosterCols.opponent)),
  );

  const addChat = (m: ChatMessage): void => {
    if (seenChat.has(m.id)) return;
    seenChat.add(m.id);
    const time = new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    chatLog.append(h("li", { class: m.coach.toLowerCase() === me.toLowerCase() ? "mine" : "" },
      h("span", { class: "chat-time" }, time), " ", h("strong", {}, m.coach), " ", h("span", {}, renderEmoji(m.text))));
    chatLog.scrollTop = chatLog.scrollHeight;
  };

  const showGone = (msg: string): void => {
    stopped = true;
    socket?.close();
    app.replaceChildren(h("section", { class: "lobby-card" }, h("h2", {}, "Lobby"), h("p", {}, msg), h("a", { class: "lobby-btn", href: "#" }, "Back to Start Game")));
  };

  const loadRoster = async (role: "creator" | "opponent", seat: SeatView): Promise<void> => {
    const keyNow = seat.team?.teamId ?? "";
    if (rosterLoaded[role] === keyNow && keyNow) return;
    rosterLoaded[role] = keyNow;
    const col = rosterCols[role];
    const heading = h("h3", {}, role === view?.me ? "Your team" : `${seat.coach}'s team`);
    if (!seat.team) {
      rosterLoaded[role] = "";
      col.replaceChildren(heading, h("p", { class: "muted" }, "Roster not shared yet."));
      return;
    }
    try {
      const res = await api<{ shared: boolean; roster: Roster | null }>(`/api/lobby/${id}/roster?role=${role}`);
      col.replaceChildren(heading, res.roster ? rosterTable(res.roster) : h("p", { class: "muted" }, "Roster not shared yet."));
    } catch (err) {
      rosterLoaded[role] = "";
      col.replaceChildren(heading, errorBox((err as Error).message));
    }
  };

  const loadCard = async (seat: SeatView, role: "creator" | "opponent"): Promise<void> => {
    if (cardLoaded === seat.coach) return;
    cardLoaded = seat.coach;
    const body = h("div", { class: "coach-body" }, h("strong", {}, seat.coach));
    card.replaceChildren(body);
    try {
      const info = await api<{ avatar: string | null; fumbblName: string | null }>(`/api/lobby/${id}/coach?role=${role}`);
      if (info.avatar) card.prepend(h("img", { class: "lobby-avatar", src: info.avatar, alt: "" }));
      if (!info.fumbblName) {
        body.append(h("p", { class: "muted" }, "No FUMBBL rating linked."));
        return;
      }
      const res = await api<{ rating: RatingLike & { name: string } }>(`/api/coach-rating?name=${encodeURIComponent(info.fumbblName)}`);
      const parts = ratingParts(res.rating);
      body.append(
        h("p", {}, `FUMBBL: ${res.rating.name || info.fumbblName}`, res.rating.title ? h("span", { class: "title-badge" }, res.rating.title) : null),
        h("p", { class: "muted" }, parts.length ? parts.join(" · ") : "No FUMBBL record found."),
      );
    } catch {
      body.append(h("p", { class: "muted" }, "No FUMBBL rating linked."));
    }
  };

  const renderJoin = (v: LobbyView): void => {
    if (v.me !== "opponent" || v.status === "ready" || v.opponent.team) {
      joinBox.replaceChildren();
      if (v.me === "creator" && v.status !== "ready") {
        joinBox.replaceChildren(h("button", { class: "lobby-btn", type: "button", onclick: async () => {
          try { await api(`/api/lobby/${id}/close`, { method: "POST" }); location.hash = ""; }
          catch (err) { launchErr.replaceChildren(errorBox((err as Error).message)); }
        } }, "Close lobby"));
      }
      return;
    }
    if (joinBox.querySelector("select")) return; // keep the coach's pick across polls
    const sel = teamSelect("join-team");
    const err = h("div");
    const btn = h("button", { class: "lobby-btn primary", type: "button", onclick: async () => {
      if (!sel.value) return err.replaceChildren(errorBox("Pick a team first."));
      btn.disabled = true;
      try {
        const res = await api<{ lobby: LobbyView }>(`/api/lobby/${id}/join`, { method: "POST", body: { teamId: sel.value } });
        apply(res.lobby);
      } catch (e) {
        err.replaceChildren(errorBox((e as Error).message));
        btn.disabled = false;
      }
    } }, "Accept with this team");
    joinBox.replaceChildren(h("div", { class: "lobby-form inline" }, h("label", { for: "join-team" }, "Your team"), sel, btn), err);
  };

  const apply = (v: LobbyView): void => {
    view = v;
    const mine = v.me === "creator" ? v.creator : v.opponent;
    const other = v.me === "creator" ? v.opponent : v.creator;
    const otherRole = v.me === "creator" ? "opponent" : "creator";
    title.textContent = `${v.creator.coach} vs ${v.opponent.coach}`;
    status.textContent = v.status === "ready"
      ? `Game set up${v.game?.gameId ? ` (game ${v.game.gameId})` : ""}. ${v.canLaunch ? "Ready to start." : "Waiting for both coaches."}`
      : v.status === "waiting"
        ? v.me === "creator" ? `Waiting for ${other.coach} to accept.` : `${other.coach} challenged you. Pick a team to accept.`
        : v.me === "creator" ? `Your challenge lapsed. It renews when ${other.coach} accepts.` : `Pick a team to accept.`;
    expiry.textContent = expiryLine(v.expiresAt, Date.now());
    presence.replaceChildren(...[v.creator, v.opponent].map((s) => h("li", { class: `presence-${s.state}` }, presenceLine(s.coach, s.state))));
    startBtn.disabled = !v.canLaunch;
    startBtn.textContent = mine.state === "client" ? "Start game again" : "Start game";
    renderJoin(v);
    void loadRoster("creator", v.creator);
    void loadRoster("opponent", v.opponent);
    void loadCard(other, otherRole);
    if (!chatLive) for (const m of v.chat ?? []) addChat(m);
  };

  const poll = async (): Promise<void> => {
    try {
      const res = await api<{ lobby: LobbyView; chatLive: boolean }>(`/api/lobby/${id}`);
      if (stopped) return;
      apply(res.lobby);
      if (!res.chatLive && !socket) chatState.textContent = "Live chat is off on this server.";
    } catch (err) {
      if (err instanceof ApiError && (err.status === 410 || err.status === 404 || err.status === 403)) return showGone(err.message);
      if (err instanceof ApiError && err.status === 401) return void boot();
      status.textContent = (err as Error).message;
    }
  };

  const launch = async (): Promise<void> => {
    launchErr.replaceChildren();
    startBtn.disabled = true;
    try {
      const res = await api<{ jnlpUrl: string; scheme: string | null }>(`/api/lobby/${id}/launch`, { method: "POST" });
      const a = h("a", { href: res.scheme ?? res.jnlpUrl, download: "" });
      document.body.append(a);
      a.click();
      a.remove();
      await poll();
    } catch (err) {
      launchErr.replaceChildren(errorBox((err as Error).message));
      startBtn.disabled = !view?.canLaunch;
    }
  };

  const connect = (): void => {
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    let ws: WebSocket;
    try { ws = new WebSocket(`${proto}//${location.host}/super`); } catch { chatState.textContent = "Live chat is off on this server."; return; }
    socket = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: "hello", v: 1, lobbyId: id }));
    ws.onmessage = (ev) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
      if (msg.type === "lobbyWelcome") {
        chatLive = true;
        socketTries = 0;
        chatState.textContent = "";
        chatInput.disabled = false;
        for (const m of (msg.history as ChatMessage[]) ?? []) addChat(m);
      } else if (msg.type === "event" && msg.feature === "lobby-chat") {
        const p = msg.payload as { id: number; text: string };
        addChat({ id: p.id, text: p.text, coach: String(msg.coach), ts: Number(msg.ts) });
      } else if (msg.type === "event" && msg.feature === "lobby-presence") {
        const p = msg.payload as { expired?: boolean };
        if (p.expired) void poll();
        else void poll();
      }
    };
    ws.onclose = () => {
      socket = undefined;
      chatLive = false;
      chatInput.disabled = true;
      if (stopped) return;
      socketTries++;
      if (socketTries > 5) { chatState.textContent = "Live chat is off on this server."; return; }
      chatState.textContent = "Chat reconnecting…";
      window.setTimeout(connect, Math.min(15000, 1000 * 2 ** socketTries));
    };
  };

  void poll().then(connect);
  const timer = window.setInterval(() => void poll(), 4000);
  return () => { stopped = true; window.clearInterval(timer); socket?.close(); };
}

// ── router ──

function route(): void {
  stopCurrent?.();
  const id = lobbyIdFromHash(location.hash);
  stopCurrent = id ? renderLobby(id) : renderStart();
}

async function boot(): Promise<void> {
  stopCurrent?.();
  stopCurrent = undefined;
  let session: SessionInfo;
  try {
    session = await api<SessionInfo>("/api/auth/session");
  } catch (err) {
    app.replaceChildren(errorBox((err as Error).message));
    return;
  }
  if (!session.authenticated || !session.coach) return renderSignIn(session.discordSsoEnabled !== false);
  me = session.coach;
  try {
    const back = sessionStorage.getItem(RETURN_KEY);
    if (back) { sessionStorage.removeItem(RETURN_KEY); if (!location.hash) location.hash = back; }
  } catch { /* storage off */ }
  void renderIdentity();
  await loadTeams();
  route();
}

window.addEventListener("hashchange", () => { if (me) route(); });
void boot();
