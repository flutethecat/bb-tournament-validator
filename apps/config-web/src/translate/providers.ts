/**
 * Chat auto-translate relay (owner 10-12): "LibreTranslate first with a provider switch behind it."
 * The Super FUMBBL client is a public desktop app, so no provider key can live in it; it calls
 * config-web's POST /api/translate and this module talks to the real provider.
 *
 * One interface, three adapters. Every adapter normalises detection confidence to 0..1
 * (LibreTranslate reports 0..100, Azure 0..1, DeepL reports none → 1 when it names a language).
 */

export type ProviderName = "libretranslate" | "azure" | "deepl";

export interface Detected {
  language: string;
  confidence: number;
}

export interface TranslateOutput {
  texts: string[];
  /** One entry per input item (null when the provider did not detect / source was explicit). */
  detected: (Detected | null)[];
}

export interface LanguageInfo {
  code: string;
  name: string;
  targets?: string[];
}

export interface TranslateProvider {
  readonly name: ProviderName;
  translate(items: string[], source: string, target: string): Promise<TranslateOutput>;
  /** Optional pre-detection for METERED providers: lines already in the target language are
   *  never sent to translate (saves quota). Providers without it rely on the post-check. */
  detect?(items: string[]): Promise<(Detected | null)[]>;
  languages(): Promise<LanguageInfo[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Provider failure. The message is for the server log only; the route answers a generic 502. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

const TIMEOUT_MS = 10_000;

async function call(fetchImpl: FetchLike, provider: string, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(`${provider}: request failed (${(e as Error).name})`);
  }
  if (!res.ok) throw new ProviderError(`${provider}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${provider}: invalid JSON response`);
  }
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function asDetected(raw: unknown, scale: number): Detected | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as { language?: unknown; confidence?: unknown; score?: unknown };
  if (typeof r.language !== "string" || !r.language) return null;
  const c = typeof r.confidence === "number" ? r.confidence : typeof r.score === "number" ? r.score : 0;
  return { language: r.language.toLowerCase(), confidence: clamp01(c / scale) };
}

function expectStrings(provider: string, value: unknown, n: number): string[] {
  if (!Array.isArray(value) || value.length !== n || value.some((v) => typeof v !== "string"))
    throw new ProviderError(`${provider}: unexpected response shape`);
  return value as string[];
}

// ---------------------------------------------------------------- LibreTranslate

export interface LibreTranslateConfig {
  url: string;
  apiKey?: string;
}

/** Argos/LibreTranslate names Norwegian "nb" and Chinese "zh-Hans"; the client speaks ISO 639-1
 *  "no" / "zh" (LibreTranslate accepts "zh" as input, so only "no" needs mapping on the way in). */
const toLibre = (code: string) => (code === "no" ? "nb" : code);
const fromLibre = (code: string) => {
  const c = code.toLowerCase();
  return c === "nb" ? "no" : c === "zh-hans" ? "zh" : code;
};

export function libreTranslateProvider(cfg: LibreTranslateConfig, fetchImpl: FetchLike = fetch): TranslateProvider {
  const base = cfg.url.replace(/\/+$/, "");
  const withKey = (body: Record<string, unknown>) => (cfg.apiKey ? { ...body, api_key: cfg.apiKey } : body);
  const post = (path: string, body: Record<string, unknown>) =>
    call(fetchImpl, "libretranslate", `${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(withKey(body)),
    });
  return {
    name: "libretranslate",
    async translate(items, source, target) {
      const json = (await post("/translate", { q: items, source: toLibre(source), target: toLibre(target), format: "text" })) as {
        translatedText?: unknown;
        detectedLanguage?: unknown;
      };
      const texts = expectStrings("libretranslate", json?.translatedText, items.length);
      const rawDetected = json.detectedLanguage;
      const detected = items.map((_, i) => {
        const d = asDetected(Array.isArray(rawDetected) ? rawDetected[i] : items.length === 1 ? rawDetected : undefined, 100);
        return d && { ...d, language: fromLibre(d.language) };
      });
      return { texts, detected };
    },
    // No detect(): LibreTranslate is local and free, and /translate with source=auto already
    // returns the detection, so the route's post-check costs nothing extra.
    async languages() {
      const json = await call(fetchImpl, "libretranslate", `${base}/languages`, { headers: { accept: "application/json" } });
      if (!Array.isArray(json)) throw new ProviderError("libretranslate: unexpected languages shape");
      return json
        .filter((l): l is { code: string; name: string; targets?: unknown } => typeof l?.code === "string" && typeof l?.name === "string")
        .map((l) => ({
          code: fromLibre(l.code),
          name: l.name,
          ...(Array.isArray(l.targets)
            ? { targets: l.targets.filter((t): t is string => typeof t === "string").map(fromLibre) }
            : {}),
        }));
    },
  };
}

// ---------------------------------------------------------------- Azure AI Translator

export interface AzureConfig {
  key: string;
  region?: string;
  /** Base URL; `/translate?api-version=3.0` etc. are appended. */
  endpoint?: string;
}

export function azureProvider(cfg: AzureConfig, fetchImpl: FetchLike = fetch): TranslateProvider {
  const base = (cfg.endpoint || "https://api.cognitive.microsofttranslator.com").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "ocp-apim-subscription-key": cfg.key,
    ...(cfg.region ? { "ocp-apim-subscription-region": cfg.region } : {}),
  };
  return {
    name: "azure",
    async translate(items, source, target) {
      const qs = new URLSearchParams({ "api-version": "3.0", to: target });
      if (source !== "auto") qs.set("from", source);
      const json = await call(fetchImpl, "azure", `${base}/translate?${qs}`, {
        method: "POST",
        headers,
        body: JSON.stringify(items.map((Text) => ({ Text }))),
      });
      if (!Array.isArray(json) || json.length !== items.length) throw new ProviderError("azure: unexpected response shape");
      const texts = json.map((row: { translations?: { text?: unknown }[] }) => row?.translations?.[0]?.text);
      return {
        texts: expectStrings("azure", texts, items.length),
        detected: json.map((row: { detectedLanguage?: unknown }) => asDetected(row?.detectedLanguage, 1)),
      };
    },
    async detect(items) {
      const json = await call(fetchImpl, "azure", `${base}/detect?api-version=3.0`, {
        method: "POST",
        headers,
        body: JSON.stringify(items.map((Text) => ({ Text }))),
      });
      if (!Array.isArray(json) || json.length !== items.length) throw new ProviderError("azure: unexpected detect shape");
      return json.map((row) => asDetected(row, 1));
    },
    async languages() {
      const json = (await call(fetchImpl, "azure", `${base}/languages?api-version=3.0&scope=translation`, {
        headers: { accept: "application/json" },
      })) as { translation?: Record<string, { name?: unknown }> };
      const table = json?.translation;
      if (!table || typeof table !== "object") throw new ProviderError("azure: unexpected languages shape");
      return Object.entries(table).map(([code, v]) => ({ code, name: typeof v?.name === "string" ? v.name : code }));
    },
  };
}

// ---------------------------------------------------------------- DeepL

export interface DeepLConfig {
  key: string;
  /** Override for tests / proxies. Defaults by key type: `:fx` → api-free.deepl.com. */
  baseUrl?: string;
}

export function deeplBaseUrl(key: string): string {
  return key.trim().endsWith(":fx") ? "https://api-free.deepl.com" : "https://api.deepl.com";
}

/** ISO 639-1 → DeepL target code (DeepL wants a variant for EN and PT targets). */
export function deeplTargetCode(target: string): string {
  const t = target.toLowerCase();
  if (t === "en") return "EN-GB";
  if (t === "pt") return "PT-PT";
  return t.toUpperCase();
}

export function deeplProvider(cfg: DeepLConfig, fetchImpl: FetchLike = fetch): TranslateProvider {
  const base = (cfg.baseUrl || deeplBaseUrl(cfg.key)).replace(/\/+$/, "");
  const auth = { authorization: `DeepL-Auth-Key ${cfg.key}` };
  return {
    name: "deepl",
    async translate(items, source, target) {
      const body: Record<string, unknown> = { text: items, target_lang: deeplTargetCode(target) };
      if (source !== "auto") body.source_lang = source.split("-")[0]!.toUpperCase();
      const json = (await call(fetchImpl, "deepl", `${base}/v2/translate`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      })) as { translations?: { text?: unknown; detected_source_language?: unknown }[] };
      const rows = json?.translations;
      if (!Array.isArray(rows) || rows.length !== items.length) throw new ProviderError("deepl: unexpected response shape");
      return {
        texts: expectStrings("deepl", rows.map((r) => r?.text), items.length),
        detected: rows.map((r) =>
          typeof r?.detected_source_language === "string" && r.detected_source_language
            ? { language: r.detected_source_language.toLowerCase(), confidence: 1 }
            : null,
        ),
      };
    },
    async languages() {
      const json = await call(fetchImpl, "deepl", `${base}/v2/languages?type=target`, { headers: auth });
      if (!Array.isArray(json)) throw new ProviderError("deepl: unexpected languages shape");
      return json
        .filter((l): l is { language: string; name: string } => typeof l?.language === "string" && typeof l?.name === "string")
        .map((l) => ({ code: l.language.toLowerCase(), name: l.name }));
    },
  };
}

// ---------------------------------------------------------------- switch

export type ProviderSetting = ProviderName | "off";

export interface ProviderSelection {
  setting: ProviderSetting;
  provider: TranslateProvider | null;
  /** Why the provider is null although the setting is not "off" (missing key) — log only. */
  problem?: string;
}

export function providerFromEnv(env: NodeJS.ProcessEnv, fetchImpl: FetchLike = fetch): ProviderSelection {
  const raw = (env.TRANSLATE_PROVIDER ?? "libretranslate").trim().toLowerCase() || "libretranslate";
  switch (raw) {
    case "off":
      return { setting: "off", provider: null };
    case "libretranslate":
      return {
        setting: raw,
        provider: libreTranslateProvider(
          { url: env.LIBRETRANSLATE_URL?.trim() || "http://127.0.0.1:5000", apiKey: env.LIBRETRANSLATE_API_KEY?.trim() || undefined },
          fetchImpl,
        ),
      };
    case "azure": {
      const key = env.AZURE_TRANSLATOR_KEY?.trim();
      if (!key) return { setting: raw, provider: null, problem: "AZURE_TRANSLATOR_KEY is not set" };
      return {
        setting: raw,
        provider: azureProvider(
          { key, region: env.AZURE_TRANSLATOR_REGION?.trim() || undefined, endpoint: env.AZURE_TRANSLATOR_ENDPOINT?.trim() || undefined },
          fetchImpl,
        ),
      };
    }
    case "deepl": {
      const key = env.DEEPL_API_KEY?.trim();
      if (!key) return { setting: raw, provider: null, problem: "DEEPL_API_KEY is not set" };
      return { setting: raw, provider: deeplProvider({ key }, fetchImpl) };
    }
    default:
      return { setting: "off", provider: null, problem: `unknown TRANSLATE_PROVIDER "${raw}"` };
  }
}

/** Fallback picker list for providers that cannot list (or whose list call fails). */
export const STATIC_LANGUAGES: LanguageInfo[] = [
  ["en", "English"], ["de", "German"], ["fr", "French"], ["es", "Spanish"], ["it", "Italian"],
  ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["sv", "Swedish"],
  ["da", "Danish"], ["fi", "Finnish"], ["no", "Norwegian"], ["cs", "Czech"], ["hu", "Hungarian"],
  ["el", "Greek"], ["tr", "Turkish"], ["uk", "Ukrainian"], ["ja", "Japanese"], ["zh", "Chinese"],
].map(([code, name]) => ({ code: code!, name: name! }));
