import { describe, expect, it } from "vitest";
import { parseChannelDate, resolveChannelPackage, tournamentDateStatus } from "../src/channelTournament";
import { PendingChannelResolutionStore } from "../src/store/pendingChannelResolutions";

const PKGS = ["Spike! 2026", "Lustrian Superleague", "Spike! 2025"];

describe("resolveChannelPackage", () => {
  it("derives the tournament from a dated channel name (#09-12-spike)", () => {
    const r = resolveChannelPackage("09-12-spike", ["Spike! 2026", "Lustrian Superleague"]);
    expect(r.looksLikeTournamentChannel).toBe(true);
    expect(r.slug).toBe("spike");
    expect(r.match).toBe("Spike! 2026");
  });

  it("matches a multi-token slug requiring every token present", () => {
    const r = resolveChannelPackage("11-30-lustrian-superleague", PKGS);
    expect(r.match).toBe("Lustrian Superleague");
  });

  it("reports ambiguity when the slug matches more than one package", () => {
    const r = resolveChannelPackage("09-12-spike", PKGS); // matches both Spike! years
    expect(r.match).toBeUndefined();
    expect(r.candidates.sort()).toEqual(["Spike! 2025", "Spike! 2026"]);
  });

  it("disambiguates when the year is in the slug", () => {
    const r = resolveChannelPackage("09-12-spike-2026", PKGS);
    expect(r.match).toBe("Spike! 2026");
  });

  it("looks like a tournament channel but has no match → candidates empty", () => {
    const r = resolveChannelPackage("01-02-planning", PKGS);
    expect(r.looksLikeTournamentChannel).toBe(true);
    expect(r.candidates).toEqual([]);
    expect(r.match).toBeUndefined();
  });

  it("a plain channel name is not treated as a tournament channel", () => {
    const r = resolveChannelPackage("general", PKGS);
    expect(r.looksLikeTournamentChannel).toBe(false);
    expect(r.match).toBeUndefined();
  });

  it("still matches a non-dated channel whose whole name is the slug", () => {
    // Not auto-triggered (looksLike=false), but the resolver still finds the package
    // if the wiring ever wants it (e.g. an explicit lookup).
    const r = resolveChannelPackage("spike-2025", PKGS);
    expect(r.looksLikeTournamentChannel).toBe(false);
    expect(r.match).toBe("Spike! 2025");
  });

  it("tolerates underscores and dots as separators", () => {
    expect(resolveChannelPackage("09_12_spike-2026", PKGS).match).toBe("Spike! 2026");
    expect(resolveChannelPackage("09.12.lustrian-superleague", PKGS).match).toBe("Lustrian Superleague");
  });
});

describe("parseChannelDate", () => {
  it("reads MM-DD by default", () => {
    expect(parseChannelDate("09-12-spike")).toEqual({ month: 9, day: 12 });
  });
  it("falls back to DD-MM when the first number can't be a month", () => {
    expect(parseChannelDate("30-11-lustrian")).toEqual({ month: 11, day: 30 });
  });
  it("returns null for undated names or impossible dates", () => {
    expect(parseChannelDate("general")).toBeNull();
    expect(parseChannelDate("13-40-spike")).toBeNull();
  });
});

describe("tournamentDateStatus", () => {
  it("a date earlier this year (nearest occurrence) reads as passed", () => {
    const now = new Date(2026, 6, 11); // Jul 11 2026
    const s = tournamentDateStatus("05-01-spike", now)!;
    expect(s.passed).toBe(true);
    expect(s.date.getFullYear()).toBe(2026);
  });

  it("a later-this-year date reads as upcoming, not expired", () => {
    const now = new Date(2026, 6, 11); // Jul 11
    expect(tournamentDateStatus("09-12-spike", now)!.passed).toBe(false);
  });

  it("anchors an early-year date to NEXT year when that's the nearest occurrence", () => {
    const now = new Date(2026, 10, 1); // Nov 1 2026 — Jan 15 2027 is nearer than Jan 15 2026
    const s = tournamentDateStatus("01-15-spike", now)!;
    expect(s.date.getFullYear()).toBe(2027);
    expect(s.passed).toBe(false);
  });

  it("a just-past date late in the year reads as passed", () => {
    const now = new Date(2026, 10, 1); // Nov 1 — Sep 12 2026 is ~50 days ago, nearest
    const s = tournamentDateStatus("09-12-spike", now)!;
    expect(s.date.getFullYear()).toBe(2026);
    expect(s.passed).toBe(true);
  });

  it("same-day is not yet passed", () => {
    const now = new Date(2026, 8, 12); // Sep 12
    expect(tournamentDateStatus("09-12-spike", now)!.passed).toBe(false);
  });

  it("returns null when the channel has no date", () => {
    expect(tournamentDateStatus("spike", new Date())).toBeNull();
  });
});

describe("PendingChannelResolutionStore", () => {
  const make = (over: Partial<{ channelId: string; messageId: string; userId: string }> = {}) => ({
    channelId: "c1",
    messageId: "m1",
    userId: "u1",
    ...over,
  });

  it("create/take is single-use", () => {
    const s = new PendingChannelResolutionStore();
    const p = s.create(make());
    expect(p.token).toMatch(/^[0-9a-f]{12}$/);
    expect(s.take(p.token)?.userId).toBe("u1");
    expect(s.take(p.token)).toBeUndefined();
  });

  it("a new prompt for the same message supersedes the old one", () => {
    const s = new PendingChannelResolutionStore();
    const first = s.create(make());
    const second = s.create(make());
    expect(s.take(first.token)).toBeUndefined();
    expect(s.take(second.token)).toBeDefined();
  });

  it("expires past its TTL", () => {
    const s = new PendingChannelResolutionStore(-1);
    const p = s.create(make());
    expect(s.take(p.token)).toBeUndefined();
  });
});
