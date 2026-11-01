// Postmark HTTP adapter: POST https://api.postmarkapp.com/email with the server token. 10 s timeout per attempt;
// retries with exponential backoff on 5xx, 429 and network errors / timeouts; never on other 4xx (a 422 is a message
// problem the same request would hit again). The caller's stillEligible check runs before every attempt, retries included.
// Errors never carry the token, the address or the message text.

import { MAIL_FROM_NAME } from "./config.js";
import { MailSendAborted, MailSendError, type MailMessage, type MailSendResult, type MailTransport } from "./transport.js";

export const POSTMARK_EMAIL_URL = "https://api.postmarkapp.com/email";
/** Postmark ErrorCode for "recipient marked inactive" (hard bounce, complaint or manual suppression). */
export const POSTMARK_INACTIVE_RECIPIENT = 406;

export interface PostmarkOptions {
  token: string;
  from: string;
  stream?: string;
  replyTo?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Extra attempts after the first (default 3). */
  retries?: number;
  /** Base backoff (default 500 ms, doubled each attempt, with up to 25% jitter). */
  backoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** The Postmark request body for one message (exported for tests). */
export function postmarkBody(message: MailMessage, opts: Pick<PostmarkOptions, "from" | "stream" | "replyTo">): Record<string, unknown> {
  const replyTo = message.replyTo ?? opts.replyTo;
  return {
    From: `${MAIL_FROM_NAME} <${opts.from}>`,
    To: message.to,
    Subject: message.subject,
    TextBody: message.text,
    HtmlBody: message.html,
    MessageStream: message.stream ?? opts.stream ?? "outbound",
    Tag: message.template,
    TrackOpens: false,
    TrackLinks: "None",
    ...(replyTo ? { ReplyTo: replyTo } : {}),
    ...(message.headers?.length ? { Headers: message.headers.map((h) => ({ Name: h.name, Value: h.value })) } : {}),
    ...(message.metadata && Object.keys(message.metadata).length ? { Metadata: message.metadata } : {}),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createPostmarkTransport(opts: PostmarkOptions): MailTransport {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retries = opts.retries ?? 3;
  const backoff = opts.backoffMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  async function attempt(body: string): Promise<MailSendResult> {
    let res: Response;
    try {
      res = await doFetch(POSTMARK_EMAIL_URL, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "x-postmark-server-token": opts.token },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timeout = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      throw new MailSendError(timeout ? "Postmark request timed out." : "Postmark request failed (network).", true);
    }
    let data: { ErrorCode?: unknown; MessageID?: unknown } = {};
    try { data = (await res.json()) as typeof data; } catch { /* non-JSON */ }
    if (res.ok && (data.ErrorCode === undefined || data.ErrorCode === 0)) {
      return typeof data.MessageID === "string" ? { providerId: data.MessageID } : {};
    }
    const code = typeof data.ErrorCode === "number" ? data.ErrorCode : undefined;
    const retryable = res.status >= 500 || res.status === 429;
    throw new MailSendError(`Postmark refused the message (HTTP ${res.status}${code !== undefined ? `, code ${code}` : ""}).`, retryable, res.status, code === POSTMARK_INACTIVE_RECIPIENT);
  }

  return {
    name: "postmark",
    async send(message, options) {
      const body = JSON.stringify(postmarkBody(message, opts));
      for (let i = 0; ; i += 1) {
        // Eligibility can change during the backoff (a complaint, a withdrawn consent): re-checked before every attempt.
        if (options?.stillEligible && !options.stillEligible()) throw new MailSendAborted();
        try {
          return await attempt(body);
        } catch (e) {
          const err = e as MailSendError;
          if (!err.retryable || i >= retries) throw err;
          const wait = backoff * 2 ** i;
          await sleep(wait + Math.floor(Math.random() * wait * 0.25));
        }
      }
    },
  };
}
