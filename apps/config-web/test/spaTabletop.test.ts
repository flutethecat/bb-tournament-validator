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
    const [app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC, ttm, ttmC, timelineC, weatherBarC, clockMod, rosterRowC, chipLayoutMod, pickConfirmC, cardC] = await Promise.all([
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
      vite.ssrLoadModule("/src/components/TabletopPickConfirm.vue"),
      vite.ssrLoadModule("/src/components/TabletopPlayerCard.vue"),
    ]);
    mods = { app, vueRouter, renderer, rec, list, queue, organiser, standings, coachSearch, feedMod, otherC, rostersC, pregameC, feedC, boardC, pickC, settingsC, settingsMod, sharedApi, turnSetC, ttm, ttmC, timelineC, weatherBarC, clockMod, rosterRowC, chipLayoutMod, pickConfirmC, cardC };
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
    { id: "e3", type: "undo", team: "home", payload: { target: "e2" }, by: "Alice", ts: "2026-10-23T10:05:00.000Z" },
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

  it("signed out: /tabletop shows the sign-in prompt; /tabletop/:id is open to watch (owner ruling 10-30)", async () => {
    for (const path of ["/tabletop"]) {
      const { html } = await render(path, { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
      expect(html, path).toContain("Login with Discord");
      expect(html, path).toContain(`next=${encodeURIComponent(`/app${path}`)}`);
      expect(html, path).not.toContain("New match");
    }
    // the match page has no sign-in gate: the server decides the role (spectator for an anonymous visitor)
    const open = await render("/tabletop/tm_abc123", { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } });
    expect(open.html).not.toContain("Sign in with Discord to use this page.");
    const pw = await render("/tabletop", { "/api/auth/session": { authenticated: true, coach: "Pw", authMethod: "password", discordSsoEnabled: true } });
    expect(pw.html).toContain("This page needs a Discord sign-in.");
  });

  it("nav has a Tabletop entry under Testing for site admins only (owner 10-30)", async () => {
    const { html } = await render("/tabletop", { "/api/auth/session": session({ admin: true }) });
    expect(html).toContain("class=\"sf-label\">Tabletop<");
    const coach = await render("/tabletop", { "/api/auth/session": session() });
    expect(coach.html).not.toContain("class=\"sf-label\">Tabletop<");
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

  it("log cards: a casualty is two lines (causer, then the victim beneath); injuries and out-of-order pairs; obscured victims; undo strikes both", async () => {
    const pos = (id: string, name: string, n: number, positionName: string) => ({ ...player(id, name, n), positionName });
    const t2 = { home: { name: "Alice Orcs", players: [pos("h1", "Grob", 1, "Blitzer"), pos("h2", "Snaga", 2, "Lineman")] }, away: { name: "Bob Elves", players: [pos("a1", "Lirael", 7, "Catcher"), pos("a2", "Faen", 8, "Lineman")] } };
    const cas = { id: "c1", type: "casualty", team: "home", player: "h1", payload: { victim: "a1", victimTeam: "away", result: "BH", apothecaryUsed: true }, half: 1, turn: 2 };
    const rowsOf = (evs: any[], live: string[], obscure: "home" | "away" | null = null) => mods.feedMod.feedRows(evs, live, t2, { c1: 2 }, undefined, obscure);
    const r = rowsOf([cas], ["c1"]);
    expect(r.map((x: any) => `${x.part}:${x.team}`)).toEqual(["main:home", "victim:away"]); // causer line on top, victim line beneath on the victim's side
    const html = await mount(mods.feedC, { rows: r, canUndo: true });
    expect(html).toMatch(/class="tt-ev-line"><!---->causes\ a\ casualty!/); // the sentence is the action only; the name lives in the chip
    expect(html).not.toContain('class="tt-ev-name"');
    expect(html).toContain("(★2)"); // the stars ride the causer line
    expect(html).toMatch(/class="tt-ev-line"><!---->is\ Badly\ Hurt\ \(apothecary\ used\)\./);
    expect(html.indexOf("causes a casualty!")).toBeLessThan(html.indexOf("is Badly Hurt"));
    expect(html.match(/class="tt-trash"/g)).toHaveLength(1); // one undo for the one event
    expect(html).toContain('<b class="tt-ev-pname-name" data-seat="away">Lirael</b><small>Catcher</small>'); // chip: name over position, no number
    // a participant (home) sees the opposing victim obscured: "#7 Catcher is Badly Hurt"
    const hidden = await mount(mods.feedC, { rows: rowsOf([cas], ["c1"], "away"), canUndo: false });
    expect(hidden).toContain('data-seat="away">#7</b><small>Catcher</small>');
    expect(hidden).toMatch(/class="tt-ev-line"><!---->is\ Badly\ Hurt/);
    expect(hidden).not.toContain("Lirael");
    // retracted: both lines struck
    const undo = { id: "u1", type: "undo", team: "home", payload: { target: "c1" }, by: "Alice", ts: "2026-10-23T10:05:00.000Z" };
    const struck = await mount(mods.feedC, { rows: rowsOf([cas, undo], []), canUndo: false, showRemoved: true });
    expect(struck.match(/tt-ev--removed/g)).toHaveLength(2);
    // injuries (no causer): the victim line only, with the other wordings
    const inj = (id: string, result: string, extra: Record<string, unknown> = {}) => ({ id, type: "injury", team: "away", player: "a2", payload: { result, ...extra } });
    const words = rowsOf([inj("i1", "MNG"), inj("i2", "NI"), inj("i3", "stat loss", { stat: "AV" }), inj("i4", "DEAD")], ["i1", "i2", "i3", "i4"]).map((x: any) => x.rest).reverse();
    expect(words).toEqual(["is Miss Next Game.", "is Niggled.", "loses AV.", "is Dead."]);
    expect(rowsOf([inj("i1", "BH")], ["i1"])).toHaveLength(1);
    // order guard: an injury recorded BEFORE the casualty on the same victim and turn pairs with it and renders beneath it, once
    const early = { id: "i0", type: "injury", team: "away", player: "a1", payload: { result: "MNG" }, half: 1, turn: 2 };
    const paired = rowsOf([early, cas], ["i0", "c1"]);
    expect(paired.map((x: any) => `${x.id}:${x.part}`)).toEqual(["c1:main", "i0:victim"]);
    expect(paired[1].rest).toBe("is Miss Next Game.");
    // a different turn is not paired: two separate entries
    expect(rowsOf([{ ...early, turn: 1 }, cas], ["i0", "c1"]).map((x: any) => x.id)).toEqual(["c1", "c1", "i0"]);
  });

  it("log red: the spine and the card borders use the scarlet token (primary on the light preset)", async () => {
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-rec \{ --tt-red: var\(--ui-scarlet, #d7141f\); \}/);
    expect(css).toMatch(/:root\[data-theme="light"\] \.tt-rec \{ --tt-red: var\(--ui-primary, #790004\); \}/);
    expect(css).toMatch(/\.tt-events::before \{ width: 2px; background: color-mix\(in srgb, var\(--tt-red\) 70%, transparent\); \}/); // spine: 2 px at 70 %
    expect(css).toMatch(/::after \{ background: var\(--tt-red\); border: 2px solid var\(--ui-surface, #0d0d0d\); \}/); // dots: filled, dark ring
    expect(css).toMatch(/\.tt-ev \{ border-top-color: color-mix\(in srgb, var\(--tt-red\) 55%, transparent\); border-bottom-color: color-mix\(in srgb, var\(--tt-red\) 55%, transparent\); \}/); // card borders: 55 %
    expect(css).toMatch(/\.tt-ev\[data-row-side="neutral"\] \{ border-color: color-mix\(in srgb, var\(--tt-red\) 55%, transparent\); \}/);
    expect(css).toMatch(/\.tt-ev--admin\[data-row-side="neutral"\] \{ border-top-color: var\(--ui-admin, #ffd23d\); \}/); // admin keeps the yellow edge
  });

  it("name group: name glyph, tray border and fans pill share one edge", async () => {
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-corner\.home \.tt-namegroup > \.tt-team\.tt-nameline \{ margin-left: calc\(var\(--tt-name-bearing\) \* -1\); \}/);
    expect(css).toMatch(/\.tt-corner\.away \.tt-namegroup > \.tt-team\.tt-nameline \{ margin-right: calc\(var\(--tt-name-bearing\) \* -1\); \}/);
    expect(css).toMatch(/\.tt-namegroup > \.tt-coachline\.tt-nameline \{ margin-left: 0; margin-right: 0; padding-left: 0; padding-right: 0; \}/); // no padding-left on the tray wrapper
    expect(css).toMatch(/\.tt-namegroup > \.tt-fans-pill \{ margin-left: 0; margin-right: 0; \}/);
    expect(css).toMatch(/\.tt-coachline \.tt-chips \{ padding: 6px 8px; \}/); // chips start 8 px inside the border
  });

  it("player portrait card: stats, skill chips, SPP gain, status, injuries; the obscured variant names no one and lists no skills", async () => {
    const mods2 = await import("../spa/src/tabletop/playerCard");
    const full = { id: "h1", name: "Grob", number: 1, spp: 6, mng: false, dead: false, positionName: "Blitzer", sprite: "sprites/orc/blitzer.png", ma: 7, st: 3, ag: 2, pa: 4, av: 9,
      printedStats: { ma: 6, st: 3, ag: 3, pa: 4, av: 9 }, printed: [{ name: "Block", category: "General" }], added: [{ name: "Dodge", category: "Agility" }], injuries: ["Smashed Knee"] };
    const line = { id: "h1", name: "Grob", touchdowns: 1, casualtiesCaused: 0, completions: 0, interceptions: 0, deflections: 0, mvp: 0, sentOff: false, sppEarned: 3, injury: { result: "BH", apothecaryUsed: false } };
    const html = await mount(mods.cardC, { player: full, side: "home", line, x: 10, y: 20 });
    expect(html).toContain('class="tt-pcard-name" data-side="home">Grob</div>');
    expect(html).toContain('class="tt-pcard-position">#1 · Blitzer</div>');
    expect(html.match(/class="tt-pcard-stat"/g)).toHaveLength(5);
    expect(html).toContain('<span data-increased="true">7</span>'); // MA improved over the printed 6
    expect(html).toContain('<span data-increased="true">2+</span>'); // AG improved (lower target)
    expect(html).toContain('<span>3</span>'); // ST unchanged
    expect(html).toContain('class="skill-general tt-pcard-skill">Block</span>');
    expect(html).toContain('class="skill-agility tt-pcard-skill tt-pcard-added">Dodge</span>'); // added skills are highlighted
    expect(html).toContain('<div class="tt-pcard-spp">9 SPP<b class="tt-pcard-gain"> (+3)</b></div>');
    expect(html).toContain('data-status="Badly Hurt"');
    expect(html).toContain("\u2695 Smashed Knee");
    expect(html).toContain('src="/sprites/orc/blitzer.png"');
    expect(html).toContain("left:10px;top:20px;");
    const hidden = await mount(mods.cardC, { player: full, side: "away", obscured: true });
    expect(hidden).toContain('class="tt-pcard-name" data-side="away">#1 · Blitzer</div>');
    expect(hidden).not.toContain("Grob");
    expect(hidden).not.toContain("Block");
    expect(hidden).not.toContain("tt-pcard-skills");
    expect(hidden).not.toContain("Smashed Knee");
    // keys and placement
    expect(mods2.parseCardKey("home:h1")).toEqual({ side: "home", id: "h1" });
    expect(mods2.parseCardKey("nope")).toBeNull();
    const at = mods2.placeCard({ left: 100, top: 100, right: 160, bottom: 140 }, { w: 300, h: 200 }, { w: 1000, h: 800 }, 120);
    expect(at.x).toBe(172); // beside the element, to its right
    expect(mods2.placeCard({ left: 800, top: 100, right: 900, bottom: 140 }, { w: 300, h: 200 }, { w: 1000, h: 800 }, 120).x).toBe(488); // no room right: to its left
    const narrow = mods2.placeCard({ left: 20, top: 100, right: 340, bottom: 140 }, { w: 300, h: 200 }, { w: 360, h: 800 }, 120);
    expect(narrow.y).toBeGreaterThanOrEqual(140); // no room beside it: under it, never over it
    // the hover targets carry the key
    const feedHtml = await mount(mods.feedC, { rows: mods.feedMod.feedRows([{ id: "e1", type: "touchdown", team: "home", player: "h1", payload: {} }], ["e1"], teams), canUndo: false });
    expect(feedHtml).toContain('data-pcard="home:h1"');
    expect(mods2.CARD_DELAY_MS).toBe(250);
  });

  it("NAF line: a second muted line under the CR chip and under the phone CR text, hidden at 0 games, glicko part omitted when absent", async () => {
    const base = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    const view = (naf: Record<string, unknown>, cr = 1523) => ({ cr, rank: "Emerging Star", rankKey: "emerging", games: 12, naf });
    const html = (await renderMatch({ ...base, coachRating: { home: view({ games: 86, glicko: 1498.5 }), away: view({ games: 1 }) } })).html;
    expect(html).toContain('<span class="tt-cr-naf">NAF 1499 \u00b7 86 GAMES</span>'); // glicko rounded
    expect(html).toContain('<span class="tt-cr-naf">NAF 1 GAME</span>'); // no glicko: no rating part
    expect(html.match(/class="tt-cr-naf"/g)).toHaveLength(2);
    expect(html).toContain('<small class="tt-coach-naf">NAF 1499 \u00b7 86 GAMES</small>'); // phone line, under the CR text
    // directly under the chip in the crest column, after it and before the name group
    const col = html.slice(html.indexOf('class="tt-crestcol"'), html.indexOf('class="tt-namegroup"'));
    expect(col.indexOf('class="tt-cr-naf"')).toBeGreaterThan(col.indexOf('class="tt-cr"'));
    expect(html).toContain('data-tip="Coach rating 1523 \u00b7 Emerging Star (12 games) \u00b7 86 NAF games"'); // the chip tip is kept
    const none = (await renderMatch({ ...base, coachRating: { home: view({ games: 0 }), away: { cr: 1760, rank: "Legend", rankKey: "legend", games: 1 } } })).html;
    expect(none).not.toContain("tt-cr-naf");
    expect(none).not.toContain("tt-coach-naf");
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-rec \.tt-crestcol \.tt-cr-naf \{[^}]*white-space: nowrap;[^}]*font-size: 10px;[^}]*text-transform: uppercase;[^}]*color: var\(--tt-muted\)/);
    expect(css).toMatch(/\.tt-coach-naf \{[^}]*white-space: nowrap;/);
    expect(css).not.toMatch(/\.tt-(?:cr-naf|coach-naf) \{[^}]*#[0-9a-f]{3,8}/i); // tokens only
  });

  it("coach rating badge: CR text and pixel rank shield per seat, tip, phone text under the coach, nothing without a server rating", async () => {
    const base = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    const html = (await renderMatch({ ...base, coachRating: { home: { cr: 1523, rank: "Emerging Star", rankKey: "emerging", games: 12 }, away: { cr: 1760, rank: "Legend", rankKey: "legend", games: 1 } } })).html;
    expect(html.match(/class="tt-cr"/g)).toHaveLength(2);
    expect(html).toContain('data-rank="emerging" data-tip="Coach rating 1523 \u00b7 Emerging Star (12 games)"');
    expect(html).toContain('data-rank="legend" data-tip="Coach rating 1760 \u00b7 Legend (1 game)"');
    expect(html).toContain('<b class="tt-cr-text">CR 1523</b>');
    expect(html.match(/class="tt-rank-pip"/g)).toHaveLength(4 + 8); // emerging = 4 pips, legend = 8
    expect(html).toContain('class="tt-rank-shield"');
    expect(html).not.toMatch(/<img[^>]*rank/i); // our own inline SVG, never an image
    expect(html.match(/class="tt-coach-cr">CR /g)).toHaveLength(2); // phone: CR text under the coach name
    expect((await renderMatch(base)).html).not.toContain('class="tt-cr"');
    // the client's own retro badge image when the manifest lists it; the SVG shield otherwise
    const board = (art: Record<string, unknown>) => mount(mods.boardC, {
      match: baseMatch("recording"), teams, tally: serverTally, events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art,
      coachRating: { home: { cr: 1571, rank: "Star", rankKey: "star", slug: "star", games: 30 }, away: { cr: 1523, rank: "Emerging Star", rankKey: "emerging", slug: "emerging-star", games: 12 } },
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    const withBadges = await board({ coachBadges: { star: "icons/coach-badges/star-retro.png", "emerging-star": "icons/coach-badges/emerging-star-retro.png", evil: "//evil.example/x.png" } });
    expect(withBadges).toContain('<img class="tt-rank-img" src="/icons/coach-badges/star-retro.png" alt="" height="28">');
    expect(withBadges).toContain('src="/icons/coach-badges/emerging-star-retro.png"');
    expect(withBadges).not.toContain("tt-rank-shield"); // the image replaces the shield
    expect(withBadges).toContain("CR 1571");
    const partial = await board({ coachBadges: { star: "icons/coach-badges/star-retro.png" } });
    expect(partial.match(/class="tt-rank-img"/g)).toHaveLength(1);
    expect(partial.match(/class="tt-rank-shield"/g)).toHaveLength(1); // the missing badge falls back to the SVG shield
    const unsafe = await board({ coachBadges: { star: "//evil.example/x.png", "emerging-star": "icons/coach-badges/../x.png" } });
    expect(unsafe).not.toContain("evil.example");
    expect(unsafe).not.toContain("tt-rank-img");
    const manifest = JSON.parse((await import("node:fs")).readFileSync(fileURLToPath(new URL("../public/icons/coach-badges/manifest.json", import.meta.url)), "utf8"));
    expect(Object.keys(manifest.retro)).toHaveLength(8);
    expect(manifest.source.commit).toMatch(/^[0-9a-f]{40}$/); // the source commit travels with the art
    expect(manifest.retro.star).toBe("icons/coach-badges/star-retro.png");
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    for (const [k, t] of [["rookie", "--ui-muted"], ["experienced", "--ui-success"], ["veteran", "--ui-info"], ["star", "--ui-gold"], ["super", "--ui-scarlet"], ["legend", "--ui-text-on-primary"]]) {
      expect(css).toMatch(new RegExp(`\\.tt-cr\\[data-rank="${k}"\\] \\{ --tt-rank-c: var\\(${t},`));
    }
    expect(css).toMatch(/\.tt-cr\[data-rank="mega"\] \{ --tt-rank-c: color-mix\(in srgb, var\(--ui-warn,[^;]*var\(--ui-scarlet,/); // Mega-Star: orange, between Super Star and Legend
    expect(css).toMatch(/\.tt-cr\[data-rank="emerging"\] \{ --tt-rank-c: color-mix\(/);
    expect(css).not.toMatch(/\.tt-cr \{[^}]*position: absolute/); // in the column's flow, never over the crest
    expect(css).toMatch(/\.tt-rec \.tt-cr \{[^}]*align-self: center;/);
    expect(css).toMatch(/\.tt-rec \.tt-crestcol \{ display: flex; flex-direction: column; align-items: center; align-self: center; gap: 6px;/); // the 6 px gap
    // order inside the crest column: coach, crest, race, then the CR badge
    const col = html.slice(html.indexOf('class="tt-crestcol"'), html.indexOf('class="tt-namegroup"'));
    const order = [col.indexOf('tt-crest-coach'), col.indexOf('tt-corner-top'), col.indexOf('tt-crest-race'), col.indexOf('class="tt-cr"')].filter((v) => v >= 0); // the race line shows only when the team has a race
    expect(order.length).toBeGreaterThanOrEqual(3);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(col.lastIndexOf('class="tt-cr"')).toBeGreaterThan(col.lastIndexOf('tt-corner-top')); // last in the column
  });

  it("context bar: renders the server's competition context for the three kinds, nothing when it sent none", async () => {
    const base = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    const league = (await renderMatch({ ...base, context: { kind: "league", title: "Pacific League", subtitle: "Round 7/8", round: 7, roundCount: 8, startedAt: "2026-10-28T20:00:00.000Z", venue: "Table 3" } })).html;
    expect(league).toContain('class="tt-context" data-kind="league"');
    expect(league).toContain('<b class="tt-context-title">Pacific League</b>');
    expect(league).toContain('<span class="tt-context-sub">Round 7/8</span>');
    expect(league).toContain('<span class="tt-context-venue">Table 3</span>');
    expect(league).toContain('class="tt-context-when"');
    expect(league.indexOf('class="tt-context"')).toBeLessThan(league.indexOf('class="tt-board"')); // above the hero
    const tournament = (await renderMatch({ ...base, context: { kind: "tournament", title: "Spring Cup", subtitle: "Winter Series" } })).html;
    expect(tournament).toContain('data-kind="tournament"');
    expect(tournament).toContain('<span class="tt-context-sub">Winter Series</span>');
    expect(tournament).not.toContain("tt-context-when");
    const casual = (await renderMatch({ ...base, context: { kind: "casual", title: "Casual match", subtitle: "Blood Bowl 2025" } })).html;
    expect(casual).toContain('<b class="tt-context-title">Casual match</b>');
    expect(casual).toContain("Blood Bowl 2025");
    expect((await renderMatch(base)).html).not.toContain('class="tt-context"');
    const cssC = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(cssC).toMatch(/\.tt-rec \.tt-context \{\s*box-sizing: border-box; height: 56px; margin: 16px 2px 0;/);
    expect(cssC).toMatch(/\.tt-rec \.tt-context-title \{ font-size: 24px;/);
    expect(cssC).toMatch(/@media \(min-width: 1600px\) \{ \.tt-rec \.tt-context-title \{ font-size: 28px; \} \}/);
  });

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
    expect(html).toContain('<span>1</span><span class="tt-score-colon">:</span><span>0</span>');
    expect(html).toContain("TURN 3"); // the End Turn button's turn line (the log and strip no longer show 1Ht3)
    expect(html).toContain("End Turn"); // Alice plays home and home is the active team
    expect(html).not.toContain("tt-stepper"); // no manual half / turn stepper any more
    expect(html).toContain("Rosters");
    expect(html).not.toContain("tt-back"); // no back button: the shell navigation leaves the page
    // feed rows: the client log sentence, SPP stars, undo trash; the undone TD is gone
    expect(html).toMatch(/class="tt-ev-line"><!---->scores\ a\ touchdown!/); // the sentence states only the action...
    expect(html).not.toContain("Grob #1</span>"); // ...and no number glued to it
    expect(html).toContain("(&#9733;3)".replace("&#9733;", "\u2605"));
    expect(html).toContain("completes a pass!");
    expect(html).toContain('data-seat="away">#7</b><small>'); // the opponent (Alice plays home) is shown by number (and position when the roster has one) only, in the chip
    expect(html).not.toContain("Lirael");
    expect(html).not.toContain("Lirael");
    expect(html).not.toContain('aria-label="Undo'); // undo rides edit mode (organisers) only
    expect(html.match(/data-type="touchdown"/g)).toHaveLength(2); // the undone TD stays in the log...
    expect(html.match(/tt-ev--removed/g)).toHaveLength(1); // ...struck through, with who removed it
    expect(html).toMatch(/class="tt-ev-removed">Removed by Alice/);
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
    expect(html.indexOf("tt-rosters-btn")).toBeLessThan(html.indexOf('class="tt-weather"')); // top row: Rosters, weather, cog
    expect(html.match(/class="tt-rosters-btn"/g)).toHaveLength(1); // not repeated in the away corner
    expect(html).not.toContain("tt-back");
    expect(html.indexOf('class="tt-weather"')).toBeLessThan(html.indexOf("tt-cog"));
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
    expect(html).toMatch(/data-state="active"[^>]*aria-current="step">11</); // match turns: 2Ht3 is turn 11 (1-8 first half, 9-16 second)
    expect(html).toContain("2nd half");
    expect(html).toContain('<span>1</span><span class="tt-score-colon">:</span><span>0</span>');
    expect(html).toContain("<span>TD</span>");
    expect(html).toContain("<span>CAS</span>");
    expect(html).not.toContain("tt-clock"); // no turn timer in this clock
  });

  it("phone layout (below 760 px): strip, three 64 px squares + the OTHER row, admin chip, bottom sheets with the red X, single-column timeline, nothing wider than 375", async () => {
    const { readFileSync } = await import("node:fs");
    const body = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    // markup: TD, CAS, Injury squares then the Other row; the strip carries the turn, the timeline and Rosters / Settings; the admin chip is for organisers only
    const coach = await renderMatch(body);
    const bar = coach.html.slice(coach.html.indexOf('class="tt-actions-bar"'));
    expect(bar.match(/class="tt-big tt-big-(td|cas|injury|other)"/g)).toEqual(['class="tt-big tt-big-td"', 'class="tt-big tt-big-cas"', 'class="tt-big tt-big-injury"', 'class="tt-big tt-big-other"']);
    expect(bar).toContain("<span>Injury</span>");
    expect(bar).toMatch(/class="tt-big tt-big-other"[^>]*><span class="tt-big-dots" aria-hidden="true">[^<]*<\/span><span>Other<\/span>/);
    expect(coach.html).toMatch(/class="tt-stripbar"><span class="tt-stripbar-lead">1st half · TURN 3<\/span>/);
    expect(coach.html).toMatch(/class="tt-stripbar-btn"[^>]*>Rosters<\/button>/);
    expect(coach.html).toMatch(/class="tt-stripbar-btn tt-stripbar-cog" type="button" aria-label="Settings"/);
    expect(coach.html).not.toContain("tt-hero-admin"); // a participant has no admin chip
    const org = await renderMatch(body, session({ coach: "Zed", organizer: true }));
    // collapsed by default: the chip is a disclosure (aria-expanded false, aria-controls the row) and the row is not rendered
    expect(org.html).toMatch(/<button class="tt-hero-admin" type="button" aria-controls="tt-admin-row" aria-expanded="false"[^>]*>Admin<\/button>/);
    expect(org.html).not.toContain('id="tt-admin-row"');
    // expanded (remembered for the session): the row renders and the chip says so
    const store = new Map<string, string>([["cw.tt.adminRowOpen", "1"]]);
    const realSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    let open: Awaited<ReturnType<typeof renderMatch>>;
    try { open = await renderMatch(body, session({ coach: "Zed", organizer: true })); }
    finally { if (realSession) Object.defineProperty(globalThis, "sessionStorage", realSession); else delete (globalThis as { sessionStorage?: unknown }).sessionStorage; }
    expect(open.html).toMatch(/class="tt-hero-admin" type="button" aria-controls="tt-admin-row" aria-expanded="true"/);
    expect(open.html).toMatch(/<div id="tt-admin-row" class="tt-hero-admin-row" role="group" aria-label="Admin tools">/);
    expect(open.html).toContain("All admin tools");
    // a throwing sessionStorage (private window, blocked data) leaves the row collapsed instead of breaking the page
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get() { throw new Error("blocked"); } });
    let blocked: Awaited<ReturnType<typeof renderMatch>>;
    try { blocked = await renderMatch(body, session({ coach: "Zed", organizer: true })); }
    finally { if (realSession) Object.defineProperty(globalThis, "sessionStorage", realSession); else delete (globalThis as { sessionStorage?: unknown }).sessionStorage; }
    expect(blocked.html).toContain('aria-expanded="false"');
    // CSS: the phone block sits behind the 759 px breakpoint and carries the owner rules
    const css = readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    const at = css.indexOf("PHONE (below 760 px)");
    expect(at).toBeGreaterThan(-1);
    const phone = css.slice(css.indexOf("@media (max-width: 759px) {", at));
    expect(phone).toMatch(/^@media \(max-width: 759px\) \{\s*\.tt-rec \{\s*--tt-gutter: 16px;/); // the 16 px gutter is the first scale step
    for (const v of ["--tt-sq: 64px", "--tt-other-h: 48px", "--tt-end-h: 48px", "--tt-strip-h: 48px", "--tt-tap: 44px", "--tt-score-w: 128px"]) expect(phone).toContain(v);
    // three squares + the Other row
    expect(phone).toMatch(/\.tt-rec > \.tt-actions-bar \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-big \{[^}]*aspect-ratio: auto; height: var\(--tt-sq\); min-height: var\(--tt-sq\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-big-other \{ grid-column: 1 \/ -1;[^}]*height: var\(--tt-other-h\);/);
    // hero: the LED track collapses to the active LED; the scoreboard keeps score + TURN cell + stats; End Turn is a full-width row
    expect(phone).toMatch(/\.tt-rec \.tt-track \.tt-cell:not\(\[data-state="active"\]\) \{ display: none; \}/);
    expect(phone).toMatch(/\.tt-rec \.tt-score \{[^}]*grid-template-columns: minmax\(0, 1fr\) var\(--tt-turncell-w\) minmax\(0, 1fr\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-turns > \.tt-weather-cell \{ grid-column: 2; grid-row: 1;/);
    expect(phone).toMatch(/\.tt-rec \.tt-stats \{ grid-column: 1 \/ -1;/);
    expect(phone).toMatch(/\.tt-rec \.tt-endturn, \.tt-rec \.tt-towait \{ grid-column: 1 \/ -1;[^}]*height: var\(--tt-end-h\)/);
    expect(phone).toMatch(/\.tt-rec \.tt-corner \.tt-coachline > \.tt-coach \{[^}]*font-family: var\(--font-heading, sans-serif\);[^}]*color: var\(--ui-coach-led, #4cff6a\)/); // LED-green coach names
    expect(phone).toMatch(/\.tt-rec \.tt-corner \.tt-team \{ font-size: var\(--tt-team-fs\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-corner \.tt-namegroup > \.tt-race\.tt-nameline \{ display: block;/); // the race line stays (the CR text sits under the coach beneath it)
    // popups are full-width bottom sheets; the X is the shared red one
    expect(phone).toMatch(/\.tt-rec \.tt-modal-box, \.tt-rec \.tt-sheet, \.tt-rec \.tt-rosters:not\(\.tt-rosters-embed\), \.tt-rec \.tt-other-box \{\s*left: 0; right: 0; width: 100%; max-width: 100%; margin: 0;/);
    expect(phone).toMatch(/border-radius: var\(--tt-sheet-r\) var\(--tt-sheet-r\) 0 0/);
    expect(phone).toMatch(/\.tt-rec \.tt-x \{ width: var\(--tt-tap\); height: var\(--tt-tap\); \}/);
    expect(css).toMatch(/\.tt-x \{ background: var\(--ui-danger, #ff4d4d\); color: var\(--ui-text-on-primary, #ffffff\); \}/);
    expect(phone).toMatch(/\.tt-rec \.tt-ind \{ overflow-x: auto; \}/); // the inducements table scrolls inside its panel
    // the inducement tray scrolls sideways inside its own box; the timeline strip too
    expect(phone).toMatch(/\.tt-chips \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto; overflow-y: hidden;/);
    expect(phone).toMatch(/\.tt-rec \.tt-stripbar \.tt-tl \{[^}]*overflow-x: auto; overflow-y: hidden;/);
    expect(phone).toMatch(/\.tt-rec \.tt-feed > \.tt-tl \{ display: none; \}/); // the strip carries the timeline, not the feed
    // single-column timeline: spine on the left, home cards left, away cards right-aligned (order, never row-reverse), a dot per card on the spine
    expect(phone).toMatch(/\.tt-rec \.tt-events::before \{ content: ""; position: absolute; left: var\(--tt-spine-x\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-ev\[data-row-side="home"\] \{ margin: 0 var\(--tt-ev-indent\) 0 0;/);
    expect(phone).toMatch(/\.tt-rec \.tt-ev\[data-row-side="away"\] \{ margin: 0 0 0 var\(--tt-ev-indent\);[^}]*text-align: right;/);
    expect(phone).toMatch(/\.tt-rec \.tt-ev\[data-row-side="home"\]::after, \.tt-rec \.tt-ev\[data-row-side="away"\]::after \{/);
    expect(phone).not.toContain("row-reverse");
    expect(phone).not.toMatch(/\.tt-events \{[^}]*grid-template-columns/); // one column
    // nothing wider than 375: the page never scrolls sideways, the grid column can shrink, and no fixed width in the block exceeds the 343 px inside the gutters
    expect(phone).toMatch(/grid-template-columns: minmax\(0, 1fr\); grid-template-rows: auto auto var\(--tt-strip-h\) minmax\(0, 1fr\) auto; overflow-x: hidden; max-width: 100vw;/);
    const widths = [...phone.matchAll(/(?:^|[\s;{])(?:min-|max-)?width: (\d+)px/g)].map((m) => Number(m[1]));
    expect(Math.max(0, ...widths)).toBeLessThanOrEqual(343);
    const vars = [...phone.matchAll(/--tt-(?:score-w|led-w|turncell-w|chip|crest): (\d+)px/g)].map((m) => Number(m[1]));
    expect(vars.length).toBeGreaterThan(4);
    expect(2 * 44 + 128 + 2 * 8 + 32).toBeLessThanOrEqual(375); // two 44 px crests beside the 128 px score, 8 px gaps, 16 px gutters: the minimum the hero needs
    // tokens only: no raw hex or rgb()/hsl() colours in the phone block (the var() fallbacks are the only literals)
    const raw = phone.replace(/var\([^()]*(?:\([^()]*\)[^()]*)*\)/g, "").match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/g) ?? [];
    expect(raw).toEqual([]);
    // light and dark: the stats strip is black in both themes, so its text is the on-dark token (never --ui-text)
    expect(phone).toMatch(/\.tt-rec \.tt-stats \{[^}]*color: var\(--tt-on-dark\);/);
    expect(phone).toMatch(/--tt-on-dark: var\(--ui-text-on-primary, #ffffff\)/);
    expect(css).not.toMatch(/\.tt-rec \.tt-stats \{[^}]*color: var\(--ui-text, #e6e9ef\)/); // the desktop strip too
    expect(css).not.toMatch(/\.tt-rec \.tt-stats-half \{[^}]*color: var\(--ui-text, #e6e9ef\)/);
    // the Admin chip has its own row (under End Turn), so it never overlaps the LED row
    expect(phone).toMatch(/\.tt-rec \.tt-hero-admin \{ grid-column: 1 \/ -1; grid-row: 5;/);
    // the chip is a 44 px tap target; the admin row sits under it; desktop and tablet hide both (the rail panel is unchanged)
    expect(phone).toMatch(/\.tt-rec \.tt-hero-admin \{[^}]*height: var\(--tt-tap\); min-height: var\(--tt-tap\);/);
    expect(phone).toMatch(/\.tt-rec \.tt-hero-admin-row \{ grid-column: 1 \/ -1; grid-row: 6; display: grid;/);
    expect(phone).toMatch(/\.tt-rec \.tt-hero-admin-btn \{ min-height: var\(--tt-tap\);/);
    expect(css.slice(0, at)).toMatch(/\.tt-hero-admin, \.tt-hero-admin-row, \.tt-big-dots \{ display: none; \}/);
    expect(css.slice(0, at)).not.toMatch(/\.tt-hero-admin(?:-row)? \{[^}]*display: (?:flex|grid|inline-flex)/);
    expect(coach.html).not.toContain("tt-hero-admin-row");
    // the spectator line is upper-cased by CSS (the markup keeps "Bob's Turn"), the Match log heading is back above the log
    expect(phone).toMatch(/\.tt-rec \.tt-towait \{ text-transform: uppercase;/);
    expect(phone).toMatch(/\.tt-rec \.tt-mid > \.tt-log-h \{ display: flex;/);
    // timeline markers: a 44 x 44 hit area on a 14 px box inside the 2 px ring, items spaced 44 px apart
    expect(phone).toMatch(/\.tt-stripbar \.tt-tl-mark::before \{ inset: -15px; \}/);
    expect(phone).toMatch(/\.tt-tl-item\[data-lane\] \{ flex: 1 0 var\(--tt-tap\); min-width: var\(--tt-tap\);/);
    // tablet changes are 3 -> 4 columns only: the TD / CAS glyphs stay 36 px there
    expect(css).toMatch(/@media \(min-width: 760px\) \{[^@]*\.tt-big \.tt-glyph \{ width: 36px; height: 36px; \}/);
    // a 375 px audit over every rule that applies below 760 px (everything outside min-width media): no fixed width above the 343 px inside the gutters
    const applies: string[] = [];
    for (let i = 0, depth = 0, start = 0, skip = false; i < css.length; i++) {
      if (css[i] === "{") { if (depth === 0) { skip = /@media[^{]*min-width/.test(css.slice(start, i)); } depth++; }
      else if (css[i] === "}") { depth--; if (depth === 0) { if (!skip) applies.push(css.slice(start, i + 1)); start = i + 1; } }
    }
    const fixed = applies.join("\n").match(/(?<![-\w])(?:min-)?width: (\d+)px/g) ?? [];
    expect(fixed.length).toBeGreaterThan(10);
    expect(Math.max(...fixed.map((m) => Number(m.replace(/\D+/g, ""))))).toBeLessThanOrEqual(343);
    // long-press card: no text selection or system callout on the held element, the card fits the gutters
    expect(phone).toMatch(/\.tt-rec \[data-pcard\] \{ -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; \}/);
    expect(phone).toMatch(/\.tt-pcard \{ width: min\(22em, calc\(100vw - 32px\)\); max-width: calc\(100vw - 32px\); \}/);
    const view = readFileSync(fileURLToPath(new URL("../spa/src/views/TabletopRecorderView.vue", import.meta.url)), "utf8");
    expect(view).toMatch(/@pointercancel="pcardCancel\(\)"/); // a scroll that takes over the touch cancels the 450 ms hold
    // the pop-in stays, reduced motion is still respected; tablet keeps one row of four
    expect(css).toMatch(/\.tt-ev--new \{ animation: tt-ev-in 220ms ease-out both; \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tt-ev--new \{ animation: tt-fade-in 120ms linear both; \}/);
    expect(css).toMatch(/@media \(min-width: 760px\) \{\s*\.tt-actions-bar \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
  });

  it("phone: the strip reads the half and match turn (2nd half turn 3 = TURN 11), the spectator line stays \"Bob's Turn\" in the markup, OTHER opens the Other sheet", async () => {
    const { readFileSync } = await import("node:fs");
    const body = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("away", 3, { half: 2 }) };
    const spectator = await renderMatch(body, session({ coach: "Zed", organizer: true }));
    expect(spectator.html).toContain("2nd half · TURN 11");
    expect(spectator.html).toMatch(/class="tt-towait"[^>]*>[^]{0,40}?<b>Bob&#39;s Turn<[/]b>/);
    const coach = await renderMatch(body);
    expect(coach.html).toMatch(/class="tt-towait"[^>]*>[^]{0,40}?<b>Opponent&#39;s Turn<[/]b>/);
    // OTHER is wired to the Other sheet (a modal dialog with the shared X), which closes on its own X
    const view = readFileSync(fileURLToPath(new URL("../spa/src/views/TabletopRecorderView.vue", import.meta.url)), "utf8");
    expect(view).toMatch(/class="tt-big tt-big-other"[^>]*@click="viewer\.buzz\(\); other = true"/);
    expect(view).toMatch(/<TabletopOther v-if="other" @pick="onOther" @close="other = false" \/>/);
    const other = await mount(mods.otherC, {});
    expect(other).toMatch(/class="tt-modal" role="dialog" aria-label="Other events"/);
    expect(other.match(/aria-label="Close"/g)).toHaveLength(1);
    expect(view).toMatch(/ref="recRoot"/); // the focus manager watches the recorder root
  });

  it("possessive coach names: Bob's, and Chris' for a name ending in s", async () => {
    const { possessive } = mods.clockMod;
    expect(possessive("Bob")).toBe("Bob's");
    expect(possessive("Chris")).toBe("Chris'");
    expect(possessive("Jess")).toBe("Jess'");
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
    // second half, turn 3, away active: the cells read 9-16 (first half 1-8, overtime from 17)
    expect(turnCells(clock("away", 3), "away").map((c: { n: number }) => c.n)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(turnCells(clock("away", 3, 1), "away").map((c: { n: number }) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(turnCells({ half: "OT", turn: 1, activeTeam: "home" }, "home")[0].n).toBe(17);
    expect(turnCells(clock("home", 5), "home").find((c: { state: string }) => c.state === "active")!.n).toBe(13); // 2Ht5
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

  it("desktop rail: the rail container with TD, CAS and Other, the state strip and the crumb row render beside the log, with no End match button", async () => {
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
    expect(html.match(/class="tt-rail-btn[^>]*data-tip="/g)).toHaveLength(4); // every rail button (TD, CAS, Injury, Other) carries a tip
    expect(html).not.toMatch(/ title="/); // the recorder uses data-tip, never a native title
    expect(html).not.toContain("End match"); // ending the match is reached only through the Other grid's End of match tile
    expect(html).not.toContain("tt-rail-endmatch");
    expect(html).not.toContain("Undo last event"); // undo rides edit mode
    expect(html).not.toContain("tt-quick"); // the Quick box is gone
    expect(html).toMatch(/class="tt-rail-btn tt-rail-other"[^>]*><span>Other<\/span><\/button>/); // Other is label only, no glyph

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
    const crumbRow = css.lastIndexOf(".tt-rec > .tt-top { grid-row: 1; }");
    expect(crumbRow).toBeGreaterThan(-1);
    expect(css.indexOf(".tt-rec > .tt-stripbar { grid-row: 3; }")).toBeGreaterThan(crumbRow);
    expect(css).toContain(".tt-rec > .tt-mid { grid-column: 2; grid-row: 4; }");
    expect(css).toMatch(/\.tt-rec \{ overflow-y: auto; grid-template-rows: auto auto var\(--tt-strip-h\) minmax\(auto, 1fr\); \}/);
    // the hero is a contained, clipped, bezelled card at desktop; no full-bleed gradient is left
    expect(css).toMatch(/\.tt-rec > \.tt-board \{ margin: 18px 2px 0; padding: 12px 20px 14px; overflow: hidden; border-radius: 4px 4px 0 0; border: 0; border-bottom: 1px solid color-mix/); // joined: square bottom corners, one divider
    expect(css).toMatch(/\.tt-rec > \.tt-board \{[^}]*box-shadow: none;/); // the shadow belongs to the shared outer card
    expect(css).not.toContain("margin-inline: calc(-1 * var(--tt-pad))");
    expect(css).not.toMatch(/\.tt-board::after/);
    expect(css).not.toMatch(/\.tt-board::before \{[^}]*grid-column: 1 \/ -1/); // no full-width pseudo-element: the only one is the centre scoreboard panel
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
    expect(html.match(/class="tt-crest-coach"/g)).toHaveLength(2); // the coach sits above the crest frame, inside the crest column
    expect(html.match(/class="tt-crestcol"/g)).toHaveLength(2);
    expect(html).not.toContain("tt-cornerline"); // the top-corner line is gone
    const css1 = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \{ display: flex; flex-direction: column; align-items: center; align-self: center; gap: 6px; grid-row: 1 \/ -1; \}/); // one content-sized stack, centred in the card
    expect(css1).not.toMatch(/\.tt-crestcol \{[^}]*space-between/);
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-coach \{ font-size: 16px;/);
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-race \{ font-size: 13px; text-transform: uppercase; color: var\(--ui-text-dim/); // the race under the crest
    expect(css1).toContain("--tt-grad: radial-gradient(ellipse at center, color-mix(in srgb, var(--ui-surface, #0d0d0d) 45%, transparent) 0%, color-mix(in srgb, var(--ui-surface, #0d0d0d) 18%, transparent) 70%, transparent 100%)");
    expect(css1).toMatch(/--tt-grad-soft: radial-gradient\(ellipse at center, color-mix\(in srgb, var\(--ui-surface, #0d0d0d\) 35%, transparent\) 0%, color-mix\(in srgb, var\(--ui-surface, #0d0d0d\) 12%/);
    expect(css1).toMatch(/\.tt-rec \.tt-crest-frame \{ background: var\(--tt-grad\); \}/);
    expect(css1).toMatch(/\.tt-rec > \.tt-stripbar \{ background: var\(--tt-grad-soft\); \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-mid > \.tt-feed \{ background: var\(--tt-grad-soft\); \}/);
    expect(css1).toContain("--tt-bevel-inset: inset 0 1px 0 rgb(255 255 255 / .16), inset 0 -2px 0 rgb(0 0 0 / .35), inset 2px 0 0 rgb(255 255 255 / .06), inset -2px 0 0 rgb(0 0 0 / .22);");
    expect(css1).toContain("--tt-lift: var(--tt-bevel-inset), 0 3px 0 rgb(0 0 0 / .35), 0 8px 20px rgb(0 0 0 / .45), 0 0 0 1px rgb(0 0 0 / .35), 0 2px 0 rgb(255 255 255 / .05);"); // the longer lift
    expect(css1).toMatch(/\.tt-rec \.tt-rail-btn, \.tt-rec \.tt-rail-end \{ box-shadow: var\(--tt-lift\); \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-crest-frame, [^{]*\{ margin-bottom: 4px; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-crest-frame, \.tt-rec \.tt-half,[^{]*\{\s*border: 1px solid color-mix\(in srgb, var\(--ui-border, #3d0002\) 60%, #000\); border-radius: 6px; box-shadow: var\(--tt-lift\);/);
    expect(css1).toMatch(/\.tt-rec \.tt-mid > \.tt-feed \{ border: 1px solid[^}]*border-radius: 6px; box-shadow: var\(--tt-bevel-inset\); \}/); // the log field: the inset half only
    expect(css1).toMatch(/\.tt-rec > \.tt-board::before \{\s*content: ""; grid-column: 2; grid-row: 1 \/ 4;[^}]*repeating-linear-gradient\(0deg, rgba\(255, 255, 255, \.03\) 0 2px, transparent 2px 4px\)[^}]*color-mix\(in srgb, #000 58%, var\(--ui-surface[^}]*box-shadow: var\(--tt-lift\)/); // the scoreboard panel, a softer black
    expect(css1).toContain("radial-gradient(ellipse at center, transparent 55%, rgb(0 0 0 / .22) 100%)"); // half-strength vignette
    expect(css1).toContain("--tt-led-glow: 0 0 8px rgb(215 20 31 / .7), 0 0 18px rgb(215 20 31 / .4)");
    expect(css1).not.toContain("data-ghost"); // no ghost digits behind the score
    expect(css1).toMatch(/--tt-rows: minmax\(0, 1fr\) var\(--tt-half-w\) minmax\(0, 1fr\);/); // one three-column grid for the track, the score and the counters
    expect(css1).toMatch(/--tt-score-w: 420px;/);
    expect(css1).toMatch(/--tt-score-w: 460px;/);
    expect(html).not.toContain("data-ghost");
    // the turn track: the same dark cell throughout; future digits bright white, played digits soft grey, only the active cell glows scarlet
    expect(css1).toMatch(/\.tt-rec \.tt-track\.home \.tt-cell:not\(\[data-state="active"\]\), \.tt-rec \.tt-track\.away \.tt-cell:not\(\[data-state="active"\]\) \{\s*background: color-mix\(in srgb, #000 70%[^}]*border: 1px solid transparent; color: var\(--ui-text, #e6e9ef\); opacity: 1;/);
    expect(css1).toMatch(/\.tt-rec \.tt-track \.tt-cell\[data-state="active"\] \{ background: var\(--ui-scarlet/);
    expect(css1).toMatch(/\.tt-rec \.tt-track\.home \.tt-cell\[data-state="done"\], \.tt-rec \.tt-track\.away \.tt-cell\[data-state="done"\] \{ color: color-mix\(in srgb, var\(--ui-text, #e6e9ef\) 55%, transparent\); \}/); // played = soft grey, future = full white
    // scoreboard variant C: the broadcast bug (three columns, Nuffle digits with a hard shadow, no LED glow) and the stats strip
    expect(css1).toMatch(/\.tt-rec \.tt-score \{ display: grid; grid-template-columns: minmax\(0, 1fr\) 84px minmax\(0, 1fr\); grid-template-rows: 1fr;[^}]*font-family: var\(--font-heading, sans-serif\);[^}]*text-shadow: 3px 3px 0 #000;/);
    expect(css1).toMatch(/\.tt-rec \.tt-score > span:nth-child\(1\) \{ grid-column: 1; background: linear-gradient\(90deg, color-mix\(in srgb, var\(--ui-info/);
    expect(css1).toMatch(/\.tt-rec \.tt-score > span:nth-child\(3\) \{ grid-column: 3; background: linear-gradient\(270deg, color-mix\(in srgb, var\(--ui-danger/);
    expect(css1).toMatch(/\.tt-rec \.tt-stats \{ grid-column: 2; grid-row: 3; display: grid; grid-template-columns: minmax\(0, 1fr\) 84px minmax\(0, 1fr\);[^}]*border-top: 1px solid var\(--tt-rule\); border-bottom: 1px solid var\(--tt-rule\);[^}]*font-family: var\(--font-heading, sans-serif\)/);
    expect(css1).not.toMatch(/\.tt-rec \.tt-score \{[^}]*(?:glow|scarlet)/); // no LED red on the digits
    expect(css1).not.toMatch(/\.tt-rec \.tt-counters b \{/); // the LED counter cells are gone
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-race \{ color: var\(--ui-text, #e6e9ef\); \}/); // the race line is white
    expect(html).toContain('<span class="tt-score-turn"><small>TURN</small><b>3</b></span>'); // the dark centre cell
    expect(html).toContain('<div class="tt-stats" aria-label="Match stats"><span class="tt-stats-home">FOULS <b>0</b> · CAS <b>'); // fouls and casualties per side, not TDs (the score halves show those)
    expect(html).toContain('<span class="tt-stats-half">1st half</span>');
    // desktop: MATCH LOG is a footer row under the field; the field and the rail start at the same y
    expect(css1).toMatch(/\.tt-rec \.tt-mid \{ grid-template-rows: minmax\(0, 1fr\) 28px; \}\s*\.tt-rec \.tt-mid > \.tt-feed \{ grid-row: 1; \}\s*\.tt-rec \.tt-mid > \.tt-log-h \{ grid-row: 2; justify-content: flex-end; \}/);
    expect(css1).toMatch(/\.tt-rec > \.tt-mid \{ margin: 8px 20px 20px 0; \}\s*\.tt-rec > \.tt-rail \{ padding-top: 8px; \}/);
    // the score row has a fixed height and its three cells stretch the full height, digits centred
    expect(css1).toMatch(/--tt-score-h: 96px;/);
    expect(css1).toMatch(/--tt-score-h: 108px;/);
    expect(css1).toMatch(/\.tt-rec > \.tt-board \{ grid-template-rows: auto var\(--tt-score-h\) auto; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-score > span:nth-child\(1\), \.tt-rec \.tt-score > span:nth-child\(3\), \.tt-rec \.tt-score-turn \{ align-self: stretch; height: 100%; margin: 0; padding: 0; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-score > span:nth-child\(1\), \.tt-rec \.tt-score > span:nth-child\(3\) \{ display: grid; place-items: center; \}/);
    // the score row: exactly three items on row 1 (the colon is display:none), a single 1fr row so the fills equal the row height; no label on the track
    expect(css1).toMatch(/\.tt-rec \.tt-score > span:nth-child\(1\), \.tt-rec \.tt-score > span:nth-child\(3\), \.tt-rec \.tt-score-turn \{ grid-row: 1; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-score-colon \{ display: none; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-turns > \.tt-half \{ display: none; \}/);
    const score = /<p class="tt-score"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1]!;
    expect(score.match(/<span(?: class="tt-score-(?:colon|turn)")?>|<span class="tt-score-(?:colon|turn)">/g)).toHaveLength(4); // home, colon (hidden), away, TURN
    expect(html).not.toContain('class="tt-half"'); // no TURN / half label on the track (the server render is the desktop one)
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-coach \{ white-space: nowrap; width: max-content; max-width: 18em;[^}]*text-overflow: ellipsis;[^}]*align-self: center; \}/); // the coach line never wraps
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-coach\[data-long="true"\] \{ font-size: 14px; \}/);
    const longCoach = await mount(mods.boardC, {
      match: { ...baseMatch("recording"), home: { ...baseMatch("recording").home, coach: "Flutethecatwalker" } }, teams, tally: serverTally, events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(longCoach).toContain('class="tt-crest-coach" data-long="true">Flutethecatwalker<'); // longer than 12 characters steps down
    expect(html).toContain('<p class="tt-crest-coach">Alice</p>'); // short names keep the full size
    expect(css1).toMatch(/\.tt-rec \.tt-namegroup \{ display: flex; flex-direction: column; gap: 10px; align-self: center; justify-self: stretch; width: 100%; grid-row: 1 \/ -1; min-width: 0; \}/); // name + tray: one centred group
    expect(css1).toMatch(/\.tt-rec \.tt-corner\.away \.tt-namegroup \{ grid-column: 1; align-items: flex-end; \}/);
    expect(html.match(/class="tt-namegroup"/g)).toHaveLength(2);
    expect(css1).toMatch(/@media \(min-width: 1024px\) \{\s*\.tt-rec \.tt-namegroup > \.tt-race\.tt-nameline \{ display: none; \}/); // the in-group race copy is hidden on desktop
    expect(css1).toMatch(/\.tt-rec \.tt-score-turn small \{ font-size: 16px;/); // the TURN cell: label 16 px, number 26 px (18 / 30 from 1600)
    expect(css1).toMatch(/\.tt-rec \.tt-score-turn b \{ font-size: 26px;/);
    expect(css1).toMatch(/@media \(min-width: 1600px\) \{\s*\.tt-rec \.tt-score-turn small \{ font-size: 18px; \}\s*\.tt-rec \.tt-score-turn b \{ font-size: 30px; \}\s*\.tt-rec \.tt-stats-half \{ font-size: 14px; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-stats-half \{ font-size: 13px; white-space: nowrap; letter-spacing: \.02em; color: var\(--ui-text-on-primary, #ffffff\); text-shadow: var\(--tt-lettering-shadow\); \}/); // 2ND HALF: white, 13 px, never wraps
    expect(css1).toMatch(/\.tt-rec \.tt-stats-half\[data-long="true"\] \{ font-size: 12px; \}/); // a longer label (overtime) shrinks
    expect(css1).toMatch(/\.tt-x \{[^}]*width: 40px; height: 40px;[^}]*box-shadow: var\(--tt-bevel\)/); // the close X on every popup
    expect(css1).toMatch(/\.tt-picker \.tt-roster-list li\.roster-row\.tt-rp-pick \{ grid-template-columns: 56px minmax\(140px, 1\.2fr\) 236px minmax\(120px, 1\.4fr\);/); // the picker's table-like rows
    expect(css1).toContain("width: min(calc(var(--tt-col) - 40px), calc(100vw - 32px)); box-sizing: border-box; overflow-x: hidden;"); // popups never overflow the viewport
    expect(css1).toContain("grid-template-columns: repeat(2, minmax(0, 1fr)); margin-top: 0;"); // the picker's tab row shrinks
    expect(css1).toMatch(/\.tt-rec \.tt-picker \* \{ min-width: 0; \}/);
    expect(css1).toMatch(/\.tt-rosters \.roster-grid \{ grid-template-columns: 36px 56px minmax\(180px, 1fr\) 236px minmax\(0, 2fr\) 96px; column-gap: 12px; \}/); // number | sprite | name | stats | skills | SPP
    expect(css1).toMatch(/\.tt-picker \.tt-roster-list li\.roster-row\.tt-rp-pick \{ grid-template-columns: 36px 56px minmax\(180px, 1fr\) 236px minmax\(0, 2fr\);/);
    expect(css1).toMatch(/\.tt-rosters \.slot-number, \.tt-rosters-embed \.tt-rp-pick \.slot-number \{\s*display: flex;[^}]*width: 36px; height: 36px;[^}]*font-size: 16px;[^}]*box-shadow: var\(--tv-bezel\)/); // the number tile
    expect(css1).toMatch(/\.tt-rosters \.row-stats, \.tt-picker \.tt-rp-pick \.row-stats \{ width: 236px; justify-self: start; \}/); // the stats start right after the name column
    expect(css1).toMatch(/\.tt-rec \.tt-rail-btn, \.tt-rec \.tt-rail-btn\.tt-rail-other \{ display: inline-flex; justify-content: center; align-items: center; gap: 10px; padding: 0 14px; text-align: center; \}/); // each rail button centres its own icon and label pair
    expect(css1).toMatch(/\.tt-rec \.tt-rail-btn > \.tt-glyph \{ width: 24px; height: 24px; \}/);
    expect(css1).toMatch(/\.tt-rec > \.tt-stripbar \{ overflow-y: hidden; color: var\(--ui-text, #e6e9ef\); \}/); // no vertical scroll in the strip, white text
    expect(css1).toMatch(/\.tt-stripbar \.tt-tl \{ display: flex; align-items: center; overflow-y: hidden; overflow-x: auto;/);
    expect(css1).toMatch(/\.tt-rec \.tt-stripbar-end \{ color: var\(--ui-text, #e6e9ef\); \}/); // the FINAL label is white
    expect(css1).not.toContain("tt-stripbar-t"); // no state text in the strip
    // the picker's row grid fits its sheet: the fixed tracks plus the gaps stay well inside the 1236 px content box measured at 1280 px (sheet padding included)
    const gridRule = /\.tt-picker \.tt-roster-list li\.roster-row\.tt-rp-pick \{ grid-template-columns: ([^;]+);/.exec(css1)![1]!;
    const px = [...gridRule.matchAll(/(\d+)px/g)].reduce((n, m) => n + Number(m[1]), 0);
    const cols = gridRule.split(/\s+(?=\d|minmax)/).length;
    expect(px + 12 * (cols - 1)).toBeLessThan(1236 - 24);
    expect(css1).toMatch(/\.tt-rec \.tt-rosters-embed \{ width: 100%; max-width: 100%; box-sizing: border-box;/); // embedded lists take no popup width
    expect(css1).toMatch(/\.tt-confirm-yes \{ background: var\(--ui-success, #3fb463\); \}/); // YES is green
    expect(css1).toMatch(/\.tt-confirm-again \{ background: var\(--ui-danger, #ff4d4d\); \}/); // CHOOSE SOMEONE ELSE is red
    expect(css1).toMatch(/\.tt-x \{ background: var\(--ui-danger, #ff4d4d\); color: var\(--ui-text-on-primary, #ffffff\); \}/); // the Close X is red with a white X
    // new cards pop in (not on first load); reduced motion: a 120 ms fade and no movement
    expect(css1).toMatch(/@keyframes tt-ev-in \{ 0% \{ opacity: 0; transform: translateY\(-12px\) scale\(1\.02\); \} 70% \{[^}]*scale\(1\.02\); \} 100% \{ opacity: 1; transform: none; \} \}/);
    expect(css1).toMatch(/\.tt-ev--new \{ animation: tt-ev-in 220ms ease-out both; \}/);
    expect(css1).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.tt-ev--new \{ animation: tt-fade-in 120ms linear both; \}/);
    expect(css1).toMatch(/\.tt-ev \.tt-ev-line, \.tt-ev \.tt-ev-icon \{ transition: opacity 160ms ease; \}/); // a removed card fades to its struck state
    expect(html).not.toContain("tt-ev--new"); // nothing animates on first load
    expect(css1).toMatch(/\.tt-rec \.tt-crestcol \.tt-crest-coach \{ color: var\(--ui-coach-led, #4cff6a\); text-shadow: var\(--tt-name-shadow\), 0 0 6px rgb\(76 255 106 \/ \.55\); \}/); // the coach line uses the LED green token
    expect(css1).toMatch(/\.tt-rec \.tt-corner\.away \.tt-fans-pill \{ align-self: flex-end; \}/);
    const fansHtml = await mount(mods.boardC, {
      match: baseMatch("recording"), teams: { home: { ...teams.home, dedicatedFans: 5 }, away: teams.away }, tally: serverTally, events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    const noFans = await mount(mods.boardC, {
      match: baseMatch("recording"), teams, tally: serverTally, events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })));
    expect(noFans.match(/class="tt-fans-pill"/g)).toHaveLength(2); // the pill always shows, for both teams
    expect(noFans).toContain("FANS <b>0</b>"); // FANS 0 when the team file carries none
    expect(fansHtml).toMatch(/<span class="tt-fans-pill"[^>]*><img class="tt-fans-icon"[^>]*>FANS <b>5<\/b><\/span>/); // the fans pill renders the count
    expect(fansHtml).not.toContain('data-tip="Dedicated fans: 5" data-tip-pos'); // the tray no longer repeats it
    const themeCoach = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../public/theme.css", import.meta.url)), "utf8");
    expect(themeCoach).toContain("--ui-coach-led: #4cff6a;");
    // light theme only: the LED green darkened (tools/theme/derive-light.mjs) to clear WCAG AA 4.5:1 on --ui-surface and --ui-surface-2
    const lightBlock = /:root\[data-theme="light"\] \{[^}]*\}/.exec(themeCoach)?.[0] ?? "";
    const tok = (n: string): string => new RegExp(`${n}: (#[0-9a-f]{6});`).exec(lightBlock)?.[1] ?? "";
    const lightCoach = tok("--ui-coach-led");
    expect(lightCoach).toMatch(/^#[0-9a-f]{6}$/);
    const lum = (hex: string): number => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
    const ratio = (f: string, g: string): number => { const x = lum(f), y = lum(g); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    expect(ratio(lightCoach, tok("--ui-surface"))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(lightCoach, tok("--ui-surface-2"))).toBeGreaterThanOrEqual(4.5);
    expect(css1).toMatch(/--tt-team-fs: 34px;/);
    expect(css1).toMatch(/--tt-team-fs: 40px;/);
    expect(css1).toMatch(/--tt-team-fs: 34px; --tt-team-fs-md: 28px; --tt-team-fs-lg: 24px;/); // name steps: over 14 characters 28 px, over 20 characters 24 px
    expect(css1).toMatch(/--tt-team-fs: 40px; --tt-team-fs-md: 32px; --tt-team-fs-lg: 28px;/); // 1600: 40 / 32 / 28
    expect(css1).toMatch(/\.tt-team\[data-fit="md"\] \{ font-size: var\(--tt-team-fs-md\); \}/);
    expect(css1).toMatch(/\.tt-team\[data-fit="lg"\] \{ font-size: var\(--tt-team-fs-lg\); \}/);
    // symmetric hero: 24 px gap each side of the scoreboard, name groups fill their track, trays stretch to the panel edge
    expect(css1).toMatch(/\.tt-rec > \.tt-board \{ column-gap: 24px; \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-corner\.home \{ grid-template-columns: calc\(var\(--tt-crest\) \+ 18px\) minmax\(0, 1fr\); \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-corner\.away \{ grid-template-columns: minmax\(0, 1fr\) calc\(var\(--tt-crest\) \+ 18px\); \}/);
    expect(css1).toMatch(/\.tt-rec \.tt-namegroup \{[^}]*justify-self: stretch; width: 100%;/);
    expect(css1).toMatch(/\.tt-board \{ grid-template-columns: minmax\(0, 1fr\) var\(--tt-score-w, 420px\) minmax\(0, 1fr\);/);
    const nameFit = async (n: string) => (await mount(mods.boardC, {
      match: { ...baseMatch("recording"), home: { ...baseMatch("recording").home, teamName: n } }, teams, tally: serverTally,
      events: [], pregame: {}, clock: clockOf("home", 3), localSide: "home", organiser: false, canAct: true, inducementIcons: {}, art: {},
    }, (app) => app.use(mods.vueRouter.createRouter({ history: mods.vueRouter.createMemoryHistory(), routes: [{ path: "/tabletop", component: { render: () => null } }] })))).match(/class="tt-team tt-nameline"[^>]*data-fit="(\w+)"/)?.[1] ?? "";
    expect(await nameFit("Spike Rats")).toBe(""); // 10 characters
    expect(await nameFit("AmOrcs with a Bribe")).toBe("md"); // 19 characters: 28 px, two lines
    expect(await nameFit("The Extremely Long Name")).toBe("lg"); // 23 characters
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
    expect(css).toMatch(/\.tt-rail-injury \{[^}]*background: var\(--ui-warn\); color: var\(--ui-text-on-primary, #ffffff\)/); // white lettering on the amber face, kept legible by the dark lettering shadow
    expect(css).toMatch(/\.tt-rec \.tt-other-btn\[data-type="injury"\] \{ background: var\(--ui-warn\); color: var\(--ui-text-on-primary, #ffffff\);[^}]*text-shadow: var\(--tt-lettering-shadow/); // and the Other-grid tile
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
    expect(victim).toContain(">Catcher</strong>"); // the position stands in for the name
    expect(victim).toMatch(/class="slot-number tt-roster-nr"[^>]*>7<\/span>/); // the number is its own tile, left of the sprite
    expect(victim).not.toContain("Lirael"); // the name never reaches the markup
    const zeroPa = await mount(mods.rosterRowC, { player: { ...rich.away.players[0], pa: 0, printedStats: { ma: 8, st: 2, ag: 2, pa: 3, av: 8 } }, side: "away", variant: "pick" });
    expect(zeroPa).toContain("<b>-</b><small>PA</small>"); // a stored 0 reads "-", never "0+"
    expect(zeroPa).not.toContain("0+");
    expect(zeroPa).not.toContain('class="improved"'); // and is not marked as an improvement
    const reduced = await mount(mods.rosterRowC, { player: { ...rich.away.players[0], ma: 5, printedStats: { ma: 6, st: 2, ag: 2, pa: 3, av: 8 } }, side: "away", variant: "pick" });
    expect(reduced).toMatch(/class="worse"[^>]*><b>5<\/b><small>MA<\/small>/); // a positive reduced stat still shows 5, marked as a decrease
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
    expect(css).toMatch(/\.tt-rec \.tt-modal-box, \.tt-rec \.tt-sheet, \.tt-rec \.tt-rosters:not\(\.tt-rosters-embed\), \.tt-rec \.tt-other-box \{\s*width: calc\(var\(--tt-col\) - 40px\); max-width: none; margin-inline: auto;/);
    expect(css).toMatch(/\.tt-rec \.tt-settings \.tt-seg \{ max-width: 720px; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.tt-rec \.tt-other-btn \.tt-glyph \{ width: 48px; height: 48px; \}/); // bigger Other icons
    expect(css).toMatch(/@media \(min-width: 1600px\) \{\s*\.tt-rec \.tt-other-btn \.tt-glyph \{ width: 56px; height: 56px; \}/);
    expect(css).toMatch(/\.tt-rec \.tt-other > li:nth-child\(3n\+2\) \.tt-other-btn \{ background: color-mix\(in srgb, var\(--tt-home\) 70%[^}]*border-color: var\(--ui-info/); // left column: the TD blue
    expect(css).toMatch(/\.tt-rec \.tt-other > li:nth-child\(3n\) \.tt-other-btn \{ background: var\(--tt-btn\); \}/); // centre: neutral
    expect(css).toMatch(/\.tt-rec \.tt-other > li:nth-child\(3n\+1\) \.tt-other-btn \{ background: color-mix\(in srgb, var\(--tt-away\) 70%[^}]*border-color: var\(--ui-danger/); // right column: the CAS red
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

  it("confirm modal: the assign title, the player's row, the SPP line with the gain, YES and CHOOSE SOMEONE ELSE; the title and gain helpers", async () => {
    const { assignTitle, sppGain } = await import("../spa/src/tabletop/confirm");
    expect(assignTitle("touchdown", "Touchdown", "Gutter Runner 1")).toBe("ASSIGN TOUCHDOWN TO GUTTER RUNNER 1?");
    expect(assignTitle("casualty", "Casualty", "Grob on #3 Big Un Blocker")).toBe("ASSIGN CASUALTY TO GROB ON #3 BIG UN BLOCKER?");
    expect(assignTitle("mvp", "MVP", "Lirael")).toBe("ASSIGN MVP TO LIRAEL?");
    const values = { touchdown: 3, casualty: 2, completion: 1, interception: 2, deflection: 1, mvp: 4 };
    expect(sppGain("touchdown", "rostered", values)).toBe(3);
    expect(sppGain("touchdown", "star", values)).toBe(0); // a Star earns none
    expect(sppGain("casualty", "rostered", values, "foul")).toBe(0); // only a block casualty counts
    expect(sppGain("foul", "rostered", values)).toBe(0); // events with no SPP
    const html = await mount(mods.pickConfirmC, { title: "ASSIGN TOUCHDOWN TO GRUB?", player: { id: "h1", name: "Grub", number: 1, spp: 3, mng: false, dead: false, positionName: "Blitzer" }, side: "home", spp: { current: 3, gain: 3 } });
    expect(html).toContain("ASSIGN TOUCHDOWN TO GRUB?");
    expect(html).toContain('class="roster-row roster-grid tt-rp tt-rp-pick"'); // the same roster row
    expect(html).toContain('<p class="tt-confirm-spp">SPP 3 <b class="tt-gain">(+3)</b></p>');
    expect(html).toContain('<button class="tt-confirm-yes" type="button">Yes</button>');
    expect(html).toContain('<button class="tt-confirm-again" type="button">Choose someone else</button>');
    const none = await mount(mods.pickConfirmC, { title: "ASSIGN FOUL TO GRUB?", player: { id: "h1", name: "Grub", spp: 3, mng: false, dead: false }, side: "home", spp: { current: 3, gain: 0 } });
    expect(none).toContain("SPP 3 <b class=\"tt-gain\">(+0)</b>"); // an event without SPP still reads +0
  });

  it("every popup renders exactly one close button labelled Close (the shared sheet head)", async () => {
    const roster = { home: { name: "A", players: [{ id: "h1", name: "Grob", number: 1, spp: 0, mng: false, dead: false, available: true }] }, away: { name: "B", players: [{ id: "a1", name: "Lirael", number: 7, spp: 0, mng: false, dead: false, available: true }] } };
    const closes = (html: string) => (html.match(/aria-label="Close"/g) ?? []).length;
    expect(closes(await mount(mods.pickC, { kind: mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: roster, visibleSides: ["home"] }))).toBe(1); // the picker
    expect(closes(await mount(mods.pickC, { kind: { type: "weather", label: "Weather", needs: "weather" }, match: baseMatch("recording"), teams: roster, visibleSides: ["home"] }))).toBe(1); // a pick form
    expect(closes(await mount(mods.rostersC, { match: baseMatch("recording"), teams: roster, tally: serverTally }))).toBe(1);
    expect(closes(await mount(mods.otherC, {}))).toBe(1);
    expect(closes(await mount(mods.settingsC, { theme: createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc }), settings: mods.settingsMod.createViewerSettings(mods.queue.memoryStorage()), editMode: false, canEdit: false }))).toBe(1);
    expect(closes(await mount(mods.turnSetC, { match: baseMatch("recording"), clock: clockOf("home", 3), busy: false, error: "" }))).toBe(1);
    expect(closes(await mount(mods.ttmC, { match: baseMatch("recording"), teams: roster, tally: serverTally, visibleSides: ["home"] }))).toBe(1);
  });

  it("spectator (role from the server): the recorder renders read-only, with no action buttons and the waiting copy", async () => {
    const watching = session({ coach: "Mallory" });
    const play = { match: baseMatch("recording"), role: "spectator", events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    const { html } = await renderMatch(play, watching);
    expect(html).toContain("You are watching this match. It updates as the coaches record it.");
    expect(html).toContain("Alice Orcs"); // the scoreboard
    expect(html).toContain("Match log");
    expect(html).not.toContain('class="tt-actions-bar"'); // no TD / CAS / Injury / Other
    expect(html).not.toContain('class="tt-rail-btns"');
    expect(html).not.toContain("End turn");
    expect(html).not.toContain('class="tt-admin"');
    // an organiser's session flag never turns a spectator view into an admin one
    expect((await renderMatch(play, session({ coach: "Zed", organizer: true }))).html).not.toContain('class="tt-admin"');
    // the same match for its coach still has the buttons
    expect((await renderMatch({ ...play, role: "home" })).html).toContain('class="tt-actions-bar"');
    // pre-game: the kick/receive dialog shows as waiting; no organiser tools, no rolls
    const kr = { ...play, phase: "pregame:coin", clock: undefined, pregame: { step: "kickreceive", seatsSwappable: false, coin: { caller: "away", call: "tails", result: "heads", winner: "home", mode: "auto" } } };
    const pre = (await renderMatch(kr, watching)).html;
    expect(pre).toContain("Waiting for Alice to choose…");
    expect(pre).not.toContain("Kick or receive?");
    expect(pre).not.toContain(">Receive<");
    expect(pre).not.toContain("Skip pre-game");
    const fans = (await renderMatch({ ...kr, phase: "pregame:fans", pregame: { step: "fans", seatsSwappable: true } }, session({ coach: "Zed", organizer: true }))).html;
    expect(fans).toContain("Waiting for the coaches.");
    expect(fans).not.toContain(">Roll for me<");
    expect(fans).not.toContain(">Swap home and away<");
  });

  it("admin: the panel is absent for participants and present for organisers; admin events are yellow with an ADMIN tag; removed events stay unless a participant hides them, and organisers outside the match always see them", async () => {
    const body = { match: baseMatch("recording"), events, effectiveEventIds: ["e1", "e4"], teams, tally: serverTally, clock: clockOf("home", 3) };
    const coach = await renderMatch(body);
    expect(coach.html).not.toContain('class="tt-admin"'); // a participant has no admin panel
    expect(coach.html).not.toContain("Reopen match");
    const org = await renderMatch(body, session({ coach: "Zed", organizer: true }));
    expect(org.html).toContain('class="tt-admin"');
    expect(org.html).toContain("Add event");
    expect(org.html).toContain("Hide admin panel"); // collapsible for an organiser (the Show button replaces it once hidden)
    expect(coach.html).not.toContain("Hide admin panel");
    expect(coach.html).not.toContain("Show admin panel");
    expect(org.html).not.toContain("Set half / overtime"); // Change turn covers it
    expect(org.html).toContain("Change turn");
    expect(org.html).not.toContain("End match"); // the admin panel has no End match button either: the Other grid's End of match tile is the only way
    expect(org.html).toContain("Edit mode:");
    expect(org.html).toContain("End this turn (override)");
    const confirmed = await renderMatch({ ...body, match: { ...baseMatch("confirmed"), confirmedBy: { by: "Zed", at: "2026-10-23T10:00:00.000Z", admin: true } } }, session({ coach: "Zed", organizer: true }));
    expect(confirmed.html).toMatch(/class="tt-match-row tt-admin-line"[^>]*>Confirmed for both by Zed<b class="tt-ev-admintag">ADMIN<\/b>/); // an admin line in the log
    expect((await renderMatch(body)).html).not.toContain("tt-admin-line"); // nothing when the coaches confirmed themselves
    // the weather symbol in the turn track's centre cell: a plain symbol for a participant, a button for an organiser; the Nice icon when nothing is recorded
    expect(coach.html).toMatch(/<span class="tt-weather-cell" role="img" aria-label="Weather: Nice" data-tip="Nice"/);
    expect(coach.html).not.toContain('<button class="tt-weather-cell"');
    expect(org.html).toMatch(/<button class="tt-weather-cell" type="button" aria-label="Weather: Nice"/);
    const withWeather = await renderMatch({ ...body, pregame: { weather: "Pouring Rain" } }, session({ coach: "Zed", organizer: true }));
    expect(withWeather.html).toMatch(/class="tt-weather-cell"[^>]*data-tip="Pouring Rain"[^>]*>\u{1F327}/u); // the recorded weather's icon and name
    const cssW = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(cssW).toMatch(/\.tt-rec \.tt-turns > \.tt-weather-cell \{ grid-column: 2; grid-row: 1;[^}]*font-size: 24px;/);
    expect(cssW).toMatch(/@media \(min-width: 1600px\) \{ \.tt-rec \.tt-turns > \.tt-weather-cell \{ font-size: 28px; \} \}/);
    const cssA = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(cssA).toMatch(/\.tt-admin-row \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/); // TD and CAS side by side
    expect(cssA).toMatch(/\.tt-admin-row > \.tt-admin-btn:nth-child\(n\+3\) \{ grid-column: 1 \/ -1; \}/); // Injury and Other on their own full-width rows
    expect(cssA).toMatch(/\.tt-admin-row > \.tt-admin-btn \{ height: 40px; min-height: 40px; white-space: nowrap; \}/);
    const adminRows = mods.feedMod.feedRows([{ id: "e9", type: "touchdown", team: "away", player: "a1", payload: {}, half: 1, turn: 2, admin: true }], ["e9"], teams, {}, undefined);
    const feed = await mount(mods.feedC, { rows: adminRows, canUndo: false });
    expect(feed).toContain("tt-ev--admin");
    expect(feed).toContain('<b class="tt-ev-admintag">ADMIN</b>');
    // removed events: hidden by a participant who turned the setting off, always shown to an organiser outside the match
    const hide = (sess: unknown) => render("/tabletop/tm_abc123", { "/api/auth/session": sess, "/api/tabletop/matches/tm_abc123": body }, async (spa, f) => {
      const recorder = mods.rec.createRecorder("tm_abc123", { api: f, onSignedOut: () => undefined, storage: mods.queue.memoryStorage() });
      await recorder.refresh();
      spa.app.provide(mods.rec.RECORDER_KEY, () => recorder);
      const settings = mods.settingsMod.createViewerSettings(mods.queue.memoryStorage());
      settings.set("showRemoved", false);
      spa.app.provide(mods.settingsMod.VIEWER_SETTINGS_INJECT, settings);
    });
    expect((await hide(session())).html).not.toContain("tt-ev--removed"); // a participant who hides them
    expect((await hide(session({ coach: "Zed", organizer: true }))).html).toContain("tt-ev--removed"); // an organiser outside the match: forced on
    const struck = await mount(mods.feedC, { rows: mods.feedMod.feedRows(events, ["e1", "e4"], teams), canUndo: false });
    expect(struck).toContain("tt-ev--removed");
    const css = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../spa/src/tabletop/tabletop.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.tt-ev--admin \{ background: color-mix\(in srgb, var\(--ui-admin, #ffd23d\) 22%, var\(--ui-surface-2/);
    expect(css).toMatch(/\.tt-ev--removed \.tt-ev-line \{ text-decoration: line-through; opacity: \.55; \}/); // only the event line is struck
    expect(css).toMatch(/\.tt-ev--removed \.tt-ev-removed \{ display: block; font-family: var\(--font-heading, sans-serif\); font-size: 11px; font-style: normal; text-decoration: none; opacity: 1;/); // the note is not
    const theme = (await import("node:fs")).readFileSync(fileURLToPath(new URL("../public/theme.css", import.meta.url)), "utf8");
    expect(theme).toContain("--ui-admin: #ffd23d;");
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
    expect(css).toMatch(/\.tt-ev\[data-row-side="home"\], \.tt-ev\[data-row-side="away"\] \{ flex-direction: row; text-align: left; \}/); // away reads left to right like home
    expect(css).not.toMatch(/\.tt-ev\[data-row-side="away"\] \{[^}]*row-reverse/);
    expect(css).toMatch(/\.tt-ev:not\(\[data-row-side="neutral"\]\) \.tt-ev-icon \{ align-self: center; margin-right: 12px;/); // the icon: home right edge
    expect(css).toMatch(/\.tt-ev\[data-row-side="away"\] \.tt-ev-icon \{ order: -1; margin-left: 12px;/); // away left edge, nearest the spine
    expect(css).toMatch(/\.tt-ev\[data-row-side="neutral"\] \.tt-ev-icon \{ order: -1; \}/); // centred cards keep it above the text
    expect(html).toContain('<span class="tt-ev-mark">H1 T3</span>');
    expect(html).toContain('<b class="tt-ev-pname-name" data-seat="home">Grob</b><small>'); // the chip: name in the seat tint over the position (no number)
    expect(html).not.toContain("<small>#1");
    expect(html).toContain('class="tt-ev-sprite"'); // with a sprite frame (initials when the roster has none)
    expect(html).toMatch(/class="tt-ev-line"><!---->scores\ a\ touchdown!/); // the actor is the chip's name, not the sentence's
    expect(html).not.toContain('data-team="home" data-pcard="home:h1">Grob</span>');
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

  it("theme: the default follows the device setting (dark -> Black/Red, light -> Light) and the browser chrome colour", () => {
    const dark = fakeDoc();
    const t1 = createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: dark.doc });
    expect(t1.state.mode).toBe("system");
    expect(t1.state.resolved).toBe("dark");
    expect(dark.attrs["data-theme"]).toBe("brand-red");
    expect(dark.metas.themeColor).toBe(THEME_COLORS.dark);
    const light = fakeDoc();
    const t2 = createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: light.doc });
    expect(t2.state.resolved).toBe("light");
    expect(light.attrs["data-theme"]).toBe("light");
    expect(light.metas.themeColor).toBe(THEME_COLORS.light);
  });

  it("theme: a system change event flips the theme live while on System", () => {
    const media = fakeMedia(true);
    const d = fakeDoc();
    const t = createTheme({ matchMedia: media.matchMedia, storage: memStore(), doc: d.doc });
    expect(t.state.resolved).toBe("dark");
    media.flip(false);
    expect(t.state.resolved).toBe("light");
    expect(d.attrs["data-theme"]).toBe("light");
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

  it("theme: the recorder follows the device (light = the derived Light preset, dark = SNES dark) and shows the three-state control", async () => {
    const body = { match: baseMatch("recording"), events, effectiveEventIds: [], teams, tally: serverTally };
    const dark = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(true).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(dark.html).toContain('data-tt-theme="dark"');
    expect(dark.html).toContain("Theme: System");
    const light = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(light.html).toContain('data-tt-theme="light"');
    const forced = await renderMatch(body, session(), [], createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore({ [THEME_STORAGE_KEY]: "dark" }), doc: fakeDoc().doc }));
    expect(forced.html).toContain('data-tt-theme="dark"');
    expect(forced.html).toContain("Theme: Dark");
    // the whole SPA: the shell header carries the same control on every page (standings is public)
    const standings = await render("/standings", { "/api/auth/session": { authenticated: false } }, undefined, createTheme({ matchMedia: fakeMedia(false).matchMedia, storage: memStore(), doc: fakeDoc().doc }));
    expect(standings.html).toContain("Theme: System");
  });

  const pregameProps = (phase: string, pregame: Record<string, unknown> = {}) => ({ match: baseMatch("recording"), teams, phase, pregame, busy: false, error: "" });

  it("pre-game wizard: every dice step offers Roll for me and Enter result; journeymen is one button", async () => {
    for (const phase of ["fans", "weather", "prayers"]) {
      const html = await mount(mods.pregameC, pregameProps(`pregame:${phase}`, { fans: "Home 5, Away 2" }));
      expect(html, phase).toContain(">Roll for me<");
      expect(html, phase).toContain(">Enter result<");
      expect(html, phase).toContain('data-state="now"');
    }
    expect(await mount(mods.pregameC, pregameProps("pregame:journeymen"))).toContain("Take on journeymen");
    const later = await mount(mods.pregameC, pregameProps("pregame:weather", { fans: "Home 5, Away 2" }));
    expect(later).toContain("Home 5, Away 2"); // the earlier result, from the server
  });

  it("pre-game wizard: an inducement picker per team (catalogue + cart), from the server's options", async () => {
    const html = await mount(mods.pregameC, pregameProps("pregame:inducements", {
      inducementOptions: { home: [{ id: "bribes", name: "Bribes", cost: 100000, max: 3 }], away: [] },
    }));
    expect(html).toContain("Bribes");
    expect(html).toContain("100k");
    expect(html).toContain("Confirm Alice Orcs");
    expect(html).toContain("Confirm Bob Elves"); // one phone submits both teams
    expect(html).toContain("No inducements offered.");
    expect(html.match(/>No inducements</g)).toHaveLength(2);
    const again = await mount(mods.pregameC, pregameProps("pregame:inducements", { inducements: { home: { picks: [] } }, inducementOptions: { home: [{ id: "bribes", name: "Bribes", max: 3 }], away: [] } }));
    expect(again).toContain("Resubmit Alice Orcs"); // a resubmission replaces
    expect(again).toContain("Confirm Bob Elves");
  });

  it("coin flipper: the away coach sees Heads / Tails, the other coach waits; hand entry is a small link at the bottom", async () => {
    const html = await mount(mods.pregameC, pregameProps("pregame:coin", { coin: { caller: "away" } }));
    expect(html).toContain("Away team Bob Elves (Bob) calls the toss");
    expect(html).toContain("Heads ");
    expect(html).toContain("Tails ");
    expect(html).not.toContain('class="tt-coin"');
    expect(html).toContain("Flipping a real coin? Call it here, then enter the result");
    expect(html.indexOf("Flipping a real coin?")).toBeGreaterThan(html.indexOf("Tails"));
    const other = await mount(mods.pregameC, { ...pregameProps("pregame:coin", { coin: { caller: "away" } }), mySide: "home" });
    expect(other).toContain("Away team Bob Elves (Bob) calls the toss");
    expect(other).toContain("Waiting for Bob to call…");
    expect(other).not.toContain("Heads <");
    const caller = await mount(mods.pregameC, { ...pregameProps("pregame:coin", { coin: { caller: "away" } }), mySide: "away" });
    expect(caller).toContain("Heads ");
    const org = await mount(mods.pregameC, { ...pregameProps("pregame:coin", { coin: { caller: "away" } }), mySide: null, organiser: true });
    expect(org).toContain("Heads "); // an organiser may call for the coaches
    expect(org).toContain("Skip pre-game");
    expect(other).not.toContain("Skip pre-game");
    // no caller draw any more (owner ruling 10-30): with no coin block yet the away coach is still the caller
    const bare = await mount(mods.pregameC, { ...pregameProps("pregame:coin"), mySide: "home" });
    expect(bare).toContain("Away team Bob Elves (Bob) calls the toss");
    expect(bare).not.toContain("Draw the caller");
  });

  it("kick/receive: the winner gets the Kick or receive? dialog; everyone else waits", async () => {
    for (const result of ["heads", "tails"]) {
      const kr = { step: "kickreceive", coin: { caller: "home", result, call: "heads", winner: "away" } };
      const html = await mount(mods.pregameC, { ...pregameProps("pregame:coin", kr), mySide: "away" });
      expect(html).toContain(`${result.toUpperCase()} - Bob Elves wins the toss`);
      expect(html).toContain("Kick or receive?");
      expect(html).toContain(">Receive<");
      expect(html).toContain(">Kick<");
      expect(html).not.toContain("calls the toss");
      const loser = await mount(mods.pregameC, { ...pregameProps("pregame:coin", kr), mySide: "home" });
      expect(loser).toContain("Bob (Bob Elves) won the toss");
      expect(loser).toContain("Waiting for Bob to choose…");
      expect(loser).not.toContain("Kick or receive?");
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
    expect(html).toContain('<span>1</span><span class="tt-score-colon">:</span><span>0</span>'); // the score still follows the server only
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
    expect(settings.state).toEqual({ compact: false, timestamps: true, haptic: false, sounds: true, showRemoved: true });
    settings.set("compact", true);
    settings.set("timestamps", false);
    const again = mods.settingsMod.createViewerSettings(store);
    expect(again.state).toEqual({ compact: true, timestamps: false, haptic: false, sounds: true, showRemoved: true });
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
  const names = (html: string) => [...html.matchAll(/class="tt-roster-name" data-seat="\w+">(?:<!---->)?(\w+)<\/strong>/g)].map((m) => m[1]);

  it("player lists: own roster only, available players only, filtered by the server's eligible flag; unavailable are omitted, not greyed", async () => {
    const open = (kind: string, visibleSides: string[]) => mount(mods.pickC, { kind: mods.feedMod.OTHER_EVENTS.find((o: any) => o.type === kind) ?? mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: ttmTeams, visibleSides });
    const foulHome = await open("foul", ["home"]);
    expect(names(foulHome)).toEqual(["Grob", "Snaga", "Fleet"]); // Nofoul (flag false), Hurt (unavailable), NoFlag (no `available`) are gone
    expect(foulHome).not.toContain("Lirael"); // never the other roster
    expect(foulHome).not.toContain("disabled"); // omitted, not greyed
    expect(foulHome).not.toContain("tt-pick-head"); // one roster: no team header
    const td = await mount(mods.pickC, { kind: mods.feedMod.TD_EVENT, match: baseMatch("recording"), teams: ttmTeams, visibleSides: ["away"] });
    expect(names(td)).toEqual(["Lirael", "Wisp"]); // Faen is unavailable
    // an organiser in edit mode gets both rosters as tabs, still availability-filtered
    const both = await open("foul", ["home", "away"]);
    expect(both).toMatch(/class="tt-roster-tab-name">Alice Orcs/); // an organiser picking from both teams gets team tabs, not headers
    expect(both).toMatch(/class="tt-roster-tab-name">Bob Elves/);
    expect(both).not.toContain("tt-pick-head");
    expect(both.match(/class="tt-roster-tab tt-team-tab"/g)).toHaveLength(2); // the picker's tabs are the Rosters pane's shared tab component
    expect(both).toContain("tt-crest-frame"); // crest frame, name, coach: the Rosters tab look
    expect(names(both)).toEqual(["Grob", "Snaga", "Fleet"]); // the first tab lists its own roster; the other is one tap away
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
    expect(theirs.html).toContain("Opponent&#39;s Turn"); // a coach off turn: not the team name
    expect(theirs.html).not.toContain("Bob Elves to play");
    expect(theirs.html).toContain("TURN 3");
    const organiser = await renderMatch(body(clockOf("away", 3)), session({ coach: "Zed", organizer: true }));
    expect(organiser.html).not.toContain("End Turn"); // an organiser never gets the enabled button on the opponent's turn
    expect(organiser.html).not.toContain('class="tt-endturn"');
    expect(organiser.html).not.toContain('class="tt-rail-end"');
    expect(organiser.html).toContain('<span class="tt-rail-label tt-rail-label-sm">Bob&#39;s</span><span class="tt-rail-label tt-rail-label-sm">Turn</span>'); // outside the match: the active coach's name, "Turn", then the number
    expect(organiser.html).toContain("Bob&#39;s Turn"); // and on the phone hero button
    expect(organiser.html).not.toContain("Bob Elves to play");
    expect(organiser.html).not.toContain("Opponent&#39;s Turn");
    expect(organiser.html).toContain("End this turn (override)"); // the organiser's way in, in the admin panel
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
    expect(kick.html).toContain("Kick-off"); // turn 0: no turn number yet
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
    expect(other.html).toContain("Opponent&#39;s Turn");
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
      "Away team Bob Elves (Bob) calls the toss: heads. The coin lands heads. Alice wins the toss.",
      "Alice chooses to kick. Bob Elves will receive.",
    ].reverse()); // newest first
    // hand mode, merged event
    expect(lines([mk("c", "coinFlip", "away", { mode: "hand", call: "heads", caller: "away", result: "tails", winner: "home", choice: "receive" })])[0])
      .toBe("Away team Bob Elves (Bob) calls the toss: heads. They flipped a real coin: tails. Alice wins the toss. Alice chooses to receive. Bob Elves will kick.");
    expect(lines([mk("d", "coinFlip", "home", { mode: "auto", call: "tails", caller: "away", result: "heads", winner: "home", choice: "kick" })])[0])
      .toBe("Away team Bob Elves (Bob) calls the toss: tails. The coin lands heads. Alice wins the toss. Alice chooses to kick. Bob Elves will receive.");
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


// Popup focus management (phone bottom sheets and every other popup): a minimal fake DOM stands in for a browser here (no jsdom in the repo);
// the real thing was also driven in Chromium at 375 px (Other opens, focus moves in, Tab wraps, Escape and the X close, focus returns).
describe("sheet focus manager", () => {
  class FakeEl {
    children: FakeEl[] = []; parentElement: FakeEl | null = null; attrs = new Map<string, string>(); dataset: Record<string, string> = {}; isConnected = true;
    constructor(readonly tag: string, readonly cls: string[], readonly ownerDocument: FakeDoc) {}
    add(c: FakeEl): FakeEl { c.parentElement = this; this.children.push(c); return c; }
    remove(): void { const p = this.parentElement!; p.children.splice(p.children.indexOf(this), 1); this.walk((e) => { e.isConnected = false; }); this.parentElement = null; }
    walk(fn: (e: FakeEl) => void): void { fn(this); this.children.forEach((c) => c.walk(fn)); }
    get classList() { return { contains: (c: string) => this.cls.includes(c) }; }
    setAttribute(k: string, v: string) { this.attrs.set(k, v); }
    removeAttribute(k: string) { this.attrs.delete(k); }
    hasAttribute(k: string) { return this.attrs.has(k); }
    contains(o: FakeEl | null) { for (let n = o; n; n = n.parentElement) if (n === this) return true; return false; }
    closest(sel: string) { const cs = sel.split(",").map((x) => x.trim().slice(1)); for (let n: FakeEl | null = this; n; n = n.parentElement) if (cs.some((c) => n!.cls.includes(c))) return n; return null; }
    querySelectorAll(sel: string): FakeEl[] {
      const out: FakeEl[] = [];
      const sheet = sel.includes(".tt-sheet");
      this.children.forEach((c) => c.walk((e) => { if (sheet ? e.cls.includes("tt-sheet") || e.cls.includes("tt-modal") : e.tag === "button" || e.tag === "input") out.push(e); }));
      return out;
    }
    focus() { this.ownerDocument.activeElement = this; }
  }
  class FakeDoc {
    activeElement: FakeEl | null = null; body = new FakeEl("body", [], this); defaultView = undefined;
    listeners: Array<(e: any) => void> = [];
    addEventListener(_t: string, fn: (e: any) => void) { this.listeners.push(fn); }
    removeEventListener(_t: string, fn: (e: any) => void) { this.listeners = this.listeners.filter((l) => l !== fn); }
    press(key: string, shiftKey = false) { const e = { key, shiftKey, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; this.listeners.forEach((l) => l(e)); return e; }
  }
  const setup = () => {
    const doc = new FakeDoc();
    const root = new FakeEl("div", ["tt-rec"], doc);
    const board = root.add(new FakeEl("header", ["tt-board"], doc));
    const bar = root.add(new FakeEl("nav", ["tt-actions-bar"], doc));
    const other = bar.add(new FakeEl("button", ["tt-big-other"], doc));
    other.focus();
    const sheet = (cls: string) => {
      const el = root.add(new FakeEl("div", [cls], doc));
      const first = el.add(new FakeEl("button", ["tt-other-btn"], doc));
      el.add(new FakeEl("button", ["tt-x"], doc));
      const last = el.add(new FakeEl("button", ["tt-close"], doc));
      return { el, first, last };
    };
    return { doc, root, board, bar, other, sheet };
  };

  it("opens: focus moves into the sheet, the page behind is inert, the scroll flag is set; closing restores focus to the opener", async () => {
    const { createSheetFocus } = await import("../spa/src/tabletop/sheetFocus");
    const { doc, root, board, bar, other, sheet } = setup();
    const sf = createSheetFocus(root as any);
    const s = sheet("tt-modal");
    sf.sync();
    expect(doc.activeElement).toBe(s.first);
    expect(board.hasAttribute("inert")).toBe(true);
    expect(bar.hasAttribute("inert")).toBe(true);
    expect(s.el.hasAttribute("inert")).toBe(false);
    expect(s.el.attrs.get("aria-modal")).toBe("true");
    expect(root.attrs.get("data-sheet-open")).toBe("true");
    s.el.remove(); // Escape and the X both just unmount the sheet
    sf.sync();
    expect(doc.activeElement).toBe(other);
    expect(board.hasAttribute("inert") || bar.hasAttribute("inert") || root.hasAttribute("data-sheet-open")).toBe(false);
  });

  it("Tab wraps inside the topmost sheet, Shift+Tab wraps back, and a sheet over a sheet takes focus and makes the lower one inert", async () => {
    const { createSheetFocus } = await import("../spa/src/tabletop/sheetFocus");
    const { doc, root, other, sheet } = setup();
    const sf = createSheetFocus(root as any);
    const low = sheet("tt-sheet");
    sf.sync();
    low.last.focus();
    expect(doc.press("Tab").defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(low.first);
    expect(doc.press("Tab", true).defaultPrevented).toBe(true);
    expect(doc.activeElement).toBe(low.last);
    other.focus(); // focus that escaped (it is inert in a browser) is pulled back in
    doc.press("Tab");
    expect(doc.activeElement).toBe(low.first);
    const high = sheet("tt-sheet");
    sf.sync();
    expect(doc.activeElement).toBe(high.first);
    expect(low.el.hasAttribute("inert")).toBe(true);
    high.el.remove();
    sf.sync();
    expect(doc.activeElement).toBe(low.first);
    expect(low.el.hasAttribute("inert")).toBe(false);
    low.el.remove();
    sf.sync();
    expect(doc.activeElement).toBe(other); // the opener, not the lower sheet's button
    sf.detach();
  });
});
