// Competition region (owner 11-04, round 2 item 7): an optional "where is it" for a league or a tournament, used by the
// global site search and its Region filter. A country (ISO 3166-1 alpha-2, from the shared country table) plus free text
// ("Pacific Northwest", "Greater Manchester"). There is no venue field and no map: a tournament's own Location (venue,
// address) stays a page field. Shared by the server (validation) and the SPA (the Region fields and the labels).

import { countryByCode } from "../auth/countries.js";

export const REGION_TEXT_MAX = 80;

export interface CompetitionRegion {
  /** ISO 3166-1 alpha-2 code from src/auth/countries.ts. */
  country?: string;
  /** Free text: a state, county, city or area. */
  text?: string;
}

export class RegionError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/**
 * A request's region: an object { country?, text? }, or null / "" / an empty object = clear (returns null). A country must
 * be a code from the country table; the text is trimmed, control characters dropped, at most REGION_TEXT_MAX characters.
 * Throws RegionError on anything else.
 */
export function parseCompetitionRegion(raw: unknown, field = "region"): CompetitionRegion | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RegionError("Region must be a country and a description.", field);
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => k !== "country" && k !== "text");
  if (extra) throw new RegionError(`Unknown region field: ${extra.slice(0, 40)}.`, `${field}.${extra.slice(0, 40)}`);
  const out: CompetitionRegion = {};
  if (r.country !== undefined && r.country !== null && r.country !== "") {
    if (typeof r.country !== "string") throw new RegionError("Pick a country from the list.", `${field}.country`);
    const code = r.country.trim().toUpperCase();
    if (!countryByCode(code)) throw new RegionError("Pick a country from the list.", `${field}.country`);
    out.country = code;
  }
  if (r.text !== undefined && r.text !== null) {
    if (typeof r.text !== "string") throw new RegionError("Region must be text.", `${field}.text`);
    const text = r.text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    if (text.length > REGION_TEXT_MAX) throw new RegionError(`Region must be at most ${REGION_TEXT_MAX} characters.`, `${field}.text`);
    if (text) out.text = text;
  }
  return out.country || out.text ? out : null;
}

/** A stored region as read (anything malformed is treated as absent). */
export function storedRegion(raw: unknown): CompetitionRegion | undefined {
  try { return parseCompetitionRegion(raw) ?? undefined; } catch { return undefined; }
}

/** "Pacific Northwest, United States", "United Kingdom", "Somewhere", or "". */
export function regionLabel(region: CompetitionRegion | null | undefined): string {
  if (!region) return "";
  const country = region.country ? countryByCode(region.country)?.name ?? "" : "";
  return [region.text ?? "", country].filter(Boolean).join(", ");
}

/** The request value for a form's country + text pair (null = clear). */
export function regionFromForm(country: string, text: string): CompetitionRegion | null {
  const c = country.trim();
  const t = text.trim().replace(/\s+/g, " ");
  return c || t ? { ...(c ? { country: c } : {}), ...(t ? { text: t } : {}) } : null;
}
