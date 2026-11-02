import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultEvents, DEFAULT_LIVE, effectiveConfig, eventKeysFor, TOURNAMENT_MODE_KEYS, type CompetitionDiscordConfig,
} from "../src/discord/catalogue";
import { botInviteUrl, discordApi, discordApiPath, populateSeasonDiscord, resetDiscordRateLimits, type DiscordApiDeps } from "../src/discord/api";
import { COMMENT_MAX, commentsFor, parseComment } from "../src/discord/comments";
import { displaySettingsRoute, profanityFilterOn } from "../src/discord/displaySettings";
import { forkGame, tabletopGame } from "../src/discord/games";
import { DiscordHub } from "../src/discord/hub";
import { DiscordObserver, RESULT_SETTLE_MS } from "../src/discord/observer";
import { gameDigestPost, samplePost } from "../src/discord/posts";
import { containsProfanity, forViewer, starProfanity } from "../src/discord/profanity";
import { ROOTS_ROT13, WORDS_ROT13 } from "../src/discord/profanityList";
import { createDiscordReach, safeInviteUrl } from "../src/discord/reach";
import { DiscordStateStore } from "../src/discord/store";
import { postTo, seasonTarget, tournamentTarget } from "../src/discord/targets";
import { lastSlot, slotDue, weeklyContent, weeklyOf } from "../src/discord/weekly";
import type { DiscordPayload } from "../src/leagues/discord";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, SeasonRecord } from "../src/leagues/types";
import { MailPrefsStore } from "../src/mail/stores";
import { MailWorker, Outbox } from "../src/mail/outbox";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api";
import type { TabletopEvent } from "../src/tabletop/events";
import type { TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository, type MatchRecord } from "../src/tabletop/store";
import { TournamentStore } from "../src/tournaments/store";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { TournamentResultStore } from "../src/tournamentResults";

// Competition Discord (src/discord/): per-competition webhooks with the league fallback, the event catalogue and its
// defaults, live vs end-of-game routing from RECORDED games only, the digest, coach's comments, the profanity display
// filter, the Weekly Digest, the observer, the samples button and the DM queue pacing. No network: every poster and
// fetch is stubbed. Fake data only; webhook URLs are fake and must never appear in a read model or a log.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const HOOK2 = "https://discord.com/api/webhooks/223456789012345678/zyxwvutsrqponmlkjihgfedcba_FEDCBA-321";
const NOW = new Date("2026-11-01T12:00:00.000Z");
const at = (h: number): string => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const rot13 = (s: string): string => s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + 13) % 26) + 97));
/** A listed word, decoded at run time so the test source and names never carry it. */
const LISTED = rot13(WORDS_ROT13[1]!);
const ROOT = rot13(ROOTS_ROT13[0]!);

let dir = "";
let leagues: LeagueStore;
let tournaments: TournamentStore;
let state: DiscordStateStore;
let posts: Array<{ url: string; payload: DiscordPayload }>;
const poster = async (url: string, payload: DiscordPayload) => { posts.push({ url, payload }); return { ok: true, status: 204 }; };
const titles = () => posts.map((p) => p.payload.embeds[0]!.title);

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const season = (id: string, fixtures: LeagueFixture[] = [], extra: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id, leagueId: "lg", number: Number(id.split("-")[1]), name: `Season ${id.split("-")[1]}`, sourceSlug: id, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }], fixtures,
  teams: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: at(-500), source: "manual", ...extra,
});

const tournament = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: "Autumn Open", status: "active", format: "swiss", packageName: "test-cup", maxPlayers: 8, roundCount: 3, currentRound: 1,
  tiebreakers: [], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "TOrg", organizerCoachIds: [], createdAt: at(-200), updatedAt: at(-200), ...extra,
});
const side = (entrantId: string, coach: string) => ({ entrantId, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: at(-300) }, teamId: `lib-${coach}` });
const entrant = (id: string, coach: string) => ({ id, tournamentId: "t1", seed: 1, coach: side(id, coach).coach, teamId: `lib-${coach}`, registeredAt: at(-100) });
const smatch = (id: string, extra: Record<string, unknown> = {}) => ({
  id, tournamentId: "t1", roundId: "t1:round:1", roundNumber: 1, home: side("e1", "Ann"), away: side("e2", "Bob"), status: "scheduled", revision: 1,
  launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 }, createdAt: at(-50), updatedAt: at(-50), ...extra,
});
function seedTournaments(extra: { t?: Record<string, unknown>; entrants?: Record<string, unknown>; matches?: Record<string, unknown>; rounds?: Record<string, unknown> } = {}): void {
  tournaments.writeSnapshot({
    version: 4,
    tournaments: { t1: tournament("t1", extra.t), t2: tournament("t2", { name: "Hidden Draft", unpublished: true, status: "draft" }) },
    entrants: extra.entrants ?? { e1: entrant("e1", "Ann"), e2: entrant("e2", "Bob") },
    rounds: extra.rounds ?? {}, standings: {}, scheduledMatches: extra.matches ?? {}, waitingPresence: {},
  } as never);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "discord-events-"));
  leagues = new LeagueStore(dir);
  leagues.upsertLeague({ id: "lg", name: "Test League", fullName: "Test League", slug: "lg", organisers: ["Org"] } as never);
  leagues.updateLeague("lg", (l) => { l.owner = "Org"; });
  leagues.putSeason(season("season-1"));
  tournaments = new TournamentStore(join(dir, "tournaments"));
  seedTournaments();
  state = new DiscordStateStore(join(dir, "discord"));
  posts = [];
  resetDiscordRateLimits();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("event catalogue: defaults per competition type", () => {
  it("leagues post most events (match started ON); tournaments start in tournament mode (match started OFF)", () => {
    const lg = defaultEvents("league");
    expect(lg.matchStarted).toBe(true);
    expect(lg.newRegistration).toBe(false);
    expect(lg.checkInOpen).toBe(false); // tournaments only
    for (const k of ["touchdown", "casualty", "injury", "death", "foul", "sentOff", "mvp", "hireFire"] as const) expect(lg[k]).toBe(true);
    const t = defaultEvents("tournament");
    expect(Object.entries(t).filter(([, v]) => v).map(([k]) => k).sort()).toEqual([...TOURNAMENT_MODE_KEYS].sort());
    expect(t.matchStarted).toBe(false);
    expect(eventKeysFor("tournament")).not.toContain("fixtureCreated");
    expect(eventKeysFor("league")).not.toContain("checkInOpen");
  });

  it("only deaths and sent-offs are live by default; the digest is on for leagues, off for tournaments; comments on", () => {
    expect(Object.entries(DEFAULT_LIVE).filter(([, v]) => v).map(([k]) => k).sort()).toEqual(["death", "sentOff"]);
    expect(effectiveConfig("league", undefined)).toMatchObject({ endOfGameDigest: true, comments: true });
    expect(effectiveConfig("tournament", undefined)).toMatchObject({ endOfGameDigest: false, comments: true });
    // a key that does not apply to the type is never on, whatever is stored
    expect(effectiveConfig("league", { events: { checkInOpen: true } }).events.checkInOpen).toBe(false);
  });
});

describe("per-competition webhooks: fallback, auto-populate, masking", () => {
  it("a season with no webhook of its own falls back to the league's; its own wins once set", () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    const t = seasonTarget(leagues, leagues.league("lg")!, "season-1");
    expect(t.url).toBe(HOOK);
    expect(t.inherited).toBe(true);
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK, competitionWebhooks: { "season:season-1": HOOK2 } });
    expect(seasonTarget(leagues, leagues.league("lg")!, "season-1")).toMatchObject({ url: HOOK2, inherited: false });
  });

  it("a new season is auto-populated from the league webhook and options (nothing is overwritten)", () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.discord = { endOfGameDigest: false }; });
    leagues.putSeason(season("season-2"));
    populateSeasonDiscord(leagues, "lg", "season-2");
    expect(leagues.secrets("lg").competitionWebhooks).toEqual({ "season:season-2": HOOK });
    expect(leagues.league("lg")!.competitionDiscord!["season:season-2"]).toMatchObject({ endOfGameDigest: false, events: { matchStarted: true } });
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK2, competitionWebhooks: { "season:season-2": HOOK } });
    populateSeasonDiscord(leagues, "lg", "season-2");
    expect(leagues.secrets("lg").competitionWebhooks!["season:season-2"]).toBe(HOOK);
  });

  it("starting a season through the league settings route copies the league webhook in", async () => {
    const { leagueApi } = await import("../src/leagues/api");
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    const r = await leagueApi("POST", "/api/leagues/lg/seasons", new URLSearchParams(), { coach: "Org", admin: false }, { store: leagues, postWebhook: poster, readBody: async () => Buffer.from("{}") } as never);
    expect(r!.status).toBe(201);
    const id = (r!.body as { season: { id: string } }).season.id;
    expect(leagues.secrets("lg").competitionWebhooks![`season:${id}`]).toBe(HOOK);
    expect(titles()).toEqual(["Test League: Season 2 has started"]);
  });

  it("a tournament in a series falls back to the series webhook", () => {
    seedTournaments({ t: { seriesId: "s1" } });
    state.setWebhook("series:s1", HOOK2);
    expect(tournamentTarget(state, tournaments.tournament("t1")!)).toMatchObject({ url: HOOK2, inherited: true });
    state.setWebhook("tournament:t1", HOOK);
    expect(tournamentTarget(state, tournaments.tournament("t1")!)).toMatchObject({ url: HOOK, inherited: false });
  });

  it("GET / PATCH answer the webhook masked only; a bad URL is refused without echoing it; nothing is logged", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster };
    const bad = await discordApi("PATCH", "/api/tournaments/t1/discord", { coach: "TOrg" }, { url: "https://evil.test/secret-hook-value" }, deps);
    expect(bad!.status).toBe(400);
    expect(JSON.stringify(bad!.body)).not.toContain("secret-hook-value");
    const set = await discordApi("PATCH", "/api/tournaments/t1/discord", { coach: "TOrg" }, { url: HOOK, events: { news: true } }, deps);
    expect(set!.status).toBe(200);
    expect(JSON.stringify(set!.body)).not.toContain("abcdefghijklmnop");
    expect((set!.body as { discord: { maskedUrl: string; configured: boolean } }).discord).toMatchObject({ configured: true, maskedUrl: "https://discord.com/api/webhooks/…/•••" });
    const season = await discordApi("PATCH", "/api/leagues/lg/seasons/season-1/discord", { coach: "Org" }, { url: HOOK2 }, deps);
    expect(JSON.stringify(season!.body)).not.toContain("zyxwvut");
    const lg = await discordApi("GET", "/api/leagues/lg/discord", { coach: "Org" }, undefined, deps);
    expect(JSON.stringify(lg!.body)).not.toMatch(/\d{18}/);
    expect(readFileSync(join(dir, "discord", "competitions.json"), "utf8")).not.toContain("webhooks");
    for (const spy of [log, err]) for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain("abcdefghijklmnop");
  });

  it("organisers and admins only: anonymous 401, another coach 403, a draft the viewer cannot see 404", async () => {
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster };
    expect((await discordApi("GET", "/api/leagues/lg/discord", undefined, undefined, deps))!.status).toBe(401);
    expect((await discordApi("GET", "/api/leagues/lg/discord", { coach: "Eve" }, undefined, deps))!.status).toBe(403);
    expect((await discordApi("GET", "/api/leagues/lg/discord", { coach: "Eve", admin: true }, undefined, deps))!.status).toBe(200);
    expect((await discordApi("GET", "/api/tournaments/t2/discord", { coach: "Eve" }, undefined, deps))!.status).toBe(404);
    // the league's own /discord/test stays on the league settings route
    expect(discordApiPath("/api/leagues/lg/discord/test")).toBe(false);
    expect(discordApiPath("/api/leagues/lg/seasons/season-1/discord/test")).toBe(true);
  });

  it("CSRF covers every write here (by method); GETs never change state", async () => {
    for (const p of ["/api/leagues/lg/discord", "/api/tournaments/t1/discord/samples", "/api/leagues/lg/discord/weekly-digest/post"]) {
      expect(isStateChangingApiRequest("POST", p)).toBe(true);
      expect(isStateChangingApiRequest("PATCH", p)).toBe(true);
      expect(isStateChangingApiRequest("GET", p)).toBe(false);
    }
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2, cas: 1 }, away: { ...fx("f1").away, score: 0, cas: 0 }, finishedAt: at(-2) })]));
    const observer = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster, observer };
    const before = existsSync(join(dir, "discord")) ? readdirSync(join(dir, "discord")) : [];
    const preview = await discordApi("GET", "/api/leagues/lg/discord/weekly-digest", { coach: "Org" }, undefined, deps);
    expect(preview!.status).toBe(200);
    expect((preview!.body as { preview: DiscordPayload }).preview.embeds[0]!.title).toBe("Test League: Weekly Digest");
    await discordApi("GET", "/api/leagues/lg/discord", { coach: "Org" }, undefined, deps);
    expect(existsSync(join(dir, "discord")) ? readdirSync(join(dir, "discord")) : []).toEqual(before);
    expect(posts).toHaveLength(0);
  });

  it("the bot invite link is built from DISCORD_CLIENT_ID and hidden when it is unset", async () => {
    expect(botInviteUrl(undefined)).toBeUndefined();
    expect(botInviteUrl("not-an-id")).toBeUndefined();
    expect(botInviteUrl("123456789012345678")).toBe("https://discord.com/oauth2/authorize?client_id=123456789012345678&scope=bot&permissions=19456");
    const g = await discordApi("GET", "/api/leagues/lg/discord", { coach: "Org" }, undefined, { leagues, tournaments, state });
    expect((g!.body as { discord: { botInviteUrl?: string } }).discord.botInviteUrl).toBeUndefined();
  });
});

describe("in-game events: only from recorded games", () => {
  const teams: Record<"home" | "away", TabletopTeamFile> = {
    home: { schema: 1, name: "Orcs", treasury: 0, dedicatedFans: 1, players: [{ id: "a1", name: "Grukk", number: 3, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }] },
    away: { schema: 1, name: "Elves", treasury: 0, dedicatedFans: 1, players: [{ id: "b1", name: "Lithiel", number: 7, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }] },
  };
  const ev = (id: string, type: string, team: "home" | "away", player?: string, payload: Record<string, unknown> = {}): TabletopEvent => ({ id, matchId: "m1", type: type as never, team, player, payload, ts: at(0), by: "Ann" });

  it("a hand-entered league fixture has no game record; a banked Super FUMBBL result does", () => {
    expect(forkGame(fx("f1", { home: { ...fx("f1").home, score: 2 } }))).toBeUndefined();
    const g = forkGame({ ...fx("f2"), fork: { result: { gameId: "g9", source: "full", appliedAt: at(0), home: { score: 1, cas: 1, conceded: false, winnings: 0, lines: [{ forkPlayerId: "1", name: "Grukk", td: 1, cas: 1, completions: 0, interceptions: 0, mvp: 1, fouls: 2, injuries: [] }] }, away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [{ forkPlayerId: "2", name: "Lithiel", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, injuries: ["Dead (RIP)"] }] } } } } as never)!;
    expect(g.source).toBe("superfumbbl");
    expect(g.lines.touchdown).toEqual([{ side: "home", player: "Grukk", count: 1 }]);
    expect(g.lines.foul[0]!.count).toBe(2);
    expect(g.lines.death).toEqual([{ side: "away", player: "Lithiel", count: 1, detail: "killed" }]);
    expect(g.lines.sentOff).toEqual([]); // the result carries none: never invented
    expect(g.lines.hireFire).toEqual([]);
  });

  it("the tabletop record comes from the effective event log (undone events are gone), names by number when names are private", () => {
    const events = [ev("e1", "touchdown", "home", "a1"), ev("e2", "touchdown", "home", "a1"), ev("e3", "undo", "home", undefined, { target: "e2" }),
      ev("e4", "casualty", "home", "a1", { victim: "b1", result: "DEAD" }), ev("e5", "sendOff", "home", "a1"), ev("e6", "foul", "home", "a1")];
    const label = (_s: "home" | "away", id?: string) => (id === "a1" ? "#3" : id === "b1" ? "#7" : "a player");
    const g = tabletopGame({ matchId: "m1", home: { team: "Orcs", coach: "Ann" }, away: { team: "Elves", coach: "Bob" }, events, label });
    expect(g.home.score).toBe(1);
    expect(g.lines.touchdown).toEqual([{ side: "home", player: "#3", count: 1 }]);
    expect(g.lines.death[0]).toMatchObject({ side: "away", player: "#7", victim: { player: "#3" } });
    expect(g.lines.sentOff).toHaveLength(1);
    void teams;
  });
});

describe("live vs digest routing (recorder matches)", () => {
  const teams = {
    home: { schema: 1 as const, name: "Orcs", treasury: 0, dedicatedFans: 1, players: [{ id: "a1", name: "Grukk", number: 3, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }] },
    away: { schema: 1 as const, name: "Elves", treasury: 0, dedicatedFans: 1, players: [{ id: "b1", name: "Lithiel", number: 7, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }] },
  };
  const ev = (id: string, type: string, team: "home" | "away", player?: string, payload: Record<string, unknown> = {}): TabletopEvent => ({ id, matchId: "m1", type: type as never, team, player, payload, ts: at(0), by: "Ann" });
  const match = (fixtureRef: string, extra: Partial<MatchRecord> = {}) => ({
    id: "m1", fixtureRef, home: { coach: "Ann", teamName: "Orcs", teamSaveId: "s1" }, away: { coach: "Bob", teamName: "Elves", teamSaveId: "s2" }, ...extra,
  }) as MatchRecord;
  const LREF = "league:lg:season-1:f1";

  beforeEach(() => {
    leagues.putSeason(season("season-1", [fx("f1")]));
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
  });

  it("a death and a sending-off post live (after the delay, if not undone); a touchdown waits for the digest", async () => {
    const undone = new Set<string>();
    const hub = new DiscordHub({ leagues, tournaments, state, poster, liveDelayMs: 0, stillEffective: async (_m, id) => !undone.has(id) });
    undone.add("e3");
    hub.onTabletopEvents(match(LREF), [ev("e1", "touchdown", "home", "a1"), ev("e2", "casualty", "home", "a1", { victim: "b1", result: "DEAD" }), ev("e3", "sendOff", "home", "a1"), ev("e4", "sendOff", "away", "b1")], teams);
    await hub.flush();
    expect(titles()).toEqual(["Test League: Player death", "Test League: Sent off"]);
    expect(posts[0]!.payload.embeds[0]!.description).toContain("Lithiel (Elves) has died, killed by Grukk");
    expect(posts[1]!.payload.embeds[0]!.description).toContain("Lithiel (Elves) has been sent off");
  });

  it("an event switched to live posts live; deaths switched off do not; casual and test matches never post", async () => {
    leagues.updateLeague("lg", (l) => { l.discord = { live: { touchdown: true, death: false } }; });
    const hub = new DiscordHub({ leagues, tournaments, state, poster, liveDelayMs: 0 });
    hub.onTabletopEvents(match(LREF), [ev("e1", "touchdown", "home", "a1"), ev("e2", "casualty", "home", "a1", { victim: "b1", result: "DEAD" })], teams);
    hub.onTabletopEvents(match(""), [ev("e5", "touchdown", "home", "a1")], teams);
    hub.onTabletopEvents(match(LREF, { test: true }), [ev("e6", "touchdown", "home", "a1")], teams);
    await hub.flush();
    expect(titles()).toEqual(["Test League: Touchdown"]);
  });

  it("the end of the game posts ONE digest (score, sections, comments), once per match and score; digest off = the plain result", async () => {
    const hub = new DiscordHub({ leagues, tournaments, state, poster, liveDelayMs: 0 });
    const events = [ev("e1", "touchdown", "home", "a1"), ev("e2", "foul", "home", "a1"), ev("e3", "mvp", "away", "b1")];
    const m = match(LREF, { comments: { home: { text: "Well played!", at: at(0) }, away: { text: "hidden one", at: at(0), hidden: { by: "Org", at: at(0) } } } });
    expect(await hub.onTabletopResult(m, events, teams)).toBe(true);
    expect(await hub.onTabletopResult(m, events, teams)).toBe(false);
    expect(posts).toHaveLength(1);
    const e = posts[0]!.payload.embeds[0]!;
    expect(e.title).toBe("Test League: Orcs 1 - 0 Elves");
    expect(e.fields!.map((f) => f.name)).toEqual(["Touchdowns", "Fouls", "MVP", "Coach's comments"]);
    expect(e.fields!.at(-1)!.value).toContain("Well played!");
    expect(JSON.stringify(e)).not.toContain("hidden one");
    posts.length = 0;
    leagues.updateLeague("lg", (l) => { l.discord = { endOfGameDigest: false }; });
    await hub.onTabletopResult({ ...m, id: "m2" }, events, teams);
    expect(posts.map((p) => p.payload.embeds[0]!.title)).toEqual(["Test League: result"]);
  });

  it("a tournament game marks its result, so the observer never posts it again", async () => {
    seedTournaments({ matches: { M1: smatch("M1", { result: { homeScore: 1, awayScore: 0, reportedAt: at(-1) } }) } });
    state.setWebhook("tournament:t1", HOOK2);
    const hub = new DiscordHub({ leagues, tournaments, state, poster });
    await hub.onTabletopResult(match("M1"), [ev("e1", "touchdown", "home", "a1")], teams);
    expect(titles()).toEqual(["Autumn Open: result"]); // tournament mode: digest off, match end on
    expect(state.has("tournament:t1", "result:M1")).toBe(true);
  });

  it("drafts never post: a draft league's match is silent live and at the end", async () => {
    leagues.updateLeague("lg", (l) => { l.visibility = "draft"; });
    const hub = new DiscordHub({ leagues, tournaments, state, poster, liveDelayMs: 0 });
    hub.onTabletopEvents(match(LREF), [ev("e2", "casualty", "home", "a1", { victim: "b1", result: "DEAD" })], teams);
    await hub.onTabletopResult(match(LREF), [], teams);
    await hub.flush();
    expect(posts).toHaveLength(0);
    expect(await postTo(seasonTarget(leagues, leagues.league("lg")!, "season-1"), "news", samplePost("x", "news"), poster)).toBe(false);
  });
});

describe("digest content and Discord starring", () => {
  it("every coach-typed text on Discord has listed words starred; the digest sections follow the toggles", () => {
    const g = tabletopGame({ matchId: "m", home: { team: "Orcs", coach: "Ann" }, away: { team: "Elves", coach: "Bob" }, events: [], label: () => "x", comments: [{ side: "home", coach: "Ann", text: `what a ${LISTED} game` }] });
    const p = gameDigestPost("Cup", g, {});
    const text = JSON.stringify(p);
    expect(text).not.toContain(LISTED);
    expect(p.embeds[0]!.fields!.at(-1)!.value).toContain("what a \\*\\*\\* game");
  });
});

describe("profanity: stored as written, starred for viewers who filter, always on Discord", () => {
  it("matches whole words (look-alikes, repeats, endings, compounds) and leaves innocent words alone", () => {
    expect(containsProfanity(`you ${LISTED}`)).toBe(true);
    expect(containsProfanity(`${LISTED.toUpperCase()}S!`)).toBe(true);
    expect(containsProfanity(`${ROOT}wit`)).toBe(true);
    expect(containsProfanity(LISTED.replace("i", "1"))).toBe(true);
    expect(containsProfanity("Scunthorpe raccoon cockatrice spicy")).toBe(false);
    expect(starProfanity(`well ${LISTED}, good game!`)).toBe("well ***, good game!");
  });

  it("the viewer option: on (default, and for visitors) stars; off shows the text as written", () => {
    expect(forViewer(`a ${LISTED}`, undefined)).toBe("a ***");
    expect(forViewer(`a ${LISTED}`, true)).toBe("a ***");
    expect(forViewer(`a ${LISTED}`, false)).toBe(`a ${LISTED}`);
    const prefs = new MailPrefsStore(join(dir, "mail"));
    expect(profanityFilterOn(prefs, undefined)).toBe(true);
    expect(displaySettingsRoute("GET", { coach: "Ann" }, undefined, prefs).body).toEqual({ profanityFilter: true });
    expect(displaySettingsRoute("POST", undefined, { profanityFilter: false }, prefs).status).toBe(401);
    expect(displaySettingsRoute("POST", { coach: "Ann", test: true }, { profanityFilter: false }, prefs).status).toBe(403);
    expect(displaySettingsRoute("POST", { coach: "Ann" }, { profanityFilter: "no" }, prefs).status).toBe(400);
    expect(displaySettingsRoute("POST", { coach: "Ann" }, { profanityFilter: false }, prefs).body).toEqual({ profanityFilter: false });
    expect(profanityFilterOn(prefs, "Ann")).toBe(false);
    expect(profanityFilterOn(prefs, "Bob")).toBe(true);
  });

  it("a comment is never rejected for its words and is stored exactly as written", () => {
    expect(parseComment({ text: `${LISTED} of a dodge` })).toEqual({ ok: true, text: `${LISTED} of a dodge` });
  });
});

describe("coach's comments (recorder end-game step)", () => {
  let repo: FileTabletopRepository;
  let commentsOn = true;
  const managers = new Set(["Org"]);
  const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
    schema: 1, name, treasury: 50_000, dedicatedFans: 2,
    players: ["1", "2", "3"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
  });
  const hooks = { events: [] as string[], results: [] as string[] };
  const deps = (): TabletopApiDeps => ({
    repo, results: new TournamentResultStore(join(dir, "res")),
    loadTeamFile: (coach) => (coach === "Ann" ? mkTeam("Orcs", "a") : mkTeam("Elves", "b")),
    isBanned: () => false, drawSeats: () => false, isOrganizer: () => false,
    managesMatch: (coach) => managers.has(coach),
    commentsEnabled: () => commentsOn,
    onEvents: (_m, accepted) => { hooks.events.push(...accepted.map((e) => e.type)); },
    onResult: (m) => { hooks.results.push(m.id); },
    now: () => NOW,
  });
  const as = (coach: string, method: string, path: string, body?: unknown) => tabletopApi(method, path, { coach, method: "discord" }, body, deps()) as Promise<TabletopResult>;
  let n = 0;
  const E = (type: string, team: string, player?: string) => ({ id: `evt-${String(++n).padStart(8, "0")}`, type, team, player, payload: {} });

  async function submitted(): Promise<string> {
    const r = await as("Ann", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Ann", teamSaveId: "s1" }, away: { coach: "Bob", teamSaveId: "s2" }, postMatch: "none" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = (r.body as { match: { id: string } }).match.id;
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1")] })).status).toBe(200);
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/submit`)).status).toBe(200);
    return id;
  }

  beforeEach(() => { repo = new FileTabletopRepository(join(dir, "tt")); commentsOn = true; hooks.events.length = 0; hooks.results.length = 0; });

  it("one comment per coach per game, at most 120 characters, only at the end-game step, only by the two coaches", async () => {
    const r = await as("Ann", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Ann", teamSaveId: "s3" }, away: { coach: "Bob", teamSaveId: "s4" }, postMatch: "none" });
    const early = (r.body as { match: { id: string } }).match.id;
    expect((await as("Ann", "POST", `/api/tabletop/matches/${early}/comment`, { text: "too soon" })).status).toBe(409);
    const id = await submitted();
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/comment`, { text: "x".repeat(COMMENT_MAX + 1) })).body).toEqual({ error: "A comment can be at most 120 characters." });
    expect((await as("Eve", "POST", `/api/tabletop/matches/${id}/comment`, { text: "hi" })).status).toBe(403);
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/comment`, { text: "x".repeat(COMMENT_MAX) })).status).toBe(200);
    const saved = await as("Ann", "POST", `/api/tabletop/matches/${id}/comment`, { text: `Lucky ${LISTED} dice, GG` });
    expect(saved.status).toBe(200);
    // stored as written (the display filter is the viewer's business), still one comment
    expect((await repo.getMatch(id))!.comments).toEqual({ home: { text: `Lucky ${LISTED} dice, GG`, at: NOW.toISOString() } });
    expect(hooks.events).toEqual(["touchdown"]);
  });

  it("an organiser hides a comment: gone for the opponent, still there (marked) for its author and managers", async () => {
    const id = await submitted();
    await as("Bob", "POST", `/api/tabletop/matches/${id}/comment`, { text: "Rematch soon" });
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/comment/hide`, { side: "away", hidden: true })).status).toBe(403);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/comment/hide`, { side: "away", hidden: true })).status).toBe(200);
    const m = (await repo.getMatch(id))!;
    expect(m.comments!.away!.hidden).toMatchObject({ by: "Org" });
    expect(commentsFor(m, "home")).toBeUndefined();
    expect(commentsFor(m, "away")!.away!.hidden).toBeDefined();
    expect(commentsFor(m, "manager")!.away).toBeDefined();
    const ann = await as("Ann", "GET", `/api/tabletop/matches/${id}`);
    expect(JSON.stringify(ann.body)).not.toContain("Rematch soon");
    await as("Org", "POST", `/api/tabletop/matches/${id}/comment/hide`, { side: "away", hidden: false });
    expect(JSON.stringify((await as("Ann", "GET", `/api/tabletop/matches/${id}`)).body)).toContain("Rematch soon");
  });

  it("the competition setting off refuses comments; the result hook fires when both coaches confirm", async () => {
    const id = await submitted();
    commentsOn = false;
    expect((await as("Ann", "POST", `/api/tabletop/matches/${id}/comment`, { text: "hi" })).body).toEqual({ error: "Coach's comments are turned off for this competition." });
    await as("Ann", "POST", `/api/tabletop/matches/${id}/confirm`);
    await as("Bob", "POST", `/api/tabletop/matches/${id}/confirm`);
    await new Promise((r) => setTimeout(r, 5));
    expect(hooks.results).toEqual([id]);
  });
});

describe("Weekly Digest", () => {
  it("the schedule: day + time in the league time zone, every N weeks; a slot is due once and never after a day", () => {
    const s = weeklyOf({ day: 0, time: "10:00", everyWeeks: 1 });
    // 2026-11-01 is a Sunday; 10:00 in New York (EST, UTC-5) = 15:00 UTC
    const slot = lastSlot(s, new Date("2026-11-01T16:00:00.000Z"), "America/New_York");
    expect(slot.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(lastSlot(s, new Date("2026-11-01T14:00:00.000Z"), "America/New_York").toISOString()).toBe("2026-10-25T14:00:00.000Z"); // EDT the week before
    expect(slotDue(s, new Date("2026-11-01T16:00:00.000Z"), "America/New_York", undefined)?.toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(slotDue(s, new Date("2026-11-01T16:00:00.000Z"), "America/New_York", "2026-11-01T15:00:00.000Z")).toBeUndefined();
    expect(slotDue(s, new Date("2026-11-03T16:00:00.000Z"), "America/New_York", undefined)).toBeUndefined();
    expect(slotDue({ ...s, trigger: "afterRound" }, new Date("2026-11-01T16:00:00.000Z"), "UTC", undefined)).toBeUndefined();
    const every2 = lastSlot({ ...s, everyWeeks: 2 }, new Date("2026-11-01T16:00:00.000Z"), "UTC");
    expect([every2.toISOString()]).toContainEqual(expect.stringMatching(/T10:00:00.000Z$/));
  });

  it("a week with no games is skipped; content has standings, results and highlights from recorded data", () => {
    const played = (id: string, h: number, a: number, when: string, extra: Partial<LeagueFixture> = {}) => fx(id, { home: { ...fx(id).home, score: h, cas: 2 }, away: { ...fx(id).away, score: a, cas: 0 }, finishedAt: when, ...extra });
    const s = season("season-1", [played("f1", 3, 0, at(-30)), played("f2", 1, 1, at(-200))]);
    expect(weeklyContent(s, NOW.getTime() - 10 * 3_600_000, NOW.getTime(), "UTC", [])).toBeUndefined();
    const c = weeklyContent(s, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime(), "UTC", [])!;
    expect(c.results).toEqual(["Orcs 3 - 0 Elves"]);
    expect(c.standings[0]).toMatchObject({ rank: 1, name: "Orcs" });
    expect(c.highlights.map((h) => h.name)).toEqual(["Most casualties", "Biggest win"]); // no recorded games: no fouls / scorers / deaths, no bounties ever
  });

  it("the observer posts the digest at the slot once (the run survives a restart via the ledger), and never for a draft", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.timeZone = "UTC"; l.weeklyDigest = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 }; });
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2, cas: 1 }, away: { ...fx("f1").away, score: 1, cas: 0 }, finishedAt: at(-5) })]));
    const make = () => new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await make().tick();
    expect(titles().filter((t) => t.endsWith("Weekly Digest"))).toHaveLength(1);
    await make().tick(); // a fresh observer (restart): the last run is in the ledger
    expect(titles().filter((t) => t.endsWith("Weekly Digest"))).toHaveLength(1);
    expect(state.weekly("lg").lastRun).toBe("2026-11-01T10:00:00.000Z");
  });

  it("Preview and Post now are organiser actions; Post now refuses a period with no games and a draft", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    const observer = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster, observer };
    const empty = await discordApi("GET", "/api/leagues/lg/discord/weekly-digest", { coach: "Org" }, undefined, deps);
    expect(empty!.body).toMatchObject({ preview: null, reason: "No games were played in this period, so the digest is skipped." });
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, deps))!.status).toBe(409);
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Eve" }, {}, deps))!.status).toBe(403);
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2 }, away: { ...fx("f1").away, score: 1 }, finishedAt: at(-5) })]));
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, deps))!.status).toBe(200);
    expect(titles()).toEqual(["Test League: Weekly Digest"]);
  });
});

describe("observer: competition events without replaying history", () => {
  it("first sight marks what exists without posting; a new entrant, pairings, a result and a round summary post afterwards", async () => {
    state.setWebhook("tournament:t1", HOOK);
    state.setConfig("tournament:t1", { events: { newRegistration: true } });
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    expect(posts).toHaveLength(0);
    seedTournaments({
      entrants: { e1: entrant("e1", "Ann"), e2: entrant("e2", "Bob"), e3: entrant("e3", "Cat") },
      rounds: { r1: { id: "r1", tournamentId: "t1", number: 1, status: "completed", scheduledMatchIds: ["M1"], createdAt: at(-3) } },
      matches: { M1: smatch("M1", { status: "completed", result: { homeScore: 2, awayScore: 1, reportedAt: new Date(NOW.getTime() - RESULT_SETTLE_MS).toISOString() } }) },
    });
    await obs.tick();
    expect(titles()).toEqual(["Autumn Open: New registration", "Autumn Open: Round 1 pairings", "Autumn Open: result", "Autumn Open: Round 1 summary"]);
    await obs.tick();
    expect(posts).toHaveLength(4);
  });

  it("an organiser's result edit is never announced; a draft tournament and a league without a webhook stay silent", async () => {
    state.setWebhook("tournament:t1", HOOK);
    state.setWebhook("tournament:t2", HOOK);
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    seedTournaments({ matches: { M1: smatch("M1", { result: { homeScore: 2, awayScore: 1, reportedAt: at(-2) }, edited: { kind: "result", by: "TOrg", at: at(-1) } }) } });
    await obs.tick();
    expect(posts).toHaveLength(0);
    expect(state.has("tournament:t1", "result:M1")).toBe(true);
  });

  it("publishing a draft posts 'published' only", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.visibility = "draft"; l.awards = [{ id: "a1", title: "Best painted", icon: "brush", toTeam: "Orcs", note: "", by: "Org", at: at(-1) }]; });
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    await obs.tick();
    expect(posts).toHaveLength(0);
    leagues.updateLeague("lg", (l) => { l.visibility = "published"; });
    await obs.tick();
    expect(titles()).toEqual(["Test League: Published"]);
  });
});

describe("samples button", () => {
  it("organiser-only, never for drafts, needs a webhook, one [TEST] sample per ticked event, then rate limited", async () => {
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster, samplePauseMs: 0 };
    expect((await discordApi("POST", "/api/tournaments/t1/discord/samples", undefined, {}, deps))!.status).toBe(401);
    expect((await discordApi("POST", "/api/tournaments/t1/discord/samples", { coach: "Eve" }, {}, deps))!.status).toBe(403);
    expect((await discordApi("POST", "/api/tournaments/t1/discord/samples", { coach: "TOrg" }, {}, deps))!.status).toBe(409); // no webhook
    state.setWebhook("tournament:t2", HOOK);
    expect((await discordApi("POST", "/api/tournaments/t2/discord/samples", { coach: "TOrg" }, {}, deps))!.status).toBe(409); // draft
    state.setWebhook("tournament:t1", HOOK);
    const r = await discordApi("POST", "/api/tournaments/t1/discord/samples", { coach: "TOrg" }, {}, deps);
    expect(r!.body).toEqual({ ok: true, posted: TOURNAMENT_MODE_KEYS.length, failed: 0, total: TOURNAMENT_MODE_KEYS.length });
    expect(titles().every((t) => t.startsWith("[TEST] "))).toBe(true);
    expect(posts.every((p) => p.url === HOOK)).toBe(true);
    const again = await discordApi("POST", "/api/tournaments/t1/discord/samples", { coach: "TOrg" }, {}, deps);
    expect(again!.status).toBe(429);
    expect(again!.headers!["retry-after"]).toBeDefined();
    expect(posts).toHaveLength(TOURNAMENT_MODE_KEYS.length);
  });

  it("a season's samples go to the season's (or the league's) webhook", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK, competitionWebhooks: { "season:season-1": HOOK2 } });
    leagues.updateLeague("lg", (l) => { l.competitionDiscord = { "season:season-1": { events: Object.fromEntries(Object.keys(defaultEvents("league")).map((k) => [k, k === "news"])) } as CompetitionDiscordConfig }; });
    const r = await discordApi("POST", "/api/leagues/lg/seasons/season-1/discord/samples", { coach: "Org" }, {}, { leagues, tournaments, state, poster, samplePauseMs: 0 });
    expect(r!.body).toMatchObject({ posted: 1 });
    expect(posts[0]!.url).toBe(HOOK2);
  });
});

describe("DM queue", () => {
  const msg = (i: number) => ({ key: `action:dm:c${i}`, channel: "discord" as const, message: { to: "", subject: "s", text: "t", html: "", template: "action-dm" }, recipient: { coach: `Coach${i}` } });

  it("bot DMs go out a few per second; email keeps the global rate; the queue survives a restart", async () => {
    let clock = Date.now() + 1000;
    const sent: string[] = [];
    const outbox = new Outbox(join(dir, "mail", "outbox"));
    outbox.enqueue(Array.from({ length: 7 }, (_, i) => msg(i)));
    const worker = new MailWorker({ outbox, transports: { email: { name: "log", send: async () => ({}) }, discord: { name: "discord", send: async (_m, o) => { sent.push(o?.recipient?.coach ?? ""); return {}; } } }, now: () => clock });
    expect(worker.channelRate("discord")).toBe(3);
    expect(worker.channelRate("email")).toBe(10);
    expect(await worker.drain()).toBe(3);
    expect(await worker.drain()).toBe(0); // same second
    const reopened = new Outbox(join(dir, "mail", "outbox")); // a restart replays the journal
    expect(reopened.due(clock).length).toBe(4);
    clock += 1000;
    expect(await new MailWorker({ outbox: reopened, transports: { discord: { name: "discord", send: async () => ({}) } }, now: () => clock }).drain()).toBe(3);
  });

  it("the reach check is inert without the bot token, respects the opt-out, and asks Discord only with the token", async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: string) => {
      calls.push(String(url).replace(/\d{5,}/g, "<id>"));
      if (String(url).includes("/users/@me/guilds")) return new Response(JSON.stringify([{ id: "111111111111111111" }]), { status: 200 });
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const base = { discordUserId: (c: string) => (c === "Ann" ? "999999999999999999" : undefined), dmOn: (c: string) => c !== "Off", dmAvailable: () => false, fetch: fetchStub };
    const inert = createDiscordReach({ ...base });
    expect(await inert.status("Ann")).toEqual({ dm: "inactive", sharesServer: null, inviteUrl: null, accountUrl: "/app/account#notifications" });
    expect(calls).toHaveLength(0);
    expect(await inert.status("Nobody")).toMatchObject({ dm: "unlinked" });
    const live = createDiscordReach({ ...base, token: "test-token-not-real", dmAvailable: () => true, inviteUrl: "https://discord.gg/example" });
    expect(await live.status("Ann")).toEqual({ dm: "on", sharesServer: false, inviteUrl: "https://discord.gg/example", accountUrl: "/app/account#notifications" });
    expect(calls).toEqual(["https://discord.com/api/v10/users/@me/guilds?limit=25", "https://discord.com/api/v10/guilds/<id>/members/<id>"]);
    expect(safeInviteUrl("https://evil.test/x")).toBeNull();
    expect(safeInviteUrl("")).toBeNull();
  });
});
