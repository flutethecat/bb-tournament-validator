/**
 * League Discord webhook (League settings, External connections). The webhook URL is a secret: it is stored in the
 * league's secrets.json, masked in every read model (maskWebhookUrl), never logged and never put in an error message.
 * Posts are small embeds with mentions disabled; delivery is best effort.
 */
import { defaultEvents } from "../discord/catalogue.js";
import { DISCORD_EVENT_KEYS, type DiscordEventKey, type DiscordEvents, type LeagueRecord } from "./types.js";

/** https://discord.com/api/webhooks/<id>/<token> (also discordapp.com and the ptb / canary hosts). */
export const DISCORD_WEBHOOK_URL = /^https:\/\/(?:(?:ptb|canary)\.)?(?:discord|discordapp)\.com\/api(?:\/v\d{1,2})?\/webhooks\/\d{5,25}\/[A-Za-z0-9_-]{20,120}$/;
export const DISCORD_URL_MAX = 300;

/** League defaults (src/discord/catalogue.ts): match started is ON for leagues (owner round 2b). */
export const DEFAULT_DISCORD_EVENTS: DiscordEvents = defaultEvents("league");

export const DISCORD_EVENT_LABEL: Record<DiscordEventKey, string> = {
  news: "News",
  fixtureCreated: "Fixture created",
  matchStarted: "Match started",
  matchResult: "Match result",
  milestones: "Redraft and season milestones",
  redraftRolls: "Redraft rolls (each Rest & Relaxation roll)",
  published: "Published",
  registrationOpened: "Registration opened",
  newRegistration: "New registration",
  registrationClosing: "Registration closing in 24 hours",
  checkInOpen: "Check-in open",
  roundPosted: "Round / pairings posted",
  fixtureStart: "Fixture start notification",
  roundStandings: "Standings after each round",
  finalStandings: "Final standings and champion",
  awards: "Awards and honours",
  seasonStarted: "Season started",
  seasonFinished: "Season finished",
  touchdown: "Touchdown",
  casualty: "Casualty",
  injury: "Injury",
  death: "Player death",
  foul: "Foul",
  sentOff: "Sent off",
  mvp: "MVP",
  hireFire: "Hire / fire",
};

export function isDiscordWebhookUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= DISCORD_URL_MAX && DISCORD_WEBHOOK_URL.test(url.trim());
}

/** The only form of the URL a read model carries: `https://discord.com/api/webhooks/…/•••` ("" when unset). */
export function maskWebhookUrl(url: string | undefined): string {
  if (!url) return "";
  const host = /^https:\/\/([a-z.]+)\//.exec(url)?.[1] ?? "discord.com";
  return `https://${host}/api/webhooks/…/•••`;
}

export function discordEvents(league: Pick<LeagueRecord, "discordEvents">): DiscordEvents {
  const out = { ...DEFAULT_DISCORD_EVENTS };
  for (const k of DISCORD_EVENT_KEYS) if (typeof league.discordEvents?.[k] === "boolean") out[k] = league.discordEvents[k];
  return out;
}

export interface DiscordEmbed { title: string; description: string; color: number; url?: string; footer?: { text: string }; fields?: Array<{ name: string; value: string; inline?: boolean }> }
export interface DiscordPayload { username: string; content?: string; embeds: DiscordEmbed[]; allowed_mentions: { parse: never[] } }

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const BRAND = "Super FUMBBL";
const GOLD = 0xe8b02c;

/** The "Send test post" embed. */
export function buildTestPost(league: Pick<LeagueRecord, "name" | "fullName">, coach: string, siteUrl = ""): DiscordPayload {
  return {
    username: BRAND,
    embeds: [{
      title: clip(`${league.name}: Discord connected`, 256),
      description: clip(`${coach || "An organiser"} connected ${league.fullName || league.name} to this channel. League news, fixtures, results and season milestones will post here.`, 2000),
      color: GOLD,
      ...(siteUrl ? { url: siteUrl } : {}),
      footer: { text: "Test post from League settings" },
    }],
    allowed_mentions: { parse: [] },
  };
}

/** Season milestone (started / finished). */
export function buildMilestonePost(league: Pick<LeagueRecord, "name">, kind: "season-started" | "season-finished", seasonName: string, ruleset = ""): DiscordPayload {
  const title = kind === "season-started" ? `${league.name}: ${seasonName} has started` : `${league.name}: ${seasonName} is finished`;
  const description = kind === "season-started" ? `A new season is under way${ruleset ? ` (${ruleset})` : ""}.` : "The season is closed. Final standings and honours are on the league page.";
  return { username: BRAND, embeds: [{ title: clip(title, 256), description, color: GOLD }], allowed_mentions: { parse: [] } };
}

/** Redraft news (board confirmed, a draft list submitted, redraft closed). */
export function buildRedraftPost(league: Pick<LeagueRecord, "name">, title: string, description: string): DiscordPayload {
  return { username: BRAND, embeds: [{ title: clip(`${league.name}: ${title}`, 256), description: clip(description, 2000), color: GOLD }], allowed_mentions: { parse: [] } };
}

/** Fixture news (generated on Super FUMBBL, a Super FUMBBL result). */
export function buildFixturePost(league: Pick<LeagueRecord, "name">, title: string, description: string): DiscordPayload {
  return { username: BRAND, embeds: [{ title: clip(`${league.name}: ${title}`, 256), description: clip(description, 2000), color: GOLD }], allowed_mentions: { parse: [] } };
}

export type WebhookPoster = (url: string, payload: DiscordPayload) => Promise<{ ok: boolean; status: number }>;

/** POST the payload (5 s timeout). Never logs; the caller reports only the status. */
export const postWebhook: WebhookPoster = async (url, payload) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: ctl.signal, redirect: "error" });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
};
