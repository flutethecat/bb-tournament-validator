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
const src = (recorder?: Map<string, RecorderResult>) => ({ leagues, tournaments, clubs, ...(recorder ? { recorder } : {}) });
const earnedNow = (recorder?: Map<string, RecorderResult>): Earned[] => evaluateCatalog(buildBadgeLedger(src(recorder), new Date(at(1000))), new Date(at(1000)));
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
  it("is data: every entry has an evaluator, a known icon and valid fields; ids are unique", () => {
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
  it("icons are our own glyphs (text, never image files)", () => {
    for (const v of Object.values(BADGE_ICONS)) { expect(v.glyph).not.toMatch(/[/.]/); expect(v.glyph.length).toBeGreaterThan(0); }
  });
  it("the Badge earned Discord event exists and is off by default for leagues and tournaments", () => {
    expect(defaultEvents("league").badgeEarned).toBe(false);
    expect(defaultEvents("tournament").badgeEarned).toBe(false);
  });
});

describe("evaluators", () => {
  it("first win, clean sheet, meat grinder, iron wall: coach and team; the loser earns none of the win badges", () => {
    leagues.putSeason(season(1, [game(2, 0, { hc: 3, ac: 0 })]));
    const e = earnedNow();
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

  it("games tiers, 5-win streak (a loss resets it), shutout run of 3", () => {
    const fx = [game(1, 0), game(1, 0), game(0, 1), game(1, 0), game(1, 0), game(1, 0), game(1, 0), game(2, 0), game(1, 1), game(1, 1)];
    leagues.putSeason(season(1, fx));
    const e = earnedNow();
    expect(has(e, "games-10", "coach", "Ann")).toBe(true);
    expect(has(e, "games-50", "coach", "Ann")).toBe(false);
    const streak = e.find((x) => x.badgeId === "win-streak-5" && x.subject.name === "Ann");
    expect(streak?.context.gameId).toBe("l:lg:season-1:f8"); // games 4-8
    expect(has(e, "shutout-defence", "coach", "Ann")).toBe(true);
    expect(has(e, "win-streak-5", "coach", "Bob")).toBe(false);
  });

  it("detail achievements need the detail: Super FUMBBL lines give hat-trick and pass master; a plain score gives none", () => {
    const fork = (td: number, comp: number) => ({
      status: "finished", teams: {}, log: [],
      result: {
        gameId: "g1", source: "full", appliedAt: at(1),
        home: { score: 3, cas: 0, conceded: false, winnings: 0, lines: [{ forkPlayerId: "p1", name: "A", td, cas: 0, completions: comp, interceptions: 0, mvp: 0, fouls: 0, injuries: [] }] },
        away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [] },
      },
    });
    leagues.putSeason(season(1, [game(3, 0, { fork: fork(3, 3) as never }), game(4, 0)]));
    const e = earnedNow();
    expect(has(e, "hat-trick", "coach", "Ann")).toBe(true);
    expect(has(e, "pass-master", "coach", "Ann")).toBe(true);
    expect(e.find((x) => x.badgeId === "hat-trick" && x.subject.name === "Ann")?.context.gameId).toBe("l:lg:season-1:f1");
    leagues.putSeason(season(1, [game(5, 0)]));
    expect(has(earnedNow(), "hat-trick", "coach", "Ann")).toBe(false);
  });

  it("recorder detail: comeback (trailing at half-time), foul play, Nuffle's Favourite; only for the op the fixture holds", () => {
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
    const e = earnedNow(recorder);
    expect(has(e, "comeback", "coach", "Ann")).toBe(true);
    expect(has(e, "foul-play", "coach", "Ann")).toBe(true);
    expect(has(e, "nuffles-favourite", "coach", "Ann")).toBe(true);
    expect(has(e, "comeback", "coach", "Bob")).toBe(false);
    // a fixture whose result came from elsewhere (a different op) never reads that match's detail
    n = 0;
    leagues.putSeason(season(1, [game(2, 1, { tabletop: { revision: 2, opId: "op2" } })]));
    expect(has(earnedNow(recorder), "comeback", "coach", "Ann")).toBe(false);
  });

  it("a placeholder that needs recorder data is never awarded", () => {
    leagues.putSeason(season(1, Array.from({ length: 12 }, () => game(3, 0, { hc: 4, ac: 0 }))));
    expect(earnedNow().some((x) => x.badgeId === "underdog")).toBe(false);
  });

  it("unbeaten season and ever present need a FINISHED season; a forfeit loss breaks unbeaten", () => {
    const fx = [game(1, 0), game(1, 1), game(2, 0)];
    leagues.putSeason(season(1, fx));
    expect(has(earnedNow(), "unbeaten-season", "coach", "Ann")).toBe(false);
    leagues.putSeason(season(1, fx, { status: "completed", endedAt: at(50) }));
    let e = earnedNow();
    expect(has(e, "unbeaten-season", "coach", "Ann")).toBe(true);
    expect(has(e, "unbeaten-season", "team", "Orcs")).toBe(true);
    expect(has(e, "ever-present", "coach", "Ann")).toBe(true);
    expect(has(e, "ever-present", "coach", "Bob")).toBe(true);
    expect(e.find((x) => x.badgeId === "unbeaten-season" && x.subject.name === "Ann")?.at).toBe(at(50));
    // Ann forfeits a fourth game: no longer unbeaten, and no longer ever present (a forfeit is not a game played)
    n = 3;
    const forfeit = game(0, 2, { forfeit: { home: true, away: false, at: at(4) }, home: { ...side("Orcs", "Ann", "Orc"), score: 0, cas: 0, conceded: true } as never });
    leagues.putSeason(season(1, [...fx, forfeit], { status: "completed", endedAt: at(50) }));
    e = earnedNow();
    expect(has(e, "unbeaten-season", "coach", "Ann")).toBe(false);
    expect(has(e, "ever-present", "coach", "Ann")).toBe(false);
  });

  it("founding coach, veteran (3 seasons, one league) and loyalist (same team lineage across 3 seasons)", () => {
    leagues.putSeason(season(1, [game(1, 0)]));
    leagues.putSeason(season(2, [game(1, 0)]));
    let e = earnedNow();
    expect(has(e, "founding-coach", "coach", "Ann")).toBe(true);
    expect(has(e, "veteran", "coach", "Ann")).toBe(false);
    leagues.putSeason(season(3, [game(1, 0)]));
    e = earnedNow();
    expect(has(e, "veteran", "coach", "Ann")).toBe(true);
    expect(has(e, "loyalist", "coach", "Ann")).toBe(true);
    expect(has(e, "loyalist", "team", "Orcs")).toBe(true);
    expect(has(e, "loyalist", "coach", "Bob")).toBe(false); // Bob's Elves have no lineage id: a fresh entry each season
  });

  it("tournaments: winner, road warrior (5 tournaments), polyglot (5 races)", () => {
    const races = ["Orc", "Human", "Dwarf", "Skaven", "Lizardmen"];
    const ts = races.map((_, i) => tournament(`t${i}`));
    const es = races.flatMap((r, i) => [entrant(`t${i}`, "Cy", 1, r), entrant(`t${i}`, "Dee", 2)]);
    const ms = races.map((_, i) => smatch(`t${i}`, i + 1, "Cy", "Dee", 2, 1));
    seedTournaments(ts, es, ms);
    const e = earnedNow();
    expect(has(e, "tournament-winner", "coach", "Cy")).toBe(true);
    expect(has(e, "tournament-winner", "coach", "Dee")).toBe(false);
    expect(has(e, "road-warrior", "coach", "Cy")).toBe(true);
    expect(has(e, "road-warrior", "coach", "Dee")).toBe(true);
    expect(has(e, "polyglot", "coach", "Cy")).toBe(true);
    expect(has(e, "polyglot", "coach", "Dee")).toBe(false);
    // an unpublished or test tournament never counts
    seedTournaments(ts.map((t) => ({ ...t, test: true })), es, ms);
    expect(earnedNow().some((x) => x.subject.name === "Cy")).toBe(false);
  });

  it("club stalwart: a year as a member (current or former)", () => {
    const club = (over: Partial<ClubRecord>): ClubRecord => ({
      id: "red", name: "Red", homeRegion: "", description: "", createdAt: at(-9000), createdBy: "Ann", updatedAt: at(-9000), revision: 1,
      members: [{ coach: "Ann", role: "admin", joinedAt: at(-9000) }, { coach: "Bob", role: "member", joinedAt: at(-24) }], requests: [],
      former: [{ coach: "Cy", joinedAt: at(-9500), leftAt: at(-100), reason: "left" }], settings: { ladderGamesCount: false, webhookEvents: { results: true, podiums: true, titles: true } }, ...over,
    });
    const e = evaluateCatalog(buildBadgeLedger({ leagues, tournaments, clubs: { list: () => [club({})] } }, new Date(at(1000))), new Date(at(1000)));
    expect(has(e, "club-stalwart", "coach", "Ann")).toBe(true);
    expect(has(e, "club-stalwart", "coach", "Bob")).toBe(false);
    expect(has(e, "club-stalwart", "coach", "Cy")).toBe(true);
  });

  it("ladder milestones: belt holder, long reign (4 weeks), Rumble winner, ladder climber", () => {
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
    const e = evaluateCatalog(ledger, now);
    expect(has(e, "belt-holder", "coach", "Ann")).toBe(true);
    expect(has(e, "belt-holder", "team", "Orcs")).toBe(true);
    expect(has(e, "long-reign", "coach", "Ann")).toBe(false); // 10 days
    expect(has(e, "long-reign", "coach", "Bob")).toBe(true); // still holding, 30 days
    expect(e.find((x) => x.badgeId === "long-reign")?.at).toBe(at(24 * 38));
    expect(has(e, "rumble-winner", "coach", "Ann")).toBe(true);
    expect(has(e, "ladder-climber", "team", "Elves")).toBe(true);
    expect(LEDGER_EVALUATORS.beltReign!({ days: 28 }, { ledger, now: new Date(at(24 * 20)) })).toEqual([]);
  });
});

describe("forfeits and administrative results never earn", () => {
  it("a forfeit win, a concession or an organiser-typed result earns nothing", () => {
    const forfeit = game(2, 0, { forfeit: { home: false, away: true, at: at(1) }, away: { ...side("Elves", "Bob", "Wood Elf"), score: 0, cas: 0, conceded: true } as never });
    const conceded = game(1, 0, { away: { ...side("Elves", "Bob", "Wood Elf"), score: 0, cas: 0, conceded: true } as never });
    const edited = game(3, 0, { resultEdit: { by: "Org", at: at(3) } });
    const deadline = game(0, 0, { deadlineOutcome: { outcome: "both-lose", auto: true, at: at(4) } });
    leagues.putSeason(season(1, [forfeit, conceded, edited, deadline]));
    const e = earnedNow();
    expect(e.filter((x) => x.subject.name === "Ann")).toEqual([]);
    expect(e.filter((x) => x.subject.name === "Bob")).toEqual([]);
  });
  it("a tournament result typed by an organiser earns nothing", () => {
    seedTournaments([tournament("t1", { status: "active" })], [entrant("t1", "Cy", 1), entrant("t1", "Dee", 2)], [smatch("t1", 1, "Cy", "Dee", 2, 0, { result: { homeScore: 2, awayScore: 0, reportedAt: at(1), manual: true } })]);
    expect(earnedNow()).toEqual([]);
  });
  it("draft leagues and test fixtures never count", () => {
    leagues.upsertLeague({ id: "dr", name: "Draft", fullName: "Draft", slug: "dr", organisers: ["Org"], visibility: "draft" } as never);
    leagues.putSeason(season(1, [game(1, 0)], {}, "dr"));
    leagues.putSeason(season(1, [game(1, 0, { test: true })]));
    expect(earnedNow()).toEqual([]);
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

  it("a coach under deletion is neither awarded nor revoked by the engine; a deleted coach's pseudonym never earns", () => {
    const file = { version: 1 as const, seeded: [], auto: [], leagues: {}, log: [] };
    const earned: Earned[] = [{ key: "first-win||coach|ann", badgeId: "first-win", subject: { kind: "coach", key: "ann", name: "Ann" }, at: at(1), context: {} }];
    expect(diffAwards(file, earned, new Date(), (c) => c === "Ann").add).toEqual([]);
    leagues.putSeason(season(1, [game(1, 0, { home: { ...side("Orcs", "Deleted coach #3", "Orc"), score: 1, cas: 1 } as never })]));
    expect(earnedNow().some((x) => x.subject.name.startsWith("Deleted coach"))).toBe(false);
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
    const ledger = buildBadgeLedger({ leagues, tournaments }, time.now);
    const e = evaluateCatalog(ledger, time.now);
    expect(has(e, "belt-holder", "coach", "Amy")).toBe(true);
    expect(has(e, "belt-holder", "team", "Amy's team")).toBe(true);
    expect(has(e, "ladder-climber", "coach", "Amy")).toBe(true);
    expect(has(e, "belt-holder", "coach", "Bob")).toBe(false);
    expect(has(e, "first-win", "coach", "Amy")).toBe(true); // ladder games count like any other
  });
});
