/**
 * SR-260 ④: explicit-allowlist CORS, replacing the old `access-control-allow-origin: *`.
 * No-Origin callers (curl, the fork's Java client) pass untouched; a browser Origin passes only
 * when it is same-origin, a FUMBBL40k app WebView origin, or on the env allowlist.
 * 08-18 live finding: Tauri v2 plugin-http DOES send the WebView origin (the original "tauriFetch
 * sends no Origin" premise was wrong — the packaged app 403'd on /api/*), so the app's own known
 * origins are allowlisted by default, still explicit, never a wildcard.
 */

/** The FUMBBL40k desktop app's WebView origins (Windows WebView2 + macOS WKWebView schemes). */
export const APP_WEBVIEW_ORIGINS = ["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

/** Parse CORS_ALLOWED_ORIGINS (comma-separated origins) into a normalized set. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    [...APP_WEBVIEW_ORIGINS, ...(raw ?? "").split(",")]
      .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  );
}

export type CorsDecision =
  | { kind: "no-origin" } // non-browser caller — no CORS headers needed
  | { kind: "allowed"; origin: string } // reflect THIS origin (never *)
  | { kind: "denied" };

export function corsDecision(
  origin: string | undefined,
  host: string | undefined,
  allowlist: Set<string>,
): CorsDecision {
  if (!origin) return { kind: "no-origin" };
  const normalized = origin.trim().replace(/\/+$/, "").toLowerCase();
  if (allowlist.has(normalized)) return { kind: "allowed", origin };
  // Same-origin: the page came from THIS server (config-web's own frontend).
  try {
    if (host && new URL(normalized).host === host.trim().toLowerCase()) return { kind: "allowed", origin };
  } catch {
    // malformed Origin ⇒ denied
  }
  return { kind: "denied" };
}
