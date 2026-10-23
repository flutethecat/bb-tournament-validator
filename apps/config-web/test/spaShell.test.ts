import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError, type LobbyView, type PendingChallenge } from "../spa/src/shared/api";
import { createSessionStore, discordLoginUrl, appPath, type Fetcher } from "../spa/src/session";
import { controlFor, createLobbyRoom, startLabel, statusLine, type SocketLike } from "../spa/src/lobby/room";
import { createLobbyStart, lobbyStatusLabel } from "../spa/src/lobby/start";
import { CHAT_KEEP } from "../spa/src/shared/format";

// SPA shell (apps/config-web/spa): session store, router gate, the lobby controllers, and server-rendered routes.
// The .vue routes are loaded through the SPA's own Vite config (ssrLoadModule, middleware mode: no port opened),
// so the test exercises exactly what build:spa compiles.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
/** A fetcher answering from a path table; an ApiError value is thrown (status + server message). */
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body: unknown }> } {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = routes[`${method} ${path}`] !== undefined ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const seat = (coach: string, role: "creator" | "opponent", extra: Partial<LobbyView["creator"]> = {}): LobbyView["creator"] => ({
  coach, role, team: null, state: "here", side: null, ...extra,
});

const readyLobby = (): LobbyView => ({
  id: "lobbyAB12",
  me: "creator",
  createdAt: 0,
  expiresAt: Date.now() + 30 * 60000,
  startedAt: null,
  status: "ready",
  opponentAccepted: true,
  canAccept: false,
  canRenew: false,
  creator: seat("Alice", "creator", { team: { teamId: "t1", teamName: "Alice Orcs", race: "Orc" }, side: "home" }),
  opponent: seat("Bob", "opponent", { team: { teamId: "t2", teamName: "Bob Elves", race: "Wood Elf" }, state: "client", side: "away" }),
  game: { gameName: "g", gameId: "77" },
  bothPresent: true,
  canLaunch: true,
  chat: [{ id: 1, coach: "Bob", text: "gl :+1:", ts: Date.UTC(2026, 9, 22, 18, 5) }],
});

const roster = (name: string) => ({
  teamId: "t1", name, race: "Orc", teamValue: 1_000_000, treasury: 50_000, rerolls: 3, apothecary: true, fanFactor: 2,
  assistantCoaches: 0, cheerleaders: 1,
  players: [{ number: 1, name: "Grob", position: "Blitzer", skills: ["Block"], injuries: [], spp: 6, value: 80, ma: 6, st: 3, ag: 3, pa: 4, av: 10, mng: false }],
});

const roomRoutes = (lobby: LobbyView): Routes => ({
  "/api/lobby/lobbyAB12": { lobby, chatLive: false },
  "/api/lobby/lobbyAB12/roster?role=creator": { shared: true, roster: roster("Alice Orcs") },
  "/api/lobby/lobbyAB12/roster?role=opponent": { shared: false, roster: null },
  "/api/lobby/lobbyAB12/coach?role=opponent": { avatar: "https://cdn.discordapp.test/a.png", fumbblName: "BobF" },
  "/api/coach-rating?name=BobF": { rating: { name: "BobF", title: "Star", record: { w: 3, d: 1, l: 2 }, cr: 150.2 } },
});

describe("session store", () => {
  it("reads /api/auth/session once; concurrent callers share the request", async () => {
    const f = mockFetcher({ "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true } });
    const s = createSessionStore(f);
    expect(s.state.status).toBe("idle");
    expect(s.signedIn()).toBe(false);
    await Promise.all([s.load(), s.load()]);
    await s.load();
    expect(f.calls.filter((c) => c.path === "/api/auth/session")).toHaveLength(1);
    expect(s.state.status).toBe("ready");
    expect(s.signedIn()).toBe(true);
    expect(s.coach()).toBe("Alice");
  });

  it("a password session is not signed in here (Discord only) and is never labelled Discord", async () => {
    const s = createSessionStore(mockFetcher({ "/api/auth/session": { authenticated: true, coach: "PwCoach", authMethod: "password" } }));
    await s.load();
    expect(s.signedIn()).toBe(false);
    expect(s.coach()).toBe("");
    expect(s.otherSession()).toBe(true);
    const old = createSessionStore(mockFetcher({ "/api/auth/session": { authenticated: true, coach: "NoMethod" } }));
    await old.load();
    expect(old.signedIn()).toBe(false);
  });

  it("signed out, SSO off, and errors are states, never throws", async () => {
    const out = createSessionStore(mockFetcher({ "/api/auth/session": { authenticated: false, discordSsoEnabled: false } }));
    await out.load();
    expect(out.signedIn()).toBe(false);
    expect(out.coach()).toBe("");
    expect(out.ssoEnabled()).toBe(false);

    const down = createSessionStore(mockFetcher({ "/api/auth/session": new ApiError(0, "Can't reach the server. Check your connection.") }));
    await expect(down.load()).resolves.toBeUndefined();
    expect(down.state.status).toBe("error");
    expect(down.state.error).toBe("Can't reach the server. Check your connection.");
    expect(down.signedIn()).toBe(false);
  });

  // The successful Sign out runs against the real server in both auth modes (spaServerRoutes*.test.ts); here only
  // the failure path, which must surface and leave the session as the server says it is.
  it("signOut surfaces a rejected logout and re-reads the session (still signed in)", async () => {
    const f = mockFetcher({
      "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
      "POST /api/auth/logout": new ApiError(401, "Authentication required."),
    });
    const s = createSessionStore(f);
    await s.load();
    await expect(s.signOut()).rejects.toThrow("Authentication required.");
    expect(f.calls.filter((c) => c.path === "/api/auth/session")).toHaveLength(2);
    expect(s.signedIn()).toBe(true);
  });

  it("login URL uses the existing Discord flow and returns to the /app path", () => {
    expect(appPath("/lobby/abcDEF12")).toBe("/app/lobby/abcDEF12");
    expect(discordLoginUrl(appPath("/lobby"))).toBe("/api/auth/discord/start?next=%2Fapp%2Flobby");
  });
});

describe("lobby controllers", () => {
  it("status copy and Accept / Confirm / Close come from the server's pairing state", () => {
    const v = readyLobby();
    expect(statusLine(v)).toBe("Game set up (game 77). Ready to start.");
    expect(controlFor(v)).toBe("");
    expect(startLabel(v)).toBe("Start game");
    expect(startLabel({ ...v, me: "opponent" })).toBe("Start game again");
    const waiting: LobbyView = { ...v, status: "waiting", opponentAccepted: false, opponent: { ...v.opponent, team: null }, canLaunch: false, game: null };
    expect(statusLine(waiting)).toBe("Waiting for Bob to accept.");
    expect(controlFor(waiting)).toBe("close");
    // the opponent's Accept shows only when the server says canAccept
    expect(controlFor({ ...waiting, me: "opponent" })).toBe("");
    expect(controlFor({ ...waiting, me: "opponent", canAccept: true })).toBe("accept");
    expect(statusLine({ ...waiting, me: "opponent" })).toBe("Alice challenged you. Pick a team to accept.");
    // needs-renewal: the creator confirms (canRenew); the opponent waits for the creator
    const renewal: LobbyView = { ...waiting, status: "needs-renewal", opponentAccepted: true, canRenew: true };
    expect(controlFor(renewal)).toBe("renew");
    expect(statusLine(renewal)).toBe("Bob accepted. Your challenge needs confirming before the game is set up.");
    expect(statusLine({ ...renewal, me: "opponent", canRenew: false })).toBe("You accepted. Waiting for Alice to confirm.");
    expect(lobbyStatusLabel({ ...renewal, me: "opponent" })).toBe("Waiting for Alice to confirm");
    expect(lobbyStatusLabel(renewal)).toBe("Confirm your challenge");
    expect(lobbyStatusLabel({ ...waiting, opponentAccepted: true })).toBe("Accepted");
    expect(lobbyStatusLabel(v)).toBe("Game ready");
  });

  it("poll loads view, rosters, coach card and chat history; launch hands the URL to the browser", async () => {
    const lobby = readyLobby();
    const f = mockFetcher({ ...roomRoutes(lobby), "POST /api/lobby/lobbyAB12/launch": { jnlpUrl: "/api/lobby/lobbyAB12/jnlp", scheme: null } });
    const download = vi.fn();
    const room = createLobbyRoom("lobbyAB12", { api: f, me: () => "Alice", onSignedOut: vi.fn(), download });
    await room.poll();
    await flush();
    expect(room.state.view?.id).toBe("lobbyAB12");
    expect(room.state.rosters.creator.roster?.name).toBe("Alice Orcs");
    expect(room.state.rosters.opponent).toMatchObject({ status: "ok", roster: null });
    expect(room.state.card).toMatchObject({ coach: "Bob", status: "ok", avatar: "https://cdn.discordapp.test/a.png", fumbbl: { name: "BobF", title: "Star", parts: ["Record 3/1/2", "CR 150.2"] } });
    expect(room.state.chat.map((m) => m.id)).toEqual([1]);
    expect(room.state.chatState).toBe("Live chat is off on this server.");
    await room.launch();
    // the only download is the session-scoped JNLP route the server names
    expect(download).toHaveBeenCalledWith("/api/lobby/lobbyAB12/jnlp");
    // the roster is fetched once per team, not on every poll
    await room.poll();
    await flush();
    expect(f.calls.filter((c) => c.path.includes("/roster?role=creator"))).toHaveLength(1);
  });

  it("socket: hello on open, welcome history + live events de-duplicated, chat publish frame, presence re-polls", async () => {
    const lobby = readyLobby();
    const f = mockFetcher(roomRoutes(lobby));
    const sockets: Array<SocketLike & { sent: string[] }> = [];
    const room = createLobbyRoom("lobbyAB12", {
      api: f, me: () => "alice", onSignedOut: vi.fn(),
      openSocket: (url) => {
        expect(url).toBe("ws://host.test/super");
        const s = { readyState: 1, onopen: null, onmessage: null, onclose: null, sent: [] as string[], send(d: string) { this.sent.push(d); }, close: vi.fn() };
        sockets.push(s);
        return s;
      },
      socketUrl: () => "ws://host.test/super",
      setInterval: () => 1,
      clearInterval: () => undefined,
    });
    room.start();
    await flush();
    const ws = sockets[0]!;
    ws.onopen?.({});
    expect(JSON.parse(ws.sent[0]!)).toEqual({ type: "hello", v: 1, lobbyId: "lobbyAB12" });
    ws.onmessage?.({ data: JSON.stringify({ type: "lobbyWelcome", history: [{ id: 1, coach: "Bob", text: "gl :+1:", ts: 1 }, { id: 2, coach: "Alice", text: "hi", ts: 2 }] }) });
    expect(room.state.chatLive).toBe(true);
    expect(room.state.chatState).toBe("");
    ws.onmessage?.({ data: JSON.stringify({ type: "event", feature: "lobby-chat", coach: "Bob", ts: 3, payload: { id: 3, text: "go" } }) });
    ws.onmessage?.({ data: JSON.stringify({ type: "event", feature: "lobby-chat", coach: "Bob", ts: 3, payload: { id: 3, text: "go" } }) });
    expect(room.state.chat.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(room.isMine(room.state.chat[1]!)).toBe(true);
    expect(room.sendChat("  :joy:  ")).toBe(true);
    expect(JSON.parse(ws.sent[1]!)).toEqual({ type: "publish", feature: "lobby-chat", payload: { text: ":joy:" } });
    expect(room.sendChat("   ")).toBe(false);
    const pollsBefore = f.calls.filter((c) => c.path === "/api/lobby/lobbyAB12").length;
    ws.onmessage?.({ data: JSON.stringify({ type: "event", feature: "lobby-presence", payload: {} }) });
    await flush();
    expect(f.calls.filter((c) => c.path === "/api/lobby/lobbyAB12").length).toBe(pollsBefore + 1);
    room.stop();
    expect(ws.close).toHaveBeenCalled();
  });

  it("rating: a temporary failure says so and retries with backoff; no link only when the server says so", async () => {
    let clock = 1_000_000;
    let ratingUp = false;
    const lobby = readyLobby();
    const f = mockFetcher({
      ...roomRoutes(lobby),
      "/api/coach-rating?name=BobF": () => (ratingUp ? { rating: { name: "BobF", cr: 140 } } : new ApiError(503, "busy")),
    });
    const room = createLobbyRoom("lobbyAB12", { api: f, me: () => "Alice", onSignedOut: vi.fn(), now: () => clock });
    const ratingCalls = () => f.calls.filter((c) => c.path.startsWith("/api/coach-rating")).length;
    await room.poll(); await flush();
    expect(room.state.card).toMatchObject({ status: "unavailable", linkedName: "BobF", fumbbl: null });
    expect(ratingCalls()).toBe(1);
    clock += 10_000; // inside the 15 s backoff: no retry
    await room.poll(); await flush();
    expect(ratingCalls()).toBe(1);
    clock += 6_000; // past it: retried, still down, backoff doubles to 30 s
    await room.poll(); await flush();
    expect(ratingCalls()).toBe(2);
    clock += 20_000;
    await room.poll(); await flush();
    expect(ratingCalls()).toBe(2);
    ratingUp = true;
    clock += 11_000;
    await room.poll(); await flush();
    expect(ratingCalls()).toBe(3);
    expect(room.state.card).toMatchObject({ status: "ok", fumbbl: { name: "BobF", parts: ["CR 140"] } });
    clock += 3_600_000; // loaded: never re-read
    await room.poll(); await flush();
    expect(ratingCalls()).toBe(3);

    const unlinked = createLobbyRoom("lobbyAB12", {
      api: mockFetcher({ ...roomRoutes(lobby), "/api/lobby/lobbyAB12/coach?role=opponent": { avatar: null, fumbblName: null } }),
      me: () => "Alice", onSignedOut: vi.fn(),
    });
    await unlinked.poll(); await flush();
    expect(unlinked.state.card).toMatchObject({ status: "unlinked" });

    const cardDown = createLobbyRoom("lobbyAB12", {
      api: mockFetcher({ ...roomRoutes(lobby), "/api/lobby/lobbyAB12/coach?role=opponent": new ApiError(500, "oops") }),
      me: () => "Alice", onSignedOut: vi.fn(),
    });
    await cardDown.poll(); await flush();
    expect(cardDown.state.card).toMatchObject({ status: "unavailable", linkedName: null });
  });

  it("accept and confirm post join / renew with the picked team", async () => {
    const lobby = { ...readyLobby(), status: "needs-renewal" as const, canRenew: true };
    const f = mockFetcher({
      ...roomRoutes(lobby),
      "POST /api/lobby/lobbyAB12/renew": { lobby: { ...lobby, status: "ready", canRenew: false } },
      "POST /api/lobby/lobbyAB12/join": { lobby },
    });
    const room = createLobbyRoom("lobbyAB12", { api: f, me: () => "Alice", onSignedOut: vi.fn() });
    await room.renew("t1");
    expect(f.calls.at(-1)?.path).not.toBeUndefined();
    expect(f.calls.find((c) => c.path === "/api/lobby/lobbyAB12/renew")).toMatchObject({ method: "POST", body: { teamId: "t1" } });
    expect(room.state.view?.status).toBe("ready");
    await room.join("t9");
    expect(f.calls.find((c) => c.path === "/api/lobby/lobbyAB12/join")).toMatchObject({ method: "POST", body: { teamId: "t9" } });
  });

  it("chat keeps the last 200 lines; a refused socket says why and does not reconnect", async () => {
    const lobby = readyLobby();
    const sockets: Array<SocketLike> = [];
    const timeouts = vi.fn();
    const room = createLobbyRoom("lobbyAB12", {
      api: mockFetcher(roomRoutes(lobby)), me: () => "Alice", onSignedOut: vi.fn(),
      openSocket: () => {
        const s: SocketLike = { readyState: 1, onopen: null, onmessage: null, onclose: null, send() {}, close() {} };
        sockets.push(s);
        return s;
      },
      socketUrl: () => "ws://host.test/super",
      setInterval: () => 1, clearInterval: () => undefined, setTimeout: timeouts,
    });
    room.start();
    await flush();
    const ws = sockets[0]!;
    const history = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, coach: "Bob", text: `m${i}`, ts: i }));
    ws.onmessage?.({ data: JSON.stringify({ type: "lobbyWelcome", history }) });
    expect(room.state.chat).toHaveLength(CHAT_KEEP);
    expect(room.state.chat[0]!.id).toBe(1050);
    expect(room.state.chat.at(-1)!.id).toBe(1249);
    ws.onmessage?.({ data: JSON.stringify({ type: "event", feature: "lobby-chat", coach: "Bob", ts: 9, payload: { id: 2000, text: "new" } }) });
    expect(room.state.chat).toHaveLength(CHAT_KEEP);
    expect(room.state.chat[0]!.id).toBe(1051);
    // an ordinary drop reconnects; a refusal does not
    ws.onclose?.({});
    expect(room.state.chatState).toBe("Chat reconnecting…");
    expect(timeouts).toHaveBeenCalledTimes(1);
    const refusedRoom = createLobbyRoom("lobbyAB12", {
      api: mockFetcher(roomRoutes(lobby)), me: () => "Alice", onSignedOut: vi.fn(),
      openSocket: () => {
        const s: SocketLike = { readyState: 1, onopen: null, onmessage: null, onclose: null, send() {}, close() {} };
        sockets.push(s);
        return s;
      },
      socketUrl: () => "ws://host.test/super",
      setInterval: () => 1, clearInterval: () => undefined, setTimeout: timeouts,
    });
    refusedRoom.start();
    await flush();
    const ws2 = sockets.at(-1)!;
    ws2.onmessage?.({ data: JSON.stringify({ type: "lobbyRefused", v: 1, lobbyId: "lobbyAB12", reason: "too-many" }) });
    ws2.onclose?.({});
    expect(refusedRoom.state.chatState).toBe("Chat is open in too many tabs.");
    expect(timeouts).toHaveBeenCalledTimes(1);
  });

  it("410 shows the gone message and stops; 401 hands back to the session", async () => {
    const gone = createLobbyRoom("lobbyAB12", { api: mockFetcher({ "/api/lobby/lobbyAB12": new ApiError(410, "This lobby has expired.") }), me: () => "A", onSignedOut: vi.fn() });
    await gone.poll();
    expect(gone.state.gone).toBe("This lobby has expired.");
    const onSignedOut = vi.fn();
    const out = createLobbyRoom("lobbyAB12", { api: mockFetcher({ "/api/lobby/lobbyAB12": new ApiError(401, "Authentication required.") }), me: () => "A", onSignedOut });
    await out.poll();
    expect(onSignedOut).toHaveBeenCalledOnce();
    expect(out.state.gone).toBe("");
  });

  it("start: lists, challenge and accept use the same API calls as the vanilla page", async () => {
    const challenge: PendingChallenge = { coach: "Bob", teamId: "t2", opponent: "Alice", createdAt: 0, lobbyId: "lobbyAB12" };
    const f = mockFetcher({
      "GET /api/lobby": { lobbies: [readyLobby()], challenges: [challenge] },
      "POST /api/lobby": { lobby: { id: "newLobby1" } },
      "POST /api/lobby/lobbyAB12/join": { lobby: { id: "lobbyAB12" } },
    });
    const start = createLobbyStart({ api: f, onSignedOut: vi.fn() });
    await start.refresh();
    expect(start.state.loaded).toBe(true);
    expect(start.state.challenges).toHaveLength(1);
    expect(await start.challenge("t1", "Bob")).toBe("newLobby1");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/lobby", body: { teamId: "t1", opponent: "Bob" } });
    expect(await start.accept(challenge, "t1")).toBe("lobbyAB12");
    expect(f.calls.at(-1)).toMatchObject({ method: "POST", path: "/api/lobby/lobbyAB12/join", body: { teamId: "t1" } });
    const onSignedOut = vi.fn();
    const out = createLobbyStart({ api: mockFetcher({ "GET /api/lobby": new ApiError(401, "Authentication required.") }), onSignedOut });
    await out.refresh();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });
});

describe("SPA routes (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // Loaded through the SPA's Vite config so .vue files compile; every module comes from one graph (one Vue).
  let mods: {
    createSpa: (o: { history: unknown; ssr?: boolean; fetcher?: Fetcher }) => { app: { provide: (k: unknown, v: unknown) => void }; router: { push: (p: string) => Promise<unknown>; isReady: () => Promise<void>; currentRoute: { value: { name: unknown; meta: Record<string, unknown> } } }; session: ReturnType<typeof createSessionStore> };
    createMemoryHistory: (base?: string) => unknown;
    renderToString: (app: unknown) => Promise<string>;
    gateFor: (route: { meta: Record<string, unknown> }, s: ReturnType<typeof createSessionStore>) => string;
    createLobbyRoom: typeof createLobbyRoom;
    createLobbyStart: typeof createLobbyStart;
    LOBBY_ROOM_KEY: symbol;
    LOBBY_START_KEY: symbol;
    /** ApiError from the SSR module graph (instanceof checks inside the loaded controllers need this one). */
    ApiError: typeof ApiError;
  };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: SPA_CONFIG,
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true, hmr: false, ws: false },
    });
    const [app, router, room, start, vueRouter, renderer, sharedApi] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/router.ts"),
      vite.ssrLoadModule("/src/lobby/room.ts"),
      vite.ssrLoadModule("/src/lobby/start.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/shared/api.ts"),
    ]);
    mods = {
      createSpa: app.createSpa,
      createMemoryHistory: vueRouter.createMemoryHistory,
      renderToString: renderer.renderToString,
      gateFor: router.gateFor,
      createLobbyRoom: room.createLobbyRoom,
      createLobbyStart: start.createLobbyStart,
      LOBBY_ROOM_KEY: room.LOBBY_ROOM_KEY,
      LOBBY_START_KEY: start.LOBBY_START_KEY,
      ApiError: sharedApi.ApiError,
    };
  }, 60_000);

  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes, setup?: (spa: ReturnType<typeof mods.createSpa>, f: Fetcher) => void | Promise<void>) {
    const f = mockFetcher(routes);
    const spa = mods.createSpa({ history: mods.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await setup?.(spa, f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: await mods.renderToString(spa.app), spa, f };
  }

  it("router gate: signed-out lobby route shows the login prompt, never a crash", async () => {
    for (const path of ["/lobby", "/lobby/abcDEF12", "/account"]) {
      const { html, spa } = await render(path, { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
      expect(mods.gateFor(spa.router.currentRoute.value, spa.session), path).toBe("signin");
      expect(html, path).toContain("Login with Discord");
      expect(html, path).toContain(`href="/api/auth/discord/start?next=${encodeURIComponent(`/app${path}`)}"`);
      expect(html, path).not.toContain("Challenge a coach");
    }
  });

  it("router gate: a password session gets the Login with Discord action, never the Discord label", async () => {
    for (const path of ["/lobby", "/lobby/abcDEF12", "/account"]) {
      const { html } = await render(path, { "/api/auth/session": { authenticated: true, coach: "PwCoach", authMethod: "password", discordSsoEnabled: true } });
      expect(html, path).toContain("This page needs a Discord sign-in.");
      expect(html, path).toContain("Login with Discord");
      expect(html, path).not.toContain("PwCoach");
    }
  });

  it("router gate: SSO off, session read failure, public link-out pages and unknown paths", async () => {
    const off = await render("/lobby", { "/api/auth/session": { authenticated: false, discordSsoEnabled: false } });
    expect(off.html).toContain("Discord sign-in is not set up on this server.");
    const down = await render("/lobby", { "/api/auth/session": new ApiError(0, "Can't reach the server. Check your connection.") });
    expect(down.html).toContain("Can&#39;t check your sign-in");
    expect(down.html).toContain("Try again");
    const tournaments = await render("/tournaments", { "/api/auth/session": { authenticated: false } });
    expect(tournaments.html).toContain('href="/tournaments.html"');
    const tb = await render("/team-builder", { "/api/auth/session": { authenticated: false } });
    expect(tb.html).toContain('href="/team-builder.html"');
    const ttb = await render("/tournament-team-builder", { "/api/auth/session": { authenticated: false } });
    expect(ttb.html).toContain('href="/tournament-team-builder.html"');
    const nf = await render("/nowhere", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } });
    expect(nf.html).toContain("Page not found");
    const badId = await render("/lobby/<x>", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } });
    expect(badId.spa.router.currentRoute.value.name).toBe("not-found");
    const home = await render("/", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } });
    expect(home.spa.router.currentRoute.value.name).toBe("lobby");
  });

  it("nav shows every section; signed in shows the coach, not the login button", async () => {
    const { html } = await render("/tournaments", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } });
    for (const label of ["Lobby", "Tournaments", "Team Builder", "Tournament Team Builder", "Account"]) expect(html).toContain(`>${label}</a>`);
    expect(html).toContain("Alice");
    expect(html).not.toContain("Login with Discord");
  });

  it("lobby route renders the server's lobby: title, status, presence, card, chat, rosters, Start game", async () => {
    const lobby = readyLobby();
    const { html } = await render("/lobby/lobbyAB12", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }, async (spa, f) => {
      const room = mods.createLobbyRoom("lobbyAB12", { api: mockFetcher(roomRoutes(lobby)), me: () => "Alice", onSignedOut: vi.fn() });
      await room.poll();
      await flush();
      spa.app.provide(mods.LOBBY_ROOM_KEY, () => room);
      void f;
    });
    expect(html).toContain("Alice vs Bob");
    expect(html).toContain("Game set up (game 77). Ready to start.");
    expect(html).toContain("Alice is here");
    expect(html).toContain("Bob is in the client");
    expect(html).toContain("FUMBBL: BobF");
    expect(html).toContain("Record 3/1/2 · CR 150.2");
    expect(html).toContain("gl 👍");
    expect(html).toContain("Your team");
    expect(html).toContain("Bob&#39;s team");
    expect(html).toContain("Grob");
    expect(html).toContain("Roster not shared yet.");
    expect(html).toContain("Live chat is off on this server.");
    // Start game is enabled (canLaunch) and the creator sees no Close button on a ready game
    expect(html).toMatch(/<button class="lobby-btn primary big" type="button">\s*Start game\s*<\/button>/);
    expect(html).not.toContain("Close lobby");
  });

  it("lobby route: the creator's Confirm (canRenew) with Close, and rating unavailable copy", async () => {
    const lobby: LobbyView = { ...readyLobby(), status: "needs-renewal", canRenew: true, canLaunch: false, game: null };
    const { html } = await render("/lobby/lobbyAB12", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }, async (spa) => {
      const room = mods.createLobbyRoom("lobbyAB12", {
        api: mockFetcher({ ...roomRoutes(lobby), "/api/coach-rating?name=BobF": new mods.ApiError(503, "busy") }),
        me: () => "Alice", onSignedOut: vi.fn(),
      });
      await room.poll();
      await flush();
      spa.app.provide(mods.LOBBY_ROOM_KEY, () => room);
    });
    expect(html).toContain("Bob accepted. Your challenge needs confirming before the game is set up.");
    expect(html).toMatch(/>\s*Confirm challenge\s*</);
    expect(html).toContain("Close lobby");
    expect(html).not.toContain("Accept with this team");
    expect(html).toContain("FUMBBL: BobF");
    expect(html).toContain("Rating unavailable right now.");
    expect(html).not.toContain("No FUMBBL rating linked.");
    expect(html).toMatch(/<button class="lobby-btn primary big" type="button" disabled>/);
  });

  it("lobby route: the opponent's Accept shows only with canAccept", async () => {
    const base: LobbyView = { ...readyLobby(), me: "opponent", status: "waiting", opponentAccepted: false, canLaunch: false, game: null, opponent: { ...readyLobby().opponent, team: null } };
    const renderWith = async (v: LobbyView) => (await render("/lobby/lobbyAB12", { "/api/auth/session": { authenticated: true, coach: "Bob", authMethod: "discord" } }, async (spa) => {
      const room = mods.createLobbyRoom("lobbyAB12", { api: mockFetcher({ ...roomRoutes(v), "/api/lobby/lobbyAB12/coach?role=creator": { avatar: null, fumbblName: null } }), me: () => "Bob", onSignedOut: vi.fn() });
      await room.poll();
      await flush();
      spa.app.provide(mods.LOBBY_ROOM_KEY, () => room);
    })).html;
    expect(await renderWith({ ...base, canAccept: true })).toMatch(/>\s*Accept with this team\s*</);
    expect(await renderWith(base)).not.toContain("Accept with this team");
  });

  it("lobby route: gone lobby shows the server message and a way back", async () => {
    const { html } = await render("/lobby/lobbyAB12", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }, async (spa) => {
      const room = mods.createLobbyRoom("lobbyAB12", { api: mockFetcher({ "/api/lobby/lobbyAB12": new mods.ApiError(410, "This lobby has expired.") }), me: () => "Alice", onSignedOut: vi.fn() });
      await room.poll();
      spa.app.provide(mods.LOBBY_ROOM_KEY, () => room);
    });
    expect(html).toContain("This lobby has expired.");
    expect(html).toContain("Back to Start Game");
  });

  it("start route: prototype-key coach names (toString, __proto__, constructor) keep Accept usable", async () => {
    const names = ["toString", "__proto__", "constructor", "hasOwnProperty"];
    const challenges: PendingChallenge[] = names.map((coach) => ({ coach, teamId: "t2", opponent: "Alice", createdAt: 0 }));
    const { html } = await render("/lobby", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }, async (spa) => {
      const start = mods.createLobbyStart({ api: mockFetcher({ "GET /api/lobby": { lobbies: [], challenges } }), onSignedOut: vi.fn() });
      await start.refresh();
      spa.app.provide(mods.LOBBY_START_KEY, start);
    });
    for (const coach of names) expect(html, coach).toContain(`<strong>${coach}</strong> challenged you`);
    const accepts = html.match(/<button class="lobby-btn primary" type="button"[^>]*>Accept<\/button>/g) ?? [];
    expect(accepts).toHaveLength(names.length);
    for (const b of accepts) expect(b).not.toContain("disabled");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("function");
  });

  it("start route renders challenges and lobbies from the API", async () => {
    const challenge: PendingChallenge = { coach: "Bob", teamId: "t2", opponent: "Alice", createdAt: 0, lobbyId: "lobbyAB12" };
    const { html } = await render("/lobby", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } }, async (spa) => {
      const start = mods.createLobbyStart({ api: mockFetcher({ "GET /api/lobby": { lobbies: [readyLobby()], challenges: [challenge] } }), onSignedOut: vi.fn() });
      await start.refresh();
      spa.app.provide(mods.LOBBY_START_KEY, start);
    });
    expect(html).toContain("Challenge a coach");
    expect(html).toContain("<strong>Bob</strong> challenged you");
    expect(html).toContain('href="/app/lobby/lobbyAB12"');
    expect(html).toContain("vs Bob");
    expect(html).toContain("Game ready");
    expect(html).toContain("No teams in your library yet");
  });

  it("account route shows the Discord identity and the linked FUMBBL name the server returned", async () => {
    const { html } = await render("/account", {
      "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" },
      "/api/account": { ffbCoachId: "Alice", identities: { discordUsername: "alice_dc", email: "a@example.test" }, fumbblName: "AliceF" },
    });
    expect(html).toContain("<h2>Account</h2>");
    expect(html).toContain("alice_dc");
    expect(html).toContain("AliceF");
    expect(html).not.toContain("a@example.test");
    expect(html).toContain("Sign out");
    const unlinked = await render("/account", { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" }, "/api/account": { ffbCoachId: "Alice", fumbblName: null } });
    expect(unlinked.html).toContain("No FUMBBL name linked.");
  });
});

describe("SPA build (smoke)", () => {
  it("vite build emits index.html with the /app/ base and the site theme left unbundled", async () => {
    const { build } = await import("vite");
    const outDir = mkdtempSync(join(tmpdir(), "spa-build-"));
    try {
      await build({ configFile: SPA_CONFIG, logLevel: "silent", build: { outDir, emptyOutDir: true } });
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      expect(html).toMatch(/src="\/app\/assets\/index-[\w-]+\.js"/);
      expect(html).toContain('href="/theme.css"');
      expect(html).toContain('src="/theme.js"');
      const assets = readdirSync(join(outDir, "assets"));
      expect(assets.some((f) => f.endsWith(".css"))).toBe(true);
      const js = assets.filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(outDir, "assets", f), "utf8")).join("\n");
      expect(js).not.toMatch(/re-roll/i);
      expect(js).not.toMatch(/\bjava\b|webstart/i);
      expect(js).not.toMatch(/[A-Za-z]:\\\\Users/);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
