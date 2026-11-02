// Discord DM transport for the outbox's "discord" channel (actionable notifications, src/mail/actionMessages.ts).
//
// config-web sends the DM itself through the Discord REST API with the bot's token (env DISCORD_BOT_TOKEN, the same
// value as the bot's DISCORD_TOKEN): POST /users/@me/channels opens (or returns) the DM channel, then
// POST /channels/<id>/messages posts the text. No gateway connection is needed here (the bot process keeps its own), and
// the coach's Discord id never leaves this process: it is read from the identity record at send time through
// `resolveUserId(coach)` and held only in memory (the DM channel cache).
//
// Errors:
//   403 (DMs closed, no shared server: Discord codes 50007 / 50278) and 10013 (unknown user): DiscordDmRefused, a
//   permanent RECIPIENT failure (the worker dead-letters the row; only this kind may trigger the email fallback).
//   Other 4xx except 401 and 429: permanent, no fallback.
//   429: waits Discord's retry_after inside the send when it is short (re-checking eligibility before the next attempt);
//   otherwise a retryable error so the outbox backs off. Bucket headers (X-RateLimit-Remaining 0 + Reset-After) hold the
//   next request until the bucket resets.
//   401 (bad token), 5xx, network errors and timeouts: retryable (a broken token must not dead-letter every DM into email).
// Eligibility is re-checked right before the message POST (after the channel open and any bucket wait), and every POST
// carries a nonce stable per outbox item with enforce_nonce, so a retry after a lost response does not post twice.
// Error messages never carry the token, the Discord id, the channel id or the message text.

import { createHash } from "node:crypto";
import { MailSendAborted, MailSendError, type MailMessage, type MailSendResult, type MailTransport } from "./transport.js";

export const DISCORD_API = "https://discord.com/api/v10";
/** Discord message content limit. */
export const DISCORD_CONTENT_MAX = 2000;
/** The longest in-send wait for a rate limit; longer waits go back to the outbox backoff. */
export const DISCORD_MAX_INLINE_WAIT_MS = 5_000;

export interface DiscordDmConfig { token?: string }

/** Only DISCORD_BOT_TOKEN is read; the value is never logged or returned. */
export function discordDmConfigFromEnv(env: Record<string, string | undefined>): DiscordDmConfig {
  const token = env.DISCORD_BOT_TOKEN?.trim();
  return token ? { token } : {};
}

export interface DiscordDmTransportOptions {
  token: string;
  /** The coach's Discord user id, read at send time (undefined = no linked Discord account: the send is abandoned). */
  resolveUserId(coach: string): string | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after the first for short rate limits and 5xx (default 2). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Discord will not deliver a DM to this user (DMs closed, no shared server, unknown user): retrying cannot help. */
export class DiscordDmRefused extends MailSendError {
  constructor(label: string, status: number) {
    super(`Discord DM refused (${label}): DMs closed or no shared server.`, false, status);
    this.name = "DiscordDmRefused";
  }
}

/** A Discord nonce (at most 25 characters) from the outbox item's stable key. */
export function discordNonce(key: string): string {
  return createHash("sha256").update(`dm:${key}`, "utf8").digest("base64url").slice(0, 25);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SNOWFLAKE = /^\d{5,25}$/;

/** Discord error codes that mean "this user cannot receive a DM from the bot". */
const DM_REFUSED_CODES = new Set([50007, 50278, 10013]);

export function createDiscordDmTransport(opts: DiscordDmTransportOptions): MailTransport {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  /** Discord user id -> DM channel id (memory only). */
  const channels = new Map<string, string>();
  /** Route key -> epoch ms before which no request goes out (bucket exhausted). */
  const holdUntil = new Map<string, number>();

  async function request(route: "open" | "post", url: string, body: unknown, beforeSend?: () => void): Promise<unknown> {
    const hold = (holdUntil.get(route) ?? 0) - now();
    if (hold > 0) {
      if (hold > DISCORD_MAX_INLINE_WAIT_MS) throw new MailSendError("Discord rate limit: waiting for the bucket to reset.", true, 429);
      await sleep(hold);
    }
    // After every await: the last chance to stop (eligibility may have changed during the open or the bucket wait).
    beforeSend?.();
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bot ${opts.token}`, "content-type": "application/json", "user-agent": "DiscordBot (super-fumbbl-config-web, 1.0)" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      throw new MailSendError(timeout ? "Discord request timed out." : "Discord request failed (network).", true);
    }
    const remaining = res.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(res.headers.get("x-ratelimit-reset-after"));
    if (remaining === "0" && Number.isFinite(resetAfter) && resetAfter > 0) holdUntil.set(route, now() + Math.ceil(resetAfter * 1000));
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* empty or non-JSON */ }
    if (res.ok) return data;
    const code = typeof data.code === "number" ? data.code : undefined;
    const label = `HTTP ${res.status}${code !== undefined ? `, code ${code}` : ""}`;
    if (res.status === 429) {
      const after = typeof data.retry_after === "number" ? data.retry_after : Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(after) && after > 0 ? Math.ceil(after * 1000) : 1_000;
      for (const r of data.global === true ? ["open", "post"] : [route]) holdUntil.set(r, now() + waitMs);
      throw new MailSendError(`Discord rate limit (${label}).`, true, 429);
    }
    if (res.status === 401 || res.status >= 500) throw new MailSendError(`Discord refused the request (${label}).`, true, res.status);
    if (res.status === 403 || (code !== undefined && DM_REFUSED_CODES.has(code))) throw new DiscordDmRefused(label, res.status);
    throw new MailSendError(`Discord refused the request (${label}).`, false, res.status);
  }

  async function deliver(userId: string, content: string, nonce: string | undefined, beforeSend: () => void): Promise<MailSendResult> {
    let channelId = channels.get(userId);
    if (!channelId) {
      const opened = await request("open", `${DISCORD_API}/users/@me/channels`, { recipient_id: userId }) as { id?: unknown };
      if (typeof opened.id !== "string" || !SNOWFLAKE.test(opened.id)) throw new MailSendError("Discord returned no DM channel.", true);
      channelId = opened.id;
      channels.set(userId, channelId);
      if (channels.size > 5_000) channels.delete(channels.keys().next().value as string);
    }
    try {
      // Plain text: mentions are never parsed (a coach name cannot ping anyone) and link previews are suppressed (flag 4).
      const body = { content, allowed_mentions: { parse: [] }, flags: 4, ...(nonce ? { nonce, enforce_nonce: true } : {}) };
      const posted = await request("post", `${DISCORD_API}/channels/${channelId}/messages`, body, beforeSend) as { id?: unknown };
      return typeof posted.id === "string" ? { providerId: posted.id } : {};
    } catch (e) {
      // A stale cached channel (deleted, or the user blocked the bot) is reopened on the next attempt.
      if (e instanceof MailSendError && (e.status === 403 || e.status === 404)) channels.delete(userId);
      throw e;
    }
  }

  return {
    name: "discord",
    async send(message: MailMessage, options) {
      const content = discordContent(message.text);
      const nonce = options?.idempotencyKey ? discordNonce(options.idempotencyKey) : undefined;
      const beforeSend = (): void => { if (options?.stillEligible && !options.stillEligible()) throw new MailSendAborted(); };
      for (let i = 0; ; i += 1) {
        // Eligibility (opt-out, unlinked Discord, deletion fence) is re-checked before every attempt, retries included.
        if (options?.stillEligible && !options.stillEligible()) throw new MailSendAborted();
        const coach = options?.recipient?.coach;
        const userId = coach ? opts.resolveUserId(coach) : undefined;
        if (!userId || !SNOWFLAKE.test(userId)) throw new MailSendAborted();
        try {
          return await deliver(userId, content, nonce, beforeSend);
        } catch (e) {
          if (e instanceof MailSendAborted) throw e;
          const err = e instanceof MailSendError ? e : new MailSendError("Discord send failed.", true);
          if (!err.retryable || i >= retries) throw err;
          const hold = Math.max(0, ...[...holdUntil.values()].map((t) => t - now()));
          if (err.status === 429 && hold > DISCORD_MAX_INLINE_WAIT_MS) throw err;
          await sleep(err.status === 429 ? hold : 500 * 2 ** i);
        }
      }
    },
  };
}

/** One message's content: control characters stripped, cut to Discord's limit. */
export function discordContent(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return [...clean].length > DISCORD_CONTENT_MAX ? `${[...clean].slice(0, DISCORD_CONTENT_MAX - 1).join("")}…` : clean;
}
