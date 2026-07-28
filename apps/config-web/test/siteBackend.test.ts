import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NonceStore } from "../src/site-backend/nonceStore.js";
import { bankGameResult, recoverInterrupted, type BankingDirs, type TeamBankTask } from "../src/site-backend/banking.js";
import { adminResponse } from "@bb/fork-ops";

// ── TP-5: bounded, single-use nonce store ──────────────────────────────────────
describe("NonceStore (TP-5 bounded by construction)", () => {
  it("issues a 16-byte hex nonce and consumes it exactly once (no replay)", () => {
    const s = new NonceStore();
    const n = s.issue("Flutethecat");
    expect(n).toMatch(/^[0-9a-f]{32}$/);
    expect(s.consume("Flutethecat")).toBe(n);
    expect(s.consume("Flutethecat")).toBeUndefined(); // single-use — can't replay
  });

  it("keeps ONE outstanding nonce per coach (re-issue evicts the prior)", () => {
    const s = new NonceStore();
    s.issue("A");
    const second = s.issue("A");
    expect(s.size()).toBe(1);
    expect(s.consume("A")).toBe(second);
  });

  it("is coach-case-insensitive (matches the fork's equalsIgnoreCase coach handling)", () => {
    const s = new NonceStore();
    const n = s.issue("Gondra87");
    expect(s.consume("gondra87")).toBe(n);
  });

  it("expires an unconsumed nonce after the TTL", () => {
    let t = 1000;
    const s = new NonceStore({ ttlMs: 100, now: () => t });
    s.issue("A");
    t = 1201; // past TTL
    expect(s.consume("A")).toBeUndefined();
    expect(s.size()).toBe(0);
  });

  it("HARD-CAPS distinct coaches by LRU eviction (cannot grow unbounded)", () => {
    const s = new NonceStore({ maxCoaches: 3 });
    for (const c of ["a", "b", "c", "d", "e"]) s.issue(c);
    expect(s.size()).toBe(3); // capped regardless of caller volume
    expect(s.consume("a")).toBeUndefined(); // oldest evicted
    expect(s.consume("e")).toBeDefined(); // newest kept
  });
});

// ── TP-1: the auth verify reuses the verified replica (challenge round-trip) ────
describe("challenge/response round-trip (TP-1 reuse adminResponse)", () => {
  it("a response computed with adminResponse verifies against the issued nonce", () => {
    const s = new NonceStore();
    const storedMd5 = "0".repeat(32); // stand-in md5(pw)
    const nonce = s.issue("A");
    // client side: PasswordChallenge.createResponse(nonce, md5(pw)) === adminResponse(nonce, md5)
    const clientResponse = adminResponse(nonce, storedMd5);
    // site side: consume the nonce, recompute, compare
    const issued = s.consume("A")!;
    expect(adminResponse(issued, storedMd5)).toBe(clientResponse); // match ⇒ OK
    // a wrong password digest must NOT verify
    expect(adminResponse(issued, "f".repeat(32))).not.toBe(clientResponse);
  });
});

// ── C-2 / BR-1 / BR-3: crash-safe two-phase banking ledger ─────────────────────
describe("bankGameResult (C-2 crash-safe two-phase ledger)", () => {
  let root: string;
  let dirs: BankingDirs;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bank-"));
    dirs = { resultsDir: join(root, "results"), teamsDir: join(root, "teams") };
    mkdirSync(dirs.teamsDir, { recursive: true });
    writeFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "<team id=\"900001\"><spp>0</spp></team>", "utf8");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const bumpSpp = (xml: string): string => xml.replace(/<spp>(\d+)<\/spp>/, (_, n) => `<spp>${Number(n) + 6}</spp>`);
  const task = (teamId: string, fn = bumpSpp): TeamBankTask => ({ teamId, applyFn: fn });

  it("applies a clean result and marks APPLIED", () => {
    const r = bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["900001"]);
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>");
    const marker = JSON.parse(readFileSync(join(dirs.resultsDir, "ledger", "g1_900001.json"), "utf8"));
    expect(marker.phase).toBe("APPLIED");
  });

  it("is IDEMPOTENT — re-banking the same (game,team) does NOT double-apply (BR-1)", () => {
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>"); // replay
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>"); // not 12
  });

  it("CRASH-SAFE: a throw mid-apply leaves the team file intact and recoverable (BR-3, kill-mid-apply)", () => {
    // apply throws AFTER the IN_PROGRESS marker + .bak are written but BEFORE commit
    const boom = () => { throw new Error("killed mid-apply"); };
    const r = bankGameResult(dirs, "g1", [task("900001", boom)], "<gameResult/>");
    expect(r.ok).toBe(false);
    // team file is unchanged (restored from .bak), NOT half-written
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>0</spp>");
    // it landed in quarantine, never a partial bank
    expect(existsSync(join(dirs.resultsDir, "quarantine"))).toBe(true);
  });

  it("RECOVERS an interrupted IN_PROGRESS marker on startup (simulated crash after backup, before commit)", () => {
    // Simulate a real mid-apply crash: backup exists, team file half-mutated, marker stuck IN_PROGRESS.
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(`${teamFile}.bank-bak`, "<team id=\"900001\"><spp>0</spp></team>", "utf8");
    writeFileSync(teamFile, "<team id=\"900001\"><spp>GARBAGE-PARTIAL", "utf8"); // corrupt half-write
    writeFileSync(join(dirs.resultsDir, "ledger", "g1_900001.json"), JSON.stringify({
      gameId: "g1", teamId: "900001", phase: "IN_PROGRESS", teamFile,
      bakFile: `${teamFile}.bank-bak`, teamSizeAtRead: 0, teamMtimeAtRead: 0, startedAt: 0,
    }), "utf8");

    const { recovered } = recoverInterrupted(dirs);
    expect(recovered).toEqual(["g1_900001"]);
    expect(readFileSync(teamFile, "utf8")).toBe("<team id=\"900001\"><spp>0</spp></team>"); // restored
    expect(existsSync(join(dirs.resultsDir, "ledger", "g1_900001.json"))).toBe(false); // marker cleared
  });

  it("recovery leaves an APPLIED marker untouched (does not roll back completed work)", () => {
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    const { recovered } = recoverInterrupted(dirs);
    expect(recovered).toEqual([]);
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>");
  });

  it("AV-2: an unresolvable teamId quarantines rather than writing", () => {
    const r = bankGameResult(dirs, "g1", [task("999999")], "<gameResult/>");
    expect(r.ok).toBe(false);
    expect(readdirSync(join(dirs.resultsDir, "quarantine")).some((f) => f.startsWith("g1_999999"))).toBe(true);
  });
});
