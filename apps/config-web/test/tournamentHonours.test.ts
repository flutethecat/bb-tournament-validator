import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireSession } from "../src/auth/requireSession.js";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { tournamentStatistics } from "../src/tournaments/honours.js";
import { TournamentStore } from "../src/tournaments/store.js";
import type { ScheduledMatchRecord, TournamentDataFileV4, TournamentEntrantRecord, TournamentRecord } from "../src/tournaments/types.js";
import type { StoredTournamentResult } from "../src/tournamentResults.js";
import type { GamestatePlayerResult } from "@bb/fork-ops";

// Tournament Statistics, Honours and Awards (spec-main-landing-nav §3 item 6). Fake coaches and teams only.

const roots: string[] = [];
const at = "2026-10-20T12:00:00.000Z";
const now = new Date("2026-11-01T12:00:00.000Z");
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const helper: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
const admin: TournamentApiIdentity = { coach: "Root", organizer: true, admin: true };
const otherOrganiser: TournamentApiIdentity = { coach: "Ozzel", organizer: true, admin: false };
const ann: TournamentApiIdentity = { coach: "Ann", organizer: false, admin: false };

afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const TEAMS: Record<string, { teamName: string; race: string }> = {
  "team-ann": { teamName: "Ann's Orcs", race: "Orc" },
  "team-bob": { teamName: "Bob's Elves", race: "Wood Elf" },
  "team-cy": { teamName: "Cy's Dwarfs", race: "Dwarf" },
  "team-di": { teamName: "Di's Humans", race: "Human" },
};
const COACHES = ["Ann", "Bob", "Cy", "Di"];

function tournament(over: Partial<TournamentRecord> = {}): TournamentRecord {
  return {
    id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "Rules", maxPlayers: 8, roundCount: 2, currentRound: 1,
    tiebreakers: ["buchholz"], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "Veers", organizerCoachId: "Veers", organizerCoachIds: ["Piett"],
    createdAt: at, updatedAt: at, ...over,
  };
}
const entrant = (coach: string, seed: number): TournamentEntrantRecord => ({
  id: `e-${coach.toLowerCase()}`, tournamentId: "t1", seed, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: at }, teamId: `team-${coach.toLowerCase()}`, registeredAt: at,
});
function match(id: string, round: number, home: string, away: string, result?: { h: number; a: number; hc?: number; ac?: number }, gameId?: string): ScheduledMatchRecord {
  const side = (c: string) => ({ entrantId: `e-${c.toLowerCase()}`, coach: { coachId: c, ffbCoachId: c, verifiedAt: at }, teamId: `team-${c.toLowerCase()}` });
  return {
    id, tournamentId: "t1", roundId: `t1:round:${round}`, roundNumber: round, home: side(home), away: side(away),
    status: result ? "completed" : "scheduled", revision: 2,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, ...(gameId ? { gameId } : {}) },
    ...(result ? { result: { homeScore: result.h, awayScore: result.a, ...(result.hc !== undefined ? { homeCasualties: result.hc, awayCasualties: result.ac } : {}), reportedAt: at } } : {}),
    createdAt: at, updatedAt: at,
  };
}
const player = (playerId: string, name: string, p: Partial<GamestatePlayerResult>): GamestatePlayerResult => ({
  playerId, name, touchdowns: 0, casualtiesCaused: 0, blocks: 0, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, ...p,
});

/** Fork game g1: Ann (home) 2-1 Bob. The row lists the coaches the other way round to check the side matching. */
const FORK_ROW: StoredTournamentResult = {
  gameId: "g1", pulledAt: at, namesDecoded: true,
  home: { teamId: "fork-bob", teamName: "Bob's Elves", coach: "Bob" },
  away: { teamId: "fork-ann", teamName: "Ann's Orcs", coach: "Ann" },
  teams: [
    { teamId: "fork-bob", score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 1, si: 1, rip: 1 },
      players: [player("b1", "Leaf", { touchdowns: 1, completions: 3, interceptions: 1, blocks: 2 })] },
    { teamId: "fork-ann", score: 2, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 },
      players: [player("a1", "Grok", { touchdowns: 2, casualtiesCaused: 3, mvp: 1, blocks: 5, fouls: 1 })] },
  ],
};
/** Published tabletop match for fixture m2 (Cy 1-1 Di): player rows but no blocks (the recorder does not count them). */
const TABLETOP_ROW: StoredTournamentResult = {
  gameId: "tt-1", pulledAt: at, source: "tabletop", published: true, fixtureRef: "m2",
  home: { teamId: "save:cy", teamName: "Cy's Dwarfs", coach: "Cy" }, away: { teamId: "save:di", teamName: "Di's Humans", coach: "Di" },
  teams: [
    { teamId: "save:cy", score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [player("c1", "Thorin", { touchdowns: 1, casualtiesCaused: 1, blocks: 0 })] },
    { teamId: "save:di", score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 1, rip: 0 }, players: [player("d1", "Hal", { touchdowns: 1, fouls: 2 })] },
  ],
};

function setup(data: { t?: Partial<TournamentRecord>; matches: ScheduledMatchRecord[] }): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tournament-honours-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const file: TournamentDataFileV4 = {
    version: 4,
    tournaments: { t1: tournament(data.t) },
    entrants: Object.fromEntries(COACHES.map((c, i) => [`e-${c.toLowerCase()}`, entrant(c, i + 1)])),
    rounds: {}, standings: {}, waitingPresence: {},
    scheduledMatches: Object.fromEntries(data.matches.map((m) => [m.id, m])),
  };
  store.writeSnapshot(file);
  return store;
}

function deps(store: TournamentStore, extra: Partial<TournamentApiDeps> = {}): TournamentApiDeps {
  return { store, teamBuild: (id) => TEAMS[id], packageExists: () => true, now: () => now, ...extra };
}
const call = (store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, extra: Partial<TournamentApiDeps> = {}, query = "") =>
  tournamentApi(method, path, new URLSearchParams(query), auth, body, deps(store, extra));

type Stats = ReturnType<typeof tournamentStatistics>;

describe("statistics from the tournament's results", () => {
  it("fork and tabletop rows add player stats; a manual result carries the score only", async () => {
    const store = setup({ matches: [
      match("m1", 1, "Ann", "Bob", { h: 2, a: 1 }, "g1"),
      match("m2", 1, "Cy", "Di", { h: 1, a: 1 }),
      match("m3", 2, "Ann", "Cy", { h: 0, a: 0 }),
      match("m4", 2, "Bob", "Di"),
    ] });
    const res = await call(store, "GET", "/api/tournaments/t1/statistics", undefined, undefined, { results: () => [FORK_ROW, TABLETOP_ROW] });
    expect(res?.status).toBe(200);
    const s = res!.body as Stats;
    expect(s.coverage).toEqual({ games: 3, casualties: 2, players: 2, blocks: 1 });
    expect(s.totals).toMatchObject({ games: 3, touchdowns: 5, casualties: 4, teams: 4, players: 4 });
    const ann = s.teams.find((t) => t.entrantId === "e-ann")!;
    // the row's sides were matched by coach, so Ann gets the "fork-ann" block although the row lists her away
    expect(ann).toMatchObject({ team: "Ann's Orcs", race: "Orc", games: 2, wins: 1, draws: 1, points: 4, td: 2, tdAgainst: 1, cas: 3, casAgainst: 0, blocks: 5, mvp: 1, fouls: 1, injuriesFor: 1, deathsFor: 1 });
    expect(s.teams.find((t) => t.entrantId === "e-bob")).toMatchObject({ cas: 0, casAgainst: 3, completions: 3, interceptions: 1, blocks: 2, injuriesAgainst: 1, deathsAgainst: 1 });
    // the tabletop row records no blocks: Thorin's 0 blocks never count, only the fork game's
    expect(s.players.find((p) => p.playerId === "c1")).toMatchObject({ td: 1, cas: 1, blocks: 0 });
    expect(s.stats).toEqual(["td", "tdAgainst", "cas", "casAgainst", "completions", "interceptions", "fouls", "blocks", "mvp", "injuriesFor", "injuriesAgainst", "deathsFor", "deathsAgainst"]);
    expect(s.playerStats).toEqual(["td", "cas", "mvp", "completions", "interceptions", "fouls", "blocks"]);
    expect(s.coaches.map((c) => c.points)).toEqual([...s.coaches.map((c) => c.points)].sort((a, b) => b - a));
    expect(s.coaches.find((c) => c.coach === "Ann")).toMatchObject({ teams: 1, points: 4, td: 2 });
    expect(s.races).toHaveLength(4);
    // honour boards: top scorer, ties ranked together, best defence ascending
    const td = s.honours.find((b) => b.key === "player-td")!;
    expect(td.rows[0]).toMatchObject({ rank: 1, name: "Grok", team: "Ann's Orcs", value: 2 });
    expect(td.rows.slice(1).map((r) => r.rank)).toEqual([2, 2, 2]);
    const defence = s.honours.find((b) => b.key === "team-tdAgainst")!;
    expect(defence.rows[0]).toMatchObject({ rank: 1, name: "Ann's Orcs", value: 1 });
    expect(s.honours.some((b) => b.kind === "coach")).toBe(true);
    expect(s.cards.map((c) => c.id)).toEqual(["top-scorer", "casualties", "mvp", "best-attack", "best-defence", "playmaker", "interceptor", "dirtiest"]);
  });

  it("hides stats nobody recorded: manual scores only, then casualties typed by the organiser", async () => {
    const scoresOnly = setup({ matches: [match("m1", 1, "Ann", "Bob", { h: 3, a: 0 }), match("m2", 1, "Cy", "Di", { h: 1, a: 2 })] });
    const s = (await call(scoresOnly, "GET", "/api/tournaments/t1/statistics", undefined, undefined, { results: () => [] }))!.body as Stats;
    expect(s.stats).toEqual(["td", "tdAgainst"]);
    expect(s.playerStats).toEqual([]);
    expect(s.players).toEqual([]);
    expect(s.totals.casualties).toBeNull();
    expect(s.coverage).toEqual({ games: 2, casualties: 0, players: 0, blocks: 0 });
    expect(s.honours.every((b) => b.kind !== "player")).toBe(true);
    expect(s.honours.map((b) => b.key)).not.toContain("team-cas");
    expect(s.cards.map((c) => c.id)).toEqual(["best-attack", "best-defence"]);

    const withCas = setup({ matches: [match("m1", 1, "Ann", "Bob", { h: 3, a: 0, hc: 2, ac: 0 }), match("m2", 1, "Cy", "Di", { h: 1, a: 2, hc: 0, ac: 0 })] });
    const c = (await call(withCas, "GET", "/api/tournaments/t1/statistics"))!.body as Stats;
    expect(c.stats).toEqual(["td", "tdAgainst", "cas", "casAgainst"]);
    expect(c.totals.casualties).toBe(2);
  });

  it("a test or unpublished row never reaches the stats (the server passes only counted rows); byes are not games", async () => {
    const store = setup({ matches: [match("m1", 1, "Ann", "Bob", { h: 1, a: 0 })] });
    const bye: ScheduledMatchRecord = { ...match("bye", 1, "Cy", "Di", { h: 0, a: 0 }) };
    delete (bye as { away?: unknown }).away;
    store.writeSnapshot({ ...store.snapshot(), scheduledMatches: { ...store.snapshot().scheduledMatches, bye } });
    const s = (await call(store, "GET", "/api/tournaments/t1/statistics"))!.body as Stats;
    expect(s.totals.games).toBe(1);
    expect(s.teams.map((t) => t.entrantId).sort()).toEqual(["e-ann", "e-bob"]);
  });

  it("an empty tournament has no stats and an unknown one is 404", async () => {
    const store = setup({ matches: [] });
    const s = (await call(store, "GET", "/api/tournaments/t1/statistics"))!.body as Stats;
    expect(s).toMatchObject({ stats: [], playerStats: [], teams: [], honours: [], cards: [], totals: { games: 0 } });
    expect((await call(store, "GET", "/api/tournaments/nope/statistics"))?.status).toBe(404);
    expect((await call(store, "POST", "/api/tournaments/t1/statistics", owner, {}))?.status).toBe(405);
  });
});

type AwardsBody = { revision: number; finished: boolean; podium: Array<{ id: string; title: string; toTeam: string; toCoach: string; star: boolean }>; awards: Array<{ id: string; title: string; toCoach: string; toTeam?: string; by: string }>; recipients?: unknown };

describe("podium", () => {
  const played = [
    match("m1", 1, "Ann", "Bob", { h: 2, a: 1 }), match("m2", 1, "Cy", "Di", { h: 3, a: 0 }),
    match("m3", 2, "Ann", "Cy", { h: 1, a: 1 }), match("m4", 2, "Bob", "Di", { h: 2, a: 0 }),
  ];
  it("stays empty until the tournament is finished", async () => {
    const store = setup({ matches: played });
    const v = (await call(store, "GET", "/api/tournaments/t1/awards"))!.body as AwardsBody;
    expect(v).toMatchObject({ revision: 0, finished: false, podium: [], awards: [] });
    expect(v).not.toHaveProperty("recipients");
  });
  it("comes from the final standings once finished: champion 1st, runner-up 2nd, consolation 3rd", async () => {
    const store = setup({ t: { status: "completed" }, matches: played });
    const v = (await call(store, "GET", "/api/tournaments/t1/awards"))!.body as AwardsBody;
    // Ann 4 pts (+1), Cy 4 pts (+3) -> buchholz decides; Bob 3; Di 0
    const order = store.standings("t1").filter((r) => r.played > 0).map((r) => r.coachId);
    expect(v.podium.map((p) => p.toCoach)).toEqual(order.slice(0, 3));
    expect(v.podium.map((p) => p.title)).toEqual(["Overall Champion", "Runner-up", "Consolation"]);
    expect(v.podium[0]!.star).toBe(true);
    expect(v.podium[0]!.toTeam).toBe(TEAMS[`team-${order[0]!.toLowerCase()}`]!.teamName);
  });
  it("a knockout's final decides champion and runner-up", async () => {
    const store = setup({ t: { status: "completed", format: "knockout" }, matches: [
      match("k1", 1, "Ann", "Bob", { h: 3, a: 0 }), match("k2", 1, "Cy", "Di", { h: 1, a: 0 }), match("k3", 2, "Ann", "Cy", { h: 0, a: 1 }),
    ] });
    const v = (await call(store, "GET", "/api/tournaments/t1/awards"))!.body as AwardsBody;
    expect(v.podium.slice(0, 2).map((p) => p.toCoach)).toEqual(["Cy", "Ann"]);
    expect(v.podium).toHaveLength(3);
  });
});

describe("custom awards", () => {
  const give = (store: TournamentStore, who: TournamentApiIdentity | undefined, body: Record<string, unknown>, notify?: TournamentApiDeps["notify"]) =>
    call(store, "POST", "/api/tournaments/t1/awards", who, body, notify ? { notify } : {});
  const award = { title: "Best sportsmanship", icon: "captain", recipient: { kind: "team", teamId: "e-ann" }, note: "Always on time." };
  const notifier = () => ({ coach: vi.fn(), managers: vi.fn(), entrants: vi.fn() });

  it("only the tournament's organisers and admins give or remove them", async () => {
    const store = setup({ matches: [] });
    expect((await give(store, undefined, { ...award, revision: 0 }))?.status).toBe(401);
    expect((await give(store, ann, { ...award, revision: 0 }))?.status).toBe(403);
    expect((await give(store, otherOrganiser, { ...award, revision: 0 }))?.status).toBe(403);
    const r1 = await give(store, helper, { ...award, revision: 0 });
    expect(r1?.status).toBe(201);
    const b1 = r1!.body as { award: { id: string }; awards: AwardsBody };
    expect(b1.awards.awards[0]).toMatchObject({ title: "Best sportsmanship", toCoach: "Ann", toTeam: "Ann's Orcs", by: "Piett" });
    expect(b1.awards.revision).toBe(1);
    expect(store.tournament("t1")!.awards![0]).toMatchObject({ tournamentId: "t1", toCoach: "Ann", entrantId: "e-ann", by: "Piett" });
    expect((await give(store, admin, { ...award, revision: 1, recipient: { kind: "coach", coachId: "bob" } }))?.status).toBe(201);
    expect(store.tournament("t1")!.awards![1]).toMatchObject({ toCoach: "Bob", by: "Root" });
    expect(store.tournament("t1")!.awards![1]).not.toHaveProperty("toTeam");
    // managers see the recipients; others never
    expect(((await call(store, "GET", "/api/tournaments/t1/awards", owner))!.body as AwardsBody).recipients).toMatchObject({ teams: expect.any(Array), coaches: expect.any(Array) });
    expect((await call(store, "GET", "/api/tournaments/t1/awards", ann))!.body).not.toHaveProperty("recipients");
    // remove: organiser, revision via If-Match
    const del = (who: TournamentApiIdentity | undefined, ifMatch?: string, id = b1.award.id) => call(store, "DELETE", `/api/tournaments/t1/awards/${id}`, who, undefined, ifMatch ? { ifMatch } : {});
    expect((await del(ann, '"2"'))?.status).toBe(403);
    expect((await del(owner))?.status).toBe(428);
    expect((await del(owner, '"1"'))?.status).toBe(409);
    expect((await del(owner, '"2"', "podium-champion"))?.status).toBe(409);
    expect((await del(owner, '"2"', "a-missing"))?.status).toBe(404);
    const gone = await del(owner, '"2"');
    expect(gone?.status).toBe(200);
    expect(store.tournament("t1")!.awards!.map((a) => a.toCoach)).toEqual(["Bob"]);
    expect(store.tournament("t1")!.awardsRevision).toBe(3);
  });

  it("validates title, icon and recipient; 428 without a revision, 409 when stale", async () => {
    const store = setup({ matches: [] });
    expect((await give(store, owner, award))?.status).toBe(428);
    expect((await give(store, owner, { ...award, revision: 5 }))).toMatchObject({ status: 409, body: { revision: 0 } });
    expect((await give(store, owner, { ...award, revision: 0, title: " " }))).toMatchObject({ status: 400, body: { field: "title" } });
    expect((await give(store, owner, { ...award, revision: 0, icon: "../../etc" }))).toMatchObject({ status: 400, body: { field: "icon" } });
    expect((await give(store, owner, { ...award, revision: 0, recipient: { kind: "team", teamId: "e-nobody" } }))).toMatchObject({ status: 400, body: { field: "recipient" } });
    expect((await give(store, owner, { ...award, revision: 0, recipient: { kind: "coach", coachId: "Stranger" } }))).toMatchObject({ status: 400, body: { field: "recipient" } });
    expect(store.tournament("t1")!.awards).toBeUndefined();
  });

  it("notifies the recipient once, never the giver, and not on a refused write", async () => {
    const store = setup({ matches: [] });
    const n = notifier();
    expect((await give(store, owner, { ...award, revision: 0 }, n))?.status).toBe(201);
    expect(n.coach).toHaveBeenCalledTimes(1);
    expect(n.coach).toHaveBeenCalledWith("Ann", expect.objectContaining({ type: "award", link: "/app/tournaments/t1?tab=awards", from: "Veers" }));
    expect(n.coach.mock.calls[0]![1].body).toContain("Best sportsmanship");
    // a stale retry of the same award is refused and notifies nobody
    expect((await give(store, owner, { ...award, revision: 0 }, n))?.status).toBe(409);
    expect(n.coach).toHaveBeenCalledTimes(1);
    // reads never notify
    await call(store, "GET", "/api/tournaments/t1/awards", owner, undefined, { notify: n });
    expect(n.coach).toHaveBeenCalledTimes(1);
    // an organiser giving themself an award (as an entrant) is not notified
    const self = setup({ matches: [] });
    const n2 = notifier();
    expect((await call(self, "POST", "/api/tournaments/t1/awards", { coach: "Ann", organizer: true, admin: true }, { ...award, revision: 0 }, { notify: n2 }))?.status).toBe(201);
    expect(n2.coach).not.toHaveBeenCalled();
  });

  it("the coach page lists the coach's podium places and awards across tournaments", async () => {
    const store = setup({ t: { status: "completed" }, matches: [match("m1", 1, "Ann", "Bob", { h: 2, a: 0 }), match("m2", 1, "Cy", "Di", { h: 0, a: 1 })] });
    await give(store, owner, { ...award, revision: 0 });
    const mine = await call(store, "GET", "/api/tournaments", ann, undefined, {}, "awards=mine");
    const list = (mine!.body as { awards: Array<{ id: string; source: string; tournamentName: string }> }).awards;
    expect(list.map((a) => a.source).sort()).toEqual(["custom", "podium"]);
    expect(list.every((a) => a.tournamentName === "Spike Open")).toBe(true);
    expect(((await call(store, "GET", "/api/tournaments", undefined, undefined, {}, "awards=mine"))!.body as { awards: unknown[] }).awards).toEqual([]);
  });
});

describe("visibility: public statuses for anyone, a draft only to its managers", () => {
  it("draft statistics and awards are 404 to anonymous and other coaches, readable by organisers and admins", async () => {
    const store = setup({ t: { status: "draft" }, matches: [] });
    for (const path of ["/api/tournaments/t1/statistics", "/api/tournaments/t1/awards"]) {
      for (const who of [undefined, ann, otherOrganiser]) expect((await call(store, "GET", path, who))?.status, `${path} ${who?.coach}`).toBe(404);
      for (const who of [owner, helper, admin]) expect((await call(store, "GET", path, who))?.status, `${path} ${who.coach}`).toBe(200);
    }
    // a non-manager's award write cannot tell a draft exists either
    expect((await call(store, "POST", "/api/tournaments/t1/awards", ann, { revision: 0 }))?.status).toBe(404);
    expect((await call(store, "GET", "/api/tournaments/__proto__/statistics", admin))?.status).toBe(404);
  });
  it("active, completed and cancelled tournaments are public", async () => {
    for (const status of ["active", "completed", "cancelled"] as const) {
      const store = setup({ t: { status }, matches: [] });
      expect((await call(store, "GET", "/api/tournaments/t1/statistics"))?.status, status).toBe(200);
      expect((await call(store, "GET", "/api/tournaments/t1/awards"))?.status, status).toBe(200);
    }
  });
  it("the coach page leaves out awards from a draft the coach does not manage", async () => {
    const store = setup({ t: { status: "draft" }, matches: [] });
    expect((await call(store, "POST", "/api/tournaments/t1/awards", owner, { title: "Early bird", icon: "star", recipient: { kind: "coach", coachId: "Ann" }, revision: 0 }))?.status).toBe(201);
    const mine = (who: TournamentApiIdentity) => call(store, "GET", "/api/tournaments", who, undefined, {}, "awards=mine").then((r) => (r!.body as { awards: unknown[] }).awards);
    expect(await mine(ann)).toEqual([]);
    expect(await mine({ coach: "Ann", organizer: true, admin: true })).toHaveLength(1);
  });
});

describe("public reads under the session gate", () => {
  const req = (method: string) => ({ method, headers: {} }) as unknown as IncomingMessage;
  it("anonymous GETs of statistics and awards pass; award writes stay session-gated", () => {
    for (const p of ["/api/tournaments/t1/statistics", "/api/tournaments/t1/awards", "/api/fork/tournaments/t1/statistics"])
      expect(requireSession(req("GET"), p, "").kind, p).toBe("allow");
    expect(requireSession(req("POST"), "/api/tournaments/t1/awards", "").kind).toBe("unauthorized");
    expect(requireSession(req("DELETE"), "/api/tournaments/t1/awards/a-1", "").kind).toBe("unauthorized");
    expect(requireSession(req("GET"), "/api/tournaments/t1/awards/a-1", "").kind).toBe("unauthorized");
  });
});
