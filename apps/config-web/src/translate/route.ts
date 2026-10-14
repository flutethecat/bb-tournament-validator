/**
 * POST /api/translate + GET /api/translate/languages — the chat auto-translate relay (owner 10-12).
 *
 * Contract (mirrors LibreTranslate's /translate so a direct LibreTranslate URL could stand in):
 *   request  { q: string | string[], target, source = "auto", format = "text" }
 *   response { translatedText: string | string[], detectedLanguage, provider }
 *     detectedLanguage: { language, confidence 0..1 } | null for a string q; an array of those for an array q.
 *     provider: "none" when nothing was translated (every line detected as the target language with
 *     confidence >= 0.8, handed back unchanged by the provider, or source === target) — the client
 *     then shows NO parenthesised copy.
 *   errors   400 bad input · 413 too long · 429 rate limited (Retry-After) · 502 provider failure ·
 *            503 translation disabled. Bodies are { error } and never carry provider details.
 * Public (PUBLIC_PATHS): the desktop client has no admin credentials; the limits below are the guard.
 * Logs one line per request with counts + provider latency — NEVER the text.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  cacheKey,
  DEFAULT_RATE_LIMIT,
  LruCache,
  RateLimiter,
  validateTranslateRequest,
  type RateLimitOptions,
} from "./guards.js";
import {
  providerFromEnv,
  STATIC_LANGUAGES,
  type Detected,
  type FetchLike,
  type LanguageInfo,
  type ProviderSelection,
} from "./providers.js";

export const TRANSLATE_PATH = "/api/translate";
export const LANGUAGES_PATH = "/api/translate/languages";
export const COACH_HEADER = "x-super-fumbbl-coach";
/** Detection must be at least this sure before a line is treated as already in the target language. */
export const SAME_LANGUAGE_CONFIDENCE = 0.8;
const BODY_CAP_BYTES = 32 * 1024;
const LANGUAGES_TTL_MS = 60 * 60 * 1000;
const LANGUAGES_FAILURE_TTL_MS = 60 * 1000;

interface CachedItem {
  text: string;
  detected: Detected | null;
  passthrough: boolean;
}

export interface TranslateServiceOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /** Inject a ready selection instead of reading env (tests). */
  selection?: ProviderSelection;
  now?: () => number;
  rateLimit?: RateLimitOptions;
  cacheEntries?: number;
  log?: (line: string) => void;
}

export type TranslateHandler = ((req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<boolean>) & {
  readonly providerSetting: string;
};

/** Caller IP. Behind the local Caddy proxy every socket is loopback, so then (and only then) the
 *  last X-Forwarded-For hop — the one Caddy appended — is the real client. */
export function clientIp(req: IncomingMessage): string {
  const raw = (req.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  if (raw === "127.0.0.1" || raw === "::1") {
    const xff = req.headers["x-forwarded-for"];
    const value = Array.isArray(xff) ? xff[xff.length - 1] : xff;
    const last = value?.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last.replace(/^::ffff:/, "").slice(0, 64);
  }
  return raw;
}

class BodyTooLarge extends Error {}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > BODY_CAP_BYTES) throw new BodyTooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > BODY_CAP_BYTES) throw new BodyTooLarge();
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

const sameLanguage = (d: Detected | null, target: string) =>
  !!d && d.confidence >= SAME_LANGUAGE_CONFIDENCE && d.language.split("-")[0] === target.split("-")[0];

export function createTranslateHandler(opts: TranslateServiceOptions = {}): TranslateHandler {
  const selection = opts.selection ?? providerFromEnv(opts.env ?? process.env, opts.fetch ?? fetch);
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  const limiter = new RateLimiter(opts.rateLimit ?? DEFAULT_RATE_LIMIT, now);
  const cache = new LruCache<CachedItem>(opts.cacheEntries ?? 10_000, 24 * 60 * 60 * 1000, now);
  let languagesCache: { at: number; ttl: number; body: LanguageInfo[] } | undefined;
  if (selection.problem) log(`[translate] provider unavailable: ${selection.problem}`);

  const disabled = (res: ServerResponse) =>
    send(res, 503, { error: selection.setting === "off" ? "translation disabled" : "translation unavailable" });

  async function handleTranslate(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = now();
    const provider = selection.provider;
    if (!provider) return disabled(res);
    let body: unknown;
    try {
      body = await readJson(req);
    } catch (e) {
      if (e instanceof BodyTooLarge) return send(res, 413, { error: "Request body too large." });
      return send(res, 400, { error: "Invalid JSON request body." });
    }
    const v = validateTranslateRequest(body);
    if (!v.ok) return send(res, v.status, { error: v.error });
    const { items, isArray, source, target, chars } = v.value;

    const keys = [`ip:${clientIp(req)}`];
    const coachRaw = req.headers[COACH_HEADER];
    const coach = (Array.isArray(coachRaw) ? coachRaw[0] : coachRaw)?.trim().toLowerCase().slice(0, 64);
    if (coach) keys.push(`coach:${coach}`);
    const retryAfter = limiter.take(keys, chars);
    if (retryAfter > 0) {
      log(`[translate] 429 items=${items.length} chars=${chars} retryAfter=${retryAfter}s`);
      return send(res, 429, { error: "Too many translation requests; slow down." }, { "retry-after": String(retryAfter) });
    }

    const results: (CachedItem | undefined)[] = items.map((text) =>
      source === target ? { text, detected: null, passthrough: true } : cache.get(cacheKey(provider.name, source, target, text)),
    );
    const cachedCount = results.filter(Boolean).length - (source === target ? items.length : 0);
    let missing = results.flatMap((r, i) => (r ? [] : [i]));
    let providerMs = 0;
    try {
      if (missing.length && source === "auto" && provider.detect) {
        const t0 = now();
        const found = await provider.detect(missing.map((i) => items[i]!));
        providerMs += now() - t0;
        missing = missing.filter((i, k) => {
          const d = found[k] ?? null;
          if (!sameLanguage(d, target)) return true;
          results[i] = { text: items[i]!, detected: d, passthrough: true };
          return false;
        });
      }
      if (missing.length) {
        const t0 = now();
        const out = await provider.translate(missing.map((i) => items[i]!), source, target);
        providerMs += now() - t0;
        missing.forEach((i, k) => {
          const d = out.detected[k] ?? null;
          const text = out.texts[k]!;
          // Already in the target language (confident detection), or the provider handed the line
          // back unchanged ("gg", names, weak detection): nothing to show in parentheses.
          const unchanged = text.trim() === items[i]!.trim();
          results[i] =
            unchanged || (source === "auto" && sameLanguage(d, target))
              ? { text: items[i]!, detected: d, passthrough: true }
              : { text, detected: d, passthrough: false };
        });
      }
    } catch (e) {
      log(`[translate] 502 provider=${provider.name} items=${items.length} chars=${chars} providerMs=${now() - started} (${(e as Error).message})`);
      return send(res, 502, { error: "translation provider failed" });
    }
    results.forEach((r, i) => {
      if (r && source !== target) cache.set(cacheKey(provider.name, source, target, items[i]!), r);
    });

    const done = results as CachedItem[];
    const providerOut = done.every((r) => r.passthrough) ? "none" : provider.name;
    log(
      `[translate] 200 provider=${providerOut} items=${items.length} chars=${chars} cached=${cachedCount} ` +
        `sent=${missing.length} providerMs=${providerMs} totalMs=${now() - started}`,
    );
    send(res, 200, {
      translatedText: isArray ? done.map((r) => r.text) : done[0]!.text,
      detectedLanguage: isArray ? done.map((r) => r.detected) : done[0]!.detected,
      provider: providerOut,
    });
  }

  async function handleLanguages(res: ServerResponse): Promise<void> {
    const provider = selection.provider;
    if (!provider) return disabled(res);
    const t = now();
    if (!languagesCache || t - languagesCache.at >= languagesCache.ttl) {
      try {
        languagesCache = { at: t, ttl: LANGUAGES_TTL_MS, body: await provider.languages() };
        log(`[translate] languages provider=${provider.name} count=${languagesCache.body.length} providerMs=${now() - t}`);
      } catch (e) {
        log(`[translate] languages provider=${provider.name} failed, static list (${(e as Error).message})`);
        languagesCache = { at: t, ttl: LANGUAGES_FAILURE_TTL_MS, body: STATIC_LANGUAGES };
      }
    }
    send(res, 200, languagesCache.body, { "cache-control": "public, max-age=3600" });
  }

  const handler = async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    const method = req.method ?? "GET";
    if (pathname === TRANSLATE_PATH) {
      if (method !== "POST") send(res, 405, { error: "Method not allowed." }, { allow: "POST, OPTIONS" });
      else await handleTranslate(req, res);
      return true;
    }
    if (pathname === LANGUAGES_PATH) {
      if (method !== "GET" && method !== "HEAD") send(res, 405, { error: "Method not allowed." }, { allow: "GET, OPTIONS" });
      else await handleLanguages(res);
      return true;
    }
    return false;
  };
  return Object.assign(handler, { providerSetting: selection.setting });
}
