import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forkFixtureNotices, leagueApi, requestRevision, resetForkToggleLimit, seasonForViewer, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { buildMilestonePost, buildTestPost, isDiscordWebhookUrl, maskWebhookUrl, type DiscordPayload } from "../src/leagues/discord";
import { csvCell, leagueCsvFiles, unzipStored, zipFiles, crc32 } from "../src/leagues/exportZip";
import { datasetRosters, normalisePostcode, parseAddress, SettingsError, teamBuildingTable } from "../src/leagues/settings";
import { LeagueStore } from "../src/leagues/store";
import type { LeagueFixture, SeasonRecord } from "../src/leagues/types";
import { resetAvatarRateLimit } from "../src/teamAvatars";

// League settings (src/leagues/settings.ts, discord.ts, exportZip.ts and the settings routes in api.ts).

const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz_ABCDEF-123";

const fx = (id: string, over: Partial<LeagueFixture> = {}): LeagueFixture => ({
  id, category: "Season", phase: "Regular", phaseId: "season-regular", group: "", round: 1, table: 1,
  home: { team: "Orcs", coach: "Ann", coachId: "Ann", race: "Orc", score: null, cas: null, conceded: false },
  away: { team: "Elves", coach: "Bob", coachId: "Bob", race: "Wood Elf", score: null, cas: null, conceded: false },
  suspended: false, ...over,
});

const season = (number: number, status: "active" | "completed", fixtures: LeagueFixture[] = []): SeasonRecord => ({
  id: `season-${number}`, leagueId: "tabbl", number, name: `Season ${number}`, sourceSlug: `s${number}`, ruleset: "BB2025", status,
  phases: [{ id: "season-regular", category: "Season", name: "Regular", groups: [""], standings: [
    { group: "", rank: 1, team: "Orcs", race: "Orc", coach: "Ann", points: 3, played: 1, wins: 1, draws: 0, losses: 0, tdFor: 2, tdAgainst: 1, casFor: 1, casAgainst: 0,
      injuriesFor: 0, injuriesAgainst: 0, completions: 0, interceptions: 0, deathsFor: 0, deathsAgainst: 0, foulsFor: 0, foulsAgainst: 0, sentOffsFor: 0, sentOffsAgainst: 0, secretObjectives: 0, buchholz: 0 },
  ] }],
  fixtures, teams: [{ id: "orcs", name: "Orcs", race: "Orc", coach: "Ann", teamValue: 1000000, treasury: 10000, rerolls: 2, fans: 1, assistantCoaches: 0, cheerleaders: 0, apothecary: true, tier: "1", raceLeague: "", players: [], formerPlayers: [] }],
  participants: [{ coach: "Ann", country: "US", race: "Orc", team: "Orcs", active: true }],
  honours: [{ key: "season-mosttouchdowns", category: "season", stat: "mosttouchdowns", kind: "player", rows: [{ rank: 1, name: "=HYPERLINK(\"x\")", team: "Orcs", coach: "Ann", value: 3 }] }],
  awards: [{ category: "Season", type: "Overall Champion", name: "", description: "Won, \"easily\"", coach: "Ann", team: "Orcs", race: "Orc", goldenStar: false }],
  unattributedStats: [], importedAt: "2026-10-30T00:00:00.000Z", source: "tourplay-export",
});

describe("address, webhook and export helpers", () => {
  it("US ZIP (5 or 5-4) and Canadian postal codes (case and space tolerant), region per country", () => {
    expect(normalisePostcode("US", "98101")).toBe("98101");
    expect(normalisePostcode("US", " 98101-1234 ")).toBe("98101-1234");
    expect(normalisePostcode("US", "9810")).toBeUndefined();
    expect(normalisePostcode("US", "98101-12")).toBeUndefined();
    expect(normalisePostcode("CA", "k1a0b1")).toBe("K1A 0B1");
    expect(normalisePostcode("CA", "V6B 4Y8")).toBe("V6B 4Y8");
    expect(normalisePostcode("CA", "D1A 0B1")).toBeUndefined(); // D never used
    expect(normalisePostcode("CA", "98101")).toBeUndefined();
    expect(parseAddress({ country: "CA", region: "bc", postcode: "v6b4y8", locality: "Vancouver", street: "1 Main St" }))
      .toEqual({ country: "CA", region: "BC", postcode: "V6B 4Y8", locality: "Vancouver", street: "1 Main St" });
    expect(() => parseAddress({ country: "US", region: "BC" })).toThrow("Pick a US state.");
    expect(() => parseAddress({ country: "CA", region: "WA" })).toThrow("Pick a Canadian province");
    expect(() => parseAddress({ country: "US", region: "WA", postcode: "K1A 0B1" })).toThrow(/ZIP code/);
    expect(() => parseAddress({ country: "MX" })).toThrow(SettingsError);
  });

  it("webhook URL check, masking, test and milestone payloads (mentions off)", () => {
    expect(isDiscordWebhookUrl(HOOK)).toBe(true);
    expect(isDiscordWebhookUrl(HOOK.replace("discord.com", "discordapp.com"))).toBe(true);
    expect(isDiscordWebhookUrl("http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isDiscordWebhookUrl("https://evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(isDiscordWebhookUrl("https://discord.com.evil.test/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(maskWebhookUrl(HOOK)).toBe("https://discord.com/api/webhooks/…/•••");
    expect(maskWebhookUrl(undefined)).toBe("");
    const post = buildTestPost({ name: "TABBL", fullName: "Tahoma Area Blood Bowl League" }, "Jay");
    expect(post.allowed_mentions).toEqual({ parse: [] });
    expect(post.embeds[0]!.title).toBe("TABBL: Discord connected");
    expect(post.embeds[0]!.description).toContain("Jay connected Tahoma Area Blood Bowl League");
    expect(JSON.stringify(post)).not.toContain("webhooks");
    expect(buildMilestonePost({ name: "TABBL" }, "season-started", "Season 7", "BB2025").embeds[0]!.title).toBe("TABBL: Season 7 has started");
  });

  it("CSV cells: quoting and formula defusing; zip round trip with CRC", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(null)).toBe("");
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    const zip = zipFiles({ "a.csv": "x,y\r\n", "b.csv": "é\r\n" });
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(unzipStored(zip)).toEqual({ "a.csv": "x,y\r\n", "b.csv": "é\r\n" });
  });

  it("team building table: every dataset roster, saved rows win, defaults from the dataset tiers", () => {
    const rosters = datasetRosters();
    expect(rosters.length).toBeGreaterThan(25);
    expect(rosters.find((r) => r.roster === "Black Orc")!.tier).toBe(2);
    const t = teamBuildingTable({ rules: { teamBuilding: { rosters: [{ roster: "Orc", tier: 5, treasury: 1100, startingSkills: { primary: 1, secondary: 0, elite: 2 } }], eliteSkills: ["Block"] } } });
    expect(t.rosters).toHaveLength(rosters.length);
    expect(t.rosters.find((r) => r.roster === "Orc")).toEqual({ roster: "Orc", tier: 5, treasury: 1100, startingSkills: { primary: 1, secondary: 0, elite: 2 } });
    expect(t.rosters.find((r) => r.roster === "Amazon")).toMatchObject({ tier: 1, treasury: 1000, startingSkills: { primary: 0, secondary: 0, elite: 0 } });
    expect(teamBuildingTable(undefined).eliteSkills).toEqual(["Block", "Guard", "Mighty Blow", "Dodge"]);
  });
});

describe("league settings routes", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  const posts: Array<{ url: string; payload: DiscordPayload }> = [];
  const notes: Array<{ coach: string; title: string; body: string }> = [];
  let postOk = true;
  let clock = "2026-10-30T12:00:00Z";
  const RAW = Symbol("raw body");
  const IDENTITIES = [
    { coach: "Jay", level: "organizer" }, { coach: "Kainis", level: "player" }, { coach: "Ann", level: "player" }, { coach: "Bob", level: "player" },
    { coach: "Root", level: "admin" }, { coach: "Gone", level: "player", banned: true },
  ];
  const deps = (): LeagueApiDeps => ({
    store,
    readBody: async () => (body === undefined ? Buffer.alloc(0) : Buffer.from(typeof body === "string" ? body : JSON.stringify(body))),
    now: () => new Date(clock),
    identities: () => IDENTITIES,
    notify: (coach, input) => { notes.push({ coach, title: input.title, body: input.body }); },
    postWebhook: async (url, payload) => { posts.push({ url, payload }); return { ok: postOk, status: postOk ? 204 : 404 }; },
  });
  const JAY = { coach: "Jay", admin: false };
  const ROOT = { coach: "Root", admin: true };
  const MALLORY = { coach: "Mallory", admin: false };
  // A settings PATCH carries the current revision unless the test sends { [RAW]: body } to control it.
  const call = async (method: string, path: string, auth?: { coach: string; admin: boolean }, b?: unknown, q = ""): Promise<LeagueApiResult> => {
    const raw = b && typeof b === "object" && RAW in (b as object) ? (b as Record<symbol, unknown>)[RAW] : undefined;
    body = raw !== undefined ? raw
      : method === "PATCH" && path.endsWith("/settings") && b && typeof b === "object" && !("revision" in (b as object)) ? { revision: store.league("tabbl")?.revision ?? 0, ...(b as object) } : b;
    const r = await leagueApi(method, path, new URLSearchParams(q), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${path}`);
    return r;
  };
  const settings = (r: LeagueApiResult) => (r.body as { settings: Record<string, any> }).settings;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "league-settings-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "tabbl", name: "TABBL", fullName: "Tahoma Area Blood Bowl League", slug: "tabbl", organisers: ["Jay"] });
    store.putSeason(season(5, "completed", [fx("f1", { home: { ...fx("x").home, score: 2, cas: 1 }, away: { ...fx("x").away, score: 1, cas: 0 } })]));
    store.putSeason(season(6, "active", [fx("f2")]));
    posts.length = 0;
    notes.length = 0;
    postOk = true;
    resetAvatarRateLimit();
    resetForkToggleLimit();
    clock = "2026-10-30T12:00:00Z";
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gating: anonymous 401, non-organiser 403, organiser and admin may read; no-store", async () => {
    for (const [method, path] of [["GET", "/api/leagues/tabbl/settings"], ["PATCH", "/api/leagues/tabbl/settings"], ["POST", "/api/leagues/tabbl/seasons"],
      ["GET", "/api/leagues/tabbl/export.zip"], ["POST", "/api/leagues/tabbl/discord/test"], ["PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2"],
      ["POST", "/api/leagues/tabbl/seasons/season-6/finish"]] as const) {
      expect((await call(method, path, undefined, {})).status, `${method} ${path} anon`).toBe(401);
      expect((await call(method, path, MALLORY, {})).status, `${method} ${path} mallory`).toBe(403);
    }
    expect((await call("GET", "/api/leagues/nope/settings", JAY)).status).toBe(404);
    const mine = await call("GET", "/api/leagues/tabbl/settings", JAY);
    expect(mine.status).toBe(200);
    expect(mine.headers?.["cache-control"]).toBe("no-store");
    expect(settings(mine)).toMatchObject({
      revision: 0, information: { name: "TABBL", ruleset: "BB2025", mode: "individual", address: null },
      permissions: { owner: "Jay", organisers: [], admins: ["Root"], canEditOrganisers: true, canChangeOwner: false },
      connections: { playOnFork: false, discord: { configured: false, maskedUrl: "" }, naf: { available: false } },
      teamBuilding: { seasonId: "season-6" },
    });
    expect((await call("GET", "/api/leagues/tabbl/settings", ROOT)).status).toBe(200);
    // the public league read stays public and carries no settings
    const pub = (await call("GET", "/api/leagues/tabbl")).body as { league: Record<string, unknown> };
    expect(pub.league.playOnFork).toBe(false);
    expect(pub.league).not.toHaveProperty("registrations");
    expect(pub.league).not.toHaveProperty("revision");
  });

  it("PATCH validation: information + address, registrations, revision conflict, nothing written on a bad section", async () => {
    const ok = await call("PATCH", "/api/leagues/tabbl/settings", JAY, {
      revision: 0,
      information: { name: " TABBL ", fullName: "Tahoma Area BBL", description: "Weekly.", ruleset: "BB2025", mode: "individual", address: { country: "US", region: "wa", postcode: "98101", locality: "Seattle", street: "" } },
      registrations: { allowRegistration: true, maxRegistrations: 24, maxPerRace: 2, allowedRosters: { unofficial: true } },
    });
    expect(ok.status).toBe(200);
    expect(settings(ok)).toMatchObject({ revision: 1, information: { fullName: "Tahoma Area BBL", address: { region: "WA", postcode: "98101" } }, registrations: { allowRegistration: true, maxRegistrations: 24, maxPerRace: 2, allowedRosters: { official: true, nafApproved: true, unofficial: true } } });
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: 0, information: { name: "X" } })).status).toBe(409);
    const bad = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { revision: 1, information: { name: "Renamed" }, registrations: { maxPerRace: 99 } });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ field: "Max per race" });
    expect(store.league("tabbl")!.name).toBe("TABBL"); // the valid section was not applied either
    const zip = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { information: { address: { country: "CA", region: "ON", postcode: "12345" } } });
    expect(zip.status).toBe(400);
    expect((zip.body as { error: string }).error).toContain("A1A 1A1");
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { information: { name: "" } })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { registrations: { allowedRosters: { official: false, nafApproved: false, unofficial: false } } })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, "not json")).status).toBe(400);
    // admin may patch too
    expect((await call("PATCH", "/api/leagues/tabbl/settings", ROOT, { registrations: { hideTeamComposition: true } })).status).toBe(200);
  });

  it("administration: owner adds / removes organisers by identity name; only an admin changes the owner", async () => {
    const add = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "kainis" } });
    expect(add.status).toBe(200);
    expect(settings(add).permissions.organisers).toEqual(["Kainis"]); // the identity's spelling
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "Nobody" } })).body).toMatchObject({ error: 'No coach called "Nobody".' });
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "Gone" } })).status).toBe(400); // banned
    // Kainis (organiser, not owner) can read the settings but not change the organisers
    expect((await call("GET", "/api/leagues/tabbl/settings", { coach: "Kainis", admin: false })).status).toBe(200);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", { coach: "Kainis", admin: false }, { administration: { removeOrganiser: "Jay" } })).status).toBe(403);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { removeOrganiser: "Jay" } })).status).toBe(400); // the owner
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { owner: "Kainis" } })).status).toBe(403);
    const own = await call("PATCH", "/api/leagues/tabbl/settings", ROOT, { administration: { owner: "Kainis" } });
    expect(settings(own).permissions).toMatchObject({ owner: "Kainis", organisers: ["Jay"] });
    const rm = await call("PATCH", "/api/leagues/tabbl/settings", ROOT, { administration: { removeOrganiser: "jay" } });
    expect(settings(rm).permissions.organisers).toEqual([]);
    expect((await call("GET", "/api/leagues/tabbl/settings", JAY)).status).toBe(403);
  });

  it("team building: saved on the season's rules, validated per row", async () => {
    const rows = [{ roster: "Orc", tier: 3, treasury: 1150, startingSkills: { primary: 2, secondary: 1, elite: 1 } }];
    const r = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { teamBuilding: { seasonId: "season-6", rosters: rows } });
    expect(r.status).toBe(200);
    expect(store.season("tabbl", "season-6")!.rules!.teamBuilding).toMatchObject({ rosters: rows, eliteSkills: ["Block", "Guard", "Mighty Blow", "Dodge"], updatedBy: "Jay" });
    expect(settings(r).teamBuilding.rules.rosters.find((x: { roster: string }) => x.roster === "Orc")).toEqual(rows[0]);
    for (const bad of [{ ...rows[0], tier: 7 }, { ...rows[0], roster: "Martians" }, { ...rows[0], startingSkills: { primary: 7 } }, { ...rows[0], treasury: 1.5 }])
      expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { teamBuilding: { seasonId: "season-6", rosters: [bad] } })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { teamBuilding: { seasonId: "season-6", rosters: [rows[0], rows[0]] } })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { teamBuilding: { seasonId: "season-9", rosters: rows } })).status).toBe(404);
    expect(settings(await call("GET", "/api/leagues/tabbl/settings", JAY, undefined, "season=season-5")).teamBuilding.seasonId).toBe("season-5");
  });

  it("seasons: start refuses while one is open; finish, then start copies the team building rules", async () => {
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { teamBuilding: { seasonId: "season-6", rosters: [{ roster: "Orc", tier: 4, treasury: 1000, startingSkills: { primary: 1, secondary: 0, elite: 0 } }] } });
    expect((await call("POST", "/api/leagues/tabbl/seasons", JAY, { name: "Season 7" })).status).toBe(409);
    const fin = await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", JAY);
    expect(fin.status).toBe(200);
    expect(store.season("tabbl", "season-6")).toMatchObject({ status: "completed", endedAt: "2026-10-30T12:00:00.000Z" });
    expect((await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", JAY)).status).toBe(409);
    expect((await call("POST", "/api/leagues/tabbl/seasons", JAY, { ruleset: "BB2016" })).status).toBe(400);
    const made = await call("POST", "/api/leagues/tabbl/seasons", JAY, { name: "Season Seven", ruleset: "BB2025" });
    expect(made.status).toBe(201);
    expect((made.body as { season: { id: string; number: number } }).season).toMatchObject({ id: "season-7", number: 7, name: "Season Seven", status: "active", ruleset: "BB2025" });
    const s7 = store.season("tabbl", "season-7")!;
    expect(s7).toMatchObject({ source: "manual", phases: [{ id: "season-regular" }], fixtures: [], teams: [] });
    expect(s7.rules!.teamBuilding!.rosters).toEqual([{ roster: "Orc", tier: 4, treasury: 1000, startingSkills: { primary: 1, secondary: 0, elite: 0 } }]);
    expect(store.seasons("tabbl").map((s) => s.id)).toEqual(["season-7", "season-6", "season-5"]);
  });

  it("Discord: URL validated, stored in secrets.json, masked on read, never echoed; test post; milestone posts", async () => {
    const bad = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { connections: { discord: { url: "https://evil.test/hook-secret-value" } } });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).not.toContain("hook-secret-value");
    expect((await call("POST", "/api/leagues/tabbl/discord/test", JAY)).status).toBe(409);
    const set = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { connections: { discord: { url: HOOK, events: { matchStarted: true, news: false } } } });
    expect(set.status).toBe(200);
    expect(settings(set).connections.discord).toEqual({ configured: true, maskedUrl: "https://discord.com/api/webhooks/…/•••", events: { news: false, fixtureCreated: true, matchStarted: true, matchResult: true, milestones: true } });
    expect(JSON.stringify(set.body)).not.toContain("123456789012345678");
    expect(JSON.stringify((await call("GET", "/api/leagues/tabbl/settings", JAY)).body)).not.toContain("abcdefghijklmnop");
    expect(readFileSync(join(dir, "leagues", "tabbl", "league.json"), "utf8")).not.toContain("webhooks");
    expect(JSON.parse(readFileSync(join(dir, "leagues", "tabbl", "secrets.json"), "utf8"))).toEqual({ discordWebhookUrl: HOOK });
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const test = await call("POST", "/api/leagues/tabbl/discord/test", JAY);
    expect(test.status).toBe(200);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(HOOK);
    expect(posts[0]!.payload.embeds[0]!.title).toBe("TABBL: Discord connected");
    postOk = false;
    const fail = await call("POST", "/api/leagues/tabbl/discord/test", JAY);
    expect(fail.status).toBe(502);
    expect(JSON.stringify(fail.body)).not.toContain("webhooks");
    for (const spy of [log, err]) for (const c of spy.mock.calls) expect(JSON.stringify(c)).not.toContain("abcdefghijklmnop");
    log.mockRestore(); err.mockRestore();
    postOk = true;
    posts.length = 0;
    await call("POST", "/api/leagues/tabbl/seasons/season-6/finish", JAY);
    expect(posts.map((p) => p.payload.embeds[0]!.title)).toEqual(["TABBL: Season 6 is finished"]);
    const clear = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { connections: { discord: { url: null } } });
    expect(settings(clear).connections.discord).toMatchObject({ configured: false, maskedUrl: "" });
    expect(store.secrets("tabbl")).toEqual({});
  });

  it("export.zip: the six CSVs across seasons (or one), formula cells defused", async () => {
    const r = await call("GET", "/api/leagues/tabbl/export.zip", JAY);
    expect(r.status).toBe(200);
    expect(r.download).toMatchObject({ contentType: "application/zip", filename: "tabbl-results.zip" });
    const files = unzipStored(r.download!.bytes);
    expect(Object.keys(files).sort()).toEqual(["tabbl-awards.csv", "tabbl-fixtures.csv", "tabbl-honours.csv", "tabbl-participants.csv", "tabbl-standings.csv", "tabbl-teams.csv"]);
    expect(files["tabbl-fixtures.csv"]!.split("\r\n")[0]).toContain("home_team,home_coach");
    expect(files["tabbl-fixtures.csv"]).toContain("5,Season 5,BB2025,f1,Season,Regular,,1,1,Orcs,Ann,Orc,2,1,no,Elves,Bob,Wood Elf,1,0,no,win");
    expect(files["tabbl-honours.csv"]).toContain(`"'=HYPERLINK(""x"")"`);
    expect(files["tabbl-awards.csv"]).toContain('"Won, ""easily"""');
    expect(files["tabbl-teams.csv"]!.trim().split("\r\n")).toHaveLength(3); // header + one team in each season
    const one = await call("GET", "/api/leagues/tabbl/export.zip", ROOT, undefined, "season=season-6");
    expect(one.download!.filename).toBe("tabbl-results-season-6.zip");
    expect(unzipStored(one.download!.bytes)["tabbl-teams.csv"]!.trim().split("\r\n")).toHaveLength(2);
    expect((await call("GET", "/api/leagues/tabbl/export.zip", JAY, undefined, "season=nope")).status).toBe(404);
    expect(Object.keys(leagueCsvFiles(store.league("tabbl")!, []))).toHaveLength(6);
  });

  it("Play on Super FUMBBL: league toggle gates the fixture flag; flipping on notifies the coaches and the league admins", async () => {
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: true })).status).toBe(409);
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "Kainis" }, connections: { playOnFork: true } });
    expect(store.league("tabbl")!.playOnFork).toBe(true);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: "yes" })).status).toBe(400);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/nope", JAY, { forkEnabled: true })).status).toBe(404);
    const on = await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: true });
    expect(on.status).toBe(200);
    expect(store.season("tabbl", "season-6")!.fixtures[0]!.forkEnabled).toBe(true);
    expect(notes.map((n) => [n.coach, n.title])).toEqual([
      ["Ann", "Play on Super FUMBBL"], ["Bob", "Play on Super FUMBBL"],
      ["Kainis", "Super FUMBBL allowed for a fixture"], ["Root", "Super FUMBBL allowed for a fixture"],
    ]);
    expect(notes[0]!.body).toBe("Jay has invited you to play your match on Super FUMBBL (TABBL: Orcs vs Elves).");
    notes.length = 0;
    await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: true });
    expect(notes).toHaveLength(0); // already on: no repeat
    await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: false });
    expect(store.season("tabbl", "season-6")!.fixtures[0]).not.toHaveProperty("forkEnabled");
    // a coach who plays in the fixture invites only the opponent
    const list = forkFixtureNotices(store.league("tabbl")!, "season-6", fx("f9"), "Ann", []);
    expect(list.map((n) => n.coach)).toEqual(["Bob", "Jay", "Kainis"]);
    // an unmapped side (no coachId) is not notified
    expect(forkFixtureNotices(store.league("tabbl")!, "season-6", fx("f9", { away: { ...fx("x").away, coachId: undefined } }), "Root", []).map((n) => n.coach)).toEqual(["Ann", "Jay", "Kainis"]);
  });
  // ---- review regressions (Sol 6.1, 10-30) ----

  it("[P1] a slow PATCH from an organiser removed meanwhile is refused and cannot restore them", async () => {
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "Bob" } });
    expect(store.league("tabbl")!.organisers).toEqual(["Jay", "Bob"]);
    let release!: (b: Buffer) => void;
    const slowBody = new Promise<Buffer>((r) => { release = r; });
    const rev = store.league("tabbl")!.revision!;
    // Bob starts a request whose body arrives late...
    const pending = leagueApi("PATCH", "/api/leagues/tabbl/settings", new URLSearchParams(), { coach: "Bob", admin: false }, { ...deps(), readBody: () => slowBody });
    // ...meanwhile the owner removes Bob.
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { removeOrganiser: "Bob" } })).status).toBe(200);
    release(Buffer.from(JSON.stringify({ revision: rev, administration: {} })));
    const late = await pending;
    expect(late!.status).toBe(403);
    expect(store.league("tabbl")!.organisers).toEqual(["Jay"]);
    // An empty administration section from a still-authorised organiser never rewrites membership.
    const before = store.league("tabbl")!.organisers;
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: {}, registrations: { hideTeamComposition: false } })).status).toBe(200);
    expect(store.league("tabbl")!.organisers).toEqual(before);
  });

  it("[P1] a slow PATCH is judged against the league as it is when the body arrives (stale revision: 409)", async () => {
    let release!: (b: Buffer) => void;
    const slowBody = new Promise<Buffer>((r) => { release = r; });
    const pending = leagueApi("PATCH", "/api/leagues/tabbl/settings", new URLSearchParams(), JAY, { ...deps(), readBody: () => slowBody });
    expect((await call("PATCH", "/api/leagues/tabbl/settings", ROOT, { information: { fullName: "Changed by the admin" } })).status).toBe(200);
    release(Buffer.from(JSON.stringify({ revision: 0, information: { fullName: "Stale" } })));
    expect((await pending)!.status).toBe(409);
    expect(store.league("tabbl")!.fullName).toBe("Changed by the admin");
  });

  it("[P2] every settings PATCH names a revision: 428 when missing, If-Match accepted, 409 when stale, 400 when malformed", async () => {
    const none = await call("PATCH", "/api/leagues/tabbl/settings", JAY, { [RAW]: { information: { fullName: "No revision" } } });
    expect(none.status).toBe(428);
    expect(store.league("tabbl")!.fullName).toBe("Tahoma Area Blood Bowl League");
    const viaHeader = await leagueApi("PATCH", "/api/leagues/tabbl/settings", new URLSearchParams(), JAY,
      { ...deps(), readBody: async () => Buffer.from(JSON.stringify({ information: { fullName: "Via If-Match" } })), ifMatch: "\"0\"" });
    expect(viaHeader!.status).toBe(200);
    expect(store.league("tabbl")!.fullName).toBe("Via If-Match");
    const staleHeader = await leagueApi("PATCH", "/api/leagues/tabbl/settings", new URLSearchParams(), JAY,
      { ...deps(), readBody: async () => Buffer.from(JSON.stringify({ information: { fullName: "Stale" } })), ifMatch: "W/\"0\"" });
    expect(staleHeader!.status).toBe(409);
    expect((await call("PATCH", "/api/leagues/tabbl/settings", JAY, { [RAW]: { revision: "1", information: { fullName: "x" } } })).status).toBe(400);
    expect(requestRevision({}, "*")).toBe("bad");
    expect(requestRevision({}, undefined)).toBe("missing");
    expect(requestRevision({ revision: 4 }, "\"9\"")).toBe(4);
    expect((await call("GET", "/api/leagues/tabbl/settings", JAY)).headers?.etag).toBe("\"1\"");
  });

  it("[P2] hide team composition: anonymous and other coaches get counts only, the team's own coach sees it, organisers see all", async () => {
    const s6 = store.season("tabbl", "season-6")!;
    const stats = { td: 1, cas: 0, mvp: 0, int: 0, completions: 0, fouls: 0, injuries: 0, sentOffs: 0, spp: 3, performance: 0 };
    const player = { playerId: "p-1", number: 1, name: "Grok", position: "Blitzer", ma: 6, st: 3, ag: 3, pa: 4, av: 9, skills: ["Block"], value: 85000, level: "Rookie", availableSpp: 0, niggling: 0, missNextGame: false, stats };
    s6.teams = [
      { ...s6.teams[0]!, coachId: "Ann", players: [player], formerPlayers: [{ playerId: "p-2", name: "Gone", position: "Lineman", level: "Rookie", stats }] },
      { ...s6.teams[0]!, id: "elves", name: "Elves", coach: "Bob", coachId: "Bob", players: [{ ...player, playerId: "p-3", name: "Leaf" }], formerPlayers: [] },
    ];
    s6.unattributedStats = [{ team: "Orcs", teamId: "orcs", name: "Grok", position: "Blitzer", stats, reason: "x", candidates: ["p-1"] }];
    store.putSeason(s6);
    const read = async (auth?: { coach: string; admin: boolean }) => ((await call("GET", "/api/leagues/tabbl/seasons/season-6", auth)).body as { season: SeasonRecord }).season;
    expect((await read()).teams[0]!.players).toHaveLength(1); // off by default
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { registrations: { hideTeamComposition: true } });
    const anon = await read();
    expect(anon.teams.map((t) => [t.name, t.players.length, t.formerPlayers.length, t.playerCount, t.rosterHidden, t.teamValue]))
      .toEqual([["Orcs", 0, 0, 1, true, 1000000], ["Elves", 0, 0, 1, true, 1000000]]);
    expect(anon.unattributedStats).toEqual([]);
    expect(JSON.stringify(anon)).not.toContain("Leaf");
    const ann = await read({ coach: "ann", admin: false });
    expect(ann.teams.map((t) => [t.name, t.players.length, t.rosterHidden ?? false])).toEqual([["Orcs", 1, false], ["Elves", 0, true]]);
    expect(ann.unattributedStats).toHaveLength(1);
    expect((await read({ coach: "Mallory", admin: false })).teams.every((t) => t.rosterHidden)).toBe(true);
    for (const who of [JAY, ROOT]) expect((await read(who)).teams.map((t) => t.players.length)).toEqual([1, 1]);
  });

  it("[P2] toggling a fixture on and off: one notice per recipient per fixture, quiet 24 h, 10 toggles per 10 minutes", async () => {
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { connections: { playOnFork: true } });
    const path = "/api/leagues/tabbl/seasons/season-6/fixtures/f2";
    for (let i = 0; i < 5; i++) {
      expect((await call("PATCH", path, JAY, { forkEnabled: true })).status).toBe(200);
      expect((await call("PATCH", path, JAY, { forkEnabled: false })).status).toBe(200);
    }
    expect(notes.map((n) => n.coach)).toEqual(["Ann", "Bob", "Root"]); // ten toggles, one batch
    const limited = await call("PATCH", path, JAY, { forkEnabled: true });
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBeTruthy();
    // the bookkeeping never reaches a read model
    expect(JSON.stringify((await call("GET", "/api/leagues/tabbl/seasons/season-6")).body)).not.toContain("forkNotice");
    // a new organiser added later: within 24 h of the last batch nobody is told; after it, only the new organiser
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { administration: { addOrganiser: "Kainis" } });
    notes.length = 0;
    clock = "2026-10-30T12:30:00Z";
    expect((await call("PATCH", path, JAY, { forkEnabled: true })).status).toBe(200);
    expect(notes).toHaveLength(0);
    await call("PATCH", path, JAY, { forkEnabled: false });
    clock = "2026-10-31T13:00:00Z";
    const on = await call("PATCH", path, JAY, { forkEnabled: true });
    expect(JSON.stringify(on.body)).not.toContain("forkNotice");
    expect(notes.map((n) => n.coach)).toEqual(["Kainis"]);
  });

  it("[P2] a played fixture never sends Super FUMBBL notices", async () => {
    await call("PATCH", "/api/leagues/tabbl/settings", JAY, { connections: { playOnFork: true } });
    const s6 = store.season("tabbl", "season-6")!;
    s6.fixtures[0] = { ...s6.fixtures[0]!, home: { ...s6.fixtures[0]!.home, score: 1 }, away: { ...s6.fixtures[0]!.away, score: 0 } };
    store.putSeason(s6);
    expect((await call("PATCH", "/api/leagues/tabbl/seasons/season-6/fixtures/f2", JAY, { forkEnabled: true })).status).toBe(200);
    expect(notes).toHaveLength(0);
    expect(seasonForViewer(store.league("tabbl")!, store.season("tabbl", "season-6")!, undefined).fixtures.every((f) => !("forkNotice" in f))).toBe(true);
  });
});
