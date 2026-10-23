import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tabletopApi, type FixtureGateway, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { TournamentStore } from "../src/tournaments/store.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let tstore: TournamentStore;
let tid = "";
let fixtures: string[] = [];
const banned = new Set<string>();
const files: Record<string, TabletopTeamFile> = {};
const COACHES = ["Alice", "Bob", "Carol", "Dave"];

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
  isBanned: (c) => banned.has(c),
  isOrganizer: (c) => c === "Org",
  now: () => NOW,
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> => {
  const [p, q] = path.split("?");
  return (await tabletopApi(method, p!, { coach, method: "discord" }, body, deps(), new URLSearchParams(q ?? "")))!;
};
let eid = 0;
const E = (type: string, team: string, player?: string, payload: Record<string, unknown> = {}) => {
  eid += 1;
  return { id: `evt-${String(eid).padStart(8, "0")}`, type, team, player, payload };
};
const prefix = (c: string) => c.slice(0, 1).toLowerCase();
const saveOf = (c: string) => `sv_${prefix(c)}`;

/** Create a match for fixture index `i` (fixture orientation), play it, and optionally submit. */
async function fixtureMatch(i: number, submit = true, comma = false): Promise<string> {
  const f = tstore.match(fixtures[i]!)!;
  const homeCoach = f.home.coach.ffbCoachId;
  const awayCoach = f.away!.coach.ffbCoachId;
  const created = await as("Org", "POST", "/api/tabletop/matches", {
    home: { coach: homeCoach, teamSaveId: saveOf(homeCoach) }, away: { coach: awayCoach, teamSaveId: saveOf(awayCoach) },
    postMatch: "spp-only", fixtureRef: fixtures[i],
  });
  expect(created.status).toBe(201);
  const id = (created.body as { match: { id: string } }).match.id;
  void comma;
  await as("Org", "POST", `/api/tabletop/matches/${id}/events`, {
    events: [E("touchdown", "home", `${prefix(homeCoach)}1`), E("touchdown", "home", `${prefix(homeCoach)}2`),
      E("casualty", "home", `${prefix(homeCoach)}1`, { victim: `${prefix(awayCoach)}1`, result: "BH" })],
  });
  if (submit) await as("Org", "POST", `/api/tabletop/matches/${id}/submit`);
  return id;
}
const bulk = (ids: string[], action: string, note?: string) => as("Org", "POST", "/api/tabletop/organiser/bulk", { ids, action, note });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-org-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  tstore = new TournamentStore(join(dir, "tournaments"));
  banned.clear();
  for (const c of COACHES) files[`${c}/${saveOf(c)}`] = mkTeam(`${c} XI`, prefix(c));
  const t = tstore.createTournament({ name: "Cup", packageName: "Rules", maxPlayers: 4, format: "swiss", organizerCoachId: "Org" }, NOW);
  tid = t.id;
  for (const name of COACHES)
    tstore.registerEntrant(t.id, { coachId: name, ffbCoachId: name, verifiedAt: NOW.toISOString() }, `team-${name.toLowerCase()}`, NOW);
  const snap = tstore.snapshot();
  snap.tournaments[t.id]!.status = "active";
  tstore.writeSnapshot(snap);
  fixtures = tstore.generateNextRound(t.id, NOW).scheduledMatchIds;
  expect(fixtures).toHaveLength(2);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("tabletop T4: organiser list", () => {
  it("is organiser-only and lists the tournament/round matches with state, score, confirmations, pendingOrganiser", async () => {
    const a = await fixtureMatch(0);
    await fixtureMatch(1, false);
    await as("Org", "POST", `/api/tabletop/matches/${a}/confirm`);
    expect((await as("Alice", "GET", `/api/tabletop/organiser/matches?tournament=${tid}`)).status).toBe(403);
    const r = await as("Org", "GET", `/api/tabletop/organiser/matches?tournament=${encodeURIComponent(tid)}&round=1`);
    const rows = (r.body as { matches: Array<Record<string, any>> }).matches;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: a, state: "confirmed", pendingOrganiser: true, score: { home: 2, away: 0 }, fixtureRef: fixtures[0] });
    expect(Object.keys(rows[0]!.confirmations)).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: "recording", pendingOrganiser: false });
    const other = await as("Org", "GET", `/api/tabletop/organiser/matches?tournament=${encodeURIComponent(tid)}&round=2`);
    expect((other.body as { matches: unknown[] }).matches).toEqual([]);
    expect((await as("Org", "GET", "/api/tabletop/organiser/matches")).status).toBe(400);
    expect((await as("Org", "GET", `/api/tabletop/organiser/matches?tournament=${tid}&round=x`)).status).toBe(400);
  });
});

describe("tabletop T4: bulk", () => {
  it("confirm-publish confirms both seats and publishes in one commit per match; failures are per id and the rest proceed", async () => {
    const a = await fixtureMatch(0);
    const b = await fixtureMatch(1, false); // still recording: cannot be confirmed
    const out = (await bulk([a, b, "tm_missing"], "confirm-publish")).body as { results: Array<{ id: string; ok: boolean; status: number; state?: string }> };
    expect(out.results.map((r) => [r.id, r.ok, r.status])).toEqual([[a, true, 200], [b, false, 409], ["tm_missing", false, 404]]);
    expect(out.results[0]!.state).toBe("published");
    const m = (await repo.getMatch(a))!;
    expect(m).toMatchObject({ state: "published", publishedBy: "Org" });
    expect(Object.keys(m.confirmations)).toHaveLength(2);
    expect(results.list()).toHaveLength(1); // counted
    expect(tstore.match(fixtures[0]!)!.status).toBe("completed");
    const hc = tstore.match(fixtures[0]!)!.home.coach.ffbCoachId;
    expect((await repo.getChain(hc, saveOf(hc)))!.head).toBe(1);
    expect((await repo.getMatch(b))!.state).toBe("recording");
    expect(await repo.getJournal(a)).toBeUndefined();
  });

  it("a newly banned participant fails that id only", async () => {
    const a = await fixtureMatch(0);
    const b = await fixtureMatch(1);
    banned.add(tstore.match(fixtures[0]!)!.home.coach.ffbCoachId);
    const out = (await bulk([a, b], "confirm-publish")).body as { results: Array<{ ok: boolean; status: number }> };
    expect(out.results.map((r) => [r.ok, r.status])).toEqual([[false, 403], [true, 200]]);
    expect((await repo.getMatch(a))!.state).toBe("submitted");
  });

  it("an already-confirmed match is published; a published one is a 409", async () => {
    const a = await fixtureMatch(0);
    await as("Org", "POST", `/api/tabletop/matches/${a}/confirm`);
    const first = (await bulk([a], "confirm-publish")).body as { results: Array<{ ok: boolean }> };
    expect(first.results[0]!.ok).toBe(true);
    const again = (await bulk([a], "confirm-publish")).body as { results: Array<{ ok: boolean; status: number }> };
    expect(again.results[0]).toMatchObject({ ok: false, status: 409 });
  });

  it("reopen: submitted and confirmed go back to recording with the note (shown in the list); published is a 409", async () => {
    const a = await fixtureMatch(0); // submitted
    const b = await fixtureMatch(1);
    await as("Org", "POST", `/api/tabletop/matches/${b}/confirm`); // confirmed (revisions + row written)
    const out = (await bulk([a, b], "reopen", "score disputed")).body as { results: Array<{ ok: boolean; state?: string }> };
    expect(out.results.map((r) => [r.ok, r.state])).toEqual([[true, "recording"], [true, "recording"]]);
    expect((await repo.getMatch(b))).toMatchObject({ state: "recording", note: "score disputed" });
    expect(results.listAll()).toHaveLength(0); // confirmed row retracted
    const rows = ((await as("Org", "GET", `/api/tabletop/organiser/matches?tournament=${encodeURIComponent(tid)}`)).body as { matches: Array<{ note?: string }> }).matches;
    expect(rows.map((r) => r.note)).toEqual(["score disputed", "score disputed"]);
    // published must be undone first
    await as("Org", "POST", `/api/tabletop/matches/${a}/submit`);
    await bulk([a], "confirm-publish");
    const pub = (await bulk([a], "reopen")).body as { results: Array<{ ok: boolean; status: number }> };
    expect(pub.results[0]).toMatchObject({ ok: false, status: 409 });
    expect((await as("Org", "POST", `/api/tabletop/matches/${a}/undo-revision`)).status).toBe(200);
  });

  it("validates input and is organiser-only", async () => {
    expect((await as("Alice", "POST", "/api/tabletop/organiser/bulk", { ids: ["x"], action: "reopen" })).status).toBe(403);
    expect((await bulk([], "reopen")).status).toBe(400);
    expect((await bulk(["tm_a"], "explode")).status).toBe(400);
    expect((await bulk(["tm_a"], "reopen", "x".repeat(501))).status).toBe(400);
  });
});

describe("tabletop T4: export", () => {
  it("CSV of published results only, NAF column names, formula-safe", async () => {
    const a = await fixtureMatch(0);
    await fixtureMatch(1); // submitted, not published
    await bulk([a], "confirm-publish");
    const r = await as("Org", "GET", `/api/tabletop/organiser/export?tournament=${encodeURIComponent(tid)}&round=1`);
    expect(r.status).toBe(200);
    expect(r.contentType).toMatch(/^text\/csv/);
    const lines = String(r.body).trim().split("\r\n");
    expect(lines[0]).toBe("timeStamp,homeCoach,homeTeam,awayCoach,awayTeam,homeTouchDowns,awayTouchDowns,homeBadlyHurt,awayBadlyHurt,fixture");
    expect(lines).toHaveLength(2);
    const f = tstore.match(fixtures[0]!)!;
    expect(lines[1]).toBe(`2026-3-1 10:00,${f.home.coach.ffbCoachId},${f.home.coach.ffbCoachId} XI,${f.away!.coach.ffbCoachId},${f.away!.coach.ffbCoachId} XI,2,0,1,0,${fixtures[0]}`);
    expect((await as("Alice", "GET", `/api/tabletop/organiser/export?tournament=${tid}`)).status).toBe(403);
    // a coach/team name that starts like a formula is neutralised
    const m = (await repo.getMatch(a))!;
    await repo.updateMatch({ ...m, home: { ...m.home, teamName: '=HYPERLINK("x"),y' } });
    const again = await as("Org", "GET", `/api/tabletop/organiser/export?tournament=${encodeURIComponent(tid)}`);
    expect(String(again.body)).toContain(`"'=HYPERLINK(""x""),y"`);
  });
});
