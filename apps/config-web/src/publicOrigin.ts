/**
 * The site's public origin (PUBLIC_BASE_URL, and the mail link base): an http(s) origin with no credentials, path, query
 * or hash. Anything else is ignored (undefined). The only source of absolute links the server hands out: never the
 * request's Host header.
 */
export function publicOriginOf(raw: string | undefined): string | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  try {
    const u = new URL(text);
    if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password && (u.pathname === "/" || u.pathname === "")
      && !u.search && !u.hash) return u.origin;
  } catch { /* invalid */ }
  return undefined;
}
