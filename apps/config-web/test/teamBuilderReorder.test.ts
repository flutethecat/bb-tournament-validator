import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Roster gripper (owner 10-30): reorder is a presentation order only. Pure logic lives in
// TeamBuilderCore (public/team-builder.js), loaded in a bare vm context exactly as the browser does.
const publicDir = new URL("../public/", import.meta.url);
/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: any = { console, setTimeout, clearTimeout };
ctx.window = ctx;
createContext(ctx);
runInContext(readFileSync(new URL("team-builder.js", publicDir), "utf8"), ctx);
const core = ctx.TeamBuilderCore;

const positions: Record<string, any> = {
  a: { positionId: "a", name: "Lineman", cost: 50_000, skills: [] },
  b: { positionId: "b", name: "Blitzer", cost: 90_000, skills: [] },
  s: { positionId: "s", name: "Grim", cost: 190_000, skills: [], isStar: true },
};
const byId = (id: string) => positions[id];
const slot = (positionId: string, extra: Record<string, unknown> = {}) => ({ positionId, chosenSkills: [], chosenStatIncreases: [], ...extra });
const ids = (list: any[]) => list.map((s) => s.positionId).join("");

describe("moveSlot", () => {
  const base = () => [slot("a"), slot("b"), slot("s"), slot("a", { chosenSkills: ["Block"] })];

  it("moves a slot up and down by one", () => {
    expect(ids(core.moveSlot(base(), 1, 0))).toBe("bas" + "a");
    expect(ids(core.moveSlot(base(), 1, 2))).toBe("asb" + "a");
  });
  it("is a no-op (same array) at the bounds and for bad input", () => {
    const list = base();
    expect(core.moveSlot(list, 0, -1)).toBe(list);
    expect(core.moveSlot(list, 3, 3)).toBe(list);
    expect(core.moveSlot(list, 9, 0)).toBe(list);
    expect(core.moveSlot(list, -1, 0)).toBe(list);
    expect(core.moveSlot(list, 1.5, 0)).toBe(list);
    expect(core.moveSlot(null, 0, 1)).toEqual([]);
  });
  it("clamps an out-of-range target and never mutates its input", () => {
    const list = base();
    const before = [...list];
    expect(ids(core.moveSlot(list, 0, 99))).toBe("bsa" + "a");
    expect(list).toEqual(before);
  });
  it("keeps the very same slot objects, so skills, stats and costs are untouched", () => {
    const list = base();
    const moved = core.moveSlot(list, 3, 0);
    expect(moved[0]).toBe(list[3]);
    expect(moved[0].chosenSkills).toEqual(["Block"]);
    const total = (l: any[]) => l.reduce((sum, s) => sum + byId(s.positionId).cost, 0);
    expect(total(moved)).toBe(total(list));
  });
});

describe("renumbering and exports follow the order", () => {
  it("sheet numbers follow slot order (stars included, not forced last)", () => {
    const players = [slot("s"), slot("a"), slot("b")].map((s) => ({ position: byId(s.positionId), chosenSkills: [], chosenStatIncreases: [] }));
    const model = core.rosterSheetModel({ raceName: "Test", players });
    expect(model.rows.map((r: any) => [r.number, r.positionFull])).toEqual([[1, "Grim"], [2, "Lineman"], [3, "Blitzer"]]);
    const moved = core.moveSlot([slot("s"), slot("a"), slot("b")], 0, 2);
    const model2 = core.rosterSheetModel({ raceName: "Test", players: moved.map((s: any) => ({ position: byId(s.positionId), chosenSkills: [], chosenStatIncreases: [] })) });
    expect(model2.rows.map((r: any) => r.positionFull)).toEqual(["Lineman", "Blitzer", "Grim"]);
    expect(model2.rows.map((r: any) => r.number)).toEqual([1, 2, 3]);
  });
});

describe("save round-trip", () => {
  it("buildPicks keeps slot order and slotsFromPicks restores it", () => {
    const reordered = core.moveSlot([slot("a"), slot("a"), slot("b"), slot("s")], 2, 0);
    const picks = core.buildPicks(reordered);
    expect(picks.map((p: any) => [p.positionId, p.count])).toEqual([["b", 1], ["a", 2], ["s", 1]]);
    const restored = core.slotsFromPicks(JSON.parse(JSON.stringify(picks)), byId);
    expect(ids(restored)).toBe(ids(reordered));
  });
  it("a reordered skilled player keeps its own skills across the round-trip", () => {
    const list = [slot("a"), slot("a", { chosenSkills: ["Block"] }), slot("b")];
    const moved = core.moveSlot(list, 1, 0);
    const restored = core.slotsFromPicks(core.buildPicks(moved), byId);
    expect(restored.map((s: any) => [s.positionId, s.chosenSkills.join()])).toEqual([["a", "Block"], ["a", ""], ["b", ""]]);
  });
});

describe("page markup", () => {
  const js = readFileSync(new URL("team-builder.js", publicDir), "utf8");
  const css = readFileSync(new URL("team-builder.css", publicDir), "utf8");
  it("renders a labelled gripper per row and wires Alt+Arrow with a live announcement", () => {
    expect(js).toContain('class="row-grip"');
    expect(js).toContain('title="Drag to reorder"');
    expect(js).toContain("Moved ${slotLabel(slot)} to position ${index + 1}");
    expect(js).toContain('event.key !== "ArrowUp"');
    expect(js).toContain('setAttribute("aria-live", "polite")');
  });
  it("styles it with theme tokens only, 24 x 44 hit area, grab cursor", () => {
    const block = css.slice(css.indexOf(".row-grip {"), css.indexOf(".visually-hidden") > 0 ? css.indexOf(".roster-row.drop-after") : undefined);
    expect(block).toMatch(/width: 24px; height: 44px/);
    expect(block).toContain("cursor: grab");
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,6}\b|rgb\(/);
  });
  it("a roster rerender cancels any in-flight drag (no stale indices)", () => {
    // No DOM in the vm harness, so assert the wiring: state is declared before renderRoster, which cancels first.
    expect(js.indexOf("let dragFrom = null;")).toBeLessThan(js.indexOf("function renderRoster()"));
    expect(js).toMatch(/function renderRoster\(\) \{\s*cancelDrag\(\);/);
    expect(js).toMatch(/function cancelDrag\(\) \{[\s\S]*pointerDrag = null;[\s\S]*dragFrom = null;[\s\S]*clearDropMarks\(\);/);
    expect(js).toContain('"lostpointercapture"');
    expect(js).toContain('document.addEventListener("dragend"');
  });
});
