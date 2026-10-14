import { describe, expect, it } from "vitest";
import {
  azureProvider,
  deeplBaseUrl,
  deeplProvider,
  deeplTargetCode,
  libreTranslateProvider,
  ProviderError,
  providerFromEnv,
  type FetchLike,
} from "../../src/translate/providers.js";

interface Call {
  url: string;
  init?: RequestInit;
  body?: unknown;
}

function mockFetch(respond: (call: Call) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    const call: Call = { url, init, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "content-type": "application/json" } });
  };
  return { fn, calls };
}

const headerOf = (c: Call, name: string) => (c.init?.headers as Record<string, string>)[name];

describe("libretranslate adapter", () => {
  it("posts q/source/target/format (+api_key) and normalises confidence to 0..1", async () => {
    const m = mockFetch(() => ({
      json: { translatedText: ["gg wp, schöner Dodge"], detectedLanguage: [{ confidence: 90, language: "en" }] },
    }));
    const p = libreTranslateProvider({ url: "http://lt:5000/", apiKey: "k" }, m.fn);
    const out = await p.translate(["gg wp, nice dodge"], "auto", "de");
    expect(m.calls[0]!.url).toBe("http://lt:5000/translate");
    expect(m.calls[0]!.body).toEqual({ q: ["gg wp, nice dodge"], source: "auto", target: "de", format: "text", api_key: "k" });
    expect(out).toEqual({ texts: ["gg wp, schöner Dodge"], detected: [{ language: "en", confidence: 0.9 }] });
  });

  it("accepts a single detectedLanguage object for a single item and no detection for explicit source", async () => {
    const m = mockFetch(() => ({ json: { translatedText: ["hallo"], detectedLanguage: { confidence: 100, language: "EN" } } }));
    expect((await libreTranslateProvider({ url: "http://lt" }, m.fn).translate(["hello"], "auto", "de")).detected).toEqual([
      { language: "en", confidence: 1 },
    ]);
    const m2 = mockFetch(() => ({ json: { translatedText: ["hallo"] } }));
    const out = await libreTranslateProvider({ url: "http://lt" }, m2.fn).translate(["hello"], "en", "de");
    expect(out.detected).toEqual([null]);
    expect(m2.calls[0]!.body).not.toHaveProperty("api_key");
  });

  it("throws ProviderError on HTTP failure, bad shape and network error", async () => {
    await expect(libreTranslateProvider({ url: "http://lt" }, mockFetch(() => ({ status: 500, json: {} })).fn).translate(["a"], "auto", "de")).rejects.toBeInstanceOf(ProviderError);
    await expect(libreTranslateProvider({ url: "http://lt" }, mockFetch(() => ({ json: { translatedText: [] } })).fn).translate(["a"], "auto", "de")).rejects.toBeInstanceOf(ProviderError);
    const failing: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await expect(libreTranslateProvider({ url: "http://lt" }, failing).translate(["a"], "auto", "de")).rejects.toBeInstanceOf(ProviderError);
  });

  it("maps ISO 'no' to Argos 'nb' on the way in and back on the way out", async () => {
    const m = mockFetch((c) =>
      c.url.endsWith("/languages")
        ? { json: [{ code: "nb", name: "Norwegian", targets: ["en", "nb", "zh-Hans"] }] }
        : { json: { translatedText: ["hei"], detectedLanguage: [{ confidence: 95, language: "nb" }] } },
    );
    const p = libreTranslateProvider({ url: "http://lt" }, m.fn);
    const out = await p.translate(["hei"], "auto", "no");
    expect(m.calls[0]!.body).toMatchObject({ source: "auto", target: "nb" });
    expect(out.detected).toEqual([{ language: "no", confidence: 0.95 }]);
    expect(await p.languages()).toEqual([{ code: "no", name: "Norwegian", targets: ["en", "no", "zh"] }]);
  });

  it("lists languages from /languages", async () => {
    const m = mockFetch(() => ({ json: [{ code: "en", name: "English", targets: ["de"] }, { bogus: 1 }] }));
    expect(await libreTranslateProvider({ url: "http://lt" }, m.fn).languages()).toEqual([{ code: "en", name: "English", targets: ["de"] }]);
    expect(m.calls[0]!.url).toBe("http://lt/languages");
  });
});

describe("azure adapter", () => {
  it("sends key/region headers, omits `from` for auto, and maps detection", async () => {
    const m = mockFetch(() => ({
      json: [{ detectedLanguage: { language: "en", score: 0.95 }, translations: [{ text: "hallo", to: "de" }] }],
    }));
    const p = azureProvider({ key: "K", region: "westeurope" }, m.fn);
    const out = await p.translate(["hello"], "auto", "de");
    const url = new URL(m.calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://api.cognitive.microsofttranslator.com/translate");
    expect(url.searchParams.get("api-version")).toBe("3.0");
    expect(url.searchParams.get("to")).toBe("de");
    expect(url.searchParams.has("from")).toBe(false);
    expect(headerOf(m.calls[0]!, "ocp-apim-subscription-key")).toBe("K");
    expect(headerOf(m.calls[0]!, "ocp-apim-subscription-region")).toBe("westeurope");
    expect(m.calls[0]!.body).toEqual([{ Text: "hello" }]);
    expect(out).toEqual({ texts: ["hallo"], detected: [{ language: "en", confidence: 0.95 }] });
  });

  it("passes `from` for an explicit source and honours a custom endpoint", async () => {
    const m = mockFetch(() => ({ json: [{ translations: [{ text: "hallo" }] }] }));
    await azureProvider({ key: "K", endpoint: "https://my.cognitiveservices.azure.com/translator/text/v3.0/" }, m.fn).translate(["hello"], "en", "de");
    expect(m.calls[0]!.url).toMatch(/^https:\/\/my\.cognitiveservices\.azure\.com\/translator\/text\/v3\.0\/translate\?/);
    expect(new URL(m.calls[0]!.url).searchParams.get("from")).toBe("en");
  });

  it("pre-detects via /detect (so same-language lines never hit the metered translate)", async () => {
    const m = mockFetch(() => ({ json: [{ language: "de", score: 1 }, { language: "en", score: 0.5 }] }));
    const p = azureProvider({ key: "K" }, m.fn);
    expect(await p.detect!(["hallo", "hi"])).toEqual([{ language: "de", confidence: 1 }, { language: "en", confidence: 0.5 }]);
    expect(m.calls[0]!.url).toContain("/detect?api-version=3.0");
  });

  it("lists languages from the translation scope and fails closed on bad shapes", async () => {
    const m = mockFetch(() => ({ json: { translation: { de: { name: "German" } } } }));
    expect(await azureProvider({ key: "K" }, m.fn).languages()).toEqual([{ code: "de", name: "German" }]);
    await expect(azureProvider({ key: "K" }, mockFetch(() => ({ json: [{}] })).fn).translate(["a", "b"], "auto", "de")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("deepl adapter", () => {
  it("routes :fx keys to the free API and maps target variants", () => {
    expect(deeplBaseUrl("abc:fx")).toBe("https://api-free.deepl.com");
    expect(deeplBaseUrl("abc")).toBe("https://api.deepl.com");
    expect(deeplTargetCode("en")).toBe("EN-GB");
    expect(deeplTargetCode("pt")).toBe("PT-PT");
    expect(deeplTargetCode("de")).toBe("DE");
  });

  it("posts text/target_lang with the auth header and reports the detected source", async () => {
    const m = mockFetch(() => ({ json: { translations: [{ detected_source_language: "EN", text: "hallo" }] } }));
    const out = await deeplProvider({ key: "secret:fx" }, m.fn).translate(["hello"], "auto", "de");
    expect(m.calls[0]!.url).toBe("https://api-free.deepl.com/v2/translate");
    expect(headerOf(m.calls[0]!, "authorization")).toBe("DeepL-Auth-Key secret:fx");
    expect(m.calls[0]!.body).toEqual({ text: ["hello"], target_lang: "DE" });
    expect(out).toEqual({ texts: ["hallo"], detected: [{ language: "en", confidence: 1 }] });
  });

  it("sends source_lang for an explicit source and lists target languages", async () => {
    const m = mockFetch((c) =>
      c.url.includes("/languages") ? { json: [{ language: "DE", name: "German" }] } : { json: { translations: [{ text: "hi" }] } },
    );
    const p = deeplProvider({ key: "paid" }, m.fn);
    await p.translate(["hallo"], "de", "en");
    expect(m.calls[0]!.url).toBe("https://api.deepl.com/v2/translate");
    expect(m.calls[0]!.body).toEqual({ text: ["hallo"], target_lang: "EN-GB", source_lang: "DE" });
    expect(await p.languages()).toEqual([{ code: "de", name: "German" }]);
    expect(m.calls[1]!.url).toBe("https://api.deepl.com/v2/languages?type=target");
  });

  it("throws ProviderError on quota/HTTP errors", async () => {
    await expect(deeplProvider({ key: "k" }, mockFetch(() => ({ status: 456, json: {} })).fn).translate(["a"], "auto", "de")).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("providerFromEnv", () => {
  it("defaults to LibreTranslate on 127.0.0.1:5000", async () => {
    const m = mockFetch(() => ({ json: { translatedText: ["x"] } }));
    const sel = providerFromEnv({}, m.fn);
    expect(sel.setting).toBe("libretranslate");
    await sel.provider!.translate(["a"], "auto", "de");
    expect(m.calls[0]!.url).toBe("http://127.0.0.1:5000/translate");
  });

  it("switches on TRANSLATE_PROVIDER and reports missing keys", () => {
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "off" })).toEqual({ setting: "off", provider: null });
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "azure" }).provider).toBeNull();
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "azure", AZURE_TRANSLATOR_KEY: "k" }).provider?.name).toBe("azure");
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "DeepL", DEEPL_API_KEY: "k:fx" }).provider?.name).toBe("deepl");
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "deepl" }).problem).toMatch(/DEEPL_API_KEY/);
    expect(providerFromEnv({ TRANSLATE_PROVIDER: "google" })).toMatchObject({ setting: "off", provider: null });
  });
});
