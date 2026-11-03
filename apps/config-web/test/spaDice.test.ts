import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { askedToChoose, canChoose, createDiceClient, diceFaces, faceArt, rollMeaning, type DiceRollView, type DiceStateView } from "../spa/src/dice/client";

// The SPA dice client (spa/src/dice/client.ts): it shows what the server sent, plays someone else's roll, and opens the
// block picker for the coach asked to choose.

const roll = (over: Partial<DiceRollView>): DiceRollView => ({ id: "r1", at: "2026-01-01T00:00:00Z", by: "Alice", side: "home", kind: "d6", purpose: "D6", dice: [4], result: { total: 4 }, ...over });
const view = (latest: DiceRollView[], extra: Partial<DiceStateView> = {}): DiceStateView => ({ ruleset: "BB2025", kickoffTable: [], logShown: false, canSeeLog: false, latest, pending: [], ...extra });

describe("dice client", () => {
  it("first load marks what is there; a new roll by the opponent becomes the live 'incoming' roll; my own never does", async () => {
    let answer = view([roll({ id: "a" })]);
    const calls: Array<{ path: string; body?: unknown }> = [];
    const api = (async (path: string, init?: { body?: unknown }) => { calls.push({ path, body: init?.body }); return answer; }) as never;
    const c = createDiceClient("/api/tabletop/matches/m1", { api, me: () => "Bob" });
    await c.refresh();
    expect(c.state.incoming).toBeNull();
    answer = view([roll({ id: "a" }), roll({ id: "b", by: "Alice", kind: "kickoff", dice: [3, 4], result: { total: 7, eventName: "Brilliant Coaching" } })]);
    await c.refresh();
    expect(c.state.incoming?.id).toBe("b");
    expect(rollMeaning(c.state.incoming!)).toBe("7: Brilliant Coaching");
    c.dismissIncoming();
    answer = { ...view([roll({ id: "c", by: "Bob" })]), roll: roll({ id: "c", by: "Bob" }) } as never;
    await c.roll({ kind: "d6", count: 1 });
    expect(calls.at(-1)).toEqual({ path: "/api/tabletop/matches/m1/dice/roll", body: { kind: "d6", count: 1 } });
    expect(c.state.incoming).toBeNull();
    expect(c.state.current?.id).toBe("c");
    await c.choose("x", 1);
    expect(calls.at(-1)).toEqual({ path: "/api/tabletop/matches/m1/dice/choose", body: { rollId: "x", index: 1 } });
    await c.setLogShown(true);
    expect(calls.at(-1)).toEqual({ path: "/api/tabletop/matches/m1/dice/log", body: { shown: true } });
  });

  it("block picker: the opponent is asked for -2/-3, the roller for 2/3; either seat may choose a -2", () => {
    const neg = roll({ kind: "block", block: { count: -2, chooser: "opponent" }, result: { faces: ["skull", "pow"] }, dice: [1, 6] });
    expect(askedToChoose(neg, "away")).toBe(true);
    expect(askedToChoose(neg, "home")).toBe(false);
    expect(canChoose(neg, "home", false)).toBe(true);
    expect(canChoose(neg, null, false)).toBe(false);
    const pos = { ...neg, block: { count: 2, chooser: "roller" as const } };
    expect(askedToChoose(pos, "home")).toBe(true);
    expect(canChoose(pos, "away", false)).toBe(false);
    expect(askedToChoose({ ...neg, choice: { index: 0, face: "skull", by: "Bob", at: "" } }, "away")).toBe(false);
  });

  it("faces use the in-repo art (the client's default D6 and block faces, D8 / D16 to match) and every file exists; deviate draws a D6 and a D8", () => {
    const pub = (p: string) => new URL(`../public${p}`, import.meta.url);
    for (const f of [1, 2, 3, 4, 5, 6]) expect(existsSync(pub(faceArt("d6", f)))).toBe(true);
    for (const f of ["skull", "both-down", "push", "stumble", "pow"]) expect(existsSync(pub(faceArt("block", f)))).toBe(true);
    for (let f = 1; f <= 8; f++) expect(existsSync(pub(faceArt("d8", f)))).toBe(true);
    for (let f = 1; f <= 16; f++) expect(existsSync(pub(faceArt("d16", f)))).toBe(true);
    expect(faceArt("block", "pow")).toBe("/assets/dice/block/128/block-face-pow.png");
    expect(faceArt("d16", 12)).toBe("/assets/dice/d16/128/d16-face-12.png");
    expect(diceFaces(roll({ kind: "deviate", dice: [3, 7], result: {} }))).toEqual([{ die: "d6", face: 3 }, { die: "d8", face: 7 }]);
    expect(rollMeaning(roll({ kind: "deviate", dice: [3, 7], result: { distance: 3, directionLabel: "Down", arrow: "↓" } }))).toBe("3 squares, Down ↓");
  });

  it("the dice CSS uses tokens and respects reduced motion; no three.js is loaded", () => {
    const css = readFileSync(new URL("../spa/src/dice/dice.css", import.meta.url), "utf8");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    const pkg = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    expect(pkg).not.toContain("\"three\"");
  });
});
