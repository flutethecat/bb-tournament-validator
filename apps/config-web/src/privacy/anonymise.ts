/**
 * Anonymisation of public history (privacy spec §3.5, owner 10-31: "anonymise, don't erase").
 *
 * The anonymiser never walks a document blindly and never renames object keys on its own: each store's step
 * (src/privacy/collectors.ts) names the exact fields that hold a coach (coach, coachId, by, owner, home/away coach, ...),
 * and only those values are compared and replaced. Free text that a step names (news, logs, notification titles) gets
 * whole-word replacement of the coach's names.
 *
 * Matching uses EXACTLY the identity store's key function (trim + lower case; src/privacy/fence.ts coachKey), never a
 * broader normalisation, so two accounts the identity store keeps apart are never merged here.
 *
 * A value written all in lower case (a normalised key such as a coach id) gets the lower-case pseudonym, so lookups that
 * fold case keep matching each other.
 */
import { coachKey } from "./fence.js";

export const nameKey = coachKey;

/** Dropped from an object once one of its coach fields was anonymised (they would re-identify the person). */
export const RE_IDENTIFYING = ["discordUserId", "discordUsername", "discordAvatarHash", "email", "secondaryEmail", "nafUser"];

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export interface Anonymiser {
  readonly pseudonym: string;
  readonly aliases: readonly string[];
  /** The value is a string naming the coach. */
  matches(value: unknown): boolean;
  /** The pseudonym in the case convention of `original`. */
  swap(original: string): string;
  /** Replace the named fields of `obj` that name the coach; on any change drop the re-identifying siblings. */
  fields(obj: unknown, names: readonly string[], drop?: readonly string[]): boolean;
  /** Replace matching strings of a string array in place. */
  list(arr: unknown): boolean;
  /** Rebuild a map keyed by coach (explicitly known maps only, e.g. tabletop confirmations, coach titles). */
  keyedMap(map: unknown): boolean;
  /** Whole-word, case-insensitive replacement of the coach's names inside free text. */
  text(value: unknown): unknown;
  /** Replace the named free-text fields of `obj`. */
  texts(obj: unknown, names: readonly string[]): boolean;
  /** The same pseudonym with more names (e.g. display names found on rows linked to the coach's account). */
  withAliases(extra: readonly string[]): Anonymiser;
}

export function createAnonymiser(aliases: readonly string[], pseudonym: string): Anonymiser {
  const list = [...new Map(aliases.filter((a) => typeof a === "string" && nameKey(a)).map((a) => [nameKey(a), a.trim()])).values()];
  const keys = new Set(list.map(nameKey));
  const lower = pseudonym.toLowerCase();
  const swap = (original: string): string => (original === original.toLowerCase() && original !== original.toUpperCase() ? lower : pseudonym);
  const matches = (v: unknown): boolean => typeof v === "string" && keys.has(nameKey(v));
  // Longest first so "Bob Smith" wins over "Bob".
  const textRes = [...list].sort((a, b) => b.length - a.length).map((k) => new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(k)}(?![\\p{L}\\p{N}_])`, "giu"));

  const an: Anonymiser = {
    pseudonym,
    aliases: list,
    matches,
    swap,
    fields(obj, names, drop = RE_IDENTIFYING) {
      if (!isObj(obj)) return false;
      let changed = false;
      for (const n of names) if (matches(obj[n])) { obj[n] = swap(obj[n] as string); changed = true; }
      if (changed) for (const d of drop) delete obj[d];
      return changed;
    },
    list(arr) {
      if (!Array.isArray(arr)) return false;
      let changed = false;
      arr.forEach((v, i) => { if (matches(v)) { arr[i] = swap(v as string); changed = true; } });
      return changed;
    },
    keyedMap(map) {
      if (!isObj(map)) return false;
      const hits = Object.keys(map).filter((k) => keys.has(nameKey(k)));
      for (const k of hits) {
        const v = map[k];
        delete map[k];
        map[swap(k)] = v;
      }
      return hits.length > 0;
    },
    text(value) {
      if (typeof value !== "string") return value;
      let out = value;
      for (const re of textRes) out = out.replace(re, pseudonym);
      return out;
    },
    texts(obj, names) {
      if (!isObj(obj)) return false;
      let changed = false;
      for (const n of names) {
        const next = an.text(obj[n]);
        if (next !== obj[n]) { obj[n] = next; changed = true; }
      }
      return changed;
    },
    withAliases(extra) { return createAnonymiser([...list, ...extra], pseudonym); },
  };
  return an;
}
