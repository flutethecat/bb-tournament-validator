import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, leaguePath, type LeagueApiDeps } from "../src/leagues/api";
import { leagueBrowseInfo, leagueBrowseStatus } from "../src/leagues/browse";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueRecord, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { requireSession } from "../src/auth/requireSession";
import { DEMO_LEAGUES, isLiveStateDir, main, MARKER_FILE, removeDemoLeagues, seedDemoLeagues } from "../scripts/seed-demo-leagues";

// Browse leagues (owner 11-02): the list rows' public search index (src/leagues/browse.ts), drafts never listed, the
// public gates, and the demo seed script against a temp state dir.

const NOW = new Date("2026-11-02T12:00:00.000Z");

const team = (name: string, coach: string, extra: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, race: "Orc", coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0,
  cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [], ...extra,
});

const season = (leagueId: string, number: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${number}`, leagueId, number, name: `Season ${number}`, sourceSlug: `${leagueId}-s${number}`, ruleset: "BB2025", status: "active",
  phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: NOW.toISOString(), source: "manual", ...over,
});

let dir: string;
let store: LeagueStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "league-browse-"));
  store = new LeagueStore(dir, { identitiesFile: join(dir, "identities.json") });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const deps = (): LeagueApiDeps => ({ store, now: () => NOW });
type Row = { id: string; name: string; visibility?: string; browse: ReturnType<typeof leagueBrowseInfo> };
async function list(auth?: { coach: string; admin: boolean }) {
  const res = await leagueApi("GET", "/api/leagues", new URLSearchParams(), auth, deps());
  return res!;
}
const rows = async (auth?: { coach: string; admin: boolean }) => ((await list(auth)).body as { leagues: Row[] }).leagues;

function addLeague(id: string, over: Partial<LeagueRecord> = {}): void {
  store.upsertLeague({ id, name: id.toUpperCase(), fullName: `${id} full name`, slug: id, description: "", organisers: ["org-a"], ...over }, NOW);
}

describe("browse status and the search index", () => {
  it("status follows the newest season's stage: in progress, registration, finished, off-season (setup or none)", () => {
    expect(leagueBrowseStatus([])).toBe("off-season");
    expect(leagueBrowseStatus([season("x", 1)])).toBe("in-progress");
    expect(leagueBrowseStatus([season("x", 1, { stage: "registration" })])).toBe("registration");
    expect(leagueBrowseStatus([season("x", 1, { stage: "setup" })])).toBe("off-season");
    expect(leagueBrowseStatus([season("x", 2, { status: "completed" }), season("x", 1)])).toBe("finished");
    expect(leagueBrowseStatus([season("x", 1, { status: "completed" }), season("x", 2, { stage: "registration" })])).toBe("registration");
  });

  it("list rows carry status, registration open, town + state, regions, season names, team names and coach display names", async () => {
    addLeague("alpha", {
      description: "Games at the Example Hall.", regions: ["North", " ", "South"], test: true, registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null },
      address: { country: "US", region: "WA", locality: "Port Example", postcode: "98999", street: "1 Secret Street" },
    });
    store.putSeason(season("alpha", 1, { status: "completed", teams: [team("Grudge Rollers", "Pat Example")] }));
    store.putSeason(season("alpha", 2, { stage: "registration", participants: [{ coach: "Sam Sample", team: "Mud Moles", race: "Dwarf", country: "US", active: true }] }));
    addLeague("beta");
    const [a, b] = await rows();
    expect(a!.browse).toEqual({
      status: "registration", registrationOpen: true, location: "Port Example, WA", regions: ["North", "South"], test: true,
      seasons: ["Season 2", "Season 1"], teams: [{ name: "Mud Moles", coach: "Sam Sample" }, { name: "Grudge Rollers", coach: "Pat Example" }],
    });
    expect(b!.browse).toEqual({ status: "off-season", registrationOpen: false, regions: [], seasons: [], teams: [] });
  });

  it("registration is open only while joining is possible: not once play started, not when the organisers turned it off", async () => {
    const regs = (allow: boolean) => ({ allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: allow, maxRegistrations: null, maxPerRace: null });
    addLeague("open", { registrations: regs(true) });
    store.putSeason(season("open", 1, { stage: "registration" }));
    addLeague("off", { registrations: regs(false) });
    store.putSeason(season("off", 1, { stage: "registration" }));
    addLeague("playing", { registrations: regs(true) });
    store.putSeason(season("playing", 1));
    const byId = Object.fromEntries((await rows()).map((r) => [r.id, r.browse.registrationOpen]));
    expect(byId).toEqual({ open: true, off: false, playing: false });
  });

  it("the list payload carries no private field: no email, phone, Discord id, NAF name, coach account, street, postcode or payment link", async () => {
    addLeague("priv", {
      address: { country: "US", region: "OR", locality: "Example Town", postcode: "97999", street: "77 Hidden Lane" },
      registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: null, payPal: "https://paypal.example.com/secret-pay" },
    });
    store.setSecrets("priv", { discordWebhookUrl: "https://discord.example.com/api/webhooks/123/secret-hook" });
    store.putSeason(season("priv", 1, {
      teams: [team("Rusty Ravens", "Lee Fixture", { coachId: "acct-hidden-1", nafUser: "naf-hidden-1" })],
      participants: [{ coach: "Lee Fixture", coachId: "acct-hidden-1", nafUser: "naf-hidden-1", country: "US", race: "Orc", team: "Rusty Ravens", active: true, paid: true }],
    }));
    const json = JSON.stringify((await list()).body);
    for (const secret of ["acct-hidden-1", "naf-hidden-1", "77 Hidden Lane", "97999", "secret-pay", "secret-hook", "@", "555", "discordId", "email", "phone", "paid"]) {
      expect(json, secret).not.toContain(secret);
    }
    expect(json).toContain("Rusty Ravens");
    expect(json).toContain("Lee Fixture");
  });
});

describe("drafts never listed", () => {
  it("anonymous viewers and other coaches get exactly the list they would get if the draft did not exist", async () => {
    addLeague("public-one");
    store.putSeason(season("public-one", 1, { teams: [team("Iron Owls", "Max Stub")] }));
    const anonBefore = await list();
    const coachBefore = await list({ coach: "someone", admin: false });
    addLeague("secret-draft", { visibility: "draft", organisers: ["org-draft"], description: "Iron Owls rematch" });
    store.putSeason(season("secret-draft", 1, { teams: [team("Draft Team", "Draft Coach")] }));
    expect(await list()).toEqual(anonBefore);
    expect(await list({ coach: "someone", admin: false })).toEqual(coachBefore);
    expect(JSON.stringify((await list()).body)).not.toContain("Draft Team");
    // its organisers still see it in their own (never cached) list, marked as a draft
    const own = await list({ coach: "org-draft", admin: false });
    expect(own.headers?.["cache-control"]).toBe("private, no-store");
    expect((own.body as { leagues: Row[] }).leagues.find((l) => l.id === "secret-draft")?.visibility).toBe("draft");
  });

  it("the list stays a public read on both gates (session gate and the sidecar-off authorized() path)", () => {
    const req = { method: "GET", headers: {} } as unknown as IncomingMessage;
    expect(requireSession(req, "/api/leagues", "").kind).not.toBe("unauthorized");
    expect(leaguePath("/api/leagues")).toEqual({ rest: [] }); // authorized() lets every leaguePath through
  });
});

describe("seed-demo-leagues script", () => {
  it("creates 12 varied demo leagues through the store, every one test: true and named Demo, with a marker", async () => {
    const ids = await seedDemoLeagues({ stateDir: dir, now: NOW });
    expect(ids).toHaveLength(12);
    expect(DEMO_LEAGUES).toHaveLength(12);
    const listed = await rows();
    expect(listed).toHaveLength(12);
    for (const l of listed) {
      expect(l.name.startsWith("Demo ")).toBe(true);
      expect(l.browse.test).toBe(true);
      expect(store.league(l.id)?.test).toBe(true);
    }
    expect(new Set(listed.map((l) => l.browse.status))).toEqual(new Set(["in-progress", "registration", "finished", "off-season"]));
    expect(listed.filter((l) => l.browse.registrationOpen).length).toBeGreaterThan(0);
    const summaries = (await list()).body as { leagues: Array<{ bannerUrl?: string; logoUrl?: string; playOnFork: boolean; currentSeason?: { ruleset: string; teamCount: number } }> };
    expect(summaries.leagues.some((l) => l.bannerUrl) && summaries.leagues.some((l) => !l.bannerUrl)).toBe(true);
    expect(summaries.leagues.some((l) => l.playOnFork) && summaries.leagues.some((l) => !l.playOnFork)).toBe(true);
    expect(new Set(summaries.leagues.map((l) => l.currentSeason?.ruleset).filter(Boolean))).toEqual(new Set(["BB2020", "BB2025"]));
    expect(new Set(summaries.leagues.map((l) => l.currentSeason?.teamCount ?? 0)).size).toBeGreaterThan(5);
    const marker = JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8"));
    expect(marker.ids).toEqual(ids);
    // a second run refreshes the same leagues
    expect(await seedDemoLeagues({ stateDir: dir, now: NOW })).toEqual(ids);
    expect(await rows()).toHaveLength(12);
  });

  it("--remove deletes only its own records: other leagues and test leagues it did not create stay", async () => {
    addLeague("real-league");
    addLeague("demo-handmade", { name: "Demo Handmade", test: true });
    await seedDemoLeagues({ stateDir: dir, now: NOW });
    const removed = removeDemoLeagues({ stateDir: dir, now: NOW });
    expect(removed).toHaveLength(12);
    store.invalidate();
    expect(store.list().map((l) => l.id).sort()).toEqual(["demo-handmade", "real-league"]);
    expect(existsSync(join(dir, MARKER_FILE))).toBe(false);
  });

  it("never overwrites an existing league with a demo id that is not its own", async () => {
    addLeague("demo-harbour-league", { name: "Someone's League" });
    const lines: string[] = [];
    await seedDemoLeagues({ stateDir: dir, now: NOW, log: (s) => lines.push(s) });
    expect(store.league("demo-harbour-league")?.name).toBe("Someone's League");
    expect(lines.some((l) => l.startsWith("demo-harbour-league: skipped"))).toBe(true);
    removeDemoLeagues({ stateDir: dir });
    expect(store.league("demo-harbour-league")?.name).toBe("Someone's League");
  });

  it("refuses the live data dir without --live --yes, and needs a target", async () => {
    const out: string[] = [];
    const io = { log: (s: string) => void out.push(s), error: (s: string) => void out.push(s) };
    const liveLike = join(dir, "data-store");
    mkdirSync(liveLike);
    expect(isLiveStateDir(liveLike, {})).toBe(true);
    expect(isLiveStateDir(dir, { FORK_STATE_DIR: dir })).toBe(true);
    expect(isLiveStateDir(dir, {})).toBe(false);
    expect(await main([liveLike], io, {})).toBe(3);
    expect(out.at(-1)).toContain("Refusing without --live --yes");
    expect(await main([liveLike, "--live"], io, {})).toBe(3);
    expect(await main([dir], io, { FORK_STATE_DIR: dir })).toBe(3);
    expect(await main([liveLike, "--remove"], io, {})).toBe(3);
    expect(new LeagueStore(liveLike).list()).toEqual([]);
    expect(await main([], io, {})).toBe(2);
    expect(await main([liveLike, "--live", "--yes"], io, {})).toBe(0);
    expect(new LeagueStore(liveLike).list()).toHaveLength(12);
    expect(await main([liveLike, "--remove", "--live", "--yes"], io, {})).toBe(0);
    expect(new LeagueStore(liveLike).list()).toHaveLength(0);
  });
});
