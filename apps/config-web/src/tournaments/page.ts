/**
 * Tournament page extras (spec-main-landing-nav §3 items 1-7): banner, location, start time, entry fee, summary,
 * notes, deadlines and news. All fields are optional and additive on the v4 record (no version bump).
 *
 * This module holds the request parsing / validation (pure) and the banner file handling. The store applies the
 * parsed patches; the API routes live in api.ts (JSON) and tournamentBannerApi below (raw image bodies).
 *
 * Banner guards reuse the team-avatar helpers (src/teamAvatars.ts): magic-byte sniff with header-parsed dimensions
 * (png / jpg / webp only), a byte cap, a hashed file name with the extension from the sniffed bytes, and the shared
 * per-coach rate limiter under its own key.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { parsePayField } from "../payments/links.js";
import { AVATAR_CONTENT_TYPE, avatarRateLimit, sniffImage, type AvatarExt, type SniffedImage } from "../teamAvatars.js";
import { isTournamentManager, TournamentStore, TournamentStoreError } from "./store.js";
import type { TournamentDeadlines, TournamentLocation, TournamentNewsPost, TournamentRecord } from "./types.js";

export const BANNER_MAX_BYTES = 1024 * 1024;
export const BANNER_MIN_WIDTH = 1200;
export const BANNER_MAX_WIDTH = 2400;
export const BANNER_DIR_NAME = "tournament-banners";
export const SUMMARY_MAX = 4000;
export const NOTES_MAX = 2000;
export const NEWS_TITLE_MAX = 120;
export const NEWS_BODY_MAX = 4000;
export const NEWS_MAX_POSTS = 100;
const VENUE_MAX = 120;
const ADDRESS_MAX = 200;
const URL_MAX = 500;
const ENTRY_FEE_MAX = 40;

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;
const BANNER_PATH = /^tournament-banners\/[a-f0-9]{64}\.(png|jpg|webp)$/;

const bad = (message: string): never => { throw new TournamentStoreError(400, message); };

/** Only absolute http(s) URLs without credentials or whitespace. */
export function safeHttpUrl(value: string): boolean {
  if (value.length > URL_MAX || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

/** Optional text: undefined = untouched; "" or null = clear; otherwise trimmed and capped. */
function text(value: unknown, field: string, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return bad(`${field} must be a string.`);
  const trimmed = value.replace(/\r\n?/g, "\n").trim();
  if (trimmed.length > max) return bad(`${field} must be at most ${max} characters.`);
  return trimmed === "" ? null : trimmed;
}

function iso(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value)))
    return bad(`${field} must be an ISO-8601 timestamp.`);
  return value;
}

function plainObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad(`${field} must be an object.`);
  return value as Record<string, unknown>;
}

/** The page fields of a PATCH body. A value of null clears the field (location / deadlines replace as a whole). */
export interface TournamentPagePatch {
  location?: TournamentLocation | null;
  startTime?: string | null;
  entryFee?: string | null;
  /** Payment links (src/payments/links.ts): null clears. */
  payPal?: string | null;
  venmo?: string | null;
  summary?: string | null;
  notes?: string | null;
  deadlines?: TournamentDeadlines | null;
}

export const PAGE_FIELDS = ["location", "startTime", "entryFee", "payPal", "venmo", "summary", "notes", "deadlines"] as const;

export function parsePagePatch(input: Record<string, unknown>): TournamentPagePatch {
  const out: TournamentPagePatch = {};
  if (input.location !== undefined) {
    if (input.location === null) out.location = null;
    else {
      const raw = plainObject(input.location, "location");
      const venue = text(raw.venue, "location.venue", VENUE_MAX);
      const address = text(raw.address, "location.address", ADDRESS_MAX);
      const mapUrl = text(raw.mapUrl, "location.mapUrl", URL_MAX);
      if (mapUrl && !safeHttpUrl(mapUrl)) bad("location.mapUrl must be an http(s) link.");
      const location: TournamentLocation = {
        ...(venue ? { venue } : {}),
        ...(address ? { address } : {}),
        ...(mapUrl ? { mapUrl } : {}),
      };
      out.location = Object.keys(location).length ? location : null;
    }
  }
  if (input.startTime !== undefined) {
    const value = text(input.startTime, "startTime", 5);
    if (value && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) bad("startTime must be a 24-hour time like 09:30.");
    out.startTime = value ?? null;
  }
  if (input.entryFee !== undefined) out.entryFee = text(input.entryFee, "entryFee", ENTRY_FEE_MAX) ?? null;
  for (const kind of ["payPal", "venmo"] as const) {
    const checked = parsePayField(kind, input[kind]);
    if (!checked) continue;
    if (!checked.ok) bad(checked.error);
    else out[kind] = checked.value || null;
  }
  if (input.summary !== undefined) out.summary = text(input.summary, "summary", SUMMARY_MAX) ?? null;
  if (input.notes !== undefined) out.notes = text(input.notes, "notes", NOTES_MAX) ?? null;
  if (input.deadlines !== undefined) {
    if (input.deadlines === null) out.deadlines = null;
    else {
      const raw = plainObject(input.deadlines, "deadlines");
      const registration = iso(raw.registration, "deadlines.registration");
      const checkIn = iso(raw.checkIn, "deadlines.checkIn");
      const deadlines: TournamentDeadlines = {
        ...(registration ? { registration } : {}),
        ...(checkIn ? { checkIn } : {}),
      };
      out.deadlines = Object.keys(deadlines).length ? deadlines : null;
    }
  }
  return out;
}

export interface NewsInput { title?: string; body?: string; pinned?: boolean }

/** A news post body. `partial` (PATCH) allows any subset; a create needs title and body. */
export function parseNewsInput(input: Record<string, unknown>, partial: boolean): NewsInput {
  const out: NewsInput = {};
  if (input.title !== undefined || !partial) {
    const title = text(input.title ?? "", "title", NEWS_TITLE_MAX);
    if (!title) bad("title is required.");
    out.title = title!;
  }
  if (input.body !== undefined || !partial) {
    const body = text(input.body ?? "", "body", NEWS_BODY_MAX);
    if (!body) bad("body is required.");
    out.body = body!;
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== "boolean") bad("pinned must be true or false.");
    out.pinned = input.pinned as boolean;
  }
  if (partial && Object.keys(out).length === 0) bad("Nothing to change: send title, body or pinned.");
  return out;
}

export function newNewsPost(input: NewsInput, by: string, now: Date): TournamentNewsPost {
  return { id: randomUUID().slice(0, 12), title: input.title!, body: input.body!, by, at: now.toISOString(), pinned: input.pinned === true };
}

/** Pinned first, then newest first (id breaks exact ties so the order is stable). */
export function orderedNews(news: readonly TournamentNewsPost[] | undefined): TournamentNewsPost[] {
  return [...(news ?? [])].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) || Date.parse(b.at) - Date.parse(a.at) || b.id.localeCompare(a.id));
}

// ---- banner ----

export type BannerCheck = { ok: true; image: SniffedImage } | { ok: false; error: string };

export function checkBanner(b: Buffer): BannerCheck {
  if (b.length === 0) return { ok: false, error: "An image is required." };
  if (b.length > BANNER_MAX_BYTES) return { ok: false, error: "The banner must be at most 1 MB." };
  const image = sniffImage(b);
  if (!image) return { ok: false, error: "The banner must be a PNG, JPEG or WebP file." };
  if (image.width < BANNER_MIN_WIDTH || image.width > BANNER_MAX_WIDTH)
    return { ok: false, error: `The banner must be ${BANNER_MIN_WIDTH} to ${BANNER_MAX_WIDTH} pixels wide.` };
  if (image.height < 1 || image.height > image.width)
    return { ok: false, error: "The banner must be wider than it is tall." };
  return { ok: true, image };
}

/** The public read URL for a record's banner (versioned by the file hash), or undefined. */
export function bannerUrl(record: Pick<TournamentRecord, "id" | "bannerPath">): string | undefined {
  if (!record.bannerPath || !BANNER_PATH.test(record.bannerPath)) return undefined;
  const hash = record.bannerPath.slice(BANNER_DIR_NAME.length + 1, BANNER_DIR_NAME.length + 13);
  return `/api/tournaments/${encodeURIComponent(record.id)}/banner?v=${hash}`;
}

/** `/api/tournaments/<id>/banner` (or the fork spelling) -> the tournament id. */
export function tournamentBannerPath(pathname: string): string | undefined {
  const m = /^\/api\/(?:fork\/)?tournaments\/([^/]+)\/banner$/.exec(pathname);
  if (!m) return undefined;
  try { return decodeURIComponent(m[1]!); } catch { return undefined; }
}

const sha = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

export interface BannerApiIdentity { coach: string; admin: boolean }

export interface BannerApiDeps {
  store: TournamentStore;
  /** The tournaments data dir; banners live in `<dir>/tournament-banners`. */
  dataDir: string;
  /** Reads the raw body up to `max` bytes; undefined = it was larger (the caller closes the connection). */
  readBody(max: number): Promise<Buffer | undefined>;
  /** True when a declared Content-Length is already over `max`. */
  declaredTooLarge?(max: number): boolean;
  now?: () => Date;
}

export interface BannerApiResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** GET: the file to stream. */
  /** `private`: an unpublished draft's banner (no shared caching). */
  file?: { path: string; contentType: string; private?: boolean };
  /** 413: answer, then drop the connection rather than drain the upload. */
  close?: boolean;
}

/**
 * PUT / DELETE (managers: owner, organisers, admins) and the public GET of a tournament banner. Order of checks on a
 * write: sign-in, tournament exists, rate limit (so manager probing is throttled too), manager, then the body.
 */
export async function tournamentBannerApi(
  method: string,
  pathname: string,
  auth: BannerApiIdentity | undefined,
  deps: BannerApiDeps,
): Promise<BannerApiResult | undefined> {
  const id = tournamentBannerPath(pathname);
  if (id === undefined) return undefined;
  const tournament = deps.store.tournament(id);
  if (method === "GET" || method === "HEAD") {
    const path = tournament?.bannerPath && BANNER_PATH.test(tournament.bannerPath) ? join(deps.dataDir, tournament.bannerPath) : undefined;
    if (!path) return { status: 404, body: { error: "No banner." } };
    const ext = tournament!.bannerPath!.split(".").pop() as AvatarExt;
    // An unpublished draft's banner is never cached by shared caches (only its managers reach it at all).
    return { status: 200, file: { path, contentType: AVATAR_CONTENT_TYPE[ext], ...(tournament!.unpublished === true ? { private: true } : {}) } };
  }
  if (method !== "PUT" && method !== "DELETE") return { status: 405, body: { error: "Use GET, PUT or DELETE." } };
  if (!auth) return { status: 401, body: { error: "Sign in to change the banner." } };
  if (!tournament) return { status: 404, body: { error: "Tournament not found." } };
  const wait = avatarRateLimit(`tournament-banner:${auth.coach.trim().toLowerCase()}`);
  if (wait > 0) return { status: 429, headers: { "retry-after": String(wait) }, body: { error: "Too many banner changes. Try again in a minute." } };
  if (!auth.admin && !isTournamentManager(tournament, auth.coach))
    return { status: 403, body: { error: "You are not this tournament's organizer." } };
  const now = deps.now?.() ?? new Date();
  const dropUnreferenced = async (rel: string | undefined): Promise<void> => {
    // Never unlink a file the record still points at (an identical re-upload maps to the same hashed path).
    if (!rel || !BANNER_PATH.test(rel) || deps.store.tournament(id)?.bannerPath === rel) return;
    try { await fsp.unlink(join(deps.dataDir, rel)); } catch { /* already gone */ }
  };
  if (method === "DELETE") {
    return withBannerLock(id, async () => {
      const previous = deps.store.tournament(id)?.bannerPath;
      deps.store.setBanner(id, undefined, now);
      await dropUnreferenced(previous);
      return { status: 204 };
    });
  }
  const tooLarge: BannerApiResult = { status: 413, close: true, body: { error: "The banner must be at most 1 MB." } };
  if (deps.declaredTooLarge?.(BANNER_MAX_BYTES)) return tooLarge;
  const bytes = await deps.readBody(BANNER_MAX_BYTES);
  if (!bytes) return tooLarge;
  const checked = checkBanner(bytes);
  if (!checked.ok) return { status: 400, body: { error: checked.error } };
  const rel = `${BANNER_DIR_NAME}/${sha(`${id}\0${sha(bytes)}`)}.${checked.image.ext}`;
  const dir = join(deps.dataDir, BANNER_DIR_NAME);
  const target = join(deps.dataDir, rel);
  // Lookup of the current path, file write, record update and cleanup run as one unit per tournament.
  return withBannerLock(id, async () => {
    if (!deps.store.tournament(id)) return { status: 404, body: { error: "Tournament not found." } };
    const previous = deps.store.tournament(id)?.bannerPath;
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await fsp.rename(temp, target);
    } catch {
      try { await fsp.unlink(temp); } catch { /* none */ }
      return { status: 500, body: { error: "Could not store the banner right now." } };
    }
    const updated = deps.store.setBanner(id, rel, now);
    await dropUnreferenced(previous);
    return { status: 200, body: { ok: true, bannerUrl: bannerUrl(updated) } };
  });
}

const bannerLocks = new Map<string, Promise<unknown>>();
/** Runs banner mutations of one tournament one at a time (a per-id promise chain; the entry is dropped when idle). */
function withBannerLock<T>(id: string, task: () => Promise<T>): Promise<T> {
  const prior = bannerLocks.get(id) ?? Promise.resolve();
  const run = prior.then(task, task);
  const tail = run.catch(() => undefined);
  bannerLocks.set(id, tail);
  void tail.then(() => { if (bannerLocks.get(id) === tail) bannerLocks.delete(id); });
  return run;
}
