import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { onboardingGateApplies } from "../src/auth/onboarding";
import { requireSession } from "../src/auth/requireSession";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { gateTime, runGateJob, syncGateTargets, type GateView } from "../src/leagues/gates";
import { challengesPaused } from "../src/leagues/ladder";
import { runLadderJob } from "../src/leagues/ladderJob";
import { seasonWindowStatus } from "../src/leagues/seasonRegistration";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeaguePlayer, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { EMPTY_PLAYER_STATS } from "../src/leagues/types";

// Gates (league ladder spec, "Gates (11-02)"; lane 8c): an "Opens at" on an online step, by a time in the league zone or with a
// League Event (+ offset, moving with it). Each gated step refused while shut and allowed after; the minute job opens it once
// (restart-safe) with an inbox note and a Discord post; Open now; the honours reveal hidden then shown with no leak; the
// redraft window in the league zone; the live Redraft rolls page; the Schedule timeline; access control and CSRF.
// Every test has its own state dir; the notifier and the webhook poster are stubs.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const H = 3_600_000;
const D = 24 * H;

const pl = (id: string, n: number, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: `p-${id}${n}`, careerKey: `c-${id}${n}`, number: n, name: `${id} ${n}`, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [],
  value: 50_000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0, ...over,
});
const team = (id: string, name: string, coach: string, race = "Human", niggling = false): LeagueTeam => ({
  id, name, race, coach, coachId: coach, teamValue: 1_000_000, treasury: 50_000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: Array.from({ length: 11 }, (_, i) => pl(id, i + 1, niggling && i === 0 ? { niggling: 1, name: `Grim ${id}` } : {})), formerPlayers: [],
});
const fx = (id: string, home: string, away: string, hs: number | null, as: number | null): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: home, teamId: home.toLowerCase(), coach: "", race: "", score: hs, cas: 0, conceded: false },
  away: { team: away, teamId: away.toLowerCase(), coach: "", race: "", score: as, cas: 0, conceded: false },
  suspended: false,
});
const season = (n: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `s${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual", ...over,
});

const JAY: LeagueApiIdentity = { coach: "Jay", admin: false };
const ANN: LeagueApiIdentity = { coach: "Ann", admin: false };
const OTTO: LeagueApiIdentity = { coach: "Otto", admin: false, organizer: true };
const ROOT: LeagueApiIdentity = { coach: "Root", admin: true };

let dir: string;
let store: LeagueStore;
let now: Date;
let notes: Array<{ coach: string; title: string; body: string; link: string }>;
let posts: DiscordPayload[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "league-gates-"));
  store = new LeagueStore(dir);
  now = new Date("2026-11-02T12:00:00.000Z");
  notes = [];
  posts = [];
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
  store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Otto"] });
  store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
  // Season 6 finished (Ann's Orcs, Cat's Gobbos: the redraft source); Season 7 in registration with two teams.
  store.putSeason(season(6, { status: "completed", teams: [team("orcs", "Orcs", "Ann", "Orc", true), team("gobbos", "Gobbos", "Cat", "Goblin")], fixtures: [fx("f1", "Orcs", "Gobbos", 2, 1)] }));
  store.putSeason(season(7, { stage: "registration", teams: [team("elves", "Elves", "Bob", "Wood Elf"), team("dwarfs", "Dwarfs", "Dee", "Dwarf")], registration: { allowedRosters: { official: true, nafApproved: true, unofficial: true }, allowRegistration: true, maxRegistrations: null, maxPerRace: null, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, entryFee: "" } }));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = (body: unknown): LeagueApiDeps => ({
  store,
  readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  now: () => now,
  notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body, link: input.link }); },
  postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  rollD6: () => 6,
});
const call = async (method: string, path: string, auth?: LeagueApiIdentity, body?: unknown): Promise<LeagueApiResult> => {
  const r = await leagueApi(method, path.split("?")[0]!, new URLSearchParams(path.split("?")[1] ?? ""), auth, deps(body));
  if (!r) throw new Error(`no route for ${method} ${path}`);
  return r;
};
const G = "/api/leagues/tabbl/gates";
const gates = async (who?: LeagueApiIdentity) => (await call("GET", G, who)).body as { timeZone: string; manage: boolean; gates: GateView[]; events?: Array<{ id: string }> };
const gateOf = async (id: string, who: LeagueApiIdentity = JAY) => (await gates(who)).gates.find((g) => g.id === id);
const setGate = (kind: string, target: string, body: Record<string, unknown>, who: LeagueApiIdentity = JAY) => call("PUT", `${G}/${kind}/${target}`, who, { revision: 0, ...body });
const openNow = async (kind: string, target: string, who: LeagueApiIdentity = JAY) => {
  const g = await gateOf(`${kind}:${target}`);
  return call("POST", `${G}/${kind}/${target}/open`, who, { revision: g?.revision ?? 0 });
};
const job = () => runGateJob({ store, now: () => now, notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body, link: input.link }); }, postWebhook: async (_u, p) => { posts.push(p); return { ok: true, status: 204 }; } });
const titles = () => posts.map((p) => p.embeds[0]!.title);
const confirmRedraft = (extra: Record<string, unknown> = {}) =>
  call("POST", "/api/leagues/tabbl/redraft", JAY, { revision: 0, action: "confirm", capEnabled: false, cap: 1_300_000, teams: [{ teamId: "orcs", selected: true }, { teamId: "gobbos", selected: true }], ...extra });

describe("the gate model", () => {
  it("off by default; a time in the league zone; per-gate revisions; the file is stored per league", async () => {
    expect((await gates()).gates).toEqual([]);
    store.updateLeague("tabbl", (l) => { l.timeZone = "Europe/London"; });
    const put = await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" });
    expect(put.status, JSON.stringify(put.body)).toBe(201);
    const g = (put.body as { gate: GateView }).gate;
    expect(g).toMatchObject({ id: "registration:season-7", kind: "registration", target: "season-7", state: "shut", mode: "time", wall: "2026-11-05T19:00", opensAt: "2026-11-05T19:00:00.000Z", revision: 1, title: "Season 7: Registration opens" });
    expect(g.secondsLeft).toBe(3 * 24 * 3600 + 7 * 3600);
    // A stale or missing revision is refused.
    expect((await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-06T19:00" })).status).toBe(409);
    expect((await call("PUT", `${G}/registration/season-7`, JAY, { mode: "off" })).status).toBe(428);
    const file = JSON.parse(readFileSync(join(dir, "leagues", "tabbl", "gates.json"), "utf8")) as { revision: number; gates: Array<{ openedBy?: string }> };
    expect(file.revision).toBe(1);
    expect(JSON.stringify(file)).not.toMatch(/Jay/); // no coach data in the gates file
    // Bad input
    expect((await setGate("registration", "season-9", { mode: "time", opensAt: "2026-11-05T19:00" })).status).toBe(400);
    expect((await setGate("season-start", "season-6", { mode: "time", opensAt: "2026-11-05T19:00" })).status).toBe(400); // finished
    expect((await setGate("redraft-rest", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" })).status).toBe(400); // redraft gates are the league's
    expect((await setGate("season-start", "season-7", { mode: "time", opensAt: "2026-10-01T19:00" })).status).toBe(400); // past
    expect((await setGate("season-start", "season-7", { mode: "sometime" })).status).toBe(400);
    expect((await call("PUT", `${G}/nope/season-7`, JAY, { revision: 0, mode: "off" })).status).toBe(404);
    // Off removes it.
    const off = await call("PUT", `${G}/registration/season-7`, JAY, { revision: 1, mode: "off" });
    expect(off.body).toMatchObject({ gate: null, removed: true });
    expect((await gates()).gates).toEqual([]);
  });

  it("an event-linked gate takes the event's start (+ offset) and moves with the event; a deleted event leaves it shut with no time", async () => {
    const ev = await call("POST", "/api/leagues/tabbl/events", JAY, { title: "League night", type: "league-night", start: "2026-11-05T19:00", end: "2026-11-05T22:00", announce: false, remind: false });
    expect(ev.status).toBe(201);
    const eventId = (ev.body as { event: { id: string; revision: number } }).event.id;
    const put = await setGate("redraft-rest", "league", { mode: "event", eventId, offsetMinutes: 60 });
    expect(put.status).toBe(201);
    expect((put.body as { gate: GateView }).gate).toMatchObject({ mode: "event", eventId, eventTitle: "League night", offsetMinutes: 60, opensAt: "2026-11-05T20:00:00.000Z" });
    // The event moves a day: the gate follows.
    const moved = await call("PATCH", `/api/leagues/tabbl/events/${eventId}`, JAY, { revision: 1, start: "2026-11-06T19:00", end: "2026-11-06T22:00" });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect((await gateOf("redraft-rest:league"))?.opensAt).toBe("2026-11-06T20:00:00.000Z");
    // Weekly event: the first occurrence after the gate was set.
    expect(gateTime({ eventId: "e", offsetMinutes: 0, armedAt: "2026-11-06T12:00:00.000Z" }, [{ id: "e", title: "x", type: "league-night", start: "2026-11-05T19:00", end: "2026-11-05T22:00", recurrence: { everyWeeks: 1, until: "2026-12-31" }, location: { kind: "venue", text: "" }, description: "", remind: false, announce: false, revision: 1, createdAt: "", updatedAt: "" }], "UTC")).toBe(Date.parse("2026-11-12T19:00:00.000Z"));
    // Deleted: no time, shut, refused with "when the organisers open it".
    expect((await call("DELETE", `/api/leagues/tabbl/events/${eventId}`, JAY, { revision: 2 })).status).toBe(200);
    expect(await gateOf("redraft-rest:league")).toMatchObject({ state: "shut", opensAt: null, secondsLeft: null, eventMissing: true });
    await job();
    expect((await gateOf("redraft-rest:league"))?.state).toBe("shut");
  });
});

describe("each gated step: refused while shut, allowed after it opens", () => {
  it("registration: joins refused with countdown data, the season's projection shuts every registration read; open after the time", async () => {
    await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-03T18:00" });
    const join = await call("POST", "/api/leagues/tabbl/seasons/season-7/registrations", ANN, { teamRef: "save:abc", acknowledged: true });
    expect(join.status).toBe(409);
    expect(join.body).toMatchObject({ code: "gate-shut", gate: { kind: "registration", target: "season-7", opensAt: "2026-11-03T18:00:00.000Z", secondsLeft: 30 * 3600 } });
    expect((join.body as { error: string }).error).toMatch(/^Registration opens Tue 3 Nov 2026, 18:00 \(UTC\)\.$/);
    expect(store.season("tabbl", "season-7")!.gates?.registration).toEqual({ opensAt: "2026-11-03T18:00:00.000Z" });
    expect(seasonWindowStatus(store.league("tabbl")!, store.season("tabbl", "season-7")!, now).open).toBe(false);
    // Organisers may still add entries (the window rule for managers is unchanged).
    now = new Date("2026-11-03T18:00:30.000Z");
    const after = await call("POST", "/api/leagues/tabbl/seasons/season-7/registrations", ANN, { teamRef: "save:abc", acknowledged: true });
    expect((after.body as { code?: string }).code).not.toBe("gate-shut");
    await job();
    expect(store.season("tabbl", "season-7")!.gates).toBeUndefined();
    expect(seasonWindowStatus(store.league("tabbl")!, store.season("tabbl", "season-7")!, now).open).toBe(true);
  });

  it("season start: Start season refused until the gate; Open now lifts it; with auto-start the job starts the season", async () => {
    await setGate("season-start", "season-7", { mode: "time", opensAt: "2026-11-04T19:00" });
    const start = await call("POST", "/api/leagues/tabbl/seasons/season-7/stage", JAY, { stage: "active" });
    expect(start.status).toBe(409);
    expect(start.body).toMatchObject({ code: "gate-shut", gate: { kind: "season-start" } });
    expect((await openNow("season-start", "season-7")).status).toBe(200);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-7/stage", JAY, { stage: "active" })).status).toBe(200);
    // Auto-start: a second season in registration starts by itself when its gate opens.
    store.putSeason(season(8, { stage: "registration", teams: [team("a", "A", "Ann"), team("b", "B", "Bob")] }));
    const put = await setGate("season-start", "season-8", { mode: "time", opensAt: "2026-11-02T13:00", autoStart: true });
    expect((put.body as { gate: GateView }).gate.autoStart).toBe(true);
    await job();
    expect(store.season("tabbl", "season-8")!.stage).toBe("registration");
    now = new Date("2026-11-02T13:00:00.000Z");
    await job();
    expect(store.season("tabbl", "season-8")!.stage).toBe("active");
    expect(titles()).toContain("TABBL: Season 8: The season is starting!");
    expect(notes.filter((n) => n.title === "TABBL: Season 8: The season is starting!").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
  });

  it("redraft rest rolls and submissions each wait for their gate; then the roll posts and shows on the live page", async () => {
    expect((await confirmRedraft()).status).toBe(200);
    await setGate("redraft-rest", "league", { mode: "time", opensAt: "2026-11-02T19:00" });
    await setGate("redraft-submit", "league", { mode: "time", opensAt: "2026-11-03T19:00" });
    const rev = () => store.season("tabbl", "season-6")!.redraft!.revision;
    const rest = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: rev(), mode: "site" });
    expect(rest.status).toBe(409);
    expect(rest.body).toMatchObject({ code: "gate-shut", gate: { kind: "redraft-rest", opensAt: "2026-11-02T19:00:00.000Z" } });
    const sub = await call("POST", "/api/leagues/tabbl/redraft/teams/gobbos/submit", { coach: "Cat", admin: false }, { revision: rev(), keep: [], hires: [], staff: {} });
    expect(sub.body).toMatchObject({ code: "gate-shut", gate: { kind: "redraft-submit" } });
    now = new Date("2026-11-02T19:00:00.000Z");
    store.updateLeague("tabbl", (l) => { l.discordEvents = { redraftRolls: true }; });
    const ok = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: rev(), mode: "site" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(titles()).toContain("TABBL: Orcs Rest & Relaxation"); // the existing redraftRolls event
    const sub2 = await call("POST", "/api/leagues/tabbl/redraft/teams/gobbos/submit", { coach: "Cat", admin: false }, { revision: rev(), keep: [], hires: [], staff: {} });
    expect((sub2.body as { code?: string }).code).toBe("gate-shut");
  });

  it("ladder challenges: refused with the countdown, and the ladder's own pause reads the projection", async () => {
    const created = await call("POST", "/api/leagues/tabbl/ladders", JAY, { name: "Spring", ranking: "points" });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = (created.body as { id: string }).id;
    expect((await call("POST", `/api/leagues/tabbl/ladders/${id}/start`, JAY, {})).status).toBe(200);
    const lad = store.season("tabbl", id)!;
    for (const [i, c] of ["Ann", "Bob"].entries()) {
      const t = team(`t-${c.toLowerCase()}`, `${c}'s team`, c);
      lad.teams.push(t);
      lad.ladder!.members.push({ teamId: t.id, joinedAt: new Date(Date.parse("2026-11-01T00:00:00.000Z") + i).toISOString(), via: "organiser" });
    }
    store.putSeason(lad);
    await setGate("ladder-challenges", id, { mode: "time", opensAt: "2026-11-02T20:00" });
    expect(store.season("tabbl", id)!.ladder!.gates?.challenges).toEqual({ opensAt: "2026-11-02T20:00:00.000Z", source: "gate" });
    expect(challengesPaused(store.league("tabbl")!, store.season("tabbl", id)!, now)).toBe("Challenges open on 2026-11-02.");
    const issue = await call("POST", `/api/leagues/tabbl/ladders/${id}/challenges`, ANN, { challengerTeamId: "t-ann", defenderTeamId: "t-bob" });
    expect(issue.status).toBe(409);
    expect(issue.body).toMatchObject({ code: "gate-shut", gate: { kind: "ladder-challenges", target: id } });
    now = new Date("2026-11-02T20:00:00.000Z");
    const ok = await call("POST", `/api/leagues/tabbl/ladders/${id}/challenges`, ANN, { challengerTeamId: "t-ann", defenderTeamId: "t-bob" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    await job();
    expect(store.season("tabbl", id)!.ladder!.gates).toBeUndefined();
    expect(titles()).toContain("TABBL: Spring: Ladder challenges are open!");
  });
});

describe("the minute job and Open now", () => {
  it("opens a due gate once (restart-safe): one inbox note per coach and one Discord post; drafts post nothing", async () => {
    await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-02T12:30" });
    await job();
    expect(posts).toHaveLength(0);
    now = new Date("2026-11-02T12:31:00.000Z");
    const first = await job();
    expect(first.opened).toEqual(["tabbl/registration:season-7"]);
    expect(titles()).toEqual(["TABBL: Season 7: Registration is open"]);
    // Registration tells the league's coaches (Season 7's open season, plus the newest coaches).
    expect(notes.map((n) => n.coach).sort()).toEqual(["Bob", "Dee"]);
    expect(await gateOf("registration:season-7")).toMatchObject({ state: "open", openedBy: "schedule", openedAt: "2026-11-02T12:31:00.000Z" });
    // A second tick, and a "restart" (a fresh store on the same files), tell nobody again.
    await job();
    store = new LeagueStore(dir);
    expect((await job()).opened).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(notes).toHaveLength(2);
    // A draft league: the gate opens, its organisers only get the note, nothing is posted.
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    store.putSeason(season(9, { stage: "registration", teams: [team("x", "X", "Ann")] }));
    await setGate("registration", "season-9", { mode: "time", opensAt: "2026-11-02T12:40" });
    now = new Date("2026-11-02T12:41:00.000Z");
    notes = [];
    await job();
    expect(await gateOf("registration:season-9")).toMatchObject({ state: "open" });
    expect(posts).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("Open now opens it at once with the same note and post; only once; organisers and admins only", async () => {
    await setGate("redraft-window", "league", { mode: "time", opensAt: "2026-11-09T18:00" });
    expect((await confirmRedraft()).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.redraft!.window!.opensAt).toBe("2026-11-09T18:00:00.000Z");
    expect((await openNow("redraft-window", "league", ANN)).status).toBe(403);
    expect((await openNow("redraft-window", "league", OTTO)).status).toBe(403);
    expect((await call("POST", `${G}/redraft-window/league/open`, undefined, { revision: 1 })).status).toBe(401);
    const opened = await openNow("redraft-window", "league");
    expect(opened.status).toBe(200);
    expect((opened.body as { gate: GateView }).gate).toMatchObject({ state: "open", openedBy: "organiser" });
    // The window moved to now (its length kept).
    const w = store.season("tabbl", "season-6")!.redraft!.window!;
    expect(w.opensAt).toBe(now.toISOString());
    expect(Date.parse(w.closesAt) - Date.parse(w.opensAt)).toBe(7 * D);
    expect(titles()).toEqual(["TABBL: Redraft started", "TABBL: Redraft is open!"]);
    expect(notes.filter((n) => n.title === "TABBL: Redraft is open!").map((n) => n.coach).sort()).toEqual(["Ann", "Cat"]);
    expect((await openNow("redraft-window", "league")).status).toBe(409);
    await job();
    expect(titles()).toHaveLength(2);
    expect((await openNow("redraft-window", "league", ROOT)).status).toBe(409); // admin reaches it (already open)
  });
});

describe("the honours reveal", () => {
  it("period honours are held (no read shows them) until the gate opens; then written and announced", async () => {
    const created = await call("POST", "/api/leagues/tabbl/ladders", JAY, { name: "Spring", ranking: "points" });
    const id = (created.body as { id: string }).id;
    const p = await call("PATCH", `/api/leagues/tabbl/ladders/${id}`, JAY, { revision: store.season("tabbl", id)!.revision, settings: { periodDays: 7, redraft: { trigger: "schedule" } } });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect((await call("POST", `/api/leagues/tabbl/ladders/${id}/start`, JAY, {})).status).toBe(200);
    const lad = store.season("tabbl", id)!;
    for (const c of ["Ann", "Bob"]) {
      const t = team(`t-${c.toLowerCase()}`, `${c}'s team`, c);
      lad.teams.push(t);
      lad.ladder!.members.push({ teamId: t.id, joinedAt: "2026-11-02T12:00:00.000Z", via: "organiser" });
    }
    const side = (t: LeagueTeam, score: number) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score, cas: 0, conceded: false });
    lad.fixtures.push({ id: "lf-1", category: "Ladder", phase: "Challenges", phaseId: "ladder-challenges", group: "", round: 0, table: 0, home: side(lad.teams[0]!, 2), away: side(lad.teams[1]!, 0), suspended: false, finishedAt: "2026-11-03T10:00:00.000Z" });
    store.putSeason(lad);
    await setGate("honours-reveal", id, { mode: "time", opensAt: "2026-11-12T19:00" });
    expect(store.season("tabbl", id)!.ladder!.gates?.honours).toMatchObject({ from: now.toISOString(), opensAt: "2026-11-12T19:00:00.000Z" });
    // The period ends (7 days after the start); the ladder job runs: nothing is written.
    now = new Date(now.getTime() + 7 * D + H);
    runLadderJob({ store, now: () => now, notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body, link: input.link }); } });
    const hidden = store.season("tabbl", id)!;
    expect(hidden.awards).toEqual([]);
    expect(hidden.ladder!.periodHonours ?? []).toEqual([]);
    const reads = [
      await call("GET", "/api/leagues/tabbl/honours"), await call("GET", `/api/leagues/tabbl/ladders/${id}`), await call("GET", `/api/leagues/tabbl/seasons/${id}`, JAY),
      await call("GET", "/api/leagues/tabbl/awards"), await call("GET", G, JAY), await call("GET", "/api/leagues/tabbl/champions"),
    ];
    for (const r of reads) expect(JSON.stringify(r.body ?? {})).not.toMatch(/Period 1/);
    expect(notes.some((n) => /Period 1/.test(n.title))).toBe(false);
    // The gate opens: the honours are written, the champion told, the coaches told.
    now = new Date("2026-11-12T19:00:00.000Z");
    await job();
    const shown = store.season("tabbl", id)!;
    expect(shown.awards.map((a) => a.type)).toEqual(["Spring champion, Period 1", "Spring runner-up, Period 1"]);
    expect(shown.ladder!.periodHonours).toEqual([1]);
    expect(shown.ladder!.gates).toBeUndefined();
    expect(JSON.stringify((await call("GET", "/api/leagues/tabbl/honours")).body)).toMatch(/Spring champion, Period 1/);
    expect(notes.find((n) => /Period 1 champion/.test(n.title))?.coach).toBe("Ann");
    expect(notes.filter((n) => n.title === "TABBL: Spring: Period honours revealed").map((n) => n.coach).sort()).toEqual(["Ann", "Bob"]);
    // A later period is not held (the gate is open).
    now = new Date(now.getTime() + 7 * D);
    runLadderJob({ store, now: () => now, notify: () => undefined });
    expect(store.season("tabbl", id)!.ladder!.periodHonours).toEqual([1, 2]);
  });
});

describe("the redraft window reads the league time zone", () => {
  it("Opens at on the board is a wall-clock time in the league zone (not the browser's)", async () => {
    store.updateLeague("tabbl", (l) => { l.timeZone = "America/New_York"; });
    const r = await confirmRedraft({ opensAtWall: "2026-11-09T18:00" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const w = store.season("tabbl", "season-6")!.redraft!.window!;
    expect(w.opensAt).toBe("2026-11-09T23:00:00.000Z");
    expect((r.body as { redraft: { timeZone: string } }).redraft.timeZone).toBe("America/New_York");
    expect(store.season("tabbl", "season-6")!.redraft!.log[0]!.text).toMatch(/from Nov 9, 2026, 18:00 America\/New York to Nov 16, 2026, 18:00 America\/New York/);
    const rest = await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: store.season("tabbl", "season-6")!.redraft!.revision, mode: "site" });
    expect(rest.body).toMatchObject({ code: "gate-shut", gate: { kind: "redraft-window", opensAt: "2026-11-09T23:00:00.000Z" } });
    expect((rest.body as { error: string }).error).toBe("The redraft opens at Nov 9, 2026, 18:00 America/New York.");
    expect((await confirmRedraft({ revision: 1, opensAtWall: "2026-13-09T18:00" })).status).not.toBe(200);
  });

  it("an event-linked window gate moves the confirmed window until it has opened", async () => {
    const ev = await call("POST", "/api/leagues/tabbl/events", JAY, { title: "Redraft night", type: "draft", start: "2026-11-05T19:00", end: "2026-11-05T22:00", announce: false, remind: false });
    const eventId = (ev.body as { event: { id: string } }).event.id;
    await setGate("redraft-window", "league", { mode: "event", eventId, offsetMinutes: 0 });
    expect((await confirmRedraft()).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.redraft!.window!.opensAt).toBe("2026-11-05T19:00:00.000Z");
    await call("PATCH", `/api/leagues/tabbl/events/${eventId}`, JAY, { revision: 1, start: "2026-11-07T19:00", end: "2026-11-07T22:00" });
    const w = store.season("tabbl", "season-6")!.redraft!.window!;
    expect(w.opensAt).toBe("2026-11-07T19:00:00.000Z");
    expect(w.closesAt).toBe("2026-11-14T19:00:00.000Z");
    now = new Date("2026-11-07T19:00:00.000Z");
    await job();
    expect(titles()).toContain("TABBL: Redraft is open!");
  });
});

describe("the live Redraft rolls page", () => {
  it("organisers read it and make a share link; the link reads it read-only and live; revoked or drafted it is gone", async () => {
    expect((await confirmRedraft()).status).toBe(200);
    expect((await call("GET", "/api/leagues/tabbl/redraft-rolls")).status).toBe(401);
    expect((await call("GET", "/api/leagues/tabbl/redraft-rolls", ANN)).status).toBe(403);
    expect((await call("GET", "/api/leagues/tabbl/redraft-rolls", OTTO)).status).toBe(403);
    const own = await call("GET", "/api/leagues/tabbl/redraft-rolls", JAY);
    expect(own.body).toMatchObject({ link: null, rolls: { leagueName: "TABBL", rolls: [], waiting: 1, redraft: { seasonName: "Season 6", closed: false } } });
    expect((await call("POST", "/api/leagues/tabbl/redraft-rolls/link", ANN, { action: "create" })).status).toBe(403);
    const made = await call("POST", "/api/leagues/tabbl/redraft-rolls/link", JAY, { action: "create" });
    const link = (made.body as { link: string }).link;
    expect(link).toMatch(/^\/app\/leagues\/tabbl\/redraft-rolls\/[A-Za-z0-9_-]{32}$/);
    const token = link.split("/").at(-1)!;
    expect(JSON.stringify(store.league("tabbl"))).not.toContain(token); // a secret, not on the league record
    const viaLink = await call("GET", `/api/leagues/tabbl/redraft-rolls/${token}`);
    expect(viaLink.status).toBe(200);
    expect(viaLink.body).not.toHaveProperty("link");
    const before = (viaLink.body as { rolls: { version: string } }).rolls.version;
    // A roll happens: the page shows it (team, player name, roll, outcome; no coach).
    await call("POST", "/api/leagues/tabbl/redraft/teams/orcs/rest", ANN, { revision: store.season("tabbl", "season-6")!.redraft!.revision, mode: "site" });
    const after = (await call("GET", `/api/leagues/tabbl/redraft-rolls/${token}`)).body as { rolls: { version: string; waiting: number; rolls: Array<Record<string, unknown>> } };
    expect(after.rolls.version).not.toBe(before);
    expect(after.rolls.waiting).toBe(0);
    expect(after.rolls.rolls).toEqual([expect.objectContaining({ team: "Orcs", race: "Orc", player: "Grim orcs", roll: 6, recovered: true, source: "site" })]);
    expect(JSON.stringify(after)).not.toMatch(/Ann|budget/);
    // Wrong token, write to the token path, revoke, draft.
    expect((await call("GET", "/api/leagues/tabbl/redraft-rolls/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await call("POST", `/api/leagues/tabbl/redraft-rolls/${token}`, JAY, {})).status).toBe(405);
    store.updateLeague("tabbl", (l) => { l.visibility = "draft"; });
    expect((await call("GET", `/api/leagues/tabbl/redraft-rolls/${token}`)).status).toBe(404);
    store.updateLeague("tabbl", (l) => { l.visibility = "published"; });
    await call("POST", "/api/leagues/tabbl/redraft-rolls/link", JAY, { action: "revoke" });
    expect((await call("GET", `/api/leagues/tabbl/redraft-rolls/${token}`)).status).toBe(404);
  });

  it("shows the rest-roll gate's countdown", async () => {
    expect((await confirmRedraft()).status).toBe(200);
    await setGate("redraft-rest", "league", { mode: "time", opensAt: "2026-11-02T19:00" });
    const own = (await call("GET", "/api/leagues/tabbl/redraft-rolls", JAY)).body as { rolls: { gate: GateView } };
    expect(own.rolls.gate).toMatchObject({ kind: "redraft-rest", state: "shut", secondsLeft: 7 * 3600 });
  });
});

describe("Schedule timeline and calendar read", () => {
  it("every gate with a time to come is on the organiser timeline (event gates say which event); coaches read the gates for countdowns", async () => {
    const ev = await call("POST", "/api/leagues/tabbl/events", JAY, { title: "League night", type: "league-night", start: "2026-11-05T19:00", end: "2026-11-05T22:00", announce: false, remind: false });
    const eventId = (ev.body as { event: { id: string } }).event.id;
    await setGate("redraft-rest", "league", { mode: "event", eventId, offsetMinutes: 120 });
    await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-04T09:00" });
    const sched = (await call("GET", "/api/leagues/tabbl/schedule", JAY)).body as { entries: Array<{ kind: string; title: string; start: string; detail: string; gateId?: string; eventId?: string }> };
    const gateEntries = sched.entries.filter((e) => e.kind === "gate");
    expect(gateEntries).toEqual([
      expect.objectContaining({ gateId: "registration:season-7", title: "Season 7: Registration opens", start: "2026-11-04T09:00:00.000Z", detail: "Registration gate" }),
      expect.objectContaining({ gateId: "redraft-rest:league", title: "Rest & Relaxation rolls open", start: "2026-11-05T21:00:00.000Z", detail: "With League night (+2 h)", eventId }),
    ]);
    expect(sched.entries.some((e) => e.kind === "league-event")).toBe(true);
    // Once open, a gate leaves the timeline.
    await openNow("registration", "season-7");
    const later = (await call("GET", "/api/leagues/tabbl/schedule", JAY)).body as { entries: Array<{ gateId?: string }> };
    expect(later.entries.some((e) => e.gateId === "registration:season-7")).toBe(false);
    // Public read: the gates (no organiser event list); a ladder still in setup is hidden from coaches.
    const pub = await gates();
    expect(pub.manage).toBe(false);
    expect(pub.events).toBeUndefined();
    expect(pub.gates.map((g) => g.id).sort()).toEqual(["redraft-rest:league", "registration:season-7"]);
    expect((await gates(JAY)).events?.map((e) => e.id)).toEqual([eventId]);
    const created = await call("POST", "/api/leagues/tabbl/ladders", JAY, { name: "Spring", ranking: "points" });
    const id = (created.body as { id: string }).id;
    await setGate("ladder-challenges", id, { mode: "time", opensAt: "2026-11-04T09:00" });
    expect((await gates()).gates.some((g) => g.target === id)).toBe(false);
    expect((await gates(JAY)).gates.some((g) => g.target === id)).toBe(true);
  });
});

describe("access control, CSRF and GETs", () => {
  it("only organisers and admins write gates; writes are CSRF-gated; GETs are public and never write", async () => {
    for (const p of [`${G}/registration/season-7`, `${G}/registration/season-7/open`, "/api/leagues/tabbl/redraft-rolls/link"]) {
      expect(isStateChangingApiRequest("PUT", p)).toBe(true);
      expect(isStateChangingApiRequest("POST", p)).toBe(true);
      expect(onboardingGateApplies("POST", p)).toBe(true);
    }
    for (const p of [G, "/api/leagues/tabbl/redraft-rolls/abc"]) expect(isStateChangingApiRequest("GET", p)).toBe(false);
    const get = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "GET" } as unknown as IncomingMessage;
    expect(requireSession(get, G, "").kind).toBe("allow");
    expect(requireSession(get, "/api/leagues/tabbl/redraft-rolls/abcdefabcdefabcdefabcdefabcdefab", "").kind).toBe("allow");
    expect((await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" }, ANN)).status).toBe(403);
    expect((await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" }, OTTO)).status).toBe(403);
    expect((await call("PUT", `${G}/registration/season-7`, undefined, { revision: 0, mode: "off" })).status).toBe(401);
    expect((await call("GET", `${G}/registration/season-7`, JAY)).status).toBe(405);
    expect((await call("POST", G, JAY, {})).status).toBe(405);
    expect((await setGate("registration", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" }, ROOT)).status).toBe(201);
    // A GET writes nothing (gates file, seasons untouched), even when a gate is due.
    now = new Date("2026-11-06T00:00:00.000Z");
    const stamp = statSync(join(dir, "leagues", "tabbl", "gates.json")).mtimeMs;
    const seasonStamp = statSync(join(dir, "leagues", "tabbl", "seasons", "season-7.json")).mtimeMs;
    const v = store.version();
    await gates();
    await gates(JAY);
    await call("GET", "/api/leagues/tabbl/schedule", JAY);
    expect(store.version()).toBe(v);
    expect(statSync(join(dir, "leagues", "tabbl", "gates.json")).mtimeMs).toBe(stamp);
    expect(statSync(join(dir, "leagues", "tabbl", "seasons", "season-7.json")).mtimeMs).toBe(seasonStamp);
    // ...and the read already says open (the step is allowed from its minute), before the job flips the state.
    expect((await gateOf("registration:season-7"))?.state).toBe("open");
  });

  it("an unreadable gates file refuses gated steps and leaves projections as they are", async () => {
    await setGate("season-start", "season-7", { mode: "time", opensAt: "2026-11-05T19:00" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(dir, "leagues", "tabbl", "gates.json"), "{not json");
    store.invalidate();
    const start = await call("POST", "/api/leagues/tabbl/seasons/season-7/stage", JAY, { stage: "active" });
    expect(start.status).toBe(503);
    expect((await call("GET", G)).status).toBe(500);
    expect((await job()).failed).toEqual(["tabbl"]);
    expect(syncGateTargets(store, "tabbl", now)).toEqual([]);
  });
});
