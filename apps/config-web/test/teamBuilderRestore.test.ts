import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The ?save= deep link and the loadSave / applyBody lifecycle, run through the REAL team-builder.js UI on the
// tournament page: the whole script boots in a vm against a small DOM stub (one stub element per id, created
// on demand) and a routed fetch stub whose responses a test can hold back to force interleavings.
const publicDir = new URL("../public/", import.meta.url);
const js = readFileSync(new URL("team-builder.js", publicDir), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

function stubElement(id: string): Any {
  const listeners: Record<string, Array<(event: Any) => unknown>> = {};
  const classes = new Set<string>();
  const attributes: Record<string, string> = {};
  return {
    id, value: "", textContent: "", innerHTML: "", className: "", href: "", title: "", hidden: false, disabled: false, open: false, checked: false,
    dataset: {} as Record<string, string>, style: {} as Record<string, string>, listeners,
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, on?: boolean) => { const next = on ?? !classes.has(name); if (next) classes.add(name); else classes.delete(name); return next; },
      contains: (name: string) => classes.has(name),
    },
    setAttribute: (name: string, value: string) => { attributes[name] = String(value); },
    getAttribute: (name: string) => attributes[name] ?? null,
    removeAttribute: (name: string) => { delete attributes[name]; },
    hasAttribute: (name: string) => name in attributes,
    addEventListener: (type: string, fn: (event: Any) => unknown) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    focus: () => undefined,
    blur: () => undefined,
    scrollIntoView: () => undefined,
    showModal() { this.open = true; },
    close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    appendChild: (child: unknown) => child,
    append: () => undefined,
    remove: () => undefined,
  };
}

interface Held { path: string; release: () => void }

function bootBuilder(opts: { search?: string; routes: Record<string, (init: Any) => { status: number; body: unknown }>; hold?: (path: string) => boolean }) {
  const elements = new Map<string, Any>();
  const el = (id: string) => { if (!elements.has(id)) elements.set(id, stubElement(id)); return elements.get(id); };
  el("team-builder-title");
  const docListeners: Record<string, Array<(event: Any) => unknown>> = {};
  const document = {
    body: { dataset: { builder: "tournament" }, classList: stubElement("body").classList },
    documentElement: stubElement("html"),
    getElementById: (id: string) => el(id),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: (tag: string) => stubElement(tag),
    addEventListener: (type: string, fn: (event: Any) => unknown) => { (docListeners[type] ??= []).push(fn); },
    removeEventListener: () => undefined,
  };
  const calls: Array<{ path: string; method: string }> = [];
  const held: Held[] = [];
  const replaced: string[] = [];
  const respond = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const fetch = (path: string, init: Any = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method });
    const key = `${method} ${path.split("?")[0]}`;
    const route = opts.routes[`${method} ${path}`] ?? opts.routes[key];
    const out = route ? route(init) : { status: 200, body: {} };
    const result = respond(out.status, out.body);
    if (opts.hold?.(path)) return new Promise((resolve) => held.push({ path, release: () => resolve(result) }));
    return Promise.resolve(result);
  };
  const location = { pathname: "/tournament-team-builder.html", search: opts.search ?? "", hash: "", hostname: "localhost", href: "" };
  const context: Record<string, Any> = {
    console, document, fetch, location, URLSearchParams, setTimeout, clearTimeout, Promise, Date, JSON, Math, Map, Set,
    history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
    window: { prompt: () => null, confirm: () => true, print: () => undefined, open: () => null, addEventListener: () => undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  };
  context.globalThis = context;
  runInNewContext(js, context);
  return { el, calls, held, replaced };
}

const flush = async (rounds = 30) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

const roster = { rosterId: "orc", raceName: "Orc", positions: [{ positionId: "L", name: "Orc Lineman", cost: 50_000, MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+", skills: [], quantity: 16 }], rerollCost: 60_000 };
const saveBody = (packageName: string | undefined) => ({ rosterId: "orc", teamName: "Green Tide", packageName, picks: [{ positionId: "L", count: 2 }], reRolls: 1 });
const baseRoutes = (save: Any): Record<string, (init: Any) => { status: number; body: unknown }> => ({
  "GET /api/auth/session": () => ({ status: 200, body: { authenticated: true, coach: "Jay", discordSsoEnabled: true } }),
  "GET /api/fork/rosters": () => ({ status: 200, body: { rosters: [roster] } }),
  "GET /api/packages": () => ({ status: 200, body: [{ name: "Small Gods 2026" }, { name: "EuroBowl 2026" }] }),
  "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: [{ id: "sv_1", name: "Green Tide", rosterId: "orc", raceName: "Orc", packageName: "Small Gods 2026" }] } }),
  "GET /api/fork/team-builder/saves/sv_1": () => save,
});

describe("tournament builder — ?save= restore lifecycle (real loadSave / applyBody)", () => {
  it("loads the save, lands on the build step and names it in the header", async () => {
    const page = bootBuilder({ search: "?save=sv_1", routes: baseRoutes({ status: 200, body: { save: { id: "sv_1", name: "Green Tide", body: saveBody("Small Gods 2026") } } }) });
    await flush();
    expect(page.el("package").value).toBe("Small Gods 2026");
    expect(page.el("team-name").value).toBe("Green Tide");
    expect(page.el("builder-panel").hidden).toBe(false);
    expect(page.el("current-save-label").textContent).toBe("Editing “Green Tide”");
    expect(page.replaced).toEqual(["/tournament-team-builder.html"]);
  });

  it("refuses a save whose ruleset is no longer available (no currentSave, so Save can't strip its ruleset)", async () => {
    const page = bootBuilder({ search: "?save=sv_1", routes: baseRoutes({ status: 200, body: { save: { id: "sv_1", name: "Green Tide", body: saveBody("Retired Cup 2019") } } }) });
    await flush();
    expect(page.el("saves-status").textContent).toBe("This team's ruleset is no longer available.");
    expect(page.el("current-save-label").textContent).toBe("");
    expect(page.el("team-name").value).toBe("");
    expect(page.el("builder-panel").hidden).toBe(true);
    // The rail Save Team would now create a NEW save, never PUT over sv_1.
    expect(page.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("abandons the restore when the coach picks another ruleset while its rules requests are in flight", async () => {
    let holding = true;
    const page = bootBuilder({
      search: "?save=sv_1",
      routes: baseRoutes({ status: 200, body: { save: { id: "sv_1", name: "Green Tide", body: saveBody("Small Gods 2026") } } }),
      hold: (path) => holding && path.startsWith("/api/packages/Small"),
    });
    await flush();
    expect(page.held.length).toBeGreaterThan(0); // applyBody is parked on the Small Gods rules request
    holding = false;
    // The coach picks EuroBowl on step 1 meanwhile.
    const card = { dataset: { ttPackage: "EuroBowl 2026" } };
    for (const fn of page.el("tt-packages").listeners.click ?? []) fn({ target: { closest: (sel: string) => (sel === "[data-tt-package]" ? card : null) } });
    await flush();
    page.held.splice(0).forEach((h) => h.release());
    await flush();
    expect(page.el("package").value).toBe("EuroBowl 2026");
    expect(page.el("builder-panel").hidden).toBe(true); // still on step 1, not a roster-less step 3
    expect(page.el("current-save-label").textContent).toBe("");
  });

  it("drops a late save-detail response once the coach has made a newer choice", async () => {
    const page = bootBuilder({
      search: "?save=sv_1",
      routes: baseRoutes({ status: 200, body: { save: { id: "sv_1", name: "Green Tide", body: saveBody("Small Gods 2026") } } }),
      hold: (path) => path === "/api/fork/team-builder/saves/sv_1",
    });
    await flush();
    expect(page.held.map((h) => h.path)).toEqual(["/api/fork/team-builder/saves/sv_1"]);
    const card = { dataset: { ttPackage: "EuroBowl 2026" } };
    for (const fn of page.el("tt-packages").listeners.click ?? []) fn({ target: { closest: (sel: string) => (sel === "[data-tt-package]" ? card : null) } });
    await flush();
    page.held.splice(0).forEach((h) => h.release());
    await flush();
    expect(page.el("package").value).toBe("EuroBowl 2026");
    expect(page.el("team-name").value).toBe("");
    expect(page.el("current-save-label").textContent).toBe("");
  });

  it("an expired session during the silent load signs the page out instead of being swallowed", async () => {
    const page = bootBuilder({ search: "?save=sv_1", routes: baseRoutes({ status: 401, body: { error: "Session expired" } }) });
    await flush();
    expect(page.el("signed-in-session").hidden).toBe(true);
    expect(page.el("login-form").hidden).toBe(false);
    expect(page.el("login-message").textContent).toMatch(/session expired/i);
  });

  it("another coach's (or a deleted) save id is ignored silently", async () => {
    const page = bootBuilder({ search: "?save=sv_1", routes: baseRoutes({ status: 404, body: { error: "Not found" } }) });
    await flush();
    expect(page.el("saves-status").textContent).toBe("");
    expect(page.el("signed-in-session").hidden).toBe(false);
    expect(page.el("builder-panel").hidden).toBe(true);
  });
});
