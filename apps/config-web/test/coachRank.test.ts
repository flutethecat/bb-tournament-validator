import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CoachGlicko } from "../src/coachGlicko.js";
import { BANDS, COACH_TITLE_SLUGS, CoachTitleStore, HYSTERESIS, TITLE_PERCENT, coachRatingFor, coachTitleSlug, computeTitleBands, rankFor, ROOKIE, ROOKIE_GAMES, type Bounds } from "../src/coachRank.js";

const ASOF = new Date("2026-10-29T12:00:00Z");
const DAY = 86_400_000;
const g = (cr: number, games = 20, daysAgo = 1): CoachGlicko => ({ cr, r: cr, rd: 60, sigma: 0.06, games, lastPlayedMs: ASOF.getTime() - daysAgo * DAY });
/** 100 active coaches with CR 1000..1099 (coach c0 = 1099 ... c99 = 1000). */
const pool = (n = 100): Map<string, CoachGlicko> => new Map(Array.from({ length: n }, (_, i) => [`c${i}`, g(1000 + n - 1 - i)] as const));
const title = (cr: number, b: Bounds, previousTitle?: string, games = 20): string => rankFor("x", { cr, games }, { bounds: b, previousTitle }).name;

describe("percentile title bands", () => {
  const b = computeTitleBands(pool(), ASOF);
  it("100 coaches: Legend top 2, Mega-Star next 5%, Super Star 10%, Star 20%, Emerging Star 30%, Veteran 20%, Experienced 15% of the rest", () => {
    expect(TITLE_PERCENT.legend).toBe(0.02);
    const counts = new Map<string, number>();
    for (const c of pool().values()) counts.set(title(c.cr, b), (counts.get(title(c.cr, b)) ?? 0) + 1);
    expect(b.poolSize).toBe(100);
    expect(b.legendCount).toBe(2);
    expect(Object.fromEntries(counts)).toEqual({ "Legend": 2, "Mega-Star": 5, "Super Star": 10, "Star": 19, "Emerging Star": 30, "Veteran": 19, "Experienced": 15 });
    // lower CR bound of Veteran .. Legend (cumulative rounding over the 98 non-Legend coaches: 5, 15, 34, 64, 83)
    expect(b.lower.slice(1)).toEqual([1015, 1034, 1064, 1083, 1093, 1098]);
  });
  it("Legend is at least one coach even for a tiny pool", () => {
    expect(computeTitleBands(pool(10), ASOF).legendCount).toBe(1);
    expect(computeTitleBands(pool(1), ASOF).legendCount).toBe(1);
    expect(title(1000, computeTitleBands(pool(1), ASOF))).toBe("Legend");
  });
  it("forced: unrated = Emerging Star, 1-9 games = Rookie whatever the CR", () => {
    expect(title(1900, b, undefined, 0)).toBe("Emerging Star");
    expect(title(1900, b, undefined, ROOKIE_GAMES - 1)).toBe("Rookie");
    expect(rankFor("x", { cr: 1900, games: 3 }, { bounds: b, previousTitle: "Legend" })).toBe(ROOKIE);
    expect(title(1100, b, undefined, ROOKIE_GAMES)).toBe("Legend");
  });
  it("inactive coaches (no game in 365 days) and <10-game coaches are outside the pool but still titled", () => {
    const m = pool();
    m.set("idle", g(2000, 50, 400));
    m.set("newbie", g(2000, 5, 1));
    const b2 = computeTitleBands(m, ASOF);
    expect(b2.poolSize).toBe(100);
    expect(b2.crs[0]).toBe(1099);
    expect(title(2000, b2)).toBe("Legend");
    expect(coachRatingFor("idle", m.get("idle")!, { bounds: b2 }).rank).toBe("Legend");
  });
  it("hysteresis: crossing a bound by 9 keeps the title, by 10 moves (up and down)", () => {
    const veteranMin = b.lower[1]!, emergingMin = b.lower[2]!;
    expect(title(emergingMin + HYSTERESIS - 1, b, "Veteran")).toBe("Veteran");
    expect(title(emergingMin + HYSTERESIS, b, "Veteran")).toBe("Emerging Star");
    expect(title(emergingMin - HYSTERESIS, b, "Emerging Star")).toBe("Emerging Star");
    expect(title(emergingMin - HYSTERESIS - 1, b, "Emerging Star")).toBe("Veteran");
    expect(title(veteranMin + 5, b, "Veteran")).toBe("Veteran");
    // no previous title: the plain percentile title, no margin
    expect(title(emergingMin, b)).toBe("Emerging Star");
    expect(title(emergingMin - 1, b)).toBe("Veteran");
  });
  it("pct is the top-percent within the pool", () => {
    expect(coachRatingFor("a", g(1099), { bounds: b }).pct).toBe(1);
    expect(coachRatingFor("a", g(1050), { bounds: b }).pct).toBe(50);
    expect(coachRatingFor("a", g(1000), { bounds: b }).pct).toBe(100);
    expect(coachRatingFor("a", g(1050, 4), { bounds: b }).pct).toBeUndefined();
  });
});

describe("CoachTitleStore (persisted titles + per-period bounds)", () => {
  it("round-trips the file, reuses the bounds within a 7-day period and recomputes in the next", () => {
    const dir = mkdtempSync(join(tmpdir(), "titles-"));
    try {
      const file = join(dir, "coach-titles.json");
      const m = pool();
      m.set("flutethecat", g(1099));
      const s1 = new CoachTitleStore(file).session(m, ASOF);
      expect(s1.view("Flutethecat").rank).toBe("Legend");
      s1.flush();
      const saved = JSON.parse(readFileSync(file, "utf8"));
      expect(saved.titles.flutethecat.title).toBe("Legend");
      expect(saved.bounds.poolSize).toBe(101);
      // a fresh store reads the file; a changed pool inside the same period does NOT change the bounds
      const bigger = new Map(m); for (let i = 0; i < 50; i += 1) bigger.set(`n${i}`, g(1500 + i));
      const s2 = new CoachTitleStore(file).session(bigger, new Date(ASOF.getTime() + 2 * DAY));
      expect(s2.bounds.poolSize).toBe(101);
      expect(s2.view("flutethecat").rank).toBe("Legend");
      // the next rating period recomputes
      const s3 = new CoachTitleStore(file).session(bigger, new Date(ASOF.getTime() + 8 * DAY));
      expect(s3.bounds.poolSize).toBe(151);
      // 1099 is now 51st of 151: Legend -> a lower band only if 10 below the Legend bound; the hysteresis memory survived the file
      expect(s3.view("flutethecat").rank).not.toBe("Legend");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("coach rank (FUMBBL titles)", () => {
  const b = computeTitleBands(pool(), ASOF);
  it("the CR is shown as a whole number", () => {
    expect(coachRatingFor("a", g(1523.4), { bounds: b }).cr).toBe(1523);
    expect(coachRatingFor("a", g(1523.6), { bounds: b }).cr).toBe(1524);
  });
  it("eight titles in order, with one more pip per step", () => {
    expect([ROOKIE, ...BANDS].map((r) => r.name)).toEqual(["Rookie", "Experienced", "Veteran", "Emerging Star", "Star", "Super Star", "Mega-Star", "Legend"]);
    expect([ROOKIE, ...BANDS].map((r) => r.pips)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
  it("a rated coach carries cr, rank, key and games; an unrated one is an Emerging Star", () => {
    expect(coachRatingFor("a", { cr: 1500, games: 0 }, { bounds: b })).toEqual({ cr: 1500, rank: "Emerging Star", rankKey: "emerging", slug: "emerging-star", games: 0 });
    expect(coachRatingFor("a", { cr: 1250, games: 4 }, { bounds: b })).toEqual({ cr: 1250, rank: "Rookie", rankKey: "rookie", slug: "rookie", games: 4 });
  });
  it("the title list, order and normalisation are the client's", () => {
    expect(Object.keys(COACH_TITLE_SLUGS)).toEqual(["rookie", "experienced", "veteran", "emerging star", "star", "super star", "mega star", "legend"]);
    expect(coachTitleSlug(" super  STAR ")).toBe("super-star");
    expect(coachTitleSlug("Mega-Star")).toBe("mega-star");
    expect(coachTitleSlug("Hero")).toBeUndefined();
    for (const r of [ROOKIE, ...BANDS]) expect(coachTitleSlug(r.name), r.name).toBeDefined();
  });
});

describe("review fixes", () => {
  const same = (n: number, cr = 1300): Map<string, CoachGlicko> => new Map(Array.from({ length: n }, (_, i) => [`k${String(i).padStart(3, "0")}`, g(cr)] as const));
  const countBy = (m: Map<string, CoachGlicko>, b: Bounds): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of m) { const t = rankFor(k, v, { bounds: b }).name; out[t] = (out[t] ?? 0) + 1; }
    return out;
  };
  it("tied CRs keep the band counts (ties broken by coach key)", () => {
    const m = same(100);
    expect(countBy(m, computeTitleBands(m, ASOF))).toEqual({ "Legend": 2, "Mega-Star": 5, "Super Star": 10, "Star": 19, "Emerging Star": 30, "Veteran": 19, "Experienced": 15 });
    expect(rankFor("k000", g(1300), { bounds: computeTitleBands(m, ASOF) }).name).toBe("Legend");
  });
  it("2- and 3-coach pools", () => {
    const two = pool(2), three = pool(3);
    expect(countBy(two, computeTitleBands(two, ASOF))).toEqual({ "Legend": 1, "Emerging Star": 1 });
    expect(countBy(three, computeTitleBands(three, ASOF))).toEqual({ "Legend": 1, "Star": 1, "Veteran": 1 });
    expect(rankFor("c0", g(1002), { bounds: computeTitleBands(three, ASOF) }).name).toBe("Legend");
  });
  it("a multi-band jump needs 10 beyond the destination bound; future and stale activity stamps are not active", () => {
    const b = computeTitleBands(pool(), ASOF);
    expect(title(b.lower[5]! + HYSTERESIS, b, "Veteran")).toBe("Mega-Star");
    expect(title(b.lower[5]! + HYSTERESIS - 1, b, "Veteran")).toBe("Super Star");
    const m = pool(); m.set("future", { ...g(3000), lastPlayedMs: ASOF.getTime() + DAY }); m.set("old", g(3000, 20, 366));
    expect(computeTitleBands(m, ASOF).poolSize).toBe(100);
  });
  it("naf: keys count in the pool", () => {
    const m = pool(98); m.set("naf:someone", g(5000)); m.set("naf:other", g(1));
    const b = computeTitleBands(m, ASOF);
    expect(b.poolSize).toBe(100);
    expect(rankFor("naf:someone", g(5000), { bounds: b }).name).toBe("Legend");
  });
  const withDir = (fn: (dir: string, file: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), "titles-"));
    try { fn(dir, join(dir, "coach-titles.json")); } finally { try { chmodSync(dir, 0o755); } catch { /* */ } rmSync(dir, { recursive: true, force: true }); }
  };
  it("a malformed or wrong-shape file recovers", () => withDir((_d, file) => {
    writeFileSync(file, "{not json");
    expect(new CoachTitleStore(file).session(pool(), ASOF).bounds.poolSize).toBe(100);
    writeFileSync(file, JSON.stringify({ version: 1, boundsPeriod: 1, bounds: { poolSize: 5, lower: [1], crs: [] }, titles: { a: { title: 1 } } }));
    const s = new CoachTitleStore(file).session(pool(), ASOF);
    expect(s.bounds.poolSize).toBe(100);
    expect(s.view("c0").rank).toBe("Legend");
  }));
  it("a shrinking pool or a backwards period recomputes the bounds", () => withDir((_d, file) => {
    const old = (n: number): Map<string, CoachGlicko> => new Map(Array.from({ length: n }, (_, i) => [`c${i}`, g(1000 + i, 20, 30)] as const));
    new CoachTitleStore(file).session(old(100), ASOF).flush();
    expect(new CoachTitleStore(file).session(old(40), new Date(ASOF.getTime() + 8 * DAY)).bounds.poolSize).toBe(40);
    expect(new CoachTitleStore(file).session(old(60), new Date(ASOF.getTime() - 8 * DAY)).bounds.poolSize).toBe(60);
  }));
  it("a failed write stays pending and is retried on the next flush", () => withDir((dir) => {
    const file = join(dir, "coach-titles.json");
    mkdirSync(file); // a directory where the file belongs: the atomic write fails
    const store = new CoachTitleStore(file);
    const s1 = store.session(pool(), ASOF); s1.view("c0"); s1.flush();
    rmSync(file, { recursive: true });
    store.session(pool(), ASOF).flush(); // same period, nothing new, but the earlier write is still owed
    expect(JSON.parse(readFileSync(file, "utf8")).titles.c0.title).toBe("Legend");
  }));
  it("unviewed coaches advance with the viewed ones at a rollover (identical coaches stay identical)", () => withDir((_d, file) => {
    const m = pool(); m.set("twinA", g(1060)); m.set("twinB", g(1060));
    const s1 = new CoachTitleStore(file).session(m, ASOF);
    s1.view("twinA"); s1.flush();
    const saved = JSON.parse(readFileSync(file, "utf8")).titles;
    expect(saved.twinB.title).toBe(saved.twina?.title ?? saved.twinA?.title);
    expect(Object.keys(saved)).toContain("c0");
  }));
});
