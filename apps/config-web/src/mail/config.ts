// Portal mail configuration (docs/mail/setup.md). Only these env keys are read; values are never logged or returned.
//
//   POSTMARK_SERVER_TOKEN    Postmark server API token. Unset = the "log" transport (nothing leaves the host).
//   MAIL_STREAM              Postmark message stream, default "outbound" (transactional: verification email).
//   MAIL_LEAGUE_STREAM       Optional stream for league messages (a Postmark Broadcasts stream); default MAIL_STREAM.
//   MAIL_FROM                From address (a noreply@ address on the site domain). Display name is always "Super FUMBBL".
//   MAIL_REPLY_TO            Optional Reply-To address.
//   MAIL_LINK_SECRET         HMAC key for unsubscribe / verification links (>= 32 chars). Unset = a random key kept in
//                            <state>/mail/link.key (links stay valid across restarts on that host).
//   MAIL_LINK_BASE_URL       Absolute origin for links in emails; falls back to PUBLIC_BASE_URL. Neither = no email
//                            (league messages still reach the in-portal notifications).
//   POSTMARK_WEBHOOK_SECRET  Basic-auth password Postmark sends to POST /api/mail/postmark/webhook. Unset = 503.

import { publicOriginOf } from "../publicOrigin.js";

export const MAIL_FROM_NAME = "Super FUMBBL";

export interface MailConfig {
  transport: "postmark" | "log";
  postmarkToken?: string;
  stream: string;
  leagueStream: string;
  /** Bare address (no display name). */
  from?: string;
  replyTo?: string;
  linkSecret?: string;
  /** Validated http(s) origin, no trailing slash. */
  linkBase?: string;
  webhookSecret?: string;
}

const ADDRESS = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function isEmailAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && ADDRESS.test(value);
}

const origin = publicOriginOf;

export function mailConfigFromEnv(env: Record<string, string | undefined> = process.env): MailConfig {
  const token = env.POSTMARK_SERVER_TOKEN?.trim() || undefined;
  const from = env.MAIL_FROM?.trim();
  const replyTo = env.MAIL_REPLY_TO?.trim();
  const secret = env.MAIL_LINK_SECRET?.trim();
  const stream = env.MAIL_STREAM?.trim();
  const streamOk = (v: string | undefined): v is string => Boolean(v && /^[\w-]{1,64}$/.test(v));
  const leagueStream = env.MAIL_LEAGUE_STREAM?.trim();
  const linkBase = origin(env.MAIL_LINK_BASE_URL) ?? origin(env.PUBLIC_BASE_URL);
  return {
    transport: token ? "postmark" : "log",
    ...(token ? { postmarkToken: token } : {}),
    stream: streamOk(stream) ? stream : "outbound",
    leagueStream: streamOk(leagueStream) ? leagueStream : streamOk(stream) ? stream : "outbound",
    ...(isEmailAddress(from) ? { from } : {}),
    ...(isEmailAddress(replyTo) ? { replyTo } : {}),
    ...(secret && secret.length >= 32 ? { linkSecret: secret } : {}),
    ...(linkBase ? { linkBase } : {}),
    ...(env.POSTMARK_WEBHOOK_SECRET?.trim() ? { webhookSecret: env.POSTMARK_WEBHOOK_SECRET.trim() } : {}),
  };
}

/** Startup warnings: names of problems only, never values. */
export function mailConfigWarnings(env: Record<string, string | undefined>, cfg: MailConfig): string[] {
  const out: string[] = [];
  if (cfg.transport === "postmark" && !cfg.from) out.push("MAIL_FROM is unset or not an address: email is off.");
  if (env.MAIL_LINK_SECRET?.trim() && !cfg.linkSecret) out.push("MAIL_LINK_SECRET is shorter than 32 characters: using the host key file.");
  if (!cfg.linkBase) out.push("Neither MAIL_LINK_BASE_URL nor PUBLIC_BASE_URL is a valid origin: email is off.");
  return out;
}
