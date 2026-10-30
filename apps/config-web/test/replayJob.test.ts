import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReplayJob, unsafeReason, type ReplayGuard } from "../src/replay/job";
import type { ReplayReadResult } from "../src/replay/reader";
import { createReplayService } from "../src/replay/service";
import { REPLAY_READER_VERSION, ReplayMomentStore } from "../src/replay/store";
import { TournamentResultStore } from "../src/tournamentResults";

// The replay moments cache (src/replay/store.ts) and the background job that fills it (src/replay/job.ts): each game
// read from the fork once, unavailable answers cached, failures retried a bounded number of times, unsafe games never
// loaded, and the results-store trigger (src/replay/service.ts).

const dirs: string[] = [];
const tmp = (): string => { const d = mkdtempSync(join(tmpdir(), "replay-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const teams = { home: { teamId: "H", name: "Reavers", coach: "Alice" }, away: { teamId: "A", name: "Grinders", coach: "Bob" } };
const ready = (moments = 1): ReplayReadResult => ({
  status: "ready",
  derivation: { teams, commands: 10, truncated: false, moments: Array.from({ length: moments }, (_, i) => ({ seq: i, commandNr: i + 1, half: 1, turn: 1, side: "home" as const, kind: "touchdown" as const, text: "Touchdown: Grak" })) },
});
const safe: ReplayGuard = { testMode: false, started: "2026-10-01T10:00:00.000", homeTeamId: "H", awayTeamId: "A" };

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

describe("replay job", () => {
  const job = (over: Partial<Parameters<typeof createReplayJob>[0]> & { store: ReplayMomentStore }) => {
    const reads: string[] = [];
    const j = createReplayJob({
      rows: () => [],
      guards: async () => new Map([["999", safe], ["1072", safe], ["5", safe], ["6", safe]]),
      read: async (id) => { reads.push(id); return ready(); },
      gapMs: 0,
      ...over,
    });
    return { j, reads };
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

  it("the fork's unavailable answer is cached for good; a failed read is retried at most maxFailures times, then reads 'unavailable'", async () => {
    const store = new ReplayMomentStore(tmp());
    let calls = 0;
    const { j } = job({
      store, maxFailures: 2,
      read: async (id) => { calls += 1; if (id === "1072") return { status: "unavailable", reason: "Replay Unavailable" }; throw new Error("fork down"); },
    });
    j.enqueue("1072");
    await j.idle();
    expect(store.get("1072")).toMatchObject({ status: "unavailable", reason: "Replay Unavailable" });
    j.enqueue("5"); await j.idle();
    expect(j.status("5")).toBe("pending");
    j.enqueue("5"); await j.idle();
    j.enqueue("5"); await j.idle();
    expect(calls).toBe(3); // 1072 once, 5 twice
    expect(store.get("5")).toBeUndefined();
    expect(j.status("5")).toBe("unavailable");
  });

  it("guard: a test-mode, unstarted or one-team fork game is cached unavailable without being loaded; a game missing from the list is not cached", async () => {
    expect(unsafeReason(safe)).toBeUndefined();
    expect(unsafeReason({ ...safe, testMode: true })).toMatch(/test-mode/);
    expect(unsafeReason({ ...safe, started: undefined })).toMatch(/unstarted/);
    expect(unsafeReason({ ...safe, started: "1970-01-01T00:00:00.000" })).toMatch(/unstarted/);
    expect(unsafeReason({ ...safe, awayTeamId: "" })).toMatch(/one-team/);
    const store = new ReplayMomentStore(tmp());
    const { j, reads } = job({ store, guards: async () => new Map([["5", { ...safe, testMode: true }], ["6", safe]]) });
    j.enqueue("5"); j.enqueue("7"); j.enqueue("6");
    await j.idle();
    expect(reads).toEqual(["6"]);
    expect(store.get("5")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/test-mode/) });
    expect(store.get("7")).toBeUndefined();
    expect(j.status("7")).toBe("pending");
  });

  it("an empty or failing finished list caches nothing", async () => {
    const store = new ReplayMomentStore(tmp());
    const { j, reads } = job({ store, guards: async () => new Map() });
    j.enqueue("999"); await j.idle();
    const { j: j2 } = job({ store, guards: async () => { throw new Error("admin down"); } });
    j2.enqueue("999"); await j2.idle();
    expect(reads).toEqual([]);
    expect(store.get("999")).toBeUndefined();
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

  it("with a fork: a fork result stored by any results store in the process queues the game; FORK_REPLAY_ENABLED=false turns it off", async () => {
    const dir = tmp();
    const results = new TournamentResultStore(dir);
    // a fork admin API nobody listens on: the job's guard read fails at once and nothing is cached
    const adminCfg = { baseUrl: "http://127.0.0.1:1", passwordMd5Hex: "0".repeat(32) } as never;
    const lines: string[] = [];
    const svc = createReplayService({ dataDir: dir, adminCfg, results, start: false, log: (l) => lines.push(l) });
    expect(svc.job).toBeDefined();
    expect(svc.forGame("42")).toEqual({ state: "pending" });
    const row = { gameId: "42", pulledAt: "t", home: { teamId: "H", teamName: "R", coach: "a" }, away: { teamId: "A", teamName: "G", coach: "b" }, teams: [] };
    results.put(row as never);
    await svc.job!.idle();
    expect(lines.join(" | ")).toMatch(/\[replay\] game 42: finished list unavailable/);
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
