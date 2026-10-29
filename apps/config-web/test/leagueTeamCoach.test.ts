import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { fixtureForkView } from "../src/leagues/forkPlay";
import { buildCoachAliases } from "../src/leagues/identity";
import { applyDraftTeam, coachOwnsTeam, leagueAliases } from "../src/leagues/redraft";
import { leagueStats } from "../src/leagues/stats";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";

// Assign coach account (src/leagues/teamCoach.ts, PATCH /api/leagues/:id/seasons/:seasonId/teams/:teamId) and the
// alias-table precedence of an assigned account (identity.ts).

const team = (id: string, name: string, coach: string, over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id, name, race: "Orc", coach, teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [], ...over,
});
const fx = (id: string, score: [number, number] | null): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Dee Display", nafUser: "deenaf", race: "Orc", score: score?.[0] ?? null, cas: score ? 0 : null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: score?.[1] ?? null, cas: score ? 0 : null, conceded: false },
  suspended: false,
});
const season = (number: number, status: "active" | "completed", fixtures: LeagueFixture[]): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures,
  teams: [team("orcs", "Orcs", "Dee Display", { nafUser: "deenaf" }), team("elves", "Elves", "Bob", { coachId: "Bob", race: "Wood Elf" })],
  participants: [{ coach: "Dee Display", coachId: "DeeAccount", nafUser: "deenaf", country: "US", race: "Orc", team: "Orcs", active: true }],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
});

describe("assign coach account", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  const IDENTITIES = [
    { coach: "Jay", level: "organizer" }, { coach: "ForkTester", level: "player" }, { coach: "Bob", level: "player" },
    { coach: "Root", level: "admin" }, { coach: "Gone", level: "player", banned: true },
  ];
  const deps = (): LeagueApiDeps => ({
    store, identities: () => IDENTITIES, now: () => new Date("2026-10-30T18:00:00Z"),
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  });
  const JAY = { coach: "Jay", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const path = (s = "season-6", t = "orcs") => `/api/leagues/tabbl/seasons/${s}/teams/${t}`;
  const rev = (s = "season-6") => store.season("tabbl", s)!.revision ?? 0;
  const call = async (method: string, p: string, auth: { coach: string; admin: boolean } | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-team-coach-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(season(5, "completed", [fx("g1", [2, 1])]));
    store.putSeason(season(6, "active", [fx("f1", [1, 1]), fx("f2", null)]));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("gating: anonymous 401, a coach (even the team's) 403, organiser and admin 200; revision 428 / 409 / 400", async () => {
    expect((await call("PATCH", path(), undefined, { revision: rev(), coachId: "ForkTester" })).status).toBe(401);
    expect((await call("PATCH", path(), { coach: "DeeAccount", admin: false }, { revision: rev(), coachId: "ForkTester" })).status).toBe(403);
    expect((await call("PATCH", path(), { coach: "Bob", admin: false }, { revision: rev(), coachId: "Bob" })).status).toBe(403);
    expect((await call("PATCH", path(), JAY, { coachId: "ForkTester" })).status).toBe(428);
    expect((await call("PATCH", path(), JAY, { revision: rev() + 5, coachId: "ForkTester" })).status).toBe(409);
    expect((await call("PATCH", path(), JAY, { revision: "x", coachId: "ForkTester" })).status).toBe(400);
    expect((await call("PATCH", path(), JAY, { revision: rev(), coachId: "Nobody" })).body).toMatchObject({ error: 'No coach called "Nobody".', field: "coachId" });
    expect((await call("PATCH", path(), JAY, { revision: rev(), coachId: "Gone" })).status).toBe(400); // banned
    expect((await call("PATCH", path(), JAY, { revision: rev(), coachId: "" })).status).toBe(400);
    expect((await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester", allSeasons: "yes" })).status).toBe(400);
    expect((await call("PATCH", path("season-6", "nope"), JAY, { revision: rev(), coachId: "ForkTester" })).status).toBe(404);
    expect((await call("PATCH", path("season-9"), JAY, { revision: 0, coachId: "ForkTester" })).status).toBe(404);
    expect((await call("POST", path(), JAY, { revision: rev(), coachId: "ForkTester" })).status).toBe(405);
    expect(store.season("tabbl", "season-6")!.teams[0]!.coachId).toBeUndefined(); // nothing written so far
    const ok = await call("PATCH", path(), ROOT, { revision: rev(), coachId: "forktester" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, seasons: ["season-6"], team: { coachId: "ForkTester", coachAssigned: { by: "Root", at: "2026-10-30T18:00:00.000Z" } } });
    expect((ok.body as { revision: number }).revision).toBe(rev());
  });

  it("persists on the team, the participant row and unplayed fixtures only; logged; seats the account on the fork", async () => {
    const r = await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester" });
    expect(r.status).toBe(200);
    const s6 = store.season("tabbl", "season-6")!;
    expect(s6.teams.find((t) => t.id === "orcs")).toMatchObject({ coach: "Dee Display", coachId: "ForkTester" });
    expect(s6.participants[0]).toMatchObject({ coachId: "ForkTester", coachAssigned: true });
    expect(s6.fixtures.find((f) => f.id === "f1")!.home.coachId).toBeUndefined(); // played: history kept
    expect(s6.fixtures.find((f) => f.id === "f2")!.home).toMatchObject({ coachId: "ForkTester", coachAssigned: true });
    expect(s6.fixtures.find((f) => f.id === "f2")!.away.coachId).toBe("Bob");
    expect(s6.log![0]).toMatchObject({ kind: "team-coach", teamId: "orcs", by: "Jay", text: "Jay assigned the coach account ForkTester to Orcs." });
    expect(store.season("tabbl", "season-5")!.teams[0]!.coachId).toBeUndefined(); // this season only
    // the assigned account is the seat on Super FUMBBL
    const view = fixtureForkView(store.league("tabbl")!, s6, s6.fixtures.find((f) => f.id === "f2")!, { coach: "forktester", admin: false });
    expect(view.mySide).toBe("home");
    // the season read carries it (public too)
    const pub = (await call("GET", "/api/leagues/tabbl/seasons/season-6", undefined)).body as { season: SeasonRecord };
    expect(pub.season.teams[0]!.coachId).toBe("ForkTester");
    // clearing: null removes the assignment
    const cleared = await call("PATCH", path(), JAY, { revision: rev(), coachId: null });
    expect(cleared.status).toBe(200);
    const after = store.season("tabbl", "season-6")!;
    expect(after.teams[0]).not.toHaveProperty("coachId");
    expect(after.teams[0]).not.toHaveProperty("coachAssigned");
    expect(after.fixtures.find((f) => f.id === "f2")!.home).not.toHaveProperty("coachId");
    expect(after.log![0]!.text).toBe("Jay cleared the coach account of Orcs.");
  });

  it("allSeasons applies it to every season holding the team's lineage (same team id)", async () => {
    const r = await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester", allSeasons: true });
    expect(r.status).toBe(200);
    expect((r.body as { seasons: string[] }).seasons.sort()).toEqual(["season-5", "season-6"]);
    expect(store.season("tabbl", "season-5")!.teams[0]!.coachId).toBe("ForkTester");
    expect(store.season("tabbl", "season-5")!.fixtures[0]!.home.coachId).toBeUndefined(); // played
    expect(store.season("tabbl", "season-5")!.log![0]!.kind).toBe("team-coach");
  });

  it("a team in a running Super FUMBBL game is refused (409)", async () => {
    const s6 = store.season("tabbl", "season-6")!;
    s6.fixtures[1]!.fork = { status: "in_progress", teams: { home: { teamId: "orcs" } }, log: [] } as unknown as LeagueFixture["fork"];
    store.putSeason(s6);
    const r = await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester" });
    expect(r.status).toBe(409);
    expect((r.body as { error: string }).error).toContain("Super FUMBBL game");
  });

  it("[review P2] a fixture created (or a redraft roster applied) after an assignment keeps the account marked: no alias merge", async () => {
    await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester" });
    body = { home: "orcs", away: "elves", round: 3 };
    const created = await leagueApi("POST", "/api/leagues/tabbl/seasons/season-6/fixtures", new URLSearchParams(), JAY, deps());
    expect(created!.status).toBe(201);
    const s6 = store.season("tabbl", "season-6")!;
    const f = s6.fixtures.find((x) => x.round === 3)!;
    expect(f.home).toMatchObject({ coachId: "ForkTester", coachAssigned: true, nafUser: "deenaf" });
    expect(f.away).not.toHaveProperty("coachAssigned"); // Bob's own account
    const aliases = leagueAliases(store.seasons("tabbl"));
    expect(aliases.key({ coachId: "ForkTester" })).not.toBe(aliases.key({ coachId: "DeeAccount" }));
    // a redraft roster put into a season lists its coach with the marker as well
    const next = season(7, "active", []);
    next.teams = [];
    next.participants = [];
    applyDraftTeam(next, s6.teams.find((t) => t.id === "orcs")!);
    expect(next.participants[0]).toMatchObject({ coachId: "ForkTester", coachAssigned: true });
    const withNext = leagueAliases([...store.seasons("tabbl"), next]);
    expect(withNext.key({ coachId: "ForkTester" })).not.toBe(withNext.key({ coachId: "DeeAccount" }));
  });

  it("alias precedence: the assigned account keys alone; the imported name and NAF name stay with their coach", async () => {
    await call("PATCH", path(), JAY, { revision: rev(), coachId: "ForkTester" });
    const seasons = store.seasons("tabbl");
    const aliases = leagueAliases(seasons);
    // the display name and NAF name still resolve to the real account they were seen with
    expect(aliases.key({ coach: "Dee Display" })).toBe(aliases.key({ coachId: "DeeAccount" }));
    expect(aliases.key({ nafUser: "deenaf" })).toBe(aliases.key({ coachId: "DeeAccount" }));
    expect(aliases.key({ coachId: "ForkTester" })).not.toBe(aliases.key({ coachId: "DeeAccount" }));
    // the team row's explicit coachId is authoritative for ownership
    const orcs = seasons.find((s) => s.id === "season-6")!.teams[0]!;
    expect(coachOwnsTeam(orcs, "ForkTester", aliases)).toBe(true);
    expect(coachOwnsTeam(orcs, "DeeAccount", aliases)).toBe(false);
    // without the flag the same row would merge the two accounts through the NAF name
    const merged = buildCoachAliases([{ coach: "Dee Display", coachId: "DeeAccount", nafUser: "deenaf" }, { coach: "Dee Display", coachId: "ForkTester", nafUser: "deenaf" }]);
    expect(merged.key({ coachId: "ForkTester" })).toBe(merged.key({ coachId: "DeeAccount" }));
    const kept = buildCoachAliases([{ coach: "Dee Display", coachId: "DeeAccount", nafUser: "deenaf" }, { coach: "Dee Display", coachId: "ForkTester", nafUser: "deenaf", coachAssigned: true }]);
    expect(kept.key({ coachId: "ForkTester" })).not.toBe(kept.key({ coachId: "DeeAccount" }));
    expect(kept.key({ coach: "Dee Display" })).toBe(kept.key({ coachId: "DeeAccount" }));
    // a result on the assigned fixture credits the assigned account, named by its account
    const s6 = store.season("tabbl", "season-6")!;
    const f2 = s6.fixtures.find((f) => f.id === "f2")!;
    f2.home.score = 3; f2.away.score = 0; f2.home.cas = 0; f2.away.cas = 0;
    store.putSeason(s6);
    const stats = leagueStats(store.seasons("tabbl"), "all");
    expect(stats.coaches.find((c) => c.coach === "ForkTester")).toMatchObject({ games: 1, wins: 1 });
    expect(stats.coaches.find((c) => c.coach === "Dee Display")).toMatchObject({ games: 2 });
  });
});
