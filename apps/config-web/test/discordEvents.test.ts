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
import { editFixture } from "../src/leagues/events";
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
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2, cas: 1 }, away: { ...fx("f1").away, score: 0, cas: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-2) })]));
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
    const played = (id: string, h: number, a: number, when: string, extra: Partial<LeagueFixture> = {}) => fx(id, { home: { ...fx(id).home, score: h, cas: 2 }, away: { ...fx(id).away, score: a, cas: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: when, ...extra });
    const s = season("season-1", [played("f1", 3, 0, at(-30)), played("f2", 1, 1, at(-200))]);
    expect(weeklyContent(s, NOW.getTime() - 10 * 3_600_000, NOW.getTime(), "UTC", [])).toBeUndefined();
    const c = weeklyContent(s, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime(), "UTC", [])!;
    expect(c.results).toEqual(["Orcs 3 - 0 Elves"]);
    expect(c.standings[0]).toMatchObject({ rank: 1, name: "Orcs" });
    expect(c.highlights.map((h) => h.name)).toEqual(["Most casualties", "Biggest win"]); // no recorded games: no fouls / scorers / deaths, no bounties ever
  });

  it("decided outcomes are labelled administrative with no score; organiser-typed scores are labelled edited; recorded and coach results are unlabelled", () => {
    const sc = (h: number | null, a: number | null, cas: number | null = null) => ({ home: { ...fx("x").home, score: h, cas }, away: { ...fx("x").away, score: a, cas } });
    const recorded = fx("rec", { ...sc(2, 1, 3), tabletop: { revision: 1, opId: "op" }, finishedAt: at(-30) });
    const typed = fx("typed", { ...sc(5, 0, 9), finishedAt: at(-29), round: 2 });
    const forfeit = fx("ff", { ...sc(0, 0), away: { ...fx("x").away, score: 0, cas: null, conceded: true }, finishedAt: at(-28) });
    const forfeitAway = fx("ffa", { home: { ...fx("x").home, score: 0, cas: null, conceded: true }, away: { ...fx("x").away, score: 0, cas: null }, finishedAt: at(-28) });
    const deadlineAuto = fx("dl", { ...sc(0, 0), home: { ...fx("x").home, score: 0, cas: null, conceded: true }, away: { ...fx("x").away, score: 0, cas: null, conceded: true }, deadlineOutcome: { outcome: "both-lose", auto: true, at: at(-27) } });
    const deadlineOrg = fx("dlo", { home: { ...fx("x").home, score: 0, cas: null, conceded: true }, away: { ...fx("x").away, score: 0, cas: null, conceded: true }, deadlineOutcome: { outcome: "both-lose", by: "Org", at: at(-26) } });
    const overrideWin = fx("ow", { ...sc(8, 1), tabletop: { revision: 1, opId: "op2" }, finishedAt: at(-300), resultEdit: { by: "Org", at: at(-25) } });
    const overrideDraw = fx("od", { ...sc(1, 1), finishedAt: at(-300), resultEdit: { at: at(-24) } });
    const overrideZero = fx("oz", { ...sc(0, 0), finishedAt: at(-300), resultEdit: { at: at(-22) } });
    const firstTyped = fx("ft", { ...sc(6, 2), finishedAt: at(-21), resultEdit: { by: "Org", at: at(-21) } });
    const noResult = fx("nr", { deadlineOutcome: { outcome: "no-result", by: "Org", at: at(-23) } });
    const undated = fx("und", { ...sc(4, 4) });
    const s = season("season-1", [recorded, typed, forfeit, forfeitAway, deadlineAuto, deadlineOrg, overrideWin, overrideDraw, overrideZero, firstTyped, noResult, undated]);
    const c = weeklyContent(s, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime(), "UTC", [])!;
    expect(c.results).toEqual([
      "Orcs 2 - 1 Elves", "Orcs 5 - 0 Elves",
      "Admin win: Orcs over Elves", "Admin win: Elves over Orcs",
      "Admin loss: Orcs and Elves (both teams)", "Admin loss: Orcs and Elves (both teams)",
      "Orcs 8 - 1 Elves (edited)", "Orcs 1 - 1 Elves (edited)", "Orcs 0 - 0 Elves (edited)", "Orcs 6 - 2 Elves (edited)",
    ]);
    // highlights: casualties from the recorded fixture only (3, not the typed 9); an edited score counts for biggest win (8-1)
    const h = Object.fromEntries(c.highlights.map((x) => [x.name, x.value]));
    expect(h["Most casualties"]).toBe("Orcs: 3");
    expect(h["Biggest win"]).toBe("Orcs 8 - 1 Elves (edited)");
    // standings are unchanged by the digest change: they still count every result
    expect(c.standings.length).toBeGreaterThan(0);
  });

  it("a league with only typed results posts its digest through the cleaned sender", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.timeZone = "UTC"; });
    leagues.putSeason(season("season-1", [fx("typed", { home: { ...fx("typed").home, score: 3, cas: 1 }, away: { ...fx("typed").away, score: 1, cas: 0 }, finishedAt: at(-3) })]));
    const observer = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster, observer };
    const preview = await discordApi("GET", "/api/leagues/lg/discord/weekly-digest", { coach: "Org" }, undefined, deps);
    expect(preview!.body).not.toMatchObject({ preview: null });
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, deps))!.status).toBe(200);
    expect(titles()).toEqual(["Test League: Weekly Digest"]);
    expect(JSON.stringify(posts[0]!.payload)).toContain("Orcs 3 - 1 Elves");
    // no individual result post for a typed score
    expect(titles().filter((t) => t.endsWith("result"))).toEqual([]);
  });

  it("an organiser's first or changed score is marked edited; an unchanged save and a recorded result are not", async () => {
    leagues.putSeason(season("season-1", [fx("a"), fx("b")]));
    const lg = leagues.league("lg")!;
    const deps = { store: leagues, now: () => NOW } as never;
    const enter = (id: string, home: number) => editFixture(lg, "season-1", id, { coach: "Org", admin: false } as never, { result: { home, away: 0, homeCas: null, awayCas: null } }, deps);
    await enter("a", 2);
    expect(leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "a")!.resultEdit).toMatchObject({ by: "Org" });
    await enter("a", 3);
    expect(leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "a")!.resultEdit).toMatchObject({ by: "Org" });
    // an unchanged save neither refreshes nor creates the mark
    const marked = leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "a")!.resultEdit!;
    const later = { store: leagues, now: () => new Date(NOW.getTime() + 3_600_000) } as never;
    await editFixture(lg, "season-1", "a", { coach: "Org2", admin: false } as never, { result: { home: 3, away: 0, homeCas: null, awayCas: null } }, later);
    expect(leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "a")!.resultEdit).toEqual(marked);
    // a recorded result (coach / recorder path) carries no mark, and an unchanged organiser save does not add one
    const rec = leagues.season("lg", "season-1")!;
    Object.assign(rec.fixtures.find((f) => f.id === "b")!, { finishedAt: NOW.toISOString(), tabletop: { revision: 1, opId: "op" } });
    Object.assign(rec.fixtures.find((f) => f.id === "b")!.home, { score: 1, cas: null });
    Object.assign(rec.fixtures.find((f) => f.id === "b")!.away, { score: 0, cas: null });
    leagues.putSeason(rec);
    await editFixture(lg, "season-1", "b", { coach: "Org", admin: false } as never, { result: { home: 1, away: 0, homeCas: null, awayCas: null } }, later);
    expect(leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "b")!.resultEdit).toBeUndefined();
    // the marker never reaches a season read
    const { seasonForViewer } = await import("../src/leagues/api");
    expect(JSON.stringify(seasonForViewer(lg, leagues.season("lg", "season-1")!, undefined))).not.toContain("resultEdit");
    expect(JSON.stringify(seasonForViewer(lg, leagues.season("lg", "season-1")!, { coach: "Org", admin: true } as never))).not.toContain("resultEdit");
    await editFixture(lg, "season-1", "a", { coach: "Org", admin: false } as never, { result: null }, deps);
    expect(leagues.season("lg", "season-1")!.fixtures.find((f) => f.id === "a")!.resultEdit).toBeUndefined();
  });

  it("a score typed over a concession replaces it: standings and digest agree, and the marker never reaches a fixture read", async () => {
    const conceded = fx("c", { home: { ...fx("x").home, score: 0, cas: null, conceded: true }, away: { ...fx("x").away, score: 0, cas: null }, finishedAt: at(-300) });
    leagues.putSeason(season("season-1", [conceded, fx("d")]));
    const lg = leagues.league("lg")!;
    const { deriveStandings } = await import("../src/leagues/standings");
    const { fixtureOutcome } = await import("../src/leagues/identity");
    const { adminResult } = await import("../src/discord/weekly");
    // before: the concession is administrative, and standings give the away side the win
    expect(adminResult(leagues.season("lg", "season-1")!.fixtures[0]!)).toMatchObject({ kind: "win", winner: "away" });
    const deps = { store: leagues, now: () => NOW } as never;
    await editFixture(lg, "season-1", "c", { coach: "Org", admin: false } as never, { result: { home: 7, away: 0, homeCas: null, awayCas: null } }, deps);
    const s = leagues.season("lg", "season-1")!;
    const f = s.fixtures[0]!;
    expect(f.home.conceded || f.away.conceded).toBe(false);
    expect(fixtureOutcome(f)).toMatchObject({ home: "win", away: "loss" });
    expect(adminResult(f)).toBeUndefined();
    const row = (team: string) => deriveStandings(s).flatMap((p) => p.standings).find((r) => r.team === team)!;
    expect(row("Orcs").points).toBeGreaterThan(row("Elves").points);
    const c = weeklyContent(s, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime(), "UTC", [])!;
    expect(c.results).toEqual(["Orcs 7 - 0 Elves (edited)"]);
    expect(c.highlights.find((h) => h.name === "Biggest win")!.value).toBe("Orcs 7 - 0 Elves (edited)");
  });

  it("no public fixture read carries resultEdit: the single fixture route, the editor response, the season read", async () => {
    const edited = fx("e", { home: { ...fx("x").home, score: 2, cas: null }, away: { ...fx("x").away, score: 1, cas: null }, finishedAt: at(-10), resultEdit: { by: "Org", at: at(-5) }, fork: { status: "idle", teams: {}, log: [] } as never });
    leagues.putSeason(season("season-1", [edited]));
    const lg = leagues.league("lg")!;
    const { leagueApi, seasonForViewer } = await import("../src/leagues/api");
    const deps = { store: leagues, now: () => NOW, readBody: async () => Buffer.from("") } as never;
    for (const who of [undefined, { coach: "Bob", admin: false }, { coach: "Org", admin: true }] as const) {
      const one = await leagueApi("GET", "/api/leagues/lg/seasons/season-1/fixtures/e", new URLSearchParams(), who as never, deps);
      expect(one?.status).toBe(200);
      expect(JSON.stringify(one!.body)).not.toContain("resultEdit");
      expect(JSON.stringify(one!.body)).not.toContain("\"Org\"");
      expect(JSON.stringify(seasonForViewer(lg, leagues.season("lg", "season-1")!, who as never))).not.toContain("resultEdit");
    }
    const patched = await editFixture(lg, "season-1", "e", { coach: "Org", admin: true } as never, { result: { home: 5, away: 1, homeCas: null, awayCas: null } }, deps);
    expect(JSON.stringify(patched.body)).not.toContain("resultEdit");
  });

  it("the observer posts the digest at the slot once (the run survives a restart via the ledger), and never for a draft", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.timeZone = "UTC"; l.weeklyDigest = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 }; });
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2, cas: 1 }, away: { ...fx("f1").away, score: 1, cas: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-5) })]));
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
    expect(empty!.body).toMatchObject({ preview: null, reason: "No results were entered in this period, so the digest is skipped." });
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, deps))!.status).toBe(409);
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Eve" }, {}, deps))!.status).toBe(403);
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2 }, away: { ...fx("f1").away, score: 1 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-5) })]));
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

describe("league time zone", () => {
  it("leagueTimeZone reads the IANA zone, else UTC; General saves it and refuses an unknown zone", async () => {
    const { leagueTimeZone, leagueTimeZoneSet, isTimeZone } = await import("../src/leagues/timeZone");
    const { leagueApi } = await import("../src/leagues/api");
    expect(leagueTimeZone(leagues.league("lg"))).toBe("UTC");
    expect(leagueTimeZoneSet(leagues.league("lg")!)).toBe(false);
    expect(isTimeZone("America/New_York")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    const call = (body: unknown) => leagueApi("PATCH", "/api/leagues/lg/settings", new URLSearchParams(), { coach: "Org", admin: false }, { store: leagues, readBody: async () => Buffer.from(JSON.stringify(body)) } as never);
    const view = await leagueApi("GET", "/api/leagues/lg/settings", new URLSearchParams(), { coach: "Org", admin: false }, { store: leagues } as never);
    const settings = (view!.body as { settings: { revision: number; information: { timeZone: string | null } } }).settings;
    expect(settings.information.timeZone).toBeNull();
    const bad = await call({ revision: settings.revision, information: { timeZone: "Mars/Olympus" } });
    expect(bad!.body).toMatchObject({ field: "timeZone" });
    const ok = await call({ revision: settings.revision, information: { timeZone: "Europe/London" } });
    expect((ok!.body as { settings: { information: { timeZone: string } } }).settings.information.timeZone).toBe("Europe/London");
    expect(leagueTimeZone(leagues.league("lg"))).toBe("Europe/London");
    // the Weekly Digest reads it
    const g = await discordApi("GET", "/api/leagues/lg/discord", { coach: "Org" }, undefined, { leagues, tournaments, state });
    expect((g!.body as { discord: { weekly: { timeZone: string; timeZoneSet: boolean } } }).discord.weekly).toMatchObject({ timeZone: "Europe/London", timeZoneSet: true });
  });

  it("the wizard creates a league with the organiser's browser time zone", async () => {
    const { leagueApi } = await import("../src/leagues/api");
    const r = await leagueApi("POST", "/api/leagues", new URLSearchParams(), { coach: "Org", admin: false, organizer: true } as never, { store: leagues, readBody: async () => Buffer.from(JSON.stringify({ name: "Zone League", slug: "zone-league", timeZone: "America/Chicago" })) } as never);
    expect(r!.status).toBe(201);
    expect(leagues.league("zone-league")!.timeZone).toBe("America/Chicago");
    expect((r!.body as { draft: { identity: { timeZone: string } } }).draft.identity.timeZone).toBe("America/Chicago");
  });
});

describe("review fixes", () => {
  it("[1] an unreadable tournaments store never rejects tick(); leagues still run", async () => {
    const log: string[] = [];
    const broken = { ...tournaments, tournaments: () => { throw new Error("bad json"); }, entrants: () => [], rounds: () => [], matches: () => [], tournament: () => undefined } as unknown as TournamentStore;
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    const obs = new DiscordObserver({ leagues, tournaments: broken, state, poster, now: () => NOW, log: (l) => log.push(l) });
    await expect(obs.tick()).resolves.toBeTypeOf("number");
    expect(log.some((l) => l.includes("tournaments unreadable"))).toBe(true);
    expect(state.entry("league:lg")?.baselineAt).toBeDefined();
  });

  describe("[2][3][4] coach's comments in every match answer", () => {
    let repo: FileTabletopRepository;
    const managers = new Set(["Org"]);
    const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({ schema: 1, name, treasury: 50_000, dedicatedFans: 2, players: ["1", "2"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })) });
    const deps = (): TabletopApiDeps => ({
      repo, results: new TournamentResultStore(join(dir, "res2")), loadTeamFile: (c) => (c === "Ann" ? mkTeam("Orcs", "a") : mkTeam("Elves", "b")),
      isBanned: () => false, drawSeats: () => false, isOrganizer: (c) => c === "RecOrg" || c === "Org", managesMatch: (c) => managers.has(c), now: () => NOW,
    });
    const as = (coach: string, method: string, path: string, body?: unknown) => tabletopApi(method, path, { coach, method: "discord" }, body, deps()) as Promise<TabletopResult>;
    let n = 100;
    const E = (type: string, team: string, player?: string) => ({ id: `evt-${String(++n).padStart(8, "0")}`, type, team, player, payload: {} });
    beforeEach(() => { repo = new FileTabletopRepository(join(dir, "tt2")); });
    async function hiddenMatch(): Promise<string> {
      const r = await as("Ann", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Ann", teamSaveId: "s1" }, away: { coach: "Bob", teamSaveId: "s2" }, postMatch: "none" });
      const id = (r.body as { match: { id: string } }).match.id;
      await as("Ann", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1")] });
      await as("Ann", "POST", `/api/tabletop/matches/${id}/submit`);
      await as("Bob", "POST", `/api/tabletop/matches/${id}/comment`, { text: "secret words" });
      expect((await as("Org", "POST", `/api/tabletop/matches/${id}/comment/hide`, { side: "away", hidden: true })).status).toBe(200);
      return id;
    }

    it("[2] action answers (confirm) never carry a hidden comment to the opponent", async () => {
      const id = await hiddenMatch();
      const c = await as("Ann", "POST", `/api/tabletop/matches/${id}/confirm`);
      expect(c.status).toBe(200);
      expect(JSON.stringify(c.body)).not.toContain("secret words");
      expect(JSON.stringify((await as("Ann", "POST", `/api/tabletop/matches/${id}/comment`, { text: "gg" })).body)).not.toContain("secret words");
    });

    it("[3] a recorder organiser who does not manage this competition does not see a hidden comment", async () => {
      const id = await hiddenMatch();
      expect(JSON.stringify((await as("RecOrg", "GET", `/api/tabletop/matches/${id}`)).body)).not.toContain("secret words");
      expect(JSON.stringify((await as("Org", "GET", `/api/tabletop/matches/${id}`)).body)).toContain("secret words");
    });

    it("[4] emptying a hidden comment and posting again keeps it hidden until an organiser unhides it", async () => {
      const id = await hiddenMatch();
      await as("Bob", "POST", `/api/tabletop/matches/${id}/comment`, { text: "" });
      await as("Bob", "POST", `/api/tabletop/matches/${id}/comment`, { text: "new words" });
      const m = (await repo.getMatch(id))!;
      expect(m.comments!.away).toMatchObject({ text: "new words", hidden: { by: "Org" } });
      expect(JSON.stringify((await as("Ann", "GET", `/api/tabletop/matches/${id}`)).body)).not.toContain("new words");
      await as("Org", "POST", `/api/tabletop/matches/${id}/comment/hide`, { side: "away", hidden: false });
      expect(JSON.stringify((await as("Ann", "GET", `/api/tabletop/matches/${id}`)).body)).toContain("new words");
    });
  });

  it("[5] past the ledger cap only markers no longer live are dropped; live history never replays", () => {
    const live = Array.from({ length: 4100 }, (_, i) => `entrant:${i}`);
    state.mark("tournament:big", ["gone:1", "gone:2"], at(-10), true);
    state.mark("tournament:big", live, at(0), true, new Set(live));
    expect(state.has("tournament:big", "gone:1")).toBe(false);
    expect(state.mark("tournament:big", live, at(1), true, new Set(live))).toEqual([]);
  });

  it("[6] a result reported just before the first look is baselined, not posted later", async () => {
    state.setWebhook("tournament:t1", HOOK);
    seedTournaments({ matches: { M1: smatch("M1", { result: { homeScore: 2, awayScore: 1, reportedAt: at(0) } }) } });
    let clock = NOW.getTime();
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => new Date(clock) });
    await obs.tick();
    clock += RESULT_SETTLE_MS * 2;
    await obs.tick();
    expect(posts).toHaveLength(0);
  });

  it("[7] an organiser's typed-in tournament score is marked manual and never announced", async () => {
    const { tournamentApi } = await import("../src/tournaments/api");
    seedTournaments({ matches: { M1: smatch("M1") } });
    state.setWebhook("tournament:t1", HOOK);
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => new Date(Date.now() + 10 * 60_000) });
    await obs.tick();
    const r = await tournamentApi("PATCH", "/api/scheduled-matches/M1/result", new URLSearchParams(), { coach: "TOrg", organizer: true, admin: false } as never, { revision: 1, homeScore: 3, awayScore: 0 }, { store: tournaments } as never);
    expect(r!.status).toBe(200);
    expect(tournaments.match("M1")!.result!.manual).toBe(true);
    await obs.tick();
    expect(titles().filter((t) => t.includes("result"))).toEqual([]);
  });

  it("[8] after-round digests switched back on never replay rounds finished meanwhile", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    const played = (id: string, round: number) => fx(id, { round, home: { ...fx(id).home, score: 1 }, away: { ...fx(id).away, score: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-1) });
    leagues.updateLeague("lg", (l) => { l.weeklyDigest = { enabled: false, trigger: "afterRound", day: 0, time: "10:00", everyWeeks: 1 }; });
    leagues.putSeason(season("season-1", [played("f1", 1)]));
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    leagues.putSeason(season("season-1", [played("f1", 1), played("f2", 2)]));
    await obs.tick(); // round 2 completes while disabled
    leagues.updateLeague("lg", (l) => { l.weeklyDigest = { ...l.weeklyDigest!, enabled: true }; });
    await obs.tick();
    expect(titles().filter((t) => t.endsWith("Weekly Digest"))).toEqual([]);
  });

  it("[9] Post now moves the period on: the next preview starts after it", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2 }, away: { ...fx("f1").away, score: 1 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-5) })]));
    const observer = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    const deps: DiscordApiDeps = { leagues, tournaments, state, poster, observer };
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, deps))!.status).toBe(200);
    expect(state.weekly("lg").lastRun).toBe(NOW.toISOString());
    const after = await discordApi("GET", "/api/leagues/lg/discord/weekly-digest", { coach: "Org" }, undefined, deps);
    expect((after!.body as { preview: unknown }).preview).toBeNull();
  });

  it("[10] highlights read only the period's games", async () => {
    const seen: string[][] = [];
    leagues.putSeason(season("season-1", [
      fx("old", { home: { ...fx("old").home, score: 5 }, away: { ...fx("old").away, score: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-24 * 30) }),
      fx("new", { home: { ...fx("new").home, score: 1 }, away: { ...fx("new").away, score: 0 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-5) }),
    ]));
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW, gamesFor: async (_l, _s, fs) => { seen.push(fs.map((f) => f.id)); return []; } });
    await obs.digestFor(leagues.league("lg")!, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime());
    expect(seen).toEqual([["new"]]);
  });

  it("[11][12] wall-clock slots across New York DST: the autumn week is 169 hours; a missing 02:30 moves forward to 03:30", async () => {
    const { previousSlot, zonedInstant } = await import("../src/discord/weekly");
    const s = weeklyOf({ day: 0, time: "10:00", everyWeeks: 1 });
    const slot = lastSlot(s, new Date("2026-11-01T16:00:00.000Z"), "America/New_York");
    const prev = previousSlot(s, slot, "America/New_York");
    expect(prev.toISOString()).toBe("2026-10-25T14:00:00.000Z");
    expect((slot.getTime() - prev.getTime()) / 3_600_000).toBe(169);
    expect(zonedInstant(2026, 3, 8, 2, 30, "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z"); // 03:30 EDT
    expect(zonedInstant(2026, 11, 1, 1, 30, "America/New_York").toISOString()).toBe("2026-11-01T05:30:00.000Z"); // the first 01:30
    const spring = weeklyOf({ day: 0, time: "02:30", everyWeeks: 1 });
    expect(lastSlot(spring, new Date("2026-03-08T12:00:00.000Z"), "America/New_York").toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("[13] user-written names in round labels and test posts are starred and escaped", async () => {
    const { pairingsPost, cleanPayload } = await import("../src/discord/posts");
    expect(JSON.stringify(pairingsPost("Cup", `Season ${LISTED} Round 1`, [{ home: "A", away: "B" }]))).not.toContain(LISTED);
    expect(JSON.stringify(cleanPayload({ username: "x", embeds: [{ title: `t ${LISTED}`, description: LISTED, color: 1, footer: { text: LISTED }, fields: [{ name: LISTED, value: LISTED }] }], allowed_mentions: { parse: [] } }))).not.toContain(LISTED);
    seedTournaments({ t: { name: `The ${LISTED} Cup` } });
    state.setWebhook("tournament:t1", HOOK);
    expect((await discordApi("POST", "/api/tournaments/t1/discord/test", { coach: "TOrg" }, {}, { leagues, tournaments, state, poster }))!.status).toBe(200);
    expect(JSON.stringify(posts.at(-1)!.payload)).not.toContain(LISTED);
  });

  it("[14] zero-width characters, separators and look-alike letters do not get past the filter; the original span is starred", () => {
    const zw = [...LISTED].join(String.fromCharCode(0x200b));
    expect(starProfanity(`oh ${zw} no`)).toBe("oh *** no");
    expect(starProfanity(`oh ${[...LISTED].join(".")} no`)).toBe("oh *** no");
    expect(starProfanity(`oh ${[...LISTED].join(" ")} no`)).toBe("oh *** no");
    expect(containsProfanity(LISTED.replace("i", String.fromCharCode(0x0456)))).toBe(true);
    expect(containsProfanity([...LISTED].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(""))).toBe(true);
    expect(starProfanity("e.g. a good game, co-op play")).toBe("e.g. a good game, co-op play");
  });

  it("[15] fork digests follow the public player-lines policy", async () => {
    const { setPublicPlayerNames } = await import("../src/discord/games");
    const fixture = { ...fx("f2"), fork: { result: { gameId: "g9", source: "full", appliedAt: at(0), home: { score: 1, cas: 0, conceded: false, winnings: 0, lines: [{ forkPlayerId: "1", name: "Grukk", td: 1, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, injuries: [] }] }, away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [] } } } } as never;
    setPublicPlayerNames(false);
    try { expect(JSON.stringify(forkGame(fixture))).not.toContain("Grukk"); } finally { setPublicPlayerNames(true); }
    expect(JSON.stringify(forkGame(fixture))).toContain("Grukk");
  });
});

describe("re-review fixes", () => {
  it("[1] a listed word joined to another word by punctuation is still starred (the joined form OR a piece)", () => {
    expect(starProfanity(`${LISTED}-game`)).toBe("***-game");
    expect(starProfanity(`what ${LISTED}.Next time`)).toBe("what ***.Next time");
    expect(containsProfanity(`${LISTED}_play`)).toBe(true);
    expect(starProfanity("pass-hit play, set.up")).toBe("pass-hit play, set.up");
  });

  it("[2] an organiser-entered score is left out of the round summary; hand-entered league results are in the digest", async () => {
    state.setWebhook("tournament:t1", HOOK);
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    seedTournaments({
      entrants: { e1: entrant("e1", "Ann"), e2: entrant("e2", "Bob"), e3: entrant("e3", "Cat"), e4: entrant("e4", "Dee") },
      rounds: { r1: { id: "r1", tournamentId: "t1", number: 1, status: "completed", scheduledMatchIds: ["M1", "M2"], createdAt: at(-3) } },
      matches: {
        M1: smatch("M1", { status: "completed", result: { homeScore: 2, awayScore: 1, reportedAt: at(-2) } }),
        M2: smatch("M2", { home: side("e3", "Cat"), away: side("e4", "Dee"), status: "completed", result: { homeScore: 7, awayScore: 0, reportedAt: at(-2), manual: true } }),
      },
    });
    await obs.tick();
    const summary = posts.find((p) => p.payload.embeds[0]!.title.endsWith("Round 1 summary"))!;
    expect(summary.payload.embeds[0]!.description).toContain("Ann 2 - 1 Bob");
    expect(summary.payload.embeds[0]!.description).not.toContain("7 - 0");
    expect(titles().filter((t) => t === "Autumn Open: result")).toHaveLength(1); // M1 only
    // league: a typed score IS in the Weekly Digest's results (a normal result, no game record behind it)
    const typed = fx("typed", { home: { ...fx("typed").home, score: 9 }, away: { ...fx("typed").away, score: 0 }, finishedAt: at(-3) });
    leagues.putSeason(season("season-1", [typed]));
    const d = await obs.digestFor(leagues.league("lg")!, NOW.getTime() - 7 * 24 * 3_600_000, NOW.getTime());
    expect(d.payload!.embeds[0]!.fields!.find((f) => f.name.startsWith("Results"))!.value).toBe("Orcs 9 - 0 Elves");
  });

  it("[3] redraft posts and the league test post go through the cleaned sender", async () => {
    const { postLeagueEvent } = await import("../src/leagues/events");
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.name = `The ${LISTED} League`; });
    await postLeagueEvent(leagues, leagues.league("lg")!, "milestones", { username: "x", embeds: [{ title: `${LISTED} redraft`, description: LISTED, color: 1 }], allowed_mentions: { parse: [] } }, poster);
    const { leagueApi } = await import("../src/leagues/api");
    await leagueApi("POST", "/api/leagues/lg/discord/test", new URLSearchParams(), { coach: "Org", admin: false }, { store: leagues, postWebhook: poster, readBody: async () => Buffer.from("{}") } as never);
    expect(posts).toHaveLength(2);
    for (const p of posts) expect(JSON.stringify(p.payload)).not.toContain(LISTED);
  });

  it("[4] Post now claims the period before it sends: a tick while Discord answers posts nothing; a failed send gives it back", async () => {
    leagues.setSecrets("lg", { discordWebhookUrl: HOOK });
    leagues.updateLeague("lg", (l) => { l.timeZone = "UTC"; l.weeklyDigest = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 }; });
    leagues.putSeason(season("season-1", [fx("f1", { home: { ...fx("f1").home, score: 2 }, away: { ...fx("f1").away, score: 1 }, tabletop: { revision: 1, opId: "op" }, finishedAt: at(-5) })]));
    let release!: (v: { ok: boolean; status: number }) => void;
    const slow = (url: string, payload: DiscordPayload) => { posts.push({ url, payload }); return new Promise<{ ok: boolean; status: number }>((r) => { release = r; }); };
    const observer = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    const pending = discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, { leagues, tournaments, state, poster: slow, observer });
    await new Promise((r) => setTimeout(r, 5));
    await observer.tick(); // the scheduled slot (today 10:00) is due, but the period is claimed
    expect(titles().filter((t) => t.endsWith("Weekly Digest"))).toHaveLength(1);
    release({ ok: true, status: 204 });
    expect((await pending)!.status).toBe(200);
    // a failed send puts the previous run back
    resetDiscordRateLimits();
    state.setWeekly("lg", { lastRun: at(-48) });
    const failing = async () => ({ ok: false, status: 500 });
    expect((await discordApi("POST", "/api/leagues/lg/discord/weekly-digest/post", { coach: "Org" }, {}, { leagues, tournaments, state, poster: failing, observer }))!.status).toBe(502);
    expect(state.weekly("lg").lastRun).toBe(at(-48));
  });
});

describe("tournament times on Discord (owner 11-04: instants, each reader's own zone)", () => {
  it("registration closing and check-in open carry Discord's <t:epoch:F> timestamps, never a zone-less clock time", async () => {
    state.setWebhook("tournament:t1", HOOK);
    const obs = new DiscordObserver({ leagues, tournaments, state, poster, now: () => NOW });
    await obs.tick();
    const closes = at(12);
    const start = at(20);
    seedTournaments({ t: { startsAt: start, deadlines: { registration: closes }, registration: { approval: "auto", waitlist: true, rosterLater: true, checkIn: { self: true, opensAt: at(-1) } } } });
    await obs.tick();
    const text = (title: string) => posts.find((p) => p.payload.embeds[0]!.title?.startsWith(title))?.payload.embeds[0]!.description ?? "";
    const epoch = (iso: string) => Math.floor(Date.parse(iso) / 1000);
    expect(text("Autumn Open: Registration closing")).toBe(`Registration closes <t:${epoch(closes)}:F> (<t:${epoch(closes)}:R>).`);
    expect(text("Autumn Open: Check-in open")).toBe(`Check-in is open until <t:${epoch(start)}:F>: check in on the tournament page.`);
    expect(posts.map((p) => p.payload.embeds[0]!.description).join(" ")).not.toMatch(/UTC|\b\d{2}:\d{2}\b/);
  });
});
