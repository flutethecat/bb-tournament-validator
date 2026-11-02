/**
 * Where a competition's Discord posts go, and with which options (per-competition webhooks, league ladder spec round 2):
 *
 *   league       the league's own webhook (secrets.json discordWebhookUrl) and toggles (league.discordEvents + league.discord)
 *   season       its own webhook (secrets.json competitionWebhooks["season:<id>"]) and options
 *                (league.competitionDiscord["season:<id>"]); a blank webhook falls back to the league's, missing options
 *                to the league's. Ladders use the same shape with "ladder:<id>" (a later lane).
 *   tournament   its own webhook and options in the Discord state store ("tournament:<id>"); a blank webhook falls back to
 *                its series' ("series:<id>") when it has one.
 *
 * A draft competition (an unpublished league or tournament) never posts. The URL never leaves this module except into
 * the poster; nothing here logs.
 */
import type { LeagueStore } from "../leagues/store.js";
import type { DiscordEventKey, LeagueRecord } from "../leagues/types.js";
import type { TournamentRecord } from "../tournaments/types.js";
import type { DiscordPayload, WebhookPoster } from "../leagues/discord.js";
import { isDraftLeague } from "../leagues/lifecycle.js";
import { effectiveConfig, type CompetitionKind, type EffectiveDiscordConfig } from "./catalogue.js";
import type { DiscordStateStore } from "./store.js";

export interface DiscordTarget {
  kind: CompetitionKind;
  /** The ledger / config key: "league:<id>", "season:<leagueId>:<seasonId>", "tournament:<id>". */
  key: string;
  /** The competition's display name for post titles. */
  name: string;
  url?: string;
  /** The webhook in use is the parent's (the competition's own is blank). */
  inherited: boolean;
  config: EffectiveDiscordConfig;
  draft: boolean;
  test: boolean;
  leagueId?: string;
  seasonId?: string;
  tournamentId?: string;
}

export const seasonCompetitionKey = (seasonId: string): string => `season:${seasonId}`;

export function leagueEffective(league: Pick<LeagueRecord, "discordEvents" | "discord">): EffectiveDiscordConfig {
  const stored = league.discordEvents ? { ...league.discordEvents } as Partial<Record<DiscordEventKey, boolean>> : undefined;
  // Season started / finished used to ride the "milestones" toggle: a league that turned it off keeps them off.
  if (stored && stored.milestones === false) for (const k of ["seasonStarted", "seasonFinished"] as const) if (stored[k] === undefined) stored[k] = false;
  return effectiveConfig("league", { ...(league.discord ?? {}), ...(stored ? { events: stored } : {}) });
}

export function leagueTarget(store: Pick<LeagueStore, "league" | "secrets">, league: LeagueRecord): DiscordTarget {
  const fresh = store.league(league.id) ?? league;
  const url = store.secrets(league.id).discordWebhookUrl;
  return {
    kind: "league", key: `league:${league.id}`, name: fresh.name, ...(url ? { url } : {}), inherited: false,
    config: leagueEffective(fresh), draft: isDraftLeague(fresh), test: fresh.test === true, leagueId: league.id,
  };
}

export function seasonTarget(store: Pick<LeagueStore, "league" | "secrets">, league: LeagueRecord, seasonId: string): DiscordTarget {
  const fresh = store.league(league.id) ?? league;
  const secrets = store.secrets(league.id);
  const own = secrets.competitionWebhooks?.[seasonCompetitionKey(seasonId)];
  const url = own || secrets.discordWebhookUrl;
  return {
    kind: "season", key: `season:${league.id}:${seasonId}`, name: fresh.name, ...(url ? { url } : {}), inherited: !own && Boolean(url),
    config: effectiveConfig("league", fresh.competitionDiscord?.[seasonCompetitionKey(seasonId)], leagueEffective(fresh)),
    draft: isDraftLeague(fresh), test: fresh.test === true, leagueId: league.id, seasonId,
  };
}

/** An unpublished tournament is a draft (visible to its managers only): it never posts. */
export const isDraftTournament = (t: Pick<TournamentRecord, "unpublished">): boolean => t.unpublished === true;

export function tournamentTarget(state: Pick<DiscordStateStore, "config" | "webhook">, t: TournamentRecord): DiscordTarget {
  const own = state.webhook(`tournament:${t.id}`);
  const parent = t.seriesId ? state.webhook(`series:${t.seriesId}`) : undefined;
  const url = own || parent;
  return {
    kind: "tournament", key: `tournament:${t.id}`, name: t.name, ...(url ? { url } : {}), inherited: !own && Boolean(url),
    config: effectiveConfig("tournament", state.config(`tournament:${t.id}`)),
    draft: isDraftTournament(t), test: t.test === true, tournamentId: t.id,
  };
}

/** Would this event post now (published, a webhook, the toggle on)? */
export const wouldPost = (t: DiscordTarget, key: DiscordEventKey): boolean => !t.draft && Boolean(t.url) && t.config.events[key] === true;

/** Posts when the target is published, has a webhook and the event is on. Best effort; never logs the URL. */
export async function postTo(t: DiscordTarget, key: DiscordEventKey, payload: DiscordPayload, poster: WebhookPoster): Promise<boolean> {
  if (!wouldPost(t, key)) return false;
  try { return (await poster(t.url!, payload)).ok; } catch { return false; }
}

/** The same without the event toggle (end-of-game digest, Weekly Digest, samples: they have their own switch). */
export async function postRaw(t: DiscordTarget, payload: DiscordPayload, poster: WebhookPoster): Promise<boolean> {
  if (t.draft || !t.url) return false;
  try { return (await poster(t.url, payload)).ok; } catch { return false; }
}
