import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import {
  buildFixtureCreatedPost, buildMatchResultPost, buildMatchStartedPost, buildNewsPost, parseFixtureDate, parseNewFixture, recordLeagueFixtureEvent, registerLeagueEvents,
  seasonCoaches,
} from "../src/leagues/events";
import { SettingsError } from "../src/leagues/settings";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";

// League events (src/leagues/events.ts): league news, the organiser fixtures editor, and the Discord posts for every
// event toggle (news, fixture created, match started, match result). No network: the poster is stubbed.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";

const team = (id: string, name: string, coach: string, race: string, coachId?: string): LeagueTeam => ({
  id, name, race, coach, ...(coachId ? { coachId } : {}), teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [],
});

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});

const season = (n: number, fixtures: LeagueFixture[] = []): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures,
  teams: [team("orcs", "Orcs", "Ann", "Orc", "Ann"), team("elves", "Elves", "Bob", "Wood Elf", "Bob"), team("dwarfs", "Dwarfs", "Cat", "Dwarf")],
  participants: [{ coach: "Dee", coachId: "Dee", country: "US", race: "Human", team: "Humans", active: true }],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("embed builders (no network)", () => {
  const lg = { name: "TABBL" };
  const s = { name: "Season 7" };
  it("news, fixture created, match started and match result: titles, bodies, [Test] prefix, mentions off", () => {
    const news = buildNewsPost(lg, s, { title: "Week 3", body: "Fixtures are **out**.", by: "Jay" });
    expect(news.embeds[0]).toMatchObject({ title: "TABBL: Week 3", description: "Fixtures are **out**.", footer: { text: "Season 7 news by Jay" } });
    expect(news.allowed_mentions).toEqual({ parse: [] });
    expect(buildNewsPost(lg, s, { title: "x", body: "y", by: "Jay" }, true).embeds[0]!.title).toBe("[Test] TABBL: x");

    const f = fx("f1", { round: 3, date: "2026-11-05" });
    const created = buildFixtureCreatedPost(lg, s, f).embeds[0]!;
    expect(created.title).toBe("TABBL: new fixture");
    expect(created.description).toBe("Orcs (Ann, Orc) vs Elves (Bob, Wood Elf)\nRound 3 on 2026-11-05");
    expect(buildFixtureCreatedPost(lg, s, { ...f, test: true }).embeds[0]!.title).toBe("[Test] TABBL: new fixture");

    const started = buildMatchStartedPost(lg, s, f, { where: "Super FUMBBL" }).embeds[0]!;
    expect(started.title).toBe("TABBL: kick-off");
    expect(started.description).toBe("Orcs vs Elves has started on Super FUMBBL.\nRound 3");
    expect(buildMatchStartedPost(lg, s, f, { test: true }).embeds[0]!.title).toBe("[Test] TABBL: kick-off");

    const played = { ...f, home: { ...f.home, score: 2, cas: 1 }, away: { ...f.away, score: 1, cas: 3, conceded: true } };
    const result = buildMatchResultPost(lg, s, played).embeds[0]!;
    expect(result.title).toBe("TABBL: result");
    expect(result.description).toBe("Orcs 2 - 1 Elves\nCasualties 1 - 3\nElves conceded.\nRound 3");
    for (const p of [news, buildFixtureCreatedPost(lg, s, f), buildMatchStartedPost(lg, s, f), buildMatchResultPost(lg, s, played)] as DiscordPayload[])
      expect(JSON.stringify(p)).not.toContain("webhooks");
  });

  it("fixture validation: teams, round, phase, date", () => {
    const s7 = season(7);
    expect(parseNewFixture(s7, { home: "orcs", away: "elves", round: 2, date: "2026-11-05" })).toEqual({ home: "orcs", away: "elves", round: 2, phaseId: "season-regular", date: "2026-11-05", test: false });
    expect(() => parseNewFixture(s7, { home: "nope", away: "elves", round: 1 })).toThrow("Pick the home team.");
    expect(() => parseNewFixture(s7, { home: "orcs", away: "orcs", round: 1 })).toThrow("A team cannot play itself.");
    expect(() => parseNewFixture(s7, { home: "orcs", away: "elves", round: 0 })).toThrow(/Round must be/);
    expect(() => parseNewFixture(s7, { home: "orcs", away: "elves", round: 1.5 })).toThrow(/Round must be/);
    expect(() => parseNewFixture(s7, { home: "orcs", away: "elves", round: 1, phaseId: "cup-final" })).toThrow("Unknown phase.");
    expect(() => parseNewFixture(s7, { home: "orcs", away: "elves", round: 1, test: "yes" })).toThrow(SettingsError);
    expect(parseFixtureDate("")).toBeNull();
    expect(() => parseFixtureDate("05/11/2026")).toThrow(/2026-11-05/);
    expect(() => parseFixtureDate("2026-02-30")).toThrow("That date does not exist.");
  });

  it("news recipients: mapped coaches of teams and participants, once, author excluded", () => {
    expect(seasonCoaches(season(7), "ann")).toEqual(["Bob", "Dee"]);
  });
});

describe("league event routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let posts: DiscordPayload[];
  let notes: Array<{ coach: string; title: string; body: string; link: string }>;
  const deps = (): LeagueApiDeps => ({
    store,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body, link: input.link }); },
    postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const JAY = { coach: "Jay" };
  const BOB = { coach: "Bob" };
  const BASE = "/api/leagues/tabbl/seasons/season-7";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-events-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
    store.putSeason(season(7, [fx("f1")]));
    posts = [];
    notes = [];
  });
  afterEach(() => { registerLeagueEvents(undefined); rmSync(dir, { recursive: true, force: true }); });

  it("news: gating, create (notifies mapped coaches, posts to Discord), pinned first, edit, delete; read with the season", async () => {
    expect((await call("POST", `${BASE}/news`, undefined, { title: "a", body: "b" })).status).toBe(401);
    expect((await call("POST", `${BASE}/news`, BOB, { title: "a", body: "b" })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-9/news", JAY, { title: "a", body: "b" })).status).toBe(404);
    expect((await call("POST", `${BASE}/news`, JAY, { title: "", body: "b" })).status).toBe(400);
    expect((await call("GET", `${BASE}/news`, JAY)).status).toBe(405);
    const first = await call("POST", `${BASE}/news`, JAY, { title: "Kick-off", body: "Season 7 starts **Monday**." });
    expect(first.status).toBe(201);
    expect(first.headers?.["cache-control"]).toBe("no-store");
    expect(notes.map((n) => n.coach)).toEqual(["Ann", "Bob", "Dee"]);
    expect(notes[0]).toMatchObject({ title: "TABBL: Kick-off", link: "/app/leagues/tabbl?season=season-7" });
    expect(posts.at(-1)!.embeds[0]!.title).toBe("TABBL: Kick-off");
    const pinned = await call("POST", `${BASE}/news`, JAY, { title: "Rules", body: "Read them.", pinned: true });
    const pid = (pinned.body as { post: { id: string } }).post.id;
    const fid = (first.body as { post: { id: string } }).post.id;
    expect((pinned.body as { news: Array<{ id: string }> }).news.map((n) => n.id)).toEqual([pid, fid]);
    const edited = await call("PATCH", `${BASE}/news/${fid}`, JAY, { body: "Moved to Tuesday." });
    expect(edited.status).toBe(200);
    expect((edited.body as { post: { body: string; editedAt: string } }).post).toMatchObject({ body: "Moved to Tuesday.", editedAt: "2026-11-01T12:00:00.000Z" });
    expect((await call("PATCH", `${BASE}/news/${fid}`, JAY, {})).status).toBe(400);
    expect((await call("PATCH", `${BASE}/news/nope`, JAY, { pinned: true })).status).toBe(404);
    const read = await call("GET", "/api/leagues/tabbl/seasons/season-7", undefined);
    expect((read.body as { season: SeasonRecord }).season.news!.map((n) => n.title).sort()).toEqual(["Kick-off", "Rules"]);
    expect((await call("DELETE", `${BASE}/news/${pid}`, JAY)).status).toBe(200);
    expect(store.season("tabbl", "season-7")!.news!.map((n) => n.id)).toEqual([fid]);
  });

  it("news toggle off: stored and notified, no Discord post", async () => {
    store.updateLeague("tabbl", (l) => { l.discordEvents = { news: false, fixtureCreated: true, matchStarted: false, matchResult: true, milestones: true }; });
    expect((await call("POST", `${BASE}/news`, JAY, { title: "Quiet", body: "No post." })).status).toBe(201);
    expect(posts).toHaveLength(0);
  });

  it("fixtures editor: create (logged, fixtureCreated embed), edit date / result (matchResult once), delete guards", async () => {
    expect((await call("POST", `${BASE}/fixtures`, BOB, { home: "orcs", away: "dwarfs", round: 2 })).status).toBe(403);
    expect((await call("POST", `${BASE}/fixtures`, JAY, { home: "orcs", away: "orcs", round: 2 })).status).toBe(400);
    const made = await call("POST", `${BASE}/fixtures`, JAY, { home: "orcs", away: "dwarfs", round: 2, date: "2026-11-05", test: true });
    expect(made.status).toBe(201);
    const f = (made.body as { fixture: LeagueFixture }).fixture;
    expect(f).toMatchObject({ round: 2, table: 1, date: "2026-11-05", test: true, phaseId: "season-regular", home: { teamId: "orcs", coachId: "Ann", score: null }, away: { teamId: "dwarfs", team: "Dwarfs" } });
    expect(f.away.coachId).toBeUndefined();
    expect(posts.at(-1)!.embeds[0]!.title).toBe("[Test] TABBL: new fixture");
    expect(store.season("tabbl", "season-7")!.log![0]).toMatchObject({ kind: "fixture-created", fixtureId: f.id, by: "Jay" });

    const path = `${BASE}/fixtures/${f.id}`;
    expect((await call("PATCH", path, JAY, { date: "2026-13-01" })).status).toBe(400);
    expect((await call("PATCH", path, JAY, {})).status).toBe(400);
    expect((await call("PATCH", path, BOB, { date: null })).status).toBe(403);
    const moved = await call("PATCH", path, JAY, { date: null, round: 3 });
    expect(moved.status).toBe(200);
    expect((moved.body as { fixture: LeagueFixture }).fixture.date).toBeUndefined();
    const n = posts.length;
    expect((await call("PATCH", path, JAY, { result: { home: 2, away: -1 } })).status).toBe(400);
    const scored = await call("PATCH", path, JAY, { result: { home: 2, away: 1, homeCas: 1, awayCas: 0 } });
    expect(scored.status).toBe(200);
    expect(posts).toHaveLength(n + 1);
    expect(posts.at(-1)!.embeds[0]).toMatchObject({ title: "[Test] TABBL: result", description: "Orcs 2 - 1 Dwarfs\nCasualties 1 - 0\nRound 3" });
    expect(store.season("tabbl", "season-7")!.fixtures.find((x) => x.id === f.id)!.finishedAt).toBe("2026-11-01T12:00:00.000Z");
    await call("PATCH", path, JAY, { result: { home: 2, away: 1, homeCas: 1, awayCas: 0 } });
    expect(posts).toHaveLength(n + 1); // same result: not announced again
    expect((await call("DELETE", path, JAY)).status).toBe(409);
    expect((await call("PATCH", path, JAY, { result: null })).status).toBe(200);
    expect((await call("DELETE", path, JAY)).status).toBe(200);
    expect(store.season("tabbl", "season-7")!.fixtures.map((x) => x.id)).toEqual(["f1"]);
    expect((await call("DELETE", path, JAY)).status).toBe(404);
    // The Super FUMBBL switch still goes through the same PATCH.
    expect((await call("PATCH", `${BASE}/fixtures/f1`, JAY, { forkEnabled: true })).status).toBe(409);
  });

  it("fixture created toggle off: the fixture is created without a post", async () => {
    store.updateLeague("tabbl", (l) => { l.discordEvents = { news: true, fixtureCreated: false, matchStarted: false, matchResult: true, milestones: true }; });
    const made = await call("POST", `${BASE}/fixtures`, JAY, { home: "orcs", away: "elves", round: 1 });
    expect(made.status).toBe(201);
    expect(posts).toHaveLength(0);
  });

  it("recordLeagueFixtureEvent: started once (toggle honoured), result from the stored fixture once per result", async () => {
    const ev = { store, postWebhook: async (_u: string, p: DiscordPayload) => { posts.push(p); return { ok: true, status: 204 }; }, now: () => new Date("2026-11-02T10:00:00.000Z") };
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "started", {}, undefined)).toMatchObject({ ok: false });
    expect(await recordLeagueFixtureEvent("tabbl", "nope", "started", {}, ev)).toMatchObject({ ok: false, reason: "Fixture not found." });
    // matchStarted is off by default: logged and stamped, not posted.
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "started", { where: "Super FUMBBL", by: "Super FUMBBL" }, ev)).toEqual({ ok: true, posted: false });
    expect(store.season("tabbl", "season-7")!.fixtures[0]!.startedAt).toBe("2026-11-02T10:00:00.000Z");
    store.updateLeague("tabbl", (l) => { l.discordEvents = { news: true, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true }; });
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "started", {}, ev)).toMatchObject({ ok: true, posted: false, reason: "Already announced." });
    store.putSeason(season(8, [fx("g1")]));
    registerLeagueEvents(ev);
    expect(await recordLeagueFixtureEvent("tabbl", "g1", "started", { test: true, where: "the tabletop" })).toEqual({ ok: true, posted: true });
    expect(posts.at(-1)!.embeds[0]!.title).toBe("[Test] TABBL: kick-off");
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "result", { seasonId: "season-7" })).toMatchObject({ ok: false, reason: "The fixture has no result yet." });
    const s7 = store.season("tabbl", "season-7")!;
    s7.fixtures[0]!.home.score = 1;
    s7.fixtures[0]!.away.score = 1;
    store.putSeason(s7);
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "result", { seasonId: "season-7" })).toEqual({ ok: true, posted: true });
    expect(posts.at(-1)!.embeds[0]!.description).toBe("Orcs 1 - 1 Elves\nRound 1");
    expect(await recordLeagueFixtureEvent("tabbl", "f1", "result")).toMatchObject({ posted: false, reason: "Already announced." });
    expect(store.season("tabbl", "season-7")!.log!.map((e) => e.kind)).toEqual(["match-result", "match-started"]);
  });
});
