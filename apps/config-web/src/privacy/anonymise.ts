/**
 * Anonymisation of public history (privacy spec §3.5, owner 10-31: "anonymise, don't erase").
 *
 * ALIASES ARE NOT OWNERSHIP AND NOT FREE-TEXT TARGETS (privacy review round 2):
 * - A record is anonymised only when it is LINKED to the coach: one of its identity fields (fork coach account, the
 *   identity-store key, a league row's coachId) names the coach. `matches` compares identity keys only.
 * - Self-chosen names (display name, NAF name, Discord username) never select records. A display-name column is
 *   rewritten only on a record that is already linked (the step rewrites it whatever it says).
 * - Free text (news, logs, notification titles) gets the coach's identity name and the display names found on LINKED
 *   records, each only when it is at least 3 characters, not a common English word, and not the name of another coach
 *   or fork account; case-sensitive whole words; text already carrying a pseudonym is never rewritten again.
 *
 * Matching uses EXACTLY the identity store's key function (trim + lower case; src/privacy/fence.ts coachKey).
 * A value written all in lower case (a normalised key) gets the lower-case pseudonym.
 */
import { coachKey } from "./fence.js";

export const nameKey = coachKey;

/** Dropped from an object once one of its coach fields was anonymised (they would re-identify the person). */
export const RE_IDENTIFYING = ["discordUserId", "discordUsername", "discordAvatarHash", "email", "secondaryEmail", "nafUser"];

/** Common English words never used as a free-text alias (a display name like "the" or "version" must not eat text). */
export const TEXT_STOP_WORDS = new Set(`
a about above after again against all also am an and any are around as at back be because been before being below
best between big both but by came can come could day did do does done down each even every few first for from game
get go goes going good got great had has have he her here him his how i if in into is it its just last let like little
long look made make man many may me more most much must my name never new next no not now of off old on once one only
or other our out over own part play played player players please put really right round said same saw say see she
should show side since so some still such take team teams than that the their them then there these they thing think
this those through time to today too two under up us use used very version want was way we well went were what when
where which while who why will win with won would year yes yet you your coach coaches league match matches season
id ids admin test name names new user users guest home away final cup open
`.split(/\s+/).filter(Boolean));

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Text already anonymised: never rewritten again (idempotent steps). */
const PSEUDONYM_RE = /Deleted coach #\d+/g;

export interface Anonymiser {
  readonly pseudonym: string;
  /** Identity keys of the coach (linkage). */
  readonly ids: ReadonlySet<string>;
  /** The value is a string naming the coach by an identity key. */
  matches(value: unknown): boolean;
  /** The pseudonym in the case convention of `original`. */
  swap(original: string): string;
  /** Replace the named identity fields of `obj` that name the coach; on any change drop `drop`. */
  fields(obj: unknown, names: readonly string[], drop?: readonly string[]): boolean;
  /** Set the named fields of a LINKED record to the pseudonym whatever they say (display-name columns). */
  overwrite(obj: unknown, names: readonly string[], drop?: readonly string[]): boolean;
  /** Replace matching strings of a string array in place. */
  list(arr: unknown): boolean;
  /** Rebuild a map keyed by coach id (explicitly known maps only, e.g. tabletop confirmations, coach titles). */
  keyedMap(map: unknown): boolean;
}

export function createAnonymiser(identityNames: readonly string[], pseudonym: string): Anonymiser {
  const ids = new Set(identityNames.filter((a) => typeof a === "string" && nameKey(a)).map(nameKey));
  const lower = pseudonym.toLowerCase();
  const swap = (original: string): string => (original === original.toLowerCase() && original !== original.toUpperCase() ? lower : pseudonym);
  const matches = (v: unknown): boolean => typeof v === "string" && ids.has(nameKey(v));
  const an: Anonymiser = {
    pseudonym,
    ids,
    matches,
    swap,
    fields(obj, names, drop = RE_IDENTIFYING) {
      if (!isObj(obj)) return false;
      let changed = false;
      for (const n of names) if (matches(obj[n])) { obj[n] = swap(obj[n] as string); changed = true; }
      if (changed) for (const d of drop) delete obj[d];
      return changed;
    },
    overwrite(obj, names, drop = RE_IDENTIFYING) {
      if (!isObj(obj)) return false;
      let changed = false;
      for (const n of names) {
        const v = obj[n];
        if (typeof v !== "string" || !v.trim()) continue;
        const next = matches(v) ? swap(v) : pseudonym;
        if (v !== next) { obj[n] = next; changed = true; }
      }
      for (const d of drop) if (Object.hasOwn(obj, d)) { delete obj[d]; changed = true; }
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
      const hits = Object.keys(map).filter((k) => ids.has(nameKey(k)));
      for (const k of hits) {
        const v = map[k];
        delete map[k];
        map[swap(k)] = v;
      }
      return hits.length > 0;
    },
  };
  return an;
}

/** Which names may be replaced inside free text (see the header). `others` are identity keys of other coaches / accounts. */
export function textAliases(candidates: readonly string[], others: ReadonlySet<string>): string[] {
  const out = new Map<string, string>();
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const v = c.trim();
    if (v.length < 3 || TEXT_STOP_WORDS.has(v.toLowerCase()) || others.has(nameKey(v)) || /deleted coach/i.test(v)) continue;
    out.set(v, v);
  }
  return [...out.values()];
}

export interface TextReplacer {
  text(value: unknown): unknown;
  texts(obj: unknown, names: readonly string[]): boolean;
}

/**
 * Case-sensitive whole-word replacement of `aliases` (already filtered by textAliases); pseudonyms are left alone.
 * `protectedNames` are other coaches' / accounts' names: an occurrence of an alias that is part of one of them at that
 * position ("Alice" inside another coach's "Alice Smith") is never replaced. Text and names are compared in NFC, and
 * combining marks count as word characters, so a decomposed "José" never matches an alias "Jose".
 */
export function createTextReplacer(aliases: readonly string[], pseudonym: string, protectedNames: readonly string[] = []): TextReplacer {
  const W = String.raw`\p{L}\p{N}\p{M}_`;
  const nfc = (x: string): string => x.normalize("NFC");
  // ONE alternation, longest first, applied once: a replacement is never matched again by a shorter alias.
  const sorted = [...new Set(aliases.map(nfc))].sort((a, b) => b.length - a.length);
  const re = sorted.length ? new RegExp(`(?<![${W}#])(?:${sorted.map(escapeRe).join("|")})(?![${W}])`, "gu") : undefined;
  const lowerAliases = sorted.map((a) => a.toLowerCase());
  const guards = [...new Set(protectedNames.map((p) => nfc(p.trim())).filter((p) => p && lowerAliases.some((a) => p.toLowerCase() !== a && p.toLowerCase().includes(a))))]
    .sort((a, b) => b.length - a.length);
  const guardRe = guards.length ? new RegExp(`(?<![${W}])(?:${guards.map(escapeRe).join("|")})(?![${W}])`, "giu") : undefined;
  const replaceSegment = (seg: string): string => {
    if (!re) return seg;
    const spans: Array<[number, number]> = guardRe ? [...seg.matchAll(guardRe)].map((m) => [m.index!, m.index! + m[0].length]) : [];
    return seg.replace(re, (m: string, offset: number) => (spans.some(([a, b]) => offset >= a && offset + m.length <= b) ? m : pseudonym));
  };
  const text = (value: unknown): unknown => {
    if (typeof value !== "string" || !re) return value;
    const input = nfc(value);
    let out = "";
    let last = 0;
    for (const m of input.matchAll(PSEUDONYM_RE)) {
      out += replaceSegment(input.slice(last, m.index)) + m[0];
      last = m.index! + m[0].length;
    }
    out += replaceSegment(input.slice(last));
    return out === input ? value : out; // untouched text keeps its original form
  };
  return {
    text,
    texts(obj, names) {
      if (!isObj(obj)) return false;
      let changed = false;
      for (const n of names) {
        const next = text(obj[n]);
        if (next !== obj[n]) { obj[n] = next; changed = true; }
      }
      return changed;
    },
  };
}
