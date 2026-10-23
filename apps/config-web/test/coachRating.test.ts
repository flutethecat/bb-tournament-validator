import { describe, expect, it } from "vitest";
import { CoachRatingCache, RatingLimitError, fumbblBaseUrlFromEnv, winsAboveReplacement, type RatingFetch } from "../src/coachRating";

const PAGE = `<html><div class="rankings">
  <div class="ranking"><div class="title">Overall</div><div class="level">Super Star</div>
    <div class="statrow CR"><div class="label">CR</div><div class="value">162.4</div></div>
    <div class="statrow record"><div class="label">Record</div><div class="value">20/12/16</div></div>
  </div>
  <div class="ranking"><div class="title">Ranked</div><div class="level">Rookie</div></div>
</div><div class="coachcontent">rest</div></html>`;

function fakeFetch(calls: string[], fail = false): RatingFetch {
  return async (url) => {
    calls.push(url);
    if (fail) throw new Error("offline");
    const body = url.includes("/api/coach/search/")
      ? JSON.stringify([{ id: 9, name: "KaliMar2" }, { id: 7, name: "Kalimar" }])
      : url.includes("/api/coach/get/7")
        ? JSON.stringify({ id: 7, name: "Kalimar", rating: "Star" })
        : PAGE;
    return { ok: true, status: 200, text: async () => body };
  };
}

describe("CoachRatingCache (the client's three fumbbl.com requests)", () => {
  it("search -> get -> coach page, page title wins, WAR computed from the record", async () => {
    const calls: string[] = [];
    const cache = new CoachRatingCache({ fetchFn: fakeFetch(calls) });
    const r = await cache.get("kalimar", "Alice");
    expect(r).toEqual({ name: "Kalimar", id: 7, title: "Super Star", cr: 162.4, record: { w: 20, d: 12, l: 16 }, winPct: 54, war: 2 });
    expect(calls.sort()).toEqual([
      "https://fumbbl.com/api/coach/get/7",
      "https://fumbbl.com/api/coach/search/kalimar",
      "https://fumbbl.com/~kalimar",
    ]);
  });

  it("uses the configured base URL", async () => {
    const calls: string[] = [];
    await new CoachRatingCache({ fetchFn: fakeFetch(calls), baseUrl: "https://fumbbl.example.test/" }).get("x", "a");
    expect(calls.every((u) => u.startsWith("https://fumbbl.example.test/"))).toBe(true);
    expect(fumbblBaseUrlFromEnv({})).toBe("https://fumbbl.com");
    expect(fumbblBaseUrlFromEnv({ FUMBBL_BASE_URL: "https://mirror.example.test/" })).toBe("https://mirror.example.test");
    expect(() => fumbblBaseUrlFromEnv({ FUMBBL_BASE_URL: "ftp://x" })).toThrow();
    expect(() => fumbblBaseUrlFromEnv({ FUMBBL_BASE_URL: "https://x.test/path" })).toThrow();
  });

  it("caches per name for 10 minutes, then refetches; cache hits are free", async () => {
    const calls: string[] = [];
    let t = 0;
    const cache = new CoachRatingCache({ fetchFn: fakeFetch(calls), now: () => t, perRequesterLimit: 2 });
    await cache.get("Kalimar", "a");
    for (let i = 0; i < 10; i++) await cache.get("KALIMAR", "a");
    expect(calls).toHaveLength(3);
    t += 10 * 60 * 1000;
    await cache.get("Kalimar", "a");
    expect(calls).toHaveLength(6);
  });

  it("per-requester and global limits on uncached lookups (no outbound request past a limit)", async () => {
    const calls: string[] = [];
    const cache = new CoachRatingCache({ fetchFn: fakeFetch(calls), perRequesterLimit: 3, globalLimit: 5 });
    for (let i = 0; i < 3; i++) await cache.get(`n${i}`, "alice");
    expect(() => cache.get("n3", "Alice")).toThrow(RatingLimitError);
    await cache.get("m0", "bob");
    await cache.get("m1", "bob");
    expect(() => cache.get("m2", "carol")).toThrow(/Too many/);
    expect(calls).toHaveLength(10); // 5 admitted lookups x (page + search; no exact hit, so no get)
  });

  it("bounded concurrency with a bounded queue", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const slow: RatingFetch = async () => {
      active++; peak = Math.max(peak, active);
      await new Promise<void>((r) => releases.push(r));
      active--;
      return { ok: false, status: 404, text: async () => "" };
    };
    const cache = new CoachRatingCache({ fetchFn: slow, maxConcurrent: 1, maxQueue: 1, perRequesterLimit: 99 });
    const a = cache.get("a", "x");
    const b = cache.get("b", "x");
    expect(() => cache.get("c", "x")).toThrow(RatingLimitError);
    while (releases.length) { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await a;
    while (releases.length) { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)); }
    await b;
    expect(peak).toBeLessThanOrEqual(2); // two parallel requests inside ONE lookup (page + search), never two lookups
  });

  it("fair queue: one coach cannot take every slot, and waiting coaches are served round-robin", async () => {
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const gated: RatingFetch = async (url) => {
      if (url.includes("/api/coach/search/")) order.push(decodeURIComponent(url.split("/").pop()!));
      await new Promise<void>((r) => releases.push(r));
      return { ok: false, status: 404, text: async () => "" };
    };
    const cache = new CoachRatingCache({ fetchFn: gated, maxConcurrent: 1, maxQueue: 16, maxQueuedPerRequester: 2, perRequesterLimit: 99 });
    const all = [cache.get("a0", "flood"), cache.get("a1", "flood"), cache.get("a2", "flood")]; // a0 runs, a1+a2 queue
    expect(() => cache.get("a3", "flood")).toThrow(RatingLimitError); // the flooder's queue share is full
    all.push(cache.get("b0", "bob")); // another coach still gets a slot
    all.push(cache.get("c0", "carol"));
    const drain = async () => { while (releases.length) { releases.shift()!(); await new Promise((r) => setTimeout(r, 0)); } };
    for (let i = 0; i < 12 && order.length < 5; i++) await drain();
    await drain();
    await Promise.all(all);
    expect(order).toEqual(["a0", "a1", "b0", "c0", "a2"]);
  });

  it("the deadline covers the body read", async () => {
    const hang: RatingFetch = async (_url, signal) => ({
      ok: true,
      status: 200,
      text: () => new Promise<string>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    const r = await new CoachRatingCache({ fetchFn: hang, deadlineMs: 30 }).get("slow", "x");
    expect(r).toEqual({ name: "slow" });
  });

  it("fail-soft: never throws on network errors, returns just the name", async () => {
    await expect(new CoachRatingCache({ fetchFn: fakeFetch([], true) }).get("Nobody", "x")).resolves.toEqual({ name: "Nobody" });
  });

  it("WAR = 0.5 (W - L)", () => {
    expect(winsAboveReplacement({ w: 20, d: 12, l: 16 })).toBe(2);
    expect(winsAboveReplacement({ w: 0, d: 0, l: 0 })).toBeUndefined();
  });
});
