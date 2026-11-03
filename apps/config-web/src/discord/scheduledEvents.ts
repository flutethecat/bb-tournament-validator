/**
 * Discord Guild Scheduled Events for League Events (owner, grill round 1: "Can we wire this up to also create a discord
 * event when created in their discord of choice?"). The bot is an optional upgrade (creation wizards v2): with
 * DISCORD_BOT_TOKEN set, the bot in the league's Discord server (with the Manage Events permission), and the organiser's
 * "Create Discord events" on with a server picked in League settings -> External connections, each League Event keeps ONE
 * Discord scheduled event for its next occurrence (a weekly league night rolls on to the next week once one has passed).
 *
 * This module is the REST client only (no gateway): list the bot's servers and their voice / stage channels, create,
 * update and delete scheduled events. The token never leaves it (never logged, never in an error message). Tests inject
 * `fetch`; nothing here runs without a token (the caller holds no client then). The sync job that decides what to call
 * lives in src/leagues/leagueEvents.ts (runLeagueEventDiscordSync).
 */
import { DISCORD_API } from "../mail/discord.js";

/** Manage Events (1 << 33): the bot permission scheduled events need, on top of the invite's View / Send / Embed. */
export const MANAGE_EVENTS_PERMISSION = 2 ** 33;
const MANAGE_EVENTS = 1n << 33n;
const ADMINISTRATOR = 1n << 3n;

/** A member's permissions (bit field) allow managing a server's events: Administrator or Manage Events. */
export const permitsEvents = (perms: bigint): boolean => (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_EVENTS) !== 0n;

export interface GuildSummary { id: string; name: string }
export interface ChannelSummary { id: string; name: string; type: "voice" | "stage" }

/** The body of a create / update (Discord field names). */
export interface ScheduledEventBody {
  name: string;
  description: string;
  scheduled_start_time: string;
  scheduled_end_time: string;
  privacy_level: 2;
  /** 1 stage channel, 2 voice channel, 3 external (a venue, or an online event without a channel). */
  entity_type: 1 | 2 | 3;
  channel_id: string | null;
  entity_metadata: { location: string } | null;
}

export interface GuildEventsClient {
  guilds(): Promise<GuildSummary[]>;
  channels(guildId: string): Promise<ChannelSummary[]>;
  create(guildId: string, body: ScheduledEventBody): Promise<{ id: string }>;
  update(guildId: string, eventId: string, body: ScheduledEventBody): Promise<{ id: string }>;
  remove(guildId: string, eventId: string): Promise<void>;
  /** The server's scheduled events (id + description): finds one a lost create already made (the sync marker). */
  listEvents(guildId: string): Promise<Array<{ id: string; description: string }>>;
  /**
   * A user's server-wide permissions in a server, as Discord computes them for the base level: the owner has all; else the
   * @everyone role plus every role the member holds. null = not a member (or the server is unknown to the bot).
   */
  memberPermissions(guildId: string, userId: string): Promise<bigint | null>;
}

/** A failed Discord call. `retryable`: 429, 5xx, 401, 403 (permissions can be fixed) and network errors; `gone`: 404. */
export class DiscordEventsError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "DiscordEventsError";
  }
  get gone(): boolean { return this.status === 404; }
}

const SNOWFLAKE = /^\d{5,25}$/;
export const isSnowflake = (v: unknown): v is string => typeof v === "string" && SNOWFLAKE.test(v);

/** A message an organiser can act on (no token, no ids). */
export function describeDiscordError(e: unknown): string {
  if (!(e instanceof DiscordEventsError)) return "Could not reach Discord.";
  if (e.status === 403) return "The bot can't manage events in that server: give it the Manage Events permission.";
  if (e.status === 401) return "Discord refused the bot's token.";
  if (e.status === 404) return "Discord could not find that server or event.";
  if (e.status === 429) return "Discord asked us to slow down.";
  if (e.status >= 500) return "Discord is having trouble right now.";
  if (e.status === 0) return "Could not reach Discord.";
  return `Discord did not accept the event (status ${e.status}).`;
}

export interface GuildEventsClientOptions {
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createGuildEventsClient(opts: GuildEventsClientOptions): GuildEventsClient {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${DISCORD_API}${path}`, {
        method,
        headers: {
          authorization: `Bot ${opts.token}`,
          "user-agent": "DiscordBot (super-fumbbl-config-web, 1.0)",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new DiscordEventsError("Discord request failed (network).", 0, true);
    }
    if (res.status === 204) return undefined;
    let data: unknown;
    try { data = await res.json(); } catch { data = undefined; }
    if (res.ok) return data;
    const status = res.status;
    const retryable = status === 429 || status === 401 || status === 403 || status >= 500;
    throw new DiscordEventsError(`Discord refused the request (HTTP ${status}).`, status, retryable);
  }

  const idOf = (data: unknown): { id: string } => {
    const id = (data as { id?: unknown } | undefined)?.id;
    if (!isSnowflake(id)) throw new DiscordEventsError("Discord answered without an event id.", 502, true);
    return { id };
  };

  return {
    async guilds() {
      const list = await call("GET", "/users/@me/guilds?limit=200");
      if (!Array.isArray(list)) return [];
      return list
        .map((g) => ({ id: (g as { id?: unknown }).id, name: (g as { name?: unknown }).name }))
        .filter((g): g is GuildSummary => isSnowflake(g.id) && typeof g.name === "string")
        .map((g) => ({ id: g.id, name: g.name.slice(0, 100) }));
    },
    async channels(guildId) {
      if (!isSnowflake(guildId)) return [];
      const list = await call("GET", `/guilds/${guildId}/channels`);
      if (!Array.isArray(list)) return [];
      const out: ChannelSummary[] = [];
      for (const c of list as Array<{ id?: unknown; name?: unknown; type?: unknown }>) {
        // 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE: the only channels a scheduled event can be held in.
        if (!isSnowflake(c.id) || typeof c.name !== "string" || (c.type !== 2 && c.type !== 13)) continue;
        out.push({ id: c.id, name: c.name.slice(0, 100), type: c.type === 13 ? "stage" : "voice" });
      }
      return out;
    },
    async create(guildId, body) {
      return idOf(await call("POST", `/guilds/${guildId}/scheduled-events`, body));
    },
    async update(guildId, eventId, body) {
      return idOf(await call("PATCH", `/guilds/${guildId}/scheduled-events/${eventId}`, body));
    },
    async remove(guildId, eventId) {
      await call("DELETE", `/guilds/${guildId}/scheduled-events/${eventId}`);
    },
    async listEvents(guildId) {
      const list = await call("GET", `/guilds/${guildId}/scheduled-events`);
      if (!Array.isArray(list)) return [];
      return (list as Array<{ id?: unknown; description?: unknown }>)
        .filter((e) => isSnowflake(e.id))
        .map((e) => ({ id: e.id as string, description: typeof e.description === "string" ? e.description : "" }));
    },
    async memberPermissions(guildId, userId) {
      if (!isSnowflake(guildId) || !isSnowflake(userId)) return null;
      let member: unknown;
      try { member = await call("GET", `/guilds/${guildId}/members/${userId}`); } catch (e) {
        if (e instanceof DiscordEventsError && (e.status === 404 || e.status === 403)) return null;
        throw e;
      }
      const guild = (await call("GET", `/guilds/${guildId}`)) as { owner_id?: unknown } | undefined;
      if (guild?.owner_id === userId) return ADMINISTRATOR | MANAGE_EVENTS;
      const roles = (await call("GET", `/guilds/${guildId}/roles`)) as Array<{ id?: unknown; permissions?: unknown }> | undefined;
      const held = new Set([guildId, ...(((member as { roles?: unknown })?.roles as unknown[] | undefined) ?? []).filter((r): r is string => typeof r === "string")]);
      let perms = 0n;
      for (const r of Array.isArray(roles) ? roles : []) {
        if (typeof r.id !== "string" || !held.has(r.id) || typeof r.permissions !== "string" || !/^\d{1,25}$/.test(r.permissions)) continue;
        perms |= BigInt(r.permissions);
      }
      return perms;
    },
  };
}

/** Backoff after the n-th failed attempt (1-based): 30 s, 2 min, 10 min, 30 min, 2 h, then 6 h. */
export function discordRetryDelayMs(attempt: number): number {
  const steps = [30_000, 120_000, 600_000, 1_800_000, 7_200_000];
  return steps[Math.max(0, attempt - 1)] ?? 21_600_000;
}

/** After this many failed attempts a sync stops retrying (shown as failed) until the event is edited again. */
export const DISCORD_SYNC_MAX_ATTEMPTS = 8;
