import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
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
    const [app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/tabletop/recorder.ts"),
      vite.ssrLoadModule("/src/tabletop/list.ts"),
      vite.ssrLoadModule("/src/tabletop/queue.ts"),
      vite.ssrLoadModule("/src/tabletop/organiser.ts"),
      vite.ssrLoadModule("/src/tabletop/standings.ts"),
      vite.ssrLoadModule("/src/tabletop/coachSearch.ts"),
      vite.ssrLoadModule("/src/tabletop/feed.ts"),
      vite.ssrLoadModule("/src/components/TabletopOther.vue"),
      vite.ssrLoadModule("/src/components/TabletopRosters.vue"),
      vite.ssrLoadModule("/src/components/TabletopPregame.vue"),
      vite.ssrLoadModule("/src/components/TabletopFeed.vue"),
      vite.ssrLoadModule("/src/components/TabletopScoreboard.vue"),
      vite.ssrLoadModule("/src/components/TabletopPick.vue"),
    ]);
    mods = { app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC };
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
    events: [{ id: "e1", sppEarned: 3 }, { id: "e4", sppEarned: 1 }],
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
      const ctrl = mods.list.createTabletopList({
        api: fetcher({
          "/api/tabletop/matches": { matches: [baseMatch("submitted")] },
          "/api/tabletop/saves?coach=Alice": { coach: "Alice", teams: [
            { ref: "library:1263233", name: "Alice Orcs", race: "Orc", tv: 1000000 },
            { ref: "save:sv_9", name: "Alice Draft", race: "Orc", tv: 950000 },
          ] },
        }),
        coach: () => "Alice", onSignedOut: () => undefined,
      });
      await ctrl.refresh();
      await ctrl.loadMyTeams();
      spa.app.provide(mods.list.TABLETOP_LIST_KEY, ctrl);
    });
    expect(html).toContain("New match");
    expect(html).toContain("Alice Orcs (Orc, TV 1,000k) · Library");
    expect(html).toContain("Alice Draft (Orc, TV 950k) · Builder save");
    expect(html).toContain('value="library:1263233"');
        expect(html).toContain("Type 2 or more letters");
    expect(html).toContain("Pick an opponent first");
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
        if (path.startsWith("/api/tabletop/saves")) return { coach: "Bob", teams: [{ ref: "save:t2", name: "Bob Elves", race: "Wood Elf", tv: 1000000 }] };
        return { match: baseMatch("recording") };
      }) as Fetcher,
      coach: () => "Alice", onSignedOut: () => undefined,
    });
    expect(await ctrl.lookupSaves(" Bob ")).toEqual([{ ref: "save:t2", name: "Bob Elves", race: "Wood Elf", tv: 1000000 }]);
    expect(await ctrl.create({ myTeam: "library:1263233", opponent: " Bob ", theirTeam: "save:t2", postMatch: "spp-only" })).toBe("tm_abc123");
    expect(calls).toEqual([
      ["/api/tabletop/saves?coach=Bob", "GET", undefined],
      ["/api/tabletop/matches", "POST", { home: { coach: "Alice", team: "library:1263233" }, away: { coach: "Bob", team: "save:t2" }, postMatch: "spp-only" }],
    ]);
  });

  /** Renders one component on its own (SSR) with props, from the same module graph as the app. */
  const mount = async (comp: { default: unknown }, props: Record<string, unknown>, provide?: (app: any) => void): Promise<string> => {
    const app = createSSRApp(comp.default as object, props);
    provide?.(app);
    return (await mods.renderer.renderToString(app)) as string;
  };

  it("recorder (recording): scoreboard, scrolling feed and TD / Other / CAS regions, rows from the server's events", async () => {
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally });
    // layout regions, in order: scoreboard, feed, action bar
    const i = (t: string): number => html.indexOf(t);
    expect(i('class="tt-board"')).toBeGreaterThan(-1);
    expect(i('class="tt-feed"')).toBeGreaterThan(i('class="tt-board"'));
    expect(i('class="tt-actions-bar"')).toBeGreaterThan(i('class="tt-feed"'));
    expect(html).toContain("<span>TD</span>");
    expect(html).toContain("<span>Other</span>");
    expect(html).toContain("<span>CAS</span>");
    // scoreboard: both coach corners and the centre
    expect(html).toContain("Alice Orcs");
    expect(html).toContain("Bob Elves");
    expect(html).toContain("<span>1</span> : <span>0</span>");
    expect(html).toContain("H1 T1");
    expect(html).toContain("Rosters");
    expect(html).toContain('href="/app/tabletop"'); // the back button
    // feed rows: the client log sentence, SPP stars, undo trash; the undone TD is gone
    expect(html).toContain("Grob #1</span> scores a touchdown.");
    expect(html).toContain("(&#9733;3)".replace("&#9733;", "\u2605"));
    expect(html).toContain("Lirael #7</span> completes a pass.");
    expect(html).toContain('aria-label="Undo Touchdown"');
    expect(html.match(/data-type="touchdown"/g)).toHaveLength(1); // the undone TD has no row
    expect(html).not.toContain("waiting");
    expect(html).not.toContain("Undo revision");
    expect(html).not.toContain("Submit match"); // submitting is part of End of match
  });

  it("layout: scoreboard and the three buttons stay fixed, only the feed scrolls (css structure)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-rec \{[^}]*position: fixed; inset: 0/);
    expect(css).toMatch(/grid-template-rows: minmax\(150px, 20dvh\) minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.tt-feed \{[^}]*overflow-y: auto; -webkit-overflow-scrolling: touch/);
    expect(css).toMatch(/\.tt-big \{[^}]*aspect-ratio: 1 \/ 1/); // squares, not a third of the screen
    expect(css).not.toMatch(/\.tt-actions-bar \{[^}]*dvh/);
    expect(css).toMatch(/\.tt-big \{[^}]*min-height: 64px/);
    expect(css).toMatch(/\.tt-actions-bar \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    expect(css).toMatch(/\.tt-other \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: 12px/);
    expect(css).toMatch(/\.tt-modal-box \{[^}]*width: calc\(100% - 16px\)/);
    expect(css).toMatch(/\.tt-ev\[data-row-side="home"\] \{[^}]*margin-right/); // home rows start left
    expect(css).toMatch(/\.tt-ev\[data-row-side="away"\] \{[^}]*margin-left/); // away rows start right
  });

  it("Other popup lists 12 events (3 columns x 4 rows) with the client glyphs; TD, CAS and MVP have their own steps", async () => {
    const html = await mount(mods.otherC, {});
    const labels = ["Injury", "Completion", "Catch", "Throw Team-mate", "Interception", "Foul", "Sent-off", "Stalling", "Secret Objectives", "Weather", "Concede match", "End of match"];
    expect(mods.feedMod.OTHER_EVENTS).toHaveLength(12);
    expect(12 / 3).toBe(4); // four rows of three
    for (const l of labels) expect(html, l).toContain(`<span>${l}</span>`);
    for (const l of ["Touchdown", "Casualty", "MVP"]) expect(html, l).not.toContain(`<span>${l}</span>`);
    expect(html.match(/class="tt-other-btn"/g)).toHaveLength(12);
    expect(html).toContain("/icons/ui/action-pass.png");
    expect(html).toContain("/icons/ui/action-foul.png");
    expect(html).toContain("/icons/ui/status-stalling.png");
    expect(html).toContain("/icons/ui/status-catch.png");
  });

  it("feed rows: team tints, inducement and pre-game rows (neutral rows for match-level lines), no undo on pre-game rolls", async () => {
    const evs = [
      { id: "p1", type: "fans", team: "home", payload: { home: 5, away: 2 } },
      { id: "p2", type: "weather", team: "home", payload: { name: "Nice" } },
      { id: "p3", type: "inducement", team: "away", payload: { id: "bribes", name: "Bribes", qty: 2 } },
      { id: "p4", type: "coinFlip", team: "home", payload: { mode: "auto", result: "tails" } },
      { id: "p5", type: "inducement", team: "home", payload: { picks: [{ id: "bribes", qty: 2 }], total: 100000, skipped: false } },
      { id: "p6", type: "inducement", team: "away", payload: { picks: [], total: 0, skipped: true } },
      { id: "e1", type: "touchdown", team: "home", player: "h1", payload: {}, half: 1, turn: 3 },
    ];
    const rows = mods.feedMod.feedRows(evs, evs.map((e) => e.id), teams);
    const html = await mount(mods.feedC, { rows, canUndo: true });
    expect(html).toContain('data-type="inducement"');
    expect(html).toContain("Bob Elves</span> buys 2 x Bribes.");
    expect(html).toMatch(/data-row-side="neutral" data-type="coinFlip"/);
    expect(html).toMatch(/data-row-side="neutral" data-type="weather"/);
    expect(html).toMatch(/data-row-side="away" data-type="inducement"/);
    expect(html).toMatch(/data-row-side="home" data-type="touchdown"/);
    expect(html).toContain("buys 2 x bribes.");
    expect(html).toContain("buys no inducements.");
    expect(html).toContain("H1 T3");
    expect(html).toContain('aria-label="Undo Touchdown"');
    expect(html).not.toContain('aria-label="Undo Fans"');
    expect(html).not.toContain('aria-label="Undo Inducement"');
  });

  it("Rosters popout renders both teams from the server's team files", async () => {
    const rich = {
      home: { name: "Alice Orcs", treasury: 120000, players: [
        { id: "h1", name: "Grob", number: 1, spp: 6, mng: false, dead: false, positionName: "Blitzer", ma: 6, st: 3, ag: 3, pa: null, av: 9, skills: ["Block", "Dodge"] },
        { id: "h2", name: "Snaga", number: 2, positionId: "lineman", spp: 0, mng: true, dead: false },
      ] },
      away: { name: "Bob Elves", players: [{ id: "a1", name: "Lirael", number: 7, positionId: "catcher", spp: 3, mng: false, dead: false, niggles: 1 }] },
    };
    const html = await mount(mods.rostersC, { match: baseMatch("recording"), teams: rich, tally: serverTally });
    for (const t of ["Rosters", "Alice Orcs", "Bob Elves", "1/2", "1/1", "Grob", "Blitzer", "Block", "Dodge", "MNG", "Treasury 120k", "<small>MA</small>6", "<small>ST</small>3", "<small>AG</small>3+", "<small>PA</small>-", "<small>AV</small>9+", "9 SPP", "(+3)"])
      expect(html, t).toContain(t);
    expect(html).toContain("lineman"); // a team file without a position name falls back to the position id
    expect(html).toContain("<small>MA</small>-"); // stats the team file lacks show a dash
  });

  it("scoreboard: crest, inducement icons with qty badge, weather in the centre, no coin result", async () => {
    const evs = [{ id: "i1", type: "inducement", team: "home", payload: { id: "bribes", name: "Bribes", qty: 2 } }];
    const html = await mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, rosterId: "orc", dedicatedFans: 5 }, away: teams.away }, tally: serverTally,
      events: evs, pregame: { weather: "Nice", coin: { result: "heads", winner: "home" } }, half: 2, turn: 5,
      inducementIcons: { bribes: "icons/inducements/bribe.png" }, art: { crests: { crests: { orc: "crests/orc.png" } } },
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(html).toContain('src="/crests/orc.png"');
    expect(html).toContain("/icons/inducements/bribe.png");
    expect(html).toContain("/icons/ui/dedicated_fans.png");
    expect(html).toContain('<b class="tt-qty">2</b>');
    expect(html).toContain("Nice");
    expect(html).toContain("H2 T5");
    expect(html).not.toMatch(/heads|tails/i);
  });

  it("theme toggle: dark by default, remembered SNES grey from storage", async () => {
    const dark = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: [], teams, tally: serverTally });
    expect(dark.html).toContain('data-tt-theme="dark"');
    expect(dark.html).toContain(">SNES grey</button>");
    (globalThis as any).localStorage = { store: { "tabletop-theme": "snes" }, getItem(k: string) { return this.store[k] ?? null; }, setItem(k: string, v: string) { this.store[k] = v; }, removeItem() {} };
    try {
      const snes = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: [], teams, tally: serverTally });
      expect(snes.html).toContain('data-tt-theme="snes"');
      expect(snes.html).toContain(">Dark</button>");
    } finally { delete (globalThis as any).localStorage; }
  });

  const pregameProps = (phase: string, pregame: Record<string, unknown> = {}) => ({ match: baseMatch("recording"), teams, phase, pregame, busy: false, error: "" });

  it("pre-game wizard: a server-rolled step shows its result and one roll button per phase", async () => {
    for (const [phase, label] of [["fans", "Roll fans"], ["weather", "Roll weather"], ["journeymen", "Roll journeymen"], ["prayers", "Roll prayers to nuffle"]]) {
      const html = await mount(mods.pregameC, pregameProps(`pregame:${phase}`, { fans: "Home 5, Away 2" }));
      expect(html, phase).toContain(label);
      expect(html, phase).toContain("The server rolls this and records the result.");
      expect(html, phase).toContain('data-state="now"');
    }
    const later = await mount(mods.pregameC, pregameProps("pregame:weather", { fans: "Home 5, Away 2" }));
    expect(later).toContain("Home 5, Away 2"); // the earlier result, from the server
  });

  it("pre-game wizard: inducements per team with Skip, from the server's options", async () => {
    const html = await mount(mods.pregameC, pregameProps("pregame:inducements", {
      inducementOptions: { home: [{ id: "bribes", name: "Bribes", cost: 100000, max: 3 }], away: [] },
    }));
    expect(html).toContain("Bribes");
    expect(html).toContain("100k");
    expect(html).toContain("Submit Alice Orcs");
    expect(html).toContain("Submit Bob Elves"); // one phone submits both teams
    expect(html).toContain("No inducements offered.");
    expect(html.match(/>Skip</g)).toHaveLength(2);
    const again = await mount(mods.pregameC, pregameProps("pregame:inducements", { inducements: { home: { picks: [] } }, inducementOptions: { home: [{ id: "bribes", name: "Bribes", max: 3 }], away: [] } }));
    expect(again).toContain("Resubmit Alice Orcs"); // a resubmission replaces
    expect(again).toContain("Submit Bob Elves");
  });

  it("coin flipper: opens on Heads / Tails, no coin yet; hand entry is a small link at the bottom", async () => {
    const html = await mount(mods.pregameC, pregameProps("pregame:coin"));
    expect(html).toContain("Bob calls the toss");
    expect(html).toContain("Heads ");
    expect(html).toContain("Tails ");
    expect(html).not.toContain('class="tt-coin"');
    expect(html).toContain("Rolled a real coin? Enter the result");
    expect(html.indexOf("Rolled a real coin?")).toBeGreaterThan(html.indexOf("Tails"));
    expect(html).not.toContain("Record hand-rolled result"); // not a peer button
  });

  it("coin flipper: the animation lands on the server's face, then the winner picks Kick / Receive", async () => {
    for (const result of ["heads", "tails"]) {
      const html = await mount(mods.pregameC, pregameProps("pregame:coin", { coin: { result, call: "heads", winner: "away" } }));
      expect(html).toContain(`data-result="${result}"`);
      expect(html).toContain(`${result.toUpperCase()} - Bob Elves wins the toss`);
      expect(html).toContain("Bob Elves kicks");
      expect(html).toContain("Bob Elves receives");
      expect(html).not.toContain("calls the toss");
    }
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toContain(".tt-coin[data-result=\"tails\"] { animation-name: tt-coin-flip-tails; }");
    expect(css).toContain("rotateX(1800deg)"); // 5 turns = heads up
    expect(css).toContain("rotateX(1980deg)"); // 5.5 turns = tails up
  });

  it("coin flipper posts the call, then the choice with the server's winner", async () => {
    const posts: unknown[] = [];
    let coin: Record<string, unknown> | undefined;
    const api = (async (path: string, init: { method?: string; body?: any } = {}) => {
      if (init.method === "POST") {
        posts.push([path, init.body]);
        if (init.body.call && !init.body.choice) coin = { result: "tails", call: init.body.call, winner: "home" };
        return { match: baseMatch("recording") };
      }
      return { match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, phase: "pregame:coin", pregame: coin ? { coin } : {} };
    }) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await rec.refresh();
    await rec.advance({ mode: "auto", call: "heads" });
    expect(rec.state.pregame.coin).toEqual({ result: "tails", call: "heads", winner: "home" });
    await rec.advance({ mode: "auto", call: "heads", winner: "home", choice: "kick" });
    expect(posts).toEqual([
      ["/api/tabletop/matches/tm_abc123/pregame/advance", { mode: "auto", call: "heads" }],
      ["/api/tabletop/matches/tm_abc123/pregame/advance", { mode: "auto", call: "heads", winner: "home", choice: "kick" }],
    ]);
    rec.stop();
  });

  it("fixtures: Your fixtures lists the server's fixtures, empty state, and a fixture creates a match from the ref alone", async () => {
    const fx = { fixtureRef: "fx1", tournament: { id: "t1", name: "Autumn Cup" }, round: 2, home: { coach: "Alice", teamName: "Alice Orcs" }, away: { coach: "Bob" } };
    const withFixtures = async (rows: unknown[]) => render("/tabletop", { "/api/auth/session": session() }, async (spa) => {
      const ctrl = mods.list.createTabletopList({ api: fetcher({ "/api/tabletop/fixtures": rows }), coach: () => "Alice", onSignedOut: () => undefined });
      await ctrl.loadFixtures();
      spa.app.provide(mods.list.TABLETOP_LIST_KEY, ctrl);
    });
    const some = await withFixtures([fx]);
    expect(some.html).toContain("Your fixtures");
    expect(some.html).toContain("Autumn Cup");
    expect(some.html).toContain("round 2");
    expect(some.html).toContain("Alice Orcs (Alice) vs Bob (Bob)");
    expect(some.html.indexOf("Your fixtures")).toBeLessThan(some.html.indexOf("Casual match"));
    expect((await withFixtures([])).html).toContain("No fixtures scheduled for you.");
    const posts: unknown[] = [];
    const ctrl = mods.list.createTabletopList({
      api: (async (path: string, init: { method?: string; body?: unknown } = {}) => { posts.push([path, init.body]); return { match: baseMatch("recording") }; }) as Fetcher,
      coach: () => "Alice", onSignedOut: () => undefined,
    });
    expect(await ctrl.createFromFixture("fx1", "full")).toBe("tm_abc123");
    expect(posts).toEqual([["/api/tabletop/matches", { fixtureRef: "fx1", postMatch: "full" }]]);
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

  it("edit mode is behind a flag (off): no pencil, no edit bar, no trash; undo stays on the last-events control", async () => {
    expect(mods.feedMod.EDIT_MODE_ENABLED).toBe(false);
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally });
    expect(html).not.toContain("tt-pencil");
    expect(html).not.toContain("You are in edit mode.");
    expect(html).not.toContain("tt-trash");
    expect(html).toContain('aria-label="Last events"');
    expect(html).toContain('aria-label="Undo Touchdown"');
  });

  it("pick list opens on the local coach side and offers the other team as a toggle; picks post the player id", async () => {
    const open = (localSide: string) => mount(mods.pickC, {
      kind: mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams, unavailable: () => "", localSide,
    });
    const away = await open("away");
    expect(away).toMatch(/data-active="true"[^>]*><span class="tt-roster-tab-name">Bob Elves/);
    expect(away).toContain("Lirael");
    expect(away).not.toContain("Grob");
    expect(away).toContain("Alice Orcs"); // the other team is one tap away
    const home = await open("home");
    expect(home).toMatch(/data-active="true"[^>]*><span class="tt-roster-tab-name">Alice Orcs/);
    expect(home).toContain("Grob");
    // the pick posts the player id
    expect(mods.feedMod.pickSpec(mods.feedMod.TD_EVENT, "away", "a1")).toEqual({ type: "touchdown", team: "away", player: "a1" });
    expect(away).toContain("tt-pick-row");
  });

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

  it("coach type-ahead: waits 250 ms after 2+ characters, one query with q, limit=10 and coach=<me>", async () => {
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const paths: string[] = [];
    const s = mods.coachSearch.createCoachSearch({
      api: (async (path: string) => { paths.push(path); return { coaches: ["Bobby", "bobcat"] }; }) as Fetcher,
      coach: () => "Alice Q",
      setTimer: (fn: () => void, ms: number) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
      clearTimer: (h: { live: boolean }) => { h.live = false; },
    });
    s.input("b");
    expect(timers).toHaveLength(0); // under 2 characters: nothing scheduled
    s.input("bo");
    s.input("bob");
    expect(timers.filter((t) => t.live).map((t) => t.ms)).toEqual([250]); // the first debounce was cancelled
    expect(paths).toEqual([]);
    timers.find((t) => t.live)!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(paths).toEqual(["/api/fork/coaches?q=bob&limit=10&coach=Alice%20Q"]);
    expect(s.state.matches).toEqual(["Bobby", "bobcat"]);
  });

  it("coach type-ahead: empty answer, server error text, and a stale answer is dropped", async () => {
    let reply: () => unknown = () => ({ coaches: [] });
    const timers: Array<() => void> = [];
    const s = mods.coachSearch.createCoachSearch({
      api: (async () => { const r = reply(); if (r instanceof Error) throw r; return r; }) as Fetcher,
      coach: () => "Alice", setTimer: (fn: () => void) => { timers.push(fn); return timers.length; }, clearTimer: () => undefined,
    });
    s.input("zz");
    timers.pop()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.searched).toBe(true);
    expect(s.state.matches).toEqual([]);
    reply = () => new ApiError(503, "Fork DB not configured on this host (set FORK_DB_HOST).");
    s.input("zzz");
    timers.pop()!();
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.error).toContain("Fork DB not configured");
    let release: (v: unknown) => void = () => undefined;
    reply = () => new Promise((r) => { release = r; }) as never;
    s.input("abc");
    const run = timers.pop()!;
    reply = () => ({ coaches: ["Old"] });
    run();
    s.input("abcd"); // text moved on before the first answer lands
    release({ coaches: ["Stale"] });
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state.matches).not.toContain("Stale");
  });

  it("new-match form renders matches as tap rows, 'No coaches match', and the server error", async () => {
    const withState = (patch: Record<string, unknown>) => render("/tabletop", { "/api/auth/session": session() }, (spa) => {
      const s = mods.coachSearch.createCoachSearch({ api: fetcher({}), coach: () => "Alice" });
      Object.assign(s.state, patch);
      spa.app.provide(mods.coachSearch.COACH_SEARCH_KEY, s);
    });
    const rows = await withState({ query: "bo", matches: ["Bobby", "Bobcat"] });
    expect(rows.html).toContain(">Bobby</button>");
    expect(rows.html).toContain(">Bobcat</button>");
    expect(rows.html).toContain('class="lobby-btn tt-tap tt-match"');
    expect((await withState({ query: "zz", searched: true })).html).toContain("No coaches match");
    expect((await withState({ query: "zz", error: "Fork DB not configured on this host (set FORK_DB_HOST)." })).html).toContain("Fork DB not configured");
  });
});
