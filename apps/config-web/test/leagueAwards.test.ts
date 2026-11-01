import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { AWARD_ICONS, awardList, hallOfFame, seasonAwardId, type HonoursView } from "../src/leagues/awards";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueAward, LeagueTeam, SeasonRecord } from "../src/leagues/types";
import { AWARD_ICONS as SPA_ICONS, awardsFor, movedOrder, teamAwards } from "../spa/src/leagues/honours";

// League awards and the Hall of Fame (src/leagues/awards.ts): organiser-given awards next to the podium and imported
// season awards, the computed Hall of Fame and the organiser-curated pins. Fake coaches and teams only.

const team = (id: string, name: string, coach: string, race: string, coachId?: string): LeagueTeam => ({
  id, name, race, coach, ...(coachId ? { coachId } : {}), teamValue: 1000000, treasury: 0, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: false,
  tier: "1", raceLeague: "", players: [], formerPlayers: [],
});
const award = (type: string, team: string, coach: string, race: string, over: Partial<LeagueAward> = {}): LeagueAward => ({
  category: "Season", type, name: type === "Overall Champion" ? "Champion" : type, description: "", coach, team, race, goldenStar: type === "Overall Champion", ...over,
});

const season = (n: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [],
  teams: [team("orcs", "Orcs", "Ann", "Orc", "Ann"), team("elves", "Elves", "Bob", "Wood Elf", "Bob"), team("dwarfs", "Dwarfs", "Cat", "Dwarf")],
  participants: [{ coach: "Dee", coachId: "Dee", country: "US", race: "Human", team: "Humans", active: true }],
  honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual", ...over,
});

/** Season 1: imported (TourPlay awards incl. an honorary award). Season 2: crowned here (podium). Season 3: in progress. */
const imported = (): SeasonRecord => season(1, {
  status: "completed", source: "tourplay-export", startedAt: "2025-01-01T00:00:00.000Z", endedAt: "2025-06-01T00:00:00.000Z", importedAt: "2026-10-01T00:00:00.000Z",
  awards: [
    award("Overall Champion", "Elves", "Bob", "Wood Elf", { coachId: "Bob" }),
    award("Runner-up", "Orcs", "Ann", "Orc"),
    award("Honorary award", "Dwarfs", "Cat", "Dwarf", { name: "Most stubborn" }),
  ],
});
const crowned = (): SeasonRecord => season(2, {
  status: "completed", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-06-01T00:00:00.000Z",
  awards: [
    award("Overall Champion", "Orcs", "Ann", "Orc", { coachId: "Ann", podium: true, description: "Final standings" }),
    award("Runner-up", "Elves", "Bob", "Wood Elf", { coachId: "Bob", podium: true }),
    award("Consolation", "Dwarfs", "Cat", "Dwarf", { podium: true }),
  ],
  podium: { decidedBy: "standings", proposed: { champion: "orcs" }, final: { champion: "orcs", runnerUp: "elves", consolation: "dwarfs" }, overridden: false, by: "Jay", at: "2026-06-01T00:00:00.000Z" },
});

describe("pure: award list, Hall of Fame, icons", () => {
  it("the SPA icon table is the server's, and every icon is one of our own files", () => {
    expect(SPA_ICONS).toEqual(AWARD_ICONS);
    for (const { src } of Object.values(AWARD_ICONS)) {
      expect(src).toMatch(/^\/icons\/(coach-badges|ui|skills|builder)\/[\w-]+\.png$/);
      expect(readFileSync(join(__dirname, "..", "public", src)).length).toBeGreaterThan(0);
    }
  });

  it("Hall of Fame: one card per finished season, newest first, from the podium or the imported awards", () => {
    const cards = hallOfFame([imported(), crowned(), season(3)]);
    expect(cards.map((c) => c.seasonId)).toEqual(["season-2", "season-1"]);
    expect(cards[0]).toMatchObject({
      source: "podium", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-06-01T00:00:00.000Z",
      champion: { team: "Orcs", coach: "Ann", race: "Orc", teamId: "orcs" }, runnerUp: { team: "Elves" }, consolation: { team: "Dwarfs" },
    });
    expect(cards[1]).toMatchObject({ source: "imported", champion: { team: "Elves", coach: "Bob", race: "Wood Elf" }, runnerUp: { team: "Orcs" } });
    expect(cards[1]!.consolation).toBeUndefined();
    // a finished season with no podium still gets its card
    expect(hallOfFame([season(4, { status: "completed" })])[0]).toMatchObject({ seasonId: "season-4", source: "none" });
  });

  it("award list: season awards (podium / imported) and custom awards, newest first; the champion carries the star", () => {
    const league = { awards: [{ id: "a-x", title: "Fair play", icon: "star", toCoach: "Dee", toCoachId: "Dee", note: "", by: "Jay", at: "2026-10-20T00:00:00.000Z" }] };
    const list = awardList(league, [imported(), crowned()]);
    expect(list.map((a) => `${a.source}:${a.title}`)).toEqual([
      "custom:Fair play", "podium:Consolation", "podium:Overall Champion", "podium:Runner-up", "imported:Most stubborn", "imported:Overall Champion", "imported:Runner-up",
    ]);
    expect(list.find((a) => a.source === "podium" && a.star)?.toTeam).toBe("Orcs");
    expect(list[0]).toMatchObject({ id: "a-x", by: "Jay" });
    expect("seasonId" in list[0]!).toBe(false);
    // ids of season awards are stable across reads; podium awards are listed after the imported ones and do not shift them
    const id = seasonAwardId("season-1", imported().awards[0]!, 0);
    expect(awardList({}, [imported()]).some((a) => a.id === id)).toBe(true);
    const withPodium = { ...imported(), awards: [...imported().awards, award("Consolation", "Dwarfs", "Cat", "Dwarf", { podium: true })] };
    expect(awardList({}, [withPodium]).some((a) => a.id === id)).toBe(true);
    // SPA filters
    expect(awardsFor(list, "league").map((a) => a.id)).toEqual(["a-x"]);
    expect(awardsFor(list, "season-1")).toHaveLength(3);
    expect(teamAwards(list, "season-2", { id: "orcs", name: "Orcs" }).map((a) => a.title)).toEqual(["Overall Champion"]);
    expect(movedOrder(["a", "b", "c"], "c", -1)).toEqual(["a", "c", "b"]);
    // two imported rows equal but for the category get different ids; a coach rename (anonymisation) keeps the id
    const twin = season(9, { awards: [award("Honorary award", "Orcs", "Ann", "Orc", { name: "MVP" }), award("Honorary award", "Orcs", "Ann", "Orc", { name: "MVP", category: "Cup" }), award("Honorary award", "Orcs", "Ann", "Orc", { name: "MVP" })] });
    const twinIds = awardList({}, [twin]).map((a) => a.id);
    expect(new Set(twinIds).size).toBe(3);
    const renamed = { ...twin, awards: twin.awards.map((a) => ({ ...a, coach: "Deleted coach #1", coachId: "Deleted coach #1" })) };
    expect(awardList({}, [renamed]).map((a) => a.id)).toEqual(twinIds);
    const podiumRenamed = { ...crowned(), awards: crowned().awards.map((a) => ({ ...a, coach: "Deleted coach #1" })) };
    expect(awardList({}, [podiumRenamed]).map((a) => a.id)).toEqual(awardList({}, [crowned()]).map((a) => a.id));
    expect(movedOrder(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });
});

describe("award and Hall of Fame routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let notes: Array<{ coach: string; type: string; title: string; body: string; link: string }>;
  const deps = (): LeagueApiDeps => ({
    store,
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
    now: () => new Date("2026-11-01T12:00:00.000Z"),
    notify: (coach, input) => { notes.push({ coach, type: input.type, title: input.title, body: input.body, link: input.link }); },
  });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown, query = ""): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(query), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const view = async (auth?: { coach: string; admin?: boolean }): Promise<HonoursView> => (await call("GET", "/api/leagues/tabbl/honours", auth)).body as HonoursView;
  const JAY = { coach: "Jay" };
  const BOB = { coach: "Bob" };
  const ADMIN = { coach: "Root", admin: true };
  const AW = "/api/leagues/tabbl/awards";
  const PINS = "/api/leagues/tabbl/hall-of-fame/pins";
  const give = (rev: number, over: Record<string, unknown> = {}) => ({ revision: rev, title: "Best sportsmanship", icon: "star", recipient: { kind: "team", seasonId: "season-3", teamId: "elves" }, note: "Always on time.", ...over });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-awards-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(imported());
    store.putSeason(crowned());
    store.putSeason(season(3));
    notes = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("public read: Hall of Fame + awards, no recipients; organisers and admins get the recipient lists; never cached", async () => {
    const anon = await call("GET", "/api/leagues/tabbl/honours");
    expect(anon.status).toBe(200);
    expect(anon.headers?.["cache-control"]).toBe("private, no-store");
    const v = anon.body as HonoursView;
    expect(v.revision).toBe(0);
    expect(v.hallOfFame.map((h) => h.seasonId)).toEqual(["season-2", "season-1"]);
    expect(v.awards).toHaveLength(6);
    expect(v.recipients).toBeUndefined();
    expect((await view(BOB)).recipients).toBeUndefined();
    const r = (await view(JAY)).recipients!;
    expect(r.seasons.map((s) => s.id)).toEqual(["season-3", "season-2", "season-1"]);
    expect(r.coaches.map((c) => c.id)).toEqual(["Ann", "Bob", "Dee"]); // accounts only: Cat is reached through the Dwarfs
    expect((await view(ADMIN)).recipients).toBeDefined();
    expect((await call("GET", "/api/leagues/nope/honours")).status).toBe(404);
    expect((await call("POST", "/api/leagues/tabbl/honours", JAY, {})).status).toBe(405);
  });

  it("auth: anonymous 401, other coaches 403, on every write", async () => {
    for (const [m, p] of [["POST", AW], ["DELETE", `${AW}/a-1`], ["POST", PINS], ["DELETE", `${PINS}/p-1`], ["PUT", "/api/leagues/tabbl/hall-of-fame/order"]] as const) {
      expect((await call(m, p, undefined, { revision: 0 })).status, `${m} ${p}`).toBe(401);
      expect((await call(m, p, BOB, { revision: 0 })).status, `${m} ${p}`).toBe(403);
    }
    expect((await call("POST", "/api/leagues/nope/awards", JAY, give(0))).status).toBe(404);
    expect((await call("GET", AW, JAY)).status).toBe(405);
    expect(store.league("tabbl")!.awards).toBeUndefined();
  });

  it("give award: validation, revision (428 / 409), stored shape, notifies the recipient once", async () => {
    expect((await call("POST", AW, JAY, { ...give(0), revision: undefined })).status).toBe(428);
    expect((await call("POST", AW, JAY, give(5))).status).toBe(409);
    expect((await call("POST", AW, JAY, give(0, { title: " " }))).status).toBe(400);
    expect((await call("POST", AW, JAY, give(0, { title: "x".repeat(61) }))).status).toBe(400);
    expect((await call("POST", AW, JAY, give(0, { icon: "../../etc/passwd" }))).body).toMatchObject({ field: "icon" });
    expect((await call("POST", AW, JAY, give(0, { recipient: { kind: "team", seasonId: "season-3", teamId: "nope" } }))).body).toMatchObject({ field: "recipient" });
    expect((await call("POST", AW, JAY, give(0, { seasonId: "season-1" }))).body).toMatchObject({ field: "recipient" }); // team of another season
    expect((await call("POST", AW, JAY, give(0, { seasonId: "season-9" }))).body).toMatchObject({ field: "seasonId" });
    expect((await call("POST", AW, JAY, give(0, { recipient: { kind: "coach", coachId: "Zed" } }))).status).toBe(400);
    expect((await call("POST", AW, JAY, give(0, { recipient: { kind: "coach", coach: "Ann" } }))).body).toMatchObject({ field: "recipient" }); // display names are refused
    expect((await call("POST", AW, JAY, give(0, { recipient: { kind: "coach", coachId: "Cat" } }))).status).toBe(400); // Cat has no account: give it to the team
    expect((await call("POST", AW, JAY, give(0, { note: "n".repeat(281) }))).body).toMatchObject({ field: "note" });
    expect(notes).toEqual([]);

    const res = await call("POST", AW, JAY, give(0, { seasonId: "season-3" }));
    expect(res.status).toBe(201);
    expect(res.headers?.["cache-control"]).toBe("private, no-store");
    const stored = store.league("tabbl")!.awards!;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toEqual({
      id: expect.stringMatching(/^a-[0-9a-f]{12}$/), title: "Best sportsmanship", icon: "star", toTeam: "Elves", teamId: "elves", race: "Wood Elf",
      toCoach: "Bob", toCoachId: "Bob", seasonId: "season-3", note: "Always on time.", by: "Jay", at: "2026-11-01T12:00:00.000Z",
    });
    expect(store.league("tabbl")!.honoursRevision).toBe(1);
    expect(store.league("tabbl")!.revision).toBeUndefined(); // the settings revision is untouched
    expect(notes).toEqual([{ coach: "Bob", type: "award", title: "TABBL: Best sportsmanship", body: 'Jay gave Elves (Season 3) the award "Best sportsmanship". Always on time.', link: "/app/leagues/tabbl?tab=honours" }]);
    const v = (res.body as { honours: HonoursView }).honours;
    expect(v.awards[0]).toMatchObject({ source: "custom", title: "Best sportsmanship", toTeam: "Elves", seasonName: "Season 3" });
    expect(v.revision).toBe(1);

    // a stale retry of the same request is refused: no second award, no second notification
    expect((await call("POST", AW, JAY, give(0, { seasonId: "season-3" }))).status).toBe(409);
    expect(store.league("tabbl")!.awards).toHaveLength(1);
    expect(notes).toHaveLength(1);

    // to a coach by account id (league-wide), by an admin: notified by account
    expect((await call("POST", AW, ADMIN, give(1, { recipient: { kind: "coach", coachId: "ann" }, icon: "block" }))).status).toBe(201);
    expect(store.league("tabbl")!.awards![1]).toMatchObject({ toCoach: "Ann", toCoachId: "Ann", by: "Root" });
    expect(store.league("tabbl")!.awards![1]!.seasonId).toBeUndefined();
    expect(notes.map((n) => n.coach)).toEqual(["Bob", "Ann"]);
    // a team whose coach has no account: stored, nobody notified
    expect((await call("POST", AW, JAY, give(2, { recipient: { kind: "team", seasonId: "season-3", teamId: "dwarfs" } }))).status).toBe(201);
    expect(store.league("tabbl")!.awards![2]).toMatchObject({ toCoach: "Cat", toTeam: "Dwarfs" });
    expect(store.league("tabbl")!.awards![2]!.toCoachId).toBeUndefined();
    // never the giver
    store.updateLeague("tabbl", (l) => { l.organisers.push("Dee"); });
    expect((await call("POST", AW, { coach: "Dee" }, give(3, { recipient: { kind: "coach", coachId: "Dee" } }))).status).toBe(201);
    expect(notes).toHaveLength(2);
  });

  it("a coach recipient resolves only by the exact account id, never by another team's display name", async () => {
    // Season 4 (newest) has a team whose coach SHOWS as "Bob" but is the account "Imp".
    store.putSeason(season(4, { teams: [team("ravens", "Ravens", "Bob", "Human", "Imp")], participants: [] }));
    expect((await call("POST", AW, JAY, give(0, { recipient: { kind: "coach", coachId: "Bob" } }))).status).toBe(201);
    expect(store.league("tabbl")!.awards![0]).toMatchObject({ toCoach: "Bob", toCoachId: "Bob" });
    expect(notes.map((n) => n.coach)).toEqual(["Bob"]);
    const r = (await view(JAY)).recipients!;
    expect(r.coaches.filter((c) => c.name === "Bob").map((c) => c.id).sort()).toEqual(["Bob", "Imp"]);
  });

  it("delete award: given awards only; podium and imported awards are protected; pins to it go too", async () => {
    await call("POST", AW, JAY, give(0));
    const id = store.league("tabbl")!.awards![0]!.id;
    await call("POST", PINS, JAY, { revision: 1, kind: "award", awardId: id });
    const v = await view(JAY);
    const podium = v.awards.find((a) => a.source === "podium")!;
    const imp = v.awards.find((a) => a.source === "imported")!;
    expect((await call("DELETE", `${AW}/${podium.id}`, JAY, { revision: 2 })).body).toMatchObject({ error: expect.stringMatching(/reopen/i) });
    expect((await call("DELETE", `${AW}/${imp.id}`, JAY, { revision: 2 })).status).toBe(409);
    expect((await call("DELETE", `${AW}/a-nope`, JAY, { revision: 2 })).status).toBe(404);
    expect((await call("DELETE", `${AW}/${id}`, BOB, { revision: 2 })).status).toBe(403);
    expect((await call("DELETE", `${AW}/${id}`, JAY, {})).status).toBe(428);
    const del = await call("DELETE", `${AW}/${id}`, JAY, { revision: 2 });
    expect(del.status).toBe(200);
    expect(store.league("tabbl")!.awards).toEqual([]);
    expect(store.league("tabbl")!.hallOfFame ?? []).toEqual([]);
    expect(store.season("tabbl", "season-2")!.awards).toHaveLength(3);
  });

  it("podium awards follow reopen: the Hall of Fame card and the awards leave with them", async () => {
    expect((await view()).hallOfFame.map((h) => h.seasonId)).toContain("season-2");
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-2/reopen", JAY, {})).status).toBe(200);
    const v = await view();
    expect(v.hallOfFame.map((h) => h.seasonId)).toEqual(["season-1"]);
    expect(v.awards.filter((a) => a.source === "podium")).toEqual([]);
  });

  it("pins: champion / award / record, notes, duplicates refused, order, removal; stale pins stay for organisers to remove", async () => {
    expect((await call("POST", PINS, JAY, { revision: 0, kind: "champion", seasonId: "season-3" })).body).toMatchObject({ field: "seasonId" }); // not finished
    expect((await call("POST", PINS, JAY, { revision: 0, kind: "record", text: "" })).status).toBe(400);
    expect((await call("POST", PINS, JAY, { revision: 0, kind: "nope" })).body).toMatchObject({ field: "kind" });
    expect((await call("POST", PINS, JAY, { revision: 0, kind: "award", awardId: "a-nope" })).body).toMatchObject({ field: "awardId" });
    const champ = await call("POST", PINS, JAY, { revision: 0, kind: "champion", seasonId: "season-2", note: "First title" });
    expect(champ.status).toBe(201);
    expect((await call("POST", PINS, JAY, { revision: 1, kind: "champion", seasonId: "season-2" })).status).toBe(409);
    const honorary = (await view()).awards.find((a) => a.title === "Most stubborn")!;
    expect((await call("POST", PINS, JAY, { revision: 1, kind: "award", awardId: honorary.id })).status).toBe(201);
    expect((await call("POST", PINS, ADMIN, { revision: 2, kind: "record", text: "Most TDs in a season: 31 (Season 1)" })).status).toBe(201);
    let v = await view();
    expect(v.pins.map((p) => p.kind)).toEqual(["champion", "award", "record"]);
    expect(v.pins[0]).toMatchObject({ note: "First title", by: "Jay", resolved: { title: "Champion", team: "Orcs", coach: "Ann", seasonName: "Season 2" } });
    expect(v.pins[1]!.resolved).toMatchObject({ title: "Most stubborn", team: "Dwarfs" });
    expect(v.pins[2]!.resolved).toEqual({ title: "Most TDs in a season: 31 (Season 1)" });

    const ids = v.pins.map((p) => p.id);
    const ORDER = "/api/leagues/tabbl/hall-of-fame/order";
    expect((await call("PUT", ORDER, JAY, { revision: 3, order: [ids[0], ids[1]] })).body).toMatchObject({ field: "order" });
    expect((await call("PUT", ORDER, JAY, { revision: 3, order: [ids[0], ids[0], ids[1]] })).status).toBe(400);
    expect((await call("PUT", ORDER, JAY, { revision: 2, order: [ids[2], ids[0], ids[1]] })).status).toBe(409);
    expect((await call("PUT", ORDER, JAY, { revision: 3, order: [ids[2], ids[0], ids[1]] })).status).toBe(200);
    expect(store.league("tabbl")!.hallOfFame!.map((p) => p.id)).toEqual([ids[2], ids[0], ids[1]]);

    // reopening season 2 leaves its champion pin unresolved (public UI hides it; organisers remove it)
    await call("POST", "/api/leagues/tabbl/seasons/season-2/reopen", JAY, {});
    v = await view();
    expect(v.pins.find((p) => p.id === ids[0])!.resolved).toBeUndefined();
    expect((await call("DELETE", `${PINS}/${ids[0]}`, BOB, { revision: 4 })).status).toBe(403);
    expect((await call("DELETE", `${PINS}/p-nope`, JAY, { revision: 4 })).status).toBe(404);
    expect((await call("DELETE", `${PINS}/${ids[0]}`, JAY, { revision: 4 })).status).toBe(200);
    expect(store.league("tabbl")!.hallOfFame!.map((p) => p.id)).toEqual([ids[2], ids[1]]);
  });

  it("the coach page: GET /api/leagues?awards=mine lists the coach's podium, imported and given awards", async () => {
    expect((await call("GET", "/api/leagues", undefined, undefined, "awards=mine")).status).toBe(401);
    await call("POST", AW, JAY, give(0));
    const mine = await call("GET", "/api/leagues", BOB, undefined, "awards=mine");
    expect(mine.headers?.["cache-control"]).toBe("private, no-store");
    const list = (mine.body as { awards: Array<{ title: string; source: string; leagueName: string }> }).awards;
    expect(list.map((a) => `${a.source}:${a.title}`)).toEqual(["custom:Best sportsmanship", "podium:Runner-up", "imported:Overall Champion"]);
    expect(list[0]!.leagueName).toBe("TABBL");
    const cat = await call("GET", "/api/leagues", { coach: "Cat" }, undefined, "awards=mine");
    expect((cat.body as { awards: unknown[] }).awards).toEqual([]); // Cat's rows carry no account link
  });
});
