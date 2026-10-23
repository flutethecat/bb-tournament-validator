import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createSession, getSession, onSessionEnded, sessionTokenFromRequest, SESSION_COOKIE_NAME } from "../src/auth/session.js";
import { SuperService } from "../src/super/service.js";
import { lobbyOriginAllowed } from "../src/lobby.js";
import { tabletopApi, clockView, type FixtureGateway, type FixtureView, type TabletopApiDeps, type TabletopResult } from "../src/tabletop/api.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";
import { FileTabletopRepository } from "../src/tabletop/store.js";
import { TournamentResultStore } from "../src/tournamentResults.js";
import { tournamentApi } from "../src/tournaments/api.js";
import { TournamentStore } from "../src/tournaments/store.js";

const NOW = new Date("2026-03-01T10:00:00.000Z");
let dir = "";
let repo: FileTabletopRepository;
let results: TournamentResultStore;
let clockPublishes: Array<{ id: string; payload: any }> = [];
let policy: FixtureView["turnTimer"];
let now = NOW;
const files: Record<string, TabletopTeamFile> = {};

const players = (prefix: string): TabletopTeamFile["players"] =>
  Array.from({ length: 11 }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false }));
const team = (prefix: string): TabletopTeamFile => ({ schema: 1, name: `${prefix} XI`, race: "Human", treasury: 0, dedicatedFans: 1, teamValue: 1_000_000, players: players(prefix) });

const fixtures = (): FixtureGateway => ({
  get: (id): FixtureView | undefined => id === "cup:round:1:match:1"
    ? { id, open: true, status: "scheduled", revision: 1, home: { coach: "Alice" }, away: { coach: "Bob" }, ...(policy ? { turnTimer: policy } : {}) }
    : undefined,
  record: () => undefined,
  retract: () => undefined,
});
const deps = (): TabletopApiDeps => ({
  repo, results, fixtures: fixtures(),
  loadTeamFile: (coach, ref) => files[`${coach}/${ref}`],
  isBanned: () => false,
  isOrganizer: (c) => c === "Org",
  now: () => now,
  rollDie: () => 1,
  publishClock: (id, payload) => { clockPublishes.push({ id, payload }); },
});
const as = async (coach: string, method: string, path: string, body?: unknown): Promise<TabletopResult> =>
  (await tabletopApi(method, path, { coach, method: "discord" }, body, deps(), new URLSearchParams()))!;
const advance = (id: string, who: string, body?: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/pregame/advance`, body);
const clockOf = async (id: string) => ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { clock: any }).clock;
let eid = 0;
const ev = (type: string, team_: string, player?: string) => { eid += 1; return { id: `clk-${String(eid).padStart(8, "0")}`, type, team: team_, player, payload: {} }; };

/** Walk the whole pre-game. `choice` is the choice of the coin winner (home). */
async function toPlaying(opts: { choice?: "kick" | "receive"; agree?: [boolean, boolean]; fixtureRef?: string; allowOvertime?: boolean } = {}): Promise<string> {
  const created = await as("Alice", "POST", "/api/tabletop/matches", {
    home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" }, postMatch: "none",
    ...(opts.fixtureRef ? { fixtureRef: opts.fixtureRef } : {}), ...(opts.allowOvertime ? { allowOvertime: true } : {}),
  });
  expect(created.status).toBe(201);
  const id = (created.body as { match: { id: string } }).match.id;
  for (let i = 0; i < 3; i += 1) await advance(id, "Alice"); // fans, weather, journeymen (no one needs any)
  await advance(id, "Alice", { team: "home", skip: true });
  await advance(id, "Bob", { team: "away", skip: true });
  await advance(id, "Alice", { mode: "hand", call: "heads", caller: "home", result: "heads", winner: "home", choice: opts.choice ?? "receive" });
  if ((await clockOf(id)).turnTimer.enforced === "optional") {
    await advance(id, "Alice", { agree: (opts.agree ?? [true, true])[0] });
    await advance(id, "Bob", { agree: (opts.agree ?? [true, true])[1] });
  }
  return id;
}
/** Finish a match so the same two teams can play the next one in the test. */
const free = async (id: string) => repo.updateMatch({ ...(await repo.getMatch(id))!, state: "confirmed" });
const turn = (id: string, who: string, action: "start" | "end", body?: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/turn/${action}`, body);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tabletop-clock-"));
  repo = new FileTabletopRepository(join(dir, "tt"));
  results = new TournamentResultStore(join(dir, "results"));
  clockPublishes = [];
  policy = undefined;
  now = NOW;
  files["Alice/sv_a"] = team("a");
  files["Bob/sv_b"] = team("b");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("match clock", () => {
  it("the RECEIVING team is active at 1Ht0/1Ht1; home starts when no coin phase ran", async () => {
    const skip = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    const sid = (skip.body as { match: { id: string } }).match.id;
    expect(await clockOf(sid)).toMatchObject({ half: 1, turn: 0, activeTeam: "home", turnStartedAt: null, turnTimer: { mode: "off", enforced: "off" } });

    await free(sid);
    const kick = await toPlaying({ choice: "kick" }); // the coin winner (home) kicks, so away receives
    expect(await clockOf(kick)).toMatchObject({ half: 1, turn: 0, activeTeam: "away" });
    expect((await turn(kick, "Alice", "start")).status).toBe(403); // not Alice's turn
    expect((await turn(kick, "Bob", "start")).body).toMatchObject({ clock: { half: 1, turn: 1, activeTeam: "away", turnStartedAt: NOW.toISOString() } });
  });

  it("End Turn alternates teams, counts 8 turns each, swaps kick/receive at half-time, and ends after 2Ht8", async () => {
    const id = await toPlaying({ choice: "receive" }); // home receives in half 1; away receives in half 2
    expect((await turn(id, "Alice", "end")).status).toBe(409); // setup first
    expect((await turn(id, "Alice", "start")).status).toBe(200);
    const press = async (who: string) => (await turn(id, who, "end")).body as { clock: any };
    let c = (await press("Alice")).clock;
    expect(c).toMatchObject({ half: 1, turn: 1, activeTeam: "away" });
    expect((await turn(id, "Alice", "end")).status).toBe(403); // the other team's turn now
    c = (await press("Bob")).clock;
    expect(c).toMatchObject({ half: 1, turn: 2, activeTeam: "home" });
    now = new Date(NOW.getTime() + 5000);
    c = (await press("Alice")).clock;
    expect(c.turnStartedAt).toBe(now.toISOString());
    for (let i = 0; i < 12; i += 1) c = (await press(c.activeTeam === "home" ? "Alice" : "Bob")).clock; // through away's turn 8
    expect(c).toMatchObject({ half: 1, turn: 8, activeTeam: "away" });
    c = (await press("Bob")).clock; // away finishes turn 8: half-time
    expect(c).toMatchObject({ half: 2, turn: 0, activeTeam: "away", turnStartedAt: null }); // the half-1 kicker now receives
    expect((await turn(id, "Bob", "start")).body).toMatchObject({ clock: { half: 2, turn: 1, activeTeam: "away" } });
    c = (await clockOf(id));
    for (let i = 0; i < 15; i += 1) c = (await press(c.activeTeam === "home" ? "Alice" : "Bob")).clock;
    expect(c).toMatchObject({ half: 2, turn: 8, activeTeam: "home" });
    c = (await press("Alice")).clock;
    expect(c).toMatchObject({ half: 2, turn: 8, activeTeam: null });
    const over = await turn(id, "Org", "end");
    expect(over.status).toBe(409); // out of turns: post endOfMatch
    // the feed has a turnEnd per press, written by the server
    const events = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ type: string; payload: any }> }).events;
    expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(32);
    expect(events.filter((e) => e.type === "turnEnd")[0]!.payload).toEqual({ half: 1, turn: 1, team: "home" });
  });

  it("overtime only when the match allows it", async () => {
    const id = await toPlaying({ allowOvertime: true });
    await turn(id, "Alice", "start");
    let c: any = await clockOf(id);
    for (let i = 0; i < 16; i += 1) c = ((await turn(id, c.activeTeam === "home" ? "Alice" : "Bob", "end")).body as { clock: any }).clock;
    await turn(id, "Org", "start");
    for (let i = 0; i < 16; i += 1) c = ((await turn(id, "Org", "end")).body as { clock: any }).clock;
    expect(c).toMatchObject({ half: "OT", turn: 0, allowOvertime: true });
  });

  it("a stale End Turn (the clock already moved on) changes nothing and answers 409 with the clock", async () => {
    const id = await toPlaying();
    await turn(id, "Alice", "start");
    const first = await turn(id, "Alice", "end", { expectedHalf: 1, expectedTurn: 1 });
    expect(first.status).toBe(200);
    const again = await turn(id, "Org", "end", { expectedHalf: 1, expectedTurn: 1, expectedTeam: "home" }); // a second phone, same press
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ clock: { half: 1, turn: 1, activeTeam: "away" } });
    const events = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ type: string }> }).events;
    expect(events.filter((e) => e.type === "turnEnd")).toHaveLength(1);
  });

  it("events posted without a half/turn are stamped from the clock; explicit ones are kept", async () => {
    const id = await toPlaying();
    await turn(id, "Alice", "start");
    await turn(id, "Alice", "end"); // 1Ht1 away
    await turn(id, "Bob", "end"); // 1Ht2 home
    const stamped = ev("touchdown", "home", "a1");
    const explicit = { ...ev("touchdown", "home", "a2"), half: 2, turn: 5 };
    const r = await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [stamped, explicit] });
    expect(r.status).toBe(200);
    expect((r.body as { clock: any }).clock).toMatchObject({ half: 1, turn: 2, activeTeam: "home" });
    const events = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ id: string; half?: number; turn?: number }> }).events;
    expect(events.find((e) => e.id === stamped.id)).toMatchObject({ half: 1, turn: 2 });
    expect(events.find((e) => e.id === explicit.id)).toMatchObject({ half: 2, turn: 5 });
  });

  it("every change is published (phase change, start, end) with the same shape as the GET clock", async () => {
    const id = await toPlaying();
    expect(clockPublishes.at(-1)).toMatchObject({ id, payload: { phase: "playing", half: 1, turn: 0 } });
    clockPublishes = [];
    await turn(id, "Alice", "start");
    await turn(id, "Alice", "end");
    expect(clockPublishes.map((p) => [p.payload.turn, p.payload.activeTeam])).toEqual([[1, "home"], [1, "away"]]);
    const got = await clockOf(id);
    expect(Object.keys(clockPublishes.at(-1)!.payload).sort()).toEqual([...Object.keys(got), "phase"].sort());
    expect(got.serverNow).toBeDefined();
  });
});

describe("turn-timer agreement", () => {
  it("optional (the default): both coaches must agree; one no means off; an organiser answers for both", async () => {
    const both = await toPlaying({ agree: [true, true] });
    expect(await clockOf(both)).toMatchObject({ turnTimer: { mode: "on", seconds: 240, enforced: "optional", agreed: { home: true, away: true } } });
    await free(both);
    const split = await toPlaying({ agree: [true, false] });
    expect(await clockOf(split)).toMatchObject({ turnTimer: { mode: "off", agreed: { home: true, away: false } } });
  });

  it("the timers step asks both and waits; a stranger or a missing answer is refused; an organiser answers for both", async () => {
    const created = await as("Alice", "POST", "/api/tabletop/matches", { home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    const id = (created.body as { match: { id: string } }).match.id;
    for (let i = 0; i < 3; i += 1) await advance(id, "Alice");
    await advance(id, "Alice", { team: "home", skip: true });
    await advance(id, "Alice", { team: "away", skip: true });
    await advance(id, "Alice", { mode: "hand", call: "tails", caller: "away", result: "tails", winner: "away", choice: "kick" });
    expect((await clockOf(id)).activeTeam).toBeNull(); // not playing yet
    expect((await advance(id, "Alice", {})).status).toBe(400);
    expect((await advance(id, "Mallory", { agree: true })).status).toBe(403);
    expect((await advance(id, "Alice", { agree: true })).body).toMatchObject({ phase: "pregame:timers", waitingFor: ["away"] });
    expect((await advance(id, "Org", { agree: true })).body).toMatchObject({ phase: "playing", clock: { turnTimer: { mode: "on" }, activeTeam: "home" } });
  });

  it("a fixture's tournament can ENFORCE (skips the question, engages) or FORBID (skips it, off), with its own seconds", async () => {
    policy = { enforced: "required", seconds: 120 };
    const required = await toPlaying({ fixtureRef: "cup:round:1:match:1" });
    expect(await clockOf(required)).toMatchObject({ turnTimer: { mode: "on", seconds: 120, enforced: "required", agreed: { home: true, away: true } } });
    expect((await as("Alice", "GET", `/api/tabletop/matches/${required}`)).body).toMatchObject({ phase: "playing" });
    await free(required);
    policy = { enforced: "off", seconds: 240 };
    const off = await toPlaying({ fixtureRef: "cup:round:1:match:1" });
    expect(await clockOf(off)).toMatchObject({ turnTimer: { mode: "off", enforced: "off" } });
    expect((await as("Alice", "GET", `/api/tabletop/matches/${off}`)).body).toMatchObject({ phase: "playing" });
  });
});

describe("manual clock change (turn/set)", () => {
  const set = (id: string, who: string, body: unknown) => as(who, "POST", `/api/tabletop/matches/${id}/turn/set`, body);

  it("either participant sets the clock while recording: turnStartedAt resets, a turnSet event records it, the clock is published", async () => {
    const id = await toPlaying();
    await turn(id, "Alice", "start");
    now = new Date(NOW.getTime() + 9000);
    clockPublishes = [];
    const r = await set(id, "Bob", { half: 2, turn: 4, activeTeam: "away" }); // the coach who is NOT active may also set it
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ clock: { half: 2, turn: 4, activeTeam: "away", turnStartedAt: now.toISOString() } });
    expect(clockPublishes.at(-1)).toMatchObject({ id, payload: { half: 2, turn: 4, activeTeam: "away", phase: "playing" } });
    const events = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ type: string; by: string; payload: any }> }).events;
    const set1 = events.filter((e) => e.type === "turnSet");
    expect(set1).toHaveLength(1);
    expect(set1[0]).toMatchObject({ by: "Bob", payload: { from: { half: 1, turn: 1, activeTeam: "home" }, to: { half: 2, turn: 4, activeTeam: "away" }, by: "Bob" } });
    expect(await clockOf(id)).toMatchObject({ half: 2, turn: 4, activeTeam: "away" });
    // turn counting carries on from the new position
    expect((await turn(id, "Bob", "end")).body).toMatchObject({ clock: { half: 2, turn: 4, activeTeam: "home" } });
  });

  it("rejects invalid values with 400 (OT only when the match allows it)", async () => {
    const id = await toPlaying();
    const bad = [
      { half: 3, turn: 1, activeTeam: "home" }, { half: "OT", turn: 1, activeTeam: "home" }, { half: 1, turn: 9, activeTeam: "home" },
      { half: 1, turn: -1, activeTeam: "home" }, { half: 1, turn: 1.5, activeTeam: "home" }, { half: 1, turn: 1, activeTeam: "mid" }, { half: 1, turn: 1 }, {},
    ];
    for (const body of bad) expect((await set(id, "Alice", body)).status).toBe(400);
    expect((await set(id, "Alice", { half: 1, turn: 0, activeTeam: "away" })).status).toBe(200);
    await free(id);
    const ot = await toPlaying({ allowOvertime: true });
    expect((await set(ot, "Alice", { half: "OT", turn: 2, activeTeam: "home" })).body).toMatchObject({ clock: { half: "OT", turn: 2 } });
  });

  it("strangers are refused; after submit participants get 403 and an organiser still can; not before the pre-game ends", async () => {
    const id = await toPlaying();
    expect((await set(id, "Mallory", { half: 1, turn: 1, activeTeam: "home" })).status).toBe(403);
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    expect((await set(id, "Alice", { half: 1, turn: 1, activeTeam: "home" })).status).toBe(403);
    expect((await set(id, "Bob", { half: 1, turn: 1, activeTeam: "home" })).status).toBe(403);
    expect((await set(id, "Org", { half: 1, turn: 5, activeTeam: "away" })).status).toBe(200);
  });
});

describe("tournament turn-timer settings", () => {
  it("default optional + 240 s, organiser-editable through the tournament settings route, validated", async () => {
    const store = new TournamentStore(join(dir, "tournaments"));
    const t = store.createTournament({ name: "Cup", packageName: "Rules", maxPlayers: 8, format: "swiss", organizerCoachId: "Org" }, NOW);
    const org = { coach: "Org", organizer: true, admin: false };
    const call = (method: string, body?: unknown) =>
      tournamentApi(method, `/api/tournaments/${t.id}`, new URLSearchParams(), org, body, { store, packageExists: () => true, teamBuild: () => undefined, now: () => NOW } as never);
    expect((await call("GET"))!.body).toMatchObject({ tournament: { turnTimer: { enforced: "optional", seconds: 240 } } });
    expect((await call("PATCH", { turnTimer: { enforced: "required", seconds: 90 } }))!.body).toMatchObject({ tournament: { turnTimer: { enforced: "required", seconds: 90 } } });
    expect(store.tournament(t.id)!.turnTimer).toEqual({ enforced: "required", seconds: 90 });
    expect((await call("PATCH", { turnTimer: { seconds: 60 } }))!.body).toMatchObject({ tournament: { turnTimer: { enforced: "required", seconds: 60 } } }); // partial keeps the rest
    expect((await call("PATCH", { turnTimer: { enforced: "sometimes" } }))!.status).toBe(400);
    expect((await call("PATCH", { turnTimer: { seconds: 5 } }))!.status).toBe(400);
  });
});

describe("undo rules", () => {
  async function playing(): Promise<{ id: string; own: string; theirs: string }> {
    const r = await as("Alice", "POST", "/api/tabletop/matches", { pregame: "skip", home: { coach: "Alice", team: "sv_a" }, away: { coach: "Bob", team: "sv_b" } });
    const id = (r.body as { match: { id: string } }).match.id;
    const own = ev("touchdown", "home", "a1");
    const theirs = ev("touchdown", "away", "b1");
    await as("Alice", "POST", `/api/tabletop/matches/${id}/events`, { events: [own, theirs] });
    return { id, own: own.id, theirs: theirs.id };
  }
  const undo = (id: string, who: string, target: string) => as(who, "POST", `/api/tabletop/matches/${id}/events`, { events: [{ id: `undo-${target}`.slice(0, 40).padEnd(12, "x"), type: "undo", payload: { target } }] });

  it("while recording a participant undoes their own side's events (403 for the other side's); an organiser undoes any; by is recorded", async () => {
    const { id, own, theirs } = await playing();
    expect((await undo(id, "Alice", theirs)).status).toBe(403);
    expect((await undo(id, "Alice", own)).status).toBe(200);
    expect((await undo(id, "Org", theirs)).status).toBe(200);
    const events = ((await as("Alice", "GET", `/api/tabletop/matches/${id}`)).body as { events: Array<{ type: string; by: string }> }).events;
    expect(events.filter((e) => e.type === "undo").map((e) => e.by)).toEqual(["Alice", "Org"]);
  });

  it("once submitted, participants cannot undo (403); an organiser can, and the preview is recomputed", async () => {
    const { id, own } = await playing();
    await as("Alice", "POST", `/api/tabletop/matches/${id}/submit`);
    expect((await undo(id, "Alice", own)).status).toBe(403);
    const r = await undo(id, "Org", own);
    expect(r.status).toBe(200);
    const m = (r.body as { match: { state: string; preview: { home: { score: { for: number } } } } }).match;
    expect(m.state).toBe("submitted");
    expect(m.preview.home.score.for).toBe(0);
    // confirmed / published matches need the revision undo first
    await as("Org", "POST", `/api/tabletop/matches/${id}/confirm`);
    expect((await undo(id, "Org", own)).status).toBe(409);
  });
});

// ---- the Super socket: tabletop-clock ------------------------------------------------------------------------------
const ORIGIN = "https://play.example.test";
interface Client { frames: Array<Record<string, any>>; send(o: unknown): void; waitFor(p: (f: Record<string, any>) => boolean, ms?: number): Promise<Record<string, any>>; closed(): boolean }
const sockets: Socket[] = [];
function wsClient(port: number, headers: Record<string, string>): Promise<Client> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, "127.0.0.1");
    sockets.push(sock);
    const frames: Array<Record<string, any>> = [];
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let closed = false;
    const waiters: Array<() => void> = [];
    sock.on("close", () => { closed = true; waiters.forEach((w) => w()); });
    sock.on("error", () => undefined);
    const client: Client = {
      frames, closed: () => closed,
      send(o) {
        const payload = Buffer.from(JSON.stringify(o), "utf8");
        const mask = randomBytes(4);
        const head = Buffer.from([0x81, 0x80 | payload.length]);
        sock.write(Buffer.concat([head, mask, Buffer.from(payload.map((b, i) => b ^ mask[i & 3]!))]));
      },
      waitFor(pred, ms = 2000) {
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error(`timeout; frames=${JSON.stringify(frames)}`)), ms);
          const check = () => { const hit = frames.find(pred); if (hit) { clearTimeout(t); res(hit); return true; } if (closed) { clearTimeout(t); rej(new Error(`closed; frames=${JSON.stringify(frames)}`)); return true; } return false; };
          if (!check()) waiters.push(() => { check(); });
        });
      },
    };
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (!upgraded) {
        const idx = buf.indexOf("\r\n\r\n");
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        buf = buf.subarray(idx + 4);
        if (!head.startsWith("HTTP/1.1 101")) { reject(new Error(head)); return; }
        upgraded = true;
        resolve(client);
      }
      for (;;) {
        if (buf.length < 2) break;
        const opcode = buf[0]! & 0x0f;
        let len = buf[1]! & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (opcode === 0x1) frames.push(JSON.parse(payload.toString("utf8")));
        waiters.splice(0).forEach((w) => w());
      }
    });
    sock.write(
      "GET /super HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n` +
        Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n",
    );
  });
}

describe("tabletop-clock over the Super socket", () => {
  let server: Server;
  let service: SuperService;
  let port = 0;
  const members = new Set(["Alice", "Bob", "Org"]);

  beforeAll(async () => {
    service = new SuperService({
      verifyAuth: async () => false, resolveSeat: async () => null, log: () => undefined, lobbySessionCheckMs: 60_000,
      lobby: {
        sessionFromRequest: (req) => {
          const token = sessionTokenFromRequest(req as IncomingMessage);
          const s = getSession(token);
          return token && s?.method === "discord" ? { coach: s.coach, token } : undefined;
        },
        sessionCoach: (token) => { const s = getSession(token); return s?.method === "discord" ? s.coach : undefined; },
        originAllowed: (origin, host) => lobbyOriginAllowed(origin, host, [ORIGIN]),
        onSessionEnded,
        isMember: () => false, history: () => [], presence: () => null, appendChat: () => null,
        socketOpened: () => undefined, socketClosed: () => undefined, subscribe: () => undefined,
      },
      tabletop: {
        isMember: (matchId, coach) => matchId === "tm_socket" && members.has(coach),
        clock: (matchId) => ({ half: 1, turn: 0, activeTeam: "home", matchId }),
      },
    });
    server = createServer((_req, res) => res.writeHead(404).end());
    server.on("upgrade", (req, socket) => service.onUpgrade(req, socket));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const open = (coach: string) => wsClient(port, { Origin: ORIGIN, Cookie: `${SESSION_COOKIE_NAME}=${createSession(coach, Date.now(), "discord").token}` });

  it("members get the current clock on join and every later change; strangers and non-members are refused", async () => {
    const alice = await open("Alice");
    alice.send({ type: "hello", tabletopId: "tm_socket" });
    const welcome = await alice.waitFor((f) => f.type === "tabletopWelcome");
    expect(welcome).toMatchObject({ matchId: "tm_socket", coach: "Alice", features: ["tabletop-clock"], clock: { turn: 0 } });
    const org = await open("Org");
    org.send({ type: "hello", tabletopId: "tm_socket" });
    await org.waitFor((f) => f.type === "tabletopWelcome");

    const stranger = await open("Mallory");
    stranger.send({ type: "hello", tabletopId: "tm_socket" });
    expect(await stranger.waitFor((f) => f.type === "tabletopRefused")).toMatchObject({ reason: "member" });
    const noSession = await wsClient(port, { Origin: ORIGIN });
    noSession.send({ type: "hello", tabletopId: "tm_socket" });
    expect(await noSession.waitFor((f) => f.type === "tabletopRefused")).toMatchObject({ reason: "session" });

    service.publishTabletopClock("tm_socket", { half: 1, turn: 3, activeTeam: "away", turnStartedAt: "t", serverNow: "n" });
    for (const c of [alice, org]) {
      const frame = await c.waitFor((f) => f.type === "event" && f.feature === "tabletop-clock");
      expect(frame).toMatchObject({ matchId: "tm_socket", payload: { turn: 3, activeTeam: "away" } });
    }
    expect(stranger.frames.some((f) => f.feature === "tabletop-clock")).toBe(false);
    service.publishTabletopClock("tm_other", { turn: 1 }); // another match: nobody in this room hears it
    await new Promise((r) => setTimeout(r, 50));
    expect(alice.frames.filter((f) => f.feature === "tabletop-clock")).toHaveLength(1);
  });
});
