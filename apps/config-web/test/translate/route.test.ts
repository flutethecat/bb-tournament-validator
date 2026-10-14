import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createTranslateHandler, type TranslateServiceOptions } from "../../src/translate/route.js";
import type { Detected, TranslateProvider } from "../../src/translate/providers.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Fake provider: "translates" by prefixing the target; detects German for words in GERMAN. */
const GERMAN = new Set(["hallo", "danke", "gut gemacht"]);
function fakeProvider(opts: { detect?: boolean; fail?: boolean } = {}) {
  const calls = { translate: [] as string[][], detect: [] as string[][] };
  const detectOne = (t: string): Detected => (GERMAN.has(t) ? { language: "de", confidence: 0.95 } : { language: "en", confidence: 0.9 });
  const provider: TranslateProvider = {
    name: "libretranslate",
    async translate(items, source) {
      calls.translate.push(items);
      if (opts.fail) throw new Error("upstream exploded with secret detail");
      return { texts: items.map((t) => `[de] ${t}`), detected: items.map((t) => (source === "auto" ? detectOne(t) : null)) };
    },
    ...(opts.detect ? { detect: async (items: string[]) => (calls.detect.push(items), items.map(detectOne)) } : {}),
    async languages() {
      return [{ code: "de", name: "German" }];
    },
  };
  return { provider, calls };
}

async function start(options: TranslateServiceOptions) {
  const logs: string[] = [];
  const handler = createTranslateHandler({ log: (l) => logs.push(l), ...options });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res, new URL(req.url ?? "/", "http://x").pathname))) res.writeHead(404).end();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/translate`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, post, logs };
}

describe("POST /api/translate", () => {
  it("translates a string and mirrors the LibreTranslate response shape", async () => {
    const { provider } = fakeProvider();
    const { post, logs } = await start({ selection: { setting: "libretranslate", provider } });
    const res = await post({ q: "gg wp, nice dodge on turn 8", target: "de" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      translatedText: "[de] gg wp, nice dodge on turn 8",
      detectedLanguage: { language: "en", confidence: 0.9 },
      provider: "libretranslate",
    });
    expect(logs.at(-1)).toMatch(/\[translate\] 200 provider=libretranslate items=1 chars=27 cached=0 sent=1 providerMs=\d+/);
    expect(logs.join("\n")).not.toContain("dodge"); // never log the text
  });

  it("returns arrays for an array q", async () => {
    const { provider } = fakeProvider();
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    const body = await (await post({ q: ["hi", "lol"], target: "de" })).json();
    expect(body.translatedText).toEqual(["[de] hi", "[de] lol"]);
    expect(body.detectedLanguage).toHaveLength(2);
  });

  it("short-circuits text already in the target language with provider none", async () => {
    const { provider } = fakeProvider();
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    expect(await (await post({ q: "hallo", target: "de" })).json()).toEqual({
      translatedText: "hallo",
      detectedLanguage: { language: "de", confidence: 0.95 },
      provider: "none",
    });
    // source === target never reaches the provider.
    expect(await (await post({ q: "hi", source: "en", target: "en" })).json()).toEqual({ translatedText: "hi", detectedLanguage: null, provider: "none" });
  });

  it("does not short-circuit a low-confidence detection", async () => {
    const provider: TranslateProvider = {
      name: "libretranslate",
      translate: async (items) => ({ texts: items.map(() => "x"), detected: items.map(() => ({ language: "de", confidence: 0.5 })) }),
      languages: async () => [],
    };
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    expect((await (await post({ q: "ok", target: "de" })).json()).provider).toBe("libretranslate");
  });

  it("treats a line the provider hands back unchanged as untranslated (provider none)", async () => {
    const provider: TranslateProvider = {
      name: "libretranslate",
      translate: async (items) => ({ texts: items.map((t) => ` ${t} `), detected: items.map(() => ({ language: "en", confidence: 0 })) }),
      languages: async () => [],
    };
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    expect(await (await post({ q: "hei venn", target: "en" })).json()).toEqual({
      translatedText: "hei venn",
      detectedLanguage: { language: "en", confidence: 0 },
      provider: "none",
    });
  });

  it("pre-detects with providers that support it so same-language lines are never sent", async () => {
    const { provider, calls } = fakeProvider({ detect: true });
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    const body = await (await post({ q: ["danke", "thanks"], target: "de" })).json();
    expect(body.translatedText).toEqual(["danke", "[de] thanks"]);
    expect(body.provider).toBe("libretranslate");
    expect(calls.translate).toEqual([["thanks"]]);
  });

  it("serves repeats from the cache", async () => {
    const { provider, calls } = fakeProvider();
    const { post, logs } = await start({ selection: { setting: "libretranslate", provider } });
    await post({ q: "gg", target: "de" });
    const second = await (await post({ q: ["gg", "lol"], target: "de" })).json();
    expect(second.translatedText).toEqual(["[de] gg", "[de] lol"]);
    expect(calls.translate).toEqual([["gg"], ["lol"]]);
    expect(logs.at(-1)).toContain("cached=1 sent=1");
    await post({ q: "gg", target: "fr" }); // different target = different key
    expect(calls.translate).toHaveLength(3);
  });

  it("answers 400 / 413 for bad or oversized input without calling the provider", async () => {
    const { provider, calls } = fakeProvider();
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ q: "", target: "de" })).status).toBe(400);
    expect((await post({ q: "hi", target: "nope!" })).status).toBe(400);
    expect((await post({ q: "a".repeat(2001), target: "de" })).status).toBe(413);
    expect((await post({ q: "a".repeat(40_000), target: "de" })).status).toBe(413); // body cap
    expect(calls.translate).toHaveLength(0);
  });

  it("rate limits per IP and per coach header with Retry-After", async () => {
    const { provider } = fakeProvider();
    const { post } = await start({
      selection: { setting: "libretranslate", provider },
      rateLimit: { maxRequests: 2, maxChars: 1000, windowMs: 60_000, maxKeys: 100 },
    });
    expect((await post({ q: "a", target: "de" })).status).toBe(200);
    expect((await post({ q: "b", target: "de" })).status).toBe(200);
    const limited = await post({ q: "c", target: "de" });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toEqual({ error: expect.any(String) });
  });

  it("rate limits a coach across IPs (behind the proxy, X-Forwarded-For distinguishes clients)", async () => {
    const { provider } = fakeProvider();
    const { post } = await start({
      selection: { setting: "libretranslate", provider },
      rateLimit: { maxRequests: 2, maxChars: 1000, windowMs: 60_000, maxKeys: 100 },
    });
    const as = (ip: string, coach?: string) => ({ "x-forwarded-for": ip, ...(coach ? { "x-super-fumbbl-coach": coach } : {}) });
    expect((await post({ q: "a", target: "de" }, as("10.0.0.1", "Bob"))).status).toBe(200);
    expect((await post({ q: "b", target: "de" }, as("10.0.0.2", "bob"))).status).toBe(200);
    expect((await post({ q: "c", target: "de" }, as("10.0.0.3", "BOB"))).status).toBe(429);
    expect((await post({ q: "d", target: "de" }, as("10.0.0.3", "alice"))).status).toBe(200);
  });

  it("answers 502 without leaking provider details", async () => {
    const { provider } = fakeProvider({ fail: true });
    const { post } = await start({ selection: { setting: "libretranslate", provider } });
    const res = await post({ q: "hello", target: "de" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(JSON.parse(text)).toEqual({ error: "translation provider failed" });
  });

  it("answers 503 when TRANSLATE_PROVIDER=off, and 405 for other methods", async () => {
    const { base, post } = await start({ env: { TRANSLATE_PROVIDER: "off" } });
    const res = await post({ q: "hello", target: "de" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "translation disabled" });
    expect((await fetch(`${base}/api/translate`)).status).toBe(405);
    expect((await fetch(`${base}/api/translate/languages`)).status).toBe(503);
  });
});

describe("GET /api/translate/languages", () => {
  it("returns the provider list and caches it for an hour", async () => {
    let t = 0;
    let n = 0;
    const provider: TranslateProvider = {
      name: "libretranslate",
      translate: async () => ({ texts: [], detected: [] }),
      languages: async () => (n++, [{ code: "de", name: "German", targets: ["en"] }]),
    };
    const { base } = await start({ selection: { setting: "libretranslate", provider }, now: () => t });
    expect(await (await fetch(`${base}/api/translate/languages`)).json()).toEqual([{ code: "de", name: "German", targets: ["en"] }]);
    t = 30 * 60 * 1000;
    await fetch(`${base}/api/translate/languages`);
    expect(n).toBe(1);
    t = 61 * 60 * 1000;
    await fetch(`${base}/api/translate/languages`);
    expect(n).toBe(2);
  });

  it("falls back to the static ISO list when the provider cannot list", async () => {
    const provider: TranslateProvider = {
      name: "azure",
      translate: async () => ({ texts: [], detected: [] }),
      languages: async () => {
        throw new Error("nope");
      },
    };
    const { base } = await start({ selection: { setting: "azure", provider } });
    const list = await (await fetch(`${base}/api/translate/languages`)).json();
    expect(list).toContainEqual({ code: "de", name: "German" });
    expect(list.length).toBeGreaterThanOrEqual(20);
  });
});
