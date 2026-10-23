// Web Lobby (spec start-game-flow Part 1 lane 1 + Part 1b): a waiting room both coaches share until the game
// starts. The Lobby is a VIEW over the matchmaker (owner correction 10-22), never a second pairing store:
//   - create = the creator's challenge, join = the opponent's counter-challenge, renew = the creator's explicit
//     re-entry after their challenge lapsed or was cancelled/superseded. All three go through
//     `Matchmaker.challengeVerified` (the Discord session is the proof; NO digest enters the matchmaker, so no
//     stored credential can ever reach a match delivery).
//   - Consent is the matchmaker's: the lobby keys each side on the matchmaker challenge id. A cancelled,
//     expired or superseded creator challenge is never re-entered by the lobby; the page asks the creator to
//     confirm again ("needs-renewal"). Pairing, both-team revalidation and the in-flight reservation that stops
//     overlapping accepts all live inside the matchmaker.
//   - The lobby holds only view state: the two coaches, last-known teams, challenge ids, presence, launch marks
//     and chat. In memory, swept: 24 h after creation or 1 h after the first launch.
// The seat's JNLP is served only by the session-scoped `GET /api/lobby/:id/jnlp`.

import { randomBytes } from "node:crypto";
import { buildSeatJnlp, type PairingEvent, type PendingChallengeView, type VerifiedChallengeResult } from "@bb/fork-ops";

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
  challengeVerified(opts: { coach: string; teamId: string; opponent: string }): Promise<VerifiedChallengeResult>;
  pendingOf(coach: string): PendingChallengeView | undefined;
  pendingFor(coach: string): PendingChallengeView[];
  cancel(coach: string): void;
  /** An unresolved scheduling operation is open for these two coaches (outcome unknown, retried in background). */
  schedulingPending?(coachA: string, coachB: string): boolean;
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
  /** The matchmaker challenge that IS the creator's current consent. */
  creatorChallengeId: string;
  creatorTeam: LobbyTeam;
  /** The opponent's counter-challenge id, once they accepted. */
  opponentChallengeId?: string;
  opponentTeam?: LobbyTeam;
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

  goneReason(id: string): "expired" | "closed" | undefined {
    this.sweep();
    return this.lobbies.has(id) ? undefined : this.tombstones.get(id);
  }

  get(id: string): LobbyRecord | undefined {
    this.sweep();
    return this.lobbies.get(id);
  }

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

  requireMember(id: string, coach: string): { lobby: LobbyRecord; role: LobbyRole } {
    const lobby = this.require(id);
    const role = this.roleOf(lobby, coach);
    if (!role) throw new LobbyError(403, "You are not in this lobby.");
    return { lobby, role };
  }

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
    if (!teamId.trim()) throw new LobbyError(400, "Pick a team.");
    const resolved = this.opts.resolveTeam(coach, teamId.trim());
    if ("error" in resolved) throw new LobbyError(resolved.status ?? 400, resolved.error);
    return resolved;
  }

  private banGate(coach: string, other: string): void {
    if (this.opts.isBanned(coach)) throw new LobbyError(403, "This account is banned.");
    if (this.opts.isBanned(other)) throw new LobbyError(403, `${other} can't play right now.`);
  }

  private async enter(coach: string, teamId: string, opponent: string): Promise<VerifiedChallengeResult> {
    try {
      return await this.opts.matchmaker.challengeVerified({ coach, teamId, opponent });
    } catch (e) {
      throw new LobbyError(409, (e as Error).message);
    }
  }

  // ── create = challenge ──

  async create(coach: string, teamId: string, opponent: string): Promise<LobbyRecord> {
    const me = coach.trim();
    const them = opponent.trim();
    if (!me) throw new LobbyError(401, "Sign in first.");
    if (!them) throw new LobbyError(400, "Enter the coach you want to play.");
    if (them.length > 40) throw new LobbyError(400, "Coach names are at most 40 characters.");
    if (same(me, them)) throw new LobbyError(400, "You can't challenge yourself.");
    this.banGate(me, them);

    const existing = this.openBetween(me, them);
    if (existing && same(existing.opponent.coach, me)) return this.join(existing.id, me, teamId);
    if (existing) return this.renew(existing.id, me, teamId);

    const team = this.team(me, teamId);
    const openMine = [...this.lobbies.values()].filter((l) => !l.pairing && same(l.creator.coach, me)).length;
    if (openMine >= this.maxOpenPerCoach) throw new LobbyError(429, "You have too many open lobbies. Close one first.");
    if (this.lobbies.size >= this.maxLobbies) throw new LobbyError(503, "Too many lobbies are open. Try again later.");

    const res = await this.enter(me, team.teamId, them); // nothing is stored unless the challenge went in
    const now = this.now();
    const lobby: LobbyRecord = {
      id: randomBytes(9).toString("base64url"),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      creator: { coach: me, sockets: 0, lastSeen: now },
      opponent: { coach: them, sockets: 0 },
      creatorChallengeId: res.challengeId,
      creatorTeam: team,
      chat: [],
      nextChatId: 1,
    };
    this.lobbies.set(lobby.id, lobby);
    if (res.pairing) this.attach(lobby, res.pairing);
    this.emit(lobby.id);
    return lobby;
  }

  // ── join = counter-challenge ──

  async join(id: string, coach: string, teamId: string): Promise<LobbyRecord> {
    const { lobby, role } = this.requireMember(id, coach);
    if (role !== "opponent") throw new LobbyError(409, "You opened this lobby. Wait for your opponent to accept.");
    this.banGate(coach, lobby.creator.coach);
    if (lobby.pairing) return lobby;
    const team = this.team(coach, teamId);
    const res = await this.enter(coach.trim(), team.teamId, lobby.creator.coach);
    // Success only from here on: the seat reflects an accepted counter-challenge.
    lobby.opponent.coach = coach.trim();
    lobby.opponent.lastSeen = this.now();
    lobby.opponentChallengeId = res.challengeId;
    lobby.opponentTeam = team;
    if (res.pairing) this.attach(lobby, res.pairing);
    this.emit(lobby.id);
    return lobby;
  }

  // ── renew = the creator confirms again (their challenge lapsed, was cancelled or superseded) ──

  async renew(id: string, coach: string, teamId?: string): Promise<LobbyRecord> {
    const { lobby, role } = this.requireMember(id, coach);
    if (role !== "creator") throw new LobbyError(403, "Only the coach who opened the lobby can confirm it.");
    if (lobby.pairing) return lobby; // renewal already paired: stop
    this.banGate(coach, lobby.opponent.coach);
    const team = this.team(coach, teamId?.trim() || lobby.creatorTeam.teamId);
    const res = await this.enter(lobby.creator.coach, team.teamId, lobby.opponent.coach);
    lobby.creatorChallengeId = res.challengeId;
    lobby.creatorTeam = team;
    if (res.pairing) this.attach(lobby, res.pairing);
    this.emit(lobby.id);
    return lobby;
  }

  /** Matchmaker `onDelivered` hook: a seat's JNLP went to its owner through the client's match poll, so that
   *  coach is "in the client" (mixed pairing: the browser seat can then start). */
  noteDelivered(delivery: { coach: string; gameName: string }): void {
    this.sweep();
    for (const lobby of this.lobbies.values()) {
      if (lobby.pairing?.gameName !== delivery.gameName) continue;
      const role = this.roleOf(lobby, delivery.coach);
      if (!role) continue;
      const now = this.now();
      (role === "creator" ? lobby.creator : lobby.opponent).launchedAt = now;
      if (lobby.startedAt === undefined) {
        lobby.startedAt = now;
        lobby.expiresAt = Math.min(lobby.expiresAt, now + this.postStartTtlMs);
      }
      this.emit(lobby.id);
      return;
    }
  }

  /** Matchmaker `onPaired` hook: attach a pairing to the live lobby whose challenge ids it consumed. */
  notePairing(pairing: PairingEvent): void {
    this.sweep();
    const ids = new Set([pairing.home.challengeId, pairing.away.challengeId]);
    for (const lobby of this.lobbies.values()) {
      if (lobby.pairing) continue;
      if (ids.has(lobby.creatorChallengeId) || (lobby.opponentChallengeId !== undefined && ids.has(lobby.opponentChallengeId))) {
        this.attach(lobby, pairing);
        this.emit(lobby.id);
        return;
      }
    }
  }

  private attach(lobby: LobbyRecord, pairing: PairingEvent): void {
    if (lobby.pairing) return;
    lobby.pairing = pairing;
    const sideOf = (coach: string) => (same(pairing.home.coach, coach) ? pairing.home : pairing.away);
    const c = sideOf(lobby.creator.coach);
    const o = sideOf(lobby.opponent.coach);
    lobby.creator.coach = c.coach;
    lobby.opponent.coach = o.coach;
    lobby.creatorChallengeId = c.challengeId;
    lobby.opponentChallengeId = o.challengeId;
    const teamFor = (coach: string, teamId: string, known?: LobbyTeam): LobbyTeam => {
      if (known && known.teamId === teamId) return known;
      const resolved = this.opts.resolveTeam(coach, teamId);
      return "error" in resolved ? { teamId, teamName: "", race: "" } : resolved;
    };
    lobby.creatorTeam = teamFor(c.coach, c.teamId, lobby.creatorTeam);
    lobby.opponentTeam = teamFor(o.coach, o.teamId, lobby.opponentTeam);
  }

  /** Close an unpaired lobby (creator only): withdraws the creator's challenge if it is still this lobby's. */
  close(id: string, coach: string): void {
    const { lobby, role } = this.requireMember(id, coach);
    if (role !== "creator") throw new LobbyError(403, "Only the coach who opened the lobby can close it.");
    if (lobby.pairing) throw new LobbyError(409, "The game is already set up.");
    if (this.opts.matchmaker.pendingOf(lobby.creator.coach)?.id === lobby.creatorChallengeId) {
      this.opts.matchmaker.cancel(lobby.creator.coach);
    }
    this.lobbies.delete(id);
    this.tombstone(id, "closed");
    this.emit(id);
  }

  // ── launch ──

  /** My seat in the paired game (bans re-checked every time). */
  seatOf(id: string, coach: string): { coach: string; teamId: string; gameName: string; gameId?: string; side: "home" | "away"; role: LobbyRole; lobby: LobbyRecord } {
    const { lobby, role } = this.requireMember(id, coach);
    if (this.opts.isBanned(coach)) throw new LobbyError(403, "This account is banned.");
    const pairing = lobby.pairing;
    if (!pairing) throw new LobbyError(409, "The game is not set up yet.");
    const side = same(pairing.home.coach, coach) ? "home" : "away";
    const p = side === "home" ? pairing.home : pairing.away;
    return { coach: p.coach, teamId: p.teamId, gameName: pairing.gameName, gameId: pairing.gameId, side, role, lobby };
  }

  /** Marks me "in the client" and starts the 1 h clock. */
  launch(id: string, coach: string): { coach: string; teamId: string; gameName: string; gameId?: string; side: "home" | "away" } {
    const seat = this.seatOf(id, coach);
    const now = this.now();
    (seat.role === "creator" ? seat.lobby.creator : seat.lobby.opponent).launchedAt = now;
    if (seat.lobby.startedAt === undefined) {
      seat.lobby.startedAt = now;
      seat.lobby.expiresAt = Math.min(seat.lobby.expiresAt, now + this.postStartTtlMs);
    }
    this.emit(id);
    return { coach: seat.coach, teamId: seat.teamId, gameName: seat.gameName, gameId: seat.gameId, side: seat.side };
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
    if (seat.sockets === 0) seat.lastSeen = this.now() - this.presenceWindowMs; // "left" at once
    this.emit(id);
  }

  // ── chat ──

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

  /** Pending challenges naming this coach (the Start page inbox), with the lobby that owns each one. */
  inbox(coach: string): Array<PendingChallengeView & { lobbyId?: string }> {
    this.sweep();
    return this.opts.matchmaker.pendingFor(coach).map((c) => {
      const lobby = [...this.lobbies.values()].find((l) => !l.pairing && l.creatorChallengeId === c.id);
      return lobby ? { ...c, lobbyId: lobby.id } : { ...c };
    });
  }

  view(lobby: LobbyRecord, coach: string): LobbyView {
    const role = this.roleOf(lobby, coach) ?? "opponent";
    const paired = lobby.pairing !== undefined;
    const mm = this.opts.matchmaker;
    const creatorLive = !paired && mm.pendingOf(lobby.creator.coach)?.id === lobby.creatorChallengeId;
    const opponentAccepted = !paired && lobby.opponentChallengeId !== undefined
      && mm.pendingOf(lobby.opponent.coach)?.id === lobby.opponentChallengeId;
    const seatView = (seat: Seat, r: LobbyRole, team: LobbyTeam | null): LobbySeatView => ({
      coach: seat.coach,
      role: r,
      team,
      state: this.stateOf(seat),
      side: lobby.pairing ? (same(lobby.pairing.home.coach, seat.coach) ? "home" : "away") : null,
    });
    const creator = seatView(lobby.creator, "creator", lobby.creatorTeam);
    const opponent = seatView(lobby.opponent, "opponent", paired || opponentAccepted ? lobby.opponentTeam ?? null : null);
    const bothPresent = [creator, opponent].every((s) => s.state === "here" || s.state === "client");
    const status: LobbyView["status"] = paired ? "ready" : creatorLive ? "waiting" : "needs-renewal";
    const settingUp = !paired && (mm.schedulingPending?.(lobby.creator.coach, lobby.opponent.coach) ?? false);
    return {
      id: lobby.id,
      me: role,
      createdAt: lobby.createdAt,
      expiresAt: lobby.expiresAt,
      startedAt: lobby.startedAt ?? null,
      status,
      opponentAccepted,
      settingUp,
      canAccept: role === "opponent" && !paired && !opponentAccepted,
      canRenew: role === "creator" && status === "needs-renewal",
      creator,
      opponent,
      game: lobby.pairing ? { gameName: lobby.pairing.gameName, gameId: lobby.pairing.gameId ?? null } : null,
      bothPresent,
      canLaunch: bothPresent && paired,
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
  /** waiting = the creator's challenge is live; needs-renewal = it lapsed / was cancelled or superseded and
   *  the creator must confirm again; ready = paired (the game is set up on the fork). */
  status: "waiting" | "ready" | "needs-renewal";
  opponentAccepted: boolean;
  /** Both accepted, but the game server's answer was lost: the server is reconciling and retrying. */
  settingUp: boolean;
  canAccept: boolean;
  canRenew: boolean;
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

export interface LobbyAuth {
  coach: string;
  /** Session provenance; the lobby accepts "discord" only. */
  method: string;
}

export interface LobbyApiDeps {
  store: LobbyStore;
  roster: (coach: string, teamId: string) => LobbyRoster | undefined;
  coachCard: (coach: string) => LobbyCoachCard;
  /** Rating for a FUMBBL name, charged to `requester`; may throw an error carrying `status` (429). */
  rating: (name: string, requester: string) => Promise<unknown>;
  /** The seat coach's stored credential digest (bounded; throws an error with `status` when unavailable). Fetched
   *  BEFORE the game-start lock; the JNLP is then built under the lock after the seat is re-checked. */
  credential: (coach: string) => Promise<string>;
  /** Is the request's session still valid (re-checked under the lock, after the credential fetch)? */
  authStillValid?: () => boolean;
  chatLive: () => boolean;
  /** Runs a game-start operation (writes and the JNLP download) under the host's cache gate + game-start lock,
   *  after auth and body parsing. */
  withGameStartLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface LobbyApiResult {
  status: number;
  body: unknown;
  /** Set for a non-JSON body (the JNLP). */
  contentType?: string;
  headers?: Record<string, string>;
}

const LOBBY_ID = /^[A-Za-z0-9_-]{6,32}$/;

export function isLobbyApiPath(path: string): boolean {
  return path === "/api/lobby" || path.startsWith("/api/lobby/") || path === "/api/coach-rating";
}

/** Is a lobby request a game-start operation (cache gate + game-start lock)? The writes, and the JNLP download. */
export function isLobbyGameStartOperation(method: string, path: string): boolean {
  if (method === "GET") return /^\/api\/lobby\/[^/]+\/jnlp$/.test(path);
  return method === "POST" && /^\/api\/lobby(?:\/[^/]+\/(?:join|renew|launch))?$/.test(path);
}

function field(body: unknown, name: string): string {
  const v = body && typeof body === "object" ? (body as Record<string, unknown>)[name] : undefined;
  return typeof v === "string" ? v.trim() : "";
}

const safeFile = (s: string): string => s.replace(/[^\w.-]+/g, "_").slice(0, 60) || "game";

export async function lobbyApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: LobbyAuth | undefined,
  body: unknown,
  deps: LobbyApiDeps,
): Promise<LobbyApiResult | undefined> {
  if (!isLobbyApiPath(path)) return undefined;
  if (!auth?.coach) return { status: 401, body: { error: "Sign in with Discord first." } };
  if (auth.method !== "discord") return { status: 403, body: { error: "The lobby needs a Discord sign-in." } };
  const me = auth.coach;
  const { store } = deps;
  const locked = <T>(fn: () => Promise<T>): Promise<T> => (deps.withGameStartLock ? deps.withGameStartLock(fn) : fn());
  try {
    if (path === "/api/coach-rating") {
      if (method !== "GET") return { status: 405, body: { error: "Method not allowed." } };
      const name = query.get("name")?.trim() ?? "";
      if (!name || name.length > 60) return { status: 400, body: { error: "name is required." } };
      return { status: 200, body: { rating: await deps.rating(name, me) } };
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
        const lobby = await locked(() => store.create(me, field(body, "teamId"), field(body, "opponent")));
        return { status: 201, body: { lobby: store.view(lobby, me) } };
      }
      return { status: 405, body: { error: "Method not allowed." } };
    }

    const m = path.match(/^\/api\/lobby\/([^/]+)(?:\/(join|renew|launch|jnlp|roster|close|coach))?$/);
    if (!m) return { status: 404, body: { error: "Not found." } };
    const id = m[1]!;
    const action = m[2];
    if (!LOBBY_ID.test(id)) return { status: 404, body: { error: "Lobby not found." } };
    const want = (verb: string): LobbyApiResult | undefined => (method === verb ? undefined : { status: 405, body: { error: "Method not allowed." } });

    if (!action) {
      const bad = want("GET"); if (bad) return bad;
      const { lobby } = store.requireMember(id, me);
      store.touch(id, me);
      return { status: 200, body: { lobby: store.view(lobby, me), chatLive: deps.chatLive() } };
    }
    if (action === "join" || action === "renew") {
      const bad = want("POST"); if (bad) return bad;
      const lobby = await locked(() => action === "join"
        ? store.join(id, me, field(body, "teamId"))
        : store.renew(id, me, field(body, "teamId") || undefined));
      return { status: 200, body: { lobby: store.view(lobby, me) } };
    }
    if (action === "launch") {
      const bad = want("POST"); if (bad) return bad;
      const seat = await locked(async () => store.launch(id, me));
      // superfumbbl:// needs a launch-token mint (spec Part 1 §4), which does not exist yet.
      return { status: 200, body: { jnlpUrl: `/api/lobby/${id}/jnlp`, scheme: null, side: seat.side, gameName: seat.gameName, gameId: seat.gameId ?? null } };
    }
    if (action === "jnlp") {
      const bad = want("GET"); if (bad) return bad;
      // Membership + seat first (cheap, no global state), then the credential OUTSIDE the lock (bounded DB call),
      // then under the lock: session, seat and cache state re-checked and the artifact built synchronously.
      const first = store.seatOf(id, me);
      const passwordMd5 = await deps.credential(first.coach);
      const { seat, jnlp } = await locked(async () => {
        if (deps.authStillValid && !deps.authStillValid()) throw new LobbyError(401, "Sign in with Discord first.");
        const s = store.seatOf(id, me);
        if (s.coach !== first.coach || s.teamId !== first.teamId || s.gameName !== first.gameName || s.gameId !== first.gameId) {
          throw new LobbyError(409, "Your seat changed. Try again.");
        }
        return { seat: s, jnlp: buildSeatJnlp({ coach: s.coach, teamId: s.teamId, gameName: s.gameName, gameId: s.gameId, passwordMd5 }) };
      });
      return {
        status: 200,
        body: jnlp,
        contentType: "application/x-java-jnlp-file; charset=utf-8",
        headers: {
          "content-disposition": `attachment; filename="lobby_${safeFile(seat.gameName)}_${safeFile(seat.coach)}.jnlp"`,
          "cache-control": "no-store",
        },
      };
    }
    if (action === "close") {
      const bad = want("POST"); if (bad) return bad;
      store.close(id, me);
      return { status: 200, body: { ok: true } };
    }
    // roster / coach: ?role=creator|opponent
    const bad = want("GET"); if (bad) return bad;
    const { lobby } = store.requireMember(id, me);
    const role = query.get("role");
    if (role !== "creator" && role !== "opponent") return { status: 400, body: { error: "role must be creator or opponent." } };
    const seat = role === "creator" ? lobby.creator : lobby.opponent;
    if (action === "coach") return { status: 200, body: { coach: seat.coach, ...deps.coachCard(seat.coach) } };
    const team = store.view(lobby, me)[role].team;
    if (!team) return { status: 200, body: { shared: false, roster: null } };
    const roster = deps.roster(seat.coach, team.teamId);
    return { status: 200, body: { shared: roster !== undefined, roster: roster ?? null } };
  } catch (e) {
    if (e instanceof LobbyError) return { status: e.status, body: { error: e.message } };
    const status = (e as { status?: unknown }).status;
    if (typeof status === "number" && status >= 400 && status < 600) return { status, body: { error: (e as Error).message } };
    throw e;
  }
}

// ── socket bridge for the Super service (lobby-chat / lobby-presence) ──

export interface LobbySocketSession {
  coach: string;
  token: string;
}

export interface LobbySocketBridge {
  /** The Discord session on a WebSocket upgrade request (cookie or Bearer), or undefined. */
  sessionFromRequest(req: unknown): LobbySocketSession | undefined;
  /** The coach of a still-valid Discord session token (undefined once logged out / expired). */
  sessionCoach(token: string): string | undefined;
  /** Browser Origin check for the upgrade (absent Origin = not a browser = allowed). */
  originAllowed(origin: string | undefined, host: string | undefined): boolean;
  /** Called with a session token the moment that session is deleted (logout) or found expired. */
  onSessionEnded?(listener: (token: string) => void): void;
  isMember(lobbyId: string, coach: string): boolean;
  history(lobbyId: string): LobbyChatMessage[];
  presence(lobbyId: string): LobbyPresenceEntry[] | null;
  appendChat(lobbyId: string, coach: string, text: unknown): LobbyChatMessage | null;
  socketOpened(lobbyId: string, coach: string): void;
  socketClosed(lobbyId: string, coach: string): void;
  subscribe(listener: (lobbyId: string) => void): void;
}

export function lobbySocketBridge(
  store: LobbyStore,
  auth: Pick<LobbySocketBridge, "sessionFromRequest" | "sessionCoach" | "originAllowed" | "onSessionEnded">,
): LobbySocketBridge {
  return {
    ...auth,
    isMember: (id, coach) => store.isMember(id, coach),
    history: (id) => store.history(id),
    presence: (id) => store.presence(id),
    appendChat: (id, coach, text) => store.appendChat(id, coach, text),
    socketOpened: (id, coach) => store.socketOpened(id, coach),
    socketClosed: (id, coach) => store.socketClosed(id, coach),
    subscribe: (l) => store.subscribe(l),
  };
}

/** Trusted browser origins for lobby sockets: `SUPER_WS_ALLOWED_ORIGINS` (comma list) plus the Discord redirect
 *  URI's origin. Empty => same-host only. */
export function lobbyAllowedOriginsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw?.trim()) return;
    try { out.add(new URL(raw.trim()).origin.toLowerCase()); } catch { /* ignore a malformed entry */ }
  };
  for (const part of (env.SUPER_WS_ALLOWED_ORIGINS ?? "").split(",")) add(part);
  add(env.DISCORD_OAUTH_REDIRECT_URI);
  return [...out];
}

export function lobbyOriginAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin === "") return true; // non-browser client: no ambient-cookie CSRF
  let parsed: URL;
  try { parsed = new URL(origin); } catch { return false; }
  if (allowed.length > 0) return allowed.includes(parsed.origin.toLowerCase());
  return !!host && parsed.host.toLowerCase() === host.trim().toLowerCase();
}

/** Bounded, time-limited JSON body for lobby writes (read only after the session check, before any lock). */
export async function readLobbyBody(
  req: AsyncIterable<unknown> & { destroy?: () => void },
  read: (source: AsyncIterable<unknown>, maxBytes: number) => Promise<unknown>,
  maxBytes = 16 * 1024,
  deadlineMs = 10_000,
): Promise<{ body: unknown } | { status: number; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("Request body took too long."), { status: 408 })), deadlineMs);
  });
  try {
    return { body: await Promise.race([read(req, maxBytes), deadline]) };
  } catch (e) {
    const status = (e as { status?: unknown }).status;
    if (status === 408) { try { req.destroy?.(); } catch { /* ignore */ } }
    return { status: typeof status === "number" ? status : 400, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
