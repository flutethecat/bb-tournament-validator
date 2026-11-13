// Admin console v2 in the SPA (/app/admin/:section, spec-admin-console-v2-2026-11-04): the router guard (sign-in, the 403
// page for coaches and organisers, the page for site admins), the redirects (old /admin.html hash links, the old admin
// pages), every section rendering, and the parity smoke test: every action of the retired public/admin.js (admin/model.ts
// PARITY) is reachable in its v2 section. Server-rendered through the SPA's own Vite config against a mocked API.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import { ApiError } from "../spa/src/shared/api";
import type { Fetcher } from "../spa/src/session";
import { ADMIN_SECTIONS, adminSectionFromHash, PARITY, triageBody, type AdminSectionId } from "../spa/src/admin/model";

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
type Routes = Record<string, unknown>;

function mockFetcher(routes: Routes): Fetcher {
  return (async (path: string, init: { method?: string } = {}) => {
    const method = init.method ?? "GET";
    const hit = routes[`${method} ${path}`] ?? routes[path];
    if (hit === undefined) throw new ApiError(404, `no mock for ${method} ${path}`);
    if (hit instanceof Error) throw hit;
    return hit;
  }) as Fetcher;
}

const ANON = { "/api/auth/session": { authenticated: false, discordSsoEnabled: true } };
const AS = (coach: string, extra: Record<string, unknown> = {}) => ({ "/api/auth/session": { authenticated: true, coach, authMethod: "discord", ...extra } });

// Fake data (invented names only).
const DATA: Routes = {
  "/api/admin/overview": { version: { commit: "abc1234", buildLog: { date: "2026-11-04", title: "Admin console" } }, startedAt: "2026-11-04T08:00:00.000Z", uptimeSeconds: 7260, node: "v24.0.0",
    counts: { coaches: 42, leagues: 7, tournaments: 5, openReports: 3, openBoardReports: 2, stuckPrivacyJobs: 1 } },
  "/api/admin/ops/log?limit=12": { entries: [{ at: "2026-11-04T09:00:00.000Z", by: "Root", action: "ratings-reset", dryRun: true, ok: true, status: 200, summary: "Dry run: 4 rated coaches." }] },
  "/api/admin/ops/log?limit=50": { entries: [] },
  "/api/fork/users": { users: [
    { fumbblName: "Alice", linked: { discordUserId: "555000111", nafName: "alice", nafId: 1234, id: "c-1" }, games: [{ gameId: "g77", status: "live", homeTeamId: "T1", homeTeamName: "Alice Orcs", awayTeamId: "T2", awayTeamName: "Bob Elves" }] },
    { fumbblName: "Bob", linked: null, games: [] },
  ] },
  "/api/admin/identities": { coaches: { alice: { ffbCoachId: "Alice", level: "organizer", banned: false, silenced: false, identities: { discordUsername: "alice_example" } }, bob: { ffbCoachId: "Bob", level: "player" } } },
  "/api/fork/games": { games: [{ gameId: "g77", status: "live", half: 1, turn: 4 }] },
  "/api/fork/matchmaking-settings": { homeAwayMode: "alternating", overtime: false },
  "/api/admin/teams/search?q=Orc&mode=name": [{ teamId: "T1", name: "Alice Orcs", coach: "Alice", roster: "Orc", status: "Active" }],
  "/api/teams/T1/detail": { team: {
    id: "T1", name: "Alice Orcs", race: "Orc", treasury: 50000, teamValue: 1000, teamStatus: "Active", revision: 3, resurrection: false,
    rerolls: 2, assistantCoaches: 1, cheerleaders: 0, apothecary: true, fanFactor: 2,
    players: [
      { id: "p1", number: 1, name: "Gruk", position: "Blitzer", positionId: "orc-blitzer", status: "Active", currentValue: 80000, movement: 6, strength: 3, agility: 3, passing: 4, armour: 10, skills: ["Block"], injuries: [] },
      { id: "p2", number: 2, name: "Mog", position: "Lineman", positionId: "orc-line", status: "Active", currentValue: 50000, movement: 5, strength: 3, agility: 3, passing: 4, armour: 10, skills: [], injuries: ["Niggling Injury"] },
    ],
    firedPlayers: [{ id: "p9", name: "Old Zug", position: "Lineman", positionId: "orc-line", reason: "Fired" }],
  } },
  "/api/fork/rosters": { rosters: [{ raceName: "Orc", positions: [
    { positionId: "orc-blitzer", name: "Blitzer", cost: 80000, max: 4, MA: 6, ST: 3, AG: "3+", PA: "4+", AV: "10+" },
    { positionId: "orc-line", name: "Lineman", cost: 50000, max: 16, MA: 5, ST: 3, AG: "3+", PA: "4+", AV: "10+" },
  ] }] },
  "/api/skills": { general: [{ name: "Block" }, { name: "Dodge" }], elite: [] },
  "/api/bug-reports": { reports: [{ id: "R1", kind: "bug", coach: "Bob", description: "Ball vanished", gameService: "fork", gameId: "g77", submittedAt: "2026-11-03", triage: { status: "new" } }] },
  "/api/bug-reports/R1": { report: { id: "R1", kind: "bug", coach: "Bob", description: "Ball vanished", gameService: "fork", gameId: "g77", submittedAt: "2026-11-03", clientVersion: "1.0.300", triage: { status: "new" }, playerUpdate: { reply: "Thanks", fixedIn: "" } } },
  "/api/admin/moderation": { boards: [{ scope: "league:river", kind: "league", id: "river", name: "River League", href: "/app/leagues/river?tab=board", enabled: true, publicRead: false,
    openReports: [{ id: "r1", postId: "p1", threadId: "p1", reporter: "Bob", reason: "Rude", at: "2026-11-02T10:00:00.000Z", post: { author: "Alice", text: "Mean words", removed: false, hidden: false } }],
    mutes: [{ coach: "Alice", until: "2099-01-01T00:00:00.000Z", by: "Bob" }] }], unreadable: 0, openReports: 1, mutes: 1 },
  "/api/admin/privacy/jobs": { open: [{ jobId: "a".repeat(24), pseudonym: "Deleted coach #3", pending: ["fork-db"], startedAt: "2026-11-01T00:00:00.000Z", stuck: true }], failed: [] },
  "/api/fork/tournaments?status=all": { tournaments: [{ id: "t1", name: "Spike Open", status: "active", format: "swiss", packageName: "nut", ownerCoachId: "Alice", organizerCoachIds: [] }], page: 1, pageSize: 20, total: 1, hasMore: false },
  "/api/admin/ops/ratings": { resetAt: null, revision: "none", preview: { coaches: 4, games: 9 }, backups: [{ name: "site-ratings-20261104T100000000Z.json", createdAt: "2026-11-04T10:00:00.000Z", size: 180, reason: "before-reset", existed: false, resetAt: null }], confirm: { reset: "RESET RATINGS", restore: "RESTORE RATINGS" } },
  "/api/fork/legacy-password-auth": { counts: { "fork/login": 2 } },
};

describe("admin console (server-rendered)", () => {
  let vite: ViteDevServer;
  let mods: Record<string, any>;
  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [app, vueRouter, renderer, router, session] = await Promise.all([
      vite.ssrLoadModule("/src/app.ts"), vite.ssrLoadModule("vue-router"), vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/router.ts"), vite.ssrLoadModule("/src/session.ts"),
    ]);
    mods = { app, vueRouter, renderer, router, session };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  async function render(path: string, routes: Routes) {
    const f = mockFetcher({ ...ANON, ...DATA, ...routes });
    const spa = mods.app.createSpa({ history: mods.vueRouter.createMemoryHistory("/app/"), ssr: true, fetcher: f });
    await spa.router.push(path);
    await spa.router.isReady();
    return { html: (await mods.renderer.renderToString(spa.app)) as string, spa };
  }
  const ADMIN = AS("Root", { admin: true });
  const text = (html: string) => html.replace(/<!--[^]*?-->/g, "").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

  describe("router guard", () => {
    it("gateFor: signed out = sign-in, coach or organiser = 403, site admin = the page; a pending re-read never flashes the page to a non-admin", async () => {
      const meta = { meta: { requiresAuth: true, requiresAdmin: true } };
      const session = async (info: Record<string, unknown>) => { const s = mods.session.createSessionStore(mockFetcher({ "/api/auth/session": info })); await s.load(); return s; };
      expect(mods.router.gateFor(meta, await session({ authenticated: false }))).toBe("signin");
      expect(mods.router.gateFor(meta, await session({ authenticated: true, coach: "Bob", authMethod: "discord" }))).toBe("forbidden");
      expect(mods.router.gateFor(meta, await session({ authenticated: true, coach: "Org", authMethod: "discord", organizer: true }))).toBe("forbidden");
      expect(mods.router.gateFor(meta, await session({ authenticated: true, coach: "Root", authMethod: "discord", admin: true }))).toBe("allow");
      // a password session is not a site sign-in here
      expect(mods.router.gateFor(meta, await session({ authenticated: true, coach: "Root", authMethod: "password", admin: true }))).toBe("signin");
      const pending = await session({ authenticated: true, coach: "Bob", authMethod: "discord" });
      pending.state.status = "loading";
      expect(mods.router.gateFor(meta, pending)).not.toBe("allow");
    });

    it("every section route needs a site admin", async () => {
      for (const s of ADMIN_SECTIONS) {
        const anon = await render(`/admin/${s.id}`, {});
        expect(anon.html, s.id).toContain("Login with Discord");
        expect(anon.html, s.id).not.toContain("Admin console</h2>");
        const coach = await render(`/admin/${s.id}`, AS("Bob"));
        expect(coach.html, s.id).toContain("data-forbidden");
        const org = await render(`/admin/${s.id}`, AS("Org", { organizer: true }));
        expect(org.html, s.id).toContain("data-forbidden");
      }
    });

    it("the old separate admin pages are guarded too (they redirect into the console)", async () => {
      for (const old of ["/admin/tournaments", "/admin/organiser-requests"]) {
        const coach = await render(old, AS("Bob"));
        expect(coach.spa.router.currentRoute.value.fullPath).toBe("/admin/organisers");
        expect(coach.html).toContain("data-forbidden");
      }
    });
  });

  describe("redirects", () => {
    it("/admin and the old admin.html hash links land on their section", async () => {
      expect(adminSectionFromHash("#users")).toBe("users");
      expect(adminSectionFromHash("#games")).toBe("games");
      expect(adminSectionFromHash("#nonsense")).toBe("overview");
      for (const [hash, section] of [["", "overview"], ["#users", "users"], ["#teams", "teams"], ["#games", "games"], ["#reports", "reports"], ["#operations", "operations"]] as const) {
        const r = await render(`/admin${hash}`, ADMIN);
        expect(r.spa.router.currentRoute.value.fullPath, hash).toBe(`/admin/${section}`);
      }
    });

    it("an unknown section is the 404 page", async () => {
      const r = await render("/admin/bogus", ADMIN);
      expect(r.spa.router.currentRoute.value.name).toBe("not-found");
    });

    it("the sidebar Testing category links the console; control-panel.html and users.html point at the new routes", async () => {
      const r = await render("/admin/overview", ADMIN);
      expect(r.html).toContain('href="/app/admin/overview"');
      const cp = readFileSync(fileURLToPath(new URL("../public/control-panel.html", import.meta.url)), "utf8");
      for (const href of ["/app/admin/overview", "/app/admin/teams", "/app/admin/users", "/app/admin/games"]) expect(cp).toContain(`href="${href}"`);
      expect(cp).not.toContain("admin.html");
      expect(readFileSync(fileURLToPath(new URL("../public/users.html", import.meta.url)), "utf8")).not.toContain("admin.html");
    });
  });

  describe("sections", () => {
    const DEEP: Partial<Record<AdminSectionId, string>> = { users: "?edit=Alice", teams: "?q=Orc&mode=name&team=T1&player=p1", reports: "?report=R1" };

    it("every section renders with the section header, the nine tabs and the active tab marked", async () => {
      for (const s of ADMIN_SECTIONS) {
        const { html } = await render(`/admin/${s.id}${DEEP[s.id] ?? ""}`, ADMIN);
        expect(html, s.id).toContain("Admin console</h2>");
        for (const t of ADMIN_SECTIONS) expect(text(html), `${s.id} tab ${t.id}`).toContain(`>${t.label}</a>`);
        expect(html, s.id).toMatch(new RegExp(`<a[^>]*aria-current="page"[^>]*data-tab="${s.id}"|<a[^>]*data-tab="${s.id}"[^>]*aria-current="page"`));
        expect(html.match(/aria-current="page"[^>]*data-tab=|data-tab="[^"]+"[^>]*aria-current="page"/g), s.id).toHaveLength(1);
        expect(html, s.id).toContain(`data-section="${s.id}"`);
      }
    });

    it("parity smoke test: every action of the old admin.js is reachable in its v2 section", async () => {
      const bySection = new Map<AdminSectionId, string>();
      for (const s of ADMIN_SECTIONS) bySection.set(s.id, text((await render(`/admin/${s.id}${DEEP[s.id] ?? ""}`, ADMIN)).html));
      for (const p of PARITY) {
        if (p.shell) continue;
        expect(bySection.get(p.section), `${p.old} -> ${p.section}: "${p.control}"`).toContain(p.control);
      }
      // shell rows: signed out the sign-in prompt shows; signed in the account menu has Sign out
      expect((await render("/admin/users", {})).html).toContain("Login with Discord");
      expect(readFileSync(fileURLToPath(new URL("../spa/src/components/AccountMenu.vue", import.meta.url)), "utf8")).toContain("Sign out");
    });

    it("overview shows the version, uptime and the counts as links into their sections", async () => {
      const { html } = await render("/admin/overview", ADMIN);
      expect(html).toContain("abc1234");
      expect(html).toContain("2 h 1 min");
      expect(html).toMatch(/href="\/app\/admin\/reports"[^>]*data-count="openReports"/);
      expect(html).toMatch(/href="\/app\/admin\/moderation"[^>]*data-count="openBoardReports"/);
      expect(html).toMatch(/href="\/app\/admin\/privacy-jobs"[^>]*data-count="stuckPrivacyJobs"/);
    });

    it("moderation lists the board's open report and mute, linked to the board, with the actions", async () => {
      const { html } = await render("/admin/moderation", ADMIN);
      const t = text(html);
      expect(t).toContain("River League");
      expect(html).toContain('href="/app/leagues/river?tab=board"');
      for (const c of ["Hide post", "Dismiss", "Dealt with", "Lift", "Mean words"]) expect(t).toContain(c);
    });

    it("operations: every tool is there, and the ratings backups list time and size", async () => {
      const t = text((await render("/admin/operations", ADMIN)).html);
      for (const c of ["Reload the game server", "League fork cleanup", "Dry run", "Ratings reset", "Dry run reset", "Ratings backups", "Restore", "180 B", "Demo leagues", "Dry run seed", "Dry run remove", "Test match", "Legacy password sign-ins", "fork/login", "Operations log"]) {
        expect(t, c).toContain(c);
      }
    });

    it("organisers holds the request queue and the tournaments list; privacy jobs list retry / close", async () => {
      const org = text((await render("/admin/organisers", ADMIN)).html);
      expect(org).toContain("Organiser requests");
      expect(org).toContain("All tournaments"); // its rows load in the browser (spaTournamentsP2 covers them)
      const jobs = text((await render("/admin/privacy-jobs", ADMIN)).html);
      for (const c of ["Deleted coach #3", "Stuck", "Retry", "Close", "fork-db"]) expect(jobs).toContain(c);
    });

    it("reports: the System row shows the reporter's OS as escaped text, 'not reported' when absent", async () => {
      const mk = (extra: Record<string, unknown>) => ({ id: "2026-11-13T10-00-00-000Z_Kildash_nogame", coach: "Kildash", kind: "bug", description: "d", submittedAt: "2026-11-13T10:00:00.000Z", gameId: null, gameService: null, clientVersion: "1.0.321", files: {}, triage: { status: "new" }, playerUpdate: {}, ...extra });
      const page = async (r: ReturnType<typeof mk>) => (await render(`/admin/reports?report=${encodeURIComponent(r.id)}`, { ...ADMIN, "/api/bug-reports": { reports: [r] }, [`/api/bug-reports/${encodeURIComponent(r.id)}`]: { report: r } })).html;
      const html = await page(mk({ osLabel: "Windows <i>11</i>", context: { os: { label: "Windows <i>11</i>" } } }));
      expect(html).toContain("<dt>System</dt>");
      expect(html).toContain("Windows &lt;i&gt;11&lt;/i&gt;");
      expect(html).not.toContain("Windows <i>11</i>");
      expect(await page(mk({}))).toContain("not reported");
    });

    it("reports: the reply and Fixed-in sit in their own 'Visible to the player' block after the private triage; one PATCH carries both (ported from adminReportReply)", async () => {
      const REPORT = {
        id: "2026-11-04T10-00-00-000Z_Kildash_nogame", coach: "fumbbl:Kildash", kind: "bug", description: "Ball vanished after a blitz.", submittedAt: "2026-11-04T10:00:00.000Z",
        gameId: null, gameService: null, clientVersion: "1.0.306", files: {},
        triage: { status: "triaged", rootCause: "Stale offer", reason: "Private note" },
        playerUpdate: { reply: "Thanks <b>!</b>", replyAt: "2026-11-04T11:00:00.000Z", fixedIn: "1.0.307", updatedAt: "2026-11-04T11:00:00.000Z" },
      };
      const { html } = await render(`/admin/reports?report=${encodeURIComponent(REPORT.id)}`, {
        ...ADMIN, "/api/bug-reports": { reports: [REPORT] }, [`/api/bug-reports/${encodeURIComponent(REPORT.id)}`]: { report: REPORT },
      });
      expect(html).toContain("<legend>Visible to the player</legend>");
      expect(html).toContain("Reply to the reporter (shown to the player)");
      expect(html).toContain("Fixed in version (shown to the player)");
      expect(html).toContain('maxlength="2000"');
      expect(html).toContain('value="1.0.307"');
      expect(html).toContain("Thanks &lt;b&gt;!&lt;/b&gt;"); // escaped
      const block = html.slice(html.indexOf('<fieldset class="adm-fieldset">'), html.indexOf("</fieldset>"));
      expect(block).not.toContain("Stale offer");
      expect(block).not.toContain("Private note");
      expect(html.indexOf("Stale offer")).toBeLessThan(html.indexOf('<fieldset class="adm-fieldset">'));
      expect(html).toContain("private to organisers and admins");
      expect(triageBody({ status: "resolved", rootCause: "Stale offer", reason: "Private note", reply: "Fixed, thanks!", fixedIn: "1.0.307" }))
        .toEqual({ status: "resolved", rootCause: "Stale offer", reason: "Private note", reply: "Fixed, thanks!", fixedIn: "1.0.307" });
      const src = readFileSync(fileURLToPath(new URL("../spa/src/admin/AdminReports.vue", import.meta.url)), "utf8");
      expect(src).toContain('{ method: "PATCH", body: triageBody(form) }');
    });

    it("the Users section carries the Delete a coach card (moved from Tabletop)", async () => {
      expect(text((await render("/admin/users", ADMIN)).html)).toContain("Delete a coach");
      const tabletop = readFileSync(fileURLToPath(new URL("../spa/src/views/TabletopListView.vue", import.meta.url)), "utf8");
      expect(tabletop).not.toContain("AdminDeleteCoachCard");
    });
  });

  it("design rules: tokens only in admin.css, no legacy lobby- classes, no hyphenated reroll", () => {
    const css = readFileSync(fileURLToPath(new URL("../spa/src/admin/admin.css", import.meta.url)), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    for (const f of ["AdminOverview", "AdminUsers", "AdminTeams", "AdminGames", "AdminReports", "AdminModeration", "AdminOrganisers", "AdminPrivacyJobs", "AdminOperations", "AdminGameCard", "OpsConfirm"]) {
      const src = readFileSync(fileURLToPath(new URL(`../spa/src/admin/${f}.vue`, import.meta.url)), "utf8");
      expect(src, f).not.toMatch(/lobby-|re-roll|style="/i);
    }
  });
});
