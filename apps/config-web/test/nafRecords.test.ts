import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeGlicko } from "../src/coachGlicko.js";
import {
  fetchNafGames, NafRecordStore, nafResultRows, parseNafGameList, refreshNafForCoaches, type NafGame, type NafIdentities,
} from "../src/nafRecords.js";
import { TournamentResultStore } from "../src/tournamentResults.js";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "naf-gamelist-34116.html"), "utf8");
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "naf-")); delete process.env.NAF_SCRAPE_DISABLED; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.NAF_SCRAPE_DISABLED; });

const ids = (coaches: Record<string, { nafId?: string; nafName?: string }>): NafIdentities => ({
  coaches: Object.fromEntries(Object.entries(coaches).map(([c, identities]) => [c.toLowerCase(), { ffbCoachId: c, identities }])),
});
const game = (over: Partial<NafGame> = {}): NafGame => ({
  date: "2026-07-25", tournament: "Backyard BBQ Blitz", variant: "Blood Bowl 2025", coaches: ["teturact", "flutethecat"], races: ["Human", "Amazon"], score: [1, 0], ...over,
});
const okFetch = (html: string): typeof fetch => (async () => new Response(html, { status: 200 })) as unknown as typeof fetch;

describe("parseNafGameList", () => {
  it("parses the fixture rows, skipping header and filter rows", () => {
    const games = parseNafGameList(fixture);
    expect(games).toHaveLength(20);
    expect(games[0]).toEqual({
      date: "2026-07-25", tournament: "Backyard BBQ Blitz", variant: "Blood Bowl 2025",
      coaches: ["teturact", "flutethecat"], races: ["Human", "Amazon"], score: [1, 1],
    });
    expect(games[1]!.score).toEqual([0, 1]);
  });
  it("returns [] for junk and decodes entities", () => {
    expect(parseNafGameList("<html>nothing</html>")).toEqual([]);
    const row = "<tr><td>2026-01-02</td><td>A &amp; B Cup</td><td>V</td><td><a>x&#39;y - z</a></td><td>Orc - Elf</td><td> 2 - 3 </td><td>L</td></tr>";
    expect(parseNafGameList(row)[0]).toMatchObject({ tournament: "A & B Cup", coaches: ["x'y", "z"], score: [2, 3] });
  });
});

describe("fetchNafGames", () => {
  it("returns [] on non-200, thrown fetch and unparseable pages, never throwing", async () => {
    expect(await fetchNafGames("34116", (async () => new Response("no", { status: 503 })) as unknown as typeof fetch)).toEqual([]);
    expect(await fetchNafGames("34116", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toEqual([]);
    expect(await fetchNafGames("34116", okFetch("<p>changed</p>"))).toEqual([]);
  });
  it("sends the User-Agent and parses a good page", async () => {
    const f = vi.fn(okFetch(fixture));
    expect(await fetchNafGames("34116", f as unknown as typeof fetch)).toHaveLength(20);
    expect(String(f.mock.calls[0]![0])).toContain("coach=34116&limit=1000");
    expect((f.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ "User-Agent": expect.stringContaining("SuperFUMBBL-config-web") });
  });
  it("NAF_SCRAPE_DISABLED=1 makes no request", async () => {
    process.env.NAF_SCRAPE_DISABLED = "1";
    const f = vi.fn(okFetch(fixture));
    expect(await fetchNafGames("34116", f as unknown as typeof fetch)).toEqual([]);
    const store = new NafRecordStore(dir);
    await refreshNafForCoaches(["Jay"], { store, identities: () => ids({ Jay: { nafId: "34116" } }), fetchImpl: f as unknown as typeof fetch });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("refreshNafForCoaches", () => {
  it("fetches opted-in coaches only, then skips under 10 minutes, then refetches", async () => {
    const store = new NafRecordStore(dir);
    const f = vi.fn(okFetch(fixture));
    let t = Date.parse("2026-10-01T10:00:00Z");
    const deps = { store, identities: () => ids({ Jay: { nafId: "34116", nafName: "flutethecat" }, Bob: { nafName: "bob" } }), fetchImpl: f as unknown as typeof fetch, now: () => new Date(t) };
    await refreshNafForCoaches(["Jay", "Bob", "Nobody"], deps);
    expect(f).toHaveBeenCalledTimes(1);
    expect(store.get("34116")).toMatchObject({ nafName: "flutethecat", games: expect.any(Array) });
    t += 9 * 60_000;
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(1);
    t += 2 * 60_000;
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("dedupes concurrent refreshes and never throws on failure", async () => {
    const store = new NafRecordStore(dir);
    const f = vi.fn(okFetch(fixture));
    const deps = { store, identities: () => ids({ Jay: { nafId: "1" } }), fetchImpl: f as unknown as typeof fetch };
    await Promise.all([refreshNafForCoaches(["Jay"], deps), refreshNafForCoaches(["Jay"], deps)]);
    expect(f).toHaveBeenCalledTimes(1);
    const warn = vi.fn();
    await expect(refreshNafForCoaches(["Jay"], { ...deps, identities: () => { throw new Error("boom"); }, warn })).resolves.toBeUndefined();
    const failing = new NafRecordStore(join(dir, "none"));
    await expect(refreshNafForCoaches(["Jay"], { ...deps, store: failing, fetchImpl: (async () => { throw new Error("x"); }) as unknown as typeof fetch })).resolves.toBeUndefined();
  });
});

describe("nafResultRows and the rating", () => {
  it("dedupes the same game cached from both linked coaches", () => {
    const store = new NafRecordStore(dir);
    store.put("1", "teturact", [game()]);
    store.put("2", "flutethecat", [game({ coaches: ["flutethecat", "teturact"], races: ["Amazon", "Human"], score: [0, 1] })]);
    const rows = nafResultRows(store, ids({ Tet: { nafId: "1", nafName: "teturact" }, Jay: { nafId: "2", nafName: "flutethecat" } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("naf");
    expect(rows[0]!.playedAt).toBe("2026-07-25T12:00:00.000Z");
  });
  it("keys a mapped opponent by ffbCoachId and an unknown one as naf:<name>", () => {
    const store = new NafRecordStore(dir);
    store.put("2", "flutethecat", [game({ coaches: ["Teturact", "flutethecat"] }), game({ coaches: ["Stranger", "flutethecat"], date: "2026-07-26" })]);
    const rows = nafResultRows(store, ids({ Jay: { nafId: "2", nafName: "FluteTheCat" }, Tet: { nafId: "9", nafName: "teturact" }, NoOptIn: { nafName: "stranger" } }));
    const byDate = (d: string) => rows.find((r) => r.playedAt!.startsWith(d))!;
    expect([byDate("2026-07-25").home.coach, byDate("2026-07-25").away.coach]).toEqual(["Tet", "Jay"]);
    expect([byDate("2026-07-26").home.coach, byDate("2026-07-26").away.coach]).toEqual(["naf:stranger", "Jay"]);
  });
  it("moves the linked coach's CR and never touches the results store", () => {
    const results = new TournamentResultStore(join(dir, "r"));
    const store = new NafRecordStore(dir);
    const identities = ids({ Jay: { nafId: "2", nafName: "flutethecat" } });
    const asOf = new Date("2026-08-10T00:00:00Z");
    const before = computeGlicko(results.list(), { asOf });
    store.put("2", "flutethecat", [1, 2, 3].map((n) => game({ coaches: [`opp${n}`, "flutethecat"], date: `2026-07-0${n}`, score: [0, 2] })));
    const rows = nafResultRows(store, identities);
    const after = computeGlicko([...results.list(), ...rows], { asOf });
    expect(before.get("jay")).toBeUndefined();
    expect(after.get("jay")!.r).toBeGreaterThan(1500);
    expect(after.get("jay")!.games).toBe(3);
    expect(after.get("naf:opp1")!.r).toBeLessThan(1500);
    expect(results.list()).toEqual([]);
    expect(results.listAll()).toEqual([]);
  });
  it("revision changes when the cache is written", () => {
    const store = new NafRecordStore(dir);
    const a = store.revision();
    store.put("1", "x", [game()]);
    expect(store.revision()).not.toBe(a);
  });
});
