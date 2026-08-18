import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Matchmaker } from "@bb/fork-ops";

/** The fork stores md5(pw) hex, and matchmaking now works in that digest throughout. */
const md5 = (v: string): string => createHash("md5").update(v, "utf8").digest("hex");

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

    // Each JNLP carries that side's own coach / team / credential. The credential rides as
    // the md5 DIGEST (owner ruling 08-17) — matchmaking reduces whichever carrier arrived at
    // admission, so a coach's clear-text password never reaches the file they download.
    expect(a.jnlp).toContain("<argument>-coach</argument><argument>Kalimar</argument>");
    expect(a.jnlp).toContain("<argument>-teamId</argument><argument>111</argument>");
    expect(a.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${md5("pwK")}</argument>`);
    expect(a.jnlp).not.toContain("pwK<");
    expect(a.jnlp).toContain(`<argument>-gameName</argument><argument>${a.gameName}</argument>`);
    expect(b.jnlp).toContain("<argument>-coach</argument><argument>BattleLore</argument>");
    expect(b.jnlp).toContain("<argument>-teamId</argument><argument>222</argument>");
    expect(b.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${md5("pwB")}</argument>`);
    expect(b.jnlp).not.toContain("pwB<");
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
      // Surfaced as a first-class field (wire-proves the client's -gameId consumer), not only in the JNLP.
      expect(a.gameId).toBe("42");
      expect(b.gameId).toBe("42");
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

  describe("with a verifyChallenger function (authenticated mutual consent)", () => {
    it("rejects a challenge with no password when verification is configured", async () => {
      const mm = new Matchmaker({ verifyChallenger: async () => true });
      await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "B" })).rejects.toThrow(/password is required/i);
    });

    it("rejects a challenge that fails verification, without registering it as pending", async () => {
      const mm = new Matchmaker({ verifyChallenger: async (coach) => coach !== "A" });
      await expect(
        mm.challenge({ coach: "A", teamId: "1", opponent: "B", password: "wrong" }),
      ).rejects.toThrow(/invalid coach name or password/i);
      // B's reciprocal challenge must NOT find A's — the rejected attempt left no state behind.
      await expect(mm.challenge({ coach: "B", teamId: "2", opponent: "A", password: "pwB" })).resolves.toEqual({
        status: "waiting",
      });
    });

    it("accepts a pre-hashed passwordMd5 as well as a clear-text password", async () => {
      // Dual-accept at the matchmaking door: a client that already pre-hashed (the point of
      // the 08-17 ruling) and one still sending clear text must both be able to challenge,
      // and must reduce to the SAME digest so either can pair with either.
      const seen: string[] = [];
      const mm = new Matchmaker({
        verifyChallenger: async (_coach, digest) => {
          seen.push(digest);
          return true;
        },
      });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: md5("pw") });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A", password: "pw" });
      expect(seen).toEqual([md5("pw"), md5("pw")]);

      // …and both sides still paired, each JNLP carrying the digest.
      const a = mm.matchstatus("A");
      expect(a.status).toBe("matched");
      if (a.status === "matched") {
        expect(a.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${md5("pw")}</argument>`);
        expect(a.jnlp).not.toContain(">pw<");
      }
    });

    it("rejects a malformed passwordMd5 rather than treating it as a password", async () => {
      const mm = new Matchmaker({ verifyChallenger: async () => true });
      await expect(
        mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: "not-a-digest" }),
      ).rejects.toThrow(/32-character hex/);
    });

    it("cannot be spoofed by one caller issuing both sides of a 'mutual' challenge", async () => {
      // Only the real "A" and real "B" passwords verify — an attacker guessing wrong for
      // either side never gets a schedule-worthy mutual pair.
      // Keyed by DIGEST, because that is what the verifier is handed now.
      const verified = new Set([`A:${md5("secretA")}`, `B:${md5("secretB")}`]);
      const mm = new Matchmaker({ verifyChallenger: async (coach, digest) => verified.has(`${coach}:${digest}`) });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", password: "secretA" });
      await expect(
        mm.challenge({ coach: "B", teamId: "2", opponent: "A", password: "guessed-wrong" }),
      ).rejects.toThrow(/invalid coach name or password/i);
      expect(mm.matchstatus("A")).toEqual({ status: "waiting" }); // never paired
    });

    it("pairs normally once both sides verify", async () => {
      const mm = new Matchmaker({ verifyChallenger: async () => true });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", password: "pwA" });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A", password: "pwB" });
      expect(mm.matchstatus("A").status).toBe("matched");
      expect(mm.matchstatus("B").status).toBe("matched");
    });
  });

  describe("home/away assignment", () => {
    it("defaults to alternating, whose FIRST meeting is alphabetical (backward compatible)", async () => {
      const calls: Array<[string, string]> = [];
      const mm = new Matchmaker({
        scheduleGame: async (home, away) => {
          calls.push([home, away]);
          return { gameId: "1" };
        },
      });
      expect(mm.getHomeAwayMode()).toBe("alternating");
      await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore" });
      await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar" });
      // BattleLore < Kalimar alphabetically → BattleLore(222) is home on the first meeting.
      expect(calls[0]).toEqual(["222", "111"]);
    });

    it("alternating swaps home/away each time the SAME pair meets again", async () => {
      const calls: Array<[string, string]> = [];
      const mm = new Matchmaker({
        scheduleGame: async (home, away) => {
          calls.push([home, away]);
          return { gameId: "g" };
        },
      });
      for (let i = 0; i < 4; i++) {
        await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore" });
        await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar" });
        mm.matchstatus("Kalimar");
        mm.matchstatus("BattleLore");
      }
      // Meetings 0,2 → sorted (222 home); meetings 1,3 → swapped (111 home).
      expect(calls).toEqual([
        ["222", "111"],
        ["111", "222"],
        ["222", "111"],
        ["111", "222"],
      ]);
    });

    it("random mode uses the injected RNG to pick home", async () => {
      const calls: Array<[string, string]> = [];
      const seq = [0.9, 0.1]; // >=0.5 → no swap; <0.5 → swap
      let i = 0;
      const mm = new Matchmaker({
        homeAwayMode: "random",
        random: () => seq[i++]!,
        scheduleGame: async (home, away) => {
          calls.push([home, away]);
          return { gameId: "g" };
        },
      });
      for (let n = 0; n < 2; n++) {
        await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore" });
        await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar" });
        mm.matchstatus("Kalimar");
        mm.matchstatus("BattleLore");
      }
      expect(calls).toEqual([
        ["222", "111"], // 0.9 → no swap → sorted, BattleLore(222) home
        ["111", "222"], // 0.1 → swap → Kalimar(111) home
      ]);
    });

    it("setHomeAwayMode switches policy at runtime and rejects unknown modes", () => {
      const mm = new Matchmaker();
      mm.setHomeAwayMode("random");
      expect(mm.getHomeAwayMode()).toBe("random");
      mm.setHomeAwayMode("alternating");
      expect(mm.getHomeAwayMode()).toBe("alternating");
      expect(() => mm.setHomeAwayMode("bogus" as never)).toThrow(/unknown home\/away mode/i);
    });
  });
});
