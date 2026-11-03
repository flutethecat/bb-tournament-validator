import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Roster } from "@bb/validator";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeagueTeamSheet } from "../src/leagues/registrationApi.js";
import type { ForkScheduleOutcome, LeagueForkClient } from "../src/leagues/forkPlay.js";
import { leagueTeamRevision, type LeagueForkTeamFile } from "../src/leagues/forkTeam.js";
import { leagueStats } from "../src/leagues/stats.js";
import { gameCoach, stampPlayedCoaches } from "../src/leagues/identity.js";
import { backfillPlayedCoaches, entryHistoryLine } from "../src/leagues/teamLibrary.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { registrationContactFor } from "../src/registration/index.js";
import { parseShareScope } from "../src/auth/contactFor.js";
import type { CoachIdentityRecord } from "../src/auth/identitiesStore.js";
import type { NotificationInput } from "../src/notifications.js";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types.js";

// Team library, swap and takeover (spec-team-management-2026-11-02; round answers Q5-Q8). Library visibility (member vs
// non-member, league A vs league B, the scoped organiser only), swap validation and atomicity with the entry history and
// standings kept, the next fork build using the new team / coach, the takeover listing on the overview data only,
// applications through the registration core (apply with a team + the played-games count the approval modal reads; take
// over), ownership transfer with standings and skills kept and records following the coach of each game, the backfill,
// notifications, access control and CSRF. Every test has its own state dir (laws §C14); every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const JAY: LeagueApiIdentity = { coach: "Jay", admin: false, organizer: true };
const KIM: LeagueApiIdentity = { coach: "Kim", admin: false };
const OTTO: LeagueApiIdentity = { coach: "Otto", admin: false, organizer: true };
const ROOT: LeagueApiIdentity = { coach: "Root", admin: true };
const coach = (c: string): LeagueApiIdentity => ({ coach: c, admin: false });
const L = "tabbl";
const S = "season-7";
const base = `/api/leagues/${L}/seasons/${S}`;

const pos = (id: string, name: string, s: { ma: number; st: number; ag: number; pa: number; av: number; cost: number }) =>
  `<position id="${id}"><quantity>16</quantity><name>${name}</name><type>Regular</type><gender>male</gender><cost>${s.cost}</cost>` +
  `<movement>${s.ma}</movement><strength>${s.st}</strength><agility>${s.ag}</agility><passing>${s.pa}</passing><armour>${s.av}</armour><skillList></skillList></position>`;
const HUMAN = '<roster id="human.bb2025"><name>Human</name><reRollCost>50000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("10", "Human Lineman", { ma: 6, st: 3, ag: 3, pa: 4, av: 9, cost: 50000 }) + "</roster>";
const ORC = '<roster id="orc.bb2025"><name>Orc</name><reRollCost>60000</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>' +
  pos("20", "Orc Lineman", { ma: 5, st: 3, ag: 3, pa: 4, av: 10, cost: 50000 }) + "</roster>";
const ROSTERS = new Map([["human.bb2025", HUMAN], ["orc.bb2025", ORC]]);

const player = (playerId: string, number: number, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId, number, name: `P${number}`, position: "Lineman", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: [], value: 50000, level: "Rookie", availableSpp: 0, niggling: 0,
  missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});
const team = (id: string, name: string, race: string, who: string, over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id, name, race, coach: who, coachId: who, teamValue: 600_000, treasury: 50_000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "2", raceLeague: "", players: Array.from({ length: 11 }, (_, i) => player(`${id}-p${i + 1}`, i + 1)), formerPlayers: [], ...over,
});
const side = (t: LeagueTeam, score: number | null) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score, cas: score === null ? null : 0, conceded: false });
const fixture = (id: string, round: number, home: LeagueTeam, away: LeagueTeam, hs: number | null, as: number | null, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1, home: side(home, hs), away: side(away, as), suspended: false, ...over,
});

function rosterOf(race: string): Roster {
  return {
    rosterName: race, coach: "anyone", teamName: "T",
    sideline: { apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, reRolls: 2 },
    inducements: [], leagues: [], specialRules: [],
    players: Array.from({ length: 11 }, (_, i) => ({ number: i + 1, positionName: "Lineman", MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: i === 0 ? ["Block"] : [], keywords: [], cost: 50_000 })),
    summary: { playersCost: 550_000, skillsCost: 0, inducementCost: 0, sidelineCost: 100_000, total: 650_000 },
  } as Roster;
}

/** The fake team check: "*-human" / "*-orc" refs fit; "save:bad" breaks the rules. */
function sheetFor(c: string, ref: string, pkg: string): LeagueTeamSheet | { error: string; status?: number } {
  if (ref === "save:bad") return { teamName: `${c} Broken`, savePackage: pkg, validation: { ok: false, problems: ["Too many big guys."] }, roster: rosterOf("Orc") };
  if (ref.endsWith("-human")) return { teamName: `${c} Hammers`, savePackage: pkg, validation: { ok: true, problems: [] }, roster: rosterOf("Human"), ...(ref.startsWith("library:") ? { libraryTeamId: ref.slice(8) } : {}) };
  if (ref.endsWith("-orc")) return { teamName: `${c} Tuskers`, savePackage: pkg, validation: { ok: true, problems: [] }, roster: rosterOf("Orc") };
  return { error: "Team Builder save not found.", status: 404 };
}

interface Sent { coach: string; input: NotificationInput }

function stubFork() {
  const s = {
    installs: [] as Array<Array<{ coach: string; file: LeagueForkTeamFile }>>,
    next: { kind: "rejected", error: "no slot" } as ForkScheduleOutcome,
    client: undefined as unknown as LeagueForkClient,
  };
  s.client = {
    rosters: () => ROSTERS,
    async prepareGame({ install }) { if (install.length) s.installs.push(install); return s.next; },
    async findGame() { return { kind: "none" }; },
    async deleteGame() { return true; },
    async launchFile() { return "<jnlp/>"; },
    async gameStates() { return new Map(); },
    async result() { return undefined; },
  } as LeagueForkClient;
  return s;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "bbtv-tlib-"));
  roots.push(root);
  const store = new LeagueStore(root);
  const sent: Sent[] = [];
  const acked = new Set<string>(); // "<league>:<coach>"
  const identities: Record<string, CoachIdentityRecord> = {};
  const faults = { failNextWrite: false };
  const fork = stubFork();
  store.upsertLeague({ id: L, name: "TABBL", fullName: "TABBL", slug: L, organisers: ["Jay", "Kim"], owner: "Jay", playOnFork: true } as never);
  store.upsertLeague({ id: "other", name: "Other BBL", fullName: "Other BBL", slug: "other", organisers: ["Otto"], owner: "Otto" } as never);
  // Kim organises TABBL? No: Kim is listed so the record-change note has a recipient; KIM below acts as an organiser too.
  const grudge = team("grudge", "Grudge Rollers", "Human", "Ann", { players: [player("grudge-p1", 1, { skills: ["Block"], availableSpp: 6, stats: { ...EMPTY_PLAYER_STATS, td: 2, spp: 6 } }), ...Array.from({ length: 10 }, (_, i) => player(`grudge-p${i + 2}`, i + 2))] });
  const orcs = team("orcs", "Green Tide", "Orc", "Bob");
  const season7: SeasonRecord = {
    id: S, leagueId: L, number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [
      fixture("f1", 1, grudge, orcs, 2, 1),
      fixture("f2", 2, orcs, grudge, 0, 0),
      fixture("f3", 3, grudge, orcs, null, null, { forkEnabled: true }),
    ],
    participants: [
      { coach: "Ann", coachId: "Ann", country: "", race: "Human", team: "Grudge Rollers", active: true, teamId: "grudge" },
      { coach: "Bob", coachId: "Bob", country: "", race: "Orc", team: "Green Tide", active: true, teamId: "orcs" },
    ],
    teams: [grudge, orcs], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
  };
  store.putSeason(season7);
  // Ann's other league teams: an older finished TABBL season (fits), a BB2020 team elsewhere (greyed), a team still playing.
  store.putSeason({ ...structuredClone(season7), id: "season-6", number: 6, name: "Season 6", sourceSlug: "s6", status: "completed", fixtures: [], participants: [],
    teams: [team("oldham", "Oldham Ironsides", "Human", "Ann", { teamUid: "tm-aaaaaaaaaaaa" })] });
  const otherActive: SeasonRecord = { ...structuredClone(season7), id: "season-1", leagueId: "other", number: 1, name: "Season 1", sourceSlug: "o1", fixtures: [], participants: [],
    teams: [team("busy", "Busy Bees", "Human", "Ann"), team("relic", "Relic Rovers", "Human", "Bob")] };
  store.putSeason(otherActive);
  store.putSeason({ ...structuredClone(otherActive), id: "season-0", number: 0, name: "Season 0", sourceSlug: "o0", ruleset: "BB2020", status: "completed",
    teams: [team("vintage", "Vintage Vipers", "Human", "Ann")] });
  acked.add(`${L}:ann`);
  acked.add(`${L}:bob`);
  acked.add("other:ann");

  const coachTeams: Record<string, Array<{ ref: string; kind: "save" | "library"; name: string; race: string; tv: number | null }>> = {
    ann: [
      { ref: "save:s1-human", kind: "save", name: "Ann Hammers", race: "Human", tv: 650_000 },
      { ref: "save:bad", kind: "save", name: "Broken", race: "Orc", tv: null },
      { ref: "library:lib1-human", kind: "library", name: "Ann Library", race: "Human", tv: 1_000 },
    ],
    eve: [{ ref: "save:e1-orc", kind: "save", name: "Eve Tuskers", race: "Orc", tv: 650_000 }, { ref: "save:bad", kind: "save", name: "Broken", race: "Orc", tv: null }],
    dan: [{ ref: "save:d1-human", kind: "save", name: "Dan Hammers", race: "Human", tv: 650_000 }],
  };
  const identityFor = (c: string): CoachIdentityRecord => {
    const k = c.toLowerCase();
    identities[k] ??= { ffbCoachId: c, contact: { email: `${k}@example.test`, emailSource: "user", emailVerified: true, phones: [] }, profile: { preferredName: `${c} P` }, consent: {} } as unknown as CoachIdentityRecord;
    return identities[k]!;
  };
  let body: unknown;
  const deps = (): LeagueApiDeps => ({
    store,
    fork: fork.client,
    readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))),
    now: () => new Date("2026-11-03T12:00:00.000Z"),
    identities: () => [{ coach: "Jay", level: "organizer" }, { coach: "Root", level: "admin" }, { coach: "Otto", level: "organizer" }],
    notify: (c, input) => { sent.push({ coach: c, input }); },
    memberContact: (_viewer, c, leagueId) => (acked.has(`${leagueId}:${c.toLowerCase()}`) ? { coach: c } : undefined),
    leagueTeamSheet: (c, ref, pkg) => sheetFor(c, ref, pkg),
    coachTeams: (c) => coachTeams[c.toLowerCase()] ?? [],
    registrationSharing: {
      acknowledge: (c, leagueId, fields, at) => {
        acked.add(`${leagueId}:${c.toLowerCase()}`);
        const rec = identityFor(c);
        const consent = (rec.consent ?? {}) as NonNullable<CoachIdentityRecord["consent"]>;
        rec.consent = { ...consent, leagues: { ...(consent.leagues ?? {}), [leagueId]: { at: at.toISOString(), version: "v1" } }, sharing: { ...(consent.sharing ?? {}), [`league:${leagueId}`]: { fields, at: at.toISOString(), version: "v1" } } } as CoachIdentityRecord["consent"];
      },
      contacts: (viewer, entries, managers) => entries.map((e) => registrationContactFor(viewer, identities[e.coach.toLowerCase()], parseShareScope(`league:${e.competitionId}`)!, e, managers)),
    },
    teamLibraryBeforeWrite: () => { if (faults.failNextWrite) { faults.failNextWrite = false; throw new Error("disk full"); } },
  });
  const call = async (method: string, path: string, auth?: LeagueApiIdentity, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const season = (id = S, leagueId = L) => store.season(leagueId, id)!;
  const rev = () => season().revision ?? 0;
  const list = async (available: boolean, auth: LeagueApiIdentity = JAY, teamId = "grudge") => call("POST", `${base}/teams/${teamId}/takeover`, auth, { revision: rev(), available });
  const listingId = (teamId = "grudge") => season().teams.find((t) => t.id === teamId)!.takeover!.id;
  const apply = (who: string, b: Record<string, unknown>, listing = listingId()) => call("POST", `${base}/takeovers/${listing}/applications`, coach(who), b);
  const panel = async (auth: LeagueApiIdentity) => (await call("GET", `${base}/takeovers`, auth)).body as Record<string, any>;
  return { store, sent, acked, fork, faults, call, season, rev, list, listingId, apply, panel };
}

const standingOf = async (h: ReturnType<typeof harness>, teamId: string) => {
  const r = await h.call("GET", base);
  const s = (r.body as { season: SeasonRecord }).season;
  return s.phases[0]!.standings.find((x) => x.teamId === teamId)!;
};

// ---- library visibility --------------------------------------------------------------------------------------------------

describe("coach libraries for organisers", () => {
  it("a member's library: saves, library teams and other league teams, greyed with the reason when they don't fit", async () => {
    const h = harness();
    const r = await h.call("GET", `${base}/library/Ann`, JAY);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = (r.body as { items: Array<Record<string, any>> }).items;
    const by = (ref: string) => items.find((i) => i.ref === ref)!;
    expect(by("save:s1-human")).toMatchObject({ kind: "save", ok: true, race: "Human" });
    expect(by("save:bad")).toMatchObject({ ok: false, reason: "Too many big guys." });
    expect(by("library:lib1-human")).toMatchObject({ kind: "library", ok: true });
    expect(by(`league:${L}/season-6/oldham`)).toMatchObject({ kind: "league", ok: true, source: "TABBL Season 6" });
    expect(by("league:other/season-0/vintage")).toMatchObject({ ok: false, reason: "Built for BB2020; this season plays BB2025." });
    expect(by("league:other/season-1/busy")).toMatchObject({ ok: false, reason: "Still playing in Other BBL Season 1." });
    expect(by(`league:${L}/${S}/grudge`)).toMatchObject({ ok: false, reason: "Already in this season." });
    // other coaches' teams never appear
    expect(items.some((i) => i.ref === "league:other/season-1/relic")).toBe(false);
    // the swap dialog's per-team read names the team in the entry
    const t = await h.call("GET", `${base}/teams/grudge/library`, JAY);
    expect((t.body as { items: Array<Record<string, any>> }).items.find((i) => i.ref === `league:${L}/${S}/grudge`)).toMatchObject({ reason: "This is the team in the entry now." });
    expect((t.body as Record<string, any>).team).toMatchObject({ id: "grudge", games: 2 });
  });

  it("non-members, members who haven't shared, and unknown coaches all answer the same 404", async () => {
    const h = harness();
    const eve = await h.call("GET", `${base}/library/Eve`, JAY); // not on the league's roster
    const nobody = await h.call("GET", `${base}/library/Nobody`, JAY);
    expect(eve.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(eve.body).toEqual(nobody.body);
    h.acked.delete(`${L}:bob`);
    expect((await h.call("GET", `${base}/library/Bob`, JAY)).status).toBe(404);
    const t = await h.call("GET", `${base}/teams/orcs/library`, JAY);
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ items: [], reason: expect.stringContaining("hasn't shared") });
  });

  it("organisers of league A see nothing in league B; plain coaches and anonymous callers are refused", async () => {
    const h = harness();
    expect((await h.call("GET", `${base}/library/Ann`, OTTO)).status).toBe(403);
    expect((await h.call("GET", `${base}/teams/grudge/library`, OTTO)).status).toBe(403);
    // Ann is a member of Other too, but Jay doesn't organise it
    expect((await h.call("GET", "/api/leagues/other/seasons/season-1/library/Ann", JAY)).status).toBe(403);
    expect((await h.call("GET", `${base}/library/Ann`, coach("Bob"))).status).toBe(403);
    expect((await h.call("GET", `${base}/library/Ann`)).status).toBe(401);
    // a site admin may
    expect((await h.call("GET", `${base}/library/Ann`, ROOT)).status).toBe(200);
    // Otto sees Ann's library in HIS league (she shares with it), never TABBL's teams' entries
    const o = await h.call("GET", "/api/leagues/other/seasons/season-1/library/Ann", OTTO);
    expect(o.status).toBe(200);
    // no host identity lookup: fail closed
    const r = await leagueApi("GET", `${base}/library/Ann`, new URLSearchParams(), JAY, { store: h.store, coachTeams: () => [] });
    expect(r!.status).toBe(404);
  });
});

// ---- swap -------------------------------------------------------------------------------------------------------------

describe("swap", () => {
  it("validates against the season rules and changes nothing on a refusal", async () => {
    const h = harness();
    const before = readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8");
    const bad = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:bad" });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ error: "Too many big guys.", code: "invalid-team" });
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "league:other/season-0/vintage" })).status).toBe(400);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:e1-orc" })).status).toBe(404); // not Ann's
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { ref: "save:s1-human" })).status).toBe(428);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev() - 1, ref: "save:s1-human" })).status).toBe(409);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, OTTO, { revision: h.rev(), ref: "save:s1-human" })).status).toBe(403);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, coach("Ann"), { revision: h.rev(), ref: "save:s1-human" })).status).toBe(403);
    expect(readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8")).toBe(before);
  });

  it("keeps the entry's standings and fixtures, lists both teams in the entry history, in one season write", async () => {
    const h = harness();
    const st = await standingOf(h, "grudge");
    expect(st).toMatchObject({ played: 2, wins: 1, draws: 1, points: 4 });
    const revBefore = h.rev();
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: revBefore, ref: "save:s1-human" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.rev()).toBe(revBefore + 1); // ONE season write
    expect((r.body as Record<string, unknown>).entryHistory).toBe("Grudge Rollers (games 1-2), Ann Hammers (games 3-)");
    const s = h.season();
    const t = s.teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ id: "grudge", name: "Ann Hammers", coachId: "Ann", race: "Human" });
    expect(t.entryId).toMatch(/^en-/);
    expect(t.players).toHaveLength(11);
    expect(t.players[0]!.skills).toContain("Block");
    // the old roster's season records stay under "Left the roster"; the replaced team is kept in the entry history
    expect(t.formerPlayers.map((p) => p.playerId)).toContain("grudge-p1");
    expect(t.entryHistory![0]).toMatchObject({ name: "Grudge Rollers", fromGame: 1, toGame: 2, via: "start" });
    expect(t.entryHistory![0]!.outgoing!.players).toHaveLength(11);
    expect(t.entryHistory![1]).toMatchObject({ name: "Ann Hammers", fromGame: 3, via: "swap", by: "Jay" });
    expect(t.history![0]).toMatchObject({ kind: "swap", by: "Jay" });
    // played fixtures keep the team and coach that played; the unplayed one names the new team
    expect(s.fixtures.find((f) => f.id === "f1")!.home).toMatchObject({ team: "Grudge Rollers", teamId: "grudge", playedBy: { coach: "Ann", coachId: "Ann" } });
    expect(s.fixtures.find((f) => f.id === "f3")!.home).toMatchObject({ team: "Ann Hammers", teamId: "grudge", coachId: "Ann" });
    expect(s.participants.find((p) => p.teamId === "grudge")).toMatchObject({ team: "Ann Hammers", coachId: "Ann" });
    // the standings row is the entry's: same games, same points
    expect(await standingOf(h, "grudge")).toMatchObject({ played: 2, wins: 1, draws: 1, points: 4 });
    // the public read carries the entry history without the replaced roster or the actor
    const pub = ((await h.call("GET", base)).body as { season: SeasonRecord }).season;
    const span = pub.teams.find((x) => x.id === "grudge")!.entryHistory!;
    expect(span).toHaveLength(2);
    expect(span[0]).not.toHaveProperty("outgoing");
    expect(span[1]).not.toHaveProperty("by");
    expect(entryHistoryLine(span)).toBe("Grudge Rollers (games 1-2), Ann Hammers (games 3-)");
  });

  it("is atomic: a failed write leaves the season exactly as it was", async () => {
    const h = harness();
    const before = readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8");
    h.faults.failNextWrite = true;
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    expect(r.status).toBe(500);
    expect(readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8")).toBe(before);
    expect(h.sent).toHaveLength(0);
  });

  it("swaps in another league team of the coach: the same team, fresh player ids, this season's counters at zero", async () => {
    const h = harness();
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: `league:${L}/season-6/oldham` });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = h.season().teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ name: "Oldham Ironsides", teamUid: "tm-aaaaaaaaaaaa" });
    expect(t.players[0]!.previousIds).toEqual(["oldham-p1"]);
    expect(t.players[0]!.playerId).not.toBe("oldham-p1");
  });

  it("tells the coach and the other organisers (record-change note), never the actor", async () => {
    const h = harness();
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    const to = h.sent.map((s) => s.coach);
    expect(to).toContain("Ann");
    expect(to).toContain("Kim");
    expect(to).not.toContain("Jay");
    expect(h.sent.find((s) => s.coach === "Ann")!.input.title).toBe("Your team in TABBL was swapped");
    expect(h.sent.find((s) => s.coach === "Kim")!.input.title).toContain("Grudge Rollers swapped for Ann Hammers");
  });

  it("the next fork build uses the new team; a scheduled game blocks the swap", async () => {
    const h = harness();
    const s = h.season();
    const f3 = s.fixtures.find((f) => f.id === "f3")!;
    // teams built for f3 from the old rosters, no game yet
    f3.fork = { status: "teams_built", teams: {
      home: { teamId: "grudge", forkTeamId: "lg_x", coach: "Ann", builtAt: "2026-11-01T00:00:00.000Z", players: [], revision: leagueTeamRevision(s.teams[0]!) },
      away: { teamId: "orcs", forkTeamId: "lg_y", coach: "Bob", builtAt: "2026-11-01T00:00:00.000Z", players: [], revision: leagueTeamRevision(s.teams[1]!) },
    }, log: [] };
    h.store.putSeason(s);
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    h.fork.next = { kind: "scheduled", gameId: "g1" };
    const g = await h.call("POST", `${base}/fixtures/f3/fork/generate`, JAY, {});
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    // only the swapped side is rebuilt, from the new roster, for the entry's coach
    expect(h.fork.installs).toHaveLength(1);
    expect(h.fork.installs[0]!.map((i) => i.file.library.teamName)).toEqual(["Ann Hammers"]);
    expect(h.fork.installs[0]![0]!.coach).toBe("Ann");
    // the game now exists: no swap until it is reset or finished
    const blocked = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "library:lib1-human" });
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: string }).error).toContain("Super FUMBBL game exists");
  });

  it("is a CSRF-covered state change; the library is a plain GET", () => {
    expect(isStateChangingApiRequest("POST", `${base}/teams/grudge/swap`)).toBe(true);
    expect(isStateChangingApiRequest("POST", `${base}/teams/grudge/takeover`)).toBe(true);
    expect(isStateChangingApiRequest("POST", `${base}/takeovers/tk-000000000000/applications`)).toBe(true);
    expect(isStateChangingApiRequest("POST", `${base}/takeovers/tk-000000000000/applications/ta-000000000000/approve`)).toBe(true);
    expect(isStateChangingApiRequest("GET", `${base}/teams/grudge/library`)).toBe(false);
  });

  it("GETs never write", async () => {
    const h = harness();
    await h.list(true);
    const before = readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8");
    for (const p of [`${base}/library/Ann`, `${base}/teams/grudge/library`, `${base}/takeovers`, `${base}/takeovers/my-teams`]) await h.call("GET", p, JAY);
    expect(readFileSync(join(h.store.leagueDir(L), "seasons", `${S}.json`), "utf8")).toBe(before);
  });
});

// ---- takeover listing + applications --------------------------------------------------------------------------------------

describe("available for takeover", () => {
  it("organisers or admins list a team; the public read shows the listing without who listed it; GET panel is signed-in only", async () => {
    const h = harness();
    expect((await h.list(true, coach("Ann"))).status).toBe(403);
    expect((await h.list(true, OTTO)).status).toBe(403);
    const r = await h.list(true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.season().teams[0]!.takeover).toMatchObject({ by: "Jay", since: "2026-11-03T12:00:00.000Z" });
    const pub = ((await h.call("GET", base)).body as { season: SeasonRecord }).season;
    expect(pub.teams[0]!.takeover).toEqual({ id: h.listingId(), since: "2026-11-03T12:00:00.000Z" });
    expect(pub).not.toHaveProperty("takeoverApplications");
    expect((await h.call("GET", `${base}/takeovers`)).status).toBe(401);
    const p = await h.panel(coach("Eve"));
    expect(p).toMatchObject({ member: false, listings: [{ teamId: "grudge", name: "Grudge Rollers", games: 2, mine: false }], mine: [] });
    expect(p).not.toHaveProperty("applications");
    expect((await h.panel(coach("Ann"))).listings[0].mine).toBe(true);
    // admins too
    expect((await h.list(true, ROOT, "orcs")).status).toBe(200);
  });

  it("the Browse leagues list has no takeover filter or field (overview only)", async () => {
    const h = harness();
    await h.list(true);
    const r = await h.call("GET", "/api/leagues", undefined);
    expect(JSON.stringify(r.body)).not.toMatch(/takeover/i);
  });

  it("apply with a team: pending, organisers told; approval substitutes it, other applications are declined; the panel gives the played games", async () => {
    const h = harness();
    await h.list(true);
    // the team's own coach can't apply; non-members must acknowledge the league notice
    expect((await h.apply("Ann", { mode: "takeover" })).status).toBe(400);
    expect((await h.apply("Eve", { mode: "team", teamRef: "save:e1-orc", share: [] })).status).toBe(400);
    expect((await h.apply("Eve", { mode: "team", teamRef: "save:bad", share: [], acknowledged: true })).body).toMatchObject({ code: "invalid-team" });
    const a = await h.apply("Eve", { mode: "team", teamRef: "save:e1-orc", share: ["email"], acknowledged: true });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ application: { state: "pending", mode: "team", teamName: "Eve Tuskers" } });
    expect((await h.apply("Eve", { mode: "takeover", share: [], acknowledged: true })).status).toBe(409);
    expect(h.acked.has(`${L}:eve`)).toBe(true);
    const told = h.sent.filter((s) => s.input.type === "registration").map((s) => s.coach).sort();
    expect(told).toEqual(["Jay", "Kim"]);
    // Bob (a member) applies to take it over: no acknowledgement asked
    const b = await h.apply("Bob", { mode: "takeover" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    // organisers see both with what the coach shared; the coach sees only their own
    const org = await h.panel(JAY);
    const eveRow = org.applications.find((x: any) => x.coachId === "Eve");
    expect(eveRow).toMatchObject({ state: "pending", mode: "team", games: 2, member: false, shared: { email: "eve@example.test" } });
    expect((await h.panel(coach("Eve"))).mine).toHaveLength(1);
    expect(await h.panel(coach("Eve"))).not.toHaveProperty("applications");
    // only organisers decide
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${eveRow.id}/approve`, coach("Eve"), {})).status).toBe(403);
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${eveRow.id}/approve`, OTTO, {})).status).toBe(403);
    const listing = h.listingId();
    const ok = await h.call("POST", `${base}/takeovers/${listing}/applications/${eveRow.id}/approve`, JAY, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ application: { state: "accepted" }, teamId: "grudge", games: 2, mode: "team" });
    expect((ok.body as { editLink: string }).editLink).toContain("team=grudge&edit=1");
    const s = h.season();
    const t = s.teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ name: "Eve Tuskers", race: "Orc", coachId: "Eve" });
    expect(t.takeover).toBeUndefined();
    expect(entryHistoryLine(t.entryHistory)).toBe("Grudge Rollers (games 1-2), Eve Tuskers (games 3-)");
    expect(s.participants.find((p) => p.teamId === "grudge")).toMatchObject({ coachId: "Eve" }); // the membership row
    const bobRow = s.takeoverApplications!.find((r) => r.coach === "Bob")!;
    expect(bobRow).toMatchObject({ state: "declined", decided: { reason: "Another application was approved." } });
    expect(h.sent.some((x) => x.coach === "Bob" && x.input.title === "Application closed: Grudge Rollers")).toBe(true);
    expect(h.sent.some((x) => x.coach === "Ann" && x.input.title === "Grudge Rollers has a new coach")).toBe(true);
    expect(h.sent.some((x) => x.coach === "Eve" && x.input.type === "registration-outcome" && /You're in/.test(x.input.title))).toBe(true);
    expect(await standingOf(h, "grudge")).toMatchObject({ played: 2, points: 4 });
    // the listing is closed
    expect((await h.call("POST", `${base}/takeovers/${listing}/applications/${bobRow.id}/approve`, JAY, {})).status).toBe(409);
  });

  it("take over: ownership transfers, standings and skills stay, past games stay with the old coach, future games count for the new one", async () => {
    const h = harness();
    await h.list(true);
    const a = await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const statsBefore = (await h.call("GET", `/api/leagues/${L}/stats`)).body as ReturnType<typeof leagueStats>;
    const annBefore = statsBefore.coaches.find((c) => c.coach === "Ann")!;
    const id = h.season().takeoverApplications![0]!.id;
    const ok = await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, KIM, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ mode: "takeover", games: 2 });
    const t = h.season().teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ name: "Grudge Rollers", coach: "Dan", coachId: "Dan" });
    expect(t.players[0]!.skills).toContain("Block");
    expect(t.players[0]!.availableSpp).toBe(6);
    expect(entryHistoryLine(t.entryHistory)).toBe("Grudge Rollers (games 1-2), Grudge Rollers (games 3-)");
    expect(t.entryHistory!.map((x) => x.coach)).toEqual(["Ann", "Dan"]);
    expect(await standingOf(h, "grudge")).toMatchObject({ played: 2, wins: 1, draws: 1, points: 4, coach: "Dan" });
    // records follow the coach of each game: Dan inherits nothing, Ann keeps hers
    let stats = (await h.call("GET", `/api/leagues/${L}/stats`)).body as ReturnType<typeof leagueStats>;
    expect(stats.coaches.find((c) => c.coach === "Dan")).toBeUndefined();
    expect(stats.coaches.find((c) => c.coach === "Ann")).toMatchObject({ games: annBefore.games, wins: annBefore.wins, draws: annBefore.draws });
    const s = h.season();
    expect(s.fixtures.find((f) => f.id === "f1")!.home).toMatchObject({ coachId: "Ann", playedBy: { coachId: "Ann" } });
    expect(s.fixtures.find((f) => f.id === "f3")!.home).toMatchObject({ coach: "Dan", coachId: "Dan" });
    // the next game is Dan's
    const f3 = s.fixtures.find((f) => f.id === "f3")!;
    f3.home.score = 3; f3.away.score = 0; f3.home.cas = 0; f3.away.cas = 0;
    h.store.putSeason(s);
    expect(h.season().fixtures.find((f) => f.id === "f3")!.home.playedBy).toMatchObject({ coach: "Dan", coachId: "Dan" });
    stats = (await h.call("GET", `/api/leagues/${L}/stats`)).body as ReturnType<typeof leagueStats>;
    expect(stats.coaches.find((c) => c.coach === "Dan")).toMatchObject({ games: 1, wins: 1 });
    expect(stats.coaches.find((c) => c.coach === "Ann")).toMatchObject({ games: annBefore.games, wins: annBefore.wins });
    // the old coach and the other organisers heard
    expect(h.sent.some((x) => x.coach === "Ann" && x.input.title === "Grudge Rollers has a new coach")).toBe(true);
    expect(h.sent.some((x) => x.coach === "Jay" && /taken over/.test(x.input.title))).toBe(true);
    expect(h.sent.some((x) => x.coach === "Kim" && /taken over/.test(x.input.title))).toBe(false);
  });

  it("the next fork build after a takeover seats the new coach", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${h.season().takeoverApplications![0]!.id}/approve`, JAY, {});
    h.fork.next = { kind: "scheduled", gameId: "g9" };
    const g = await h.call("POST", `${base}/fixtures/f3/fork/generate`, JAY, {});
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    expect(h.fork.installs[0]!.map((i) => i.coach)).toEqual(["Dan", "Bob"]);
    expect(h.fork.installs[0]![0]!.file.xml).toContain("<coach>Dan</coach>");
  });

  it("withdraw and decline: the coach's own, the reason shown, a non-member's acknowledgement released; unlisting closes the rest", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Eve", { mode: "takeover", share: [], acknowledged: true });
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    const rows = () => h.season().takeoverApplications!;
    const eve = rows().find((r) => r.coach === "Eve")!;
    const dan = rows().find((r) => r.coach === "Dan")!;
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${eve.id}/withdraw`, coach("Dan"), {})).status).toBe(404);
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${eve.id}/withdraw`, coach("Eve"), {})).status).toBe(200);
    const d = await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${dan.id}/decline`, JAY, { reason: "Full up" });
    expect(d.status).toBe(200);
    expect((await h.panel(coach("Dan"))).mine[0]).toMatchObject({ state: "declined", reason: "Full up" });
    expect(h.sent.some((x) => x.coach === "Dan" && x.input.type === "registration-outcome" && /declined/i.test(x.input.title))).toBe(true);
    // a fresh application on a re-listed team after unlisting
    await h.apply("Bob", { mode: "takeover" });
    const off = await h.list(false);
    expect(off.status).toBe(200);
    expect(rows().find((r) => r.coach === "Bob")).toMatchObject({ state: "declined", decided: { reason: "The team is no longer available for takeover." } });
    expect(h.season().teams[0]!.takeover).toBeUndefined();
  });

  it("an entry id from another season or league is not found; a draft league's listing is not open", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Eve", { mode: "takeover", share: [], acknowledged: true });
    const id = h.season().takeoverApplications![0]!.id;
    expect((await h.call("POST", `/api/leagues/other/seasons/season-1/takeovers/${h.listingId()}/applications/${id}/approve`, OTTO, {})).status).toBe(404);
    expect((await h.call("POST", `${base}/takeovers/tk-000000000000/applications`, coach("Eve"), { mode: "takeover" })).status).toBe(404);
    h.store.updateLeague(L, (lg) => { lg.visibility = "draft"; });
    expect((await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true })).status).toBe(404);
  });
});

// ---- records follow the coach of each game ----------------------------------------------------------------------------------

describe("the coach of each game", () => {
  it("every season write freezes the coach of played sides and drops it from cleared results", () => {
    const s = { fixtures: [
      { home: { team: "A", coach: "Ann", coachId: "Ann", race: "Human", score: 1, cas: 0, conceded: false }, away: { team: "B", coach: "Bob", race: "Orc", score: 0, cas: 0, conceded: false }, suspended: false },
      { home: { team: "A", coach: "Ann", race: "Human", score: null, cas: null, conceded: false, playedBy: { coach: "Old" } }, away: { team: "B", coach: "Bob", race: "Orc", score: null, cas: null, conceded: false }, suspended: false },
    ] } as unknown as SeasonRecord;
    expect(stampPlayedCoaches(s)).toBe(3);
    expect(s.fixtures[0]!.home.playedBy).toEqual({ coach: "Ann", coachId: "Ann" });
    expect(s.fixtures[0]!.away.playedBy).toEqual({ coach: "Bob" });
    expect(s.fixtures[1]!.home.playedBy).toBeUndefined();
    // a stamped side keeps its coach even if the side is re-pointed later
    s.fixtures[0]!.home.coach = "Zed"; s.fixtures[0]!.home.coachId = "Zed";
    expect(stampPlayedCoaches(s)).toBe(0);
    expect(gameCoach(s.fixtures[0]!.home)).toMatchObject({ coach: "Ann", coachId: "Ann", team: "A" });
  });

  it("backfills results written before the stamp with the coach the side recorded then, and nothing else", () => {
    const h = harness();
    const file = join(h.store.leagueDir(L), "seasons", `${S}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8")) as SeasonRecord;
    for (const f of raw.fixtures) { delete f.home.playedBy; delete f.away.playedBy; }
    // the team changed hands after these games (Assign coach account leaves played sides alone)
    raw.teams[0]!.coachId = "Zed";
    raw.teams[0]!.coach = "Zed";
    writeFileSync(file, JSON.stringify(raw));
    h.store.invalidate();
    const dry = backfillPlayedCoaches(h.store, false);
    expect(dry).toEqual({ seasons: 1, sides: 4, nameOnly: 0 });
    expect(h.season().fixtures[0]!.home.playedBy).toBeUndefined();
    const applied = backfillPlayedCoaches(h.store, true);
    expect(applied.sides).toBe(4);
    const s = h.season();
    expect(s.fixtures[0]!.home.playedBy).toEqual({ coach: "Ann", coachId: "Ann" });
    expect(s.fixtures[1]!.away.playedBy).toEqual({ coach: "Ann", coachId: "Ann" });
    expect(s.fixtures[2]!.home.playedBy).toBeUndefined(); // unplayed
    expect(backfillPlayedCoaches(h.store, false).sides).toBe(0);
    // the league statistics count those games for Ann, not the team's current coach
    const stats = leagueStats(h.store.seasons(L), "all");
    expect(stats.coaches.find((c) => c.coach === "Zed")).toBeUndefined();
    expect(stats.coaches.find((c) => c.coach === "Ann")).toMatchObject({ games: 2 });
  });
});

// ---- privacy ------------------------------------------------------------------------------------------------------------

describe("privacy: deletion and export cover the new records", () => {
  it("a deleted coach is anonymised in entry histories, takeover listings and applications, and the frozen coach of a game", async () => {
    const { seed, depsFor } = await import("./privacyFixture.js");
    const { clearFences } = await import("../src/privacy/fence.js");
    const root = mkdtempSync(join(tmpdir(), "bbtv-tlib-priv-"));
    roots.push(root);
    process.env.IDENTITIES_FILE = join(root, "identities.json");
    clearFences();
    await seed(root);
    const deps = depsFor(root);
    const sFile = join(deps.stateDir, "leagues", "l1", "seasons", "s1.json");
    const s = JSON.parse(readFileSync(sFile, "utf8"));
    const t0 = s.teams[0];
    t0.takeover = { id: "tk-aaaaaaaaaaaa", since: "2026-11-02T12:00:00.000Z", by: "Alice" };
    t0.entryHistory = [
      { name: "Old Orcs", race: "Orc", coach: "Alice Smith", coachId: "Alice", fromGame: 1, toGame: 2, via: "start", at: "", outgoing: { id: "x", name: "Old Orcs", coach: "Alice Smith", coachId: "Alice", players: [], formerPlayers: [], history: [] } },
      { name: "Green Orcs", race: "Orc", coach: "Bob", coachId: "Bob", fromGame: 3, via: "swap", at: "", by: "Alice" },
    ];
    s.fixtures[0].home.playedBy = { coach: "Alice Smith", coachId: "Alice", nafUser: "AliceNaf" };
    s.takeoverApplications = [{ id: "ta-aaaaaaaaaaaa", leagueId: "l1", seasonId: "s1", teamId: "x", listingId: "tk-aaaaaaaaaaaa", listedTeam: "Old Orcs", coach: "Alice", state: "pending", submittedAt: "", enteredAt: "", registrationLog: [{ action: "submit", from: null, to: "pending", by: "Alice", at: "" }], mode: "takeover", member: false }];
    writeFileSync(sFile, JSON.stringify(s));
    const collectors = await import("../src/privacy/collectors.js");
    // the export carries Alice's application
    const files = new Map((await collectors.collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const leagues = JSON.parse(files.get("league-teams.json")!);
    expect(leagues[0].seasons[0].takeoverApplications).toHaveLength(1);
    const P = "Deleted coach #1";
    const plan = { jobId: "x".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001", pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
    const ctx = collectors.deleteContext(deps, { ...collectors.splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001" } as never);
    for (const step of collectors.DELETE_STEPS.filter((x) => x.id === "anonymise-leagues")) await step.run(ctx);
    const after = readFileSync(sFile, "utf8");
    const a = JSON.parse(after);
    expect(a.teams[0].takeover.by).toBe(P);
    expect(a.teams[0].entryHistory[0]).toMatchObject({ coach: P, coachId: P });
    expect(a.teams[0].entryHistory[0].outgoing).toMatchObject({ coach: P });
    expect(a.teams[0].entryHistory[1]).toMatchObject({ coach: "Bob", by: P });
    expect(a.fixtures[0].home.playedBy).toMatchObject({ coach: P, coachId: P });
    expect(a.fixtures[0].home.playedBy.nafUser).toBeUndefined();
    expect(a.takeoverApplications[0]).toMatchObject({ coach: P });
    expect(a.takeoverApplications[0].registrationLog[0].by).toBe(P);
    expect(JSON.stringify(a.teams[0].entryHistory)).not.toMatch(/Alice/);
    expect(JSON.stringify(a.takeoverApplications)).not.toMatch(/Alice/);
  });
});
