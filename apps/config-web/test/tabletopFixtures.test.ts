import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tabletopApi, type FixtureGateway, type FixtureView, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { TournamentStore } from "../src/tournaments/store.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let tstore: TournamentStore;
let fixtureId = "";
let otherFixtureId = "";
let fixtureHome = "";
let fixtureAway = "";
let resolvable = true;
const files: Record<string, TabletopTeamFile> = {};

const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
  schema: 1, name, treasury: 0, dedicatedFans: 1,
  players: [{ id: `${prefix}1`, name: `${prefix} 1`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }],
});
const view = (id: string): FixtureView | undefined => {
  const m = tstore.match(id);
  if (!m?.away) return undefined;
  const t = tstore.tournament(m.tournamentId)!;
  return {
    id: m.id, packageName: t.packageName,
    open: t.status === "active" && !["completed", "cancelled", "dismissed"].includes(m.status),
    status: m.status, revision: m.revision,
    home: { coach: m.home.coach.ffbCoachId, teamId: m.home.teamId }, away: { coach: m.away.coach.ffbCoachId, teamId: m.away.teamId },
    tournament: { id: t.id, name: t.name }, round: m.roundNumber,
  };
};
const gateway = (): FixtureGateway => ({
  get: view,
  list: () => tstore.matches().map((m) => view(m.id)).filter((v): v is FixtureView => !!v),
  record: (id, input, at) => { tstore.recordResult(id, input, at); },
  retract: () => undefined,
});
const deps = (): TabletopApiDeps => ({
  repo, results, fixtures: gateway(),
  // fixture entrants carry `team-<coach>`; the tabletop store can load each coach's `sv_<initial>` save
  resolveFixtureTeam: (coach, teamId) => (resolvable && teamId === `team-${coach.toLowerCase()}` ? { ref: `sv_${coach[0]!.toLowerCase()}`, name: `${coach} XI` } : undefined),
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => NOW,
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return (await tabletopApi(method, p!, { coach, method: "discord" }, body, deps(), new URLSearchParams(q ?? "")))!;
};

function tournament(name: string, coaches: [string, string]): string {
  const t = tstore.createTournament({ name, packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: "Org" }, NOW);
  for (const c of coaches) tstore.registerEntrant(t.id, { coachId: c, ffbCoachId: c, verifiedAt: NOW.toISOString() }, `team-${c.toLowerCase()}`, NOW);
  const snap = tstore.snapshot();
  snap.tournaments[t.id]!.status = "active";
  tstore.writeSnapshot(snap);
  return tstore.generateNextRound(t.id, NOW).scheduledMatchIds[0]!;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-fixtures-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  tstore = new TournamentStore(join(dir, "tournaments"));
  resolvable = true;
  for (const c of ["Alice", "Bob", "Carol", "Dave"]) files[`${c}/sv_${c[0]!.toLowerCase()}`] = mkTeam(`${c} XI`, c[0]!.toLowerCase());
  fixtureId = tournament("Alpha Cup", ["Alice", "Bob"]);
  otherFixtureId = tournament("Beta Cup", ["Carol", "Dave"]);
  fixtureHome = tstore.match(fixtureId)!.home.coach.ffbCoachId;
  fixtureAway = tstore.match(fixtureId)!.away!.coach.ffbCoachId;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("GET /api/tabletop/fixtures", () => {
  it("lists the caller's unresolved fixtures (either orientation) with teamRefs resolved", async () => {
    const r = await as("Bob", "GET", "/api/tabletop/fixtures");
    expect(r.status).toBe(200);
    const rows = (r.body as { fixtures: Array<Record<string, any>> }).fixtures;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fixtureRef: fixtureId, tournament: { name: "Alpha Cup" }, round: 1,
      home: { coach: fixtureHome, teamRef: `sv_${fixtureHome[0]!.toLowerCase()}`, teamName: `${fixtureHome} XI` },
      away: { coach: fixtureAway, teamRef: `sv_${fixtureAway[0]!.toLowerCase()}` },
    });
    expect(rows[0]!.tournament.id).toBeDefined();
  });

  it("omits teamRef when the team cannot be resolved; excludes resolved fixtures; organisers see all with ?all=1", async () => {
    resolvable = false;
    const bare = ((await as("Alice", "GET", "/api/tabletop/fixtures")).body as { fixtures: Array<{ home: object }> }).fixtures;
    expect(bare[0]!.home).toEqual({ coach: fixtureHome });
    expect(((await as("Mallory", "GET", "/api/tabletop/fixtures")).body as { fixtures: unknown[] }).fixtures).toEqual([]);
    // an organiser who is not playing sees nothing by default, everything with ?all=1; a player's ?all=1 changes nothing
    expect(((await as("Org", "GET", "/api/tabletop/fixtures")).body as { fixtures: unknown[] }).fixtures).toEqual([]);
    const all = ((await as("Org", "GET", "/api/tabletop/fixtures?all=1")).body as { fixtures: Array<{ fixtureRef: string; tournament: { name: string } }> }).fixtures;
    expect(all.map((f) => f.tournament.name)).toEqual(["Alpha Cup", "Beta Cup"]);
    expect(((await as("Alice", "GET", "/api/tabletop/fixtures?all=1")).body as { fixtures: unknown[] }).fixtures).toHaveLength(1);
    tstore.recordResult(fixtureId, { expectedRevision: 1, homeScore: 1, awayScore: 0 }, NOW);
    expect(((await as("Alice", "GET", "/api/tabletop/fixtures")).body as { fixtures: unknown[] }).fixtures).toEqual([]);
    expect((await tabletopApi("GET", "/api/tabletop/fixtures", undefined, undefined, deps()))!.status).toBe(401);
  });
});

describe("create from a fixtureRef alone", () => {
  it("fills coaches and teams from the fixture", async () => {
    const r = await as(fixtureAway, "POST", "/api/tabletop/matches", { fixtureRef: fixtureId, pregame: "skip" });
    expect(r.status).toBe(201);
    const m = (r.body as { match: Record<string, any> }).match;
    expect(m).toMatchObject({
      fixtureRef: fixtureId, league: "Rules",
      home: { coach: fixtureHome, teamSaveId: `sv_${fixtureHome[0]!.toLowerCase()}` },
      away: { coach: fixtureAway, teamSaveId: `sv_${fixtureAway[0]!.toLowerCase()}` },
    });
    expect(m.fixtureSwap).toBeUndefined(); // same orientation as the fixture
  });

  it("an explicit body wins over the fixture; a non-participant is refused; unresolved teams must be named", async () => {
    // reversed orientation sent explicitly: accepted, flagged as swapped
    const swapped = await as("Org", "POST", "/api/tabletop/matches", {
      fixtureRef: fixtureId, pregame: "skip",
      home: { coach: fixtureAway, team: `sv_${fixtureAway[0]!.toLowerCase()}` }, away: { coach: fixtureHome, team: `sv_${fixtureHome[0]!.toLowerCase()}` },
    });
    expect(swapped.status).toBe(201);
    expect((swapped.body as { match: { fixtureSwap?: boolean } }).match.fixtureSwap).toBe(true);
    expect((await as("Mallory", "POST", "/api/tabletop/matches", { fixtureRef: otherFixtureId })).status).toBe(403);
    resolvable = false;
    const unresolved = await as(fixtureHome, "POST", "/api/tabletop/matches", { fixtureRef: fixtureId });
    expect(unresolved.status).toBe(400);
    expect((unresolved.body as { error: string }).error).toMatch(/Choose both teams/);
    // naming just the missing teams is enough
    const named = await as(fixtureHome, "POST", "/api/tabletop/matches", {
      fixtureRef: fixtureId, pregame: "skip",
      home: { team: `sv_${fixtureHome[0]!.toLowerCase()}` }, away: { team: `sv_${fixtureAway[0]!.toLowerCase()}` },
    });
    expect(named.status).toBe(409); // the organiser's swapped match above already holds these teams
    expect((named.body as { error: string }).error).toMatch(/unfinished recorded match/);
  });

  it("a resolved fixture cannot start a match", async () => {
    tstore.recordResult(fixtureId, { expectedRevision: 1, homeScore: 0, awayScore: 0 }, NOW);
    const r = await as(fixtureHome, "POST", "/api/tabletop/matches", { fixtureRef: fixtureId });
    expect(r.status).toBe(409);
  });
});
