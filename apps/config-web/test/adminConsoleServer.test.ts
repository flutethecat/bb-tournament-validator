// Admin console v2 over HTTP (spec-admin-console-v2-2026-11-04): the new /api/admin routes are site-admin only (admin vs
// organiser vs coach vs anonymous), CSRF-protected for cookie sessions, GETs never write, the ratings reset always backs
// up first and a restore round-trips the file byte for byte, dry runs change nothing, applies need the typed phrase (and
// the ratings ones the dry run's revision), the moderation aggregate only reads, every Operations action is logged, and
// /admin.html redirects to /app/admin. Isolated state: every store points into this suite's temp root. Invented names only.
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardFileName } from "../src/boards/board.js";
import { DEMO_LEAGUES } from "../src/leagues/demoLeagues.js";
import { createSession, ONBOARDED_CONSENT } from "./onboardedFixture.js";

const root = mkdtempSync(join(tmpdir(), "admin-console-server-"));
const state = join(root, "state");
const previousEnv = new Map<string, string | undefined>();
let origin = "";
let server: (typeof import("../src/server.js"))["server"];

const rec = (ffbCoachId: string, level: string) => ({
  ffbCoachId, level, banned: false, silenced: false, note: "", profile: {}, identities: {}, consent: ONBOARDED_CONSENT, updatedAt: "", updatedBy: "",
});

beforeAll(async () => {
  for (const [name, value] of Object.entries({
    AUTH_SIDECAR_ENABLED: "1", HOST: "127.0.0.1", PORT: "0",
    IDENTITIES_FILE: join(root, "identities.json"), ORGANIZERS_FILE: join(root, "organizers.json"),
    FORK_LIBRARY_DIR: join(root, "library"), FORK_TEAMS_DIR: "", FORK_ADMIN_PASSWORD: "", ADMIN_PASSWORD: "",
    FORK_STATE_DIR: state, TOURNAMENTS_DIR: join(root, "tournaments"), BUG_REPORTS_DIR: join(root, "bugs"),
  })) {
    previousEnv.set(name, process.env[name]);
    process.env[name] = value;
  }
  for (const d of ["library", "state", "tournaments", "bugs"]) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, "identities.json"), JSON.stringify({ version: 1, coaches: {
    boss: rec("Boss", "admin"), orgcoach: rec("OrgCoach", "organizer"), plaincoach: rec("PlainCoach", "player"),
  } }), "utf8");
  writeFileSync(join(root, "organizers.json"), JSON.stringify({ organizers: [] }), "utf8");
  // a league board with one open report and one running mute (written as the board store writes it)
  const scope = "league:demo-board-league";
  mkdirSync(join(state, "boards"), { recursive: true });
  writeFileSync(join(state, "boards", boardFileName(scope)), JSON.stringify({
    version: 1, scope, seq: 1, seen: {}, notified: {},
    threads: [{ id: "p1", author: "PlainCoach", text: "Rude words here", at: "2026-11-01T10:00:00.000Z", title: "Hello", replies: [], lastAt: "2026-11-01T10:00:00.000Z" }],
    reports: [{ id: "r1", postId: "p1", threadId: "p1", reporter: "OrgCoach", reason: "Rude", at: "2026-11-01T11:00:00.000Z" }], rseq: 1,
    mutes: { plaincoach: { coach: "PlainCoach", until: "2099-01-01T00:00:00.000Z", by: "OrgCoach", at: "2026-11-01T11:00:00.000Z", reason: "Cool off" } },
  }), "utf8");
  ({ server } = await import("../src/server.js"));
  if (!server.listening) await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [name, value] of previousEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

const as = (coach: string) => ({ authorization: `Bearer ${createSession(coach).token}`, "content-type": "application/json" });
const get = (path: string, coach?: string) => fetch(`${origin}${path}`, { headers: coach ? as(coach) : {} });
const post = (path: string, body: unknown, coach?: string) => fetch(`${origin}${path}`, { method: "POST", headers: coach ? as(coach) : { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as Record<string, any>;

const GETS = ["/api/admin/overview", "/api/admin/moderation", "/api/admin/ops/log", "/api/admin/ops/ratings"];
const POSTS = ["/api/admin/ops/ratings/reset", "/api/admin/ops/ratings/restore", "/api/admin/ops/demo-leagues", "/api/admin/ops/fork-reload", "/api/admin/ops/league-fork-cleanup"];

/** Every file under the state dir with its size and mtime (a GET must leave this exactly as it was). */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p); else out.push(`${p}:${st.size}:${st.mtimeMs}`);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort().join("\n");
}

describe("gates", () => {
  it("anonymous 401, coach 403, organiser 403 on every new route; admin passes", async () => {
    for (const path of GETS) {
      expect((await get(path)).status, path).toBe(401);
      expect((await get(path, "PlainCoach")).status, path).toBe(403);
      expect((await get(path, "OrgCoach")).status, path).toBe(403);
      expect((await get(path, "Boss")).status, path).toBe(200);
    }
    for (const path of POSTS) {
      expect((await post(path, {})).status, path).toBe(401);
      expect((await post(path, {}, "PlainCoach")).status, path).toBe(403);
      expect((await post(path, {}, "OrgCoach")).status, path).toBe(403);
    }
  });

  it("writes are POST only (GET on a write route is refused) and reads refuse POST", async () => {
    expect((await get("/api/admin/ops/ratings/reset", "Boss")).status).toBe(405);
    expect((await post("/api/admin/overview", {}, "Boss")).status).toBe(405);
  });

  it("cookie sessions need the CSRF header on a write", async () => {
    const cookie = `cw_session=${createSession("Boss").token}`;
    const without = await fetch(`${origin}/api/admin/ops/ratings/reset`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(without.status).toBe(403);
    const withHeader = await fetch(`${origin}/api/admin/ops/ratings/reset`, { method: "POST", headers: { cookie, "content-type": "application/json", "x-cw-auth": "1" }, body: "{}" });
    expect(withHeader.status).toBe(200);
  });
});

describe("read-only routes", () => {
  it("GETs never write: the state dir is byte-for-byte the same after every read", async () => {
    const before = snapshot(state);
    for (const path of GETS) expect((await get(path, "Boss")).status).toBe(200);
    expect(snapshot(state)).toBe(before);
  });

  it("overview: version, uptime and counts", async () => {
    const o = await json(await get("/api/admin/overview", "Boss"));
    expect(o.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(o.version).toHaveProperty("commit");
    expect(o.counts).toMatchObject({ coaches: 3, openBoardReports: 1, openReports: 0, stuckPrivacyJobs: 0 });
  });

  it("moderation: the open report (with its post) and the running mute, linked to the board; the board file is untouched", async () => {
    const file = join(state, "boards", boardFileName("league:demo-board-league"));
    const bytes = readFileSync(file, "utf8");
    const mtime = statSync(file).mtimeMs;
    const m = await json(await get("/api/admin/moderation", "Boss"));
    expect(m.openReports).toBe(1);
    expect(m.boards[0]).toMatchObject({ kind: "league", id: "demo-board-league", href: "/app/leagues/demo-board-league?tab=board" });
    expect(m.boards[0].openReports[0]).toMatchObject({ id: "r1", reason: "Rude", post: { author: "PlainCoach", text: "Rude words here" } });
    expect(m.boards[0].mutes[0]).toMatchObject({ coach: "PlainCoach", by: "OrgCoach" });
    expect(readFileSync(file, "utf8")).toBe(bytes);
    expect(statSync(file).mtimeMs).toBe(mtime);
  });
});

describe("ratings reset and restore", () => {
  const ratingsFile = join(state, "site-ratings.json");
  const backups = join(state, "backups", "ratings");

  it("dry run writes nothing but the log; apply needs the phrase (400) and the revision (428 / 409)", async () => {
    rmSync(backups, { recursive: true, force: true });
    const dry = await json(await post("/api/admin/ops/ratings/reset", {}, "Boss"));
    expect(dry).toMatchObject({ dryRun: true, confirm: "RESET RATINGS", previousResetAt: null });
    expect(existsSync(ratingsFile)).toBe(false);
    expect(existsSync(backups)).toBe(false);
    expect((await post("/api/admin/ops/ratings/reset", { apply: true, revision: dry.revision }, "Boss")).status).toBe(400);
    expect((await post("/api/admin/ops/ratings/reset", { apply: true, confirm: "reset" , revision: dry.revision }, "Boss")).status).toBe(400);
    expect((await post("/api/admin/ops/ratings/reset", { apply: true, confirm: "RESET RATINGS" }, "Boss")).status).toBe(428);
    expect((await post("/api/admin/ops/ratings/reset", { apply: true, confirm: "RESET RATINGS", revision: "stale" }, "Boss")).status).toBe(409);
    expect(existsSync(ratingsFile)).toBe(false);
    expect(existsSync(backups)).toBe(false);
  });

  it("apply always writes the backup first (here: 'no file'), then the reset; the restore puts the exact bytes back", async () => {
    // a live state file with unusual (but valid) formatting, so a byte-exact round trip is visible
    const original = '{"version":1,   "resetAt":"2026-01-02T03:04:05.000Z"}\n';
    writeFileSync(ratingsFile, original, "utf8");
    const dry = await json(await post("/api/admin/ops/ratings/reset", {}, "Boss"));
    const done = await post("/api/admin/ops/ratings/reset", { apply: true, confirm: "RESET RATINGS", revision: dry.revision }, "Boss");
    expect(done.status).toBe(200);
    const out = await json(done);
    expect(out.backup.reason).toBe("before-reset");
    const backupFile = JSON.parse(readFileSync(join(backups, out.backup.name), "utf8"));
    expect(backupFile).toMatchObject({ kind: "site-ratings-backup", existed: true, content: original });
    const reset = readFileSync(ratingsFile, "utf8");
    expect(JSON.parse(reset).resetAt).toBe(out.resetAt);
    expect(reset).not.toBe(original);

    // the list shows it (time, size)
    const view = await json(await get("/api/admin/ops/ratings", "Boss"));
    expect(view.backups.map((b: { name: string }) => b.name)).toContain(out.backup.name);
    expect(view.backups[0].size).toBeGreaterThan(0);

    // restore: dry run says what changes and writes nothing; apply needs phrase + revision; then the bytes are back
    const plan = await json(await post("/api/admin/ops/ratings/restore", { backup: out.backup.name }, "Boss"));
    expect(plan).toMatchObject({ dryRun: true, changes: true, current: { existed: true, resetAt: out.resetAt }, restored: { existed: true, resetAt: "2026-01-02T03:04:05.000Z" } });
    expect(readFileSync(ratingsFile, "utf8")).toBe(reset);
    expect((await post("/api/admin/ops/ratings/restore", { backup: out.backup.name, apply: true, revision: plan.revision }, "Boss")).status).toBe(400);
    expect((await post("/api/admin/ops/ratings/restore", { backup: out.backup.name, apply: true, confirm: "RESTORE RATINGS" }, "Boss")).status).toBe(428);
    const restored = await post("/api/admin/ops/ratings/restore", { backup: out.backup.name, apply: true, confirm: "RESTORE RATINGS", revision: plan.revision }, "Boss");
    expect(restored.status).toBe(200);
    expect(readFileSync(ratingsFile, "utf8")).toBe(original);
    // the state it replaced was backed up first, so the restore can itself be undone
    const safety = (await json(restored)).safetyBackup;
    expect(JSON.parse(readFileSync(join(backups, safety.name), "utf8")).content).toBe(reset);
  });

  it("a backup of 'no file' restores to no file; unknown or traversal backup names are refused", async () => {
    rmSync(ratingsFile, { force: true });
    const dry = await json(await post("/api/admin/ops/ratings/reset", {}, "Boss"));
    const out = await json(await post("/api/admin/ops/ratings/reset", { apply: true, confirm: "RESET RATINGS", revision: dry.revision }, "Boss"));
    expect(out.backup.existed).toBe(false);
    expect(existsSync(ratingsFile)).toBe(true);
    const plan = await json(await post("/api/admin/ops/ratings/restore", { backup: out.backup.name }, "Boss"));
    await post("/api/admin/ops/ratings/restore", { backup: out.backup.name, apply: true, confirm: "RESTORE RATINGS", revision: plan.revision }, "Boss");
    expect(existsSync(ratingsFile)).toBe(false);
    expect((await post("/api/admin/ops/ratings/restore", { backup: "../identities.json" }, "Boss")).status).toBe(400);
    expect((await post("/api/admin/ops/ratings/restore", { backup: "site-ratings-20990101T000000000Z.json" }, "Boss")).status).toBe(404);
  });
});

describe("demo leagues", () => {
  const leagueFile = (id: string) => join(state, "leagues", id, "league.json");

  it("seed: dry run plans 12 creates and writes nothing; apply needs the phrase; then 12 test leagues exist", async () => {
    const dry = await json(await post("/api/admin/ops/demo-leagues", { action: "seed" }, "Boss"));
    expect(dry).toMatchObject({ dryRun: true, counts: { create: 12 }, confirm: "SEED DEMO LEAGUES" });
    expect(existsSync(join(state, "demo-leagues.seed.json"))).toBe(false);
    for (const d of DEMO_LEAGUES) expect(existsSync(leagueFile(d.id))).toBe(false);
    expect((await post("/api/admin/ops/demo-leagues", { action: "seed", apply: true }, "Boss")).status).toBe(400);
    expect((await post("/api/admin/ops/demo-leagues", { action: "nuke", apply: true, confirm: "SEED DEMO LEAGUES" }, "Boss")).status).toBe(400);
    const done = await post("/api/admin/ops/demo-leagues", { action: "seed", apply: true, confirm: "SEED DEMO LEAGUES" }, "Boss");
    expect(done.status).toBe(200);
    expect((await json(done)).ids).toHaveLength(12);
    for (const d of DEMO_LEAGUES) expect(JSON.parse(readFileSync(leagueFile(d.id), "utf8"))).toMatchObject({ test: true, name: d.name });
    // the running server sees them (its own store wrote them)
    const leagues = await json(await get("/api/admin/overview", "Boss"));
    expect(leagues.counts.leagues).toBeGreaterThanOrEqual(12);
    // a second dry run now plans refreshes
    expect((await json(await post("/api/admin/ops/demo-leagues", { action: "seed" }, "Boss"))).counts).toEqual({ refresh: 12 });
  });

  it("remove: dry run removes nothing; apply removes them all", async () => {
    const dry = await json(await post("/api/admin/ops/demo-leagues", { action: "remove" }, "Boss"));
    expect(dry).toMatchObject({ dryRun: true, counts: { remove: 12 }, confirm: "REMOVE DEMO LEAGUES" });
    for (const d of DEMO_LEAGUES) expect(existsSync(leagueFile(d.id))).toBe(true);
    expect((await post("/api/admin/ops/demo-leagues", { action: "remove", apply: true, confirm: "SEED DEMO LEAGUES" }, "Boss")).status).toBe(400);
    const done = await json(await post("/api/admin/ops/demo-leagues", { action: "remove", apply: true, confirm: "REMOVE DEMO LEAGUES" }, "Boss"));
    expect(done.ids).toHaveLength(12);
    for (const d of DEMO_LEAGUES) expect(existsSync(leagueFile(d.id))).toBe(false);
  });
});

describe("operations without a fork, and the log", () => {
  it("fork reload and league cleanup answer 503 here (no fork) and are still logged", async () => {
    expect((await post("/api/admin/ops/fork-reload", {}, "Boss")).status).toBe(503);
    expect((await post("/api/admin/ops/league-fork-cleanup", {}, "Boss")).status).toBe(503);
    expect((await post("/api/admin/ops/league-fork-cleanup", { apply: true }, "Boss")).status).toBe(400); // phrase first
  });

  it("every Operations action is logged: who, when, what, dry run or not, and the backup", async () => {
    const { entries } = await json(await get("/api/admin/ops/log?limit=200", "Boss"));
    const actions = new Set(entries.map((e: { action: string }) => e.action));
    for (const a of ["ratings-reset", "ratings-restore", "demo-seed", "demo-remove", "league-fork-cleanup"]) expect(actions.has(a), a).toBe(true);
    expect(entries.every((e: { by: string; at: string }) => e.by === "Boss" && Number.isFinite(Date.parse(e.at)))).toBe(true);
    expect(entries.some((e: { action: string; dryRun: boolean }) => e.action === "ratings-reset" && e.dryRun)).toBe(true);
    expect(entries.some((e: { action: string; dryRun: boolean; backup?: string }) => e.action === "ratings-reset" && !e.dryRun && /^site-ratings-/.test(e.backup ?? ""))).toBe(true);
  });
});

describe("old page", () => {
  it("/admin.html redirects to /app/admin (the browser keeps the #section)", async () => {
    const r = await fetch(`${origin}/admin.html`, { redirect: "manual" });
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app/admin");
  });
});
