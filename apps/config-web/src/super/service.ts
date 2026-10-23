// SUPER MODULE service core (keystone §1-§4, §9). Presentation sidecar: relays presentation-only
// payloads between the two authed coaches of a game. NEVER touches the FFB wire, never carries game
// state, never decides anything. On any conflict with FFB game state the CLIENT drops the Super datum
// (the service only guarantees staleness + validation).
//
// Everything here is wrapped so a Super fault degrades to "Super down for this session", never
// "config-web down" (SM-3). Dependencies (auth verification + seat truth) are INJECTED so the concrete
// fork-store/gamestate reads live at the edge (server.ts) and this core stays pure + testable.

import { handshake, type WsConnection } from "./ws.js";
import { getFeature, getLobbyFeature, lobbyFeatures, serviceCapabilities, PITCH_W } from "./registry.js";
import type { LobbySocketBridge } from "../lobby.js";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { randomBytes } from "node:crypto";

export type Seat = "home" | "away";

// ── Pure, unit-testable core (extracted for the fast-follow teeth; the service methods delegate here) ──

/** X-only perspective mirror between a seat's local frame and the server/global frame, per upstream
 *  `FieldCoordinate.transform()` (x' = 25 − x, y unchanged). Self-inverse: applying it twice is identity,
 *  which is why the same function serves local→global and global→local. */
export function mirrorX(x: number, seat: Seat): number {
  return seat === "away" ? PITCH_W - 1 - x : x; // FIELD_WIDTH-1-x ⇒ 25-x
}

/** Active feature set for a game: the ∩ of every present member's advertised caps with what the service
 *  offers — but only once ≥2 members are present (a lone coach ⇒ everything inert). Pure fn of the inputs
 *  so membership/recompute is testable without sockets. */
export function computeActiveFeatures(memberCaps: ReadonlyArray<ReadonlySet<string>>, serviceCaps: ReadonlySet<string>): Set<string> {
  if (memberCaps.length < 2) return new Set();
  let active = new Set(serviceCaps);
  for (const caps of memberCaps) active = new Set([...active].filter((k) => caps.has(k)));
  return active;
}

/** Verify a coach's challenge-response WITHOUT ever seeing the plaintext (SM-5/RC-2). The concrete impl
 *  recomputes md5(nonce+ts+md5(pw)) from the stored `ffb_coaches.password` (already an md5 hex). */
export type AuthVerifier = (
  coach: string,
  nonce: string,
  ts: string,
  response: string,
) => Promise<boolean>;

/** Authoritative seat truth for {gameId, coach} from the server/global frame (SM-6/RC-1): the
 *  `/gamestate/get` poll. Returns null when the coach is NOT a participant (reject) — never guess. */
export type SeatResolver = (gameId: string, coach: string) => Promise<Seat | null>;

export interface SuperOptions {
  verifyAuth: AuthVerifier;
  resolveSeat: SeatResolver;
  /** ms a socket may sit without a valid hello before it's dropped (SC-3). */
  handshakeTimeoutMs?: number;
  /** max publishes/sec per connection per feature; excess is coalesced keep-latest (SM-2). */
  maxPublishHz?: number;
  log?: (line: string) => void;
  /** Web Lobby rooms (lobby-chat / lobby-presence). Absent => a lobby hello is refused. */
  lobby?: LobbySocketBridge;
  /** min ms between two lobby-chat publishes by one coach in one lobby, across all their sockets (default 400). */
  lobbyChatIntervalMs?: number;
  /** max open sockets per coach per lobby (default 3); one more is refused. */
  lobbyMaxSocketsPerCoach?: number;
  /** how often lobby sockets re-check their session (default 15 s; 0 disables the timer). */
  lobbySessionCheckMs?: number;
}

interface Participant {
  conn: WsConnection;
  coach: string;
  seat: Seat;
  caps: Set<string>;
  /** last publish time per feature (rate/coalesce bookkeeping). */
  lastPublish: Map<string, number>;
}

interface GameRoom {
  gameId: string;
  /** one entry per authed coach; a reconnect replaces the prior entry for that coach. */
  members: Map<string, Participant>;
  activeFeatures: Set<string>;
}


export class SuperService {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly log: (line: string) => void;
  private readonly handshakeTimeoutMs: number;
  private readonly minPublishIntervalMs: number;
  /** lobbyId -> the open sockets of its two coaches (a coach may have several tabs). */
  private readonly lobbyRooms = new Map<string, Set<WsConnection>>();
  private readonly lobbyChatIntervalMs: number;
  private readonly lobbyMaxSocketsPerCoach: number;
  /** `${lobbyId}|${coach}` -> last accepted chat publish (per coach, not per socket). */
  private readonly lobbyLastChat = new Map<string, number>();

  constructor(private readonly opts: SuperOptions) {
    this.log = opts.log ?? ((l) => console.log(`[super] ${l}`));
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs ?? 10_000;
    this.minPublishIntervalMs = 1000 / (opts.maxPublishHz ?? 10);
    this.lobbyChatIntervalMs = opts.lobbyChatIntervalMs ?? 400;
    this.lobbyMaxSocketsPerCoach = Math.max(1, opts.lobbyMaxSocketsPerCoach ?? 3);
    opts.lobby?.subscribe((lobbyId) => this.broadcastLobbyPresence(lobbyId));
    const checkMs = opts.lobbySessionCheckMs ?? 15_000;
    if (opts.lobby && checkMs > 0) {
      const timer = setInterval(() => this.revalidateLobbySockets(), checkMs);
      (timer as { unref?: () => void }).unref?.();
    }
  }

  /** Attach to an http.Server 'upgrade' event, scoped to a path. Returns the handler for detach. */
  onUpgrade(req: IncomingMessage, socket: Duplex): void {
    // SM-3: the whole upgrade path is caught — a handshake fault closes THIS socket only.
    try {
      const conn = handshake(req, socket);
      if (!conn) return;
      // Lobby identity = the Discord session on the upgrade request (cookie / Bearer), plus the browser
      // Origin check; both captured here, the session re-checked for the socket's whole life.
      if (this.opts.lobby) {
        try {
          const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
          conn.data.originOk = this.opts.lobby.originAllowed(origin, req.headers.host);
          const session = this.opts.lobby.sessionFromRequest(req);
          if (session) conn.data.sessionToken = session.token;
        } catch { /* no session */ }
      }
      this.beginHandshake(conn);
    } catch (e) {
      this.log(`upgrade error (contained): ${(e as Error).message}`);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }

  /** Test seam: run the handshake on an already-upgraded connection (session token + origin verdict given). */
  acceptConnection(conn: WsConnection, session?: { token?: string; originOk?: boolean }): void {
    if (session?.token !== undefined) conn.data.sessionToken = session.token;
    conn.data.originOk = session?.originOk ?? true;
    this.beginHandshake(conn);
  }

  private beginHandshake(conn: WsConnection): void {
    const nonce = randomBytes(16).toString("hex");
    const ts = String(Date.now());
    conn.data.nonce = nonce;
    conn.data.ts = ts;
    conn.data.authed = false;
    // Challenge single-use, short TTL (replay resistance).
    const timer = setTimeout(() => {
      if (!conn.data.authed) { this.log("handshake timeout"); conn.close(); }
    }, this.handshakeTimeoutMs);
    conn.onClose = () => { clearTimeout(timer); this.removeConn(conn); };
    conn.onMessage = (text) => { void this.onFrame(conn, text); };
    this.safeSend(conn, { type: "challenge", v: 1, nonce, ts });
  }

  private async onFrame(conn: WsConnection, text: string): Promise<void> {
    // SM-3: every inbound frame is an isolated island.
    try {
      const msg = JSON.parse(text) as Record<string, unknown>;
      const type = msg.type;
      if (type === "hello" && typeof msg.lobbyId === "string") this.handleLobbyHello(conn, msg);
      else if (type === "hello") await this.handleHello(conn, msg);
      else if (type === "publish" && conn.data.kind === "lobby") this.handleLobbyPublish(conn, msg);
      else if (type === "publish") this.handlePublish(conn, msg);
      else if (type === "bye") conn.close();
      // unknown types are ignored (forward-compat; never error)
    } catch (e) {
      this.log(`frame error (contained): ${(e as Error).message}`);
    }
  }

  private async handleHello(conn: WsConnection, msg: Record<string, unknown>): Promise<void> {
    if (conn.data.authed) return; // one hello per connection
    const coach = typeof msg.coach === "string" ? msg.coach : "";
    const gameId = typeof msg.gameId === "string" ? msg.gameId : "";
    const response = typeof msg.auth === "string" ? msg.auth : "";
    const caps = Array.isArray(msg.capabilities)
      ? new Set(msg.capabilities.filter((c): c is string => typeof c === "string"))
      : new Set<string>();
    if (!coach || !gameId || !response) { conn.close(); return; }

    const nonce = String(conn.data.nonce);
    const ts = String(conn.data.ts);
    const ok = await this.opts.verifyAuth(coach, nonce, ts, response);
    if (!ok) { this.log(`auth reject coach=${coach}`); conn.close(); return; }

    // SM-6/RC-1: authoritative participant + seat truth. null ⇒ not a participant ⇒ reject
    // (admit-unverified is forbidden — it re-opens spoofing). Caller's resolver parks-and-retries
    // internally if the gamestate isn't queryable yet.
    const seat = await this.opts.resolveSeat(gameId, coach);
    if (!seat) { this.log(`participant reject coach=${coach} game=${gameId}`); conn.close(); return; }

    conn.data.authed = true;
    conn.data.coach = coach;
    conn.data.gameId = gameId;

    const room = this.rooms.get(gameId) ?? { gameId, members: new Map(), activeFeatures: new Set() };
    // A reconnect for the same coach replaces the prior socket.
    const prior = room.members.get(coach);
    if (prior && prior.conn !== conn) prior.conn.close();
    room.members.set(coach, { conn, coach, seat, caps, lastPublish: new Map() });
    this.rooms.set(gameId, room);
    this.recomputeAndBroadcast(room);
  }

  /** SM-4: recompute the active set (∩ of all present coaches' caps ∩ serviceCapabilities) and push a
   *  featureSet frame to EVERY current member — so a late-joining coach flips the first connector's
   *  features on the instant they arrive. */
  private recomputeAndBroadcast(room: GameRoom): void {
    const members = [...room.members.values()];
    const active = computeActiveFeatures(members.map((m) => m.caps), new Set(serviceCapabilities()));
    room.activeFeatures = active;
    const list = [...active];
    for (const m of members) {
      this.safeSend(m.conn, { type: "featureSet", v: 1, gameId: room.gameId, features: list });
    }
  }

  private handlePublish(conn: WsConnection, msg: Record<string, unknown>): void {
    if (!conn.data.authed) return;
    const gameId = String(conn.data.gameId);
    const coach = String(conn.data.coach);
    const room = this.rooms.get(gameId);
    if (!room) return;
    const me = room.members.get(coach);
    if (!me || me.conn !== conn) return;

    const featureKey = typeof msg.feature === "string" ? msg.feature : "";
    const feature = getFeature(featureKey);
    if (!feature) return;                         // unknown/disabled feature → drop (SC-5 kill switch)
    if (!room.activeFeatures.has(featureKey)) return; // not active for this game → drop

    // Rate limit (SM-2): DROP within-interval publishes, cap per feature per connection. (For a hover
    // stream this is effectively latest-wins — the next accepted frame carries the current position;
    // it drops the intervening frames rather than buffering+flushing the last one.)
    const now = Date.now();
    const last = me.lastPublish.get(featureKey) ?? 0;
    if (now - last < this.minPublishIntervalMs) return;
    me.lastPublish.set(featureKey, now);

    // SM-2: validate at admission — drop non-conforming, NEVER relay raw peer input.
    const clean = feature.validate(msg.payload);
    if (!clean) return;

    // SM-1/RC-1: the payload is in the PUBLISHER's local frame. Un-mirror to the global frame here,
    // then mirror to each recipient's local frame on fan-out. The service is the ONLY place frame math
    // lives; clients do none.
    const global = feature.coordFramed ? this.toGlobal(clean, me.seat) : clean;

    for (const other of room.members.values()) {
      if (other.coach === coach) continue;              // don't echo to the publisher
      if (!other.caps.has(featureKey)) continue;        // recipient must advertise it
      const local = feature.coordFramed ? this.toLocal(global, other.seat) : global;
      this.safeSend(other.conn, {
        type: "event",
        v: 1,
        gameId,
        coach,                                          // server-stamped publisher (spoof-proof)
        feature: featureKey,
        payload: local,
        ts: now,
      });
    }
  }

  // CC-2 TRANSFORM-SOURCE CITATION (not wire-observation — the fleet flipped 3/4 times trusting wire):
  // upstream `FieldCoordinate.transform()` (fumbbl40k-server ffb-common FieldCoordinate.java:123) returns
  //   new FieldCoordinate(FIELD_WIDTH - 1 - getX(), getY())   // FIELD_WIDTH = 26 ⇒ x' = 25 - x
  // i.e. the perspective mirror is X-ONLY; Y is passed through UNCHANGED. So on-pitch S1 coords mirror
  // as `x = 25 - x`, y untouched. (Off-pitch sentinel columns RSV_/KO_ have special x-mappings, :94-97 —
  // not reachable by on-pitch hover coords; a future off-pitch coord feature must revisit those.)
  // Seat is CACHED per Participant at handshake (SM-6 resolve) — the relay never re-polls gamestate.

  /** Publisher-local → server/global (delegates to the pure `mirrorX`). */
  private toGlobal(p: Record<string, unknown>, seat: Seat): Record<string, unknown> {
    if (typeof p.x !== "number") return p;
    return { ...p, x: mirrorX(p.x, seat) };
  }

  /** Server/global → recipient-local (same x-only mirror; `mirrorX` is self-inverse). */
  private toLocal(p: Record<string, unknown>, seat: Seat): Record<string, unknown> {
    if (typeof p.x !== "number") return p;
    return { ...p, x: mirrorX(p.x, seat) };
  }

  // -- Web Lobby rooms --------------------------------------------------------------------------------------
  // Auth: the coach is the HTTP session bound to the upgrade request (Discord SSO cookie, or a Bearer header),
  // never a name the frame claims. A hello naming a different coach, or a coach who is not one of the lobby's
  // two, is closed. Publishes are server-stamped with that coach (spoof-proof) and re-checked for membership.

  private handleLobbyHello(conn: WsConnection, msg: Record<string, unknown>): void {
    if (conn.data.authed) return;
    const lobby = this.opts.lobby;
    const lobbyId = String(msg.lobbyId);
    const token = typeof conn.data.sessionToken === "string" ? conn.data.sessionToken : "";
    const coach = (lobby && token && lobby.sessionCoach(token)) || "";
    const claimed = typeof msg.coach === "string" ? msg.coach.trim().toLowerCase() : "";
    const room = this.lobbyRooms.get(lobbyId);
    const mine = room ? [...room].filter((c) => String(c.data.coach).toLowerCase() === coach.toLowerCase()).length : 0;
    const reason = !lobby ? "off"
      : conn.data.originOk !== true ? "origin"
      : !coach ? "session"
      : claimed && claimed !== coach.toLowerCase() ? "session"
      : !lobby.isMember(lobbyId, coach) ? "member"
      : mine >= this.lobbyMaxSocketsPerCoach ? "too-many"
      : "";
    if (reason || !lobby) {
      this.log(`lobby reject (${reason}) coach=${coach || "-"} lobby=${lobbyId}`);
      this.safeSend(conn, { type: "lobbyRefused", v: 1, lobbyId, reason });
      conn.close();
      return;
    }
    conn.data.authed = true;
    conn.data.kind = "lobby";
    conn.data.coach = coach;
    conn.data.lobbyId = lobbyId;
    const joined = room ?? new Set<WsConnection>();
    joined.add(conn);
    this.lobbyRooms.set(lobbyId, joined);
    this.safeSend(conn, {
      type: "lobbyWelcome",
      v: 1,
      lobbyId,
      coach,
      features: lobbyFeatures(),
      history: lobby.history(lobbyId),
    });
    lobby.socketOpened(lobbyId, coach); // store emits -> broadcastLobbyPresence
  }

  /** A lobby socket lives only as long as its Discord session (logout / expiry closes it). */
  private lobbySessionValid(conn: WsConnection): boolean {
    const token = typeof conn.data.sessionToken === "string" ? conn.data.sessionToken : "";
    const coach = token ? this.opts.lobby?.sessionCoach(token) : undefined;
    return !!coach && coach.toLowerCase() === String(conn.data.coach).toLowerCase();
  }

  private revalidateLobbySockets(): void {
    try {
      for (const room of [...this.lobbyRooms.values()]) {
        for (const c of [...room]) if (!this.lobbySessionValid(c)) c.close();
      }
    } catch (e) {
      this.log(`lobby session sweep error (contained): ${(e as Error).message}`);
    }
  }

  private handleLobbyPublish(conn: WsConnection, msg: Record<string, unknown>): void {
    const lobby = this.opts.lobby;
    if (!lobby || !conn.data.authed) return;
    const lobbyId = String(conn.data.lobbyId);
    const coach = String(conn.data.coach);
    if (!this.lobbySessionValid(conn)) { conn.close(); return; }
    const feature = getLobbyFeature(typeof msg.feature === "string" ? msg.feature : "");
    if (!feature || !feature.publishable) return;
    const now = Date.now();
    const rateKey = `${lobbyId}|${coach.toLowerCase()}`;
    if (now - (this.lobbyLastChat.get(rateKey) ?? 0) < this.lobbyChatIntervalMs) return;
    this.lobbyLastChat.set(rateKey, now);
    const clean = feature.validate(msg.payload);
    if (!clean) return;
    const stored = lobby.appendChat(lobbyId, coach, clean.text); // null => not a member any more / expired
    if (!stored) return;
    this.fanOutLobby(lobbyId, {
      type: "event",
      v: 1,
      lobbyId,
      coach: stored.coach,
      feature: feature.key,
      payload: { id: stored.id, text: stored.text },
      ts: stored.ts,
    });
  }

  private broadcastLobbyPresence(lobbyId: string): void {
    const room = this.lobbyRooms.get(lobbyId);
    if (!room || room.size === 0) return;
    const presence = this.opts.lobby?.presence(lobbyId) ?? null;
    this.fanOutLobby(lobbyId, {
      type: "event",
      v: 1,
      lobbyId,
      coach: "",
      feature: "lobby-presence",
      payload: presence ? { presence } : { expired: true },
      ts: Date.now(),
    });
    if (!presence) for (const c of [...room]) c.close(); // lobby gone: drop its sockets
  }

  private fanOutLobby(lobbyId: string, frame: unknown): void {
    const room = this.lobbyRooms.get(lobbyId);
    if (!room) return;
    const text = JSON.stringify(frame);
    for (const c of room) {
      try { c.send(text); } catch { /* ignore */ }
    }
  }

  private removeLobbyConn(conn: WsConnection): void {
    const lobbyId = conn.data.lobbyId as string | undefined;
    const coach = conn.data.coach as string | undefined;
    if (!lobbyId || !coach) return;
    const room = this.lobbyRooms.get(lobbyId);
    if (!room || !room.delete(conn)) return;
    if (![...room].some((c) => String(c.data.coach).toLowerCase() === coach.toLowerCase())) {
      this.lobbyLastChat.delete(`${lobbyId}|${coach.toLowerCase()}`);
    }
    if (room.size === 0) this.lobbyRooms.delete(lobbyId);
    this.opts.lobby?.socketClosed(lobbyId, coach);
  }

  private removeConn(conn: WsConnection): void {
    if (conn.data.kind === "lobby") { this.removeLobbyConn(conn); return; }
    const gameId = conn.data.gameId as string | undefined;
    const coach = conn.data.coach as string | undefined;
    if (!gameId || !coach) return;
    const room = this.rooms.get(gameId);
    if (!room) return;
    const m = room.members.get(coach);
    if (m && m.conn === conn) {
      room.members.delete(coach);
      if (room.members.size === 0) this.rooms.delete(gameId); // GC empty room (SC-3)
      else this.recomputeAndBroadcast(room);                  // bye → recompute → S1 goes inert
    }
  }

  private safeSend(conn: WsConnection, obj: unknown): void {
    try { conn.send(JSON.stringify(obj)); } catch { /* ignore — never propagate */ }
  }

  /** Ops visibility (SM-3): coarse health for a log line / future /api/super/health. */
  health(): { games: number; connections: number; lobbies: number } {
    let connections = 0;
    for (const r of this.rooms.values()) connections += r.members.size;
    for (const r of this.lobbyRooms.values()) connections += r.size;
    return { games: this.rooms.size, connections, lobbies: this.lobbyRooms.size };
  }
}
