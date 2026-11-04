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
import { maskToken } from "../src/leagues/teamLibraryApi.js";
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
  const exits: string[] = [];
  const store = new LeagueStore(root, { onRosterExit: (_l, coaches) => exits.push(...coaches) });
  const matches: Array<{ fixtureRef?: string; state: string }> = [];
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
    teams: [team("vintage", "Vintage Vipers", "Human", "Ann", { transfer: { permitted: true, by: "Ann", at: "2026-10-01T00:00:00.000Z" } })] });
  acked.add(`${L}:ann`);
  acked.add(`${L}:bob`);
  acked.add("other:ann");

  const coachTeams: Record<string, Array<{ ref: string; kind: "save"; name: string; race: string; tv: number | null; shared?: boolean }>> = {
    ann: [
      { ref: "save:s1-human", kind: "save", name: "Ann Hammers", race: "Human", tv: 650_000, shared: true },
      { ref: "save:bad", kind: "save", name: "Broken", race: "Orc", tv: null, shared: true },
      { ref: "save:p1-human", kind: "save", name: "Ann Private", race: "Human", tv: 1_000_000 },
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
    tabletop: { listMatches: async () => matches as never, readEvents: async () => [] },
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
  return { store, sent, acked, fork, faults, exits, matches, coachTeams, call, season, rev, list, listingId, apply, panel };
}

/** The opaque token organisers get for one of Ann's masked teams (per league, entry and coach). */
const tok = (ref: string, entry = "grudge", owner = "Ann"): string => maskToken(L, entry, owner, ref);

const standingOf = async (h: ReturnType<typeof harness>, teamId: string) => {
  const r = await h.call("GET", base);
  const s = (r.body as { season: SeasonRecord }).season;
  return s.phases[0]!.standings.find((x) => x.teamId === teamId)!;
};

// ---- library visibility --------------------------------------------------------------------------------------------------

describe("coach libraries for organisers", () => {
  it("a member's library: saved teams and league teams, greyed with the reason; another league's teams only with a permitted transfer, masked", async () => {
    const h = harness();
    const r = await h.call("GET", `${base}/library/Ann`, JAY);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = (r.body as { items: Array<Record<string, any>> }).items;
    const by = (ref: string) => items.find((i) => i.ref === ref)!;
    expect(by("save:s1-human")).toMatchObject({ kind: "save", ok: true, race: "Human" });
    expect(by("save:bad")).toMatchObject({ ok: false, reason: "Too many big guys." });
    // a team the coach never shared shows as private: no name, race, value or check result
    // a generic member read can't ask anyone: another coach's private team is greyed
    expect(by(tok("save:p1-human", ""))).toEqual({ ref: tok("save:p1-human", ""), kind: "save", name: "Private saved team", race: "", tv: null, ok: false, private: true, reason: "Not shared with the organisers." });
    expect(items.every((i) => i.kind === "save" || i.kind === "league")).toBe(true); // no fork library teams
    expect(by(`league:${L}/season-6/oldham`)).toMatchObject({ kind: "league", ok: true, source: "TABBL Season 6" });
    // another league's team: listed only when its coach permits a transfer, and masked from these organisers
    expect(by(tok("league:other/season-0/vintage", ""))).toEqual({ ref: tok("league:other/season-0/vintage", ""), kind: "league", name: "League team (transfer permitted)", race: "", tv: null, ok: false, private: true, reason: "Only its coach can offer it." });
    expect(by("league:other/season-1/busy")).toBeUndefined(); // no transfer permitted
    expect(by(`league:${L}/${S}/grudge`)).toMatchObject({ ok: false, reason: "Already in this season." });
    // other coaches' teams never appear
    expect(items.some((i) => i.ref === "league:other/season-1/relic")).toBe(false);
    // the swap dialog's per-team read names the team in the entry
    const t = await h.call("GET", `${base}/teams/grudge/library`, JAY);
    const titems = (t.body as { items: Array<Record<string, any>> }).items;
    expect(titems.find((i) => i.ref === `league:${L}/${S}/grudge`)).toMatchObject({ reason: "This is the team in the entry now." });
    // for the entry's own coach a private team can be asked for
    expect(titems.find((i) => i.ref === tok("save:p1-human"))).toMatchObject({ ok: true, private: true });
    expect(titems.find((i) => i.ref === tok("league:other/season-0/vintage"))).toMatchObject({ ok: true, private: true });
    // the coach's own view shows their teams in full, with the reasons
    const mine = (await h.call("GET", `${base}/my-teams`, coach("Ann"))).body as { items: Array<Record<string, any>> };
    expect(mine.items.find((i) => i.ref === "league:other/season-0/vintage")).toMatchObject({ name: "Vintage Vipers", ok: false, reason: "Built for BB2020; this season plays BB2025." });
    expect(mine.items.find((i) => i.ref === "save:p1-human")).toMatchObject({ name: "Ann Hammers", ok: true });
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
    // another league's team without a permitted transfer is not in the library at all
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "league:other/season-1/busy" })).status).toBe(404);
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
    const blocked = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:p1-human") });
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
    expect(s.fixtures[0]!.home.playedBy).toEqual({ coach: "Ann", coachId: "Ann", span: 0 });
    expect(s.fixtures[1]!.away.playedBy).toEqual({ coach: "Ann", coachId: "Ann", span: 0 });
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

// ---- review round (Sol, 11-03): guards, locks, consent, replays, registration row, listings -----------------------------

describe("review: the team behind an entry changes only when nothing can credit the wrong coach", () => {
  it("P1: a cancelled fork game that still holds a game id blocks a swap and a takeover approval", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    const s = h.season();
    s.fixtures.find((f) => f.id === "f3")!.fork = { status: "cancelled", statusBeforeCancel: "scheduled", gameId: "g77", teams: {}, log: [] };
    h.store.putSeason(s);
    const swap = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    expect(swap.status).toBe(409);
    expect((swap.body as { error: string }).error).toContain("Super FUMBBL game exists");
    const id = h.season().takeoverApplications![0]!.id;
    const ok = await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, JAY, {});
    expect(ok.status).toBe(409);
    expect(h.season().teams.find((t) => t.id === "grudge")!.coachId).toBe("Ann");
    // an applied result frees it
    const s2 = h.season();
    s2.fixtures.find((f) => f.id === "f3")!.fork!.result = { gameId: "g77", source: "basic", appliedAt: "x", home: { score: 1, cas: 0, conceded: false, winnings: 0, lines: [] }, away: { score: 0, cas: 0, conceded: false, winnings: 0, lines: [] } };
    h.store.putSeason(s2);
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, JAY, {})).status).toBe(200);
  });

  it("P2-5: an unpublished recorder match on the team's fixtures blocks a swap and an approval", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    h.matches.push({ fixtureRef: `league:${L}:${S}:f3`, state: "submitted" });
    const swap = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    expect(swap.status).toBe(409);
    expect((swap.body as { error: string }).error).toContain("tabletop match");
    const id = h.season().takeoverApplications![0]!.id;
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, JAY, {})).status).toBe(409);
    // another season's match, or a published one, does not block
    h.matches[0]!.state = "published";
    h.matches.push({ fixtureRef: `league:${L}:season-6:f3`, state: "recording" });
    expect((await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, JAY, {})).status).toBe(200);
  });

  it("P2-2: a swap waits for a fork generate holding the team's locks, then is judged against what it recorded", async () => {
    const h = harness();
    const { withForkLocks, fixtureLockKey } = await import("../src/leagues/forkPlay.js");
    const { forkTeamIdFor } = await import("../src/leagues/forkTeam.js");
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>((r) => { entered = r; });
    const generate = withForkLocks([fixtureLockKey(L, S, "f3")], [forkTeamIdFor(L, S, "grudge")], async () => {
      entered();
      await held;
      // what the generate recorded while holding the locks: a scheduled game for the team
      const s = h.season();
      s.fixtures.find((f) => f.id === "f3")!.fork = { status: "scheduled", gameId: "g5", teams: {}, log: [] };
      h.store.putSeason(s);
    });
    await inside;
    const swap = h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" });
    await new Promise((r) => setTimeout(r, 30));
    expect(h.season().teams.find((t) => t.id === "grudge")!.name).toBe("Grudge Rollers"); // still waiting
    release();
    await generate;
    const r = await swap;
    expect(r.status).toBe(409); // judged under the lock: the season moved on and the game now exists
    expect(h.season().teams.find((t) => t.id === "grudge")!.name).toBe("Grudge Rollers");
  });
});

describe("review: an organiser never sees or uses a private team without the coach's consent", () => {
  it("P2-3: unshared saves show as private; picking one asks the coach, who sees which team and approves", async () => {
    const h = harness();
    h.coachTeams.ann!.push({ ref: "save:secret-human", kind: "save", name: "Secret Squirrels", race: "Human", tv: 900_000 });
    const lib = await h.call("GET", `${base}/teams/grudge/library`, JAY);
    const item = (lib.body as { items: Array<Record<string, unknown>> }).items.find((i) => i.ref === tok("save:secret-human"))!;
    expect(item).toEqual({ ref: tok("save:secret-human"), kind: "save", name: "Private saved team", race: "", tv: null, ok: true, private: true });
    expect(JSON.stringify(lib.body)).not.toContain("Secret Squirrels");
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:secret-human") });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ requested: true });
    const t = h.season().teams.find((x) => x.id === "grudge")!;
    expect(t.name).toBe("Grudge Rollers");
    expect(t.swapRequest).toMatchObject({ ref: "save:secret-human", by: "Jay" });
    expect(h.sent.find((x) => x.coach === "Ann")!.input).toMatchObject({ title: "Swap request: Grudge Rollers", action: true });
    // the organiser sees that a request waits, never the team; the coach sees it; the public read has nothing
    const asOrg = await h.call("GET", `${base}/teams/grudge/swap-request`, JAY);
    expect(JSON.stringify(asOrg.body)).not.toContain("Secret");
    const asCoach = await h.call("GET", `${base}/teams/grudge/swap-request`, coach("Ann"));
    expect(asCoach.body).toMatchObject({ request: { by: "Jay", name: "Ann Hammers", race: "Human", ok: true } }); // the composed sheet's name (the fake check names it)
    expect((await h.call("GET", `${base}/teams/grudge/swap-request`, coach("Bob"))).status).toBe(403);
    const pub = ((await h.call("GET", base)).body as { season: SeasonRecord }).season;
    expect(pub.teams.find((x) => x.id === "grudge")).not.toHaveProperty("swapRequest");
    // only the coach approves
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/approve`, JAY, {})).status).toBe(403);
    // the approval names the reviewed request (id + team)
    const reviewed = (asCoach.body as { request: { id: string; ref: string } }).request;
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), {})).status).toBe(400);
    const ok = await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: reviewed.id, ref: reviewed.ref });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = h.season().teams.find((x) => x.id === "grudge")!;
    expect(after.name).toBe("Ann Hammers");
    expect(after.swapRequest).toBeUndefined();
    expect(h.sent.some((x) => x.coach === "Jay" && x.input.title === "Swap approved: Ann Hammers")).toBe(true);
  });

  it("P2-3: the coach can decline; an organiser can withdraw; nothing else changes", async () => {
    const h = harness();
    h.coachTeams.ann!.push({ ref: "save:secret-human", kind: "save", name: "Secret Squirrels", race: "Human", tv: 900_000 });
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:secret-human") });
    const d = await h.call("POST", `${base}/teams/grudge/swap-request/decline`, coach("Ann"), {});
    expect(d.status).toBe(200);
    expect(h.season().teams.find((x) => x.id === "grudge")!.name).toBe("Grudge Rollers");
    expect(h.season().teams.find((x) => x.id === "grudge")!.swapRequest).toBeUndefined();
    expect(h.sent.some((x) => x.coach === "Jay" && x.input.title === "Swap declined: Grudge Rollers")).toBe(true);
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: "sr-000000000000", ref: "save:secret-human" })).status).toBe(409);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:p1-human") })).status).toBe(202);
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/decline`, KIM, {})).status).toBe(200);
    expect(h.season().teams.find((x) => x.id === "grudge")!.swapRequest).toBeUndefined();
  });
});

describe("review: replays, registration rows and listings", () => {
  it("P2-4: by time: a correction of a game Ann played stays Ann after Dan took over; a replay after the takeover is Dan's", async () => {
    const h = harness();
    const fx = (id: string) => h.season().fixtures.find((f) => f.id === id)!;
    const edit = (id: string, fn: (f: LeagueFixture) => void) => { const s = h.season(); fn(s.fixtures.find((f) => f.id === id)!); h.store.putSeason(s); };
    const patch = (id: string, body: unknown) => h.call("PATCH", `${base}/fixtures/${id}`, JAY, body);
    // f1 and f2 were played by Ann before the takeover (their played times)
    edit("f1", (f) => { f.finishedAt = "2026-10-11T20:00:00.000Z"; });
    edit("f2", (f) => { f.finishedAt = "2026-10-12T20:00:00.000Z"; });
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Ann", at: "2026-10-11T20:00:00.000Z" }); // the time joins the stamp
    // a correction with no change of hands keeps the original stamp (with a NAF name only that stamp had)
    edit("f2", (f) => { f.away.playedBy = { coach: "Ann", coachId: "Ann", nafUser: "AnnNaf", span: 0, at: "2026-10-12T20:00:00.000Z" }; });
    expect((await patch("f2", { result: null })).status).toBe(200);
    expect((await patch("f2", { result: { home: 1, away: 1 } })).status).toBe(200);
    expect(fx("f2").away.playedBy).toEqual({ coach: "Ann", coachId: "Ann", nafUser: "AnnNaf", span: 0, at: "2026-10-12T20:00:00.000Z" });
    // Dan takes over (2026-11-03T12:00); unplayed fixtures move to him at once
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${h.season().takeoverApplications![0]!.id}/approve`, JAY, {});
    expect(fx("f3").home).toMatchObject({ coach: "Dan", coachId: "Dan" });
    // a bad "played on" is refused
    expect((await patch("f3", { result: { home: 1, away: 0, playedOn: "soon" } })).status).toBe(400);
    // CORRECTION: f1 is cleared and re-entered; "played on" defaults to the original time, so it stays Ann's game
    expect((await patch("f1", { result: null })).status).toBe(200);
    expect(fx("f1").home).toMatchObject({ coach: "Dan", coachId: "Dan", clearedPlayedBy: { coach: "Ann", at: "2026-10-11T20:00:00.000Z" } }); // seated for Dan meanwhile
    expect((await patch("f1", { result: { home: 3, away: 1 } })).status).toBe(200);
    expect(fx("f1").finishedAt).toBe("2026-10-11T20:00:00.000Z");
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Ann", coachId: "Ann", span: 0 });
    // an explicit "played on" at or before the takeover is a correction too
    expect((await patch("f2", { result: null })).status).toBe(200);
    // a bare date on the takeover day is ambiguous: a time is required
    expect((await patch("f2", { result: { home: 0, away: 0, playedOn: "2026-11-03" } })).status).toBe(400);
    expect((await patch("f2", { result: { home: 0, away: 0, playedOn: "2026-11-03T11:00:00.000Z" } })).status).toBe(200);
    expect(fx("f2").away.playedBy).toMatchObject({ coach: "Ann" });
    // REPLAY: f1 cleared again and replayed after the takeover ("played on" after it) counts for Dan
    expect((await patch("f1", { result: null })).status).toBe(200);
    expect((await patch("f1", { result: { home: 0, away: 2, playedOn: "2026-11-03T12:03:00Z" } })).status).toBe(200);
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Dan", coachId: "Dan", span: 1, at: "2026-11-03T12:03:00.000Z" });
    // a replay result from a path with a real time after the takeover (the fork, the recorder) is Dan's too
    expect((await patch("f2", { result: null })).status).toBe(200);
    edit("f2", (f) => { f.home.score = 2; f.away.score = 2; f.finishedAt = "2026-11-05T19:00:00.000Z"; });
    expect(fx("f2").away.playedBy).toMatchObject({ coach: "Dan", span: 1 });
    // a stamp that names its holder and is re-entered with no time is a correction: its coach
    edit("f3", (f) => { delete f.finishedAt; f.home.score = 1; f.away.score = 0; f.home.playedBy = { coach: "Ann", coachId: "Ann", span: 0 }; });
    edit("f3", (f) => { f.home.score = null; f.away.score = null; });
    edit("f3", (f) => { f.home.score = 1; f.away.score = 0; delete f.finishedAt; });
    expect(fx("f3").home.playedBy).toMatchObject({ coach: "Ann" });
    expect(fx("f3").home).toMatchObject({ coach: "Ann", coachId: "Ann" }); // the raw side agrees with the stamp
    // played times: never after now (plus a few minutes of clock skew)
    expect((await patch("f3", { result: null })).status).toBe(200);
    expect((await patch("f3", { result: { home: 1, away: 0, playedOn: "2026-11-03T12:10:00Z" } })).status).toBe(400);
    expect((await patch("f3", { result: { home: 1, away: 0, playedOn: "2026-11-03T19:30" } })).status).toBe(400); // no zone
    expect((await patch("f3", { result: { home: 1, away: 0, playedOn: "2026-11-03T12:04:00Z" } })).status).toBe(200);
  });

  it("P2-6: a race-changing swap updates the entry's accepted registration row in the same write", async () => {
    const h = harness();
    const s = h.season();
    s.registrations = [{ id: "lr-aaaaaaaaaaaa", leagueId: L, seasonId: S, coach: "Ann", state: "accepted", submittedAt: "", enteredAt: "", registrationLog: [], race: "Human", teamName: "Grudge Rollers", teamRef: "save:x", kind: "new", teamSnapshot: { teamName: "Grudge Rollers", race: "Human", rerolls: 2, apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, cost: 0, players: [] }, validation: { ok: true, problems: [], checkedAt: "" }, teamId: "grudge" }];
    h.store.putSeason(s);
    h.coachTeams.ann!.push({ ref: "save:s9-orc", kind: "save", name: "Ann Tuskers", race: "Orc", tv: 650_000, shared: true });
    const rev = h.rev();
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: rev, ref: "save:s9-orc" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.rev()).toBe(rev + 1);
    expect(h.season().registrations![0]).toMatchObject({ race: "Orc", teamName: "Ann Tuskers", teamId: "grudge", state: "accepted" });
  });

  it("P2-7: swapping a listed entry closes the listing, declines its pending applications, tells them and releases their acknowledgements", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Eve", { mode: "takeover", share: [], acknowledged: true });
    await h.apply("Bob", { mode: "takeover" });
    const rev = h.rev();
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: rev, ref: "save:s1-human" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.rev()).toBe(rev + 1); // one write
    const s = h.season();
    expect(s.teams.find((t) => t.id === "grudge")!.takeover).toBeUndefined();
    for (const who of ["Eve", "Bob"]) expect(s.takeoverApplications!.find((a) => a.coach === who)).toMatchObject({ state: "declined", decided: { reason: "The team is no longer available for takeover." } });
    expect(h.sent.filter((x) => x.input.title === "Application closed: Grudge Rollers" && x.input.body === "This team is no longer available for takeover.").map((x) => x.coach).sort()).toEqual(["Bob", "Eve"]);
    expect(h.exits).toContain("Eve"); // the non-member's acknowledgement goes
    expect(h.exits).not.toContain("Bob"); // a member keeps theirs
  });
});

// ---- re-review (Sol, 11-03 round 2) -----------------------------------------------------------------------------------

describe("re-review: stale approvals, legacy stamps, exports, deletion, unreadable recorder files", () => {
  it("R1: approving a request the organiser replaced meanwhile is refused (409)", async () => {
    const h = harness();
    h.coachTeams.ann!.push({ ref: "save:r1-human", kind: "save", name: "R1", race: "Human", tv: null }, { ref: "save:r2-orc", kind: "save", name: "R2", race: "Orc", tv: null });
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:r1-human") });
    const seen = ((await h.call("GET", `${base}/teams/grudge/swap-request`, coach("Ann"))).body as { request: { id: string; ref: string } }).request;
    expect(seen.ref).toBe("save:r1-human");
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:r2-orc") }); // replaced
    const stale = await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: seen.id, ref: seen.ref });
    expect(stale.status).toBe(409);
    expect(h.season().teams.find((t) => t.id === "grudge")!.name).toBe("Grudge Rollers");
    const now = ((await h.call("GET", `${base}/teams/grudge/swap-request`, coach("Ann"))).body as { request: { id: string; ref: string } }).request;
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: now.id, ref: "save:r1-human" })).status).toBe(409);
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: now.id, ref: now.ref })).status).toBe(200);
    expect(h.season().teams.find((t) => t.id === "grudge")!.race).toBe("Orc");
  });

  it("R2: a legacy stamp (no holder index) after A -> B -> C credits the holder at the re-entered time; with no time at all it stays with A", async () => {
    const h = harness();
    const edit = (id: string, fn: (f: LeagueFixture) => void) => { const s = h.season(); fn(s.fixtures.find((f) => f.id === id)!); h.store.putSeason(s); };
    const fx = (id: string) => h.season().fixtures.find((f) => f.id === id)!;
    // the entry changed hands twice: Ann -> Ben (10-20) -> Cat (10-25)
    const s = h.season();
    const t = s.teams.find((x) => x.id === "grudge")!;
    t.entryHistory = [
      { name: t.name, race: t.race, coach: "Ann", coachId: "Ann", fromGame: 1, toGame: 1, via: "start", at: "2026-10-01T00:00:00.000Z" },
      { name: t.name, race: t.race, coach: "Ben", coachId: "Ben", fromGame: 2, toGame: 2, via: "takeover", at: "2026-10-20T00:00:00.000Z" },
      { name: t.name, race: t.race, coach: "Cat", coachId: "Cat", fromGame: 3, via: "takeover", at: "2026-10-25T00:00:00.000Z" },
    ];
    t.coach = "Cat"; t.coachId = "Cat";
    // legacy stamps: no holder index, no played time; f1 still has its scheduled date, f2 has nothing at all
    for (const f of s.fixtures.filter((x) => x.id !== "f3")) { delete f.finishedAt; delete f.startedAt; f.home.playedBy = { coach: "Ann", coachId: "Ann" }; f.away.playedBy = { coach: f.away.coach, ...(f.away.coachId ? { coachId: f.away.coachId } : {}) }; }
    s.fixtures.find((x) => x.id === "f1")!.date = "2026-10-11";
    s.fixtures.find((x) => x.id === "f2")!.away.playedBy = { coach: "Ann", coachId: "Ann" };
    h.store.putSeason(s);
    // f1 cleared: the kept stamp takes the fixture's date, the side is seated for Cat
    edit("f1", (f) => { f.home.score = null; f.away.score = null; });
    expect(fx("f1").home.clearedPlayedBy).toMatchObject({ coach: "Ann", at: "2026-10-11T00:00:00.000Z" });
    expect(fx("f1").home).toMatchObject({ coach: "Cat" });
    // re-entered as played while Ben held the entry: Ben's game (never Cat's)
    edit("f1", (f) => { f.home.score = 1; f.away.score = 0; f.finishedAt = "2026-10-22T20:00:00.000Z"; });
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Ben", coachId: "Ben", span: 1 });
    expect(fx("f1").home).toMatchObject({ coach: "Ben", coachId: "Ben" });
    // as a correction of Ann's game (her time): Ann again
    edit("f1", (f) => { f.home.score = null; f.away.score = null; });
    edit("f1", (f) => { f.home.score = 1; f.away.score = 0; f.finishedAt = "2026-10-11T00:00:00.000Z"; });
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Ann" });
    // a replay after Cat took over: Cat's
    edit("f1", (f) => { f.home.score = null; f.away.score = null; });
    edit("f1", (f) => { f.home.score = 0; f.away.score = 1; f.finishedAt = "2026-11-01T20:00:00.000Z"; });
    expect(fx("f1").home.playedBy).toMatchObject({ coach: "Cat", span: 2 });
    // f2: no stamp holder, no time anywhere: a re-entry stays with Ann whatever time it carries
    edit("f2", (f) => { f.home.score = null; f.away.score = null; });
    expect(fx("f2").away.clearedPlayedBy).toEqual({ coach: "Ann", coachId: "Ann" });
    edit("f2", (f) => { f.home.score = 2; f.away.score = 2; f.finishedAt = "2026-11-01T20:00:00.000Z"; });
    expect(fx("f2").away.playedBy).toEqual({ coach: "Ann", coachId: "Ann" });
    expect(fx("f2").away).toMatchObject({ coach: "Ann", coachId: "Ann" });
  });

  it("R4: a restored correction sets the side's coach to match, so the CSV export names the coach who played", async () => {
    const h = harness();
    const { leagueCsvFiles } = await import("../src/leagues/exportZip.js");
    const edit = (id: string, fn: (f: LeagueFixture) => void) => { const s = h.season(); fn(s.fixtures.find((f) => f.id === id)!); h.store.putSeason(s); };
    edit("f1", (f) => { f.finishedAt = "2026-10-11T20:00:00.000Z"; });
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${h.season().takeoverApplications![0]!.id}/approve`, JAY, {});
    expect((await h.call("PATCH", `${base}/fixtures/f1`, JAY, { result: null })).status).toBe(200);
    expect((await h.call("PATCH", `${base}/fixtures/f1`, JAY, { result: { home: 3, away: 1 } })).status).toBe(200);
    const f1 = h.season().fixtures.find((f) => f.id === "f1")!;
    expect(f1.home).toMatchObject({ coach: "Ann", coachId: "Ann", playedBy: { coach: "Ann" } });
    const csv = String(Object.entries(leagueCsvFiles(h.store.league(L)!, [h.season()])).find(([k]) => k.endsWith("fixtures.csv"))![1]);
    const row = csv.split(/\r?\n/).find((l) => l.includes(",f1,"))!;
    expect(row).toContain(",Ann,");
    expect(row).not.toContain(",Dan,");
  });

  it("R6: an unreadable recorder match file fails the swap and the approval closed (503)", async () => {
    const h = harness();
    await h.list(true);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    const { leagueApi: api } = await import("../src/leagues/api.js");
    const depsWith = (unreadable: string[]) => ({
      store: h.store, now: () => new Date("2026-11-03T12:00:00.000Z"), identities: () => [], notify: () => undefined,
      memberContact: (_v: unknown, c: string) => ({ coach: c }), coachTeams: () => [{ ref: "save:s1-human", kind: "save" as const, name: "x", race: "Human", tv: null, shared: true }],
      leagueTeamSheet: (c: string, ref: string, pkg: string) => sheetFor(c, ref, pkg),
      tabletop: { listMatches: async () => [], readEvents: async () => [], listMatchesChecked: async () => ({ matches: [], unreadable }) },
      readBody: async () => Buffer.from(JSON.stringify({ revision: h.rev(), ref: "save:s1-human" })),
    }) as unknown as LeagueApiDeps;
    const r = await api("POST", `${base}/teams/grudge/swap`, new URLSearchParams(), JAY, depsWith(["broken.json"]));
    expect(r!.status).toBe(503);
    const id = h.season().takeoverApplications![0]!.id;
    const a = await api("POST", `${base}/takeovers/${h.listingId()}/applications/${id}/approve`, new URLSearchParams(), JAY, { ...depsWith(["broken.json"]), readBody: async () => Buffer.alloc(0) } as LeagueApiDeps);
    expect(a!.status).toBe(503);
    expect(h.season().teams.find((t) => t.id === "grudge")!.coachId).toBe("Ann");
    // the file repository reports what it can't read
    const { FileTabletopRepository } = await import("../src/tabletop/store.js");
    const dir = mkdtempSync(join(tmpdir(), "tlib-tt-"));
    roots.push(dir);
    const repo = new FileTabletopRepository(join(dir, "tt"));
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(dir, "tt", "matches"), { recursive: true });
    writeFileSync(join(dir, "tt", "matches", "m-bad.json"), "{ not json");
    writeFileSync(join(dir, "tt", "matches", "m-odd.json"), "[]");
    writeFileSync(join(dir, "tt", "matches", "m-ok.json"), JSON.stringify({ id: "m-ok", state: "recording", fixtureRef: `league:${L}:${S}:f3` }));
    const checked = await repo.listMatchesChecked();
    expect(checked.unreadable.sort()).toEqual(["m-bad.json", "m-odd.json"]);
    expect(checked.matches.map((m) => m.id)).toEqual(["m-ok"]);
  });
});

describe("re-review R5: a cleared stamp is anonymised and exported", () => {
  it("delete then restore: the restored coach is the pseudonym, never the deleted identity", async () => {
    const { seed, depsFor } = await import("./privacyFixture.js");
    const { clearFences } = await import("../src/privacy/fence.js");
    const root = mkdtempSync(join(tmpdir(), "bbtv-tlib-priv2-"));
    roots.push(root);
    process.env.IDENTITIES_FILE = join(root, "identities.json");
    clearFences();
    await seed(root);
    const deps = depsFor(root);
    const sFile = join(deps.stateDir, "leagues", "l1", "seasons", "s1.json");
    const s = JSON.parse(readFileSync(sFile, "utf8"));
    // Alice played the home side; the result was cleared after the team passed to Bob (the side now names Bob)
    s.fixtures[0].home = { ...s.fixtures[0].home, coach: "Bob", coachId: "Bob", score: null, cas: null, clearedPlayedBy: { coach: "Alice Smith", coachId: "Alice", nafUser: "AliceNaf" } };
    s.fixtures[0].away = { ...s.fixtures[0].away, score: null, cas: null };
    writeFileSync(sFile, JSON.stringify(s));
    const collectors = await import("../src/privacy/collectors.js");
    const files = new Map((await collectors.collectExport(deps, "alice")).map((f) => [f.name, String(f.content)]));
    const exported = JSON.parse(files.get("league-teams.json")!);
    expect(JSON.stringify(exported[0].seasons[0].fixtures)).toContain("clearedPlayedBy");
    const P = "Deleted coach #1";
    const plan = { jobId: "x".repeat(24), coachHash: "", coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001", pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" };
    const ctx = collectors.deleteContext(deps, { ...collectors.splitPlan(plan as never).stored, coach: "Alice", coachNames: ["Alice"], displays: ["Alice Smith", "AliceNaf"], nafId: "1001" } as never);
    for (const step of collectors.DELETE_STEPS.filter((x) => x.id === "anonymise-leagues")) await step.run(ctx);
    const after = JSON.parse(readFileSync(sFile, "utf8")) as SeasonRecord;
    expect(after.fixtures[0]!.home.clearedPlayedBy).toEqual({ coach: P, coachId: P });
    // the result is re-entered: the restored coach is the pseudonym
    after.fixtures[0]!.home.score = 1; after.fixtures[0]!.away.score = 0;
    stampPlayedCoaches(after);
    expect(after.fixtures[0]!.home.playedBy).toEqual({ coach: P, coachId: P });
    expect(JSON.stringify(after.fixtures[0])).not.toMatch(/Alice/);
  });
});

// ---- owner 11-03: transfers, other members' shared teams, a decline never locks the entry ------------------------------

describe("owner 11-03: league transfers and replacing a team whatever the coach answered", () => {
  it("a coach's decline never blocks the organisers: they list the team for takeover and approve another coach", async () => {
    const h = harness();
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:p1-human") });
    expect((await h.call("POST", `${base}/teams/grudge/swap-request/decline`, coach("Ann"), {})).status).toBe(200);
    // inactive, takeover listing and approval all go ahead
    expect((await h.call("POST", `${base}/teams/grudge/status`, JAY, { revision: h.rev(), status: "inactive" })).status).toBe(200);
    expect((await h.call("POST", `${base}/teams/grudge/status`, JAY, { revision: h.rev(), status: "active" })).status).toBe(200);
    expect((await h.list(true)).status).toBe(200);
    await h.apply("Dan", { mode: "takeover", share: [], acknowledged: true });
    const ok = await h.call("POST", `${base}/takeovers/${h.listingId()}/applications/${h.season().takeoverApplications![0]!.id}/approve`, JAY, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(h.season().teams.find((t) => t.id === "grudge")!.coachId).toBe("Dan");
  });

  it("a pending request doesn't lock the entry either: an approval or a shared-team swap replaces it and clears the request", async () => {
    const h = harness();
    await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("save:p1-human") });
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:s1-human" }); // shared: direct
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(h.season().teams.find((t) => t.id === "grudge")!.swapRequest).toBeUndefined();
  });

  it("organisers may swap in another member's SHARED team (the entry gets that coach); never another member's private one", async () => {
    const h = harness();
    h.coachTeams.bob = [{ ref: "save:b1-orc", kind: "save", name: "Bob Tuskers", race: "Orc", tv: 650_000, shared: true }, { ref: "save:b2-human", kind: "save", name: "Bob Secret", race: "Human", tv: null }];
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: maskToken(L, "grudge", "Bob", "save:b2-human"), coach: "Bob" })).status).toBe(403);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:b1-orc", coach: "Eve" })).status).toBe(404); // not a member
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:b1-orc", coach: "Bob" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const t = h.season().teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ coach: "Bob", coachId: "Bob", race: "Orc" });
    expect(h.sent.some((x) => x.coach === "Ann" && x.input.title === "Your team in TABBL was swapped")).toBe(true);
    expect(h.sent.some((x) => x.coach === "Bob" && x.input.title === "Your team joined TABBL")).toBe(true);
    expect(await standingOf(h, "grudge")).toMatchObject({ played: 2, points: 4 });
  });

  it("Permit league transfer: only the team's coach sets it; off, the team can't leave its league; on, its coach can apply with it and it moves with its record", async () => {
    const h = harness();
    // Ann's Busy Bees play in Other BBL (finished there for this test)
    const o = h.store.season("other", "season-1")!;
    o.status = "completed";
    h.store.putSeason(o);
    const P = "/api/leagues/other/seasons/season-1/teams/busy/transfer";
    expect((await h.call("POST", P, OTTO, { permit: true })).status).toBe(403); // an organiser can't
    expect((await h.call("POST", P, coach("Bob"), { permit: true })).status).toBe(403);
    expect((await h.call("POST", P, coach("Ann"), { permit: "yes" })).status).toBe(400);
    await h.list(true, JAY, "orcs"); // Bob's Green Tide needs a coach; Ann applies with her other-league team
    const ref = "league:other/season-1/busy";
    expect((await h.apply("Ann", { mode: "team", teamRef: ref }, h.listingId("orcs"))).status).toBe(404); // transfer not permitted
    expect((await h.call("POST", P, coach("Ann"), { permit: true })).status).toBe(200);
    expect(h.store.season("other", "season-1")!.teams.find((t) => t.id === "busy")!.transfer).toMatchObject({ permitted: true, by: "Ann" });
    // the public read never shows the option
    const pub = ((await h.call("GET", "/api/leagues/other/seasons/season-1")).body as { season: SeasonRecord }).season;
    expect(pub.teams.find((t) => t.id === "busy")).not.toHaveProperty("transfer");
    const a = await h.apply("Ann", { mode: "team", teamRef: ref }, h.listingId("orcs"));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const id = h.season().takeoverApplications!.find((x) => x.coach === "Ann")!.id;
    const ok = await h.call("POST", `${base}/takeovers/${h.listingId("orcs")}/applications/${id}/approve`, JAY, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const t = h.season().teams.find((x) => x.id === "orcs")!;
    const src = h.store.season("other", "season-1")!.teams.find((x) => x.id === "busy")!;
    expect(t).toMatchObject({ name: "Busy Bees", coachId: "Ann" });
    expect(t.teamUid).toBe(src.teamUid); // the same team, lineage kept
    expect(t.players[0]!.previousIds).toEqual([src.players[0]!.playerId]);
    // a fork library team is never a source
    await h.list(true, JAY, "grudge");
    const lib = await h.apply("Dan", { mode: "team", teamRef: "library:lib1-human", share: [], acknowledged: true }, h.listingId("grudge"));
    expect(lib.status).toBe(400);
    expect((lib.body as { error: string }).error).toContain("saved team");
  });
});

// ---- re-review round 3 (Sol, 11-03) ---------------------------------------------------------------------------------------

describe("re-review 3: lineage, unresolved fixtures, masked tokens, legacy entries, veterans", () => {
  const third = (h: ReturnType<typeof harness>, teams: LeagueTeam[], over: Partial<SeasonRecord> = {}) => {
    h.store.upsertLeague({ id: "third", name: "Third BBL", fullName: "Third BBL", slug: "third", organisers: ["Tia"], owner: "Tia" } as never);
    h.store.putSeason({ ...structuredClone(h.season()), id: "season-2", leagueId: "third", number: 2, name: "Season 2", sourceSlug: "t2", status: "completed", fixtures: [], participants: [], registrations: [], takeoverApplications: [], teams, ...over } as SeasonRecord);
  };
  const permit = { permitted: true, by: "Ann", at: "2026-06-01T00:00:00.000Z" };

  it("R3-1: eligibility is per lineage: only the team's current copy counts; an older copy left behind is never selectable", async () => {
    const h = harness();
    // the Vipers (lineage tm-v) moved from Other BBL (old copy, transfer permitted) to Third BBL (current copy, not permitted)
    const s0 = h.store.season("other", "season-0")!;
    s0.ruleset = "BB2025";
    s0.teams[0]!.teamUid = "tm-vvvvvvvvvvvv";
    s0.teams[0]!.coachAssigned = { by: "Otto", at: "2026-03-01T00:00:00.000Z" };
    h.store.putSeason(s0);
    third(h, [team("vipers3", "Vintage Vipers", "Human", "Ann", { teamUid: "tm-vvvvvvvvvvvv", coachAssigned: { by: "Tia", at: "2026-07-01T00:00:00.000Z" } })]);
    const mine = async () => ((await h.call("GET", `${base}/my-teams`, coach("Ann"))).body as { items: Array<Record<string, any>> }).items.filter((i) => i.kind === "league").map((i) => i.ref);
    expect(await mine()).not.toContain("league:other/season-0/vintage");
    expect(await mine()).not.toContain("league:third/season-2/vipers3"); // the current copy is not permitted
    // permitted on the current copy: that copy (and only it) is offered
    const s2 = h.store.season("third", "season-2")!;
    s2.teams[0]!.transfer = permit;
    h.store.putSeason(s2);
    expect(await mine()).toContain("league:third/season-2/vipers3");
    expect(await mine()).not.toContain("league:other/season-0/vintage");
    // taken over by Bob in the current copy: no longer Ann's at all
    const s2b = h.store.season("third", "season-2")!;
    s2b.teams[0]!.coachId = "Bob"; s2b.teams[0]!.coach = "Bob";
    h.store.putSeason(s2b);
    expect((await mine()).some((r) => r.includes("vipers") || r.includes("vintage"))).toBe(false);
  });

  it("R3-2: unresolved fixtures block a move even for an inactive team, until its organisers decide them", async () => {
    const h = harness();
    const o = h.store.season("other", "season-1")!;
    const busy = o.teams.find((t) => t.id === "busy")!;
    busy.status = "inactive";
    busy.transfer = permit;
    const relic = o.teams.find((t) => t.id === "relic")!;
    o.fixtures = [fixture("of1", 1, busy, relic, null, null)];
    h.store.putSeason(o);
    await h.list(true, JAY, "orcs");
    const r = await h.apply("Ann", { mode: "team", teamRef: "league:other/season-1/busy" }, h.listingId("orcs"));
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toBe("Has unresolved fixtures in Other BBL Season 1.");
    const o2 = h.store.season("other", "season-1")!;
    o2.fixtures[0]!.deadlineOutcome = { outcome: "no-result", by: "Otto", at: "2026-11-01T00:00:00.000Z" };
    h.store.putSeason(o2);
    expect((await h.apply("Ann", { mode: "team", teamRef: "league:other/season-1/busy" }, h.listingId("orcs"))).status).toBe(201);
  });

  it("R3-3/4: a masked team goes by an opaque token; the coach reviews the real team (a cross-league one too) and approves it", async () => {
    const h = harness();
    third(h, [team("far", "Far Hammers", "Human", "Ann", { transfer: permit, players: Array.from({ length: 11 }, (_, i) => player(`far-p${i + 1}`, i + 1, { availableSpp: 3, stats: { ...EMPTY_PLAYER_STATS, spp: 3 } })) })]);
    const lib = await h.call("GET", `${base}/teams/grudge/library`, JAY);
    const raw = JSON.stringify(lib.body);
    expect(raw).not.toContain("third");
    expect(raw).not.toContain("Far Hammers");
    const masked = (lib.body as { items: Array<Record<string, any>> }).items.filter((i) => i.private);
    expect(masked.every((i) => /^pv-[0-9a-f]{24}$/.test(i.ref))).toBe(true);
    // a raw ref of a masked team is refused like an unknown one (no existence oracle)
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "league:third/season-2/far" })).status).toBe(404);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "save:p1-human" })).status).toBe(404);
    expect((await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: "pv-000000000000000000000000" })).status).toBe(404);
    const r = await h.call("POST", `${base}/teams/grudge/swap`, JAY, { revision: h.rev(), ref: tok("league:third/season-2/far") });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    // organisers' views never carry the real ref; the coach sees the team in full
    const asOrg = await h.call("GET", `${base}/teams/grudge/manage`, JAY);
    expect(JSON.stringify(asOrg.body)).not.toContain("league:third");
    const review = ((await h.call("GET", `${base}/teams/grudge/swap-request`, coach("Ann"))).body as { request: Record<string, any> }).request;
    expect(review).toMatchObject({ ref: "league:third/season-2/far", name: "Far Hammers", race: "Human", source: "Third BBL Season 2", ok: true });
    const ok = await h.call("POST", `${base}/teams/grudge/swap-request/approve`, coach("Ann"), { requestId: review.id, ref: review.ref });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const t = h.season().teams.find((x) => x.id === "grudge")!;
    expect(t).toMatchObject({ name: "Far Hammers", transferredFrom: { leagueId: "third", seasonId: "season-2", teamId: "far", played: true } });
    expect(t.teamUid).toBe(h.store.season("third", "season-2")!.teams[0]!.teamUid); // lineage minted on the source and kept
  });

  it("R3-5: a legacy pending entry made with a fork library team is not accepted (409 with what to do); it stays pending", async () => {
    const h = harness();
    const { defaultSeasonRegistration } = await import("../src/leagues/seasonRegistration.js");
    const s = h.season();
    s.registration = { ...defaultSeasonRegistration(h.store.league(L)!), allowRegistration: true, allowMidSeason: true };
    s.registrations = [{ id: "lr-cccccccccccc", leagueId: L, seasonId: S, coach: "Eve", state: "pending", submittedAt: "2026-11-01T00:00:00.000Z", enteredAt: "2026-11-01T00:00:00.000Z", registrationLog: [], race: "Human", teamName: "Eve Library", teamRef: "library:old-1", kind: "existing", libraryTeamId: "old-1", teamSnapshot: { teamName: "Eve Library", race: "Human", rerolls: 2, apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, cost: 0, players: [] }, validation: { ok: true, problems: [], checkedAt: "" } }];
    h.store.putSeason(s);
    const r = await h.call("POST", `${base}/registrations/lr-cccccccccccc/accept`, JAY, {});
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("register again with a saved team");
    expect(h.season().registrations![0]!.state).toBe("pending");
    expect(h.season().teams.some((t) => t.name === "Eve Library")).toBe(false);
  });

  it("R3-6/7: a same-league move of an imported team without a lineage id mints it on the source; a veteran keeps in-season rules", async () => {
    const h = harness();
    const { teamHasPlayed } = await import("../src/leagues/teamOps.js");
    const s6 = h.store.season(L, "season-6")!;
    s6.teams.push(team("vets", "Old Vets", "Human", "Ann", { players: Array.from({ length: 11 }, (_, i) => player(`vets-p${i + 1}`, i + 1, { availableSpp: 8, stats: { ...EMPTY_PLAYER_STATS, td: 1, spp: 8 } })) }));
    h.store.putSeason(s6);
    expect(h.store.season(L, "season-6")!.teams.find((t) => t.id === "vets")!.teamUid).toBeUndefined();
    await h.list(true, JAY, "orcs");
    const a = await h.apply("Ann", { mode: "team", teamRef: `league:${L}/season-6/vets` }, h.listingId("orcs"));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const id = h.season().takeoverApplications!.find((x) => x.coach === "Ann")!.id;
    expect((await h.call("POST", `${base}/takeovers/${h.listingId("orcs")}/applications/${id}/approve`, JAY, {})).status).toBe(200);
    const src = h.store.season(L, "season-6")!.teams.find((t) => t.id === "vets")!;
    const dst = h.season().teams.find((t) => t.id === "orcs")!;
    expect(src.teamUid).toMatch(/^tm-/);
    expect(dst.teamUid).toBe(src.teamUid);
    expect(dst.transferredFrom).toMatchObject({ leagueId: L, seasonId: "season-6", teamId: "vets", played: true });
    expect(dst.players.every((p) => p.stats.spp === 0)).toBe(true); // this season's counters start at zero...
    expect(teamHasPlayed({ fixtures: [], phases: [] }, dst)).toBe(true); // ...but it is a veteran team: in-season rules
  });
});
