import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privacyContact } from "../src/privacy/contact";
import { safeLogValue } from "../src/privacy/logSafe";
import { rotateLogs } from "../src/privacy/logRotation";
import { pruneBugReports } from "../src/bugReports";

// Privacy notice (/app/privacy): sections, inventory rows, contact block, and the links to it; plus the env-driven contact endpoint.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));

describe("privacy notice (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, inventory] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"),
      vite.ssrLoadModule("vue-router"),
      vite.ssrLoadModule("vue/server-renderer"),
      vite.ssrLoadModule("/src/privacy/inventory.ts"),
    ]);
    mods = { app, vueRouter, renderer, inventory };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const fetcher = (routes: Record<string, unknown>): Fetcher =>
    (async (path: string) => {
      const hit = routes[path];
      if (hit === undefined) throw new ApiError(404, `no mock for ${path}`);
      return hit;
    }) as Fetcher;

  async function render(path: string, routes: Record<string, unknown>): Promise<string> {
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: fetcher(routes) });
    await spa.router.push(path);
    await spa.router.isReady();
    return (await mods.renderer.renderToString(spa.app)) as string;
  }

  const out = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
  const signedIn = { "/api/auth/session": { authenticated: true, coach: "Alice", authMethod: "discord", discordSsoEnabled: true } };
  const contact = { "/api/privacy/contact": { controller: "Example Operator", email: "privacy@example.test", hosting: "United States", euRepresentative: null } };

  it("renders every section anchor, the date, and every inventory row", async () => {
    const html = await render("/privacy", { ...out, ...contact });
    for (const id of ["who", "collect", "why", "public", "share", "transfers", "keep", "rights", "cookies", "children", "changes"]) {
      expect(html, id).toContain(`id="${id}"`);
      expect(html, `toc ${id}`).toContain(`href="#${id}"`);
    }
    expect(html).toContain("Last updated 2026-10-31");
    const { INVENTORY } = mods.inventory;
    expect(INVENTORY.length).toBeGreaterThan(10);
    for (const row of INVENTORY) expect(html, row.id).toContain(`data-row="${row.id}"`);
    expect(html).toContain("Example Operator");
    expect(html).toContain("mailto:privacy@example.test");
    expect(html).toContain("United States");
    for (const word of ["preferred name", "phone number", "Legal basis: your consent", "never public"]) expect(html, word).toContain(word);
  });

  it("exports the privacy version from one place", async () => {
    const version = await vite.ssrLoadModule("/src/privacy/version.ts");
    expect(version.PRIVACY_VERSION).toBe("2026-10-31");
    expect(mods.inventory.PRIVACY_VERSION).toBe(version.PRIVACY_VERSION);
    expect(mods.inventory.PRIVACY_LAST_UPDATED).toBe(version.PRIVACY_VERSION);
  });

  it("shows the neutral contact line when the endpoint has no details or fails", async () => {
    for (const routes of [{ ...out, "/api/privacy/contact": { controller: null, email: null, hosting: "United States", euRepresentative: null } }, out]) {
      const html = await render("/privacy", routes);
      expect(html).toContain("Contact: see the");
      expect(html).not.toContain("mailto:");
    }
  });

  it("each feature claim renders only when its flag is true", async () => {
    const { FEATURES } = mods.inventory;
    const claims: Record<string, { on: string[]; off: string[] }> = {
      export: { on: ["Download a copy of your data from the Account page"], off: ["A copy of your data: coming soon"] },
      delete: { on: ["Delete your account from the Account page", "Deleted coach", "keep a hash of their Discord id", "deleted with your account"], off: ["Deleting your account: coming soon"] },
      consentRecording: { on: ["We record your choice"], off: [] },
      consentWithdrawal: { on: ["withdraw it at any time on the"], off: ["withdrawing on the Account page is coming soon"] },
    };
    const saved = { ...FEATURES };
    // every lane has landed: export + delete (codex/export-delete), consent recording / withdrawal (new-user flow)
    expect(saved).toEqual({ export: true, delete: true, consentRecording: true, consentWithdrawal: true });
    try {
      for (const flag of Object.keys(claims)) {
        for (const k of Object.keys(saved)) FEATURES[k] = false;
        const off = await render("/privacy", { ...out, ...contact });
        for (const t of claims[flag]!.on) expect(off, `${flag} off hides: ${t}`).not.toContain(t);
        for (const t of claims[flag]!.off) expect(off, `${flag} off shows: ${t}`).toContain(t);
        FEATURES[flag] = true;
        const on = await render("/privacy", { ...out, ...contact });
        for (const t of claims[flag]!.on) expect(on, `${flag} on shows: ${t}`).toContain(t);
        for (const t of claims[flag]!.off) expect(on, `${flag} on hides: ${t}`).not.toContain(t);
      }
    } finally { Object.assign(FEATURES, saved); }
  });

  it("names the translation provider only when the endpoint reports one; lists cookies, lobby chat and tabletop wording", async () => {
    const withDeepl = await render("/privacy", { ...out, "/api/privacy/contact": { controller: null, email: null, hosting: "United States", euRepresentative: null, translation: "deepl" } });
    expect(withDeepl).toContain('data-testid="translation-provider"');
    expect(withDeepl).toContain("DeepL");
    const without = await render("/privacy", { ...out, ...contact });
    expect(without).not.toContain('data-testid="translation-provider"');
    for (const t of ["discord_oauth_state", "discord_sso_pending", 'data-row="lobby-chat"', 'data-row="desktop-claims"', 'data-row="translation-cache"', "visible to spectators while they are recorded and after publication; test matches never"]) expect(without, t).toContain(t);
  });

  it("names Postmark only when the endpoint reports a mail provider, and lists the mail inventory row", async () => {
    const withMail = await render("/privacy", { ...out, "/api/privacy/contact": { controller: null, email: null, hosting: "United States", euRepresentative: null, translation: null, mail: "postmark" } });
    expect(withMail).toContain('data-testid="mail-provider"');
    expect(withMail).toContain("Postmark");
    const without = await render("/privacy", { ...out, ...contact });
    expect(without).not.toContain('data-testid="mail-provider"');
    expect(without).toContain("None is switched on yet, so we send no email.");
    expect(without).toContain('data-row="mail"');
    expect(without).toContain("the organiser never receives your address");
  });

  it("inventory rows are complete and unique", () => {
    const { INVENTORY, COLLECT_GROUPS } = mods.inventory;
    const ids = INVENTORY.map((r: any) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of INVENTORY) {
      for (const key of ["store", "data", "purpose", "retention"]) expect(r[key], `${r.id}.${key}`).toBeTruthy();
      expect(["yes", "no", "partly"]).toContain(r.public);
    }
    for (const g of COLLECT_GROUPS) for (const id of g.ids) expect(ids, id).toContain(id);
  });

  it("links to the notice from the nav foot, landing, account page and sign-in prompt", async () => {
    const landing = await render("/home", { ...out });
    expect(landing).toContain('data-testid="landing-privacy"');
    expect(landing).toContain('data-testid="nav-privacy"');
    const account = await render("/account", { ...signedIn, "/api/account": { ffbCoachId: "Alice", fumbblName: null } });
    expect(account).toContain("How we use your data");
    expect(account).toContain('href="/app/privacy"');
    const prompt = await render("/account", { ...out });
    expect(prompt).toContain("By signing in you agree to the");
    expect(prompt).toContain('data-testid="signin-privacy"');
  });
});

describe("GET /api/privacy/contact", () => {
  it("reads only the two env keys", () => {
    const env = { PRIVACY_CONTROLLER_NAME: " Example Operator ", PRIVACY_CONTACT_EMAIL: "privacy@example.test", DISCORD_CLIENT_SECRET: "never-echoed", ADMIN_PASSWORD: "never-echoed" };
    const body = privacyContact(env);
    expect(body).toEqual({ controller: "Example Operator", email: "privacy@example.test", hosting: "United States", euRepresentative: null, translation: null, mail: null });
    expect(JSON.stringify(body)).not.toContain("never-echoed");
  });

  it("falls back to nulls when unset or malformed", () => {
    const unset = { controller: null, email: null, hosting: "United States", euRepresentative: null, translation: null, mail: null };
    expect(privacyContact({})).toEqual(unset);
    expect(privacyContact({ PRIVACY_CONTROLLER_NAME: "  ", PRIVACY_CONTACT_EMAIL: "not an address" })).toEqual(unset);
  });

  it("reports the translation provider only when selected and keyed, never a key", () => {
    expect(privacyContact({ TRANSLATE_PROVIDER: "deepl", DEEPL_API_KEY: "secret-k" }).translation).toBe("deepl");
    expect(privacyContact({ TRANSLATE_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "secret-k" }).translation).toBe("azure");
    expect(privacyContact({ TRANSLATE_PROVIDER: "deepl" }).translation).toBeNull();
    expect(privacyContact({ TRANSLATE_PROVIDER: "libretranslate" }).translation).toBeNull();
    expect(JSON.stringify(privacyContact({ TRANSLATE_PROVIDER: "deepl", DEEPL_API_KEY: "secret-k" }))).not.toContain("secret-k");
  });

  it("is wired as a public, 5-minute-cached route", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");
    expect(source).toMatch(/PUBLIC_PATHS = new Set\(\[[\s\S]*"\/api\/privacy\/contact"[\s\S]*\]\);/);
    expect(source).toMatch(/path === "\/api\/privacy\/contact"[\s\S]{0,200}max-age=300/);
  });
});

describe("retention enforcement and log hygiene", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("prunes bug reports older than 12 months and keeps recent and undated ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "bugs-"));
    try {
      const now = Date.parse("2026-10-31T12:00:00Z");
      const make = (id: string, submittedAt?: string) => { mkdirSync(join(dir, id)); if (submittedAt) writeFileSync(join(dir, id, "report.json"), JSON.stringify({ submittedAt })); writeFileSync(join(dir, id, "wire.log"), "x"); };
      make("old", "2025-10-01T00:00:00.000Z");
      make("recent", "2026-09-01T00:00:00.000Z");
      make("2025-01-02T03-04-05-678Z_coach_nogame");
      make("undated-no-prefix");
      expect(pruneBugReports(dir, now).sort()).toEqual(["2025-01-02T03-04-05-678Z_coach_nogame", "old"]);
      expect(readdirSync(dir).sort()).toEqual(["recent", "undated-no-prefix"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rotates a stale live log by date and deletes dated logs older than 14 days", () => {
    const dir = mkdtempSync(join(tmpdir(), "logs-"));
    try {
      const now = Date.parse("2026-10-31T12:00:00Z");
      const live = (name: string, ageDays: number) => { const p = join(dir, name); writeFileSync(p, "line"); const t = (now - ageDays * DAY) / 1000; utimesSync(p, t, t); };
      live("config-web.log", 1);
      live("config-web.out", 0);
      writeFileSync(join(dir, "config-web.log.2026-10-01"), "old");
      writeFileSync(join(dir, "config-web.err.2026-10-20"), "kept");
      writeFileSync(join(dir, "notes.txt"), "untouched");
      const out = rotateLogs(dir, now);
      expect(out.rotated).toEqual(["config-web.log"]);
      expect(out.deleted).toEqual(["config-web.log.2026-10-01"]);
      expect(existsSync(join(dir, "config-web.log.2026-10-30"))).toBe(true);
      expect(existsSync(join(dir, "config-web.log"))).toBe(false);
      expect(existsSync(join(dir, "config-web.out"))).toBe(true); // written today
      expect(existsSync(join(dir, "config-web.err.2026-10-20"))).toBe(true);
      expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("safeLogValue never logs the raw claimed coach string", () => {
    const hostile = "  someone@example.test \n[super] forged line\t" + "x".repeat(100);
    const out = safeLogValue(hostile);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out).not.toMatch(/[@\s\u0000-\u001f]/);
    expect(safeLogValue("")).toBe("(empty)");
    expect(safeLogValue(42)).toBe("(empty)");
  });

  it("the super service logs auth failures through safeLogValue", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/super/service.ts", import.meta.url)), "utf8");
    expect(source).toContain("auth reject coach=${safeLogValue(coach)}");
    expect(source).not.toMatch(/reject coach=\$\{coach\}/);
  });
});
