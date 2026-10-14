/** Input validation, per-caller rate limiting and the result cache for POST /api/translate. */

export const MAX_ITEMS = 20;
export const MAX_TOTAL_CHARS = 2000;
export const LANG_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,4})?$/i;

export interface TranslateRequest {
  items: string[];
  /** true when `q` was an array — the response mirrors the shape. */
  isArray: boolean;
  source: string; // "auto" or a lowercased code
  target: string; // lowercased code
  chars: number;
}

export type ValidationResult = { ok: true; value: TranslateRequest } | { ok: false; status: 400 | 413; error: string };

// C0 + DEL + C1 controls, except TAB and LF (multi-line chat survives; CR is dropped).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

export function stripControlChars(s: string): string {
  return s.replace(CONTROL_CHARS, "");
}

/** Code-point length, so an emoji counts once. */
export function charCount(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function validateTranslateRequest(body: unknown): ValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Expected a JSON object." };
  const b = body as Record<string, unknown>;
  const rawQ = b.q;
  const isArray = Array.isArray(rawQ);
  const list: unknown[] = isArray ? (rawQ as unknown[]) : [rawQ];
  if (list.length === 0) return { ok: false, status: 400, error: "q must not be empty." };
  if (list.length > MAX_ITEMS) return { ok: false, status: 413, error: `At most ${MAX_ITEMS} strings per request.` };
  if (list.some((v) => typeof v !== "string")) return { ok: false, status: 400, error: "q must be a string or an array of strings." };
  const items = (list as string[]).map((s) => stripControlChars(s).trim());
  if (items.some((s) => s.length === 0)) return { ok: false, status: 400, error: "q must not contain empty text." };
  const chars = items.reduce((n, s) => n + charCount(s), 0);
  if (chars > MAX_TOTAL_CHARS) return { ok: false, status: 413, error: `At most ${MAX_TOTAL_CHARS} characters per request.` };

  if (typeof b.target !== "string" || !LANG_CODE.test(b.target.trim()))
    return { ok: false, status: 400, error: "target must be a language code (ISO 639-1)." };
  const target = b.target.trim().toLowerCase();
  let source = "auto";
  if (b.source !== undefined && b.source !== null) {
    if (typeof b.source !== "string") return { ok: false, status: 400, error: "source must be \"auto\" or a language code." };
    const s = b.source.trim().toLowerCase();
    if (s !== "auto" && !LANG_CODE.test(s)) return { ok: false, status: 400, error: "source must be \"auto\" or a language code." };
    source = s || "auto";
  }
  if (b.format !== undefined && b.format !== "text") return { ok: false, status: 400, error: "Only format \"text\" is supported." };
  return { ok: true, value: { items, isArray, source, target, chars } };
}

// ---------------------------------------------------------------- rate limit

export interface RateLimitOptions {
  maxRequests: number;
  maxChars: number;
  windowMs: number;
  maxKeys: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitOptions = { maxRequests: 60, maxChars: 20_000, windowMs: 60_000, maxKeys: 10_000 };

interface Bucket {
  start: number;
  requests: number;
  chars: number;
}

/**
 * Fixed one-minute window per key, in memory. Every key in `keys` must have room for the request
 * before ANY of them is charged, so a refused request costs nothing. The map is bounded: expired
 * windows are swept when it fills, then the oldest-inserted keys are evicted.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly opts: RateLimitOptions = DEFAULT_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  /** Returns 0 when allowed (and charged), else the seconds until the blocking window resets. */
  take(keys: string[], chars: number): number {
    const t = this.now();
    let retryMs = 0;
    const live: Bucket[] = [];
    for (const key of keys) {
      let b = this.buckets.get(key);
      if (!b || t - b.start >= this.opts.windowMs) b = { start: t, requests: 0, chars: 0 };
      if (b.requests + 1 > this.opts.maxRequests || b.chars + chars > this.opts.maxChars)
        retryMs = Math.max(retryMs, b.start + this.opts.windowMs - t);
      live.push(b);
    }
    if (retryMs > 0) return Math.max(1, Math.ceil(retryMs / 1000));
    keys.forEach((key, i) => {
      const b = live[i]!;
      b.requests += 1;
      b.chars += chars;
      this.buckets.delete(key); // re-insert = most recently used at the end
      this.buckets.set(key, b);
    });
    this.evict(t);
    return 0;
  }

  private evict(t: number): void {
    if (this.buckets.size <= this.opts.maxKeys) return;
    for (const [key, b] of this.buckets) if (t - b.start >= this.opts.windowMs) this.buckets.delete(key);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.opts.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------- cache

/** Size- and age-bounded LRU (Map insertion order = recency). */
export class LruCache<V> {
  private readonly map = new Map<string, { value: V; at: number }>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (this.now() - hit.at >= this.ttlMs) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { value, at: this.now() });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

export function cacheKey(provider: string, source: string, target: string, text: string): string {
  return JSON.stringify([provider, source, target, text]);
}
