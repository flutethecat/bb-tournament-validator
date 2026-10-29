import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeGlicko } from "../src/coachGlicko.js";
import {
  fetchNafGames, fetchNafProfile, NafRecordStore, nafResultRows, nafSummaryFor, parseNafCoachPage, parseNafGameList, refreshNafForCoaches, type NafGame, type NafIdentities,
} from "../src/nafRecords.js";
import { deriveTeamResult, TournamentResultStore } from "../src/tournamentResults.js";

const fixture = readFileSync(join(import.meta.dirname, "fixtures", "naf-gamelist-34116.html"), "utf8");
const coachPage = readFileSync(join(import.meta.dirname, "fixtures", "naf-coachpage-34116.html"), "utf8");
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
      coaches: ["teturact", "flutethecat"], coachIds: ["31611", "34116"], races: ["Human", "Amazon"], score: [1, 1],
    });
    expect(games[1]!.score).toEqual([0, 1]);
  });
  it("captures the head2head coach ids in the same order as the names", () => {
    const games = parseNafGameList(fixture);
    expect(games[0]!.coachIds).toEqual(["31611", "34116"]);
    expect(games[3]!.coaches[0]).toBe("flutethecat");
    expect(games[3]!.coachIds).toEqual(["34116", "36728"]);
  });
  const page = (rows: string, head = "<tr><th>Date</th><th>Tournament</th><th>Variant</th><th>Coaches</th><th>Races</th><th>Score</th><th>Result</th></tr>") => `<table>${head}${rows}</table>`;
  const row = (coaches: string, tournament = "T") => `<tr><td>2026-01-02</td><td>${tournament}</td><td>V</td><td>${coaches}</td><td>Orc - Elf</td><td> 2 - 3 </td><td>L</td></tr>`;
  it("returns [] for junk, headerless tables and other tables rows", () => {
    expect(parseNafGameList("<html>nothing</html>")).toEqual([]);
    expect(parseNafGameList(`<table>${row("<a>a - b</a>")}</table>`)).toEqual([]); // same cells, no Games header
    expect(parseNafGameList(`<table><tr><td>Name</td><td>Posts</td></tr>${row("<a>a - b</a>")}</table>`)).toEqual([]); // login / other table
    expect(parseNafGameList(page(row("<a>a - b</a>")).replace("<table>", "<table><tr><td>x</td></tr></table><table>"))).toHaveLength(1);
  });
  it("resolves columns by header, so a reordered table parses", () => {
    const html = "<table><tr><th>Score</th><th>Races</th><th>Coaches</th><th>Tournament</th><th>Date</th></tr><tr><td>2 - 3</td><td>Orc - Elf</td><td>a - b</td><td>Cup</td><td>2026-01-02</td></tr></table>";
    expect(parseNafGameList(html)[0]).toMatchObject({ date: "2026-01-02", tournament: "Cup", coaches: ["a", "b"], score: [2, 3] });
  });
  it("decodes numeric and named entities", () => {
    expect(parseNafGameList(page(row("<a>x&#39;y - Ren&eacute;</a>", "A &amp; B &Eacute;cole")))[0]).toMatchObject({ tournament: "A & B \u00c9cole", coaches: ["x'y", "Ren\u00e9"], score: [2, 3] });
  });
  it("handles a name containing a dash: two anchors, or the hint / ids settle the split", () => {
    const anchors = parseNafGameList(page(row("<a>Ann - Marie</a><a>bob</a>")));
    expect(anchors[0]!.coaches).toEqual(["Ann - Marie", "bob"]);
    const link = '<a href="https://x/index.php?module=NAF&amp;type=head2head&amp;coach1=11&amp;coach2=34116">Ann - Marie - flutethecat</a>';
    expect(parseNafGameList(page(row(link)))).toEqual([]); // ambiguous without a hint
    expect(parseNafGameList(page(row(link)), { nafId: "34116", nafName: "flutethecat" })[0]).toMatchObject({ coaches: ["Ann - Marie", "flutethecat"], coachIds: ["11", "34116"] });
    // the page coach name is learned from the unambiguous rows
    const plain = row('<a href="x?coach1=12&amp;coach2=34116">zed - flutethecat</a>');
    expect(parseNafGameList(page(plain + row(link)), { nafId: "34116" })).toHaveLength(2);
  });
});

describe("parseNafCoachPage", () => {
  it("reads the Global Glicko, the W/T/L record and the NAF name by label from the fixture", () => {
    expect(parseNafCoachPage(coachPage, "2026-10-28T00:00:00.000Z")).toEqual({
      glicko: 1498.5, wins: 29, draws: 16, losses: 17, nafName: "flutethecat", fetchedAt: "2026-10-28T00:00:00.000Z",
    });
  });
  it("leaves out a field whose label is absent, and gives undefined when nothing is found", () => {
    expect(parseNafCoachPage("<table><tr><td>Global Glicko</td><td>1501.25</td></tr></table>")).toMatchObject({ glicko: 1501.25 });
    expect(parseNafCoachPage("<table><tr><td>Global Glicko</td><td>1501.25</td></tr></table>")).not.toHaveProperty("wins");
    expect(parseNafCoachPage("<table><tr><td>Record (W/T/L)</td><td>3/2/1</td></tr></table>")).toMatchObject({ wins: 3, draws: 2, losses: 1 });
    // Only the cell right after the label counts: free text and later columns never feed a number.
    expect(parseNafCoachPage("<p>Record (W/T/L) 3/2/1</p>")).toBeUndefined();
    expect(parseNafCoachPage("<table><tr><td>Global Glicko</td><td>n/a</td><td>86</td></tr></table>")).toBeUndefined();
    expect(parseNafCoachPage("<html><body>maintenance</body></html>")).toBeUndefined();
    expect(parseNafCoachPage("<table><tr><td>Global Glicko</td><td>n/a</td></tr></table>")).toBeUndefined();
  });
  it("fetchNafProfile returns undefined on failure and honours the kill switch", async () => {
    expect(await fetchNafProfile("34116", okFetch(coachPage))).toMatchObject({ glicko: 1498.5 });
    expect(await fetchNafProfile("34116", (async () => new Response("x", { status: 500 })) as unknown as typeof fetch)).toBeUndefined();
    expect(await fetchNafProfile("34116", (async () => { throw new Error("down"); }) as unknown as typeof fetch)).toBeUndefined();
    process.env.NAF_SCRAPE_DISABLED = "1";
    const f = vi.fn(okFetch(coachPage));
    expect(await fetchNafProfile("34116", f as unknown as typeof fetch)).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });
});

describe("coach page in the refresh and the summary", () => {
  const routed = (games: () => Response, page: () => Response): typeof fetch => (async (url: string | URL | Request) => (String(url).includes("type=coachpage") ? page() : games())) as unknown as typeof fetch;
  it("stores the profile after the game list; either one failing leaves the other", async () => {
    const store = new NafRecordStore(dir);
    const calls: string[] = [];
    const f = ((url: string) => { calls.push(String(url).includes("coachpage") ? "page" : "list"); return routed(() => new Response(fixture), () => new Response(coachPage))(url); }) as unknown as typeof fetch;
    await refreshNafForCoaches(["Jay"], { store, identities: () => ids({ Jay: { nafId: "34116", nafName: "flutethecat" } }), fetchImpl: f });
    expect(calls).toEqual(["list", "page"]);
    expect(store.get("34116")).toMatchObject({ profile: { glicko: 1498.5, wins: 29 } });
    expect(store.get("34116")!.games).toHaveLength(20);
    // page down: games still stored, no profile
    const s2 = new NafRecordStore(join(dir, "b"));
    await refreshNafForCoaches(["Jay"], { store: s2, identities: () => ids({ Jay: { nafId: "34116" } }), fetchImpl: routed(() => new Response(fixture), () => new Response("no", { status: 503 })) });
    expect(s2.get("34116")!.games).toHaveLength(20);
    expect(s2.get("34116")!.profile).toBeUndefined();
    // list down: profile still stored, no games, attempt remembered
    const s3 = new NafRecordStore(join(dir, "c"));
    await refreshNafForCoaches(["Jay"], { store: s3, identities: () => ids({ Jay: { nafId: "34116" } }), fetchImpl: routed(() => new Response("no", { status: 503 }), () => new Response(coachPage)) });
    expect(s3.get("34116")).toMatchObject({ games: [], profile: { glicko: 1498.5 } });
    expect(s3.get("34116")!.lastAttemptAt).toBeTruthy();
  });
  it("a later game refresh keeps the stored profile", () => {
    const store = new NafRecordStore(dir);
    store.putProfile("2", "x", { glicko: 1400, fetchedAt: "t" });
    store.put("2", "x", [game()]);
    expect(store.get("2")!.profile).toMatchObject({ glicko: 1400 });
    store.markAttempt("2", "x", "t2");
    expect(store.get("2")!.profile).toMatchObject({ glicko: 1400 });
  });
  it("the summary has the page glicko and a record computed from the cached games", () => {
    const store = new NafRecordStore(dir);
    store.put("34116", "flutethecat", parseNafGameList(fixture));
    const none = nafSummaryFor(store, ids({ Jay: { nafId: "34116" } }), "Jay");
    expect(none.glicko).toBeUndefined();
    expect(none.record!.w + none.record!.d + none.record!.l).toBe(20);
    store.putProfile("34116", "flutethecat", { glicko: 1498.5, fetchedAt: "t" });
    const s = nafSummaryFor(store, ids({ Jay: { nafId: "34116" } }), "Jay");
    expect(s).toMatchObject({ games: 20, glicko: 1498.5 });
    expect(s.record).toEqual(none.record);
    expect(nafSummaryFor(store, ids({ Jay: {} }), "Jay")).toEqual({ games: 0 });
  });
  it("counts W/D/L from the coach side, by id or by name", () => {
    const store = new NafRecordStore(dir);
    store.put("2", "ali", [
      game({ coaches: ["ali", "x"], score: [2, 0] }), // won on the left
      game({ coaches: ["x", "ali"], score: [2, 0], date: "2026-01-02" }), // lost on the right
      game({ coaches: ["ali", "y"], score: [1, 1], date: "2026-01-03" }), // drawn
    ]);
    expect(nafSummaryFor(store, ids({ Jay: { nafId: "2", nafName: "Ali" } }), "Jay").record).toEqual({ w: 1, d: 1, l: 1 });
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
    expect(f).toHaveBeenCalledTimes(2); // the game list and the coach page
    expect(store.get("34116")).toMatchObject({ nafName: "flutethecat", games: expect.any(Array) });
    t += 9 * 60_000;
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(2);
    t += 2 * 60_000;
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(4);
  });
  it("throttles on lastAttemptAt after a failed fetch, keeping the cached games", async () => {
    const store = new NafRecordStore(dir);
    store.put("1", "x", [game()], "2026-10-01T09:00:00.000Z");
    const f = vi.fn((async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    let t = Date.parse("2026-10-01T10:00:00Z");
    const deps = { store, identities: () => ids({ Jay: { nafId: "1", nafName: "x" } }), fetchImpl: f, now: () => new Date(t) };
    await refreshNafForCoaches(["Jay"], deps);
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(2); // the failed attempt is remembered
    expect(store.get("1")).toMatchObject({ fetchedAt: "2026-10-01T09:00:00.000Z", lastAttemptAt: "2026-10-01T10:00:00.000Z", games: [expect.anything()] });
    t += 11 * 60_000;
    await refreshNafForCoaches(["Jay"], deps);
    expect(f).toHaveBeenCalledTimes(4);
  });
  it("a failing store write after a successful fetch does not throw", async () => {
    class Broken extends NafRecordStore { override put(): never { throw new Error("disk full"); } }
    const warn = vi.fn();
    await expect(refreshNafForCoaches(["Jay"], { store: new Broken(dir), identities: () => ids({ Jay: { nafId: "5" } }), fetchImpl: okFetch(fixture), warn })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("disk full"));
  });
  it("prunes records of nafIds that are no longer linked, and caps games per coach", async () => {
    const store = new NafRecordStore(dir);
    store.put("99", "gone", [game()]);
    await refreshNafForCoaches(["Jay"], { store, identities: () => ids({ Jay: { nafId: "5" } }), fetchImpl: okFetch(fixture) });
    expect(store.get("99")).toBeUndefined();
    expect(store.get("5")!.games).toHaveLength(20);
    store.put("6", "big", Array.from({ length: 1200 }, (_, n) => game({ date: "2026-01-01", tournament: `t${n}` })));
    expect(store.get("6")!.games).toHaveLength(1000);
  });
  it("dedupes concurrent refreshes and never throws on failure", async () => {
    const store = new NafRecordStore(dir);
    const f = vi.fn(okFetch(fixture));
    const deps = { store, identities: () => ids({ Jay: { nafId: "1" } }), fetchImpl: f as unknown as typeof fetch };
    await Promise.all([refreshNafForCoaches(["Jay"], deps), refreshNafForCoaches(["Jay"], deps)]);
    expect(f).toHaveBeenCalledTimes(2);
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
  it("maps the owner by NAF id even with an empty nafName", () => {
    const store = new NafRecordStore(dir);
    store.put("34116", "", parseNafGameList(fixture).slice(0, 3));
    const rows = nafResultRows(store, ids({ Jay: { nafId: "34116" }, Tet: { nafId: "31611", nafName: "Teturact" } }));
    const first = rows.find((r) => r.home.teamName === "Human")!;
    expect([first.home.coach, first.away.coach]).toEqual(["Tet", "Jay"]);
    const other = rows.find((r) => r.home.teamName === "Orc")!;
    expect([other.home.coach, other.away.coach]).toEqual(["naf:papafreelove", "Jay"]);
  });
  it("falls back to the one name common to every game when the page carries no ids", () => {
    const store = new NafRecordStore(dir);
    store.put("2", "", [game({ coaches: ["a", "FluteTheCat"] }), game({ coaches: ["FluteTheCat", "b"], date: "2026-07-26" })]);
    const rows = nafResultRows(store, ids({ Jay: { nafId: "2" } }));
    expect(rows.flatMap((r) => [r.home.coach, r.away.coach]).filter((c) => c === "Jay")).toHaveLength(2);
    store.put("3", "", [game({ coaches: ["a", "b"] }), game({ coaches: ["b", "a"], date: "2026-07-27" })]); // two common names: no page coach
    expect(nafResultRows(store, ids({ Jay: { nafId: "3" } })).every((r) => r.home.coach.startsWith("naf:") && r.away.coach.startsWith("naf:"))).toBe(true);
  });
  it("dedupes whichever linked coach cache comes first", () => {
    const a = game();
    const b = game({ coaches: ["flutethecat", "teturact"], races: ["Amazon", "Human"], score: [0, 1] });
    const link = { Tet: { nafId: "1", nafName: "teturact" }, Jay: { nafId: "2", nafName: "flutethecat" } };
    const s1 = new NafRecordStore(join(dir, "a")); s1.put("1", "teturact", [a]); s1.put("2", "flutethecat", [b]);
    const s2 = new NafRecordStore(join(dir, "b")); s2.put("2", "flutethecat", [b]); s2.put("1", "teturact", [a]);
    expect(nafResultRows(s1, ids(link))).toHaveLength(1);
    expect(nafResultRows(s2, ids(link))).toHaveLength(1);
    expect(nafResultRows(s1, ids(link))[0]!.gameId).toBe(nafResultRows(s2, ids(link))[0]!.gameId);
  });
  it("skips a malformed cache record and bad games instead of dropping every NAF row", () => {
    writeFileSync(join(dir, "naf-games.json"), JSON.stringify({ version: 1, coaches: {
      "1": { nafId: "1", nafName: "ok", fetchedAt: "2026-01-01T00:00:00Z", games: [game(), { date: "nope" }, null, game({ score: [-1, 2] })] },
      "2": { nafId: "2", nafName: 5, games: "x" },
      abc: { nafId: "abc", nafName: "", fetchedAt: "", games: [] },
      "3": null,
    } }));
    const store = new NafRecordStore(dir);
    expect(store.listAll().map((r) => r.nafId)).toEqual(["1"]);
    expect(nafResultRows(store, ids({ A: { nafId: "1" }, B: { nafId: "2" } }))).toHaveLength(1);
  });
  it("a NAF row W/D/L comes out of deriveTeamResult as the score says", () => {
    const store = new NafRecordStore(dir);
    store.put("2", "flutethecat", [game({ score: [2, 0], date: "2026-07-01" }), game({ score: [1, 1], date: "2026-07-02" }), game({ score: [0, 3], date: "2026-07-03" })]);
    const outcomes = nafResultRows(store, ids({ Jay: { nafId: "2" } })).sort((x, y) => x.playedAt!.localeCompare(y.playedAt!)).map((r) => deriveTeamResult(r.teams[0]!, r.teams[1]!).outcome);
    expect(outcomes).toEqual(["won", "drawn", "lost"]);
  });
  it("games of a coach unlinked since stop counting", () => {
    const store = new NafRecordStore(dir);
    store.put("2", "flutethecat", [game()]);
    expect(nafResultRows(store, ids({ Jay: { nafId: "2" } }))).toHaveLength(1);
    expect(nafResultRows(store, ids({ Jay: { nafName: "flutethecat" } }))).toHaveLength(0);
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
