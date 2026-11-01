import { describe, expect, it } from "vitest";
import { logCounts, mailStatusLine, messageCoaches, messageTeams, sentSummary, type MyMailStatus } from "../spa/src/leagues/messages";
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

  it("summarises a send with only what the server disclosed", () => {
    expect(sentSummary({ id: "x", emailEnabled: true, counts: { notified: 8, queued: 3, skipped: { noConsent: 3, unverified: 0, suppressed: 0 } } }))
      .toBe("Sent to 8 members' notifications. 3 emails queued. 3 members get no email (not opted in, no confirmed address, or the address bounced).");
    expect(sentSummary({ id: "x", emailEnabled: true, counts: { notified: 8, queued: null, skipped: null } }))
      .toBe("Sent to 8 members' notifications. Members who accept league messages also get it by email; some members get no email.");
    expect(sentSummary({ id: "x", emailEnabled: true, counts: null, summary: "S" })).toBe("S");
    expect(sentSummary({ id: "x", emailEnabled: false, counts: null })).toMatch(/Email is not set up/);
    expect(logCounts({ id: "x", sender: "Jay", at: "", scope: "coach", counts: null })).toBe("sent");
  });

  it("account email status line", () => {
    const base: MyMailStatus = { emailEnabled: true, email: null, verified: false, suppressed: false, pending: null, leagueMailOff: null };
    expect(mailStatusLine(base)).toMatch(/No email address/);
    expect(mailStatusLine({ ...base, email: "me@example.test" })).toMatch(/Not confirmed/);
    expect(mailStatusLine({ ...base, email: "me@example.test", verified: true })).toBe("Confirmed for league emails.");
    expect(mailStatusLine({ ...base, email: "me@example.test", verified: true, suppressed: true })).toMatch(/bounced/);
  });
});
