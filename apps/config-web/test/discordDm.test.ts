import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACTION_DM, actionDmText, escapeDiscordName } from "../src/mail/actionMessages";
import { createDiscordDmTransport, DISCORD_API, discordDmConfigFromEnv, DiscordDmRefused, discordNonce } from "../src/mail/discord";
import { retryDelayMs } from "../src/mail/outbox";
import { createMailService, DISCORD_DM_TEXT, DISCORD_DM_VERSION } from "../src/mail/service";
import { MailSendAborted, MailSendError, MemoryTransport, type MailMessage } from "../src/mail/transport";
import { NotificationStore, SenderRateLimiter } from "../src/notifications";
import { clearFences, coachKeyHash, fenceCoachHash } from "../src/privacy/fence";
import { scheduleApi, type ScheduleApiDeps } from "../src/schedule/api";
import { clearScheduleIndex, createFixtureSource, tournamentRef } from "../src/schedule/fixtures";
import { ProposalStore } from "../src/schedule/store";
import { TournamentStore } from "../src/tournaments/store";
import { LeagueStore } from "../src/leagues/store";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { onboardingGateApplies } from "../src/auth/onboarding";

// Discord DMs for actionable notifications (owner 11-01, laws §E 23c; src/mail/discord.ts, actionMessages.ts, service.ts):
// a game-time proposal queues ONE bot DM for the coach who has to act, the Account opt-out is respected at enqueue and at
// every send attempt, a refused DM is dead-lettered and falls back to ONE email only with email consent, the deletion
// fence drops queued DMs, export/delete cover the discord rows, and no Discord id or token ever reaches a log, a response,
// the journal or an export. Nothing is sent: transports are in-memory and fetch is mocked. Fake ids and example.test only.

const roots: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "discorddm-")); roots.push(d); return d; };
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); clearFences(); });
beforeEach(() => clearFences());

const H = 3_600_000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const S1 = "2026-11-12T18:00:00.000Z";
const S2 = "2026-11-13T18:00:00.000Z";
const TOKEN = "bot-token-for-tests-only";
const IDS: Record<string, string> = { ann: "900000000000000101", eve: "900000000000000202" };
const ENV = { MAIL_LINK_SECRET: "x".repeat(40), MAIL_LINK_BASE_URL: "https://site.example.test", MAIL_FROM: "noreply@site.example.test" };
const M1 = tournamentRef("m1");

interface Coach { discord?: boolean; consent?: boolean; email?: boolean }

function identities(spec: Record<string, Coach>) {
  return (coach: string): unknown => {
    const key = coach.trim().toLowerCase();
    const c = spec[key];
    if (!c) return undefined;
    return {
      ffbCoachId: key,
      identities: c.discord === false ? {} : { discordUserId: IDS[key] },
      ...(c.email === false ? {} : { contact: { email: `${key}@example.test`, emailSource: "user", emailVerified: true, phones: [] } }),
      consent: { ...(c.consent ? { leagueContact: { granted: true, at: "2026-11-01T00:00:00.000Z", version: "v" } } : {}) },
    };
  };
}

function setup(opts: { spec?: Record<string, Coach>; env?: Record<string, string>; discord?: MemoryTransport | "real" | "none"; fetch?: typeof fetch } = {}) {
  const dir = tmp();
  const clock = { t: NOW };
  const lines: string[] = [];
  const email = new MemoryTransport();
  const dm = opts.discord === undefined ? new MemoryTransport() : opts.discord;
  const svc = createMailService(dir, { ...ENV, ...(opts.discord === "real" ? { DISCORD_BOT_TOKEN: TOKEN } : {}), ...(opts.env ?? {}) }, {
    identity: identities(opts.spec ?? { ann: { consent: true }, eve: { consent: true } }),
    transport: email,
    ...(dm instanceof MemoryTransport ? { discordTransport: dm } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    discordSleep: async () => {},
    now: () => clock.t,
    log: (l) => lines.push(l),
  });
  const notifications = new NotificationStore(dir, { now: () => new Date(clock.t), onAdded: (coach, record, _u, input) => { svc.notifyAction(coach, record, input); } });
  // A tournament match between Ann and Eve, and the schedule routes over it.
  const tournaments = new TournamentStore(dir);
  tournaments.writeSnapshot({
    version: 4,
    tournaments: { t1: { id: "t1", name: "Autumn Open", status: "active" } },
    entrants: {
      e1: { id: "e1", tournamentId: "t1", seed: 1, coach: { ffbCoachId: "Ann" }, teamId: "x1", registeredAt: "2026-11-01T00:00:00.000Z", submission: { teamName: "Ann's Orcs" } },
      e2: { id: "e2", tournamentId: "t1", seed: 2, coach: { ffbCoachId: "Eve" }, teamId: "x2", registeredAt: "2026-11-01T00:00:00.000Z", submission: { teamName: "Eve's Elves" } },
    },
    rounds: {}, standings: {},
    scheduledMatches: {
      m1: { id: "m1", tournamentId: "t1", roundId: "r1", roundNumber: 1, home: { entrantId: "e1", coach: { ffbCoachId: "Ann" }, teamId: "x1" }, away: { entrantId: "e2", coach: { ffbCoachId: "Eve" }, teamId: "x2" }, status: "scheduled", revision: 3, launch: { retryCount: 0 }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" },
    },
    waitingPresence: {},
  } as never);
  const leagues = new LeagueStore(dir);
  const deps: ScheduleApiDeps = {
    store: new ProposalStore(dir),
    fixtures: createFixtureSource({ leagues, tournaments, now: () => clock.t }),
    coach: (name) => ["Ann", "Eve"].find((a) => a.toLowerCase() === name.trim().toLowerCase()),
    scheduling: () => ({ timezone: "Europe/London", availability: [] }),
    hasBlocked: () => false,
    isFenced: () => false,
    notify: (coach, input) => { try { notifications.add(coach, input); } catch { /* fire-and-forget */ } },
    limiter: new SenderRateLimiter(100, H),
    now: () => clock.t,
  };
  const call = (coach: string, path: string, body: unknown) => scheduleApi("POST", path, { coach }, body, deps) as { status: number; body: any };
  const me = (coach: string, method: string, body?: unknown, test?: boolean) =>
    svc.meRoute(method, "/api/me/notification-settings", { coach, ...(test ? { test: true } : {}) }, body)!;
  const cleanup = () => clearScheduleIndex(leagues);
  return {
    dir, svc, clock, lines, email, dm, notifications, call, me, cleanup,
    propose: (coach: string, slots = [S1]) => call(coach, "/api/schedule/propose", { fixture: M1, slots }),
    respond: (coach: string, body: Record<string, unknown>) => call(coach, "/api/schedule/respond", body),
    discordRows: () => svc.outbox.list().filter((e) => e.channel === "discord"),
    emailRows: () => svc.outbox.list().filter((e) => e.channel === "email"),
    journal: () => readFileSync(svc.outbox.file, "utf8"),
  };
}

const jsonRes = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fetch mock answering Discord: open DM -> channel, post -> message, or the scripted error per call. */
function discordFetch(script: (url: string, n: number) => Response | undefined = () => undefined) {
  let n = 0;
  return vi.fn(async (url: string | URL | Request) => {
    n += 1;
    const u = String(url);
    const scripted = script(u, n);
    if (scripted) return scripted;
    if (u.endsWith("/users/@me/channels")) return jsonRes(200, { id: "910000000000000001" });
    return jsonRes(200, { id: `920000000000000${String(n).padStart(3, "0")}` });
  });
}

const noSecrets = (text: string) => {
  for (const id of Object.values(IDS)) expect(text).not.toContain(id);
  expect(text).not.toContain(TOKEN);
};

describe("which notifications DM", () => {
  it("the table has exactly the proposal types, with short plain text and the link", () => {
    // + the registration rows (registration spec Q18), which DM only when flagged actionable (test/registrationCore.test.ts).
    expect(Object.keys(ACTION_DM).sort()).toEqual(["check-in", "proposal-accepted", "proposal-countered", "proposal-received", "registration", "registration-outcome"]);
    const text = actionDmText({ record: { type: "proposal-received", from: "Ann", title: "t", link: "/app/schedule" }, subject: "Round 1 vs Eve's Elves · Autumn Open", url: "https://site.example.test/app/schedule?proposal=p1" });
    expect(text).toEqual({
      text: "Ann proposed times for Round 1 vs Eve's Elves · Autumn Open. Accept or decline: https://site.example.test/app/schedule?proposal=p1",
      plain: "Ann proposed times for Round 1 vs Eve's Elves · Autumn Open. Accept or decline: https://site.example.test/app/schedule?proposal=p1",
    });
    expect(actionDmText({ record: { type: "award", from: "", title: "t", link: "/app/" }, url: "x" })).toBeUndefined();
  });

  it("names cannot inject Markdown links or URLs: the action link is the only link in the DM", () => {
    const url = "https://site.example.test/app/schedule?proposal=p1";
    const dm = actionDmText({
      record: { type: "proposal-received", from: "**Admin** <@123>", title: "t", link: "/app/schedule" },
      subject: "[Accept here](https://evil.example) · `x` ~~y~~ > z # www.evil.example _u_ |s| (p) -",
      url,
    })!;
    // Only one URL: the action link at the end. The names part has every Markdown character escaped.
    expect(dm.text.match(/https?:\/\//g)).toHaveLength(1);
    expect(dm.text.endsWith(`Accept or decline: ${url}`)).toBe(true);
    expect(dm.text).not.toContain("www.evil");
    const names = dm.text.slice(0, dm.text.indexOf(". Accept or decline: "));
    for (let i = 0; i < names.length; i += 1) {
      const c = names[i]!;
      if ("*_~`|>[]()#-<@:".includes(c)) expect(names[i - 1], `"${c}" at ${i} in ${names}`).toBe("\\");
    }
    expect(dm.text).toContain(String.raw`\[Accept here\]\(https //evil.example\)`);
    expect(dm.text).toContain(String.raw`\*\*Admin\*\* \<\@123\>`);
    // the email fallback gets the plain words
    expect(dm.plain).toContain("[Accept here](https://evil.example)");
    expect(escapeDiscordName(String.raw`a\b`)).toBe(String.raw`a\\b`);
  });

  it("only DISCORD_BOT_TOKEN is read from the env", () => {
    expect(discordDmConfigFromEnv({ DISCORD_BOT_TOKEN: "  t  " })).toEqual({ token: "t" });
    expect(discordDmConfigFromEnv({ DISCORD_TOKEN: "t" })).toEqual({});
  });
});

describe("a proposal queues one DM for the coach who has to act", () => {
  it("propose -> one DM row for the opponent; counter -> one for the proposer; accept -> one for the counter's sender", async () => {
    const h = setup();
    const p = h.propose("Ann");
    expect(p.status).toBe(201);
    let rows = h.discordRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "discord", template: "action-dm", recipient: { coach: "eve" }, status: "queued" });
    expect(rows[0]!.key).toMatch(/^action:dm:eve:n1:/);
    expect(rows[0]!.message!.to).toBe("");
    expect(rows[0]!.message!.text).toMatch(new RegExp(`^Ann proposed times for .*Autumn Open\\. Accept or decline: https://site\\.example\\.test/app/schedule\\?proposal=${p.body.proposal.id}$`));
    expect(await h.svc.worker.drain()).toBe(1);
    expect((h.dm as MemoryTransport).sent).toHaveLength(1);
    expect((h.dm as MemoryTransport).recipients[0]).toEqual({ coach: "eve" });
    expect(h.email.sent).toHaveLength(0);

    const c = h.respond("Eve", { proposalId: p.body.proposal.id, action: "counter", slots: [S2] });
    expect(c.status).toBe(201);
    rows = h.discordRows().filter((r) => r.recipient?.coach === "ann");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message!.text).toMatch(/^Eve suggested other times for .*\. Accept or decline: https:\/\/site\.example\.test\/app\/schedule\?proposal=/);

    const a = h.respond("Ann", { proposalId: c.body.proposal.id, action: "accept", slot: S2 });
    expect(a.status).toBe(200);
    rows = h.discordRows().filter((r) => r.recipient?.coach === "eve");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.message!.text).toMatch(/^Ann accepted a time for .*\. See it on your schedule: https:\/\/site\.example\.test\/app\/schedule\?proposal=/);
    // a decline asks nobody to act: no DM
    const before = h.discordRows().length;
    const p2 = h.propose("Eve", [S1]);
    h.respond("Ann", { proposalId: p2.body.proposal.id, action: "decline" });
    expect(h.discordRows().length).toBe(before + 1);
    // the journal never holds a Discord id
    noSecrets(h.journal());
    h.cleanup();
  });

  it("no DM without a transport, without a link origin, without a linked Discord account, or for a type that does not DM", () => {
    expect(setup({ discord: "none" }).svc.discordEnabled()).toBe(false);
    const noBase = setup({ env: { MAIL_LINK_BASE_URL: "" } });
    expect(noBase.svc.discordEnabled()).toBe(false);
    noBase.propose("Ann");
    expect(noBase.discordRows()).toHaveLength(0);
    noBase.cleanup();
    const unlinked = setup({ spec: { ann: {}, eve: { discord: false } } });
    unlinked.propose("Ann");
    expect(unlinked.discordRows()).toHaveLength(0);
    unlinked.notifications.add("Eve", { type: "award", title: "x", body: "y", link: "/app/" });
    expect(unlinked.discordRows()).toHaveLength(0);
    unlinked.cleanup();
    const h = setup();
    h.notifications.add("Eve", { type: "award", title: "x", body: "y", link: "/app/" });
    expect(h.discordRows()).toHaveLength(0);
    h.cleanup();
  });
});

describe("Account setting: Discord messages for actions I need to take", () => {
  it("on by default for a linked coach; the opt-out is stamped with a version and respected", () => {
    const h = setup();
    const view = h.me("Eve", "GET");
    expect(view.status).toBe(200);
    expect(view.json).toEqual({ discordDm: { label: DISCORD_DM_TEXT, on: true, linked: true, available: true, at: null, version: DISCORD_DM_VERSION }, emailFallback: true });
    noSecrets(JSON.stringify(view));
    const off = h.me("Eve", "POST", { discordDm: false });
    expect(off.status).toBe(200);
    expect((off.json as any).discordDm).toMatchObject({ on: false, at: new Date(NOW).toISOString(), version: DISCORD_DM_VERSION });
    expect(h.svc.prefs.get("Eve").discordDm).toEqual({ on: false, at: new Date(NOW).toISOString(), version: DISCORD_DM_VERSION });
    h.propose("Ann");
    expect(h.discordRows()).toHaveLength(0);
    expect(h.emailRows()).toHaveLength(0);
    // bad bodies and test sessions
    expect(h.me("Eve", "POST", { discordDm: "no" }).status).toBe(400);
    expect(h.me("Eve", "POST", { discordDm: true }, true).status).toBe(403);
    expect(h.me("Eve", "DELETE").status).toBe(405);
    // the POST rides the CSRF guard and the onboarding gate; the GET changes nothing
    expect(isStateChangingApiRequest("POST", "/api/me/notification-settings")).toBe(true);
    expect(onboardingGateApplies("POST", "/api/me/notification-settings")).toBe(true);
    expect(isStateChangingApiRequest("GET", "/api/me/notification-settings")).toBe(false);
    expect(h.svc.meRoute("GET", "/api/me/notification-settings", undefined, undefined)!.status).toBe(401);
    expect(h.me("Eve", "POST", { discordDm: true }).status).toBe(200);
    // write-time checks: an account being deleted, or with no identity, never gets prefs (back)
    fenceCoachHash(coachKeyHash("Eve"));
    h.svc.prefs.remove("Eve");
    expect(h.me("Eve", "POST", { discordDm: false }).status).toBe(410);
    expect(h.svc.prefs.get("Eve")).toEqual({});
    clearFences();
    expect(h.me("Zed", "POST", { discordDm: false }).status).toBe(403);
    expect(h.svc.prefs.get("Zed")).toEqual({});
    h.propose("Ann", [S2]);
    expect(h.discordRows()).toHaveLength(1);
    h.cleanup();
  });

  it("a coach without Discord linked sees linked: false and the email-fallback state of their own account", () => {
    const h = setup({ spec: { ann: { discord: false }, eve: {} } });
    expect((h.me("Ann", "GET").json as any).discordDm).toMatchObject({ linked: false, on: true });
    expect((h.me("Ann", "GET").json as any).emailFallback).toBe(false);
    h.cleanup();
  });

  it("opting out while a DM waits drops it at the send-time re-check (no send, no email)", async () => {
    const h = setup();
    h.propose("Ann");
    h.me("Eve", "POST", { discordDm: false });
    await h.svc.worker.drain();
    expect((h.dm as MemoryTransport).sent).toHaveLength(0);
    expect(h.discordRows()[0]).toMatchObject({ status: "dead", error: "ineligible: noConsent" });
    expect(h.emailRows()).toHaveLength(0);
    h.cleanup();
  });
});

describe("Discord REST transport (mocked fetch)", () => {
  it("opens the DM channel once, posts plain text with mentions off, and sends the bot token only in the header", async () => {
    const fetch = discordFetch();
    const t = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} });
    const msg: MailMessage = { to: "", subject: "s", text: "Ann proposed times for X. Accept or decline: https://site.example.test/app/schedule", html: "", template: "action-dm" };
    await t.send(msg, { recipient: { coach: "eve" } });
    await t.send(msg, { recipient: { coach: "eve" } });
    expect(fetch).toHaveBeenCalledTimes(3); // open once (cached), post twice
    const [openUrl, openInit] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(openUrl).toBe(`${DISCORD_API}/users/@me/channels`);
    expect(JSON.parse(String(openInit.body))).toEqual({ recipient_id: IDS.eve });
    expect((openInit.headers as Record<string, string>).authorization).toBe(`Bot ${TOKEN}`);
    const [postUrl, postInit] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(postUrl).toBe(`${DISCORD_API}/channels/910000000000000001/messages`);
    expect(JSON.parse(String(postInit.body))).toEqual({ content: msg.text, allowed_mentions: { parse: [] }, flags: 4 });
  });

  it("re-checks eligibility right before the message POST (after the channel open): opted out meanwhile = no POST", async () => {
    let eligible = true;
    const f = discordFetch((u) => { if (u.endsWith("/users/@me/channels")) eligible = false; return undefined; });
    const t = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: f as unknown as typeof globalThis.fetch, sleep: async () => {} });
    const msg: MailMessage = { to: "", subject: "s", text: "hi", html: "", template: "action-dm" };
    await expect(t.send(msg, { recipient: { coach: "eve" }, stillEligible: () => eligible })).rejects.toBeInstanceOf(MailSendAborted);
    expect(f).toHaveBeenCalledTimes(1);
    expect(String(f.mock.calls[0]![0])).toMatch(/\/users\/@me\/channels$/);
  });

  it("every POST carries a nonce stable per outbox item with enforce_nonce, the same on a retry after a lost response", async () => {
    const f = discordFetch((u, n) => (n === 2 ? jsonRes(502, {}) : undefined));
    const t = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: f as unknown as typeof globalThis.fetch, sleep: async () => {} });
    const msg: MailMessage = { to: "", subject: "s", text: "hi", html: "", template: "action-dm" };
    await t.send(msg, { recipient: { coach: "eve" }, idempotencyKey: "action:dm:eve:n1:x" });
    const posts = f.mock.calls.filter((c) => String(c[0]).endsWith("/messages")).map((c) => JSON.parse(String(((c as unknown as [string, RequestInit])[1]).body)));
    expect(posts).toHaveLength(2);
    expect(posts[0].nonce).toBe(discordNonce("action:dm:eve:n1:x"));
    expect(posts[0].nonce.length).toBeLessThanOrEqual(25);
    expect(posts[0].enforce_nonce).toBe(true);
    expect(posts[1].nonce).toBe(posts[0].nonce);
    expect(discordNonce("action:dm:eve:n2:x")).not.toBe(posts[0].nonce);
  });

  it("403 / 50007 is permanent and its error carries no id or token; 5xx and 401 are retryable; no id = abandoned", async () => {
    const refuse = discordFetch((u) => (u.endsWith("/messages") ? jsonRes(403, { code: 50007, message: "Cannot send messages to this user" }) : undefined));
    const t = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: refuse as unknown as typeof globalThis.fetch, sleep: async () => {} });
    const msg: MailMessage = { to: "", subject: "s", text: "hi", html: "", template: "action-dm" };
    const err = await t.send(msg, { recipient: { coach: "eve" } }).then(() => undefined, (e: unknown) => e as MailSendError);
    expect(err).toBeInstanceOf(DiscordDmRefused);
    expect(err!.retryable).toBe(false);
    expect(err!.status).toBe(403);
    noSecrets(err!.message);
    expect(err!.message).not.toContain("910000000000000001");
    for (const status of [500, 401]) {
      const f = discordFetch(() => jsonRes(status, {}));
      const r = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: f as unknown as typeof globalThis.fetch, sleep: async () => {}, retries: 0 });
      const e = await r.send(msg, { recipient: { coach: "eve" } }).then(() => undefined, (x: unknown) => x as MailSendError);
      expect(e!.retryable).toBe(true);
    }
    const none = createDiscordDmTransport({ token: TOKEN, resolveUserId: () => undefined, fetch: refuse as unknown as typeof globalThis.fetch });
    await expect(none.send(msg, { recipient: { coach: "eve" } })).rejects.toBeInstanceOf(MailSendAborted);
  });

  it("honours a short 429 inside the send and re-checks eligibility before the retry", async () => {
    const sleeps: number[] = [];
    const f = discordFetch((u, n) => (n === 2 ? jsonRes(429, { retry_after: 0.25, global: false }) : undefined));
    let eligible = true;
    const t = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: f as unknown as typeof globalThis.fetch, sleep: async (ms) => { sleeps.push(ms); eligible = false; }, now: () => NOW });
    const msg: MailMessage = { to: "", subject: "s", text: "hi", html: "", template: "action-dm" };
    await expect(t.send(msg, { recipient: { coach: "eve" }, stillEligible: () => eligible })).rejects.toBeInstanceOf(MailSendAborted);
    expect(sleeps).toEqual([250]);
    expect(f).toHaveBeenCalledTimes(2);
    // a long rate limit goes back to the outbox backoff (retryable), and the bucket holds the next request
    const long = discordFetch(() => jsonRes(429, { retry_after: 60 }));
    const t2 = createDiscordDmTransport({ token: TOKEN, resolveUserId: (c) => IDS[c], fetch: long as unknown as typeof globalThis.fetch, sleep: async () => {}, now: () => NOW });
    const e = await t2.send(msg, { recipient: { coach: "eve" } }).then(() => undefined, (x: unknown) => x as MailSendError);
    expect(e!.retryable).toBe(true);
    expect(long).toHaveBeenCalledTimes(1);
    const e2 = await t2.send(msg, { recipient: { coach: "eve" } }).then(() => undefined, (x: unknown) => x as MailSendError);
    expect(e2!.retryable).toBe(true);
    expect(long).toHaveBeenCalledTimes(1); // held: no request while the bucket waits
  });
});

describe("dead letters, email fallback and retries through the outbox", () => {
  const refused = () => discordFetch((u) => (u.endsWith("/messages") ? jsonRes(403, { code: 50007 }) : undefined));

  it("a refused DM is dead-lettered and falls back to ONE email when the coach has email consent", async () => {
    const fetch = refused();
    const h = setup({ discord: "real", fetch: fetch as unknown as typeof globalThis.fetch });
    h.propose("Ann");
    await h.svc.worker.drain();
    expect(h.discordRows()[0]).toMatchObject({ status: "dead", attempts: 1 });
    expect(h.emailRows()).toHaveLength(1);
    expect(h.emailRows()[0]).toMatchObject({ template: "action-email", recipient: { coach: "eve" } });
    expect(h.emailRows()[0]!.key).toMatch(/^action:email:eve:n1:/);
    await h.svc.worker.drain();
    expect(h.email.sent).toHaveLength(1);
    expect(h.email.sent[0]!.to).toBe("eve@example.test");
    expect(h.email.sent[0]!.text).toContain("Ann proposed times for");
    expect(h.email.sent[0]!.text).toContain("https://site.example.test/app/schedule?proposal=");
    expect(h.email.sent[0]!.headers?.some((x) => x.name === "List-Unsubscribe")).toBe(true);
    // once only: draining again sends nothing more
    await h.svc.worker.drain();
    expect(h.email.sent).toHaveLength(1);
    noSecrets(h.lines.join("\n"));
    noSecrets(h.journal());
    h.cleanup();
  });

  it("no email fallback without consent, without a confirmed address, or after an unsubscribe", async () => {
    for (const spec of [{ ann: {}, eve: {} }, { ann: {}, eve: { consent: true, email: false } }]) {
      const h = setup({ spec, discord: "real", fetch: refused() as unknown as typeof globalThis.fetch });
      h.propose("Ann");
      await h.svc.worker.drain();
      expect(h.discordRows()[0]!.status).toBe("dead");
      expect(h.emailRows()).toHaveLength(0);
      h.cleanup();
    }
    const h = setup({ discord: "real", fetch: refused() as unknown as typeof globalThis.fetch });
    h.svc.prefs.update("Eve", (p) => ({ ...p, leagueMailOff: { at: new Date(NOW).toISOString() } }));
    h.propose("Ann");
    await h.svc.worker.drain();
    expect(h.emailRows()).toHaveLength(0);
    h.cleanup();
  });

  it("a queued fallback email is re-checked at send time (consent withdrawn meanwhile = dropped)", async () => {
    const spec: Record<string, Coach> = { ann: {}, eve: { consent: true } };
    const h = setup({ spec, discord: "real", fetch: refused() as unknown as typeof globalThis.fetch });
    h.propose("Ann");
    await h.svc.worker.drain(); // DM dead, email queued
    expect(h.emailRows()).toHaveLength(1);
    spec.eve!.consent = false;
    await h.svc.worker.drain();
    expect(h.email.sent).toHaveLength(0);
    expect(h.emailRows()[0]).toMatchObject({ status: "dead", error: "ineligible: noConsent" });
    h.cleanup();
  });

  it("a retryable failure backs off, and the retry re-checks eligibility first (opted out = dropped, no request, no email)", async () => {
    const fetch = discordFetch((u) => (u.endsWith("/messages") ? jsonRes(502, {}) : undefined));
    const h = setup({ discord: "real", fetch: fetch as unknown as typeof globalThis.fetch });
    h.propose("Ann");
    await h.svc.worker.drain();
    const row = h.discordRows()[0]!;
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.nextAt).toBe(NOW + retryDelayMs(1));
    const calls = fetch.mock.calls.length;
    h.me("Eve", "POST", { discordDm: false });
    h.clock.t = row.nextAt;
    await h.svc.worker.drain();
    expect(fetch.mock.calls.length).toBe(calls);
    expect(h.discordRows()[0]).toMatchObject({ status: "dead", error: "ineligible: noConsent" });
    expect(h.emailRows()).toHaveLength(0);
    noSecrets(h.lines.join("\n"));
    h.cleanup();
  });

  it("out of retries (Discord down) is dead-lettered WITHOUT the email fallback", async () => {
    const fetch = discordFetch(() => jsonRes(503, {}));
    const h = setup({ discord: "real", fetch: fetch as unknown as typeof globalThis.fetch });
    h.propose("Ann");
    for (let i = 0; i < 10 && h.discordRows()[0]!.status === "queued"; i += 1) {
      h.clock.t = h.discordRows()[0]!.nextAt;
      await h.svc.worker.drain();
    }
    expect(h.discordRows()[0]).toMatchObject({ status: "dead", attempts: 6 });
    expect(h.emailRows()).toHaveLength(0);
    h.cleanup();
  });
});

describe("privacy", () => {
  it("the deletion fence: no DM is queued for a coach being deleted, and a queued one is dropped unsent", async () => {
    const h = setup();
    h.propose("Ann");
    expect(h.discordRows()).toHaveLength(1);
    fenceCoachHash(coachKeyHash("Eve"));
    await h.svc.worker.drain();
    expect((h.dm as MemoryTransport).sent).toHaveLength(0);
    expect(h.discordRows()[0]).toMatchObject({ status: "dead", error: "account deleted" });
    const record = { id: "n9", type: "proposal-received" as const, title: "t", body: "b", link: "/app/schedule", at: new Date(NOW).toISOString(), from: "Ann" };
    expect(h.svc.notifyAction("Eve", record, { subject: "x" })).toBe(false);
    h.cleanup();
  });

  it("export covers discord rows (no address, no Discord id) and the choice; delete removes both", async () => {
    const h = setup();
    h.me("Eve", "POST", { discordDm: true });
    h.propose("Ann");
    await h.svc.worker.drain();
    const exported = h.svc.exportCoach("Eve") as any;
    expect(exported.prefs.discordDm).toMatchObject({ on: true, version: DISCORD_DM_VERSION });
    const row = exported.deliveries.find((d: any) => d.channel === "discord");
    expect(row).toMatchObject({ channel: "discord", template: "action-dm", status: "sent" });
    expect(row.text).toContain("Ann proposed times for");
    expect(row).not.toHaveProperty("to");
    noSecrets(JSON.stringify(exported));
    h.svc.forgetCoach("Eve");
    expect(h.svc.outbox.forCoach("Eve")).toHaveLength(0);
    expect(h.svc.prefs.get("Eve")).toEqual({});
    expect(h.journal()).not.toContain("Ann proposed times for");
    h.cleanup();
  });
});
