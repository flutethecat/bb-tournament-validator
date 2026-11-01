import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GamestatePlayerResult } from "@bb/fork-ops";
import { tournamentApi, type TournamentApiDeps, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { computeSeriesStandings } from "../src/tournaments/series.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { gameDetail } from "../src/gameDetail.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { onboardingGateApplies } from "../src/auth/onboarding.js";
import type { TournamentNotify } from "../src/notifications.js";
import type { StoredTournamentResult } from "../src/tournamentResults.js";
import type {
  ScheduledMatchRecord, TournamentDataFileV4, TournamentEntrantRecord, TournamentRecord, TournamentRoundRecord, TournamentSeriesRecord,
} from "../src/tournaments/types.js";

// Organiser edits of confirmed tournament results (owner ruling 10-29 §7: organisers may edit a result after both
// coaches confirmed it; the edit is stamped admin and shows in the activity feed). Fake coaches and teams only.

const roots: string[] = [];
const at = "2026-10-20T12:00:00.000Z";
const now = new Date("2026-11-01T12:00:00.000Z");
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

// Roles: Veers owns t1, Piett is a listed organiser of t1 only (no global organiser flag), Ozzel is a global organiser
// who does not run t1, Root is a site admin; Ann / Bob / Cy / Di play.
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
const piett: TournamentApiIdentity = { coach: "Piett", organizer: false, admin: false };
const ozzel: TournamentApiIdentity = { coach: "Ozzel", organizer: true, admin: false };
const admin: TournamentApiIdentity = { coach: "Root", organizer: true, admin: true };
const ann: TournamentApiIdentity = { coach: "Ann", organizer: false, admin: false };
const cy: TournamentApiIdentity = { coach: "Cy", organizer: false, admin: false };
const COACHES = ["Ann", "Bob", "Cy", "Di"];
const TEAMS: Record<string, { teamName: string; race: string }> = {
  "team-ann": { teamName: "Ann's Orcs", race: "Orc" }, "team-bob": { teamName: "Bob's Elves", race: "Wood Elf" },
  "team-cy": { teamName: "Cy's Dwarfs", race: "Dwarf" }, "team-di": { teamName: "Di's Humans", race: "Human" },
};

function tournament(over: Partial<TournamentRecord> = {}): TournamentRecord {
  return {
    id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "Rules", maxPlayers: 8, roundCount: 3, currentRound: 2,
    tiebreakers: ["buchholz"], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "Veers", organizerCoachId: "Veers",
    organizerCoachIds: ["Piett"], startedAt: at, createdAt: at, updatedAt: at, ...over,
  };
}
const entrant = (coach: string, seed: number): TournamentEntrantRecord => ({
  id: `e-${coach.toLowerCase()}`, tournamentId: "t1", seed, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: at },
  teamId: `team-${coach.toLowerCase()}`, registeredAt: at,
});
function match(id: string, round: number, home: string, away: string, result?: { h: number; a: number; hc?: number; ac?: number; opId?: string }, gameId?: string): ScheduledMatchRecord {
  const side = (c: string) => ({ entrantId: `e-${c.toLowerCase()}`, coach: { coachId: c, ffbCoachId: c, verifiedAt: at }, teamId: `team-${c.toLowerCase()}` });
  return {
    id, tournamentId: "t1", roundId: `t1:round:${round}`, roundNumber: round, home: side(home), away: side(away),
    status: result ? "completed" : "scheduled", revision: 3,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0, ...(gameId ? { gameId } : {}) },
    ...(result ? { result: {
      homeScore: result.h, awayScore: result.a,
      ...(result.hc !== undefined ? { homeCasualties: result.hc, awayCasualties: result.ac } : {}),
      reportedAt: at, ...(result.opId ? { opId: result.opId } : {}),
    } } : {}),
    createdAt: at, updatedAt: at,
  };
}
const round = (n: number, status: TournamentRoundRecord["status"], ids: string[]): TournamentRoundRecord => ({
  id: `t1:round:${n}`, tournamentId: "t1", number: n, status, scheduledMatchIds: ids, createdAt: at, ...(status === "completed" ? { completedAt: at } : {}),
});

/** Round 1 played (m1 a fork game, m2 a published tabletop match), round 2 drawn and unplayed. */
const BASE = {
  matches: [
    match("m1", 1, "Ann", "Bob", { h: 2, a: 1 }, "g1"),
    match("m2", 1, "Cy", "Di", { h: 1, a: 1, hc: 0, ac: 2, opId: "op-tt-1" }),
    match("m3", 2, "Ann", "Cy"),
    match("m4", 2, "Bob", "Di"),
  ],
  rounds: [round(1, "completed", ["m1", "m2"]), round(2, "active", ["m3", "m4"])],
};

function setup(data: { t?: Partial<TournamentRecord>; matches: ScheduledMatchRecord[]; rounds: TournamentRoundRecord[]; coaches?: string[]; series?: TournamentSeriesRecord }): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-result-edits-"));
  roots.push(root);
  const store = new TournamentStore(root);
  const coaches = data.coaches ?? COACHES;
  const file: TournamentDataFileV4 = {
    version: 4,
    tournaments: { t1: tournament({ ...data.t, ...(data.series ? { seriesId: data.series.id } : {}) }) },
    entrants: Object.fromEntries(coaches.map((c, i) => [`e-${c.toLowerCase()}`, entrant(c, i + 1)])),
    rounds: Object.fromEntries(data.rounds.map((r) => [r.id, r])),
    standings: {}, waitingPresence: {},
    scheduledMatches: Object.fromEntries(data.matches.map((m) => [m.id, m])),
    ...(data.series ? { series: { [data.series.id]: data.series } } : {}),
  };
  store.writeSnapshot(file);
  return store;
}

function notifier() {
  const sent: Array<{ coach: string; type: string; title: string; body: string; from?: string }> = [];
  const notify: TournamentNotify = {
    coach: (coach, input) => { sent.push({ coach, type: input.type, title: input.title, body: input.body, from: input.from }); },
    managers: vi.fn(),
    entrants: vi.fn(),
  };
  return { sent, notify };
}

function deps(store: TournamentStore, extra: Partial<TournamentApiDeps> = {}): TournamentApiDeps {
  return { store, teamBuild: (id) => TEAMS[id], packageExists: () => true, now: () => now, ...extra };
}
const call = (store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown, extra: Partial<TournamentApiDeps> = {}) =>
  tournamentApi(method, path, new URLSearchParams(), auth, body, deps(store, extra));
const edit = (store: TournamentStore, auth: TournamentApiIdentity | undefined, mid: string, body: Record<string, unknown>, extra: Partial<TournamentApiDeps> = {}) =>
  call(store, "PATCH", `/api/tournaments/t1/fixtures/${mid}/result`, auth, body, extra);
const clear = (store: TournamentStore, auth: TournamentApiIdentity | undefined, mid: string, body: Record<string, unknown>, extra: Partial<TournamentApiDeps> = {}) =>
  call(store, "POST", `/api/tournaments/t1/fixtures/${mid}/result/clear`, auth, body, extra);

describe("who may edit a result", () => {
  it("anonymous 401; a coach who plays it, and a global organiser who does not run the tournament, 403", async () => {
    const store = setup(BASE);
    expect((await edit(store, undefined, "m1", { revision: 3, homeScore: 3, awayScore: 1 }))?.status).toBe(401);
    expect((await edit(store, ann, "m1", { revision: 3, homeScore: 3, awayScore: 1 }))?.status).toBe(403);
    expect((await edit(store, ozzel, "m1", { revision: 3, homeScore: 3, awayScore: 1 }))?.status).toBe(403);
    expect((await clear(store, ozzel, "m1", { revision: 3 }))?.status).toBe(403);
    expect(store.match("m1")?.result?.homeScore).toBe(2);
  });

  it("a listed organiser with no global role, the owner and a site admin may", async () => {
    const store = setup(BASE);
    expect((await edit(store, piett, "m1", { revision: 3, homeScore: 3, awayScore: 1 }))?.status).toBe(200);
    expect((await edit(store, owner, "m1", { revision: 4, homeScore: 3, awayScore: 0 }))?.status).toBe(200);
    expect((await edit(store, admin, "m1", { revision: 5, homeScore: 4, awayScore: 0 }))?.status).toBe(200);
  });

  it("a fixture of another tournament, a bye and an unplayed fixture are refused", async () => {
    const store = setup({ ...BASE, matches: [...BASE.matches, { ...match("m5", 2, "Cy", "Di"), away: undefined, status: "completed", result: { homeScore: 0, awayScore: 0, reportedAt: at } }] });
    expect((await call(store, "PATCH", "/api/tournaments/t9/fixtures/m1/result", owner, { revision: 3, homeScore: 1, awayScore: 0 }))?.status).toBe(404);
    expect((await edit(store, owner, "nope", { revision: 3, homeScore: 1, awayScore: 0 }))?.status).toBe(404);
    expect((await edit(store, owner, "m5", { revision: 3, homeScore: 1, awayScore: 0 }))?.status).toBe(409);
    expect((await edit(store, owner, "m3", { revision: 3, homeScore: 1, awayScore: 0 }))?.status).toBe(409);
    expect((await clear(store, owner, "m3", { revision: 3 }))?.status).toBe(409);
  });

  it("names the fixture revision: missing 428, stale 409, If-Match accepted; bad values 400", async () => {
    const store = setup(BASE);
    expect((await edit(store, owner, "m1", { homeScore: 3, awayScore: 1 }))?.status).toBe(428);
    expect((await edit(store, owner, "m1", { revision: 2, homeScore: 3, awayScore: 1 }))?.status).toBe(409);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: -1, awayScore: 1 }))?.status).toBe(400);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 100, awayScore: 1 }))?.status).toBe(400);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 3, awayScore: 1, homeCasualties: 2 }))?.status).toBe(400);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 2, awayScore: 1 }))?.status).toBe(400); // nothing changed
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 1, awayScore: 1, reason: "x".repeat(501) }))?.status).toBe(400);
    expect((await edit(store, owner, "m1", { homeScore: 3, awayScore: 1 }, { ifMatch: '"3"' }))?.status).toBe(200);
  });
});

describe("request gates", () => {
  it("both routes are state changes: the CSRF header and the onboarding gate (428) cover them; no GET writes", async () => {
    for (const [method, path] of [["PATCH", "/api/tournaments/t1/fixtures/m1/result"], ["POST", "/api/tournaments/t1/fixtures/m1/result/clear"]] as const) {
      expect(isStateChangingApiRequest(method, path)).toBe(true);
      expect(onboardingGateApplies(method, path)).toBe(true);
    }
    const store = setup(BASE);
    expect(await call(store, "GET", "/api/tournaments/t1/fixtures/m1/result", owner)).toBeUndefined();
    expect(await call(store, "GET", "/api/tournaments/t1/fixtures/m1/result/clear", owner)).toBeUndefined();
    expect(await call(store, "POST", "/api/tournaments/t1/fixtures/m1/result", owner, { revision: 3, homeScore: 1, awayScore: 0 })).toBeUndefined();
    expect(store.match("m1")!.revision).toBe(3);
  });
});

describe("edit and clear lifecycle", () => {
  it("an edit stamps who / when / why with the previous and first-reported values, logs an admin entry, keeps the fork link", async () => {
    const store = setup(BASE);
    const res = await edit(store, piett, "m1", { revision: 3, homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0, reason: "  Agreed typo  " });
    expect(res?.status).toBe(200);
    const m1 = store.match("m1")!;
    expect(m1).toMatchObject({ status: "completed", revision: 4, result: { homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0, reportedAt: at } });
    expect(m1.launch.gameId).toBe("g1"); // the source record stays linked
    expect(m1.edited).toEqual({ byCoachId: "Piett", at: now.toISOString(), kind: "result", reason: "Agreed typo", previous: { homeScore: 2, awayScore: 1 }, original: { homeScore: 2, awayScore: 1 } });
    const log = store.tournament("t1")!.activity!;
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ by: "Piett", kind: "result-edited", admin: true, fixtureId: "m1", roundNumber: 1, result: { homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0 }, previous: { homeScore: 2, awayScore: 1 }, reason: "Agreed typo" });
    // a second edit keeps the first-reported values and adds a newer log entry on top
    await edit(store, owner, "m1", { revision: 4, homeScore: 0, awayScore: 1 });
    expect(store.match("m1")!.edited).toMatchObject({ byCoachId: "Veers", previous: { homeScore: 1, awayScore: 1, homeCasualties: 2, awayCasualties: 0 }, original: { homeScore: 2, awayScore: 1 } });
    expect(store.match("m1")!.edited!.reason).toBeUndefined();
    expect(store.tournament("t1")!.activity!.map((e) => e.by)).toEqual(["Veers", "Piett"]);
  });

  it("a tabletop-sourced result keeps its op id, so the recorder's revert refuses until the tournament is resolved", async () => {
    const store = setup(BASE);
    await edit(store, owner, "m2", { revision: 3, homeScore: 2, awayScore: 1, homeCasualties: 0, awayCasualties: 2 });
    expect(store.match("m2")!.result).toMatchObject({ homeScore: 2, opId: "op-tt-1", reportedAt: at });
    expect(store.match("m2")!.revision).toBe(4); // the published link names revision 3 + 1 = 4 only before the edit
  });

  it("clear makes the fixture unplayed again, reopens its round, keeps the link; it cannot be edited until a result is recorded", async () => {
    const store = setup({ ...BASE, rounds: [round(1, "completed", ["m1", "m2"])], matches: BASE.matches.slice(0, 2), t: { currentRound: 1 } });
    const res = await clear(store, owner, "m1", { revision: 3, reason: "Replay ordered" });
    expect(res?.status).toBe(200);
    const m1 = store.match("m1")!;
    expect(m1.result).toBeUndefined();
    expect(m1).toMatchObject({ status: "scheduled", revision: 4, launch: { gameId: "g1" } });
    expect(m1.edited).toMatchObject({ byCoachId: "Veers", kind: "result", cleared: true, reason: "Replay ordered", previous: { homeScore: 2, awayScore: 1 } });
    expect(store.rounds("t1")[0]).toMatchObject({ status: "active" });
    expect(store.rounds("t1")[0]!.completedAt).toBeUndefined();
    expect(store.tournament("t1")!.activity![0]).toMatchObject({ kind: "result-cleared", admin: true, previous: { homeScore: 2, awayScore: 1 } });
    expect(store.tournament("t1")!.activity![0]!.result).toBeUndefined();
    expect((await edit(store, owner, "m1", { revision: 4, homeScore: 1, awayScore: 0 }))?.status).toBe(409);
    // the existing result path records it again; the next edit's original is that new result
    store.recordResult("m1", { expectedRevision: 4, homeScore: 0, awayScore: 0 }, now);
    await edit(store, owner, "m1", { revision: 5, homeScore: 1, awayScore: 0 });
    expect(store.match("m1")!.edited).toMatchObject({ original: { homeScore: 0, awayScore: 0 } });
    expect(store.match("m1")!.edited!.cleared).toBeUndefined();
  });

  it("a finished tournament needs the confirm; clearing reopens it; a cancelled one can be edited, not cleared", async () => {
    const store = setup({ ...BASE, t: { status: "completed" } });
    const refused = await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 1 });
    expect(refused?.status).toBe(409);
    expect((refused?.body as { error: string }).error).toMatch(/finished/i);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 1, confirmFinished: true }))?.status).toBe(200);
    expect(store.tournament("t1")!.status).toBe("completed");
    expect((await clear(store, owner, "m1", { revision: 4 }))?.status).toBe(409);
    expect((await clear(store, owner, "m1", { revision: 4, confirmFinished: true }))?.status).toBe(200);
    expect(store.tournament("t1")!.status).toBe("active");

    const cancelled = setup({ ...BASE, t: { status: "cancelled" } });
    expect((await edit(cancelled, owner, "m1", { revision: 3, homeScore: 0, awayScore: 1, confirmFinished: true }))?.status).toBe(200);
    expect((await clear(cancelled, owner, "m1", { revision: 4, confirmFinished: true }))?.status).toBe(409);
  });
});

describe("what recomputes", () => {
  it("standings follow the edit at once", async () => {
    const store = setup(BASE);
    const before = (await call(store, "GET", "/api/tournaments/t1/standings"))!.body as { standings: Array<{ entrantId: string; points: number; touchdownsFor: number }> };
    expect(before.standings.find((r) => r.entrantId === "e-ann")).toMatchObject({ points: 3, touchdownsFor: 2 });
    await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 3 });
    const after = (await call(store, "GET", "/api/tournaments/t1/standings"))!.body as { standings: Array<{ entrantId: string; points: number; touchdownsFor: number; rank: number }> };
    expect(after.standings.find((r) => r.entrantId === "e-ann")).toMatchObject({ points: 0, touchdownsFor: 0 });
    expect(after.standings.find((r) => r.entrantId === "e-bob")).toMatchObject({ points: 3, touchdownsFor: 3, rank: 1 });
  });

  it("drawn rounds keep their pairings; only the next draw reads the edited standings", async () => {
    const store = setup(BASE);
    const r2 = store.matches("t1").filter((m) => m.roundNumber === 2);
    await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 3 });
    expect(store.matches("t1").filter((m) => m.roundNumber === 2)).toEqual(r2);
    expect(Object.keys(store.snapshot().rounds).sort()).toEqual(["t1:round:1", "t1:round:2"]);
  });

  it("knockout: a later round drawn from the winner refuses an edit that changes who won, allows a score change", async () => {
    const store = setup({
      t: { format: "knockout", roundCount: 2 },
      matches: [match("m1", 1, "Ann", "Bob", { h: 2, a: 1 }), match("m2", 1, "Cy", "Di", { h: 1, a: 0 }), match("m3", 2, "Ann", "Cy")],
      rounds: [round(1, "completed", ["m1", "m2"]), round(2, "active", ["m3"])],
    });
    const flip = await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 1 });
    expect(flip?.status).toBe(409);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 1, awayScore: 1 }))?.status).toBe(409); // a draw changes the outcome too
    expect((await clear(store, owner, "m1", { revision: 3 }))?.status).toBe(409);
    expect((await edit(store, owner, "m1", { revision: 3, homeScore: 3, awayScore: 0 }))?.status).toBe(200);
    expect(store.match("m3")).toMatchObject({ home: { entrantId: "e-ann" }, away: { entrantId: "e-cy" } });
  });

  it("series standings (computed on read) follow the edit", async () => {
    const series: TournamentSeriesRecord = {
      id: "sr1", name: "Valley Tour", description: "", organisers: ["Veers"], scoring: "sum", seeding: "dutch", tournaments: ["t1"],
      createdBy: "Veers", createdAt: at, updatedAt: at, revision: 1,
    };
    const store = setup({ ...BASE, series });
    const total = (coach: string) => computeSeriesStandings(series, store.snapshot()).rows.find((r) => r.coach === coach)?.total;
    expect(total("Ann")).toBeGreaterThan(total("Bob")!);
    await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 3 });
    expect(total("Bob")).toBeGreaterThan(total("Ann")!);
  });

  it("statistics count the edited score and casualties over the fork row's totals; the player lines stay as played", async () => {
    const store = setup(BASE);
    await edit(store, owner, "m1", { revision: 3, homeScore: 3, awayScore: 1, homeCasualties: 5, awayCasualties: 0 });
    const res = await call(store, "GET", "/api/tournaments/t1/statistics", undefined, undefined, { results: () => [FORK_ROW] });
    const teams = (res!.body as { teams: Array<{ entrantId: string; td: number; cas: number }> }).teams;
    expect(teams.find((t) => t.entrantId === "e-ann")).toMatchObject({ td: 3, cas: 5 });
    const players = (res!.body as { players: Array<{ playerId: string; td: number }> }).players;
    expect(players.find((p) => p.playerId === "a1")?.td).toBe(2);
  });

  it("the podium of a finished tournament (computed on read) follows a confirmed edit", async () => {
    const store = setup({
      t: { status: "completed", roundCount: 1, currentRound: 1 }, coaches: ["Ann", "Bob"],
      matches: [match("m1", 1, "Ann", "Bob", { h: 2, a: 1 })], rounds: [round(1, "completed", ["m1"])],
    });
    const champion = async () => ((await call(store, "GET", "/api/tournaments/t1/awards"))!.body as { podium: Array<{ title: string; toCoach?: string }> })
      .podium.find((p) => p.title === "Overall Champion")?.toCoach;
    expect(await champion()).toBe("Ann");
    await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 2, confirmFinished: true });
    expect(await champion()).toBe("Bob");
  });
});

describe("notifications", () => {
  it("both coaches once per edit or clear, from the editing manager; the manager is never told of their own edit", async () => {
    const store = setup(BASE);
    const { sent, notify } = notifier();
    await edit(store, piett, "m1", { revision: 3, homeScore: 1, awayScore: 1 }, { notify });
    expect(sent.map((s) => `${s.coach}:${s.type}:${s.from}`)).toEqual(["Ann:result-edited:Piett", "Bob:result-edited:Piett"]);
    expect(sent[0]!.title).toBe("Spike Open: result edited by an organiser");
    expect(sent[0]!.body).toContain("Ann 1 - 1 Bob");
    sent.splice(0);
    await clear(store, piett, "m1", { revision: 4 }, { notify });
    expect(sent.map((s) => s.coach)).toEqual(["Ann", "Bob"]);
    expect(sent[0]!.title).toMatch(/cleared/);
    sent.splice(0);
    // an admin who also plays the fixture: only the opponent is told
    const store2 = setup(BASE);
    await edit(store2, { coach: "Ann", organizer: false, admin: true }, "m1", { revision: 3, homeScore: 1, awayScore: 1 }, { notify });
    expect(sent.map((s) => s.coach)).toEqual(["Bob"]);
    // a refused edit tells nobody
    sent.splice(0);
    await edit(store2, owner, "m1", { revision: 3, homeScore: 5, awayScore: 1 }, { notify });
    expect(sent).toEqual([]);
  });
});

describe("what viewers see", () => {
  it("the Edited chip for everyone who sees the fixture; reason and old values only for its coaches and managers; the log for those who see every fixture", async () => {
    const store = setup(BASE);
    await edit(store, piett, "m1", { revision: 3, homeScore: 1, awayScore: 1, reason: "Typo" });
    const detail = async (auth?: TournamentApiIdentity) => (await call(store, "GET", "/api/tournaments/t1", auth))!.body as {
      tournament: Record<string, unknown>; scheduledMatches: Array<{ id: string; edited?: Record<string, unknown>; launch?: { gameId?: string } }>; activity: unknown[];
    };
    const anon = await detail();
    expect(anon.scheduledMatches).toEqual([]);
    expect(anon.activity).toEqual([]);
    expect(anon.tournament.activity).toBeUndefined();
    const asCy = await detail(cy); // an entrant who does not play m1
    expect(asCy.scheduledMatches.find((m) => m.id === "m1")!.edited).toEqual({ kind: "result", byCoachId: "Piett", at: now.toISOString() });
    expect(asCy.activity).toHaveLength(1);
    expect(asCy.tournament.activity).toBeUndefined();
    const asAnn = await detail(ann);
    expect(asAnn.scheduledMatches.find((m) => m.id === "m1")!.edited).toMatchObject({ reason: "Typo", previous: { homeScore: 2, awayScore: 1 } });
    expect(asAnn.scheduledMatches.find((m) => m.id === "m1")!.launch?.gameId).toBe("g1");
    // a signed-in coach outside the tournament sees only entries about fixtures they play (none)
    expect((await detail({ coach: "Zed", organizer: false, admin: false })).activity).toEqual([]);
  });

  it("the game page keeps the fork game as played and shows the organiser's result (edited and cleared)", async () => {
    const store = setup(BASE);
    await edit(store, owner, "m1", { revision: 3, homeScore: 0, awayScore: 1, homeCasualties: 1, awayCasualties: 1 });
    const t = { id: "t1", name: "Spike Open", matches: [store.match("m1")!], entrants: store.entrants("t1") };
    const online = gameDetail("online", "g1", { tournaments: [t], results: [FORK_ROW], tabletop: [] })!;
    expect(online.card.home.score).toBe(2); // the game as played (Ann 2-1)
    expect(online.summary.edited).toEqual({
      by: "Veers", at: now.toISOString(),
      result: { home: { coach: "Ann", score: 0, cas: 1 }, away: { coach: "Bob", score: 1, cas: 1 } },
    });
    const fixturePage = gameDetail("tournament", "m1", { tournaments: [t], results: [FORK_ROW], tabletop: [] })!;
    expect(fixturePage.card.home.score).toBe(0); // the fixture page shows the result the tournament counts
    expect(fixturePage.summary.edited?.result?.away.score).toBe(1);
    await clear(store, owner, "m1", { revision: 4 });
    const cleared = gameDetail("online", "g1", { tournaments: [{ ...t, matches: [store.match("m1")!] }], results: [FORK_ROW], tabletop: [] })!;
    expect(cleared.summary.edited).toEqual({ by: "Veers", at: now.toISOString(), cleared: true });
  });
});

const player = (playerId: string, name: string, p: Partial<GamestatePlayerResult>): GamestatePlayerResult => ({
  playerId, name, touchdowns: 0, casualtiesCaused: 0, blocks: 0, fouls: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, ...p,
});
/** Fork game g1 as played: Ann (home) 2-1 Bob, Ann's team caused 3 casualties. */
const FORK_ROW: StoredTournamentResult = {
  gameId: "g1", pulledAt: at, namesDecoded: true,
  home: { teamId: "fork-ann", teamName: "Ann's Orcs", coach: "Ann" },
  away: { teamId: "fork-bob", teamName: "Bob's Elves", coach: "Bob" },
  teams: [
    { teamId: "fork-ann", score: 2, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 0, si: 0, rip: 0 },
      players: [player("a1", "Grok", { touchdowns: 2, casualtiesCaused: 3 })] },
    { teamId: "fork-bob", score: 1, winnings: 0, penaltyScore: -1, conceded: false, casualtiesSuffered: { bh: 1, si: 1, rip: 1 },
      players: [player("b1", "Leaf", { touchdowns: 1 })] },
  ],
};
