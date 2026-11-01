import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSSRApp, effectScope, nextTick, ref } from "vue";
import type { ViteDevServer } from "vite";

// Match log order (owner 10-31): every log reads top to bottom, oldest first, latest at the bottom. Live logs follow the
// latest entry only while the viewer is at the bottom, else a "New events" pill; a finished game opens at the top.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const SRC = (p: string): string => readFileSync(fileURLToPath(new URL(`../spa/src/${p}`, import.meta.url)), "utf8");
let vite: ViteDevServer;
let mods: Record<string, any>;

beforeAll(async () => {
  const { createServer } = await import("vite");
  vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
  const [renderer, feed, feedC, stick, announce] = await Promise.all([
    vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/tabletop/feed.ts"),
    vite.ssrLoadModule("/src/components/TabletopFeed.vue"), vite.ssrLoadModule("/src/tabletop/stickBottom.ts"), vite.ssrLoadModule("/src/tabletop/announce.ts"),
  ]);
  mods = { renderer, feed, feedC, stick, announce };
}, 60_000);
afterAll(async () => { await vite?.close(); });

const teams = { home: undefined, away: undefined } as any;
const ev = (id: string, type: string, team: "home" | "away", extra: Record<string, unknown> = {}) => ({ id, type, team, payload: {}, ...extra });

describe("feed order", () => {
  const events = [
    ev("w", "weather", "home", { payload: { pregame: true, result: "Blizzard" } }),
    ev("k", "kickoff", "home", { half: 1, turn: 0 }),
    ev("t1", "touchdown", "home", { player: "h1", half: 1, turn: 2 }),
    ev("c1", "casualty", "away", { player: "a1", half: 1, turn: 3, payload: { victim: "h2", result: "BH" } }),
    ev("t2", "touchdown", "away", { player: "a1", half: 2, turn: 1 }),
  ];
  it("rows run oldest first: pre-game rows at the top, the latest event last, a casualty's victim beneath its causer", () => {
    const rows = mods.feed.feedRows(events, events.map((e) => e.id), teams);
    expect(rows.map((r: any) => `${r.id}:${r.part}`)).toEqual(["w:main", "k:main", "t1:main", "c1:main", "c1:victim", "t2:main"]);
  });
  it("an event arriving live is appended at the bottom", () => {
    const next = [...events, ev("t3", "touchdown", "home", { player: "h1", half: 2, turn: 4 })];
    const rows = mods.feed.feedRows(next, next.map((e) => e.id), teams);
    expect(rows.at(-1).id).toBe("t3");
    expect(rows[0].id).toBe("w");
  });
  it("retracted rows keep their relative place, struck through", () => {
    const undo = ev("u", "undo", "home", { payload: { target: "t1" }, by: "Alice", ts: "2026-10-31T10:00:00.000Z" });
    const rows = mods.feed.feedRows([...events, undo], events.map((e) => e.id).filter((i) => i !== "t1"), teams);
    expect(rows.map((r: any) => r.id)).toEqual(["w", "k", "t1", "c1", "c1", "t2"]);
    expect(rows[2].removed).not.toBeNull();
  });
  it("the strip timeline runs earliest to latest, left to right", () => {
    const rows = mods.feed.feedRows(events, events.map((e) => e.id), teams);
    expect(mods.feed.timelineMarkers(rows).map((m: any) => m.id)).toEqual(["w", "k", "t1", "c1", "t2"]);
  });
  it("the rendered log lists the oldest card first; new ids still get the highlight class", async () => {
    const rows = mods.feed.feedRows(events, events.map((e) => e.id), teams);
    const html: string = await mods.renderer.renderToString(createSSRApp(mods.feedC.default, { rows, canUndo: false, newIds: new Set(["t2"]) }));
    expect(html.indexOf('id="tt-ev-w"')).toBeLessThan(html.indexOf('id="tt-ev-t2"'));
    expect(html.match(/tt-ev--new/g)).toHaveLength(1);
  });
});

describe("stick to the bottom", () => {
  const el = (over: Partial<{ scrollTop: number; scrollHeight: number; clientHeight: number }> = {}) => ({ scrollTop: 0, scrollHeight: 1000, clientHeight: 400, ...over }) as any;
  it("nearBottom: within 80 px counts as at the bottom", () => {
    const { nearBottom, STICK_PX } = mods.stick;
    expect(STICK_PX).toBe(80);
    expect(nearBottom(el({ scrollTop: 600 }))).toBe(true);
    expect(nearBottom(el({ scrollTop: 520 }))).toBe(true);
    expect(nearBottom(el({ scrollTop: 519 }))).toBe(false);
    expect(nearBottom(el({ scrollTop: 0 }))).toBe(false);
  });
  const setup = () => {
    const ids = ref<string[]>([]);
    const node = el();
    const scrollTo = [] as any[];
    node.scrollTo = (o: any) => { scrollTo.push(o); node.scrollTop = o.top; };
    const scroller = ref<any>(node);
    const scope = effectScope();
    const api = scope.run(() => mods.stick.useStickToBottom(scroller, () => ids.value))!;
    return { ids, node, scrollTo, api, scope };
  };
  const settle = async () => { await nextTick(); await nextTick(); };
  it("the first rows of a live log land on the latest (bottom), instantly", async () => {
    const t = setup();
    t.ids.value = ["a", "b", "c"];
    await settle();
    expect(t.node.scrollTop).toBe(1000);
    expect(t.scrollTo).toHaveLength(0);
    t.scope.stop();
  });
  it("at the bottom: a new event scrolls smoothly to the new last entry, no pill", async () => {
    const t = setup();
    t.ids.value = ["a", "b"]; await settle();
    t.node.scrollHeight = 1200; t.node.scrollTop = 760; // 1200 - 760 - 400 = 40 px from the bottom
    t.ids.value = ["a", "b", "c"]; await settle();
    expect(t.scrollTo.at(-1)).toMatchObject({ top: 1200, behavior: "smooth" });
    expect(t.api.unseen.value).toBe(false);
    t.scope.stop();
  });
  it("scrolled up: not yanked down, the New events pill appears; clicking scrolls to the latest and clears it", async () => {
    const t = setup();
    t.ids.value = ["a", "b"]; await settle();
    t.node.scrollTop = 100;
    t.ids.value = ["a", "b", "c"]; await settle();
    expect(t.node.scrollTop).toBe(100);
    expect(t.scrollTo).toHaveLength(0);
    expect(t.api.unseen.value).toBe(true);
    t.api.toLatest();
    expect(t.node.scrollTop).toBe(1000);
    expect(t.api.unseen.value).toBe(false);
    t.scope.stop();
  });
  it("scrolling back to the bottom by hand dismisses the pill", async () => {
    const t = setup();
    t.ids.value = ["a"]; await settle();
    t.node.scrollTop = 0; t.ids.value = ["a", "b"]; await settle();
    expect(t.api.unseen.value).toBe(true);
    t.node.scrollTop = 590; t.api.onScroll();
    expect(t.api.unseen.value).toBe(false);
    t.scope.stop();
  });
  it("reduced motion: the scroll to the new entry is instant", async () => {
    const g = globalThis as any; const prev = g.matchMedia;
    g.matchMedia = () => ({ matches: true });
    try {
      const t = setup();
      t.ids.value = ["a"]; await settle();
      t.node.scrollTop = 600; t.ids.value = ["a", "b"]; await settle();
      expect(t.scrollTo).toHaveLength(0);
      expect(t.node.scrollTop).toBe(1000);
      t.scope.stop();
    } finally { g.matchMedia = prev; }
  });
  it("revealing older ids (Show removed events) never raises the pill or scrolls", async () => {
    const t = setup();
    t.ids.value = ["a", "c"]; await settle();
    t.node.scrollTop = 100;
    t.ids.value = ["a", "b", "c"]; await settle(); // b is a historical row now shown
    expect(t.api.unseen.value).toBe(false);
    expect(t.node.scrollTop).toBe(100);
    t.ids.value = ["a", "b", "c", "d"]; await settle(); // a genuinely newer id still does
    expect(t.api.unseen.value).toBe(true);
    t.scope.stop();
  });
  it("a removal with no new id neither scrolls nor raises the pill", async () => {
    const t = setup();
    t.ids.value = ["a", "b"]; await settle();
    t.node.scrollTop = 0; t.ids.value = ["a"]; await settle();
    expect(t.api.unseen.value).toBe(false);
    expect(t.node.scrollTop).toBe(0);
    t.scope.stop();
  });
});

describe("announcements", () => {
  const row = (id: string, player: string, over: Record<string, unknown> = {}) => ({ id, part: "main", removed: null, player, number: "", lead: "", rest: "scores a touchdown.", ...over }) as any;
  const setup = (loaded: boolean, initial: any[] = []) => {
    const rows = ref<any[]>(initial); const ready = ref(loaded);
    const scope = effectScope();
    const text = scope.run(() => mods.announce.useAnnouncer(() => rows.value, () => ready.value))!;
    return { rows, ready, text, scope };
  };
  const settle = async () => { await nextTick(); await nextTick(); };
  it("announces the newest effective event, naming the player; never a removed one", async () => {
    const t = setup(true, [row("a", "Ann")]); // already in the log at load: silent
    await settle();
    expect(t.text.value).toBe("");
    // a poll brings an event and its undo together: the removed row is last, the announcement stays on nothing new
    t.rows.value = [row("a", "Ann"), row("b", "Bo", { removed: { by: "x", at: "", admin: false } })]; await settle();
    expect(t.text.value).toBe("");
    t.rows.value = [row("a", "Ann"), row("b", "Bo", { removed: { by: "x", at: "", admin: false } }), row("c", "Cy")]; await settle();
    expect(t.text.value).toContain("Cy: scores a touchdown.");
    t.scope.stop();
  });
  it("two identical consecutive actions both announce (different text each time)", async () => {
    const t = setup(true, [row("a", "Ann")]);
    await settle();
    t.rows.value = [row("a", "Ann"), row("b", "Ann")]; await settle();
    const first = t.text.value;
    t.rows.value = [row("a", "Ann"), row("b", "Ann"), row("c", "Ann")]; await settle();
    expect(first).toContain("Ann: scores a touchdown.");
    expect(t.text.value).toContain("Ann: scores a touchdown.");
    expect(t.text.value).not.toBe(first);
    t.scope.stop();
  });
  it("the first event after loading an empty match is announced; nothing before the load completes", async () => {
    const t = setup(false);
    t.rows.value = []; await settle();
    t.ready.value = true; await settle(); // loaded with zero events
    expect(t.text.value).toBe("");
    t.rows.value = [row("a", "Ann")]; await settle();
    expect(t.text.value).toContain("Ann: scores a touchdown.");
    t.scope.stop();
  });
  it("an undo that makes an older event the latest announces nothing", async () => {
    const t = setup(true, [row("a", "Ann")]);
    await settle();
    t.rows.value = [row("a", "Ann"), row("b", "Bo")]; await settle();
    const before = t.text.value;
    t.rows.value = [row("a", "Ann"), row("b", "Bo", { removed: { by: "x", at: "", admin: false } })]; await settle();
    expect(t.text.value).toBe(before);
    t.scope.stop();
  });
});

describe("wiring", () => {
  it("the live recorder follows the latest, shows the pill and announces the newest event politely", () => {
    const s = SRC("views/TabletopRecorderView.vue");
    expect(s).toContain('<main ref="feedEl" class="tt-feed" @scroll.passive="onFeedScroll">');
    expect(s).toMatch(/<button v-if="newBelow" class="tt-newpill" type="button" @click="feedToLatest">New events/);
    expect(s).toMatch(/role="status" aria-live="polite" data-tt-announce/);
  });
  it("the finished game page opens at the top and never scrolls itself down", () => {
    const s = SRC("components/GameReporterView.vue");
    expect(s).toContain("scrollTop = 0");
    expect(s).toContain("onMounted(toTop)");
    expect(s).toContain('<main ref="feedEl" class="tt-feed">');
    expect(s).not.toContain("stickBottom");
  });
});
