import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { NonceStore } from "../src/site-backend/nonceStore.js";
import { bankGameResult, bankingLedgerStem, recoverInterrupted, type BankingDirs, type TeamBankTask } from "../src/site-backend/banking.js";
import { acknowledgeForkCacheReload, adminResponse, markForkCacheReloadRequired, readLibrary, upsertLibraryTeam } from "@bb/fork-ops";

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
  const ledger = (gameId: string, teamId: string): string => join(dirs.resultsDir, "ledger", `${bankingLedgerStem(gameId, teamId)}.json`);
  const quarantineFile = (gameId: string, teamId: string, suffix: string): string =>
    join(dirs.resultsDir, "quarantine", `${bankingLedgerStem(gameId, teamId)}.${suffix}`);

  it("applies a clean result and marks APPLIED", () => {
    const r = bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    expect(r.ok).toBe(true);
    expect(r.applied).toEqual(["900001"]);
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>");
    const marker = JSON.parse(readFileSync(ledger("g1", "900001"), "utf8"));
    expect(marker.phase).toBe("APPLIED");
  });

  it("is IDEMPOTENT — re-banking the same (game,team) does NOT double-apply (BR-1)", () => {
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>"); // replay
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>"); // not 12
  });

  it("defers banking while an earlier team/cache transaction requires recovery", () => {
    markForkCacheReloadRequired(dirs.teamsDir, "unresolved prior transaction");
    const result = bankGameResult(dirs, "g-deferred", [task("900001")], "<gameResult/>");
    expect(result.ok).toBe(false);
    expect(result.quarantined?.[0]?.reason).toMatch(/deferred until team\/cache recovery/i);
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>0</spp>");
    expect(existsSync(ledger("g-deferred", "900001"))).toBe(false);
  });

  it("uses an unambiguous tuple ledger key and verifies marker identity", () => {
    expect(bankingLedgerStem("test:a", "b_c")).not.toBe(bankingLedgerStem("test:a_b", "c"));
    const firstTeam = join(dirs.teamsDir, "team_x_b_c.xml");
    writeFileSync(firstTeam, '<team id="b_c"><spp>0</spp></team>', "utf8");
    expect(bankGameResult(dirs, "test:a", [task("b_c")], "<gameResult/>").ok).toBe(true);
    acknowledgeForkCacheReload(dirs.teamsDir); // simulate the successful reload between distinct results
    rmSync(firstTeam);
    const secondTeam = join(dirs.teamsDir, "team_x_c.xml");
    writeFileSync(secondTeam, '<team id="c"><spp>0</spp></team>', "utf8");
    expect(bankGameResult(dirs, "test:a_b", [task("c")], "<gameResult/>").ok).toBe(true);
    expect(readFileSync(secondTeam, "utf8")).toContain("<spp>6</spp>");
    expect(readdirSync(join(dirs.resultsDir, "ledger")).filter((file) => file.endsWith(".json"))).toHaveLength(2);

    acknowledgeForkCacheReload(dirs.teamsDir);
    const marker = JSON.parse(readFileSync(ledger("test:a_b", "c"), "utf8"));
    writeFileSync(ledger("test:a_b", "c"), JSON.stringify({ ...marker, gameId: "different" }), "utf8");
    expect(bankGameResult(dirs, "test:a_b", [task("c")], "<gameResult/>").ok).toBe(false);
    expect(readFileSync(secondTeam, "utf8")).toContain("<spp>6</spp>");
  });

  it("preflights a throwing apply function before writing any team transaction", () => {
    const boom = () => { throw new Error("killed mid-apply"); };
    const r = bankGameResult(dirs, "g1", [task("900001", boom)], "<gameResult/>");
    expect(r.ok).toBe(false);
    // team file is unchanged because deterministic validation finishes before mutation.
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>0</spp>");
    // it landed in quarantine, never a partial bank
    expect(existsSync(join(dirs.resultsDir, "quarantine"))).toBe(true);
  });

  it("AV-3: refuses to overwrite an external team XML change between read and commit", () => {
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    let calls = 0;
    const changesOutsideSharedLock = (xml: string): string => {
      calls += 1;
      // The first call is the game-atomic dry run. Simulate an unsupported external editor during
      // the real apply so the commit guard must compare bytes, not rely on lock convention alone.
      if (calls === 2) writeFileSync(teamFile, '<team id="900001"><spp>9</spp></team>', "utf8");
      return bumpSpp(xml);
    };

    const result = bankGameResult(dirs, "g-external", [task("900001", changesOutsideSharedLock)], "<gameResult/>");

    expect(result.ok).toBe(false);
    expect(readFileSync(teamFile, "utf8")).toContain("<spp>9</spp>");
    expect(existsSync(ledger("g-external", "900001"))).toBe(false);
    expect(readFileSync(quarantineFile("g-external", "900001", "error.txt"), "utf8"))
      .toMatch(/changed after banking read and before commit/i);
  });

  it("never restores an interrupted backup over an unknown later team mutation", () => {
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(`${teamFile}.bank-bak`, "<team id=\"900001\"><spp>0</spp></team>", "utf8");
    writeFileSync(teamFile, "<team id=\"900001\"><spp>GARBAGE-PARTIAL", "utf8"); // corrupt half-write
    writeFileSync(ledger("g1", "900001"), JSON.stringify({
      gameId: "g1", teamId: "900001", phase: "IN_PROGRESS", teamFile,
      bakFile: `${teamFile}.bank-bak`, teamSizeAtRead: 0, teamMtimeAtRead: 0, startedAt: 0,
    }), "utf8");

    const { recovered } = recoverInterrupted(dirs);
    expect(recovered).toEqual([]);
    expect(readFileSync(teamFile, "utf8")).toBe("<team id=\"900001\"><spp>GARBAGE-PARTIAL");
    expect(existsSync(quarantineFile("g1", "900001", "error.txt"))).toBe(true);
    expect(existsSync(ledger("g1", "900001"))).toBe(true);
  });

  it("recovery leaves an APPLIED marker untouched (does not roll back completed work)", () => {
    bankGameResult(dirs, "g1", [task("900001")], "<gameResult/>");
    const { recovered } = recoverInterrupted(dirs);
    expect(recovered).toEqual([]);
    expect(readFileSync(join(dirs.teamsDir, "team_flutethecat_900001.xml"), "utf8")).toContain("<spp>6</spp>");
  });

  it("recognizes a commit that completed before the APPLIED marker flip", () => {
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    const before = readFileSync(teamFile, "utf8");
    const applied = before.replace("<spp>0</spp>", "<spp>6</spp>");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(teamFile, applied, "utf8");
    writeFileSync(`${teamFile}.bank-bak`, before, "utf8");
    writeFileSync(ledger("g1", "900001"), JSON.stringify({
      gameId: "g1", teamId: "900001", phase: "IN_PROGRESS", teamFile, bakFile: `${teamFile}.bank-bak`,
      teamSizeAtRead: before.length, teamMtimeAtRead: 0, beforeHash: digest(before), appliedHash: digest(applied), startedAt: 0,
    }), "utf8");
    expect(recoverInterrupted(dirs).recovered).toEqual(["g1_900001"]);
    expect(JSON.parse(readFileSync(ledger("g1", "900001"), "utf8")).phase).toBe("APPLIED");
    expect(readFileSync(teamFile, "utf8")).toBe(applied);
  });

  it("recovers an IN_PROGRESS retry instead of double-banking the applied XML", () => {
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    const before = readFileSync(teamFile, "utf8");
    const applied = bumpSpp(before);
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(teamFile, applied, "utf8");
    writeFileSync(`${teamFile}.bank-bak`, before, "utf8");
    writeFileSync(ledger("g-retry", "900001"), JSON.stringify({
      gameId: "g-retry", teamId: "900001", phase: "IN_PROGRESS", teamFile, bakFile: `${teamFile}.bank-bak`,
      teamSizeAtRead: before.length, teamMtimeAtRead: 0, beforeHash: digest(before), appliedHash: digest(applied),
      resultHash: digest("<gameResult/>"), startedAt: 0,
    }), "utf8");

    expect(bankGameResult(dirs, "g-retry", [task("900001")], "<gameResult/>").ok).toBe(true);
    expect(readFileSync(teamFile, "utf8")).toBe(applied);
    expect(JSON.parse(readFileSync(ledger("g-retry", "900001"), "utf8")).phase).toBe("APPLIED");
  });

  it("quarantines an unreadable existing marker rather than treating the retry as fresh", () => {
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(ledger("g-unreadable", "900001"), "{broken", "utf8");
    expect(bankGameResult(dirs, "g-unreadable", [task("900001")], "<gameResult/>").ok).toBe(false);
    expect(readFileSync(teamFile, "utf8")).toContain("<spp>0</spp>");
    expect(existsSync(quarantineFile("g-unreadable", "900001", "error.txt"))).toBe(true);
  });

  it("reconciles library metadata when recovery finds an applied XML write", () => {
    const libraryDir = join(root, "library");
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    const before = '<team id="900001"><coach>flutethecat</coach><currentTeamValue>1000000</currentTeamValue><spp>0</spp></team>';
    const applied = before.replace("1000000", "1020000").replace("<spp>0</spp>", "<spp>6</spp>");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    upsertLibraryTeam(libraryDir, "flutethecat", { teamId: "900001", teamName: "T", race: "Human", coach: "flutethecat", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00Z" });
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(teamFile, applied, "utf8");
    writeFileSync(`${teamFile}.bank-bak`, before, "utf8");
    writeFileSync(ledger("g-recover-tv", "900001"), JSON.stringify({
      gameId: "g-recover-tv", teamId: "900001", phase: "IN_PROGRESS", teamFile, bakFile: `${teamFile}.bank-bak`,
      teamSizeAtRead: before.length, teamMtimeAtRead: 0, beforeHash: digest(before), appliedHash: digest(applied), startedAt: 0,
    }), "utf8");

    expect(recoverInterrupted({ ...dirs, libraryDir }).recovered).toEqual(["g-recover-tv_900001"]);
    expect(readLibrary(libraryDir, "flutethecat")[0]?.teamValue).toBe(1020);
  });

  it("restores library metadata when recovery finds the before XML generation", () => {
    const libraryDir = join(root, "library");
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    const before = '<team id="900001"><coach>flutethecat</coach><currentTeamValue>1000000</currentTeamValue><spp>0</spp></team>';
    const applied = before.replace("1000000", "1020000").replace("<spp>0</spp>", "<spp>6</spp>");
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    upsertLibraryTeam(libraryDir, "flutethecat", { teamId: "900001", teamName: "T", race: "Human", coach: "flutethecat", teamValue: 1020, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00Z" });
    mkdirSync(join(dirs.resultsDir, "ledger"), { recursive: true });
    writeFileSync(teamFile, before, "utf8");
    writeFileSync(`${teamFile}.bank-bak`, before, "utf8");
    writeFileSync(ledger("g-rollback-tv", "900001"), JSON.stringify({
      gameId: "g-rollback-tv", teamId: "900001", phase: "IN_PROGRESS", teamFile, bakFile: `${teamFile}.bank-bak`,
      teamSizeAtRead: before.length, teamMtimeAtRead: 0, beforeHash: digest(before), appliedHash: digest(applied), startedAt: 0,
    }), "utf8");

    expect(recoverInterrupted({ ...dirs, libraryDir }).recovered).toEqual(["g-rollback-tv_900001"]);
    expect(readLibrary(libraryDir, "flutethecat")[0]?.teamValue).toBe(1000);
    expect(existsSync(ledger("g-rollback-tv", "900001"))).toBe(false);
  });

  it("AV-2: an unresolvable teamId quarantines rather than writing", () => {
    const r = bankGameResult(dirs, "g1", [task("999999")], "<gameResult/>");
    expect(r.ok).toBe(false);
    expect(readdirSync(join(dirs.resultsDir, "quarantine")).some((f) => f.startsWith("g1_999999"))).toBe(true);
  });

  it("bounds ledger and quarantine filenames for maximum-length logical ids", () => {
    const gameId = "g".repeat(128);
    const teamId = "t".repeat(128);
    expect(bankGameResult(dirs, gameId, [task(teamId)], "<gameResult/>").ok).toBe(false);
    const filenames = readdirSync(join(dirs.resultsDir, "quarantine"));
    expect(filenames.length).toBeGreaterThan(0);
    expect(filenames.every((filename) => filename.length <= 255)).toBe(true);
    expect(filenames.some((filename) => filename.startsWith(bankingLedgerStem(gameId, teamId)))).toBe(true);
  });

  it("synchronizes persistent library TV metadata under the same team transaction", () => {
    const libraryDir = join(root, "library");
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    writeFileSync(teamFile, '<team id="900001"><coach>flutethecat</coach><spp>0</spp></team>', "utf8");
    upsertLibraryTeam(libraryDir, "flutethecat", { teamId: "900001", teamName: "T", race: "Human", coach: "flutethecat", teamValue: 1000, gold: 0, forkLoadable: true, ingestedAt: "2026-01-01T00:00:00Z" });
    const syncedDirs = { ...dirs, libraryDir };
    const tvTask: TeamBankTask = { teamId: "900001", applyFn: (xml) => xml.replace("<spp>0</spp>", "<spp>6</spp>").replace("</team>", "<currentTeamValue>1020000</currentTeamValue></team>") };
    expect(bankGameResult(syncedDirs, "g-tv", [tvTask], "<gameResult/>").ok).toBe(true);
    expect(readLibrary(libraryDir, "flutethecat")[0]?.teamValue).toBe(1020);
  });

  it("fails closed and restores XML when existing library metadata is malformed", () => {
    const libraryDir = join(root, "library");
    const teamFile = join(dirs.teamsDir, "team_flutethecat_900001.xml");
    mkdirSync(libraryDir, { recursive: true });
    writeFileSync(teamFile, '<team id="900001"><coach>flutethecat</coach><spp>0</spp></team>', "utf8");
    writeFileSync(join(libraryDir, "flutethecat.json"), "{broken", "utf8");
    const result = bankGameResult({ ...dirs, libraryDir }, "g-bad-library", [task("900001")], "<gameResult/>");
    expect(result.ok).toBe(false);
    expect(readFileSync(teamFile, "utf8")).toContain("<spp>0</spp>");
    expect(existsSync(ledger("g-bad-library", "900001"))).toBe(true);
  });
});
