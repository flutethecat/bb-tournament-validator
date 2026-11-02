/**
 * Live vs end-of-game routing for a finished recorded game (owner round 3):
 *
 *   - the end-of-game digest (when the competition has it on) is THE match-end post: score, every in-game section that is
 *     switched on, the coach's comments. It replaces the plain result post, so a game is never announced twice.
 *   - digest off: the plain result post (the "match result" toggle).
 *   - live in-game events: a tabletop game posted them while it was played (see hub.ts onTabletopEvents); a Super FUMBBL
 *     game has no live feed, so its live-switched events (deaths by default) post one by one when its result arrives.
 */
import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { IN_GAME_KEYS } from "./catalogue.js";
import type { GameRecord } from "./games.js";
import { gameDigestPost, liveEventPost } from "./posts.js";
import { postRaw, postTo, type DiscordTarget } from "./targets.js";

export interface GameAnnounceOptions {
  round?: string;
  url?: string;
  /** The plain result post (digest off). */
  plain: () => DiscordPayload;
}

export interface GameAnnounceOutcome { digest: boolean; plain: boolean; live: number }

export async function announceGame(t: DiscordTarget, game: GameRecord | undefined, poster: WebhookPoster, opts: GameAnnounceOptions): Promise<GameAnnounceOutcome> {
  const out: GameAnnounceOutcome = { digest: false, plain: false, live: 0 };
  if (t.draft || !t.url) return out;
  if (game && game.source === "superfumbbl") {
    for (const k of IN_GAME_KEYS) {
      if (!t.config.events[k] || !t.config.live[k]) continue;
      for (const line of game.lines[k]) if (await postTo(t, k, liveEventPost(t.name, k, game, line), poster)) out.live += 1;
    }
  }
  if (game && t.config.endOfGameDigest) {
    const show = Object.fromEntries(IN_GAME_KEYS.map((k) => [k, t.config.events[k]]));
    out.digest = await postRaw(t, gameDigestPost(t.name, game, show, { ...(opts.round ? { round: opts.round } : {}), ...(opts.url ? { url: opts.url } : {}), comments: t.config.comments }), poster);
    return out;
  }
  out.plain = await postTo(t, "matchResult", opts.plain(), poster);
  return out;
}
