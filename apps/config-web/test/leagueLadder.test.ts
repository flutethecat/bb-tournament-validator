import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Roster } from "@bb/validator";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import { leaguePackageName } from "../src/leagueBuilderMarker.js";
import type { LeagueTeamSheet } from "../src/leagues/registrationApi.js";
import type { NotificationInput } from "../src/notifications.js";
import type { LeagueFixture, LeagueRecord, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import {
  challengeState, declineLosses, defaultLadderSettings, ladderRanking, ladderRedraftRules, ladderTeamGamesSinceRedraft, parseLadderSettings, replayLadder, supersededTeams,
} from "../src/leagues/ladder.js";
import { runLadderJob } from "../src/leagues/ladderJob.js";
import { createFixtureSource } from "../src/schedule/fixtures.js";
import { applyForkResult } from "../src/leagues/forkResult.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { requireSession } from "../src/auth/requireSession.js";
import { DiscordObserver } from "../src/discord/observer.js";
import { DiscordStateStore } from "../src/discord/store.js";
import { TournamentStore } from "../src/tournaments/store.js";
import { ladderTarget, seasonTarget } from "../src/discord/targets.js";
import { discordApi, discordApiPath } from "../src/discord/api.js";
import type { DiscordPayload } from "../src/leagues/discord.js";
import { gateScheduleSource } from "../src/leagues/leagueEvents.js";
import { WORDS_ROT13 } from "../src/discord/profanityList.js";
import { ACTION_DM, actionDmText } from "../src/mail/actionMessages.js";
import { generateBlocker, syncLeagueForkResults } from "../src/leagues/forkPlay.js";
import { leagueLobbyFixture } from "../src/fixtureLobby/league.js";
import { leagueFixtureView, recordLeagueFixture } from "../src/leagues/tabletopFixtures.js";
import { fixturePlayBlock } from "../src/leagues/playBlock.js";
import { resolveLeaguePackage } from "../src/leagues/leagueBuilder.js";
import { postTo } from "../src/discord/targets.js";
import { suggestForfeit } from "../src/forfeit/rules.js";
import type { IncomingMessage } from "node:http";
import { onboardingGateApplies } from "../src/auth/onboarding.js";

// Lane 8b (spec-league-ladder-2026-11-02): league ladders. Creation (wizard) and visibility (setup hidden), joining through the
// ladder adapter of the registration core (validated teams auto-approved, pre-existing teams and moves need an organiser,
// moves only with nothing open, progression kept), the three ranking methods, the challenge lifecycle (issue / accept /
// decline / 48 h expiry / deadline discard, the limits, the decline rule, the scheduling hand-off), scheduled rounds, results
// feeding progression but a separate ladder ranking, Discord, the redraft hook, the gates hook, the calendar read, access
// control, CSRF, and GETs that never write. Each test has its own state dir (laws §C14); every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const ROOT: LeagueApiIdentity = { coach: "Root", admin: true };
const OTTO: LeagueApiIdentity = { coach: "Otto", admin: false, organizer: true };
const coach = (name: string): LeagueApiIdentity => ({ coach: name, admin: false });
const L = "rivertown";
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const H = 3_600_000;
const rot13 = (v: string): string => v.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c === c.toLowerCase() ? 97 : 65)));
const LISTED = rot13(WORDS_ROT13[1]!);
const D = 24 * H;

function rosterOf(race: string, players = 11, cost = 50_000): Roster {
  return {
    rosterName: race, coach: "anyone", teamName: "T",
    sideline: { apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, reRolls: 2 },
    inducements: [], leagues: [], specialRules: [],
    players: Array.from({ length: players }, (_, i) => ({ number: i + 1, positionName: "Lineman", MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+", skills: [], keywords: [], cost })),
    summary: { playersCost: players * cost, skillsCost: 0, inducementCost: 0, sidelineCost: 120_000, total: players * cost + 120_000 },
  } as Roster;
}

/** Fake team check: "new-*" saves are built in league mode for the package asked; "old-*" saves are pre-existing teams. */
function sheetFor(coachName: string, ref: string, packageName: string): LeagueTeamSheet | { error: string; status?: number } {
  const race = /orc/i.test(ref) ? "Orc" : /human/i.test(ref) ? "Human" : "Dwarf";
  if (ref === "save:bad-orc") return { teamName: `${coachName} Bad`, savePackage: packageName, validation: { ok: false, problems: ["Too many big guys."] }, roster: rosterOf("Orc") };
  if (ref.startsWith("save:new-")) return { teamName: `${coachName} ${race}s`, savePackage: packageName, validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  if (ref.startsWith("save:old-")) return { teamName: `${coachName} Old ${race}s`, savePackage: "Spike 2026", validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  return { error: "Team Builder save not found.", status: 404 };
}

function team(id: string, coachName: string, extra: Partial<LeagueTeam> = {}): LeagueTeam {
  return {
    id, name: `${coachName}'s ${id}`, race: "Human", coach: coachName, coachId: coachName, coachAssigned: { by: "Olga", at: "2026-10-01T00:00:00.000Z" },
    teamValue: 1_000_000, treasury: 50_000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "", raceLeague: "",
    players: Array.from({ length: 11 }, (_, i) => ({
      playerId: `p-${id}-${i}`, number: i + 1, name: `P${i}`, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: i === 0 ? ["Block"] : [], value: 50_000,
      level: i === 0 ? "Experienced" : "Rookie", availableSpp: i === 0 ? 6 : 0, niggling: 0, missNextGame: false,
      stats: { td: i === 0 ? 3 : 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: i === 0 ? 9 : 0, performance: 0 },
    })),
    formerPlayers: [], teamUid: `tm-${id}`, entryId: `en-${id}`, ...extra,
  };
}

interface Sent { coach: string; input: NotificationInput }

function harness(opts: { clock?: string; league?: Partial<LeagueRecord> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bbtv-ladder-"));
  roots.push(root);
  const store = new LeagueStore(root);
  const clock = { now: new Date(opts.clock ?? "2026-11-10T12:00:00.000Z") };
  const sent: Sent[] = [];
  store.upsertLeague({ id: L, name: "Rivertown", fullName: "Rivertown BBL", slug: L, organisers: ["Olga"], owner: "Olga", playOnFork: true, rulesetPackage: "EuroBowl 2026",
    houseRules: { maxStatIncreasesTeam: 4 } as never, ...(opts.league ?? {}) } as never);
  store.upsertLeague({ id: "otherbbl", name: "Other BBL", fullName: "Other BBL", slug: "otherbbl", organisers: ["Otto"], owner: "Otto" } as never);
  const season: SeasonRecord = {
    id: "season-1", leagueId: L, number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active", stage: "active",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [team("t-amy", "Amy"), team("t-bob", "Bob")], honours: [], awards: [], unattributedStats: [],
    importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
    rules: { teamBuilding: { rosters: [{ roster: "Human", tier: 2, treasury: 1100, startingSkills: { primary: 1, secondary: 0, elite: 0 } }], eliteSkills: ["Block"] } },
  };
  store.putSeason(season);
  const deps = (body: unknown): LeagueApiDeps => ({
    store,
    readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))),
    now: () => clock.now,
    identities: () => [{ coach: "Olga", level: "organizer" }, { coach: "Root", level: "admin" }, { coach: "Otto", level: "organizer" }],
    notify: (c, input) => { sent.push({ coach: c, input }); },
    leagueTeamSheet: (c, ref, pkg) => sheetFor(c, ref, pkg),
    registrationSharing: { acknowledge: () => undefined, contacts: (_v, entries) => entries.map(() => undefined) },
    packageExists: (name) => name === "EuroBowl 2026" || name === "Spike 2026",
  });
  const call = async (method: string, path: string, auth?: LeagueApiIdentity, body?: unknown): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps(body));
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const ladderOf = (id = "ladder-1") => store.season(L, id)!;
  /** A ladder created through the routes, set up and started. */
  const openLadder = async (ranking: "rating" | "points" | "position" = "position", settings: Record<string, unknown> = {}) => {
    const created = await call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: `Spring ${ranking}`, ranking });
    expect(created.status).toBe(201);
    const id = (created.body as { id: string }).id;
    if (Object.keys(settings).length) {
      const p = await call("PATCH", `/api/leagues/${L}/ladders/${id}`, OLGA, { revision: ladderOf(id).revision, settings });
      expect(p.status, JSON.stringify(p.body)).toBe(200);
    }
    expect((await call("POST", `/api/leagues/${L}/ladders/${id}/start`, OLGA, {})).status).toBe(200);
    return id;
  };
  /** Seeds members straight into the record (ranking and challenge tests), oldest first = top of a position ladder. */
  const seedMembers = (id: string, coaches: string[], joined = "2026-11-01T00:00:00.000Z") => {
    const lad = ladderOf(id);
    for (const [i, c] of coaches.entries()) {
      const t = team(`t-${c.toLowerCase()}-l`, c);
      lad.teams.push(t);
      lad.ladder!.members.push({ teamId: t.id, joinedAt: new Date(Date.parse(joined) + i * 1000).toISOString(), via: "organiser" });
    }
    store.putSeason(lad);
  };
  const result = (id: string, home: string, away: string, hs: number, as: number, at: string, extra: Partial<LeagueFixture> = {}) => {
    const lad = ladderOf(id);
    const t = (c: string) => lad.teams.find((x) => x.coach === c)!;
    const side = (x: LeagueTeam, score: number) => ({ team: x.name, teamId: x.id, coach: x.coach, coachId: x.coachId, race: x.race, score, cas: 0, conceded: false });
    const f: LeagueFixture = { id: `f-${lad.fixtures.length + 1}`, category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(t(home), hs), away: side(t(away), as), suspended: false, finishedAt: at, ...extra };
    lad.fixtures.push(f);
    store.putSeason(lad);
    return f;
  };
  return { store, clock, sent, call, deps, ladderOf, openLadder, seedMembers, result, root };
}

const order = (rows: Array<{ coach: string }>) => rows.map((r) => r.coach);

// ---------------------------------------------------------------------------------------------------------------------------

describe("creation and visibility", () => {
  it("organisers create a ladder (wizard steps, revision-checked); it copies the season's rules and stays hidden until started", async () => {
    const h = harness();
    expect((await h.call("POST", `/api/leagues/${L}/ladders`, undefined, { name: "Spring" })).status).toBe(401);
    expect((await h.call("POST", `/api/leagues/${L}/ladders`, coach("Amy"), { name: "Spring" })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders`, OTTO, { name: "Spring" })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "" })).status).toBe(400);
    const created = await h.call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Spring Ladder" });
    expect(created.status).toBe(201);
    expect((created.body as { id: string }).id).toBe("ladder-1");
    const lad = h.ladderOf();
    expect(lad.competition).toBe("ladder");
    expect(lad.stage).toBe("setup");
    // Copied from the current season / league (spec Q6) and editable.
    expect(lad.rules?.teamBuilding?.rosters[0]?.treasury).toBe(1100);
    expect(lad.ladder!.rulesetPackage).toBe("EuroBowl 2026");
    expect(lad.ladder!.playOnFork).toBe(true);
    expect(lad.ladder!.houseRules?.maxStatIncreasesTeam).toBe(4);
    expect(lad.ladder!.settings.ranking).toBe("position");
    expect(lad.ladder!.settings.declineRule).toEqual({ enabled: true, count: 3, days: 14 });
    expect(lad.ladder!.settings.challengeRange).toBe(3);
    // Hidden while in setup: the public list, the read, the season read path, the join facts.
    for (const who of [undefined, coach("Amy"), OTTO]) {
      expect(((await h.call("GET", `/api/leagues/${L}/ladders`, who)).body as { ladders: unknown[] }).ladders).toHaveLength(0);
      expect((await h.call("GET", `/api/leagues/${L}/ladders/ladder-1`, who)).status).toBe(404);
      expect((await h.call("GET", `/api/leagues/${L}/seasons/ladder-1`, who)).status).toBe(404);
      expect((await h.call("GET", `/api/leagues/${L}/ladders/ladder-1/join`, who)).status).toBe(404);
    }
    expect(((await h.call("GET", `/api/leagues/${L}/ladders`, OLGA)).body as { ladders: unknown[] }).ladders).toHaveLength(1);
    expect(((await h.call("GET", `/api/leagues/${L}/ladders`, ROOT)).body as { ladders: unknown[] }).ladders).toHaveLength(1);
    // A ladder is not a season: the league summary and the season list leave it out.
    const summary = (await h.call("GET", `/api/leagues/${L}`)).body as { league: { seasonCount: number }; seasons: Array<{ id: string }> };
    expect(summary.league.seasonCount).toBe(1);
    expect(summary.seasons.map((s) => s.id)).toEqual(["season-1"]);
    // Wizard: General -> Rules -> Ladder settings -> Review, revision-checked.
    const base = `/api/leagues/${L}/ladders/ladder-1`;
    expect((await h.call("PATCH", base, OLGA, { general: { name: "X" } })).status).toBe(428);
    expect((await h.call("PATCH", base, OLGA, { revision: 999, general: { name: "X" } })).status).toBe(409);
    let rev = h.ladderOf().revision;
    const g = await h.call("PATCH", base, OLGA, { revision: rev, step: 2, general: { name: "Spring Ladder", description: "Open all spring.", playOnFork: false } });
    expect(g.status).toBe(200);
    rev = h.ladderOf().revision;
    expect((await h.call("PATCH", base, OLGA, { revision: rev, rules: { rulesetPackage: "Nope" } })).status).toBe(400);
    const r = await h.call("PATCH", base, OLGA, { revision: rev, step: 3, rules: { rulesetPackage: null, houseRules: { maxStatIncreasesTeam: 2 } } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    rev = h.ladderOf().revision;
    expect((await h.call("PATCH", base, OLGA, { revision: rev, settings: { ranking: "elo" } })).status).toBe(400);
    expect((await h.call("PATCH", base, OLGA, { revision: rev, settings: { bogus: 1 } })).status).toBe(400);
    const s = await h.call("PATCH", base, OLGA, { revision: rev, step: 4, settings: { ranking: "rating", minGames: 5, playByDays: 10, autoApproveValidated: false, style: "tournament", endsAt: "2027-03-01T00:00:00.000Z" } });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    rev = h.ladderOf().revision;
    expect((await h.call("PATCH", base, OLGA, { revision: rev, complete: true })).status).toBe(200);
    const stored = h.ladderOf();
    expect(stored.name).toBe("Spring Ladder");
    expect(stored.ladder!.description).toBe("Open all spring.");
    expect(stored.ladder!.playOnFork).toBe(false);
    expect(stored.ladder!.rulesetPackage).toBeUndefined();
    expect(stored.ladder!.houseRules?.maxStatIncreasesTeam).toBe(2);
    expect(stored.ladder!.settings).toMatchObject({ ranking: "rating", minGames: 5, playByDays: 10, autoApproveValidated: false, style: "tournament", endsAt: "2027-03-01T00:00:00.000Z" });
    expect(stored.ladder!.wizard?.completedAt).toBeTruthy();
    // Season-only routes are not there for a ladder id.
    for (const p of ["join", "registrations", "registration"]) expect((await h.call("GET", `/api/leagues/${L}/seasons/ladder-1/${p}`, OLGA)).status).toBe(404);
    expect((await h.call("POST", `/api/leagues/${L}/seasons/ladder-1/stage`, OLGA, { stage: "active" })).status).toBe(404);
    expect((await h.call("POST", `/api/leagues/${L}/seasons/ladder-1/finish`, OLGA, {})).status).toBe(404);
    // Start: everyone sees it.
    expect((await h.call("POST", `${base}/start`, coach("Amy"), {})).status).toBe(404); // a ladder in setup is not there for them
    expect((await h.call("POST", `${base}/start`, OLGA, {})).status).toBe(200);
    expect((await h.call("POST", `${base}/start`, OLGA, {})).status).toBe(409);
    const pub = (await h.call("GET", `/api/leagues/${L}/ladders`)).body as { ladders: Array<{ id: string; state: string; ranking: string }> };
    expect(pub.ladders).toEqual([expect.objectContaining({ id: "ladder-1", state: "active", ranking: "rating" })]);
    const read = (await h.call("GET", base)).body as { ladder: { settings: { redraft: { rules?: unknown } } } };
    expect(read.ladder.settings.redraft.rules).toBeUndefined();
    // The ladder's own record never rides on the season read.
    expect(JSON.stringify((await h.call("GET", `/api/leagues/${L}/seasons/ladder-1`)).body)).not.toContain("\"members\"");
  });

  it("a draft league's ladders are not there for anyone but its organisers; another league's organiser gets 403 on writes", async () => {
    const h = harness({ league: { visibility: "draft" } });
    expect((await h.call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Draft ladder" })).status).toBe(201);
    expect((await h.call("GET", `/api/leagues/${L}/ladders`, coach("Amy"))).status).toBe(404);
    expect((await h.call("POST", `/api/leagues/otherbbl/ladders`, OLGA, { name: "Not mine" })).status).toBe(403);
  });
});

describe("joining through the ladder adapter", () => {
  it("a team built and validated for the ladder joins straight away (auto-approve, default on); the organisers get the validator note", async () => {
    const h = harness();
    const id = await h.openLadder();
    const base = `/api/leagues/${L}/ladders/${id}`;
    const facts = (await h.call("GET", `${base}/join`, coach("Cara"))).body as { status: { open: boolean; packageName: string; autoApprove: boolean } };
    expect(facts.status).toMatchObject({ open: true, autoApprove: true, packageName: leaguePackageName(L, id) });
    expect((await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-orc", share: [], acknowledged: false })).status).toBe(400);
    expect((await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:bad-orc", share: [], acknowledged: true })).status).toBe(400);
    const joined = await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-orc", share: [], acknowledged: true });
    expect(joined.status, JSON.stringify(joined.body)).toBe(201);
    expect((joined.body as { registration: { state: string; teamId: string } }).registration.state).toBe("accepted");
    const lad = h.ladderOf(id);
    // The team and the member are one write with the acceptance.
    expect(lad.teams).toHaveLength(1);
    expect(lad.ladder!.members).toEqual([expect.objectContaining({ teamId: lad.teams[0]!.id, via: "validator" })]);
    const toOrg = h.sent.filter((s) => s.coach === "Olga" && s.input.type === "registration");
    expect(toOrg.at(-1)!.input.title).toContain("approved through the validator");
    expect((await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-human", share: [], acknowledged: true })).status).toBe(409);
    // The ranking now lists the team.
    const view = (await h.call("GET", base)).body as { ranking: Array<{ teamId: string }> };
    expect(view.ranking.map((r) => r.teamId)).toEqual([lad.teams[0]!.id]);
  });

  it("with auto-approve off, and for a pre-existing team, the entry waits for an organiser who sees TV, games and redraft status", async () => {
    const h = harness();
    const id = await h.openLadder("points", { autoApproveValidated: false });
    const base = `/api/leagues/${L}/ladders/${id}`;
    const a = await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-orc", share: [], acknowledged: true });
    expect((a.body as { registration: { state: string } }).registration.state).toBe("pending");
    const b = await h.call("POST", `${base}/registrations`, coach("Dan"), { teamRef: "save:old-dwarf", share: [], acknowledged: true });
    expect((b.body as { registration: { state: string } }).registration.state).toBe("pending");
    expect(h.ladderOf(id).teams).toHaveLength(0);
    expect((await h.call("GET", `${base}/registrations`, coach("Cara"))).status).toBe(403);
    expect((await h.call("GET", `${base}/registrations`)).status).toBe(401);
    const list = (await h.call("GET", `${base}/registrations`, OLGA)).body as { entries: Array<{ id: string; coachId: string; state: string; kind: string; review?: Record<string, unknown> }> };
    const dan = list.entries.find((e) => e.coachId === "Dan")!;
    expect(dan.kind).toBe("existing");
    expect(dan.review).toMatchObject({ from: "Outside this league", redraft: "Not drafted in this league" });
    expect(typeof dan.review!.teamValue).toBe("number");
    const cara = list.entries.find((e) => e.coachId === "Cara")!;
    expect((await h.call("POST", `${base}/registrations/${cara.id}/accept`, coach("Cara"), {})).status).toBe(403);
    const ok = await h.call("POST", `${base}/registrations/${cara.id}/accept`, OLGA, {});
    expect(ok.status).toBe(200);
    expect(h.ladderOf(id).ladder!.members).toEqual([expect.objectContaining({ via: "organiser" })]);
    expect((await h.call("POST", `${base}/registrations/${dan.id}/decline`, OLGA, { reason: "Redraft first." })).status).toBe(200);
    const mine = (await h.call("GET", `${base}/join`, coach("Dan"))).body as { mine: { state: string; reason: string } };
    expect(mine.mine).toMatchObject({ state: "declined", reason: "Redraft first." });
  });

  it("a league team moves in from a season with its progression, only with nothing open; it then plays in one place only", async () => {
    const h = harness();
    // Bob's season team has an unplayed fixture: it cannot move yet.
    const s1 = h.store.season(L, "season-1")!;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    s1.fixtures.push({ id: "sf1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, home: side(s1.teams[1]!), away: side(s1.teams[0]!), suspended: false });
    h.store.putSeason(s1);
    const id = await h.openLadder();
    const base = `/api/leagues/${L}/ladders/${id}`;
    const facts = (await h.call("GET", `${base}/join`, coach("Amy"))).body as { movable: Array<{ id: string; teamId: string; blocked?: string; games: number }> };
    expect(facts.movable).toEqual([expect.objectContaining({ id: "season-1", teamId: "t-amy", blocked: expect.stringContaining("unplayed") })]);
    expect((await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true })).status).toBe(409);
    expect((await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-bob" }, share: [], acknowledged: true })).status).toBe(404);
    // The fixture is played: now the move request goes to the organisers (always manual), who see the review facts.
    const s1b = h.store.season(L, "season-1")!;
    s1b.fixtures[0]!.home.score = 1; s1b.fixtures[0]!.away.score = 2; s1b.fixtures[0]!.finishedAt = "2026-11-05T20:00:00.000Z";
    h.store.putSeason(s1b);
    const req = await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true });
    expect(req.status, JSON.stringify(req.body)).toBe(201);
    expect((req.body as { registration: { state: string; moving: boolean } }).registration).toMatchObject({ state: "pending", moving: true });
    const list = (await h.call("GET", `${base}/registrations`, OLGA)).body as { entries: Array<{ id: string; review?: Record<string, unknown> }> };
    expect(list.entries[0]!.review).toMatchObject({ from: "Season 1", redraft: "Never redrafted", teamValue: 1_000_000, gamesPlayed: 1 });
    expect((await h.call("POST", `${base}/registrations/${list.entries[0]!.id}/accept`, OLGA, {})).status).toBe(200);
    const lad = h.ladderOf(id);
    const moved = lad.teams[0]!;
    // Progression moved with it (skills, SPP, level); this competition's counters start at zero; new ids name the old ones.
    expect(moved.movedFrom).toMatchObject({ kind: "season", id: "season-1", teamId: "t-amy" });
    expect(moved.teamUid).toBe("tm-t-amy");
    expect(moved.players[0]).toMatchObject({ skills: ["Block"], availableSpp: 6, level: "Experienced" });
    expect(moved.players[0]!.stats.td).toBe(0);
    expect(moved.players[0]!.previousIds).toEqual(["p-t-amy-0"]);
    expect(moved.players[0]!.playerId).not.toBe("p-t-amy-0");
    expect(lad.ladder!.members[0]!.via).toBe("move");
    // The season row is superseded (derived): not movable again, not offered.
    expect(supersededTeams(h.store.competitions(L)).has("season-1/t-amy")).toBe(true);
    const again = (await h.call("GET", `${base}/join`, coach("Amy"))).body as { movable: unknown[] };
    expect(again.movable).toHaveLength(0);
    // Back to the season (organisers), only with nothing open there either.
    expect((await h.call("POST", `${base}/teams/${moved.id}/move`, coach("Amy"), { seasonId: "season-1" })).status).toBe(403);
    expect((await h.call("POST", `${base}/teams/${moved.id}/move`, OLGA, { seasonId: id })).status).toBe(404);
    const back = await h.call("POST", `${base}/teams/${moved.id}/move`, OLGA, { seasonId: "season-1" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const s1c = h.store.season(L, "season-1")!;
    const returned = s1c.teams.find((t) => t.movedFrom?.id === id)!;
    expect(returned.players[0]!.availableSpp).toBe(6);
    expect(h.ladderOf(id).ladder!.members[0]).toMatchObject({ movedTo: { kind: "season", id: "season-1" } });
    expect((await h.call("GET", base)).body).toMatchObject({ ranking: [] });
    // The entry ended, so the coach may join again later.
    expect(h.ladderOf(id).registrations![0]!.state).toBe("withdrawn");
  });

  it("tournament-style ladders take new teams only and reset the roster after every game (stat counters kept)", async () => {
    const h = harness();
    const id = await h.openLadder("points", { style: "tournament" });
    const base = `/api/leagues/${L}/ladders/${id}`;
    expect((await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true })).status).toBe(400);
    expect((await h.call("POST", `${base}/registrations`, coach("Dan"), { teamRef: "save:old-dwarf", share: [], acknowledged: true })).status).toBe(400);
    expect((await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-orc", share: [], acknowledged: true })).status).toBe(201);
    expect((await h.call("POST", `${base}/registrations`, coach("Eve"), { teamRef: "save:new-human", share: [], acknowledged: true })).status).toBe(201);
    const lad = h.ladderOf(id);
    expect(lad.ladder!.members.every((m) => m.reset)).toBe(true);
    // The snapshot carries no coach data (account deletion anonymises the team rows, not this copy).
    const snap = JSON.stringify(lad.ladder!.members.map((m) => m.reset));
    for (const k of ['"coach"', '"coachId"', '"coachAssigned"', '"history"']) expect(snap).not.toContain(k);
    // A game: the roster gains SPP and a skill; the write that records the result puts the joined roster back (counters kept).
    const t = lad.teams[0]!;
    t.players[0]!.availableSpp = 8; t.players[0]!.skills = ["Dodge"]; t.players[0]!.stats.td = 2; t.treasury = 999_999;
    h.store.putSeason(lad);
    h.result(id, "Cara", "Eve", 2, 0, "2026-11-10T12:30:00.000Z");
    h.clock.now = new Date("2026-11-10T13:00:00.000Z");
    const after = h.ladderOf(id).teams.find((x) => x.id === t.id)!;
    expect(after.players[0]!.availableSpp).toBe(0);
    expect(after.players[0]!.skills).toEqual([]);
    expect(after.players[0]!.stats.td).toBe(2);
    expect(after.treasury).not.toBe(999_999);
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).resets).toHaveLength(0); // nothing left for the job
    // A tournament-style team never moves (its roster resets every game): not offered, refused by the organiser route.
    const s1 = h.store.season(L, "season-1")!;
    expect(((await h.call("POST", `${base}/teams/${t.id}/move`, OLGA, { seasonId: s1.id })).body as { code: string }).code).toBe("tournament-style");
  });
});

describe("ranking methods", () => {
  it("points: W/D/L as set, plus point awards (the titles lane's hook)", async () => {
    const h = harness();
    const id = await h.openLadder("points", { points: { win: 3, draw: 1, loss: 0 } });
    h.seedMembers(id, ["Amy", "Bob", "Cara"]);
    h.result(id, "Bob", "Amy", 2, 1, "2026-11-05T12:00:00.000Z");
    h.result(id, "Cara", "Amy", 1, 1, "2026-11-06T12:00:00.000Z");
    let rows = ladderRanking(h.ladderOf(id), h.clock.now, h.store.competitions(L));
    expect(order(rows)).toEqual(["Bob", "Cara", "Amy"]);
    expect(rows.map((r) => r.points)).toEqual([3, 1, 1]);
    const lad = h.ladderOf(id);
    lad.ladder!.pointAwards = [{ teamId: lad.teams.find((t) => t.coach === "Amy")!.id, points: 5, reason: "Test bonus", at: "2026-11-07T00:00:00.000Z" }];
    h.store.putSeason(lad);
    rows = ladderRanking(h.ladderOf(id), h.clock.now, h.store.competitions(L));
    expect(order(rows)[0]).toBe("Amy");
  });

  it("rating: Glicko per team, unranked until the minimum games; the ladder's ranking is its own", async () => {
    const h = harness();
    const id = await h.openLadder("rating", { minGames: 2 });
    h.seedMembers(id, ["Amy", "Bob", "Cara"]);
    h.result(id, "Amy", "Bob", 2, 0, "2026-11-05T12:00:00.000Z");
    let rows = ladderRanking(h.ladderOf(id), h.clock.now, h.store.competitions(L));
    expect(rows.every((r) => !r.ranked)).toBe(true);
    h.result(id, "Amy", "Cara", 1, 0, "2026-11-06T12:00:00.000Z");
    h.result(id, "Bob", "Cara", 1, 0, "2026-11-07T12:00:00.000Z");
    rows = ladderRanking(h.ladderOf(id), h.clock.now, h.store.competitions(L));
    expect(order(rows)).toEqual(["Amy", "Bob", "Cara"]);
    expect(rows.every((r) => r.ranked)).toBe(true);
    expect(rows[0]!.rating).toBeGreaterThan(rows[1]!.rating);
    expect(rows[1]!.rating).toBeGreaterThan(rows[2]!.rating);
    // The league's season standings know nothing of ladder games.
    expect(h.store.season(L, "season-1")!.fixtures).toHaveLength(0);
  });

  it("position swap: a winning challenger takes the defender's place, the teams between move down; a defender's win changes nothing; the rating column rides along", async () => {
    const h = harness();
    const id = await h.openLadder("position");
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now))).toEqual(["Amy", "Bob", "Cara", "Dan"]);
    h.result(id, "Bob", "Dan", 2, 1, "2026-11-05T12:00:00.000Z"); // the defender (above) wins: no change
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now))).toEqual(["Amy", "Bob", "Cara", "Dan"]);
    h.result(id, "Amy", "Dan", 0, 1, "2026-11-06T12:00:00.000Z"); // Dan (4th) beats Amy (1st): Dan 1st, Amy/Bob/Cara down one
    const rows = ladderRanking(h.ladderOf(id), h.clock.now);
    expect(order(rows)).toEqual(["Dan", "Amy", "Bob", "Cara"]);
    expect(rows.every((r) => typeof r.rating === "number" && r.rating > 0)).toBe(true);
    // A team that joins later starts at the bottom.
    h.seedMembers(id, ["Eve"], "2026-11-07T00:00:00.000Z");
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now)).at(-1)).toBe("Eve");
  });
});

describe("challenges", () => {
  it("issue -> accept goes straight into the time-proposal flow (inbox + DM, the Schedule source offers the fixture)", async () => {
    const h = harness();
    const id = await h.openLadder("position");
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan", "Eve"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    expect((await h.call("POST", `${base}/challenges`, undefined, { challengerTeamId: tid("Dan"), defenderTeamId: tid("Bob") })).status).toBe(401);
    expect((await h.call("POST", `${base}/challenges`, coach("Cara"), { challengerTeamId: tid("Dan"), defenderTeamId: tid("Bob") })).status).toBe(403);
    // Position ladders: only upward, at most 3 places.
    expect(((await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Dan") })).body as { error: string }).error).toContain("above");
    expect(((await h.call("POST", `${base}/challenges`, coach("Eve"), { challengerTeamId: tid("Eve"), defenderTeamId: tid("Amy") })).body as { error: string }).error).toContain("3 places");
    // The Ladder tab tells the coach the same (targets).
    const view = (await h.call("GET", base, coach("Dan"))).body as { me: { targets: Record<string, Record<string, string>> } };
    expect(view.me.targets[tid("Dan")]![tid("Amy")]).toBe("");
    expect(view.me.targets[tid("Dan")]![tid("Eve")]).toContain("above");
    const issued = await h.call("POST", `${base}/challenges`, coach("Dan"), { challengerTeamId: tid("Dan"), defenderTeamId: tid("Amy") });
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const cid = (issued.body as { challenge: { id: string } }).challenge.id;
    const toAmy = h.sent.filter((s) => s.coach === "Amy").at(-1)!.input;
    expect(toAmy).toMatchObject({ type: "ladder", action: true });
    expect(toAmy.body).toContain("48 hours");
    // One per pair.
    expect(((await h.call("POST", `${base}/challenges`, coach("Dan"), { challengerTeamId: tid("Dan"), defenderTeamId: tid("Amy") })).body as { error: string }).error).toContain("already have a challenge");
    // Only the defender answers.
    expect((await h.call("POST", `${base}/challenges/${cid}/accept`, coach("Dan"), {})).status).toBe(403);
    const accepted = await h.call("POST", `${base}/challenges/${cid}/accept`, coach("Amy"), {});
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const fx = (accepted.body as { fixture: { id: string; ref: string; deadline: string } }).fixture;
    expect(fx.ref).toBe(`league:${L}:${id}:${fx.id}`);
    expect(Date.parse(fx.deadline) - h.clock.now.getTime()).toBe(7 * D);
    const lad = h.ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === fx.id)!;
    expect(f).toMatchObject({ home: { teamId: tid("Amy") }, away: { teamId: tid("Dan") }, deadline: fx.deadline, ladder: { challengeId: cid } });
    // Both coaches: an actionable "propose a time" note (Discord DM) that opens the Schedule's propose dialog.
    for (const c of ["Amy", "Dan"]) {
      const n = h.sent.filter((s) => s.coach === c).at(-1)!.input;
      expect(n).toMatchObject({ type: "ladder", action: true, link: `/app/schedule?propose=${encodeURIComponent(fx.ref)}` });
      expect(actionDmText({ record: { type: "ladder", from: "", title: n.title, link: n.link }, action: true, url: `https://example.com${n.link}` })?.plain).toContain("propose a time");
    }
    expect(Object.keys(ACTION_DM)).toContain("ladder");
    const src = createFixtureSource({ leagues: h.store, tournaments: { snapshot: () => ({ scheduledMatches: {}, tournaments: {}, entrants: {} }) } as never, now: () => h.clock.now.getTime() });
    const offered = src.forCoach("Dan").find((e) => e.ref === fx.ref)!;
    expect(offered).toMatchObject({ kind: "league", deadline: fx.deadline });
    expect(offered.competition).toContain(lad.name);
    src.setTime(fx.ref, { start: "2026-11-12T19:00:00.000Z", end: "2026-11-12T21:00:00.000Z", agreedAt: h.clock.now.toISOString() });
    expect(h.ladderOf(id).fixtures.find((x) => x.id === fx.id)!.scheduledTime?.start).toBe("2026-11-12T19:00:00.000Z");
    // The read shows it live with the schedule ref for its coaches.
    const read = (await h.call("GET", base, coach("Dan"))).body as { challenges: { live: Array<{ id: string; state: string; scheduleRef?: string }> } };
    expect(read.challenges.live[0]).toMatchObject({ id: cid, state: "accepted", scheduleRef: fx.ref });
    // Answering twice is refused.
    expect((await h.call("POST", `${base}/challenges/${cid}/decline`, coach("Amy"), {})).status).toBe(409);
  });

  it("limits: max open per coach counts issued and received; the rematch wait; withdraw by the challenger", async () => {
    const h = harness();
    const id = await h.openLadder("points", { maxOpen: 2, rematchDays: 7 });
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const ch = (a: string, b: string) => h.call("POST", `${base}/challenges`, coach(a), { challengerTeamId: tid(a), defenderTeamId: tid(b) });
    expect((await ch("Amy", "Bob")).status).toBe(201);
    expect((await ch("Cara", "Amy")).status).toBe(201);
    // Amy has 2 open (one issued, one received): no more either way.
    expect(((await ch("Amy", "Dan")).body as { error: string }).error).toContain("2 open challenges");
    expect(((await ch("Dan", "Amy")).body as { error: string }).error).toContain("coach already has 2 open");
    const cid = h.ladderOf(id).ladder!.challenges[0]!.id;
    expect((await h.call("POST", `${base}/challenges/${cid}/withdraw`, coach("Bob"), {})).status).toBe(403);
    expect((await h.call("POST", `${base}/challenges/${cid}/withdraw`, coach("Amy"), {})).status).toBe(200);
    expect((await ch("Amy", "Dan")).status).toBe(201);
    // Rematch: Bob and Cara played 2 days ago.
    h.result(id, "Bob", "Cara", 1, 0, new Date(h.clock.now.getTime() - 2 * D).toISOString());
    expect(((await ch("Bob", "Cara")).body as { error: string }).error).toContain("rematch");
  });

  it("expiry after 48 h is derived on read (GET writes nothing) and stored by the job with notes; deadline discards cost nothing", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob", "Cara"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const c1 = ((await h.call("POST", `${base}/challenges`, coach("Amy"), { challengerTeamId: tid("Amy"), defenderTeamId: tid("Bob") })).body as { challenge: { id: string } }).challenge.id;
    const c2 = ((await h.call("POST", `${base}/challenges`, coach("Cara"), { challengerTeamId: tid("Cara"), defenderTeamId: tid("Bob") })).body as { challenge: { id: string } }).challenge.id;
    expect((await h.call("POST", `${base}/challenges/${c2}/accept`, coach("Bob"), {})).status).toBe(200);
    h.clock.now = new Date(h.clock.now.getTime() + 48 * H + 1000);
    const rev = h.ladderOf(id).revision;
    const read = (await h.call("GET", base)).body as { challenges: { closed: Array<{ id: string; state: string }> } };
    expect(read.challenges.closed.find((c) => c.id === c1)!.state).toBe("expired");
    expect(h.ladderOf(id).revision).toBe(rev); // the GET wrote nothing
    expect((await h.call("POST", `${base}/challenges/${c1}/accept`, coach("Bob"), {})).status).toBe(409);
    h.sent.length = 0;
    let out = runLadderJob({ store: h.store, notify: (c, i) => h.sent.push({ coach: c, input: i }), now: () => h.clock.now });
    expect(out.expired).toHaveLength(1);
    expect(h.ladderOf(id).ladder!.challenges.find((c) => c.id === c1)!.state).toBe("expired");
    expect(h.sent.map((s) => s.coach).sort()).toEqual(["Amy", "Bob"]);
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).expired).toHaveLength(0); // once
    // The accepted one is not played by its deadline (7 days): discarded, no result, no penalty.
    h.clock.now = new Date(h.clock.now.getTime() + 6 * D);
    h.sent.length = 0;
    out = runLadderJob({ store: h.store, notify: (c, i) => h.sent.push({ coach: c, input: i }), now: () => h.clock.now });
    expect(out.discarded).toHaveLength(1);
    const lad = h.ladderOf(id);
    const ch2 = lad.ladder!.challenges.find((c) => c.id === c2)!;
    expect(ch2.state).toBe("discarded");
    expect(lad.fixtures.find((f) => f.id === ch2.fixtureId)!.deadlineOutcome).toMatchObject({ outcome: "no-result", auto: true });
    expect(h.sent.map((s) => s.coach).sort()).toEqual(["Bob", "Cara"]);
    expect(h.sent[0]!.input.body).toContain("No penalty");
    const rows = ladderRanking(lad, h.clock.now);
    expect(rows.every((r) => r.played === 0 && r.losses === 0)).toBe(true);
  });

  it("the decline rule (on by default for position ladders): the 3rd decline within 14 days is a loss and a swap; expiries count", async () => {
    const h = harness();
    const id = await h.openLadder("position", { maxOpen: 5, rematchDays: 0 });
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const issue = async (a: string) => ((await h.call("POST", `${base}/challenges`, coach(a), { challengerTeamId: tid(a), defenderTeamId: tid("Amy") })).body as { challenge: { id: string } }).challenge.id;
    const d1 = await issue("Bob");
    expect((await h.call("POST", `${base}/challenges/${d1}/decline`, coach("Amy"), {})).status).toBe(200);
    const d2 = await issue("Cara");
    // The second one expires unanswered (counts as a decline while the rule is on).
    h.clock.now = new Date(h.clock.now.getTime() + 49 * H);
    expect(challengeState(h.ladderOf(id).ladder!.challenges.find((c) => c.id === d2)!, h.ladderOf(id), h.clock.now)).toBe("expired");
    const d3 = await issue("Dan");
    const third = await h.call("POST", `${base}/challenges/${d3}/decline`, coach("Amy"), {});
    expect((third.body as { countedAsLoss?: boolean }).countedAsLoss).toBe(true);
    expect(declineLosses(h.ladderOf(id), h.clock.now)).toEqual([expect.objectContaining({ challengeId: d3, loserTeamId: tid("Amy"), winnerTeamId: tid("Dan") })]);
    const rows = ladderRanking(h.ladderOf(id), h.clock.now);
    expect(order(rows)).toEqual(["Dan", "Amy", "Bob", "Cara"]);
    expect(rows.find((r) => r.coach === "Amy")).toMatchObject({ losses: 1, declineLosses: 1, played: 0 });
    expect(h.sent.some((s) => s.coach === "Amy" && s.input.title.includes("counted as a loss"))).toBe(true);
    // The job does not tell the loss again.
    runLadderJob({ store: h.store, now: () => h.clock.now });
    h.sent.length = 0;
    runLadderJob({ store: h.store, notify: (c, i) => h.sent.push({ coach: c, input: i }), now: () => h.clock.now });
    expect(h.sent.filter((s) => s.input.title.includes("loss"))).toHaveLength(0);
    // Off: no losses.
    const lad = h.ladderOf(id);
    lad.ladder!.settings = parseLadderSettings({ declineRule: { enabled: false } }, lad.ladder!.settings, h.clock.now);
    h.store.putSeason(lad);
    expect(declineLosses(h.ladderOf(id), h.clock.now)).toEqual([]);
  });
});

describe("scheduled rounds, results and the scheduled end", () => {
  it("organisers set a round of scheduled matches; coaches get the propose-a-time note; unplayed games are discarded at the deadline", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const deadline = new Date(h.clock.now.getTime() + 5 * D).toISOString();
    expect((await h.call("POST", `${base}/rounds`, coach("Amy"), { pairs: [] })).status).toBe(403);
    expect((await h.call("POST", `${base}/rounds`, OLGA, { pairs: [{ home: tid("Amy"), away: tid("Bob") }, { home: tid("Amy"), away: tid("Cara") }] })).status).toBe(400);
    expect((await h.call("POST", `${base}/rounds`, OLGA, { pairs: [{ home: tid("Amy"), away: tid("Amy") }] })).status).toBe(400);
    const r = await h.call("POST", `${base}/rounds`, OLGA, { deadline, pairs: [{ home: tid("Amy"), away: tid("Bob") }, { home: tid("Cara"), away: tid("Dan") }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const lad = h.ladderOf(id);
    expect(lad.ladder!.rounds).toEqual([expect.objectContaining({ number: 1, name: "Round 1", deadline })]);
    expect(lad.fixtures.filter((f) => f.ladder?.roundId)).toHaveLength(2);
    expect(lad.fixtures.every((f) => f.deadline === deadline && f.round === 1)).toBe(true);
    expect(h.sent.filter((s) => s.input.type === "ladder" && s.input.action && s.input.link.startsWith("/app/schedule?propose="))).toHaveLength(4);
    const view = (await h.call("GET", base)).body as { rounds: Array<{ fixtures: unknown[] }> };
    expect(view.rounds[0]!.fixtures).toHaveLength(2);
    // One is played, the other not: the job discards it after the deadline.
    const played = h.ladderOf(id);
    played.fixtures[0]!.home.score = 2; played.fixtures[0]!.away.score = 0; played.fixtures[0]!.finishedAt = h.clock.now.toISOString();
    h.store.putSeason(played);
    h.clock.now = new Date(Date.parse(deadline) + 1000);
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).discarded).toHaveLength(1);
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now))[0]).toBe("Amy");
  });

  it("a Super FUMBBL result on a ladder fixture applies league progression and feeds the game index, not the season", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const lad = h.ladderOf(id);
    const [a, b] = lad.teams;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    const f: LeagueFixture = {
      id: "lf-x", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(a!), away: side(b!), suspended: false,
      fork: { status: "scheduled", gameId: "9001", log: [], teams: {
        home: { teamId: a!.id, forkTeamId: "ft-a", coach: "Amy", builtAt: "x", players: a!.players.map((p, i) => ({ forkPlayerId: `fa${i}`, playerId: p.playerId })) },
        away: { teamId: b!.id, forkTeamId: "ft-b", coach: "Bob", builtAt: "x", players: b!.players.map((p, i) => ({ forkPlayerId: `fb${i}`, playerId: p.playerId })) },
      } },
    };
    lad.fixtures.push(f);
    const out = applyForkResult(lad, lad.fixtures.at(-1)!, {
      gameId: "9001", source: "full", playedAt: "2026-11-10T10:00:00.000Z",
      teams: [
        { teamId: "ft-a", score: 2, conceded: false, winnings: 60_000, players: [{ forkPlayerId: "fa1", name: "P1", td: 2, cas: 0, completions: 0, interceptions: 0, mvp: 1, fouls: 0, earnedSpps: 10 }] },
        { teamId: "ft-b", score: 1, conceded: false, winnings: 40_000, players: [] },
      ],
    }, h.clock.now);
    expect(out.applied).toBe(true);
    h.store.putSeason(lad);
    const saved = h.ladderOf(id);
    const amy = saved.teams.find((t) => t.id === a!.id)!;
    expect(amy.players[1]!.stats.td).toBe(2);
    expect(amy.treasury).toBeGreaterThan(50_000);
    // The ladder ranking counts it; site ratings read the fork game itself: the game index knows the ladder fixture.
    expect(ladderRanking(saved, h.clock.now)[0]).toMatchObject({ coach: "Amy", points: 3, played: 1 });
    expect(h.store.forkGame("9001")).toMatchObject({ leagueId: L, seasonId: id, fixtureId: "lf-x" });
    expect(h.store.season(L, "season-1")!.fixtures).toHaveLength(0);
  });

  it("the scheduled end closes the ladder: live challenges and unplayed fixtures are discarded, the ranking freezes", async () => {
    const h = harness();
    const end = new Date(h.clock.now.getTime() + 1 * D).toISOString();
    const id = await h.openLadder("points", { endsAt: end });
    h.seedMembers(id, ["Amy", "Bob"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    await h.call("POST", `${base}/challenges`, coach("Amy"), { challengerTeamId: tid("Amy"), defenderTeamId: tid("Bob") });
    h.clock.now = new Date(Date.parse(end) + 1000);
    expect(((await h.call("GET", base, coach("Amy"))).body as { ladder: { paused: string } }).ladder.paused).toContain("ended");
    const out = runLadderJob({ store: h.store, now: () => h.clock.now });
    expect(out.closed).toEqual([`${L}/${id}`]);
    const lad = h.ladderOf(id);
    expect(lad.status).toBe("completed");
    expect(lad.ladder!.challenges[0]!.state).toBe("withdrawn");
    expect(((await h.call("GET", base)).body as { ladder: { state: string } }).ladder.state).toBe("closed");
  });
});

describe("redraft hooks and gates", () => {
  it("ladder redraft rules layer over the league's; a period end opens a window that pauses challenges; TV cap and per-team N games block", async () => {
    const h = harness({ league: { redraftRules: { perWin: 30_000, windowDays: 5 } } });
    const id = await h.openLadder("position", { periodDays: 28 });
    h.seedMembers(id, ["Amy", "Bob", "Cara"]);
    const lad = h.ladderOf(id);
    lad.ladder!.settings.redraft.rules = { perWin: 50_000 };
    h.store.putSeason(lad);
    const league = h.store.league(L)!;
    expect(ladderRedraftRules(league, h.ladderOf(id))).toMatchObject({ perWin: 50_000, windowDays: 5, perGame: 20_000 });
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const start = Date.parse(h.ladderOf(id).ladder!.startedAt!);
    h.clock.now = new Date(start + 28 * D - H);
    const c1 = ((await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Amy") })).body as { challenge: { id: string } }).challenge.id;
    // 28 days after the start the period ends: a 5-day window (the league's window days), challenges paused, live ones discarded.
    h.clock.now = new Date(start + 28 * D + 60_000);
    expect(((await h.call("POST", `${base}/challenges`, coach("Cara"), { challengerTeamId: tid("Cara"), defenderTeamId: tid("Amy") })).body as { error: string }).error).toContain("redraft window");
    const out = runLadderJob({ store: h.store, now: () => h.clock.now });
    expect(out.windows).toHaveLength(1);
    expect(h.ladderOf(id).ladder!.challenges.find((c) => c.id === c1)!.state).toBe("withdrawn");
    expect(runLadderJob({ store: h.store, now: () => h.clock.now }).windows).toHaveLength(0);
    h.clock.now = new Date(h.clock.now.getTime() + 5 * D);
    expect((await h.call("POST", `${base}/challenges`, coach("Cara"), { challengerTeamId: tid("Cara"), defenderTeamId: tid("Amy") })).status).toBe(201);
    // TV cap: a team over it must redraft before its next challenge.
    const capped = h.ladderOf(id);
    capped.ladder!.settings = parseLadderSettings({ redraft: { tvCap: 900_000 } }, capped.ladder!.settings, h.clock.now);
    h.store.putSeason(capped);
    expect(((await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Amy") })).body as { error: string }).error).toContain("TV cap");
    // Per team after N games.
    const g = h.ladderOf(id);
    g.ladder!.settings = parseLadderSettings({ redraft: { tvCap: null, trigger: "games", everyGames: 1 } }, g.ladder!.settings, h.clock.now);
    h.store.putSeason(g);
    h.result(id, "Bob", "Cara", 1, 0, new Date(h.clock.now.getTime() - D).toISOString());
    // Stored but not enforced until ladder redrafts exist (nothing could lift the block): the count is there for that lane.
    expect(ladderTeamGamesSinceRedraft(h.ladderOf(id), tid("Bob"))).toBe(1);
    expect((await h.call("POST", `${base}/challenges`, coach("Bob"), { challengerTeamId: tid("Bob"), defenderTeamId: tid("Amy") })).status).toBe(201);
  });

  it("the Schedule page's gate source lists a ladder's challenge gate while it is still to open (lane 8c hook), and the gate pauses challenges", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const opens = new Date(h.clock.now.getTime() + 2 * D).toISOString();
    const lad = h.ladderOf(id);
    lad.ladder!.gates = { challenges: { opensAt: opens } };
    h.store.putSeason(lad);
    const entries = gateScheduleSource({ league: h.store.league(L)!, seasons: [], ladders: h.store.ladders(L), events: [], zone: "UTC", now: h.clock.now.getTime() });
    expect(entries).toEqual([expect.objectContaining({ kind: "gate", step: "ladder-challenges", start: opens })]);
    const sched = (await h.call("GET", `/api/leagues/${L}/schedule`, OLGA)).body as { entries: Array<{ kind: string }> };
    expect(sched.entries.some((e) => e.kind === "gate")).toBe(true);
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    expect(((await h.call("POST", `/api/leagues/${L}/ladders/${id}/challenges`, coach("Amy"), { challengerTeamId: tid("Amy"), defenderTeamId: tid("Bob") })).body as { error: string }).error).toContain("Challenges open");
  });
});

describe("Discord", () => {
  it("a new ladder gets its own webhook and options from the league (ladder result replaces the plain result); events post through the cleaned sender", async () => {
    const h = harness();
    h.store.setSecrets(L, { discordWebhookUrl: HOOK });
    const id = await h.openLadder("position", { maxOpen: 5 });
    const secrets = h.store.secrets(L);
    expect(secrets.competitionWebhooks?.[`ladder:${id}`]).toBe(HOOK);
    const cfg = h.store.league(L)!.competitionDiscord?.[`ladder:${id}`];
    expect(cfg?.events).toMatchObject({ matchResult: false, ladderResult: true, ladderChallengeAccepted: true, ladderRankChanges: true, ladderChallengeIssued: false });
    const target = ladderTarget(h.store, h.store.league(L)!, id);
    expect(target).toMatchObject({ kind: "ladder", key: `ladder:${L}:${id}`, url: HOOK, inherited: false });
    // A ladder fixture's recorded game (the existing season paths) posts to the ladder's webhook and options.
    expect(seasonTarget(h.store, h.store.league(L)!, id).kind).toBe("ladder");
    // The organiser routes reach the ladder's options at .../ladders/:id/discord.
    expect(discordApiPath(`/api/leagues/${L}/ladders/${id}/discord`)).toBe(true);
    const tstore = new TournamentStore(join(h.root, "tournaments"));
    const state = new DiscordStateStore(join(h.root, "discord"));
    const view = (await discordApi("GET", `/api/leagues/${L}/ladders/${id}/discord`, OLGA, undefined, { leagues: h.store, tournaments: tstore, state } as never))!;
    expect(view.status).toBe(200);
    const keys = (view.body as { discord: { catalogue: Array<{ key: string }> } }).discord.catalogue.map((c) => c.key);
    expect(keys).toContain("ladderResult");
    const seasonView = (await discordApi("GET", `/api/leagues/${L}/seasons/season-1/discord`, OLGA, undefined, { leagues: h.store, tournaments: tstore, state } as never))!;
    expect((seasonView.body as { discord: { catalogue: Array<{ key: string }> } }).discord.catalogue.map((c) => c.key)).not.toContain("ladderResult");
    expect((await discordApi("GET", `/api/leagues/${L}/seasons/${id}/discord`, OLGA, undefined, { leagues: h.store, tournaments: tstore, state } as never))?.status).toBe(404);
    // The observer: first sight baselines, then each event posts once.
    const posts: Array<{ url: string; payload: DiscordPayload }> = [];
    const poster = async (url: string, payload: DiscordPayload) => { posts.push({ url, payload }); return { ok: true, status: 204 }; };
    const observer = () => new DiscordObserver({ leagues: h.store, tournaments: tstore, state, poster, now: () => h.clock.now });
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    await observer().tick();
    expect(posts).toHaveLength(0);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const cid = ((await h.call("POST", `${base}/challenges`, coach("Dan"), { challengerTeamId: tid("Dan"), defenderTeamId: tid("Amy") })).body as { challenge: { id: string } }).challenge.id;
    await observer().tick();
    expect(posts).toHaveLength(0); // challenge issued is off by default
    const acc = (await h.call("POST", `${base}/challenges/${cid}/accept`, coach("Amy"), {})).body as { fixture: { id: string } };
    await observer().tick();
    expect(posts.map((p) => p.payload.embeds[0]!.title)).toEqual([expect.stringContaining("Ladder challenge accepted")]);
    const lad = h.ladderOf(id);
    const f = lad.fixtures.find((x) => x.id === acc.fixture.id)!;
    f.home.score = 0; f.away.score = 2; f.finishedAt = h.clock.now.toISOString();
    f.away.team = `Dan's ${LISTED} team`; // a listed word in a name is starred by the cleaned sender
    h.store.putSeason(lad);
    posts.length = 0;
    await observer().tick();
    const texts = posts.map((p) => `${p.payload.embeds[0]!.title}\n${p.payload.embeds[0]!.description}`);
    expect(texts.some((t) => t.includes("ladder result") && t.includes("takes 1st place")), texts.join("|")).toBe(true);
    expect(texts.some((t) => t.includes("top 10 changes"))).toBe(true);
    expect(posts.every((p) => p.url === HOOK && p.payload.allowed_mentions?.parse.length === 0)).toBe(true);
    expect(JSON.stringify(posts)).not.toContain(LISTED);
    posts.length = 0;
    await observer().tick();
    expect(posts).toHaveLength(0);
  });

  it("the Weekly Digest carries a ladder section (also when the league has no season results that week)", async () => {
    const h = harness({ clock: "2026-11-08T10:30:00.000Z" });
    h.store.setSecrets(L, { discordWebhookUrl: HOOK });
    h.store.updateLeague(L, (l) => { l.timeZone = "UTC"; l.weeklyDigest = { enabled: true, trigger: "schedule", day: 0, time: "10:00", everyWeeks: 1 }; });
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    h.result(id, "Amy", "Bob", 3, 1, "2026-11-06T20:00:00.000Z");
    const tstore = new TournamentStore(join(h.root, "tournaments"));
    const state = new DiscordStateStore(join(h.root, "discord"));
    const observer = new DiscordObserver({ leagues: h.store, tournaments: tstore, state, poster: async () => ({ ok: true, status: 204 }), now: () => h.clock.now });
    const d = await observer.digestFor(h.store.league(L)!, Date.parse("2026-11-01T10:00:00.000Z"), Date.parse("2026-11-08T10:00:00.000Z"));
    const fields = d.payload!.embeds[0]!.fields!;
    const section = fields.find((x) => x.name.startsWith("Ladder: "))!;
    expect(section.value).toContain("1. Amy's");
    expect(section.value).toContain("1 result this period");
  });
});

describe("access, CSRF, GETs", () => {
  it("every ladder write is a CSRF-gated state change and GETs are public reads on both gates; GETs never write", async () => {
    for (const p of [`/api/leagues/${L}/ladders`, `/api/leagues/${L}/ladders/ladder-1/challenges`, `/api/leagues/${L}/ladders/ladder-1/registrations`, `/api/leagues/${L}/ladders/ladder-1/rounds`]) {
      expect(isStateChangingApiRequest("POST", p)).toBe(true);
      expect(onboardingGateApplies("POST", p)).toBe(true);
      expect(isStateChangingApiRequest("GET", p)).toBe(false);
    }
    expect(isStateChangingApiRequest("PATCH", `/api/leagues/${L}/ladders/ladder-1`)).toBe(true);
    const get = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "GET" } as unknown as IncomingMessage;
    expect(requireSession(get, `/api/leagues/${L}/ladders/ladder-1`, "").kind).toBe("allow");
    expect(requireSession(get, `/api/leagues/${L}/ladders`, "").kind).toBe("allow");
    const post = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "POST" } as unknown as IncomingMessage;
    expect(requireSession(post, `/api/leagues/${L}/ladders/ladder-1/challenges`, "").kind).not.toBe("allow");
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const rev = h.ladderOf(id).revision;
    for (const path of [`/api/leagues/${L}/ladders`, `/api/leagues/${L}/ladders/${id}`, `/api/leagues/${L}/ladders/${id}/join`]) {
      for (const who of [undefined, coach("Amy"), OLGA]) expect((await h.call("GET", path, who)).status).toBe(200);
    }
    expect(h.ladderOf(id).revision).toBe(rev);
    expect((await h.call("DELETE", `/api/leagues/${L}/ladders/${id}`, OLGA)).status).toBe(405);
    expect((await h.call("GET", `/api/leagues/${L}/ladders/ladder-99`)).status).toBe(404);
    expect((await h.call("PATCH", `/api/leagues/${L}/ladders/${id}`, OTTO, { revision: rev, general: { name: "Mine now" } })).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, coach("Amy"), {})).status).toBe(403);
    expect((await h.call("POST", `/api/leagues/${L}/ladders/${id}/close`, ROOT, {})).status).toBe(200);
  });

  it("ladder settings parse: defaults per method, ranges refused, position ladders always keep a range", () => {
    const now = new Date("2026-11-10T00:00:00.000Z");
    expect(defaultLadderSettings("rating")).toMatchObject({ challengeRange: null, declineRule: { enabled: false } });
    expect(() => parseLadderSettings({ minGames: -1 }, defaultLadderSettings(), now)).toThrow();
    expect(() => parseLadderSettings({ endsAt: "2026-01-01T00:00:00.000Z" }, defaultLadderSettings(), now)).toThrow();
    expect(parseLadderSettings({ challengeRange: null }, defaultLadderSettings("position"), now).challengeRange).toBe(3);
    expect(parseLadderSettings({ challengeRange: null }, defaultLadderSettings("points"), now).challengeRange).toBeNull();
    const snap = replayLadder({ fixtures: [], teams: [], ladder: { settings: defaultLadderSettings(), challenges: [], rounds: [], members: [], playOnFork: false } } as unknown as SeasonRecord, now);
    expect(snap.order).toEqual([]);
  });
});

// ---- Sol review (11-03): each fix through the real wiring (routes, the store's write, the sync, the lobby, the recorder) ----

describe("review fixes", () => {
  const lobbyDeps = {} as never;

  it("P1: Super FUMBBL results sync for ladder fixtures (the sync walks seasons AND ladders)", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const lad = h.ladderOf(id);
    const [a, b] = lad.teams;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    lad.fixtures.push({
      id: "lf-sync", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(a!), away: side(b!), suspended: false, forkEnabled: true,
      fork: { status: "scheduled", gameId: "7001", log: [], teams: {
        home: { teamId: a!.id, forkTeamId: "ft-a", coach: "Amy", builtAt: "x", players: a!.players.map((p, i) => ({ forkPlayerId: `fa${i}`, playerId: p.playerId })) },
        away: { teamId: b!.id, forkTeamId: "ft-b", coach: "Bob", builtAt: "x", players: b!.players.map((p, i) => ({ forkPlayerId: `fb${i}`, playerId: p.playerId })) },
      } },
    } as LeagueFixture);
    h.store.putSeason(lad);
    const fork = {
      gameStates: async () => new Map([["7001", { status: "finished", playedAt: "2026-11-10T10:00:00.000Z" }]]),
      result: async () => ({ gameId: "7001", source: "full", playedAt: "2026-11-10T10:00:00.000Z", teams: [
        { teamId: "ft-a", score: 1, conceded: false, winnings: 50_000, players: [] }, { teamId: "ft-b", score: 0, conceded: false, winnings: 30_000, players: [] },
      ] }),
    } as never;
    const out = await syncLeagueForkResults({ store: h.store, fork, now: () => h.clock.now });
    expect(out.applied).toContain("7001");
    const f = h.ladderOf(id).fixtures.find((x) => x.id === "lf-sync")!;
    expect([f.home.score, f.away.score, f.fork?.status]).toEqual([1, 0, "finished"]);
    expect(ladderRanking(h.ladderOf(id), h.clock.now)[0]).toMatchObject({ coach: "Amy", points: 3 });
  });

  it("a team that moved to a ladder can't be given or play fixtures in its old season (create, lobby, recorder, result entry)", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    const base = `/api/leagues/${L}/ladders/${id}`;
    await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true });
    const rid = h.ladderOf(id).registrations![0]!.id;
    expect((await h.call("POST", `${base}/registrations/${rid}/accept`, OLGA, {})).status).toBe(200);
    const create = await h.call("POST", `/api/leagues/${L}/seasons/season-1/fixtures`, OLGA, { home: "t-amy", away: "t-bob", round: 2 });
    expect(create.status).toBe(409);
    expect((create.body as { error: string }).error).toContain("moved");
    // A fixture that already named it (made by another writer) can't be played.
    const s1 = h.store.season(L, "season-1")!;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    s1.fixtures.push({ id: "old-f", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 3, table: 1, home: side(s1.teams[0]!), away: side(s1.teams[1]!), suspended: false });
    h.store.putSeason(s1);
    const s1b = h.store.season(L, "season-1")!;
    const lobby = leagueLobbyFixture(h.store.league(L)!, s1b, s1b.fixtures.find((f) => f.id === "old-f")!, OLGA, h.store, lobbyDeps, h.clock.now);
    expect(lobby.open).toBe(false);
    expect(lobby.closedReason).toContain("moved");
    expect(leagueFixtureView(h.store, `league:${L}:season-1:old-f`, h.clock.now)?.open).toBe(false);
    expect(() => recordLeagueFixture(h.store, `league:${L}:season-1:old-f`, { expectedRevision: 0, homeScore: 1, awayScore: 0, homeCasualties: 0, awayCasualties: 0 }, h.clock.now)).toThrow(/moved/);
    const result = await h.call("PATCH", `/api/leagues/${L}/seasons/season-1/fixtures/old-f`, OLGA, { result: { home: 1, away: 0, homeCas: null, awayCas: null } });
    expect(result.status).toBe(409);
    // Bob's team (never moved) is untouched.
    expect(fixturePlayBlock(h.store, L, "season-1", { home: side(s1.teams[1]!), away: side(s1.teams[1]!) }, h.clock.now)).toBe("");
  });

  it("accepting re-runs every challenge rule inside the write: a rematch or range that no longer holds refuses it", async () => {
    const h = harness();
    const id = await h.openLadder("points", { challengeRange: 3, rematchDays: 7, maxOpen: 5 });
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const issue = async (a: string, b: string) => ((await h.call("POST", `${base}/challenges`, coach(a), { challengerTeamId: tid(a), defenderTeamId: tid(b) })).body as { challenge: { id: string } }).challenge.id;
    const c1 = await issue("Cara", "Amy");
    h.result(id, "Cara", "Amy", 1, 0, new Date(h.clock.now.getTime() - 60_000).toISOString()); // they met meanwhile
    const r1 = await h.call("POST", `${base}/challenges/${c1}/accept`, coach("Amy"), {});
    expect(r1.status).toBe(409);
    expect((r1.body as { error: string }).error).toContain("rematch");
    // Range: the last team challenged the first within 3 places; the organiser narrows the range to 1 before it is answered.
    const before = ladderRanking(h.ladderOf(id), h.clock.now);
    const top = before[0]!.coach; // Cara (they just met Amy: not Amy)
    const last = before.filter((r) => r.coach !== top && r.coach !== "Amy").at(-1)!.coach;
    expect(before.find((r) => r.coach === last)!.rank - 1).toBeGreaterThan(1);
    const c2 = await issue(last, top);
    const lad = h.ladderOf(id);
    lad.ladder!.settings = parseLadderSettings({ challengeRange: 1 }, lad.ladder!.settings, h.clock.now);
    h.store.putSeason(lad);
    const r2 = await h.call("POST", `${base}/challenges/${c2}/accept`, coach(top), {});
    expect(r2.status).toBe(409);
    expect((r2.body as { error: string }).error).toContain("1 places");
    expect(h.ladderOf(id).ladder!.challenges.find((c) => c.id === c2)!.state).toBe("open");
  });

  it("position swap: a defender who wins never moves up, even when the order changed before the game", async () => {
    const h = harness();
    const id = await h.openLadder("position");
    h.seedMembers(id, ["Amy", "Bob", "Cara", "Dan"]);
    const lad = h.ladderOf(id);
    const tid = (c: string) => lad.teams.find((t) => t.coach === c)!.id;
    lad.ladder!.challenges.push({ id: "lc-x", challengerTeamId: tid("Dan"), defenderTeamId: tid("Bob"), state: "accepted", createdAt: "2026-11-05T00:00:00.000Z", expiresAt: "2026-11-07T00:00:00.000Z", answeredAt: "2026-11-05T01:00:00.000Z", fixtureId: "f-ch" });
    h.store.putSeason(lad);
    // Before the challenge game, Dan wins a scheduled-round game against Amy and goes 1st.
    h.result(id, "Dan", "Amy", 2, 0, "2026-11-06T12:00:00.000Z", { ladder: { roundId: "lr-1" } });
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now))).toEqual(["Dan", "Amy", "Bob", "Cara"]);
    // Bob (defender, now 3rd) beats Dan (challenger, now 1st): nothing moves.
    h.result(id, "Bob", "Dan", 2, 1, "2026-11-07T12:00:00.000Z", { ladder: { challengeId: "lc-x" } });
    expect(order(ladderRanking(h.ladderOf(id), h.clock.now))).toEqual(["Dan", "Amy", "Bob", "Cara"]);
  });

  it("the write's clock is read after the body arrives: a slow body can't slip an accept past the 48 h expiry", async () => {
    const h = harness();
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const base = `/api/leagues/${L}/ladders/${id}`;
    const tid = (c: string) => h.ladderOf(id).teams.find((t) => t.coach === c)!.id;
    const cid = ((await h.call("POST", `${base}/challenges`, coach("Amy"), { challengerTeamId: tid("Amy"), defenderTeamId: tid("Bob") })).body as { challenge: { id: string } }).challenge.id;
    h.clock.now = new Date(h.clock.now.getTime() + 48 * H - 1000);
    const deps = { ...h.deps({}), readBody: async () => { h.clock.now = new Date(h.clock.now.getTime() + 5000); return Buffer.from("{}"); } };
    const r = await leagueApi("POST", `${base}/challenges/${cid}/accept`, new URLSearchParams(), coach("Bob"), deps);
    expect(r?.status).toBe(409);
    expect((r?.body as { error: string }).error).toContain("expired");
  });

  it("a move rebases team-page MNG: one already served clears, one still to serve counts from the destination's games", async () => {
    const h = harness();
    const s1 = h.store.season(L, "season-1")!;
    const amy = s1.teams[0]!;
    amy.players[1]!.missNextGame = true; amy.players[1]!.mngGames = 1; // set after game 1: misses game 2 (not played yet)
    amy.players[2]!.missNextGame = true; amy.players[2]!.mngGames = 0; // set before game 1: served by it
    const side = (t: LeagueTeam, s: number) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: s, cas: 0, conceded: false });
    s1.fixtures.push({ id: "g1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, home: side(amy, 1), away: side(s1.teams[1]!, 0), suspended: false, finishedAt: "2026-11-01T00:00:00.000Z" });
    h.store.putSeason(s1);
    const id = await h.openLadder("points");
    const base = `/api/leagues/${L}/ladders/${id}`;
    await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true });
    await h.call("POST", `${base}/registrations/${h.ladderOf(id).registrations![0]!.id}/accept`, OLGA, {});
    const moved = h.ladderOf(id).teams[0]!;
    expect(moved.players[1]).toMatchObject({ missNextGame: true, mngGames: 0 });
    expect(moved.players[2]!.missNextGame).toBe(false);
    expect(moved.players[2]!.mngGames).toBeUndefined();
  });

  it("a ladder in setup doesn't exist to the Roster Builder's package resolver, nor to Discord (private in a published league)", async () => {
    const h = harness();
    h.store.setSecrets(L, { discordWebhookUrl: HOOK });
    const created = await h.call("POST", `/api/leagues/${L}/ladders`, OLGA, { name: "Hidden" });
    const id = (created.body as { id: string }).id;
    expect(resolveLeaguePackage(h.store, leaguePackageName(L, id))).toEqual({ error: expect.any(String) });
    const target = ladderTarget(h.store, h.store.league(L)!, id);
    expect(target.draft).toBe(true);
    expect(seasonTarget(h.store, h.store.league(L)!, id).draft).toBe(true);
    let posted = 0;
    expect(await postTo(target, "news", { embeds: [{ title: "x" }] } as never, async () => { posted += 1; return { ok: true, status: 204 }; })).toBe(false);
    expect(posted).toBe(0);
    await h.call("POST", `/api/leagues/${L}/ladders/${id}/start`, OLGA, {});
    expect(ladderTarget(h.store, h.store.league(L)!, id).draft).toBe(false);
    expect("pkg" in (resolveLeaguePackage(h.store, leaguePackageName(L, id)) as object)).toBe(true);
  });

  it("the ladder's own Played on decides Super FUMBBL play (generate, lobby mode, the admin switch), not the league's", async () => {
    const h = harness({ league: { playOnFork: false } });
    const id = await h.openLadder("points");
    h.seedMembers(id, ["Amy", "Bob"]);
    const lad = h.ladderOf(id);
    lad.ladder!.playOnFork = true;
    const [a, b] = lad.teams;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    lad.fixtures.push({ id: "lf-p", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(a!), away: side(b!), suspended: false } as LeagueFixture);
    h.store.putSeason(lad);
    const on = await h.call("PATCH", `/api/leagues/${L}/seasons/${id}/fixtures/lf-p`, ROOT, { forkEnabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    const saved = h.ladderOf(id);
    const f = saved.fixtures.find((x) => x.id === "lf-p")!;
    expect(f.forkEnabled).toBe(true);
    expect(generateBlocker(h.store.league(L)!, saved, f)).not.toMatch(/off for this league|tabletop/);
    expect(leagueLobbyFixture(h.store.league(L)!, saved, f, OLGA, h.store, lobbyDeps, h.clock.now).mode).toBe("fork");
    saved.ladder!.playOnFork = false;
    h.store.putSeason(saved);
    const again = h.ladderOf(id);
    const g = again.fixtures.find((x) => x.id === "lf-p")!;
    expect(generateBlocker(h.store.league(L)!, again, g)).toContain("tabletop");
    expect(leagueLobbyFixture(h.store.league(L)!, again, g, OLGA, h.store, lobbyDeps, h.clock.now).mode).toBe("tabletop");
  });
});

// ---- Sol re-review (11-03, round 3) ----

describe("review fixes, round 3", () => {
  it("a forfeit on a tournament-style ladder fixture can be undone right away (the undo fingerprint is taken after the in-write reset)", async () => {
    const h = harness();
    const id = await h.openLadder("points", { style: "tournament" });
    const base = `/api/leagues/${L}/ladders/${id}`;
    expect((await h.call("POST", `${base}/registrations`, coach("Cara"), { teamRef: "save:new-orc", share: [], acknowledged: true })).status).toBe(201);
    expect((await h.call("POST", `${base}/registrations`, coach("Eve"), { teamRef: "save:new-human", share: [], acknowledged: true })).status).toBe(201);
    const lad = h.ladderOf(id);
    const [a, b] = lad.teams;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    lad.fixtures.push({ id: "lf-ff", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(a!), away: side(b!), suspended: false } as LeagueFixture);
    h.store.putSeason(lad);
    const F = `/api/leagues/${L}/seasons/${id}/fixtures/lf-ff/forfeit`;
    h.clock.now = new Date(h.clock.now.getTime() + 3_600_000); // the forfeit lands after the teams joined: the reset runs
    expect((await h.call("POST", `${F}/settings`, OLGA, { defectionRolls: false })).status).toBe(200);
    const s = suggestForfeit({ home: true, away: false });
    const applied = await h.call("POST", F, OLGA, { home: s.home, away: { ...s.away, winnings: 40_000 }, noStandings: false, legalConcession: false });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(h.ladderOf(id).ladder!.members.every((m) => m.reset?.after)).toBe(true); // the roster reset in that write
    const undo = await h.call("POST", `${F}/undo`, OLGA, {});
    expect(undo.status, JSON.stringify(undo.body)).toBe(200);
    expect(h.ladderOf(id).fixtures.find((f) => f.id === "lf-ff")!.forfeit).toBeUndefined();
  });

  it("Super FUMBBL banking records the MNG marker, so a move never mistakes a fresh MNG for a served one (stale team-page counter)", async () => {
    const h = harness();
    const s1 = h.store.season(L, "season-1")!;
    const [amy, bob] = s1.teams;
    // An old team-page MNG left a counter behind (set before game 0, never settled), then a fork game injures the player.
    amy!.players[3]!.mngGames = 0;
    const side = (t: LeagueTeam) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: null, cas: null, conceded: false });
    s1.fixtures.push({
      id: "fk1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, home: side(amy!), away: side(bob!), suspended: false,
      fork: { status: "scheduled", gameId: "8001", log: [], teams: {
        home: { teamId: amy!.id, forkTeamId: "fa", coach: "Amy", builtAt: "x", players: amy!.players.map((p, i) => ({ forkPlayerId: `a${i}`, playerId: p.playerId })) },
        away: { teamId: bob!.id, forkTeamId: "fb", coach: "Bob", builtAt: "x", players: bob!.players.map((p, i) => ({ forkPlayerId: `b${i}`, playerId: p.playerId })) },
      } },
    } as LeagueFixture);
    const fx = s1.fixtures.at(-1)!;
    expect(applyForkResult(s1, fx, { gameId: "8001", source: "full", playedAt: "2026-11-09T20:00:00.000Z", teams: [
      { teamId: "fa", score: 0, conceded: false, winnings: 20_000, players: [{ forkPlayerId: "a3", name: "P3", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: ["Seriously Hurt (MNG)"] }] },
      { teamId: "fb", score: 1, conceded: false, winnings: 30_000, players: [] },
    ] }, h.clock.now).applied).toBe(true);
    h.store.putSeason(s1);
    const banked = h.store.season(L, "season-1")!.teams[0]!.players[3]!;
    expect(banked).toMatchObject({ missNextGame: true, mngGames: 1 }); // the marker is this game, not the stale 0
    const id = await h.openLadder("points");
    const base = `/api/leagues/${L}/ladders/${id}`;
    await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true });
    await h.call("POST", `${base}/registrations/${h.ladderOf(id).registrations![0]!.id}/accept`, OLGA, {});
    expect(h.ladderOf(id).teams[0]!.players[3]).toMatchObject({ missNextGame: true, mngGames: 0 });
  });

  it("a move that clears a served MNG recomputes the current team value (both move paths)", async () => {
    const h = harness();
    const s1 = h.store.season(L, "season-1")!;
    const amy = s1.teams[0]!;
    amy.players[2]!.missNextGame = true; amy.players[2]!.mngGames = 0; // served by game 1 below
    amy.currentTeamValue = 950_000; // what the season read showed while the player sat out
    const side = (t: LeagueTeam, s: number) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: s, cas: 0, conceded: false });
    s1.fixtures.push({ id: "g1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, home: side(amy, 1), away: side(s1.teams[1]!, 0), suspended: false, finishedAt: "2026-11-01T00:00:00.000Z" });
    h.store.putSeason(s1);
    const id = await h.openLadder("points");
    const base = `/api/leagues/${L}/ladders/${id}`;
    await h.call("POST", `${base}/registrations`, coach("Amy"), { move: { id: "season-1", teamId: "t-amy" }, share: [], acknowledged: true });
    await h.call("POST", `${base}/registrations/${h.ladderOf(id).registrations![0]!.id}/accept`, OLGA, {});
    const moved = h.ladderOf(id).teams[0]!;
    expect(moved.players[2]!.missNextGame).toBe(false);
    expect(moved.currentTeamValue).toBe(moved.teamValue);
    // Back to the season (the organiser's move): a served MNG in the ladder clears with the value recomputed there too.
    const lad = h.ladderOf(id);
    lad.teams[0]!.players[4]!.missNextGame = true; lad.teams[0]!.players[4]!.mngGames = 0;
    lad.teams[0]!.currentTeamValue = 900_000;
    const side2 = (t: LeagueTeam, s: number) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score: s, cas: 0, conceded: false });
    h.seedMembers(id, ["Zed"]);
    const lad2 = h.ladderOf(id);
    lad2.teams[0]!.players[4]!.missNextGame = true; lad2.teams[0]!.players[4]!.mngGames = 0; lad2.teams[0]!.currentTeamValue = 900_000;
    lad2.fixtures.push({ id: "lg1", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side2(lad2.teams[0]!, 1), away: side2(lad2.teams.find((t) => t.coach === "Zed")!, 0), suspended: false, finishedAt: "2026-11-09T00:00:00.000Z" });
    h.store.putSeason(lad2);
    void lad;
    const back = await h.call("POST", `${base}/teams/${moved.id}/move`, OLGA, { seasonId: "season-1" });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    const returned = h.store.season(L, "season-1")!.teams.find((t) => t.id === (back.body as { teamId: string }).teamId)!;
    expect(returned.players[4]!.missNextGame).toBe(false);
    expect(returned.currentTeamValue).toBe(returned.teamValue);
  });
});
