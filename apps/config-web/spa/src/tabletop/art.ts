// Crest lookup over the builder-art manifest (/crests/manifest.json). Same resolution as the Team Builder page
// (public/team-builder.js resolveCrest): race key, letters only, present in the manifest.

export interface ArtManifests {
  crests?: { crests?: Record<string, string> };
}

const normalizeKey = (value: unknown): string => String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export function rosterRaceKey(race: unknown): string {
  const key = normalizeKey(race);
  return key.replace(/^(?:bb\d{4}|bb\d|crp|lrb\d|ffb|20\d{2})+/, "").replace(/(?:bb\d{4}|bb\d|crp|lrb\d|20\d{2})+$/, "") || key;
}

/** Crest path (from the site root) for a race, only when the crest manifest lists it. */
export function resolveCrest(art: ArtManifests, race: unknown): string {
  const key = rosterRaceKey(race).replace(/[^a-z]/g, "");
  const p = key ? art.crests?.crests?.[key] : undefined;
  return p ? `/${p}` : "";
}
