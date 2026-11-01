// Coach notifications (landing/nav spec §4.1, lane 2): one capped file per coach under <FORK_STATE_DIR>/notifications,
// the /api/me/notifications routes, the organiser "Message coach" route, and the notifier the tournament and tabletop
// mutation paths call. Every emitter is fire-and-forget: a notification fault never changes the response of the
// mutation that raised it.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { assertNotFenced } from "./privacy/fence.js";
import { isTournamentManager, tournamentOwner } from "./tournaments/store.js";
import type { TournamentEntrantRecord, TournamentRecord } from "./tournaments/types.js";

export const NOTIFICATION_TYPES = [
  "organiser-message",
  "entrant-flag",
  "roster-problems",
  "withdrawal",
  "award",
  "fixture-created",
  "fixture-rescheduled",
  "proposal-received",
  "proposal-accepted",
  "proposal-countered",
  "result-confirmed",
  "result-edited",
  "tournament-news",
  "league-broadcast",
  "registration",
  "share-request",
  "naf-request",
  "private-message",
  "friend-request",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface NotificationRecord {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  /** The SPA path the row opens (/app/...). */
  link: string;
  at: string;
  readAt?: string;
  /** Who raised it: a coach name, or "" for the system. */
  from: string;
}

export interface NotificationInput {
  type: NotificationType;
  title: string;
  body: string;
  link: string;
  from?: string;
  /** Short name of the thing the row is about (a fixture label), for the Discord DM text
   *  (src/mail/actionMessages.ts). Not stored. */
  subject?: string;
}

export const NOTIFICATION_CAP = 500;
export const MESSAGE_MAX_CHARS = 2000;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const LINK_MAX = 300;

/** The identity key the tournaments store matches coaches by (entrant.coach.ffbCoachId, case-insensitive). */
export const notificationCoachKey = (coach: string): string => coach.trim().toLowerCase();

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/** File name for a coach key: [a-z0-9-] kept, every other character as _xx (UTF-8 hex), so two keys never share a file. */
export function notificationFileName(key: string): string {
  let out = "";
  for (const byte of Buffer.from(key, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[a-z0-9-]/.test(ch) ? ch : `_${byte.toString(16).padStart(2, "0")}`;
  }
  if (WINDOWS_RESERVED.test(out)) out = `_${out.charCodeAt(0).toString(16)}${out.slice(1)}`;
  return `${out || "_"}.json`;
}

interface NotificationFile {
  version: 1;
  /** Last id number issued for this coach (ids stay unique after the cap drops old rows). */
  seq: number;
  /** Oldest first. */
  notifications: NotificationRecord[];
}

const isType = (v: unknown): v is NotificationType => typeof v === "string" && (NOTIFICATION_TYPES as readonly string[]).includes(v);
const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** A stored row, or undefined when it is not the right shape (dropped on read). */
function validRecord(raw: unknown): NotificationRecord | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || !/^n\d+$/.test(r.id)) return undefined;
  if (!isType(r.type) || typeof r.title !== "string" || typeof r.body !== "string" || typeof r.link !== "string") return undefined;
  if (!isIso(r.at) || typeof r.from !== "string") return undefined;
  if (r.readAt !== undefined && !isIso(r.readAt)) return undefined;
  return {
    id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, at: r.at, from: r.from,
    ...(r.readAt !== undefined ? { readAt: r.readAt as string } : {}),
  };
}

const idNumber = (id: string): number => Number(id.slice(1));

export interface NotificationListOptions {
  /** Only rows newer than this id (incremental poll). An unknown id returns everything. */
  after?: string;
  /** Only rows older than this id (paging back). */
  before?: string;
  limit?: number;
}

export interface NotificationList {
  notifications: NotificationRecord[];
  unread: number;
  total: number;
}

export interface NotificationStoreOptions {
  now?: () => Date;
  /** Called after a row is stored (the Super socket push). Errors are swallowed. */
  onAdded?: (coachKey: string, record: NotificationRecord, unread: number, input: NotificationInput) => void;
  /** Called after rows were marked read (the Super socket push, so the coach's other tabs follow). Errors are swallowed. */
  onRead?: (coachKey: string, change: { unread: number; readIds: string[]; all?: true }) => void;
}

export class NotificationStore {
  readonly dir: string;
  constructor(stateDir: string, private readonly opts: NotificationStoreOptions = {}) {
    this.dir = join(stateDir, "notifications");
  }

  private file(key: string): string {
    return join(this.dir, notificationFileName(key));
  }

  /** The coach's file, shape-validated; a missing or corrupt file reads as empty. */
  private read(key: string): NotificationFile {
    const path = this.file(key);
    const empty: NotificationFile = { version: 1, seq: 0, notifications: [] };
    if (!existsSync(path)) return empty;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<NotificationFile> | null;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.notifications)) return empty;
      const rows = raw.notifications.map(validRecord).filter((r): r is NotificationRecord => r !== undefined);
      const maxId = rows.reduce((m, r) => Math.max(m, idNumber(r.id)), 0);
      const seq = Number.isSafeInteger(raw.seq) && (raw.seq as number) >= maxId ? (raw.seq as number) : maxId;
      return { version: 1, seq, notifications: rows.slice(-NOTIFICATION_CAP) };
    } catch {
      return empty;
    }
  }

  private write(key: string, data: NotificationFile): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(this.file(key), `${JSON.stringify(data, null, 2)}\n`);
  }

  list(coach: string, options: NotificationListOptions = {}): NotificationList {
    const data = this.read(notificationCoachKey(coach));
    let rows = data.notifications;
    if (options.after && rows.some((r) => r.id === options.after)) rows = rows.filter((r) => idNumber(r.id) > idNumber(options.after!));
    if (options.before && /^n\d+$/.test(options.before)) rows = rows.filter((r) => idNumber(r.id) < idNumber(options.before!));
    const limit = Math.min(NOTIFICATION_CAP, Math.max(1, options.limit ?? 50));
    return {
      notifications: rows.slice(-limit).reverse(),
      unread: data.notifications.filter((r) => !r.readAt).length,
      total: data.notifications.length,
    };
  }

  unread(coach: string): number {
    return this.read(notificationCoachKey(coach)).notifications.filter((r) => !r.readAt).length;
  }

  /** Store one row (capped at NOTIFICATION_CAP, oldest dropped). Returns the stored row. */
  add(coach: string, input: NotificationInput): NotificationRecord {
    const key = notificationCoachKey(coach);
    if (!key) throw new Error("A coach is required.");
    assertNotFenced(coach);
    if (!isType(input.type)) throw new Error("Unknown notification type.");
    const data = this.read(key);
    const seq = data.seq + 1;
    const record: NotificationRecord = {
      id: `n${seq}`,
      type: input.type,
      title: input.title.slice(0, TITLE_MAX),
      body: input.body.slice(0, BODY_MAX),
      link: input.link.startsWith("/") ? input.link.slice(0, LINK_MAX) : "/app/",
      at: (this.opts.now?.() ?? new Date()).toISOString(),
      from: input.from ?? "",
    };
    const notifications = [...data.notifications, record].slice(-NOTIFICATION_CAP);
    this.write(key, { version: 1, seq, notifications });
    const unread = notifications.filter((r) => !r.readAt).length;
    try { this.opts.onAdded?.(key, record, unread, input); } catch { /* the push is best effort */ }
    return record;
  }

  /** Mark rows read; returns how many changed and the new unread count. */
  markRead(coach: string, which: { ids: string[] } | { all: true }): { marked: number; unread: number } {
    const key = notificationCoachKey(coach);
    const data = this.read(key);
    const at = (this.opts.now?.() ?? new Date()).toISOString();
    const wanted = "ids" in which ? new Set(which.ids) : undefined;
    const readIds: string[] = [];
    const notifications = data.notifications.map((r) => {
      if (r.readAt || (wanted && !wanted.has(r.id))) return r;
      readIds.push(r.id);
      return { ...r, readAt: at };
    });
    const unread = notifications.filter((r) => !r.readAt).length;
    if (readIds.length > 0) {
      this.write(key, { ...data, notifications });
      try { this.opts.onRead?.(key, { unread, readIds, ...(wanted ? {} : { all: true as const }) }); } catch { /* the push is best effort */ }
    }
    return { marked: readIds.length, unread };
  }
}

// ---- tournament notifier: who gets what, and the SPA link ----------------------------------------------------------

/** The SPA path of a tournament page, with ?tab= where the tab exists. */
export function tournamentLink(tournamentId: string, tab?: "overview" | "entrants" | "rounds" | "standings" | "statistics" | "honours" | "awards" | "manage"): string {
  return `/app/tournaments/${encodeURIComponent(tournamentId)}${tab ? `?tab=${tab}` : ""}`;
}

/** What the notifier reads from the tournaments store. */
export interface NotifierTournamentSource {
  tournament(id: string): TournamentRecord | undefined;
  entrants(tournamentId: string): TournamentEntrantRecord[];
}

/** The emitters the tournament and tabletop paths call (all fire-and-forget). */
export interface TournamentNotify {
  /** One coach (key = the tournaments identity key, ffbCoachId). */
  coach(coach: string, input: NotificationInput): void;
  /** The tournament's owner and listed organisers, minus `except` (usually the actor). */
  managers(tournamentId: string, input: NotificationInput, except?: string): void;
  /** Every undropped entrant of the tournament, minus `except`. */
  entrants(tournamentId: string, type: NotificationType, title: string, body: string, link: string, from?: string, except?: string): void;
}

export function tournamentManagers(tournament: TournamentRecord): string[] {
  const out = new Map<string, string>();
  const owner = tournamentOwner(tournament);
  if (owner) out.set(notificationCoachKey(owner), owner);
  for (const id of tournament.organizerCoachIds ?? []) out.set(notificationCoachKey(id), id);
  return [...out.values()];
}

export function createTournamentNotifier(
  store: Pick<NotificationStore, "add">,
  tournaments: NotifierTournamentSource,
  log: (line: string) => void = (l) => console.error(`[notify] ${l}`),
): TournamentNotify {
  const send = (coach: string, input: NotificationInput) => {
    try { if (coach.trim()) store.add(coach, input); } catch (e) { log(`add failed for ${coach}: ${(e as Error).message}`); }
  };
  const skip = (coach: string, except?: string) => except !== undefined && notificationCoachKey(coach) === notificationCoachKey(except);
  return {
    coach: send,
    managers(tournamentId, input, except) {
      try {
        const t = tournaments.tournament(tournamentId);
        if (!t) return;
        for (const m of tournamentManagers(t)) if (!skip(m, except)) send(m, input);
      } catch (e) { log(`managers failed: ${(e as Error).message}`); }
    },
    entrants(tournamentId, type, title, body, link, from = "", except) {
      try {
        const seen = new Set<string>();
        for (const e of tournaments.entrants(tournamentId)) {
          if (e.droppedAt !== undefined) continue;
          const coach = e.coach.ffbCoachId;
          const key = notificationCoachKey(coach);
          if (seen.has(key) || skip(coach, except)) continue;
          seen.add(key);
          send(coach, { type, title, body, link, from });
        }
      } catch (e) { log(`entrants failed: ${(e as Error).message}`); }
    },
  };
}

// The process-wide notifier (server.ts registers it at startup). Other modules (the tournament news route) call
// notifyEntrants without threading a dependency through.
let activeNotifier: TournamentNotify | undefined;
export function setActiveNotifier(notifier: TournamentNotify | undefined): void {
  activeNotifier = notifier;
}

/** Notify every undropped entrant of a tournament (e.g. a news post). No-op until server.ts registers the notifier. */
export function notifyEntrants(tournamentId: string, type: NotificationType, title: string, body: string, link: string, from = ""): void {
  activeNotifier?.entrants(tournamentId, type, title, body, link, from);
}

// The organiser <-> coach thread writer (src/social; server.ts registers it). Unset = no Messages store on this host.
export type OrganiserThreadSink = (organiser: string, coach: string, text: string, context: { kind: "tournament"; id: string; name: string }) => void;
let organiserThreadSink: OrganiserThreadSink | undefined;
export function setOrganiserThreadSink(sink: OrganiserThreadSink | undefined): void {
  organiserThreadSink = sink;
}

// ---- HTTP routes ---------------------------------------------------------------------------------------------------

export interface NotificationAuth {
  coach: string;
  organizer: boolean;
  admin: boolean;
  /** A test sign-in session: reads only. */
  test?: boolean;
}

export interface NotificationApiDeps {
  store: NotificationStore;
  tournaments: NotifierTournamentSource;
  limiter?: SenderRateLimiter;
  now?: () => number;
}

export interface NotificationApiResult { status: number; body: unknown }

export const isNotificationApiPath = (path: string): boolean =>
  path === "/api/me/notifications" || path === "/api/me/notifications/read" || /^\/api\/tournaments\/[^/]+\/message$/.test(path);

/** Sliding one-minute window per sender (in memory; a restart forgets it). */
export class SenderRateLimiter {
  private readonly hits = new Map<string, number[]>();
  constructor(private readonly max = 30, private readonly windowMs = 60_000, private readonly maxKeys = 5_000) {}
  take(sender: string, now = Date.now()): boolean {
    const key = notificationCoachKey(sender);
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.delete(key);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

const err = (status: number, error: string): NotificationApiResult => ({ status, body: { error } });

function decoded(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

export function notificationsApi(
  method: string,
  path: string,
  query: URLSearchParams,
  auth: NotificationAuth | undefined,
  body: unknown,
  deps: NotificationApiDeps,
): NotificationApiResult | undefined {
  if (path === "/api/me/notifications" && method === "GET") {
    if (!auth) return err(401, "Authentication required.");
    const limitRaw = Number(query.get("limit") ?? "");
    const after = query.get("after")?.trim() || undefined;
    const before = query.get("before")?.trim() || undefined;
    return {
      status: 200,
      body: deps.store.list(auth.coach, {
        ...(after ? { after } : {}),
        ...(before ? { before } : {}),
        ...(Number.isSafeInteger(limitRaw) && limitRaw > 0 ? { limit: limitRaw } : {}),
      }),
    };
  }

  if (path === "/api/me/notifications/read" && method === "POST") {
    if (!auth) return err(401, "Authentication required.");
    if (auth.test) return err(403, "Test sign-in sessions cannot change notifications.");
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (!input) return err(400, "A JSON object is required.");
    if (input.all === true) return { status: 200, body: deps.store.markRead(auth.coach, { all: true }) };
    if (!Array.isArray(input.ids) || input.ids.length > NOTIFICATION_CAP || input.ids.some((id) => typeof id !== "string"))
      return err(400, "Send ids (a list of notification ids) or all: true.");
    return { status: 200, body: deps.store.markRead(auth.coach, { ids: input.ids as string[] }) };
  }

  const messageMatch = path.match(/^\/api\/tournaments\/([^/]+)\/message$/);
  if (messageMatch && method === "POST") {
    if (!auth) return err(401, "Authentication required.");
    if (auth.test) return err(403, "Test sign-in sessions cannot write tournament or scheduled-match data.");
    const tournamentId = decoded(messageMatch[1]!);
    const tournament = tournamentId ? deps.tournaments.tournament(tournamentId) : undefined;
    if (!tournament) return err(404, "Tournament not found.");
    if (!auth.admin && !isTournamentManager(tournament, auth.coach)) return err(403, "You are not this tournament's organizer.");
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
    if (!input) return err(400, "A JSON object is required.");
    const target = typeof input.coachKey === "string" ? input.coachKey.trim() : "";
    const text = typeof input.body === "string" ? input.body.trim() : "";
    if (!target) return err(400, "coachKey is required.");
    if (!text) return err(400, "Write a message first.");
    if ([...text].length > MESSAGE_MAX_CHARS) return err(400, `A message is at most ${MESSAGE_MAX_CHARS} characters.`);
    const entrant = deps.tournaments.entrants(tournament.id)
      .find((e) => e.droppedAt === undefined && notificationCoachKey(e.coach.ffbCoachId) === notificationCoachKey(target));
    if (!entrant) return err(404, "That coach is not entered in this tournament.");
    if (deps.limiter && !deps.limiter.take(auth.coach, deps.now?.() ?? Date.now()))
      return err(429, "Too many messages; wait a minute and try again.");
    const record = deps.store.add(entrant.coach.ffbCoachId, {
      type: "organiser-message",
      title: `Message from ${auth.coach} · ${tournament.name}`,
      body: text,
      link: tournamentLink(tournament.id, "overview"),
      from: auth.coach,
    });
    // Messages (§4.4): the same text lands in the organiser <-> coach thread, flagged ORGANISER (blocks do not apply).
    try { organiserThreadSink?.(auth.coach, entrant.coach.ffbCoachId, text, { kind: "tournament", id: tournament.id, name: tournament.name }); } catch { /* fire-and-forget */ }
    return { status: 201, body: { notification: { id: record.id, at: record.at } } };
  }

  return undefined;
}
