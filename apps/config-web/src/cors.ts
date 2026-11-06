/**
 * SR-260 ④: explicit-allowlist CORS, replacing the old `access-control-allow-origin: *`.
 * No-Origin callers (curl, the fork's Java client) pass untouched; a browser Origin passes only
 * when it is same-origin, a FUMBBL40k app WebView origin, or on the env allowlist.
 * 08-18 live finding: Tauri v2 plugin-http DOES send the WebView origin (the original "tauriFetch
 * sends no Origin" premise was wrong — the packaged app 403'd on /api/*), so the app's own known
 * origins are allowlisted by default, still explicit, never a wildcard.
 */

/** The FUMBBL40k desktop app's WebView origins (Windows WebView2 + macOS WKWebView schemes).
 *  Owner 10-01: Super FUMBBL 1.0.31+ serves its page through its own `sfapp` scheme (the app-patch channel), so the
 *  WebView origin became `http://sfapp.localhost` (WebView2) / `sfapp://localhost` (WKWebView, WebKitGTK) — the
 *  public client's bug reports 403'd on the preflight until these were added. The old tauri origins stay for 1.0.30-. */
export const APP_WEBVIEW_ORIGINS = [
  "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost",
  "http://sfapp.localhost", "https://sfapp.localhost", "sfapp://localhost",
];

/** Parse CORS_ALLOWED_ORIGINS (comma-separated origins) into a normalized set. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    [...APP_WEBVIEW_ORIGINS, ...(raw ?? "").split(",")]
      .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  );
}

/** Owner 11-06 (Linux bug report "Origin not allowed"): Tauri plugin-http writes the Origin from the page URL, and the
 *  url crate serializes a custom scheme other than `tauri` (sfapp://localhost on WebKitGTK / WKWebView) as the opaque
 *  origin "null", so every Linux / macOS request from the patched app arrives as `Origin: null`. Sandboxed iframes,
 *  file: and data: pages send "null" too, so it is accepted ONLY on a request that carries no ambient browser
 *  credential: no Cookie header (the session / Discord cookies) and no Basic Authorization (a browser replays a cached
 *  admin login on a form post; Sol 11-06 HIGH). The app authenticates with Bearer tokens or credentials in the body.
 *  Never on the loopback-gated test-login routes (Sol 11-06 LOW). Drop once the shell sends its real origin and the
 *  old shells are gone. */
export const NULL_ORIGIN_BLOCKED_PREFIXES = ["/api/auth/test-login"];

export function nullOriginEligible(headers: { cookie?: string; authorization?: string }, pathname: string): boolean {
  if (headers.cookie) return false;
  if (/^\s*basic\s/i.test(headers.authorization ?? "")) return false;
  return !NULL_ORIGIN_BLOCKED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export type CorsDecision =
  | { kind: "no-origin" } // non-browser caller — no CORS headers needed
  | { kind: "allowed"; origin: string } // reflect THIS origin (never *)
  | { kind: "denied" };

export function corsDecision(
  origin: string | undefined,
  host: string | undefined,
  allowlist: Set<string>,
  opts: { allowNullOrigin?: boolean } = {},
): CorsDecision {
  if (!origin) return { kind: "no-origin" };
  const normalized = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (normalized === "null") return opts.allowNullOrigin ? { kind: "allowed", origin } : { kind: "denied" };
  if (allowlist.has(normalized)) return { kind: "allowed", origin };
  // Same-origin: the page came from THIS server (config-web's own frontend).
  try {
    if (host && new URL(normalized).host === host.trim().toLowerCase()) return { kind: "allowed", origin };
  } catch {
    // malformed Origin ⇒ denied
  }
  return { kind: "denied" };
}
