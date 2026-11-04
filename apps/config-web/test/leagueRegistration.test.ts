import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Roster } from "@bb/validator";
import { leagueApi, seasonSummary, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import { defaultSeasonRegistration, type SeasonRegistration } from "../src/leagues/seasonRegistration.js";
import { leaguePackageName } from "../src/leagueBuilderMarker.js";
import { leagueRegistrationLink, rowToEntry, type LeagueRegistrationRow } from "../src/leagues/registration.js";
import type { LeagueTeamSheet } from "../src/leagues/registrationApi.js";
import { registrationContactFor } from "../src/registration/index.js";
import { parseShareScope } from "../src/auth/contactFor.js";
import { isStateChangingApiRequest } from "../src/auth/csrf.js";
import { onboardingGateApplies } from "../src/auth/onboarding.js";
import { requireSession } from "../src/auth/requireSession.js";
import type { CoachIdentityRecord } from "../src/auth/identitiesStore.js";
import type { NotificationInput } from "../src/notifications.js";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";

// Lane L6 (registration spec 2026-11-02 §5 (c)): league registration. The coach join flow (a new team built in the Roster
// Builder's league mode, or a library team when the organisers allow existing teams, checked against the season's rules),
// region, the league share acknowledgement (no NAF), organiser approval and auto mode, the cap / per-race race, waitlist
// promotion exactly once, accept -> one LeagueTeam in one season write (crash simulated), mid-season joining (no
// fixtures), organisers notified and never the actor, the decline notice, "I've paid" privacy, the Sol hunt list, drafts
// and CSRF / 428 coverage. Each test has its own state dir (laws §C14); every transport is a stub.

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const IVY: LeagueApiIdentity = { coach: "Ivy", admin: false };
const ROOT: LeagueApiIdentity = { coach: "Root", admin: true };
const OTTO: LeagueApiIdentity = { coach: "Otto", admin: false, organizer: true };
const coach = (name: string, extra: Partial<LeagueApiIdentity> = {}): LeagueApiIdentity => ({ coach: name, admin: false, ...extra });
const L = "rivertown";
const S = "season-1";
const MARKER = leaguePackageName(L, S);
const base = `/api/leagues/${L}/seasons/${S}`;

function rosterOf(race: string, players = 11, cost = 50_000): Roster {
  return {
    rosterName: race, coach: "anyone", teamName: "T",
    sideline: { apothecary: false, assistantCoaches: 0, cheerleaders: 0, dedicatedFans: 1, reRolls: 2 },
    inducements: [], leagues: [], specialRules: [],
    players: Array.from({ length: players }, (_, i) => ({ number: i + 1, positionName: "Lineman", MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+", skills: [], keywords: [], cost })),
    summary: { playersCost: players * cost, skillsCost: 0, inducementCost: 0, sidelineCost: 120_000, total: players * cost + 120_000 },
  } as Roster;
}

/** The fake team check: refs name a race; "new-*" saves are built in league mode for this season. */
function sheetFor(coachName: string, ref: string, packageName: string): LeagueTeamSheet | { error: string; status?: number } {
  if (ref === "save:missing") return { error: "Team Builder save not found.", status: 404 };
  const race = /orc/i.test(ref) ? "Orc" : /human/i.test(ref) ? "Human" : /dwarf/i.test(ref) ? "Dwarf" : /gnoblar/i.test(ref) ? "Gnoblar Horde" : "Elven Union";
  if (ref === "save:bad-orc") return { teamName: `${coachName} Bad`, savePackage: packageName, validation: { ok: false, problems: ["Too many big guys."] }, roster: rosterOf("Orc") };
  if (ref.startsWith("save:linked-")) return { teamName: `${coachName} Linked ${race}s`, libraryTeamId: ref.slice("save:linked-".length), savePackage: "Spike 2026", validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  if (ref.startsWith("save:new-")) return { teamName: `${coachName} ${race}s`, savePackage: packageName, validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  if (ref.startsWith("save:old-")) return { teamName: `${coachName} Old ${race}s`, savePackage: "Spike 2026", validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  if (ref.startsWith("library:")) return { teamName: `${coachName} Library ${race}s`, libraryTeamId: ref.slice(8), savePackage: "Spike 2026", validation: { ok: true, problems: [] }, roster: rosterOf(race) };
  return { error: "Team Builder save not found.", status: 404 };
}

interface Sent { coach: string; input: NotificationInput }

function harness(opts: { reg?: Partial<SeasonRegistration>; stage?: SeasonRecord["stage"]; status?: SeasonRecord["status"]; league?: Partial<LeagueRecord>; clock?: string } = {}) {
  const root = mkdtempSync(pathJoin(tmpdir(), "bbtv-lreg-"));
  roots.push(root);
  const exits: Array<{ league: string; coaches: string[] }> = [];
  const store = new LeagueStore(root, { onRosterExit: (league, coaches) => exits.push({ league, coaches: [...coaches] }) });
  const clock = { now: new Date(opts.clock ?? "2026-11-10T12:00:00.000Z") };
  const sent: Sent[] = [];
  const identities: Record<string, CoachIdentityRecord> = {};
  const acks: Array<{ coach: string; league: string; fields: string[] }> = [];
  const faults = { failNextWrite: false };
  store.upsertLeague({ id: L, name: "Rivertown", fullName: "Rivertown BBL", slug: L, organisers: ["Olga", "Ivy"], owner: "Olga", ...(opts.league ?? {}) } as never);
  store.upsertLeague({ id: "otherbbl", name: "Other BBL", fullName: "Other BBL", slug: "otherbbl", organisers: ["Otto"], owner: "Otto" } as never);
  const league = store.league(L)!;
  const registration: SeasonRegistration = { ...defaultSeasonRegistration(league), allowRegistration: true, ...(opts.reg ?? {}) };
  const seasonOf = (leagueId: string, reg: SeasonRegistration): SeasonRecord => ({
    id: S, leagueId, number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: opts.status ?? "active", stage: opts.stage ?? "registration",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00.000Z", source: "manual",
    registration: reg,
  } as SeasonRecord);
  store.putSeason(seasonOf(L, registration));
  store.putSeason(seasonOf("otherbbl", { ...registration }));
  const identityFor = (c: string): CoachIdentityRecord => {
    const k = c.toLowerCase();
    identities[k] ??= {
      ffbCoachId: c, contact: { email: `${k}@example.test`, emailSource: "user", emailVerified: true, phones: [] }, profile: { preferredName: `${c} P` }, consent: {},
    } as unknown as CoachIdentityRecord;
    return identities[k]!;
  };
  const deps = (body: unknown): LeagueApiDeps => ({
    store,
    readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))),
    now: () => clock.now,
    identities: () => [{ coach: "Olga", level: "organizer" }, { coach: "Ivy", level: "player" }, { coach: "Root", level: "admin" }, { coach: "Otto", level: "organizer" }],
    notify: (c, input) => { sent.push({ coach: c, input }); },
    leagueTeamSheet: (c, ref, pkg) => sheetFor(c, ref, pkg),
    registrationSharing: {
      acknowledge: (c, leagueId, fields, at) => {
        acks.push({ coach: c, league: leagueId, fields: [...fields] });
        const rec = identityFor(c);
        const consent = (rec.consent ?? {}) as NonNullable<CoachIdentityRecord["consent"]>;
        rec.consent = {
          ...consent,
          leagues: { ...(consent.leagues ?? {}), [leagueId]: consent.leagues?.[leagueId] ?? { at: at.toISOString(), version: "v1" } },
          sharing: { ...(consent.sharing ?? {}), [`league:${leagueId}`]: { fields, at: at.toISOString(), version: "v1" } },
        } as CoachIdentityRecord["consent"];
      },
      contacts: (viewer, entries, managers) => entries.map((e) => registrationContactFor(viewer, identities[e.coach.toLowerCase()], parseShareScope(`league:${e.competitionId}`)!, e, managers)),
    },
    registrationBeforeWrite: () => { if (faults.failNextWrite) { faults.failNextWrite = false; throw new Error("disk full"); } },
  });
  const call = async (method: string, path: string, auth?: LeagueApiIdentity, body?: unknown): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(), auth, deps(body));
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const join = (who: string | LeagueApiIdentity, ref = "save:new-orc", extra: Record<string, unknown> = {}, path = base) =>
    call("POST", `${path}/registrations`, typeof who === "string" ? coach(who) : who, { teamRef: ref, share: [], acknowledged: true, ...extra });
  const season = (leagueId = L) => store.season(leagueId, S)!;
  const rows = (leagueId = L): LeagueRegistrationRow[] => season(leagueId).registrations ?? [];
  const rowOf = (who: string, leagueId = L) => rows(leagueId).find((r) => r.coach === who);
  const decide = (who: string, verb: string, auth: LeagueApiIdentity = OLGA, body: unknown = {}) =>
    call("POST", `${base}/registrations/${rowOf(who)!.id}/${verb}`, auth, body);
  const panel = async (auth: LeagueApiIdentity = OLGA) => (await call("GET", `${base}/registrations`, auth));
  const status = async (auth?: LeagueApiIdentity) => (await call("GET", `${base}/join`, auth)).body as { status: Record<string, unknown>; mine?: Record<string, unknown> };
  const setReg = (patch: Partial<SeasonRegistration>) => { const s = season(); s.registration = { ...s.registration!, ...patch }; store.putSeason(s); };
  return { store, clock, sent, acks, exits, identities, faults, call, join, season, rows, rowOf, decide, panel, status, setReg };
}

const types = (sent: Sent[], who: string) => sent.filter((s) => s.coach === who).map((s) => s.input.type);

describe("coach join flow", () => {
  it("joins with a new team built in league mode: pending (organiser approval by default), a reference code, organisers told", async () => {
    const h = harness();
    const r = await h.join("Pat");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ registration: { state: "pending", teamName: "Pat Orcs", race: "Orc", kind: "new" } });
    const row = h.rowOf("Pat")!;
    expect(row.refCode).toMatch(/^SF-[23456789A-HJ-NP-Z]{4}$/);
    expect(row.teamSnapshot.players).toHaveLength(11);
    expect(JSON.stringify(row.teamSnapshot)).not.toContain("anyone"); // the sheet's coach name is not kept
    // no team yet; the organisers (owner + organiser) are told, actionable (DM) in approval mode; the coach gets a receipt
    expect(h.season().teams).toHaveLength(0);
    expect(types(h.sent, "Olga")).toEqual(["registration"]);
    expect(types(h.sent, "Ivy")).toEqual(["registration"]);
    expect(h.sent.find((s) => s.coach === "Olga")!.input).toMatchObject({ action: true, link: leagueRegistrationLink(L, S, "organiser") });
    expect(types(h.sent, "Pat")).toEqual(["registration-outcome"]);
    // a second join changes nothing
    expect((await h.join("Pat", "save:new-human")).status).toBe(409);
  });

  it("existing teams are refused unless the organisers allow them; then a saved team is checked and kept as existing; fork library teams are never a source", async () => {
    const h = harness();
    expect(await h.join("Pat", "save:old-orc")).toMatchObject({ status: 400, body: { code: "existing-teams" } });
    h.setReg({ allowExistingTeams: true });
    expect((await h.join("Pat", "save:old-orc")).status).toBe(201);
    expect(h.rowOf("Pat")).toMatchObject({ kind: "existing", teamName: "Pat Old Orcs" });
    // owner 11-03: fork library teams are per-fixture copies, never a team to join with
    expect((await h.join("Dee", "library:lib-1-dwarf")).status).toBe(400);
  });

  it("a league team from another league joins only when its coach permits a league transfer, and moves with its record", async () => {
    const h = harness({ reg: { allowExistingTeams: true } });
    const old: SeasonRecord = { ...h.season("otherbbl"), id: "season-0", number: 0, sourceSlug: "o0", status: "completed", registrations: [], teams: [
      { id: "oldorcs", name: "Old Orcs", race: "Orc", coach: "Pat", coachId: "Pat", teamValue: 1_000_000, treasury: 30_000, rerolls: 2, fans: 3, assistantCoaches: 0, cheerleaders: 0, apothecary: true, tier: "2", raceLeague: "",
        players: [{ playerId: "p-old1", number: 1, name: "Grub", position: "Lineman", ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills: ["Block"], value: 70_000, level: "Experienced", availableSpp: 6, niggling: 0, missNextGame: false, stats: { td: 2, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 8, performance: 0 } }],
        formerPlayers: [], teamUid: "tm-bbbbbbbbbbbb" },
    ] } as unknown as SeasonRecord;
    h.store.putSeason(old);
    const ref = "league:otherbbl/season-0/oldorcs";
    expect((await h.join("Pat", ref)).status).toBe(404); // no transfer permitted: it can't leave Other BBL
    const s = h.store.season("otherbbl", "season-0")!;
    s.teams[0]!.transfer = { permitted: true, by: "Pat", at: "2026-11-01T00:00:00.000Z" };
    h.store.putSeason(s);
    const r = await h.join("Pat", ref);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(h.rowOf("Pat")).toMatchObject({ kind: "existing", teamRef: ref, teamName: "Old Orcs", race: "Orc" });
    expect((await h.decide("Pat", "accept")).status).toBe(200);
    const t = h.season().teams.find((x) => x.id === h.rowOf("Pat")!.teamId)!;
    expect(t).toMatchObject({ name: "Old Orcs", coachId: "Pat", teamUid: "tm-bbbbbbbbbbbb", treasury: 30_000 });
    expect(t.players[0]).toMatchObject({ name: "Grub", skills: ["Block"], availableSpp: 6, previousIds: ["p-old1"] });
    expect(t.players[0]!.stats.td).toBe(0); // this season's counters start at zero
    expect(t).not.toHaveProperty("transfer");
  });

  it("validates against the season rules: an invalid team, a missing save and a roster class the league refuses", async () => {
    const h = harness();
    expect(await h.join("Pat", "save:bad-orc")).toMatchObject({ status: 400, body: { code: "invalid-team", problems: ["Too many big guys."] } });
    expect((await h.join("Pat", "save:missing")).status).toBe(404);
    expect(await h.join("Pat", "save:new-gnoblars")).toMatchObject({ status: 400, body: { code: "roster" } });
    h.setReg({ allowedRosters: { official: false, nafApproved: false, unofficial: true } });
    expect(await h.join("Pat", "save:new-orc")).toMatchObject({ status: 400, body: { code: "roster" } });
    expect(h.rows()).toHaveLength(0);
  });

  it("asks for a region from the league's list when it has regions", async () => {
    const h = harness({ league: { regions: ["North", "South"] } });
    expect(await h.join("Pat")).toMatchObject({ status: 400, body: { code: "region" } });
    expect(await h.join("Pat", "save:new-orc", { region: "East" })).toMatchObject({ status: 400, body: { code: "region" } });
    expect((await h.join("Pat", "save:new-orc", { region: "South" })).status).toBe(201);
    expect(h.rowOf("Pat")!.region).toBe("South");
    expect((await h.status(coach("Pat"))).mine).toMatchObject({ region: "South" });
  });

  it("requires the league share acknowledgement, writes it with the grant after the entry, and has no NAF step", async () => {
    const h = harness();
    expect(await h.join("Pat", "save:new-orc", { acknowledged: false })).toMatchObject({ status: 400, body: { field: "acknowledged" } });
    expect(await h.join("Pat", "save:new-orc", { nafNumber: "1234" })).toMatchObject({ status: 400 }); // no NAF field at all
    expect(await h.join("Pat", "save:new-orc", { share: ["shoe-size"] })).toMatchObject({ status: 400, body: { field: "share" } });
    expect(h.rows()).toHaveLength(0);
    expect((await h.join("Pat", "save:new-orc", { share: ["email"] })).status).toBe(201);
    expect(h.acks).toEqual([{ coach: "Pat", league: L, fields: ["email"] }]);
    const status = await h.status();
    expect(JSON.stringify(status)).not.toMatch(/naf/i);
    expect(status.status.shareText).toContain("Rivertown");
    // the organisers see the shared email while the entry is pending
    const rows = (await h.panel()).body as { entries: Array<Record<string, unknown>> };
    expect(rows.entries[0]).toMatchObject({ coachId: "Pat", state: "pending", shared: { coach: "Pat", email: "pat@example.test" } });
  });

  it("withdraw before a decision and re-enter: the same entry id and reference code; an accepted coach asks the organisers", async () => {
    const h = harness();
    await h.join("Pat");
    const first = h.rowOf("Pat")!;
    const w = await h.call("POST", `${base}/registrations/${first.id}/withdraw`, coach("Pat"));
    expect(w).toMatchObject({ status: 200, body: { entry: { state: "withdrawn" } } });
    expect(types(h.sent, "Olga").at(-1)).toBe("withdrawal");
    expect(types(h.sent, "Pat")).not.toContain("withdrawal");
    expect(h.exits.at(-1)).toEqual({ league: L, coaches: ["Pat"] }); // the join acknowledgement goes with the entry
    expect((await h.join("Pat", "save:new-human")).status).toBe(201);
    const again = h.rowOf("Pat")!;
    expect(again).toMatchObject({ id: first.id, refCode: first.refCode, state: "pending", race: "Human", teamName: "Pat Humans" });
    await h.decide("Pat", "accept");
    expect(await h.call("POST", `${base}/registrations/${first.id}/withdraw`, coach("Pat"))).toMatchObject({ status: 409, body: { code: "organiser-only" } });
  });
});

describe("approval and auto mode", () => {
  it("organiser approval: accept creates the team (teamUid, fresh entryId, coach assigned, participant row) and tells the coach", async () => {
    const h = harness();
    await h.join("Pat");
    const r = await h.decide("Pat", "accept", IVY);
    expect(r).toMatchObject({ status: 200, body: { entry: { state: "accepted" }, changed: true } });
    const s = h.season();
    expect(s.teams).toHaveLength(1);
    const t = s.teams[0]!;
    expect(t).toMatchObject({ name: "Pat Orcs", race: "Orc", coach: "Pat", coachId: "Pat", coachAssigned: { by: "Ivy" }, registrationId: h.rowOf("Pat")!.id });
    expect(t.id).toMatch(/^t-[0-9a-f]{10}$/);
    expect(t.teamUid).toMatch(/^tm-[0-9a-f]{12}$/);
    expect(t.entryId).toMatch(/^en-[0-9a-f]{12}$/);
    expect(t.players).toHaveLength(11);
    expect(t.treasury).toBe(1_000_000 - (11 * 50_000 + 120_000));
    expect(s.participants).toEqual([expect.objectContaining({ coachId: "Pat", teamId: t.id, team: "Pat Orcs", active: true, registeredAt: "2026-11-10T12:00:00.000Z" })]);
    expect(h.rowOf("Pat")!.teamId).toBe(t.id);
    expect(h.sent.filter((x) => x.coach === "Pat").at(-1)!.input).toMatchObject({ type: "registration-outcome", action: true });
    expect(types(h.sent, "Ivy").filter((x) => x === "registration-outcome")).toEqual([]);
    // the public Participants list (season read) now shows the team
    const read = (await h.call("GET", base)).body as { season: SeasonRecord };
    expect(read.season.teams.map((x) => x.name)).toEqual(["Pat Orcs"]);
  });

  it("auto mode accepts while there is room, then waitlists (waitlist on) or refuses (off)", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 1 } });
    expect((await h.join("Pat")).body).toMatchObject({ registration: { state: "accepted" } });
    expect(h.season().teams).toHaveLength(1);
    expect((await h.join("Dee", "save:new-human")).body).toMatchObject({ registration: { state: "waitlisted", position: 1 } });
    h.setReg({ waitlist: false });
    expect(await h.join("Eve", "save:new-dwarf")).toMatchObject({ status: 409, body: { code: "full" } });
    // organisers are told on every registration (law 24), never the coach as an organiser notice
    expect(types(h.sent, "Olga").filter((t) => t === "registration")).toHaveLength(2);
    expect(types(h.sent, "Pat")).toEqual(["registration-outcome"]);
  });

  it("decline: the coach gets the reason; the grant is never shown again; the acknowledgement is released", async () => {
    const h = harness();
    await h.join("Pat", "save:new-orc", { share: ["email", "preferredName"] });
    const r = await h.decide("Pat", "decline", OLGA, { reason: "Full of Orcs this season" });
    expect(r.body).toMatchObject({ entry: { state: "declined" } });
    const notice = h.sent.filter((s) => s.coach === "Pat").at(-1)!.input;
    expect(notice).toMatchObject({ type: "registration-outcome", action: true });
    expect(notice.body).toContain("Full of Orcs this season");
    const rows = ((await h.panel()).body as { entries: Array<Record<string, unknown>> }).entries;
    expect(rows[0]).toMatchObject({ state: "declined", decided: { by: "Olga", reason: "Full of Orcs this season" } });
    expect(rows[0]).not.toHaveProperty("shared");
    expect(rows[0]).not.toHaveProperty("refCode");
    expect(h.exits.at(-1)).toEqual({ league: L, coaches: ["Pat"] });
    // the coach sees the reason on their entry, never who decided, and no reference code; a declined coach can't re-enter
    const mine = (await h.status(coach("Pat"))).mine!;
    expect(mine).toMatchObject({ state: "declined", reason: "Full of Orcs this season" });
    expect(mine).not.toHaveProperty("refCode");
    expect(JSON.stringify(mine)).not.toContain("Olga");
    expect(await h.join("Pat")).toMatchObject({ status: 409, body: { code: "declined" } });
  });

  it("waitlist and promote in organiser mode; remove takes the team out (refused while it has fixtures)", async () => {
    const h = harness({ reg: { maxRegistrations: 1 } });
    await h.join("Pat");
    await h.join("Dee", "save:new-human");
    await h.decide("Pat", "accept");
    expect(await h.decide("Dee", "accept")).toMatchObject({ status: 409, body: { code: "full" } });
    expect((await h.decide("Dee", "waitlist")).body).toMatchObject({ entry: { state: "waitlisted" } });
    const panel = (await h.panel()).body as { counts: Record<string, unknown>; entries: Array<Record<string, unknown>> };
    expect(panel.counts).toMatchObject({ accepted: 1, waitlisted: 1, pending: 0, cap: 1, placesLeft: 0 });
    expect(panel.entries.find((e) => e.coachId === "Dee")).toMatchObject({ position: 1, nextInLine: true });
    // a fixture names Pat's team: removal refused, nothing changes
    const s = h.season();
    const teamId = s.teams[0]!.id;
    s.fixtures.push({ id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
      home: { team: "Pat Orcs", teamId, coach: "Pat", race: "Orc", score: null, cas: null, conceded: false },
      away: { team: "X", teamId: "x", coach: "X", race: "Human", score: null, cas: null, conceded: false } } as never);
    h.store.putSeason(s);
    expect((await h.decide("Pat", "remove")).status).toBe(409);
    expect(h.rowOf("Pat")!.state).toBe("accepted");
    const s2 = h.season();
    s2.fixtures = [];
    h.store.putSeason(s2);
    const removed = await h.decide("Pat", "remove", OLGA, { promote: true });
    expect(removed.body).toMatchObject({ entry: { state: "dropped" }, promoted: [{ coachId: "Dee", state: "accepted" }] });
    expect(h.season().teams.map((t) => t.coachId)).toEqual(["Dee"]);
    expect(h.season().participants.map((p) => p.coachId)).toEqual(["Dee"]);
    expect(types(h.sent, "Ivy")).toContain("withdrawal"); // the other organiser hears about the removal
  });
});

describe("races, promotion and atomic acceptance", () => {
  it("two simultaneous joins at the last place: exactly one gets it (cap), the other waitlisted or refused", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 1, waitlist: false } });
    const [a, b] = await Promise.all([h.join("Pat"), h.join("Dee", "save:new-human")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(h.season().teams).toHaveLength(1);
    const h2 = harness({ reg: { approval: "auto", maxRegistrations: 1, waitlist: true } });
    await Promise.all([h2.join("Pat"), h2.join("Dee", "save:new-human")]);
    expect(h2.rows().map((r) => r.state).sort()).toEqual(["accepted", "waitlisted"]);
    expect(h2.season().teams).toHaveLength(1);
  });

  it("two simultaneous joins of one race at the per-race limit: exactly one Orc team", async () => {
    const h = harness({ reg: { approval: "auto", maxPerRace: 1, waitlist: false } });
    const [a, b] = await Promise.all([h.join("Pat", "save:new-orc"), h.join("Dee", "save:new-orc")]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect([a.body, b.body].some((x) => (x as { code?: string }).code === "race-full")).toBe(true);
    expect(h.season().teams.filter((t) => t.race === "Orc")).toHaveLength(1);
    // another race still fits; and two organisers accepting two pending Orcs at once take one place
    expect((await h.join("Eve", "save:new-human")).status).toBe(201);
    const o = harness({ reg: { maxPerRace: 1 } });
    await o.join("Pat", "save:new-orc");
    await o.join("Dee", "save:new-orc");
    const [x, y] = await Promise.all([o.decide("Pat", "accept", OLGA), o.decide("Dee", "accept", IVY)]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(o.season().teams).toHaveLength(1);
  });

  it("imported teams hold places: the cap counts every team in the season", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 1, waitlist: false } });
    const s = h.season();
    s.teams.push({ id: "imported", name: "Imported", race: "Orc", coach: "Zed", coachId: "Zed", teamValue: null, players: [], formerPlayers: [] } as unknown as LeagueTeam);
    h.store.putSeason(s);
    expect(await h.join("Pat", "save:new-human")).toMatchObject({ status: 409, body: { code: "full" } });
  });

  it("waitlist promotion happens exactly once (concurrent removals, concurrent promotes)", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 1 } });
    await h.join("Pat");
    await h.join("Dee", "save:new-human");
    await h.join("Eve", "save:new-dwarf");
    const [r1, r2] = await Promise.all([h.decide("Pat", "remove"), h.decide("Pat", "remove", IVY)]);
    expect([r1.body, r2.body].filter((b) => (b as { changed: boolean }).changed)).toHaveLength(1);
    expect(h.rows().filter((r) => r.state === "accepted").map((r) => r.coach)).toEqual(["Dee"]);
    expect(h.season().teams.map((t) => t.coachId)).toEqual(["Dee"]);
    expect(h.sent.filter((s) => s.coach === "Dee" && s.input.title.startsWith("You're in"))).toHaveLength(1);
    // organiser mode: two organisers promoting the next in line at once: one team
    const o = harness({ reg: { maxRegistrations: 1 } });
    await o.join("Pat");
    await o.join("Dee", "save:new-human");
    await o.decide("Dee", "waitlist");
    await o.decide("Pat", "accept");
    await o.decide("Pat", "remove");
    const [p1, p2] = await Promise.all([o.decide("Dee", "promote", OLGA), o.decide("Dee", "promote", IVY)]);
    expect([p1.body, p2.body].filter((b) => (b as { changed: boolean }).changed)).toHaveLength(1);
    expect(o.season().teams).toHaveLength(1);
  });

  it("accept creates exactly one team in one write: a crash before the write leaves the entry pending and no team", async () => {
    const h = harness();
    await h.join("Pat");
    h.faults.failNextWrite = true;
    await expect(h.decide("Pat", "accept")).rejects.toThrow("disk full");
    expect(h.rowOf("Pat")!.state).toBe("pending");
    expect(h.rowOf("Pat")!.teamId).toBeUndefined();
    expect(h.season().teams).toHaveLength(0);
    expect(h.season().participants).toHaveLength(0);
    expect((await h.decide("Pat", "accept")).body).toMatchObject({ changed: true });
    expect((await h.decide("Pat", "accept")).body).toMatchObject({ changed: false });
    expect(h.season().teams).toHaveLength(1);
    expect(h.season().participants).toHaveLength(1);
    expect(h.season().teams[0]!.id).toBe(h.rowOf("Pat")!.teamId);
  });

  it("a save linked to a team keeps that team's teamUid across seasons of the league", async () => {
    const h = harness({ reg: { approval: "auto", allowExistingTeams: true } });
    const prior = { ...h.season(), id: "season-0", number: 0, sourceSlug: "s0", status: "completed", teams: [
      { id: "old", name: "Old Dwarfs", race: "Dwarf", coach: "Pat", coachId: "Pat", teamValue: null, players: [], formerPlayers: [], teamUid: "tm-aaaaaaaaaaaa", libraryTeamId: "lib-7-dwarf" },
    ], registrations: [] } as unknown as SeasonRecord;
    h.store.putSeason(prior);
    await h.join("Pat", "save:linked-lib-7-dwarf");
    expect(h.season().teams[0]).toMatchObject({ teamUid: "tm-aaaaaaaaaaaa", libraryTeamId: "lib-7-dwarf" });
    // the public read never carries the library or entry links
    const read = (await h.call("GET", base)).body as { season: SeasonRecord };
    expect(read.season.teams[0]).not.toHaveProperty("libraryTeamId");
    expect(read.season.teams[0]).not.toHaveProperty("registrationId");
  });
});

describe("mid-season joining", () => {
  it("allowed only when the season allows it; the team gets no fixtures and the organisers are reminded", async () => {
    const h = harness({ stage: "active" });
    expect(await h.join("Pat")).toMatchObject({ status: 409, body: { code: "started" } });
    h.setReg({ allowMidSeason: true });
    expect((await h.join("Pat")).status).toBe(201);
    const s = h.season();
    s.fixtures.push({ id: "f0", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
      home: { team: "A", teamId: "a", coach: "A", race: "Orc", score: null, cas: null, conceded: false },
      away: { team: "B", teamId: "b", coach: "B", race: "Human", score: null, cas: null, conceded: false } } as never);
    h.store.putSeason(s);
    const r = await h.decide("Pat", "accept");
    expect(r.body).toMatchObject({ entry: { state: "accepted" }, midSeason: true });
    const after = h.season();
    const teamId = after.teams[0]!.id;
    expect(after.fixtures).toHaveLength(1);
    expect(after.fixtures.some((f) => f.home.teamId === teamId || f.away.teamId === teamId)).toBe(false);
    expect(h.rowOf("Pat")!.midSeason).toBe(true);
    for (const org of ["Olga", "Ivy"]) {
      expect(h.sent.some((x) => x.coach === org && x.input.title.startsWith("Add fixtures for Pat Orcs") && x.input.action === true)).toBe(true);
    }
    expect((await h.status(coach("Pat"))).mine).toMatchObject({ state: "accepted", midSeason: true });
  });
});

describe("I've paid and the reference code", () => {
  it("only the coach claims; organisers hear once per 24 hours; the code is private to the coach and the organisers", async () => {
    const h = harness({ reg: { entryFee: "$10 a team", payPal: "https://paypal.me/rivertown" } });
    await h.join("Pat");
    await h.join("Dee", "save:new-human");
    const row = h.rowOf("Pat")!;
    expect((await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, coach("Dee"), { paid: true })).status).toBe(403);
    expect((await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, OLGA, { paid: true })).status).toBe(403);
    const before = h.sent.length;
    const r = await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, coach("Pat"), { paid: true });
    expect(r.body).toMatchObject({ registration: { coachSaysPaid: { at: "2026-11-10T12:00:00.000Z" }, refCode: row.refCode, paid: false } });
    const told = h.sent.slice(before);
    expect(told.map((s) => s.coach).sort()).toEqual(["Ivy", "Olga"]);
    expect(told[0]!.input.body).toContain(row.refCode!);
    // toggled again within 24 hours: no new notice; after 24 hours: one more
    await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, coach("Pat"), { paid: false });
    await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, coach("Pat"), { paid: true });
    expect(h.sent.length).toBe(before + 2);
    h.clock.now = new Date("2026-11-11T12:00:01.000Z");
    await h.call("POST", `${base}/registrations/${row.id}/paid-claim`, coach("Pat"), { paid: true });
    expect(h.sent.length).toBe(before + 4);
    // private: anonymous and other coaches never see a code; the coach sees only their own; organisers see codes + claims
    const anon = await h.status();
    expect(JSON.stringify(anon)).not.toContain("SF-");
    const dee = await h.status(coach("Dee"));
    expect(dee.mine!.refCode).toBe(h.rowOf("Dee")!.refCode);
    expect(JSON.stringify(dee)).not.toContain(row.refCode!);
    const panel = ((await h.panel()).body as { entries: Array<Record<string, unknown>> }).entries.find((e) => e.coachId === "Pat")!;
    expect(panel).toMatchObject({ refCode: row.refCode, coachSaysPaid: { at: "2026-11-10T12:00:00.000Z" } });
    expect(JSON.stringify((await h.call("GET", base, coach("Dee"))).body)).not.toContain("SF-");
    // after acceptance the organisers see it by the Paid toggle in Participants
    await h.decide("Pat", "accept");
    const parts = (await h.call("GET", `${base}/participants`, OLGA)).body as { participants: Array<Record<string, unknown>> };
    expect(parts.participants[0]).toMatchObject({ coachId: "Pat", refCode: row.refCode, coachSaysPaid: { at: "2026-11-10T12:00:00.000Z" }, flags: { paid: false } });
  });
});

describe("Sol hunt list", () => {
  it("an organiser of league A can't act on league B (403), and an entry of another season answers 404", async () => {
    const h = harness();
    await h.join("Pat");
    await h.join("Pat", "save:new-orc", {}, `/api/leagues/otherbbl/seasons/${S}`);
    const mine = h.rowOf("Pat")!;
    const theirs = h.rowOf("Pat", "otherbbl")!;
    expect((await h.call("POST", `/api/leagues/otherbbl/seasons/${S}/registrations/${theirs.id}/accept`, OLGA)).status).toBe(403);
    expect((await h.call("GET", `/api/leagues/otherbbl/seasons/${S}/registrations`, OLGA)).status).toBe(403);
    expect((await h.call("POST", `${base}/registrations/${theirs.id}/accept`, OLGA)).status).toBe(404);
    expect((await h.call("POST", `${base}/registrations/${mine.id}/accept`, OTTO)).status).toBe(403);
    expect((await h.call("POST", `${base}/registrations/team:x/accept`, OLGA)).status).toBe(404);
    expect(h.rowOf("Pat", "otherbbl")!.state).toBe("pending");
    // a site admin may act anywhere; a plain coach never decides
    expect((await h.call("POST", `${base}/registrations/${mine.id}/accept`, coach("Dee"))).status).toBe(403);
    expect((await h.call("POST", `${base}/registrations/${mine.id}/accept`, ROOT)).status).toBe(200);
  });

  it("pending, waitlisted and declined entries never appear on public routes, counts or Participants", async () => {
    const h = harness({ reg: { maxRegistrations: 4 } });
    await h.join("Pat");
    await h.join("Dee", "save:new-human");
    await h.join("Eve", "save:new-dwarf");
    await h.decide("Dee", "waitlist");
    await h.decide("Eve", "decline");
    for (const auth of [undefined, coach("Zed")]) {
      const read = JSON.stringify((await h.call("GET", base, auth)).body);
      for (const name of ["Pat", "Dee", "Eve"]) expect(read).not.toContain(name);
      expect(read).not.toContain("registrations");
      const status = (await h.status(auth)).status;
      expect(status).toMatchObject({ accepted: 0, placesLeft: 4, raceCounts: {} });
      expect(JSON.stringify(status)).not.toMatch(/Pat|Dee|Eve|pending|waitlisted/);
      const lg = (await h.call("GET", `/api/leagues/${L}`, auth)).body as { seasons: Array<{ teamCount: number }> };
      expect(lg.seasons[0]!.teamCount).toBe(0);
    }
    expect(seasonSummary(h.season()).teamCount).toBe(0);
    expect((await h.call("GET", `${base}/registrations`)).status).toBe(401);
    expect((await h.call("GET", `${base}/registrations`, coach("Pat"))).status).toBe(403);
    // a coach sees only their own entry
    const pat = await h.status(coach("Pat"));
    expect(pat.mine).toMatchObject({ state: "pending" });
    expect(JSON.stringify(pat)).not.toMatch(/Dee|Eve/);
    // Participants (organisers) lists teams only
    expect(((await h.call("GET", `${base}/participants`, OLGA)).body as { participants: unknown[] }).participants).toHaveLength(0);
  });

  it("a grant is never shown after a withdrawal; GETs never change state", async () => {
    const h = harness();
    await h.join("Pat", "save:new-orc", { share: ["email"] });
    const file = pathJoin(h.store.leagueDir(L), "seasons", `${S}.json`);
    const stamp = statSync(file).mtimeMs;
    const rev = h.season().revision;
    await h.status(coach("Pat"));
    await h.status();
    await h.panel();
    expect(statSync(file).mtimeMs).toBe(stamp);
    expect(h.season().revision).toBe(rev);
    await h.call("POST", `${base}/registrations/${h.rowOf("Pat")!.id}/withdraw`, coach("Pat"));
    const row = ((await h.panel()).body as { entries: Array<Record<string, unknown>> }).entries[0]!;
    expect(row).toMatchObject({ state: "withdrawn" });
    expect(row).not.toHaveProperty("shared");
    // the privacy reader agrees directly: nothing for a withdrawn entry even with a grant on file
    const entry = rowToEntry(h.rowOf("Pat")!);
    expect(registrationContactFor(OLGA, h.identities.pat, parseShareScope(`league:${L}`)!, { ...entry, competitionId: L }, ["Olga", "Ivy"])).toBeUndefined();
  });

  it("drafts: a draft league's registration is hidden from coaches, and only its organisers are notified", async () => {
    const h = harness({ league: { visibility: "draft" } });
    expect((await h.call("GET", `${base}/join`, coach("Pat"))).status).toBe(404);
    expect((await h.join("Pat")).status).toBe(404);
    expect((await h.call("GET", `${base}/registrations`, OLGA)).status).toBe(200);
    // the owner may enter their own team while it is a draft (organisers add teams until play starts); only organisers hear
    const r = await h.join(OLGA);
    expect(r.status).toBe(201);
    expect(h.sent.every((s) => ["Olga", "Ivy", "Root"].includes(s.coach))).toBe(true);
  });

  it("test sign-in sessions write only in test leagues", async () => {
    const h = harness();
    expect((await h.join(coach("Tess", { test: true }))).status).toBe(403);
    expect(h.rows()).toHaveLength(0);
    const t = harness({ league: { test: true } });
    expect((await t.join(coach("Tess", { test: true }))).status).toBe(201);
  });

  it("every write is covered by the CSRF guard and the 428 onboarding gate; the reads are public on both session gates", () => {
    for (const p of [`${base}/registrations`, `${base}/registrations/lr-1/accept`, `${base}/registrations/lr-1/withdraw`, `${base}/registrations/lr-1/paid-claim`, `${base}/registrations/lr-1/remove`]) {
      expect(isStateChangingApiRequest("POST", p), p).toBe(true);
      expect(onboardingGateApplies("POST", p), p).toBe(true);
    }
    expect(isStateChangingApiRequest("GET", `${base}/join`)).toBe(false);
    expect(isStateChangingApiRequest("GET", `${base}/registrations`)).toBe(false);
    const req = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "GET" } as unknown as IncomingMessage;
    expect(requireSession(req, `${base}/join`, "").kind).toBe("allow");
    const post = { headers: {}, socket: { remoteAddress: "10.0.0.9" }, method: "POST" } as unknown as IncomingMessage;
    expect(requireSession(post, `${base}/registrations`, "").kind).not.toBe("allow");
  });
});

describe("review fixes (Sol, 11-03)", () => {
  it("a skilled starter is priced by the league's own valuation (position cost + starting skill), and the team value follows", async () => {
    const h = harness({ reg: { approval: "auto" } });
    const roster = rosterOf("Human", 11, 50_000);
    roster.players = roster.players.map((p, i) => ({ ...p, positionName: "Human Lineman", MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "9+", skills: i === 0 ? ["Block"] : [] }));
    const r = await h.call("POST", `${base}/registrations`, coach("Pat"), { teamRef: "save:new-human", share: [], acknowledged: true });
    expect(r.status).toBe(201);
    // re-place the team from a sheet with a skilled starter (the fake sheet has plain linemen): exercise placeRegisteredTeam
    const { placeRegisteredTeam, snapshotFromRoster } = await import("../src/leagues/registration.js");
    const s = h.season();
    const row = { ...h.rowOf("Pat")!, teamSnapshot: snapshotFromRoster(roster, "Skilled") };
    const team = placeRegisteredTeam({ id: L, slug: L }, s, row, [s], new Date("2026-11-10T12:00:00.000Z"));
    // the league's own price for that player (teamValue.ts fallbackPlayerValue: position cost + the starting skill)
    const { fallbackPlayerValue, teamValueRoster, computeTeamValue } = await import("../src/leagues/teamValue.js");
    const human = teamValueRoster("Human")!;
    const priced = fallbackPlayerValue({ ...team.players[0]!, value: null }, human).value!;
    expect(priced).toBeGreaterThan(50_000);
    expect(team.players[0]!.value).toBe(priced);
    expect(team.players[0]!.purchasePrice).toBe(priced);
    expect(team.players[1]!.value).toBe(50_000);
    expect(team.teamValue).toBe(computeTeamValue(team, human).teamValue);
    expect(team.teamValue).toBe(priced + 10 * 50_000 + 2 * human.reRollCost);
  });

  it("a pending or waitlisted coach can change or revoke their league grant from Account Sharing; not after a decline", async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), "bbtv-lreg-ids-"));
    roots.push(dir);
    const file = pathJoin(dir, "identities.json");
    const prev = process.env.IDENTITIES_FILE;
    process.env.IDENTITIES_FILE = file;
    try {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(file, JSON.stringify({ version: 1, coaches: { pat: { ffbCoachId: "Pat", level: "player", banned: false, silenced: false, note: "", profile: {}, identities: {}, updatedAt: "", updatedBy: "",
        contact: { email: "pat@example.test", emailSource: "user", emailVerified: true, phones: [] } } } }), "utf8");
      const { acknowledgeLeagueJoin } = await import("../src/auth/leagueSharing.js");
      const { setSharing, SharingError } = await import("../src/auth/sharing.js");
      const { readIdentities } = await import("../src/auth/identitiesStore.js");
      const h = harness();
      await h.join("Pat", "save:new-orc", { share: ["email"] });
      acknowledgeLeagueJoin("Pat", L, ["email"], new Date("2026-11-10T12:00:00.000Z"));
      const sources = { leagues: h.store, tournaments: { tournament: () => undefined, entrants: () => [] } } as never;
      // pending: the coach revokes the email grant directly (PUT /api/me/sharing/league:<id>)
      setSharing("Pat", `league:${L}`, { fields: [] }, sources, new Date("2026-11-10T13:00:00.000Z"));
      expect(readIdentities().coaches.pat!.consent?.sharing?.[`league:${L}`]?.fields).toEqual([]);
      // waitlisted: may change it again
      await h.decide("Pat", "waitlist");
      setSharing("Pat", `league:${L}`, { fields: ["email"] }, sources, new Date("2026-11-10T14:00:00.000Z"));
      expect(readIdentities().coaches.pat!.consent?.sharing?.[`league:${L}`]?.fields).toEqual(["email"]);
      // declined: out of scope
      await h.decide("Pat", "decline");
      let status = 0;
      try { setSharing("Pat", `league:${L}`, { fields: ["phone"] }, sources); } catch (e) { status = (e as InstanceType<typeof SharingError>).status; }
      expect(status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.IDENTITIES_FILE; else process.env.IDENTITIES_FILE = prev;
    }
  });
});

// Owner rule 11-03 (mirrors the tournament side): a waitlisted entry made with a fork library team before the rule is never
// promoted, and never stops the next eligible entry or an unrelated registration.
describe("blocked legacy library entries in the waitlist", () => {
  const makeLegacy = (h: ReturnType<typeof harness>, who: string) => {
    const s = h.season();
    s.registrations = (s.registrations ?? []).map((r) => (r.coach === who ? { ...r, teamRef: "library:lib-1-dwarf" } : r));
    h.store.putSeason(s);
  };

  it("auto promotion skips the blocked entry and promotes the next eligible one; later joins still work", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 2, waitlist: true } });
    await h.join("Pat", "save:new-orc");
    await h.join("Zed", "save:new-human");
    await h.join("Dee", "save:new-dwarf");
    await h.join("Eve", "save:new-elf");
    expect(h.rowOf("Dee")!.state).toBe("waitlisted");
    makeLegacy(h, "Dee");
    expect((await h.decide("Pat", "remove")).status).toBe(200);
    expect(h.rowOf("Dee")!.state).toBe("waitlisted");
    expect(h.rowOf("Eve")!.state).toBe("accepted");
    expect((await h.join("Fay", "save:new-human")).body).toMatchObject({ registration: { state: "waitlisted" } });
  });

  it("a free place with only a blocked entry waiting never fails an unrelated join", async () => {
    const h = harness({ reg: { approval: "auto", maxRegistrations: 2, waitlist: true } });
    await h.join("Pat", "save:new-orc");
    await h.join("Zed", "save:new-human");
    await h.join("Dee", "save:new-dwarf");
    makeLegacy(h, "Dee");
    expect((await h.decide("Pat", "remove")).status).toBe(200);
    expect(h.rowOf("Dee")!.state).toBe("waitlisted");
    expect((await h.join("Gus", "save:new-orc")).body).toMatchObject({ registration: { state: "accepted" } });
  });
});

// ---- the club pick at join (clubs lane, src/clubs/pick.ts) ----------------------------------------------------------
describe("club pick at join", () => {
  const CLUBS: Record<string, Array<{ id: string; name: string }>> = { pat: [{ id: "red", name: "Red Club" }, { id: "blue", name: "Blue Club" }], quinn: [] };
  const install = async () => {
    const { setClubDirectory } = await import("../src/clubs/pick.js");
    setClubDirectory({ membershipsOf: (c) => CLUBS[c.toLowerCase()] ?? [], nameOf: (id) => ({ red: "Red Club", blue: "Blue Club" } as Record<string, string>)[id] });
    return () => setClubDirectory(undefined);
  };

  it("stores the picked club (one of the coach's, or none) on the season entry; organisers and the coach see it", async () => {
    const off = await install();
    try {
      const h = harness();
      expect((await h.join("Pat", "save:new-orc", { clubId: "green" })).body).toMatchObject({ code: "club" });
      expect((await h.join("Pat", "save:new-orc", { clubId: "red" })).status).toBe(201);
      expect(h.rowOf("Pat")!.clubId).toBe("red");
      const panel = (await h.panel()).body as { entries: Array<Record<string, unknown>> };
      expect(panel.entries.find((e) => e.coachId === "Pat")).toMatchObject({ clubId: "red", clubName: "Red Club" });
      expect((await h.status(coach("Pat"))).mine).toMatchObject({ clubId: "red", clubName: "Red Club" });
      // no club is fine (players are not required to join as a club)
      expect((await h.join("Quinn", "save:new-human")).status).toBe(201);
      expect(h.rowOf("Quinn")!.clubId).toBeUndefined();
    } finally { off(); }
  });

  it("the club is fixed once the entry was accepted: a re-entry keeps it, a different pick is refused", async () => {
    const off = await install();
    try {
      const h = harness();
      await h.join("Pat", "save:new-orc", { clubId: "red" });
      expect((await h.decide("Pat", "accept")).status).toBe(200);
      expect((await h.decide("Pat", "withdraw")).status).toBe(200);
      const again = await h.join("Pat", "save:new-orc", { clubId: "blue" });
      expect(again.body).toMatchObject({ code: "club-fixed" });
      expect((await h.join("Pat", "save:new-orc")).status).toBe(201);
      expect(h.rowOf("Pat")!.clubId).toBe("red");
    } finally { off(); }
  });

  it("before acceptance a re-entry may change the club (withdraw, then join again)", async () => {
    const off = await install();
    try {
      const h = harness();
      await h.join("Pat", "save:new-orc", { clubId: "red" });
      expect((await h.call("POST", `${base}/registrations/${h.rowOf("Pat")!.id}/withdraw`, coach("Pat"))).status).toBe(200);
      expect((await h.join("Pat", "save:new-orc", { clubId: "blue" })).status).toBe(201);
      expect(h.rowOf("Pat")!.clubId).toBe("blue");
      expect((await h.call("POST", `${base}/registrations/${h.rowOf("Pat")!.id}/withdraw`, coach("Pat"))).status).toBe(200);
      expect((await h.join("Pat", "save:new-orc")).status).toBe(201);
      expect(h.rowOf("Pat")!.clubId).toBeUndefined();
    } finally { off(); }
  });
});
