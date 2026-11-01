import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { canSubmit, createOnboarding, onboardingBody, onboardingKey, onboardingProblems, type OnboardingForm } from "../spa/src/account/onboarding";
import { contactBody, createContactEditor, dateOf } from "../spa/src/account/contact";

// New-user flow in the SPA: the onboarding controller (prefill, validation, disabled states, the POST), the modal's
// keyboard rules (Tab wraps, Escape does nothing), the modal over the shell on any route (server-rendered through the
// SPA's own Vite config, as spaHome.test.ts does), and the Account page's Contact & consent section.

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

const INFO = (needed = true, extra: Record<string, unknown> = {}) => ({
  needed, privacyVersion: "2026-10-31",
  prefill: { preferredName: "alice_dc", email: "alice@example.test", emailSource: "discord" },
  leagueContactText: "Organisers of leagues and tournaments I join may contact me by email or phone about fixtures and league business.",
  ...extra,
});
const CONTACT = {
  preferredName: "Alice", email: "alice@example.test", emailSource: "discord", emailVerified: true, phones: [{ number: "+15551234567", label: "mobile" }],
  leagueContact: { granted: true, at: "2026-11-01T10:00:00.000Z", version: "2026-10-31" }, privacy: { acceptedVersion: "2026-10-31", at: "2026-11-01T10:00:00.000Z" },
  privacyVersion: "2026-10-31", leagueContactText: "Organisers of leagues and tournaments I join may contact me by email or phone about fixtures and league business.",
};
const form = (extra: Partial<OnboardingForm> = {}): OnboardingForm => ({
  preferredName: "Alice", email: "alice@example.test", editingEmail: false, phones: [], leagueContact: false, privacyAccepted: true, ...extra,
});

describe("onboarding controller", () => {
  it("loads once per coach, prefills, and opens only while needed", async () => {
    const f = mockFetcher({ "/api/me/onboarding": INFO() });
    const o = createOnboarding({ api: f });
    await o.load("Alice");
    await o.load("Alice");
    expect(f.calls.filter((c) => c.path === "/api/me/onboarding")).toHaveLength(1);
    expect(o.open()).toBe(true);
    expect(o.state.form).toMatchObject({ preferredName: "alice_dc", email: "alice@example.test", editingEmail: false, leagueContact: false, privacyAccepted: false });
    await o.load("");
    expect(o.open()).toBe(false);
    const done = createOnboarding({ api: mockFetcher({ "/api/me/onboarding": INFO(false) }) });
    await done.load("Alice");
    expect(done.open()).toBe(false);
    // No email to show: the field starts as an input.
    const none = createOnboarding({ api: mockFetcher({ "/api/me/onboarding": INFO(true, { prefill: { preferredName: "x", email: null, emailSource: "discord" } }) }) });
    await none.load("X");
    expect(none.state.form.editingEmail).toBe(true);
  });

  it("Save is disabled until the privacy box is ticked and every field is valid; the league box is never required", () => {
    expect(canSubmit(form({ privacyAccepted: false }))).toBe(false);
    expect(canSubmit(form())).toBe(true);
    expect(canSubmit(form({ preferredName: "  " }))).toBe(false);
    expect(canSubmit(form({ preferredName: "x".repeat(41) }))).toBe(false);
    expect(canSubmit(form({ email: "nope" }))).toBe(false);
    expect(canSubmit(form({ email: "" }))).toBe(true);
    expect(canSubmit(form({ phones: [{ number: "", label: "mobile" }] }))).toBe(false);
    expect(canSubmit(form({ phones: [{ number: "5551234567", label: "mobile" }] }))).toBe(false);
    expect(canSubmit(form({ phones: [{ number: "+1 555 123 4567", label: "mobile" }] }))).toBe(true);
    expect(onboardingProblems(form({ phones: [{ number: "+15551234567", label: "" }, { number: "+1 555 123 4567", label: "home" }] })).phones).toEqual(["", "Listed twice."]);
    expect(onboardingProblems(form({ phones: [{ number: "123", label: "" }] })).phones[0]).toContain("+1 555 123 4567");
  });

  it("phones: add up to 3, remove; submit POSTs normalised phones and the privacy version, then closes", async () => {
    const f = mockFetcher({ "/api/me/onboarding": INFO(), "POST /api/me/onboarding": INFO(false) });
    const o = createOnboarding({ api: f });
    await o.load("Alice");
    expect(o.canSubmit()).toBe(false);
    for (let i = 0; i < 5; i++) o.addPhone();
    expect(o.state.form.phones).toHaveLength(3);
    o.removePhone(2);
    o.removePhone(1);
    o.state.form.phones[0]!.number = "+44 20 7946 0000";
    o.state.form.privacyAccepted = true;
    expect(o.canSubmit()).toBe(true);
    expect(await o.submit()).toBe(true);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/onboarding", method: "POST", body: {
      preferredName: "alice_dc", email: "alice@example.test", phones: [{ number: "+442079460000", label: "mobile" }], leagueContact: false, privacyAccepted: true, privacyVersion: "2026-10-31",
    } });
    expect(o.open()).toBe(false);
    expect(onboardingBody(form({ email: "  " }), "v")).toMatchObject({ email: null });
  });

  it("a server refusal shows verbatim and keeps the modal; a 401 signs out", async () => {
    let reply: unknown = new ApiError(400, "Accept the privacy notice to continue.");
    let signedOut = 0;
    const o = createOnboarding({ api: mockFetcher({ "/api/me/onboarding": INFO(), "POST /api/me/onboarding": () => reply }), onSignedOut: () => { signedOut++; } });
    await o.load("Alice");
    o.state.form.privacyAccepted = true;
    expect(await o.submit()).toBe(false);
    expect(o.state.error).toBe("Accept the privacy notice to continue.");
    expect(o.open()).toBe(true);
    reply = new ApiError(401, "Authentication required.");
    await o.submit();
    expect(signedOut).toBe(1);
    expect(o.state.busy).toBe(false);
  });

  it("keyboard: Tab wraps inside, Escape is blocked (never closes), shell shortcuts are stopped", () => {
    const list = ["a", "b", "c"];
    expect(onboardingKey({ key: "Escape", shiftKey: false }, list, "b")).toEqual({ type: "block" });
    expect(onboardingKey({ key: "Tab", shiftKey: false }, list, "c")).toEqual({ type: "focus", target: "a" });
    expect(onboardingKey({ key: "Tab", shiftKey: true }, list, "a")).toEqual({ type: "focus", target: "c" });
    expect(onboardingKey({ key: "Tab", shiftKey: false }, list, "a")).toBeNull();
    expect(onboardingKey({ key: "[", shiftKey: false }, list, "a")).toEqual({ type: "stop" });
  });
});

describe("contact editor (Account page)", () => {
  it("loads, validates, PATCHes the whole section, and shows dates", async () => {
    const f = mockFetcher({ "/api/me/contact": CONTACT, "PATCH /api/me/contact": { ...CONTACT, leagueContact: { granted: false, at: "2026-11-02T00:00:00.000Z", version: "2026-10-31" } } });
    const e = createContactEditor({ api: f });
    await e.load();
    expect(e.state.form).toEqual({ preferredName: "Alice", email: "alice@example.test", phones: [{ number: "+15551234567", label: "mobile" }], leagueContact: true });
    expect(e.dirty()).toBe(false);
    e.state.form.phones[0]!.number = "bad";
    expect(e.valid()).toBe(false);
    expect(await e.save()).toBe(false);
    expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
    e.state.form.phones[0]!.number = "+1 555 123 4567";
    e.state.form.leagueContact = false;
    expect(e.dirty()).toBe(true);
    expect(await e.save()).toBe(true);
    expect(f.calls.at(-1)?.body).toEqual({ preferredName: "Alice", email: "alice@example.test", phones: [{ number: "+15551234567", label: "mobile" }], leagueContact: false });
    expect(e.state.notice).toBe("Saved.");
    expect(dateOf("2026-11-02T00:00:00.000Z")).toBe("2026-11-02");
    expect(contactBody({ preferredName: " A ", email: "", phones: [{ number: "+15551234567", label: "" }], leagueContact: false })).toEqual({ preferredName: "A", email: null, phones: [{ number: "+15551234567" }], leagueContact: false });
  });

  it("a 428 says to finish the welcome form", async () => {
    const e = createContactEditor({ api: mockFetcher({ "/api/me/contact": CONTACT, "PATCH /api/me/contact": new ApiError(428, "Complete your profile first.") }) });
    await e.load();
    expect(await e.save()).toBe(false);
    expect(e.state.error).toBe("Complete the welcome form first.");
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

  const AS = { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord" } };
  async function render(path: string, routes: Routes, prep?: (o: ReturnType<typeof createOnboarding>) => void) {
    const f = mockFetcher({ ...AS, ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    const o = mods.onboarding.createOnboarding({ api: f });
    await o.load("Alice");
    prep?.(o);
    spa.app.provide(mods.onboarding.ONBOARDING_KEY, o);
    await spa.router.push(path);
    await spa.router.isReady();
    await spa.session.load();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }
  const checkboxes = (html: string) => [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
  const modalOf = (html: string) => html.slice(html.indexOf('class="tn-modal-backdrop ob-backdrop"'));

  it("the modal over the shell on any route: band heading, prefilled fields, unticked boxes, privacy link, Save disabled, Sign out; the shell is inert", async () => {
    for (const path of ["/home", "/tournaments", "/account"]) {
      const html = await render(path, { "/api/me/onboarding": INFO() });
      expect(html).toMatch(/<header class="shell-header[^"]*"[^>]*inert/);
      expect(html).toMatch(/<div class="sf-body"[^>]*inert/);
      const m = modalOf(html);
      expect(m).toMatch(/role="dialog" aria-modal="true" aria-labelledby="ob-h"/);
      expect(m).toContain('<h2 id="ob-h" class="tn-band">Welcome to Super FUMBBL</h2>');
      expect(m).toMatch(/<input id="ob-name"[^>]*value="alice_dc"/);
      expect(m).toContain('<span class="ob-email-value" aria-labelledby="ob-email-l">alice@example.test</span>');
      expect(m).toContain(">Edit</button>");
      expect(m).toContain("From your Discord account.");
      expect(m).toContain("+1 555 123 4567");
      expect(m).toContain(">Add phone number</button>");
      expect(m).toContain("Organisers of leagues and tournaments I join may contact me");
      expect(checkboxes(m)).toHaveLength(2);
      expect(checkboxes(m).some((c) => /\schecked/.test(c))).toBe(false);
      expect(m).toContain('<a href="/app/privacy" target="_blank" rel="noopener">Privacy notice</a>');
      expect(m).toMatch(/<button class="lobby-btn primary" type="submit" disabled[^>]*>Save and continue<\/button>/);
      expect(m).toMatch(/<button class="lobby-btn" type="button"[^>]*>Sign out<\/button>/);
      expect(m).not.toContain("tn-modal-x"); // no close button: blocking
    }
  });

  it("valid + privacy ticked enables Save; an edited email shows the 'verify later' note; phone rows have labels and Remove", async () => {
    const html = await render("/home", { "/api/me/onboarding": INFO() }, (o) => {
      o.state.form.privacyAccepted = true;
      o.state.form.editingEmail = true;
      o.state.form.email = "other@example.test";
      o.state.form.phones.push({ number: "+15551234567", label: "home" });
    });
    const m = modalOf(html);
    expect(m).toMatch(/<button class="lobby-btn primary" type="submit"[^>]*>Save and continue<\/button>/);
    expect(m).not.toMatch(/type="submit" disabled/);
    expect(m).toMatch(/<input id="ob-email"[^>]*type="email"/);
    expect(m).toContain("We&#39;ll verify this address later.");
    expect(m).toContain('<label for="ob-phone-0">Number 1</label>');
    expect(m).toContain('<label for="ob-phone-0-label">Type</label>');
    expect(m).toContain('aria-label="Remove number 1"');
  });

  it("no modal once onboarding is done; the shell is not inert", async () => {
    const html = await render("/home", { "/api/me/onboarding": INFO(false) });
    expect(html).not.toContain("Welcome to Super FUMBBL");
    expect(html).not.toMatch(/<header class="shell-header[^"]*"[^>]*inert/);
  });

  it("Account page: Contact & consent section with the fields, consent status and dates, and privacy acceptance read-only", async () => {
    const html = await render("/account", { "/api/me/onboarding": INFO(false), "/api/me/contact": CONTACT });
    expect(html).toContain('<h2 id="ac-contact-h">Contact &amp; consent</h2>');
    const sec = html.slice(html.indexOf('id="contact"'), html.indexOf('id="calendar"')).replace(/<!--[^>]*-->/g, "");
    expect(sec).toMatch(/<input id="acc-name"[^>]*value="Alice"/);
    expect(sec).toMatch(/<input id="acc-email"[^>]*value="alice@example.test"/);
    expect(sec).toMatch(/<input id="acc-phone-0"[^>]*value="\+15551234567"/);
    expect(checkboxes(sec)).toHaveLength(1);
    expect(checkboxes(sec)[0]).toMatch(/\schecked/);
    expect(sec).toContain('data-consent="league">Allowed · since 2026-11-01');
    expect(sec).toContain("Accepted version 2026-10-31 on 2026-11-01");
    expect(sec).not.toMatch(/name="privacy"|privacyAccepted/);
    expect(sec).toContain(">Save contact details</button>");
  });
});
