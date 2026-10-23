import { describe, expect, it } from "vitest";
import { Matchmaker } from "@bb/fork-ops";
import { SuperService } from "../src/super/service";
import type { WsConnection } from "../src/super/ws";
import { LobbyStore, lobbySocketBridge } from "../src/lobby";

interface FakeConn {
  data: Record<string, unknown>;
  sent: Array<Record<string, unknown>>;
  closed: boolean;
  onMessage: (text: string) => void;
  onClose: () => void;
  send(text: string): void;
  close(): void;
}

function fakeConn(): FakeConn {
  const c: FakeConn = {
    data: {},
    sent: [],
    closed: false,
    onMessage: () => {},
    onClose: () => {},
    send(text) { if (!c.closed) c.sent.push(JSON.parse(text) as Record<string, unknown>); },
    close() { if (c.closed) return; c.closed = true; c.onClose(); },
  };
  return c;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function setup() {
  const matchmaker = new Matchmaker();
  const store = new LobbyStore({
    matchmaker,
    digestFor: async () => undefined,
    isBanned: () => false,
    resolveTeam: (_coach, teamId) => ({ teamId, teamName: `Team ${teamId}`, race: "Orc" }),
  });
  matchmaker.onPaired((p) => store.notePairing(p));
  const service = new SuperService({
    verifyAuth: async () => false,
    resolveSeat: async () => null,
    log: () => {},
    lobby: lobbySocketBridge(store, () => undefined),
    lobbyChatIntervalMs: 0,
  });
  const lobby = await store.create("Alice", "t1", "Bob");
  const connect = async (sessionCoach: string | undefined, hello: Record<string, unknown> = {}) => {
    const conn = fakeConn();
    service.acceptConnection(conn as unknown as WsConnection, sessionCoach);
    conn.onMessage(JSON.stringify({ type: "hello", lobbyId: lobby.id, ...hello }));
    await flush();
    return conn;
  };
  const say = async (conn: FakeConn, text: unknown, feature = "lobby-chat") => {
    conn.onMessage(JSON.stringify({ type: "publish", feature, payload: { text } }));
    await flush();
  };
  return { store, service, lobby, connect, say };
}

const events = (c: FakeConn, feature: string) => c.sent.filter((m) => m.type === "event" && m.feature === feature);

describe("lobby chat over the Super socket", () => {
  it("a coach who is not in the lobby is refused (no session, wrong coach, or a claimed name that is not the session)", async () => {
    const { connect, store, lobby } = await setup();
    const anon = await connect(undefined);
    expect(anon.closed).toBe(true);
    expect(anon.sent.some((m) => m.type === "lobbyRefused")).toBe(true);
    const carol = await connect("Carol");
    expect(carol.closed).toBe(true);
    const spoof = await connect("Carol", { coach: "Alice" });
    expect(spoof.closed).toBe(true);
    const mismatch = await connect("Alice", { coach: "Bob" });
    expect(mismatch.closed).toBe(true);
    expect(store.history(lobby.id)).toEqual([]);
  });

  it("members get history on welcome; a publish is server-stamped with the session coach and fanned out to both", async () => {
    const { connect, say, store, lobby } = await setup();
    store.appendChat(lobby.id, "Alice", "earlier");
    const alice = await connect("alice");
    const bob = await connect("Bob");
    const welcome = bob.sent.find((m) => m.type === "lobbyWelcome")!;
    expect(welcome).toMatchObject({ lobbyId: lobby.id, coach: "Bob", features: ["lobby-chat", "lobby-presence"] });
    expect((welcome.history as Array<{ text: string }>).map((m) => m.text)).toEqual(["earlier"]);

    await say(alice, "gl hf :+1:");
    for (const c of [alice, bob]) {
      expect(events(c, "lobby-chat").at(-1)).toMatchObject({ v: 1, lobbyId: lobby.id, coach: "Alice", payload: { text: "gl hf :+1:" } });
    }
    expect(store.history(lobby.id).map((m) => m.text)).toEqual(["earlier", "gl hf :+1:"]);
  });

  it("drops invalid payloads and server-only features", async () => {
    const { connect, say, store, lobby } = await setup();
    const alice = await connect("Alice");
    await say(alice, "");
    await say(alice, 42);
    await say(alice, "x".repeat(501));
    await say(alice, "fake presence", "lobby-presence");
    await say(alice, "kick", "s1.kickAim");
    expect(store.history(lobby.id)).toEqual([]);
  });

  it("presence is pushed on join / leave / launch, and an expired lobby closes its sockets", async () => {
    const { connect, store, lobby } = await setup();
    const alice = await connect("Alice");
    const bob = await connect("Bob");
    const lastPresence = (c: FakeConn) => (events(c, "lobby-presence").at(-1)!.payload as { presence: Array<{ coach: string; state: string }> }).presence;
    expect(lastPresence(alice).find((p) => p.coach === "Bob")!.state).toBe("here");
    bob.close();
    expect(lastPresence(alice).find((p) => p.coach === "Bob")!.state).toBe("left");

    await store.join(lobby.id, "Bob", "t2");
    store.launch(lobby.id, "Alice");
    expect(lastPresence(alice).find((p) => p.coach === "Alice")!.state).toBe("client");

    (store as unknown as { lobbies: Map<string, { expiresAt: number }> }).lobbies.get(lobby.id)!.expiresAt = 0;
    store.sweep();
    expect(events(alice, "lobby-presence").at(-1)!.payload).toEqual({ expired: true });
    expect(alice.closed).toBe(true);
  });

  it("a game hello (no lobbyId) still takes the game path", async () => {
    const { service } = await setup();
    const conn = fakeConn();
    service.acceptConnection(conn as unknown as WsConnection, "Alice");
    conn.onMessage(JSON.stringify({ type: "hello", coach: "Alice", gameId: "1", auth: "x" }));
    await flush();
    expect(conn.closed).toBe(true); // verifyAuth=false in this rig -> game auth reject, not a lobby admit
    expect(conn.sent.some((m) => m.type === "lobbyWelcome")).toBe(false);
  });
});
