import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D8_FACES, D8_TILT, d8Final, d8Geometry, prefersReducedMotion, rollTiming } from "../spa/src/dice/client";

// The big D8 roll ("Advance Characteristic", spec-forfeit-and-dice-2026-11-02 Q7; spa/src/dice/D8Roll.vue): a true
// octahedron in CSS 3D that settles on the SERVER's number in about 2 s, or fades in quickly under reduced motion; the
// team page shows a resurfaced pending roll settled, never replayed and never re-rolled.

const src = (p: string): string => readFileSync(new URL(`../spa/src/${p}`, import.meta.url), "utf8");

describe("the D8 roller", () => {
  it("eight faces, opposite faces add to 9, four at each vertex", () => {
    expect(D8_FACES.map((f) => f.value).sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const f of D8_FACES) {
      const opposite = D8_FACES.find((o) => o.top !== f.top && (o.azimuth - f.azimuth + 360) % 360 === 180)!;
      expect(f.value + opposite.value).toBe(9);
    }
    expect(D8_FACES.filter((f) => f.top)).toHaveLength(4);
    expect(D8_TILT).toBeCloseTo(35.264, 2);
  });

  it("settles square on the rolled face: the die's final turn undoes that face's own placement", () => {
    for (const f of D8_FACES) {
      const fin = d8Final(f.value);
      expect(fin.y).toBe(-f.azimuth);
      expect(fin.x + 8).toBeCloseTo(f.top ? -D8_TILT : D8_TILT, 6);
    }
    const g = d8Geometry(200);
    expect(g.edge).toBeCloseTo(g.radius * Math.SQRT2, 6);
    expect(g.inset).toBeCloseTo(g.radius / Math.sqrt(3), 6);
  });

  it("plays about 2.2 s (inside the owner's 1.5-2.5 s), and a quick fade under prefers-reduced-motion", () => {
    const full = rollTiming(false);
    expect(full.total).toBeGreaterThanOrEqual(1500);
    expect(full.total).toBeLessThanOrEqual(2500);
    expect(full.settle).toBeLessThan(full.total);
    expect(rollTiming(true)).toEqual({ spin: 0, settle: 0, total: 250 });
    expect(prefersReducedMotion()).toBe(false); // no window here: never throws
    const css = src("dice/dice.css");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.d8-die, \.d8-throw[^}]*animation: none !important/);
    expect(css).toMatch(/\.d8-stage\[data-play="true"\]\[data-reduced="true"\] \{ animation: d8-fade/);
    const vue = src("dice/D8Roll.vue");
    expect(vue).toMatch(/prefersReducedMotion\(\)/);
    expect(vue).toMatch(/v-if="play && !reduce" class="d8-burst"/); // no flourish ring under reduced motion
  });

  it("the team page animates only the roll it just made; a resurfaced pending roll is shown settled", () => {
    const panel = src("components/TeamAdvanceRoll.vue");
    expect(panel).toMatch(/const animate = computed\(\(\) => Boolean\(pending\.value && props\.fresh && \(props\.fresh === "\*" \|\| props\.fresh === pending\.value\.id\)\)\)/);
    expect(panel).toMatch(/<D8Roll [^>]*:play="animate"/);
    const page = src("components/LeagueTeams.vue");
    // armed ("*") before the request, so the die mounts playing; then pinned to the roll's id (a later reopen is settled)
    expect(page).toMatch(/freshRoll\.value = "\*";\s+const err = await send/);
    expect(page).toMatch(/freshRoll\.value = err \? "" : playerOf\(id\)\?\.pendingAdvance\?\.id/);
    // reopening the dialog never sends a roll: the only rollAdvance is behind the coach's button
    expect(panel.match(/emit\('roll'/g)).toHaveLength(2);
  });

  it("tokens only in the dice stylesheet's new rules (no raw colours)", () => {
    const css = src("dice/dice.css");
    const ours = css.slice(css.indexOf("/* ---- the big D8 roll"));
    expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});
