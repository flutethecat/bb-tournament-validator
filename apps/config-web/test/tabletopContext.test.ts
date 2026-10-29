import { describe, expect, it } from "vitest";
import { matchContext, type FixtureGateway, type FixtureView } from "../src/tabletop/api.js";
import type { MatchRecord } from "../src/tabletop/store.js";

const match = (extra: Partial<MatchRecord> = {}): MatchRecord => ({
  id: "m1", state: "recording", home: { coach: "A", teamSaveId: "a", teamName: "A XI" }, away: { coach: "B", teamSaveId: "b", teamName: "B XI" },
  postMatch: "none", createdBy: "A", createdAt: "2026-10-28T20:00:00.000Z", updatedAt: "2026-10-28T20:00:00.000Z", confirmations: {}, baseRevision: { home: 0, away: 0 }, ...extra,
});
const fixture = (extra: Partial<FixtureView> = {}): FixtureView => ({
  id: "f1", open: true, status: "scheduled", revision: 1, home: { coach: "A" }, away: { coach: "B" },
  tournament: { id: "t1", name: "Spring Cup" }, round: 7, roundCount: 8, packageName: "NAF World Cup 2027", ...extra,
});
const gateway = (f: FixtureView): FixtureGateway => ({ get: (id) => (id === "f1" ? f : undefined), record: () => undefined, retract: () => undefined });

describe("match context (the header bar above the hero)", () => {
  it("casual: 'Casual match' over the teams' real ruleset/package name, with the recorded start", () => {
    const pk = { packageNameOf: (_c: string, ref: string) => (ref === "a" ? "NAF World Cup 2027" : undefined) };
    expect(matchContext(match(), pk)).toEqual({ kind: "casual", title: "Casual match", subtitle: "NAF World Cup 2027", startedAt: "2026-10-28T20:00:00.000Z" });
    expect(matchContext(match(), { packageNameOf: (_c, ref) => (ref === "a" ? "Pack A" : "Pack B") }).subtitle).toBe("Pack A / Pack B");
    expect(matchContext(match(), {}).subtitle).toBe(""); // nothing known: no placeholder
  });
  it("tournament: the tournament name over its package, round and round count", () => {
    expect(matchContext(match({ fixtureRef: "f1", league: "NAF World Cup 2027" }), { fixtures: gateway(fixture()) }))
      .toMatchObject({ kind: "tournament", title: "Spring Cup", subtitle: "NAF World Cup 2027", round: 7, roundCount: 8 });
  });
  it("tournament in a series: the series name is the subline", () => {
    expect(matchContext(match({ fixtureRef: "f1" }), { fixtures: gateway(fixture({ seriesName: "Winter Series" })) })).toMatchObject({ kind: "tournament", subtitle: "Winter Series" });
  });
  it("league fixture: the league name over 'Round 7/8'", () => {
    expect(matchContext(match({ fixtureRef: "f1", league: "Pacific League" }), { fixtures: gateway(fixture()) }))
      .toMatchObject({ kind: "league", title: "Pacific League", subtitle: "Round 7/8", round: 7, roundCount: 8 });
  });
  it("carries the venue when the match has one", () => {
    expect(matchContext(match({ venue: "Table 3" }), {})).toMatchObject({ venue: "Table 3" });
  });
});
