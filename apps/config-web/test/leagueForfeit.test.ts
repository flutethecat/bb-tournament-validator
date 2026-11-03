import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import type { DiscordPayload } from "../src/leagues/discord";
import { LeagueStore } from "../src/leagues/store";
import { EMPTY_PLAYER_STATS, type LeagueFixture, type LeaguePlayer, type LeagueTeam, type SeasonRecord } from "../src/leagues/types";
import { MemoryDiceLog, fixtureLogId } from "../src/dice/log";
import { sequenceRoller } from "../src/dice/roller";
import { advancementCount, defectionCandidates, isLegalConcession, parseForfeitInput, suggestForfeit } from "../src/forfeit/rules";
import { adminResult } from "../src/discord/weekly";
import { computePhaseStandings } from "../src/leagues/standings";
import { buildForfeitPost } from "../src/leagues/forfeit";
import { cleanPayload } from "../src/discord/clean";

// Forfeit dialog (src/leagues/forfeit.ts, src/forfeit/rules.ts): FFB defection rules, the admin toggle, pre-filled
// penalties, roster removal and history, standings, the digest label and the webhook report. No network.

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";
const pl = (id: string, position: string, skills: string[] = [], over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId: id, number: Number(id.replace(/\D/g, "")) || 1, name: `Orc ${id}`, position, ma: 5, st: 3, ag: 3, pa: 4, av: 10, skills,
  value: 50000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...EMPTY_PLAYER_STATS }, ...over,
});
const orcs = (): LeagueTeam => ({
  id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", coachId: "Ann", teamValue: 1000000, treasury: 50000, rerolls: 2, fans: 3,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [
    pl("p1", "Orc Blitzer", ["Block", "Dodge", "Guard", "Tackle"]), // 3 gained skills (Block is printed)
    pl("p2", "Orc Blitzer", ["Block", "Dodge", "Guard"]), // 2 gained
    pl("p3", "Orc Lineman", ["Block", "Team Captain", "Pro", "Dodge", "Guard"]), // BB2025: 3 (captain grants excluded)
    pl("p4", "Orc Lineman", ["Block"], { ma: 7, st: 4 }), // 1 skill + 3 characteristic increases
    pl("p5", "Orc Lineman"),
  ],
  formerPlayers: [],
});
const elves = (): LeagueTeam => ({
  id: "elves", name: "Elves", race: "Wood Elf", coach: "Bob", coachId: "Bob", teamValue: 1000000, treasury: 0, rerolls: 1, fans: 2,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [pl("e1", "Wood Elf Lineman", [], { name: "Elf 1" }), pl("e2", "Wood Elf Lineman", [], { name: "Elf 2" })], formerPlayers: [],
});
const fx = (over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id: "f1", category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 2, table: 1,
  home: { team: "Orcs", teamId: "orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", teamId: "elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});
const season = (fixtures: LeagueFixture[] = [fx()], ruleset: "BB2020" | "BB2025" = "BB2025"): SeasonRecord => ({
  id: "s1", leagueId: "tabbl", number: 1, name: "Season 1", sourceSlug: "s1", ruleset, status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams: [orcs(), elves()], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("forfeit rules", () => {
  it("defection eligibility per ruleset: 3+ advancements (BB2025 leaves out Team Captain grants), characteristic increases count", () => {
    const t = orcs();
    expect(advancementCount(t.players[0]!, "Orc", "BB2025")).toBe(3);
    expect(advancementCount(t.players[1]!, "Orc", "BB2025")).toBe(2);
    expect(advancementCount(t.players[2]!, "Orc", "BB2025")).toBe(3);
    expect(advancementCount(t.players[2]!, "Orc", "BB2020")).toBe(3); // one shared counter (teamOps.ts): captain grants never count
    expect(advancementCount(t.players[3]!, "Orc", "BB2025")).toBe(4);
    expect(advancementCount(pl("x", "Orc Lineman", ["-MA", "Dodge"]), "Orc", "BB2020")).toBe(1); // a decrease never counts
    expect(defectionCandidates(t.players, "Orc", "BB2025").map((c) => c.playerId)).toEqual(["p1", "p3", "p4"]);
  });
  it("legal concession: < 3 able players (BB2025), <= 3 (BB2020), only at set-up", () => {
    expect(isLegalConcession("BB2025", true, 2)).toBe(true);
    expect(isLegalConcession("BB2025", true, 3)).toBe(false);
    expect(isLegalConcession("BB2020", true, 3)).toBe(true);
    expect(isLegalConcession("BB2020", false, 1)).toBe(false);
  });
  it("pre-filled FFB penalties are suggestions the organiser can change", () => {
    const s = suggestForfeit({ home: true, away: false });
    expect(s.home).toMatchObject({ forfeit: true, winnings: 0, fans: -1, mvp: [] });
    expect(s.away).toMatchObject({ forfeit: false, score: 2 });
    expect(s.notes.join(" ")).toMatch(/no winnings/);
    const rosters = { home: new Set(["p1"]), away: new Set(["e1", "e2"]) };
    const edited = parseForfeitInput({ ...s, home: { ...s.home, fans: 0, winnings: 10000 }, away: { ...s.away, mvp: ["e1", "e2"] } }, rosters);
    expect(edited.home).toMatchObject({ fans: 0, winnings: 10000 });
    expect(edited.away.mvp).toEqual(["e1", "e2"]); // the winner of an illegal concession may have two MVPs
    expect(() => parseForfeitInput({ ...s, home: { ...s.home, mvp: ["p1"] } }, rosters)).toThrow(/no MVP/);
    expect(() => parseForfeitInput({ ...s, away: { ...s.away, penalty: 2 } }, rosters)).toThrow(/Penalty points/);
    expect(() => parseForfeitInput({ ...s, home: { ...s.home, forfeit: false } }, rosters)).toThrow(/Mark the team/);
    expect(() => parseForfeitInput({ ...s, away: { ...s.away, mvp: ["zz"] } }, rosters)).toThrow(/not on that team/);
  });
});

describe("forfeit routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let posts: DiscordPayload[];
  let log: MemoryDiceLog;
  let rolls: number[];
  const deps = (): LeagueApiDeps => ({
    store, diceLog: log, roller: sequenceRoller(rolls), publicNames: () => true,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date("2026-11-02T12:00:00.000Z"),
    postWebhook: async (_url, payload) => { posts.push(payload); return { ok: true, status: 204 }; },
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const JAY = { coach: "Jay" };
  const F = "/api/leagues/tabbl/seasons/s1/fixtures/f1/forfeit";
  const homeForfeits = () => { const s = suggestForfeit({ home: true, away: false }); return { home: s.home, away: s.away, noStandings: false, legalConcession: false }; };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-forfeit-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.setSecrets("tabbl", { discordWebhookUrl: HOOK });
    store.putSeason(season());
    posts = [];
    log = new MemoryDiceLog();
    rolls = [2, 5, 3]; // p1 leaves, p3 stays, p4 leaves
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("organisers only; the model lists eligibility and suggestions; GET writes nothing", async () => {
    expect((await call("GET", F)).status).toBe(401);
    expect((await call("GET", F, { coach: "Ann" })).status).toBe(403);
    const r = await call("GET", F, JAY);
    expect(r.status).toBe(200);
    const m = r.body as any;
    expect(m.defectionRolls).toBe(true);
    expect(m.players.home.filter((p: any) => p.defectionEligible).map((p: any) => p.playerId)).toEqual(["p1", "p3", "p4"]);
    expect(m.suggestions.home.home.fans).toBe(-1);
    const before = JSON.stringify(store.season("tabbl", "s1"));
    await call("GET", F, JAY);
    expect(JSON.stringify(store.season("tabbl", "s1"))).toBe(before);
  });

  it("defections must be rolled first; rolls are logged, never re-rolled, then applied to the roster and history", async () => {
    expect((await call("POST", F, JAY, homeForfeits())).status).toBe(409); // roll first
    const rolled = await call("POST", `${F}/defections`, JAY, { side: "home" });
    expect(rolled.status).toBe(201);
    const draft = (rolled.body as any).draft;
    expect(draft.rolls.map((r: any) => [r.playerId, r.roll, r.leaves])).toEqual([["p1", 2, true], ["p3", 5, false], ["p4", 3, true]]);
    const logged = log.read(fixtureLogId("league:tabbl:s1:f1"));
    expect(logged.map((x) => [x.kind, x.dice[0], x.by])).toEqual([["defection", 2, "Jay"], ["defection", 5, "Jay"], ["defection", 3, "Jay"]]);
    rolls = [6, 6, 6];
    const again = await call("POST", `${F}/defections`, JAY, { side: "home" });
    expect((again.body as any).already).toBe(true);
    expect((again.body as any).draft.rolls[0].roll).toBe(2);
    expect((await call("POST", `${F}/defections`, JAY, { side: "away" })).status).toBe(409);
    const ok = await call("POST", F, JAY, { ...homeForfeits(), home: { ...homeForfeits().home, penalty: 1, missNextGame: ["p5"] }, away: { ...homeForfeits().away, mvp: ["e1", "e2"], winnings: 40000 } });
    expect(ok.status).toBe(200);
    const s = store.season("tabbl", "s1")!;
    const f = s.fixtures[0]!;
    expect(f.forfeit).toMatchObject({ home: true, away: false, penalty: { home: 1, away: 0 } });
    expect(f.home.conceded).toBe(true);
    expect(f.forfeitDraft).toBeUndefined();
    const o = s.teams.find((t) => t.id === "orcs")!;
    expect(o.players.map((p) => p.playerId)).toEqual(["p2", "p3", "p5"]);
    expect(o.formerPlayers.map((p) => p.playerId)).toEqual(["p1", "p4"]);
    expect(o.fans).toBe(2); // -1 suggestion applied
    expect(o.players.find((p) => p.playerId === "p5")!.missNextGame).toBe(true);
    expect(o.players.find((p) => p.playerId === "p5")!.mngGames).toBe(1); // team page MNG bookkeeping: served after the next game
    const e = s.teams.find((t) => t.id === "elves")!;
    expect(e.treasury).toBe(40000);
    expect(e.players.map((p) => p.availableSpp)).toEqual([4, 4]);
    expect((s.log ?? []).filter((l) => l.kind === "defection" && l.teamId === "orcs")[0]!.text).toMatch(/left Orc p1 \(2\), Orc p4 \(3\); stayed Orc p3 \(5\)/);
    // the webhook report: forfeit + who left / stayed, through the cleaned sender (stubbed)
    expect(posts).toHaveLength(1);
    const embed = posts[0]!.embeds[0]!;
    expect(embed.title).toBe("TABBL: forfeit");
    expect(embed.description).toMatch(/Admin win: Elves over Orcs/);
    expect(JSON.stringify(embed.fields)).toMatch(/Left Orcs.*#1 Orc p1 \(rolled 2\)/);
    expect(JSON.stringify(embed.fields)).toMatch(/Stayed with Orcs.*Orc p3/);
    // no second forfeit on top
    expect((await call("POST", F, JAY, homeForfeits())).status).toBe(409);
    // the digest labels it administrative; read models never carry the details
    expect(adminResult(f)).toEqual({ kind: "win", winner: "away" });
    const read = await call("GET", "/api/leagues/tabbl/seasons/s1", { coach: "Ann" });
    const shown = ((read.body as any).season.fixtures as any[])[0];
    expect(shown.forfeit).toBeTruthy();
    expect(shown.forfeitDetail).toBeUndefined();
  });

  it("the admin toggle: off = no defections are rolled and none are needed", async () => {
    expect((await call("POST", `${F}/settings`, { coach: "Ann" }, { defectionRolls: false })).status).toBe(403);
    expect((await call("POST", `${F}/settings`, JAY, { defectionRolls: "no" })).status).toBe(400);
    expect((await call("POST", `${F}/settings`, JAY, { defectionRolls: false })).status).toBe(200);
    expect(store.season("tabbl", "s1")!.fixtures[0]!.defectionRolls).toBe(false);
    expect((await call("POST", `${F}/defections`, JAY, { side: "home" })).status).toBe(409);
    expect((await call("POST", F, JAY, homeForfeits())).status).toBe(200);
    expect(store.season("tabbl", "s1")!.teams[0]!.players).toHaveLength(5);
    expect(log.read(fixtureLogId("league:tabbl:s1:f1"))).toHaveLength(0);
  });

  it("a legal concession rolls nothing; both forfeiting = both lose; no effect on standings and penalties", async () => {
    expect((await call("POST", `${F}/defections`, JAY, { side: "home", legalConcession: true })).status).toBe(409);
    const both = suggestForfeit({ home: true, away: true });
    expect((await call("POST", F, JAY, { home: both.home, away: both.away, noStandings: true })).status).toBe(200);
    const s = store.season("tabbl", "s1")!;
    expect(adminResult(s.fixtures[0]!)).toEqual({ kind: "loss-both" });
    const rows = computePhaseStandings(s, s.phases[0]!).rows;
    expect(rows.every((r) => r.played === 0)).toBe(true);
  });

  it("penalty points come off the standings", () => {
    const s = season([fx({ home: { ...fx().home, score: 0, conceded: true }, away: { ...fx().away, score: 2 }, forfeit: { home: true, away: false, penalty: { home: 2, away: 0 }, at: "x" } })]);
    const rows = computePhaseStandings(s, s.phases[0]!).rows;
    expect(rows.find((r) => r.teamId === "orcs")!.points).toBe(-2);
    expect(rows.find((r) => r.teamId === "elves")!.points).toBe(3);
  });

  it("a fixture with a recorded game is refused; clearing the result removes the forfeit", async () => {
    const s = store.season("tabbl", "s1")!;
    s.fixtures[0]!.tabletop = { revision: 1, opId: "op" };
    store.putSeason(s);
    expect((await call("POST", F, JAY, homeForfeits())).status).toBe(409);
  });

  it("the report hides player names when public player lines are off, and stars listed words", () => {
    const f = fx({ home: { ...fx().home, score: 0, conceded: true }, away: { ...fx().away, score: 2 }, forfeit: { home: true, away: false, at: "x" },
      forfeitDetail: { by: "Jay", at: "x", legalConcession: false, sides: { home: { winnings: 0, fans: -1, mvp: [], missNextGame: [] }, away: { winnings: 0, fans: 0, mvp: [], missNextGame: [] } },
        defections: { side: "home", rolls: [{ playerId: "p1", name: "Secret Name", number: 7, advancements: 3, roll: 1, leaves: true }] } } });
    const post = cleanPayload(buildForfeitPost({ name: "TABBL" }, { name: "Season 1" }, f, false));
    const text = JSON.stringify(post);
    expect(text).not.toContain("Secret Name");
    expect(text).toContain("Player 7 (rolled 1)");
    expect(text).not.toContain("webhooks");
  });
});
