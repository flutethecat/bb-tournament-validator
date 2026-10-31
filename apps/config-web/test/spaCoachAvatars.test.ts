import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createSSRApp } from "vue";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ViteDevServer } from "vite";
import type { Fetcher } from "../spa/src/session";
import { avatarSrc, createAvatarFallback } from "../spa/src/shared/avatarUrl";
import { createProfileEditor, OWN_AVATAR_PATH, type OwnAvatarUploader, type ProfileView } from "../spa/src/account/profile";

// Coach avatars on the client (owner 10-31): the card allow-list and load-error fallback, the Account page avatar
// control (Upload / Remove), and the race line under the crest wrapping only at spaces.

const SPA_CONFIG = fileURLToPath(new URL("../spa/vite.config.ts", import.meta.url));
const CARD_CSS = readFileSync(fileURLToPath(new URL("../spa/src/shared/result-card.css", import.meta.url)), "utf8");

const view = (over: Partial<ProfileView> = {}): ProfileView => ({
  coach: "Alice", displayName: "", fumbblName: "", fumbblLinked: false, nafName: "", nafId: "",
  avatar: "https://cdn.discordapp.com/avatars/1/a.png?size=256", avatarSource: "discord", discord: { linked: true, username: "a" }, connections: [], ...over,
});

function fetcher(routes: Record<string, (init?: { method?: string }) => unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (path: string, init?: { method?: string }) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const hit = routes[path];
    if (!hit) throw new Error(`no mock for ${path}`);
    return hit(init);
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("card avatar allow-list and fallback", () => {
  it("allows https cdn.discordapp.com and the site's coach-avatar route only", () => {
    expect(avatarSrc("https://cdn.discordapp.com/avatars/1/a.png?size=64")).toBe("https://cdn.discordapp.com/avatars/1/a.png?size=64");
    expect(avatarSrc("/api/coach-avatars/alice?v=12")).toBe("/api/coach-avatars/alice?v=12");
    for (const bad of ["http://cdn.discordapp.com/a.png", "https://evil.test/a.png", "https://cdn.discordapp.com:8443/a.png", "//cdn.discordapp.com/a.png",
      "/api/fork/teams/x/avatar", "/api/coach-avatars/a/b", "javascript:alert(1)", "", null, undefined]) {
      expect(avatarSrc(bad as string)).toBe("");
    }
  });

  it("a failed avatar falls back to the letter badge with the error marker; other sides are unaffected", () => {
    const fb = createAvatarFallback();
    const ok = "/api/coach-avatars/alice?v=1";
    const other = "https://cdn.discordapp.com/avatars/2/b.png";
    expect(fb.shown(ok)).toBe(ok);
    expect(fb.marker(ok)).toBeUndefined();
    fb.fail(ok);
    expect(fb.shown(ok)).toBe("");
    expect(fb.marker(ok)).toBe("error");
    expect(fb.shown(other)).toBe(other);
    expect(fb.marker("https://evil.test/x.png")).toBeUndefined(); // never allowed: plain badge, no marker
  });
});

describe("profile editor avatar actions", () => {
  it("upload adopts the server's avatar without touching unsaved form edits; errors show inline", async () => {
    let answer: Awaited<ReturnType<OwnAvatarUploader>> = { ok: true, status: 200, profile: view({ avatar: "/api/coach-avatars/alice?v=9", avatarSource: "upload" }) };
    const sent: Blob[] = [];
    const ed = createProfileEditor({ api: fetcher({ "/api/me/profile": () => view() }), coach: "Alice", uploadAvatar: async (b) => { sent.push(b); return answer; } });
    await ed.load();
    ed.edit("displayName", "Unsaved Name");
    expect(await ed.uploadAvatar(new Blob(["x"], { type: "image/webp" }))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(ed.state.view).toMatchObject({ avatar: "/api/coach-avatars/alice?v=9", avatarSource: "upload" });
    expect(ed.state.form.displayName).toBe("Unsaved Name");
    answer = { ok: false, status: 400, error: "The image must be a PNG, JPEG or WebP file." };
    expect(await ed.uploadAvatar(new Blob(["x"]))).toBe(false);
    expect(ed.state.avatar.error).toBe("The image must be a PNG, JPEG or WebP file.");
    expect(ed.state.avatar.busy).toBe(false);
  });

  it("remove DELETEs only an uploaded avatar and falls back to the server's next source", async () => {
    const api = fetcher({
      "/api/me/profile": () => view({ avatar: "/api/coach-avatars/alice?v=9", avatarSource: "upload" }),
      [OWN_AVATAR_PATH]: () => ({ ok: true, profile: view() }),
    });
    const ed = createProfileEditor({ api, coach: "Alice" });
    await ed.load();
    expect(await ed.removeAvatar()).toBe(true);
    expect(api.calls).toContain(`DELETE ${OWN_AVATAR_PATH}`);
    expect(ed.state.view).toMatchObject({ avatarSource: "discord", avatar: "https://cdn.discordapp.com/avatars/1/a.png?size=256" });
    expect(await ed.removeAvatar()).toBe(false); // nothing uploaded any more: no request
    expect(api.calls.filter((c) => c.startsWith("DELETE"))).toHaveLength(1);
  });
});

describe("SSR markup", () => {
  let vite: ViteDevServer;
  let mods: { renderToString: (app: unknown) => Promise<string>; ResultCard: unknown; AccountIdentity: unknown };

  beforeAll(async () => {
    const { createServer } = await import("vite");
    vite = await createServer({ configFile: SPA_CONFIG, logLevel: "silent", appType: "custom", server: { middlewareMode: true, hmr: false, ws: false } });
    const [renderer, card, identity] = await Promise.all([
      vite.ssrLoadModule("vue/server-renderer"), vite.ssrLoadModule("/src/components/ResultCard.vue"), vite.ssrLoadModule("/src/components/AccountIdentity.vue"),
    ]);
    mods = { renderToString: renderer.renderToString, ResultCard: card.default, AccountIdentity: identity.default };
  }, 60_000);
  afterAll(async () => { await vite?.close(); });

  const side = (coach: string, avatarUrl?: string) => ({ name: `${coach} XI`, race: "Shambling Undead", coach, crestUrl: null, score: 1, cas: 0, ...(avatarUrl ? { avatarUrl } : {}) });

  it("ResultCard: an allowed avatar is a lazy, no-referrer image left of the coach name; others are letter badges", async () => {
    const html = await mods.renderToString(createSSRApp(mods.ResultCard as never, {
      context: "Online · Friendly", home: side("Alice", "/api/coach-avatars/alice?v=3"), away: side("Zed", "https://evil.test/z.png"),
    }));
    expect(html).toMatch(/<span class="rc-coach"><img class="rc-avatar" src="\/api\/coach-avatars\/alice\?v=3" alt(="")? width="24" height="24" loading="lazy" referrerpolicy="no-referrer" decoding="async"><span class="rc-coach-name">Alice<\/span>/);
    expect(html).not.toContain("evil.test");
    expect(html).toContain('<span class="rc-avatar" aria-hidden="true">Z</span><span class="rc-coach-name">Zed</span>');
    const none = await mods.renderToString(createSSRApp(mods.ResultCard as never, { context: "x", home: side("Amy"), away: side("Bo") }));
    expect(none).not.toContain('<img class="rc-avatar"');
    // the error handler is wired to the shared fallback (SSR does not run events)
    const sfc = readFileSync(fileURLToPath(new URL("../spa/src/components/ResultCard.vue", import.meta.url)), "utf8");
    expect(sfc).toContain('@error="avatar.fail(s.side.avatarUrl)"');
    expect(sfc).toContain(':data-avatar-fallback="avatar.marker(s.side.avatarUrl)"');
  });

  it("Account page: the avatar control with Upload, the fallback line, and Remove only for an uploaded avatar", async () => {
    const render = async (v: ProfileView) => {
      const editor = createProfileEditor({ api: fetcher({ "/api/me/profile": () => v }), coach: "Alice" });
      return mods.renderToString(createSSRApp(mods.AccountIdentity as never, { editor, coach: "Alice" }));
    };
    const discord = await render(view());
    expect(discord).toContain('class="ac-avatar-ctl"');
    expect(discord).toMatch(/<label class="ac-avatar-up" for="ac-avatar-file">Upload<\/label>/);
    expect(discord).toMatch(/<input id="ac-avatar-file" class="ac-sr" type="file" accept="image\/png,image\/jpeg,image\/webp"/);
    expect(discord).toContain("Your avatar. Falls back to your Discord avatar.");
    expect(discord).not.toContain(">Remove</button>");
    expect(discord).not.toMatch(/Avatar set by an admin|No avatar: set one on Discord/);
    const uploaded = await render(view({ avatar: "/api/coach-avatars/alice?v=4", avatarSource: "upload" }));
    expect(uploaded).toContain('src="/api/coach-avatars/alice?v=4"');
    expect(uploaded).toContain(">Remove</button>");
  });
});

describe("race line wraps only at spaces", () => {
  const rule = (selector: string) => {
    const at = CARD_CSS.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return CARD_CSS.slice(at, CARD_CSS.indexOf("}", at));
  };
  it("never breaks inside a word or hyphenates", () => {
    const race = rule(".rc-race");
    expect(race).toMatch(/overflow-wrap: normal/);
    expect(race).toMatch(/word-break: normal/);
    expect(race).toMatch(/hyphens: manual/);
    expect(race).not.toMatch(/anywhere|break-all/);
    expect(CARD_CSS).not.toMatch(/\.rc-race[^{]*\{[^}]*overflow-wrap: anywhere/);
  });
  it("the crest column can grow past the crest (up to a cap) so two-word races fit on two lines", () => {
    const col = rule(".rc-crestcol");
    expect(col).toMatch(/width: max-content/);
    expect(col).toMatch(/min-width: 64px/);
    expect(col).toMatch(/max-width: 104px/);
    expect(CARD_CSS).not.toMatch(/\.rc-crestcol \{[^}]*max-width: (64|72)px/);
    expect(CARD_CSS).toMatch(/\.rc-card\[data-size="lg"\] \.rc-crestcol \{ min-width: 72px; max-width: 124px; \}/);
  });
});
