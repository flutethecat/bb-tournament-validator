import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CoachRatingInput } from "../src/ratings/glicko";
import { WORDS_ROT13 } from "../src/discord/profanityList";
import { ASK_LIMIT, LobbyNoticeGate, NOTICE_GAP_MS, winRateOf } from "../src/fixtureLobby/api";
import { SenderRateLimiter } from "../src/notifications";
import { budgetFor, lobbyConfirmRules, newLobby } from "../src/fixtureLobby/core";
import { headToHead, ratingsOf, teamMeetings, type Meeting } from "../src/fixtureLobby/league";
import { LobbyPresence } from "../src/fixtureLobby/presence";
import { FixtureLobbyStore } from "../src/fixtureLobby/store";
import type { LobbyFixture, LobbyFixtureSide, LobbyTeam } from "../src/fixtureLobby/types";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { effectiveInducements, seasonInducementOffers } from "../src/leagues/inducements";
import { LeagueStore } from "../src/leagues/store";
import { leagueFixtureView } from "../src/leagues/tabletopFixtures";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { actionDmText } from "../src/mail/actionMessages";
import type { NotificationInput } from "../src/notifications";
import { appendFixtureMessage, createSocialLimiters, fixtureMessageAllowed } from "../src/social/api";
import { SocialStore } from "../src/social/store";
import { createMatch, tabletopApi, type TabletopApiDeps } from "../src/tabletop/api";
import { inducementMenu } from "../src/tabletop/pregame";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";
import { RATING_LABEL, coachCardLines, meetingLine, recordLine, scheduleLine } from "../spa/src/leagues/fixtureSummary";
import { profanitySetting, shown } from "../spa/src/shared/profanity";

// Fixture summary (league UX pass 11-02, lane UX-B): the match page before kick-off. The summary fields from the server
// (team value, record, position, form, agreed time), the coach cards' Rating (the site Glicko-2), head-to-head maths
// (coaches and teams, the last meeting), the inducement budget against the recorder's own maths, pick privacy and
// own-coach writes, the pre-fill into the recorder's picker, the coaches' messages (two coaches; organisers only after
// "Ask an organiser"; others 403; anonymous 401), the inbox copy and notes / DMs (stubbed), the profanity viewer option,
// and read-only GETs. Fake data only.

const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
const LISTED = rot13(WORDS_ROT13[1]!);

const players = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
  playerId: `p-${prefix}${i}`, number: i + 1, name: `${prefix} ${i + 1}`, position: "Lineman", ma: 5, st: 3, ag: 3, pa: 4, av: 9, skills: [],
  value: 50_000, level: "", availableSpp: 0, niggling: 0, missNextGame: false,
  stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 },
}));
const leagueTeam = (id: string, name: string, race: string, coachId: string, tv: number, treasury: number): LeagueTeam => ({
  id, name, race, coach: coachId, coachId, teamValue: tv, currentTeamValue: tv, treasury, rerolls: 2, fans: 3, assistantCoaches: 0, cheerleaders: 0,
  apothecary: true, tier: "", raceLeague: "", players: players(12, name.slice(0, 1)), formerPlayers: [],
});
const ORCS = leagueTeam("orcs", "Green Tide", "Orc", "Ann", 1_000_000, 100_000);
const HUMANS = leagueTeam("humans", "Grudge Rollers", "Human", "Bob", 1_100_000, 150_000);
const side = (t: LeagueTeam, score: number | null = null, cas: number | null = null, coach = t.coachId!) =>
  ({ team: t.name, teamId: t.id, coach, coachId: coach, race: t.race, score, cas, conceded: false });
const fx = (id: string, round: number, hs: number | null = null, as: number | null = null, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: side(ORCS, hs, hs === null ? null : 1), away: side(HUMANS, as, as === null ? null : 0), suspended: false, ...over,
});
const season = (id: string, number: number, fixtures: LeagueFixture[], status: SeasonRecord["status"] = "active"): SeasonRecord => ({
  id, leagueId: "alpha", number, name: `Season ${number}`, sourceSlug: id, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams: [ORCS, HUMANS], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-09-01T00:00:00.000Z", source: "manual",
});

const L = "/api/leagues/alpha/seasons/season-2/fixtures/f1/lobby";
const AGREED = { start: "2026-11-05T19:00:00.000Z", end: "2026-11-05T21:00:00.000Z", agreedAt: "2026-11-02T10:00:00.000Z" };

describe("fixture summary routes (league)", () => {
  let dir = "";
  let store: LeagueStore;
  let lobbyStore: FixtureLobbyStore;
  let notes: Array<{ to: string; input: NotificationInput }>;
  let mirrored: Array<{ from: string; to: string; text: string; context: { title: string; link: string } }>;
  let mirrorAnswer: { burst: boolean } | "blocked" | undefined;
  let gate: LobbyNoticeGate;
  let allowed = true;
  let asks: SenderRateLimiter;
  let clock = 0;
  const ratings = new Map<string, CoachRatingInput>([
    ["ann", { rating: 1561.4, rd: 87.4, games: 12, provisional: false }],
    ["bob", { rating: 1488.2, games: 4, provisional: true }],
    ["cat", { rating: 1600, games: 30, provisional: false }],
    ["dee", { rating: 1500, games: 0, provisional: true }],
  ]);
  const deps = (body?: unknown): LeagueApiDeps => ({
    store,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date(Date.parse("2026-11-02T12:00:00.000Z") + clock++ * 1000),
    notify: (to, input) => { notes.push({ to, input }); },
    lobby: {
      store: lobbyStore, presence: new LobbyPresence(), ratings: () => ratings, notices: gate, messageAllowed: () => allowed, askLimiter: asks,
      now: () => new Date(Date.parse("2026-11-02T12:00:00.000Z") + clock * 1000),
      mirror: (from, to, text, context) => { mirrored.push({ from, to, text, context }); return mirrorAnswer; },
      recorderTeams: (coach) => [{ ref: `library:${coach.toLowerCase()}-team`, name: coach === "Ann" ? "Green Tide" : "Grudge Rollers", race: coach === "Ann" ? "Orc" : "Human" }],
    },
  });
  const call = async (coach: string | undefined, method: string, path: string, body?: unknown): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(), coach ? { coach, admin: false } : undefined, deps(body));
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = async (coach?: string): Promise<any> => (await call(coach, "GET", L)).body;
  const post = async (coach: string | undefined, action: string, body: unknown) => call(coach, "POST", `${L}/${action}`, body);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-summary-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    // season 1: the teams met with another Humans coach (Cat), and Ann beat Bob 2-1
    store.putSeason(season("season-1", 1, [
      fx("s1a", 1, 3, 0, { finishedAt: "2026-09-10T20:00:00.000Z", away: side(HUMANS, 0, 0, "Cat") }),
    ], "completed"));
    // season 2 (active): Ann 2-1 Bob (round 0), Ann 1-1 Bob (round 1b), and the open fixture f1 with an agreed time
    store.putSeason(season("season-2", 2, [
      fx("f0", 0, 2, 1, { finishedAt: "2026-10-10T20:00:00.000Z" }),
      fx("f0b", 0, 1, 1, { finishedAt: "2026-10-20T20:00:00.000Z", resultEdit: { by: "Org", at: "2026-10-21T09:00:00.000Z" }, forkNotice: { at: "2026-10-21T09:00:00.000Z", to: ["Ann"] } }),
      fx("f1", 1, null, null, { scheduledTime: AGREED }),
    ]));
    lobbyStore = new FixtureLobbyStore(dir);
    notes = [];
    mirrored = [];
    mirrorAnswer = { burst: true };
    gate = new LobbyNoticeGate();
    asks = new SenderRateLimiter(ASK_LIMIT, 600_000);
    allowed = true;
    clock = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("summary fields come from server data: team value, record, position, latest form, agreed time, Rating, win rate", async () => {
    const v = await view();
    expect(v.sides.home.team).toMatchObject({ name: "Green Tide", race: "Orc", tv: 1_000_000, treasury: 100_000 });
    expect(v.sides.away.team).toMatchObject({ name: "Grudge Rollers", tv: 1_100_000 });
    // the standings row of this phase: W-D-L, position and form
    expect(v.sides.home.standing).toMatchObject({ rank: 1, played: 2, wins: 1, draws: 1, losses: 0, latest: ["W", "D"] });
    expect(v.sides.away.standing).toMatchObject({ rank: 2, played: 2, wins: 0, draws: 1, losses: 1, latest: ["L", "D"] });
    expect(v.header.scheduled).toEqual(AGREED);
    // Rating = the site Glicko-2 (with its RD when the server has one), rank among rated coaches (a coach without a rated game is not ranked)
    expect(v.sides.home.rating).toEqual({ value: 1561, rd: 87, games: 12, provisional: false, rank: 2, of: 3 });
    expect(v.sides.away.rating).toEqual({ value: 1488, games: 4, provisional: true, rank: 3, of: 3 });
    // all-time: Ann W W D (season 1 vs Cat, then Bob twice) -> (2 + 0.5) / 3
    expect(v.sides.home.winRate).toBeCloseTo(0.833, 3);
    expect(v.sides.home.stats.allTime).toMatchObject({ played: 3, wins: 2, draws: 1, losses: 0 });
    // the inducement cash summary per side (worked out on the server)
    expect(v.sides.home.inducements.budget).toEqual({ role: "underdog", pettyCash: 100_000, treasury: 100_000, topUpLimit: 50_000, limit: 150_000 });
    expect(v.sides.away.inducements.budget).toEqual({ role: "overdog", pettyCash: 0, treasury: 150_000, topUpLimit: 150_000, limit: 150_000 });
    expect(v.links.lobby).toBe("/leagues/alpha/seasons/season-2/fixtures/f1/lobby");
    // the coach cards never carry contact data, and no private fixture bookkeeping reaches any viewer
    expect(JSON.stringify(v)).not.toMatch(/@|discord|email|phone/i);
    for (const who of [undefined, "Ann", "Org"]) expect(JSON.stringify(await view(who))).not.toMatch(/resultEdit|forkNotice/);
  });

  it("head-to-head: the coaches' record and last meeting; the teams' record when it differs (another coach met these teams)", async () => {
    const v = await view();
    expect(v.headToHead).toMatchObject({ wins: { home: 1, away: 0 }, draws: 1, td: { home: 3, away: 2 } });
    expect(v.lastMeeting).toMatchObject({ at: "2026-10-20T20:00:00.000Z", home: { score: 1 }, away: { score: 1 }, event: "Alpha League · Season 2 · Round 0" });
    expect(v.lastMeeting.to).toBe("/leagues/alpha?season=season-2&tab=fixtures&fixture=f0b");
    // the teams met three times (once with Cat coaching the Humans): Green Tide 2 wins, 1 draw, TD 6-2
    expect(v.teamHeadToHead).toMatchObject({ wins: { home: 2, away: 0 }, draws: 1, td: { home: 6, away: 2 } });
    expect(v.teamHeadToHead.meetings).toHaveLength(3);
  });

  it("pick privacy: the opponent cannot read unrevealed picks, only the team's own coach (or an organiser) sets them", async () => {
    expect((await post("Bob", "inducements", { side: "away", picks: [{ id: "bribes", qty: 1 }] })).status).toBe(200);
    expect((await view("Bob")).sides.away.inducements.picks).toHaveLength(1);
    expect((await view("Ann")).sides.away.inducements).toMatchObject({ visible: false, picks: null, total: null });
    expect((await view()).sides.away.inducements.picks).toBeNull();
    expect((await view("Eve")).sides.away.inducements.picks).toBeNull();
    expect((await view("Org")).sides.away.inducements.picks).toHaveLength(1);
    // writes: the opponent 403, a stranger 403, anonymous 401, the organiser any side
    expect((await post("Ann", "inducements", { side: "away", picks: [] })).status).toBe(403);
    expect((await post("Eve", "inducements", { side: "away", picks: [] })).status).toBe(403);
    expect((await post(undefined, "inducements", { side: "away", picks: [] })).status).toBe(401);
    expect((await post("Org", "inducements", { side: "away", picks: [{ id: "bribes", qty: 1 }] })).status).toBe(200);
    // both confirm (the overdog locks; the underdog arms Auto-Buy and locks): both see both
    expect((await post("Bob", "inducements", { side: "away", lock: true })).status).toBe(200);
    expect((await view("Ann")).sides.away.inducements.picks).toBeNull();
    expect((await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 1 }], autoBuy: true, lock: true })).status).toBe(200);
    const after = await view("Ann");
    expect(after.sides.away.inducements).toMatchObject({ visible: true, total: 100_000 });
    expect((await view("Bob")).sides.home.inducements.picks).toHaveLength(1);
  });

  it("messages: the two coaches; organisers only after Ask an organiser; others 403; anonymous 401", async () => {
    expect((await post("Ann", "chat", { text: "Thursday at 8?" })).status).toBe(200);
    expect((await post("Bob", "chat", { text: "Works for me" })).status).toBe(200);
    expect((await view("Ann")).chat.map((m: { text: string }) => m.text)).toEqual(["Thursday at 8?", "Works for me"]);
    expect((await view("Bob")).viewer.canChat).toBe(true);
    // organisers: no read, no write, no ask before a coach asks
    const org = await view("Org");
    expect(org.chat).toBeNull();
    expect(org.viewer.canChat).toBe(false);
    expect((await post("Org", "chat", { text: "hello" })).status).toBe(403);
    expect((await post("Org", "ask", {})).status).toBe(403);
    // strangers and visitors
    expect((await view("Eve")).chat).toBeNull();
    expect((await view()).chat).toBeNull();
    expect((await post("Eve", "chat", { text: "hi" })).status).toBe(403);
    expect((await post("Eve", "ask", {})).status).toBe(403);
    expect((await post(undefined, "chat", { text: "hi" })).status).toBe(401);
    expect((await post(undefined, "ask", {})).status).toBe(401);
    // "Ask an organiser" is throttled per coach across fixtures (each ask notes and DMs every organiser)
    for (let i = 0; i < ASK_LIMIT; i += 1) expect(asks.take("Ann", Date.parse("2026-11-02T12:00:00.000Z"))).toBe(true);
    const throttled = await post("Ann", "ask", {});
    expect(throttled.status).toBe(429);
    expect(notes.filter((n) => n.to === "Org")).toHaveLength(0);
    expect((await view("Org")).chat).toBeNull();
    asks = new SenderRateLimiter(ASK_LIMIT, 600_000);
    // a coach asks: the organisers are noted (actionable), and can read and write from then on
    expect((await view("Ann")).messages).toMatchObject({ asked: false, canAsk: true });
    expect((await post("Ann", "ask", {})).status).toBe(200);
    expect(notes.filter((n) => n.to === "Org").map((n) => n.input)).toEqual([expect.objectContaining({
      type: "fixture-message", action: true, from: "Ann", link: "/app/leagues/alpha/seasons/season-2/fixtures/f1/lobby",
    })]);
    expect((await post("Bob", "ask", {})).status).toBe(200); // once: no second note
    expect(notes.filter((n) => n.to === "Org")).toHaveLength(1);
    const asked = await view("Org");
    expect(asked.messages).toMatchObject({ asked: true, canAsk: false });
    expect(asked.chat.map((m: { text: string }) => m.text)).toEqual(["Thursday at 8?", "Works for me", "Ann asked an organiser to join the messages."]);
    expect((await post("Org", "chat", { text: "Thursday is fine." })).status).toBe(200);
    expect((await view("Eve")).chat).toBeNull();
  });

  it("a new message notes the other coach (inbox + DM queue) once per burst, copied to Messages; blocks stop both", async () => {
    expect((await post("Ann", "chat", { text: "Hi Bob" })).status).toBe(200);
    expect(mirrored).toEqual([{ from: "Ann", to: "Bob", text: "Hi Bob", context: { title: "Green Tide v Grudge Rollers · Alpha League", link: "/app/leagues/alpha/seasons/season-2/fixtures/f1/lobby" } }]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ to: "Bob", input: { type: "fixture-message", action: true, from: "Ann", body: "Hi Bob", subject: "Green Tide v Grudge Rollers · Alpha League" } });
    // the same burst (Bob has not read it yet): copied, no second note
    mirrorAnswer = { burst: false };
    expect((await post("Ann", "chat", { text: "Still there?" })).status).toBe(200);
    expect(mirrored).toHaveLength(2);
    expect(notes).toHaveLength(1);
    // either coach blocked the other: no note (the fixture thread itself still works)
    mirrorAnswer = "blocked";
    expect((await post("Bob", "chat", { text: "Yes" })).status).toBe(200);
    expect(notes).toHaveLength(1);
    // no Messages copy available: a time-gated note instead (one per fixture and recipient per gap)
    mirrorAnswer = undefined;
    expect((await post("Bob", "chat", { text: "See you" })).status).toBe(200);
    expect((await post("Bob", "chat", { text: "Bye" })).status).toBe(200);
    expect(notes.filter((n) => n.to === "Ann")).toHaveLength(1);
    // the shared Messages limit (across fixtures) refuses with 429 before anything is written
    allowed = false;
    expect((await post("Ann", "chat", { text: "over the limit" })).status).toBe(429);
    allowed = true;
    // a refused message writes nothing and notes nobody
    expect((await post("Ann", "chat", { text: "x".repeat(501) })).status).toBe(400);
    expect(notes).toHaveLength(2);
  });

  it("the DM text names the writer and the fixture (starred), never the message; the inbox copy lands in both indexes", () => {
    const dm = actionDmText({
      record: { type: "fixture-message", from: "Ann", title: `New message from Ann about ${LISTED} XI v Elves`, link: "/app/leagues/a/seasons/s/fixtures/f/lobby" },
      subject: `${LISTED} XI v Elves`, action: true, url: "https://site.example.test/app/leagues/a/seasons/s/fixtures/f/lobby",
    })!;
    expect(dm.text).toContain("Read and reply: https://site.example.test/app/leagues/a/seasons/s/fixtures/f/lobby");
    expect(dm.text).not.toContain(LISTED);
    expect(dm.plain).not.toContain(LISTED);
    const sdir = mkdtempSync(join(tmpdir(), "fixture-summary-social-"));
    try {
      const social = new SocialStore(sdir);
      const known = new Map([["ann", "Ann"], ["bob", "Bob"]]);
      const sdeps = { store: social, coach: (n: string) => known.get(n.trim().toLowerCase()), isFenced: () => false, limiters: createSocialLimiters(), now: () => 1_000 };
      const ctx = { title: "Green Tide v Grudge Rollers · Alpha League", link: "/app/leagues/alpha/seasons/season-2/fixtures/f1/lobby" };
      expect(appendFixtureMessage(sdeps, "ann", "Bob", "Hi Bob", ctx)).toEqual({ burst: true });
      expect(appendFixtureMessage(sdeps, "Ann", "Bob", "Again", ctx)).toEqual({ burst: false });
      expect(social.index("Bob").threads[0]).toMatchObject({ with: "Ann", unread: 2, preview: "Again" });
      expect(social.index("Ann").threads[0]).toMatchObject({ with: "Bob", unread: 0 });
      expect(social.findThread("Ann", "Bob")!.messages[0]).toMatchObject({ text: "Hi Bob", fixture: ctx });
      // a context link off the site is dropped; a block either way stops the copy
      appendFixtureMessage(sdeps, "Ann", "Bob", "x", { title: "t", link: "https://elsewhere.example.test/" });
      expect(social.findThread("Ann", "Bob")!.messages.at(-1)!.fixture).toBeUndefined();
      social.block("Bob", "Ann");
      expect(appendFixtureMessage(sdeps, "Ann", "Bob", "blocked?", ctx)).toBe("blocked");
      expect(appendFixtureMessage(sdeps, "Ann", "Nobody", "?", ctx)).toBeUndefined();
      // the shared limits: 30 messages a minute across fixtures; a new conversation counts against 20 an hour
      const lim = { limiters: createSocialLimiters(), now: () => 5_000 };
      for (let i = 0; i < 30; i += 1) expect(fixtureMessageAllowed(lim, "Ann")).toBe(true);
      expect(fixtureMessageAllowed(lim, "ann")).toBe(false);
      const many = new Map([["ann", "Ann"], ...Array.from({ length: 21 }, (_, i) => [`c${i}`, `C${i}`] as [string, string])]);
      const tdeps = { ...sdeps, coach: (n: string) => many.get(n.trim().toLowerCase()), limiters: createSocialLimiters() };
      for (let i = 0; i < 20; i += 1) expect(appendFixtureMessage(tdeps, "Ann", `C${i}`, "hi", ctx)).toEqual({ burst: true });
      expect(appendFixtureMessage(tdeps, "Ann", "C20", "hi", ctx)).toBeUndefined();
      expect(appendFixtureMessage(tdeps, "Ann", "C0", "again", ctx)).toEqual({ burst: false }); // an existing thread still copies
    } finally {
      rmSync(sdir, { recursive: true, force: true });
    }
  });

  it("messages are stored as written; the viewer's profanity option stars them on screen", async () => {
    expect((await post("Ann", "chat", { text: `what a ${LISTED} dice roll` })).status).toBe(200);
    const line = (await view("Bob")).chat[0].text as string;
    expect(line).toBe(`what a ${LISTED} dice roll`);
    expect(lobbyStore.get("league:alpha:season-2:f1")!.chat[0]!.text).toBe(`what a ${LISTED} dice roll`);
    const was = profanitySetting.on;
    try {
      profanitySetting.on = true;
      expect(shown(line)).toBe("what a *** dice roll");
      profanitySetting.on = false;
      expect(shown(line)).toBe(line);
    } finally {
      profanitySetting.on = was;
    }
  });

  it("GETs never change state: no lobby file, no presence, no notes, the same revision", async () => {
    await view("Ann");
    await view("Org");
    await view();
    expect(existsSync(join(dir, "fixture-lobbies"))).toBe(false);
    expect(notes).toHaveLength(0);
    expect((await post("Ann", "chat", { text: "hi" })).status).toBe(200);
    const file = join(lobbyStore.dir, readdirSync(lobbyStore.dir)[0]!);
    const before = { text: readFileSync(file, "utf8"), mtime: statSync(file).mtimeMs };
    for (const c of ["Ann", "Bob", "Org", "Eve", undefined]) await view(c);
    expect(readFileSync(file, "utf8")).toBe(before.text);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(notes).toHaveLength(1);
    expect((await view("Ann")).sides.home.online).toBe(false);
  });
});

describe("fixture summary maths (pure)", () => {
  const meeting = (at: string, home: string, away: string, hs: number, as: number, to?: string): Meeting => ({
    at, event: "E", home: { coach: home, team: `${home} XI`, score: hs }, away: { coach: away, team: `${away} XI`, score: as },
    cas: { home: 1, away: 2 }, coaches: { home, away }, ...(to ? { to } : {}),
  });

  it("head-to-head by side whichever seat each coach had; the last meeting is the newest", () => {
    const h = headToHead([
      meeting("2026-10-03", "Bob", "Ann", 2, 0, "/c"),
      meeting("2026-10-02", "Ann", "Bob", 1, 1, "/b"),
      meeting("2026-10-01", "Ann", "Bob", 3, 1, "/a"),
    ], { home: "ann", away: "BOB" });
    expect(h.wins).toEqual({ home: 1, away: 1 });
    expect(h.draws).toBe(1);
    expect(h.td).toEqual({ home: 4, away: 4 });
    expect(h.cas).toEqual({ home: 1 + 1 + 2, away: 2 + 2 + 1 });
    expect(h.meetings[0]!.to).toBe("/c");
  });

  it("win rate counts a draw as half; Rating ranks only rated coaches, ties share the better rank", () => {
    expect(winRateOf({ played: 0, wins: 0, draws: 0 })).toBeNull();
    expect(winRateOf({ played: 4, wins: 1, draws: 2 })).toBe(0.5);
    const rate = ratingsOf({ ratings: () => new Map([["a", { rating: 1500, games: 3, provisional: true }], ["b", { rating: 1500, games: 9, provisional: true }], ["c", { rating: 1400.6, games: 1, provisional: true }]]) })!;
    expect(rate("A")).toMatchObject({ value: 1500, rank: 1, of: 3 });
    expect(rate("b")).toMatchObject({ rank: 1 });
    expect(rate("c")).toMatchObject({ value: 1401, rank: 3 });
    expect(rate("nobody")).toBeNull();
    expect(ratingsOf({})).toBeUndefined();
  });

  it("the team head-to-head is null when it is the same games as the coaches' meetings", () => {
    const dir = mkdtempSync(join(tmpdir(), "fixture-summary-teams-"));
    try {
      const store = new LeagueStore(dir);
      store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
      store.putSeason(season("season-2", 2, [fx("f0", 0, 2, 1, { finishedAt: "2026-10-10T20:00:00.000Z" }), fx("f1", 1)]));
      const league = store.league("alpha")!;
      const sides = { home: { team: { id: "orcs" } }, away: { team: { id: "humans" } } } as unknown as Record<"home" | "away", LobbyFixtureSide>;
      const same = [meeting("2026-10-10T20:00:00.000Z", "Ann", "Bob", 2, 1, "/leagues/alpha?season=season-2&tab=fixtures&fixture=f0")];
      expect(teamMeetings(store, league, sides, same)).toBeNull();
      expect(teamMeetings(store, league, sides, [])).toMatchObject({ wins: { home: 1, away: 0 }, td: { home: 2, away: 1 } });
      // the coaches also met in a game without a link (a results-store game): the records differ, so the teams' shows
      expect(teamMeetings(store, league, sides, [...same, meeting("2026-08-01T20:00:00.000Z", "Ann", "Bob", 0, 3)])).toMatchObject({ wins: { home: 1, away: 0 } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the inducement budget matches the recorder's own maths (petty cash, treasury, the 50K top-up cap)", () => {
    const { offers, ids } = seasonInducementOffers(undefined);
    const team = (name: string, tv: number, treasury: number): LobbyTeam => ({
      id: name, name, race: "Orc", tv, treasury, rerolls: 2, apothecary: false, fans: 2, assistantCoaches: 0, cheerleaders: 0, playerCount: 11, roster: [],
      file: { schema: 1, name, race: "Orc", treasury, dedicatedFans: 2, teamValue: tv, players: [] }, stars: [],
    });
    const stats = { played: 0, wins: 0, draws: 0, losses: 0, tdPerGame: 0, casPerGame: 0, form: [] };
    for (const [htv, atv, ht, at] of [[1_000_000, 1_150_000, 120_000, 40_000], [1_200_000, 1_050_000, 10_000, 30_000], [990_000, 1_000_000, 0, 0]] as const) {
      const lobby: LobbyFixture = {
        key: "k", source: "league", mode: "tabletop", open: true, header: { competition: "A", round: 1, ruleset: "BB2025" },
        links: { competition: "", fixture: "", standings: "", rules: "" },
        sides: { home: { coachId: "a", coach: "a", team: team("H", htv, ht), stats: { season: stats, allTime: stats } }, away: { coachId: "b", coach: "b", team: team("W", atv, at), stats: { season: stats, allTime: stats } } },
        rules: { treasuryTopUp: true, highlander: false, starClash: "refund" }, noInducements: "", offers, ids, table: effectiveInducements(undefined),
        isOrganiser: () => false, headToHead: { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] },
        organisers: [], recorderTeamAllowed: () => true, start: { fixtureRef: "k", extra: {} },
      };
      const rec = newLobby(lobby, new Date());
      const recorder = inducementMenu({ teams: { home: lobby.sides.home.team.file, away: lobby.sides.away.team.file }, events: [], offers }).budget;
      for (const s of ["home", "away"] as const) {
        const ours = budgetFor(lobby, rec, s);
        const theirs = recorder[s];
        expect(ours.pettyCash, `${s} petty cash`).toBe(theirs.pettyCash);
        expect(ours.treasury, `${s} treasury`).toBe(theirs.treasury);
        expect(ours.topUpLimit, `${s} top-up`).toBe(theirs.topUpLimit);
        expect(ours.role === "overdog" ? "favourite" : ours.role).toBe(theirs.role);
      }
    }
  });

  it("the note gate allows one note per fixture and recipient per gap", () => {
    const g = new LobbyNoticeGate();
    expect(g.take("k", "Ann", 0)).toBe(true);
    expect(g.take("k", "ann", 1000)).toBe(false);
    expect(g.take("k2", "Ann", 1000)).toBe(true);
    expect(g.take("k", "Ann", NOTICE_GAP_MS)).toBe(true);
  });

  it("SPA helpers: the Rating label, coach card lines, record, schedule and meeting lines (server figures only)", () => {
    expect(RATING_LABEL).toBe("Rating");
    expect(coachCardLines({ rating: { value: 1561, rd: 87, games: 12, provisional: false, rank: 2, of: 3 }, winRate: 0.833, stats: { allTime: { played: 3 } } } as never))
      .toEqual([{ k: "Rating", v: "1561 ±87" }, { k: "Win rate", v: "83%" }, { k: "Games", v: "3" }, { k: "Overall rank", v: "#2 of 3" }]);
    expect(coachCardLines({ rating: { value: 1488, games: 4, provisional: true }, winRate: null, stats: { allTime: { played: 0 } } } as never))
      .toEqual([{ k: "Rating", v: "1488 · Provisional" }, { k: "Win rate", v: "-" }, { k: "Games", v: "0" }]);
    expect(coachCardLines({ rating: null, winRate: null, stats: { allTime: { played: 0 } } } as never)[0]).toEqual({ k: "Rating", v: "Unrated" });
    expect(recordLine({ wins: 1, draws: 1, losses: 0 })).toBe("1-1-0");
    expect(recordLine(null)).toBe("-");
    expect(scheduleLine({ scheduled: AGREED }, "UTC")).toMatch(/Thu 5 Nov.*19:00/);
    expect(scheduleLine({ date: "2026-11-09" }, "UTC")).toMatch(/9 Nov/);
    expect(scheduleLine({}, "UTC")).toBe("No time agreed yet");
    expect(meetingLine({ home: { coach: "Ann", team: "Green Tide", score: 1 }, away: { coach: "Bob", team: "Grudge Rollers", score: 2 } }))
      .toBe("Green Tide 1-2 Grudge Rollers");
  });
});

// ---- the recorder pre-fill ---------------------------------------------------------------------------------------------

describe("lobby picks pre-fill the recorder's inducement picker, which can still change them", () => {
  let dir = "";
  let store: LeagueStore;
  const tplayers = (n: number, prefix: string): TabletopPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
  const file = (race: string, prefix: string, tv: number): TabletopTeamFile => ({ schema: 1, name: `${prefix} XI`, race, treasury: 100_000, dedicatedFans: 2, teamValue: tv, players: tplayers(11, prefix) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-summary-tt-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    store.putSeason(season("season-2", 2, [fx("f1", 1)]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("seeded lists are pre-filled, not confirmed; the favourite confirms first; both confirms move on", async () => {
    const ref = "league:alpha:season-2:f1";
    const deps: TabletopApiDeps = {
      repo: new FileTabletopRepository(join(dir, "tt")), results: new TournamentResultStore(join(dir, "res")),
      // Ann's Orcs are the underdog (1.0M v 1.1M)
      loadTeamFile: (coach) => (coach === "Ann" ? file("Orc", "a", 1_000_000) : file("Human", "b", 1_100_000)),
      isBanned: () => false, isOrganizer: (c) => c === "Org", drawSeats: () => false, rollDie: () => 3,
      leagueInducements: () => ({ config: undefined, active: true, coaches: ["Ann", "Bob"] }),
      fixtures: { get: (id) => leagueFixtureView(store, id), record: () => undefined, retract: () => undefined },
    };
    const lists = {
      ann: { picks: [{ id: "bribes", name: "Bribes", qty: 1, cost: 100_000 }], total: 100_000, treasury: 0, pettyCash: 100_000 },
      bob: { picks: [], total: 0, treasury: 0, pettyCash: 0 },
    };
    const body = { fixtureRef: ref, home: { coach: "Ann", team: "library:a" }, away: { coach: "Bob", team: "library:b" }, leagueSeason: { leagueId: "alpha", seasonId: "season-2" }, league: "Alpha League" };
    const made = await createMatch("Ann", false, body, deps, () => new Date("2026-11-02T12:00:00.000Z"), { inducementsByCoach: lists, fromLobby: true });
    expect(made.status).toBe(201);
    const id = (made.body as { match: { id: string } }).match.id;
    const adv = async (coach: string, b: Record<string, unknown> = { mode: "site" }) => (await tabletopApi("POST", `/api/tabletop/matches/${id}/pregame/advance`, { coach, method: "discord" }, b, deps))!;
    let r = await adv("Ann");
    for (let i = 0; i < 2; i += 1) r = await adv("Ann");
    expect(r.status).toBe(200);
    const pre = r.body as { phase: string; waitingFor: string[]; pregame: { budget: Record<string, { submitted: boolean; lobby?: true }>; inducements: Record<string, { picks: Array<{ id: string; qty: number }> }> } };
    expect(pre.phase).toBe("pregame:inducements");
    // the picker starts from the lobby lists, marked as pre-filled and not yet confirmed
    expect(pre.pregame.inducements.home!.picks).toEqual([expect.objectContaining({ id: "bribes", qty: 1 })]);
    expect(pre.pregame.budget.home).toMatchObject({ submitted: false, lobby: true });
    expect(pre.pregame.budget.away).toMatchObject({ submitted: false, lobby: true });
    // the underdog cannot confirm before the favourite confirms here (its spend feeds the petty cash)
    expect((await adv("Ann", { team: "home", picks: [{ id: "bribes", qty: 1 }] })).status).toBe(409);
    // the favourite confirms its (empty) list; the phase waits for the underdog
    r = await adv("Bob", { team: "away", skip: true });
    expect(r.body).toMatchObject({ phase: "pregame:inducements", waitingFor: ["home"] });
    // without the fixture's rules (no lobbyRules here) a change cannot be judged: only the list as picked confirms
    expect((await adv("Ann", { team: "home", picks: [{ id: "bloodweiser_kegs", qty: 1 }] })).status).toBe(409);
    r = await adv("Ann", { team: "home", picks: [{ id: "bribes", qty: 1 }] });
    expect(r.status).toBe(200);
    expect((r.body as { phase: string }).phase).toBe("pregame:coin");
    const events = (await deps.repo.readEvents(id)).filter((e) => e.type === "inducement" && e.team === "home");
    expect(events.map((e) => [e.payload.lobby ?? false, e.payload.total])).toEqual([[true, 100_000], [false, 100_000]]);
  });
});


describe("the recorder confirm uses the lobby's own rules (stars, Builder-paid lines, package limits)", () => {
  let dir = "";
  let store: LeagueStore;
  const tplayers = (n: number, prefix: string): TabletopPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
  const STAR = "star:Akhorne the Squirrel";
  // the recorder's team files: Ann's Orcs 1.0M (underdog), Bob's Humans 1.1M; Bob may carry a rostered star
  const tfile = (race: string, prefix: string, tv: number, opts: { players?: number; star?: boolean } = {}): TabletopTeamFile => ({
    schema: 1, name: `${prefix} XI`, race, treasury: 100_000, dedicatedFans: 2, teamValue: tv,
    players: [...tplayers(opts.players ?? 11, prefix), ...(opts.star ? [{ id: `${prefix}s`, name: "Akhorne the Squirrel", positionName: "Akhorne the Squirrel", kind: "star", spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false } as TabletopPlayer] : [])],
  });
  // Ann (home, underdog: 1.0M v 1.1M, 100K treasury) with a Builder-paid bribe; Bob the favourite
  function lobbyFx(opts: { kegsOff?: boolean } = {}): LobbyFixture {
    const { offers, ids } = seasonInducementOffers(undefined);
    const team = (name: string, tv: number, treasury: number): LobbyTeam => ({
      id: name, name, race: "Orc", tv, treasury, rerolls: 2, apothecary: false, fans: 2, assistantCoaches: 0, cheerleaders: 0, playerCount: 11, roster: [],
      file: { schema: 1, name, race: "Orc", treasury, dedicatedFans: 2, teamValue: tv, players: [] }, stars: [{ name: "Akhorne the Squirrel", cost: 80_000 }],
    });
    const stats = { played: 0, wins: 0, draws: 0, losses: 0, tdPerGame: 0, casPerGame: 0, form: [] };
    const table = effectiveInducements(undefined).map((r) => (opts.kegsOff && r.id === "bloodweiser_kegs" ? { ...r, enabled: false } : r));
    return {
      key: "tournament:m1", source: "tournament", mode: "tabletop", open: true, header: { competition: "Cup", round: 1, ruleset: "x" },
      links: { competition: "", fixture: "", standings: "", rules: "" },
      sides: { home: { coachId: "Ann", coach: "Ann", team: team("A", 1_000_000, 100_000), stats: { season: stats, allTime: stats } }, away: { coachId: "Bob", coach: "Bob", team: team("B", 1_100_000, 0), stats: { season: stats, allTime: stats } } },
      rules: { treasuryTopUp: true, highlander: false, starClash: "refund" }, noInducements: "", offers, ids, table,
      isOrganiser: () => false, headToHead: { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] },
      organisers: [], recorderTeamAllowed: () => true, start: { fixtureRef: "x", extra: {} }, prefilled: { home: [{ id: "bribes", qty: 1 }], away: [] },
    };
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-summary-rules-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    store.putSeason(season("season-2", 2, [fx("f1", 1)]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  type View = { phase: string; pregame: { tv: Record<string, number>; inducementOptions: Record<string, Array<{ id: string; max: number; price: number; prefilled?: number }>>; budget: Record<string, { role: string; pettyCash: number; topUpLimit: number; submitted: boolean }> } };
  async function seeded(fixture: LobbyFixture | undefined, teamOpts: { annPlayers?: number; bobStar?: boolean } = {}) {
    const deps: TabletopApiDeps = {
      repo: new FileTabletopRepository(join(dir, "tt")), results: new TournamentResultStore(join(dir, "res")),
      loadTeamFile: (coach) => (coach === "Ann" ? tfile("Orc", "a", 1_000_000, { players: teamOpts.annPlayers }) : tfile("Human", "b", 1_100_000, { star: teamOpts.bobStar })),
      isBanned: () => false, isOrganizer: (c) => c === "Org", drawSeats: () => false, rollDie: () => 3,
      leagueInducements: () => ({ config: undefined, active: true, coaches: ["Ann", "Bob"] }),
      fixtures: { get: (id) => leagueFixtureView(store, id), record: () => undefined, retract: () => undefined },
      lobbyRules: () => (fixture ? lobbyConfirmRules(fixture) : undefined),
    };
    const lists = {
      ann: { picks: [{ id: STAR, name: "Akhorne the Squirrel", qty: 1, cost: 80_000 }, { id: "bribes", name: "Bribes", qty: 1, cost: 0, prefilled: 1 }], total: 80_000, treasury: 0, pettyCash: 100_000 },
      bob: { picks: [], total: 0, treasury: 0, pettyCash: 0 },
    };
    const body = { fixtureRef: "league:alpha:season-2:f1", home: { coach: "Ann", team: "library:a" }, away: { coach: "Bob", team: "library:b" }, leagueSeason: { leagueId: "alpha", seasonId: "season-2" }, league: "Alpha League" };
    const made = await createMatch("Ann", false, body, deps, () => new Date("2026-11-02T12:00:00.000Z"), { inducementsByCoach: lists, fromLobby: true });
    const id = (made.body as { match: { id: string } }).match.id;
    const adv = async (coach: string, b: Record<string, unknown> = { mode: "site" }) => (await tabletopApi("POST", `/api/tabletop/matches/${id}/pregame/advance`, { coach, method: "discord" }, b, deps))!;
    const edit = async (b: Record<string, unknown>) => (await tabletopApi("POST", `/api/tabletop/matches/${id}/inducements`, { coach: "Org", method: "discord" }, b, deps))!;
    let r = await adv("Ann");
    for (let i = 0; i < 2; i += 1) r = await adv("Ann");
    return { deps, id, adv, edit, view: r.body as View };
  }
  const cart = [{ id: STAR, qty: 1 }, { id: "bribes", qty: 1 }];
  const err = (r: { body: unknown }): string => (r.body as { error?: string }).error ?? "";

  it("confirming keeps a star hire and never charges a Builder-paid line again; the picker shows the lobby's catalogue", async () => {
    const { deps, id, adv, view } = await seeded(lobbyFx());
    expect(view.phase).toBe("pregame:inducements");
    expect(view.pregame.inducementOptions.home!.map((o) => o.id)).toContain(STAR);
    expect(view.pregame.inducementOptions.home!.find((o) => o.id === "bribes")).toMatchObject({ max: 3, prefilled: 1 });
    expect(view.pregame.budget.home).toMatchObject({ role: "underdog", pettyCash: 100_000, topUpLimit: 50_000 });
    expect((await adv("Bob", { team: "away", skip: true })).status).toBe(200);
    // still in the inducement step: removing the Builder-paid bribe is refused with the reason
    const removed = await adv("Ann", { team: "home", picks: [{ id: STAR, qty: 1 }] });
    expect(removed.status).toBe(400);
    expect(err(removed)).toMatch(/already paid and cannot be removed/);
    const r = await adv("Ann", { team: "home", picks: cart });
    expect(r.status).toBe(200);
    expect((r.body as { phase: string }).phase).toBe("pregame:coin");
    const last = (await deps.repo.readEvents(id)).filter((e) => e.type === "inducement" && e.team === "home").at(-1)!;
    expect(last.payload).toMatchObject({ total: 80_000, treasury: 0 });
    expect((last.payload.picks as Array<{ id: string; qty: number; cost: number }>).map((p) => [p.id, p.qty, p.cost])).toEqual([[STAR, 1, 80_000], ["bribes", 1, 0]]);
  });

  it("changes follow the lobby's rules: a forbidden item, over budget and a star already in the match are refused", async () => {
    const { adv } = await seeded(lobbyFx({ kegsOff: true }));
    expect((await adv("Bob", { team: "away", skip: true })).status).toBe(200);
    expect((await adv("Ann", { team: "home", picks: [...cart, { id: "bloodweiser_kegs", qty: 1 }] })).status).toBe(400);
    expect((await adv("Ann", { team: "home", picks: [{ id: STAR, qty: 1 }, { id: "bribes", qty: 3 }] })).status).toBe(400); // 2 more bribes: 280K > 150K
    expect(lobbyConfirmRules(lobbyFx()).plan("home", cart, 0, [STAR])).toMatchObject({ error: expect.stringMatching(/already plays in this match/) });
    // "No inducements" keeps the paid bribe
    const skip = await adv("Ann", { team: "home", skip: true });
    expect(skip.status).toBe(200);
    expect((skip.body as { phase: string }).phase).toBe("pregame:coin");
  });

  it("a star already on a roster (a Builder star) cannot be confirmed for the other team", async () => {
    const { adv } = await seeded(lobbyFx(), { bobStar: true });
    expect((await adv("Bob", { team: "away", skip: true })).status).toBe(200);
    const r = await adv("Ann", { team: "home", picks: cart });
    expect(r.status).toBe(400);
    expect(err(r)).toMatch(/Akhorne the Squirrel already plays in this match/);
  });

  it("the petty-cash gap uses the team values after journeymen", async () => {
    // Ann has 10 players: one journeyman joins, so her team value rises and the gap shrinks
    const { view } = await seeded(lobbyFx(), { annPlayers: 10 });
    expect(view.pregame.tv.home).toBeGreaterThan(1_000_000);
    expect(view.pregame.budget.home!.pettyCash).toBe(view.pregame.tv.away! - view.pregame.tv.home!);
    expect(view.pregame.budget.home!.pettyCash).toBeLessThan(100_000);
  });

  it("rules unreadable: the seeded star and paid line are in the catalogue and the list confirms unchanged", async () => {
    const { adv, view } = await seeded(undefined);
    expect(view.pregame.inducementOptions.home!.find((o) => o.id === STAR)).toMatchObject({ price: 80_000, max: 1 });
    expect(view.pregame.inducementOptions.home!.find((o) => o.id === "bribes")).toMatchObject({ prefilled: 1 });
    expect((await adv("Bob", { team: "away", skip: true })).status).toBe(200); // Bob's empty list: "No inducements" confirms it
    expect((await adv("Ann", { team: "home", picks: [{ id: STAR, qty: 1 }] })).status).toBe(409); // a change cannot be judged
    const r = await adv("Ann", { team: "home", picks: cart });
    expect(r.status).toBe(200);
    expect((r.body as { phase: string }).phase).toBe("pregame:coin");
  });

  it("an organiser's edit after the step uses the lobby's rules (skip keeps paid lines); override is explicit and marked", async () => {
    const { deps, id, adv, edit } = await seeded(lobbyFx({ kegsOff: true }));
    expect((await adv("Bob", { team: "away", skip: true })).status).toBe(200);
    expect((await adv("Ann", { team: "home", picks: cart })).status).toBe(200);
    // skip keeps the Builder-paid bribe and charges nothing
    const skip = await edit({ team: "home", skip: true });
    expect(skip.status).toBe(200);
    let last = (await deps.repo.readEvents(id)).filter((e) => e.type === "inducement" && e.team === "home").at(-1)!;
    expect(last.payload).toMatchObject({ total: 0, treasury: 0, adminEdit: true });
    expect((last.payload.picks as Array<{ id: string }>).map((p) => p.id)).toEqual(["bribes"]);
    // a forbidden item is refused by the lobby's rules; the paid bribe is not charged again
    expect((await edit({ team: "home", picks: [...cart, { id: "bloodweiser_kegs", qty: 1 }] })).status).toBe(400);
    expect((await edit({ team: "home", picks: cart })).status).toBe(200);
    last = (await deps.repo.readEvents(id)).filter((e) => e.type === "inducement" && e.team === "home").at(-1)!;
    expect(last.payload).toMatchObject({ total: 80_000 });
    // override: the recorder's own pricing, marked on the record
    const over = await edit({ team: "home", picks: [{ id: "bloodweiser_kegs", qty: 1 }], override: true });
    expect(over.status).toBe(200);
    last = (await deps.repo.readEvents(id)).filter((e) => e.type === "inducement" && e.team === "home").at(-1)!;
    expect(last.payload).toMatchObject({ override: true, adminEdit: true });
  });
});

describe("privacy: who asked an organiser", () => {
  it("the export names the asker's lobby; deletion anonymises askedOrganiser.by", async () => {
    const { collectExport, DELETE_STEPS } = await import("../src/privacy/collectors");
    const { createAnonymiser, createTextReplacer } = await import("../src/privacy/anonymise");
    const dir = mkdtempSync(join(tmpdir(), "fixture-summary-privacy-"));
    try {
      const store = new FixtureLobbyStore(dir);
      // an organiser-side lobby where only the ask names the coach (not a seat, no chat line of theirs)
      const rec = newLobby({ key: "league:alpha:season-2:f9", source: "league", sides: { home: { coachId: "Cat" }, away: { coachId: "Dee" } } as never }, new Date("2026-11-02T12:00:00.000Z"));
      rec.askedOrganiser = { at: "2026-11-02T12:00:00.000Z", by: "Ann" };
      store.put(rec);
      const deps = { stateDir: dir, tournamentsDir: dir, libraryDir: dir, builderSavesDir: dir, teamAvatarsDir: dir, coachAvatarsDir: dir, bugReportsDir: dir, tabletopDir: dir };
      const files = await collectExport(deps, "Ann");
      const lobbies = JSON.parse(String(files.find((f) => f.name === "fixture-lobbies.json")!.content)) as Array<{ askedOrganiser: { by: string } }>;
      expect(lobbies[0]!.askedOrganiser.by).toBe("Ann");
      const step = DELETE_STEPS.find((s) => s.id === "anonymise-fixture-lobbies")!;
      await step.run({ deps, an: createAnonymiser(["Ann"], "Deleted coach #7"), names: new Set(["ann"]), text: () => createTextReplacer(["Ann"], "Deleted coach #7", []) } as never);
      const after = JSON.parse(readFileSync(join(store.dir, readdirSync(store.dir)[0]!), "utf8")) as { askedOrganiser: { by: string } };
      expect(after.askedOrganiser.by).toBe("Deleted coach #7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
