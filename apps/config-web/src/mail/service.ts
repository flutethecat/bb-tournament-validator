// Portal mail service: wires config, transport, outbox + worker, suppression, prefs, links and the recipient seam, and
// answers the mail routes:
//
//   POST /api/mail/postmark/webhook   Postmark bounce / spam complaint / subscription change (Basic auth: the password
//                                     must equal POSTMARK_WEBHOOK_SECRET). Public path; 503 while the secret is unset.
//   GET  /api/mail/unsubscribe?token= confirmation page with one button (a GET never changes anything: mail scanners
//                                     prefetch links).
//   POST /api/mail/unsubscribe        token in the query (RFC 8058 one-click from the List-Unsubscribe header, body
//                                     "List-Unsubscribe=One-Click") or in a form body (the page's button). Turns league
//                                     mail off for that coach.
//   GET  /api/mail/verify?token=      marks the pending address verified.
//   GET  /api/me/email                the session coach's own mail status (their own address only).
//   POST /api/me/email/verify         { email? } sends a verification link (email omitted = the identity contact email).
//   GET  /api/me/notification-settings  the coach's Discord DM choice (never the Discord id) and whether email fallback
//                                       would apply.
//   POST /api/me/notification-settings  { discordDm: boolean } "Discord messages for actions I need to take".
//
// Discord DMs (owner 11-01, laws §E 23c): an actionable notification (src/mail/actionMessages.ts) also goes out as a bot
// DM through the outbox's "discord" channel (src/mail/discord.ts) when DISCORD_BOT_TOKEN and a link origin are set, the
// coach has Discord linked and has not opted out (on by default). If Discord refuses the DM for good (DMs closed, no
// shared server, unknown user; NOT a retryable failure that ran out of retries), it falls back to ONE email, only with the coach's email consent (league-contact consent, a confirmed
// address, no unsubscribe since, not suppressed), re-checked again at send time.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { isEmailAddress, mailConfigFromEnv, type MailConfig } from "./config.js";
import { actionDmText } from "./actionMessages.js";
import { createDiscordDmTransport, discordDmConfigFromEnv, DiscordDmRefused } from "./discord.js";
import { isCoachFenced } from "../privacy/fence.js";
import type { NotificationInput, NotificationRecord } from "../notifications.js";
import { MailWorker, Outbox, type OutboxEntry, type OutboxItem, type RecheckResult } from "./outbox.js";
import { createPostmarkTransport } from "./postmark.js";
import {
  createDefaultRecipientResolver, identityMailFields, type ContactWriter, type RecipientResolver,
} from "./recipients.js";
import { MailAuditLog, mailCoachKey, MailPrefsStore, normalizeAddress, SuppressionStore, type SuppressionReason } from "./stores.js";
import { linkPage, renderActionEmail, renderVerifyEmail } from "./templates.js";
import { hostKey, signLink, UNSUBSCRIBE_TTL_S, verifyLink, VERIFY_TTL_S } from "./tokens.js";
import { createLogTransport, type MailMessage, type MailTransport } from "./transport.js";

export interface MailRouteResult {
  status: number;
  json?: unknown;
  html?: string;
  headers?: Record<string, string>;
}

export interface MailServiceDeps {
  /** Identity record for a coach (unknown shape: the resolver reads optional onboarding fields). */
  identity(coach: string): unknown;
  /** Plug the onboarding lane's contactFor() in here (a factory gets the prefs store); default reads the identity fields. */
  resolver?: RecipientResolver | ((prefs: MailPrefsStore) => RecipientResolver);
  /** Identity-side writes (unsubscribe, verification); default no-op. */
  contactWriter?: ContactWriter;
  transport?: MailTransport;
  /** The Discord DM transport (tests); default: the Discord REST transport when DISCORD_BOT_TOKEN is set. */
  discordTransport?: MailTransport;
  /** The coach's Discord user id (default: identities.discordUserId on the identity record). Server-side only. */
  discordUserId?: (coach: string) => string | undefined;
  /** The Discord transport's wait between its own retries (tests). */
  discordSleep?: (ms: number) => Promise<void>;
  /** For the Postmark adapter (tests). */
  fetch?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
  ratePerSecond?: number;
  leagueDailyCap?: number;
}

export interface MeMailAuth { coach: string; test?: boolean }

/** Verification requests per coach per hour, and the minimum gap between two. */
export const VERIFY_MAX_PER_HOUR = 5;
export const VERIFY_MIN_GAP_MS = 60_000;

/** The Account page wording of the Discord DM choice, and its version (stamped on every saved choice). */
export const DISCORD_DM_TEXT = "Discord messages for actions I need to take";
export const DISCORD_DM_VERSION = "2026-11-01";
const NOTIFICATION_SETTINGS_PATH = "/api/me/notification-settings";

const NO_STORE = { "cache-control": "no-store" };
const page = (status: number, title: string, message: string, form?: Parameters<typeof linkPage>[2]): MailRouteResult => ({
  status, html: linkPage(title, message, form), headers: { ...NO_STORE, "referrer-policy": "no-referrer", "x-robots-tag": "noindex" },
});
const jsonErr = (status: number, error: string): MailRouteResult => ({ status, json: { error }, headers: NO_STORE });

export type MailService = ReturnType<typeof createMailService>;

export function createMailService(stateDir: string, env: Record<string, string | undefined>, deps: MailServiceDeps) {
  const dir = join(stateDir, "mail");
  const config: MailConfig = mailConfigFromEnv(env);
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((l: string) => console.error(l));
  const linkSecret = config.linkSecret ?? hostKey(join(dir, "link.key"));
  const suppression = new SuppressionStore(dir, () => new Date(now()));
  const prefs = new MailPrefsStore(dir);
  const audit = new MailAuditLog(dir);
  const outbox = new Outbox(dir, now);
  const transport: MailTransport = deps.transport
    ?? (config.transport === "postmark" && config.postmarkToken && config.from
      ? createPostmarkTransport({ token: config.postmarkToken, from: config.from, stream: config.stream, ...(config.replyTo ? { replyTo: config.replyTo } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) })
      : createLogTransport(log));
  const resolver: RecipientResolver = typeof deps.resolver === "function"
    ? deps.resolver(prefs)
    : deps.resolver ?? createDefaultRecipientResolver({ identity: deps.identity, prefs });
  const writer: ContactWriter = deps.contactWriter ?? { revokeLeagueContact() {}, markEmailVerified() {} };

  // ---- Discord DMs --------------------------------------------------------------------------------------------------

  const objOf = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
  /** The coach's Discord user id, read fresh every time (never stored by the mailer, never returned or logged). */
  function discordUserIdOf(coach: string): string | undefined {
    if (deps.discordUserId) return deps.discordUserId(coach);
    let record: Record<string, unknown> | undefined;
    try { record = objOf(deps.identity(coach)); } catch { return undefined; }
    if (!record || record.banned === true) return undefined;
    const id = objOf(record.identities)?.discordUserId;
    return typeof id === "string" && /^\d{5,25}$/.test(id) ? id : undefined;
  }
  const discordConfig = discordDmConfigFromEnv(env);
  const discordTransport: MailTransport | undefined = deps.discordTransport
    ?? (discordConfig.token ? createDiscordDmTransport({ token: discordConfig.token, resolveUserId: discordUserIdOf, ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.discordSleep ? { sleep: deps.discordSleep } : {}) }) : undefined);
  /** DMs can go out: a transport and absolute links. */
  const discordEnabled = (): boolean => Boolean(discordTransport) && Boolean(config.linkBase);
  /** The coach's choice (absent = on, owner 11-01). */
  const discordDmOn = (coach: string): boolean => prefs.get(coach).discordDm?.on ?? true;
  /** May this coach get a Discord DM now: not being deleted, Discord linked, not opted out. */
  function discordDmEligible(coach: string | undefined): RecheckResult {
    if (!coach || isCoachFenced(coach)) return { ok: false, reason: "noConsent" };
    if (!discordUserIdOf(coach)) return { ok: false, reason: "unverified" };
    return discordDmOn(coach) ? { ok: true } : { ok: false, reason: "noConsent" };
  }
  /**
   * Email for an actionable notification (only the DM fallback): the coach's existing email consent (league-contact
   * consent granted and no unsubscribe-link opt-out since), a confirmed address (equal to `address` when given: the one
   * a queued row goes to) and no suppression. Returns the address, or why not.
   */
  function actionEmailCheck(coach: string, address?: string): { ok: true; address: string } | Exclude<RecheckResult, { ok: true }> {
    if (isCoachFenced(coach)) return { ok: false, reason: "noConsent" };
    let fields: ReturnType<typeof identityMailFields> | undefined;
    try { fields = identityMailFields(deps.identity(coach)); } catch { /* no identity */ }
    if (!fields || fields.banned || !fields.leagueContact) return { ok: false, reason: "noConsent" };
    const optOut = Date.parse(prefs.get(coach).leagueMailOff?.at ?? "");
    if (Number.isFinite(optOut) && !(consentAt(coach) > optOut)) return { ok: false, reason: "noConsent" };
    const contact = resolver.resolve(coach);
    if (!contact?.email || !contact.verified) return { ok: false, reason: "unverified" };
    if (address !== undefined && normalizeAddress(contact.email) !== normalizeAddress(address)) return { ok: false, reason: "unverified" };
    if (suppression.isSuppressed(contact.email)) return { ok: false, reason: "suppressed" };
    return { ok: true, address: contact.email };
  }
  /**
   * Send-time re-check (consent may be withdrawn while a message waits in the queue or between retries): league mail
   * needs the same consent, acknowledgement, verified address (unchanged since queueing) and no suppression as at
   * enqueue; every message needs an unsuppressed address (except a re-verification the coach asked for, and only while
   * no complaint is newer than their re-consent). Fails closed: a league row that does not name its coach and league
   * (an older journal row) is re-checked by the coach in its key, or dropped.
   */
  function recheck(entry: OutboxEntry): RecheckResult {
    if (entry.channel === "discord") return discordDmEligible(entry.recipient?.coach);
    if (entry.template === "action-email") {
      const coach = entry.recipient?.coach;
      if (!coach) return { ok: false, reason: "noConsent" };
      const check = actionEmailCheck(coach, entry.message?.to ?? "");
      return check.ok ? { ok: true } : check;
    }
    const to = entry.message?.to ?? "";
    const league = isLeagueEntry(entry);
    if (league) {
      const target = leagueTarget(entry);
      if (!target) return { ok: false, reason: "noConsent" };
      const contact = resolver.resolve(target.coach);
      if (!contact || !contact.canReceiveLeagueMail(target.leagueId)) return { ok: false, reason: "noConsent" };
      if (!contact.email || !contact.verified || normalizeAddress(contact.email) !== normalizeAddress(to)) return { ok: false, reason: "unverified" };
    }
    const sup = suppression.entry(to);
    if (sup) {
      const coach = entry.recipient?.coach;
      const reverifyOk = !league && entry.reverify === true && coach !== undefined && sup.reason === "complaint" && consentAt(coach) > Date.parse(sup.at);
      if (!reverifyOk) return { ok: false, reason: "suppressed" };
    }
    return { ok: true };
  }

  /** League mail: any row tied to a league or a league message, whatever fields an older journal row carries. */
  function isLeagueEntry(entry: OutboxEntry): boolean {
    return Boolean(entry.recipient?.leagueId || entry.leagueId || entry.auditId || entry.template === "league-message" || entry.key.startsWith("league:"));
  }

  /** The coach and league a league row is for: its recipient, else parsed from its key (league:<league>:<message>:<coach>). */
  function leagueTarget(entry: OutboxEntry): { coach: string; leagueId: string } | undefined {
    const leagueId = entry.recipient?.leagueId ?? entry.leagueId;
    if (!leagueId) return undefined;
    if (entry.recipient?.coach) return { coach: entry.recipient.coach, leagueId };
    const prefix = `league:${leagueId}:`;
    if (!entry.key.startsWith(prefix)) return undefined;
    const rest = entry.key.slice(prefix.length);
    const cut = rest.indexOf(":");
    const coach = cut > 0 ? rest.slice(cut + 1) : "";
    return coach ? { coach, leagueId } : undefined;
  }

  /** A Discord DM the recipient cannot receive: ONE email instead, only with the coach's email consent (key-idempotent). */
  function discordFallback(entry: OutboxEntry): void {
    const coach = entry.recipient?.coach;
    if (entry.channel !== "discord" || !coach || !entry.message || !entry.key.startsWith("action:dm:") || !emailEnabled()) return;
    const check = actionEmailCheck(coach);
    if (!check.ok) return;
    const url = typeof entry.message.metadata?.url === "string" ? entry.message.metadata.url : absolute("/app/");
    const rendered = renderActionEmail({ coach, title: entry.message.subject, text: entry.message.metadata?.plain ?? entry.message.text, url, unsubscribeUrl: unsubscribeUrl(coach, undefined, check.address) });
    enqueue([{
      key: `action:email:${entry.key.slice("action:dm:".length)}`,
      message: { to: check.address, subject: rendered.subject, text: rendered.text, html: rendered.html, headers: rendered.headers, template: "action-email", stream: config.stream },
      recipient: { coach },
    }]);
  }

  /**
   * An actionable notification was stored (NotificationStore onAdded): queue the bot DM when its type DMs
   * (src/mail/actionMessages.ts), DMs are set up, and the coach has Discord linked and has not opted out.
   */
  function notifyAction(coach: string, record: NotificationRecord, input?: Pick<NotificationInput, "subject">): boolean {
    if (!discordEnabled() || !discordDmEligible(coach).ok) return false;
    const url = absolute(record.link.startsWith("/") ? record.link : "/app/");
    const dm = actionDmText({ record, ...(input?.subject ? { subject: input.subject } : {}), url });
    if (!dm) return false;
    const r = enqueue([{
      key: `action:dm:${mailCoachKey(coach)}:${record.id}:${record.at}`,
      channel: "discord",
      // No address and no Discord id: the transport resolves the id from the recipient at send time.
      message: { to: "", subject: record.title, text: dm.text, html: "", template: "action-dm", metadata: { type: record.type, url, plain: dm.plain } },
      recipient: { coach },
    }]);
    return r.added > 0;
  }

  const worker = new MailWorker({
    outbox, transports: { email: transport, ...(discordTransport ? { discord: discordTransport } : {}) }, now, log, recheck,
    // Only a permanent RECIPIENT refusal (DMs closed, no shared server, unknown user) falls back to email; a retryable
    // failure that ran out of retries (Discord down, bad token, rate limits) is dead-lettered without email.
    onFailed: (entry, error) => { if (entry.channel === "discord" && error instanceof DiscordDmRefused) discordFallback(entry); },
    onDropped: (entry, reason) => {
      if (entry.auditId && entry.leagueId) audit.recordDrop({ id: entry.auditId, leagueId: entry.leagueId, at: new Date(now()).toISOString(), reason });
    },
    onInactive: (a) => suppression.suppress(a, "inactive"),
    ...(deps.ratePerSecond ? { ratePerSecond: deps.ratePerSecond } : {}),
    ...(deps.leagueDailyCap ? { leagueDailyCap: deps.leagueDailyCap } : {}),
  });
  const verifyHits = new Map<string, number[]>();

  /** Email can go out: links can be absolute, and a real transport has a From address (the log transport always can). */
  const emailEnabled = (): boolean => Boolean(config.linkBase) && !(config.transport === "postmark" && !config.from && !deps.transport);
  const absolute = (path: string): string => `${config.linkBase ?? ""}${path}`;

  /** Keyed short hash of an address for link binding (never the address itself in a URL). */
  const addressTag = (address: string): string => createHmac("sha256", linkSecret).update(`addr\0${normalizeAddress(address)}`).digest("base64url").slice(0, 16);
  const consentGen = (coach: string): number => prefs.get(coach).consentGen ?? 0;
  /**
   * When league consent was last GRANTED: the identity's consent stamp (only while consent is granted: a withdrawal also
   * carries a newer stamp and must never count) or the Account page "turn back on" (only while the identity's consent
   * stands). 0 = no granted consent.
   */
  function consentAt(coach: string): number {
    let fields: ReturnType<typeof identityMailFields> | undefined;
    try { fields = identityMailFields(deps.identity(coach)); } catch { /* no identity */ }
    if (!fields?.leagueContact) return 0;
    const identityAt = fields.leagueContactAt;
    const prefsAt = Date.parse(prefs.get(coach).reconsentAt ?? "");
    return Math.max(Number.isFinite(identityAt) ? identityAt : 0, Number.isFinite(prefsAt) ? prefsAt : 0);
  }

  /** One-click unsubscribe link, bound to the coach, the address the message goes to and the consent generation. */
  function unsubscribeUrl(coach: string, leagueId: string | undefined, address: string): string {
    const t = Math.floor(now() / 1000);
    const token = signLink(linkSecret, {
      v: 1, p: "unsub", c: mailCoachKey(coach), e: t + UNSUBSCRIBE_TTL_S, i: t, h: addressTag(address), g: consentGen(coach), ...(leagueId ? { l: leagueId } : {}),
    });
    return absolute(`/api/mail/unsubscribe?token=${encodeURIComponent(token)}`);
  }

  type UnsubCheck = { ok: true; coach: string; leagueId?: string } | { ok: false; result: MailRouteResult };
  function checkUnsubscribe(token: string): UnsubCheck {
    const check = verifyLink(linkSecret, token, "unsub", now());
    if (!check.ok) {
      return {
        ok: false,
        result: check.reason === "expired"
          ? page(410, "Link expired", "This link has expired. Turn league emails off on your Account page instead.")
          : page(400, "Link not valid", "This unsubscribe link is not valid. Turn league emails off on your Account page instead."),
      };
    }
    const { c: coach, h, g, i } = check.payload;
    // `i` is whole seconds, so consent is compared at the same precision (a link issued in the same second stays valid).
    const current = resolver.resolve(coach)?.email;
    const stale = !h || !current || addressTag(current) !== h || (g ?? -1) !== consentGen(coach) || typeof i !== "number" || Math.floor(consentAt(coach) / 1000) > i;
    if (stale)
      return { ok: false, result: page(410, "Link out of date", "Your email address or your league-email choice changed after this email was sent, so this link no longer works. Use your Account page instead.") };
    return { ok: true, coach, ...(check.payload.l ? { leagueId: check.payload.l } : {}) };
  }

  function enqueue(items: OutboxItem[]) {
    return outbox.enqueue(items);
  }

  // ---- unsubscribe --------------------------------------------------------------------------------------------------

  function unsubscribe(token: string): MailRouteResult {
    const check = checkUnsubscribe(token);
    if (!check.ok) return check.result;
    const at = new Date(now()).toISOString();
    const coach = check.coach;
    prefs.update(coach, (p) => ({ ...p, leagueMailOff: { at, ...(check.leagueId ? { leagueId: check.leagueId } : {}) } }));
    try { writer.revokeLeagueContact(coach, at); } catch (e) { log(`[mail] consent write failed: ${(e as Error).message}`); }
    return page(200, "League emails turned off", "You will not get league emails any more. In-portal notifications still show league messages. You can turn league emails back on from your Account page.");
  }

  // ---- verification -------------------------------------------------------------------------------------------------

  function verify(token: string): MailRouteResult {
    const check = verifyLink(linkSecret, token, "verify", now());
    if (!check.ok) {
      return check.reason === "expired"
        ? page(410, "Link expired", "This confirmation link has expired. Ask for a new one on your Account page.")
        : page(400, "Link not valid", "This confirmation link is not valid. Ask for a new one on your Account page.");
    }
    const coach = check.payload.c;
    const pending = prefs.get(coach).pending;
    if (!pending || pending.nonce !== check.payload.n || Date.parse(pending.expiresAt) < now())
      return page(410, "Link already used", "This link was already used or replaced by a newer one. Your Account page shows the current state.");
    const at = new Date(now()).toISOString();
    prefs.update(coach, (p) => {
      const next = { ...p, email: { address: pending.address, verifiedAt: at } };
      delete next.pending;
      return next;
    });
    try { writer.markEmailVerified(coach, pending.address, at); } catch (e) { log(`[mail] verified write failed: ${(e as Error).message}`); }
    // A complaint is cleared only by the coach re-verifying the address after re-consenting (or by an admin).
    const sup = suppression.entry(pending.address);
    if (sup?.reason === "complaint" && consentAt(coach) > Date.parse(sup.at)) suppression.clear(pending.address, "reverify-reconsent", log);
    return page(200, "Email confirmed", "Thanks: this address is confirmed for league emails.");
  }

  function takeVerifySlot(coach: string): boolean {
    const key = mailCoachKey(coach);
    const t = now();
    const recent = (verifyHits.get(key) ?? []).filter((x) => t - x < 3_600_000);
    if (recent.length >= VERIFY_MAX_PER_HOUR || (recent.length && t - recent[recent.length - 1]! < VERIFY_MIN_GAP_MS)) { verifyHits.set(key, recent); return false; }
    recent.push(t);
    verifyHits.set(key, recent);
    if (verifyHits.size > 5_000) verifyHits.delete(verifyHits.keys().next().value as string);
    return true;
  }

  function requestVerification(auth: MeMailAuth, body: unknown): MailRouteResult {
    if (auth.test) return jsonErr(403, "Test sign-in sessions cannot change account email.");
    const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    let address: string | undefined;
    if (input.email !== undefined) {
      if (typeof input.email !== "string" || !isEmailAddress(input.email.trim())) return jsonErr(400, "Enter a valid email address.");
      address = input.email.trim();
    }
    // A coach with an address on file confirms that one (change it in the Contact panel first).
    const onFile = resolver.resolve(auth.coach)?.email;
    if (address && onFile && normalizeAddress(address) !== normalizeAddress(onFile))
      return jsonErr(409, "Change your contact email on the Account page first, then confirm it here.");
    address ??= onFile;
    if (!address) return jsonErr(400, "Enter the email address to confirm.");
    if (!emailEnabled()) return jsonErr(503, "Email is not set up on this site yet.");
    // The rate limit is consumed first, and a suppressed address gets the same 202 and the same pending state on the
    // Account page (only nothing is sent), so this route cannot be used to probe which addresses bounced or complained.
    if (!takeVerifySlot(auth.coach)) return { ...jsonErr(429, "Too many confirmation emails; wait a few minutes and try again."), headers: { ...NO_STORE, "retry-after": "60" } };
    const accepted: MailRouteResult = { status: 202, json: { sent: true, expiresInHours: VERIFY_TTL_S / 3600 }, headers: NO_STORE };
    const sup = suppression.entry(address);
    // Re-verification after a complaint is allowed only once the coach has re-consented since the complaint (checked
    // again at send time).
    const reverify = sup?.reason === "complaint" && consentAt(auth.coach) > Date.parse(sup.at);
    const nonce = randomBytes(12).toString("base64url");
    const t = now();
    prefs.update(auth.coach, (p) => ({ ...p, pending: { address, nonce, requestedAt: new Date(t).toISOString(), expiresAt: new Date(t + VERIFY_TTL_S * 1000).toISOString() } }));
    if (sup && !reverify) return accepted;
    const token = signLink(linkSecret, { v: 1, p: "verify", c: mailCoachKey(auth.coach), e: Math.floor(t / 1000) + VERIFY_TTL_S, n: nonce });
    const rendered = renderVerifyEmail({ coach: auth.coach, verifyUrl: absolute(`/api/mail/verify?token=${encodeURIComponent(token)}`) });
    const message: MailMessage = { to: address, subject: rendered.subject, text: rendered.text, html: rendered.html, template: "verify-email", stream: config.stream };
    enqueue([{ key: `verify:${mailCoachKey(auth.coach)}:${nonce}`, message, recipient: { coach: auth.coach }, ...(reverify ? { reverify: true as const } : {}) }]);
    return accepted;
  }

  function myStatus(auth: MeMailAuth): MailRouteResult {
    const contact = resolver.resolve(auth.coach);
    const p = prefs.get(auth.coach);
    const pending = p.pending && Date.parse(p.pending.expiresAt) >= now() ? p.pending : undefined;
    return {
      status: 200,
      headers: NO_STORE,
      json: {
        emailEnabled: emailEnabled(),
        // The coach's own data only.
        email: contact?.email ?? null,
        verified: contact?.verified === true,
        suppressed: contact?.email ? suppression.isSuppressed(contact.email) : false,
        pending: pending ? { email: pending.address, expiresAt: pending.expiresAt } : null,
        leagueMailOff: p.leagueMailOff ? { at: p.leagueMailOff.at } : null,
      },
    };
  }

  /** Account page notification settings: the coach's own choice and state only (never the Discord id). */
  function notificationSettings(auth: MeMailAuth): MailRouteResult {
    const saved = prefs.get(auth.coach).discordDm;
    return {
      status: 200,
      headers: NO_STORE,
      json: {
        discordDm: {
          label: DISCORD_DM_TEXT,
          on: saved?.on ?? true,
          linked: discordUserIdOf(auth.coach) !== undefined,
          available: discordEnabled(),
          at: saved?.at ?? null,
          version: DISCORD_DM_VERSION,
        },
        emailFallback: actionEmailCheck(auth.coach).ok,
      },
    };
  }

  /** Account page: turn league email back on after a link opt-out (consent itself is the onboarding lane's). */
  function clearOptOut(auth: MeMailAuth): MailRouteResult {
    if (auth.test) return jsonErr(403, "Test sign-in sessions cannot change account email.");
    // Re-consent: a new generation voids every unsubscribe link sent before.
    prefs.update(auth.coach, (p) => {
      const next = { ...p, consentGen: (p.consentGen ?? 0) + 1, reconsentAt: new Date(now()).toISOString() };
      delete next.leagueMailOff;
      return next;
    });
    return myStatus(auth);
  }

  // ---- webhook ------------------------------------------------------------------------------------------------------

  function webhookAuthorized(header: string | undefined): boolean {
    if (!config.webhookSecret || !header?.startsWith("Basic ")) return false;
    let decoded: string;
    try { decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8"); } catch { return false; }
    const password = decoded.slice(decoded.indexOf(":") + 1);
    const a = Buffer.from(password);
    const b = Buffer.from(config.webhookSecret);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Bounce types that mean the address cannot receive mail (soft bounces and auto-replies are ignored). */
  const HARD_BOUNCES = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "SpamNotification", "Blocked", "DMARCPolicy"]);

  function webhook(payload: unknown): MailRouteResult {
    const p = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
    if (!p) return jsonErr(400, "Send a JSON object.");
    const type = p.RecordType;
    let action: "suppressed" | "unsuppressed" | "ignored" = "ignored";
    const mark = (address: unknown, reason: SuppressionReason) => {
      if (typeof address === "string" && isEmailAddress(address.trim())) { suppression.suppress(address, reason); action = "suppressed"; }
    };
    if (type === "Bounce" && typeof p.Type === "string" && HARD_BOUNCES.has(p.Type)) mark(p.Email, "bounce");
    else if (type === "SpamComplaint") mark(p.Email, "complaint");
    else if (type === "SubscriptionChange") {
      const address = p.Recipient;
      if (p.SuppressSending === true) mark(address, p.SuppressionReason === "SpamComplaint" ? "complaint" : p.SuppressionReason === "HardBounce" ? "bounce" : "manual");
      else if (p.SuppressSending === false && typeof address === "string" && isEmailAddress(address.trim()) && suppression.unsuppress(address)) action = "unsuppressed";
    }
    // Counts only: never the address.
    log(`[mail] webhook ${typeof type === "string" ? type.slice(0, 30) : "unknown"}: ${action}`);
    return { status: 200, json: { ok: true, action }, headers: NO_STORE };
  }

  // ---- routing ------------------------------------------------------------------------------------------------------

  const PUBLIC = new Set(["/api/mail/postmark/webhook", "/api/mail/unsubscribe", "/api/mail/verify"]);
  const isPublicMailPath = (path: string): boolean => PUBLIC.has(path);
  const isMeMailPath = (path: string): boolean => path === "/api/me/email" || path === "/api/me/email/verify" || path === "/api/me/email/league-mail" || path === NOTIFICATION_SETTINGS_PATH;

  /** Public mail routes. `readText` reads the raw body (bounded by the caller). */
  async function publicRoute(
    method: string, path: string, query: URLSearchParams, headers: { authorization?: string; contentType?: string }, readText: () => Promise<string>,
  ): Promise<MailRouteResult | undefined> {
    if (path === "/api/mail/postmark/webhook") {
      if (method !== "POST") return jsonErr(405, "Use POST.");
      if (!config.webhookSecret) return jsonErr(503, "The mail webhook is not configured.");
      if (!webhookAuthorized(headers.authorization)) return { status: 401, json: { error: "Authentication required." }, headers: { ...NO_STORE, "www-authenticate": 'Basic realm="mail-webhook"' } };
      let payload: unknown;
      try { payload = JSON.parse(await readText()); } catch { return jsonErr(400, "Send valid JSON."); }
      return webhook(payload);
    }
    if (path === "/api/mail/unsubscribe") {
      const queryToken = query.get("token") ?? "";
      if (method === "GET" || method === "HEAD") {
        if (!queryToken) return page(400, "Link not valid", "This unsubscribe link is not complete.");
        const check = checkUnsubscribe(queryToken);
        if (!check.ok) return check.result;
        return page(200, "Stop league emails?", "Press the button to stop league emails from Super FUMBBL. In-portal notifications are not affected.", { action: "/api/mail/unsubscribe", token: queryToken, button: "Stop league emails" });
      }
      if (method !== "POST") return jsonErr(405, "Use GET or POST.");
      let token = queryToken;
      const text = await readText();
      if (!token) token = new URLSearchParams(text).get("token") ?? "";
      return unsubscribe(token);
    }
    if (path === "/api/mail/verify") {
      if (method !== "GET" && method !== "HEAD") return jsonErr(405, "Use GET.");
      return verify(query.get("token") ?? "");
    }
    return undefined;
  }

  /** /api/me/email routes for a signed-in coach. */
  function meRoute(method: string, path: string, auth: MeMailAuth | undefined, body: unknown): MailRouteResult | undefined {
    if (!isMeMailPath(path)) return undefined;
    if (!auth) return jsonErr(401, "Authentication required.");
    if (path === "/api/me/email") return method === "GET" || method === "HEAD" ? myStatus(auth) : jsonErr(405, "Use GET.");
    if (path === NOTIFICATION_SETTINGS_PATH) {
      if (method === "GET" || method === "HEAD") return notificationSettings(auth);
      if (method !== "POST") return jsonErr(405, "Use GET or POST.");
      if (auth.test) return jsonErr(403, "Test sign-in sessions cannot change notification settings.");
      const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
      if (typeof input.discordDm !== "boolean") return jsonErr(400, "Send { discordDm: true } or { discordDm: false }.");
      // Checked at write time (after the body was read): an account being deleted, or gone, never gets prefs back.
      if (isCoachFenced(auth.coach)) return jsonErr(410, "This account is being deleted.");
      let record: Record<string, unknown> | undefined;
      try { record = objOf(deps.identity(auth.coach)); } catch { record = undefined; }
      if (!record || record.banned === true) return jsonErr(403, "This account cannot change notification settings.");
      const on = input.discordDm;
      prefs.update(auth.coach, (p) => ({ ...p, discordDm: { on, at: new Date(now()).toISOString(), version: DISCORD_DM_VERSION } }));
      return notificationSettings(auth);
    }
    if (path === "/api/me/email/verify") return method === "POST" ? requestVerification(auth, body) : jsonErr(405, "Use POST.");
    if (path === "/api/me/email/league-mail") {
      if (method !== "POST") return jsonErr(405, "Use POST.");
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (input.on !== true) return jsonErr(400, "Send { on: true } to turn league emails back on.");
      return clearOptOut(auth);
    }
    return undefined;
  }

  return {
    config, transport, discordTransport, discordEnabled, notifyAction, outbox, worker, suppression, prefs, audit, resolver, recheck,
    /** Start the background work (server only): the outbox worker and the daily retention sweep. */
    start(): void { worker.start(); outbox.startRetention(); },
    stop(): void { worker.stop(); outbox.stopRetention(); },
    /** Explicit admin clear of a suppression (the only way besides re-verify + re-consent to lift a complaint). */
    clearSuppression: (address: string) => suppression.clear(address, "admin", log),
    emailEnabled, absolute, unsubscribeUrl, enqueue,
    isPublicMailPath, isMeMailPath, publicRoute, meRoute,
    /** Account deletion hook (export/delete lane): forget a coach's mail prefs and every delivery to them. Suppression
     *  hashes stay (they only stop mail to an address that bounced or complained). */
    forgetCoach: (coach: string): void => { prefs.remove(coach); outbox.forgetCoach(coach); },
    /** Data export: the coach's mail prefs (confirmed address, open confirmation, league email choice) and deliveries. */
    exportCoach: (coach: string): unknown => ({
      prefs: prefs.get(coach),
      deliveries: outbox.forCoach(coach).map((e) => ({
        channel: e.channel, template: e.template, status: e.status, leagueId: e.leagueId ?? null, enqueuedAt: new Date(e.enqueuedAt).toISOString(),
        ...(e.doneAt ? { doneAt: new Date(e.doneAt).toISOString() } : {}),
        // A Discord row has no address (and never a Discord id): only its subject and text.
        ...(e.message ? { ...(e.channel === "email" ? { to: e.message.to } : {}), subject: e.message.subject, text: e.message.text } : {}),
      })),
    }),
    normalizeAddress,
  };
}
