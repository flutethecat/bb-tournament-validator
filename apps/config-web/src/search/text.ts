// Search text folding and matching (global site search, owner 11-04; shared with Browse leagues in the SPA). Pure: no
// DOM, no stores. Case- and diacritic-insensitive ("Müller" = "muller", "ÉLITE" = "elite"), plus the common letters NFKD
// does not decompose (ß, æ, ø, œ, ł, đ, þ).

const EXTRA: Readonly<Record<string, string>> = { "ß": "ss", "æ": "ae", "ø": "o", "œ": "oe", "ł": "l", "đ": "d", "ð": "d", "þ": "th", "ı": "i" };

function foldChar(ch: string): string {
  const f = ch.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  let out = "";
  for (const c of f) out += EXTRA[c] ?? c;
  return out;
}

/** Folded text plus, for each folded character, the index of the original character it came from (and its end). */
export function fold(text: string): { text: string; map: number[]; ends: number[] } {
  let out = "";
  const map: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) { map.push(i); ends.push(i + ch.length); }
    out += f;
    i += ch.length;
  }
  return { text: out, map, ends };
}

/** The folded text alone. */
export const foldText = (text: string): string => fold(text).text;

/** A query as matched: trimmed, inner whitespace collapsed, folded. */
export const foldQuery = (q: string): string => foldText(q.trim().replace(/\s+/g, " "));

/** How a (folded) query meets a (folded) value. Higher is better; 0 = no match. */
export const MATCH_EXACT = 4;
export const MATCH_PREFIX = 3;
export const MATCH_WORD_PREFIX = 2;
export const MATCH_SUBSTRING = 1;

const WORD_START = /[\s\-_'.,/()&:+]/;

/** Exact (4), prefix (3), a word inside starts with it (2), anywhere (1), or 0. Both sides already folded. */
export function matchTier(value: string, q: string): number {
  if (!q || !value) return 0;
  if (value === q) return MATCH_EXACT;
  if (value.startsWith(q)) return MATCH_PREFIX;
  let at = value.indexOf(q);
  if (at < 0) return 0;
  while (at >= 0) {
    if (at === 0 || WORD_START.test(value[at - 1]!)) return MATCH_WORD_PREFIX;
    at = value.indexOf(q, at + 1);
  }
  return MATCH_SUBSTRING;
}
