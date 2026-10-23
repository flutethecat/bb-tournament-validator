import { describe, expect, it } from "vitest";
import { Matchmaker } from "@bb/fork-ops";
import { LobbyStore, lobbyApi, lobbyRosterFromDetail, seatJnlpUrl, cleanChatText, type LobbyApiDeps, type LobbyRoster } from "../src/lobby";

const DIGEST: Record<string, string> = { alice: "a".repeat(32), bob: "b".repeat(32), carol: "c".repeat(32) };
const TEAMS: Record<string, Record<string, { teamName: string; race: string }>> = {
  alice: { t1: { teamName: "Alice Orcs", race: "Orc" } },
  bob: { t2: { teamName: "Bob Elves", race: "Wood Elf" } },
  carol: { t3: { teamName: "Carol Dwarfs", race: "Dwarf" } },
};

function setup(opts: { banned?: string[]; scheduleFails?: boolean } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const scheduled: Array<[string, string]> = [];
  const verified: Array<[string, string]> = [];
  const matchmaker = new Matchmaker({
    now,
    ttlMs: 10 * 60 * 1000,
    scheduleGame: async (home, away) => {
      scheduled.push([home, away]);
      if (opts.scheduleFails) throw new Error("fork down");
      return { gameId: "4242" };
    },
    // the fork-DB verification the live host runs: the digest must be the coach's stored one
    verifyChallenger: async (coach, digest) => {
      verified.push([coach, digest]);
      return DIGEST[coach.toLowerCase()] === digest;
    },
  });
  const store = new LobbyStore({
    matchmaker,
    now,
    digestFor: async (coach) => DIGEST[coach.toLowerCase()],
    isBanned: (coach) => (opts.banned ?? []).includes(coach.toLowerCase()),
    resolveTeam: (coach, teamId) => {
      const t = TEAMS[coach.toLowerCase()]?.[teamId];
      return t ? { teamId, ...t } : { error: `Team ${teamId} isn't in ${coach}'s library.`, status: 400 };
    },
  });
  matchmaker.onPaired((p) => store.notePairing(p));
  return { store, matchmaker, scheduled, verified, advance: (ms: number) => { clock += ms; } };
}

describe("LobbyStore: a view over the matchmaker", () => {
  it("create = the creator's challenge (stored digest); join = the counter-challenge, which schedules once", async () => {
    const { store, matchmaker, scheduled, verified } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(matchmaker.pendingOf("alice")).toMatchObject({ coach: "Alice", teamId: "t1", opponent: "Bob" });
    expect(verified).toEqual([["Alice", DIGEST.alice]]);
    expect(store.view(lobby, "Alice").status).toBe("waiting");
    expect(store.inbox("Bob")).toEqual([expect.objectContaining({ coach: "Alice", lobbyId: lobby.id })]);

    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toHaveLength(1);
    const v = store.view(store.get(lobby.id)!, "Bob");
    expect(v.status).toBe("ready");
    expect(v.game).toEqual({ gameName: expect.stringMatching(/^chal_/), gameId: "4242" });
    expect(v.opponent.team).toMatchObject({ teamId: "t2", teamName: "Bob Elves" });
    expect(matchmaker.pendingOf("Alice")).toBeUndefined();
    // a second join is idempotent: no second schedule
    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toHaveLength(1);
  });

  it("the opponent creating against an open lobby joins it instead of opening a second one", async () => {
    const { store, scheduled } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    const again = await store.create("bob", "t2", "alice");
    expect(again.id).toBe(lobby.id);
    expect(scheduled).toHaveLength(1);
    expect(store.listFor("Bob")).toHaveLength(1);
  });

  it("a client-side challenge already waiting pairs at once when the lobby opens", async () => {
    const { store, matchmaker, scheduled } = setup();
    await matchmaker.challenge({ coach: "Bob", teamId: "t2", opponent: "Alice", passwordMd5: DIGEST.bob });
    expect(store.inbox("Alice")).toEqual([expect.objectContaining({ coach: "Bob" })]);
    expect(store.inbox("Alice")[0]!.lobbyId).toBeUndefined();
    const lobby = await store.create("Alice", "t1", "Bob");
    expect(scheduled).toHaveLength(1);
    expect(store.view(lobby, "Alice").status).toBe("ready");
  });

  it("a lapsed creator challenge is re-entered from the lobby on join; a challenge to someone else blocks it", async () => {
    const { store, matchmaker, scheduled, advance } = setup();
    const lobby = await store.create("Alice", "t1", "Bob");
    advance(11 * 60 * 1000); // past the matchmaker's 10 min TTL, well inside the lobby's 24 h
    expect(matchmaker.pendingOf("Alice")).toBeUndefined();
    expect(store.view(store.get(lobby.id)!, "Alice").status).toBe("lapsed");
    await store.join(lobby.id, "Bob", "t2");
    expect(scheduled).toHaveLength(1);

    const second = await store.create("Alice", "t1", "Carol");
    await matchmaker.challenge({ coach: "Alice", teamId: "t1", opponent: "Bob", passwordMd5: DIGEST.alice });
    await expect(store.join(second.id, "Carol", "t3")).rejects.toMatchObject({ status: 409 });
  });

  it("schedule failure still pairs on the gameName fallback (no gameId)", async () => {
    const { store } = setup({ scheduleFails: true });
    const lobby = await store.create("Alice", "t1", "Bob");
    await store.join(lobby.id, "Bob", "t2");
    expect(store.view(store.get(lobby.id)!, "Alice").game).toEqual({ gameName: expect.any(String), gameId: null });
  });

  it("bans block create (either side), join and launch", async () => {
    const a = setup({ banned: ["alice"] });
    await expect(a.store.create("Alice", "t1", "Bob")).rejects.toMatchObject({ status: 403 });
    const b = setup({ banned: ["bob"] });
    await expect(b.store.create("Alice", "t1", "Bob")).rejects.toMatchObject({ status: 403 });
    expect(b.matchmaker.pendingOf("Alice")).toBeUndefined();
  });

  it("validates: self-challenge, unknown team, only the opponent may join", async () => {
    const { store } = setup();
    await expect(store.create("Alice", "t1", "alice")).rejects.toMatchObject({ status: 400 });
    await expect(store.create("Alice", "nope", "Bob")).rejects.toMatchObject({ status: 400 });
    const lobby = await store.create("Alice", "t1", "Bob");
    await expect(store.join(lobby.id, "Alice", "t1")).rejects.toMatchObject({ status: 409 });
    await expect(store.join(lobby.id, "Carol", "t3")).rejects.toMatchObject({ status: 403 });
    await expect(store.join(lobby.id, "Bob", "t1")).rejects.toMatchObject({ status: 400 });
  });

  it("expires 24 h after creation (410 afterwards), or 1 h after the first launch", async () => {
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

  it("presence: not here yet -> here (heartbeat or socket) -> left -> in the client", async () => {
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
    advance(60_000);
    expect(state("bob")).toBe("here");
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
    expect(store.history(lobby.id).at(-1)!.text).toBe("m249");
    expect(cleanChatText("   ")).toBeNull();
    expect(cleanChatText("x".repeat(900))).toHaveLength(500);
  });

  it("close withdraws the creator's challenge", async () => {
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
  function deps(store: LobbyStore, ratingCalls: string[] = []): LobbyApiDeps {
    return {
      store,
      roster: (coach, teamId) => (coach === "Bob" && teamId === "t2" ? roster : undefined),
      coachCard: (coach) => ({ avatar: coach === "Bob" ? "https://cdn.discordapp.com/avatars/1/x.png" : null, fumbblName: coach === "Bob" ? "BobOnFumbbl" : null }),
      rating: async (name) => { ratingCalls.push(name); return { name, cr: 150.2, record: { w: 3, d: 1, l: 2 }, war: 0.5 }; },
      chatLive: () => true,
    };
  }
  const call = (d: LobbyApiDeps, method: string, path: string, coach: string | undefined, body?: unknown, q = "") =>
    lobbyApi(method, path, new URLSearchParams(q), coach ? { coach } : undefined, body, d);

  it("401 without a session; non-lobby paths fall through", async () => {
    const { store } = setup();
    expect(await call(deps(store), "GET", "/api/lobby", undefined)).toMatchObject({ status: 401 });
    expect(await call(deps(store), "GET", "/api/other", "Alice")).toBeUndefined();
  });

  it("create -> list/inbox -> join -> launch returns each seat's own JNLP params", async () => {
    const { store } = setup();
    const d = deps(store);
    const created = await call(d, "POST", "/api/lobby", "Alice", { teamId: "t1", opponent: "Bob" });
    expect(created!.status).toBe(201);
    const id = (created!.body as { lobby: { id: string } }).lobby.id;
    expect(await call(d, "POST", "/api/lobby", "Alice", { coach: "Carol", teamId: "t1", opponent: "Bob" })).toMatchObject({ status: 403 });

    const list = await call(d, "GET", "/api/lobby", "Bob");
    expect((list!.body as { challenges: Array<{ lobbyId?: string }> }).challenges[0]!.lobbyId).toBe(id);

    expect(await call(d, "POST", `/api/lobby/${id}/launch`, "Alice")).toMatchObject({ status: 409 });
    expect(await call(d, "POST", `/api/lobby/${id}/join`, "Bob", { teamId: "t2" })).toMatchObject({ status: 200 });

    const a = await call(d, "POST", `/api/lobby/${id}/launch`, "Alice");
    const b = await call(d, "POST", `/api/lobby/${id}/launch`, "Bob");
    const aUrl = new URL((a!.body as { jnlpUrl: string }).jnlpUrl, "http://x");
    const bUrl = new URL((b!.body as { jnlpUrl: string }).jnlpUrl, "http://x");
    expect(aUrl.pathname).toBe("/api/fork/jnlp");
    expect(Object.fromEntries(aUrl.searchParams)).toEqual({ coach: "Alice", teamId: "t1", gameName: expect.stringMatching(/^chal_/), gameId: "4242" });
    expect(Object.fromEntries(bUrl.searchParams)).toMatchObject({ coach: "Bob", teamId: "t2", gameId: "4242" });
    expect((a!.body as { scheme: unknown }).scheme).toBeNull();
    expect(aUrl.search).not.toMatch(/password/i);
    expect(await call(d, "POST", `/api/lobby/${id}/launch`, "Carol")).toMatchObject({ status: 403 });
  });

  it("state + rosters + coach card: members only, roster fields only, 'not shared yet' before a pick", async () => {
    const { store } = setup();
    const d = deps(store);
    const id = ((await call(d, "POST", "/api/lobby", "Alice", { teamId: "t1", opponent: "Bob" }))!.body as { lobby: { id: string } }).lobby.id;
    expect(await call(d, "GET", `/api/lobby/${id}`, "Carol")).toMatchObject({ status: 403 });
    expect(await call(d, "GET", `/api/lobby/${id}/roster`, "Alice", undefined, "role=opponent")).toEqual({ status: 200, body: { shared: false, roster: null } });
    await call(d, "POST", `/api/lobby/${id}/join`, "Bob", { teamId: "t2" });
    expect(await call(d, "GET", `/api/lobby/${id}/roster`, "Alice", undefined, "role=opponent")).toEqual({ status: 200, body: { shared: true, roster } });
    expect(await call(d, "GET", `/api/lobby/${id}/coach`, "Alice", undefined, "role=opponent")).toEqual({
      status: 200, body: { coach: "Bob", avatar: "https://cdn.discordapp.com/avatars/1/x.png", fumbblName: "BobOnFumbbl" },
    });
    const state = await call(d, "GET", `/api/lobby/${id}`, "Alice");
    expect(state!.body).toMatchObject({ chatLive: true, lobby: { me: "creator", status: "ready" } });
    expect(await call(d, "GET", "/api/lobby/zz", "Alice")).toMatchObject({ status: 404 });
  });

  it("coach-rating proxies the injected (cached) fetch", async () => {
    const { store } = setup();
    const calls: string[] = [];
    const d = deps(store, calls);
    expect(await call(d, "GET", "/api/coach-rating", "Alice", undefined, "name=BobOnFumbbl")).toMatchObject({ status: 200, body: { rating: { cr: 150.2 } } });
    expect(await call(d, "GET", "/api/coach-rating", "Alice")).toMatchObject({ status: 400 });
    expect(calls).toEqual(["BobOnFumbbl"]);
  });

  it("410 for an expired lobby", async () => {
    const { store, advance } = setup();
    const d = deps(store);
    const id = ((await call(d, "POST", "/api/lobby", "Alice", { teamId: "t1", opponent: "Bob" }))!.body as { lobby: { id: string } }).lobby.id;
    advance(25 * 60 * 60 * 1000);
    expect(await call(d, "GET", `/api/lobby/${id}`, "Alice")).toMatchObject({ status: 410, body: { error: "This lobby has expired." } });
  });
});

describe("helpers", () => {
  it("seatJnlpUrl omits gameId on the fallback", () => {
    expect(seatJnlpUrl({ coach: "A b", teamId: "1", gameName: "chal_x" })).toBe("/api/fork/jnlp?coach=A+b&teamId=1&gameName=chal_x");
  });
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
});
