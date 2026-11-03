import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WORDS_ROT13 } from "../src/discord/profanityList";
import {
  computePermissions, createGuildEventsClient, DISCORD_SYNC_MAX_ATTEMPTS, discordRetryDelayMs, DiscordEventsError, permitsChannelEvents, permitsEvents,
  type GuildEventsClient, type ScheduledEventBody,
} from "../src/discord/scheduledEvents";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { LeagueEventsDeps } from "../src/leagues/leagueEvents";
import {
  ADD_BOT_TEXT, createDiscordSyncRunner, DEAD_LETTER_CHECK_MS, eventsBotInviteUrl, GRACE_MS, LINK_DISCORD_TEXT, runLeagueEventDiscordSync, syncMarker,
} from "../src/leagues/leagueEventsDiscord";
import { LeagueStore } from "../src/leagues/store";

// League Events -> Discord Guild Scheduled Events (src/discord/scheduledEvents.ts + src/leagues/leagueEventsDiscord.ts):
// authority over the server (the bot is shared: only servers the organiser's LINKED Discord account manages), create /
// update / delete against a STUBBED Discord, reconcile of a lost create, sync generations, in-progress tracking, the time
// zone drift, dead-lettered cleanups, retries with backoff, the token-missing path, and that a save never waits for Discord.

const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const LISTED = rot13(WORDS_ROT13[1]!);
const GUILD = "111111111111111111";
const OTHER_GUILD = "222222222222222222";
const FOREIGN_GUILD = "555555555555555555"; // another league's server: the bot is there, Jay is not a manager
const VOICE = "333333333333333333";
const STAGE = "444444444444444444";
const JAY_DISCORD = "700000000000000001";
const OLGA_DISCORD = "700000000000000002";
const BOT = "800000000000000000";
const MALLORY = "700000000000000099"; // a member of the league's server, not the bot
const NOW = new Date("2026-10-26T12:00:00.000Z");
const MANAGE = 1n << 33n;

type Call = { op: "create" | "update" | "remove" | "list"; guildId: string; eventId?: string; body?: ScheduledEventBody };

/** A fake Discord: records calls, keeps the events it holds, and answers member permissions from `perms`. */
function fakeGuild() {
  const calls: Call[] = [];
  const fail: Partial<Record<Call["op"], Array<DiscordEventsError | "lost">>> = {};
  const held = new Map<string, { guildId: string; description: string; creatorId: string }>();
  const BOT_PERMS = MANAGE | (1n << 10n) | (1n << 20n);
  /** guild -> discord user -> permission bits (absent = not a member) */
  const perms: Record<string, Record<string, bigint>> = {
    [GUILD]: { [JAY_DISCORD]: MANAGE | (1n << 10n), [BOT]: BOT_PERMS }, [OTHER_GUILD]: { [JAY_DISCORD]: 1n << 3n, [BOT]: BOT_PERMS },
    [FOREIGN_GUILD]: { [JAY_DISCORD]: 0n, [OLGA_DISCORD]: MANAGE, [BOT]: BOT_PERMS },
  };
  /** channel -> user -> EFFECTIVE permission bits (absent = the user's server permissions) */
  const channelPerms: Record<string, Record<string, bigint>> = {};
  let n = 0;
  let hang = false;
  const next = (op: Call["op"]) => { const e = fail[op]?.shift(); return e; };
  const client: GuildEventsClient = {
    guilds: async () => [{ id: GUILD, name: "Example League Server" }, { id: OTHER_GUILD, name: "Second Server" }, { id: FOREIGN_GUILD, name: "Someone Else's League" }],
    channels: async (g) => (g === GUILD ? [{ id: VOICE, name: "League voice", type: "voice" as const }, { id: STAGE, name: "Stage", type: "stage" as const }] : []),
    create: async (guildId, body) => {
      if (hang) return new Promise(() => undefined);
      calls.push({ op: "create", guildId, body });
      const e = next("create");
      if (e && e !== "lost") throw e;
      n += 1;
      const id = `90000000000000000${n}`;
      held.set(id, { guildId, description: body.description, creatorId: BOT });
      if (e === "lost") throw new DiscordEventsError("network", 0, true); // Discord made it, the answer never came back
      return { id };
    },
    update: async (guildId, eventId, body) => {
      calls.push({ op: "update", guildId, eventId, body });
      const e = next("update"); if (e && e !== "lost") throw e;
      const was = held.get(eventId);
      if (!was) throw new DiscordEventsError("gone", 404, false);
      held.set(eventId, { ...was, guildId, description: body.description });
      return { id: eventId };
    },
    remove: async (guildId, eventId) => { calls.push({ op: "remove", guildId, eventId }); const e = next("remove"); if (e && e !== "lost") throw e; held.delete(eventId); },
    listEvents: async (guildId) => { calls.push({ op: "list", guildId }); return [...held].filter(([, v]) => v.guildId === guildId).map(([id, v]) => ({ id, description: v.description, creatorId: v.creatorId })); },
    getEvent: async (_g, eventId) => { const e = held.get(eventId); return e ? { id: eventId, creatorId: e.creatorId } : null; },
    botUserId: async () => BOT,
    memberPermissions: async (guildId, userId) => perms[guildId]?.[userId] ?? null,
    channelPermissions: async (guildId, channelId, userId) => (perms[guildId]?.[userId] === undefined ? null : channelPerms[channelId]?.[userId] ?? perms[guildId]![userId]!),
  };
  return { client, calls, fail, held, perms, channelPerms, setHang: (v: boolean) => { hang = v; } };
}

const NIGHT = {
  title: "Thursday league night", type: "league-night", start: "2026-10-29T19:00", end: "2026-10-29T22:00",
  location: { kind: "venue", text: "Example Games Club" }, description: "Bring your team.",
};

describe("Discord REST client (stubbed fetch)", () => {
  it("creates, updates, deletes and lists with the bot token; maps errors; never leaks the token", async () => {
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
    answer = { status: 200, body: [{ id: "444444444444444444", description: "x [sf:e1:k]" }, { id: "bad" }] };
    expect(await c.listEvents(GUILD)).toEqual([{ id: "444444444444444444", description: "x [sf:e1:k]" }]);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST https://discord.com/api/v10/guilds/${GUILD}/scheduled-events`,
      `PATCH https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/444444444444444444`,
      `DELETE https://discord.com/api/v10/guilds/${GUILD}/scheduled-events/444444444444444444`,
      `GET https://discord.com/api/v10/guilds/${GUILD}/scheduled-events`,
    ]);
    expect(seen.every((s) => s.auth === "Bot test-token-value")).toBe(true);
    for (const [status, retryable] of [[403, true], [429, true], [503, true], [400, false], [404, false]] as const) {
      answer = { status, body: { message: "no" } };
      const e = await c.create(GUILD, body).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(DiscordEventsError);
      expect((e as DiscordEventsError).retryable, String(status)).toBe(retryable);
      expect(String((e as Error).message)).not.toContain("test-token-value");
    }
    answer = { status: 200, body: [{ id: VOICE, name: "Voice", type: 2 }, { id: "555555555555555556", name: "text", type: 0 }, { id: STAGE, name: "Stage", type: 13 }] };
    expect(await c.channels(GUILD)).toEqual([{ id: VOICE, name: "Voice", type: "voice" }, { id: STAGE, name: "Stage", type: "stage" }]);
  });

  it("member permissions: owner = all; else @everyone + the member's roles; not a member = null", async () => {
    const routes: Record<string, { status: number; body: unknown }> = {
      [`/guilds/${GUILD}/members/${JAY_DISCORD}`]: { status: 200, body: { roles: ["r1"] } },
      [`/guilds/${GUILD}`]: { status: 200, body: { owner_id: "799999999999999999" } },
      [`/guilds/${GUILD}/roles`]: { status: 200, body: [{ id: GUILD, permissions: "1024" }, { id: "r1", permissions: String(MANAGE) }, { id: "r2", permissions: "8" }] },
      [`/guilds/${GUILD}/members/${OLGA_DISCORD}`]: { status: 404, body: {} },
    };
    const fetchStub = (async (url: string) => {
      const r = routes[url.replace("https://discord.com/api/v10", "")] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    const c = createGuildEventsClient({ token: "t", fetch: fetchStub });
    const p = await c.memberPermissions(GUILD, JAY_DISCORD);
    expect(p).toBe(1024n | MANAGE); // r2 (Administrator) is not held
    expect(permitsEvents(p!)).toBe(true);
    expect(permitsEvents(1024n)).toBe(false);
    expect(permitsEvents(8n)).toBe(true); // Administrator
    expect(await c.memberPermissions(GUILD, OLGA_DISCORD)).toBeNull();
    routes[`/guilds/${GUILD}`] = { status: 200, body: { owner_id: JAY_DISCORD } };
    routes[`/guilds/${GUILD}/roles`] = { status: 200, body: [] };
    expect(permitsEvents((await c.memberPermissions(GUILD, JAY_DISCORD))!)).toBe(true);
  });

  it("REST: effective channel permissions from the channel's overwrites; creator ids; the bot's own id (cached)", async () => {
    let meCalls = 0;
    const routes: Record<string, unknown> = {
      [`/guilds/${GUILD}/members/${JAY_DISCORD}`]: { roles: ["r1"] },
      [`/guilds/${GUILD}`]: { owner_id: "799999999999999999" },
      [`/guilds/${GUILD}/roles`]: [{ id: GUILD, permissions: "1024" }, { id: "r1", permissions: String(MANAGE) }],
      [`/channels/${VOICE}`]: { guild_id: GUILD, permission_overwrites: [{ id: JAY_DISCORD, type: 1, allow: "0", deny: String(MANAGE) }] },
      [`/channels/${STAGE}`]: { guild_id: OTHER_GUILD, permission_overwrites: [] },
      [`/guilds/${GUILD}/scheduled-events/910000000000000001`]: { id: "910000000000000001", creator_id: MALLORY },
      [`/guilds/${GUILD}/scheduled-events`]: [{ id: "910000000000000001", description: "d", creator_id: MALLORY }],
    };
    const fetchStub = (async (url: string) => {
      const path = url.replace("https://discord.com/api/v10", "");
      if (path === "/users/@me") { meCalls += 1; return new Response(JSON.stringify({ id: BOT }), { status: 200 }); }
      return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const c = createGuildEventsClient({ token: "t", fetch: fetchStub });
    expect(permitsEvents((await c.memberPermissions(GUILD, JAY_DISCORD))!)).toBe(true);
    expect(permitsChannelEvents((await c.channelPermissions(GUILD, VOICE, JAY_DISCORD))!)).toBe(false); // member overwrite denies
    expect(await c.channelPermissions(GUILD, STAGE, JAY_DISCORD)).toBeNull(); // a channel of another server
    expect(await c.getEvent(GUILD, "910000000000000001")).toEqual({ id: "910000000000000001", creatorId: MALLORY });
    expect(await c.getEvent(GUILD, "910000000000000002")).toBeNull();
    expect(await c.listEvents(GUILD)).toEqual([{ id: "910000000000000001", description: "d", creatorId: MALLORY }]);
    expect(await c.botUserId()).toBe(BOT);
    expect(await c.botUserId()).toBe(BOT);
    expect(meCalls).toBe(1);
  });

  it("backoff: 30 s, 2 min, 10 min, 30 min, 2 h, then 6 h; the events invite adds Manage Events", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(discordRetryDelayMs)).toEqual([30_000, 120_000, 600_000, 1_800_000, 7_200_000, 21_600_000, 21_600_000]);
    expect(eventsBotInviteUrl("123456789012345678")).toBe("https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=8589954048");
  });
});

describe("League Events -> Discord scheduled events", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let now: Date;
  let fake: ReturnType<typeof fakeGuild>;
  let ev: LeagueEventsDeps;
  let links: Record<string, string>;
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
  const sync = () => runLeagueEventDiscordSync({ store, guild: fake.client, now: () => now, discordUserId: (c) => links[c.toLowerCase()] });
  const stored = (id: string) => store.leagueEvents("tabbl").events.find((e) => e.id === id)!;
  const view = async (who = "Jay") => ((await call("GET", "/api/leagues/tabbl/events/discord", undefined, who)).body as { discordEvents: Record<string, unknown> }).discordEvents;
  const enable = async (extra: Record<string, unknown> = {}) => {
    const r = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD, ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r;
  };
  const create = async (over: Record<string, unknown> = {}) => {
    const r = await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return (r.body as { event: { id: string } }).event.id;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-events-discord-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], timeZone: "America/New_York" });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Olga"] });
    fake = fakeGuild();
    links = { jay: JAY_DISCORD, olga: OLGA_DISCORD };
    ev = { guild: fake.client, clientId: "123456789012345678", kick: () => undefined, discordUserId: (c) => links[c.toLowerCase()] };
    now = NOW;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("no token (no bot client): the option says to add the bot, cannot be turned on, and nothing calls Discord", async () => {
    ev = { clientId: "123456789012345678", discordUserId: (c) => links[c.toLowerCase()] };
    expect(await view()).toMatchObject({ available: false, enabled: false, guilds: [], notice: ADD_BOT_TEXT, inviteUrl: expect.stringContaining("permissions=8589954048") });
    const on = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD });
    expect(on.status).toBe(409);
    expect((on.body as { error: string }).error).toBe(`${ADD_BOT_TEXT}.`);
    await create();
    expect(await runLeagueEventDiscordSync({ store, now: () => now })).toMatchObject({ created: [], updated: [], deleted: [] });
    expect(fake.calls).toEqual([]);
  });

  it("P1 authority: the list holds only servers the organiser's LINKED account manages; another league's server is refused; unlinked = none", async () => {
    const v = await view();
    expect((v.guilds as Array<{ id: string }>).map((g) => g.id)).toEqual([GUILD, OTHER_GUILD]); // Manage Events, Administrator; never FOREIGN
    expect(JSON.stringify(v)).not.toContain(FOREIGN_GUILD);
    const foreign = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: FOREIGN_GUILD });
    expect(foreign.status).toBe(403);
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: "999999999999999999" })).status).toBe(400); // bot not there
    // unlinked Discord: no list, and no save
    delete links.jay;
    expect(await view()).toMatchObject({ linked: false, guilds: [], notice: LINK_DISCORD_TEXT });
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD })).status).toBe(403);
    links.jay = JAY_DISCORD;
    // a server already bound to another league: shareable only by someone who manages it there too
    store.updateLeague("other", (l) => { l.scheduledEvents = { enabled: true, guildId: FOREIGN_GUILD }; });
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: FOREIGN_GUILD })).status).toBe(403);
    fake.perms[FOREIGN_GUILD]![JAY_DISCORD] = MANAGE;
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: FOREIGN_GUILD })).status).toBe(200);
    // other league's organiser cannot change this league at all
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: false }, "Olga")).status).toBe(403);
    // the public league read never carries a server id
    const pub = await leagueApi("GET", "/api/leagues/tabbl", new URLSearchParams(), undefined, deps());
    expect(JSON.stringify(pub?.body)).not.toContain(FOREIGN_GUILD);
  });

  it("P1 re-check before every sync: lost permission (or unlinked Discord) stops the sync and says why; it resumes when a manager is back", async () => {
    await enable();
    const id = await create();
    await sync();
    expect(stored(id).discord?.eventId).toBeDefined();
    fake.calls.length = 0;
    fake.perms[GUILD]![JAY_DISCORD] = 0n; // Jay lost Manage Events
    await call("PATCH", `/api/leagues/tabbl/events/${id}`, { revision: 1, title: "Moved" });
    let out = await sync();
    expect(out.blocked).toEqual(["tabbl"]);
    expect(fake.calls.filter((c) => c.op !== "list")).toEqual([]); // nothing created, changed or removed
    const v = await view();
    expect(v.blocked).toContain("no organiser of this league can manage events");
    expect((v.guilds as Array<{ id: string }>).map((g) => g.id)).not.toContain(GUILD);
    const listed = (await call("GET", "/api/leagues/tabbl/events")).body as { events: Array<{ discord: { state: string; error?: string } }> };
    expect(listed.events[0]!.discord).toMatchObject({ state: "blocked", error: expect.stringContaining("Discord events stopped") });
    // unlinking reads the same
    fake.perms[GUILD]![JAY_DISCORD] = MANAGE;
    delete links.jay;
    store.updateLeague("tabbl", (l) => { delete l.scheduledEvents!.blocked; });
    out = await sync();
    expect(store.league("tabbl")!.scheduledEvents!.blocked?.reason).toBe("Discord events stopped: no organiser of this league has a linked Discord account.");
    // a manager again: resumes and syncs the edit
    links.jay = JAY_DISCORD;
    out = await sync();
    expect(out.blocked).toEqual([]);
    expect(store.league("tabbl")!.scheduledEvents!.blocked).toBeUndefined();
    expect(fake.calls.find((c) => c.op === "update")?.body?.name).toBe("Moved");
  });

  it("create -> update -> delete; the description carries the sync marker; text starred; stage channels get entity_type 1", async () => {
    await enable();
    const id = await create({ title: `Night of ${LISTED}` });
    expect(fake.calls).toEqual([]); // the route never calls Discord itself
    let out = await sync();
    expect(out.created).toEqual([`tabbl:${id}`]);
    const c = fake.calls.find((x) => x.op === "create")!;
    expect(c.body).toMatchObject({ scheduled_start_time: "2026-10-29T23:00:00.000Z", scheduled_end_time: "2026-10-30T02:00:00.000Z", entity_type: 3, privacy_level: 2 });
    expect(c.body!.description.endsWith(syncMarker(undefined, "tabbl", id, "2026-10-29T19:00"))).toBe(true);
    expect(c.body!.description).not.toContain(id); // the marker gives nothing away
    expect(JSON.stringify(c.body)).not.toContain(LISTED);
    expect(stored(id).discord).toMatchObject({ guildId: GUILD, eventId: "900000000000000001", occurrence: "2026-10-29T19:00", start: "2026-10-29T23:00:00.000Z", end: "2026-10-30T02:00:00.000Z" });
    fake.calls.length = 0;
    expect((await sync()).created).toEqual([]); // nothing pending, no drift
    expect(fake.calls).toEqual([]);
    await call("PATCH", `/api/leagues/tabbl/events/${id}`, { revision: 1, start: "2026-10-29T20:00", end: "2026-10-29T23:00" });
    out = await sync();
    expect(out.updated).toEqual([`tabbl:${id}`]);
    expect(fake.calls.find((x) => x.op === "update")!.body!.scheduled_start_time).toBe("2026-10-30T00:00:00.000Z");
    fake.calls.length = 0;
    await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 2 });
    out = await sync();
    expect(out.deleted).toEqual(["tabbl:900000000000000001"]);
    expect(store.leagueEvents("tabbl").discordDeletes).toBeUndefined();
    // stage vs voice
    await enable({ channelId: STAGE });
    const s = await create({ location: { kind: "online", text: "Stage night" } });
    await enable({ channelId: VOICE });
    await sync();
    const bodies = fake.calls.filter((x) => x.op === "create" || x.op === "update").map((x) => x.body!);
    expect(bodies.at(-1)).toMatchObject({ entity_type: 2, channel_id: VOICE });
    await enable({ channelId: STAGE });
    fake.calls.length = 0;
    await sync();
    expect(fake.calls.find((x) => x.op === "update")!.body).toMatchObject({ entity_type: 1, channel_id: STAGE, entity_metadata: null });
    expect(stored(s).discord?.channelId).toBe(STAGE);
  });

  it("#3 a create whose answer was lost is adopted on the retry (found by its marker), never posted twice", async () => {
    await enable();
    const id = await create();
    fake.fail.create = ["lost"];
    let out = await sync();
    expect(out.failed).toEqual([`tabbl:${id}`]);
    expect(fake.held.size).toBe(1);
    now = new Date(NOW.getTime() + 31_000);
    out = await sync();
    expect(out.adopted).toEqual([`tabbl:${id}`]);
    expect(fake.calls.filter((c) => c.op === "create")).toHaveLength(1);
    expect(fake.held.size).toBe(1);
    expect(stored(id).discord?.eventId).toBe("900000000000000001");
    expect(stored(id).discordSync).toBeUndefined();
  });

  it("#4 #5 generations: an older pass's failure never fails a newer edit, and an older success never clears a newer queued sync", async () => {
    await enable();
    const id = await create();
    // the organiser edits while the create is in flight, and the create then fails
    const failing: GuildEventsClient = { ...fake.client, create: async () => {
      body = { revision: 1, title: "Edited meanwhile" };
      await leagueApi("PATCH", `/api/leagues/tabbl/events/${id}`, new URLSearchParams(), { coach: "Jay", admin: false }, deps());
      throw new DiscordEventsError("x", 400, false);
    } };
    await runLeagueEventDiscordSync({ store, guild: failing, now: () => now, discordUserId: (c) => links[c.toLowerCase()] });
    expect(stored(id).title).toBe("Edited meanwhile");
    expect(stored(id).discordSync).toMatchObject({ attempts: 0 }); // the newer generation stays queued, not failed
    expect(stored(id).discordSync?.failed).toBeUndefined();
    // a channel change while a create succeeds: the success records the Discord id but keeps the newer sync queued
    const slow: GuildEventsClient = { ...fake.client, create: async (g, b) => {
      body = { channelId: VOICE };
      await leagueApi("PATCH", "/api/leagues/tabbl/events/discord", new URLSearchParams(), { coach: "Jay", admin: false }, deps());
      return fake.client.create(g, b);
    } };
    await runLeagueEventDiscordSync({ store, guild: slow, now: () => now, discordUserId: (c) => links[c.toLowerCase()] });
    expect(stored(id).discord?.eventId).toBeDefined();
    expect(stored(id).discordSync).toBeDefined();
    fake.calls.length = 0;
    await sync();
    expect(fake.calls.find((c) => c.op === "update")?.body?.name).toBe("Edited meanwhile");
    expect(stored(id).discordSync).toBeUndefined();
  });

  it("#7 an occurrence under way stays tracked until it ends (+ grace): a delete during it still removes it; a weekly roll keeps it", async () => {
    await enable();
    const id = await create({ recurrence: { everyWeeks: 1, until: "2026-11-12" } });
    await sync();
    fake.calls.length = 0;
    now = new Date("2026-10-30T00:00:00.000Z"); // 29 Oct 20:00 New York: under way
    let out = await sync();
    expect(out.created).toEqual([`tabbl:${id}`]); // the next week gets its own Discord event
    expect(stored(id).discordLive?.map((m) => m.eventId)).toEqual(["900000000000000001"]);
    expect(stored(id).discord?.occurrence).toBe("2026-11-05T19:00");
    // deleted while the night is under way: both go
    fake.calls.length = 0;
    await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 1 });
    out = await sync();
    expect(fake.calls.filter((c) => c.op === "remove").map((c) => c.eventId).sort()).toEqual(["900000000000000001", "900000000000000002"]);
    // and once the grace period after the end is over, an unchanged tracked one is simply forgotten
    const id2 = await create({ title: "Short", start: "2026-10-30T19:00", end: "2026-10-30T20:00" });
    await sync();
    now = new Date(Date.parse("2026-10-31T00:00:00.000Z") + GRACE_MS + 60_000);
    fake.calls.length = 0;
    await sync();
    expect(fake.calls).toEqual([]);
    expect(stored(id2).discord).toBeUndefined();
  });

  it("#7 a move during the occurrence removes the in-progress Discord event", async () => {
    await enable();
    const id = await create({ recurrence: { everyWeeks: 1, until: "2026-11-12" } });
    await sync();
    now = new Date("2026-10-30T00:00:00.000Z");
    await sync();
    fake.calls.length = 0;
    await call("PATCH", `/api/leagues/tabbl/events/${id}`, { revision: 1, start: "2026-10-28T19:00", end: "2026-10-28T22:00" }); // every Wednesday now
    await sync();
    expect(fake.calls.filter((c) => c.op === "remove").map((c) => c.eventId)).toEqual(["900000000000000001"]);
    expect(stored(id).discordLive).toBeUndefined();
  });

  it("#10 a league time zone change moves the Discord event to the new real time (drift on the UTC start / end)", async () => {
    await enable();
    const id = await create();
    await sync();
    fake.calls.length = 0;
    store.updateLeague("tabbl", (l) => { l.timeZone = "Europe/London"; });
    await sync();
    expect(fake.calls.find((c) => c.op === "update")!.body!.scheduled_start_time).toBe("2026-10-29T19:00:00.000Z");
    expect(stored(id).discord?.start).toBe("2026-10-29T19:00:00.000Z");
  });

  it("#6 removals that run out of retries are dead-lettered (kept), shown in Connections, and 'Retry cleanup' queues them again", async () => {
    await enable();
    const id = await create();
    await sync();
    await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 1 });
    fake.fail.remove = Array.from({ length: DISCORD_SYNC_MAX_ATTEMPTS }, () => new DiscordEventsError("x", 503, true));
    for (let i = 0; i < DISCORD_SYNC_MAX_ATTEMPTS; i++) { await sync(); now = new Date(now.getTime() + 7 * 3_600_000); }
    const f = store.leagueEvents("tabbl");
    expect(f.discordDeletes).toBeUndefined();
    expect(f.discordDeadLetters).toMatchObject([{ guildId: GUILD, eventId: "900000000000000001", title: "Thursday league night", error: "Discord is having trouble right now." }]);
    expect((await view()).cleanup).toMatchObject([{ eventId: "900000000000000001", title: "Thursday league night" }]);
    expect((await call("POST", "/api/leagues/tabbl/events/discord/cleanup", {}, "Olga")).status).toBe(403);
    const r = await call("POST", "/api/leagues/tabbl/events/discord/cleanup", {});
    expect(r.body).toMatchObject({ requeued: 1 });
    await sync();
    expect(fake.held.size).toBe(0);
    expect(store.leagueEvents("tabbl").discordDeadLetters).toBeUndefined();
  });

  it("retries with backoff for a 5xx; a 400 is permanent until the next edit", async () => {
    await enable();
    const id = await create();
    fake.fail.create = [new DiscordEventsError("x", 503, true)];
    await sync();
    expect(stored(id).discordSync).toMatchObject({ attempts: 1, nextAt: new Date(NOW.getTime() + 30_000).toISOString(), error: "Discord is having trouble right now." });
    fake.calls.length = 0;
    now = new Date(NOW.getTime() + 10_000);
    await sync();
    expect(fake.calls).toEqual([]);
    now = new Date(NOW.getTime() + 31_000);
    await sync();
    expect(stored(id).discordSync).toBeUndefined();
    const id2 = await create({ title: "Second" });
    fake.fail.create = [new DiscordEventsError("x", 400, false)];
    await sync();
    expect(stored(id2).discordSync).toMatchObject({ failed: true });
    await call("PATCH", `/api/leagues/tabbl/events/${id2}`, { revision: 1, description: "Fixed" });
    await sync();
    expect(stored(id2).discord?.eventId).toBeDefined();
  });

  it("turning it off removes the Discord events; another server moves them; a draft sends nothing until published", async () => {
    await enable();
    const id = await create();
    await sync();
    fake.calls.length = 0;
    await enable({ guildId: OTHER_GUILD });
    await sync();
    expect(fake.calls.filter((c) => c.op !== "list").map((c) => `${c.op}:${c.guildId}`)).toEqual([`remove:${GUILD}`, `create:${OTHER_GUILD}`]);
    fake.calls.length = 0;
    await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: false });
    await sync();
    expect(fake.calls.map((c) => c.op)).toEqual(["remove"]);
    expect(stored(id).discord).toBeUndefined();
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    await enable();
    fake.calls.length = 0;
    await sync();
    expect(fake.calls).toEqual([]);
    store.updateLeague("tabbl", (l) => { l.visibility = "published"; });
    await sync();
    expect(fake.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("P1 spoofed marker: an event a member made with a copied marker is never adopted, changed or deleted (Retry cleanup included)", async () => {
    await enable();
    const id = await create();
    // Mallory pre-creates an event carrying exactly our marker
    const marker = syncMarker(undefined, "tabbl", id, "2026-10-29T19:00");
    fake.held.set("910000000000000001", { guildId: GUILD, description: `party ${marker}`, creatorId: MALLORY });
    const out = await sync();
    expect(out.adopted).toEqual([]);
    expect(out.created).toEqual([`tabbl:${id}`]);
    expect(fake.calls.some((c) => c.eventId === "910000000000000001")).toBe(false);
    // a removal (queued or dead-lettered) that points at someone else's event is dropped, never sent
    store.putLeagueEvents("tabbl", { ...store.leagueEvents("tabbl"), discordDeadLetters: [{ guildId: GUILD, eventId: "910000000000000001", at: NOW.toISOString(), error: "x" }] });
    await call("POST", "/api/leagues/tabbl/events/discord/cleanup", {});
    const r = await sync();
    expect(r.skipped).toEqual(["tabbl:910000000000000001"]);
    expect(fake.held.has("910000000000000001")).toBe(true);
    expect(fake.calls.filter((c) => c.op === "remove")).toEqual([]);
    // signed: another key gives another marker; the same inputs the same one
    expect(syncMarker("key-a", "tabbl", id, "k")).not.toBe(syncMarker("key-b", "tabbl", id, "k"));
    expect(syncMarker("key-a", "tabbl", id, "k")).toBe(syncMarker("key-a", "tabbl", id, "k"));
  });

  it("#2 effective channel permissions: Discord's algorithm (everyone / roles / member overwrites; Administrator wins)", () => {
    const G = "100000000000000000";
    const roles = [{ id: G, permissions: 1024n }, { id: "r1", permissions: MANAGE }, { id: "admin", permissions: 8n }];
    const ow = (id: string, type: 0 | 1, allow: bigint, deny: bigint) => ({ id, type, allow, deny });
    expect(computePermissions({ guildId: G, userId: "u", roles, memberRoles: ["r1"] })).toBe(1024n | MANAGE);
    // @everyone denies View; the role gives it back; the member's own overwrite takes Manage Events away
    const p = computePermissions({ guildId: G, userId: "u", roles, memberRoles: ["r1"], overwrites: [ow(G, 0, 0n, 1024n), ow("r1", 0, 1024n, 0n), ow("u", 1, 0n, MANAGE)] });
    expect(p & 1024n).toBe(1024n);
    expect(permitsChannelEvents(p)).toBe(false);
    // Administrator in the base ignores overwrites; so does the owner
    expect(permitsChannelEvents(computePermissions({ guildId: G, userId: "u", roles, memberRoles: ["admin"], overwrites: [ow("u", 1, 0n, MANAGE | 1024n)] }))).toBe(true);
    expect(permitsChannelEvents(computePermissions({ guildId: G, userId: "u", ownerId: "u", roles: [], memberRoles: [], overwrites: [ow(G, 0, 0n, 1024n)] }))).toBe(true);
  });

  it("#2 a channel overwrite denying the organiser refuses the save and stops the background sync; the bot needs Connect there too", async () => {
    fake.channelPerms[VOICE] = { [JAY_DISCORD]: 1024n }; // can see the channel, Manage Events denied there
    const denied = await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD, channelId: VOICE });
    expect(denied.status).toBe(403);
    expect((denied.body as { error: string }).error).toBe("Your Discord account can't manage events in that channel.");
    delete fake.channelPerms[VOICE];
    fake.channelPerms[VOICE] = { [BOT]: MANAGE | (1n << 10n) }; // the bot cannot Connect
    expect((await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: true, guildId: GUILD, channelId: VOICE })).status).toBe(400);
    delete fake.channelPerms[VOICE];
    await enable({ channelId: VOICE });
    await create({ location: { kind: "online", text: "Voice night" } });
    await sync();
    fake.calls.length = 0;
    fake.channelPerms[VOICE] = { [JAY_DISCORD]: 1024n }; // an overwrite added later
    const out = await sync();
    expect(out.blocked).toEqual(["tabbl"]);
    expect(store.league("tabbl")!.scheduledEvents!.blocked?.reason).toContain("picked voice channel");
    delete fake.channelPerms[VOICE];
    fake.channelPerms[VOICE] = { [BOT]: MANAGE | (1n << 10n) };
    await sync();
    expect(store.league("tabbl")!.scheduledEvents!.blocked?.reason).toContain("the Super FUMBBL bot can't manage events in the picked channel");
  });

  it("#3 a one-off event (and a series' last date) is NOT deleted when it starts: tracked until it ends plus the grace period", async () => {
    await enable();
    const id = await create(); // one-off, 29 Oct 19:00-22:00 New York
    await sync();
    fake.calls.length = 0;
    now = new Date("2026-10-29T23:30:00.000Z"); // under way
    await sync();
    expect(fake.calls.filter((c) => c.op === "remove")).toEqual([]);
    expect(stored(id).discordLive?.map((m) => m.eventId)).toEqual(["900000000000000001"]);
    now = new Date(Date.parse("2026-10-30T02:00:00.000Z") + GRACE_MS + 60_000);
    await sync();
    expect(fake.calls.filter((c) => c.op === "remove")).toEqual([]);
    expect(stored(id).discordLive).toBeUndefined();
    expect(fake.held.has("900000000000000001")).toBe(true); // Discord keeps its own finished event
  });

  it("P3 dead letters are re-checked hourly even with Discord events turned off, and requeued once the bot can manage events again", async () => {
    await enable();
    const id = await create();
    await sync();
    await call("PATCH", "/api/leagues/tabbl/events/discord", { enabled: false });
    await call("DELETE", `/api/leagues/tabbl/events/${id}`, { revision: 1 });
    const f = store.leagueEvents("tabbl");
    store.putLeagueEvents("tabbl", { events: f.events, discordDeadLetters: [{ guildId: GUILD, eventId: "900000000000000001", title: "Thursday league night", at: NOW.toISOString(), error: "x" }] });
    fake.perms[GUILD]![BOT] = 0n; // the bot lost Manage Events
    await sync();
    expect(store.leagueEvents("tabbl").discordDeadLetters?.[0]?.checkedAt).toBe(NOW.toISOString());
    fake.perms[GUILD]![BOT] = MANAGE | (1n << 10n) | (1n << 20n);
    await sync(); // within the hour: not checked again
    expect(store.leagueEvents("tabbl").discordDeadLetters).toHaveLength(1);
    now = new Date(NOW.getTime() + DEAD_LETTER_CHECK_MS + 1);
    await sync(); // requeued ...
    await sync(); // ... and removed
    expect(store.leagueEvents("tabbl").discordDeadLetters).toBeUndefined();
    expect(fake.held.has("900000000000000001")).toBe(false);
  });

  it("never blocks the save: Discord hanging forever, the route still answers at once", async () => {
    await enable();
    fake.setHang(true);
    const runner = createDiscordSyncRunner({ store, guild: fake.client, now: () => now, discordUserId: (c) => links[c.toLowerCase()] });
    ev = { ...ev, kick: runner.kick };
    const started = Date.now();
    expect((await call("POST", "/api/leagues/tabbl/events", NIGHT)).status).toBe(201);
    expect((await call("POST", "/api/leagues/tabbl/events", { ...NIGHT, title: "Another" })).status).toBe(201);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(store.leagueEvents("tabbl").events).toHaveLength(2);
  });
});
