// Friends, private messages and the block list (landing/nav spec §4.3-4.5): per-coach JSON files under FORK_STATE_DIR.
//
//   friends/<coach>.json          { version, friends[], incoming[], outgoing[] }   mutual friends + pending requests
//   blocks/<coach>.json           { version, blocked[] }                            coaches this coach blocked
//   messages/threads/<id>.json    { version, id, coaches[2], seq, messages[] }      one 1:1 thread (capped)
//   messages/index/<coach>.json   { version, threads[] }                            the coach's thread list + unread
//
// Every file is written atomically. Reads are STRICT: a missing file is empty, an unreadable or malformed one throws
// (a corrupt block list must never read as "nobody blocked", which would fail open). Coaches are keyed by the identity
// store's key (trim + lower case) and stored in the spelling of their identity record. Everything here is synchronous,
// so one request's read-modify-write of both coaches' files never interleaves with another's.

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { notificationFileName } from "../notifications.js";
import { assertNotFenced, DeletionFenceError, isReservedCoachName } from "../privacy/fence.js";

export const socialKey = (coach: string): string => coach.trim().toLowerCase();
export const socialFileName = (coach: string): string => notificationFileName(socialKey(coach));

export const FRIENDS_CAP = 1000;
export const PENDING_CAP = 200;
export const BLOCKS_CAP = 1000;
export const THREAD_INDEX_CAP = 1000;
export const THREAD_MESSAGE_CAP = 1000;
export const MESSAGE_TEXT_MAX = 2000;
export const PREVIEW_MAX = 140;
export const THREAD_ID = /^t[a-f0-9]{16}$/;

export class SocialError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface FriendEntry { coach: string; since: string }
export interface RequestEntry { coach: string; at: string }
export interface FriendsFile { version: 1; friends: FriendEntry[]; incoming: RequestEntry[]; outgoing: RequestEntry[] }
export interface BlockEntry { coach: string; at: string }
export interface BlocksFile { version: 1; blocked: BlockEntry[] }
export interface OrganiserContext { kind: "tournament"; id: string; name: string }
export interface MessageRecord { id: number; from: string; text: string; at: string; organiser?: OrganiserContext }
export interface ThreadFile { version: 1; id: string; coaches: [string, string]; createdAt: string; seq: number; organiser?: true; messages: MessageRecord[] }
export interface IndexEntry {
  id: string;
  /** The other coach (identity spelling; "Deleted coach #n" after their account was deleted). */
  with: string;
  lastAt: string;
  lastFrom: string;
  preview: string;
  unread: number;
  organiser?: true;
}
export interface IndexFile { version: 1; threads: IndexEntry[] }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** undefined when the file does not exist; throws on anything unreadable. */
function readStrict(path: string): Obj | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch (e) { if (isEnoent(e)) return undefined; throw new SocialError(500, "A social store file is unreadable."); }
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new SocialError(500, "A social store file is unreadable."); }
  if (!isObj(data)) throw new SocialError(500, "A social store file is unreadable.");
  return data;
}

const entries = <T>(v: unknown, ok: (o: Obj) => boolean): T[] => (Array.isArray(v) ? v.filter((o) => isObj(o) && ok(o)) as T[] : []);
const pairOk = (field: string) => (o: Obj): boolean => isStr(o.coach) && o.coach.trim() !== "" && isStr(o[field]);

/**
 * Message text as stored: CRLF -> LF, C0/C1 controls (except tab and newline) and bidi overrides / isolates removed,
 * at most two blank lines in a row, trimmed. Plain text only: it is never parsed as HTML or markdown, and every view
 * renders it as text (Vue interpolation), so markup arrives on screen as the characters typed.
 */
export function cleanMessageText(raw: unknown): string {
  if (!isStr(raw)) return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩﻿]/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}
export const textLength = (s: string): number => [...s].length;

const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > PREVIEW_MAX ? `${chars.slice(0, PREVIEW_MAX - 1).join("")}…` : flat;
};

export interface SocialStoreOptions { now?: () => Date; newId?: () => string }

export class SocialStore {
  readonly friendsDir: string;
  readonly blocksDir: string;
  readonly threadsDir: string;
  readonly indexDir: string;

  constructor(readonly stateDir: string, private readonly opts: SocialStoreOptions = {}) {
    this.friendsDir = join(stateDir, "friends");
    this.blocksDir = join(stateDir, "blocks");
    this.threadsDir = join(stateDir, "messages", "threads");
    this.indexDir = join(stateDir, "messages", "index");
  }

  private nowIso(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private write(dir: string, file: string, data: unknown): void {
    mkdirSync(dir, { recursive: true });
    atomicWriteTextFile(join(dir, file), `${JSON.stringify(data, null, 2)}\n`);
  }

  // ---- friends --------------------------------------------------------------------------------------------------

  friends(coach: string): FriendsFile {
    const raw = readStrict(join(this.friendsDir, socialFileName(coach)));
    return {
      version: 1,
      friends: entries<FriendEntry>(raw?.friends, pairOk("since")),
      incoming: entries<RequestEntry>(raw?.incoming, pairOk("at")),
      outgoing: entries<RequestEntry>(raw?.outgoing, pairOk("at")),
    };
  }
  private putFriends(coach: string, data: FriendsFile): void {
    assertNotFenced(coach);
    this.write(this.friendsDir, socialFileName(coach), data);
  }

  relation(me: string, other: string): "self" | "friend" | "outgoing" | "incoming" | "none" {
    const k = socialKey(other);
    if (k === socialKey(me)) return "self";
    const f = this.friends(me);
    if (f.friends.some((x) => socialKey(x.coach) === k)) return "friend";
    if (f.outgoing.some((x) => socialKey(x.coach) === k)) return "outgoing";
    if (f.incoming.some((x) => socialKey(x.coach) === k)) return "incoming";
    return "none";
  }

  /** Send a request (or accept theirs when they already asked). Both spellings are identity spellings. */
  request(me: string, other: string): "requested" | "friends" | "already" {
    const rel = this.relation(me, other);
    if (rel === "self") throw new SocialError(400, "You cannot add yourself.");
    if (rel === "friend" || rel === "outgoing") return "already";
    if (rel === "incoming") { this.accept(me, other); return "friends"; }
    const mine = this.friends(me);
    const theirs = this.friends(other);
    if (mine.outgoing.length >= PENDING_CAP) throw new SocialError(429, "You have too many friend requests waiting. Cancel some first.");
    if (theirs.incoming.length >= PENDING_CAP) throw new SocialError(429, "This coach has too many friend requests waiting.");
    const at = this.nowIso();
    this.putFriends(me, { ...mine, outgoing: [...mine.outgoing, { coach: other, at }] });
    this.putFriends(other, { ...theirs, incoming: [...theirs.incoming, { coach: me, at }] });
    return "requested";
  }

  accept(me: string, other: string): void {
    const k = socialKey(other);
    const mine = this.friends(me);
    if (!mine.incoming.some((x) => socialKey(x.coach) === k)) throw new SocialError(404, "No friend request from this coach.");
    const theirs = this.friends(other);
    if (mine.friends.length >= FRIENDS_CAP || theirs.friends.length >= FRIENDS_CAP) throw new SocialError(429, "Friend list is full.");
    const since = this.nowIso();
    const meK = socialKey(me);
    this.putFriends(me, {
      version: 1,
      friends: [...mine.friends.filter((x) => socialKey(x.coach) !== k), { coach: other, since }],
      incoming: mine.incoming.filter((x) => socialKey(x.coach) !== k),
      outgoing: mine.outgoing.filter((x) => socialKey(x.coach) !== k),
    });
    this.putFriends(other, {
      version: 1,
      friends: [...theirs.friends.filter((x) => socialKey(x.coach) !== meK), { coach: me, since }],
      incoming: theirs.incoming.filter((x) => socialKey(x.coach) !== meK),
      outgoing: theirs.outgoing.filter((x) => socialKey(x.coach) !== meK),
    });
  }

  /** Drop every link between the two (friendship, requests either way). Returns whether anything changed. */
  unlink(me: string, other: string): boolean {
    const k = socialKey(other);
    const meK = socialKey(me);
    const strip = (f: FriendsFile, key: string): FriendsFile => ({
      version: 1,
      friends: f.friends.filter((x) => socialKey(x.coach) !== key),
      incoming: f.incoming.filter((x) => socialKey(x.coach) !== key),
      outgoing: f.outgoing.filter((x) => socialKey(x.coach) !== key),
    });
    const size = (f: FriendsFile): number => f.friends.length + f.incoming.length + f.outgoing.length;
    const mine = this.friends(me);
    const theirs = this.friends(other);
    const mineNext = strip(mine, k);
    const theirsNext = strip(theirs, meK);
    const changed = size(mineNext) !== size(mine) || size(theirsNext) !== size(theirs);
    if (size(mineNext) !== size(mine)) this.putFriends(me, mineNext);
    // The other side may be fenced (their account is being deleted): their file goes with the job anyway.
    if (size(theirsNext) !== size(theirs)) { try { this.putFriends(other, theirsNext); } catch (e) { if (!(e instanceof DeletionFenceError)) throw e; } }
    return changed;
  }

  /** Decline an incoming request (only that; never a friendship). */
  decline(me: string, other: string): void {
    const k = socialKey(other);
    const mine = this.friends(me);
    if (!mine.incoming.some((x) => socialKey(x.coach) === k)) throw new SocialError(404, "No friend request from this coach.");
    this.unlink(me, other);
  }

  // ---- blocks ---------------------------------------------------------------------------------------------------

  blocks(coach: string): BlocksFile {
    const raw = readStrict(join(this.blocksDir, socialFileName(coach)));
    return { version: 1, blocked: entries<BlockEntry>(raw?.blocked, pairOk("at")) };
  }
  hasBlocked(coach: string, other: string): boolean {
    const k = socialKey(other);
    return this.blocks(coach).blocked.some((b) => socialKey(b.coach) === k);
  }
  /** Either coach blocked the other. */
  blockedEitherWay(a: string, b: string): boolean { return this.hasBlocked(a, b) || this.hasBlocked(b, a); }

  /** Block: also removes the friendship and any pending request, both ways. */
  block(me: string, other: string): boolean {
    if (socialKey(me) === socialKey(other)) throw new SocialError(400, "You cannot block yourself.");
    assertNotFenced(me);
    const data = this.blocks(me);
    const already = data.blocked.some((b) => socialKey(b.coach) === socialKey(other));
    if (!already) {
      if (data.blocked.length >= BLOCKS_CAP) throw new SocialError(429, "Your block list is full.");
      this.write(this.blocksDir, socialFileName(me), { version: 1, blocked: [...data.blocked, { coach: other, at: this.nowIso() }] });
    }
    this.unlink(me, other);
    return !already;
  }
  unblock(me: string, other: string): boolean {
    assertNotFenced(me);
    const data = this.blocks(me);
    const next = data.blocked.filter((b) => socialKey(b.coach) !== socialKey(other));
    if (next.length === data.blocked.length) return false;
    this.write(this.blocksDir, socialFileName(me), { version: 1, blocked: next });
    return true;
  }

  // ---- threads --------------------------------------------------------------------------------------------------

  index(coach: string): IndexFile {
    const raw = readStrict(join(this.indexDir, socialFileName(coach)));
    const threads = entries<IndexEntry>(raw?.threads, (o) => isStr(o.id) && THREAD_ID.test(o.id) && isStr(o.with) && isStr(o.lastAt))
      .map((t) => ({
        id: t.id, with: t.with, lastAt: t.lastAt, lastFrom: isStr(t.lastFrom) ? t.lastFrom : "", preview: isStr(t.preview) ? t.preview : "",
        unread: Number.isSafeInteger(t.unread) && t.unread > 0 ? t.unread : 0, ...(t.organiser === true ? { organiser: true as const } : {}),
      }));
    return { version: 1, threads };
  }
  private putIndex(coach: string, data: IndexFile): void {
    assertNotFenced(coach);
    // Newest first; the oldest entries leave the list past the cap (the thread file stays for the other coach).
    const threads = [...data.threads].sort((a, b) => b.lastAt.localeCompare(a.lastAt)).slice(0, THREAD_INDEX_CAP);
    this.write(this.indexDir, socialFileName(coach), { version: 1, threads });
  }

  unread(coach: string): number {
    return this.index(coach).threads.reduce((n, t) => n + t.unread, 0);
  }

  thread(id: string): ThreadFile | undefined {
    if (!THREAD_ID.test(id)) return undefined;
    const raw = readStrict(join(this.threadsDir, `${id}.json`));
    if (!raw) return undefined;
    const coaches = Array.isArray(raw.coaches) ? raw.coaches.filter(isStr) : [];
    if (raw.id !== id || coaches.length !== 2) throw new SocialError(500, "A social store file is unreadable.");
    const messages = entries<MessageRecord>(raw.messages, (o) => Number.isSafeInteger(o.id) && isStr(o.from) && isStr(o.text) && isStr(o.at));
    const seq = Number.isSafeInteger(raw.seq) ? Number(raw.seq) : messages.reduce((m, x) => Math.max(m, x.id), 0);
    return {
      version: 1, id, coaches: [coaches[0]!, coaches[1]!], createdAt: isStr(raw.createdAt) ? raw.createdAt : "", seq, messages,
      ...(raw.organiser === true ? { organiser: true as const } : {}),
    };
  }

  /** The thread a coach sees, only when they are one of its two coaches. */
  threadFor(coach: string, id: string): ThreadFile | undefined {
    const t = this.thread(id);
    return t && t.coaches.some((c) => socialKey(c) === socialKey(coach)) ? t : undefined;
  }
  static other(t: ThreadFile, coach: string): string {
    return socialKey(t.coaches[0]) === socialKey(coach) ? t.coaches[1] : t.coaches[0];
  }

  /** The existing thread between the two (found through the sender's index), if any. */
  findThread(me: string, other: string): ThreadFile | undefined {
    const k = socialKey(other);
    for (const entry of this.index(me).threads) {
      if (socialKey(entry.with) !== k) continue;
      const t = this.threadFor(me, entry.id);
      if (t && socialKey(SocialStore.other(t, me)) === k) return t;
    }
    return undefined;
  }

  /**
   * Append one message (creating the thread when none exists). Updates both coaches' index rows. Returns the thread,
   * the stored message, and whether the recipient had nothing unread in this thread before (a new burst: notify once).
   */
  append(from: string, to: string, text: string, organiser?: OrganiserContext): { thread: ThreadFile; message: MessageRecord; created: boolean; burst: boolean } {
    assertNotFenced(from);
    assertNotFenced(to);
    if (isReservedCoachName(to) || isReservedCoachName(from)) throw new SocialError(410, "This coach's account was deleted.");
    const clean = cleanMessageText(text);
    if (!clean) throw new SocialError(400, "Write a message first.");
    if (textLength(clean) > MESSAGE_TEXT_MAX) throw new SocialError(400, `A message is at most ${MESSAGE_TEXT_MAX} characters.`);
    const at = this.nowIso();
    let thread = this.findThread(from, to);
    const created = !thread;
    if (!thread) {
      let id = "";
      for (let i = 0; i < 5 && (!id || this.thread(id)); i += 1) id = this.opts.newId?.() ?? `t${randomBytes(8).toString("hex")}`;
      if (!THREAD_ID.test(id) || this.thread(id)) throw new SocialError(500, "Could not start a conversation.");
      thread = { version: 1, id, coaches: [from, to], createdAt: at, seq: 0, messages: [] };
    }
    const message: MessageRecord = { id: thread.seq + 1, from, text: clean, at, ...(organiser ? { organiser } : {}) };
    const next: ThreadFile = {
      ...thread,
      seq: message.id,
      messages: [...thread.messages, message].slice(-THREAD_MESSAGE_CAP),
      ...(organiser || thread.organiser ? { organiser: true as const } : {}),
    };
    // The recipient's row first: if it fails (fenced), nothing was written.
    const theirs = this.index(to);
    const prior = theirs.threads.find((t) => t.id === next.id);
    const burst = !prior || prior.unread === 0;
    const row = (withCoach: string, unread: number): IndexEntry => ({
      id: next.id, with: withCoach, lastAt: at, lastFrom: from, preview: preview(clean), unread, ...(next.organiser ? { organiser: true as const } : {}),
    });
    this.write(this.threadsDir, `${next.id}.json`, next);
    this.putIndex(to, { version: 1, threads: [row(from, (prior?.unread ?? 0) + 1), ...theirs.threads.filter((t) => t.id !== next.id)] });
    const mine = this.index(from);
    this.putIndex(from, { version: 1, threads: [row(to, 0), ...mine.threads.filter((t) => t.id !== next.id)] });
    return { thread: next, message, created, burst };
  }

  /** Mark one thread read for the coach; returns their new total unread. */
  markRead(coach: string, id: string): number {
    const data = this.index(coach);
    const row = data.threads.find((t) => t.id === id);
    if (row && row.unread > 0) this.putIndex(coach, { version: 1, threads: data.threads.map((t) => (t.id === id ? { ...t, unread: 0 } : t)) });
    return this.unread(coach);
  }
}
