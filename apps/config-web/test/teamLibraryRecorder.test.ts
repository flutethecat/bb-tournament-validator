import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMatch, tabletopApi, type FixtureGateway, type FixtureView, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

// Team library lane review (P2-5): a tabletop recorder match started for a league fixture is never published to it once
// the fixture's seats changed (a swap or takeover re-seated it): the result would be credited to a coach who did not
// play it. The fixture gateway here is a stub with a league fixture ref; the swap / takeover side refuses while such a
// match is open (leagueTeamLibrary.test.ts).

const NOW = new Date("2026-11-03T10:00:00.000Z");
const REF = "league:tabbl:season-7:f3";
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let fixture: FixtureView;
const recorded: unknown[] = [];

const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
  schema: 1, name, treasury: 0, dedicatedFans: 1,
  players: ["1", "2"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
});
const files: Record<string, TabletopTeamFile> = { "Ann/sv_a": mkTeam("Ann XI", "a"), "Bob/sv_b": mkTeam("Bob XI", "b") };
const gateway = (): FixtureGateway => ({
  get: (id) => (id === REF ? fixture : undefined),
  record: (_id, input) => { recorded.push(input); fixture = { ...fixture, revision: fixture.revision + 1, status: "completed", resultReportedAt: NOW.toISOString(), ...(input.opId ? { resultOpId: input.opId } : {}) }; },
  retract: () => undefined,
});
const deps = (): TabletopApiDeps => ({
  repo, results, fixtures: gateway(), loadTeamFile: (coach, saveId) => files[`${coach}/${saveId}`], isBanned: () => false,
  drawSeats: () => false, isOrganizer: (c) => c === "Jay", now: () => NOW,
});
const as = (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams()) as Promise<TabletopResult>;

async function confirmed(): Promise<string> {
  const created = await createMatch("Jay", true, { pregame: "skip", home: { coach: "Ann", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" }, postMatch: "spp-only", fixtureRef: REF }, deps(), () => NOW, { fromLobby: true });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = (created.body as { match: { id: string } }).match.id;
  await as("Jay", "POST", `/api/tabletop/matches/${id}/events`, { events: [{ id: "evt-00000001", type: "touchdown", team: "home", player: "a1", payload: {} }] });
  await as("Jay", "POST", `/api/tabletop/matches/${id}/submit`);
  expect((await as("Jay", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
  return id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tlib-recorder-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  recorded.length = 0;
  fixture = { id: REF, open: true, status: "scheduled", revision: 0, home: { coach: "Ann" }, away: { coach: "Bob" }, round: 3 };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("recorder publish after a change of hands", () => {
  it("refuses with a clear message when the fixture's coaches are no longer the match's; nothing is published", async () => {
    const id = await confirmed();
    fixture = { ...fixture, home: { coach: "Dan" } }; // Grudge Rollers taken over by Dan meanwhile
    const r = await as("Jay", "POST", `/api/tabletop/matches/${id}/publish`);
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("coaches of this fixture changed since the match started");
    expect(recorded).toHaveLength(0);
    expect(results.list()).toHaveLength(0);
    expect((await repo.getMatch(id))!.state).toBe("confirmed");
  });

  it("publishes as before while the seats are the coaches who played", async () => {
    const id = await confirmed();
    expect((await as("Jay", "POST", `/api/tabletop/matches/${id}/publish`)).status).toBe(200);
    expect(recorded).toHaveLength(1);
  });
});
