import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireSession } from "../src/auth/requireSession";
import { leagueApi, leaguePath, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { aggregateInducementUsage, effectiveMatchPicks, type InducementUsageSource, type InducementUsageView } from "../src/leagues/inducementUsage";
import { LeagueStore } from "../src/leagues/store";
import { leagueFixtureRef } from "../src/leagues/tabletopFixtures";
import type { LeagueFixture, SeasonRecord } from "../src/leagues/types";
import type { TabletopEvent } from "../src/tabletop/events";
import type { MatchRecord } from "../src/tabletop/store";

// League inducement usage (src/leagues/inducementUsage.ts): how often each inducement was taken across a season's (or
// the league's) played fixtures, from the tabletop recorder's effective picks. Fake data only.

const AT = "2026-11-01T12:00:00.000Z";
const KEG = { id: "c-0000abcd", name: "Lucky Keg", price: 25_000, cap: 2, icon: "keg", effectText: "", category: "special" as const };

const season = (n: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: AT, source: "manual", ...over,
});
const fixture = (id: string, played: boolean, opId?: string): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1, suspended: false,
  home: { team: "Orcs", coach: "Bob", race: "Orc", score: played ? 2 : null, cas: played ? 1 : null, conceded: false },
  away: { team: "Elves", coach: "Dee", race: "Wood Elf", score: played ? 1 : null, cas: played ? 0 : null, conceded: false },
  ...(opId ? { tabletop: { revision: 1, opId, reportedAt: AT } } : {}),
});
const match = (id: string, ref: string, opId: string, over: Partial<MatchRecord> = {}): MatchRecord => ({
  id, state: "published", fixtureRef: ref, home: { coach: "Bob", teamSaveId: "s1", teamName: "Orcs" }, away: { coach: "Dee", teamSaveId: "s2", teamName: "Elves" },
  postMatch: "full" as MatchRecord["postMatch"], createdBy: "Jay", createdAt: AT, updatedAt: AT, confirmations: {}, baseRevision: { home: 1, away: 1 },
  fixtureLink: { id: ref, priorStatus: "scheduled", expectedRevision: 0, reportedAt: AT, swapped: false, opId }, ...over,
});
let seq = 0;
const ind = (team: "home" | "away", picks: Array<{ id: string; qty: number; name?: string }>, over: Partial<TabletopEvent> = {}): TabletopEvent =>
  ({ id: `ev-${++seq}`, matchId: "m", type: "inducement", team, ts: AT, by: "Bob", payload: { picks, total: 0, treasury: 0, pettyCash: 0, skipped: picks.length === 0 }, ...over }) as TabletopEvent;
const undo = (target: string): TabletopEvent => ({ id: `ev-${++seq}`, matchId: "m", type: "undo", ts: AT, by: "Jay", payload: { target } }) as unknown as TabletopEvent;

describe("aggregation (pure)", () => {
  const s = season(1, { rules: { inducements: { standard: {}, custom: [KEG], revision: 1 } } });

  it("an organiser's replacement counts once (the latest in force), and an undone replacement restores the earlier picks", () => {
    const first = ind("home", [{ id: "bribes", qty: 2 }]);
    const replaced = ind("home", [{ id: "bribes", qty: 1 }, { id: "wandering_apothecaries", qty: 1 }], { admin: true } as Partial<TabletopEvent>);
    expect(effectiveMatchPicks({}, [first, replaced, ind("away", [])])).toEqual([[{ id: "bribes", qty: 1 }, { id: "wandering_apothecaries", qty: 1 }], []]);
    expect(effectiveMatchPicks({}, [first, replaced, undo(replaced.id)])).toEqual([[{ id: "bribes", qty: 2 }]]);
    // no record from either team = no data; the lobby's resolved picks fill in a team without a record
    expect(effectiveMatchPicks({}, [])).toBeUndefined();
    const lobby = { home: { picks: [{ id: "bribes", name: "Bribes", qty: 1, cost: 100_000 }], total: 100_000, treasury: 100_000, pettyCash: 0 }, away: { picks: [], total: 0, treasury: 0, pettyCash: 0 } };
    expect(effectiveMatchPicks({ inducements: lobby }, [])).toEqual([[{ id: "bribes", name: "Bribes", qty: 1 }], []]);
  });

  it("qty > 1 adds to times taken but a game counts once; custom types by name; games without data are counted apart", () => {
    const out = aggregateInducementUsage([
      { season: s, sides: [[{ id: "bribes", qty: 2 }, { id: KEG.id, qty: 2 }], [{ id: "bribes", qty: 1 }]] },
      { season: s, sides: [[{ id: "bribes", qty: 1 }], []] },
      { season: s, sides: [[], []] }, // both teams recorded "nothing": a counted game with no inducements
      { season: s }, // TourPlay / Super FUMBBL / organiser-entered: no data
      { season: s },
    ]);
    expect(out.gamesCounted).toBe(3);
    expect(out.gamesWithoutData).toBe(2);
    expect(out.rows.map((r) => [r.key, r.name, r.taken, r.games, r.share])).toEqual([
      ["bribes", "Bribes", 4, 2, 0.6667],
      ["custom:lucky keg", "Lucky Keg", 2, 1, 0.3333],
    ]);
    expect(out.rows[1]).toMatchObject({ source: "custom", iconSrc: "/icons/inducements/bloodweiser_keg.png" });
    expect(out.rows[0]).toMatchObject({ source: "standard", category: "special", iconSrc: "/icons/inducements/bribe.png" });
  });

  it("the same custom type in two seasons (different ids) adds up by name; a removed type keeps its recorded name", () => {
    const s2 = season(2, { rules: { inducements: { standard: {}, custom: [{ ...KEG, id: "c-0000beef", name: "lucky  KEG" }], revision: 0 } } });
    const out = aggregateInducementUsage([
      { season: s, sides: [[{ id: KEG.id, qty: 1 }]] },
      { season: s2, sides: [[{ id: "c-0000beef", qty: 1 }]] },
      { season: season(3), sides: [[{ id: "c-0000dead", qty: 1, name: "Old Brew" }]] },
    ]);
    expect(out.rows.map((r) => [r.key, r.taken, r.games])).toEqual([["custom:lucky keg", 2, 2], ["custom:old brew", 1, 1]]);
    expect(aggregateInducementUsage([])).toEqual({ gamesCounted: 0, gamesWithoutData: 0, rows: [] });
  });
});

describe("GET .../seasons/:seasonId/inducements/usage", () => {
  let dir: string;
  let store: LeagueStore;
  let matches: MatchRecord[];
  let events: Record<string, TabletopEvent[]>;
  let reads: number;
  const source: InducementUsageSource = { listMatches: async () => matches, readEvents: async (id) => { reads += 1; return events[id] ?? []; } };
  const deps = (): LeagueApiDeps => ({ store, now: () => new Date(AT), tabletop: source });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, query = ""): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(query), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const U = "/api/leagues/tabbl/seasons/season-2/inducements/usage";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-ind-usage-"));
    store = new LeagueStore(dir);
    reads = 0;
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(season(1, { status: "completed", fixtures: [fixture("f1", true, "op-1")] }));
    store.putSeason(season(2, {
      rules: { inducements: { standard: {}, custom: [KEG], revision: 1 } },
      fixtures: [fixture("f1", true, "op-2a"), fixture("f2", true, "op-2b"), fixture("f3", true), fixture("f4", false), fixture("f5", true, "op-2e")],
    }));
    const r = (s: number, f: string) => leagueFixtureRef("tabbl", `season-${s}`, f);
    matches = [
      match("m1", r(1, "f1"), "op-1"),
      match("m2a", r(2, "f1"), "op-2a"),
      match("m2b", r(2, "f2"), "op-2b"),
      match("m2b-old", r(2, "f2"), "op-old"), // an earlier, undone publish of the same fixture: not the result in force
      match("m2e", r(2, "f5"), "op-2e"), // pre-game skipped: no inducement record from either team
      match("m2c", r(2, "f4"), "op-x", { state: "recording" }),
    ];
    const first = ind("home", [{ id: "bribes", qty: 3 }]);
    events = {
      m1: [ind("home", [{ id: "bribes", qty: 1 }])],
      m2a: [first, ind("away", [{ id: KEG.id, qty: 2, name: "Lucky Keg" }]), ind("home", [{ id: "bribes", qty: 1 }], { admin: true } as Partial<TabletopEvent>)],
      m2b: [ind("home", [{ id: "bribes", qty: 1 }]), ind("away", [])],
      "m2b-old": [ind("home", [{ id: "wizard", qty: 9 }])],
      m2e: [],
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("counts the season's played fixtures: effective picks, replaced picks once, games without data apart", async () => {
    const res = await call("GET", U);
    expect(res.status).toBe(200);
    expect(res.headers?.["cache-control"]).toBe("no-store");
    const v = res.body as InducementUsageView;
    expect(v).toMatchObject({ leagueId: "tabbl", seasonId: "season-2", scope: "season", gamesCounted: 2, gamesWithoutData: 2, canEdit: false });
    expect(v.rows.map((r) => [r.name, r.taken, r.games, r.share])).toEqual([["Bribes", 2, 2, 1], ["Lucky Keg", 2, 1, 0.5]]);
    expect(((await call("GET", U, { coach: "Jay" })).body as InducementUsageView).canEdit).toBe(true);
    expect(((await call("GET", U, { coach: "Bob" })).body as InducementUsageView).canEdit).toBe(false);
  });

  it("scope=league adds every season; a bad scope is 400; GET only reads (no write, no event appended)", async () => {
    const before = JSON.stringify(store.seasons("tabbl"));
    const v = (await call("GET", U, undefined, "scope=league")).body as InducementUsageView;
    expect(v).toMatchObject({ scope: "league", gamesCounted: 3, gamesWithoutData: 2 });
    expect(v.rows.find((r) => r.key === "bribes")).toMatchObject({ taken: 3, games: 3, share: 1 });
    expect((await call("GET", U, undefined, "scope=everything")).status).toBe(400);
    expect(JSON.stringify(store.seasons("tabbl"))).toBe(before);
    // published matches are cached: a second read does not re-read their events
    const n = reads;
    await call("GET", U, undefined, "scope=league");
    expect(reads).toBe(n);
  });

  it("no recorder wired: every played game is a game without data; 404s and 405", async () => {
    const r = await leagueApi("GET", U, new URLSearchParams(), undefined, { store, now: () => new Date(AT) });
    expect(r?.body).toMatchObject({ gamesCounted: 0, gamesWithoutData: 4, rows: [] });
    expect((await call("GET", "/api/leagues/tabbl/seasons/nope/inducements/usage")).status).toBe(404);
    expect((await call("POST", U, { coach: "Jay" })).status).toBe(405);
  });

  it("a draft league answers a non-organiser exactly like an unknown league (status and body); its organiser reads it", async () => {
    store.upsertLeague({ id: "lakeside", name: "Lakeside", fullName: "", slug: "lakeside", organisers: ["Jay"], owner: "Jay", visibility: "draft" });
    store.putSeason(season(2, { leagueId: "lakeside", fixtures: [fixture("f1", true)] }));
    const draft = (who?: { coach: string }) => call("GET", "/api/leagues/lakeside/seasons/season-2/inducements/usage", who);
    const unknown = (who?: { coach: string }) => call("GET", "/api/leagues/nowhere/seasons/season-2/inducements/usage", who);
    for (const who of [undefined, { coach: "Bob" }]) {
      const [d, u] = [await draft(who), await unknown(who)];
      expect(d.status).toBe(404);
      expect({ status: d.status, body: d.body, headers: d.headers }).toEqual({ status: u.status, body: u.body, headers: u.headers });
    }
    const org = await draft({ coach: "Jay" });
    expect(org.status).toBe(200);
    expect(org.body).toMatchObject({ gamesWithoutData: 1, canEdit: true });
  });

  it("anonymous reads pass the session gate (requireSession) and the sidecar-off gate's league path; writes do not", () => {
    const req = (method: string) => ({ method, headers: {} }) as unknown as IncomingMessage;
    expect(requireSession(req("GET"), U, "?scope=league")).toEqual({ kind: "allow" });
    expect(requireSession(req("HEAD"), U, "").kind).toBe("allow");
    expect(requireSession(req("POST"), U, "").kind).toBe("unauthorized");
    expect(leaguePath(U)).toEqual({ id: "tabbl", rest: ["seasons", "season-2", "inducements", "usage"] }); // authorized() admits leaguePath
  });
});
