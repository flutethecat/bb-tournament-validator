import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { LeagueStore } from "../src/leagues/store";
import { exactMatch, nameSimilarity, resetTourplayLimits, suggestCoaches, UPLOAD_LIMIT } from "../src/leagues/tourplayImport";
import { csvFilesFrom, safeUploadPath, unzipCsv, uploadSeasons, UPLOAD_MAX_FILE_BYTES, UploadError } from "../src/leagues/tourplayUpload";
import type { NotificationInput } from "../src/notifications";
import { deflateZip, exportZip, NAF_NUMBERS, PROFILES, seasonFiles, SLUG } from "./tourplayFixture";

// TourPlay import upload (lane L8, src/leagues/tourplayImport.ts + tourplayUpload.ts). Fake fixture data only.

const ORG = { coach: "Organiser1", admin: false };
const ADMIN = { coach: "Root", admin: true };
const SAM = { coach: "Sam", admin: false };
const MORGAN = { coach: "Morgan", admin: false };

describe("TourPlay import upload", () => {
  let dir: string;
  let store: LeagueStore;
  let body: unknown;
  let notes: Array<{ coach: string; input: NotificationInput }>;
  const deps = (): LeagueApiDeps => ({
    store,
    identities: () => [...PROFILES.map((p) => ({ coach: p.coach, level: "player" })), { coach: "Root", level: "admin" }],
    coachProfiles: () => PROFILES,
    now: () => new Date("2026-11-03T12:00:00Z"),
    notify: (coach, input) => { notes.push({ coach, input }); },
    readBody: async () => Buffer.from(body === undefined ? "" : JSON.stringify(body)),
  });
  const call = async (method: string, p: string, auth: { coach: string; admin: boolean } | undefined, b?: unknown): Promise<LeagueApiResult> => {
    body = b;
    const r = await leagueApi(method, `/api/leagues/vbl${p}`, new URLSearchParams(), auth, deps());
    if (!r) throw new Error(`no route for ${method} ${p}`);
    return r;
  };
  const upload = (extra: Record<string, unknown> = {}) => ({ zip: exportZip().toString("base64"), ...extra });
  const json = (r: LeagueApiResult): any => r.body as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rowByName = async (name: string) => json(await call("GET", "/tourplay", ORG)).rows.find((r: { name: string }) => r.name === name);
  const leagueFiles = (): string => {
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    return walk(join(dir, "leagues", "vbl")).filter((f) => !f.endsWith("tourplay-import.json")).map((f) => readFileSync(f, "utf8")).join("\n");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tourplay-import-"));
    store = new LeagueStore(dir);
    store.upsertLeague({ id: "vbl", name: "VBL", fullName: "Valley Bowl League", slug: "vbl", organisers: ["Organiser1"] });
    store.upsertLeague({ id: "other", name: "Other", fullName: "Other League", slug: "other", organisers: ["Sam"] });
    notes = [];
    resetTourplayLimits();
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  describe("upload safety (zip and CSV files)", () => {
    it("refuses path traversal, absolute paths and drive letters", () => {
      for (const bad of ["../evil.csv", "a/../../evil.csv", "/etc/x.csv", "C:/x.csv", "..\\evil.csv", "a/./b.csv", "a//b.csv"]) {
        expect(() => safeUploadPath(bad), bad).toThrow(UploadError);
        expect(() => unzipCsv(deflateZip({ [bad]: "x" })), bad).toThrow(UploadError);
      }
      expect(safeUploadPath("folder\\x-fixtures.csv")).toBe("folder/x-fixtures.csv");
    });

    it("accepts only .csv files; macOS clutter is skipped", () => {
      expect(() => unzipCsv(deflateZip({ "export/logo.png": "x", ...seasonFiles() }))).toThrow(/Only \.csv files/);
      expect(() => csvFilesFrom([{ name: "notes.txt", text: "x" }])).toThrow(/Only \.csv files/);
      const entries = unzipCsv(deflateZip({ "__MACOSX/._a.csv": "x", "export/.DS_Store": "x", "export/a-fixtures.csv": "Category\r\n" }));
      expect(entries.map((e) => e.path)).toEqual(["export/a-fixtures.csv"]);
    });

    it("size caps: a declared size over the cap, a zip bomb lying about its size, a duplicate, a damaged zip", () => {
      expect(() => unzipCsv(deflateZip({ "big.csv": "x" }, { lie: { "big.csv": UPLOAD_MAX_FILE_BYTES + 1 } }))).toThrow(/larger than/);
      const bomb = "0".repeat(2 * 1024 * 1024); // deflates to a few KB
      expect(() => unzipCsv(deflateZip({ "bomb.csv": bomb }, { lie: { "bomb.csv": 1000 } }))).toThrow(/could not be unpacked/);
      expect(() => unzipCsv(deflateZip({ "a.csv": "1", "A.CSV": "2" }))).toThrow(/twice/);
      expect(() => unzipCsv(Buffer.from("not a zip at all, sorry"))).toThrow(/not a zip/);
      expect(unzipCsv(deflateZip({ "s.csv": "stored" }, { store: true }))[0]!.text).toBe("stored");
    });

    it("the route answers 400 for an unsafe upload and 413 for an oversized zip, and writes nothing", async () => {
      const bad = deflateZip({ "../x-fixtures.csv": "x" }).toString("base64");
      expect((await call("POST", "/tourplay/preview", ORG, { zip: bad })).status).toBe(400);
      expect((await call("POST", "/tourplay/apply", ORG, { zip: bad })).status).toBe(400);
      expect((await call("POST", "/tourplay/preview", ORG, { files: [{ name: "x.exe", text: "x" }] })).status).toBe(400);
      expect((await call("POST", "/tourplay/preview", ORG, {})).status).toBe(400);
      const huge = Buffer.alloc(9 * 1024 * 1024).toString("base64");
      expect((await call("POST", "/tourplay/preview", ORG, { zip: huge })).status).toBe(413);
      expect(store.seasons("vbl")).toEqual([]);
      expect(existsSync(join(dir, "leagues", "vbl", "tourplay-import.json"))).toBe(false);
    });

    it("loose CSV files and several season folders in one zip", async () => {
      const files = Object.entries(seasonFiles()).map(([name, text]) => ({ name, text }));
      const r = await call("POST", "/tourplay/preview", ORG, { files });
      expect(r.status).toBe(200);
      expect(json(r).seasons.map((s: { number: number }) => s.number)).toEqual([1]);
      const two = uploadSeasons(unzipCsv(deflateZip({
        ...Object.fromEntries(Object.entries(seasonFiles()).map(([k, v]) => [`s1/${k}`, v])),
        ...Object.fromEntries(Object.entries(seasonFiles("valley-bowl-season-2-0002")).map(([k, v]) => [`s2/${k}`, v])),
      })));
      expect(two.map((s) => [s.folder, s.files.slug, s.files.rosters.length])).toEqual([["s1", SLUG, 5], ["s2", "valley-bowl-season-2-0002", 5]]);
    });
  });

  describe("preview vs apply", () => {
    it("preview shows seasons and coaches and writes nothing; apply imports through the store", async () => {
      const p = await call("POST", "/tourplay/preview", ORG, upload());
      expect(p.status).toBe(200);
      const view = json(p);
      expect(view.canApply).toBe(true);
      expect(view.seasons[0]).toMatchObject({ number: 1, id: "season-1", action: "new", teams: 5, fixtures: 4, played: 3, status: "active", ruleset: "BB2025" });
      expect(view.counts).toMatchObject({ matched: 2, conflict: 1, unmatched: 2, linked: 2 });
      expect(JSON.stringify(view)).not.toContain(NAF_NUMBERS.morgan); // numbers show only as "on file"
      expect(view.coaches.find((c: { name: string }) => c.name === "Morgan Example").hasNafNumber).toBe(true);
      expect(store.seasons("vbl")).toEqual([]);
      expect(existsSync(join(dir, "leagues", "vbl", "tourplay-import.json"))).toBe(false);

      const a = await call("POST", "/tourplay/apply", ORG, upload());
      expect(a.status).toBe(200);
      expect(json(a).seasons).toEqual([expect.objectContaining({ id: "season-1", number: 1, action: "new" })]);
      const s = store.season("vbl", "season-1")!;
      expect(s.source).toBe("tourplay-export");
      expect(s.fixtures).toHaveLength(4);
      expect(existsSync(join(dir, "leagues", "vbl", "tourplay-import.json"))).toBe(true);
      expect(json(await call("GET", "/tourplay", ORG)).imports[0]).toMatchObject({ by: "Organiser1", seasons: [{ id: "season-1", action: "new" }] });
    });

    it("an empty setup season is replaced; a season with teams that was not imported refuses the apply", async () => {
      store.putSeason({ id: "season-1", leagueId: "vbl", number: 1, name: "Season 1", sourceSlug: "season-1", ruleset: "BB2025", status: "active", stage: "setup",
        phases: [], fixtures: [], participants: [], teams: [], honours: [], awards: [], unattributedStats: [], importedAt: "2026-11-01T00:00:00Z", source: "manual" });
      expect(json(await call("POST", "/tourplay/preview", ORG, upload())).seasons[0].action).toBe("replace-empty");
      expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200);
      expect(store.season("vbl", "season-1")!.source).toBe("tourplay-export");

      const s = store.season("vbl", "season-1")!;
      store.putSeason({ ...s, sourceSlug: "manual-1", source: "manual" });
      const p = json(await call("POST", "/tourplay/preview", ORG, upload()));
      expect(p.canApply).toBe(false);
      expect(p.problems[0]).toMatch(/already exists/);
      expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(409);
    });
  });

  describe("re-import", () => {
    it("the same upload twice changes nothing but the import time, and keeps the organiser's assignments", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      // the organiser seats an account on the conflicted team through Assign coach account (teamCoach.ts)
      const rev = store.season("vbl", "season-1")!.revision;
      expect((await call("PATCH", "/seasons/season-1/teams/rapid-rascals", ORG, { revision: rev, coachId: "RileyB" })).status).toBe(200);
      const strip = (x: unknown) => JSON.parse(JSON.stringify(x, (k, v) => (k === "importedAt" || k === "revision" ? undefined : v)));
      const before = strip(store.season("vbl", "season-1"));
      const fileBefore = { ...store.tourplayImport("vbl"), imports: [] };
      expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200);
      const after = store.season("vbl", "season-1")!;
      expect(strip(after)).toEqual(before);
      expect(after.teams.length).toBe(5);
      expect(store.seasons("vbl")).toHaveLength(1);
      expect(after.fixtures.find((f) => f.id === "f2")!.home.coachId).toBeUndefined(); // played fixtures keep who played
      expect({ ...store.tourplayImport("vbl"), imports: [] }).toEqual(fileBefore);
      expect(json(await call("POST", "/tourplay/preview", ORG, upload())).seasons[0].action).toBe("update");
    });

    it("an updated export updates the season in place (new fixture, renamed team)", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const zip = exportZip("valley-bowl-export", seasonFiles(SLUG, { extraRound: true })).toString("base64");
      expect((await call("POST", "/tourplay/apply", ORG, { zip })).status).toBe(200);
      expect(store.season("vbl", "season-1")!.fixtures).toHaveLength(5);
      expect(store.seasons("vbl")).toHaveLength(1);
    });
  });

  describe("matching", () => {
    it("NAF user (any case) and NAF number (leading zeros) link; a username/number disagreement is never merged", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const s = store.season("vbl", "season-1")!;
      const side = (team: string) => s.fixtures.flatMap((f) => [f.home, f.away]).find((x) => x.team === team)!;
      expect(side("Moss Marauders").coachId).toBe("Morgan");
      expect(s.teams.find((t) => t.name === "Moss Marauders")!.coachId).toBe("Morgan");
      expect(side("Quarry Quakers").coachId).toBe("QuinnPlays");
      expect(side("Rapid Rascals").coachId).toBeUndefined();
      const riley = await rowByName("Riley Test");
      expect(riley).toMatchObject({ status: "conflict", needsReview: true, candidates: { byName: ["RileyA"], byNumber: ["RileyB"] } });
      expect(riley.reason).toMatch(/RileyA.*RileyB/);
      expect((await rowByName("Morgan Example")).basis).toBe("naf-name");
      expect((await rowByName("Quinn Sample")).basis).toBe("naf-number");
    });

    it("exactMatch: duplicates are ambiguous, both agreeing is strongest, banned profiles never match", () => {
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set() }, [{ coach: "A", nafName: "X" }, { coach: "B", nafName: "x" }]).status).toBe("ambiguous");
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set(["5"]) }, [{ coach: "A", nafName: "x", nafId: "005" }])).toMatchObject({ status: "matched", basis: "naf-name+number", coachId: "A" });
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set() }, [{ coach: "A", nafName: "x", banned: true }]).status).toBe("unmatched");
      expect(exactMatch({ nafNumbers: new Set(["1", "2"]) }, []).status).toBe("conflict");
    });
  });

  describe("NAF numbers stay private", () => {
    it("never on a season, league, stats or export read, nor in the season files; Payment and Observations dropped", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const publicReads = [
        await call("GET", "", undefined), await call("GET", "/seasons/season-1", undefined), await call("GET", "/seasons/season-1", SAM),
        await call("GET", "/stats", undefined), await call("GET", "/tourplay/claimable", SAM),
      ];
      const zip = await call("GET", "/export.zip", ORG);
      const text = [...publicReads.map((r) => JSON.stringify(r.body)), zip.download ? zip.download.bytes.toString("utf8") : JSON.stringify(zip.body), leagueFiles()].join("\n");
      for (const n of Object.values(NAF_NUMBERS)) expect(text).not.toContain(n);
      expect(text).not.toContain("paid in cash");
      expect(text).not.toContain("late roster");
      // the private record keeps it; the organiser sees it only on a row linked to a site coach
      const file = readFileSync(join(dir, "leagues", "vbl", "tourplay-import.json"), "utf8");
      expect(file).toContain(NAF_NUMBERS.riley);
      expect(file).not.toContain("paid in cash");
      expect((await rowByName("Morgan Example")).nafNumber).toBe(NAF_NUMBERS.morgan);
      const riley = await rowByName("Riley Test");
      expect(riley.nafNumber).toBeUndefined();
      expect(riley.hasNafNumber).toBe(true);
    });
  });

  describe("likely matches", () => {
    it("suggestions are listed but never assigned on their own; the organiser's pick is", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const casey = await rowByName("Casey Demo");
      expect(casey.status).toBe("unmatched");
      expect(casey.suggestions.map((s: { coach: string }) => s.coach)).toContain("CaseyDemo");
      expect(store.season("vbl", "season-1")!.fixtures.flatMap((f) => [f.home, f.away]).filter((x) => x.team === "Cobble Crushers").every((x) => !x.coachId)).toBe(true);
      // the organiser picks it in the preview: the apply links it and remembers the pick
      const res = await call("POST", "/tourplay/apply", ORG, upload({ decisions: { [casey.id]: "caseydemo" } }));
      expect(res.status).toBe(200);
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.home.team === "Cobble Crushers")!.home.coachId).toBe("CaseyDemo");
      expect((await rowByName("Casey Demo")).decision).toMatchObject({ coachId: "CaseyDemo", via: "organiser" });
      // remembered on the next re-import without a decision
      await call("POST", "/tourplay/apply", ORG, upload());
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.home.team === "Cobble Crushers")!.home.coachId).toBe("CaseyDemo");
      // a decision naming nobody is refused
      expect((await call("POST", "/tourplay/apply", ORG, upload({ decisions: { [casey.id]: "Nobody" } }))).status).toBe(409);
    });

    it("the same team name in an earlier season suggests its coach; similarity handles case, accents and brackets", () => {
      const s = suggestCoaches({ name: "Zed Q", teams: ["Moss Marauders"] }, PROFILES, [{ team: "moss marauders", coachId: "Sam", season: "Season 0" }]);
      expect(s[0]).toMatchObject({ coach: "Sam", reasons: ["Coached moss marauders in Season 0"] });
      expect(nameSimilarity("Casey Demo", "CaseyDemo")).toBe(1);
      expect(nameSimilarity("José Ríos", "jose rios")).toBe(1);
      expect(nameSimilarity("flutey (Casey)", "Casey")).toBeGreaterThanOrEqual(0.75);
      expect(nameSimilarity("Alpha", "Omega")).toBeLessThan(0.75);
    });

    it("the review list's assign seats the account through teamCoach (all seasons) and clears with null", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const riley = await rowByName("Riley Test");
      expect((await call("POST", `/tourplay/coaches/${riley.id}/assign`, ORG, { coachId: "Nobody" })).status).toBe(400);
      const r = await call("POST", `/tourplay/coaches/${riley.id}/assign`, ORG, { coachId: "rileyb" });
      expect(r.status).toBe(200);
      const fx = store.season("vbl", "season-1")!.fixtures.find((f) => f.id === "f3")!; // unplayed (suspended 0-0)
      expect(fx.away.coachId).toBe("RileyB");
      expect((await rowByName("Riley Test"))).toMatchObject({ needsReview: false, coachId: "RileyB", nafNumber: NAF_NUMBERS.riley });
      expect((await call("POST", `/tourplay/coaches/${riley.id}/assign`, ORG, { coachId: null })).status).toBe(200);
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.id === "f3")!.away.coachId).toBeUndefined();
    });
  });

  describe("coach claims", () => {
    it("claim, organiser notified, approve assigns via teamCoach; duplicates refused; decline notifies", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      expect((await call("GET", "/tourplay/claimable", undefined)).status).toBe(401);
      const claimable = json(await call("GET", "/tourplay/claimable", SAM));
      const avery = claimable.rows.find((r: { name: string }) => r.name === "Avery Placeholder");
      expect(avery.teams).toEqual(["Ashen Avengers"]);
      expect(claimable.rows.map((r: { name: string }) => r.name)).not.toContain("Morgan Example"); // linked names are not open
      expect(Object.keys(avery).sort()).toEqual(["id", "name", "seasons", "teams"]);

      expect((await call("POST", "/tourplay/claims", undefined, { row: avery.id })).status).toBe(401);
      const c = await call("POST", "/tourplay/claims", SAM, { row: avery.id });
      expect(c.status).toBe(201);
      expect(notes.map((n) => [n.coach, n.input.type])).toEqual([["Organiser1", "registration"]]);
      expect((await call("POST", "/tourplay/claims", SAM, { row: avery.id })).status).toBe(409);
      const morganRow = await rowByName("Morgan Example");
      expect((await call("POST", "/tourplay/claims", SAM, { row: morganRow.id })).status).toBe(404); // linked: not open
      expect(json(await call("GET", "/tourplay/claimable", SAM)).mine).toEqual([expect.objectContaining({ name: "Avery Placeholder", state: "pending" })]);

      const claimId = json(c).claim.id;
      expect((await call("POST", `/tourplay/claims/${claimId}/approve`, SAM, {})).status).toBe(403); // the claimant cannot approve
      expect((await call("POST", `/tourplay/claims/${claimId}/approve`, MORGAN, {})).status).toBe(403);
      const ok = await call("POST", `/tourplay/claims/${claimId}/approve`, ORG, { allSeasons: true });
      expect(ok.status).toBe(200);
      const fx = store.season("vbl", "season-1")!.fixtures.find((f) => f.away.team === "Ashen Avengers")!;
      expect(fx.away.coachId).toBeUndefined(); // f4 was played: played fixtures keep who played
      expect(store.season("vbl", "season-1")!.participants.find((p) => p.team === "Ashen Avengers")!.coachId).toBe("Sam");
      expect((await rowByName("Avery Placeholder")).decision).toMatchObject({ coachId: "Sam", via: "claim" });
      expect(notes.at(-1)).toMatchObject({ coach: "Sam", input: { type: "registration-outcome" } });
      expect((await call("POST", `/tourplay/claims/${claimId}/approve`, ORG, {})).status).toBe(409);
      expect(json(await call("GET", "/tourplay/claimable", SAM)).rows.map((r: { name: string }) => r.name)).not.toContain("Avery Placeholder");

      const casey = (await rowByName("Casey Demo")).id;
      const c2 = json(await call("POST", "/tourplay/claims", MORGAN, { row: casey })).claim.id;
      expect(json(await call("GET", "/tourplay", ORG)).rows.find((r: { id: string }) => r.id === casey).claims).toHaveLength(1);
      expect((await call("POST", `/tourplay/claims/${c2}/decline`, ORG, {})).status).toBe(200);
      expect(notes.at(-1)).toMatchObject({ coach: "Morgan", input: { type: "registration-outcome", title: expect.stringMatching(/declined/) } });
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.away.team === "Cobble Crushers")!.away.coachId).toBeUndefined();
    });

    it("a claimant withdraws; claims are rate-limited", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const casey = (await rowByName("Casey Demo")).id;
      const id = json(await call("POST", "/tourplay/claims", SAM, { row: casey })).claim.id;
      expect((await call("POST", `/tourplay/claims/${id}/withdraw`, MORGAN, {})).status).toBe(404);
      expect((await call("POST", `/tourplay/claims/${id}/withdraw`, SAM, {})).status).toBe(200);
      let last = 0;
      for (let i = 0; i < 12; i += 1) last = (await call("POST", "/tourplay/claims", SAM, { row: casey })).status;
      expect(last).toBe(429);
    });
  });

  describe("access", () => {
    it("organisers of the league and site admins only; anyone else 401 / 403; GETs never write", async () => {
      for (const [m, p] of [["POST", "/tourplay/preview"], ["POST", "/tourplay/apply"], ["GET", "/tourplay"], ["POST", "/tourplay/coaches/tp000000000000/assign"]] as const) {
        expect((await call(m, p, undefined, upload())).status, `${m} ${p} anon`).toBe(401);
        expect((await call(m, p, SAM, upload())).status, `${m} ${p} organiser of another league`).toBe(403);
        expect((await call(m, p, MORGAN, upload())).status, `${m} ${p} coach`).toBe(403);
      }
      expect((await call("POST", "/tourplay/preview", ADMIN, upload())).status).toBe(200);
      expect((await call("POST", "/tourplay/apply", ADMIN, upload())).status).toBe(200);
      const file = readFileSync(join(dir, "leagues", "vbl", "tourplay-import.json"), "utf8");
      await call("GET", "/tourplay", ORG);
      await call("GET", "/tourplay/claimable", SAM);
      expect(readFileSync(join(dir, "leagues", "vbl", "tourplay-import.json"), "utf8")).toBe(file);
      expect((await call("GET", "/tourplay/apply", ORG)).status).toBe(405);
    });

    it("a draft league is not there for anyone but its organisers", async () => {
      store.updateLeague("vbl", (l) => { l.visibility = "draft"; });
      expect((await call("POST", "/tourplay/preview", SAM, upload())).status).toBe(404);
      expect((await call("GET", "/tourplay/claimable", SAM)).status).toBe(404);
      expect((await call("POST", "/tourplay/preview", ORG, upload())).status).toBe(200);
    });

    it("uploads are rate-limited per coach", async () => {
      let last = 0;
      for (let i = 0; i <= UPLOAD_LIMIT; i += 1) last = (await call("POST", "/tourplay/preview", ORG, { files: [] })).status;
      expect(last).toBe(429);
    });

    it("CSRF: every TourPlay write is a state-changing request (X-CW-Auth); the reads are not", () => {
      for (const p of ["preview", "apply", "claims", "claims/tc1/approve", "claims/tc1/decline", "claims/tc1/withdraw", "coaches/tp1/assign"]) {
        expect(isStateChangingApiRequest("POST", `/api/leagues/vbl/tourplay/${p}`), p).toBe(true);
      }
      expect(isStateChangingApiRequest("GET", "/api/leagues/vbl/tourplay")).toBe(false);
      expect(isStateChangingApiRequest("GET", "/api/leagues/vbl/tourplay/claimable")).toBe(false);
    });
  });

  describe("law 20a: no network access", () => {
    it("preview, apply, review and claims never open a connection or call fetch", async () => {
      const require = createRequire(import.meta.url);
      const net = require("node:net") as typeof import("node:net");
      const http = require("node:http") as typeof import("node:http");
      const https = require("node:https") as typeof import("node:https");
      const tls = require("node:tls") as typeof import("node:tls");
      const dns = require("node:dns") as typeof import("node:dns");
      const attempts: string[] = [];
      const trap = (name: string) => (..._args: unknown[]) => { attempts.push(name); throw new Error(`network access in the TourPlay import: ${name}`); };
      const saved: Array<[Record<string, unknown>, string, unknown]> = [];
      const patch = (obj: Record<string, unknown>, key: string, name: string) => { saved.push([obj, key, obj[key]]); obj[key] = trap(name); };
      patch(globalThis as unknown as Record<string, unknown>, "fetch", "fetch");
      patch(net.Socket.prototype as unknown as Record<string, unknown>, "connect", "net.Socket.connect");
      for (const [mod, label] of [[net, "net"], [http, "http"], [https, "https"], [tls, "tls"], [dns, "dns"]] as const) {
        for (const key of ["connect", "createConnection", "request", "get", "lookup", "resolve"]) {
          if (typeof (mod as unknown as Record<string, unknown>)[key] === "function") patch(mod as unknown as Record<string, unknown>, key, `${label}.${key}`);
        }
      }
      try {
        expect((await call("POST", "/tourplay/preview", ORG, upload())).status).toBe(200);
        expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200);
        expect((await call("GET", "/tourplay", ORG)).status).toBe(200);
        const row = json(await call("GET", "/tourplay/claimable", SAM)).rows[0];
        const claim = json(await call("POST", "/tourplay/claims", SAM, { row: row.id })).claim;
        expect((await call("POST", `/tourplay/claims/${claim.id}/approve`, ORG, {})).status).toBe(200);
      } finally {
        for (const [obj, key, value] of saved.reverse()) obj[key] = value;
      }
      expect(attempts).toEqual([]);
    });

    it("the import modules import nothing that reaches the network", () => {
      for (const f of ["tourplay.ts", "tourplayUpload.ts", "tourplayImport.ts"]) {
        const src = readFileSync(join(__dirname, "..", "src", "leagues", f), "utf8");
        expect(src, f).not.toMatch(/from "node:(http|https|net|tls|dns)"|\bfetch\(|tourplay\.net/i);
      }
    });
  });
});
