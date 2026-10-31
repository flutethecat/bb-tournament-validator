// Coach avatar URLs a result card may load (owner 10-31): only the site's own coach-avatar route with its version token.
// A Discord CDN URL is never accepted on a card: the server proxies the Discord fallback through the same route
// (src/coachAvatars.ts isAllowedCardAvatarUrl). Anything else is "" and the card shows the letter badge.

import { reactive } from "vue";

/** The site's own coach-avatar route (`/api/coach-avatars/<coach>?v=<16 hex>`), else "". */
export const avatarSrc = (url: string | null | undefined): string => {
  const u = typeof url === "string" ? url.trim() : "";
  return u.length <= 512 && /^\/api\/coach-avatars\/[^/?#\\]+\?v=[a-f0-9]{16}$/.test(u) ? u : "";
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
