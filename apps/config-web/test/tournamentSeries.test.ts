import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeSeriesStandings, seriesApi, type SeriesApiDeps, type SeriesApiIdentity } from "../src/tournaments/series.js";
import { tournamentApi } from "../src/tournaments/api.js";
import { migrateTournamentData, TournamentStore } from "../src/tournaments/store.js";
import type {
  ScheduledMatchRecord, TournamentDataFileV4, TournamentEntrantRecord, TournamentRecord, TournamentSeriesRecord,
} from "../src/tournaments/types.js";

// Tournament Series (spec-spa-tournaments §6.2; owner 10-28: admins AND organisers create; scoring sum | bestN; Elo
// seeding is an option inside a series). Store + routes + standings maths. Fake coach names only.

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function newStore(): TournamentStore {
  const root = mkdtempSync(join(tmpdir(), "bbtv-series-"));
  roots.push(root);
  return new TournamentStore(root);
}

const now = new Date("2026-11-01T12:00:00.000Z");
const organiser = (coach: string): SeriesApiIdentity => ({ coach, organizer: true, admin: false });
const player = (coach: string): SeriesApiIdentity => ({ coach, organizer: false, admin: false });
const ADMIN: SeriesApiIdentity = { coach: "Root", organizer: true, admin: true };
const REGISTERED = ["Veers", "Piett", "Ozzel", "Root", "Needa", "Alice", "Bob"];
const deps = (store: TournamentStore, over: Partial<SeriesApiDeps> = {}): SeriesApiDeps => ({
  store, now: () => now, registeredCoach: (id) => REGISTERED.find((n) => n.toLowerCase() === id.trim().toLowerCase()), ...over,
});

const tournament = (id: string, over: Partial<TournamentRecord> = {}): TournamentRecord => ({
  id, name: `Event ${id}`, status: "completed", format: "swiss", packageName: "Rules", maxPlayers: 8, roundCount: 1, currentRound: 1,
  tiebreakers: ["buchholz", "touchdownDifferential", "casualtyDifferential"], points: { win: 3, draw: 1, loss: 0, bye: 3 },
  ownerCoachId: "Veers", organizerCoachId: "Veers", organizerCoachIds: [], pairingSystem: "dutch", seedingMode: "elo",
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...over,
});
const ident = (c: string) => ({ coachId: c, ffbCoachId: c, verifiedAt: "2026-10-01T00:00:00Z" });
const entrant = (tid: string, coach: string, seed: number): TournamentEntrantRecord => ({
  id: `${tid}:${coach}`, tournamentId: tid, seed, coach: ident(coach), teamId: `team-${coach}`, registeredAt: "",
  submission: { saveId: "save:x", revision: "r", submittedAt: "", teamName: `${coach} XI`, snapshot: null, validation: { ok: true, problems: [], checkedAt: "", packageName: "Rules" } },
});
let matchNo = 0;
const game = (tid: string, home: string, away: string, hs: number, as: number): ScheduledMatchRecord => ({
  id: `${tid}:m${++matchNo}`, tournamentId: tid, roundId: `${tid}:r1`, roundNumber: 1,
  home: { entrantId: `${tid}:${home}`, coach: ident(home), teamId: `team-${home}` },
  away: { entrantId: `${tid}:${away}`, coach: ident(away), teamId: `team-${away}` },
  status: "completed", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
  result: { homeScore: hs, awayScore: as, reportedAt: "2026-10-01T00:00:00Z" }, createdAt: "", updatedAt: "",
});
function data(tournaments: TournamentRecord[], games: ScheduledMatchRecord[], extra: TournamentEntrantRecord[] = []): TournamentDataFileV4 {
  const entrants: Record<string, TournamentEntrantRecord> = {};
  for (const g of games) {
    for (const side of [g.home, g.away!]) {
      const coach = side.coach.ffbCoachId;
      entrants[`${g.tournamentId}:${coach}`] ??= entrant(g.tournamentId, coach, Object.keys(entrants).length + 1);
    }
  }
  for (const e of extra) entrants[e.id] = e;
  return migrateTournamentData({
    version: 4, tournaments: Object.fromEntries(tournaments.map((t) => [t.id, t])), entrants, rounds: {}, standings: {},
    scheduledMatches: Object.fromEntries(games.map((g) => [g.id, g])), waitingPresence: {},
  });
}
const series = (tournaments: string[], over: Partial<TournamentSeriesRecord> = {}): TournamentSeriesRecord => ({
  id: "s1", name: "Valley Series", description: "", organisers: ["Veers"], scoring: "sum", seeding: "dutch", tournaments,
  createdBy: "Veers", createdAt: "", updatedAt: "", revision: 1, ...over,
});

/** A, B, C, D over three events: sum A6 B4 C7 D0; best-2 A6 B4 C6 D0 with C over A on head-to-head (C beat A in T2). */
function threeEvents(): TournamentDataFileV4 {
  return data([tournament("t1"), tournament("t2"), tournament("t3")], [
    game("t1", "Alice", "Bob", 2, 1), game("t1", "Cid", "Dee", 1, 0),
    game("t2", "Alice", "Cid", 0, 1), game("t2", "Bob", "Dee", 2, 0),
    game("t3", "Alice", "Dee", 3, 0), game("t3", "Bob", "Cid", 1, 1),
  ], [entrant("t1", "Zed", 9)]); // entered, never played: not in the series standings
}

describe("series standings maths", () => {
  it("sum adds every event; per-event points and events played are shown; a coach with no game is left out", () => {
    const s = computeSeriesStandings(series(["t1", "t2", "t3"]), threeEvents());
    expect(s.rows.map((r) => [r.rank, r.coach, r.total, r.eventsPlayed])).toEqual([[1, "Cid", 7, 3], [2, "Alice", 6, 3], [3, "Bob", 4, 3], [4, "Dee", 0, 3]]);
    expect(s.rows[1]!.results.map((r) => [r.tournamentId, r.points, r.counted])).toEqual([["t1", 3, true], ["t2", 0, true], ["t3", 3, true]]);
    expect(s.rows[0]!.results[0]).toMatchObject({ teamName: "Cid XI", rank: expect.any(Number) });
    expect(s.rows.some((r) => r.coach === "Zed")).toBe(false);
    expect(s.tiebreaks).toEqual(["total points", "best single result", "head-to-head wins", "name"]);
  });

  it("bestN keeps each coach's N best (the dropped result is shown, not added); head-to-head breaks the tie on total and best", () => {
    const s = computeSeriesStandings(series(["t1", "t2", "t3"], { scoring: "bestN", bestN: 2 }), threeEvents());
    expect(s.rows.map((r) => [r.rank, r.coach, r.total, r.best, r.headToHead])).toEqual([
      [1, "Cid", 6, 3, 1], [2, "Alice", 6, 3, 0], [3, "Bob", 4, 3, 0], [4, "Dee", 0, 0, 0],
    ]);
    const alice = s.rows.find((r) => r.coach === "Alice")!;
    expect(alice.results.map((r) => r.counted)).toEqual([true, false, true]);
    // Equal results: the earlier event is kept (Cid scored 3, 3, 1 -> the two 3s).
    expect(s.rows[0]!.results.map((r) => r.counted)).toEqual([true, true, false]);
    expect(s).toMatchObject({ scoring: "bestN", bestN: 2 });
  });

  it("best single result breaks a tie on total before head-to-head", () => {
    // Equal totals, different bests: Ann 3 + 1 (best 3) against Ben's four draws 1 + 1 + 1 + 1 (best 1).
    const d = data([tournament("a"), tournament("b"), tournament("c"), tournament("d")], [
      game("a", "Ann", "Xen", 1, 0), game("b", "Ann", "Yul", 1, 1), // Ann 3 + 1 = 4, best 3
      game("a", "Ben", "Yul", 0, 0), game("b", "Ben", "Xen", 0, 0), game("c", "Ben", "Xen", 0, 0), game("d", "Ben", "Yul", 0, 0), // Ben 1+1+1+1 = 4, best 1
    ]);
    const s = computeSeriesStandings(series(["a", "b", "c", "d"]), d);
    const order = s.rows.filter((r) => r.coach === "Ann" || r.coach === "Ben").map((r) => [r.coach, r.total, r.best]);
    expect(order).toEqual([["Ann", 4, 3], ["Ben", 4, 1]]);
  });

  it("still tied after head-to-head: same rank, ordered by name (case-insensitive)", () => {
    const d = data([tournament("t4")], [game("t4", "bob", "Gus", 2, 0), game("t4", "Alice", "Hal", 1, 0)]);
    const s = computeSeriesStandings(series(["t4"]), d);
    expect(s.rows.slice(0, 2).map((r) => [r.rank, r.coach])).toEqual([[1, "Alice"], [1, "bob"]]);
    expect(s.rows.slice(2).map((r) => r.rank)).toEqual([3, 3]);
  });

  it("drafts and cancelled tournaments don't count; an active one counts and is provisional; a missing id is skipped", () => {
    const d = data([tournament("t1"), tournament("t2", { status: "active" }), tournament("t3", { status: "draft" }), tournament("t5", { status: "cancelled" })], [
      game("t1", "Alice", "Bob", 1, 0), game("t2", "Bob", "Alice", 1, 0), game("t5", "Alice", "Bob", 5, 0),
    ]);
    const s = computeSeriesStandings(series(["t1", "t2", "t3", "t5", "gone"]), d);
    expect(s.events.map((e) => [e.id, e.counted, e.provisional])).toEqual([["t1", true, false], ["t2", true, true], ["t3", false, false], ["t5", false, false]]);
    expect(s.rows.map((r) => [r.coach, r.total, r.eventsPlayed])).toEqual([["Alice", 3, 2], ["Bob", 3, 2]]);
  });
});

describe("series routes: create / edit / delete", () => {
  const create = (store: TournamentStore, who: SeriesApiIdentity | undefined, body: Record<string, unknown> = {}) =>
    seriesApi("POST", "/api/series", who, { name: "Valley Series", scoring: "sum", seeding: "dutch", ...body }, deps(store))!;

  it("anonymous 401, a plain coach 403; an organiser and an admin may create (creator first among organisers)", () => {
    const store = newStore();
    expect(create(store, undefined).status).toBe(401);
    expect(create(store, player("Needa")).status).toBe(403);
    const made = create(store, organiser("veers"), { organisers: ["Piett", "VEERS", "piett"], description: "  Four events. " });
    expect(made.status).toBe(201);
    const body = made.body as { series: TournamentSeriesRecord & { canEdit: boolean } };
    expect(body.series).toMatchObject({ organisers: ["Veers", "Piett"], description: "Four events.", revision: 1, canEdit: true, tournaments: [] });
    expect(body.series).not.toHaveProperty("createdBy"); // public read model: the organisers list is the "run by"
    expect(store.seriesRecord(body.series.id)!.createdBy).toBe("veers");
    expect(create(store, ADMIN).status).toBe(201);
    expect((seriesApi("GET", "/api/series", undefined, undefined, deps(store))!.body as { series: unknown[] }).series).toHaveLength(2);
  });

  it("validates name, scoring, bestN, seeding and organisers", () => {
    const store = newStore();
    const o = organiser("Veers");
    expect(create(store, o, { name: " " }).status).toBe(400);
    expect(create(store, o, { name: "x".repeat(101) }).status).toBe(400);
    expect(create(store, o, { scoring: "average" }).status).toBe(400);
    expect(create(store, o, { scoring: "bestN" }).status).toBe(400);
    expect(create(store, o, { scoring: "bestN", bestN: 0 }).status).toBe(400);
    expect(create(store, o, { scoring: "bestN", bestN: 2.5 }).status).toBe(400);
    expect(create(store, o, { seeding: "swiss" }).status).toBe(400);
    expect((create(store, o, { organisers: ["Nobody"] }).body as { error: string }).error).toContain("not a registered coach");
    const best = create(store, o, { scoring: "bestN", bestN: 3, seeding: "elo" });
    expect((best.body as { series: TournamentSeriesRecord }).series).toMatchObject({ scoring: "bestN", bestN: 3, seeding: "elo" });
  });

  it("only the series' organisers or an admin edit; writes need the loaded revision (428 missing, 409 stale)", () => {
    const store = newStore();
    const id = (create(store, organiser("Veers"), { organisers: ["Piett"] }).body as { series: { id: string } }).series.id;
    const patch = (who: SeriesApiIdentity | undefined, body: Record<string, unknown>, ifMatch?: string) =>
      seriesApi("PATCH", `/api/series/${id}`, who, body, deps(store, { ifMatch }))!;
    expect(patch(undefined, { revision: 1, name: "X" }).status).toBe(401);
    expect(patch(organiser("Ozzel"), { revision: 1, name: "X" }).status).toBe(403); // an organiser, but not of THIS series
    expect(patch(organiser("Veers"), { name: "X" }).status).toBe(428);
    expect(patch(organiser("Veers"), { revision: 7, name: "X" }).status).toBe(409);
    // Piett is a series organiser without the global organiser role: still edits this series.
    const ok = patch(player("piett"), { revision: 1, name: "Renamed", scoring: "bestN", bestN: 2 });
    expect(ok.status).toBe(200);
    expect((ok.body as { series: TournamentSeriesRecord }).series).toMatchObject({ name: "Renamed", scoring: "bestN", bestN: 2, revision: 2 });
    expect(patch(organiser("Veers"), { name: "Again" }, '"2"').status).toBe(200); // If-Match works too
    expect(patch(ADMIN, { revision: 3, scoring: "sum" }).status).toBe(200);
    expect(store.seriesRecord(id)).not.toHaveProperty("bestN");
    expect(patch(ADMIN, { revision: 4, organisers: [] }).status).toBe(400);
  });

  it("delete: organisers / admins only, revision-checked; the tournaments stay and leave the series", () => {
    const store = newStore();
    store.writeSnapshot(data([tournament("t1")], []));
    const id = (create(store, organiser("Veers")).body as { series: { id: string } }).series.id;
    expect(seriesApi("POST", `/api/series/${id}/tournaments/t1`, organiser("Veers"), { revision: 1 }, deps(store))!.status).toBe(200);
    expect(store.tournament("t1")!.seriesId).toBe(id);
    expect(seriesApi("DELETE", `/api/series/${id}`, organiser("Ozzel"), { revision: 2 }, deps(store))!.status).toBe(403);
    expect(seriesApi("DELETE", `/api/series/${id}`, organiser("Veers"), {}, deps(store))!.status).toBe(428);
    expect(seriesApi("DELETE", `/api/series/${id}`, organiser("Veers"), { revision: 2 }, deps(store))!.status).toBe(200);
    expect(store.seriesRecord(id)).toBeUndefined();
    expect(store.tournament("t1")).toBeDefined();
    expect(store.tournament("t1")!.seriesId).toBeUndefined();
    expect(seriesApi("GET", `/api/series/${id}`, undefined, undefined, deps(store))!.status).toBe(404);
  });
});

describe("series routes: add / remove tournaments", () => {
  function setup() {
    const store = newStore();
    store.writeSnapshot(data([
      tournament("mine"), tournament("helped", { ownerCoachId: "Ozzel", organizerCoachId: "Ozzel", organizerCoachIds: ["Veers"] }),
      tournament("theirs", { ownerCoachId: "Ozzel", organizerCoachId: "Ozzel" }),
    ], []));
    const created = seriesApi("POST", "/api/series", organiser("Veers"), { name: "S", scoring: "sum", seeding: "monrad", organisers: ["Piett"] }, deps(store))!;
    return { store, id: (created.body as { series: { id: string } }).series.id };
  }
  const move = (store: TournamentStore, method: "POST" | "DELETE", id: string, tid: string, who: SeriesApiIdentity, revision?: number) =>
    seriesApi(method, `/api/series/${id}/tournaments/${tid}`, who, revision === undefined ? {} : { revision }, deps(store))!;

  it("a series organiser adds only tournaments they run (owner or listed organiser); an admin adds any", () => {
    const { store, id } = setup();
    expect(move(store, "POST", id, "mine", organiser("Ozzel"), 1).status).toBe(403); // runs no part of this series
    expect(move(store, "POST", id, "theirs", organiser("Veers"), 1).status).toBe(403); // not a tournament Veers runs
    expect(move(store, "POST", id, "theirs", player("Piett"), 1).status).toBe(403);
    expect(move(store, "POST", id, "mine", organiser("Veers")).status).toBe(428);
    expect(move(store, "POST", id, "mine", organiser("Veers"), 1).status).toBe(200);
    const helped = move(store, "POST", id, "helped", organiser("Veers"), 2);
    expect(helped.status).toBe(200);
    expect((helped.body as { series: TournamentSeriesRecord }).series.tournaments).toEqual(["mine", "helped"]);
    expect(move(store, "POST", id, "mine", organiser("Veers"), 3).status).toBe(409); // already in
    expect(move(store, "POST", id, "theirs", ADMIN, 3).status).toBe(200);
    expect(store.tournament("theirs")!.seriesId).toBe(id);
    expect(move(store, "POST", id, "nope", ADMIN, 4).status).toBe(404);
  });

  it("a tournament belongs to one series; remove follows the same rule and clears seriesId", () => {
    const { store, id } = setup();
    expect(move(store, "POST", id, "mine", organiser("Veers"), 1).status).toBe(200);
    const other = (seriesApi("POST", "/api/series", organiser("Veers"), { name: "Other", scoring: "sum", seeding: "dutch" }, deps(store))!.body as { series: { id: string } }).series.id;
    expect(move(store, "POST", other, "mine", organiser("Veers"), 1).status).toBe(409);
    expect(move(store, "POST", id, "theirs", ADMIN, 2).status).toBe(200);
    expect(move(store, "DELETE", id, "theirs", organiser("Veers"), 3).status).toBe(403); // not Veers' tournament
    expect(move(store, "DELETE", id, "mine", organiser("Veers"), 3).status).toBe(200);
    expect(store.tournament("mine")!.seriesId).toBeUndefined();
    expect(move(store, "DELETE", id, "mine", organiser("Veers"), 4).status).toBe(404);
  });

  it("the detail lists what the viewer may add (managers' own, not in a series, not cancelled) only to editors", () => {
    const { store, id } = setup();
    const read = (who?: SeriesApiIdentity) => seriesApi("GET", `/api/series/${id}`, who, undefined, deps(store))!.body as { attachable?: Array<{ id: string }>; series: { canEdit: boolean } };
    expect(read().attachable).toBeUndefined();
    expect(read().series.canEdit).toBe(false);
    expect(read(organiser("Ozzel")).attachable).toBeUndefined();
    expect(read(organiser("Veers")).attachable!.map((t) => t.id)).toEqual(["helped", "mine"]);
    expect(read(ADMIN).attachable!.map((t) => t.id)).toEqual(["helped", "mine", "theirs"]);
  });
});

describe("series seeding: the default for new tournaments in the series", () => {
  const tdeps = (store: TournamentStore) => ({
    store, packageExists: (n: string) => n === "Rules", teamBuild: () => undefined, now: () => now,
  });
  const newSeries = (store: TournamentStore, seeding: string) =>
    (seriesApi("POST", "/api/series", organiser("Veers"), { name: `S ${seeding}`, scoring: "sum", seeding }, deps(store))!.body as { series: { id: string } }).series.id;
  const createIn = (store: TournamentStore, seriesId: string | undefined, who = organiser("Veers")) =>
    tournamentApi("POST", "/api/tournaments", new URLSearchParams(), who, { name: "Leg", packageName: "Rules", maxPlayers: 8, format: "swiss", ...(seriesId ? { seriesId } : {}) }, tdeps(store));

  it("dutch / monrad / elo set the new tournament's pairing; it joins the series in the same write", async () => {
    const store = newStore();
    for (const [seeding, pairing] of [["dutch", "dutch"], ["monrad", "monrad"], ["elo", "eloSeeded"]] as const) {
      const sid = newSeries(store, seeding);
      const res = await createIn(store, sid);
      expect(res!.status).toBe(201);
      const t = (res!.body as { tournament: TournamentRecord }).tournament;
      expect(t).toMatchObject({ pairingSystem: pairing, seedingMode: "elo", seriesId: sid });
      expect(store.seriesRecord(sid)).toMatchObject({ tournaments: [t.id], revision: 2 });
    }
    // Outside a series the default stays Dutch.
    expect(((await createIn(store, undefined))!.body as { tournament: TournamentRecord }).tournament.pairingSystem).toBe("dutch");
  });

  it("only the series' organisers (or an admin) create inside it; the organiser can still change the pairing per tournament", async () => {
    const store = newStore();
    const sid = newSeries(store, "elo");
    expect((await createIn(store, sid, organiser("Ozzel")))!.status).toBe(403);
    expect((await createIn(store, "missing"))!.status).toBe(404);
    expect((await createIn(store, sid, { coach: "Root", organizer: true, admin: true }))!.status).toBe(201);
    const t = ((await createIn(store, sid))!.body as { tournament: TournamentRecord }).tournament;
    const patched = await tournamentApi("PATCH", `/api/tournaments/${t.id}`, new URLSearchParams(), organiser("Veers"), { pairingSystem: "monrad" }, tdeps(store));
    expect((patched!.body as { tournament: TournamentRecord }).tournament.pairingSystem).toBe("monrad");
    // The tournament page reads the series chip (id + name).
    const detail = await tournamentApi("GET", `/api/tournaments/${t.id}`, new URLSearchParams(), undefined, undefined, tdeps(store));
    expect((detail!.body as { series?: unknown }).series).toEqual({ id: sid, name: "S elo" });
  });
});
