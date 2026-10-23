import { describe, expect, it } from "vitest";
import { CoachRatingCache, winsAboveReplacement, type RatingFetch } from "../src/coachRating";

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
    const cache = new CoachRatingCache(fakeFetch(calls));
    const r = await cache.get("kalimar");
    expect(r).toEqual({ name: "Kalimar", id: 7, title: "Super Star", cr: 162.4, record: { w: 20, d: 12, l: 16 }, winPct: 54, war: 2 });
    expect(calls.sort()).toEqual([
      "https://fumbbl.com/api/coach/get/7",
      "https://fumbbl.com/api/coach/search/kalimar",
      "https://fumbbl.com/~kalimar",
    ]);
  });

  it("caches per name for 10 minutes, then refetches", async () => {
    const calls: string[] = [];
    let t = 0;
    const cache = new CoachRatingCache(fakeFetch(calls), () => t);
    await cache.get("Kalimar");
    await cache.get("KALIMAR");
    expect(calls).toHaveLength(3);
    t += 10 * 60 * 1000;
    await cache.get("Kalimar");
    expect(calls).toHaveLength(6);
  });

  it("fail-soft: never throws, returns just the name", async () => {
    const cache = new CoachRatingCache(fakeFetch([], true));
    await expect(cache.get("Nobody")).resolves.toEqual({ name: "Nobody" });
  });

  it("WAR = 0.5 (W - L)", () => {
    expect(winsAboveReplacement({ w: 20, d: 12, l: 16 })).toBe(2);
    expect(winsAboveReplacement({ w: 0, d: 0, l: 0 })).toBeUndefined();
  });
});
