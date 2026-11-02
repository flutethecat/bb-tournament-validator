/**
 * Small profanity filter (owner 11-02, replacing the earlier "reject" rule): messages and coach's comments are ALWAYS
 * sent and stored exactly as written. The filter only changes what is DISPLAYED:
 *
 *   - on the site and in the inbox, for a viewer whose Account option "Filter profanity" is on (default on, and always on
 *     for a visitor who is not signed in): matched words show as "***" (the SPA imports starProfanity from here);
 *   - in every Discord post: coach-typed text (comment lines, names, news) is always starred.
 *
 * The list lives in ./profanityList.ts (ROT13-encoded); nothing here logs the text or the word that matched.
 *
 * Matching: each word is folded (NFKD, accents dropped, lower case, look-alike digits and symbols mapped to letters) and
 * checked with its repeated letters collapsed too. Whole-word matching keeps innocent words that merely contain a listed
 * word (place names, "raccoon") untouched. Pure: safe to import from the SPA.
 */
import { ALLOW_ROT13, ROOTS_ROT13, WORDS_ROT13 } from "./profanityList.js";

export const PROFANITY_MASK = "***";

const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const ROOTS = ROOTS_ROT13.map(rot13);
const WORDS = new Set(WORDS_ROT13.map(rot13));
const ALLOW = new Set(ALLOW_ROT13.map(rot13));
const ENDINGS = ["", "s", "es", "ed", "er", "ers", "ing", "y", "z"];
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "!": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "+": "t", "8": "b", "9": "g" };

const collapse = (w: string): string => w.replace(/(.)\1+/g, "$1");

/** One token folded to plain lower-case letters (look-alikes mapped, everything else dropped). */
function foldWord(token: string): string {
  return token.normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[0-9!@$+]/g, (c) => LOOKALIKE[c] ?? c).replace(/[^a-z]/g, "");
}

function wordBlocked(w: string): boolean {
  if (!w || ALLOW.has(w)) return false;
  for (const form of new Set([w, collapse(w)])) {
    if (ROOTS.some((r) => form.includes(r) || collapse(form).includes(collapse(r)))) return true;
    for (const end of ENDINGS) {
      if (!form.endsWith(end)) continue;
      const stem = form.slice(0, form.length - end.length);
      if (WORDS.has(stem) || WORDS.has(collapse(stem))) return true;
      // "bitchy" / "dicks": a stem whose last letter was doubled before the ending
      if (stem.length > 2 && stem.at(-1) === stem.at(-2) && WORDS.has(stem.slice(0, -1))) return true;
    }
  }
  return false;
}

/** Words: runs of letters, digits and the look-alike symbols (so "sh1t" and "f@g" are one word each). */
const TOKEN = /[\p{L}\p{M}\p{N}!@$+]+/gu;

/** A token split into its word and a trailing "!" run (punctuation there, not a look-alike letter). */
function split(tok: string): { word: string; tail: string } {
  const tail = /!+$/.exec(tok)?.[0] ?? "";
  return { word: tail ? tok.slice(0, -tail.length) : tok, tail };
}
const tokenBlocked = (tok: string): boolean => {
  const { word } = split(tok);
  return Boolean(word) && wordBlocked(foldWord(word));
};

/** True when the text contains a listed word. */
export function containsProfanity(text: string): boolean {
  for (const m of String(text).matchAll(TOKEN)) if (tokenBlocked(m[0])) return true;
  return false;
}

/** The text with every listed word replaced by "***" (everything else exactly as written). */
export function starProfanity(text: string): string {
  return String(text).replace(TOKEN, (tok) => (tokenBlocked(tok) ? `${PROFANITY_MASK}${split(tok).tail}` : tok));
}

/** What a viewer sees: starred when their "Filter profanity" option is on (default on). */
export const forViewer = (text: string, filterOn: boolean | undefined): string => (filterOn === false ? text : starProfanity(text));
