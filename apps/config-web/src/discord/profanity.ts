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
 * Matching works on words found in the ORIGINAL text, and the original span is what gets starred:
 *   - invisible format characters (zero-width spaces and joiners, soft hyphens: Unicode Cf) are ignored inside a word;
 *   - common separators between letters (. - _ * ' ` ~ | and the like) join a word ("s.h.i.t" is one word), and runs of
 *     three or more single letters split by spaces are read as one word ("f u c k");
 *   - each word is folded: NFKC (full-width and other compatibility forms), accents dropped, lower case, look-alike digits
 *     and symbols ("1" for "i", "@" for "a") and common Cyrillic / Greek look-alike letters mapped to Latin;
 *   - the folded word is checked as written and with repeated letters collapsed, whole word (with plain endings) or, for a
 *     few roots, anywhere inside it. Whole-word matching keeps innocent words ("Scunthorpe", "raccoon") alone.
 * Pure: safe to import from the SPA.
 */
import { ALLOW_ROT13, ROOTS_ROT13, WORDS_ROT13 } from "./profanityList.js";

export const PROFANITY_MASK = "***";

const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const ROOTS = ROOTS_ROT13.map(rot13);
const WORDS = new Set(WORDS_ROT13.map(rot13));
const ALLOW = new Set(ALLOW_ROT13.map(rot13));
const ENDINGS = ["", "s", "es", "ed", "er", "ers", "ing", "y", "z"];
const LOOKALIKE: Record<string, string> = { "0": "o", "1": "i", "!": "i", "|": "i", "3": "e", "4": "a", "@": "a", "5": "s", $: "s", "7": "t", "+": "t", "8": "b", "9": "g" };
/** Cyrillic and Greek letters that look like Latin ones (lower case; NFKC does not map these). */
const CONFUSABLE: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ѕ": "s",
  "ј": "j", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b", "ґ": "r",
  "α": "a", "ε": "e", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "ν": "v", "κ": "k", "ι": "i", "χ": "x",
};

const collapse = (w: string): string => w.replace(/(.)\1+/g, "$1");

/** One character of a word folded to plain lower-case Latin letters ("" = nothing that counts). */
function foldChar(c: string): string {
  const lower = c.normalize("NFKC").toLowerCase();
  let out = "";
  for (const ch of lower) {
    const mapped = CONFUSABLE[ch] ?? LOOKALIKE[ch] ?? ch;
    out += mapped.normalize("NFKD").replace(/\p{M}+/gu, "");
  }
  return out.replace(/[^a-z]/g, "");
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

const isWordChar = (c: string): boolean => /[\p{L}\p{M}\p{N}@$+]/u.test(c) || (c === "!" || c === "|");
const isFormat = (c: string): boolean => /\p{Cf}/u.test(c);
const isJoiner = (c: string): boolean => /[.\-_*'`~’·•]/.test(c);

interface Span { start: number; end: number; word: string }

/** Words in the text: [start, end) code-unit spans of the original and their folded letters. */
function words(text: string): Span[] {
  const chars = [...text];
  const offs: number[] = [];
  let o = 0;
  for (const c of chars) { offs.push(o); o += c.length; }
  offs.push(o);
  const spans: Span[] = [];
  let i = 0;
  while (i < chars.length) {
    if (!isWordChar(chars[i]!) || ((chars[i] === "!" || chars[i] === "|") && !(i + 1 < chars.length && /[\p{L}\p{N}]/u.test(chars[i + 1]!)) && !(i > 0 && /[\p{L}\p{N}]/u.test(chars[i - 1]!)))) { i += 1; continue; }
    let j = i;
    let last = i;
    let word = "";
    while (j < chars.length) {
      const c = chars[j]!;
      if (isWordChar(c)) { word += foldChar(c); last = j; j += 1; continue; }
      // a format character, or a separator with a letter right after it, stays inside the word
      if (isFormat(c) || (isJoiner(c) && j + 1 < chars.length && (isWordChar(chars[j + 1]!) || isFormat(chars[j + 1]!)))) { j += 1; continue; }
      break;
    }
    // a trailing "!" run is punctuation, not a look-alike "i"
    let end = last;
    while (end > i && chars[end] === "!") end -= 1;
    if (end < last) word = [...chars.slice(i, end + 1)].map((c) => (isWordChar(c) ? foldChar(c) : "")).join("");
    spans.push({ start: offs[i]!, end: offs[end + 1]!, word });
    i = last + 1;
  }
  // "f u c k": three or more single-letter words split by single spaces read as one word
  const out: Span[] = [];
  for (let k = 0; k < spans.length; k++) {
    let m = k;
    while (m + 1 < spans.length && spans[m]!.word.length === 1 && spans[m + 1]!.word.length === 1 && /^[\s]$/.test(text.slice(spans[m]!.end, spans[m + 1]!.start))) m += 1;
    if (m - k >= 2) { out.push({ start: spans[k]!.start, end: spans[m]!.end, word: spans.slice(k, m + 1).map((s) => s.word).join("") }); k = m; } else out.push(spans[k]!);
  }
  return out;
}

/** True when the text contains a listed word. */
export function containsProfanity(text: string): boolean {
  return words(String(text)).some((s) => wordBlocked(s.word));
}

/** The text with every listed word's original span replaced by the mask (everything else exactly as written). */
export function starProfanity(text: string, mask = PROFANITY_MASK): string {
  const s = String(text);
  let out = "";
  let at = 0;
  for (const w of words(s)) {
    if (!wordBlocked(w.word)) continue;
    out += s.slice(at, w.start) + mask;
    at = w.end;
  }
  return out + s.slice(at);
}

/** What a viewer sees: starred when their "Filter profanity" option is on (default on). */
export const forViewer = (text: string, filterOn: boolean | undefined): string => (filterOn === false ? text : starProfanity(text));
