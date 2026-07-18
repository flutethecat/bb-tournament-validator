/**
 * BB-Bot rules grounding. When a coach @-mentions the grognard with an actual rules question,
 * we hand the LLM the Blood Bowl 2025 rulebook text so he answers CORRECTLY (in character).
 *
 * The rulebook is a LOCAL MIRROR of bloodbowlbase.ru/bb2025 (our canonical BB2025 reference),
 * cached to data-store/rules-corpus.md so we hit their site only when (re)building the mirror,
 * never per question. The corpus is large and STABLE, so it rides Anthropic prompt caching as a
 * frozen system block — see askGrognardLLM.ts (first rules query writes the cache, the rest read
 * it at ~0.1x). Rebuild the mirror with: scripts/build-rules-corpus.mjs.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const CORPUS_PATH = fileURLToPath(new URL("../data-store/rules-corpus.md", import.meta.url));

let corpus: string | null | undefined; // undefined = not yet tried; null = tried & absent

/** The BB2025 rules corpus text, or null if the local mirror isn't present. Read once, cached. */
export function loadRulesCorpus(): string | null {
  if (corpus === undefined) {
    try {
      corpus = readFileSync(CORPUS_PATH, "utf8");
    } catch {
      corpus = null; // no mirror → grognard just answers from character (ungrounded)
    }
  }
  return corpus;
}

/**
 * Does this @-mention read like a genuine rules question? Kept deliberately lean — a false
 * positive just means we ground an answer we didn't need to (bounded cost, cached); a false
 * negative means he waffles from character. We lean toward answering: explicit rules words
 * always trigger, otherwise we need an interrogative AND a Blood-Bowl noun.
 */
export function looksLikeRulesQuestion(question: string): boolean {
  const s = (question || "").toLowerCase();
  if (/\b(rule|rules|ruling|faq|errata|legal|illegal|allowed|permitted|by the book)\b/.test(s)) {
    return true;
  }
  const interrogative = /\?|\b(can|could|how|what|when|where|which|does|do|is|are|why|should)\b/.test(s);
  const rulesNoun =
    /\b(block|blitz|dodge|foul|tackle|pass|hand-?off|throw|scatter|kick-?off|kick|touchdown|td|armou?r|injury|casualty|knock(ed)? down|stun|ko\b|sent off|skill|trait|turnover|re-?roll|rush|go for it|prone|stumble|push(ed)?|both down|pow|interception|catch|pick up|prayer|inducement|star player|apothecary|wizard|bribe|sideline|crowd|blitzer|lineman|thrower|catcher|ogre|troll|team ?value|tv\b|spp|niggling|mng|stat)\b/.test(
      s,
    );
  return interrogative && rulesNoun;
}
