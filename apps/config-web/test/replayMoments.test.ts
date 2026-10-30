import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMomentDeriver, deriveReplayMoments } from "../src/replay/moments";

// The replay reader's moment derivation (src/replay/moments.ts) over real replay streams captured from the local fork
// (scripts/capture-replay.ts, 10-30) and over hand-built streams for the reports those games do not carry.

const fixture = (id: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", `replay-${id}.json`), "utf8")) as { gameState: unknown; commands: unknown[] };
const brief = (m: { half: number | null; turn: number | null; side: string | null; kind: string; text: string }) =>
  `${m.half ?? "-"}/${m.turn ?? "-"} ${m.side ?? "game"} ${m.kind}: ${m.text}`;

describe("replay moments: real fork streams", () => {
  it("game 999 (online, away concession, 2 awarded TDs): ordered with half and turn, names from the player model", () => {
    const f = fixture("999");
    const d = deriveReplayMoments(f.gameState, f.commands);
    expect(d.teams.home).toEqual({ teamId: "tb_flutethecat_gnome_mumzzhdu", name: "UAT2 Woodland", coach: "Flutethecat" });
    expect(d.teams.away.name).toBe("UAt2 Nurgle");
    expect(d.commands).toBe(648);
    expect(d.truncated).toBe(false);
    expect(d.moments.map(brief)).toEqual([
      "-/- game weather: Weather: Nice Weather (2 + 3)",
      "1/- game halfStart: Start of half 1",
      "1/- game kickoff: Kick-off: Brilliant Coaching (4 + 3)",
      "1/1 away casualty: Casualty: Grashnak Blackhoof on Gnome Lineman 1 (Badly Hurt)",
      "1/5 away concession: Concession: UAt2 Nurgle",
      "1/5 home touchdown: Touchdown awarded: Swiftvine Glimmershard",
      "1/5 home touchdown: Touchdown awarded: Jordell Freshbreeze",
    ]);
    expect(d.moments[3]).toMatchObject({
      commandNr: 113, playerId: "tb_gondra87_nurgle_mumzyebo5", victimId: "tb_flutethecat_gnome_mumzzhdu12", victimSide: "home", result: "Badly Hurt",
    });
    // the injury report arrives twice (skipInjuryParts CAS, then EVERYTHING_BUT_CAS): one casualty
    expect(d.moments.filter((m) => m.kind === "casualty")).toHaveLength(1);
    expect(d.moments[4]).toMatchObject({ legal: false });
    expect(d.moments.slice(5).every((m) => m.awarded === true)).toBe(true);
    expect(d.moments.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("game 1097 (league test game): a scored touchdown, a lasting injury, a Secret Weapon send-off, a weather-free second kick-off", () => {
    const f = fixture("1097");
    const d = deriveReplayMoments(f.gameState, f.commands);
    expect(d.moments.map(brief)).toEqual([
      "-/- game weather: Weather: Nice Weather (1 + 6)",
      "1/- game halfStart: Start of half 1",
      "1/- game kickoff: Kick-off: Charge (5 + 5)",
      "1/1 home casualty: Casualty: Zegerd Commonbender on Bender (Smashed Knee (-MA))",
      "1/1 home touchdown: Touchdown: Dethirord Slenderstrength",
      "1/1 home sendOff: Sent off: Zhethrah Stonerage ‘The Harvester’ (banned for using a Secret Weapon)",
      "1/- game kickoff: Kick-off: Quick Snap (5 + 4)",
      "1/1 away concession: Concession: Hypno toads",
      "1/1 home touchdown: Touchdown awarded: Zegerd Commonbender",
    ]);
    expect(d.moments[4]).not.toHaveProperty("awarded");
  });
});

// ---- hand-built streams ----
const player = (playerId: string, playerName: string) => ({ playerId, playerName });
const game = {
  gameId: 1,
  teamHome: { teamId: "H", teamName: "Reavers", coach: "Alice", playerArray: [player("h1", "Grak"), player("h2", "Bonk")] },
  teamAway: { teamId: "A", teamName: "Grinders", coach: "Bob", playerArray: [player("a1", "Snik"), player("a2", "Rat")] },
};
let nr = 0;
const mc = (modelChangeId: string, modelChangeKey: string | null, modelChangeValue: unknown) => ({ modelChangeId, modelChangeKey, modelChangeValue });
const sync = (changes: unknown[] = [], reports: unknown[] = []) => ({ netCommandId: "serverModelSync", commandNr: ++nr, modelChangeList: { modelChangeArray: changes }, reportList: { reports } });
const injury = (defenderId: string, attackerId: string | null, injury: number, extra: Record<string, unknown> = {}) =>
  ({ reportId: "injury", defenderId, attackerId, injuryType: "block", armorBroken: true, armorRoll: [5, 5], injuryRoll: [5, 5], casualtyRoll: [9, 1], injury, seriousInjury: null, ...extra });
const turn = (side: "home" | "away", n: number, half = 1) => sync([mc("gameSetHalf", null, half), mc("gameSetHomePlaying", null, side === "home"), mc("turnDataSetTurnNr", side, n)]);

describe("replay moments: reports the captured games do not carry", () => {
  it("casualty vs injury: an attacker on the other team is credited; no attacker or a team-mate makes an injury; KO is no moment", () => {
    const d = deriveReplayMoments(game, [
      turn("home", 2),
      sync([], [injury("a1", "h1", 6), injury("a1", "h1", 6, { skipInjuryParts: "EVERYTHING_BUT_CAS" })]),
      sync([], [injury("a2", null, 7, { seriousInjury: "Dislocated Hip (-AG)" })]),
      sync([], [injury("h2", "h1", 8, { seriousInjury: "Dead (RIP)" })]),
      sync([], [injury("a1", "h1", 5)]),
    ]);
    expect(d.moments.map(brief)).toEqual([
      "1/2 home casualty: Casualty: Grak on Snik (Badly Hurt)",
      "1/2 away injury: Injury: Rat (Dislocated Hip (-AG))",
      "1/2 home injury: Injury: Bonk (Dead (RIP))",
    ]);
  });

  it("the apothecary outcome lands on that player's casualty", () => {
    const d = deriveReplayMoments(game, [
      turn("away", 3),
      sync([], [injury("h2", "a1", 7, { seriousInjury: "Smashed Knee (-MA)" })]),
      sync([], [{ reportId: "apothecaryRoll", playerId: "h2", casualtyRoll: [3, 2], playerState: 6, seriousInjury: null }]),
      sync([], [{ reportId: "apothecaryChoice", playerId: "h2", playerState: 6, seriousInjury: null }]),
    ]);
    expect(d.moments).toHaveLength(1);
    expect(d.moments[0]).toMatchObject({ kind: "casualty", side: "away", result: "Smashed Knee (-MA)", apothecary: "Badly Hurt", text: "Casualty: Snik on Bonk (Smashed Knee (-MA); apothecary: Badly Hurt)" });
  });

  it("send-offs carry the argue-the-call and bribe outcomes the server reported for that player in that turn; a fouled player is no send-off", () => {
    const d = deriveReplayMoments(game, [
      turn("home", 4),
      sync([], [{ reportId: "argueTheCall", playerId: "h1", successful: false, coachBanned: true, roll: 1 }]),
      sync([mc("playerResultSetSendToBoxReason", "h1", "foulBan")]),
      sync([mc("playerResultSetSendToBoxReason", "a1", "fouled")]),
      turn("away", 4),
      sync([mc("playerResultSetSendToBoxReason", "a2", "foulBan")]),
      sync([], [{ reportId: "bribesRoll", playerId: "a2", successful: false, roll: 1 }]),
    ]);
    expect(d.moments.map(brief)).toEqual([
      "1/4 home sendOff: Sent off: Grak (banned for fouling; argued the call unsuccessfully; coach banned)",
      "1/4 away sendOff: Sent off: Rat (banned for fouling; bribe failed)",
    ]);
  });

  it("completions, interceptions and deflections from the result counters (each rise once), overtime, an added player", () => {
    const d = deriveReplayMoments(game, [
      turn("home", 8, 2),
      sync([mc("playerResultSetCompletions", "h1", 1)]),
      sync([mc("playerResultSetCompletions", "h1", 1)]), // the same value again: nothing new
      sync([mc("playerResultSetCompletions", "h1", 3)]),
      { netCommandId: "serverAddPlayer", commandNr: ++nr, teamId: "A", player: player("a9", "Journeyman Gob") },
      turn("away", 1, 3),
      sync([], [{ reportId: "startHalf", half: 3 }]),
      sync([mc("playerResultSetInterceptions", "a9", 1), mc("playerResultSetDeflections", "a1", 1), mc("playerResultSetTouchdowns", "a9", 1)]),
    ]);
    expect(d.moments.map(brief)).toEqual([
      "2/8 home completion: Completion: Grak",
      "2/8 home completion: Completion: Grak",
      "2/8 home completion: Completion: Grak",
      "3/- game halfStart: Start of overtime",
      "3/1 away interception: Interception: Journeyman Gob",
      "3/1 away deflection: Deflection: Snik",
      "3/1 away touchdown: Touchdown: Journeyman Gob",
    ]);
  });

  it("a concession takes the model change's verdict; unknown players, keys and commands are skipped; the moment cap truncates", () => {
    const d = deriveReplayMoments(game, [
      turn("away", 2),
      sync([mc("teamResultSetConceded", "away", true), mc("gameSetConcededLegally", null, true)]),
      sync([mc("playerResultSetTouchdowns", "ghost", 1), mc("turnDataSetTurnNr", "neither", 9)], [injury("ghost", "h1", 6)]),
      { netCommandId: "serverTalk", commandNr: ++nr },
    ]);
    expect(d.moments.map(brief)).toEqual(["1/2 away concession: Concession: Grinders"]);
    expect(d.moments[0]!.legal).toBe(true);
    expect(d.commands).toBe(4);
    const capped = createMomentDeriver(game, { maxMoments: 2 });
    capped.feed(turn("home", 1));
    capped.feed(sync([mc("playerResultSetCompletions", "h1", 5)]));
    expect(capped.result()).toMatchObject({ truncated: true });
    expect(capped.result().moments).toHaveLength(2);
  });
});
