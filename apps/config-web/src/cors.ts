/**
 * SR-260 ④: explicit-allowlist CORS, replacing the old `access-control-allow-origin: *`.
 * No-Origin callers (curl, the Tauri client's plugin-http fetch, the fork's Java client) pass
 * untouched; a browser Origin passes only when it is same-origin or on the env allowlist.
 */

/** Parse CORS_ALLOWED_ORIGINS (comma-separated origins) into a normalized set. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
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
