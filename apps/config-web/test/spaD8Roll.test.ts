import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { D8_FACES, D8_TILT, d6Sides, d8Final, d8Geometry, prefersReducedMotion, rollTiming, skillRollPlan } from "../spa/src/dice/client";

// The big D8 roll ("Advance Characteristic", spec-forfeit-and-dice-2026-11-02 Q7; spa/src/dice/DieRoll.vue): a true
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
    const vue = src("dice/DieRoll.vue");
    expect(vue).toMatch(/prefersReducedMotion\(\)/);
    expect(vue).toMatch(/v-if="play && !reduce" class="d8-burst"/); // no flourish ring under reduced motion
  });

  it("the team page animates only the roll it just made; a resurfaced pending roll is shown settled", () => {
    const panel = src("components/TeamAdvanceRoll.vue");
    expect(panel).toMatch(/const animate = computed\(\(\) => Boolean\(pending\.value && props\.fresh && \(props\.fresh === "\*" \|\| props\.fresh === pending\.value\.id\)\)\)/);
    expect(panel).toMatch(/<DieRoll [^>]*die="d8"[^>]*:play="animate"/);
    expect(panel).toMatch(/<SkillRollSequence :key="pending\.id" :rolls="pending\.rolls \?\? \[\]" :play="animate"/);
    const page = src("components/LeagueTeams.vue");
    // armed ("*") before the request, so the die mounts playing; then pinned to the roll's id (a later reopen is settled)
    expect(page).toMatch(/freshRoll\.value = "\*";\s+const err = await send/);
    expect(page).toMatch(/freshRoll\.value = err \|\| menu\.value\?\.id !== id \? "" : playerOf\(id\)\?\.pendingAdvance\?\.id/);
    // closing the dialog clears it: reopening a pending D8 shows it settled (Sol P3)
    expect(page).toMatch(/function closeMenu\(\): void \{ menu\.value = null; freshRoll\.value = ""; takenRoll\.value = null; \}/);
    expect(page).toMatch(/@close="closeMenu"/);
    // reopening the dialog never sends a roll: the only rollAdvance is behind the coach's button
    expect(panel.match(/emit\('roll'/g)).toHaveLength(2);
  });

  it("tokens only in the dice stylesheet's new rules (no raw colours)", () => {
    const css = src("dice/dice.css");
    const ours = css.slice(css.indexOf("/* ---- the big D8 roll"));
    expect(ours).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("the 2D6 play-back of a Random Primary roll (owner 11-03)", () => {
  const ROLLS = [{ dice: [1, 1] as [number, number], skill: "Block", rerolled: true }, { dice: [2, 4] as [number, number], skill: "Kick" }, { dice: [6, 6] as [number, number], skill: "Wrestle" }];

  it("plays exactly the logged pairs, in order, rerolls included and shorter, all under about 4 s", () => {
    const plan = skillRollPlan(ROLLS, false);
    expect(plan.steps.map((x) => [x.dice, x.skill, Boolean(x.rerolled)])).toEqual([[[1, 1], "Block", true], [[2, 4], "Kick", false], [[6, 6], "Wrestle", false]]);
    expect(plan.total).toBeLessThanOrEqual(4000);
    expect(plan.steps[0]!.total).toBeLessThan(plan.steps[1]!.total);
    for (const x of plan.steps) expect(x.total - x.spin).toBe(350); // each pair settles, then its flourish
    // many rerolls still fit the budget
    const long = skillRollPlan(Array.from({ length: 8 }, (_, i) => ({ dice: [1, 1] as [number, number], skill: "Block", rerolled: i < 6 })), false);
    expect(long.total).toBeLessThanOrEqual(4000);
  });

  it("reduced motion: nothing tumbles, every line at once after a quick fade", () => {
    expect(skillRollPlan(ROLLS, true)).toMatchObject({ total: 250, steps: [{ spin: 0 }, { spin: 0 }, { spin: 0 }] });
    const seq = src("dice/SkillRollSequence.vue");
    expect(seq).toMatch(/const animated = props\.play && !reduce\.value && props\.rolls\.length > 0;/);
    expect(seq).toMatch(/const shown = ref\(animated \? 0 : props\.rolls\.length\)/); // settled or reduced: all lines
    expect(src("dice/dice.css")).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.adv-seq-lines li \{ animation: none; \} \}/);
  });

  it("the D6 shows the rolled face in front with its opposite behind; the stage is the shared DieRoll with die as a parameter", () => {
    for (let f = 1; f <= 6; f += 1) {
      const sides = d6Sides(f);
      expect(sides[0]).toBe(f);
      expect(sides[1]).toBe(7 - f);
      expect([...sides].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    }
    const seq = src("dice/SkillRollSequence.vue");
    expect(seq).toMatch(/<DieRoll[\s\S]*die="d6"/);
    expect(seq).toMatch(/@click="finish"/); // skip on click
    expect(seq).toMatch(/already has" : "can't take"\} \$\{r\.skill\}, rolled again/);
    expect(src("dice/DieRoll.vue")).toMatch(/die\?: "d8" \| "d6"/);
  });

  it("a pending random roll reopens settled: no replay; a forced double plays back the logged roll, then says it was taken", () => {
    const panel = src("components/TeamAdvanceRoll.vue");
    expect(panel).toMatch(/<template v-if="settled">\s*<p>Keep one of the two skills the table gave\.<\/p>/);
    expect(panel).toMatch(/Both rolls gave \{\{ taken\.skill \}\}: it is taken\./);
    const page = src("components/LeagueTeams.vue");
    expect(page).toMatch(/last\?\.kind === "advance-skill" && res\.playerId === id && res\.forced/);
  });
});
