import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { backoffMs, BATCH_SIZE, createEventQueue, memoryStorage, type WireEvent } from "../spa/src/tabletop/queue";

// Tabletop recorder in the SPA: the pure event queue (de-dup / batching / backoff / refusals) and the server-rendered
// routes, loaded through the SPA's own Vite config like spaShell.test.ts (no port is opened, no jsdom).

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

const ev = (id: string, extra: Partial<WireEvent> = {}): WireEvent => ({ id, type: "touchdown", team: "home", player: "p1", payload: {}, ts: "2026-10-23T10:00:00.000Z", ...extra });

describe("event queue", () => {
  const make = (send: (e: WireEvent[]) => Promise<{ accepted: string[]; duplicates: string[]; total: number }>, storage = memoryStorage()) => {
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const q = createEventQueue({
      matchId: "m1", storage, send, now: () => 1000,
      setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimer: () => undefined,
    });
    return { q, timers, storage };
  };
  const ok = async (e: WireEvent[]) => ({ accepted: e.map((x) => x.id), duplicates: [], total: e.length });

  it("backoff doubles from 2 s and caps at 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(backoffMs)).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("de-duplicates by id on enqueue and sends in batches of at most 100", async () => {
    const sent: number[] = [];
    const { q } = make(async (e) => { sent.push(e.length); return ok(e); });
    expect(q.enqueue(ev("event-0001"))).toBe(true);
    expect(q.enqueue(ev("event-0001"))).toBe(false);
    for (let i = 0; i < 249; i++) q.enqueue(ev(`bulk-${String(i).padStart(4, "0")}`));
    expect(q.pendingCount()).toBe(250);
    await q.flush();
    expect(sent).toEqual([BATCH_SIZE, BATCH_SIZE, 50]);
    expect(q.pendingCount()).toBe(0);
  });

  it("a network failure keeps the events, schedules a backoff retry, and the retry re-sends the same ids", async () => {
    let fail = true;
    const seen: string[][] = [];
    const { q, timers, storage } = make(async (e) => {
      seen.push(e.map((x) => x.id));
      if (fail) throw new ApiError(0, "Can't reach the server. Check your connection.");
      return ok(e);
    });
    q.enqueue(ev("event-0001"));
    await q.flush();
    expect(q.pendingCount()).toBe(1);
    expect(q.status.lastError).toContain("Can't reach");
    expect(timers.map((t) => t.ms)).toEqual([2000]);
    expect(storage.getItem("tabletop-queue:m1")).toContain("event-0001");
    await q.flush();
    expect(timers.map((t) => t.ms)).toEqual([2000, 4000]);
    fail = false;
    timers[1]!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(q.pendingCount()).toBe(0);
    expect(seen.every((s) => s.join() === "event-0001")).toBe(true);
    expect(storage.getItem("tabletop-queue:m1")).toBeNull();
  });

  it("restores unsent events from storage (a reload while offline)", () => {
    const storage = memoryStorage();
    storage.setItem("tabletop-queue:m1", JSON.stringify([ev("event-0009")]));
    expect(make(ok, storage).q.pendingCount()).toBe(1);
    const broken = memoryStorage();
    broken.setItem("tabletop-queue:m1", "{not json");
    expect(make(ok, broken).q.pendingCount()).toBe(0);
  });

  it("a storage that throws still queues in memory", async () => {
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    const { q } = make(ok, throwing);
    q.enqueue(ev("event-0001"));
    expect(q.pendingCount()).toBe(1);
    await q.flush();
    expect(q.pendingCount()).toBe(0);
  });

  it("a refused batch is isolated: the good events send, the refused one is reported", async () => {
    const accepted: string[] = [];
    const { q } = make(async (e) => {
      if (e.some((x) => x.id === "event-bad1")) throw new ApiError(400, "event event-bad1: player p9 is dead.");
      accepted.push(...e.map((x) => x.id));
      return ok(e);
    });
    q.enqueue(ev("event-0001"));
    q.enqueue(ev("event-bad1"));
    q.enqueue(ev("event-0003"));
    await q.flush();
    expect(accepted).toEqual(["event-0001", "event-0003"]);
    expect(q.pendingCount()).toBe(0);
    expect(q.rejected.map((r) => r.event.id)).toEqual(["event-bad1"]);
    expect(q.rejected[0]!.error).toContain("is dead");
  });

  it("a 403 halts retries (no timer) and keeps the events", async () => {
    const { q, timers } = make(async () => { throw new ApiError(403, "You are not a participant in this match."); });
    q.enqueue(ev("event-0001"));
    await q.flush();
    expect(q.pendingCount()).toBe(1);
    expect(q.status.halted).toBe(true);
    expect(timers).toHaveLength(0);
  });

  it("discard drops a not-yet-sent event", () => {
    const { q } = make(ok);
    q.enqueue(ev("event-0001"));
    expect(q.discard("event-0001")).toBe(true);
    expect(q.discard("event-0001")).toBe(false);
    expect(q.pendingCount()).toBe(0);
  });
});

describe("tabletop routes (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, rec, list, queue, organiser, standings] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/tabletop/recorder.ts"),
      vite.ssrLoadModule("/src/tabletop/list.ts"),
      vite.ssrLoadModule("/src/tabletop/queue.ts"),
      vite.ssrLoadModule("/src/tabletop/organiser.ts"),
      vite.ssrLoadModule("/src/tabletop/standings.ts"),
    ]);
    mods = { app, vueRouter, renderer, rec, list, queue, organiser, standings };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const session = (extra: Record<string, unknown> = {}) => ({ authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true, ...extra });

  const fetcher = (routes: Record<string, unknown>): Fetcher =>
    (async (path: string, init: { method?: string } = {}) => {
      const key = `${init.method ?? "GET"} ${path}`;
      const hit = routes[key] ?? routes[path];
      if (hit === undefined) throw new ApiError(404, `no mock for ${key}`);
      if (hit instanceof Error) throw hit;
      return typeof hit === "function" ? (hit as () => unknown)() : hit;
    }) as Fetcher;

  async function render(path: string, routes: Record<string, unknown>, setup?: (spa: any, f: Fetcher) => Promise<void> | void) {
    const f = fetcher(routes);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await setup?.(spa, f);
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: (await mods.renderer.renderToString(spa.app)) as string, spa };
  }

  const player = (id: string, name: string, number: number, extra: Record<string, unknown> = {}) => ({ id, name, number, spp: 0, mng: false, dead: false, ...extra });
  const baseMatch = (state: string, extra: Record<string, unknown> = {}) => ({
    id: "tm_abc123", state, postMatch: "full", createdBy: "Alice", confirmations: {},
    home: { coach: "Alice", teamSaveId: "t1", teamName: "Alice Orcs" },
    away: { coach: "Bob", teamSaveId: "t2", teamName: "Bob Elves" },
    ...extra,
  });
  const teams = {
    home: { name: "Alice Orcs", players: [player("h1", "Grob", 1), player("h2", "Snaga", 2, { mng: true })] },
    away: { name: "Bob Elves", players: [player("a1", "Lirael", 7), player("a2", "Faen", 8)] },
  };
  const events = [
    { id: "e1", type: "touchdown", team: "home", player: "h1", payload: {} },
    { id: "e2", type: "touchdown", team: "home", player: "h1", payload: {} },
    { id: "e3", type: "undo", team: "home", payload: { target: "e2" } },
    { id: "e4", type: "completion", team: "away", player: "a1", payload: {} },
  ];
  const line = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    id, name, touchdowns: 0, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 0, ...extra,
  });
  const serverTally = {
    score: { home: 1, away: 0 }, fanDelta: { home: 0, away: 0 },
    casualtiesSuffered: { home: { bh: 0, si: 0, rip: 0 }, away: { bh: 0, si: 0, rip: 0 } },
    players: { home: [line("h1", "Grob", { touchdowns: 1, sppEarned: 3 })], away: [line("a1", "Lirael", { completions: 1, sppEarned: 1 })] },
  };
  const summary = (side: string, extra: Record<string, unknown> = {}) => ({
    postMatch: "full", applied: true, team: side, score: { for: side === "home" ? 1 : 0, against: side === "home" ? 0 : 1 },
    outcome: side === "home" ? "won" : "lost", deaths: [], winnings: 70000, treasuryBefore: 50000, treasuryAfter: 120000, fansBefore: 3, fansAfter: 4,
    players: [{ id: "x", name: side === "home" ? "Grob" : "Lirael", touchdowns: 1, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 3 }],
    ...extra,
  });

  /** Renders /tabletop/:id with a recorder already loaded from `body` (SSR never runs onMounted). */
  async function renderMatch(body: Record<string, unknown>, sess = session(), pendingEvents: WireEvent[] = []) {
    const routes = { "/api/auth/session": sess, "/api/tabletop/matches/tm_abc123": body };
    return render("/tabletop/tm_abc123", routes, async (spa, f) => {
      const storage = mods.queue.memoryStorage();
      if (pendingEvents.length) storage.setItem("tabletop-queue:tm_abc123", JSON.stringify(pendingEvents));
      const recorder = mods.rec.createRecorder("tm_abc123", { api: f, onSignedOut: () => undefined, storage });
      await recorder.refresh();
      spa.app.provide(mods.rec.RECORDER_KEY, () => recorder);
    });
  }

  it("signed out: /tabletop and /tabletop/:id show the sign-in prompt, never the recorder", async () => {
    for (const path of ["/tabletop", "/tabletop/tm_abc123"]) {
      const { html } = await render(path, { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
      expect(html, path).toContain("Login with Discord");
      expect(html, path).toContain(`next=${encodeURIComponent(`/app${path}`)}`);
      expect(html, path).not.toContain("New match");
    }
    const pw = await render("/tabletop", { "/api/auth/session": { authenticated: true, coach: "Pw", authMethod: "password", discordSsoEnabled: true } });
    expect(pw.html).toContain("This page needs a Discord sign-in.");
  });

  it("nav has a Tabletop entry", async () => {
    const { html } = await render("/tabletop", { "/api/auth/session": session() });
    expect(html).toContain(">Tabletop</a>");
  });

  it("new-match form: my team, opponent lookup, their save picker, post-match options; my matches from the server", async () => {
    const { html } = await render("/tabletop", { "/api/auth/session": session() }, async (spa) => {
      spa.library.teams.value = [{ teamId: "t1", teamName: "Alice Orcs", race: "Orc", teamValue: 1000000 }];
      const ctrl = mods.list.createTabletopList({
        api: fetcher({ "/api/tabletop/matches": { matches: [baseMatch("submitted")] } }), coach: () => "Alice", onSignedOut: () => undefined,
      });
      await ctrl.refresh();
      spa.app.provide(mods.list.TABLETOP_LIST_KEY, ctrl);
    });
    expect(html).toContain("New match");
    expect(html).toContain("Alice Orcs (Orc");
    expect(html).toContain('placeholder="Coach name"');
    expect(html).toContain("Find their teams");
    expect(html).toContain("Find their teams first");
    expect(html).toContain("SPP only");
    expect(html).toContain("Full post-match");
    expect(html).toContain("None (record the score only)");
    expect(html).toContain("Alice Orcs vs Bob Elves");
    expect(html).toContain("Waiting for confirmation");
    expect(html).not.toContain("re-roll");
  });

  it("lookup and create: saves come from the server, home = me, away = the opponent", async () => {
    const calls: unknown[] = [];
    const ctrl = mods.list.createTabletopList({
      api: (async (path: string, init: { method?: string; body?: unknown } = {}) => {
        calls.push([path, init.method ?? "GET", init.body]);
        if (path.startsWith("/api/tabletop/saves")) return { coach: "Bob", saves: [{ id: "t2", name: "Bob Elves" }] };
        return { match: baseMatch("recording") };
      }) as Fetcher,
      coach: () => "Alice", onSignedOut: () => undefined,
    });
    expect(await ctrl.lookupSaves(" Bob ")).toEqual([{ id: "t2", name: "Bob Elves" }]);
    expect(await ctrl.create({ mySaveId: "t1", opponent: " Bob ", theirSaveId: "t2", postMatch: "spp-only" })).toBe("tm_abc123");
    expect(calls).toEqual([
      ["/api/tabletop/saves?coach=Bob", "GET", undefined],
      ["/api/tabletop/matches", "POST", { home: { coach: "Alice", teamSaveId: "t1" }, away: { coach: "Bob", teamSaveId: "t2" }, postMatch: "spp-only" }],
    ]);
  });

  it("recorder (recording): both teams, per-player controls, fan change, undo list, score and SPP from the server's events", async () => {
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally });
    for (const label of ["Grob", "Snaga", "Lirael", "Faen", "+TD", "+CAS", "+Comp", "+Int", "+Defl", "MVP", "Send off", "Fan change", "Submit match", "Undo", "Last events"])
      expect(html, label).toContain(label);
    expect(html).toContain("Home: Alice Orcs (Alice)");
    expect(html).toContain("Away: Bob Elves (Bob)");
    expect(html).toContain("<span>1</span> : <span>0</span>");
    expect(html).toContain("+3 SPP"); // Grob: one effective touchdown (the second was undone)
    expect(html).toContain("+1 SPP"); // Lirael: one completion
    expect(html).toContain("(MNG)"); // Snaga cannot act
    expect(html).not.toContain("waiting");
    expect(html).not.toContain("Undo revision");
  });

  it("recorder: the 'n events waiting' chip shows queued events that the server has not accepted", async () => {
    const queued = [
      { id: "event-q001", type: "touchdown", team: "away", player: "a1", payload: {}, ts: "2026-10-23T10:00:00.000Z" },
      { id: "event-q002", type: "completion", team: "away", player: "a2", payload: {}, ts: "2026-10-23T10:00:01.000Z" },
    ] as WireEvent[];
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: [], teams, tally: serverTally }, session(), queued);
    expect(html).toContain("2 events waiting");
    expect(html).toContain("<span>1</span> : <span>0</span>"); // the score still follows the server only
  });

  it("recorder (submitted): preview of both teams, per-coach confirmation state and a Confirm button for a coach", async () => {
    const body = {
      match: baseMatch("submitted", { confirmations: { Bob: "2026-10-23T10:05:00.000Z" }, preview: { home: summary("home"), away: summary("away") } }),
      events, effectiveEventIds: [], teams,
    };
    const { html } = await renderMatch(body);
    expect(html).toContain("Won 1-0");
    expect(html).toContain("Lost 0-1");
    expect(html).toContain("winnings 70k");
    expect(html).toContain("Alice: not confirmed yet");
    expect(html).toMatch(/Bob: confirmed \d/);
    expect(html).toContain(">Confirm<");
    expect(html).not.toContain("Submit match");
    expect(html).not.toContain("Undo revision");

    const done = await renderMatch({ ...body, match: { ...body.match, confirmations: { Alice: "2026-10-23T10:06:00.000Z", Bob: "2026-10-23T10:05:00.000Z" } } });
    expect(done.html).toContain("Waiting for your opponent.");
    expect(done.html).not.toContain(">Confirm<");
  });

  it("recorder (confirmed): a coach sees the result, only an organiser session sees Undo revision", async () => {
    const body = {
      match: baseMatch("confirmed", { confirmations: { Alice: "2026-10-23T10:06:00.000Z", Bob: "2026-10-23T10:05:00.000Z" }, preview: { home: summary("home"), away: summary("away") } }),
      events, effectiveEventIds: [], teams,
    };
    const coach = await renderMatch(body);
    expect(coach.html).toContain("Both coaches confirmed.");
    expect(coach.html).not.toContain("Undo revision");
    const org = await renderMatch(body, session({ organizer: true }));
    expect(org.html).toContain("Undo revision");
  });

  it("recorder: posts events with a client uuid through the queue and refreshes from the server", async () => {
    const posted: Array<{ events: Array<{ id: string; type: string; team: string; player: string }> }> = [];
    let served = { match: baseMatch("recording"), events: [] as unknown[], effectiveEventIds: [] as string[], teams, tally: serverTally };
    const api = (async (path: string, init: { method?: string; body?: any } = {}) => {
      if (init.method === "POST") {
        posted.push(init.body);
        served = { ...served, events: init.body.events.map((e: any) => ({ ...e })), effectiveEventIds: init.body.events.map((e: any) => e.id) };
        return { accepted: init.body.events.map((e: any) => e.id), duplicates: [], total: 1 };
      }
      return served;
    }) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await rec.refresh();
    await rec.record({ type: "touchdown", team: "home", player: "h1" });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.events[0]!.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(rec.state.pending).toBe(0);
    expect(rec.state.events).toHaveLength(1);
    expect(rec.state.tally.score.home).toBe(1); // straight from the server answer
    await rec.undo(rec.state.events[0]);
    expect(posted[1]!.events[0]).toMatchObject({ type: "undo", team: "home", payload: { target: posted[0]!.events[0]!.id } });
    rec.stop();
  });

  const orgMatch = (id: string, extra: Record<string, unknown> = {}) => ({
    id, state: "confirmed", pendingOrganiser: true, home: { coach: "Alice", teamName: "Alice Orcs" }, away: { coach: "Bob", teamName: "Bob Elves" },
    score: { home: 2, away: 1 }, confirmations: { Alice: "2026-10-23T10:06:00.000Z" }, ...extra,
  });

  async function renderOrganiser(sess: Record<string, unknown>) {
    return render("/tabletop/organiser", { "/api/auth/session": sess }, async (spa, f) => {
      const ctrl = mods.organiser.createOrganiser({ api: f, onSignedOut: () => undefined });
      ctrl.state.tournaments = [{ id: "tour1", name: "Autumn Cup", currentRound: 3 }];
      ctrl.state.tournament = "tour1";
      ctrl.state.round = 2;
      ctrl.state.loaded = true;
      ctrl.state.matches = [orgMatch("tm_a1"), orgMatch("tm_a2", { pendingOrganiser: false, state: "published" })];
      ctrl.state.selected = ["tm_a1"];
      ctrl.state.results = { tm_a2: { id: "tm_a2", ok: false, error: "Already published." } };
      spa.app.provide(mods.organiser.ORGANISER_KEY, ctrl);
    });
  }

  it("organiser console: hidden unless the session is an organiser", async () => {
    const no = await renderOrganiser(session());
    expect(no.html).toContain("Organiser access only.");
    expect(no.html).not.toContain("Confirm &amp; publish selected");
    const yes = await renderOrganiser(session({ organizer: true }));
    for (const t of ["Autumn Cup", "Round 3", "Alice Orcs vs Bob Elves", "2-1", "Pending", "Confirm &amp; publish selected", "Reopen selected", "Note (optional)", "Already published.", "Export CSV"])
      expect(yes.html, t).toContain(t);
    expect(yes.html).toContain('href="/api/tabletop/organiser/export?tournament=tour1&amp;round=2"');
    expect(yes.html).toContain("Alice: ");
  });

  it("organiser controller: bulk posts ids, action and note, shows per-id results, then reloads the round", async () => {
    const posts: unknown[] = [];
    const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
      if (init.method === "POST") { posts.push([path, init.body]); return { results: [{ id: "tm_a1", ok: true }, { id: "tm_a2", ok: false, error: "Not submitted." }] }; }
      return { matches: [orgMatch("tm_a1", { state: "published", pendingOrganiser: false })] };
    }) as Fetcher;
    const c = mods.organiser.createOrganiser({ api, onSignedOut: () => undefined });
    await c.choose("tour1", 2);
    c.toggle("tm_a1"); c.toggle("tm_a2");
    c.state.note = " fixed typo ";
    await c.bulk("confirm-publish");
    expect(posts).toEqual([["/api/tabletop/organiser/bulk", { ids: ["tm_a1", "tm_a2"], action: "confirm-publish", note: "fixed typo" }]]);
    expect(c.state.results.tm_a2.error).toBe("Not submitted.");
    expect(c.state.matches[0].state).toBe("published");
    expect(c.state.selected).toEqual(["tm_a1"]);
  });

  it("standings route: server rows with W/D/L, TD and CAS differences, points", async () => {
    const row = { coach: "Alice", played: 3, won: 2, drawn: 1, lost: 0, tdFor: 6, tdAgainst: 3, tdDiff: 3, casFor: 2, casAgainst: 4, casDiff: -2, points: 7 };
    const { html } = await render("/standings?league=Autumn", { "/api/auth/session": { authenticated: false } }, async (spa, f) => {
      const st = mods.standings.createStandings({ api: fetcher({ "/api/standings?league=Autumn": { league: "Autumn", rows: [row] } }) });
      await st.load("Autumn");
      spa.app.provide(mods.standings.STANDINGS_KEY, st);
      void f;
    });
    for (const t of ["Standings", "Alice", "TD +/-", "CAS +/-", "+3", "-2", "<strong>7</strong>"]) expect(html, t).toContain(t);
    expect(html).not.toContain("Sign in with Discord to use this page."); // public read, no gate
  });
});
