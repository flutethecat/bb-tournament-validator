/**
 * The built-in profanity list for coach's comments (owner round 4: "obvious candidates only"). Kept in its own module and
 * ROT13-encoded so the words never appear in plain text in the source, the tests or a log. Lower case, letters only.
 *
 *   ROOTS  blocked wherever they appear inside a word (compounds)
 *   WORDS  blocked as a whole word, with or without a plain English ending (s, es, ed, er, ers, ing, y)
 *
 * To add a word: ROT13 it (each letter shifted 13 places) and append it to the right list.
 */
export const ROOTS_ROT13: readonly string[] = ["shpx", "avttre", "avttn", "snttbg", "zbgures", "pbpxfhpx"];
export const WORDS_ROT13: readonly string[] = ["phag", "fuvg", "ovgpu", "onfgneq", "nffubyr", "nefrubyr", "qvpx", "qvpxurnq", "pbpx", "chffl", "jnaxre", "gjng", "obyybpxf", "cevpx", "fyhg", "juber", "ergneq", "snt", "fcvp", "puvax", "xvxr", "jrgonpx", "genaal", "qlxr", "pbba", "tbbx", "cnxv", "fuvgurnq", "ohyyfuvg", "wnpxnff", "qbhpuront", "qbhpur", "oryyraq", "xabournq"];
/** Ordinary words a WORDS entry plus an ending would otherwise catch. */
export const ALLOW_ROT13: readonly string[] = ["fcvpl", "pbpxl", "pbpxrq", "pbpxvat", "pbpxre", "pbpxref", "cevpxrq", "cevpxvat", "cevpxre", "qvpxl"];
