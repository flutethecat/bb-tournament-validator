import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { bb2025 } from "@bb/validator/dataset";
import { shortPositionName } from "../src/positionNames.js";

// Owner 10-27: coach-facing position names use the desktop client's rule verbatim (SpectateView.vue
// positionNameFor): a leading "<race name> " is dropped, nothing else. Written twice — the browser Core (public/team-builder.js) and the server twin
// (src/positionNames.ts, used by the public share view) — so both are held to ONE fixture table.
const publicDir = new URL("../public/", import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadCore(): any {
  const context: Record<string, unknown> = { console };
  runInNewContext(readFileSync(new URL("team-builder.js", publicDir), "utf8"), context);
  return context.TeamBuilderCore;
}
const core = loadCore();
const fixture = JSON.parse(readFileSync(new URL("./fixtures/shortPositionNames.json", import.meta.url), "utf8")) as {
  rosters: Record<string, Record<string, string>>;
};
const rosters = Object.values(bb2025.rosters);

describe("shortPositionName — full BB2025 dataset", () => {
  it("covers every roster and position of the dataset", () => {
    expect(Object.keys(fixture.rosters).sort()).toEqual(rosters.map((r) => r.name).sort());
    for (const roster of rosters) expect(Object.keys(fixture.rosters[roster.name]!).sort()).toEqual(roster.positions.map((p) => p.name).sort());
  });
  it.each(rosters.map((r) => [r.name, r] as const))("%s: browser Core and TS twin match the fixture", (_name, roster) => {
    const expected = fixture.rosters[roster.name]!;
    for (const position of roster.positions) {
      const js = core.shortPositionName(position, roster);
      const ts = shortPositionName(position, roster);
      expect({ position: position.name, js }).toEqual({ position: position.name, js: expected[position.name] });
      expect({ position: position.name, ts }).toEqual({ position: position.name, ts: js });
    }
  });
});

describe("shortPositionName — the client rule", () => {
  const both = (position: object, roster: object): string => {
    const js = core.shortPositionName(position, roster);
    expect(shortPositionName(position, roster)).toBe(js);
    return js;
  };
  const pos = (roster: string, name: string) => bb2025.rosters[roster]!.positions.find((p) => p.name === name)!;
  const on = (roster: string, name: string) => both(pos(roster, name), bb2025.rosters[roster]!);

  it("drops a leading race name + space (owner examples)", () => {
    expect(on("Dwarf", "Dwarf Blocker Lineman")).toBe("Blocker Lineman");
    expect(on("Dwarf", "Dwarf Blitzer")).toBe("Blitzer");
    expect(on("Dwarf", "Dwarf Runner")).toBe("Runner");
    expect(on("Skaven", "Skaven Clanrat")).toBe("Clanrat");
    expect(on("Human", "Human Lineman")).toBe("Lineman");
    expect(on("Dark Elf", "Dark Elf Assassin")).toBe("Assassin");
    expect(both({ name: "Shambling Undead Ghoul" }, { name: "Shambling Undead" })).toBe("Ghoul");
  });
  it("touches nothing else: other species words, role words, other rosters' races", () => {
    expect(on("Human", "Halfling Hopeful")).toBe("Halfling Hopeful");
    expect(on("Black Orc", "Goblin Bruiser")).toBe("Goblin Bruiser");
    expect(on("Necromantic Horror", "Ghoul Runner")).toBe("Ghoul Runner");
    expect(on("Orc", "Goblin Lineman")).toBe("Goblin Lineman");
    expect(on("Chaos Chosen", "Beastman Runner Lineman")).toBe("Beastman Runner Lineman");
    for (const p of bb2025.rosters["Old World Alliance"]!.positions) expect(on("Old World Alliance", p.name)).toBe(p.name);
  });
  it("needs the race name followed by a space; a bare race-named position keeps its name", () => {
    expect(on("Black Orc", "Black Orc")).toBe("Black Orc");
    expect(on("Chaos Chosen", "Chaos Chosen")).toBe("Chaos Chosen");
    expect(both({ name: "Dwarfish Runner" }, { name: "Dwarf" })).toBe("Dwarfish Runner");
    expect(both({ name: "Dwarf  " }, { name: "Dwarf" })).toBe("Dwarf  ");
    expect(both({ name: "" }, { name: "Dwarf" })).toBe("");
    expect(both({ name: "Dwarf Runner" }, {})).toBe("Dwarf Runner");
  });
  it("is case-insensitive, trims the race, and reads raceName when name is absent", () => {
    expect(both({ name: "dwarf Blitzer" }, { name: " Dwarf " })).toBe("Blitzer");
    expect(both({ name: "Dwarf Blitzer" }, { raceName: "DWARF" })).toBe("Blitzer");
  });
});
