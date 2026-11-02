import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findRoster, skillAccess } from "@bb/validator";
import { bb2025 } from "@bb/validator/dataset";
import { createSession, onboardedCoaches } from "./onboardedFixture.js";
import { LeagueStore } from "../src/leagues/store.js";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createTournamentBuilder } from "../spa/src/teams/builder";
import { LEAGUE_FORK_NOTE } from "../src/leagueBuilderMarker.js";

// Roster Builder league mode against the real server (registration spec 11-02, lane L7): the builder reads the season's
// team-building rules, the server preview judges the team by the same rules, and a save keeps the league season.
/* eslint-disable @typescript-eslint/no-explicit-any */
const root = mkdtempSync(join(tmpdir(), "league-builder-http-"));
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const num = (t: string) => (/^(\d+)\+$/.exec(t)?.[1] ?? "0");
function rosterXml(race: string, id: string, prefix: string): string {
  const r = findRoster(bb2025, race)!;
  const positions = r.positions.map(
    (p, i) =>
      `<position id="${prefix}${i + 1}"><quantity>${p.max}</quantity><name>${p.name}</name><type>Regular</type><gender>male</gender>` +
      `<cost>${p.cost}</cost><movement>${p.MA}</movement><strength>${p.ST}</strength><agility>${num(p.AG)}</agility>` +
      `<passing>${num(p.PA)}</passing><armour>${num(p.AV)}</armour><skillList>${p.skills.map((s) => `<skill>${s}</skill>`).join("")}</skillList></position>`,
  );
  return `<roster id="${id}"><name>${r.name}</name><reRollCost>${r.reRollCost ?? 50000}</reRollCost><maxReRolls>8</maxReRolls><apothecary>true</apothecary>${positions.join("")}</roster>\n<!-- Time: 0.01 -->`;
}
const DWARF = findRoster(bb2025, "Dwarf")!;
const pos = (re: RegExp) => `d${DWARF.positions.findIndex((p) => re.test(p.name)) + 1}`;
const BLOCKER = pos(/blocker/i);
const ROLLER = pos(/deathroller/i);
const blocker = DWARF.positions.find((p) => /blocker/i.test(p.name))!;
const primaries = Object.keys(bb2025.skills).filter((k) => !bb2025.skills[k]!.trait && !blocker.skills.includes(k) && skillAccess(bb2025, blocker, k) === "primary"
  && !["Block", "Guard", "Mighty Blow", "Dodge"].includes(k));

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_BUILDER_SAVES_DIR: join(root, "saves"), FORK_TEAMS_DIR: join(root, "teams"),
    FORK_STATE_DIR: join(root, "state"), PACKAGES_DIR: join(root, "packages"), TOURNAMENTS_DIR: join(root, "tournaments"), FORK_ADMIN_PASSWORD: "",
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "teams", "rosters", "packages", "tournaments", "log", "state", "saves"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "log", "default.log"), "", "utf8");
  writeFileSync(join(root, "rosters", "dwarf.xml"), rosterXml("Dwarf", "dwarf.bb2025", "d"), "utf8");
  writeFileSync(join(root, "rosters", "human.xml"), rosterXml("Human", "human.bb2025", "h"), "utf8");
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: onboardedCoaches("Alice") }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  const store = new LeagueStore(join(root, "state"), { identitiesFile: join(root, "identities.json") } as never);
  store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Org"] } as never);
  const lg = store.league("tabbl")!;
  store.upsertLeague({ ...lg, registrations: { allowedRosters: { official: true, nafApproved: true, unofficial: false }, allowRegistration: true, maxRegistrations: null, maxPerRace: 1 } } as never);
  store.putSeason({
    id: "s7", leagueId: "tabbl", number: 7, name: "Season 7", sourceSlug: "s7", ruleset: "BB2025", status: "active",
    phases: [], fixtures: [], honours: [], awards: [], participants: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00.000Z", source: "manual",
    teams: [{ id: "t1", name: "Reikland Rejects", race: "Human", coach: "Bob", teamValue: null, players: [], formerPlayers: [] }],
    rules: {
      teamBuilding: { eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"], rosters: [{ roster: "Dwarf", tier: 1, treasury: 1100, startingSkills: { primary: 1, secondary: 0, elite: 0 } }] },
      inducements: { standard: { bribes: { price: 50_000, cap: 2 } }, custom: [], revision: 1 },
    },
  } as never);
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  for (const [name, value] of previousEnv) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  rmSync(root, { recursive: true, force: true });
});

const alice = createSession("Alice");
const fetcher = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${origin}${path}`, {
    method: init.method ?? "GET",
    headers: { authorization: `Bearer ${alice.token}`, ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, String((data as any)?.error ?? res.status), data);
  return data;
}) as Fetcher;
const builder = () => createTournamentBuilder({ api: fetcher, coach: () => "Alice", previewDelay: 0, origin: () => origin, clipboard: async () => undefined });
const MARKER = "league:tabbl:s7";

describe("league mode over HTTP", () => {
  it("public reads: the league context and the derived package answer without a session", async () => {
    const ctx = (await (await fetch(`${origin}/api/leagues/tabbl/seasons/s7/team-building`)).json()) as any;
    expect(ctx).toMatchObject({ label: "TABBL · Season 7", packageName: MARKER, registration: { open: true, maxPerRace: 1 } });
    const pkg = await fetch(`${origin}/api/packages/${encodeURIComponent(MARKER)}?roster=Dwarf`);
    expect(pkg.status).toBe(200);
    expect(((await pkg.json()) as any).rules.budget).toBe(1_100_000);
    expect((await fetch(`${origin}/api/packages/${encodeURIComponent("league:tabbl:nope")}`)).status).toBe(404);
    expect((await fetch(`${origin}/api/leagues/tabbl/seasons/nope/team-building`)).status).toBe(404);
  });

  it("the builder applies the season's rules: race filter with reasons, the treasury as the budget, the inducement table", async () => {
    const b = builder();
    expect(await b.init({ league: { leagueId: "tabbl", seasonId: "s7" } })).toBe("ruleset");
    expect(b.leagueMode()).toBe(true);
    expect(b.state.packageName).toBe(MARKER);
    expect(b.rulesetLabel()).toBe("TABBL · Season 7");
    const races = b.leagueRaces();
    expect(races.find((r) => r.roster === "Dwarf")).toMatchObject({ selectable: true, rosterId: "dwarf.bb2025", terms: "Tier 1 · 1,100k · 1 primary starting skills" });
    expect(races.find((r) => r.roster === "Human")).toMatchObject({ selectable: false, reason: "Full: 1 / 1 Human teams this season." });
    expect(races.find((r) => r.roster === "Halfling")).toMatchObject({ selectable: false, reason: "Not installed on this server." });
    expect([...b.eligibleRosters().keys()]).toEqual(["dwarf.bb2025"]);
    expect(await b.chooseRace("human.bb2025")).toBe(false);
    expect(await b.chooseRace("dwarf.bb2025")).toBe(true);
    expect(b.totals().budget).toBe(1_100_000);
    expect(b.starsAllowed()).toBe(false);
    expect(b.forkBlocked()).toBe(LEAGUE_FORK_NOTE);
    expect(b.inducementRows()).toEqual([]);
    expect(b.state.leagueCtx!.inducements.find((i) => i.id === "bribes")).toMatchObject({ price: 50_000, cap: 2 });
  });

  it("server validation agrees with the builder: over 1,000k but inside the league treasury is valid; one primary skill only", async () => {
    const b = builder();
    await b.init({ league: { leagueId: "tabbl", seasonId: "s7" }, race: "dwarf.bb2025" });
    b.setTeamName("Longbeards");
    for (let i = 0; i < 11; i++) b.addPosition(BLOCKER);
    b.addPosition(ROLLER);
    b.stepStaff("reRolls", 2);
    await b.flushPreview();
    expect(b.totals().used).toBeGreaterThan(1_000_000);
    expect(b.validity().tone).toBe("valid");
    const direct = (await fetcher("/api/fork/team-builder/preview", { method: "POST", body: b.requestBody() })) as any;
    expect(direct.valid).toBe(true);
    expect(direct.package).toMatchObject({ name: "TABBL · Season 7", budget: 1_100_000 });
    // Two primary skills where the league grants one: invalid on both sides.
    expect(await b.openSkills(0)).toBe("");
    expect(b.addSkill(0, primaries[0]!)).toBe("");
    await b.flushPreview();
    expect(b.validity().tone).toBe("valid");
    expect(b.addSkill(1, primaries[1]!)).toBe("");
    await b.flushPreview();
    expect(b.validity().tone).toBe("invalid");
    const over = (await fetcher("/api/fork/team-builder/preview", { method: "POST", body: b.requestBody() })) as any;
    expect(over.valid).toBe(false);
    // A full race is refused by the server as well, whatever the client sends.
    const human = (await fetcher("/api/fork/team-builder/preview", { method: "POST", body: { ...b.requestBody(), rosterId: "human.bb2025", picks: [{ positionId: "h1", count: 11 }] } })) as any;
    expect(human.valid).toBe(false);
    expect(human.errors[0]).toMatchObject({ ruleId: "league", message: "Human: 1 / 1 teams in this season, full." });
    // Create on Fork is refused: the league team is made when the registration is accepted.
    const built = await fetch(`${origin}/api/fork/team-builder/build`, {
      method: "POST", headers: { authorization: `Bearer ${alice.token}`, "content-type": "application/json", "x-cw-auth": "1" }, body: JSON.stringify(b.requestBody()),
    });
    expect(built.status).toBe(400);
    expect(((await built.json()) as any).error).toBe(LEAGUE_FORK_NOTE);
  });

  it("a league save carries the league season, and reopening it restores league mode", async () => {
    const b = builder();
    await b.init({ league: { leagueId: "tabbl", seasonId: "s7" }, race: "dwarf.bb2025" });
    b.setTeamName("Saved Beards");
    for (let i = 0; i < 11; i++) b.addPosition(BLOCKER);
    expect(await b.saveTeam()).toBe(true);
    const id = b.state.currentSave!.id;
    const one = (await fetcher(`/api/fork/team-builder/saves/${id}`)) as any;
    expect(one.save.league).toEqual({ leagueId: "tabbl", seasonId: "s7" });
    const list = (await fetcher("/api/fork/team-builder/saves")) as any;
    expect(list.saves.find((s: any) => s.id === id).league).toEqual({ leagueId: "tabbl", seasonId: "s7" });
    const again = builder();
    expect(await again.init({ saveId: id })).toBe("roster");
    expect(again.leagueMode()).toBe(true);
    expect(again.rulesetLabel()).toBe("TABBL · Season 7");
    expect(again.state.slots).toHaveLength(11);
    // Saving the same sheet under a tournament ruleset drops the league context.
    const moved = (await fetcher(`/api/fork/team-builder/saves/${id}`, { method: "PUT", body: { body: { ...again.requestBody(), packageName: "free-create" } } })) as any;
    expect(moved.save.league).toBeUndefined();
  });

  it("standard mode is unchanged: no league context, no league field on the save", async () => {
    const b = builder();
    expect(await b.init({ packageName: "free-create", race: "dwarf.bb2025" })).toBe("roster");
    expect(b.leagueMode()).toBe(false);
    expect(b.state.leagueCtx).toBeNull();
    expect(b.forkBlocked()).toBe("");
    expect(b.eligibleRosters().size).toBe(2);
    b.setTeamName("Free Beards");
    b.addPosition(BLOCKER);
    expect(await b.saveTeam()).toBe(true);
    const one = (await fetcher(`/api/fork/team-builder/saves/${b.state.currentSave!.id}`)) as any;
    expect(one.save.league).toBeUndefined();
  });
});
