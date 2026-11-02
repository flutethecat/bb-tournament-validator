import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import {
  callbackErrorText, coachNameProblem, createWelcome, NAME_AVAILABLE, NAME_DESKTOP_MISSING, NAME_LINK, NAME_REQUIRED, NAME_TAKEN, NAME_TOO_LONG,
  PASSWORD_REQUIRED, welcomeLanding,
} from "../spa/src/account/welcome";
import { createGetStarted, GET_STARTED_HIDDEN_STORAGE, getStartedCards, ORGANISER_REQUEST_TO } from "../spa/src/home/getStarted";
import { RESERVED_NAME_MESSAGE } from "../src/privacy/fence.js";

// Sign-up lane L1 in the SPA (spec-registration-creation-flows 11-02 §3): the coach-name step controller (/app/welcome:
// the retired discord-complete page's checks and flow), the two-step frame (step 1 page, step 2 dialog; re-accept = step 2
// alone) and the coach page's Get started panel. Views are server-rendered through the SPA's own Vite config.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown | ((body: unknown, method: string) => unknown)>;
function mockFetcher(routes: Routes): Fetcher & { calls: Array<{ path: string; method: string; body: unknown }> } {
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const f = (async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: init.body });
    const key = routes[`${method} ${path}`] !== undefined ? `${method} ${path}` : path;
    const hit = routes[key];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    const value = typeof hit === "function" ? (hit as (b: unknown, m: string) => unknown)(init.body, method) : hit;
    if (value instanceof Error) throw value;
    return value;
  }) as Fetcher & { calls: typeof calls };
  f.calls = calls;
  return f;
}
const avail = (name: string) => `/api/fork/name-available?coach=${encodeURIComponent(name)}`;
const PENDING_NEW = { pending: true, discordUsername: "brand_new", existingFfbCoachId: null, requestedFfbCoachId: null, desktop: false };

describe("coach-name validation (parity with the retired page)", () => {
  it("empty, too long and reserved, in the old page's order and words; the name is trimmed", () => {
    expect(coachNameProblem("")).toBe(NAME_REQUIRED);
    expect(coachNameProblem("   ")).toBe("Enter a coach name.");
    expect(coachNameProblem("x".repeat(41))).toBe(NAME_TOO_LONG);
    expect(NAME_TOO_LONG).toBe("Coach names must be at most 40 characters.");
    expect(coachNameProblem(`  ${"x".repeat(40)}  `)).toBe("");
    expect(coachNameProblem("Deleted Coach #4")).toBe(RESERVED_NAME_MESSAGE);
    expect(coachNameProblem("deleted_coach")).toBe(RESERVED_NAME_MESSAGE);
    expect(coachNameProblem("Alice")).toBe("");
  });

  it("callback errors and the landing rule", () => {
    expect(callbackErrorText("expired", "https://x.test")?.title).toBe("Discord sign-in expired");
    expect(callbackErrorText("host-browser-mismatch", "https://x.test")?.message).toContain("https://x.test/");
    expect(callbackErrorText("invalid-state", "")?.title).toBe("Discord sign-in could not be verified");
    expect(callbackErrorText(null, "")).toBeNull();
    expect(welcomeLanding("/")).toBe("/app/home");
    expect(welcomeLanding(undefined)).toBe("/app/home");
    expect(welcomeLanding("/app/tournaments")).toBe("/app/tournaments");
    expect(welcomeLanding("//evil.test")).toBe("/app/home");
  });
});

describe("coach-name step controller", () => {
  it("a callback error shows without reading the pending sign-in", async () => {
    const f = mockFetcher({});
    const w = createWelcome({ api: f });
    await w.init("?error=expired");
    expect(w.state.phase).toBe("error");
    expect(f.calls).toHaveLength(0);
  });

  it("no pending sign-in -> missing", async () => {
    const w = createWelcome({ api: mockFetcher({ "/api/auth/discord/pending": new ApiError(404, "x", { pending: false }) }) });
    await w.init("");
    expect(w.state.phase).toBe("missing");
  });

  it("a returning coach is signed straight in (no step 1); next wins over the coach page", async () => {
    const f = mockFetcher({
      "/api/auth/discord/pending": { ...PENDING_NEW, existingFfbCoachId: "Alice" },
      "POST /api/auth/discord/complete": { coach: "Alice", next: "/app/tournaments" },
    });
    const w = createWelcome({ api: f });
    await w.init("");
    expect(w.state.phase).toBe("done");
    expect(w.state.landing).toBe("/app/tournaments");
    expect(f.calls.find((c) => c.method === "POST")?.body).toEqual({ ffbCoachId: "Alice" });
  });

  it("a brand-new account: the form, prefilled from Discord, checked live; Continue creates and lands on the coach page", async () => {
    const f = mockFetcher({
      "/api/auth/discord/pending": PENDING_NEW,
      [avail("brand_new")]: { available: true },
      "POST /api/auth/discord/complete": { coach: "brand_new", next: "/" },
    });
    const w = createWelcome({ api: f });
    await w.init("");
    expect(w.state.phase).toBe("form");
    expect(w.state.name).toBe("brand_new");
    expect(w.state.availability).toBe("available");
    expect(w.state.note).toBe(NAME_AVAILABLE);
    expect(w.canSubmit()).toBe(true);
    expect(await w.submit()).toBe(true);
    expect(f.calls.find((c) => c.method === "POST")?.body).toEqual({ ffbCoachId: "brand_new" });
    expect(w.state.phase).toBe("done");
    expect(w.state.landing).toBe("/app/home");
  });

  it("invalid names never reach the server; a newer edit wins over a slower answer", async () => {
    let release: (v: unknown) => void = () => {};
    const f = mockFetcher({
      "/api/auth/discord/pending": { ...PENDING_NEW, discordUsername: "" },
      [avail("Slow")]: () => new Promise((r) => { release = r; }),
      [avail("Fast")]: { available: false },
    });
    const w = createWelcome({ api: f });
    await w.init("");
    expect(w.state.availability).toBe("invalid");
    expect(w.state.note).toBe(NAME_REQUIRED);
    expect(w.canSubmit()).toBe(false);
    w.state.name = "Deleted coach #1";
    expect(await w.check()).toBe(false);
    expect(w.state.note).toBe(RESERVED_NAME_MESSAGE);
    expect(f.calls.some((c) => c.path.startsWith("/api/fork/name-available"))).toBe(false);
    w.state.name = "Slow";
    const slow = w.check();
    w.state.name = "Fast";
    w.edited();
    await w.check();
    release({ available: true });
    expect(await slow).toBe(false);
    expect(w.state.availability).toBe("taken");
    expect(w.state.note).toBe(NAME_TAKEN);
  });

  it("taken name: submit without a password -> the server's 409 canLink opens linking; linking needs the password", async () => {
    let calls = 0;
    const f = mockFetcher({
      "/api/auth/discord/pending": PENDING_NEW,
      [avail("brand_new")]: { available: false },
      "POST /api/auth/discord/complete": (body: unknown) => {
        calls++;
        if (!(body as { password?: string }).password) return new ApiError(409, "That coach already exists.", { canLink: true });
        return { coach: "brand_new", next: "/" };
      },
    });
    const w = createWelcome({ api: f });
    await w.init("");
    expect(w.state.availability).toBe("taken");
    expect(w.canSubmit()).toBe(true); // the old page let a taken name through to ask the server
    expect(await w.submit()).toBe(false);
    expect(w.state.linking).toBe(true);
    expect(w.state.note).toBe(NAME_LINK);
    expect(w.state.error).toBe("That coach already exists.");
    expect(w.canSubmit()).toBe(false);
    expect(await w.submit()).toBe(false);
    expect(w.state.error).toBe(PASSWORD_REQUIRED);
    w.state.password = "pw";
    expect(await w.submit()).toBe(true);
    expect(calls).toBe(2);
    expect(f.calls.filter((c) => c.method === "POST").at(-1)?.body).toEqual({ ffbCoachId: "brand_new", password: "pw" });
  });

  it("'I already have a Super FUMBBL account' opens linking by hand; closing it drops the password", async () => {
    const w = createWelcome({ api: mockFetcher({ "/api/auth/discord/pending": PENDING_NEW, [avail("brand_new")]: { available: false } }) });
    await w.init("");
    w.setLinking(true);
    expect(w.state.note).toBe(NAME_LINK);
    w.state.password = "x";
    w.setLinking(false);
    expect(w.state.password).toBe("");
    expect(w.state.note).toBe(NAME_TAKEN);
  });

  it("desktop sign-in: the required name, never creates (an available name can't submit), handoff on success", async () => {
    const f = mockFetcher({
      "/api/auth/discord/pending": { ...PENDING_NEW, desktop: true, requestedFfbCoachId: "Desk" },
      [avail("Desk")]: { available: true },
    });
    const w = createWelcome({ api: f });
    await w.init("");
    expect(w.state.name).toBe("Desk");
    expect(w.state.requested).toBe("Desk");
    expect(w.state.note).toBe(NAME_DESKTOP_MISSING);
    expect(w.canSubmit()).toBe(false);
    const linked = createWelcome({ api: mockFetcher({
      "/api/auth/discord/pending": { ...PENDING_NEW, desktop: true, requestedFfbCoachId: "Desk", existingFfbCoachId: "Desk" },
      "POST /api/auth/discord/complete": { coach: "Desk", clientHandoff: true },
    }) });
    await linked.init("");
    expect(linked.state.phase).toBe("handoff");
    const other = createWelcome({ api: mockFetcher({ "/api/auth/discord/pending": { ...PENDING_NEW, desktop: true, requestedFfbCoachId: "Desk", existingFfbCoachId: "Other" } }) });
    await other.init("");
    expect(other.state.phase).toBe("error");
  });

  it("a refusal of the submit (ban, fence, reserved) shows the server's words", async () => {
    const w = createWelcome({ api: mockFetcher({
      "/api/auth/discord/pending": PENDING_NEW, [avail("brand_new")]: { available: true },
      "POST /api/auth/discord/complete": new ApiError(403, "This account is not allowed."),
    }) });
    await w.init("");
    expect(await w.submit()).toBe(false);
    expect(w.state.error).toBe("This account is not allowed.");
    expect(w.state.phase).toBe("form");
  });
});

describe("Get started controller", () => {
  const VIEW = (extra: Record<string, unknown> = {}) => ({ done: { league: false, tournament: false, team: false, organiser: false }, doneCount: 0, total: 4, hidden: false, show: true, ...extra });
  const store = new Map<string, string>();
  beforeAll(() => {
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
  afterEach(() => store.clear());
  afterAll(() => vi.unstubAllGlobals());

  it("shows for a new coach; the organiser card links only when the request route answers", async () => {
    const g = createGetStarted({ api: mockFetcher({ "/api/me/get-started": VIEW() }) });
    await g.load("Alice");
    expect(g.visible()).toBe(true);
    expect(g.cards().find((c) => c.id === "organiser")?.to).toBeNull();
    const withRoute = createGetStarted({ api: mockFetcher({ "/api/me/get-started": VIEW(), "/api/me/organiser-request": { request: null } }) });
    await withRoute.load("Alice");
    expect(withRoute.cards().find((c) => c.id === "organiser")?.to).toBe(ORGANISER_REQUEST_TO);
    expect(getStartedCards(false).map((c) => c.to)).toEqual(["/leagues?registration=open", "/tournaments?registration=open", "/tournament-team-builder", null]);
  });

  it("hidden on the server, or every step done -> not shown", async () => {
    const hidden = createGetStarted({ api: mockFetcher({ "/api/me/get-started": VIEW({ hidden: true, show: false }) }) });
    await hidden.load("Alice");
    expect(hidden.visible()).toBe(false);
    const failed = createGetStarted({ api: mockFetcher({}) });
    await failed.load("Alice");
    expect(failed.visible()).toBe(false);
  });

  it("Hide POSTs { hidden: true }; if the server can't keep it, this browser remembers it", async () => {
    const f = mockFetcher({ "GET /api/me/get-started": VIEW(), "POST /api/me/get-started": VIEW({ hidden: true, show: false }) });
    const g = createGetStarted({ api: f });
    await g.load("Alice");
    await g.hide();
    expect(f.calls.find((c) => c.method === "POST")?.body).toEqual({ hidden: true });
    expect(g.visible()).toBe(false);
    expect(store.size).toBe(0);
    const offline = createGetStarted({ api: mockFetcher({ "GET /api/me/get-started": VIEW(), "POST /api/me/get-started": new ApiError(428, "Complete your profile first.") }) });
    await offline.load("Bob");
    await offline.hide();
    expect(store.get(`${GET_STARTED_HIDDEN_STORAGE}:bob`)).toBe("1");
    const again = createGetStarted({ api: mockFetcher({ "/api/me/get-started": VIEW() }) });
    await again.load("Bob");
    expect(again.visible()).toBe(false);
  });

  it("blocked storage never breaks it", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    const g = createGetStarted({ api: mockFetcher({ "GET /api/me/get-started": VIEW(), "POST /api/me/get-started": new ApiError(500, "x") }) });
    await g.load("Alice");
    expect(g.visible()).toBe(true);
    await g.hide();
    expect(g.visible()).toBe(false);
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  });
});

describe("views (server-rendered against a mocked API)", () => {
  let vite: ViteDevServer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, onboarding] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/account/onboarding.ts"),
    ]);
    mods = { app, vueRouter, renderer, onboarding };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const SIGNED_OUT = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const AS = { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } };
  const INFO = (needed: boolean, extra: Record<string, unknown> = {}) => ({
    needed, privacyVersion: "2026-10-31", prefill: { preferredName: "alice_dc", email: "alice@example.test", emailSource: "discord", country: "US" },
    leagueContactText: "Organisers of leagues and tournaments I join may message me through Super FUMBBL.", ...extra,
  });
  async function render(path: string, routes: Routes, coach = "") {
    const f = mockFetcher(routes);
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    if (coach) {
      const o = mods.onboarding.createOnboarding({ api: f });
      await o.load(coach);
      spa.app.provide(mods.onboarding.ONBOARDING_KEY, o);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    await spa.session.load();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  it("step 1 (/welcome): band + STEP 1 OF 2, the step indicator, the name preview, the field with its rules, the link-account option", async () => {
    const html = await render("/welcome", { ...SIGNED_OUT, "/api/auth/discord/pending": PENDING_NEW, [avail("brand_new")]: { available: true } });
    expect(html).toContain('<h2 id="wl-h">Your coach name</h2>');
    expect(html).toContain('<span class="hm-cap">Step 1 of 2</span>');
    expect(html).toMatch(/<ol class="ob-steps" aria-label="Sign-up steps">/);
    expect(html).toMatch(/data-state="current" aria-current="step"/);
    expect(html).toContain('<div class="wl-preview" aria-hidden="true">brand_new</div>');
    expect(html).toMatch(/<label class="ob-label" for="wl-name">Coach name<\/label>/);
    expect(html).toMatch(/<input id="wl-name"[^>]*maxlength="40"/);
    expect(html).toContain("case-sensitive");
    expect(html).toContain(NAME_AVAILABLE);
    expect(html).toContain(">I already have a Super FUMBBL account</button>");
    expect(html).toMatch(/<button class="ob-btn primary" type="submit"[^>]*>\s*Continue\s*<\/button>/);
    expect(html).not.toContain("lobby-");
  });

  it("step 1 with no pending sign-in offers Discord again", async () => {
    const html = await render("/welcome", { ...SIGNED_OUT });
    expect(html).toContain("No Discord sign-in to finish");
    expect(html).toContain("sf-discord-login");
  });

  it("step 2 for a new coach: the dialog carries the indicator (step 1 done) and STEP 2 OF 2", async () => {
    const html = await render("/home", { ...AS, "/api/me/onboarding": INFO(true, { reaccept: false }) }, "Alice");
    const m = html.slice(html.indexOf('class="ob-backdrop"'));
    expect(m).toContain('<h2 id="ob-h" class="ob-title">Welcome to Super FUMBBL</h2>');
    expect(m).toContain('<span class="hm-cap">Step 2 of 2</span>');
    expect(m).toMatch(/data-state="done"[^>]*>.*Your coach name/s);
    expect(m).toMatch(/data-state="current" aria-current="step"/);
  });

  it("step 2 alone for a re-accept: no indicator, the changed-notice title; the 428-gated form is the same", async () => {
    const html = await render("/home", { ...AS, "/api/me/onboarding": INFO(true, { reaccept: true }) }, "Alice");
    const m = html.slice(html.indexOf('class="ob-backdrop"'));
    expect(m).toContain("Our privacy notice has changed");
    expect(m).not.toContain("ob-steps");
    expect(m).not.toContain("Step 2 of 2");
    expect(m).toContain("Privacy notice</a>");
  });

  it("coach page: Get started shows for a new coach (band, 0 / 4 done, four cards, Hide) and is absent once hidden", async () => {
    const view = { done: { league: false, tournament: true, team: false, organiser: false }, doneCount: 1, total: 4, hidden: false, show: true };
    const html = await render("/home", { ...AS, "/api/me/onboarding": INFO(false), "/api/me/get-started": view }, "Alice");
    expect(html).toContain('<h2 id="gs-h">Get started</h2>');
    expect(html).toContain("1 / 4 done");
    expect(html).toContain(">Hide</button>");
    expect(html).toContain('href="/app/leagues?registration=open"');
    expect(html).toContain('href="/app/tournaments?registration=open"');
    expect(html).toContain('href="/app/tournament-team-builder"');
    expect(html).toMatch(/data-step="tournament" data-done="true"/);
    expect(html).toContain("Run your own league or tournament");
    expect(html).not.toContain(`href="/app${ORGANISER_REQUEST_TO}"`); // no request route yet: never a dead link
    expect(html.indexOf("gs-h")).toBeLessThan(html.indexOf("hm-new-h")); // at the top
    const hidden = await render("/home", { ...AS, "/api/me/onboarding": INFO(false), "/api/me/get-started": { ...view, hidden: true, show: false } }, "Alice");
    expect(hidden).not.toContain("gs-h");
  });

  it("the organiser card links to the request page once that route answers", async () => {
    const view = { done: { league: false, tournament: false, team: false, organiser: false }, doneCount: 0, total: 4, hidden: false, show: true };
    const html = await render("/home", { ...AS, "/api/me/onboarding": INFO(false), "/api/me/get-started": view, "/api/me/organiser-request": {} }, "Alice");
    expect(html).toContain(`href="/app${ORGANISER_REQUEST_TO}"`);
  });
});
