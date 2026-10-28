import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bb2025 } from "@bb/validator/dataset";
import { withRosterArt } from "../src/tabletop/rosterArt.js";
import type { TabletopTeamFile } from "../src/tabletop/postMatch.js";

const PUBLIC = fileURLToPath(new URL("../public", import.meta.url));

describe("roster art for the recorder's Rosters pane", () => {
  const roster = Object.values(bb2025.rosters).find((r) => r.positions.some((p) => p.skills.length > 0 && !/star/i.test(p.name)))!;
  const pos = roster.positions.find((p) => p.skills.length > 0)!;
  const file = (skills: string[]): TabletopTeamFile => ({
    schema: 1, name: "T", rosterId: roster.id, treasury: 0, dedicatedFans: 1,
    players: [{ id: "p1", name: "One", number: 1, positionId: pos.id, spp: 0, skills, mng: false, niggles: 0, statLoss: {}, dead: false }],
  });

  it("splits printed from added skills, gives each a category, and adds the position's printed stats", () => {
    const out = withRosterArt(file([...pos.skills, "Block"]), PUBLIC)!;
    const p = out.players[0] as unknown as { printed: Array<{ name: string; category: string }>; added: Array<{ name: string; category: string }>; printedStats: Record<string, unknown> };
    expect(p.printed.map((s) => s.name)).toEqual(pos.skills.filter((s) => s !== "Block"));
    expect(p.added.map((s) => s.name)).toEqual(pos.skills.includes("Block") ? [] : ["Block"]);
    for (const s of [...p.printed, ...p.added]) expect(s.category).toMatch(/^(General|Agility|Strength|Passing|Mutation|Devious|Trait)/);
    expect(p.printedStats).toMatchObject({ ma: pos.MA, st: pos.ST });
  });

  it("adds a sprite path only from the generated art folder, and none without a manifest", () => {
    const withArt = withRosterArt(file([...pos.skills]), PUBLIC)!.players[0] as unknown as { sprite?: string };
    if (withArt.sprite) expect(withArt.sprite).toMatch(/^sprites\/[\w/-]+\.png$/);
    expect((withRosterArt(file([...pos.skills]))!.players[0] as unknown as { sprite?: string }).sprite).toBeUndefined();
  });

  it("resolves a real sprite for an Orc Blitzer", () => {
    const orc = Object.values(bb2025.rosters).find((r) => r.name === "Orc")!;
    const blitzer = orc.positions.find((p) => /blitzer/i.test(p.name))!;
    const f: TabletopTeamFile = { ...file([]), rosterId: orc.id, players: [{ ...file([]).players[0]!, positionId: blitzer.id, skills: [...blitzer.skills] }] };
    expect((withRosterArt(f, PUBLIC)!.players[0] as unknown as { sprite?: string }).sprite).toBe("sprites/orc/blitzer.png");
  });

  it("passes an unknown roster through with skills as printed", () => {
    const f = { ...file(["Dodge"]), rosterId: "nope" };
    const p = withRosterArt(f, PUBLIC)!.players[0] as unknown as { printed: unknown[]; added: unknown[]; printedStats?: unknown };
    expect(p.printed).toHaveLength(1);
    expect(p.added).toHaveLength(0);
    expect(p.printedStats).toBeUndefined();
  });
});
