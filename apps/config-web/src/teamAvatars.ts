/**
 * Team avatars: a coach-uploaded image shown for their team (the Super FUMBBL race crest is the fallback).
 *
 * Storage: <dir>/<sha256(coach)>/<sha256("library:<id>" | "save:<id>")>.<png|jpg|webp>, ONE file per team.
 * Neither the coach name nor the ref ever reaches a path (both are hashed), and the extension comes from the
 * sniffed bytes, never from the request. Validation is decode-free: magic bytes + header-parsed dimensions.
 *
 * Routes (wired in server.ts):
 *   PUT    /api/fork/teams/<ref>/avatar   raw image body, owner only
 *   DELETE /api/fork/teams/<ref>/avatar   owner only
 *   GET    /api/fork/teams/<ref>/avatar   public read
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { parseTeamRef } from "./tabletop/teamFile.js";

export const AVATAR_MAX_BYTES = 512 * 1024;
export const AVATAR_MIN_PX = 64;
export const AVATAR_MAX_PX = 1024;
export const AVATAR_RATE_PER_MINUTE = 10;

export type AvatarExt = "png" | "jpg" | "webp";
const EXTS: AvatarExt[] = ["png", "jpg", "webp"];
export const AVATAR_CONTENT_TYPE: Record<AvatarExt, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** `/api/fork/teams/<ref>/avatar` -> the canonical team key ("library:<id>" | "save:<id>"), or undefined. */
export function teamAvatarPath(pathname: string): string | undefined {
  const m = /^\/api\/fork\/teams\/([^/]+)\/avatar$/.exec(pathname);
  if (!m) return undefined;
  try {
    return canonicalTeamKey(decodeURIComponent(m[1]!));
  } catch {
    return undefined;
  }
}

/** "library:<id>", "save:<id>" or a bare save id -> "library:<id>" | "save:<id>"; undefined for anything else. */
export function canonicalTeamKey(ref: string): string | undefined {
  const parsed = parseTeamRef(ref);
  return parsed ? `${parsed.kind}:${parsed.id}` : undefined;
}

const coachDir = (dir: string, coach: string): string => join(dir, sha(coach));
const fileName = (teamKey: string, ext: AvatarExt): string => `${sha(teamKey)}.${ext}`;

export interface SniffedImage { ext: AvatarExt; width: number; height: number }

/** Magic-byte sniff + header dimensions for png / jpeg / webp. Returns undefined for anything else or a malformed header. */
export function sniffImage(b: Buffer): SniffedImage | undefined {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString("latin1") === "IHDR") {
    return { ext: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = b.readUInt16BE(i + 2);
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) return { ext: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      if (length < 2) return undefined;
      i += 2 + length;
    }
    return undefined;
  }
  if (b.length >= 30 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    const kind = b.subarray(12, 16).toString("latin1");
    if (kind === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { ext: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L" && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") {
      return { ext: "webp", width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1, height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1 };
    }
  }
  return undefined;
}

export type AvatarCheck = { ok: true; image: SniffedImage } | { ok: false; error: string };

export function checkAvatar(b: Buffer): AvatarCheck {
  if (b.length === 0) return { ok: false, error: "An image is required." };
  if (b.length > AVATAR_MAX_BYTES) return { ok: false, error: `The image must be at most ${AVATAR_MAX_BYTES / 1024} KB.` };
  const image = sniffImage(b);
  if (!image) return { ok: false, error: "The image must be a PNG, JPEG or WebP file." };
  if (image.width < AVATAR_MIN_PX || image.height < AVATAR_MIN_PX) return { ok: false, error: `The image must be at least ${AVATAR_MIN_PX} x ${AVATAR_MIN_PX} pixels.` };
  if (image.width > AVATAR_MAX_PX || image.height > AVATAR_MAX_PX) return { ok: false, error: `The image must be at most ${AVATAR_MAX_PX} x ${AVATAR_MAX_PX} pixels.` };
  return { ok: true, image };
}

/** Store (replacing any previous file of any extension) atomically. */
export function saveAvatar(dir: string, coach: string, teamKey: string, bytes: Buffer, ext: AvatarExt): void {
  const folder = coachDir(dir, coach);
  mkdirSync(folder, { recursive: true });
  const target = join(folder, fileName(teamKey, ext));
  const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    renameSync(temp, target);
  } catch (error) {
    try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
    throw error;
  }
  for (const other of EXTS) {
    if (other === ext) continue;
    try { unlinkSync(join(folder, fileName(teamKey, other))); } catch { /* none */ }
  }
}

/** Remove the owner's avatar; true when a file was removed. */
export function removeAvatar(dir: string, coach: string, teamKey: string): boolean {
  let removed = false;
  for (const ext of EXTS) {
    try { unlinkSync(join(coachDir(dir, coach), fileName(teamKey, ext))); removed = true; } catch { /* none */ }
  }
  return removed;
}

export interface FoundAvatar { path: string; ext: AvatarExt; mtimeMs: number }

/** The stored avatar for a team (any owner folder: the public read has only the ref). Paths are built from hashes only. */
export function findAvatar(dir: string, teamKey: string): FoundAvatar | undefined {
  let folders: string[];
  try { folders = readdirSync(dir).filter((n) => /^[a-f0-9]{64}$/.test(n)); } catch { return undefined; }
  for (const folder of folders) {
    for (const ext of EXTS) {
      const path = join(dir, folder, fileName(teamKey, ext));
      try {
        const st = statSync(path);
        if (st.isFile()) return { path, ext, mtimeMs: st.mtimeMs };
      } catch { /* not here */ }
    }
  }
  return undefined;
}

/** The public read URL (with a version so a replaced image is not served stale), or undefined when none is stored. */
export function avatarUrlFor(dir: string | undefined, ref: string | undefined): string | undefined {
  if (!dir || !ref) return undefined;
  const key = canonicalTeamKey(ref);
  if (!key) return undefined;
  const found = findAvatar(dir, key);
  return found ? `/api/fork/teams/${encodeURIComponent(key)}/avatar?v=${Math.floor(found.mtimeMs)}` : undefined;
}

/** Raw request body, capped; resolves undefined when it exceeds `max` (the rest is drained and dropped). */
export async function readRawCapped(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let length = 0;
  let over = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > max) { over = true; chunks.length = 0; continue; }
    if (!over) chunks.push(buffer);
  }
  return over ? undefined : Buffer.concat(chunks);
}

const uploads = new Map<string, number[]>();
/** 10 changes per minute per coach. Returns the seconds to wait, or 0 when allowed (and counts this one). */
export function avatarRateLimit(coach: string, now = Date.now()): number {
  const recent = (uploads.get(coach) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= AVATAR_RATE_PER_MINUTE) {
    uploads.set(coach, recent);
    return Math.max(1, Math.ceil((60_000 - (now - recent[0]!)) / 1000));
  }
  recent.push(now);
  uploads.set(coach, recent);
  return 0;
}
export const resetAvatarRateLimit = (): void => uploads.clear();
