import { describe, expect, it } from "vitest";
import {
  cacheKey,
  charCount,
  LruCache,
  MAX_TOTAL_CHARS,
  RateLimiter,
  stripControlChars,
  validateTranslateRequest,
} from "../../src/translate/guards.js";

describe("validateTranslateRequest", () => {
  it("accepts a string q with defaults", () => {
    const r = validateTranslateRequest({ q: " gg wp ", target: "DE" });
    expect(r).toEqual({ ok: true, value: { items: ["gg wp"], isArray: false, source: "auto", target: "de", chars: 5 } });
  });

  it("accepts an array q and an explicit source", () => {
    const r = validateTranslateRequest({ q: ["hallo", "welt"], target: "en", source: "de", format: "text" });
    expect(r.ok && r.value).toMatchObject({ items: ["hallo", "welt"], isArray: true, source: "de", target: "en" });
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(stripControlChars("a\u0000b\u0007c\rd\te\nf\u007f\u0085")).toBe("abcd\te\nf");
    const r = validateTranslateRequest({ q: "\u0001hi\u001b", target: "de" });
    expect(r.ok && r.value.items).toEqual(["hi"]);
  });

  it.each([
    [{ q: "", target: "de" }, 400],
    [{ q: "\u0000\u0001  ", target: "de" }, 400],
    [{ q: [], target: "de" }, 400],
    [{ q: ["ok", ""], target: "de" }, 400],
    [{ q: 5, target: "de" }, 400],
    [{ q: ["ok", 5], target: "de" }, 400],
    [{ q: "hi" }, 400],
    [{ q: "hi", target: "german" }, 400],
    [{ q: "hi", target: "de", source: "xx-yyyyyy" }, 400],
    [{ q: "hi", target: "de", format: "html" }, 400],
    [null, 400],
    [["hi"], 400],
  ])("rejects %j with %i", (body, status) => {
    const r = validateTranslateRequest(body);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.status).toBe(status);
  });

  it("enforces the 2000-character and 20-string limits with 413", () => {
    expect(validateTranslateRequest({ q: "a".repeat(MAX_TOTAL_CHARS), target: "de" }).ok).toBe(true);
    const long = validateTranslateRequest({ q: "a".repeat(MAX_TOTAL_CHARS + 1), target: "de" });
    expect(!long.ok && long.status).toBe(413);
    const split = validateTranslateRequest({ q: ["a".repeat(1000), "b".repeat(1001)], target: "de" });
    expect(!split.ok && split.status).toBe(413);
    const many = validateTranslateRequest({ q: Array.from({ length: 21 }, () => "x"), target: "de" });
    expect(!many.ok && many.status).toBe(413);
    expect(validateTranslateRequest({ q: Array.from({ length: 20 }, () => "x"), target: "de" }).ok).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    expect(charCount("gg 👍")).toBe(4);
  });
});

describe("RateLimiter", () => {
  const opts = { maxRequests: 3, maxChars: 100, windowMs: 60_000, maxKeys: 5 };

  it("allows maxRequests per window then returns Retry-After seconds, and resets", () => {
    let t = 1_000;
    const rl = new RateLimiter(opts, () => t);
    expect(rl.take(["ip:a"], 1)).toBe(0);
    expect(rl.take(["ip:a"], 1)).toBe(0);
    expect(rl.take(["ip:a"], 1)).toBe(0);
    t += 15_000;
    expect(rl.take(["ip:a"], 1)).toBe(45);
    expect(rl.take(["ip:b"], 1)).toBe(0); // other callers unaffected
    t += 45_000;
    expect(rl.take(["ip:a"], 1)).toBe(0);
  });

  it("limits characters per window", () => {
    const rl = new RateLimiter(opts, () => 0);
    expect(rl.take(["ip:a"], 60)).toBe(0);
    expect(rl.take(["ip:a"], 41)).toBeGreaterThan(0);
    expect(rl.take(["ip:a"], 40)).toBe(0);
  });

  it("charges every key, and refuses when ANY key is exhausted without charging the others", () => {
    const rl = new RateLimiter(opts, () => 0);
    for (let i = 0; i < 3; i++) expect(rl.take([`ip:${i}`, "coach:bob"], 1)).toBe(0);
    expect(rl.take(["ip:new", "coach:bob"], 1)).toBeGreaterThan(0); // coach limit follows across IPs
    // ip:new was not charged by the refused request: it still has 3 requests.
    for (let i = 0; i < 3; i++) expect(rl.take(["ip:new"], 1)).toBe(0);
  });

  it("keeps the key map bounded", () => {
    const rl = new RateLimiter(opts, () => 0);
    for (let i = 0; i < 50; i++) rl.take([`ip:${i}`], 1);
    expect(rl.size).toBeLessThanOrEqual(opts.maxKeys);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry past maxEntries", () => {
    const c = new LruCache<number>(2, 1_000, () => 0);
    c.set("a", 1);
    c.set("b", 2);
    expect(c.get("a")).toBe(1); // a is now most recent
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    expect(c.size).toBe(2);
  });

  it("expires entries after the TTL", () => {
    let t = 0;
    const c = new LruCache<number>(10, 1_000, () => t);
    c.set("a", 1);
    t = 999;
    expect(c.get("a")).toBe(1);
    t = 2_000;
    expect(c.get("a")).toBeUndefined();
  });

  it("keys on provider, source, target and text", () => {
    expect(cacheKey("libretranslate", "auto", "de", "gg")).not.toBe(cacheKey("deepl", "auto", "de", "gg"));
    expect(cacheKey("libretranslate", "auto", "de", "gg")).not.toBe(cacheKey("libretranslate", "auto", "fr", "gg"));
  });
});
