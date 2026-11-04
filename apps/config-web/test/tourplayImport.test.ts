import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { leagueApi, type LeagueApiDeps, type LeagueApiResult } from "../src/leagues/api";
import { LeagueStore } from "../src/leagues/store";
import { exactMatch, nameSimilarity, resetTourplayLimits, suggestCoaches, UPLOAD_LIMIT } from "../src/leagues/tourplayImport";
import { firstSeason } from "../src/leagues/wizard";
import { fixtureLockKey, withForkLocks } from "../src/leagues/forkPlay";
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
  /** The organiser's explicit "Confirm all exact matches": a decision per proposed row (from a preview). */
  const confirmAll = async (b: Record<string, unknown> = upload()): Promise<Record<string, string>> => {
    const view = json(await call("POST", "/tourplay/preview", ORG, b));
    return Object.fromEntries(view.coaches.filter((c: { proposed?: string; status: string }) => c.proposed && c.status === "matched").map((c: { id: string; proposed: string }) => [c.id, c.proposed]));
  };
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
      // CRC-32 is checked for every entry, stored or deflated
      expect(() => unzipCsv(deflateZip({ "x.csv": "a;b 1;2" }, { badCrc: "x.csv" }))).toThrow(/checksum/);
      expect(() => unzipCsv(deflateZip({ "x.csv": "a;b" }, { badCrc: "x.csv", store: true }))).toThrow(/checksum/);
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
      expect(view.counts).toMatchObject({ matched: 2, conflict: 1, unmatched: 2, linked: 0, proposed: 2 });
      expect(view.coaches.map((c: { basis: string }) => c.basis).sort()).toEqual(["naf-name", "naf-number", "none", "none", "none"]);
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
      expect(s.teams.every((t) => !t.coachId)).toBe(true); // no automatic links
      expect(existsSync(join(dir, "leagues", "vbl", "tourplay-import.json"))).toBe(true);
      expect(json(await call("GET", "/tourplay", ORG)).imports[0]).toMatchObject({ by: "Organiser1", seasons: [{ id: "season-1", action: "new" }] });
    });

    it("only the wizard's untouched Season 1 is replaced; a season made here is never replaced, the export takes the next number", async () => {
      const lg = store.league("vbl")!;
      store.putSeason(firstSeason(lg, "2026-11-01T00:00:00.000Z"));
      expect(json(await call("POST", "/tourplay/preview", ORG, upload())).seasons[0]).toMatchObject({ action: "replace-empty", id: "season-1" });
      // customised (a division and news): kept, and the export becomes Season 2
      const custom = firstSeason(lg, "2026-11-01T00:00:00.000Z");
      custom.phases[0]!.groups = ["North"];
      store.putSeason(custom);
      const p = json(await call("POST", "/tourplay/preview", ORG, upload()));
      expect(p.seasons[0]).toMatchObject({ action: "new", id: "season-2", number: 2, renumbered: { from: 1 } });
      expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200);
      expect(store.season("vbl", "season-1")!.phases[0]!.groups).toEqual(["North"]);
      expect(store.season("vbl", "season-1")!.source).toBe("manual");
      expect(store.season("vbl", "season-2")!.source).toBe("tourplay-export");
      // a re-import updates Season 2, never Season 1
      expect(json(await call("POST", "/tourplay/preview", ORG, upload())).seasons[0]).toMatchObject({ action: "update", id: "season-2" });
    });
  });

  describe("re-import", () => {
    it("the same upload twice changes nothing but the import time, and keeps the organiser's assignments", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      // the organiser seats an account on the conflicted team through Assign coach account (teamCoach.ts)
      const rev = store.season("vbl", "season-1")!.revision;
      expect((await call("PATCH", "/seasons/season-1/teams/rapid-rascals", ORG, { revision: rev, coachId: "RileyB" })).status).toBe(200);
      // the Teams-tab assignment became the TourPlay row's decision (record, review list and privacy follow it)
      expect(await rowByName("Riley Test")).toMatchObject({ needsReview: false, coachId: "RileyB", decision: { coachId: "RileyB", via: "organiser" } });
      expect(store.tourplayImport("vbl").coaches["naf:rileyt"]!.decision).toMatchObject({ coachId: "RileyB", by: "Organiser1" });
      expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200); // settles the decision into every row
      expect(store.season("vbl", "season-1")!.teams.find((t) => t.id === "rapid-rascals")).toMatchObject({ coachId: "RileyB", coachAssigned: { by: "Organiser1" } });
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
    it("NAF user (any case) and NAF number (leading zeros) only PROPOSE; nothing links until the organiser confirms; a disagreement proposes nobody", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      let s = store.season("vbl", "season-1")!;
      expect(s.teams.every((t) => !t.coachId)).toBe(true);
      expect(s.fixtures.flatMap((f) => [f.home, f.away]).every((x) => !x.coachId)).toBe(true);
      const morgan = await rowByName("Morgan Example");
      expect(morgan).toMatchObject({ status: "matched", basis: "naf-name", needsReview: true });
      expect(morgan.coachId).toBeUndefined();
      expect(morgan.nafNumber).toBeUndefined(); // not linked yet
      expect(morgan.suggestions[0]).toMatchObject({ coach: "Morgan", reasons: expect.arrayContaining(["NAF name matches"]) });
      expect((await rowByName("Quinn Sample")).suggestions[0]).toMatchObject({ coach: "QuinnPlays", reasons: expect.arrayContaining(["NAF number matches"]) });
      const riley = await rowByName("Riley Test");
      expect(riley).toMatchObject({ status: "conflict", needsReview: true, candidates: { byName: ["RileyA"], byNumber: ["RileyB"] } });
      expect(riley.reason).toMatch(/RileyA.*RileyB/);
      // "Confirm all exact matches" (explicit) links the two proposals, not the conflict
      const decisions = await confirmAll();
      expect(Object.values(decisions).sort()).toEqual(["Morgan", "QuinnPlays"]);
      expect((await call("POST", "/tourplay/apply", ORG, upload({ decisions }))).status).toBe(200);
      s = store.season("vbl", "season-1")!;
      const side = (team: string) => s.fixtures.flatMap((f) => [f.home, f.away]).find((x) => x.team === team)!;
      expect(s.teams.find((t) => t.name === "Moss Marauders")!.coachId).toBe("Morgan");
      expect(s.teams.find((t) => t.name === "Quarry Quakers")!.coachId).toBe("QuinnPlays");
      expect(side("Rapid Rascals").coachId).toBeUndefined();
      expect((await rowByName("Morgan Example"))).toMatchObject({ needsReview: false, coachId: "Morgan", decision: { via: "organiser" } });
    });

    it("exactMatch: duplicates are ambiguous, both agreeing is strongest, banned profiles never match", () => {
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set() }, [{ coach: "A", nafName: "X" }, { coach: "B", nafName: "x" }]).status).toBe("ambiguous");
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set(["5"]) }, [{ coach: "A", nafName: "x", nafId: "005" }])).toMatchObject({ status: "matched", basis: "naf-name+number", coachId: "A" });
      expect(exactMatch({ nafUser: "x", nafNumbers: new Set() }, [{ coach: "A", nafName: "x", banned: true }]).status).toBe("unmatched");
      expect(exactMatch({ nafNumbers: new Set(["1", "2"]) }, []).status).toBe("conflict");
    });
  });

  describe("re-import merges (review round)", () => {
    const zipOf = (files: Record<string, string>) => exportZip("valley-bowl-export", files).toString("base64");
    const withoutAvery = (): Record<string, string> => Object.fromEntries(Object.entries(seasonFiles()).filter(([k]) => !k.includes("Avery"))
      .map(([k, v]) => [k, v.split("\r\n").filter((l) => !l.includes("Avery Placeholder")).join("\r\n")]));

    it("Sol's 5-2: a result recorded here survives a re-import, is listed as a conflict, and the export wins only when the organiser picks it", async () => {
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { round3: "unplayed" })) });
      let s = store.season("vbl", "season-1")!;
      const r3 = s.fixtures.find((f) => f.round === 3)!;
      expect(r3.home.score).toBeNull();
      // the coaches report 5-2 here (a typed first result carries no marker); a local roster edit too
      r3.home.score = 5; r3.away.score = 2; r3.home.cas = 0; r3.away.cas = 1;
      s.teams.find((t) => t.id === "moss-marauders")!.players[0]!.name = "Grub the Renamed";
      store.putSeason(s);
      // TourPlay later shows 1-0 for that game and 3-1 (not 2-1) for round 1, which nobody touched here
      const next = { zip: zipOf(seasonFiles(SLUG, { round3: "1-0", round1Score: "3;1" })) };
      const p = json(await call("POST", "/tourplay/preview", ORG, next));
      const conflicts = p.seasons[0].conflicts;
      expect(conflicts).toEqual([expect.objectContaining({ kind: "result", local: "5-2", export: "1-0", reason: "Changed here since the last import" })]);
      expect((await call("POST", "/tourplay/apply", ORG, next)).status).toBe(200);
      s = store.season("vbl", "season-1")!;
      expect(s.fixtures.find((f) => f.round === 3)!).toMatchObject({ home: { score: 5 }, away: { score: 2 } }); // kept
      expect(s.fixtures.find((f) => f.round === 1 && f.table === 1)!).toMatchObject({ home: { score: 3 }, away: { score: 1 } }); // export update taken
      expect(s.teams.find((t) => t.id === "moss-marauders")!.players[0]!.name).toBe("Grub the Renamed"); // local roster edit kept
      expect(s.fixtures).toHaveLength(5);
      // the organiser picks the export for that row
      expect((await call("POST", "/tourplay/apply", ORG, { ...next, choices: [conflicts[0].id] })).status).toBe(200);
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.round === 3)!).toMatchObject({ home: { score: 1 }, away: { score: 0 } });
      expect((await call("POST", "/tourplay/preview", ORG, { ...next, choices: ["not-an-id"] })).status).toBe(400);
    });

    it("a fixture with a recorder link or Super FUMBBL state is never overwritten, even when unchanged here", async () => {
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { round3: "unplayed" })) });
      const s = store.season("vbl", "season-1")!;
      const r1 = s.fixtures.find((f) => f.round === 1 && f.table === 1)!;
      r1.tabletop = { revision: 1 };
      store.putSeason(s);
      const next = { zip: zipOf(seasonFiles(SLUG, { round3: "unplayed", round1Score: "4;0" })) };
      const p = json(await call("POST", "/tourplay/preview", ORG, next));
      expect(p.seasons[0].conflicts).toEqual([expect.objectContaining({ kind: "result", reason: "Kept: recorded with the match recorder", local: "2-1", export: "4-0" })]);
      await call("POST", "/tourplay/apply", ORG, next);
      expect(store.season("vbl", "season-1")!.fixtures.find((f) => f.round === 1 && f.table === 1)!).toMatchObject({ home: { score: 2 }, tabletop: { revision: 1 } });
    });

    it("an explicit preview decision wins over a carried Teams-tab assignment, and the record follows", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const rev = store.season("vbl", "season-1")!.revision;
      await call("PATCH", "/seasons/season-1/teams/cobble-crushers", ORG, { revision: rev, coachId: "Sam" });
      const casey = await rowByName("Casey Demo");
      expect(casey.coachId).toBe("Sam");
      expect((await call("POST", "/tourplay/apply", ORG, upload({ decisions: { [casey.id]: "CaseyDemo" } }))).status).toBe(200);
      const t = store.season("vbl", "season-1")!.teams.find((x) => x.id === "cobble-crushers")!;
      expect(t).toMatchObject({ coachId: "CaseyDemo", coachAssigned: { by: "Organiser1" } });
      expect(store.season("vbl", "season-1")!.participants.find((p) => p.team === "Cobble Crushers")!.coachId).toBe("CaseyDemo");
      expect(await rowByName("Casey Demo")).toMatchObject({ coachId: "CaseyDemo", decision: { coachId: "CaseyDemo" } });
    });

    it("a coach the export no longer names is obsolete: not claimable or assignable, its team refs cleared, its pending claim closed", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const avery = await rowByName("Avery Placeholder");
      await call("POST", "/tourplay/claims", SAM, { row: avery.id });
      expect((await call("POST", "/tourplay/apply", ORG, { zip: zipOf(withoutAvery()) })).status).toBe(200);
      const row = await rowByName("Avery Placeholder");
      expect(row).toMatchObject({ obsolete: true, needsReview: false, seasons: [] });
      expect(json(await call("GET", "/tourplay/claimable", SAM)).rows.map((r: { name: string }) => r.name)).not.toContain("Avery Placeholder");
      expect(json(await call("GET", "/tourplay/claimable", SAM)).mine).toEqual([expect.objectContaining({ state: "declined" })]);
      expect((await call("POST", `/tourplay/coaches/${avery.id}/assign`, ORG, { coachId: "Sam" })).status).toBe(409);
      expect((await call("POST", "/tourplay/claims", SAM, { row: avery.id })).status).toBe(404);
    });

    it("missing roster files: teams are derived from the fixtures; a coach with no team at all cannot be linked and stays open", async () => {
      const zip = zipOf(seasonFiles(SLUG, { noRosters: true, extraParticipant: true }));
      const p = json(await call("POST", "/tourplay/preview", ORG, { zip }));
      expect(p.seasons[0].derivedTeams).toHaveLength(5);
      const jordan = p.coaches.find((c: { name: string }) => c.name === "Jordan Benchwarmer");
      const bad = json(await call("POST", "/tourplay/preview", ORG, { zip, decisions: { [jordan.id]: "Sam" } }));
      expect(bad.canApply).toBe(false);
      expect(bad.problems[0]).toMatch(/no team in the export/);
      expect((await call("POST", "/tourplay/apply", ORG, { zip })).status).toBe(200);
      expect(store.season("vbl", "season-1")!.teams).toHaveLength(5);
      const riley = await rowByName("Riley Test");
      expect((await call("POST", `/tourplay/coaches/${riley.id}/assign`, ORG, { coachId: "RileyB" })).status).toBe(200);
      expect(store.season("vbl", "season-1")!.teams.find((t) => t.name === "Rapid Rascals")!.coachId).toBe("RileyB");
      const j = await rowByName("Jordan Benchwarmer");
      const r = await call("POST", `/tourplay/coaches/${j.id}/assign`, ORG, { coachId: "Sam" });
      expect(r.status).toBe(409);
      expect(json(r).error).toMatch(/roster files/);
      expect(await rowByName("Jordan Benchwarmer")).toMatchObject({ needsReview: true });
    });
  });

  describe("re-import merges (review round 2)", () => {
    const zipOf = (files: Record<string, string>) => exportZip("valley-bowl-export", files).toString("base64");
    const moss = () => store.season("vbl", "season-1")!.teams.find((t) => t.id === "moss-marauders")!;
    const r1 = () => store.season("vbl", "season-1")!.fixtures.find((f) => f.round === 1 && f.home.team === "Moss Marauders")!;

    it("P1: an export without roster files leaves local rosters and team details alone, with no conflict", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const before = structuredClone(moss());
      expect(before.players).toHaveLength(2);
      const none = { zip: zipOf(seasonFiles(SLUG, { noRosters: true })) };
      expect(json(await call("POST", "/tourplay/preview", ORG, none)).seasons[0].conflicts).toEqual([]);
      expect((await call("POST", "/tourplay/apply", ORG, none)).status).toBe(200);
      expect(moss()).toMatchObject({ players: before.players.map((p) => expect.objectContaining({ playerId: p.playerId, name: p.name })), treasury: before.treasury, rerolls: before.rerolls, fans: before.fans });
      // the real roster baseline survives: the full export again changes nothing and lists nothing
      expect(json(await call("POST", "/tourplay/preview", ORG, upload())).seasons[0].conflicts).toEqual([]);
    });

    it("P2: a local stats edit is never dropped by an export roster change; a stats-only export change is taken when nothing changed here", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      // stats-only change in the export (an honours TD total), nothing changed here: taken
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { tds: 2 })) });
      expect(moss().players.find((p) => p.name === "Grub Mossfoot")!.stats.td).toBe(2);
      // a local SPP edit, then the export renames the player: conflict, local kept whole
      const s = store.season("vbl", "season-1")!;
      s.teams.find((t) => t.id === "moss-marauders")!.players.find((p) => p.name === "Grub Mossfoot")!.stats.td = 5;
      store.putSeason(s);
      const next = { zip: zipOf(seasonFiles(SLUG, { tds: 2, rosterRename: true })) };
      const conflicts = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts;
      expect(conflicts).toEqual([expect.objectContaining({ kind: "roster", label: "Moss Marauders roster" })]);
      await call("POST", "/tourplay/apply", ORG, next);
      expect(moss().players.find((p) => p.name === "Grub Mossfoot")!.stats.td).toBe(5);
    });

    it("P2: 'use the export' takes the export's whole result (baseline 2-1, local 5-2, export 3-1 -> 3-1)", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const s = store.season("vbl", "season-1")!;
      const f = s.fixtures.find((x) => x.id === r1().id)!;
      f.home.score = 5; f.away.score = 2;
      store.putSeason(s);
      const next = { zip: zipOf(seasonFiles(SLUG, { round1Score: "3;1" })) };
      const [c] = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts;
      expect(c).toMatchObject({ local: "5-2", export: "3-1" });
      await call("POST", "/tourplay/apply", ORG, { ...next, choices: [c.id] });
      expect(r1()).toMatchObject({ home: { score: 3 }, away: { score: 1 } });
    });

    it("P2: taking the export drops the local forfeit, overrides and recorder link; a live Super FUMBBL game blocks it", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      let s = store.season("vbl", "season-1")!;
      let f = s.fixtures.find((x) => x.id === r1().id)! as unknown as Record<string, unknown>;
      Object.assign(f, { forfeit: { home: true, away: false, noStandings: true }, resultEdit: { by: "Organiser1", at: "2026-11-01T00:00:00Z" }, tabletop: { revision: 2 } });
      store.putSeason(s);
      const next = { zip: zipOf(seasonFiles(SLUG, { round1Score: "3;1" })) };
      const [c] = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts;
      expect(c.reason).toMatch(/^Kept:/);
      await call("POST", "/tourplay/apply", ORG, { ...next, choices: [c.id] });
      f = r1() as unknown as Record<string, unknown>;
      expect(f).toMatchObject({ home: { score: 3 }, away: { score: 1 } });
      expect(f.forfeit).toBeUndefined();
      expect(f.resultEdit).toBeUndefined();
      expect(f.tabletop).toBeUndefined();
      // a game in progress on Super FUMBBL: the choice is refused, local kept
      s = store.season("vbl", "season-1")!;
      const live = s.fixtures.find((x) => x.id === r1().id)! as unknown as Record<string, unknown>;
      live.fork = { status: "in_progress", teams: { home: { teamId: "moss-marauders" } } };
      store.putSeason(s);
      const later = { zip: zipOf(seasonFiles(SLUG, { round1Score: "4;0" })) };
      const [c2] = json(await call("POST", "/tourplay/preview", ORG, { ...later, choices: [] })).seasons[0].conflicts;
      const blocked = json(await call("POST", "/tourplay/preview", ORG, { ...later, choices: [c2.id] })).seasons[0].conflicts[0];
      expect(blocked.reason).toMatch(/in progress/);
      await call("POST", "/tourplay/apply", ORG, { ...later, choices: [c2.id] });
      expect(r1()).toMatchObject({ home: { score: 3 }, away: { score: 1 }, fork: { status: "in_progress" } });
    });

    it("P2: a fixture deleted here stays deleted on every later re-import", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const s = store.season("vbl", "season-1")!;
      s.fixtures = s.fixtures.filter((x) => x.round !== 2 || x.table !== 2);
      store.putSeason(s);
      for (let i = 0; i < 2; i += 1) {
        expect((await call("POST", "/tourplay/apply", ORG, upload())).status).toBe(200);
        expect(store.season("vbl", "season-1")!.fixtures).toHaveLength(3);
      }
    });

    it("P2: TourPlay correcting a played fixture's table updates it in place (no duplicate game)", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const id = r1().id;
      expect((await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { round1Table: 3 })) })).status).toBe(200);
      const s = store.season("vbl", "season-1")!;
      expect(s.fixtures).toHaveLength(4);
      expect(s.fixtures.find((x) => x.id === id)).toMatchObject({ table: 3, home: { score: 2 }, away: { score: 1 } });
    });

    it("P2: Teams-tab seats are kept per season: assigning RileyA in S1 and RileyB in S2 keeps both linked and leaves the row's decision alone", async () => {
      const two = { zip: deflateZip({
        ...Object.fromEntries(Object.entries(seasonFiles()).map(([k, v]) => [`s1/${k}`, v])),
        ...Object.fromEntries(Object.entries(seasonFiles("valley-bowl-season-2-0002")).map(([k, v]) => [`s2/${k}`, v])),
      }).toString("base64") };
      expect((await call("POST", "/tourplay/apply", ORG, two)).status).toBe(200);
      for (const [sid, who] of [["season-1", "RileyA"], ["season-2", "RileyB"]] as const) {
        const rev = store.season("vbl", sid)!.revision;
        expect((await call("PATCH", `/seasons/${sid}/teams/rapid-rascals`, ORG, { revision: rev, coachId: who })).status).toBe(200);
      }
      const rec = store.tourplayImport("vbl").coaches["naf:rileyt"]!;
      expect(rec.linked?.sort()).toEqual(["RileyA", "RileyB"]);
      expect(rec.seasonLinks).toMatchObject({ "season-1": { coachId: "RileyA" }, "season-2": { coachId: "RileyB" } });
      expect(rec.decision).toBeUndefined();
    });

    it("P2: a preview decision cannot change the owner of a team in a live Super FUMBBL game", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const s = store.season("vbl", "season-1")!;
      const f = s.fixtures.find((x) => x.home.team === "Cobble Crushers")! as unknown as Record<string, unknown>;
      f.fork = { status: "in_progress", teams: { home: { teamId: "cobble-crushers" } } };
      store.putSeason(s);
      const casey = await rowByName("Casey Demo");
      const p = json(await call("POST", "/tourplay/preview", ORG, upload({ decisions: { [casey.id]: "CaseyDemo" } })));
      expect(p.canApply).toBe(false);
      expect(p.problems.join(" ")).toMatch(/Super FUMBBL game/);
      expect((await call("POST", "/tourplay/apply", ORG, upload({ decisions: { [casey.id]: "CaseyDemo" } }))).status).toBe(409);
      expect(store.season("vbl", "season-1")!.teams.find((t) => t.id === "cobble-crushers")!.coachId).toBeUndefined();
    });
  });

  describe("re-import merges (review round 3)", () => {
    const zipOf = (files: Record<string, string>) => exportZip("valley-bowl-export", files).toString("base64");
    const season = () => store.season("vbl", "season-1")!;
    const r1 = () => season().fixtures.find((f) => f.home.team === "Moss Marauders" && f.away.team === "Quarry Quakers" && f.phaseId === "season-regular" && f.round !== 4)!;
    const edit = (fn: (s: ReturnType<typeof season>) => void) => { const s = season(); fn(s); store.putSeason(s); };

    it("1: fixture ids are never reused, even after the highest one was deleted", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      edit((s) => { s.fixtures = s.fixtures.filter((f) => f.id !== "f4"); });
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { extraRound: true })) });
      const ids = season().fixtures.map((f) => f.id);
      expect(ids).not.toContain("f4");
      expect(ids).toContain("f5");
    });

    it("2: same round and teams in two phases are told apart by phase, whatever the export order; rows the export can't tell apart are a conflict", async () => {
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { twinPhases: true })) });
      const before = season().fixtures.filter((f) => f.round === 4).map((f) => [f.id, f.phaseId, f.home.score, f.away.score]);
      expect(before).toHaveLength(2);
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { twinPhases: true, reverse: true })) });
      expect(season().fixtures.filter((f) => f.round === 4).map((f) => [f.id, f.phaseId, f.home.score, f.away.score])).toEqual(before);
      const p = json(await call("POST", "/tourplay/preview", ORG, { zip: zipOf(seasonFiles(SLUG, { twinSame: true })) }));
      const amb = p.seasons[0].conflicts.find((c: { kind: string }) => c.kind === "ambiguous");
      expect(amb).toBeTruthy();
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { twinSame: true })) });
      expect(season().fixtures.filter((f) => f.round === 6)).toHaveLength(0); // not added without a pick
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { twinSame: true })), choices: [amb.id] });
      expect(season().fixtures.filter((f) => f.round === 6)).toHaveLength(2);
    });

    it("3: picking the export's table never touches the local result or its forfeit; only a result pick does", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      edit((s) => { const f = s.fixtures.find((x) => x.id === r1().id)! as unknown as Record<string, any>; f.home.score = 5; f.away.score = 2; f.table = 7; f.forfeit = { home: true, away: false, noStandings: true }; });
      const next = { zip: zipOf(seasonFiles(SLUG, { round1Score: "3;1", round1Table: 4 })) };
      const cs = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts;
      const table = cs.find((c: { kind: string }) => c.kind === "fixture");
      const result = cs.find((c: { kind: string }) => c.kind === "result");
      expect(table).toBeTruthy(); expect(result).toBeTruthy();
      await call("POST", "/tourplay/apply", ORG, { ...next, choices: [table.id] });
      expect(r1()).toMatchObject({ table: 4, home: { score: 5 }, away: { score: 2 }, forfeit: { noStandings: true } });
      await call("POST", "/tourplay/apply", ORG, { ...next, choices: [result.id] });
      expect(r1()).toMatchObject({ table: 4, home: { score: 3 }, away: { score: 1 } });
      expect((r1() as unknown as Record<string, unknown>).forfeit).toBeUndefined();
    });

    it("4: a team in a live Super FUMBBL game keeps its roster, even for a stats-only export change", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      edit((s) => { (s.fixtures.find((x) => x.id === r1().id)! as unknown as Record<string, unknown>).fork = { status: "in_progress", teams: { home: { teamId: "moss-marauders" } } }; });
      const next = { zip: zipOf(seasonFiles(SLUG, { tds: 3 })) };
      const c = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts.find((x: { kind: string }) => x.kind === "roster");
      expect(c.reason).toMatch(/live game/);
      await call("POST", "/tourplay/apply", ORG, { ...next, choices: [c.id] });
      expect(season().teams.find((t) => t.id === "moss-marauders")!.players.find((p) => p.name === "Grub Mossfoot")!.stats.td).toBe(0);
    });

    it("6: a deleted fixture stays deleted while the export leaves it out and after it comes back", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      edit((s) => { s.fixtures = s.fixtures.filter((f) => !(f.round === 2 && f.table === 2)); });
      await call("POST", "/tourplay/apply", ORG, upload());
      await call("POST", "/tourplay/apply", ORG, { zip: zipOf(seasonFiles(SLUG, { dropRound2Table2: true })) });
      await call("POST", "/tourplay/apply", ORG, upload());
      expect(season().fixtures).toHaveLength(3);
    });

    it("7: a corrected round or a renamed team is a preview pairing, never a silent copy", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const id = r1().id;
      // round 1 -> 9 for a played game
      const moved = { zip: zipOf(seasonFiles(SLUG, { round1Round: 9 })) };
      const pair = json(await call("POST", "/tourplay/preview", ORG, moved)).seasons[0].conflicts.find((c: { kind: string }) => c.kind === "pairing");
      expect(pair.reason).toMatch(/Possible correction of Moss Marauders v Quarry Quakers/);
      expect(pair.keepBothId).toMatch(/^cf/);
      await call("POST", "/tourplay/apply", ORG, moved);
      expect(season().fixtures).toHaveLength(4); // nothing added without a pick
      await call("POST", "/tourplay/apply", ORG, { ...moved, choices: [pair.id] });
      expect(season().fixtures).toHaveLength(4);
      expect(season().fixtures.find((f) => f.id === id)).toMatchObject({ round: 9, home: { score: 2 } });
      // a renamed team: "Quarry Quakers" -> "Quarry Quake" (same race and coach)
      const renamed = { zip: zipOf(seasonFiles(SLUG, { round1Round: 9, quinnTeam: "Quarry Quake" })) };
      const ren = json(await call("POST", "/tourplay/preview", ORG, renamed)).seasons[0].conflicts.find((c: { kind: string }) => c.kind === "rename");
      expect(ren.reason).toBe("Possible rename of Quarry Quakers");
      await call("POST", "/tourplay/apply", ORG, renamed);
      expect(season().teams).toHaveLength(5);
      expect(season().fixtures).toHaveLength(4);
      await call("POST", "/tourplay/apply", ORG, { ...renamed, choices: [ren.id] });
      expect(season().teams).toHaveLength(5);
      expect(season().teams.find((t) => t.id === "quarry-quakers")!.name).toBe("Quarry Quake");
      expect(season().fixtures).toHaveLength(4);
      expect(season().fixtures.find((f) => f.id === id)!.away).toMatchObject({ team: "Quarry Quake", teamId: "quarry-quakers", score: 1 });
      // "keep both" adds the copy, on purpose
      const back = { zip: zipOf(seasonFiles(SLUG, { round1Round: 2 })) };
      const pair2 = json(await call("POST", "/tourplay/preview", ORG, back)).seasons[0].conflicts.find((c: { kind: string }) => c.kind === "pairing");
      if (pair2) { await call("POST", "/tourplay/apply", ORG, { ...back, choices: [pair2.keepBothId] }); expect(season().fixtures.length).toBeGreaterThan(4); }
    });

    it("8: a row from before `linked` keeps its first coach linked when reassigned on the Teams tab", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const file = store.tourplayImport("vbl");
      const row = file.coaches["naf:rileyt"]!;
      delete row.linked;
      row.coachId = "RileyA";
      row.decision = { coachId: "RileyA", by: "Organiser1", at: "2026-11-01T00:00:00Z", via: "organiser" };
      store.putTourplayImport("vbl", file);
      expect(store.tourplayImport("vbl").coaches["naf:rileyt"]!.linked).toEqual(["RileyA"]); // migrated on read
      const rev = season().revision;
      await call("PATCH", "/seasons/season-1/teams/rapid-rascals", ORG, { revision: rev, coachId: "RileyB" });
      expect(store.tourplayImport("vbl").coaches["naf:rileyt"]!.linked?.sort()).toEqual(["RileyA", "RileyB"]);
    });

    it("9: the apply waits for the shared fork locks (a launch in flight)", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const s = season();
      const f = s.fixtures[0]!;
      let release!: () => void;
      const held = withForkLocks([fixtureLockKey("vbl", s.id, f.id)], [], () => new Promise<void>((r) => { release = r; }));
      let done = false;
      const applying = call("POST", "/tourplay/apply", ORG, upload()).then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 50));
      expect(done).toBe(false);
      release();
      await held;
      expect((await applying).status).toBe(200);
    });
  });

  describe("re-import pairings (review round 4)", () => {
    const zipOf = (files: Record<string, string>) => exportZip("valley-bowl-export", files).toString("base64");
    const season = () => store.season("vbl", "season-1")!;

    it("'Same game' on a home/away swap takes the export's sides: A-B 2-1 becomes B-A 1-2; links refuse the swap", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const f0 = season().fixtures.find((f) => f.round === 1 && f.home.team === "Moss Marauders")!;
      const swapped = { zip: zipOf(seasonFiles(SLUG, { round1Swap: true })) };
      const pair = json(await call("POST", "/tourplay/preview", ORG, swapped)).seasons[0].conflicts.find((c: { kind: string }) => c.kind === "pairing");
      expect(pair.options).toEqual([expect.objectContaining({ id: pair.id })]);
      // a recorder link: refused, nothing changes and nothing is added
      let s = season();
      s.fixtures.find((f) => f.id === f0.id)!.tabletop = { revision: 1 };
      store.putSeason(s);
      const refused = json(await call("POST", "/tourplay/preview", ORG, { ...swapped, choices: [pair.id] })).seasons[0].conflicts.find((c: { kind: string }) => c.kind === "pairing");
      expect(refused.reason).toMatch(/^Can't match .*recorder/);
      await call("POST", "/tourplay/apply", ORG, { ...swapped, choices: [pair.id] });
      expect(season().fixtures).toHaveLength(4);
      expect(season().fixtures.find((f) => f.id === f0.id)).toMatchObject({ home: { team: "Moss Marauders", score: 2 }, away: { team: "Quarry Quakers", score: 1 } });
      // without links: the sides swap with their ids and coaches
      s = season();
      delete s.fixtures.find((f) => f.id === f0.id)!.tabletop;
      store.putSeason(s);
      expect((await call("POST", "/tourplay/apply", ORG, { ...swapped, choices: [pair.id] })).status).toBe(200);
      expect(season().fixtures).toHaveLength(4);
      expect(season().fixtures.find((f) => f.id === f0.id)).toMatchObject({
        home: { team: "Quarry Quakers", teamId: "quarry-quakers", coach: "Quinn Sample", race: "Dwarf", score: 1 },
        away: { team: "Moss Marauders", teamId: "moss-marauders", coach: "Morgan Example", race: "Orc", score: 2 },
      });
    });

    it("every possible pairing is offered, none taken greedily: a round-3 row sharing a team does not swallow the orphan, and the real correction is never added silently", async () => {
      await call("POST", "/tourplay/apply", ORG, upload());
      const f0 = season().fixtures.find((f) => f.round === 1 && f.home.team === "Moss Marauders")!;
      // the round-3 Quarry v Ashen row comes first (reverse) and shares Quarry with the orphan; round 1 became round 9
      const next = { zip: zipOf(seasonFiles(SLUG, { round1Round: 9, extraRound: true, reverse: true })) };
      const pairs = json(await call("POST", "/tourplay/preview", ORG, next)).seasons[0].conflicts.filter((c: { kind: string }) => c.kind === "pairing");
      expect(pairs).toHaveLength(2);
      const r9 = pairs.find((c: { label: string }) => /round 9/.test(c.label));
      const r3 = pairs.find((c: { label: string }) => /round 3/.test(c.label));
      expect(r9.options.map((o: { label: string }) => o.label)).toEqual([expect.stringMatching(/round 1\)/)]);
      expect(r3.options.map((o: { label: string }) => o.label)).toEqual([expect.stringMatching(/round 1\)/)]);
      // undecided: nothing is added
      await call("POST", "/tourplay/apply", ORG, next);
      expect(season().fixtures).toHaveLength(4);
      // both rows picking the same fixture: only one may take it
      const clash = json(await call("POST", "/tourplay/preview", ORG, { ...next, choices: [r9.options[0].id, r3.options[0].id] })).seasons[0].conflicts.filter((c: { kind: string }) => c.kind === "pairing");
      expect(clash.some((c: { reason: string }) => /already matched/.test(c.reason))).toBe(true);
      // the organiser matches round 9 and says round 3 is a new game
      expect((await call("POST", "/tourplay/apply", ORG, { ...next, choices: [r9.options[0].id, r3.keepBothId] })).status).toBe(200);
      expect(season().fixtures).toHaveLength(5);
      expect(season().fixtures.find((f) => f.id === f0.id)).toMatchObject({ round: 9, home: { score: 2 }, away: { score: 1 } });
      expect(season().fixtures.filter((f) => f.round === 9)).toHaveLength(1);
    });
  });

  describe("NAF numbers stay private", () => {
    it("never on a season, league, stats or export read, nor in the season files; Payment and Observations dropped", async () => {
      await call("POST", "/tourplay/apply", ORG, upload({ decisions: await confirmAll() }));
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
      expect(store.season("vbl", "season-1")!.teams.find((t) => t.name === "Cobble Crushers")!.coachId).toBe("CaseyDemo");
      expect((await rowByName("Casey Demo")).decision).toMatchObject({ coachId: "CaseyDemo", via: "organiser" });
      // remembered on the next re-import without a decision
      await call("POST", "/tourplay/apply", ORG, upload());
      expect(store.season("vbl", "season-1")!.teams.find((t) => t.name === "Cobble Crushers")!.coachId).toBe("CaseyDemo");
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
      await call("POST", "/tourplay/apply", ORG, upload({ decisions: await confirmAll() }));
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
