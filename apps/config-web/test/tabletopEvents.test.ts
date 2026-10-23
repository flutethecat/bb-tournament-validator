import { describe, expect, it } from "vitest";
import { effectiveEvents, parseEvent, validateEvent, type RosterPair, type TabletopEvent } from "../src/tabletop/events.js";
import { applyPostMatch, type TabletopPlayer, type TabletopTeamFile } from "../src/tabletop/postMatch.js";

const player = (id: string, extra: Partial<TabletopPlayer> = {}): TabletopPlayer =>
  ({ id, name: `Name ${id}`, spp: 0, skills: [], mng: false, niggles: 0, statLoss: {}, dead: false, ...extra });
const team = (name: string, extra: Partial<TabletopTeamFile> = {}): TabletopTeamFile => ({
  schema: 1, name, treasury: 100_000, dedicatedFans: 2, players: [player("h1"), player("h2"), player("h3")], ...extra,
});
const away = (): TabletopTeamFile => team("Away", { players: [player("a1"), player("a2"), player("a3")] });
const rosters = (h = team("Home"), a = away()): RosterPair => ({ home: h, away: a });

let n = 0;
const ev = (type: string, side: "home" | "away", who: string | undefined, payload: Record<string, unknown> = {}): TabletopEvent => {
  n += 1;
  const p = parseEvent({ id: `evt-${String(n).padStart(6, "0")}`, type, team: side, player: who, payload }, "m1", "alice", "2026-01-01T00:00:00.000Z");
  if (!p.ok) throw new Error(p.error);
  return p.event;
};
/** Validate each event in order, returning the accepted list (throws on the first rejection). */
function accept(events: TabletopEvent[], r = rosters()): TabletopEvent[] {
  const stored: TabletopEvent[] = [];
  for (const e of events) {
    const v = validateEvent(e, stored, r);
    if ("error" in v) throw new Error(v.error);
    stored.push(v.event);
  }
  return stored;
}
const rejects = (events: TabletopEvent[], r = rosters()) => {
  const stored: TabletopEvent[] = [];
  for (const e of events) {
    const v = validateEvent(e, stored, r);
    if ("error" in v) return v.error;
    stored.push(v.event);
  }
  return undefined;
};

describe("tabletop event validation", () => {
  it("rejects malformed wire events", () => {
    expect(parseEvent({ id: "x", type: "touchdown", team: "home" }, "m", "a", "t")).toMatchObject({ ok: false });
    expect(parseEvent({ id: "evt-aaaaaaaa", type: "nope", team: "home" }, "m", "a", "t")).toMatchObject({ ok: false });
    expect(parseEvent({ id: "evt-aaaaaaaa", type: "touchdown", team: "mid" }, "m", "a", "t")).toMatchObject({ ok: false });
    expect(parseEvent({ id: "evt-aaaaaaaa", type: "touchdown", team: "home", half: 7 }, "m", "a", "t")).toMatchObject({ ok: false });
  });
  it("ignores a client-supplied by: the server stamps it", () => {
    const p = parseEvent({ id: "evt-aaaaaaaa", type: "touchdown", team: "home", player: "h1", by: "mallory" }, "m", "alice", "t");
    expect(p).toMatchObject({ ok: true, event: { by: "alice", matchId: "m" } });
  });
  it("player must be on the acting team", () => {
    expect(rejects([ev("touchdown", "home", "a1")])).toMatch(/not on the home team/);
    expect(rejects([ev("touchdown", "home", undefined)])).toMatch(/needs a player/);
  });
  it("dead and MNG players cannot take part", () => {
    expect(rejects([ev("touchdown", "home", "h1")], rosters(team("H", { players: [player("h1", { dead: true })] })))).toMatch(/dead/);
    expect(rejects([ev("completion", "home", "h1")], rosters(team("H", { players: [player("h1", { mng: true })] })))).toMatch(/cannot take part/);
  });
  it("a player killed earlier in the match cannot act afterwards, until the casualty is undone", () => {
    const cas = ev("casualty", "away", "a1", { victim: "h1", result: "DEAD" });
    expect(rejects([cas, ev("touchdown", "home", "h1")])).toMatch(/killed earlier/);
    const undo = ev("undo", "home", undefined, { target: cas.id });
    expect(rejects([cas, undo, ev("touchdown", "home", "h1")])).toBeUndefined();
  });
  it("sent-off players cannot act afterwards", () => {
    expect(rejects([ev("sendOff", "home", "h1"), ev("completion", "home", "h1")])).toMatch(/sent off/);
  });
  it("casualty: victim on the other team, valid result, stat for a stat loss, one casualty per victim", () => {
    expect(rejects([ev("casualty", "home", "h1", { victim: "h2", result: "BH" })])).toMatch(/not on the away team/);
    expect(rejects([ev("casualty", "home", "h1", { victim: "a1", result: "FLATTENED" })])).toMatch(/result must be/);
    expect(rejects([ev("casualty", "home", "h1", { victim: "a1", result: "stat loss" })])).toMatch(/needs payload.stat/);
    expect(rejects([ev("casualty", "home", "h1", { victim: "a1", result: "stat loss", stat: "AV" })])).toBeUndefined();
    expect(rejects([ev("casualty", "home", "h1", { victim: "a1", result: "BH" }), ev("casualty", "home", "h2", { victim: "a1", result: "MNG" })])).toMatch(/already suffered/);
  });
  it("one MVP and one fan change per team", () => {
    expect(rejects([ev("mvp", "home", "h1"), ev("mvp", "home", "h2")])).toMatch(/already has an MVP/);
    expect(rejects([ev("mvp", "home", "h1"), ev("mvp", "away", "a1")])).toBeUndefined();
    expect(rejects([ev("fanChange", "home", undefined, { delta: 3 })])).toMatch(/delta/);
    expect(rejects([ev("fanChange", "home", undefined, { delta: 1 }), ev("fanChange", "home", undefined, { delta: -1 })])).toMatch(/already has a fan change/);
  });
  it("undo: reverses by id, takes the target team, cannot repeat, undo an undo, or miss", () => {
    const td = ev("touchdown", "home", "h1");
    const u1 = ev("undo", "away", undefined, { target: td.id });
    const stored = accept([td, u1]);
    expect(stored[1]!.team).toBe("home");
    expect(effectiveEvents(stored)).toEqual([]);
    expect(rejects([td, u1, ev("undo", "home", undefined, { target: td.id })])).toMatch(/already undone/);
    expect(rejects([td, u1, ev("undo", "home", undefined, { target: u1.id })])).toMatch(/cannot be undone/);
    expect(rejects([ev("undo", "home", undefined, { target: "evt-missing1" })])).toMatch(/not found/);
    expect(rejects([ev("undo", "home", undefined, {})])).toMatch(/payload.target/);
  });
});

describe("applyPostMatch (BB2025)", () => {
  const run = (events: TabletopEvent[], postMatch: "none" | "spp-only" | "full", side: "home" | "away" = "home", t = team("Home")) =>
    applyPostMatch(t, accept(events), { team: side, postMatch, ruleset: "bb2025", matchId: "m1" });
  const sppOf = (r: ReturnType<typeof run>, id: string) => r.teamFile.players.find((p) => p.id === id)!.spp;

  it("SPP per event type", () => {
    const r = run([
      ev("touchdown", "home", "h1"), ev("completion", "home", "h2"), ev("interception", "home", "h2"),
      ev("deflection", "home", "h3"), ev("mvp", "home", "h3"),
      ev("casualty", "home", "h1", { victim: "a1", result: "BH" }),
    ], "spp-only");
    expect(sppOf(r, "h1")).toBe(3 + 2);
    expect(sppOf(r, "h2")).toBe(1 + 1);
    expect(sppOf(r, "h3")).toBe(1 + 4);
  });
  it("only block casualties give SPP; fouls and other causes do not", () => {
    const r = run([
      ev("casualty", "home", "h1", { victim: "a1", result: "BH", cause: "foul" }),
      ev("casualty", "home", "h2", { victim: "a2", result: "BH", cause: "other" }),
      ev("casualty", "home", "h3", { victim: "a3", result: "BH" }),
    ], "spp-only");
    expect([sppOf(r, "h1"), sppOf(r, "h2"), sppOf(r, "h3")]).toEqual([0, 0, 2]);
  });
  it("injuries: BH nothing, MNG, NI (niggle + MNG), stat loss (+MNG), DEAD; apothecary is recorded", () => {
    const r = run([
      ev("casualty", "home", "h1", { victim: "a1", result: "BH", apothecaryUsed: true }),
      ev("casualty", "home", "h1", { victim: "a2", result: "NI" }),
      ev("casualty", "home", "h1", { victim: "a3", result: "stat loss", stat: "ST" }),
    ], "spp-only", "away", away());
    const [a1, a2, a3] = ["a1", "a2", "a3"].map((id) => r.teamFile.players.find((p) => p.id === id)!);
    expect(a1).toMatchObject({ mng: false, niggles: 0, dead: false });
    expect(a2).toMatchObject({ mng: true, niggles: 1 });
    expect(a3).toMatchObject({ mng: true, statLoss: { ST: 1 } });
    expect(r.summary.players.find((p) => p.id === "a1")!.injury).toMatchObject({ result: "BH", apothecaryUsed: true });
    expect(r.summary.casualtiesSuffered).toEqual({ bh: 1, si: 2, rip: 0 });
    const dead = run([ev("casualty", "home", "h1", { victim: "a1", result: "DEAD" }), ev("casualty", "home", "h1", { victim: "a2", result: "MNG" })], "spp-only", "away", away());
    expect(dead.teamFile.players.find((p) => p.id === "a1")!.dead).toBe(true);
    expect(dead.summary.deaths).toEqual(["a1"]);
    expect(dead.teamFile.players.find((p) => p.id === "a2")!.mng).toBe(true);
  });
  it("a player who started MNG sat out: the flag clears", () => {
    const t = team("Home", { players: [player("h1", { mng: true }), player("h2")] });
    const r = run([ev("touchdown", "home", "h2")], "spp-only", "home", t);
    expect(r.teamFile.players.find((p) => p.id === "h1")!.mng).toBe(false);
  });
  it("none leaves the team file unchanged (and does not alias the input)", () => {
    const t = team("Home");
    const r = run([ev("touchdown", "home", "h1"), ev("casualty", "away", "a1", { victim: "h2", result: "DEAD" })], "none", "home", t);
    expect(r.teamFile).toEqual(t);
    expect(r.teamFile).not.toBe(t);
    expect(r.summary).toMatchObject({ applied: false, postMatch: "none", score: { for: 1, against: 0 }, outcome: "won" });
  });
  it("spp-only leaves treasury and fans alone; full adds winnings and the fan change", () => {
    const events = () => [ev("touchdown", "home", "h1"), ev("touchdown", "home", "h2"), ev("fanChange", "home", undefined, { delta: 1 }), ev("touchdown", "away", "a1")];
    const spp = run(events(), "spp-only");
    expect(spp.teamFile).toMatchObject({ treasury: 100_000, dedicatedFans: 2 });
    expect(spp.summary.winnings).toBe(0);
    const full = run(events(), "full");
    expect(full.teamFile).toMatchObject({ treasury: 120_000, dedicatedFans: 3, lastMatchId: "m1" });
    expect(full.summary).toMatchObject({ winnings: 20_000, outcome: "won", score: { for: 2, against: 1 } });
    const loser = run(events(), "full", "away", away());
    expect(loser.teamFile.treasury).toBe(110_000);
    expect(loser.summary.outcome).toBe("lost");
  });
  it("dedicated fans clamp to 1..6", () => {
    const hi = run([ev("fanChange", "home", undefined, { delta: 1 })], "full", "home", team("H", { dedicatedFans: 6 }));
    expect(hi.teamFile.dedicatedFans).toBe(6);
    const lo = run([ev("fanChange", "home", undefined, { delta: -1 })], "full", "home", team("H", { dedicatedFans: 1 }));
    expect(lo.teamFile.dedicatedFans).toBe(1);
  });
  it("undone events do not count; the input is not mutated; an unknown ruleset throws", () => {
    const td = ev("touchdown", "home", "h1");
    const t = team("Home");
    const before = JSON.stringify(t);
    const r = applyPostMatch(t, accept([td, ev("undo", "home", undefined, { target: td.id })]), { team: "home", postMatch: "full", ruleset: "bb2025" });
    expect(r.summary.score.for).toBe(0);
    expect(r.teamFile.treasury).toBe(100_000);
    expect(JSON.stringify(t)).toBe(before);
    expect(() => applyPostMatch(t, [], { team: "home", postMatch: "full", ruleset: "bb2020" as never })).toThrow(/ruleset/);
  });
});
