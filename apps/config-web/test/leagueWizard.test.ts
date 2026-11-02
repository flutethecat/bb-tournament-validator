import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api";
import { myAwards } from "../src/leagues/awards";
import { resolveLeaguePackage } from "../src/leagues/leagueBuilder";
import { canMoveStage, draftAwareNotify, isDraftLeague, leagueVisibleTo, seasonStage } from "../src/leagues/lifecycle";
import { clearMyLeaguesIndex, myLeagues } from "../src/leagues/myLeagues";
import { checkLeagueRegistration } from "../src/leagues/registrationCheck";
import { parseSeasonRegistration, seasonRegistrationOf, seasonSnapshot, seasonWindowStatus } from "../src/leagues/seasonRegistration";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { draftLeagueMatch, slugifyLeagueName, testSessionMayWriteLeaguePath } from "../src/leagues/wizard";

// League creation wizard + lifecycle (registration spec 11-02 §4 (b), lane L5): POST /api/leagues, PATCH .../draft,
// Publish, season stages, per-season registration settings through the registration core's window, draft visibility on
// every read path, imported leagues as published, permissions and the test sign-in rule (Q13).

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
const ROOT: LeagueApiIdentity = { coach: "Root", admin: true };
const PAT: LeagueApiIdentity = { coach: "Pat", admin: false };
const IVY: LeagueApiIdentity = { coach: "Ivy", admin: false, organizer: true };
const TESS: LeagueApiIdentity = { coach: "Tess", admin: false, organizer: true, test: true };

let dir = "";
let store: LeagueStore;
let body: unknown;
let clock = "2026-11-02T12:00:00.000Z";
const posts: unknown[] = [];
const notes: Array<{ coach: string }> = [];
const teamOf = (id: string, race: string, coach = id): LeagueTeam => ({ id, name: id, race, coach, coachId: coach, teamValue: null, players: [], formerPlayers: [] } as never);
const fixtureOf = (id: string, home: string, away: string) => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
  home: { team: home, teamId: home, coach: home, race: "Orc", score: null, cas: null, conceded: false },
  away: { team: away, teamId: away, coach: away, race: "Human", score: null, cas: null, conceded: false },
});
const deps = (): LeagueApiDeps => ({
  store,
  readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body))),
  now: () => new Date(clock),
  identities: () => [{ coach: "Olga", level: "organizer" }, { coach: "Ivy", level: "organizer" }, { coach: "Pat", level: "player" }, { coach: "Root", level: "admin" }],
  postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  notify: (coach) => { notes.push({ coach }); },
});
async function call(method: string, path: string, auth?: LeagueApiIdentity, b?: unknown, q = ""): Promise<LeagueApiResult> {
  body = b;
  const r = await leagueApi(method, path, new URLSearchParams(q), auth, deps());
  if (!r) throw new Error(`no route for ${method} ${path}`);
  return r;
}
const draftOf = (r: LeagueApiResult) => (r.body as { draft: any }).draft;

async function createDraft(auth: LeagueApiIdentity = OLGA, input: Record<string, unknown> = { name: "Rivertown BBL", fullName: "Rivertown Blood Bowl League", description: "Thursdays." }) {
  const r = await call("POST", "/api/leagues", auth, input);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return draftOf(r);
}
async function patchDraft(id: string, auth: LeagueApiIdentity, section: Record<string, unknown>) {
  const revision = store.league(id)?.revision ?? 0;
  return call("PATCH", `/api/leagues/${id}/draft`, auth, { revision, ...section });
}

/** An imported league as the TourPlay importer writes it: no visibility, an active season with a team and a fixture. */
function seedImported(): void {
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Ivy"] });
  const team = (id: string, coach: string, race: string): LeagueTeam => ({ id, name: id, race, coach, coachId: coach, teamValue: null, players: [], formerPlayers: [] } as never);
  store.putSeason({
    id: "season-6", leagueId: "tabbl", number: 6, name: "Season 6", sourceSlug: "s6", ruleset: "BB2025", status: "active",
    phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
    fixtures: [], participants: [], teams: [team("orcs", "Pat", "Orc")], honours: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
    awards: [{ category: "Season", type: "Most Touchdowns", name: "", description: "", coach: "Pat", coachId: "Pat", team: "orcs", race: "Orc", goldenStar: false }],
  } as SeasonRecord);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "league-wizard-"));
  store = new LeagueStore(dir);
  clock = "2026-11-02T12:00:00.000Z";
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("creating a league (POST /api/leagues)", () => {
  it("site organisers and admins create (Q1); anonymous 401, a plain coach 403; the creator becomes the owner", async () => {
    expect((await call("POST", "/api/leagues", undefined, { name: "X" })).status).toBe(401);
    const pat = await call("POST", "/api/leagues", PAT, { name: "X" });
    expect(pat.status).toBe(403);
    expect((pat.body as { error: string }).error).toMatch(/organisers/);
    const d = await createDraft();
    expect(d).toMatchObject({ id: "rivertown-bbl", visibility: "draft", step: 2, test: false, identity: { name: "Rivertown BBL", slug: "rivertown-bbl" } });
    const league = store.league("rivertown-bbl")!;
    expect(league).toMatchObject({ owner: "Olga", organisers: ["Olga"], visibility: "draft", ruleset: "BB2025", revision: 0 });
    const s = store.seasons("rivertown-bbl");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: "season-1", number: 1, status: "active", stage: "setup", source: "manual", teams: [], fixtures: [] });
    // Season 1 copies the league's registration defaults plus the owner's accepted window defaults (Q5, Q6, Q8, Q9).
    expect(s[0]!.registration).toMatchObject({ allowRegistration: false, approval: "organiser", waitlist: true, allowExistingTeams: false, allowMidSeason: false, maxRegistrations: null });
    const admin = await createDraft(ROOT, { name: "Admin League" });
    expect(store.league(admin.id)?.owner).toBe("Root");
  });

  it("the league address is derived, checked, unique and never a reserved route", async () => {
    expect(slugifyLeagueName("  Tahoma Área B.B.L.!  ")).toBe("tahoma-area-b-b-l");
    await createDraft(OLGA, { name: "Rivertown BBL" });
    const taken = await call("POST", "/api/leagues", IVY, { name: "Rivertown BBL" });
    expect(taken).toMatchObject({ status: 409, body: { field: "slug" } });
    expect(store.league("rivertown-bbl")?.owner).toBe("Olga");
    expect((await call("POST", "/api/leagues", OLGA, { name: "New", slug: "new" })).status).toBe(400);
    expect((await call("POST", "/api/leagues", OLGA, { name: "Bad", slug: "Bad Slug" })).body).toMatchObject({ field: "slug" });
    expect((await call("POST", "/api/leagues", OLGA, { name: "" })).body).toMatchObject({ error: "Name is required." });
    expect((await call("POST", "/api/leagues", OLGA, { name: "x".repeat(41) })).body).toMatchObject({ error: "Name must be at most 40 characters." });
    expect((await createDraft(OLGA, { name: "Other", slug: "my-league" })).id).toBe("my-league");
  });

  it("caps open drafts per owner", async () => {
    for (let i = 0; i < 10; i++) await createDraft(OLGA, { name: `Draft ${i}` });
    expect((await call("POST", "/api/leagues", OLGA, { name: "One more" })).status).toBe(429);
    expect((await call("POST", "/api/leagues", IVY, { name: "Ivy's" })).status).toBe(201);
  });
});

describe("the wizard steps agree with the League settings tabs", () => {
  it("every step saves what the settings tabs would, and refuses what they refuse with the same words", async () => {
    const d = await createDraft();
    const id = d.id as string;
    const rules = await patchDraft(id, OLGA, {
      step: 3,
      rules: {
        ruleset: "BB2020", allowedRosters: { official: true, nafApproved: false, unofficial: true }, maxRegistrations: 12, maxPerRace: 2,
        teamBuilding: { rosters: [{ roster: "Halfling", tier: 4, treasury: 1150, startingSkills: { primary: 2, secondary: 1, elite: 1 } }] },
      },
    });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    const season = await patchDraft(id, OLGA, {
      step: 4,
      season: {
        name: "Founding Season", startsAt: "2026-12-01T12:00:00.000Z", divisions: ["North", "South"], playoffs: true,
        registration: { opensAt: "2026-11-10T18:00:00.000Z", closesAt: "2026-11-30T18:00:00.000Z", approval: "auto", waitlist: false, allowMidSeason: true, entryFee: "$10 at the first game" },
      },
    });
    expect(season.status, JSON.stringify(season.body)).toBe(200);
    const conn = await patchDraft(id, OLGA, { step: 5, connections: { playOnFork: true, discord: { url: HOOK, events: { news: false } } } });
    expect(conn.status).toBe(200);
    expect(JSON.stringify(conn.body)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const done = await patchDraft(id, OLGA, { complete: true });
    expect(draftOf(done)).toMatchObject({ step: 5, completedAt: clock, visibility: "draft" });

    // The settings read model (what the tabs show) holds exactly what the wizard saved.
    const settings = (await call("GET", `/api/leagues/${id}/settings`, OLGA)).body as { settings: any };
    expect(settings.settings.information).toMatchObject({ name: "Rivertown BBL", fullName: "Rivertown Blood Bowl League", description: "Thursdays.", ruleset: "BB2020" });
    expect(settings.settings.registrations).toEqual({ allowedRosters: { official: true, nafApproved: false, unofficial: true }, allowRegistration: false, maxRegistrations: 12, maxPerRace: 2 });
    expect(settings.settings.connections).toMatchObject({ playOnFork: true, discord: { configured: true, events: { news: false, matchResult: true } } });
    expect(settings.settings.permissions).toMatchObject({ owner: "Olga", canEditOrganisers: true });
    const tb = settings.settings.teamBuilding;
    expect(tb).toMatchObject({ seasonId: "season-1", seasonName: "Founding Season", ruleset: "BB2020" });
    expect(tb.rules.rosters.find((r: any) => r.roster === "Halfling")).toEqual({ roster: "Halfling", tier: 4, treasury: 1150, startingSkills: { primary: 2, secondary: 1, elite: 1 } });
    expect(tb.rules.rosters.length).toBeGreaterThan(20);
    const s1 = store.season(id, "season-1")!;
    expect(s1.phases.map((p) => [p.id, p.format ?? "table", p.groups])).toEqual([["season-regular", "table", ["North", "South"]], ["cup-play-offs", "knockout", [""]]]);
    expect(s1.startedAt).toBe("2026-12-01T12:00:00.000Z");
    // The season's registration took the rules step's limits and the season step's window.
    expect(seasonRegistrationOf(store.league(id)!, s1)).toEqual({
      allowedRosters: { official: true, nafApproved: false, unofficial: true }, allowRegistration: false, maxRegistrations: 12, maxPerRace: 2,
      opensAt: "2026-11-10T18:00:00.000Z", closesAt: "2026-11-30T18:00:00.000Z", approval: "auto", waitlist: false, allowExistingTeams: false, allowMidSeason: true,
      entryFee: "$10 at the first game",
    });
    const reg = (await call("GET", `/api/leagues/${id}/seasons/season-1/registration`, OLGA)).body as { registration: any };
    expect(reg.registration).toMatchObject({ stage: "setup", open: false, counts: { teams: 0, cap: 12, placesLeft: 12 } });

    // The same refusals, word for word, as the settings PATCH.
    const viaWizard = await patchDraft(id, OLGA, { rules: { maxRegistrations: 4, maxPerRace: 5 } });
    const viaSettings = await call("PATCH", `/api/leagues/${id}/settings`, OLGA, { revision: store.league(id)!.revision, registrations: { maxRegistrations: 4, maxPerRace: 5 } });
    expect(viaWizard.status).toBe(400);
    expect((viaWizard.body as any).error).toBe((viaSettings.body as any).error);
    const badHook = await patchDraft(id, OLGA, { connections: { discord: { url: "https://evil.example.com/hook" } } });
    expect(badHook.status).toBe(400);
    expect(JSON.stringify(badHook.body)).not.toContain("evil.example.com");
    expect((await patchDraft(id, OLGA, { rules: { teamBuilding: { rosters: [{ roster: "Nope", tier: 1, treasury: 1000 }] } } })).body).toMatchObject({ error: 'Unknown roster "Nope".' });
    expect((await patchDraft(id, OLGA, { season: { registration: { opensAt: "2026-11-30T00:00:00Z", closesAt: "2026-11-01T00:00:00Z" } } })).body).toMatchObject({ field: "closesAt" });
    expect((await patchDraft(id, OLGA, { season: { divisions: ["A", "a"] } })).status).toBe(400);
    expect((await patchDraft(id, OLGA, { identity: { slug: "renamed" } })).status).toBe(400);
    // Nothing was written by a refused step.
    expect(store.league(id)!.registrations).toMatchObject({ maxRegistrations: 12, maxPerRace: 2 });
  });

  it("revision guard (428 missing, 409 stale) and draft-only", async () => {
    const d = await createDraft();
    expect((await call("PATCH", `/api/leagues/${d.id}/draft`, OLGA, { identity: { name: "X" } })).status).toBe(428);
    expect((await call("PATCH", `/api/leagues/${d.id}/draft`, OLGA, { revision: 7, identity: { name: "X" } })).status).toBe(409);
    expect((await call("POST", `/api/leagues/${d.id}/publish`, OLGA, {})).status).toBe(200);
    expect((await patchDraft(d.id, OLGA, { identity: { name: "X" } })).status).toBe(409);
  });

  it("a new season started from Administration copies the league defaults and starts in setup", async () => {
    seedImported();
    await call("PATCH", "/api/leagues/tabbl/settings", IVY, { revision: 0, registrations: { maxRegistrations: 16, maxPerRace: 3, allowRegistration: true } });
    const r = await call("POST", "/api/leagues/tabbl/seasons", IVY, { name: "Season 7" });
    expect(r.status).toBe(201);
    expect((r.body as any).season).toMatchObject({ stage: "setup" });
    const s7 = store.seasons("tabbl")[0]!;
    expect(s7.registration).toMatchObject({ maxRegistrations: 16, maxPerRace: 3, allowRegistration: true, approval: "organiser" });
    // Q7: a later change to the league defaults does not rewrite the season's own copy.
    await call("PATCH", "/api/leagues/tabbl/settings", IVY, { revision: store.league("tabbl")!.revision, registrations: { maxRegistrations: 8 } });
    expect(seasonRegistrationOf(store.league("tabbl")!, store.season("tabbl", s7.id)!).maxRegistrations).toBe(16);
  });
});

describe("draft visibility on every read path", () => {
  async function draftWithData(): Promise<string> {
    const d = await createDraft();
    await patchDraft(d.id, OLGA, { identity: { name: "Secret League" } });
    // Give the draft a team and an award so the per-coach indexes would find them.
    const s = store.season(d.id, "season-1")!;
    s.teams = [{ id: "t1", name: "Hidden Orcs", race: "Orc", coach: "Pat", coachId: "Pat", teamValue: null, players: [], formerPlayers: [] } as never];
    s.awards = [{ category: "Season", type: "Most Casualties", name: "", description: "", coach: "Pat", coachId: "Pat", team: "Hidden Orcs", race: "Orc", goldenStar: false }];
    s.stage = "active";
    store.putSeason(s);
    return d.id;
  }
  const READS = (id: string) => [
    `/api/leagues/${id}`, `/api/leagues/${id}/seasons/season-1`, `/api/leagues/${id}/stats`, `/api/leagues/${id}/honours`,
    `/api/leagues/${id}/seasons/season-1/team-building`, `/api/leagues/${id}/seasons/season-1/registration`, `/api/leagues/${id}/seasons/season-1/inducements`,
    `/api/leagues/${id}/draft`, `/api/leagues/${id}/settings`, `/api/leagues/${id}/logo`, `/api/leagues/${id}/seasons/season-1/participants`,
  ];

  it("anonymous viewers and other coaches get 404 everywhere and never see it listed; organisers and admins do", async () => {
    const id = await draftWithData();
    for (const viewer of [undefined, PAT, IVY]) {
      const list = (await call("GET", "/api/leagues", viewer)).body as { leagues: Array<{ id: string }> };
      expect(list.leagues.map((l) => l.id)).not.toContain(id);
      for (const path of READS(id)) {
        const r = await call("GET", path, viewer);
        expect(r.status === 404 || (!viewer && r.status === 401), `${path} as ${viewer?.coach ?? "anonymous"}: ${r.status}`).toBe(true); // as for an unknown league
        expect(JSON.stringify(r.body)).not.toContain("Secret");
      }
      // Writes too: the league does not exist for them.
      expect((await call("PATCH", `/api/leagues/${id}/settings`, viewer, { revision: 1, information: { name: "Mine" } })).status).toBe(viewer ? 404 : 401);
      expect((await call("POST", `/api/leagues/${id}/publish`, viewer, {})).status).toBe(404);
    }
    for (const viewer of [OLGA, ROOT]) {
      const list = (await call("GET", "/api/leagues", viewer));
      expect((list.body as { leagues: Array<{ id: string; visibility?: string }> }).leagues.find((l) => l.id === id)).toMatchObject({ visibility: "draft" });
      expect(list.headers?.["cache-control"]).toContain("no-store");
      for (const path of READS(id).filter((p) => !p.endsWith("/logo"))) expect((await call("GET", path, viewer)).status, path).toBe(200);
    }
    // A co-organiser added later sees it too.
    await call("PATCH", `/api/leagues/${id}/settings`, OLGA, { revision: store.league(id)!.revision, administration: { addOrganiser: "Ivy" } });
    expect((await call("GET", `/api/leagues/${id}`, IVY)).status).toBe(200);
  });

  it("the per-coach indexes (My leagues, awards, the Roster Builder's league package) skip drafts until published", async () => {
    seedImported();
    const id = await draftWithData();
    clearMyLeaguesIndex(store);
    expect(myLeagues(store, "Pat").map((l) => l.id)).toEqual(["tabbl"]);
    expect(myAwards(store, "Pat").map((a) => a.leagueId)).toEqual(["tabbl"]);
    expect(resolveLeaguePackage(store, `league:${id}:season-1`)).toEqual({ error: "That league season doesn't exist." });
    await call("POST", `/api/leagues/${id}/publish`, OLGA, {});
    clearMyLeaguesIndex(store);
    expect(myLeagues(store, "Pat").map((l) => l.id).sort()).toEqual(["rivertown-bbl", "tabbl"]);
    expect(myAwards(store, "Pat").map((a) => a.leagueId).sort()).toEqual(["rivertown-bbl", "tabbl"]);
    expect(resolveLeaguePackage(store, `league:${id}:season-1`)).not.toHaveProperty("error");
  });

  it("imported leagues (no visibility) count as published", async () => {
    seedImported();
    const lg = store.league("tabbl")!;
    expect(lg.visibility).toBeUndefined();
    expect(isDraftLeague(lg)).toBe(false);
    expect(leagueVisibleTo(lg, undefined)).toBe(true);
    expect((await call("GET", "/api/leagues/tabbl")).status).toBe(200);
    expect(((await call("GET", "/api/leagues")).body as any).leagues.map((l: any) => l.id)).toEqual(["tabbl"]);
    expect(((await call("GET", "/api/leagues")).body as any).leagues[0]).not.toHaveProperty("visibility");
    expect(seasonSnapshot(lg, store.season("tabbl", "season-6")!).published).toBe(true);
    // Absent stage = derived from the status.
    expect(seasonStage(store.season("tabbl", "season-6")!)).toBe("active");
    expect(seasonStage({ status: "completed", stage: "registration" })).toBe("completed");
  });
});

describe("publish and season stages", () => {
  it("Publish: organisers and admins only, once; stages move setup -> registration -> active (2 teams), back only before a result", async () => {
    const d = await createDraft();
    await call("PATCH", `/api/leagues/${d.id}/settings`, OLGA, { revision: 0, administration: { addOrganiser: "Ivy" } });
    expect((await call("POST", `/api/leagues/${d.id}/publish`, PAT, {})).status).toBe(404); // a draft does not exist for Pat
    const pub = await call("POST", `/api/leagues/${d.id}/publish`, IVY, {});
    expect(pub.body).toMatchObject({ ok: true, changed: true, visibility: "published", publishedAt: clock });
    expect(store.league(d.id)!.visibility).toBe("published");
    expect((await call("POST", `/api/leagues/${d.id}/publish`, PAT, {})).status).toBe(403); // published: visible, not his
    expect((await call("POST", `/api/leagues/${d.id}/publish`, OLGA, {})).body).toMatchObject({ changed: false });
    expect((await call("GET", `/api/leagues/${d.id}`)).status).toBe(200);

    const stage = (to: string, who = OLGA) => call("POST", `/api/leagues/${d.id}/seasons/season-1/stage`, who, { stage: to });
    expect((await stage("registration", PAT)).status).toBe(403);
    expect((await stage("bogus")).status).toBe(400);
    const open = await stage("registration");
    expect(open.body).toMatchObject({ changed: true, season: { stage: "registration" } });
    // Opening registration turns Allow registration on for the season.
    expect(seasonRegistrationOf(store.league(d.id)!, store.season(d.id, "season-1")!).allowRegistration).toBe(true);
    expect((await stage("setup")).body).toMatchObject({ season: { stage: "setup" } });
    await stage("registration");
    // Start season needs at least two teams.
    const empty = await stage("active");
    expect(empty).toMatchObject({ status: 409, body: { field: "stage" } });
    expect((empty.body as { error: string }).error).toContain("at least 2 teams");
    const s1 = store.season(d.id, "season-1")!;
    s1.teams = [teamOf("a", "Orc"), teamOf("b", "Human")];
    s1.fixtures = [fixtureOf("f1", "a", "b")] as never;
    store.putSeason(s1);
    expect((await stage("active")).body).toMatchObject({ season: { stage: "active" } });
    // Back to registration while no fixture has a result; never to setup.
    expect((await stage("setup")).status).toBe(409);
    expect((await stage("registration")).body).toMatchObject({ season: { stage: "registration" } });
    expect((await stage("active")).status).toBe(200);
    const played = store.season(d.id, "season-1")!;
    played.fixtures[0] = { ...played.fixtures[0]!, home: { ...played.fixtures[0]!.home, score: 2 }, away: { ...played.fixtures[0]!.away, score: 1 } };
    store.putSeason(played);
    const late = await stage("registration");
    expect(late.status).toBe(409);
    expect((late.body as { error: string }).error).toContain("already has results");
    expect((await call("GET", `/api/leagues/${d.id}`)).body).toMatchObject({ seasons: [{ stage: "active" }] });
    // Finish season stays the way to completed.
    expect((await call("POST", `/api/leagues/${d.id}/seasons/season-1/finish`, OLGA, {})).status).toBe(200);
    expect(seasonStage(store.season(d.id, "season-1")!)).toBe("completed");
    expect(canMoveStage("completed", "active")).toBe(false);
  });

  it("Reopen season returns it to active, never to registration; the window stays closed", async () => {
    seedImported();
    const s = store.season("tabbl", "season-6")!;
    s.stage = "registration";
    s.registration = parseSeasonRegistration({ allowRegistration: true }, seasonRegistrationOf(store.league("tabbl")!, s));
    store.putSeason(s);
    expect(seasonWindowStatus(store.league("tabbl")!, store.season("tabbl", "season-6")!, new Date(clock)).open).toBe(true);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", IVY, {})).status).toBe(200);
    expect(store.season("tabbl", "season-6")!.stage).toBe("active");
    expect(seasonWindowStatus(store.league("tabbl")!, store.season("tabbl", "season-6")!, new Date(clock))).toMatchObject({ open: false, reason: "finished" });
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/reopen", IVY, {})).status).toBe(200);
    const reopened = store.season("tabbl", "season-6")!;
    expect(reopened).toMatchObject({ status: "active", stage: "active" });
    expect(seasonWindowStatus(store.league("tabbl")!, reopened, new Date(clock))).toMatchObject({ open: false, reason: "started" });
    // Even a stored registration stage on a finished season reads as completed and closed.
    const odd = { ...reopened, status: "completed" as const, stage: "registration" as const };
    expect(seasonStage(odd)).toBe("completed");
    expect(seasonWindowStatus(store.league("tabbl")!, odd, new Date(clock))).toMatchObject({ open: false, reason: "finished" });
  });
});

describe("a draft is silent and uncached", () => {
  it("posts nothing to Discord and notifies only its organisers while a draft; publishing replays nothing", async () => {
    const d = await createDraft();
    await patchDraft(d.id, OLGA, { connections: { discord: { url: HOOK } } });
    const s = store.season(d.id, "season-1")!;
    s.teams = [teamOf("a", "Orc"), teamOf("b", "Human")];
    store.putSeason(s);
    posts.length = 0;
    notes.length = 0;
    const news = await call("POST", `/api/leagues/${d.id}/seasons/season-1/news`, OLGA, { title: "Hello", body: "First post." });
    expect(news.status, JSON.stringify(news.body)).toBe(201);
    expect((await call("POST", `/api/leagues/${d.id}/seasons`, OLGA, { name: "Season 2" })).status).toBe(201); // milestone
    expect((await call("POST", `/api/leagues/${d.id}/seasons/season-1/finish`, OLGA, {})).status).toBe(200); // milestone
    expect(posts).toEqual([]);
    expect(notes).toEqual([]); // the team coaches never hear of a hidden league
    // The test post stays: the organiser checks their own webhook.
    expect((await call("POST", `/api/leagues/${d.id}/discord/test`, OLGA, {})).status).toBe(200);
    expect(posts).toHaveLength(1);
    posts.length = 0;
    await call("POST", `/api/leagues/${d.id}/publish`, OLGA, {});
    expect(posts).toEqual([]); // nothing from the draft period is replayed
    const s2 = store.season(d.id, "season-2")!;
    s2.teams = [teamOf("a", "Orc")];
    store.putSeason(s2);
    expect((await call("POST", `/api/leagues/${d.id}/seasons/season-2/news`, OLGA, { title: "Live", body: "Now public." })).status).toBe(201);
    expect(posts).toHaveLength(1);
    expect(notes.map((n) => n.coach)).toEqual(["a"]);
  });

  it("artwork: private, no-store + Vary while a draft; public caching once published", async () => {
    const d = await createDraft();
    store.setArt(d.id, "logo", `league-art/${"a".repeat(64)}.png`);
    const draftLogo = await call("GET", `/api/leagues/${d.id}/logo`, OLGA);
    expect(draftLogo.status).toBe(200);
    expect(draftLogo.headers).toMatchObject({ "cache-control": "private, no-store", vary: "Cookie" });
    expect((await call("GET", `/api/leagues/${d.id}/logo`)).status).toBe(404);
    await call("POST", `/api/leagues/${d.id}/publish`, OLGA, {});
    const pub = await call("GET", `/api/leagues/${d.id}/logo`);
    expect(pub.status).toBe(200);
    expect(pub.headers?.["cache-control"]).toBeUndefined(); // the server's public, max-age default
  });

  it("Message members: a draft answers 404 (not 403) to anyone but its organisers", async () => {
    const { leagueMessagesRoute } = await import("../src/mail/leagueMessages");
    const d = await createDraft();
    const deps = { store } as never;
    expect(leagueMessagesRoute("GET", `/api/leagues/${d.id}/messages`, { coach: "Pat", admin: false }, undefined, deps)?.status).toBe(404);
    expect(leagueMessagesRoute("GET", "/api/leagues/nope/messages", { coach: "Pat", admin: false }, undefined, deps)?.status).toBe(404);
    seedImported();
    expect(leagueMessagesRoute("GET", "/api/leagues/tabbl/messages", { coach: "Pat", admin: false }, undefined, deps)?.status).toBe(403);
  });
});

describe("registration settings enforced through the core window", () => {
  const T = (iso: string) => new Date(iso);
  function setup(over: Partial<SeasonRecord> = {}, leagueOver: Partial<LeagueRecord> = {}) {
    seedImported();
    const league = { ...store.league("tabbl")!, ...leagueOver };
    const season = { ...store.season("tabbl", "season-6")!, stage: "registration" as const, ...over };
    season.registration = parseSeasonRegistration({ allowRegistration: true, maxRegistrations: 3, maxPerRace: 2 }, seasonRegistrationOf(league, season));
    return { league, season };
  }

  it("Allow registration, the stage, publication and the dates decide whether it is open", () => {
    const { league, season } = setup();
    const now = T("2026-11-02T12:00:00Z");
    expect(seasonWindowStatus(league, season, now)).toEqual({ open: true });
    expect(checkLeagueRegistration(league, season, { race: "Human" }, { now })).toEqual({ ok: true });
    expect(seasonWindowStatus(league, { ...season, registration: { ...season.registration!, allowRegistration: false } }, now)).toMatchObject({ open: false, reason: "not-yet-open" });
    expect(seasonWindowStatus(league, { ...season, stage: "setup" }, now)).toMatchObject({ open: false, reason: "not-yet-open" });
    expect(seasonWindowStatus({ ...league, visibility: "draft" }, season, now)).toMatchObject({ open: false, reason: "unpublished" });
    expect(seasonWindowStatus(league, { ...season, status: "completed" }, now)).toMatchObject({ open: false, reason: "finished" });
    // Started: closed unless joining mid-season is on (Q9).
    expect(seasonWindowStatus(league, { ...season, stage: "active" }, now)).toMatchObject({ open: false, reason: "started" });
    expect(seasonWindowStatus(league, { ...season, stage: "active", registration: { ...season.registration!, allowMidSeason: true } }, now)).toEqual({ open: true });
    const dated = { ...season, registration: { ...season.registration!, opensAt: "2026-11-05T00:00:00.000Z", closesAt: "2026-11-20T00:00:00.000Z" } };
    expect(checkLeagueRegistration(league, dated, { race: "Human" }, { now })).toMatchObject({ ok: false, code: "closed", message: "Registration is not open yet." });
    expect(checkLeagueRegistration(league, dated, { race: "Human" }, { now: T("2026-11-10T00:00:00Z") })).toEqual({ ok: true });
    expect(checkLeagueRegistration(league, dated, { race: "Human" }, { now: T("2026-11-20T00:00:00Z") })).toMatchObject({ ok: false, code: "closed", message: "Registration is closed." });
    // An organiser adding a team ignores the dates and Allow registration, never a finished season.
    expect(checkLeagueRegistration(league, dated, { race: "Human" }, { now, organiser: true })).toEqual({ ok: true });
    expect(checkLeagueRegistration(league, { ...dated, status: "completed" }, { race: "Human" }, { now, organiser: true })).toMatchObject({ code: "closed" });
  });

  it("max teams, max per race and the allowed roster classes", () => {
    const { league, season } = setup();
    const now = T("2026-11-02T12:00:00Z");
    const team = (id: string, race: string) => ({ id, name: id, race, coach: id, teamValue: null, players: [], formerPlayers: [] }) as never;
    // One Orc team already: a second fits (max 2 per race), a third does not.
    expect(checkLeagueRegistration(league, season, { race: "orc" }, { now })).toEqual({ ok: true });
    const twoOrcs = { ...season, teams: [team("a", "Orc"), team("b", "Orc")] };
    expect(checkLeagueRegistration(league, twoOrcs, { race: "Orc" }, { now })).toMatchObject({ ok: false, code: "race-full" });
    expect(checkLeagueRegistration(league, twoOrcs, { race: "Human" }, { now })).toEqual({ ok: true });
    const full = { ...season, teams: [team("a", "Orc"), team("b", "Human"), team("c", "Dwarf")] };
    expect(checkLeagueRegistration(league, full, { race: "Halfling" }, { now })).toMatchObject({ ok: false, code: "full", message: "Season 6 is full (3 teams)." });
    // L6 passes its own entries: only accepted ones count.
    const entries = [{ id: "e1", competitionId: "tabbl/season-6", coach: "x", state: "pending" as const, submittedAt: "", enteredAt: "", race: "Orc", log: [] }];
    expect(checkLeagueRegistration(league, full, { race: "Orc" }, { now, entries })).toEqual({ ok: true });
    const noOfficial = { ...season, registration: { ...season.registration!, allowedRosters: { official: false, nafApproved: false, unofficial: true } } };
    expect(checkLeagueRegistration(league, noOfficial, { race: "Human" }, { now })).toMatchObject({ ok: false, code: "roster", message: "Official rosters aren't allowed in this league." });
  });

  it("PATCH .../seasons/:id/registration: organisers only, the season's revision, the shared parser", async () => {
    seedImported();
    const path = "/api/leagues/tabbl/seasons/season-6/registration";
    const pub = (await call("GET", path)).body as { registration: any };
    expect(pub.registration).toMatchObject({ stage: "active", open: false, reason: "started", counts: { teams: 1, cap: null } });
    expect(pub.registration).not.toHaveProperty("revision");
    expect((await call("PATCH", path, PAT, { revision: 0, maxRegistrations: 4 })).status).toBe(403);
    const rev = ((await call("GET", path, IVY)).body as { registration: any }).registration.revision;
    expect((await call("PATCH", path, IVY, { maxRegistrations: 4 })).status).toBe(428);
    expect((await call("PATCH", path, IVY, { revision: rev + 5, maxRegistrations: 4 })).status).toBe(409);
    const bad = await call("PATCH", path, IVY, { revision: rev, maxRegistrations: 2, maxPerRace: 3 });
    expect(bad.body).toMatchObject({ error: "Max per race cannot be more than max registrations.", field: "maxPerRace" });
    const ok = await call("PATCH", path, IVY, { revision: rev, maxRegistrations: 4, allowMidSeason: true, allowRegistration: true, approval: "auto" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((ok.body as any).registration).toMatchObject({ open: true, settings: { maxRegistrations: 4, approval: "auto" }, counts: { teams: 1, cap: 4, placesLeft: 3 } });
    // The Roster Builder's league mode reads the same window.
    const ctx = (await call("GET", "/api/leagues/tabbl/seasons/season-6/team-building")).body as any;
    expect(ctx.registration).toMatchObject({ open: true, maxRegistrations: 4, source: "window" });
  });
});

describe("test sign-in sessions (Q13)", () => {
  it("a test session's league is a test league; it writes only in test leagues", async () => {
    seedImported();
    const d = await createDraft(TESS, { name: "UAT League" });
    expect(store.league(d.id)?.test).toBe(true);
    expect(draftOf(await patchDraft(d.id, TESS, { identity: { name: "UAT League 2" } }))).toMatchObject({ test: true });
    expect((await call("POST", `/api/leagues/${d.id}/publish`, TESS, {})).status).toBe(200);
    // Not in a real league, even one it organises.
    store.updateLeague("tabbl", (l) => { l.organisers.push("Tess"); });
    expect((await call("PATCH", "/api/leagues/tabbl/settings", TESS, { revision: 0, information: { name: "Hacked" } })).status).toBe(403);
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/stage", TESS, { stage: "registration" })).status).toBe(403);
    expect(store.league("tabbl")?.name).toBe("TABBL");
    // The server's pre-check for every league write by a test session.
    expect(testSessionMayWriteLeaguePath(store, "/api/leagues")).toBe(true);
    expect(testSessionMayWriteLeaguePath(store, `/api/leagues/${d.id}/draft`)).toBe(true);
    expect(testSessionMayWriteLeaguePath(store, "/api/leagues/tabbl/settings")).toBe(false);
    expect(testSessionMayWriteLeaguePath(store, "/api/leagues/nope/settings")).toBe(false);
    // A real organiser session is unaffected by a test league's flag.
    expect((await call("POST", "/api/leagues", OLGA, { name: "Real" })).status).toBe(201);
    expect(store.league("real")?.test).toBeUndefined();
  });
});

describe("draft privacy across the other emit and read paths (review round 3)", () => {
  async function draftWithTeams(): Promise<string> {
    const d = await createDraft();
    const s = store.season(d.id, "season-1")!;
    s.teams = [teamOf("a", "Orc", "Pat"), teamOf("b", "Human", "Bea")];
    store.putSeason(s);
    return d.id;
  }

  it("Message members (scope all) on a draft sends nothing: no notification, no email", async () => {
    const { leagueMessagesRoute } = await import("../src/mail/leagueMessages");
    const id = await draftWithTeams();
    const sent: string[] = [];
    const deps = { store, notify: (c: string) => { sent.push(c); }, enqueue: () => { sent.push("email"); return { added: 1 }; } } as never;
    const r = leagueMessagesRoute("POST", `/api/leagues/${id}/messages`, { coach: "Olga", admin: false }, { scope: "all", subject: "Hi", body: "Welcome" }, deps);
    expect(r).toMatchObject({ status: 409, body: { error: "Publish the league before messaging its members." } });
    expect(sent).toEqual([]);
  });

  it("recorder announcements skip a draft league's fixture", async () => {
    const id = await draftWithTeams();
    seedImported();
    expect(draftLeagueMatch(store, { fixtureRef: `league:${id}:season-1:f1` })).toBe(true);
    expect(draftLeagueMatch(store, { leagueSeason: { leagueId: id } })).toBe(true);
    expect(draftLeagueMatch(store, { fixtureRef: "league:tabbl:season-6:f1" })).toBe(false);
    expect(draftLeagueMatch(store, {})).toBe(false);
    await call("POST", `/api/leagues/${id}/publish`, OLGA, {});
    expect(draftLeagueMatch(store, { fixtureRef: `league:${id}:season-1:f1` })).toBe(false);
  });

  it("GET /api/me/leagues/sharing never lists a draft to a coach on its team; its organisers and admins still see it", async () => {
    const { leagueSharingView } = await import("../src/auth/leagueSharing");
    const id = await draftWithTeams();
    seedImported();
    const sources = { leagues: store, tournaments: { tournament: () => undefined, entrants: () => [] } } as never;
    const record = (coach: string, level = "player", leagues: Record<string, unknown> = {}) =>
      ({ ffbCoachId: coach, level, consent: { leagues }, contact: { phones: [] }, identities: {}, profile: {} }) as never;
    expect(leagueSharingView(record("Pat", "player", { [id]: { at: clock } }), sources).leagues.map((l) => l.id)).toEqual(["tabbl"]);
    store.updateLeague(id, (l) => { l.organisers.push("Pat"); });
    expect(leagueSharingView(record("Pat"), sources).leagues.map((l) => l.id).sort()).toEqual([id, "tabbl"].sort());
    expect(leagueSharingView(record("Bea", "admin"), sources).leagues.map((l) => l.id)).toEqual([id]);
    store.updateLeague(id, (l) => { l.organisers = l.organisers.filter((o) => o !== "Pat"); });
    await call("POST", `/api/leagues/${id}/publish`, OLGA, {});
    expect(leagueSharingView(record("Pat"), sources).leagues.map((l) => l.id).sort()).toEqual([id, "tabbl"].sort());
  });

  it("a hidden draft answers exactly like an unknown league (anonymous 401 where routes sign in first)", async () => {
    const id = await draftWithTeams();
    const paths = ["/settings", "/draft", "/seasons/season-1/participants", "/honours", "/seasons/season-1", "/logo", "/seasons/season-1/registration", "/stats"];
    for (const viewer of [undefined, PAT]) {
      for (const p of paths) {
        const draft = await call("GET", `/api/leagues/${id}${p}`, viewer);
        const unknown = await call("GET", `/api/leagues/no-such-league${p}`, viewer);
        expect([p, viewer?.coach, draft.status, draft.body], p).toEqual([p, viewer?.coach, unknown.status, unknown.body]);
      }
      const w1 = await call("PATCH", `/api/leagues/${id}/settings`, viewer, { revision: 0, information: { name: "X" } });
      const w2 = await call("PATCH", "/api/leagues/no-such-league/settings", viewer, { revision: 0, information: { name: "X" } });
      expect([w1.status, w1.body]).toEqual([w2.status, w2.body]);
    }
    expect((await call("GET", `/api/leagues/${id}/settings`)).status).toBe(401);
  });

  it("notifications judge visibility when they are sent: none to coaches before Publish, delivered after", () => {
    const sent: string[] = [];
    store.upsertLeague({ id: "span", name: "Span", fullName: "", slug: "span", organisers: ["Olga"], visibility: "draft" });
    const notify = draftAwareNotify(store, "span", (c: string) => { sent.push(c); }, (c) => c === "Root");
    notify("Pat", {});
    notify("Olga", {});
    notify("Root", {});
    store.updateLeague("span", (l) => { l.visibility = "published"; });
    notify("Pat", {});
    expect(sent).toEqual(["Olga", "Root", "Pat"]);
  });
});
