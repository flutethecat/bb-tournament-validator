// Mail transports: the interface every sender implements, the "log" transport (no token configured: one redacted line
// per message, nothing leaves the host) and the "memory" transport (tests and previews). Postmark lives in postmark.ts.

export interface MailHeader { name: string; value: string }

export interface MailMessage {
  /** One recipient address per message (league mail is never sent with visible co-recipients). */
  to: string;
  subject: string;
  text: string;
  html: string;
  /** The template that produced it ("league-message", "verify-email"): logs and provider tags. */
  template: string;
  headers?: MailHeader[];
  replyTo?: string;
  /** Provider message stream for this message (league mail can use its own stream); default the transport's. */
  stream?: string;
  /** Provider metadata: ids only, never addresses or names. */
  metadata?: Record<string, string>;
}

export interface MailSendResult { providerId?: string }

/**
 * A send that failed. retryable: 5xx / 429 / network / timeout. inactiveRecipient: the provider refuses this address
 * (Postmark ErrorCode 406), so the address is suppressed instead of retried.
 */
export class MailSendError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly status?: number, readonly inactiveRecipient = false) {
    super(message);
    this.name = "MailSendError";
  }
}

export interface MailTransport {
  readonly name: "postmark" | "log" | "memory";
  send(message: MailMessage): Promise<MailSendResult>;
}

/** No token configured: writes one line per message with the template and recipient count; never an address or text. */
export function createLogTransport(log: (line: string) => void = (l) => console.error(l)): MailTransport {
  let n = 0;
  return {
    name: "log",
    async send(message) {
      n += 1;
      log(`[mail] log transport: template=${message.template} recipients=1 (not sent: POSTMARK_SERVER_TOKEN unset)`);
      return { providerId: `log-${n}` };
    },
  };
}

/** Collects messages in memory (tests, previews). `fail` lets a test script errors per call. */
export class MemoryTransport implements MailTransport {
  readonly name = "memory" as const;
  readonly sent: MailMessage[] = [];
  fail?: (message: MailMessage, attempt: number) => MailSendError | undefined;
  private attempts = 0;
  async send(message: MailMessage): Promise<MailSendResult> {
    this.attempts += 1;
    const error = this.fail?.(message, this.attempts);
    if (error) throw error;
    this.sent.push(message);
    return { providerId: `mem-${this.sent.length}` };
  }
}
