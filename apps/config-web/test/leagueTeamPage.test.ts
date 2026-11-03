import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RulesChangeCoalescer } from "../src/competition/rulesChange";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { leagueApi, type LeagueApiDeps, type LeagueApiIdentity, type LeagueApiResult } from "../src/leagues/api";
import { recordLeagueFixtureEvent } from "../src/leagues/events";
import { LeagueStore } from "../src/leagues/store";
import { advancementCount, ensureTeamIdentity, INJURIES, playerLeaves, rosterLimitMetrics, settleServedMng, worsenedLimits } from "../src/leagues/teamOps";
import { buildDraftTeam } from "../src/leagues/redraft";
import { teamValueRoster } from "../src/leagues/teamValue";
import { findPosition } from "@bb/validator";
import type { TeamPageView } from "../src/leagues/teamPage";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";

// Team page v2 (src/leagues/teamPage.ts + teamOps.ts): coach editing within the rules (pre-game vs in-season), the
// organiser's edit mode (scoped to THIS league's organisers and site admins), injuries, MNG, Seasons Played, the team status
// cog with its fixture decisions, history and notes and their privacy.

const player = (id: string, number: number, position: string, over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: id, careerKey: `c-${id}`, number, name: `P${number}`, position, ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills: [], value: 85_000, level: "Rookie",
  availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, seasonsPlayed: 0, ...over,
});
const dwarves = (over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: "rollers", name: "Grudge Rollers", race: "Dwarf", coach: "Dee", coachId: "Dee", teamValue: 0, treasury: 200_000, rerolls: 1, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "2", raceLeague: "",
  players: [player("p1", 1, "Dwarf Blocker Lineman"), player("p2", 2, "Dwarf Blocker Lineman"), player("p3", 3, "Runner", { ma: 6, value: 85_000 })],
  formerPlayers: [], ...over,
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Orcs", race: "Orc", coach: "Bob", coachId: "Bob", teamValue: 0, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0,
  apothecary: false, tier: "1", raceLeague: "", players: [player("o1", 1, "Orc Lineman")], formerPlayers: [],
});
const elves = (): LeagueTeam => ({ ...orcs(), id: "elves", name: "Elves", race: "Wood Elf", coach: "Cat", coachId: "Cat", players: [player("e1", 1, "Wood Elf Lineman")] });
const fx = (id: string, home: [string, string], away: [string, string], score: [number, number] | null, round = 1): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: { team: home[1], teamId: home[0], coach: "x", race: "x", score: score?.[0] ?? null, cas: score ? 0 : null, conceded: false },
  away: { team: away[1], teamId: away[0], coach: "y", race: "y", score: score?.[1] ?? null, cas: score ? 0 : null, conceded: false },
  suspended: false,
});
const R: [string, string] = ["rollers", "Grudge Rollers"];
const O: [string, string] = ["orcs", "Orcs"];
const E: [string, string] = ["elves", "Elves"];
const season = (fixtures: LeagueFixture[], teams: LeagueTeam[] = [dwarves(), orcs(), elves()], over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: "season-1", leagueId: "lg", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00.000Z", source: "manual", ...over,
});

describe("team page v2", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let notes: Array<{ to: string; title: string; body: string }>;
  let scheduled: Array<() => void>;
  let coalescer: RulesChangeCoalescer;
  const deps = (): LeagueApiDeps => ({
    store, now: () => new Date("2026-11-02T12:00:00Z"), notify: (to, n) => { notes.push({ to, title: n.title, body: n.body }); },
    teamNotices: coalescer, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  });
  const ORG: LeagueApiIdentity = { coach: "Jay", admin: false };
  const CO_ORG: LeagueApiIdentity = { coach: "Kim", admin: false };
  const ADMIN: LeagueApiIdentity = { coach: "Root", admin: true };
  const COACH: LeagueApiIdentity = { coach: "dee", admin: false }; // case-insensitive seat
  const OTHER_COACH: LeagueApiIdentity = { coach: "Bob", admin: false };
  const OTHER_LEAGUE_ORG: LeagueApiIdentity = { coach: "Zed", admin: false };
  const SITE_ORGANISER: LeagueApiIdentity = { coach: "Sam", admin: false, organizer: true };
  const base = "/api/leagues/lg/seasons/season-1/teams/rollers";
  const rev = () => store.season("lg", "season-1")!.revision ?? 0;
  const team = (id = "rollers") => store.season("lg", "season-1")!.teams.find((t) => t.id === id)!;
  const call = async (method: string, p: string, auth: LeagueApiIdentity | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, p, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  const edit = (auth: LeagueApiIdentity, mode: "coach" | "organiser", ops: unknown[]) => call("POST", `${base}/edit`, auth, { revision: rev(), mode, ops });
  const view = async (auth: LeagueApiIdentity = ORG): Promise<TeamPageView> => ((await call("GET", `${base}/manage`, auth)).body as { view: TeamPageView }).view;
  const publicSeason = async (auth?: LeagueApiIdentity) => ((await call("GET", "/api/leagues/lg/seasons/season-1", auth)).body as { season: SeasonRecord }).season;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-team-page-"));
    store = new LeagueStore(dir);
    notes = [];
    scheduled = [];
    coalescer = new RulesChangeCoalescer(60_000, (fn) => { scheduled.push(fn); }, () => 0);
    store.upsertLeague({ id: "lg", name: "Harbour League", fullName: "Harbour League", slug: "lg", organisers: ["Jay", "Kim"] });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Zed"] });
    store.putSeason(season([fx("f1", R, O, null, 1), fx("f2", E, R, null, 2), fx("f3", O, E, null, 3)]));
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const playGame = (id: string, score: [number, number]) => {
    const s = store.season("lg", "season-1")!;
    const f = s.fixtures.find((x) => x.id === id)!;
    f.home.score = score[0]; f.away.score = score[1]; f.home.cas = 0; f.away.cas = 0;
    s.resultsChangedAt = "2026-11-02T11:00:00.000Z";
    store.putSeason(s);
  };

  describe("who may do what", () => {
    it("the edit context: coach and organisers only; another league's organiser and a site organiser who is not a member are refused", async () => {
      expect((await call("GET", `${base}/manage`, undefined)).status).toBe(401);
      for (const a of [OTHER_COACH, OTHER_LEAGUE_ORG, SITE_ORGANISER]) expect((await call("GET", `${base}/manage`, a)).status).toBe(403);
      const c = await view(COACH);
      expect(c.role).toEqual({ coach: true, organiser: false });
      expect(c.skills).toBeUndefined(); // organiser-only lists
      expect(c.fixtures).toBeUndefined();
      expect((await view(ORG)).role).toEqual({ coach: false, organiser: true });
      expect((await view(ADMIN)).role.organiser).toBe(true);
      expect((await call("POST", `${base}/manage`, ORG, {})).status).toBe(405);
    });

    it("edit mode is scoped: coach, another league's organiser and a site-organiser non-member get 403 and nothing is written", async () => {
      const before = rev();
      for (const a of [COACH, OTHER_COACH, OTHER_LEAGUE_ORG, SITE_ORGANISER]) {
        const r = await edit(a, "organiser", [{ op: "team", field: "treasury", value: 999_000 }]);
        expect(r.status, a.coach).toBe(403);
      }
      expect(rev()).toBe(before);
      expect(team().treasury).toBe(200_000);
      // coach mode is the team's own coach only (an organiser who does not coach the team is refused there)
      expect((await edit(OTHER_COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "X" }])).status).toBe(403);
      expect((await edit(ORG, "coach", [{ op: "player", playerId: "p1", field: "name", value: "X" }])).status).toBe(403);
      // the scoped role and an admin may
      expect((await edit(ORG, "organiser", [{ op: "team", field: "treasury", value: 150_000 }])).status).toBe(200);
      expect((await edit(ADMIN, "organiser", [{ op: "team", field: "rerolls", value: 3 }])).status).toBe(200);
      expect(team()).toMatchObject({ treasury: 150_000, rerolls: 3 });
    });

    it("revision: 428 missing, 409 stale; bad mode 400; unknown team 404", async () => {
      expect((await call("POST", `${base}/edit`, ORG, { mode: "organiser", ops: [{ op: "team", field: "fans", value: 2 }] })).status).toBe(428);
      expect((await call("POST", `${base}/edit`, ORG, { revision: rev() + 3, mode: "organiser", ops: [{ op: "team", field: "fans", value: 2 }] })).status).toBe(409);
      expect((await call("POST", `${base}/edit`, ORG, { revision: rev(), mode: "god", ops: [] })).status).toBe(400);
      expect((await call("GET", "/api/leagues/lg/seasons/season-1/teams/nope/manage", ORG)).status).toBe(404);
    });

    it("CSRF covers every write here (POST) and the GET is a read: it never changes the season", async () => {
      expect(isStateChangingApiRequest("POST", `${base}/edit`)).toBe(true);
      expect(isStateChangingApiRequest("POST", `${base}/status`)).toBe(true);
      expect(isStateChangingApiRequest("POST", `${base}/fixtures`)).toBe(true);
      expect(isStateChangingApiRequest("GET", `${base}/manage`)).toBe(false);
      // a served MNG and the missing identity are computed on a copy by the GET, never stored
      const s = store.season("lg", "season-1")!;
      s.teams[0]!.players[0]!.missNextGame = true; s.teams[0]!.players[0]!.mngGames = 0;
      store.putSeason(s);
      playGame("f1", [1, 0]);
      const r0 = rev();
      const v = await view(ORG);
      expect(v.team.players[0]!.missNextGame).toBe(false);
      expect(v.team.teamUid).toBeUndefined(); // identity is minted by a write, never by a read
      expect(rev()).toBe(r0);
      expect(team().players[0]!.missNextGame).toBe(true);
      expect(team().teamUid).toBeUndefined();
    });
  });

  describe("coach editing within the rules", () => {
    it("pre-game: hire and fire within the budget, rerolls up and down, rename and renumber; stats are not theirs", async () => {
      const v = await view(COACH);
      expect(v.phase).toBe("pregame");
      expect(v.coach).toMatchObject({ rerolls: true, fire: true, advance: false });
      const blocker = v.hire.positions.find((p) => /Blocker/.test(p.name))!;
      const r = await edit(COACH, "coach", [{ op: "hire", position: blocker.name }]);
      expect(r.status).toBe(200);
      expect(team().players).toHaveLength(4);
      expect(team().treasury).toBe(200_000 - blocker.cost);
      const hired = team().players.find((p) => !["p1", "p2", "p3"].includes(p.playerId))!;
      expect(hired).toMatchObject({ number: 4, level: "Rookie", value: blocker.cost, position: blocker.name });
      // fire before the first game: the player goes (no former-player row) and the price comes back
      expect((await edit(COACH, "coach", [{ op: "fire", playerId: hired.playerId }])).status).toBe(200);
      expect(team().players).toHaveLength(3);
      expect(team().formerPlayers).toHaveLength(0);
      expect(team().treasury).toBe(200_000);
      // rerolls: a team with no games played can still change them (roster price), both ways
      const rr = v.hire.staff.find((s) => s.key === "rerolls")!;
      expect((await edit(COACH, "coach", [{ op: "staff", key: "rerolls", delta: 1 }])).status).toBe(200);
      expect(team()).toMatchObject({ rerolls: 2, treasury: 200_000 - rr.price });
      expect((await edit(COACH, "coach", [{ op: "staff", key: "rerolls", delta: -1 }])).status).toBe(200);
      expect(team()).toMatchObject({ rerolls: 1, treasury: 200_000 });
      // rename / renumber; a taken number is refused
      expect((await edit(COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "Grimli" }, { op: "player", playerId: "p1", field: "number", value: 7 }])).status).toBe(200);
      expect(team().players.find((p) => p.playerId === "p1")).toMatchObject({ name: "Grimli", number: 7 });
      expect((await edit(COACH, "coach", [{ op: "player", playerId: "p2", field: "number", value: 7 }])).body).toMatchObject({ error: "Number 7 is already taken." });
      expect((await edit(COACH, "coach", [{ op: "player", playerId: "p2", field: "ma", value: 9 }])).status).toBe(403);
      expect((await edit(COACH, "coach", [{ op: "team", field: "treasury", value: 9_000_000 }])).status).toBe(403);
      expect((await edit(COACH, "coach", [{ op: "injury", playerId: "p2", injury: "dead" }])).status).toBe(403);
    });

    it("pre-game: over the budget or the position limit is refused, and nothing of the batch is written", async () => {
      const v = await view(COACH);
      const pricey = [...v.hire.positions].sort((a, b) => b.cost - a.cost)[0]!;
      const s = store.season("lg", "season-1")!;
      s.teams[0]!.treasury = pricey.cost - 1;
      store.putSeason(s);
      const r = await edit(COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "Kept?" }, { op: "hire", position: pricey.name }]);
      expect(r.status).toBe(400);
      expect((r.body as { error: string }).error).toMatch(/Not enough gold/);
      expect(team().players.find((p) => p.playerId === "p1")!.name).toBe("P1"); // the whole batch is refused
      const capped = v.hire.positions.find((p) => p.max <= 2 && p.cost < 200_000)!;
      const s2 = store.season("lg", "season-1")!;
      s2.teams[0]!.treasury = 2_000_000;
      store.putSeason(s2);
      const ops = Array.from({ length: capped.max - capped.count + 1 }, () => ({ op: "hire", position: capped.name }));
      const over = await edit(COACH, "coach", ops);
      expect(over.status).toBe(400);
      expect((over.body as { error: string }).error).toMatch(new RegExp(`At most ${capped.max}`));
    });

    it("in-season: rerolls locked, no firing, staff only up, hiring and advancements paid from treasury and SPP", async () => {
      playGame("f1", [2, 1]);
      const base0 = store.season("lg", "season-1")!;
      Object.assign(base0.teams[0]!.players[0]!, { ma: 4, st: 3, ag: 4, pa: 5, av: 10, skills: ["Block", "Defensive", "Thick Skull"] }); // the position's printed line: no advancement yet
      store.putSeason(base0);
      const v = await view(COACH);
      expect(v.phase).toBe("inseason");
      expect(v.coach).toMatchObject({ rerolls: false, fire: false, advance: true });
      expect((await edit(COACH, "coach", [{ op: "staff", key: "rerolls", delta: 1 }])).body).toMatchObject({ error: expect.stringMatching(/Rerolls can't be changed/) });
      expect((await edit(COACH, "coach", [{ op: "staff", key: "rerolls", delta: -1 }])).status).toBe(403);
      expect((await edit(COACH, "coach", [{ op: "fire", playerId: "p1" }])).status).toBe(403);
      expect((await edit(COACH, "coach", [{ op: "staff", key: "fans", delta: 1 }])).status).toBe(403);
      expect((await edit(COACH, "coach", [{ op: "staff", key: "cheerleaders", delta: 1 }])).status).toBe(200);
      expect(team()).toMatchObject({ cheerleaders: 1, treasury: 190_000 });
      expect((await edit(COACH, "coach", [{ op: "staff", key: "cheerleaders", delta: -1 }])).status).toBe(403);
      // advancement: chosen Primary, priced from the BB2025 table by advancements taken
      const adv = v.advancement.p1!;
      expect(adv.costs.chosenPrimary).toBe(6);
      const skill = adv.primary[0]!;
      expect((await edit(COACH, "coach", [{ op: "advance", playerId: "p1", skill, method: "chosenPrimary" }])).body).toMatchObject({ error: expect.stringMatching(/costs 6 SPP/) });
      const s = store.season("lg", "season-1")!;
      s.teams[0]!.players[0]!.availableSpp = 7;
      store.putSeason(s);
      expect((await edit(COACH, "coach", [{ op: "advance", playerId: "p1", skill: "Not A Skill", method: "chosenPrimary" }])).status).toBe(400);
      expect((await edit(COACH, "coach", [{ op: "advance", playerId: "p1", skill, method: "chosenPrimary" }])).status).toBe(200);
      expect(team().players[0]).toMatchObject({ availableSpp: 1, level: "Experienced", value: 85_000 + 20_000 + (skill === "Block" || skill === "Guard" || skill === "Mighty Blow" || skill === "Dodge" ? 10_000 : 0) });
      expect(team().players[0]!.skills).toContain(skill);
    });

    it("the phase comes from the team record itself: an unrelated same-id team in another season changes nothing; imported games or SPP do", async () => {
      store.putSeason({ ...season([fx("g1", R, O, [1, 1])]), id: "season-0", number: 0, sourceSlug: "s0", status: "completed" });
      expect((await view(COACH)).phase).toBe("pregame"); // no link by id or name
      const s = store.season("lg", "season-1")!;
      s.phases[0]!.standings = [{ group: "", rank: 1, team: "Grudge Rollers", teamId: "rollers", race: "Dwarf", coach: "Dee", points: 3, played: 1, wins: 1, draws: 0, losses: 0, tdFor: 1, tdAgainst: 0, casFor: 0, casAgainst: 0, injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0, sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0 }];
      store.putSeason(s);
      expect((await view(COACH)).phase).toBe("inseason"); // imported games played
      const t = store.season("lg", "season-1")!;
      t.phases[0]!.standings = [];
      t.teams[0]!.players[1]!.seasonsPlayed = 2; // a redrafted veteran
      store.putSeason(t);
      expect((await view(COACH)).phase).toBe("inseason");
    });

    it("a pre-game firing refunds the purchase price (or at most the position's price), never the valuation: no fire / rehire profit", async () => {
      const s = store.season("lg", "season-1")!;
      s.teams[0]!.players[0]!.value = 300_000; // a valuation far above the position's price
      store.putSeason(s);
      const cost = (await view(COACH)).hire.positions.find((p) => p.name === "Dwarf Blocker Lineman")!.cost;
      await edit(COACH, "coach", [{ op: "fire", playerId: "p1" }]);
      expect(team().treasury).toBe(200_000 + cost);
      await edit(COACH, "coach", [{ op: "hire", position: "Dwarf Blocker Lineman" }]);
      const hired = team().players.find((p) => !["p2", "p3"].includes(p.playerId))!;
      expect(hired.purchasePrice).toBe(cost);
      const s2 = store.season("lg", "season-1")!;
      s2.teams[0]!.players.find((p) => p.playerId === hired.playerId)!.value = 500_000;
      store.putSeason(s2);
      await edit(COACH, "coach", [{ op: "fire", playerId: hired.playerId }]);
      expect(team().treasury).toBe(200_000 + cost);
    });

    it("an already-invalid roster may shrink but never grow past a limit (counts, not messages)", async () => {
      const s = store.season("lg", "season-1")!;
      const t = s.teams[0]!;
      for (let i = 4; i <= 17; i += 1) t.players.push(player(`x${i}`, i + 10, "Dwarf Blocker Lineman"));
      t.treasury = 2_000_000;
      store.putSeason(s);
      expect(team().players).toHaveLength(17);
      expect((await edit(COACH, "coach", [{ op: "hire", position: "Dwarf Blocker Lineman" }])).body).toMatchObject({ error: expect.stringMatching(/at most 16 players/) });
      expect((await edit(COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "Still fine" }])).status).toBe(200);
      expect((await edit(COACH, "coach", [{ op: "fire", playerId: "x17" }])).status).toBe(200);
      const before = rosterLimitMetrics(team(), teamValueRoster("Dwarf"));
      expect(worsenedLimits(before, before)).toEqual([]);
    });

    it("an inactive team or a finished season is read-only for its coach", async () => {
      await call("POST", `${base}/status`, ORG, { revision: rev(), status: "inactive" });
      expect((await edit(COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "X" }])).body).toMatchObject({ error: "This team is inactive in the league." });
    });
  });

  describe("organiser edit mode", () => {
    it("every number: team numbers, stats, SPP, value, Seasons Played, niggles, MNG; skills added and removed", async () => {
      const r = await edit(ORG, "organiser", [
        { op: "team", field: "treasury", value: 90_000 }, { op: "team", field: "fans", value: 4 }, { op: "team", field: "assistantCoaches", value: 2 },
        { op: "team", field: "apothecary", value: true },
        { op: "player", playerId: "p1", field: "ma", value: 6 }, { op: "player", playerId: "p1", field: "av", value: 11 },
        { op: "player", playerId: "p1", field: "availableSpp", value: 12 }, { op: "player", playerId: "p1", field: "spp", value: 20 },
        { op: "player", playerId: "p1", field: "value", value: 120_000 }, { op: "player", playerId: "p1", field: "seasonsPlayed", value: 3 },
        { op: "player", playerId: "p1", field: "td", value: 4 },
        { op: "addSkill", playerId: "p2", skill: "mighty blow" }, { op: "addSkill", playerId: "p2", skill: "Hatred (Elf)" },
      ]);
      expect(r.status).toBe(200);
      const t = team();
      expect(t).toMatchObject({ treasury: 90_000, fans: 4, assistantCoaches: 2, apothecary: true });
      expect(t.players[0]).toMatchObject({ ma: 6, av: 11, availableSpp: 12, value: 120_000, seasonsPlayed: 3 });
      expect(t.players[0]!.stats).toMatchObject({ spp: 20, td: 4 });
      expect(t.players[1]!.skills).toEqual(["Mighty Blow", "Hatred (Elf)"]);
      expect((await edit(ORG, "organiser", [{ op: "removeSkill", playerId: "p2", skill: "Mighty Blow" }])).status).toBe(200);
      expect(team().players[1]!.skills).toEqual(["Hatred (Elf)"]);
      // stat limits hold even in edit mode
      expect((await edit(ORG, "organiser", [{ op: "player", playerId: "p1", field: "ma", value: 12 }])).status).toBe(400);
      // Seasons Played is in the public read
      expect((await publicSeason()).teams[0]!.players[0]!.seasonsPlayed).toBe(3);
    });

    it("a team rename reaches its fixture sides", async () => {
      expect((await edit(ORG, "organiser", [{ op: "team", field: "name", value: "Grudge Bearers" }])).status).toBe(200);
      const s = store.season("lg", "season-1")!;
      expect(s.fixtures.find((f) => f.id === "f1")!.home.team).toBe("Grudge Bearers");
      expect(s.fixtures.find((f) => f.id === "f3")!.home.team).toBe("Orcs");
    });

    it.each(INJURIES.filter((i) => i.stat).map((i) => [i.key, i.stat!] as const))("injury %s reduces %s", async (key, stat) => {
      const before = team().players[0]![stat]!;
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p1", injury: key }])).status).toBe(200);
      const p = team().players[0]!;
      expect(p[stat]).toBe(stat === "ma" || stat === "st" || stat === "av" ? before - 1 : before + 1);
      expect(p.missNextGame).toBe(false); // a lasting injury can be added without MNG
      expect(p.injuries).toEqual([{ type: key, at: "2026-11-02T12:00:00.000Z", by: "Jay" }]);
      // with MNG when asked
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p2", injury: key, mng: true }])).status).toBe(200);
      expect(team().players[1]!.missNextGame).toBe(true);
    });

    it("Seriously Hurt sets MNG; Badly Hurt is a record only; Niggling adds one; Dead leaves the roster", async () => {
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p1", injury: "seriously-hurt" }])).status).toBe(200);
      expect(team().players[0]).toMatchObject({ missNextGame: true, mngGames: 0, ma: 5, st: 3, ag: 3, pa: 4, av: 10, niggling: 0 });
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p2", injury: "badly-hurt" }])).status).toBe(200);
      expect(team().players[1]).toMatchObject({ missNextGame: false, ma: 5, st: 3, ag: 3, pa: 4, av: 10, niggling: 0 });
      expect(team().players[1]!.injuries).toEqual([{ type: "badly-hurt", at: "2026-11-02T12:00:00.000Z", by: "Jay" }]);
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p2", injury: "niggling" }])).status).toBe(200);
      expect(team().players[1]).toMatchObject({ niggling: 1, missNextGame: false });
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p3", injury: "dead" }])).status).toBe(200);
      expect(team().players.map((p) => p.playerId)).toEqual(["p1", "p2"]);
      expect(team().formerPlayers.map((p) => p.playerId)).toEqual(["p3"]);
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p1", injury: "broken-hip" }])).status).toBe(400);
      // the public read never names who recorded an injury
      const pub = (await publicSeason()).teams[0]!;
      expect(pub.players[1]!.injuries).toEqual([{ type: "badly-hurt", at: "2026-11-02T12:00:00.000Z" }, { type: "niggling", at: "2026-11-02T12:00:00.000Z" }]);
    });

    it("MNG clears by itself after the player's next game (read at once, stored by the next write or result hook)", async () => {
      await edit(ORG, "organiser", [{ op: "player", playerId: "p1", field: "missNextGame", value: true }]);
      expect((await publicSeason()).teams[0]!.players[0]!.missNextGame).toBe(true);
      playGame("f3", [1, 0]); // not this team's game
      expect((await publicSeason()).teams[0]!.players[0]!.missNextGame).toBe(true);
      playGame("f1", [0, 0]); // the team's next game: served
      expect((await publicSeason()).teams[0]!.players[0]!.missNextGame).toBe(false);
      // the shared result hook stores it
      await recordLeagueFixtureEvent("lg", "f1", "result", { handEntered: true }, { store, now: () => new Date("2026-11-02T13:00:00Z") });
      expect(team().players[0]).toMatchObject({ missNextGame: false });
      expect(team().players[0]!.mngGames).toBeUndefined();
      // a flag set after that game waits for the following one
      await edit(ORG, "organiser", [{ op: "player", playerId: "p1", field: "missNextGame", value: true }]);
      expect(team().players[0]).toMatchObject({ missNextGame: true, mngGames: 1 });
      const s = store.season("lg", "season-1")!;
      expect(settleServedMng(s)).toBe(false);
    });
  });

    it("an MNG recovery refreshes the current team value, from the result hook and from a forfeit decision (stored, not just read)", async () => {
      await edit(ORG, "organiser", [{ op: "player", playerId: "p1", field: "missNextGame", value: true }]);
      const tv = team().teamValue!;
      expect(team().currentTeamValue).toBe(tv - 85_000);
      playGame("f1", [1, 0]);
      await recordLeagueFixtureEvent("lg", "f1", "result", { handEntered: true }, { store, now: () => new Date("2026-11-02T13:00:00Z") });
      expect(team().players[0]!.missNextGame).toBe(false);
      expect(team().currentTeamValue).toBe(tv);
      // a forfeit decided for an inactive opponent is a game for the Rollers too: their MNG is served and stored
      await edit(ORG, "organiser", [{ op: "player", playerId: "p2", field: "missNextGame", value: true }]);
      expect(team().currentTeamValue).toBe(tv - 85_000);
      const elvesPath = "/api/leagues/lg/seasons/season-1/teams/elves";
      await call("POST", `${elvesPath}/status`, ORG, { revision: rev(), status: "inactive", decisions: [{ fixtureId: "f2", decision: "forfeit" }] });
      expect(team().players[1]!.missNextGame).toBe(false); // stored, not only in the answer
      expect(team().players[1]!.mngGames).toBeUndefined();
      expect(team().currentTeamValue).toBe(tv);
    });

  describe("team status", () => {
    it("inactive: standings row gone, opponents keep earned points; no fixture is cancelled until the organiser decides", async () => {
      playGame("f1", [0, 2]); // Orcs beat the Rollers
      expect((await call("POST", `${base}/status`, COACH, { revision: rev(), status: "inactive" })).status).toBe(403);
      expect((await call("POST", `${base}/status`, OTHER_LEAGUE_ORG, { revision: rev(), status: "inactive" })).status).toBe(403);
      expect((await call("POST", `${base}/status`, SITE_ORGANISER, { revision: rev(), status: "inactive" })).status).toBe(403);
      const r = await call("POST", `${base}/status`, ORG, { revision: rev(), status: "inactive" });
      expect(r.status).toBe(200);
      expect((r.body as { view: TeamPageView }).view.needDecision).toBe(1);
      const s = await publicSeason();
      const rows = s.phases[0]!.standings;
      expect(rows.some((x) => x.teamId === "rollers")).toBe(false);
      expect(rows.find((x) => x.teamId === "orcs")).toMatchObject({ played: 1, wins: 1, points: 3, rank: 1 });
      // never auto-cancelled
      const f2 = store.season("lg", "season-1")!.fixtures.find((f) => f.id === "f2")!;
      expect(f2.home.score).toBeNull();
      expect(f2.deadlineOutcome).toBeUndefined();
      expect(f2.inactiveDecision).toBeUndefined();
      // back to active: the row returns
      expect((await call("POST", `${base}/status`, ORG, { revision: rev(), status: "active" })).status).toBe(200);
      expect((await publicSeason()).phases[0]!.standings.some((x) => x.teamId === "rollers")).toBe(true);
    });

    it("an inactive team takes no part in tiebreaks: head-to-head among the remaining tied teams decides", async () => {
      // A beat X, X beat B, B beat A, all 1-0: with X in the tie everyone is level (name order puts Elves first);
      // without X, Orcs (B) beat Elves (A) head to head.
      const s = season([fx("g1", E, R, [1, 0]), fx("g2", R, O, [1, 0]), fx("g3", O, E, [1, 0])]);
      s.resultsChangedAt = "2026-11-02T00:00:00.000Z";
      store.putSeason(s);
      expect((await publicSeason()).phases[0]!.standings.map((r) => r.teamId)).toEqual(["elves", "rollers", "orcs"]);
      await call("POST", `${base}/status`, ORG, { revision: rev(), status: "inactive" });
      const rows = (await publicSeason()).phases[0]!.standings;
      expect(rows.map((r) => [r.teamId, r.rank, r.points])).toEqual([["orcs", 1, 3], ["elves", 2, 3]]);
    });

    it("the decision flow: per fixture at the cog, later in bulk; forfeit gives the opponent the win, cancel counts nowhere, leave stays", async () => {
      store.putSeason({ ...store.season("lg", "season-1")!, fixtures: [...store.season("lg", "season-1")!.fixtures, fx("f4", R, E, null, 4), fx("f5", O, R, null, 5)] });
      const r = await call("POST", `${base}/status`, ORG, { revision: rev(), status: "inactive", decisions: [{ fixtureId: "f1", decision: "leave" }] });
      expect((r.body as { view: TeamPageView }).view.needDecision).toBe(3);
      expect((await call("POST", `${base}/fixtures`, COACH, { revision: rev(), all: "cancel" })).status).toBe(403);
      expect((await call("POST", `${base}/fixtures`, ORG, { revision: rev(), decisions: [{ fixtureId: "f3", decision: "cancel" }] })).status).toBe(400); // not this team's
      expect((await call("POST", `${base}/fixtures`, ORG, { revision: rev(), decisions: [{ fixtureId: "f2", decision: "forfeit" }] })).status).toBe(200);
      const after = await call("POST", `${base}/fixtures`, ORG, { revision: rev(), all: "cancel" });
      expect((after.body as { view: TeamPageView }).view.needDecision).toBe(0);
      const s = store.season("lg", "season-1")!;
      const f = (id: string) => s.fixtures.find((x) => x.id === id)!;
      expect(f("f1")).toMatchObject({ inactiveDecision: { decision: "leave", by: "Jay" } });
      expect(f("f1").home.score).toBeNull();
      expect(f("f2")).toMatchObject({ inactiveDecision: { decision: "forfeit" }, away: { conceded: true }, home: { conceded: false, score: 0 } });
      expect(f("f4")).toMatchObject({ inactiveDecision: { decision: "cancel" }, deadlineOutcome: { outcome: "no-result", by: "Jay" } });
      expect(f("f5").deadlineOutcome?.outcome).toBe("no-result");
      const rows = (await publicSeason()).phases[0]!.standings;
      expect(rows.find((x) => x.teamId === "elves")).toMatchObject({ wins: 1, points: 3 });
      // a decision can be changed later: the forfeit is undone when it becomes a cancel
      expect((await call("POST", `${base}/fixtures`, ORG, { revision: rev(), decisions: [{ fixtureId: "f2", decision: "leave" }] })).status).toBe(200);
      const f2 = store.season("lg", "season-1")!.fixtures.find((x) => x.id === "f2")!;
      expect(f2.home.score).toBeNull();
      expect(f2.away.conceded).toBe(false);
      // a fixture played after an earlier "leave" has a real result: it is no longer decidable (409), never overwritten
      const s3 = store.season("lg", "season-1")!;
      const f1 = s3.fixtures.find((x) => x.id === "f1")!;
      f1.home.score = 3; f1.away.score = 1; f1.home.cas = 0; f1.away.cas = 0;
      store.putSeason(s3);
      expect((await call("POST", `${base}/fixtures`, ORG, { revision: rev(), decisions: [{ fixtureId: "f1", decision: "forfeit" }] })).status).toBe(409);
      expect(store.season("lg", "season-1")!.fixtures.find((x) => x.id === "f1")!.home).toMatchObject({ score: 3, conceded: false });
      // fixture decisions belong to an inactive team
      await call("POST", `${base}/status`, ORG, { revision: rev(), status: "active" });
      expect((await call("POST", `${base}/fixtures`, ORG, { revision: rev(), all: "cancel" })).status).toBe(409);
    });
  });

  describe("history and notes", () => {
    it("organiser edits: history with old and new, a coach note, the record-change note to the OTHER organisers; coalesced", async () => {
      await edit(ORG, "organiser", [{ op: "team", field: "treasury", value: 100_000 }]);
      const h = team().history!;
      expect(h[0]).toMatchObject({ by: "Jay", kind: "organiser-edit", at: "2026-11-02T12:00:00.000Z", changes: [{ what: "Treasury", from: "200k", to: "100k" }] });
      expect(notes.map((n) => [n.to, n.title])).toEqual([["Dee", "An organiser updated your team"], ["Kim", "Harbour League: Grudge Rollers was changed"]]);
      expect(notes[0]!.body).toContain("Treasury: 200k → 100k");
      // a burst within the window is held, then goes out as one combined note
      await edit(ORG, "organiser", [{ op: "team", field: "fans", value: 3 }]);
      await edit(ORG, "organiser", [{ op: "team", field: "cheerleaders", value: 2 }]);
      expect(notes).toHaveLength(2);
      scheduled.forEach((fn) => fn());
      expect(notes).toHaveLength(4);
      expect(notes[2]!.body).toMatch(/Dedicated fans: 1 → 3[\s\S]*Cheerleaders: 0 → 2/);
    });

    it("an admin's edit notifies every organiser; status changes are logged and noted", async () => {
      await call("POST", `${base}/status`, ADMIN, { revision: rev(), status: "inactive" });
      expect(team().history![0]).toMatchObject({ kind: "status", by: "Root", changes: [{ what: "Status", from: "Active", to: "Inactive" }] });
      expect(notes.map((n) => n.to).sort()).toEqual(["Dee", "Jay", "Kim"]);
    });

    it("coach self-edits are logged without notes", async () => {
      await edit(COACH, "coach", [{ op: "player", playerId: "p1", field: "name", value: "Grimli" }]);
      expect(team().history![0]).toMatchObject({ kind: "coach-edit", by: "dee", changes: [{ what: "P1 name", from: "P1", to: "Grimli" }] });
      expect(notes).toEqual([]);
    });

    it("history is for the team's coach and organisers only: never in a season read, public or another coach's", async () => {
      await edit(ORG, "organiser", [{ op: "team", field: "treasury", value: 100_000 }]);
      for (const a of [undefined, OTHER_COACH, COACH, ORG]) expect((await publicSeason(a)).teams[0]!.history).toBeUndefined();
      expect((await view(COACH)).history).toHaveLength(1);
      expect((await view(CO_ORG)).history).toHaveLength(1);
      expect((await call("GET", `${base}/manage`, OTHER_COACH)).status).toBe(403);
    });
  });

  describe("library-lane shape and the stable leave API", () => {
    it("teamUid travels only by explicit links: same-named or same-id teams never share one; minted and stored on the first write", async () => {
      const a = dwarves();
      const b = dwarves();
      ensureTeamIdentity(a);
      ensureTeamIdentity(b);
      expect(a.teamUid).toMatch(/^tm-[a-f0-9]{12}$/);
      expect(a.teamUid).not.toBe(b.teamUid); // same id and name, no proven link
      expect(a.entryId).not.toBe(b.entryId);
      await edit(ORG, "organiser", [{ op: "team", field: "fans", value: 2 }]);
      const uid = team().teamUid;
      expect(uid).toMatch(/^tm-/);
      await edit(ORG, "organiser", [{ op: "team", field: "fans", value: 3 }]);
      expect(team().teamUid).toBe(uid); // stored, never re-minted
    });

    it("a redraft copies the lineage (teamUid, history) into the next season but not the entry, the status or MNG bookkeeping", () => {
      const src = dwarves({ teamUid: "tm-aaaaaaaaaaaa", entryId: "en-bbbbbbbbbbbb", status: "inactive", statusChanged: { by: "Jay", at: "x" }, history: [{ at: "x", by: "Jay", kind: "status", changes: [{ what: "Status" }] }] });
      src.players[0]!.mngGames = 0;
      const ctx = { task: { budget: { capped: 1_000_000 } }, source: season([]), team: src, roster: teamValueRoster("Dwarf"), teamPlayed: true } as never;
      const price = { keep: [{ quote: { playerId: "p1", value: 85_000, seasons: 1 } }], hires: [], staffCost: 0, spent: 0, remaining: 0, players: 1 } as never;
      const input = { keep: ["p1"], hires: [], staff: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false } } as never;
      const next = buildDraftTeam(ctx, price, input, { leagueId: "lg", slug: "s2" }, new Set());
      expect(next.teamUid).toBe("tm-aaaaaaaaaaaa");
      expect(next.history).toHaveLength(1);
      expect(next.entryId).toBeUndefined();
      expect(next.status).toBeUndefined();
      expect(next.statusChanged).toBeUndefined();
      expect(next.players[0]!.mngGames).toBeUndefined();
      ensureTeamIdentity(next);
      expect(next.entryId).not.toBe("en-bbbbbbbbbbbb");
      expect(next.teamUid).toBe("tm-aaaaaaaaaaaa");
    });

    it("advancements are counted per skill and characteristic: stat gains without a +X entry count; traits from results do not", () => {
      const pos = findPosition(teamValueRoster("Dwarf")!, "Dwarf Blocker Lineman")!;
      const n = (v: unknown): number => Number.parseInt(String(v), 10);
      const base = { skills: [...pos.skills], ma: pos.MA, st: pos.ST, ag: n(pos.AG), pa: n(pos.PA), av: n(pos.AV) };
      expect(advancementCount(base, pos)).toBe(0);
      expect(advancementCount({ ...base, skills: [...pos.skills, "Hatred (Elf)"] }, pos)).toBe(0); // a trait from a result
      expect(advancementCount({ ...base, st: base.st + 1 }, pos)).toBe(1); // a gain without its +ST entry
      expect(advancementCount({ ...base, st: base.st + 1, skills: [...pos.skills, "+ST"] }, pos)).toBe(1); // not twice
      expect(advancementCount({ ...base, ag: base.ag - 1 }, pos)).toBe(1); // AG target down = better
      expect(advancementCount({ ...base, skills: [...pos.skills, "+MA"] }, pos)).toBe(1); // bought, then lost to an injury
      expect(advancementCount({ ...base, skills: [...pos.skills, "Guard", "Team Captain", "Pro"], captainGrants: ["Team Captain", "Pro"] }, pos)).toBe(1);
    });

    it("Sol re-review examples: imported captains, spelling variants, \"+1 ST\" entries, injuries never erase a gain", () => {
      const pos = findPosition(teamValueRoster("Dwarf")!, "Dwarf Blocker Lineman")!;
      const n = (v: unknown): number => Number.parseInt(String(v), 10);
      const base = { skills: [...pos.skills], ma: pos.MA, st: pos.ST, ag: n(pos.AG), pa: n(pos.PA), av: n(pos.AV) };
      // 1. an imported captain has no captainGrants record: the trait and its one free Pro are still no advancement
      expect(advancementCount({ ...base, skills: [...pos.skills, "Team Captain", "Pro"] }, pos)).toBe(0);
      expect(advancementCount({ ...base, skills: [...pos.skills, "Team Captain", "Pro", "Pro"] }, pos)).toBe(1); // a second Pro is bought
      // 2. spelling: "Hit & Run" is the catalogue's "Hit and Run" (the validator's canonSkill)
      expect(advancementCount({ ...base, skills: [...pos.skills, "Hit & Run"] }, pos)).toBe(1);
      expect(advancementCount({ ...base, skills: [...pos.skills, "Side Step"] }, pos)).toBe(1);
      // 3. every spelling statAdvanceOf reads: "+1 ST"
      expect(advancementCount({ ...base, st: base.st + 1, skills: [...pos.skills, "+1 ST"] }, pos)).toBe(1);
      expect(advancementCount({ ...base, skills: [...pos.skills, "+1 ST"] }, pos)).toBe(1);
      // 4. gains = (current + recorded lasting-injury reductions) - position base: a recorded Smashed Knee never erases one
      expect(advancementCount({ ...base, ma: base.ma, injuries: [{ type: "smashed-knee", at: "x" }] }, pos)).toBe(1); // was base + 1
      expect(advancementCount({ ...base, ma: base.ma - 1, injuries: [{ type: "smashed-knee", at: "x" }] }, pos)).toBe(0); // no gain, only the knee
      expect(advancementCount({ ...base, ma: base.ma, injuries: [{ type: "badly-hurt", at: "x" }] }, pos)).toBe(0); // no stat effect
      expect(advancementCount({ ...base, ag: base.ag, injuries: [{ type: "neck-injury", at: "x" }] }, pos)).toBe(1); // AG target: was one better
    });

    it("an organiser's lasting injury first writes an inferred gain down as \"+X\", so the advancement is never erased", async () => {
      const pos = findPosition(teamValueRoster("Dwarf")!, "Dwarf Blocker Lineman")!;
      const s = store.season("lg", "season-1")!;
      Object.assign(s.teams[0]!.players[0]!, { ma: pos.MA + 1, st: pos.ST, ag: 4, pa: 5, av: 10, skills: [...pos.skills] });
      store.putSeason(s);
      expect(advancementCount(team().players[0]!, pos)).toBe(1); // inferred from MA
      expect((await edit(ORG, "organiser", [{ op: "injury", playerId: "p1", injury: "smashed-knee" }])).status).toBe(200);
      const p = team().players[0]!;
      expect(p.ma).toBe(pos.MA);
      expect(p.skills).toContain("+MA");
      expect(advancementCount(p, pos)).toBe(1);
      expect(team().history![0]!.changes).toContainEqual({ what: "P1 (#1) advancement recorded", to: "+MA" });
      // a recorded injury alone (no +X entry) also keeps the gain: MA at base with one Smashed Knee on record
      expect(advancementCount({ ...p, skills: [...pos.skills] }, pos)).toBe(1);
    });

    it("a redrafted team is in-season even with an all-rookie roster; a redraft mints the lineage id on the SOURCE and copies it", async () => {
      const s = store.season("lg", "season-1")!;
      s.teams[0]!.redraftedFrom = { seasonId: "season-0" };
      store.putSeason(s);
      expect((await view(COACH)).phase).toBe("inseason");
      const src = dwarves(); // no teamUid yet
      const ctx = { task: { budget: { capped: 1_000_000 } }, source: season([]), team: src, roster: teamValueRoster("Dwarf"), teamPlayed: true } as never;
      const price = { keep: [], hires: [], staffCost: 0, spent: 0, remaining: 0, players: 0 } as never;
      const input = { keep: [], hires: [], staff: { rerolls: 0, assistantCoaches: 0, cheerleaders: 0, apothecary: false } } as never;
      const next = buildDraftTeam(ctx, price, input, { leagueId: "lg", slug: "s2" }, new Set());
      expect(src.teamUid).toMatch(/^tm-[a-f0-9]{12}$/);
      expect(next.teamUid).toBe(src.teamUid);
      expect(next.redraftedFrom).toEqual({ seasonId: "season-1" });
    });

    it("playerLeaves moves a player to the former players with stats and skills and returns the row", () => {
      const t = dwarves();
      t.players[0]!.skills = ["Block"];
      t.players[0]!.stats.td = 2;
      const row = playerLeaves(t, "p1", "defected");
      expect(row).toMatchObject({ playerId: "p1", skills: ["Block"], stats: { td: 2 } });
      expect(t.players.map((p) => p.playerId)).toEqual(["p2", "p3"]);
      expect(t.formerPlayers.map((p) => p.playerId)).toEqual(["p1"]);
      expect(playerLeaves(t, "nobody", "dead")).toBeUndefined();
    });
  });
});
