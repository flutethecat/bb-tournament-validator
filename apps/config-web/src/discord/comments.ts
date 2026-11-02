/**
 * Coach's comments (owner rounds 3 + 4): at the recorder's end-game step each coach may write ONE comment of at most 120
 * characters per game. It shows in the end-of-game digest and on the match page. An organiser of the competition (or a
 * site admin) may hide it. A competition setting turns comments off (default on). A comment is stored exactly as written
 * (owner 11-02): the profanity filter only changes what is displayed (src/discord/profanity.ts: starred for a viewer with
 * "Filter profanity" on, always starred on Discord).
 *
 * Stored on the tabletop match record by SIDE (MatchRecord.comments), so the coach is the seat's and account deletion
 * anonymises it with the seat (src/privacy/collectors.ts anonymiseTabletopMatch also rewrites the text's name mentions).
 */
import type { MatchComment, MatchRecord } from "../tabletop/store.js";

export const COMMENT_MAX = 120;
/** States in which the end-game step is open: the match was submitted (and later confirmed / published). */
export const COMMENT_STATES: ReadonlySet<MatchRecord["state"]> = new Set(["submitted", "confirmed", "published"]);

export type CommentParse = { ok: true; text: string } | { ok: false; error: string };

/** "" = remove the comment. */
export function parseComment(raw: unknown): CommentParse {
  const v = (raw as { text?: unknown } | undefined)?.text;
  if (typeof v !== "string") return { ok: false, error: "text must be a string." };
  // eslint-disable-next-line no-control-regex
  const text = v.normalize("NFC").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  if ([...text].length > COMMENT_MAX) return { ok: false, error: `A comment can be at most ${COMMENT_MAX} characters.` };
  return { ok: true, text };
}

/**
 * The comments a viewer of the recorder sees: managers see every comment (hidden ones marked); a seat sees its own comment
 * (marked when hidden) and the other seat's when visible; anyone else none (the public match page reads visible ones).
 */
export function commentsFor(match: Pick<MatchRecord, "comments">, viewer: "home" | "away" | "manager" | "other"): Partial<Record<"home" | "away", MatchComment>> | undefined {
  const all = match.comments;
  if (!all) return undefined;
  const out: Partial<Record<"home" | "away", MatchComment>> = {};
  for (const side of ["home", "away"] as const) {
    const c = all[side];
    if (!c) continue;
    if (viewer === "manager" || viewer === side) out[side] = c;
    else if (viewer !== "other" && !c.hidden) out[side] = { text: c.text, at: c.at };
  }
  return Object.keys(out).length ? out : undefined;
}
