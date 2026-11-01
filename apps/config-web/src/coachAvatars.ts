/**
 * Coach avatars (owner 10-31: "Discord Avatars should be the fallback. Allow users to upload their own.").
 *
 * Display precedence, everywhere a coach avatar shows:
 *   1. the image the coach uploaded here,
 *   2. the avatar an admin set on the identity record (record.profile.avatar; only a cdn.discordapp.com https URL),
 *   3. the coach's Discord avatar,
 *   4. none: the client shows a letter badge.
 *
 * Privacy (review 10-31): a PUBLIC response never carries a Discord CDN URL (it would map coach names to Discord user
 * ids). Every public avatarUrl is this site's own route, /api/coach-avatars/<coach>?v=<token>, and that route serves
 * the upload, else PROXIES the admin-set or Discord image (fetched server-side at 64 px, short timeout, size cap,
 * content-type and magic-byte checks, cached in memory and on disk for 24 h; a changed avatar hash is a new cache key),
 * else 404. `v` is a hash of (source + version), never the Discord hash itself. Only the signed-in owner's account page
 * shows the raw Discord URL (src/accountProfile.ts).
 *
 * Eligibility (cards and the public GET alike, checked on every request from memory): the coach has an identity record
 * and is not banned. A removed or merged-away identity is not eligible, and its upload is deleted when the identities
 * write that removed it lands (onIdentitiesWritten).
 *
 * Storage reuses the team-avatar store and checks (src/teamAvatars.ts): <dir>/<sha256(id)>/<sha256("coach:<id>")>.<ext>;
 * the proxy cache lives in <dir>/proxy-cache/<sha256(source url)>.<ext>.
 *
 * Coach ids: coachAvatarId(name) = NFC + the identity store's case fold (normalizeFfbCoachId). The 40-character limit
 * applies to the ORIGINAL name (sessions and identity records); a folded id may be longer ("İ" folds to two code
 * units), so the route accepts ids up to 3x that and the identity lookup decides.
 */
import { createHash, randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import { join } from "node:path";
import { avatarStoreFor, sniffImage, AVATAR_CONTENT_TYPE, type AvatarExt, type AvatarStore } from "./teamAvatars.js";
import { normalizeFfbCoachId, readIdentities, MAX_FFB_COACH_ID_LENGTH, type IdentityStore } from "./auth/identitiesStore.js";

export const COACH_AVATAR_ROUTE = "/api/coach-avatars/";
export const OWN_AVATAR_PATH = "/api/me/avatar";
/** Longest folded id the route accepts (a 40-character name can fold to more code units). */
export const MAX_COACH_AVATAR_ID_LENGTH = MAX_FFB_COACH_ID_LENGTH * 3;

export type CoachAvatarSource = "upload" | "profile" | "discord" | "none";

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** One spelling of a coach for avatars: NFC, then the identity store's case fold. */
export const coachAvatarId = (coach: string): string => normalizeFfbCoachId(coach.normalize("NFC"));
/** The upload store key for a coach. */
export const coachAvatarKey = (coach: string): string => `coach:${coachAvatarId(coach)}`;

/** `/api/coach-avatars/<id>` -> the folded coach id, or undefined. */
export function coachAvatarPath(pathname: string): string | undefined {
  if (!pathname.startsWith(COACH_AVATAR_ROUTE)) return undefined;
  const raw = pathname.slice(COACH_AVATAR_ROUTE.length);
  if (!raw || raw.includes("/")) return undefined;
  let coach: string;
  try { coach = decodeURIComponent(raw); } catch { return undefined; }
  const id = coachAvatarId(coach);
  if (!id || id.length > MAX_COACH_AVATAR_ID_LENGTH || /[\u0000-\u001f\u007f/\\]/.test(id)) return undefined;
  return id;
}

export const coachAvatarStore = (dir: string): AvatarStore => avatarStoreFor(dir);

/** The URLs a public card may carry: this site's own coach-avatar route only. */
export function isAllowedCardAvatarUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 512 && /^\/api\/coach-avatars\/[^/?#\\]+\?v=[a-f0-9]{16}$/.test(url);
}

/** Images the server may fetch for the proxy: https cdn.discordapp.com only. */
export function isProxyableAvatarUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url || url.length > 512) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "cdn.discordapp.com" && !u.username && !u.password && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}

/** The shown avatar and where it came from, in the precedence above. Empty / missing values fall through. */
export function resolveCoachAvatar<T extends string>(sources: { upload?: T | null; profile?: T | null; discord?: T | null }): { url: T | null; source: CoachAvatarSource } {
  if (sources.upload) return { url: sources.upload, source: "upload" };
  if (sources.profile) return { url: sources.profile, source: "profile" };
  if (sources.discord) return { url: sources.discord, source: "discord" };
  return { url: null, source: "none" };
}

/** A Discord CDN avatar as a 64 px PNG (an animated "a_" hash is served as a still PNG too). */
export function smallDiscordAvatar(url: string | undefined, size = 64): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.discordapp.com") return undefined;
    u.pathname = u.pathname.replace(/\.(gif|webp|jpe?g)$/i, ".png");
    u.search = "";
    u.searchParams.set("size", String(size));
    return u.toString();
  } catch {
    return undefined;
  }
}

/** The public route URL for a coach and a resolved source. */
export const coachAvatarRouteUrl = (id: string, source: CoachAvatarSource, version: string): string =>
  `${COACH_AVATAR_ROUTE}${encodeURIComponent(id)}?v=${sha(`${source}:${version}`).slice(0, 16)}`;

// ---- proxy ----------------------------------------------------------------------------------------------------

export const PROXY_MAX_BYTES = 256 * 1024;
export const PROXY_TIMEOUT_MS = 4000;
export const PROXY_TTL_MS = 24 * 60 * 60 * 1000;
const PROXY_MEMORY_MAX = 300;

export interface ProxiedImage { bytes: Buffer; ext: AvatarExt; contentType: string }
export type AvatarFetch = (url: string, init: { signal: AbortSignal; redirect: "error" }) => Promise<Response>;

/** Fetches allow-listed avatar images server-side and caches them (memory, then disk) for 24 h. */
export class AvatarProxy {
  private readonly memory = new Map<string, { at: number; image: ProxiedImage }>();
  private readonly inflight = new Map<string, Promise<ProxiedImage | undefined>>();

  constructor(readonly dir: string, private readonly fetcher: AvatarFetch = (u, i) => fetch(u, i), private readonly now: () => number = Date.now) {}

  async get(url: string): Promise<ProxiedImage | undefined> {
    if (!isProxyableAvatarUrl(url)) return undefined;
    const key = sha(url);
    const hit = this.memory.get(key);
    if (hit && this.now() - hit.at < PROXY_TTL_MS) return hit.image;
    const running = this.inflight.get(key);
    if (running) return running;
    const job = this.load(key, url).finally(() => this.inflight.delete(key));
    this.inflight.set(key, job);
    return job;
  }

  private remember(key: string, at: number, image: ProxiedImage): void {
    this.memory.delete(key);
    this.memory.set(key, { at, image });
    while (this.memory.size > PROXY_MEMORY_MAX) this.memory.delete(this.memory.keys().next().value!);
  }

  private async load(key: string, url: string): Promise<ProxiedImage | undefined> {
    // disk cache
    for (const ext of ["png", "jpg", "webp"] as AvatarExt[]) {
      const path = join(this.dir, `${key}.${ext}`);
      try {
        const st = await fsp.stat(path);
        if (this.now() - st.mtimeMs >= PROXY_TTL_MS) continue;
        const bytes = await fsp.readFile(path);
        const image = { bytes, ext, contentType: AVATAR_CONTENT_TYPE[ext] };
        this.remember(key, st.mtimeMs, image);
        return image;
      } catch { /* not cached */ }
    }
    let res: Response;
    try {
      res = await this.fetcher(url, { signal: AbortSignal.timeout(PROXY_TIMEOUT_MS), redirect: "error" });
    } catch {
      return undefined;
    }
    if (!res.ok) return undefined;
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (!["image/png", "image/jpeg", "image/webp"].includes(type)) return undefined;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > PROXY_MAX_BYTES) return undefined;
    const bytes = await readCapped(res, PROXY_MAX_BYTES);
    if (!bytes) return undefined;
    const sniffed = sniffImage(bytes);
    if (!sniffed || AVATAR_CONTENT_TYPE[sniffed.ext] !== type) return undefined;
    const image = { bytes, ext: sniffed.ext, contentType: type };
    this.remember(key, this.now(), image);
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      const target = join(this.dir, `${key}.${sniffed.ext}`);
      const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      await fsp.writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
      await fsp.rename(temp, target);
    } catch { /* memory copy still serves */ }
    return image;
  }
}

async function readCapped(res: Response, max: number): Promise<Buffer | undefined> {
  if (!res.body) {
    const all = Buffer.from(await res.arrayBuffer());
    return all.length > max ? undefined : all;
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > max) { await reader.cancel().catch(() => undefined); return undefined; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// ---- resolver -------------------------------------------------------------------------------------------------

interface Entry { banned: boolean; profile?: string; discord?: string; discordHash?: string }

export interface CoachAvatarResolverDeps {
  /** The coach-avatars directory (uploads; the proxy cache sits in its proxy-cache folder). */
  dir: string;
  /** Discord CDN URL builder (src/auth/discordSso.ts discordAvatarUrl). */
  discordAvatarUrl: (discordUserId: string, hash: string | undefined) => string | null | undefined;
  /** Identities snapshot source; defaults to the identities store. */
  readIdentities?: () => IdentityStore;
  /** How long one identities snapshot is reused when no in-process write invalidated it (ms). */
  ttlMs?: number;
  now?: () => number;
  fetcher?: AvatarFetch;
}

export interface ResolvedCoachAvatar { source: Exclude<CoachAvatarSource, "none">; url: string; version: string }

/**
 * Coach name -> public avatar route URL (or undefined), and the route's image. Memory only per request: the upload
 * index (AvatarStore) and an identities snapshot (re-read at most once per TTL, and at once after a write in this
 * process). Until the upload index has loaded, nothing resolves (never a lower source by mistake): await `ready`.
 */
export function createCoachAvatarResolver(deps: CoachAvatarResolverDeps) {
  const read = deps.readIdentities ?? readIdentities;
  const ttl = deps.ttlMs ?? 30_000;
  const now = deps.now ?? Date.now;
  const uploads = avatarStoreFor(deps.dir);
  const proxy = new AvatarProxy(join(deps.dir, "proxy-cache"), deps.fetcher, now);
  let loaded = false;
  let snapshot: { at: number; byId: Map<string, Entry> } | undefined;
  /** The ids of the last identities read (kept across invalidate()), to spot identities a write removed. */
  let knownIds: Set<string> | undefined;

  const build = (store: IdentityStore): Map<string, Entry> => {
    const byId = new Map<string, Entry>();
    for (const record of Object.values(store.coaches)) {
      const id = coachAvatarId(record.ffbCoachId);
      const profile = isProxyableAvatarUrl(record.profile?.avatar) ? record.profile.avatar : undefined;
      const hash = record.identities?.discordAvatarHash;
      const discord = smallDiscordAvatar(deps.discordAvatarUrl(record.identities?.discordUserId ?? "", hash) || undefined);
      byId.set(id, { banned: record.banned === true, ...(profile ? { profile } : {}), ...(discord ? { discord, discordHash: hash } : {}) });
    }
    return byId;
  };
  const index = (): Map<string, Entry> => {
    const t = now();
    if (snapshot && t - snapshot.at < ttl) return snapshot.byId;
    let store: IdentityStore;
    try { store = read(); } catch { store = { version: 1, coaches: {} }; }
    snapshot = { at: t, byId: build(store) };
    knownIds = new Set(snapshot.byId.keys());
    return snapshot.byId;
  };

  // Ready = the upload index is loaded and a first identities snapshot is taken (so a later write can tell which
  // identities it removed).
  const ready = uploads.ready.then(() => { index(); loaded = true; });

  /** The eligible coach's best source, or undefined (not loaded yet, no identity, banned, or nothing to show). */
  function resolve(coach: string | undefined): (ResolvedCoachAvatar & { id: string }) | undefined {
    if (!loaded) return undefined;
    const id = typeof coach === "string" ? coachAvatarId(coach.trim()) : "";
    if (!id || id.length > MAX_COACH_AVATAR_ID_LENGTH) return undefined;
    const entry = index().get(id);
    if (!entry || entry.banned) return undefined;
    const found = uploads.find(`coach:${id}`);
    if (found) return { id, source: "upload", url: "", version: String(Math.floor(found.mtimeMs)) };
    if (entry.profile) return { id, source: "profile", url: entry.profile, version: entry.profile };
    if (entry.discord) return { id, source: "discord", url: entry.discord, version: entry.discordHash ?? entry.discord };
    return undefined;
  }

  return {
    ready,
    /** The public avatarUrl for a card (always the site's own route), or undefined (letter badge). */
    avatarFor(coach: string | undefined): string | undefined {
      const r = resolve(coach);
      return r ? coachAvatarRouteUrl(r.id, r.source, r.version) : undefined;
    },
    /** The image the public route serves for a folded coach id, or undefined (404). Eligibility is checked here. */
    async image(id: string): Promise<ProxiedImage | undefined> {
      await ready;
      const r = resolve(id);
      if (!r) return undefined;
      if (r.source === "upload") {
        const found = uploads.find(`coach:${r.id}`);
        if (!found) return undefined;
        try { return { bytes: await fsp.readFile(found.path), ext: found.ext, contentType: AVATAR_CONTENT_TYPE[found.ext] }; } catch { return undefined; }
      }
      const proxied = await proxy.get(r.url);
      if (proxied || r.source !== "profile") return proxied;
      // an admin-set image that cannot be fetched falls back to Discord
      const entry = index().get(r.id);
      return entry?.discord ? proxy.get(entry.discord) : undefined;
    },
    /** True when the coach may have an avatar shown (identity exists, not banned). */
    eligible(coach: string): boolean {
      const entry = index().get(coachAvatarId(coach.trim()));
      return Boolean(entry && !entry.banned);
    },
    /** Drop the identities snapshot (re-read on the next lookup). */
    invalidate(): void { snapshot = undefined; },
    /**
     * After an identities write in this process: adopt the written store at once, and delete the uploads of identities
     * that are gone (removed or merged away), so they are never published again.
     */
    async identitiesWritten(store: IdentityStore): Promise<void> {
      const before = knownIds ?? new Set<string>();
      const after = build(store);
      snapshot = { at: now(), byId: after };
      knownIds = new Set(after.keys());
      await ready;
      for (const id of before) if (!after.has(id)) await uploads.remove(`coach:${id}`).catch(() => false);
    },
  };
}

export type CoachAvatarResolver = ReturnType<typeof createCoachAvatarResolver>;

interface SideWithCoach { coach: string; avatarUrl?: string | null }

/** A card (home/away sides with a coach name) with each side's avatarUrl filled in; sides without one carry none. */
export function withSideAvatars<T extends { home: SideWithCoach; away: SideWithCoach }>(card: T, avatarFor: (coach: string) => string | undefined): T {
  const side = <S extends SideWithCoach>(s: S): S => {
    const { avatarUrl: _drop, ...rest } = s;
    const url = avatarFor(s.coach);
    return (url ? { ...rest, avatarUrl: url } : rest) as S;
  };
  return { ...card, home: side(card.home), away: side(card.away) };
}

/** The coach's own uploaded avatar URL (for the account page and the PUT answer), or undefined. Memory only. */
export function uploadedCoachAvatarUrl(dir: string | undefined, coach: string): string | undefined {
  if (!dir || !coach.trim()) return undefined;
  const found = avatarStoreFor(dir).find(coachAvatarKey(coach));
  return found ? coachAvatarRouteUrl(coachAvatarId(coach), "upload", String(Math.floor(found.mtimeMs))) : undefined;
}

/** The proxy-cache keys (sha256 of the fetched URL) of a coach's admin-set and Discord avatars: what deletion removes. */
export function coachProxyCacheKeys(
  record: { profile?: { avatar?: string }; identities?: { discordUserId?: string; discordAvatarHash?: string } } | undefined,
  discordAvatarUrl: (discordUserId: string, hash: string | undefined) => string | null | undefined,
): string[] {
  if (!record) return [];
  const urls = new Set<string>();
  if (isProxyableAvatarUrl(record.profile?.avatar)) urls.add(record.profile!.avatar!);
  const discord = smallDiscordAvatar(discordAvatarUrl(record.identities?.discordUserId ?? "", record.identities?.discordAvatarHash) || undefined);
  if (discord) urls.add(discord);
  return [...urls].map(sha);
}

/**
 * Account deletion: the coach's uploaded avatar (the same store and key the resolver drops when an identity goes away) and
 * the proxy-cache copies of their admin-set / Discord images. Idempotent.
 */
export async function deleteCoachAvatarData(dir: string, coach: string, proxyKeys: readonly string[]): Promise<void> {
  await avatarStoreFor(dir).remove(coachAvatarKey(coach));
  for (const key of proxyKeys) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue;
    for (const ext of ["png", "jpg", "webp"]) await fsp.unlink(join(dir, "proxy-cache", `${key}.${ext}`)).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  }
}
