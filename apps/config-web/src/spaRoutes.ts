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
