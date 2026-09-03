# Spec: Skill escalation, Star SPP tax, conditional inducement caps

**Status:** stage-1 spec (Yularen, 2026-09-03) — ready for build. **Model tier:** Sonnet / Codex (mechanical, well-bounded).
**Motivation:** NAF-style resurrection packs (World Cup 2027 V2.1, and most NAF majors) carry three rules the
package model cannot express today; `tournament-packages/naf-world-cup-2027.json` parks them in `dataNote`
for the TO to hand-check. This spec adds them as first-class package knobs. Squad-level rules (one race per
squad, duplicate-star double-booking) stay OUT of scope: the validator is single-roster.

Source of truth for the rules: NAF-World-Cup-Rules-V2.1.pdf p.3–4.

---

## A. Per-player skill escalation (`stackSurchargeSP` / `stackSurchargeGold`)

**Rule (NAF):** 1st skill on a player: primary 6 / secondary 10 SPP. 2nd skill on the *same* player: primary 8 /
secondary 12. I.e. every added skill beyond a player's first costs +2 SPP. The surcharge is flat per extra
skill, so pick order does not matter: `extra = stackSurcharge × max(0, addedSkills.length − 1)`.

**Package model** — `SkillAllotment` gains:

```ts
/** Extra SP charged for each added skill beyond a player's FIRST (NAF: +2). Default 0. */
stackSurchargeSP?: number;
/** Gold twin, parallel to primaryCostGold etc. Default 0. */
stackSurchargeGold?: number;
```

`TierDef`, `TeamRule`, `MatrixRow` do **not** get overrides in v1 (no pack varies it per tier). Add later if a
pack needs it; the resolver seam already exists.

**Enforcement** — `rules/rules.ts` `skillPoints` rule, inside the per-player loop after the `addedSkills.forEach`:

```ts
const extra = Math.max(0, rp.addedSkills.filter((_, i) => rp.access[i] && rp.access[i] !== "illegal").length - 1);
if (extra > 0 && (cfg.stackSurchargeSP ?? 0) > 0) total += extra * cfg.stackSurchargeSP;
```

Count only legal picks (mirror the existing `access === "illegal"` skip). Gold twin goes into the parallel
`costGold` accumulation (`cost/costGold.ts` callers) the same way.

**Findings:** no new finding; the existing over-budget message must show the breakdown when a surcharge
applied: `Team spends 46 Skill Points (40 in skills + 6 stacking surcharge); the budget is 44 …`. Put the
breakdown in the `actual` field too.

**Render:** `render/packageHtml.ts` skill-cost line appends `, +N SP for each skill beyond a player's first`
when > 0. `apps/config-web/src/teamBuilderPackage.ts` `packageRulesInfo` exposes `stackSurchargeSP` so the Slot
Builder can show it.

**Schema:** `schemas/tournament-package.schema.json` `skillAllotment.properties` += both keys (`number`, min 0).

---

## B. Star Player SPP tax (`starPlayers.spTaxByCombinedCost`)

**Rule (NAF):** the team's SPP budget is reduced by a tax keyed on the *cumulative gold* of induced stars:
0–199k → 18 SPP · 200–299k → 24 SPP · 300k+ → 32 SPP. Tax applies only when ≥1 star is rostered.

**Package model** — `TournamentPackage.starPlayers` gains:

```ts
/**
 * SPP tax on the skill budget by COMBINED star gold. Brackets are ascending and inclusive
 * of `upToGold`; the last bracket uses `upToGold: null` (open-ended). Applies only when the
 * roster has at least one Star Player. Mutually exclusive with spCostByTier (Spike! model).
 */
spTaxByCombinedCost?: { upToGold: number | null; sp: number }[];
```

NAF encoding: `[{ "upToGold": 199999, "sp": 18 }, { "upToGold": 299999, "sp": 24 }, { "upToGold": null, "sp": 32 }]`.

**Enforcement** — new pure helper `cost/starTax.ts`:

```ts
export function starTaxSP(brackets: Bracket[] | undefined, combinedStarGold: number, starCount: number): number
// 0 when no brackets, or starCount === 0; else the first bracket whose upToGold is null or >= combinedStarGold.
```

`skillPoints` rule adds `starTaxSP(pkg.starPlayers.spTaxByCombinedCost, combined, stars.length)` to `total`
(the rule already has access to `players`; identify stars the way the `starPlayers` rule does — factor the
star-detection into a shared helper in `rules/` rather than duplicating). `loadPackage` normalisation
(`package/resolve.ts`) validates brackets: ascending `upToGold`, exactly one trailing `null`, non-negative `sp`;
violations are `problems`, not throws. If both `spTaxByCombinedCost` and `spCostByTier` are set, emit a problem
and ignore the tax.

**Findings:** the over-budget message includes the tax when non-zero:
`Team spends 62 Skill Points (44 in skills + 18 Star Player tax at 150k of stars); the budget is 58 …`.

**Render:** `packageHtml.ts` stars line appends `; Star tax: 18 SP (≤199k) / 24 SP (≤299k) / 32 SP (300k+)`.
`packageRaceRules(...).stars` gains `spTax?: Bracket[]`.

**Schema:** `starPlayers.properties.spTaxByCombinedCost` array of `{ upToGold: number|null, sp: number }`.

---

## C. Conditional inducement caps (`inducements.capOverrides`)

**Rule (NAF):** "Taking a star with Secret Weapon means the limit of Bribes for the team goes down to 2."

**Prerequisite (dataset):** `dataset/bb2025/stars.json` entries carry no skills today. Extend
`scripts/generate_dataset.py` `build_stars` to emit `skills: string[]` per star from FUMBBL roster 8513
(the same source the names/costs come from), regenerate, and add `skills` to the `Star` type in
`dataset/lookup.ts`. Verify at least: Bomber Dribblesnot, Fungus the Loon, Nobbla Blackwart, Barik Farblast,
Kreek Rustgouger carry `Secret Weapon`.

**Package model** — `TournamentPackage.inducements` gains:

```ts
/** Conditional caps, applied on top of `caps` (lowest wins) when the condition holds. */
capOverrides?: {
  when: { starHasSkill: string };   // v1: the only supported condition
  caps: Record<string, number>;     // inducement id -> cap
  note?: string;                    // surfaced in the finding
}[];
```

NAF encoding: `[{ "when": { "starHasSkill": "Secret Weapon" }, "caps": { "bribes": 2 }, "note": "Secret Weapon star on roster" }]`.

**Enforcement** — `inducements` rule: before comparing against `cap` (rules.ts ~496), compute the effective cap
as `min(pkg.inducements.caps[id], every matching override's caps[id])`. A condition matches when any
rostered star's `skills` includes the named skill (normName compare). Finding text names the trigger:
`3× Bribes; the limit is 2 while a Secret Weapon star is rostered (Fungus the Loon).`

**Render/Schema:** list overrides under the inducements line; schema adds `capOverrides`.

---

## D. Package update + tests (same PR)

1. `tournament-packages/naf-world-cup-2027.json`: set `stackSurchargeSP: 2`, the three tax brackets, the
   Secret Weapon override; delete items (1)–(3) from `dataNote` (keep the squad-rule and CTV notes).
2. `apps/config-web/test/nafWorldCup2027Package.test.ts`: assert the three new fields load with zero `problems`.
3. `packages/bb-validator/test/`: new `skillEscalation.test.ts`, `starTax.test.ts`, `capOverrides.test.ts`
   using the existing `helpers.ts` roster builders. Minimum cases:
   - escalation: 2 skills on one player = base + base + 2; 1 skill each on two players = no surcharge; illegal
     pick does not attract surcharge; gold twin mirrors.
   - tax: 0 stars → 0; 150k → 18; 200k → 24; 199,999 → 18; 300k → 32; brackets misordered → load problem;
     tax + spCostByTier → problem and tax ignored.
   - overrides: Bribes 3 with a Secret Weapon star → finding; same roster with a non-SW star → no finding;
     override never RAISES a cap (min semantics).
4. Existing suites stay green: `node node_modules/vitest/vitest.mjs run` from the bb-tv root.

## Acceptance

- NAF WC 2027 package validates a roster with 2 stacked skills, one 150k Secret Weapon star and 3 Bribes and
  reports exactly: SP total includes +2 and +18, Bribes capped at 2. Same roster with the star removed passes
  with no tax and 3 Bribes allowed.
- `pnpm -r build` / typecheck green; schema file validates both the EuroBowl and NAF packages.
- No behaviour change for packages that omit the new keys (all default to "off").

## Out of scope / follow-ups

- Squad composition rules (multi-roster), double-booked stars, unspent-budget-is-lost (informational).
- Per-tier overrides of `stackSurchargeSP` (add when a pack needs it).
- Conditions other than `starHasSkill` (e.g. team special rule → cap change is already handled by dataset caps).
