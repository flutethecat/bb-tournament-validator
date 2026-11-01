/**
 * Anonymisation of public history (privacy spec §3.5, owner 10-31: "anonymise, don't erase").
 *
 * A deleted coach's name becomes a stable pseudonym ("Deleted coach #<n>") everywhere a store records it as a coach:
 * any string value that EQUALS one of the coach's names (case-insensitive, trimmed, NFC), any object key that equals one
 * (maps keyed by coach), and every element of a string array. Free-text fields (titles, bodies, team and player names,
 * ids/slugs) are never touched by the value rule: a team called like its coach keeps its name. In an object where a coach
 * field was replaced, the sibling fields that would re-identify the person (Discord ids, email, NAF user) are removed.
 *
 * A value written all in lower case (a normalised key such as "coachid") gets the lower-case pseudonym, so lookups that
 * fold case keep matching each other.
 */

export const nameKey = (value: string): string => value.normalize("NFC").trim().toLowerCase();

/** Keys whose string values are never compared against the coach's names (free text, names of things, ids). */
const SKIP_VALUE_KEYS = new Set([
  "name", "teamName", "team", "title", "body", "summary", "notes", "note", "description", "text", "message", "reason",
  "race", "id", "teamId", "packageName", "player", "fullName", "slug", "venue", "address", "mapUrl", "link", "gameId",
  "logoPath", "bannerPath", "rosterName", "position", "skills", "status", "kind", "type",
]);

/** Fields dropped from an object once one of its coach fields was anonymised. */
const RE_IDENTIFYING = ["discordUserId", "discordUsername", "discordAvatarHash", "email", "secondaryEmail", "nafUser", "nafName", "nafId"];

export interface Anonymiser {
  /** Returns the anonymised copy and whether anything changed. Never mutates the input. */
  apply<T>(value: T): { value: T; changed: boolean };
  /** Word-boundary replacement of the coach's names inside free text (notifications of other coaches). */
  text(value: string): string;
  readonly pseudonym: string;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createAnonymiser(aliases: readonly string[], pseudonym: string): Anonymiser {
  const keys = new Set(aliases.map(nameKey).filter((k) => k.length > 0));
  const lower = pseudonym.toLowerCase();
  const swap = (original: string): string => (original === original.toLowerCase() && original !== original.toUpperCase() ? lower : pseudonym);
  const matches = (s: string): boolean => keys.has(nameKey(s));
  // Longest first so "Bob Smith" wins over "Bob".
  const textRes = [...keys].sort((a, b) => b.length - a.length).map((k) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(k)}(?![\\p{L}\\p{N}_])`, "giu"));

  const walk = (value: unknown, parentKey: string | undefined, state: { changed: boolean }): unknown => {
    if (typeof value === "string") {
      if (parentKey !== undefined && SKIP_VALUE_KEYS.has(parentKey)) return value;
      if (matches(value)) { state.changed = true; return swap(value); }
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => walk(item, parentKey, state));
    if (!value || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    let replacedHere = false;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const before = state.changed;
      state.changed = false;
      const next = walk(v, k, state);
      if (state.changed && typeof v === "string") replacedHere = true;
      if (state.changed && Array.isArray(v) && v.some((x) => typeof x === "string" && matches(x))) replacedHere = true;
      state.changed = state.changed || before;
      let key = k;
      if (matches(k)) { key = swap(k); state.changed = true; }
      out[key] = next;
    }
    if (replacedHere) {
      for (const field of RE_IDENTIFYING) if (Object.hasOwn(out, field)) { delete out[field]; state.changed = true; }
    }
    return out;
  };

  return {
    pseudonym,
    apply<T>(value: T): { value: T; changed: boolean } {
      const state = { changed: false };
      const next = walk(value, undefined, state) as T;
      return { value: next, changed: state.changed };
    },
    text(value: string): string {
      let out = value;
      for (const re of textRes) out = out.replace(re, pseudonym);
      return out;
    },
  };
}
