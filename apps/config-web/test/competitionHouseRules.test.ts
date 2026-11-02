// Creation wizards v2 (lane 1): house rules (defaults "as the ruleset says", league-only / tournament-only fields, the
// Progression tickboxes), the round trip wizard -> draft -> publish -> settings edit for tournaments and leagues, Played on
// in General, the ruleset card, the old primaryTiebreaker still working, regions / avoidance on a tournament, the
// authorised flag default (new and old records), and the package overlay the Roster Builder validator uses.
// Each test has its own state dir (laws §C14).
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedHouseRulesRows, defaultHouseRules, houseRulesOf, houseRulesRows, parseHouseRules,
} from "../src/competition/houseRules.js";
import { applyHouseRulesToPackage } from "../src/competition/packageOverlay.js";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api.js";
import { LeagueStore } from "../src/leagues/store.js";
import { tournamentApi, type TournamentApiIdentity } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };

describe("house rules model", () => {
  it("defaults every setting to the ruleset, per kind", () => {
    expect(defaultHouseRules("league")).toEqual({ prayers: { mode: "ruleset" }, brawlingBrutes: "ruleset", maxStatIncreasesTeam: null, maxStatIncreasesPlayer: null, mvp: "ruleset", hireFire: "ruleset" });
    expect(defaultHouseRules("tournament")).toEqual({
      prayers: { mode: "ruleset" }, brawlingBrutes: "ruleset", maxStatIncreasesTeam: null, maxStatIncreasesPlayer: null,
      progression: { enabled: false, spp: true, injuries: true, treasury: true },
    });
    expect(houseRulesOf({}, "league")).toEqual(defaultHouseRules("league"));
    expect(changedHouseRulesRows(defaultHouseRules("tournament"), "tournament")).toEqual([]);
  });
  it("keeps league-only and tournament-only settings apart", () => {
    expect(() => parseHouseRules({ progression: { enabled: true } }, "league")).toThrow(/tournament setting/);
    expect(() => parseHouseRules({ mvp: "pick3" }, "tournament")).toThrow(/league settings/);
    expect(() => parseHouseRules({ hireFire: "enforced" }, "tournament")).toThrow(/league settings/);
    expect(parseHouseRules({ mvp: "random", hireFire: "notEnforced" }, "league")).toMatchObject({ mvp: "random", hireFire: "notEnforced" });
    expect(houseRulesRows(defaultHouseRules("league"), "league").map((r) => r.k)).toEqual(["Prayers to Nuffle", "Brawling Brutes", "Stat increases per team", "Stat increases per player", "MVP", "Hire/fire"]);
    expect(houseRulesRows(defaultHouseRules("tournament"), "tournament").map((r) => r.k)).toContain("Progression");
  });
  it("Prayers to Nuffle: a cost change needs a cost; banned and as-ruleset carry none", () => {
    expect(parseHouseRules({ prayers: { mode: "cost", costK: 50 } }, "league").prayers).toEqual({ mode: "cost", costK: 50 });
    expect(() => parseHouseRules({ prayers: { mode: "cost" } }, "league")).toThrow(/cost/);
    expect(parseHouseRules({ prayers: { mode: "banned", costK: 5 } }, "league").prayers).toEqual({ mode: "banned" });
    expect(() => parseHouseRules({ maxStatIncreasesPlayer: 11 }, "league")).toThrow(/0 to 10/);
    expect(parseHouseRules({ maxStatIncreasesTeam: "" }, "league").maxStatIncreasesTeam).toBeNull();
  });
  it("progression: the three carry-over tickboxes are stored and shown", () => {
    const on = parseHouseRules({ progression: { enabled: true, spp: true, injuries: false, treasury: true } }, "tournament");
    expect(on.progression).toEqual({ enabled: true, spp: true, injuries: false, treasury: true });
    expect(houseRulesRows(on, "tournament").find((r) => r.k === "Progression")!.v).toBe("On: SPP and advancements, Treasury and winnings");
    expect(houseRulesRows(defaultHouseRules("tournament"), "tournament").find((r) => r.k === "Progression")!.v).toBe("Off (resurrection)");
    expect(() => parseHouseRules({ progression: { spp: "yes" } }, "tournament")).toThrow(/true or false/);
  });
  it("the package overlay enforces PtN banned and the stat caps on a copy, never the shared package", () => {
    const pkg = { name: "P", inducements: { allowed: ["*"], caps: {} }, statIncreases: { allowed: ["MA"], maxPerPlayer: 2 }, special: { statIncreasesAllowed: true }, tiers: [{ tier: 1, statIncreases: { maxPerPlayer: 3 } }] };
    const rules = parseHouseRules({ prayers: { mode: "banned" }, maxStatIncreasesPlayer: 1, maxStatIncreasesTeam: 4 }, "tournament");
    const out = applyHouseRulesToPackage(pkg, rules) as typeof pkg & { special: { statIncreaseRules: { maxPerTeam: number } } };
    expect(out.inducements.caps).toEqual({ prayers_to_nuffle: 0 });
    expect(out.statIncreases.maxPerPlayer).toBe(1);
    expect(out.tiers[0]!.statIncreases.maxPerPlayer).toBe(1);
    expect(out.special.statIncreaseRules.maxPerTeam).toBe(4);
    expect(pkg.inducements.caps).toEqual({});
    expect(pkg.statIncreases.maxPerPlayer).toBe(2);
    // A cost change, Brawling Brutes and defaults change nothing (display-only).
    expect(applyHouseRulesToPackage(pkg, parseHouseRules({ prayers: { mode: "cost", costK: 80 }, brawlingBrutes: "off" }, "tournament"))).toEqual(pkg);
    // A cap never loosens the package.
    expect((applyHouseRulesToPackage(pkg, parseHouseRules({ maxStatIncreasesPlayer: 5 }, "tournament")) as typeof pkg).statIncreases.maxPerPlayer).toBe(2);
  });
});

// ---- tournaments ----
const owner: TournamentApiIdentity = { coach: "Veers", organizer: true, admin: false };
async function tcall(store: TournamentStore, method: string, path: string, auth?: TournamentApiIdentity, body?: unknown) {
  return tournamentApi(method, path, new URLSearchParams(), auth, body, {
    store, teamBuild: () => undefined, teamOwner: () => undefined, packageExists: (n) => n === "BB2025 Default", registeredCoach: (n) => n,
    now: () => new Date("2026-11-02T12:00:00.000Z"),
  });
}

describe("tournament: wizard -> draft -> publish -> Manage edit", () => {
  it("round-trips house rules, format, avoidance, regions and played-on", async () => {
    const store = new TournamentStore(tmp("bbtv-hr-t-"));
    const created = await tcall(store, "POST", "/api/tournaments", owner, {
      name: "Grill Cup", packageName: "BB2025 Default", maxPlayers: 8, format: "swiss", primaryTiebreaker: "buchholz", publish: false, playOnFork: true,
      tiebreakers: ["headToHead", "touchdownDifferential", "casualtyDifferential"], points: { win: 2000, draw: 1000, loss: 0 },
      houseRules: { prayers: { mode: "banned" }, progression: { enabled: true, treasury: false } }, pairingAvoid: "both", regions: ["North", "South"],
    });
    expect(created?.status, JSON.stringify(created?.body)).toBe(201);
    const id = (created!.body as { tournament: { id: string } }).tournament.id;
    const read = async () => ((await tcall(store, "GET", `/api/tournaments/${id}`, owner))!.body as { tournament: any }).tournament;
    let t = await read();
    expect(t).toMatchObject({
      unpublished: true, playOnFork: true, authorised: true, tiebreakerChain: ["headToHead", "touchdownDifferential", "casualtyDifferential"],
      points: { win: 2000, draw: 1000, loss: 0, bye: 2000 }, pairingAvoid: "both", regions: ["North", "South"],
      houseRules: { prayers: { mode: "banned" }, progression: { enabled: true, spp: true, injuries: true, treasury: false } },
    });
    expect((await tcall(store, "POST", `/api/tournaments/${id}/publish`, owner, {}))?.status).toBe(200);
    const patched = await tcall(store, "PATCH", `/api/tournaments/${id}`, owner, { houseRules: { brawlingBrutes: "off" }, tiebreakers: ["sonnebornBerger"], pairingAvoid: "none", playOnFork: false });
    expect(patched?.status, JSON.stringify(patched?.body)).toBe(200);
    t = await read();
    // Merged over the stored house rules: the ban and the progression survive the edit.
    expect(t.houseRules).toMatchObject({ prayers: { mode: "banned" }, brawlingBrutes: "off", progression: { enabled: true, treasury: false } });
    expect(t.tiebreakerChain).toEqual(["sonnebornBerger"]);
    expect(t.pairingAvoid).toBe("none");
    expect(t.playOnFork).toBeFalsy();
    expect(t.unpublished).toBeUndefined();
  });
  it("refuses bad values with a 400 and writes nothing", async () => {
    const store = new TournamentStore(tmp("bbtv-hr-t-"));
    for (const extra of [{ houseRules: { mvp: "pick3" } }, { tiebreakers: ["buchholz", "buchholz"] }, { points: { win: 1, draw: 2, loss: 0 } }, { pairingAvoid: "city" }]) {
      const res = await tcall(store, "POST", "/api/tournaments", owner, { name: "Bad", packageName: "BB2025 Default", maxPlayers: 8, format: "swiss", publish: false, ...extra });
      expect(res?.status, JSON.stringify(extra)).toBe(400);
    }
    expect(store.tournaments(["draft"])).toHaveLength(0);
  });
  it("keeps the old primaryTiebreaker working: it becomes chain[0]", async () => {
    const store = new TournamentStore(tmp("bbtv-hr-t-"));
    const res = await tcall(store, "POST", "/api/tournaments", owner, { name: "Old", packageName: "BB2025 Default", maxPlayers: 8, format: "swiss", primaryTiebreaker: "sonnebornBerger" });
    const id = (res!.body as { tournament: { id: string } }).tournament.id;
    let t = ((await tcall(store, "GET", `/api/tournaments/${id}`, owner))!.body as { tournament: any }).tournament;
    expect(t.tiebreakerChain).toEqual(["sonnebornBerger", "touchdownDifferential", "casualtyDifferential"]);
    await tcall(store, "PATCH", `/api/tournaments/${id}`, owner, { primaryTiebreaker: "buchholz" });
    t = ((await tcall(store, "GET", `/api/tournaments/${id}`, owner))!.body as { tournament: any }).tournament;
    expect(t.tiebreakerChain[0]).toBe("buchholz");
    // New records store the flag.
    expect(store.tournament(id)!.authorised).toBe(true);
  });
  it("derives authorised (true) and default house rules for a record written before they existed", async () => {
    const dir = tmp("bbtv-hr-t-");
    const store = new TournamentStore(dir);
    const res = await tcall(store, "POST", "/api/tournaments", owner, { name: "Legacy", packageName: "BB2025 Default", maxPlayers: 8, format: "swiss" });
    const id = (res!.body as { tournament: { id: string } }).tournament.id;
    const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
    const data = JSON.parse(readFileSync(join(dir, file), "utf8"));
    delete data.tournaments[id].authorised;
    writeFileSync(join(dir, file), JSON.stringify(data));
    const fresh = new TournamentStore(dir);
    expect(fresh.tournament(id)!.authorised).toBeUndefined();
    const t = ((await tcall(fresh, "GET", `/api/tournaments/${id}`, owner))!.body as { tournament: any }).tournament;
    expect(t.authorised).toBe(true);
    expect(t.houseRules).toEqual(defaultHouseRules("tournament"));
    expect(t.pairingAvoid).toBe("none");
  });
});

// ---- leagues ----
const OLGA: LeagueApiIdentity = { coach: "Olga", admin: false, organizer: true };
let lstore: LeagueStore;
let lbody: unknown;
const ldeps = (): LeagueApiDeps => ({
  store: lstore, readBody: async () => (lbody === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(lbody))),
  now: () => new Date("2026-11-02T12:00:00.000Z"), identities: () => [{ coach: "Olga", level: "organizer" }],
  packageExists: (n) => ["EuroBowl 2026", "BB2025 Default"].includes(n),
});
async function lcall(method: string, path: string, auth?: LeagueApiIdentity, b?: unknown): Promise<LeagueApiResult> {
  lbody = b;
  const r = await leagueApi(method, path, new URLSearchParams(), auth, ldeps());
  if (!r) throw new Error(`no route ${path}`);
  return r;
}

describe("league: wizard -> draft -> publish -> settings edit", () => {
  it("round-trips house rules, the ruleset card, regions and Played on (General)", async () => {
    lstore = new LeagueStore(tmp("bbtv-hr-l-"));
    const made = await lcall("POST", "/api/leagues", OLGA, { name: "Grill League", playOnFork: true });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = (made.body as { id: string }).id;
    expect((made.body as { draft: any }).draft.identity.playOnFork).toBe(true);
    const rev = () => lstore.league(id)!.revision ?? 0;
    const bad = await lcall("PATCH", `/api/leagues/${id}/draft`, OLGA, { revision: rev(), rules: { rulesetPackage: "Not A Package" } });
    expect(bad.status).toBe(400);
    const tourney = await lcall("PATCH", `/api/leagues/${id}/draft`, OLGA, { revision: rev(), rules: { houseRules: { progression: { enabled: true } } } });
    expect(tourney.status).toBe(400);
    const saved = await lcall("PATCH", `/api/leagues/${id}/draft`, OLGA, {
      revision: rev(), step: 3,
      rules: { ruleset: "BB2025", rulesetPackage: "EuroBowl 2026", houseRules: { mvp: "pick3", hireFire: "enforced", prayers: { mode: "cost", costK: 60 } } },
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const s2 = await lcall("PATCH", `/api/leagues/${id}/draft`, OLGA, { revision: rev(), season: { regions: ["East", "West"] }, identity: { name: "Grill League", playOnFork: false } });
    expect(s2.status, JSON.stringify(s2.body)).toBe(200);
    const draft = (s2.body as { draft: any }).draft;
    expect(draft.rules).toMatchObject({ rulesetPackage: "EuroBowl 2026", houseRules: { mvp: "pick3", hireFire: "enforced", prayers: { mode: "cost", costK: 60 } } });
    expect(draft.season.regions).toEqual(["East", "West"]);
    expect(draft.identity.playOnFork).toBe(false);
    expect((await lcall("POST", `/api/leagues/${id}/publish`, OLGA, {})).status).toBe(200);
    const edit = await lcall("PATCH", `/api/leagues/${id}/settings`, OLGA, {
      revision: rev(), information: { playOnFork: true }, houseRules: { brawlingBrutes: "on" }, regions: ["East"],
    });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    const settings = (edit.body as { settings: any }).settings;
    expect(settings.information).toMatchObject({ playOnFork: true, rulesetPackage: "EuroBowl 2026" });
    expect(settings.houseRules).toMatchObject({ mvp: "pick3", brawlingBrutes: "on", prayers: { mode: "cost", costK: 60 } });
    expect(settings.competitionRegions).toEqual(["East"]);
    expect(settings.authorised).toBe(true);
    const pub = (await lcall("GET", `/api/leagues/${id}`)).body as { league: any };
    expect(pub.league).toMatchObject({ playOnFork: true, rulesetPackage: "EuroBowl 2026", authorised: true, houseRules: { brawlingBrutes: "on" } });
  });
  it("an old league without the new fields reads defaults and authorised", async () => {
    lstore = new LeagueStore(tmp("bbtv-hr-l-"));
    lstore.upsertLeague({ id: "old", name: "Old", fullName: "", slug: "old", organisers: ["Olga"] } as never);
    const pub = (await lcall("GET", "/api/leagues/old")).body as { league: any };
    expect(pub.league.authorised).toBe(true);
    expect(pub.league.houseRules).toEqual(defaultHouseRules("league"));
  });
});

describe("CSRF and read-only GETs on the creation wizards v2 routes", () => {
  it("every new write rides a CSRF-guarded method; the reads are not state-changing", async () => {
    const { isStateChangingApiRequest } = await import("../src/auth/csrf.js");
    for (const [m, p] of [["POST", "/api/tournaments"], ["PATCH", "/api/tournaments/t1"], ["POST", "/api/tournaments/t1/publish"], ["POST", "/api/leagues"], ["PATCH", "/api/leagues/l1/draft"], ["PATCH", "/api/leagues/l1/settings"], ["POST", "/api/leagues/l1/publish"]] as const)
      expect(isStateChangingApiRequest(m, p), `${m} ${p}`).toBe(true);
    for (const p of ["/api/tournaments/t1", "/api/leagues/l1", "/api/leagues/l1/draft", "/api/leagues/l1/settings", "/api/packages"])
      expect(isStateChangingApiRequest("GET", p), p).toBe(false);
  });
  it("GET reads never write: the tournament and league records are unchanged after them", async () => {
    const dir = tmp("bbtv-hr-get-");
    const store = new TournamentStore(dir);
    const res = await tcall(store, "POST", "/api/tournaments", owner, { name: "Read Cup", packageName: "BB2025 Default", maxPlayers: 8, format: "swiss", publish: false, houseRules: { brawlingBrutes: "off" } });
    const id = (res!.body as { tournament: { id: string } }).tournament.id;
    // The tournament records (settings, house rules) never change on a read. (The detail read refreshes the derived
    // standings cache, which predates this lane and holds no settings.)
    const snap = () => readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.stringify(JSON.parse(readFileSync(join(dir, f), "utf8")).tournaments)).join("\n");
    const before = snap();
    await tcall(store, "GET", `/api/tournaments/${id}`, owner);
    await tcall(store, "GET", "/api/tournaments", owner);
    expect(snap()).toBe(before);
    const ldir = tmp("bbtv-hr-lget-");
    lstore = new LeagueStore(ldir);
    const made = await lcall("POST", "/api/leagues", OLGA, { name: "Read League" });
    const lid = (made.body as { id: string }).id;
    const lsnap = () => JSON.stringify(lstore.league(lid)) + JSON.stringify(lstore.seasons(lid));
    const lbefore = lsnap();
    await lcall("GET", `/api/leagues/${lid}/draft`, OLGA);
    await lcall("GET", `/api/leagues/${lid}/settings`, OLGA);
    await lcall("GET", `/api/leagues/${lid}`, OLGA);
    expect(lsnap()).toBe(lbefore);
  });
});
