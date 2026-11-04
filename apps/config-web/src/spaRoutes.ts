import { join, resolve } from "node:path";

// The League & Tournament Manager SPA mount (/app, Vite build output in public/app/). Public static like /lobby/ in
// both auth modes: every API call the SPA makes gates itself.

export function isSpaPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/");
}

/** History fallback: an SPA route (no file extension, not under /app/assets/) is answered with /app/index.html. */
export function spaFallback(pathname: string): boolean {
  if (!isSpaPath(pathname) || pathname.startsWith("/app/assets/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return !last.includes(".");
}

/**
 * Where an /app request is served from: the SPA build directory (SPA_DIST_DIR, default <public>/app) and the file
 * inside it (SPA routes -> /index.html). undefined for any other path.
 */
export function spaStaticPath(pathname: string, publicDir: string): { root: string; rel: string } | undefined {
  if (!isSpaPath(pathname)) return undefined;
  const root = resolve(process.env.SPA_DIST_DIR || join(publicDir, "app"));
  const rel = spaFallback(pathname) ? "/index.html" : pathname.slice("/app".length);
  return { root, rel };
}

/** A QR check-in page: its token is in the path (src/tournaments/checkInQr.ts). */
const CHECK_IN_PAGE = /^\/app\/tournaments\/[^/]+\/check-in\/[^/]+\/?$/;

/**
 * Extra headers for an SPA page response. A check-in page carries its token in the URL, so the document itself says
 * Referrer-Policy: no-referrer (no asset, API call or link from it ever sends that URL as the Referer, from the very first
 * request) and is never cached.
 */
export function spaPageHeaders(pathname: string): Record<string, string> {
  return CHECK_IN_PAGE.test(pathname) ? { "referrer-policy": "no-referrer", "cache-control": "no-store" } : {};
}
