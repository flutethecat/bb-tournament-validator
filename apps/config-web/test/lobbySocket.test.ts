import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Matchmaker } from "@bb/fork-ops";
import { SuperService } from "../src/super/service";
import { LobbyStore, lobbyOriginAllowed, lobbySocketBridge } from "../src/lobby";
import { createSession, deleteSession, getSession, onSessionEnded, sessionTokenFromRequest, SESSION_COOKIE_NAME } from "../src/auth/session";

// Real upgrade path: an http.Server on port 0 with the Super service's `upgrade` handler, a raw RFC 6455 client,
// and the real session store (Discord vs password provenance, logout = deleteSession).

const ORIGIN = "https://play.example.test";

interface Client {
  frames: Array<Record<string, unknown>>;
  closed: Promise<void>;
  isClosed: () => boolean;
  send(obj: unknown): void;
  waitFor(pred: (f: Record<string, unknown>) => boolean, ms?: number): Promise<Record<string, unknown>>;
  end(): void;
}

const allClients: Array<{ sock: Socket }> = [];

function wsClient(port: number, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(port, "127.0.0.1");
    allClients.push({ sock });
    const frames: Array<Record<string, unknown>> = [];
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    let onClosed!: () => void;
    const closedP = new Promise<void>((r) => { onClosed = r; });
    const waiters: Array<() => void> = [];
    sock.on("close", () => { closed = true; onClosed(); waiters.forEach((w) => w()); });
    sock.on("error", () => { /* surfaced as close */ });
    const client: Client = {
      frames,
      closed: closedP,
      isClosed: () => closed,
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj), "utf8");
        const mask = randomBytes(4);
        const head = payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 255]);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!));
        sock.write(Buffer.concat([head, mask, masked]));
      },
      waitFor(pred, ms = 2000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout; frames=${JSON.stringify(frames)}`)), ms);
          const check = () => {
            const hit = frames.find(pred);
            if (hit) { clearTimeout(t); res(hit); return true; }
            if (closed) { clearTimeout(t); rej(new Error(`closed; frames=${JSON.stringify(frames)}`)); return true; }
            return false;
          };
          if (!check()) waiters.push(() => { check(); });
        });
      },
      end() { sock.destroy(); },
    };
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        buf = buf.subarray(idx + 4);
        if (!head.startsWith("HTTP/1.1 101")) { reject(new Error(head)); return; }
        upgraded = true;
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1) frames.push(JSON.parse(payload.toString("utf8")) as Record<string, unknown>);
        waiters.splice(0).forEach((w) => w());
      }
    });
    sock.write(
      "GET /super HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n",
    );
  });
}

let server: Server;
let port = 0;
let store: LobbyStore;
let service: SuperService;
let lobbyId = "";
let carolLobbyId = "";
/** Tokens revoked WITHOUT a session-store event (models expiry noticed only on access). */
const silentlyRevoked = new Set<string>();

beforeAll(async () => {
  const matchmaker = new Matchmaker();
  store = new LobbyStore({
    matchmaker,
    isBanned: () => false,
    resolveTeam: (_coach, teamId) => ({ teamId, teamName: `Team ${teamId}`, race: "Orc" }),
  });
  matchmaker.onPaired((p) => store.notePairing(p));
  service = new SuperService({
    verifyAuth: async () => false,
    resolveSeat: async () => null,
    log: () => {},
    lobbyChatIntervalMs: 200,
    lobbyMaxSocketsPerCoach: 2,
    lobbySessionCheckMs: 60_000, // the idle backstop; these tests prove the immediate paths
    lobby: lobbySocketBridge(store, {
      sessionFromRequest: (req) => {
        const token = sessionTokenFromRequest(req as IncomingMessage);
        const s = getSession(token);
        return token && s?.method === "discord" ? { coach: s.coach, token } : undefined;
      },
      sessionCoach: (token) => {
        if (silentlyRevoked.has(token)) return undefined;
        const s = getSession(token);
        return s?.method === "discord" ? s.coach : undefined;
      },
      originAllowed: (origin, host) => lobbyOriginAllowed(origin, host, [ORIGIN]),
      onSessionEnded,
    }),
  });
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket) => service.onUpgrade(req, socket));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
  lobbyId = (await store.create("Alice", "t1", "Bob")).id;
  carolLobbyId = (await store.create("Carol", "t3", "Dave")).id;
});

afterAll(async () => {
  for (const c of allClients) c.sock.destroy();
  await new Promise<void>((r) => server.close(() => r()));
});

const cookie = (coach: string, method: "discord" | "password" = "discord") => {
  const { token } = createSession(coach, Date.now(), method);
  return { token, header: `${SESSION_COOKIE_NAME}=${token}` };
};
const hello = (c: Client, id = lobbyId, extra: Record<string, unknown> = {}) => c.send({ type: "hello", lobbyId: id, ...extra });
const refusedWith = async (c: Client) => (await c.waitFor((f) => f.type === "lobbyRefused")).reason;

describe("lobby socket over a real upgrade", () => {
  it("refuses: no session, a password session, a foreign Origin, a non-member, a claimed name that is not the session", async () => {
    const anon = await wsClient(port, { Origin: ORIGIN });
    hello(anon);
    expect(await refusedWith(anon)).toBe("session");

    const pw = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Alice", "password").header });
    hello(pw);
    expect(await refusedWith(pw)).toBe("session");

    const evil = await wsClient(port, { Origin: "https://evil.example.test", Cookie: cookie("Alice").header });
    hello(evil);
    expect(await refusedWith(evil)).toBe("origin");

    const carol = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Carol").header });
    hello(carol);
    expect(await refusedWith(carol)).toBe("member");

    const spoof = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Alice").header });
    hello(spoof, lobbyId, { coach: "Bob" });
    expect(await refusedWith(spoof)).toBe("session");
    await spoof.closed;
    expect(store.history(lobbyId)).toEqual([]);
  });

  it("members chat; publishes are stamped with the session coach; the rate is per coach across sockets; a third socket is refused", async () => {
    const a1 = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Alice").header });
    const a2 = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("alice").header });
    const bob = await wsClient(port, { Cookie: cookie("Bob").header }); // no Origin: not a browser
    for (const c of [a1, a2, bob]) hello(c);
    for (const c of [a1, a2, bob]) await c.waitFor((f) => f.type === "lobbyWelcome");
    const a3 = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Alice").header });
    hello(a3);
    expect(await refusedWith(a3)).toBe("too-many");

    a1.send({ type: "publish", feature: "lobby-chat", payload: { text: "gl hf :+1:" } });
    a2.send({ type: "publish", feature: "lobby-chat", payload: { text: "dropped: same coach inside the interval" } });
    const got = await bob.waitFor((f) => f.feature === "lobby-chat");
    expect(got).toMatchObject({ type: "event", v: 1, lobbyId, coach: "Alice", payload: { text: "gl hf :+1:" } });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.history(lobbyId).map((m) => m.text)).toEqual(["gl hf :+1:"]);

    bob.send({ type: "publish", feature: "lobby-presence", payload: { presence: [] } }); // server-only feature
    bob.send({ type: "publish", feature: "lobby-chat", payload: { text: "x".repeat(501) } });
    await new Promise((r) => setTimeout(r, 100));
    expect(store.history(lobbyId)).toHaveLength(1);
    for (const c of [a1, a2, bob]) c.end();
  });

  it("logout (session deleted) closes the socket and stops publishing", async () => {
    const s = cookie("Bob");
    const bob = await wsClient(port, { Origin: ORIGIN, Cookie: s.header });
    hello(bob);
    await bob.waitFor((f) => f.type === "lobbyWelcome");
    deleteSession(s.token);
    bob.send({ type: "publish", feature: "lobby-chat", payload: { text: "after logout" } });
    await bob.closed;
    expect(store.history(lobbyId).some((m) => m.text === "after logout")).toBe(false);
  });

  it("logout closes an idle socket at once (session-store hook), with no publish from it", async () => {
    const s = cookie("Alice");
    const alice = await wsClient(port, { Origin: ORIGIN, Cookie: s.header });
    hello(alice);
    await alice.waitFor((f) => f.type === "lobbyWelcome");
    deleteSession(s.token);
    await alice.closed;
    expect(alice.isClosed()).toBe(true);
  });

  it("passive delivery after revocation: a revoked recipient gets nothing more and is closed", async () => {
    const a = cookie("Alice");
    const alice = await wsClient(port, { Origin: ORIGIN, Cookie: a.header });
    const bob = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Bob").header });
    hello(alice);
    hello(bob);
    await alice.waitFor((f) => f.type === "lobbyWelcome");
    await bob.waitFor((f) => f.type === "lobbyWelcome");
    silentlyRevoked.add(a.token); // no event: only the outbound re-check can stop delivery
    const before = alice.frames.length;
    bob.send({ type: "publish", feature: "lobby-chat", payload: { text: "for Alice's eyes?" } });
    await alice.closed;
    expect(alice.frames.slice(before).some((f) => f.feature === "lobby-chat")).toBe(false);
    await bob.waitFor((f) => f.feature === "lobby-chat" && (f.payload as { text: string }).text === "for Alice's eyes?");
    bob.end();
  });

  it("presence is pushed, and an expired lobby closes its sockets", async () => {
    const dave = await wsClient(port, { Origin: ORIGIN, Cookie: cookie("Dave").header });
    hello(dave, carolLobbyId);
    await dave.waitFor((f) => f.type === "lobbyWelcome");
    const p = await dave.waitFor((f) => f.feature === "lobby-presence");
    expect((p.payload as { presence: Array<{ coach: string; state: string }> }).presence.find((x) => x.coach === "Dave")!.state).toBe("here");
    (store as unknown as { lobbies: Map<string, { expiresAt: number }> }).lobbies.get(carolLobbyId)!.expiresAt = 0;
    store.sweep();
    await dave.waitFor((f) => f.feature === "lobby-presence" && (f.payload as { expired?: boolean }).expired === true);
    await dave.closed;
  });
});
