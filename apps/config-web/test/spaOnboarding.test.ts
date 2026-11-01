import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { canSubmit, createOnboarding, onboardingBody, onboardingKey, onboardingProblems, type OnboardingForm } from "../spa/src/account/onboarding";
import { changedFields, contactBody, createContactEditor, dateOf } from "../spa/src/account/contact";

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
  prefill: { preferredName: "alice_dc", email: "alice@example.test", emailSource: "discord", country: "US" },
  leagueContactText: "Organisers of leagues and tournaments I join may message me through Super FUMBBL.",
  ...extra,
});
const CONTACT = {
  preferredName: "Alice", email: "alice@example.test", emailSource: "discord", emailVerified: true, country: "US", phones: [{ number: "+15551234567", country: "US" }],
  leagueContact: { granted: true, at: "2026-11-01T10:00:00.000Z", version: "2026-10-31" }, privacy: { acceptedVersion: "2026-10-31", at: "2026-11-01T10:00:00.000Z" },
  privacyVersion: "2026-10-31", leagueContactText: "Organisers of leagues and tournaments I join may message me through Super FUMBBL.",
};
const form = (extra: Partial<OnboardingForm> = {}): OnboardingForm => ({
  preferredName: "Alice", email: "alice@example.test", editingEmail: false, country: "US", phones: [], leagueContact: false, privacyAccepted: true, ...extra,
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
    expect(canSubmit(form({ country: "" }))).toBe(false); // country is required
    expect(onboardingProblems(form({ country: "" })).country).toBe("Choose your country.");
    expect(canSubmit(form({ phones: [{ number: "", country: "" }] }))).toBe(false);
    expect(canSubmit(form({ phones: [{ number: "555 123 4567", country: "" }] }))).toBe(true); // national, US prefix
    expect(canSubmit(form({ phones: [{ number: "+44 20 7946 0555", country: "" }] }))).toBe(true);
    expect(onboardingProblems(form({ phones: [{ number: "12", country: "" }] })).phones[0]).toBe("Enter the number without the country code, for example 555 123 4567.");
  });

  it("one phone: add, remove; submit POSTs the country, the number as typed and the privacy version, then closes", async () => {
    const f = mockFetcher({ "/api/me/onboarding": INFO(), "POST /api/me/onboarding": INFO(false) });
    const o = createOnboarding({ api: f });
    await o.load("Alice");
    expect(o.canSubmit()).toBe(false);
    for (let i = 0; i < 5; i++) o.addPhone();
    expect(o.state.form.phones).toHaveLength(1);
    o.state.form.phones[0]!.number = "07700 900555";
    o.state.form.phones[0]!.country = "GB";
    o.state.form.privacyAccepted = true;
    expect(o.canSubmit()).toBe(true);
    expect(await o.submit()).toBe(true);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/onboarding", method: "POST", body: {
      preferredName: "alice_dc", email: "alice@example.test", country: "US", phones: [{ number: "07700 900555", country: "GB" }], leagueContact: false, privacyAccepted: true, privacyVersion: "2026-10-31",
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
    expect(e.state.form).toEqual({ preferredName: "Alice", email: "alice@example.test", country: "US", phones: [{ number: "5551234567", country: "US" }], leagueContact: true });
    expect(e.dirty()).toBe(false);
    e.state.form.phones[0]!.number = "bad";
    expect(e.valid()).toBe(false);
    expect(await e.save()).toBe(false);
    expect(f.calls.some((c) => c.method === "PATCH")).toBe(false);
    e.state.form.phones[0]!.number = "5551234567";
    e.state.form.leagueContact = false;
    expect(e.dirty()).toBe(true);
    expect(await e.save()).toBe(true);
    // Partial: only the changed field goes up (the phone was put back as it was).
    expect(f.calls.at(-1)?.body).toEqual({ leagueContact: false });
    expect(e.state.notice).toBe("Saved.");
    expect(dateOf("2026-11-02T00:00:00.000Z")).toBe("2026-11-02");
    expect(contactBody({ preferredName: " A ", email: "", country: "US", phones: [{ number: " 555 123 4567 ", country: "" }], leagueContact: false })).toEqual({ preferredName: "A", email: null, country: "US", phones: [{ number: "555 123 4567" }], leagueContact: false });
    // A per-number country goes up when set (a saved number keeps the country it was entered for).
    expect(contactBody({ preferredName: "A", email: "", country: "US", phones: [{ number: "07700 900555", country: "GB" }], leagueContact: false }).phones).toEqual([{ number: "07700 900555", country: "GB" }]);
    // Changing only the country never sends the stored phone again (so it is never rewritten).
    e.state.form.country = "DE";
    expect(changedFields(e.state.form, e.state.view!)).toEqual({ country: "DE" });
  });

  it("a name edit never resubmits consent, phones or email", () => {
    const view = CONTACT as never;
    expect(changedFields({ preferredName: "Alicia", email: "alice@example.test", country: "US", phones: [{ number: "5551234567", country: "US" }], leagueContact: true }, view)).toEqual({ preferredName: "Alicia" });
    expect(changedFields({ preferredName: "Alice", email: "alice@example.test", country: "US", phones: [], leagueContact: true }, view)).toEqual({ phones: [] });
  });

  it("re-acceptance prefills the stored phone (national part for its country) and league-contact choice in the modal", async () => {
    const o = createOnboarding({ api: mockFetcher({ "/api/me/onboarding": INFO(true, { prefill: { preferredName: "a", email: "a@b.cd", emailSource: "discord", country: "US", phones: [{ number: "+447700900555", country: "GB" }], leagueContact: true } }) }) });
    await o.load("Alice");
    expect(o.state.form.phones).toEqual([{ number: "7700900555", country: "GB" }]);
    expect(o.state.form.country).toBe("US");
    const old = createOnboarding({ api: mockFetcher({ "/api/me/onboarding": INFO(true, { prefill: { preferredName: "a", email: "a@b.cd", emailSource: "discord", country: null, phones: [{ number: "+15551234567", label: "home" }] } }) }) });
    await old.load("Bob");
    expect(old.state.form.phones).toEqual([{ number: "+15551234567", country: "" }]); // typed with + : kept international
    expect(o.state.form.leagueContact).toBe(true);
  });

  it("a 428 says to finish the welcome form", async () => {
    const e = createContactEditor({ api: mockFetcher({ "/api/me/contact": CONTACT, "PATCH /api/me/contact": new ApiError(428, "Complete your profile first.") }) });
    await e.load();
    expect(await e.save()).toBe(true); // nothing changed: no request
    expect(e.state.notice).toBe("Nothing to save.");
    e.state.form.preferredName = "Alicia";
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
    const [app, vueRouter, renderer, onboarding, sharing] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/account/onboarding.ts"),
      vite.ssrLoadModule("/src/account/leagueSharing.ts"),
    ]);
    mods = { app, vueRouter, renderer, onboarding, sharing };
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
    if (routes["/api/me/leagues/sharing"]) {
      const ls = mods.sharing.createLeagueSharing({ api: f });
      await ls.load("Alice");
      spa.app.provide(mods.sharing.LEAGUE_SHARING_KEY, ls);
    }
    await spa.router.push(path);
    await spa.router.isReady();
    await spa.session.load();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }
  const checkboxes = (html: string) => [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>/g)].map((m) => m[0]);
  const modalOf = (html: string) => html.slice(html.indexOf('class="ob-backdrop"'));

  it("the modal over the shell on any route: band heading, prefilled fields, unticked boxes, privacy link, Save disabled, Sign out; the shell is inert", async () => {
    for (const path of ["/home", "/tournaments", "/account"]) {
      const html = await render(path, { "/api/me/onboarding": INFO() });
      expect(html).toMatch(/<header class="shell-header[^"]*"[^>]*inert/);
      expect(html).toMatch(/<div class="sf-body"[^>]*inert/);
      const m = modalOf(html);
      expect(m).toMatch(/role="dialog" aria-modal="true" aria-labelledby="ob-h"/);
      expect(m).toContain('<h2 id="ob-h" class="ob-title">Welcome to Super FUMBBL</h2>');
      // Two cards in the site's panel language; field labels use the muted builder label style, not the heading colour.
      expect(m).toContain('<h3 id="ob-details-h" class="ob-band">Your details</h3>');
      expect(m).toContain('<h3 id="ob-choices-h" class="ob-band">Your choices</h3>');
      expect(m).toContain('<label class="ob-label" for="ob-name">Preferred name</label>');
      expect(m).toContain('<span class="ob-readonly ob-email-value" aria-labelledby="ob-email-l">alice@example.test</span>');
      expect(m).toContain("They don&#39;t see your email or phone unless you choose to share it.");
      expect(m).toMatch(/<input id="ob-name"[^>]*value="alice_dc"/);
      expect(m).toContain(">Edit</button>");
      expect(m).toContain("From your Discord account.");
      // Phone is optional and collapsed (owner 10-31): one button, no phone rows until the coach adds one.
      expect(m).toContain(">Add a phone number (optional)</button>");
      expect(m).not.toContain('class="ob-phones"');
      expect(m).toContain("Organisers of leagues and tournaments I join may message me through Super FUMBBL.");
      expect(m).not.toContain("by email or phone");
      expect(checkboxes(m)).toHaveLength(2);
      expect(checkboxes(m).some((c) => /\schecked/.test(c))).toBe(false);
      expect(m).toContain('<a href="/app/privacy" target="_blank" rel="noopener">Privacy notice</a>');
      expect(m).toMatch(/<button class="ob-btn primary" type="submit" disabled[^>]*>Save and continue<\/button>/);
      expect(m).toMatch(/<button class="ob-btn" type="button"[^>]*>Sign out<\/button>/);
      expect(m).not.toContain("lobby-btn");
      expect(m).not.toContain("tn-modal-x"); // no close button: blocking
    }
  });

  it("valid + privacy ticked enables Save; an edited email shows the 'verify later' note; the one phone has its prefix, country override and Remove", async () => {
    const html = await render("/home", { "/api/me/onboarding": INFO() }, (o) => {
      o.state.form.privacyAccepted = true;
      o.state.form.editingEmail = true;
      o.state.form.email = "other@example.test";
      o.state.form.phones.push({ number: "555 123 4567", country: "" });
    });
    const m = modalOf(html);
    expect(m).toMatch(/<button class="ob-btn primary" type="submit"[^>]*>Save and continue<\/button>/);
    expect(m).not.toMatch(/type="submit" disabled/);
    expect(m).toMatch(/<input id="ob-email"[^>]*type="email"/);
    expect(m).toContain("We&#39;ll verify this address later.");
    expect(m).toMatch(/<label class="ob-label" for="ob-country">Country<\/label>/);
    expect(m).toContain('<span class="ob-phone-prefix" aria-hidden="true">+1</span>');
    expect(m).toContain('<label class="ob-label" for="ob-phone-country">Number&#39;s country</label>');
    expect(m).toContain("Same as mine (United States)");
    expect(m).toContain('aria-label="Remove phone number"');
    expect(m).not.toContain(">Type</label>"); // no phone type any more
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
    expect(sec).toMatch(/<input id="acc-phone-number"[^>]*value="5551234567"/);
    expect(sec).toContain("+1</span>");
    expect(sec).toMatch(/<input id="acc-country"[^>]*value="United States"/);
    expect(checkboxes(sec)).toHaveLength(1);
    expect(checkboxes(sec)[0]).toMatch(/\schecked/);
    expect(sec).toContain('data-consent="league">Allowed · since 2026-11-01');
    expect(sec).toContain("Accepted version 2026-10-31 on 2026-11-01");
    expect(sec).not.toMatch(/name="privacy"|privacyAccepted/);
    expect(sec).toContain(">Save contact details</button>");
  });

  const SHARING = (rows: unknown[]) => ({ "/api/me/leagues/sharing": { version: "2026-10-31", leagues: rows } });
  const ROW = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
    id, name: id === "lg" ? "Test League" : "Other League", status, onRoster: true,
    text: `You are joining ${id === "lg" ? "Test League" : "Other League"}. Its organisers can see your coach name and your teams.`,
    ...extra,
  });

  it("league data-sharing notice: non-blocking panel above the page for a pending league; the shell stays usable", async () => {
    const html = await render("/home", { "/api/me/onboarding": INFO(false), ...SHARING([ROW("lg", "pending"), ROW("other", "pending")]) });
    const panel = html.slice(html.indexOf('class="tn-panel ls-notice"'));
    expect(panel).toContain('role="region" aria-labelledby="ls-notice-h"');
    expect(panel).toContain("Your profile and Test League");
    expect(panel).toContain("You are joining Test League. Its organisers can see your coach name and your teams.");
    expect(panel).toContain("I agree to join Test League: its organisers can see my coach name and teams and send me league messages.");
    // The agreement box plus the three share boxes (Preferred name / Email / Phone), none ticked.
    const boxes = checkboxes(panel.slice(0, panel.indexOf("</section>")));
    expect(boxes).toHaveLength(4);
    expect(boxes.some((c) => /\schecked/.test(c))).toBe(false);
    for (const label of ["Preferred name", "Email", "Phone"]) expect(panel).toContain(`<span>${label}`);
    expect(panel).toMatch(/<button class="lobby-btn primary" type="button" disabled[^>]*>Share<\/button>/);
    expect(panel).toContain(">Don&#39;t share</button>");
    expect(html).not.toContain('aria-modal="true"');
    expect(html).not.toMatch(/<header class="shell-header[^"]*"[^>]*inert/);
    // Answered leagues show no notice; nor does it show over the welcome modal.
    expect(await render("/home", { "/api/me/onboarding": INFO(false), ...SHARING([ROW("lg", "shared", { at: "2026-11-01T00:00:00Z" })]) })).not.toContain("ls-notice");
    expect(await render("/home", { "/api/me/onboarding": INFO(true), ...SHARING([ROW("lg", "pending")]) })).not.toContain("ls-notice");
  });

  it("Account page: League data sharing lists each league with its status, Stop sharing for a shared one, Share for the others", async () => {
    const html = await render("/account", {
      "/api/me/onboarding": INFO(false), "/api/me/contact": CONTACT,
      ...SHARING([ROW("lg", "shared", { at: "2026-11-01T10:00:00.000Z" }), ROW("other", "declined", { at: "2026-11-02T10:00:00.000Z" })]),
    });
    const sec = html.slice(html.indexOf('id="league-sharing"'), html.indexOf('id="calendar"')).replace(/<!--[^>]*-->/g, "");
    expect(sec).toContain('<h2 id="ac-share-h">League data sharing</h2>');
    expect(sec).toMatch(/data-share="shared"[\s\S]*Test League[\s\S]*Shared since 2026-11-01[\s\S]*>Stop sharing<\/button>/);
    expect(sec).toMatch(/data-share="declined"[\s\S]*Other League[\s\S]*Not shared \(since 2026-11-02\)[\s\S]*>Share…<\/button>/);
  });

  it("league sharing controller: Share needs the tick and sends acknowledged; Don't share sends share false", async () => {
    const f = mockFetcher({
      ...SHARING([ROW("lg", "pending")]),
      "POST /api/me/leagues/sharing": (body: unknown) => ({ leagues: [ROW("lg", (body as { share: boolean }).share ? "shared" : "declined")] }),
    });
    const ls = (await import("../spa/src/account/leagueSharing")).createLeagueSharing({ api: f });
    await ls.load("Alice");
    expect(ls.pending()?.id).toBe("lg");
    expect(await ls.share("lg")).toBe(false);
    expect(f.calls.some((c) => c.method === "POST")).toBe(false);
    ls.tick("lg", true);
    expect(await ls.share("lg")).toBe(true);
    expect(f.calls.at(-1)).toEqual({ path: "/api/me/leagues/sharing", method: "POST", body: { leagueId: "lg", share: true, acknowledged: true, fields: [] } });
    expect(ls.pending()).toBeUndefined();
    expect(await ls.decline("lg")).toBe(true);
    expect(f.calls.at(-1)?.body).toEqual({ leagueId: "lg", share: false });
  });
});
