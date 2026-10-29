import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  NOTIFICATION_ICONS, notificationAge, sendCoachMessage, useNotifications, type NotificationRow, type NotifySocket,
} from "../spa/src/home/notifications";

// Lane 2 (Notifications) in the SPA: the store the home lane mounts (load, mark read, socket push with the 60 s poll
// fallback), the NOTIFICATIONS panel server-rendered, and the Participants "Message coach" row menu + modal.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const NOW = Date.parse("2026-10-29T12:00:00.000Z");

type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body?: unknown }> } {
  const calls: Array<{ path: string; method: string; body?: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: "n2", type: "organiser-message", title: "Message from Veers · Spike Open", body: "Kick-off moved to 7 pm.",
  link: "/app/tournaments/t1?tab=overview", at: new Date(NOW - 3 * 3600_000).toISOString(), from: "Veers", ...over,
});
const LIST = "/api/me/notifications?limit=50";

describe("notifications store", () => {
  it("load fills rows and unread; markRead / markAllRead post and update locally", async () => {
    const f = mockFetcher({
      [LIST]: { notifications: [row(), row({ id: "n1", type: "entrant-flag", readAt: "2026-10-29T10:00:00Z" })], unread: 1 },
      "POST /api/me/notifications/read": (body: unknown) => ({ marked: 1, unread: (body as { all?: boolean }).all ? 0 : 0 }),
    });
    const n = useNotifications(f);
    await n.load();
    expect(n.loaded.value).toBe(true);
    expect(n.rows.value.map((r) => r.id)).toEqual(["n2", "n1"]);
    expect(n.unread.value).toBe(1);
    await n.markRead(["n2"]);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/notifications/read", method: "POST", body: { ids: ["n2"] } });
    expect(n.rows.value[0]!.readAt).toBeTruthy();
    expect(n.unread.value).toBe(0);
    await n.markAllRead();
    expect(f.calls.at(-1)!.body).toEqual({ all: true });
  });

  it("a failed load keeps the message for the panel", async () => {
    const n = useNotifications(mockFetcher({ [LIST]: new ApiError(500, "Server down.") }));
    await n.load();
    expect(n.error.value).toBe("Server down.");
    expect(n.loaded.value).toBe(false);
  });

  function socketHarness() {
    const sockets: Array<NotifySocket & { sent: string[]; url: string }> = [];
    const intervals: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const timers: Array<() => void> = [];
    const opts = {
      openSocket: (url: string) => {
        const s = { url, sent: [] as string[], onopen: null, onmessage: null, onclose: null, send(d: string) { s.sent.push(d); }, close() { s.onclose?.(); } } as NotifySocket & { sent: string[]; url: string };
        sockets.push(s);
        return s;
      },
      setInterval: (fn: () => void, ms: number) => { const h = { fn, ms, cleared: false }; intervals.push(h); return h; },
      clearInterval: (h: unknown) => { (h as { cleared: boolean }).cleared = true; },
      setTimer: (fn: () => void) => { timers.push(fn); return 0; },
    };
    return { sockets, intervals, timers, opts };
  }

  it("subscribe: hello { notify: true }, the welcome stops polling, a pushed event bumps unread and prepends the row", async () => {
    const h = socketHarness();
    const f = mockFetcher({ [LIST]: { notifications: [row({ id: "n1" })], unread: 1 } });
    const n = useNotifications(f, h.opts);
    n.subscribe();
    n.subscribe(); // idempotent
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0]!.url).toMatch(/\/super$/);
    h.sockets[0]!.onopen!();
    expect(JSON.parse(h.sockets[0]!.sent[0]!)).toEqual({ type: "hello", v: 1, notify: true });
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "notifyWelcome", v: 1, coach: "Alice" }) });
    await Promise.resolve();
    expect(n.live.value).toBe(true);
    expect(h.intervals.filter((i) => !i.cleared)).toHaveLength(0);
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "event", feature: "notify", payload: { unread: 4, latest: row({ id: "n9", title: "Pushed" }) } }) });
    expect(n.unread.value).toBe(4);
    expect(n.rows.value[0]!.title).toBe("Pushed");
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "event", feature: "notify", payload: { unread: 4, latest: row({ id: "n9" }) } }) });
    expect(n.rows.value.filter((r) => r.id === "n9")).toHaveLength(1);
    n.unsubscribe(); // subscriptions are counted: the second holder keeps the socket open
    expect(n.live.value).toBe(true);
    n.unsubscribe();
    expect(n.live.value).toBe(false);
  });

  it("a push that lands while a load is in flight survives: the stale GET is discarded and fetched once more", async () => {
    const h = socketHarness();
    let release!: (v: unknown) => void;
    let gets = 0;
    const f = mockFetcher({
      [LIST]: () => {
        gets += 1;
        if (gets === 1) return new Promise((r) => { release = r; });
        return { notifications: [row({ id: "n9", title: "Pushed" }), row({ id: "n1" })], unread: 2 };
      },
    });
    const n = useNotifications(f, h.opts);
    n.subscribe();
    const pending = n.load();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "event", feature: "notify", payload: { unread: 2, latest: row({ id: "n9", title: "Pushed" }) } }) });
    release({ notifications: [row({ id: "n1" })], unread: 1 }); // older than the push
    await pending;
    expect(gets).toBe(2);
    expect(n.rows.value.map((r) => r.id)).toEqual(["n9", "n1"]);
    expect(n.unread.value).toBe(2);
    n.unsubscribe();
  });

  it("a read broadcast from another tab marks those rows read (or all of them)", async () => {
    const h = socketHarness();
    const f = mockFetcher({ [LIST]: { notifications: [row({ id: "n3" }), row({ id: "n2" }), row({ id: "n1" })], unread: 3 } });
    const n = useNotifications(f, h.opts);
    await n.load();
    n.subscribe();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "event", feature: "notify", payload: { unread: 2, readIds: ["n2"] } }) });
    expect(n.rows.value.filter((r) => !r.readAt).map((r) => r.id)).toEqual(["n3", "n1"]);
    expect(n.unread.value).toBe(2);
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "event", feature: "notify", payload: { unread: 0, readIds: ["n3"], all: true } }) });
    expect(n.rows.value.every((r) => r.readAt)).toBe(true);
    expect(n.unread.value).toBe(0);
    n.unsubscribe();
  });

  it("falls back to a 60 s poll when the socket is refused or drops, and when there is no socket at all", async () => {
    const h = socketHarness();
    const f = mockFetcher({ [LIST]: { notifications: [], unread: 0 } });
    const n = useNotifications(f, h.opts);
    n.subscribe();
    h.sockets[0]!.onmessage!({ data: JSON.stringify({ type: "notifyRefused", reason: "off" }) });
    h.sockets[0]!.onclose!();
    const poll = h.intervals.find((i) => !i.cleared)!;
    expect(poll.ms).toBe(60_000);
    expect(h.timers).toHaveLength(0); // refused: no reconnect
    poll.fn();
    await Promise.resolve();
    expect(f.calls.some((c) => c.path === LIST)).toBe(true);
    n.unsubscribe();
    expect(poll.cleared).toBe(true);

    const noSocket = socketHarness();
    // a socket that cannot be opened: polling only
    const m = useNotifications(f, { ...noSocket.opts, openSocket: () => { throw new Error("no socket"); } });
    m.subscribe();
    expect(noSocket.intervals.filter((i) => !i.cleared).map((i) => i.ms)).toEqual([60_000]);
    m.unsubscribe();
  });

  it("ages read like the spec ('3 h') and every type has an icon from our set", () => {
    expect(notificationAge(new Date(NOW - 20_000).toISOString(), NOW)).toBe("now");
    expect(notificationAge(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe("5 min");
    expect(notificationAge(new Date(NOW - 3 * 3600_000).toISOString(), NOW)).toBe("3 h");
    expect(notificationAge(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe("2 d");
    expect(notificationAge("2026-08-12T00:00:00Z", NOW)).toBe("12 Aug");
    for (const src of Object.values(NOTIFICATION_ICONS)) {
      expect(src).toMatch(/^\/icons\//);
      expect(() => readFileSync(fileURLToPath(new URL(`../public${src}`, import.meta.url)))).not.toThrow();
    }
  });

  it("sendCoachMessage posts { coachKey, body } and returns the server's error text", async () => {
    const f = mockFetcher({ "POST /api/tournaments/t1/message": { notification: { id: "n1" } }, "POST /api/tournaments/t2/message": new ApiError(429, "Too many messages; wait a minute and try again.") });
    expect(await sendCoachMessage(f, "t1", "Alice", "  Hello  ")).toBe("");
    expect(f.calls.at(-1)).toEqual({ path: "/api/tournaments/t1/message", method: "POST", body: { coachKey: "Alice", body: "Hello" } });
    expect(await sendCoachMessage(f, "t2", "Alice", "Hi")).toBe("Too many messages; wait a minute and try again.");
    expect(await sendCoachMessage(f, "t1", "Alice", "   ")).toBe("Write a message first.");
    expect(await sendCoachMessage(f, "t1", "Alice", "x".repeat(2001))).toBe("A message is at most 2000 characters.");
  });
});

describe("NOTIFICATIONS panel + Message coach (server-rendered)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [panel, store, modal, renderer, app, detail, vueRouter] = await Promise.all([
      vite.ssrLoadModule("/src/components/NotificationsPanel.vue"),
      vite.ssrLoadModule("/src/home/notifications.ts"),
      vite.ssrLoadModule("/src/components/MessageCoachModal.vue"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("/src/tournaments/detail.ts"),
      vite.ssrLoadModule("vue-router"),
    ]);
    mods = { panel, store, modal, renderer, app, detail, vueRouter };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function renderPanel(rows: NotificationRow[], unread: number, writable = true) {
    const f = mockFetcher({ [LIST]: { notifications: rows, unread } });
    const n = mods.store.useNotifications(f);
    await n.load();
    const app = createSSRApp(mods.panel.default, { notifications: n, now: NOW, writable });
    return (await mods.renderer.renderToString(app)) as string;
  }

  it("rows: band, typed icon, title, body, age, link and the unread dot; Mark all read while anything is unread", async () => {
    const html = await renderPanel([row(), row({ id: "n1", type: "fixture-created", title: "Spike Open: round 1 fixture", body: "You play Bob in round 1.", readAt: "2026-10-29T11:00:00Z", at: new Date(NOW - 2 * 86_400_000).toISOString(), link: "/app/tournaments/t1?tab=rounds" })], 1);
    expect(html).toContain('class="nf-band"');
    expect(html).toContain("<span>Notifications</span>");
    expect(html).toContain("1 unread");
    expect(html).toContain(">Mark all read</button>");
    expect(html).toContain('src="/icons/ui/action-pass.png"');
    expect(html).toContain('src="/icons/skills/block.png"');
    expect(html).toContain("Message from Veers · Spike Open");
    expect(html).toContain("Kick-off moved to 7 pm.");
    expect(html).toContain('href="/app/tournaments/t1?tab=overview"');
    expect(html).toContain(">3 h</time>");
    expect(html).toContain(">2 d</time>");
    expect(html.match(/class="nf-dot"/g)).toHaveLength(1);
    expect(html.match(/data-unread="true"/g)).toHaveLength(1);
  });

  it("empty state reads 'Nothing yet' with no Mark all read; a test session gets no Mark all read", async () => {
    const empty = await renderPanel([], 0);
    expect(empty).toContain("Nothing yet");
    expect(empty).toContain("All read");
    expect(empty).not.toContain("Mark all read");
    const test = await renderPanel([row()], 1, false);
    expect(test).not.toContain("Mark all read");
    expect(test).toContain("Kick-off moved");
  });

  it("Message coach modal: textarea capped at 2000, Send, the coach name in the band", async () => {
    const app = createSSRApp(mods.modal.default, { tournamentId: "t1", coachKey: "Alice", teamName: "Alice Orcs" });
    app.provide(mods.app.API_KEY, mockFetcher({}));
    const html = (await mods.renderer.renderToString(app)) as string;
    expect(html).toContain("Message Alice");
    expect(html).toContain('maxlength="2000"');
    expect(html).toContain(">Send</button>");
    expect(html).toContain("0 / 2000");
    expect(html).toContain('role="dialog"');
  });

  const AS = (coach: string, extra: Record<string, unknown> = {}) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", ...extra } });
  const FLAGS = { paid: false, rosterVerified: false, frozen: false, checkedIn: false, active: true };
  const body = {
    tournament: { id: "t1", name: "Spike Open", status: "draft", format: "swiss", packageName: "nut-cup", maxPlayers: 8, roundCount: 3, currentRound: 0, tiebreakers: ["buchholz"], entrantCount: 1, ownerCoachId: "Veers", organizerCoachIds: [], remainingRounds: 3 },
    entrants: [{ id: "t1:entrant:1", seed: 1, coachId: "Alice", teamId: "tm1", teamName: "Alice Orcs", flags: FLAGS }],
    rounds: [], scheduledMatches: [], capabilities: { manage: true, assignRoles: true },
  };
  async function manage(session: Record<string, unknown>) {
    const f = mockFetcher({ ...session, "/api/tournaments/t1": body });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const d = mods.detail.createTournamentDetail({ api: f });
    await d.load("t1");
    spa.app.provide(mods.detail.TOURNAMENT_DETAIL_KEY, d);
    await spa.router.push("/tournaments/t1?tab=manage");
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("Participants row menu has 'Message coach' for a manager, not for a test session", async () => {
    const html = await manage(AS("Veers"));
    expect(html).toContain('aria-label="Message coach Alice"');
    expect(html).toContain(">Message coach</button>");
    const test = await manage(AS("Veers", { test: true }));
    expect(test).not.toContain(">Message coach</button>");
  });

  it("the top-bar bell shows the shared store's unread count, capped at 99+, and the coach page mounts the panel", async () => {
    const f = mockFetcher({ ...AS("Alice"), "/api/tabletop/saves?coach=Alice": { saves: [] }, "/api/build-log": [] });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const shared = (spa.app._context.provides as Record<symbol, ReturnType<typeof useNotifications>>)[mods.store.NOTIFICATIONS_KEY];
    shared.unread.value = 120;
    shared.rows.value = [row()];
    await spa.router.push("/home");
    await spa.router.isReady();
    const html = (await mods.renderer.renderToString(spa.app)) as string;
    expect(html).toMatch(/class="sf-bell"[^>]*aria-label="Notifications: 120"/);
    expect(html).toContain('<span class="sf-bell-count">99+</span>');
    expect(html).toContain('href="/app/home#notifications"');
    expect(html).toMatch(/id="notifications"[\s\S]*?class="nf-band"/);
    expect(html).toContain("Kick-off moved to 7 pm.");
    expect(mods.store.unreadBadge(0)).toBe("");
    expect(mods.store.unreadBadge(7)).toBe("7");
    expect(mods.store.unreadBadge(100)).toBe("99+");
  });

  it("copy and token rules", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/home/notifications.css", import.meta.url)), "utf8");
    expect(css).toMatch(/\.nf-band \{[^}]*var\(--ui-info\)/);
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b(?![^(]*\))/i); // colours only from tokens (color-mix with #000 for depth is allowed)
    for (const file of ["components/NotificationsPanel.vue", "components/MessageCoachModal.vue", "home/notifications.ts"]) {
      const src = readFileSync(fileURLToPath(new URL(`../spa/src/${file}`, import.meta.url)), "utf8");
      expect(src, file).not.toMatch(/re-roll/i);
      expect(src, file).not.toMatch(/Java client|FUMBBL art/i);
    }
  });
});
