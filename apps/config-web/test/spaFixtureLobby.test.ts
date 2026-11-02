import { describe, expect, it } from "vitest";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { createFixtureLobby, draftOf, draftTotal, leagueLobbyPath, mySide, picksOf, tournamentLobbyPath, type LobbyView } from "../spa/src/leagues/lobby";
import { fixtureOpenForLobby } from "../spa/src/leagues/fixtureNav";

// SPA fixture lobby controller (spa/src/leagues/lobby.ts) against a mocked Fetcher: the inducement draft, Lock, the
// Auto-Buy hold notice, the presence heartbeat (insiders only) and the poll timers. Fake data only.

const menu = [{ id: "staff", label: "Staff & extras", items: [{ id: "bribes", name: "Bribes", price: 100_000, max: 3, icon: "", effect: "" }, { id: "bloodweiser_kegs", name: "Kegs", price: 50_000, max: 2, icon: "", effect: "" }], off: [] }];
const view = (role: string, over: Partial<LobbyView> = {}): LobbyView => ({
  viewer: { role, signedIn: role !== "spectator", organiser: false, canChat: true, canStart: false, canForce: false },
  sides: {
    home: { inducements: { picks: [{ id: "bribes", name: "Bribes", qty: 1, cost: 100_000 }], menu } },
    away: { inducements: { picks: null, menu } },
  },
  ...over,
}) as unknown as LobbyView;

function fetcher(routes: Record<string, unknown>) {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? "GET";
    calls.push({ path, method, body: init?.body });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) throw new ApiError(404, `no mock ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  }) as Fetcher;
  return { f, calls };
}
const B = "/api/leagues/alpha/seasons/season-1/fixtures/f1/lobby";
const timers = () => { const set: Array<() => void> = []; return { set, t: { setInterval: (fn: () => void) => { set.push(fn); return set.length; }, clearInterval: () => undefined } }; };

describe("fixture lobby controller", () => {
  it("helpers: draft totals, picks, the lobby path, my side, and which fixture rows get a Lobby link", () => {
    expect(draftTotal(menu, { bribes: 1, bloodweiser_kegs: 2 })).toBe(200_000);
    expect(picksOf({ bribes: 1, bloodweiser_kegs: 0 })).toEqual([{ id: "bribes", qty: 1 }]);
    expect(draftOf([{ id: "bribes", name: "Bribes", qty: 2, cost: 0 }])).toEqual({ bribes: 2 });
    expect(leagueLobbyPath("alpha", "season-1", "f 1")).toBe("/leagues/alpha/seasons/season-1/fixtures/f%201/lobby");
    expect(mySide(view("away"))).toBe("away");
    expect(mySide(view("organiser"))).toBe("home");
    const side = (coachId?: string, score: number | null = null) => ({ team: "T", coach: "C", race: "Orc", score, cas: null, conceded: false, ...(coachId ? { coachId } : {}) });
    const f = { id: "f", category: "", phase: "", phaseId: "", group: "", round: 1, table: 1, suspended: false, home: side("A"), away: side("B") };
    expect(fixtureOpenForLobby(f as never)).toBe(true);
    expect(fixtureOpenForLobby({ ...f, away: side() } as never)).toBe(false);
    expect(fixtureOpenForLobby({ ...f, home: side("A", 2), away: side("B", 1) } as never)).toBe(false);
  });

  it("the draft seeds from the server, edits mark it dirty (polls keep it), and Lock sends the draft with lock: true", async () => {
    const { f, calls } = fetcher({ [`GET ${B}`]: view("home"), [`POST ${B}/inducements`]: { lobby: view("home"), held: true, banner: "Bob spent 100K." }, [`POST ${B}/presence`]: { ok: true } });
    const { set, t } = timers();
    const lobby = createFixtureLobby({ api: f, timers: t });
    await lobby.load("alpha", "season-1", "f1");
    expect(lobby.state.draft).toEqual({ bribes: 1 });
    lobby.setCount("bloodweiser_kegs", 1);
    expect(lobby.state.dirty).toBe(true);
    await lobby.refresh();
    expect(lobby.state.draft).toEqual({ bribes: 1, bloodweiser_kegs: 1 });
    lobby.start();
    expect(set).toHaveLength(2); // poll + heartbeat
    await lobby.lock("home");
    expect(calls.find((c) => c.path === `${B}/inducements`)?.body).toEqual({ side: "home", picks: [{ id: "bribes", qty: 1 }, { id: "bloodweiser_kegs", qty: 1 }], lock: true });
    expect(lobby.state.dirty).toBe(false);
    expect(lobby.state.notice).toBe("Bob spent 100K.");
    expect(calls.some((c) => c.path === `${B}/presence`)).toBe(true);
  });

  it("a tournament scheduled match: its own SPA path and API base (match ids carry colons)", async () => {
    const id = "t1:round:1:match:2";
    expect(tournamentLobbyPath("t1", id)).toBe("/tournaments/t1/fixtures/t1%3Around%3A1%3Amatch%3A2/lobby");
    const T = `/api/tournaments/t1/fixtures/${encodeURIComponent(id)}/lobby`;
    const { f, calls } = fetcher({ [`GET ${T}`]: view("home"), [`POST ${T}/roster`]: { lobby: view("home") } });
    const lobby = createFixtureLobby({ api: f, timers: timers().t });
    await lobby.loadTournament("t1", id);
    expect(lobby.state.view?.viewer.role).toBe("home");
    await lobby.roster(true);
    expect(calls.find((c) => c.path === `${T}/roster`)?.body).toEqual({ locked: true });
  });

  it("a spectator never sends a heartbeat; a refused action shows the server's reason", async () => {
    const { f, calls } = fetcher({ [`GET ${B}`]: view("spectator"), [`POST ${B}/start`]: new ApiError(409, "Bob is not ready.") });
    const lobby = createFixtureLobby({ api: f, timers: timers().t });
    await lobby.load("alpha", "season-1", "f1");
    await lobby.heartbeat();
    expect(calls.some((c) => c.path.endsWith("/presence"))).toBe(false);
    expect(await lobby.startMatch()).toBeNull();
    expect(lobby.state.actionError).toBe("Bob is not ready.");
  });
});
