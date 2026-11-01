import { existsSync, mkdtempSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mailConfigFromEnv } from "../src/mail/config";
import { disclosedCounts, LeagueMessageLimiter, leagueMessagesRoute, PRIVATE_SUMMARY, type LeagueMessageDeps } from "../src/mail/leagueMessages";
import { MailWorker, Outbox, OUTBOX_BODY_RETENTION_MS, RETENTION_SWEEP_MS, retryDelayMs } from "../src/mail/outbox";
import { createPostmarkTransport, POSTMARK_EMAIL_URL, postmarkBody } from "../src/mail/postmark";
import { createDefaultRecipientResolver, createIdentityContactWriter, leagueAcknowledged } from "../src/mail/recipients";
import { createMailService, type MailServiceDeps } from "../src/mail/service";
import { MailPrefsStore } from "../src/mail/stores";
import { renderLeagueMessage } from "../src/mail/templates";
import { signLink, verifyLink } from "../src/mail/tokens";
import { createLogTransport, MailSendError, MemoryTransport, type MailMessage } from "../src/mail/transport";
import { NotificationStore } from "../src/notifications";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueTeam, SeasonRecord } from "../src/leagues/types";

// Portal mail (src/mail/): transports, the durable outbox + worker, suppression webhook, signed links (unsubscribe,
// verification) and the league "Message members" route. No network and no real addresses: fetch is mocked and every
// address is on the reserved example.test domain.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "mail-")); roots.push(d); return d; };

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const ENV = { MAIL_LINK_SECRET: "x".repeat(40), MAIL_LINK_BASE_URL: "https://site.example.test", POSTMARK_WEBHOOK_SECRET: "hook-secret", MAIL_FROM: "noreply@site.example.test" };

const msg = (to: string, over: Partial<MailMessage> = {}): MailMessage => ({ to, subject: "S", text: "T", html: "<p>T</p>", template: "league-message", ...over });

/** The MailSendError a send rejects with (fails the test if it resolves). */
const failure = (p: Promise<unknown>): Promise<MailSendError> => p.then(() => { throw new Error("expected the send to fail"); }, (x: unknown) => x as MailSendError);

const jsonRes = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// ---- transports -------------------------------------------------------------------------------------------------------

describe("transport selection", () => {
  it("uses the log transport when no token is configured, and the log line carries no address", async () => {
    const lines: string[] = [];
    const svc = createMailService(tmp(), { ...ENV }, { identity: () => undefined, log: (l) => lines.push(l) });
    expect(svc.config.transport).toBe("log");
    expect(svc.transport.name).toBe("log");
    await svc.transport.send(msg("alice@example.test"));
    expect(lines.join("\n")).toContain("template=league-message recipients=1");
    expect(lines.join("\n")).not.toContain("example.test");
  });

  it("uses Postmark with a token and a From address; config never echoes the stream when invalid", () => {
    const svc = createMailService(tmp(), { ...ENV, POSTMARK_SERVER_TOKEN: "tok" }, { identity: () => undefined });
    expect(svc.transport.name).toBe("postmark");
    expect(svc.emailEnabled()).toBe(true);
    expect(mailConfigFromEnv({ MAIL_STREAM: "bad stream!" }).stream).toBe("outbound");
    expect(mailConfigFromEnv({ MAIL_STREAM: "outbound", MAIL_LEAGUE_STREAM: "broadcast" }).leagueStream).toBe("broadcast");
    expect(mailConfigFromEnv({ MAIL_STREAM: "tx" }).leagueStream).toBe("tx");
  });

  it("email is off without a link origin, and off when a token is set without a From address", () => {
    const noBase = createMailService(tmp(), { MAIL_LINK_SECRET: ENV.MAIL_LINK_SECRET }, { identity: () => undefined });
    expect(noBase.emailEnabled()).toBe(false);
    const noFrom = createMailService(tmp(), { ...ENV, MAIL_FROM: "", POSTMARK_SERVER_TOKEN: "tok" }, { identity: () => undefined });
    expect(noFrom.transport.name).toBe("log");
    expect(noFrom.emailEnabled()).toBe(false);
  });

  it("the log transport factory never prints the subject or text", async () => {
    const lines: string[] = [];
    await createLogTransport((l) => lines.push(l)).send(msg("bob@example.test", { subject: "secret subject", text: "secret text" }));
    expect(lines.join()).not.toMatch(/secret|bob/);
  });
});

describe("Postmark adapter", () => {
  const opts = { token: "server-token", from: "noreply@site.example.test", stream: "outbound", sleep: async () => {} };

  it("POSTs the documented request shape with the server token header", async () => {
    const fetch = vi.fn(async () => jsonRes(200, { ErrorCode: 0, MessageID: "pm-1" }));
    const t = createPostmarkTransport({ ...opts, fetch: fetch as unknown as typeof globalThis.fetch });
    const r = await t.send(msg("alice@example.test", { headers: [{ name: "List-Unsubscribe", value: "<https://x>" }], metadata: { league: "tabbl" }, stream: "broadcast" }));
    expect(r.providerId).toBe("pm-1");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(POSTMARK_EMAIL_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-postmark-server-token"]).toBe("server-token");
    expect((init.headers as Record<string, string>).accept).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      From: "Super FUMBBL <noreply@site.example.test>", To: "alice@example.test", Subject: "S", TextBody: "T", HtmlBody: "<p>T</p>",
      MessageStream: "broadcast", Tag: "league-message", TrackOpens: false, TrackLinks: "None",
      Headers: [{ Name: "List-Unsubscribe", Value: "<https://x>" }], Metadata: { league: "tabbl" },
    });
    expect(postmarkBody(msg("a@example.test"), { from: "n@example.test" }).MessageStream).toBe("outbound");
  });

  it("retries 5xx and 429 with backoff, then succeeds", async () => {
    const seq = [jsonRes(503, {}), jsonRes(429, { ErrorCode: 429 }), jsonRes(200, { ErrorCode: 0, MessageID: "ok" })];
    const fetch = vi.fn(async () => seq.shift()!);
    const sleeps: number[] = [];
    const t = createPostmarkTransport({ ...opts, fetch: fetch as unknown as typeof globalThis.fetch, backoffMs: 100, sleep: async (ms) => { sleeps.push(ms); } });
    await expect(t.send(msg("a@example.test"))).resolves.toEqual({ providerId: "ok" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(sleeps[1]).toBeGreaterThanOrEqual(200);
  });

  it("never retries other 4xx; 406 marks the recipient inactive; the error carries no token or address", async () => {
    const fetch = vi.fn(async () => jsonRes(422, { ErrorCode: 300, Message: "Invalid email request" }));
    const t = createPostmarkTransport({ ...opts, fetch: fetch as unknown as typeof globalThis.fetch });
    const e = await failure(t.send(msg("a@example.test")));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(e).toBeInstanceOf(MailSendError);
    expect(e.retryable).toBe(false);
    expect(e.message).not.toMatch(/server-token|example\.test/);
    const inactive = createPostmarkTransport({ ...opts, fetch: (async () => jsonRes(422, { ErrorCode: 406 })) as unknown as typeof globalThis.fetch });
    const e2 = await failure(inactive.send(msg("a@example.test")));
    expect(e2.inactiveRecipient).toBe(true);
  });

  it("network errors and timeouts are retryable and give up after the retry budget", async () => {
    const fetch = vi.fn(async () => { const err = new Error("t"); err.name = "TimeoutError"; throw err; });
    const t = createPostmarkTransport({ ...opts, retries: 2, fetch: fetch as unknown as typeof globalThis.fetch });
    const e = await failure(t.send(msg("a@example.test")));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/timed out/);
  });
});

// ---- outbox + worker --------------------------------------------------------------------------------------------------

describe("outbox", () => {
  it("survives a restart, keeps idempotency keys, and tolerates a torn last line", () => {
    const dir = tmp();
    let now = T0;
    const a = new Outbox(dir, () => now);
    expect(a.enqueue([{ key: "k1", message: msg("a@example.test") }, { key: "k2", message: msg("b@example.test"), leagueId: "tabbl" }, { key: "k1", message: msg("a@example.test") }]))
      .toEqual({ added: 2, duplicates: 1 });
    a.markSent(a.byIdempotencyKey("k1")!.id);
    appendFileSync(a.file, '{"op":"add","entry":{"id":"half');
    const b = new Outbox(dir, () => now);
    expect(b.byIdempotencyKey("k1")!.status).toBe("sent");
    expect(b.byIdempotencyKey("k2")!.status).toBe("queued");
    expect(b.enqueue([{ key: "k1", message: msg("a@example.test") }])).toEqual({ added: 0, duplicates: 1 });
    expect(b.leagueLoad("tabbl")).toEqual({ sentToday: 0, queued: 1 });
  });

  it("strips address and body of sent mail after 30 days, keeping the key", () => {
    const dir = tmp();
    let now = T0;
    const a = new Outbox(dir, () => now);
    a.enqueue([{ key: "k1", message: msg("a@example.test") }]);
    a.markSent(a.byIdempotencyKey("k1")!.id);
    now += OUTBOX_BODY_RETENTION_MS + 1000;
    const b = new Outbox(dir, () => now);
    expect(b.byIdempotencyKey("k1")!.message).toBeUndefined();
    expect(readFileSync(b.file, "utf8")).not.toContain("example.test");
    expect(b.enqueue([{ key: "k1", message: msg("a@example.test") }]).added).toBe(0);
  });
});

describe("outbox retention sweep", () => {
  afterEach(() => { vi.useRealTimers(); });
  it("a long-running instance strips sent mail older than 30 days on the daily timer, without a restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const outbox = new Outbox(tmp(), () => Date.now());
    outbox.enqueue([
      { key: "old", message: msg("old@example.test", { text: "link https://x/api/mail/unsubscribe?token=abc" }) },
      { key: "waiting", message: msg("wait@example.test") },
    ]);
    outbox.markSent(outbox.byIdempotencyKey("old")!.id);
    outbox.startRetention();
    vi.advanceTimersByTime(29 * RETENTION_SWEEP_MS);
    expect(outbox.byIdempotencyKey("old")!.message).toBeDefined();
    vi.advanceTimersByTime(2 * RETENTION_SWEEP_MS);
    expect(outbox.byIdempotencyKey("old")!.message).toBeUndefined();
    const journal = readFileSync(outbox.file, "utf8");
    expect(journal).not.toContain("old@example.test");
    expect(journal).not.toContain("token=abc");
    expect(outbox.byIdempotencyKey("waiting")!.message?.to).toBe("wait@example.test"); // still queued: kept
    outbox.stopRetention();
  });
});

describe("mail worker", () => {
  it("sends at most ratePerSecond per second", async () => {
    let now = T0;
    const outbox = new Outbox(tmp(), () => now);
    outbox.enqueue(Array.from({ length: 25 }, (_, i) => ({ key: `k${i}`, message: msg(`c${i}@example.test`) })));
    const transport = new MemoryTransport();
    const w = new MailWorker({ outbox, transport, now: () => now, ratePerSecond: 10 });
    expect(await w.drain()).toBe(10);
    expect(await w.drain()).toBe(0);
    now += 1000;
    expect(await w.drain()).toBe(10);
    now += 1000;
    expect(await w.drain()).toBe(5);
    expect(transport.sent).toHaveLength(25);
    expect(outbox.due(now)).toHaveLength(0);
  });

  it("holds a league at its daily cap until the next UTC day", async () => {
    let now = T0;
    const outbox = new Outbox(tmp(), () => now);
    outbox.enqueue(Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, leagueId: "tabbl", message: msg(`c${i}@example.test`) })));
    outbox.enqueue([{ key: "other", leagueId: "other", message: msg("o@example.test") }]);
    const transport = new MemoryTransport();
    const w = new MailWorker({ outbox, transport, now: () => now, leagueDailyCap: 3, ratePerSecond: 100 });
    await w.drain();
    expect(transport.sent).toHaveLength(4); // 3 for tabbl + 1 for the other league
    expect(outbox.leagueLoad("tabbl", now)).toEqual({ sentToday: 3, queued: 2 });
    now = Date.parse("2026-11-01T00:00:01.000Z");
    await w.drain();
    expect(transport.sent).toHaveLength(6);
  });

  it("backs off retryable failures, dead-letters the rest, and suppresses inactive recipients", async () => {
    let now = T0;
    const outbox = new Outbox(tmp(), () => now);
    outbox.enqueue([{ key: "r", message: msg("retry@example.test") }, { key: "d", message: msg("dead@example.test") }, { key: "i", message: msg("gone@example.test") }]);
    const transport = new MemoryTransport();
    transport.fail = (m) => m.to.startsWith("retry") ? new MailSendError("busy", true, 503) : m.to.startsWith("dead") ? new MailSendError("bad", false, 422) : m.to.startsWith("gone") ? new MailSendError("inactive", false, 422, true) : undefined;
    const suppressed: string[] = [];
    const w = new MailWorker({ outbox, transport, now: () => now, onInactive: (a) => suppressed.push(a) });
    await w.drain();
    const r = outbox.byIdempotencyKey("r")!;
    expect(r.status).toBe("queued");
    expect(r.attempts).toBe(1);
    expect(r.nextAt).toBe(now + retryDelayMs(1));
    expect(outbox.byIdempotencyKey("d")!.status).toBe("dead");
    expect(outbox.byIdempotencyKey("i")!.status).toBe("dead");
    expect(suppressed).toEqual(["gone@example.test"]);
    transport.fail = undefined;
    now += retryDelayMs(1);
    await w.drain();
    expect(outbox.byIdempotencyKey("r")!.status).toBe("sent");
  });

  it("picks the transport per channel and dead-letters a channel without one", async () => {
    const outbox = new Outbox(tmp(), () => T0);
    outbox.enqueue([{ key: "e", channel: "email", message: msg("e@example.test") }]);
    expect(outbox.byIdempotencyKey("e")!.channel).toBe("email");
    const email = new MemoryTransport();
    await new MailWorker({ outbox, transports: { email }, now: () => T0 }).drain();
    expect(email.sent).toHaveLength(1);
    const none = new Outbox(tmp(), () => T0);
    none.enqueue([{ key: "x", message: msg("x@example.test") }]);
    await new MailWorker({ outbox: none, transports: {}, now: () => T0 }).drain();
    expect(none.byIdempotencyKey("x")!).toMatchObject({ status: "dead", error: "no transport for email" });
  });

  it("skips an address suppressed after it was queued", async () => {
    const outbox = new Outbox(tmp(), () => T0);
    outbox.enqueue([{ key: "s", message: msg("s@example.test") }]);
    const transport = new MemoryTransport();
    await new MailWorker({ outbox, transport, now: () => T0, isSuppressed: () => true }).drain();
    expect(transport.sent).toHaveLength(0);
    expect(outbox.byIdempotencyKey("s")!).toMatchObject({ status: "dead", error: "suppressed" });
  });
});

// ---- webhook ------------------------------------------------------------------------------------------------------------

const basic = (pw: string) => `Basic ${Buffer.from(`postmark:${pw}`).toString("base64")}`;

describe("Postmark webhook", () => {
  const call = (svc: ReturnType<typeof createMailService>, body: unknown, auth?: string) =>
    svc.publicRoute("POST", "/api/mail/postmark/webhook", new URLSearchParams(), { authorization: auth }, async () => JSON.stringify(body));

  it("503 without a secret, 401 on a wrong password", async () => {
    const off = createMailService(tmp(), { ...ENV, POSTMARK_WEBHOOK_SECRET: "" }, { identity: () => undefined });
    expect((await call(off, {}, basic("x")))!.status).toBe(503);
    const svc = createMailService(tmp(), ENV, { identity: () => undefined, log: () => {} });
    expect((await call(svc, {}, basic("wrong")))!.status).toBe(401);
    expect((await call(svc, {}))!.status).toBe(401);
  });

  it("hard bounces, complaints and subscription changes suppress by salted hash; soft bounces are ignored", async () => {
    const dir = tmp();
    const lines: string[] = [];
    const svc = createMailService(dir, ENV, { identity: () => undefined, log: (l) => lines.push(l) });
    expect((await call(svc, { RecordType: "Bounce", Type: "SoftBounce", Email: "soft@example.test" }, basic("hook-secret")))!.json).toMatchObject({ action: "ignored" });
    expect((await call(svc, { RecordType: "Bounce", Type: "HardBounce", Email: "Hard@Example.test" }, basic("hook-secret")))!.json).toMatchObject({ action: "suppressed" });
    await call(svc, { RecordType: "SpamComplaint", Email: "spam@example.test" }, basic("hook-secret"));
    await call(svc, { RecordType: "SubscriptionChange", Recipient: "sub@example.test", SuppressSending: true, SuppressionReason: "ManualSuppression" }, basic("hook-secret"));
    expect(svc.suppression.isSuppressed("hard@example.test")).toBe(true);
    expect(svc.suppression.isSuppressed("spam@example.test")).toBe(true);
    expect(svc.suppression.isSuppressed("sub@example.test")).toBe(true);
    expect(svc.suppression.isSuppressed("soft@example.test")).toBe(false);
    const stored = readFileSync(join(dir, "mail", "suppression.json"), "utf8");
    expect(stored).not.toContain("example.test");
    expect(lines.join("\n")).not.toContain("example.test");
    // A complaint is sticky: a later bounce or inactive event does not downgrade it.
    await call(svc, { RecordType: "Bounce", Type: "HardBounce", Email: "spam@example.test" }, basic("hook-secret"));
    expect(svc.suppression.entry("spam@example.test")!.reason).toBe("complaint");
    // Reactivation lifts a manual suppression but never a complaint.
    await call(svc, { RecordType: "SubscriptionChange", Recipient: "sub@example.test", SuppressSending: false }, basic("hook-secret"));
    await call(svc, { RecordType: "SubscriptionChange", Recipient: "spam@example.test", SuppressSending: false }, basic("hook-secret"));
    expect(svc.suppression.isSuppressed("sub@example.test")).toBe(false);
    expect(svc.suppression.isSuppressed("spam@example.test")).toBe(true);
    // Only an explicit admin clear removes it, and that is logged without the address.
    expect(svc.clearSuppression("spam@example.test")).toBe(true);
    expect(svc.suppression.isSuppressed("spam@example.test")).toBe(false);
    expect(lines.some((l) => l.includes("suppression cleared (complaint) by admin"))).toBe(true);
    expect(lines.join("\n")).not.toContain("example.test");
  });
});

// ---- signed links: unsubscribe + verification ------------------------------------------------------------------------

const consenting = (email: string, leagues: Record<string, unknown> = { tabbl: { acknowledgedAt: "2026-10-01T00:00:00.000Z" } }, verified = true) => ({
  ffbCoachId: "x", banned: false,
  contact: { email, emailVerified: verified },
  consent: { leagueContact: { granted: true, grantedAt: "2026-10-01T00:00:00.000Z" }, leagues },
});

describe("signed links", () => {
  it("sign / verify: tampering, wrong purpose and expiry are refused", () => {
    const tok = signLink("k".repeat(40), { v: 1, p: "unsub", c: "ann", e: Math.floor(T0 / 1000) + 60 });
    expect(verifyLink("k".repeat(40), tok, "unsub", T0)).toMatchObject({ ok: true, payload: { c: "ann" } });
    expect(verifyLink("k".repeat(40), tok, "verify", T0)).toEqual({ ok: false, reason: "purpose" });
    expect(verifyLink("other".repeat(10), tok, "unsub", T0)).toEqual({ ok: false, reason: "signature" });
    expect(verifyLink("k".repeat(40), `${tok.slice(0, -2)}AA`, "unsub", T0).ok).toBe(false);
    expect(verifyLink("k".repeat(40), tok, "unsub", T0 + 61_000)).toEqual({ ok: false, reason: "expired" });
    expect(verifyLink("k".repeat(40), "junk", "unsub", T0)).toEqual({ ok: false, reason: "malformed" });
  });

  it("unsubscribe: GET only shows the button; one-click POST turns league mail off and writes consent when present", async () => {
    const identities: Record<string, Record<string, unknown>> = { ann: consenting("ann@example.test") };
    const writes: Array<Record<string, unknown>> = [];
    const identity = (c: string) => identities[c.toLowerCase()];
    const svc = createMailService(tmp(), ENV, {
      identity, now: () => T0,
      contactWriter: createIdentityContactWriter({ identity, write: (c, r) => { writes.push(r); identities[c.toLowerCase()] = r; } }),
    });
    expect(svc.resolver.resolve("Ann")!.canReceiveLeagueMail("tabbl")).toBe(true);
    const url = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    expect(url.origin).toBe("https://site.example.test");
    expect(url.search).not.toContain("example.test");
    const get = await svc.publicRoute("GET", url.pathname, url.searchParams, {}, async () => "");
    expect(get!.status).toBe(200);
    expect(get!.html).toContain("Stop league emails");
    expect(svc.prefs.get("ann").leagueMailOff).toBeUndefined();
    const post = await svc.publicRoute("POST", url.pathname, url.searchParams, {}, async () => "List-Unsubscribe=One-Click");
    expect(post!.status).toBe(200);
    expect(post!.html).toContain("League emails turned off");
    expect(svc.prefs.get("ann").leagueMailOff?.at).toBe(new Date(T0).toISOString());
    expect(writes[0]).toMatchObject({ consent: { leagueContact: { granted: false } } });
    expect(svc.resolver.resolve("Ann")!.canReceiveLeagueMail("tabbl")).toBe(false);
    // The page's form button posts the token in the body.
    const form = await svc.publicRoute("POST", url.pathname, new URLSearchParams(), {}, async () => `token=${encodeURIComponent(url.searchParams.get("token")!)}`);
    expect(form!.status).toBe(200);
    const bad = await svc.publicRoute("POST", url.pathname, new URLSearchParams({ token: "nope.nope" }), {}, async () => "");
    expect(bad!.status).toBe(400);
  });

  it("an unsubscribe link expires after 60 days", async () => {
    let now = T0;
    const svc = createMailService(tmp(), ENV, { identity: () => consenting("ann@example.test"), now: () => now });
    const url = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    now += 59 * 24 * 3600 * 1000;
    expect((await svc.publicRoute("GET", url.pathname, url.searchParams, {}, async () => ""))!.status).toBe(200);
    now += 2 * 24 * 3600 * 1000;
    const r = await svc.publicRoute("POST", url.pathname, url.searchParams, {}, async () => "");
    expect(r!.status).toBe(410);
    expect(r!.html).toContain("Link expired");
  });

  it("an unsubscribe link is void after the address changes or the coach re-consents", async () => {
    let now = T0;
    const identities: Record<string, unknown> = { ann: consenting("ann@example.test") };
    const svc = createMailService(tmp(), ENV, { identity: (c) => identities[c.toLowerCase()], now: () => now });
    const old = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    identities.ann = consenting("ann2@example.test");
    const moved = await svc.publicRoute("POST", old.pathname, old.searchParams, {}, async () => "");
    expect(moved!.status).toBe(410);
    expect(moved!.html).toContain("Link out of date");
    expect(svc.prefs.get("ann").leagueMailOff).toBeUndefined();

    identities.ann = consenting("ann@example.test");
    const first = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    expect((await svc.publicRoute("POST", first.pathname, first.searchParams, {}, async () => ""))!.status).toBe(200);
    now += 1000;
    svc.meRoute("POST", "/api/me/email/league-mail", { coach: "Ann" }, { on: true }); // re-consent: new generation
    expect(svc.prefs.get("ann").consentGen).toBe(1);
    expect((await svc.publicRoute("GET", first.pathname, first.searchParams, {}, async () => ""))!.status).toBe(410);
    const fresh = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    expect((await svc.publicRoute("POST", fresh.pathname, fresh.searchParams, {}, async () => ""))!.status).toBe(200);
  });

  it("a link opt-out yields to consent granted again after it", () => {
    const prefs = new MailPrefsStore(tmp());
    prefs.update("ann", () => ({ leagueMailOff: { at: "2026-10-15T00:00:00.000Z" } }));
    const before = createDefaultRecipientResolver({ identity: () => consenting("ann@example.test"), prefs });
    expect(before.resolve("ann")!.canReceiveLeagueMail("tabbl")).toBe(false);
    const regranted = { ...consenting("ann@example.test"), consent: { leagueContact: { granted: true, grantedAt: "2026-10-20T00:00:00.000Z" }, leagues: { tabbl: true } } };
    expect(createDefaultRecipientResolver({ identity: () => regranted, prefs }).resolve("ann")!.canReceiveLeagueMail("tabbl")).toBe(true);
    expect(leagueAcknowledged({ a: { granted: false } }, "a")).toBe(false);
    expect(leagueAcknowledged({ a: { acknowledgedAt: "x", revokedAt: "y" } }, "a")).toBe(false);
    expect(leagueAcknowledged({}, "a")).toBe(false);
  });
});

describe("email verification", () => {
  it("sends a link for an entered address, and GET /api/mail/verify marks it verified once", async () => {
    let now = T0;
    const transport = new MemoryTransport();
    const svc = createMailService(tmp(), ENV, { identity: () => ({ ffbCoachId: "Ann", banned: false }), transport, now: () => now });
    expect(svc.resolver.resolve("Ann")).toMatchObject({ verified: false });
    expect(svc.meRoute("POST", "/api/me/email/verify", undefined, {})!.status).toBe(401);
    expect(svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "not-an-address" })!.status).toBe(400);
    expect(svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann", test: true }, { email: "ann@example.test" })!.status).toBe(403);
    const sent = svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "ann@example.test" })!;
    expect(sent.status).toBe(202);
    expect(JSON.stringify(sent.json)).not.toContain("example.test");
    await svc.worker.drain();
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!).toMatchObject({ to: "ann@example.test", template: "verify-email", stream: "outbound" });
    const link = new URL(/https:\/\/site\.example\.test\/api\/mail\/verify\?token=\S+/.exec(transport.sent[0]!.text)![0]);
    expect(link.search).not.toContain("example.test");
    expect((svc.meRoute("GET", "/api/me/email", { coach: "Ann" }, undefined)!.json as { pending: unknown }).pending).toMatchObject({ email: "ann@example.test" });
    // A second request inside a minute is refused.
    expect(svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "ann@example.test" })!.status).toBe(429);
    const ok = await svc.publicRoute("GET", link.pathname, link.searchParams, {}, async () => "");
    expect(ok!.status).toBe(200);
    expect(svc.resolver.resolve("Ann")).toMatchObject({ email: "ann@example.test", verified: true });
    const again = await svc.publicRoute("GET", link.pathname, link.searchParams, {}, async () => "");
    expect(again!.status).toBe(410);
    now += 25 * 3600 * 1000;
    expect((svc.meRoute("GET", "/api/me/email", { coach: "Ann" }, undefined)!.json as { verified: boolean }).verified).toBe(true);
  });

  it("a suppressed address gets the same 202 (nothing sent) after the rate limit is consumed; 503 when email is off", () => {
    const svc = createMailService(tmp(), ENV, { identity: () => ({}), transport: new MemoryTransport() });
    svc.suppression.suppress("ann@example.test", "bounce");
    const fresh = svc.meRoute("POST", "/api/me/email/verify", { coach: "Bob" }, { email: "bob@example.test" })!;
    const r = svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "ann@example.test" })!;
    expect(r.status).toBe(202);
    expect(r.json).toEqual(fresh.json);
    expect(svc.outbox.list().map((e) => e.message?.to)).toEqual(["bob@example.test"]);
    expect(svc.prefs.get("ann").pending).toBeUndefined();
    expect(svc.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "ann@example.test" })!.status).toBe(429);
    const off = createMailService(tmp(), { MAIL_LINK_SECRET: ENV.MAIL_LINK_SECRET }, { identity: () => ({}) });
    expect(off.meRoute("POST", "/api/me/email/verify", { coach: "Ann" }, { email: "ann@example.test" })!.status).toBe(503);
  });
});

// ---- league messages ----------------------------------------------------------------------------------------------------

const team = (id: string, name: string, coachId?: string): LeagueTeam => ({
  id, name, race: "Orc", coach: coachId ?? name, ...(coachId ? { coachId } : {}), teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [],
} as LeagueTeam);

const season = (n: number, teams: LeagueTeam[]): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams, participants: [{ coach: "Fay", coachId: "Fay", country: "US", race: "Human", team: "Humans", active: true }],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
} as SeasonRecord);

function leagueFixture(opts: { cap?: number; emailOn?: boolean } = {}) {
  const dir = tmp();
  const store = new LeagueStore(dir);
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
  store.putSeason(season(1, [team("old", "Old", "Zed")]));
  store.putSeason(season(2, [
    team("orcs", "Orcs", "Ann"), team("elves", "Elves", "Bob"), team("dwarfs", "Dwarfs", "Cat"), team("humans", "Humans", "Dee"),
    team("skaven", "Skaven", "Eve"), team("noacct", "No Account"), team("mine", "Jay's Team", "Jay"),
  ]));
  const identities: Record<string, unknown> = {
    ann: consenting("ann@example.test"), // emailed
    bob: { ffbCoachId: "Bob", banned: false }, // no consent fields at all (deploy-0818 shape)
    cat: consenting("cat@example.test", {}), // consent but no league acknowledgement
    dee: consenting("dee@example.test", undefined, false), // unverified
    eve: consenting("eve@example.test"), // suppressed below
    // fay: no identity
  };
  const transport = new MemoryTransport();
  const svcDeps: MailServiceDeps = { identity: (c) => identities[c.toLowerCase()], transport, now: () => T0 };
  const svc = createMailService(dir, opts.emailOn === false ? { MAIL_LINK_SECRET: ENV.MAIL_LINK_SECRET } : ENV, svcDeps);
  svc.suppression.suppress("eve@example.test", "bounce");
  const notifications = new NotificationStore(dir, { now: () => new Date(T0) });
  const deps: LeagueMessageDeps = {
    store, resolver: svc.resolver, isSuppressed: (a) => svc.suppression.isSuppressed(a), enqueue: (i) => svc.enqueue(i),
    leagueLoad: (id) => svc.outbox.leagueLoad(id), leagueDailyCap: opts.cap ?? 500, emailEnabled: svc.emailEnabled,
    unsubscribeUrl: svc.unsubscribeUrl, absolute: svc.absolute, leagueStream: "broadcast",
    notify: (c, input) => { notifications.add(c, input); }, audit: svc.audit, limiter: new LeagueMessageLimiter(), now: () => T0,
  };
  return { dir, svc, deps, transport, notifications };
}

const post = (deps: LeagueMessageDeps, auth: { coach: string; admin: boolean } | undefined, body: unknown) =>
  leagueMessagesRoute("POST", "/api/leagues/tabbl/messages", auth, body, deps)!;
const ALL = { scope: "all", subject: "Week 3", body: "Fixtures are out.\nGood luck <b>all</b>." };
const JAY = { coach: "Jay", admin: false };

describe("league messages: authz and validation", () => {
  it("401 anonymous, 404 unknown league, 403 non-organiser; organisers and site admins may send", () => {
    const { deps } = leagueFixture();
    expect(post(deps, undefined, ALL).status).toBe(401);
    expect(leagueMessagesRoute("POST", "/api/leagues/nope/messages", JAY, ALL, deps)!.status).toBe(404);
    expect(post(deps, { coach: "Ann", admin: false }, ALL).status).toBe(403);
    expect(leagueMessagesRoute("GET", "/api/leagues/tabbl/messages", { coach: "Ann", admin: false }, undefined, deps)!.status).toBe(403);
    expect(post(deps, JAY, ALL).status).toBe(201);
    expect(post(deps, { coach: "Root", admin: true }, ALL).status).toBe(201);
    expect(leagueMessagesRoute("GET", "/api/leagues/tabbl/other", JAY, ALL, deps)).toBeUndefined();
  });

  it("validates subject, body and recipients", () => {
    const { deps } = leagueFixture();
    expect(post(deps, JAY, { ...ALL, subject: "" }).status).toBe(400);
    expect(post(deps, JAY, { ...ALL, subject: "x".repeat(121) }).status).toBe(400);
    expect(post(deps, JAY, { ...ALL, body: "x".repeat(5001) }).status).toBe(400);
    expect(post(deps, JAY, { ...ALL, scope: "everyone" }).status).toBe(400);
    expect(post(deps, JAY, { ...ALL, scope: "team", teamId: "old" }).status).toBe(400); // not in the newest season
    expect(post(deps, JAY, { ...ALL, scope: "team", teamId: "noacct" }).status).toBe(409);
    expect(post(deps, JAY, { ...ALL, scope: "coach", coach: "Zed" }).status).toBe(400);
    expect(post(deps, JAY, { ...ALL, body: "x".repeat(5000) }).status).toBe(201);
  });
});

describe("league messages: recipients, email, notifications, audit", () => {
  it("emails only consenting, acknowledged, verified, unsuppressed members; the response hides small skipped groups", async () => {
    const { deps, svc, transport, notifications, dir } = leagueFixture();
    const r = post(deps, JAY, ALL);
    expect(r.status).toBe(201);
    // 6 recipients, but unverified (1) and suppressed (1) are 1-2 member groups: no breakdown, no queued figure.
    expect(r.body).toEqual({ id: expect.any(String), emailEnabled: true, counts: { notified: 6, queued: null, skipped: null } });
    const text = JSON.stringify(r.body);
    for (const leak of ["example.test", "Bob", "Cat", "Dee", "Eve", "Fay"]) expect(text).not.toContain(leak);

    await svc.worker.drain();
    expect(transport.sent.map((m) => m.to)).toEqual(["ann@example.test"]);
    const m = transport.sent[0]!;
    expect(m.subject).toBe("[TABBL] Week 3");
    expect(m.stream).toBe("broadcast");
    expect(m.html).toContain("Good luck &lt;b&gt;all&lt;/b&gt;.");
    expect(m.html).not.toContain("<b>all</b>");
    expect(m.text).toContain("Jay (organiser of TABBL)");
    expect(m.text).toContain("https://site.example.test/app/leagues/tabbl");
    expect(m.headers).toEqual([
      { name: "List-Unsubscribe", value: expect.stringMatching(/^<https:\/\/site\.example\.test\/api\/mail\/unsubscribe\?token=/) },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ]);
    expect(JSON.stringify(m.metadata)).not.toContain("example.test");

    // Every member (with or without email) gets the in-portal notification; the sender does not.
    for (const c of ["Ann", "Bob", "Cat", "Dee", "Eve", "Fay"]) expect(notifications.list(c).notifications[0]).toMatchObject({ type: "league-broadcast", title: "TABBL: Week 3", from: "Jay", link: "/app/leagues/tabbl" });
    expect(notifications.list("Jay").total).toBe(0);

    // Audit: counts, no addresses; the GET read shows it.
    const audit = readFileSync(join(dir, "mail", "audit.jsonl"), "utf8");
    expect(audit).not.toContain("example.test");
    expect(JSON.parse(audit.trim())).toMatchObject({ leagueId: "tabbl", sender: "Jay", scope: "all", notified: 6, queued: 1 });
    const view = leagueMessagesRoute("GET", "/api/leagues/tabbl/messages", JAY, undefined, deps)!;
    expect(view.body).toMatchObject({ emailEnabled: true, recent: [{ sender: "Jay", scope: "all", counts: { notified: 6, queued: null, skipped: null } }] });
    expect(JSON.stringify(view.body)).not.toContain("example.test");
  });

  it("one team's coach and one coach: no counts at all (they would reveal that coach's choices)", () => {
    const { deps, notifications, svc } = leagueFixture();
    const team = post(deps, JAY, { ...ALL, scope: "team", teamId: "orcs" }).body;
    const coach = post(deps, JAY, { ...ALL, scope: "coach", coach: "bob" }).body;
    expect(team).toEqual({ id: expect.any(String), emailEnabled: true, counts: null, summary: PRIVATE_SUMMARY });
    expect(coach).toEqual({ id: expect.any(String), emailEnabled: true, counts: null, summary: PRIVATE_SUMMARY });
    expect(svc.outbox.list()).toHaveLength(1); // Ann was emailed, Bob was not: indistinguishable to the organiser
    const view = leagueMessagesRoute("GET", "/api/leagues/tabbl/messages", JAY, undefined, deps)!.body as { recent: Array<{ counts: unknown }> };
    expect(view.recent.map((x) => x.counts)).toEqual([null, null]);
    expect(notifications.list("Bob").total).toBe(1);
    expect(notifications.list("Cat").total).toBe(0);
  });

  it("with email off, members are still notified and nothing is queued", () => {
    const { deps, svc } = leagueFixture({ emailOn: false });
    expect(post(deps, JAY, ALL).body).toMatchObject({ counts: { notified: 6 }, emailEnabled: false });
    expect(svc.outbox.list()).toHaveLength(0);
  });

  it("rate limit per organiser per league, the daily email cap, and requestId replays", () => {
    const { deps, notifications } = leagueFixture();
    const first = post(deps, JAY, { ...ALL, requestId: "req-12345678" });
    const replay = post(deps, JAY, { ...ALL, requestId: "req-12345678" });
    expect(replay).toBe(first);
    expect(notifications.list("Ann").total).toBe(1);
    for (let i = 1; i < 10; i += 1) expect(post(deps, JAY, ALL).status).toBe(201);
    const limited = post(deps, JAY, ALL);
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBeTruthy();
    expect(post(deps, { coach: "Root", admin: true }, ALL).status).toBe(201); // another sender has their own budget

    const capped = leagueFixture({ cap: 1 });
    expect(post(capped.deps, JAY, ALL).status).toBe(201);
    expect(post(capped.deps, JAY, ALL).status).toBe(429);
  });

  it("disclosure rule: all-members with >= 5 recipients only; breakdown only when no skipped group is 1 or 2", () => {
    const sk = (noConsent: number, unverified: number, suppressed: number) => ({ noConsent, unverified, suppressed });
    expect(disclosedCounts("coach", { notified: 9, queued: 9, skipped: sk(0, 0, 0) })).toBeNull();
    expect(disclosedCounts("team", { notified: 9, queued: 9, skipped: sk(0, 0, 0) })).toBeNull();
    expect(disclosedCounts("all", { notified: 4, queued: 1, skipped: sk(3, 0, 0) })).toBeNull();
    expect(disclosedCounts("all", { notified: 12, queued: 3, skipped: sk(3, 6, 0) })).toEqual({ notified: 12, queued: 3, skipped: sk(3, 6, 0) });
    expect(disclosedCounts("all", { notified: 12, queued: 4, skipped: sk(5, 2, 1) })).toEqual({ notified: 12, queued: null, skipped: null });
  });

  it("re-checks consent at send time: a coach who withdrew while queued is dropped and counted as skipped", async () => {
    const { deps, svc, transport } = leagueFixture();
    expect(post(deps, JAY, { ...ALL, scope: "team", teamId: "orcs" }).status).toBe(201);
    expect(svc.outbox.list()).toHaveLength(1);
    // Ann turns league email off with a fresh link before the worker runs.
    const url = new URL(svc.unsubscribeUrl("Ann", "tabbl", "ann@example.test"));
    expect((await svc.publicRoute("POST", url.pathname, url.searchParams, {}, async () => ""))!.status).toBe(200);
    await svc.worker.drain();
    expect(transport.sent).toHaveLength(0);
    expect(svc.outbox.list()[0]).toMatchObject({ status: "dead", error: "ineligible: noConsent" });
    expect(svc.audit.forLeague("tabbl")[0]).toMatchObject({ queued: 0, skipped: { noConsent: 1, unverified: 0, suppressed: 0 } });
  });

  it("re-checks at send time: a changed address or a new suppression drops the queued copy", async () => {
    const changed = leagueFixture();
    expect(post(changed.deps, JAY, { ...ALL, scope: "team", teamId: "orcs" }).status).toBe(201);
    changed.svc.suppression.suppress("ann@example.test", "complaint");
    await changed.svc.worker.drain();
    expect(changed.transport.sent).toHaveLength(0);
    expect(changed.svc.audit.forLeague("tabbl")[0]!.skipped.suppressed).toBe(1);
  });

  it("renders user text as plain text only", () => {
    const r = renderLeagueMessage({ leagueName: "L<x>", senderCoach: "Jay\r\nBcc: x", subject: "Hi\nthere", body: "<script>alert(1)</script>", leagueUrl: "https://s/l", unsubscribeUrl: "https://s/u" });
    expect(r.subject).toBe("[L<x>] Hi there");
    expect(r.html).not.toContain("<script>");
    expect(r.html).toContain("L&lt;x&gt;");
    expect(r.text).not.toMatch(/\r/);
  });
});

describe("account deletion hook", () => {
  it("forgets a coach's prefs but keeps suppression hashes", () => {
    const dir = tmp();
    const svc = createMailService(dir, ENV, { identity: () => undefined });
    svc.prefs.update("ann", () => ({ email: { address: "ann@example.test", verifiedAt: "x" } }));
    svc.suppression.suppress("ann@example.test", "bounce");
    svc.forgetCoach("Ann");
    expect(svc.prefs.get("ann")).toEqual({});
    expect(svc.suppression.isSuppressed("ann@example.test")).toBe(true);
    expect(existsSync(join(dir, "mail", "prefs.json"))).toBe(true);
    expect(readFileSync(join(dir, "mail", "prefs.json"), "utf8")).not.toContain("example.test");
  });
});
