import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { upsertLibraryTeam, type LibraryTeam } from "@bb/fork-ops";
import { withoutCaptainGrants } from "@bb/validator";
import { appointedSkills, captainGrantsFor, nextCaptainVacancy, withoutRecordedCaptainGrants, xmlCaptainVacant } from "../src/captain.js";
import { playerProgression } from "../src/teamAdvancement.js";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api.js";
import { leagueTeamCaptainVacant, markCaptainVacancy } from "../src/leagues/captain.js";
import { appointLeagueCaptain, eligibleCaptainIds, leagueCaptainIneligibility } from "../src/leagues/captainApi.js";
import { mutateLeagueTeam } from "../src/leagues/forkResult.js";
import { buildDraftTeam, type DraftContext, type DraftPrice } from "../src/leagues/redraft.js";
import { LeagueStore } from "../src/leagues/store.js";
import type { LeaguePlayer, LeagueTeam, SeasonRecord } from "../src/leagues/types.js";
import { parseFumbblResult } from "../src/site-backend/fumbblResult.js";
import { buildBankTasks } from "../src/site-backend/fumbblResultBanking.js";
import { parseEvent, validateEvent, type TabletopEvent } from "../src/tabletop/events.js";
import { applyPostMatch, teamFileCaptainVacant, type TabletopPlayer, type TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { storedTeamHasHistory, teamDetailEndpoint } from "../src/teamDetail.js";
import { libraryManageView } from "../src/teamManageView.js";
import { teamMutationEndpoint, type TeamMutationDeps } from "../src/teamMutation.js";

// Team Captain replacement in league play (owner ruling 10-30, spec-main-landing-nav-2026-10-29 §8; rules anchor
// https://bloodbowlbase.ru/bb2025/core_rules/the_teams/#team-captain): the vacancy is set by every path that removes the
// captain and cleared by an appointment; eligibility = roster player, not a Big Guy, not a Star; the new captain gains
// Team Captain + Pro free (no second Pro when already owned); the old captain's grants stay on the departed record.

const stats = { td: 0, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 0, performance: 0 };
const lp = (playerId: string, position: string, skills: string[] = [], over: Partial<LeaguePlayer> = {}): LeaguePlayer => ({
  playerId, number: Number(playerId.replace(/\D/g, "")) || null, name: `Name ${playerId}`, position, ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills,
  value: 50_000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats: { ...stats }, ...over,
});
const humans = (over: Partial<LeagueTeam> = {}): LeagueTeam => ({
  id: "humans", name: "Reikland Reavers", race: "Human", coach: "Bob", coachId: "Bob", teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "",
  players: [
    lp("p1", "Blitzer", ["Block", "Team Captain", "Pro"]),
    lp("p2", "Lineman"),
    lp("p3", "Ogre", ["Bone Head", "Mighty Blow", "Thick Skull", "Throw Team-mate"]),
    lp("p4", "Thrower", ["Sure Hands", "Pass", "Pro"]),
    lp("p5", "Griff Oberwald", ["Block", "Dodge"]),
  ],
  formerPlayers: [],
  ...over,
});
const vacantHumans = (): LeagueTeam => {
  const t = humans();
  t.players = t.players.filter((p) => p.playerId !== "p1");
  t.captainVacant = true;
  return t;
};

describe("captain helpers", () => {
  it("appointedSkills adds Team Captain + Pro, and only the trait when Pro is already owned (no double Pro)", () => {
    expect(appointedSkills(["Block"])).toEqual(["Block", "Team Captain", "Pro"]);
    expect(appointedSkills(["Pass", "Pro"])).toEqual(["Pass", "Pro", "Team Captain"]);
    // The free grants are RECORDED (captainGrantsFor), so an owned Pro stays an earned skill whatever the list order.
    expect(captainGrantsFor(["Pass", "Pro"])).toEqual(["Team Captain"]);
    expect(withoutRecordedCaptainGrants(appointedSkills(["Pass", "Pro"]), captainGrantsFor(["Pass", "Pro"]))).toEqual(["Pass", "Pro"]);
    expect(withoutRecordedCaptainGrants(appointedSkills(["Block"]), captainGrantsFor(["Block"]))).toEqual(["Block"]);
  });
  it("existing data without a record keeps the old reading: the trait and one Pro are free, in any order", () => {
    expect(withoutRecordedCaptainGrants(["Pro", "Team Captain", "Block"], undefined)).toEqual(["Block"]);
    expect(withoutCaptainGrants(["Pro", "Team Captain"])).toEqual([]);
  });
  it("nextCaptainVacancy: by player id; missing skill data is no departure; the prior state stands otherwise", () => {
    const cap = [{ ids: ["c"], skills: ["Team Captain", "Pro"] }];
    expect(nextCaptainVacancy(cap, [{ ids: ["x"], skills: [] }], false)).toBe(true);
    expect(nextCaptainVacancy(cap, [{ ids: ["c"], skills: [] }], false)).toBe(false); // re-import without skills, same player
    expect(nextCaptainVacancy([{ ids: ["x"], skills: [] }], cap, true)).toBe(false);
    expect(nextCaptainVacancy([{ ids: ["x"], skills: [] }], [{ ids: ["x"], skills: [] }], true)).toBe(true);
    expect(nextCaptainVacancy(undefined, [{ ids: ["x"], skills: [] }], false)).toBe(false);
  });
});

describe("league: vacancy set by every roster path", () => {
  it("death via fork result banking: vacant, the dead captain keeps Team Captain + Pro on the former-player record", () => {
    const before = humans();
    const result = {
      teamId: "fork-1", score: 0, conceded: false, winnings: 0,
      players: [{ forkPlayerId: "f1", name: "Name p1", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, earnedSpps: 0, injuries: ["Dead (RIP)"] }],
    };
    const m = mutateLeagueTeam(before, result, [{ forkPlayerId: "f1", playerId: "p1" }], "full");
    expect(m.retired).toEqual(["p1"]);
    expect(m.team.captainVacant).toBe(true);
    expect(leagueTeamCaptainVacant(m.team)).toBe(true);
    expect(m.team.formerPlayers.find((p) => p.playerId === "p1")?.skills).toEqual(["Block", "Team Captain", "Pro"]);
    expect(before.captainVacant).toBeUndefined(); // the input is not changed
  });
  it("a non-captain death leaves the captaincy alone", () => {
    const result = {
      teamId: "fork-1", score: 0, conceded: false, winnings: 0,
      players: [{ forkPlayerId: "f2", name: "Name p2", td: 0, cas: 0, completions: 0, interceptions: 0, mvp: 0, fouls: 0, injuries: ["Dead (RIP)"] }],
    };
    expect(mutateLeagueTeam(humans(), result, [{ forkPlayerId: "f2", playerId: "p2" }], "full").team.captainVacant).toBeUndefined();
  });
  it("redraft that does not re-hire the captain: vacant; re-hiring the captain keeps the trait and no vacancy", () => {
    const team = humans();
    const ctx = { task: {} as DraftContext["task"], source: {} as SeasonRecord, team, roster: undefined, teamPlayed: true } as DraftContext;
    const keep = (ids: string[]): DraftPrice => ({
      keep: ids.map((playerId) => ({ quote: { playerId, value: 50_000, seasons: 1, cost: 50_000 } as DraftPrice["keep"][number]["quote"] })),
      hires: [], staffCost: 0, spent: 0, remaining: 0, players: ids.length,
    });
    const input = { keep: [], hires: [], staff: { rerolls: 2, assistantCoaches: 0, cheerleaders: 0, apothecary: false } } as unknown as Parameters<typeof buildDraftTeam>[2];
    const dropped = buildDraftTeam(ctx, keep(["p2", "p4"]), input, { leagueId: "l", slug: "s2" }, new Set());
    expect(dropped.captainVacant).toBe(true);
    const kept = buildDraftTeam(ctx, keep(["p1", "p2"]), input, { leagueId: "l", slug: "s2" }, new Set());
    expect(kept.captainVacant).toBeUndefined();
    expect(kept.players.find((p) => p.name === "Name p1")?.skills).toContain("Team Captain");
  });
  it("a re-import that omits the captain's skills is no departure; a re-import without the flag keeps an existing vacancy", () => {
    const reimport = humans();
    reimport.players = reimport.players.map((p) => ({ ...p, skills: [] }));
    markCaptainVacancy(humans(), reimport);
    expect(reimport.captainVacant).toBeUndefined();
    const fresh = humans({ players: [lp("p2", "Lineman")] }); // no flag, no captain
    markCaptainVacancy(vacantHumans(), fresh);
    expect(fresh.captainVacant).toBe(true);
    const appointed = humans({ players: [lp("p2", "Lineman", ["Team Captain", "Pro"])] });
    markCaptainVacancy(vacantHumans(), appointed);
    expect(appointed.captainVacant).toBeUndefined();
  });
  it("the captain's player id persists across a skill-omitting re-import, so his later departure is still a vacancy", () => {
    const stored = humans();
    markCaptainVacancy(undefined, stored);
    expect(stored.captainPlayerId).toBe("p1");
    const reimport = humans({ captainPlayerId: undefined });
    reimport.players = reimport.players.map((p) => ({ ...p, skills: p.skills.filter((s) => s !== "Team Captain" && s !== "Pro") }));
    delete reimport.captainPlayerId;
    markCaptainVacancy(stored, reimport);
    expect(reimport.captainPlayerId).toBe("p1");
    expect(reimport.captainVacant).toBeUndefined();
    const afterDeath = structuredClone(reimport);
    afterDeath.players = afterDeath.players.filter((p) => p.playerId !== "p1");
    markCaptainVacancy(reimport, afterDeath);
    expect(afterDeath.captainVacant).toBe(true);
    expect(afterDeath.captainPlayerId).toBeUndefined();
    // a redraft successor (fresh id, previousIds) keeps the identity
    const drafted = structuredClone(reimport);
    drafted.players = drafted.players.map((p) => (p.playerId === "p1" ? { ...p, playerId: "p1-next", previousIds: ["p1"] } : p));
    markCaptainVacancy(reimport, drafted);
    expect(drafted.captainPlayerId).toBe("p1-next");
    expect(drafted.captainVacant).toBeUndefined();
  });
  it("an appointment persists the new captain's player id", () => {
    const t = vacantHumans();
    appointLeagueCaptain(t, "p2");
    expect(t.captainPlayerId).toBe("p2");
  });
  it("any other roster write (the store's season write) that drops the captain sets it; a team with no captain before stays clear", () => {
    const t = humans();
    markCaptainVacancy(humans(), t);
    expect(t.captainVacant).toBeUndefined();
    const fired = humans();
    fired.players = fired.players.filter((p) => p.playerId !== "p1");
    markCaptainVacancy(humans(), fired);
    expect(fired.captainVacant).toBe(true);
    const never = humans({ players: [lp("p2", "Lineman")] });
    markCaptainVacancy(humans({ players: [lp("p2", "Lineman")] }), never);
    expect(never.captainVacant).toBeUndefined();
  });
});

describe("league: eligibility and appointment", () => {
  it("rejects a Big Guy, a Star, a non-roster player, and a team with a captain; per-race data decides", () => {
    const t = vacantHumans();
    expect(leagueCaptainIneligibility(t, t.players.find((p) => p.playerId === "p3")!)).toMatch(/Big Guy/);
    expect(leagueCaptainIneligibility(t, t.players.find((p) => p.playerId === "p5")!)).toMatch(/Star Player/);
    expect(eligibleCaptainIds(t)).toEqual(["p2", "p4"]);
    expect(appointLeagueCaptain(t, "p3")).toMatchObject({ ok: false, status: 400 });
    expect(appointLeagueCaptain(t, "p5")).toMatchObject({ ok: false, status: 400 });
    expect(appointLeagueCaptain(t, "nobody")).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/not on this team/) });
    expect(appointLeagueCaptain(humans(), "p2")).toMatchObject({ ok: false, status: 409 });
    expect(appointLeagueCaptain(humans({ players: [lp("p2", "Lineman")] }), "p2")).toMatchObject({ ok: false, status: 409 }); // never vacant
    const elves = { ...vacantHumans(), race: "Wood Elf" };
    expect(leagueCaptainIneligibility(elves, lp("x", "Wardancer"))).toMatch(/no Team Captain/);
  });
  it("appointment adds Team Captain + Pro, keeps the value, clears the vacancy; an owned Pro is not doubled", () => {
    const t = vacantHumans();
    const done = appointLeagueCaptain(t, "p2");
    expect(done.ok).toBe(true);
    expect(t.players.find((p) => p.playerId === "p2")!.skills).toEqual(["Team Captain", "Pro"]);
    expect(t.players.find((p) => p.playerId === "p2")!.captainGrants).toEqual(["Team Captain", "Pro"]);
    expect(t.players.find((p) => p.playerId === "p2")!.value).toBe(50_000);
    expect(t.captainVacant).toBeUndefined();
    const u = vacantHumans();
    appointLeagueCaptain(u, "p4");
    expect(u.players.find((p) => p.playerId === "p4")!.skills).toEqual(["Sure Hands", "Pass", "Pro", "Team Captain"]);
    expect(u.players.find((p) => p.playerId === "p4")!.captainGrants).toEqual(["Team Captain"]);
  });
});

describe("league route POST .../teams/:teamId/captain", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  const deps = (): LeagueApiDeps => ({ store, now: () => new Date("2026-11-01T12:00:00Z"), readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)) });
  const season = (): SeasonRecord => ({
    id: "season-1", leagueId: "lg", number: 1, name: "Season 1", sourceSlug: "s1", ruleset: "BB2025", status: "active",
    phases: [], fixtures: [], teams: [humans(), { ...humans(), id: "other", name: "Other", coach: "Eve", coachId: "Eve" }], participants: [], honours: [], awards: [], unattributedStats: [],
    importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
  });
  const path = "/api/leagues/lg/seasons/season-1/teams/humans/captain";
  const rev = (): number => store.season("lg", "season-1")!.revision ?? 0;
  const call = async (auth: { coach: string; admin: boolean } | undefined, b?: unknown, method = "POST"): Promise<LeagueApiResult> => {
    body = b;
    return (await leagueApi(method, path, new URLSearchParams(), auth, deps()))!;
  };
  const killCaptain = (): void => {
    const s = store.season("lg", "season-1")!;
    s.teams[0]!.players = s.teams[0]!.players.filter((p) => p.playerId !== "p1");
    store.putSeason(s); // the store's write marks the vacancy (leagues/captain.ts)
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-captain-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "lg", name: "LG", fullName: "LG", slug: "lg", organisers: ["Jay"] });
    store.putSeason(season());
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("the store's season write marks the vacancy and the season read carries the eligible ids", async () => {
    killCaptain();
    expect(store.season("lg", "season-1")!.teams[0]!.captainVacant).toBe(true);
    expect(store.season("lg", "season-1")!.teams[1]!.captainVacant).toBeUndefined();
    const read = await leagueApi("GET", "/api/leagues/lg/seasons/season-1", new URLSearchParams(), undefined, deps());
    const team = (read!.body as { season: SeasonRecord }).season.teams[0] as LeagueTeam & { captainEligible?: string[] };
    expect(team.captainEligible).toEqual(["p2", "p4"]);
    expect(((read!.body as { season: SeasonRecord }).season.teams[1] as { captainEligible?: string[] }).captainEligible).toBeUndefined();
  });
  it("auth: anonymous 401, another coach 403, the team's coach / organiser / admin may appoint; revision 428 / 409", async () => {
    killCaptain();
    expect((await call(undefined, { revision: rev(), playerId: "p2" })).status).toBe(401);
    expect((await call({ coach: "Eve", admin: false }, { revision: rev(), playerId: "p2" })).status).toBe(403);
    expect((await call({ coach: "Bob", admin: false }, { playerId: "p2" })).status).toBe(428);
    expect((await call({ coach: "Bob", admin: false }, { revision: rev() + 3, playerId: "p2" })).status).toBe(409);
    expect((await call({ coach: "Bob", admin: false }, { revision: rev(), playerId: "p3" })).status).toBe(400);
    expect((await call({ coach: "Bob", admin: false }, { revision: rev() }, "PUT")).status).toBe(405);
    const ok = await call({ coach: "bob", admin: false }, { revision: rev(), playerId: "p2" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, playerId: "p2", skills: ["Team Captain", "Pro"] });
    const after = store.season("lg", "season-1")!.teams[0]!;
    expect(after.captainVacant).toBeUndefined();
    expect((await call({ coach: "Bob", admin: false }, { revision: rev(), playerId: "p4" })).status).toBe(409); // already has one
  });
  it("an organiser and a site admin may appoint for the team", async () => {
    killCaptain();
    expect((await call({ coach: "Jay", admin: false }, { revision: rev(), playerId: "p4" })).status).toBe(200);
    killCaptain(); // p1 is gone already: drop the new captain too
    const s = store.season("lg", "season-1")!;
    s.teams[0]!.players = s.teams[0]!.players.filter((p) => p.playerId !== "p4");
    store.putSeason(s);
    expect((await call({ coach: "Root", admin: true }, { revision: rev(), playerId: "p2" })).status).toBe(200);
  });
});

describe("tabletop result banking", () => {
  const player = (id: string, extra: Partial<TabletopPlayer> = {}): TabletopPlayer => ({ id, name: `Name ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false, ...extra });
  const file = (players: TabletopPlayer[]): TabletopTeamFile => ({ schema: 1, name: "T", treasury: 0, dedicatedFans: 1, players });
  let n = 0;
  const ev = (type: string, side: "home" | "away", who: string | undefined, payload: Record<string, unknown> = {}): TabletopEvent => {
    n += 1;
    const p = parseEvent({ id: `evt-${String(n).padStart(6, "0")}`, type, team: side, player: who, payload }, "m1", "alice", "2026-01-01T00:00:00.000Z");
    if (!p.ok) throw new Error(p.error);
    return p.event;
  };
  it("a Team Captain killed in the match leaves the team file vacant; the dead player keeps the trait + Pro", () => {
    const home = file([player("h1", { skills: ["Team Captain", "Pro"] }), player("h2")]);
    const away = file([player("a1"), player("a2")]);
    const cas = ev("casualty", "away", "a1", { victim: "h1", result: "DEAD" });
    const v = validateEvent(cas, [], { home, away });
    if ("error" in v) throw new Error(v.error);
    const out = applyPostMatch(home, [v.event], { team: "home", postMatch: "spp-only", ruleset: "bb2025", matchId: "m1" }).teamFile;
    expect(out.captainVacant).toBe(true);
    expect(teamFileCaptainVacant(out)).toBe(true);
    expect(out.players.find((p) => p.id === "h1")).toMatchObject({ dead: true, skills: ["Team Captain", "Pro"] });
    // a match without the captain's death changes nothing
    expect(applyPostMatch(home, [], { team: "home", postMatch: "spp-only", ruleset: "bb2025" }).teamFile.captainVacant).toBeUndefined();
  });
});

// ---- fork library teams (team management + the fork's result banking) ----

const ROSTER = `<roster id="human"><name>Human</name><specialRules><rule>Team Captain</rule></specialRules>
<position id="line"><name>Human Lineman</name><type>Regular</type><quantity>16</quantity><cost>50000</cost><movement>6</movement><strength>3</strength><agility>3</agility><passing>4</passing><armour>9</armour><skillList/><skillCategoryList><normal>General</normal></skillCategoryList></position>
<position id="ogre"><name>Ogre</name><type>Big Guy</type><quantity>1</quantity><cost>140000</cost><movement>5</movement><strength>5</strength><agility>4</agility><passing>5</passing><armour>10</armour><skillList/><skillCategoryList><normal>Strength</normal></skillCategoryList></position>
<position id="star"><name>Griff Oberwald</name><type>Star</type><quantity>1</quantity><cost>280000</cost><movement>7</movement><strength>4</strength><agility>2</agility><passing>3</passing><armour>9</armour><skillList/><skillCategoryList/></position>
</roster>`;
const pl = (id: string, nr: number, pos: string, skills: string[] = [], status = "Active") =>
  `<player status="${status}" nr="${nr}" id="${id}"><name>P ${id}</name><positionId>${pos}</positionId><playerStatistics currentSpps="0"><games>3</games></playerStatistics><skillList>${skills.map((s) => `<skill>${s}</skill>`).join("")}</skillList><injuryList/></player>`;
const TEAM = `<team id="42" status="1"><coach>Tarkin</coach><name>Captained Humans</name><race>Human</race><rosterId>human</rosterId>
<treasury>100000</treasury><teamRating>100</teamRating><currentTeamValue>100</currentTeamValue><teamStrength>100</teamStrength>
${pl("p1", 1, "line", ["Team Captain", "Pro"])}${pl("p2", 2, "line")}${pl("p3", 3, "ogre")}${pl("p4", 4, "line", ["Pro"])}${pl("p5", 5, "star")}${pl("p6", 6, "line", [], "journeyman")}
</team>`;
const STORED: LibraryTeam = { teamId: "42", teamName: "Captained Humans", race: "Human", coach: "Tarkin", teamValue: 1000, gold: 100_000, forkLoadable: true, ingestedAt: "2026-08-01T00:00:00.000Z" };

describe("library team: fire / retire, appoint, re-hire", () => {
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
  const setup = (teamXml = TEAM): { deps: TeamMutationDeps; teamFile: string } => {
    const root = mkdtempSync(join(tmpdir(), "captain-library-"));
    roots.push(root);
    const libraryDir = join(root, "library");
    const teamsDir = join(root, "teams");
    mkdirSync(teamsDir, { recursive: true });
    mkdirSync(join(root, "rosters"), { recursive: true });
    const teamFile = join(teamsDir, "team_Tarkin_42.xml");
    writeFileSync(teamFile, teamXml, "utf8");
    writeFileSync(join(root, "rosters", "roster_team_42.xml"), ROSTER, "utf8");
    upsertLibraryTeam(libraryDir, "Tarkin", STORED);
    return { teamFile, deps: { libraryDir, teamsDir, reload: async () => ({ reloaded: true, method: "refresh", teams: 1, rosters: 1 }), duplicateNameError: () => undefined } };
  };
  const auth = { coach: "Tarkin", admin: false };

  it("firing (and retiring) the captain makes the captaincy vacant; the fired record keeps Team Captain + Pro", async () => {
    for (const op of ["firePlayer", "retirePlayer"] as const) {
      const { deps, teamFile } = setup();
      expect(xmlCaptainVacant(readFileSync(teamFile, "utf8"))).toBe(false);
      expect((await teamMutationEndpoint(auth, op, { teamId: "42", playerId: "p1" }, deps)).status).toBe(200);
      const xml = readFileSync(teamFile, "utf8");
      expect(xmlCaptainVacant(xml)).toBe(true);
      expect(xml).toMatch(/<firedPlayer reason="[a-z]+"[^>]*id="p1"[\s\S]*?<skill>Team Captain<\/skill><skill>Pro<\/skill>[\s\S]*?<\/firedPlayer>/);
    }
  });
  it("the team management view offers only eligible players; appointing rejects Big Guy / Star / journeyman / unknown, then adds the grants at no cost", async () => {
    const { deps, teamFile } = setup();
    await teamMutationEndpoint(auth, "firePlayer", { teamId: "42", playerId: "p1" }, deps);
    const detail = await teamDetailEndpoint({ coach: "Tarkin", organizer: false }, "42", { libraryDir: deps.libraryDir, teamsDir: deps.teamsDir });
    if (detail.status !== 200) throw new Error("detail failed");
    expect(detail.body.team.captainVacant).toBe(true);
    const view = libraryManageView({ coach: "Tarkin", detail: detail.body.team, stored: STORED, rosterXml: ROSTER, publicDir: join(deps.libraryDir, "none") });
    expect(view.manage.captain).toEqual({ vacant: true, eligible: ["p2", "p4"] });
    const appoint = (playerId: string) => teamMutationEndpoint(auth, "appointCaptain", { teamId: "42", playerId }, deps);
    expect(await appoint("p3")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Big Guy/) } });
    expect(await appoint("p5")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/Star/) } });
    expect(await appoint("p6")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/journeyman/) } });
    expect(await appoint("p1")).toMatchObject({ status: 400 }); // fired: not on the roster
    const before = readFileSync(teamFile, "utf8");
    const ok = await appoint("p2");
    expect(ok).toMatchObject({ status: 200, body: { skills: ["Team Captain", "Pro"] } });
    const xml = readFileSync(teamFile, "utf8");
    expect(xml).toMatch(/id="p2"[^>]*>[\s\S]*?<skillList><skill>Team Captain<\/skill><skill>Pro<\/skill><\/skillList>/);
    expect(xmlCaptainVacant(xml)).toBe(false);
    for (const tag of ["treasury", "teamRating", "currentTeamValue", "teamStrength"]) expect(xml.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))?.[1]).toBe(before.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))?.[1]);
    expect(await appoint("p4")).toMatchObject({ status: 409 });
    // Another coach cannot appoint on this team.
    expect((await teamMutationEndpoint({ coach: "Eve", admin: false }, "appointCaptain", { teamId: "42", playerId: "p4" }, deps)).status).toBe(404);
  });
  it("an already-Pro player gains only the trait; a team that never lost its captain cannot appoint", async () => {
    const { deps, teamFile } = setup();
    expect((await teamMutationEndpoint(auth, "appointCaptain", { teamId: "42", playerId: "p2" }, deps)).status).toBe(409);
    await teamMutationEndpoint(auth, "firePlayer", { teamId: "42", playerId: "p1" }, deps);
    expect((await teamMutationEndpoint(auth, "appointCaptain", { teamId: "42", playerId: "p4" }, deps)).status).toBe(200);
    const xml = readFileSync(teamFile, "utf8");
    expect(xml).toMatch(/id="p4"[^>]*>[\s\S]*?<skillList><skill>Pro<\/skill><skill>Team Captain<\/skill><\/skillList>[\s\S]*?<captainGrants>Team Captain<\/captainGrants><\/player>/);
    // The recorded grant keeps the owned Pro valued (20k) and counted as an advancement.
    const p4 = xml.match(/<player\b[^>]*id="p4"[\s\S]*?<\/player>/)![0];
    expect(playerProgression(p4, ROSTER).currentValue).toBe(70_000);
    expect(playerProgression(p4, ROSTER).advancements).toBe(1);
  });
  it("a recorded appointment (<captainGrants>) counts as history, so whole-roster recomposition cannot reprice an earned Pro", () => {
    const appointed = `<team id="1"><player nr="1" id="a"><skillList><skill>Pro</skill><skill>Team Captain</skill></skillList><captainGrants>Team Captain</captainGrants></player></team>`;
    expect(storedTeamHasHistory(appointed)).toBe(true);
    expect(storedTeamHasHistory(appointed.replace("<captainGrants>Team Captain</captainGrants>", "").replace("<skill>Pro</skill><skill>Team Captain</skill>", "<skill>Team Captain</skill><skill>Pro</skill>"))).toBe(false); // draft grants only
  });
  it("a dead player still stored in the XML never counts as an existing captain", async () => {
    const dead = TEAM.replace(pl("p1", 1, "line", ["Team Captain", "Pro"]), pl("p1", 1, "line", ["Team Captain", "Pro"], "Dead"));
    const { deps, teamFile } = setup(dead);
    expect(xmlCaptainVacant(dead)).toBe(true);
    expect(await teamMutationEndpoint(auth, "appointCaptain", { teamId: "42", playerId: "p2" }, deps)).toMatchObject({ status: 200 });
    const xml = readFileSync(teamFile, "utf8");
    expect(xml).toMatch(/id="p2"[^>]*>[\s\S]*?<captainGrants>Team Captain\|Pro<\/captainGrants>/);
    expect(xmlCaptainVacant(xml)).toBe(false);
  });
  it("re-hiring the old captain while another player is captain brings him back without Team Captain and its Pro", async () => {
    const { deps, teamFile } = setup();
    await teamMutationEndpoint(auth, "firePlayer", { teamId: "42", playerId: "p1" }, deps);
    await teamMutationEndpoint(auth, "appointCaptain", { teamId: "42", playerId: "p2" }, deps);
    expect((await teamMutationEndpoint(auth, "rehirePlayer", { teamId: "42", playerId: "p1" }, deps)).status).toBe(200);
    const xml = readFileSync(teamFile, "utf8");
    const p1 = xml.match(/<player\b[^>]*id="p1"[\s\S]*?<\/player>/)![0];
    expect(p1).not.toContain("Team Captain");
    expect(p1).not.toContain("<skill>Pro</skill>");
    expect(xmlCaptainVacant(xml)).toBe(false);
  });
  it("death via the fork's result banking (the block is removed) leaves the captainVacant mark", () => {
    const team = `<team id="900001"><dedicatedFans>3</dedicatedFans><coach>flutethecat</coach><name>T</name><treasury>60000</treasury>` +
      `<player status="Active" nr="1" id="17854689"><name>cap</name><playerStatistics currentSpps="1"><touchdowns>0</touchdowns><casualties>1</casualties><games>5</games></playerStatistics>` +
      `<skillList><skill>Team Captain</skill><skill>Pro</skill></skillList><injuryList/></player></team>`;
    const result = `<gameResult replayId="1" halves="2"><teamResult teamId="900001"><score>0</score><conceded>false</conceded><stalled>false</stalled><winnings>0</winnings>
      <playerResultList><playerResult playerId="17854689" playerType="regular" name="cap" positionId="1"><defecting>false</defecting><starPlayerPoints current="1" earned="2"><casualties>1</casualties></starPlayerPoints><injury>Dead (RIP)</injury></playerResult></playerResultList></teamResult>
      <teamResult teamId="900002"><score>0</score><conceded>false</conceded><stalled>false</stalled><playerResultList></playerResultList></teamResult></gameResult>`;
    const out = buildBankTasks(parseFumbblResult(result)).find((t) => t.teamId === "900001")!.applyFn(team);
    expect(out).not.toContain('id="17854689"');
    expect(out).toMatch(/<team captainVacant="true" id="900001">/);
    expect(xmlCaptainVacant(out)).toBe(true);
  });
});

describe("SPA helpers (spa/src/shared/captain.ts): lobby flag, who may appoint, picker rows", async () => {
  const spa = await import("../spa/src/shared/captain");
  it("leagueCaptainVacant confirms the flag against the roster; canAppointCaptain = the seated coach or a manager", () => {
    expect(spa.leagueCaptainVacant(vacantHumans())).toBe(true);
    expect(spa.leagueCaptainVacant({ ...humans(), captainVacant: true })).toBe(false); // the roster has a captain again
    expect(spa.leagueCaptainVacant(undefined)).toBe(false);
    expect(spa.canAppointCaptain(humans(), "bob", false)).toBe(true);
    expect(spa.canAppointCaptain(humans(), "Eve", false)).toBe(false);
    expect(spa.canAppointCaptain(humans(), "Eve", true)).toBe(true);
    expect(spa.canAppointCaptain({ coachId: "Bob", coachAssigned: { cleared: true } }, "Bob", false)).toBe(false);
  });
  it("leagueCaptainRows offers only the server's eligible ids", () => {
    expect(spa.leagueCaptainRows({ ...vacantHumans(), captainEligible: ["p2", "p4"] }).map((r) => r.id)).toEqual(["p2", "p4"]);
    expect(spa.captainGainText(["Pro"])).toMatch(/already have Pro/);
  });
});
