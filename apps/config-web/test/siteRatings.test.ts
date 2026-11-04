import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { glickoUpdate } from "../src/coachGlicko.js";
import {
  computeSiteRatings, DAY_MS, defaultRating, inflateRd, PROVISIONAL_GAMES, SITE_GLICKO, type RatedGame,
} from "../src/ratings/glicko.js";
import { leagueFixtureVerdict, tournamentMatchVerdict } from "../src/ratings/rules.js";
import { collectRatedGames, forkGames, leagueGames, tournamentGameTime, tournamentGames, type LeagueSource } from "../src/ratings/sources.js";
import { createSiteRatings, SiteRatingsService } from "../src/ratings/service.js";
import { LeagueStore } from "../src/leagues/store.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { ratingsOf } from "../src/fixtureLobby/league.js";
import { ratingsRoute } from "../src/ratings/api.js";
import { ratingsStateFile, readRatingsState } from "../src/ratings/state.js";
import { resetRatings } from "../scripts/reset-ratings.js";
import { requireSession } from "../src/auth/requireSession.js";
import { collectExport, STORE_COLLECTORS } from "../src/privacy/collectors.js";
import { rankRows, replayLadder } from "../src/leagues/ladder.js";
import { mergeSeason, snapshotOf } from "../src/leagues/tourplayMerge.js";
import type { IdentityStore } from "../src/auth/identitiesStore.js";
import type { LeagueFixture, LeagueRecord, SeasonRecord } from "../src/leagues/types.js";
import type { StoredTournamentResult } from "../src/tournamentResults.js";
import type { ScheduledMatchRecord, TournamentDataFileV4 } from "../src/tournaments/types.js";
import { coachCardLines, ratingText } from "../spa/src/leagues/fixtureSummary";
import { emptyLine, leaderboardUrl, raceRatingFor, readFilters, writeFilters } from "../spa/src/ratings/ratings";

// Site-wide Glicko-2 ratings (owner round 2, 11-04): the maths against Glickman's worked example, what counts and what
// never does, idempotency on edits, re-imports and re-syncs, per-race ratings, provisional, the go-live reset and the
// leaderboard's privacy rules. Fake coaches only.

const T0 = Date.UTC(2026, 10, 2, 12); // a Monday, noon UTC
const iso = (day: number, hour = 0): string => new Date(T0 + day * DAY_MS + hour * 3_600_000).toISOString();

// ---- fixtures -----------------------------------------------------------------------------------------------------

function side(coach: string, score: number | null, over: Partial<LeagueFixture["home"]> = {}): LeagueFixture["home"] {
  return { team: `${coach} team`, teamId: `${coach.toLowerCase()}-team`, coach, coachId: coach, race: "Orc", score, cas: 0, conceded: false, ...over };
}
function fixture(id: string, home: string, away: string, hs: number | null, as: number | null, day = 0, over: Partial<LeagueFixture> = {}): LeagueFixture {
  return {
    id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
    home: side(home, hs), away: side(away, as), suspended: false, finishedAt: iso(day), ...over,
  } as LeagueFixture;
}
function season(id: string, fixtures: LeagueFixture[], over: Partial<SeasonRecord> = {}): SeasonRecord {
  return { id, leagueId: "harbour", number: 1, name: "Season 1", fixtures, teams: [], phases: [], importedAt: iso(-10), status: "active", source: "manual", ...over } as unknown as SeasonRecord;
}
function league(id: string, over: Partial<LeagueRecord> = {}): LeagueRecord {
  return { id, name: id, organisers: ["Org"], createdAt: iso(-30), updatedAt: iso(-30), ...over } as LeagueRecord;
}
const src = (l: LeagueRecord, ...seasons: SeasonRecord[]): LeagueSource => ({ league: l, competitions: seasons.map((s) => ({ ...s, leagueId: l.id })) });

function forkRow(gameId: string, home: string, away: string, hs: number, as: number, day = 0, over: Partial<StoredTournamentResult> = {}): StoredTournamentResult {
  const team = (teamId: string, score: number) => ({ teamId, score, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] });
  return {
    gameId, pulledAt: iso(day, 1), playedAt: iso(day),
    home: { teamId: `${home}-ft`, teamName: home, coach: home }, away: { teamId: `${away}-ft`, teamName: away, coach: away },
    teams: [team(`${home}-ft`, hs), team(`${away}-ft`, as)], ...over,
  } as StoredTournamentResult;
}

function emptyTournaments(): TournamentDataFileV4 {
  return { version: 4, tournaments: {}, entrants: {}, rounds: {}, standings: {}, scheduledMatches: {}, waitingPresence: {} } as TournamentDataFileV4;
}
function tMatch(id: string, home: string, away: string | null, hs: number, as: number, day = 0, over: Partial<ScheduledMatchRecord> = {}): ScheduledMatchRecord {
  const s = (c: string) => ({ entrantId: `e-${c}`, coach: { coachId: c, ffbCoachId: c, verifiedAt: iso(-5) }, teamId: `t-${c}` });
  return {
    id, tournamentId: "cup", roundId: "r1", roundNumber: 1, home: s(home), ...(away ? { away: s(away) } : {}), status: "completed", revision: 1,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore: hs, awayScore: as, reportedAt: iso(day) }, createdAt: iso(-1), updatedAt: iso(day), ...over,
  } as ScheduledMatchRecord;
}
function tournaments(matches: ScheduledMatchRecord[], over: Record<string, unknown> = {}, races: Record<string, string> = {}): TournamentDataFileV4 {
  const data = emptyTournaments();
  data.tournaments.cup = { id: "cup", name: "Cup", status: "active", format: "swiss", packageName: "p", ...over } as never;
  for (const m of matches) data.scheduledMatches[m.id] = m;
  for (const [coach, race] of Object.entries(races)) data.entrants[`e-${coach}`] = { id: `e-${coach}`, tournamentId: "cup", submission: { race } } as never;
  return data;
}

const game = (key: string, home: string, away: string, homeScore: 0 | 0.5 | 1, day = 0, races: [string?, string?] = []): RatedGame => ({
  key, source: "fork", at: T0 + day * DAY_MS,
  home: { coach: home, ...(races[0] ? { race: races[0] } : {}) }, away: { coach: away, ...(races[1] ? { race: races[1] } : {}) }, homeScore,
});

// ---- the maths ------------------------------------------------------------------------------------------------------

describe("Glicko-2 maths", () => {
  it("matches Glickman's worked example (r 1500, RD 200 vs 1400/30 W, 1550/100 L, 1700/300 L, tau 0.5)", () => {
    const out = glickoUpdate({ r: 1500, rd: 200, sigma: 0.06 }, [
      { r: 1400, rd: 30, score: 1 }, { r: 1550, rd: 100, score: 0 }, { r: 1700, rd: 300, score: 0 },
    ], SITE_GLICKO);
    expect(out.r).toBeCloseTo(1464.06, 1);
    expect(out.rd).toBeCloseTo(151.52, 1);
    expect(out.sigma).toBeCloseTo(0.05999, 4); // the paper rounds 0.059996 to 0.05999
  });

  it("uses the standard defaults: 1500, RD 350, volatility 0.06, tau 0.5", () => {
    expect(SITE_GLICKO).toMatchObject({ rating: 1500, rd: 350, sigma: 0.06, tau: 0.5 });
    expect(defaultRating()).toMatchObject({ rating: 1500, rd: 350, volatility: 0.06, games: 0, provisional: true });
  });

  it("a day is one rating period: the same-day games are rated together, whatever their order", () => {
    const games = [game("a", "ann", "bob", 1, 0), game("b", "ann", "cat", 0, 0), game("c", "bob", "cat", 0.5, 0)];
    const one = computeSiteRatings(games);
    const two = computeSiteRatings([...games].reverse().map((g, i) => ({ ...g, at: g.at + i * 1000 })));
    expect(two.overall.get("ann")!.rating).toBeCloseTo(one.overall.get("ann")!.rating, 9);
    // the same as one Glicko-2 update of ann from the defaults against bob and cat at their defaults
    const ann = glickoUpdate({ r: 1500, rd: 350, sigma: 0.06 }, [{ r: 1500, rd: 350, score: 1 }, { r: 1500, rd: 350, score: 0 }], SITE_GLICKO);
    expect(one.overall.get("ann")!.rating).toBeCloseTo(ann.r, 9);
    expect(one.overall.get("ann")!.rd).toBeCloseTo(ann.rd, 9);
  });

  it("idle days only grow the RD (closed form = one step a day), capped at 350; asOf grows it to today", () => {
    let rd = 80;
    for (let i = 0; i < 30; i++) rd = Math.min(Math.sqrt((rd / 173.7178) ** 2 + 0.06 ** 2) * 173.7178, 350);
    expect(inflateRd(80, 0.06, 30)).toBeCloseTo(rd, 9);
    expect(inflateRd(300, 0.06, 100_000)).toBe(350);
    const r = computeSiteRatings([game("a", "ann", "bob", 1, 0)]);
    const later = computeSiteRatings([game("a", "ann", "bob", 1, 0)], { asOf: T0 + 200 * DAY_MS });
    expect(later.overall.get("ann")!.rating).toBe(r.overall.get("ann")!.rating);
    expect(later.overall.get("ann")!.rd).toBeGreaterThan(r.overall.get("ann")!.rd);
  });

  it("a game seen twice (same key) counts once; a coach against themselves never counts", () => {
    const once = computeSiteRatings([game("a", "ann", "bob", 1)]);
    const twice = computeSiteRatings([game("a", "ann", "bob", 1), game("a", "ann", "bob", 1, 0)]);
    expect(twice.overall.get("ann")).toEqual(once.overall.get("ann"));
    expect(twice.games).toBe(1);
    expect(computeSiteRatings([game("s", "ann", "ann", 1)]).overall.size).toBe(0);
  });
});

describe("per race and provisional", () => {
  it("keeps one rating per coach per race, updated against the opponent's OVERALL rating", () => {
    const games = [
      game("1", "ann", "bob", 1, 0, ["Orc", "Elf"]),
      game("2", "ann", "bob", 1, 1, ["Human", "Elf"]),
      game("3", "ann", "bob", 1, 2, ["orc ", "Elf"]),
    ];
    const r = computeSiteRatings(games);
    const ann = r.byRace.get("ann")!;
    expect([...ann.keys()].sort()).toEqual(["human", "orc"]);
    expect(ann.get("orc")!.games).toBe(2);
    expect(ann.get("orc")!.label).toBe("Orc");
    expect(ann.get("human")!.games).toBe(1);
    expect(r.overall.get("ann")!.games).toBe(3);
    // the Human game (day 1): ann's race rating starts from the defaults, bob is read at his overall rating then
    const bobAfterDay0 = glickoUpdate({ r: 1500, rd: 350, sigma: 0.06 }, [{ r: 1500, rd: 350, score: 0 }], SITE_GLICKO);
    const bobDay1 = { r: bobAfterDay0.r, rd: inflateRd(bobAfterDay0.rd, bobAfterDay0.sigma, 0) };
    const human = glickoUpdate({ r: 1500, rd: 350, sigma: 0.06 }, [{ r: bobDay1.r, rd: bobDay1.rd, score: 1 }], SITE_GLICKO);
    expect(ann.get("human")!.rating).toBeCloseTo(human.r, 9);
  });

  it("a game without a race rates overall only", () => {
    const r = computeSiteRatings([game("1", "ann", "bob", 1)]);
    expect(r.overall.get("ann")!.games).toBe(1);
    expect(r.byRace.get("ann")).toBeUndefined();
  });

  it(`is provisional until ${PROVISIONAL_GAMES} rated games, overall and per race separately`, () => {
    const games = Array.from({ length: 5 }, (_, i) => game(`g${i}`, "ann", "bob", 1, i, [i < 4 ? "Orc" : "Elf", "Elf"]));
    const four = computeSiteRatings(games.slice(0, 4));
    expect(four.overall.get("ann")!.provisional).toBe(true);
    const five = computeSiteRatings(games);
    expect(five.overall.get("ann")!.provisional).toBe(false);
    expect(five.byRace.get("ann")!.get("orc")!.provisional).toBe(true); // 4 Orc games
    expect(five.byRace.get("bob")!.get("elf")!.provisional).toBe(false); // 5 Elf games
  });
});

// ---- what counts ----------------------------------------------------------------------------------------------------

describe("exclusions", () => {
  it("league: forfeits, deadline decisions, overrides, unbacked concessions and test fixtures never count", () => {
    const played = fixture("f1", "Ann", "Bob", 2, 1);
    expect(leagueFixtureVerdict(played)).toEqual({ counts: true, homeScore: 1 });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", 0, 0, 0, { forfeit: { home: true, away: false, at: iso(0) } }))).toMatchObject({ reason: "forfeit" });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", 2, 0, 0, { inactiveDecision: { teamId: "x", decision: "forfeit", by: "Org", at: iso(0) } }))).toMatchObject({ reason: "forfeit" });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", 0, 0, 0, { deadlineOutcome: { outcome: "both-lose", at: iso(0) } }))).toMatchObject({ reason: "deadline" });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", 2, 1, 0, { resultEdit: { by: "Org", at: iso(0) } }))).toMatchObject({ reason: "override" });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", 2, 1, 0, { test: true }))).toMatchObject({ reason: "test" });
    expect(leagueFixtureVerdict(fixture("f", "Ann", "Bob", null, null))).toMatchObject({ reason: "no-result" });
    const conceded = fixture("f", "Ann", "Bob", 0, 0, 0, { away: side("Bob", 0, { conceded: true }) });
    expect(leagueFixtureVerdict(conceded)).toMatchObject({ reason: "concession" }); // a TourPlay-style forfeit
    // a concession in a game actually played on Super FUMBBL is a loss for the coach who conceded
    expect(leagueFixtureVerdict({ ...conceded, fork: { status: "finished", teams: {}, log: [], result: { gameId: "77" } } as never })).toEqual({ counts: true, homeScore: 1 });
  });

  it("league: drafts, test leagues, demo data and sides without a coach account never count", () => {
    const s = season("s1", [fixture("f1", "Ann", "Bob", 1, 0)]);
    expect(leagueGames([src(league("harbour"), s)])).toHaveLength(1);
    expect(leagueGames([src(league("harbour", { visibility: "draft" }), s)])).toHaveLength(0);
    expect(leagueGames([src(league("harbour", { test: true }), s)])).toHaveLength(0);
    expect(leagueGames([src(league("harbour", { seededBy: { script: "seed", run: "1" } }), s)])).toHaveLength(0);
    const unlinked = season("s1", [fixture("f1", "Ann", "Bob", 1, 0, 0, { away: side("Bob", 0, { coachId: undefined }) })]);
    expect(leagueGames([src(league("harbour"), unlinked)])).toHaveLength(0);
  });

  it("league: the coach who PLAYED counts (playedBy), and ladders count as ladder games", () => {
    const f = fixture("f1", "Ann", "Bob", 1, 0, 0, { home: side("Cat", 1, { playedBy: { coach: "Ann", coachId: "Ann" } }) });
    const [g] = leagueGames([src(league("harbour"), season("s1", [f]))]);
    expect(g!.home.coach).toBe("ann");
    const ladder = season("ladder-1", [fixture("f1", "Ann", "Bob", 1, 0)], { competition: "ladder", ladder: { challenges: [], members: [] } as never });
    expect(leagueGames([src(league("harbour"), ladder)])[0]!.source).toBe("ladder");
  });

  it("tournament: byes, cancelled fixtures, manager edits, unpublished and test tournaments never count", () => {
    expect(tournamentMatchVerdict(tMatch("m", "ann", "bob", 2, 1))).toEqual({ counts: true, homeScore: 1 });
    expect(tournamentMatchVerdict(tMatch("m", "ann", null, 2, 0))).toMatchObject({ reason: "bye" });
    expect(tournamentMatchVerdict(tMatch("m", "ann", "bob", 2, 1, 0, { status: "cancelled" }))).toMatchObject({ reason: "cancelled" });
    const edited = tMatch("m", "ann", "bob", 2, 1, 0, { edited: { byCoachId: "org", at: iso(0), kind: "result", previous: null, original: null } });
    expect(tournamentMatchVerdict(edited)).toMatchObject({ reason: "override" });
    // a result reported again after a manager cleared it is a played result again
    expect(tournamentMatchVerdict({ ...edited, edited: { ...edited.edited!, reportedAgainAt: iso(1) } })).toMatchObject({ counts: true });
    // a manager's first-time entry (manual) is a played result
    expect(tournamentMatchVerdict(tMatch("m", "ann", "bob", 1, 1, 0, { result: { homeScore: 1, awayScore: 1, reportedAt: iso(0), manual: true } }))).toEqual({ counts: true, homeScore: 0.5 });
    const m = [tMatch("m1", "ann", "bob", 2, 1)];
    expect(tournamentGames(tournaments(m))).toHaveLength(1);
    expect(tournamentGames(tournaments(m, { unpublished: true }))).toHaveLength(0);
    expect(tournamentGames(tournaments(m, { test: true }))).toHaveLength(0);
    expect(tournamentGames(tournaments(m, {}, { ann: "Orc" }))[0]!.home.race).toBe("Orc");
  });

  it("Super FUMBBL: a game a fixture claims (any league, also a draft) counts through the fixture only; recorder, NAF and test rows never", () => {
    const f = fixture("f1", "Ann", "Bob", 2, 0, 0, { fork: { status: "finished", teams: {}, log: [], gameId: "77", result: { gameId: "77" } } as never });
    const rows = [forkRow("77", "Ann", "Bob", 2, 0), forkRow("78", "Ann", "Bob", 0, 1)];
    const games = collectRatedGames({ leagues: [src(league("harbour"), season("s1", [f]))], tournaments: emptyTournaments(), results: rows });
    expect(games.map((g) => g.key).sort()).toEqual(["fork:78", "league:harbour:s1:f1"]);
    const draft = collectRatedGames({ leagues: [src(league("harbour", { visibility: "draft" }), season("s1", [f]))], tournaments: emptyTournaments(), results: rows });
    expect(draft.map((g) => g.key)).toEqual(["fork:78"]); // the draft's game never leaks through the results store
    const tClaim = tournaments([tMatch("m1", "ann", "bob", 2, 1, 0, { launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, gameId: "78" } })]);
    expect(collectRatedGames({ leagues: [], tournaments: tClaim, results: [forkRow("78", "Ann", "Bob", 0, 1)] }).map((g) => g.key)).toEqual(["tournament:cup:m1"]);
    expect(forkGames([forkRow("9", "Ann", "Bob", 1, 0, 0, { source: "tabletop", published: true }), forkRow("10", "Ann", "Bob", 1, 0, 0, { source: "naf" }), forkRow("11", "Ann", "Bob", 1, 0, 0, { test: true })], new Set())).toHaveLength(0);
    expect(forkGames([forkRow("12", "Ann", "Bob", 1, 0)], new Set(), (id) => (id === "Ann-ft" ? "Orc" : undefined))[0]!.home).toEqual({ coach: "ann", race: "Orc" });
  });
});

// ---- idempotency ----------------------------------------------------------------------------------------------------

describe("idempotency and corrections", () => {
  const ratingOf = (sources: LeagueSource[], results: StoredTournamentResult[] = []) =>
    computeSiteRatings(collectRatedGames({ leagues: sources, tournaments: emptyTournaments(), results })).overall;

  it("an edited result replaces the old one (never counted twice); a deleted or cleared result drops out", () => {
    const before = ratingOf([src(league("harbour"), season("s1", [fixture("f1", "Ann", "Bob", 2, 0)]))]);
    const edited = ratingOf([src(league("harbour"), season("s1", [fixture("f1", "Ann", "Bob", 0, 2)]))]);
    expect(edited.get("ann")!.games).toBe(1);
    expect(edited.get("ann")!.rating).toBeLessThan(1500);
    expect(before.get("ann")!.rating).toBeGreaterThan(1500);
    expect(ratingOf([src(league("harbour"), season("s1", []))]).size).toBe(0);
    expect(ratingOf([src(league("harbour"), season("s1", [fixture("f1", "Ann", "Bob", null, null)]))]).size).toBe(0);
  });

  it("a TourPlay re-import (the merge keeps fixture ids) or a re-sync gives the same ratings", () => {
    const fixtures = [fixture("f1", "Ann", "Bob", 2, 0, 0), fixture("f2", "Bob", "Cat", 1, 1, 1), fixture("f3", "Cat", "Ann", 0, 3, 2)];
    const first = ratingOf([src(league("harbour"), season("s1", fixtures))]);
    // re-imported: the same rows rewritten (fresh objects, new import time)
    const again = ratingOf([src(league("harbour"), season("s1", structuredClone(fixtures), { importedAt: iso(5) }))]);
    expect(again).toEqual(first);
    // the same fork game pulled twice (re-sync), and also claimed by the fixture: one game
    const f = fixture("f9", "Ann", "Bob", 1, 0, 3, { fork: { status: "finished", teams: {}, log: [], result: { gameId: "500" } } as never });
    const synced = ratingOf([src(league("harbour"), season("s1", [...fixtures, f]))], [forkRow("500", "Ann", "Bob", 1, 0, 3), forkRow("500", "Ann", "Bob", 1, 0, 3)]);
    expect(synced.get("ann")!.games).toBe(3);
  });

  it("a real TourPlay merge of the same export (fresh fixture ids) keeps every game once and adds only the new one", () => {
    const prior = season("s1", [fixture("f1", "Ann", "Bob", 2, 0, 0), fixture("f2", "Bob", "Cat", 1, 1, 1)], { source: "tourplay-export" });
    const exported = season("s1", [
      { ...fixture("f1", "Ann", "Bob", 2, 0, 0), id: "f101" }, { ...fixture("f2", "Bob", "Cat", 1, 1, 1), id: "f102" },
      { ...fixture("f3", "Cat", "Ann", 0, 1, 2), id: "f103", round: 2 },
    ], { source: "tourplay-export" });
    const merged = mergeSeason(prior, exported, snapshotOf(prior), new Set(), "harbour-s1").season;
    const ids = merged.fixtures.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["f1", "f2"]));
    expect(ids).toHaveLength(3);
    const games = collectRatedGames({ leagues: [src(league("harbour"), merged)], tournaments: emptyTournaments(), results: [] });
    expect(games).toHaveLength(3);
    const again = mergeSeason(merged, exported, snapshotOf(merged), new Set(), "harbour-s1").season;
    expect(computeSiteRatings(collectRatedGames({ leagues: [src(league("harbour"), again)], tournaments: emptyTournaments(), results: [] })).overall)
      .toEqual(computeSiteRatings(games).overall);
  });

  it("an organiser override after the fact takes the game out again", () => {
    const f = fixture("f1", "Ann", "Bob", 2, 0);
    expect(ratingOf([src(league("harbour"), season("s1", [f]))]).get("ann")!.games).toBe(1);
    expect(ratingOf([src(league("harbour"), season("s1", [{ ...f, resultEdit: { by: "Org", at: iso(1) } }]))]).size).toBe(0);
  });
});

// ---- service, leaderboard, reset, privacy ------------------------------------------------------------------------

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function identities(names: string[], over: Record<string, Partial<IdentityStore["coaches"][string]>> = {}): IdentityStore {
  const coaches: IdentityStore["coaches"] = {};
  for (const n of names) coaches[n.toLowerCase()] = { ffbCoachId: n, level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: iso(-30), updatedBy: "x", ...over[n] } as never;
  return { version: 1, coaches };
}

function service(stateDir: string, sources: LeagueSource[], results: StoredTournamentResult[] = [], ids = identities(["Ann", "Bob", "Cat", "Dee"]), t = emptyTournaments()) {
  return new SiteRatingsService({
    stateDir,
    leagues: { list: () => sources.map((s) => s.league), competitions: (id: string) => [...(sources.find((s) => s.league.id === id)?.competitions ?? [])], version: () => 0 },
    tournaments: () => t, results: () => results, resultsRevision: () => "r",
    identities: () => ids, now: () => T0 + 30 * DAY_MS, ttlMs: 0,
  });
}

/** Ann beats everyone `n` times (one game a day), Bob and Cat split; Dee plays one game. */
function busyLeague(n: number): LeagueSource {
  const fx: LeagueFixture[] = [];
  for (let i = 0; i < n; i++) {
    fx.push(fixture(`a${i}`, "Ann", "Bob", 2, 0, i, { home: side("Ann", 2, { race: "Orc" }), away: side("Bob", 0, { race: "Elf" }) }));
    fx.push(fixture(`c${i}`, "Cat", "Bob", 1, 1, i, { home: side("Cat", 1, { race: "Human" }), away: side("Bob", 1, { race: "Elf" }) }));
  }
  fx.push(fixture("d0", "Dee", "Cat", 1, 0, 0));
  return src(league("harbour"), season("s1", fx));
}

describe("leaderboard and coach reads", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "site-ratings-")); roots.push(dir); });

  it("hides provisional coaches by default, shows them with the toggle, and filters by minimum games", () => {
    const svc = service(dir, [busyLeague(6)]);
    const lb = svc.leaderboard();
    expect(lb.rows.map((r) => r.coach)).toEqual(["Ann", "Cat", "Bob"]); // Dee (1 game) is provisional
    expect(lb.rows[0]).toMatchObject({ rank: 1, games: 6, provisional: false });
    expect(lb.rows.every((r) => Number.isInteger(r.rating) && Number.isInteger(r.rd))).toBe(true);
    const all = svc.leaderboard({ provisional: true });
    expect(all.rows.map((r) => r.coach)).toContain("Dee");
    expect(all.rows.find((r) => r.coach === "Dee")!.provisional).toBe(true);
    expect(svc.leaderboard({ minGames: 7 }).rows.map((r) => r.coach)).toEqual(["Cat", "Bob"]); // Cat 7, Bob 12, Ann 6
  });

  it("the race selector lists played races and ranks that race only", () => {
    const svc = service(dir, [busyLeague(6)]);
    const lb = svc.leaderboard({ provisional: true });
    expect(lb.races.map((r) => r.label)).toEqual(["Elf", "Human", "Orc"]);
    const orc = svc.leaderboard({ race: "orc" });
    expect(orc.race).toEqual({ key: "orc", label: "Orc" });
    expect(orc.rows.map((r) => r.coach)).toEqual(["Ann"]);
    expect(svc.leaderboard({ race: "Lizardmen" }).rows).toEqual([]);
  });

  it("never lists banned or deleted coaches (and a deleted coach's games still count for their opponents)", () => {
    const deletedLeague = busyLeague(6);
    // Bob was deleted: his league rows read "Deleted coach #1", his account is gone
    const anon = { ...deletedLeague, competitions: deletedLeague.competitions.map((s) => ({ ...s, fixtures: s.fixtures.map((f) => ({ ...f, away: f.away.coach === "Bob" ? { ...f.away, coach: "Deleted coach #1", coachId: "Deleted coach #1" } : f.away })) })) };
    const ids = identities(["Ann", "Cat", "Dee", "Deleted coach #1"], { Cat: { banned: true } });
    const svc = service(dir, [anon], [], ids);
    const names = svc.leaderboard({ provisional: true }).rows.map((r) => r.coach);
    expect(names).toEqual(["Ann", "Dee"]);
    expect(svc.coach("Cat")).toBeUndefined();
    expect(svc.coach("Bob")).toBeUndefined();
    expect(svc.coach("Deleted coach #1")).toBeUndefined();
    expect(svc.coach("Ann")!.overall.games).toBe(6);
  });

  it("nothing from draft leagues reaches a leaderboard or a coach's rating", () => {
    const draft = { ...busyLeague(6), league: league("harbour", { visibility: "draft" }) };
    const svc = service(dir, [draft]);
    expect(svc.leaderboard({ provisional: true }).rows).toEqual([]);
    expect(svc.coach("Ann")!.overall).toMatchObject({ rating: 1500, rd: 350, games: 0, provisional: true });
  });

  it("the coach read: overall with its site rank, and every race played", () => {
    const c = service(dir, [busyLeague(6)]).coach("ann")!;
    expect(c.coach).toBe("Ann");
    expect(c.overall).toMatchObject({ games: 6, provisional: false, rank: 1, of: 3 });
    expect(c.races).toEqual([expect.objectContaining({ race: "orc", label: "Orc", games: 6 })]);
  });

  it("routes: public reads, 400 on a bad filter, 404 for an unlisted coach, 503 when the reset file is unreadable", () => {
    const svc = service(dir, [busyLeague(6)]);
    const q = (s = "") => new URLSearchParams(s);
    expect(ratingsRoute("GET", "/api/ratings", q("min=5&provisional=1"), svc)).toMatchObject({ status: 200 });
    expect(ratingsRoute("GET", "/api/ratings", q("min=-1"), svc)).toMatchObject({ status: 400 });
    expect(ratingsRoute("POST", "/api/ratings", q(), svc)).toMatchObject({ status: 405 });
    expect(ratingsRoute("GET", "/api/ratings/coaches/Ann", q(), svc)).toMatchObject({ status: 200 });
    expect(ratingsRoute("GET", "/api/ratings/coaches/Nobody", q(), svc)).toMatchObject({ status: 404 });
    expect(ratingsRoute("GET", "/api/other", q(), svc)).toBeUndefined();
    writeFileSync(ratingsStateFile(dir), "{not json", "utf8");
    expect(ratingsRoute("GET", "/api/ratings", q(), svc)).toMatchObject({ status: 503 });
    expect(ratingsRoute("GET", "/api/ratings/coaches/Ann", q(), svc)).toMatchObject({ status: 503 });
    for (const path of ["/api/ratings", "/api/ratings/coaches/Ann"]) {
      expect(requireSession({ method: "GET", headers: {}, url: path } as never, path, "")).toEqual({ kind: "allow" });
    }
  });
});

describe("go-live reset (scripts/reset-ratings.ts)", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "site-ratings-reset-")); roots.push(dir); });

  function seedResults(): void {
    writeFileSync(join(dir, "tournament-results.json"), JSON.stringify({ version: 1, results: { "1": forkRow("1", "Ann", "Bob", 2, 0, 0), "2": forkRow("2", "Ann", "Bob", 1, 0, 1) } }), "utf8");
  }

  it("dry run by default: counts, writes nothing", () => {
    seedResults();
    const r = resetRatings({ stateDir: dir, yes: false });
    expect(r).toMatchObject({ dryRun: true, coaches: 2, games: 2, previousResetAt: null, resetAt: null });
    expect(existsSync(ratingsStateFile(dir))).toBe(false);
  });

  it("--yes resets every rating to 1500 / RD 350: earlier games never count, later ones do", () => {
    seedResults();
    const at = new Date(T0 + 10 * DAY_MS);
    const r = resetRatings({ stateDir: dir, yes: true, now: at });
    expect(r.resetAt).toBe(at.toISOString());
    expect(readRatingsState(dir).resetAt).toBe(at.toISOString());
    expect(JSON.parse(readFileSync(ratingsStateFile(dir), "utf8"))).toEqual({ version: 1, resetAt: at.toISOString() }); // no personal data
    const svc = service(dir, [], [forkRow("1", "Ann", "Bob", 2, 0, 0), forkRow("2", "Ann", "Bob", 1, 0, 1)]);
    expect(svc.coach("Ann")!.overall).toEqual({ rating: 1500, rd: 350, games: 0, provisional: true });
    const after = service(dir, [], [forkRow("1", "Ann", "Bob", 2, 0, 0), forkRow("3", "Ann", "Bob", 1, 0, 11)]);
    expect(after.coach("Ann")!.overall.games).toBe(1);
    expect(after.leaderboard().resetAt).toBe(at.toISOString());
  });
});

describe("privacy", () => {
  const prev = process.env.IDENTITIES_FILE;
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "site-ratings-privacy-")); roots.push(dir);
    process.env.IDENTITIES_FILE = join(dir, "identities.json");
    writeFileSync(process.env.IDENTITIES_FILE, JSON.stringify(identities(["Ann", "Bob"])), "utf8");
  });
  afterEach(() => { if (prev === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prev; });

  it("the export carries the coach's own ratings (overall and per race), and the registry names how deletion handles them", async () => {
    writeFileSync(join(dir, "tournament-results.json"), JSON.stringify({ version: 1, results: { "1": forkRow("1", "Ann", "Bob", 2, 0, 0) } }), "utf8");
    for (const d of ["library", "saves", "avatars", "coach-avatars", "bugs", "tabletop"]) mkdirSync(join(dir, d), { recursive: true });
    const files = await collectExport({
      stateDir: dir, tournamentsDir: dir, libraryDir: join(dir, "library"), builderSavesDir: join(dir, "saves"), teamAvatarsDir: join(dir, "avatars"),
      coachAvatarsDir: join(dir, "coach-avatars"), bugReportsDir: join(dir, "bugs"), tabletopDir: join(dir, "tabletop"),
    }, "Ann");
    const ratings = JSON.parse(String(files.find((f) => f.name === "ratings.json")!.content));
    expect(ratings.overall).toMatchObject({ games: 1, provisional: true });
    expect(ratings.overall.rating).toBeGreaterThan(1500);
    expect(ratings.races).toEqual([]);
    expect(String(files.find((f) => f.name === "README.txt")!.content)).toMatch(/ratings\.json/);
    const entry = STORE_COLLECTORS.find((s) => s.id === "site-ratings")!;
    expect(entry.erase).toEqual(expect.arrayContaining(["anonymise-results", "anonymise-leagues", "anonymise-tournaments", "identity"]));
  });
});

describe("ladders ranked by rating use the site Glicko-2", () => {
  it("starts at 1500, and a forfeit counts in the table but never moves the rating", () => {
    const now = new Date(T0 + 10 * DAY_MS);
    const teams = [{ id: "ann-team", name: "Ann team", race: "Orc", coach: "Ann" }, { id: "bob-team", name: "Bob team", race: "Elf", coach: "Bob" }];
    const base = (fixtures: LeagueFixture[]) => season("ladder-1", fixtures, {
      competition: "ladder", teams: teams as never,
      ladder: { settings: { ranking: "rating", minGames: 0 }, members: teams.map((t) => ({ teamId: t.id, joinedAt: iso(-1) })), challenges: [] } as never,
    });
    const rows = (s: SeasonRecord) => rankRows(s, replayLadder(s, now), teams.map((t) => ({ team: t as never })));
    const fresh = rows(base([]));
    expect(fresh.map((r) => [r.rating, r.rd])).toEqual([[1500, 350], [1500, 350]]);
    const forfeit = rows(base([fixture("f1", "Ann", "Bob", 2, 0, 0, { forfeit: { home: false, away: true, at: iso(0) } })]));
    expect(forfeit.find((r) => r.teamId === "ann-team")).toMatchObject({ wins: 1, rating: 1500, rd: 350 });
    const played = rows(base([fixture("f1", "Ann", "Bob", 2, 0, 0)]));
    expect(played.find((r) => r.teamId === "ann-team")!.rating).toBeGreaterThan(1500);
  });
});

// ---- review round (Sol, 6 x P2) -------------------------------------------------------------------------------------

describe("review: fork claims survive a TourPlay correction, a reset and a deleted fixture", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "site-ratings-claims-")); roots.push(dir); });

  it("a fork game a fixture once claimed never counts again as a stand-alone fork game", () => {
    const store = new LeagueStore(dir);
    store.upsertLeague({ id: "harbour", name: "Harbour", fullName: "Harbour", slug: "harbour", organisers: ["Org"] } as never);
    const played = fixture("f1", "Ann", "Bob", 2, 0, 0, { fork: { status: "finished", teams: {}, log: [], gameId: "77", result: { gameId: "77" } } as never });
    store.putSeason(season("s1", [played, fixture("f2", "Bob", "Ann", 1, 0, 1, { fork: { status: "scheduled", teams: {}, log: [], gameId: "78" } as never })], { sourceSlug: "s1" } as never));
    // a TourPlay correction picked the export's result: detachLocalResult drops the fork state; another fixture was deleted
    const s = store.season("harbour", "s1")!;
    const f1 = s.fixtures.find((f) => f.id === "f1")!;
    delete (f1 as { fork?: unknown }).fork;
    f1.home.score = 1; f1.away.score = 1;
    s.fixtures = s.fixtures.filter((f) => f.id !== "f2");
    store.putSeason(s);
    const stored = store.season("harbour", "s1")!;
    expect(stored.forkClaims).toEqual(["77", "78"]);
    const results = [forkRow("77", "Ann", "Bob", 2, 0, 0), forkRow("78", "Bob", "Ann", 1, 0, 1)];
    const games = collectRatedGames({ leagues: [src(store.league("harbour")!, ...store.competitions("harbour"))], tournaments: emptyTournaments(), results });
    expect(games.map((g) => g.key)).toEqual(["league:harbour:s1:f1"]);
    expect(games[0]!.homeScore).toBe(0.5);
  });
});

describe("review: deleted and banned coaches have no public rating anywhere", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "site-ratings-public-")); roots.push(dir); });

  it("the fixture coach cards (and seeding) read only listed coaches", () => {
    const anonLeague = busyLeague(6);
    const anon = { ...anonLeague, competitions: anonLeague.competitions.map((s) => ({ ...s, fixtures: s.fixtures.map((f) => ({ ...f, away: f.away.coach === "Bob" ? { ...f.away, coach: "Deleted coach #1", coachId: "Deleted coach #1" } : f.away })) })) };
    const svc = service(dir, [anon], [], identities(["Ann", "Cat", "Dee", "Deleted coach #1"], { Cat: { banned: true } }));
    const pub = svc.publicOverall();
    expect([...pub.keys()].sort()).toEqual(["ann", "dee"]);
    const rate = ratingsOf({ ratings: () => svc.publicOverall() })!;
    expect(rate("Deleted coach #1")).toBeNull();
    expect(rate("Cat")).toBeNull();
    expect(rate("Ann")).toMatchObject({ games: 6, rank: 1, of: 2 });
    // unreadable identities: no ratings at all (fail closed), never everyone's
    const broken = new SiteRatingsService({ ...(svc as unknown as { deps: object }).deps, identities: () => { throw new Error("unreadable"); } } as never);
    expect(ratingsOf({ ratings: () => broken.publicOverall() })).toBeUndefined();
  });
});

describe("review: a tournament game keeps its time across a clear and re-report", () => {
  it("the rating time is the agreed time, else when the fixture was drawn, never the latest report", () => {
    const drawn = tMatch("m1", "ann", "bob", 2, 1, 0, { createdAt: iso(0) });
    const reReported = { ...drawn, result: { homeScore: 0, awayScore: 1, reportedAt: iso(20) }, edited: { byCoachId: "org", at: iso(19), kind: "result" as const, previous: null, original: null, reportedAgainAt: iso(20) } };
    expect(tournamentGameTime(reReported)).toBe(T0);
    expect(tournamentGames(tournaments([reReported]))[0]!.at).toBe(T0);
    expect(tournamentGameTime({ ...drawn, scheduledTime: { start: iso(2), end: iso(2, 2), agreedAt: iso(1) } })).toBe(T0 + 2 * DAY_MS);
    // the go-live reset at day 10 keeps it out, however late it is reported again
    const r = computeSiteRatings(tournamentGames(tournaments([reReported])), { resetAt: T0 + 10 * DAY_MS });
    expect(r.games).toBe(0);
  });
});

describe("review: rating ladders qualify on rated games only", () => {
  it("a forfeit win does not count toward the minimum games", () => {
    const now = new Date(T0 + 10 * DAY_MS);
    const teams = [{ id: "ann-team", name: "Ann team", race: "Orc", coach: "Ann" }, { id: "bob-team", name: "Bob team", race: "Elf", coach: "Bob" }];
    const lad = (fixtures: LeagueFixture[]) => season("ladder-1", fixtures, {
      competition: "ladder", teams: teams as never,
      ladder: { settings: { ranking: "rating", minGames: 1 }, members: teams.map((t) => ({ teamId: t.id, joinedAt: iso(-1) })), challenges: [] } as never,
    });
    const rows = (s: SeasonRecord) => rankRows(s, replayLadder(s, now), teams.map((t) => ({ team: t as never })));
    const forfeit = rows(lad([fixture("f1", "Ann", "Bob", 2, 0, 0, { forfeit: { home: false, away: true, at: iso(0) } })]));
    expect(forfeit.find((r) => r.teamId === "ann-team")).toMatchObject({ played: 1, ratedGames: 0, ranked: false });
    const played = rows(lad([fixture("f1", "Ann", "Bob", 2, 0, 0)]));
    expect(played.find((r) => r.teamId === "ann-team")).toMatchObject({ ratedGames: 1, ranked: true });
  });
});

describe("review: presence writes never rebuild the ratings", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "site-ratings-cache-")); roots.push(dir); });

  it("a tournament file rewritten by presence leases neither replays nor (within the TTL) re-reads; a new result does", () => {
    const data = tournaments([tMatch("m1", "ann", "bob", 2, 1)]);
    let reads = 0;
    let clock = T0;
    const svc = new SiteRatingsService({
      stateDir: dir, leagues: { list: () => [], competitions: () => [], version: () => 0 },
      tournaments: () => { reads += 1; return data; }, results: () => [], resultsRevision: () => "r",
      identities: () => identities(["Ann", "Bob"]), now: () => clock, ttlMs: 30_000,
    });
    svc.current();
    expect(svc.rebuilds).toBe(1);
    for (let i = 0; i < 50; i++) {
      data.waitingPresence[`lease-${i}`] = { scheduledMatchId: "m1", coachId: "ann", renewedAt: iso(0), expiresAt: iso(1) } as never;
      clock += 100;
      svc.leaderboard({ provisional: true });
    }
    expect(reads).toBe(1); // inside the TTL nothing is re-read
    clock += 31_000;
    data.waitingPresence.more = { scheduledMatchId: "m1", coachId: "bob", renewedAt: iso(0), expiresAt: iso(1) } as never;
    svc.current();
    expect(reads).toBe(2);
    expect(svc.rebuilds).toBe(1); // re-read once after the TTL, the games are the same: no replay
    data.scheduledMatches.m2 = tMatch("m2", "bob", "ann", 3, 0);
    clock += 31_000;
    expect(svc.coach("Ann")!.overall.games).toBe(2);
    expect(svc.rebuilds).toBe(2);
  });
});

describe("review: the privacy export uses the production factory (fork races)", () => {
  const prev = process.env.IDENTITIES_FILE;
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "site-ratings-export-")); roots.push(dir);
    process.env.IDENTITIES_FILE = join(dir, "identities.json");
    writeFileSync(process.env.IDENTITIES_FILE, JSON.stringify(identities(["Ann", "Bob"])), "utf8");
  });
  afterEach(() => { if (prev === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prev; });

  it("a Super FUMBBL game's race comes from the team library in the export too", async () => {
    writeFileSync(join(dir, "tournament-results.json"), JSON.stringify({ version: 1, results: { "1": forkRow("1", "Ann", "Bob", 2, 0, 0) } }), "utf8");
    for (const d of ["library", "saves", "avatars", "coach-avatars", "bugs", "tabletop"]) mkdirSync(join(dir, d), { recursive: true });
    writeFileSync(join(dir, "library", "ann.json"), JSON.stringify([{ teamId: "Ann-ft", teamName: "Green Tide", race: "Orc" }]), "utf8");
    const deps = {
      stateDir: dir, tournamentsDir: dir, libraryDir: join(dir, "library"), builderSavesDir: join(dir, "saves"), teamAvatarsDir: join(dir, "avatars"),
      coachAvatarsDir: join(dir, "coach-avatars"), bugReportsDir: join(dir, "bugs"), tabletopDir: join(dir, "tabletop"),
    };
    const files = await collectExport(deps, "Ann");
    const ratings = JSON.parse(String(files.find((f) => f.name === "ratings.json")!.content));
    expect(ratings.races).toEqual([expect.objectContaining({ race: "orc", label: "Orc", games: 1 })]);
    // the same numbers the production service (same factory, same stores) gives
    const prod = createSiteRatings({ stateDir: dir, tournamentsDir: dir, libraryDir: join(dir, "library") }, { identities: () => identities(["Ann", "Bob"]) });
    expect(prod.coach("Ann")!.races).toEqual([expect.objectContaining({ race: "orc", games: 1 })]);
  });
});

describe("review 2: a fixture drawn before the reset and first played after it counts, at its first report", () => {
  it("firstReportedAt is stamped by the store on the first report and survives a clear and re-report", () => {
    const root = mkdtempSync(join(tmpdir(), "site-ratings-first-report-")); roots.push(root);
    const store = new TournamentStore(root);
    const at0 = iso(0);
    const side = (c: string) => ({ entrantId: `e-${c}`, coach: { coachId: c, ffbCoachId: c, verifiedAt: at0 }, teamId: `t-${c}` });
    store.writeSnapshot({
      version: 4,
      tournaments: { cup: { id: "cup", name: "Cup", status: "active", format: "swiss", packageName: "p", maxPlayers: 8, roundCount: 3, currentRound: 1, tiebreakers: ["buchholz"], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "Org", organizerCoachId: "Org", organizerCoachIds: [], startedAt: at0, createdAt: at0, updatedAt: at0 } as never },
      entrants: Object.fromEntries(["ann", "bob"].map((c, i) => [`e-${c}`, { id: `e-${c}`, tournamentId: "cup", seed: i + 1, coach: { coachId: c, ffbCoachId: c, verifiedAt: at0 }, teamId: `t-${c}`, registeredAt: at0 }])) as never,
      rounds: { r1: { id: "r1", tournamentId: "cup", number: 1, status: "active", scheduledMatchIds: ["m1"], createdAt: at0 } },
      standings: {}, waitingPresence: {},
      // drawn on day 0, no agreed time, no result yet
      scheduledMatches: { m1: { id: "m1", tournamentId: "cup", roundId: "r1", roundNumber: 1, home: side("ann"), away: side("bob"), status: "scheduled", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 }, createdAt: at0, updatedAt: at0 } },
    } as TournamentDataFileV4);
    const resetAt = T0 + 10 * DAY_MS;
    const first = store.recordResult("m1", { expectedRevision: 1, homeScore: 2, awayScore: 0 }, new Date(T0 + 12 * DAY_MS));
    expect(first.firstReportedAt).toBe(iso(12));
    const counted = (): RatedGame[] => tournamentGames(store.snapshot());
    expect(counted()[0]!.at).toBe(T0 + 12 * DAY_MS);
    expect(computeSiteRatings(counted(), { resetAt }).games).toBe(1); // played after go-live: it counts
    // a manager clears it, it is reported again later: the game time stays the first report
    const cleared = store.clearEditedResult("m1", { expectedRevision: first.revision, by: "Org", confirmFinished: true } as never, new Date(T0 + 13 * DAY_MS)).match;
    expect(cleared.firstReportedAt).toBe(iso(12));
    expect(counted()).toEqual([]);
    const again = store.recordResult("m1", { expectedRevision: cleared.revision, homeScore: 0, awayScore: 1 }, new Date(T0 + 20 * DAY_MS));
    expect(again.firstReportedAt).toBe(iso(12));
    expect(counted()).toEqual([expect.objectContaining({ at: T0 + 12 * DAY_MS, homeScore: 0 })]);
    // the agreed time wins when there is one; a legacy row with neither falls back to the draw
    expect(tournamentGameTime({ scheduledTime: { start: iso(11), end: iso(11, 2), agreedAt: iso(5) }, firstReportedAt: iso(12), createdAt: at0 })).toBe(T0 + 11 * DAY_MS);
    expect(tournamentGameTime({ createdAt: at0, result: { homeScore: 1, awayScore: 0, reportedAt: iso(30) } })).toBe(T0);
  });
});

describe("review 3: a legacy result (no firstReportedAt) keeps its original time through a clear and re-report", () => {
  it("a pre-reset legacy game cleared and re-reported after the reset never counts", () => {
    const root = mkdtempSync(join(tmpdir(), "site-ratings-legacy-")); roots.push(root);
    const at0 = iso(0);
    const side = (c: string) => ({ entrantId: `e-${c}`, coach: { coachId: c, ffbCoachId: c, verifiedAt: at0 }, teamId: `t-${c}` });
    // written raw, as a file from before the stamp existed: a result reported on day 2, no firstReportedAt
    writeFileSync(join(root, "tournaments.json"), JSON.stringify({
      version: 4,
      tournaments: { cup: { id: "cup", name: "Cup", status: "active", format: "swiss", packageName: "p", maxPlayers: 8, roundCount: 3, currentRound: 1, tiebreakers: ["buchholz"], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "Org", organizerCoachId: "Org", organizerCoachIds: [], startedAt: at0, createdAt: at0, updatedAt: at0 } },
      entrants: Object.fromEntries(["ann", "bob"].map((c, i) => [`e-${c}`, { id: `e-${c}`, tournamentId: "cup", seed: i + 1, coach: { coachId: c, ffbCoachId: c, verifiedAt: at0 }, teamId: `t-${c}`, registeredAt: at0 }])),
      rounds: { r1: { id: "r1", tournamentId: "cup", number: 1, status: "active", scheduledMatchIds: ["m1"], createdAt: at0 } },
      standings: {}, waitingPresence: {},
      scheduledMatches: { m1: { id: "m1", tournamentId: "cup", roundId: "r1", roundNumber: 1, home: side("ann"), away: side("bob"), status: "completed", revision: 2, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 }, result: { homeScore: 2, awayScore: 0, reportedAt: iso(2) }, createdAt: at0, updatedAt: iso(2) } },
    }), "utf8");
    const store = new TournamentStore(root);
    const resetAt = T0 + 10 * DAY_MS;
    expect(store.match("m1")!.firstReportedAt).toBe(iso(2)); // read: stamped in memory from the stored report
    const cleared = store.clearEditedResult("m1", { expectedRevision: 2, by: "Org", confirmFinished: true } as never, new Date(T0 + 12 * DAY_MS)).match;
    expect(cleared.firstReportedAt).toBe(iso(2));
    const again = store.recordResult("m1", { expectedRevision: cleared.revision, homeScore: 0, awayScore: 1 }, new Date(T0 + 14 * DAY_MS));
    expect(again.firstReportedAt).toBe(iso(2));
    const games = tournamentGames(store.snapshot());
    expect(games).toEqual([expect.objectContaining({ at: T0 + 2 * DAY_MS })]);
    expect(computeSiteRatings(games, { resetAt }).games).toBe(0); // the pre-reset game stays out
  });
});

describe("SPA helpers", () => {
  it("coach card: rating with RD, Provisional under 5 games", () => {
    expect(ratingText({ value: 1561, rd: 87, provisional: false })).toBe("1561 ±87");
    expect(ratingText({ value: 1488, rd: 210, provisional: true })).toBe("1488 ±210 · Provisional");
    expect(coachCardLines({ rating: { value: 1488, rd: 210, games: 4, provisional: true }, winRate: null, stats: { allTime: { played: 4 } } } as never)[0])
      .toEqual({ k: "Rating", v: "1488 ±210 · Provisional" });
  });

  it("leaderboard URL, empty line, race lookup and the remembered filters", () => {
    expect(leaderboardUrl({ race: "", minGames: 0, provisional: false })).toBe("/api/ratings");
    expect(leaderboardUrl({ race: "orc", minGames: 10, provisional: true })).toBe("/api/ratings?race=orc&min=10&provisional=1");
    expect(emptyLine({ race: null, provisional: false, provisionalGames: 5, minGames: 0 })).toMatch(/played 5 rated games yet\. Show provisional/);
    expect(raceRatingFor({ coach: "Ann", overall: { rating: 1, rd: 1, games: 1, provisional: true }, races: [{ race: "orc", label: "Orc", rating: 1600, rd: 90, games: 6, provisional: false }] }, " Orc")!.rating).toBe(1600);
    const m = new Map<string, string>();
    const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    writeFilters({ race: "orc", minGames: 10, provisional: true }, storage);
    expect(readFilters(storage)).toEqual({ race: "orc", minGames: 10, provisional: true });
    m.set("sf-ratings-filters", JSON.stringify({ minGames: 7, provisional: "yes" }));
    expect(readFilters(storage)).toEqual({ race: "", minGames: 0, provisional: false });
    expect(readFilters({ getItem: () => { throw new Error("blocked"); } })).toEqual({ race: "", minGames: 0, provisional: false });
  });
});
