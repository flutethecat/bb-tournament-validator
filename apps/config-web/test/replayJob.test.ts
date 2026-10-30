import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReplayJob, parseGameGuard, SITE_TEST_REASON, UNKNOWN_GAME_REASON, unsafeReason, type ReplayGuard } from "../src/replay/job";
import type { ReplayReadResult } from "../src/replay/reader";
import { createReplayService } from "../src/replay/service";
import { REPLAY_READER_VERSION, ReplayMomentStore } from "../src/replay/store";
import { TestGameStore } from "../src/testGames";
import { TournamentResultStore } from "../src/tournamentResults";

// The replay moments cache (src/replay/store.ts) and the background job that fills it (src/replay/job.ts): each game
// read from the fork once, unavailable answers cached, failures retried later with backoff, test or unknown games never
// loaded, fork visits paced, and the results-store trigger (src/replay/service.ts).

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "replay-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const teams = { home: { teamId: "H", name: "Reavers", coach: "Alice" }, away: { teamId: "A", name: "Grinders", coach: "Bob" } };
const ready = (moments = 1): ReplayReadResult => ({
  status: "ready",
  derivation: { teams, commands: 10, truncated: false, moments: Array.from({ length: moments }, (_, i) => ({ seq: i, commandNr: i + 1, half: 1, turn: 1, side: "home" as const, kind: "touchdown" as const, text: "Touchdown: Grak" })) },
});
const safe: ReplayGuard = { testMode: false, status: "backuped", started: "2026-10-01T10:00:00.000", homeTeamId: "H", awayTeamId: "A" };

describe("replay moments store", () => {
  it("writes one versioned file per game; another reader version, a foreign game id or junk reads as absent", () => {
    const dir = tmp();
    const store = new ReplayMomentStore(dir);
    expect(store.get("999")).toBeUndefined();
    const before = store.revision();
    store.put({ gameId: "999", status: "ready", readAt: "t", commands: 10, truncated: false, teams, moments: [] });
    expect(store.revision()).not.toBe(before);
    expect(store.get("999")).toMatchObject({ schema: 1, reader: REPLAY_READER_VERSION, status: "ready", teams });
    store.put({ gameId: "1072", status: "unavailable", readAt: "t", reason: "Replay Unavailable" });
    expect(store.get("1072")).toMatchObject({ status: "unavailable", reason: "Replay Unavailable" });
    const file = join(dir, "replay-moments", "999.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), reader: REPLAY_READER_VERSION + 1 }));
    expect(store.get("999")).toBeUndefined();
    writeFileSync(file, "{nope");
    expect(store.get("999")).toBeUndefined();
    expect(store.get("../999")).toBeUndefined();
    expect(() => store.put({ gameId: "../x", status: "unavailable", readAt: "t", reason: "r" })).toThrow();
  });
});

describe("replay guard", () => {
  it("parses the fork's per-game admin entry (testMode from DbAdminListByIdQuery); a missing attribute is unknown", () => {
    const xml = (attrs: string) => `<admin><list gameId="999" size="1"><game id="999" started="2026-09-29T11:16:42.000" finished="x" half="1" turn="4" status="backuped" ${attrs}><team id="H" home="true" name="R" coach="a"/><team id="A" home="false" name="G" coach="b"/></game></list></admin>`;
    expect(parseGameGuard(xml('testMode="false"'), "999")).toEqual({ testMode: false, status: "backuped", started: "2026-09-29T11:16:42.000", homeTeamId: "H", awayTeamId: "A" });
    expect(parseGameGuard(xml('testMode="true"'), "999")!.testMode).toBe(true);
    expect(parseGameGuard(xml(""), "999")!.testMode).toBeUndefined();
    expect(parseGameGuard('<admin><list gameId="5" size="0"/></admin>', "5")).toBeUndefined();
  });

  it("only a known non-test, started, two-team game is safe", () => {
    expect(unsafeReason(safe)).toBeUndefined();
    expect(unsafeReason({ ...safe, testMode: true })).toMatch(/test game/);
    expect(unsafeReason({ ...safe, testMode: undefined })).toMatch(/test status unknown/);
    expect(unsafeReason({ ...safe, started: undefined })).toMatch(/unstarted/);
    expect(unsafeReason({ ...safe, started: "1970-01-01T00:00:00.000" })).toMatch(/unstarted/);
    expect(unsafeReason({ ...safe, awayTeamId: "" })).toMatch(/one-team/);
  });
});

describe("replay job", () => {
  const job = (over: Partial<Parameters<typeof createReplayJob>[0]> & { store: ReplayMomentStore }) => {
    const reads: string[] = [];
    const guards: string[] = [];
    const j = createReplayJob({
      rows: () => [],
      guard: async (id) => { guards.push(id); return safe; },
      isSiteTest: () => false,
      read: async (id) => { reads.push(id); return ready(); },
      gapMs: 0,
      ...over,
    });
    return { j, reads, guards };
  };

  it("reads a queued game once and caches it; a second enqueue never reads again", async () => {
    const store = new ReplayMomentStore(tmp());
    const { j, reads } = job({ store });
    expect(j.status("999")).toBe("pending");
    j.enqueue("999");
    j.enqueue("999");
    await j.idle();
    expect(reads).toEqual(["999"]);
    expect(j.status("999")).toBe("ready");
    expect(store.get("999")).toMatchObject({ status: "ready", commands: 10, moments: [{ text: "Touchdown: Grak" }] });
    j.enqueue("999");
    await j.idle();
    expect(reads).toEqual(["999"]);
  });

  it("a site test game (test-games.json) is cached unavailable without asking or loading the fork", async () => {
    const dir = tmp();
    const tests = new TestGameStore(dir);
    tests.add(["1099"], "league-fork-test");
    const store = new ReplayMomentStore(dir);
    const { j, reads, guards } = job({ store, isSiteTest: (id) => tests.has(id) });
    j.enqueue("1099"); j.enqueue("999");
    await j.idle();
    expect(store.get("1099")).toMatchObject({ status: "unavailable", reason: SITE_TEST_REASON });
    expect(guards).toEqual(["999"]);
    expect(reads).toEqual(["999"]);
  });

  it("the fork's guard: a test game, an unknown test status or a game the fork does not list is cached unavailable, never loaded", async () => {
    const store = new ReplayMomentStore(tmp());
    const g: Record<string, ReplayGuard | undefined> = { 5: { ...safe, testMode: true }, 6: { ...safe, testMode: undefined }, 7: undefined, 8: safe };
    const { j, reads } = job({ store, guard: async (id) => g[id] });
    for (const id of ["5", "6", "7", "8"]) j.enqueue(id);
    await j.idle();
    expect(reads).toEqual(["8"]);
    expect(store.get("5")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/fork test game/) });
    expect(store.get("6")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/test status unknown/) });
    expect(store.get("7")).toMatchObject({ status: "unavailable", reason: UNKNOWN_GAME_REASON });
  });

  it("the fork's unavailable answer is cached for good; failures (fork down, guard down, not finished) back off and stop at maxFailures", async () => {
    const store = new ReplayMomentStore(tmp());
    let t = 0;
    let calls = 0;
    const lines: string[] = [];
    const { j } = job({
      store, maxFailures: 2, retryBaseMs: 1000, now: () => t, log: (l) => lines.push(l),
      guard: async (id) => { if (id === "6") throw new Error("admin down"); return id === "7" ? { ...safe, status: "active" } : safe; },
      read: async (id) => { calls += 1; if (id === "1072") return { status: "unavailable", reason: "Replay Unavailable" }; throw new Error("fork down"); },
    });
    j.enqueue("1072"); await j.idle();
    expect(store.get("1072")).toMatchObject({ status: "unavailable", reason: "Replay Unavailable" });
    j.enqueue("5"); j.enqueue("6"); j.enqueue("7"); await j.idle();
    expect(calls).toBe(2);
    expect(j.status("5")).toBe("pending");
    j.enqueue("5"); await j.idle(); // still backing off: nothing
    expect(calls).toBe(2);
    t = 1500;
    j.enqueue("5"); await j.idle();
    expect(calls).toBe(3);
    expect(j.status("5")).toBe("unavailable"); // gave up for this process
    expect(store.get("5")).toBeUndefined();
    expect(store.get("6")).toBeUndefined();
    expect(store.get("7")).toBeUndefined();
    // logged once per game and kind
    expect(lines.filter((l) => l.startsWith("[replay] game 5:"))).toHaveLength(1);
  });

  it("a cache write that fails never rejects the job: the game is retried later and the queue carries on", async () => {
    const store = new ReplayMomentStore(tmp());
    const realPut = store.put.bind(store);
    store.put = ((e: Parameters<typeof realPut>[0]) => { if (e.gameId === "5") throw Object.assign(new Error("ENOSPC: no space left"), { code: "ENOSPC" }); return realPut(e); }) as typeof store.put;
    const lines: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on("unhandledRejection", onRejection);
    try {
      const { j, reads } = job({ store, log: (l) => lines.push(l) });
      j.enqueue("5"); j.enqueue("6");
      await j.idle();
      await new Promise((r) => setTimeout(r, 10));
      expect(reads).toEqual(["5", "6"]);
      expect(store.get("6")).toMatchObject({ status: "ready" });
      expect(j.status("5")).toBe("pending");
      expect(lines.join(" | ")).toMatch(/game 5: could not be cached: ENOSPC/);
    } finally { process.off("unhandledRejection", onRejection); }
    expect(rejections).toEqual([]);
  });

  it("pacing: at least gapMs between two fork visits, even when the queue emptied in between", async () => {
    const store = new ReplayMomentStore(tmp());
    let t = 0;
    const slept: number[] = [];
    const { j, guards } = job({ store, gapMs: 20_000, now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
    j.enqueue("5"); await j.idle();
    t += 25; // a second result 25 ms later, the queue already empty
    j.enqueue("6"); await j.idle();
    expect(guards).toEqual(["5", "6"]);
    expect(slept).toEqual([19_975]);
    t += 60_000;
    j.enqueue("7"); await j.idle();
    expect(slept).toEqual([19_975]);
  });

  it("sweep: fork rows without a cached answer, newest first; tabletop rows, non-numeric ids and cached games skipped", async () => {
    const store = new ReplayMomentStore(tmp());
    store.put({ gameId: "6", status: "unavailable", readAt: "t", reason: "r" });
    const rows = [
      { gameId: "5", playedAt: "2026-10-01T00:00:00Z" },
      { gameId: "999", playedAt: "2026-10-20T00:00:00Z", source: "fork" },
      { gameId: "6", playedAt: "2026-10-25T00:00:00Z" },
      { gameId: "tabletop:m1", playedAt: "2026-10-26T00:00:00Z", source: "tabletop" },
      { gameId: "1072", pulledAt: "2026-10-10T00:00:00Z" },
    ];
    const { j, reads } = job({ store, rows: () => rows });
    expect(j.sweep()).toBe(3);
    await j.idle();
    expect(reads).toEqual(["999", "1072", "5"]);
    expect(j.sweep()).toBe(0);
  });

  it("stopped: nothing is queued and the page reads 'unavailable' for an uncached game", async () => {
    const store = new ReplayMomentStore(tmp());
    const { j, reads } = job({ store, rows: () => [{ gameId: "5" }] });
    j.stop();
    j.enqueue("999");
    expect(j.sweep()).toBe(0);
    await j.idle();
    expect(reads).toEqual([]);
    expect(j.status("999")).toBe("unavailable");
  });
});

describe("replay service", () => {
  it("no fork admin config: no job, an uncached game reads 'unavailable', a cached one its entry", () => {
    const dir = tmp();
    const svc = createReplayService({ dataDir: dir, adminCfg: undefined, results: new TournamentResultStore(dir), start: false });
    expect(svc.job).toBeUndefined();
    expect(svc.forGame("999")).toEqual({ state: "unavailable" });
    svc.store.put({ gameId: "999", status: "ready", readAt: "t", commands: 1, truncated: false, teams, moments: [] });
    expect(svc.forGame("999")).toMatchObject({ state: "ready", entry: { gameId: "999" } });
  });

  it("with a fork: a stored fork result queues the game; a test-games.json game is refused before the fork is asked; FORK_REPLAY_ENABLED=false turns it off", async () => {
    const dir = tmp();
    new TestGameStore(dir).add(["1099"], "league-fork-test");
    const results = new TournamentResultStore(dir);
    // a fork admin API nobody listens on: the guard read fails at once and nothing is cached
    const adminCfg = { baseUrl: "http://127.0.0.1:1", passwordMd5Hex: "0".repeat(32) } as never;
    const lines: string[] = [];
    const svc = createReplayService({ dataDir: dir, adminCfg, results, start: false, log: (l) => lines.push(l) });
    expect(svc.job).toBeDefined();
    expect(svc.forGame("42")).toEqual({ state: "pending" });
    const side = (teamId: string) => ({ teamId, teamName: "R", coach: "a" });
    results.put({ gameId: "1099", pulledAt: "t", home: side("H"), away: side("A"), teams: [] } as never);
    results.put({ gameId: "42", pulledAt: "t", home: side("H"), away: side("A"), teams: [] } as never);
    await svc.job!.idle();
    await new Promise((r) => setTimeout(r, 50));
    await svc.job!.idle();
    expect(svc.forGame("1099")).toMatchObject({ state: "unavailable", entry: { reason: SITE_TEST_REASON } });
    expect(lines.join(" | ")).toMatch(/\[replay\] game 42: the fork's game entry could not be read/);
    expect(svc.forGame("42")).toEqual({ state: "pending" });
    svc.stop();
    const svc2 = createReplayService({ dataDir: dir, adminCfg, results, start: false, env: { FORK_REPLAY_ENABLED: "false" } });
    expect(svc2.job).toBeUndefined();
    svc2.stop();
  });

  it("the trigger: onResultStored hands fork rows (never tabletop rows) to the job", async () => {
    const dir = tmp();
    const results = new TournamentResultStore(dir);
    const { onResultStored } = await import("../src/tournamentResults");
    const seen: string[] = [];
    const off = onResultStored((r) => seen.push(r.gameId));
    const side = { teamId: "H", teamName: "R", coach: "a" };
    results.put({ gameId: "77", pulledAt: "t", home: side, away: side, teams: [] } as never);
    results.put({ gameId: "tabletop:x", pulledAt: "t", home: side, away: side, teams: [], source: "tabletop" } as never);
    off();
    results.put({ gameId: "78", pulledAt: "t", home: side, away: side, teams: [] } as never);
    expect(seen).toEqual(["77"]);
  });
});
