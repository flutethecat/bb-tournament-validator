import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeElo } from "../src/coachElo.js";
import { recoverTabletop, tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import { duplicatePlayerId, teamFileFromSave } from "../src/tabletop/teamFile.js";
import type { TeamBuilderSave } from "../src/teamBuilderSaves.js";
import { FileTabletopRepository, headRevision } from "../src/tabletop/store.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { TournamentResultStore, aggregateStandings } from "../src/tournamentResults.js";

let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
const organisers = new Set<string>(["Org"]);
const banned = new Set<string>();
const files: Record<string, TabletopTeamFile> = {};
let failRepo: FileTabletopRepository | undefined;
let failResults: TournamentResultStore | undefined;

const mkTeam = (name: string, prefix: string): TabletopTeamFile => ({
  schema: 1, name, treasury: 50_000, dedicatedFans: 2,
  players: ["1", "2", "3"].map((i) => ({ id: `${prefix}${i}`, name: `${prefix} ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false })),
});

const deps = (): TabletopApiDeps => ({
  repo: failRepo ?? repo, results: failResults ?? results,
  loadTeamFile: (coach, saveId) => files[`${coach}/${saveId}`],
  isBanned: (c) => banned.has(c),
  isOrganizer: (c) => organisers.has(c),
  listSaves: (c) => (c === "Alice" ? [{ id: "sv_a", name: "Alice XI" }] : []),
  now: () => new Date("2026-02-01T10:00:00.000Z"),
});
const as = (coach: string, method: string, path: string, body?: unknown, authMethod = "discord"): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return tabletopApi(method, p!, { coach, method: authMethod }, body, deps(), new URLSearchParams(q ?? "")) as Promise<TabletopResult>;
};

let eid = 0;
const E = (type: string, team: string, player?: string, payload: Record<string, unknown> = {}) => {
  eid += 1;
  return { id: `evt-${String(eid).padStart(8, "0")}`, type, team, player, payload };
};
async function newMatch(postMatch = "full", fixtureRef?: string): Promise<string> {
  const r = await as("Alice", "POST", "/api/tabletop/matches", {
    home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" }, postMatch, fixtureRef,
  });
  expect(r.status).toBe(201);
  return (r.body as { match: { id: string } }).match.id;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  banned.clear();
  failRepo = undefined;
  failResults = undefined;
  files["Alice/sv_a"] = mkTeam("Alice XI", "a");
  files["Bob/sv_b"] = mkTeam("Bob XI", "b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tabletop API: auth", () => {
  it("401 anonymous, 403 for a non-Discord session, 403 banned", async () => {
    expect((await tabletopApi("POST", "/api/tabletop/matches", undefined, {}, deps()))!.status).toBe(401);
    expect((await as("Alice", "POST", "/api/tabletop/matches", {}, "password")).status).toBe(403);
    banned.add("Alice");
    expect((await as("Alice", "POST", "/api/tabletop/matches", {})).status).toBe(403);
  });
  it("403 for a non-participant on every route; an organiser is allowed", async () => {
    const id = await newMatch();
    for (const [m, p] of [["GET", ""], ["POST", "/events"], ["POST", "/submit"], ["POST", "/confirm"]] as const)
      expect((await as("Mallory", m, `/api/tabletop/matches/${id}${p}`, { events: [E("touchdown", "home", "a1")] })).status).toBe(403);
    expect((await as("Mallory", "POST", "/api/tabletop/matches", {
      home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" },
    })).status).toBe(403);
    expect((await as("Org", "GET", `/api/tabletop/matches/${id}`)).status).toBe(200);
    expect((await as("Mallory", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(403);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(403);
  });
  it("create validates sides, own saves and one open match per team", async () => {
    expect((await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", teamSaveId: "sv_a" } })).status).toBe(400);
    expect((await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Alice", teamSaveId: "sv_a" } })).status).toBe(400);
    expect((await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_nope" } })).status).toBe(404);
    await newMatch();
    expect((await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" } })).status).toBe(409);
  });
});

describe("tabletop API: events", () => {
  it("is idempotent by event id and rejects invalid events atomically", async () => {
    const id = await newMatch();
    const td = E("touchdown", "home", "a1");
    const first = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [td] });
    expect(first.body).toMatchObject({ accepted: [td.id], duplicates: [], total: 1 });
    const again = await as("Bob", "POST", `/api/tabletop/matches/${id}/events`, { events: [td, E("completion", "away", "b1")] });
    expect(again.body).toMatchObject({ duplicates: [td.id], total: 2 });
    const bad = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a2"), E("touchdown", "home", "ghost")] });
    expect(bad.status).toBe(400);
    const got = (await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ id: string; by: string }> };
    expect(got.events).toHaveLength(2); // the valid first event of the bad batch was NOT stored
    expect(got.events.map((e) => e.by)).toEqual(["Alice", "Bob"]);
  });
  it("409 once the match is no longer recording", async () => {
    const id = await newMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1")] })).status).toBe(409);
  });
});

describe("tabletop API: submit / confirm / undo-revision", () => {
  async function playedMatch(postMatch = "full", fixtureRef?: string): Promise<string> {
    const id = await newMatch(postMatch, fixtureRef);
    const r = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, {
      events: [
        E("touchdown", "home", "a1"), E("touchdown", "home", "a2"), E("touchdown", "away", "b1"),
        E("casualty", "home", "a1", { victim: "b2", result: "DEAD" }),
        E("mvp", "home", "a3"),
      ],
    });
    expect(r.status).toBe(200);
    return id;
  }

  it("submit previews both teams; confirm needs both coaches; then revisions + a tabletop results row are written", async () => {
    const id = await playedMatch("full");
    const sub = (await as("Bob", "POST", `/api/tabletop/matches/${id}/submit`)).body as { match: { state: string; preview: { home: { winnings: number }; away: { deaths: string[] } } } };
    expect(sub.match.state).toBe("submitted");
    expect(sub.match.preview.home.winnings).toBe(20_000);
    expect(sub.match.preview.away.deaths).toEqual(["b2"]);

    const c1 = (await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).body as { match: { state: string } };
    expect(c1.match.state).toBe("submitted");
    expect(results.listAll()).toHaveLength(0);
    const c2 = (await as("Bob", "POST", `/api/tabletop/matches/${id}/confirm`)).body as { match: { state: string; resultGameId: string; wroteRevisions: object } };
    expect(c2.match).toMatchObject({ state: "confirmed", wroteRevisions: { home: 1, away: 1 } });

    const chain = (await repo.getChain("Alice", "sv_a"))!;
    expect(chain.head).toBe(1);
    expect(chain.revisions.map((r) => [r.revision, r.parent])).toEqual([[0, null], [1, 0]]);
    expect(headRevision(chain).teamFile).toMatchObject({ treasury: 70_000, lastMatchId: id });
    expect(headRevision(chain).teamFile.players.find((p) => p.id === "a1")!.spp).toBe(3 + 2);
    expect(chain.revisions[0]!.teamFile.treasury).toBe(50_000);
    expect((await repo.getChain("Bob", "sv_b"))!.revisions[1]!.teamFile.players.find((p) => p.id === "b2")!.dead).toBe(true);

    const rows = results.listAll();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ gameId: `tabletop-${id}`, source: "tabletop", home: { coach: "Alice" }, away: { coach: "Bob" } });
    expect(rows[0]!.teams.map((t) => t.score)).toEqual([2, 1]);
    // the same pipeline reads it: standings and Elo
    const standings = aggregateStandings(rows, () => undefined);
    expect(standings.find((s) => s.coach === "Alice")).toMatchObject({ won: 1, tdFor: 2, tdAgainst: 1, casFor: 1 });
    expect(computeElo(rows).get("alice")!.rating).toBeGreaterThan(1500);
  });

  it("an organiser confirms for both coaches", async () => {
    const id = await playedMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    const r = (await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).body as { match: { state: string } };
    expect(r.match.state).toBe("confirmed");
    expect(results.listAll()).toHaveLength(1);
  });

  it("postMatch none writes the results row but no team revisions", async () => {
    const id = await playedMatch("none");
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    expect((await repo.getChain("Alice", "sv_a"))!.head).toBe(0);
    expect(results.listAll()).toHaveLength(1);
  });

  it("confirm before submit is a 409", async () => {
    const id = await playedMatch();
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(409);
  });

  it("undo-revision (organiser) reverts both teams, retracts the row, reopens; a re-confirm chains from the parent", async () => {
    const id = await playedMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    const undone = (await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).body as { match: { state: string; confirmations: object } };
    expect(undone.match).toMatchObject({ state: "recording", confirmations: {} });
    const chain = (await repo.getChain("Alice", "sv_a"))!;
    expect(chain.head).toBe(0);
    expect(chain.revisions).toHaveLength(2); // history kept
    expect(headRevision(chain).teamFile.treasury).toBe(50_000);
    expect((await repo.getChain("Bob", "sv_b"))!.head).toBe(0);
    expect(results.listAll()).toHaveLength(0);
    // fix a mistake by an undo event, then confirm again
    const evs = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ id: string; type: string }> }).events;
    const tdB = evs.filter((e) => e.type === "touchdown")[2]!;
    await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("undo", "away", undefined, { target: tdB.id })] });
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    const chain2 = (await repo.getChain("Alice", "sv_a"))!;
    expect(chain2.revisions.map((r) => [r.revision, r.parent])).toEqual([[0, null], [1, 0], [2, 0]]);
    expect(chain2.head).toBe(2);
    expect(results.listAll()[0]!.teams.map((t) => t.score)).toEqual([2, 0]);
  });

  it("undo-revision refuses while the match is not confirmed", async () => {
    const id = await playedMatch();
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(409);
  });
});

describe("tabletop: baseline team file ids", () => {
  const save = (picks: unknown[]) => ({ name: "T", rosterId: "orc", body: { picks } }) as unknown as TeamBuilderSave;
  it("two picks of one position get unique ids across the roster", () => {
    const file = teamFileFromSave(save([{ positionId: "B", count: 2 }, { positionId: "L", count: 1 }, { positionId: "B", count: 2, chosenSkills: ["Block"] }]));
    expect(file.players.map((p) => p.id)).toEqual(["B-1", "B-2", "L-1", "B-3", "B-4"]);
    expect(duplicatePlayerId(file)).toBeUndefined();
  });
  it("a baseline with a duplicate id is refused before it is persisted", async () => {
    const bad = mkTeam("Dup", "a");
    bad.players[1]!.id = bad.players[0]!.id;
    files["Alice/sv_a"] = bad;
    const r = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", teamSaveId: "sv_a" }, away: { coach: "Bob", teamSaveId: "sv_b" } });
    expect(r.status).toBe(422);
    expect(await repo.getChain("Alice", "sv_a")).toBeUndefined();
  });
});

describe("tabletop: commit journal", () => {
  async function submitted(): Promise<string> {
    const id = await newMatch();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", "a1"), E("casualty", "home", "a2", { victim: "b1", result: "MNG" })] });
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    return id;
  }
  const flakyRepo = (failOnce: (coach: string) => boolean): FileTabletopRepository => {
    const flaky = Object.create(repo) as FileTabletopRepository;
    let armed = true;
    flaky.putChain = async (chain) => {
      if (armed && failOnce(chain.coach)) { armed = false; throw new Error("disk full"); }
      return repo.putChain(chain);
    };
    return flaky;
  };

  it("a failed away write leaves a journal; retry completes the commit (200, not 409)", async () => {
    const id = await submitted();
    failRepo = flakyRepo((coach) => coach === "Bob");
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(500);
    expect((await repo.getChain("Alice", "sv_a"))!.head).toBe(1); // home landed
    expect((await repo.getChain("Bob", "sv_b"))!.head).toBe(0); // away did not
    expect((await repo.getMatch(id))!.state).toBe("submitted");
    expect(await repo.getJournal(id)).toBeDefined();
    const retry = await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    expect(retry.status).toBe(200);
    expect((await repo.getChain("Bob", "sv_b"))!.head).toBe(1);
    expect((await repo.getMatch(id))!.state).toBe("confirmed");
    expect(results.listAll()).toHaveLength(1);
    expect(await repo.getJournal(id)).toBeUndefined();
    expect((await repo.getChain("Alice", "sv_a"))!.revisions).toHaveLength(2); // not applied twice
  });

  it("a failed results write is completed by replay", async () => {
    const id = await submitted();
    failResults = Object.create(results) as TournamentResultStore;
    let armed = true;
    failResults.put = (row) => { if (armed) { armed = false; throw new Error("results down"); } return results.put(row); };
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(500);
    expect(results.listAll()).toHaveLength(0);
    expect((await repo.getMatch(id))!.state).toBe("submitted");
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(200);
    expect(results.listAll()).toHaveLength(1);
    expect((await repo.getMatch(id))!.state).toBe("confirmed");
  });

  it("startup recovery replays an unfinished journal", async () => {
    const id = await submitted();
    failRepo = flakyRepo((coach) => coach === "Bob");
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    expect(await recoverTabletop(deps())).toEqual([id]);
    expect((await repo.getMatch(id))!.state).toBe("confirmed");
    expect((await repo.getChain("Bob", "sv_b"))!.head).toBe(1);
    expect(await recoverTabletop(deps())).toEqual([]);
  });

  it("a failed undo also completes on retry", async () => {
    const id = await submitted();
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    failRepo = flakyRepo((coach) => coach === "Bob");
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(500);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/undo-revision`)).status).toBe(200);
    expect((await repo.getChain("Bob", "sv_b"))!.head).toBe(0);
    expect((await repo.getMatch(id))!.state).toBe("recording");
    expect(results.listAll()).toHaveLength(0);
  });

  it("a participant banned after submit blocks the final confirm (403); the match stays submitted", async () => {
    const id = await submitted();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/confirm`);
    banned.add("Bob");
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`)).status).toBe(403);
    expect((await repo.getMatch(id))!.state).toBe("submitted");
    expect(results.listAll()).toHaveLength(0);
    expect((await repo.getChain("Alice", "sv_a"))!.head).toBe(0);
  });
});

describe("tabletop: list, saves, tally", () => {
  it("lists the caller's matches newest first (minimal fields); an organiser sees all", async () => {
    files["Carol/sv_c"] = mkTeam("Carol XI", "c");
    files["Dave/sv_d"] = mkTeam("Dave XI", "d");
    const first = await newMatch();
    let tick = 0;
    const later = tabletopApi("POST", "/api/tabletop/matches", { coach: "Carol", method: "discord" }, {
      home: { coach: "Carol", teamSaveId: "sv_c" }, away: { coach: "Dave", teamSaveId: "sv_d" },
    }, { ...deps(), now: () => new Date(Date.UTC(2026, 2, 1, 0, 0, ++tick)) });
    const secondId = ((await later)!.body as { match: { id: string } }).match.id;
    const mine = (await as("Alice", "GET", "/api/tabletop/matches")).body as { matches: Array<Record<string, any>> };
    expect(mine.matches.map((m) => m.id)).toEqual([first]);
    expect(Object.keys(mine.matches[0]!).sort()).toEqual(["away", "createdAt", "home", "id", "pendingOrganiser", "postMatch", "state", "updatedAt"]);
    expect(mine.matches[0]!.home).toEqual({ coach: "Alice", teamName: "Alice XI" });
    const all = (await as("Org", "GET", "/api/tabletop/matches")).body as { matches: Array<{ id: string }> };
    expect(all.matches.map((m) => m.id)).toEqual([secondId, first]); // newest first
    expect(((await as("Mallory", "GET", "/api/tabletop/matches")).body as { matches: unknown[] }).matches).toEqual([]);
    expect((await tabletopApi("GET", "/api/tabletop/matches", undefined, undefined, deps()))!.status).toBe(401);
  });

  it("saves lookup: ids and names only, session-gated", async () => {
    const r = await as("Bob", "GET", "/api/tabletop/saves?coach=Alice");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ coach: "Alice", saves: [{ id: "sv_a", name: "Alice XI" }] });
    expect((await as("Bob", "GET", "/api/tabletop/saves")).status).toBe(400);
    expect((await as("Bob", "GET", "/api/tabletop/saves?coach=Alice", undefined, "password")).status).toBe(403);
    expect((await tabletopApi("GET", "/api/tabletop/saves", undefined, undefined, deps(), new URLSearchParams("coach=Alice")))!.status).toBe(401);
  });

  it("match GET and events POST carry the server tally", async () => {
    const id = await newMatch();
    const posted = (await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, {
      events: [E("touchdown", "home", "a1"), E("mvp", "home", "a2"), E("casualty", "home", "a1", { victim: "b1", result: "DEAD" })],
    })).body as { tally: any };
    expect(posted.tally.score).toEqual({ home: 1, away: 0 });
    expect(posted.tally.casualtiesSuffered.away).toEqual({ bh: 0, si: 0, rip: 1 });
    const a1 = posted.tally.players.home.find((p: any) => p.id === "a1");
    expect(a1).toMatchObject({ touchdowns: 1, casualtiesCaused: 1, sppEarned: 5 });
    expect(posted.tally.players.home.find((p: any) => p.id === "a2").sppEarned).toBe(4);
    const got = (await as("Bob", "GET", `/api/tabletop/matches/${id}`)).body as { tally: any };
    expect(got.tally).toEqual(posted.tally);
  });
});
