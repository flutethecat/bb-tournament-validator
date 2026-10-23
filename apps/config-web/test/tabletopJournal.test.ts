import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoverTabletop, tabletopApi, type FixtureGateway, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
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
// injection points
let failChain: ((coach: string) => boolean) | undefined;
let failRecord = false;
let failResultPut = false;
let putOrder: string[] = [];
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
      ...(m.result?.opId ? { resultOpId: m.result.opId } : {}),
    };
  },
  record: (id, input, at) => {
    if (failRecord) throw new Error("tournament store down");
    tstore.recordResult(id, input, at);
  },
  retract: (id, input, at) => { tstore.retractResult(id, { expectedRevision: input.expectedRevision, status: input.status as never }, at); },
});

const deps = (): TabletopApiDeps => {
  const flaky = Object.create(repo) as FileTabletopRepository;
  flaky.putChain = async (chain) => {
    if (failChain?.(chain.coach)) throw new Error("disk full");
    return repo.putChain(chain);
  };
  const res = Object.create(results) as TournamentResultStore;
  res.put = (row: StoredTournamentResult) => {
    if (failResultPut) throw new Error("results down");
    putOrder.push(row.gameId);
    return results.put(row);
  };
  return {
    repo: flaky, results: res, fixtures: gateway(),
    loadTeamFile: (coach, saveId) => files[`${coach}/${saveId}`],
    isBanned: () => false,
    isOrganizer: (c) => c === "Org",
    now: () => NOW,
  };
};
const as = async (coach: string | undefined, method: string, path: string, body?: unknown): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return (await tabletopApi(method, p!, coach ? { coach, method: "discord" } : undefined, body, deps(), new URLSearchParams(q ?? "")))!;
};
let eid = 0;
const E = (type: string, team: string, player?: string) => {
  eid += 1;
  return { id: `evt-${String(eid).padStart(8, "0")}`, type, team, player, payload: {} };
};
const saveOf = (c: string) => `sv_${c.slice(0, 1).toLowerCase()}`;

/** A submitted match between two coaches (home scores a touchdown). */
async function submitted(home: string, away: string, fixtureRef?: string): Promise<string> {
  const created = await as("Org", "POST", "/api/tabletop/matches", {
    pregame: "skip", home: { coach: home, teamSaveId: saveOf(home) }, away: { coach: away, teamSaveId: saveOf(away) }, postMatch: "spp-only", fixtureRef,
  });
  expect(created.status).toBe(201);
  const id = (created.body as { match: { id: string } }).match.id;
  await as("Org", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("touchdown", "home", `${home.slice(0, 1).toLowerCase()}1`)] });
  await as("Org", "POST", `/api/tabletop/matches/${id}/submit`);
  return id;
}
const confirm = (id: string) => as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
const publish = (id: string) => as("Org", "POST", `/api/tabletop/matches/${id}/publish`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-journal-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  tstore = new TournamentStore(join(dir, "tournaments"));
  failChain = undefined; failRecord = false; failResultPut = false; putOrder = [];
  for (const c of ["Alice", "Bob", "Carol", "Dave"]) files[`${c}/${saveOf(c)}`] = mkTeam(`${c} XI`, c.slice(0, 1).toLowerCase());
  const t = tstore.createTournament({ name: "Cup", packageName: "Rules", maxPlayers: 2, format: "swiss", organizerCoachId: "Org" }, NOW);
  for (const name of ["Alice", "Bob"])
    tstore.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name.toLowerCase()}`, NOW);
  const snap = tstore.snapshot();
  snap.tournaments[t.id]!.status = "active";
  tstore.writeSnapshot(snap);
  fixtureId = tstore.generateNextRound(t.id, NOW).scheduledMatchIds[0]!;
  fixtureHome = tstore.match(fixtureId)!.home.coach.ffbCoachId;
  fixtureAway = tstore.match(fixtureId)!.away!.coach.ffbCoachId;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("journal: team chains are never overwritten", () => {
  it("a stuck confirm retried after another writer moved the chain is a 409 conflict; their revision survives", async () => {
    const id = await submitted("Alice", "Bob");
    failChain = (coach) => coach === "Bob";
    expect((await confirm(id)).status).toBe(500); // Alice written, Bob not
    failChain = undefined;
    // "match B" lands on Bob's team meanwhile
    const bob = (await repo.getChain("Bob", "sv_b"))!;
    const theirs = { ...bob, head: 1, revisions: [...bob.revisions, { saveId: "sv_b", revision: 1, parent: 0, teamFile: mkTeam("Bob after B", "b"), matchId: "tm_other", createdAt: NOW.toISOString() }] };
    await repo.putChain(theirs);

    const retry = await confirm(id);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ conflict: true });
    expect(String((retry.body as { error: string }).error)).toMatch(/Bob's team changed/);
    expect(await repo.getChain("Bob", "sv_b")).toEqual(theirs); // untouched
    expect((await repo.getMatch(id))!.state).toBe("submitted");
    expect((await repo.getJournal(id))!.state).toBe("conflict");
    expect((await confirm(id)).status).toBe(409); // stays conflicted, still never overwrites
    expect(await repo.getChain("Bob", "sv_b")).toEqual(theirs);

    // an organiser can discard the conflicted commit; participants cannot
    expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/resolve-conflict`)).status).toBe(403);
    expect((await as("Org", "POST", `/api/tabletop/matches/${id}/resolve-conflict`)).status).toBe(200);
    expect(await repo.getJournal(id)).toBeUndefined();
  });

  it("publication does not write team chains at all", async () => {
    const id = await submitted("Alice", "Bob");
    expect((await confirm(id)).status).toBe(200);
    const alice = (await repo.getChain("Alice", "sv_a"))!;
    const moved = { ...alice, head: 2, revisions: [...alice.revisions, { saveId: "sv_a", revision: 2, parent: 1, teamFile: mkTeam("Alice later", "a"), matchId: "tm_later", createdAt: NOW.toISOString() }] };
    await repo.putChain(moved);
    expect((await publish(id)).status).toBe(200);
    expect(await repo.getChain("Alice", "sv_a")).toEqual(moved);
    expect((await repo.getJournal(id))).toBeUndefined();
  });

  it("an unresolved journal blocks confirm and undo on another match using the team (409 recovery pending)", async () => {
    const a = await submitted("Alice", "Bob");
    expect((await confirm(a)).status).toBe(200);
    failChain = (coach) => coach === "Bob";
    expect((await as("Org", "POST", `/api/tabletop/matches/${a}/undo-revision`)).status).toBe(500); // stuck undo journal
    failChain = undefined;
    const b = await submitted("Alice", "Bob"); // A is confirmed, so the teams are free to play again
    const blocked = await confirm(b);
    expect(blocked.status).toBe(409);
    expect(String((blocked.body as { error: string }).error)).toMatch(/Recovery pending/);
    // finishing A's undo (a retry) lifts the block
    expect((await as("Org", "POST", `/api/tabletop/matches/${a}/undo-revision`)).status).toBe(200);
    expect((await repo.getMatch(a))!.state).toBe("recording");
  });
});

describe("journal: fixture replay recognises only its own write", () => {
  it("success is recognised by the op id: a stuck publish whose fixture write landed completes on retry", async () => {
    const id = await submitted(fixtureHome, fixtureAway, fixtureId);
    await confirm(id);
    failResultPut = true;
    expect((await publish(id)).status).toBe(500); // fixture recorded, results row not yet published
    failResultPut = false;
    const stamped = tstore.match(fixtureId)!;
    expect(stamped.status).toBe("completed");
    expect(stamped.result!.opId).toBeDefined();
    expect((await publish(id)).status).toBe(200);
    expect((await repo.getMatch(id))).toMatchObject({ state: "published", fixtureLink: { opId: stamped.result!.opId } });
    expect(results.list()).toHaveLength(1);
    expect(tstore.match(fixtureId)!.revision).toBe(stamped.revision); // not recorded twice
  });

  it("a higher fixture revision with a result that is NOT ours is a conflict: not published, no fixtureLink", async () => {
    const id = await submitted(fixtureHome, fixtureAway, fixtureId);
    await confirm(id);
    failRecord = true;
    expect((await publish(id)).status).toBe(500); // journal exists, fixture untouched
    failRecord = false;
    tstore.recordResult(fixtureId, { expectedRevision: 1, homeScore: 5, awayScore: 5 }, NOW); // someone else resolves it
    const retry = await publish(id);
    expect(retry.status).toBe(409);
    expect(retry.body).toMatchObject({ conflict: true });
    expect(results.list()).toHaveLength(0); // the tabletop row is NOT published
    const m = (await repo.getMatch(id))!;
    expect(m.state).toBe("confirmed");
    expect(m.fixtureLink).toBeUndefined();
    expect(tstore.match(fixtureId)!.result).toMatchObject({ homeScore: 5, awayScore: 5 }); // theirs, untouched
    expect((await repo.getJournal(id))!.state).toBe("conflict");
  });

  it("an own-op result later altered by someone else is a conflict too", async () => {
    const id = await submitted(fixtureHome, fixtureAway, fixtureId);
    await confirm(id);
    failResultPut = true;
    await publish(id);
    failResultPut = false;
    const snap = tstore.snapshot();
    snap.scheduledMatches[fixtureId]!.result!.opId = "someone-else";
    snap.scheduledMatches[fixtureId]!.revision += 1;
    tstore.writeSnapshot(snap);
    expect((await publish(id)).status).toBe(409);
    expect(results.list()).toHaveLength(0);
  });
});

describe("journal: startup replay", () => {
  it("replays in the recorded sequence (not id order) and skips conflicts", async () => {
    // two independent matches, stuck in this order: Carol/Dave first, then Alice/Bob
    const first = await submitted("Carol", "Dave");
    const second = await submitted("Alice", "Bob");
    failChain = () => true;
    expect((await confirm(first)).status).toBe(500);
    expect((await confirm(second)).status).toBe(500);
    failChain = undefined;
    expect((await repo.getJournal(first))!.seq!).toBeLessThan((await repo.getJournal(second))!.seq!);
    putOrder = [];
    const done = await recoverTabletop(deps());
    expect(done).toEqual([first, second]);
    expect(putOrder).toEqual([`tabletop-${first}`, `tabletop-${second}`]);
    expect((await repo.getMatch(first))!.state).toBe("confirmed");
    expect(await repo.listJournalMatchIds()).toEqual([]);
  });

  it("skips a conflicted journal and leaves it in place", async () => {
    const id = await submitted("Alice", "Bob");
    failChain = (coach) => coach === "Bob";
    await confirm(id);
    failChain = undefined;
    const j = (await repo.getJournal(id))!;
    await repo.putJournal({ ...j, state: "conflict", conflict: "test" });
    expect(await recoverTabletop(deps())).toEqual([]);
    expect((await repo.getJournal(id))!.state).toBe("conflict");
    expect((await repo.getMatch(id))!.state).toBe("submitted");
  });
});

describe("public standings", () => {
  it("GET /api/standings needs no session; every write stays gated", async () => {
    const anon = await as(undefined, "GET", "/api/standings?league=Rules");
    expect(anon.status).toBe(200);
    expect(anon.body).toEqual({ league: "Rules", rows: [] });
    expect((await as(undefined, "GET", "/api/standings")).status).toBe(400);
    expect((await as(undefined, "POST", "/api/standings?league=Rules")).status).toBe(405);
    expect((await as(undefined, "POST", "/api/tabletop/matches", {})).status).toBe(401);
    expect((await as(undefined, "GET", "/api/tabletop/matches")).status).toBe(401);
  });
});
