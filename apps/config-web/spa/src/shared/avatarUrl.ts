// Coach avatar URLs a result card may load (owner 10-31): https on cdn.discordapp.com (the Discord avatar Discord already
// serves publicly), or the site's own coach-avatar route. The server applies the same list (src/coachAvatars.ts
// isAllowedCardAvatarUrl); anything else is "" and the card shows the letter badge.

import { reactive } from "vue";

/** Coach avatars: https on cdn.discordapp.com, or the site's own coach-avatar route (the server applies the same list). */
export const avatarSrc = (url: string | null | undefined): string => {
  const u = typeof url === "string" ? url.trim() : "";
  if (/^\/api\/coach-avatars\/[^/?#\\]+(\?v=\d+)?$/.test(u)) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" && parsed.hostname === "cdn.discordapp.com" && !parsed.username && !parsed.password && !parsed.port ? u : "";
  } catch {
    return "";
  }
};

/** Per-card memory of avatar URLs that failed to load (the img's error event): a failed URL shows the letter badge,
 *  which carries data-avatar-fallback="error" so the swap is visible in the markup. Reactive; no DOM needed. */
export function createAvatarFallback() {
  const failed = reactive(new Set<string>());
  return {
    /** The src to render, or "" for the letter badge (not allow-listed, missing, or already failed). */
    shown(url: string | null | undefined): string {
      const src = avatarSrc(url);
      return src && !failed.has(src) ? src : "";
    },
    /** "error" when the side has an allowed avatar that failed to load (the badge's marker), else undefined. */
    marker(url: string | null | undefined): "error" | undefined {
      const src = avatarSrc(url);
      return src && failed.has(src) ? "error" : undefined;
    },
    fail(url: string | null | undefined): void {
      const src = avatarSrc(url);
      if (src) failed.add(src);
    },
  };
}
