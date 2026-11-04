// A simple threaded message board (clubs lane, the site's first "Board"): threads of posts with replies, edit / delete
// your own, moderators remove anything. Built for reuse: a board is addressed by a SCOPE key ("club:<id>" today; a league
// or tournament later) and every permission comes from the caller's BoardPolicy, so a new owner only writes its policy
// and mounts the routes (src/clubs/api.ts shows how).
//
//   <FORK_STATE_DIR>/boards/<sha256(scope)[0..32]>.json   { version, scope, seq, threads[], seen{}, notified{} }
//
// Text is stored exactly as written (plain text; every view renders it as text). The profanity filter only changes what a
// viewer SEES (the SPA's shown(): "Filter profanity"), never what is stored. Reads are strict (a corrupt board file throws,
// never reads as empty); writes are atomic and synchronous.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteTextFile } from "@bb/fork-ops";
import { cleanMessageText, textLength } from "../social/store.js";

export const BOARD_TEXT_MAX = 4000;
export const BOARD_TITLE_MAX = 120;
export const BOARD_THREADS_MAX = 500;
export const BOARD_REPLIES_MAX = 500;
export const BOARD_SCOPE = /^(?:club|league|tournament):[a-z0-9][a-z0-9_-]{0,79}$/i;
export const BOARD_POST_ID = /^p\d{1,9}$/;

export class BoardError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); this.name = "BoardError"; }
}

export interface BoardRemoval { by: "author" | "moderator"; at: string }

export interface BoardPost {
  id: string;
  author: string;
  text: string;
  at: string;
  editedAt?: string;
  removed?: BoardRemoval;
}

export interface BoardThread extends BoardPost {
  title: string;
  replies: BoardPost[];
  /** The newest post in the thread (thread order: newest activity first). */
  lastAt: string;
}

export interface BoardFile {
  version: 1;
  scope: string;
  seq: number;
  threads: BoardThread[];
  /** coach key -> when they last opened the board (POST .../seen). */
  seen: Record<string, string>;
  /** coach key -> when they were last told about new posts (coalescing: once until they visit). */
  notified: Record<string, string>;
}

/** What the viewer may do on this board (the owner's rules: a club's members post, its admins moderate). */
export interface BoardPolicy {
  canRead(viewer: string | undefined): boolean;
  canPost(viewer: string): boolean;
  canModerate(viewer: string): boolean;
}

const key = (coach: string): string => coach.normalize("NFC").trim().toLowerCase();
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export const boardFileName = (scope: string): string => `${createHash("sha256").update(scope).digest("hex").slice(0, 32)}.json`;

function post(raw: unknown): BoardPost | undefined {
  if (!isObj(raw) || !isStr(raw.id) || !BOARD_POST_ID.test(raw.id) || !isStr(raw.author) || !isStr(raw.text) || !isStr(raw.at)) return undefined;
  const removed = isObj(raw.removed) && (raw.removed.by === "author" || raw.removed.by === "moderator") && isStr(raw.removed.at)
    ? { by: raw.removed.by as BoardRemoval["by"], at: raw.removed.at } : undefined;
  return { id: raw.id, author: raw.author, text: raw.text, at: raw.at, ...(isStr(raw.editedAt) ? { editedAt: raw.editedAt } : {}), ...(removed ? { removed } : {}) };
}

export function parseBoardText(raw: unknown, max = BOARD_TEXT_MAX): string {
  if (!isStr(raw)) throw new BoardError(400, "Write something first.", "text");
  const text = cleanMessageText(raw).normalize("NFC");
  if (!text) throw new BoardError(400, "Write something first.", "text");
  if (textLength(text) > max) throw new BoardError(400, `A post is at most ${max} characters.`, "text");
  return text;
}

export function parseBoardTitle(raw: unknown): string {
  if (!isStr(raw)) throw new BoardError(400, "Give the thread a title.", "title");
  const title = cleanMessageText(raw).replace(/\s+/g, " ").normalize("NFC").trim();
  if (!title) throw new BoardError(400, "Give the thread a title.", "title");
  if (textLength(title) > BOARD_TITLE_MAX) throw new BoardError(400, `A title is at most ${BOARD_TITLE_MAX} characters.`, "title");
  return title;
}

export interface BoardStoreOptions { now?: () => Date }

export class BoardStore {
  readonly dir: string;
  constructor(stateDir: string, private readonly opts: BoardStoreOptions = {}) {
    this.dir = join(stateDir, "boards");
  }
  private now(): string { return (this.opts.now?.() ?? new Date()).toISOString(); }
  private path(scope: string): string {
    if (!BOARD_SCOPE.test(scope)) throw new BoardError(400, "Unknown board.");
    return join(this.dir, boardFileName(scope));
  }

  /** The board (empty when it has no file yet). Throws on an unreadable file. */
  read(scope: string): BoardFile {
    const p = this.path(scope);
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch (e) {
      if (isEnoent(e)) return { version: 1, scope, seq: 0, threads: [], seen: {}, notified: {} };
      throw new BoardError(500, "The board is unreadable.");
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new BoardError(500, "The board is unreadable."); }
    if (!isObj(raw) || raw.scope !== scope || !Array.isArray(raw.threads)) throw new BoardError(500, "The board is unreadable.");
    const threads: BoardThread[] = [];
    for (const t of raw.threads) {
      const head = post(t);
      if (!head || !isObj(t)) continue;
      const replies = Array.isArray(t.replies) ? t.replies.map(post).filter((r): r is BoardPost => Boolean(r)) : [];
      threads.push({ ...head, title: isStr(t.title) ? t.title : "", replies, lastAt: isStr(t.lastAt) ? t.lastAt : head.at });
    }
    const map = (v: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (isObj(v)) for (const [k, x] of Object.entries(v)) if (isStr(x)) out[k] = x;
      return out;
    };
    return { version: 1, scope, seq: typeof raw.seq === "number" ? raw.seq : 0, threads, seen: map(raw.seen), notified: map(raw.notified) };
  }

  private write(file: BoardFile): void {
    mkdirSync(this.dir, { recursive: true });
    atomicWriteTextFile(this.path(file.scope), `${JSON.stringify(file, null, 2)}\n`);
  }

  /** Removes a board entirely (its owner was deleted). */
  drop(scope: string): void {
    try { unlinkSync(this.path(scope)); } catch (e) { if (!isEnoent(e)) throw e; }
  }

  private nextId(file: BoardFile): string {
    file.seq += 1;
    return `p${file.seq}`;
  }

  private find(file: BoardFile, postId: string): { thread: BoardThread; post: BoardPost } {
    if (!BOARD_POST_ID.test(postId)) throw new BoardError(404, "Post not found.");
    for (const thread of file.threads) {
      if (thread.id === postId) return { thread, post: thread };
      const reply = thread.replies.find((r) => r.id === postId);
      if (reply) return { thread, post: reply };
    }
    throw new BoardError(404, "Post not found.");
  }

  startThread(scope: string, author: string, title: string, text: string): BoardThread {
    const file = this.read(scope);
    const at = this.now();
    const thread: BoardThread = { id: this.nextId(file), author, title, text, at, replies: [], lastAt: at };
    file.threads.push(thread);
    // The oldest-active threads go first when the board is full.
    if (file.threads.length > BOARD_THREADS_MAX) {
      file.threads.sort((a, b) => a.lastAt.localeCompare(b.lastAt));
      file.threads = file.threads.slice(file.threads.length - BOARD_THREADS_MAX);
    }
    this.write(file);
    return structuredClone(thread);
  }

  reply(scope: string, threadId: string, author: string, text: string): BoardPost {
    const file = this.read(scope);
    const thread = file.threads.find((t) => t.id === threadId);
    if (!thread || !BOARD_POST_ID.test(threadId)) throw new BoardError(404, "Thread not found.");
    if (thread.removed) throw new BoardError(409, "This thread was removed.", "removed");
    if (thread.replies.length >= BOARD_REPLIES_MAX) throw new BoardError(409, "This thread is full. Start a new one.", "full");
    const at = this.now();
    const reply: BoardPost = { id: this.nextId(file), author, text, at };
    thread.replies.push(reply);
    thread.lastAt = at;
    this.write(file);
    return structuredClone(reply);
  }

  /** The author edits their own post (text, and the title of a thread they started). */
  edit(scope: string, postId: string, author: string, text: string, title?: string): BoardPost {
    const file = this.read(scope);
    const found = this.find(file, postId);
    if (key(found.post.author) !== key(author)) throw new BoardError(403, "You can only edit your own posts.");
    if (found.post.removed) throw new BoardError(409, "This post was removed.", "removed");
    found.post.text = text;
    found.post.editedAt = this.now();
    if (title !== undefined && found.post === found.thread) found.thread.title = title;
    this.write(file);
    return structuredClone(found.post);
  }

  /** Removes a post: its author, or a moderator. The text goes; a placeholder keeps the thread's shape. */
  remove(scope: string, postId: string, actor: string, moderator: boolean): BoardPost {
    const file = this.read(scope);
    const found = this.find(file, postId);
    const own = key(found.post.author) === key(actor);
    if (!own && !moderator) throw new BoardError(403, "You can only remove your own posts.");
    if (found.post.removed) return structuredClone(found.post);
    found.post.removed = { by: own ? "author" : "moderator", at: this.now() };
    found.post.text = "";
    if (found.post === found.thread) found.thread.title = "";
    this.write(file);
    return structuredClone(found.post);
  }

  /** The viewer opened the board (a POST: reads never change state). */
  markSeen(scope: string, coach: string): void {
    const file = this.read(scope);
    file.seen[key(coach)] = this.now();
    this.write(file);
  }

  /**
   * Coalesced "new posts" notices: of `candidates` (the members who opted in), the ones to tell now - not the author, and
   * not anyone already told since they last opened the board. Records them as told in the same write.
   */
  claimNotices(scope: string, candidates: readonly string[], author: string): string[] {
    const file = this.read(scope);
    const out: string[] = [];
    const at = this.now();
    for (const c of candidates) {
      const k = key(c);
      if (!k || k === key(author)) continue;
      const told = file.notified[k];
      const seen = file.seen[k];
      if (told && (!seen || seen < told)) continue;
      file.notified[k] = at;
      out.push(c);
    }
    if (out.length) this.write(file);
    return out;
  }
}

/** The board as one viewer sees it: newest activity first, with what they may do on each post. */
export interface BoardPostView extends BoardPost {
  mine: boolean;
  canEdit: boolean;
  canRemove: boolean;
}
export interface BoardThreadView extends BoardPostView {
  title: string;
  lastAt: string;
  replies: BoardPostView[];
}
export interface BoardView {
  threads: BoardThreadView[];
  canPost: boolean;
  canModerate: boolean;
  /** When this viewer last opened the board (posts after it show as new). */
  seenAt?: string;
}

export function boardView(file: BoardFile, viewer: string, policy: BoardPolicy): BoardView {
  const k = key(viewer);
  const canPost = policy.canPost(viewer);
  const canModerate = policy.canModerate(viewer);
  const view = (p: BoardPost): BoardPostView => {
    const mine = key(p.author) === k;
    return { ...structuredClone(p), mine, canEdit: mine && canPost && !p.removed, canRemove: !p.removed && (mine || canModerate) };
  };
  const threads = [...file.threads]
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.id.localeCompare(a.id))
    .map((t) => ({ ...view(t), title: t.title, lastAt: t.lastAt, replies: t.replies.map(view) }));
  return { threads, canPost, canModerate, ...(file.seen[k] ? { seenAt: file.seen[k] } : {}) };
}
