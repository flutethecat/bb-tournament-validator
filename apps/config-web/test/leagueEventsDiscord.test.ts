import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORDS_ROT13 } from "../src/discord/profanityList";
import {
  createGuildEventsClient, DISCORD_SYNC_MAX_ATTEMPTS, discordRetryDelayMs, DiscordEventsError, type GuildEventsClient, type ScheduledEventBody,
} from "../src/discord/scheduledEvents";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { ADD_BOT_TEXT, createDiscordSyncRunner, eventsBotInviteUrl, runLeagueEventDiscordSync } from "../src/leagues/leagueEvents";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueEventsDeps } from "../src/leagues/leagueEvents";

// League Events -> Discord Guild Scheduled Events (src/discord/scheduledEvents.ts + runLeagueEventDiscordSync): create /
// update / delete against a STUBBED Discord, retries with backoff, the token / bot-missing path, the bot-in-server check,
// and that a save never waits for Discord. Nothing here reaches the network.

const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const LISTED = rot13(WORDS_ROT13[1]!);
const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const VOICE = "333333333333333333";
const NOW = new Date("2026-10-26T12:00:00.000Z");

type Call = { op: "create" | "update" | "remove"; guildId: string; eventId?: string; body?: ScheduledEventBody };

/** A fake Discord: records every call; `fail` queues errors for the next calls of an op. */
function fakeGuild() {
  const calls: Call[] = [];
  const fail: Partial<Record<Call["op"], DiscordEventsError[]>> = {};
  let n = 0;
  let hang = false;
  const next = (op: Call["op"]) => { const e = fail[op]?.shift(); if (e) throw e; };
  const client: GuildEventsClient = {
    guilds: async () => [{ id: GUILD, name: "Example League Server" }, { id: OTHER_GUILD, name: "Second Server" }],
    channels: async (g) => (g === GUILD ? [{ id: VOICE, name: "League voice", type: "voice" as const }] : []),
    create: async (guildId, body) => {
      if (hang) return new Promise(() => undefined);
      calls.push({ op: "create", guildId, body }); next("create"); n += 1; return { id: `90000000000000000${n}` };
    },
    update: async (guildId, eventId, body) => { calls.push({ op: "update", guildId, eventId, body }); next("update"); return { id: eventId }; },
    remove: async (guildId, eventId) => { calls.push({ op: "remove", guildId, eventId }); next("remove"); },
  };
  return { client, calls, fail, setHang: (v: boolean) => { hang = v; } };
}

const NIGHT = {
  title: "Thursday league night", type: "league-night", start: "2026-10-29T19:00", end: "2026-10-29T22:00",
  location: { kind: "venue", text: "Example Games Club" }, description: "Bring your team.",
};

describe("Discord REST client (stubbed fetch)", () => {
  it("creates, updates and deletes with the bot token; maps errors (403 / 429 / 5xx retryable, 400 permanent, 404 gone); never leaks the token", async () => {
    const seen: Array<{ url: string; method: string; auth: string; body?: string }> = [];
    let answer: { status: number; body?: unknown } = { status: 200, body: { id: "444444444444444444" } };
    const fetchStub = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", auth: (init.headers as Record<string, string>).authorization ?? "", ...(init.body ? { body: String(init.body) } : {}) });
      return new Response(answer.status === 204 ? null : JSON.stringify(answer.body ?? {}), { status: answer.status });
    }) as unknown as typeof fetch;
    const c = createGuildEventsClient({ token: "test-token-value", fetch: fetchStub });
    const body: ScheduledEventBody = { name: "N", description: "D", scheduled_start_time: "2026-10-29T23:00:00.000Z", scheduled_end_time: "2026-10-30T02:00:00.000Z", privacy_level: 2, entity_type: 3, channel_id: null, entity_metadata: { location: "Club" } };
    expect(await c.create(GUILD, body)).toEqual({ id: "444444444444444444" });
    expect(await c.update(GUILD, "444444444444444444", body)).toEqual({ id: "444444444444444444" });
    answer = { status: 204 };
    await c.remove(GUILD, "444444444444444444");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST https://discord.com/api/v10/guilds/${GUILD}/scheduled-events`,
      `PATCH https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/444444444444444444`,
      `DELETE https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/444444444444444444`,
    ]);
    expect(seen.every((s) => s.auth === "Bot test-token-value")).toBe(true);
    expect(JSON.parse(seen[0]!.body!)).toMatchObject({ entity_type: 3, privacy_level: 2, entity_metadata: { location: "Club" } });
    for (const [status, retryable] of [[403, true], [429, true], [503, true], [400, false], [404, false]] as const) {
      answer = { status, body: { message: "no" } };
      const e = await c.create(GUILD, body).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DiscordEventsError);
      expect((e as DiscordEventsError).retryable, String(status)).toBe(retryable);
      expect((e as DiscordEventsError).gone).toBe(status === 404);
      expect(String((e as Error).message)).not.toContain("test-token-value");
    }
    const net = createGuildEventsClient({ token: "t", fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await net.remove(GUILD, "1").catch((x: DiscordEventsError) => [x.status, x.retryable])).toEqual([0, true]);
    // voice / stage channels only
    answer = { status: 200, body: [{ id: VOICE, name: "Voice", type: 2 }, { id: "555555555555555555", name: "text", type: 0 }, { id: "666666666666666666", name: "Stage", type: 13 }] };
    expect(await c.channels(GUILD)).toEqual([{ id: VOICE, name: "Voice", type: "voice" }, { id: "666666666666666666", name: "Stage", type: "stage" }]);
  });

  it("backoff: 30 s, 2 min, 10 min, 30 min, 2 h, then 6 h; the events invite adds Manage Events", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(discordRetryDelayMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]);
    expect(eventsBotInviteUrl("123456789012345678")).toBe("https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=8589954048");
    expect(eventsBotInviteUrl(undefined)).toBeUndefined();
  });
});

describe("League Events -> Discord scheduled events", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let now: Date;
  let fake: ReturnType<typeof fakeGuild>;
  let ev: LeagueEventsDeps;
  let kicks: number;
  const deps = (): LeagueApiDeps => ({
    store, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)), now: () => now,
    notify: () => undefined, postWebhook: async () => ({ ok: true, status: 204 }), leagueEvents: ev,
  });
  const call = async (method: string, path: string, b?: unknown, who = "Jay"): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), { coach: who, admin: false }, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const sync = () => runLeagueEventDiscordSync({ store, guild: fake.client, now: () => now });
  const stored = (id: string) => store.leagueEvents("tabbl").events.find((e) => e.id === id)!;
  const enable = async (extra: Record<string, unknown> = {}) => {
    const r = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-events-discord-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], timeZone: "America/New_York" });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Olga"] });
    fake = fakeGuild();
    kicks = 0;
    ev = { guild: fake.client, clientId: "123456789012345678", kick: () => { kicks += 1; } };
    now = NOW;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("no token (no bot client): the option says to add the bot (with the invite), cannot be turned on, and nothing calls Discord", async () => {
    ev = { clientId: "123456789012345678" };
    const view = await call("GET", "/api/leagues/tabbl/events/discord");
    expect(view.status).toBe(200);
    expect((view.body as { discordEvents: Record<string, unknown> }).discordEvents).toMatchObject({
      available: false, enabled: false, guilds: [], notice: ADD_BOT_TEXT, inviteUrl: expect.stringContaining("permissions=8589954048"),
    });
    const on = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD });
    expect(on.status).toBe(409);
    expect((on.body as { error: string }).error).toBe(`${ADD_BOT_TEXT}.`);
    expect((await call("POST", "/api/leagues/tabbl/events", NIGHT)).status).toBe(201);
    expect(await runLeagueEventDiscordSync({ store, now: () => now })).toEqual({ created: [], updated: [], deleted: [], failed: [] });
    expect(fake.calls).toEqual([]);
  });

  it("the bot must be in the picked server (and the voice channel in it); other organisers cannot change it", async () => {
    const notThere = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: "999999999999999999" });
    expect(notThere.status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true })).status).toBe(400); // no server picked
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD, channelId: "777777777777777777" })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD }, "Olga")).status).toBe(403);
    const ok = await enable({ channelId: VOICE });
    expect((ok.body as { discordEvents: Record<string, unknown> }).discordEvents).toMatchObject({ available: true, enabled: true, guildId: GUILD, channelId: VOICE, botInServer: true });
    // the organiser read model is the only place the server id shows
    const pub = await leagueApi("GET", "/api/leagues/tabbl", new URLSearchParams(), undefined, deps());
    expect(JSON.stringify(pub?.body)).not.toContain(GUILD);
  });

  it("create -> update -> delete: one scheduled event for the next occurrence, its id stored, moved with an edit, removed with a delete", async () => {
    await enable();
    const created = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, title: `Night of ${LISTED}`, description: `A ${LISTED} time.` });
    const id = (created.body as { event: { id: string; discord: { state: string } } }).event.id;
    expect((created.body as { event: { discord: { state: string } } }).event.discord.state).toBe("pending");
    expect(fake.calls).toEqual([]); // the route never calls Discord itself
    let out = await sync();
    expect(out.created).toEqual([`tabbl:${id}`]);
    const c = fake.calls[0]!;
    expect(c).toMatchObject({ op: "create", guildId: GUILD });
    expect(c.body).toMatchObject({ scheduled_start_time: "2026-10-29T23:00:00.000Z", scheduled_end_time: "2026-10-30T02:00:00.000Z", entity_type: 3, entity_metadata: { location: "Example Games Club" }, privacy_level: 2 });
    expect(JSON.stringify(c.body)).not.toContain(LISTED); // starred
    expect(c.body!.name).toBe("Night of ***");
    expect(stored(id).discord).toEqual({ guildId: GUILD, eventId: "900000000000000001", occurrence: "2026-10-29T19:00" });
    expect(stored(id).discordSync).toBeUndefined();
    expect(((await call("GET", "/api/leagues/tabbl/events")).body as { events: Array<{ discord?: { state: string } }> }).events[0]!.discord?.state).toBe("synced");
    // nothing pending: another pass calls nothing
    fake.calls.length = 0;
    expect(await sync()).toEqual({ created: [], updated: [], deleted: [], failed: [] });

    // edit: the same Discord event is updated (moved)
    await call("PATCH", `/api/leagues/tabbl/events/${id}`, { revision: 1, start: "2026-10-29T20:00", end: "2026-10-29T23:00" });
    out = await sync();
    expect(out.updated).toEqual([`tabbl:${id}`]);
    expect(fake.calls[0]).toMatchObject({ op: "update", guildId: GUILD, eventId: "900000000000000001" });
    expect(fake.calls[0]!.body!.scheduled_start_time).toBe("2026-10-30T00:00:00.000Z");
    expect(stored(id).discord?.occurrence).toBe("2026-10-29T20:00");

    // delete: the League Event goes at once; the Discord event is queued and removed
    fake.calls.length = 0;
    expect((await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 2 })).status).toBe(200);
    expect(store.leagueEvents("tabbl").discordDeletes).toEqual([{ guildId: GUILD, eventId: "900000000000000001", attempts: 0, nextAt: NOW.toISOString() }]);
    out = await sync();
    expect(out.deleted).toEqual(["tabbl:900000000000000001"]);
    expect(fake.calls).toEqual([{ op: "remove", guildId: GUILD, eventId: "900000000000000001" }]);
    expect(store.leagueEvents("tabbl").discordDeletes).toBeUndefined();
  });

  it("online events go to the picked voice channel; a weekly event rolls on to the next week once a date has passed", async () => {
    await enable({ channelId: VOICE });
    const r = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, location: { kind: "online", text: "Super FUMBBL" }, recurrence: { everyWeeks: 1, until: "2026-11-12" } });
    const id = (r.body as { event: { id: string } }).event.id;
    await sync();
    expect(fake.calls[0]!.body).toMatchObject({ entity_type: 2, channel_id: VOICE, entity_metadata: null });
    fake.calls.length = 0;
    now = new Date("2026-10-30T03:00:00.000Z"); // the 29 Oct night is over
    const out = await sync();
    expect(out.created).toEqual([`tabbl:${id}`]);
    expect(fake.calls[0]!.body!.scheduled_start_time).toBe("2026-11-06T00:00:00.000Z"); // 5 Nov 19:00 EST
    expect(stored(id).discord?.occurrence).toBe("2026-11-05T19:00");
    // after the last date nothing follows: the reference is dropped, Discord is not called
    fake.calls.length = 0;
    now = new Date("2026-11-14T00:00:00.000Z");
    await sync();
    expect(fake.calls).toEqual([]);
    expect(stored(id).discord).toBeUndefined();
  });

  it("failures retry with backoff and never touch the event; a permanent refusal stops until the next edit; the max attempts end in failed", async () => {
    await enable();
    const r = await call("POST", "/api/leagues/tabbl/events", NIGHT);
    const id = (r.body as { event: { id: string } }).event.id;
    fake.fail.create = [new DiscordEventsError("x", 503, true)];
    let out = await sync();
    expect(out.failed).toEqual([`tabbl:${id}`]);
    expect(stored(id).discordSync).toMatchObject({ attempts: 1, nextAt: new Date(NOW.getTime() + 30_000).toISOString(), error: "Discord is having trouble right now." });
    expect(stored(id).title).toBe("Thursday league night");
    // not due yet: no call
    fake.calls.length = 0;
    now = new Date(NOW.getTime() + 10_000);
    await sync();
    expect(fake.calls).toEqual([]);
    // due: succeeds and clears
    now = new Date(NOW.getTime() + 31_000);
    out = await sync();
    expect(out.created).toEqual([`tabbl:${id}`]);
    expect(stored(id).discordSync).toBeUndefined();

    // a 400 (Discord refuses the event) is permanent: failed at once, shown to the organiser, no more calls
    const r2 = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, title: "Second" });
    const id2 = (r2.body as { event: { id: string } }).event.id;
    fake.fail.create = [new DiscordEventsError("x", 400, false)];
    await sync();
    expect(stored(id2).discordSync).toMatchObject({ failed: true });
    const listed = (await call("GET", "/api/leagues/tabbl/events")).body as { events: Array<{ id: string; discord: { state: string; error?: string } }> };
    expect(listed.events.find((e) => e.id === id2)!.discord).toMatchObject({ state: "failed", error: "Discord did not accept the event (status 400)." });
    fake.calls.length = 0;
    now = new Date(now.getTime() + 86_400_000);
    await sync();
    expect(fake.calls.filter((c) => c.op === "create")).toEqual([]);
    // the next edit resets it
    await call("PATCH", `/api/leagues/tabbl/events/${id2}`, { revision: 1, description: "Fixed" });
    await sync();
    expect(stored(id2).discord?.eventId).toBeDefined();
    expect(stored(id2).discordSync).toBeUndefined();

    // a 403 (no Manage Events) keeps retrying until the last attempt, then failed
    const r3 = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, title: "Third", start: "2026-12-29T19:00", end: "2026-12-29T22:00" });
    const id3 = (r3.body as { event: { id: string } }).event.id;
    fake.fail.create = Array.from({ length: DISCORD_SYNC_MAX_ATTEMPTS }, () => new DiscordEventsError("x", 403, true));
    for (let i = 0; i < DISCORD_SYNC_MAX_ATTEMPTS; i++) {
      await sync();
      now = new Date(now.getTime() + 7 * 3_600_000);
    }
    expect(stored(id3).discordSync).toMatchObject({ attempts: DISCORD_SYNC_MAX_ATTEMPTS, failed: true, error: "The bot can't manage events in that server: give it the Manage Events permission." });
  });

  it("a failed removal is retried with backoff; a 404 counts as gone", async () => {
    await enable();
    const r = await call("POST", "/api/leagues/tabbl/events", NIGHT);
    const id = (r.body as { event: { id: string } }).event.id;
    await sync();
    await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 1 });
    fake.fail.remove = [new DiscordEventsError("x", 502, true)];
    await sync();
    expect(store.leagueEvents("tabbl").discordDeletes).toEqual([{ guildId: GUILD, eventId: "900000000000000001", attempts: 1, nextAt: new Date(NOW.getTime() + 30_000).toISOString() }]);
    now = new Date(NOW.getTime() + 60_000);
    fake.fail.remove = [new DiscordEventsError("x", 404, false)];
    await sync();
    expect(store.leagueEvents("tabbl").discordDeletes).toBeUndefined();
  });

  it("turning it off removes the Discord events; another server moves them; a draft league sends nothing until published", async () => {
    await enable();
    const r = await call("POST", "/api/leagues/tabbl/events", NIGHT);
    const id = (r.body as { event: { id: string } }).event.id;
    await sync();
    fake.calls.length = 0;
    await call("PATCH", "/api/leagues/tabbl/events/discord", { guildId: OTHER_GUILD });
    await sync();
    expect(fake.calls.map((c) => `${c.op}:${c.guildId}`)).toEqual([`remove:${GUILD}`, `create:${OTHER_GUILD}`]);
    expect(stored(id).discord?.guildId).toBe(OTHER_GUILD);
    fake.calls.length = 0;
    await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: false });
    await sync();
    expect(fake.calls.map((c) => c.op)).toEqual(["remove"]);
    expect(stored(id).discord).toBeUndefined();

    // draft: pending stays pending until Publish
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    await enable();
    fake.calls.length = 0;
    await sync();
    expect(fake.calls).toEqual([]);
    expect(((await call("GET", "/api/leagues/tabbl/events")).body as { events: Array<{ discord: { state: string } }> }).events[0]!.discord.state).toBe("draft");
    store.updateLeague("tabbl", (l) => { l.visibility = "published"; });
    await sync();
    expect(fake.calls.map((c) => c.op)).toEqual(["create"]);
  });

  it("never blocks the save: Discord hanging forever, the route still answers at once and the runner keeps one pass at a time", async () => {
    await enable();
    fake.setHang(true);
    const runner = createDiscordSyncRunner({ store, guild: fake.client, now: () => now });
    ev = { ...ev, kick: runner.kick };
    const started = Date.now();
    const r = await call("POST", "/api/leagues/tabbl/events", NIGHT);
    expect(r.status).toBe(201);
    expect(Date.now() - started).toBeLessThan(2000);
    // a second save while the first pass hangs: also answers at once
    const r2 = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, title: "Another" });
    expect(r2.status).toBe(201);
    expect(store.leagueEvents("tabbl").events).toHaveLength(2);
  });

  it("an edit made while Discord was answering is kept, and the event syncs again with the new version", async () => {
    await enable();
    const r = await call("POST", "/api/leagues/tabbl/events", NIGHT);
    const id = (r.body as { event: { id: string } }).event.id;
    // the organiser edits while the create is in flight
    const slow: GuildEventsClient = { ...fake.client, create: async (g, b) => {
      body = { revision: 1, title: "Edited meanwhile" };
      await leagueApi("PATCH", `/api/leagues/tabbl/events/${id}`, new URLSearchParams(), { coach: "Jay", admin: false }, deps());
      return fake.client.create(g, b);
    } };
    await runLeagueEventDiscordSync({ store, guild: slow, now: () => now });
    expect(stored(id).title).toBe("Edited meanwhile");
    expect(stored(id).discord?.eventId).toBe("900000000000000001");
    expect(stored(id).discordSync).toMatchObject({ attempts: 0 }); // syncs again
    fake.calls.length = 0;
    await sync();
    expect(fake.calls[0]).toMatchObject({ op: "update", eventId: "900000000000000001" });
    expect(fake.calls[0]!.body!.name).toBe("Edited meanwhile");
    expect(kicks).toBeGreaterThan(0);
  });
});
