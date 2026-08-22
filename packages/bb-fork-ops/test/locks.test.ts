import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { acknowledgeForkCacheReload, acquireFileWriteLock, acquireTeamNameWriteLock, acquireTeamWriteLock, markForkCacheReloadRequired, teamWriteLockPath } from "@bb/fork-ops";

const roots: string[] = [];
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("cross-process team locks", () => {
  it("serializes same-team writers and permits unrelated teams", () => {
    const root = mkdtempSync(join(tmpdir(), "team-lock-")); roots.push(root);
    const first = acquireTeamWriteLock(root, "42")!;
    expect(acquireTeamWriteLock(root, "42")).toBeUndefined();
    const other = acquireTeamWriteLock(root, "43")!;
    other.release();
    first.release();
    acquireTeamWriteLock(root, "42")!.release();
  });

  it("serializes global team-name commits even for different team ids", () => {
    const root = mkdtempSync(join(tmpdir(), "team-name-lock-")); roots.push(root);
    const first = acquireTeamNameWriteLock(root)!;
    expect(acquireTeamNameWriteLock(root)).toBeUndefined();
    // Per-team locks remain independently available; the route lock order is name then team.
    const differentId = acquireTeamWriteLock(root, "different")!;
    differentId.release();
    first.release();
    acquireTeamNameWriteLock(root)!.release();
  });

  it("recovers a stale lock only when its PID is dead", () => {
    const root = mkdtempSync(join(tmpdir(), "stale-lock-")); roots.push(root);
    const path = teamWriteLockPath(root, "42");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "owner.json"), JSON.stringify({ token: "dead", pid: 2_147_483_647, createdAt: 0 }), "utf8");
    const recovered = acquireFileWriteLock(path, Date.now() + 10_000, 1);
    expect(recovered).toBeDefined();
    expect(JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token).not.toBe("dead");
    recovered!.release();
  });

  it("recovers a fresh lock immediately when its recorded PID is definitely dead", () => {
    const root = mkdtempSync(join(tmpdir(), "dead-lock-")); roots.push(root);
    const path = teamWriteLockPath(root, "42");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "owner.json"), JSON.stringify({ token: "dead", pid: 2_147_483_647, createdAt: Date.now() }), "utf8");
    const recovered = acquireFileWriteLock(path);
    expect(recovered).toBeDefined();
    recovered!.release();
  });

  it("blocks ordinary team writers while fork cache recovery is pending", () => {
    const root = mkdtempSync(join(tmpdir(), "cache-marker-")); roots.push(root);
    markForkCacheReloadRequired(root, "test rollback");
    expect(acquireTeamWriteLock(root, "42")).toBeUndefined();
    const recoveryLock = acquireTeamWriteLock(root, "42", Date.now(), true);
    expect(recoveryLock).toBeDefined();
    recoveryLock!.release();
    acknowledgeForkCacheReload(root);
    acquireTeamWriteLock(root, "42")!.release();
  });

  it("refuses a lock held by a live external process", async () => {
    const root = mkdtempSync(join(tmpdir(), "process-lock-")); roots.push(root);
    const path = teamWriteLockPath(root, "42");
    const ready = join(root, "ready");
    const script = `const fs=require('node:fs');const p=${JSON.stringify(path)};fs.mkdirSync(p,{recursive:true});fs.writeFileSync(require('node:path').join(p,'owner.json'),JSON.stringify({token:'child',pid:process.pid,createdAt:0}));fs.writeFileSync(${JSON.stringify(ready)},'1');setTimeout(()=>{},1500);`;
    const child = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    try {
      for (let i = 0; i < 50 && !readReady(ready); i += 1) await pause(20);
      expect(readReady(ready)).toBe(true);
      expect(acquireFileWriteLock(path, Date.now() + 10_000, 1)).toBeUndefined();
    } finally {
      child.kill();
    }
  });
});

function readReady(path: string): boolean {
  try { return readFileSync(path, "utf8") === "1"; } catch { return false; }
}
