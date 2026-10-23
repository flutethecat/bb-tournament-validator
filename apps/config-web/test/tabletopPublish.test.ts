import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeElo } from "../src/coachElo.js";
import { tabletopApi, type FixtureGateway, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { leagueStandings } from "../src/tabletop/standings.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore, type StoredTournamentResult } from "../src/tournamentResults.js";
import { TournamentStore } from "../src/tournaments/store.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let tstore: TournamentStore;
let fixtureId = "";
let fixtureHome = "";
let fixtureAway = "";
const files: Record<string, TabletopTeamFile> = {};

const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
  schema: 1, name, treasury: 0, dedicatedFans: 1,
  players: ["1", "2"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
});

const gateway = (): FixtureGateway => ({
  get: (id) => {
    const m = tstore.match(id);
    if (!m) return undefined;
    const t = tstore.tournament(m.tournamentId);
    return {
      id: m.id, ...(t?.packageName ? { packageName: t.packageName } : {}),
      open: Boolean(m.away) && t?.status === "active" && !["completed", "cancelled", "dismissed"].includes(m.status),
      status: m.status, revision: m.revision, home: { coach: m.home.coach.ffbCoachId }, away: { coach: m.away?.coach.ffbCoachId ?? "" },
      ...(m.result ? { resultReportedAt: m.result.reportedAt } : {}),
    };
  },
  record: (id, input, at) => { tstore.recordResult(id, input, at); },
  retract: (id, input, at) => { tstore.retractResult(id, { expectedRevision: input.expectedRevision, status: input.status as never }, at); },
});

const deps = (): TabletopApiDeps => ({
  repo, results, fixtures: gateway(),
  loadTeamFile: (coach, saveId) => files[`${coach}/${saveId}`],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => NOW,
});
const as = (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return tabletopApi(method, p!, { coach, method: "discord" }, body, deps(), new URLSearchParams(q ?? "")) as Promise<TabletopResult>;
};
let eid = 0;
const E = (type: string, team: string, player?: string, payload: Record<string, unknown> = {}) => {
  eid += 1;
  return { id: `evt-${String(eid).padStart(8, "0")}`, type, team, player, payload };
};
const saveOf = (coach: string) => (coach === "Alice" ? "sv_a" : "sv_b");

/** Create + play + submit + confirm (via the organiser). `homeCoach` is the match's home. Home scores 2, away 1. */
async function confirmedMatch(homeCoach: string, fixtureRef?: string, league?: string): Promise<string> {
  const awayCoach = homeCoach === "Alice" ? "Bob" : "Alice";
  const created = await as("Org", "POST", "/api/tabletop/matches", {
    home: { coach: homeCoach, teamSaveId: saveOf(homeCoach) }, away: { coach: awayCoach, teamSaveId: saveOf(awayCoach) },
    postMatch: "spp-only", fixtureRef, league,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { match: { id: string } }).match.id;
  const hp = homeCoach === "Alice" ? "a" : "b";
  const ap = homeCoach === "Alice" ? "b" : "a";
  await as("Org", "POST", `/api/tabletop/matches/${id}/events`, {
    events: [E("touchdown", "home", `${hp}1`), E("touchdown", "home", `${hp}2`), E("touchdown", "away", `${ap}1`),
      E("casualty", "home", `${hp}1`, { victim: `${ap}2`, result: "BH" })],
  });
  await as("Org", "POST", `/api/tabletop/matches/${id}/submit`);
  expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-publish-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  tstore = new TournamentStore(join(dir, "tournaments"));
  files["Alice/sv_a"] = mkTeam("Alice XI", "a");
  files["Bob/sv_b"] = mkTeam("Bob XI", "b");
  const t = tstore.createTournament({ name: "Cup", packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: "Org" }, NOW);
  for (const name of ["Alice", "Bob"])
    tstore.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name.toLowerCase()}`, NOW);
  const snap = tstore.snapshot();
  snap.tournaments[t.id]!.status = "active";
  tstore.writeSnapshot(snap);
  const round = tstore.generateNextRound(t.id, NOW);
  fixtureId = round.scheduledMatchIds[0]!;
  fixtureHome = tstore.match(fixtureId)!.home.coach.ffbCoachId;
  fixtureAway = tstore.match(fixtureId)!.away!.coach.ffbCoachId;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tabletop T3: publish gating", () => {
  it("a confirmed match is pending organiser and counts nowhere until an organiser publishes it", async () => {
    const id = await confirmedMatch("Alice", undefined, "Rules");
    expect(results.listAll()).toHaveLength(1);
    expect(results.list()).toHaveLength(0);
    expect(computeElo(results.list()).size).toBe(0);
    expect(leagueStandings(results.list(), "Rules", () => undefined)).toEqual([]);
    const list = (await as("Alice", "GET", "/api/tabletop/matches")).body as { matches: Array<{ pendingOrganiser: boolean; state: string }> };
    expect(list.matches[0]).toMatchObject({ state: "confirmed", pendingOrganiser: true });

    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(403); // participant
    expect((await as("Mallory", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(403);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(200);
    expect(results.list()).toHaveLength(1);
    expect(results.list()[0]).toMatchObject({ source: "tabletop", published: true, league: "Rules" });
    const after = (await as("Alice", "GET", "/api/tabletop/matches")).body as { matches: Array<{ pendingOrganiser: boolean; state: string }> };
    expect(after.matches[0]).toMatchObject({ state: "published", pendingOrganiser: false });
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(409); // already published
  });

  it("publish before confirm is a 409", async () => {
    const created = await as("Org", "POST", "/api/tabletop/matches", {
      home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" },
    });
    const id = (created.body as { match: { id: string } }).match.id;
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(409);
  });
});

describe("tabletop T3: fixture link", () => {
  it("validates the fixture at creation: exists, unresolved, coaches match (409 otherwise)", async () => {
    const mk = (fixtureRef: string, a = "Alice", b = "Bob") => as("Org", "POST", "/api/tabletop/matches", {
      home: { coach: a, teamSaveId: saveOf(a) }, away: { coach: b, teamSaveId: saveOf(b) }, fixtureRef,
    });
    expect((await mk("nope:round:1:match:1")).status).toBe(409);
    files["Carol/sv_c"] = mkTeam("Carol XI", "c");
    const wrong = await as("Org", "POST", "/api/tabletop/matches", {
      home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Carol", teamSaveId: "sv_c" }, fixtureRef: fixtureId,
    });
    expect(wrong.status).toBe(409);
    expect((await mk(fixtureId, fixtureHome, fixtureAway)).status).toBe(201);
    // either orientation is accepted
    await repo.updateMatch({ ...(await repo.listMatches())[0]!, state: "recording" });
    tstore.recordResult(fixtureId, { expectedRevision: 1, homeScore: 0, awayScore: 0 }, NOW);
    expect((await mk(fixtureId, fixtureAway, fixtureHome)).status).toBe(409); // resolved now
  });

  it("publish writes the fixture result through recordResult, in either orientation (scores follow the fixture's home)", async () => {
    // match home = the fixture's AWAY coach: scores must be swapped onto the fixture
    const id = await confirmedMatch(fixtureAway, fixtureId);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(200);
    const m = tstore.match(fixtureId)!;
    expect(m.status).toBe("completed");
    expect(m.result).toMatchObject({ homeScore: 1, awayScore: 2, homeCasualties: 0, awayCasualties: 1, reportedAt: NOW.toISOString() });
    expect(m.revision).toBe(2);
    // the tournament table (fork-reported path) now counts it
    const rows = tstore.standings(m.tournamentId);
    const winner = rows.find((r) => r.coachId === fixtureAway)!;
    expect(winner.wins).toBe(1);
  });

  it("publish is refused (409) when the fixture was resolved meanwhile; nothing is published", async () => {
    const id = await confirmedMatch(fixtureHome, fixtureId);
    tstore.recordResult(fixtureId, { expectedRevision: 1, homeScore: 3, awayScore: 3 }, NOW);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(409);
    expect(results.list()).toHaveLength(0);
    expect((await repo.getMatch(id))!.state).toBe("confirmed");
  });
});

describe("tabletop T3: undo after publish", () => {
  it("retracts the fixture result, the counted row and the standings contribution, and reopens the match", async () => {
    const id = await confirmedMatch(fixtureHome, fixtureId, "Rules");
    await as("Org", "POST", `/api/tabletop/matches/${id}/publish`);
    expect(tstore.match(fixtureId)!.status).toBe("completed");
    expect(leagueStandings(results.list(), "Rules", () => undefined)).toHaveLength(2);

    const undone = await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`);
    expect(undone.status).toBe(200);
    const m = tstore.match(fixtureId)!;
    expect(m.status).toBe("scheduled");
    expect(m.result).toBeUndefined();
    expect(tstore.tournament(m.tournamentId)!.status).toBe("active");
    expect(tstore.standings(m.tournamentId).every((r) => r.wins === 0 && r.played === 0)).toBe(true);
    expect(results.listAll()).toHaveLength(0);
    expect(leagueStandings(results.list(), "Rules", () => undefined)).toEqual([]);
    expect((await repo.getMatch(id))).toMatchObject({ state: "recording" });
    expect((await repo.getMatch(id))!.fixtureLink).toBeUndefined();
    // the fixture can be used again
    expect(gateway().get(fixtureId)!.open).toBe(true);
  });

  it("refuses (409) when the fixture result was changed after publication", async () => {
    const id = await confirmedMatch(fixtureHome, fixtureId);
    await as("Org", "POST", `/api/tabletop/matches/${id}/publish`);
    const snap = tstore.snapshot();
    snap.scheduledMatches[fixtureId]!.revision += 1; // someone touched it
    tstore.writeSnapshot(snap);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(409);
    expect((await repo.getMatch(id))!.state).toBe("published");
  });
});

describe("tabletop T3: league standings and Elo", () => {
  const fork = (gameId: string, home: string, away: string, hs: number, as_: number): StoredTournamentResult => ({
    gameId, pulledAt: "2026-02-01T00:00:00.000Z",
    home: { teamId: `t-${home}`, teamName: home, coach: home }, away: { teamId: `t-${away}`, teamName: away, coach: away },
    teams: [
      { teamId: `t-${home}`, score: hs, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] },
      { teamId: `t-${away}`, score: as_, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 }, players: [] },
    ],
  });
  const meta = (gameId: string) => gameId === "100" || gameId === "101"
    ? { gameId, packageName: "Rules", home: { ffbCoachId: "x", teamId: "x", instructions: { treasury: 0, inducements: [] } }, away: { ffbCoachId: "y", teamId: "y", instructions: { treasury: 0, inducements: [] } }, createdAt: "" }
    : undefined;

  it("mixes fork and published tabletop rows: W/D/L, TD/CAS, points 3/1/0, and a league points override", async () => {
    // fork games in league "Rules": Alice beats Bob 2-0, then Bob and Alice draw 1-1.
    const forkMeta = (gameId: string) => {
      const row = gameId === "100" ? { h: "Alice", a: "Bob" } : gameId === "101" ? { h: "Bob", a: "Alice" } : undefined;
      return row ? { gameId, packageName: "Rules", home: { ffbCoachId: row.h, teamId: `t-${row.h}`, instructions: { treasury: 0, inducements: [] } }, away: { ffbCoachId: row.a, teamId: `t-${row.a}`, instructions: { treasury: 0, inducements: [] } }, createdAt: "" } : undefined;
    };
    void meta;
    results.put(fork("100", "Alice", "Bob", 2, 0));
    results.put(fork("101", "Bob", "Alice", 1, 1));
    const id = await confirmedMatch("Bob", undefined, "Rules"); // Bob 2 - Alice 1
    // unpublished: not counted
    let rows = leagueStandings(results.list(), "Rules", forkMeta);
    expect(rows.find((r) => r.coach === "Alice")).toMatchObject({ played: 2, won: 1, drawn: 1, points: 4 });
    await as("Org", "POST", `/api/tabletop/matches/${id}/publish`);
    rows = leagueStandings(results.list(), "Rules", forkMeta);
    const alice = rows.find((r) => r.coach === "Alice")!;
    const bob = rows.find((r) => r.coach === "Bob")!;
    expect(alice).toMatchObject({ played: 3, won: 1, drawn: 1, lost: 1, tdFor: 4, tdAgainst: 3, points: 4 });
    expect(bob).toMatchObject({ played: 3, won: 1, drawn: 1, lost: 1, tdFor: 3, tdAgainst: 4, casFor: 1, points: 4 });
    expect(leagueStandings(results.list(), "Rules", forkMeta, { win: 2, draw: 1, loss: 0 }).find((r) => r.coach === "Alice")!.points).toBe(3);
    expect(leagueStandings(results.list(), "Other", forkMeta)).toEqual([]);
    // the HTTP route
    const http = (await as("Alice", "GET", "/api/standings?league=Rules")).body as { rows: Array<{ coach: string }> };
    expect(http.rows).toHaveLength(2);
    expect((await as("Alice", "GET", "/api/standings")).status).toBe(400);
  });

  it("Elo includes published tabletop rows by default; the flag excludes them", async () => {
    const id = await confirmedMatch("Bob");
    await as("Org", "POST", `/api/tabletop/matches/${id}/publish`);
    const rows = results.list();
    expect(computeElo(rows).get("bob")!.rating).toBeGreaterThan(1500);
    expect(computeElo(rows, { includeTabletop: false }).size).toBe(0);
    process.env.ELO_EXCLUDE_TABLETOP = "1";
    try { expect(computeElo(rows).size).toBe(0); } finally { delete process.env.ELO_EXCLUDE_TABLETOP; }
    expect(computeElo(rows).size).toBe(2);
  });
});
