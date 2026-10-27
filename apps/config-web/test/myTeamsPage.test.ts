import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// My Teams page (owner 10-27). The repo has no jsdom, so the page controller runs against a small DOM stub built
// from the real my-teams.html markup: one stub element per id, plus the nav links carrying data-*-only flags.
const publicDir = new URL("../public/", import.meta.url);
const js = readFileSync(new URL("my-teams.js", publicDir), "utf8");
const html = readFileSync(new URL("my-teams.html", publicDir), "utf8");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
function loadMyTeams(): Any {
  const context: Record<string, unknown> = { console };
  runInNewContext(js, context);
  return context.MyTeams;
}
const MyTeams = loadMyTeams();

function stubElement(id = ""): Any {
  const listeners: Record<string, Array<(event: Any) => unknown>> = {};
  const classes = new Set<string>();
  return {
    id, hidden: /hidden/.test(html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] ?? ""), textContent: "", innerHTML: "", className: "", href: "", disabled: false, open: false,
    attributes: {} as Record<string, string>,
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)), contains: (name: string) => classes.has(name) },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    addEventListener(type: string, fn: (event: Any) => unknown) { (listeners[type] ??= []).push(fn); },
    contains: () => false,
    listeners,
  };
}

function stubDocument() {
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
  const byId = new Map(ids.map((id) => [id, stubElement(id)]));
  const nav = [...html.matchAll(/<a [^>]*>[^<]*<\/a>/g)].map((m) => m[0]).filter((tag) => /data-(admin|signed-in)-only/.test(tag)).map((tag) => ({
    tag, text: tag.replace(/<[^>]+>/g, ""), hidden: true, admin: tag.includes("data-admin-only"), signedIn: tag.includes("data-signed-in-only"),
  }));
  const doc = {
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: (selector: string) => nav.filter((link) => (selector === "[data-admin-only]" ? link.admin : selector === "[data-signed-in-only]" ? link.signedIn : false)),
    addEventListener: () => undefined,
  };
  return { doc, byId, nav };
}

const fixture = [
  { id: "sv_old", name: "Old Orcs", rosterId: "orc", raceName: "Orc", packageName: "Small Gods 2026", teamId: null, updatedAt: "2026-10-01T10:00:00.000Z", createdAt: "2026-10-01T10:00:00.000Z" },
  { id: "sv_new", name: "Dwarf <Gold>", rosterId: "dwarf", raceName: "Dwarf", packageName: "EuroBowl 2026", teamId: "123", updatedAt: "2026-10-27T09:00:00.000Z", createdAt: "2026-10-20T10:00:00.000Z" },
  { id: "sv_plain", name: "Plain Elves", rosterId: "woodelf", raceName: "", packageName: null, teamId: null, updatedAt: "2026-10-15T10:00:00.000Z", createdAt: "2026-10-15T10:00:00.000Z" },
];

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function makePage(routes: Record<string, (init: Any) => { status: number; body: unknown }>, overrides: Partial<Any> = {}) {
  const { doc, byId, nav } = stubDocument();
  const calls: Array<{ path: string; method: string; body?: string }> = [];
  const navigations: string[] = [];
  const page = MyTeams.createMyTeamsPage({
    document: doc,
    fetch: async (path: string, init: Any = {}) => {
      const method = init.method ?? "GET";
      calls.push({ path, method, body: init.body });
      const route = routes[`${method} ${path}`];
      if (!route) return respond(404, { error: "not found" });
      const out = route(init);
      return respond(out.status, out.body);
    },
    navigate: (url: string) => navigations.push(url),
    prompt: () => null,
    confirm: () => false,
    location: { pathname: "/my-teams.html", hostname: "localhost" },
    ...overrides,
  });
  return { page, byId, nav, calls, navigations };
}

const signedIn = { "GET /api/auth/session": () => ({ status: 200, body: { authenticated: true, coach: "Jay", discordSsoEnabled: true } }) };
const savesRoute = { "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: fixture } }) };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const clickTarget = (attr: string, id: string): Any => ({ closest: (selector: string) => (selector === `[${attr}]` ? { dataset: { [attr.replace(/^data-/, "").replace(/-(\w)/g, (_m, c: string) => c.toUpperCase())]: id } } : null) });

describe("my teams page — table core", () => {
  it("orders saves newest first and maps Name / Race / Ruleset", () => {
    expect(MyTeams.rows(fixture).map((row: Any) => [row.name, row.race, row.ruleset])).toEqual([
      ["Dwarf <Gold>", "Dwarf", "EuroBowl 2026"],
      ["Plain Elves", "woodelf", ""],
      ["Old Orcs", "Orc", "Small Gods 2026"],
    ]);
  });

  it("renders a three-column table with escaped names, and an empty state", () => {
    const markup = MyTeams.tableHtml(MyTeams.rows(fixture));
    expect([...markup.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((m: RegExpMatchArray) => m[1])).toEqual(["Name", "Race", "Ruleset"]);
    expect(markup).toContain("Dwarf &lt;Gold&gt;");
    expect(markup).not.toContain("Dwarf <Gold>");
    expect([...markup.matchAll(/data-open-save="([^"]+)"/g)].map((m: RegExpMatchArray) => m[1])).toEqual(["sv_new", "sv_plain", "sv_old"]);
    expect(markup).toContain('data-rename-save="sv_new"');
    expect(markup).toContain('data-delete-save="sv_new"');
    expect(MyTeams.tableHtml([])).toContain("No saved teams yet.");
  });
});

describe("my teams page — controller", () => {
  it("signed out: only the Discord button and the sign-in line; nav link and list stay hidden", async () => {
    const { page, byId, nav, calls } = makePage({ "GET /api/auth/session": () => ({ status: 200, body: { authenticated: false, discordSsoEnabled: true } }) });
    await page.start();
    expect(byId.get("login-form").hidden).toBe(false);
    expect(byId.get("signed-in-session").hidden).toBe(true);
    expect(byId.get("my-teams-signin").hidden).toBe(false);
    expect(html).toContain("Sign in to see your teams.");
    expect(byId.get("my-teams-list").hidden).toBe(true);
    expect(byId.get("my-teams-list").innerHTML).toBe("");
    expect(nav.find((link) => link.text === "My Teams")!.hidden).toBe(true);
    expect(calls.map((c) => c.path)).not.toContain("/api/fork/team-builder/saves");
  });

  it("signed in: shows the table from the saves list and reveals the My Teams nav link (admin links stay hidden)", async () => {
    const { page, byId, nav } = makePage({ ...signedIn, ...savesRoute });
    await page.start();
    expect(byId.get("login-form").hidden).toBe(true);
    expect(byId.get("signed-in-coach").textContent).toBe("Jay");
    expect(byId.get("my-teams-signin").hidden).toBe(true);
    const list = byId.get("my-teams-list");
    expect(list.hidden).toBe(false);
    expect(list.innerHTML).toContain("<td>Dwarf</td>");
    expect(list.innerHTML).toContain("EuroBowl 2026");
    expect(nav.find((link) => link.text === "My Teams")!.hidden).toBe(false);
    expect(nav.filter((link) => link.admin).every((link) => link.hidden)).toBe(true);
  });

  it("shows the empty state for a coach without saves", async () => {
    const { page, byId } = makePage({ ...signedIn, "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: [] } }) });
    await page.start();
    expect(byId.get("my-teams-list").innerHTML).toContain("No saved teams yet.");
  });

  it("a row click (or Enter) opens the Tournament Team Builder with ?save=<id>", async () => {
    const { page, byId, navigations } = makePage({ ...signedIn, ...savesRoute });
    await page.start();
    byId.get("my-teams-list").listeners.click[0]({ target: clickTarget("data-open-save", "sv_new") });
    byId.get("my-teams-list").listeners.keydown[0]({ key: "Enter", target: clickTarget("data-open-save", "sv/old") });
    expect(navigations).toEqual(["/tournament-team-builder.html?save=sv_new", "/tournament-team-builder.html?save=sv%2Fold"]);
  });

  it("Rename PUTs the stored body under the new name; Delete asks first and DELETEs", async () => {
    let listed = fixture;
    const routes: Record<string, (init: Any) => { status: number; body: unknown }> = {
      ...signedIn,
      "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: listed } }),
      "GET /api/fork/team-builder/saves/sv_old": () => ({ status: 200, body: { save: { id: "sv_old", body: { rosterId: "orc", packageName: "Small Gods 2026" } } } }),
      "PUT /api/fork/team-builder/saves/sv_old": () => ({ status: 200, body: { save: { id: "sv_old" } } }),
      "DELETE /api/fork/team-builder/saves/sv_old": () => { listed = fixture.filter((s) => s.id !== "sv_old"); return { status: 204, body: {} }; },
    };
    const { page, byId, calls, navigations } = makePage(routes, { prompt: () => "  Green Tide ", confirm: () => true });
    await page.start();
    await page.onListClick({ target: clickTarget("data-rename-save", "sv_old") });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ name: "Green Tide", body: { rosterId: "orc", packageName: "Small Gods 2026" } });
    await page.onListClick({ target: clickTarget("data-delete-save", "sv_old") });
    await tick();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/fork/team-builder/saves/sv_old")).toBe(true);
    expect(byId.get("my-teams-list").innerHTML).not.toContain("sv_old");
    expect(byId.get("my-teams-status").textContent).toBe("Deleted “Old Orcs”.");
    expect(navigations).toEqual([]);
  });

  it("an expired session drops back to the signed-out view", async () => {
    const { page, byId } = makePage({ ...signedIn, "GET /api/fork/team-builder/saves": () => ({ status: 401, body: { error: "expired" } }) });
    await page.start();
    expect(byId.get("login-form").hidden).toBe(false);
    expect(byId.get("my-teams-list").hidden).toBe(true);
    expect(byId.get("login-message").textContent).toMatch(/session expired/);
  });
});

describe("my teams page — share links (owner 10-27)", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  it("marks shared rows and offers Share on every row, Unshare only on shared ones", () => {
    const list = [{ ...fixture[0]!, shareToken: TOKEN }, fixture[1]!];
    const markup = MyTeams.tableHtml(MyTeams.rows(list));
    expect(markup).toContain('data-share-save="sv_old"');
    expect(markup).toContain('data-share-save="sv_new"');
    expect(markup).toContain('data-unshare-save="sv_old"');
    expect(markup).not.toContain('data-unshare-save="sv_new"');
    expect((markup.match(/class="my-teams-shared"/g) ?? []).length).toBe(1);
    expect(markup).not.toContain(TOKEN); // the table never prints the token itself
    expect(MyTeams.shareUrl("https://x.test/", TOKEN)).toBe(`https://x.test/t/${TOKEN}`);
  });

  it("Share POSTs, copies the /t/<token> link, says Link copied and shows the link with Copy", async () => {
    let listed: Any[] = fixture;
    const copied: string[] = [];
    const routes: Record<string, (init: Any) => { status: number; body: unknown }> = {
      ...signedIn,
      "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: listed } }),
      "POST /api/fork/team-builder/saves/sv_new/share": () => {
        listed = fixture.map((s) => (s.id === "sv_new" ? { ...s, shareToken: TOKEN } : s));
        return { status: 201, body: { shareToken: TOKEN, path: `/t/${TOKEN}` } };
      },
    };
    const { page, byId, calls, navigations } = makePage(routes, {
      clipboard: async (text: string) => { copied.push(text); },
      location: { pathname: "/my-teams.html", hostname: "x.test", origin: "https://x.test" },
    });
    await page.start();
    await page.onListClick({ target: clickTarget("data-share-save", "sv_new") });
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/fork/team-builder/saves/sv_new/share")).toBe(true);
    expect(copied).toEqual([`https://x.test/t/${TOKEN}`]);
    expect(byId.get("my-teams-status").textContent).toMatch(/^Link copied/);
    const list = byId.get("my-teams-list").innerHTML;
    expect(list).toContain(`value="https://x.test/t/${TOKEN}"`);
    expect(list).toContain("data-copy-share");
    expect(list).toContain('class="my-teams-shared"');
    expect(navigations).toEqual([]);
    await page.onListClick({ target: clickTarget("data-copy-share", "") });
    expect(copied).toHaveLength(2);
    expect(byId.get("my-teams-status").textContent).toBe("Link copied.");
  });

  it("without clipboard access the link is still shown to copy by hand", async () => {
    const routes = { ...signedIn, ...savesRoute, "POST /api/fork/team-builder/saves/sv_old/share": () => ({ status: 200, body: { shareToken: TOKEN } }) };
    const { page, byId } = makePage(routes, { clipboard: async () => { throw new Error("denied"); }, location: { pathname: "/my-teams.html", hostname: "x.test", origin: "https://x.test" } });
    await page.start();
    await page.onListClick({ target: clickTarget("data-share-save", "sv_old") });
    expect(byId.get("my-teams-status").textContent).toMatch(/Share link ready/);
    expect(byId.get("my-teams-list").innerHTML).toContain(`/t/${TOKEN}`);
  });

  it("Unshare asks first, DELETEs and hides the link", async () => {
    let listed: Any[] = fixture.map((s) => (s.id === "sv_old" ? { ...s, shareToken: TOKEN } : s));
    const routes: Record<string, (init: Any) => { status: number; body: unknown }> = {
      ...signedIn,
      "GET /api/fork/team-builder/saves": () => ({ status: 200, body: { saves: listed } }),
      "DELETE /api/fork/team-builder/saves/sv_old/share": () => { listed = fixture; return { status: 204, body: {} }; },
    };
    let asked = "";
    const declined = makePage(routes, { confirm: (m: string) => { asked = m; return false; } });
    await declined.page.start();
    await declined.page.onListClick({ target: clickTarget("data-unshare-save", "sv_old") });
    expect(asked).toMatch(/Stop sharing “Old Orcs”/);
    expect(declined.calls.some((c) => c.method === "DELETE")).toBe(false);
    const { page, byId, calls } = makePage(routes, { confirm: () => true });
    await page.start();
    await page.onListClick({ target: clickTarget("data-unshare-save", "sv_old") });
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/api/fork/team-builder/saves/sv_old/share")).toBe(true);
    expect(byId.get("my-teams-status").textContent).toBe("“Old Orcs” is no longer shared.");
    expect(byId.get("my-teams-list").innerHTML).not.toContain('class="my-teams-shared"');
  });
});

describe("my teams page — markup and serving", () => {
  it("reuses the builder shell, styles and header sign-in slot", () => {
    expect(html).toContain("<title>Super FUMBBL — My Teams</title>");
    expect(html).toContain('<link rel="stylesheet" href="/team-builder.css" />');
    expect(html).toContain('<script src="/my-teams.js" defer></script>');
    expect(html).toContain('<a class="active" href="/my-teams.html" aria-current="page" data-signed-in-only hidden>My Teams</a>');
    for (const id of ["discord-login", "signed-in-session", "logout-button", "my-teams-list", "my-teams-signin"]) expect(html).toContain(`id="${id}"`);
  });

  it("is served without the admin gate like the builders", () => {
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
    const sidecar = readFileSync(new URL("../src/auth/requireSession.ts", import.meta.url), "utf8");
    for (const path of ["/my-teams.html", "/my-teams.js"]) {
      expect(server).toContain(`pathname === "${path}"`);
      expect(sidecar).toContain(`pathname === "${path}"`);
    }
  });
});
