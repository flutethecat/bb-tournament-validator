/**
 * Coach avatars (owner 10-31: "Discord Avatars should be the fallback. Allow users to upload their own.").
 *
 * Display precedence, everywhere a coach avatar shows (account page, public result cards):
 *   1. the image the coach uploaded here,
 *   2. the avatar an admin set on the identity record (record.profile.avatar),
 *   3. the coach's Discord avatar (the public cdn.discordapp.com URL Discord already serves),
 *   4. none: the client shows a letter badge.
 *
 * Storage reuses the team-avatar store and checks (src/teamAvatars.ts: magic-byte sniff, size and pixel limits, atomic
 * sha-named files, in-memory index): <dir>/<sha256(coach)>/<sha256("coach:<coach>")>.<png|jpg|webp>, one file per coach.
 *
 * Routes (wired in server.ts):
 *   PUT    /api/me/avatar               raw image body, the session coach's own avatar
 *   DELETE /api/me/avatar               the session coach's own avatar
 *   GET    /api/coach-avatars/<coach>   public read (versioned ?v=<mtime> URL, cache-friendly)
 *
 * Result cards resolve avatars from memory only: the uploaded index (AvatarStore) and an identities snapshot that is
 * re-read at most once per TTL. Only coaches with a site identity (an identity record, or an upload, which needs a
 * session) get one; a FUMBBL-only name gets nothing and the card shows its letter badge. Card URLs pass an allow-list
 * (https cdn.discordapp.com, or this site's own coach-avatar route), so an admin-set avatar on another host is not
 * published on a card, and nothing but the avatar URL itself leaves the server.
 */
import { avatarStoreFor, type AvatarStore } from "./teamAvatars.js";
import { normalizeFfbCoachId, readIdentities, MAX_FFB_COACH_ID_LENGTH, type IdentityStore } from "./auth/identitiesStore.js";

export const COACH_AVATAR_ROUTE = "/api/coach-avatars/";
export const OWN_AVATAR_PATH = "/api/me/avatar";

export type CoachAvatarSource = "upload" | "profile" | "discord" | "none";

/** The store key for a coach: case-insensitive, like coach ids everywhere else. */
export const coachAvatarKey = (coach: string): string => `coach:${normalizeFfbCoachId(coach)}`;

/** `/api/coach-avatars/<coach>` -> the normalized coach id, or undefined. */
export function coachAvatarPath(pathname: string): string | undefined {
  if (!pathname.startsWith(COACH_AVATAR_ROUTE)) return undefined;
  const raw = pathname.slice(COACH_AVATAR_ROUTE.length);
  if (!raw || raw.includes("/")) return undefined;
  let coach: string;
  try { coach = decodeURIComponent(raw); } catch { return undefined; }
  const id = normalizeFfbCoachId(coach);
  if (!id || id.length > MAX_FFB_COACH_ID_LENGTH || /[\u0000-\u001f\u007f/\\]/.test(id)) return undefined;
  return id;
}

export const coachAvatarStore = (dir: string): AvatarStore => avatarStoreFor(dir);

/** The public, versioned URL of the coach's uploaded avatar, or undefined when none is stored. Memory only. */
export function uploadedCoachAvatarUrl(dir: string | undefined, coach: string): string | undefined {
  if (!dir || !coach.trim()) return undefined;
  const found = avatarStoreFor(dir).find(coachAvatarKey(coach));
  return found ? `${COACH_AVATAR_ROUTE}${encodeURIComponent(normalizeFfbCoachId(coach))}?v=${Math.floor(found.mtimeMs)}` : undefined;
}

/** The URLs a result card may carry: https on cdn.discordapp.com, or this site's own coach-avatar route. */
export function isAllowedCardAvatarUrl(url: unknown): url is string {
  if (typeof url !== "string" || !url || url.length > 512) return false;
  if (url.startsWith(COACH_AVATAR_ROUTE)) return /^\/api\/coach-avatars\/[^/?#\\]+(\?v=\d+)?$/.test(url);
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname === "cdn.discordapp.com" && !u.username && !u.password && (u.port === "" || u.port === "443");
  } catch {
    return false;
  }
}

/** The shown avatar and where it came from, in the precedence above. Empty / missing values fall through. */
export function resolveCoachAvatar(sources: { upload?: string | null; profile?: string | null; discord?: string | null }): { url: string | null; source: CoachAvatarSource } {
  if (sources.upload) return { url: sources.upload, source: "upload" };
  if (sources.profile) return { url: sources.profile, source: "profile" };
  if (sources.discord) return { url: sources.discord, source: "discord" };
  return { url: null, source: "none" };
}

/** A Discord CDN avatar sized for a small card circle (the account page keeps the 256 px URL). */
export function smallDiscordAvatar(url: string | undefined, size = 64): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (u.hostname !== "cdn.discordapp.com") return url;
    u.searchParams.set("size", String(size));
    return u.toString();
  } catch {
    return undefined;
  }
}

interface IdentityAvatarEntry { profile?: string; discord?: string; banned?: true }

export interface CoachAvatarResolverDeps {
  /** The coach-avatars directory (uploads). */
  dir: string | undefined;
  /** Discord CDN URL builder (src/auth/discordSso.ts discordAvatarUrl). */
  discordAvatarUrl: (discordUserId: string, hash: string | undefined) => string | null | undefined;
  /** Identities snapshot source; defaults to the identities store. */
  readIdentities?: () => IdentityStore;
  /** How long one identities snapshot is reused (ms). */
  ttlMs?: number;
  now?: () => number;
}

/**
 * Card avatar resolver: coach name -> allow-listed avatar URL, or undefined. The identities file is read at most once
 * per TTL (never per card), the upload index is memory, so a request costs no disk access.
 */
export function createCoachAvatarResolver(deps: CoachAvatarResolverDeps) {
  const read = deps.readIdentities ?? readIdentities;
  const ttl = deps.ttlMs ?? 30_000;
  const now = deps.now ?? Date.now;
  let snapshot: { at: number; byCoach: Map<string, IdentityAvatarEntry> } | undefined;

  const index = (): Map<string, IdentityAvatarEntry> => {
    const t = now();
    if (snapshot && t - snapshot.at < ttl) return snapshot.byCoach;
    const byCoach = new Map<string, IdentityAvatarEntry>();
    let store: IdentityStore;
    try { store = read(); } catch { store = { version: 1, coaches: {} }; }
    for (const [key, record] of Object.entries(store.coaches)) {
      if (record.banned) { byCoach.set(key, { banned: true }); continue; } // a banned coach keeps the letter badge
      const profile = typeof record.profile?.avatar === "string" && isAllowedCardAvatarUrl(record.profile.avatar) ? record.profile.avatar : undefined;
      const discordRaw = deps.discordAvatarUrl(record.identities?.discordUserId ?? "", record.identities?.discordAvatarHash) || undefined;
      const discord = smallDiscordAvatar(discordRaw);
      byCoach.set(key, { ...(profile ? { profile } : {}), ...(discord && isAllowedCardAvatarUrl(discord) ? { discord } : {}) });
    }
    snapshot = { at: t, byCoach };
    return byCoach;
  };

  return {
    /** The avatar a public card shows for this coach name, or undefined (letter badge). */
    avatarFor(coach: string | undefined): string | undefined {
      const name = typeof coach === "string" ? coach.trim() : "";
      if (!name || name.length > MAX_FFB_COACH_ID_LENGTH) return undefined;
      const key = normalizeFfbCoachId(name);
      const entry = index().get(key);
      if (entry?.banned) return undefined;
      const upload = uploadedCoachAvatarUrl(deps.dir, name);
      const { url } = resolveCoachAvatar({ upload, profile: entry?.profile, discord: entry?.discord });
      return url && isAllowedCardAvatarUrl(url) ? url : undefined;
    },
    /** Drop the identities snapshot (after an identity write in this process). */
    invalidate(): void { snapshot = undefined; },
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
