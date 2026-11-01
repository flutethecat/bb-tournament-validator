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

import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { isEmailAddress, mailConfigFromEnv, type MailConfig } from "./config.js";
import { MailWorker, Outbox, type OutboxItem } from "./outbox.js";
import { createPostmarkTransport } from "./postmark.js";
import {
  createDefaultRecipientResolver, type ContactWriter, type RecipientResolver,
} from "./recipients.js";
import { MailAuditLog, mailCoachKey, MailPrefsStore, normalizeAddress, SuppressionStore, type SuppressionReason } from "./stores.js";
import { linkPage, renderVerifyEmail } from "./templates.js";
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
  /** Plug the onboarding lane's contactFor() in here; default reads the identity fields. */
  resolver?: RecipientResolver;
  /** Identity-side writes (unsubscribe, verification); default no-op. */
  contactWriter?: ContactWriter;
  transport?: MailTransport;
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
  const resolver = deps.resolver ?? createDefaultRecipientResolver({ identity: deps.identity, prefs });
  const writer: ContactWriter = deps.contactWriter ?? { revokeLeagueContact() {}, markEmailVerified() {} };
  const worker = new MailWorker({
    outbox, transport, now, log,
    isSuppressed: (a) => suppression.isSuppressed(a),
    onInactive: (a) => suppression.suppress(a, "inactive"),
    ...(deps.ratePerSecond ? { ratePerSecond: deps.ratePerSecond } : {}),
    ...(deps.leagueDailyCap ? { leagueDailyCap: deps.leagueDailyCap } : {}),
  });
  const verifyHits = new Map<string, number[]>();

  /** Email can go out: links can be absolute, and a real transport has a From address (the log transport always can). */
  const emailEnabled = (): boolean => Boolean(config.linkBase) && !(config.transport === "postmark" && !config.from && !deps.transport);
  const absolute = (path: string): string => `${config.linkBase ?? ""}${path}`;

  function unsubscribeUrl(coach: string, leagueId?: string): string {
    const token = signLink(linkSecret, { v: 1, p: "unsub", c: mailCoachKey(coach), e: Math.floor(now() / 1000) + UNSUBSCRIBE_TTL_S, ...(leagueId ? { l: leagueId } : {}) });
    return absolute(`/api/mail/unsubscribe?token=${encodeURIComponent(token)}`);
  }

  function enqueue(items: OutboxItem[]) {
    return outbox.enqueue(items);
  }

  // ---- unsubscribe --------------------------------------------------------------------------------------------------

  function unsubscribe(token: string): MailRouteResult {
    const check = verifyLink(linkSecret, token, "unsub", now());
    if (!check.ok) {
      return check.reason === "expired"
        ? page(410, "Link expired", "This link has expired. Turn league emails off on your Account page instead.")
        : page(400, "Link not valid", "This unsubscribe link is not valid. Turn league emails off on your Account page instead.");
    }
    const at = new Date(now()).toISOString();
    const coach = check.payload.c;
    prefs.update(coach, (p) => ({ ...p, leagueMailOff: { at, ...(check.payload.l ? { leagueId: check.payload.l } : {}) } }));
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
    } else {
      address = resolver.resolve(auth.coach)?.email;
      if (!address) return jsonErr(400, "Enter the email address to confirm.");
    }
    if (!emailEnabled()) return jsonErr(503, "Email is not set up on this site yet.");
    if (suppression.isSuppressed(address)) return jsonErr(409, "Mail to this address bounced or was reported as spam, so we cannot send to it. Use another address.");
    if (!takeVerifySlot(auth.coach)) return { ...jsonErr(429, "Too many confirmation emails; wait a few minutes and try again."), headers: { ...NO_STORE, "retry-after": "60" } };
    const nonce = randomBytes(12).toString("base64url");
    const t = now();
    prefs.update(auth.coach, (p) => ({ ...p, pending: { address, nonce, requestedAt: new Date(t).toISOString(), expiresAt: new Date(t + VERIFY_TTL_S * 1000).toISOString() } }));
    const token = signLink(linkSecret, { v: 1, p: "verify", c: mailCoachKey(auth.coach), e: Math.floor(t / 1000) + VERIFY_TTL_S, n: nonce });
    const rendered = renderVerifyEmail({ coach: auth.coach, verifyUrl: absolute(`/api/mail/verify?token=${encodeURIComponent(token)}`) });
    const message: MailMessage = { to: address, subject: rendered.subject, text: rendered.text, html: rendered.html, template: "verify-email", stream: config.stream };
    enqueue([{ key: `verify:${mailCoachKey(auth.coach)}:${nonce}`, message }]);
    return { status: 202, json: { sent: true, expiresInHours: VERIFY_TTL_S / 3600 }, headers: NO_STORE };
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

  /** Account page: turn league email back on after a link opt-out (consent itself is the onboarding lane's). */
  function clearOptOut(auth: MeMailAuth): MailRouteResult {
    if (auth.test) return jsonErr(403, "Test sign-in sessions cannot change account email.");
    prefs.update(auth.coach, (p) => { const next = { ...p }; delete next.leagueMailOff; return next; });
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
  const isMeMailPath = (path: string): boolean => path === "/api/me/email" || path === "/api/me/email/verify" || path === "/api/me/email/league-mail";

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
        const check = verifyLink(linkSecret, queryToken, "unsub", now());
        if (!check.ok) return unsubscribe(queryToken); // the error page
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
    config, transport, outbox, worker, suppression, prefs, audit, resolver,
    emailEnabled, absolute, unsubscribeUrl, enqueue,
    isPublicMailPath, isMeMailPath, publicRoute, meRoute,
    /** Account deletion hook (export/delete lane): forget a coach's mail prefs. Suppression hashes stay. */
    forgetCoach: (coach: string) => prefs.remove(coach),
    normalizeAddress,
  };
}
