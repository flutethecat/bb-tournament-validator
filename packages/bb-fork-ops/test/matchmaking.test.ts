import { describe, expect, it } from "vitest";
import { Matchmaker } from "@bb/fork-ops";

describe("Matchmaker", () => {
  it("returns waiting for a lone challenge", async () => {
    const mm = new Matchmaker();
    await expect(mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "BattleLore" })).resolves.toEqual({
      status: "waiting",
    });
    expect(mm.matchstatus("Kalimar")).toEqual({ status: "waiting" });
  });

  it("pairs reciprocal challenges and delivers a matched result to BOTH sides", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", password: "pwK" });
    await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", password: "pwB" });

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
    // No scheduleGame configured -> no -gameId argument (gameName-only fallback scheme).
    expect(a.jnlp).not.toContain("-gameId");
    expect(b.jnlp).not.toContain("-gameId");
  });

  it("consumes a matched result — a second poll goes back to waiting", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("A").status).toBe("matched");
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
  });

  it("matches case-insensitively on coach names", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "battlelore" });
    await mm.challenge({ coach: "BattleLore", teamId: "2", opponent: "KALIMAR" });
    expect(mm.matchstatus("kalimar").status).toBe("matched");
    expect(mm.matchstatus("BATTLELORE").status).toBe("matched");
  });

  it("does NOT match when the opponent names someone else", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "C" });
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });

  it("rejects a self-challenge and missing fields", async () => {
    const mm = new Matchmaker();
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "a" })).rejects.toThrow(/yourself/i);
    await expect(mm.challenge({ coach: "", teamId: "1", opponent: "B" })).rejects.toThrow(/coach/i);
    await expect(mm.challenge({ coach: "A", teamId: "", opponent: "B" })).rejects.toThrow(/teamId/i);
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "" })).rejects.toThrow(/opponent/i);
  });

  it("cancels a pending challenge so a later reciprocal won't match", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    mm.cancel("A");
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });

  it("expires stale challenges past the TTL (injected clock)", async () => {
    let t = 1000;
    const mm = new Matchmaker({ ttlMs: 5000, now: () => t });
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
    t += 6000; // A's challenge is now stale
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.matchstatus("A")).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B")).toEqual({ status: "waiting" });
  });

  describe("with a scheduleGame function (server-scheduled real gameId)", () => {
    it("embeds -gameId in both sides' JNLP when scheduling succeeds", async () => {
      const calls: Array<[string, string]> = [];
      const mm = new Matchmaker({
        scheduleGame: async (home, away) => {
          calls.push([home, away]);
          return { gameId: "42" };
        },
      });
      await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore" });
      await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar" });

      const a = mm.matchstatus("Kalimar");
      const b = mm.matchstatus("BattleLore");
      if (a.status !== "matched" || b.status !== "matched") throw new Error("unreachable");
      expect(a.jnlp).toContain("<argument>-gameId</argument><argument>42</argument>");
      expect(b.jnlp).toContain("<argument>-gameId</argument><argument>42</argument>");
      // gameName is still present too (additive, not a replacement).
      expect(a.jnlp).toContain(`<argument>-gameName</argument><argument>${a.gameName}</argument>`);

      // Deterministic home/away order — alphabetical by coach ("BattleLore" < "Kalimar"),
      // regardless of who challenged first.
      expect(calls).toEqual([["222", "111"]]);
    });

    it("falls back to the gameName-only scheme when scheduling throws (never blocks pairing)", async () => {
      const mm = new Matchmaker({
        scheduleGame: async () => {
          throw new Error("fork admin unreachable");
        },
      });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A" });

      const a = mm.matchstatus("A");
      const b = mm.matchstatus("B");
      if (a.status !== "matched" || b.status !== "matched") throw new Error("unreachable");
      expect(a.jnlp).not.toContain("-gameId");
      expect(b.jnlp).not.toContain("-gameId");
      expect(a.gameName).toBe(b.gameName); // still paired via the proven fallback
    });

    it("falls back when scheduleGame resolves with no gameId", async () => {
      const mm = new Matchmaker({ scheduleGame: async () => undefined });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B" });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A" });
      const a = mm.matchstatus("A");
      if (a.status !== "matched") throw new Error("unreachable");
      expect(a.jnlp).not.toContain("-gameId");
    });
  });
});
