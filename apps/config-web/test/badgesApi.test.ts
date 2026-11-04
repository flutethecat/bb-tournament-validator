import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { badgesApi, isPublicBadgeRead, type BadgesApiDeps, type BadgesAuth } from "../src/badges/api.js";
import { BadgeStore } from "../src/badges/store.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import type { NotificationInput } from "../src/notifications.js";
import { requireSession } from "../src/auth/requireSession.js";
import { DELETE_STEPS, deleteContext, splitPlan, STORE_COLLECTORS } from "../src/privacy/collectors.js";

// Organiser custom badges (badges lane 11-04): an organiser of THAT league (or a site admin) creates league badges and
// awards / revokes them by hand for a coach or team in the league; every write names the revision (428 / 409) and is
// logged; draft leagues tell only organisers; the reads are public. Privacy: awards go in the export and go on delete.

let dir: string;
let leagues: LeagueStore;
let store: BadgeStore;
let notes: Array<[string, NotificationInput]>;
const ADMINS = new Set(["site-admin"]);
const team = (id: string, name: string, coach: string): LeagueTeam =>
  ({ id, name, race: "Orc", coach, coachId: coach, players: [], formerPlayers: [], teamValue: null, treasury: null, rerolls: null }) as never;
const season = (leagueId: string, teams: LeagueTeam[]): SeasonRecord => ({
  id: "season-1", leagueId, number: 1, name: "Season 1", sourceSlug: "season-1", ruleset: "BB2025", status: "active", phases: [], fixtures: [],
  teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
});
const deps = (): BadgesApiDeps => ({ store, leagues, isAdmin: (c) => ADMINS.has(c), notify: (c, i) => notes.push([c, i]), now: () => new Date("2026-11-04T10:00:00.000Z") });
const call = (method: string, path: string, auth?: BadgesAuth, body?: unknown) => badgesApi(method, path, auth, body, deps());
const as = (coach: string): BadgesAuth => ({ coach });
const B = "/api/badges/league";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "badges-api-"));
  leagues = new LeagueStore(dir);
  store = new BadgeStore(dir);
  notes = [];
  leagues.upsertLeague({ id: "lg", name: "Test League", fullName: "Test League", slug: "lg", organisers: ["OrgA"] } as never);
  leagues.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["OrgB"] } as never);
  leagues.upsertLeague({ id: "dr", name: "Drafty", fullName: "Drafty", slug: "dr", organisers: ["OrgD"], visibility: "draft" } as never);
  leagues.putSeason(season("lg", [team("orcs", "Orcs", "Ann"), team("elves", "Elves", "Bob")]));
  leagues.putSeason(season("other", [team("dwarfs", "Dwarfs", "Cy")]));
  leagues.putSeason(season("dr", [team("rats", "Rats", "Dee")]));
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

async function create(leagueId = "lg", actor = "OrgA", extra: Record<string, unknown> = {}) {
  const rev = ((await call("GET", `${B}/${leagueId}`, as(actor)))!.body as { revision: number }).revision;
  return call("POST", `${B}/${leagueId}/badges`, as(actor), { revision: rev, name: "Iron Man", description: "Played through the flu.", icon: "heart", scope: "both", ...extra });
}

describe("custom badge auth", () => {
  it("only this league's organisers (or a site admin) create badges; others get 401 / 403", async () => {
    expect((await call("POST", `${B}/lg/badges`, undefined, { revision: 0, name: "X", icon: "star" }))!.status).toBe(401);
    expect((await call("POST", `${B}/lg/badges`, as("Ann"), { revision: 0, name: "X", icon: "star" }))!.status).toBe(403);
    // another league's organiser is a plain viewer here
    expect((await call("POST", `${B}/lg/badges`, as("OrgB"), { revision: 0, name: "X", icon: "star" }))!.status).toBe(403);
    const made = await create();
    expect(made!.status).toBe(201);
    expect((await create("lg", "site-admin", { name: "Admin made" }))!.status).toBe(201);
    // a test sign-in writes only in a test league
    expect((await call("POST", `${B}/lg/badges`, { coach: "OrgA", test: true }, { revision: 2, name: "T", icon: "star" }))!.status).toBe(403);
  });

  it("revisions: missing = 428, stale = 409; icons come from the provided set; names are checked", async () => {
    expect((await call("POST", `${B}/lg/badges`, as("OrgA"), { name: "X", icon: "star" }))!.status).toBe(428);
    expect((await call("POST", `${B}/lg/badges`, as("OrgA"), { revision: 5, name: "X", icon: "star" }))!.status).toBe(409);
    expect((await call("POST", `${B}/lg/badges`, as("OrgA"), { revision: 0, name: "X", icon: "/icons/x.png" }))!.status).toBe(400);
    expect((await call("POST", `${B}/lg/badges`, as("OrgA"), { revision: 0, name: "   ", icon: "star" }))!.status).toBe(400);
    expect((await call("POST", `${B}/lg/badges`, as("OrgA"), { revision: 0, name: "x".repeat(61), icon: "star" }))!.status).toBe(400);
  });

  it("awards only to a coach or team of THIS league, once; revoke; every action logged", async () => {
    const badge = ((await create())!.body as { badge: { id: string }; revision: number });
    let rev = 1;
    const award = (body: Record<string, unknown>, actor = "OrgA") => call("POST", `${B}/lg/badges/${badge.badge.id}/award`, as(actor), { revision: rev, ...body });
    expect((await award({ coach: "Cy" }))!.status).toBe(400); // Cy plays in another league
    expect((await award({ seasonId: "season-1", teamId: "dwarfs" }))!.status).toBe(400);
    expect((await award({ coach: "ann" }, "OrgB"))!.status).toBe(403);
    const a1 = await award({ coach: "ann", note: "Well played" });
    expect(a1!.status).toBe(201);
    rev = (a1!.body as { revision: number }).revision;
    expect((await award({ coach: "Ann" }))!.status).toBe(409); // already awarded
    const a2 = await award({ seasonId: "season-1", teamId: "elves" });
    expect(a2!.status).toBe(201);
    rev = (a2!.body as { revision: number }).revision;
    // the coach (and the team's coach) were told
    expect(notes.map(([c, i]) => [c, i.type, i.title])).toEqual([["Ann", "award", "Badge earned: Iron Man"], ["Bob", "award", "Badge earned: Iron Man"]]);
    // public reads: the coach strip and the league panel show it
    const strip = (await call("GET", "/api/badges/coach/Ann"))!.body as { badges: Array<{ name: string; source: string; by: string }> };
    expect(strip.badges).toEqual([expect.objectContaining({ name: "Iron Man", source: "league", by: "OrgA" })]);
    const teamView = (await call("GET", "/api/badges/team/lg/season-1/elves"))!.body as { badges: Array<{ name: string }> };
    expect(teamView.badges.map((b) => b.name)).toEqual(["Iron Man"]);
    const pub = (await call("GET", `${B}/lg`))!.body as Record<string, unknown>;
    expect(pub.manage).toBe(false);
    expect(pub.log).toBeUndefined();
    expect((pub.recent as unknown[]).length).toBe(2);
    // revoke
    const awardId = (a1!.body as { award: { id: string } }).award.id;
    expect((await call("POST", `${B}/lg/awards/${awardId}/revoke`, as("OrgB"), { revision: rev }))!.status).toBe(403);
    const rv = await call("POST", `${B}/lg/awards/${awardId}/revoke`, as("OrgA"), { revision: rev, reason: "Mistake" });
    expect(rv!.status).toBe(200);
    expect(((await call("GET", "/api/badges/coach/Ann"))!.body as { badges: unknown[] }).badges).toEqual([]);
    const org = (await call("GET", `${B}/lg`, as("OrgA")))!.body as { manage: boolean; log: Array<{ action: string; by: string }> };
    expect(org.manage).toBe(true);
    expect(org.log.map((l) => `${l.action}:${l.by}`)).toEqual(["revoke:OrgA", "award:OrgA", "award:OrgA", "create:OrgA"]);
  });

  it("archive and edit name the revision; an archived badge can't be awarded", async () => {
    const made = (await create())!.body as { badge: { id: string } };
    expect((await call("PATCH", `${B}/lg/badges/${made.badge.id}`, as("OrgA"), { archived: true }))!.status).toBe(428);
    expect((await call("PATCH", `${B}/lg/badges/${made.badge.id}`, as("OrgA"), { revision: 1, archived: true, name: "Iron Woman" }))!.status).toBe(200);
    expect((await call("POST", `${B}/lg/badges/${made.badge.id}/award`, as("OrgA"), { revision: 2, coach: "Ann" }))!.status).toBe(409);
    expect(((await call("GET", `${B}/lg`))!.body as { badges: unknown[] }).badges).toEqual([]);
  });

  it("a draft league is unknown to everyone but its organisers, and its award notice goes to organisers only", async () => {
    expect((await call("GET", `${B}/dr`))!.status).toBe(404);
    expect((await call("GET", `${B}/dr`, as("Dee")))!.status).toBe(404);
    expect((await call("GET", "/api/badges/team/dr/season-1/rats"))!.status).toBe(404);
    const made = (await create("dr", "OrgD"))!.body as { badge: { id: string } };
    expect((await call("POST", `${B}/dr/badges/${made.badge.id}/award`, as("OrgD"), { revision: 1, coach: "Dee" }))!.status).toBe(201);
    expect(notes).toEqual([]); // Dee is not an organiser: told nothing while the league is a draft
    expect(((await call("GET", "/api/badges/coach/Dee"))!.body as { badges: unknown[] }).badges).toEqual([]);
    expect(((await call("GET", "/api/badges/coach/Dee", as("OrgD")))!.body as { badges: unknown[] }).badges).toHaveLength(1);
  });

  it("GETs never write; the reads are public on both auth paths", async () => {
    await call("GET", `${B}/lg`, as("OrgA"));
    await call("GET", "/api/badges/catalog");
    await call("GET", "/api/badges/coach/Ann");
    expect(() => readFileSync(store.file)).toThrow();
    for (const p of ["/api/badges/catalog", "/api/badges/coach/Ann", "/api/badges/team/lg/season-1/orcs", "/api/badges/league/lg"]) {
      expect(isPublicBadgeRead("GET", p), p).toBe(true);
      expect(requireSession({ method: "GET", headers: {} } as never, p, "").kind, p).toBe("allow");
    }
    expect(isPublicBadgeRead("POST", "/api/badges/league/lg/badges")).toBe(false);
    expect(requireSession({ method: "POST", headers: {} } as never, "/api/badges/league/lg/badges", "").kind).toBe("unauthorized");
    const cat = (await call("GET", "/api/badges/catalog"))!.body as { catalog: Array<{ id: string; status: string }> };
    expect(cat.catalog.find((c) => c.id === "underdog")?.status).toBe("needs-recorder-data");
  });
});

describe("privacy: export and delete", () => {
  it("the export has the coach's awards and what they gave; delete removes awards to them and keeps theirs as organiser under the pseudonym", async () => {
    const made = (await create("lg", "OrgA"))!.body as { badge: { id: string } };
    await call("POST", `${B}/lg/badges/${made.badge.id}/award`, as("OrgA"), { revision: 1, coach: "Ann" });
    await call("POST", `${B}/lg/badges/${made.badge.id}/award`, as("OrgA"), { revision: 2, coach: "Bob" });
    store.update((f) => {
      f.auto.push({ key: "first-win||coach|ann", badgeId: "first-win", subject: { kind: "coach", key: "ann", name: "Ann" }, at: "2026-10-01T00:00:00.000Z", awardedAt: "2026-10-01T00:00:00.000Z", context: {} });
      f.auto.push({ key: "first-win||coach|bob", badgeId: "first-win", subject: { kind: "coach", key: "bob", name: "Bob" }, at: "2026-10-01T00:00:00.000Z", awardedAt: "2026-10-01T00:00:00.000Z", context: {} });
      f.log.unshift({ id: "x", at: "2026-10-01T00:00:00.000Z", action: "award", badgeId: "first-win", subject: { kind: "coach", key: "ann", name: "Ann" }, by: "" });
    });
    const collector = STORE_COLLECTORS.find((c) => c.id === "badges")!;
    const pdeps = { stateDir: dir, tournamentsDir: join(dir, "t"), libraryDir: join(dir, "l"), builderSavesDir: join(dir, "b"), teamAvatarsDir: join(dir, "ta"), coachAvatarsDir: join(dir, "ca"), bugReportsDir: join(dir, "br"), tabletopDir: join(dir, "tt") };
    const files = await (collector.export as (ctx: unknown) => Array<{ name: string; content: string }>)({ deps: pdeps, coach: "Ann", keys: new Set(["ann"]) });
    const out = JSON.parse(files[0]!.content);
    expect(files[0]!.name).toBe("badges.json");
    expect(out.earned.map((a: { badgeId: string }) => a.badgeId)).toEqual(["first-win"]);
    expect(out.leagueAwards).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain("\"Bob\"");
    const orgOut = JSON.parse((await (collector.export as (ctx: unknown) => Array<{ content: string }>)({ deps: pdeps, coach: "OrgA", keys: new Set(["orga"]) }))[0]!.content);
    expect(orgOut.given).toHaveLength(2);
    expect(orgOut.created).toHaveLength(1);

    // delete Ann: her awards and the log rows about her go; Bob's stay
    const P = "Deleted coach #4";
    const ctx = deleteContext(pdeps as never, { ...splitPlan({ jobId: "x".repeat(24), coachHash: "", coach: "Ann", coachNames: ["Ann"], displays: [], pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" } as never).stored, coach: "Ann", coachNames: ["Ann"], displays: [] } as never);
    await DELETE_STEPS.find((s) => s.id === "badges")!.run(ctx);
    let f = store.read();
    expect(f.auto.map((a) => a.subject.name)).toEqual(["Bob"]);
    expect(f.leagues.lg!.awards.map((a) => a.subject.name)).toEqual(["Bob"]);
    expect(JSON.stringify(f)).not.toMatch(/"Ann"|"ann"/);
    // delete the organiser: what they made stays under the pseudonym
    const ctx2 = deleteContext(pdeps as never, { ...splitPlan({ jobId: "y".repeat(24), coachHash: "", coach: "OrgA", coachNames: ["OrgA"], displays: [], pseudonym: P, teamKeys: [], proxyKeys: [], actor: "self", at: "" } as never).stored, coach: "OrgA", coachNames: ["OrgA"], displays: [] } as never);
    await DELETE_STEPS.find((s) => s.id === "badges")!.run(ctx2);
    f = store.read();
    expect(f.leagues.lg!.badges[0]!.createdBy).toBe(P);
    expect(f.leagues.lg!.awards[0]!.by).toBe(P);
    expect(JSON.stringify(f)).not.toContain("OrgA");
  });
});
