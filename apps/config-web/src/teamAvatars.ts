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
import { promises as fsp } from "node:fs";
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

export interface SniffedImage { ext: AvatarExt; width: number; height: number }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Magic-byte sniff + header dimensions for png / jpeg / webp, strict about the structure it reads: a wrong PNG IHDR
 * length, a JPEG SOF that is truncated or short, or WebP RIFF / chunk lengths that do not fit the file are all
 * "not an image" (undefined). Anything else (SVG, HTML, GIF, ...) never matches a magic and is refused.
 */
export function sniffImage(b: Buffer): SniffedImage | undefined {
  if (b.length >= 33 && b.subarray(0, 8).equals(PNG_SIG)) {
    if (b.readUInt32BE(8) !== 13 || b.subarray(12, 16).toString("latin1") !== "IHDR") return undefined;
    return { ext: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) { i += 1; continue; }
      const marker = b[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9) return undefined; // EOI before any frame header
      const length = b.readUInt16BE(i + 2);
      if (length < 2 || i + 2 + length > b.length) return undefined; // segment runs past the file: truncated
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (sof) {
        if (length < 11) return undefined; // length + precision + h + w + components
        return { ext: "jpg", height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + length;
    }
    return undefined;
  }
  if (b.length >= 30 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    if (b.readUInt32LE(4) + 8 !== b.length) return undefined; // RIFF size must describe exactly this file
    const kind = b.subarray(12, 16).toString("latin1");
    const chunk = b.readUInt32LE(16);
    if (20 + chunk > b.length) return undefined;
    if (kind === "VP8 " && chunk >= 10 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { ext: "webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    }
    if (kind === "VP8L" && chunk >= 5 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { ext: "webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X" && chunk >= 10) {
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

export interface FoundAvatar { path: string; ext: AvatarExt; mtimeMs: number }

/**
 * In-memory index of the avatars dir: team-key hash -> every stored copy (normally one). Built once from disk, then
 * kept current by save / remove, so the public GET (and every avatarUrl lookup) never touches the disk to say "none".
 * A copy can outlive an ownership change in the old owner's folder; save and remove prune all of a team's copies.
 */
export class AvatarStore {
  readonly ready: Promise<void>;
  private readonly copies = new Map<string, Array<FoundAvatar & { folder: string }>>();

  constructor(readonly dir: string) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    let folders: string[] = [];
    try { folders = (await fsp.readdir(this.dir)).filter((n) => /^[a-f0-9]{64}$/.test(n)); } catch { return; }
    for (const folder of folders) {
      let names: string[] = [];
      try { names = await fsp.readdir(join(this.dir, folder)); } catch { continue; }
      for (const name of names) {
        const m = /^([a-f0-9]{64})\.(png|jpg|webp)$/.exec(name);
        if (!m) continue;
        const path = join(this.dir, folder, name);
        try {
          const st = await fsp.stat(path);
          if (st.isFile()) this.add(m[1]!, { path, ext: m[2] as AvatarExt, mtimeMs: st.mtimeMs, folder });
        } catch { /* gone */ }
      }
    }
  }

  private add(hash: string, copy: FoundAvatar & { folder: string }): void {
    const list = this.copies.get(hash) ?? [];
    list.push(copy);
    this.copies.set(hash, list);
  }

  /** The stored avatar for a team: the newest copy. Memory only. */
  find(teamKey: string): FoundAvatar | undefined {
    const list = this.copies.get(sha(teamKey));
    if (!list?.length) return undefined;
    const best = list.reduce((a, c) => (c.mtimeMs > a.mtimeMs ? c : a));
    return { path: best.path, ext: best.ext, mtimeMs: best.mtimeMs };
  }

  url(ref: string | undefined): string | undefined {
    const key = ref ? canonicalTeamKey(ref) : undefined;
    const found = key ? this.find(key) : undefined;
    return key && found ? `/api/fork/teams/${encodeURIComponent(key)}/avatar?v=${Math.floor(found.mtimeMs)}` : undefined;
  }

  private async prune(hash: string): Promise<void> {
    for (const copy of this.copies.get(hash) ?? []) {
      try { await fsp.unlink(copy.path); } catch { /* already gone */ }
    }
    this.copies.delete(hash);
  }

  /** Store (atomically) as the caller's copy, replacing every other copy of this team in any folder or extension. */
  async save(coach: string, teamKey: string, bytes: Buffer, ext: AvatarExt): Promise<void> {
    await this.ready;
    const hash = sha(teamKey);
    const folder = sha(coach);
    const dir = join(this.dir, folder);
    await fsp.mkdir(dir, { recursive: true });
    const target = join(dir, `${hash}.${ext}`);
    const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      // Drop the previous copies (other extension / other owner folder) but never the file about to be replaced.
      for (const copy of this.copies.get(hash) ?? []) {
        if (copy.path === target) continue;
        try { await fsp.unlink(copy.path); } catch { /* already gone */ }
      }
      await fsp.rename(temp, target);
    } catch (error) {
      try { await fsp.unlink(temp); } catch { /* none */ }
      throw error;
    }
    const st = await fsp.stat(target);
    this.copies.set(hash, [{ path: target, ext, mtimeMs: st.mtimeMs, folder }]);
  }

  /** Remove every copy of the team's avatar (the route has already proven the caller owns the team). */
  async remove(teamKey: string): Promise<boolean> {
    await this.ready;
    const hash = sha(teamKey);
    const had = (this.copies.get(hash)?.length ?? 0) > 0;
    await this.prune(hash);
    return had;
  }
}

const stores = new Map<string, AvatarStore>();
/** One store (and index) per avatars directory. */
export function avatarStoreFor(dir: string): AvatarStore {
  let store = stores.get(dir);
  if (!store) { store = new AvatarStore(dir); stores.set(dir, store); }
  return store;
}

/** The public read URL (versioned so a replaced image is not served stale), or undefined when none is stored. */
export function avatarUrlFor(dir: string | undefined, ref: string | undefined): string | undefined {
  return dir ? avatarStoreFor(dir).url(ref) : undefined;
}

/**
 * Raw request body, capped. Resolves undefined as soon as the streamed body passes `max` (it stops reading at once;
 * the caller answers 413 and then destroys the request) rather than draining a hostile upload to EOF.
 */
export function readRawCapped(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const detach = (): void => { req.off("data", onData); req.off("end", onEnd); req.off("error", onError); };
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.length;
      if (length > max) { req.pause(); detach(); resolve(undefined); return; }
      chunks.push(buffer);
    };
    const onEnd = (): void => { detach(); resolve(Buffer.concat(chunks)); };
    const onError = (error: Error): void => { detach(); reject(error); };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
}

/** True when a declared Content-Length already exceeds the cap (answer 413 before reading anything). */
export function declaredTooLarge(req: IncomingMessage, max: number): boolean {
  const n = Number(req.headers["content-length"]);
  return Number.isFinite(n) && n > max;
}

const uploads = new Map<string, number[]>();
/** 10 changes per minute per coach (PUT and DELETE share it). Returns the seconds to wait, or 0 when allowed (and counts this one). */
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
/** Drop buckets with no change in the last minute (idle coaches no longer cost memory). */
export function sweepAvatarRateLimit(now = Date.now()): number {
  let dropped = 0;
  for (const [coach, times] of uploads) {
    if (!times.some((t) => now - t < 60_000)) { uploads.delete(coach); dropped += 1; }
  }
  return dropped;
}
export const avatarRateBuckets = (): number => uploads.size;
export const resetAvatarRateLimit = (): void => uploads.clear();
setInterval(() => sweepAvatarRateLimit(), 10 * 60 * 1000).unref();
