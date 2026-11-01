import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { onboardingGateApplies } from "../src/auth/onboarding";
import { requireSession } from "../src/auth/requireSession";
import { applyStarRule, budgetFor, gateOf, inducementStep, menuFor, newLobby, picksVisible, planSide, resolveStart, sideHasStep, tvRoles } from "../src/fixtureLobby/core";
import { LobbyPresence } from "../src/fixtureLobby/presence";
import { FixtureLobbyStore } from "../src/fixtureLobby/store";
import type { LobbyFixture, LobbyRecord, LobbyRules, LobbySide, LobbyTeam, ResolvedSide } from "../src/fixtureLobby/types";
import type { StartTabletopInput } from "../src/fixtureLobby/api";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { effectiveInducements, seasonInducementOffers } from "../src/leagues/inducements";
import { LeagueStore } from "../src/leagues/store";
import { leagueFixtureView, recordLeagueFixture, retractLeagueFixture } from "../src/leagues/tabletopFixtures";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { createMatch, type TabletopApiDeps } from "../src/tabletop/api";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";

// Fixture lobby (src/fixtureLobby; spec-landing-bubble-retro §8-§9.3): the pure rules (budgets per league vs tournament,
// Auto-Buy resolution, reveal, stars), and the league routes (public read, permissions, locks, the start gate, the
// underdog hold, idempotent START, chat), privacy coverage and the gates. Fake data only.

// ---- a synthetic fixture for the pure rules ----------------------------------------------------------------------

const team = (name: string, race: string, tv: number | null, treasury: number, stars: Array<{ name: string; cost: number }> = []): LobbyTeam => ({
  id: name.toLowerCase(), name, race, tv, treasury, rerolls: 2, apothecary: true, fans: 3, assistantCoaches: 0, cheerleaders: 0, playerCount: 12, roster: [],
  file: { schema: 1, name, race, treasury, dedicatedFans: 3, ...(tv !== null ? { teamValue: tv } : {}), players: [] }, stars,
});
const STAR = { name: "Akhorne the Squirrel", cost: 80_000 };
const LEAGUE_RULES: LobbyRules = { treasuryTopUp: true, highlander: false, starClash: "refund" };
const TOURNAMENT_RULES: LobbyRules = { treasuryTopUp: false, highlander: false, starClash: "refund" };

function fixture(over: { home?: Partial<LobbyTeam>; away?: Partial<LobbyTeam>; rules?: LobbyRules; mode?: "tabletop" | "fork" } = {}): LobbyFixture {
  const { offers, ids } = seasonInducementOffers(undefined);
  const stats = { played: 0, wins: 0, draws: 0, losses: 0, tdPerGame: 0, casPerGame: 0, form: [] };
  const side = (coach: string, t: LobbyTeam) => ({ coachId: coach, coach, team: t, stats: { season: stats, allTime: stats } });
  return {
    key: "league:alpha:season-1:f1", source: "league", mode: over.mode ?? "tabletop", open: true,
    header: { competition: "Alpha", round: 1, ruleset: "BB2025" },
    links: { competition: "/leagues/alpha", fixture: "/leagues/alpha?tab=fixtures&fixture=f1", standings: "", rules: "" },
    sides: {
      home: side("Ann", { ...team("Orcs", "Orc", 1_000_000, 100_000, [STAR]), ...over.home }),
      away: side("Bob", { ...team("Humans", "Human", 1_100_000, 150_000, [STAR]), ...over.away }),
    },
    rules: over.rules ?? LEAGUE_RULES, noInducements: "", offers, ids, table: effectiveInducements(undefined),
    isOrganiser: (c) => c === "Org", headToHead: { wins: { home: 0, away: 0 }, draws: 0, td: { home: 0, away: 0 }, cas: { home: 0, away: 0 }, meetings: [] },
    organisers: ["Org"], start: { fixtureRef: "league:alpha:season-1:f1", extra: {} },
  };
}
const NOW = new Date("2026-11-01T12:00:00.000Z");
function ready(rec: LobbyRecord): LobbyRecord {
  for (const s of ["home", "away"] as const) Object.assign(rec.sides[s], { rosterLocked: true, teamRef: `library:${s}`, ready: true });
  return rec;
}

describe("fixture lobby rules (pure)", () => {
  it("TV roles and the budget: the overdog buys with treasury only (leagues), the underdog has petty cash + up to 50K treasury", () => {
    const fx = fixture();
    expect(tvRoles(fx)).toEqual({ gap: 100_000, underdog: "home", overdog: "away" });
    const rec = newLobby(fx, NOW);
    expect(budgetFor(fx, rec, "away")).toMatchObject({ role: "overdog", pettyCash: 0, treasury: 150_000, topUpLimit: 150_000, limit: 150_000 });
    expect(budgetFor(fx, rec, "home")).toMatchObject({ role: "underdog", pettyCash: 100_000, topUpLimit: 50_000, limit: 150_000 });
    // while START is held, the underdog's petty cash includes the overdog's final spend
    expect(budgetFor(fx, { hold: { at: "", underdog: "home", overdogSpend: 100_000, pettyCash: 200_000, was: 100_000 } }, "home").pettyCash).toBe(200_000);
  });

  it("tournament rules (inducements.treasuryTopUp off): no treasury at all, so the overdog has no inducement step", () => {
    const fx = fixture({ rules: TOURNAMENT_RULES });
    const rec = newLobby(fx, NOW);
    expect(sideHasStep(fx, "away")).toBe(false);
    expect(sideHasStep(fx, "home")).toBe(true);
    expect(budgetFor(fx, rec, "home")).toMatchObject({ pettyCash: 100_000, topUpLimit: 0, limit: 100_000 });
    expect(planSide(fx, rec, "home", [{ id: "bribes", qty: 1 }])).toMatchObject({ total: 100_000, treasury: 0 });
    expect(planSide(fx, rec, "home", [{ id: "bribes", qty: 1 }, { id: "bloodweiser_kegs", qty: 1 }])).toMatchObject({ error: expect.stringMatching(/Petty cash is 100K; these cost 150K/) });
    // the same picks fit in a league: 50K of treasury tops up
    expect(planSide(fixture(), newLobby(fixture(), NOW), "home", [{ id: "bribes", qty: 1 }, { id: "bloodweiser_kegs", qty: 1 }])).toMatchObject({ total: 150_000, treasury: 50_000, pettyCash: 100_000 });
  });

  it("no inducement step: equal or unknown team values, and Super FUMBBL fixtures (bought in the client)", () => {
    expect(inducementStep(fixture({ away: { tv: 1_000_000 } }))).toMatch(/equal/);
    expect(inducementStep(fixture({ away: { tv: null } }))).toMatch(/unknown/);
    expect(inducementStep(fixture({ mode: "fork" }))).toMatch(/Super FUMBBL client/);
    expect(inducementStep(fixture())).toBe("");
  });

  it("menu: categories with prices and caps, ruleset-off rows greyed, stars from the roster with the 0-2 cap", () => {
    const menu = menuFor(fixture(), "home");
    expect(menu.map((c) => c.id)).toEqual(["staff", "star", "special", "mercenary"]);
    const stars = menu.find((c) => c.id === "star")!;
    expect(stars.cap).toBe(2);
    expect(stars.items).toEqual([expect.objectContaining({ id: `star:${STAR.name}`, price: 80_000, max: 1 })]);
    expect(menu.find((c) => c.id === "mercenary")!.off.some((o) => o.id === "mercenaries")).toBe(true);
    expect(menu.flatMap((c) => c.off).find((o) => o.id === "canopic_jar")?.reason).toBe("Ruleset off");
  });

  it("Auto-Buy, overdog spent 0: the underdog's pre-loaded list is bought as loaded; no hold", () => {
    const fx = fixture();
    const rec = ready(newLobby(fx, NOW));
    rec.sides.away.locked = true; // overdog locked an empty list
    Object.assign(rec.sides.home, { picks: [{ id: "bribes", qty: 1 }], locked: true, autoBuy: true });
    const out = resolveStart(fx, rec, { force: false, now: NOW });
    expect(out.kind).toBe("go");
    if (out.kind !== "go") return;
    expect(out.resolution).toMatchObject({ treasurySpend: 0, pettyCash: 100_000, home: { total: 100_000, picks: [{ id: "bribes", qty: 1 }] }, away: { total: 0 } });
  });

  it("overdog spent > 0: START holds, the underdog's petty cash grows, and START re-arms after the underdog locks again", () => {
    const fx = fixture();
    const rec = ready(newLobby(fx, NOW));
    Object.assign(rec.sides.away, { picks: [{ id: "bribes", qty: 1 }], locked: true, lockedAt: "2026-11-01T11:00:00.000Z" });
    Object.assign(rec.sides.home, { picks: [{ id: "bribes", qty: 1 }], locked: true, autoBuy: true });
    const held = resolveStart(fx, rec, { force: false, now: NOW });
    expect(held).toMatchObject({ kind: "held", hold: { underdog: "home", overdogSpend: 100_000, pettyCash: 200_000, was: 100_000 } });
    if (held.kind !== "held") return;
    expect(held.banner).toBe("Bob spent 100K. Ann has 200K petty cash now (was 100K).");
    rec.hold = held.hold;
    rec.sides.home.locked = false;
    // gated until the underdog locks again; the organiser cannot force past it
    expect(gateOf(fx, rec).blockers).toContain("Waiting for Ann to lock inducements.");
    expect(resolveStart(fx, rec, { force: true, now: NOW })).toMatchObject({ kind: "refused", error: "Waiting for Ann to lock inducements." });
    // the overdog's final list is visible to the underdog now, still hidden from a spectator
    expect(picksVisible(fx, rec, { kind: "side", side: "home" }, "away")).toBe(true);
    expect(picksVisible(fx, rec, { kind: "spectator" }, "away")).toBe(false);
    rec.sides.home.picks = [{ id: "bribes", qty: 2 }];
    rec.sides.home.locked = true;
    const go = resolveStart(fx, rec, { force: false, now: NOW });
    expect(go).toMatchObject({ kind: "go", resolution: { treasurySpend: 100_000, pettyCash: 200_000, home: { total: 200_000, treasury: 0 }, away: { total: 100_000, treasury: 100_000 } } });
  });

  it("Auto-Buy off: START holds for the underdog's manual pick even when the overdog spent nothing", () => {
    const fx = fixture();
    const rec = ready(newLobby(fx, NOW));
    rec.sides.away.locked = true;
    expect(resolveStart(fx, rec, { force: false, now: NOW })).toMatchObject({ kind: "held", hold: { overdogSpend: 0, pettyCash: 100_000 } });
  });

  it("reveal: opponent picks only when BOTH lock; a coach always sees their own; organisers see both", () => {
    const fx = fixture();
    const rec = newLobby(fx, NOW);
    rec.sides.away.locked = true;
    expect(picksVisible(fx, rec, { kind: "side", side: "home" }, "away")).toBe(false);
    expect(picksVisible(fx, rec, { kind: "side", side: "away" }, "away")).toBe(true);
    expect(picksVisible(fx, rec, { kind: "organiser" }, "home")).toBe(true);
    rec.sides.home.locked = true;
    expect(picksVisible(fx, rec, { kind: "side", side: "home" }, "away")).toBe(true);
    expect(picksVisible(fx, rec, { kind: "spectator" }, "home")).toBe(true);
  });

  it("stars: both may pick the same star; without Highlander it leaves BOTH teams (refunded); with Highlander the first to lock keeps it", () => {
    const line = (cost: number): ResolvedSide => ({ picks: [{ id: `star:${STAR.name}`, name: STAR.name, qty: 1, cost }], total: cost, treasury: 0, pettyCash: 0 });
    const plans = (): Record<LobbySide, ResolvedSide> => ({ home: { ...line(80_000), pettyCash: 100_000 }, away: { ...line(80_000), treasury: 80_000 } });
    const rec = newLobby(fixture(), NOW);
    rec.sides.home.lockedAt = "2026-11-01T11:30:00.000Z";
    rec.sides.away.lockedAt = "2026-11-01T11:00:00.000Z";
    const off = plans();
    expect(applyStarRule(fixture(), rec, off)).toEqual([{ name: STAR.name, removedFrom: ["home", "away"], refunded: true }]);
    expect(off.home).toMatchObject({ picks: [], total: 0, treasury: 0 });
    expect(off.away).toMatchObject({ picks: [], total: 0, treasury: 0 });
    const hl = plans();
    expect(applyStarRule(fixture({ rules: { ...LEAGUE_RULES, highlander: true } }), rec, hl)).toEqual([{ name: STAR.name, kept: "away", removedFrom: ["home"], refunded: true }]);
    expect(hl.away.picks).toHaveLength(1);
    expect(hl.home.picks).toHaveLength(0);
    const forfeit = plans();
    applyStarRule(fixture({ rules: { ...LEAGUE_RULES, starClash: "forfeit" } }), rec, forfeit);
    expect(forfeit.home).toMatchObject({ picks: [], total: 80_000 });
  });

  it("validation: unknown ids, caps, stars not for this roster, the star cap", () => {
    const fx = fixture();
    const rec = newLobby(fx, NOW);
    expect(planSide(fx, rec, "home", [{ id: "nope", qty: 1 }])).toHaveProperty("error");
    expect(planSide(fx, rec, "home", [{ id: "bribes", qty: 4 }])).toMatchObject({ error: "Bribes: at most 3." });
    expect(planSide(fx, rec, "home", [{ id: "star:Someone Else", qty: 1 }])).toHaveProperty("error");
    expect(planSide(fx, rec, "home", [{ id: `star:${STAR.name}`, qty: 2 }])).toHaveProperty("error");
  });
});

// ---- league routes -------------------------------------------------------------------------------------------------

const players = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({
  playerId: `p-${prefix}${i}`, number: i + 1, name: `${prefix} ${i + 1}`, position: "Lineman", ma: 5, st: 3, ag: 3, pa: 4, av: 9, skills: i === 0 ? ["Block"] : [],
  value: 50_000, level: "", availableSpp: i, niggling: 0, missNextGame: false,
  stats: { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 },
}));
const leagueTeam = (id: string, name: string, race: string, coachId: string, tv: number, treasury: number): LeagueTeam => ({
  id, name, race, coach: coachId, coachId, teamValue: tv, currentTeamValue: tv, treasury, rerolls: 2, fans: 3, assistantCoaches: 0, cheerleaders: 0,
  apothecary: true, tier: "", raceLeague: "", players: players(12, name.slice(0, 1)), formerPlayers: [],
});
const fside = (t: LeagueTeam, score: number | null = null, cas: number | null = null) => ({ team: t.name, teamId: t.id, coach: t.coach, coachId: t.coachId, race: t.race, score, cas, conceded: false });
const ORCS = leagueTeam("orcs", "Green Tide", "Orc", "Ann", 1_000_000, 100_000);
const HUMANS = leagueTeam("humans", "Grudge Rollers", "Human", "Bob", 1_100_000, 150_000);
const fx = (id: string, round: number, hs: number | null = null, as: number | null = null, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: fside(ORCS, hs, hs === null ? null : 1), away: fside(HUMANS, as, as === null ? null : 0), suspended: false, ...over,
});
const season1 = (fixtures: LeagueFixture[]): SeasonRecord => ({
  id: "season-1", leagueId: "alpha", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams: [ORCS, HUMANS], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-01T00:00:00.000Z", source: "manual",
});

describe("league fixture lobby routes", () => {
  let dir = "";
  let store: LeagueStore;
  let lobbyStore: FixtureLobbyStore;
  let presence: LobbyPresence;
  let started: StartTabletopInput[];
  let clock = 0;
  const L = "/api/leagues/alpha/seasons/season-1/fixtures/f1/lobby";
  const deps = (body?: unknown): LeagueApiDeps => ({
    store,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date(Date.parse("2026-11-01T12:00:00.000Z") + clock++ * 1000),
    lobby: {
      store: lobbyStore, presence,
      recorderTeams: (coach) => [{ ref: `library:${coach.toLowerCase()}-team`, name: `${coach}'s team` }],
      startTabletop: async (input) => {
        started.push(input);
        await new Promise((r) => setTimeout(r, 5));
        return { status: 201, body: { match: { id: `tm_${started.length}` } } };
      },
      findMatchFor: async () => undefined,
    },
  });
  const call = async (coach: string | undefined, method: string, path: string, body?: unknown): Promise<LeagueApiResult> => {
    const r = await leagueApi(method, path, new URLSearchParams(), coach ? { coach, admin: coach === "Root" } : undefined, deps(body));
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  type View = { viewer: { role: string; canStart: boolean; canForce: boolean }; chat: unknown[] | null; sides: Record<LobbySide, { inducements: { picks: unknown; locked: boolean; visible: boolean } }>; gate: { blockers: string[]; armed: boolean }; hold: { banner: string } | null; started: { matchId?: string } | null; headToHead: { wins: Record<LobbySide, number>; meetings: unknown[] } };
  const view = async (coach?: string): Promise<View> => (await call(coach, "GET", L)).body as View;
  const post = async (coach: string, action: string, body: unknown) => call(coach, "POST", `${L}/${action}`, body);
  const err = (r: LeagueApiResult): string => (r.body as { error: string }).error;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-lobby-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    store.putSeason(season1([fx("f0", 0, 2, 1, { finishedAt: "2026-10-10T20:00:00.000Z" }), fx("f1", 1)]));
    lobbyStore = new FixtureLobbyStore(dir);
    presence = new LobbyPresence();
    started = [];
    clock = 0;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function readyBoth(): Promise<void> {
    for (const c of ["Ann", "Bob"]) {
      expect((await post(c, "roster", { locked: true, teamRef: `library:${c.toLowerCase()}-team` })).status).toBe(200);
      expect((await post(c, "ready", { ready: true })).status).toBe(200);
    }
  }

  it("GET is public: a visitor gets a read-only view without chat; requireSession waves the read through, not the writes", async () => {
    const v = await view();
    expect(v.viewer).toMatchObject({ role: "spectator", canStart: false });
    expect(v.chat).toBeNull();
    expect(v.headToHead.wins).toEqual({ home: 1, away: 0 }); // f0: Ann 2-1 Bob
    expect(v.headToHead.meetings).toHaveLength(1);
    const req = (method: string) => ({ method, headers: {} }) as IncomingMessage;
    expect(requireSession(req("GET"), L, "").kind).toBe("allow");
    expect(requireSession(req("POST"), `${L}/chat`, "").kind).toBe("unauthorized");
    // a GET never creates the lobby file
    expect(readdirSync(dir)).not.toContain("fixture-lobbies");
    expect((await view("Ann")).viewer.role).toBe("home");
    expect((await view("Org")).viewer.role).toBe("organiser");
  });

  it("writes: anonymous 401, a stranger 403, own side only for coaches, any side for organisers", async () => {
    expect((await call(undefined, "POST", `${L}/chat`, { text: "hi" })).status).toBe(401);
    expect((await post("Eve", "chat", { text: "hi" })).status).toBe(403);
    expect((await post("Ann", "roster", { side: "away", locked: true, teamRef: "library:bob-team" })).status).toBe(403);
    expect((await post("Org", "roster", { side: "away", locked: true, teamRef: "library:bob-team" })).status).toBe(200);
    // a site admin who is not a league organiser is an organiser here too
    expect((await view("Root")).viewer.role).toBe("organiser");
    // the recorder team must be one of the coach's own teams
    expect(err(await post("Ann", "roster", { locked: true, teamRef: "library:bob-team" }))).toMatch(/Choose the team/);
  });

  it("chat: plain text, 500 characters at most, kept for coaches + organisers only; system lines record locks", async () => {
    expect((await post("Ann", "chat", { text: "Hi! <b>see you</b>" })).status).toBe(200);
    expect((await post("Ann", "chat", { text: "x".repeat(501) })).status).toBe(400);
    expect((await post("Ann", "chat", { text: "bell\u0007" })).status).toBe(400);
    expect((await post("Ann", "chat", { text: "two\nlines" })).status).toBe(400);
    await post("Bob", "roster", { locked: true, teamRef: "library:bob-team" });
    const bob = await view("Bob");
    expect(bob.chat!.map((m) => (m as { text: string }).text)).toEqual(["Hi! <b>see you</b>", "Bob locked their roster."]);
    expect((await view("Org")).chat).toHaveLength(2);
    expect((await view("Eve")).chat).toBeNull();
  });

  it("chat rate limit answers 429 with retry-after", async () => {
    let n = 0;
    const limited = async () => leagueApi("POST", `${L}/chat`, new URLSearchParams(), { coach: "Ann", admin: false },
      { ...deps({ text: "spam" }), lobby: { ...deps().lobby!, chatLimiter: { take: () => (++n > 2 ? 30 : 0) } } });
    expect((await limited())!.status).toBe(200);
    expect((await limited())!.status).toBe(200);
    const third = (await limited())!;
    expect(third.status).toBe(429);
    expect(third.headers?.["retry-after"]).toBe("30");
  });

  it("presence: a heartbeat POST marks the coach online; GET never does", async () => {
    await view("Bob");
    expect(((await view("Ann")).sides.away as unknown as { online: boolean }).online).toBe(false);
    expect((await post("Bob", "presence", {})).status).toBe(200);
    expect(((await view("Ann")).sides.away as unknown as { online: boolean }).online).toBe(true);
  });

  it("inducements: own side only; locked lists answer 409 until an organiser unlocks; the organiser never locks for the underdog", async () => {
    // Ann (Green Tide, TV 1.0M) is the underdog; Bob (1.1M) the overdog
    expect((await post("Ann", "inducements", { side: "away", picks: [] })).status).toBe(403);
    expect((await post("Bob", "inducements", { side: "away", picks: [{ id: "bribes", qty: 1 }], lock: true })).status).toBe(200);
    const again = await post("Bob", "inducements", { side: "away", picks: [] });
    expect(again.status).toBe(409);
    expect(err(again)).toMatch(/locked/);
    // the underdog cannot lock early without Auto-Buy
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 1 }], lock: true }))).toMatch(/Auto-Buy/);
    expect(err(await post("Bob", "inducements", { side: "away", autoBuy: true }))).toMatch(/locked|underdog/);
    expect(err(await post("Org", "inducements", { side: "home", picks: [], autoBuy: true, lock: true }))).toBe("The underdog locks their own inducements.");
    // over budget blocks Lock
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 2 }], autoBuy: true, lock: true }))).toMatch(/Petty cash is 100K/);
    // organiser unlocks the overdog
    expect((await post("Org", "inducements", { side: "away", lock: false })).status).toBe(200);
    expect((await post("Bob", "inducements", { side: "away", picks: [] })).status).toBe(200);
  });

  it("reveal over HTTP: the opponent's picks are null until both lock; organisers see both", async () => {
    await post("Bob", "inducements", { side: "away", picks: [{ id: "bribes", qty: 1 }], lock: true });
    expect((await view("Ann")).sides.away.inducements.picks).toBeNull();
    expect((await view("Bob")).sides.away.inducements.picks).toHaveLength(1);
    expect((await view("Org")).sides.away.inducements.picks).toHaveLength(1);
    expect((await view()).sides.away.inducements.picks).toBeNull();
    await post("Ann", "inducements", { side: "home", picks: [{ id: "bloodweiser_kegs", qty: 1 }], autoBuy: true, lock: true });
    expect((await view("Ann")).sides.away.inducements.picks).toHaveLength(1);
    expect((await view()).sides.home.inducements.picks).toHaveLength(1);
  });

  it("start gate, then the underdog hold: START held, the underdog kicked back with the banner, organiser force refused, re-lock re-arms", async () => {
    expect(err(await post("Ann", "start", {}))).toMatch(/has not locked their roster/);
    await readyBoth();
    expect(err(await post("Ann", "start", {}))).toBe("Bob has not locked their inducements.");
    await post("Bob", "inducements", { side: "away", picks: [{ id: "bribes", qty: 1 }], lock: true });
    await post("Ann", "inducements", { side: "home", picks: [{ id: "bloodweiser_kegs", qty: 1 }], autoBuy: true, lock: true });
    const held = await post("Bob", "start", {});
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({ held: true, banner: "Bob spent 100K. Ann has 200K petty cash now (was 100K)." });
    expect(started).toHaveLength(0);
    const ann = await view("Ann");
    expect(ann.hold?.banner).toMatch(/Bob spent 100K/);
    expect(ann.sides.home.inducements.locked).toBe(false);
    expect(ann.sides.away.inducements.picks).toHaveLength(1); // the overdog's final list is visible to the underdog
    // underdog offline: HOLD; no organiser bypass
    expect(err(await post("Org", "start", { force: true }))).toBe("Waiting for Ann to lock inducements.");
    expect(err(await post("Bob", "inducements", { side: "away", picks: [] }))).toMatch(/locked/);
    // the underdog adjusts and locks again with the bigger petty cash: START re-arms
    expect((await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 1 }, { id: "bloodweiser_kegs", qty: 1 }], lock: true })).status).toBe(200);
    const go = await post("Ann", "start", {});
    expect(go.body).toMatchObject({ started: true, to: "/tabletop/tm_1" });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({
      fixtureRef: "league:alpha:season-1:f1", home: { coach: "Ann", team: "library:ann-team" }, away: { coach: "Bob", team: "library:bob-team" },
      extra: { leagueSeason: { leagueId: "alpha", seasonId: "season-1" }, league: "Alpha League" },
      inducementsByCoach: { ann: { total: 150_000, pettyCash: 200_000 }, bob: { total: 100_000, treasury: 100_000 } },
    });
  });

  it("Auto-Buy with an overdog that spent nothing: one START creates the match", async () => {
    await readyBoth();
    await post("Bob", "inducements", { side: "away", picks: [], lock: true });
    await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 1 }], autoBuy: true, lock: true });
    const go = await post("Ann", "start", {});
    expect(go.body).toMatchObject({ started: true });
    expect(started[0]!.inducementsByCoach.ann).toMatchObject({ total: 100_000, picks: [{ id: "bribes", qty: 1 }] });
  });

  it("START is idempotent: two STARTs at once create ONE match; a later START answers with the same match", async () => {
    await readyBoth();
    await post("Bob", "inducements", { side: "away", picks: [], lock: true });
    await post("Ann", "inducements", { side: "home", picks: [], autoBuy: true, lock: true });
    const [a, b] = await Promise.all([post("Ann", "start", {}), post("Bob", "start", {})]);
    expect(started).toHaveLength(1);
    expect(a.body).toMatchObject({ started: true, to: "/tabletop/tm_1" });
    expect(b.body).toMatchObject({ started: true, to: "/tabletop/tm_1" });
    expect((await post("Org", "start", { force: true })).body).toMatchObject({ to: "/tabletop/tm_1" });
    expect((await view()).started?.matchId).toBe("tm_1");
    // after the start nothing changes any more
    expect((await post("Ann", "ready", { ready: false })).status).toBe(409);
  });

  it("organiser force start skips the Ready presses only; coaches cannot force", async () => {
    for (const c of ["Ann", "Bob"]) await post(c, "roster", { locked: true, teamRef: `library:${c.toLowerCase()}-team` });
    await post("Bob", "inducements", { side: "away", picks: [], lock: true });
    await post("Ann", "inducements", { side: "home", picks: [], autoBuy: true, lock: true });
    expect((await view("Org")).viewer.canForce).toBe(true);
    expect((await post("Ann", "start", { force: true })).status).toBe(403);
    expect(err(await post("Ann", "start", {}))).toMatch(/not ready/);
    expect((await post("Org", "start", { force: true })).body).toMatchObject({ started: true });
  });

  it("a played fixture is read-only; a Super FUMBBL fixture starts without inducements and points at its launch page", async () => {
    expect(err(await call("Ann", "POST", "/api/leagues/alpha/seasons/season-1/fixtures/f0/lobby/roster", { locked: true, teamRef: "library:ann-team" }))).toBe("This fixture has been played.");
    store.updateLeague("alpha", (l) => { l.playOnFork = true; });
    const s = store.season("alpha", "season-1")!;
    s.fixtures[1]!.forkEnabled = true;
    store.putSeason(s);
    for (const c of ["Ann", "Bob"]) { await post(c, "roster", { locked: true }); await post(c, "ready", { ready: true }); }
    expect(err(await post("Ann", "inducements", { side: "home", picks: [] }))).toMatch(/Super FUMBBL client/);
    const go = await post("Ann", "start", {});
    expect(go.body).toMatchObject({ started: true, to: "/leagues/alpha?tab=fixtures&fixture=f1" });
    expect(started).toHaveLength(0);
  });

  it("CSRF and onboarding cover every lobby write; the read is not a state change", () => {
    for (const a of ["presence", "chat", "roster", "ready", "inducements", "start"]) {
      expect(isStateChangingApiRequest("POST", `${L}/${a}`)).toBe(true);
      expect(onboardingGateApplies("POST", `${L}/${a}`)).toBe(true);
    }
    expect(isStateChangingApiRequest("GET", L)).toBe(false);
    expect(onboardingGateApplies("GET", L)).toBe(false);
  });
});

// ---- privacy ---------------------------------------------------------------------------------------------------------

describe("fixture lobby privacy coverage", () => {
  it("the export carries the coach's lobby chats; deletion shows them as the pseudonym (never erased)", async () => {
    const { collectExport, DELETE_STEPS, STORE_COLLECTORS, KNOWN_STORES } = await import("../src/privacy/collectors");
    expect(KNOWN_STORES).toContain("fixture-lobbies");
    expect(STORE_COLLECTORS.find((c) => c.id === "fixture-lobbies")?.erase).toEqual(["anonymise-fixture-lobbies"]);
    const dir = mkdtempSync(join(tmpdir(), "fixture-lobby-privacy-"));
    try {
      const store = new FixtureLobbyStore(dir);
      const rec = newLobby({ key: "league:alpha:season-1:f1", source: "league", sides: { home: { coachId: "Ann" }, away: { coachId: "Bob" } } as never }, NOW);
      rec.chat.push({ id: "1", from: "Ann", text: "Hi Bob, Ann here", at: NOW.toISOString(), role: "home" }, { id: "2", from: "Bob", text: "GG", at: NOW.toISOString(), role: "away" });
      rec.sides.home.by = "Ann";
      store.put(rec);
      const deps = { stateDir: dir, tournamentsDir: dir, libraryDir: dir, builderSavesDir: dir, teamAvatarsDir: dir, coachAvatarsDir: dir, bugReportsDir: dir, tabletopDir: dir };
      const files = await collectExport(deps, "Ann");
      const lobbies = JSON.parse(String(files.find((f) => f.name === "fixture-lobbies.json")!.content)) as Array<{ chat: Array<{ text: string }> }>;
      expect(lobbies[0]!.chat.map((m) => m.text)).toEqual(["Hi Bob, Ann here", "GG"]);
      expect((await collectExport(deps, "Carol")).some((f) => f.name === "fixture-lobbies.json")).toBe(false);
      const { createAnonymiser, createTextReplacer } = await import("../src/privacy/anonymise");
      const an = createAnonymiser(["Ann"], "Deleted coach #7");
      const step = DELETE_STEPS.find((s) => s.id === "anonymise-fixture-lobbies")!;
      await step.run({ deps, an, names: new Set(["ann"]), text: () => createTextReplacer(["Ann"], "Deleted coach #7", ["Bob"]) } as never);
      const after = JSON.parse(readFileSync(join(store.dir, readdirSync(store.dir)[0]!), "utf8")) as LobbyRecord;
      expect(after.coaches).toEqual(["Deleted coach #7", "Bob"]);
      expect(after.chat[0]).toMatchObject({ from: "Deleted coach #7" });
      expect(after.chat[0]!.text).not.toContain("Ann");
      expect(after.chat[1]).toMatchObject({ from: "Bob", text: "GG" });
      expect(after.sides.home.by).toBe("Deleted coach #7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- the recorder link -------------------------------------------------------------------------------------------------

describe("league fixtures in the tabletop recorder (START's createMatch)", () => {
  let dir = "";
  let store: LeagueStore;
  const tplayers = (n: number, prefix: string): TabletopPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
  const file = (race: string, prefix: string): TabletopTeamFile => ({ schema: 1, name: `${prefix} XI`, race, treasury: 100_000, dedicatedFans: 2, teamValue: 1_000_000, players: tplayers(11, prefix) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fixture-lobby-tt-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    store.putSeason(season1([fx("f1", 1)]));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("the gateway resolves league refs; createMatch seats the lobby inducements by the drawn seats; publish/undo write and clear the result", async () => {
    const ref = "league:alpha:season-1:f1";
    expect(leagueFixtureView(store, ref)).toMatchObject({ id: ref, open: true, revision: 0, home: { coach: "Ann" }, away: { coach: "Bob" } });
    const deps: TabletopApiDeps = {
      repo: new FileTabletopRepository(join(dir, "tt")), results: new TournamentResultStore(join(dir, "res")),
      loadTeamFile: (coach) => (coach === "Ann" ? file("Orc", "a") : file("Human", "b")),
      isBanned: () => false, isOrganizer: () => false, drawSeats: () => true, // the seat draw swaps home and away
      leagueInducements: () => ({ config: undefined, active: true, coaches: ["Ann", "Bob"] }),
      fixtures: {
        get: (id) => leagueFixtureView(store, id),
        record: (id, input, at) => recordLeagueFixture(store, id, input, at),
        retract: (id, input, at) => retractLeagueFixture(store, id, input, at),
      },
    };
    const lists = { ann: { picks: [{ id: "bribes", name: "Bribes", qty: 1, cost: 100_000 }], total: 100_000, treasury: 0, pettyCash: 100_000 }, bob: { picks: [], total: 0, treasury: 0, pettyCash: 0 } };
    const made = await createMatch("Ann", false, { fixtureRef: ref, home: { coach: "Ann", team: "library:a" }, away: { coach: "Bob", team: "library:b" }, leagueSeason: { leagueId: "alpha", seasonId: "season-1" }, league: "Alpha League" }, deps, () => NOW, { inducementsByCoach: lists });
    expect(made.status).toBe(201);
    const match = (made.body as { match: { home: { coach: string }; inducements: Record<LobbySide, { total: number }>; fixtureSwap?: boolean } }).match;
    expect(match.home.coach).toBe("Bob");
    expect(match.inducements).toEqual({ home: lists.bob, away: lists.ann });
    expect(match.fixtureSwap).toBe(true);
    recordLeagueFixture(store, ref, { opId: "op1", expectedRevision: 0, homeScore: 2, awayScore: 0, homeCasualties: 1, awayCasualties: 0 }, NOW);
    const f = store.season("alpha", "season-1")!.fixtures[0]!;
    expect(f).toMatchObject({ home: { score: 2, cas: 1 }, away: { score: 0 }, tabletop: { revision: 1, opId: "op1" } });
    expect(leagueFixtureView(store, ref)).toMatchObject({ open: false, revision: 1, resultOpId: "op1" });
    expect(() => recordLeagueFixture(store, ref, { expectedRevision: 1, homeScore: 1, awayScore: 1, homeCasualties: 0, awayCasualties: 0 }, NOW)).toThrow(/already has a result/);
    retractLeagueFixture(store, ref, { expectedRevision: 1 }, NOW);
    expect(store.season("alpha", "season-1")!.fixtures[0]).toMatchObject({ home: { score: null }, away: { score: null }, tabletop: { revision: 2 } });
    expect(leagueFixtureView(store, ref)?.open).toBe(true);
  });
});
