import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TournamentPackage } from "@bb/validator";
import { requireSession } from "../src/auth/requireSession";
import { isStateChangingApiRequest } from "../src/auth/csrf";
import { LobbyPresence } from "../src/fixtureLobby/presence";
import { FixtureLobbyStore } from "../src/fixtureLobby/store";
import { tournamentLobbyKey, tournamentLobbyRoute, type TournamentLobbyDeps } from "../src/fixtureLobby/tournament";
import type { LobbyResult } from "../src/fixtureLobby/api";
import { adoptLobbyMatch, createMatch, type TabletopApiDeps } from "../src/tabletop/api";
import type { TabletopPlayer, TabletopTeamFile } from "../src/tabletop/postMatch";
import { FileTabletopRepository } from "../src/tabletop/store";
import { TournamentResultStore } from "../src/tournamentResults";
import { tournamentApi } from "../src/tournaments/api";
import { TournamentStore } from "../src/tournaments/store";

// Tournament fixture lobby (src/fixtureLobby/tournament.ts): visibility (entrants, managers, read-only others, hidden
// drafts), package-driven inducement rules (treasury top-up, Highlander, allowed / caps / rosterOnly), Builder-bought
// inducements pre-filled and non-removable, the roster lock from the submitted snapshot, START into the recorder
// (idempotent, reporter seeded), the online launch gate and no recorder bypass once a lobby exists. Fake data only.

const at = (h: number): string => new Date(Date.parse("2026-11-01T12:00:00.000Z") + h * 3_600_000).toISOString();
const tplayers = (n: number, prefix: string): TabletopPlayer[] =>
  Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, number: i + 1, spp: i, skills: i === 0 ? ["Block"] : [], mng: false, niggles: 0, statLoss: {}, dead: false }));
const ORC: TabletopTeamFile = { schema: 1, name: "Green Tide", race: "Orc", treasury: 100_000, dedicatedFans: 2, teamValue: 1_000_000, players: tplayers(11, "a") };
const HUMAN: TabletopTeamFile = { schema: 1, name: "Grudge Rollers", race: "Human", treasury: 150_000, dedicatedFans: 2, teamValue: 1_100_000, players: tplayers(11, "b") };

const pkgWith = (inducements: Record<string, unknown> = {}, stars = true): TournamentPackage =>
  ({ name: "Test Cup", inducements: { allowed: ["*"], caps: {}, ...inducements }, starPlayers: { allowed: stars, maxCount: null, maxCombinedCost: null } }) as unknown as TournamentPackage;

const tournament = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, name: id === "t1" ? "Autumn Open" : "Winter Draft", status, format: "swiss", packageName: "test-cup", maxPlayers: 8, roundCount: 3, currentRound: 1,
  tiebreakers: [], points: { win: 3, draw: 1, loss: 0, bye: 3 }, ownerCoachId: "Org", organizerCoachIds: ["Org2"], createdAt: at(-200), updatedAt: at(-200), ...extra,
});
const side = (entrantId: string, coach: string, teamId: string) => ({ entrantId, coach: { coachId: coach, ffbCoachId: coach, verifiedAt: at(-300) }, teamId });
const match = (id: string, tid: string, home: ReturnType<typeof side>, away: ReturnType<typeof side>) => ({
  id, tournamentId: tid, roundId: `${tid}:round:1`, roundNumber: 1, home, away, status: "scheduled", revision: 1, launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 }, createdAt: at(-50), updatedAt: at(-50),
});
const M1 = "t1:round:1:match:1";

describe("tournament fixture lobby", () => {
  let dir = "";
  let tournaments: TournamentStore;
  let lobbyStore: FixtureLobbyStore;
  let presence: LobbyPresence;
  let pkg: TournamentPackage;
  let current = true;
  let clock = 0;
  let repo: FileTabletopRepository;
  let tt: TabletopApiDeps;
  let starts = 0;
  let chainAt: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tour-lobby-"));
    tournaments = new TournamentStore(dir);
    tournaments.writeSnapshot({
      version: 4,
      tournaments: { t1: tournament("t1", "active"), t2: tournament("t2", "draft", { ownerCoachId: "Org3", organizerCoachIds: [] }) },
      entrants: {
        e1: { id: "e1", tournamentId: "t1", seed: 1, coach: side("e1", "Ann", "lib-ann").coach, teamId: "lib-ann", registeredAt: at(-100),
          submission: { saveId: "save:ann1", revision: at(-95), submittedAt: at(-90), teamName: "Green Tide", race: "Orc", snapshot: { rosterId: "orc" },
            validation: { ok: true, problems: [], checkedAt: at(-90), packageName: "test-cup" } } },
        e2: { id: "e2", tournamentId: "t1", seed: 2, coach: side("e2", "Bob", "lib-bob").coach, teamId: "lib-bob", registeredAt: at(-100) },
        e3: { id: "e3", tournamentId: "t2", seed: 1, coach: side("e3", "Ann", "lib-ann").coach, teamId: "lib-ann", registeredAt: at(-100) },
        e4: { id: "e4", tournamentId: "t2", seed: 2, coach: side("e4", "Bob", "lib-bob").coach, teamId: "lib-bob", registeredAt: at(-100) },
      },
      rounds: {},
      standings: {},
      scheduledMatches: {
        [M1]: match(M1, "t1", side("e1", "Ann", "lib-ann"), side("e2", "Bob", "lib-bob")),
        m2: match("m2", "t2", side("e3", "Ann", "lib-ann"), side("e4", "Bob", "lib-bob")),
      },
      waitingPresence: {},
    } as never);
    lobbyStore = new FixtureLobbyStore(dir);
    presence = new LobbyPresence();
    pkg = pkgWith();
    current = true;
    clock = 0;
    starts = 0;
    chainAt = undefined;
    repo = new FileTabletopRepository(join(dir, "tt"));
    tt = {
      repo, results: new TournamentResultStore(join(dir, "res")),
      loadTeamFile: (coach) => (coach === "Ann" ? ORC : HUMAN),
      isBanned: () => false, isOrganizer: (c) => c === "Org", drawSeats: () => false, rollDie: () => 3,
      fixtures: {
        get: (id) => {
          const m = tournaments.match(id);
          return m ? { id: m.id, packageName: "test-cup", open: true, status: m.status, revision: m.revision, home: { coach: m.home.coach.ffbCoachId, teamId: m.home.teamId }, away: { coach: m.away!.coach.ffbCoachId, teamId: m.away!.teamId } } as never : undefined;
        },
        record: () => undefined, retract: () => undefined,
      },
      fixtureHasLobby: (ref) => lobbyStore.get(tournamentLobbyKey(ref)) !== undefined,
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (): TournamentLobbyDeps => ({
    store: lobbyStore, presence, now: () => new Date(Date.parse("2026-11-01T12:00:00.000Z") + clock++ * 1000),
    tournaments,
    packageOf: () => pkg,
    teamOf: (coach) => (coach === "Ann" ? { file: ORC, rostered: [{ key: "bribes", count: 2 }] } : { file: HUMAN, rostered: [] }),
    submissionCurrent: () => current,
    startTabletop: async (input) => {
      starts += 1;
      await new Promise((r) => setTimeout(r, 5));
      return createMatch(input.actor, input.organiser, { ...input.extra, fixtureRef: input.fixtureRef, home: input.home, away: input.away }, tt, () => new Date(), { inducementsByCoach: input.inducementsByCoach, fromLobby: true });
    },
    adoptMatch: (input) => adoptLobbyMatch(tt, input),
    chainStartedAt: async () => chainAt,
  });
  const L = `/api/tournaments/t1/fixtures/${encodeURIComponent(M1)}/lobby`;
  const call = async (coach: string | undefined, method: string, path: string, body: Record<string, unknown> = {}): Promise<LobbyResult> => {
    const r = await tournamentLobbyRoute(method, path, coach ? { coach, admin: coach === "Root" } : undefined, body, deps());
    if (!r) throw new Error(`no route ${method} ${path}`);
    return r;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const view = async (coach?: string): Promise<any> => (await call(coach, "GET", L)).body;
  const post = (coach: string, action: string, body: Record<string, unknown>) => call(coach, "POST", `${L}/${action}`, body);
  const err = (r: LobbyResult): string => (r.body as { error: string }).error;

  it("visibility: the two entrants act, the tournament's managers and admins organise, others read without chat or roster", async () => {
    const anon = await view();
    expect(anon).toMatchObject({ source: "tournament", mode: "tabletop", viewer: { role: "spectator", canChat: false }, chat: null });
    expect(anon.header).toMatchObject({ competition: "Autumn Open", round: 1, rounds: 3, ruleset: "test-cup" });
    // the submitted roster is the coaches' and managers' business
    expect(anon.sides.home.team.roster).toEqual([]);
    expect(anon.sides.home.inducements.prefilled).toBeNull();
    expect((await view("Ann")).viewer.role).toBe("home");
    expect((await view("Bob")).sides.home.team.roster).toHaveLength(3); // the opponent sees it
    expect((await view("Org")).viewer.role).toBe("organiser");
    expect((await view("Org2")).viewer.role).toBe("organiser");
    expect((await view("Root")).viewer.role).toBe("organiser");
    expect((await view("Eve")).viewer.role).toBe("spectator");
    expect((await post("Eve", "chat", { text: "hi" })).status).toBe(403);
    expect((await call(undefined, "POST", `${L}/chat`, { text: "hi" })).status).toBe(401);
    expect((await post("Ann", "chat", { text: "Hi Bob" })).status).toBe(200);
    // the managers read the coaches' messages only after a coach asks an organiser
    expect((await view("Org")).chat).toBeNull();
    expect((await post("Org", "chat", { text: "hello" })).status).toBe(403);
    expect((await post("Ann", "ask", {})).status).toBe(200);
    expect((await view("Org")).chat).toHaveLength(2);
    expect((await view("Eve")).chat).toBeNull();
    // gates: a public read on requireSession; every write is CSRF-covered
    const req = (method: string) => ({ method, headers: {} }) as IncomingMessage;
    expect(requireSession(req("GET"), L, "").kind).toBe("allow");
    expect(requireSession(req("POST"), `${L}/chat`, "").kind).toBe("unauthorized");
    expect(isStateChangingApiRequest("POST", `${L}/start`)).toBe(true);
    // unknown fixture / wrong tournament
    expect((await call("Ann", "GET", "/api/tournaments/t1/fixtures/nope/lobby")).status).toBe(404);
    expect((await call("Ann", "GET", "/api/tournaments/t2/fixtures/" + encodeURIComponent(M1) + "/lobby")).status).toBe(404);
  });

  it("a draft tournament is hidden from everyone but its managers (the honours rule), entrants included", async () => {
    const D = "/api/tournaments/t2/fixtures/m2/lobby";
    expect((await call(undefined, "GET", D)).status).toBe(404);
    expect((await call("Ann", "GET", D)).status).toBe(404);
    expect((await call("Ann", "POST", `${D}/chat`, { text: "hi" })).status).toBe(404);
    expect((await call("Org", "GET", D)).status).toBe(404); // a manager of ANOTHER tournament
    const mgr = await call("Org3", "GET", D);
    expect(mgr.status).toBe(200);
    expect((mgr.body as { open: boolean; closedReason: string }).closedReason).toBe("This tournament has not started yet.");
    expect((await call("Root", "GET", D)).status).toBe(200);
  });

  it("package rules: treasury top-up off by default (the overdog buys nothing), on with inducements.treasuryTopUp; Highlander per package", async () => {
    let v = await view("Ann");
    expect(v.inducements.rules).toEqual({ treasuryTopUp: false, highlander: false, starClash: "refund" });
    expect(v.sides.away.inducements).toMatchObject({ role: "overdog", hasStep: false });
    expect(v.sides.home.inducements.budget).toMatchObject({ role: "underdog", pettyCash: 100_000, topUpLimit: 0, limit: 100_000 });
    expect(err(await post("Bob", "inducements", { side: "away", picks: [] }))).toMatch(/buys no inducements/);
    pkg = pkgWith({ treasuryTopUp: true, highlander: true });
    v = await view("Ann");
    expect(v.inducements.rules).toMatchObject({ treasuryTopUp: true, highlander: true });
    expect(v.sides.away.inducements).toMatchObject({ hasStep: true, budget: { topUpLimit: 150_000 } });
    expect(v.sides.home.inducements.budget).toMatchObject({ topUpLimit: 50_000, limit: 150_000 });
  });

  it("package prices and caps: allowed list, caps, rosterOnly and the star switch decide the menu", async () => {
    pkg = pkgWith({ allowed: ["bribes", "bloodweiser_kegs", "halfling_master_chef", "star_players"], caps: { bloodweiser_kegs: 1 }, rosterOnly: { halfling_master_chef: ["Halfling"] } });
    const menu = (await view("Ann")).sides.home.inducements.menu as Array<{ id: string; items: Array<{ id: string; max: number }>; off: Array<{ id: string; reason: string }> }>;
    const items = menu.flatMap((c) => c.items);
    const off = menu.flatMap((c) => c.off);
    expect(items.find((i) => i.id === "bloodweiser_kegs")?.max).toBe(1);
    expect(off.find((o) => o.id === "halfling_master_chef")?.reason).toBe("Not for this team");
    expect(off.find((o) => o.id === "wandering_apothecaries" || o.id === "temp_agency_cheerleaders")?.reason).toBe("Ruleset off");
    expect(items.some((i) => i.id.startsWith("star:"))).toBe(true);
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: "bloodweiser_kegs", qty: 2 }] }))).toMatch(/at most 1/);
    // no stars in the package: no star players before the match either
    pkg = pkgWith({}, false);
    const stars = ((await view("Ann")).sides.home.inducements.menu as Array<{ id: string; items: unknown[]; off: Array<{ id: string }> }>).find((c) => c.id === "star")!;
    expect(stars.items).toHaveLength(0);
    expect(stars.off.map((o) => o.id)).toContain("star_players");
  });

  it("Builder-bought inducements are pre-filled and non-removable: they share the cap, cost nothing and survive an empty list", async () => {
    const v = await view("Ann");
    expect(v.sides.home.inducements.prefilled).toEqual([{ id: "bribes", name: "Bribes", qty: 2, cost: 0, prefilled: 2 }]);
    const bribes = (v.sides.home.inducements.menu as Array<{ items: Array<{ id: string; max: number; prefilled?: number }> }>).flatMap((c) => c.items).find((i) => i.id === "bribes")!;
    expect(bribes).toMatchObject({ max: 1, prefilled: 2 });
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 2 }] }))).toMatch(/at most 3, and the team already has 2 from the Builder/);
    expect((await post("Ann", "inducements", { side: "home", picks: [] })).status).toBe(200);
    const after = await view("Ann");
    expect(after.sides.home.inducements.picks).toEqual([]);
    expect(after.sides.home.inducements.prefilled).toHaveLength(1);
    // one more Bribe fits (100K petty cash; the two from the Builder are already paid)
    expect((await post("Ann", "inducements", { side: "home", picks: [{ id: "bribes", qty: 1 }], autoBuy: true, lock: true })).status).toBe(200);
  });

  it("the roster lock plays the submitted roster (no free choice) and refuses a save changed after the snapshot", async () => {
    const own = await view("Ann");
    expect(own.fixedTeam).toEqual({ ref: "save:ann1", name: "Green Tide", race: "Orc" });
    expect(own.recorderTeams.map((t: { ref: string }) => t.ref)).toEqual(["save:ann1"]);
    expect(err(await post("Ann", "roster", { locked: true, teamRef: "library:lib-ann" }))).toMatch(/plays your submitted team \(Green Tide\)/);
    expect((await post("Ann", "roster", { locked: true })).status).toBe(200);
    expect((await view("Ann")).sides.home.teamRef).toBe("save:ann1");
    // nothing submitted: the registered library team
    expect((await post("Bob", "roster", { locked: true })).status).toBe(200);
    expect((await view("Bob")).sides.away.teamRef).toBe("library:lib-bob");
    await post("Ann", "roster", { locked: false });
    current = false;
    const r = await post("Ann", "roster", { locked: true });
    expect(r.status).toBe(409);
    expect(err(r)).toMatch(/save changed after it was submitted/);
    expect((await view("Ann")).fixedTeam).toHaveProperty("error");
  });

  async function readyAndLock(): Promise<void> {
    for (const c of ["Ann", "Bob"]) {
      expect((await post(c, "roster", { locked: true })).status).toBe(200);
      expect((await post(c, "ready", { ready: true })).status).toBe(200);
      expect((await post(c, "presence", {})).status).toBe(200);
    }
    expect((await post("Ann", "inducements", { side: "home", picks: [{ id: "bloodweiser_kegs", qty: 1 }], autoBuy: true, lock: true })).status).toBe(200);
  }

  it("START creates ONE recorder match with the tournament fixtureRef and both lists (Builder lines included); the reporter is seeded", async () => {
    await readyAndLock();
    const [a, b] = await Promise.all([post("Ann", "start", {}), post("Bob", "start", {})]);
    expect(starts).toBe(1);
    const to = (a.body as { to: string }).to;
    expect(to).toMatch(/^\/tabletop\/tm_/);
    expect((b.body as { to: string }).to).toBe(to);
    expect((await post("Org", "start", { force: true })).body).toMatchObject({ started: true, to });
    const matches = await repo.listMatches();
    expect(matches).toHaveLength(1);
    const m = matches[0]!;
    expect(m).toMatchObject({ fixtureRef: M1, league: "test-cup", home: { coach: "Ann", teamSaveId: "ann1" }, away: { coach: "Bob", teamSaveId: "library:lib-bob" } });
    expect(m.inducements!.home.picks).toEqual([
      { id: "bloodweiser_kegs", name: "Blitzer's Best Kegs", qty: 1, cost: 50_000 },
      { id: "bribes", name: "Bribes", qty: 2, cost: 0, prefilled: 2 },
    ]);
    expect(m.inducements!.home).toMatchObject({ total: 50_000, pettyCash: 100_000, treasury: 0 });
    const events = (await repo.readEvents(m.id)).filter((e) => e.type === "inducement");
    expect(events.map((e) => [e.id, e.payload.total, e.payload.lobby])).toEqual([["pg-inducement-home", 50_000, true], ["pg-inducement-away", 0, true]]);
    expect((await view()).started).toMatchObject({ mode: "tabletop", matchId: m.id });
  });

  it("no bypass: once a lobby exists the recorder refuses a direct create; a fixture without a lobby keeps the old path", async () => {
    const body = { fixtureRef: M1, home: { coach: "Ann", team: "save:ann1" }, away: { coach: "Bob", team: "library:lib-bob" } };
    await post("Ann", "chat", { text: "see you at table 3" }); // the lobby exists from here on
    expect(await createMatch("Ann", false, body, tt, () => new Date())).toMatchObject({ status: 409, body: { error: "Start this fixture from its fixture lobby." } });
    expect((await createMatch("Org", true, body, tt, () => new Date())).status).toBe(409);
    // an unreadable lobby fails closed
    expect((await createMatch("Ann", false, body, { ...tt, fixtureHasLobby: () => { throw new Error("bad file"); } }, () => new Date())).status).toBe(500);
    // a GET never creates the lobby: another fixture without one records directly as before
    tournaments.writeSnapshot({ ...tournaments.snapshot(), scheduledMatches: { ...tournaments.snapshot().scheduledMatches, m3: match("m3", "t1", side("e1", "Ann", "lib-ann"), side("e2", "Bob", "lib-bob")) } } as never);
    await call("Ann", "GET", "/api/tournaments/t1/fixtures/m3/lobby");
    expect((await createMatch("Ann", false, { ...body, fixtureRef: "m3" }, tt, () => new Date())).status).toBe(201);
  });

  it("Super FUMBBL tournaments: no inducement step, and the online launch waits for the lobby's START", async () => {
    const tdeps = { store: tournaments, teamBuild: () => undefined, fixtureLobby: (id: string) => { const r = lobbyStore.get(tournamentLobbyKey(id)); return r ? { started: Boolean(r.started) } : undefined; } };
    // the organiser's settings switch (managers only)
    const settings = (coach: string, playOnFork: unknown) => tournamentApi("PATCH", "/api/tournaments/t1", new URLSearchParams(), { coach, organizer: true, admin: false }, { playOnFork }, tdeps);
    expect((await settings("Eve", true))!.status).toBe(403);
    expect((await settings("Org", "yes"))!.status).toBe(400);
    expect((await settings("Org", true))!.body).toMatchObject({ tournament: { playOnFork: true } });
    const presenceCall = () => tournamentApi("POST", `/api/scheduled-matches/${encodeURIComponent(M1)}/presence`, new URLSearchParams(), { coach: "Ann", organizer: false, admin: false }, {}, tdeps);
    const launch = (status: string, revision: number) => tournamentApi("PATCH", `/api/scheduled-matches/${encodeURIComponent(M1)}/launch`, new URLSearchParams(), { coach: "Org", organizer: true, admin: false }, { status, revision, gameId: "g1" }, tdeps);
    // no lobby yet: the old path
    expect((await presenceCall())!.status).toBe(200);
    await post("Bob", "chat", { text: "ready when you are" });
    const held = (await presenceCall())!;
    expect(held.status).toBe(409);
    expect(held.body).toEqual({ error: "Start this match from the fixture lobby first." });
    expect((await launch("launching", 1))!.status).toBe(409);
    expect((await launch("launch_failed", 1))!.status).not.toBe(409); // a failure report is never held
    const v = await view("Ann");
    expect(v.mode).toBe("fork");
    expect(v.inducements.step).toBe(false);
    expect(err(await post("Ann", "inducements", { side: "home", picks: [] }))).toMatch(/Super FUMBBL client/);
    for (const c of ["Ann", "Bob"]) { await post(c, "roster", { locked: true }); await post(c, "ready", { ready: true }); }
    expect((await post("Ann", "start", {})).body).toMatchObject({ started: true, to: "/tournaments/t1?tab=rounds" });
    expect(starts).toBe(0);
    expect((await presenceCall())!.status).not.toBe(409);
    // a started lobby went online: switching the tournament back to tabletop would strand it
    const back = (await settings("Org", false))!;
    expect(back.status).toBe(409);
    expect((back.body as { error: string }).error).toMatch(/already started its match/);
  });

  it("an edited submitted save unlocks the locked roster with the reason; START never runs on it", async () => {
    await readyAndLock();
    current = false; // Ann edits the submitted save after locking and pressing Ready
    const r = await post("Bob", "start", {});
    expect(r.status).toBe(409);
    expect(err(r)).toMatch(/save changed after it was submitted/);
    expect(starts).toBe(0);
    const v = await view("Ann");
    expect(v.sides.home).toMatchObject({ rosterLocked: false, ready: false });
    expect(v.chat.at(-1).text).toMatch(/^Ann's roster was unlocked: Green Tide: the Team Builder save changed/);
    expect(err(await post("Ann", "ready", { ready: true }))).toMatch(/save changed after it was submitted|Lock the roster first/);
  });

  it("a withdrawn entrant loses the seat: a spectator who cannot write, and the lobby closes", async () => {
    await post("Bob", "chat", { text: "hi" });
    const snap = tournaments.snapshot();
    tournaments.writeSnapshot({ ...snap, entrants: { ...snap.entrants, e2: { ...snap.entrants.e2!, droppedAt: at(-1) } } } as never);
    const v = await view("Bob");
    expect(v.viewer.role).toBe("spectator");
    expect(v.chat).toBeNull();
    expect(v).toMatchObject({ open: false, closedReason: "Bob withdrew from the tournament." });
    expect((await post("Bob", "chat", { text: "still here?" })).status).toBe(403);
    expect((await view("Ann")).viewer.role).toBe("home");
  });

  it("spectators get the menu without Builder counts", async () => {
    const items = (v: { sides: { home: { inducements: { menu: Array<{ items: Array<{ id: string; max: number; prefilled?: number }> }> } } } }) =>
      v.sides.home.inducements.menu.flatMap((c) => c.items).find((i) => i.id === "bribes")!;
    expect(items(await view())).toEqual(expect.objectContaining({ max: 3 }));
    expect(items(await view())).not.toHaveProperty("prefilled");
    expect(items(await view("Eve"))).not.toHaveProperty("prefilled");
    expect(items(await view("Bob"))).toMatchObject({ max: 1, prefilled: 2 });
  });

  it("the package's star limits (count, combined cost, roster stars included) hold at save, lock and START", async () => {
    const stars = ((await view("Ann")).sides.home.inducements.menu as Array<{ id: string; items: Array<{ id: string; price: number }> }>).find((c) => c.id === "star")!.items;
    expect(stars.length).toBeGreaterThan(1);
    pkg = { ...pkgWith(), starPlayers: { allowed: true, maxCount: 1, maxCombinedCost: null } } as unknown as TournamentPackage;
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: stars[0]!.id, qty: 1 }, { id: stars[1]!.id, qty: 1 }] }))).toMatch(/at most 1 star player per team/);
    pkg = { ...pkgWith(), starPlayers: { allowed: true, maxCount: null, maxCombinedCost: stars[0]!.price - 5_000 } } as unknown as TournamentPackage;
    expect(err(await post("Ann", "inducements", { side: "home", picks: [{ id: stars[0]!.id, qty: 1 }] }))).toMatch(/Star players may cost at most/);
    // a star already on the roster counts
    const starPlayer = { ...ORC.players[0]!, id: "s1", kind: "star" as const, positionName: stars[0]!.id.slice(5) };
    const withStar = { ...ORC, players: [...ORC.players, starPlayer] };
    pkg = { ...pkgWith(), starPlayers: { allowed: true, maxCount: 1, maxCombinedCost: null } } as unknown as TournamentPackage;
    const d = deps();
    const r = await tournamentLobbyRoute("POST", `${L}/inducements`, { coach: "Ann", admin: false }, { side: "home", picks: [{ id: stars[1]!.id, qty: 1 }] },
      { ...d, teamOf: (c) => (c === "Ann" ? { file: withStar, rostered: [] } : { file: HUMAN, rostered: [] }) });
    expect(err(r!)).toMatch(/1 already on the roster/);
  });

  it("START refuses when the recorder already holds the save from before the submitted revision", async () => {
    await readyAndLock();
    chainAt = at(-200); // the recorder chain was built from an older version of the save
    const r = await post("Ann", "start", {});
    expect(r.status).toBe(409);
    expect(err(r)).toMatch(/older version of the save than the one submitted/);
    expect(await repo.listMatches()).toHaveLength(0);
    chainAt = at(-10); // a chain started after the submission holds exactly the submitted roster
    expect((await post("Ann", "start", {})).body).toMatchObject({ started: true });
  });
});
