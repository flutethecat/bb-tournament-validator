import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { onboardingGateApplies } from "../src/auth/onboarding";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { SenderRateLimiter, type NotificationInput } from "../src/notifications";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { TournamentStore } from "../src/tournaments/store";
import { clearFences, coachKeyHash, fenceCoachHash } from "../src/privacy/fence";
import { collectExport, DELETE_STEPS, INVENTORY_ROWS, KNOWN_STORES, STORE_COLLECTORS } from "../src/privacy/collectors";
import { PrivacyService } from "../src/privacy/service";
import { setResultCoachFilter } from "../src/tournamentResults";
import { setNafIdFilter } from "../src/nafRecords";
import { setReplayCoachFilter } from "../src/replay/store";
import { SocialStore } from "../src/social/store";
import { isScheduleApiPath, NOT_ACCEPTING, OPPONENT_UNLINKED, parseSlot, scheduleApi, slotWarnings, socialSlot, YOU_BLOCKED, type ScheduleApiDeps, type SchedulingInfo } from "../src/schedule/api";
import { clearScheduleIndex, createFixtureSource, leagueRef, parseRef, tournamentRef } from "../src/schedule/fixtures";
import { KEEP_SETTLED_MS, ProposalStore } from "../src/schedule/store";
import { INVENTORY } from "../spa/src/privacy/inventory";
import { depsFor, seed } from "./privacyFixture.js";

// Game-time proposals + the coach Schedule (src/schedule; landing spec §4.6, ruling §7): the lifecycle (propose, counter,
// accept, decline, withdraw, expire), accept writes the agreed time onto the EXISTING fixture and never creates one,
// participants only, blocks, unsocial hours / no timezone / deadline warnings, conflict suppression, one notification
// per proposal / counter / accept, the deletion fence, the CSRF and onboarding gates, and privacy coverage.

const H = 3_600_000;
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const at = (hours: number) => new Date(NOW + hours * H).toISOString();

const team = (id: string, name: string, coachId: string): LeagueTeam => ({
  id, name, race: "Orc", coach: coachId, coachId, teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
} as unknown as LeagueTeam);
const fx = (id: string, round: number, home: string, away: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: { team: home, teamId: home.toLowerCase(), coach: "", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: away, teamId: away.toLowerCase(), coach: "", race: "Orc", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const season = (): SeasonRecord => ({
  id: "season-1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "tabbl-s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  teams: [team("orcs", "Orcs", "Ann"), team("elves", "Elves", "Bob"), team("rats", "Rats", "Cat"), team("dwarfs", "Dwarfs", "Dee")],
  fixtures: [
    fx("f1", 1, "Orcs", "Elves", { deadline: at(24 * 6) }),
    fx("f2", 1, "Rats", "Dwarfs"),
    fx("f3", 2, "Orcs", "Rats"),
    fx("played", 1, "Elves", "Dwarfs", { home: { team: "Elves", teamId: "elves", coach: "", race: "Orc", score: 2, cas: 0, conceded: false }, away: { team: "Dwarfs", teamId: "dwarfs", coach: "", race: "Orc", score: 1, cas: 0, conceded: false } }),
  ],
  participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
} as unknown as SeasonRecord);

const ACCOUNTS = ["Ann", "Bob", "Cat", "Dee", "Eve"];
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

interface Harness {
  dir: string;
  leagues: LeagueStore;
  tournaments: TournamentStore;
  store: ProposalStore;
  social: SocialStore;
  notes: Array<{ coach: string; input: NotificationInput }>;
  zones: Map<string, SchedulingInfo>;
  now: { t: number };
  deps: ScheduleApiDeps;
  call(coach: string | undefined, method: string, path: string, body?: unknown, test?: boolean): { status: number; body: any };
  propose(coach: string, fixture: string, slots: string[]): { status: number; body: any };
  respond(coach: string, body: Record<string, unknown>): { status: number; body: any };
  mine(coach: string): any;
}

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), "schedule-"));
  roots.push(dir);
  const leagues = new LeagueStore(dir);
  leagues.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Org"] } as never);
  leagues.putSeason(season());
  const tournaments = new TournamentStore(dir);
  tournaments.writeSnapshot({
    version: 4,
    tournaments: { t1: { id: "t1", name: "Autumn Open", status: "active" } },
    entrants: {
      e1: { id: "e1", tournamentId: "t1", seed: 1, coach: { ffbCoachId: "Ann" }, teamId: "x1", registeredAt: at(-100), submission: { teamName: "Ann's Orcs" } },
      e2: { id: "e2", tournamentId: "t1", seed: 2, coach: { ffbCoachId: "Eve" }, teamId: "x2", registeredAt: at(-100), submission: { teamName: "Eve's Elves" } },
    },
    rounds: {},
    standings: {},
    scheduledMatches: {
      m1: { id: "m1", tournamentId: "t1", roundId: "r1", roundNumber: 1, home: { entrantId: "e1", coach: { ffbCoachId: "Ann" }, teamId: "x1" }, away: { entrantId: "e2", coach: { ffbCoachId: "Eve" }, teamId: "x2" }, status: "scheduled", revision: 3, launch: { retryCount: 0 }, createdAt: at(-50), updatedAt: at(-50) },
    },
    waitingPresence: {},
  } as never);
  const store = new ProposalStore(dir);
  const social = new SocialStore(dir);
  const notes: Harness["notes"] = [];
  const zones = new Map<string, SchedulingInfo>([["ann", { timezone: "Europe/London", availability: [] }], ["bob", { timezone: "Europe/London", availability: [{ day: 1, start: "18:00", end: "23:00" }] }]]);
  const now = { t: NOW };
  const deps: ScheduleApiDeps = {
    store,
    fixtures: createFixtureSource({ leagues, tournaments, now: () => now.t }),
    coach: (name) => ACCOUNTS.find((a) => a.toLowerCase() === name.trim().toLowerCase()),
    scheduling: (c) => zones.get(c.trim().toLowerCase()),
    hasBlocked: (a, b) => social.hasBlocked(a, b),
    isFenced: () => false,
    notify: (coach, input) => notes.push({ coach, input }),
    limiter: new SenderRateLimiter(100, H),
    now: () => now.t,
  };
  const call = (coach: string | undefined, method: string, path: string, body?: unknown, test?: boolean) =>
    scheduleApi(method, path, coach ? { coach, ...(test ? { test: true } : {}) } : undefined, body, deps) as { status: number; body: any };
  return {
    dir, leagues, tournaments, store, social, notes, zones, now, deps, call,
    propose: (coach, fixture, slots) => call(coach, "POST", "/api/schedule/propose", { fixture, slots }),
    respond: (coach, body) => call(coach, "POST", "/api/schedule/respond", body),
    mine: (coach) => call(coach, "GET", "/api/schedule/mine").body,
  };
}

const F1 = leagueRef("tabbl", "season-1", "f1");
const F3 = leagueRef("tabbl", "season-1", "f3");
const M1 = tournamentRef("m1");
// Slots on whole hours in the afternoon/evening London time (UTC in November).
const S1 = "2026-11-12T18:00:00.000Z";
const S2 = "2026-11-13T18:00:00.000Z";
const S3 = "2026-11-14T15:00:00.000Z";

let h: Harness;
beforeEach(() => { h = harness(); clearFences(); });
afterEach(() => { clearFences(); clearScheduleIndex(h.leagues); });

describe("refs, slots and time checks", () => {
  it("parses fixture refs and refuses junk", () => {
    expect(parseRef(F1)).toEqual({ kind: "league", leagueId: "tabbl", seasonId: "season-1", fixtureId: "f1" });
    expect(parseRef(M1)).toEqual({ kind: "tournament", matchId: "m1" });
    for (const bad of ["", "league:TAB:s:f", "league:a:b", "tournament:", "tournament:a/b", "x".repeat(300), 5, null]) expect(parseRef(bad)).toBeUndefined();
  });
  it("slot starts are ISO instants with a zone on the quarter hour", () => {
    expect(parseSlot("2026-11-12T19:00+01:00")).toBe("2026-11-12T18:00:00.000Z");
    expect(parseSlot("2026-11-12T18:15:00Z")).toBe("2026-11-12T18:15:00.000Z");
    for (const bad of ["2026-11-12T18:07:00Z", "2026-11-12T18:00", "2026-11-12", "soon", 1]) expect(parseSlot(bad)).toBeUndefined();
  });
  it("unsocial hours = outside 09:00-22:00 in the OPPONENT's zone; no zone = an explicit notice", () => {
    expect(socialSlot("2026-11-12T18:00:00Z", "Europe/London")).toBe(true);
    expect(socialSlot("2026-11-12T21:00:00Z", "Europe/London")).toBe(false); // 21:00-23:00
    expect(socialSlot("2026-11-12T18:00:00Z", "Asia/Tokyo")).toBe(false); // 03:00-05:00 in Tokyo
    expect(slotWarnings([S1], "Asia/Tokyo", undefined).map((w) => w.code)).toEqual(["unsocial"]);
    expect(slotWarnings([S1], "", undefined).map((w) => w.code)).toEqual(["no-timezone"]);
    expect(slotWarnings([S1], "Europe/London", "2026-11-12T19:00:00Z").map((w) => w.code)).toEqual(["after-deadline"]);
  });
});

describe("routes and gates", () => {
  it("signed-in only; GET reads, POST writes; a test sign-in reads only", () => {
    expect(isScheduleApiPath("/api/schedule/mine")).toBe(true);
    expect(isScheduleApiPath("/api/schedule/other")).toBe(false);
    expect(h.call(undefined, "GET", "/api/schedule/mine").status).toBe(401);
    expect(h.call("Ann", "POST", "/api/schedule/mine").status).toBe(405);
    expect(h.call("Ann", "GET", "/api/schedule/propose").status).toBe(405);
    expect(h.call("Ann", "GET", "/api/schedule/pending").body).toEqual({ pending: 0 });
    expect(h.call("Ann", "POST", "/api/schedule/propose", { fixture: F1, slots: [S1] }, true).status).toBe(403);
    expect(h.store.all()).toEqual([]);
  });
  it("writes ride the CSRF guard and the onboarding 428 gate; reads do not", () => {
    for (const p of ["/api/schedule/propose", "/api/schedule/respond"]) {
      expect(isStateChangingApiRequest("POST", p)).toBe(true);
      expect(onboardingGateApplies("POST", p)).toBe(true);
    }
    expect(onboardingGateApplies("GET", "/api/schedule/mine")).toBe(false);
    expect(isStateChangingApiRequest("GET", "/api/schedule/mine")).toBe(false);
  });
  it("GET never writes: the store file is not created by reads", () => {
    h.mine("Ann");
    h.call("Bob", "GET", "/api/schedule/pending");
    expect(existsSync(h.store.path)).toBe(false);
  });
  it("deletion fence: a coach being deleted cannot propose or answer", () => {
    fenceCoachHash(coachKeyHash("Ann"));
    h.deps.isFenced = (c) => c.trim().toLowerCase() === "ann";
    const r = h.propose("Ann", F1, [S1]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/being deleted/);
    // and a write naming the fenced coach from the other side is refused at the store too
    h.deps.isFenced = () => false;
    expect(h.propose("Bob", F1, [S1]).status).toBe(409);
    expect(h.store.all()).toEqual([]);
  });
});

describe("opponent without an account (test or imported data only)", () => {
  it("refuses with plain wording that never says Super FUMBBL; the 409 rule stays", () => {
    expect(OPPONENT_UNLINKED).toBe("This fixture's opponent isn't linked to an account on this site yet. Ask the organiser.");
    expect(OPPONENT_UNLINKED).not.toMatch(/super fumbbl/i);
    // A seat whose coach has no account behind it.
    const coach = h.deps.coach;
    h.deps.coach = (name) => (name.trim().toLowerCase() === "dee" ? undefined : coach(name));
    const r = h.propose("Cat", leagueRef("tabbl", "season-1", "f2"), [S1]);
    expect(r).toEqual({ status: 409, body: { error: OPPONENT_UNLINKED } });
    h.deps.coach = coach;
    // A seat with no coach at all.
    const s = season();
    s.teams = s.teams.map((t) => (t.id === "dwarfs" ? { ...t, coach: "", coachId: "" } as LeagueTeam : t));
    h.leagues.putSeason(s);
    clearScheduleIndex(h.leagues);
    const r2 = h.propose("Cat", leagueRef("tabbl", "season-1", "f2"), [S1]);
    expect(r2.status).toBe(409);
    expect(r2.body.error).toBe(OPPONENT_UNLINKED);
    const view = h.mine("Cat").fixtures.find((f: { ref: string }) => f.ref === leagueRef("tabbl", "season-1", "f2"));
    expect(JSON.stringify(view)).not.toMatch(/super fumbbl/i);
    expect(h.notes).toHaveLength(0);
  });
});

describe("proposal lifecycle on a league fixture", () => {
  it("propose -> the opponent sees it, one notification, pending badge", () => {
    const r = h.propose("Ann", F1, [S2, S1]);
    expect(r.status).toBe(201);
    expect(r.body.proposal).toMatchObject({ fixture: F1, from: "Ann", to: "Bob", status: "pending", mine: true });
    expect(r.body.proposal.slots.map((s: { start: string }) => s.start)).toEqual([S1, S2]);
    expect(r.body.warnings).toEqual([]);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]).toMatchObject({ coach: "Bob", input: { type: "proposal-received", from: "Ann" } });
    expect(h.notes[0]!.input.link).toBe(`/app/schedule?proposal=${r.body.proposal.id}`);
    expect(h.call("Bob", "GET", "/api/schedule/pending").body).toEqual({ pending: 1 });
    expect(h.call("Ann", "GET", "/api/schedule/pending").body).toEqual({ pending: 0 });
    const bob = h.mine("Bob");
    expect(bob.counts).toMatchObject({ toAnswer: 1, waiting: 0 });
    const f1 = bob.fixtures.find((f: { ref: string }) => f.ref === F1);
    expect(f1).toMatchObject({ title: "Round 1 vs Orcs", opponent: { coach: "Ann", timezone: "Europe/London" }, canPropose: true, link: "/leagues/tabbl/seasons/season-1/fixtures/f1/lobby" });
    // the opponent cannot propose over a pending offer: they answer it
    const clash = h.propose("Bob", F1, [S3]);
    expect(clash.status).toBe(409);
    expect(clash.body.proposal).toBe(r.body.proposal.id);
    // the sender's newer times replace their own pending ones (and notify once more)
    const again = h.propose("Ann", F1, [S3]);
    expect(again.status).toBe(201);
    expect(h.store.get(r.body.proposal.id)).toMatchObject({ status: "withdrawn", replacedBy: again.body.proposal.id });
    expect(h.notes).toHaveLength(2);
  });

  it("counter -> a new proposal the other way, the old one countered; accept sets the fixture's time and creates nothing", () => {
    const p1 = h.propose("Ann", F1, [S1]).body.proposal;
    const c = h.respond("Bob", { proposalId: p1.id, action: "counter", slots: [S2, S3] });
    expect(c.status).toBe(201);
    expect(c.body.proposal).toMatchObject({ from: "Bob", to: "Ann", counterOf: p1.id, status: "pending" });
    expect(h.store.get(p1.id)).toMatchObject({ status: "countered", replacedBy: c.body.proposal.id });
    expect(h.notes.map((n) => [n.coach, n.input.type])).toEqual([["Bob", "proposal-received"], ["Ann", "proposal-countered"]]);
    // Bob cannot accept his own counter
    expect(h.respond("Bob", { proposalId: c.body.proposal.id, action: "accept", slot: S2 }).status).toBe(403);
    // a slot that was not offered
    expect(h.respond("Ann", { proposalId: c.body.proposal.id, action: "accept", slot: S1 }).status).toBe(400);
    const before = h.leagues.season("tabbl", "season-1")!;
    const a = h.respond("Ann", { proposalId: c.body.proposal.id, action: "accept", slot: S3 });
    expect(a.status).toBe(200);
    expect(a.body.scheduled).toMatchObject({ start: S3, end: "2026-11-14T17:00:00.000Z" });
    const after = h.leagues.season("tabbl", "season-1")!;
    expect(after.fixtures.map((f) => f.id)).toEqual(before.fixtures.map((f) => f.id)); // no fixture created
    expect(after.fixtures.find((f) => f.id === "f1")!.scheduledTime).toEqual({ start: S3, end: "2026-11-14T17:00:00.000Z", agreedAt: new Date(NOW).toISOString() });
    expect(after.fixtures.find((f) => f.id === "f1")!.home).toEqual(before.fixtures.find((f) => f.id === "f1")!.home);
    expect(h.store.get(c.body.proposal.id)).toMatchObject({ status: "accepted", acceptedSlot: S3 });
    expect(h.notes.at(-1)).toMatchObject({ coach: "Bob", input: { type: "proposal-accepted", from: "Ann" } });
    expect(h.notes).toHaveLength(3); // once per proposal, counter and accept
    // answered twice: refused, no extra notification
    expect(h.respond("Ann", { proposalId: c.body.proposal.id, action: "accept", slot: S2 }).status).toBe(409);
    expect(h.notes).toHaveLength(3);
    // both coaches see it under Scheduled
    expect(h.mine("Bob").fixtures.find((f: { ref: string }) => f.ref === F1).scheduled.start).toBe(S3);
    expect(h.mine("Ann").counts.scheduled).toBe(1);
  });

  it("decline and withdraw (only the right coach), no notification for either", () => {
    const p = h.propose("Ann", F1, [S1]).body.proposal;
    expect(h.respond("Ann", { proposalId: p.id, action: "decline" }).status).toBe(403);
    expect(h.respond("Bob", { proposalId: p.id, action: "decline" }).status).toBe(200);
    expect(h.store.get(p.id)!.status).toBe("declined");
    const q = h.propose("Ann", F1, [S2]).body.proposal;
    expect(h.respond("Bob", { proposalId: q.id, action: "withdraw" }).status).toBe(403);
    expect(h.respond("Ann", { proposalId: q.id, action: "withdraw" }).status).toBe(200);
    expect(h.store.get(q.id)!.status).toBe("withdrawn");
    expect(h.notes.map((n) => n.input.type)).toEqual(["proposal-received", "proposal-received"]);
    expect(h.respond("Bob", { proposalId: q.id, action: "nope" }).status).toBe(400);
  });

  it("expire: once every slot has started the proposal reads expired and cannot be accepted", () => {
    const p = h.propose("Ann", F1, [S1]).body.proposal;
    h.now.t = Date.parse(S1) + 60_000;
    expect(h.mine("Bob").proposals.find((x: { id: string }) => x.id === p.id).status).toBe("expired");
    expect(h.call("Bob", "GET", "/api/schedule/pending").body).toEqual({ pending: 0 });
    const r = h.respond("Bob", { proposalId: p.id, action: "accept", slot: S1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/passed/);
    // a new proposal is allowed again (the expired one no longer blocks)
    expect(h.propose("Bob", F1, ["2026-11-20T18:00:00.000Z"]).status).toBe(201);
    // settled rows are pruned after the keep window on the next write
    h.now.t += KEEP_SETTLED_MS + H;
    expect(h.propose("Cat", F3, ["2027-01-20T18:00:00.000Z"]).body).toMatchObject({ proposal: { from: "Cat" } });
    expect(h.store.get(p.id)).toBeUndefined();
  });

  it("validates slots: 1-3, future, distinct, not overlapping", () => {
    expect(h.propose("Ann", F1, []).status).toBe(400);
    expect(h.propose("Ann", F1, [S1, S2, S3, "2026-11-15T18:00:00Z"]).status).toBe(400);
    expect(h.propose("Ann", F1, [at(-1)]).status).toBe(400);
    expect(h.propose("Ann", F1, [S1, "2026-11-12T19:00:00Z"]).status).toBe(400);
    expect(h.propose("Ann", F1, [at(24 * 400)]).status).toBe(400);
    expect(h.store.all()).toEqual([]);
  });
});

describe("who may propose", () => {
  it("non-participants are refused; a played fixture is closed; an unknown one is 404", () => {
    expect(h.propose("Cat", F1, [S1]).status).toBe(403);
    expect(h.propose("Ann", leagueRef("tabbl", "season-1", "played"), [S1]).status).toBe(409);
    expect(h.propose("Ann", "league:tabbl:season-1:nope", [S1]).status).toBe(409);
    expect(h.propose("Ann", "bogus", [S1]).status).toBe(400);
    const p = h.propose("Ann", F1, [S1]).body.proposal;
    // another coach cannot see or answer it
    expect(h.respond("Cat", { proposalId: p.id, action: "accept", slot: S1 }).status).toBe(404);
    expect(h.mine("Cat").proposals).toEqual([]);
  });

  it("blocked coaches cannot propose to each other (either direction); the view hides the opponent's schedule", () => {
    h.social.block("Bob", "Ann");
    const r = h.propose("Ann", F1, [S1]);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe(NOT_ACCEPTING);
    const bobView = h.mine("Bob").fixtures.find((f: { ref: string }) => f.ref === F1);
    expect(bobView.canPropose).toBe(false);
    expect(bobView.reason).toBe(YOU_BLOCKED);
    expect(bobView.opponent).toEqual({ coach: "Ann" });
    expect(h.propose("Bob", F1, [S1]).body.error).toBe(YOU_BLOCKED);
    expect(h.store.all()).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it("a block placed after a proposal stops accept and counter; decline still works", () => {
    const p = h.propose("Ann", F1, [S1]).body.proposal;
    h.social.block("Ann", "Bob");
    expect(h.respond("Bob", { proposalId: p.id, action: "accept", slot: S1 }).status).toBe(403);
    expect(h.respond("Bob", { proposalId: p.id, action: "counter", slots: [S2] }).status).toBe(403);
    expect(h.respond("Bob", { proposalId: p.id, action: "decline" }).status).toBe(200);
    expect(h.leagues.season("tabbl", "season-1")!.fixtures.find((f) => f.id === "f1")!.scheduledTime).toBeUndefined();
  });
});

describe("Sol review: seat keys, dropped entrants, shared seats", () => {
  it("coach accounts use the identity store's exact key: 'Dee Dee' never acts for 'Dee  Dee'", () => {
    const s = h.leagues.season("tabbl", "season-1")!;
    s.teams = s.teams.map((t) => (t.id === "dwarfs" ? { ...t, coach: "Dee  Dee", coachId: "Dee  Dee" } : t));
    h.leagues.putSeason(s);
    const F2 = leagueRef("tabbl", "season-1", "f2");
    expect(h.deps.fixtures.forCoach("Dee Dee").map((e) => e.ref)).toEqual([]);
    expect(h.deps.fixtures.forCoach("dee  dee").map((e) => e.ref)).toEqual([F2]);
    h.deps.coach = (name) => [...ACCOUNTS, "Dee Dee", "Dee  Dee"].find((a) => a.toLowerCase() === name.trim().toLowerCase());
    expect(h.propose("Dee Dee", F2, [S1]).status).toBe(403);
    expect(h.propose("Dee  Dee", F2, [S1]).status).toBe(201);
  });

  it("a dropped tournament entrant loses the match: not listed, propose refused, a pending accept refused", () => {
    const p = h.propose("Ann", M1, [S1]).body.proposal;
    const snap = h.tournaments.snapshot();
    (snap.entrants.e2 as { droppedAt?: string }).droppedAt = at(0);
    h.tournaments.writeSnapshot(snap);
    expect(h.mine("Eve").fixtures).toEqual([]);
    expect(h.mine("Ann").fixtures.map((f: { ref: string }) => f.ref)).not.toContain(M1);
    expect(h.respond("Eve", { proposalId: p.id, action: "accept", slot: S1 }).status).toBe(409);
    expect(h.propose("Ann", M1, [S2]).status).toBe(409);
    expect(h.tournaments.snapshot().scheduledMatches.m1!.scheduledTime).toBeUndefined();
    // and setTime refuses directly, too
    expect(() => h.deps.fixtures.setTime(M1, { start: S1, end: S2, agreedAt: at(0) })).toThrow();
  });

  it("the sender's own seat must be held by exactly one account (same rule as the opponent's)", () => {
    const entry = { ...h.deps.fixtures.byRef(F1)! };
    entry.sides = { home: { ...entry.sides.home, owners: ["ann", "zed"] }, away: entry.sides.away };
    const real = h.deps.fixtures;
    h.deps.fixtures = { ...real, byRef: (r) => (r === F1 ? entry : real.byRef(r)), forCoach: (c) => real.forCoach(c).map((e) => (e.ref === F1 ? entry : e)) };
    const r = h.propose("Ann", F1, [S1]);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/More than one account/);
    expect(h.mine("Ann").fixtures.find((f: { ref: string }) => f.ref === F1)).toMatchObject({ canPropose: false });
    // Bob's opposing seat is ambiguous from his side too
    expect(h.propose("Bob", F1, [S1]).status).toBe(409);
    expect(h.store.all()).toEqual([]);
  });

  it("quarter-hour starts are accepted", () => {
    expect(h.propose("Ann", F1, ["2026-11-12T18:45:00.000Z"]).status).toBe(201);
  });
});

describe("timezone checks and conflict suppression", () => {
  it("warns about unsocial hours in the opponent's zone and a missing zone, but still sends", () => {
    h.zones.set("bob", { timezone: "Asia/Tokyo", availability: [] });
    const r = h.propose("Ann", F1, [S1]);
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: { code: string }) => w.code)).toEqual(["unsocial"]);
    h.zones.delete("ann");
    const c = h.respond("Bob", { proposalId: r.body.proposal.id, action: "counter", slots: [S2] });
    expect(c.status).toBe(201);
    expect(c.body.warnings.map((w: { code: string }) => w.code)).toEqual(["no-timezone"]);
    expect(h.mine("Bob").fixtures.find((f: { ref: string }) => f.ref === F1).opponent.timezone).toBeNull();
  });

  it("warns about slots after the fixture's deadline (organisers' rules apply) and still sends", () => {
    const r = h.propose("Ann", F1, [at(24 * 6)]);
    expect(r.status).toBe(201);
    expect(r.body.warnings.map((w: { code: string }) => w.code)).toContain("after-deadline");
  });

  it("a slot clashing with a confirmed game of either coach is refused; busy slots are listed for the opponent", () => {
    // Ann and Cat agree f3 at S1
    const p = h.propose("Cat", F3, [S1]).body.proposal;
    expect(h.respond("Ann", { proposalId: p.id, action: "accept", slot: S1 }).status).toBe(200);
    // Bob proposing f1 at an overlapping time: Ann (his opponent) is busy
    const clash = h.propose("Bob", F1, ["2026-11-12T19:00:00.000Z"]);
    expect(clash.status).toBe(409);
    expect(clash.body.conflicts).toEqual(["2026-11-12T19:00:00.000Z"]);
    // touching ends are fine
    expect(h.propose("Bob", F1, ["2026-11-12T20:00:00.000Z"]).status).toBe(201);
    const f1 = h.mine("Bob").fixtures.find((f: { ref: string }) => f.ref === F1);
    expect(f1.opponent.busy).toEqual([{ start: S1, end: "2026-11-12T20:00:00.000Z" }]);
    // rescheduling the same fixture does not clash with itself
    // (and pending offers on other fixtures never block: they are tentative)
    expect(h.propose("Ann", F3, ["2026-11-12T19:00:00.000Z"]).status).toBe(201);
  });
});

describe("tournament scheduled matches", () => {
  it("propose + accept writes the agreed time onto the match: no new match, revision unchanged", () => {
    h.zones.set("eve", { timezone: "America/New_York", availability: [] });
    const p = h.propose("Ann", M1, [S1]).body.proposal;
    expect(p).toMatchObject({ from: "Ann", to: "Eve" });
    expect(h.mine("Eve").fixtures[0]).toMatchObject({ ref: M1, kind: "tournament", title: "Round 1 vs Ann's Orcs", competition: "Autumn Open", link: "/tournaments/t1/fixtures/m1/lobby" });
    expect(h.respond("Eve", { proposalId: p.id, action: "accept", slot: S1 }).status).toBe(200);
    const snap = h.tournaments.snapshot();
    expect(Object.keys(snap.scheduledMatches)).toEqual(["m1"]);
    expect(snap.scheduledMatches.m1!.revision).toBe(3);
    expect(snap.scheduledMatches.m1!.scheduledTime).toMatchObject({ start: S1, end: "2026-11-12T20:00:00.000Z" });
    expect(h.notes.map((n) => [n.coach, n.input.type])).toEqual([["Eve", "proposal-received"], ["Ann", "proposal-accepted"]]);
  });
  it("a completed match is closed", () => {
    const snap = h.tournaments.snapshot();
    snap.scheduledMatches.m1!.status = "completed";
    h.tournaments.writeSnapshot(snap);
    expect(h.propose("Ann", M1, [S1]).status).toBe(409);
  });
});

describe("store", () => {
  it("reads strictly: a corrupt file fails closed (500), never as 'no proposals'", () => {
    h.propose("Ann", F1, [S1]);
    writeFileSync(h.store.path, "{ not json");
    expect(h.call("Bob", "GET", "/api/schedule/pending").status).toBe(500);
    expect(h.propose("Ann", F1, [S2]).status).toBe(500);
  });
});

describe("privacy", () => {
  const prevIdentities = process.env.IDENTITIES_FILE;
  afterEach(() => {
    if (prevIdentities === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prevIdentities;
    setResultCoachFilter(undefined);
    setNafIdFilter(undefined);
    setReplayCoachFilter(undefined);
  });

  it("the proposals store has a collector, an inventory row and a delete step", () => {
    expect(KNOWN_STORES as readonly string[]).toContain("schedule-proposals");
    const c = STORE_COLLECTORS.find((x) => x.id === "schedule-proposals")!;
    expect(c.location).toBe("FORK_STATE_DIR/schedule/proposals.json");
    expect(c.erase).toEqual(["schedule-proposals", "final-sweep"]);
    expect(INVENTORY_ROWS["schedule-proposals"]).toEqual(["schedule-proposals"]);
    expect(INVENTORY.some((r) => r.id === "schedule-proposals")).toBe(true);
    expect(DELETE_STEPS.some((s) => s.id === "schedule-proposals")).toBe(true);
  });

  it("export carries the coach's proposals only; delete removes every proposal naming them", async () => {
    const root = mkdtempSync(join(tmpdir(), "schedule-privacy-"));
    roots.push(root);
    process.env.IDENTITIES_FILE = join(root, "identities.json");
    await seed(root);
    const deps = depsFor(root);
    const store = new ProposalStore(deps.stateDir);
    store.mutate((list, ctx) => {
      list.push({ id: ctx.newId(), fixture: F1, from: "Alice", to: "Bob", slots: [S1], status: "pending", createdAt: at(0) });
      list.push({ id: ctx.newId(), fixture: F3, from: "Bob", to: "Carol", slots: [S2], status: "pending", createdAt: at(0) });
    }, NOW);
    const files = new Map((await collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const mine = JSON.parse(files.get("game-proposals.json")!);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: "Alice", to: "Bob" });
    expect(files.get("game-proposals.json")).not.toContain("Carol");
    expect(files.get("README.txt")).toMatch(/game-proposals\.json/);
    expect((await new PrivacyService(deps).deleteCoach("Alice", "Alice", "self")).pending).toEqual([]);
    const left = JSON.parse(readFileSync(store.path, "utf8")).proposals;
    expect(left.map((p: { from: string; to: string }) => [p.from, p.to])).toEqual([["Bob", "Carol"]]);
    expect(readFileSync(store.path, "utf8")).not.toMatch(/Alice/);
  });
});
