import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BADGE_CATALOG, badgeDefinition } from "../src/badges/catalog.js";
import { BadgeEngine, diffAwards } from "../src/badges/engine.js";
import { evaluateCatalog, LEDGER_EVALUATORS, type Earned } from "../src/badges/evaluators.js";
import { BADGE_ICONS, isBadgeIcon } from "../src/badges/icons.js";
import { buildBadgeLedger, recorderDetail, type BadgeLedger, type RecorderResult } from "../src/badges/ledger.js";
import { BadgeStore } from "../src/badges/store.js";
import { CheckedLeagueReader } from "../src/badges/sources.js";
import { ClubStore } from "../src/clubs/store.js";
import type { ClubRecord } from "../src/clubs/types.js";
import { defaultEvents } from "../src/discord/catalogue.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import type { NotificationInput } from "../src/notifications.js";
import { TournamentStore } from "../src/tournaments/store.js";

// Badges and achievements (badges lane, spec-grill-round2-leftovers 11-04 item 6): a data-driven catalog, evaluators over
// the site's history, idempotent awards (one per subject per badge / tier / race), revocation when a result is corrected
// or deleted, never on forfeits or organiser-entered results, never for "needs recorder data" placeholders.

let dir: string;
let leagues: LeagueStore;
let tournaments: TournamentStore;
let clubs: ClubStore;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();

const side = (team: string, coach: string, race: string, teamId = team.toLowerCase()) => ({ team, teamId, coach, coachId: coach, race, score: null, cas: null, conceded: false });
let n = 0;
/** A played league fixture: Ann (Orcs) v Bob (Elves) by default. */
const game = (hs: number, as: number, over: Partial<LeagueFixture> & { hc?: number; ac?: number } = {}): LeagueFixture => {
  n += 1;
  const { hc, ac, ...rest } = over;
  const base: LeagueFixture = {
    id: `f${n}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: n, table: 1,
    home: { ...side("Orcs", "Ann", "Orc"), score: hs, cas: hc ?? 1 }, away: { ...side("Elves", "Bob", "Wood Elf"), score: as, cas: ac ?? 1 },
    suspended: false, finishedAt: at(n),
  };
  return { ...base, ...rest, home: { ...base.home, ...(rest.home ?? {}) }, away: { ...base.away, ...(rest.away ?? {}) } };
};
const team = (id: string, name: string, coach: string, race: string, extra: Partial<LeagueTeam> = {}): LeagueTeam =>
  ({ id, name, race, coach, coachId: coach, players: [], formerPlayers: [], teamValue: null, treasury: null, rerolls: null, ...extra }) as never;
const season = (num: number, fixtures: LeagueFixture[], extra: Partial<SeasonRecord> = {}, leagueId = "lg"): SeasonRecord => ({
  id: `season-${num}`, leagueId, number: num, name: `Season ${num}`, sourceSlug: `season-${num}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }] as never, fixtures,
  teams: [team("orcs", "Orcs", "Ann", "Orc", { teamUid: "uid-orcs" }), team("elves", "Elves", "Bob", "Wood Elf")],
  participants: [], honours: [], awards: [], unattributedStats: [], importedAt: at(-500), source: "manual", ...extra,
});
const src = (recorder?: Map<string, RecorderResult>) => ({ leagues: new CheckedLeagueReader(dir), tournaments, clubs, ...(recorder ? { recorder } : {}) });
const earnedNow = async (recorder?: Map<string, RecorderResult>): Promise<Earned[]> => evaluateCatalog(await buildBadgeLedger(src(recorder), new Date(at(1000))), new Date(at(1000)));
const has = (earned: Earned[], badgeId: string, kind: "coach" | "team", name: string, variant?: string) =>
  earned.some((e) => e.badgeId === badgeId && e.subject.kind === kind && e.subject.name === name && (variant === undefined || e.variant === variant));

const tournament = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Cup ${id}`, status: "completed", format: "swiss", packageName: "test-cup", maxPlayers: 8, roundCount: 1, currentRound: 1,
  tiebreakers: [], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "TOrg", organizerCoachIds: [], createdAt: at(-200), updatedAt: at(-1), ...extra,
});
const ident = (c: string) => ({ coachId: c, ffbCoachId: c, verifiedAt: at(-300) });
const entrant = (tid: string, coach: string, seed: number, race = "Orc") => ({
  id: `${tid}:${coach}`, tournamentId: tid, seed, coach: ident(coach), teamId: `team-${coach}`, registeredAt: at(-100),
  submission: { saveId: "save:x", revision: "r", submittedAt: "", teamName: `${coach} Team`, race, snapshot: null, validation: { ok: true, problems: [], checkedAt: "", packageName: "test-cup" } },
});
const smatch = (tid: string, k: number, home: string, away: string, hs: number, as: number, extra: Record<string, unknown> = {}) => ({
  id: `${tid}:m${k}`, tournamentId: tid, roundId: `${tid}:r1`, roundNumber: 1,
  home: { entrantId: `${tid}:${home}`, coach: ident(home), teamId: `team-${home}` }, away: { entrantId: `${tid}:${away}`, coach: ident(away), teamId: `team-${away}` },
  status: "completed", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  result: { homeScore: hs, awayScore: as, homeCasualties: 1, awayCasualties: 1, reportedAt: at(k) }, createdAt: at(-50), updatedAt: at(k), ...extra,
});
function seedTournaments(ts: Array<ReturnType<typeof tournament>>, es: Array<ReturnType<typeof entrant>>, ms: Array<ReturnType<typeof smatch>>): void {
  tournaments.writeSnapshot({
    version: 4, tournaments: Object.fromEntries(ts.map((t) => [t.id, t])), entrants: Object.fromEntries(es.map((e) => [e.id, e])),
    rounds: {}, standings: {}, scheduledMatches: Object.fromEntries(ms.map((m) => [m.id, m])), waitingPresence: {},
  } as never);
}

beforeEach(() => {
  n = 0;
  dir = mkdtempSync(join(tmpdir(), "badges-"));
  leagues = new LeagueStore(dir);
  leagues.upsertLeague({ id: "lg", name: "Test League", fullName: "Test League", slug: "lg", organisers: ["Org"] } as never);
  tournaments = new TournamentStore(join(dir, "tournaments"));
  seedTournaments([], [], []);
  clubs = new ClubStore(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("the catalog", () => {
  it("is data: every entry has an evaluator, a known icon and valid fields; ids are unique", async () => {
    const ids = new Set<string>();
    for (const d of BADGE_CATALOG) {
      expect(ids.has(d.id), d.id).toBe(false);
      ids.add(d.id);
      expect(isBadgeIcon(d.icon), d.id).toBe(true);
      expect(["badge", "achievement"]).toContain(d.kind);
      expect(["coach", "team", "both"]).toContain(d.scope);
      expect(["live", "needs-recorder-data"]).toContain(d.status);
    }
    expect(BADGE_CATALOG.filter((d) => d.kind === "achievement")).toHaveLength(20);
    for (const id of ["first-win", "games-10", "games-50", "games-100", "unbeaten-season", "belt-holder", "tournament-winner", "rumble-winner", "win-streak-5", "race"]) expect(badgeDefinition(id)?.kind).toBe("badge");
    expect(BADGE_CATALOG.filter((d) => d.status === "needs-recorder-data").map((d) => d.id)).toEqual(["underdog"]);
  });
  it("icons are our own glyphs (text, never image files)", async () => {
    for (const v of Object.values(BADGE_ICONS)) { expect(v.glyph).not.toMatch(/[/.]/); expect(v.glyph.length).toBeGreaterThan(0); }
  });
  it("the Badge earned Discord event exists and is off by default for leagues and tournaments", async () => {
    expect(defaultEvents("league").badgeEarned).toBe(false);
    expect(defaultEvents("tournament").badgeEarned).toBe(false);
  });
});

describe("evaluators", () => {
  it("first win, clean sheet, meat grinder, iron wall: coach and team; the loser earns none of the win badges", async () => {
    leagues.putSeason(season(1, [game(2, 0, { hc: 3, ac: 0 })]));
    const e = await earnedNow();
    expect(has(e, "first-win", "coach", "Ann")).toBe(true);
    expect(has(e, "first-win", "team", "Orcs")).toBe(true);
    expect(has(e, "clean-sheet", "coach", "Ann")).toBe(true);
    expect(has(e, "meat-grinder", "coach", "Ann")).toBe(true);
    expect(has(e, "iron-wall", "coach", "Ann")).toBe(true); // Bob inflicted 0
    expect(has(e, "first-win", "coach", "Bob")).toBe(false);
    expect(has(e, "iron-wall", "coach", "Bob")).toBe(false);
    expect(has(e, "race", "coach", "Ann", "Orc")).toBe(true);
    expect(has(e, "race", "coach", "Bob", "Wood Elf")).toBe(true);
    expect(e.find((x) => x.badgeId === "first-win" && x.subject.name === "Ann")!.context).toMatchObject({ leagueId: "lg", seasonId: "season-1", label: "Test League" });
  });

  it("games tiers, 5-win streak (a loss resets it), shutout run of 3", async () => {
    const fx = [game(1, 0), game(1, 0), game(0, 1), game(1, 0), game(1, 0), game(1, 0), game(1, 0), game(2, 0), game(1, 1), game(1, 1)];
    leagues.putSeason(season(1, fx));
    const e = await earnedNow();
    expect(has(e, "games-10", "coach", "Ann")).toBe(true);
    expect(has(e, "games-50", "coach", "Ann")).toBe(false);
    const streak = e.find((x) => x.badgeId === "win-streak-5" && x.subject.name === "Ann");
    expect(streak?.context.gameId).toBe("l:lg:season-1:f8"); // games 4-8
    expect(has(e, "shutout-defence", "coach", "Ann")).toBe(true);
    expect(has(e, "win-streak-5", "coach", "Bob")).toBe(false);
  });

  it("detail achievements need the detail: Super FUMBBL lines give hat-trick and pass master; a plain score gives none", async () => {
    const fork = (td: number, comp: number) => ({
      status: "finished", teams: {}, log: [],
      result: {
        gameId: "g1", source: "full", appliedAt: at(1),
        home: { score: 3, cas: 0, conceded: false, winnings: 0, lines: [{ forkPlayerId: "p1", name: "A", td, cas: 0, completions: comp, interceptions: 0, mvp: 0, fouls: 0, injuries: [] }] },
        away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [] },
      },
    });
    leagues.putSeason(season(1, [game(3, 0, { fork: fork(3, 3) as never }), game(4, 0)]));
    const e = await earnedNow();
    expect(has(e, "hat-trick", "coach", "Ann")).toBe(true);
    expect(has(e, "pass-master", "coach", "Ann")).toBe(true);
    expect(e.find((x) => x.badgeId === "hat-trick" && x.subject.name === "Ann")?.context.gameId).toBe("l:lg:season-1:f1");
    leagues.putSeason(season(1, [game(5, 0)]));
    expect(has(await earnedNow(), "hat-trick", "coach", "Ann")).toBe(false);
  });

  it("recorder detail: comeback (trailing at half-time), foul play, Nuffle's Favourite; only for the op the fixture holds", async () => {
    const events = [
      { type: "weather", team: "home", payload: { pregame: true, dice: [1, 5] } },
      { type: "touchdown", team: "away", player: "b1", half: 1, payload: {} },
      { type: "touchdown", team: "home", player: "a1", half: 2, payload: {} },
      { type: "touchdown", team: "home", player: "a1", half: 2, payload: {} },
      { type: "casualty", team: "home", player: "a2", half: 2, payload: { victim: "b2", cause: "foul" } },
      { type: "casualty", team: "home", player: "a3", half: 2, payload: { victim: "b3", cause: "foul" } },
    ];
    const d = recorderDetail(events);
    expect(d.home).toMatchObject({ halfTime: { for: 0, against: 1 }, successfulFouls: 2, weatherDice: [1, 5], maxPlayerTd: 2, casSuffered: 0 });
    const recorder = new Map([["league:lg:season-1:f1", { opId: "op1", byCoach: new Map([["ann", d.home], ["bob", d.away]]) }]]);
    leagues.putSeason(season(1, [game(2, 1, { tabletop: { revision: 1, opId: "op1" } })]));
    const e = await earnedNow(recorder);
    expect(has(e, "comeback", "coach", "Ann")).toBe(true);
    expect(has(e, "foul-play", "coach", "Ann")).toBe(true);
    expect(has(e, "nuffles-favourite", "coach", "Ann")).toBe(true);
    expect(has(e, "comeback", "coach", "Bob")).toBe(false);
    // a fixture whose result came from elsewhere (a different op) never reads that match's detail
    n = 0;
    leagues.putSeason(season(1, [game(2, 1, { tabletop: { revision: 2, opId: "op2" } })]));
    expect(has(await earnedNow(recorder), "comeback", "coach", "Ann")).toBe(false);
  });

  it("a placeholder that needs recorder data is never awarded", async () => {
    leagues.putSeason(season(1, Array.from({ length: 12 }, () => game(3, 0, { hc: 4, ac: 0 }))));
    expect((await earnedNow()).some((x) => x.badgeId === "underdog")).toBe(false);
  });

  it("unbeaten season and ever present need a FINISHED season; a forfeit loss breaks unbeaten", async () => {
    const fx = [game(1, 0), game(1, 1), game(2, 0)];
    leagues.putSeason(season(1, fx));
    expect(has(await earnedNow(), "unbeaten-season", "coach", "Ann")).toBe(false);
    leagues.putSeason(season(1, fx, { status: "completed", endedAt: at(50) }));
    let e = await earnedNow();
    expect(has(e, "unbeaten-season", "coach", "Ann")).toBe(true);
    expect(has(e, "unbeaten-season", "team", "Orcs")).toBe(true);
    expect(has(e, "ever-present", "coach", "Ann")).toBe(true);
    expect(has(e, "ever-present", "coach", "Bob")).toBe(true);
    expect(e.find((x) => x.badgeId === "unbeaten-season" && x.subject.name === "Ann")?.at).toBe(at(50));
    // Ann forfeits a fourth game: no longer unbeaten, and no longer ever present (a forfeit is not a game played)
    n = 3;
    const forfeit = game(0, 2, { forfeit: { home: true, away: false, at: at(4) }, home: { ...side("Orcs", "Ann", "Orc"), score: 0, cas: 0, conceded: true } as never });
    leagues.putSeason(season(1, [...fx, forfeit], { status: "completed", endedAt: at(50) }));
    e = await earnedNow();
    expect(has(e, "unbeaten-season", "coach", "Ann")).toBe(false);
    expect(has(e, "ever-present", "coach", "Ann")).toBe(false);
  });

  it("founding coach, veteran (3 seasons, one league) and loyalist (same team lineage across 3 seasons)", async () => {
    leagues.putSeason(season(1, [game(1, 0)]));
    leagues.putSeason(season(2, [game(1, 0)]));
    let e = await earnedNow();
    expect(has(e, "founding-coach", "coach", "Ann")).toBe(true);
    expect(has(e, "veteran", "coach", "Ann")).toBe(false);
    leagues.putSeason(season(3, [game(1, 0)]));
    e = await earnedNow();
    expect(has(e, "veteran", "coach", "Ann")).toBe(true);
    expect(has(e, "loyalist", "coach", "Ann")).toBe(true);
    expect(has(e, "loyalist", "team", "Orcs")).toBe(true);
    expect(has(e, "loyalist", "coach", "Bob")).toBe(false); // Bob's Elves have no lineage id: a fresh entry each season
  });

  it("tournaments: winner, road warrior (5 tournaments), polyglot (5 races)", async () => {
    const races = ["Orc", "Human", "Dwarf", "Skaven", "Lizardmen"];
    const ts = races.map((_, i) => tournament(`t${i}`));
    const es = races.flatMap((r, i) => [entrant(`t${i}`, "Cy", 1, r), entrant(`t${i}`, "Dee", 2)]);
    const ms = races.map((_, i) => smatch(`t${i}`, i + 1, "Cy", "Dee", 2, 1));
    seedTournaments(ts, es, ms);
    const e = await earnedNow();
    expect(has(e, "tournament-winner", "coach", "Cy")).toBe(true);
    expect(has(e, "tournament-winner", "coach", "Dee")).toBe(false);
    expect(has(e, "road-warrior", "coach", "Cy")).toBe(true);
    expect(has(e, "road-warrior", "coach", "Dee")).toBe(true);
    expect(has(e, "polyglot", "coach", "Cy")).toBe(true);
    expect(has(e, "polyglot", "coach", "Dee")).toBe(false);
    // an unpublished or test tournament never counts
    seedTournaments(ts.map((t) => ({ ...t, test: true })), es, ms);
    expect((await earnedNow()).some((x) => x.subject.name === "Cy")).toBe(false);
  });

  it("club stalwart: a year as a member (current or former)", async () => {
    const club = (over: Partial<ClubRecord>): ClubRecord => ({
      id: "red", name: "Red", homeRegion: "", description: "", createdAt: at(-9000), createdBy: "Ann", updatedAt: at(-9000), revision: 1,
      members: [{ coach: "Ann", role: "admin", joinedAt: at(-9000) }, { coach: "Bob", role: "member", joinedAt: at(-24) }], requests: [],
      former: [{ coach: "Cy", joinedAt: at(-9500), leftAt: at(-100), reason: "left" }], settings: { ladderGamesCount: false, webhookEvents: { results: true, podiums: true, titles: true } }, ...over,
    });
    const e = await evaluateCatalog(await buildBadgeLedger({ leagues: new CheckedLeagueReader(dir), tournaments, clubs: { list: () => [club({})] } }, new Date(at(1000))), new Date(at(1000)));
    expect(has(e, "club-stalwart", "coach", "Ann")).toBe(true);
    expect(has(e, "club-stalwart", "coach", "Bob")).toBe(false);
    expect(has(e, "club-stalwart", "coach", "Cy")).toBe(true);
  });

  it("ladder milestones: belt holder, long reign (4 weeks), Rumble winner, ladder climber", async () => {
    const ledger: BadgeLedger = {
      games: [], seasons: [], tournamentWins: [], clubSpans: [], firstSeason: new Map(),
      ladder: [
        { kind: "reign", leagueId: "lg", ladderId: "ladder-1", teamKey: "u:t1", team: "Orcs", coachKey: "ann", coach: "Ann", at: at(0), until: at(24 * 10), link: "/x" },
        { kind: "reign", leagueId: "lg", ladderId: "ladder-1", teamKey: "u:t2", team: "Elves", coachKey: "bob", coach: "Bob", at: at(24 * 10), link: "/x" },
        { kind: "rumble", leagueId: "lg", ladderId: "ladder-1", teamKey: "u:t1", team: "Orcs", coachKey: "ann", coach: "Ann", at: at(5), link: "/x" },
        { kind: "top", leagueId: "lg", ladderId: "ladder-1", teamKey: "u:t2", team: "Elves", coachKey: "bob", coach: "Bob", at: at(6), link: "/x" },
      ],
    };
    const now = new Date(at(24 * 40));
    const e = await evaluateCatalog(ledger, now);
    expect(has(e, "belt-holder", "coach", "Ann")).toBe(true);
    expect(has(e, "belt-holder", "team", "Orcs")).toBe(true);
    expect(has(e, "long-reign", "coach", "Ann")).toBe(false); // 10 days
    expect(has(e, "long-reign", "coach", "Bob")).toBe(true); // still holding, 30 days
    expect(e.find((x) => x.badgeId === "long-reign")?.at).toBe(at(24 * 38));
    expect(has(e, "rumble-winner", "coach", "Ann")).toBe(true);
    expect(has(e, "ladder-climber", "team", "Elves")).toBe(true);
    expect(LEDGER_EVALUATORS.beltReign!({ days: 28 }, { ledger, now: new Date(at(24 * 20)), seasons: new Map() })).toEqual([]);
  });
});

describe("forfeits and administrative results never earn", () => {
  it("a forfeit win, a concession or an organiser-typed result earns nothing", async () => {
    const forfeit = game(2, 0, { forfeit: { home: false, away: true, at: at(1) }, away: { ...side("Elves", "Bob", "Wood Elf"), score: 0, cas: 0, conceded: true } as never });
    const conceded = game(1, 0, { away: { ...side("Elves", "Bob", "Wood Elf"), score: 0, cas: 0, conceded: true } as never });
    const edited = game(3, 0, { resultEdit: { by: "Org", at: at(3) } });
    const deadline = game(0, 0, { deadlineOutcome: { outcome: "both-lose", auto: true, at: at(4) } });
    leagues.putSeason(season(1, [forfeit, conceded, edited, deadline]));
    const e = await earnedNow();
    expect(e.filter((x) => x.subject.name === "Ann")).toEqual([]);
    expect(e.filter((x) => x.subject.name === "Bob")).toEqual([]);
  });
  it("tournaments: a manager's FIRST-TIME typed result counts; an edited result does not, also for the winner", async () => {
    seedTournaments([tournament("t1", { status: "active" })], [entrant("t1", "Cy", 1), entrant("t1", "Dee", 2)], [smatch("t1", 1, "Cy", "Dee", 2, 0, { result: { homeScore: 2, awayScore: 0, reportedAt: at(1), manual: true } })]);
    expect(has(await earnedNow(), "first-win", "coach", "Cy")).toBe(true);
    // the result edited by the manager (Dee now "wins" 0-1): no win for anyone, and Dee is not the tournament winner
    seedTournaments([tournament("t1")], [entrant("t1", "Cy", 1), entrant("t1", "Dee", 2)], [smatch("t1", 1, "Cy", "Dee", 0, 1, { edited: { kind: "result", byCoachId: "TOrg", at: at(2), previous: null } })]);
    const e = await earnedNow();
    expect(has(e, "first-win", "coach", "Dee")).toBe(false);
    expect(has(e, "tournament-winner", "coach", "Dee")).toBe(false);
  });
  it("a Super FUMBBL tournament game one side conceded is a forfeit (its real state, not assumed)", async () => {
    seedTournaments([tournament("t1", { status: "active" })], [entrant("t1", "Cy", 1), entrant("t1", "Dee", 2)],
      [smatch("t1", 1, "Cy", "Dee", 2, 0, { launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, gameId: "g9" } })]);
    const results = { get: (id: string) => (id === "g9" ? { teams: [{ conceded: false }, { conceded: true }] } : undefined) };
    const e = await evaluateCatalog(await buildBadgeLedger({ leagues: new CheckedLeagueReader(dir), tournaments, tournamentResults: results }, new Date(at(1000))), new Date(at(1000)));
    expect(has(e, "first-win", "coach", "Cy")).toBe(false);
  });
  it("a recorder concession is a forfeit: the published conceded match earns no win", async () => {
    const d = recorderDetail([{ type: "touchdown", team: "home", player: "a1", half: 1, payload: {} }, { type: "concede", team: "away", payload: {} }]);
    expect(d.away.conceded).toBe(true);
    const recorder = new Map([["league:lg:season-1:f1", { opId: "op1", byCoach: new Map([["ann", d.home], ["bob", d.away]]) }]]);
    leagues.putSeason(season(1, [game(1, 0, { tabletop: { revision: 1, opId: "op1" } })]));
    expect(has(await earnedNow(recorder), "first-win", "coach", "Ann")).toBe(false);
  });
  it("draft leagues and test fixtures never count", async () => {
    leagues.upsertLeague({ id: "dr", name: "Draft", fullName: "Draft", slug: "dr", organisers: ["Org"], visibility: "draft" } as never);
    leagues.putSeason(season(1, [game(1, 0)], {}, "dr"));
    leagues.putSeason(season(1, [game(1, 0, { test: true })]));
    expect(await earnedNow()).toEqual([]);
  });
});

describe("the engine: idempotent awards, revocation, announcements", () => {
  const engine = (notes: Array<[string, NotificationInput]>, posts: unknown[] = [], now = at(1000)) => new BadgeEngine({
    store: new BadgeStore(dir), sources: () => src(), notify: (c, i) => notes.push([c, i]), now: () => new Date(now),
    discord: { leagues, state: { config: () => undefined, webhook: () => undefined }, poster: async (_u, p) => { posts.push(p); return { ok: true, status: 204 }; } },
  });

  it("the first pass awards silently; later passes announce new awards once, and a second pass changes nothing", async () => {
    const notes: Array<[string, NotificationInput]> = [];
    leagues.putSeason(season(1, [game(1, 0)]));
    const first = await engine(notes).recompute();
    expect(first.silent).toBe(true);
    expect(notes).toEqual([]);
    const store = new BadgeStore(dir);
    expect(store.read().auto.some((a) => a.badgeId === "first-win" && a.subject.name === "Ann")).toBe(true);
    // Bob wins one: announced to Bob only, once
    leagues.putSeason(season(1, [game(1, 0), game(0, 2)]));
    await engine(notes).recompute();
    expect(notes.filter(([c, i]) => c === "Bob" && i.title === "Badge earned: First win")).toHaveLength(1);
    expect(notes.every(([c]) => c === "Bob")).toBe(true);
    const before = store.read();
    const again = await engine(notes).recompute();
    expect(again.awarded).toEqual([]);
    expect(again.revoked).toEqual([]);
    expect(store.read().auto).toEqual(before.auto);
    // one row per subject per badge
    const keys = store.read().auto.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(store.read().log.filter((l) => l.action === "award" && l.badgeId === "first-win" && l.subject?.name === "Bob")).toHaveLength(1);
  });

  it("a corrected result revokes what no longer holds, and logs it; a deleted fixture too", async () => {
    const notes: Array<[string, NotificationInput]> = [];
    leagues.putSeason(season(1, [game(2, 0)]));
    await engine(notes).recompute();
    const store = new BadgeStore(dir);
    expect(store.read().auto.some((a) => a.badgeId === "clean-sheet" && a.subject.name === "Ann")).toBe(true);
    // the organiser corrects 2-0 to 2-1 through a recorded path (no resultEdit): clean sheet no longer holds
    n = 0;
    leagues.putSeason(season(1, [game(2, 1)]));
    const out = await engine(notes).recompute();
    expect(out.revoked.map((a) => `${a.badgeId}:${a.subject.name}`)).toContain("clean-sheet:Ann");
    expect(store.read().auto.some((a) => a.badgeId === "clean-sheet")).toBe(false);
    expect(store.read().auto.some((a) => a.badgeId === "first-win" && a.subject.name === "Ann")).toBe(true);
    expect(store.read().log.find((l) => l.action === "revoke" && l.badgeId === "clean-sheet" && l.subject?.kind === "coach")).toMatchObject({ by: "", subject: { kind: "coach", name: "Ann" } });
    // the fixture is deleted: every award from it goes
    leagues.putSeason(season(1, []));
    await engine(notes).recompute();
    expect(store.read().auto.filter((a) => a.subject.name === "Ann")).toEqual([]);
    // an override by an organiser (resultEdit) counts as administrative: nothing comes back
    leagues.putSeason(season(1, [game(2, 0, { resultEdit: { by: "Org", at: at(1) } })]));
    await engine(notes).recompute();
    expect(store.read().auto.filter((a) => a.subject.name === "Ann")).toEqual([]);
  });

  it("Discord: nothing posts while the event is off (the default); on, the league channel gets one cleaned post", async () => {
    const notes: Array<[string, NotificationInput]> = [];
    const posts: Array<{ embeds: Array<{ title: string; description: string }> }> = [];
    leagues.putSeason(season(1, []));
    await engine(notes, posts).recompute(); // initialise
    leagues.setSecrets("lg", { discordWebhookUrl: "https://discord.com/api/webhooks/12345678/abcdefghijklmnopqrstuvwxyz" } as never);
    leagues.putSeason(season(1, [game(1, 0)]));
    await engine(notes, posts).recompute();
    expect(posts).toEqual([]);
    leagues.updateLeague("lg", (l) => { l.discordEvents = { ...(l.discordEvents ?? {}), badgeEarned: true }; });
    leagues.putSeason(season(1, [game(1, 0), game(0, 3)]));
    await engine(notes, posts).recompute();
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.every((p) => p.embeds[0]!.title.includes("Test League"))).toBe(true);
    expect(posts.some((p) => p.embeds[0]!.description.includes("Bob earned **First win**"))).toBe(true);
  });

  it("an unreadable badge file fails closed: the pass throws and nothing is written", async () => {
    mkdirSync(join(dir, "badges"), { recursive: true });
    writeFileSync(join(dir, "badges", "badges.json"), "{ not json");
    leagues.putSeason(season(1, [game(1, 0)]));
    await expect(engine([]).recompute()).rejects.toThrow(/unavailable/);
  });

  it("a coach under deletion is neither awarded nor revoked by the engine; a deleted coach's pseudonym never earns", async () => {
    const file = { version: 1 as const, seeded: [], auto: [], leagues: {}, log: [] };
    const earned: Earned[] = [{ key: "first-win||coach|ann", badgeId: "first-win", subject: { kind: "coach", key: "ann", name: "Ann" }, at: at(1), context: {} }];
    expect(diffAwards(file, earned, new Date(), (c) => c === "Ann").add).toEqual([]);
    leagues.putSeason(season(1, [game(1, 0, { home: { ...side("Orcs", "Deleted coach #3", "Orc"), score: 1, cas: 1 } as never })]));
    expect((await earnedNow()).some((x) => x.subject.name.startsWith("Deleted coach"))).toBe(false);
  });
});

describe("ladders through the real ladder engine", () => {
  it("a crowned belt holder earns Belt holder; the first team to reach number 1 earns Ladder climber", async () => {
    const { leagueApi } = await import("../src/leagues/api.js");
    const { runLadderJob } = await import("../src/leagues/ladderJob.js");
    const time = { now: new Date("2026-11-10T12:00:00.000Z") };
    leagues.upsertLeague({ id: "lg", name: "Test League", fullName: "Test League", slug: "lg", organisers: ["Olga"], owner: "Olga" } as never);
    const OLGA = { coach: "Olga", admin: false, organizer: true };
    const call = async (method: string, path: string, body?: unknown) => (await leagueApi(method, path, new URLSearchParams(), OLGA, {
      store: leagues, readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))), now: () => time.now,
      identities: () => [{ coach: "Olga", level: "organizer" }], notify: () => undefined,
    } as never))!;
    const created = await call("POST", "/api/leagues/lg/ladders", { name: "Spring", ranking: "points" });
    const id = (created.body as { id: string }).id;
    expect((await call("PATCH", `/api/leagues/lg/ladders/${id}`, { revision: leagues.season("lg", id)!.revision, settings: { titles: { belt: true } } })).status).toBe(200);
    expect((await call("POST", `/api/leagues/lg/ladders/${id}/start`, {})).status).toBe(200);
    const lad = leagues.season("lg", id)!;
    for (const [i, c] of ["Amy", "Bob", "Cara", "Dan"].entries()) {
      lad.teams.push(team(`t-${c.toLowerCase()}`, `${c}'s team`, c, "Human", { teamUid: `tm-${c}` }));
      lad.ladder!.members.push({ teamId: `t-${c.toLowerCase()}`, joinedAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i * 1000).toISOString(), via: "organiser" } as never);
    }
    const res = (h: string, a: string, hs: number, as: number, when: string) => {
      const l = leagues.season("lg", id)!;
      const t = (c: string) => l.teams.find((x) => x.coach === c)!;
      const s = (x: LeagueTeam, score: number) => ({ team: x.name, teamId: x.id, coach: x.coach, coachId: x.coachId, race: x.race, score, cas: 0, conceded: false });
      l.fixtures.push({ id: `f-${l.fixtures.length + 1}`, category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: s(t(h), hs), away: s(t(a), as), suspended: false, finishedAt: when });
      leagues.putSeason(l);
    };
    leagues.putSeason(lad);
    res("Amy", "Bob", 3, 0, "2026-11-05T10:00:00.000Z");
    res("Cara", "Dan", 2, 0, "2026-11-05T11:00:00.000Z");
    runLadderJob({ store: leagues, notify: () => undefined, now: () => time.now });
    const l = leagues.season("lg", id)!;
    const vacant = (l.ladder!.titles?.bouts ?? []).find((b) => b.state === "scheduled" && b.kind === "vacant")!;
    const f = l.fixtures.find((x) => x.id === vacant.fixtureId)!;
    f.home.score = 1; f.away.score = 0; f.finishedAt = "2026-11-10T12:01:00.000Z";
    leagues.putSeason(l);
    runLadderJob({ store: leagues, notify: () => undefined, now: () => time.now });
    const ledger = await buildBadgeLedger({ leagues: new CheckedLeagueReader(dir), tournaments }, time.now);
    const e = await evaluateCatalog(ledger, time.now);
    expect(has(e, "belt-holder", "coach", "Amy")).toBe(true);
    expect(has(e, "belt-holder", "team", "Amy's team")).toBe(true);
    expect(has(e, "ladder-climber", "coach", "Amy")).toBe(true);
    expect(has(e, "belt-holder", "coach", "Bob")).toBe(false);
    expect(has(e, "first-win", "coach", "Amy")).toBe(true); // ladder games count like any other
    // P2-3: Carol takes the team over afterwards: the reign stays Amy's (the coach of record when it was won)
    const after = leagues.season("lg", id)!;
    const amyTeam = after.teams.find((t) => t.coach === "Amy")!;
    amyTeam.coach = "Carol"; amyTeam.coachId = "Carol";
    leagues.putSeason(after);
    const e2 = await evaluateCatalog(await buildBadgeLedger({ leagues: new CheckedLeagueReader(dir), tournaments }, time.now), time.now);
    expect(has(e2, "belt-holder", "coach", "Amy")).toBe(true);
    expect(has(e2, "belt-holder", "coach", "Carol")).toBe(false);
    expect(has(e2, "ladder-climber", "coach", "Carol")).toBe(false);
    // P2-4: the title game's result overridden by an organiser: titles replay from counted fixtures only, so no reign
    const ov = leagues.season("lg", id)!;
    ov.fixtures.find((x) => x.id === vacant.fixtureId)!.resultEdit = { by: "Olga", at: "2026-11-10T12:02:00.000Z" };
    leagues.putSeason(ov);
    const e3 = await evaluateCatalog(await buildBadgeLedger({ leagues: new CheckedLeagueReader(dir), tournaments }, time.now), time.now);
    expect(e3.some((x) => x.badgeId === "belt-holder")).toBe(false);
  });
});

describe("review fixes (Sol 11-04)", () => {
  const engine = (opts: { notes?: Array<[string, NotificationInput]>; posts?: unknown[]; sources?: () => unknown } = {}) => new BadgeEngine({
    store: new BadgeStore(dir), sources: (opts.sources ?? (() => src())) as never, notify: (c, i) => opts.notes?.push([c, i]), now: () => new Date(at(1000)),
    discord: { leagues, state: { config: () => undefined, webhook: () => undefined }, poster: async (_u, p) => { opts.posts?.push(p); return { ok: true, status: 204 }; } },
  });

  it("P2-0: an unreadable season aborts the pass: nothing is revoked, nothing is written", async () => {
    leagues.putSeason(season(1, [game(2, 0)]));
    await engine().recompute();
    const store = new BadgeStore(dir);
    const before = JSON.stringify(store.read());
    writeFileSync(join(dir, "leagues", "lg", "seasons", "season-1.json"), "{ torn");
    await expect(engine().recompute()).rejects.toThrow(/unparsable|unreadable/);
    expect(JSON.stringify(store.read())).toBe(before);
    expect(store.read().auto.some((a) => a.subject.name === "Ann")).toBe(true);
  });

  it("P2-1: an unreadable recorder match file aborts the pass", async () => {
    const { FileTabletopRepository } = await import("../src/tabletop/store.js");
    const { recorderSource } = await import("../src/badges/engine.js");
    const repo = new FileTabletopRepository(join(dir, "tabletop"));
    writeFileSync(join(dir, "tabletop", "matches", "tm1.json"), "{ torn");
    await expect(recorderSource((e) => e)(repo as never)).rejects.toThrow(/unreadable/);
  });

  it("P2-1: an award revoked and then restored is never announced twice", async () => {
    const notes: Array<[string, NotificationInput]> = [];
    leagues.putSeason(season(1, []));
    await engine({ notes }).recompute(); // initialise
    leagues.putSeason(season(1, [game(0, 1)]));
    await engine({ notes }).recompute();
    leagues.putSeason(season(1, []));
    await engine({ notes }).recompute(); // revoked
    leagues.putSeason(season(1, [game(0, 1)]));
    await engine({ notes }).recompute(); // restored
    expect(notes.filter(([c, i]) => c === "Bob" && i.title === "Badge earned: First win")).toHaveLength(1);
    expect(new BadgeStore(dir).read().auto.some((a) => a.badgeId === "first-win" && a.subject.name === "Bob")).toBe(true);
  });

  it("P2-8: a coach fenced for deletion while the announcements run gets no notice and no post", async () => {
    const notes: Array<[string, NotificationInput]> = [];
    const posts: unknown[] = [];
    leagues.putSeason(season(1, []));
    await engine().recompute();
    leagues.setSecrets("lg", { discordWebhookUrl: "https://discord.com/api/webhooks/12345678/abcdefghijklmnopqrstuvwxyz" } as never);
    leagues.updateLeague("lg", (l) => { l.discordEvents = { ...(l.discordEvents ?? {}), badgeEarned: true }; });
    let fenced = false;
    // Ann's notice goes first; it flips the fence for Bob before Bob's turn comes
    const e = new BadgeEngine({
      store: new BadgeStore(dir), sources: () => src() as never, now: () => new Date(at(1000)), isFenced: (c) => fenced && c === "Bob",
      notify: (c, i) => { notes.push([c, i]); fenced = true; },
      discord: { leagues, state: { config: () => undefined, webhook: () => undefined }, poster: async (_u, p) => { posts.push(p); return { ok: true, status: 204 }; } },
    });
    leagues.putSeason(season(1, [game(1, 0), game(0, 1)]));
    await e.recompute();
    expect(notes.some(([c]) => c === "Ann")).toBe(true);
    expect(notes.some(([c]) => c === "Bob")).toBe(false);
    expect(JSON.stringify(posts)).not.toContain("Bob");
  });

  it("P2-2: only result-changing writes recompute; recorder in-game events never do", async () => {
    const { badgeKickPath } = await import("../src/badges/kick.js");
    for (const p of ["/api/tabletop/matches/tm1/events", "/api/tabletop/matches/tm1/turn/end", "/api/tabletop/matches/tm1/pregame/advance", "/api/tabletop/matches/tm1/dice/roll",
      "/api/leagues/lg/settings", "/api/leagues/lg/board", "/api/leagues/lg/seasons/season-1/news"]) expect(badgeKickPath("POST", p), p).toBe(false);
    for (const p of ["/api/tabletop/matches/tm1/publish", "/api/tabletop/matches/tm1/confirm", "/api/tabletop/matches/tm1/undo-revision", "/api/scheduled-matches/m1/result",
      "/api/tournaments/t1/fixtures/m1/result/clear", "/api/tournaments/t1/finish", "/api/leagues/lg/tourplay/apply", "/api/leagues/lg/seasons/season-1/finish",
      "/api/leagues/lg/seasons/season-1/fixtures/f1", "/api/leagues/lg/ladders/ladder-1/rounds"]) expect(badgeKickPath("POST", p), p).toBe(true);
    expect(badgeKickPath("GET", "/api/tabletop/matches/tm1/publish")).toBe(false);
  });

  it("P2-2: passes coalesce: at most one runs at a time, with one trailing rerun", async () => {
    let running = 0; let most = 0; let calls = 0;
    const e = engine({ sources: async () => { calls += 1; running += 1; most = Math.max(most, running); await new Promise((r) => setTimeout(r, 30)); running -= 1; return src(); } });
    leagues.putSeason(season(1, [game(1, 0)]));
    await Promise.all([e.tick(), e.tick(), e.tick(), e.tick()]);
    expect(most).toBe(1);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("P2-2: a large history evaluates within bounds and never blocks the event loop for long", async () => {
    const coaches = Array.from({ length: 400 }, (_, i) => `Coach${i}`);
    const races = ["Orc", "Human", "Dwarf", "Skaven", "Lizardmen", "Wood Elf", "Undead", "Chaos"];
    const lgs = Array.from({ length: 30 }, (_, i) => ({ id: `lg${i}`, name: `League ${i}`, organisers: [], visibility: "published" }));
    let k = 0;
    const seasonsOf = new Map(lgs.map((l, li) => [l.id, Array.from({ length: 4 }, (_, si) => {
      const teams = Array.from({ length: 16 }, (_, ti) => team(`t${ti}`, `Team ${li}-${ti}`, coaches[(li * 13 + ti * 7 + si) % coaches.length]!, races[ti % races.length]!, { teamUid: `u-${li}-${ti}` }));
      const fixtures: LeagueFixture[] = Array.from({ length: 120 }, (_, fi) => {
        const h = teams[fi % 16]!;
        const a = teams[(fi % 16 + 1 + (fi % 15)) % 16]!;
        k += 1;
        return {
          id: `f${fi}`, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: fi, table: 1, suspended: false, finishedAt: new Date(T0 + k * 60_000).toISOString(),
          home: { team: h.name, teamId: h.id, coach: h.coach, coachId: h.coachId, race: h.race, score: k % 4, cas: k % 5, conceded: false },
          away: { team: a.name, teamId: a.id, coach: a.coach, coachId: a.coachId, race: a.race, score: (k * 7) % 3, cas: k % 3, conceded: false },
        };
      });
      return season(si + 1, fixtures, { status: si < 3 ? "completed" : "active", ...(si < 3 ? { endedAt: at(si * 1000 + 900) } : {}), teams } as never, l.id);
    })]));
    const big = { leagues: { list: () => lgs as never, competitions: (id: string) => seasonsOf.get(id) ?? [] }, tournaments };
    let maxGap = 0; let last = performance.now();
    const timer = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 1);
    const t0 = performance.now();
    const out = await engine({ sources: () => big }).recompute();
    const took = performance.now() - t0;
    clearInterval(timer);
    expect(out.silent).toBe(true);
    expect(new BadgeStore(dir).read().auto.length).toBeGreaterThan(1000);
    expect(took).toBeLessThan(20_000);
    expect(maxGap).toBeLessThan(250); // slices are 40 ms; the bound leaves room for a loaded test machine
  }, 60_000);
});
