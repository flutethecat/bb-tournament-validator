import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireFileWriteLock, libraryWriteLockPath, readLibrary, upsertLibraryTeam, type AdminGameEntry } from "@bb/fork-ops";
import { leagueApi, resetForkToggleLimit, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { createLeagueForkClient, removalPending } from "../src/leagues/forkClient";
import { cleanupFixtureForkTeams, forkTeamBackfill, leagueForkCleanupRoute, runForkTeamCleanup } from "../src/leagues/forkCleanup";
import { cleanupBackoffMs, forkCleanupReason } from "../src/leagues/forkCleanupRules";
import { syncLeagueForkResults, type ForkScheduleOutcome, type LeagueForkClient } from "../src/leagues/forkPlay";
import type { ForkGameResult } from "../src/leagues/forkResult";
import { buildLeagueForkTeam, forkTeamIdFor } from "../src/leagues/forkTeam";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";

// Removal of a fixture's fork team copies once the match is over (src/leagues/forkCleanup.ts, owner 11-03). The fork is
// a stub with an in-memory "disk" for the fixture flow, and the real fork client on temp dirs (io seams) for the IO.

const pos = (id: string, name: string, cost: number) =>
  `<position id="${id}"><quantity>16</quantity><name>${name}</name><type>Regular</type><gender>male</gender><cost>${cost}</cost>` +
  `<movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList></skillList></position>`;
const HUMAN = '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' + pos("10", "Human Lineman", 50000) + "</roster>";
const ORC = '<roster id="orc.bb2025"><name>Orc</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' + pos("20", "Orc Lineman", 50000) + "</roster>";
const ROSTERS = new Map([["human.bb2025", HUMAN], ["orc.bb2025", ORC]]);

const player = (playerId: string, position: string): LeaguePlayer => ({
  playerId, number: 1, name: playerId, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0,
  missNextGame: false, stats: { ...EMPTY_PLAYER_STATS },
});
const team = (id: string, name: string, race: string, coach: string, position: string): LeagueTeam => ({
  id, name, race, coach, coachId: coach, teamValue: 1_000_000, treasury: 0, rerolls: 1, fans: 1, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "2", raceLeague: "", players: [player(`${id}-p1`, position)], formerPlayers: [],
});
const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Grudge Rollers", teamId: "grudge", coach: "Ann", coachId: "Ann", race: "Human", score: null, cas: null, conceded: false },
  away: { team: "Green Tide", teamId: "orcs", coach: "Bob", coachId: "Bob", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, forkEnabled: true, ...over,
});
const season = (fixtures: LeagueFixture[]): SeasonRecord => ({
  id: "season-7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, participants: [], teams: [team("grudge", "Grudge Rollers", "Human", "Ann", "Human Lineman"), team("orcs", "Green Tide", "Orc", "Bob", "Orc Lineman")],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

const HID = forkTeamIdFor("tabbl", "season-7", "grudge");
const AID = forkTeamIdFor("tabbl", "season-7", "orcs");
const basicResult = (gameId: string): ForkGameResult => ({
  gameId, source: "basic", playedAt: "2026-10-30T20:00:00.000Z",
  teams: [
    { teamId: HID, score: 1, conceded: false, winnings: 0, players: [] },
    { teamId: AID, score: 0, conceded: false, winnings: 0, players: [] },
  ],
});

// ---- stub fork with a disk ----

interface Disk extends LeagueForkClient {
  files: Set<string>;
  libs: Map<string, string>;
  live: Set<string>;
  failRemove: number;
  removeCalls: number;
  next: ForkScheduleOutcome;
  states: Map<string, { status: "scheduled" | "active" | "finished" }>;
  results: Map<string, ForkGameResult>;
}
function diskFork(): Disk {
  const d: Disk = {
    files: new Set(), libs: new Map(), live: new Set(), failRemove: 0, removeCalls: 0,
    next: { kind: "scheduled", gameId: "g42" }, states: new Map(), results: new Map(),
    rosters: () => ROSTERS,
    async prepareGame({ install }) {
      for (const t of install) { d.files.add(t.file.forkTeamId); d.libs.set(t.file.forkTeamId, t.coach); }
      return d.next;
    },
    async findGame() { return { kind: "none" }; },
    async deleteGame() { return true; },
    async launchFile() { return "<jnlp/>"; },
    async gameStates(ids) { return new Map([...d.states].filter(([id]) => ids.includes(id))); },
    async result(id) { return d.results.get(id); },
    async removeTeams(teams) {
      d.removeCalls += 1;
      if (d.failRemove > 0) { d.failRemove -= 1; throw new Error("the fork did not reload its teams"); }
      const busy = teams.find((t) => d.live.has(t.forkTeamId));
      if (busy) throw new Error(`team ${busy.forkTeamId} is in a game on Super FUMBBL`);
      for (const t of teams) { d.files.delete(t.forkTeamId); d.libs.delete(t.forkTeamId); }
      return { removed: teams.map((t) => t.forkTeamId) };
    },
    teamCopies(ids) {
      return new Map(ids.map((id) => [id, { files: d.files.has(id) ? 1 : 0, libraries: d.libs.has(id) ? 1 : 0 }]));
    },
  };
  return d;
}

describe("fork team copies are removed when the match is over", () => {
  let dir: string;
  let store: LeagueStore;
  let fork: Disk;
  let body: unknown;
  let clock: Date;
  const lines: string[] = [];
  const JAY = { coach: "Jay", admin: false };
  const ANN = { coach: "Ann", admin: false };
  const base = "/api/leagues/tabbl/seasons/season-7/fixtures/f1";
  const deps = (): LeagueApiDeps => ({
    store, fork, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)), now: () => clock,
    identities: () => [{ coach: "Jay", level: "organizer" }, { coach: "Ann", level: "player" }, { coach: "Bob", level: "player" }],
    notify: () => undefined,
  });
  const call = async (method: string, path: string, auth: { coach: string; admin: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  const cleanupDeps = () => ({ store, fork, now: () => clock, log: (l: string) => { lines.push(l); } });
  const fixture = (id = "f1") => store.season("tabbl", "season-7")!.fixtures.find((f) => f.id === id)!;
  const finish = async (gameId = "g42") => {
    fork.states.set(gameId, { status: "finished" });
    fork.results.set(gameId, basicResult(gameId));
    return syncLeagueForkResults({ store, fork, now: () => clock });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-fork-cleanup-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], playOnFork: true });
    store.putSeason(season([fx("f1"), fx("f2")]));
    fork = diskFork();
    clock = new Date("2026-10-30T12:00:00Z");
    lines.length = 0;
    resetForkToggleLimit();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("removes both copies after the result is banked, logged on the server and in the fork history", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect([...fork.files].sort()).toEqual([HID, AID].sort());
    const synced = await finish();
    expect(synced.applied).toEqual(["g42"]);
    expect(fixture().fork).toMatchObject({ status: "finished", cleanup: { state: "pending", attempts: 0 } });
    expect(fork.files.size).toBe(2); // banking never touches the fork
    const out = await runForkTeamCleanup(cleanupDeps());
    expect(out).toEqual({ removed: ["tabbl/season-7/f1"], failed: [] });
    expect(fork.files.size).toBe(0);
    expect(fork.libs.size).toBe(0);
    const c = fixture().fork!.cleanup!;
    expect(c).toMatchObject({ state: "removed", reason: "the game is over and its result is banked" });
    expect(c.removed!.sort()).toEqual([HID, AID].sort());
    expect(fixture().fork!.log.at(-1)!.text).toBe("Removed the Super FUMBBL copies of Grudge Rollers and Green Tide (the game is over and its result is banked).");
    expect(lines.join("\n")).toContain(`removed for tabbl/season-7/f1: ${HID}`);
    expect(lines.join("\n")).not.toMatch(/Ann|Bob/);
  });

  it("never removes copies while the game is scheduled or live (store and fork both checked)", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect(forkCleanupReason(fixture())).toBe("");
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.removeCalls).toBe(0);
    // A marker written by mistake on a scheduled fixture is skipped, not acted on.
    const s = store.season("tabbl", "season-7")!;
    s.fixtures[0]!.fork!.cleanup = { state: "pending", reason: "x", since: clock.toISOString(), attempts: 0 };
    store.putSeason(s);
    expect(await cleanupFixtureForkTeams(cleanupDeps(), { leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1" })).toEqual({ kind: "skipped", why: "the copies are needed again" });
    expect(fork.files.size).toBe(2);
    // In progress: still kept.
    fork.states.set("g42", { status: "active" });
    await syncLeagueForkResults({ store, fork, now: () => clock });
    expect(fixture().fork!.status).toBe("in_progress");
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.removeCalls).toBe(0);
    // The fork says a team is in a game (e.g. a friendly from the library): the removal fails and is retried later.
    await finish();
    fork.live.add(HID);
    expect((await runForkTeamCleanup(cleanupDeps())).failed).toEqual(["tabbl/season-7/f1"]);
    expect(fork.files.size).toBe(2);
    expect(fixture().fork!.cleanup).toMatchObject({ state: "failed", attempts: 1, error: expect.stringContaining("is in a game") });
  });

  it("keeps a team id another fixture still needs, and removes only the other", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    // f2 (same two teams) was built earlier and is waiting to be scheduled again: it still needs the home copy.
    const s = store.season("tabbl", "season-7")!;
    const f2 = s.fixtures.find((f) => f.id === "f2")!;
    f2.fork = { status: "teams_built", teams: { home: { ...s.fixtures[0]!.fork!.teams.home! } }, log: [] };
    store.putSeason(s);
    await finish();
    const out = await cleanupFixtureForkTeams(cleanupDeps(), { leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1" });
    expect(out).toEqual({ kind: "removed", removed: [AID], kept: [HID] });
    expect([...fork.files]).toEqual([HID]);
    expect(fixture().fork!.cleanup).toMatchObject({ state: "removed", removed: [AID], kept: [HID] });
    expect(fixture().fork!.log.at(-1)!.text).toBe("Kept the Super FUMBBL copy of Grudge Rollers: another fixture still uses it.");
    await runForkTeamCleanup(cleanupDeps());
    expect([...fork.files]).toEqual([HID]); // still needed by f2
    // f2 later gets a hand-entered result: nobody needs the kept copy any more, so the tick removes it after all.
    const s2 = store.season("tabbl", "season-7")!;
    const g = s2.fixtures.find((f) => f.id === "f2")!;
    g.home.score = 1; g.away.score = 1;
    store.putSeason(s2);
    expect(await forkTeamBackfill(cleanupDeps())).toHaveLength(2); // both fixtures list it until then
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.files.size).toBe(0);
    expect(fixture().fork!.cleanup!.removed!.sort()).toEqual([HID, AID].sort());
    expect(fixture().fork!.cleanup!.kept).toBeUndefined();
    expect(await forkTeamBackfill(cleanupDeps())).toEqual([]);
  });

  it("is idempotent: a second run, a forced re-run and a crash-resumed run remove nothing twice", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    await finish();
    await runForkTeamCleanup(cleanupDeps());
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.removeCalls).toBe(1);
    expect(await cleanupFixtureForkTeams(cleanupDeps(), { leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1" }, { force: true })).toEqual({ kind: "skipped", why: "already removed" });
    // A re-run of applying the same result does not re-mark it.
    await finish();
    expect(fixture().fork!.cleanup!.state).toBe("removed");
    const logged = fixture().fork!.log.filter((l) => l.text.startsWith("Removed the Super FUMBBL copies"));
    expect(logged).toHaveLength(1);
  });

  it("a failed removal never blocks banking, retries with a backoff and survives a restart", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    fork.failRemove = 2;
    await finish();
    // Banked in full before any cleanup.
    expect(fixture().fork!.status).toBe("finished");
    expect(fixture().fork!.result!.gameId).toBe("g42");
    expect(fixture().home.score).toBe(1);
    expect((await runForkTeamCleanup(cleanupDeps())).failed).toHaveLength(1);
    const c1 = fixture().fork!.cleanup!;
    expect(c1).toMatchObject({ state: "failed", attempts: 1, error: "the fork did not reload its teams" });
    expect(Date.parse(c1.nextAttemptAt!) - clock.getTime()).toBe(cleanupBackoffMs(1));
    // Before the retry time: not tried.
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.removeCalls).toBe(1);
    clock = new Date(clock.getTime() + cleanupBackoffMs(1));
    await runForkTeamCleanup(cleanupDeps());
    expect(fixture().fork!.cleanup).toMatchObject({ state: "failed", attempts: 2 });
    expect(cleanupBackoffMs(2)).toBe(2 * cleanupBackoffMs(1));
    expect(cleanupBackoffMs(50)).toBe(6 * 60 * 60_000);
    expect(fixture().fork!.log.filter((l) => l.text.startsWith("Could not remove"))).toHaveLength(1); // first failure only
    // Restart: a fresh store over the same dir resumes the marker.
    store = new LeagueStore(dir);
    clock = new Date(clock.getTime() + cleanupBackoffMs(2));
    expect((await runForkTeamCleanup(cleanupDeps())).removed).toEqual(["tabbl/season-7/f1"]);
    expect(fork.files.size).toBe(0);
    expect(fixture().fork!.cleanup).toMatchObject({ state: "removed", attempts: 2 });
  });

  it("reset and regenerate reuse the same copies (no orphans); the banked match then leaves none", async () => {
    fork.next = { kind: "rejected", error: "refused" };
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(502);
    expect(fixture().fork!.status).toBe("launch_failed");
    expect(forkCleanupReason(fixture())).toBe(""); // a failed game's teams are still needed for the retry
    expect((await call("POST", `${base}/fork/reset`, JAY, { reason: "fork was down" })).status).toBe(200);
    fork.next = { kind: "scheduled", gameId: "g43" };
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect([...fork.files].sort()).toEqual([HID, AID].sort());
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.removeCalls).toBe(0);
    await finish("g43");
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.files.size).toBe(0);
    expect(fork.libs.size).toBe(0);
  });

  it("cancel removes the copies of a withdrawn game; allowing play again rebuilds both and clears the marker", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect((await call("PATCH", base, { coach: "Root", admin: true }, { forkCancelled: true })).status).toBe(200);
    expect(fixture().fork).toMatchObject({ status: "cancelled", cleanup: { state: "pending", reason: "Super FUMBBL play was cancelled" } });
    await runForkTeamCleanup(cleanupDeps());
    expect(fork.files.size).toBe(0);
    expect((await call("PATCH", base, { coach: "Root", admin: true }, { forkCancelled: false })).status).toBe(200);
    expect(fixture().fork!.status).toBe("teams_built");
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    expect([...fork.files].sort()).toEqual([HID, AID].sort());
    expect(fixture().fork!.cleanup).toBeUndefined();
  });

  it("backfill: the dry run lists banked fixtures without a marker and changes nothing; apply removes them", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    await finish();
    // As if banked before cleanup existed: no marker.
    const s = store.season("tabbl", "season-7")!;
    delete s.fixtures[0]!.fork!.cleanup;
    store.putSeason(s);
    await runForkTeamCleanup({ ...cleanupDeps(), baselineFile: join(dir, "baseline.json") }); // first scan: baseline
    expect(fork.removeCalls).toBe(0); // the server never sweeps fixtures older than its first scan
    const dry = await forkTeamBackfill(cleanupDeps());
    expect(dry).toHaveLength(1);
    expect(dry[0]).toMatchObject({ fixtureId: "f1", reason: "the game is over and its result is banked" });
    expect(dry[0]!.marker).toBeUndefined();
    expect(dry[0]!.teams.every((t) => t.files === 1 && t.libraries === 1 && !t.neededElsewhere)).toBe(true);
    expect(fork.files.size).toBe(2);
    expect(fixture().fork!.cleanup).toBeUndefined();
    const applied = await forkTeamBackfill(cleanupDeps(), { apply: true });
    expect(applied[0]!.outcome).toMatchObject({ kind: "removed" });
    expect(fork.files.size).toBe(0);
    expect(fixture().fork!.cleanup!.state).toBe("removed");
    expect(await forkTeamBackfill(cleanupDeps())).toEqual([]);
  });

  it("the tick also cleans fixtures whose result came from another writer (hand entry), after the first-scan baseline", async () => {
    // f1: generated, then the game failed and an organiser entered the result by hand (no marker from the fork path).
    fork.next = { kind: "rejected", error: "refused" };
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(502);
    const s = store.season("tabbl", "season-7")!;
    s.fixtures[0]!.home.score = 2; s.fixtures[0]!.away.score = 0;
    store.putSeason(s);
    expect(forkCleanupReason(fixture())).toBe("the fixture has a result without a Super FUMBBL game");
    const baselineFile = join(dir, "league-fork-cleanup-baseline.json");
    // First scan on this server: f1 was already like this, so it is recorded and left to the backfill.
    await runForkTeamCleanup({ ...cleanupDeps(), baselineFile });
    expect(JSON.parse(readFileSync(baselineFile, "utf8")).refs).toEqual(["tabbl/season-7/f1"]);
    expect(fork.removeCalls).toBe(0);
    expect(fixture().fork!.cleanup).toBeUndefined();
    expect((await forkTeamBackfill(cleanupDeps())).map((r) => r.fixtureId)).toEqual(["f1"]);
    // f2: generated after, then its result entered by hand: the next scan marks and removes it (shared ids aside).
    const s2 = store.season("tabbl", "season-7")!;
    s2.fixtures[0]!.fork!.teams = {}; // f1's record set aside so f2's copies are not shared with it
    store.putSeason(s2);
    fork.next = { kind: "rejected", error: "refused" };
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/fixtures/f2/fork/generate", ANN, {})).status).toBe(502);
    const s3 = store.season("tabbl", "season-7")!;
    const f2 = s3.fixtures.find((f) => f.id === "f2")!;
    f2.home.score = 1; f2.away.score = 1;
    store.putSeason(s3);
    const out = await runForkTeamCleanup({ ...cleanupDeps(), baselineFile });
    expect(out.removed).toEqual(["tabbl/season-7/f2"]);
    expect(fixture("f2").fork!.cleanup).toMatchObject({ state: "removed", reason: "the fixture has a result without a Super FUMBBL game" });
    // f2 copies gone; f1 (baseline) is still the backfill's.
    expect(fork.files.size).toBe(0);
  });

  it("removing a shared id clears the build fingerprint on every fixture that recorded it, so a regenerate rebuilds", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    await finish();
    // f2 recorded the same copies earlier, and play on it was cancelled (no game): it does not need them either.
    const s = store.season("tabbl", "season-7")!;
    const f2 = s.fixtures.find((f) => f.id === "f2")!;
    f2.fork = { status: "cancelled", statusBeforeCancel: "teams_built", teams: JSON.parse(JSON.stringify(s.fixtures[0]!.fork!.teams)), log: [] };
    f2.forkCancelled = true;
    store.putSeason(s);
    expect(fixture("f2").fork!.teams.home!.revision).toBeTruthy();
    expect(await cleanupFixtureForkTeams(cleanupDeps(), { leagueId: "tabbl", seasonId: "season-7", fixtureId: "f1" })).toMatchObject({ kind: "removed" });
    expect(fork.files.size).toBe(0);
    expect(fixture("f2").fork!.teams.home!.revision).toBeUndefined();
    expect(fixture("f2").fork!.teams.away!.revision).toBeUndefined();
    expect(fixture("f2").fork!.cleanup).toBeUndefined();
    // Play allowed again on f2 and generated: both teams are rebuilt (installed), not trusted.
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-7/fixtures/f2", { coach: "Root", admin: true }, { forkCancelled: false })).status).toBe(200);
    fork.next = { kind: "scheduled", gameId: "g77" };
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/fixtures/f2/fork/generate", ANN, {})).status).toBe(200);
    expect([...fork.files].sort()).toEqual([HID, AID].sort());
  });

  it("admin route: site admins only, dry run unless apply is exactly true, then removes inside the server", async () => {
    expect((await call("POST", `${base}/fork/generate`, ANN, {})).status).toBe(200);
    await finish();
    const s = store.season("tabbl", "season-7")!;
    delete s.fixtures[0]!.fork!.cleanup;
    store.putSeason(s);
    const rdeps = { store, fork, now: () => clock, log: () => undefined };
    expect((await leagueForkCleanupRoute(undefined, {}, rdeps)).status).toBe(401);
    expect((await leagueForkCleanupRoute({ coach: "Jay", admin: false }, { apply: true }, rdeps)).status).toBe(403);
    expect((await leagueForkCleanupRoute({ coach: "Root", admin: true }, {}, { ...rdeps, fork: undefined })).status).toBe(503);
    const dry = await leagueForkCleanupRoute({ coach: "Root", admin: true }, { apply: "yes" }, rdeps);
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ apply: false, rows: [{ fixtureId: "f1" }] });
    expect(fork.files.size).toBe(2);
    const applied = await leagueForkCleanupRoute({ coach: "Root", admin: true }, { apply: true }, rdeps);
    expect(applied.body).toMatchObject({ apply: true, rows: [{ fixtureId: "f1", outcome: { kind: "removed" } }] });
    expect(fork.files.size).toBe(0);
  });
});

// ---- the real fork client on temp dirs ----

describe("fork client removeTeams / install (temp dirs)", () => {
  let root: string;
  let teamsDir: string;
  let libraryDir: string;
  let live: AdminGameEntry[];
  let reloads: number;
  let reloadOk: boolean;
  const client = () => createLeagueForkClient({
    forkConfig: () => ({ teamsDir } as never), adminCfg: { baseUrl: "http://127.0.0.1:9", passwordMd5Hex: "0" }, stateDir: join(root, "state"), libraryDir,
    io: {
      liveGames: async () => live,
      reload: async () => { reloads += 1; return reloadOk ? { reloaded: true } : { reloaded: false, reason: "refresh refused" }; },
      schedule: async () => ({ kind: "scheduled", gameId: "g1" }),
    },
  });
  const teamFile = (coach: string, id: string) => join(teamsDir, `team_${coach}_${id}.xml`);
  const install = (coach: string, id: string) => {
    writeFileSync(teamFile(coach, id), `<team id="${id}"><coach>${coach}</coach></team>`);
    upsertLibraryTeam(libraryDir, coach, { teamId: id, teamName: id, race: "Human", coach, teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-10-30T00:00:00.000Z" });
  };
  const teamFiles = () => readdirSync(teamsDir).filter((f) => f.startsWith("team_"));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fork-client-cleanup-"));
    teamsDir = join(root, "ffb", "teams");
    libraryDir = join(root, "library");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(join(root, "ffb", "rosters"), { recursive: true });
    live = [];
    reloads = 0;
    reloadOk = true;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("deletes the files and every library row, reloads, and touches nothing else", async () => {
    install("Ann", HID);
    install("Bob", AID);
    install("Bob", "1234567"); // a coach's own team (not a league copy)
    upsertLibraryTeam(libraryDir, "OldSeat", { teamId: HID, teamName: HID, race: "Human", coach: "OldSeat", teamValue: 1, gold: 0, forkLoadable: true, ingestedAt: "x" });
    const c = client();
    expect(c.teamCopies!([HID, AID, "1234567"])).toEqual(new Map([[HID, { files: 1, libraries: 2 }], [AID, { files: 1, libraries: 1 }]]));
    expect(await c.removeTeams!([{ forkTeamId: HID, coach: "Ann" }, { forkTeamId: AID, coach: "Bob" }, { forkTeamId: "1234567", coach: "Bob" }])).toEqual({ removed: [HID, AID].sort() });
    expect(teamFiles()).toEqual(["team_Bob_1234567.xml"]);
    expect(readLibrary(libraryDir, "Ann")).toEqual([]);
    expect(readLibrary(libraryDir, "oldseat")).toEqual([]);
    expect(readLibrary(libraryDir, "Bob").map((t) => t.teamId)).toEqual(["1234567"]);
    expect(reloads).toBe(1);
    // No locks left behind.
    expect(existsSync(join(teamsDir, ".global-team-name.lock"))).toBe(false);
  });

  it("refuses while a team is in a live or scheduled game, or the list cannot be confirmed; nothing changes", async () => {
    install("Ann", HID);
    live = [{ gameId: "9", status: "scheduled", homeTeamId: HID, awayTeamId: "other" } as AdminGameEntry];
    await expect(client().removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).rejects.toThrow(/is in a game/);
    const broken = createLeagueForkClient({
      forkConfig: () => ({ teamsDir } as never), adminCfg: { baseUrl: "http://127.0.0.1:9", passwordMd5Hex: "0" }, stateDir: join(root, "state"), libraryDir,
      io: { liveGames: async () => { throw new Error("no answer"); }, reload: async () => ({ reloaded: true }) },
    });
    await expect(broken.removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).rejects.toThrow(/live games could not be checked/);
    expect(teamFiles()).toEqual([`team_Ann_${HID}.xml`]);
    expect(readLibrary(libraryDir, "Ann")).toHaveLength(1);
    expect(reloads).toBe(0);
  });

  it("a failure at the library step leaves a targeted reload-required marker: only that team is refused, a retry finishes", async () => {
    install("Ann", HID);
    install("Bob", AID);
    // The library is locked by another writer: the row update throws before any file is touched.
    const held = acquireFileWriteLock(libraryWriteLockPath(libraryDir, "Ann"))!;
    await expect(client().removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).rejects.toThrow(/library update is in progress/);
    held.release();
    expect(teamFiles().sort()).toEqual([`team_Ann_${HID}.xml`, `team_Bob_${AID}.xml`].sort());
    expect(readLibrary(libraryDir, "Ann")).toHaveLength(1);
    expect(reloads).toBe(0);
    expect(removalPending(teamsDir, HID)).toBe(true);
    expect(removalPending(teamsDir, AID)).toBe(false);
    // Scheduling with that team (no fresh install) is refused; the site-wide gate is untouched, so other teams still play.
    await expect(client().prepareGame({ install: [], home: HID, away: AID })).rejects.toThrow(/being removed/);
    expect(existsSync(join(teamsDir, ".fork-cache-reload-required.json"))).toBe(false);
    const other = forkTeamIdFor("tabbl", "season-7", "third");
    expect(await client().prepareGame({ install: [], home: AID, away: other })).toEqual({ kind: "scheduled", gameId: "g1" });
    expect(client().teamCopies!([HID]).get(HID)).toEqual({ files: 1, libraries: 1, pendingReload: true });
    // The fixture flow over the real client: the marker is still pending, a fresh process resumes it.
    const dir = join(root, "leagues");
    let store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"], playOnFork: true });
    const file = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: season([]).teams[0]!, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    const f = fx("f1", { home: { ...fx("f1").home, score: 1, cas: 0 }, away: { ...fx("f1").away, score: 0, cas: 0 } });
    f.fork = {
      status: "finished", gameId: "g1", log: [], teams: { home: { teamId: "grudge", forkTeamId: file.forkTeamId, coach: "Ann", builtAt: "x", players: [] } },
      result: { gameId: "g1", source: "basic", appliedAt: "x" } as never,
      cleanup: { state: "pending", reason: "the game is over and its result is banked", since: "x", attempts: 0 },
    };
    store.putSeason(season([f]));
    store = new LeagueStore(dir);
    const out = await runForkTeamCleanup({ store, fork: client(), log: () => undefined });
    expect(out.removed).toEqual(["tabbl/season-7/f1"]);
    expect(readLibrary(libraryDir, "Ann")).toEqual([]);
    expect(teamFiles()).toEqual([`team_Bob_${AID}.xml`]);
    expect(reloads).toBe(1);
    expect(removalPending(teamsDir, HID)).toBe(false);
  });

  it("a fresh install of a team with an unfinished removal goes ahead and clears the marker", async () => {
    install("Ann", HID);
    reloadOk = false;
    await expect(client().removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).rejects.toThrow("refresh refused");
    reloadOk = true;
    const file = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: season([]).teams[0]!, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    expect(await client().prepareGame({ install: [{ coach: "Ann", file }], home: HID, away: AID })).toEqual({ kind: "scheduled", gameId: "g1" });
    expect(removalPending(teamsDir, HID)).toBe(false);
    expect(teamFiles()).toHaveLength(1);
    expect(readLibrary(libraryDir, "Ann").map((t) => t.teamId)).toEqual([HID]);
  });

  it("a refused reload fails the removal (retried later); the re-run reloads even though the files are gone", async () => {
    install("Ann", HID);
    reloadOk = false;
    await expect(client().removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).rejects.toThrow("refresh refused");
    expect(teamFiles()).toEqual([]);
    expect(readLibrary(libraryDir, "Ann")).toEqual([]);
    // Disk and cache disagree for this team only: it is refused until a reload succeeds.
    expect(removalPending(teamsDir, HID)).toBe(true);
    await expect(client().prepareGame({ install: [], home: HID, away: AID })).rejects.toThrow(/being removed/);
    expect(client().teamCopies!([HID]).get(HID)).toEqual({ files: 0, libraries: 0, pendingReload: true });
    reloadOk = true;
    expect(await client().removeTeams!([{ forkTeamId: HID, coach: "Ann" }])).toEqual({ removed: [HID] });
    expect(reloads).toBe(2);
    expect(removalPending(teamsDir, HID)).toBe(false);
    expect(client().teamCopies!([HID]).get(HID)).toEqual({ files: 0, libraries: 0 });
  });

  it("a rebuild after the seat changed coach leaves the team in one library only (no orphan row)", async () => {
    const s = season([]);
    const first = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: s.teams[0]!, coach: "Ann", rosters: ROSTERS, ruleset: "BB2025" });
    const c = client();
    expect(await c.prepareGame({ install: [{ coach: "Ann", file: first }], home: first.forkTeamId, away: AID })).toEqual({ kind: "scheduled", gameId: "g1" });
    const again = buildLeagueForkTeam({ leagueId: "tabbl", seasonId: "season-7", team: { ...s.teams[0]!, coach: "Cid", coachId: "Cid" }, coach: "Cid", rosters: ROSTERS, ruleset: "BB2025" });
    await c.prepareGame({ install: [{ coach: "Cid", file: again }], home: again.forkTeamId, away: AID });
    expect(teamFiles()).toHaveLength(1);
    expect(readLibrary(libraryDir, "Ann")).toEqual([]);
    expect(readLibrary(libraryDir, "Cid").map((t) => t.teamId)).toEqual([HID]);
    expect(c.teamCopies!([HID]).get(HID)).toEqual({ files: 1, libraries: 1 });
  });
});
