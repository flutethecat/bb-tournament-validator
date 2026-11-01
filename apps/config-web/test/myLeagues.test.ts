import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { myLeagues } from "../src/leagues/myLeagues";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, LeagueTeam, SeasonRecord } from "../src/leagues/types";

// GET /api/me/leagues read model (src/leagues/myLeagues.ts): the signed-in coach's own seats in active league seasons,
// with each team's W-D-L record and next unplayed fixture. Only the coach's own teams; nothing private about others.

const team = (id: string, name: string, race: string, coach: string, coachId?: string): LeagueTeam => ({
  id, name, race, coach, ...(coachId ? { coachId } : {}), nafUser: `${coach}-naf`, teamValue: 1_000_000, treasury: 0, rerolls: 2, fans: 1,
  assistantCoaches: 0, cheerleaders: 0, apothecary: false, tier: "1", raceLeague: "", players: [], formerPlayers: [],
});

const fx = (id: string, round: number, home: [string, number | null], away: [string, number | null], over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round, table: 1,
  home: { team: home[0], teamId: home[0].toLowerCase(), coach: "", race: "", score: home[1], cas: 0, conceded: false },
  away: { team: away[0], teamId: away[0].toLowerCase(), coach: "", race: "", score: away[1], cas: 0, conceded: false },
  suspended: false, ...over,
});

const season = (leagueId: string, number: number, status: "active" | "completed", teams: LeagueTeam[], fixtures: LeagueFixture[]): SeasonRecord => ({
  id: `season-${number}`, leagueId, number, name: `Season ${number}`, sourceSlug: `${leagueId}-s${number}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures, teams, participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual",
});

describe("myLeagues", () => {
  let dir = "";
  let store: LeagueStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "my-leagues-"));
    store = new LeagueStore(dir);
    // League A: Ann seated on Orcs in the active season 2; W 2-1, D 1-1, L by concession, next = round 4 (round 5 later,
    // a suspended round-3 game skipped).
    store.upsertLeague({ id: "alpha", name: "Alpha League", fullName: "Alpha League", slug: "alpha", organisers: ["Org"] });
    store.putSeason(season("alpha", 1, "completed", [team("orcs", "Orcs", "Orc", "Ann", "Ann")], []));
    store.putSeason(season("alpha", 2, "active", [team("orcs", "Orcs", "Orc", "Ann", "Ann"), team("elves", "Elves", "Wood Elf", "Bob", "Bob")], [
      fx("f1", 1, ["Orcs", 2], ["Elves", 1]),
      fx("f2", 2, ["Elves", 1], ["Orcs", 1]),
      fx("f3", 2, ["Orcs", 3], ["Elves", 0], { home: { team: "Orcs", teamId: "orcs", coach: "", race: "", score: 3, cas: 0, conceded: true } }),
      fx("f6", 3, ["Orcs", null], ["Elves", null], { suspended: true }),
      fx("f5", 5, ["Orcs", null], ["Elves", null]),
      fx("f4", 4, ["Elves", null], ["Orcs", null], { date: "2026-11-05" }),
    ]));
    // League B: Ann's seat is in the active season 3 while season 4 (newest, without Ann) is already finished: the links
    // carry ?season=.
    store.upsertLeague({ id: "beta", name: "Beta Cup", fullName: "Beta Cup", slug: "beta", organisers: ["Org"] });
    store.putSeason(season("beta", 4, "completed", [team("gobbos", "Gobbos", "Goblin", "Cat", "Cat")], []));
    store.putSeason(season("beta", 3, "active", [team("dwarfs", "Dwarfs", "Dwarf", "Ann", "Ann")], []));
    // League C: Ann only in a finished season; League D: nobody's account matches.
    store.upsertLeague({ id: "gamma", name: "Gamma", fullName: "Gamma", slug: "gamma", organisers: [] });
    store.putSeason(season("gamma", 1, "completed", [team("orcs", "Orcs", "Orc", "Ann", "Ann")], []));
    store.upsertLeague({ id: "delta", name: "Delta", fullName: "Delta", slug: "delta", organisers: [] });
    store.putSeason(season("delta", 1, "active", [team("other", "Other", "Human", "Dee", "Dee")], []));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("one row per league with a seat in an active season: team, record and the next unplayed fixture", () => {
    const out = myLeagues(store, "Ann");
    expect(out.map((l) => l.id)).toEqual(["alpha", "beta"]);
    const [alpha, beta] = out;
    expect(alpha).toEqual({
      id: "alpha", name: "Alpha League", season: { id: "season-2", number: 2, name: "Season 2" }, to: "/leagues/alpha",
      teams: [{
        id: "orcs", name: "Orcs", race: "Orc", record: { wins: 1, draws: 1, losses: 1 }, to: "/leagues/alpha?tab=teams&team=orcs",
        next: { id: "f4", round: 4, opponent: "Elves", home: false, date: "2026-11-05", to: "/leagues/alpha?tab=fixtures&fixture=f4" },
      }],
    });
    // the seat's season is not the newest: every link names it
    expect(beta).toMatchObject({ to: "/leagues/beta?season=season-3", teams: [{ name: "Dwarfs", record: { wins: 0, draws: 0, losses: 0 }, next: null, to: "/leagues/beta?season=season-3&tab=teams&team=dwarfs" }] });
  });

  it("own data only: other coaches' teams, NAF names and coach ids never appear; nobody signed in gets nothing", () => {
    const json = JSON.stringify(myLeagues(store, "Ann"));
    for (const leak of ["Bob", "naf", "coachId", "Dee", "Cat"]) expect(json).not.toContain(leak);
    expect(myLeagues(store, "Bob").map((l) => l.teams.map((t) => t.name))).toEqual([["Elves"]]);
    expect(myLeagues(store, "Nobody")).toEqual([]);
    expect(myLeagues(store, "  ")).toEqual([]);
  });

  it("an organiser-assigned account owns the team; the old display name no longer does", () => {
    store.putSeason(season("delta", 1, "active", [{ ...team("other", "Other", "Human", "Dee", "Ann"), coachAssigned: { by: "Org", at: "2026-10-30" } }], []));
    expect(myLeagues(store, "Ann").map((l) => l.id)).toEqual(["alpha", "beta", "delta"]);
    expect(myLeagues(store, "Dee")).toEqual([]);
  });
});
