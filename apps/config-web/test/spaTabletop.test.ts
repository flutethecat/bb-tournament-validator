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
    const [app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC] = await Promise.all([
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
    ]);
    mods = { app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC };
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
    expect(html).toContain('href="/app/tabletop"'); // the back button
    // feed rows: the client log sentence, SPP stars, undo trash; the undone TD is gone
    expect(html).toContain("Grob #1</span> scores a touchdown.");
    expect(html).toContain("(&#9733;3)".replace("&#9733;", "\u2605"));
    expect(html).toContain("Lirael #7</span> completes a pass.");
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
    for (const t of ["Rosters", "Alice Orcs", "Bob Elves", "1/2", "1/1", "Grob", "Blitzer", "Block", "Dodge", "MNG", "Treasury 120k", "<small>MA</small>6", "<small>ST</small>3", "<small>AG</small>3+", "<small>PA</small>-", "<small>AV</small>9+", "9 SPP", "(+3)"])
      expect(html, t).toContain(t);
    expect(html).toContain("lineman"); // a team file without a position name falls back to the position id
    expect(html).toContain("<small>MA</small>-"); // stats the team file lacks show a dash
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
    expect(html.indexOf("tt-back")).toBeLessThan(html.indexOf("tt-weather")); // top row: Back, weather, cog
    expect(html.indexOf("tt-weather")).toBeLessThan(html.indexOf("tt-cog"));
    expect(html).toContain("2Ht5");
    expect(html).not.toMatch(/heads|tails/i);
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
    expect(organiser.html).toContain("End Turn");
    expect(organiser.html).toContain("Bob Elves");
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
      files: () => ({ minute: "/sounds/ui/turnClockMinute.wav", countdown: "/sounds/ui/turnClockCountdown.wav" }),
      makeAudio: (src) => ({ play: () => { played.push(src); } }),
    });
    withFiles.unlock();
    expect(withFiles.play("minute")).toBe("file"); // one preloaded Audio per file
    expect(withFiles.play("warning", 9)).toBe("file"); // the warning tone reuses the minute sound
    expect(withFiles.play("countdown", 4)).toBe("file");
    expect(played).toEqual(["/sounds/ui/turnClockMinute.wav", "/sounds/ui/turnClockMinute.wav", "/sounds/ui/turnClockCountdown.wav"]);
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
});
