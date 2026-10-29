import { describe, expect, it } from "vitest";
import { generateTournamentPairings, pairSwissDutch, pairSwissMonrad } from "../src/tournaments/pairing.js";
import type { ScheduledMatchRecord, TournamentEntrantRecord } from "../src/tournaments/types.js";

// Named Swiss systems (spec-spa-tournaments §6.3): Dutch (score groups, top half v bottom half, floaters, no rematch,
// bye to the lowest unbyed) and Monrad (1-2, 3-4, skip a rematch). The min-cost matcher stays the fallback.

const points = { win: 3, draw: 1, loss: 0, bye: 3 };
const tiebreakers = ["touchdownDifferential", "seed"] as const;

function entrant(index: number): TournamentEntrantRecord {
  return {
    id: `e${index}`,
    tournamentId: "cup",
    seed: index,
    coach: { coachId: `coach-${index}`, ffbCoachId: `Coach${index}`, verifiedAt: "2026-08-26T00:00:00.000Z" },
    teamId: `team-${index}`,
    registeredAt: "2026-08-26T00:00:00.000Z",
  };
}

let serial = 0;
function played(round: number, home: number, away: number | undefined, homeScore = 0, awayScore = 0): ScheduledMatchRecord {
  serial += 1;
  return {
    id: `m${serial}`,
    tournamentId: "cup",
    roundId: `r${round}`,
    roundNumber: round,
    home: { entrantId: `e${home}`, coach: entrant(home).coach, teamId: `team-${home}` },
    ...(away === undefined ? {} : { away: { entrantId: `e${away}`, coach: entrant(away).coach, teamId: `team-${away}` } }),
    status: "completed",
    revision: 2,
    launch: { challengePath: "/api/fork/challenge", jnlpPath: "/api/fork/jnlp", retryCount: 0 },
    result: { homeScore, awayScore, reportedAt: "2026-08-26T01:00:00.000Z" },
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T01:00:00.000Z",
  };
}

const pairsOf = (pairings: Array<{ homeEntrantId: string; awayEntrantId?: string }> | undefined) =>
  (pairings ?? []).map((p) => (p.awayEntrantId ? `${p.homeEntrantId}-${p.awayEntrantId}` : `${p.homeEntrantId}:bye`));

const met = (matches: ScheduledMatchRecord[]) => new Set(matches.filter((m) => m.away).map((m) => [m.home.entrantId, m.away!.entrantId].sort().join("|")));

describe("Dutch", () => {
  it("round 1: the seeded top half meets the bottom half (1 v 5, 2 v 6 ...)", () => {
    const field = [1, 2, 3, 4, 5, 6, 7, 8].map(entrant);
    expect(pairsOf(pairSwissDutch(field, [], points, tiebreakers))).toEqual(["e1-e5", "e2-e6", "e3-e7", "e4-e8"]);
  });

  it("pairs inside score groups: winners meet winners, losers meet losers, top half v bottom half within a group", () => {
    const field = [1, 2, 3, 4, 5, 6, 7, 8].map(entrant);
    // Round 1 (1-5, 2-6, 3-7, 4-8): the top seeds win by falling margins, so standings run e1 e2 e3 e4 | e8 e7 e6 e5.
    const r1 = [played(1, 1, 5, 4, 0), played(1, 2, 6, 3, 0), played(1, 3, 7, 2, 0), played(1, 4, 8, 1, 0)];
    const pairs = pairsOf(pairSwissDutch(field, r1, points, tiebreakers));
    // Winners group [e1 e2 e3 e4]: S1 = e1 e2, S2 = e3 e4 -> 1-3, 2-4. Losers group [e8 e7 e6 e5] -> 8-6, 7-5.
    expect(pairs).toEqual(["e1-e3", "e2-e4", "e8-e6", "e7-e5"]);
  });

  it("an odd score group floats its lowest entrant down to the next group", () => {
    const field = [1, 2, 3, 4].map(entrant);
    // e1 beats e2; e3 and e4 draw: groups [e1] (3), [e3 e4] (1), [e2] (0).
    const r1 = [played(1, 1, 2, 2, 0), played(1, 3, 4, 1, 1)];
    const pairs = pairSwissDutch(field, r1, points, tiebreakers);
    expect(pairsOf(pairs)).toHaveLength(2);
    // e1 floats down to the top of the draw group; the draw group's remaining entrant meets e2.
    expect(pairsOf(pairs)[0]).toMatch(/^e1-e(3|4)$/);
    for (const key of met(r1)) expect(pairsOf(pairs).map((p) => p.split("-").sort().join("|"))).not.toContain(key);
  });

  it("never repeats a pairing when a legal alternative exists", () => {
    const field = [1, 2, 3, 4, 5, 6].map(entrant);
    const history = [
      played(1, 1, 4, 1, 0), played(1, 2, 5, 1, 0), played(1, 3, 6, 1, 0),
      played(2, 1, 2, 1, 0), played(2, 3, 4, 0, 1), played(2, 5, 6, 1, 0),
    ];
    const pairs = pairSwissDutch(field, history, points, tiebreakers);
    expect(pairs).toBeDefined();
    const seen = met(history);
    for (const p of pairs!) if (p.awayEntrantId) expect(seen.has([p.homeEntrantId, p.awayEntrantId].sort().join("|"))).toBe(false);
  });

  it("an odd field gives the bye to the lowest-ranked entrant who has not had one", () => {
    const field = [1, 2, 3, 4, 5].map(entrant);
    const first = pairSwissDutch(field, [], points, tiebreakers)!;
    expect(first[0]).toEqual({ homeEntrantId: "e5" });
    // e5 had the bye and sits on 3 points; the lowest without one (a loser) takes the next.
    const r1 = [played(1, 5, undefined), played(1, 1, 3, 1, 0), played(1, 2, 4, 1, 0)];
    const second = pairSwissDutch(field, r1, points, tiebreakers)!;
    expect(second[0]!.awayEntrantId).toBeUndefined();
    expect(["e3", "e4"]).toContain(second[0]!.homeEntrantId);
  });

  it("returns undefined when no rematch-free pairing exists (the caller falls back to the min-cost matcher)", () => {
    const field = [1, 2].map(entrant);
    const r1 = [played(1, 1, 2, 1, 0)];
    expect(pairSwissDutch(field, r1, points, tiebreakers)).toBeUndefined();
    expect(pairsOf(generateTournamentPairings("swiss", 2, field, r1, points, [...tiebreakers], { system: "dutch" }))).toEqual(["e1-e2"]);
  });
});

describe("Monrad", () => {
  it("round 1 pairs by seed 1-2, 3-4", () => {
    const field = [1, 2, 3, 4, 5, 6].map(entrant);
    expect(pairsOf(pairSwissMonrad(field, [], points, tiebreakers))).toEqual(["e1-e2", "e3-e4", "e5-e6"]);
  });

  it("pairs adjacent ranks and skips to the next legal opponent on a rematch", () => {
    const field = [1, 2, 3, 4].map(entrant);
    // e1 beat e2 3-0, e3 beat e4 1-0: rank e1 e3 e4 e2 by points then TD diff. 1-3 then 4-2.
    const r1 = [played(1, 1, 2, 3, 0), played(1, 3, 4, 1, 0)];
    expect(pairsOf(pairSwissMonrad(field, r1, points, tiebreakers))).toEqual(["e1-e3", "e4-e2"]);
    // Round 3 after 1-3 and 4-2: e1 has met e2 and e3, so e1 skips to e4.
    const r2 = [played(2, 1, 3, 1, 0), played(2, 4, 2, 1, 0)];
    const pairs = pairsOf(pairSwissMonrad(field, [...r1, ...r2], points, tiebreakers));
    expect(pairs[0]).toBe("e1-e4");
    expect(pairs[1]).toMatch(/^e(2-e3|3-e2)$/);
  });

  it("the system is chosen per tournament through generateTournamentPairings", () => {
    const field = [1, 2, 3, 4].map(entrant);
    expect(pairsOf(generateTournamentPairings("swiss", 1, field, [], points, [...tiebreakers], { system: "monrad" }))).toEqual(["e1-e2", "e3-e4"]);
    expect(pairsOf(generateTournamentPairings("swiss", 1, field, [], points, [...tiebreakers], { system: "dutch" }))).toEqual(["e1-e3", "e2-e4"]);
    // eloSeeded / absent = the original min-cost matcher (round 1 top half v bottom half).
    expect(pairsOf(generateTournamentPairings("swiss", 1, field, [], points, [...tiebreakers]))).toEqual(["e1-e3", "e2-e4"]);
  });

  it("standby (inactive) entrants are left out of the draw", () => {
    const field = [1, 2, 3, 4].map(entrant);
    const eligible = (e: TournamentEntrantRecord) => e.id !== "e2";
    expect(pairsOf(generateTournamentPairings("swiss", 1, field, [], points, [...tiebreakers], { system: "monrad", eligible })))
      .toEqual(["e4:bye", "e1-e3"]);
  });
});
