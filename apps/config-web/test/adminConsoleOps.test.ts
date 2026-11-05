// Admin console v2 Operations, below HTTP: the ratings backup module and scripts/reset-ratings.ts (backup always first; a
// failed backup means no reset; --restore is a dry run unless --yes and round-trips exactly), the demo-league dry runs
// (plans only, nothing written), the one-at-a-time guard, and the pure route gate. Temp dirs only.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adminConsoleApi, exclusive, type AdminConsoleDeps } from "../src/admin/console.js";
import { planDemoRemove, planDemoSeed, seedDemoLeagues } from "../src/leagues/demoLeagues.js";
import { listRatingsBackups, planRatingsRestore, ratingsBackupDir, restoreRatingsBackup } from "../src/ratings/backup.js";
import { ratingsStateFile } from "../src/ratings/state.js";
import { resetRatings, restoreRatings } from "../scripts/reset-ratings.js";

const roots: string[] = [];
const temp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); roots.push(d); return d; };
afterAll(() => { for (const d of roots) rmSync(d, { recursive: true, force: true }); });

describe("scripts/reset-ratings.ts backup and restore", () => {
  it("--yes always writes the backup before the reset; the backup holds the exact previous text", () => {
    const dir = temp("ratings-script-");
    const original = '{ "version": 1, "resetAt": "2026-02-03T04:05:06.000Z" }\n';
    writeFileSync(ratingsStateFile(dir), original, "utf8");
    const r = resetRatings({ stateDir: dir, yes: true, now: new Date("2026-11-04T10:00:00.000Z") });
    expect(r.backup?.name).toBe("site-ratings-20261104T100000000Z.json");
    expect(JSON.parse(readFileSync(join(ratingsBackupDir(dir), r.backup!.name), "utf8")).content).toBe(original);
    expect(JSON.parse(readFileSync(ratingsStateFile(dir), "utf8")).resetAt).toBe("2026-11-04T10:00:00.000Z");
  });

  it("a dry run writes no backup", () => {
    const dir = temp("ratings-script-dry-");
    resetRatings({ stateDir: dir, yes: false });
    expect(existsSync(ratingsBackupDir(dir))).toBe(false);
  });

  it("no backup, no reset: when the backup cannot be written the state file is left alone", () => {
    const dir = temp("ratings-script-nobackup-");
    writeFileSync(ratingsStateFile(dir), '{"version":1}\n', "utf8");
    mkdirSync(join(dir, "backups"), { recursive: true });
    writeFileSync(join(dir, "backups", "ratings"), "not a folder", "utf8"); // the backups folder can't be made
    expect(() => resetRatings({ stateDir: dir, yes: true })).toThrow();
    expect(readFileSync(ratingsStateFile(dir), "utf8")).toBe('{"version":1}\n');
  });

  it("--restore is a dry run by default; --yes restores byte for byte and backs up what it replaced", () => {
    const dir = temp("ratings-script-restore-");
    const original = '{"version":1,"resetAt":"2026-03-01T00:00:00.000Z"}';
    writeFileSync(ratingsStateFile(dir), original, "utf8");
    const reset = resetRatings({ stateDir: dir, yes: true, now: new Date("2026-11-04T11:00:00.000Z") });
    const afterReset = readFileSync(ratingsStateFile(dir), "utf8");
    const dry = restoreRatings({ stateDir: dir, backup: reset.backup!.name, yes: false });
    expect(dry).toMatchObject({ dryRun: true, plan: { changes: true, restored: { resetAt: "2026-03-01T00:00:00.000Z" } } });
    expect(readFileSync(ratingsStateFile(dir), "utf8")).toBe(afterReset);
    // a path to the backup works too (the script takes the file name)
    const done = restoreRatings({ stateDir: dir, backup: join(ratingsBackupDir(dir), reset.backup!.name), yes: true, now: new Date("2026-11-04T12:00:00.000Z") });
    expect(done.dryRun).toBe(false);
    expect(readFileSync(ratingsStateFile(dir), "utf8")).toBe(original);
    expect(listRatingsBackups(dir).map((b) => b.reason)).toEqual(["before-restore", "before-reset"]);
  });

  it("a backup holding a file the site can't read is refused before anything is written", () => {
    const dir = temp("ratings-script-bad-");
    mkdirSync(ratingsBackupDir(dir), { recursive: true });
    const name = "site-ratings-20261104T090000000Z.json";
    writeFileSync(join(ratingsBackupDir(dir), name), JSON.stringify({ kind: "site-ratings-backup", version: 1, createdAt: "x", reason: "manual", file: "site-ratings.json", existed: true, content: '{"version":2}' }), "utf8");
    expect(() => restoreRatings({ stateDir: dir, backup: name, yes: true })).toThrow(/cannot read/);
    expect(existsSync(ratingsStateFile(dir))).toBe(false);
    expect(readdirSync(ratingsBackupDir(dir))).toEqual([name]); // not even the safety backup
  });
});

describe("demo league dry runs", () => {
  it("plans without writing; after a seed the plans say refresh / remove", async () => {
    const dir = temp("demo-plan-");
    expect(planDemoSeed({ stateDir: dir }).every((r) => r.action === "create")).toBe(true);
    expect(planDemoRemove({ stateDir: dir })).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    await seedDemoLeagues({ stateDir: dir, now: new Date("2026-11-04T00:00:00.000Z") });
    expect(planDemoSeed({ stateDir: dir }).every((r) => r.action === "refresh")).toBe(true);
    expect(planDemoRemove({ stateDir: dir }).every((r) => r.action === "remove")).toBe(true);
  });
});

describe("route gate and the one-at-a-time guard", () => {
  const deps = { stateDir: temp("admin-gate-") } as unknown as AdminConsoleDeps;
  it("answers only its own paths; 401 signed out, 403 for anyone not a site admin", async () => {
    expect(await adminConsoleApi("GET", "/api/admin/identities", { coach: "A", admin: true }, undefined, deps)).toBeUndefined();
    expect((await adminConsoleApi("GET", "/api/admin/overview", undefined, undefined, deps))?.status).toBe(401);
    expect((await adminConsoleApi("GET", "/api/admin/overview", { coach: "Org", admin: false }, undefined, deps))?.status).toBe(403);
    expect((await adminConsoleApi("POST", "/api/admin/ops/ratings/reset", { coach: "Org" }, {}, deps))?.status).toBe(403);
  });

  it("a second Operations write while one runs answers 409", async () => {
    let release!: () => void;
    const first = exclusive(() => new Promise((r) => { release = () => r({ status: 200, body: {} }); }));
    expect((await exclusive(async () => ({ status: 200, body: {} }))).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect((await exclusive(async () => ({ status: 200, body: {} }))).status).toBe(200);
  });
});

describe("Sol P2 fixes below HTTP", () => {
  it("recheck runs after the body and again right before an apply acts; a refusal there writes nothing", async () => {
    const dir = temp("admin-recheck-");
    let calls = 0;
    const deps = { stateDir: dir, now: () => new Date("2026-11-04T10:00:00.000Z"), ratingsPreview: () => ({ coaches: 0, games: 0 }),
      recheck: () => (++calls >= 2 ? { status: 403, body: { error: "Site admins only." } } : undefined) } as unknown as AdminConsoleDeps;
    const who = { coach: "Root", admin: true };
    const dry = await adminConsoleApi("POST", "/api/admin/ops/ratings/reset", who, {}, { ...deps, recheck: () => undefined });
    calls = 0;
    const out = await adminConsoleApi("POST", "/api/admin/ops/ratings/reset", who, { apply: true, confirm: "RESET RATINGS", revision: (dry!.body as { revision: string }).revision }, deps);
    expect(out?.status).toBe(403);
    expect(calls).toBe(2);
    expect(existsSync(ratingsStateFile(dir))).toBe(false);
    expect(existsSync(ratingsBackupDir(dir))).toBe(false);
  });

  it("the restore revision binds the backup bytes: changed bytes after the dry run answer 409 from the module", () => {
    const dir = temp("admin-rev-");
    writeFileSync(ratingsStateFile(dir), '{"version":1}', "utf8");
    const reset = resetRatings({ stateDir: dir, yes: true, now: new Date("2026-11-04T10:00:00.000Z") });
    const name = reset.backup!.name;
    const plan = restoreRatings({ stateDir: dir, backup: name, yes: false }).plan;
    const path = join(ratingsBackupDir(dir), name);
    writeFileSync(path, readFileSync(path, "utf8").replace('"before-reset"', '"manual"'), "utf8"); // same content, other bytes
    const live = readFileSync(ratingsStateFile(dir), "utf8");
    expect(() => restoreRatingsBackup(dir, name, new Date(), plan.revision)).toThrow(/changed since the dry run/);
    expect(readFileSync(ratingsStateFile(dir), "utf8")).toBe(live);
    expect(planRatingsRestore(dir, name).revision).not.toBe(plan.revision);
  });
});
