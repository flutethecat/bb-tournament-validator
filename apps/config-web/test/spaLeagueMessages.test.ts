import { describe, expect, it } from "vitest";
import { mailStatusLine, messageCoaches, messageTeams, sentSummary, type MyMailStatus } from "../spa/src/leagues/messages";
import type { SeasonRecord } from "../spa/src/leagues/types";

// League "Message members" composer and the Account Email panel: the display helpers (counts only, never an address of
// another coach).

const season = {
  teams: [
    { id: "orcs", name: "Orcs", coachId: "Ann" }, { id: "elves", name: "Elves", coachId: "bob" }, { id: "none", name: "No Account" },
    { id: "mine", name: "Mine", coachId: "Jay" },
  ],
  participants: [{ coach: "Cat", coachId: "Cat" }, { coach: "Ann again", coachId: "ann" }],
} as unknown as SeasonRecord;

describe("message members helpers", () => {
  it("teams with a coach account and member coaches, without the sender", () => {
    expect(messageTeams(season, "jay")).toEqual([{ id: "elves", label: "Elves (bob)" }, { id: "orcs", label: "Orcs (Ann)" }]);
    expect(messageCoaches(season, "Jay")).toEqual(["Ann", "bob", "Cat"]);
  });

  it("summarises a send with counts only", () => {
    expect(sentSummary({ id: "x", notified: 5, queued: 2, skipped: { noConsent: 2, unverified: 1, suppressed: 0 }, emailEnabled: true }))
      .toBe("Sent to 5 members' notifications. 2 emails queued. 3 members get no email (not opted in, no confirmed address, or the address bounced).");
    expect(sentSummary({ id: "x", notified: 1, queued: 0, skipped: { noConsent: 0, unverified: 0, suppressed: 0 }, emailEnabled: false }))
      .toBe("Sent to 1 member's notifications. Email is not set up on this site yet.");
  });

  it("account email status line", () => {
    const base: MyMailStatus = { emailEnabled: true, email: null, verified: false, suppressed: false, pending: null, leagueMailOff: null };
    expect(mailStatusLine(base)).toMatch(/No email address/);
    expect(mailStatusLine({ ...base, email: "me@example.test" })).toMatch(/Not confirmed/);
    expect(mailStatusLine({ ...base, email: "me@example.test", verified: true })).toBe("Confirmed for league emails.");
    expect(mailStatusLine({ ...base, email: "me@example.test", verified: true, suppressed: true })).toMatch(/bounced/);
  });
});
