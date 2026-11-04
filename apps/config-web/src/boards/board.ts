// A simple threaded message board (clubs lane, the site's first "Board"): threads of posts with replies, edit / delete
// your own, moderators remove anything. Built for reuse: a board is addressed by a SCOPE key ("club:<id>", "league:<id>",
// "tournament:<id>") and every permission comes from the caller's BoardPolicy, so a new owner only writes its policy
// and mounts the routes (src/clubs/api.ts and src/boards/competitionApi.ts show how).
//
//   <FORK_STATE_DIR>/boards/<sha256(scope)[0..32]>.json
//     { version, scope, seq, threads[], seen{}, notified{},
//       settings?, mutes?, reports?, rseq?, log?, lseq? }        (the moderation fields: league / tournament boards only)
//
// Moderation (league and tournament boards, owner 11-04): organisers hide / unhide, pin / unpin, lock / unlock threads,
// delete posts (soft: a "removed by an organiser" placeholder keeps the thread's shape) and mute a coach until a time.
// Coaches report posts (one open report per coach per post). Every moderation action lands in the board's log (who, what,
// when, reason). The invariants live HERE so every caller gets them: a muted coach, a locked or hidden thread and a
// switched-off board refuse posts in the store itself. A club board never sets any of these, so it behaves as before.
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
export const BOARD_REASON_MAX = 500;
/** Moderation log entries kept per board (oldest dropped first). */
export const BOARD_LOG_MAX = 2000;
/** Reports kept per board (resolved ones are dropped first, oldest first). */
export const BOARD_REPORTS_MAX = 1000;
/** The longest mute (custom "until"). */
export const BOARD_MUTE_MAX_MS = 366 * 24 * 60 * 60_000;
export const BOARD_SCOPE = /^(?:club|league|tournament):[a-z0-9][a-z0-9_-]{0,79}$/i;
export const BOARD_POST_ID = /^p\d{1,9}$/;
export const BOARD_REPORT_ID = /^r\d{1,9}$/;

export class BoardError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); this.name = "BoardError"; }
}

export interface BoardRemoval { by: "author" | "moderator"; at: string }
/** Who set a moderation mark (hidden / pinned / locked), and when. */
export interface BoardMark { by: string; at: string }

export interface BoardPost {
  id: string;
  author: string;
  text: string;
  at: string;
  editedAt?: string;
  removed?: BoardRemoval;
  /** Hidden by a moderator: kept as written, shown only to moderators until unhidden. */
  hidden?: BoardMark;
}

export interface BoardThread extends BoardPost {
  title: string;
  replies: BoardPost[];
  /** The newest post in the thread (thread order: newest activity first). */
  lastAt: string;
  /** Pinned threads list first. */
  pinned?: BoardMark;
  /** A locked thread takes no replies (moderators excepted). */
  locked?: BoardMark;
}

export interface BoardSettings {
  /** On by default; off hides the board from coaches and refuses posts (posts are kept). */
  enabled: boolean;
  /** Anyone may read (off by default: members and organisers only). */
  publicRead: boolean;
  /** Bumped by every settings write; a write names the revision it read (428 missing, 409 stale). */
  revision: number;
}
export const DEFAULT_BOARD_SETTINGS: Readonly<BoardSettings> = Object.freeze({ enabled: true, publicRead: false, revision: 0 });

export interface BoardMute { coach: string; until: string; by: string; at: string; reason?: string }

export type BoardReportOutcome = "dismissed" | "actioned";
export interface BoardReport {
  id: string;
  postId: string;
  threadId: string;
  reporter: string;
  reason: string;
  at: string;
  resolved?: { by: string; at: string; outcome: BoardReportOutcome };
}

export const BOARD_LOG_ACTIONS = [
  "delete", "hide", "unhide", "pin", "unpin", "lock", "unlock", "mute", "unmute", "report-dismissed", "report-actioned", "settings",
] as const;
export type BoardLogAction = (typeof BOARD_LOG_ACTIONS)[number];
export interface BoardLogEntry {
  id: string;
  at: string;
  /** The moderator. */
  by: string;
  action: BoardLogAction;
  postId?: string;
  /** The coach the action was about (the post's author, the muted coach). */
  coach?: string;
  reason?: string;
  /** A short machine-written note (the mute's end, the settings that changed). */
  detail?: string;
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
  // ---- moderation (absent on boards that never used it, e.g. every club board) ----
  settings?: BoardSettings;
  /** coach key -> the mute (kept after it ends until the coach is muted again or unmuted; the end decides). */
  mutes?: Record<string, BoardMute>;
  reports?: BoardReport[];
  rseq?: number;
  /** Newest last. */
  log?: BoardLogEntry[];
  lseq?: number;
}

/** What the viewer may do on this board (the owner's rules: a club's members post, its admins moderate). */
export interface BoardPolicy {
  canRead(viewer: string | undefined): boolean;
  canPost(viewer: string): boolean;
  canModerate(viewer: string): boolean;
  /** Reporting posts (league / tournament boards). Absent = no reports on this board. */
  canReport?(viewer: string): boolean;
}

/** A write's moderation context: moderators may still reply in a locked or hidden thread and are never muted. */
export interface BoardWriteOptions { moderator?: boolean }

export const boardCoachKey = (coach: string): string => coach.normalize("NFC").trim().toLowerCase();
const key = boardCoachKey;
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

export const boardFileName = (scope: string): string => `${createHash("sha256").update(scope).digest("hex").slice(0, 32)}.json`;

function mark(raw: unknown): BoardMark | undefined {
  return isObj(raw) && isStr(raw.by) && isStr(raw.at) ? { by: raw.by, at: raw.at } : undefined;
}

function post(raw: unknown): BoardPost | undefined {
  if (!isObj(raw) || !isStr(raw.id) || !BOARD_POST_ID.test(raw.id) || !isStr(raw.author) || !isStr(raw.text) || !isStr(raw.at)) return undefined;
  const removed = isObj(raw.removed) && (raw.removed.by === "author" || raw.removed.by === "moderator") && isStr(raw.removed.at)
    ? { by: raw.removed.by as BoardRemoval["by"], at: raw.removed.at } : undefined;
  const hidden = mark(raw.hidden);
  return {
    id: raw.id, author: raw.author, text: raw.text, at: raw.at, ...(isStr(raw.editedAt) ? { editedAt: raw.editedAt } : {}), ...(removed ? { removed } : {}),
    ...(hidden ? { hidden } : {}),
  };
}

function readSettings(raw: unknown): BoardSettings | undefined {
  if (!isObj(raw)) return undefined;
  return {
    enabled: raw.enabled !== false,
    publicRead: raw.publicRead === true,
    revision: typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
  };
}

/** A reason a moderator or reporter typed: optional unless `required`; one paragraph, capped. */
export function parseBoardReason(raw: unknown, required = false): string {
  if (raw === undefined || raw === null || raw === "") {
    if (required) throw new BoardError(400, "Give a reason.", "reason");
    return "";
  }
  if (!isStr(raw)) throw new BoardError(400, "The reason must be text.", "reason");
  const text = cleanMessageText(raw).replace(/\s+/g, " ").normalize("NFC").trim();
  if (required && !text) throw new BoardError(400, "Give a reason.", "reason");
  if (textLength(text) > BOARD_REASON_MAX) throw new BoardError(400, `A reason is at most ${BOARD_REASON_MAX} characters.`, "reason");
  return text;
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

/** The board's settings (the defaults when it has none). */
export const boardSettings = (file: Pick<BoardFile, "settings">): BoardSettings => ({ ...(file.settings ?? DEFAULT_BOARD_SETTINGS) });

/** The coach's mute while it lasts (undefined once it ended). */
export function activeMute(file: Pick<BoardFile, "mutes">, coach: string, now: Date): BoardMute | undefined {
  const m = file.mutes?.[key(coach)];
  return m && Date.parse(m.until) > now.getTime() ? { ...m } : undefined;
}

export interface BoardStoreOptions { now?: () => Date }

export class BoardStore {
  readonly dir: string;
  constructor(stateDir: string, private readonly opts: BoardStoreOptions = {}) {
    this.dir = join(stateDir, "boards");
  }
  private date(): Date { return this.opts.now?.() ?? new Date(); }
  private now(): string { return this.date().toISOString(); }
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
      const pinned = mark(t.pinned);
      const locked = mark(t.locked);
      threads.push({ ...head, title: isStr(t.title) ? t.title : "", replies, lastAt: isStr(t.lastAt) ? t.lastAt : head.at, ...(pinned ? { pinned } : {}), ...(locked ? { locked } : {}) });
    }
    const map = (v: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (isObj(v)) for (const [k, x] of Object.entries(v)) if (isStr(x)) out[k] = x;
      return out;
    };
    const file: BoardFile = { version: 1, scope, seq: typeof raw.seq === "number" ? raw.seq : 0, threads, seen: map(raw.seen), notified: map(raw.notified) };
    const settings = readSettings(raw.settings);
    if (settings) file.settings = settings;
    if (isObj(raw.mutes)) {
      const mutes: Record<string, BoardMute> = {};
      for (const [k, m] of Object.entries(raw.mutes)) {
        if (!isObj(m) || !isStr(m.coach) || !isStr(m.until) || !isStr(m.by) || !isStr(m.at)) continue;
        mutes[k] = { coach: m.coach, until: m.until, by: m.by, at: m.at, ...(isStr(m.reason) && m.reason ? { reason: m.reason } : {}) };
      }
      file.mutes = mutes;
    }
    if (Array.isArray(raw.reports)) {
      file.reports = raw.reports.flatMap((r): BoardReport[] => {
        if (!isObj(r) || !isStr(r.id) || !BOARD_REPORT_ID.test(r.id) || !isStr(r.postId) || !isStr(r.threadId) || !isStr(r.reporter) || !isStr(r.reason) || !isStr(r.at)) return [];
        const res = isObj(r.resolved) && isStr(r.resolved.by) && isStr(r.resolved.at) && (r.resolved.outcome === "dismissed" || r.resolved.outcome === "actioned")
          ? { by: r.resolved.by, at: r.resolved.at, outcome: r.resolved.outcome as BoardReportOutcome } : undefined;
        return [{ id: r.id, postId: r.postId, threadId: r.threadId, reporter: r.reporter, reason: r.reason, at: r.at, ...(res ? { resolved: res } : {}) }];
      });
    }
    if (typeof raw.rseq === "number") file.rseq = raw.rseq;
    if (Array.isArray(raw.log)) {
      file.log = raw.log.flatMap((e): BoardLogEntry[] => {
        if (!isObj(e) || !isStr(e.id) || !isStr(e.at) || !isStr(e.by) || !(BOARD_LOG_ACTIONS as readonly unknown[]).includes(e.action)) return [];
        return [{
          id: e.id, at: e.at, by: e.by, action: e.action as BoardLogAction,
          ...(isStr(e.postId) ? { postId: e.postId } : {}), ...(isStr(e.coach) ? { coach: e.coach } : {}),
          ...(isStr(e.reason) && e.reason ? { reason: e.reason } : {}), ...(isStr(e.detail) && e.detail ? { detail: e.detail } : {}),
        }];
      });
    }
    if (typeof raw.lseq === "number") file.lseq = raw.lseq;
    return file;
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

  private log(file: BoardFile, entry: Omit<BoardLogEntry, "id" | "at">): void {
    file.lseq = (file.lseq ?? 0) + 1;
    const log = file.log ?? [];
    log.push({ id: `l${file.lseq}`, at: this.now(), ...entry });
    file.log = log.length > BOARD_LOG_MAX ? log.slice(log.length - BOARD_LOG_MAX) : log;
  }

  /** The posting rules every new post or edit passes: the board is on, and the author is not muted (moderators never are). */
  private assertMayPost(file: BoardFile, author: string, opts: BoardWriteOptions): void {
    if (!boardSettings(file).enabled) throw new BoardError(403, "The board is switched off.", "board-off");
    if (opts.moderator) return;
    const muted = activeMute(file, author, this.date());
    if (muted) throw new BoardError(403, `You are muted on this board until ${muted.until}.`, "muted");
  }

  startThread(scope: string, author: string, title: string, text: string, opts: BoardWriteOptions = {}): BoardThread {
    const file = this.read(scope);
    this.assertMayPost(file, author, opts);
    const at = this.now();
    const thread: BoardThread = { id: this.nextId(file), author, title, text, at, replies: [], lastAt: at };
    file.threads.push(thread);
    // The oldest-active threads go first when the board is full (pinned threads stay).
    if (file.threads.length > BOARD_THREADS_MAX) {
      file.threads.sort((a, b) => Number(Boolean(a.pinned)) - Number(Boolean(b.pinned)) || a.lastAt.localeCompare(b.lastAt));
      file.threads = file.threads.slice(file.threads.length - BOARD_THREADS_MAX);
    }
    this.write(file);
    return structuredClone(thread);
  }

  reply(scope: string, threadId: string, author: string, text: string, opts: BoardWriteOptions = {}): BoardPost {
    const file = this.read(scope);
    const thread = file.threads.find((t) => t.id === threadId);
    if (!thread || !BOARD_POST_ID.test(threadId)) throw new BoardError(404, "Thread not found.");
    this.assertMayPost(file, author, opts);
    if (thread.removed) throw new BoardError(409, "This thread was removed.", "removed");
    if (thread.locked && !opts.moderator) throw new BoardError(409, "This thread is locked.", "locked");
    if (thread.hidden && !opts.moderator) throw new BoardError(409, "This thread is hidden.", "hidden");
    if (thread.replies.length >= BOARD_REPLIES_MAX) throw new BoardError(409, "This thread is full. Start a new one.", "full");
    const at = this.now();
    const reply: BoardPost = { id: this.nextId(file), author, text, at };
    thread.replies.push(reply);
    thread.lastAt = at;
    this.write(file);
    return structuredClone(reply);
  }

  /** The author edits their own post (text, and the title of a thread they started). */
  edit(scope: string, postId: string, author: string, text: string, title?: string, opts: BoardWriteOptions = {}): BoardPost {
    const file = this.read(scope);
    const found = this.find(file, postId);
    if (key(found.post.author) !== key(author)) throw new BoardError(403, "You can only edit your own posts.");
    if (found.post.removed) throw new BoardError(409, "This post was removed.", "removed");
    this.assertMayPost(file, author, opts);
    if (found.post.hidden && !opts.moderator) throw new BoardError(409, "This post is hidden.", "hidden");
    if (found.thread.locked && !opts.moderator) throw new BoardError(409, "This thread is locked.", "locked");
    found.post.text = text;
    found.post.editedAt = this.now();
    if (title !== undefined && found.post === found.thread) found.thread.title = title;
    this.write(file);
    return structuredClone(found.post);
  }

  /**
   * Removes a post: its author, or a moderator. The text goes; a placeholder keeps the thread's shape. `log` (league and
   * tournament boards) records a moderator's removal of someone else's post in the moderation log, with its reason.
   */
  remove(scope: string, postId: string, actor: string, moderator: boolean, log?: { reason?: string }): BoardPost {
    const file = this.read(scope);
    const found = this.find(file, postId);
    const own = key(found.post.author) === key(actor);
    if (!own && !moderator) throw new BoardError(403, "You can only remove your own posts.");
    if (found.post.removed) return structuredClone(found.post);
    found.post.removed = { by: own ? "author" : "moderator", at: this.now() };
    found.post.text = "";
    delete found.post.hidden;
    if (found.post === found.thread) found.thread.title = "";
    if (log && !own) {
      this.log(file, { by: actor, action: "delete", postId, coach: found.post.author, ...(log.reason ? { reason: log.reason } : {}) });
      // The open reports on that post are dealt with: closed as actioned (part of the delete's log entry).
      for (const r of file.reports ?? []) if (!r.resolved && r.postId === postId) r.resolved = { by: actor, at: this.now(), outcome: "actioned" };
    }
    this.write(file);
    return structuredClone(found.post);
  }

  /**
   * A moderator's mark on a post: hide / unhide any post; pin / unpin and lock / unlock a thread (its first post). A no-op
   * (already in that state) writes nothing and logs nothing. Returns whether it changed.
   */
  moderate(scope: string, postId: string, action: "hide" | "unhide" | "pin" | "unpin" | "lock" | "unlock", by: string, reason = ""): boolean {
    const file = this.read(scope);
    const found = this.find(file, postId);
    if (found.post.removed) throw new BoardError(409, "This post was removed.", "removed");
    const isThread = found.post === found.thread;
    if ((action === "pin" || action === "unpin" || action === "lock" || action === "unlock") && !isThread)
      throw new BoardError(400, "Only a thread can be pinned or locked.", "not-thread");
    const m: BoardMark = { by, at: this.now() };
    let changed = false;
    if (action === "hide" && !found.post.hidden) { found.post.hidden = m; changed = true; }
    if (action === "unhide" && found.post.hidden) { delete found.post.hidden; changed = true; }
    if (action === "pin" && !found.thread.pinned) { found.thread.pinned = m; changed = true; }
    if (action === "unpin" && found.thread.pinned) { delete found.thread.pinned; changed = true; }
    if (action === "lock" && !found.thread.locked) { found.thread.locked = m; changed = true; }
    if (action === "unlock" && found.thread.locked) { delete found.thread.locked; changed = true; }
    if (!changed) return false;
    this.log(file, { by, action, postId, coach: found.post.author, ...(reason ? { reason } : {}) });
    this.write(file);
    return true;
  }

  /** Mutes `coach` on this board until `until` (replaces a running mute). */
  mute(scope: string, coach: string, until: Date, by: string, reason = ""): BoardMute {
    const file = this.read(scope);
    const now = this.date();
    if (!(until.getTime() > now.getTime())) throw new BoardError(400, "A mute must end in the future.", "until");
    if (until.getTime() - now.getTime() > BOARD_MUTE_MAX_MS) throw new BoardError(400, "A mute lasts at most a year.", "until");
    const mute: BoardMute = { coach, until: until.toISOString(), by, at: now.toISOString(), ...(reason ? { reason } : {}) };
    file.mutes = { ...(file.mutes ?? {}), [key(coach)]: mute };
    this.log(file, { by, action: "mute", coach, detail: `until ${mute.until}`, ...(reason ? { reason } : {}) });
    this.write(file);
    return { ...mute };
  }

  /** Ends the coach's mute now. A coach who is not muted: nothing changes (false). */
  unmute(scope: string, coach: string, by: string, reason = ""): boolean {
    const file = this.read(scope);
    const k = key(coach);
    const m = file.mutes?.[k];
    if (!m) return false;
    const running = Date.parse(m.until) > this.date().getTime();
    delete file.mutes![k];
    if (running) this.log(file, { by, action: "unmute", coach: m.coach, ...(reason ? { reason } : {}) });
    this.write(file);
    return running;
  }

  /**
   * A coach reports a post. One open report per coach per post: a repeat answers the open one with `duplicate` and writes
   * nothing. Removed posts and your own posts can't be reported.
   */
  report(scope: string, postId: string, reporter: string, reason: string): { report: BoardReport; duplicate: boolean } {
    const file = this.read(scope);
    const found = this.find(file, postId);
    if (found.post.removed) throw new BoardError(409, "This post was removed.", "removed");
    if (key(found.post.author) === key(reporter)) throw new BoardError(400, "You can't report your own post.", "own");
    const reports = file.reports ?? [];
    const open = reports.find((r) => !r.resolved && r.postId === postId && key(r.reporter) === key(reporter));
    if (open) return { report: { ...open }, duplicate: true };
    file.rseq = (file.rseq ?? 0) + 1;
    const report: BoardReport = { id: `r${file.rseq}`, postId, threadId: found.thread.id, reporter, reason, at: this.now() };
    reports.push(report);
    // Full: resolved reports go first (oldest first), then the oldest open ones.
    while (reports.length > BOARD_REPORTS_MAX) {
      const i = reports.findIndex((r) => r.resolved);
      reports.splice(i >= 0 ? i : 0, 1);
    }
    file.reports = reports;
    this.write(file);
    return { report: { ...report }, duplicate: false };
  }

  /** A moderator closes a report (dismissed, or actioned after acting on the post). Logged. */
  resolveReport(scope: string, reportId: string, by: string, outcome: BoardReportOutcome, reason = ""): BoardReport {
    const file = this.read(scope);
    const report = BOARD_REPORT_ID.test(reportId) ? file.reports?.find((r) => r.id === reportId) : undefined;
    if (!report) throw new BoardError(404, "Report not found.");
    if (report.resolved) throw new BoardError(409, "This report was already resolved.", "resolved");
    report.resolved = { by, at: this.now(), outcome };
    let author: string | undefined;
    try { author = this.find(file, report.postId).post.author; } catch { author = undefined; }
    this.log(file, { by, action: outcome === "dismissed" ? "report-dismissed" : "report-actioned", postId: report.postId, ...(author ? { coach: author } : {}), ...(reason ? { reason } : {}), detail: report.id });
    this.write(file);
    return { ...report };
  }

  /** Changes the board's settings. `expected` is the settings revision the moderator read (409 when stale). Logged. */
  updateSettings(scope: string, expected: number, patch: Partial<Pick<BoardSettings, "enabled" | "publicRead">>, by: string): BoardSettings {
    const file = this.read(scope);
    const current = boardSettings(file);
    if (current.revision !== expected) throw new BoardError(409, "The board settings changed since you loaded them. Reload and try again.", "stale");
    const next: BoardSettings = { ...current, revision: current.revision + 1 };
    const changes: string[] = [];
    if (patch.enabled !== undefined && patch.enabled !== current.enabled) { next.enabled = patch.enabled; changes.push(patch.enabled ? "board on" : "board off"); }
    if (patch.publicRead !== undefined && patch.publicRead !== current.publicRead) { next.publicRead = patch.publicRead; changes.push(patch.publicRead ? "public read on" : "public read off"); }
    if (!changes.length) return current;
    file.settings = next;
    this.log(file, { by, action: "settings", detail: changes.join(", ") });
    this.write(file);
    return { ...next };
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
export interface BoardPostView extends Omit<BoardPost, "hidden"> {
  mine: boolean;
  canEdit: boolean;
  canRemove: boolean;
  /** Moderation boards only. */
  hidden?: true;
  canReport?: boolean;
}
export interface BoardThreadView extends BoardPostView {
  title: string;
  lastAt: string;
  replies: BoardPostView[];
  pinned?: true;
  locked?: true;
}
export interface BoardView {
  threads: BoardThreadView[];
  canPost: boolean;
  canModerate: boolean;
  /** When this viewer last opened the board (posts after it show as new). */
  seenAt?: string;
}

export interface BoardViewOptions {
  /** A moderation board (league / tournament): hidden posts show as placeholders to non-moderators, pinned threads go
   *  first, and each post carries its marks and canReport. */
  moderation?: boolean;
  now?: Date;
}

export function boardView(file: BoardFile, viewer: string, policy: BoardPolicy, opts: BoardViewOptions = {}): BoardView {
  const k = key(viewer);
  const canPost = policy.canPost(viewer);
  const canModerate = policy.canModerate(viewer);
  const moderation = opts.moderation === true;
  const canReport = moderation && Boolean(k) && policy.canReport?.(viewer) === true;
  const view = (p: BoardPost, thread: BoardThread): BoardPostView => {
    const mine = key(p.author) === k;
    const { hidden, ...rest } = structuredClone(p);
    if (!moderation) {
      return { ...rest, ...(hidden ? { hidden: true as const } : {}), mine, canEdit: mine && canPost && !p.removed, canRemove: !p.removed && (mine || canModerate) };
    }
    // Non-moderators never get a hidden post's text (or a hidden thread's title, below).
    const masked = hidden && !canModerate ? { text: "" } : {};
    const frozen = Boolean(thread.locked || hidden) && !canModerate;
    return {
      ...rest, ...masked, ...(hidden ? { hidden: true as const } : {}), mine,
      canEdit: mine && canPost && !p.removed && !frozen,
      canRemove: !p.removed && (mine || canModerate),
      canReport: canReport && !mine && !p.removed && !hidden,
    };
  };
  const threads = [...file.threads]
    .sort((a, b) => (moderation ? Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) : 0) || b.lastAt.localeCompare(a.lastAt) || b.id.localeCompare(a.id))
    .map((t): BoardThreadView => ({
      ...view(t, t),
      title: moderation && t.hidden && !canModerate ? "" : t.title,
      lastAt: t.lastAt,
      // A hidden thread shows coaches only its placeholder (its replies go with it until it is unhidden).
      replies: moderation && t.hidden && !canModerate ? [] : t.replies.map((r) => view(r, t)),
      ...(moderation && t.pinned ? { pinned: true as const } : {}),
      ...(moderation && t.locked ? { locked: true as const } : {}),
    }));
  return { threads, canPost, canModerate, ...(k && file.seen[k] ? { seenAt: file.seen[k] } : {}) };
}
