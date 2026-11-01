import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireSession } from "../src/auth/requireSession";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { effectiveInducements, parseInducementConfig, seasonInducementOffers } from "../src/leagues/inducements";
import { customProblem, INDUCEMENT_ICONS, STANDARD_INDUCEMENT_ICON, type InducementTableView, type SeasonInducements } from "../src/leagues/inducementRules";
import { LeagueStore } from "../src/leagues/store";
import type { SeasonRecord } from "../src/leagues/types";
import { tabletopApi, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch";
import { planInducements } from "../src/tabletop/pregame";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";

// League inducement table (src/leagues/inducements.ts): the standard BB2025 dataset with per-season overrides and custom
// types, its organiser-only PUT, the public GET, and the tabletop recorder pricing its pre-game from it. Fake data only.

const season = (n: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  id: `season-${n}`, leagueId: "tabbl", number: n, name: `Season ${n}`, sourceSlug: `season-${n}`, ruleset: "BB2025", status: "active",
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [] }],
  fixtures: [], teams: [], participants: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "manual", ...over,
});
const config = (over: Partial<SeasonInducements> = {}): SeasonInducements => ({ standard: {}, custom: [], revision: 0, ...over });
const keg = { name: "Lucky Keg", price: 25_000, cap: 2, icon: "keg", effectText: "Once per game, reroll one KO recovery roll.", category: "special" };

describe("effective table and validation (pure)", () => {
  it("lists every dataset inducement with its defaults, then the custom types", () => {
    const t = effectiveInducements(undefined);
    expect(t.find((r) => r.id === "bribes")).toMatchObject({ source: "standard", enabled: true, cap: 3, price: 100_000, default: { enabled: true, cap: 3, price: 100_000 }, icon: "bribe" });
    expect(t.find((r) => r.id === "canopic_jar")).toMatchObject({ enabled: false, default: { enabled: false } }); // commissioner opt-in
    expect(t.find((r) => r.id === "star_players")).toMatchObject({ price: null, priceFixed: true, category: "star" });
    const merged = effectiveInducements(config({
      standard: { bribes: { cap: 1, price: 150_000 }, weather_mage: { enabled: false }, canopic_jar: { enabled: true } },
      custom: [{ id: "c-0000abcd", ...keg, category: "special" }],
    }));
    expect(merged.find((r) => r.id === "bribes")).toMatchObject({ cap: 1, price: 150_000, default: { cap: 3, price: 100_000 } });
    expect(merged.find((r) => r.id === "weather_mage")?.enabled).toBe(false);
    expect(merged.find((r) => r.id === "canopic_jar")?.enabled).toBe(true);
    expect(merged.at(-1)).toMatchObject({ id: "c-0000abcd", source: "custom", name: "Lucky Keg", price: 25_000, cap: 2, iconSrc: "/icons/inducements/bloodweiser_keg.png", enabled: true });
  });

  it("every icon is one of our own files, and the standard icons agree with the inducement manifest", () => {
    for (const { src } of Object.values(INDUCEMENT_ICONS)) {
      expect(src).toMatch(/^\/icons\/(inducements|coach-badges|ui|skills)\/[\w-]+\.png$/);
      expect(readFileSync(join(__dirname, "..", "public", src)).length).toBeGreaterThan(0);
    }
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "public", "icons", "inducements", "manifest.json"), "utf8")) as { icons: Record<string, string> };
    for (const [id, path] of Object.entries(manifest.icons)) expect(INDUCEMENT_ICONS[STANDARD_INDUCEMENT_ICON[id]!]?.src, id).toBe(`/${path}`);
  });

  it("validation: caps 0-16, 5,000-gold price steps, unknown ids, names <= 40, effect <= 300, plain text", () => {
    const cur = config();
    const bad = (input: Record<string, unknown>) => expect(() => parseInducementConfig(input, cur), JSON.stringify(input).slice(0, 80)).toThrow();
    bad({ standard: { bribes: { cap: 17 } } });
    bad({ standard: { bribes: { cap: -1 } } });
    bad({ standard: { bribes: { cap: 1.5 } } });
    bad({ standard: { bribes: { price: 12_345 } } });
    bad({ standard: { bribes: { price: 2_005_000 } } });
    bad({ standard: { star_players: { price: 100_000 } } }); // no single price
    bad({ standard: { nope: { cap: 1 } } });
    bad({ standard: { bribes: { cap: 1, colour: "red" } } });
    bad({ standard: JSON.parse('{"__proto__":{"cap":1}}') });
    bad({ custom: [{ ...keg, name: "x".repeat(41) }] });
    bad({ custom: [{ ...keg, effectText: "y".repeat(301) }] });
    bad({ custom: [{ ...keg, name: "Bad\u0007bell" }] });
    bad({ custom: [{ ...keg, name: "Two\nlines" }] });
    bad({ custom: [{ ...keg, icon: "skull-from-elsewhere" }] });
    bad({ custom: [{ ...keg, category: "magic" }] });
    bad({ custom: [{ ...keg, name: "Bribes" }] }); // clashes with a standard inducement
    bad({ custom: [keg, { ...keg, name: "lucky keg" }] }); // twice, any case
    bad({ custom: [{ ...keg, id: "c-12345678" }] }); // an id that is not stored
    bad({ custom: Array.from({ length: 31 }, (_, i) => ({ ...keg, name: `Keg ${i}` })) });
    expect(customProblem({ ...keg, name: "  " })).toMatch(/name/);
    expect(customProblem(keg)).toBe("");
    // effect text may hold newlines; names are trimmed and NFC-normalised
    const ok = parseInducementConfig({ custom: [{ ...keg, name: "  Café Keg ", effectText: "Line one.\r\nLine two." }] }, cur, () => "c-0000aaaa");
    expect(ok.custom[0]).toMatchObject({ id: "c-0000aaaa", name: "Café Keg", effectText: "Line one.\nLine two." });
  });

  it("overrides equal to the dataset value are dropped; custom ids stay stable across edits", () => {
    const first = parseInducementConfig({ standard: { bribes: { enabled: true, cap: 3, price: 100_000 }, weather_mage: { cap: 0 } }, custom: [keg] }, config(), () => "c-0000beef");
    expect(first.standard).toEqual({ weather_mage: { cap: 0 } });
    const stored = config({ ...first, revision: 1 });
    const second = parseInducementConfig({ custom: [{ ...first.custom[0], price: 30_000 }, { ...keg, name: "Second Keg" }] }, stored, () => "c-0000f00d");
    expect(second.custom.map((c) => c.id)).toEqual(["c-0000beef", "c-0000f00d"]);
    expect(second.custom[0]!.price).toBe(30_000);
  });
});

describe("recorder offers from the season table", () => {
  const players = (n: number): TabletopPlayer[] => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P ${i}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
  const file = (race: string): TabletopTeamFile => ({ schema: 1, name: `${race} XI`, race, treasury: 300_000, dedicatedFans: 1, teamValue: 1_000_000, players: players(11) });

  it("applies caps, prices, disables, opt-ins and custom types; restrictions and reduced prices stay", () => {
    const { offers, ids } = seasonInducementOffers(config({
      standard: { bribes: { cap: 2, price: 75_000 }, weather_mage: { enabled: false }, team_mascot: { cap: 0 }, canopic_jar: { enabled: true } },
      custom: [{ id: "c-0000abcd", ...keg, category: "special" }, { id: "c-0000dead", ...keg, name: "Retired Keg", cap: 0, category: "special" }],
    }));
    expect(ids).toContain("c-0000abcd");
    const human = file("Human");
    expect(offers(human, "bribes")).toEqual({ name: "Bribes", price: 75_000, max: 2 });
    expect(offers(file("Goblin"), "bribes")).toEqual({ name: "Bribes", price: 50_000, max: 2 }); // Bribery and Corruption: lower of the two
    expect(offers(human, "weather_mage")).toHaveProperty("error");
    expect(offers(human, "team_mascot")).toHaveProperty("error");
    expect(offers(human, "canopic_jar")).toMatchObject({ price: 50_000 });
    expect(offers(human, "mortuary_assistant")).toHaveProperty("error"); // Masters of Undeath only
    expect(offers(human, "c-0000abcd")).toEqual({ name: "Lucky Keg", price: 25_000, max: 2 });
    expect(offers(human, "c-0000dead")).toHaveProperty("error");
    const plan = planInducements({ file: human, picks: [{ id: "c-0000abcd", qty: 2 }, { id: "bribes", qty: 1 }], role: "favourite", tvDifference: 0, favouriteSpent: 0, offers });
    expect(plan).toMatchObject({ total: 125_000, picks: [{ id: "c-0000abcd", name: "Lucky Keg", qty: 2, cost: 50_000 }, { id: "bribes", cost: 75_000 }] });
    expect(planInducements({ file: human, picks: [{ id: "bribes", qty: 3 }], role: "favourite", tvDifference: 0, favouriteSpent: 0, offers })).toEqual({ error: "Bribes: at most 2." });
  });
});

describe("routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  const deps = (): LeagueApiDeps => ({ store, readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)), now: () => new Date("2026-11-01T12:00:00.000Z") });
  const call = async (method: string, path: string, auth?: { coach: string; admin?: boolean }, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, path, new URLSearchParams(), auth ? { coach: auth.coach, admin: auth.admin ?? false } : undefined, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const P = "/api/leagues/tabbl/seasons/season-2/inducements";
  const JAY = { coach: "Jay" }; // organiser of THIS league only (no global role)
  const BOB = { coach: "Bob" };
  const ROOT = { coach: "Root", admin: true };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-inducements-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "TABBL", slug: "tabbl", organisers: ["Jay"] });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other", slug: "other", organisers: ["Bob"] });
    store.putSeason(season(1, { status: "completed" }));
    store.putSeason(season(2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("GET is public (game rules): the effective table, revision 0, canEdit only for organisers and admins", async () => {
    const anon = await call("GET", P);
    expect(anon.status).toBe(200);
    const v = anon.body as InducementTableView;
    expect(v).toMatchObject({ leagueId: "tabbl", seasonId: "season-2", seasonName: "Season 2", revision: 0, canEdit: false });
    expect(v.table.length).toBeGreaterThan(15);
    expect(((await call("GET", P, BOB)).body as InducementTableView).canEdit).toBe(false); // organiser of another league
    expect(((await call("GET", P, JAY)).body as InducementTableView).canEdit).toBe(true);
    expect(((await call("GET", P, ROOT)).body as InducementTableView).canEdit).toBe(true);
    expect((await call("GET", "/api/leagues/tabbl/seasons/nope/inducements")).status).toBe(404);
    expect((await call("GET", "/api/leagues/nope/seasons/season-2/inducements")).status).toBe(404);
    expect((await call("POST", P, JAY, { revision: 0 })).status).toBe(405);
  });

  it("PUT: anonymous 401, another league's organiser 403, revision 428 / 409, returns the new revision", async () => {
    const put = (rev: number | undefined, over: Record<string, unknown> = {}) => ({ ...(rev === undefined ? {} : { revision: rev }), standard: { bribes: { cap: 2 } }, custom: [keg], ...over });
    expect((await call("PUT", P, undefined, put(0))).status).toBe(401);
    expect((await call("PUT", P, BOB, put(0))).status).toBe(403);
    expect((await call("PUT", P, JAY, put(undefined))).status).toBe(428);
    expect((await call("PUT", P, JAY, put(4))).status).toBe(409);
    expect((await call("PUT", P, JAY, put(0, { standard: { bribes: { cap: 99 } } }))).status).toBe(400);
    expect(store.season("tabbl", "season-2")!.rules?.inducements).toBeUndefined();
    const ok = await call("PUT", P, JAY, put(0));
    expect(ok.status).toBe(200);
    const v = ok.body as InducementTableView;
    expect(v.revision).toBe(1);
    expect(v.updatedBy).toBe("Jay");
    expect(v.table.find((r) => r.id === "bribes")?.cap).toBe(2);
    const id = v.table.at(-1)!.id;
    expect(id).toMatch(/^c-[0-9a-f]{8}$/);
    expect(store.season("tabbl", "season-2")!.rules!.inducements).toMatchObject({ revision: 1, standard: { bribes: { cap: 2 } }, custom: [{ id, name: "Lucky Keg" }] });
    expect((await call("PUT", P, JAY, put(0))).status).toBe(409); // stale now
    // an admin may edit any league; the custom type keeps its id
    const admin = await call("PUT", P, ROOT, { revision: 1, standard: {}, custom: [{ ...keg, id, cap: 1 }] });
    expect(admin.status).toBe(200);
    expect((admin.body as InducementTableView)).toMatchObject({ revision: 2 });
    expect((admin.body as InducementTableView).table.find((r) => r.id === id)?.cap).toBe(1);
    expect((await call("PUT", "/api/leagues/tabbl/seasons/nope/inducements", JAY, put(0))).status).toBe(404);
  });

  it("a new season starts from the previous season's table, at revision 0", async () => {
    await call("PUT", P, JAY, { revision: 0, standard: { bribes: { cap: 2 } }, custom: [keg] });
    const r = await call("POST", "/api/leagues/tabbl/seasons", JAY, { name: "Season 3" });
    expect(r.status).toBe(201);
    const s3 = store.season("tabbl", "season-3")!;
    expect(s3.rules?.inducements).toMatchObject({ revision: 0, standard: { bribes: { cap: 2 } }, custom: [{ name: "Lucky Keg" }] });
  });

  it("the public read passes the session gate anonymously; the write does not", () => {
    const req = (method: string) => ({ method, headers: {} }) as unknown as IncomingMessage;
    expect(requireSession(req("GET"), P, "").kind).toBe("allow");
    expect(requireSession(req("HEAD"), P, "").kind).toBe("allow");
    expect(requireSession(req("PUT"), P, "").kind).toBe("unauthorized");
  });
});

describe("the recorder's inducement picker reads the league season's table", () => {
  let dir = "";
  let repo: FileTabletopRepository;
  let results: TournamentResultStore;
  let leagueConfig: SeasonInducements | undefined;
  let active = true;
  const files: Record<string, TabletopTeamFile> = {};
  const players = (n: number, prefix: string): TabletopPlayer[] =>
    Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
  const team = (race: string, prefix: string, tv: number): TabletopTeamFile => ({ schema: 1, name: `${prefix} XI`, race, treasury: 100_000, dedicatedFans: 2, teamValue: tv, players: players(11, prefix) });
  const deps = (): TabletopApiDeps => ({
    repo, results,
    loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
    isBanned: () => false, drawSeats: () => false, isOrganizer: () => false,
    now: () => new Date("2026-03-01T10:00:00.000Z"),
    rollDie: () => 1,
    leagueInducements: (leagueId, seasonId) => (leagueId === "tabbl" && seasonId === "season-2" ? { config: leagueConfig, active } : undefined),
  });
  const as = async (coach: string, method: string, path: string, b?: unknown): Promise<TabletopResult> =>
    (await tabletopApi(method, path, { coach, method: "discord" }, b, deps(), new URLSearchParams()))!;
  const create = (leagueSeason?: unknown) => as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "full", ...(leagueSeason === undefined ? {} : { leagueSeason }) });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-inducements-tt-"));
    repo = new FileTabletopRepository(join(dir, "tt"));
    results = new TournamentResultStore(join(dir, "results"));
    files["Alice/sv_a"] = team("Human", "a", 1_000_000);
    files["Bob/sv_b"] = team("Black Orc", "b", 1_200_000);
    leagueConfig = config({ standard: { bribes: { price: 80_000, cap: 1 }, weather_mage: { enabled: false } }, custom: [{ id: "c-0000abcd", ...keg, category: "special" }] });
    active = true;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("create checks the season; the menu and the submit use its table (custom types included)", async () => {
    expect((await create({ leagueId: "tabbl" })).status).toBe(400);
    expect((await create({ leagueId: "tabbl", seasonId: "season-9" })).status).toBe(409);
    active = false;
    expect((await create({ leagueId: "tabbl", seasonId: "season-2" })).status).toBe(409);
    active = true;
    const r = await create({ leagueId: "tabbl", seasonId: "season-2" });
    expect(r.status).toBe(201);
    const id = (r.body as { match: { id: string; leagueSeason: unknown } }).match.id;
    expect((r.body as { match: { leagueSeason: unknown } }).match.leagueSeason).toEqual({ leagueId: "tabbl", seasonId: "season-2" });
    for (let i = 0; i < 3; i += 1) expect((await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, {})).status).toBe(200);
    const pg = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { pregame: { step: string; inducementOptions: Record<string, Array<Record<string, unknown>>> } }).pregame;
    expect(pg.step).toBe("inducements");
    const away = pg.inducementOptions.away!;
    expect(away.find((o) => o.id === "bribes")).toMatchObject({ price: 50_000, max: 1 }); // Black Orc: Bribery and Corruption, the lower price; the league cap
    expect(pg.inducementOptions.home!.find((o) => o.id === "bribes")).toMatchObject({ price: 80_000, max: 1 });
    expect(away.some((o) => o.id === "weather_mage")).toBe(false);
    expect(away.find((o) => o.id === "c-0000abcd")).toMatchObject({ name: "Lucky Keg", price: 25_000, max: 2, custom: true, icon: "/icons/inducements/bloodweiser_keg.png", effectText: keg.effectText });
    const sub = await as("Bob", "POST", `/api/tabletop/matches/${id}/pregame/advance`, { team: "away", picks: [{ id: "c-0000abcd", qty: 2 }] });
    expect(sub.status).toBe(200);
    expect((await as("Bob", "POST", `/api/tabletop/matches/${id}/pregame/advance`, { team: "away", picks: [{ id: "weather_mage", qty: 1 }] })).status).toBe(400);
  });

  it("a match without a league season keeps the shared dataset", async () => {
    const r = await create();
    const id = (r.body as { match: { id: string } }).match.id;
    for (let i = 0; i < 3; i += 1) await as("Alice", "POST", `/api/tabletop/matches/${id}/pregame/advance`, {});
    const pg = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { pregame: { inducementOptions: Record<string, Array<Record<string, unknown>>> } }).pregame;
    expect(pg.inducementOptions.home!.find((o) => o.id === "bribes")).toMatchObject({ price: 100_000, max: 3 });
    expect(pg.inducementOptions.home!.some((o) => o.id === "c-0000abcd")).toBe(false);
  });
});
