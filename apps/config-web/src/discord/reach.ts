/**
 * Can the bot reach this coach by DM? (wizards v2 round 5: "Join the Super FUMBBL Discord" when the coach shares no server
 * with the bot). Discord delivers a bot DM only to a user who shares a server with the bot, so with DISCORD_BOT_TOKEN set
 * we ask Discord: the bot's servers (GET /users/@me/guilds), then whether the coach is a member of one of them
 * (GET /guilds/<id>/members/<user>). Without the token the answer is "unknown" (null) and nothing is asked.
 *
 *   GET /api/me/discord-reach   the signed-in coach's own state: { dm, sharesServer, inviteUrl, accountUrl }
 *
 * The coach's Discord id and the bot token never leave this module (never answered, never logged); results are cached in
 * memory for ten minutes per coach so a page load never fans out to Discord.
 */
import { DISCORD_API } from "../mail/discord.js";

export interface ReachDeps {
  /** DISCORD_BOT_TOKEN (unset = unknown, no request). */
  token?: string;
  /** DISCORD_INVITE_URL: the Super FUMBBL Discord invite (unset = no invite line). */
  inviteUrl?: string;
  /** The coach's linked Discord id (server side only). */
  discordUserId(coach: string): string | undefined;
  /** The coach's Account choice "Discord messages for actions I need to take" (absent = on). */
  dmOn(coach: string): boolean;
  /** DMs can go out at all (token + link origin). */
  dmAvailable(): boolean;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface ReachStatus {
  /** on = DMs will reach this coach (if they share a server); off = opted out; unlinked = no Discord linked; inactive = DMs not set up. */
  dm: "on" | "off" | "unlinked" | "inactive";
  /** true / false when Discord was asked; null = unknown (no bot token, or Discord did not answer). */
  sharesServer: boolean | null;
  inviteUrl: string | null;
  accountUrl: string;
}

const TTL_MS = 10 * 60_000;
const MAX_GUILDS = 25;

/** An invite link we are willing to show (discord.gg / discord.com/invite only). */
export function safeInviteUrl(url: string | undefined): string | null {
  const v = url?.trim();
  return v && /^https:\/\/(?:discord\.gg\/[A-Za-z0-9-]{2,40}|(?:www\.)?discord\.com\/invite\/[A-Za-z0-9-]{2,40})$/.test(v) ? v : null;
}

export function createDiscordReach(deps: ReachDeps) {
  const doFetch = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  let guilds: { at: number; ids: string[] } | undefined;
  const cache = new Map<string, { at: number; shares: boolean | null }>();

  async function get(url: string): Promise<Response | undefined> {
    try {
      return await doFetch(url, { headers: { authorization: `Bot ${deps.token}`, "user-agent": "DiscordBot (super-fumbbl-config-web, 1.0)" }, signal: AbortSignal.timeout(5000) });
    } catch { return undefined; }
  }

  async function botGuilds(): Promise<string[] | undefined> {
    if (guilds && now() - guilds.at < TTL_MS) return guilds.ids;
    const r = await get(`${DISCORD_API}/users/@me/guilds?limit=${MAX_GUILDS}`);
    if (!r?.ok) return undefined;
    try {
      const list = (await r.json()) as Array<{ id?: unknown }>;
      const ids = Array.isArray(list) ? list.map((g) => g.id).filter((id): id is string => typeof id === "string" && /^\d{5,25}$/.test(id)).slice(0, MAX_GUILDS) : [];
      guilds = { at: now(), ids };
      return ids;
    } catch { return undefined; }
  }

  async function sharesServer(userId: string): Promise<boolean | null> {
    const hit = cache.get(userId);
    if (hit && now() - hit.at < TTL_MS) return hit.shares;
    const ids = await botGuilds();
    let shares: boolean | null = ids ? false : null;
    for (const g of ids ?? []) {
      const r = await get(`${DISCORD_API}/guilds/${g}/members/${userId}`);
      if (r?.ok) { shares = true; break; }
      if (!r || (r.status !== 404 && r.status !== 403)) { shares = null; break; }
    }
    cache.set(userId, { at: now(), shares });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return shares;
  }

  return {
    async status(coach: string): Promise<ReachStatus> {
      const base = { inviteUrl: safeInviteUrl(deps.inviteUrl), accountUrl: "/app/account#notifications" };
      const userId = deps.discordUserId(coach);
      if (!userId || !/^\d{5,25}$/.test(userId)) return { dm: "unlinked", sharesServer: null, ...base };
      const dm = !deps.dmAvailable() ? "inactive" : deps.dmOn(coach) ? "on" : "off";
      if (!deps.token) return { dm, sharesServer: null, ...base };
      return { dm, sharesServer: await sharesServer(userId), ...base };
    },
  };
}
