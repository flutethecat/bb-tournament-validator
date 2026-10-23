// Web Lobby (spec start-game-flow Part 1 lane 1 + Part 1b): a waiting room both coaches share until the game
// starts. The Lobby is a VIEW over the existing matchmaker record (owner correction 10-22), NOT a second
// pairing store:
//   - create = the creator's matchmaker challenge (coach -> opponent),
//   - join   = the opponent's counter-challenge (opponent -> creator); the matchmaker pairs, schedules on the
//              fork (scheduleForkGame through its injected scheduler) and fires `onPaired`, which this store
//              records against the lobby (gameName / gameId / home + away teams, all server-derived).
// What the lobby itself holds is only view state: who the two coaches are, presence, launch marks, and the chat
// history. In memory, swept: a lobby expires 24 h after creation or 1 h after the game starts (first launch).
//
// Identity is the authenticated session's coach (Discord SSO -> ffbCoachId). Challenges are entered with the
// coach's STORED fork credential digest (injected `digestFor`), exactly like the JNLP route derives it; the page
// never sees a password or digest.

import { randomBytes } from "node:crypto";
import type { PairingEvent, PendingChallengeView } from "@bb/fork-ops";

export const LOBBY_TTL_MS = 24 * 60 * 60 * 1000;
export const LOBBY_POST_START_TTL_MS = 60 * 60 * 1000;
export const LOBBY_PRESENCE_WINDOW_MS = 15_000;
export const LOBBY_CHAT_CAP = 200;
export const LOBBY_CHAT_MAX_LEN = 500;

export class LobbyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The slice of Matchmaker the lobby reads and drives. */
export interface LobbyMatchmaker {
  challenge(opts: { coach: string; teamId: string; opponent: string; passwordMd5?: string }): Promise<unknown>;
  pendingOf(coach: string): PendingChallengeView | undefined;
  pendingFor(coach: string): PendingChallengeView[];
  cancel(coach: string): void;
}

export interface LobbyTeam {
  teamId: string;
  teamName: string;
  race: string;
  teamValue?: number;
}

export type ResolveTeam = (coach: string, teamId: string) => LobbyTeam | { error: string; status?: number };

export interface LobbyStoreOptions {
  matchmaker: LobbyMatchmaker;
  /** The coach's stored fork credential digest (md5 hex), or undefined when the host has no fork DB. */
  digestFor: (coach: string) => Promise<string | undefined>;
  isBanned: (coach: string) => boolean;
  resolveTeam: ResolveTeam;
  now?: () => number;
  ttlMs?: number;
  postStartTtlMs?: number;
  presenceWindowMs?: number;
  maxLobbies?: number;
  maxOpenPerCoach?: number;
  chatCap?: number;
}

export type PresenceState = "here" | "left" | "client" | "not-here-yet";
export type LobbyRole = "creator" | "opponent";

interface Seat {
  coach: string;
  team?: LobbyTeam;
  lastSeen?: number;
  sockets: number;
  launchedAt?: number;
}

export interface LobbyChatMessage {
  id: number;
  coach: string;
  text: string;
  ts: number;
}

export interface LobbyRecord {
  id: string;
  createdAt: number;
  expiresAt: number;
  creator: Seat;
  opponent: Seat;
  pairing?: PairingEvent;
  startedAt?: number;
  chat: LobbyChatMessage[];
  nextChatId: number;
}

export interface LobbyPresenceEntry {
  coach: string;
  role: LobbyRole;
  state: PresenceState;
}

const key = (coach: string): string => coach.trim().toLowerCase();
const same = (a: string, b: string): boolean => key(a) === key(b);

/** Control characters out, whitespace runs collapsed, bounded. Empty => null (dropped). */
export function cleanChatText(raw: unknown, maxLen = LOBBY_CHAT_MAX_LEN): string | null {
  if (typeof raw !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return [...text].slice(0, maxLen).join("");
}

export class LobbyStore {
  private readonly lobbies = new Map<string, LobbyRecord>();
  /** Ids of expired / closed lobbies, so the page can say "expired" instead of "not found". Bounded. */
  private readonly tombstones = new Map<string, "expired" | "closed">();
  private readonly listeners: Array<(lobbyId: string) => void> = [];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly postStartTtlMs: number;
  private readonly presenceWindowMs: number;
  private readonly maxLobbies: number;
  private readonly maxOpenPerCoach: number;
  private readonly chatCap: number;

  constructor(private readonly opts: LobbyStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? LOBBY_TTL_MS;
    this.postStartTtlMs = opts.postStartTtlMs ?? LOBBY_POST_START_TTL_MS;
    this.presenceWindowMs = opts.presenceWindowMs ?? LOBBY_PRESENCE_WINDOW_MS;
    this.maxLobbies = opts.maxLobbies ?? 1000;
    this.maxOpenPerCoach = opts.maxOpenPerCoach ?? 5;
    this.chatCap = opts.chatCap ?? LOBBY_CHAT_CAP;
  }

  // ── change feed (the Super socket pushes presence on every change) ──

  subscribe(listener: (lobbyId: string) => void): void {
    this.listeners.push(listener);
  }

  private emit(lobbyId: string): void {
    for (const l of this.listeners) {
      try { l(lobbyId); } catch { /* a listener fault never breaks the store */ }
    }
  }

  // ── expiry ──

  /** Drop expired lobbies (tombstoned). Returns how many were dropped. */
  sweep(): number {
    const now = this.now();
    let dropped = 0;
    for (const [id, lobby] of this.lobbies) {
      if (now >= lobby.expiresAt) {
        this.lobbies.delete(id);
        this.tombstone(id, "expired");
        dropped++;
        this.emit(id);
      }
    }
    return dropped;
  }

  private tombstone(id: string, why: "expired" | "closed"): void {
    this.tombstones.set(id, why);
    while (this.tombstones.size > 2000) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest === undefined) break;
      this.tombstones.delete(oldest);
    }
  }

  /** Why a lobby id is gone ("expired" / "closed"), or undefined when it never existed (or is live). */
  goneReason(id: string): "expired" | "closed" | undefined {
    this.sweep();
    return this.lobbies.has(id) ? undefined : this.tombstones.get(id);
  }

  get(id: string): LobbyRecord | undefined {
    this.sweep();
    return this.lobbies.get(id);
  }

  /** Lobby or a LobbyError (404 / 410 expired). */
  private require(id: string): LobbyRecord {
    const lobby = this.get(id);
    if (lobby) return lobby;
    const gone = this.tombstones.get(id);
    if (gone === "expired") throw new LobbyError(410, "This lobby has expired.");
    if (gone === "closed") throw new LobbyError(410, "This lobby was closed.");
    throw new LobbyError(404, "Lobby not found.");
  }

  roleOf(lobby: LobbyRecord, coach: string): LobbyRole | undefined {
    if (same(lobby.creator.coach, coach)) return "creator";
    if (same(lobby.opponent.coach, coach)) return "opponent";
    return undefined;
  }

  isMember(id: string, coach: string): boolean {
    const lobby = this.get(id);
    return lobby !== undefined && this.roleOf(lobby, coach) !== undefined;
  }

  /** Lobby + the caller's role; 403 for a coach who is not one of the two. */
  requireMember(id: string, coach: string): { lobby: LobbyRecord; role: LobbyRole } {
    const lobby = this.require(id);
    const role = this.roleOf(lobby, coach);
    if (!role) throw new LobbyError(403, "You are not in this lobby.");
    return { lobby, role };
  }

  /** Every live lobby this coach is in, newest first. */
  listFor(coach: string): LobbyRecord[] {
    this.sweep();
    return [...this.lobbies.values()]
      .filter((l) => this.roleOf(l, coach) !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The open (unpaired) lobby between these two coaches, either direction, newest first. */
  private openBetween(a: string, b: string): LobbyRecord | undefined {
    this.sweep();
    return [...this.lobbies.values()]
      .filter((l) => !l.pairing && ((same(l.creator.coach, a) && same(l.opponent.coach, b)) || (same(l.creator.coach, b) && same(l.opponent.coach, a))))
      .sort((x, y) => y.createdAt - x.createdAt)[0];
  }

  private team(coach: string, teamId: string): LobbyTeam {
    const resolved = this.opts.resolveTeam(coach, teamId);
    if ("error" in resolved) throw new LobbyError(resolved.status ?? 400, resolved.error);
    return resolved;
  }

  private async enterChallenge(coach: string, teamId: string, opponent: string): Promise<void> {
    const passwordMd5 = await this.opts.digestFor(coach);
    try {
      await this.opts.matchmaker.challenge({ coach, teamId, opponent, passwordMd5 });
    } catch (e) {
      throw new LobbyError(400, (e as Error).message);
    }
  }

  // ── create = challenge ──

  /**
   * Challenge `opponent` with `teamId` and open (or reuse) the lobby that views it. If the opponent already
   * opened a lobby against this coach, this is that lobby's join (the counter-challenge). If the opponent
   * already challenged this coach from the client, the matchmaker pairs at once and the lobby opens paired.
   */
  async create(coach: string, teamId: string, opponent: string): Promise<LobbyRecord> {
    const me = coach.trim();
    const them = opponent.trim();
    if (!me) throw new LobbyError(401, "Sign in first.");
    if (!teamId.trim()) throw new LobbyError(400, "Pick a team.");
    if (!them) throw new LobbyError(400, "Enter the coach you want to play.");
    if (them.length > 40) throw new LobbyError(400, "Coach names are at most 40 characters.");
    if (same(me, them)) throw new LobbyError(400, "You can't challenge yourself.");
    if (this.opts.isBanned(me)) throw new LobbyError(403, "This account is banned.");
    if (this.opts.isBanned(them)) throw new LobbyError(403, `${them} can't play right now.`);

    const existing = this.openBetween(me, them);
    if (existing && same(existing.opponent.coach, me)) return this.join(existing.id, me, teamId);

    const team = this.team(me, teamId.trim());
    let lobby = existing;
    if (lobby) {
      lobby.creator.team = team;
    } else {
      const openMine = [...this.lobbies.values()].filter((l) => !l.pairing && same(l.creator.coach, me)).length;
      if (openMine >= this.maxOpenPerCoach) throw new LobbyError(429, "You have too many open lobbies. Close one first.");
      if (this.lobbies.size >= this.maxLobbies) throw new LobbyError(503, "Too many lobbies are open. Try again later.");
      const now = this.now();
      lobby = {
        id: randomBytes(9).toString("base64url"),
        createdAt: now,
        expiresAt: now + this.ttlMs,
        creator: { coach: me, team, sockets: 0, lastSeen: now },
        opponent: { coach: them, sockets: 0 },
        chat: [],
        nextChatId: 1,
      };
      this.lobbies.set(lobby.id, lobby);
    }
    try {
      await this.enterChallenge(me, team.teamId, lobby.opponent.coach);
    } catch (e) {
      if (!existing) this.lobbies.delete(lobby.id);
      throw e;
    }
    this.emit(lobby.id);
    return lobby;
  }

  // ── join = counter-challenge ──

  async join(id: string, coach: string, teamId: string): Promise<LobbyRecord> {
    const { lobby, role } = this.requireMember(id, coach);
    if (role !== "opponent") throw new LobbyError(409, "You opened this lobby. Wait for your opponent to join.");
    if (this.opts.isBanned(coach)) throw new LobbyError(403, "This account is banned.");
    if (this.opts.isBanned(lobby.creator.coach)) throw new LobbyError(403, `${lobby.creator.coach} can't play right now.`);
    if (lobby.pairing) return lobby; // already paired: idempotent
    if (!teamId.trim()) throw new LobbyError(400, "Pick a team.");
    const team = this.team(coach, teamId.trim());

    lobby.opponent.coach = coach.trim(); // the session's spelling (fork names are case-sensitive at join)
    lobby.opponent.team = team;
    lobby.opponent.lastSeen = this.now();

    const creator = lobby.creator;
    const theirs = this.opts.matchmaker.pendingOf(creator.coach);
    if (theirs && !same(theirs.opponent, coach)) {
      throw new LobbyError(409, `${creator.coach} has challenged someone else since. Ask them to reopen the lobby.`);
    }
    if (!theirs) {
      // The matchmaker's pending challenge has a short TTL; the lobby (24 h) is the creator's recorded consent,
      // so re-enter their challenge with their stored credential, unchanged team, before the counter-challenge.
      if (!creator.team) throw new LobbyError(409, "The lobby has no team for its creator.");
      await this.enterChallenge(creator.coach, creator.team.teamId, coach.trim());
    }
    await this.enterChallenge(coach.trim(), team.teamId, creator.coach);
    this.emit(lobby.id);
    return lobby;
  }

  /** Matchmaker `onPaired` hook: attach the pairing to the open lobby between the two coaches, if any. */
  notePairing(pairing: PairingEvent): void {
    const lobby = this.openBetween(pairing.home.coach, pairing.away.coach);
    if (!lobby) return; // a client-only pairing: nothing to view
    lobby.pairing = pairing;
    for (const seat of [lobby.creator, lobby.opponent]) {
      const side = same(pairing.home.coach, seat.coach) ? pairing.home : pairing.away;
      seat.coach = side.coach;
      if (!seat.team || seat.team.teamId !== side.teamId) {
        const resolved = this.opts.resolveTeam(side.coach, side.teamId);
        seat.team = "error" in resolved ? { teamId: side.teamId, teamName: "", race: "" } : resolved;
      }
    }
    this.emit(lobby.id);
  }

  /** Close an unpaired lobby (creator only): withdraws the creator's challenge if it still names the opponent. */
  close(id: string, coach: string): void {
    const { lobby, role } = this.requireMember(id, coach);
    if (role !== "creator") throw new LobbyError(403, "Only the coach who opened the lobby can close it.");
    if (lobby.pairing) throw new LobbyError(409, "The game is already set up.");
    const pending = this.opts.matchmaker.pendingOf(lobby.creator.coach);
    if (pending && same(pending.opponent, lobby.opponent.coach)) this.opts.matchmaker.cancel(lobby.creator.coach);
    this.lobbies.delete(id);
    this.tombstone(id, "closed");
    this.emit(id);
  }

  // ── launch ──

  /** My seat's join parameters for the paired game; marks me "in the client" and starts the 1 h clock. */
  launch(id: string, coach: string): { coach: string; teamId: string; gameName: string; gameId?: string; side: "home" | "away" } {
    const { lobby, role } = this.requireMember(id, coach);
    if (this.opts.isBanned(coach)) throw new LobbyError(403, "This account is banned.");
    const pairing = lobby.pairing;
    if (!pairing) throw new LobbyError(409, "The game is not set up yet.");
    const side = same(pairing.home.coach, coach) ? "home" : "away";
    const seatPair = side === "home" ? pairing.home : pairing.away;
    const now = this.now();
    const seat = role === "creator" ? lobby.creator : lobby.opponent;
    seat.launchedAt = now;
    if (lobby.startedAt === undefined) {
      lobby.startedAt = now;
      lobby.expiresAt = Math.min(lobby.expiresAt, now + this.postStartTtlMs);
    }
    this.emit(id);
    return { coach: seatPair.coach, teamId: seatPair.teamId, gameName: pairing.gameName, gameId: pairing.gameId, side };
  }

  // ── presence ──

  private seat(lobby: LobbyRecord, coach: string): Seat | undefined {
    const role = this.roleOf(lobby, coach);
    return role === "creator" ? lobby.creator : role === "opponent" ? lobby.opponent : undefined;
  }

  private stateOf(seat: Seat): PresenceState {
    if (seat.launchedAt !== undefined) return "client";
    if (seat.sockets > 0) return "here";
    if (seat.lastSeen !== undefined && this.now() - seat.lastSeen < this.presenceWindowMs) return "here";
    return seat.lastSeen !== undefined ? "left" : "not-here-yet";
  }

  presence(id: string): LobbyPresenceEntry[] | null {
    const lobby = this.get(id);
    if (!lobby) return null;
    return [
      { coach: lobby.creator.coach, role: "creator", state: this.stateOf(lobby.creator) },
      { coach: lobby.opponent.coach, role: "opponent", state: this.stateOf(lobby.opponent) },
    ];
  }

  /** HTTP heartbeat (the page polls the lobby state). Emits only on a state change. */
  touch(id: string, coach: string): void {
    const lobby = this.get(id);
    const seat = lobby && this.seat(lobby, coach);
    if (!lobby || !seat) return;
    const before = this.stateOf(seat);
    seat.lastSeen = this.now();
    if (this.stateOf(seat) !== before) this.emit(id);
  }

  socketOpened(id: string, coach: string): void {
    const lobby = this.get(id);
    const seat = lobby && this.seat(lobby, coach);
    if (!lobby || !seat) return;
    seat.sockets++;
    seat.lastSeen = this.now();
    this.emit(id);
  }

  socketClosed(id: string, coach: string): void {
    const lobby = this.get(id);
    const seat = lobby && this.seat(lobby, coach);
    if (!lobby || !seat) return;
    seat.sockets = Math.max(0, seat.sockets - 1);
    seat.lastSeen = this.now() - this.presenceWindowMs; // a closed socket is "left" at once, not after the window
    this.emit(id);
  }

  // ── chat ──

  /** Append as `coach` (must be one of the two). Returns the stored message, or null when refused / empty. */
  appendChat(id: string, coach: string, rawText: unknown): LobbyChatMessage | null {
    const lobby = this.get(id);
    if (!lobby) return null;
    const role = this.roleOf(lobby, coach);
    if (!role) return null;
    const text = cleanChatText(rawText);
    if (!text) return null;
    const seat = role === "creator" ? lobby.creator : lobby.opponent;
    const msg: LobbyChatMessage = { id: lobby.nextChatId++, coach: seat.coach, text, ts: this.now() };
    lobby.chat.push(msg);
    const cutoff = this.now() - this.ttlMs;
    while (lobby.chat.length > this.chatCap || (lobby.chat[0] && lobby.chat[0].ts < cutoff)) lobby.chat.shift();
    return msg;
  }

  history(id: string): LobbyChatMessage[] {
    return [...(this.get(id)?.chat ?? [])];
  }

  /** Pending challenges naming this coach (the Start page inbox), each with its lobby id when one is open. */
  inbox(coach: string): Array<PendingChallengeView & { lobbyId?: string }> {
    return this.opts.matchmaker.pendingFor(coach).map((c) => {
      const lobby = this.openBetween(c.coach, coach);
      return lobby && same(lobby.creator.coach, c.coach) ? { ...c, lobbyId: lobby.id } : { ...c };
    });
  }

  /** The caller's view of a lobby (also the HTTP heartbeat's response body). */
  view(lobby: LobbyRecord, coach: string): LobbyView {
    const role = this.roleOf(lobby, coach) ?? "opponent";
    const pending = this.opts.matchmaker.pendingOf(lobby.creator.coach);
    const challengeOpen = !lobby.pairing && pending !== undefined && same(pending.opponent, lobby.opponent.coach);
    const seatView = (seat: Seat, r: LobbyRole): LobbySeatView => ({
      coach: seat.coach,
      role: r,
      team: seat.team ?? null,
      state: this.stateOf(seat),
      side: lobby.pairing ? (same(lobby.pairing.home.coach, seat.coach) ? "home" : "away") : null,
    });
    const creator = seatView(lobby.creator, "creator");
    const opponent = seatView(lobby.opponent, "opponent");
    const bothPresent = [creator, opponent].every((s) => s.state === "here" || s.state === "client");
    return {
      id: lobby.id,
      me: role,
      createdAt: lobby.createdAt,
      expiresAt: lobby.expiresAt,
      startedAt: lobby.startedAt ?? null,
      status: lobby.pairing ? "ready" : challengeOpen ? "waiting" : "lapsed",
      creator,
      opponent,
      game: lobby.pairing ? { gameName: lobby.pairing.gameName, gameId: lobby.pairing.gameId ?? null } : null,
      bothPresent,
      canLaunch: bothPresent && lobby.pairing !== undefined,
      chat: [...lobby.chat],
    };
  }
}

export interface LobbySeatView {
  coach: string;
  role: LobbyRole;
  team: LobbyTeam | null;
  state: PresenceState;
  side: "home" | "away" | null;
}

export interface LobbyView {
  id: string;
  me: LobbyRole;
  createdAt: number;
  expiresAt: number;
  startedAt: number | null;
  /** waiting = the creator's challenge is open; ready = paired (game set up on the fork); lapsed = challenge gone. */
  status: "waiting" | "ready" | "lapsed";
  creator: LobbySeatView;
  opponent: LobbySeatView;
  game: { gameName: string; gameId: string | null } | null;
  bothPresent: boolean;
  canLaunch: boolean;
  chat: LobbyChatMessage[];
}

// ── roster projection: only roster fields, never anything else from the stored team ──

export interface LobbyRosterPlayer {
  number: number;
  name: string;
  position: string | null;
  skills: string[];
  injuries: string[];
  spp: number;
  value: number;
  ma: number | null;
  st: number | null;
  ag: number | null;
  pa: number | null;
  av: number | null;
  mng: boolean;
}

export interface LobbyRoster {
  teamId: string;
  name: string;
  race: string;
  teamValue: number;
  treasury: number;
  rerolls: number;
  apothecary: boolean;
  fanFactor: number;
  assistantCoaches: number;
  cheerleaders: number;
  players: LobbyRosterPlayer[];
}

interface DetailLike {
  id: string; name: string; race: string; teamValue: number; treasury: number; rerolls: number; apothecary: boolean;
  fanFactor: number; assistantCoaches: number; cheerleaders: number;
  players: Array<{
    number: number; name: string; position: string | null; skills: string[]; injuries: string[]; spp: number;
    currentValue: number; movement: number | null; strength: number | null; agility: number | null;
    passing: number | null; armour: number | null; mng: boolean;
  }>;
}

export function lobbyRosterFromDetail(detail: DetailLike): LobbyRoster {
  return {
    teamId: detail.id,
    name: detail.name,
    race: detail.race,
    teamValue: detail.teamValue,
    treasury: detail.treasury,
    rerolls: detail.rerolls,
    apothecary: detail.apothecary,
    fanFactor: detail.fanFactor,
    assistantCoaches: detail.assistantCoaches,
    cheerleaders: detail.cheerleaders,
    players: [...detail.players]
      .sort((a, b) => a.number - b.number)
      .map((p) => ({
        number: p.number,
        name: p.name,
        position: p.position,
        skills: [...p.skills],
        injuries: [...p.injuries],
        spp: p.spp,
        value: p.currentValue,
        ma: p.movement,
        st: p.strength,
        ag: p.agility,
        pa: p.passing,
        av: p.armour,
        mng: p.mng,
      })),
  };
}

// ── HTTP API ──

export interface LobbyCoachCard {
  avatar: string | null;
  fumbblName: string | null;
}

export interface LobbyApiDeps {
  store: LobbyStore;
  /** Roster fields for a team owned by `coach`; undefined when not readable. */
  roster: (coach: string, teamId: string) => LobbyRoster | undefined;
  coachCard: (coach: string) => LobbyCoachCard;
  rating: (name: string) => Promise<unknown>;
  /** Is the lobby chat socket up on this host (Super module attached)? */
  chatLive: () => boolean;
}

export interface LobbyApiResult {
  status: number;
  body: unknown;
}

const LOBBY_ID = /^[A-Za-z0-9_-]{6,32}$/;

export function isLobbyApiPath(path: string): boolean {
  return path === "/api/lobby" || path.startsWith("/api/lobby/") || path === "/api/coach-rating";
}

function field(body: unknown, name: string): string {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  return typeof v === "string" ? v.trim() : "";
}

/** JNLP URL for a seat, on the existing /api/fork/jnlp route (it derives the credential from the session). */
export function seatJnlpUrl(seat: { coach: string; teamId: string; gameName: string; gameId?: string }): string {
  const q = new URLSearchParams({ coach: seat.coach, teamId: seat.teamId, gameName: seat.gameName });
  if (seat.gameId) q.set("gameId", seat.gameId);
  return `/api/fork/jnlp?${q.toString()}`;
}

export async function lobbyApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: { coach: string } | undefined,
  body: unknown,
  deps: LobbyApiDeps,
): Promise<LobbyApiResult | undefined> {
  if (!isLobbyApiPath(path)) return undefined;
  if (!auth?.coach) return { status: 401, body: { error: "Sign in with Discord first." } };
  const me = auth.coach;
  const { store } = deps;
  try {
    if (path === "/api/coach-rating") {
      if (method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      const name = query.get("name")?.trim() ?? "";
      if (!name || name.length > 60) return { status: 400, body: { error: "name is required." } };
      return { status: 200, body: { rating: await deps.rating(name) } };
    }

    if (path === "/api/lobby") {
      if (method === "GET") {
        return {
          status: 200,
          body: {
            coach: me,
            lobbies: store.listFor(me).map((l) => store.view(l, me)).map(({ chat: _chat, ...rest }) => rest),
            challenges: store.inbox(me),
            chatLive: deps.chatLive(),
          },
        };
      }
      if (method === "POST") {
        const claimed = field(body, "coach");
        if (claimed && claimed.toLowerCase() !== me.toLowerCase()) {
          return { status: 403, body: { error: "You can only challenge as yourself." } };
        }
        const lobby = await store.create(me, field(body, "teamId"), field(body, "opponent"));
        return { status: 201, body: { lobby: store.view(lobby, me) } };
      }
      return { status: 405, body: { error: "Method not allowed." } };
    }

    const m = path.match(/^\/api\/lobby\/([^/]+)(?:\/(join|launch|roster|close|coach))?$/);
    if (!m) return { status: 404, body: { error: "Not found." } };
    const id = m[1]!;
    const action = m[2];
    if (!LOBBY_ID.test(id)) return { status: 404, body: { error: "Lobby not found." } };

    if (!action) {
      if (method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      const { lobby } = store.requireMember(id, me);
      store.touch(id, me);
      return { status: 200, body: { lobby: store.view(lobby, me), chatLive: deps.chatLive() } };
    }
    if (action === "join") {
      if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
      const lobby = await store.join(id, me, field(body, "teamId"));
      return { status: 200, body: { lobby: store.view(lobby, me) } };
    }
    if (action === "launch") {
      if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
      const seat = store.launch(id, me);
      // superfumbbl:// needs a launch-token mint (spec Part 1 §4), which does not exist yet.
      return { status: 200, body: { jnlpUrl: seatJnlpUrl(seat), scheme: null, side: seat.side, gameName: seat.gameName, gameId: seat.gameId ?? null } };
    }
    if (action === "close") {
      if (method !== "POST") return { status: 405, body: { error: "Method not allowed." } };
      store.close(id, me);
      return { status: 200, body: { ok: true } };
    }
    // roster / coach: ?role=creator|opponent
    if (method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
    const { lobby } = store.requireMember(id, me);
    const role = query.get("role");
    if (role !== "creator" && role !== "opponent") return { status: 400, body: { error: "role must be creator or opponent." } };
    const seat = role === "creator" ? lobby.creator : lobby.opponent;
    if (action === "coach") {
      return { status: 200, body: { coach: seat.coach, ...deps.coachCard(seat.coach) } };
    }
    if (!seat.team) return { status: 200, body: { shared: false, roster: null } };
    const roster = deps.roster(seat.coach, seat.team.teamId);
    return { status: 200, body: { shared: roster !== undefined, roster: roster ?? null } };
  } catch (e) {
    if (e instanceof LobbyError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}

// ── socket bridge for the Super service (lobby-chat / lobby-presence) ──

export interface LobbySocketBridge {
  /** The authed coach for a WebSocket upgrade (session cookie, or a Bearer header from the client). */
  coachFromRequest(req: unknown): string | undefined;
  isMember(lobbyId: string, coach: string): boolean;
  history(lobbyId: string): LobbyChatMessage[];
  presence(lobbyId: string): LobbyPresenceEntry[] | null;
  appendChat(lobbyId: string, coach: string, text: unknown): LobbyChatMessage | null;
  socketOpened(lobbyId: string, coach: string): void;
  socketClosed(lobbyId: string, coach: string): void;
  subscribe(listener: (lobbyId: string) => void): void;
}

export function lobbySocketBridge(store: LobbyStore, coachFromRequest: (req: unknown) => string | undefined): LobbySocketBridge {
  return {
    coachFromRequest,
    isMember: (id, coach) => store.isMember(id, coach),
    history: (id) => store.history(id),
    presence: (id) => store.presence(id),
    appendChat: (id, coach, text) => store.appendChat(id, coach, text),
    socketOpened: (id, coach) => store.socketOpened(id, coach),
    socketClosed: (id, coach) => store.socketClosed(id, coach),
    subscribe: (l) => store.subscribe(l),
  };
}
