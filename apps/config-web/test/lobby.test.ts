import { describe, expect, it } from "vitest";
import { Matchmaker } from "@bb/fork-ops";
import { LobbyStore, lobbyApi, lobbyRosterFromDetail, cleanChatText, lobbyOriginAllowed, lobbyAllowedOriginsFromEnv, type LobbyApiDeps, type LobbyRoster } from "../src/lobby";

const TEAMS: Record<string, Record<string, { teamName: string; race: string }>> = {
  alice: { t1: { teamName: "Alice Orcs", race: "Orc" }, t1b: { teamName: "Alice Humans", race: "Human" } },
  bob: { t2: { teamName: "Bob Elves", race: "Wood Elf" }, t2b: { teamName: "Bob Dwarfs", race: "Dwarf" } },
  carol: { t3: { teamName: "Carol Dwarfs", race: "Dwarf" } },
};

function setup(opts: { scheduleFails?: boolean; gate?: Promise<void> } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const banned = new Set<string>();
  const retired = new Set<string>();
  const scheduled: Array<[string, string]> = [];
  let gameNo = 0;
  const matchmaker = new Matchmaker({
    now,
    ttlMs: 10 * 60 * 1000,
    scheduleGame: async (home, away) => {
      scheduled.push([home, away]);
      if (opts.gate) await opts.gate;
      if (opts.scheduleFails) throw new Error("fork down");
      return { gameId: String(4242 + gameNo++) };
    },
    // a client challenge must carry a digest; lobby challenges never do (challengeVerified)
    verifyChallenger: async (_coach, digest) => digest === "c".repeat(32),
    validateSide: ({ coach, teamId }) => (banned.has(coach.toLowerCase()) ? `${coach} can't play right now.` : retired.has(teamId) ? `Team ${teamId} is retired.` : undefined),
  });
  const store = new LobbyStore({
    matchmaker,
    now,
    isBanned: (coach) => banned.has(coach.toLowerCase()),
    resolveTeam: (coach, teamId) => {
      const t = TEAMS[coach.toLowerCase()]?.[teamId];
      return t && !retired.has(teamId) ? { teamId, ...t } : { error: `Team ${teamId} isn't in ${coach}'s library.`, status: 400 };
    },
  });
  matchmaker.onPaired((p) => store.notePairing(p));
  return { store, matchmaker, scheduled, banned, retired, advance: (ms: number) => { clock += ms; } };
}

describe("LobbyStore: a view over the matchmaker", () => {
  it("create = challenge (no digest); join = counter-challenge; pairs and schedules once", async () => {
    const { store, matchmaker, scheduled } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(matchmaker.pendingOf("alice")).toMatchObject({ id: lobby.creatorChallengeId, teamId: "t1", opponent: "Bob" });
    expect(store.view(lobby, "Alice")).toMatchObject({ status: "waiting", canRenew: false });
    expect(store.view(lobby, "Bob")).toMatchObject({ status: "waiting", canAccept: true, opponent: { team: null } });
    expect(store.inbox("Bob")).toEqual([expect.objectContaining({ coach: "Alice", lobbyId: lobby.id })]);

    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toHaveLength(1);
    const v = store.view(store.get(lobby.id)!, "Bob");
    expect(v).toMatchObject({ status: "ready", canAccept: false, game: { gameId: "4242" }, opponent: { team: { teamId: "t2" } } });
    const delivery = matchmaker.matchstatus("Alice") as { jnlp: string; gameId?: string };
    expect(delivery.gameId).toBe("4242"); // the lobby's game IS the delivery's game
    expect(delivery.jnlp).not.toContain("passwordMd5");
    await store.join(lobby.id, "Bob", "t2"); // idempotent
    expect(scheduled).toHaveLength(1);
  });

  it("the opponent creating against an open lobby joins it", async () => {
    const { store, scheduled } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    const again = await store.create("bob", "t2", "alice");
    expect(again.id).toBe(lobby.id);
    expect(scheduled).toHaveLength(1);
  });

  it("a client challenge already waiting pairs at once when the lobby opens", async () => {
    const { store, matchmaker, scheduled } = setup();
    await matchmaker.challenge({ coach: "Bob", teamId: "t2", opponent: "Alice", passwordMd5: "c".repeat(32) });
    expect(store.inbox("Alice")[0]!.lobbyId).toBeUndefined();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(scheduled).toHaveLength(1);
    expect(store.view(lobby, "Alice").status).toBe("ready");
  });

  it("cancelled consent is never resurrected: the creator must confirm, and the confirm pairs", async () => {
    const { store, matchmaker, scheduled } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    matchmaker.cancel("Alice"); // e.g. the client's Cancel button
    expect(store.view(lobby, "Alice")).toMatchObject({ status: "needs-renewal", canRenew: true });
    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toEqual([]); // Bob's acceptance waits for Alice
    expect(matchmaker.pendingOf("Alice")).toBeUndefined();
    expect(store.view(lobby, "Bob")).toMatchObject({ status: "needs-renewal", opponentAccepted: true, canAccept: false });
    await store.renew(lobby.id, "Alice");
    expect(scheduled).toHaveLength(1);
    expect(store.view(lobby, "Alice").status).toBe("ready");
    await expect(store.renew(lobby.id, "Bob")).rejects.toMatchObject({ status: 403 });
  });

  it("an expired creator challenge needs confirming; a superseded one (challenged someone else) too", async () => {
    const { store, matchmaker, scheduled, advance } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    advance(11 * 60 * 1000);
    expect(store.view(store.get(lobby.id)!, "Alice").status).toBe("needs-renewal");
    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toEqual([]);

    const s2 = setup();
    const l2 = await s2.store.create("Alice", "t1", "Bob");
    await s2.matchmaker.challenge({ coach: "Alice", teamId: "t1", opponent: "Carol", passwordMd5: "c".repeat(32) });
    expect(s2.store.view(l2, "Bob").status).toBe("needs-renewal");
    await s2.store.join(l2.id, "Bob", "t2");
    expect(s2.scheduled).toEqual([]);
    expect(s2.matchmaker.pendingOf("Alice")).toMatchObject({ opponent: "Carol" }); // Alice's other consent untouched
    void matchmaker;
  });

  it("renewal stops when it already paired; renewal re-validates the team", async () => {
    const { store, matchmaker, retired } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    matchmaker.cancel("Alice");
    retired.add("t1");
    await expect(store.renew(lobby.id, "Alice")).rejects.toMatchObject({ status: 400 });
    await store.renew(lobby.id, "Alice", "t1b");
    await store.join(lobby.id, "Bob", "t2");
    expect(store.view(lobby, "Alice")).toMatchObject({ status: "ready", creator: { team: { teamId: "t1b" } } });
    const before = lobby.pairing;
    await store.renew(lobby.id, "Alice", "t1b");
    expect(lobby.pairing).toBe(before);
  });

  it("both teams are re-validated at pairing: a team retired after the challenge stops the schedule", async () => {
    const { store, retired, scheduled, matchmaker } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    retired.add("t1");
    await expect(store.join(lobby.id, "Bob", "t2")).rejects.toMatchObject({ status: 409 });
    expect(scheduled).toEqual([]);
    expect(matchmaker.pendingOf("Alice")).toBeUndefined(); // Alice's consent voided
    expect(store.view(lobby, "Bob")).toMatchObject({ status: "needs-renewal", canAccept: true, opponent: { team: null } });
  });

  it("overlapping joins schedule once and the lobby shows the delivered game", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { store, scheduled, matchmaker } = setup({ gate });
    const lobby = await store.create("Alice", "t1", "Bob");
    const a = store.join(lobby.id, "Bob", "t2");
    const b = store.join(lobby.id, "Bob", "t2b");
    release();
    const results = await Promise.allSettled([a, b]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(scheduled).toHaveLength(1);
    const delivered = matchmaker.matchstatus("Bob") as { gameId?: string };
    expect(store.view(lobby, "Bob").game?.gameId).toBe(delivered.gameId);
    expect(store.view(lobby, "Bob").opponent.team?.teamId).toBe("t2");
  });

  it("a client challenge with another team never pairs behind the lobby's back", async () => {
    const { store, matchmaker, scheduled, advance } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    advance(11 * 60 * 1000); // Alice's challenge expired
    await matchmaker.challenge({ coach: "Bob", teamId: "t2", opponent: "Alice", passwordMd5: "c".repeat(32) });
    await store.join(lobby.id, "Bob", "t2b"); // replaces Bob's pending challenge, no pairing (Alice's lapsed)
    expect(scheduled).toEqual([]);
    await store.renew(lobby.id, "Alice");
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]!.sort()).toEqual(["t1", "t2b"]);
    expect(store.view(lobby, "Alice").opponent.team?.teamId).toBe("t2b");
  });

  it("a failed join leaves the seat untouched and Accept available", async () => {
    const { store, matchmaker } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    await expect(store.join(lobby.id, "Bob", "nope")).rejects.toMatchObject({ status: 400 });
    expect(lobby.opponentTeam).toBeUndefined();
    expect(store.view(lobby, "Bob")).toMatchObject({ canAccept: true, opponent: { team: null } });
    // a matchmaker refusal (pairing in flight for Bob) also leaves no partial state
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const s2 = setup({ gate });
    const l2 = await s2.store.create("Alice", "t1", "Bob");
    const first = s2.store.join(l2.id, "Bob", "t2");
    await expect(s2.store.join(l2.id, "Bob", "t2b")).rejects.toMatchObject({ status: 409 });
    release();
    await first;
    expect(l2.opponentTeam?.teamId).toBe("t2");
    void matchmaker;
  });

  it("dynamic bans: create (either side), join and launch re-check every time", async () => {
    const { store, banned } = setup();
    banned.add("bob");
    await expect(store.create("Alice", "t1", "Bob")).rejects.toMatchObject({ status: 403 });
    banned.clear();
    const lobby = await store.create("Alice", "t1", "Bob");
    banned.add("bob");
    await expect(store.join(lobby.id, "Bob", "t2")).rejects.toMatchObject({ status: 403 });
    banned.clear();
    await store.join(lobby.id, "Bob", "t2");
    banned.add("alice");
    expect(() => store.launch(lobby.id, "Alice")).toThrow(/banned/);
    expect(() => store.seatOf(lobby.id, "Alice")).toThrow(/banned/);
    expect(store.launch(lobby.id, "Bob")).toMatchObject({ coach: "Bob", teamId: "t2" });
  });

  it("a ban between challenge and accept stops the pairing inside the matchmaker", async () => {
    const { store, banned, scheduled } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    banned.add("alice");
    // join's own ban gate refuses first; the matchmaker validator is the backstop for client accepts
    await expect(store.join(lobby.id, "Bob", "t2")).rejects.toMatchObject({ status: 403 });
    expect(scheduled).toEqual([]);
  });

  it("validates: self-challenge, unknown team, only the opponent may join", async () => {
    const { store } = setup();
    await expect(store.create("Alice", "t1", "alice")).rejects.toMatchObject({ status: 400 });
    await expect(store.create("Alice", "nope", "Bob")).rejects.toMatchObject({ status: 400 });
    expect(store.listFor("Alice")).toEqual([]); // nothing stored for a failed create
    const lobby = await store.create("Alice", "t1", "Bob");
    await expect(store.join(lobby.id, "Alice", "t1")).rejects.toMatchObject({ status: 409 });
    await expect(store.join(lobby.id, "Carol", "t3")).rejects.toMatchObject({ status: 403 });
  });

  it("expires 24 h after creation (410), or 1 h after the first launch", async () => {
    const { store, advance } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    advance(24 * 60 * 60 * 1000);
    expect(store.sweep()).toBe(1);
    expect(store.goneReason(lobby.id)).toBe("expired");
    expect(() => store.requireMember(lobby.id, "Alice")).toThrow(/expired/);

    const s2 = setup();
    const l2 = await s2.store.create("Alice", "t1", "Bob");
    await s2.store.join(l2.id, "Bob", "t2");
    s2.store.launch(l2.id, "Alice");
    s2.advance(59 * 60 * 1000);
    expect(s2.store.get(l2.id)).toBeDefined();
    s2.advance(2 * 60 * 1000);
    expect(s2.store.get(l2.id)).toBeUndefined();
  });

  it("presence: not here yet -> here -> left -> in the client", async () => {
    const { store, advance } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    const state = (coach: string) => store.presence(lobby.id)!.find((p) => p.coach.toLowerCase() === coach)!.state;
    expect(state("alice")).toBe("here");
    expect(state("bob")).toBe("not-here-yet");
    store.touch(lobby.id, "Bob");
    expect(state("bob")).toBe("here");
    advance(20_000);
    expect(state("bob")).toBe("left");
    store.socketOpened(lobby.id, "Bob");
    store.socketOpened(lobby.id, "Bob");
    advance(60_000);
    store.socketClosed(lobby.id, "Bob");
    expect(state("bob")).toBe("here"); // one tab still open
    store.socketClosed(lobby.id, "Bob");
    expect(state("bob")).toBe("left");
    await store.join(lobby.id, "Bob", "t2");
    store.launch(lobby.id, "Bob");
    expect(state("bob")).toBe("client");
  });

  it("chat: members only, cleaned, capped", async () => {
    const { store } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(store.appendChat(lobby.id, "Carol", "hi")).toBeNull();
    expect(store.appendChat(lobby.id, "alice", "  hi\u0000 there ")).toMatchObject({ coach: "Alice", text: "hi there" });
    for (let i = 0; i < 250; i++) store.appendChat(lobby.id, "Alice", `m${i}`);
    expect(store.history(lobby.id)).toHaveLength(200);
    expect(cleanChatText("   ")).toBeNull();
    expect(cleanChatText("x".repeat(900))).toHaveLength(500);
  });

  it("close withdraws only this lobby's challenge", async () => {
    const { store, matchmaker } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(() => store.close(lobby.id, "Bob")).toThrow(/Only the coach/);
    store.close(lobby.id, "Alice");
    expect(matchmaker.pendingOf("Alice")).toBeUndefined();
    expect(store.goneReason(lobby.id)).toBe("closed");
  });
});

describe("lobbyApi", () => {
  const roster: LobbyRoster = {
    teamId: "t2", name: "Bob Elves", race: "Wood Elf", teamValue: 1000, treasury: 50000, rerolls: 2, apothecary: true,
    fanFactor: 3, assistantCoaches: 1, cheerleaders: 0, players: [],
  };
  function deps(store: LobbyStore, calls: { rating: string[]; jnlp: unknown[]; locked: number } = { rating: [], jnlp: [], locked: 0 }): LobbyApiDeps {
    return {
      store,
      roster: (coach, teamId) => (coach === "Bob" && teamId === "t2" ? roster : undefined),
      coachCard: (coach) => ({ avatar: coach === "Bob" ? "https://cdn.discordapp.com/avatars/1/x.png" : null, fumbblName: coach === "Bob" ? "BobOnFumbbl" : null }),
      rating: async (name, requester) => { calls.rating.push(`${requester}:${name}`); return { name, cr: 150.2 }; },
      jnlp: async (seat) => { calls.jnlp.push(seat); return `<jnlp coach="${seat.coach}" team="${seat.teamId}" game="${seat.gameId ?? ""}"/>`; },
      chatLive: () => true,
      withGameStartLock: async (fn) => { calls.locked++; return fn(); },
    };
  }
  const discord = (coach: string) => ({ coach, method: "discord" });
  const call = (d: LobbyApiDeps, method: string, path: string, auth: { coach: string; method: string } | undefined, body?: unknown, q = "") =>
    lobbyApi(method, path, new URLSearchParams(q), auth, body, d);

  it("401 without a session, 403 for a password session; non-lobby paths fall through", async () => {
    const { store } = setup();
    expect(await call(deps(store), "GET", "/api/lobby", undefined)).toMatchObject({ status: 401 });
    expect(await call(deps(store), "GET", "/api/lobby", { coach: "Alice", method: "password" })).toMatchObject({ status: 403 });
    expect(await call(deps(store), "GET", "/api/coach-rating", { coach: "Alice", method: "password" }, undefined, "name=x")).toMatchObject({ status: 403 });
    expect(await call(deps(store), "GET", "/api/other", discord("Alice"))).toBeUndefined();
  });

  it("create -> join -> launch -> the session-scoped JNLP for MY seat; writes run under the lock", async () => {
    const { store } = setup();
    const calls = { rating: [] as string[], jnlp: [] as unknown[], locked: 0 };
    const d = deps(store, calls);
    const created = await call(d, "POST", "/api/lobby", discord("Alice"), { teamId: "t1", opponent: "Bob" });
    expect(created!.status).toBe(201);
    const id = (created!.body as { lobby: { id: string } }).lobby.id;
    expect(await call(d, "POST", "/api/lobby", discord("Alice"), { coach: "Carol", teamId: "t1", opponent: "Bob" })).toMatchObject({ status: 403 });
    expect(await call(d, "POST", `/api/lobby/${id}/launch`, discord("Alice"))).toMatchObject({ status: 409 });
    expect(await call(d, "GET", `/api/lobby/${id}/jnlp`, discord("Alice"))).toMatchObject({ status: 409 });
    expect(await call(d, "POST", `/api/lobby/${id}/join`, discord("Bob"), { teamId: "t2" })).toMatchObject({ status: 200 });

    const launched = await call(d, "POST", `/api/lobby/${id}/launch`, discord("Alice"));
    expect(launched!.body).toEqual({ jnlpUrl: `/api/lobby/${id}/jnlp`, scheme: null, side: expect.stringMatching(/^(home|away)$/), gameName: expect.stringMatching(/^chal_/), gameId: "4242" });
    const a = await call(d, "GET", `/api/lobby/${id}/jnlp`, discord("Alice"));
    const b = await call(d, "GET", `/api/lobby/${id}/jnlp`, discord("Bob"));
    expect(a).toMatchObject({ status: 200, contentType: expect.stringContaining("jnlp"), body: '<jnlp coach="Alice" team="t1" game="4242"/>' });
    expect(b!.body).toBe('<jnlp coach="Bob" team="t2" game="4242"/>');
    expect(await call(d, "GET", `/api/lobby/${id}/jnlp`, discord("Carol"))).toMatchObject({ status: 403 });
    expect(await call(d, "GET", `/api/lobby/${id}/jnlp`, { coach: "Alice", method: "password" })).toMatchObject({ status: 403 });
    expect(calls.locked).toBe(4); // create, the refused launch, join, launch (the coach-mismatch 403 never locks)
  });

  it("renew and the needs-renewal view through the API", async () => {
    const { store, matchmaker } = setup();
    const d = deps(store);
    const id = ((await call(d, "POST", "/api/lobby", discord("Alice"), { teamId: "t1", opponent: "Bob" }))!.body as { lobby: { id: string } }).lobby.id;
    matchmaker.cancel("Alice");
    expect(((await call(d, "GET", `/api/lobby/${id}`, discord("Bob")))!.body as { lobby: { status: string; canAccept: boolean } }).lobby).toMatchObject({ status: "needs-renewal", canAccept: true });
    await call(d, "POST", `/api/lobby/${id}/join`, discord("Bob"), { teamId: "t2" });
    expect(await call(d, "POST", `/api/lobby/${id}/renew`, discord("Bob"), {})).toMatchObject({ status: 403 });
    const renewed = await call(d, "POST", `/api/lobby/${id}/renew`, discord("Alice"), {});
    expect((renewed!.body as { lobby: { status: string } }).lobby.status).toBe("ready");
  });

  it("state + rosters + coach card: members only, roster fields only, 'not shared yet' before an accept", async () => {
    const { store } = setup();
    const d = deps(store);
    const id = ((await call(d, "POST", "/api/lobby", discord("Alice"), { teamId: "t1", opponent: "Bob" }))!.body as { lobby: { id: string } }).lobby.id;
    expect(await call(d, "GET", `/api/lobby/${id}`, discord("Carol"))).toMatchObject({ status: 403 });
    expect(await call(d, "GET", `/api/lobby/${id}/roster`, discord("Alice"), undefined, "role=opponent")).toEqual({ status: 200, body: { shared: false, roster: null } });
    await call(d, "POST", `/api/lobby/${id}/join`, discord("Bob"), { teamId: "t2" });
    expect(await call(d, "GET", `/api/lobby/${id}/roster`, discord("Alice"), undefined, "role=opponent")).toEqual({ status: 200, body: { shared: true, roster } });
    expect(await call(d, "GET", `/api/lobby/${id}/coach`, discord("Alice"), undefined, "role=opponent")).toEqual({
      status: 200, body: { coach: "Bob", avatar: "https://cdn.discordapp.com/avatars/1/x.png", fumbblName: "BobOnFumbbl" },
    });
    expect(await call(d, "GET", "/api/lobby/zz", discord("Alice"))).toMatchObject({ status: 404 });
  });

  it("coach-rating charges the session coach; a limit error surfaces as 429", async () => {
    const { store } = setup();
    const calls = { rating: [] as string[], jnlp: [] as unknown[], locked: 0 };
    const d = deps(store, calls);
    expect(await call(d, "GET", "/api/coach-rating", discord("Alice"), undefined, "name=BobOnFumbbl")).toMatchObject({ status: 200 });
    expect(calls.rating).toEqual(["Alice:BobOnFumbbl"]);
    const limited = { ...d, rating: async () => { throw Object.assign(new Error("Too many rating lookups."), { status: 429 }); } };
    expect(await call(limited, "GET", "/api/coach-rating", discord("Alice"), undefined, "name=x")).toMatchObject({ status: 429 });
  });

  it("410 for an expired lobby", async () => {
    const { store, advance } = setup();
    const d = deps(store);
    const id = ((await call(d, "POST", "/api/lobby", discord("Alice"), { teamId: "t1", opponent: "Bob" }))!.body as { lobby: { id: string } }).lobby.id;
    advance(25 * 60 * 60 * 1000);
    expect(await call(d, "GET", `/api/lobby/${id}`, discord("Alice"))).toMatchObject({ status: 410, body: { error: "This lobby has expired." } });
  });
});

describe("helpers", () => {
  it("lobbyRosterFromDetail keeps roster fields only, sorted by number", () => {
    const r = lobbyRosterFromDetail({
      id: "t", name: "N", race: "R", teamValue: 1, treasury: 2, rerolls: 3, apothecary: false, fanFactor: 4, assistantCoaches: 5, cheerleaders: 6,
      players: [
        { number: 2, name: "B", position: "Lineman", skills: [], injuries: ["-MA"], spp: 6, currentValue: 50000, movement: 6, strength: 3, agility: 3, passing: 4, armour: 9, mng: true, secret: "x" } as never,
        { number: 1, name: "A", position: "Blitzer", skills: ["Block"], injuries: [], spp: 0, currentValue: 90000, movement: 7, strength: 3, agility: 3, passing: 4, armour: 9, mng: false } as never,
      ],
    });
    expect(r.players.map((p) => p.number)).toEqual([1, 2]);
    expect(Object.keys(r.players[1]!).sort()).toEqual(["ag", "av", "injuries", "ma", "mng", "name", "number", "pa", "position", "skills", "spp", "st", "value"]);
  });

  it("origin policy: configured origins, else same host; no Origin header = not a browser", () => {
    expect(lobbyAllowedOriginsFromEnv({ SUPER_WS_ALLOWED_ORIGINS: "https://Play.example.test/, bad url", DISCORD_OAUTH_REDIRECT_URI: "https://auth.example.test/api/auth/discord/callback" }))
      .toEqual(["https://play.example.test", "https://auth.example.test"]);
    const allowed = ["https://play.example.test"];
    expect(lobbyOriginAllowed("https://play.example.test", "x", allowed)).toBe(true);
    expect(lobbyOriginAllowed("https://evil.example.test", "play.example.test", allowed)).toBe(false);
    expect(lobbyOriginAllowed(undefined, "x", allowed)).toBe(true);
    expect(lobbyOriginAllowed("http://127.0.0.1:4310", "127.0.0.1:4310", [])).toBe(true);
    expect(lobbyOriginAllowed("http://sibling.localhost:4310", "127.0.0.1:4310", [])).toBe(false);
    expect(lobbyOriginAllowed("null", "127.0.0.1:4310", [])).toBe(false);
  });
});
