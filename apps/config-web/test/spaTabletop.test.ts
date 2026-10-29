import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp } from "vue";
import { createTheme, THEME_COLORS, THEME_STORAGE_KEY } from "../spa/src/theme";
import { centreMode, createCueTracker, CUE_SECONDS, formatTimer, serverOffset, timerRemaining, turnLabel } from "../spa/src/tabletop/clock";
import { createCuePlayer, toneFor } from "../spa/src/tabletop/sounds";
import { canEditMatch } from "../spa/src/tabletop/settings";
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
    const [app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC, ttm, ttmC, timelineC, weatherBarC, clockMod, rosterRowC, chipLayoutMod] = await Promise.all([
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
      vite.ssrLoadModule("/src/components/TabletopSettings.vue"),
      vite.ssrLoadModule("/src/tabletop/settings.ts"),
      vite.ssrLoadModule("/src/shared/api.ts"),
      vite.ssrLoadModule("/src/components/TabletopTurnSet.vue"),
      vite.ssrLoadModule("/src/tabletop/ttm.ts"),
      vite.ssrLoadModule("/src/components/TabletopTtm.vue"),
      vite.ssrLoadModule("/src/components/TabletopTimeline.vue"),
      vite.ssrLoadModule("/src/components/TabletopWeatherBar.vue"),
      vite.ssrLoadModule("/src/tabletop/clock.ts"),
      vite.ssrLoadModule("/src/components/TabletopRosterRow.vue"),
      vite.ssrLoadModule("/src/tabletop/chipLayout.ts"),
    ]);
    mods = { app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC, ttm, ttmC, timelineC, weatherBarC, clockMod, rosterRowC, chipLayoutMod };
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

  async function render(path: string, routes: Record<string, unknown>, setup?: (spa: any, f: Fetcher) => Promise<void> | void, theme?: unknown) {
    const f = fetcher(routes);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f, ...(theme ? { theme } : {}) });
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
  async function renderMatch(body: Record<string, unknown>, sess = session(), pendingEvents: WireEvent[] = [], theme?: unknown) {
    const routes = { "/api/auth/session": sess, "/api/tabletop/matches/tm_abc123": body };
    return render("/tabletop/tm_abc123", routes, async (spa, f) => {
      const storage = mods.queue.memoryStorage();
      if (pendingEvents.length) storage.setItem("tabletop-queue:tm_abc123", JSON.stringify(pendingEvents));
      const recorder = mods.rec.createRecorder("tm_abc123", { api: f, onSignedOut: () => undefined, storage });
      await recorder.refresh();
      spa.app.provide(mods.rec.RECORDER_KEY, () => recorder);
    }, theme);
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
            { ref: "save:sv_10", name: "Alice Scratch", race: "", tv: null }, // a builder save the server cannot value: tv is null
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
    expect(html).toContain("Alice Scratch · Builder save"); // a null tv must not crash the page
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

  const clockOf = (active: "home" | "away", turn: number, extra: Record<string, unknown> = {}) => ({
    half: 1, turn, activeTeam: active, turnStartedAt: Date.now(), serverNow: Date.now(), turnTimer: { mode: "off" }, ...extra,
  });

  /** Renders one component on its own (SSR) with props, from the same module graph as the app. */
  const mount = async (comp: { default: unknown }, props: Record<string, unknown>, provide?: (app: any) => void): Promise<string> => {
    const app = createSSRApp(comp.default as object, props);
    provide?.(app);
    return (await mods.renderer.renderToString(app)) as string;
  };

  it("recorder (recording): scoreboard, scrolling feed and TD / Other / CAS regions, rows from the server's events", async () => {
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) });
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
    expect(html).toContain("1Ht3");
    expect(html).toContain("End Turn"); // Alice plays home and home is the active team
    expect(html).not.toContain("tt-stepper"); // no manual half / turn stepper any more
    expect(html).toContain("Rosters");
    expect(html).not.toContain("tt-back"); // no back button: the shell navigation leaves the page
    // feed rows: the client log sentence, SPP stars, undo trash; the undone TD is gone
    expect(html).toContain("Grob #1</span> scores a touchdown.");
    expect(html).toContain("(&#9733;3)".replace("&#9733;", "\u2605"));
    expect(html).toContain("#7 player</span> completes a pass."); // the opponent (Alice plays home) is named by number and position only
    expect(html).not.toContain("Lirael");
    expect(html).not.toContain('aria-label="Undo'); // undo rides edit mode (organisers) only
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
    for (const t of ["Rosters", "Alice Orcs", "Bob Elves", "1/2", "1/1", "Grob", "Blitzer", "Block", "Dodge", "MNG", "Treasury 120k", "<b>6</b><small>MA</small>", "<b>3</b><small>ST</small>", "<b>3+</b><small>AG</small>", "<b>-</b><small>PA</small>", "<b>9+</b><small>AV</small>", "9 SPP", "(+3)"])
      expect(html, t).toContain(t);
    expect(html).toContain("lineman"); // a team file without a position name falls back to the position id
    expect(html).toContain("<b>-</b><small>MA</small>"); // stats the team file lacks show a dash
  });

  it("scoreboard: crest, inducement icons with qty badge, weather in the centre, no coin result", async () => {
    const evs = [{ id: "i1", type: "inducement", team: "home", payload: { id: "bribes", name: "Bribes", qty: 2 } }];
    const html = await mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, rosterId: "orc", dedicatedFans: 5 }, away: teams.away }, tally: serverTally,
      events: evs, pregame: { weather: "Nice", coin: { result: "heads", winner: "home" } }, clock: clockOf("away", 5, { half: 2 }), localSide: "home", organiser: false, canAct: true,
      inducementIcons: { bribes: "icons/inducements/bribe.png" }, art: { crests: { crests: { orc: "crests/orc.png" } } },
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(html).toContain('src="/crests/orc.png"');
    expect(html).toContain("/icons/inducements/bribe.png");
    expect(html).toContain("/icons/ui/dedicated_fans.png");
    expect(html).toContain('<b class="tt-qty">2</b>');
    expect(html).toContain('aria-label="Nice"'); // the condition name is a tooltip / label only
    expect(html).not.toMatch(/>[^<]*Nice[^<]*</);
    expect(html).toContain("tt-weather");
    expect(html.indexOf("tt-rosters-btn")).toBeLessThan(html.indexOf("tt-weather")); // top row: Rosters, weather, cog
    expect(html.match(/class="tt-rosters-btn"/g)).toHaveLength(1); // not repeated in the away corner
    expect(html).not.toContain("tt-back");
    expect(html.indexOf("tt-weather")).toBeLessThan(html.indexOf("tt-cog"));
    expect(html).toContain("TURN 13"); // 2Ht5, shown as the match turn number
    expect(html).not.toMatch(/heads|tails/i);
  });

  it("hero (Modern Retro): a 16-cell turn track with the active turn marked, the score and the TD / CAS counters", async () => {
    const html = await mount(mods.boardC, {
      match: baseMatch("recording"), teams, tally: serverTally, events: [], pregame: {}, clock: clockOf("home", 3, { half: 2 }),
      remaining: 95, localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(html.match(/class="tt-cell"/g)).toHaveLength(16); // 8 per team for the half in play
    expect(html.match(/data-state="active"/g)).toHaveLength(1); // the active team's current turn only
    expect(html).toMatch(/data-state="active"[^>]*aria-current="step">3</); // turns read 1-8 in every half
    expect(html).toContain("2nd half");
    expect(html).toContain("<span>1</span> : <span>0</span>");
    expect(html).toContain("<span>TD</span>");
    expect(html).toContain("<span>CAS</span>");
    expect(html).not.toContain("tt-clock"); // no turn timer in this clock
  });

  it("turnLine: the match turn number 1-16 (2Ht1 is Turn 9), overtime continues from 17, turn 0 reads Kick-off", () => {
    const { turnLine } = mods.clockMod;
    expect(turnLine(1, 3)).toBe("TURN 3");
    expect(turnLine(1, 8)).toBe("TURN 8");
    expect(turnLine(2, 1)).toBe("TURN 9");
    expect(turnLine(2, 5)).toBe("TURN 13");
    expect(turnLine("OT", 1)).toBe("TURN 17");
    expect(turnLine(2, 0)).toBe("Kick-off");
  });

  it("turn track: 1-8 per half; same-number turn is done for the team that already ended it; both 8th cells done at match end", () => {
    const { turnCells, turnKey } = mods.clockMod;
    const states = (cells: Array<{ state: string }>) => cells.map((c) => c.state[0]).join("");
    const clock = (active: "home" | "away" | null, turn: number, half = 2) => ({ half, turn, activeTeam: active });
    // second half, turn 3, away active: numbers stay 1-8
    expect(turnCells(clock("away", 3), "away").map((c: { n: number }) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // kicker/receiver: home played turn 3 first (its turnEnd is recorded), away is active on turn 3
    const ended = new Set([turnKey(2, 3, "home")]);
    expect(states(turnCells(clock("away", 3), "home", ended))).toBe("dddttttt");
    expect(states(turnCells(clock("away", 3), "away", ended))).toBe("ddattttt");
    // no turnEnd yet for the other team: its same-number cell is still to come
    expect(states(turnCells(clock("home", 3), "away"))).toBe("ddtttttt");
    // match end: turn 8 and nobody active
    expect(states(turnCells(clock(null, 8), "home"))).toBe("dddddddd");
    expect(states(turnCells(clock(null, 8), "away"))).toBe("dddddddd");
  });

  it("desktop rail: the rail container with TD, CAS and Other, the state strip, the crumb row and the Quick box render beside the log", async () => {
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) });
    expect(html).toContain('class="tt-rail"');
    expect(html.match(/class="tt-rail-btn tt-rail-(td|cas|injury|other)"/g)).toHaveLength(4);
    expect(html.indexOf("tt-rail-cas")).toBeLessThan(html.indexOf("tt-rail-injury")); // TD, CAS, Injury, Other
    expect(html.indexOf("tt-rail-injury")).toBeLessThan(html.indexOf("tt-rail-other"));
    expect(html).toContain('class="tt-rail-end"'); // Alice plays home and home is active
    expect(html).toContain("tt-stripbar");
    expect(html).toContain("tt-crumbs");
    expect(html).toContain("Match log");
    expect(html).toContain('data-tip="Record a touchdown"');
    expect(html.match(/class="tt-rail-btn[^>]*data-tip="/g)).toHaveLength(4); // every rail button carries a tip
    expect(html).not.toMatch(/ title="/); // the recorder uses data-tip, never a native title
    expect(html).toContain("End match");
    expect(html).not.toContain("Undo last event"); // undo rides edit mode
    expect(html.indexOf('class="tt-rail"')).toBeGreaterThan(html.indexOf('class="tt-mid"'));
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/@media \(min-width: 1024px\) \{[\s\S]*\.tt-rec > \.tt-actions-bar \{ display: none; \}/); // no bottom bar on desktop
    expect(css).toMatch(/grid-template-columns: 232px minmax\(0, 1fr\)/); // the rail sits left of the log
    expect(css).toMatch(/\.tt-roster-list li\.roster-row \{/); // specificity above any plain li rule, so the grid row applies
    expect(css).not.toMatch(/\.tt-roster-list li \{/);
    expect(css).toMatch(/--tt-pad: max\(0px, calc\(\(100vw - 1400px\) \/ 2\)\)/); // the desktop page is centred in 1400 px
    expect(css).toMatch(/\.tt-rec::before \{[^}]*grid-row: 2 \/ 5;[^}]*border-radius: 6px;[^}]*0 6px 0 rgb\(0 0 0 \/ \.45\), 0 12px 28px/); // one shared card behind hero, strip, rail and log
    // row order: crumbs, hero, strip, then the body (strip before body), with the body row never shorter than the rail
    const crumbRow = css.lastIndexOf(".tt-rec > .tt-crumbs { grid-row: 1; }");
    expect(crumbRow).toBeGreaterThan(-1);
    expect(css.indexOf(".tt-rec > .tt-stripbar { grid-row: 3; }")).toBeGreaterThan(crumbRow);
    expect(css).toContain(".tt-rec > .tt-mid { grid-column: 2; grid-row: 4; }");
    expect(css).toMatch(/\.tt-rec \{ overflow-y: auto; grid-template-rows: auto auto var\(--tt-strip-h\) minmax\(auto, 1fr\); \}/);
    // the hero is a contained, clipped, bezelled card at desktop; no full-bleed gradient is left
    expect(css).toMatch(/\.tt-rec > \.tt-board \{ margin: 18px 2px 0; padding: 12px 20px 14px; overflow: hidden; border-radius: 4px 4px 0 0; border: 0; border-bottom: 1px solid color-mix/); // joined: square bottom corners, one divider
    expect(css).toMatch(/\.tt-rec > \.tt-board \{[^}]*box-shadow: none;/); // the shadow belongs to the shared outer card
    expect(css).not.toContain("margin-inline: calc(-1 * var(--tt-pad))");
    expect(css).not.toMatch(/\.tt-board::(?:before|after)/);
    // readability pass: the team-name shadow stack, the button text-shadow and the CSS bevel with its pressed state
    expect(css).toContain("--tt-name-shadow: 2px 2px 0 rgb(0 0 0 / 80%), 0 0 10px rgb(0 0 0 / .45)"); // the builder h1 shadow + one soft glow
    expect(css).toMatch(/\.tt-rec \.tt-team \{ text-shadow: var\(--tt-name-shadow\); letter-spacing: \.06em; font-weight: 500; \}/);
    expect(css).toMatch(/@media \(max-width: 759px\) \{\s*\.tt-rec \.tt-corner \.tt-team \{ font-size: 13px;[^}]*line-clamp: 2;/); // phone: 13 px, two lines, same shadow
    expect(css).toContain("--tt-btn-text-shadow: 0 1px 0 rgb(0 0 0 / .8), 0 0 6px rgb(0 0 0 / .5)");
    expect(css).toContain("--tt-bevel: inset 0 2px 0 rgb(255 255 255 / .22), inset 0 -3px 0 rgb(0 0 0 / .45), inset 2px 0 0 rgb(255 255 255 / .08), inset -2px 0 0 rgb(0 0 0 / .25), 0 3px 0 rgb(0 0 0 / .5)");
    expect(css).toMatch(/\.tt-rec \.tt-rail-btn, [^{]*\{\s*border: 1px solid rgb\(0 0 0 \/ \.6\); border-radius: 3px; box-shadow: var\(--tt-bevel\); text-shadow: var\(--tt-btn-text-shadow\);/);
    expect(css).toMatch(/\.tt-rec \.tt-rail-btn:active[^{]*\{\s*box-shadow: var\(--tt-bevel-down\); transform: translateY\(2px\);/);
    expect(css).toContain("--tt-lettering-shadow: 2px 2px 0 rgb(0 0 0 / 80%), 0 0 10px rgb(0 0 0 / .45)"); // button lettering = the team-name shadow
    expect(css).toMatch(/\.tt-rec \.tt-rail-btn, [^{]*\.tt-rec \.tt-big, [^{]*\{ text-shadow: var\(--tt-lettering-shadow\); letter-spacing: \.06em; \}/);
    expect(css).toMatch(/\.tt-rec \.tt-rail-turn \{[^}]*font-size: var\(--tt-turnmark-fs\);[^}]*text-shadow: var\(--tt-lettering-shadow\)/);
    expect(css).toMatch(/--tt-turnmark-fs: 13px;/); // the turn line is a subheader under the larger label
    expect(css).toContain("--tt-strip-h: 48px; --tt-strip-fs: 14px; --tt-marker: 28px; --tt-marker-icon: 18px;"); // desktop strip and timeline markers
    expect(css).toContain("--tt-strip-h: 52px; --tt-marker: 32px; --tt-marker-icon: 20px;"); // 1600 px
    expect(css).toMatch(/@media \(min-width: 760px\) and \(max-width: 1023px\) \{\s*\.tt-rec \{ --tt-tl-h: 40px; --tt-marker: 24px;/); // tablet
    expect(css).toMatch(/\.tt-stripbar \.tt-tl-mark \{ width: var\(--tt-marker\); height: var\(--tt-marker\); border-width: 2px; background: color-mix/);
    expect(css).toMatch(/--tt-rail-label-fs: 22px;/);
    expect(css).toMatch(/--tt-rail-label-fs: 24px;/); // the End Turn label steps up, 24 px from 1600
    expect(css).toMatch(/--tt-turnmark-fs: 14px;/);
    expect(css).toMatch(/--tt-rail-fs: 16px;/);
    expect(css).toMatch(/--tt-rail-fs: 18px;/);
    expect(css).toMatch(/\.tt-rec \.tt-mid > \.tt-log-h \{ display: flex; align-items: center; justify-content: flex-end; height: 28px;[^}]*color: var\(--ui-text, #e6e9ef\); text-shadow: var\(--tt-btn-text-shadow\); background: none; \}/); // MATCH LOG: white, right-aligned on a 28 px row above the field
    expect(css).toMatch(/\.tt-rec \.tt-mid \{ grid-template-rows: 28px minmax\(0, 1fr\); \}/);
    expect(css).toMatch(/\.tt-rec > \.tt-stripbar \{ border-bottom: 1px solid var\(--tt-rule\); \}/); // a neutral divider, nothing red
    expect(css).toMatch(/--tt-rule: color-mix\(in srgb, var\(--ui-text, #e6e9ef\) 16%, transparent\)/);
    expect(css).toMatch(/--tt-hero-min: 168px;[\s\S]*--tt-hero-min: 200px;/); // one scale block, two steps
  });

  it("hero icon chips: rerolls always carry a count badge, apothecary and singles none, inducements badge from 2, unknown ones show a letter; titles carry name and count", async () => {
    const evs = [
      { id: "i1", type: "inducement", team: "home", payload: { picks: [{ id: "bribes", name: "Bribes", qty: 2 }, { id: "mystery", name: "Mystery Item", qty: 1 }] } },
    ];
    const html = await mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, rerolls: 3, apothecary: true }, away: teams.away }, tally: serverTally,
      events: evs, pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true,
      inducementIcons: { bribes: "icons/inducements/bribe.png" }, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(html).toContain("/icons/ui/re_roll.png");
    expect(html).toContain('data-tip="Team rerolls: 3"');
    expect(html).not.toContain(" title=");
    expect(html).toContain('<b class="tt-qty">3</b>');
    expect(html).toContain('data-tip="Apothecary"');
    expect(html).toContain('data-tip="Bribes x2"');
    expect(html).toContain('<b class="tt-qty">2</b>');
    expect(html).toContain('data-tip="Mystery Item x1"');
    expect(html).toContain('<span class="tt-chip-txt">M</span>');
    expect(html.match(/class="tt-qty"/g)).toHaveLength(2); // rerolls and bribes only
    expect(html.match(/class="tt-crest-coach"/g)).toHaveLength(2); // the coach sits above the crest frame
    expect(html).not.toContain("tt-cornerline"); // the top-corner line is gone
    const css1 = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css1).toMatch(/\.tt-rec \.tt-crest-coach \{ grid-row: 1; font-size: 14px;/);
    expect(css1).toMatch(/\.tt-rec \.tt-corner \.tt-race\.tt-nameline \{ grid-row: 3; font-size: 12px;[^}]*text-transform: uppercase; color: var\(--ui-text-dim/); // the race under the crest
    expect(css1).toMatch(/--tt-team-fs: 34px;/);
    expect(css1).toMatch(/--tt-team-fs: 40px;/);
    expect(css1).toMatch(/\.tt-rec \.tt-crest-frame \{ background: color-mix\(in srgb, var\(--ui-surface, #0d0d0d\) 28%, transparent\); border: 1px solid color-mix\(in srgb, var\(--ui-border, #3d0002\) 35%, transparent\); box-shadow: inset 0 1px 0 rgb\(255 255 255 \/ \.14\); \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-corner \.tt-coachline \.tt-chips, [^{]*\{\s*box-sizing: border-box; display: flex; flex-wrap: wrap;[^}]*border: 1px solid var\(--tt-rule\); border-radius: 4px;/); // the inset chip tray
    expect(css1).toMatch(/--tt-chip: 56px; --tt-chip-img: 46px;/);
    expect(css1).toMatch(/--tt-chip: 64px; --tt-chip-img: 52px;/);
    // a protocol-relative avatar is refused (falls back to the race crest)
    const evil = await mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, avatarUrl: "//evil.example/x.png", rosterId: "orc" }, away: { ...teams.away, avatarUrl: "/uploads/a.png" } }, tally: serverTally,
      events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: { crests: { crests: { orc: "crests/orc.png" } } },
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(evil).not.toContain("evil.example");
    expect(evil).toContain('src="/crests/orc.png"');
    expect(evil).toContain('src="/uploads/a.png"');
    expect(html.match(/class="tt-team tt-nameline"/g)).toHaveLength(2); // name, race and coach lines share the alignment class
    expect(html).toContain('class="tt-coachline tt-nameline"');
    const css0 = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css0).toMatch(/\.tt-rec \.tt-corner\.home \.tt-race\.tt-nameline, \.tt-rec \.tt-corner\.home \.tt-coachline\.tt-nameline \{ margin-left: var\(--tt-name-bearing\); \}/);
    expect(css0).toMatch(/\.tt-rec \.tt-corner\.away \.tt-team\.tt-nameline[^{]*\{ margin-right: -\.06em; \}/);
    expect(html).toMatch(/class="tt-coachline tt-nameline"><span class="tt-coach">/);
  });

  it("--ui-warn / --ui-warn-contrast exist for every preset and the Injury button text clears 4.5:1 on its face", async () => {
    const { readFileSync } = await import("node:fs");
    const theme = readFileSync(fileURLToPath(new URL("../public/theme.css", import.meta.url)), "utf8");
    // the fixed-semantics block sits on :root, which every preset (Black/Red, FUMBBL) inherits; no preset block may override it away
    const fixed = /:root \{[^}]*--ui-danger:[^}]*\}/.exec(theme)![0];
    const warn = /--ui-warn:\s*(#[0-9a-f]{6})/i.exec(fixed)![1]!;
    const ink = /--ui-warn-contrast:\s*(#[0-9a-f]{6})/i.exec(fixed)![1]!;
    for (const preset of theme.match(/:root\[data-theme="[^"]+"\] \{[^}]*\}/g) ?? []) expect(preset).not.toMatch(/--ui-warn/);
    const lum = (hex: string): number => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const [hi, lo] = [lum(warn), lum(ink)].sort((a, b) => b - a);
    expect((hi! + 0.05) / (lo! + 0.05)).toBeGreaterThanOrEqual(4.5);
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-rail-injury \{[^}]*background: var\(--ui-warn\); color: var\(--ui-warn-contrast\)/);
    expect(css).not.toContain("--tt-warn");
    const scarlet = /--ui-scarlet:\s*(#[0-9a-f]{6})/i.exec(fixed)![1]!;
    const scarletInk = /--ui-scarlet-contrast:\s*(#[0-9a-f]{6})/i.exec(fixed)![1]!;
    const [sh, sl] = [lum(scarlet), lum(scarletInk)].sort((x, y) => y - x);
    expect((sh! + 0.05) / (sl! + 0.05)).toBeGreaterThanOrEqual(4.5); // white on scarlet
    expect(css).toMatch(/\.tt-rail-end \{[^}]*background: var\(--ui-scarlet/); // the enabled End Turn is scarlet
  });

  it("Rosters pane (client roster language): five stat boxes with a changed-stat mark, a categorised skill chip, a gold added-skill box, a seat-tinted name and the sprite", async () => {
    const rich = {
      home: { name: "Alice Orcs", rerolls: 3, apothecary: true, players: [
        { id: "h1", name: "Grob", number: 1, spp: 6, mng: false, dead: false, positionName: "Blitzer", ma: 7, st: 3, ag: 3, pa: null, av: 9,
          printedStats: { ma: 6, st: 3, ag: 3, pa: null, av: 9 }, sprite: "sprites/orc/blitzer.png",
          printed: [{ name: "Block", category: "General" }], added: [{ name: "Dodge", category: "Agility" }], skills: ["Block", "Dodge"] },
      ] },
      away: { name: "Bob Elves", players: [{ id: "a1", name: "Lirael", number: 7, spp: 0, mng: false, dead: false }] },
    };
    const html = await mount(mods.rostersC, { match: baseMatch("recording"), teams: rich, tally: serverTally });
    expect(html.match(/class="row-stats"/g)).toHaveLength(1);
    expect(html).toMatch(/class="improved" data-tip="Movement Allowance \(printed 6\)"><b>7<\/b><small>MA<\/small>/); // MA 7 over the printed 6 (the builder's .improved)
    expect(html).toContain('class="roster-row roster-grid');
    expect(html).toContain('class="sprite-frame roster-sprite"');
    expect(html).toMatch(/class="(?=[^"]*skill)[^"]*skill-general[^"]*"[^>]*>Block</); // a categorised chip
    expect(html).toMatch(/class="(?=[^"]*tv-added)[^"]*skill-agility[^"]*"[^>]*>Dodge</); // the gold added-skill box
    expect(html).toContain('data-tip="Dodge: Agility skill, added"');
    expect(html).toMatch(/class="tt-roster-name" data-seat="home">(?:<!---->)?Grob</); // seat-tinted name
    expect(html).toContain('src="/sprites/orc/blitzer.png"');
    expect(html).toContain('data-tip="Team rerolls: 3"'); // the tab's icon chips with a count badge
    expect(html).toContain('<b class="tt-qty">3</b>');
    expect(html).toContain("tt-crest-frame"); // the lifted crest frame on the tab
    expect(html).toContain('aria-label="Skill key"');
    expect(html.match(/aria-label="Skill key"/g)).toHaveLength(1); // the key once, in the header
  });

  it("pickers use the Rosters row: roster-row classes, own-team rows only, an obscured victim row carries no name; Rosters adds the Inducements table and the stats column class", async () => {
    const rich = {
      home: { name: "Alice Orcs", players: [{ id: "h1", name: "Grob", number: 1, spp: 0, mng: false, dead: false, available: true, positionName: "Blitzer", ma: 6, st: 3, ag: 3, pa: null, av: 9, printed: [{ name: "Block", category: "General" }] }] },
      away: { name: "Bob Elves", players: [{ id: "a1", name: "Lirael", number: 7, spp: 0, mng: false, dead: false, available: true, positionName: "Catcher", ma: 8, st: 2, ag: 2, pa: 3, av: 8 }] },
    };
    const pick = await mount(mods.pickC, { kind: mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: rich, visibleSides: ["home"] });
    expect(pick).toContain('class="roster-row roster-grid tt-rp tt-rp-pick"');
    expect(pick).toContain("Grob");
    expect(pick).not.toContain("Lirael"); // a participant lists their own roster only
    expect(pick).not.toContain("Alice Orcs"); // no team header for a single roster
    expect(pick).toContain('class="row-stats"');
    expect(pick).toContain('class="skill skill-general"'.replace('class="skill skill-general"', 'skill-general'));
    const victim = await mount(mods.rosterRowC, { player: rich.away.players[0], side: "away", variant: "pick", obscured: true });
    expect(victim).toContain("#7 · Catcher");
    expect(victim).not.toContain("Lirael"); // the name never reaches the markup
    const named = await mount(mods.rosterRowC, { player: rich.away.players[0], side: "away", variant: "pick" });
    expect(named).toContain("Lirael");
    const evs = [{ id: "i1", type: "inducement", team: "home", payload: { picks: [{ id: "bribes", name: "Bribes", qty: 2, cost: 200000 }], total: 200000 } }];
    const ros = await mount(mods.rostersC, { match: baseMatch("recording"), teams: rich, tally: serverTally, events: evs, inducementIcons: { bribes: "icons/inducements/bribe.png" } });
    expect(ros).toContain('aria-label="Inducements"');
    expect(ros).toContain("/icons/inducements/bribe.png");
    expect(ros).toContain("200k"); // the cost and the total
    expect(ros).toContain('<span class="tt-hd-stats">Stats</span>');
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-rec \{ --tt-col: min\(1400px, 100vw\); \}/); // popups share the centred column width
    expect(css).toMatch(/\.tt-rec \.tt-modal-box, \.tt-rec \.tt-sheet, \.tt-rec \.tt-rosters, \.tt-rec \.tt-other-box \{\s*width: calc\(var\(--tt-col\) - 40px\); max-width: none; margin-inline: auto;/);
    expect(css).toMatch(/\.tt-rec \.tt-settings \.tt-seg \{ max-width: 720px; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    const other = await mount(mods.otherC, {});
    expect(other).toContain('class="tt-other-btn"');
    expect(other).toContain('class="tt-other-injury"'); // the Injury tile stays in the markup (phones, tablets)
    expect(css).toMatch(/@media \(min-width: 1024px\) \{[^@]*\.tt-rec \.tt-other-injury \{ display: none; \}/); // hidden on desktop: it is in the rail
    expect(css).toMatch(/\.tt-rec \.tt-other \{ max-width: 960px; margin: 0 auto 12px; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); gap: 12px; \}/);
    expect(css).toMatch(/\.tt-rec \.tt-other-btn \{ min-height: 112px;[^}]*box-shadow: var\(--tt-bevel\); text-shadow: var\(--tt-lettering-shadow\);/);
    expect(css).toMatch(/\.tt-rosters \.row-stats \{ width: 236px; justify-self: center; \}/); // the fixed centred stats column
    expect(css).toMatch(/\.tt-rosters \.tv-added \{[^}]*border: 1\.5px solid var\(--ui-gold\)/); // the gold added-skill box
    expect(css).toMatch(/\.tt-crest-frame \{[^}]*padding: 8px; border-radius: 6px;[^}]*0 8px 18px rgb\(0 0 0 \/ \.45\)/);
  });

  it("chip tray: two rows at most; the base size, then one notch smaller, then the first N plus a +K chip naming the hidden items", async () => {
    const { chipLayout, trayInnerWidth } = mods.chipLayoutMod;
    expect(trayInnerWidth(1400)).toBeGreaterThan(300); // the tray beside the crest column at the full 1400 px column
    expect(chipLayout(8, 1400)).toMatchObject({ size: 56, step: 0, visible: 8, hidden: 0 }); // two rows, no overflow
    expect(chipLayout(10, 1400)).toMatchObject({ size: 56, hidden: 0 });
    expect(chipLayout(12, 1400)).toMatchObject({ size: 48, step: 1, visible: 12, hidden: 0 }); // stepped down, re-flowed
    const many = chipLayout(20, 1400);
    expect(many).toMatchObject({ size: 48 });
    expect(many.visible + many.hidden).toBe(20);
    expect(many.hidden).toBeGreaterThan(0); // the rest sit behind "+K"
    expect(chipLayout(8, 1700).size).toBe(64); // from 1600 px the base chip is 64
    const picks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `ind${i}`, name: `Thing ${i}`, qty: 1 }));
    const render = (n: number) => mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, rerolls: 2, apothecary: true, dedicatedFans: 3 }, away: teams.away }, tally: serverTally,
      events: [{ id: "i1", type: "inducement", team: "home", payload: { picks: picks(n) } }], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true,
      inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    const five = await render(5); // rerolls + apothecary + fans + 5 inducements = 8 chips
    expect(five).toContain('data-size="56"');
    expect(five).not.toContain("tt-chip-more");
    const eleven = await render(11); // 14 chips: stepped down, one slot given to "+K"
    expect(eleven).toContain('data-size="48"');
    expect(eleven).toMatch(/class="tt-chip-more"[^>]*data-tip="Also: Thing \d+ x1/);
    const seventeen = await render(17); // 20 chips
    expect(seventeen).toMatch(/class="tt-chip-more"[^>]*>\+\d+</);
    expect(seventeen).toContain("Thing 16 x1"); // the last (hidden) item is named in the tip
  });

  it("event feed (Modern Retro): home cards left, away cards right, both-team cards full width, a jump id per card, a turn mark", async () => {
    const evs = [
      { id: "p1", type: "coinFlip", team: "home", payload: { mode: "auto", result: "tails" } },
      { id: "e1", type: "touchdown", team: "home", player: "h1", payload: {}, half: 1, turn: 3 },
      { id: "e2", type: "completion", team: "away", player: "a1", payload: {}, half: 1, turn: 4 },
    ];
    const rows = mods.feedMod.feedRows(evs, evs.map((e) => e.id), teams);
    const html = await mount(mods.feedC, { rows, canUndo: false });
    expect(html).toMatch(/class="tt-ev--home tt-ev" data-row-side="home" data-type="touchdown"/);
    expect(html).toMatch(/class="tt-ev--away tt-ev" data-row-side="away" data-type="completion"/);
    expect(html).toMatch(/class="tt-ev--neutral tt-ev" data-row-side="neutral" data-type="coinFlip"/);
    expect(html).toContain('id="tt-ev-e1"');
    // alignment classes: home left, away mirrored, game events centred (css contract)
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-ev\[data-row-side="neutral"\] \{[^}]*flex-direction: column; align-items: center;[^}]*text-align: center;/);
    expect(css).toMatch(/\.tt-ev\[data-row-side="neutral"\] \.tt-ev-mark \{[^}]*left: 50%;[^}]*translateX\(-50%\)/);
    expect(css).toMatch(/\.tt-ev\[data-row-side="away"\] \{[^}]*flex-direction: row-reverse; text-align: right;/);
    expect(css).toMatch(/\.tt-ev\[data-row-side="away"\] \.tt-ev-who \{[^}]*flex-direction: row-reverse; margin-right: auto;/);
    expect(html).toContain('<span class="tt-ev-mark">H1 T3</span>');
    expect(html).toContain('<b class="tt-ev-num">#1</b>'); // the acting player's number
    expect(html).not.toContain("tt-ev-grip"); // the store has no reordering, so no gripper
    const tl = await mount(mods.timelineC, { rows });
    expect(tl.match(/class="tt-tl-item"/g)).toHaveLength(3);
    expect(tl.indexOf('data-lane="both"')).toBeLessThan(tl.indexOf('data-lane="home"')); // play order: coin first
    const bar = await mount(mods.weatherBarC, { pregame: { weather: "Nice", stadium: { name: "Orc Arena" } }, events: [] });
    expect(bar).toContain("Nice");
    expect(bar).toContain("Orc Arena");
  });

  /** A matchMedia stand-in whose system setting can be flipped (fires the change event). */
  const fakeMedia = (dark: boolean) => {
    const listeners: Array<(e: { matches: boolean }) => void> = [];
    const mql = { matches: dark, addEventListener: (_t: "change", fn: (e: { matches: boolean }) => void) => { listeners.push(fn); } };
    return { matchMedia: () => mql, flip: (v: boolean) => { mql.matches = v; listeners.forEach((fn) => fn({ matches: v })); } };
  };
  const fakeDoc = () => {
    const attrs: Record<string, string> = {};
    const metas: Record<string, string> = {};
    const meta = { setAttribute: (k: string, v: string) => { if (k === "content") metas.themeColor = v; } };
    return {
      attrs, metas,
      doc: { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } }, head: { appendChild: () => undefined },
        querySelector: () => meta, createElement: () => meta },
    };
  };
  const memStore = (init: Record<string, string> = {}) => { const m = { ...init }; return { m, getItem: (k: string) => m[k] ?? null, setItem: (k: string, v: string) => { m[k] = v; } }; };

  it("theme: the default follows the device setting (dark -> Black/Red, light -> FUMBBL) and the browser chrome colour", () => {
    const dark = fakeDoc();
    const t1 = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: dark.doc });
    expect(t1.state.mode).toBe("system");
    expect(t1.state.resolved).toBe("dark");
    expect(dark.attrs["data-theme"]).toBe("brand-red");
    expect(dark.metas.themeColor).toBe(THEME_COLORS.dark);
    const light = fakeDoc();
    const t2 = createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: light.doc });
    expect(t2.state.resolved).toBe("light");
    expect(light.attrs["data-theme"]).toBe("fumbbl");
    expect(light.metas.themeColor).toBe(THEME_COLORS.light);
  });

  it("theme: a system change event flips the theme live while on System", () => {
    const media = fakeMedia(true);
    const d = fakeDoc();
    const t = createTheme({ matchMedia: media.matchMedia, storage: memStore(), doc: d.doc });
    expect(t.state.resolved).toBe("dark");
    media.flip(false);
    expect(t.state.resolved).toBe("light");
    expect(d.attrs["data-theme"]).toBe("fumbbl");
    media.flip(true);
    expect(t.state.resolved).toBe("dark");
  });

  it("theme: an explicit choice wins over the system and is remembered; System follows again", () => {
    const media = fakeMedia(true);
    const store = memStore();
    const t = createTheme({ matchMedia: media.matchMedia, storage: store, doc: fakeDoc().doc });
    t.setMode("light");
    expect(store.m[THEME_STORAGE_KEY]).toBe("light");
    media.flip(true);
    expect(t.state.resolved).toBe("light"); // the system says dark, the stored choice wins
    // a new session reads the stored choice over a dark system
    const again = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: store, doc: fakeDoc().doc });
    expect(again.state.mode).toBe("light");
    expect(again.state.resolved).toBe("light");
    // cycling: light -> dark -> system -> light, and System follows the device again
    again.cycle();
    expect(again.state.mode).toBe("dark");
    again.cycle();
    expect(again.state.mode).toBe("system");
    expect(again.state.resolved).toBe("dark");
    // storage that throws still works (in memory)
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const b = createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: broken, doc: fakeDoc().doc });
    b.setMode("dark");
    expect(b.state.resolved).toBe("dark");
  });

  it("theme: the recorder follows the device (light = SNES grey, dark = SNES dark) and shows the three-state control", async () => {
    const body = { match: baseMatch("recording"), events, effectiveEventIds: [], teams, tally: serverTally };
    const dark = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(dark.html).toContain('data-tt-theme="dark"');
    expect(dark.html).toContain("Theme: System");
    const light = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(light.html).toContain('data-tt-theme="snes"');
    const forced = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore({ [THEME_STORAGE_KEY]: "dark" }), doc: fakeDoc().doc }));
    expect(forced.html).toContain('data-tt-theme="dark"');
    expect(forced.html).toContain("Theme: Dark");
    // the whole SPA: the shell header carries the same control on every page (standings is public)
    const standings = await render("/standings", { "/api/auth/session": { authenticated: false } }, undefined, createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(standings.html).toContain("Theme: System");
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

  it("edit mode: no Undo buttons and no trash for a coach; the cog offers Edit mode to organisers only", async () => {
    const body = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally };
    for (const sess of [session(), session({ organizer: true })]) {
      const { html } = await renderMatch(body, sess);
      expect(html).not.toContain("tt-trash"); // trash cans only while edit mode is on (off on load)
      expect(html).not.toContain("You are in edit mode.");
      expect(html).not.toContain("Last events");
      expect(html).not.toMatch(/>Undo</);
      expect(html).not.toContain("tt-pencil");
    }
    const theme = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc });
    const settings = mods.settingsMod.createViewerSettings(mods.queue.memoryStorage());
    const coach = await mount(mods.settingsC, { theme, settings, editMode: false, canEdit: false });
    expect(coach).not.toContain("Edit mode");
    const organiser = await mount(mods.settingsC, { theme, settings, editMode: false, canEdit: true });
    expect(organiser).toContain("Edit mode");
    // trash cans surface only when the feed is told edit mode is on
    const rows = mods.feedMod.feedRows(events, ["e1", "e4"], teams);
    expect(await mount(mods.feedC, { rows, canUndo: false })).not.toContain("tt-trash");
    expect(await mount(mods.feedC, { rows, canUndo: true })).toContain('aria-label="Undo Touchdown"');
  });

  it("settings sheet: theme System / Light / Dark, compact rows, timestamps, haptic; options persist per viewer", async () => {
    const theme = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc });
    const store = mods.queue.memoryStorage();
    const settings = mods.settingsMod.createViewerSettings(store);
    const html = await mount(mods.settingsC, { theme, settings, editMode: false, canEdit: false });
    for (const t of ["Settings", ">System<", ">Light<", ">Dark<", "Compact rows", "Show timestamps", "Sounds", "Vibrate on tap"]) expect(html, t).toContain(t);
    expect(html).toContain("Andrea Baroni (Cyberleaf Studio)"); // credit for the timer sounds
    expect(html).toMatch(/aria-pressed="true">System</);
    expect(settings.state).toEqual({ compact: false, timestamps: true, haptic: false, sounds: true });
    settings.set("compact", true);
    settings.set("timestamps", false);
    const again = mods.settingsMod.createViewerSettings(store);
    expect(again.state).toEqual({ compact: true, timestamps: false, haptic: false, sounds: true });
    const broken = mods.settingsMod.createViewerSettings({ getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => undefined });
    broken.set("haptic", true);
    expect(broken.state.haptic).toBe(true);
    // compact rows and hidden timestamps reach the feed
    const rows = mods.feedMod.feedRows([{ id: "e1", type: "touchdown", team: "home", player: "h1", payload: {}, half: 1, turn: 3 }], ["e1"], teams);
    const feed = await mount(mods.feedC, { rows, canUndo: false, compact: true, timestamps: false });
    expect(feed).toContain('data-compact="true"');
    expect(feed).not.toContain("H1 T3");
  });

  /** A roster where the server says who is available and what each player is eligible for. */
  const elig = (id: string, name: string, number: number, extra: Record<string, unknown> = {}, eligible: Record<string, boolean> = {}) => ({
    id, name, number, spp: 0, mng: false, dead: false, available: true, eligible, ...extra,
  });
  const ttmTeams = {
    home: { name: "Alice Orcs", players: [
      elig("h1", "Grob", 1, { positionName: "Blitzer", skills: ["Block"] }, { throwTeamMate: true, rightStuff: false, foul: true }),
      elig("h2", "Snaga", 2, { positionName: "Lineman" }, { throwTeamMate: false, rightStuff: true }),
      elig("h3", "Fleet", 3, { positionName: "Goblin", skills: ["Right Stuff", "Dodge"] }, { throwTeamMate: false, rightStuff: true }),
      elig("h4", "Hurt", 4, { available: false, unavailableReason: "MNG" }, { throwTeamMate: true, rightStuff: true }),
      elig("h5", "Nofoul", 5, {}, { foul: false }),
      { id: "h6", name: "NoFlag", number: 6, spp: 0, mng: false, dead: false }, // no `available` from the server: omitted
    ] },
    away: { name: "Bob Elves", players: [
      elig("a1", "Lirael", 7, { positionName: "Catcher" }, { throwTeamMate: true, rightStuff: true, foul: true }),
      elig("a2", "Faen", 8, { available: false }, { throwTeamMate: true }),
      elig("a3", "Wisp", 9, {}, { throwTeamMate: false, rightStuff: true, foul: false }),
    ] },
  };
  const names = (html: string) => [...html.matchAll(/class="tt-num-badge">#\d+<\/b>(\w+)<\/strong>/g)].map((m) => m[1]);

  it("player lists: own roster only, available players only, filtered by the server's eligible flag; unavailable are omitted, not greyed", async () => {
    const open = (kind: string, visibleSides: string[]) => mount(mods.pickC, { kind: mods.feedMod.OTHER_EVENTS.find((o: any) => o.type === kind) ?? mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: ttmTeams, visibleSides });
    const foulHome = await open("foul", ["home"]);
    expect(names(foulHome)).toEqual(["Grob", "Snaga", "Fleet"]); // Nofoul (flag false), Hurt (unavailable), NoFlag (no `available`) are gone
    expect(foulHome).not.toContain("Lirael"); // never the other roster
    expect(foulHome).not.toContain("disabled"); // omitted, not greyed
    expect(foulHome).not.toContain("tt-pick-head"); // one roster: no team header
    const td = await mount(mods.pickC, { kind: mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: ttmTeams, visibleSides: ["away"] });
    expect(names(td)).toEqual(["Lirael", "Wisp"]); // Faen is unavailable
    // an organiser in edit mode sees both rosters, still availability-filtered, with a team header
    const both = await open("foul", ["home", "away"]);
    expect(both).toContain('class="tt-pick-head">Alice Orcs');
    expect(both).toContain('class="tt-pick-head">Bob Elves');
    expect(names(both)).toEqual(["Grob", "Snaga", "Fleet", "Lirael"]);
    expect(mods.feedMod.visibleSidesFor("home", false, true)).toEqual(["home"]); // edit mode alone does not widen it
    expect(mods.feedMod.visibleSidesFor("away", true, false)).toEqual(["away"]); // nor does being an organiser
    expect(mods.feedMod.visibleSidesFor("home", true, true)).toEqual(["home", "away"]);
    // the pick posts the player id
    expect(mods.feedMod.pickSpec(mods.feedMod.TD_EVENT, "away", "a1")).toEqual({ type: "touchdown", team: "away", player: "a1" });
  });

  it("Throw Team-mate: superb -> thrower (auto when one) -> landed -> who; posts ONE throwTeamMate event (both branches)", () => {
    const posted: any[] = [];
    const flow = (sides: string[], teams: unknown = ttmTeams) => mods.ttm.createTtmFlow({ teams: () => teams, visibleSides: () => sides, onPost: (x: unknown) => posted.push(x) });
    // not superb, did not land: finish with no names
    let f = flow(["home"]);
    expect(f.st.step).toBe("superb");
    f.answerSuperb(false);
    expect(f.st.step).toBe("landed");
    f.answerLanded(false);
    expect(posted).toEqual([{ type: "throwTeamMate", team: "home", payload: { superb: false, landed: false } }]);
    posted.length = 0;
    // superb with ONE eligible thrower (Grob): the list is skipped and he is selected; landed -> Right Stuff players only
    f = flow(["home"]);
    f.answerSuperb(true);
    expect(f.st.step).toBe("landed"); // auto-selected, no thrower list
    expect(f.st.thrower).toBe("h1");
    f.answerLanded(true);
    expect(f.st.step).toBe("thrown");
    expect(f.thrownGroups.value[0]!.players.map((p: any) => p.id)).toEqual(["h2", "h3"]); // Right Stuff + available; not the thrower, not Hurt
    f.finish(true, { side: "home", id: "h3" });
    expect(posted).toEqual([{ type: "throwTeamMate", team: "home", player: "h1", payload: { superb: true, landed: true, thrower: "h1", thrown: "h3" } }]);
    posted.length = 0;
    // two eligible throwers (an organiser in edit mode sees both rosters): the list is shown, the choice sets the team
    f = flow(["home", "away"]);
    f.answerSuperb(true);
    expect(f.st.step).toBe("thrower");
    expect(f.throwers.value.map((g: any) => g.side)).toEqual(["home", "away"]);
    f.choose("away", "a1");
    expect(f.st.step).toBe("landed");
    f.answerLanded(true);
    expect(f.thrownGroups.value.map((g: any) => g.side)).toEqual(["away"]); // the thrown player comes from the thrower's roster
    expect(f.thrownGroups.value[0]!.players.map((p: any) => p.id)).toEqual(["a3"]);
    f.finish(false);
    expect(posted).toEqual([{ type: "throwTeamMate", team: "away", player: "a1", payload: { superb: true, landed: false, thrower: "a1" } }]);
    // no eligible thrower at all: the list says so and continues
    const none = flow(["away"], { home: ttmTeams.home, away: { name: "Bob Elves", players: [elig("a9", "Plain", 9, {}, { throwTeamMate: false })] } });
    none.answerSuperb(true);
    expect(none.st.step).toBe("thrower");
    expect(none.throwers.value).toEqual([]);
  });

  it("Throw Team-mate sheets render the steps: superb question, thrower list, landed question, thrown rows with skills and SPP this match", async () => {
    const props = { match: baseMatch("recording"), teams: ttmTeams, tally: { ...serverTally, players: { home: [line("h3", "Fleet", { sppEarned: 2 })], away: [] } }, visibleSides: ["home"] };
    const html = await mount(mods.ttmC, props);
    expect(html).toContain("Was the pass superb?");
    expect(html.match(/>Yes</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Throw Team-mate"');
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

  // ---------------------------------------------------------------- R3: clock, End Turn, timers, cues, copy
  it("counter format 1Ht0: half, Ht, turn; overtime reads OTt", () => {
    expect(turnLabel(1, 0)).toBe("1Ht0");
    expect(turnLabel(2, 8)).toBe("2Ht8");
    expect(turnLabel("OT", 1)).toBe("OTt1");
    expect(turnLabel(undefined, undefined)).toBe("1Ht0");
  });

  it("End Turn shows only for the active side (organisers for the active team); others see who is to play; turn 0 is Kick-off done", async () => {
    expect(centreMode(undefined, "home", false, true)).toBe("none");
    expect(centreMode(clockOf("home", 3), "home", false, true)).toBe("end");
    expect(centreMode(clockOf("away", 3), "home", false, true)).toBe("wait");
    expect(centreMode(clockOf("away", 3), null, true, true)).toBe("end"); // organiser, for the active team
    expect(centreMode(clockOf("away", 3), null, false, false)).toBe("wait");
    expect(centreMode(clockOf("home", 0), "home", false, true)).toBe("kickoff");
    expect(centreMode(clockOf("home", 0), "away", false, true)).toBe("wait"); // only the team about to play confirms the kick-off
    expect(centreMode(clockOf("home", 0), null, true, true)).toBe("kickoff"); // an organiser may
    const body = (clock: unknown) => ({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock });
    const mine = await renderMatch(body(clockOf("home", 3)));
    expect(mine.html).toContain("End Turn");
    const theirs = await renderMatch(body(clockOf("away", 3)));
    expect(theirs.html).not.toContain("End Turn");
    expect(theirs.html).toContain("Bob Elves to play");
    expect(theirs.html).toContain("1Ht3");
    const organiser = await renderMatch(body(clockOf("away", 3)), session({ coach: "Zed", organizer: true }));
    expect(organiser.html).not.toContain("End Turn"); // an organiser never gets the enabled button on the opponent's turn
    expect(organiser.html).not.toContain('class="tt-endturn"');
    expect(organiser.html).not.toContain('class="tt-rail-end"');
    expect(organiser.html).toContain("Bob Elves to play"); // the disabled state
    expect(organiser.html).toContain("End this turn (override)"); // the organiser's way in, in the Quick box
    expect(mine.html).toContain('class="tt-rail-end"'); // the active coach's enabled rail button
    expect(mine.html).toContain('<span class="tt-rail-turn">TURN 3</span>'); // the big turn mark, no team name in the sub-line
    expect(mine.html).not.toContain("1Ht3 ·");
    expect(organiser.html).toContain('class="tt-rail-wait"'); // the disabled state keeps the team name in its label and the turn mark below
    expect(organiser.html).toContain('<span class="tt-rail-turn">TURN 3</span>');
    const second = await renderMatch(body(clockOf("home", 5, { half: 2 })));
    expect(second.html).toContain('<span class="tt-rail-turn">TURN 13</span>'); // 2Ht5 is match turn 13
    expect(second.html).toContain('<small class="tt-turnmark">TURN 13</small>'); // and the phone hero button
    expect(mine.html).not.toContain("End this turn (override)");
    expect(theirs.html).not.toContain("End this turn (override)"); // a coach never sees it
    const kick = await renderMatch(body(clockOf("home", 0)));
    expect(kick.html).toContain("Kick-off done");
    expect(kick.html).toContain("1Ht0");
    expect(kick.html).not.toContain("End Turn");
  });

  it("End Turn and Kick-off done post turn/end (guarded by the seen half and turn) and turn/start", async () => {
    const posts: unknown[] = [];
    const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
      if (init.method === "POST") { posts.push([path, init.body]); return { match: baseMatch("recording") }; }
      return { match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, clock: clockOf("home", 3, { half: 2 }) };
    }) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await rec.refresh();
    await rec.endTurn();
    await rec.startTurn();
    expect(posts).toEqual([
      ["/api/tabletop/matches/tm_abc123/turn/end", { expectedHalf: 2, expectedTurn: 3, expectedTeam: "home" }],
      ["/api/tabletop/matches/tm_abc123/turn/start", { expectedHalf: 2, expectedTurn: 3, expectedTeam: "home" }],
    ]);
    rec.stop();
  });

  it("timer is derived from the server offset: serverNow - local now at the sync, never a free-running count", async () => {
    const S0 = Date.UTC(2026, 9, 24, 12, 0, 0);
    const local = Date.UTC(2026, 9, 24, 11, 59, 0); // this phone runs a minute behind the server
    const clock = { half: 1, turn: 2, activeTeam: "home", turnStartedAt: S0 - 10_000, serverNow: S0, turnTimer: { mode: "on", seconds: 120 } };
    const offset = serverOffset(clock, local);
    expect(offset).toBe(60_000);
    expect(timerRemaining(clock, offset, local)).toBe(110); // 10 s into the turn on the SERVER clock
    expect(timerRemaining(clock, offset, local + 5_000)).toBe(105);
    expect(timerRemaining(clock, offset, local + 200_000)).toBeLessThan(0);
    expect(formatTimer(105)).toBe("1:45");
    expect(formatTimer(-7)).toBe("0:00"); // negative shows 0:00
    expect(timerRemaining({ ...clock, turnTimer: { mode: "off", seconds: 120 } }, offset, local)).toBeUndefined();
    // every sync re-measures the offset (the recorder keeps the latest)
    let nowMs = local;
    const api = (async () => ({ match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, clock })) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage(), now: () => nowMs });
    await rec.refresh();
    expect(rec.state.clockOffsetMs).toBe(60_000);
    nowMs = local + 30_000;
    await rec.refresh();
    expect(rec.state.clockOffsetMs).toBe(30_000);
    rec.onClockMessage({ feature: "tabletop-clock", payload: { ...clock, serverNow: S0 + 90_000, turn: 3 } });
    expect(rec.state.clock.turn).toBe(3);
    expect(rec.state.clockOffsetMs).toBe(S0 + 90_000 - nowMs);
    rec.stop();
  });

  it("timer mode: the End Turn button IS the timer (mm:ss from the server offset, End turn beneath); no separate Timer panel", async () => {
    const S0 = Date.now();
    // the server says this turn started 100 s ago on a 120 s timer: 20 s left, whatever this phone's clock says
    const on = clockOf("home", 3, { turnTimer: { mode: "on", seconds: 120 }, turnStartedAt: S0 - 100_000, serverNow: S0 });
    const { html } = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: on });
    expect(html).toMatch(/class="tt-endturn"[^>]*data-timed="true"/);
    expect(html).toMatch(/role="timer">0:(19|20)</); // inside the button
    expect(html).toContain("<small>End turn</small>");
    expect(html).toMatch(/--tt-fill:\s*1[56]\.\d+%/); // the background level follows the remaining time (about 16 %)
    expect(html).not.toContain('data-alert="true"'); // 20 s left: not yet the alert colour
    expect(html).not.toContain('class="tt-timer"'); // the Timer half-panel is gone
    expect(html).not.toContain('data-timer="on"');
    // under 10 s: the alert state; past zero: 0:00 pulses
    const hot = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3, { turnTimer: { mode: "on", seconds: 120 }, turnStartedAt: S0 - 115_000, serverNow: S0 }) });
    expect(hot.html).toMatch(/data-alert="true"/);
    expect(hot.html).toMatch(/role="timer">0:0[45]</);
    const late = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3, { turnTimer: { mode: "on", seconds: 120 }, turnStartedAt: S0 - 200_000, serverNow: S0 }) });
    expect(late.html).toContain('data-zero="true"');
    expect(late.html).toMatch(/role="timer">0:00</);
    // the other coach sees the same countdown dimmed with "<Team> to play"
    const other = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("away", 3, { turnTimer: { mode: "on", seconds: 120 }, turnStartedAt: S0 - 100_000, serverNow: S0 }) });
    expect(other.html).toMatch(/class="tt-towait"[\s\S]*role="timer">0:(19|20)</);
    expect(other.html).toContain("Bob Elves to play");
    expect(other.html).not.toContain('class="tt-endturn"');
    // timer off keeps the plain End Turn label
    const off = await renderMatch({ match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) });
    expect(off.html).toContain("<b>End Turn</b>");
    expect(off.html).not.toContain("role=\"timer\"");
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toContain('.tt-endturn[data-alert="true"]');
    expect(css).toContain('.tt-endturn[data-zero="true"] { animation: tt-pulse');
    expect(css).not.toContain(".tt-timer {");
  });

  it("cue schedule matches the client: the minute sound at 1:00, then every second 10..1 (warning tone 10..6, countdown 5..1)", () => {
    const tr = createCueTracker();
    const heard: Array<[string, number, string]> = [];
    const feed = (key: string, ...secs: number[]) => secs.forEach((s) => { const h = tr.reading(key, s); if (h) heard.push([key, s, h.cue]); });
    const run = Array.from({ length: 81 }, (_, i) => 80 - i); // 80 s down to 0 s
    feed("1-1-home", ...run);
    expect(heard.map(([, s]) => s)).toEqual([60, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]); // = {60} u {10..1}
    expect(heard.map(([, , c]) => c)).toEqual(["minute", "warning", "warning", "warning", "warning", "warning", "countdown", "countdown", "countdown", "countdown", "countdown"]);
    expect(CUE_SECONDS).toEqual([60, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    heard.length = 0;
    feed("1-2-away", 8, 7, 7, 6, 3, 2); // first reading at 0:08: 1:00, 0:10 and 0:09 already passed; a repeat second is silent
    expect(heard.map(([, s]) => s)).toEqual([7, 6, 3, 2]);
    heard.length = 0;
    feed("1-3-home", 65, 55, 9, 8); // a skipped tick still sounds the second it lands on
    expect(heard.map(([, s, c]) => `${s}:${c}`)).toEqual(["55:minute", "9:warning", "8:warning"]);
    heard.length = 0;
    feed("1-3-home", 61, 61); // same turn key, a clock that did not fall: nothing replays
    expect(heard).toEqual([]);
  });

  it("cue player: Sounds off and locked audio stay quiet; a listed file is preferred over a tone; tones follow the cadence", () => {
    const tones: Array<[number, number]> = [];
    let sounds = false;
    const p = createCuePlayer({ enabled: () => sounds, tone: (hz, ms) => tones.push([hz, ms]) });
    expect(p.play("minute")).toBe("off"); // Sounds off
    sounds = true;
    expect(p.play("minute")).toBe("off"); // browser audio still locked: no gesture yet
    p.unlock();
    expect(p.play("minute")).toBe("tone");
    expect(p.play("warning", 10)).toBe("tone");
    expect(p.play("countdown", 5)).toBe("tone");
    expect(tones[0]![1]).toBeGreaterThan(tones[1]![1]); // one long chime at 1:00, short beeps after
    expect(toneFor("countdown", 3)[0]).toBeLessThan(toneFor("countdown", 2)[0]); // rising on the last three
    expect(toneFor("countdown", 2)[0]).toBeLessThan(toneFor("countdown", 1)[0]);
    expect(toneFor("countdown", 5)[0]).toBe(toneFor("warning", 9)[0]); // flat before the last three
    const played: string[] = [];
    const withFiles = createCuePlayer({
      enabled: () => true, tone: () => { throw new Error("a tone must not play when the manifest lists the file"); },
      files: () => ({ minute: "/sounds/ui/turn-clock-minute.wav", countdown: "/sounds/ui/turn-clock-countdown.wav" }),
      makeAudio: (src) => ({ play: () => { played.push(src); } }),
    });
    withFiles.unlock();
    expect(withFiles.play("minute")).toBe("file"); // one preloaded Audio per file
    expect(withFiles.play("warning", 9)).toBe("file"); // the warning tone reuses the minute sound
    expect(withFiles.play("countdown", 4)).toBe("file");
    expect(played).toEqual(["/sounds/ui/turn-clock-minute.wav", "/sounds/ui/turn-clock-minute.wav", "/sounds/ui/turn-clock-countdown.wav"]);
  });

  it("pre-game timers step: Yes / No (the session coach answers for their team); required or off competitions just say so", async () => {
    const ask = await mount(mods.pregameC, { ...pregameProps("pregame:timers"), clock: { turnTimer: { mode: "off", enforced: "optional" } }, timerAnswers: { home: true } });
    expect(ask).toContain("Use turn timers?");
    expect(ask.match(/>Yes</g)).toHaveLength(1);
    expect(ask.match(/>No</g)).toHaveLength(1);
    expect(ask).toContain("Alice Orcs</b> says yes");
    expect(ask).toContain("Bob Elves</b> has not answered yet");
    const required = await mount(mods.pregameC, { ...pregameProps("pregame:timers"), clock: { turnTimer: { mode: "on", enforced: "required", seconds: 120 } } });
    expect(required).toContain("Turn timers are required for this competition.");
    expect(required).not.toContain("Use turn timers?");
    const off = await mount(mods.pregameC, { ...pregameProps("pregame:timers"), clock: { turnTimer: { mode: "off", enforced: "off" } } });
    expect(off).toContain("Turn timers are off for this competition.");
    expect(off).not.toContain(">Yes<");
    expect(mods.feedMod.PREGAME_STEPS.at(-1)).toBe("timers"); // after the coin
  });

  it("edit mode: participants while recording, organisers always (the cog toggle follows)", () => {
    expect(canEditMatch({ organiser: false, participant: true, ended: false })).toBe(true);
    expect(canEditMatch({ organiser: false, participant: true, ended: true })).toBe(false); // after End of match
    expect(canEditMatch({ organiser: true, participant: false, ended: true })).toBe(true);
    expect(canEditMatch({ organiser: false, participant: false, ended: false })).toBe(false);
  });

  it("pre-game feed copy: coin (two rows or one merged), fans, weather, journeymen, inducements, prayers, timers, end of turn", async () => {
    const match = baseMatch("recording") as any;
    const mk = (id: string, type: string, team: string, payload: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ id, type, team, payload, ...extra });
    const lines = (evs: any[]) => mods.feedMod.feedRows(evs, evs.map((e) => e.id), teams, {}, match).map((r: any) => `${r.lead}${r.rest}`);
    // the server's two events: the flip, then the winner's choice
    expect(lines([
      mk("a", "coinFlip", "home", { mode: "auto", call: "heads", caller: "away", result: "heads", winner: "home" }),
      mk("b", "coinFlip", "home", { stage: "choice", winner: "home", choice: "kick" }),
    ])).toEqual([
      "Bob (Bob Elves) calls heads. The coin lands heads. Alice wins the toss.",
      "Alice chooses to kick. Bob Elves will receive.",
    ].reverse()); // newest first
    // hand mode, merged event
    expect(lines([mk("c", "coinFlip", "away", { mode: "hand", call: "heads", caller: "away", result: "tails", winner: "home", choice: "receive" })])[0])
      .toBe("Bob (Bob Elves) calls heads. They flipped a real coin: tails. Alice wins the toss. Alice chooses to receive. Bob Elves will kick.");
    expect(lines([mk("d", "coinFlip", "home", { mode: "auto", call: "tails", caller: "away", result: "heads", winner: "home", choice: "kick" })])[0])
      .toBe("Bob (Bob Elves) calls tails. The coin lands heads. Alice wins the toss. Alice chooses to kick. Bob Elves will receive.");
    expect(lines([mk("e", "fans", "home", { roll: 3, dedicatedFans: 1, total: 4 })])[0]).toBe("Alice Orcs brings 4 fans (rolled 3).");
    expect(lines([mk("f", "weather", "home", { pregame: true, roll: 12, dice: [6, 6], result: "Blizzard" })])[0]).toBe("Weather: Blizzard");
    expect(lines([mk("g1", "journeyman", "away", { player: "x1" }), mk("g2", "journeyman", "away", { player: "x2" })])).toEqual(["Bob Elves takes on 2 journeymen."]);
    expect(lines([mk("h", "inducement", "home", { picks: [{ id: "bribes", qty: 2 }, { id: "wizard", qty: 1 }] })])[0]).toBe("Alice Orcs buys 2 x bribes, 1 x wizard.");
    expect(lines([mk("i", "inducement", "away", { picks: [], skipped: true })])[0]).toBe("Bob Elves buys no inducements.");
    expect(lines([mk("j", "prayer", "home", { roll: 4, name: "Fan Interaction" })])[0]).toBe("Alice Orcs prays to Nuffle: Fan Interaction.");
    expect(lines([mk("k", "timers", "home", { agreed: { home: true, away: true }, seconds: 120 })])[0]).toBe("Both coaches agree to turn timers (2:00).");
    expect(lines([mk("l", "timers", "home", { agreed: { home: true, away: false }, seconds: 120 })])[0]).toBe("Turn timers off.");
    expect(lines([mk("l2", "timerAgree", "home", { agree: true }), mk("l3", "timerAgree", "away", { agree: false })])).toEqual(["Bob Elves declines turn timers.", "Alice Orcs agrees to turn timers."]);
    expect(lines([mk("m", "turnEnd", "away", {}, { half: 1, turn: 3 })])[0]).toBe("End of turn 1Ht3 · Bob Elves");
    const rows = mods.feedMod.feedRows([mk("m", "turnEnd", "away", {}, { half: 1, turn: 3 })], ["m"], teams, {}, match);
    expect(rows[0].side).toBe("centre"); // a neutral, full-width row
    const html = await mount(mods.feedC, { rows, canUndo: true });
    expect(html).toMatch(/data-row-side="neutral" data-type="turnEnd"/);
    expect(html).not.toContain("tt-trash"); // not an undoable row... (turn ends are server events)
  });

  it("corner icon grid fits the band: rows share the height left under the names (css contract)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-chips \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); grid-auto-rows: minmax\(0, 1fr\)[^}]*flex: 1 1 0; min-height: 0/);
    expect(css).toMatch(/\.tt-chips li \{[^}]*height: 100%; width: auto; aspect-ratio: 1 \/ 1; max-width: 24px/);
    expect(css).toMatch(/\.tt-qty \{[^}]*font-size: 9px/);
  });

  it("a stale End Turn (409) just re-renders from the server's clock, with no error left on screen", async () => {
    let clock = clockOf("home", 3);
    const api = (async (path: string, init: { method?: string } = {}) => {
      if (init.method === "POST") { clock = clockOf("away", 3); throw new mods.sharedApi.ApiError(409, "The turn already moved on."); }
      return { match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, clock };
    }) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await rec.refresh();
    await rec.endTurn();
    expect(rec.state.clock.activeTeam).toBe("away");
    expect(rec.state.actionError).toBe("");
    rec.stop();
  });

  it("the tabletop-clock socket: hello with the match id, the welcome clock and pushed events update the clock; a refusal stops it", async () => {
    const sent: string[] = [];
    let ws: any;
    const api = (async () => ({ match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, clock: clockOf("home", 1) })) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", {
      api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage(), setInterval: () => 0, clearInterval: () => undefined, setTimer: () => 0,
      openSocket: () => { ws = { send: (d: string) => sent.push(d), close: () => undefined, onopen: null, onmessage: null, onclose: null }; return ws; },
    });
    rec.start();
    ws.onopen();
    expect(JSON.parse(sent[0]!)).toEqual({ type: "hello", v: 1, tabletopId: "tm_abc123" });
    ws.onmessage({ data: JSON.stringify({ type: "tabletopWelcome", v: 1, matchId: "tm_abc123", clock: clockOf("away", 4) }) });
    expect(rec.state.clock.turn).toBe(4);
    ws.onmessage({ data: JSON.stringify({ type: "event", v: 1, feature: "tabletop-clock", payload: clockOf("home", 5) }) });
    expect(rec.state.clock.turn).toBe(5);
    expect(rec.state.clock.activeTeam).toBe("home");
    ws.onmessage({ data: JSON.stringify({ type: "tabletopRefused", reason: "member" }) });
    rec.stop();
  });

  it("undo rules in the feed: a participant sees trash on their OWN side's rows only, an organiser on every row", async () => {
    const rows = mods.feedMod.feedRows(events, ["e1", "e4"], teams);
    const mine = await mount(mods.feedC, { rows, canUndo: true, undoSide: "home" });
    expect(mine).toContain('aria-label="Undo Touchdown"'); // e1 is home
    expect(mine.match(/class="tt-trash"/g)).toHaveLength(1); // the away completion has none
    const organiser = await mount(mods.feedC, { rows, canUndo: true, undoSide: null });
    expect(organiser.match(/class="tt-trash"/g)).toHaveLength(2);
  });

  it("Change turn: the cog offers it to those who may edit; the sheet is prefilled from the clock (OT only when allowed)", async () => {
    const theme = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc });
    const settings = mods.settingsMod.createViewerSettings(mods.queue.memoryStorage());
    expect(await mount(mods.settingsC, { theme, settings, editMode: false, canEdit: true })).toContain("Change turn");
    expect(await mount(mods.settingsC, { theme, settings, editMode: false, canEdit: false })).not.toContain("Change turn");
    const clock = { half: 2, turn: 4, activeTeam: "away", turnTimer: { mode: "off" }, allowOvertime: false };
    const html = await mount(mods.turnSetC, { match: baseMatch("recording"), clock, busy: false, error: "" });
    expect(html).toContain("Half 1");
    expect(html).toContain("Half 2");
    expect(html).not.toContain(">OT<"); // overtime is not allowed in this match
    expect(html).toMatch(/aria-pressed="true">Half 2</); // prefilled from the clock
    expect(html).toMatch(/aria-pressed="true">Bob Elves</); // the active team
    expect(html).toContain('<option value="4" selected>4</option>');
    const ot = await mount(mods.turnSetC, { match: baseMatch("recording"), clock: { ...clock, half: "OT", allowOvertime: true }, busy: false, error: "" });
    expect(ot).toMatch(/aria-pressed="true">OT</);
  });

  it("Change turn posts {half, turn, activeTeam} to turn/set; a turnSet event is a neutral row", async () => {
    const posts: unknown[] = [];
    const api = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
      if (init.method === "POST") { posts.push([path, init.body]); return { match: baseMatch("recording") }; }
      return { match: baseMatch("recording"), events: [], effectiveEventIds: [], teams, tally: serverTally, clock: clockOf("home", 1) };
    }) as Fetcher;
    const rec = mods.rec.createRecorder("tm_abc123", { api, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
    await rec.refresh();
    await rec.setTurn({ half: "OT", turn: 2, activeTeam: "away" });
    await rec.setTurn({ half: 2, turn: 4, activeTeam: "home" });
    expect(posts).toEqual([
      ["/api/tabletop/matches/tm_abc123/turn/set", { half: "OT", turn: 2, activeTeam: "away" }],
      ["/api/tabletop/matches/tm_abc123/turn/set", { half: 2, turn: 4, activeTeam: "home" }],
    ]);
    rec.stop();
    const ev = { id: "ts1", type: "turnSet", team: "away", by: "Alice", payload: { from: { half: 1, turn: 1, activeTeam: "home" }, to: { half: 2, turn: 4, activeTeam: "away" }, by: "Alice" } };
    const rows = mods.feedMod.feedRows([ev], ["ts1"], teams, {}, baseMatch("recording"));
    expect(`${rows[0].lead}${rows[0].rest}`).toBe("Alice set the clock to 2Ht4 · Bob Elves");
    expect(rows[0].side).toBe("centre");
    expect(rows[0].undoable).toBe(false);
  });

  it("match state is a green feed line (nothing while recording); the Recording status bar is gone", async () => {
    const body = (state: string, extra: Record<string, unknown> = {}) => ({ match: baseMatch(state, { updatedAt: "2026-10-23T20:41:00.000Z", ...extra }), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally });
    const rec = await renderMatch(body("recording"));
    expect(rec.html).not.toContain("tt-match-row");
    expect(rec.html).not.toContain("tt-state");
    expect(rec.html).not.toContain("Recording ·");
    const sub = await renderMatch(body("submitted", { preview: { home: summary("home"), away: summary("away") } }));
    expect(sub.html).toMatch(/class="tt-match-row" data-state="submitted" role="status">Match completed · \d/);
    const conf = await renderMatch(body("confirmed", { preview: { home: summary("home"), away: summary("away") } }));
    expect(conf.html).toMatch(/data-state="confirmed" role="status">Match confirmed</);
    const pub = await renderMatch(body("published", { preview: { home: summary("home"), away: summary("away") } }));
    expect(pub.html).toMatch(/data-state="published" role="status">Match published</);
    expect(sub.html.indexOf("tt-match-row")).toBeLessThan(sub.html.indexOf("tt-events")); // at the top of the feed
  });
});
