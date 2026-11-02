/**
 * The recorder side of the competition Discord posts: a tabletop match played for a league fixture or a tournament
 * fixture posts to THAT competition's webhook (src/discord/targets.ts).
 *
 *   onTabletopEvents   while the match is played: each newly recorded in-game event whose toggle AND "live" switch are on
 *                      (deaths and sent-offs by default) posts after a short delay, and only if it is still in effect then
 *                      (an undo inside the delay cancels it).
 *   onTabletopResult   when the match is confirmed for good: the end-of-game digest (with the coach's comments) or the
 *                      plain result (games-post.ts), once per match and score.
 *
 * Casual and Testing Suite matches post nothing; neither does a draft competition. In-game data comes only from the
 * recorder's own event log (laws 15). Player names follow the game pages' public player-lines policy.
 */
import type { LeagueStore } from "../leagues/store.js";
import { postWebhook as defaultPoster, type WebhookPoster } from "../leagues/discord.js";
import { LEAGUE_FIXTURE_REF } from "../leagues/tabletopFixtures.js";
import type { LeagueFixture } from "../leagues/types.js";
import type { TournamentStore } from "../tournaments/store.js";
import type { Side, TabletopEvent } from "../tabletop/events.js";
import type { TabletopTeamFile } from "../tabletop/postMatch.js";
import type { MatchRecord } from "../tabletop/store.js";
import { announceGame } from "./games-post.js";
import { tabletopGame, tabletopLine, type GameComment, type PlayerLabel } from "./games.js";
import { liveEventPost, resultPost } from "./posts.js";
import type { DiscordStateStore } from "./store.js";
import { postTo, seasonTarget, tournamentTarget, type DiscordTarget } from "./targets.js";

export const LIVE_DELAY_MS = 30_000;

export interface DiscordHubDeps {
  leagues: Pick<LeagueStore, "league" | "season" | "secrets">;
  tournaments: Pick<TournamentStore, "match" | "tournament">;
  state: DiscordStateStore;
  poster?: WebhookPoster;
  /** GAME_PAGES_PUBLIC_PLAYER_LINES: false = players are shown by number only. Default true. */
  publicNames?: boolean;
  liveDelayMs?: number;
  /** Is the event still in effect (not undone)? Default: yes. */
  stillEffective?: (matchId: string, eventId: string) => Promise<boolean>;
  now?: () => Date;
}

export interface MatchTarget { target: DiscordTarget; round?: string; tournamentMatchId?: string; fixture?: LeagueFixture }

type MatchLike = Pick<MatchRecord, "id" | "fixtureRef" | "test" | "home" | "away"> & Partial<Pick<MatchRecord, "comments">>;

/** The visible coach's comments of a match (hidden ones never leave the store). */
export function visibleComments(match: MatchLike): GameComment[] {
  const out: GameComment[] = [];
  for (const side of ["home", "away"] as const) {
    const c = match.comments?.[side];
    if (c && !c.hidden && c.text) out.push({ side, coach: match[side].coach, text: c.text });
  }
  return out;
}

export function playerLabel(teams: Partial<Record<Side, TabletopTeamFile | undefined>>, publicNames: boolean): PlayerLabel {
  return (side, id) => {
    const p = id ? teams[side]?.players.find((x) => x.id === id) : undefined;
    if (!p) return "a player";
    if (publicNames) return p.name;
    return typeof p.number === "number" ? `#${p.number}` : "a player";
  };
}

export class DiscordHub {
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly deps: DiscordHubDeps) {}

  private get poster(): WebhookPoster { return this.deps.poster ?? defaultPoster; }

  /** The competition a recorder match was played for (league fixture or tournament fixture), or undefined (casual). */
  targetForMatch(match: Pick<MatchRecord, "fixtureRef" | "test">): MatchTarget | undefined {
    if (match.test || !match.fixtureRef) return undefined;
    const lm = LEAGUE_FIXTURE_REF.exec(match.fixtureRef);
    if (lm) {
      const league = this.deps.leagues.league(lm[1]!);
      const season = league ? this.deps.leagues.season(league.id, lm[2]!) : undefined;
      const fixture = season?.fixtures.find((f) => f.id === lm[3]);
      if (!league || !season || !fixture) return undefined;
      const round = [fixture.phase && fixture.phase !== "Regular" ? fixture.phase : "", fixture.round ? `Round ${fixture.round}` : ""].filter(Boolean).join(", ");
      return { target: seasonTarget(this.deps.leagues, league, season.id), ...(round ? { round } : {}), fixture };
    }
    const m = this.deps.tournaments.match(match.fixtureRef);
    const t = m ? this.deps.tournaments.tournament(m.tournamentId) : undefined;
    if (!m || !t) return undefined;
    return { target: tournamentTarget(this.deps.state, t), round: `Round ${m.roundNumber}`, tournamentMatchId: m.id };
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }

  /** Waits for every scheduled post (tests; graceful shutdown). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Newly recorded events of a match being played: the live ones post (after the delay, if not undone). */
  onTabletopEvents(match: MatchLike, accepted: readonly TabletopEvent[], teams: Partial<Record<Side, TabletopTeamFile | undefined>>): void {
    const at = this.targetForMatch(match);
    if (!at || at.target.draft || !at.target.url) return;
    const label = playerLabel(teams, this.deps.publicNames !== false);
    const game = { home: { team: match.home.teamName }, away: { team: match.away.teamName }, ...(match.test ? { test: true } : {}) };
    for (const e of accepted) {
      const got = tabletopLine(e, label);
      if (!got || !at.target.config.events[got.key] || !at.target.config.live[got.key]) continue;
      const payload = liveEventPost(at.target.name, got.key, game, got.line);
      const delay = this.deps.liveDelayMs ?? LIVE_DELAY_MS;
      this.track((async () => {
        if (delay > 0) await new Promise((r) => setTimeout(r, delay).unref?.());
        if (this.deps.stillEffective && !(await this.deps.stillEffective(match.id, e.id).catch(() => false))) return false;
        // Re-resolve: the competition may have been unpublished or its switch turned off meanwhile.
        const now = this.targetForMatch(match)?.target;
        return now && now.config.live[got.key] ? postTo(now, got.key, payload, this.poster) : false;
      })());
    }
  }

  /** The match was confirmed for good: digest or plain result, once per match and score. */
  async onTabletopResult(match: MatchLike, events: readonly TabletopEvent[], teams: Partial<Record<Side, TabletopTeamFile | undefined>>): Promise<boolean> {
    const at = this.targetForMatch(match);
    if (!at || at.target.draft || !at.target.url) return false;
    const game = tabletopGame({
      matchId: match.id,
      home: { team: match.home.teamName, coach: match.home.coach },
      away: { team: match.away.teamName, coach: match.away.coach },
      events, label: playerLabel(teams, this.deps.publicNames !== false),
      comments: visibleComments(match),
    });
    const marker = `game:${match.id}:${game.home.score}-${game.away.score}`;
    const stamp = (this.deps.now?.() ?? new Date()).toISOString();
    // Marked first (also the tournament result marker the observer checks): a game is never announced twice.
    const markers = [marker, ...(at.tournamentMatchId ? [`result:${at.tournamentMatchId}`] : [])];
    if (!this.deps.state.mark(at.target.key, markers, stamp).includes(marker)) return false;
    const out = await this.track(announceGame(at.target, game, this.poster, {
      ...(at.round ? { round: at.round } : {}),
      plain: () => resultPost(at.target.name, { home: { team: game.home.team, score: game.home.score, conceded: game.home.conceded }, away: { team: game.away.team, score: game.away.score, conceded: game.away.conceded }, ...(at.round ? { round: at.round } : {}) }),
    }));
    return out.digest || out.plain;
  }
}
