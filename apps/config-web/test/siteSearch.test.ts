import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IdentityStore } from "../src/auth/identitiesStore";
import { ClubStore } from "../src/clubs/store";
import { parseCompetitionRegion, regionLabel } from "../src/competition/region";
import { leagueApi } from "../src/leagues/api";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import {
  accountGate, buildSearchDocs, PAGE_LIMIT_MAX, SEARCH_SOURCE_PATH, QUERY_MAX, QUICK_LIMIT_MAX, SearchIndex, searchApi, type SearchGroup, type SearchSources, type SearchViewer,
} from "../src/search/index";
import { emptyCompetitionFilters, parseCompetitionFilters, passesCompetitionFilters, type CompetitionFacets } from "../src/search/filters";
import { foldQuery, matchTier } from "../src/search/text";
import { tournamentApi } from "../src/tournaments/api";
import { TournamentStore } from "../src/tournaments/store";
import { RateLimiter } from "../src/translate/guards";
import { clearFences, fenceCoachHash, onCoachFenced } from "../src/privacy/fence";
import { requireSession } from "../src/auth/requireSession";
import type { IncomingMessage } from "node:http";

// Global site search (owner 11-04, round 2 item 7): GET /api/search ranking, privacy (anonymous vs member vs organiser),
// filters, limits, no writes on GET, and the new Region field's round trip (league settings + wizard, tournament page).

const NOW = new Date("2026-11-04T12:00:00.000Z");

const team = (name: string, coach: string, extra: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, race: "Orc", coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0,
  cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [], ...extra,
});
const season = (leagueId: string, number: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${number}`, leagueId, number, name: `Season ${number}`, sourceSlug: `${leagueId}-s${number}`, ruleset: "BB2025", status: "active",
  phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: NOW.toISOString(), source: "manual", ...over,
});
const consented = { privacy: { acceptedVersion: "2026-11-01", at: NOW.toISOString() } };
const identity = (name: string, over: Record<string, unknown> = {}) => ({
  ffbCoachId: name, level: "player", banned: false, silenced: false, note: "", profile: {},
  identities: { email: `${name.toLowerCase().replace(/\W/g, "")}@example.com`, nafId: "12345", nafName: `${name}NAF`, discordUserId: "555000111" },
  consent: consented, updatedAt: NOW.toISOString(), updatedBy: name, ...over,
});

let dir: string;
let leagues: LeagueStore;
let tournaments: TournamentStore;
let clubs: ClubStore;
let people: IdentityStore;
let fenced: Set<string>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "site-search-"));
  leagues = new LeagueStore(dir, { identitiesFile: join(dir, "identities.json") });
  tournaments = new TournamentStore(dir);
  clubs = new ClubStore(dir, { now: () => NOW });
  people = { version: 1, coaches: {} };
  fenced = new Set();
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const sources = (): SearchSources => ({
  leagues, tournaments, clubs, identities: () => people, now: () => NOW,
  avatarFor: (c) => `/api/coach-avatars/${encodeURIComponent(c)}?v=1`, isFenced: (c) => fenced.has(c.toLowerCase()),
});
const index = () => new SearchIndex(() => buildSearchDocs(sources()));

type Body = { groups: Record<string, SearchGroup>; facets: { rulesets: string[]; countries: Array<{ code: string; name: string }> } };
/** The live account check exactly as server.ts wires it: the current identities and the deletion fences. */
const accounts = () => accountGate(people, (c) => fenced.has(c.toLowerCase()));
function search(params: Record<string, string>, viewer?: SearchViewer, idx = index()) {
  return searchApi("GET", new URLSearchParams(params), viewer, { index: idx, accounts });
}
const body = (params: Record<string, string>, viewer?: SearchViewer) => {
  const r = search(params, viewer);
  expect(r.status).toBe(200);
  return r.body as Body;
};
const titles = (params: Record<string, string>, type: string, viewer?: SearchViewer) => body(params, viewer).groups[type]!.items.map((i) => i.title);

function addLeague(id: string, over: Partial<LeagueRecord> = {}): void {
  leagues.upsertLeague({ id, name: id.toUpperCase(), fullName: "", slug: id, description: "", organisers: ["Olga"], ...over }, NOW);
}
function addTournament(name: string, over: { publication?: "draft" | "published"; organizer?: string; packageName?: string; playOnFork?: boolean; region?: unknown } = {}) {
  const t = tournaments.createTournament({
    name, packageName: over.packageName ?? "EuroBowl 2026", maxPlayers: 16, format: "swiss", organizerCoachId: over.organizer ?? "Tara",
    ...(over.publication ? { publication: over.publication } : {}),
    ...(over.playOnFork ? { settings: { playOnFork: true } } : {}),
    ...(over.region ? { page: { region: parseCompetitionRegion(over.region) } } : {}),
  }, NOW);
  return t;
}

const OLGA: SearchViewer = { coach: "olga" }; // organiser (case-insensitive)
const MEMBER: SearchViewer = { coach: "Amy" }; // a coach with a team in the league
const ADMIN: SearchViewer = { coach: "Root", admin: true };

describe("text folding and match tiers", () => {
  it("is case- and diacritic-insensitive and ranks exact > prefix > word prefix > substring", () => {
    expect(foldQuery("  MÜLLER  Straße ")).toBe("muller strasse");
    expect(foldQuery("Ærø Łódź")).toBe("aero lodz");
    expect(matchTier("grudge", "grudge")).toBe(4);
    expect(matchTier("grudge rollers", "grudge")).toBe(3);
    expect(matchTier("the grudge", "grudge")).toBe(2);
    expect(matchTier("begrudged", "grudge")).toBe(1);
    expect(matchTier("orcs", "elves")).toBe(0);
  });
});

describe("ranking", () => {
  it("exact beats prefix beats substring; ties break on recent activity", () => {
    addLeague("mud", { name: "Mud" });
    addLeague("mudbowl", { name: "Mudbowl League" });
    addLeague("bigmud", { name: "Big Mud League" });
    addLeague("amud", { name: "Amudsen" });
    expect(titles({ q: "mud" }, "leagues")).toEqual(["Mud", "Mudbowl League", "Big Mud League", "Amudsen"]);
    // Two equal matches: the more recently active comes first.
    leagues.upsertLeague({ ...leagues.league("mudbowl")!, name: "Mud Two" }, new Date("2026-11-01T00:00:00Z"));
    leagues.upsertLeague({ ...leagues.league("bigmud")!, name: "Mud Three" }, new Date("2026-11-03T00:00:00Z"));
    expect(titles({ q: "mud" }, "leagues").slice(1, 3)).toEqual(["Mud Three", "Mud Two"]);
  });

  it("a name hit outranks a description hit, accents are ignored, every word of a multi-word query must match", () => {
    addLeague("aaa", { name: "Quiet League", description: "We play at the Élite hall" });
    addLeague("bbb", { name: "Elite League" });
    expect(titles({ q: "elite" }, "leagues")).toEqual(["Elite League", "Quiet League"]);
    expect(body({ q: "elite" }).groups.leagues!.items[1]).toMatchObject({ matched: "description" });
    expect(titles({ q: "quiet hall" }, "leagues")).toEqual(["Quiet League"]);
    expect(titles({ q: "quiet nothing" }, "leagues")).toEqual([]);
  });
});

describe("privacy", () => {
  beforeEach(() => {
    addLeague("pub", { name: "Public Grudge League" });
    leagues.putSeason(season("pub", 1, { teams: [team("Grudge Rollers", "Amy")] }));
    addLeague("hidden", { name: "Grudge Draft League", visibility: "draft", organisers: ["Olga"] });
    leagues.putSeason(season("hidden", 1, { teams: [team("Grudge Secret Team", "Amy")] }));
    // A ladder still in setup (and its team) in a published league.
    leagues.putSeason(season("pub", 2, { id: "ladder-1", name: "Grudge Ladder", competition: "ladder", ladder: {} as never, stage: "setup", teams: [team("Grudge Ladder Team", "Bob")] }));
  });

  it("draft leagues, setup ladders and their teams: anonymous and a member see none; the organiser and an admin see them", () => {
    for (const viewer of [undefined, MEMBER]) {
      const b = body({ q: "grudge" }, viewer);
      expect(b.groups.leagues!.items.map((i) => i.title)).toEqual(["Public Grudge League"]);
      expect(b.groups.teams!.items.map((i) => i.title)).toEqual(["Grudge Rollers"]);
      expect(JSON.stringify(b)).not.toMatch(/Draft League|Secret|Grudge Ladder/);
    }
    for (const viewer of [OLGA, ADMIN]) {
      const b = body({ q: "grudge" }, viewer);
      expect(b.groups.leagues!.items.map((i) => i.title).sort()).toEqual(["Grudge Draft League", "Grudge Ladder", "Public Grudge League"]);
      expect(b.groups.leagues!.items.find((i) => i.title === "Grudge Draft League")).toMatchObject({ draft: true, chips: expect.arrayContaining(["Draft"]) });
      expect(b.groups.teams!.items.map((i) => i.title).sort()).toEqual(["Grudge Ladder Team", "Grudge Rollers", "Grudge Secret Team"]);
    }
  });

  it("an active ladder is public; draft rulesets never leak into the anonymous facet list", () => {
    leagues.putSeason({ ...leagues.season("pub", "ladder-1")!, stage: "active" });
    addLeague("secretpkg", { name: "Hush", visibility: "draft", rulesetPackage: "Secret Package" });
    const b = body({ q: "grudge" });
    expect(b.groups.leagues!.items.map((i) => i.title)).toContain("Grudge Ladder");
    expect(b.facets.rulesets).not.toContain("Secret Package");
    expect(body({ q: "grudge" }, OLGA).facets.rulesets).toContain("Secret Package");
  });

  it("unpublished tournaments: only the owner, an organiser and admins", () => {
    addTournament("Grudge Open", { publication: "published" });
    const draft = addTournament("Grudge Hidden Cup", { publication: "draft", organizer: "Tara" });
    tournaments.addOrganizer(draft.id, "Olga", NOW);
    expect(titles({ q: "grudge" }, "tournaments")).toEqual(["Grudge Open"]);
    expect(titles({ q: "grudge" }, "tournaments", MEMBER)).toEqual(["Grudge Open"]);
    expect(titles({ q: "grudge" }, "tournaments", { coach: "TARA" }).sort()).toEqual(["Grudge Hidden Cup", "Grudge Open"]);
    expect(titles({ q: "grudge" }, "tournaments", OLGA).sort()).toEqual(["Grudge Hidden Cup", "Grudge Open"]);
    expect(titles({ q: "grudge" }, "tournaments", ADMIN).sort()).toEqual(["Grudge Hidden Cup", "Grudge Open"]);
  });

  it("coaches: name and the site avatar only; banned, deleted, being-deleted and never-onboarded coaches never appear", () => {
    people.coaches = {
      amy: identity("Amy") as never,
      banned: identity("Amybanned", { banned: true }) as never,
      deleted: identity("Deleted coach #4") as never,
      gone: identity("Amygone") as never,
      fresh: identity("Amyfresh", { consent: undefined }) as never,
    };
    fenced.add("amygone");
    const b = body({ q: "amy", type: "coaches" });
    expect(b.groups.coaches!.items).toEqual([{ type: "coaches", id: "Amy", title: "Amy", url: "/search?type=teams&q=Amy", image: "/api/coach-avatars/Amy?v=1" }]);
    const text = JSON.stringify(body({ q: "a", type: "all" })) + JSON.stringify(body({ q: "amy" }));
    expect(text).not.toMatch(/example\.com|12345|NAF|555000111|banned|Deleted coach|gone|fresh/i);
    // A hidden coach is not named on their league teams either.
    leagues.putSeason(season("pub", 3, { teams: [team("Banned Bashers", "Amybanned")] }));
    expect(body({ q: "bashers" }).groups.teams!.items[0]!.subtitle).not.toContain("Amybanned");
    expect(titles({ q: "amybanned" }, "teams")).toEqual([]);
    // A third-party avatar URL is never passed on.
    const idx = new SearchIndex(() => buildSearchDocs({ ...sources(), avatarFor: () => "https://cdn.discordapp.com/avatars/555000111/x.png" }));
    expect(JSON.stringify(search({ q: "amy", type: "coaches" }, undefined, idx).body)).not.toContain("discord");
  });

  it("coaches and teams need two characters; no blank-query listing of people", () => {
    people.coaches = { amy: identity("Amy") as never };
    expect(body({ q: "a", type: "coaches" }).groups.coaches!.items).toEqual([]);
    expect(body({ type: "teams" }).groups.teams!.items).toEqual([]);
    expect(body({ type: "coaches" }).groups.coaches!.items).toEqual([]);
  });

  it("clubs: archived clubs are not listed (the directory's rule)", () => {
    clubs.create({ name: "Grudge Club", homeRegion: "North", description: "", createdBy: "Amy" });
    const old = clubs.create({ name: "Grudge Old Club", homeRegion: "", description: "", createdBy: "Amy" });
    clubs.update(old.id, (c) => { c.archivedAt = NOW.toISOString(); });
    expect(titles({ q: "grudge" }, "clubs")).toEqual(["Grudge Club"]);
    expect(titles({ q: "grudge" }, "clubs", ADMIN)).toEqual(["Grudge Club"]);
  });

  it("private teams (Roster Builder saves, library teams) are never indexed: teams come from league seasons only", () => {
    const docs = buildSearchDocs(sources());
    expect(docs.filter((d) => d.type === "teams").every((d) => d.url.startsWith("/leagues/"))).toBe(true);
  });
});

describe("filters", () => {
  beforeEach(() => {
    addLeague("tabletop", { name: "Tabletop League", rulesetPackage: "EuroBowl 2026", region: { country: "GB", text: "Greater Manchester" } });
    leagues.putSeason(season("tabletop", 1, { stage: "registration" }));
    leagues.updateLeague("tabletop", (l) => { l.registrations = { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null }; }, NOW);
    addLeague("online", { name: "Online League", playOnFork: true, ruleset: "BB2020", region: { country: "US", text: "Pacific Northwest" } });
    leagues.putSeason(season("online", 1, { ruleset: "BB2020" }));
    addLeague("ladderonly", { name: "Ladder League" });
    leagues.putSeason(season("ladderonly", 1, { id: "ladder-1", name: "Spring Ladder", competition: "ladder", ladder: {} as never, stage: "active" }));
    addTournament("League Cup", { publication: "published", region: { country: "GB", text: "Leeds" } });
  });
  const all = (p: Record<string, string>) => {
    const b = body({ q: "league", ...p });
    return [...b.groups.leagues!.items, ...b.groups.tournaments!.items].map((i) => i.title).sort();
  };

  it("ruleset, region (country and text, accent-folded), format, played on and open for registration", () => {
    expect(all({ ruleset: "EuroBowl 2026" })).toEqual(["League Cup", "Tabletop League"]);
    expect(all({ ruleset: "bb2020" })).toEqual(["Online League"]);
    expect(all({ country: "GB" })).toEqual(["League Cup", "Tabletop League"]);
    expect(all({ region: "manchester" })).toEqual(["Tabletop League"]);
    expect(all({ region: "united kingdom" })).toEqual(["League Cup", "Tabletop League"]);
    expect(all({ format: "tournament" })).toEqual(["League Cup"]);
    expect(all({ format: "ladder" })).toEqual(["Ladder League", "Spring Ladder"]);
    expect(all({ format: "season,tournament" })).toEqual(["League Cup", "Online League", "Tabletop League"]);
    expect(all({ playedOn: "fork" })).toEqual(["Online League"]);
    // A published tournament without a registration window takes entries (legacy rule); the season in registration is open.
    expect(all({ open: "1" })).toEqual(["League Cup", "Tabletop League"]);
    expect(all({ playedOn: "tabletop", country: "GB", format: "season" })).toEqual(["Tabletop League"]);
  });

  it("filters list competitions without a query on the Search page, and leave clubs, coaches and teams out", () => {
    people.coaches = { leaguefan: identity("Leaguefan") as never };
    const b = body({ type: "all", country: "GB" });
    expect(b.groups.leagues!.items.map((i) => i.title)).toEqual(["Tabletop League"]);
    expect(b.groups.coaches!.items).toEqual([]);
    expect(body({ type: "leagues" }).groups.leagues!.items.length).toBe(4);
    expect(body({ type: "all" }).groups.leagues!.items).toEqual([]);
    expect(body({ q: "league", country: "GB" }).groups.coaches!.items).toEqual([]);
  });

  it("the shared predicate drops unknown values and matches what the server applies", () => {
    const f = parseCompetitionFilters(new URLSearchParams("country=zz,gb&format=season,bogus&playedOn=moon&open=1&ruleset=EuroBowl 2026, Plus"));
    expect(f).toEqual({ rulesets: ["EuroBowl 2026, Plus"], countries: ["GB"], region: "", formats: ["season"], playedOn: [], registrationOpen: true });
    const facets: CompetitionFacets = { rulesets: ["BB2025"], formats: ["season"], playedOn: "tabletop", registrationOpen: false };
    expect(passesCompetitionFilters(facets, emptyCompetitionFilters())).toBe(true);
    expect(passesCompetitionFilters(facets, { ...emptyCompetitionFilters(), registrationOpen: true })).toBe(false);
  });
});

describe("limits", () => {
  beforeEach(() => { for (let i = 0; i < 60; i++) addLeague(`l-${i}`, { name: `Limit League ${i}` }); });

  it("caps the query length, the result counts and the offset; refuses unknown types and writes", () => {
    expect(search({ q: "x".repeat(QUERY_MAX + 1) }).status).toBe(400);
    expect(search({ q: "x".repeat(QUERY_MAX) }).status).toBe(200);
    expect(search({ q: "a", type: "nope" }).status).toBe(400);
    const quick = body({ q: "limit", limit: "999" }).groups.leagues!;
    expect(quick.items.length).toBe(QUICK_LIMIT_MAX);
    expect(quick).toMatchObject({ total: 60, more: true });
    expect(body({ q: "limit" }).groups.leagues!.items.length).toBe(5);
    const page = body({ q: "limit", type: "leagues", limit: "999" }).groups.leagues!;
    expect(page.items.length).toBe(PAGE_LIMIT_MAX);
    const rest = body({ q: "limit", type: "leagues", limit: "50", offset: "50" }).groups.leagues!;
    expect(rest).toMatchObject({ total: 60, more: false });
    expect(rest.items.length).toBe(10);
    expect(searchApi("POST", new URLSearchParams(), undefined, { index: index() }).status).toBe(405);
  });

  it("rate-limits per coach, else per IP (429 with Retry-After)", () => {
    const limiter = new RateLimiter({ maxRequests: 2, maxChars: Number.MAX_SAFE_INTEGER, windowMs: 60_000, maxKeys: 100 });
    const idx = index();
    const call = (viewer?: SearchViewer, ip = "1.2.3.4") => searchApi("GET", new URLSearchParams("q=limit"), viewer, { index: idx, limiter, ip });
    expect(call().status).toBe(200);
    expect(call().status).toBe(200);
    const blocked = call();
    expect(blocked.status).toBe(429);
    expect(blocked.headers?.["retry-after"]).toMatch(/^\d+$/);
    expect(call(undefined, "5.6.7.8").status).toBe(200);
    expect(call(MEMBER).status).toBe(200);
  });

  it("answers 503 (never a stale index) when a store cannot be read", () => {
    let fail = false;
    const idx = new SearchIndex(() => { if (fail) throw new Error("unreadable"); return buildSearchDocs(sources()); });
    expect(searchApi("GET", new URLSearchParams("q=limit"), undefined, { index: idx }).status).toBe(200);
    fail = true;
    idx.invalidate();
    expect(searchApi("GET", new URLSearchParams("q=limit"), undefined, { index: idx }).status).toBe(503);
  });

  it("the index is reused until invalidated or older than its TTL", () => {
    let builds = 0;
    let clock = 0;
    const idx = new SearchIndex(() => { builds += 1; return []; }, { ttlMs: 1000, now: () => clock });
    idx.docs(); idx.docs();
    expect(builds).toBe(1);
    idx.invalidate(); idx.docs();
    expect(builds).toBe(2);
    clock = 1500; idx.docs();
    expect(builds).toBe(3);
  });

  it("writes to listed things invalidate the index; lobby, chat and notification writes do not", () => {
    for (const p of ["/api/leagues", "/api/leagues/x/settings", "/api/tournaments/t1", "/api/clubs/c/leave", "/api/me/profile", "/api/admin/identities", "/api/series/s"]) expect(SEARCH_SOURCE_PATH.test(p)).toBe(true);
    for (const p of ["/api/lobby/x/chat", "/api/notifications/read", "/api/tabletop/matches/m", "/api/leaguesx"]) expect(SEARCH_SOURCE_PATH.test(p)).toBe(false);
  });
});

describe("Sol review fixes", () => {
  it("a team's linked account (coachId) that is banned or never onboarded hides its coach name from matching and output", () => {
    people.coaches = {
      acct: identity("acct42", { banned: true }) as never,
      fresh: identity("fresh7", { consent: undefined }) as never,
      ok: identity("okcoach") as never,
    };
    addLeague("pub", { name: "Public League" });
    leagues.putSeason(season("pub", 1, { teams: [
      team("Imported Bashers", "Imported Name", { coachId: "acct42" }),
      team("Fresh Bashers", "Fresh Imported", { coachId: "Fresh7" }),
      team("Fine Bashers", "Fine Imported", { coachId: "okcoach" }),
    ] }));
    expect(titles({ q: "imported name" }, "teams")).toEqual([]);
    expect(titles({ q: "fresh imported" }, "teams")).toEqual([]);
    expect(titles({ q: "fine imported" }, "teams")).toEqual(["Fine Bashers"]);
    const items = body({ q: "bashers", type: "teams" }).groups.teams!.items;
    expect(items.map((i) => i.title).sort()).toEqual(["Fine Bashers", "Fresh Bashers", "Imported Bashers"]);
    expect(JSON.stringify(items)).not.toMatch(/Imported Name|Fresh Imported|acct42|fresh7/i);
    expect(items.find((i) => i.title === "Fine Bashers")!.subtitle).toContain("Fine Imported");
  });

  it("team result ids and links are opaque and stable: never built from a coach name", () => {
    addLeague("pub", { name: "Public League" });
    leagues.putSeason(season("pub", 1, { teams: [
      team("Bashers", "alice42", { id: "bashers--alice42" }),
      team("Bashers", "bob77", { id: "bashers--bob77", teamUid: "tm-0a1b2c3d4e5f" }),
      team("Only Team", "carol9", { id: "only-team--carol9" }),
    ] }));
    const items = body({ q: "bashers", type: "teams" }).groups.teams!.items;
    const again = search({ q: "bashers", type: "teams" }).body as Body;
    expect(items.map((i) => i.id).sort()).toEqual(again.groups.teams!.items.map((i) => i.id).sort());
    for (const i of items) {
      expect(i.id).toMatch(/^t-[0-9a-f]{20}$/);
      expect(`${i.id} ${i.url}`).not.toMatch(/alice|bob/);
    }
    expect(items.map((i) => i.url).sort()).toEqual([
      "/leagues/pub?season=season-1&tab=participants", // a duplicate name without a lineage id: the participants list
      "/leagues/pub?season=season-1&tab=participants&team=tm-0a1b2c3d4e5f",
    ]);
    expect(body({ q: "only team", type: "teams" }).groups.teams!.items[0]!.url).toBe("/leagues/pub?season=season-1&tab=participants&team=Only%20Team");
  });

  it("bans, deletion fences and privacy revocations apply at once, whatever the index age", () => {
    people.coaches = { amy: identity("Amy") as never, bob: identity("Bob") as never, cal: identity("Cal") as never };
    addLeague("pub", { name: "Public League" });
    leagues.putSeason(season("pub", 1, { teams: [team("Amy Team", "Amy"), team("Bob Team", "Bob"), team("Cal Team", "Cal")] }));
    let builds = 0;
    const idx = new SearchIndex(() => { builds += 1; return buildSearchDocs(sources()); }, { ttlMs: 60_000 });
    const names = (q: string, type: string) => ((search({ q, type }, undefined, idx).body as Body).groups[type]!.items.map((i) => `${i.title}|${i.subtitle ?? ""}`));
    expect(names("amy", "coaches")).toEqual(["Amy|"]);
    expect(names("amy team", "teams")[0]).toBe("Amy Team|Orc · Amy · Public League Season 1");
    expect(builds).toBe(1);
    fenced.add("amy"); // deletion starts
    people.coaches = { ...people.coaches, bob: identity("Bob", { banned: true }) as never, cal: identity("Cal", { consent: undefined }) as never };
    expect(names("amy", "coaches")).toEqual([]);
    expect(names("bob", "coaches")).toEqual([]);
    expect(names("cal", "coaches")).toEqual([]);
    const teams = names("team", "teams");
    expect(teams.length).toBe(3);
    for (const t of teams) expect(t.split("|")[1]).not.toMatch(/Amy|Bob|Cal/);
    expect(builds).toBe(1); // same index: the check is live
    // An unreadable identities store fails closed (503), never a result without the check.
    const r = searchApi("GET", new URLSearchParams("q=amy"), undefined, { index: idx, accounts: () => { throw new Error("unreadable"); } });
    expect(r.status).toBe(503);
  });

  it("a deletion fence tells its listeners synchronously (server.ts drops the index then)", () => {
    let told = 0;
    const off = onCoachFenced(() => { told += 1; });
    fenceCoachHash("0".repeat(64));
    expect(told).toBe(1);
    off();
    fenceCoachHash("1".repeat(64));
    expect(told).toBe(1);
    clearFences();
  });

  it("a ladder's own Played on (not the league's) drives its facets and chips", () => {
    addLeague("tt", { name: "Tabletop Ladders" });
    leagues.putSeason(season("tt", 1, { id: "ladder-1", name: "Online Ladder", competition: "ladder", ladder: { playOnFork: true } as never, stage: "active" }));
    leagues.putSeason(season("tt", 2, { id: "ladder-2", name: "Table Ladder", competition: "ladder", ladder: { playOnFork: false } as never, stage: "active" }));
    addLeague("on", { name: "Online Ladders", playOnFork: true });
    leagues.putSeason(season("on", 1, { id: "ladder-1", name: "Tabletop Night Ladder", competition: "ladder", ladder: { playOnFork: false } as never, stage: "active" }));
    const ladders = (playedOn: string) => body({ type: "leagues", format: "ladder", playedOn }).groups.leagues!.items.filter((i) => i.subtitle?.startsWith("Ladder")).map((i) => i.title).sort();
    expect(ladders("fork")).toEqual(["Online Ladder"]);
    expect(ladders("tabletop")).toEqual(["Table Ladder", "Tabletop Night Ladder"]);
    expect(body({ q: "online ladder", type: "leagues" }).groups.leagues!.items.find((i) => i.title === "Online Ladder")!.chips).toContain("Super FUMBBL");
  });
});

describe("public read", () => {
  it("GET /api/search passes the session gate anonymously; a write method does not", () => {
    expect(requireSession({ method: "GET", headers: {} } as unknown as IncomingMessage, "/api/search", "").kind).toBe("allow");
    expect(requireSession({ method: "HEAD", headers: {} } as unknown as IncomingMessage, "/api/search", "").kind).toBe("allow");
    expect(requireSession({ method: "POST", headers: {} } as unknown as IncomingMessage, "/api/search", "").kind).toBe("unauthorized");
  });
});

describe("GET never writes", () => {
  it("a search leaves every file in the state dir untouched", () => {
    addLeague("pub", { name: "Write Check" });
    leagues.putSeason(season("pub", 1, { teams: [team("Writers", "Amy")] }));
    addTournament("Write Cup", { publication: "published" });
    clubs.create({ name: "Write Club", homeRegion: "", description: "", createdBy: "Amy" });
    const snap = () => {
      const out: Record<string, string> = {};
      const walk = (d: string) => {
        for (const f of readdirSync(d)) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else out[p] = `${statSync(p).mtimeMs}:${readFileSync(p, "utf8")}`;
        }
      };
      walk(dir);
      return out;
    };
    const before = snap();
    for (const type of ["all", "leagues", "tournaments", "clubs", "coaches", "teams"]) search({ q: "write", type }, ADMIN);
    expect(snap()).toEqual(before);
  });
});

describe("region field", () => {
  it("validates a country from the list and free text; empty clears", () => {
    expect(parseCompetitionRegion({ country: "gb", text: "  Greater   Manchester " })).toEqual({ country: "GB", text: "Greater Manchester" });
    expect(parseCompetitionRegion({ country: "", text: "" })).toBeNull();
    expect(parseCompetitionRegion(null)).toBeNull();
    expect(() => parseCompetitionRegion({ country: "ZZ" })).toThrow(/country/);
    expect(() => parseCompetitionRegion({ text: "x".repeat(81) })).toThrow(/80/);
    expect(() => parseCompetitionRegion({ venue: "Hall" })).toThrow(/Unknown/);
    expect(regionLabel({ country: "US", text: "Pacific Northwest" })).toBe("Pacific Northwest, United States");
  });

  it("round-trips through league settings, the league wizard and the tournament page fields", async () => {
    const json = (v: unknown) => async () => Buffer.from(JSON.stringify(v));
    const deps = { store: leagues, now: () => NOW };
    const org = { coach: "Olga", admin: false, organizer: true };
    addLeague("reg", { name: "Region League", revision: 1 });
    const patch = await leagueApi("PATCH", "/api/leagues/reg/settings", new URLSearchParams(), org, {
      ...deps, readBody: json({ revision: leagues.league("reg")!.revision ?? 0, information: { region: { country: "DE", text: "Bayern" } } }),
    } as never);
    expect(patch!.status).toBe(200);
    expect(leagues.league("reg")!.region).toEqual({ country: "DE", text: "Bayern" });
    const view = await leagueApi("GET", "/api/leagues/reg/settings", new URLSearchParams(), org, deps as never);
    expect((view!.body as { settings: { information: { region: unknown } } }).settings.information.region).toEqual({ country: "DE", text: "Bayern" });
    expect(titles({ q: "region", region: "bayern" }, "leagues")).toEqual(["Region League"]);
    expect(body({ q: "region" }).groups.leagues!.items[0]!.subtitle).toBe("Bayern, Germany");
    const bad = await leagueApi("PATCH", "/api/leagues/reg/settings", new URLSearchParams(), org, {
      ...deps, readBody: json({ revision: leagues.league("reg")!.revision ?? 0, information: { region: { country: "XX" } } }),
    } as never);
    expect(bad!.status).toBe(400);
    const cleared = await leagueApi("PATCH", "/api/leagues/reg/settings", new URLSearchParams(), org, {
      ...deps, readBody: json({ revision: leagues.league("reg")!.revision ?? 0, information: { region: null } }),
    } as never);
    expect(cleared!.status).toBe(200);
    expect(leagues.league("reg")!.region).toBeUndefined();

    // The wizard: create with a region, then change it on the draft.
    const created = await leagueApi("POST", "/api/leagues", new URLSearchParams(), org, {
      ...deps, readBody: json({ name: "Wizard League", region: { country: "FR", text: "Bretagne" } }),
    } as never);
    expect(created!.status).toBe(201);
    const id = (created!.body as { id: string }).id;
    expect((created!.body as { draft: { identity: { region: unknown } } }).draft.identity.region).toEqual({ country: "FR", text: "Bretagne" });
    const step = await leagueApi("PATCH", `/api/leagues/${id}/draft`, new URLSearchParams(), org, {
      ...deps, readBody: json({ revision: leagues.league(id)!.revision ?? 0, identity: { region: { country: "BE", text: "Gent" } } }),
    } as never);
    expect(step!.status).toBe(200);
    expect(leagues.league(id)!.region).toEqual({ country: "BE", text: "Gent" });

    // Tournaments: the region is a page field (wizard create and Manage -> Page).
    const t = addTournament("Region Cup", { publication: "published", region: { country: "IT", text: "Toscana" } });
    expect(tournaments.tournament(t.id)!.region).toEqual({ country: "IT", text: "Toscana" });
    const read = await tournamentApi("GET", `/api/tournaments/${t.id}`, new URLSearchParams(), undefined, undefined, { store: tournaments, now: () => NOW } as never);
    expect(JSON.stringify(read!.body)).toContain("Toscana");
    tournaments.updatePage(t.id, { region: null }, NOW);
    expect(tournaments.tournament(t.id)!.region).toBeUndefined();
  });
});
