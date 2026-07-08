import { describe, expect, it } from "vitest";
import { Matchmaker } from "@bb/fork-ops";

describe("Matchmaker", () => {
  it("returns waiting for a lone challenge", () => {
    const mm = new Matchmaker();
    expect(mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "BattleLore" })).toEqual({ status: "waiting" });
    expect(mm.matchstatus("Kalimar")).toEqual({ status: "waiting" });
  });

  it("pairs reciprocal challenges and delivers a matched result to BOTH sides", () => {
    const mm = new Matchmaker();
    mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", password: "pwK" });
    mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", password: "pwB" });

    const a = mm.matchstatus("Kalimar");
    const b = mm.matchstatus("BattleLore");
    expect(a.status).toBe("matched");
    expect(b.status).toBe("matched");
    if (a.status !== "matched" || b.status !== "matched") throw new Error("unreachable");

    // Shared game name, each side sees the other as opponent.
    expect(a.gameName).toBe(b.gameName);
    expect(a.opponent).toBe("BattleLore");
    expect(b.opponent).toBe("Kalimar");

    // Each JNLP carries that side's own coach / team / password.
    expect(a.jnlp).toContain("<argument>-coach</argument><argument>Kalimar</argument>");
    expect(a.jnlp).toContain("<argument>-teamId</argument><argument>111</argument>");
    expect(a.jnlp).toContain("<argument>-password</argument><argument>pwK</argument>");
    expect(a.jnlp).toContain(`<argument>-gameName</argument><argument>${a.gameName}</argument>`);
    expect(b.jnlp).toContain("<argument>-coach</argument><argument>BattleLore</argument>");
    expect(b.jnlp).toContain("<argument>-teamId</argument><argument>222</argument>");
    expect(b.jnlp).toContain("<argument>-password</argument><argument>pwB</argument>");
  });

  it("consumes a matched result — a second poll goes back to waiting", () => {
    const mm = new Matchmaker();
    mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("A").status).toBe("matched");
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
  });

  it("matches case-insensitively on coach names", () => {
    const mm = new Matchmaker();
    mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "battlelore" });
    mm.challenge({ coach: "BattleLore", teamId: "2", opponent: "KALIMAR" });
    expect(mm.matchstatus("kalimar").status).toBe("matched");
    expect(mm.matchstatus("BATTLELORE").status).toBe("matched");
  });

  it("does NOT match when the opponent names someone else", () => {
    const mm = new Matchmaker();
    mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    mm.challenge({ coach: "B", teamId: "2", opponent: "C" });
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });

  it("rejects a self-challenge and missing fields", () => {
    const mm = new Matchmaker();
    expect(() => mm.challenge({ coach: "A", teamId: "1", opponent: "a" })).toThrow(/yourself/i);
    expect(() => mm.challenge({ coach: "", teamId: "1", opponent: "B" })).toThrow(/coach/i);
    expect(() => mm.challenge({ coach: "A", teamId: "", opponent: "B" })).toThrow(/teamId/i);
    expect(() => mm.challenge({ coach: "A", teamId: "1", opponent: "" })).toThrow(/opponent/i);
  });

  it("cancels a pending challenge so a later reciprocal won't match", () => {
    const mm = new Matchmaker();
    mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    mm.cancel("A");
    mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });

  it("expires stale challenges past the TTL (injected clock)", () => {
    let t = 1000;
    const mm = new Matchmaker({ ttlMs: 5000, now: () => t });
    mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    t += 6000; // A's challenge is now stale
    mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });
});
