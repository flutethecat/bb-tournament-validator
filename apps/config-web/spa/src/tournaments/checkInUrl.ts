// The absolute link a QR check-in code opens (personal and venue). The server sends the site's public origin
// (PUBLIC_BASE_URL, validated at startup) beside the code's path; this page's own origin is only the fallback, so a host
// opened as 127.0.0.1 still hands phones the public address. The token stays in the path, as the server built it.

/** An http(s) origin and nothing else (a bad value from the server is ignored, like an unset one). */
function originOf(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  try {
    const u = new URL(raw);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash) return u.origin;
  } catch { /* invalid */ }
  return undefined;
}

/** localhost, *.localhost, 127.x.x.x or [::1]: a phone can't open it. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || /^127(\.\d{1,3}){3}$/.test(host) || host === "[::1]" || host === "::1";
  } catch { return false; }
}

export const LOOPBACK_WARNING = "This code points at this computer; set PUBLIC_BASE_URL so phones can open it.";

export interface CheckInLink { url: string; loopback: boolean }

/** The code's URL: the public origin when the server sent one, else `here` (this page's origin; "" while server-rendering).
 *  `loopback` = the fallback points at this computer (the organisers' warning). */
export function checkInLink(path: string | undefined, publicOrigin: unknown, here: string = typeof window !== "undefined" ? window.location.origin : ""): CheckInLink {
  if (!path) return { url: "", loopback: false };
  const origin = originOf(publicOrigin);
  if (origin) return { url: `${origin}${path}`, loopback: false };
  return { url: `${here}${path}`, loopback: Boolean(here) && isLoopbackOrigin(here) };
}
