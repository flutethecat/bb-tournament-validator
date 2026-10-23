/**
 * Generated team-builder art (public/sprites/** portraits, public/crests/** team crests, public/icons/** inducement icons, public/sounds/** recorder cues (host-only, gitignored) — see their
 * README.md). Public like the builder pages. Only plain lower-case segments and the generated file
 * types (PNG art + JSON manifests) match, so no dot-segments, encodings or other public files ride along.
 */
export function isPublicArtPath(pathname: string): boolean {
  return /^\/(?:sprites|crests|icons|sounds)\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:png|json|wav|mp3|ogg)$/.test(pathname);
}
