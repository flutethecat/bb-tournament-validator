import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClubObserver } from "../src/clubs/observer.js";
import { clubLedger, clubStats, countedGames } from "../src/clubs/stats.js";
import { ClubStore } from "../src/clubs/store.js";
import type { ClubRecord } from "../src/clubs/types.js";
import { DiscordStateStore } from "../src/discord/store.js";
import type { DiscordPayload } from "../src/leagues/discord.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeagueFixture, SeasonRecord } from "../src/leagues/types.js";
import type { NotificationInput } from "../src/notifications.js";
import { TournamentStore } from "../src/tournaments/store.js";

// Club stats (wizards v2 Q15 + round 3, ladder spec Q9): each game counts for the club the coach represented IN THAT
// competition; only authorised, published, non-test competitions; ladder games only with ladderGamesCount; leavers' games
// stay; takeovers never move a game. The club observer posts members' results, podiums and titles to the club webhook and
// tells opted-in clubmates of wins, never replaying history, never a draft, never an organiser-entered result.

let dir: string;
let leagues: LeagueStore;
let tournaments: TournamentStore;
let clubs: ClubStore;
const at = (h: number) => new Date(Date.parse("2026-11-01T12:00:00.000Z") + h * 3_600_000).toISOString();

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const played = (id: string, hs: number, as: number, over: Partial<LeagueFixture> = {}): LeagueFixture => {
  const base = fx(id, over);
  return { ...base, home: { ...base.home, score: hs, cas: 1 }, away: { ...base.away, score: as, cas: 0 }, finishedAt: at(-10), ...over, ...(over.home ? {} : {}) };
};
const reg = (coach: string, clubId: string | undefined, state = "accepted") => ({
  id: `lr-${coach}`, leagueId: "lg", seasonId: "season-1", coach, state, submittedAt: at(-100), enteredAt: at(-100),
  registrationLog: [{ action: "submit", from: null, to: state, by: coach, at: at(-100) }], race: "Orc", teamName: `${coach} XI`, teamRef: "save:x",
  kind: "new", teamSnapshot: { teamName: "x", race: "Orc", rerolls: 0, apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, cost: 0, players: [] },
  validation: { ok: true, problems: [], checkedAt: at(-100) }, ...(clubId ? { clubId } : {}),
});
const season = (id: string, fixtures: LeagueFixture[], extra: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id, leagueId: "lg", number: Number(id.split("-")[1]) || 1, name: `Season ${id.split("-")[1]}`, sourceSlug: id, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }], fixtures,
  teams: [
    { id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", coachId: "Ann", players: [], formerPlayers: [], teamValue: null, treasury: null, rerolls: null } as never,
    { id: "elves", name: "Elves", race: "Wood Elf", coach: "Bob", coachId: "Bob", players: [], formerPlayers: [], teamValue: null, treasury: null, rerolls: null } as never,
  ],
  participants: [], honours: [], awards: [], unattributedStats: [], importedAt: at(-500), source: "manual",
  registrations: [reg("Ann", "red"), reg("Bob", "blue")] as never, ...extra,
});

const tournament = (id: string, extra: Record<string, unknown> = {}) => ({
  id, name: `Cup ${id}`, status: "completed", format: "swiss", packageName: "test-cup", maxPlayers: 8, roundCount: 1, currentRound: 1,
  tiebreakers: [], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "TOrg", organizerCoachIds: [], createdAt: at(-200), updatedAt: at(-1), ...extra,
});
const ident = (c: string) => ({ coachId: c, ffbCoachId: c, verifiedAt: at(-300) });
const entrant = (tid: string, coach: string, seed: number, clubId?: string) => ({
  id: `${tid}:${coach}`, tournamentId: tid, seed, coach: ident(coach), teamId: `team-${coach}`, registeredAt: at(-100),
  submission: { saveId: "save:x", revision: "r", submittedAt: "", teamName: `${coach} Team`, race: "Orc", snapshot: null, validation: { ok: true, problems: [], checkedAt: "", packageName: "test-cup" } },
  ...(clubId ? { clubId } : {}),
});
const smatch = (tid: string, n: number, home: string, away: string, hs: number, as: number, extra: Record<string, unknown> = {}) => ({
  id: `${tid}:m${n}`, tournamentId: tid, roundId: `${tid}:r1`, roundNumber: 1,
  home: { entrantId: `${tid}:${home}`, coach: ident(home), teamId: `team-${home}` }, away: { entrantId: `${tid}:${away}`, coach: ident(away), teamId: `team-${away}` },
  status: "completed", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  result: { homeScore: hs, awayScore: as, homeCasualties: 2, awayCasualties: 1, reportedAt: at(-5) }, createdAt: at(-50), updatedAt: at(-5), ...extra,
});
function seedTournaments(ts: Array<ReturnType<typeof tournament>>, entrants: Array<ReturnType<typeof entrant>>, matches: Array<ReturnType<typeof smatch>>): void {
  tournaments.writeSnapshot({
    version: 4, tournaments: Object.fromEntries(ts.map((t) => [t.id, t])), entrants: Object.fromEntries(entrants.map((e) => [e.id, e])),
    rounds: {}, standings: {}, scheduledMatches: Object.fromEntries(matches.map((m) => [m.id, m])), waitingPresence: {},
  } as never);
}
const club = (id: string, over: Partial<ClubRecord> = {}): ClubRecord => ({
  id, name: `${id} club`, homeRegion: "", description: "", createdAt: at(-1000), createdBy: "Ann", updatedAt: at(-1000), revision: 1,
  members: [{ coach: "Ann", role: "admin", joinedAt: at(-1000) }], requests: [], former: [],
  settings: { ladderGamesCount: false, webhookEvents: { results: true, podiums: true, titles: true } }, ...over,
});
const src = () => ({ tournaments, leagues });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "club-stats-"));
  leagues = new LeagueStore(dir);
  leagues.upsertLeague({ id: "lg", name: "Test League", fullName: "Test League", slug: "lg", organisers: ["Org"] } as never);
  tournaments = new TournamentStore(join(dir, "tournaments"));
  seedTournaments([], [], []);
  clubs = new ClubStore(dir);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("attribution per competition choice", () => {
  it("a tournament game counts for the club each side picked; no pick = no club; one row per member side", () => {
    seedTournaments([tournament("t1")], [entrant("t1", "Ann", 1, "red"), entrant("t1", "Bob", 2, "blue"), entrant("t1", "Cy", 3)],
      [smatch("t1", 1, "Ann", "Bob", 2, 1), smatch("t1", 2, "Cy", "Ann", 0, 0)]);
    const ledger = clubLedger(src());
    const red = countedGames(club("red"), ledger);
    expect(red.map((g) => [g.member.coach, g.opponent.coach, g.result, g.score])).toEqual([
      ["Ann", "Bob", "win", { for: 2, against: 1 }], ["Ann", "Cy", "draw", { for: 0, against: 0 }],
    ]);
    expect(red[0]).toMatchObject({ kind: "tournament", competitionName: "Cup t1", link: "/tournaments/t1", opponent: { clubId: "blue" }, cas: { for: 2, against: 1 } });
    expect(countedGames(club("blue"), ledger).map((g) => g.result)).toEqual(["loss"]);
    expect([...ledger.games.keys()].sort()).toEqual(["blue", "red"]);
  });

  it("a multi-club coach's games go to the club picked in each competition, not to every club", () => {
    seedTournaments(
      [tournament("t1"), tournament("t2")],
      [entrant("t1", "Ann", 1, "red"), entrant("t1", "Bob", 2), entrant("t2", "Ann", 1, "green"), entrant("t2", "Bob", 2)],
      [smatch("t1", 1, "Ann", "Bob", 1, 0), smatch("t2", 1, "Ann", "Bob", 0, 3)],
    );
    const ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger).map((g) => [g.competitionId, g.result])).toEqual([["t1", "win"]]);
    expect(countedGames(club("green"), ledger).map((g) => [g.competitionId, g.result])).toEqual([["t2", "loss"]]);
  });

  it("league games follow the season registration pick and the coach who played (a takeover never moves a game)", () => {
    leagues.putSeason(season("season-1", [played("f1", 2, 1)]));
    let ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger).map((g) => [g.member.coach, g.result, g.seasonName])).toEqual([["Ann", "win", "Season 1"]]);
    expect(countedGames(club("blue"), ledger).map((g) => g.result)).toEqual(["loss"]);
    // the Orcs change hands to Cy (no club pick) after the game: the played game stays Ann's / red's
    const s = leagues.season("lg", "season-1")!;
    s.teams[0]!.coach = "Cy"; s.teams[0]!.coachId = "Cy";
    s.fixtures[0]!.home.coach = "Cy"; s.fixtures[0]!.home.coachId = "Cy";
    s.fixtures.push(played("f2", 3, 0, { home: { ...fx("f2").home, coach: "Cy", coachId: "Cy", score: 3, cas: 0 } }));
    leagues.putSeason(s);
    ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger).map((g) => [g.id.split(":")[3], g.member.coach])).toEqual([["f1", "Ann"]]);
    // a registration that was never accepted carries no club
    leagues.putSeason(season("season-2", [played("g1", 1, 0)], { registrations: [reg("Ann", "red", "pending"), reg("Bob", "blue", "declined")] as never }));
    expect(countedGames(club("red"), clubLedger(src())).some((g) => g.seasonName === "Season 2")).toBe(false);
  });

  it("only authorised competitions count; drafts and test data never do", () => {
    seedTournaments(
      [tournament("ok"), tournament("noauth", { authorised: false }), tournament("draft", { unpublished: true }), tournament("test", { test: true })],
      ["ok", "noauth", "draft", "test"].flatMap((t) => [entrant(t, "Ann", 1, "red"), entrant(t, "Bob", 2)]),
      ["ok", "noauth", "draft", "test"].map((t) => smatch(t, 1, "Ann", "Bob", 1, 0)),
    );
    leagues.putSeason(season("season-1", [played("f1", 1, 0), played("f2", 2, 0, { test: true })]));
    let ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger).map((g) => g.competitionId).sort()).toEqual(["lg", "ok"]);
    // the league unauthorised, then a draft, then a test league: its games drop out
    leagues.updateLeague("lg", (l) => { l.authorised = false; });
    ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger).map((g) => g.competitionId)).toEqual(["ok"]);
    leagues.updateLeague("lg", (l) => { delete l.authorised; l.visibility = "draft"; });
    expect(countedGames(club("red"), clubLedger(src())).map((g) => g.competitionId)).toEqual(["ok"]);
    leagues.updateLeague("lg", (l) => { delete l.visibility; l.test = true; });
    expect(countedGames(club("red"), clubLedger(src())).map((g) => g.competitionId)).toEqual(["ok"]);
    // a club pick in an unauthorised competition is still history (the club is archived, never deleted)
    expect(ledger.picked.has("red")).toBe(true);
  });

  it("ladder games count only with the club's ladderGamesCount setting on (default off); a ladder in setup never", () => {
    const ladder = season("ladder-1", [played("lf1", 2, 0, { ladder: { challengeId: "c1" } })], { competition: "ladder", ladder: {} as never, stage: "active", name: "Spring Ladder" });
    leagues.putSeason(ladder);
    const ledger = clubLedger(src());
    expect(countedGames(club("red"), ledger)).toEqual([]);
    expect(clubStats(club("red"), ledger).ladderExcluded).toBe(true);
    const on = club("red", { settings: { ladderGamesCount: true, webhookEvents: { results: true, podiums: true, titles: true } } });
    expect(countedGames(on, ledger).map((g) => [g.kind, g.seasonName, g.link])).toEqual([["ladder", "Spring Ladder", "/leagues/lg?tab=ladder&ladder=ladder-1"]]);
    leagues.putSeason({ ...ladder, stage: "setup" });
    expect(countedGames(on, clubLedger(src()))).toEqual([]);
  });
});

describe("club stats", () => {
  it("totals, member records (current and former), leaders; a leaver's games stay", () => {
    seedTournaments(
      [tournament("t1")],
      [entrant("t1", "Ann", 1, "red"), entrant("t1", "Dee", 2, "red"), entrant("t1", "Bob", 3)],
      [smatch("t1", 1, "Ann", "Bob", 2, 0), smatch("t1", 2, "Dee", "Bob", 1, 1), smatch("t1", 3, "Ann", "Dee", 1, 0)],
    );
    const c = club("red", {
      members: [{ coach: "Ann", role: "admin", joinedAt: at(-1000) }, { coach: "Eve", role: "member", joinedAt: at(-10) }],
      former: [{ coach: "Dee", joinedAt: at(-1000), leftAt: at(-1), reason: "left" }],
    });
    const s = clubStats(c, clubLedger(src()));
    expect(s.totals).toMatchObject({ games: 4, wins: 2, draws: 1, losses: 1, tdFor: 4, tdAgainst: 2, competitions: 1, coaches: 2 });
    expect(s.members.map((m) => [m.coach, m.games, m.wins, m.role])).toEqual([["Ann", 2, 2, "admin"], ["Eve", 0, 0, "member"]]);
    expect(s.former.map((f) => [f.coach, f.games, f.draws, f.losses, f.leftAt])).toEqual([["Dee", 2, 1, 1, at(-1)]]);
    expect(s.leaders.find((l) => l.key === "wins")).toMatchObject({ coach: "Ann", value: 2 });
    expect(s.results).toHaveLength(4);
  });

  it("podiums from a finished tournament and a league title from a crowned season", () => {
    seedTournaments(
      [tournament("t1")],
      [entrant("t1", "Ann", 1, "red"), entrant("t1", "Bob", 2, "blue"), entrant("t1", "Cy", 3)],
      [smatch("t1", 1, "Ann", "Bob", 2, 0), smatch("t1", 2, "Cy", "Ann", 0, 1), smatch("t1", 3, "Bob", "Cy", 1, 0)],
    );
    leagues.putSeason(season("season-1", [played("f1", 2, 1)], { status: "completed", endedAt: at(-2), podium: { decidedBy: "standings", proposed: {}, final: { champion: "orcs" }, overridden: false, by: "Org", at: at(-2) } }));
    const s = clubStats(club("red"), clubLedger(src()));
    expect(s.honours.map((h) => [h.kind, h.place, h.coach, h.competitionName])).toEqual(expect.arrayContaining([["podium", 1, "Ann", "Cup t1"], ["title", 1, "Ann", "Test League"]]));
    expect(s.totals).toMatchObject({ titles: 1, podiums: 1 });
    expect(clubStats(club("blue"), clubLedger(src())).honours.map((h) => [h.kind, h.place])).toEqual([["podium", 2]]);
  });
});

describe("club observer: webhook events and clubmate wins", () => {
  const URL = "https://discord.com/api/webhooks/123456789012/abcdefghijklmnopqrstuvwxyz0123";
  function observer(posts: DiscordPayload[], sent: Array<{ coach: string; input: NotificationInput }>) {
    return new ClubObserver({
      store: clubs, ledger: () => clubLedger(src()), state: new DiscordStateStore(join(dir, "discord")),
      poster: async (_url, p) => { posts.push(p); return { ok: true, status: 204 }; },
      notify: (coach, input) => { sent.push({ coach, input }); },
    });
  }
  function redClub(): string {
    const c = clubs.create({ name: "Red Club", homeRegion: "", description: "", createdBy: "Ann" });
    clubs.update(c.id, (x) => { x.members.push({ coach: "Eve", role: "member", joinedAt: at(-1), notify: { wins: true } }, { coach: "Fay", role: "member", joinedAt: at(-1) }); });
    clubs.setWebhook(c.id, URL);
    return c.id;
  }

  it("first sight marks history without posting; then a member's result posts, a win tells opted-in clubmates only", async () => {
    const id = redClub();
    seedTournaments([tournament("t1", { status: "active" })], [entrant("t1", "Ann", 1, id), entrant("t1", "Bob", 2)], [smatch("t1", 1, "Ann", "Bob", 2, 1)]);
    const posts: DiscordPayload[] = [];
    const sent: Array<{ coach: string; input: NotificationInput }> = [];
    const o = observer(posts, sent);
    expect(await o.tick()).toBe(0);
    expect(posts).toEqual([]);
    seedTournaments([tournament("t1", { status: "active" })], [entrant("t1", "Ann", 1, id), entrant("t1", "Bob", 2)], [smatch("t1", 1, "Ann", "Bob", 2, 1), smatch("t1", 2, "Bob", "Ann", 0, 3)]);
    await o.tick();
    expect(posts.map((p) => p.embeds[0]!.title)).toEqual(["Red Club: member result"]);
    expect(posts[0]!.embeds[0]!.description).toContain("Ann (Ann Team) beat Bob (Bob Team) 3-0");
    expect(sent.map((s) => [s.coach, s.input.type, s.input.title])).toEqual([["Eve", "club", "Ann won for Red Club"]]);
    // nothing twice
    await o.tick();
    expect(posts).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("an organiser-entered result, a draft and a test tournament never post; toggles are respected; podiums post", async () => {
    const id = redClub();
    const ts = [tournament("t1", { status: "active" }), tournament("dr", { unpublished: true, status: "active" }), tournament("tt", { test: true, status: "active" })];
    const es = ["t1", "dr", "tt"].flatMap((t) => [entrant(t, "Ann", 1, id), entrant(t, "Bob", 2)]);
    seedTournaments(ts, es, []);
    const posts: DiscordPayload[] = [];
    const sent: Array<{ coach: string; input: NotificationInput }> = [];
    const o = observer(posts, sent);
    await o.tick();
    seedTournaments(ts, es, [
      smatch("t1", 1, "Ann", "Bob", 1, 0, { result: { homeScore: 1, awayScore: 0, reportedAt: at(-1), manual: true } }),
      smatch("dr", 1, "Ann", "Bob", 1, 0), smatch("tt", 1, "Ann", "Bob", 1, 0),
    ]);
    await o.tick();
    expect(posts).toEqual([]);
    expect(sent).toEqual([]);
    // results toggle off: a recorded win still tells clubmates, but nothing posts; the podium posts
    clubs.update(id, (c) => { c.settings.webhookEvents.results = false; });
    seedTournaments([...ts.slice(0, 1).map((t) => ({ ...t, status: "completed" })), ...ts.slice(1)], es, [
      smatch("t1", 1, "Ann", "Bob", 1, 0, { result: { homeScore: 1, awayScore: 0, reportedAt: at(-1), manual: true } }),
      smatch("t1", 2, "Ann", "Bob", 2, 0),
    ]);
    await o.tick();
    expect(posts.map((p) => p.embeds[0]!.title)).toEqual(["Red Club: tournament podium"]);
    expect(posts[0]!.embeds[0]!.description).toContain("Ann (Ann Team) won Cup t1");
    expect(sent.map((s) => s.coach)).toEqual(["Eve"]);
  });

  it("turning ladder games on later never replays the ladder games played meanwhile", async () => {
    const id = redClub();
    const posts: DiscordPayload[] = [];
    const o = observer(posts, []);
    await o.tick();
    leagues.putSeason(season("ladder-1", [played("lf1", 2, 0, { ladder: { challengeId: "c1" } })], {
      competition: "ladder", ladder: {} as never, stage: "active", registrations: [reg("Ann", id), reg("Bob", undefined)] as never,
    }));
    await o.tick();
    clubs.update(id, (c) => { c.settings.ladderGamesCount = true; });
    await o.tick();
    expect(posts).toEqual([]);
  });
});
