import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Matchmaker, type Matchup, type MatchupGame, type ScheduleOutcome } from "@bb/fork-ops";

const OWNER = { authorized: true } as const;
/** Client challenges carry the coach's own digest; only such seats get a JNLP from matchstatus. */
const PW = "f".repeat(32);

/** The fork stores md5(pw) hex, and matchmaking now works in that digest throughout. */
const md5 = (v: string): string => createHash("md5").update(v, "utf8").digest("hex");

describe("Matchmaker", () => {
  it("returns waiting for a lone challenge", async () => {
    const mm = new Matchmaker();
    await expect(mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "BattleLore", passwordMd5: PW })).resolves.toEqual({
      status: "waiting",
    });
    expect(mm.matchstatus("Kalimar", OWNER)).toEqual({ status: "waiting" });
  });

  it("pairs reciprocal challenges and delivers a matched result to BOTH sides", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", password: "pwK" });
    await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", password: "pwB" });

    const a = mm.matchstatus("Kalimar", OWNER);
    const b = mm.matchstatus("BattleLore", OWNER);
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
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: PW });
    expect(mm.matchstatus("A", OWNER).status).toBe("matched");
    expect(mm.matchstatus("A", OWNER)).toEqual({ status: "waiting" });
  });

  it("matches case-insensitively on coach names", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "Kalimar", teamId: "1", opponent: "battlelore", passwordMd5: PW });
    await mm.challenge({ coach: "BattleLore", teamId: "2", opponent: "KALIMAR", passwordMd5: PW });
    expect(mm.matchstatus("kalimar", OWNER).status).toBe("matched");
    expect(mm.matchstatus("BATTLELORE", OWNER).status).toBe("matched");
  });

  it("does NOT match when the opponent names someone else", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "C", passwordMd5: PW });
    expect(mm.matchstatus("A", OWNER)).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B", OWNER)).toEqual({ status: "waiting" });
  });

  it("rejects a self-challenge and missing fields", async () => {
    const mm = new Matchmaker();
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "a", passwordMd5: PW })).rejects.toThrow(/yourself/i);
    await expect(mm.challenge({ coach: "", teamId: "1", opponent: "B" })).rejects.toThrow(/coach/i);
    await expect(mm.challenge({ coach: "A", teamId: "", opponent: "B" })).rejects.toThrow(/teamId/i);
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "" })).rejects.toThrow(/opponent/i);
  });

  it("cancels a pending challenge so a later reciprocal won't match", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
    mm.cancel("A");
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: PW });
    expect(mm.matchstatus("B", OWNER)).toEqual({ status: "waiting" });
  });

  it("expires stale challenges past the TTL (injected clock)", async () => {
    let t = 1000;
    const mm = new Matchmaker({ ttlMs: 5000, now: () => t });
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
    t += 6000; // A's challenge is now stale
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: PW });
    expect(mm.matchstatus("A", OWNER)).toEqual({ status: "waiting" });
    expect(mm.matchstatus("B", OWNER)).toEqual({ status: "waiting" });
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
      await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: PW });
      await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", passwordMd5: PW });

      const a = mm.matchstatus("Kalimar", OWNER);
      const b = mm.matchstatus("BattleLore", OWNER);
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
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: PW });

      const a = mm.matchstatus("A", OWNER);
      const b = mm.matchstatus("B", OWNER);
      if (a.status !== "matched" || b.status !== "matched") throw new Error("unreachable");
      expect(a.jnlp).not.toContain("-gameId");
      expect(b.jnlp).not.toContain("-gameId");
      expect(a.gameName).toBe(b.gameName); // still paired via the proven fallback
    });

    it("falls back when scheduleGame resolves with no gameId", async () => {
      const mm = new Matchmaker({ scheduleGame: async () => undefined });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: PW });
      const a = mm.matchstatus("A", OWNER);
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
      const a = mm.matchstatus("A", OWNER);
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
      expect(mm.matchstatus("A", OWNER)).toEqual({ status: "waiting" }); // never paired
    });

    it("pairs normally once both sides verify", async () => {
      const mm = new Matchmaker({ verifyChallenger: async () => true });
      await mm.challenge({ coach: "A", teamId: "1", opponent: "B", password: "pwA" });
      await mm.challenge({ coach: "B", teamId: "2", opponent: "A", password: "pwB" });
      expect(mm.matchstatus("A", OWNER).status).toBe("matched");
      expect(mm.matchstatus("B", OWNER).status).toBe("matched");
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
      await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: PW });
      await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", passwordMd5: PW });
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
        await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: PW });
        await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", passwordMd5: PW });
        mm.matchstatus("Kalimar", OWNER);
        mm.matchstatus("BattleLore", OWNER);
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
        await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: PW });
        await mm.challenge({ coach: "BattleLore", teamId: "222", opponent: "Kalimar", passwordMd5: PW });
        mm.matchstatus("Kalimar", OWNER);
        mm.matchstatus("BattleLore", OWNER);
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

describe("Matchmaker views + lobby entry (web Lobby)", () => {
  const D = "a".repeat(32);

  it("pendingOf / pendingFor expose challenges with an id but never the digest", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: D });
    const view = { id: expect.any(String), coach: "Kalimar", teamId: "111", opponent: "BattleLore", createdAt: expect.any(Number) };
    expect(mm.pendingOf("kalimar")).toEqual(view);
    expect(mm.pendingFor("battlelore")).toEqual([view]);
    expect(JSON.stringify(mm.pendingFor("BattleLore"))).not.toContain("aaaa");
    const firstId = mm.pendingOf("Kalimar")!.id;
    await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: D });
    expect(mm.pendingOf("Kalimar")!.id).not.toBe(firstId); // a re-entered challenge is a new consent
  });

  it("onPaired fires once with challenge ids; a throwing listener never breaks pairing", async () => {
    const events: unknown[] = [];
    const mm = new Matchmaker({ scheduleGame: async () => ({ gameId: "77" }), onPaired: () => { throw new Error("boom"); } });
    mm.onPaired((e) => events.push(e));
    await mm.challenge({ coach: "Kalimar", teamId: "111", opponent: "BattleLore", passwordMd5: PW });
    const kId = mm.pendingOf("Kalimar")!.id;
    const res = await mm.challengeVerified({ coach: "BattleLore", teamId: "222", opponent: "Kalimar" });
    expect(res.status).toBe("paired");
    expect(events).toEqual([{
      gameName: expect.stringMatching(/^chal_/), gameId: "77",
      home: { coach: "BattleLore", teamId: "222", challengeId: res.challengeId },
      away: { coach: "Kalimar", teamId: "111", challengeId: kId },
      at: expect.any(Number),
    }]);
    expect(res.pairing).toEqual(events[0]);
  });

  it("a lobby seat (no digest of its own) never gets a JNLP from matchstatus, even when authorized", async () => {
    const mm = new Matchmaker({ verifyChallenger: async () => false });
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D })).rejects.toThrow(/invalid/i);
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    const a = mm.matchstatus("A", { authorized: true });
    expect(a).toEqual({ status: "matched", gameName: expect.stringMatching(/^chal_/), gameId: undefined, opponent: "B" });
    expect(a).not.toHaveProperty("jnlp");
    expect(mm.matchstatus("A", { authorized: true }).status).toBe("matched"); // never consumed here
  });

  it("matchstatus: JNLP only to the owner (session or same digest), built from that digest by the real builder; others get status only", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: "b".repeat(32) });
    const anon = mm.matchstatus("A", { authorized: false });
    expect(anon).not.toHaveProperty("jnlp");
    expect(anon.status).toBe("matched");
    expect(mm.matchstatus("A", { authorized: false, passwordMd5: "b".repeat(32) })).not.toHaveProperty("jnlp");
    const owner = mm.matchstatus("A", { authorized: false, passwordMd5: D.toUpperCase() }) as { jnlp: string };
    expect(owner.jnlp).toContain(`<argument>-passwordMd5</argument><argument>${D}</argument>`);
    expect(owner.jnlp).not.toContain("12345");
    expect(owner.jnlp).not.toContain("<argument>-password</argument>");
    expect(mm.matchstatus("A", { authorized: false })).toEqual({ status: "waiting" }); // consumed by the owner
    const bOwn = mm.matchstatus("B", { authorized: true }) as { jnlp: string };
    expect(bOwn.jnlp).toContain(`<argument>${"b".repeat(32)}</argument>`);
  });

  it("overlapping accepts pair (and schedule) exactly once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const scheduled: string[] = [];
    const mm = new Matchmaker({ scheduleGame: async (h, a) => { scheduled.push(`${h}-${a}`); await gate; return { gameId: "9" }; } });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    const first = mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    const second = mm.challengeVerified({ coach: "B", teamId: "3", opponent: "A" });
    await expect(second).rejects.toThrow(/being set up/);
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: PW })).rejects.toThrow(/being set up/);
    release();
    await expect(first).resolves.toMatchObject({ status: "paired" });
    expect(scheduled).toEqual(["1-2"]);
  });

  it("validateSide: the invalid WAITING side voids its consent and the attempt is rolled back (nothing pending unseen)", async () => {
    const scheduled: string[] = [];
    let bad = "";
    const mm = new Matchmaker({
      scheduleGame: async (h, a) => { scheduled.push(`${h}-${a}`); return { gameId: "1" }; },
      validateSide: (side) => (side.coach === bad ? `${side.coach} can't play right now.` : undefined),
    });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    bad = "A";
    await expect(mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" })).rejects.toThrow(/A can't play/);
    expect(mm.pendingOf("A")).toBeUndefined();
    expect(mm.pendingOf("B")).toBeUndefined(); // Bob's failed attempt is rolled back
    bad = "";
    await mm.challengeVerified({ coach: "A", teamId: "1b", opponent: "B" }); // Alice renews
    expect(scheduled).toEqual([]); // no game until Bob accepts again
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    expect(scheduled).toHaveLength(1);
  });

  it("an invalid ATTEMPTING side is rolled back and its previous challenge restored; the waiting side keeps waiting", async () => {
    const mm = new Matchmaker({ validateSide: (s) => (s.teamId === "bad" ? "Team bad is retired." : undefined) });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "C", passwordMd5: D }); // Bob's earlier, unrelated challenge
    const earlier = mm.pendingOf("B")!.id;
    await expect(mm.challengeVerified({ coach: "B", teamId: "bad", opponent: "A" })).rejects.toThrow(/retired/);
    expect(mm.pendingOf("B")).toMatchObject({ id: earlier, opponent: "C" });
    expect(mm.pendingOf("A")).toMatchObject({ teamId: "1", opponent: "B" });
  });

  it("the host's client Create Game path rolls back the same way (challenge())", async () => {
    let bad = false;
    const mm = new Matchmaker({ validateSide: (s) => (bad && s.coach === "A" ? "A can't play right now." : undefined) });
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    bad = true;
    await expect(mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: D })).rejects.toThrow(/A can't play/);
    expect(mm.pendingOf("B")).toBeUndefined();
  });

  function uncertainSetup(findMatchup?: (m: Matchup) => Promise<MatchupGame[] | undefined>) {
    const scheduled: string[] = [];
    const mm = new Matchmaker({
      scheduler: {
        schedule: async (h, a): Promise<ScheduleOutcome> => { scheduled.push(`${h}-${a}`); return scheduled.length === 1 ? { kind: "unknown", error: "504" } : { kind: "scheduled", gameId: `fresh-${scheduled.length}`, homeTeamId: h, awayTeamId: a }; },
        ...(findMatchup ? { findMatchup } : {}),
      },
    });
    return { mm, scheduled };
  }

  it("an unknown outcome makes the pairing uncertain: consents held, coaches reserved, no named game, no second schedule", async () => {
    const { mm, scheduled } = uncertainSetup();
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    expect(await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" })).toMatchObject({ status: "uncertain" });
    expect(mm.operationState("a", "b")).toBe("uncertain");
    expect(mm.matchstatus("A", { authorized: true })).toEqual({ status: "waiting" });
    await expect(mm.challengeVerified({ coach: "A", teamId: "1", opponent: "C" })).rejects.toThrow(/being set up/);
    // re-entry by either coach of the same pairing is refused (only Check again / Start over apply), no schedule
    await expect(mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" })).rejects.toThrow(/Check again or Start over/);
    await expect(mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D })).rejects.toThrow(/Check again or Start over/);
    expect(await mm.checkAgain("A", "B")).toMatchObject({ status: "uncertain" });
    expect(scheduled).toHaveLength(1);
  });

  it("Check again pairs only when the exact matchup is live; absence keeps it uncertain; extra games are reported", async () => {
    let live: MatchupGame[] | undefined = [];
    const asked: Matchup[] = [];
    const { mm, scheduled } = uncertainSetup(async (m) => { asked.push(m); return live; });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    expect(await mm.checkAgain("A", "B")).toMatchObject({ status: "uncertain" }); // nothing live: NOT "no game"
    live = undefined;
    expect(await mm.checkAgain("A", "B")).toMatchObject({ status: "uncertain" }); // could not check
    live = [{ gameId: "905", homeCoach: "A" }, { gameId: "903", homeCoach: "B" }]; // the fork lists B as home
    const r = await mm.checkAgain("B", "A");
    expect(r).toMatchObject({ status: "paired", pairing: { gameId: "903", duplicates: ["905"], home: { coach: "B", teamId: "2" }, away: { coach: "A", teamId: "1" } } });
    expect(asked.at(-1)).toEqual({ home: expect.objectContaining({ teamId: expect.any(String) }), away: expect.objectContaining({ teamId: expect.any(String) }) });
    expect(new Set([asked.at(-1)!.home.coach, asked.at(-1)!.away.coach])).toEqual(new Set(["A", "B"]));
    expect(scheduled).toHaveLength(1);
    expect(mm.operationState("A", "B")).toBe("none");
    expect(mm.matchstatus("A", { authorized: true })).toMatchObject({ status: "matched", gameId: "903" });
  });

  it("Start over withdraws both consents; only then may the coaches challenge (and schedule) afresh", async () => {
    const { mm, scheduled } = uncertainSetup();
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    expect(mm.startOver("b")).toBe(true);
    expect(mm.operationState("A", "B")).toBe("none");
    expect(mm.pendingOf("A")).toBeUndefined();
    expect(mm.pendingOf("B")).toBeUndefined();
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    expect((await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" })).pairing?.gameId).toBe("fresh-2");
    expect(scheduled).toHaveLength(2);
  });

  it("a definite rejection keeps the named-game fallback (unchanged)", async () => {
    const mm = new Matchmaker({ scheduler: { schedule: async () => ({ kind: "rejected", error: "no" }) } });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    const r = await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    expect(r).toMatchObject({ status: "paired", pairing: { gameId: undefined, gameName: expect.stringMatching(/^chal_/) } });
  });

  it("a plain scheduler that never answers becomes uncertain at the deadline (no timers left behind)", async () => {
    const mm = new Matchmaker({ scheduleTimeoutMs: 15, scheduleGame: () => new Promise(() => {}) });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    expect((await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" })).status).toBe("uncertain");
  });

  it("close / cancel during the in-flight schedule withdraws consent: no pairing, nothing restored", async () => {
    let answer!: (r: { gameId: string }) => void;
    const mm = new Matchmaker({ scheduleGame: () => new Promise((r) => { answer = r; }) });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    const aId = mm.pendingOf("A")!.id;
    const attempt = mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    await new Promise((r) => setTimeout(r, 0));
    expect(mm.operationState("A", "B")).toBe("inflight");
    expect(mm.holdsChallenge("A", aId)).toBe(true); // the lobby's close can still find the consent
    mm.withdraw("A", aId); // the lobby was closed
    answer({ gameId: "77" });
    expect((await attempt).status).toBe("waiting");
    expect(mm.matchstatus("A", { authorized: true })).toEqual({ status: "waiting" });
    expect(mm.pendingOf("A")).toBeUndefined();
    expect(mm.pendingOf("B")).toBeUndefined();
  });

  it("close / cancel while uncertain drops the operation and its consents", async () => {
    const { mm } = uncertainSetup(async () => [{ gameId: "1", homeCoach: "A" }]);
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    const r = await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    mm.withdraw("B", r.challengeId);
    expect(mm.operationState("A", "B")).toBe("none");
    expect(await mm.checkAgain("A", "B")).toBeUndefined();
  });

  it("client admission generation: a cancel while the password is verified refuses the challenge", async () => {
    let release!: (ok: boolean) => void;
    const mm = new Matchmaker({ verifyChallenger: () => new Promise((r) => { release = r; }) });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    const attempt = mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    mm.cancel("A");
    release(true);
    await expect(attempt).rejects.toThrow(/changed while it was being checked/);
    expect(mm.matchstatus("B", { authorized: true })).toEqual({ status: "waiting" });
  });

  it("rollback never resurrects a challenge cancelled while the attempt was in flight (consent generation)", async () => {
    let releaseValidation!: () => void;
    const gate = new Promise<void>((r) => { releaseValidation = r; });
    const mm = new Matchmaker({
      validateSide: async (side) => { await gate; return side.coach === "A" ? "A is banned." : undefined; },
    });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "C", passwordMd5: D }); // B's earlier challenge to C
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    const attempt = mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    mm.cancel("B");
    releaseValidation();
    await expect(attempt).rejects.toThrow(/A is banned/);
    expect(mm.pendingOf("B")).toBeUndefined();
  });

  it("onDelivered fires only for an authorized JNLP delivery", async () => {
    const seen: string[] = [];
    const mm = new Matchmaker();
    mm.onDelivered((d) => seen.push(`${d.coach}:${d.gameName.slice(0, 5)}`));
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    await mm.challenge({ coach: "B", teamId: "2", opponent: "A", passwordMd5: D });
    mm.matchstatus("A", { authorized: false });
    expect(seen).toEqual([]);
    mm.matchstatus("A", { authorized: true });
    expect(seen).toEqual(["A:chal_"]);
  });

  it("a consent that expires while the client is authenticated is gone for good (swept before reservation)", async () => {
    let t = 0;
    let release!: (ok: boolean) => void;
    const mm = new Matchmaker({ now: () => t, ttlMs: 100, verifyChallenger: () => new Promise((r) => { release = r; }) });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" }); // created at 0, expires after 100
    t = 99;
    const attempt = mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    t = 101; // B's consent expires during A's verification; no other request sweeps
    release(true);
    await attempt;
    expect(mm.matchstatus("A", { authorized: true })).toEqual({ status: "waiting" });
    expect(mm.pendingOf("B")).toBeUndefined();
  });

  it("cancel authorization: the coach's own session or the same digest only", async () => {
    const mm = new Matchmaker();
    await mm.challenge({ coach: "A", teamId: "1", opponent: "B", passwordMd5: D });
    expect(mm.mayCancel("A", { authorized: false })).toBe(false);
    expect(mm.mayCancel("A", { authorized: false, passwordMd5: "e".repeat(32) })).toBe(false);
    expect(mm.mayCancel("A", { authorized: false, passwordMd5: D })).toBe(true);
    expect(mm.mayCancel("A", { authorized: true })).toBe(true);
    await mm.challengeVerified({ coach: "C", teamId: "3", opponent: "D" }); // lobby consent: no digest at all
    expect(mm.mayCancel("C", { authorized: false, passwordMd5: D })).toBe(false);
  });

  it("a check stays occupied until its lookup settles (no stacked reads)", async () => {
    let calls = 0;
    let finish!: (v: MatchupGame[]) => void;
    const mm = new Matchmaker({
      scheduleTimeoutMs: 10,
      scheduler: {
        schedule: async (): Promise<ScheduleOutcome> => ({ kind: "unknown" }),
        findMatchup: () => { calls++; return new Promise((r) => { finish = r; }); },
      },
    });
    await mm.challengeVerified({ coach: "A", teamId: "1", opponent: "B" });
    await mm.challengeVerified({ coach: "B", teamId: "2", opponent: "A" });
    expect((await mm.checkAgain("A", "B"))?.status).toBe("uncertain"); // our deadline passed, lookup still running
    expect((await mm.checkAgain("A", "B"))?.status).toBe("uncertain");
    expect(calls).toBe(1);
    finish([]);
    await new Promise((r) => setTimeout(r, 0));
    await mm.checkAgain("A", "B");
    expect(calls).toBe(2);
  });
});
