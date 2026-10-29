import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import { eligibleOf, availabilityOf } from "../src/tabletop/eligibility.js";
import { parseEvent, validateEvent, type RosterPair, type TabletopEvent } from "../src/tabletop/events.js";
import { applyPostMatch, tallyMatch, type PlayerKind, type TabletopPlayer, type TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

const player = (id: string, extra: Partial<TabletopPlayer> = {}): TabletopPlayer =>
  ({ id, name: `Name ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false, pa: 4, ...extra });
// Home: h1 Ogre-like thrower, h2 goblin (Right Stuff), h3 plain, h4 Troll (thrower) but injured, h5 goblin (Right Stuff) injured, h6 no-hands, h7 PA "-".
const home = (): TabletopTeamFile => ({
  schema: 1, name: "Home", treasury: 0, dedicatedFans: 1,
  players: [
    player("h1", { skills: ["Throw Team-mate", "Mighty Blow"] }), player("h2", { skills: ["Right Stuff", "Dodge"] }), player("h3"),
    player("h4", { skills: ["Throw Team-mate"], mng: true }), player("h5", { skills: ["Right Stuff"], mng: true }),
    player("h6", { skills: ["No Hands"] }), player("h7", { pa: null, skills: ["Throw Team-mate"] }), player("h8", { skills: ["Right Stuff"], dead: true }),
  ],
});
const away = (): TabletopTeamFile => ({
  schema: 1, name: "Away", treasury: 0, dedicatedFans: 1,
  players: [player("a1", { skills: ["Throw Team-mate"] }), player("a2", { skills: ["Right Stuff"] }), player("a3")],
});
const rosters = (): RosterPair => ({ home: home(), away: away() });

let n = 0;
const ev = (type: string, side: string | undefined, who: string | undefined, payload: Record<string, unknown> = {}): TabletopEvent => {
  n += 1;
  const p = parseEvent({ id: `elg-${String(n).padStart(6, "0")}`, type, team: side, player: who, payload }, "m", "alice", "t");
  if (!p.ok) throw new Error(p.error);
  return p.event;
};
const check = (events: TabletopEvent[], r = rosters()) => {
  const stored: TabletopEvent[] = [];
  for (const e of events) {
    const v = validateEvent(e, stored, r);
    if ("error" in v) return { error: v.error, status: v.status ?? 400, stored };
    stored.push(v.event);
  }
  return { stored } as { stored: TabletopEvent[]; error?: string; status?: number };
};
const ttm = (payload: Record<string, unknown>, side = "home") => ev("throwTeamMate", side, undefined, payload);

describe("Throw Team-mate (superb x landed matrix, skills, SPP)", () => {
  it("superb + landed: thrower earns 1 (the throw counts as a completion), the thrown player 1 for landing safely", () => {
    const { stored, error } = check([ttm({ superb: true, thrower: "h1", landed: true, thrown: "h2" })]);
    expect(error).toBeUndefined();
    const res = applyPostMatch(home(), stored, { team: "home", postMatch: "spp-only", ruleset: "bb2025" });
    expect(Object.fromEntries(res.teamFile.players.map((p) => [p.id, p.spp]))).toMatchObject({ h1: 1, h2: 1, h3: 0 });
    const line = tallyMatch(stored).lines.home;
    expect(line.get("h1")).toMatchObject({ throwTeamMateCompletions: 1, sppEarned: 1 });
    expect(line.get("h2")).toMatchObject({ landings: 1, sppEarned: 1 });
  });

  it("superb but the thrown player did not land: nobody earns anything", () => {
    const { stored, error } = check([ttm({ superb: true, thrower: "h1", landed: false })]);
    expect(error).toBeUndefined();
    const res = applyPostMatch(home(), stored, { team: "home", postMatch: "spp-only", ruleset: "bb2025" });
    expect(res.teamFile.players.every((p) => p.spp === 0)).toBe(true);
    expect(stored[0]!.player).toBe("h1"); // the feed still shows who threw
  });

  it("not superb but landed: only the thrown player earns (landing safely, whatever the throw)", () => {
    const { stored, error } = check([ttm({ superb: false, landed: true, thrown: "h2" })]);
    expect(error).toBeUndefined();
    const res = applyPostMatch(home(), stored, { team: "home", postMatch: "spp-only", ruleset: "bb2025" });
    expect(Object.fromEntries(res.teamFile.players.map((p) => [p.id, p.spp]))).toMatchObject({ h1: 0, h2: 1 });
  });

  it("neither superb nor landed: recorded, no SPP", () => {
    const { stored, error } = check([ttm({ superb: false, landed: false })]);
    expect(error).toBeUndefined();
    expect(stored).toHaveLength(1);
  });

  it("thrower is required iff superb; thrown is required iff landed (400 otherwise); booleans required", () => {
    expect(check([ttm({ superb: true, landed: false })]).error).toMatch(/needs payload.thrower/);
    expect(check([ttm({ superb: false, thrower: "h1", landed: false })]).error).toMatch(/only for a superb/);
    expect(check([ttm({ superb: false, landed: true })]).error).toMatch(/needs payload.thrown/);
    expect(check([ttm({ superb: false, landed: false, thrown: "h2" })]).error).toMatch(/only for a throw that landed/);
    expect(check([ttm({ superb: "yes", landed: false })]).error).toMatch(/booleans/);
    expect(check([ttm({ completed: true })]).status).toBe(400); // the old payload is gone
    expect(check([ttm({ superb: true, thrower: "h1", landed: true, thrown: "h1" })]).error).toMatch(/themselves|Right Stuff/);
  });

  it("wrong skills are refused with 422: thrower needs Throw Team-mate, thrown needs Right Stuff, both on the acting team", () => {
    const noSkillThrower = check([ttm({ superb: true, thrower: "h3", landed: false })]);
    expect(noSkillThrower).toMatchObject({ status: 422 });
    expect(noSkillThrower.error).toMatch(/does not have Throw Team-mate/);
    const noRightStuff = check([ttm({ superb: false, landed: true, thrown: "h3" })]);
    expect(noRightStuff).toMatchObject({ status: 422 });
    expect(noRightStuff.error).toMatch(/does not have Right Stuff/);
    expect(check([ttm({ superb: true, thrower: "a1", landed: false })]).status).toBe(422); // a1 plays for away
    expect(check([ttm({ superb: false, landed: true, thrown: "a2" })]).status).toBe(422);
    expect(check([ttm({ superb: true, thrower: "a1", landed: true, thrown: "a2" }, "away")]).error).toBeUndefined();
  });

  it("an unavailable thrower or thrown player is refused with 422", () => {
    expect(check([ttm({ superb: true, thrower: "h4", landed: false })])).toMatchObject({ status: 422 }); // injured (MNG)
    expect(check([ttm({ superb: false, landed: true, thrown: "h5" })])).toMatchObject({ status: 422 });
    expect(check([ttm({ superb: false, landed: true, thrown: "h8" })])).toMatchObject({ status: 422 }); // dead
  });
});

describe("availability: 422 with a reason on every player-credited event", () => {
  it("MNG, dead, not on the roster, killed earlier, sent off", () => {
    for (const type of ["touchdown", "completion", "catch", "interception", "deflection", "foul", "stalling", "mvp"]) {
      for (const who of ["h4", "h8", "a1"]) expect(check([ev(type, "home", who)])).toMatchObject({ status: 422 });
    }
    expect(check([ev("injury", "home", "h4", { result: "KO" })]).status).toBe(422);
    expect(check([ev("casualty", "home", "h4", { victim: "a1", result: "BH" })]).status).toBe(422); // inflictor MNG
    expect(check([ev("casualty", "home", "h1", { victim: "a1", result: "BH" }), ev("touchdown", "home", "h1")]).error).toBeUndefined();
    expect(check([ev("casualty", "away", "a1", { victim: "h1", result: "DEAD" }), ev("touchdown", "home", "h1")])).toMatchObject({ status: 422 });
    expect(check([ev("sendOff", "home", "h1"), ev("catch", "home", "h1")])).toMatchObject({ status: 422 });
    expect(check([ev("touchdown", "home", "h1")]).error).toBeUndefined();
    expect(check([ev("touchdown", "home", "h1", {}, )]).status).toBeUndefined();
  });

  it("availability and eligibility flags are computed from skills and state", () => {
    const h = home().players;
    const flags = (id: string) => {
      const p = h.find((x) => x.id === id)!;
      return eligibleOf(p, availabilityOf("home", p, []).available);
    };
    expect(flags("h1")).toMatchObject({ throwTeamMate: true, rightStuff: false, pass: true, catch: true, intercept: true, foul: true, touchdown: true });
    expect(flags("h2")).toMatchObject({ throwTeamMate: false, rightStuff: true });
    expect(flags("h6")).toMatchObject({ catch: false, intercept: false, deflect: false, pass: true });
    expect(flags("h7")).toMatchObject({ pass: false, throwTeamMate: false, completion: false, catch: true }); // no Passing Ability
    expect(flags("h4")).toMatchObject({ throwTeamMate: false, touchdown: false, foul: false, mvp: false }); // unavailable: nothing
    expect(availabilityOf("home", h.find((x) => x.id === "h4")!, [])).toEqual({ available: false, unavailableReason: "Missing this game (injured last match)" });
    expect(availabilityOf("home", h.find((x) => x.id === "h8")!, [])).toEqual({ available: false, unavailableReason: "Dead" });
  });
});

// ---- over the API ------------------------------------------------------------------------------------------
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
const files: Record<string, TabletopTeamFile> = {};
const deps = (): TabletopApiDeps => ({
  repo, results,
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: () => false,
  drawSeats: () => false, isOrganizer: (c) => c === "Org",
  now: () => new Date("2026-03-01T10:00:00.000Z"),
  rollDie: () => 1,
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams()))!;
let eid = 0;
const E = (type: string, team_: string | undefined, player?: string, payload: Record<string, unknown> = {}) => { eid += 1; return { id: `api-elg-${String(eid).padStart(6, "0")}`, type, team: team_, player, payload }; };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-eligibility-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  const a = home();
  a.players = [
    ...a.players,
    player("h9", { kind: "star" as PlayerKind, name: "Star Guy" }), player("h10", { kind: "mercenary" as PlayerKind }), player("h11", { kind: "journeyman" as PlayerKind, journeyman: true }),
  ];
  files["Alice/sv_a"] = a;
  files["Bob/sv_b"] = away();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("over the API", () => {
  async function playing(): Promise<string> {
    const r = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    return (r.body as { match: { id: string } }).match.id;
  }
  const post = (id: string, ...events: unknown[]) => as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events });

  it("an unavailable or off-roster player is refused with 422 and the reason; nothing is recorded", async () => {
    const id = await playing();
    const r = await post(id, E("touchdown", "home", "h4"));
    expect(r.status).toBe(422);
    expect((r.body as { error: string }).error).toMatch(/missing the next game/);
    expect((await post(id, E("touchdown", "home", "a1"))).status).toBe(422);
    expect((await post(id, E("touchdown", "home", "ghost"))).status).toBe(422);
    expect((await post(id, E("touchdown", "home"))).status).toBe(400); // malformed, not an eligibility problem
    expect(((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ type: string }> }).events.filter((e) => e.type !== "seats")).toHaveLength(0);
  });

  it("the match GET exposes kind, available, unavailableReason and eligible per player", async () => {
    const id = await playing();
    await as("Bob", "POST", `/api/tabletop/matches/${id}/events`, { events: [E("casualty", "away", "a3", { victim: "h3", result: "DEAD" })] }); // the away coach records their own casualty
    await post(id, E("sendOff", "home", "h6"));
    const g = (await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { teams: { home: { players: any[] } } };
    const by = Object.fromEntries(g.teams.home.players.map((p) => [p.id, p]));
    expect(by.h1).toMatchObject({ kind: "rostered", available: true, eligible: { throwTeamMate: true, pass: true, catch: true } });
    expect(by.h2.eligible).toMatchObject({ rightStuff: true, throwTeamMate: false });
    expect(by.h4).toMatchObject({ available: false, unavailableReason: "Missing this game (injured last match)", eligible: { touchdown: false } });
    expect(by.h8).toMatchObject({ available: false, unavailableReason: "Dead" });
    expect(by.h3).toMatchObject({ available: false, unavailableReason: "Killed in this match" });
    expect(by.h6).toMatchObject({ available: false, unavailableReason: "Sent off" });
    expect(by.h9.kind).toBe("star");
    expect(by.h10.kind).toBe("mercenary");
    expect(by.h11.kind).toBe("journeyman");
  });

  it("a Star Player TD scores for the team but earns 0 SPP; a journeyman TD earns 3; a mercenary earns none", async () => {
    const id = await playing();
    const star = E("touchdown", "home", "h9");
    const jm = E("touchdown", "home", "h11");
    const merc = E("touchdown", "home", "h10");
    const plain = E("touchdown", "home", "h1");
    const posted = (await post(id, star, jm, merc, plain)).body as { tally: any };
    expect(posted.tally.score).toEqual({ home: 4, away: 0 });
    const spp = Object.fromEntries(posted.tally.events.map((e: any) => [e.id, e.sppEarned]));
    expect(spp).toEqual({ "pg-seats": 0, [star.id]: 0, [jm.id]: 3, [merc.id]: 0, [plain.id]: 3 }); // the seat draw row earns nothing
    const lines = Object.fromEntries(posted.tally.players.home.map((l: any) => [l.id, l]));
    expect(lines.h9).toMatchObject({ touchdowns: 1, sppEarned: 0 });
    expect(lines.h11).toMatchObject({ touchdowns: 1, sppEarned: 3 });
    expect(lines.h10.sppEarned).toBe(0);
    // the stored team file after confirm: the star and the mercenary gained nothing
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    const chain = (await repo.getChain("Alice", "sv_a"))!;
    const after = chain.revisions.at(-1)!.teamFile.players;
    expect(after.find((p) => p.id === "h9")!.spp).toBe(0);
    expect(after.find((p) => p.id === "h10")!.spp).toBe(0);
    expect(after.find((p) => p.id === "h11")!.spp).toBe(3);
  });

  it("the feed credits a Throw Team-mate with who threw whom and what each earned", async () => {
    const id = await playing();
    const t = E("throwTeamMate", "home", undefined, { superb: true, thrower: "h1", landed: true, thrown: "h2" });
    const posted = (await post(id, t)).body as { tally: { events: Array<{ id: string; sppEarned: number; credits: Array<{ player: string; spp: number }>; text: string }> } };
    const row = posted.tally.events.find((e) => e.id === t.id)!;
    expect(row.sppEarned).toBe(2);
    expect(row.credits).toEqual([{ player: "h1", spp: 1 }, { player: "h2", spp: 1 }]);
    expect(row.text).toBe("Name h1 throws Name h2 - superb pass, lands safely");
    const wrong = await post(id, E("throwTeamMate", "home", undefined, { superb: true, thrower: "h3", landed: false }));
    expect(wrong.status).toBe(422);
  });
});
